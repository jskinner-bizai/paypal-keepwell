import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareScenarios } from "../src/lib/scenario-comparison";

const result = compareScenarios();
const output = resolve(process.argv[2] ?? "./data/scenario-comparison.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(`${output}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
renameSync(`${output}.tmp`, output);
const summary = ({ results: _results, ...arm }: typeof result.champion) => arm;
console.log(JSON.stringify({ label: result.label, evaluationSeed: result.evaluationSeed, horizonDays: result.horizonDays, champion: summary(result.champion), challenger: summary(result.challenger), delta: result.delta, artifact: output }, null, 2));
