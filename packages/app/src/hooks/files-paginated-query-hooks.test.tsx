import { act, cleanup, renderHook } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient, usePaginatedQuery } from "convex/react";
import {
	getFunctionName,
	makeFunctionReference,
	type paginationOptsValidator,
	type PaginationResult,
} from "convex/server";
import { ConvexError, convexToJson, type Infer, type Value } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { files_DirectoryView, files_SavedStream } from "../../shared/files.ts";
import { ConvexQueryCacheProvider } from "./convex-hooks.ts";
import { useFilesPaginatedQuery } from "./files-paginated-query-hooks.ts";

type Row = { name: string };
type Args = { folder: string; savedStream: files_SavedStream; searchGeneration: number; value?: Value };
type DirectoryArgs = { folder: string; stream: "normal" | "cohort"; pageView?: files_DirectoryView };
type QueryArgs = (Args | DirectoryArgs) & { paginationOpts: Infer<typeof paginationOptsValidator> };
type DirectoryPage = PaginationResult<Row> & { directoryView: files_DirectoryView };
const query = makeFunctionReference<"query", QueryArgs, PaginationResult<Row>>("files_test:page");
const otherQuery = makeFunctionReference<"query", QueryArgs, PaginationResult<Row>>("files_test:other_page");
const directoryQuery = makeFunctionReference<"query", DirectoryArgs & Pick<QueryArgs, "paginationOpts">, DirectoryPage>(
	"files_test:directory",
);
const args: Args = { folder: "root", savedStream: { kind: "normal", generation: 0 }, searchGeneration: 0 };
const directoryArgs: DirectoryArgs = { folder: "root", stream: "normal" };
const beforeView: files_DirectoryView = {
	cohortId: "cohort-a" as NonNullable<files_DirectoryView>["cohortId"],
	view: "before",
};
const afterView: files_DirectoryView = { ...beforeView, view: "after" };
const nextView: files_DirectoryView = {
	cohortId: "cohort-b" as NonNullable<files_DirectoryView>["cohortId"],
	view: "before",
};
type Watch = { name: string; args: QueryArgs; key: string };
const answers = new Map<string, PaginationResult<Row> | Error>();
const listeners = new Map<string, Set<() => void>>();
const watches = new Map<string, Watch>();
let client: ConvexReactClient;

// Most tests keep no idle queries. Cache lifetime tests below use the app's default provider.
function Wrapper(props: { children: ReactNode }) {
	return (
		<ConvexProvider client={client}>
			<ConvexQueryCacheProvider maxIdleEntries={0}>{props.children}</ConvexQueryCacheProvider>
		</ConvexProvider>
	);
}

function CachingWrapper(props: { children: ReactNode }) {
	return (
		<ConvexProvider client={client}>
			<ConvexQueryCacheProvider>{props.children}</ConvexQueryCacheProvider>
		</ConvexProvider>
	);
}

function renderPager(initialArgs: Args | "skip" = args) {
	return renderHook(
		(props: { args: Args | "skip"; query: typeof query }) =>
			useFilesPaginatedQuery(props.query, props.args, { initialNumItems: 2 }),
		{ wrapper: Wrapper, initialProps: { args: initialArgs, query } },
	);
}

function renderDirectoryPager(stream: DirectoryArgs["stream"] = "normal") {
	return renderHook(
		() => useFilesPaginatedQuery(directoryQuery, { ...directoryArgs, stream }, { initialNumItems: 2 }),
		{
			wrapper: Wrapper,
		},
	);
}

function activeWatches() {
	return [...watches.values()].filter((watch) => (listeners.get(watch.key)?.size ?? 0) > 0);
}

function answer(watch: Watch, value: PaginationResult<Row> | DirectoryPage | Error) {
	act(() => {
		answers.set(watch.key, value);
		listeners.get(watch.key)?.forEach((notify) => notify());
	});
}

function page(names: string[], isDone = false, continueCursor = "tail"): PaginationResult<Row> {
	return { page: names.map((name) => ({ name })), isDone, continueCursor };
}

