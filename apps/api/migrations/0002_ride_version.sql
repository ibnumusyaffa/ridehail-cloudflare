-- Ride status is written by its zone actor as a compare-and-set on `version` (one bump per transition).
-- A transition whose reply was lost is resolved by "fencing": bumping the version from the value the
-- write expected. If the fence wins, the lost write can never commit any more; if it loses, the write
-- had committed. Either way the actor knows for sure (see transitionRide / fenceRide in db.ts).
ALTER TABLE rides ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
