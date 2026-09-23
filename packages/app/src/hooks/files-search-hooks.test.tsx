import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_api, app_convex_Id } from "@/lib/app-convex-client.ts";
import { useFilesVisibleEntries } from "./files-search-hooks.ts";

type VisibleResult = FunctionReturnType<typeof app_convex_api.files_visible.list>;

// `firstPageEnd` lets a test move the end of the first page, like a write before it does on the server.
const { cursorsSeen, pageEnds } = vi.hoisted(() => ({ cursorsSeen: [] as string[], pageEnds: { firstPageEnd: 50 } }));

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

// Answer each `files_visible.list` page at once. The cursor is the index of the page's first entry.
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQueries: (queries: Record<string, { query: FunctionReference<"query">; args: Record<string, unknown> }>) =>
		Object.fromEntries(
			Object.entries(queries).map(([key, request]) => {
				const cursor = String(request.args.cursor ?? "0");
				if (!cursorsSeen.includes(cursor)) cursorsSeen.push(cursor);
				const start = Number(cursor);
				const end = start === 0 ? pageEnds.firstPageEnd : start + Number(request.args.numItems);
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
}));

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

beforeEach(() => {
	cursorsSeen.length = 0;
	pageEnds.firstPageEnd = 50;
});

afterEach(() => {
	cleanup();
});

describe("useFilesVisibleEntries", () => {
	test("incremental mode returns the first page and loads the next page only on loadMore", async () => {
		const { result } = renderHook(() => useFilesVisibleEntries(MEMBERSHIP_ID, "/folder", "children", "incremental"));

		expect(result.current.entries).toEqual(ENTRIES.slice(0, 50));
		expect(result.current.isDone).toBe(false);
		// Give a pending timer the chance to ask for more pages. Incremental mode must not.
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(cursorsSeen).toEqual(["0"]);

		act(() => result.current.loadMore());
		expect(result.current.entries).toEqual(ENTRIES.slice(0, 100));
		expect(result.current.isDone).toBe(false);
		expect(cursorsSeen).toEqual(["0", "50"]);

		act(() => result.current.loadMore());
		expect(result.current.entries).toEqual(ENTRIES);
		expect(result.current.isDone).toBe(true);

		act(() => result.current.loadMore());
		expect(cursorsSeen).toEqual(["0", "50", "100"]);
		expect(result.current.entries).toEqual(ENTRIES);
	});

	test("incremental mode loads the pages it was asked for again when an earlier page changes", async () => {
		const { result, rerender } = renderHook(() =>
			useFilesVisibleEntries(MEMBERSHIP_ID, "/folder", "children", "incremental"),
		);
		act(() => result.current.loadMore());
		act(() => result.current.loadMore());
		expect(result.current.entries).toEqual(ENTRIES);

		// The first page now ends one entry earlier, so every later cursor changes.
		pageEnds.firstPageEnd = 49;
		rerender();

		await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));
		expect(result.current.isDone).toBe(true);
		expect(cursorsSeen).toEqual(["0", "50", "100", "49", "99"]);
	});

	test("complete mode returns entries only after every page is loaded", async () => {
		const { result } = renderHook(() => useFilesVisibleEntries(MEMBERSHIP_ID, "/folder", "children"));

		expect(result.current.entries).toBeUndefined();
		expect(result.current.isDone).toBe(false);
		await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));
		expect(result.current.isDone).toBe(true);
		expect(cursorsSeen).toEqual(["0", "50", "100"]);
	});
});
