import { InputError, parseEvent, processEvent } from "./events";
import type { Store } from "./store";
import type { PayPalAdapter, PayPalEvent } from "./types";

// Verify the exact received object before normalization or identity resolution.
export async function ingestPayPalWebhook(store: Store | (() => Store), adapter: PayPalAdapter, raw: unknown, headers: Headers, now = new Date()) {
  if (adapter.mode !== "sandbox" || !await adapter.verifyWebhook(raw as PayPalEvent, headers)) {
    throw new InputError("Webhook signature could not be verified", 401);
  }
  const event = parseEvent(raw);
  return processEvent(typeof store === "function" ? store() : store, adapter, event, "paypal", now);
}
