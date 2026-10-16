import { describe, expect, test } from "vitest";
import { compareValues, getDocumentSize } from "convex/values";
import type { Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { test_convex } from "../convex/setup-base.test.ts";
import { files_list_bitmap_decode, files_list_bitmap_from_offsets } from "./files-list-bitmap.ts";
import {
	files_list_set_directory_db_cleanup_step,
	files_list_set_directory_db_derive,
	files_list_set_directory_db_has,
	files_list_set_directory_db_hold,
	files_list_set_directory_db_lookup,
	files_list_set_directory_db_next_block,
	files_list_set_directory_db_update,
	type files_list_set_directory_Handle,
} from "./files-list-set-directory.ts";

type Handle = files_list_set_directory_Handle;
type Scope = Pick<Handle, "namespace" | "family">;
const scope: Scope = { namespace: { kind: "global", workspaceId: "GITHUB" }, family: "policy_entries" };

function empty(currentScope: Scope = scope): Handle {
	const kinds = {
		policy_entries: { ownerKind: "policy", memberKind: "entry" },
		audience_policies: { ownerKind: "audience", memberKind: "policy" },
	} as const;
	return { ...currentScope, ...kinds[currentScope.family], root: null };
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
		// Return the write's own transaction metrics, so the test asserts its bounds right there.
		measure<T>(fn: (db: MutationCtx["db"]) => Promise<T>) {
			return t.run(async (ctx) => {
				const result = await fn(ctx.db);
				return { result, metrics: await ctx.meta.getTransactionMetrics() };
			});
		},
	};
}

type Fixture = ReturnType<typeof fixture>;

async function hold(
	db: MutationCtx["db"],
	handle: Handle,
	id = "current",
	purpose: "head" | "capture" | "writer" = "head",
) {
	await files_list_set_directory_db_hold(db, { scope: handle, handle, hold: { kind: "hold", purpose, id } });
}

async function cleanup(f: Fixture, currentScope: Scope = scope) {
	for (let count = 0; count < 30000; count++) {
		const step = await f.measure((db) => files_list_set_directory_db_cleanup_step(db, currentScope));
		// One step reads at most 4 docs plus 2 per page reference, and writes at most 2 docs plus 2 per reference.
		// A page has at most 32 references.
		expect(step.metrics.documentsRead.used, "One cleanup step must keep its read bound").toBeLessThanOrEqual(
			4 + 2 * 32,
		);
		expect(step.metrics.databaseQueries.used, "One cleanup step must use at most 4 index ranges").toBeLessThanOrEqual(
			4,
		);
		expect(step.metrics.documentsWritten.used, "One cleanup step must keep its write bound").toBeLessThanOrEqual(
			2 + 2 * 32,
		);
		if (step.result.done) return;
	}
	throw new Error("Small cleanup fixture did not finish");
}

async function change(f: Fixture, handle: Handle, ownerId: bigint, memberId: bigint, enabled = true) {
	return f.write(async (db) => {
		const next = await files_list_set_directory_db_update(db, { scope: handle, handle, ownerId, memberId, enabled });
		await hold(db, next);
		return next;
	});
}

async function lookup(f: Fixture, handle: Handle, ownerId: bigint) {
	return f.read((db) => files_list_set_directory_db_lookup(db, { scope: handle, handle, ownerId }));
}

async function has(f: Fixture, handle: Handle, ownerId: bigint, memberId: bigint) {
	return f.read((db) => files_list_set_directory_db_has(db, { scope: handle, handle, ownerId, memberId }));
}

async function seed(f: Fixture, handle: Handle, ownerId: bigint, members: bigint[]) {
	let next = handle;
	for (const memberId of members) next = await change(f, next, ownerId, memberId);
	await cleanup(f, handle);
	return next;
}

