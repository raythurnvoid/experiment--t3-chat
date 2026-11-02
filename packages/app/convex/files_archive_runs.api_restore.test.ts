// The public API `files/restore` tests. The route starts the same restore job as Restore in the app.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { restore_items } from "./public_api_files_organize.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_db_hold_move_slot, test_mocks, test_rename_node, test_spy_handler } from "./setup.test.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { test_run_with_flush } from "./setup.test.ts";
import {
	fixture,
	add_member,
	seed_tree,
	seed_same_path,
	read_activity,
	run_to_end,
	archive,
	archive_to_end,
	folder,
	read_node,
	restore,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";

// A check step reads at most 100 nodes here instead of 500, and a request at most 50 instead of 100, so
// small trees cross them. The mock puts this file in the isolated "Convex" project.
vi.mock("../server/files-archive-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-archive-runs.ts")>()),
	files_archive_runs_CHECK_STEP_MAX_NODES: 100,
	files_archive_runs_REQUEST_MAX_CHECK_NODES: 50,
}));

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function create_key(args: { asUser: Fixture["asOwner"]; membershipId: Id<"organizations_workspaces_users"> }) {
	// Key creation has a small rate bucket. Let it refill first.
	vi.advanceTimersByTime(60_000);
	const created = await args.asUser.mutation(api.public_api.api_credential_create, {
		serviceAccountId: null,
		membershipId: args.membershipId,
		name: "Restore key",
		scopes: ["files:list", "files:write"],
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay;
}

async function create_owner_key(f: Fixture) {
	// Only a Clerk account can make a key.
	await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-restore-key-owner" }));
	return await create_key({ asUser: f.asOwner, membershipId: f.db.membershipId });
}

async function post(f: Fixture, route: string, credential: string, body: unknown) {
	const response = await f.t.fetch(route, {
		method: "POST",
		headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function insert_root_file(f: Fixture, args: { name: string; archiveOperationId: string | null }) {
	return await test_run_with_flush(f.t, (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
			parentId: "root",
			name: args.name,
			sortName: files_sort_text_key(args.name),
			kind: "file",
			path: `/${args.name}`,
			treePath: `/${args.name}`,
			pathDepth: 1,
			archiveOperationId: args.archiveOperationId,
			...(args.archiveOperationId !== null ? { archivedPath: `/${args.name}` } : {}),
		}),
	);
}

describe("files/restore", () => {
	test.each(["app", "paths", "nodes"] as const)("%s restores only the selected file from one delete", async (mode) => {
		const f = await fixture();
		const key = mode === "app" ? null : await create_owner_key(f);
		const ids = [];
		for (const name of ["a.md", "b.md", "c.md"]) {
			ids.push(await insert_root_file(f, { name, archiveOperationId: null }));
		}
		expect(await archive(f, ids)).toEqual({ _yay: null });
		const operationId = (await read_node(f, ids[1]!)).archiveOperationId!;
		const body = {
			...(mode === "nodes" ? { nodes: [{ nodeId: ids[1], archiveOperationId: operationId }] } : { paths: ["/b.md"] }),
			requestId: "one-file",
		};
		const result = key ? await post(f, "/api/v1/files/restore", key.credential, body) : null;
		if (!key) await restore(f, [ids[1]!]);

		expect(
			await Promise.all(ids.map(async (id) => (await read_node(f, id)).archiveOperationId)),
			"only the selected file comes back",
		).toEqual([operationId, null, operationId]);
		if (key && result) {
			expect(await post(f, "/api/v1/files/restore", key.credential, body)).toEqual(result);
			expect(
				await post(f, "/api/v1/files/jobs/get", key.credential, { jobId: (result.body.jobIds as string[])[0] }),
			).toMatchObject({
				status: 200,
				body: { status: "succeeded", progress: { completed: 1 }, refused: [] },
			});
		}
	});

	test.each(["app", "paths", "nodes"] as const)(
		"%s restores only the selected folder and merges overlapping roots",
		async (mode) => {
			const f = await fixture();
			const key = mode === "app" ? null : await create_owner_key(f);
			const tree = await seed_tree(f, { name: "selected", folderCount: 2, filesPerFolder: 55 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			const olderOperation = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
			await archive_to_end(f, tree.topId);
			const operationId = (await read_node(f, tree.topId)).archiveOperationId!;
			const selectedIds = [tree.fileIds[1]!, tree.folderIds[0]!];
			let job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> };
			if (key) {
				const body = {
					...(mode === "nodes"
						? { nodes: selectedIds.map((nodeId) => ({ nodeId, archiveOperationId: operationId })) }
						: { paths: ["/selected/d0/f001.md", "/selected/d0"] }),
					requestId: "one-folder",
				};
				const response = await post(f, "/api/v1/files/restore", key.credential, body);
				expect(response).toMatchObject({ status: 200, body: { isDone: false, refused: [] } });
				expect(await post(f, "/api/v1/files/restore", key.credential, body)).toEqual(response);
				const activityId = (response.body.jobIds as Array<Id<"activities">>)[0]!;
				job = { runId: (await read_activity(f, activityId)).source.id as Id<"files_archive_runs">, activityId };
			} else {
				const response = await restore(f, selectedIds);
				expect(response._nay).toBeUndefined();
				job = response._yay!;
			}
			const ended = await run_to_end(f, job);
			expect((await read_node(f, tree.topId)).archiveOperationId, "unselected parent stays in Trash").toBe(operationId);
			expect((await read_node(f, tree.folderIds[1]!)).archiveOperationId).toBe(operationId);
			expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).toBe(operationId);
			// The folder comes back at its Trash path, in a new `/selected`.
			const restored = await read_node(f, tree.folderIds[0]!);
			expect(restored).toMatchObject({ archiveOperationId: null, path: "/selected/d0" });
			expect(restored.parentId).not.toBe(tree.topId);
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(olderOperation);
			expect((await read_node(f, tree.fileIds[54]!)).archiveOperationId).toBeNull();
			expect(ended.activity.progress).toMatchObject({ total: 55, completed: 55 });
		},
	);

	test.each([false, true])("equal-path folder selections keep their root ids (both: %s)", async (both) => {
		const f = await fixture();
		const key = await create_owner_key(f);
		const operationId = crypto.randomUUID();
		const roots = [];
		const children = [];
		for (const name of ["first.md", "second.md"]) {
			const rootId = await insert_root_file(f, { name: "same", archiveOperationId: operationId });
			const childId = await insert_root_file(f, { name, archiveOperationId: operationId });
			await test_run_with_flush(f.t, async (ctx) => {
				await ctx.db.patch("files_nodes", rootId, { kind: "folder", treePath: "/same/" });
				await ctx.db.patch("files_nodes", childId, {
					parentId: rootId,
					path: `/same/${name}`,
					treePath: `/same/${name}`,
					pathDepth: 2,
				});
			});
			roots.push(rootId);
			children.push(childId);
		}
		const selected = both ? roots : [roots[0]!];
		const response = await post(f, "/api/v1/files/restore", key.credential, {
			nodes: selected.map((nodeId) => ({ nodeId, archiveOperationId: operationId })),
			requestId: "equal-folders",
		});
		expect((await read_node(f, roots[1]!)).archiveOperationId, "only selected folder ids come back").toBe(
			both ? null : operationId,
		);
		const jobId = (response.body.jobIds as string[])[0]!;
		expect(
			await post(f, "/api/v1/files/jobs/get", key.credential, { jobId }),
			"overlapping folder ranges count each item once",
		).toMatchObject({
			status: 200,
			body: { status: "succeeded", progress: { total: both ? 4 : 3, completed: both ? 4 : 3 }, refused: [] },
		});
		expect((await read_node(f, roots[0]!)).archiveOperationId).toBeNull();
		expect(await Promise.all(children.map(async (id) => (await read_node(f, id)).archiveOperationId))).toEqual([
			null,
			null,
		]);
	});

	test.each(["paths", "nodes"] as const)("%s previews only the selected item", async (mode) => {
		const f = await fixture();
		const key = await create_owner_key(f);
		const operationId = crypto.randomUUID();
		const selectedId = await insert_root_file(f, { name: "a.md", archiveOperationId: operationId });
		await insert_root_file(f, { name: "b.md", archiveOperationId: operationId });
		const selection =
			mode === "nodes" ? { nodes: [{ nodeId: selectedId, archiveOperationId: operationId }] } : { paths: ["/a.md"] };
		const preview = await post(f, "/api/v1/files/restore", key.credential, { ...selection, dryRun: true });
		expect(preview, "the preview counts only the selected item").toMatchObject({
			status: 200,
			body: {
				dryRun: true,
				complete: true,
				jobs: [
					expect.objectContaining({
						status: "succeeded",
						progress: expect.objectContaining({ total: 1, completed: 1 }),
					}),
				],
			},
		});
	});

	test.each(["succeeded", "failed"] as const)(
		"a %s restore does not report an unselected item after later renames",
		async (status) => {
			const f = await fixture();
			const key = await create_owner_key(f);
			const selected = await seed_tree(f, { name: "old", folderCount: 1, filesPerFolder: 1 });
			const other = await seed_tree(f, { name: "other", folderCount: 1, filesPerFolder: 1 });
			const archived = await archive(f, [selected.folderIds[0]!, other.fileIds[0]!]);
			if (archived._yay) await run_to_end(f, archived._yay);
			const restored = await post(f, "/api/v1/files/restore", key.credential, {
				paths: ["/old/d0"],
				requestId: "renamed-selection",
			});
			const jobId = (restored.body.jobIds as Array<Id<"activities">>)[0]!;
			if (status === "failed") {
				// A stopped job can already have restored its selected folder.
				await f.t.run((ctx) => ctx.db.patch("activities", jobId, { status }));
			}
			for (const [nodeId, path] of [
				[selected.folderIds[0]!, "/done"],
				[other.topId, "/old/d0"],
			] as const) {
				expect(
					(await test_rename_node(f.t, f.asOwner, { membershipId: f.db.membershipId, nodeId, path }))._nay,
				).toBeUndefined();
			}
			expect((await read_node(f, other.fileIds[0]!)).path).toBe("/old/d0/d0/f000.md");
			expect(
				await post(f, "/api/v1/files/jobs/get", key.credential, { jobId }),
				"later renames never add an unselected item to the job",
			).toMatchObject({ status: 200, body: { status, refused: [] } });
		},
	);

	test("jobs/get finds an unfinished selected child in the published Move view", async () => {
		const f = await fixture();
		const key = await create_owner_key(f);
		const tree = await seed_tree(f, { name: "old", folderCount: 1, filesPerFolder: 1 });
		await archive_to_end(f, tree.topId);
		const archiveOperationId = (await read_node(f, tree.topId)).archiveOperationId!;
		const restored = await post(f, "/api/v1/files/restore", key.credential, {
			paths: ["/old/d0"],
			requestId: "moved-recovery",
		});
		const jobId = (restored.body.jobIds as Array<Id<"activities">>)[0]!;
		// Keep a child in Trash, as when a job stops after landing its folder.
		await test_run_with_flush(f.t, async (ctx) => {
			await ctx.db.patch("activities", jobId, { status: "failed" });
			await ctx.db.patch("files_nodes", tree.fileIds[0]!, { archiveOperationId, archivedPath: "/old/d0/f000.md" });
		});
		await f.t.run(async (ctx) => {
			const cohortId = await test_db_hold_move_slot(ctx, f.db);
			for (const nodeId of [tree.folderIds[0]!, tree.fileIds[0]!]) {
				const {
					_id,
					_creationTime,
					createdBy: _createdBy,
					readOnly: _readOnly,
					readOnlyDecisionId: _readOnlyDecisionId,
					moveCohortId: _moveCohortId,
					scopeOpId: _scopeOpId,
					...header
				} = (await ctx.db.get("files_nodes", nodeId))!;
				const place = {
					...header,
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					cohortId,
					nodeId,
					nodeCreationTime: _creationTime,
					contentId: null,
				};
				await ctx.db.insert("files_saved_places", { ...place, view: "before" });
				await ctx.db.insert("files_saved_places", {
					...place,
					view: "after",
					path: header.path.replace("/d0", "/done"),
					treePath: header.treePath.replace("/d0/", "/done/"),
					name: header.kind === "folder" ? "done" : header.name,
					sortName: files_sort_text_key(header.kind === "folder" ? "done" : header.name),
				});
				await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
			}
			await ctx.db.patch("files_move_cohorts", cohortId, { visibleView: "after", publishedAt: Date.now() });
			const slot = (await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique())!;
			await ctx.db.patch("files_move_workspace_slots", slot._id, { visibleView: "after" });
		});
		expect(
			await post(f, "/api/v1/files/jobs/get", key.credential, { jobId }),
			"recovery names the selected child at its published Move path",
		).toMatchObject({ status: 200, body: { status: "failed", refused: [{ path: "/old/done/f000.md" }] } });
	});

	test("restores what it can and refuses each bad path alone", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const kept = await seed_tree(f, { name: "kept", folderCount: 1, filesPerFolder: 1 });
		await archive_to_end(f, kept.topId);
		const soloId = await insert_root_file(f, { name: "solo.md", archiveOperationId: crypto.randomUUID() });
		// Two deleted files with the same path, each from its own delete.
		await seed_same_path(f, { name: "twice", count: 2, archiveOperationId: null });
		await folder(f, "/active");

		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, {
				paths: ["/kept/d0/f000.md", "/kept", "/solo.md", "/twice/same.md", "/active", "/missing.md"],
				requestId: "refusals",
			}),
		).toEqual({
			status: 200,
			body: {
				// One job per delete. The first two paths are from one delete, so one job brings back the folder.
				jobIds: [expect.any(String), expect.any(String)],
				isDone: true,
				refused: [
					{
						path: "/twice/same.md",
						message:
							"Several deleted items have this path. Find the one you want in files/trash/list and restore it by nodes.",
					},
					{ path: "/active", message: "Not in the Trash" },
					{ path: "/missing.md", message: "Not found" },
				],
			},
		});
		expect((await read_node(f, kept.topId)).archiveOperationId).toBeNull();
		expect((await read_node(f, kept.fileIds[0]!)).archiveOperationId).toBeNull();
		expect((await read_node(f, soloId)).archiveOperationId).toBeNull();

		// Restricted files that a member cannot open are locked for the member's key. There are two, so a
		// locked path must not tell that several deleted items have it.
		for (let index = 0; index < 2; index++) {
			const lockedId = await insert_root_file(f, { name: "hidden.md", archiveOperationId: crypto.randomUUID() });
			await f.t.run((ctx) =>
				ctx.db.patch("files_nodes", lockedId, {
					restrictedScopeNodeId: lockedId,
					isRestrictedScopeRoot: true,
					parentScopeNodeId: null,
				}),
			);
		}
		const member = await add_member(f);
		await f.t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			}),
		);
		const memberKey = await create_key({ asUser: member.asUser, membershipId: member.membershipId });
		expect(
			await post(f, "/api/v1/files/restore", memberKey.credential, { paths: ["/hidden.md"], requestId: "locked" }),
		).toEqual({
			status: 200,
			body: { jobIds: [], isDone: true, refused: [{ path: "/hidden.md", message: "Permission denied" }] },
		});

		// Control: the owner passes every check, so the owner's key sees both items.
		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, { paths: ["/hidden.md"], requestId: "owner" }),
		).toMatchObject({
			status: 200,
			body: {
				refused: [
					{
						path: "/hidden.md",
						message:
							"Several deleted items have this path. Find the one you want in files/trash/list and restore it by nodes.",
					},
				],
			},
		});
	});

	test("a retry with the same requestId answers the same jobs and restores nothing again", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		await f.t.run((ctx) =>
			ctx.db.patch("api_credentials", ownerKey.credentialId, {
				scopes: ["files:list", "files:write", "files:read-only"],
			}),
		);
		const tree = await seed_tree(f, { name: "again", folderCount: 1, filesPerFolder: 1 });
		await archive_to_end(f, tree.topId);
		const body = { paths: ["/again"], requestId: "retry" };

		const first = await post(f, "/api/v1/files/restore", ownerKey.credential, body);
		expect(first).toEqual({ status: 200, body: { jobIds: [expect.any(String)], isDone: true, refused: [] } });
		const run = await f.t.run((ctx) =>
			ctx.db
				.query("files_archive_runs")
				.withIndex("by_user_workspace_apiRequest", (q) =>
					q
						.eq("userId", f.db.userId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("apiRequest.requestId", `api:${ownerKey.credentialId}:retry`),
				)
				.unique(),
		);
		expect(run?.apiRequest?.inputHash).toBe(await crypto_sha256_hex(JSON.stringify([body.paths, "keep_both"])));
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();

		// Delete the folder again. A late retry must not bring it back a second time.
		await archive_to_end(f, tree.topId);
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, body)).toEqual(first);
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, { ...body, force: false })).toEqual(first);
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, { ...body, force: true })).toEqual({
			status: 409,
			body: { message: "This requestId was already used for another request. Send a new requestId." },
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, { ...body, onConflict: "skip" })).toEqual({
			status: 409,
			body: { message: "This requestId was already used for another request. Send a new requestId." },
		});

		const jobId = (first.body.jobIds as string[])[0];
		expect(await post(f, "/api/v1/files/jobs/get", ownerKey.credential, { jobId })).toMatchObject({
			status: 200,
			body: { jobId, kind: "restore", status: "succeeded", refused: [] },
		});
	});

	test("a restore job stops at its next step once its key is revoked", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		// More nodes than the request checks, so the job goes on in the background.
		const tree = await seed_tree(f, { name: "big", folderCount: 2, filesPerFolder: 48 });
		await archive_to_end(f, tree.topId);

		const response = await post(f, "/api/v1/files/restore", ownerKey.credential, {
			paths: ["/big"],
			requestId: "revoke",
		});
		expect(response).toMatchObject({ status: 200, body: { isDone: false, refused: [] } });
		const jobId = (response.body.jobIds as Array<Id<"activities">>)[0]!;
		const activity = await read_activity(f, jobId);
		// While the job runs, the items it has not reached yet are not left behind, so no path is named.
		expect(await post(f, "/api/v1/files/jobs/get", ownerKey.credential, { jobId })).toMatchObject({
			status: 200,
			body: { status: "running", refused: [] },
		});

		// Revoke stamps `revokedAt`. The key mutations allow only two changes in a row, so stamp it here.
		await f.t.run((ctx) => ctx.db.patch("api_credentials", ownerKey.credentialId, { revokedAt: Date.now() }));
		const ended = await run_to_end(f, { runId: activity.source.id as Id<"files_archive_runs">, activityId: jobId });

		// The owner still writes everything, so only the revoked key stops the job.
		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage: "The API key that started this job was revoked or lost a required file scope.",
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("a restore stops with the reason where the app would ask about a name clash", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const archivedId = await insert_root_file(f, { name: "clash.md", archiveOperationId: crypto.randomUUID() });
		// The name and every name Keep both tries are taken.
		await insert_root_file(f, { name: "clash.md", archiveOperationId: null });
		for (let counter = 2; counter <= 100; counter++) {
			await insert_root_file(f, { name: `clash-${counter}.md`, archiveOperationId: null });
		}

		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, { paths: ["/clash.md"], requestId: "clash" }),
		).toEqual({
			status: 200,
			body: {
				jobIds: [],
				isDone: true,
				refused: [
					{
						path: "/clash.md",
						message:
							'"clash.md" clashes with an item in the folder it comes back to, and Keep both found no name that fits. Rename or move that item, then restore again.',
					},
				],
			},
		});
		expect((await read_node(f, archivedId)).archiveOperationId).not.toBeNull();
	});

	test("jobs/get names each item that Keep both renamed or Skip left in the Trash", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		// A full jobs/get page still needs its final empty continuation.
		const archiveOperationId = crypto.randomUUID();
		const paths = [];
		for (let index = 0; index < 100; index++) {
			const name = `c${String(index).padStart(3, "0")}.md`;
			await insert_root_file(f, { name, archiveOperationId });
			await insert_root_file(f, { name, archiveOperationId: null });
			paths.push(`/${name}`);
		}

		const response = await post(f, "/api/v1/files/restore", ownerKey.credential, {
			paths,
			requestId: "renamed",
		});
		const jobId = (response.body.jobIds as Array<Id<"activities">>)[0]!;
		const runId = (await read_activity(f, jobId)).source.id as Id<"files_archive_runs">;
		await run_to_end(f, { runId, activityId: jobId });

		const firstPage = await post(f, "/api/v1/files/jobs/get", ownerKey.credential, { jobId });
		expect(firstPage).toMatchObject({
			status: 200,
			body: { status: "succeeded", refused: [], refusedCursor: expect.any(String) },
		});
		expect(firstPage.body.renamed).toHaveLength(100);
		const secondPage = await post(f, "/api/v1/files/jobs/get", ownerKey.credential, {
			jobId,
			cursor: firstPage.body.refusedCursor,
		});
		expect(secondPage).toMatchObject({ status: 200, body: { refused: [], refusedCursor: null } });
		const renamed = [...(firstPage.body.renamed as unknown[]), ...(secondPage.body.renamed as unknown[])];
		expect(renamed).toHaveLength(100);
		expect(new Set(renamed.map((item) => JSON.stringify(item))).size).toBe(100);
		expect(renamed).toContainEqual({ path: "/c099.md", newPath: "/c099-2.md" });

		// Skip leaves the item in the Trash, and the job names the path it keeps there. Its Trash path is
		// `/kept.md`, so it would land at the root, next to an item with its name.
		const skippedId = await insert_root_file(f, { name: "kept.md", archiveOperationId: crypto.randomUUID() });
		const goneFolderId = await folder(f, "/gone");
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_nodes", goneFolderId);
			await ctx.db.patch("files_nodes", skippedId, {
				parentId: goneFolderId,
				path: "/gone/kept.md",
				treePath: "/gone/kept.md",
				pathDepth: 2,
			});
		});
		await insert_root_file(f, { name: "kept.md", archiveOperationId: null });
		const skipped = await post(f, "/api/v1/files/restore", ownerKey.credential, {
			paths: ["/gone/kept.md"],
			onConflict: "skip",
			requestId: "skipped",
		});
		expect(skipped).toMatchObject({ status: 200, body: { isDone: true, refused: [] } });
		expect(
			await post(f, "/api/v1/files/jobs/get", ownerKey.credential, {
				jobId: (skipped.body.jobIds as string[])[0],
			}),
		).toMatchObject({
			status: 200,
			body: {
				refused: [
					{
						path: "/gone/kept.md",
						message: "An item with this name is already there, so this item stays in the Trash.",
					},
				],
				renamed: [],
			},
		});
		expect((await read_node(f, skippedId)).archiveOperationId).not.toBeNull();

		// History cleanup deletes the listed items together with the job.
		await f.t.run(async (ctx) => {
			while (!(await files_archive_runs_db_delete_run_batch(ctx, { runId })).done);
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_archive_run_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toEqual([]);
	});

	test("a restore that stops partway returns its job, and the job names a path that brings back the rest", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		// One delete with two files. `a.md` comes back first. `clash.md` clashes, and every name Keep both
		// tries is taken, so the job stops partway inside the request.
		const archiveOperationId = crypto.randomUUID();
		const restoredId = await insert_root_file(f, { name: "a.md", archiveOperationId });
		const leftId = await insert_root_file(f, { name: "clash.md", archiveOperationId });
		await insert_root_file(f, { name: "clash.md", archiveOperationId: null });
		const takenIds: Array<Id<"files_nodes">> = [];
		for (let counter = 2; counter <= 100; counter++) {
			takenIds.push(await insert_root_file(f, { name: `clash-${counter}.md`, archiveOperationId: null }));
		}

		const body = { paths: ["/a.md", "/clash.md"], requestId: "partway" };
		const response = await post(f, "/api/v1/files/restore", ownerKey.credential, body);
		expect(response).toMatchObject({
			status: 200,
			body: {
				jobIds: [expect.any(String)],
				// The job still gives `clash.md` its Trash entry.
				isDone: false,
				refused: body.paths.map((path) => ({ path, message: expect.stringMatching(/^Stopped partway: /u) })),
			},
		});
		expect((await read_node(f, restoredId)).archiveOperationId).toBeNull();
		// The stopped job holds the request, so a retry answers the same and restores nothing again.
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, body)).toEqual(response);

		const jobId = (response.body.jobIds as string[])[0] as Id<"activities">;
		const activity = await read_activity(f, jobId);
		expect(activity.status).toBe("stopping");
		await run_to_end(f, { runId: activity.source.id as Id<"files_archive_runs">, activityId: jobId });
		expect(
			await f.t.run(async (ctx) => (await ctx.db.query("files_trash_entries").collect()).map((entry) => entry.nodeId)),
		).toEqual([leftId]);
		expect(await post(f, "/api/v1/files/jobs/get", ownerKey.credential, { jobId })).toMatchObject({
			status: 200,
			body: {
				status: "failed",
				refused: [
					{ path: "/a.md", message: expect.stringMatching(/^Stopped partway: /u) },
					{ path: "/clash.md", message: expect.stringMatching(/^Stopped partway: /u) },
					{
						path: "/clash.md",
						message:
							"This item is still in the Trash. Restore it to bring it back with the items inside it that were moved to Trash with it.",
					},
				],
			},
		});

		// Once a name is free, that path brings back the rest.
		await f.t.run((ctx) => ctx.db.delete("files_nodes", takenIds[0]!));
		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, { paths: ["/clash.md"], requestId: "rest" }),
		).toMatchObject({ status: 200, body: { isDone: true, refused: [] } });
		expect(await read_node(f, leftId)).toMatchObject({ archiveOperationId: null, name: "clash-2.md" });
	});

	test("a retry answers the same jobs after history cleanup deleted the first job", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		await insert_root_file(f, { name: "x.md", archiveOperationId: crypto.randomUUID() });
		await insert_root_file(f, { name: "y.md", archiveOperationId: crypto.randomUUID() });
		const body = { paths: ["/x.md", "/y.md"], requestId: "two-jobs" };

		const first = await post(f, "/api/v1/files/restore", ownerKey.credential, body);
		expect(first).toEqual({
			status: 200,
			body: { jobIds: [expect.any(String), expect.any(String)], isDone: true, refused: [] },
		});

		// History cleanup deletes each job 7 days after it ends. The jobs run one after another, so the
		// first one can be deleted while the last one still runs.
		const firstJobId = (first.body.jobIds as Array<Id<"activities">>)[0]!;
		const firstRunId = (await read_activity(f, firstJobId)).source.id as Id<"files_archive_runs">;
		await f.t.run(async (ctx) => {
			while (!(await files_archive_runs_db_delete_run_batch(ctx, { runId: firstRunId })).done);
		});
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, body)).toEqual(first);
	});

	test("the most paths from separate deletes stay well inside the transaction limits", async () => {
		const f = await fixture();
		// A member pays for the access checks the owner skips.
		const member = await add_member(f);
		await f.t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			}),
		);
		const memberKey = await create_key({ asUser: member.asUser, membershipId: member.membershipId });
		// Each path comes from its own delete, so each one starts its own job.
		const paths = [];
		for (let index = 0; index < 101; index++) {
			const name = `m${String(index).padStart(3, "0")}.md`;
			await insert_root_file(f, { name, archiveOperationId: crypto.randomUUID() });
			paths.push(`/${name}`);
		}

		expect(await post(f, "/api/v1/files/restore", memberKey.credential, { paths, requestId: "too-many" })).toEqual({
			status: 400,
			body: { message: "Restore at most 100 items at once. Split the list into several calls." },
		});

		let databaseQueries = 0;
		test_spy_handler(restore_items, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			databaseQueries = (await ctx.meta.getTransactionMetrics()).databaseQueries.used;
			return result;
		});
		const response = await post(f, "/api/v1/files/restore", memberKey.credential, {
			paths: paths.slice(0, 100),
			requestId: "most",
		});
		vi.restoreAllMocks();
		expect(response).toMatchObject({ status: 200, body: { refused: [] } });
		expect(response.body.jobIds).toHaveLength(100);
		// Restricted folders cost more access reads per path, so keep half of the 4,096 query limit free.
		expect(databaseQueries).toBeGreaterThan(0);
		expect(databaseQueries).toBeLessThan(4096 / 2);
	});

	test("restores one of several deleted items at one path by its node id", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const firstDelete = crypto.randomUUID();
		const secondDelete = crypto.randomUUID();
		const firstId = await insert_root_file(f, { name: "same.md", archiveOperationId: firstDelete });
		const secondId = await insert_root_file(f, { name: "same.md", archiveOperationId: secondDelete });
		const siblingId = await insert_root_file(f, { name: "same.md", archiveOperationId: firstDelete });

		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, {
				nodes: [
					{ nodeId: firstId, archiveOperationId: firstDelete },
					// Listed before a later delete or restore changed it.
					{ nodeId: secondId, archiveOperationId: firstDelete },
					{ nodeId: "missing", archiveOperationId: firstDelete },
				],
				requestId: "by-id",
			}),
		).toEqual({
			status: 200,
			body: {
				jobIds: [expect.any(String)],
				isDone: true,
				refused: [
					{
						nodeId: secondId,
						path: "/same.md",
						message: "This Trash item changed. List the Trash and pick it again.",
					},
					{ nodeId: "missing", path: null, message: "Not found" },
				],
			},
		});
		expect((await read_node(f, firstId)).archiveOperationId).toBeNull();
		expect((await read_node(f, secondId)).archiveOperationId).toBe(secondDelete);
		expect(
			(await read_node(f, siblingId)).archiveOperationId,
			"an equal-path sibling from the same delete stays in Trash",
		).toBe(firstDelete);

		const nodes = [{ nodeId: secondId, archiveOperationId: secondDelete }];
		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, { nodes: [...nodes, ...nodes], requestId: "twice" }),
		).toEqual({ status: 400, body: { message: "Duplicate node in batch", nodeId: secondId } });
		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, { paths: ["/same.md"], nodes, requestId: "both" }),
		).toEqual({ status: 400, body: { message: "Send either paths or nodes." } });
	});

	test("a locked node answers Permission denied whether its Trash stamp changed or not", async () => {
		const f = await fixture();
		const archiveOperationId = crypto.randomUUID();
		const lockedIds = [];
		for (const name of ["a.md", "b.md"]) {
			const lockedId = await insert_root_file(f, { name, archiveOperationId });
			await f.t.run((ctx) =>
				ctx.db.patch("files_nodes", lockedId, {
					restrictedScopeNodeId: lockedId,
					isRestrictedScopeRoot: true,
					parentScopeNodeId: null,
				}),
			);
			lockedIds.push(lockedId);
		}
		const member = await add_member(f);
		await f.t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			}),
		);
		const memberKey = await create_key({ asUser: member.asUser, membershipId: member.membershipId });

		expect(
			await post(f, "/api/v1/files/restore", memberKey.credential, {
				nodes: [
					{ nodeId: lockedIds[0], archiveOperationId },
					{ nodeId: lockedIds[1], archiveOperationId: "stale" },
				],
				dryRun: true,
			}),
		).toMatchObject({
			status: 200,
			body: {
				refused: [
					{ nodeId: lockedIds[0], path: null, message: "Permission denied" },
					{ nodeId: lockedIds[1], path: null, message: "Permission denied" },
				],
				jobs: [],
			},
		});
	});

	test("a dry run says what the restore would do and saves nothing", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const archivedId = await insert_root_file(f, { name: "clash.md", archiveOperationId: crypto.randomUUID() });
		await insert_root_file(f, { name: "clash.md", archiveOperationId: null });
		const count_saved = () =>
			f.t.run(async (ctx) => ({
				runs: (await ctx.db.query("files_archive_runs").collect()).length,
				activities: (await ctx.db.query("activities").collect()).length,
			}));
		const before = await count_saved();

		const preview = await post(f, "/api/v1/files/restore", ownerKey.credential, {
			paths: ["/clash.md", "/gone.md"],
			dryRun: true,
		});
		expect(await read_node(f, archivedId)).toMatchObject({ name: "clash.md", archiveOperationId: expect.any(String) });
		expect(await count_saved()).toEqual(before);
		expect(preview).toEqual({
			status: 200,
			body: {
				dryRun: true,
				complete: true,
				refused: [{ path: "/gone.md", message: "Not found" }],
				jobs: [
					expect.objectContaining({
						kind: "restore",
						status: "succeeded",
						renamed: [{ path: "/clash.md", newPath: "/clash-2.md" }],
						hasMoreItems: false,
					}),
				],
			},
		});

		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, {
				paths: ["/clash.md"],
				dryRun: true,
				requestId: "preview",
			}),
		).toEqual({ status: 400, body: { message: "A dry run takes no requestId." } });
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, { paths: ["/clash.md"] })).toEqual({
			status: 400,
			body: { message: "requestId is required." },
		});
	});
});