function changedView(
	reason:
		| "saved_move_view_changed"
		| "saved_search_view_changed"
		| "saved_index_view_changed" = "saved_move_view_changed",
) {
	return new ConvexError({
		message: "InvalidCursor: The saved view changed.",
		isConvexSystemError: true,
		paginationError: "InvalidCursor",
		reason,
	});
}

beforeEach(() => {
	answers.clear();
	listeners.clear();
	watches.clear();
	client = new ConvexReactClient("https://files-pager-test.convex.cloud");
	// Keep the real hooks. Key answers by the full session, so a retry can reach the assertion.
	vi.spyOn(client, "watchQuery").mockImplementation((reference, queryArgs?, _options?) => {
		const name = getFunctionName(reference);
		const key = JSON.stringify(convexToJson({ name, args: queryArgs }));
		watches.set(key, { name, args: queryArgs as QueryArgs, key });
		return {
			onUpdate: (notify) => {
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(notify);
				listeners.set(key, callbacks);
				return () => {
					callbacks.delete(notify);
				};
			},
			localQueryResult: () => answers.get(key) as never,
			localQueryLogs: () => undefined,
			journal: () => undefined,
		};
	});
});

afterEach(async () => {
	cleanup();
	await client.close();
	vi.restoreAllMocks();
});

