// The later copy_transfer_file scopes tests, from the pinned media checks on, are in
// files_transfer_scopes_content.pinned.test.ts, so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import {
	mock_scope_copy_storage,
	fixture,
	save_proposal,
	copy_files,
	media_copy_source,
} from "./files_transfer_scopes_content.setup.test.ts";

beforeEach(mock_scope_copy_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("cross-workspace Move refusal", () => {
	test.each(["current", "personal"] as const)(
		"refuses a Move from %s before creating output",
		async (sourceWorkspace) => {
			const f = await fixture();
			const sourceId = await test_create_saved_text_file(f.t, {
				membershipId: f[sourceWorkspace].membershipId,
				path: "/source.txt",
				textContent: "Keep this source\n",
			});
			const before = await f.t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				holds: await ctx.db.query("files_private_storage_reservations").collect(),
				pendingNodes: await ctx.db.query("files_pending_nodes").collect(),
				pendingUpdates: await ctx.db.query("files_pending_updates").collect(),
				transferRuns: await ctx.db.query("files_transfer_runs").collect(),
				transferItems: await ctx.db.query("files_transfer_items").collect(),
				activities: await ctx.db.query("activities").collect(),
				invocationTransfers: await ctx.db.query("ai_chat_bash_invocation_transfers").collect(),
			}));
			const result = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				sourceWorkspace,
				destinationWorkspace: sourceWorkspace === "current" ? "personal" : "current",
				requestId: "refused-move",
				kind: "move",
				sources: [{ kind: "saved", id: sourceId }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "error" },
			});
			expect(result).toEqual({
				_nay: {
					name: "cross_workspace_move",
					message:
						"Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.",
				},
			});
			await f.t.run(async (ctx) => {
				expect(await ctx.db.query("files_nodes").collect()).toEqual(before.nodes);
				expect(await ctx.db.query("files_r2_assets").collect()).toEqual(before.assets);
				expect(await ctx.db.query("files_private_storage_reservations").collect()).toEqual(before.holds);
				expect(await ctx.db.query("files_pending_nodes").collect()).toEqual(before.pendingNodes);
				expect(await ctx.db.query("files_pending_updates").collect()).toEqual(before.pendingUpdates);
				expect(await ctx.db.query("files_transfer_runs").collect()).toEqual(before.transferRuns);
				expect(await ctx.db.query("files_transfer_items").collect()).toEqual(before.transferItems);
				expect(await ctx.db.query("activities").collect()).toEqual(before.activities);
				expect(await ctx.db.query("ai_chat_bash_invocation_transfers").collect()).toEqual(before.invocationTransfers);
			});
		},
	);
});

