import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { DEFAULT_BUDGET } from "../src/lib/engine";
import { processEvent, simulatedEvent } from "../src/lib/events";
import { mockAdapter } from "../src/lib/paypal";
import type { Decision } from "../src/lib/types";

const now = new Date("2026-11-03T12:00:00.000Z");
test("schema upgrade preserves foundation receipts and adds synthetic profiles without resetting data", () => {
  const dir = mkdtempSync(join(tmpdir(), "keepwell-migration-"));
  const path = join(dir, "v1.sqlite");
  const db = new DatabaseSync(path);
  db.exec(readFileSync("migrations/001_foundation.sql", "utf8"));
  db.prepare("INSERT INTO customers VALUES ('legacy', 'I-LEGACY', NULL, ?)").run('{"id":"legacy"}');
  db.prepare("INSERT INTO webhook_events VALUES ('old-event', 'simulation', '{}', ?)").run(now.toISOString());
  const payload = '{"id":"old-decision","eventId":"old-event","policyVersion":"foundation-v1","status":"draft"}';
  db.prepare("INSERT INTO decisions VALUES ('old-decision', 'old-event', 'legacy', ?)").run(payload);
  db.close();
  const store = new Store(path);
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
    assert.equal(store.db.prepare("SELECT payload FROM decisions WHERE id='old-decision'").get()!.payload, payload);
    assert.equal(store.profile("legacy"), null);
    assert.equal(store.dashboard().eventCount, 0);
    assert.equal(store.dashboard().customers.length, 54);
    assert.equal(store.profile("customer-001")?.captureId, "DEMO-CAPTURE-customer-001");
    assert.equal(store.profile("customer-001", "paypal"), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent event processing across connections reserves fresh budgets atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keepwell-budget-"));
  const path = join(dir, "concurrent.sqlite");
  const stores = [new Store(path), new Store(path)];
  try {
    const customers = stores[0].dashboard().customers;
    const events = customers.map(customer => simulatedEvent(customer, "failed_payment", now));
    const receipts = await Promise.all(events.map((event, index) => processEvent(stores[index % 2], mockAdapter, event, "simulation", now)));
    const dashboard = stores[0].dashboard();
    assert.equal(dashboard.eventCount, 54);
    assert.equal(dashboard.auditCount, 54);
    assert.equal(dashboard.reservedConcessionCents, receipts.reduce((sum, receipt) => sum + receipt.decision.concessionCents, 0));
    assert(dashboard.reservedConcessionCents <= DEFAULT_BUDGET.monthlyLimitCents);
    assert(receipts.some(receipt => receipt.decision.candidates!.some(candidate => candidate.reasons.some(reason => reason.startsWith("Monthly")))));
    for (const receipt of receipts) {
      assert(receipt.decision.budget!.customerUsedCents + receipt.decision.concessionCents <= DEFAULT_BUDGET.customerLimitCents);
      assert(receipt.decision.budget!.monthlyUsedCents + receipt.decision.concessionCents <= DEFAULT_BUDGET.monthlyLimitCents);
    }
    const duplicate = await processEvent(stores[1], mockAdapter, events[0], "simulation", now);
    assert.equal(duplicate.duplicate, true);
    assert.equal(stores[0].dashboard().reservedConcessionCents, dashboard.reservedConcessionCents);
    const repeat = await processEvent(stores[0], mockAdapter, simulatedEvent(customers[0], "failed_payment", now), "simulation", now);
    assert(repeat.decision.candidates!.find(candidate => candidate.action === "goodwill_refund")!.reasons.some(reason => reason.includes("cooldown")));
    assert.equal(stores[0].budget(customers[0].id, "paypal", now).monthlyUsedCents, 0);
  } finally { stores.forEach(store => store.close()); rmSync(dir, { recursive: true, force: true }); }
});

test("budget windows use UTC months and rolling 90 days without confusing reservations with spend", () => {
  const store = new Store(":memory:");
  try {
    const customer = store.dashboard().customers[0];
    for (const [index, date] of ["2026-11-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z", "2026-08-05T12:00:00.000Z", "2026-08-05T11:59:59.999Z"].entries()) {
      const event = simulatedEvent(customer, "failed_payment", new Date(date));
      const decision: Decision = { id: `window-${index}`, eventId: event.id, customerId: customer.id, action: "pause", status: "draft", reason: "Budget window fixture", message: null, valueAtRiskCents: 1900, concessionCents: 100, trace: [], context: { source: "synthetic", transactionCount: 0, successfulPayments: 0, note: "Fixture" }, policyVersion: "recovery-v1", createdAt: date };
      store.db.exec("BEGIN IMMEDIATE");
      store.record(event, "simulation", JSON.stringify(event), decision);
      store.db.exec("COMMIT");
    }
    const budget = store.budget(customer.id, "simulation", now);
    assert.equal(budget.monthlyUsedCents, 100);
    assert.equal(budget.customerUsedCents, 300);
    assert.equal(store.dashboard().reservedConcessionCents, 400);
  } finally { store.close(); }
});

test("rolling customer budgets include the current instant and exclude future reservations", () => {
  const store = new Store(":memory:");
  try {
    const customer = store.dashboard().customers[0];
    const otherCustomer = store.dashboard().customers[1];
    const fixtures = [
      { customer, source: "simulation" as const, date: now.toISOString(), cents: 100 },
      { customer, source: "simulation" as const, date: "2026-11-03T12:00:00.001Z", cents: 200 },
      { customer, source: "simulation" as const, date: "2026-12-01T00:00:00.000Z", cents: 400 },
      { customer: otherCustomer, source: "simulation" as const, date: now.toISOString(), cents: 800 },
      { customer, source: "paypal" as const, date: now.toISOString(), cents: 1600 },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const event = simulatedEvent(fixture.customer, "failed_payment", new Date(fixture.date));
      const decision: Decision = { id: `future-window-${index}`, eventId: event.id, customerId: fixture.customer.id, action: "pause", status: "draft", reason: "Budget window fixture", message: null, valueAtRiskCents: 1900, concessionCents: fixture.cents, trace: [], context: { source: fixture.source === "paypal" ? "paypal_sandbox" : "synthetic", transactionCount: 0, successfulPayments: 0, note: "Fixture" }, policyVersion: "recovery-v1", createdAt: fixture.date };
      store.db.exec("BEGIN IMMEDIATE");
      store.record(event, fixture.source, JSON.stringify(event), decision);
      store.db.exec("COMMIT");
    }
    const budget = store.budget(customer.id, "simulation", now);
    assert.equal(budget.customerUsedCents, 100);
    // Merchant commitments remain counted for the entire UTC month, including future promises.
    assert.equal(budget.monthlyUsedCents, 1100);
    assert.equal(store.budget(customer.id, "paypal", now).customerUsedCents, 1600);
    assert.equal(store.dashboard().reservedConcessionCents, 1500);
  } finally { store.close(); }
});