// Inspect persisted bytes in the test, without adding an inspection-only app export.
async function audit(f: Fixture, handle: Handle) {
	return f.read(async (db) => {
		const seen = new Set<Id<"files_list_set_pages">>();
		const totals = {
			pages: 0,
			bodyBytes: 0,
			documentBytes: 0,
			edges: 0,
			edgeBytes: 0,
			maxDocumentBytes: 0,
			maxRefs: 0,
		};
		async function visit(id: Id<"files_list_set_pages">, root: boolean): Promise<void> {
			const page = await db.get("files_list_set_pages", id);
			if (!page) throw new Error("Missing retained page");
			expect(compareValues(page.namespace, handle.namespace)).toBe(0);
			expect(page.family).toBe(handle.family);
			const view = new DataView(page.body);
			const kind = view.getUint8(0);
			const count = view.getUint16(2);
			let position = 4;
			let weight = 0;
			let previous = -1n;
			for (let index = 0; index < count; index++) {
				const key = view.getBigUint64(position);
				expect(key).toBeGreaterThan(previous);
				previous = key;
				position += 8;
				if (kind === 1) {
					const block = files_list_bitmap_decode(page.body, position);
					position += block.bytesRead;
					weight += 8 + block.bytesRead;
				} else if (kind === 2) {
					const tag = view.getUint8(position++);
					if (tag === 0) {
						const members = view.getUint8(position++);
						expect(members).toBeGreaterThan(0);
						expect(members).toBeLessThanOrEqual(64);
						position += members * 8;
						weight += 10 + members * 8;
					} else {
						expect(tag).toBe(1);
						expect(view.getBigUint64(position)).toBeGreaterThanOrEqual(65n);
						position += 9;
						weight += 256;
					}
				} else {
					expect(kind).toBe(3);
					position++;
					weight += 9;
				}
			}
			expect(position).toBe(page.body.byteLength);
			expect(weight + 4).toBeLessThanOrEqual(8192);
			if (kind === 3) {
				expect(count).toBeLessThanOrEqual(16);
				if (!root) expect(count).toBeGreaterThanOrEqual(8);
			} else if (!root) {
				expect(weight, "Non-root leaf weight must survive split and repair").toBeGreaterThanOrEqual(3072);
			}
			expect(page.children.length).toBeLessThanOrEqual(32);
			expect(getDocumentSize(page)).toBeLessThanOrEqual(12288);
			const edges = await db
				.query("files_list_set_edges")
				.withIndex("by_namespace_family_owner", (q) =>
					q.eq("namespace", handle.namespace).eq("family", handle.family).eq("owner", { kind: "page", pageId: id }),
				)
				.take(33);
			expect(edges.map((edge) => edge.target).sort()).toEqual([...page.children].sort());
			if (seen.has(id)) return;
			seen.add(id);
			totals.pages++;
			totals.bodyBytes += page.body.byteLength;
			totals.documentBytes += getDocumentSize(page);
			totals.maxDocumentBytes = Math.max(totals.maxDocumentBytes, getDocumentSize(page));
			totals.maxRefs = Math.max(totals.maxRefs, page.children.length);
			totals.edges += edges.length;
			totals.edgeBytes += edges.reduce((sum, edge) => sum + getDocumentSize(edge), 0);
			for (const child of page.children) await visit(child, kind === 2);
		}
		if (handle.root !== null) await visit(handle.root, true);
		return totals;
	});
}

