import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifySandboxReads } from "../src/lib/paypal";

const now = () => Date.parse("2026-11-07T12:00:00Z");
const env = { PAYPAL_CLIENT_ID: "private-client-fixture", PAYPAL_CLIENT_SECRET: "private-secret-fixture", PAYPAL_WEBHOOK_ID: "private-webhook-fixture" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const oauth = () => json({ access_token: "private-token-fixture", token_type: "Bearer", expires_in: 60 });

test("qualification reports missing credentials without any request or invented live pass", async () => {
  for (const missing of [{}, { PAYPAL_CLIENT_ID: " " }, { PAYPAL_CLIENT_ID: "id" }, { PAYPAL_CLIENT_SECRET: "secret" }]) {
    let calls = 0;
    const result = await qualifySandboxReads({ env: missing, now, fetch: (async () => { calls++; throw new Error("must not run"); }) as typeof fetch });
    assert.equal(calls, 0);
    assert.equal(result.result, "blocked");
    assert.equal(result.oauth.status, "not_run");
    assert.equal(result.reporting.status, "not_run");
    assert.equal(result.applicationQualified, false);
    assert.equal(result.businessWritesAttempted, false);
  }
});

test("qualification separates successful OAuth from the bounded read and minimizes its receipt", async () => {
  const calls: string[] = [];
  const result = await qualifySandboxReads({ env, now, fetch: (async (url, init) => {
    const target = new URL(String(url));
    calls.push(target.pathname);
    assert.equal(target.origin, "https://api-m.sandbox.paypal.com");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    if (target.pathname === "/v1/oauth2/token") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "grant_type=client_credentials");
      return oauth();
    }
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(target.pathname, "/v1/reporting/transactions");
    assert.equal(target.searchParams.get("page_size"), "100");
    assert.equal(target.searchParams.get("page"), "1");
    assert.equal(target.searchParams.get("start_date"), "2026-10-08T12:00:00Z");
    assert.equal(target.searchParams.get("end_date"), "2026-11-07T12:00:00Z");
    return json({ transaction_details: ["S", "D", "P", "S"].map(transaction_status => ({
      transaction_info: { transaction_status, transaction_id: "private-transaction-fixture", transaction_amount: { value: "999.00" } },
      payer_info: { email_address: "private-payer-fixture@example.test" },
    })), total_pages: 99 });
  }) as typeof fetch });
  assert.deepEqual(calls, ["/v1/oauth2/token", "/v1/reporting/transactions"]);
  assert.equal(result.result, "passed");
  assert.equal(result.transport, "injected_fetch");
  assert.equal(result.checkedAt, "2026-11-07T12:00:00.000Z");
  assert.deepEqual(result.oauth, { status: "passed", expiresInSeconds: 60 });
  assert.deepEqual(result.reporting, { status: "passed", coverage: "merchant_wide_first_page_up_to_100_last_30_days", transactionCount: 4, successfulPayments: 2 });
  assert.deepEqual(result.configuration, { clientIdPresent: true, clientSecretPresent: true, webhookIdPresent: true });
  assert.equal(result.webhookVerificationTested, false);
  assert.equal(result.resourceMappingTested, false);
  assert.equal(result.applicationQualified, false);
  assert.doesNotMatch(JSON.stringify(result), /private-|999\.00/);
});

test("valid empty reporting results qualify the read, not recovery or webhook execution", async () => {
  const result = await qualifySandboxReads({ env: { ...env, PAYPAL_WEBHOOK_ID: undefined }, now,
    fetch: (async url => String(url).endsWith("/token") ? oauth() : json({ transaction_details: [] })) as typeof fetch });
  assert.equal(result.result, "passed");
  assert.equal(result.reporting.transactionCount, 0);
  assert.equal(result.configuration.webhookIdPresent, false);
  assert.equal(result.webhookVerificationTested, false);
  assert.equal(result.applicationQualified, false);
});

test("OAuth failure stops reporting and never includes raw errors, bodies or secrets", async () => {
  for (const transport of [
    async () => json({ error: "private-body-fixture" }, 401),
    async () => { throw new Error("private-error-fixture"); },
    async () => new Response("private-invalid-json"),
    async () => json({ access_token: "private-token-fixture", token_type: "Bearer", expires_in: 0 }),
  ]) {
    let calls = 0;
    const result = await qualifySandboxReads({ env, now, fetch: (async () => { calls++; return transport(); }) as typeof fetch });
    assert.equal(calls, 1);
    assert.equal(result.result, "failed");
    assert.equal(result.oauth.status, "failed");
    assert.equal(result.reporting.status, "not_run");
    assert.equal(result.applicationQualified, false);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test("reporting permission denial preserves OAuth pass but fails the qualification", async () => {
  const result = await qualifySandboxReads({ env, now, fetch: (async url => String(url).endsWith("/token") ? oauth() : json({ detail: "private-denial-fixture" }, 403)) as typeof fetch });
  assert.equal(result.result, "failed");
  assert.equal(result.oauth.status, "passed");
  assert.equal(result.reporting.status, "failed");
  assert.equal(result.reason, "PayPal sandbox request failed (HTTP 403).");
  assert.equal(result.reporting.transactionCount, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("malformed reporting and invalid clocks cannot produce a pass", async () => {
  for (const body of [{}, { transaction_details: [null] }, { transaction_details: [{ transaction_info: { transaction_status: 3 } }] }]) {
    const result = await qualifySandboxReads({ env, now, fetch: (async url => String(url).endsWith("/token") ? oauth() : json(body)) as typeof fetch });
    assert.equal(result.oauth.status, "passed");
    assert.equal(result.reporting.status, "failed");
    assert.equal(result.result, "failed");
    assert.equal(result.reason, "PayPal sandbox returned an invalid transaction response.");
  }
  for (const time of [NaN, Infinity, -Infinity, -8640000000000000]) {
    let calls = 0;
    const result = await qualifySandboxReads({ env, now: () => time, fetch: (async () => { calls++; return oauth(); }) as typeof fetch });
    assert.equal(calls, 0);
    assert.equal(result.result, "failed");
    assert.equal(result.oauth.status, "not_run");
    assert.equal(result.reporting.status, "not_run");
    assert.equal(result.reason, "A valid qualification clock is required.");
  }
});
