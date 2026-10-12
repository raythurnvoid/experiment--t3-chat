import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import {
	mark_copied,
	finish_review,
	fixture,
	mock_review_storage,
	private_media,
	private_node,
	saved_text,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("review job content", () => {
	// The mock database makes these large cases slow.
	test("saves more than 100 Copy media before its document and keeps one unit per output", async () => {
		const f = await fixture();
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		const images = [];
		// 101 media and the document need 2 selection pages of 100, 5 media
		// validation pages of 25, and 13 plan pages of 8.
		for (let index = 0; index < 101; index++)
			images.push(await private_media({ f, path: `/image-${index}.png`, sourceId: source._yay.nodeId }));
		const text = images.map(({ src }) => `![Image](${src})`).join("\n\n") + "\n";
		const document = await mark_copied({
			f,
			pending: await private_node({ f, path: "/document.md", text }),
			sourceId: source._yay.nodeId,
		});
		const runId = await start_review({ f, proposals: [document, ...images.map(({ pending }) => pending)] });
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units).toHaveLength(102);
		expect(units.every((unit) => unit.kind === "cohort" && unit.itemCount === 1)).toBe(true);
		expect(units.find((unit) => unit.order === 0)).toMatchObject({
			status: "waiting",
			remainingPrerequisiteCount: 101,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect())).toHaveLength(101);
		const result = await finish_review({ f, runId, stepMs: 1_200 });
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 102 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved).toHaveLength(103);
		expect(await saved_text(f, saved.find((node) => node.path === "/document.md")!._id)).toBe(text);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(102);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		const documentUnit = await f.t.run((ctx) =>
			ctx.db.get("files_pending_update_run_units", units.find((unit) => unit.order === 0)!._id),
		);
		if (!documentUnit?.cohortId) throw new Error("Expected the completed document group");
		const content = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_proposal", (q) =>
					q.eq("cohortId", documentUnit.cohortId!).eq("pendingUpdateId", document._id),
				)
				.unique(),
		);
		expect(content?.mediaProof).toMatchObject({
			reviewedRevision: document.revision,
			selectedContentStateId: document.content?.unstagedStateId,
			expectedCount: 101,
			validatedCount: 101,
			sealed: true,
		});
	}, 10_800_000);
});
