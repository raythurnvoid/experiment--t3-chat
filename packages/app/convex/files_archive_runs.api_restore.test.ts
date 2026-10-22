// The public API `files/restore` tests. The route starts the same restore job as Restore in the app.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { restore_paths } from "./public_api_files_organize.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { test_mocks, test_spy_handler } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	fixture,
	add_member,
	seed_tree,
	seed_same_path,
	read_activity,
	run_to_end,
	archive_to_end,
	folder,
	read_node,
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
	return await f.t.run((ctx) =>
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
		}),
	);
}

describe("files/restore", () => {
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
						message: "Several deleted items have this path. Restore the one you want in the app.",
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
			const hiddenId = await insert_root_file(f, { name: "hidden.md", archiveOperationId: crypto.randomUUID() });
			await f.t.run((ctx) =>
				ctx.db.patch("files_nodes", hiddenId, {
					restrictedScopeNodeId: hiddenId,
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
					{ path: "/hidden.md", message: "Several deleted items have this path. Restore the one you want in the app." },
				],
			},
		});
	});

	test("a retry with the same requestId answers the same jobs and restores nothing again", async () => {
		const f = await fixture();
		const ownerKey = await create_owner_key(f);
		const tree = await seed_tree(f, { name: "again", folderCount: 1, filesPerFolder: 1 });
		await archive_to_end(f, tree.topId);
		const body = { paths: ["/again"], requestId: "retry" };

		const first = await post(f, "/api/v1/files/restore", ownerKey.credential, body);
		expect(first).toEqual({ status: 200, body: { jobIds: [expect.any(String)], isDone: true, refused: [] } });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();

		// Delete the folder again. A late retry must not bring it back a second time.
		await archive_to_end(f, tree.topId);
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, body)).toEqual(first);
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
			errorMessage: "The API key that started this job was revoked or lost files:write.",
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
		// One delete with more clashing files than one jobs/get page.
		const archiveOperationId = crypto.randomUUID();
		for (let index = 0; index < 101; index++) {
			const name = `c${String(index).padStart(3, "0")}.md`;
			await insert_root_file(f, { name, archiveOperationId });
			await insert_root_file(f, { name, archiveOperationId: null });
		}

		const response = await post(f, "/api/v1/files/restore", ownerKey.credential, {
			paths: ["/c000.md"],
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
		expect(renamed).toHaveLength(101);
		expect(new Set(renamed.map((item) => JSON.stringify(item))).size).toBe(101);
		expect(renamed).toContainEqual({ path: "/c100.md", newPath: "/c100-2.md" });

		// Skip leaves the item in the Trash, and the job names the path it keeps there. Its folder is gone, so it
		// would land at the root, next to an item with its name.
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

		const body = { paths: ["/a.md"], requestId: "partway" };
		const response = await post(f, "/api/v1/files/restore", ownerKey.credential, body);
		expect(response).toMatchObject({
			status: 200,
			body: {
				jobIds: [expect.any(String)],
				isDone: true,
				refused: [{ path: "/a.md", message: expect.stringMatching(/^Stopped partway: /u) }],
			},
		});
		expect((await read_node(f, restoredId)).archiveOperationId).toBeNull();
		// The stopped job holds the request, so a retry answers the same and restores nothing again.
		expect(await post(f, "/api/v1/files/restore", ownerKey.credential, body)).toEqual(response);

		const jobId = (response.body.jobIds as string[])[0];
		expect(await post(f, "/api/v1/files/jobs/get", ownerKey.credential, { jobId })).toMatchObject({
			status: 200,
			body: {
				status: "failed",
				refused: [
					{ path: "/a.md", message: expect.stringMatching(/^Stopped partway: /u) },
					{
						path: "/clash.md",
						message:
							"This item and the rest of its delete are still in the Trash. Restore this path to bring them back.",
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

		expect(
			await post(f, "/api/v1/files/restore", memberKey.credential, { paths, requestId: "too-many" }),
		).toMatchObject({ status: 400 });

		let databaseQueries = 0;
		test_spy_handler(restore_paths, async (handler, ctx, args) => {
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
});
