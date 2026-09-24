import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { files_transfer_db_delete_run_batch } from "./files_transfer.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";

const r2Objects = new Map<string, BodyInit>();

beforeEach(() => {
	vi.useFakeTimers();
	r2Objects.clear();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
		async () => `clipboard-work-${++workCount}` as never,
	);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key");
			if (url.origin !== "https://r2.test" || !key) return new Response(null, { status: 404 });
			if (url.pathname === "/upload" && init?.method === "PUT") {
				r2Objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function create_folder_fixture(paths: string[]) {
	const t = test_convex({ transactionLimits: true });
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

// These tests exercise discovery and publication after Copy intake finishes.
async function finish_selection(
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">,
	runId: Id<"files_transfer_runs">,
	activityId: Id<"activities">,
) {
	for (let step = 0; step < 300; step++) {
		const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		if (run?.step !== "select" && run?.step !== "normalize") return;
		const activity = await t.run((ctx) => ctx.db.get("activities", activityId));
		if (!activity || !activities_is_active(activity.status)) return;
		await t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Copy selection did not finish");
}

async function start_transfer(
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">,
	args: FunctionArgs<typeof api.files_transfer.start>,
) {
	const started = await t.mutation(api.files_transfer.start, {
		...args,
		...(args.kind === "copy"
			? { expectedSourceCount: args.sourceIds.length, sourceIds: args.sourceIds.slice(0, 100) }
			: {}),
	});
	if (started._nay || args.kind === "move") return started;
	const runId = started._yay.runId;
	for (let offset = 100; offset < args.sourceIds.length; offset += 100) {
		expect(
			await t.mutation(api.files_transfer.append_sources, {
				membershipId: args.membershipId,
				runId,
				offset,
				sourceIds: args.sourceIds.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	}
	expect(await t.mutation(api.files_transfer.seal, { membershipId: args.membershipId, runId })).toEqual({ _yay: null });
	await finish_selection(t, runId, started._yay.activityId);
	return started;
}

async function start_agent_transfer(
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">,
	args: FunctionArgs<typeof internal.files_transfer.start_for_agent>,
) {
	const started = await t.mutation(internal.files_transfer.start_for_agent, {
		...args,
		...(args.kind === "copy" ? { expectedSourceCount: args.sources.length, sources: args.sources.slice(0, 100) } : {}),
	});
	if (started._nay || args.kind === "move") return started;
	const runId = started._yay.runId;
	for (let offset = 100; offset < args.sources.length; offset += 100) {
		expect(
			await t.mutation(internal.files_transfer.append_sources_for_agent, {
				membershipId: args.membershipId,
				threadId: args.threadId,
				runId,
				offset,
				sources: args.sources.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	}
	expect(
		await t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: args.membershipId,
			threadId: args.threadId,
			runId,
		}),
	).toEqual({ _yay: null });
	await finish_selection(t, runId, started._yay.activityId);
	return started;
}

async function start_copy(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, sourceIds: Id<"files_nodes">[]) {
	const started = await start_transfer(fixture.asUser, {
		membershipId: fixture.db.membershipId,
		requestId: "copy-request",
		kind: "copy",
		sourceIds,
		targetParentId: fixture.folders.get("/target")!,
	});
	if (started._nay) throw new Error(started._nay.message);
	return started._yay.runId;
}

async function finish_discovery(
	fixture: Awaited<ReturnType<typeof create_folder_fixture>>,
	runId: Id<"files_transfer_runs">,
) {
	for (let step = 0; step < 150; step += 1) {
		const view = await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId });
		if (!view) throw new Error("Missing run");
		if (view.step === "apply" || (view.activity.status !== "queued" && view.activity.status !== "running")) return view;
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
		if (view.activity.status !== "queued" && view.activity.status !== "running" && view.activity.status !== "stopping")
			return view;
		await fixture.t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Folder copy did not finish");
}

async function finish_copy_worker(
	fixture: Awaited<ReturnType<typeof create_folder_fixture>>,
	item: Doc<"files_transfer_items">,
) {
	if (!item.workId) throw new Error("Missing queued copy worker");
	await fixture.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
	await fixture.t.mutation(internal.files_transfer.handle_copy_complete, {
		workId: item.workId,
		context: { itemId: item._id, attempt: item.attempt },
		result: { kind: "success", returnValue: null },
	});
}

// File children run on queued workers. Drive each one until the run settles.
async function finish_copy_with_workers(
	fixture: Awaited<ReturnType<typeof create_folder_fixture>>,
	runId: Id<"files_transfer_runs">,
) {
	for (let step = 0; step < 300; step += 1) {
		const view = await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId });
		if (!view) throw new Error("Missing run");
		if (view.activity.status !== "queued" && view.activity.status !== "running" && view.activity.status !== "stopping")
			return view;
		const items = await fixture.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		const working = items.find((item) => item.workId !== null);
		if (working) {
			await finish_copy_worker(fixture, working);
		} else {
			await fixture.t.mutation(internal.files_transfer.advance, { runId });
		}
	}
	throw new Error("Copy did not finish");
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
		const first = await start_transfer(asUser, args);
		if (first._nay) throw new Error(first._nay.message);
		expect(await start_transfer(asUser, args)).toEqual(first);
		// The same request ID with other sources is a new request, not a retry of this one.
		expect((await start_transfer(asUser, { ...args, sourceIds: [folders.get("/source/child")!] }))._nay).toMatchObject({
			name: "request_changed",
			message: "This request ID was already used for another transfer",
		});
		expect((await start_transfer(asUser, { ...args, requestId: "another-request" }))._nay?.message).toBe(
			"A transfer is already running in this workspace",
		);
		expect(await asUser.query(api.files_transfer.list_current, { membershipId: db.membershipId })).toMatchObject([
			{
				_id: first._yay.runId,
				step: "discover",
				activity: { status: "running", progress: { discovered: 1, total: null } },
				controls: { canStop: true, canRetry: false, canDismiss: false },
			},
		]);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_transfer_runs").collect()).toHaveLength(1);
			expect((await ctx.db.query("files_transfer_items").collect()).map((item) => item.source.id)).toEqual([
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
		expect(refused._nay?.message).toBe("A folder cannot be transferred inside itself");
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(0);
		expect((await get_node(fixture, "/source"))?._id).toBe(folders.get("/source"));
	});

	test("rejects a paste into an archived folder", async () => {
		const fixture = await create_folder_fixture(["/source", "/archived-target"]);
		const { t, db, asUser, folders } = fixture;
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folders.get("/archived-target")!],
		});
		if (archived._nay) throw new Error(archived._nay.message);

		const refused = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "archived-target",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/archived-target")!,
		});
		expect(refused._nay?.message).toBe("Destination changed");
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(0);
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
			(await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId }))?.activity
				.status,
		).toBe("running");
	});
	test.each([200, 201])("starts a copy of %s selected roots across intake pages", async (count) => {
		const paths = Array.from({ length: count }, (_entry, index) => `/root-${index.toString().padStart(3, "0")}`);
		const fixture = await create_folder_fixture(paths);
		const { t, db, asUser, folders } = fixture;
		const started = await start_transfer(asUser, {
			membershipId: db.membershipId,
			requestId: "root-limit",
			kind: "copy",
			sourceIds: paths.map((path) => folders.get(path)!),
			targetParentId: folders.get("/target")!,
		});

		expect(started._nay).toBeUndefined();
		if (started._nay) return;
		expect(
			await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toMatchObject({ step: "discover", activity: { progress: { discovered: count } } });
		expect(await t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toHaveLength(count);
	});
});

