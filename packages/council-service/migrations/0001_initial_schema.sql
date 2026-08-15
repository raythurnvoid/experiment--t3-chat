-- Council's authoritative state. The Plan 2 document store holds a display-safe projection of
-- some of this, but a projection is never read back as the source of truth for a service decision.
--
-- No plaintext guest email is stored anywhere in this file. The join route keeps a keyed HMAC for two
-- hours so a retried join is recognized, and nothing else.

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

CREATE TABLE meeting_participants (
	-- The durable participant id Council generates and sends as `custom_participant_id`.
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	display_name TEXT NOT NULL,
	-- Keyed HMAC of the normalized email, kept only so a retried join is recognized as the same
	-- person. Cleared by the cleanup pass two hours after the join.
	email_hmac TEXT,
	role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
	-- The client's own attempt id. It plus the meeting is what makes a replayed join idempotent.
	join_attempt_id TEXT NOT NULL,
	-- Add Participant returns this separate `data.id`. Track filenames carry this provider id, so it
	-- is the lookup key that maps a track back to the durable `id` above.
	provider_participant_id TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (meeting_id, join_attempt_id)
);

CREATE INDEX meeting_participants_by_meeting ON meeting_participants (meeting_id);

-- One-time handoff from the members-only plugin page to the room origin. The page never sends the
-- member's own session anywhere; it sends this instead, and the room trades it for a room cookie.
CREATE TABLE meeting_tickets (
	token_hash TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	actor_user_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	-- Set by the one UPDATE that claims the ticket. A second POST finds it already set and is refused,
	-- so two parallel consumes cannot both win.
	consumed_at INTEGER,
	created_at INTEGER NOT NULL
);

-- The `__Host-` cookie session the room runs on, for a host or a guest.
CREATE TABLE room_sessions (
	token_hash TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	participant_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
	-- Sent to the page in the body and echoed back in a header on every state-changing call, so a
	-- cross-site form post carrying the cookie still fails.
	csrf_token_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX room_sessions_by_meeting ON room_sessions (meeting_id);

-- The `psg_` service grant Council exchanged its page token for, one per installation.
CREATE TABLE service_grants (
	installation_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	-- Encrypted with COUNCIL_ROOM_COOKIE_SECRET-derived key material. A D1 read alone is not the
	-- grant.
	token_encrypted TEXT NOT NULL,
	scopes TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- One row per verified webhook body. The provider retries, and it changes the delivery id when it
-- does, so the key is the body hash and the configuration id together, never the delivery id alone.
CREATE TABLE webhook_events (
	id TEXT PRIMARY KEY,
	webhook_id TEXT NOT NULL,
	body_sha256 TEXT NOT NULL,
	event_type TEXT NOT NULL,
	meeting_id TEXT,
	received_at INTEGER NOT NULL,
	handled_at INTEGER
);

CREATE INDEX webhook_events_by_meeting ON webhook_events (meeting_id);

-- One row per downloaded per-participant audio track.
CREATE TABLE meeting_tracks (
	id TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	file_name TEXT NOT NULL,
	-- The durable Council participant id, set only after the provider id parsed from `file_name`
	-- matches `meeting_participants.provider_participant_id`. An unknown provider id leaves this null,
	-- and that track never reaches the transcript.
	participant_id TEXT,
	-- Milliseconds to add to this track's own times to put them on the meeting clock. A track starts
	-- when its participant joined, not when the recording started.
	start_offset_ms INTEGER,
	transcript_json TEXT,
	status TEXT NOT NULL CHECK (status IN ('discovered', 'transcribed', 'rejected')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (meeting_id, file_name)
);

CREATE INDEX meeting_tracks_by_meeting ON meeting_tracks (meeting_id);

-- Fixed-window counters for the public join route. The window start is part of the key, so an expired
-- window is a different row and the cleanup pass deletes it rather than resetting it.
CREATE TABLE rate_limit_windows (
	bucket_key TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX rate_limit_windows_by_window ON rate_limit_windows (window_start);
