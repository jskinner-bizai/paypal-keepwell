import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { Store } from "../../src/lib/store";
import { processEvent, simulatedEvent } from "../../src/lib/events";

test("production HTTP simulation reaches durable event, decision and audit rows", { timeout: 60000 }, async () => {
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((done) => portServer.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "keepwell-e2e-"));
  const dbPath = join(dir, "evidence.sqlite");
  const setup = new Store(dbPath);
  let providerDecisionId: string;
  try {
    const customer = { ...setup.customer("customer-001")!, id: "SANDBOX-E2E", name: "Provider-only E2E fixture", subscriptionId: "I-PROVIDER-E2E", invoiceId: null };
    setup.db.prepare("INSERT INTO customers (id, subscription_id, invoice_id, payload) VALUES (?, ?, ?, ?)").run(customer.id, customer.subscriptionId, null, JSON.stringify(customer));
    setup.registerSandboxResource(customer.id, "subscription", customer.subscriptionId);
    const receipt = await processEvent(setup, { mode: "sandbox", verifyWebhook: async () => true, getContext: async () => ({ source: "paypal_sandbox", transactionCount: 0, successfulPayments: 0, note: "Injected E2E context, no provider request" }) }, simulatedEvent(customer, "failed_payment"), "paypal");
    providerDecisionId = receipt.decision.id;
  } finally { setup.close(); }
  const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "production", KEEPWELL_DEMO_ENABLED: "true", KEEPWELL_DB_PATH: dbPath,
      PAYPAL_CLIENT_ID: "fake-test-id", PAYPAL_CLIENT_SECRET: "fake-test-secret", PAYPAL_WEBHOOK_ID: "WH-TEST" },
    stdio: "pipe",
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { ready = (await fetch(`${origin}/api/health`)).ok; } catch { /* Wait for the local listener. */ }
      if (ready) break;
      await new Promise(done => setTimeout(done, 200));
    }
    assert(ready, logs);
    const initialPage = await fetch(origin);
    assert.equal(initialPage.status, 200);
    const html = await initialPage.text();
    assert(html.includes("Synthetic demo"));
    assert(!html.includes("Provider-only E2E fixture"));
    assert(!html.includes("SANDBOX-E2E"));
    assert(!html.includes(providerDecisionId));
    assert(html.includes("SCENARIO SIMULATION ON SYNTHETIC DATA"));
    assert(html.includes("$1,300.15"));
    const post = (body: unknown, site = origin) => fetch(`${origin}/api/demo/simulate`, { method: "POST", headers: { origin: site, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ customerId: "SANDBOX-E2E", scenario: "failed_payment" })).status, 404);
    const response = await post({ customerId: "customer-001", scenario: "failed_payment" });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.decision.action, "goodwill_refund");
    assert.equal(receipt.decision.status, "pending_review");
    assert.equal(receipt.decision.candidates.length, 6);
    const readback = new Store(dbPath);
    try {
      assert.equal(readback.dashboard().customers.length, 54);
      assert.equal(readback.dashboard().eventCount, 1);
      assert.equal(readback.dashboard().auditCount, 1);
      assert.equal(readback.dashboard().reservedConcessionCents, receipt.decision.concessionCents);
      const audit = JSON.parse(String(readback.db.prepare("SELECT payload FROM audit_log WHERE decision_id = ?").get(receipt.decision.id)!.payload));
      assert.equal(audit.execution, "none");
      assert.equal(audit.candidates.length, 6);
      assert.equal(audit.reservedConcessionCents, receipt.decision.concessionCents);
      assert.equal(readback.dashboard().decisions[0].id, receipt.decision.id);
    } finally { readback.close(); }
    assert((await (await fetch(origin)).text()).includes(receipt.decision.eventId));
    const review = (body: unknown, site = origin) => fetch(`${origin}/api/demo/review`, { method: "POST", headers: { origin: site, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await review({ decisionId: providerDecisionId, outcome: "approved" })).status, 403);
    assert.equal((await review({ decisionId: receipt.decision.id, outcome: "rejected" }, "https://foreign.example")).status, 403);
    assert.equal((await review({ decisionId: receipt.decision.id, outcome: "execute" })).status, 400);
    assert.equal((await review({ decisionId: "unknown", outcome: "rejected" })).status, 404);
    const rejectedResponse = await review({ decisionId: receipt.decision.id, outcome: "rejected" });
    assert.equal(rejectedResponse.status, 201);
    const rejected = await rejectedResponse.json();
    assert.equal(rejected.review.execution, "none");
    assert.equal(rejected.review.releasedConcessionCents, receipt.decision.concessionCents);
    assert.equal((await review({ decisionId: receipt.decision.id, outcome: "rejected" })).status, 200);
    assert.equal((await review({ decisionId: receipt.decision.id, outcome: "approved" })).status, 409);
    const reviewReadback = new Store(dbPath);
    try {
      assert.equal(reviewReadback.dashboard().reservedConcessionCents, 0);
      assert.equal(reviewReadback.dashboard().pendingReviewCount, 0);
      assert.equal(reviewReadback.dashboard().auditCount, 2);
      assert.equal(reviewReadback.dashboard().reviews[receipt.decision.id].outcome, "rejected");
      assert.equal(reviewReadback.db.prepare("SELECT COUNT(*) AS n FROM concession_reservations").get()!.n, 1);
    } finally { reviewReadback.close(); }
    const rejectedPage = await (await fetch(origin)).text();
    assert(rejectedPage.includes("Demo recommendation rejected"));
    assert(rejectedPage.includes("released from the active demo budget"));
    const second = await (await post({ customerId: "customer-001", scenario: "failed_payment" })).json();
    assert.equal(second.decision.action, "goodwill_refund");
    const approvedResponse = await review({ decisionId: second.decision.id, outcome: "approved" });
    assert.equal(approvedResponse.status, 201);
    const approved = await approvedResponse.json();
    assert.equal(approved.review.execution, "none");
    assert.equal(approved.review.heldConcessionCents, second.decision.concessionCents);
    assert.equal((await review({ decisionId: second.decision.id, outcome: "approved" })).status, 200);
    assert.equal((await review({ decisionId: second.decision.id, outcome: "rejected" })).status, 409);
    const approvedPage = await (await fetch(origin)).text();
    assert(approvedPage.includes("Demo recommendation approved"));
    assert(approvedPage.includes("remains reserved"));
    assert.equal((await post({ customerId: "customer-001", scenario: "failed_payment" }, "https://foreign.example")).status, 403);
    assert.equal((await post({ customerId: "customer-001", scenario: "past_due" })).status, 422);
    const unsigned = await fetch(`${origin}/api/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "WH-UNSIGNED" }) });
    assert.equal(unsigned.status, 401);
  } finally {
    const stopped = once(child, "exit");
    child.kill();
    if (child.exitCode === null) await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});