describe("start_for_agent", () => {
	test("cross-workspace Copy keeps three real worker attempts", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/retry.txt",
			textContent: "Keep all retries\n",
		});
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "retry-count",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "retry-count",
			kind: "copy",
			sources: [{ kind: "saved", id: sourceId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		const enqueueAction = vi.spyOn(Workpool.prototype, "enqueueAction").mockClear();
		for (let worker = 1; worker <= 3; worker++) {
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.unique(),
			);
			expect(item?.workId, `Worker ${worker} must be queued`).not.toBeNull();
			if (!item?.workId) throw new Error("Expected a queued worker");
			if (worker < 3)
				await t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "failed", error: "Temporary storage failure" },
				});
			else await finish_copy_worker(fixture, item);
		}
		expect(enqueueAction).toHaveBeenCalledTimes(3);
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({ archiveOperationId: null });
	});

	test.each([false, true])(
		"reserves every cross-workspace file draft before starting content workers, selected media: %s",
		async (withMedia) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const sources: Array<{ kind: "saved"; id: Id<"files_nodes"> }> = [];
			for (const path of ["/document.txt", "/other.txt"]) {
				const created = await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path,
					textContent: `${path}\n`,
				});
				sources.push({ kind: "saved", id: created });
			}
			let mediaId: Id<"files_nodes"> | null = null;
			if (withMedia) {
				const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: files_ROOT_ID,
					filename: "image.png",
					contentType: "image/png",
					size: 3,
				});
				if (upload._nay) throw new Error(upload._nay.message);
				mediaId = upload._yay.nodeId;
				sources.push({ kind: "saved", id: mediaId });
				const key = r2_create_asset_key({ ...db, assetId: upload._yay.assetId });
				r2Objects.set(key, new Uint8Array([1, 2, 3]));
				await t.run((ctx) =>
					ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: key, unfinalizedExpiresAt: undefined }),
				);
				vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
					r2Objects.set(args.destinationKey, r2Objects.get(args.sourceKey)!);
					return { outcome: "copied", size: 3, etag: "copied" };
				});
			}
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "reserve-copy",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const enqueueAction = vi.spyOn(Workpool.prototype, "enqueueAction").mockClear();
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "reserve-copy",
				kind: "copy",
				sources,
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect((await finish_discovery(fixture, started._yay.runId)).step).toBe("apply");
			expect(enqueueAction).not.toHaveBeenCalled();
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.collect(),
			);
			expect(items).toHaveLength(sources.length);
			for (const item of items) {
				expect(item.state).toBe(item.source.id === mediaId ? "pending" : "waiting_media");
				expect(item.preparation).not.toBeNull();
				expect(item.workId).toBeNull();
			}
			expect(new Set(items.map((item) => item.preparation?.privateNodeId)).size).toBe(sources.length);
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			expect(enqueueAction).toHaveBeenCalledTimes(1);
			if (withMedia) {
				const working = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_state_order", (q) => q.eq("runId", started._yay.runId).eq("state", "copying"))
						.unique(),
				);
				expect(working?.source.id).toBe(mediaId);
			}
			expect((await finish_copy_with_workers(fixture, started._yay.runId)).activity).toMatchObject({
				status: "succeeded",
				progress: { completed: sources.length, failed: 0 },
			});
		},
	);

	test.each(["current", "personal"] as const)(
		"copies folders from %s to the other workspace as private proposals",
		async (sourceWorkspace) => {
			const fixture = await create_folder_fixture([]);
			const { t, db, asUser } = fixture;
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "cross-workspace-copy",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: db.userId,
				membershipId: db.membershipId,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const destinationWorkspace = sourceWorkspace === "current" ? "personal" : "current";
			const source = captured._yay[sourceWorkspace];
			const destination = captured._yay[destinationWorkspace];
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: db.userId,
				path: "/cross-source/child",
			});
			if (created._nay) throw new Error(created._nay.message);
			const sourceFolder = await t.run((ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", source.organizationId)
							.eq("workspaceId", source.workspaceId)
							.eq("path", "/cross-source")
							.eq("archiveOperationId", null),
					)
					.unique(),
			);
			if (!sourceFolder) throw new Error("Missing source folder");
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace,
				destinationWorkspace,
				requestId: "cross-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: sourceFolder._id }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const finished = await finish_folder_copy(fixture, started._yay.runId);
			expect(finished.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, failed: 0 } });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", started._yay.runId))).toMatchObject({
				workspaceId: db.workspaceId,
				sourceScope: { workspaceId: source.workspaceId, membershipId: source.membershipId },
				destinationScope: { workspaceId: destination.workspaceId, membershipId: destination.membershipId },
			});
			const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(drafts).toHaveLength(2);
			for (const draft of drafts)
				expect(draft).toMatchObject({
					organizationId: destination.organizationId,
					workspaceId: destination.workspaceId,
					userId: db.userId,
					state: "active",
				});
			expect(drafts.map((draft) => draft.name)).toEqual(["cross-source", "child"]);
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			const items = await asUser.query(api.files_transfer.list_items, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
				paginationOpts: { numItems: 20, cursor: null },
			});
			expect(items?.page).toHaveLength(2);
		},
	);

	test.each([false, true])(
		"a viewer can copy to home, but old work stays stopped after leave and re-invite: %s",
		async (reinvite) => {
			const fixture = await create_folder_fixture(["/source"]);
			const { t, db, asUser, folders } = fixture;
			const visitor = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			expect(
				await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userIdToAdd: visitor.userId,
				}),
			).toEqual({ _yay: null });
			const organization = await t.run((ctx) => ctx.db.get("organizations", db.organizationId));
			if (!organization?.defaultWorkspaceId) throw new Error("Missing primary workspace");
			expect(
				await asUser.mutation(api.access_control.set_user_role, {
					organizationId: db.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					userId: visitor.userId,
					role: "viewer",
				}),
			).toEqual({ _yay: null });
			const member = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("userId", visitor.userId).eq("active", true),
					)
					.unique(),
			);
			if (!member) throw new Error("Missing invited membership");
			const asVisitor = t.withIdentity({ issuer: "https://clerk.test", external_id: visitor.userId });
			const thread = await asVisitor.mutation(api.ai_chat.thread_create, {
				membershipId: member._id,
				clientGeneratedId: "viewer-transfer",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: member._id,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "viewer-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			let membershipId = member._id;
			if (reinvite) {
				expect(
					await asVisitor.mutation(api.organizations.remove_user_from_organization, {
						organizationId: db.organizationId,
						userIdToRemove: visitor.userId,
					}),
				).toEqual({ _yay: null });
				expect(
					await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userIdToAdd: visitor.userId,
					}),
				).toEqual({ _yay: null });
				const rejoined = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", db.workspaceId).eq("userId", visitor.userId).eq("active", true),
						)
						.unique(),
				);
				if (!rejoined) throw new Error("Missing rejoined membership");
				membershipId = rejoined._id;
			}
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const finished = await finish_folder_copy(
				{ ...fixture, db: { ...db, userId: visitor.userId, membershipId }, asUser: asVisitor },
				started._yay.runId,
			);
			expect(finished.activity.status).toBe(reinvite ? "failed" : "succeeded");
			if (reinvite) expect(finished.activity.errorMessage).toBe("Permission denied");
			const drafts = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(drafts).toHaveLength(reinvite ? 0 : 1);
			if (!reinvite)
				expect(drafts[0]).toMatchObject({ workspaceId: visitor.workspaceId, userId: visitor.userId, name: "source" });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test.each(["writePolicy", "newChildWritePolicy"] as const)(
		"refuses a copied folder's %s when its writer has no destination access",
		async (field) => {
			const fixture = await create_folder_fixture(["/source"]);
			const { t, db, asUser, folders } = fixture;
			const member = await add_member(fixture);
			const writePolicy = { mode: "writer" as const, writer: { kind: "user" as const, userId: member.userId } };
			const policyResult =
				field === "writePolicy"
					? await asUser.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: db.membershipId,
							nodeId: folders.get("/source")!,
							writePolicy,
						})
					: await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
							membershipId: db.membershipId,
							nodeId: folders.get("/source")!,
							newChildWritePolicy: writePolicy,
						});
			if (policyResult._nay) throw new Error(policyResult._nay.message);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "copied-writer",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				requestId: "writer-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect((await finish_folder_copy(fixture, started._yay.runId)).activity).toMatchObject({
				status: "failed",
				progress: { completed: 0, failed: 1 },
			});
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.collect(),
			);
			expect(items[0]?.errorMessage).toBe(
				"The copied protection names a writer who cannot edit this destination. Change the source rule or pick a writer with access first.",
			);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", folders.get("/source")!))).toMatchObject({
				[field]: writePolicy,
				archiveOperationId: null,
			});
		},
	);

	test.each(["", ".", "../hidden", "nested/name", "nested\\name"])(
		"rejects a destination that is not one name: %j",
		async (targetName) => {
			const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "transfer-name-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "invalid-name",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(await t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
				status: "failed",
				errorMessage: "Invalid destination name",
				progress: { completed: 0 },
			});
			expect(await t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
			expect((await t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual([
				"/source",
				"/target",
			]);
		},
	);
});

describe("transfers of a background job", () => {
	/**
	 * A folder fixture plus one job row of the user, started through the real door.
	 */
	async function create_job_fixture() {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser } = fixture;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "transfer-job-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const scope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			threadId: thread._yay.threadId,
		};
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: db.userId,
			membershipId: db.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...scope,
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "job-parent",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh call");
		const started = await t.mutation(internal.ai_chat_files.start_bash_job, {
			parentInvocationId: begun._yay.invocationId,
			commandNumber: 0,
			shellId: begun._yay.shell._id,
			script: "cp -R source target",
			startCwd: "/",
			startCwdTarget: null,
			shellState: {
				env: [],
				arrays: [],
				options: {},
				shoptOptions: {},
				readonlyVars: [],
				associativeArrays: [],
				namerefs: [],
				boundNamerefs: [],
				invalidNamerefs: [],
				integerVars: [],
				lowercaseVars: [],
				uppercaseVars: [],
				exportedVars: [],
				declaredVars: [],
				functions: [],
				previousDir: "/",
				directoryStack: [],
				lastExitCode: 0,
				lastArg: "",
				openFileDescriptors: [],
			},
			allowDbFilesMkdir: true,
		});
		if (started._nay) throw new Error(started._nay.message);
		const job = await t.run(async (ctx) =>
			(await ctx.db.query("ai_chat_bash_invocations").collect()).find((row) => row.job?.jobNumber === 1),
		);
		if (!job) throw new Error("Expected the job row");
		const copy = async (commandNumber: number) =>
			await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: scope.threadId,
				invocation: { id: job._id, commandNumber },
				requestId: `job-copy-${commandNumber}`,
				kind: "copy",
				sources: [{ kind: "saved", id: fixture.folders.get("/source")! }],
				targetParent: { kind: "saved", id: fixture.folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
		return { ...fixture, scope, job, copy };
	}

	test("hides the job's transfer from the feed, also after a retry, and the lane query sees it", async () => {
		const f = await create_job_fixture();
		const laneArgs = { membershipId: f.db.membershipId, threadId: f.scope.threadId };
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toBeNull();
		const started = await f.copy(0);
		if (started._nay) throw new Error(started._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
			feedVisible: false,
			status: "running",
		});
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toEqual({
			activityId: started._yay.activityId,
			status: "running",
		});
		// The lane query is fenced on the membership and the thread's owner.
		const other = await add_member(f);
		expect(
			await f.t.query(internal.files_transfer.get_current_activity_for_agent, {
				membershipId: other.membershipId,
				threadId: f.scope.threadId,
			}),
		).toBeNull();

		// Retry needs a finished discovery, so stop only after it.
		await finish_discovery(f, started._yay.runId);
		await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId: started._yay.runId });
		await finish_folder_copy(f, started._yay.runId);
		expect(await f.t.query(internal.files_transfer.get_current_activity_for_agent, laneArgs)).toBeNull();
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.db.membershipId,
			runId: started._yay.runId,
			requestId: "job-copy-retry",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("activities", retried._yay.activityId))).toMatchObject({
			feedVisible: false,
		});
	});

	test("refuses a new transfer once the job is stopping, but still answers a replayed one", async () => {
		const f = await create_job_fixture();
		const started = await f.copy(0);
		if (started._nay) throw new Error(started._nay.message);
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(true);
		expect((await f.copy(1))._nay).toMatchObject({ name: "stopped" });
		expect((await f.copy(0))._yay).toMatchObject({ runId: started._yay.runId, activityId: started._yay.activityId });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
	});
});

