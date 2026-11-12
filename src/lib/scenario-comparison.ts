import { decide, DEFAULT_BUDGET } from "./engine";
import { generateCustomers, generateRecoveryProfile } from "./seed";
import { seededRandom, syntheticOutcomeProbability } from "./synthetic-history";
import model from "./propensity-model.json";
import { actionIds, type ActionId, type BudgetSnapshot, type Candidate, type Customer, type RecoveryProfile, type Signal } from "./types";

export const EVALUATION_SEED = 20261103;
export const COMPARISON_AS_OF = "2026-11-03T12:00:00.000Z";
export const COMPARISON_LABEL = "Scenario simulation on synthetic data: paired policy replay";
const APPROVAL_RATE = 0.9;
const CONSENT_RATE = 0.75;

export type ScenarioCase = { id: string; customer: Customer; profile: RecoveryProfile; signal: Signal; approvalDraw: number; consentDraw: number; outcomeDraw: number };
export type ScenarioCaseResult = {
  caseId: string;
  customerId: string;
  signal: Signal;
  action: ActionId;
  selected: Candidate;
  candidates: Candidate[];
  budgetBefore: BudgetSnapshot;
  approvalAssumed: boolean | null;
  customerConsentAssumed: boolean | null;
  outcomeProbability: number;
  saved: boolean;
  grossRevenueCents: number;
  concessionSpendCents: number;
  netRevenueCents: number;
};
export type ArmResult = {
  label: string;
  cases: number;
  saves: number;
  grossRevenueCents: number;
  concessionSpendCents: number;
  netRevenueCents: number;
  reservedConcessionCents: number;
  pendingApprovalCount: number;
  assumedApprovedCount: number;
  consentRequiredCount: number;
  actionMix: Record<ActionId, number>;
  results: ScenarioCaseResult[];
};

export function generateEvaluationCases(): ScenarioCase[] {
  const random = seededRandom(EVALUATION_SEED ^ 0x5a5a5a5a);
  return generateCustomers(EVALUATION_SEED).map((original, index) => {
    const customer: Customer = { ...original, id: `eval-${original.id}`, subscriptionId: `eval-${original.subscriptionId}`, invoiceId: original.invoiceId ? `eval-${original.invoiceId}` : null };
    const signal: Signal = index % 9 === 7 ? "dispute" : index % 9 === 8 ? "cancelled" : customer.invoiceId ? "past_due" : "failed_payment";
    return { id: `eval-case-${String(index + 1).padStart(3, "0")}`, customer, profile: generateRecoveryProfile(customer), signal, approvalDraw: random(), consentDraw: random(), outcomeDraw: random() };
  });
}

type Reservation = { customerId: string; cents: number; createdAt: string };
function budgetFor(customerId: string, reservations: Reservation[]): BudgetSnapshot {
  const cutoff = new Date(Date.parse(COMPARISON_AS_OF) - 90 * 86400000).toISOString();
  return {
    ...DEFAULT_BUDGET,
    monthlyUsedCents: reservations.filter(row => row.createdAt.slice(0, 7) === COMPARISON_AS_OF.slice(0, 7)).reduce((sum, row) => sum + row.cents, 0),
    customerUsedCents: reservations.filter(row => row.customerId === customerId && row.createdAt >= cutoff && row.createdAt <= COMPARISON_AS_OF).reduce((sum, row) => sum + row.cents, 0),
  };
}

