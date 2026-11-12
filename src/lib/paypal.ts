import type { Customer, PayPalAdapter, PayPalEvent } from "./types";

const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
type Options = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
};

export const mockAdapter: PayPalAdapter = {
  mode: "mock",
  async getContext(customer) {
    const successfulPayments = Math.max(0, customer.tenureMonths - customer.failedPayments);
    return {
      source: "synthetic",
      transactionCount: customer.tenureMonths,
      successfulPayments,
      note: "Synthetic history derived from seeded tenure and payment failures. No PayPal request was made.",
    };
  },
  async verifyWebhook() {
    return false;
  },
};

function sandboxClient(options: Options) {
  const env = options.env ?? process.env;
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for sandbox access.");
  }
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let token: { value: string; expiresAt: number; expiresIn: number } | undefined;
  let pendingToken: Promise<NonNullable<typeof token>> | undefined;

  async function request(path: string, init: RequestInit) {
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await send(`${SANDBOX_URL}${path}`, { ...init, signal, redirect: "error", cache: "no-store" });
    } catch {
      throw new Error(signal.aborted ? "PayPal sandbox request timed out." : "PayPal sandbox request could not be completed.");
    }
    if (!response.ok) {
      throw new Error(`PayPal sandbox request failed (HTTP ${response.status}).`);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new Error("PayPal sandbox returned an invalid JSON response.");
    }
  }

  async function authenticate() {
    if (token && now() < token.expiresAt - 30_000) return token;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const result = await request("/v1/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      const body = result as Record<string, unknown> | null;
      if (!body || typeof body.access_token !== "string" || !body.access_token ||
          body.token_type !== "Bearer" || typeof body.expires_in !== "number" ||
          !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
        throw new Error("PayPal sandbox returned an invalid OAuth response.");
      }
      token = { value: body.access_token, expiresAt: now() + body.expires_in * 1_000, expiresIn: body.expires_in };
      return token;
    })();
    try {
      return await pendingToken;
    } finally {
      pendingToken = undefined;
    }
  }

  async function authorized(path: string, init: RequestInit = {}) {
    const current = await authenticate();
    return request(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${current.value}` },
    });
  }
  return { authenticate, authorized, env, now };
}

async function reportingContext(client: ReturnType<typeof sandboxClient>) {
  const end = new Date(client.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = new Date(client.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = new URLSearchParams({ start_date: start, end_date: end, page_size: "100", page: "1" });
  const result = await client.authorized(`/v1/reporting/transactions?${query}`) as Record<string, unknown> | null;
  if (!result || !Array.isArray(result.transaction_details) || result.transaction_details.some((row) =>
    !row || typeof row !== "object" || !row.transaction_info || typeof row.transaction_info !== "object" ||
    typeof row.transaction_info.transaction_status !== "string")) {
    throw new Error("PayPal sandbox returned an invalid transaction response.");
  }
  const rows = result.transaction_details as { transaction_info: { transaction_status: string } }[];
  return {
    source: "paypal_sandbox" as const,
    transactionCount: rows.length,
    successfulPayments: rows.filter((row) => row.transaction_info.transaction_status === "S").length,
    note: "REST reporting read: merchant-wide first page, up to 100 transactions from the last 30 days. Successful status does not establish recovery. Toolkit integration is pending; merchant insights is unavailable in sandbox.",
  };
}

export function createSandboxAdapter(options: Options = {}): PayPalAdapter {
  const client = sandboxClient(options);
  return {
    mode: "sandbox",
    async getContext(_customer: Customer) {
      return reportingContext(client);
    },
    async verifyWebhook(event: PayPalEvent, headers: Headers) {
      const webhookId = client.env.PAYPAL_WEBHOOK_ID?.trim();
      if (!webhookId) throw new Error("Set PAYPAL_WEBHOOK_ID before accepting PayPal sandbox webhooks.");
      const fields = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
      if (fields.some((field) => !headers.get(field)?.trim())) return false;
      if (headers.get("paypal-auth-algo") !== "SHA256withRSA" || !Number.isFinite(Date.parse(headers.get("paypal-transmission-time")!))) return false;
      try {
        const cert = new URL(headers.get("paypal-cert-url")!);
        if (cert.protocol !== "https:" || (cert.port && cert.port !== "443") || cert.username || cert.password ||
            (cert.hostname !== "paypal.com" && !cert.hostname.endsWith(".paypal.com"))) return false;
      } catch {
        return false;
      }
      const result = await client.authorized("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: JSON.stringify({
          auth_algo: headers.get("paypal-auth-algo"),
          cert_url: headers.get("paypal-cert-url"),
          transmission_id: headers.get("paypal-transmission-id"),
          transmission_sig: headers.get("paypal-transmission-sig"),
          transmission_time: headers.get("paypal-transmission-time"),
          webhook_id: webhookId,
          webhook_event: event,
        }),
      }) as Record<string, unknown> | null;
      return result?.verification_status === "SUCCESS";
    },
  };
}

export async function checkSandboxOAuth(options: Options = {}) {
  const token = await sandboxClient(options).authenticate();
  return { mode: "sandbox", authenticated: true, tokenType: "Bearer", expiresInSeconds: token.expiresIn } as const;
}

export type SandboxReadQualification = {
  scope: "sandbox_oauth_and_reporting_only";
  result: "blocked" | "failed" | "passed";
  checkedAt: string | null;
  transport: "default_fetch" | "injected_fetch";
  configuration: { clientIdPresent: boolean; clientSecretPresent: boolean; webhookIdPresent: boolean };
  oauth: { status: "not_run" | "failed" | "passed"; expiresInSeconds?: number };
  reporting: { status: "not_run" | "failed" | "passed"; transactionCount?: number; successfulPayments?: number; coverage: "merchant_wide_first_page_up_to_100_last_30_days" };
  reason?: string;
  businessWritesAttempted: false;
  webhookVerificationTested: false;
  resourceMappingTested: false;
  applicationQualified: false;
};

function safeQualificationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^PayPal sandbox request failed \(HTTP \d{3}\)\.$/.test(message)) return message;
  if (["PayPal sandbox request timed out.", "PayPal sandbox request could not be completed.", "PayPal sandbox returned an invalid JSON response.", "PayPal sandbox returned an invalid OAuth response.", "PayPal sandbox returned an invalid transaction response."].includes(message)) return message;
  return "Sandbox read check could not be completed.";
}

export async function qualifySandboxReads(options: Options = {}): Promise<SandboxReadQualification> {
  const env = options.env ?? process.env;
  const configuration = { clientIdPresent: !!env.PAYPAL_CLIENT_ID?.trim(), clientSecretPresent: !!env.PAYPAL_CLIENT_SECRET?.trim(), webhookIdPresent: !!env.PAYPAL_WEBHOOK_ID?.trim() };
  const result: SandboxReadQualification = {
    scope: "sandbox_oauth_and_reporting_only", result: "blocked", checkedAt: null,
    transport: options.fetch ? "injected_fetch" : "default_fetch", configuration,
    oauth: { status: "not_run" },
    reporting: { status: "not_run", coverage: "merchant_wide_first_page_up_to_100_last_30_days" },
    businessWritesAttempted: false, webhookVerificationTested: false, resourceMappingTested: false, applicationQualified: false,
  };
  let time: number;
  try {
    time = (options.now ?? Date.now)();
    if (!Number.isFinite(time)) throw new Error("Invalid clock");
    result.checkedAt = new Date(time).toISOString();
    // Validate the full reporting range before making even an authentication request.
    new Date(time - 30 * 86_400_000).toISOString();
  } catch {
    return { ...result, result: "failed", reason: "A valid qualification clock is required." };
  }
  if (!configuration.clientIdPresent || !configuration.clientSecretPresent) {
    return { ...result, reason: "Both existing sandbox client credentials are required. No request was made." };
  }
  const client = sandboxClient({ ...options, now: () => time });
  try {
    const token = await client.authenticate();
    result.oauth = { status: "passed", expiresInSeconds: token.expiresIn };
  } catch (error) {
    return { ...result, result: "failed", oauth: { status: "failed" }, reason: safeQualificationFailure(error) };
  }
  try {
    const context = await reportingContext(client);
    result.reporting = { ...result.reporting, status: "passed", transactionCount: context.transactionCount, successfulPayments: context.successfulPayments };
    result.result = "passed";
  } catch (error) {
    result.reporting.status = "failed";
    result.result = "failed";
    result.reason = safeQualificationFailure(error);
  }
  return result;
}
