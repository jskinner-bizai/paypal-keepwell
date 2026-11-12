import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScenarios, generateEvaluationCases, EVALUATION_SEED } from "../src/lib/scenario-comparison";
import { generateSyntheticHistory } from "../src/lib/synthetic-history";
import { DEFAULT_BUDGET } from "../src/lib/engine";

test("paired scenario replay is repeatable, disjoint and explicitly synthetic", () => {
  const result = compareScenarios();
  assert.deepEqual(result, compareScenarios());
  assert.match(result.label, /Scenario simulation on synthetic data/);
  assert.match(result.methodology, /not a randomized holdout/);
  assert.equal(result.evaluationSeed, EVALUATION_SEED);
  assert.notEqual(result.trainingSeed, result.evaluationSeed);
  assert.notEqual(result.calibrationSeed, result.evaluationSeed);
  const cases = generateEvaluationCases();
  assert.equal(cases.length, 54);
  assert.equal(new Set(cases.map(row => row.id)).size, 54);
  assert.equal(new Set(cases.map(row => row.signal)).size, 4);
  assert(cases.filter(row => row.signal === "past_due").every(row => row.customer.invoiceId));
  const trainingIds = new Set(generateSyntheticHistory(result.trainingSeed).map(row => row.customer.id));
  const calibrationIds = new Set(generateSyntheticHistory(result.calibrationSeed, 240).map(row => row.customer.id));
  assert(cases.every(row => row.customer.id.startsWith("eval-") && !trainingIds.has(row.customer.id) && !calibrationIds.has(row.customer.id)));
  assert.deepEqual(result.champion.results.map(row => row.caseId), result.challenger.results.map(row => row.caseId));
  assert.deepEqual(result.champion.results.map(row => row.customerId), result.challenger.results.map(row => row.customerId));
  for (const [index, champion] of result.champion.results.entries()) {
    const challenger = result.challenger.results[index];
    if (champion.action === challenger.action) {
      assert.equal(champion.approvalAssumed, challenger.approvalAssumed);
      assert.equal(champion.customerConsentAssumed, challenger.customerConsentAssumed);
      assert.equal(champion.saved, challenger.saved);
    }
  }
});

test("scenario money reconciles and both arms keep independent budgets", () => {
  const result = compareScenarios();
  for (const arm of [result.champion, result.challenger]) {
    assert.equal(arm.cases, 54);
    assert.equal(Object.values(arm.actionMix).reduce((sum, count) => sum + count, 0), 54);
    assert.equal(arm.grossRevenueCents - arm.concessionSpendCents, arm.netRevenueCents);
    assert(arm.reservedConcessionCents <= DEFAULT_BUDGET.monthlyLimitCents);
    assert(arm.concessionSpendCents <= arm.reservedConcessionCents);
    assert.equal(arm.saves, arm.results.filter(row => row.saved).length);
    assert.equal(arm.pendingApprovalCount, arm.results.filter(row => row.selected.requiresApproval).length);
    for (const row of arm.results) {
      assert(row.selected.eligible);
      assert(Number.isSafeInteger(row.grossRevenueCents));
      assert(Number.isSafeInteger(row.concessionSpendCents));
      assert.equal(row.grossRevenueCents - row.concessionSpendCents, row.netRevenueCents);
      assert(row.selected.concessionCents + row.budgetBefore.monthlyUsedCents <= row.budgetBefore.monthlyLimitCents);
      assert(row.selected.concessionCents + row.budgetBefore.customerUsedCents <= row.budgetBefore.customerLimitCents);
      if (row.approvalAssumed === false || row.customerConsentAssumed === false) {
        assert.equal(row.saved, false);
        assert.equal(row.concessionSpendCents, 0);
      }
      if (!row.saved && row.action !== "goodwill_refund") assert.equal(row.concessionSpendCents, 0);
    }
  }
  assert.equal(result.champion.reservedConcessionCents, 0);
  assert(result.champion.results.every(row => ["merchant_reminder", "human_save_task"].includes(row.action)));
  assert.equal(result.delta.saves, result.challenger.saves - result.champion.saves);
  assert.equal(result.delta.netRevenueCents, result.challenger.netRevenueCents - result.champion.netRevenueCents);
});

test("uncontactable and sensitive cases preserve the same safety rules in both arms", () => {
  const result = compareScenarios();
  const cases = new Map(generateEvaluationCases().map(row => [row.id, row]));
  for (const arm of [result.champion, result.challenger]) for (const row of arm.results) {
    const scenario = cases.get(row.caseId)!;
    if (["cancelled", "dispute"].includes(row.signal) || !scenario.profile.contactAllowed) assert.equal(row.action, "human_save_task");
    if (!scenario.profile.contactAllowed) {
      assert.equal(row.saved, false);
      assert.equal(row.outcomeProbability, 0);
    }
  }
});
