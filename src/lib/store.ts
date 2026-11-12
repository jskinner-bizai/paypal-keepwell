import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateCustomers, generateRecoveryProfile } from "./seed";
import { DEFAULT_BUDGET } from "./engine";
import { InputError } from "./events";
import type { BudgetSnapshot, Customer, DashboardData, Decision, DecisionReview, PayPalEvent, RecoveryProfile, ReviewOutcome, ReviewReceipt } from "./types";

export class Store {
  readonly db: DatabaseSync;
  constructor(path = process.env.KEEPWELL_DB_PATH || "./data/keepwell.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 4) throw new Error("Database schema is newer than this application");
    if (version.user_version < 4) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (current === 0) this.db.exec(readFileSync(resolve("migrations/001_foundation.sql"), "utf8"));
        if (current < 2) this.db.exec(readFileSync(resolve("migrations/002_recovery.sql"), "utf8"));
        if (current < 3) this.db.exec(readFileSync(resolve("migrations/003_demo_reviews.sql"), "utf8"));
        if (current < 4) this.db.exec(readFileSync(resolve("migrations/004_sandbox_mapping.sql"), "utf8"));
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    this.seed();
  }
  seed() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare("INSERT OR IGNORE INTO customers (id, subscription_id, invoice_id, payload) VALUES (?, ?, ?, ?)");
      for (const customer of generateCustomers()) {
        insert.run(customer.id, customer.subscriptionId, customer.invoiceId, JSON.stringify(customer));
        this.db.prepare("INSERT OR IGNORE INTO recovery_profiles (customer_id, payload) VALUES (?, ?)").run(customer.id, JSON.stringify(generateRecoveryProfile(customer)));
      }
      this.db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('dataset', 'synthetic-20261101-v1')").run();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  customer(id: string): Customer | undefined {
    const row = this.db.prepare("SELECT payload FROM customers WHERE id = ?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  // Only the original seeded identities belong to the synthetic workspace.
  demoCustomer(id: string): Customer | undefined {
    const seed = generateCustomers().find(customer => customer.id === id);
    const customer = seed ? this.customer(id) : undefined;
    return customer && customer.subscriptionId === seed!.subscriptionId && customer.invoiceId === seed!.invoiceId ? customer : undefined;
  }
  private demoCustomerIds(): string[] {
    return generateCustomers().filter(customer => this.demoCustomer(customer.id)).map(customer => customer.id);
  }
  customerByResource(id: string, kind: "subscription" | "invoice" = "subscription", source: "simulation" | "paypal" = "simulation"): Customer | undefined {
    const column = kind === "invoice" ? "invoice_id" : "subscription_id";
    const row = (source === "paypal"
      ? this.db.prepare(`SELECT c.payload FROM sandbox_resource_mappings m JOIN customers c ON c.id = m.customer_id WHERE m.resource_kind = ? AND m.resource_id = ? AND c.${column} = m.resource_id`).get(kind, id)
      : this.db.prepare(`SELECT payload FROM customers WHERE ${column} = ?`).get(id)) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  // Local operator-only configuration, never called from webhook content.
  // Does not establish provider ownership or provision a recovery profile.
  registerSandboxResource(customerId: string, kind: "subscription" | "invoice", resourceId: string) {
    if (!["subscription", "invoice"].includes(kind) || !/^[A-Za-z0-9_-]{1,128}$/.test(resourceId)) throw new InputError("Invalid sandbox resource mapping");
    const customer = this.customer(customerId);
    if (!customer || generateCustomers().some(c => c.id === customerId) || resourceId !== (kind === "invoice" ? customer.invoiceId : customer.subscriptionId)) throw new InputError("Mapping needs a separately registered sandbox customer and matching resource");
    this.db.prepare("INSERT INTO sandbox_resource_mappings (resource_kind, resource_id, customer_id) VALUES (?, ?, ?) ON CONFLICT(resource_kind, resource_id) DO NOTHING").run(kind, resourceId, customerId);
    const mapped = this.customerByResource(resourceId, kind, "paypal");
    if (mapped?.id !== customerId) throw new InputError("Sandbox resource already belongs to another customer", 409);
  }
  profile(customerId: string, source: "simulation" | "paypal" = "simulation", now = new Date()): RecoveryProfile | null {
    if (source === "paypal") return null;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InputError("A valid profile clock is required", 400);
    const row = this.db.prepare("SELECT payload FROM recovery_profiles WHERE customer_id = ?").get(customerId) as { payload: string } | undefined;
    if (!row) return null;
    const profile: RecoveryProfile = JSON.parse(row.payload);
    // A rejection releases the pending promise only at its own timestamp, matching budget snapshots.
    // Future promise dates remain visible so the engine's invalid/future-history guard fails closed.
    const promises = this.db.prepare("SELECT d.payload, r.created_at FROM concession_reservations r JOIN decisions d ON d.id = r.decision_id LEFT JOIN decision_reviews v ON v.decision_id = r.decision_id WHERE r.customer_id = ? AND r.source = ? AND (v.outcome IS NULL OR v.outcome != 'rejected' OR v.created_at > ?) ORDER BY r.created_at DESC").all(customerId, source, now.toISOString()) as { payload: string; created_at: string }[];
    for (const action of ["goodwill_refund", "pause"] as const) {
      const promise = promises.find(p => JSON.parse(p.payload).action === action);
      const field = action === "goodwill_refund" ? "lastRefundAt" : "lastPauseAt";
      if (promise && (!profile[field] || promise.created_at > profile[field]!)) profile[field] = promise.created_at;
    }
    return profile;
  }
  budget(customerId: string, source: "simulation" | "paypal", now: Date): BudgetSnapshot {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
    const active = "FROM concession_reservations r LEFT JOIN decision_reviews v ON v.decision_id = r.decision_id WHERE (v.outcome IS NULL OR v.outcome != 'rejected' OR v.created_at > ?) AND (r.source != 'simulation' OR r.customer_id IN (SELECT value FROM json_each(?)))";
    const month = this.db.prepare(`SELECT COALESCE(SUM(r.amount_cents), 0) AS used ${active} AND r.source = ? AND r.created_at >= ? AND r.created_at < ?`).get(now.toISOString(), JSON.stringify(this.demoCustomerIds()), source, monthStart, monthEnd)!;
    const customer = this.db.prepare(`SELECT COALESCE(SUM(r.amount_cents), 0) AS used ${active} AND r.source = ? AND r.customer_id = ? AND r.created_at >= ? AND r.created_at <= ?`).get(now.toISOString(), JSON.stringify(this.demoCustomerIds()), source, customerId, cutoff, now.toISOString())!;
    return { ...DEFAULT_BUDGET, monthlyUsedCents: Number(month.used), customerUsedCents: Number(customer.used) };
  }
  existing(eventId: string): { payload: string; source: string; decision: Decision } | undefined {
    const row = this.db.prepare("SELECT e.payload, e.source, d.payload AS decision FROM webhook_events e JOIN decisions d ON d.event_id = e.id WHERE e.id = ?").get(eventId) as { payload: string; source: string; decision: string } | undefined;
    return row ? { ...row, decision: JSON.parse(row.decision) } : undefined;
  }
  record(event: PayPalEvent, source: "simulation" | "paypal", canonicalPayload: string, decision: Decision) {
    this.db.prepare("INSERT INTO webhook_events (id, source, payload, received_at) VALUES (?, ?, ?, ?)").run(event.id, source, canonicalPayload, decision.createdAt);
    this.db.prepare("INSERT INTO decisions (id, event_id, customer_id, payload) VALUES (?, ?, ?, ?)").run(decision.id, event.id, decision.customerId, JSON.stringify(decision));
    if (decision.concessionCents > 0) this.db.prepare("INSERT INTO concession_reservations (decision_id, customer_id, source, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)").run(decision.id, decision.customerId, source, decision.concessionCents, decision.createdAt);
    this.db.prepare("INSERT INTO audit_log (event_id, decision_id, kind, payload, created_at) VALUES (?, ?, 'decision_recorded', ?, ?)").run(event.id, decision.id, JSON.stringify({ policyVersion: decision.policyVersion, modelVersion: decision.modelVersion, status: decision.status, trace: decision.trace, candidates: decision.candidates, budget: decision.budget, reservedConcessionCents: decision.concessionCents, execution: "none", paypalRequestId: null }), decision.createdAt);
  }
  reviewDemoDecision(decisionId: string, outcome: ReviewOutcome, now = new Date()): ReviewReceipt {
    if (typeof decisionId !== "string" || !decisionId || decisionId.length > 128 || !["approved", "rejected"].includes(outcome)
      || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new InputError("A valid decision, review outcome and clock are required", 400);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT d.payload, e.source FROM decisions d JOIN webhook_events e ON e.id = d.event_id WHERE d.id = ?").get(decisionId) as { payload: string; source: string } | undefined;
      if (!row) throw new InputError("Decision was not found", 404);
      if (row.source !== "simulation") throw new InputError("Demo reviews cannot change PayPal decisions", 403);
      const decision: Decision = JSON.parse(row.payload);
      if (!this.demoCustomer(decision.customerId) || decision.context?.source !== "synthetic") throw new InputError("Demo reviews require a seeded synthetic decision", 403);
      if (decision.policyVersion !== "recovery-v1") throw new InputError("Historical foundation decisions cannot be reviewed", 409);
      const previous = this.db.prepare("SELECT payload FROM decision_reviews WHERE decision_id = ?").get(decisionId) as { payload: string } | undefined;
      if (previous) {
        const review: DecisionReview = JSON.parse(previous.payload);
        if (review.outcome !== outcome) throw new InputError("This decision already has a final review outcome", 409);
        this.db.exec("COMMIT");
        return { duplicate: true, review };
      }
      if (!Number.isFinite(Date.parse(decision.createdAt)) || now.getTime() < Date.parse(decision.createdAt)) throw new InputError("Review cannot precede the decision", 400);
      const reservation = this.db.prepare("SELECT amount_cents FROM concession_reservations WHERE decision_id = ?").get(decisionId);
      const cents = Number(reservation?.amount_cents ?? 0);
      const review: DecisionReview = { decisionId, eventId: decision.eventId, outcome, reviewedAt: now.toISOString(), heldConcessionCents: outcome === "approved" ? cents : 0, releasedConcessionCents: outcome === "rejected" ? cents : 0, execution: "none" };
      // The original decision and reservation remain immutable. The review is its own audit receipt.
      this.db.prepare("INSERT INTO decision_reviews (decision_id, outcome, payload, created_at) VALUES (?, ?, ?, ?)").run(decisionId, outcome, JSON.stringify(review), review.reviewedAt);
      this.db.exec("COMMIT");
      return { duplicate: false, review };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  dashboard(): DashboardData {
    const ids = JSON.stringify(this.demoCustomerIds());
    const scope = "WITH demo_decisions AS (SELECT d.* FROM decisions d JOIN webhook_events e ON e.id = d.event_id WHERE e.source = 'simulation' AND d.customer_id IN (SELECT value FROM json_each(?)) AND json_extract(d.payload, '$.context.source') = 'synthetic') ";
    const count = (query: string) => Number(this.db.prepare(scope + query).get(ids)!.n);
    return {
      customers: this.demoCustomerIds().map(id => this.demoCustomer(id)!),
      decisions: (this.db.prepare(scope + "SELECT payload FROM demo_decisions ORDER BY (SELECT rowid FROM decisions WHERE id = demo_decisions.id) DESC LIMIT 100").all(ids) as { payload: string }[]).map(row => JSON.parse(row.payload)),
      eventCount: count("SELECT COUNT(*) AS n FROM demo_decisions"),
      auditCount: count("SELECT (SELECT COUNT(*) FROM audit_log WHERE decision_id IN (SELECT id FROM demo_decisions)) + (SELECT COUNT(*) FROM decision_reviews WHERE decision_id IN (SELECT id FROM demo_decisions)) AS n"),
      reservedConcessionCents: count("SELECT COALESCE(SUM(r.amount_cents), 0) AS n FROM concession_reservations r LEFT JOIN decision_reviews v ON v.decision_id = r.decision_id WHERE r.source = 'simulation' AND r.decision_id IN (SELECT id FROM demo_decisions) AND (v.outcome IS NULL OR v.outcome != 'rejected')"),
      pendingReviewCount: count("SELECT COUNT(*) AS n FROM demo_decisions d LEFT JOIN decision_reviews v ON v.decision_id = d.id WHERE json_extract(d.payload, '$.status') = 'pending_review' AND v.decision_id IS NULL"),
      reviews: Object.fromEntries((this.db.prepare(scope + "SELECT decision_id, payload FROM decision_reviews WHERE decision_id IN (SELECT id FROM demo_decisions)").all(ids) as { decision_id: string; payload: string }[]).map(row => [row.decision_id, JSON.parse(row.payload)])),
    };
  }
  close() { this.db.close(); }
}

let singleton: Store | undefined;
export function getStore() { return singleton ??= new Store(); }
export function getDashboard() { return getStore().dashboard(); }
