import { Store } from "../src/lib/store";
import { processEvent, simulatedEvent } from "../src/lib/events";
import { mockAdapter } from "../src/lib/paypal";
const store = new Store();
try {
  const customer = store.dashboard().customers[0];
  const receipt = await processEvent(store, mockAdapter, simulatedEvent(customer, "failed_payment"), "simulation");
  console.log(JSON.stringify({ ...receipt, persisted: { events: store.dashboard().eventCount, auditRows: store.dashboard().auditCount } }, null, 2));
} finally { store.close(); }
