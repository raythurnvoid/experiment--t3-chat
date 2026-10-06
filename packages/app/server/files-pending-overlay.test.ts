import { compareValues, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_pending_overlay_window_ranges } from "./files-pending-overlay.ts";

type Row = Record<string, Value>;
type Range = ReturnType<typeof files_pending_overlay_window_ranges>[number];

function in_range(row: Row, range: Range) {
	for (const [field, value] of range.eq) if (compareValues(row[field]!, value) !== 0) return false;
	if (range.lower) {
		const compared = compareValues(row[range.lower.field]!, range.lower.value);
		if (compared < 0 || (compared === 0 && !range.lower.inclusive)) return false;
	}
	if (range.upper) {
		const compared = compareValues(row[range.upper.field]!, range.upper.value);
		if (compared > 0 || (compared === 0 && !range.upper.inclusive)) return false;
	}
	return true;
}

/**
 * Check every window of `rows` (each pair of first and last rows, in both orders) against the rows
 * whose key is between them. Each row must be in exactly one range.
 */
function expect_exact_windows(fields: string[], rows: Row[]) {
	const key = (row: Row) => fields.map((field) => row[field]!);
	const sorted = [...rows].sort((a, b) => compareValues(key(a), key(b)));
	for (let first = 0; first < sorted.length; first++)
		for (let last = first; last < sorted.length; last++) {
			const low = key(sorted[first]!);
			const high = key(sorted[last]!);
			const expected = sorted.filter((row) => compareValues(key(row), low) >= 0 && compareValues(key(row), high) <= 0);
			for (const order of ["asc", "desc"] as const) {
				const ranges = files_pending_overlay_window_ranges({
					fields,
					first: order === "asc" ? low : high,
					last: order === "asc" ? high : low,
					order,
				});
				expect(ranges.length).toBeLessThanOrEqual(2 * fields.length - 1);
				const matched = sorted.filter((row) => ranges.some((range) => in_range(row, range)));
				expect(matched).toEqual(expected);
				for (const row of matched) expect(ranges.filter((range) => in_range(row, range))).toHaveLength(1);
			}
		}
}

describe("files_pending_overlay_window_ranges", () => {
	// The key fields after the owner and parent prefix of each agent hide index.
	test("by_org_ws_user_parent_name: one name field", () => {
		expect_exact_windows(
			["name"],
			["a.md", "b.md", "b.md", "c", "z"].map((name) => ({ name })),
		);
	});

	test("by_org_ws_user_parent_updatedAt: many rows with the same updatedAt, as in `ls -t`", () => {
		const rows = [];
		for (const updatedAt of [100, 200, 200, 200, 300])
			for (const nodeCreationTime of [1, 2, 3]) rows.push({ updatedAt, nodeCreationTime });
		expect_exact_windows(["updatedAt", "nodeCreationTime"], rows);
	});

	test("by_org_ws_user_treePath, by_org_ws_user_kind_treePath: tree paths", () => {
		const treePaths = ["/a/", "/a/b.md", "/a/c/", "/a/c/d.md", "/b.md"];
		expect_exact_windows(
			["treePath"],
			treePaths.map((treePath) => ({ treePath })),
		);
		expect_exact_windows(
			["kind", "treePath"],
			treePaths.map((treePath) => ({ kind: treePath.endsWith("/") ? "folder" : "file", treePath })),
		);
	});

	test("by_org_ws_user_kind_ext_treePath: many `.md` files, as in `find --extension md`", () => {
		const rows = [];
		for (const lowercaseExtension of [null, "md", "md", "txt"])
			for (const treePath of ["/a", "/b", "/c"]) rows.push({ kind: "file", lowercaseExtension, treePath });
		expect_exact_windows(["kind", "lowercaseExtension", "treePath"], rows);
	});

	test("reads exactly the window on the real `ls -t` hide index", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const owner = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };

		const ids = await t.run(async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
			});
			const inserted = [];
			for (const updatedAt of [100, 200, 200, 200, 300])
				for (const nodeCreationTime of [1, 2])
					inserted.push(
						await ctx.db.insert("files_pending_hides", {
							...owner,
							savedNodeId: nodeId,
							parentId: "root",
							kind: "file",
							name: `n${updatedAt}-${nodeCreationTime}`,
							updatedAt,
							lowercaseExtension: null,
							nodeCreationTime,
							treePath: `/n${updatedAt}-${nodeCreationTime}`,
						}),
					);
			return inserted;
		});

		// A `desc` page from (300, 1) down to (200, 2), like `ls -t`.
		const ranges = files_pending_overlay_window_ranges({
			fields: ["updatedAt", "nodeCreationTime"],
			first: [300, 1],
			last: [200, 2],
			order: "desc",
		});
		const read = await t.run(async (ctx) => {
			const found = [];
			for (const range of ranges)
				found.push(
					...(await ctx.db
						.query("files_pending_hides")
						.withIndex("by_org_ws_user_parent_updatedAt", (q) => {
							let indexRange: any = q
								.eq("organizationId", owner.organizationId)
								.eq("workspaceId", owner.workspaceId)
								.eq("userId", owner.userId)
								.eq("parentId", "root");
							for (const [field, value] of range.eq) indexRange = indexRange.eq(field, value);
							if (range.lower)
								indexRange = range.lower.inclusive
									? indexRange.gte(range.lower.field, range.lower.value)
									: indexRange.gt(range.lower.field, range.lower.value);
							if (range.upper)
								indexRange = range.upper.inclusive
									? indexRange.lte(range.upper.field, range.upper.value)
									: indexRange.lt(range.upper.field, range.upper.value);
							return indexRange;
						})
						.collect()),
				);
			return found.map((hide) => [hide.updatedAt, hide.nodeCreationTime]).sort((a, b) => compareValues(a, b));
		});
		expect(ids).toHaveLength(10);
		expect(read).toEqual([
			[200, 2],
			[200, 2],
			[200, 2],
			[300, 1],
		]);
	});
});
