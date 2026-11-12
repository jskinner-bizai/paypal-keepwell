"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Decision, DecisionReview, ReviewOutcome, ReviewReceipt } from "@/lib/types";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export default function ReviewControls({ decision, review }: { decision: Decision; review?: DecisionReview }) {
  const router = useRouter();
  const requestPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<DecisionReview | null>(null);
  const [error, setError] = useState("");
  const current = saved ?? review;

  async function record(outcome: ReviewOutcome) {
    if (requestPending.current || current) return;
    requestPending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/demo/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisionId: decision.id, outcome }) });
      const result = await response.json();
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "Review was not saved.");
        router.refresh();
        return;
      }
      setSaved((result as ReviewReceipt).review);
      router.refresh();
    } catch {
      setError("The review outcome could not be confirmed. Refresh this page before retrying.");
    } finally {
      requestPending.current = false;
      setBusy(false);
    }
  }

  if (decision.context.source !== "synthetic" || decision.policyVersion !== "recovery-v1") return null;
  return <div className="review-controls" aria-label="Synthetic decision review">
    <div aria-live="polite" aria-atomic="true">
      {current ? <p className="review-result"><strong>{current.outcome === "approved" ? "Demo recommendation approved" : "Demo recommendation rejected"}</strong><br />{current.outcome === "approved" ? `${money(current.heldConcessionCents)} remains reserved.` : `${money(current.releasedConcessionCents)} released from the active demo budget.`} No external action executed.</p> : <>
        <p className="form-note">Record a final demo review. Approval keeps the reservation. Rejection releases it. Neither sends a payment or message.</p>
        <div className="review-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => record("approved")}>Approve demo only</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => record("rejected")}>Reject and release</button>
        </div>
      </>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
  </div>;
}
