import { actionIds, type ActionId, type Candidate, type EngineInput, type EngineResult } from "./types";
import { MODEL_VERSION, predictPropensity } from "./propensity";

export const DEFAULT_BUDGET = { monthlyLimitCents: 15000, customerLimitCents: 4000 } as const;
export const APPROVAL_THRESHOLD_CENTS = 1000;
export const MARGIN_FLOOR_BPS = 2000;
export const ACTION_LABELS: Record<ActionId, string> = {
  pause: "Pause subscription",
  downgrade_offer: "Downgrade offer",
  early_pay_discount: "Early-pay discount invoice",
  merchant_reminder: "Merchant reminder",
  goodwill_refund: "Goodwill partial refund",
  human_save_task: "Human save task",
};
// Fixed merchant preferences; probabilities alone do not define action priority.
export const LEVER_WEIGHTS: Record<ActionId, number> = {
  pause: 1, downgrade_offer: 1.05, early_pay_discount: 1.1,
  merchant_reminder: 1, goodwill_refund: 0.95, human_save_task: 0.3,
};

function nonnegativeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
}

function validate(input: EngineInput) {
  if (!input || !input.customer || !input.budget || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw new Error("Invalid decision input");
  const { customer, profile, budget } = input;
  if (!["failed_payment", "past_due", "cancelled", "dispute"].includes(input.signal)) throw new Error("Invalid signal");
  if (!["starter", "growth", "scale"].includes(customer.planId) || typeof customer.id !== "string" || !customer.id
    || typeof customer.subscriptionId !== "string" || !customer.subscriptionId
    || (customer.invoiceId !== null && (typeof customer.invoiceId !== "string" || !customer.invoiceId))) throw new Error("Invalid customer identifiers");
  nonnegativeInteger(input.valueAtRiskCents, "value at risk");
  nonnegativeInteger(customer.monthlyValueCents, "monthly value");
  for (const key of ["tenureMonths", "failedPayments", "daysPastDue"] as const) nonnegativeInteger(customer[key], key);
  // Bound monetary products so basis-point math remains exact before rounding.
  if (input.valueAtRiskCents > 1_000_000_000 || customer.monthlyValueCents > 1_000_000_000) throw new Error("Money exceeds supported range");
  for (const key of ["monthlyLimitCents", "monthlyUsedCents", "customerLimitCents", "customerUsedCents"] as const) nonnegativeInteger(budget[key], key);
  if (profile !== null) {
    if (!profile || !["ACTIVE", "SUSPENDED", "CANCELLED"].includes(profile.subscriptionStatus)
      || typeof profile.contactAllowed !== "boolean") throw new Error("Invalid recovery profile");
    nonnegativeInteger(profile.grossMarginBps, "gross margin");
    nonnegativeInteger(profile.refundableCents, "refundable amount");
    if (profile.grossMarginBps > 10000 || profile.refundableCents > 1_000_000_000
      || (profile.captureId !== null && (typeof profile.captureId !== "string" || !profile.captureId.trim()))) throw new Error("Invalid recovery profile");
  }
}

function historyBlock(value: string | null, now: Date, days: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return "History date is invalid; verify before offering this action.";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value.slice(0, 10)
    || timestamp > now.getTime()) return "History date is invalid or in the future; verify before offering this action.";
  return now.getTime() - timestamp < days * 86400000 ? `Action is within the ${days}-day cooldown.` : null;
}

