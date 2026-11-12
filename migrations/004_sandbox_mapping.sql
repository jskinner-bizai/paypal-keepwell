CREATE TABLE sandbox_resource_mappings (
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('subscription', 'invoice')),
  resource_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  PRIMARY KEY(resource_kind, resource_id),
  UNIQUE(customer_id, resource_kind)
);
PRAGMA user_version = 4;
