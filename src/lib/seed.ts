import type { Customer, PlanId, RecoveryProfile } from "./types";

export const plans: { id: PlanId; monthlyValueCents: number }[] = [
  { id: "starter", monthlyValueCents: 1900 },
  { id: "growth", monthlyValueCents: 4900 },
  { id: "scale", monthlyValueCents: 9900 },
];

// shortcut: synthetic cohorts only, replace with authorized merchant imports before live use.
export function generateCustomers(seed = 20261101): Customer[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Array.from({ length: 54 }, (_, i) => {
    const id = String(i + 1).padStart(3, "0");
    const plan = plans[i % plans.length];
    return {
      id: `customer-${id}`, name: `Demo merchant customer ${id}`, planId: plan.id,
      subscriptionId: `I-DEMO-${id}`, invoiceId: i % 3 === 1 ? `INV2-DEMO-${id}` : null,
      monthlyValueCents: plan.monthlyValueCents, tenureMonths: 1 + Math.floor(random() * 36),
      failedPayments: 1 + Math.floor(random() * 4), daysPastDue: 1 + Math.floor(random() * 21),
    };
  });
}

export function generateRecoveryProfile(customer: Customer): RecoveryProfile {
  const index = Number(customer.id.match(/(\d+)$/)?.[1] ?? 0);
  return {
    subscriptionStatus: index % 17 === 0 ? "SUSPENDED" : "ACTIVE",
    contactAllowed: index % 19 !== 0,
    grossMarginBps: 4500 + (index % 4) * 1000,
    captureId: index % 4 === 0 ? null : `DEMO-CAPTURE-${customer.id}`,
    refundableCents: index % 4 === 0 ? 0 : customer.monthlyValueCents,
    lastRefundAt: index % 13 === 0 ? "2026-10-12T12:00:00.000Z" : null,
    lastPauseAt: index % 11 === 0 ? "2026-10-20T12:00:00.000Z" : null,
  };
}
