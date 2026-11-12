CREATE TABLE decision_reviews (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
PRAGMA user_version = 3;
