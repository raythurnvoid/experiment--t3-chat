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