export function decide(input: EngineInput): EngineResult {
  validate(input);
  const { customer, profile, signal, valueAtRiskCents, budget, now } = input;
  const sensitive = signal === "cancelled" || signal === "dispute";
  const nextPlanCents = customer.planId === "scale" ? 4900 : customer.planId === "growth" ? 1900 : null;
  const concessions: Record<ActionId, number> = {
    pause: Math.ceil(valueAtRiskCents / 4),
    downgrade_offer: nextPlanCents === null ? 0 : Math.max(0, customer.monthlyValueCents - nextPlanCents),
    early_pay_discount: Math.round(valueAtRiskCents / 10), merchant_reminder: 0,
    goodwill_refund: Math.min(Math.floor(valueAtRiskCents / 5), profile?.refundableCents ?? 0), human_save_task: 0,
  };
  const candidates: Candidate[] = actionIds.map(action => {
    const concessionCents = concessions[action];
    const reasons: string[] = [];
    if (action !== "human_save_task") {
      if (valueAtRiskCents === 0) reasons.push("No outstanding value at risk; human review is required.");
      if (!profile) reasons.push("Recovery profile is unknown; human review is required.");
      if (profile && !profile.contactAllowed) reasons.push("Customer contact is not permitted.");
      if (sensitive) reasons.push("Cancellation or dispute requires human review before offers or contact.");
      if (action === "pause" || action === "downgrade_offer") {
        if (signal !== "failed_payment") reasons.push("Requires a failed subscription payment.");
        if (profile?.subscriptionStatus !== "ACTIVE") reasons.push("Requires an active subscription.");
      }
      if (action === "pause" && profile) {
        const block = historyBlock(profile.lastPauseAt, now, 30);
        if (block) reasons.push(block);
      }
      if (action === "downgrade_offer" && (nextPlanCents === null || customer.monthlyValueCents <= nextPlanCents)) reasons.push("No cheaper plan is available.");
      if (action === "early_pay_discount" && (signal !== "past_due" || !customer.invoiceId || customer.daysPastDue < 1)) reasons.push("Requires an unpaid past-due invoice.");
      if (action === "merchant_reminder" && signal !== "failed_payment" && signal !== "past_due") reasons.push("Requires a failed payment or past-due invoice.");
      if (action === "goodwill_refund") {
        if (signal !== "failed_payment") reasons.push("Requires a failed subscription payment.");
        if (!profile?.captureId || profile.refundableCents < 1 || concessionCents < 1) reasons.push("Requires a known capture with refundable value.");
        if (customer.tenureMonths < 6 || customer.failedPayments < 2) reasons.push("Requires six months of tenure and two payment failures.");
        if (profile) {
          const block = historyBlock(profile.lastRefundAt, now, 90);
          if (block) reasons.push(block);
        }
      }
      if (concessionCents > 0) {
        if (concessionCents > budget.monthlyLimitCents - budget.monthlyUsedCents) reasons.push("Monthly concession budget is exhausted.");
        if (concessionCents > budget.customerLimitCents - budget.customerUsedCents) reasons.push("Customer 90-day concession budget is exhausted.");
        if (!profile || concessionCents > Math.floor(valueAtRiskCents * (profile.grossMarginBps - MARGIN_FLOOR_BPS) / 10000)) reasons.push("Concession would breach the 20% margin floor.");
      }
    }
    const eligible = reasons.length === 0;
    const propensity = eligible ? predictPropensity(customer, signal, action) : null;
    if (propensity !== null && (!Number.isFinite(propensity) || propensity < 0 || propensity > 1)) throw new Error("Invalid propensity output");
    const priority = propensity === null ? null : propensity * valueAtRiskCents * LEVER_WEIGHTS[action];
    return {
      action, label: ACTION_LABELS[action], eligible, reasons: eligible ? ["Eligible under recovery-v1."] : reasons,
      propensity, leverWeight: LEVER_WEIGHTS[action], valueAtRiskCents, concessionCents, priority,
      requiresApproval: action === "goodwill_refund" || action === "human_save_task" || concessionCents > APPROVAL_THRESHOLD_CENTS,
      requiresCustomerConsent: action === "downgrade_offer",
    };
  });
  const eligible = candidates.filter(candidate => candidate.eligible);
  const selected = eligible.reduce((best, candidate) => candidate.priority! > best.priority! ? candidate : best);
  const messages: Record<ActionId, string | null> = {
    pause: "Your payment did not go through. We can review a short subscription pause with you. Any change needs confirmation before it takes effect.",
    downgrade_offer: "Your payment did not go through. A lower-priced plan may help. You must review and approve any plan change before it takes effect.",
    early_pay_discount: "Your invoice is past due. We can offer a one-time early-payment discount on an invoice, subject to review before it is sent.",
    merchant_reminder: signal === "past_due" ? "Your invoice is past due. Please review your payment details or contact us if you need help."
      : "Your renewal payment did not go through. Please review your payment details or contact us if you need help.",
    goodwill_refund: "Your payment did not go through. We can review a partial goodwill refund of a previous eligible payment. No refund has been approved or issued.",
    human_save_task: null,
  };
  return {
    action: selected.action, status: selected.requiresApproval ? "pending_review" : "draft",
    reason: `${selected.label} has the highest eligible priority (${selected.priority!.toFixed(2)} = propensity ${selected.propensity!.toFixed(4)} x value ${valueAtRiskCents} cents x lever ${selected.leverWeight}). No external action executed.`,
    message: messages[selected.action], propensity: selected.propensity!, priority: selected.priority!,
    concessionCents: selected.concessionCents, candidates, budget: { ...budget }, requiresCustomerConsent: selected.requiresCustomerConsent,
    policyVersion: "recovery-v1", modelVersion: MODEL_VERSION,
  };
}
