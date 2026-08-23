import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const BEFORE_SUMMARY = [
	"0001_initial_schema.sql",
	"0002_concurrent_service_grants.sql",
	"0003_pipeline_state.sql",
	"0004_bind_host_sessions_to_grants.sql",
	"0005_drop_upload_reservations.sql",
];

function apply(db: DatabaseSync, files: string[]) {
	for (const fileName of files) {
		db.exec(readFileSync(`${MIGRATIONS_DIR}${fileName}`, "utf8"));
	}
}

function seed_meeting(db: DatabaseSync) {
	db.exec(`
		INSERT INTO service_grants (
			id, organization_id, workspace_id, installation_id, actor_user_id, principal_key,
			phase, token_encrypted, scopes, expires_at, created_at, updated_at
		) VALUES ('grant-1', 'org-1', 'ws-1', 'inst-1', 'user-1', 'principal-1',
			'interactive', 'encrypted', '[]', 1, 0, 0);
		INSERT INTO meetings (
			id, code_hash, organization_id, workspace_id, installation_id, plugin_name, title,
			created_by_user_id, service_grant_id, destination_path, status, created_at, updated_at
		) VALUES ('meeting-1', 'hash', 'org-1', 'ws-1', 'inst-1', 'council', 'Test',
			'user-1', 'grant-1', '/meetings/meeting-1', 'ready', 0, 0);
	`);
}

/**
 * Everything about `meeting_artifacts` that a hand-written table rebuild must carry over: the
 * columns, the cascade to `meetings`, and both indexes with the columns they cover. `index_list`
 * alone would still match if an index moved to another column, so read `index_info` too. Its `seq`
 * is only a creation counter and legitimately changes when an index is recreated, so drop it.
 */
function artifacts_shape(db: DatabaseSync) {
	const indexList = db.prepare("PRAGMA index_list(meeting_artifacts)").all() as unknown as {
		name: string;
		unique: number;
		origin: string;
		partial: number;
	}[];
	const indexes = indexList
		.map((index) => ({
			name: index.name,
			unique: index.unique,
			origin: index.origin,
			partial: index.partial,
			columns: (db.prepare(`PRAGMA index_info('${index.name}')`).all() as unknown as { name: string }[]).map(
				(column) => column.name,
			),
		}))
		.sort((left, right) => (left.name < right.name ? -1 : 1));

	return {
		columns: db.prepare("PRAGMA table_info(meeting_artifacts)").all(),
		foreignKeys: db.prepare("PRAGMA foreign_key_list(meeting_artifacts)").all(),
		indexes,
	};
}

describe("0006_summary_artifact.sql", () => {
	test("refuses legacy artifacts whose upload bodies cannot replay on the strict host", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, BEFORE_SUMMARY);
		seed_meeting(db);
		db.exec(`
			INSERT INTO meeting_artifacts (
				id, meeting_id, kind, target_key, file_name, node_id, upload_body, bytes, status,
				created_at, updated_at
			) VALUES ('artifact-1', 'meeting-1', 'transcript_markdown', 'transcript:1',
				'transcript.md', 'node-1', '{}', 123, 'finalized', 0, 0);
		`);

		expect(() => apply(db, ["0006_summary_artifact.sql"])).toThrow();
		expect(db.prepare("SELECT node_id, bytes, status FROM meeting_artifacts WHERE id = 'artifact-1'").get()).toEqual({
			node_id: "node-1",
			bytes: 123,
			status: "finalized",
		});
	});

	test("re-applies after the operator drains the artifacts it refused for", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, BEFORE_SUMMARY);
		seed_meeting(db);
		db.exec(`
			INSERT INTO meeting_artifacts (
				id, meeting_id, kind, target_key, file_name, node_id, upload_body, bytes, status,
				created_at, updated_at
			) VALUES ('artifact-1', 'meeting-1', 'transcript_markdown', 'transcript:1',
				'transcript.md', 'node-1', '{}', 123, 'finalized', 0, 0);
		`);
		expect(() => apply(db, ["0006_summary_artifact.sql"])).toThrow();

		// The refusal is a CHECK failing on the third statement, after the guard table is created. An
		// applier that runs a migration file statement by statement, as `node:sqlite` and `test/d1.ts`
		// do, therefore leaves that table behind. Assert it, because a run that rolled the whole file
		// back instead would let the retry below pass whatever the migration says.
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'migration_0006_empty_guard'").get()).toEqual({
			name: "migration_0006_empty_guard",
		});

		db.exec("DELETE FROM meeting_artifacts;");

		// The README tells the operator to drain the old artifacts and apply `0006` again. That retry
		// re-runs the whole file, so the migration has to survive its own leftover guard table. Its
		// first statement, `DROP TABLE IF EXISTS migration_0006_empty_guard`, is the only thing that
		// lets it.
		expect(() => apply(db, ["0006_summary_artifact.sql"])).not.toThrow();
	});

	test("adds the summary kind after the maintenance gate drains old artifacts", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, BEFORE_SUMMARY);
		seed_meeting(db);
		apply(db, ["0006_summary_artifact.sql"]);

		expect(() =>
			db.exec(`INSERT INTO meeting_artifacts (
				id, meeting_id, kind, target_key, file_name, status, created_at, updated_at
			) VALUES ('artifact-2', 'meeting-1', 'summary_markdown', 'summary:1', 'summary.md',
				'pending', 0, 0);`),
		).not.toThrow();
		expect(() =>
			db.exec(`INSERT INTO meeting_artifacts (
				id, meeting_id, kind, target_key, file_name, status, created_at, updated_at
			) VALUES ('artifact-3', 'meeting-1', 'unknown', 'unknown:1', 'unknown', 'pending', 0, 0);`),
		).toThrow();
	});

	test("rebuilds the table without losing a column, the cascade, or an index", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, BEFORE_SUMMARY);
		seed_meeting(db);
		const before = artifacts_shape(db);

		apply(db, ["0006_summary_artifact.sql"]);

		// The row copy proves nothing: the drain gate above forces the table empty before the rebuild
		// runs. What has to survive is the shape, and a dropped foreign key would leave orphan rows in
		// D1 that nothing cleans up.
		expect(artifacts_shape(db)).toEqual(before);
	});

	test("still refuses a second artifact for the same meeting and target key", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, [...BEFORE_SUMMARY, "0006_summary_artifact.sql"]);
		seed_meeting(db);
		const insert = (id: string) =>
			db.exec(`INSERT INTO meeting_artifacts (
				id, meeting_id, kind, target_key, file_name, status, created_at, updated_at
			) VALUES ('${id}', 'meeting-1', 'summary_markdown', 'summary:1', 'summary.md', 'pending', 0, 0);`);

		insert("artifact-1");
		// A replayed Workflow step resolves its upload by `target_key`; two rows for one key would
		// give the replay two answers.
		expect(() => insert("artifact-2")).toThrow();
	});
});

