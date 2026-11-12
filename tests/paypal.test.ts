import assert from "node:assert/strict";
import test from "node:test";
import { checkSandboxOAuth, createSandboxAdapter, mockAdapter } from "../src/lib/paypal";
import type { Customer, PayPalEvent } from "../src/lib/types";

const env = { PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "private-test-secret", PAYPAL_WEBHOOK_ID: "WH-TEST" };
const customer: Customer = {
  id: "C-1", name: "Test Merchant", planId: "growth", subscriptionId: "I-TEST", invoiceId: null,
  monthlyValueCents: 4900, tenureMonths: 12, failedPayments: 2, daysPastDue: 5,
};
const event: PayPalEvent = { id: "WH-EVENT", event_type: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", create_time: "2026-11-01T12:00:00Z", resource: { id: "I-TEST" } };
const signatureHeaders = () => new Headers({
  "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-TEST",
  "paypal-transmission-id": "transmission", "paypal-transmission-sig": "signature", "paypal-transmission-time": event.create_time,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const oauth = () => json({ access_token: "private-access-token", token_type: "Bearer", expires_in: 60 });

test("mock context is deterministic and cannot verify PayPal ingress", async () => {
  assert.deepEqual(await mockAdapter.getContext(customer), await mockAdapter.getContext(customer));
  assert.equal((await mockAdapter.getContext(customer)).successfulPayments, 10);
  assert.equal(await mockAdapter.verifyWebhook(event, signatureHeaders()), false);
});

test("missing or partial credentials cannot authenticate or silently select mock", async () => {
  for (const missing of [{}, { PAYPAL_CLIENT_ID: "id" }, { PAYPAL_CLIENT_SECRET: "secret" }]) {
    assert.throws(() => createSandboxAdapter({ env: missing }), /Set both/);
    await assert.rejects(checkSandboxOAuth({ env: missing }), /Set both/);
  }
});

test("OAuth authenticates against sandbox only and exposes safe metadata", async () => {
  const result = await checkSandboxOAuth({ env, fetch: (async (url, init) => {
    assert.equal(url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "grant_type=client_credentials");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return oauth();
  }) as typeof fetch });
  assert.deepEqual(result, { mode: "sandbox", authenticated: true, tokenType: "Bearer", expiresInSeconds: 60 });
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("context uses cached OAuth until refresh, with accurate reporting status counts", async () => {
  let time = Date.parse("2026-11-01T12:00:00Z");
  let tokenCalls = 0;
  let reportingCalls = 0;
  const adapter = createSandboxAdapter({ env, now: () => time, fetch: (async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://api-m.sandbox.paypal.com");
    if (target.pathname === "/v1/oauth2/token") { tokenCalls++; return oauth(); }
    reportingCalls++;
    assert.equal(target.pathname, "/v1/reporting/transactions");
    assert.equal(target.searchParams.get("page_size"), "100");
    assert.doesNotMatch(target.searchParams.get("start_date")!, /\.\d+Z/);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-access-token");
    return json({ transaction_details: ["S", "D", "P", "S"].map((transaction_status) => ({ transaction_info: { transaction_status } })) });
  }) as typeof fetch });
  const context = await adapter.getContext(customer);
  assert.equal(context.source, "paypal_sandbox");
  assert.equal(context.transactionCount, 4);
  assert.equal(context.successfulPayments, 2);
  assert.match(context.note, /merchant-wide first page/);
  await adapter.getContext(customer);
  assert.equal(tokenCalls, 1);
  time += 31_000;
  await adapter.getContext(customer);
  assert.equal(tokenCalls, 2);
  assert.equal(reportingCalls, 3);
});

test("OAuth and reporting errors do not disclose response bodies or fall back to synthetic data", async () => {
  await assert.rejects(checkSandboxOAuth({ env, fetch: (async () => json({ error: env.PAYPAL_CLIENT_SECRET }, 401)) as typeof fetch }), /HTTP 401/);
  await assert.rejects(checkSandboxOAuth({ env, fetch: (async () => { throw new Error(env.PAYPAL_CLIENT_SECRET); }) as typeof fetch }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private-test-secret/);
    return true;
  });
  const adapter = createSandboxAdapter({ env, fetch: (async (url) => String(url).endsWith("/token") ? oauth() : json({ detail: "private-response" }, 403)) as typeof fetch });
  await assert.rejects(adapter.getContext(customer), /HTTP 403/);
  const invalid = createSandboxAdapter({ env, fetch: (async (url) => String(url).endsWith("/token") ? oauth() : json({})) as typeof fetch });
  await assert.rejects(invalid.getContext(customer), /invalid transaction response/);
  await assert.rejects(checkSandboxOAuth({ env, fetch: (async () => json({ access_token: "secret", token_type: "Bearer", expires_in: 0 })) as typeof fetch }), /invalid OAuth response/);
});

test("concurrent reads share OAuth and malformed JSON is rejected safely", async () => {
  let tokenCalls = 0;
  const adapter = createSandboxAdapter({ env, fetch: (async (url) => {
    if (String(url).endsWith("/token")) { tokenCalls++; return oauth(); }
    return json({ transaction_details: [] });
  }) as typeof fetch });
  await Promise.all([adapter.getContext(customer), adapter.getContext(customer)]);
  assert.equal(tokenCalls, 1);
  await assert.rejects(checkSandboxOAuth({ env, fetch: (async () => new Response("private-invalid-body")) as typeof fetch }), /invalid JSON response/);
});

test("webhooks require complete signature headers, configured ID and an HTTPS PayPal certificate", async () => {
  const adapter = createSandboxAdapter({ env, fetch: (async () => { throw new Error("No request should be made"); }) as typeof fetch });
  assert.equal(await adapter.verifyWebhook(event, new Headers()), false);
  for (const url of ["http://api.paypal.com/cert", "https://paypal.com.evil.test/cert", "https://evilpaypal.com/cert", "https://api.paypal.com:8443/cert", "https://user@api.paypal.com/cert", "invalid"]) {
    const headers = signatureHeaders();
    headers.set("paypal-cert-url", url);
    assert.equal(await adapter.verifyWebhook(event, headers), false);
  }
  const missingId = createSandboxAdapter({ env: { ...env, PAYPAL_WEBHOOK_ID: undefined } });
  await assert.rejects(missingId.verifyWebhook(event, signatureHeaders()), /Set PAYPAL_WEBHOOK_ID/);
});

test("webhook postback sends exact signed event and accepts only exact SUCCESS", async () => {
  for (const status of ["SUCCESS", "FAILURE", "success", undefined]) {
    let calls = 0;
    const adapter = createSandboxAdapter({ env, fetch: (async (url, init) => {
      calls++;
      if (String(url).endsWith("/token")) return oauth();
      assert.equal(url, "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.webhook_event, event);
      assert.equal(body.webhook_id, "WH-TEST");
      assert.equal(body.transmission_sig, "signature");
      assert.equal(body.auth_algo, "SHA256withRSA");
      return json({ verification_status: status });
    }) as typeof fetch });
    assert.equal(await adapter.verifyWebhook(event, signatureHeaders()), status === "SUCCESS");
    assert.equal(calls, 2);
  }
});
