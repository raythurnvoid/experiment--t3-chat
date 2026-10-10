import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { componentsGeneric, defineSchema, defineTable, makeFunctionReference, mutationGeneric, queryGeneric, type DataModelFromSchemaDefinition, type DocumentByName } from "convex/server";
import { compareValues, v, type GenericId } from "convex/values";

const schema = defineSchema({
	entries: defineTable({
		bucket: v.string(),
		key: v.optional(v.union(v.null(), v.number(), v.string(), v.int64(), v.object({ value: v.string() }))),
		payload: v.string(),
		stamp: v.optional(v.commitTs()),
	})
		.index("by_bucket_key", ["bucket", "key"])
		.index("by_key", ["key"])
		.index("by_stamp", ["stamp"]),
});

const read = queryGeneric({
	args: { bucket: v.string() },
	handler: async (ctx, args) => await ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", args.bucket)).collect(),
});
const change = mutationGeneric({
	args: { id: v.id("entries"), key: v.number(), fail: v.boolean() },
	handler: async (ctx, args) => {
		await ctx.db.patch(args.id, { key: args.key });
		if (args.fail) throw new Error("Roll back the child");
		return null;
	},
});
const insert = mutationGeneric({
	args: { bucket: v.string(), key: v.number(), payload: v.string() },
	handler: async (ctx, args) => await ctx.db.insert("entries", args),
});
const modules = {
	"./_generated/server.ts": async () => ({}),
	"./index_test.ts": async () => ({ read, change, insert }),
};
const readRef = makeFunctionReference<"query", { bucket: string }, DocumentByName<DataModelFromSchemaDefinition<typeof schema>, "entries">[]>("index_test:read");
const changeRef = makeFunctionReference<"mutation", { id: GenericId<"entries">; key: number; fail: boolean }>("index_test:change");

afterEach(() => vi.restoreAllMocks());

test("Warm native index ranges do not visit same-table noise docs", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const noiseCount = 2_000;
	await t.run(async ctx => {
		for (let key = 0; key < noiseCount; key++)
			await ctx.db.insert("entries", { bucket: "noise", key, payload: "noise" });
		await ctx.db.insert("entries", { bucket: "wanted", key: 1, payload: "wanted" });
	});
	await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "wanted")).first());
	// Native metrics count returned docs. Count field reads on noise docs too.
	const getPrototypeOf = Object.getPrototypeOf;
	let noiseVisits = 0;
	vi.spyOn(Object, "getPrototypeOf").mockImplementation((value: unknown) => {
		if (value !== null && typeof value === "object" && "bucket" in value && value.bucket === "noise") noiseVisits++;
		return getPrototypeOf(value);
	});
	const exact = await t.query(async ctx => ({
		doc: await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "wanted").eq("key", 1)).first(),
		metrics: await ctx.meta.getTransactionMetrics(),
	}));
	expect(exact.doc).toMatchObject({ bucket: "wanted", key: 1 });
	expect(exact.metrics.documentsRead.used).toBe(1);
	expect(noiseVisits, "An exact index read must not visit every noise doc").toBeLessThan(noiseCount / 10);
	noiseVisits = 0;
	expect(await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "absent")).first())).toBeNull();
	expect(noiseVisits, "An empty index range must not visit every noise doc").toBeLessThan(noiseCount / 10);
	noiseVisits = 0;
	expect(await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "noise")).first()))
		.toMatchObject({ key: 0 });
	expect(noiseVisits, "A wide index first must not sort every noise doc again").toBeLessThan(noiseCount / 10);
	noiseVisits = 0;
	expect(await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "noise"))
		.filter(q => q.eq(q.field("payload"), "noise")).first())).toMatchObject({ key: 0 });
	expect(noiseVisits, "An index first must stop after its first matching doc").toBeLessThan(noiseCount / 10);
	const middle = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "noise"))
		.paginate({ cursor: null, numItems: 1_000 }));
	noiseVisits = 0;
	const next = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "noise"))
		.filter(q => q.eq(q.field("payload"), "noise")).paginate({ cursor: middle.continueCursor, numItems: 3 }));
	expect(next.page.map(doc => doc.key)).toEqual([1_000, 1_001, 1_002]);
	expect(noiseVisits, "A later index page must seek past earlier docs").toBeLessThan(noiseCount / 10);
});