describe("advance", () => {
	test("finishes canceled when the only preparing leaf is discarded", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/report.txt",
			textContent: "Source report\n",
		});
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "discard-only-copy-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "discard-only-copy",
			kind: "copy",
			sources: [{ kind: "saved", id: sourceId }],
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.unique(),
		);
		if (!item?.preparation || !item.workId) throw new Error("Expected a preparing file worker");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", item.preparation!.pendingUpdateId));
		if (!proposal) throw new Error("Expected its proposal");
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: db.membershipId,
					target: proposal.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "canceled" },
		});
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "canceled",
			progress: { total: 1, completed: 0, failed: 0, blocked: 0, canceled: 1 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
			state: "canceled",
			cancelReason: "proposal_discard",
			outputTarget: null,
		});
		expect(await get_node(fixture, "/target/report.txt")).toBeNull();
		expect((await get_node(fixture, "/source/report.txt"))?._id).toBe(sourceId);
	});

	test("a later lock on a copied parent refuses the next child", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(copiedParent).not.toBeNull();
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const finished = await finish_folder_copy(fixture, runId);
		expect(finished.activity.status).toBe("partial");
		expect(await get_node(fixture, "/target/source/child.txt")).toBeNull();
		const failedChild = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(failedChild.some((item) => item.sourcePath === "/source/child.txt" && item.state === "failed")).toBe(true);
	});

	test("copies children into a locked copy of a read-only folder", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/nested"]);
		const { t, db, asUser, folders } = fixture;
		for (const name of ["a.txt", "b.txt"]) {
			await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: `/source/${name}`,
				textContent: `${name}\n`,
			});
		}
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);

		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 4, completed: 4, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source")).toMatchObject({ writePolicy: { mode: "read_only" } });
		for (const path of ["/target/source/nested", "/target/source/a.txt", "/target/source/b.txt"]) {
			expect(await get_node(fixture, path)).not.toBeNull();
		}
	});

	test("still copies children after the produced parent's new-item default changes", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		// The default change moves the folder's revision but leaves it writable.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 2, completed: 2, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source/child.txt")).not.toBeNull();
	});

	test("still copies children after the produced parent is locked then unlocked", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		for (const writePolicy of [{ mode: "read_only" as const }, null]) {
			expect(
				(
					await asUser.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: db.membershipId,
						nodeId: copiedParent!._id,
						writePolicy,
					})
				)._nay,
			).toBeUndefined();
		}

		// The lock and unlock moved the revision twice, but the folder is writable again.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: 2, completed: 2, failed: 0 },
		});
		expect(await get_node(fixture, "/target/source/child.txt")).not.toBeNull();
	});

	test("fails children when the produced parent is locked with a different policy", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: folders.get("/source")!,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });

		const copiedParent = await get_node(fixture, "/target/source");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedParent!._id,
					writePolicy: { mode: "writer", writer: { kind: "user", userId: member.userId } },
				})
			)._nay,
		).toBeUndefined();

		// The copy kept the run's lock, but someone replaced it with a different one.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "partial",
			progress: { total: 2, completed: 1, failed: 1 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.find((entry) => entry.sourcePath === "/source/child.txt")).toMatchObject({
			state: "failed",
			errorMessage: "This item is read-only.",
		});
		expect(await get_node(fixture, "/target/source/child.txt")).toBeNull();
	});

	test("fails children copied into a merged folder that locks after the merge", async () => {
		const fixture = await create_folder_fixture(["/source", "/target/source"]);
		const { t, db, asUser, folders } = fixture;
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source/child.txt",
			textContent: "Child\n",
		});
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");

		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
				.unique(),
		);
		if (!item?.conflictTarget) throw new Error("Expected a destination conflict");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [
						{
							itemId: item._id,
							choice: "merge",
							reviewedTarget: item.conflictTarget,
							reviewedVersion: item.conflictVersion,
						},
					],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();

		// Finish the merge first, then lock the destination before children copy.
		for (let step = 0; step < 50; step += 1) {
			const merged = await t.run((ctx) => ctx.db.get("files_transfer_items", item._id));
			if (merged?.state === "completed") break;
			await t.mutation(internal.files_transfer.advance, { runId });
		}
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
			state: "completed",
			outcome: "merged",
		});
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: folders.get("/target/source")!,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		// The run did not write the merged folder's lock, so the child fails on the live check.
		const finished = await finish_copy_with_workers(fixture, runId);
		expect(finished.activity).toMatchObject({
			status: "partial",
			progress: { total: 2, completed: 1, failed: 1 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.find((entry) => entry.sourcePath === "/source/child.txt")).toMatchObject({
			state: "failed",
			errorMessage: "This item is read-only.",
		});
		expect(await get_node(fixture, "/target/source/child.txt")).toBeNull();
	});

	test.each([
		{ publication: "saved", destination: "fresh" },
		{ publication: "proposal", destination: "fresh" },
		{ publication: "saved", destination: "keep_both" },
		{ publication: "proposal", destination: "keep_both" },
		{ publication: "saved", destination: "merge" },
		{ publication: "proposal", destination: "merge" },
	] as const)("checks a finite descendant copy ($publication, $destination)", async ({ publication, destination }) => {
		const sourcePaths = ["/source", "/source/out", "/source/empty"];
		if (destination !== "fresh") sourcePaths.push("/source/out/source", "/source/out/source/child");
		const fixture = await create_folder_fixture(sourcePaths);
		const { t, db, asUser, folders } = fixture;
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "descendant-copy-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started =
			publication === "saved"
				? await start_transfer(asUser, {
						membershipId: db.membershipId,
						requestId: "descendant-copy",
						kind: "copy",
						sourceIds: [folders.get("/source")!],
						targetParentId: folders.get("/source/out")!,
					})
				: await start_agent_transfer(t, {
						membershipId: db.membershipId,
						sourceWorkspace: "current",
						destinationWorkspace: "current",
						threadId: thread._yay.threadId,
						requestId: "descendant-copy",
						kind: "copy",
						sources: [{ kind: "saved", id: folders.get("/source")! }],
						targetParent: { kind: "saved", id: folders.get("/source/out")! },
						targetPath: "/source/out",
						targetName: null,
						missingParentNames: [],
						conflictPolicy: { file: "replace", folder: destination === "keep_both" ? "ask" : "merge" },
					});
		expect(started._nay).toBeUndefined();
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const checked = await finish_discovery(fixture, runId);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		if (destination !== "fresh" && (publication === "saved" || destination === "keep_both")) {
			expect(checked.activity.status).toBe("awaiting_input");
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
					.unique(),
			);
			if (!item?.conflictTarget) throw new Error("Expected a destination conflict");
			const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId,
				revision: checked.revision,
				choices: [
					{
						itemId: item._id,
						choice: destination,
						reviewedTarget: item.conflictTarget,
						reviewedVersion: item.conflictVersion,
					},
				],
				applyToRemaining: { file: null, folder: null },
			});
			expect(resolved._nay).toBeUndefined();
		}
		const finished = await finish_folder_copy(fixture, runId);
		if (destination === "merge") {
			expect(finished.activity).toMatchObject({ status: "failed", progress: { completed: 0 } });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
			return;
		}
		expect(finished.activity).toMatchObject({
			status: "succeeded",
			progress: { total: sourcePaths.length, completed: sourcePaths.length, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.sourcePath).sort()).toEqual(sourcePaths.toSorted());
		const outputRoot = destination === "fresh" ? "/source/out/source" : "/source/out/source-copy-1";
		expect(items.map((item) => item.outputPath).sort()).toEqual(
			sourcePaths.map((path) => outputRoot + path.slice("/source".length)).sort(),
		);
		expect(items.every((item) => item.outputTarget?.kind === (publication === "saved" ? "saved" : "private"))).toBe(
			true,
		);
		if (publication === "proposal") expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		for (const path of sourcePaths) expect((await get_node(fixture, path))?._id).toBe(folders.get(path));
	});

	test.each([false, true])("refuses a merge into a copy source in any root order (reversed: %s)", async (reversed) => {
		const fixture = await create_folder_fixture(["/source", "/source/out", "/source/out/source", "/other"]);
		const { t, db, asUser, folders } = fixture;
		const fileId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/other/report.txt",
			textContent: "Report\n",
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		// The saved text file above leaves its own published draft, so compare against that state.
		const draftsBefore = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "merge-source-order-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const sources = [
			{ kind: "saved" as const, id: fileId },
			{ kind: "saved" as const, id: folders.get("/source")! },
		];
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "merge-source-order",
			kind: "copy",
			sources: reversed ? sources.toReversed() : sources,
			targetParent: { kind: "saved", id: folders.get("/source/out")! },
			targetPath: "/source/out",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "A copy cannot replace or merge into its sources",
		});
		// The refusal lands while the names are resolved, so the run never reaches a worker and the
		// order of the selected roots cannot change the outcome.
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.sourcePath).toSorted()).toEqual([
			"/other/report.txt",
			"/source",
			"/source/out",
			"/source/out/source",
		]);
		expect(items.every((item) => item.attempt === 0 && item.workId === null && item.outputTarget === null)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(draftsBefore);
	});

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
		expect(await finish_discovery(fixture, runId)).toMatchObject({
			step: "apply",
			activity: { status: "running", progress: { total: 4, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 4, completed: 4, failed: 0 } },
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
		await finish_discovery(fixture, runId);
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
					.withIndex("by_run_source", (q) => q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceId))
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
			activity: {
				status: "partial",
				progress: { total: 3, completed: 1, failed: 2 },
				errorMessage: "The source file is still saving. Try again.",
			},
		});
		const activities = (
			await asUser.query(api.activities.list_page, {
				membershipId: db.membershipId,
				section: "history",
				paginationOpts: { cursor: null, numItems: 50 },
			})
		).page;
		expect(activities.find((activity) => activity.source.id === runId)).toMatchObject({
			status: "partial",
			errorMessage: "The source file is still saving. Try again.",
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(copiedFolder!._id);
		expect(await get_node(fixture, "/target/source/first.bin")).toBeNull();
		expect(await get_node(fixture, "/target/source/second.bin")).toBeNull();
	});

	test("keeps at most two file copies in flight", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		for (const filename of ["first.bin", "second.bin", "third.bin"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename,
				contentType: "application/octet-stream",
				size: 8,
			});
			if (file._nay) throw new Error(file._nay.message);
		}
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);

		const read_items = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
		// Copy shares two worker slots with review preparation, so more advances must not queue a
		// third file.
		for (let step = 0; step < 10; step += 1) await t.mutation(internal.files_transfer.advance, { runId });
		const queued = await read_items();
		expect(queued.filter((item) => item.workId !== null)).toHaveLength(2);
		expect(queued.filter((item) => item.state === "pending" && item.workId === null)).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ inFlight: 2 });

		// One finished worker frees one slot, so the waiting file starts and the cap still holds.
		const waiting = queued.find((item) => item.state === "pending" && item.workId === null)!;
		const running = queued.find((item) => item.workId !== null)!;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: running._id, attempt: running.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: running.workId!,
			context: { itemId: running._id, attempt: running.attempt },
			result: { kind: "success", returnValue: null },
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		const after = await read_items();
		expect(after.find((item) => item._id === waiting._id)?.workId).not.toBeNull();
		expect(after.filter((item) => item.workId !== null)).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ inFlight: 2 });
	});

	test("discovers more than one page before creating any output", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			step: "discover",
			activity: { status: "running", progress: { discovered: 51, total: null, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 56, total: null });
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 56, completed: 56 } },
		});
		for (const path of paths) expect(await get_node(fixture, `/target${path}`)).not.toBeNull();
	});

	test("copies a child added between discovery pages only when it sorts after the cursor", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 51, total: null });

		// Discovery pages the children by name, so the first page stopped after "folder-49". A name added
		// after that point is still ahead of the cursor and joins the copy. A name added before it is
		// already behind the cursor and the second page never sees it. Either way the copy stays whole:
		// a child is copied completely or not at all, and neither name is copied twice.
		for (const path of ["late-after-cursor", "early-before-cursor"]) {
			expect(
				(
					await asUser.mutation(api.files_nodes.create_folder_node, {
						membershipId: db.membershipId,
						parentId: folders.get("/source")!,
						path,
					})
				)._nay,
			).toBeUndefined();
		}

		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.progress,
		).toMatchObject({ discovered: 57, total: null });
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 57, completed: 57 } },
		});
		expect(await get_node(fixture, "/target/source/late-after-cursor")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/early-before-cursor")).toBeNull();
		for (const path of paths) expect(await get_node(fixture, `/target${path}`)).not.toBeNull();
	});

	test("asks for a choice when a discovered child moves out between discovery pages", async () => {
		const paths = Array.from({ length: 55 }, (_entry, index) => `/source/folder-${index.toString().padStart(2, "0")}`);
		const fixture = await create_folder_fixture(["/source", ...paths]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			(
				await asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: db.membershipId,
					itemIds: [folders.get("/source/folder-00")!],
					targetParentId: folders.get("/target")!,
				})
			)._nay,
		).toBeUndefined();

		// The second page finishes the root, then discovery reaches the moved child and finds it at a new
		// path. The run stops and asks the user instead of copying from where the child used to be.
		await t.mutation(internal.files_transfer.advance, { runId });
		await t.mutation(internal.files_transfer.advance, { runId });
		const view = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		expect(view).toMatchObject({
			step: "discover",
			activity: { status: "awaiting_input", progress: { discovered: 56, total: null, completed: 0, blocked: 1 } },
			conflicts: [{ kind: "source_changed", sourceName: null }],
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
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
		const started = await start_transfer(member.asUser, {
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
		expect(view).toMatchObject({
			activity: { status: "failed", progress: { completed: 0 }, errorMessage: "Permission denied" },
		});
		expect(JSON.stringify(view)).not.toContain("hidden-name");
		expect(await get_node(fixture, "/target/source")).toBeNull();
	});

	// A member's running copy must stop when they are removed and invited again, because the invite
	// makes a new membership doc and the run belongs to the old one. The control keeps the same
	// member and the same copy, so only the re-invite can change the result.
	test.each([
		{ label: "keeps copying for a member who stayed in the workspace", reinvited: false },
		{ label: "stops copying for a member who was removed and invited again", reinvited: true },
	])("$label", async ({ reinvited }) => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, folders } = fixture;
		const member = await add_member(fixture);
		const started = await start_transfer(member.asUser, {
			membershipId: member.membershipId,
			requestId: "re-invited",
			kind: "copy",
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;

		if (reinvited) {
			await t.run(async (ctx) => {
				await ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: member.userId,
					active: true,
					updatedAt: Date.now(),
				});
				const membership = await ctx.db.get("organizations_workspaces_users", membershipId);
				if (!membership) throw new Error("Missing membership");
				expect(await organizations_membership_lifetimes_db_ensure(ctx, membership)).toBe(2);
			});
		}

		const read_activity = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", runId))
					.unique(),
			);
		for (let step = 0; step < 40; step += 1) {
			const activity = await read_activity();
			if (activity && !activities_is_active(activity.status)) break;
			await t.mutation(internal.files_transfer.advance, { runId });
		}

		if (reinvited) {
			expect(await read_activity()).toMatchObject({
				status: "failed",
				errorMessage: "Permission denied",
				progress: { completed: 0, canceled: 1 },
			});
			expect(await get_node(fixture, "/target/source")).toBeNull();
			return;
		}

		expect(await read_activity()).toMatchObject({ status: "succeeded", errorMessage: null });
		expect(await get_node(fixture, "/target/source/child")).not.toBeNull();
	});

	test("does not copy descendants added after discovery finishes", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/first"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(
			(
				await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: folders.get("/source")!,
					path: "later",
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 2, completed: 2 } },
		});
		expect(await get_node(fixture, "/target/source/first")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/later")).toBeNull();
	});

	test("gives a run waiting for a choice a much later deadline than a copying run", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child", "/target/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const read_deadline = async () =>
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))!.activity;

		const copying = await read_deadline();
		expect(copying.status).toBe("running");
		// A copy must not sit idle for long, so its deadline is half an hour.
		expect(copying.deadlineAt - Date.now()).toBe(30 * 60 * 1000);

		for (let step = 0; step < 50; step += 1) {
			if ((await read_deadline()).status === "awaiting_input") break;
			await t.mutation(internal.files_transfer.advance, { runId });
		}
		// Waiting for a person is different work, so the question gets a whole day of its own.
		const waiting = await read_deadline();
		expect(waiting.status).toBe("awaiting_input");
		expect(waiting.deadlineAt - Date.now()).toBe(24 * 60 * 60 * 1000);
	});

	test("keeps the job status and the counters on the Activity alone at every transition", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser } = fixture;
		// The copy of "asks.txt" meets an occupant in /target and asks; the answer is Skip. Its sibling
		// copies for real, so the run passes through a question and a worker before it finishes.
		const sourceIds: Id<"files_nodes">[] = [];
		for (const path of ["/source/asks.txt", "/source/copies.txt", "/target/asks.txt"]) {
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path,
				textContent: `Report for ${path}\n`,
			});
			if (path.startsWith("/source/")) sourceIds.push(nodeId);
		}
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "activity-transitions",
			kind: "copy",
			expectedSourceCount: sourceIds.length,
			sourceIds,
			targetParentId: fixture.folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});

		// The Activity owns the job status and the counters. The run doc must never grow its own copy,
		// and the counters must always match a fresh count of the items, so nothing can drift apart.
		const activityOwnedFields = ["status", "progress", "completed", "skipped", "failed", "canceled", "blocked"];
		const statusesSeen = new Set<string>();
		const read_both = async () => {
			const view = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
			if (!view) throw new Error("Missing run");
			const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			const count = (state: Doc<"files_transfer_items">["state"]) =>
				items.filter((item) => item.state === state).length;

			statusesSeen.add(view.activity.status);
			expect(Object.keys(run!).filter((field) => activityOwnedFields.includes(field))).toEqual([]);
			expect(view.activity.progress).toMatchObject({
				discovered: items.length,
				completed: count("completed"),
				skipped: count("skipped"),
				failed: count("failed"),
				canceled: count("canceled"),
				blocked: count("conflict"),
			});
			return { view, items };
		};

		let current = await read_both();
		for (let step = 0; step < 50 && current.view.activity.status !== "awaiting_input"; step += 1) {
			await t.mutation(internal.files_transfer.advance, { runId });
			current = await read_both();
		}
		expect(current.view.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: current.view.revision,
					choices: [{ itemId: current.view.conflicts[0]!.itemId, choice: "skip" as const }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();

		current = await read_both();
		for (let step = 0; step < 50 && activities_is_active(current.view.activity.status); step += 1) {
			const queued = current.items.find((item) => item.state === "copying" && item.workId !== null);
			if (queued) await finish_copy_worker(fixture, queued);
			else await t.mutation(internal.files_transfer.advance, { runId });
			current = await read_both();
		}

		// The run really passed through all four states, so the checks above are not one repeated state.
		expect([...statusesSeen].toSorted()).toEqual(["awaiting_input", "queued", "running", "succeeded"]);
		expect(current.view.activity.progress).toMatchObject({ total: 2, completed: 1, skipped: 1, failed: 0 });
	});
});

