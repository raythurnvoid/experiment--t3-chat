import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
		async () => `clipboard-work-${++workCount}` as never,
	);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function create_folder_fixture(paths: string[]) {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folders = new Map<string, Id<"files_nodes">>();
	for (const path of new Set(["/target", ...paths])) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.set(path, created._yay.nodeId);
	}
	return { t, db, asUser, folders };
}

async function start_copy(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, sourceIds: Id<"files_nodes">[]) {
	const started = await fixture.asUser.mutation(api.files_transfer.start, {
		membershipId: fixture.db.membershipId,
		requestId: "copy-request",
		kind: "copy",
		sourceIds,
		targetParentId: fixture.folders.get("/target")!,
	});
	if (started._nay) throw new Error(started._nay.message);
	return started._yay.runId;
}

async function finish_checking(
	fixture: Awaited<ReturnType<typeof create_folder_fixture>>,
	runId: Id<"files_transfer_runs">,
) {
	for (let step = 0; step < 150; step += 1) {
		const view = await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId });
		if (!view) throw new Error("Missing run");
		if (view.phase !== "checking") return view;
		await fixture.t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Discovery did not finish");
}

async function finish_folder_copy(
	fixture: Awaited<ReturnType<typeof create_folder_fixture>>,
	runId: Id<"files_transfer_runs">,
) {
	for (let step = 0; step < 300; step += 1) {
		const view = await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId });
		if (!view) throw new Error("Missing run");
		if (view.phase !== "checking" && view.phase !== "running") return view;
		await fixture.t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Folder copy did not finish");
}

async function get_node(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, path: string) {
	return await fixture.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", fixture.db.organizationId)
					.eq("workspaceId", fixture.db.workspaceId)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
}

async function add_member(fixture: Awaited<ReturnType<typeof create_folder_fixture>>) {
	const member = await fixture.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clipboard-other-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.db.organizationId,
			workspaceId: fixture.db.workspaceId,
			userId,
			active: true,
			updatedAt: Date.now(),
		});
		await ctx.db.insert("access_control_role_assignments", {
			organizationId: fixture.db.organizationId,
			workspaceId: fixture.db.workspaceId,
			userId,
			role: "member",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { userId, membershipId };
	});
	return { ...member, asUser: fixture.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }) };
}

describe("start", () => {
	test("keeps top selected ancestors and reuses the same request", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const args = {
			membershipId: db.membershipId,
			requestId: "same-request",
			kind: "copy" as const,
			sourceIds: [folders.get("/source")!, folders.get("/source/child")!, folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		};
		const first = await asUser.mutation(api.files_transfer.start, args);
		if (first._nay) throw new Error(first._nay.message);
		expect(await asUser.mutation(api.files_transfer.start, args)).toEqual(first);
		expect(
			(await asUser.mutation(api.files_transfer.start, { ...args, requestId: "another-request" }))._nay?.message,
		).toBe("A Paste is already running in this workspace");
		expect(await asUser.query(api.files_transfer.list_current, { membershipId: db.membershipId })).toMatchObject([
			{ _id: first._yay.runId, phase: "checking", total: 1 },
		]);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_transfer_runs").collect()).toHaveLength(1);
			expect((await ctx.db.query("files_transfer_items").collect()).map((item) => item.sourceId)).toEqual([
				folders.get("/source"),
			]);
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	test("rejects a move into the selected folder's child", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const refused = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "cycle",
			kind: "move",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/source/child")!,
		});
		expect(refused._nay?.message).toBe("A folder cannot be moved inside itself");
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(0);
		expect((await get_node(fixture, "/source"))?._id).toBe(folders.get("/source"));
	});

	test("keeps a run private from another member of the same workspace", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [fixture.folders.get("/source")!]);
		expect(await member.asUser.query(api.files_transfer.get, { membershipId: member.membershipId, runId })).toBeNull();
		expect(await member.asUser.query(api.files_transfer.list_current, { membershipId: member.membershipId })).toEqual(
			[],
		);
		expect(
			(await member.asUser.mutation(api.files_transfer.stop, { membershipId: member.membershipId, runId }))._nay
				?.message,
		).toBe("Not found");
		expect(
			(await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId }))?.phase,
		).toBe("checking");
	});
});

