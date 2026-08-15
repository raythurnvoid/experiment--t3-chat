-- The full meeting pipeline: deletion states on the meeting machine, the webhook-to-Queue outbox,
-- the ordered Plan 2 projection outbox, artifact records, provider preset verification cache, and a
-- short-lived page-token exchange cache.
--
-- The meetings table gains states and columns its CHECK cannot be widened to in place, so it is
-- rebuilt the way migration 0002 did it. Both deployed tables are empty; refuse this clean-slate
-- migration if that stops being true before it is applied.

CREATE TABLE migration_0003_empty_guard (
	row_count INTEGER NOT NULL CHECK (row_count = 0)
);

INSERT INTO migration_0003_empty_guard (row_count)
SELECT
	(SELECT COUNT(*) FROM meetings) +
	(SELECT COUNT(*) FROM meeting_participants) +
	(SELECT COUNT(*) FROM service_grants);

DROP TABLE migration_0003_empty_guard;

DROP INDEX meetings_by_installation;
DROP INDEX meetings_by_status_deadline;
DROP TABLE meetings;

CREATE TABLE meetings (
	id TEXT PRIMARY KEY,
	-- Only the hash. The code is the whole admission secret for a guest, so a database read must not
	-- hand out working join links.
	code_hash TEXT NOT NULL UNIQUE,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	installation_id TEXT NOT NULL,
	plugin_name TEXT NOT NULL,
	title TEXT NOT NULL,
	created_by_user_id TEXT NOT NULL,
	-- Pin actor and token liveness to the grant this meeting was created with. Another actor's later
	-- exchange in the same installation must not replace this authority. Nullable because the delete
	-- workflow clears it before the grant row itself is deleted; a live meeting always has one.
	service_grant_id TEXT REFERENCES service_grants (id) ON DELETE RESTRICT,
	-- The sealed file-write grant. Minted when the meeting opens — capacity is claimed before any
	-- guest joins — and re-minted fresh when a delete is requested. Cleared when the meeting
	-- tombstones.
	processing_grant_id TEXT REFERENCES service_grants (id) ON DELETE RESTRICT,
	-- The service-uploads reservation claimed at open: the full recording envelope, so a workspace
	-- without capacity refuses the meeting before it exists. `reserve_body` is the exact JSON body
	-- the reserve call was made with — the host answers a replay only for an identical body, so the
	-- body must be replayed from storage, never rebuilt from a new clock.
	reservation_id TEXT,
	reserve_body TEXT,
	-- Workspace folder the recording and transcript are written into.
	destination_path TEXT NOT NULL,
	provider_meeting_id TEXT,
	provider_session_id TEXT,
	provider_recording_id TEXT,
	-- created -> open -> closed -> processing -> ready|failed. `create_unknown` and
	-- `recording_start_unknown` mean a provider call was sent and its answer was lost; neither may be
	-- retried automatically, because the provider offers no idempotency key on either call.
	-- Any live or terminal state may enter `deleting`; a finished delete leaves only
	-- `deleted_tombstone`, and a delete whose external cleanup keeps failing sits in `delete_failed`
	-- so an operator is alerted instead of the plan claiming zero while data survives.
	status TEXT NOT NULL CHECK (
		status IN (
			'created',
			'create_unknown',
			'open',
			'recording_start_unknown',
			'closed',
			'processing',
			'ready',
			'failed',
			'expired',
			'deleting',
			'delete_failed',
			'deleted_tombstone'
		)
	),
	-- Why a meeting is `failed`, for the page and the operator. Never carries names or secrets.
	failure_reason TEXT,
	-- Set when the host opens the session. Admission closes at this time whatever else happens.
	deadline_at INTEGER,
	opened_at INTEGER,
	closed_at INTEGER,
	recording_started_at INTEGER,
	-- Accepted slots, not attempts. The 26th accepted participant is refused.
	participant_count INTEGER NOT NULL DEFAULT 0,
	-- Monotonic Plan 2 projection revision. Every projection write is a new revision, so the
	-- receiver can refuse stale and duplicate deliveries.
	projection_revision INTEGER NOT NULL DEFAULT 0,
	-- Work generation for the Queue-to-Workflow handoff. A replay after Workflow retention creates a
	-- new generation instead of reviving a dead instance id.
	processing_generation INTEGER NOT NULL DEFAULT 0,
	processing_workflow_id TEXT,
	-- Set when the meeting enters `deleted_tombstone`. Scheduled cleanup deletes the row after this
	-- moment, eight days after close/delete, once every external delete has settled.
	tombstone_expires_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX meetings_by_installation ON meetings (installation_id, created_at DESC);
CREATE INDEX meetings_by_status_deadline ON meetings (status, deadline_at);
CREATE INDEX meetings_by_provider_meeting ON meetings (provider_meeting_id);

-- The provider result for a joined participant, encrypted with COUNCIL_ROOM_COOKIE_SECRET-derived
-- key material like the grant tokens. A replayed join returns the same token instead of creating a
-- second provider participant. Cleared when the meeting is deleted.
ALTER TABLE meeting_participants ADD COLUMN provider_token_encrypted TEXT;
-- Set when the provider accepted this participant. The 25-slot cap counts these, not attempts.
ALTER TABLE meeting_participants ADD COLUMN accepted_at INTEGER;

-- The provider retries a delivery under a fresh delivery id, so the dedupe key is the webhook
-- configuration id plus the body hash, never the delivery id alone.
CREATE UNIQUE INDEX webhook_events_dedupe ON webhook_events (webhook_id, body_sha256);

-- Durable handoff from an accepted event to a Workflow instance. The webhook handler commits the
-- verified event and this row in one transaction, so a crash after the 200 cannot lose the work.
-- A row is terminal only after the expected Workflow instance was observed and recorded.
CREATE TABLE event_outbox (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('process_meeting', 'delete_meeting')),
	-- One work generation per (meeting, kind). Duplicate provider deliveries collapse onto the same
	-- row instead of starting a second Workflow.
	generation INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'handoff_pending', 'delivered', 'dead')),
	attempts INTEGER NOT NULL DEFAULT 0,
	workflow_instance_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (meeting_id, kind, generation)
);

