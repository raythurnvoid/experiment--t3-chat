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

// `sorted.rows` holds every row of each stream, keyed by its full folder, sort and stream scope.
// `paginatedArgsSeen` records the args of every active paginated query.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one stream loading.
// `pages` gives a stream fixed server pages instead of `rows`. `splitting` keeps a stream past its first
// page in "LoadingMore", like a page that answered SplitRequired. `loadMoreCalls` counts each stream's calls.
// `search` answers the search box queries: `undefined` is loading.
const { cursorsSeen, paginatedArgsSeen, keysSeen, matchesSeen, enumsSeen, sorted, search } = vi.hoisted(() => ({
	cursorsSeen: [] as string[],
	paginatedArgsSeen: [] as SortedArgs[],
	keysSeen: [] as Array<Record<string, unknown>>,
	matchesSeen: [] as Array<Record<string, unknown>>,
	enumsSeen: [] as Array<Record<string, unknown>>,
	sorted: {
		rows: new Map<string, SortedRow[]>(),
		sideRows: undefined as SideRows | undefined,
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
		pages: new Map<string, SortedRow[][]>(),
		splitting: new Set<string>(),
		loadMoreCalls: new Map<string, number>(),
		sideScopes: new Map<string, SideRows | Error | undefined>(),
		matches: new Map<string, { matches: boolean } | Error | null | undefined>(),
		keys: new Map<string, files_sort_RowKey | Error | null | undefined>(),
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
	restricted: boolean;
	sort: files_sort_Sort;
	filter: files_table_Filter | null;
	namePrefix: string | null;
};

const sorted_key = (args: SortedArgs) =>
	JSON.stringify([
		args.membershipId,
		args.parentId,
		args.kind,
		args.segment,
		args.restricted,
		args.sort,
		args.filter,
		args.namePrefix,
	]);
const sorted_fixture_key = (args: {
	kind: "folder" | "file";
	segment: "value" | "missing";
	field: string;
	direction: "asc" | "desc";
	restricted?: boolean;
	folderId?: typeof FOLDER_ID;
	filter?: files_table_Filter | null;
	namePrefix?: string | null;
}) => {
	const {
		direction,
		field,
		kind,
		segment,
		restricted = false,
		folderId = FOLDER_ID,
		filter = null,
		namePrefix = null,
	} = args;

	return sorted_key({
		membershipId: MEMBERSHIP_ID,
		parentId: folderId,
		kind,
		segment,
		restricted,
		sort: [{ field, direction }],
		filter,
		namePrefix,
	});
};
const notify_sorted = () => {
	sorted.revision++;
	for (const listener of sorted.listeners) listener();
};
const match_key = (args: {
	filter: files_table_Filter;
	target: SideRow["target"];
	namePrefix?: string | null;
	membershipId?: Id<"organizations_workspaces_users">;
	parentId?: Id<"files_nodes">;
}) => {
	const { filter, target, namePrefix = null, membershipId = MEMBERSHIP_ID, parentId = FOLDER_ID } = args;

	return JSON.stringify([membershipId, parentId, target, filter, namePrefix]);
};

// Answer each query at once from the fixtures.
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
									namePrefix: string | null;
								};
								matchesSeen.push(request.args);
								return [
									key,
									sorted.matches.get(
										match_key({
											filter: args.filter,
											target: args.target,
											namePrefix: args.namePrefix,
											membershipId: args.membershipId,
											parentId: args.parentId,
										}),
									),
								];
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
			if (args !== "skip") paginatedArgsSeen.push(args);
			const [loaded, setLoaded] = useState({ key, numItems: options.initialNumItems, pageCount: 1 });
			const numItems = loaded.key === key ? loaded.numItems : options.initialNumItems;
			const pageCount = loaded.key === key ? loaded.pageCount : 1;
			if (args === "skip" || sorted.loadingFields.has(args.sort[0].field) || sorted.loadingKeys.has(key)) {
				return { results: [], status: "LoadingFirstPage", loadMore: () => {} };
			}

			const countLoadMore = () => sorted.loadMoreCalls.set(key, (sorted.loadMoreCalls.get(key) ?? 0) + 1);
			const loadMore = (more: number) => {
				countLoadMore();
				setLoaded({ key, numItems: numItems + more, pageCount: pageCount + 1 });
			};
			const pages = sorted.pages.get(key);
			if (pages) {
				// Convex keeps the pages before a split page and reports "LoadingMore" until the split ends.
				// It ignores loadMore then.
				if (pageCount > 1 && sorted.splitting.has(key)) {
					return { results: pages.slice(0, pageCount - 1).flat(), status: "LoadingMore", loadMore: countLoadMore };
				}
				return {
					results: pages.slice(0, pageCount).flat(),
					status: pageCount >= pages.length ? "Exhausted" : "CanLoadMore",
					loadMore,
				};
			}

			// A stream with no fixture is empty and done, like the restricted stream of a member.
			const rows = sorted.rows.get(key) ?? [];
			return {
				results: rows.slice(0, numItems),
				status: numItems >= rows.length ? "Exhausted" : "CanLoadMore",
				loadMore,
			};
		},
	};
});

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const FOLDER_ID = "folder_1" as app_convex_Id<"files_nodes">;
const NAME_ASC: files_sort_Sort = [{ field: "name", direction: "asc" }];
const NAME_FILTER: files_table_Filter = { kind: "name", field: "name", op: "starts_with", value: "match" };

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