describe("advance", () => {
	test("copies nested empty folders and folder metadata with fresh IDs", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/empty", "/source/nested/deep"]);
		const { db, asUser, folders } = fixture;
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: folders.get("/source")!,
					metadataYaml: "owner: Ray",
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(await finish_checking(fixture, runId)).toMatchObject({ phase: "running", total: 4, completed: 0 });
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			phase: "completed",
			total: 4,
			completed: 4,
			failed: 0,
		});
		for (const path of ["/source", "/source/empty", "/source/nested", "/source/nested/deep"]) {
			const original = await get_node(fixture, path);
			const copied = await get_node(fixture, `/target${path}`);
			expect(copied?.kind).toBe("folder");
			expect(copied?._id).not.toBe(original?._id);
		}
		const copiedRoot = await get_node(fixture, "/target/source");
		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: copiedRoot!._id,
			}),
		).toEqual([{ key: "owner", value: "Ray" }]);
		expect(await asUser.query(api.files_transfer.list_current, { membershipId: db.membershipId })).toEqual([]);
	});

	test("shows the first file failure and keeps completed folders", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const filename of ["first.bin", "second.bin"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename,
				contentType: "application/octet-stream",
				size: 8,
			});
			if (file._nay) throw new Error(file._nay.message);
			fileIds.push(file._yay.nodeId);
		}
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_checking(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const copiedFolder = await get_node(fixture, "/target/source");
		expect(copiedFolder?.kind).toBe("folder");
		for (const [index, sourceId] of fileIds.entries()) {
			if (index === 1) {
				await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" }));
			}
			await t.mutation(internal.files_transfer.advance, { runId });
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) => q.eq("runId", runId).eq("sourceId", sourceId))
					.unique(),
			);
			if (!item?.workId) throw new Error("Missing queued copy worker");
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
				state: "failed",
				errorMessage:
					index === 0
						? "The source file is still saving. Try again."
						: "This workspace's plan does not include file uploads",
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			phase: "failed",
			total: 3,
			completed: 1,
			failed: 2,
			errorMessage: "The source file is still saving. Try again.",
		});
		const activities = await asUser.query(api.activities.list_recent, { membershipId: db.membershipId });
		expect(activities.find((activity) => activity.source.id === runId)).toMatchObject({
			status: "failed",
			errorMessage: "The source file is still saving. Try again.",
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(copiedFolder!._id);
		expect(await get_node(fixture, "/target/source/first.bin")).toBeNull();
		expect(await get_node(fixture, "/target/source/second.bin")).toBeNull();
	});

	test("discovers more than one page before creating any output", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({
			phase: "checking",
			total: 51,
			completed: 0,
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.total).toBe(56);
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({ phase: "completed", total: 56, completed: 56 });
		for (const path of paths) expect(await get_node(fixture, `/target${path}`)).not.toBeNull();
	});

	test("refuses an unreadable descendant before copying its readable parent", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/hidden-name"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		expect(
			(
				await asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source/hidden-name")!,
				})
			)._nay,
		).toBeUndefined();
		const started = await member.asUser.mutation(api.files_transfer.start, {
			membershipId: member.membershipId,
			requestId: "hidden-child",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const view = await member.asUser.query(api.files_transfer.get, {
			membershipId: member.membershipId,
			runId: started._yay.runId,
		});
		expect(view).toMatchObject({ phase: "failed", completed: 0, errorMessage: "Permission denied" });
		expect(JSON.stringify(view)).not.toContain("hidden-name");
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	test("does not copy descendants added after discovery finishes", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/first"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect((await finish_checking(fixture, runId)).phase).toBe("running");
		expect(
			(
				await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: folders.get("/source")!,
					path: "later",
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({ phase: "completed", total: 2, completed: 2 });
		expect(await get_node(fixture, "/target/source/first")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/later")).toBeNull();
	});
});

describe("resolve_conflicts", () => {
	test("allocates a free counter for selected items with the same name", async () => {
		const fixture = await create_folder_fixture(["/first/report", "/second/report", "/target/report-copy-1"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/first/report")!, folders.get("/second/report")!]);
		const waiting = await finish_checking(fixture, runId);
		expect(waiting.phase).toBe("awaiting_choice");
		expect(waiting.conflicts).toHaveLength(1);
		expect(await get_node(fixture, "/target/report")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: "keep_both",
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({ phase: "completed", completed: 2 });
		expect(await get_node(fixture, "/target/report")).not.toBeNull();
		expect(await get_node(fixture, "/target/report-copy-2")).not.toBeNull();
	});

	test("rejects a stale answer and skips a whole folder without merging", async () => {
		const fixture = await create_folder_fixture([
			"/source",
			"/source/child/deep",
			"/target/source",
			"/target/source/keep",
		]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const waiting = await finish_checking(fixture, runId);
		expect(waiting).toMatchObject({ phase: "awaiting_choice", total: 3, completed: 0 });
		const resolution = {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "skip" as const }],
			applyToRemaining: null,
		};
		expect(
			(await asUser.mutation(api.files_transfer.resolve_conflicts, { ...resolution, revision: waiting.revision - 1 }))
				._nay?.message,
		).toBe("The conflicts changed. Review them again.");
		expect((await asUser.mutation(api.files_transfer.resolve_conflicts, resolution))._nay).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({ phase: "completed", completed: 0, skipped: 3 });
		expect(await get_node(fixture, "/target/source/child")).toBeNull();
		expect((await get_node(fixture, "/target/source/keep"))?._id).toBe(folders.get("/target/source/keep"));
		expect((await get_node(fixture, "/source/child/deep"))?._id).toBe(folders.get("/source/child/deep"));
	});
});

describe("stop", () => {
	test("cancels checking before any output and lets a new request start", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect((await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.phase).toBe(
			"canceled",
		);
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.start, {
					membershipId: db.membershipId,
					requestId: "after-stop",
					kind: "copy",
					sourceIds: [folders.get("/source")!],
					targetParentId: folders.get("/target")!,
				})
			)._yay?.runId,
		).not.toBe(runId);
	});

	test("keeps a completed folder and prevents a queued file from publishing", async () => {
		const cancel = vi.spyOn(Workpool.prototype, "cancel");
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			filename: "queued.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_checking(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const completed = await get_node(fixture, "/target/source");
		expect(completed).not.toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) => q.eq("runId", runId).eq("sourceId", file._yay.nodeId))
				.unique(),
		);
		if (!item?.workId) throw new Error("Missing queued copy worker");
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		expect((await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.phase).toBe(
			"stopping",
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "canceled" },
		});
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			phase: "canceled",
			completed: 1,
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(completed!._id);
		expect(await get_node(fixture, "/target/source/queued.pdf")).toBeNull();
		expect(cancel).toHaveBeenCalledWith(expect.anything(), item.workId);
	});
});

