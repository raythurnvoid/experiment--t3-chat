// Fixtures shared by the files_archive_runs.scope_budget test files.
import { R2 } from "@convex-dev/r2";
import { expect, vi } from "vitest";
import { activities_is_active } from "./activities_db.ts";
import { step, type Fixture } from "./files_archive_runs.setup.test.ts";
import { test_create_saved_text_file, test_fill_saved_file_with_max_chunks } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";

// Each test file calls this in `beforeEach`.
export function mock_scope_budget_storage() {
	vi.useFakeTimers();
	const objects = new Map<string, string | ArrayBuffer>();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		objects.delete(key);
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey) => {
		const key = customKey ?? crypto.randomUUID();
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (path.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(path.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			if (!path.startsWith("https://r2.test/object?key=")) return new Response(null, { status: 404 });
			const body = objects.get(decodeURIComponent(path.slice("https://r2.test/object?key=".length)));
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
}

/** A folder 3 levels deep, so a file in it with a 252-char name has the longest path. */
export const DEEP_FOLDER = `/${["0", "1", "2"].map((digit) => digit.repeat(files_NAME_MAX_LENGTH)).join("/")}`;
export const TOP_FOLDER = DEEP_FOLDER.slice(0, files_NAME_MAX_LENGTH + 1);

export function deep_path(letter: string) {
	const path = `${DEEP_FOLDER}/${letter.repeat(files_NAME_MAX_LENGTH - 3)}.md`;
	expect(path).toHaveLength(files_PATH_MAX_LENGTH);
	return path;
}

/**
 * Saved files, each with about 3,000 chunks. With `fill: false` they stay small: call
 * `fill_max_chunks` later.
 */
export async function max_files(f: Fixture, paths: string[], options: { head?: string; fill?: boolean } = {}) {
	const nodeIds: Array<Id<"files_nodes">> = [];
	for (const path of paths) {
		nodeIds.push(await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path, textContent: "x" }));
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	}
	if (options.fill !== false) await fill_max_chunks(f, nodeIds, options.head);
	return nodeIds;
}

export async function fill_max_chunks(f: Fixture, nodeIds: Array<Id<"files_nodes">>, head?: string) {
	for (const nodeId of nodeIds)
		expect(await test_fill_saved_file_with_max_chunks(f.t, nodeId, head)).toBeGreaterThan(2900);
}

/**
 * Run the steps of an Archive or Restore job until it ends or waits. Returns the activity status.
 * A job that ended in the user's call returns no job.
 *
 * Not `run_to_end`: its `expect_consistent` reads every chunk of every file in one transaction, more
 * than these max-size files fit in.
 */
export async function step_job_to_end(
	f: Fixture,
	job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> } | null,
) {
	let status = "succeeded";
	for (let count = 0; job && count < 100; count++) {
		await step(f, job.runId);
		status = (await f.t.run((ctx) => ctx.db.get("activities", job.activityId)))!.status;
		if (!activities_is_active(status as never) || status === "awaiting_input") break;
	}
	return status;
}

/**
 * Run every scheduled job, like the jobs that copy the node's scope onto its docs. convex-test keeps a
 * failed scheduled job as a row and does not throw, so check the rows.
 */
export async function finish_all_jobs(f: Fixture) {
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const failed = await f.t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "failed"),
	);
	expect(failed.map((job) => [job.name, job.state])).toEqual([]);
}

/**
 * When all jobs are done, every saved chunk and metadata doc says the same as its node. One read per
 * file: all chunks of one file fit in one transaction.
 */
export async function expect_side_docs_follow(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	for (const nodeId of nodeIds) {
		const mismatches = await f.t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const sideDocs = [
				...(await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("organizationId", node.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", nodeId),
					)
					.collect()),
				...(await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
						q.eq("organizationId", node.organizationId).eq("workspaceId", node.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect()),
			].filter((doc) => doc.sourceKind === "committed");
			return sideDocs
				.filter((doc) => (doc.archiveOperationId ?? null) !== node.archiveOperationId || doc.path !== node.path)
				.map((doc) => ({
					table: "fieldPath" in doc ? "metadata" : "chunk",
					archiveOperationId: doc.archiveOperationId ?? null,
				}))
				.slice(0, 3);
		});
		expect(mismatches).toEqual([]);
	}
}
