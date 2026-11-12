import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store";
import { InputError, processEvent, simulatedEvent } from "../src/lib/events";
import { mockAdapter } from "../src/lib/paypal";
import type { Decision, ReviewOutcome } from "../src/lib/types";

const now = new Date("2026-11-06T12:00:00.000Z");
async function fixture(store: Store) {
  const customer = store.customer("customer-001")!;
  return processEvent(store, mockAdapter, simulatedEvent(customer, "failed_payment", now), "simulation", now);
}
const status = (expected: number) => (error: unknown) => error instanceof InputError && error.status === expected;

test("approval records an immutable demo review, holds the concession and never executes", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    const original = store.db.prepare("SELECT payload FROM decisions WHERE id = ?").get(decision.id)!.payload;
    const result = store.reviewDemoDecision(decision.id, "approved", now);
    assert.equal(result.duplicate, false);
    assert.equal(result.review.execution, "none");
    assert.equal(result.review.heldConcessionCents, decision.concessionCents);
    assert.equal(result.review.releasedConcessionCents, 0);
    assert.equal(store.dashboard().reservedConcessionCents, decision.concessionCents);
    assert.equal(store.dashboard().pendingReviewCount, 0);
    assert.equal(store.dashboard().auditCount, 2);
    assert.equal(store.db.prepare("SELECT payload FROM decisions WHERE id = ?").get(decision.id)!.payload, original);
    const again = store.reviewDemoDecision(decision.id, "approved", new Date(now.getTime() + 1000));
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.review, result.review);
    assert.equal(store.dashboard().auditCount, 2);
    assert.throws(() => store.reviewDemoDecision(decision.id, "rejected", now), status(409));
    assert.equal(store.dashboard().reservedConcessionCents, decision.concessionCents);
  } finally { store.close(); }
});

test("rejection releases both active budgets and pending cooldown without deleting evidence", async () => {
  const store = new Store(":memory:");
  try {
    const beforeProfile = store.profile("customer-001");
    const { decision } = await fixture(store);
    assert.equal(decision.action, "goodwill_refund");
    assert.equal(store.profile(decision.customerId)!.lastRefundAt, now.toISOString());
    const result = store.reviewDemoDecision(decision.id, "rejected", now);
    assert.equal(result.review.releasedConcessionCents, decision.concessionCents);
    assert.equal(result.review.heldConcessionCents, 0);
    assert.equal(result.review.execution, "none");
    assert.equal(store.budget(decision.customerId, "simulation", now).customerUsedCents, 0);
    assert.equal(store.budget(decision.customerId, "simulation", now).monthlyUsedCents, 0);
    assert.equal(store.dashboard().reservedConcessionCents, 0);
    assert.equal(store.profile(decision.customerId)!.lastRefundAt, beforeProfile!.lastRefundAt);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM concession_reservations").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()!.n, 1);
    assert.equal(store.existing(decision.eventId)!.decision.concessionCents, decision.concessionCents);
    assert.equal(store.reviewDemoDecision(decision.id, "rejected", now).duplicate, true);
    assert.equal(store.dashboard().auditCount, 2);
    assert.throws(() => store.reviewDemoDecision(decision.id, "approved", now), status(409));
  } finally { store.close(); }
});

test("demo review rejects PayPal-sourced and historical decisions without changing their ledgers", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    store.db.prepare("UPDATE webhook_events SET source = 'paypal' WHERE id = ?").run(decision.eventId);
    store.db.prepare("UPDATE concession_reservations SET source = 'paypal' WHERE decision_id = ?").run(decision.id);
    assert.throws(() => store.reviewDemoDecision(decision.id, "rejected", now), status(403));
    assert.equal(store.budget(decision.customerId, "paypal", now).customerUsedCents, decision.concessionCents);
    store.db.prepare("UPDATE webhook_events SET source = 'simulation' WHERE id = ?").run(decision.eventId);
    const legacy: Decision = { ...decision, policyVersion: "foundation-v1" };
    store.db.prepare("UPDATE decisions SET payload = ? WHERE id = ?").run(JSON.stringify(legacy), decision.id);
    assert.throws(() => store.reviewDemoDecision(decision.id, "approved", now), status(409));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM decision_reviews").get()!.n, 0);
    assert.equal(store.dashboard().auditCount, 1);
  } finally { store.close(); }
});

