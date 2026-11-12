import { qualifySandboxReads } from "../src/lib/paypal";

const result = await qualifySandboxReads();
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.result === "passed" ? 0 : 1;
