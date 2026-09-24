import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_api, app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_sort_Key, files_sort_Sort } from "../../shared/files-sort.ts";
import { useFilesSortedChildren, useFilesVisibleEntries } from "./files-search-hooks.ts";

type VisibleResult = FunctionReturnType<typeof app_convex_api.files_visible.list>;
type SortedPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;
type SortedRow = SortedPage["page"][number];
type SideRows = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>;
type SideRow = NonNullable<SideRows>["rows"][number];

// `sorted` holds every row of each sorted segment, keyed by `kind:segment:field:direction`. A metadata
// key's missing segment is keyed by its pages instead, because its cursor can end a page early.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one segment loading.
const { cursorsSeen, sorted } = vi.hoisted(() => ({
	cursorsSeen: [] as string[],
	sorted: {
		rows: new Map<string, SortedRow[]>(),
		missingPages: new Map<string, SortedRow[][]>(),
		sideRows: undefined as SideRows | undefined,
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
	},
}));

// 120 entries give two full pages of 50 and a last page of 20.
const ENTRIES = Array.from({ length: 120 }, (_, index) => ({
	target: { kind: "saved" as const, id: `node_${index}` as app_convex_Id<"files_nodes"> },
	name: `file-${index}.md`,
	path: `/folder/file-${index}.md`,
	kind: "file" as const,
	updatedAt: 1,
	updatedBy: "user_1" as app_convex_Id<"users">,
	contentType: "text/markdown",
	preparing: false,
}));

type SortedArgs = {
	kind: "file" | "folder";
	segment: "value" | "missing";
	sort: files_sort_Sort;
	paginationOpts?: { numItems: number; cursor: string | null };
};

const sorted_key = (args: SortedArgs) => `${args.kind}:${args.segment}:${args.sort.field}:${args.sort.direction}`;

// Answer each page at once. A cursor is the index of the page's first entry, or of the page itself for
// a metadata key's missing segment.
vi.mock("convex/react", async (importOriginal) => {
	const { useState } = await import("react");
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useQueries: (queries: Record<string, { query: FunctionReference<"query">; args: Record<string, unknown> }>) =>
			Object.fromEntries(
				Object.entries(queries).map(([key, request]) => {
					if (getFunctionName(request.query) === "files_nodes:list_tree_children_sorted") {
						const args = request.args as SortedArgs;
						const cursor = args.paginationOpts!.cursor;
						cursorsSeen.push(`${args.kind}:${cursor}`);
						const pages = sorted.missingPages.get(sorted_key(args)) ?? [[]];
						const index = Number(cursor ?? "0");
						const result: SortedPage = {
							page: pages[index]!,
							isDone: index + 1 >= pages.length,
							continueCursor: String(index + 1),
						};
						return [key, result];
					}

					const cursor = String(request.args.cursor ?? "0");
					if (!cursorsSeen.includes(cursor)) cursorsSeen.push(cursor);
					const start = Number(cursor);
					const end = start + Number(request.args.numItems);
					const result: VisibleResult = {
						_yay: {
							items: ENTRIES.slice(start, end),
							continueCursor: end < ENTRIES.length ? String(end) : null,
							isDone: end >= ENTRIES.length,
						},
					};
					return [key, result];
				}),
			),
		usePaginatedQuery: (
			_query: FunctionReference<"query">,
			args: SortedArgs | "skip",
			options: { initialNumItems: number },
		) => {
			const key = args === "skip" ? "skip" : sorted_key(args);
			const [loaded, setLoaded] = useState({ key, numItems: options.initialNumItems });
			const numItems = loaded.key === key ? loaded.numItems : options.initialNumItems;
			if (args === "skip" || sorted.loadingFields.has(args.sort.field) || sorted.loadingKeys.has(key)) {
				return { results: [], status: "LoadingFirstPage", loadMore: () => {} };
			}

			const rows = sorted.rows.get(key) ?? [];
			return {
				results: rows.slice(0, numItems),
				status: numItems >= rows.length ? "Exhausted" : "CanLoadMore",
				loadMore: (more: number) => setLoaded({ key, numItems: numItems + more }),
			};
		},
		useQuery: (_query: FunctionReference<"query">, args: { sort: files_sort_Sort } | "skip") =>
			args === "skip" || sorted.loadingFields.has(args.sort.field) ? undefined : sorted.sideRows,
	};
});

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const FOLDER_ID = "folder_1" as app_convex_Id<"files_nodes">;
const NAME_ASC: files_sort_Sort = { field: "name", direction: "asc" };

