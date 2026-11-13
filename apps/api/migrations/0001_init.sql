-- Cold store (D1). Location pings are NOT stored here (soft state lives in ZoneDO).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer', 'driver')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE vehicles (
  driver_id TEXT PRIMARY KEY REFERENCES users(id),
  plate TEXT NOT NULL,
  model TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE rides (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT REFERENCES users(id),
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, pickup_label TEXT,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL, drop_label TEXT,
  status TEXT NOT NULL,
  fare_estimate INTEGER NOT NULL,
  fare_final INTEGER,
  distance_m INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'WALLET')),
  paid_via TEXT CHECK (paid_via IN ('CASH', 'WALLET')),
  paid_at INTEGER,
  cancel_reason TEXT,
  cancelled_by TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  idempotency_key TEXT,
  requested_at INTEGER NOT NULL,
  accepted_at INTEGER, arrived_at INTEGER, started_at INTEGER,
  completed_at INTEGER, cancelled_at INTEGER
);
CREATE INDEX rides_customer ON rides (customer_id, requested_at DESC);
CREATE INDEX rides_driver ON rides (driver_id, requested_at DESC);
CREATE UNIQUE INDEX rides_idem ON rides (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('TOPUP', 'RIDE_PAYMENT', 'RIDE_EARNING', 'COMMISSION', 'ADJUSTMENT')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ride_id TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (ride_id, user_id, type),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX wallet_tx_user ON wallet_transactions (user_id, created_at DESC);