describe("files/trash/list", () => {
	/**
	 * `/team` is a restricted folder in Trash with `/team/inside.md` from the same delete.
	 */
	async function insert_restricted_team(f: Fixture, archiveOperationId: string) {
		const teamId = await insert_root_file(f, { name: "team", archiveOperationId });
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", teamId, {
				kind: "folder",
				treePath: "/team/",
				restrictedScopeNodeId: teamId,
				isRestrictedScopeRoot: true,
				parentScopeNodeId: null,
			});
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: teamId,
				name: "inside.md",
				sortName: files_sort_text_key("inside.md"),
				kind: "file",
				path: "/team/inside.md",
				treePath: "/team/inside.md",
				pathDepth: 2,
				restrictedScopeNodeId: teamId,
				archiveOperationId,
				archivedPath: "/team/inside.md",
			});
		});
		return teamId;
	}

	test("lists every item in Trash of one area, newest delete first, and ends with a null cursor", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const olderDelete = files_archive_operation_id_new(1_000);
		const newerDelete = files_archive_operation_id_new(2_000);
		await insert_root_file(f, { name: "old.md", archiveOperationId: olderDelete });
		// Two items of one delete at one path. The app's Trash view shows only one of them.
		const firstSameId = await insert_root_file(f, { name: "same.md", archiveOperationId: newerDelete });
		const secondSameId = await insert_root_file(f, { name: "same.md", archiveOperationId: newerDelete });
		const teamId = await insert_restricted_team(f, newerDelete);
		// Active files are in the same index, but outside the Trash range.
		for (const name of ["a.md", "b.md", "c.md"]) await insert_root_file(f, { name, archiveOperationId: null });

		const pages = [];
		let cursor: unknown = null;
		do {
			const response = await post(f, "/api/v1/files/trash/list", ownerKey.credential, { limit: 2, cursor });
			expect(response.status).toBe(200);
			pages.push(response.body);
			cursor = response.body.cursor;
		} while (pages.at(-1)!.isDone === false);

		expect(pages[0]!.items).toHaveLength(2);
		expect(pages.slice(0, -1).every((page) => typeof page.cursor === "string" && page.cursor !== "")).toBe(true);
		expect(pages.at(-1)!.cursor).toBeNull();
		expect(pages.flatMap((page) => page.items as Array<Record<string, unknown>>)).toEqual([
			// The restricted folder lists in the area of its parent. What is inside lists in its own area.
			expect.objectContaining({ path: "/team", kind: "folder", locked: false, top: true, nodeId: teamId }),
			// The same delete and path: the newer doc comes first, and a page break between them skips neither.
			expect.objectContaining({
				path: "/same.md",
				nodeId: secondSameId,
				archiveOperationId: newerDelete,
				operationAt: 2_000,
				changedBy: f.db.userId,
				top: true,
			}),
			expect.objectContaining({ path: "/same.md", nodeId: firstSameId, archiveOperationId: newerDelete, top: true }),
			expect.objectContaining({ path: "/old.md", archiveOperationId: olderDelete, operationAt: 1_000 }),
		]);

		expect(await post(f, "/api/v1/files/trash/list", ownerKey.credential, { areaNodeId: teamId })).toMatchObject({
			status: 200,
			body: {
				// Its folder is in Trash from the same delete, so the app's Trash view does not show it.
				items: [expect.objectContaining({ path: "/team/inside.md", top: false })],
				cursor: null,
				isDone: true,
			},
		});
		// A cursor works only for the area it was made for.
		for (const body of [{ cursor: "" }, { cursor: pages[0]!.cursor, areaNodeId: teamId }]) {
			expect(await post(f, "/api/v1/files/trash/list", ownerKey.credential, body)).toEqual({
				status: 400,
				body: { message: "This Trash cursor changed. Start a new page.", errorCode: "invalid_cursor" },
			});
		}
		// A restricted file is not an area: it holds no other items.
		const fileRootId = await insert_root_file(f, { name: "private.md", archiveOperationId: null });
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileRootId, {
				restrictedScopeNodeId: fileRootId,
				isRestrictedScopeRoot: true,
				parentScopeNodeId: null,
			}),
		);
		expect(await post(f, "/api/v1/files/trash/list", ownerKey.credential, { areaNodeId: fileRootId })).toEqual({
			status: 400,
			body: { message: "areaNodeId must name a restricted folder. Use null for the rest of the workspace." },
		});
	});

	test("a published Move shows its new place and Trash stamp before cleanup, and restore by node accepts it", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const oldDelete = files_archive_operation_id_new(1_000);
		const newDelete = files_archive_operation_id_new(2_000);
		const nodeId = await insert_root_file(f, { name: "old.md", archiveOperationId: oldDelete });
		// The Move's after view has a new path and Trash stamp. Its cleanup has not rewritten the node doc yet.
		await f.t.run(async (ctx) => {
			const cohortId = await test_db_hold_move_slot(ctx, f.db);
			const {
				_id,
				_creationTime,
				createdBy: _createdBy,
				readOnly: _readOnly,
				readOnlyDecisionId: _readOnlyDecisionId,
				moveCohortId: _moveCohortId,
				scopeOpId: _scopeOpId,
				...header
			} = (await ctx.db.get("files_nodes", nodeId))!;
			const place = {
				...header,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				cohortId,
				nodeId,
				nodeCreationTime: _creationTime,
				contentId: null,
			};
			await ctx.db.insert("files_saved_places", { ...place, view: "before" });
			await ctx.db.insert("files_saved_places", {
				...place,
				view: "after",
				name: "moved.md",
				sortName: files_sort_text_key("moved.md"),
				path: "/moved.md",
				treePath: "/moved.md",
				archiveOperationId: newDelete,
			});
			await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
			await ctx.db.patch("files_move_cohorts", cohortId, { visibleView: "after", publishedAt: Date.now() });
			const slot = (await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique())!;
			await ctx.db.patch("files_move_workspace_slots", slot._id, { visibleView: "after" });
		});

		expect(await post(f, "/api/v1/files/trash/list", ownerKey.credential, {})).toMatchObject({
			status: 200,
			body: { items: [expect.objectContaining({ nodeId, path: "/moved.md", archiveOperationId: newDelete })] },
		});
		expect(
			await post(f, "/api/v1/files/restore", ownerKey.credential, {
				nodes: [{ nodeId, archiveOperationId: newDelete }],
				dryRun: true,
			}),
		).toMatchObject({ status: 200, body: { refused: [] } });
	});

	test("shows a restricted folder the member cannot open as a locked row", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_team(f, files_archive_operation_id_new(1_000));
		const member = await add_member(f);
		await f.t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			}),
		);
		const memberKey = await create_key({ asUser: member.asUser, membershipId: member.membershipId });

		expect(await post(f, "/api/v1/files/trash/list", memberKey.credential, {})).toMatchObject({
			status: 200,
			body: {
				items: [expect.objectContaining({ path: "/team", locked: true, changedBy: null })],
				cursor: null,
				isDone: true,
			},
		});
		expect(await post(f, "/api/v1/files/trash/list", memberKey.credential, { areaNodeId: teamId })).toEqual({
			status: 403,
			body: { message: "Permission denied" },
		});
	});
});

