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
import type { files_DirectoryView } from "../../shared/files.ts";
import { useFilesSearchSaved, useFilesSortedChildren } from "./files-search-hooks.ts";

type SortedPage = FunctionReturnType<typeof app_convex_api.files_tree.list_tree_children_sorted>;
type SortedRow = SortedPage["page"][number];
type SavedArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_saved>;
type SavedRow = FunctionReturnType<typeof app_convex_api.files_nodes.search_saved>["page"][number];
type MetadataArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_saved_metadata>;

// `sorted.rows` holds every row of each stream, keyed by its full folder, sort and stream scope.
// `paginatedArgsSeen` records the args of every active paginated query.
// `loadingFields` keeps every query of a sort loading. `loadingKeys` keeps one stream loading.
// `pages` gives a stream fixed server pages instead of `rows`. `splitting` keeps a stream past its first
// page in "LoadingMore", like a page that answered SplitRequired. `loadMoreCalls` counts each stream's calls.
// `saved` answers `search_saved` by clause: `argsSeen` records its args, and a clause with no
// answer is empty and done. `search_saved_metadata` answers by `{ kind: "metadata", plan }` with all
// its rows at once ("CanLoadMore" adds a next page), and `metadataArgsSeen` records its args.
// `metadataFails` makes its first page or its next pages fail.
const { paginatedArgsSeen, sorted, saved } = vi.hoisted(() => ({
	paginatedArgsSeen: [] as SortedArgs[],
	sorted: {
		view: { cohortId: null, view: null, generation: 0, searchGeneration: 0 } as
			FunctionReturnType<typeof app_convex_api.files_tree.get_workspace_move_view> | undefined,
		rows: new Map<string, SortedRow[]>(),
		loadingFields: new Set<string>(),
		loadingKeys: new Set<string>(),
		pages: new Map<string, SortedRow[][]>(),
		splitting: new Set<string>(),
		loadMoreCalls: new Map<string, number>(),
		directoryViews: new Map<string, files_DirectoryView>(),
		revision: 0,
		listeners: new Set<() => void>(),
	},
	saved: {
		argsSeen: [] as SavedArgs[],
		metadataArgsSeen: [] as MetadataArgs[],
		metadataFails: null as "first" | "more" | null,
		answers: new Map<
			string,
			{ results: SavedRow[]; status: "LoadingFirstPage" | "LoadingMore" | "CanLoadMore" | "Exhausted" }
		>(),
	},
}));

// The args of a `list_tree_children_sorted` stream (`restricted`) or of a `list_tree_children_shared`
// stream (`principalIndex`).
type SortedArgs = {
	stream: "normal" | "cohort";
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

const sorted_key = (args: SortedArgs, directoryView: files_DirectoryView = null) =>
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
		args.stream,
		directoryView,
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
	stream?: "normal" | "cohort";
	directoryView?: files_DirectoryView;
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
		stream = "normal",
		directoryView = null,
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
		stream,
	}, directoryView);
};
const notify_sorted = () => {
	sorted.revision++;
	for (const listener of sorted.listeners) listener();
};

// This file tests stream merging with fixed pager results.
vi.mock("./files-paginated-query-hooks.ts", async () => {
	const { usePaginatedQuery } = await import("convex/react");
	return { useFilesPaginatedQuery: usePaginatedQuery };
});

// The cached hooks use the `convex/react` mock below.
vi.mock("@/hooks/convex-hooks.ts", async (importOriginal) => {
	const { useQueries, useQuery } = await import("convex/react");
	return {
		...(await importOriginal<typeof import("@/hooks/convex-hooks.ts")>()),
		useCachedQueries: useQueries,
		useCachedQuery: useQuery,
	};
});

