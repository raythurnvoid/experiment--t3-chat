-- Bind each host room session to the exact interactive grant that minted its one-time ticket.
-- Picking the newest grant for the same actor is wrong when several plugin-page sessions overlap:
-- a newer dead grant can hide the still-live grant that authorized this room session.
--
-- Tickets and room cookies are short-lived handoff data. Clear them during this one-time rebuild
-- instead of guessing which old grant authorized a row that never stored that fact.

DROP INDEX meeting_tickets_by_expiry;
DROP TABLE meeting_tickets;

CREATE TABLE meeting_tickets (
	token_hash TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	actor_user_id TEXT NOT NULL,
	actor_service_grant_id TEXT NOT NULL REFERENCES service_grants (id) ON DELETE RESTRICT,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX meeting_tickets_by_expiry ON meeting_tickets (expires_at);

DROP INDEX room_sessions_by_expiry;
DROP INDEX room_sessions_by_meeting;
DROP TABLE room_sessions;

CREATE TABLE room_sessions (
	token_hash TEXT PRIMARY KEY,
	meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
	participant_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
	actor_service_grant_id TEXT REFERENCES service_grants (id) ON DELETE RESTRICT,
	csrf_token_hash TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	CHECK (
		(role = 'host' AND actor_service_grant_id IS NOT NULL) OR
		(role = 'guest' AND actor_service_grant_id IS NULL)
	)
);

CREATE INDEX room_sessions_by_meeting ON room_sessions (meeting_id);
CREATE INDEX room_sessions_by_expiry ON room_sessions (expires_at);
