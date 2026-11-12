import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_LABELS, APPROVAL_THRESHOLD_CENTS, decide, DEFAULT_BUDGET, LEVER_WEIGHTS } from "../src/lib/engine";
import { predictPropensity, MODEL_VERSION } from "../src/lib/propensity";
import { actionIds, type ActionId, type EngineInput } from "../src/lib/types";
import { generateCustomers, generateRecoveryProfile } from "../src/lib/seed";

const now = new Date("2026-11-03T12:00:00.000Z");
function input(): EngineInput {
  return {
    customer: { id: "engine-customer", name: "Synthetic customer", planId: "growth", subscriptionId: "I-DEMO", invoiceId: "INV-DEMO", monthlyValueCents: 4900, tenureMonths: 12, failedPayments: 2, daysPastDue: 8 },
    signal: "failed_payment", valueAtRiskCents: 4900,
    profile: { subscriptionStatus: "ACTIVE", contactAllowed: true, grossMarginBps: 9000, captureId: "CAPTURE-DEMO", refundableCents: 4900, lastRefundAt: null, lastPauseAt: null },
    budget: { ...DEFAULT_BUDGET, monthlyUsedCents: 0, customerUsedCents: 0 }, now,
  };
}
const candidate = (value: EngineInput, action: ActionId) => decide(value).candidates.find(row => row.action === action)!;
const ago = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();

test("six candidates expose eligibility, trained propensity and the exact priority formula", () => {
  const value = input();
  const result = decide(value);
  assert.equal(result.policyVersion, "recovery-v1");
  assert.equal(result.modelVersion, MODEL_VERSION);
  assert.deepEqual(result.candidates.map(row => row.action), actionIds);
  for (const row of result.candidates) {
    assert.equal(row.label, ACTION_LABELS[row.action]);
    assert.equal(row.leverWeight, LEVER_WEIGHTS[row.action]);
    assert(row.reasons.length > 0);
    if (row.eligible) {
      assert.equal(row.propensity, predictPropensity(value.customer, value.signal, row.action));
      assert.equal(row.priority, row.propensity! * value.valueAtRiskCents * row.leverWeight);
    } else {
      assert.equal(row.propensity, null);
      assert.equal(row.priority, null);
    }
  }
  assert.equal(candidate(value, "pause").eligible, true);
  assert.equal(candidate(value, "downgrade_offer").eligible, true);
  assert.equal(candidate(value, "goodwill_refund").eligible, true);
  assert.equal(candidate(value, "merchant_reminder").eligible, true);
  assert.equal(candidate(value, "human_save_task").eligible, true);
  assert.equal(candidate(value, "early_pay_discount").eligible, false);
  const invoice = { ...value, signal: "past_due" as const };
  assert.equal(candidate(invoice, "early_pay_discount").eligible, true);
  assert.equal(candidate(invoice, "pause").eligible, false);
  assert.equal(candidate(invoice, "goodwill_refund").eligible, false);
});

test("eligibility excludes cheapest-plan downgrades, absent invoices and inactive subscriptions", () => {
  const value = input();
  value.customer.planId = "starter";
  value.customer.monthlyValueCents = 1900;
  assert.equal(candidate(value, "downgrade_offer").eligible, false);
  value.customer.invoiceId = null;
  value.signal = "past_due";
  assert.equal(candidate(value, "early_pay_discount").eligible, false);
  value.signal = "failed_payment";
  value.profile!.subscriptionStatus = "SUSPENDED";
  assert.equal(candidate(value, "pause").eligible, false);
  assert.equal(candidate(value, "merchant_reminder").eligible, true);
});

test("the fixed demo cohort cannot qualify for downgrade under current margin and budget limits", () => {
  for (const customer of generateCustomers()) {
    const value = { ...input(), customer, valueAtRiskCents: customer.monthlyValueCents, profile: generateRecoveryProfile(customer) };
    const downgrade = candidate(value, "downgrade_offer");
    assert.equal(downgrade.eligible, false, customer.id);
    const expected = customer.planId === "starter" ? "No cheaper plan" : customer.planId === "growth" ? "margin floor" : "Customer 90-day";
    assert(downgrade.reasons.some(reason => reason.includes(expected)), customer.id);
  }
});

test("cooldowns include the instant before 30 and 90 days and permit exact boundaries", () => {
  const value = input();
  value.profile!.lastPauseAt = new Date(now.getTime() - 30 * 86400000 + 1).toISOString();
  value.profile!.lastRefundAt = new Date(now.getTime() - 90 * 86400000 + 1).toISOString();
  assert.equal(candidate(value, "pause").eligible, false);
  assert.equal(candidate(value, "goodwill_refund").eligible, false);
  value.profile!.lastPauseAt = ago(30);
  value.profile!.lastRefundAt = ago(90);
  assert.equal(candidate(value, "pause").eligible, true);
  assert.equal(candidate(value, "goodwill_refund").eligible, true);
});

test("malformed, impossible and future history dates block the relevant action", () => {
  for (const timestamp of ["not-a-date", "2026-02-30T12:00:00.000Z", new Date(now.getTime() + 1).toISOString()]) {
    const value = input();
    value.profile!.lastPauseAt = timestamp;
    value.profile!.lastRefundAt = timestamp;
    assert.equal(candidate(value, "pause").eligible, false);
    assert.equal(candidate(value, "goodwill_refund").eligible, false);
    assert.equal(candidate(value, "human_save_task").eligible, true);
  }
});

