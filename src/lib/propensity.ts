import artifact from "./propensity-model.json";
import { actionIds, type ActionId, type Customer, type Signal } from "./types";
import type { SyntheticObservation } from "./synthetic-history";

export const MODEL_VERSION = "synthetic-logistic-v1";
export const featureNames = ["intercept", "tenure_36", "failures_4", "overdue_30", "monthly_10000", "invoice_signal", "sensitive_signal"] as const;
export function features(customer: Customer, signal: Signal): number[] {
  if (!["failed_payment", "past_due", "cancelled", "dispute"].includes(signal)) throw new Error("Unknown propensity signal");
  for (const value of [customer.tenureMonths, customer.failedPayments, customer.daysPastDue, customer.monthlyValueCents]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Propensity inputs must be nonnegative safe integers");
  }
  return [1, Math.min(customer.tenureMonths, 36) / 36, Math.min(customer.failedPayments, 4) / 4,
    Math.min(customer.daysPastDue, 30) / 30, Math.min(customer.monthlyValueCents, 10000) / 10000,
    Number(signal === "past_due"), Number(signal === "cancelled" || signal === "dispute")];
}
const sigmoid = (score: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score))));
const score = (weights: number[], values: number[]) => sigmoid(weights.reduce((sum, weight, i) => sum + weight * values[i], 0));

export function predictPropensity(customer: Customer, signal: Signal, action: ActionId): number {
  if (!actionIds.includes(action)) throw new Error("Unknown propensity action");
  if (artifact.modelVersion !== MODEL_VERSION || artifact.featureNames.join("|") !== featureNames.join("|")) throw new Error("Propensity artifact contract differs");
  const weights = artifact.coefficients[action];
  if (weights.length !== featureNames.length || weights.some(value => !Number.isFinite(value))) throw new Error("Invalid propensity coefficients");
  return score(weights, features(customer, signal));
}

export function fitPropensity(rows: SyntheticObservation[], epochs = 500): Record<ActionId, number[]> {
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs > 5000) throw new Error("Invalid training epochs");
  const result = {} as Record<ActionId, number[]>;
  for (const action of actionIds) {
    const samples = rows.filter(row => row.action === action).map(row => ({ x: features(row.customer, row.signal), y: Number(row.recovered) }));
    if (!samples.length) throw new Error(`No training samples for ${action}`);
    const weights = Array(featureNames.length).fill(0) as number[];
    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradient = Array(featureNames.length).fill(0) as number[];
      for (const sample of samples) {
        const error = score(weights, sample.x) - sample.y;
        for (let j = 0; j < weights.length; j++) gradient[j] += error * sample.x[j];
      }
      for (let j = 0; j < weights.length; j++) weights[j] -= 0.6 * (gradient[j] / samples.length + (j === 0 ? 0 : 0.002 * weights[j]));
    }
    result[action] = weights.map(value => Number(value.toFixed(10)));
  }
  return result;
}

export function brierScore(rows: SyntheticObservation[], coefficients: Record<ActionId, number[]>): number {
  if (!rows.length) throw new Error("Calibration samples are required");
  return rows.reduce((sum, row) => sum + (score(coefficients[row.action], features(row.customer, row.signal)) - Number(row.recovered)) ** 2, 0) / rows.length;
}
