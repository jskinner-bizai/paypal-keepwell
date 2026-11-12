import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson, requireDemoRequest } from "../src/lib/http";
test("simulation requires an enabled same-origin JSON request", async () => {
  const previous = process.env.KEEPWELL_DEMO_ENABLED;
  process.env.KEEPWELL_DEMO_ENABLED = "true";
  try {
    const request = (origin: string, body = "{}") => new Request("http://localhost:3000/api/demo/simulate", { method: "POST", headers: { host: "localhost:3000", origin, "content-type": "application/json" }, body });
    requireDemoRequest(request("http://localhost:3000"));
    assert.throws(() => requireDemoRequest(request("http://other.example")), /Same-origin/);
    assert.throws(() => requireDemoRequest(request("null")), /Same-origin/);
    assert.deepEqual(await readJson(request("http://localhost:3000")), {});
    await assert.rejects(readJson(request("http://localhost:3000", "{")), /Invalid JSON/);
    await assert.rejects(readJson(request("http://localhost:3000", JSON.stringify({ data: "x".repeat(66000) }))), /64 KB/);
    process.env.KEEPWELL_DEMO_ENABLED = "false";
    assert.throws(() => requireDemoRequest(request("http://localhost:3000")), /disabled/);
  } finally {
    if (previous === undefined) delete process.env.KEEPWELL_DEMO_ENABLED;
    else process.env.KEEPWELL_DEMO_ENABLED = previous;
  }
});
