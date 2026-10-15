// Fixtures shared by the files_pending_overlay_limits test files.
import { R2 } from "@convex-dev/r2";
import { getFunctionName } from "convex/server";
import { expect, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { advance_stage } from "./files_move_content.ts";
import { advance as advance_review } from "./files_pending_update_runs.ts";
import {
	accept_input as accept_transfer_input,
	append_input as append_transfer_input,
	advance as advance_transfer,
} from "./files_transfer.ts";
import {
	test_convex,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { access_control_FILE_SHARE_LEVELS } from "../shared/access-control.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Each test file calls this in `beforeEach`.
export function mock_overlay_limits_storage() {
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

type Db = Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;
type Cost = ReturnType<typeof transaction_cost>;
export type Metadata = Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }>;

const zero: Cost = {
	databaseQueries: 0,
	documentsRead: 0,
	bytesRead: 0,
	documentsWritten: 0,
	bytesWritten: 0,
	functionsScheduled: 0,
	scheduledFunctionArgsBytes: 0,
};

/**
 * The work done between two metric reads in one transaction.
 */
export function transaction_cost(before: Metrics, after: Metrics) {
	return {
		databaseQueries: after.databaseQueries.used - before.databaseQueries.used,
		documentsRead: after.documentsRead.used - before.documentsRead.used,
		bytesRead: after.bytesRead.used - before.bytesRead.used,
		documentsWritten: after.documentsWritten.used - before.documentsWritten.used,
		bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
		functionsScheduled: after.functionsScheduled.used - before.functionsScheduled.used,
		scheduledFunctionArgsBytes: after.scheduledFunctionArgsBytes.used - before.scheduledFunctionArgsBytes.used,
	};
}

/**
 * Check one transaction against the Convex limits. `transactionLimits: true` already throws past
 * them, so these asserts show the numbers and keep the check if that option goes away.
 */
export function expect_under_convex_limits(cost: ReturnType<typeof transaction_cost>) {
	expect(cost.databaseQueries, "databaseQueries").toBeLessThan(4096);
	expect(cost.documentsRead, "documentsRead").toBeLessThan(32_000);
	expect(cost.bytesRead, "bytesRead").toBeLessThan(16 * 1024 * 1024);
	expect(cost.documentsWritten, "documentsWritten").toBeLessThan(16_000);
	expect(cost.bytesWritten, "bytesWritten").toBeLessThan(16 * 1024 * 1024);
	expect(cost.functionsScheduled, "functionsScheduled").toBeLessThan(1000);
	expect(cost.scheduledFunctionArgsBytes, "scheduledFunctionArgsBytes").toBeLessThan(16 * 1024 * 1024);
}

/**
 * Peak transaction cost per phase. Joined phases repeat the whole transaction's cost; do not add them.
 * Each measurement includes the overlay flush, so also the metadata catalog's deltas and marker.
 */
export function budget_recorder() {
	const peaks = new Map<string, { measured: Cost; calls: number }>();
	const check = (phase: string, measured: Cost) => {
		expect_under_convex_limits(measured);
		for (const [key, limit] of Object.entries({
			databaseQueries: 4096,
			documentsRead: 32_000,
			bytesRead: 16 * 1024 * 1024,
			documentsWritten: 16_000,
			bytesWritten: 16 * 1024 * 1024,
			functionsScheduled: 1000,
			scheduledFunctionArgsBytes: 16 * 1024 * 1024,
		}) as Array<[keyof Cost, number]>)
			expect(measured[key], `${phase}: ${key}`).toBeLessThan(limit * 0.75);
	};
	const record = (phase: string, measured: Cost) => {
		const peak = peaks.get(phase) ?? { measured: { ...zero }, calls: 0 };
		for (const key of Object.keys(zero) as Array<keyof Cost>)
			peak.measured[key] = Math.max(peak.measured[key], measured[key]);
		peak.calls++;
		peaks.set(phase, peak);
		if (peak.calls === 1 || peak.calls % 500 === 0) console.info("Move budget phase", phase, peak.calls);
		check(phase, measured);
	};
	return {
		peaks,
		record,
		check: (name: string) => {
			for (const [phase, peak] of peaks) check(`${name}/${phase}`, peak.measured);
		},
	};
}

export function measure_cohort(
	record: ReturnType<typeof budget_recorder>["record"],
	metadata: Metadata[] = [],
) {
	const fileIds = new Set(metadata.map((row) => row.fileNodeId));
	let parents = 0;
	const pages: {
		cohortId: Id<"files_move_cohorts">;
		parent: number;
		phase: string;
		view: "before" | "after";
		rowIds: Id<"files_metadata_docs">[];
		fileNodeIds: (Id<"files_nodes"> | null)[];
	}[] = [];
	// Transfer and Review can start the cohort inline, without calling registered cohort.advance.
	for (const registered of [
		advance_cohort,
		accept_transfer_input,
		append_transfer_input,
		advance_transfer,
		advance_review,
		advance_stage,
	]) {
		test_spy_handler(registered, async (handler, ctx, args) => {
			const parent = ++parents;
			const get = vi.spyOn(ctx.db, "get");
			const patch = vi.spyOn(ctx.db, "patch");
			const query = vi.spyOn(ctx, "runQuery");
			const before = await ctx.meta.getTransactionMetrics();
			try {
				const result = await handler(ctx, args);
				// The registered handler includes the mutation wrapper and its overlay flush.
				const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
				const phases = new Set<string>();
				const cohorts = new Map<Id<"files_move_cohorts">, string>();
				let current: Id<"files_move_cohorts"> | undefined;
				const events: (
					| { order: number; kind: "get"; cohort: Doc<"files_move_cohorts"> }
					| { order: number; kind: "patch"; cohortId: Id<"files_move_cohorts">; fields: Partial<Doc<"files_move_cohorts">> }
					| { order: number; kind: "query"; index: number }
				)[] = [];
				// Vitest infers the older id-only overload. These calls use the table-first overload.
				const gets = get.mock.calls as unknown as [string, Id<"files_move_cohorts">][];
				for (const [index, [table]] of gets.entries()) {
					if (table !== "files_move_cohorts") continue;
					const cohort = await get.mock.results[index]!.value as Doc<"files_move_cohorts"> | null;
					if (cohort) events.push({ order: get.mock.invocationCallOrder[index]!, kind: "get", cohort });
				}
				const patches = patch.mock.calls as unknown as [string, Id<"files_move_cohorts">, Partial<Doc<"files_move_cohorts">>][];
				for (const [index, [table, id, fields]] of patches.entries()) {
					if (table === "files_move_cohorts")
						events.push({ order: patch.mock.invocationCallOrder[index]!, kind: "patch", cohortId: id, fields });
				}
				for (const [index, [reference]] of query.mock.calls.entries()) {
					if (getFunctionName(reference).startsWith("files_move_pages:"))
						events.push({ order: query.mock.invocationCallOrder[index]!, kind: "query", index });
				}
				for (const event of events.sort((a, b) => a.order - b.order)) {
					if (event.kind === "get") {
						current = event.cohort._id;
						cohorts.set(current, event.cohort.workPhase);
						continue;
					}
					if (event.kind === "patch") {
						const phase = cohorts.get(event.cohortId);
						if (phase) phases.add(phase);
						current = event.cohortId;
						if (event.fields.workPhase) cohorts.set(current, event.fields.workPhase);
						continue;
					}
					const [reference, queryArgs] = query.mock.calls[event.index]!;
					const name = getFunctionName(reference);
					const pageArgs = queryArgs as { cohortId?: Id<"files_move_cohorts">; family?: string; view?: "before" | "after" };
					const cohortId = pageArgs.cohortId ?? current;
					expect(cohortId, "A real Move page has its parent cohort").toBeDefined();
					const phase = cohorts.get(cohortId!);
					expect(phase, "A real Move page has its current parent phase").toBeDefined();
					phases.add(phase!);
					if (name !== "files_move_pages:metadata" && !(name === "files_move_pages:side_cleanup" && pageArgs.family === "files_metadata_docs")) continue;
					const page = await query.mock.results[event.index]!.value as { page: Doc<"files_metadata_docs">[] };
					// Fixture files select pages, never shorten a real native page.
					if (!page.page.some((row) => row.sourceKind === "committed" && fileIds.has(row.fileNodeId))) continue;
					pages.push({
						cohortId: cohortId!, parent, phase: phase!, view: name === "files_move_pages:metadata" ? "before" : pageArgs.view!,
						rowIds: page.page.map((row) => row._id),
						fileNodeIds: page.page.map((row) => row.sourceKind === "committed" ? row.fileNodeId : null),
					});
				}
				if (registered === advance_cohort && phases.size === 0) phases.add("stale");
				for (const visited of phases) record(`cohort/${visited}`, cost);
				return result;
			} finally {
				get.mockRestore();
				patch.mockRestore();
				query.mockRestore();
			}
		});
	}
	return pages;
}

export async function finish_scheduled(t: ReturnType<typeof test_convex>, isDone: () => Promise<boolean>) {
	for (let step = 0; step < 50_000; step++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		if (await isDone()) return;
		// Each scheduled worker has a fake timer. Reading `_scheduled_functions` here would be slow:
		// that table keeps finished jobs, so each read grows with the steps already run.
		if (vi.getTimerCount() === 0) throw new Error("The accepted job has no scheduled worker");
		// Advance between workers, never while an async worker is still reading or writing.
		vi.advanceTimersToNextTimer();
	}
	throw new Error("The scheduled job did not finish");
}

export async function add_member(ctx: MutationCtx, db: Db, clerkUserId: string) {
	const userId = await ctx.db.insert("users", { clerkUserId });
	await ctx.db.insert("organizations_workspaces_users", {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		active: true,
		pendingOrganizationRemoval: false,
		updatedAt: Date.now(),
	});
	await access_control_db_ensure_role_assignment(ctx, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		role: "member",
		now: Date.now(),
	});
	return userId;
}

export async function insert_saved_node(
	ctx: MutationCtx,
	db: Db,
	args: { parent: Doc<"files_nodes"> | null; name: string; kind: "file" | "folder"; createdBy?: Id<"users"> },
) {
	const path = `${args.parent?.path ?? ""}/${args.name}`;
	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		createdBy: args.createdBy ?? db.userId,
		updatedBy: args.createdBy ?? db.userId,
		parentId: args.parent?._id ?? files_ROOT_ID,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		kind: args.kind,
		path,
		treePath: args.kind === "folder" ? `${path}/` : path,
		pathDepth: path.split("/").length - 1,
	});
	return (await ctx.db.get("files_nodes", nodeId))!;
}