describe("directory pages", () => {
	test.each([null, beforeView, afterView])("pins continuations to directory view %j", (directoryView) => {
		const hook = renderDirectoryPager();
		const first = activeWatches()[0]!;
		expect(first.args).not.toHaveProperty("pageView");
		answer(first, { ...page(["a", "b"], false, "native-tail"), directoryView });
		act(() => hook.result.current.loadMore(2));
		const later = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "native-tail")!;
		expect(later.args, "a continuation pins its native cursor to the returned directory view").toHaveProperty(
			"pageView",
			directoryView,
		);
		answer(later, { ...page(["c", "d"], true, ""), directoryView });
		expect(hook.result.current.directoryView).toEqual(directoryView);
		expect(hook.result.current.results.map((row) => row.name)).toEqual(["a", "b", "c", "d"]);
	});

	test("settles an empty idle cohort with its null directory view", () => {
		const hook = renderDirectoryPager("cohort");
		answer(activeWatches()[0]!, { ...page([], true, ""), directoryView: null });
		expect(hook.result.current, "an idle cohort is settled with an explicit null tag").toMatchObject({
			results: [],
			status: "Exhausted",
			directoryView: null,
		});
	});

	test.each([null, beforeView])("pins both native split children to directory view %j", (directoryView) => {
		const hook = renderDirectoryPager();
		const parent = activeWatches()[0]!;
		answer(parent, { ...page(["a", "z"], false, "z"), directoryView, pageStatus: "SplitRequired", splitCursor: "m" });
		const left = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
		const right = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		for (const child of [left, right])
			expect(child.args, "both split children pin the parent directory view").toHaveProperty("pageView", directoryView);
		expect(left.args.paginationOpts).toEqual({
			cursor: null,
			endCursor: "m",
			numItems: 2,
			id: parent.args.paginationOpts.id,
		});
		expect(right.args.paginationOpts).toEqual({
			cursor: "m",
			endCursor: "z",
			numItems: 2,
			id: parent.args.paginationOpts.id,
		});
		answer(left, { ...page(["a"], false, "m"), directoryView });
		answer(right, { ...page(["z"], false, "z"), directoryView });
		expect(hook.result.current.results.map((row) => row.name)).toEqual(["a", "z"]);
		expect(hook.result.current.directoryView).toEqual(directoryView);
	});

	test.each([afterView, nextView, null])(
		"resets mixed pages and restores the requested extent for %j",
		(directoryView) => {
			const hook = renderDirectoryPager();
			const first = activeWatches()[0]!;
			answer(first, { ...page(["a", "b"], false, "old-tail"), directoryView: beforeView });
			act(() => hook.result.current.loadMore(2));
			const later = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "old-tail")!;
			answer(later, { ...page(["c", "d"], true, ""), directoryView });
			const fresh = activeWatches().find((watch) => watch.args.paginationOpts.id !== first.args.paginationOpts.id)!;
			expect(fresh, "mixed page tags start a fresh native pagination session").toBeDefined();
			expect(fresh.args.paginationOpts.cursor).toBeNull();
			expect(fresh.args.paginationOpts.id).toBeLessThan(first.args.paginationOpts.id!);
			expect(fresh.args).not.toHaveProperty("pageView");
			answer(fresh, { ...page(["new-a", "new-b"], false, "new-tail"), directoryView });
			expect(hook.result.current.isLoading, "a reset does not settle at the first page after Show more").toBe(true);
			expect(hook.result.current.directoryView).toBeUndefined();
			const refill = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "new-tail")!;
			expect(refill, "a directory reset refills the requested loaded extent").toBeDefined();
			expect(refill.args).toHaveProperty("pageView", directoryView);
			answer(refill, { ...page(["new-c", "new-d"], true, ""), directoryView });
			expect(hook.result.current.results.map((row) => row.name)).toEqual(["new-a", "new-b", "new-c", "new-d"]);
			expect(hook.result.current.directoryView).toEqual(directoryView);
			expect(hook.result.current.status).toBe("Exhausted");
		},
	);

	test.each([
		{ side: "left", otherReady: false },
		{ side: "left", otherReady: true },
		{ side: "right", otherReady: false },
		{ side: "right", otherReady: true },
	] as const)("rejects a mixed $side split child while otherReady=$otherReady", ({ side, otherReady }) => {
		const hook = renderDirectoryPager();
		const parent = activeWatches()[0]!;
		answer(parent, { ...page(["a", "z"]), directoryView: beforeView, pageStatus: "SplitRequired", splitCursor: "m" });
		const left = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
		const right = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		if (otherReady) answer(side === "left" ? right : left, { ...page(["old"]), directoryView: beforeView });
		answer(side === "left" ? left : right, { ...page(["new"]), directoryView: afterView });
		const fresh = activeWatches().find((watch) => watch.args.paginationOpts.id !== parent.args.paginationOpts.id);
		expect(fresh, "either split child with a different view resets before rows can join").toBeDefined();
		expect(hook.result.current).toMatchObject({ results: [], directoryView: undefined, isLoading: true });
	});

	test("retries a native first-page error with a fresh ID and keeps the refill extent", () => {
		const hook = renderDirectoryPager();
		const first = activeWatches()[0]!;
		answer(first, { ...page(["a", "b"], false, "old-tail"), directoryView: beforeView });
		act(() => hook.result.current.loadMore(2));
		answer(first, new Error("InvalidCursor: Native first-page journal changed."));
		const fresh = activeWatches()[0]!;
		expect(fresh.args.paginationOpts.id, "a native first-page failure gets a fresh negative ID").toBeLessThan(
			first.args.paginationOpts.id!,
		);
		answer(fresh, { ...page(["new-a", "new-b"], false, "new-tail"), directoryView: afterView });
		expect(hook.result.current.isLoading, "native journal recovery keeps the requested extent").toBe(true);
		const refill = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "new-tail")!;
		expect(refill, "native first-page recovery refills past its first page").toBeDefined();
		answer(refill, { ...page(["new-c"], true, ""), directoryView: afterView });
		expect(hook.result.current.results.map((row) => row.name)).toEqual(["new-a", "new-b", "new-c"]);
		expect(hook.result.current.directoryView).toEqual(afterView);
	});
});