test("Native indexes keep insert, patch, replace and delete through rollback and commit", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const ids = await t.run(async ctx => ({
		one: await ctx.db.insert("entries", { bucket: "a", key: 1, payload: "one" }),
		two: await ctx.db.insert("entries", { bucket: "a", key: 2, payload: "two" }),
		seven: await ctx.db.insert("entries", { bucket: "b", key: 7, payload: "seven" }),
	}));
	await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).collect());
	await t.query(ctx => ctx.db.query("entries").withIndex("by_key").collect());
	for (const abort of [true, false]) {
		const write = t.run(async ctx => {
			await ctx.db.insert("entries", { bucket: "a", key: 3, payload: "three" });
			await ctx.db.patch("entries", ids.one, { bucket: "b", key: 5 });
			await ctx.db.replace("entries", ids.two, { bucket: "a", key: 4, payload: "four" });
			await ctx.db.delete("entries", ids.seven);
			expect((await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).collect()).map(doc => doc.key)).toEqual([3, 4]);
			expect((await ctx.db.query("entries").withIndex("by_key").collect()).map(doc => doc.key)).toEqual([3, 4, 5]);
			if (abort) throw new Error("Roll back the outer write");
		});
		if (abort) await expect(write).rejects.toThrow("Roll back the outer write");
		else await write;
		const saved = await t.query(ctx => ctx.db.query("entries").withIndex("by_key").collect());
		expect(saved.map(doc => doc.key)).toEqual(abort ? [1, 2, 7] : [3, 4, 5]);
	}
	await t.run(ctx => ctx.db.patch("entries", ids.two, { payload: "new body" }));
	expect(await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a").eq("key", 4)).unique()))
		.toMatchObject({ payload: "new body" });
});

test("Native indexes keep nested writes and committed snapshot queries separate", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const id = await t.run(ctx => ctx.db.insert("entries", { bucket: "a", key: 1, payload: "one" }));
	await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).collect());
	await t.run(async ctx => {
		await expect(ctx.runMutation(changeRef, { id, key: 3, fail: true })).rejects.toThrow("Roll back the child");
		expect((await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).first())?.key).toBe(1);
		await ctx.runMutation(changeRef, { id, key: 4, fail: false });
		expect((await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).first())?.key).toBe(4);
	});
	await expect(t.run(async ctx => {
		await ctx.runMutation(changeRef, { id, key: 5, fail: false });
		throw new Error("Roll back the parent");
	})).rejects.toThrow("Roll back the parent");
	await t.run(async ctx => {
		await ctx.db.patch("entries", id, { key: 8 });
		const snapshot = await ctx.runQuery(readRef, { bucket: "a" }, { useStaleSnapshot: true });
		const pending = await ctx.runQuery(readRef, { bucket: "a" });
		expect(snapshot.map(doc => doc.key)).toEqual([4]);
		expect(pending.map(doc => doc.key)).toEqual([8]);
	});
	expect((await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a")).first()))?.key).toBe(8);
});

test("Native index iterators keep the pending view they opened with", async () => {
	const t = convexTest({ schema, modules });
	await t.run(async ctx => {
		for (const key of [1, 2, 3]) await ctx.db.insert("entries", { bucket: "a", key, payload: "old" });
	});
	await t.run(async ctx => {
		await ctx.db.insert("entries", { bucket: "a", key: 4, payload: "pending" });
		const iterator = ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a"))[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.value?.key).toBe(1);
		await ctx.db.insert("entries", { bucket: "a", key: 0, payload: "later" });
		const last = await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "a").eq("key", 3)).unique();
		await ctx.db.patch("entries", last!._id, { key: 9 });
		const rest = [];
		while (true) {
			const next = await iterator.next();
			if (next.done) break;
			rest.push(next.value.key);
		}
		expect(rest).toEqual([2, 3, 4]);
	});
});

