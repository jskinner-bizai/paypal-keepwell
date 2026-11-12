import { getStore } from "@/lib/store";
import { InputError } from "@/lib/events";
import { errorResponse, readJson, requireDemoRequest } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireDemoRequest(request);
    const body = await readJson(request) as Record<string, unknown> | null;
    if (!body || typeof body.decisionId !== "string" || typeof body.outcome !== "string" || !["approved", "rejected"].includes(body.outcome)) throw new InputError("Decision and review outcome are required", 400);
    const receipt = getStore().reviewDemoDecision(body.decisionId, body.outcome as "approved" | "rejected");
    return Response.json(receipt, { status: receipt.duplicate ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
