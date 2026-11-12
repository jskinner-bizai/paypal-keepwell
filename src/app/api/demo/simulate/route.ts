import { getStore } from "@/lib/store";
import { mockAdapter } from "@/lib/paypal";
import { InputError, processEvent, scenarios, simulatedEvent, type Scenario } from "@/lib/events";
import { errorResponse, readJson, requireDemoRequest } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    requireDemoRequest(request);
    const body = await readJson(request) as Record<string, unknown> | null;
    if (!body || typeof body.customerId !== "string" || !scenarios.includes(body.scenario as Scenario)) throw new InputError("Customer and supported scenario are required");
    const store = getStore();
    const customer = store.demoCustomer(body.customerId);
    if (!customer) throw new InputError("Customer was not found", 404);
    const event = simulatedEvent(customer, body.scenario as Scenario);
    return Response.json(await processEvent(store, mockAdapter, event, "simulation", new Date(), customer.id), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
