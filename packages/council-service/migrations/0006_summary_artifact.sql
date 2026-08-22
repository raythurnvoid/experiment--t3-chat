-- Old upload bodies and host fingerprints do not contain the two required file mode flags. Stop
-- until the maintenance gate has drained every old artifact instead of preserving rows that the
-- strict host can never replay.
DROP TABLE IF EXISTS council_upgrade_guard;
CREATE TABLE council_upgrade_guard (artifact_rows INTEGER CHECK (artifact_rows = 0));
INSERT INTO council_upgrade_guard (artifact_rows) SELECT COUNT(*) FROM meeting_artifacts;
DROP TABLE council_upgrade_guard;

-- Add the generated meeting summary. SQLite cannot widen a CHECK in place, so rebuild only this
-- now-empty table and recreate its index.

DROP INDEX meeting_artifacts_by_meeting;

ALTER TABLE meeting_artifacts RENAME TO meeting_artifacts_0006_old;

CREATE TABLE meeting_artifacts (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (
		kind IN ('track_audio', 'provider_transcript', 'transcript_markdown', 'summary_markdown')
	),
	target_key TEXT NOT NULL,
	file_name TEXT NOT NULL,
	node_id TEXT,
	upload_body TEXT,
	bytes INTEGER,
	status TEXT NOT NULL CHECK (status IN ('pending', 'finalized', 'failed', 'deleted')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (meeting_id, target_key)
);

INSERT INTO meeting_artifacts (
	id,
	meeting_id,
	kind,
	target_key,
	file_name,
	node_id,
	upload_body,
	bytes,
	status,
	created_at,
	updated_at
)
SELECT
	id,
	meeting_id,
	kind,
	target_key,
	file_name,
	node_id,
	upload_body,
	bytes,
	status,
	created_at,
	updated_at
FROM meeting_artifacts_0006_old;

DROP TABLE meeting_artifacts_0006_old;

CREATE INDEX meeting_artifacts_by_meeting ON meeting_artifacts (meeting_id);

-- Store the validated rendered summary before any upload target is created. A redrive reads these
-- exact bytes instead of calling the model again, and immediate meeting deletion removes the text.
CREATE TABLE meeting_summaries (
	meeting_id TEXT PRIMARY KEY REFERENCES meetings (id) ON DELETE CASCADE,
	markdown TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
