import { act, cleanup, renderHook } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient, usePaginatedQuery } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import {
	getFunctionName,
	makeFunctionReference,
	type paginationOptsValidator,
	type PaginationResult,
} from "convex/server";
import { ConvexError, convexToJson, type Infer, type Value } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { files_SavedStream } from "../../shared/files.ts";
import { useFilesPaginatedQuery } from "./files-paginated-query-hooks.ts";

type Row = { name: string };
type Args = { folder: string; savedStream: files_SavedStream; searchGeneration: number; value?: Value };
type QueryArgs = Args & { paginationOpts: Infer<typeof paginationOptsValidator> };
const query = makeFunctionReference<"query", QueryArgs, PaginationResult<Row>>("files_test:page");
const otherQuery = makeFunctionReference<"query", QueryArgs, PaginationResult<Row>>("files_test:other_page");
const args: Args = { folder: "root", savedStream: { kind: "normal", generation: 0 }, searchGeneration: 0 };
type Watch = { name: string; args: QueryArgs; key: string };
const answers = new Map<string, PaginationResult<Row> | Error>();
const listeners = new Map<string, Set<() => void>>();
const watches = new Map<string, Watch>();
let client: ConvexReactClient;

// The cache keeps no idle query here, so a test can check that a pager stops listening. While a pager
// listens, the cache adds one more listener to the same query.
function Wrapper(props: { children: ReactNode }) {
	return (
		<ConvexProvider client={client}>
			<ConvexQueryCacheProvider maxIdleEntries={0}>{props.children}</ConvexQueryCacheProvider>
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

function activeWatches() {
	return [...watches.values()].filter((watch) => (listeners.get(watch.key)?.size ?? 0) > 0);
}

function answer(watch: Watch, value: PaginationResult<Row> | Error) {
	act(() => {
		answers.set(watch.key, value);
		listeners.get(watch.key)?.forEach((notify) => notify());
	});
}

function page(names: string[], isDone = false, continueCursor = "tail"): PaginationResult<Row> {
	return { page: names.map((name) => ({ name })), isDone, continueCursor };
}

function changedView(reason: "saved_move_view_changed" | "saved_search_view_changed" = "saved_move_view_changed") {
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

describe("useFilesPaginatedQuery", () => {
	test.each(["saved_move_view_changed", "saved_search_view_changed"] as const)(
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

	test("a pager that mounts again shows its cached first page at once", () => {
		function CachingWrapper(props: { children: ReactNode }) {
			return (
				<ConvexProvider client={client}>
					<ConvexQueryCacheProvider>{props.children}</ConvexQueryCacheProvider>
				</ConvexProvider>
			);
		}
		const usePager = () => useFilesPaginatedQuery(query, args, { initialNumItems: 2 });
		const first = renderHook(usePager, { wrapper: CachingWrapper });
		const watch = activeWatches()[0]!;
		answer(watch, page(["a"], true, ""));
		first.unmount();
		expect(listeners.get(watch.key)?.size, "the cache keeps the query subscribed").toBe(1);

		const second = renderHook(usePager, { wrapper: CachingWrapper });
		expect(watches.size, "the second pager uses the same query args").toBe(1);
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
		else expect(first.args.value).toEqual(value);
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
