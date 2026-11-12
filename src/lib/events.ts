import { randomUUID } from "node:crypto";
import type { PayPalAdapter, PayPalEvent, ProcessReceipt, Decision } from "./types";
import type { Store } from "./store";
import { decide } from "./engine";
import type { Signal } from "./types";

export class InputError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}
const supported = new Set(["BILLING.SUBSCRIPTION.PAYMENT.FAILED", "BILLING.SUBSCRIPTION.CANCELLED", "INVOICING.INVOICE.UPDATED", "CUSTOMER.DISPUTE.CREATED"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseEvent(input: unknown): PayPalEvent {
  if (!object(input) || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)
    || typeof input.event_type !== "string" || !supported.has(input.event_type)
    || typeof input.create_time !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.create_time)
    || !Number.isFinite(Date.parse(input.create_time)) || !object(input.resource)) {
    throw new InputError("Unsupported or malformed event");
  }
  return { id: input.id, event_type: input.event_type, create_time: input.create_time, resource: input.resource };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function processEvent(store: Store, adapter: PayPalAdapter, event: PayPalEvent, source: "simulation" | "paypal", now = new Date(), simulationCustomerId?: string): Promise<ProcessReceipt> {
  if ((source === "simulation") !== (adapter.mode === "mock")) throw new InputError("Event source and adapter mode differ");
  if (source === "paypal" && simulationCustomerId) throw new InputError("Simulation identity is not allowed for PayPal events");
  const payload = canonical(event);
  const duplicate = () => {
    const existing = store.existing(event.id);
    if (!existing) return;
    if (existing.source !== source || existing.payload !== payload) throw new InputError("Event ID already exists with different content", 409);
    return { duplicate: true, decision: existing.decision };
  };
  const prior = duplicate();
  // Validate synthetic identity before the duplicate fast path as old mixed records may exist.
  if (source === "simulation") {
    const candidate = simulationCustomerId ? store.demoCustomer(simulationCustomerId)
      : typeof event.resource.id === "string" ? store.customerByResource(event.resource.id, event.event_type === "INVOICING.INVOICE.UPDATED" ? "invoice" : "subscription", "simulation") : undefined;
    if (!candidate || !store.demoCustomer(candidate.id)) throw new InputError("Simulation requires a seeded demo customer", 403);
    const existing = store.existing(event.id);
    if (existing && (existing.decision.customerId !== candidate.id || existing.decision.context?.source !== "synthetic")) throw new InputError("Event ID already exists with a different customer or context", 409);
  }
  if (prior) return prior;
  if (source === "paypal" && event.event_type === "CUSTOMER.DISPUTE.CREATED") throw new InputError("Dispute transaction-to-customer correlation is not configured");
  // PayPal's Invoicing v2 webhook wraps the invoice in resource.invoice.
  // Keep the original signed envelope for verification, receipts and idempotency.
  const invoice = event.event_type === "INVOICING.INVOICE.UPDATED";
  let resource = event.resource;
  if (invoice && Object.hasOwn(resource, "invoice")) {
    if (!object(resource.invoice) || ["id", "detail", "status", "due_amount"].some(key => Object.hasOwn(resource, key))) {
      throw new InputError("Malformed or ambiguous invoice resource");
    }
    resource = resource.invoice;
  }
  const customer = source === "simulation" && simulationCustomerId ? store.demoCustomer(simulationCustomerId)
    : typeof resource.id === "string" ? store.customerByResource(resource.id, invoice ? "invoice" : "subscription", source) : undefined;
  if (!customer) throw new InputError("No registered customer matches this resource");
  let valueAtRiskCents = customer.monthlyValueCents;
  if (invoice) {
    const detail = object(resource.detail) ? resource.detail : {};
    const due = typeof detail.payment_term === "object" && object(detail.payment_term) ? detail.payment_term.due_date : undefined;
    if (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(`${due}T00:00:00Z`)) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due
      || due >= now.toISOString().slice(0, 10) || !["SENT", "UNPAID", "PARTIALLY_PAID"].includes(String(resource.status))) {
      throw new InputError("Invoice is not unpaid and past due");
    }
    if (resource.id !== customer.invoiceId) throw new InputError("Invoice does not match the registered customer");
    const amount = resource.due_amount;
    if (!object(amount) || amount.currency_code !== "USD" || typeof amount.value !== "string" || !/^(0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amount.value)) throw new InputError("Invoice needs a valid USD outstanding amount");
    const [dollars, cents = ""] = amount.value.split(".");
    valueAtRiskCents = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
    if (valueAtRiskCents === 0) throw new InputError("Invoice has no outstanding balance");
  }
  const context = await adapter.getContext(customer);
  const signal: Signal = event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED" ? "failed_payment"
    : invoice ? "past_due" : event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" ? "cancelled" : "dispute";
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const raced = duplicate();
    if (raced) { store.db.exec("COMMIT"); return raced; }
    const result = decide({ customer, signal, valueAtRiskCents, profile: store.profile(customer.id, source, now), budget: store.budget(customer.id, source, now), now });
    const decision: Decision = {
      ...result, id: randomUUID(), eventId: event.id, customerId: customer.id, valueAtRiskCents,
      trace: [
        `Source: ${source}; context: ${context.source}.`, `Matched registered customer ${customer.id}.`,
        `Event: ${event.event_type}.`, result.reason,
        `Priority = propensity ${result.propensity.toFixed(6)} x value ${valueAtRiskCents} cents x selected lever weight.`,
        `Reserved concession: ${result.concessionCents} cents. Monthly prior reservations ${result.budget.monthlyUsedCents}/${result.budget.monthlyLimitCents}; customer prior rolling 90-day reservations ${result.budget.customerUsedCents}/${result.budget.customerLimitCents}.`,
        "No external action executed. Customer message is a fixed template; buyer consent and execution approval are separate future steps.",
      ], context, createdAt: now.toISOString(),
    };
    store.record(event, source, payload, decision);
    store.db.exec("COMMIT");
    return { duplicate: false, decision };
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

export const scenarios = ["failed_payment", "past_due", "cancelled", "dispute"] as const;
export type Scenario = typeof scenarios[number];
export function simulatedEvent(customer: import("./types").Customer, scenario: Scenario, now = new Date()): PayPalEvent {
  if (scenario === "past_due" && !customer.invoiceId) throw new InputError("Select a customer with an invoice for this scenario");
  const due = new Date(now.getTime() - customer.daysPastDue * 86400000).toISOString().slice(0, 10);
  return {
    id: `SIM-${randomUUID()}`, create_time: now.toISOString(),
    event_type: { failed_payment: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", past_due: "INVOICING.INVOICE.UPDATED", cancelled: "BILLING.SUBSCRIPTION.CANCELLED", dispute: "CUSTOMER.DISPUTE.CREATED" }[scenario],
    resource: scenario === "past_due" ? { id: customer.invoiceId, status: "SENT", detail: { payment_term: { due_date: due } }, due_amount: { currency_code: "USD", value: (customer.monthlyValueCents / 100).toFixed(2) } }
      : scenario === "dispute" ? { dispute_id: `PP-D-DEMO-${customer.id}`, disputed_transactions: [{ seller_transaction_id: `DEMO-TXN-${customer.id}` }] }
      : { id: customer.subscriptionId },
  };
}

