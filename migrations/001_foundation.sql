CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL UNIQUE,
  invoice_id TEXT UNIQUE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('simulation', 'paypal')),
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES webhook_events(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events(id),
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  kind TEXT NOT NULL CHECK (kind = 'decision_recorded'),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 1;
