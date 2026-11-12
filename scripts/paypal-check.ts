import { checkSandboxOAuth } from "../src/lib/paypal";

try {
  console.log(JSON.stringify(await checkSandboxOAuth()));
} catch (error) {
  console.error(error instanceof Error ? error.message : "PayPal sandbox OAuth check failed.");
  process.exitCode = 1;
}
