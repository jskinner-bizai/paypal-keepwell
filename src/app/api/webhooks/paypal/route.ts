import { getStore } from "@/lib/store";
import { createSandboxAdapter } from "@/lib/paypal";
import { ingestPayPalWebhook } from "@/lib/webhook";
import { errorResponse, readJson } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const raw = await readJson(request);
    const adapter = createSandboxAdapter();
    const receipt = await ingestPayPalWebhook(getStore, adapter, raw, request.headers);
    return Response.json(receipt);
  } catch (error) { return errorResponse(error); }
}