const saved_row = (args: { kind: "file" | "folder"; name: string; part?: files_sort_Key | null }) => {
	const { kind, name, part = [name] } = args;

	return {
		_id: `node_${name}` as app_convex_Id<"files_nodes">,
		_creationTime: 2,
		name,
		kind,
		updatedAt: 1,
		contentByteSize: kind === "file" ? 42 : null,
		updatedBy: "user_1" as app_convex_Id<"users">,
		contentType: kind === "file" ? "text/markdown" : null,
		sortKey: row_key(name, part),
	} as SortedRow;
};

// A restricted child shared with this member.
const side_row = (name: string, kind: "file" | "folder" = "file"): SideRow =>
	({
		target: { kind: "saved", id: `shared_${name}` as app_convex_Id<"files_nodes"> },
		name,
		kind,
		createdAt: 1,
		updatedAt: 1,
		contentByteSize: kind === "file" ? 7 : null,
		updatedBy: "user_1" as app_convex_Id<"users">,
		contentType: kind === "file" ? "text/markdown" : null,
		treeRow: { _id: `shared_${name}` },
	}) as SideRow;

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}.md`);

beforeEach(() => {
	cursorsSeen.length = 0;
	paginatedArgsSeen.length = 0;
	sorted.rows.clear();
	sorted.sideRows = { rows: [], tooManyShared: false } as SideRows;
	sorted.loadingFields.clear();
	sorted.loadingKeys.clear();
	sorted.pages.clear();
	sorted.splitting.clear();
	sorted.loadMoreCalls.clear();
	sorted.sideScopes.clear();
	sorted.matches.clear();
	sorted.keys.clear();
	keysSeen.length = 0;
	matchesSeen.length = 0;
	enumsSeen.length = 0;
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
				useFilesSortedChildren({
					membershipId: MEMBERSHIP_ID,
					folderId: FOLDER_ID,
					sort: props.sort,
					filter: null,
					namePrefix: null,
				}),
			{ initialProps: { sort } },
		);
	const render_filtered = (sort = NAME_ASC, filter: files_table_Filter | null = NAME_FILTER, namePrefix: string | null = null) =>
		renderHook(
			(props: {
				membershipId: typeof MEMBERSHIP_ID;
				folderId: typeof FOLDER_ID;
				sort: files_sort_Sort;
				filter: files_table_Filter | null;
				namePrefix: string | null;
			}) => useFilesSortedChildren(props),
			{
				initialProps: {
					membershipId: MEMBERSHIP_ID,
					folderId: FOLDER_ID,
					sort,
					filter: filter as files_table_Filter | null,
					namePrefix,
				},
			},
		);

	test("puts folders first and holds a shared row until the loaded rows reach it", () => {
		sorted.rows.set(sorted_fixture_key({ kind: "folder", segment: "value", field: "name", direction: "asc" }), [
			saved_row({ kind: "folder", name: "docs" }),
		]);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			file_names(150).map((name) => saved_row({ kind: "file", name })),
		);
		sorted.sideRows = { rows: [side_row("file-005b.md"), side_row("zz.md")], tooManyShared: false } as SideRows;
		const { result } = render_sorted(NAME_ASC);
		expect(result.current.sideTargets).toEqual(sorted.sideRows!.rows.map((row) => row.target));

		const firstPage = file_names(100);
		firstPage.splice(firstPage.indexOf("file-005.md") + 1, 0, "file-005b.md");
		expect(result.current.rows?.map((row) => row.name)).toEqual(["docs", ...firstPage]);
		expect(result.current.rows?.find((row) => row.name === "file-000.md")).toMatchObject({
			createdAt: 2,
			contentByteSize: 42,
		});
		expect(result.current).toMatchObject({ isBusy: false, isDone: false, isFailed: false });

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([
			"docs",
			...firstPage,
			...file_names(150).slice(100),
			"zz.md",
		]);
		expect(result.current.isDone).toBe(true);
	});

	test("merges an owner's restricted rows spread by name, two pages per stream, with no repeat or gap", () => {
		const open = file_names(150, "b");
		const restricted = [...file_names(75, "a"), ...file_names(75, "c")];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			open.map((name) => saved_row({ kind: "file", name })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", restricted: true }),
			restricted.map((name) => saved_row({ kind: "file", name })),
		);
		const all = [...open, ...restricted].sort();
		const shown: string[][] = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: null,
				namePrefix: null,
			});
			if (children.rows) shown.push(children.rows.map((row) => row.name));
			return children;
		});

		// The first pages end at b-099 and at c-024. The rows past b-099 must wait for the next open page.
		expect(result.current.rows?.map((row) => row.name)).toEqual(all.slice(0, 175));
		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual(all);
		expect(result.current.isDone).toBe(true);
		// Every list shown on the way is the start of the full order: no gap and no repeat.
		for (const names of shown) expect(names).toEqual(all.slice(0, names.length));
	});

	test("merges two streams in desc order with equal keys: ties keep the stream order, with no repeat or gap", () => {
		// file.created keeps equal-time ties, so rows of both streams share keys. 50 rows per time.
		const sort: files_sort_Sort = [{ field: "created", direction: "desc" }];
		const time = (index: number) => 100 - Math.floor(index / 50);
		const open = file_names(150, "o");
		const restricted = file_names(150, "r");
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "created", direction: "desc" }),
			open.map((name, index) => saved_row({ kind: "file", name, part: [time(index)] })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "created", direction: "desc", restricted: true }),
			restricted.map((name, index) => saved_row({ kind: "file", name, part: [time(index)] })),
		);
		// Newest first. On a tie the open stream comes first, because it ranks first.
		const all = [0, 1, 2].flatMap((block) => [
			...open.slice(block * 50, block * 50 + 50),
			...restricted.slice(block * 50, block * 50 + 50),
		]);
		const shown: string[][] = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort,
				filter: null,
				namePrefix: null,
			});
			if (children.rows) shown.push(children.rows.map((row) => row.name));
			return children;
		});

		// Both first pages end on time 99. The restricted rows of time 99 wait: the next open page could
		// still hold open rows of time 99, which come first.
		expect(result.current.rows?.map((row) => row.name)).toEqual(all.slice(0, 150));
		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual(all);
		expect(result.current.isDone).toBe(true);
		for (const names of shown) expect(names).toEqual(all.slice(0, names.length));
	});

	test("keeps loading a stream whose pages are empty but not done, and still fills the page", () => {
		// The restricted stream's first two pages are empty, like pages left empty by access checks. Its
		// rows sort first, so no open row may show before them.
		const open = file_names(150, "b");
		const restricted = file_names(30, "a");
		sorted.pages.set(sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }), [
			open.slice(0, 100).map((name) => saved_row({ kind: "file", name })),
			open.slice(100).map((name) => saved_row({ kind: "file", name })),
		]);
		const restrictedKey = sorted_fixture_key({
			kind: "file",
			segment: "value",
			field: "name",
			direction: "asc",
			restricted: true,
		});
		sorted.pages.set(restrictedKey, [[], [], restricted.map((name) => saved_row({ kind: "file", name }))]);
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.rows?.map((row) => row.name)).toEqual([...restricted, ...open.slice(0, 100)]);
		expect(result.current.isBusy).toBe(false);
		// One call per empty page, and no more.
		expect(sorted.loadMoreCalls.get(restrictedKey)).toBe(2);
	});

	test("waits through a page split with no extra loads, then fills the page", () => {
		const fileKey = sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" });
		const names = file_names(150);
		sorted.pages.set(fileKey, [
			names.slice(0, 60).map((name) => saved_row({ kind: "file", name })),
			names.slice(60).map((name) => saved_row({ kind: "file", name })),
		]);
		// The second page answers SplitRequired, so Convex reports "LoadingMore" until the split ends.
		sorted.splitting.add(fileKey);
		const { result } = render_sorted(NAME_ASC);

		// The first 60 rows are fewer than a page, so the hook asks for the next page once and waits.
		expect(result.current.rows?.map((row) => row.name)).toEqual(names.slice(0, 60));
		expect(result.current.isBusy).toBe(true);
		expect(sorted.loadMoreCalls.get(fileKey)).toBe(1);

		act(() => {
			sorted.splitting.delete(fileKey);
			notify_sorted();
		});
		expect(result.current.rows?.map((row) => row.name)).toEqual(names);
		expect(result.current).toMatchObject({ isBusy: false, isDone: true });
		expect(sorted.loadMoreCalls.get(fileKey)).toBe(1);
	});

	test("shows no files while more folders can load", () => {
		sorted.rows.set(
			sorted_fixture_key({ kind: "folder", segment: "value", field: "name", direction: "asc" }),
			file_names(150, "folder").map((name) => saved_row({ kind: "folder", name })),
		);
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }), [
			saved_row({ kind: "file", name: "a.md" }),
		]);
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(100, "folder"));

		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(150, "folder"), "a.md"]);
	});

	test("keeps folders A to Z when sorting by size, because folders have no size", () => {
		sorted.rows.set(sorted_fixture_key({ kind: "folder", segment: "value", field: "size", direction: "desc" }), [
			saved_row({ kind: "folder", name: "a", part: null }),
			saved_row({ kind: "folder", name: "c", part: null }),
		]);
		sorted.rows.set(sorted_fixture_key({ kind: "file", segment: "value", field: "size", direction: "desc" }), [
			saved_row({ kind: "file", name: "big.md", part: [9, "big.md"] }),
		]);
		sorted.sideRows = { rows: [side_row("b", "folder")], tooManyShared: false } as SideRows;
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
			sorted_fixture_key({ kind: "file", segment: "value", field: "extension", direction: "asc" }),
			file_names(150).map((name) => saved_row({ kind: "file", name, part: ["md", name] })),
		);
		// No folder has a file.extension, so the folders' missing rows start at once. Keep that page loading.
		sorted.loadingKeys.add(
			sorted_fixture_key({ kind: "folder", segment: "missing", field: "extension", direction: "asc" }),
		);
		const { result, rerender } = render_sorted([{ field: "extension", direction: "asc" }]);
		expect(result.current.isBusy).toBe(true);

		act(() => result.current.loadMore());
		sorted.loadingKeys.clear();
		act(notify_sorted);
		rerender({ sort: [{ field: "extension", direction: "asc" }] });
		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(100));
		expect(result.current.isDone).toBe(false);
	});

	test("waits for a sort before it loads anything", () => {
		const { result } = render_sorted(null);

		expect(result.current).toMatchObject({ rows: undefined, isBusy: true, isDone: false });
	});

	test("reads no missing segment for a metadata sort and hides shared rows without the key", () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "asc" }];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "metadata.status", direction: "asc" }),
			[saved_row({ kind: "file", name: "a.md", part: ["open", "a.md"] })],
		);
		const withKey = side_row("b.md");
		const withoutKey = side_row("c.md");
		sorted.sideRows = { rows: [withKey, withoutKey], tooManyShared: false } as SideRows;
		for (const [draft, value] of [
			[withKey, "open"],
			[withoutKey, null],
		] as const)
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, draft.target, sort]),
				files_sort_key_of({
					sort,
					facts: { ...draft, extension: "md" },
					metadataParts: new Map([["metadata.status", value]]),
				}),
			);
		const { result } = render_sorted(sort);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		expect(result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.some((args) => args.segment === "missing")).toBe(false);
	});

	test("fails when the side rows refuse the folder", () => {
		sorted.sideRows = null;
		const { result } = render_sorted(NAME_ASC);

		expect(result.current.isFailed).toBe(true);
	});

	test("Retry drops a failed side query before subscribing again", () => {
		const scope = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID]);
		sorted.sideScopes.set(scope, new Error("side rows failed"));
		const renders: Array<{ isBusy: boolean; isFailed: boolean }> = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: null,
				namePrefix: null,
			});
			renders.push({ isBusy: children.isBusy, isFailed: children.isFailed });
			return children;
		});
		expect(result.current.isFailed).toBe(true);
		renders.length = 0;
		act(() => result.current.retry());
		expect(renders).toContainEqual({ isBusy: true, isFailed: false });
		act(() => {
			sorted.sideScopes.delete(scope);
			notify_sorted();
		});
		expect(result.current).toMatchObject({ isFailed: false, isDone: true });
	});

	test("a filter reads value segments with the name prefix and checks shared rows with it too", () => {
		const filter: files_table_Filter = { kind: "extension", field: "extension", op: "is", value: "md" };
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter, namePrefix: "re" }),
			[saved_row({ kind: "file", name: "report.md" })],
		);
		const matching = side_row("readme.md");
		const other = side_row("recipe.md");
		sorted.sideRows = { rows: [matching, other], tooManyShared: false } as SideRows;
		sorted.matches.set(match_key({ filter, target: matching.target, namePrefix: "re" }), { matches: true });
		sorted.matches.set(match_key({ filter, target: other.target, namePrefix: "re" }), { matches: false });
		const { result } = render_filtered(NAME_ASC, filter, "re");

		expect(result.current.rows?.map((row) => row.name)).toEqual(["readme.md", "report.md"]);
		expect(result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.every((args) => args.segment === "value" && args.namePrefix === "re")).toBe(true);
		expect(new Set(paginatedArgsSeen.map((args) => args.restricted))).toEqual(new Set([false, true]));
		expect(matchesSeen.every((args) => args.namePrefix === "re")).toBe(true);
	});

	test("holds the old filter label while applying and clears rows on a folder or membership change", () => {
		const nextFilter: files_table_Filter = { kind: "name", field: "name", op: "starts_with", value: "later" };
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter: NAME_FILTER }),
			file_names(5, "match").map((name) => saved_row({ kind: "file", name })),
		);
		sorted.loadingKeys.add(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter: nextFilter }),
		);
		const { result, rerender } = render_filtered();
		expect(result.current.rows).toHaveLength(5);
		rerender({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort: NAME_ASC, filter: nextFilter, namePrefix: null });
		expect(result.current.rowsFilter).toEqual(NAME_FILTER);
		expect(result.current.rows).toHaveLength(5);
		expect(result.current.isBusy).toBe(true);
		// The new folder is still loading, so nothing of the old folder may show.
		sorted.loadingFields.add("name");
		rerender({
			membershipId: MEMBERSHIP_ID,
			folderId: "folder_2" as typeof FOLDER_ID,
			sort: NAME_ASC,
			filter: nextFilter,
			namePrefix: null,
		});
		expect(result.current.rows).toBeUndefined();
	});

	test("holds the old name prefix while only the prefix changes", () => {
		const filter: files_table_Filter = { kind: "extension", field: "extension", op: "is", value: "md" };
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter, namePrefix: "re" }),
			[saved_row({ kind: "file", name: "report.md" })],
		);
		sorted.loadingKeys.add(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter, namePrefix: "rep" }),
		);
		const { result, rerender } = render_filtered(NAME_ASC, filter, "re");
		expect(result.current.rowsNamePrefix).toBe("re");

		rerender({ membershipId: MEMBERSHIP_ID, folderId: FOLDER_ID, sort: NAME_ASC, filter, namePrefix: "rep" });
		// The filter and the sort did not change, so only the prefix tells the table these rows are held.
		expect(result.current).toMatchObject({ rowsFilter: filter, rowsSort: NAME_ASC, rowsNamePrefix: "re", isBusy: true });
		expect(result.current.rows?.map((row) => row.name)).toEqual(["report.md"]);
	});

	test("prunes a refused shared row from held rows", () => {
		const shared = side_row("a-match.md");
		sorted.sideRows = { rows: [shared], tooManyShared: false } as SideRows;
		sorted.matches.set(match_key({ filter: NAME_FILTER, target: shared.target }), { matches: true });
		const pageKey = sorted_fixture_key({
			kind: "file",
			segment: "value",
			field: "name",
			direction: "asc",
			filter: NAME_FILTER,
		});
		sorted.rows.set(
			pageKey,
			file_names(4, "match").map((name) => saved_row({ kind: "file", name })),
		);
		const { result } = render_filtered();
		expect(result.current.rows).toHaveLength(5);
		act(() => {
			sorted.loadingKeys.add(pageKey);
			sorted.matches.set(match_key({ filter: NAME_FILTER, target: shared.target }), null);
			notify_sorted();
		});
		expect(result.current.isBusy).toBe(true);
		expect(result.current.rows?.some((row) => row.target.id === shared.target.id)).toBe(false);
		expect(result.current.sideTargets).toEqual([shared.target]);
	});

	test("asks one key for every metadata shared row and waits for the last one", () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "desc" }];
		const shared = file_names(40).map((name) => side_row(name));
		sorted.sideRows = { rows: shared, tooManyShared: false } as SideRows;
		for (const [index, row] of shared.slice(0, -1).entries())
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, row.target, sort]),
				files_sort_key_of({
					sort,
					facts: { ...row, extension: "md" },
					metadataParts: new Map([["metadata.status", String(100 + index)]]),
				}),
			);
		const { result } = render_sorted(sort);
		expect(keysSeen).toHaveLength(40);
		expect(result.current.rows).toBeUndefined();
		const last = shared.at(-1)!;
		act(() => {
			sorted.keys.set(
				JSON.stringify([MEMBERSHIP_ID, FOLDER_ID, last.target, sort]),
				files_sort_key_of({
					sort,
					facts: { ...last, extension: "md" },
					metadataParts: new Map([["metadata.status", "999"]]),
				}),
			);
			notify_sorted();
		});
		expect(result.current.isBusy).toBe(false);
		expect(result.current.rows?.map((row) => row.name)).toEqual([...file_names(40)].reverse());
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