describe("files_list_set_directory_db_update", () => {
	test("stores only namespace and family from a wider handle", async () => {
		const f = fixture();
		const handle = empty();
		const write = f.write(async (db) => {
			const next = await files_list_set_directory_db_update(db, {
				scope: handle,
				handle,
				ownerId: 0n,
				memberId: 0n,
				enabled: true,
			});
			await hold(db, next);
			return db.get("files_list_set_pages", next.root!);
		});
		await expect(
			write,
			"A wider handle must store only the schema's namespace and family fields",
		).resolves.toMatchObject(scope);
	});

	test("keeps zero absent, exact 64/65 changes, high IDs and old captures", async () => {
		const f = fixture();
		let current = empty();
		const ids = [0n, ...Array.from({ length: 64 }, (_, index) => (1n << 62n) + BigInt(index) * 8192n)];
		expect(await lookup(f, current, 0n)).toBeNull();
		current = await seed(f, current, 0n, ids.slice(0, 64));
		const inline = current;
		await f.write((db) => hold(db, inline, "inline", "capture"));
		expect(await lookup(f, current, 0n)).toEqual({ kind: "inline", ids: ids.slice(0, 64) });
		await audit(f, current);
		const promotion = await f.measure(async (db) => {
			const next = await files_list_set_directory_db_update(db, {
				scope: inline,
				handle: inline,
				ownerId: 0n,
				memberId: ids[64]!,
				enabled: true,
			});
			await hold(db, next);
			return next;
		});
		// The 65 IDs sit in 65 blocks here. Promotion must still save one bitmap leaf, not one page per block.
		expect(promotion.metrics.documentsWritten.used, "Promotion must save one bitmap leaf").toBeLessThanOrEqual(10);
		expect(promotion.metrics.documentsRead.used, "Promotion must not edit one block at a time").toBeLessThanOrEqual(12);
		current = promotion.result;
		await cleanup(f);
		const promoted = current;
		await f.write((db) => hold(db, promoted, "promoted", "capture"));
		expect(await lookup(f, current, 0n)).toMatchObject({ kind: "bitmap", count: 65n });
		await audit(f, current);
		for (const id of ids) expect(await has(f, current, 0n, id)).toBe(true);
		expect(await has(f, inline, 0n, ids[64]!)).toBe(false);
		current = await change(f, current, 0n, ids[64]!, false);
		await cleanup(f);
		expect(await lookup(f, current, 0n)).toEqual({ kind: "inline", ids: ids.slice(0, 64) });
		expect(await has(f, promoted, 0n, ids[64]!)).toBe(true);
		for (const id of ids.slice(0, 64)) current = await change(f, current, 0n, id, false);
		await cleanup(f);
		expect(current.root).toBeNull();
		expect(await has(f, inline, 0n, 0n)).toBe(true);
		await f.write(async (db) => {
			await hold(db, empty(), "inline", "capture");
			await hold(db, empty(), "promoted", "capture");
		});
		await cleanup(f);
		expect(await f.read((db) => db.query("files_list_set_pages").first())).toBeNull();
	});

	test("duplicate adds and absent removes write no pages in either layout", async () => {
		const f = fixture();
		let current = await change(f, empty(), 0n, 0n);
		for (const count of [1, 65]) {
			if (count === 65)
				current = await seed(
					f,
					current,
					0n,
					Array.from({ length: 65 }, (_, index) => BigInt(index)),
				);
			for (const [memberId, enabled] of [
				[0n, true],
				[90n, false],
			] as const) {
				const write = await f.measure((db) =>
					files_list_set_directory_db_update(db, { scope, handle: current, ownerId: 0n, memberId, enabled }),
				);
				expect(write.result.root).toBe(current.root);
				expect(write.metrics.documentsWritten.used, "A duplicate edit must not write a new root").toBe(0);
			}
		}
	});

	test("uses the app sparse/dense codec at 511/512 and keeps exact cardinality", async () => {
		const f = fixture();
		let current = await seed(
			f,
			empty(),
			2n,
			Array.from({ length: 511 }, (_, index) => BigInt(index)),
		);
		async function blockKind(handle: Handle) {
			const value = await lookup(f, handle, 2n);
			if (value?.kind !== "bitmap") throw new Error("Expected bitmap root");
			return f.read(async (db) => {
				const page = await db.get("files_list_set_pages", value.root);
				if (!page) throw new Error("Missing bitmap page");
				// Skip the 4-byte page header and the first 8-byte key.
				return files_list_bitmap_decode(page.body, 4 + 8).container.kind;
			});
		}
		expect(await blockKind(current)).toBe("sparse");
		current = await change(f, current, 2n, 511n);
		expect(await blockKind(current)).toBe("dense");
		expect(await lookup(f, current, 2n)).toMatchObject({ count: 512n });
		await audit(f, current);
		current = await change(f, current, 2n, 0n, false);
		expect(await blockKind(current)).toBe("sparse");
		expect(await lookup(f, current, 2n)).toMatchObject({ count: 511n });
		expect(await has(f, current, 2n, 0n)).toBe(false);
		expect(await has(f, current, 2n, 511n)).toBe(true);
	});

	test("packs 454 singleton owners before splitting and repairs a leaf with mixed record weights", async () => {
		const f = fixture();
		let current = empty();
		for (let index = 0; index < 455; index++) {
			current = await change(f, current, BigInt(index), 0n);
			await cleanup(f);
			if (index === 453) {
				const full = await audit(f, current);
				expect(full.pages).toBe(1);
				expect(full.bodyBytes).toBe(8176);
			}
		}
		expect((await audit(f, current)).pages).toBe(3);

		// The split keeps owners 0..170 in the left leaf. Give that leaf a 64-member inline record (weight 522) and a
		// bitmap record (weight 256) next to its singletons (weight 18). The leaf then weighs 3,820.
		const members = Array.from({ length: 65 }, (_, index) => BigInt(index) << 13n);
		current = await seed(f, current, 0n, members.slice(0, 64));
		current = await seed(f, current, 1n, members);
		// 42 removals drop the left leaf to 3,064, below the 3,072 minimum. So it must merge with its neighbor.
		for (let ownerId = 2n; ownerId < 44n; ownerId++) {
			current = await change(f, current, ownerId, 0n, false);
			await cleanup(f);
			await audit(f, current);
		}
		expect((await audit(f, current)).pages, "One merged leaf and one bitmap page must remain").toBe(2);
		expect(await lookup(f, current, 0n)).toEqual({ kind: "inline", ids: members.slice(0, 64) });
		expect(await lookup(f, current, 1n)).toMatchObject({ kind: "bitmap", count: 65n });
		expect(await lookup(f, current, 43n)).toBeNull();
		expect(await lookup(f, current, 454n)).toEqual({ kind: "inline", ids: [0n] });
	});

	test("repairs two branch levels when one inline leaf shrinks", async () => {
		const f = fixture();
		let current = await seed(
			f,
			empty(),
			0n,
			Array.from({ length: 64 }, (_, index) => BigInt(index)),
		);
		const originalSet = await lookup(f, current, 0n);
		for (let index = 1; index < 106; index++) {
			current = await f.write(async (db) => {
				const next = await files_list_set_directory_db_derive(db, {
					scope,
					handle: current,
					sourceOwnerId: 0n,
					ownerId: BigInt(index),
					memberId: 0n,
				});
				await hold(db, next);
				return next;
			});
			await cleanup(f);
		}
		const old = current;
		await f.write((db) => hold(db, old, "old", "capture"));
		const level = await f.read(async (db) => (await db.get("files_list_set_pages", current.root!))!.level);
		expect(level, "The fixture must reach a branch above branches").toBeGreaterThanOrEqual(2);
		await audit(f, current);
		// Six 64-member records weigh 3,132. Eight removals drop the first leaf below 3,072.
		for (let member = 0; member < 8; member++) {
			current = await change(f, current, 0n, BigInt(member), false);
			await cleanup(f);
			await audit(f, current);
		}
		expect(await f.read(async (db) => (await db.get("files_list_set_pages", current.root!))!.level)).toBe(1);
		for (const ownerId of [1n, 61n, 105n]) expect(await lookup(f, current, ownerId)).toEqual(originalSet);
		expect(await has(f, current, 0n, 0n)).toBe(false);
		expect(await has(f, old, 0n, 0n)).toBe(true);
		await audit(f, current);
		await f.write((db) => hold(db, empty(), "old", "capture"));
		await cleanup(f);
		expect(await has(f, current, 105n, 0n)).toBe(true);
		await f.write((db) => hold(db, empty()));
		await cleanup(f);
		expect(await f.read((db) => db.query("files_list_set_pages").first())).toBeNull();
	});
});