describe("resolve_conflicts", () => {
	test.each([
		{ firstWorker: "first", outsideCollision: false, occupiedOriginal: false },
		{ firstWorker: "second", outsideCollision: false, occupiedOriginal: false },
		{ firstWorker: "second", outsideCollision: true, occupiedOriginal: false },
		{ firstWorker: "first", outsideCollision: true, occupiedOriginal: true },
	] as const)(
		"keeps file claims when the $firstWorker worker finishes first (outside collision: $outsideCollision, occupied original: $occupiedOriginal)",
		async ({ firstWorker, outsideCollision, occupiedOriginal }) => {
			const fixture = await create_folder_fixture(["/a", "/b"]);
			const { t, db, asUser } = fixture;
			const sourceIds: Id<"files_nodes">[] = [];
			for (const folder of ["a", "b"]) {
				sourceIds.push(
					await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: `/${folder}/report.txt`,
						textContent: `Report ${folder}: café 😀\n`,
					}),
				);
			}
			const originalId = occupiedOriginal
				? await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: "/target/report.txt",
						textContent: "Original report: résumé\n",
					})
				: null;
			const runId = await start_copy(fixture, sourceIds);
			const waiting = await finish_discovery(fixture, runId);
			expect(waiting.activity.status).toBe("awaiting_input");
			expect(waiting.conflicts).toHaveLength(occupiedOriginal ? 2 : 1);
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: waiting.conflicts.map((conflict) => ({ itemId: conflict.itemId, choice: "keep_both" as const })),
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			await finish_discovery(fixture, runId);
			const planned = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(planned.map((item) => item.plannedPath)).toEqual(
				occupiedOriginal
					? ["/target/report-copy-1.txt", "/target/report-copy-2.txt"]
					: ["/target/report.txt", "/target/report-copy-1.txt"],
			);
			// Another write may occupy a planned name before either file worker publishes.
			const outsideId = outsideCollision
				? await test_create_saved_text_file(t, {
						membershipId: db.membershipId,
						path: "/target/report-copy-1.txt",
						textContent: "Outside report: résumé\n",
					})
				: null;
			await t.mutation(internal.files_transfer.advance, { runId });
			await t.mutation(internal.files_transfer.advance, { runId });
			const queued = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(queued.every((item) => item.state === "copying" && item.workId)).toBe(true);
			for (const item of firstWorker === "first" ? queued : queued.toReversed()) {
				await finish_copy_worker(fixture, item);
			}
			const finished = await finish_folder_copy(fixture, runId);
			expect(finished.activity).toMatchObject({
				status: "succeeded",
				progress: { completed: 2, total: 2, failed: 0, blocked: 0 },
			});
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			const outputPaths = occupiedOriginal
				? ["/target/report-copy-3.txt", "/target/report-copy-2.txt"]
				: ["/target/report.txt", `/target/report-copy-${outsideCollision ? 2 : 1}.txt`];
			expect(items.map((item) => item.outputPath)).toEqual(outputPaths);
			for (const [index, path] of outputPaths.entries()) {
				const copied = await get_node(fixture, path);
				expect(items[index]).toMatchObject({
					source: { kind: "saved", id: sourceIds[index] },
					outputTarget: { kind: "saved", id: copied!._id },
				});
				expect(sourceIds).not.toContain(copied!._id);
				const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", copied!.assetId!));
				const bytes = r2Objects.get(asset!.r2Key!);
				expect(bytes).toBeDefined();
				expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(
					new TextEncoder().encode(`Report ${index === 0 ? "a" : "b"}: café 😀\n`),
				);
			}
			for (const outsideFile of [
				{ id: originalId, path: "/target/report.txt", text: "Original report: résumé\n" },
				{ id: outsideId, path: "/target/report-copy-1.txt", text: "Outside report: résumé\n" },
			]) {
				if (!outsideFile.id) continue;
				const outside = await get_node(fixture, outsideFile.path);
				expect(outside?._id).toBe(outsideFile.id);
				const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", outside!.assetId!));
				const bytes = r2Objects.get(asset!.r2Key!);
				expect(bytes).toBeDefined();
				expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(
					new TextEncoder().encode(outsideFile.text),
				);
			}
		},
	);

	test.each(["saved", "proposal"] as const)("refuses duplicate file Replace before %s output", async (publication) => {
		const fixture = await create_folder_fixture(["/a", "/b"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const folder of ["a", "b"]) {
			sourceIds.push(
				await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: `/${folder}/report.txt`,
					textContent: `Report ${folder}\n`,
				}),
			);
		}
		const targetId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/target/report.txt",
			textContent: "Target report\n",
		});
		const before = await t.run((ctx) => ctx.db.get("files_nodes", targetId));
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-file-replace-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started =
			publication === "saved"
				? await start_transfer(asUser, {
						membershipId: db.membershipId,
						requestId: "duplicate-file-replace",
						kind: "copy",
						sourceIds,
						targetParentId: folders.get("/target")!,
					})
				: await start_agent_transfer(t, {
						membershipId: db.membershipId,
						sourceWorkspace: "current",
						destinationWorkspace: "current",
						threadId: thread._yay.threadId,
						requestId: "duplicate-file-replace",
						kind: "copy",
						sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
						targetParent: { kind: "saved", id: folders.get("/target")! },
						targetPath: "/target",
						targetName: null,
						missingParentNames: [],
						conflictPolicy: { file: "replace", folder: "merge" },
					});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		if (publication === "saved") {
			const waiting = await finish_discovery(fixture, runId);
			expect(waiting.conflicts).toHaveLength(2);
			const items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: items.map((item) => ({
							itemId: item._id,
							choice: "replace" as const,
							reviewedTarget: item.conflictTarget!,
							reviewedVersion: item.conflictVersion,
						})),
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
		}
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "Several sources use the same destination",
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", targetId))).toEqual(before);
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.every((item) => item.attempt === 0 && item.outputTarget === null)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test.each([false, true])("file -n keeps the first argument (reversed: %s)", async (reversed) => {
		const fixture = await create_folder_fixture(["/a", "/b"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const folder of ["a", "b"]) {
			sourceIds.push(
				await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: `/${folder}/report.txt`,
					textContent: `Report ${folder}: café 😀\n`,
				}),
			);
		}
		if (reversed) sourceIds.reverse();
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-file-skip-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "duplicate-file-skip",
			kind: "copy",
			sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "skip", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!item) throw new Error("Expected the first file");
		await finish_copy_worker(fixture, item);
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, skipped: 1, total: 2, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => item.source.id)).toEqual(sourceIds);
		expect(items[0]).toMatchObject({ state: "completed", outputPath: "/target/report.txt" });
		expect(items[1]).toMatchObject({ state: "skipped", attempt: 0, outputTarget: null, preparation: null });
		const output = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			overlayUserId: db.userId,
			path: "/target/report.txt",
			includePending: true,
		});
		expect(output?.target).toEqual(items[0]!.outputTarget);
		expect(new TextEncoder().encode(output?.content)).toEqual(
			new TextEncoder().encode(`Report ${reversed ? "b" : "a"}: café 😀\n`),
		);
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", output!.pendingUpdateId!));
		// These sources have no local lock. The copy still records that empty rule.
		expect(proposal?.copiedFrom).toEqual({
			target: { kind: "saved", id: sourceIds[0] },
			path: `/${reversed ? "b" : "a"}/report.txt`,
			sourceWritePolicy: null,
		});
		expect(await get_node(fixture, "/target/report.txt")).toBeNull();
	});

	test.each([false, true])("folder -Rn keeps the first duplicate branch (occupied: %s)", async (occupied) => {
		const fixture = await create_folder_fixture([
			"/a/report",
			"/a/report/first",
			"/b/report",
			"/b/report/second",
			...(occupied ? ["/target/report", "/target/report/keep"] : []),
		]);
		const { t, db, asUser, folders } = fixture;
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "duplicate-folder-skip-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await start_agent_transfer(t, {
			membershipId: db.membershipId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			threadId: thread._yay.threadId,
			requestId: "duplicate-folder-skip",
			kind: "copy",
			sources: [folders.get("/a/report")!, folders.get("/b/report")!].map((id) => ({ kind: "saved" as const, id })),
			targetParent: { kind: "saved", id: folders.get("/target")! },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "skip", folder: "merge" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2, skipped: 2, total: 4, failed: 0 },
		});
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.filter((item) => item.sourcePath.startsWith("/a/")).every((item) => item.state === "completed")).toBe(
			true,
		);
		expect(
			items
				.filter((item) => item.sourcePath.startsWith("/b/"))
				.every((item) => item.state === "skipped" && item.attempt === 0 && item.outputTarget === null),
		).toBe(true);
		const parent = items.find((item) => item.source.id === folders.get("/a/report"));
		if (occupied) {
			expect(parent?.outputTarget).toEqual({ kind: "saved", id: folders.get("/target/report") });
			expect((await get_node(fixture, "/target/report/keep"))?._id).toBe(folders.get("/target/report/keep"));
		} else {
			expect(parent?.outputTarget?.kind).toBe("private");
		}
		expect(await get_node(fixture, "/target/report/second")).toBeNull();
	});

	test.each([
		{ publication: "saved", extraRoots: 0 },
		{ publication: "proposal", extraRoots: 0 },
		{ publication: "saved", extraRoots: 50 },
		{ publication: "proposal", extraRoots: 50 },
	] as const)(
		"refuses duplicate claims on an occupied folder before $publication output ($extraRoots extra roots)",
		async ({ publication, extraRoots }) => {
			const otherPaths = Array.from({ length: extraRoots }, (_, index) => `/other-${index}`);
			const fixture = await create_folder_fixture([
				"/a/report",
				"/a/report/first",
				"/b/report",
				"/b/report/second",
				"/target/report",
				...otherPaths,
			]);
			const { t, db, asUser, folders } = fixture;
			const sources = ["/a/report", ...otherPaths, "/b/report"].map((path) => folders.get(path)!);
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "duplicate-claim-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started =
				publication === "saved"
					? await start_transfer(asUser, {
							membershipId: db.membershipId,
							requestId: "duplicate-claim",
							kind: "copy",
							sourceIds: sources,
							targetParentId: folders.get("/target")!,
						})
					: await start_agent_transfer(t, {
							membershipId: db.membershipId,
							sourceWorkspace: "current",
							destinationWorkspace: "current",
							threadId: thread._yay.threadId,
							requestId: "duplicate-claim",
							kind: "copy",
							sources: sources.map((id) => ({ kind: "saved" as const, id })),
							targetParent: { kind: "saved", id: folders.get("/target")! },
							targetPath: "/target",
							targetName: null,
							missingParentNames: [],
							conflictPolicy: { file: "replace", folder: "merge" },
						});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			if (publication === "saved") {
				const checked = await finish_discovery(fixture, runId);
				expect(checked.activity.status).toBe("awaiting_input");
				const conflicts = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_state_order", (q) => q.eq("runId", runId).eq("state", "conflict"))
						.collect(),
				);
				expect(conflicts).toHaveLength(2);
				const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: checked.revision,
					choices: conflicts.map((item) => ({
						itemId: item._id,
						choice: "merge" as const,
						reviewedTarget: item.conflictTarget!,
						reviewedVersion: item.conflictVersion,
					})),
					applyToRemaining: { file: null, folder: null },
				});
				expect(resolved._nay).toBeUndefined();
			}
			const finished = await finish_folder_copy(fixture, runId);
			expect(finished.activity).toMatchObject({ status: "failed", progress: { completed: 0 } });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		},
	);

	test("keeps the normalized README extension in copy names", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get(path)!,
				filename: "README.md",
				contentType: "text/markdown",
				size: 0,
			});
			if (file._nay) throw new Error(file._nay.message);
			fileIds.push(file._yay.nodeId);
		}
		// Keep a legacy source spelling to test the new destination name.
		await t.run((ctx) => ctx.db.patch("files_nodes", fileIds[0]!, { name: "readme", path: "/source/readme" }));
		const runId = await start_copy(fixture, [fileIds[0]!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", waiting.conflicts[0]!.itemId))).toMatchObject({
			plannedPath: "/target/readme-copy-1.md",
		});
	});

	test.each([
		// The rename rules turn ".env" into "untitled.env" first, so the copy name has no leading dot
		// left to keep. The extension is still read from the right place.
		{ label: "dotfile", sourceName: ".env", plannedPath: "/target/untitled-copy-1.env" },
		{ label: "extensionless", sourceName: "notes", plannedPath: "/target/notes-copy-1" },
		// No name rule caps the length, so this case only checks that a long multi-byte name still
		// becomes a legal Keep-both name: the accents are dropped, the name is not cut.
		{
			label: "long multi-byte",
			sourceName: `${"é".repeat(200)}.md`,
			plannedPath: `/target/${"e".repeat(200)}-copy-1.md`,
		},
	])("builds a legal Keep-both name for a $label source", async ({ sourceName, plannedPath }) => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const fileIds: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const file = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get(path)!,
				filename: "placeholder.md",
				contentType: "text/markdown",
				size: 0,
			});
			if (file._nay) throw new Error(file._nay.message);
			// The upload door has its own name rules, so write the fixture spelling directly.
			await t.run((ctx) =>
				ctx.db.patch("files_nodes", file._yay.nodeId, { name: sourceName, path: `${path}/${sourceName}` }),
			);
			fileIds.push(file._yay.nodeId);
		}
		const runId = await start_copy(fixture, [fileIds[0]!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", waiting.conflicts[0]!.itemId))).toMatchObject({
			plannedPath,
		});
	});

	test("refuses a copy when every counter up to the attempt limit is taken", async () => {
		const taken = Array.from({ length: 100 }, (_entry, index) => `/target/dup-copy-${index + 1}`);
		const fixture = await create_folder_fixture(["/dup", "/target/dup", ...taken]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/dup")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		// The 101 taken names use 101 of the 200 name lookups, so the 100-attempt limit answers first.
		// A wider selection runs out of lookups instead and gets the other message.
		expect((await finish_folder_copy(fixture, runId)).activity).toMatchObject({
			status: "failed",
			progress: { completed: 0 },
			errorMessage: "No free copy name found",
		});
		expect(await get_node(fixture, "/target/dup-copy-101")).toBeNull();
	});

	test("allocates a free counter for selected items with the same name", async () => {
		const fixture = await create_folder_fixture(["/first/report", "/second/report", "/target/report-copy-1"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/first/report")!, folders.get("/second/report")!]);
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.activity.status).toBe("awaiting_input");
		expect(waiting.conflicts).toHaveLength(1);
		expect(await get_node(fixture, "/target/report")).toBeNull();
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "keep_both" }],
					applyToRemaining: { file: "keep_both", folder: "keep_both" },
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 2 } },
		});
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
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting).toMatchObject({
			activity: { status: "awaiting_input", progress: { total: 3, completed: 0, blocked: 1 } },
		});
		const resolution = {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "skip" as const }],
			applyToRemaining: { file: null, folder: null },
		};
		expect(
			(await asUser.mutation(api.files_transfer.resolve_conflicts, { ...resolution, revision: waiting.revision - 1 }))
				._nay?.message,
		).toBe("The conflicts changed. Review them again.");
		expect((await asUser.mutation(api.files_transfer.resolve_conflicts, resolution))._nay).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 0, skipped: 3, blocked: 0 } },
		});
		expect(await get_node(fixture, "/target/source/child")).toBeNull();
		expect((await get_node(fixture, "/target/source/keep"))?._id).toBe(folders.get("/target/source/keep"));
		expect((await get_node(fixture, "/source/child/deep"))?._id).toBe(folders.get("/source/child/deep"));
	});
});

