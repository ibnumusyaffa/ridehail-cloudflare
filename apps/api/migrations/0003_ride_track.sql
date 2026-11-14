-- The driver's route during a trip (ON_TRIP): one row per accepted location ping. The zone actor
-- buffers pings in its own SQLite and sends them here in batches (every TRACK_FLUSH_MS and once more
-- when the ride ends). `seq` is the buffer's row id: increasing per ride, never reused, so a batch
-- sent twice (reply lost) is ignored by the primary key.
CREATE TABLE ride_track (
  ride_id TEXT NOT NULL REFERENCES rides(id),
  seq BIGINT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (ride_id, seq)
);
