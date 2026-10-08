import { act, cleanup, renderHook } from "@testing-library/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_api, app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_sort_text_key,
	type files_sort_Key,
	type files_sort_RowKey,
	type files_sort_Sort,
} from "../../shared/files-sort.ts";
import type { files_table_Filter } from "../../shared/files-table.ts";
import { useFilesSearchSaved, useFilesSortedChildren } from "./files-search-hooks.ts";

type SortedPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;
type SortedRow = SortedPage["page"][number];
type HasShared = FunctionReturnType<typeof app_convex_api.files_nodes.has_tree_children_shared>;
type SavedArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_saved>;
type SavedRow = FunctionReturnType<typeof app_convex_api.files_nodes.search_saved>["page"][number];

// `sorted.rows` holds every row of each stream, keyed by its full folder, sort and stream scope.
// `paginatedArgsSeen` records the args of every active paginated query.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one stream loading.
// `pages` gives a stream fixed server pages instead of `rows`. `splitting` keeps a stream past its first
// page in "LoadingMore", like a page that answered SplitRequired. `loadMoreCalls` counts each stream's calls.
// `hasShared` answers `has_tree_children_shared`, and `hasSharedByScope` answers it for one folder scope.
// `saved` answers `search_saved` by clause: `argsSeen` records its args, and a clause with no
// answer is empty and done.
const { paginatedArgsSeen, sorted, saved } = vi.hoisted(() => ({
	paginatedArgsSeen: [] as SortedArgs[],
	sorted: {
		rows: new Map<string, SortedRow[]>(),
		hasShared: false as HasShared | Error | undefined,
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
		pages: new Map<string, SortedRow[][]>(),
		splitting: new Set<string>(),
		loadMoreCalls: new Map<string, number>(),
		hasSharedByScope: new Map<string, HasShared | Error | undefined>(),
		revision: 0,
		listeners: new Set<() => void>(),
	},
	saved: {
		argsSeen: [] as SavedArgs[],
		answers: new Map<
			string,
			{ results: SavedRow[]; status: "LoadingFirstPage" | "LoadingMore" | "CanLoadMore" | "Exhausted" }
		>(),
	},
}));

