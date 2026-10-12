// Fixtures shared by the files_transfer test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionArgs } from "convex/server";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

export const r2Objects = new Map<string, BodyInit>();

// Each test file calls this in `beforeEach`.
export function mock_transfer_storage() {
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
}

export async function create_folder_fixture(paths: string[]) {
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
export async function finish_selection(args: {
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">;
	runId: Id<"files_transfer_runs">;
	activityId: Id<"activities">;
}) {
	const { t, runId, activityId } = args;

	for (let step = 0; step < 300; step++) {
		const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		if (run?.step !== "select" && run?.step !== "normalize") return;
		const activity = await t.run((ctx) => ctx.db.get("activities", activityId));
		if (!activity || !activities_is_active(activity.status)) return;
		await t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Copy selection did not finish");
}

export async function start_transfer(
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">,
	args: FunctionArgs<typeof api.files_transfer.start>,
) {
	const started = await t.mutation(api.files_transfer.start, {
		...args,
		expectedSourceCount: args.sourceIds.length,
		sourceIds: args.sourceIds.slice(0, 100),
	});
	if (started._nay) return started;
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
	await finish_selection({ t, runId, activityId: started._yay.activityId });
	return started;
}

export async function start_agent_transfer(
	t: Pick<ReturnType<typeof test_convex>, "mutation" | "run">,
	args: FunctionArgs<typeof internal.files_transfer.start_for_agent>,
) {
	const started = await t.mutation(internal.files_transfer.start_for_agent, {
		...args,
		expectedSourceCount: args.sources.length,
		sources: args.sources.slice(0, 100),
	});
	if (started._nay) return started;
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
	await finish_selection({ t, runId, activityId: started._yay.activityId });
	return started;
}

export async function start_copy(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, sourceIds: Id<"files_nodes">[]) {
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

export async function finish_discovery(
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

export async function finish_folder_copy(
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

export async function finish_move(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, runId: Id<"files_transfer_runs">) {
	await fixture.t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
	return await fixture.asUser.query(api.files_transfer.get, { membershipId: fixture.db.membershipId, runId });
}

export async function finish_copy_worker(
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
export async function finish_copy_with_workers(
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

export async function get_node(fixture: Awaited<ReturnType<typeof create_folder_fixture>>, path: string) {
	return await fixture.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", fixture.db.organizationId)
					.eq("workspaceId", fixture.db.workspaceId).eq("moveCohortId", undefined)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
}

export async function add_member(fixture: Awaited<ReturnType<typeof create_folder_fixture>>) {
	const member = await fixture.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clipboard-other-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.db.organizationId,
			workspaceId: fixture.db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
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