/**
 * Share a restricted root 100 times. The share caps allow 50 shares on one node
 * (MAX_FILE_SHARE_PRINCIPALS in files_sharing.ts, MAX_READERS in plugins_external_files.ts). This is
 * twice that: 50 users and 50 roles, each with the three grants of a "manage" share.
 */
export async function share_100_times(t: ReturnType<typeof test_convex>, db: Db, nodeId: Id<"files_nodes">) {
	await test_run_with_flush(t, async (ctx) => {
		const principals: Array<
			{ principalKind: "user"; userId: Id<"users"> } | { principalKind: "role"; role: Id<"access_control_roles"> }
		> = [];
		for (let index = 0; index < 50; index++) {
			const userId = await ctx.db.insert("users", { clerkUserId: `clerk_reader_${index}` });
			const role = await ctx.db.insert("access_control_roles", {
				organizationId: db.organizationId,
				name: `Readers ${index}`,
				normalizedName: `readers ${index}`,
				description: "",
				permissions: ["content.read"],
				createdBy: db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			principals.push({ principalKind: "user", userId }, { principalKind: "role", role });
		}
		for (const principal of principals)
			for (const permission of access_control_FILE_SHARE_LEVELS.manage.permissions)
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					resourceKind: "file",
					resourceId: String(nodeId),
					...principal,
					permission,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
	});
}