test("concession budgets accept exact cents and reject a one-cent excess independently", () => {
  const value = input();
  const cost = candidate(value, "pause").concessionCents;
  assert.equal(cost, 1225);
  value.budget.monthlyUsedCents = value.budget.monthlyLimitCents - cost;
  value.budget.customerUsedCents = value.budget.customerLimitCents - cost;
  assert.equal(candidate(value, "pause").eligible, true);
  value.budget.monthlyUsedCents++;
  assert.equal(candidate(value, "pause").eligible, false);
  assert(candidate(value, "pause").reasons.some(reason => reason.startsWith("Monthly")));
  value.budget.monthlyUsedCents--;
  value.budget.customerUsedCents++;
  assert.equal(candidate(value, "pause").eligible, false);
  assert(candidate(value, "pause").reasons.some(reason => reason.startsWith("Customer")));
  assert.equal(candidate(value, "merchant_reminder").eligible, true);
});

test("20% margin floor is inclusive and cent rounding cannot overspend", () => {
  const value = input();
  value.signal = "past_due";
  value.valueAtRiskCents = 100;
  value.profile!.grossMarginBps = 3000;
  assert.equal(candidate(value, "early_pay_discount").concessionCents, 10);
  assert.equal(candidate(value, "early_pay_discount").eligible, true);
  value.profile!.grossMarginBps = 2999;
  assert.equal(candidate(value, "early_pay_discount").eligible, false);
  value.valueAtRiskCents = 105;
  value.profile!.grossMarginBps = 3000;
  assert.equal(candidate(value, "early_pay_discount").concessionCents, 11);
  assert.equal(candidate(value, "early_pay_discount").eligible, false);
});

test("refund is capped by known capture, requires history, and always requires approval", () => {
  const value = input();
  value.profile!.refundableCents = 5;
  const refund = candidate(value, "goodwill_refund");
  assert.equal(refund.eligible, true);
  assert.equal(refund.concessionCents, 5);
  assert.equal(refund.requiresApproval, true);
  value.profile!.captureId = null;
  assert.equal(candidate(value, "goodwill_refund").eligible, false);
  value.profile!.captureId = "CAPTURE-DEMO";
  value.customer.tenureMonths = 5;
  assert.equal(candidate(value, "goodwill_refund").eligible, false);
  value.customer.tenureMonths = 6;
  value.customer.failedPayments = 1;
  assert.equal(candidate(value, "goodwill_refund").eligible, false);
});

test("approval threshold is strict, downgrade needs consent and selected status follows policy", () => {
  const value = input();
  value.valueAtRiskCents = APPROVAL_THRESHOLD_CENTS * 4;
  assert.equal(candidate(value, "pause").requiresApproval, false);
  value.valueAtRiskCents++;
  assert.equal(candidate(value, "pause").requiresApproval, true);
  assert.equal(candidate(value, "downgrade_offer").requiresCustomerConsent, true);
  const selected = decide(value);
  const selectedRow = selected.candidates.find(row => row.action === selected.action)!;
  assert.equal(selected.status, selectedRow.requiresApproval ? "pending_review" : "draft");
  assert.equal(selected.requiresCustomerConsent, selectedRow.requiresCustomerConsent);
  assert.equal(selected.concessionCents, selectedRow.concessionCents);
});

test("sensitive events, unknown profiles and contact restrictions select internal human review", () => {
  const values: EngineInput[] = [
    { ...input(), signal: "cancelled" }, { ...input(), signal: "dispute" }, { ...input(), profile: null },
  ];
  const restricted = input();
  restricted.profile!.contactAllowed = false;
  values.push(restricted);
  for (const value of values) {
    const result = decide(value);
    assert.equal(result.action, "human_save_task");
    assert.equal(result.status, "pending_review");
    assert.equal(result.message, null);
    assert.equal(result.concessionCents, 0);
    assert.deepEqual(result.candidates.filter(row => row.eligible).map(row => row.action), ["human_save_task"]);
  }
});

test("repeated inputs are deterministic and do not mutate budgets", () => {
  const value = input();
  const before = structuredClone(value);
  assert.deepEqual(decide(value), decide(value));
  assert.deepEqual(value, before);
});

test("zero value at risk cannot trigger offers, refunds, pauses or customer reminders", () => {
  const value = input();
  value.valueAtRiskCents = 0;
  const result = decide(value);
  assert.equal(result.action, "human_save_task");
  assert.equal(result.status, "pending_review");
  assert.equal(result.message, null);
  assert.equal(result.concessionCents, 0);
  assert.equal(result.priority, 0);
  assert.deepEqual(result.candidates.filter(row => row.eligible).map(row => row.action), ["human_save_task"]);
  assert(result.candidates.filter(row => row.action !== "human_save_task").every(row => row.reasons.some(reason => reason.startsWith("No outstanding value"))));
});

test("invalid money, counts, budget, profile and decision clock fail closed", () => {
  for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = input();
    value.valueAtRiskCents = invalid;
    assert.throws(() => decide(value), /Invalid|supported range/);
    const budget = input();
    budget.budget.monthlyUsedCents = invalid;
    assert.throws(() => decide(budget), /Invalid/);
  }
  const margin = input(); margin.profile!.grossMarginBps = 10001;
  assert.throws(() => decide(margin), /Invalid/);
  const contact = input(); (contact.profile as unknown as { contactAllowed: unknown }).contactAllowed = "yes";
  assert.throws(() => decide(contact), /Invalid/);
  const clock = input(); clock.now = new Date("bad");
  assert.throws(() => decide(clock), /Invalid/);
  const count = input(); count.customer.failedPayments = -1;
  assert.throws(() => decide(count), /Invalid/);
  const signal = input(); (signal as unknown as { signal: string }).signal = "unknown";
  assert.throws(() => decide(signal), /Invalid/);
});
