import { actionIds, type ActionId, type Customer, type Signal } from "./types";

export function seededRandom(seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Seed must be an unsigned 32-bit integer");
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
}

// shortcut: hand-authored synthetic response assumptions, replace only after authorized outcome data exists.
export function syntheticOutcomeProbability(customer: Customer, signal: Signal, action: ActionId): number {
  const repeat = customer.failedPayments >= 3;
  const late = customer.daysPastDue >= 14;
  const loyal = customer.tenureMonths >= 12;
  const sensitive = signal === "cancelled" || signal === "dispute";
  const base: Record<ActionId, number> = {
    pause: 0.48 + (repeat ? 0.16 : -0.06) + (late ? -0.1 : 0.08),
    downgrade_offer: 0.4 + (customer.planId === "scale" ? 0.2 : 0.05) + (repeat ? 0.12 : -0.05),
    early_pay_discount: 0.45 + (signal === "past_due" ? 0.14 : -0.12) + (late ? -0.1 : 0.08),
    merchant_reminder: 0.49 - (repeat ? 0.25 : 0) - (late ? 0.18 : 0) + (loyal ? 0.05 : 0),
    goodwill_refund: 0.48 + (loyal ? 0.18 : -0.1) + (repeat ? 0.12 : 0),
    human_save_task: 0.34 + (loyal ? 0.09 : 0) + (sensitive ? 0.12 : 0),
  };
  if (!Object.hasOwn(base, action)) throw new Error("Unknown synthetic action");
  return Math.max(0.05, Math.min(0.9, base[action] - (sensitive && action !== "human_save_task" ? 0.3 : 0)));
}

export type SyntheticObservation = { id: string; customer: Customer; signal: Signal; action: ActionId; recovered: boolean };

export function generateSyntheticHistory(seed: number, customerCount = 600): SyntheticObservation[] {
  if (!Number.isSafeInteger(customerCount) || customerCount < 1 || customerCount > 10000) throw new Error("Invalid synthetic customer count");
  const random = seededRandom(seed);
  const plans = ["starter", "growth", "scale"] as const;
  const prices = [1900, 4900, 9900];
  const rows: SyntheticObservation[] = [];
  for (let i = 0; i < customerCount; i++) {
    const plan = Math.floor(random() * plans.length);
    const id = `history-${seed}-${i}`;
    const value = random();
    const signal: Signal = value < 0.64 ? "failed_payment" : value < 0.9 ? "past_due" : value < 0.95 ? "cancelled" : "dispute";
    const customer: Customer = {
      id, name: "Synthetic historical customer", planId: plans[plan], subscriptionId: `I-${id}`,
      invoiceId: signal === "past_due" ? `INV-${id}` : null, monthlyValueCents: prices[plan],
      tenureMonths: 1 + Math.floor(random() * 36), failedPayments: 1 + Math.floor(random() * 4),
      daysPastDue: 1 + Math.floor(random() * 30),
    };
    for (const action of actionIds) rows.push({ id: `${id}-${action}`, customer, signal, action, recovered: random() < syntheticOutcomeProbability(customer, signal, action) });
  }
  return rows;
}
