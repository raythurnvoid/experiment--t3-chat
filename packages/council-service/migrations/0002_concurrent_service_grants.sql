-- The first migration allowed only one grant per installation. A workspace can have several
-- actor-bound grants at once, so keep one stable local row for each grant and point every meeting at
-- the exact row it uses. Both replaced tables are empty on the current deployment. Refuse this
-- clean-slate migration if that stops being true before it is applied.

CREATE TABLE migration_0002_empty_guard (
	row_count INTEGER NOT NULL CHECK (row_count = 0)
);

INSERT INTO migration_0002_empty_guard (row_count)
SELECT
	(SELECT COUNT(*) FROM meetings) +
	(SELECT COUNT(*) FROM meeting_participants) +
	(SELECT COUNT(*) FROM service_grants);

DROP TABLE migration_0002_empty_guard;

DROP INDEX meetings_by_installation;
DROP INDEX meetings_by_status_deadline;
DROP TABLE meetings;
DROP TABLE service_grants;

CREATE TABLE service_grants (
	-- Council generates this local id once. Token renewal updates this row and never changes the id.
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	installation_id TEXT NOT NULL,
	actor_user_id TEXT NOT NULL,
	-- Stable Convex producer identity. It stays the same when the raw token rotates.
	principal_key TEXT NOT NULL,
	phase TEXT NOT NULL CHECK (phase IN ('interactive', 'processing')),
	-- Null for the current interactive grant. A sealed file-write grant stores its exact prefix.
	destination_path_prefix TEXT,
	-- Encrypted with COUNCIL_ROOM_COOKIE_SECRET-derived key material. A D1 read alone is not the
	-- grant. Renewal replaces this value on the same local row.
	token_encrypted TEXT NOT NULL,
	scopes TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX service_grants_by_installation ON service_grants (installation_id, updated_at DESC);
CREATE INDEX service_grants_by_expiry ON service_grants (expires_at);

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
	-- exchange in the same installation must not replace this authority.
	service_grant_id TEXT NOT NULL REFERENCES service_grants (id) ON DELETE RESTRICT,
	-- Workspace folder the recording and transcript are written into.
	destination_path TEXT NOT NULL,
	provider_meeting_id TEXT,
	provider_session_id TEXT,
	provider_recording_id TEXT,
	-- created -> open -> closed -> processing -> ready|failed. `create_unknown` and
	-- `recording_start_unknown` mean a provider call was sent and its answer was lost; neither may be
	-- retried automatically, because the provider offers no idempotency key on either call.
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
			'expired'
		)
	),
	-- Set when the host opens the session. Admission closes at this time whatever else happens.
	deadline_at INTEGER,
	opened_at INTEGER,
	closed_at INTEGER,
	-- Accepted slots, not attempts. The 26th accepted participant is refused.
	participant_count INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX meetings_by_installation ON meetings (installation_id, created_at DESC);
CREATE INDEX meetings_by_status_deadline ON meetings (status, deadline_at);
