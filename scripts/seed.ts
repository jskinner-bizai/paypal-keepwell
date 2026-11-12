import { Store } from "../src/lib/store";
const store = new Store();
console.log(JSON.stringify({ dataset: "synthetic-20261101-v1", customers: store.dashboard().customers.length, reset: false }));
store.close();