describe("stop", () => {
	test("drains large selections in batches before finishing", async () => {
		const paths = Array.from({ length: 101 }, (_entry, index) => `/source-${index}`);
		const fixture = await create_folder_fixture(paths);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(
			fixture,
			paths.map((path) => folders.get(path)!),
		);
		const args = { membershipId: db.membershipId, runId };
		expect((await asUser.mutation(api.files_transfer.stop, args))._nay).toBeUndefined();
		const stopping = await asUser.query(api.files_transfer.get, args);
		expect(stopping).toMatchObject({
			activity: { status: "stopping", progress: { discovered: 101, total: null, canceled: 50 } },
			controls: { canStop: false, canRetry: false, canDismiss: false },
		});
		expect(stopping?.activity.finishedAt).toBeUndefined();
		expect(
			(
				await start_transfer(asUser, {
					membershipId: db.membershipId,
					requestId: "during-stop",
					kind: "copy",
					sourceIds: [folders.get(paths[0]!)!],
					targetParentId: folders.get("/target")!,
				})
			)._nay?.message,
		).toBe("A transfer is already running in this workspace");
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, args)).toMatchObject({
			activity: { status: "stopping", progress: { canceled: 100 } },
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		const finished = await asUser.query(api.files_transfer.get, args);
		// Stop came before discovery ended, so Retry would copy an incomplete list.
		expect(finished).toMatchObject({
			activity: { status: "canceled", progress: { total: null, canceled: 101, completed: 0, blocked: 0 } },
			controls: { canStop: false, canRetry: false, canDismiss: true },
		});
		expect(finished?.activity.finishedAt).toBeTypeOf("number");
		await asUser.mutation(api.files_transfer.stop, args);
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, args)).toEqual(finished);
		await t.run(async (ctx) => {
			const items = await ctx.db.query("files_transfer_items").collect();
			expect(items).toHaveLength(101);
			expect(items.every((item) => item.state === "canceled" && item.attemptExpiresAt === null)).toBe(true);
			expect(await ctx.db.query("files_nodes").collect()).toHaveLength(102);
		});
	});

	test("moves blocked items into the canceled count once", async () => {
		const fixture = await create_folder_fixture(["/first", "/second", "/target/first", "/target/second"]);
		const { db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/first")!, folders.get("/second")!]);
		expect(await finish_discovery(fixture, runId)).toMatchObject({
			activity: { status: "awaiting_input", progress: { total: 2, blocked: 2, canceled: 0 } },
		});
		const args = { membershipId: db.membershipId, runId };
		await asUser.mutation(api.files_transfer.stop, args);
		await asUser.mutation(api.files_transfer.stop, args);
		expect(await asUser.query(api.files_transfer.get, args)).toMatchObject({
			activity: { status: "canceled", progress: { total: 2, blocked: 0, canceled: 2 } },
			conflicts: [],
		});
	});

	test("cancels discovery before any output and lets a new request start", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "canceled", progress: { discovered: 1, total: null, canceled: 1, completed: 0 } },
		});
		expect(await get_node(fixture, "/target/source")).toBeNull();
		expect(
			(
				await start_transfer(asUser, {
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
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const completed = await get_node(fixture, "/target/source");
		expect(completed).not.toBeNull();
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) =>
					q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", file._yay.nodeId),
				)
				.unique(),
		);
		if (!item?.workId) throw new Error("Missing queued copy worker");
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		expect(
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.status,
		).toBe("stopping");
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "canceled" },
		});
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "canceled", progress: { completed: 1, canceled: 1 } },
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(completed!._id);
		expect(await get_node(fixture, "/target/source/queued.pdf")).toBeNull();
		expect(cancel).toHaveBeenCalledWith(expect.anything(), item.workId);
	});
});

