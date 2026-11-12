import { writeFileSync } from "node:fs";
import { brierScore, featureNames, fitPropensity, MODEL_VERSION } from "../src/lib/propensity";
import { generateSyntheticHistory } from "../src/lib/synthetic-history";
const trainingSeed = 20261001;
const calibrationSeed = 20261015;
const training = generateSyntheticHistory(trainingSeed, 600);
const calibration = generateSyntheticHistory(calibrationSeed, 240);
const coefficients = fitPropensity(training);
const artifact = {
  modelVersion: MODEL_VERSION, source: "synthetic", featureNames,
  trainingSeed, calibrationSeed, reservedEvaluationSeed: 20261103,
  trainingCustomers: 600, calibrationCustomers: 240,
  trainingObservations: training.length, calibrationObservations: calibration.length,
  epochs: 500, calibrationBrierScore: Number(brierScore(calibration, coefficients).toFixed(8)), coefficients,
};
writeFileSync("src/lib/propensity-model.json", `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ modelVersion: MODEL_VERSION, source: "synthetic", observations: training.length, calibrationBrierScore: artifact.calibrationBrierScore }));