describe("move", () => {
	test.each([
		{ access: "none", archived: false },
		{ access: "read", archived: false },
		{ access: "write", archived: false },
		{ access: "owner", archived: false },
		{ access: "none", archived: true },
		{ access: "read", archived: true },
		{ access: "write", archived: true },
		{ access: "owner", archived: true },
	] as const)(
		"checks nested restricted descendants with $access access (archived: $archived)",
		async ({ access, archived }) => {
			const fixture = await create_folder_fixture([
				"/source",
				"/source/hidden-name",
				"/source/hidden-name/child",
				"/other",
			]);
			const { t, db, asUser, folders } = fixture;
			const member = await add_member(fixture);
			const restrictedId = folders.get("/source/hidden-name")!;
			expect(
				(
					await asUser.mutation(api.files_sharing.restrict_node, {
						membershipId: db.membershipId,
						nodeId: restrictedId,
					})
				)._nay,
			).toBeUndefined();
			if (access === "read" || access === "write") {
				expect(
					(
						await asUser.mutation(api.files_sharing.set_node_share_grant, {
							membershipId: db.membershipId,
							nodeId: restrictedId,
							principal: { kind: "user", userId: member.userId },
							level: access,
						})
					)._nay,
				).toBeUndefined();
			}
			if (archived) {
				expect(
					(
						await asUser.mutation(api.files_nodes.archive_nodes, {
							membershipId: db.membershipId,
							nodeIds: [restrictedId],
						})
					)._nay,
				).toBeUndefined();
			}
			const actor = access === "owner" ? asUser : member.asUser;
			const membershipId = access === "owner" ? db.membershipId : member.membershipId;
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const started = await actor.mutation(api.files_transfer.start, {
				membershipId,
				requestId: "nested-restricted-cut",
				kind: "move",
				sourceIds: [folders.get("/other")!, folders.get("/source")!],
				targetParentId: folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const view = await actor.query(api.files_transfer.get, { membershipId, runId });
			expect(JSON.stringify(view)).not.toContain("hidden-name");
			if (access === "none" || access === "read") {
				expect(view).toMatchObject({
					phase: "failed",
					completed: 0,
					movedNodeIds: [],
					errorMessage: "Permission denied",
				});
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} else {
				expect(view).toMatchObject({ phase: "completed", completed: 2, errorMessage: null });
				for (const path of ["/source/hidden-name", "/source/hidden-name/child"]) {
					const nodeId = folders.get(path)!;
					expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
						path: `/target${path}`,
						restrictedScopeNodeId: restrictedId,
						archiveOperationId: before.find((node) => node._id === nodeId)!.archiveOperationId,
					});
				}
				expect((await get_node(fixture, "/target/other"))?._id).toBe(folders.get("/other"));
			}
		},
	);

	test("refuses too many name checks before moving any source", async () => {
		const names = ["one", "two", "three"];
		const fixture = await create_folder_fixture([
			...names.map((name) => `/${name}`),
			...names.flatMap((name) =>
				Array.from({ length: 70 }, (_, index) => `/target/${index === 0 ? name : `${name}-copy-${index}`}`),
			),
		]);
		const { t, db, asUser, folders } = fixture;
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "many-conflicts",
			kind: "move",
			sourceIds: names.map((name) => folders.get(`/${name}`)!),
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const waiting = await finish_checking(fixture, runId);
		expect(waiting.conflicts).toHaveLength(3);
		const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: waiting.conflicts.map((item) => ({ itemId: item.itemId, choice: "keep_both" as const })),
			applyToRemaining: null,
		});
		expect(resolved._nay).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			phase: "failed",
			completed: 0,
			errorMessage: "Too many name conflicts. Select fewer items.",
		});
		for (const name of names) {
			expect((await get_node(fixture, `/${name}`))?._id).toBe(folders.get(`/${name}`));
			expect(await get_node(fixture, `/target/${name}-copy-70`)).toBeNull();
		}
	});

	test("moves the selected roots in one transaction after resolving a late conflict", async () => {
		const fixture = await create_folder_fixture(["/one", "/one/child", "/two"]);
		const { t, db, asUser, folders } = fixture;
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "move",
			kind: "move",
			sourceIds: [folders.get("/one")!, folders.get("/two")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_checking(fixture, runId)).phase).toBe("running");
		expect(
			(
				await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: folders.get("/target")!,
					path: "two",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		const waiting = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		expect(waiting).toMatchObject({ phase: "awaiting_choice", completed: 0 });
		expect((await get_node(fixture, "/one"))?._id).toBe(folders.get("/one"));
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
		expect(await get_node(fixture, "/target/one")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting!.revision,
					choices: [{ itemId: waiting!.conflicts[0]!.itemId, choice: "skip" }],
					applyToRemaining: null,
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			phase: "completed",
			completed: 1,
			skipped: 1,
			movedNodeIds: [folders.get("/one")],
		});
		expect((await get_node(fixture, "/target/one"))?._id).toBe(folders.get("/one"));
		expect((await get_node(fixture, "/target/one/child"))?._id).toBe(folders.get("/one/child"));
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
	});
});

