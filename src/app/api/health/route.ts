export const runtime = "nodejs";
export function GET() { return Response.json({ status: "ok", version: "0.2.0", policy: "recovery-v1", paypal: "sandbox-only", externalExecution: false }); }