describe("retry_remaining", () => {
	test.each(["immediately", "after its idle deadline"] as const)(
		"does not retry a preparing leaf discarded %s",
		async (when) => {
			const fixture = await create_folder_fixture(["/source", "/source/z-keep"]);
			const { t, db, asUser, folders } = fixture;
			const sourceFile = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: folders.get("/source")!,
				filename: "a.pdf",
				contentType: "application/pdf",
				size: 8,
			});
			if (sourceFile._nay) throw new Error(sourceFile._nay.message);
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "retry-leaf-thread",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "copy-leaf",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await finish_discovery(fixture, runId);
			await t.mutation(internal.files_transfer.advance, { runId });
			const parent = await t.run((ctx) => ctx.db.query("files_pending_updates").first());
			if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target: parent.target,
				pendingUpdateId: parent._id,
				reviewedRevision: parent.revision,
			});
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected its saved parent");
			const savedParentId = saved._yay.target.id;
			await t.mutation(internal.files_transfer.advance, { runId });
			const leaf = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceFile._yay.nodeId),
					)
					.unique(),
			);
			if (!leaf?.preparation || !leaf.workId) throw new Error("Expected a preparing leaf");
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", leaf.preparation!.pendingUpdateId));
			if (!proposal) throw new Error("Expected its proposal");
			if (when === "after its idle deadline") {
				const expiresAt = proposal.updatedAt + 4 * 60 * 60 * 1000;
				expect(proposal.expiresAt).toBe(expiresAt);
				vi.setSystemTime(expiresAt);
				await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
					organizationId: proposal.organizationId,
					workspaceId: proposal.workspaceId,
					userId: proposal.userId,
				});
				// The running copy holds the leaf. The job keeps it and only moves its expiry to the next try.
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual({
					...proposal,
					expiresAt: expiresAt + 60_000,
				});
				expect(await t.run((ctx) => ctx.db.get("files_transfer_items", leaf._id))).toMatchObject({ state: "copying" });
			}
			expect(
				(
					await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
						membershipId: db.membershipId,
						target: proposal.target,
						pendingUpdateId: proposal._id,
						reviewedRevision: proposal.revision,
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", leaf._id))).toMatchObject({
				state: "canceled",
				cancelReason: "proposal_discard",
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: leaf.workId,
				context: { itemId: leaf._id, attempt: leaf.attempt },
				result: { kind: "canceled" },
			});
			await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
			await finish_folder_copy(fixture, runId);
			const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: db.membershipId,
				runId,
				requestId: "retry-without-leaf",
			});
			if (retried._nay) throw new Error(retried._nay.message);
			const finished = await finish_folder_copy(fixture, retried._yay.runId);
			expect(finished.activity).toMatchObject({
				status: "partial",
				progress: { total: 3, completed: 2, canceled: 1, failed: 0 },
			});
			const retryItems = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
					.collect(),
			);
			expect(retryItems.find((item) => item.source.id === sourceFile._yay.nodeId)).toMatchObject({
				state: "canceled",
				attempt: 0,
				outputTarget: null,
				cancelReason: "proposal_discard",
			});
			const activeDrafts = await t.run((ctx) =>
				ctx.db
					.query("files_pending_nodes")
					.filter((q) => q.eq(q.field("state"), "active"))
					.collect(),
			);
			expect(activeDrafts.map((node) => ({ name: node.name, parent: node.parent }))).toEqual([
				{ name: "z-keep", parent: { kind: "saved", id: savedParentId } },
			]);
			expect((await get_node(fixture, "/source/a.pdf"))?._id).toBe(sourceFile._yay.nodeId);
			expect(await get_node(fixture, "/target/source/a.pdf")).toBeNull();
		},
	);

	test("does not copy a source that moved away after the first run", async () => {
		const fixture = await create_folder_fixture(["/source", "/elsewhere"]);
		const { db, asUser, folders } = fixture;
		const created = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			filename: "moved.bin",
			contentType: "application/octet-stream",
			size: 8,
		});
		if (created._nay) throw new Error(created._nay.message);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await finish_folder_copy(fixture, runId);

		// The manifest is frozen, so the retry still names the old path. Moving the file out must not
		// let the retry copy from where it used to be.
		expect(
			(
				await asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: db.membershipId,
					itemIds: [created._yay.nodeId],
					targetParentId: folders.get("/elsewhere")!,
				})
			)._nay,
		).toBeUndefined();
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-moved-source",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		const finished = await finish_folder_copy(fixture, retried._yay.runId);
		// The retry stops while it is still planning, so nothing is copied at all.
		expect(finished.activity).toMatchObject({ status: "awaiting_input", progress: { completed: 0 } });
		expect(finished.conflicts).toMatchObject([{ kind: "source_changed" }]);
		expect(await get_node(fixture, "/target/source/moved.bin")).toBeNull();
		expect((await get_node(fixture, "/elsewhere/moved.bin"))?._id).toBe(created._yay.nodeId);
	});

	test("keeps the first run in history while the retry copies its manifest", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		expect(
			(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
		).toBeUndefined();
		await finish_folder_copy(fixture, runId);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-pins-history",
		});
		if (retried._nay) throw new Error(retried._nay.message);

		// The retry still reads its manifest from the first run, so a deletion must wait. Otherwise the
		// retry would copy half a manifest and lose the rest of the work.
		expect(await t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId, batchSize: 50 }))).toEqual({
			done: false,
			deletedCount: 0,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).not.toBeNull();

		// Once the manifest is copied the retry leaves the "retry" step and the first run can go away.
		await finish_folder_copy(fixture, retried._yay.runId);
		for (let step = 0; step < 20; step += 1) {
			const deleted = await t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId, batchSize: 50 }));
			if (deleted.done) break;
		}
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
	});

	test("retries a failed file and leaves a skipped sibling out of the retry", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const sourceIds: Id<"files_nodes">[] = [];
		for (const parent of ["/source", "/target"] as const) {
			for (const filename of ["skipped.bin", "fails.bin"]) {
				// The copy of "skipped.bin" meets an occupant in /target and asks; the answer is Skip.
				if (parent === "/target" && filename === "fails.bin") continue;
				const created = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: folders.get(parent)!,
					filename,
					contentType: "application/octet-stream",
					size: 8,
				});
				if (created._nay) throw new Error(created._nay.message);
				if (parent === "/source") sourceIds.push(created._yay.nodeId);
			}
		}
		const runId = await start_copy(fixture, sourceIds);
		const waiting = await finish_discovery(fixture, runId);
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [{ itemId: waiting.conflicts[0]!.itemId, choice: "skip" as const }],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();

		// Drop the plan so the remaining file copy fails for real instead of being canceled.
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" }));
		const read_failing = async () =>
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", sourceIds[1]!),
					)
					.unique(),
			);
		let failing = await read_failing();
		for (let step = 0; step < 10 && !failing?.workId; step += 1) {
			await t.mutation(internal.files_transfer.advance, { runId });
			failing = await read_failing();
		}
		if (!failing?.workId) throw new Error("Missing queued copy worker");
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: failing._id, attempt: failing.attempt });
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: failing.workId,
			context: { itemId: failing._id, attempt: failing.attempt },
			result: { kind: "success", returnValue: null },
		});
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "failed", progress: { total: 2, completed: 0, skipped: 1, failed: 1 } },
		});

		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-failed-file",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		await t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		const retryItems = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
				.collect(),
		);
		// The skipped file keeps the user's answer and is never copied again. The failed file starts over.
		expect(retryItems.find((item) => item.source.id === sourceIds[0])).toMatchObject({
			state: "skipped",
			attempt: 0,
			errorMessage: null,
		});
		expect(retryItems.find((item) => item.source.id === sourceIds[1])).toMatchObject({
			state: "pending",
			attempt: 0,
			errorMessage: null,
			outputTarget: null,
		});
		expect(
			await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: retried._yay.runId }),
		).toMatchObject({ activity: { progress: { discovered: 2, skipped: 1, completed: 0 } } });
		expect(await get_node(fixture, "/target/fails.bin")).toBeNull();
	});

	test.each(["private", "saved", "moved", "discarded"] as const)(
		"resolves a completed private parent that is %s before retry",
		async (parentState) => {
			const fixture = await create_folder_fixture(["/source", "/source/first", "/source/second"]);
			const { t, db, asUser, folders } = fixture;
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "retry-private-parent",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const started = await start_agent_transfer(t, {
				membershipId: db.membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId: thread._yay.threadId,
				requestId: "private-copy",
				kind: "copy",
				sources: [{ kind: "saved", id: folders.get("/source")! }],
				targetParent: { kind: "saved", id: folders.get("/target")! },
				targetPath: "/target",
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			await finish_discovery(fixture, runId);
			await t.mutation(internal.files_transfer.advance, { runId });
			const parent = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_parentItem", (q) => q.eq("runId", runId).eq("parentItemId", null))
					.unique(),
			);
			if (parent?.outputTarget?.kind !== "private") throw new Error("Expected a ready private folder");
			const privateParent = parent.outputTarget;
			const proposal = await t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", privateParent.id))
					.unique(),
			);
			if (!proposal) throw new Error("Expected its create proposal");
			const reviewed = {
				membershipId: db.membershipId,
				target: privateParent,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			};
			let savedParentId: Id<"files_nodes"> | null = null;
			if (parentState === "saved" || parentState === "moved") {
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, reviewed);
				if (saved._nay || saved._yay.target.kind !== "saved")
					throw new Error(saved._nay?.message ?? "Expected a saved folder");
				savedParentId = saved._yay.target.id;
				if (parentState === "moved")
					expect(
						(
							await asUser.mutation(api.files_nodes.rename_node, {
								membershipId: db.membershipId,
								nodeId: savedParentId,
								path: "moved",
							})
						)._nay,
					).toBeUndefined();
			} else if (parentState === "discarded") {
				expect(
					(await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, reviewed))._nay,
				).toBeUndefined();
			}
			expect(
				(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId }))._nay,
			).toBeUndefined();
			await finish_folder_copy(fixture, runId);
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: db.membershipId,
				runId,
				requestId: "retry-private",
			});
			if (retried._nay) throw new Error(retried._nay.message);
			const finished = await finish_folder_copy(fixture, retried._yay.runId);
			if (parentState === "moved" || parentState === "discarded") {
				expect(finished).toMatchObject({
					activity: { status: "awaiting_input", progress: { completed: 1 } },
					conflicts: [{ kind: "destination_changed" }],
				});
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_pending_nodes")
							.filter((q) => q.eq(q.field("state"), "active"))
							.collect(),
					),
				).toEqual([]);
			} else {
				expect(finished.activity).toMatchObject({ status: "succeeded", progress: { total: 3, completed: 3 } });
				const children = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
				expect(
					children
						.filter((node) => node._id !== privateParent.id)
						.map((node) => ({ name: node.name, parent: node.parent })),
				).toEqual([
					{ name: "first", parent: savedParentId ? { kind: "saved", id: savedParentId } : privateParent },
					{ name: "second", parent: savedParentId ? { kind: "saved", id: savedParentId } : privateParent },
				]);
			}
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test("keeps ready parents and retries only the frozen remaining manifest", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/first", "/source/second"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const readyParent = await get_node(fixture, "/target/source");
		await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
		await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/source")!,
			path: "added-later",
		});
		const args = { membershipId: db.membershipId, runId, requestId: "retry-remaining" };
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, args);
		if (retried._nay) throw new Error(retried._nay.message);
		expect(await asUser.mutation(api.files_transfer.retry_remaining, args)).toEqual(retried);
		expect(await finish_folder_copy(fixture, retried._yay.runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 3, completed: 3 } },
		});
		expect((await get_node(fixture, "/target/source"))?._id).toBe(readyParent!._id);
		expect(await get_node(fixture, "/target/source/first")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/second")).not.toBeNull();
		expect(await get_node(fixture, "/target/source/added-later")).toBeNull();
		expect(
			await asUser.mutation(api.files_transfer.retry_remaining, { ...args, requestId: "reopen-old-retry" }),
		).toEqual(retried);
	});

	test("keeps the whole manifest when Stop is repeated during retry preparation", async () => {
		const fixture = await create_folder_fixture([
			"/source",
			...Array.from({ length: 55 }, (_, index) => `/source/${index}`),
		]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
		await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId });
		await finish_folder_copy(fixture, runId);
		const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId,
			requestId: "retry-stop",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		const stopArgs = { membershipId: db.membershipId, runId: retried._yay.runId };
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		await t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		await asUser.mutation(api.files_transfer.stop, stopArgs);
		expect((await asUser.query(api.files_transfer.get, stopArgs))?.activity.status).toBe("stopping");
		expect(await finish_folder_copy(fixture, retried._yay.runId)).toMatchObject({
			activity: { status: "canceled", progress: { discovered: 56, total: 56, completed: 0, canceled: 56 } },
		});
		const again = await asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: db.membershipId,
			runId: retried._yay.runId,
			requestId: "retry-again",
		});
		if (again._nay) throw new Error(again._nay.message);
		expect(await finish_folder_copy(fixture, again._yay.runId)).toMatchObject({
			activity: { status: "succeeded", progress: { total: 56, completed: 56 } },
		});
	});
});