const saved_row = (kind: "file" | "folder", name: string, sortKey: files_sort_Key = [name]) =>
	({
		_id: `node_${name}` as app_convex_Id<"files_nodes">,
		name,
		kind,
		updatedAt: 1,
		updatedBy: "user_1" as app_convex_Id<"users">,
		contentType: kind === "file" ? "text/markdown" : null,
		sortKey,
		sortFieldValue: null,
	}) as SortedRow;

const side_row = (name: string, sortKey: files_sort_Key = [name]): SideRow => ({
	target: { kind: "private", id: `draft_${name}` as app_convex_Id<"files_pending_nodes"> },
	name,
	kind: "file",
	updatedAt: 1,
	updatedBy: "user_1" as app_convex_Id<"users">,
	contentType: "text/markdown",
	preparing: false,
	treeRow: null,
	segment: "value",
	sortKey,
	sortFieldValue: null,
});

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}.md`);

beforeEach(() => {
	cursorsSeen.length = 0;
	sorted.rows.clear();
	sorted.missingPages.clear();
	sorted.sideRows = { rows: [], nameClaims: [], tooManyShared: false, tooManyPending: false };
	sorted.loadingFields.clear();
	sorted.loadingKeys.clear();
});

afterEach(() => {
	cleanup();
});

describe("useFilesVisibleEntries", () => {
	test("returns entries only after every page is loaded", async () => {
		const { result } = renderHook(() => useFilesVisibleEntries(MEMBERSHIP_ID, "/folder", "children"));

		expect(result.current.entries).toBeUndefined();
		await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));
		expect(cursorsSeen).toEqual(["0", "50", "100"]);
	});
});

describe("useFilesSortedChildren", () => {
	const render_sorted = (sort: files_sort_Sort | null) =>
		renderHook(
			(props: { sort: files_sort_Sort | null }) =>
				useFilesSortedChildren({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort: props.sort }),
			{ initialProps: { sort } },
		);

	test("puts folders first, holds a side row until the loaded rows reach it, and hides claimed names", () => {
		sorted.rows.set("folder:value:name:asc", [saved_row("folder", "docs")]);
		sorted.rows.set(
			"file:value:name:asc",
			file_names(60).map((name) => saved_row("file", name)),
		);
		sorted.sideRows = {
			rows: [side_row("file-05b.md"), side_row("zz.md")],
			nameClaims: ["file-01.md"],
			tooManyShared: false,
			tooManyPending: false,
		};
		const { result } = render_sorted(NAME_ASC);

		const firstPage = file_names(50).filter((name) => name !== "file-01.md");
		firstPage.splice(firstPage.indexOf("file-05.md") + 1, 0, "file-05b.md");
		expect(result.current.rows?.map((row) => row.name)).toEqual(["docs", ...firstPage]);
		expect(result.current).toMatchObject({ isBusy: false, isDone: false, isFailed: false });

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([
			"docs",
			...firstPage,
			...file_names(60).slice(50),
			"zz.md",
		]);
		expect(result.current.isDone).toBe(true);
	});

	test("shows no files while more folders can load", () => {
		sorted.rows.set(
			"folder:value:name:asc",
			file_names(60, "folder").map((name) => saved_row("folder", name)),
		);
		sorted.rows.set("file:value:name:asc", [saved_row("file", "a.md")]);
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(50, "folder"));

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(60, "folder"), "a.md"]);
	});

	test("keeps folders A to Z when sorting by size, because folders have no size", () => {
		sorted.rows.set("folder:value:size:desc", [saved_row("folder", "a"), saved_row("folder", "c")]);
		sorted.rows.set("file:value:size:desc", [saved_row("file", "big.md", [9, "big.md"])]);
		sorted.sideRows = {
			rows: [{ ...side_row("b"), kind: "folder" }],
			nameClaims: [],
			tooManyShared: false,
			tooManyPending: false,
		};
		const { result } = render_sorted({ field: "size", direction: "desc" });

		expect(result.current.rows?.map((row) => row.name)).toEqual(["a", "b", "c", "big.md"]);
	});

	test("keeps the last rows while a new sort loads", () => {
		sorted.rows.set("file:value:name:asc", [saved_row("file", "a.md"), saved_row("file", "b.md")]);
		sorted.rows.set("file:value:updated:desc", [saved_row("file", "b.md", [2]), saved_row("file", "a.md", [1])]);
		const { result, rerender } = render_sorted(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);

		// A row changes without joining or leaving. The held rows must be the new ones.
		sorted.rows.set("file:value:name:asc", [{ ...saved_row("file", "a.md"), updatedAt: 5 }, saved_row("file", "b.md")]);
		rerender({ sort: NAME_ASC });

		sorted.loadingFields.add("updated");
		rerender({ sort: { field: "updated", direction: "desc" } });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		expect(result.current.rows?.[0]?.updatedAt).toBe(5);
		expect(result.current.isBusy).toBe(true);
		// The held rows' sort keys belong to the old sort, so the table must label them with it.
		expect(result.current.rowsSort).toEqual(NAME_ASC);

		sorted.loadingFields.clear();
		rerender({ sort: { field: "updated", direction: "desc" } });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["b.md", "a.md"]);
		expect(result.current.isBusy).toBe(false);
		expect(result.current.rowsSort).toEqual({ field: "updated", direction: "desc" });
	});

	test("Show more loads only a segment that is shown", () => {
		sorted.rows.set(
			"file:value:type:asc",
			file_names(60).map((name) => saved_row("file", name, ["md", name])),
		);
		// No folder has a type, so the folders' missing rows start at once. Keep that page loading.
		sorted.loadingKeys.add("folder:missing:type:asc");
		const { result, rerender } = render_sorted({ field: "type", direction: "asc" });
		expect(result.current.isBusy).toBe(true);

		act(() => result.current.loadMore());
		sorted.loadingKeys.clear();
		rerender({ sort: { field: "type", direction: "asc" } });
		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(50));
		expect(result.current.isDone).toBe(false);
	});

	test("waits for a sort before it loads anything", () => {
		const { result } = render_sorted(null);

		expect(result.current).toMatchObject({ rows: undefined, isBusy: true, isDone: false });
	});

	test("starts a metadata key's missing rows after its values, and loads past an empty page by itself", async () => {
		const sort: files_sort_Sort = { field: "metadata.status", direction: "asc" };
		sorted.rows.set("file:value:metadata.status:asc", [saved_row("file", "a.md", ["open", "a.md"])]);
		sorted.missingPages.set("file:missing:metadata.status:asc", [
			[],
			[saved_row("file", "b.md")],
			[saved_row("file", "c.md")],
		]);
		const { result } = render_sorted(sort);

		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]));
		expect(result.current.isDone).toBe(false);
		expect(cursorsSeen.filter((cursor) => cursor.startsWith("file:"))).toEqual(
			expect.arrayContaining(["file:null", "file:1"]),
		);
		expect(cursorsSeen).not.toContain("file:2");

		act(() => result.current.loadMore());
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md", "c.md"]));
		expect(result.current.isDone).toBe(true);
	});

	test("fails when the side rows refuse the folder", () => {
		sorted.sideRows = null;
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.isFailed).toBe(true);
	});
});