// The args of a `list_tree_children_sorted` stream (`restricted`) or of a `list_tree_children_shared`
// stream (`principalIndex`).
type SortedArgs = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	parentId: app_convex_Id<"files_nodes"> | "root";
	kind: "file" | "folder";
	segment: "value" | "missing";
	restricted?: boolean;
	principalIndex?: 0 | 1 | 2;
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
		args.restricted ?? null,
		args.principalIndex ?? null,
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
	principalIndex?: 0 | 1 | 2;
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
		principalIndex,
		folderId = FOLDER_ID,
		filter = null,
		namePrefix = null,
	} = args;

	return sorted_key({
		membershipId: MEMBERSHIP_ID,
		parentId: folderId,
		kind,
		segment,
		...(principalIndex === undefined ? { restricted } : { principalIndex }),
		sort: [{ field, direction }],
		filter,
		namePrefix,
	});
};
const notify_sorted = () => {
	sorted.revision++;
	for (const listener of sorted.listeners) listener();
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
							// Only `has_tree_children_shared` goes through `useQueries` here.
							const scope = JSON.stringify([request.args.membershipId, request.args.parentId]);
							return [key, sorted.hasSharedByScope.has(scope) ? sorted.hasSharedByScope.get(scope) : sorted.hasShared];
						}),
					),
				[queries, revision],
			);
		},
		usePaginatedQuery: (
			query: FunctionReference<"query">,
			args: SortedArgs | "skip",
			options: { initialNumItems: number },
		) => {
			useSyncExternalStore(subscribe, () => sorted.revision);
			const isSaved = getFunctionName(query) === "files_nodes:search_saved";
			const key = args === "skip" ? "skip" : sorted_key(args);
			if (args !== "skip" && !isSaved) paginatedArgsSeen.push(args);
			const [loaded, setLoaded] = useState({ key, numItems: options.initialNumItems, pageCount: 1 });
			if (args !== "skip" && isSaved) {
				const savedArgs = args as unknown as SavedArgs;
				saved.argsSeen.push(savedArgs);
				return {
					...(saved.answers.get(JSON.stringify(savedArgs.clause)) ?? { results: [], status: "Exhausted" }),
					loadMore: () => {},
				};
			}
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

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}.md`);

beforeEach(() => {
	paginatedArgsSeen.length = 0;
	sorted.rows.clear();
	sorted.hasShared = false;
	sorted.loadingFields.clear();
	sorted.loadingKeys.clear();
	sorted.pages.clear();
	sorted.splitting.clear();
	sorted.loadMoreCalls.clear();
	sorted.hasSharedByScope.clear();
	saved.argsSeen.length = 0;
	saved.answers.clear();
});

afterEach(() => {
	cleanup();
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
					isOwner: null,
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
			}) => useFilesSortedChildren({ ...props, isOwner: null }),
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
		const shared = [saved_row({ kind: "file", name: "file-005b.md" }), saved_row({ kind: "file", name: "zz.md" })];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", principalIndex: 0 }),
			shared,
		);
		const { result } = render_sorted(NAME_ASC);

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
				isOwner: null,
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
				isOwner: null,
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

	test("merges a member's share streams by page and shows a node shared to them and to their role once", () => {
		const open = file_names(150, "b");
		const shared = [...file_names(75, "a"), ...file_names(75, "c")];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			open.map((name) => saved_row({ kind: "file", name })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", principalIndex: 0 }),
			shared.map((name) => saved_row({ kind: "file", name })),
		);
		// The role shares the first 10 nodes too: the same nodes, in a second stream.
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", principalIndex: 1 }),
			shared.slice(0, 10).map((name) => saved_row({ kind: "file", name })),
		);
		const all = [...open, ...shared].sort();
		const shown: string[][] = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: null,
				namePrefix: null,
				isOwner: null,
			});
			if (children.rows) shown.push(children.rows.map((row) => row.name));
			return children;
		});

		// The first pages end at b-099 and at c-024. The rows past b-099 must wait for the next open page.
		expect(result.current.rows?.map((row) => row.name)).toEqual(all.slice(0, 175));
		act(() => result.current.loadMore());
		expect(result.current.rows?.map((row) => row.name)).toEqual(all);
		expect(result.current.isDone).toBe(true);
		for (const names of shown) expect(names).toEqual(all.slice(0, names.length));
		// Every share stream reads the table's sort.
		expect(
			new Set(paginatedArgsSeen.filter((args) => args.principalIndex !== undefined).map((args) => args.principalIndex)),
		).toEqual(new Set([0, 1, 2]));
	});

	test("reads a member's share streams in the missing segment of an extension sort", () => {
		const sort: files_sort_Sort = [{ field: "extension", direction: "asc" }];
		const fixture = (kind: "file" | "folder", segment: "value" | "missing", principalIndex?: 0) =>
			sorted_fixture_key({ kind, segment, field: "extension", direction: "asc", principalIndex });
		sorted.rows.set(fixture("folder", "missing"), [saved_row({ kind: "folder", name: "docs", part: null })]);
		sorted.rows.set(fixture("folder", "missing", 0), [saved_row({ kind: "folder", name: "beta", part: null })]);
		sorted.rows.set(fixture("file", "value"), [saved_row({ kind: "file", name: "a.md", part: ["md", "a.md"] })]);
		sorted.rows.set(fixture("file", "value", 0), [saved_row({ kind: "file", name: "b.txt", part: ["txt", "b.txt"] })]);
		sorted.rows.set(fixture("file", "missing"), [saved_row({ kind: "file", name: "c", part: null })]);
		sorted.rows.set(fixture("file", "missing", 0), [saved_row({ kind: "file", name: "a-plain", part: null })]);
		const { result } = render_sorted(sort);

		// Folders have no extension, so they all sit in the missing segment, by name.
		expect(result.current.rows?.map((row) => row.name)).toEqual(["beta", "docs", "a.md", "b.txt", "a-plain", "c"]);
		expect(result.current.isDone).toBe(true);
		expect(
			paginatedArgsSeen.some((args) => args.kind === "file" && args.segment === "missing" && args.principalIndex === 0),
		).toBe(true);
	});

	test("merges a member's share stream in a desc sort", () => {
		const sort: files_sort_Sort = [{ field: "name", direction: "desc" }];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "desc" }),
			["d.md", "b.md"].map((name) => saved_row({ kind: "file", name })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "desc", principalIndex: 0 }),
			["e.md", "c.md", "a.md"].map((name) => saved_row({ kind: "file", name })),
		);
		const { result } = render_sorted(sort);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["e.md", "d.md", "c.md", "b.md", "a.md"]);
		expect(result.current.isDone).toBe(true);
	});

	test("once the role is known, reads no share stream for the owner and no restricted twin for a member", () => {
		const fixture = (args: { restricted?: boolean; principalIndex?: 0 }) =>
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", ...args });
		sorted.rows.set(fixture({}), [saved_row({ kind: "file", name: "b.md" })]);
		sorted.rows.set(fixture({ restricted: true }), [saved_row({ kind: "file", name: "a.md" })]);
		sorted.rows.set(fixture({ principalIndex: 0 }), [saved_row({ kind: "file", name: "c.md" })]);
		const render_as = (isOwner: boolean) =>
			renderHook(() =>
				useFilesSortedChildren({
					membershipId: MEMBERSHIP_ID,
					folderId: FOLDER_ID,
					sort: NAME_ASC,
					filter: null,
					namePrefix: null,
					isOwner,
				}),
			);

		const owner = render_as(true);
		expect(owner.result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		expect(owner.result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
		cleanup();

		paginatedArgsSeen.length = 0;
		const member = render_as(false);
		expect(member.result.current.rows?.map((row) => row.name)).toEqual(["b.md", "c.md"]);
		expect(member.result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.some((args) => args.restricted === true)).toBe(false);
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
		sorted.rows.set(
			sorted_fixture_key({ kind: "folder", segment: "value", field: "size", direction: "desc", principalIndex: 0 }),
			[saved_row({ kind: "folder", name: "b", part: null })],
		);
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

	test("a metadata sort reads no missing segment and no share stream, and names the key that hides the shares", () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "asc" }];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "metadata.status", direction: "asc" }),
			[saved_row({ kind: "file", name: "a.md", part: ["open", "a.md"] })],
		);
		sorted.hasShared = true;
		const { result } = render_sorted(sort);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md"]);
		expect(result.current).toMatchObject({ isDone: true, hiddenSharedKey: "metadata.status" });
		expect(paginatedArgsSeen.some((args) => args.segment === "missing")).toBe(false);
		expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
	});

	test("a metadata is filter reads the name order but no share stream, and names its key", () => {
		const filter: files_table_Filter = { kind: "text", field: "metadata.status", op: "is", value: "open" };
		sorted.hasShared = true;
		const { result } = render_filtered(NAME_ASC, filter);

		expect(result.current).toMatchObject({ isDone: true, hiddenSharedKey: "metadata.status" });
		expect(paginatedArgsSeen.length).toBeGreaterThan(0);
		expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
	});

	test("names no hidden key when the member has no share here or the sort is built in", () => {
		sorted.hasShared = false;
		const metadata = render_sorted([{ field: "metadata.status", direction: "asc" }]);
		expect(metadata.result.current.hiddenSharedKey).toBeNull();
		cleanup();

		sorted.hasShared = true;
		const byName = render_sorted(NAME_ASC);
		expect(byName.result.current.hiddenSharedKey).toBeNull();
	});

	test("fails when has_tree_children_shared refuses the folder", () => {
		sorted.hasShared = null;
		const { result } = render_sorted(NAME_ASC);

		expect(result.current).toMatchObject({ rows: undefined, isFailed: true, isFolderRefused: true });
	});

	test("Retry drops a failed has_tree_children_shared query before subscribing again", () => {
		const scope = JSON.stringify([MEMBERSHIP_ID, FOLDER_ID]);
		sorted.hasSharedByScope.set(scope, new Error("has_tree_children_shared failed"));
		const renders: Array<{ isBusy: boolean; isFailed: boolean }> = [];
		const { result } = renderHook(() => {
			const children = useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter: null,
				namePrefix: null,
				isOwner: null,
			});
			renders.push({ isBusy: children.isBusy, isFailed: children.isFailed });
			return children;
		});
		expect(result.current.isFailed).toBe(true);
		renders.length = 0;
		act(() => result.current.retry());
		expect(renders).toContainEqual({ isBusy: true, isFailed: false });
		act(() => {
			sorted.hasSharedByScope.delete(scope);
			notify_sorted();
		});
		expect(result.current).toMatchObject({ isFailed: false, isDone: true });
	});

	test("a filter reads value segments with the name prefix, the share streams too", () => {
		const filter: files_table_Filter = { kind: "extension", field: "extension", op: "is", value: "md" };
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", filter, namePrefix: "re" }),
			[saved_row({ kind: "file", name: "report.md" })],
		);
		sorted.rows.set(
			sorted_fixture_key({
				kind: "file",
				segment: "value",
				field: "name",
				direction: "asc",
				filter,
				namePrefix: "re",
				principalIndex: 0,
			}),
			[saved_row({ kind: "file", name: "readme.md" })],
		);
		const { result } = render_filtered(NAME_ASC, filter, "re");

		expect(result.current.rows?.map((row) => row.name)).toEqual(["readme.md", "report.md"]);
		expect(result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.every((args) => args.segment === "value" && args.namePrefix === "re")).toBe(true);
		expect(new Set(paginatedArgsSeen.map((args) => args.restricted ?? args.principalIndex))).toEqual(
			new Set([false, true, 0, 1, 2]),
		);
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
});

describe("useFilesSearchSaved", () => {
	const render_search = (searchQuery: string, withContents = true) =>
		renderHook(() => useFilesSearchSaved({ membershipId: MEMBERSHIP_ID, searchQuery, withContents }));
	const saved_match = (path: string, extra: Record<string, unknown> = {}) =>
		({ kind: "file", nodeId: `node_${path}`, path, ...extra }) as SavedRow;

	test("plain text asks for names and contents in two lists", () => {
		saved.answers.set(JSON.stringify({ kind: "name", text: "readme" }), {
			results: [saved_match("/a/readme.md")],
			status: "CanLoadMore",
		});
		saved.answers.set(JSON.stringify({ kind: "content", text: "README.md" }), {
			results: [
				saved_match("/b/notes.md", { textChunk: "see README.md", lineStart: 3 }),
				saved_match("/b/notes.md", { textChunk: "README.md again", lineStart: 9 }),
			],
			status: "Exhausted",
		});
		const { result } = render_search("README.md");

		expect(saved.argsSeen.map((args) => args.clause)).toEqual([
			{ kind: "name", text: "readme" },
			{ kind: "content", text: "README.md" },
		]);
		expect(result.current).toMatchObject({ mode: "search", isExact: false });
		expect(result.current.names).toMatchObject({
			rows: [{ path: "/a/readme.md" }],
			status: "more",
			isLoadingMore: false,
			problem: null,
		});
		// A file shows once in the contents list, with its first chunk.
		expect(result.current.contents).toMatchObject({
			rows: [{ path: "/b/notes.md", lineStart: 3 }],
			status: "done",
		});
	});

	test("a folder scopes names, blocks contents, and shows the folder problem", () => {
		saved.answers.set(JSON.stringify({ kind: "name", text: "plan" }), {
			results: [{ kind: "problem", message: "Folder not found" }],
			status: "Exhausted",
		});
		const { result } = render_search("file.path:/docs plan");

		expect(saved.argsSeen).toEqual([
			{ membershipId: MEMBERSHIP_ID, clause: { kind: "name", text: "plan" }, folderPath: "/docs" },
		]);
		expect(result.current.contents).toBe("folder");
		expect(result.current.names).toMatchObject({ rows: [], status: "done", problem: "Folder not found" });
		// The sidebar asks for no contents list.
		expect(render_search("plan", false).result.current.contents).toBeNull();
	});

	test("a path or id asks for that node with no folder", () => {
		const { result } = render_search("file.path:/docs /Notes/a.md");

		expect(saved.argsSeen).toEqual([{ membershipId: MEMBERSHIP_ID, clause: { kind: "path", path: "/Notes/a.md" } }]);
		expect(result.current.isExact).toBe(true);
		expect(result.current.contents).toBeNull();
	});

	test("a metadata chip merges its plans into one list", () => {
		const { result } = render_search("file.path:/docs metadata.count:3");

		expect(saved.argsSeen.map((args) => [args.clause.kind, args.folderPath])).toEqual([
			["metadata", "/docs"],
			["metadata", "/docs"],
		]);
		expect(result.current.contents).toBeNull();
		expect(result.current.names.status).toBe("done");
	});

	test("a draft link and an invalid filter ask for nothing", () => {
		expect(render_search("http://localhost/w/org/ws/files?pendingNodeId=draft_1").result.current).toMatchObject({
			mode: "draft",
		});
		expect(render_search("metadata.:x").result.current.mode).toBe("invalid");
		expect(saved.argsSeen).toEqual([]);
	});

	test("a finished list at the index limit says it shows the top matches", () => {
		saved.answers.set(JSON.stringify({ kind: "name", text: "log" }), {
			results: Array.from({ length: 1024 }, (_, index) => saved_match(`/logs/log-${index}.txt`)),
			status: "Exhausted",
		});

		expect(render_search("log").result.current.names.isTopMatches).toBe(true);
	});

	test("a metadata list has no index limit, so it never says it shows the top matches", () => {
		saved.answers.set(
			JSON.stringify({ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.status", value: "open" } }),
			{
				results: Array.from({ length: 1024 }, (_, index) => saved_match(`/tasks/task-${index}.md`)),
				status: "Exhausted",
			},
		);

		expect(render_search("metadata.status:open").result.current.names).toMatchObject({
			status: "done",
			isTopMatches: false,
		});
	});

	test("a list says when its next page is loading", () => {
		saved.answers.set(JSON.stringify({ kind: "name", text: "plan" }), {
			results: [saved_match("/plan.md")],
			status: "LoadingMore",
		});

		expect(render_search("plan").result.current.names).toMatchObject({ status: "more", isLoadingMore: true });
	});

	test("a date in a folder asks for the typed text only and says so", () => {
		const { result } = render_search("file.path:/docs metadata.due:2026-09-04");

		// A folder cannot scope the range plan that finds dates stored with a time.
		expect(saved.argsSeen.map((args) => [args.clause, args.folderPath])).toEqual([
			[{ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.due", value: "2026-09-04" } }, "/docs"],
		]);
		expect(result.current.isFolderDate).toBe(true);

		saved.argsSeen.length = 0;
		expect(render_search("metadata.due:2026-09-04").result.current.isFolderDate).toBe(false);
		expect(saved.argsSeen.map((args) => args.clause.kind === "metadata" && args.clause.plan.op)).toEqual([
			"eq",
			"range",
		]);
	});

	test("the root folder scopes nothing, so a range and a date run in full", () => {
		const range = render_search("file.path:/ metadata.priority:>2").result.current;
		const date = render_search("file.path:/ metadata.due:2026-09-04").result.current;

		expect(range.mode).toBe("search");
		expect(date.isFolderDate).toBe(false);
		expect(saved.argsSeen.map((args) => args.clause.kind === "metadata" && args.clause.plan.op)).toEqual([
			"range",
			"eq",
			"range",
		]);
	});
});