test("invalid outcomes, missing decisions and backward clocks fail closed", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    assert.throws(() => store.reviewDemoDecision("unknown", "rejected", now), status(404));
    assert.throws(() => store.reviewDemoDecision(decision.id, "execute" as ReviewOutcome, now), status(400));
    assert.throws(() => store.reviewDemoDecision(decision.id, "approved", new Date("invalid")), status(400));
    assert.throws(() => store.reviewDemoDecision(decision.id, "approved", new Date(now.getTime() - 1)), status(400));
    assert.equal(store.dashboard().auditCount, 1);
    assert.equal(store.dashboard().reservedConcessionCents, decision.concessionCents);
  } finally { store.close(); }
});

test("a later rejection does not retroactively release an earlier budget snapshot", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    const reviewAt = new Date(now.getTime() + 1000);
    store.reviewDemoDecision(decision.id, "rejected", reviewAt);
    assert.equal(store.budget(decision.customerId, "simulation", now).customerUsedCents, decision.concessionCents);
    assert.equal(store.budget(decision.customerId, "simulation", now).monthlyUsedCents, decision.concessionCents);
    assert.equal(store.budget(decision.customerId, "simulation", reviewAt).customerUsedCents, 0);
    assert.equal(store.budget(decision.customerId, "simulation", reviewAt).monthlyUsedCents, 0);
  } finally { store.close(); }
});

test("a later rejection does not erase cooldown evidence for an earlier decision clock", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    const reviewAt = new Date(now.getTime() + 2000);
    store.reviewDemoDecision(decision.id, "rejected", reviewAt);
    const earlier = new Date(now.getTime() + 1000);
    const customer = store.customer(decision.customerId)!;
    assert.equal(store.profile(customer.id, "simulation", earlier)!.lastRefundAt, now.toISOString());
    assert.equal(store.profile(customer.id, "simulation", reviewAt)!.lastRefundAt, null);
    assert.throws(() => store.profile(customer.id, "simulation", new Date("invalid")), status(400));
    const receipt = await processEvent(store, mockAdapter, simulatedEvent(customer, "failed_payment", earlier), "simulation", earlier);
    const refund = receipt.decision.candidates!.find(candidate => candidate.action === "goodwill_refund")!;
    assert.equal(refund.eligible, false);
    assert(refund.reasons.some(reason => reason.includes("cooldown")));
    assert.equal(receipt.decision.budget!.customerUsedCents, decision.concessionCents);
    assert.notEqual(receipt.decision.action, "goodwill_refund");
  } finally { store.close(); }
});

test("a zero-concession review records no invented reservation or release", async () => {
  const store = new Store(":memory:");
  try {
    const customer = store.customer("customer-001")!;
    const { decision } = await processEvent(store, mockAdapter, simulatedEvent(customer, "cancelled", now), "simulation", now);
    assert.equal(decision.action, "human_save_task");
    assert.equal(decision.concessionCents, 0);
    const result = store.reviewDemoDecision(decision.id, "rejected", now);
    assert.equal(result.review.heldConcessionCents, 0);
    assert.equal(result.review.releasedConcessionCents, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM concession_reservations").get()!.n, 0);
    assert.equal(store.dashboard().auditCount, 2);
    assert.equal(store.dashboard().pendingReviewCount, 0);
  } finally { store.close(); }
});

test("failed review insertion rolls back without releasing or approving a concession", async () => {
  const store = new Store(":memory:");
  try {
    const { decision } = await fixture(store);
    store.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON decision_reviews BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    assert.throws(() => store.reviewDemoDecision(decision.id, "rejected", now), /fixture failure/);
    assert.equal(store.dashboard().pendingReviewCount, 1);
    assert.equal(store.dashboard().auditCount, 1);
    assert.equal(store.budget(decision.customerId, "simulation", now).customerUsedCents, decision.concessionCents);
    store.db.exec("DROP TRIGGER reject_review");
    assert.equal(store.reviewDemoDecision(decision.id, "rejected", now).duplicate, false);
  } finally { store.close(); }
});

test("review survives reopen and separate connections cannot override an accepted outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keepwell-review-"));
  const path = join(dir, "reviews.sqlite");
  const first = new Store(path);
  const second = new Store(path);
  try {
    const { decision } = await fixture(first);
    first.reviewDemoDecision(decision.id, "rejected", now);
    assert.equal(second.reviewDemoDecision(decision.id, "rejected", now).duplicate, true);
    assert.throws(() => second.reviewDemoDecision(decision.id, "approved", now), status(409));
    assert.equal(second.dashboard().auditCount, 2);
    assert.equal(second.dashboard().reservedConcessionCents, 0);
    const reopened = new Store(path);
    try { assert.equal(reopened.dashboard().reviews[decision.id].outcome, "rejected"); }
    finally { reopened.close(); }
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});
