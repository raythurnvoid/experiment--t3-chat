-- The host no longer books storage before an upload. A service creates its files directly and the
-- workspace quota is charged the declared size at that moment, so a meeting has nothing to reserve
-- and nothing to release. The upload idempotency key is now derived from the meeting id instead of
-- being stored, so both columns go away.
ALTER TABLE meetings DROP COLUMN reservation_id;
ALTER TABLE meetings DROP COLUMN reserve_body;