describe("files_list_set_directory_db_derive", () => {
	test("bounds full external-root pages and keeps a shared root after one owner changes", async () => {
		const f = fixture();
		let current = await seed(
			f,
			empty(),
			0n,
			Array.from({ length: 65 }, (_, index) => BigInt(index) << 13n),
		);
		for (let index = 1; index < 32; index++) {
			current = await f.write(async (db) => {
				const next = await files_list_set_directory_db_derive(db, {
					scope,
					handle: current,
					sourceOwnerId: 0n,
					ownerId: BigInt(index),
					memberId: 0n,
				});
				await hold(db, next);
				return next;
			});
			await cleanup(f);
			if (index === 30) {
				const full = await audit(f, current);
				expect(full.pages).toBe(2);
				expect(full.maxRefs).toBe(31);
			}
		}
		expect((await audit(f, current)).pages).toBe(4);
		current = await change(f, current, 0n, 0n, false);
		await cleanup(f);
		expect(await has(f, current, 0n, 0n)).toBe(false);
		expect(await has(f, current, 31n, 0n)).toBe(true);
		await f.write((db) => hold(db, empty()));
		await cleanup(f);
		expect(await f.read((db) => db.query("files_list_set_pages").first())).toBeNull();
	});

	test("deriving A plus one keeps A and unrelated sets while sharing unchanged bitmap pages", async () => {
		const f = fixture();
		let current = await seed(
			f,
			empty(),
			7n,
			Array.from({ length: 630 }, (_, index) => BigInt(index) << 13n),
		);
		current = await seed(
			f,
			current,
			8n,
			Array.from({ length: 65 }, (_, index) => BigInt(index) << 13n),
		);
		const old = current;
		await f.write((db) => hold(db, old, "old", "capture"));
		const child = await lookup(f, old, 7n);
		const unrelated = await lookup(f, old, 8n);
		current = await f.write(async (db) => {
			const next = await files_list_set_directory_db_derive(db, {
				scope,
				handle: current,
				sourceOwnerId: 7n,
				ownerId: 9n,
				memberId: (1n << 63n) - 1n,
			});
			await hold(db, next);
			return next;
		});
		await cleanup(f);
		const outer = await lookup(f, current, 9n);
		expect(await lookup(f, current, 7n)).toEqual(child);
		expect(await lookup(f, current, 8n)).toEqual(unrelated);
		expect(outer).toMatchObject({ kind: "bitmap", count: 631n });
		expect(await has(f, old, 7n, (1n << 63n) - 1n)).toBe(false);
		expect(await has(f, current, 9n, (1n << 63n) - 1n)).toBe(true);
		if (child?.kind !== "bitmap" || outer?.kind !== "bitmap") throw new Error("Expected bitmap roots");
		const shared = await f.read(async (db) => {
			const a = await db.get("files_list_set_pages", child.root);
			const b = await db.get("files_list_set_pages", outer.root);
			return a!.children.filter((id) => b!.children.includes(id)).length;
		});
		expect(shared).toBeGreaterThan(0);
		await audit(f, current);
	});
});

