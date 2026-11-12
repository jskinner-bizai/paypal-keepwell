import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/lib/store";
import { processEvent, simulatedEvent } from "../src/lib/events";
import { mockAdapter } from "../src/lib/paypal";
import type { PayPalAdapter } from "../src/lib/types";

const now = new Date("2026-11-12T12:00:00Z");
function sandbox(store: Store) {
  const customer = { ...store.customer("customer-001")!, id: "SANDBOX-ISOLATION", name: "Provider-only fixture", subscriptionId: "I-PROVIDER-ISOLATION", invoiceId: null };
  store.db.prepare("INSERT INTO customers (id, subscription_id, invoice_id, payload) VALUES (?, ?, ?, ?)").run(customer.id, customer.subscriptionId, null, JSON.stringify(customer));
  store.registerSandboxResource(customer.id, "subscription", customer.subscriptionId);
  return customer;
}
const provider: PayPalAdapter = { mode: "sandbox", verifyWebhook: async () => true, getContext: async () => ({ source: "paypal_sandbox", transactionCount: 1, successfulPayments: 1, note: "Injected fixture, no provider request" }) };

test("provider identities and receipts never enter synthetic UI data or summary metrics", async () => {
  const store = new Store(":memory:");
  try {
    const baseline = store.dashboard();
    const customer = sandbox(store);
    assert.equal(store.demoCustomer(customer.id), undefined);
    const receipt = await processEvent(store, provider, simulatedEvent(customer, "failed_payment", now), "paypal", now);
    assert.equal(receipt.decision.context.source, "paypal_sandbox");
    assert.equal(receipt.decision.action, "human_save_task");
    assert.equal(receipt.decision.concessionCents, 0);
    assert.equal(receipt.decision.message, null);
    assert.deepEqual(store.dashboard(), baseline);
    assert.equal(store.existing(receipt.decision.eventId)!.decision.id, receipt.decision.id);
    assert.throws(() => store.reviewDemoDecision(receipt.decision.id, "approved", now), /PayPal/);
    let mockReads = 0;
    const mock = { ...mockAdapter, getContext: async () => { mockReads++; throw new Error("must not read"); } };
    for (const id of [undefined, customer.id]) await assert.rejects(processEvent(store, mock, simulatedEvent(customer, "failed_payment", now), "simulation", now, id), /seeded demo/);
    assert.equal(mockReads, 0);
    assert.deepEqual(store.dashboard(), baseline);
  } finally { store.close(); }
});

test("pre-existing nonseeded simulation evidence is preserved but cannot be replayed, reviewed or counted", async () => {
  const store = new Store(":memory:");
  try {
    const seed = store.customer("customer-001")!;
    const baseline = store.dashboard();
    const customer = sandbox(store);
    const event = simulatedEvent(customer, "failed_payment", now);
    const template = await processEvent(store, mockAdapter, simulatedEvent(seed, "failed_payment", now), "simulation", now);
    const before = store.dashboard();
    const polluted = { ...template.decision, id: "legacy-mixed", eventId: event.id, customerId: customer.id };
    const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
    store.record(event, "simulation", canonical(event), polluted);
    // Historical invalid review rows must not inflate the synthetic audit totals either.
    store.db.prepare("INSERT INTO decision_reviews VALUES (?, 'approved', ?, ?)").run(polluted.id, JSON.stringify({ decisionId: polluted.id, outcome: "approved" }), now.toISOString());
    assert.deepEqual(store.dashboard(), before);
    assert.equal(store.budget(seed.id, "simulation", now).monthlyUsedCents, template.decision.concessionCents);
    assert.throws(() => store.reviewDemoDecision(polluted.id, "approved", now), /seeded synthetic/);
    await assert.rejects(processEvent(store, mockAdapter, event, "simulation", now, customer.id), /seeded demo/);
    assert.equal(store.existing(event.id)!.decision.id, polluted.id);
    assert.equal(baseline.customers.length, 54);
  } finally { store.close(); }
});

test("changing a seeded resource identity removes it from the demo boundary", () => {
  const store = new Store(":memory:");
  try {
    const customer = { ...store.customer("customer-001")!, subscriptionId: "I-NONSEEDED" };
    store.db.prepare("UPDATE customers SET subscription_id = ?, payload = ? WHERE id = ?").run(customer.subscriptionId, JSON.stringify(customer), customer.id);
    assert.equal(store.demoCustomer(customer.id), undefined);
    assert.equal(store.dashboard().customers.some(c => c.id === customer.id), false);
  } finally { store.close(); }
});
