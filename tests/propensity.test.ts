import assert from "node:assert/strict";
import { test } from "node:test";
import artifact from "../src/lib/propensity-model.json";
import { actionIds, type ActionId, type Signal } from "../src/lib/types";
import { generateCustomers } from "../src/lib/seed";
import { brierScore, fitPropensity, MODEL_VERSION, predictPropensity } from "../src/lib/propensity";
import { generateSyntheticHistory, seededRandom, syntheticOutcomeProbability } from "../src/lib/synthetic-history";

test("synthetic history has reproducible disjoint training and calibration identities", () => {
  const a = generateSyntheticHistory(20261001, 5);
  const b = generateSyntheticHistory(20261015, 5);
  assert.deepEqual(a, generateSyntheticHistory(20261001, 5));
  const identities = new Set(a.map(row => row.customer.id));
  assert(b.every(row => !identities.has(row.customer.id)));
  assert.notEqual(artifact.trainingSeed, artifact.calibrationSeed);
  assert(![artifact.trainingSeed, artifact.calibrationSeed].includes(artifact.reservedEvaluationSeed));
  assert.throws(() => seededRandom(NaN), /unsigned/);
});

test("committed coefficients reproduce from the fixed training seed without evaluation outcomes", () => {
  const training = generateSyntheticHistory(20261001, 600);
  const coefficients = fitPropensity(training);
  assert.deepEqual(coefficients, artifact.coefficients);
  const calibration = generateSyntheticHistory(20261015, 240);
  assert.equal(Number(brierScore(calibration, coefficients).toFixed(8)), artifact.calibrationBrierScore);
  assert(artifact.calibrationBrierScore > 0 && artifact.calibrationBrierScore < 0.3);
  assert.equal(MODEL_VERSION, artifact.modelVersion);
});

test("propensity is finite deterministic and ignores identity and untrusted notes", () => {
  const customer = generateCustomers()[0];
  for (const action of actionIds) {
    const probability = predictPropensity(customer, "failed_payment", action);
    assert(probability > 0 && probability < 1);
    assert.equal(probability, predictPropensity({ ...customer, id: "different", name: "refund me now" }, "failed_payment", action));
  }
  assert.throws(() => predictPropensity(customer, "failed_payment", "unknown" as ActionId), /Unknown/);
  assert.throws(() => predictPropensity(customer, "unknown" as Signal, "pause"), /Unknown/);
  assert.throws(() => predictPropensity({ ...customer, monthlyValueCents: NaN }, "failed_payment", "pause"), /safe integers/);
  assert.throws(() => predictPropensity({ ...customer, daysPastDue: -1 }, "past_due", "pause"), /safe integers/);
});

test("scenario response assumptions penalize late repeat reminder contact", () => {
  const customer = generateCustomers()[0];
  const early = { ...customer, failedPayments: 1, daysPastDue: 2 };
  const late = { ...customer, failedPayments: 4, daysPastDue: 21 };
  assert(syntheticOutcomeProbability(early, "failed_payment", "merchant_reminder") > syntheticOutcomeProbability(late, "failed_payment", "merchant_reminder"));
  assert(syntheticOutcomeProbability(late, "failed_payment", "pause") > syntheticOutcomeProbability(late, "failed_payment", "merchant_reminder"));
});