test("Native index keys use Convex ordering and resolved commit timestamps", async () => {
	const t = convexTest({ schema, modules });
	const keys = [undefined, null, -3, 3n, "a", "é", "😀", { value: "a" }, { value: "b" }];
	await t.run(async ctx => {
		for (const key of keys) await ctx.db.insert("entries", { bucket: "values", key, payload: "key" });
	});
	const docs = await t.query(ctx => ctx.db.query("entries").withIndex("by_key").collect());
	// Array.sort moves bare undefined to the end before it calls the comparer.
	const sortedKeys = keys.map(key => ({ key })).sort((left, right) => compareValues(left.key, right.key)).map(entry => entry.key);
	expect(docs.map(doc => doc.key)).toEqual(sortedKeys);
	expect((await t.query(ctx => ctx.db.query("entries").withIndex("by_key").order("desc").collect())).map(doc => doc.key))
		.toEqual([...sortedKeys].reverse());
	await t.query(ctx => ctx.db.query("entries").withIndex("by_stamp").first());
	const stamped = await t.run(async ctx => {
		const id = await ctx.db.insert("entries", { bucket: "stamp", key: 1, payload: "stamp", stamp: ctx.db.vars.commitTs });
		expect((await ctx.db.query("entries").withIndex("by_stamp", q => q.eq("stamp", ctx.db.vars.commitTs)).unique())?._id).toBe(id);
		return (await ctx.db.get("entries", id))!;
	});
	expect(typeof stamped.stamp).toBe("bigint");
	expect((await t.query(ctx => ctx.db.query("entries").withIndex("by_stamp", q => q.eq("stamp", stamped.stamp)).unique()))?._id)
		.toBe(stamped._id);
});

async function page_fixture() {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const ids = await t.run(async ctx => {
		const ids = [];
		for (let index = 0; index < 12; index++) ids.push(await ctx.db.insert("entries", {
			bucket: "page", key: Math.floor(index / 2), payload: index % 2 === 0 ? "even" : "odd",
		}));
		return ids;
	});
	return { t, ids };
}

test("Native index seeks keep equality prefixes and inclusive or strict range bounds", async () => {
	const { t, ids } = await page_fixture();
	await t.run(async ctx => {
		await ctx.db.insert("entries", { bucket: "before", key: 3, payload: "outside" });
		await ctx.db.insert("entries", { bucket: "later", key: 3, payload: "outside" });
	});
	const strictLower = await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", "page").gt("key", 1).lte("key", 4)).collect());
	expect(strictLower.map(doc => doc._id)).toEqual(ids.slice(4, 10));
	const strictUpper = await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", "page").gte("key", 2).lt("key", 4)).order("desc").collect());
	expect(strictUpper.map(doc => doc._id)).toEqual(ids.slice(4, 8).reverse());
	const lowerOnly = await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", "page").gt("key", 4)).collect());
	expect(lowerOnly.map(doc => doc._id)).toEqual(ids.slice(10));
	const upperOnly = await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", "page").lte("key", 1)).collect());
	expect(upperOnly.map(doc => doc._id)).toEqual(ids.slice(0, 4));
	expect(await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_bucket_key", q => q.eq("bucket", "page").gte("key", 4).lt("key", 2)).collect())).toEqual([]);
	expect((await t.query(ctx => ctx.db.query("entries").withIndex("by_id", q => q.eq("_id", ids[6]!)).unique()))?._id)
		.toBe(ids[6]);
	const first = (await t.query(ctx => ctx.db.get("entries", ids[5]!)))!;
	const last = (await t.query(ctx => ctx.db.get("entries", ids[7]!)))!;
	const creationRange = await t.query(ctx => ctx.db.query("entries")
		.withIndex("by_creation_time", q => q.gte("_creationTime", first._creationTime).lte("_creationTime", last._creationTime)).collect());
	expect(creationRange.map(doc => doc._id)).toEqual(ids.slice(5, 8));
});

test("Native pagination seeks old cursor keys after cursor docs change or disappear", async () => {
	const { t, ids } = await page_fixture();
	const first = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: null, numItems: 3 }));
	expect(first.page.map(doc => doc._id)).toEqual(ids.slice(0, 3));
	await t.run(async ctx => {
		await ctx.db.delete("entries", ids[2]!);
		await ctx.db.patch("entries", ids[0]!, { key: 100 });
	});
	const second = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: first.continueCursor, numItems: 3 }));
	expect(second.page.map(doc => doc._id)).toEqual(ids.slice(3, 6));
	const descending = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page")).order("desc")
		.paginate({ cursor: null, numItems: 3 }));
	expect(descending.page.map(doc => doc._id)).toEqual([ids[0], ids[11], ids[10]]);
	await t.run(ctx => ctx.db.patch("entries", ids[10]!, { key: -1 }));
	const below = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page")).order("desc")
		.paginate({ cursor: descending.continueCursor, numItems: 3 }));
	expect(below.page.map(doc => doc._id)).toEqual([ids[9], ids[8], ids[7]]);
});

