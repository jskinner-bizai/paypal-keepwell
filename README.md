# Keepwell

Every failed renewal gets the next best action, not another reminder.

Keepwell is a sandbox merchant recovery workspace. A deterministic engine checks six levers, scores eligible actions with a small synthetic logistic model, ranks propensity x value x lever weight, and reserves concessions inside merchant and customer limits. An illustrative scenario comparison replays the same synthetic cases through reminder-only and ranked policies.

This checkpoint recommends actions and saves their evidence. No PayPal write, customer contact, refund or subscription change executes. An LLM is not connected and has no role in eligibility, scoring, arbitration or budgets.

## Run locally

Requires Node 24 and npm. Run from the repository root:

```sh
npm ci
npm run seed
npm run dev
```

Open http://127.0.0.1:3000. Select a customer and signal, then **Simulate event**. Past-due scenarios need a customer with an invoice. The receipt exposes all six candidates, exclusions, probabilities, priorities, budget snapshot and approval requirements. Reload to verify persistence.

For an isolated production-mode walkthrough, use the [judge runbook](docs/judge-runbook.md). Production requires `KEEPWELL_DEMO_ENABLED=true`; the runbook uses a fresh database and placeholder PayPal credentials so inherited provider configuration cannot enter the synthetic walkthrough.

`npm run demo:simulate` runs a failed-renewal event from the terminal. `npm run seed` is idempotent and preserves existing events, decisions and reservations. The second migration preserves historical foundation receipts and adds synthetic recovery profiles and concession reservations.

The synthetic dashboard, selector, portfolio values and event/audit/review summaries include only seeded synthetic identities and their simulation decisions. Nonseeded sandbox customers cannot enter simulation or demo review, including historical mixed-state records. Provider receipts remain retained in the local store, separate from this synthetic workspace.

All 54 demo customers, profiles, captures and payment histories are synthetic. Three plans cost $19, $49 and $99 monthly. Portfolio value and value at risk are not recovered revenue. Real sandbox customer profiles have not been provisioned: they fail closed to internal human review instead of using synthetic capture or margin assumptions.

## Decision policy

| Lever | Eligibility beyond common contact and profile checks | Reserved concession | Review |
| --- | --- | --- | --- |
| Pause subscription | Active subscription, failed renewal, no pause in 30 days | 25% of value at risk, rounded up | Above $10 |
| Downgrade offer | Active subscription, failed renewal, cheaper plan exists | One-cycle price difference | Above $10; buyer consent separately required |
| Early-pay discount invoice | Unpaid past-due invoice | 10% of amount due, rounded to cents | Above $10 |
| Merchant reminder | Failed renewal or past-due invoice | Zero | Draft for merchant to send |
| Goodwill partial refund | Known refundable capture, tenure at least six months, at least two failures, no refund in 90 days | Smaller of 20% value or refundable balance | Always |
| Human save task | Internal fallback, including sensitive cases | Zero | Always |

Cancellations, disputes, unknown profiles, uncontactable customers and zero value at risk allow only an internal human task. Invalid money, count, margin and budget values are rejected. Invalid or future pause/refund history blocks that lever. Exact cooldown boundaries are inclusive: a new offer is eligible at 30 or 90 complete days.

Policy `recovery-v1` uses fixed merchant lever weights: pause 1.0, downgrade 1.05, discount 1.1, reminder 1.0, refund 0.95, human task 0.3. Equal priorities retain the declared lever order. These preferences are stated policy assumptions, not learned economic value.

Limits are $150 per merchant UTC calendar month and $40 per customer over a rolling 90 days. Concessions cannot reduce contribution below 20% of the original value at risk under the stored gross-margin assumption. All calculations use integer cents; scoring uses finite probabilities. Downgrade and pause amounts are conservative one-cycle opportunity-cost assumptions, not statements about automatic PayPal proration.

The event, selected decision, complete candidate trace, concession reservation and audit row commit together under `BEGIN IMMEDIATE`. Budget reads occur inside that transaction. Duplicate events do not reserve twice. Pending refund and pause promises also block repeat offers during their cooldowns. Simulation and PayPal budget ledgers are separate. A reservation is not spend: all current decisions are unexecuted.

The synthetic demo now has final approval and rejection controls. Approval records review only and keeps the concession held. Rejection releases the active reservation and its pending cooldown while retaining the original decision, reservation and audit evidence. Historical budget and cooldown reads honor the rejection timestamp; a later review cannot change an earlier decision's evidence. Repeating the same review returns the original receipt; an opposite outcome is rejected. The review and budget-release effect commit atomically. Reviewed decisions survive reloads and schema upgrades preserve older receipts. The controls reject PayPal-sourced and historical foundation decisions. Buyer consent and actual execution are not supplied by a demo approval.

`POST /api/demo/review` uses the same explicit demo-mode and same-origin request boundary as simulation. It is not merchant authentication and must remain isolated to synthetic demo state. Real approval identity, authenticated merchant access, PayPal execution, idempotent provider requests and execution reconciliation remain unimplemented.