describe("files_list_set_directory_db_next_block", () => {
	test("walks every block of inline and bitmap sets in key order from any cursor", async () => {
		const f = fixture();
		const high = (1n << 63n) - 1n;
		// Owner 1 has 511 members in block 3, so that block is sparse. Owner 2 adds one more, so its block is dense.
		// Owner 3 has 900 single-member blocks with a gap after each one. They fill three bitmap leaves.
		const sets = new Map([
			[0n, [0n, high]],
			[1n, Array.from({ length: 511 }, (_, index) => (3n << 13n) + BigInt(index))],
			[2n, Array.from({ length: 512 }, (_, index) => (3n << 13n) + BigInt(index))],
			[3n, Array.from({ length: 900 }, (_, index) => BigInt(index * 2) << 13n)],
		]);
		let current = empty();
		for (const ownerId of [0n, 1n, 3n]) {
			const members = sets.get(ownerId)!;
			// Write 100 members per transaction to keep the fixture fast.
			for (let start = 0; start < members.length; start += 100) {
				current = await f.write(async (db) => {
					let next = current;
					for (const memberId of members.slice(start, start + 100)) {
						next = await files_list_set_directory_db_update(db, {
							scope,
							handle: next,
							ownerId,
							memberId,
							enabled: true,
						});
					}
					await hold(db, next);
					return next;
				});
			}
		}
		current = await f.write(async (db) => {
			const next = await files_list_set_directory_db_derive(db, {
				scope,
				handle: current,
				sourceOwnerId: 1n,
				ownerId: 2n,
				memberId: (3n << 13n) + 511n,
			});
			await hold(db, next);
			return next;
		});
		const tree = await lookup(f, current, 3n);
		if (tree?.kind !== "bitmap") throw new Error("Expected bitmap root");
		const treeRoot = await f.read((db) => db.get("files_list_set_pages", tree.root));
		expect(treeRoot!.level).toBe(1);
		expect(treeRoot!.children, "The fixture must have three bitmap leaves under one branch").toHaveLength(3);

		function blocks(members: bigint[]) {
			const offsets = new Map<bigint, number[]>();
			for (const id of members) offsets.set(id >> 13n, [...(offsets.get(id >> 13n) ?? []), Number(id & 8191n)]);
			return [...offsets].map(([key, list]) => ({ key, container: files_list_bitmap_from_offsets(list) }));
		}

		async function walk(handle: Handle, ownerId: bigint, after: bigint | null = null, limit = Infinity) {
			const value = await lookup(f, handle, ownerId);
			// Measure the tree heights. A bitmap set may read one cursor path and one leftmost path.
			const bound = await f.read(async (db) => {
				const directory = (await db.get("files_list_set_pages", handle.root!))!.level + 1;
				if (value?.kind !== "bitmap") return directory;
				return directory + 2 * ((await db.get("files_list_set_pages", value.root))!.level + 1) - 1;
			});
			const found = [];
			let cursor = after;
			while (found.length < limit) {
				const step = await f.measure((db) =>
					files_list_set_directory_db_next_block(db, { scope, handle, ownerId, after: cursor }),
				);
				expect(
					step.metrics.documentsRead.used,
					"Successor must read at most one cursor path and one leftmost path",
				).toBeLessThanOrEqual(bound);
				if (step.result === null) break;
				found.push(step.result);
				cursor = step.result.key;
			}
			return found;
		}

		for (const [ownerId, members] of sets) {
			expect(await walk(current, ownerId)).toEqual(blocks(members));
			// Cursors before the first block, on a block, in a gap, on the last block and at the largest key.
			for (const after of [0n, 1n, 2n, 3n, 474n, 475n, 1798n, (1n << 50n) - 2n, (1n << 50n) - 1n]) {
				expect(await walk(current, ownerId, after, 1)).toEqual(
					blocks(members)
						.filter((block) => block.key > after)
						.slice(0, 1),
				);
			}
		}

		const old = current;
		await f.write((db) => hold(db, old, "old", "capture"));
		current = await change(f, current, 3n, 0n, false);
		current = await change(f, current, 3n, high);
		current = await change(f, current, 0n, 1n);
		await cleanup(f);
		expect(await walk(old, 3n)).toEqual(blocks(sets.get(3n)!));
		expect(await walk(old, 0n)).toEqual(blocks(sets.get(0n)!));
		expect(await walk(current, 3n)).toEqual(blocks([...sets.get(3n)!.slice(1), high]));
		expect(await walk(current, 0n)).toEqual(blocks([0n, 1n, high]));
	});
});

