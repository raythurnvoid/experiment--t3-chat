import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_api, app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_sort_Key, files_sort_Sort } from "../../shared/files-sort.ts";
import type { files_table_Filter } from "../../shared/files-table.ts";
import { useFilesSortedChildren, useFilesVisibleEntries } from "./files-search-hooks.ts";

type VisibleResult = FunctionReturnType<typeof app_convex_api.files_visible.list>;
type SortedPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;
type SortedRow = SortedPage["page"][number];
type SideRows = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>;
type SideRow = NonNullable<SideRows>["rows"][number];

// `sorted` holds every row of each sorted segment, keyed by its full folder and sort scope. A metadata
// key's missing segment is keyed by its pages instead, because its cursor can end a page early.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one segment loading.
const { cursorsSeen, requestsSeen, batchesSeen, sorted } = vi.hoisted(() => ({
	cursorsSeen: [] as string[],
	requestsSeen: [] as Array<{ id: string; args: SortedArgs }>,
	batchesSeen: [] as Array<Array<{ id: string; args: SortedArgs }>>,
	sorted: {
		rows: new Map<string, SortedRow[]>(),
		missingPages: new Map<string, SortedRow[][]>(),
		sideRows: undefined as SideRows | undefined,
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
		sideScopes: new Map<string, SideRows | Error | undefined>(),
		filtered: null as ((args: SortedArgs) => SortedPage | Error | undefined) | null,
		matches: new Map<string, { matches: boolean; preparing: boolean } | Error | null | undefined>(),
		seen: new Set<string>(),
		revision: 0,
		listeners: new Set<() => void>(),
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
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	parentId: app_convex_Id<"files_nodes"> | "root";
	kind: "file" | "folder";
	segment: "value" | "missing";
	sort: files_sort_Sort;
	filter: files_table_Filter | null;
	workLimit: number;
	paginationOpts?: { numItems: number; cursor: string | null };
};

const sorted_key = (args: SortedArgs) =>
	JSON.stringify([args.membershipId, args.parentId, args.kind, args.segment, args.sort, args.filter]);
const sorted_fixture_key = (
	kind: "folder" | "file",
	segment: "value" | "missing",
	field: string,
	direction: "asc" | "desc",
) =>
	sorted_key({
		membershipId: MEMBERSHIP_ID,
		parentId: FOLDER_ID,
		kind,
		segment,
		sort: { field, direction },
		filter: null,
		workLimit: 1000,
	});
const notify_sorted = () => {
	sorted.revision++;
	for (const listener of sorted.listeners) listener();
};
const match_key = (
	filter: files_table_Filter,
	target: SideRow["target"],
	membershipId = MEMBERSHIP_ID,
	parentId = FOLDER_ID,
) => JSON.stringify([membershipId, parentId, target, filter]);

// Answer each page at once. A cursor is the index of the page's first entry, or of the page itself for
// a metadata key's missing segment.
vi.mock("convex/react", async (importOriginal) => {
	const { useState, useMemo, useSyncExternalStore } = await import("react");
	const subscribe = (listener: () => void) => {
		sorted.listeners.add(listener);
		return () => sorted.listeners.delete(listener);
	};
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useQueries: (queries: Record<string, { query: FunctionReference<"query">; args: Record<string, unknown> }>) => {
			const revision = useSyncExternalStore(subscribe, () => sorted.revision);
			const batch = Object.entries(queries).flatMap(([id, request]) =>
				getFunctionName(request.query) === "files_nodes:list_tree_children_sorted" && request.args.filter !== null
					? [{ id, args: request.args as SortedArgs }]
					: [],
			);
			if (batch.length > 0) batchesSeen.push(batch);
			return useMemo(
				() =>
					Object.fromEntries(
						Object.entries(queries).map(([key, request]) => {
							if (getFunctionName(request.query) === "files_nodes:list_tree_children_sort_side_rows") {
								const args = request.args as {
									membershipId: typeof MEMBERSHIP_ID;
									parentId: typeof FOLDER_ID;
									sort: files_sort_Sort;
								};
								const scope = JSON.stringify([args.membershipId, args.parentId, args.sort]);
								return [
									key,
									sorted.sideScopes.has(scope)
										? sorted.sideScopes.get(scope)
										: sorted.loadingFields.has(args.sort.field)
											? undefined
											: sorted.sideRows,
								];
							}
							if (getFunctionName(request.query) === "files_nodes:get_table_filter_match") {
								const args = request.args as {
									membershipId: typeof MEMBERSHIP_ID;
									parentId: typeof FOLDER_ID;
									target: SideRow["target"];
									filter: files_table_Filter;
								};
								return [key, sorted.matches.get(match_key(args.filter, args.target, args.membershipId, args.parentId))];
							}
							if (getFunctionName(request.query) === "files_nodes:list_tree_children_sorted") {
								const args = request.args as SortedArgs;
								if (args.filter !== null) {
									const issuedKey = JSON.stringify([key, args]);
									if (!sorted.seen.has(issuedKey)) {
										sorted.seen.add(issuedKey);
										requestsSeen.push({ id: key, args });
									}
									return [key, sorted.filtered!(args)];
								}
								const cursor = args.paginationOpts!.cursor;
								cursorsSeen.push(`${args.kind}:${cursor}`);
								const pages = sorted.missingPages.get(sorted_key(args)) ?? [[]];
								const index = Number(cursor ?? "0");
								const result: SortedPage = {
									page: pages[index]!,
									isDone: index + 1 >= pages.length,
									continueCursor: String(index + 1),
									scanBoundary: pages[index]!.at(-1)?.sortKey ?? null,
									scannedCount: pages[index]!.length,
									workCount: pages[index]!.length,
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
				[queries, revision],
			);
		},
		usePaginatedQuery: (
			_query: FunctionReference<"query">,
			args: SortedArgs | "skip",
			options: { initialNumItems: number },
		) => {
			useSyncExternalStore(subscribe, () => sorted.revision);
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
	};
});

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const FOLDER_ID = "folder_1" as app_convex_Id<"files_nodes">;
const NAME_ASC: files_sort_Sort = { field: "name", direction: "asc" };
const NAME_FILTER: files_table_Filter = { kind: "name", field: "name", op: "contains", value: "match" };

const saved_row = (kind: "file" | "folder", name: string, sortKey: files_sort_Key = [name]) =>
	({
		_id: `node_${name}` as app_convex_Id<"files_nodes">,
		_creationTime: 2,
		name,
		kind,
		updatedAt: 1,
		contentByteSize: kind === "file" ? 42 : null,
		updatedBy: "user_1" as app_convex_Id<"users">,
		contentType: kind === "file" ? "text/markdown" : null,
		sortKey,
	}) as SortedRow;

const side_row = (name: string, sortKey: files_sort_Key = [name]): SideRow => ({
	target: { kind: "private", id: `draft_${name}` as app_convex_Id<"files_pending_nodes"> },
	name,
	kind: "file",
	createdAt: 1,
	updatedAt: 1,
	contentByteSize: null,
	updatedBy: "user_1" as app_convex_Id<"users">,
	contentType: "text/markdown",
	preparing: false,
	treeRow: null,
	segment: "value",
	sortKey,
});

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}.md`);

const filter_page = (
	page: SortedRow[] = [],
	continueCursor: string | null = null,
	workCount = 0,
	scanBoundary: files_sort_Key | null = page.at(-1)?.sortKey ?? null,
): SortedPage => ({
	page,
	isDone: continueCursor === null,
	continueCursor: continueCursor ?? "",
	scanBoundary,
	scannedCount: workCount,
	workCount,
});

beforeEach(() => {
	cursorsSeen.length = 0;
	sorted.rows.clear();
	sorted.missingPages.clear();
	sorted.sideRows = { rows: [], nameClaims: [], tooManyShared: false, tooManyPending: false };
	sorted.loadingFields.clear();
	sorted.loadingKeys.clear();
	sorted.sideScopes.clear();
	requestsSeen.length = 0;
	batchesSeen.length = 0;
	sorted.matches.clear();
	sorted.seen.clear();
	sorted.filtered = () => ({
		page: [],
		isDone: true,
		continueCursor: "",
		scanBoundary: null,
		scannedCount: 0,
		workCount: 0,
	});
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
				useFilesSortedChildren({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort: props.sort, filter: null }),
			{ initialProps: { sort } },
		);
	const render_filtered = (sort = NAME_ASC, filter = NAME_FILTER) =>
		renderHook(
			(props: {
				membershipId: typeof MEMBERSHIP_ID;
				folderId: typeof FOLDER_ID;
				sort: files_sort_Sort;
				filter: files_table_Filter | null;
			}) => useFilesSortedChildren(props),
			{
				initialProps: {
					membershipId: MEMBERSHIP_ID,
					folderId: FOLDER_ID,
					sort,
					filter: filter as files_table_Filter | null,
				},
			},
		);

	test("puts folders first, holds a side row until the loaded rows reach it, and hides claimed names", () => {
		sorted.rows.set(sorted_fixture_key("folder", "value", "name", "asc"), [saved_row("folder", "docs")]);
		sorted.rows.set(
			sorted_fixture_key("file", "value", "name", "asc"),
			file_names(60).map((name) => saved_row("file", name)),
		);
		sorted.sideRows = {
			rows: [side_row("file-05b.md"), side_row("zz.md")],
			nameClaims: ["file-01.md"],
			tooManyShared: false,
			tooManyPending: false,
		};
		const { result } = render_sorted(NAME_ASC);
		expect(result.current.sideTargets).toEqual(sorted.sideRows.rows.map((row) => row.target));

		const firstPage = file_names(50).filter((name) => name !== "file-01.md");
		firstPage.splice(firstPage.indexOf("file-05.md") + 1, 0, "file-05b.md");
		expect(result.current.rows?.map((row) => row.name)).toEqual(["docs", ...firstPage]);
		expect(result.current.rows?.find((row) => row.name === "file-00.md")).toMatchObject({
			createdAt: 2,
			contentByteSize: 42,
		});
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
			sorted_fixture_key("folder", "value", "name", "asc"),
			file_names(60, "folder").map((name) => saved_row("folder", name)),
		);
		sorted.rows.set(sorted_fixture_key("file", "value", "name", "asc"), [saved_row("file", "a.md")]);
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(50, "folder"));

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(60, "folder"), "a.md"]);
	});

	test("keeps folders A to Z when sorting by size, because folders have no size", () => {
		sorted.rows.set(sorted_fixture_key("folder", "value", "size", "desc"), [
			saved_row("folder", "a"),
			saved_row("folder", "c"),
		]);
		sorted.rows.set(sorted_fixture_key("file", "value", "size", "desc"), [saved_row("file", "big.md", [9, "big.md"])]);
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
		sorted.rows.set(sorted_fixture_key("file", "value", "name", "asc"), [
			saved_row("file", "a.md"),
			saved_row("file", "b.md"),
		]);
		sorted.rows.set(sorted_fixture_key("file", "value", "updated", "desc"), [
			saved_row("file", "b.md", [2]),
			saved_row("file", "a.md", [1]),
		]);
		const { result, rerender } = render_sorted(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);

		// A row changes without joining or leaving. The held rows must be the new ones.
		sorted.rows.set(sorted_fixture_key("file", "value", "name", "asc"), [
			{ ...saved_row("file", "a.md"), updatedAt: 5 },
			saved_row("file", "b.md"),
		]);
		act(notify_sorted);
		rerender({ sort: NAME_ASC });

		sorted.loadingFields.add("updated");
		act(notify_sorted);
		rerender({ sort: { field: "updated", direction: "desc" } });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		expect(result.current.rows?.[0]?.updatedAt).toBe(5);
		expect(result.current.isBusy).toBe(true);
		// The held rows' sort keys belong to the old sort, so the table must label them with it.
		expect(result.current.rowsSort).toEqual(NAME_ASC);

		sorted.loadingFields.clear();
		act(notify_sorted);
		rerender({ sort: { field: "updated", direction: "desc" } });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["b.md", "a.md"]);
		expect(result.current.isBusy).toBe(false);
		expect(result.current.rowsSort).toEqual({ field: "updated", direction: "desc" });
	});

	test("Show more loads only a segment that is shown", () => {
		sorted.rows.set(
			sorted_fixture_key("file", "value", "type", "asc"),
			file_names(60).map((name) => saved_row("file", name, ["md", name])),
		);
		// No folder has a type, so the folders' missing rows start at once. Keep that page loading.
		sorted.loadingKeys.add(sorted_fixture_key("folder", "missing", "type", "asc"));
		const { result, rerender } = render_sorted({ field: "type", direction: "asc" });
		expect(result.current.isBusy).toBe(true);

		act(() => result.current.loadMore());
		sorted.loadingKeys.clear();
		act(notify_sorted);
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
		sorted.rows.set(sorted_fixture_key("file", "value", "metadata.status", "asc"), [
			saved_row("file", "a.md", ["open", "a.md"]),
		]);
		sorted.missingPages.set(sorted_fixture_key("file", "missing", "metadata.status", "asc"), [
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

	test("Retry drops an unfiltered failed side query before subscribing again", () => {
		const scope = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, NAME_ASC]);
		sorted.sideScopes.set(scope, new Error("side rows failed"));
		const renders: Array<{ isBusy: boolean; isFailed: boolean }> = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: null,
			});
			renders.push({ isBusy: children.isBusy, isFailed: children.isFailed });
			return children;
		});
		expect(result.current).toMatchObject({ isFailed: true, filterRecovery: "retry" });
		renders.length = 0;
		act(() => result.current.retry());
		expect(renders).toContainEqual({ isBusy: true, isFailed: false });
		act(() => {
			sorted.sideScopes.delete(scope);
			notify_sorted();
		});
		expect(result.current).toMatchObject({ isFailed: false, isDone: true });
	});

	test("runs one filtered scan at a time and advances beyond empty match pages", async () => {
		let release = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? release
					? filter_page()
					: undefined
				: args.paginationOpts!.cursor === null
					? filter_page([], "50", 50, ["m"])
					: filter_page(
							file_names(5, "match").map((name) => saved_row("file", name)),
							"100",
							50,
						);
		const { result } = render_filtered();
		expect(requestsSeen).toHaveLength(1);
		expect(requestsSeen[0]!.args.kind).toBe("folder");
		expect(result.current.searching).toBe(true);
		act(() => {
			release = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(requestsSeen.map(({ args }) => [args.kind, args.paginationOpts!.cursor])).toEqual([
			["folder", null],
			["file", null],
			["file", "50"],
		]);
		expect(result.current).toMatchObject({ rowsFilter: NAME_FILTER, searching: false, paused: false, isDone: false });
		expect(
			batchesSeen.every((batch) => batch.filter(({ args }) => sorted.filtered!(args) === undefined).length <= 1),
		).toBe(true);
	});

	test("uses the raw scan boundary for side release and keeps every shadow claim", async () => {
		const draft = side_row("a-match.md");
		const shadow = side_row("match-shadow.md");
		const last = side_row("z-match.md");
		sorted.sideRows = {
			rows: [draft, shadow, last],
			nameClaims: [shadow.name],
			tooManyShared: false,
			tooManyPending: false,
		};
		sorted.matches.set(match_key(NAME_FILTER, draft.target), { matches: true, preparing: false });
		sorted.matches.set(match_key(NAME_FILTER, shadow.target), { matches: false, preparing: false });
		sorted.matches.set(match_key(NAME_FILTER, last.target), { matches: true, preparing: false });
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: filter_page(
						[saved_row("file", shadow.name), ...file_names(4, "match").map((name) => saved_row("file", name))],
						"50",
						50,
						["t"],
					);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(result.current.rows?.map((row) => row.name)).toContain(draft.name);
		expect(result.current.rows?.map((row) => row.name)).not.toContain(shadow.name);
		expect(result.current.rows?.map((row) => row.name)).not.toContain(last.name);
		expect(result.current.sideTargets).toEqual([draft.target, shadow.target, last.target]);
		expect(requestsSeen).toHaveLength(2);
	});

	test("shares one action allowance across all four segments and retains it across cached renders", async () => {
		const sort: files_sort_Sort = { field: "type", direction: "asc" };
		sorted.filtered = (args) => {
			if (args.kind === "folder" && args.segment === "value") return filter_page();
			if (args.kind === "file" && args.segment === "missing")
				return filter_page(
					file_names(5, "match").map((name) => saved_row("file", name)),
					"next",
					50,
				);
			const page = Number(args.paginationOpts!.cursor ?? 0);
			const count = args.kind === "folder" ? 8 : 12;
			return filter_page([], page + 1 === count ? null : String(page + 1), 50, [`${page}`]);
		};
		const { result } = render_filtered(sort);
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(requestsSeen.filter(({ args }) => args.kind === "folder" && args.segment === "missing")).toHaveLength(8);
		expect(requestsSeen.filter(({ args }) => args.kind === "file" && args.segment === "value")).toHaveLength(12);
		expect(requestsSeen.some(({ args }) => args.kind === "file" && args.segment === "missing")).toBe(false);
		const issued = requestsSeen.length;
		act(notify_sorted);
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(issued);
		act(() => result.current.continueSearch());
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(requestsSeen).toHaveLength(issued + 1);
		expect(result.current.paused).toBe(false);
	});

	test("releases unused work once and freezes every issued limit", async () => {
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page([], null, 7, ["folder"])
				: filter_page([], String(Number(args.paginationOpts!.cursor ?? 0) + 1), args.workLimit, ["file"]);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(requestsSeen.reduce((sum, { args }) => sum + (sorted.filtered!(args) as SortedPage).workCount, 0)).toBe(
			1000,
		);
		expect(requestsSeen.at(-1)!.args.workLimit).toBe(43);
		const frozen = requestsSeen.map(({ id, args }) => [id, args.paginationOpts!.cursor, args.workLimit]);
		act(notify_sorted);
		expect(requestsSeen.map(({ id, args }) => [id, args.paginationOpts!.cursor, args.workLimit])).toEqual(frozen);
	});

	test("first and later Show more have new match goals and Show less stops work", async () => {
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page();
			const page = Number(args.paginationOpts!.cursor ?? 0);
			const count = page === 0 ? 5 : 50;
			return filter_page(
				Array.from({ length: count }, (_, index) => saved_row("file", `match-${page}-${index}`)),
				String(page + 1),
				50,
			);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(55));
		act(() => result.current.requestMatches(result.current.rows!.length + 50));
		await waitFor(() => expect(result.current.rows).toHaveLength(105));
		const issued = requestsSeen.length;
		act(() => result.current.requestMatches(5));
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(issued);
		expect(result.current.searching).toBe(false);
	});

	test("Keep searching keeps its larger goal", async () => {
		let renewed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: renewed
					? filter_page(
							file_names(10, `match-${args.paginationOpts!.cursor}`).map((name) => saved_row("file", name)),
							String(Number(args.paginationOpts!.cursor ?? 0) + 1),
							50,
						)
					: filter_page([], String(Number(args.paginationOpts!.cursor ?? 0) + 1), 50);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.paused).toBe(true));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(requestsSeen.filter(({ args }) => args.kind === "file")).toHaveLength(40));
		act(() => {
			renewed = true;
			notify_sorted();
			result.current.continueSearch();
		});
		await waitFor(() => expect(result.current.rows!.length).toBeGreaterThanOrEqual(50));
		expect(result.current.searching).toBe(false);
	});

	test("holds the old filter label while applying and clears rows on a folder or membership change", async () => {
		const nextFilter: files_table_Filter = { kind: "name", field: "name", op: "contains", value: "later" };
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: args.filter === null || ("value" in args.filter && args.filter.value === "match")
					? filter_page(
							file_names(5, "match").map((name) => saved_row("file", name)),
							"next",
							50,
						)
					: undefined;
		const { result, rerender } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		rerender({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort: NAME_ASC, filter: nextFilter });
		expect(result.current.rowsFilter).toEqual(NAME_FILTER);
		expect(result.current.rows).toHaveLength(5);
		expect(result.current.isBusy).toBe(true);
		rerender({
			membershipId: MEMBERSHIP_ID,
			folderId: "folder_2" as typeof FOLDER_ID,
			sort: NAME_ASC,
			filter: nextFilter,
		});
		expect(result.current.rows).toBeUndefined();
		rerender({
			membershipId: "membership_2" as typeof MEMBERSHIP_ID,
			folderId: FOLDER_ID,
			sort: NAME_ASC,
			filter: nextFilter,
		});
		expect(result.current.rows).toBeUndefined();
		expect(requestsSeen.at(-1)!.args.paginationOpts!.cursor).toBeNull();
	});

	test.each([null, { matches: false, preparing: true }, new Error("match failed")])(
		"keeps claims when a side match is %s",
		async (match) => {
			const draft = side_row("match-shadow.md");
			sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: true, tooManyPending: true };
			sorted.matches.set(match_key(NAME_FILTER, draft.target), match);
			sorted.filtered = (args) =>
				args.kind === "folder" ? filter_page() : filter_page([saved_row("file", draft.name)], null, 1);
			const { result } = render_filtered();
			await waitFor(() =>
				expect(match instanceof Error ? result.current.isFailed : result.current.rows).toEqual(
					match instanceof Error ? true : [],
				),
			);
			expect(result.current.tooManyShared).toBe(true);
			expect(result.current.tooManyPending).toBe(true);
			expect(result.current.sideTargets).toEqual([draft.target]);
			if (match instanceof Error) expect(result.current.filterRecovery).toBe("retry");
			if (match != null && !(match instanceof Error) && match.preparing)
				expect(result.current).toMatchObject({ preparing: true, isDone: false });
		},
	);

	test("waits for all side checks and prunes an explicit refusal from held rows", async () => {
		const draft = side_row("a-match.md");
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		sorted.matches.set(match_key(NAME_FILTER, draft.target), { matches: true, preparing: false });
		let loading = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: loading
					? undefined
					: filter_page(
							file_names(4, "match").map((name) => saved_row("file", name)),
							"next",
							50,
							["z"],
						);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => {
			loading = true;
			sorted.matches.set(match_key(NAME_FILTER, draft.target), null);
			notify_sorted();
		});
		expect(result.current.rows?.some((row) => row.target.id === draft.target.id)).toBe(false);
		expect(result.current.sideTargets).toEqual([draft.target]);
		act(() => {
			sorted.sideRows = { ...sorted.sideRows!, rows: [] };
			notify_sorted();
		});
		expect(result.current.rows?.some((row) => row.target.id === draft.target.id)).toBe(false);
	});

	test.each(["refused", "removed"] as const)("Retry keeps a %s side row out of held rows", async (change) => {
		const draft = side_row("a-match.md");
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		sorted.matches.set(match_key(NAME_FILTER, draft.target), { matches: true, preparing: false });
		let loading = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: loading
					? undefined
					: filter_page(
							file_names(4, "match").map((name) => saved_row("file", name)),
							"next",
							50,
							["z"],
						);
		const shownDraft: boolean[] = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: NAME_FILTER,
			});
			shownDraft.push(children.rows?.some((row) => row.target.id === draft.target.id) ?? false);
			return children;
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => {
			loading = true;
			if (change === "refused") sorted.matches.set(match_key(NAME_FILTER, draft.target), null);
			else sorted.sideRows = { ...sorted.sideRows!, rows: [] };
			notify_sorted();
		});
		expect(result.current.rows?.some((row) => row.target.id === draft.target.id)).toBe(false);
		shownDraft.length = 0;
		act(() => result.current.retry());
		expect(shownDraft.length).toBeGreaterThan(0);
		expect(shownDraft).not.toContain(true);
	});

	test("a new name claim removes its held saved shadow while the side check loads", async () => {
		const draft = side_row("match-shadow.md");
		sorted.filtered = (args) =>
			args.kind === "folder" ? filter_page() : filter_page([saved_row("file", draft.name)], null, 1);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name]));
		act(() => {
			sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
			notify_sorted();
		});
		expect(result.current.rows?.some((row) => row.target.kind === "saved" && row.name === draft.name)).toBe(false);
		expect(result.current.sideTargets).toEqual([draft.target]);
	});

	test("confirmed main matches stop forward work while a side match is loading", async () => {
		const draft = side_row("z-match.md");
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: filter_page(
						file_names(5, "match").map((name) => saved_row("file", name)),
						"next",
						50,
						["z"],
					);
		const { result } = render_filtered();
		await waitFor(() => expect(requestsSeen.length).toBeGreaterThanOrEqual(2));
		expect(requestsSeen).toHaveLength(2);
		expect(result.current.searching).toBe(true);
		act(() => {
			sorted.matches.set(match_key(NAME_FILTER, draft.target), { matches: false, preparing: false });
			notify_sorted();
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(requestsSeen).toHaveLength(2);
	});

	test("reports a continuing no-progress page as an error and Retry preserves the choices", async () => {
		let fixed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: fixed
					? filter_page([saved_row("file", "match.md")], null, 1)
					: filter_page([], "", 50);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.filterRecovery).toBe("retry"));
		expect(result.current.isDone).toBe(false);
		act(() => {
			fixed = true;
			result.current.retry();
		});
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual(["match.md"]));
		expect(result.current.rowsFilter).toEqual(NAME_FILTER);
		expect(result.current.rowsSort).toEqual(NAME_ASC);
		expect(result.current.isDone).toBe(true);
	});

	test("rebuilds only settled slots after spending all forward work", async () => {
		let refreshing = false;
		let release = false;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page();
			const cursor = args.paginationOpts!.cursor;
			if (!refreshing) return filter_page([], String(Number(cursor ?? 0) + 1), 50, ["old"]);
			if (cursor === null) return filter_page([saved_row("file", "match-refreshed.md")], "r1", 50);
			if (cursor === "r1" && !release) return undefined;
			return filter_page([], `r${Number(cursor!.slice(1)) + 1}`, args.workLimit, ["new"]);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.paused).toBe(true));
		const count = requestsSeen.length;
		act(() => {
			refreshing = true;
			notify_sorted();
		});
		expect(result.current.refreshing).toBe(true);
		expect(result.current.rows).toEqual([]);
		expect(requestsSeen).toHaveLength(count + 1);
		act(() => {
			release = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.refreshing).toBe(false));
		expect(requestsSeen).toHaveLength(count + 19);
		expect(requestsSeen.slice(count).every(({ args }) => args.workLimit === 50)).toBe(true);
		expect(result.current.rows?.map((row) => row.name)).toEqual(["match-refreshed.md"]);
		expect(result.current).toMatchObject({ paused: true, isDone: false });
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(count + 19);
	});

	test("refresh stops at the old prefix even with a new unmet match goal", async () => {
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: args.paginationOpts!.cursor === null
					? filter_page(
							changed ? [] : file_names(5, "match").map((name) => saved_row("file", name)),
							changed ? "changed" : "next",
							50,
							["z"],
						)
					: undefined;
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => {
			changed = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.refreshing).toBe(false));
		expect(result.current.rows).toEqual([]);
		expect(requestsSeen).toHaveLength(2);
		expect(result.current.searching).toBe(false);
		expect(result.current.paused).toBe(true);
		act(() => result.current.continueSearch());
		expect(requestsSeen.at(-1)!.args.paginationOpts!.cursor).toBe("changed");
	});

	test("does not start a new missing segment during a settled-prefix refresh", async () => {
		const sort: files_sort_Sort = { field: "metadata.status", direction: "asc" };
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: filter_page(
						changed ? [] : file_names(5, "match").map((name) => saved_row("file", name)),
						changed ? null : "next",
						50,
					);
		const { result } = render_filtered(sort);
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		const count = requestsSeen.length;
		act(() => {
			changed = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.refreshing).toBe(false));
		expect(requestsSeen).toHaveLength(count);
		expect(requestsSeen.some(({ args }) => args.kind === "file" && args.segment === "missing")).toBe(false);
		expect(result.current.isDone).toBe(false);
	});

	test("charges a dropped forward request fully and replaces it with a new reserve", async () => {
		let changed = false;
		let release = false;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page([], null, 7);
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page(
					file_names(5, "match").map((name) => saved_row("file", name)),
					changed ? "r1" : "1",
					50,
				);
			if (!changed || !release) return undefined;
			return filter_page([], `r${Number(cursor!.slice(1)) + 1}`, args.workLimit, ["z"]);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		const dropped = requestsSeen.at(-1)!;
		expect(dropped.args.paginationOpts!.cursor).toBe("1");
		act(() => {
			changed = true;
			notify_sorted();
		});
		const replacement = requestsSeen.at(-1)!;
		expect(replacement.id).not.toBe(dropped.id);
		expect(replacement.args.paginationOpts!.cursor).toBe("r1");
		act(() => {
			release = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(requestsSeen.slice(2).reduce((sum, { args }) => sum + args.workLimit, 0)).toBe(1000);
		expect(requestsSeen.slice(2).some(({ args }) => args.paginationOpts!.cursor === "1")).toBe(true);
	});

	test("Show less drops an unanswered request and a late old response cannot spend the next action", async () => {
		let oldResolved = false;
		let newAction = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: args.paginationOpts!.cursor === null
					? filter_page(
							file_names(5, "match").map((name) => saved_row("file", name)),
							"1",
							50,
						)
					: newAction
						? filter_page([], String(Number(args.paginationOpts!.cursor) + 1), 50, ["z"])
						: oldResolved
							? filter_page([], "2", 1, ["z"])
							: undefined;
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		const old = requestsSeen.at(-1)!;
		act(() => result.current.requestMatches(5));
		act(() => {
			oldResolved = true;
			notify_sorted();
		});
		expect(result.current.searching).toBe(false);
		expect(requestsSeen.at(-1)!.id).toBe(old.id);
		act(() => {
			newAction = true;
			result.current.requestMatches(50);
		});
		await waitFor(() => expect(result.current.paused).toBe(true));
		const newPages = requestsSeen.slice(3);
		expect(newPages).toHaveLength(20);
		expect(newPages[0]!.id).not.toBe(old.id);
		expect(newPages[0]!.args.paginationOpts!.cursor).toBe("1");
	});

	test("a refresh error requires Reload table and reload starts five matches with the same choices", async () => {
		let changed = false;
		let fail = true;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page();
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page(
					file_names(5, "match").map((name) => saved_row("file", name)),
					changed ? "r1" : "1",
					50,
				);
			return changed && fail
				? new Error("refresh failed")
				: filter_page(
						file_names(45, "match-more").map((name) => saved_row("file", name)),
						"2",
						50,
					);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => {
			changed = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.filterRecovery).toBe("reload"));
		expect(result.current.rows).toHaveLength(50);
		act(() => {
			fail = false;
			result.current.reload();
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(result.current).toMatchObject({ rowsFilter: NAME_FILTER, rowsSort: NAME_ASC, filterRecovery: null });
	});

	test("a continuing no-progress refresh stops without retrying the cursor", async () => {
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: args.paginationOpts!.cursor === null
					? filter_page(
							file_names(5, "match").map((name) => saved_row("file", name)),
							changed ? "r1" : "1",
							50,
						)
					: changed
						? filter_page([], "r1", 50)
						: filter_page(
								file_names(45, "match-more").map((name) => saved_row("file", name)),
								"2",
								50,
							);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => {
			changed = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.filterRecovery).toBe("reload"));
		const count = requestsSeen.length;
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(count);
	});

	test("checks later side targets and waits for an unanswered side check", async () => {
		const drafts = file_names(10, "match").map((name) => side_row(name));
		sorted.sideRows = {
			rows: drafts,
			nameClaims: drafts.map((row) => row.name),
			tooManyShared: false,
			tooManyPending: false,
		};
		for (const draft of drafts)
			sorted.matches.set(match_key(NAME_FILTER, draft.target), { matches: draft === drafts.at(-1), preparing: false });
		sorted.matches.set(match_key(NAME_FILTER, drafts[0]!.target), undefined);
		const { result } = render_filtered();
		expect(result.current).toMatchObject({ searching: true, isDone: false });
		expect(result.current.rows).toBeUndefined();
		act(() => {
			sorted.matches.set(match_key(NAME_FILTER, drafts[0]!.target), { matches: false, preparing: false });
			notify_sorted();
		});
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual([drafts.at(-1)!.name]));
		expect(result.current.sideTargets).toHaveLength(10);
		expect(result.current.isDone).toBe(true);
	});

	test("an older action's late count cannot release work into Keep searching", async () => {
		let release = false;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page();
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page(
					file_names(5, "match").map((name) => saved_row("file", name)),
					"1",
					50,
				);
			if (cursor === "1") return release ? filter_page([], "2", 1, ["z"]) : undefined;
			return filter_page([], String(Number(cursor) + 1), args.workLimit, ["z"]);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		expect(requestsSeen.at(-1)!.args.paginationOpts!.cursor).toBe("1");
		act(() => result.current.continueSearch());
		act(() => {
			release = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(requestsSeen.slice(3).reduce((sum, { args }) => sum + args.workLimit, 0)).toBe(1000);
		expect(requestsSeen.slice(3)).toHaveLength(20);
	});

	test("another cursor change during refresh keeps the old slot ceiling", async () => {
		let revision = 0;
		let release = false;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page();
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page(
					file_names(5, `match-${revision}`).map((name) => saved_row("file", name)),
					revision === 0 ? "1" : `${revision}:1`,
					50,
				);
			if (revision > 0 && !release) return undefined;
			const page = Number(cursor!.split(":").at(-1));
			return filter_page(
				file_names(20, `match-${revision}-${page}`).map((name) => saved_row("file", name)),
				revision === 0 ? String(page + 1) : `${revision}:${page + 1}`,
				50,
			);
		};
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(65));
		const count = requestsSeen.length;
		act(() => {
			revision = 1;
			notify_sorted();
		});
		expect(result.current.refreshing).toBe(true);
		act(() => {
			revision = 2;
			notify_sorted();
		});
		expect(result.current.refreshing).toBe(true);
		act(() => {
			release = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.refreshing).toBe(false));
		expect(requestsSeen).toHaveLength(count + 4);
		expect(result.current.rows).toHaveLength(65);
		expect(result.current.rows?.every((row) => row.name.startsWith("match-2"))).toBe(true);
	});

	test("Show less stops a blocked refresh at its retained settled prefix", async () => {
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page()
				: args.paginationOpts!.cursor === null
					? filter_page(
							file_names(5, "match").map((name) => saved_row("file", name)),
							changed ? "r1" : "1",
							50,
						)
					: changed
						? undefined
						: filter_page(
								file_names(45, "match-more").map((name) => saved_row("file", name)),
								"2",
								50,
							);
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		act(() => {
			changed = true;
			notify_sorted();
		});
		expect(result.current.refreshing).toBe(true);
		const count = requestsSeen.length;
		act(() => result.current.requestMatches(5));
		expect(result.current.rows).toHaveLength(5);
		expect(result.current.refreshing).toBe(false);
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(count);
	});
});
