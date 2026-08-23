-- Name the request that owns a participant's admission slot. Each join request writes a fresh
-- attempt id before it calls the provider, so an overlapping request cannot release or finish the
-- slot another request is holding. The start time is that hold's lease: a Worker request that died
-- while its Add Participant call was in flight would keep the slot forever, so a later retry may
-- take the slot over once the lease has passed.
ALTER TABLE meeting_participants ADD COLUMN admission_attempt_id TEXT;
ALTER TABLE meeting_participants ADD COLUMN admission_attempt_started_at INTEGER;