describe("scope binding", () => {
	test("binds tenant, global scope, volume generation, family and ID kinds", async () => {
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
		const namespaces: Handle["namespace"][] = [
			workspace,
			{ ...workspace, organizationId: "2organizations" as Id<"organizations"> },
			{ ...workspace, workspaceId: "2organizations_workspaces" as Id<"organizations_workspaces"> },
			scope.namespace,
			{ kind: "global", workspaceId: "PLUGINS" },
			volume,
			{ ...volume, organizationId: "2organizations" as Id<"organizations"> },
			{ ...volume, generationId: "2plugins_volume_generations" as Id<"plugins_volume_generations"> },
			{ ...volume, installationId: "2plugins_workspace_installations" as Id<"plugins_workspace_installations"> },
			{ ...volume, volumeId: "2plugins_volumes" as Id<"plugins_volumes"> },
			{ ...volume, ownerWorkspaceId: "2organizations_workspaces" as Id<"organizations_workspaces"> },
		];
		const handles: Handle[] = [];
		for (const namespace of namespaces) handles.push(await change(f, empty({ ...scope, namespace }), 0n, 0n));
		for (const handle of handles) {
			await cleanup(f, handle);
			expect(await has(f, handle, 0n, 0n)).toBe(true);
		}
		const current = handles[0]!;
		for (const namespace of namespaces.slice(1)) {
			const graft = { ...current, namespace };
			await expect(lookup(f, graft, 0n), "A grafted root must reject the stored tenant namespace").rejects.toThrow(
				"namespace or family mismatch",
			);
			await expect(f.write((db) => hold(db, graft))).rejects.toThrow("namespace or family mismatch");
		}
		const otherFamily = await change(f, empty({ namespace: current.namespace, family: "audience_policies" }), 0n, 0n);
		await cleanup(f, otherFamily);
		expect(await has(f, otherFamily, 0n, 0n)).toBe(true);
		await expect(lookup(f, { ...otherFamily, root: current.root }, 0n)).rejects.toThrow("namespace or family mismatch");
		for (const bad of [
			{ ...current, ownerKind: "audience" as const },
			{ ...current, memberKind: "policy" as const },
		]) {
			await expect(lookup(f, bad, 0n)).rejects.toThrow("ID kind mismatch");
			await expect(has(f, bad, 0n, 0n)).rejects.toThrow("ID kind mismatch");
			await expect(change(f, bad, 0n, 1n)).rejects.toThrow("ID kind mismatch");
			await expect(f.write((db) => hold(db, bad))).rejects.toThrow("ID kind mismatch");
			await expect(
				f.write((db) =>
					files_list_set_directory_db_derive(db, {
						scope: bad,
						handle: bad,
						sourceOwnerId: 0n,
						ownerId: 1n,
						memberId: 1n,
					}),
				),
			).rejects.toThrow("ID kind mismatch");
		}
		for (const memberId of [-1n, 1n << 63n])
			await expect(change(f, current, 0n, memberId)).rejects.toThrow("nonnegative int64");
		for (const ownerId of [-1n, 1n << 63n])
			await expect(lookup(f, current, ownerId)).rejects.toThrow("nonnegative int64");
		const reordered: Handle = {
			...current,
			namespace: { workspaceId: workspace.workspaceId, organizationId: workspace.organizationId, kind: "workspace" },
		};
		expect(await has(f, reordered, 0n, 0n)).toBe(true);
		await audit(f, handles[5]!);
	});
});

