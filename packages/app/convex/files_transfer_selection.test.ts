import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance } from "./files_transfer.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_metadata_stringify_entries_yaml } from "../shared/files-metadata.ts";
import type { files_PendingParent, files_PendingTarget } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(paths = ["/source", "/target"]) {
	const t = test_convex({ transactionLimits: true });
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const folders = new Map<string, Id<"files_nodes">>();
	for (const path of paths) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.set(path, created._yay.nodeId);
	}
	return { t, scope, asUser, folders };
}

async function start(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	sources: Id<"files_nodes">[];
	expectedCount?: number;
}) {
	const { f, sources, expectedCount = sources.length } = args;

	return await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.scope.membershipId,
		requestId: "selection",
		kind: "copy",
		expectedSourceCount: expectedCount,
		sourceIds: sources,
		targetParentId: f.folders.get("/target")!,
	});
}

describe("Transfer selection pages", () => {
	test.each([
		{ kind: "move" as const, title: "one Move parent call joins Select, Normalize and Plan" },
		{ kind: "copy" as const, title: "Copy keeps its existing selection boundary" },
	])("$title", async ({ kind }) => {
		const f = await fixture();
		const sourceId = f.folders.get("/source")!;
		const started = await f.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: f.scope.membershipId,
			requestId: `joined-${kind}`,
			kind,
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: f.folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(await f.asUser.mutation(api.files_transfer.seal, { membershipId: f.scope.membershipId, runId })).toEqual({
			_yay: null,
		});
		await f.t.mutation(internal.files_transfer.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		if (kind === "copy") {
			expect(run, "Copy stops at its existing selection boundary").toMatchObject({
				step: "normalize",
				selection: { cursor: -1 },
			});
			await f.t.mutation(internal.files_transfer.advance, { runId });
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ step: "discover" });
		} else {
			expect(run, "one parent call finishes exact planning").toMatchObject({
				step: "apply",
				selection: { count: 1, cursor: 0 },
			});
		}
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			source: { kind: "saved", id: sourceId },
			sourcePath: "/source",
			parentItemId: null,
			...(kind === "move" ? { plannedPath: "/target/source" } : {}),
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({ path: "/source" });
	});

	test.each(["long headers", "suffix searches"] as const)(
		"joined Move parent keeps 25% free with %s",
		async (scenario) => {
			const prefix = `/${["a".repeat(255), "b".repeat(255), "c".repeat(245)].join("/")}`;
			const names =
				scenario === "long headers"
					? Array.from({ length: 8 }, (_, i) => `${"n".repeat(253)}-${i}`)
					: ["one", "two", "three"];
			const sourcePaths = names.map((name) => `${scenario === "long headers" ? prefix : ""}/${name}`);
			const occupied =
				scenario === "suffix searches"
					? names.flatMap((name) =>
							Array.from({ length: 111 }, (_, i) => `/target/${i === 0 ? name : `${name}-copy-${i}`}`),
						)
					: [];
			const f = await fixture(["/target", ...sourcePaths, ...occupied]);
			const sourceIds = sourcePaths.map((path) => f.folders.get(path)!);
			const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
			test_spy_handler(advance, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				// The real registered handler has finished its final overlay and catalog flush.
				costs.push(await ctx.meta.getTransactionMetrics());
				return result;
			});
			const started = await f.asUser.mutation(api.files_transfer.accept_input, {
				membershipId: f.scope.membershipId,
				requestId: `joined-budget-${scenario}`,
				kind: "move",
				expectedSourceCount: sourceIds.length,
				sourceIds,
				targetParentId: f.folders.get("/target")!,
			});
			if (started._nay) throw new Error(started._nay.message);
			const { runId } = started._yay;
			expect(await f.asUser.mutation(api.files_transfer.seal, { membershipId: f.scope.membershipId, runId })).toEqual({
				_yay: null,
			});
			if (scenario === "suffix searches") {
				await f.t.mutation(internal.files_transfer.advance, { runId });
				const waiting = await f.asUser.query(api.files_transfer.get, { membershipId: f.scope.membershipId, runId });
				if (!waiting || waiting.activity.status !== "awaiting_input") throw new Error("Expected native name conflicts");
				expect(
					await f.asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: f.scope.membershipId,
						runId,
						revision: waiting.revision,
						choices: waiting.conflicts.map((item) => ({ itemId: item.itemId, choice: "keep_both" as const })),
						applyToRemaining: { file: null, folder: null },
					}),
				).toEqual({ _yay: null });
			}
			await f.t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
			const view = await f.asUser.query(api.files_transfer.get, { membershipId: f.scope.membershipId, runId });
			expect(view?.activity, "every source completes without a dropped tail").toMatchObject({
				status: "succeeded",
				progress: { completed: sourceIds.length, failed: 0, canceled: 0 },
			});
			for (const [index, sourceId] of sourceIds.entries())
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
					_id: sourceId,
					path: `/target/${names[index]}${scenario === "suffix searches" ? "-copy-111" : ""}`,
				});
			expect(costs.length, "registered parent transactions were measured").toBeGreaterThan(0);
			const peaks = new Map<string, number>();
			for (const cost of costs)
				for (const [key, metric] of Object.entries(cost)) {
					expect(metric.used, `${scenario}: ${key} includes final flush and leaves 25% free`).toBeLessThan(
						(metric.used + metric.remaining) * 0.75,
					);
					peaks.set(key, Math.max(peaks.get(key) ?? 0, metric.used));
				}
			console.info("joined Move parent peaks", scenario, JSON.stringify(Object.fromEntries(peaks)));
		},
		60_000,
	);

	test.each(["private roots", "new private parents"] as const)(
		"joined Move Apply keeps 25% free with %s",
		async (scenario) => {
			const paths = Array.from({ length: 8 }, (_, index) => `/source-${index}`);
			const f = await fixture(scenario === "private roots" ? ["/target"] : paths);
			const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.scope.membershipId,
				clientGeneratedId: `apply-budget-${scenario}`,
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
				userId: f.scope.userId,
				membershipId: f.scope.membershipId,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const agentSource = {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userId: f.scope.userId,
				membershipId: f.scope.membershipId,
				threadId: thread._yay.threadId,
				membershipLifetime: captured._yay.membershipLifetime,
			};
			// All 128 keys fit the real YAML cap. One value uses its 1024-character cap.
			const metadata = Array.from({ length: 128 }, (_, index) => ({
				key: `field-${index.toString().padStart(3, "0")}-${"k".repeat(index === 0 ? 107 : 97)}`,
				value: index === 0 ? "v".repeat(1024) : "2026-10-13",
			}));
			expect(new TextEncoder().encode(files_metadata_stringify_entries_yaml(metadata)).length).toBe(16 * 1024);
			const sources: files_PendingTarget[] = [];
			for (const path of paths) {
				if (scenario === "private roots") {
					const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
						organizationId: f.scope.organizationId,
						workspaceId: f.scope.workspaceId,
						userId: f.scope.userId,
						threadId: thread._yay.threadId,
						agentSource,
						path,
						kind: "folder",
					});
					if (created._nay || created._yay.target.kind !== "private")
						throw new Error(created._nay?.message ?? "Expected a private source folder");
					sources.push(created._yay.target);
				} else sources.push({ kind: "saved", id: f.folders.get(path)! });
				const written = await f.t.mutation(internal.files_metadata.update_entries_by_path, {
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					userId: f.scope.userId,
					agentSource,
					path,
					set: metadata,
					remove: [],
				});
				expect(written._yay?.entries, "the normal metadata writer accepts the dense supported map").toEqual(metadata);
			}
			let targetParent: files_PendingParent =
				scenario === "private roots" ? { kind: "saved", id: f.folders.get("/target")! } : { kind: "root" };
			const targetPath = scenario === "private roots" ? "/target" : "/new-parent/target";
			if (scenario === "new private parents") {
				// mv needs an existing parent. The normal mkdir door creates both missing drafts first.
				const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					userId: f.scope.userId,
					threadId: thread._yay.threadId,
					agentSource,
					path: targetPath,
					kind: "folder",
				});
				if (created._nay || created._yay.target.kind !== "private")
					throw new Error(created._nay?.message ?? "Expected the new private destination");
				targetParent = created._yay.target;
			}
			const savedBefore = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const calls: Array<{
				entryStep: Doc<"files_transfer_runs">["step"];
				cost: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;
			}> = [];
			test_spy_handler(advance, async (handler, ctx, args) => {
				const { runId } = args as { runId: Id<"files_transfer_runs"> };
				const run = (await ctx.db.get("files_transfer_runs", runId))!;
				const result = await handler(ctx, args);
				calls.push({ entryStep: run.step, cost: await ctx.meta.getTransactionMetrics() });
				return result;
			});
			const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.scope.membershipId,
				threadId: thread._yay.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				requestId: `apply-budget-${scenario}`,
				kind: "move",
				expectedSourceCount: sources.length,
				sources,
				targetParent,
				targetPath,
				targetName: null,
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const { runId } = started._yay;
			const holds = () =>
				f.t.run((ctx) =>
					ctx.db
						.query("files_pending_holds")
						.withIndex("by_producer_pendingUpdate_role", (q) =>
							q.eq("producer.kind", "files_transfer_run").eq("producer.id", runId),
						)
						.collect(),
				);
			if (scenario === "private roots")
				expect(
					(await holds()).map((hold) => hold.target),
					"Start holds all eight private sources",
				).toEqual(sources);
			else
				expect(await holds(), "Start holds the new private destination").toMatchObject([
					{ target: targetParent, role: "destination_parent" },
				]);
			expect(
				await f.t.mutation(internal.files_transfer.seal_for_agent, {
					membershipId: f.scope.membershipId,
					threadId: thread._yay.threadId,
					runId,
				}),
			).toEqual({ _yay: null });
			let firstApplyCall: (typeof calls)[number] | undefined;
			for (let step = 0; step < 30; step++) {
				await f.t.mutation(internal.files_transfer.advance, { runId });
				const view = await f.asUser.query(api.files_transfer.get, { membershipId: f.scope.membershipId, runId });
				if (view?.activity.progress.completed === 1) {
					firstApplyCall = calls.at(-1);
					break;
				}
				if (step === 29) throw new Error("The parent did not reach its first proposal Apply");
			}
			expect(
				["select", "normalize", "plan"],
				"the first proposal Apply shares its transaction with an earlier parent phase",
			).toContain(firstApplyCall?.entryStep);
			expect(await holds(), "the first proposal Apply keeps its output hold").toEqual(
				expect.arrayContaining([expect.objectContaining({ target: sources[0], role: "output" })]),
			);
			if (scenario === "new private parents")
				expect(await holds(), "Apply keeps the destination hold until the parent finishes").toEqual(
					expect.arrayContaining([expect.objectContaining({ target: targetParent, role: "destination_parent" })]),
				);
			await test_finish_transfer_run(f.asUser, runId);
			expect(
				(await f.asUser.query(api.files_transfer.get, { membershipId: f.scope.membershipId, runId }))?.activity,
				"all eight exact source IDs finish as proposals",
			).toMatchObject({ status: "succeeded", progress: { completed: sources.length, failed: 0, canceled: 0 } });
			const items = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			);
			expect(
				items.map((item) => item.outputTarget),
				"Apply preserves every source ID",
			).toEqual(sources);
			for (const [index, source] of sources.entries()) {
				const name = `source-${index}`;
				expect(items[index]).toMatchObject({
					sourcePath: paths[index],
					outputName: name,
					outputPath: `${targetPath}/${name}`,
				});
				const pending = await f.asUser.query(api.files_pending_updates.get_file_pending_update, {
					membershipId: f.scope.membershipId,
					target: source,
				});
				if (source.kind === "private") {
					expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", source.id))).toMatchObject({
						_id: source.id,
						name,
						parent: targetParent,
						state: "active",
					});
					expect(pending?.createIntent?.metadata, "private Move keeps the full dense metadata map").toEqual(metadata);
				} else {
					expect(pending?.pendingMove, "saved Move stores the new private parent in its proposal").toMatchObject({
						destParent: targetParent,
						destName: name,
						fromPath: paths[index],
					});
					expect(
						await f.asUser.query(api.files_metadata.get_entries, {
							membershipId: f.scope.membershipId,
							fileNodeId: source.id,
						}),
						"saved proposals keep the dense source metadata map",
					).toEqual(metadata);
				}
			}
			if (targetParent.kind === "private") {
				const targetId = targetParent.id;
				const target = await f.t.run((ctx) => ctx.db.get("files_pending_nodes", targetId));
				expect(target).toMatchObject({ _id: targetId, name: "target", state: "active" });
				if (target?.parent.kind !== "private") throw new Error("Expected the new draft parent chain");
				const parentId = target.parent.id;
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", parentId))).toMatchObject({
					name: "new-parent",
					parent: { kind: "root" },
					state: "active",
				});
			}
			expect(
				await f.t.run((ctx) => ctx.db.query("files_nodes").collect()),
				"proposal Apply leaves saved headers unchanged",
			).toEqual(savedBefore);
			expect(calls.length, "the registered proposal Apply wrapper was measured").toBeGreaterThan(0);
			const peaks = new Map<string, number>();
			for (const { cost } of calls)
				for (const [key, metric] of Object.entries(cost)) {
					expect(metric.used, `${scenario}: ${key} includes final flush and leaves 25% free`).toBeLessThan(
						(metric.used + metric.remaining) * 0.75,
					);
					peaks.set(key, Math.max(peaks.get(key) ?? 0, metric.used));
				}
			console.info("first joined Move Apply", scenario, JSON.stringify(firstApplyCall));
			console.info("joined Move Apply peaks", scenario, JSON.stringify(Object.fromEntries(peaks)));
		},
		60_000,
	);

	test("keeps input idle until sealed and refuses a changed replay", async () => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start({ f, sources: [source], expectedCount: 3 });
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await start({ f, sources: [source], expectedCount: 3 })).toEqual(started);
		expect(await start({ f, sources: [source], expectedCount: 4 })).toMatchObject({
			_nay: { name: "request_changed" },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toMatchObject({
			_nay: { name: "incomplete_selection" },
		});
		const page = { ...args, offset: 1, sourceIds: [source, source] };
		expect(await f.asUser.mutation(api.files_transfer.append_input, page)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.append_input, page)).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				...page,
				sourceIds: [f.folders.get("/target")!, source],
			}),
		).toMatchObject({ _nay: { name: "request_changed" } });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toHaveLength(3);
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.append_input, page)).toEqual({ _yay: null });
		for (let step = 0; step < 2; step++) await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ source: { kind: "saved", id: source }, parentItemId: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("activities").collect())).toHaveLength(1);
	});

	test("normalizes a later selected ancestor after more than 200 input entries", async () => {
		const f = await fixture(["/source", "/source/child", "/target"]);
		const child = f.folders.get("/source/child")!;
		const started = await start({
			f,
			sources: Array.from({ length: 100 }, () => child),
			expectedCount: 201,
		});
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				...args,
				offset: 100,
				sourceIds: Array.from({ length: 100 }, () => child),
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				...args,
				offset: 200,
				sourceIds: [f.folders.get("/source")!],
			}),
		).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		// Select pages, then one Normalize unit per input.
		for (let step = 0; step < 201 + 32; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId));
			if (run?.step === "discover") break;
		}
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ source: { kind: "saved", id: f.folders.get("/source") }, sourcePath: "/source" });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(3);
	});

	test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid offset %s without appending", async (offset) => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start({ f, sources: [source], expectedCount: 2 });
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				membershipId: f.scope.membershipId,
				runId: started._yay.runId,
				offset,
				sourceIds: [source],
			}),
		).toMatchObject({ _nay: { name: "invalid_selection" } });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toHaveLength(1);
	});

	test("accepts a Move past the old 139-source limit in selection pages", async () => {
		const paths = Array.from({ length: 140 }, (_, index) => `/source-${index}`);
		const f = await fixture(["/target", ...paths]);
		const sourceIds = paths.map((path) => f.folders.get(path)!);
		const started = await f.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: f.scope.membershipId,
			requestId: "move-140",
			kind: "move",
			expectedSourceCount: sourceIds.length,
			sourceIds: sourceIds.slice(0, 100),
			targetParentId: f.folders.get("/target")!,
		});
		expect(started).toMatchObject({ _yay: { runId: expect.any(String) } });
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				...args,
				offset: 100,
				sourceIds: sourceIds.slice(100),
			}),
		).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toHaveLength(140);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceIds[139]!))).toMatchObject({ path: paths[139] });
	}, 60_000);

	test("plans every root after 200 sources and keeps originals unchanged", async () => {
		const paths = Array.from({ length: 201 }, (_, index) => `/source-${index}`);
		const f = await fixture(["/target", ...paths]);
		const sourceIds = paths.map((path) => f.folders.get(path)!);
		const started = await start({ f, sources: sourceIds.slice(0, 100), expectedCount: sourceIds.length });
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		for (let offset = 100; offset < sourceIds.length; offset += 100)
			expect(
				await f.asUser.mutation(api.files_transfer.append_input, {
					...args,
					offset,
					sourceIds: sourceIds.slice(offset, offset + 100),
				}),
			).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		// Select, Normalize, Discover and Plan must all reach their real end.
		for (let step = 0; step < sourceIds.length * 4; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId));
			if (run?.step === "apply") break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId))).toMatchObject({ step: "apply" });
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(201);
		expect(new Set(items.map((item) => item.plannedPath))).toEqual(new Set(paths.map((path) => `/target${path}`)));
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(202);
	}, 60_000);

	test("discovers past 10,000 items in bounded pages before output", async () => {
		const f = await fixture();
		const sourceId = f.folders.get("/source")!;
		const source = (await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId)))!;
		const { _id, _creationTime, ...fields } = source;
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 120; index++) {
				const name = `child-${String(index).padStart(5, "0")}`;
				await ctx.db.insert("files_nodes", {
					...fields,
					parentId: sourceId,
					name,
					sortName: files_sort_text_key(name),
					path: `/source/${name}`,
					treePath: `/source/${name}/`,
					pathDepth: 2,
				});
			}
		});
		const started = await start({ f, sources: [sourceId] });
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });

		// Copy once refused a run past 10,000 discovered items, and that check read only this count.
		// Start the count as if 9,900 items were already found, so the 120 children cross 10,000
		// without 10,000 real rows.
		await f.t.run(async (ctx) => {
			const activity = (await ctx.db.query("activities").collect()).find(
				(row) => row.source.kind === "files_transfer_run" && row.source.id === args.runId,
			)!;
			await ctx.db.patch("activities", activity._id, { progress: { ...activity.progress!, discovered: 9_900 } });
		});

		const pageSizes: number[] = [];
		let discovered = 9_900;
		for (let step = 0; step < 10; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const view = await f.asUser.query(api.files_transfer.get, args);
			const added = view!.activity.progress.discovered - discovered;
			if (added > 0) pageSizes.push(added);
			discovered = view!.activity.progress.discovered;
			const root = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", args.runId).eq("order", 0))
					.unique(),
			);
			if (root?.discoveryDone) break;
		}
		// The first step adds the selected folder itself. Then its children come in pages of at most 50.
		expect(pageSizes).toEqual([1, 50, 50, 20]);
		const view = await f.asUser.query(api.files_transfer.get, args);
		expect(view).toMatchObject({
			step: "discover",
			activity: {
				status: "running",
				errorMessage: null,
				progress: { discovered: 10_021, completed: 0 },
			},
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", args.runId).eq("order", 10_020))
					.unique(),
			),
		).toMatchObject({ sourcePath: "/source/child-00119", outputTarget: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(source);
	}, 60_000);

	test("Stop prevents later pages and seal; cleanup drains selection pages", async () => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start({ f, sources: [source], expectedCount: 2 });
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await f.asUser.mutation(api.files_transfer.stop, args)).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, { ...args, offset: 1, sourceIds: [source] }),
		).toMatchObject({ _nay: { name: "timed_out" } });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toHaveProperty("_nay");
		for (let step = 0; step < 3; step++)
			await f.t.mutation(internal.files_transfer.delete_run_batch, { runId: args.runId });
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(2);
	});
});
