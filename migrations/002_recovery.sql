CREATE TABLE recovery_profiles (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  payload TEXT NOT NULL
);
CREATE TABLE concession_reservations (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  source TEXT NOT NULL CHECK (source IN ('simulation', 'paypal')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX reservations_month ON concession_reservations(source, created_at);
CREATE INDEX reservations_customer ON concession_reservations(source, customer_id, created_at);
PRAGMA user_version = 2;
