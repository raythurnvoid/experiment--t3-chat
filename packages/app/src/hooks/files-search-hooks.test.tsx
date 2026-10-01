import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_api, app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_sort_key_of,
	files_sort_text_key,
	type files_sort_Key,
	type files_sort_RowKey,
	type files_sort_Sort,
} from "../../shared/files-sort.ts";
import type { files_table_Filter } from "../../shared/files-table.ts";
import { useFilesSearchServerFilters, useFilesSortedChildren, useFilesVisibleEntries } from "./files-search-hooks.ts";

type VisibleResult = FunctionReturnType<typeof app_convex_api.files_visible.list>;
type SortedPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;
type SortedRow = SortedPage["page"][number];
type SideRows = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>;
type SideRow = NonNullable<SideRows>["rows"][number];
type SearchNodes = FunctionReturnType<typeof app_convex_api.files_metadata.search_nodes>;
type WorkspaceLinks = FunctionReturnType<typeof app_convex_api.files_share_links.list_workspace_links>;

// `sorted` holds every row of each sorted segment, keyed by its full folder and sort scope. A metadata
// key's missing segment is keyed by its pages instead, because its cursor can end a page early.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one segment loading.
// `search` answers the search box queries: `undefined` is loading.
const { cursorsSeen, requestsSeen, batchesSeen, keysSeen, enumsSeen, sorted, search } = vi.hoisted(() => ({
	cursorsSeen: [] as string[],
	requestsSeen: [] as Array<{ id: string; args: SortedArgs }>,
	batchesSeen: [] as Array<Array<{ id: string; args: SortedArgs }>>,
	keysSeen: [] as Array<Record<string, unknown>>,
	enumsSeen: [] as Array<Record<string, unknown>>,
	sorted: {
		rows: new Map<string, SortedRow[]>(),
		missingPages: new Map<string, SortedRow[][]>(),
		sideRows: undefined as SideRows | undefined,
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
		sideScopes: new Map<string, SideRows | Error | undefined>(),
		filtered: null as ((args: SortedArgs) => SortedPage | Error | undefined) | null,
		matches: new Map<string, { matches: boolean; preparing: boolean } | Error | null | undefined>(),
		keys: new Map<string, files_sort_RowKey | Error | null | undefined>(),
		seen: new Set<string>(),
		revision: 0,
		listeners: new Set<() => void>(),
	},
	search: {
		nodes: undefined as SearchNodes | Error | undefined,
		links: undefined as WorkspaceLinks | Error | undefined,
		linkRequests: [] as Array<Record<string, unknown>>,
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
const sorted_fixture_key = (args: {
	kind: "folder" | "file";
	segment: "value" | "missing";
	field: string;
	direction: "asc" | "desc";
}) =>
	{
		const { direction, field, kind, segment } = args;
	return sorted_key({
		membershipId: MEMBERSHIP_ID,
		parentId: FOLDER_ID,
		kind,
		segment,
		sort: [{ field, direction }],
		filter: null,
		workLimit: 1000,
	});
};
const notify_sorted = () => {
	sorted.revision++;
	for (const listener of sorted.listeners) listener();
};
const match_key = (args: {
	filter: files_table_Filter;
	target: SideRow["target"];
	membershipId?: Id<"organizations_workspaces_users">;
	parentId?: Id<"files_nodes">;
}) => {
	const { filter, target, membershipId = MEMBERSHIP_ID, parentId = FOLDER_ID } = args;

	return JSON.stringify([membershipId, parentId, target, filter]);
};

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
				getFunctionName(request.query) === "files_nodes:list_tree_children_sorted" &&
				(request.args.filter !== null || (request.args.sort as files_sort_Sort).length > 1)
					? [{ id, args: request.args as SortedArgs }]
					: [],
			);
			if (batch.length > 0) batchesSeen.push(batch);
			return useMemo(
				() =>
					Object.fromEntries(
						Object.entries(queries).map(([key, request]) => {
							if (getFunctionName(request.query) === "files_metadata:search_nodes") {
								return [key, search.nodes];
							}
							if (getFunctionName(request.query) === "files_share_links:list_workspace_links") {
								search.linkRequests.push(request.args);
								return [key, search.links];
							}
							if (getFunctionName(request.query) === "files_nodes:list_tree_children_sort_side_rows") {
								const args = request.args as {
									membershipId: typeof MEMBERSHIP_ID;
									parentId: typeof FOLDER_ID;
								};
								const scope = JSON.stringify([args.membershipId, args.parentId]);
								enumsSeen.push(request.args);
								return [key, sorted.sideScopes.has(scope) ? sorted.sideScopes.get(scope) : sorted.sideRows];
							}
							if (getFunctionName(request.query) === "files_nodes:get_table_sort_key") {
								if (!keysSeen.some((args) => JSON.stringify(args) === JSON.stringify(request.args)))
									keysSeen.push(request.args);
								return [
									key,
									sorted.keys.get(
										JSON.stringify([
											request.args.membershipId,
											request.args.parentId,
											request.args.target,
											request.args.sort,
										]),
									),
								];
							}
							if (getFunctionName(request.query) === "files_nodes:get_table_filter_match") {
								const args = request.args as {
									membershipId: typeof MEMBERSHIP_ID;
									parentId: typeof FOLDER_ID;
									target: SideRow["target"];
									filter: files_table_Filter;
								};
								return [key, sorted.matches.get(match_key({
									filter: args.filter,
									target: args.target,
									membershipId: args.membershipId,
									parentId: args.parentId,
								}))];
							}
							if (getFunctionName(request.query) === "files_nodes:list_tree_children_sorted") {
								const args = request.args as SortedArgs;
								if (args.filter !== null || args.sort.length > 1) {
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
									sortLimit: null,
									workPaused: false,
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
			if (args === "skip" || sorted.loadingFields.has(args.sort[0].field) || sorted.loadingKeys.has(key)) {
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
const NAME_ASC: files_sort_Sort = [{ field: "name", direction: "asc" }];
const NAME_FILTER: files_table_Filter = { kind: "name", field: "name", op: "contains", value: "match" };

const row_key = (name: string, part: files_sort_Key | null = [name]): files_sort_RowKey => {
	const nameKey: [string, string] = [files_sort_text_key(name), name];
	return {
		parts: [
			part === null
				? null
				: part[0] === name
					? nameKey
					: part.length > 1 && part.at(-1) === name
						? [part[0], ...nameKey]
						: part,
		],
		nameKey,
	};
};

const saved_row = (args: {
	kind: "file" | "folder";
	name: string;
	part?: files_sort_Key | null;
}) =>
	{
	const { kind, name, part = [name] } = args;

	return ({
		_id: `node_${name}` as app_convex_Id<"files_nodes">,
		_creationTime: 2,
		name,
		kind,
		updatedAt: 1,
		contentByteSize: kind === "file" ? 42 : null,
		updatedBy: "user_1" as app_convex_Id<"users">,
		contentType: kind === "file" ? "text/markdown" : null,
		sortKey: row_key(name, part),
	}) as SortedRow;
};

const side_row = (name: string): SideRow => ({
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
});

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}.md`);

const filter_page = (args: {
	page?: SortedRow[];
	continueCursor?: string | null;
	workCount?: number;
	scanBoundary?: files_sort_Key | files_sort_RowKey | null;
}): SortedPage => {
	const { page = [], continueCursor = null, workCount = 0, scanBoundary = page.at(-1)?.sortKey ?? null } = args;

	return ({
	page,
	isDone: continueCursor === null,
	continueCursor: continueCursor ?? "",
	scanBoundary: Array.isArray(scanBoundary) ? row_key(String(scanBoundary.at(-1)), scanBoundary) : scanBoundary,
	scannedCount: workCount,
	workCount,
	sortLimit: null,
	workPaused: false,
});
};

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
	sorted.keys.clear();
	keysSeen.length = 0;
	enumsSeen.length = 0;
	sorted.seen.clear();
	sorted.filtered = () => ({
		page: [],
		isDone: true,
		continueCursor: "",
		scanBoundary: null,
		scannedCount: 0,
		workCount: 0,
		sortLimit: null,
		workPaused: false,
	});
	search.nodes = undefined;
	search.links = undefined;
	search.linkRequests.length = 0;
});

afterEach(() => {
	cleanup();
});

describe("useFilesVisibleEntries", () => {
	test("returns entries only after every page is loaded", async () => {
		const { result } = renderHook(() => useFilesVisibleEntries({ membershipId: MEMBERSHIP_ID, folderPath: "/folder", mode: "children" }));

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
	const render_filtered = (sort = NAME_ASC, filter: files_table_Filter | null = NAME_FILTER) =>
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
		sorted.rows.set(sorted_fixture_key({ kind: "folder", segment: "value", field: "name", direction: "asc" }), [saved_row({ kind: "folder", name: "docs" })]);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			file_names(60).map((name) => saved_row({ kind: "file", name })),
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
			sorted_fixture_key({ kind: "folder", segment: "value", field: "name", direction: "asc" }),
			file_names(60, "folder").map((name) => saved_row({ kind: "folder", name })),
		);
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }), [saved_row({ kind: "file", name: "a.md" })]);
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(50, "folder"));

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(60, "folder"), "a.md"]);
	});

	test("keeps folders A to Z when sorting by size, because folders have no size", () => {
		sorted.rows.set(sorted_fixture_key({ kind: "folder", segment: "value", field: "size", direction: "desc" }), [
			saved_row({ kind: "folder", name: "a", part: null }),
			saved_row({ kind: "folder", name: "c", part: null }),
		]);
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "size", direction: "desc" }), [saved_row({ kind: "file", name: "big.md", part: [9, "big.md"] })]);
		sorted.sideRows = {
			rows: [{ ...side_row("b"), kind: "folder" }],
			nameClaims: [],
			tooManyShared: false,
			tooManyPending: false,
		};
		const { result } = render_sorted([{ field: "size", direction: "desc" }]);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["a", "b", "c", "big.md"]);
	});

	test("keeps the last rows while a new sort loads", () => {
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }), [
			saved_row({ kind: "file", name: "a.md" }),
			saved_row({ kind: "file", name: "b.md" }),
		]);
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "updated", direction: "desc" }), [
			saved_row({ kind: "file", name: "b.md", part: [2] }),
			saved_row({ kind: "file", name: "a.md", part: [1] }),
		]);
		const { result, rerender } = render_sorted(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);

		// A row changes without joining or leaving. The held rows must be the new ones.
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }), [
			{ ...saved_row({ kind: "file", name: "a.md" }), updatedAt: 5 },
			saved_row({ kind: "file", name: "b.md" }),
		]);
		act(notify_sorted);
		rerender({ sort: NAME_ASC });

		sorted.loadingFields.add("updated");
		act(notify_sorted);
		rerender({ sort: [{ field: "updated", direction: "desc" }] });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		expect(result.current.rows?.[0]?.updatedAt).toBe(5);
		expect(result.current.isBusy).toBe(true);
		// The held rows' sort keys belong to the old sort, so the table must label them with it.
		expect(result.current.rowsSort).toEqual(NAME_ASC);

		sorted.loadingFields.clear();
		act(notify_sorted);
		rerender({ sort: [{ field: "updated", direction: "desc" }] });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["b.md", "a.md"]);
		expect(result.current.isBusy).toBe(false);
		expect(result.current.rowsSort).toEqual([{ field: "updated", direction: "desc" }]);
	});

	test("Show more loads only a segment that is shown", () => {
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "type", direction: "asc" }),
			file_names(60).map((name) => saved_row({ kind: "file", name, part: ["md", name] })),
		);
		// No folder has a type, so the folders' missing rows start at once. Keep that page loading.
		sorted.loadingKeys.add(sorted_fixture_key({ kind: "folder", segment: "missing", field: "type", direction: "asc" }));
		const { result, rerender } = render_sorted([{ field: "type", direction: "asc" }]);
		expect(result.current.isBusy).toBe(true);

		act(() => result.current.loadMore());
		sorted.loadingKeys.clear();
		act(notify_sorted);
		rerender({ sort: [{ field: "type", direction: "asc" }] });
		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(50));
		expect(result.current.isDone).toBe(false);
	});

	test("waits for a sort before it loads anything", () => {
		const { result } = render_sorted(null);

		expect(result.current).toMatchObject({ rows: undefined, isBusy: true, isDone: false });
	});

	test("starts a metadata key's missing rows after its values, and loads past an empty page by itself", async () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "asc" }];
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "metadata.status", direction: "asc" }), [
			saved_row({ kind: "file", name: "a.md", part: ["open", "a.md"] }),
		]);
		sorted.missingPages.set(sorted_fixture_key({ kind: "file", segment: "missing", field: "metadata.status", direction: "asc" }), [
			[],
			[saved_row({ kind: "file", name: "b.md" })],
			[saved_row({ kind: "file", name: "c.md" })],
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
		const scope = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID]);
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
					? filter_page({})
					: undefined
				: args.paginationOpts!.cursor === null
					? filter_page({ page: [], continueCursor: "50", workCount: 50, scanBoundary: ["m"] })
					: filter_page({
						page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: "100",
						workCount: 50,
					});
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
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches: true, preparing: false });
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: shadow.target }), { matches: false, preparing: false });
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: last.target }), { matches: true, preparing: false });
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: filter_page({
					page: [saved_row({ kind: "file", name: shadow.name }), ...file_names(4, "match").map((name) => saved_row({ kind: "file", name }))],
					continueCursor: "50",
					workCount: 50,
					scanBoundary: ["t"],
				});
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(result.current.rows?.map((row) => row.name)).toContain(draft.name);
		expect(result.current.rows?.map((row) => row.name)).not.toContain(shadow.name);
		expect(result.current.rows?.map((row) => row.name)).not.toContain(last.name);
		expect(result.current.sideTargets).toEqual([draft.target, shadow.target, last.target]);
		expect(requestsSeen).toHaveLength(2);
	});

	test("shares one action allowance across all four segments and retains it across cached renders", async () => {
		const sort: files_sort_Sort = [{ field: "type", direction: "asc" }];
		sorted.filtered = (args) => {
			if (args.kind === "folder" && args.segment === "value") return filter_page({});
			if (args.kind === "file" && args.segment === "missing")
				return filter_page({
					page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: "next",
					workCount: 50,
				});
			const page = Number(args.paginationOpts!.cursor ?? 0);
			const count = args.kind === "folder" ? 8 : 12;
			return filter_page({
				page: [],
				continueCursor: page + 1 === count ? null : String(page + 1),
				workCount: 50,
				scanBoundary: [`${page}`],
			});
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
				? filter_page({ page: [], continueCursor: null, workCount: 7, scanBoundary: ["folder"] })
				: filter_page({
					page: [],
					continueCursor: String(Number(args.paginationOpts!.cursor ?? 0) + 1),
					workCount: args.workLimit,
					scanBoundary: ["file"],
				});
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
			if (args.kind === "folder") return filter_page({});
			const page = Number(args.paginationOpts!.cursor ?? 0);
			const count = page === 0 ? 5 : 50;
			return filter_page({
				page: Array.from({ length: count }, (_, index) => saved_row({ kind: "file", name: `match-${page}-${index}` })),
				continueCursor: String(page + 1),
				workCount: 50,
			});
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
				? filter_page({})
				: renewed
					? filter_page({
						page: file_names(10, `match-${args.paginationOpts!.cursor}`).map((name) => saved_row({ kind: "file", name })),
						continueCursor: String(Number(args.paginationOpts!.cursor ?? 0) + 1),
						workCount: 50,
					})
					: filter_page({ page: [], continueCursor: String(Number(args.paginationOpts!.cursor ?? 0) + 1), workCount: 50 });
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
				? filter_page({})
				: args.filter === null || ("value" in args.filter && args.filter.value === "match")
					? filter_page({
						page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: "next",
						workCount: 50,
					})
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

	test.each([false, true])("finishes a built-in filter when a preparing draft has matches %s", async (matches) => {
		const draft = { ...side_row(matches ? "match-draft.md" : "draft.md"), preparing: true };
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches, preparing: false });
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.isBusy).toBe(false));
		expect(requestsSeen).toHaveLength(2);
		expect(result.current.rows?.map((row) => row.name)).toEqual(matches ? [draft.name] : []);
		expect(result.current).toMatchObject({ preparing: false, isDone: true });
	});

	test("keeps an unknown metadata match incomplete after every segment finishes", async () => {
		const draft = side_row("draft.md");
		const filter: files_table_Filter = { kind: "text", field: "metadata.status", op: "missing" };
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		sorted.matches.set(match_key({ filter, target: draft.target }), { matches: false, preparing: true });
		const { result } = render_filtered(NAME_ASC, filter);
		await waitFor(() => expect(result.current.isBusy).toBe(false));
		expect(requestsSeen).toHaveLength(2);
		expect(result.current.rows).toEqual([]);
		expect(result.current).toMatchObject({ preparing: true, isDone: false });
		act(() => {
			sorted.matches.set(match_key({ filter, target: draft.target }), { matches: false, preparing: false });
			notify_sorted();
		});
		expect(result.current).toMatchObject({ preparing: false, isDone: true });
	});

	test("keeps unfiltered enumeration preparation incomplete", () => {
		const draft = { ...side_row("draft.md"), preparing: true };
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		const { result } = render_sorted(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name]);
		expect(result.current).toMatchObject({ preparing: true, isDone: false, isBusy: false });
	});

	test.each([null, { matches: false, preparing: true }, new Error("match failed")])(
		"keeps claims when a side match is %s",
		async (match) => {
			const draft = side_row("match-shadow.md");
			sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: true, tooManyPending: true };
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), match);
			sorted.filtered = (args) =>
				args.kind === "folder" ? filter_page({}) : filter_page({ page: [saved_row({ kind: "file", name: draft.name })], continueCursor: null, workCount: 1 });
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
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches: true, preparing: false });
		let loading = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: loading
					? undefined
					: filter_page({
						page: file_names(4, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: "next",
						workCount: 50,
						scanBoundary: ["z"],
					});
		const { result } = render_filtered();
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => {
			loading = true;
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), null);
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
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches: true, preparing: false });
		let loading = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: loading
					? undefined
					: filter_page({
						page: file_names(4, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: "next",
						workCount: 50,
						scanBoundary: ["z"],
					});
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
			if (change === "refused") sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), null);
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
			args.kind === "folder" ? filter_page({}) : filter_page({ page: [saved_row({ kind: "file", name: draft.name })], continueCursor: null, workCount: 1 });
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
				? filter_page({})
				: filter_page({
					page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: "next",
					workCount: 50,
					scanBoundary: ["z"],
				});
		const { result } = render_filtered();
		await waitFor(() => expect(requestsSeen.length).toBeGreaterThanOrEqual(2));
		expect(requestsSeen).toHaveLength(2);
		expect(result.current.searching).toBe(true);
		act(() => {
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches: false, preparing: false });
			notify_sorted();
		});
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		expect(requestsSeen).toHaveLength(2);
	});

	test("reports a continuing no-progress page as an error and Retry preserves the choices", async () => {
		let fixed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: fixed
					? filter_page({ page: [saved_row({ kind: "file", name: "match.md" })], continueCursor: null, workCount: 1 })
					: filter_page({ page: [], continueCursor: "", workCount: 50 });
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
			if (args.kind === "folder") return filter_page({});
			const cursor = args.paginationOpts!.cursor;
			if (!refreshing) return filter_page({ page: [], continueCursor: String(Number(cursor ?? 0) + 1), workCount: 50, scanBoundary: ["old"] });
			if (cursor === null) return filter_page({
				page: [saved_row({ kind: "file", name: "match-refreshed.md" })],
				continueCursor: "r1",
				workCount: 50,
			});
			if (cursor === "r1" && !release) return undefined;
			return filter_page({
				page: [],
				continueCursor: `r${Number(cursor!.slice(1)) + 1}`,
				workCount: args.workLimit,
				scanBoundary: ["new"],
			});
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
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? filter_page({
						page: changed ? [] : file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: changed ? "changed" : "next",
						workCount: 50,
						scanBoundary: ["z"],
					})
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
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "asc" }];
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: filter_page({
					page: changed ? [] : file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: changed ? null : "next",
					workCount: 50,
				});
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
			if (args.kind === "folder") return filter_page({ page: [], continueCursor: null, workCount: 7 });
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page({
					page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: changed ? "r1" : "1",
					workCount: 50,
				});
			if (!changed || !release) return undefined;
			return filter_page({
				page: [],
				continueCursor: `r${Number(cursor!.slice(1)) + 1}`,
				workCount: args.workLimit,
				scanBoundary: ["z"],
			});
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
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? filter_page({
						page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: "1",
						workCount: 50,
					})
					: newAction
						? filter_page({
							page: [],
							continueCursor: String(Number(args.paginationOpts!.cursor) + 1),
							workCount: 50,
							scanBoundary: ["z"],
						})
						: oldResolved
							? filter_page({ page: [], continueCursor: "2", workCount: 1, scanBoundary: ["z"] })
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
			if (args.kind === "folder") return filter_page({});
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page({
					page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: changed ? "r1" : "1",
					workCount: 50,
				});
			return changed && fail
				? new Error("refresh failed")
				: filter_page({
					page: file_names(45, "match-more").map((name) => saved_row({ kind: "file", name })),
					continueCursor: "2",
					workCount: 50,
				});
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
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? filter_page({
						page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: changed ? "r1" : "1",
						workCount: 50,
					})
					: changed
						? filter_page({ page: [], continueCursor: "r1", workCount: 50 })
						: filter_page({
							page: file_names(45, "match-more").map((name) => saved_row({ kind: "file", name })),
							continueCursor: "2",
							workCount: 50,
						});
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
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: draft.target }), { matches: draft === drafts.at(-1), preparing: false });
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: drafts[0]!.target }), undefined);
		const { result } = render_filtered();
		expect(result.current).toMatchObject({ searching: true, isDone: false });
		expect(result.current.rows).toBeUndefined();
		act(() => {
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: drafts[0]!.target }), { matches: false, preparing: false });
			notify_sorted();
		});
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual([drafts.at(-1)!.name]));
		expect(result.current.sideTargets).toHaveLength(10);
		expect(result.current.isDone).toBe(true);
	});

	test("an older action's late count cannot release work into Keep searching", async () => {
		let release = false;
		sorted.filtered = (args) => {
			if (args.kind === "folder") return filter_page({});
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page({
					page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
					continueCursor: "1",
					workCount: 50,
				});
			if (cursor === "1") return release ? filter_page({ page: [], continueCursor: "2", workCount: 1, scanBoundary: ["z"] }) : undefined;
			return filter_page({
				page: [],
				continueCursor: String(Number(cursor) + 1),
				workCount: args.workLimit,
				scanBoundary: ["z"],
			});
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
			if (args.kind === "folder") return filter_page({});
			const cursor = args.paginationOpts!.cursor;
			if (cursor === null)
				return filter_page({
					page: file_names(5, `match-${revision}`).map((name) => saved_row({ kind: "file", name })),
					continueCursor: revision === 0 ? "1" : `${revision}:1`,
					workCount: 50,
				});
			if (revision > 0 && !release) return undefined;
			const page = Number(cursor!.split(":").at(-1));
			return filter_page({
				page: file_names(20, `match-${revision}-${page}`).map((name) => saved_row({ kind: "file", name })),
				continueCursor: revision === 0 ? String(page + 1) : `${revision}:${page + 1}`,
				workCount: 50,
			});
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
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? filter_page({
						page: file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
						continueCursor: changed ? "r1" : "1",
						workCount: 50,
					})
					: changed
						? undefined
						: filter_page({
							page: file_names(45, "match-more").map((name) => saved_row({ kind: "file", name })),
							continueCursor: "2",
							workCount: 50,
						});
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

	test("multi-sort without a filter uses one scan and one allowance across all segments", async () => {
		const sort: files_sort_Sort = [
			{ field: "type", direction: "desc" },
			{ field: "updated", direction: "asc" },
		];
		sorted.filtered = (args) => {
			if (args.kind === "folder" && args.segment === "value") return filter_page({ page: [], continueCursor: null, workCount: 10 });
			if (args.kind === "folder") return filter_page({ page: [], continueCursor: null, workCount: 250 });
			if (args.segment === "value") return filter_page({ page: [], continueCursor: null, workCount: 200 });
			return filter_page({ page: [], continueCursor: "later", workCount: args.workLimit });
		};
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(requestsSeen.map(({ args }) => [args.kind, args.segment, args.workLimit])).toEqual([
			["folder", "value", 1000],
			["folder", "missing", 990],
			["file", "value", 740],
			["file", "missing", 540],
		]);
		expect(requestsSeen.reduce((sum, { args }) => sum + (sorted.filtered!(args) as SortedPage).workCount, 0)).toBe(
			1000,
		);
		expect(requestsSeen.every(({ args }) => args.filter === null && args.paginationOpts!.numItems === 50)).toBe(true);
		const before = requestsSeen.length;
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(before);
	});

	test.each(["Keep searching", "Show more"])(
		"a group pause settles safely and %s replaces it with a fresh allowance",
		async (action) => {
			const sort: files_sort_Sort = [
				{ field: "created", direction: "asc" },
				{ field: "updated", direction: "desc" },
			];
			let renewed = false;
			sorted.filtered = (args) =>
				args.kind === "folder"
					? filter_page({ page: [], continueCursor: null, workCount: 700 })
					: renewed
						? filter_page({ page: [saved_row({ kind: "file", name: "a" })], continueCursor: null, workCount: 201 })
						: { ...filter_page({ page: [], continueCursor: "", workCount: 200 }), workPaused: true };
			const { result } = render_sorted(sort);
			await waitFor(() =>
				expect(result.current).toMatchObject({ paused: true, workPaused: true, isFailed: false, sortLimit: null }),
			);
			expect(requestsSeen.map(({ args }) => args.workLimit)).toEqual([1000, 300]);
			const pausedId = requestsSeen.at(-1)!.id;
			act(() => {
				renewed = true;
				if (action === "Keep searching") result.current.continueSearch();
				else result.current.requestMatches(50);
			});
			expect(requestsSeen.at(-1)!.args.workLimit).toBe(1000);
			expect(requestsSeen.at(-1)!.args.paginationOpts!.cursor).toBeNull();
			expect(requestsSeen.at(-1)!.id).not.toBe(pausedId);
			await waitFor(() => expect(result.current.isDone).toBe(true));
		},
	);

	test("a true group limit keeps completed rows and stops every later scan", async () => {
		const sort: files_sort_Sort = [
			{ field: "created", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: {
						...filter_page({ page: [saved_row({ kind: "file", name: "a" })], continueCursor: "safe", workCount: 400 }),
						sortLimit: { reason: "group_rows" },
					};
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.sortLimit).toEqual({ reason: "group_rows" }));
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a"]);
		expect(result.current).toMatchObject({ isDone: false, searching: false, paused: false, isFailed: false });
		const before = requestsSeen.length;
		act(() => result.current.requestMatches(50));
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(before);
	});

	test("Retry after a side-key error replaces a paused group with a fresh reserve", async () => {
		const sort: files_sort_Sort = [
			{ field: "created", direction: "asc" },
			{ field: "metadata.status", direction: "asc" },
		];
		const draft = side_row("draft.md");
		sorted.sideRows = { rows: [draft], nameClaims: [], tooManyShared: false, tooManyPending: false };
		const key = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]);
		const freshKey = files_sort_key_of({ sort, facts: { ...draft, type: "md" }, metadataParts: new Map() });
		sorted.keys.set(key, freshKey);
		let renewed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({ page: [], continueCursor: null, workCount: 700 })
				: renewed && args.workLimit === 1000
					? filter_page({ page: [], continueCursor: null, workCount: 201 })
					: { ...filter_page({ page: [], continueCursor: "", workCount: 200 }), workPaused: true };
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.paused).toBe(true));
		const pausedId = requestsSeen.at(-1)!.id;
		act(() => {
			sorted.keys.set(key, new Error("key read failed"));
			notify_sorted();
		});
		expect(result.current).toMatchObject({ isFailed: true, filterRecovery: "retry" });
		act(() => {
			renewed = true;
			sorted.keys.set(key, freshKey);
			result.current.retry();
		});
		expect(requestsSeen.at(-1)!.args.workLimit).toBe(1000);
		expect(requestsSeen.at(-1)!.id).not.toBe(pausedId);
		await waitFor(() => expect(result.current.isDone).toBe(true));
		expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name]);
	});

	test.each([150, 400])(
		"builds all %s built-in side keys without extra queries and reuses enumeration",
		async (count) => {
			const drafts = file_names(count).map(side_row);
			sorted.sideRows = { rows: drafts, nameClaims: [], tooManyShared: false, tooManyPending: false };
			const { result, rerender } = render_filtered(
				[
					{ field: "name", direction: "asc" },
					{ field: "metadata.status", direction: "desc" },
				],
				null,
			);
			expect(keysSeen).toEqual([]);
			await waitFor(() => expect(result.current.isDone).toBe(true));
			expect(result.current.rows).toHaveLength(count);
			expect(keysSeen).toEqual([]);
			const initialEnumeration = enumsSeen[0];
			rerender({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: [
					{ field: "size", direction: "desc" },
					{ field: "created", direction: "asc" },
				],
				filter: null,
			});
			await waitFor(() => expect(result.current.isDone).toBe(true));
			expect(result.current.rows).toHaveLength(count);
			expect(keysSeen).toEqual([]);
			expect(enumsSeen.every((args) => args === initialEnumeration)).toBe(true);
			expect(initialEnumeration).toEqual({ membershipId: MEMBERSHIP_ID, parentId: FOLDER_ID });
		},
	);

	test("requests one full key for every metadata side target and waits for the last one", async () => {
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction: "asc" },
			{ field: "metadata.priority", direction: "desc" },
			{ field: "name", direction: "desc" },
		];
		const drafts = file_names(400).map(side_row);
		sorted.sideRows = { rows: drafts, nameClaims: [], tooManyShared: false, tooManyPending: false };
		for (const draft of drafts.slice(0, -1))
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]),
				files_sort_key_of({ sort, facts: { ...draft, type: "md" }, metadataParts: new Map([["metadata.status", "same"]]) }),
			);
		const { result } = render_sorted(sort);
		expect(keysSeen).toHaveLength(400);
		expect(result.current.rows).toBeUndefined();
		const last = drafts.at(-1)!;
		act(() => {
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, last.target, sort]),
				files_sort_key_of({ sort, facts: { ...last, type: "md" }, metadataParts: new Map([["metadata.status", "same"]]) }),
			);
			notify_sorted();
		});
		await waitFor(() => expect(result.current.isBusy).toBe(false));
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(400)].reverse());
	});

	test("uses the full fresh side key and keeps a refused target's claims through Retry", async () => {
		const sort: files_sort_Sort = [
			{ field: "updated", direction: "desc" },
			{ field: "metadata.status", direction: "asc" },
		];
		const draft = side_row("shadow.md");
		sorted.sideRows = { rows: [draft], nameClaims: [draft.name], tooManyShared: false, tooManyPending: false };
		const targetKey = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]);
		sorted.keys.set(
			targetKey,
			files_sort_key_of({
				sort,
				facts: { ...draft, updatedAt: 100, type: "md" },
				metadataParts: new Map([["metadata.status", "same"]]),
			}),
		);
		const main = {
			...saved_row({ kind: "file", name: "other.md" }),
			sortKey: files_sort_key_of({
				sort,
				facts: { ...draft, name: "other.md", updatedAt: 2, type: "md" },
				metadataParts: new Map([["metadata.status", "same"]]),
			}),
		};
		let loading = false;
		sorted.filtered = (args) =>
			args.kind === "folder" ? filter_page({}) : loading ? undefined : filter_page({ page: [main, { ...main, name: draft.name }] });
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name, "other.md"]));
		act(() => {
			loading = true;
			sorted.keys.set(targetKey, null);
			notify_sorted();
		});
		expect(result.current.rows?.map((row) => row.name)).toEqual(["other.md"]);
		act(() => result.current.retry());
		expect(result.current.rows?.map((row) => row.name)).toEqual(["other.md"]);
		expect(result.current.sideTargets).toEqual([draft.target]);
	});

	test("releases side rows only through the full secondary scan boundary", async () => {
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		const before = { ...side_row("z-before.md"), updatedAt: 9 };
		const after = { ...side_row("a-after.md"), updatedAt: 1 };
		sorted.sideRows = { rows: [before, after], nameClaims: [], tooManyShared: false, tooManyPending: false };
		for (const draft of [before, after])
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]),
				files_sort_key_of({ sort, facts: { ...draft, type: "md" }, metadataParts: new Map([["metadata.status", "same"]]) }),
			);
		const boundary = files_sort_key_of({
			sort,
			facts: { ...before, name: "boundary.md", updatedAt: 5, type: "md" },
			metadataParts: new Map([["metadata.status", "same"]]),
		});
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: { ...filter_page({ page: [], continueCursor: "next", workCount: args.workLimit, scanBoundary: boundary }), scannedCount: 50 };
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.paused).toBe(true));
		expect(result.current.rows?.map((row) => row.name)).toEqual([before.name]);
	});

	test("a frozen group refresh pause requires Reload table", async () => {
		const sort: files_sort_Sort = [
			{ field: "created", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		let changed = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? filter_page({
						page: file_names(5).map((name) => saved_row({ kind: "file", name })),
						continueCursor: changed ? "changed" : "first",
						workCount: 200,
					})
					: changed
						? { ...filter_page({ page: [], continueCursor: "changed", workCount: 100 }), workPaused: true }
						: filter_page({
							page: file_names(45, "more").map((name) => saved_row({ kind: "file", name })),
							continueCursor: "second",
							workCount: 200,
						});
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		const secondLimit = requestsSeen.at(-1)!.args.workLimit;
		act(() => {
			changed = true;
			notify_sorted();
		});
		await waitFor(() => expect(result.current.filterRecovery).toBe("reload"));
		expect(requestsSeen.at(-1)!.args.workLimit).toBe(secondLimit);
		expect(result.current.rows).toHaveLength(50);
		const before = requestsSeen.length;
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(before);
		act(() => result.current.reload());
		await waitFor(() => expect(result.current.filterRecovery).toBeNull());
		expect(result.current.rows).toHaveLength(5);
	});

	test("a new limit on a settled page discards its old suffix even without a cursor change", async () => {
		const sort: files_sort_Sort = [
			{ field: "created", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		let limited = false;
		sorted.filtered = (args) =>
			args.kind === "folder"
				? filter_page({})
				: args.paginationOpts!.cursor === null
					? {
							...filter_page({
								page: file_names(5).map((name) => saved_row({ kind: "file", name })),
								continueCursor: "first",
								workCount: 200,
							}),
							sortLimit: limited ? { reason: "bytes" } : null,
						}
					: limited
						? new Error("obsolete suffix")
						: filter_page({
							page: file_names(45, "more").map((name) => saved_row({ kind: "file", name })),
							continueCursor: "second",
							workCount: 200,
						});
		const { result } = render_sorted(sort);
		await waitFor(() => expect(result.current.rows).toHaveLength(5));
		act(() => result.current.requestMatches(50));
		await waitFor(() => expect(result.current.rows).toHaveLength(50));
		const before = requestsSeen.length;
		act(() => {
			limited = true;
			notify_sorted();
		});
		await waitFor(() =>
			expect(result.current).toMatchObject({
				sortLimit: { reason: "bytes" },
				isFailed: false,
				isDone: false,
				isBusy: false,
			}),
		);
		expect(result.current.rows).toHaveLength(5);
		act(notify_sorted);
		expect(requestsSeen).toHaveLength(before);
	});

	test("holds the whole old list until new metadata keys settle", async () => {
		const draft = side_row("a.md");
		sorted.sideRows = { rows: [draft], nameClaims: [], tooManyShared: false, tooManyPending: false };
		const { result, rerender } = render_filtered(NAME_ASC, null);
		expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name]);
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction: "asc" },
			{ field: "name", direction: "desc" },
		];
		rerender({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort, filter: null });
		expect(result.current.rowsSort).toEqual(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual([draft.name]);
		expect(result.current.isBusy).toBe(true);
		act(() => {
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]),
				files_sort_key_of({ sort, facts: { ...draft, type: "md" }, metadataParts: new Map() }),
			);
			notify_sorted();
		});
		await waitFor(() => expect(result.current.isBusy).toBe(false));
		expect(result.current.rowsSort).toEqual(sort);
	});
});

describe("useFilesSearchServerFilters", () => {
	const render_search = (query: string) =>
		renderHook(() => useFilesSearchServerFilters({ membershipId: MEMBERSHIP_ID, searchQuery: query, treeItemsList: undefined }));
	const LINK = {
		nodeId: "node_1" as app_convex_Id<"files_nodes">,
		createdBy: "user_1" as app_convex_Id<"users">,
		createdAt: 1,
	};

	test("answers every file.link chip from one workspace link list", () => {
		search.links = [LINK];
		const { result } = render_search("file.link:public !file.link:PUBLIC");

		expect(result.current.searchServerTargetKeys).toEqual(
			new Map([
				["file.link:public", new Set(["saved:node_1"])],
				["!file.link:PUBLIC", new Set(["saved:node_1"])],
			]),
		);
		expect(result.current.isSearchLoading).toBe(false);
		expect(result.current.isSearchFailed).toBe(false);
		expect(search.linkRequests.at(-1)).toEqual({ membershipId: MEMBERSHIP_ID });
	});

	test("asks for no link list without a valid file.link chip", () => {
		search.links = [LINK];
		const { result } = render_search("file.link:pub* file.kind:file notes");

		expect(search.linkRequests).toEqual([]);
		expect(result.current.searchServerTargetKeys.size).toBe(0);
		expect(result.current.isSearchLoading).toBe(false);
	});

	test("waits for the link list and for metadata chips together", () => {
		search.nodes = { targets: [], truncated: false };
		const { result, rerender } = render_search("metadata.status:open file.link:public");

		// The metadata chip answered, but the link list is still loading.
		expect(result.current.searchServerTargetKeys.has("metadata.status:open")).toBe(true);
		expect(result.current.searchServerTargetKeys.has("file.link:public")).toBe(false);
		expect(result.current.isSearchLoading).toBe(true);

		// An empty list is a real answer: no file has a public link.
		search.links = [];
		act(() => notify_sorted());
		rerender();
		expect(result.current.searchServerTargetKeys.get("file.link:public")).toEqual(new Set());
		expect(result.current.isSearchLoading).toBe(false);
		expect(result.current.isSearchFailed).toBe(false);
	});

	test("treats a refused or failed link list as unknown, not as empty", () => {
		search.links = null;
		const refused = render_search("!file.link:public");
		expect(refused.result.current.searchServerTargetKeys.get("!file.link:public")).toBeNull();
		expect(refused.result.current.isSearchLoading).toBe(false);
		expect(refused.result.current.isSearchFailed).toBe(true);
		cleanup();

		search.links = new Error("failed");
		const failed = render_search("file.link:public");
		expect(failed.result.current.searchServerTargetKeys.get("file.link:public")).toBeNull();
		expect(failed.result.current.isSearchFailed).toBe(true);
	});
});
