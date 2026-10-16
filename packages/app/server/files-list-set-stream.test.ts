import { describe, expect, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { test_convex } from "../convex/setup-base.test.ts";
import { files_list_bitmap_from_offsets, type files_list_bitmap_Container } from "./files-list-bitmap.ts";
import {
	files_list_set_directory_db_lookup,
	files_list_set_directory_db_update,
	type files_list_set_directory_Handle,
} from "./files-list-set-directory.ts";
import {
	files_list_set_stream_db_block_at,
	files_list_set_stream_db_next,
	type files_list_set_stream_Expr,
} from "./files-list-set-stream.ts";

type Handle = files_list_set_directory_Handle;
type Expr = files_list_set_stream_Expr;
const github: Handle["namespace"] = { kind: "global", workspaceId: "GITHUB" };
const high = (1n << 63n) - 1n;
const maxKey = (1n << 50n) - 1n;

function empty(namespace = github, family: Handle["family"] = "policy_entries"): Handle {
	const kinds = {
		policy_entries: { ownerKind: "policy", memberKind: "entry" },
		audience_policies: { ownerKind: "audience", memberKind: "policy" },
	} as const;
	return { namespace, family, ...kinds[family], root: null };
}

function fixture() {
	const t = test_convex({ transactionLimits: true });
	return {
		write<T>(fn: (db: MutationCtx["db"]) => Promise<T>) {
			return t.run((ctx) => fn(ctx.db));
		},
		read<T>(fn: (db: QueryCtx["db"]) => Promise<T>) {
			return t.query((ctx) => fn(ctx.db));
		},
		// Return the call's own transaction metrics, so the test asserts its bounds right there.
		measure<T>(fn: (db: MutationCtx["db"]) => Promise<T>) {
			return t.run(async (ctx) => {
				const result = await fn(ctx.db);
				return { result, metrics: await ctx.meta.getTransactionMetrics() };
			});
		},
	};
}

type Fixture = ReturnType<typeof fixture>;

// Save each owner's members in one directory, 100 members per transaction. No cleanup runs in these tests, so the
// roots need no hold.
async function seed(f: Fixture, handle: Handle, sets: Map<bigint, bigint[]>) {
	let current = handle;
	for (const [ownerId, members] of sets) {
		for (let start = 0; start < members.length; start += 100) {
			current = await f.write(async (db) => {
				let next = current;
				for (const memberId of members.slice(start, start + 100)) {
					next = await files_list_set_directory_db_update(db, {
						scope: next,
						handle: next,
						ownerId,
						memberId,
						enabled: true,
					});
				}
				return next;
			});
		}
	}
	return current;
}

function model(expr: Expr, sets: Map<bigint, bigint[]>): Set<bigint> {
	if (expr.kind === "set") return new Set(sets.get(expr.ownerId));
	if (expr.kind === "difference") {
		const right = model(expr.right, sets);
		return new Set([...model(expr.left, sets)].filter((id) => !right.has(id)));
	}
	const inputs = expr.inputs.map((input) => model(input, sets));
	if (expr.kind === "union") return new Set(inputs.flatMap((input) => [...input]));
	return new Set([...inputs[0]!].filter((id) => inputs.every((input) => input.has(id))));
}

function blocks(ids: Iterable<bigint>) {
	const offsets = new Map<bigint, number[]>();
	for (const id of [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		offsets.set(id >> 13n, [...(offsets.get(id >> 13n) ?? []), Number(id & 8191n)]);
	}
	return [...offsets].map(([key, list]) => ({ key, container: files_list_bitmap_from_offsets(list) }));
}

// Measure the tree heights. A leaf reads one directory path, then at most one cursor path and one leftmost path of
// its bitmap set.
async function bound(f: Fixture, expr: Expr): Promise<number> {
	if (expr.kind === "difference") return (await bound(f, expr.left)) + (await bound(f, expr.right));
	if (expr.kind !== "set") {
		let total = 0;
		for (const input of expr.inputs) total += await bound(f, input);
		return total;
	}

	const { handle, ownerId } = expr;
	return f.read(async (db) => {
		const directory = (await db.get("files_list_set_pages", handle.root!))!.level + 1;
		const value = await files_list_set_directory_db_lookup(db, { scope: handle, handle, ownerId });
		if (value?.kind !== "bitmap") return directory;
		return directory + 2 * ((await db.get("files_list_set_pages", value.root))!.level + 1) - 1;
	});
}

async function drain(f: Fixture, expr: Expr, after: bigint | null) {
	const limit = await bound(f, expr);
	const found: { key: bigint; container: files_list_bitmap_Container }[] = [];
	let advances = 0;
	let cursor = after;
	for (let count = 0; count < 1000; count++) {
		const step = await f.measure((db) =>
			files_list_set_stream_db_next(db, { namespace: github, memberKind: "entry", expr, after: cursor }),
		);
		expect(step.metrics.documentsRead.used, "One stream step must keep its read bound").toBeLessThanOrEqual(limit);
		if (step.result.kind === "end") return { blocks: found, advances };
		const next = step.result.kind === "block" ? step.result.key : step.result.after;
		expect(cursor === null || next > cursor, "A step must advance its cursor or finish").toBe(true);
		if (step.result.kind === "block") found.push({ key: step.result.key, container: step.result.container });
		else advances++;
		cursor = next;
	}
	throw new Error("Small stream fixture did not finish");
}

describe("files_list_set_stream_db_next", () => {
	test("matches the exact set model for union, intersection and difference from arbitrary cursors", async () => {
		const f = fixture();
		// A and D are inline. B has 70 sparse blocks. C has a dense block 0. A, B and C reach the largest block.
		const sets = new Map([
			[1n, [0n, 5n, (3n << 13n) + 7n, high]],
			[2n, [...Array.from({ length: 70 }, (_, index) => (BigInt(index) << 13n) + BigInt(index % 3)), high - 1n]],
			[3n, [...Array.from({ length: 600 }, (_, index) => BigInt(index)), (3n << 13n) + 7n, (10n << 13n) + 1n, high]],
			[4n, [5n, (3n << 13n) + 7n, (10n << 13n) + 1n]],
		]);
		const handle = await seed(f, empty(), sets);
		const leaf = (ownerId: bigint): Expr => ({ kind: "set", handle, ownerId });
		const [a, b, c, d] = [leaf(1n), leaf(2n), leaf(3n), leaf(4n)];
		const expressions: Expr[] = [
			{ kind: "union", inputs: [a, b, c, d] },
			{ kind: "intersection", inputs: [b, c] },
			{ kind: "difference", left: c, right: { kind: "union", inputs: [a, d] } },
			{ kind: "difference", left: { kind: "intersection", inputs: [{ kind: "union", inputs: [a, b] }, c] }, right: d },
			// C minus A is empty in block 3, so this input advances while the other input has a block.
			{ kind: "union", inputs: [{ kind: "difference", left: c, right: a }, d] },
			{ kind: "intersection", inputs: [{ kind: "difference", left: c, right: a }, d] },
			{ kind: "union", inputs: [] },
		];
		for (const expr of expressions) {
			const expected = blocks(model(expr, sets));
			for (const after of [null, 0n, 3n, 40n, maxKey - 1n, maxKey]) {
				expect((await drain(f, expr, after)).blocks, "Streamed blocks must equal the exact set model").toEqual(
					expected.filter((block) => after === null || block.key > after),
				);
			}
			for (const key of [0n, 1n, 3n, 10n, 40n, 69n, 70n, maxKey]) {
				expect(
					await f.read((db) =>
						files_list_set_stream_db_block_at(db, { namespace: github, memberKind: "entry", expr, key }),
					),
					"Streamed blocks must equal the exact set model",
				).toEqual(expected.find((block) => block.key === key)?.container ?? null);
			}
		}
	});

	test("human and service sets that share a block but no entry give no block", async () => {
		const f = fixture();
		// The human set is inline and the service set is a bitmap. Both use only block 0.
		const sets = new Map([
			[1n, [0n, 2n, 4n]],
			[2n, Array.from({ length: 65 }, (_, index) => BigInt(index * 2 + 1))],
		]);
		const handle = await seed(f, empty(), sets);
		const expr: Expr = {
			kind: "intersection",
			inputs: [
				{ kind: "set", handle, ownerId: 1n },
				{ kind: "set", handle, ownerId: 2n },
			],
		};
		expect((await drain(f, expr, null)).blocks, "Disjoint entries in one shared block must not intersect").toEqual([]);
		expect(
			await f.read((db) =>
				files_list_set_stream_db_block_at(db, { namespace: github, memberKind: "entry", expr, key: 0n }),
			),
		).toBeNull();
	});

	test("each step returns a block, ends, or advances strictly", async () => {
		const f = fixture();
		// The block keys interleave, so the intersection must skip ahead. All three sets have block 0, but the second
		// set has a different member there. Only blocks 12 and 24 match.
		const sets = new Map([
			[1n, Array.from({ length: 16 }, (_, index) => BigInt(index * 2) << 13n)],
			[2n, Array.from({ length: 11 }, (_, index) => (BigInt(index * 3) << 13n) + (index === 0 ? 1n : 0n))],
			[3n, Array.from({ length: 8 }, (_, index) => BigInt(index * 4) << 13n)],
		]);
		const handle = await seed(f, empty(), sets);
		const expr: Expr = {
			kind: "intersection",
			inputs: [1n, 2n, 3n].map((ownerId): Expr => ({ kind: "set", handle, ownerId })),
		};
		const result = await drain(f, expr, null);
		expect(result.blocks).toEqual(blocks([12n << 13n, 24n << 13n]));
		expect(result.advances, "The fixture must make the intersection advance").toBeGreaterThan(0);
	});

	test("rejects mixed member kinds and namespaces before any page read", async () => {
		const f = fixture();
		// Only scope keys are needed here. Tenant existence and access are the caller's job.
		const workspace: Handle["namespace"] = {
			kind: "workspace",
			organizationId: "1organizations" as Id<"organizations">,
			workspaceId: "1organizations_workspaces" as Id<"organizations_workspaces">,
		};
		const volume: Handle["namespace"] = {
			kind: "volume",
			organizationId: workspace.organizationId,
			ownerWorkspaceId: workspace.workspaceId,
			installationId: "1plugins_workspace_installations" as Id<"plugins_workspace_installations">,
			volumeId: "1plugins_volumes" as Id<"plugins_volumes">,
			generationId: "1plugins_volume_generations" as Id<"plugins_volume_generations">,
		};
		// Every directory has the same owner and member IDs.
		const sets = new Map([[0n, [1n]]]);
		const set = async (namespace: Handle["namespace"], family: Handle["family"] = "policy_entries"): Promise<Expr> => ({
			kind: "set",
			handle: await seed(f, empty(namespace, family), sets),
			ownerId: 0n,
		});
		const entries = await set(workspace);
		const generation = await set(volume);
		const cases: [Handle["namespace"], Expr][] = [
			[workspace, { kind: "union", inputs: [entries, await set(workspace, "audience_policies")] }],
			[
				workspace,
				{
					kind: "intersection",
					inputs: [
						entries,
						await set({ ...workspace, workspaceId: "2organizations_workspaces" as Id<"organizations_workspaces"> }),
					],
				},
			],
			[
				volume,
				{
					kind: "difference",
					left: generation,
					right: await set({
						...volume,
						generationId: "2plugins_volume_generations" as Id<"plugins_volume_generations">,
					}),
				},
			],
			[volume, { kind: "union", inputs: [generation, await set(github)] }],
		];
		for (const [namespace, expr] of cases) {
			const step = await f.measure((db) =>
				files_list_set_stream_db_next(db, { namespace, memberKind: "entry", expr, after: null }).then(
					() => "resolved",
					(error: unknown) => String(error),
				),
			);
			expect(step.metrics.documentsRead.used, "A mixed-domain expression must fail before reading a page").toBe(0);
			expect(step.result).toContain("domain mismatch");
		}
	});
});