describe("move", () => {
	test.each(["file", "folder"] as const)(
		"replaces only the reviewed %s and keeps the source identity",
		async (kind) => {
			const fixture = await create_folder_fixture(kind === "folder" ? ["/source", "/target/source"] : []);
			const { t, db, asUser, folders } = fixture;
			const nodeIds: Id<"files_nodes">[] = [];
			if (kind === "file") {
				for (const parentId of [files_ROOT_ID, folders.get("/target")!]) {
					const created = await asUser.mutation(api.files_nodes.create_upload_node, {
						membershipId: db.membershipId,
						parentId,
						filename: "source",
						contentType: "application/octet-stream",
						size: 8,
					});
					if (created._nay) throw new Error(created._nay.message);
					nodeIds.push(created._yay.nodeId);
				}
			} else nodeIds.push(folders.get("/source")!, folders.get("/target/source")!);
			const started = await asUser.mutation(api.files_transfer.start, {
				membershipId: db.membershipId,
				requestId: "move-replace",
				kind: "move",
				sourceIds: [nodeIds[0]!],
				targetParentId: folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			const waiting = await finish_discovery(fixture, runId);
			const page = await asUser.query(api.files_transfer.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { cursor: null, numItems: 50 },
			});
			const item = page!.page[0]!;
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting.revision,
						choices: [
							{
								itemId: item.itemId,
								choice: "replace",
								reviewedTarget: item.conflict!.target!,
								reviewedVersion: item.conflict!.version,
							},
						],
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			expect(await finish_folder_copy(fixture, runId)).toMatchObject({
				activity: { status: "succeeded", progress: { completed: 1 } },
			});
			const source = await t.run((ctx) => ctx.db.get("files_nodes", nodeIds[0]!));
			const replaced = await t.run((ctx) => ctx.db.get("files_nodes", nodeIds[1]!));
			expect(source?.path).toBe(`/target/${source!.name}`);
			expect(source?.archiveOperationId).toBeNull();
			expect(replaced?.archiveOperationId).not.toBeNull();
		},
	);

	test("keeps the moved file's metadata and version history when it replaces an occupant", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser, folders } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/notes.md",
			textContent: "keep these bytes",
		});
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: sourceId,
					metadataYaml: ["owner: Ray", "priority: 3"].join("\n"),
				})
			)._nay,
		).toBeUndefined();
		const occupant = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folders.get("/target")!,
			filename: "notes.md",
			contentType: "application/octet-stream",
			size: 8,
		});
		if (occupant._nay) throw new Error(occupant._nay.message);

		const read_versions = async (fileNodeId: Id<"files_nodes">) =>
			await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.filter((q) => q.eq(q.field("fileNodeId"), fileNodeId))
					.collect(),
			);
		const read_metadata_docs = async (fileNodeId: Id<"files_nodes">) =>
			await t.run((ctx) =>
				ctx.db
					.query("files_metadata_docs")
					.filter((q) => q.eq(q.field("fileNodeId"), fileNodeId))
					.collect(),
			);
		const versionsBefore = await read_versions(sourceId);
		const metadataDocsBefore = await read_metadata_docs(sourceId);
		const entriesBefore = await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId,
			fileNodeId: sourceId,
		});
		// Guard the fixture: an empty history or empty metadata would make the checks below pass for
		// the wrong reason.
		expect(versionsBefore.length).toBeGreaterThan(0);
		expect(entriesBefore.length).toBeGreaterThan(0);

		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "move-replace-history",
			kind: "move",
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const waiting = await finish_discovery(fixture, runId);
		const page = await asUser.query(api.files_transfer.list_items, {
			membershipId: db.membershipId,
			runId,
			paginationOpts: { cursor: null, numItems: 50 },
		});
		const item = page!.page[0]!;
		expect(
			(
				await asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: db.membershipId,
					runId,
					revision: waiting.revision,
					choices: [
						{
							itemId: item.itemId,
							choice: "replace",
							reviewedTarget: item.conflict!.target!,
							reviewedVersion: item.conflict!.version,
						},
					],
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		expect(await finish_folder_copy(fixture, runId)).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1 } },
		});

		// The move replaces the occupant and carries the source node itself, so the source keeps its
		// id, its saved versions and its metadata. Nothing may move to the archived occupant.
		const moved = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		expect(moved).toMatchObject({ path: "/target/notes.md", archiveOperationId: null });
		expect(await read_versions(sourceId)).toEqual(versionsBefore);
		// The same metadata rows stay attached to the node. Only their copy of the path follows it.
		const metadataDocsAfter = await read_metadata_docs(sourceId);
		expect(metadataDocsAfter.map((doc) => doc._id).sort()).toEqual(metadataDocsBefore.map((doc) => doc._id).sort());
		expect(metadataDocsAfter.map((doc) => doc.fieldPath).sort()).toEqual(
			metadataDocsBefore.map((doc) => doc.fieldPath).sort(),
		);
		expect([...new Set(metadataDocsAfter.map((doc) => doc.path))]).toEqual(["/target/notes.md"]);
		expect(
			await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: sourceId }),
		).toEqual(entriesBefore);
		expect(await read_versions(occupant._yay.nodeId)).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get("files_nodes", occupant._yay.nodeId)))?.archiveOperationId).not.toBeNull();
	});

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
			await t.mutation(internal.files_transfer.advance, { runId });
			const view = await actor.query(api.files_transfer.get, { membershipId, runId });
			expect(JSON.stringify(view)).not.toContain("hidden-name");
			if (access === "none" || access === "read") {
				expect(view).toMatchObject({
					movedNodeIds: [],
					activity: { status: "failed", progress: { completed: 0 }, errorMessage: "Permission denied" },
				});
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} else {
				expect(view).toMatchObject({
					activity: { status: "succeeded", progress: { completed: 2 }, errorMessage: null },
				});
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
		const waiting = await finish_discovery(fixture, runId);
		expect(waiting.conflicts).toHaveLength(3);
		const resolved = await asUser.mutation(api.files_transfer.resolve_conflicts, {
			membershipId: db.membershipId,
			runId,
			revision: waiting.revision,
			choices: waiting.conflicts.map((item) => ({ itemId: item.itemId, choice: "keep_both" as const })),
			applyToRemaining: { file: null, folder: null },
		});
		expect(resolved._nay).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: {
				status: "failed",
				progress: { completed: 0 },
				errorMessage: "Too many name conflicts. Select fewer items.",
			},
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
		expect((await finish_discovery(fixture, runId)).activity.status).toBe("running");
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
		expect(waiting).toMatchObject({ activity: { status: "awaiting_input", progress: { completed: 0 } } });
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
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, skipped: 1 } },
			movedNodeIds: [folders.get("/one")],
		});
		expect((await get_node(fixture, "/target/one"))?._id).toBe(folders.get("/one"));
		expect((await get_node(fixture, "/target/one/child"))?._id).toBe(folders.get("/one/child"));
		expect((await get_node(fixture, "/two"))?._id).toBe(folders.get("/two"));
	});
});