function replay(cases: ScenarioCase[], challenger: boolean): ArmResult {
  const reservations: Reservation[] = [];
  const results: ScenarioCaseResult[] = [];
  for (const scenario of cases) {
    const budget = budgetFor(scenario.customer.id, reservations);
    const decision = decide({ customer: scenario.customer, signal: scenario.signal, profile: scenario.profile, valueAtRiskCents: scenario.customer.monthlyValueCents, budget, now: new Date(COMPARISON_AS_OF) });
    const reminder = decision.candidates.find(candidate => candidate.action === "merchant_reminder" && candidate.eligible);
    const selected = decision.candidates.find(candidate => candidate.action === (challenger ? decision.action : reminder ? "merchant_reminder" : "human_save_task"))!;
    if (!selected.eligible || selected.concessionCents + budget.monthlyUsedCents > budget.monthlyLimitCents || selected.concessionCents + budget.customerUsedCents > budget.customerLimitCents) throw new Error("Scenario selected an ineligible or over-budget action");
    if (selected.concessionCents > 0) reservations.push({ customerId: scenario.customer.id, cents: selected.concessionCents, createdAt: COMPARISON_AS_OF });
    const approvalAssumed = selected.requiresApproval ? scenario.approvalDraw < APPROVAL_RATE : null;
    const customerConsentAssumed = selected.requiresCustomerConsent ? scenario.consentDraw < CONSENT_RATE : null;
    const activated = approvalAssumed !== false && customerConsentAssumed !== false;
    const outcomeProbability = scenario.profile.contactAllowed ? syntheticOutcomeProbability(scenario.customer, scenario.signal, selected.action) : 0;
    if (!Number.isFinite(outcomeProbability) || outcomeProbability < 0 || outcomeProbability > 1) throw new Error("Invalid synthetic outcome probability");
    const saved = activated && scenario.outcomeDraw < outcomeProbability;
    const grossRevenueCents = saved ? scenario.customer.monthlyValueCents : 0;
    const concessionSpendCents = activated && (selected.action === "goodwill_refund" || saved) ? selected.concessionCents : 0;
    results.push({ caseId: scenario.id, customerId: scenario.customer.id, signal: scenario.signal, action: selected.action, selected, candidates: decision.candidates, budgetBefore: budget, approvalAssumed, customerConsentAssumed, outcomeProbability, saved, grossRevenueCents, concessionSpendCents, netRevenueCents: grossRevenueCents - concessionSpendCents });
  }
  const actionMix = Object.fromEntries(actionIds.map(action => [action, results.filter(row => row.action === action).length])) as Record<ActionId, number>;
  return {
    label: challenger ? "Challenger: ranked six-lever policy" : "Champion: reminder-only dunning with the same mandatory human-review safety rules",
    cases: results.length, saves: results.filter(row => row.saved).length,
    grossRevenueCents: results.reduce((sum, row) => sum + row.grossRevenueCents, 0),
    concessionSpendCents: results.reduce((sum, row) => sum + row.concessionSpendCents, 0),
    netRevenueCents: results.reduce((sum, row) => sum + row.netRevenueCents, 0),
    reservedConcessionCents: reservations.reduce((sum, row) => sum + row.cents, 0),
    pendingApprovalCount: results.filter(row => row.selected.requiresApproval).length,
    assumedApprovedCount: results.filter(row => row.approvalAssumed === true).length,
    consentRequiredCount: results.filter(row => row.selected.requiresCustomerConsent).length,
    actionMix, results,
  };
}

export function compareScenarios() {
  if (model.trainingSeed === EVALUATION_SEED || model.calibrationSeed === EVALUATION_SEED) throw new Error("Evaluation seed must be disjoint from training and calibration");
  const cases = generateEvaluationCases();
  const champion = replay(cases, false);
  const challenger = replay(cases, true);
  return {
    label: COMPARISON_LABEL,
    asOf: COMPARISON_AS_OF,
    horizonDays: 30,
    evaluationSeed: EVALUATION_SEED,
    trainingSeed: model.trainingSeed,
    calibrationSeed: model.calibrationSeed,
    modelVersion: model.modelVersion,
    methodology: "The same 54 disjoint synthetic cases are replayed through both policies with shared per-case draws. This is a paired scenario replay, not a randomized holdout or a causal merchant lift estimate.",
    assumptions: [
      "All customers, histories and realized outcomes are synthetic. No transaction or customer contact executes.",
      "Response probabilities come from a separate hand-authored synthetic outcome surface, not the trained propensity score. The model learned from the same stated synthetic assumptions on separate historical identities and seeds; this is not independent evidence of effectiveness.",
      "A selected promise reserves its full concession before outcomes, including unapproved offers. Reservations are not recycled during the run. Each arm has its own monthly and rolling 90-day customer budget.",
      `Required merchant approvals are assumed with probability ${APPROVAL_RATE}; required buyer consent is separately assumed with probability ${CONSENT_RATE}. The same approval, consent and save draws are used for each case in both arms.`,
      "pendingApprovalCount counts recommendations needing review before assumed approvals; it is not a live approval queue.",
      "A save is an illustrative 30-day billing-cycle recovery. Gross revenue is receivable face value on a save; net revenue subtracts assumed concessions. Pause models a 25% one-cycle offset; downgrade models one-cycle plan-price difference. These are scenario economics, not PayPal billing behavior.",
      "A goodwill refund incurs concession spend after assumed approval even when the customer is not saved. Other offer concessions incur spend only on a save. Uncontactable customers never produce a simulated save from a human task.",
      "The champion sends only eligible reminders; sensitive or uncontactable cases use the same internal human-review safety fallback. Neither policy contacts an uncontactable customer.",
      "One event is evaluated per customer. Budget behavior across repeated events is covered by engine and persistence tests, not inferred from this cohort.",
    ],
    champion, challenger,
    delta: {
      saves: challenger.saves - champion.saves,
      grossRevenueCents: challenger.grossRevenueCents - champion.grossRevenueCents,
      concessionSpendCents: challenger.concessionSpendCents - champion.concessionSpendCents,
      netRevenueCents: challenger.netRevenueCents - champion.netRevenueCents,
    },
  };
}

export type ScenarioComparison = ReturnType<typeof compareScenarios>;
