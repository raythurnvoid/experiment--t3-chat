import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { internalMutation } from "../convex/functions.ts";
import { files_metadata_db_write_entries } from "../convex/files_metadata.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import {
	files_move_page_proof_db_wrap,
	files_move_page_proof_enable,
	files_move_page_proof_ledger,
} from "./files-move-page-proof.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("files_move_page_proof_db_wrap", () => {
	test("records real DB writes through both overloads without changing their results", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const spies = (["insert", "patch", "replace", "delete", "get"] as const).map((method) =>
				vi.spyOn(ctx.db, method),
			);
			const wrapped = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			files_move_page_proof_enable(wrapped);
			const firstValue = { clerkUserId: "proof-first" };
			const first = await wrapped.db.insert("users", firstValue);
			const second = await wrapped.db.insert("users", { clerkUserId: "proof-second" });
			const patch = { deletedAt: 1 };
			expect(await wrapped.db.patch("users", first, patch)).toBeUndefined();
			expect(await wrapped.db.patch(second, patch)).toBeUndefined();
			const replacement = { clerkUserId: "proof-replaced" };
			expect(await wrapped.db.replace("users", first, replacement)).toBeUndefined();
			expect(await wrapped.db.replace(second, replacement)).toBeUndefined();
			expect((await wrapped.db.get("users", first))?.clerkUserId).toBe("proof-replaced");
			expect((await wrapped.db.get(second))?.clerkUserId).toBe("proof-replaced");
			expect(await wrapped.db.delete("users", first)).toBeUndefined();
			expect(await wrapped.db.delete(second)).toBeUndefined();
			expect(await ctx.db.get("users", first)).toBeNull();
			expect(await ctx.db.get("users", second)).toBeNull();
			expect(files_move_page_proof_ledger(wrapped), "Every successful DB write keeps its exact ID").toEqual([
				{ operation: "insert", id: first },
				{ operation: "insert", id: second },
				{ operation: "patch", id: first },
				{ operation: "patch", id: second },
				{ operation: "replace", id: first },
				{ operation: "replace", id: second },
				{ operation: "delete", id: first },
				{ operation: "delete", id: second },
			]);
			for (const spy of spies) expect(spy.mock.contexts.every((receiver) => receiver === ctx.db)).toBe(true);
			expect(spies.map((spy) => spy.mock.calls.length)).toEqual([2, 2, 2, 2, 4]);
			expect(spies[0]!.mock.calls[0]![1]).toBe(firstValue);
			const patchArgs: readonly unknown[] = spies[1]!.mock.calls[0]!;
			expect(patchArgs[2]).toBe(patch);
			expect(spies[2]!.mock.calls[1]![1]).toBe(replacement);
			files_move_page_proof_enable(wrapped);
			const snapshot = files_move_page_proof_ledger(wrapped);
			snapshot.pop();
			expect(files_move_page_proof_ledger(wrapped)).toHaveLength(8);
		});
	});

	test("records actual scheduler IDs and preserves its receiver and arguments", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const after = vi.spyOn(ctx.scheduler, "runAfter");
			const at = vi.spyOn(ctx.scheduler, "runAt");
			const cancel = vi.spyOn(ctx.scheduler, "cancel");
			const wrapped = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			files_move_page_proof_enable(wrapped);
			const args = { _test_disableReschedule: true };
			const cleanup = internal.activities.cleanup_history;
			const afterId = await wrapped.scheduler.runAfter(60_000, cleanup, args);
			const date = new Date(Date.now() + 120_000);
			const atId = await wrapped.scheduler.runAt(date, cleanup, args);
			expect((await ctx.db.system.get("_scheduled_functions", afterId))?.state.kind).toBe("pending");
			expect((await ctx.db.system.get("_scheduled_functions", atId))?.state.kind).toBe("pending");
			expect(await wrapped.scheduler.cancel(afterId)).toBeUndefined();
			expect(await wrapped.scheduler.cancel(atId)).toBeUndefined();
			expect(files_move_page_proof_ledger(wrapped)).toEqual([
				{ operation: "runAfter", id: afterId },
				{ operation: "runAt", id: atId },
				{ operation: "cancel", id: afterId },
				{ operation: "cancel", id: atId },
			]);
			expect(after.mock.calls).toEqual([[60_000, cleanup, args]]);
			expect(at.mock.calls).toEqual([[date, cleanup, args]]);
			expect(after.mock.calls[0]![1]).toBe(cleanup);
			expect(after.mock.calls[0]![2]).toBe(args);
			expect(at.mock.calls[0]![0]).toBe(date);
			expect(at.mock.calls[0]![1]).toBe(cleanup);
			expect(at.mock.calls[0]![2]).toBe(args);
			for (const spy of [after, at, cancel])
				expect(spy.mock.contexts.every((receiver) => receiver === ctx.scheduler)).toBe(true);
		});
	});

	test("stays disabled until explicitly enabled and keeps each wrapper's state separate", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const first = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			const second = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			const id = await first.db.insert("users", { clerkUserId: "proof-disabled" });
			await first.db.patch(id, { deletedAt: 1 });
			await first.db.replace(id, { clerkUserId: "proof-disabled-replaced" });
			await first.db.delete(id);
			const afterId = await first.scheduler.runAfter(60_000, internal.activities.cleanup_history, {});
			const atId = await first.scheduler.runAt(Date.now() + 120_000, internal.activities.cleanup_history, {});
			await first.scheduler.cancel(afterId);
			await first.scheduler.cancel(atId);
			expect(files_move_page_proof_ledger(first)).toEqual([]);
			files_move_page_proof_enable(first);
			const enabledId = await first.db.insert("users", { clerkUserId: "proof-enabled" });
			await second.db.insert("users", { clerkUserId: "proof-other-parent" });
			expect(files_move_page_proof_ledger(first)).toEqual([{ operation: "insert", id: enabledId }]);
			expect(files_move_page_proof_ledger(second)).toEqual([]);
		});
	});

	test("forwards exact rejected errors and records no failed DB or scheduler call", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const id = await ctx.db.insert("users", { clerkUserId: "proof-errors" });
			const wrapped = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			files_move_page_proof_enable(wrapped);
			for (const operation of ["insert", "patch", "replace", "delete"] as const) {
				const error = new Error(`proof-${operation}`);
				const spy = vi.spyOn(ctx.db, operation).mockRejectedValueOnce(error);
				const args =
					operation === "insert"
						? ["users", { clerkUserId: "failed" }]
						: operation === "delete"
							? ["users", id]
							: ["users", id, { clerkUserId: "failed" }];
				await expect(Reflect.apply(Reflect.get(wrapped.db, operation), wrapped.db, args)).rejects.toBe(error);
				expect(spy).toHaveBeenCalledExactlyOnceWith(...args);
				expect(spy.mock.contexts[0]).toBe(ctx.db);
				spy.mockRestore();
			}
			for (const operation of ["runAfter", "runAt", "cancel"] as const) {
				const error = new Error(`proof-${operation}`);
				const spy = vi.spyOn(ctx.scheduler, operation).mockRejectedValueOnce(error);
				const args = operation === "cancel" ? ["failed-job"] : [60_000, internal.activities.cleanup_history, {}];
				await expect(
					Reflect.apply(Reflect.get(wrapped.scheduler, operation), wrapped.scheduler, args),
				).rejects.toBe(error);
				expect(spy).toHaveBeenCalledExactlyOnceWith(...args);
				expect(spy.mock.contexts[0]).toBe(ctx.scheduler);
				spy.mockRestore();
			}
			expect(files_move_page_proof_ledger(wrapped)).toEqual([]);
			expect((await ctx.db.get("users", id))?.clerkUserId).toBe("proof-errors");
		});
	});

	test("forwards synchronous errors without recording a successful call", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const wrapped = { ...ctx, ...files_move_page_proof_db_wrap(ctx) };
			files_move_page_proof_enable(wrapped);
			const error = new Error("proof-synchronous-error");
			vi.spyOn(ctx.db, "insert").mockImplementationOnce(() => {
				throw error;
			});
			vi.spyOn(ctx.scheduler, "runAfter").mockImplementationOnce(() => {
				throw error;
			});
			await expect(wrapped.db.insert("users", { clerkUserId: "failed" })).rejects.toBe(error);
			await expect(wrapped.scheduler.runAfter(60_000, internal.activities.cleanup_history, {})).rejects.toBe(error);
			expect(files_move_page_proof_ledger(wrapped)).toEqual([]);
		});
	});

	test("keeps one ledger through the real builder and its catalog flush", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "/proof-metadata",
		});
		if (created._nay) throw new Error(created._nay.message);
		const observations: { ctx: MutationCtx; beforeFlush: ReturnType<typeof files_move_page_proof_ledger> }[] = [];
		const write = internalMutation({
			args: {},
			returns: v.null(),
			handler: async (ctx) => {
				files_move_page_proof_enable(ctx);
				const fileNode = (await ctx.db.get("files_nodes", created._yay.nodeId))!;
				await files_metadata_db_write_entries(ctx, { fileNode, entries: [{ key: "status", value: "open" }] });
				observations.push({ ctx, beforeFlush: files_move_page_proof_ledger(ctx) });
				return null;
			},
		});
		const registered = write as unknown as { _handler: (ctx: MutationCtx, args: unknown) => Promise<null> };
		expect(await t.run((ctx) => registered._handler(ctx, {}))).toBeNull();
		expect(observations).toHaveLength(1);
		const observation = observations[0]!;
		const ledger = files_move_page_proof_ledger(observation.ctx);
		const [deltas, marker] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_metadata_catalog_deltas")
					.withIndex("by_org_ws", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
					)
					.collect(),
				ctx.db
					.query("files_metadata_catalog_compactors")
					.withIndex("by_org_ws", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
					)
					.unique(),
			]),
		);
		expect(deltas.length).toBeGreaterThan(0);
		expect(marker).not.toBeNull();
		for (const id of [...deltas.map((doc) => doc._id), marker!._id]) {
			expect(observation.beforeFlush.some((entry) => entry.id === id)).toBe(false);
			expect(
				ledger.filter((entry) => entry.operation === "insert" && entry.id === id),
				"The ledger includes every real catalog flush insert",
			).toHaveLength(1);
		}
		const scheduled = ledger.filter((entry) => entry.operation === "runAfter");
		expect(scheduled, "The same ledger includes the real flush schedule").toHaveLength(1);
		const job = await t.run((ctx) =>
			ctx.db.system.get("_scheduled_functions", scheduled[0]!.id as Id<"_scheduled_functions">),
		);
		expect(job?.args).toEqual([{ markerId: marker!._id }]);
		expect(observation.beforeFlush.some((entry) => entry.operation === "runAfter")).toBe(false);
	});
});
