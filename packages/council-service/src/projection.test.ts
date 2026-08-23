import { describe, expect, test } from "vitest";

import { council_projection_value } from "./projection.ts";
import { council_get_meeting, type council_ArtifactRow } from "./db.ts";
import { make_test_env, seed_grant, seed_meeting } from "../test/env.ts";

/**
 * The stale operator text a redriven meeting still carries. `pipeline.ts` writes the message it
 * threw into `failure_reason`, and nothing ever clears the column, so a meeting that failed once
 * and was redriven back to `ready` keeps the old text. This one is shaped like a real value:
 * `failure_reason` there strips the error class and keeps the first 200 characters, so an internal
 * Convex route and an HTTP status survive into the column.
 */
const STALE_OPERATOR_REASON =
	"Upload target refused: Convex /api/v1/files/service-uploads/create-target returned HTTP 403: This workspace's plan does not include plugin service file storage";

/**
 * A seeded row, never a literal. The columns this projection must not copy exist only because the
 * meetings table has them, and `seed_meeting` fills every one of them with a real value: a real
 * hash of a real code, a real destination path, real provider ids, and a real grant id in both
 * grant columns. The update below adds the one column `seed_meeting` cannot set. So the document
 * below is measured against a row that really carries each secret. None of those values equals a
 * value the document is expected to carry, so copying any one of them into the document changes
 * what the test compares.
 */
async function seeded_meeting() {
	const { env } = make_test_env();
	await seed_grant(env);
	const seeded = await seed_meeting(env, {
		status: "ready",
		processingGrantId: "grant-1",
		providerSessionId: "sess-1",
		providerRecordingId: "rec-1",
		openedAt: 1000,
		closedAt: 2000,
		deadlineAt: 3000,
		participantCount: 2,
	});
	// `seed_meeting` cannot set this column, and a row with a null one would hide the leak this test
	// exists to catch: a projection that copied the column would still produce `null` here and pass.
	// A `ready` row carrying old text is the state a redrive really leaves behind.
	await env.COUNCIL_DB.prepare("UPDATE meetings SET failure_reason = ? WHERE id = ?")
		.bind(STALE_OPERATOR_REASON, seeded.id)
		.run();
	const meeting = await council_get_meeting(env.COUNCIL_DB, seeded.id);
	if (!meeting) {
		throw new Error("The seeded meeting is missing");
	}
	return meeting;
}

describe("council_projection_value", () => {
	test("carries the display fields and no value a member must not see", async () => {
		const meeting = await seeded_meeting();

		// This document is written into the host plugin-data store, where every workspace member can
		// read it, so what lands in it is the whole boundary. None of these columns may reach it:
		// `destination_path` names the workspace folder the files land in, `provider_meeting_id` /
		// `provider_session_id` / `provider_recording_id` address the provider's own meeting and its
		// recording, and `service_grant_id` / `processing_grant_id` name the grants that hold the
		// host's authority. `code_hash` may not reach it either, though it is only the stored hash of
		// the join code: joining needs the code itself, so the hash admits nobody on its own. And
		// `failure_reason` may not reach it, because it holds the message the pipeline threw, written
		// for an operator and naming internal Convex routes and HTTP statuses.
		//
		// The key names alone do not bound this. A forbidden column reaches the member through an
		// existing key just as easily as through a new one, and `createdBy: meeting.code_hash` leaves
		// the key set untouched. So pin every value. `seeded_meeting` gives each forbidden column a
		// value unlike any value expected here, so a swap like that changes one of the values below.
		// Pinning the values gives up nothing: `toStrictEqual` still fails on an added key, including
		// one whose value is `undefined`, so re-adding `failureReason` fails here too.
		expect(council_projection_value(meeting, [])).toStrictEqual({
			meetingId: "meeting-1",
			title: "Test meeting",
			status: "ready",
			createdBy: "user-1",
			createdAt: 0,
			openedAt: 1000,
			closedAt: 2000,
			deadlineAt: 3000,
			participantCount: 2,
			artifacts: [],
		});
	});

	test("lists only a finalized artifact that has a file node the page can open", async () => {
		const meeting = await seeded_meeting();
		const artifacts: Pick<council_ArtifactRow, "kind" | "node_id" | "file_name" | "status">[] = [
			{ kind: "transcript_markdown", node_id: "node-transcript", file_name: "transcript.md", status: "finalized" },
			// A finalized row with no node id names no file, so the page would render a link to
			// nothing. The pipeline writes the status and the node id in one statement, so this pair
			// is the type's doing, not a state a run produces.
			{ kind: "summary_markdown", node_id: null, file_name: "summary.md", status: "finalized" },
			// Still uploading. Its bytes are not committed yet, so the member must not be offered it.
			{ kind: "track_audio", node_id: "node-track", file_name: "alice.webm", status: "pending" },
		];

		expect(council_projection_value(meeting, artifacts).artifacts).toEqual([
			{ kind: "transcript_markdown", fileNodeId: "node-transcript", fileName: "transcript.md" },
		]);
	});
});
