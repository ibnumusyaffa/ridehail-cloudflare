-- Cold store (Postgres). Location pings are NOT stored here (soft state lives in ZoneDO memory).
-- Money is integer rupiah, timestamps are epoch milliseconds (BIGINT).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer', 'driver')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE vehicles (
  driver_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  model TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE rides (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT REFERENCES users(id),
  pickup_lat DOUBLE PRECISION NOT NULL, pickup_lng DOUBLE PRECISION NOT NULL, pickup_label TEXT,
  drop_lat DOUBLE PRECISION NOT NULL, drop_lng DOUBLE PRECISION NOT NULL, drop_label TEXT,
  status TEXT NOT NULL,
  fare_estimate BIGINT NOT NULL,
  fare_final BIGINT,
  distance_m INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'WALLET')),
  paid_via TEXT CHECK (paid_via IN ('CASH', 'WALLET')),
  paid_at BIGINT,
  cancel_reason TEXT,
  cancelled_by TEXT,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  idempotency_key TEXT,
  requested_at BIGINT NOT NULL,
  accepted_at BIGINT, arrived_at BIGINT, started_at BIGINT,
  completed_at BIGINT, cancelled_at BIGINT
);
CREATE INDEX rides_customer ON rides (customer_id, requested_at DESC);
CREATE INDEX rides_driver ON rides (driver_id, requested_at DESC);
CREATE INDEX rides_driver_completed ON rides (driver_id, completed_at) WHERE status = 'COMPLETED';
CREATE UNIQUE INDEX rides_idem ON rides (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- One active ride per customer / per driver, enforced by the database across all zones.
CREATE UNIQUE INDEX one_active_ride ON rides (customer_id)
  WHERE status IN ('REQUESTED', 'OFFERING', 'ACCEPTED', 'ARRIVED', 'ON_TRIP');
CREATE UNIQUE INDEX one_active_ride_driver ON rides (driver_id)
  WHERE status IN ('ACCEPTED', 'ARRIVED', 'ON_TRIP');

CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('TOPUP', 'RIDE_PAYMENT', 'RIDE_EARNING', 'COMMISSION', 'ADJUSTMENT')),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  ride_id TEXT,
  idempotency_key TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (ride_id, user_id, type),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX wallet_tx_user ON wallet_transactions (user_id, created_at DESC, seq DESC);

-- Funds reserved for an in-flight WALLET ride: captured at completion, released on cancel / no driver.
-- available balance = wallets.balance - SUM(amount of ACTIVE holds)
CREATE TABLE wallet_holds (
  ride_id TEXT PRIMARY KEY REFERENCES rides(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CAPTURED', 'RELEASED')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX wallet_holds_active ON wallet_holds (user_id) WHERE status = 'ACTIVE';

-- Zone actors that have ever been used; lets ops (and the dev reset) enumerate Durable Objects.
CREATE TABLE zones (
  zone TEXT PRIMARY KEY,
  first_seen BIGINT NOT NULL
);
