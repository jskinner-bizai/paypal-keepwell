import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/lib/store";
import { createSandboxAdapter } from "../src/lib/paypal";
import { ingestPayPalWebhook } from "../src/lib/webhook";
import { simulatedEvent } from "../src/lib/events";

const now = new Date("2026-11-07T12:00:00Z");
const headers = () => new Headers({ "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/FIXTURE", "paypal-transmission-id": "fixture", "paypal-transmission-sig": "fixture", "paypal-transmission-time": now.toISOString() });
function fixture(store: Store) {
  const customer = { ...store.dashboard().customers[1], id: "SANDBOX-FIXTURE", name: "Local test only", subscriptionId: "I-FIXTURE", invoiceId: "INV-FIXTURE" };
  store.db.prepare("INSERT INTO customers (id, subscription_id, invoice_id, payload) VALUES (?, ?, ?, ?)").run(customer.id, customer.subscriptionId, customer.invoiceId, JSON.stringify(customer));
  return customer;
}
function adapter(status: string, calls: string[]) {
  return createSandboxAdapter({ env: { PAYPAL_CLIENT_ID: "fixture", PAYPAL_CLIENT_SECRET: "fixture", PAYPAL_WEBHOOK_ID: "WH-FIXTURE" }, fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    assert.equal(new URL(String(url)).origin, "https://api-m.sandbox.paypal.com");
    if (path === "/v1/oauth2/token") return Response.json({ access_token: "fixture", token_type: "Bearer", expires_in: 3600 });
    if (path === "/v1/notifications/verify-webhook-signature") {
      assert.equal(JSON.parse(String(init?.body)).webhook_id, "WH-FIXTURE");
      return Response.json({ verification_status: status });
    }
    assert.equal(path, "/v1/reporting/transactions");
    return Response.json({ transaction_details: [] });
  }) as typeof fetch });
}
test("unverified events cannot resolve identity, read reporting or persist receipts", async () => {
  const store = new Store(":memory:");
  try {
    const calls: string[] = [];
    await assert.rejects(ingestPayPalWebhook(() => { throw new Error("Database must not open"); }, adapter("FAILURE", calls), { anything: "malformed" }, headers(), now), /signature/);
    assert.equal(calls.length, 2);
    assert.equal(store.dashboard().eventCount, 0);
    for (const change of [{ "paypal-auth-algo": "MD5" }, { "paypal-transmission-time": "invalid" }]) {
      const h = headers(); Object.entries(change).forEach(([k,v]) => h.set(k,v!));
      const noCalls: string[] = [];
      await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", noCalls), {}, h, now), /signature/);
      assert.equal(noCalls.length, 0);
    }
  } finally { store.close(); }
});
test("verified sandbox fixture requires explicit typed mapping and remains human-only", async () => {
  const store = new Store(":memory:");
  try {
    const seeded = store.dashboard().customers[0];
    assert.throws(() => store.registerSandboxResource(seeded.id, "subscription", seeded.subscriptionId), /separately registered/);
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), simulatedEvent(seeded, "failed_payment", now), headers(), now), /No registered/);
    const customer = fixture(store);
    const event = simulatedEvent(customer, "failed_payment", now);
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), event, headers(), now), /No registered/);
    store.registerSandboxResource(customer.id, "subscription", customer.subscriptionId);
    store.registerSandboxResource(customer.id, "subscription", customer.subscriptionId);
    assert.equal(store.customerByResource(customer.subscriptionId, "invoice", "paypal"), undefined);
    const calls: string[] = [];
    const receipt = await ingestPayPalWebhook(store, adapter("SUCCESS", calls), event, headers(), now);
    assert.equal(receipt.decision.action, "human_save_task");
    assert.equal(receipt.decision.concessionCents, 0);
    assert.equal(receipt.decision.message, null);
    assert.equal(receipt.decision.context.source, "paypal_sandbox");
    assert.equal((await ingestPayPalWebhook(store, adapter("SUCCESS", []), event, headers(), now)).duplicate, true);
    assert.equal(store.dashboard().eventCount, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()!.n, 1);
    assert.equal(store.dashboard().auditCount, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()!.n, 1);
    assert.equal(calls.length, 3);
    const wrongType = { ...event, id: "WRONG-TYPE", resource: { id: customer.invoiceId } };
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), wrongType, headers(), now), /No registered/);
    store.registerSandboxResource(customer.id, "invoice", customer.invoiceId!);
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), wrongType, headers(), now), /No registered/);
    assert.equal(store.customerByResource(customer.invoiceId!, "subscription", "paypal"), undefined);
    const invoice = await ingestPayPalWebhook(store, adapter("SUCCESS", []), simulatedEvent(customer, "past_due", now), headers(), now);
    assert.equal(invoice.decision.action, "human_save_task");
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), { ...event, resource: { id: "other" } }, headers(), now), /different content/);
  } finally { store.close(); }
});

