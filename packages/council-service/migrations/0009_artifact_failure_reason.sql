-- A recording the host refused as over the upload cap must keep that reason on the
-- artifact row. The meeting can still finish ready. Without this column the only
-- stored text is meetings.failure_reason, and that column belongs to a failed run.
ALTER TABLE meeting_artifacts ADD COLUMN failure_reason TEXT;
