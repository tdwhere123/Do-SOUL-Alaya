-- Operational ownership only; completion remains an EventLog fact.
CREATE TABLE claim_election_leases (
  lease_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
