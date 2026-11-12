"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DashboardData, ProcessReceipt } from "@/lib/types";
import ReviewControls from "./review-controls";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
const scenarios = [
  { value: "failed_payment", label: "Failed subscription payment" },
  { value: "past_due", label: "Past-due invoice" },
  { value: "cancelled", label: "Cancelled subscription" },
  { value: "dispute", label: "Customer dispute" },
] as const;

export default function DemoPanel({ customers, decisions, eventCount, auditCount, reservedConcessionCents, pendingReviewCount, reviews }: DashboardData) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [scenario, setScenario] = useState<string>("failed_payment");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<ProcessReceipt | null>(null);
  const portfolioCents = customers.reduce((sum, customer) => sum + customer.monthlyValueCents, 0);

  async function simulate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const response = await fetch("/api/demo/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, scenario }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The event could not be processed.");
      setReceipt(result as ProcessReceipt);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The event could not be processed.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className="metrics" aria-label="Workspace summary">
      <article><p>Seeded customers</p><strong>{customers.length}</strong><span>Across three subscription plans</span></article>
      <article><p>Monthly portfolio value</p><strong>{money(portfolioCents)}</strong><span>Synthetic value, not recovered revenue</span></article>
      <article><p>Events processed</p><strong>{eventCount}<small> / {auditCount} audit rows</small></strong><span>Saved to the local event store</span></article>
      <article><p>Awaiting review</p><strong>{pendingReviewCount.toString().padStart(2, "0")}</strong><span>{money(reservedConcessionCents)} reserved in demo, no execution</span></article>
    </section>

    <section className="flow-layout" aria-labelledby="simulation-title">
      <div className="panel simulation-panel">
        <div className="section-heading"><div><p className="eyebrow">TRY THE FLOW</p><h2 id="simulation-title">Start with a signal</h2></div><span className="number-mark" aria-hidden="true">01</span></div>
        <p className="muted">Create a local event and send it through the shared processing handler.</p>
        <form onSubmit={simulate}>
          <label htmlFor="customer">Customer</label>
          <select id="customer" value={customerId} onChange={(event) => setCustomerId(event.target.value)} disabled={busy || !customers.length}>
            {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · {customer.planId}</option>)}
          </select>
          <label htmlFor="scenario">Payment signal</label>
          <select id="scenario" value={scenario} onChange={(event) => setScenario(event.target.value)} disabled={busy}>
            {scenarios.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          <button className="primary-button" type="submit" disabled={busy || !customerId}>{busy ? "Processing event…" : "Simulate event"}<span aria-hidden="true">↗</span></button>
        </form>
        <p className="form-note">Simulation uses mock context. No PayPal request or customer message is sent.</p>
        <div aria-live="polite" aria-atomic="true">
          {error && <p className="error-message" role="alert">{error}</p>}
          {receipt && <div className="receipt"><strong>{receipt.duplicate ? "Existing decision found" : "Event processed and saved"}</strong><p>{receipt.decision.reason}</p><code>{receipt.decision.id}</code></div>}
        </div>
      </div>
      <div className="panel pipeline-panel">
        <div className="section-heading"><div><p className="eyebrow">A VISIBLE DECISION PATH</p><h2>From signal to next step</h2></div><span className="subtle-badge">Deterministic</span></div>
        <ol className="pipeline">
          <li><span className="step-dot" aria-hidden="true">1</span><div><h3>Receive &amp; validate</h3><p>The event is checked and matched to a seeded customer.</p></div><span className="step-label">SIGNAL</span></li>
          <li><span className="step-dot" aria-hidden="true">2</span><div><h3>Gather context</h3><p>Plan, tenure and synthetic payment history inform the trace.</p></div><span className="step-label">CONTEXT</span></li>
          <li><span className="step-dot" aria-hidden="true">3</span><div><h3>Rank six levers</h3><p>Check eligibility, propensity, value, lever weight and concession limits.</p></div><span className="step-label">DECISION</span></li>
          <li><span className="step-dot" aria-hidden="true">4</span><div><h3>Reserve and save</h3><p>Reserve any concession and persist the decision and audit atomically.</p></div><span className="step-label">AUDIT</span></li>
        </ol>
        <div className="integration-note"><span aria-hidden="true">○</span><p><strong>Explanation integration is pending.</strong> This checkpoint uses fixed message templates. No LLM is connected.</p></div>
      </div>
    </section>

    <section className="panel customer-panel" id="customers" aria-labelledby="customers-title">
      <div className="section-heading"><div><p className="eyebrow">THE SEEDED PORTFOLIO</p><h2 id="customers-title">Customers in view</h2></div><span className="subtle-badge">Synthetic data</span></div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Seeded customer portfolio, scroll to view all customers">
        <table><caption className="sr-only">Synthetic customer plans and payment signals</caption><thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col" className="numeric">Monthly value</th><th scope="col" className="numeric">Tenure</th><th scope="col" className="numeric">Failures</th><th scope="col" className="numeric">Past due</th></tr></thead>
          <tbody>{customers.map((customer) => <tr key={customer.id}><th scope="row"><strong>{customer.name}</strong><span>{customer.id}</span></th><td><span className={`plan-tag plan-${customer.planId}`}>{customer.planId}</span></td><td className="numeric">{money(customer.monthlyValueCents)}</td><td className="numeric">{customer.tenureMonths} mo</td><td className="numeric">{customer.failedPayments}</td><td className="numeric">{customer.daysPastDue > 0 ? <span className="due-tag">{customer.daysPastDue} days</span> : <span className="muted">Current</span>}</td></tr>)}</tbody>
        </table>
      </div>
      {!customers.length && <p className="empty-state">No seeded customers yet. Run the seed command to populate this workspace.</p>}
    </section>

    <section className="decision-section" id="decisions" aria-labelledby="decisions-title">
      <div className="section-heading"><div><p className="eyebrow">EVIDENCE, NOT GUESSWORK</p><h2 id="decisions-title">Recent decisions</h2></div><span className="muted">Latest {Math.min(decisions.length, 6)} saved decisions</span></div>
      {!decisions.length ? <div className="panel empty-state"><span className="empty-symbol" aria-hidden="true">↗</span><h3>Your first decision starts above.</h3><p>Simulate a payment signal to inspect the reason, customer message and audit trace.</p></div> : <div className="decision-grid">{decisions.slice(0, 6).map((decision) => <article className="panel decision-card" key={decision.id}>
        <div className="decision-card-top"><span className={decision.status === "pending_review" && !reviews[decision.id] ? "status-tag review" : "status-tag draft"}>{reviews[decision.id] ? `Demo ${reviews[decision.id].outcome}` : decision.status === "pending_review" ? "Review required" : "Recommendation draft"}</span><span className="decision-value">{money(decision.valueAtRiskCents)} at risk</span></div>
        <h3>{customers.find((customer) => customer.id === decision.customerId)?.name ?? decision.customerId}</h3><p className="decision-reason">{decision.reason}</p>
        {decision.message && <blockquote>{decision.message}</blockquote>}
        {decision.requiresCustomerConsent && <p className="form-note">Buyer consent is required before any plan change.</p>}
        <ReviewControls decision={decision} review={reviews[decision.id]} />
        <details><summary>View decision trace</summary><ol>{decision.trace.map((step, index) => <li key={index}>{step}</li>)}</ol><p>{decision.context.note}</p><dl><dt>Policy</dt><dd>{decision.policyVersion}</dd><dt>Model</dt><dd>{decision.modelVersion ?? "No model, historical foundation receipt"}</dd><dt>Context</dt><dd>{decision.context.source === "synthetic" ? "Synthetic" : "PayPal sandbox"}</dd><dt>Reserved concession</dt><dd>{money(decision.concessionCents)}</dd></dl>
          {decision.candidates && <div className="table-scroll" tabIndex={0} role="region" aria-label="Six candidate scores"><table><thead><tr><th scope="col">Lever</th><th scope="col">Eligibility</th><th scope="col">Propensity</th><th scope="col">Priority</th><th scope="col">Reason</th></tr></thead><tbody>{decision.candidates.map(candidate => <tr key={candidate.action}><th scope="row">{candidate.label}</th><td>{candidate.eligible ? "Eligible" : "Excluded"}</td><td>{candidate.propensity === null ? "Excluded" : `${(candidate.propensity * 100).toFixed(1)}%`}</td><td>{candidate.priority === null ? "Excluded" : candidate.priority.toFixed(2)}</td><td>{candidate.reasons.join(" ")}</td></tr>)}</tbody></table></div>}
          <code>{decision.eventId}</code></details>
      </article>)}</div>}
    </section>
  </>;
}