// Answer each query at once from the fixtures.
vi.mock("convex/react", async (importOriginal) => {
	const { useState, useSyncExternalStore } = await import("react");
	const subscribe = (listener: () => void) => {
		sorted.listeners.add(listener);
		return () => sorted.listeners.delete(listener);
	};
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useQuery: () => {
			useSyncExternalStore(subscribe, () => sorted.revision);
			return sorted.view;
		},
		useConvex: () => ({
			action: async (_action: unknown, args: MetadataArgs) => {
				saved.metadataArgsSeen.push(args);
				if (saved.metadataFails === (args.cursor === null ? "first" : "more")) throw new Error("Server error");
				const answer = saved.answers.get(JSON.stringify({ kind: "metadata", plan: args.plan }));
				const more = args.cursor === null && answer?.status === "CanLoadMore";
				return { _yay: { page: answer?.results ?? [], cursor: more ? "next" : null, isDone: !more } };
			},
		}),
		usePaginatedQuery: (
			query: FunctionReference<"query">,
			args: SortedArgs | "skip",
			options: { initialNumItems: number },
		) => {
			useSyncExternalStore(subscribe, () => sorted.revision);
			const isSaved = getFunctionName(query) === "files_nodes:search_saved";
			const directoryView: files_DirectoryView = sorted.view?.cohortId ? { cohortId: sorted.view.cohortId, view: sorted.view.view! } : null;
			const key = args === "skip" ? "skip" : sorted_key(args, directoryView);
			const reportedView = sorted.directoryViews.has(key) ? sorted.directoryViews.get(key)! : directoryView;
			if (args !== "skip" && !isSaved) paginatedArgsSeen.push(args);
			const [loaded, setLoaded] = useState({ key, numItems: options.initialNumItems, pageCount: 1 });
			if (args !== "skip" && isSaved) {
				const savedArgs = args as unknown as SavedArgs;
				saved.argsSeen.push(savedArgs);
				return {
					...(saved.answers.get(JSON.stringify([savedArgs.clause, savedArgs.savedStream])) ??
						saved.answers.get(JSON.stringify(savedArgs.clause)) ?? { results: [], status: "Exhausted" }),
					loadMore: () => {},
				};
			}
			const numItems = loaded.key === key ? loaded.numItems : options.initialNumItems;
			const pageCount = loaded.key === key ? loaded.pageCount : 1;
			if (args === "skip" || sorted.loadingFields.has(args.sort[0].field) || sorted.loadingKeys.has(key)) {
				return { results: [], status: "LoadingFirstPage", directoryView: undefined, loadMore: () => {} };
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
					return { results: pages.slice(0, pageCount - 1).flat(), status: "LoadingMore", directoryView: undefined, loadMore: countLoadMore };
				}
				return {
					results: pages.slice(0, pageCount).flat(),
					status: pageCount >= pages.length ? "Exhausted" : "CanLoadMore",
					directoryView: reportedView,
					loadMore,
				};
			}

			// A stream with no fixture is empty and done, like the restricted stream of a member.
			const rows = sorted.rows.get(key) ?? [];
			return {
				results: rows.slice(0, numItems),
				status: numItems >= rows.length ? "Exhausted" : "CanLoadMore",
				directoryView: reportedView,
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

const locked_row = (args: { kind: "file" | "folder"; name: string; part?: files_sort_Key | null }) => {
	const { updatedBy: _updatedBy, ...row } = saved_row(args) as Extract<SortedRow, { locked: false }>;
	return { ...row, locked: true } as SortedRow;
};

const file_names = (count: number, prefix = "file") =>
	Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}.md`);

beforeEach(() => {
	paginatedArgsSeen.length = 0;
	sorted.view = { cohortId: null, view: null, generation: 0, searchGeneration: 0 };
	sorted.rows.clear();
	sorted.loadingFields.clear();
	sorted.loadingKeys.clear();
	sorted.pages.clear();
	sorted.splitting.clear();
	sorted.loadMoreCalls.clear();
	sorted.directoryViews.clear();
	saved.argsSeen.length = 0;
	saved.metadataArgsSeen.length = 0;
	saved.metadataFails = null;
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

	test("starts directory pages before the workspace Move view answers", () => {
		sorted.view = undefined;
		render_sorted(NAME_ASC);
		expect(paginatedArgsSeen.length, "directory pages do not wait for the workspace Move view").toBeGreaterThan(0);
	});

	test("merges matching directory views and holds rows until publication reaches every stream", () => {
		const cohortId = "cohort_1" as app_convex_Id<"files_move_cohorts">;
		sorted.view = { cohortId, view: "before", generation: 1, searchGeneration: 1 };
		const before = { cohortId, view: "before" } as const;
		const after = { cohortId, view: "after" } as const;
		const fixture = { kind: "file", segment: "value", field: "name", direction: "asc" } as const;
		sorted.rows.set(sorted_fixture_key({ ...fixture, directoryView: before }), [saved_row({ kind: "file", name: "b.md" })]);
		sorted.rows.set(sorted_fixture_key({ ...fixture, stream: "cohort", directoryView: before }), [saved_row({ kind: "file", name: "a.md" })]);
		const afterKey = sorted_fixture_key({ ...fixture, stream: "cohort", directoryView: after });
		sorted.rows.set(afterKey, [saved_row({ kind: "file", name: "c.md" })]);
		sorted.rows.set(sorted_fixture_key({ ...fixture, directoryView: after }), [saved_row({ kind: "file", name: "b.md" })]);
		const { result } = render_sorted(NAME_ASC);
		expect(result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
		act(() => {
			sorted.directoryViews.set(afterKey, before);
			sorted.view = { cohortId, view: "after", generation: 2, searchGeneration: 2 };
			notify_sorted();
		});
		expect(result.current.rows?.map((row) => row.name), "different directory views never form one table").toEqual(["a.md", "b.md"]);
		expect(result.current.isBusy).toBe(true);
		act(() => {
			sorted.directoryViews.clear();
			notify_sorted();
		});
		expect(result.current.rows?.map((row) => row.name)).toEqual(["b.md", "c.md"]);
	});

	test.each(["before", "after", "idle"] as const)("keeps Show more rows while a Move %s view refills", (view) => {
		const cohortId = "cohort_1" as app_convex_Id<"files_move_cohorts">;
		const initialView = view === "before" ? null : { cohortId, view: view === "after" ? "before" as const : "after" as const };
		const nextView = view === "idle" ? null : { cohortId, view };
		sorted.view = initialView === null
			? { cohortId: null, view: null, generation: 0, searchGeneration: 0 }
			: { ...initialView, generation: 0, searchGeneration: 0 };
		const fixture = { kind: "file", segment: "value", field: "name", direction: "asc" } as const;
		const rows = file_names(150).map((name) => saved_row({ kind: "file", name }));
		sorted.rows.set(sorted_fixture_key({ ...fixture, directoryView: initialView }), rows);
		const { result } = render_sorted(NAME_ASC);
		act(() => result.current.loadMore());
		expect(result.current.rows).toHaveLength(150);

		const nextKey = sorted_fixture_key({ ...fixture, directoryView: nextView });
		sorted.pages.set(nextKey, [rows.slice(0, 100), rows.slice(100)]);
		sorted.splitting.add(nextKey);
		act(() => {
			sorted.view = nextView === null
				? { cohortId: null, view: null, generation: 1, searchGeneration: 1 }
				: { ...nextView, generation: 1, searchGeneration: 1 };
			notify_sorted();
		});
		expect(result.current.rows, "Show more keeps all loaded rows while the Move pages refill").toHaveLength(150);
		expect(result.current.isBusy).toBe(true);
		expect(sorted.loadMoreCalls.get(nextKey)).toBe(1);

		act(() => {
			sorted.splitting.delete(nextKey);
			notify_sorted();
		});
		expect(result.current.rows?.map((row) => row.name)).toEqual(file_names(150));
		expect(result.current.isBusy).toBe(false);
	});

	test("puts folders first and holds a locked row until the loaded rows reach it", () => {
		sorted.rows.set(sorted_fixture_key({ kind: "folder", segment: "value", field: "name", direction: "asc" }), [
			saved_row({ kind: "folder", name: "docs" }),
		]);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			file_names(150).map((name) => saved_row({ kind: "file", name })),
		);
		const locked = [locked_row({ kind: "file", name: "file-005b.md" }), locked_row({ kind: "file", name: "zz.md" })];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", restricted: true }),
			locked,
		);
		const { result } = render_sorted(NAME_ASC);

		const firstPage = file_names(100);
		firstPage.splice(firstPage.indexOf("file-005.md") + 1, 0, "file-005b.md");
		expect(result.current.rows?.map((row) => row.name)).toEqual(["docs", ...firstPage]);
		expect(result.current.rows?.find((row) => row.name === "file-000.md")).toMatchObject({
			createdAt: 2,
			contentByteSize: 42,
		});
		// A locked row has no "Updated by".
		expect(result.current.rows?.find((row) => row.name === "zz.md")).toBeUndefined();
		expect(result.current.rows?.find((row) => row.name === "file-005b.md")).toMatchObject({ updatedBy: null });
		expect(result.current).toMatchObject({ isBusy: false, isDone: false, restrictedNote: null });

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

	test("merges a member's locked rows by page and reads no share stream outside a custom-field filter", () => {
		const open = file_names(150, "b");
		const shared = [...file_names(75, "a"), ...file_names(75, "c")];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc" }),
			open.map((name) => saved_row({ kind: "file", name })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", restricted: true }),
			shared.map((name) => locked_row({ kind: "file", name })),
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
		expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
	});

	test("reads the locked rows in the missing segment of an extension sort", () => {
		const sort: files_sort_Sort = [{ field: "extension", direction: "asc" }];
		const fixture = (kind: "file" | "folder", segment: "value" | "missing", restricted = false) =>
			sorted_fixture_key({ kind, segment, field: "extension", direction: "asc", restricted });
		sorted.rows.set(fixture("folder", "missing"), [saved_row({ kind: "folder", name: "docs", part: null })]);
		sorted.rows.set(fixture("folder", "missing", true), [locked_row({ kind: "folder", name: "beta", part: null })]);
		sorted.rows.set(fixture("file", "value"), [saved_row({ kind: "file", name: "a.md", part: ["md", "a.md"] })]);
		sorted.rows.set(fixture("file", "value", true), [
			locked_row({ kind: "file", name: "b.txt", part: ["txt", "b.txt"] }),
		]);
		sorted.rows.set(fixture("file", "missing"), [saved_row({ kind: "file", name: "c", part: null })]);
		sorted.rows.set(fixture("file", "missing", true), [locked_row({ kind: "file", name: "a-plain", part: null })]);
		const { result } = render_sorted(sort);

		// Folders have no extension, so they all sit in the missing segment, by name.
		expect(result.current.rows?.map((row) => row.name)).toEqual(["beta", "docs", "a.md", "b.txt", "a-plain", "c"]);
		expect(result.current.isDone).toBe(true);
		expect(
			paginatedArgsSeen.some((args) => args.kind === "file" && args.segment === "missing" && args.restricted === true),
		).toBe(true);
	});

	test("merges the locked rows in a desc sort", () => {
		const sort: files_sort_Sort = [{ field: "name", direction: "desc" }];
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "desc" }),
			["d.md", "b.md"].map((name) => saved_row({ kind: "file", name })),
		);
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "desc", restricted: true }),
			["e.md", "c.md", "a.md"].map((name) => locked_row({ kind: "file", name })),
		);
		const { result } = render_sorted(sort);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["e.md", "d.md", "c.md", "b.md", "a.md"]);
		expect(result.current.isDone).toBe(true);
	});

	test("reads the twin for the owner and a member, and no share stream outside a custom-field filter", () => {
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

		for (const isOwner of [true, false]) {
			paginatedArgsSeen.length = 0;
			const view = render_as(isOwner);
			expect(view.result.current.rows?.map((row) => row.name)).toEqual(["a.md", "b.md"]);
			expect(view.result.current.isDone).toBe(true);
			expect(paginatedArgsSeen.some((args) => args.restricted === true)).toBe(true);
			expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
			cleanup();
		}
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
			sorted_fixture_key({ kind: "folder", segment: "value", field: "size", direction: "desc", restricted: true }),
			[locked_row({ kind: "folder", name: "b", part: null })],
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

	test("a custom-field sort puts a member's locked rows last, by name, and says so", () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "asc" }];
		const fixture = (restricted: boolean) =>
			sorted_fixture_key({ kind: "file", segment: "value", field: "metadata.status", direction: "asc", restricted });
		sorted.rows.set(fixture(false), [
			saved_row({ kind: "file", name: "b.md", part: ["done", "b.md"] }),
			saved_row({ kind: "file", name: "z.md", part: ["open", "z.md"] }),
		]);
		// The server gives a member's restricted rows no value: the client never reads their custom fields.
		sorted.rows.set(fixture(true), [
			locked_row({ kind: "file", name: "a.md", part: null }),
			locked_row({ kind: "file", name: "c.md", part: null }),
		]);
		const { result } = render_sorted(sort);

		expect(result.current.rows?.map((row) => row.name)).toEqual(["b.md", "z.md", "a.md", "c.md"]);
		expect(result.current).toMatchObject({ isDone: true, restrictedNote: "sort" });
		expect(paginatedArgsSeen.some((args) => args.segment === "missing")).toBe(false);
		expect(paginatedArgsSeen.some((args) => args.principalIndex !== undefined)).toBe(false);
	});

	test("a custom-field sort with no locked row and a built-in sort say nothing", () => {
		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "metadata.status", direction: "asc" }),
			[saved_row({ kind: "file", name: "a.md", part: ["open", "a.md"] })],
		);
		const metadata = render_sorted([{ field: "metadata.status", direction: "asc" }]);
		expect(metadata.result.current.restrictedNote).toBeNull();
		cleanup();

		sorted.rows.set(
			sorted_fixture_key({ kind: "file", segment: "value", field: "name", direction: "asc", restricted: true }),
			[locked_row({ kind: "file", name: "a.md" })],
		);
		const byName = render_sorted(NAME_ASC);
		expect(byName.result.current.restrictedNote).toBeNull();
	});

	test("a member's custom-field filter reads the share streams but no twin, and says locked items are left out", () => {
		const filter: files_table_Filter = { kind: "text", field: "metadata.status", op: "is", value: "open" };
		const { result } = renderHook(() =>
			useFilesSortedChildren({
				membershipId: MEMBERSHIP_ID,
				folderId: FOLDER_ID,
				sort: NAME_ASC,
				filter,
				namePrefix: null,
				isOwner: false,
			}),
		);

		expect(result.current).toMatchObject({ isDone: true, restrictedNote: "filter" });
		expect(paginatedArgsSeen.some((args) => args.restricted === true)).toBe(false);
		expect(
			new Set(paginatedArgsSeen.map((args) => args.principalIndex).filter((index) => index !== undefined)),
		).toEqual(new Set([0, 1, 2]));
	});

	test("a built-in filter reads value segments with the name prefix, and the twin", () => {
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
				restricted: true,
			}),
			[locked_row({ kind: "file", name: "readme.md" })],
		);
		const { result } = render_filtered(NAME_ASC, filter, "re");

		expect(result.current.rows?.map((row) => row.name)).toEqual(["readme.md", "report.md"]);
		expect(result.current.isDone).toBe(true);
		expect(paginatedArgsSeen.every((args) => args.segment === "value" && args.namePrefix === "re")).toBe(true);
		expect(new Set(paginatedArgsSeen.map((args) => args.restricted ?? args.principalIndex))).toEqual(
			new Set([false, true]),
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

	test("keeps selected saved matches and restarts search at publication", () => {
		const cohortId = "cohort_search" as app_convex_Id<"files_move_cohorts">;
		sorted.view = { cohortId, view: "before", generation: 1, searchGeneration: 4 };
		const clause = { kind: "name", text: "plan" };
		saved.answers.set(JSON.stringify([clause, { kind: "normal", generation: 1 }]), {
			results: [saved_match("/normal-plan.md")], status: "Exhausted",
		});
		saved.answers.set(JSON.stringify([clause, { kind: "cohort", cohortId, view: "before", generation: 1 }]), {
			results: [saved_match("/old-plan.md")], status: "Exhausted",
		});
		const { result } = render_search("plan", false);
		expect(result.current.names.rows.map((row) => row.path),
			"selected saved matches remain visible during a linked move").toEqual(["/normal-plan.md", "/old-plan.md"]);
		saved.answers.set(JSON.stringify([clause, { kind: "cohort", cohortId, view: "after", generation: 2 }]), {
			results: [saved_match("/new-plan.md")], status: "Exhausted",
		});
		act(() => {
			sorted.view = { cohortId, view: "after", generation: 2, searchGeneration: 5 };
			notify_sorted();
		});
		expect(result.current.names.rows.map((row) => row.path)).toEqual(["/new-plan.md"]);
		expect(saved.argsSeen.at(-1)).toMatchObject({ searchGeneration: 5,
			savedStream: { kind: "cohort", view: "after", generation: 2 } });
	});

	test("waits for the saved view and ends a refused search", () => {
		sorted.view = undefined;
		const { result } = render_search("plan");
		expect(result.current.names.status).toBe("loading");
		expect(saved.argsSeen).toEqual([]);
		act(() => { sorted.view = null; notify_sorted(); });
		expect(result.current.names).toMatchObject({ rows: [], status: "done" });
	});

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
		const { result } = render_search("file.path:/docs/** plan");

		expect(saved.argsSeen).toEqual([
			{ membershipId: MEMBERSHIP_ID, clause: { kind: "name", text: "plan" }, folderPath: "/docs",
				savedStream: { kind: "normal", generation: 0 }, searchGeneration: 0 },
		]);
		expect(result.current.contents).toBe("folder");
		expect(result.current.names).toMatchObject({ rows: [], status: "done", problem: "Folder not found" });
		// The sidebar asks for no contents list.
		expect(render_search("plan", false).result.current.contents).toBeNull();

		// `/*` asks for the folder's direct children only.
		saved.argsSeen.length = 0;
		render_search("file.path:/docs/* plan");
		expect(saved.argsSeen.map((args) => [args.clause, args.folderPath])).toEqual([
			[{ kind: "name", text: "plan", childrenOnly: true }, "/docs"],
		]);
	});

	test("a file.content chip runs the contents search as its only list", () => {
		saved.answers.set(JSON.stringify({ kind: "content", text: "annual report" }), {
			results: [saved_match("/notes.md")],
			status: "Exhausted",
		});
		const { result } = render_search('file.content:"annual report"', false);

		expect(saved.argsSeen.map((args) => args.clause)).toEqual([{ kind: "content", text: "annual report" }]);
		expect(result.current.contentText).toBe("annual report");
		expect(result.current.names.rows.map((row) => row.path)).toEqual(["/notes.md"]);
		expect(result.current.contents).toBeNull();
	});

	test("a path or id asks for that node with no folder", () => {
		const { result } = render_search("file.path:/docs/** /Notes/a.md");

		expect(saved.argsSeen).toEqual([{ membershipId: MEMBERSHIP_ID, clause: { kind: "path", path: "/Notes/a.md" },
			savedStream: { kind: "normal", generation: 0 }, searchGeneration: 0 }]);
		expect(result.current.isExact).toBe(true);
		expect(result.current.contents).toBeNull();
	});

	test("a metadata chip merges its plans into one list", async () => {
		const { result } = render_search("file.path:/docs/** metadata.count:3");
		await act(async () => {});

		expect(saved.argsSeen).toEqual([]);
		expect(saved.metadataArgsSeen.map((args) => [args.plan.op, args.folderPath])).toEqual([
			["eq", "/docs"],
			["eq", "/docs"],
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

	test("a metadata list has no index limit, so it never says it shows the top matches", async () => {
		saved.answers.set(
			JSON.stringify({ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.status", value: "open" } }),
			{
				results: Array.from({ length: 1024 }, (_, index) => saved_match(`/tasks/task-${index}.md`)),
				status: "Exhausted",
			},
		);

		const { result } = render_search("metadata.status:open");
		await act(async () => {});
		expect(result.current.names).toMatchObject({ status: "done", isTopMatches: false });
		expect(result.current.names.rows).toHaveLength(1024);
	});

	test("a failed metadata search ends with a problem instead of loading forever", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		saved.metadataFails = "first";

		const { result } = render_search("metadata.status:open");
		await act(async () => {});
		expect(result.current.names).toMatchObject({
			rows: [],
			status: "done",
			isLoadingMore: false,
			problem: "The search failed. Search again.",
		});
		consoleError.mockRestore();
	});

	test("a failed next metadata page keeps the rows and stops loading more", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		saved.answers.set(
			JSON.stringify({ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.status", value: "open" } }),
			{ results: [saved_match("/tasks/a.md")], status: "CanLoadMore" },
		);
		saved.metadataFails = "more";

		const { result } = render_search("metadata.status:open");
		await act(async () => {});
		expect(result.current.names).toMatchObject({ status: "more", isLoadingMore: false });
		await act(async () => result.current.names.loadMore());
		expect(result.current.names).toMatchObject({
			status: "done",
			isLoadingMore: false,
			problem: "The search failed. Search again.",
		});
		expect(result.current.names.rows.map((row) => row.path)).toEqual(["/tasks/a.md"]);
		consoleError.mockRestore();
	});

	test("a list says when its next page is loading", () => {
		saved.answers.set(JSON.stringify({ kind: "name", text: "plan" }), {
			results: [saved_match("/plan.md")],
			status: "LoadingMore",
		});

		expect(render_search("plan").result.current.names).toMatchObject({ status: "more", isLoadingMore: true });
	});

	test("a date in a folder asks for the typed text only and says so", () => {
		const { result } = render_search("file.path:/docs/** metadata.due:2026-09-04");

		// A folder cannot scope the range plan that finds dates stored with a time.
		expect(saved.metadataArgsSeen.map((args) => [args.plan, args.folderPath])).toEqual([
			[{ op: "eq", fieldPath: "metadata.due", value: "2026-09-04" }, "/docs"],
		]);
		expect(result.current.isFolderDate).toBe(true);

		saved.metadataArgsSeen.length = 0;
		expect(render_search("metadata.due:2026-09-04").result.current.isFolderDate).toBe(false);
		expect(saved.metadataArgsSeen.map((args) => args.plan.op)).toEqual(["eq", "range"]);
	});

	test("the root folder scopes nothing, so a range and a date run in full", () => {
		const range = render_search("file.path:/** metadata.priority:>2").result.current;
		const date = render_search("file.path:/** metadata.due:2026-09-04").result.current;

		expect(range.mode).toBe("search");
		expect(date.isFolderDate).toBe(false);
		expect(saved.metadataArgsSeen.map((args) => args.plan.op)).toEqual(["range", "eq", "range"]);
	});
});