// Sanitized contract regression: the actual sandbox event observed on 2026-11-12
// used resource.invoice. Verification below is injected, NOT real delivery proof.
test("nested invoice envelope preserves verification, raw receipt and idempotency", async () => {
  const store = new Store(":memory:");
  try {
    const customer = fixture(store);
    store.registerSandboxResource(customer.id, "invoice", customer.invoiceId!);
    const base = simulatedEvent(customer, "past_due", now);
    for (const status of ["SENT", "UNPAID", "PARTIALLY_PAID"]) {
      const event = { ...base, id: `NESTED-${status}`, resource: { invoice: { ...base.resource, status, due_amount: { currency_code: "USD", value: "1.00" } } } };
      const calls: string[] = [];
      const sandbox = adapter("SUCCESS", calls);
      const verify = sandbox.verifyWebhook.bind(sandbox);
      sandbox.verifyWebhook = async (raw, h) => { assert.deepEqual(raw, event); return verify(raw, h); };
      const receipt = await ingestPayPalWebhook(store, sandbox, event, headers(), now);
      assert.equal(receipt.decision.valueAtRiskCents, 100);
      assert.equal(receipt.decision.action, "human_save_task");
      assert.equal(receipt.decision.concessionCents, 0);
      assert.equal(receipt.decision.context.source, "paypal_sandbox");
      assert.equal(calls.length, 3);
      const raw = JSON.parse(String(store.db.prepare("SELECT payload FROM webhook_events WHERE id=?").get(event.id)!.payload));
      assert.deepEqual(raw.resource, event.resource);
      assert.equal((await ingestPayPalWebhook(store, adapter("SUCCESS", []), event, headers(), now)).duplicate, true);
      await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), { ...event, resource: event.resource.invoice }, headers(), now), /different content/);
    }
    assert.equal(store.dashboard().eventCount, 0);
  } finally { store.close(); }
});

test("nested invoice rejects malformed identity, amounts, dates and paid states before reporting", async () => {
  const store = new Store(":memory:");
  try {
    const customer = fixture(store);
    const base = simulatedEvent(customer, "past_due", now);
    const nested = { ...base, resource: { invoice: base.resource } };
    await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", []), nested, headers(), now), /No registered/);
    store.registerSandboxResource(customer.id, "invoice", customer.invoiceId!);
    const invalid = [
      { invoice: null }, { invoice: [] }, { invoice: { ...base.resource }, id: customer.invoiceId },
      { invoice: { ...base.resource }, due_amount: { currency_code: "USD", value: "1.00" } },
      ...["PAID", "CANCELLED", "DRAFT", "REFUNDED"].map(status => ({ invoice: { ...base.resource, status } })),
      { invoice: { ...base.resource, id: customer.subscriptionId } },
      { invoice: { ...base.resource, id: store.dashboard().customers[1].invoiceId } },
      { invoice: { ...base.resource, due_amount: { currency_code: "EUR", value: "1.00" } } },
      { invoice: { ...base.resource, due_amount: { currency_code: "USD", value: "0.00" } } },
      { invoice: { ...base.resource, due_amount: { currency_code: "USD", value: "-1" } } },
      { invoice: { ...base.resource, detail: { payment_term: { due_date: "2026-11-07" } } } },
      { invoice: { ...base.resource, detail: { payment_term: { due_date: "2026-02-30" } } } },
    ];
    for (const resource of invalid) {
      const calls: string[] = [];
      await assert.rejects(ingestPayPalWebhook(store, adapter("SUCCESS", calls), { ...base, resource }, headers(), now));
      assert.equal(calls.length, 2, "Only OAuth/signature verification, no reporting read");
    }
    const rejectedCalls: string[] = [];
    await assert.rejects(ingestPayPalWebhook(() => { throw new Error("Must not open DB"); }, adapter("FAILURE", rejectedCalls), nested, headers(), now), /signature/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()!.n, 0);
  } finally { store.close(); }
});
