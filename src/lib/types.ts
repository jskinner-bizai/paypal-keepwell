export type PlanId = "starter" | "growth" | "scale";
export type Customer = {
  id: string;
  name: string;
  planId: PlanId;
  subscriptionId: string;
  invoiceId: string | null;
  monthlyValueCents: number;
  tenureMonths: number;
  failedPayments: number;
  daysPastDue: number;
};
export type PayPalEvent = {
  id: string;
  event_type: string;
  create_time: string;
  resource: Record<string, unknown>;
};
export type MerchantContext = {
  source: "synthetic" | "paypal_sandbox";
  transactionCount: number;
  successfulPayments: number;
  note: string;
};
export type PayPalAdapter = {
  mode: "mock" | "sandbox";
  getContext(customer: Customer): Promise<MerchantContext>;
  verifyWebhook(event: PayPalEvent, headers: Headers): Promise<boolean>;
};
export type Decision = {
  id: string;
  eventId: string;
  customerId: string;
  action: ActionId | "draft_reminder" | "human_review";
  status: "draft" | "pending_review";
  reason: string;
  message: string | null;
  valueAtRiskCents: number;
  concessionCents: number;
  trace: string[];
  context: MerchantContext;
  policyVersion: "foundation-v1" | "recovery-v1";
  modelVersion?: string;
  propensity?: number;
  priority?: number;
  candidates?: Candidate[];
  budget?: BudgetSnapshot;
  requiresCustomerConsent?: boolean;
  createdAt: string;
};
export type ProcessReceipt = { duplicate: boolean; decision: Decision };
export type ReviewOutcome = "approved" | "rejected";
export type DecisionReview = {
  decisionId: string;
  eventId: string;
  outcome: ReviewOutcome;
  reviewedAt: string;
  heldConcessionCents: number;
  releasedConcessionCents: number;
  execution: "none";
};
export type ReviewReceipt = { duplicate: boolean; review: DecisionReview };
export type DashboardData = {
  customers: Customer[];
  decisions: Decision[];
  eventCount: number;
  auditCount: number;
  reservedConcessionCents: number;
  pendingReviewCount: number;
  reviews: Record<string, DecisionReview>;
};

export const actionIds = ["pause", "downgrade_offer", "early_pay_discount", "merchant_reminder", "goodwill_refund", "human_save_task"] as const;
export type ActionId = typeof actionIds[number];
export type Signal = "failed_payment" | "past_due" | "cancelled" | "dispute";
export type RecoveryProfile = {
  subscriptionStatus: "ACTIVE" | "SUSPENDED" | "CANCELLED";
  contactAllowed: boolean;
  grossMarginBps: number;
  captureId: string | null;
  refundableCents: number;
  lastRefundAt: string | null;
  lastPauseAt: string | null;
};
export type BudgetSnapshot = {
  monthlyLimitCents: number;
  monthlyUsedCents: number;
  customerLimitCents: number;
  customerUsedCents: number;
};
export type EngineInput = {
  customer: Customer;
  signal: Signal;
  valueAtRiskCents: number;
  profile: RecoveryProfile | null;
  budget: BudgetSnapshot;
  now: Date;
};
export type Candidate = {
  action: ActionId;
  label: string;
  eligible: boolean;
  reasons: string[];
  propensity: number | null;
  leverWeight: number;
  valueAtRiskCents: number;
  concessionCents: number;
  priority: number | null;
  requiresApproval: boolean;
  requiresCustomerConsent: boolean;
};
export type EngineResult = {
  action: ActionId;
  status: "draft" | "pending_review";
  reason: string;
  message: string | null;
  propensity: number;
  priority: number;
  concessionCents: number;
  candidates: Candidate[];
  budget: BudgetSnapshot;
  requiresCustomerConsent: boolean;
  policyVersion: "recovery-v1";
  modelVersion: string;
};
