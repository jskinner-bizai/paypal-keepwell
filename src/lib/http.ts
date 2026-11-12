import { InputError } from "./events";
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new InputError("Content-Type must be application/json", 415);
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Request body is required", 400);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new InputError("Request body exceeds 64 KB", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Invalid JSON body", 400);
  } finally { reader.releaseLock(); }
}
export function requireDemoRequest(request: Request) {
  const enabled = process.env.KEEPWELL_DEMO_ENABLED === "true" || (process.env.NODE_ENV !== "production" && process.env.KEEPWELL_DEMO_ENABLED !== "false");
  if (!enabled) throw new InputError("Demo simulation is disabled", 403);
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === request.headers.get("host"); } catch { /* Reject malformed origins. */ }
  if (!sameOrigin) throw new InputError("Same-origin request required", 403);
}
export function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof InputError ? error.message : "Request could not be completed" }, { status: error instanceof InputError ? error.status : 503 });
}