describe("files/trash/areas", () => {
	/**
	 * Restricted folders `/a-mine` and `/b-team`, a restricted folder in Trash, and more restricted files
	 * before them than the reads of one page.
	 */
	async function seed_areas(f: Fixture) {
		const restrict = async (nodeId: Id<"files_nodes">) => {
			const restricted = await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId,
			});
			expect(restricted).toEqual({ _yay: null });
			return nodeId;
		};
		const mineId = await restrict(await folder(f, "/a-mine"));
		const teamId = await restrict(await folder(f, "/b-team"));
		for (let index = 0; index < 12; index++) {
			const fileId = await insert_root_file(f, {
				name: `0-file-${String(index).padStart(2, "0")}.md`,
				archiveOperationId: null,
			});
			// Mark it directly: `restrict_node` is rate limited.
			await test_run_with_flush(f.t, (ctx) =>
				ctx.db.patch("files_nodes", fileId, {
					restrictedScopeNodeId: fileId,
					isRestrictedScopeRoot: true,
					parentScopeNodeId: null,
				}),
			);
		}
		// An empty folder goes to Trash inside the request.
		expect(await archive(f, [await restrict(await folder(f, "/d-gone"))])).toEqual({ _yay: null });
		return { mineId, teamId };
	}

	test("pages the open area first, then the restricted folders by path", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const { mineId, teamId } = await seed_areas(f);

		const first = await post(f, "/api/v1/files/trash/areas", ownerKey.credential, { limit: 2 });
		expect(first).toMatchObject({
			status: 200,
			body: {
				areas: [
					{ areaNodeId: null, path: "/" },
					{ areaNodeId: mineId, path: "/a-mine" },
				],
				cursor: expect.any(String),
				isDone: false,
			},
		});
		expect(
			await post(f, "/api/v1/files/trash/areas", ownerKey.credential, { limit: 2, cursor: first.body.cursor }),
		).toEqual({
			status: 200,
			body: { areas: [{ areaNodeId: teamId, path: "/b-team" }], cursor: null, isDone: true },
		});
		// With `limit: 1` the first page holds only the open area.
		const openOnly = await post(f, "/api/v1/files/trash/areas", ownerKey.credential, { limit: 1 });
		expect(openOnly).toMatchObject({
			status: 200,
			body: { areas: [{ areaNodeId: null, path: "/" }], cursor: expect.any(String), isDone: false },
		});
		expect(
			await post(f, "/api/v1/files/trash/areas", ownerKey.credential, { limit: 1, cursor: openOnly.body.cursor }),
		).toMatchObject({ status: 200, body: { areas: [{ areaNodeId: mineId, path: "/a-mine" }], isDone: false } });
		expect(await post(f, "/api/v1/files/trash/areas", ownerKey.credential, { cursor: "" })).toEqual({
			status: 400,
			body: { message: "This Trash cursor changed. Start a new page.", errorCode: "invalid_cursor" },
		});
	});

	test("a member gets the folders they can open, and guests and account keys get 403", async () => {
		const f = await fixture();
		await create_owner_key(f);
		const { mineId } = await seed_areas(f);
		const member = await add_member(f);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				resourceKind: "file",
				resourceId: String(mineId),
				principalKind: "user",
				userId: member.userId,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await f.t.run((ctx) =>
			quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: member.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			}),
		);
		const memberKey = await create_key({ asUser: member.asUser, membershipId: member.membershipId });
		expect(await post(f, "/api/v1/files/trash/areas", memberKey.credential, {})).toEqual({
			status: 200,
			body: {
				areas: [
					{ areaNodeId: null, path: "/" },
					{ areaNodeId: mineId, path: "/a-mine" },
				],
				cursor: null,
				isDone: true,
			},
		});

		const account = await f.asOwner.mutation(api.access_control.create_service_account, {
			membershipId: f.db.membershipId,
			name: "Trash bot",
		});
		if (account._nay) throw new Error(account._nay.message);
		vi.advanceTimersByTime(60_000);
		const accountKey = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: account._yay.serviceAccountId,
			name: "Trash bot",
			scopes: ["files:list"],
		});
		if (accountKey._nay) throw new Error(accountKey._nay.message);
		expect(await post(f, "/api/v1/files/trash/areas", accountKey._yay.credential, {})).toEqual({
			status: 403,
			body: { message: "Keys bound to a service account cannot list the Trash yet." },
		});

		// Without a role the member is a guest, and a guest has no Trash view.
		await f.t.run(async (ctx) => {
			for (const assignment of await ctx.db.query("access_control_role_assignments").collect())
				if (assignment.userId === member.userId) await ctx.db.delete("access_control_role_assignments", assignment._id);
		});
		for (const body of [{}, { limit: 1 }]) {
			expect(await post(f, "/api/v1/files/trash/areas", memberKey.credential, body)).toEqual({
				status: 403,
				body: { message: "Permission denied" },
			});
		}
	});
});