CREATE INDEX event_outbox_by_status ON event_outbox (status, updated_at);

-- Ordered Plan 2 display-safe projection deliveries. D1 is authoritative; the projection is never
-- read back for a service decision. Revisions deliver in order per meeting, and a delete supersedes
-- everything older than itself.
CREATE TABLE projection_outbox (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('write', 'delete')),
	-- Bounded JSON document for a write. Empty string for a delete.
	payload TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'superseded')),
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (meeting_id, revision)
);

CREATE INDEX projection_outbox_by_status ON projection_outbox (status, updated_at);

-- One row per file Council writes into the workspace. `target_key` is the stable idempotency key a
-- replayed Workflow step reuses, so a crash between upload and record cannot double-write.
CREATE TABLE meeting_artifacts (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('track_audio', 'provider_transcript', 'transcript_markdown')),
	target_key TEXT NOT NULL,
	file_name TEXT NOT NULL,
	-- The workspace file node id, set when the upload committed. The delete workflow deletes by
	-- `target_key`; this id is for the page's file links.
	node_id TEXT,
	-- The exact create-target JSON body this artifact was minted with. The host answers a replay
	-- only for an identical body, so a replayed Workflow step re-sends this stored body instead of
	-- rebuilding one from fresh values.
	upload_body TEXT,
	bytes INTEGER,
	status TEXT NOT NULL CHECK (status IN ('pending', 'finalized', 'failed', 'deleted')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (meeting_id, target_key)
);

CREATE INDEX meeting_artifacts_by_meeting ON meeting_artifacts (meeting_id);

-- Verified provider presets. Transcription runs only when the participant's preset carries
-- `permissions.transcription_enabled: true`, and stock presets do not, so Council creates its own
-- and re-verifies them through the preset DETAIL endpoint (the list endpoint returns no
-- permissions at all, so a list-level null means "not read", not "absent").
CREATE TABLE provider_presets (
	role TEXT PRIMARY KEY CHECK (role IN ('host', 'guest')),
	preset_name TEXT NOT NULL,
	preset_id TEXT NOT NULL,
	verified_at INTEGER NOT NULL
);

-- Short-lived cache of one exchange result keyed by the hash of the presented page token, so a
-- burst of page calls does not mint one Convex service grant per call. Rows expire in minutes and
-- the cleanup pass deletes them.
CREATE TABLE page_token_cache (
	token_hash TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	installation_id TEXT NOT NULL,
	actor_user_id TEXT NOT NULL,
	service_grant_id TEXT NOT NULL REFERENCES service_grants (id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX page_token_cache_by_expiry ON page_token_cache (expires_at);
CREATE INDEX meeting_tickets_by_expiry ON meeting_tickets (expires_at);
CREATE INDEX room_sessions_by_expiry ON room_sessions (expires_at);
CREATE INDEX meeting_participants_by_created ON meeting_participants (created_at);