test("Native pagination preserves end boundaries, filtered splits and read metrics", async () => {
	const { t, ids } = await page_fixture();
	const boundary = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: null, numItems: 4 }));
	const bounded = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: null, numItems: 1, endCursor: boundary.continueCursor }));
	expect(bounded.page.map(doc => doc._id)).toEqual(ids.slice(0, 4));
	expect(bounded.isDone).toBe(false);
	const reverse = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page")).order("desc")
		.paginate({ cursor: null, numItems: 1, endCursor: boundary.continueCursor }));
	expect(reverse.page.map(doc => doc._id)).toEqual(ids.slice(3).reverse());
	const ending = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: null, numItems: 1, endCursor: "_end_cursor" }));
	expect(ending.page.map(doc => doc._id)).toEqual(ids);
	expect(ending.isDone).toBe(true);
	expect(await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: "_end_cursor", numItems: 3 }))).toMatchObject({ page: [], isDone: true });
	const rowLimited = await t.query(async ctx => ({
		page: await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
			.filter(q => q.eq(q.field("payload"), "even")).paginate({ cursor: null, numItems: 8, maximumRowsRead: 4 }),
		metrics: await ctx.meta.getTransactionMetrics(),
	}));
	expect(rowLimited.page.page.map(doc => doc._id)).toEqual([ids[0], ids[2]]);
	expect(rowLimited.page).toMatchObject({ pageStatus: "SplitRequired", continueCursor: boundary.continueCursor });
	expect(rowLimited.page.splitCursor).not.toBeNull();
	expect(rowLimited.metrics.documentsRead.used).toBe(2);
	const byteLimited = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: null, numItems: 8, maximumBytesRead: 1 }));
	expect(byteLimited.page.map(doc => doc._id)).toEqual([ids[0]]);
	expect(byteLimited).toMatchObject({ pageStatus: "SplitRequired", splitCursor: null });
	const gaps = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.filter(q => q.gte(q.field("key"), 4)).paginate({ cursor: null, numItems: 2 }));
	expect(gaps.page.map(doc => doc._id)).toEqual(ids.slice(8, 10));
	expect(gaps).toMatchObject({ pageStatus: "SplitRecommended", isDone: false });
	const last = await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "page"))
		.paginate({ cursor: gaps.continueCursor, numItems: 2 }));
	expect(last.page.map(doc => doc._id)).toEqual(ids.slice(10));
	expect(last.isDone).toBe(true);
	await expect(t.query(async ctx => {
		await ctx.db.query("entries").withIndex("by_bucket_key").paginate({ cursor: null, numItems: 1 });
		return await ctx.db.query("entries").withIndex("by_bucket_key").paginate({ cursor: null, numItems: 1 });
	})).rejects.toThrow("Only a single paginated query");
});