describe("complete folder Copy", () => {
	test("refuses an unreadable saved child before creating a private copy", async () => {
		const f = await fixture();
		const created = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "source/hidden-name",
		});
		if (created._nay) throw new Error(created._nay.message);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: created._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		const source = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/source",
		});
		if (!source) throw new Error("Missing source folder");
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "complete-folder",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 3; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const view = await f.asUser.query(api.files_transfer_queries.get, {
			membershipId: f.current.membershipId,
			runId: started._yay.runId,
		});
		expect(view).toMatchObject({
			activity: {
				status: "failed",
				progress: { completed: 0 },
				errorMessage: "Permission denied",
			},
		});
		expect(JSON.stringify(view)).not.toContain("hidden-name");
		await f.t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_nodes").collect()).toEqual([]);
			expect(await ctx.db.query("files_r2_assets").collect()).toEqual([]);
			expect((await ctx.db.get("files_nodes", created._yay.nodeId))?.archiveOperationId).toBeNull();
		});
	});

	// With 50 readable children the refusal comes on the second discovery page, after the first page
	// was already added to the manifest.
	test.each([1, 50])("refuses Retry after discovery stopped with %i readable children", async (readableCount) => {
		const f = await fixture();
		for (let index = 0; index < readableCount; index++) {
			const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.owner.userId,
				path: `/source/a${String(index).padStart(2, "0")}`,
			});
			if (created._nay) throw new Error(created._nay.message);
		}
		const hidden = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "source/zz-hidden",
		});
		if (hidden._nay) throw new Error(hidden._nay.message);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: hidden._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		const source = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/source",
		});
		if (!source) throw new Error("Missing source folder");
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "partial-discovery",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		const args = { membershipId: f.current.membershipId, runId: started._yay.runId };
		for (let step = 0; step < 10; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });

		expect(await f.asUser.query(api.files_transfer_queries.get, args)).toMatchObject({
			activity: { status: "failed", errorMessage: "Permission denied", progress: { total: null } },
			controls: { canRetry: false },
		});
		const before = await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect());
		expect(await f.asUser.mutation(api.files_transfer.retry_remaining, { ...args, requestId: "retry" })).toEqual({
			_nay: { message: "This Copy stopped before it found all its files. Start a new Copy instead." },
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.query("files_transfer_runs").collect()).toEqual(before);
			expect(await ctx.db.query("files_pending_nodes").collect()).toEqual([]);
		});
	});

	test("names a Move in the Retry refusal after it stopped before discovery", async () => {
		const f = await fixture();
		const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userId: f.owner.userId,
			path: "/source/a00",
		});
		if (created._nay) throw new Error(created._nay.message);
		const source = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/source",
		});
		if (!source) throw new Error("Missing source folder");
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "stopped-move",
			kind: "move",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "moved",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.current.membershipId, runId: started._yay.runId };
		expect(await f.asUser.mutation(api.files_transfer.stop, args)).toEqual({ _yay: null });
		for (let step = 0; step < 10; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });

		expect(await f.asUser.query(api.files_transfer_queries.get, args)).toMatchObject({
			activity: { progress: { total: null } },
			controls: { canRetry: false },
		});
		expect(await f.asUser.mutation(api.files_transfer.retry_remaining, { ...args, requestId: "retry" })).toEqual({
			_nay: { message: "This Move stopped before it found all its files. Start a new Move instead." },
		});
	});
});

describe("copy_transfer_file scopes", () => {
	test.each([
		["private", "new"],
		["private", "private"],
		["private", "saved"],
		["saved", "new"],
		["saved", "private"],
		["saved", "saved"],
	] as const)(
		"saves a copy of a copied %s document over a %s destination before its media",
		async (sourceKind, destination) => {
			const f = await fixture();
			const sources = await media_copy_source(f);
			if (sourceKind === "saved")
				await test_create_saved_text_file(f.t, {
					membershipId: f.personal.membershipId,
					path: "/document.md",
					textContent: "Original destination\n",
				});
			const first = await copy_files(f, { sources, sourceWorkspace: "current", destinationWorkspace: "personal" });
			expect(first.every((item) => item.state === "completed")).toBe(true);
			const source = first[0]!.outputTarget!;
			if (destination === "saved")
				await test_create_saved_text_file(f.t, {
					membershipId: f.personal.membershipId,
					path: "/second.md",
					textContent: "Keep saved content\n",
				});
			if (destination === "private")
				await copy_files(f, {
					sources: [source],
					sourceWorkspace: "personal",
					destinationWorkspace: "personal",
					targetName: "second.md",
				});
			const second = await copy_files(f, {
				sources: [source],
				sourceWorkspace: "personal",
				destinationWorkspace: "personal",
				targetName: "second.md",
			});
			expect(second[0]).toMatchObject({ state: "completed" });
			const target = second[0]!.outputTarget!;
			const read = (path: string, includePending: boolean) =>
				f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					organizationId: f.personal.organizationId,
					workspaceId: f.personal.workspaceId,
					userId: f.personal.userId,
					subject: { kind: "user", userId: f.personal.userId, plugin: null },
					overlayUserId: f.personal.userId,
					path,
					includePending,
				});
			const text = (await read("/document.md", true))?.content;
			expect(text).toContain("![Photo](");
			// A copied document saves like any other document. Its media draft is not saved yet.
			expect(await save_proposal({ f, workspace: "personal", target })).toHaveProperty("_yay");
			expect((await read("/second.md", false))?.content).toBe(text);
		},
	);
});
