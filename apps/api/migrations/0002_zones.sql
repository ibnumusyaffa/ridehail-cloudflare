-- Zone actors that have ever been used; lets ops (and the dev reset) enumerate Durable Objects.
CREATE TABLE zones (
  zone TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);