describe("0007_join_attempt_owner.sql", () => {
	test("adds a timestamped admission lease to an existing participant", () => {
		const db = new DatabaseSync(":memory:");
		apply(db, [...BEFORE_SUMMARY, "0006_summary_artifact.sql"]);
		seed_meeting(db);
		db.exec(`
			INSERT INTO meeting_participants (
				id, meeting_id, display_name, role, join_attempt_id, accepted_at, created_at
			) VALUES ('participant-1', 'meeting-1', 'Guest', 'guest', 'join-1', 1, 0);
		`);

		apply(db, ["0007_join_attempt_owner.sql"]);
		expect(
			db
				.prepare(
					"SELECT admission_attempt_id, admission_attempt_started_at FROM meeting_participants WHERE id = 'participant-1'",
				)
				.get(),
		).toEqual({ admission_attempt_id: null, admission_attempt_started_at: null });
	});
});

describe("0008_drop_dead_track_columns.sql", () => {
	/** A database with every migration before this one applied, one meeting, and one track row. */
	function seed_tracks_db() {
		const db = new DatabaseSync(":memory:");
		apply(db, [...BEFORE_SUMMARY, "0006_summary_artifact.sql", "0007_join_attempt_owner.sql"]);
		seed_meeting(db);
		db.exec(`
			INSERT INTO meeting_tracks (
				id, meeting_id, file_name, transcript_json, status, created_at, updated_at
			) VALUES ('track-1', 'meeting-1', 'council_prov-1_peer1_peer_audio_1755200000000.webm',
				'[]', 'transcribed', 0, 0);
		`);
		return db;
	}

	function track_columns(db: DatabaseSync) {
		return (db.prepare("PRAGMA table_info(meeting_tracks)").all() as unknown as { name: string }[]).map(
			(column) => column.name,
		);
	}

	test("removes both never-written columns and keeps the track row", () => {
		const db = seed_tracks_db();

		apply(db, ["0008_drop_dead_track_columns.sql"]);

		const columns = track_columns(db);
		expect(columns).not.toContain("participant_id");
		expect(columns).not.toContain("start_offset_ms");
		// The transcript is the only thing on this row the pipeline reads back, and a drop that
		// rewrote the table wrongly would take it with the columns.
		expect(
			db.prepare("SELECT file_name, status, transcript_json FROM meeting_tracks WHERE id = 'track-1'").get(),
		).toEqual({
			file_name: "council_prov-1_peer1_peer_audio_1755200000000.webm",
			status: "transcribed",
			transcript_json: "[]",
		});
	});

	test("still refuses a second track row for the same meeting and file name", () => {
		const db = seed_tracks_db();

		apply(db, ["0008_drop_dead_track_columns.sql"]);

		// `discover_tracks` inserts every discovered file with `INSERT OR IGNORE` on every poll
		// attempt, so losing this key would give one track file several rows and transcribe it twice.
		expect(() =>
			db.exec(`INSERT INTO meeting_tracks (
				id, meeting_id, file_name, status, created_at, updated_at
			) VALUES ('track-2', 'meeting-1', 'council_prov-1_peer1_peer_audio_1755200000000.webm',
				'discovered', 0, 0);`),
		).toThrow();
	});

	test("still deletes a meeting's tracks with the meeting", () => {
		const db = seed_tracks_db();

		apply(db, ["0008_drop_dead_track_columns.sql"]);
		db.exec("DELETE FROM meetings WHERE id = 'meeting-1';");

		// Losing the cascade would leave track rows, and their transcripts, behind in D1 after a
		// meeting row is gone, with nothing left that knows to clean them up.
		expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_tracks").get()).toEqual({ n: 0 });
	});
});
