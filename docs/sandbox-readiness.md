# Keepwell sandbox readiness, November 12, 2026

## Evidence boundary

- Actual sandbox OAuth and bounded merchant reporting passed on November 7 at 13:30:38 UTC. One returned transaction had successful status; this is not recovery attribution.
- Local fixtures exercise postback verification through the same ingress used by the HTTP route, typed explicit resource mapping, rejection paths, human-only receipts and replay safety. Fixture verification responses are injected; no real signature has been validated.
- On November 12, one authorized synthetic USD1.00 sandbox invoice was created, sent and updated with both email notifications disabled. PayPal generated an INVOICING.INVOICE.UPDATED event. The temporary tunnel returned 502 because it could not connect to the local receiver; no signature-verified provider event or decision was persisted.
- The invoice was cancelled, exact temporary webhook deletion was verified, and the owned tunnel and test servers were stopped. No payment, refund, production account action or new credential was created. No customer email notification was sent.
- The observed nested resource.invoice envelope and transient UNPAID status are covered by the revised parser and regression tests. Local test verification remains injected and does not qualify real signed delivery.

## Next integration evidence

1. For another authorized sandbox test, select and verify the exact resource, register a separate local sandbox customer, then bind the resource through the local operator method. Never relabel a seeded demo record as real provider data. The November 12 test invoice is cancelled and must not be reused as an unpaid live resource.
2. Qualify a reachable webhook receiver before a new authorized registration on the existing sandbox app. The November 12 temporary receiver, webhook and tunnel are no longer active. No authorization for ongoing exposure or additional resources is implied.
3. Deliver an actual signed sandbox event and retain sanitized evidence showing verification, mapping, persisted human-review receipt, and duplicate handling. The simulator is not proof of postback verification. Real recovery profiles and dispute transaction mapping remain separate work.
4. Before adding business writes, implement provider idempotency, approval identity, buyer consent where required and reconciliation. No writes are necessary merely to demonstrate the current read-only product truthfully.

## Competition assessment

The [official rules](https://paypalaihackathon.devpost.com/rules), checked November 12, require PayPal sandbox plus an AI model/tool, a runnable build, public open-source source, description and public YouTube demo under three minutes. Local setup instructions can replace hosting. Deadline: November 12 at noon Pacific; judging access must last through December 15.

AG Grid prizes require use of an AG Grid tool; AG Studio specifically is not mandated by those rules. Render prizes require Render use. Neither integration is required for general entry. Keepwell currently uses neither. Its trained logistic model is AI, but meaningful PayPal integration and end-to-end evidence remain weak until the provider data participates visibly in the product. This is a readiness assessment, not an eligibility determination.

Do not claim webhook production readiness, recovery revenue, AG Grid/Render integration or executed PayPal payment actions. The public MIT source is at https://github.com/jskinner-bizai/paypal-keepwell and includes local judge setup instructions. Final video publication and native submission still require their remaining review and authorization gates. Never publish local credentials as test instructions.
