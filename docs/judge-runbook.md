# Keepwell judge runbook: corrected production launch

Revision November 12, 2026. This supersedes the November 8 runbook's incomplete production launch instructions. The earlier receipt remains preserved. Current source is a local candidate, not a final entry.

## Windows PowerShell, clean source

Requires Node 24 and npm. Open a new PowerShell terminal in the extracted repository root. Use these process-local values; do not copy an existing .env.local or provider database into the walkthrough.

    $env:KEEPWELL_DEMO_ENABLED = 'true'
    $env:KEEPWELL_DB_PATH = Join-Path $env:TEMP ('keepwell-judge-' + [guid]::NewGuid().ToString('N') + '.sqlite')
    $env:PAYPAL_CLIENT_ID = 'demo-disabled'
    $env:PAYPAL_CLIENT_SECRET = 'demo-disabled'
    $env:PAYPAL_WEBHOOK_ID = 'demo-disabled'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    npm ci
    npm run seed
    npm run build
    npm run start -- --port 3000

The three placeholder PayPal values prevent inherited real credentials or a local environment file from being used in this synthetic walkthrough. Do not use this process to qualify webhooks or PayPal reads. No provider request is needed for the walkthrough. The start script binds 127.0.0.1 once. Do not use start:host for this walkthrough; that separate script is for an explicitly approved hosted deployment. The same terminal must launch the server so demo mode and the new database path are inherited. Record the database path if you need to revisit the session. Seeding is idempotent and does not clear earlier receipts. Stop with Ctrl+C when finished; preserve the database as evidence rather than deleting it.

## macOS/Linux shell equivalent, not yet platform-tested

    export KEEPWELL_DEMO_ENABLED=true
    export KEEPWELL_DB_PATH="$(mktemp -d)/keepwell-judge.sqlite"
    export PAYPAL_CLIENT_ID=demo-disabled
    export PAYPAL_CLIENT_SECRET=demo-disabled
    export PAYPAL_WEBHOOK_ID=demo-disabled
    export NEXT_TELEMETRY_DISABLED=1
    npm ci
    npm run seed
    npm run build
    npm run start -- --port 3000

## Acceptance walkthrough

Open http://127.0.0.1:3000 . Confirm Synthetic demo and 54 seeded customers. Select Demo merchant customer 001 and Failed subscription payment, then Simulate event. Open the decision trace and inspect the six candidates and the reserved concession. Reject and release: confirm the released amount and persistent review after reload. Simulate again, approve the demo only and confirm that the reservation stays held. These actions only affect the isolated local state; no refund, payment or customer message executes.

A 403 saying Demo simulation is disabled means the server was not started with KEEPWELL_DEMO_ENABLED=true. Stop that owned local server and relaunch from the correctly configured terminal. Do not weaken request-origin checks. A 409 for an opposite second review is expected: final review outcomes are immutable.

The model and comparison are synthetic. Actual sandbox qualification remains separate. The November 12 source isolation patch passed independent delta review and a fresh-database production walkthrough. The frozen November 8 archive remains preserved. Final complete-entry Claude/media review and provider-data qualification remain open. Ordinary contest publication/submission are covered by the user's standing direction; secrets, private data and materially new terms/access remain outside that scope.