describe("files_list_set_directory_db_hold", () => {
	test("keeps separate hold purposes and rejects reattaching a deleted root", async () => {
		const f = fixture();
		let current = await change(f, empty(), 0n, 0n);
		const old = current;
		await f.write(async (db) => {
			await hold(db, old, "current", "capture");
			await hold(db, old, "current", "writer");
		});
		current = await change(f, current, 0n, 0n, false);
		await cleanup(f);
		expect(await has(f, old, 0n, 0n)).toBe(true);
		await f.write((db) => hold(db, empty(), "current", "capture"));
		await cleanup(f);
		expect(await has(f, old, 0n, 0n)).toBe(true);
		await f.write((db) => hold(db, empty(), "current", "writer"));
		await cleanup(f);
		await expect(f.write((db) => hold(db, old))).rejects.toThrow("Cannot retain a missing");
		expect(current.root).toBeNull();
		expect(await f.read((db) => db.query("files_list_set_edges").first())).toBeNull();
	});
});

describe("files_list_set_directory_db_cleanup_step", () => {
	test("checks the incoming edge and page bindings before deleting a page", async () => {
		const f = fixture();
		const current = await change(f, empty(), 0n, 0n);
		await cleanup(f);
		const other: Scope = { ...scope, namespace: { kind: "global", workspaceId: "PLUGINS" } };
		const edgeId = await f.write(async (db) => {
			await hold(db, empty());
			return db.insert("files_list_set_edges", {
				...other,
				target: current.root!,
				owner: { kind: "hold", purpose: "writer", id: "wrong" },
			});
		});
		await expect(f.write((db) => files_list_set_directory_db_cleanup_step(db, scope))).rejects.toThrow(
			"namespace or family mismatch",
		);
		await f.write((db) => db.delete("files_list_set_edges", edgeId));

		// No edge points to the page now. A cleanup task from another namespace must still not delete it.
		await f.write((db) => db.insert("files_list_set_cleanup_tasks", { ...other, target: current.root! }));
		await expect(
			f.write((db) => files_list_set_directory_db_cleanup_step(db, other)),
			"A cleanup task must not delete a page from another namespace",
		).rejects.toThrow("namespace or family mismatch");
		expect(await has(f, current, 0n, 0n)).toBe(true);
		await cleanup(f);
		expect(await f.read((db) => db.get("files_list_set_pages", current.root!))).toBeNull();
	});
});