## Propensity and scenario simulation on synthetic data

```sh
npm run train
npm run compare
```

The runtime model is `synthetic-logistic-v1`: six logistic regressions with committed coefficients. Training uses 600 synthetic historical customers and 3,600 action outcomes, seed `20261001`. Disjoint calibration uses 240 customers and 1,440 outcomes, seed `20261015`. Calibration Brier score is 0.22087284 under these synthetic assumptions. Retraining reproduces the artifact exactly. Features are tenure, prior failures, days past due, monthly value and signal type. Identity, customer notes and merchant-wide reporting counts cannot change the score.

Evaluation uses seed `20261103`, 54 separately identified cases, a fixed scenario clock of November 3, 2026, and an illustrative 30-day horizon. Both policies see the same cases and paired random draws; each has an independent budget. This is a paired scenario replay, not a randomized holdout or a causal merchant lift estimate. No tuning was performed against the evaluation result.

| Simulated result | Reminder-only champion | Ranked challenger | Difference |
| --- | ---: | ---: | ---: |
| Customer saves | 23 | 26 | +3 |
| Gross revenue | $1,287.00 | $1,404.00 | +$117.00 |
| Assumed concession spend | $0.00 | $103.85 | +$103.85 |
| Net after concessions | $1,287.00 | $1,300.15 | +$13.15 |

The challenger reserves $147.75 of $150 before outcomes. Selected actions: 5 pauses, 6 invoice discounts, 7 refunds, 22 reminders and 14 human tasks. Downgrade is never eligible for the seeded customers under the current constants: the $30 growth-to-starter concession exceeds their margin allowance (at most $26.95), and the $50 scale-to-growth concession exceeds the $40 customer limit. Separate policy fixtures test downgrade eligibility and buyer consent; the fixed cohort does not demonstrate that lever. Net means revenue after concessions only, excluding labor, payment fees and service costs. It is not profit.

Outcome probabilities come from a separate hand-authored synthetic response surface. Training learned from that same assumed world on disjoint histories; the replay is not independent evidence of real effectiveness. Merchant approval is separately assumed at 90%, buyer consent at 75%. Refunds cost their concession even if the customer is not saved after assumed approval. Other concessions incur assumed spend on a save. No reservations are recycled during the run. Sensitive cases receive the same human-review safety fallback in both arms, and uncontactable cases never produce a save. One event per customer is evaluated; repeated-event budget safety is tested separately.

The full artifact, including case-level outcomes, candidate traces, assumptions and reconciled budgets, is written to ignored `data/scenario-comparison.json`. The dashboard shows the same deterministic summary. Change policy assumptions explicitly and version them before future experiments; do not cherry-pick an evaluation seed.

## PayPal sandbox

Verified November 7, 2026 at 13:30:38 UTC: the existing sandbox app passed real OAuth and transaction reporting, returning one transaction with successful status. This is read-only evidence, not proof of a recovery, a signed webhook delivery, a mapped real subscription, or an executed action. Credentials remain local and ignored.

Schema 4 adds explicit, typed sandbox resource mappings. PayPal ingress cannot map onto the seeded demo customers, and a subscription event cannot resolve an invoice ID. `Store.registerSandboxResource` is a local operator-only method, with no HTTP registration endpoint: first register a separately validated sandbox customer, then bind its exact existing subscription or invoice ID. This method does not prove provider ownership. No actual provider resource has been mapped yet. A missing mapping fails closed; a mapped sandbox customer still receives human review with zero concession because real recovery profiles are not provisioned. Disputes remain blocked pending transaction correlation.

The shared webhook ingress verifies the exact received object before parsing or opening the database. Local injected-transport tests cover rejected signatures, invalid verification metadata, unknown and wrong-kind resources, seeded identity refusal, successful verification followed by human-only processing, duplicate delivery and conflicting replay. These tests never call PayPal and are not real signed-delivery evidence. See [readiness gates](docs/sandbox-readiness.md).

Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in the launching terminal or ignored `.env.local`. User environment changes require a fresh launching environment. Never use production credentials.

```sh
npm run paypal:check
```

This makes a real sandbox OAuth request and prints authentication status and expiry metadata only. Missing credentials or denied authentication exits nonzero. Passing mock tests does not establish live OAuth. Set `PAYPAL_WEBHOOK_ID` to the sandbox app's registered webhook ID before using `/api/webhooks/paypal`.

After existing sandbox credentials are authorized and available, `npm run paypal:qualify` checks OAuth and a bounded transaction-reporting read separately. It exits nonzero for absent credentials, authentication failure, denied reporting access or malformed responses. With missing credentials it makes no request. Its JSON receipt contains presence flags, safe status/count metadata and a timestamp, never credentials, tokens, transaction IDs, payer details or response bodies. The reporting count covers only the merchant-wide first page, up to 100 transactions over 30 days. A passing receipt qualifies those reads only; it always leaves webhook verification, resource mapping, business actions and the complete application unqualified. It creates no persistent credentials, registers no webhook and executes no payment or subscription change. Fixture tests use an explicitly identified injected transport and do not establish live PayPal access.