describe("useFilesPaginatedQuery", () => {
	test.each(["saved_move_view_changed", "saved_search_view_changed", "saved_index_view_changed"] as const)(
		"waits for changed args after %s without retrying the old session",
		(reason) => {
			const hook = renderPager();
			const first = activeWatches()[0]!;
			answer(first, page(["old"]));
			const retainedLoadMore = hook.result.current.loadMore;
			answer(first, changedView(reason));
			answer(first, changedView(reason));
			hook.rerender({ args: { ...args }, query });
			act(() => retainedLoadMore(2));
			expect(watches.size, "a changed Move view does not create another query session with the same savedStream").toBe(
				1,
			);
			expect(hook.result.current).toMatchObject({ results: [], isLoading: true, status: "LoadingFirstPage" });
			const nextArgs: Args =
				reason === "saved_search_view_changed"
					? { ...args, searchGeneration: 1 }
					: { ...args, savedStream: { kind: "normal", generation: 1 } };
			hook.rerender({ args: nextArgs, query });
			act(() => retainedLoadMore(2));
			expect(watches.size, "a retained callback cannot append an old cursor while new args load").toBe(2);
			expect(listeners.get(first.key)?.size).toBe(0);
			const fresh = activeWatches()[0]!;
			expect(fresh.args.paginationOpts.cursor).toBeNull();
			answer(fresh, page(["current"], true, ""));
			expect(hook.result.current.results).toEqual([{ name: "current" }]);
			expect(hook.result.current.status).toBe("Exhausted");
		},
	);

	test("waits for a changed view on a later page without showing a partial prefix", () => {
		const hook = renderPager();
		const first = activeWatches()[0]!;
		answer(first, page(["a"], false, "a"));
		const retainedLoadMore = hook.result.current.loadMore;
		act(() => retainedLoadMore(2));
		const later = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "a")!;
		answer(later, changedView());
		act(() => retainedLoadMore(2));
		expect(hook.result.current).toMatchObject({ results: [], status: "LoadingMore", isLoading: true });
		expect(watches.size, "a later view error waits without another page or session").toBe(2);
		hook.rerender({ args: { ...args, savedStream: { kind: "normal", generation: 1 } }, query });
		const fresh = activeWatches()[0]!;
		answer(fresh, page(["b", "c"], true, ""));
		expect(hook.result.current.results).toEqual([{ name: "b" }, { name: "c" }]);
		expect(listeners.get(first.key)?.size).toBe(0);
		expect(listeners.get(later.key)?.size).toBe(0);
	});

	test.each([
		{ side: "left", otherReady: false },
		{ side: "left", otherReady: true },
		{ side: "right", otherReady: false },
		{ side: "right", otherReady: true },
	] as const)("waits for a $side split child error while otherReady=$otherReady", ({ side, otherReady }) => {
		const hook = renderPager();
		const parent = activeWatches()[0]!;
		answer(parent, { ...page(["a", "z"]), pageStatus: "SplitRequired", splitCursor: "m" });
		const left = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
		const right = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		if (otherReady) answer(side === "left" ? right : left, page(["other"], true, ""));
		answer(side === "left" ? left : right, changedView());
		act(() => hook.result.current.loadMore(2));
		expect(watches.size, "a split view error creates no retry session").toBe(3);
		expect(listeners.get(parent.key)?.size, "a failed split never replaces its parent").toBeGreaterThan(0);
		expect(hook.result.current).toMatchObject({ results: [], isLoading: true });
		hook.rerender({ args: { ...args, savedStream: { kind: "normal", generation: 1 } }, query });
		expect(activeWatches()).toHaveLength(1);
		answer(activeWatches()[0]!, page(["new"], true, ""));
		expect(hook.result.current.results).toEqual([{ name: "new" }]);
	});

	test.each([
		{ kind: "pages", viewFirst: false },
		{ kind: "pages", viewFirst: true },
		{ kind: "split", viewFirst: false },
		{ kind: "split", viewFirst: true },
	] as const)("waits before an ordinary cursor reset in $kind with viewFirst=$viewFirst", ({ kind, viewFirst }) => {
		const hook = renderPager();
		const parent = activeWatches()[0]!;
		let first: Watch;
		let second: Watch;
		if (kind === "split") {
			answer(parent, { ...page(["a", "z"]), pageStatus: "SplitRequired", splitCursor: "m" });
			first = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
			second = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		} else {
			answer(parent, page(["a"], false, "a"));
			act(() => hook.result.current.loadMore(2));
			first = parent;
			second = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "a")!;
		}
		const count = watches.size;
		act(() => {
			answers.set(first.key, viewFirst ? changedView() : new Error("InvalidCursor: Native cursor changed."));
			answers.set(second.key, viewFirst ? new Error("InvalidCursor: Native cursor changed.") : changedView());
			listeners.get(first.key)?.forEach((notify) => notify());
			listeners.get(second.key)?.forEach((notify) => notify());
		});
		expect(watches.size, "a view-dependent error wins over an ordinary cursor reset").toBe(count);
		expect(hook.result.current).toMatchObject({ results: [], isLoading: true });
	});

	test.each([
		{ kind: "pages", viewFirst: false },
		{ kind: "pages", viewFirst: true },
		{ kind: "split", viewFirst: false },
		{ kind: "split", viewFirst: true },
	] as const)("surfaces an unrelated error in $kind with viewFirst=$viewFirst", ({ kind, viewFirst }) => {
		const hook = renderPager();
		const parent = activeWatches()[0]!;
		let first: Watch;
		let second: Watch;
		if (kind === "split") {
			answer(parent, { ...page(["a", "z"]), pageStatus: "SplitRequired", splitCursor: "m" });
			first = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
			second = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		} else {
			answer(parent, page(["a"], false, "a"));
			act(() => hook.result.current.loadMore(2));
			first = parent;
			second = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "a")!;
		}
		const count = watches.size;
		expect(
			() =>
				act(() => {
					answers.set(first.key, viewFirst ? changedView() : new Error("Permission denied"));
					answers.set(second.key, viewFirst ? new Error("Permission denied") : changedView());
					listeners.get(first.key)?.forEach((notify) => notify());
					listeners.get(second.key)?.forEach((notify) => notify());
				}),
			"a saved-view wait never hides an unrelated page error",
		).toThrow("Permission denied");
		expect(watches.size).toBe(count);
	});

	test.each(["SplitRequired", "SplitRecommended", "growing"] as const)(
		"keeps native end cursors and order for %s",
		(status) => {
			const hook = renderPager();
			const parent = activeWatches()[0]!;
			answer(parent, {
				...page(["a", "b", "c", "d", "e"], false, "z"),
				...(status === "growing" ? {} : { pageStatus: status }),
				splitCursor: "m",
			});
			const left = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
			const right = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
			expect(left.args.paginationOpts).toEqual({
				numItems: 2,
				cursor: null,
				id: parent.args.paginationOpts.id,
				endCursor: "m",
			});
			expect(right.args.paginationOpts).toEqual({
				numItems: 2,
				cursor: "m",
				id: parent.args.paginationOpts.id,
				endCursor: "z",
			});
			if (status === "SplitRequired") expect(hook.result.current.results).toEqual([]);
			answer(right, page(["c", "d", "e"], false, "z"));
			expect(listeners.get(parent.key)?.size, "one child cannot complete a split").toBeGreaterThan(0);
			answer(left, page(["a", "b"], false, "m"));
			expect(hook.result.current.results.map((row) => row.name)).toEqual(["a", "b", "c", "d", "e"]);
			expect(listeners.get(parent.key)?.size).toBe(0);
			answer(left, page(["b"], false, "m"));
			expect(hook.result.current.results.map((row) => row.name)).toEqual(["b", "c", "d", "e"]);
		},
	);

	test.each([
		new Error("InvalidCursor: Native cursor changed."),
		new Error("InvalidCursor: The saved Move view changed."),
		new ConvexError({
			message: "InvalidCursor: Native cursor changed.",
			isConvexSystemError: true,
			paginationError: "InvalidCursor",
		}),
		new ConvexError({
			message: "InvalidCursor: Other cursor changed.",
			reason: "other",
			paginationError: "InvalidCursor",
		}),
	])("restarts an ordinary cursor error normally: %s", (error) => {
		const hook = renderPager();
		const first = activeWatches()[0]!;
		answer(first, error);
		expect(watches.size, "an ordinary cursor error restarts once").toBe(2);
		const fresh = activeWatches()[0]!;
		expect(fresh.args).toEqual({
			...first.args,
			paginationOpts: { ...first.args.paginationOpts, id: fresh.args.paginationOpts.id },
		});
		expect(fresh.args.paginationOpts.id).not.toBe(first.args.paginationOpts.id);
		answer(fresh, page(["recovered"], true, ""));
		expect(hook.result.current.results).toEqual([{ name: "recovered" }]);
	});

	test.each([
		new Error("Permission denied"),
		new ConvexError({ message: "Permission denied", reason: "saved_move_view_changed" }),
	])("surfaces an unrelated error or a missing cursor marker: %s", (error) => {
		renderPager();
		expect(() => answer(activeWatches()[0]!, error)).toThrow(error);
		expect(watches.size).toBe(1);
	});

	test("keeps one pending loadMore and stops after exhaustion", () => {
		const hook = renderPager();
		const first = activeWatches()[0]!;
		answer(first, page(["a"], false, "a"));
		const retainedLoadMore = hook.result.current.loadMore;
		act(() => {
			retainedLoadMore(2);
			retainedLoadMore(2);
		});
		expect(watches.size).toBe(2);
		const later = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "a")!;
		expect(later.args.paginationOpts).toEqual({ cursor: "a", numItems: 2, id: first.args.paginationOpts.id });
		act(() => retainedLoadMore(2));
		expect(watches.size).toBe(2);
		answer(later, page(["b"], true, ""));
		expect(hook.result.current.results).toEqual([{ name: "a" }, { name: "b" }]);
		expect(hook.result.current.status).toBe("Exhausted");
		act(() => retainedLoadMore(2));
		expect(watches.size).toBe(2);
	});

	test("restarts for query, args and skip changes without old-scope rows", () => {
		const hook = renderPager("skip");
		expect(activeWatches()).toHaveLength(0);
		hook.rerender({ args, query });
		const first = activeWatches()[0]!;
		answer(first, page(["old"], true, ""));
		hook.rerender({ args: { ...args, folder: "other" }, query });
		expect(hook.result.current.results).toEqual([]);
		expect(listeners.get(first.key)?.size).toBe(0);
		const second = activeWatches()[0]!;
		hook.rerender({ args: { ...args, folder: "other" }, query: otherQuery });
		expect(activeWatches()[0]!.name).toBe("files_test:other_page");
		expect(listeners.get(second.key)?.size).toBe(0);
		hook.rerender({ args: "skip", query: otherQuery });
		expect(activeWatches()).toHaveLength(0);
		expect(hook.result.current.results).toEqual([]);
	});

	test("shares one negative session between Files pagers, apart from a standard SDK pager", () => {
		renderHook(
			() => ({
				first: useFilesPaginatedQuery(query, args, { initialNumItems: 2 }),
				second: useFilesPaginatedQuery(query, args, { initialNumItems: 2 }),
				sdk: usePaginatedQuery(query, args, { initialNumItems: 2 }),
			}),
			{ wrapper: Wrapper },
		);
		const ids = activeWatches().map((watch) => watch.args.paginationOpts.id!);
		expect(ids).toHaveLength(2);
		expect(ids.filter((id) => id < 0)).toHaveLength(1);
		expect(ids.filter((id) => id >= 0)).toHaveLength(1);
	});

	test("releases old Move generations before the default cache timeout", () => {
		const hook = renderHook(
			(props: { args: Args }) => useFilesPaginatedQuery(query, props.args, { initialNumItems: 2 }),
			{ wrapper: CachingWrapper, initialProps: { args } },
		);
		let previous = activeWatches()[0]!;
		answer(previous, page(["generation-0"], true, ""));
		for (const generation of [1, 2]) {
			answer(previous, changedView());
			hook.rerender({ args: { ...args, savedStream: { kind: "normal", generation } } });
			expect(listeners.get(previous.key)?.size, "an old Move generation has no listener before the cache timeout").toBe(
				0,
			);
			previous = activeWatches()[0]!;
			answer(previous, page([`generation-${generation}`], true, ""));
			expect(hook.result.current.results).toEqual([{ name: `generation-${generation}` }]);
		}
		hook.unmount();
		expect(listeners.get(previous.key)?.size, "the last fixed-view page ends on unmount").toBe(0);
	});

	test.each(["skip", "unmount"] as const)("releases fixed-view pages on %s with the default cache", (change) => {
		const hook = renderHook(
			(props: { args: Args | "skip" }) => useFilesPaginatedQuery(query, props.args, { initialNumItems: 2 }),
			{ wrapper: CachingWrapper, initialProps: { args: args as Args | "skip" } },
		);
		const first = activeWatches()[0]!;
		answer(first, page(["a"], true, ""));
		if (change === "skip") {
			hook.rerender({ args: "skip" });
			expect(hook.result.current.results).toEqual([]);
		} else hook.unmount();
		expect(listeners.get(first.key)?.size, "a fixed-view page has no idle cache listener").toBe(0);
	});

	test("releases an initial page pinned to a null directory view", () => {
		const hook = renderHook(
			() => useFilesPaginatedQuery(directoryQuery, { ...directoryArgs, pageView: null }, { initialNumItems: 2 }),
			{ wrapper: CachingWrapper },
		);
		const first = activeWatches()[0]!;
		answer(first, { ...page(["a"], true, ""), directoryView: null });
		expect(hook.result.current.results).toEqual([{ name: "a" }]);
		hook.unmount();
		expect(listeners.get(first.key)?.size, "pageView null still binds the page's lifetime").toBe(0);
	});

	test("releases a directory continuation when its folder changes", () => {
		const hook = renderHook(
			(props: DirectoryArgs) => useFilesPaginatedQuery(directoryQuery, props, { initialNumItems: 2 }),
			{ wrapper: CachingWrapper, initialProps: directoryArgs },
		);
		const first = activeWatches()[0]!;
		answer(first, { ...page(["a", "b"], false, "tail"), directoryView: null });
		act(() => hook.result.current.loadMore(2));
		const later = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "tail")!;
		expect(later.args).toHaveProperty("pageView", null);
		answer(later, { ...page(["c"], true, ""), directoryView: null });
		expect(hook.result.current.results.map((row) => row.name)).toEqual(["a", "b", "c"]);
		hook.rerender({ ...directoryArgs, folder: "other" });
		expect(hook.result.current.results, "old-folder rows do not enter the next folder").toEqual([]);
		expect(listeners.get(later.key)?.size, "a retired continuation has no cache listener").toBe(0);
	});

	test("releases both null-view split children after their pager unmounts", () => {
		const hook = renderHook(() => useFilesPaginatedQuery(directoryQuery, directoryArgs, { initialNumItems: 2 }), {
			wrapper: CachingWrapper,
		});
		const first = activeWatches()[0]!;
		answer(first, { ...page(["a", "z"]), directoryView: null, pageStatus: "SplitRequired", splitCursor: "m" });
		const left = activeWatches().find((watch) => watch.args.paginationOpts.endCursor === "m")!;
		const right = activeWatches().find((watch) => watch.args.paginationOpts.cursor === "m")!;
		expect(left.args).toHaveProperty("pageView", null);
		expect(right.args).toHaveProperty("pageView", null);
		answer(left, { ...page(["a"], false, "m"), directoryView: null });
		answer(right, { ...page(["z"], true, ""), directoryView: null });
		expect(hook.result.current.results.map((row) => row.name)).toEqual(["a", "z"]);
		hook.unmount();
		for (const child of [left, right])
			expect(listeners.get(child.key)?.size, "a retired split child has no cache listener").toBe(0);
	});

	test("releases reset first pages instead of caching each new native session", () => {
		const hook = renderHook(() => useFilesPaginatedQuery(directoryQuery, directoryArgs, { initialNumItems: 2 }), {
			wrapper: CachingWrapper,
		});
		const first = activeWatches()[0]!;
		answer(first, new Error("InvalidCursor: Native first-page journal changed."));
		const reset = activeWatches().find((watch) => watch.args.paginationOpts.id !== first.args.paginationOpts.id)!;
		expect(reset.args.paginationOpts.cursor).toBeNull();
		expect(reset.args).not.toHaveProperty("pageView");
		answer(reset, { ...page(["a"], true, ""), directoryView: null });
		answer(reset, new Error("InvalidCursor: Native first-page journal changed again."));
		expect(listeners.get(reset.key)?.size, "a retired reset session has no cache listener").toBe(0);
		const latest = activeWatches().find((watch) => watch.key !== first.key && watch.key !== reset.key)!;
		answer(latest, { ...page(["current"], true, ""), directoryView: null });
		expect(hook.result.current.results).toEqual([{ name: "current" }]);
		hook.unmount();
		expect(listeners.get(latest.key)?.size, "the current reset session ends on unmount").toBe(0);
	});

	test("keeps a fixed page live until its last consumer leaves", () => {
		const usePager = () => useFilesPaginatedQuery(query, args, { initialNumItems: 2 });
		const first = renderHook(usePager, { wrapper: CachingWrapper });
		const second = renderHook(usePager, { wrapper: CachingWrapper });
		const watch = activeWatches()[0]!;
		answer(watch, page(["a"], true, ""));
		first.unmount();
		expect(listeners.get(watch.key)?.size, "another active consumer keeps its listener").toBeGreaterThan(0);
		expect(second.result.current.results).toEqual([{ name: "a" }]);
		second.unmount();
		expect(listeners.get(watch.key)?.size, "the last consumer leaves no fixed-view cache listener").toBe(0);
	});

	test("a pager that mounts again shows its cached first page at once", () => {
		const usePager = () => useFilesPaginatedQuery(directoryQuery, directoryArgs, { initialNumItems: 2 });
		const first = renderHook(usePager, { wrapper: CachingWrapper });
		const watch = activeWatches()[0]!;
		answer(watch, { ...page(["a"], true, ""), directoryView: null });
		first.unmount();
		expect(listeners.get(watch.key)?.size, "the cache keeps the query subscribed").toBe(1);

		const second = renderHook(usePager, { wrapper: CachingWrapper });
		expect(watches.size, "the second pager uses the same query args").toBe(1);
		expect(second.result.current.results).toEqual([{ name: "a" }]);
	});

	test("an opted-in saved-stream first page stays cached for the next pager", () => {
		const usePager = () => useFilesPaginatedQuery(query, args, { initialNumItems: 2, cacheSavedStreamFirstPage: true });
		const first = renderHook(usePager, { wrapper: CachingWrapper });
		const watch = activeWatches()[0]!;
		answer(watch, page(["a"], true, ""));
		first.unmount();
		expect(listeners.get(watch.key)?.size, "the cache keeps the query subscribed").toBe(1);

		const second = renderHook(usePager, { wrapper: CachingWrapper });
		expect(second.result.current.results).toEqual([{ name: "a" }]);
	});

	test("keeps the memoized rows and session on a same-args rerender", () => {
		const hook = renderPager();
		answer(activeWatches()[0]!, page(["a", "b"], true, ""));
		const rows = hook.result.current.results;
		hook.rerender({ args: { ...args }, query });
		expect(hook.result.current.results, "equal args keep the same rows reference").toBe(rows);
		expect(watches.size).toBe(1);
	});

	test.each([
		{ label: "undefined", value: undefined },
		{ label: "int64", value: 9n },
		{ label: "bytes", value: new Uint8Array([0, 255]).buffer },
	])("keeps Convex $label args and the same named query stable", ({ value }) => {
		const hook = renderPager({ ...args, value });
		const first = activeWatches()[0]!;
		expect(first.name).toBe("files_test:page");
		if (value === undefined) expect(first.args).not.toHaveProperty("value");
		else expect(first.args).toHaveProperty("value", value);
		answer(first, page(["a"], true, ""));
		const rows = hook.result.current.results;
		hook.rerender({
			args: { ...args, value },
			query: makeFunctionReference<"query", QueryArgs, PaginationResult<Row>>("files_test:page"),
		});
		expect(hook.result.current.results).toBe(rows);
		expect(watches.size, "equal Convex values and query names keep the same session").toBe(1);
	});
});