test("Native indexes stay separate for components with the same schema", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	t.registerComponent("child", schema, modules);
	const components = componentsGeneric();
	await t.run(ctx => ctx.db.insert("entries", { bucket: "same", key: 1, payload: "root" }));
	await t.query(ctx => ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "same")).first());
	await t.mutation(components.child.index_test.insert, { bucket: "same", key: 99, payload: "child" });
	expect(await t.query(components.child.index_test.read, { bucket: "same" })).toMatchObject([{ key: 99, payload: "child" }]);
	await t.run(async ctx => {
		await ctx.runMutation(components.child.index_test.insert, { bucket: "same", key: 100, payload: "child two" });
		expect((await ctx.db.query("entries").withIndex("by_bucket_key", q => q.eq("bucket", "same")).collect()).map(doc => doc.key)).toEqual([1]);
	});
	expect(await t.query(components.child.index_test.read, { bucket: "same" })).toMatchObject([{ key: 99 }, { key: 100 }]);
});

test("Native unions keep validation without errors for valid primitive choices", async () => {
	const unionSchema = defineSchema({
		targets: defineTable({ name: v.string() }),
		records: defineTable({
			choice: v.union(v.literal("first"), v.literal("middle"), v.literal("last")),
			value: v.union(v.string(), v.number(), v.boolean(), v.int64(), v.null(), v.bytes()),
			ref: v.union(v.null(), v.id("targets")),
			stamp: v.union(v.null(), v.commitTs()),
			shape: v.optional(v.union(
				v.object({ kind: v.literal("first"), name: v.string() }),
				v.object({ kind: v.literal("last"), count: v.number() }),
				v.array(v.number()),
			)),
		}),
	});
	const t = convexTest({ schema: unionSchema, modules });
	const targetId = await t.run(ctx => ctx.db.insert("targets", { name: "target" }));
	const base = { choice: "last" as const, value: null, ref: targetId, stamp: null };
	const nativeError = globalThis.Error;
	let errorCount = 0;
	vi.stubGlobal("Error", class extends nativeError {
		constructor(message?: string, options?: ErrorOptions) {
			super(message, options);
			errorCount++;
		}
	});
	try {
		await t.run(async ctx => {
			for (const value of [null, "text", 7, true, 7n, new Uint8Array([1, 2]).buffer])
				await ctx.db.insert("records", { ...base, value });
			const id = await ctx.db.insert("records", { ...base, stamp: ctx.db.vars.commitTs });
			await ctx.db.patch("records", id, { choice: "middle", ref: null });
		});
		expect(errorCount, "Native valid unions must not allocate errors for rejected primitive branches").toBe(0);
	} finally {
		vi.unstubAllGlobals();
	}
	const id = await t.run(ctx => ctx.db.insert("records", base));
	for (const shape of [{ kind: "first" as const, name: "ok" }, { kind: "last" as const, count: 2 }, [1, 2]])
		await t.run(ctx => ctx.db.patch("records", id, { shape }));
	const records = await t.query(ctx => ctx.db.query("records").collect());
	expect(records.some(record => typeof record.stamp === "bigint")).toBe(true);
	await expect(t.run(ctx => {
		// @ts-expect-error Test the native runtime guard for an invalid literal.
		return ctx.db.patch("records", id, { choice: "missing" });
	})).rejects.toMatchObject({
		message: 'Validator error: Expected one of literal, literal, literal, got `"missing"`',
	});
	await expect(t.run(ctx => {
		// @ts-expect-error Test the native runtime guard for a wrong table id.
		return ctx.db.patch("records", id, { ref: id });
	})).rejects.toMatchObject({ message: `Validator error: Expected one of null, id, got \`"${id}"\`` });
	await expect(t.run(ctx => {
		// @ts-expect-error Test the native runtime guard for invalid nested fields.
		return ctx.db.patch("records", id, { shape: { kind: "last", count: "bad" } });
	})).rejects.toMatchObject({
		message: 'Validator error: Expected one of object, object, array, got `{"count":"bad","kind":"last"}`',
	});
});