describe("recover_expired", () => {
	test("releases expired staging and ignores callbacks from an older attempt", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "queued.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [file._yay.nodeId]);
		await finish_checking(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const first = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!first?.workId) throw new Error("Missing first worker");
		const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: first._id,
			attempt: first.attempt,
			textKind: null,
			contentSize: 8,
		});
		if (!staged._yay) throw new Error("Missing staged asset");
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		await t.mutation(internal.files_transfer.recover_expired, {});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", staged._yay!.contentAssetId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", first._id))).toMatchObject({
			state: "pending",
			workId: null,
			stagedAssetIds: [],
		});
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: first._id, attempt: first.attempt });
		await t.mutation(internal.files_transfer.advance, { runId });
		const second = await t.run((ctx) => ctx.db.get("files_transfer_items", first._id));
		expect(second?.attempt).toBe(first.attempt + 1);
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: first.workId,
			context: { itemId: first._id, attempt: first.attempt },
			result: { kind: "canceled" },
		});
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(1);
		const callback = {
			workId: second!.workId!,
			context: { itemId: first._id, attempt: second!.attempt },
			result: { kind: "failed" as const, error: "Storage failed" },
		};
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.inFlight).toBe(0);
		expect(await get_node(fixture, "/target/queued.pdf")).toBeNull();
	});
});

describe("changed folders", () => {
	test("requires a new choice after the source moves and never follows its old path", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_checking(fixture, runId);
		expect(
			(
				await asUser.mutation(api.files_nodes.rename_node, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					path: "renamed",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		const view = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		expect(view).toMatchObject({
			phase: "awaiting_choice",
			completed: 0,
			conflicts: [{ kind: "source_changed", sourceName: null }],
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: view!.revision,
					choices: [{ itemId: view!.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: null,
				})
			)._nay,
		).toBeDefined();
	});

	test("does not write children into a copied folder moved by another member", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_checking(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const copied = await get_node(fixture, "/target/source");
		expect(
			(
				await member.asUser.mutation(api.files_nodes.rename_node, {
					membershipId: member.membershipId,
					nodeId: copied!._id,
					path: "moved-copy",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			phase: "awaiting_choice",
			completed: 1,
			conflicts: [{ kind: "destination_changed" }],
		});
		expect((await get_node(fixture, "/target/moved-copy"))?._id).toBe(copied!._id);
		expect(await get_node(fixture, "/target/moved-copy/child")).toBeNull();
		expect(await get_node(fixture, "/target/child")).toBeNull();
	});
});