describe("copy deadline", () => {
	test("blocks a staged file at the Activity deadline before the sweep runs", async () => {
		const fixture = await create_folder_fixture([]);
		const { t, db, asUser } = fixture;
		const file = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "late.pdf",
			contentType: "application/pdf",
			size: 8,
		});
		if (file._nay) throw new Error(file._nay.message);
		const runId = await start_copy(fixture, [file._yay.nodeId]);
		const running = await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!item?.workId) throw new Error("Missing copy worker");
		await t.run((ctx) => ctx.db.patch("files_r2_assets", file._yay.assetId, { r2Key: "test/late.pdf" }));
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: item._id,
			attempt: item.attempt,
		});
		const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: item._id,
			attempt: item.attempt,
			workId: item.workId,
			contentSize: 8,
		});
		if (!staged._yay) throw new Error("Missing staged asset");
		const deadlineAt = Date.now() + 1000;
		await t.run((ctx) => ctx.db.patch("activities", running.activity._id, { deadlineAt }));
		vi.setSystemTime(deadlineAt);
		expect(
			(
				await t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
					itemId: item._id,
					attempt: item.attempt,
					workId: item.workId,
					contentAssetId: staged._yay.contentAssetId,
				})
			)._nay,
		).toBeUndefined();
		const stopping = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		expect(stopping).toMatchObject({
			activity: { status: "stopping", errorCode: "timed_out", progress: { completed: 0, canceled: 1 } },
		});
		expect(stopping?.activity.finishedAt).toBeUndefined();
		expect(await get_node(fixture, "/target/late.pdf")).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", staged._yay!.contentAssetId))).toBeNull();
		const callback = {
			workId: item.workId,
			context: { itemId: item._id, attempt: item.attempt },
			result: { kind: "success" as const, returnValue: null },
		};
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		const finished = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		expect(finished).toMatchObject({
			activity: { status: "timed_out", errorMessage: "Paste timed out", progress: { completed: 0, canceled: 1 } },
		});
		vi.setSystemTime(deadlineAt + 1000);
		await t.mutation(internal.files_transfer.handle_copy_complete, callback);
		expect(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toEqual(finished);
	});
});

describe("recover_expired_attempts", () => {
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
		await finish_discovery(fixture, runId);
		await t.mutation(internal.files_transfer.advance, { runId });
		const first = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		);
		if (!first?.workId) throw new Error("Missing first worker");
		await t.run((ctx) => ctx.db.patch("files_r2_assets", file._yay.assetId, { r2Key: "test/queued.pdf" }));
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: first._id,
			attempt: first.attempt,
		});
		const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: first._id,
			attempt: first.attempt,
			workId: first.workId,
			contentSize: 8,
		});
		if (!staged._yay) throw new Error("Missing staged asset");
		vi.setSystemTime(Date.now() + 11 * 60 * 1000);
		await t.mutation(internal.files_transfer.recover_expired_attempts, {});
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

describe("delete_run_batch", () => {
	test("deletes dismissed job history and keeps the saved output", async () => {
		const fixture = await create_folder_fixture(["/source"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		const finished = await finish_folder_copy(fixture, runId);
		const copied = await get_node(fixture, "/target/source");
		expect(finished.activity.status).toBe("succeeded");
		expect(
			(
				await asUser.mutation(api.activities.archive_activity, {
					membershipId: db.membershipId,
					activityId: finished.activity._id,
				})
			)._nay,
		).toBeUndefined();
		let deleted = false;
		for (let step = 0; step < 10 && !deleted; step++) {
			await t.mutation(internal.files_transfer.delete_run_batch, { runId });
			deleted = (await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))) === null;
		}
		expect(deleted).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_runs", runId)).toBeNull();
			expect(await ctx.db.get("activities", finished.activity._id)).toBeNull();
			expect(await ctx.db.query("files_transfer_items").collect()).toEqual([]);
			expect(await ctx.db.query("activities_user_states").collect()).toEqual([]);
		});
		expect(await get_node(fixture, "/target/source")).toEqual(copied);
	});
});

describe("changed folders", () => {
	test("requires a new choice after the source moves and never follows its old path", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
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
			activity: { status: "awaiting_input", progress: { completed: 0 } },
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
					applyToRemaining: { file: null, folder: null },
				})
			)._nay,
		).toBeDefined();
	});

	test("does not write children into a copied folder moved by another member", async () => {
		const fixture = await create_folder_fixture(["/source", "/source/child"]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const runId = await start_copy(fixture, [folders.get("/source")!]);
		await finish_discovery(fixture, runId);
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
			activity: { status: "awaiting_input", progress: { completed: 1 } },
			conflicts: [{ kind: "destination_changed" }],
		});
		expect((await get_node(fixture, "/target/moved-copy"))?._id).toBe(copied!._id);
		expect(await get_node(fixture, "/target/moved-copy/child")).toBeNull();
		expect(await get_node(fixture, "/target/child")).toBeNull();
	});
});