The ingress requires PayPal signature headers and successful postback verification before parsing the event. Unsigned events fail closed. PayPal's Webhooks Simulator cannot use postback verification. Local `/api/demo/simulate` enters the same processor through a separate same-origin boundary, accepts only a seeded customer and known scenario, and always selects the mock adapter. Set `KEEPWELL_DEMO_ENABLED=false` to disable it; production requires explicit `true`.

Implemented sandbox paths are `POST /v1/oauth2/token`, `POST /v1/notifications/verify-webhook-signature`, and `GET /v1/reporting/transactions`, always on `https://api-m.sandbox.paypal.com`. Reporting returns the first 100 merchant-wide entries over 30 days, fails explicitly on missing permission, and is not used as customer propensity evidence. No silent mock fallback occurs.

Integration contracts adopted:

- Toolkit merchant insights is unavailable in sandbox. Use labeled local aggregates.
- Pause requires the suspend endpoint. Plan changes require revise and buyer consent, not `update_subscription`.
- There is no `INVOICING.INVOICE` webhook. The supported UPDATED event requires unpaid status, a valid past due date and positive USD `due_amount`. Scoring uses the outstanding balance, not the original invoice total. A scheduled due-date scan is still needed.
- Invoice reminders need an invoice. Subscription failures use a merchant-sent message.
- Real disputes need a transaction-to-customer mapping, which is not configured. Local disputes use explicit synthetic identity and realistic dispute identifiers.
- Pay Later is excluded from the six-lever library.

Sources: [toolkit](https://github.com/paypal/agent-toolkit), [invoice details and amount due](https://developer.paypal.com/api/invoicing/v2/invoices-get), [webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/), [hosted sandbox issue](https://github.com/paypal/agent-toolkit/issues/119).

## Verification and next gates

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Unit and integration checks cover eligibility, cent boundaries, cooldowns, approval flags, repeatable training, disjoint evaluation, synthetic accounting, input-note injection, schema preservation, concurrent connections, budget windows and rollback. Review tests cover held and released concessions, immutable evidence, repeated/conflicting outcomes, PayPal-source refusal, invalid clocks, rollback and durable readback. HTTP tests run an isolated production server with fake credentials, exercise both review outcomes and their request boundaries, and read event/decision/audit/reservation/review records back from SQLite. No live PayPal call occurs in these tests. The HTTP environment test explicitly enables demo mode and restores its prior value, including under inherited `NODE_ENV=production`.

The local Windows build uses webpack/Babel and two worker threads for restricted filesystem compatibility. Node 24 SQLite currently emits an experimental warning. Run from the repository root so migration paths resolve. SQLite hosting is single-instance; multiple instances require Postgres.

November 12 candidate verification: 59 local tests, type checking, production build and the enhanced production HTTP test passed. The HTTP test verifies that a nonseeded provider fixture cannot appear in the synthetic UI or use either demo endpoint. An independent fresh-database production launch confirmed simulation, rejection and persistent readback with fake provider credentials. These are local checks, not live webhook evidence.

Still required for a complete entry: meaningful provider-to-product evidence, the final source/media/form review, a public repository, a public YouTube demonstration under three minutes and native submission confirmation. Actual signed sandbox webhook delivery has not yet been demonstrated. Real authenticated approval, buyer consent and PayPal business-action execution are not part of this prototype.

Render is not deployed. No Render CLI or API credential is available in the current build environment. The account owner must provide the Render account/repository connection and approve any charges before the persistent-disk service in `render.yaml` is enabled; the repository is still local. This remains a dependency of the planned hosted demo, not a general contest requirement. Secrets stay server-side, and any public demo must use isolated synthetic state.

The official [AG Studio boilerplate](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate/tree/5de114eb4306e844396022f9ca0558a4937761e2) has been inspected, but its dashboard/agent integration has not shipped. Its unprotected model proxy needs access and rate controls before public use. No explanation model is selected. `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` remain reserved server-only settings; the future explainer only rewrites a fixed action's message and explanation.

The [official rules](https://paypalaihackathon.devpost.com/rules), checked November 12, permit a working local build with complete repository setup/run instructions instead of public hosting. They require a public open-source repository, a working PayPal-and-AI integration, text description, and a public YouTube demonstration under three minutes. AG Studio and Render are optional partner integrations for the general contest; sponsor prizes have additional requirements. The current mock flow and passing tests do not establish complete PayPal integration or contest eligibility.

Deadline: November 12, 2026, noon Pacific (20:00 UTC). The working project must remain testable through December 15. Do not publish credentials or private account data. A new sandbox resource, webhook registration, external receiver, paid service or new account/access grant needs its own appropriate authorization. MIT licensed.
