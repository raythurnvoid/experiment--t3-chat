import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { FilesSearchPalette } from "./files-search-palette.tsx";

type ContentArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_content>;
type ContentResult = FunctionReturnType<typeof app_convex_api.files_nodes.search_content>;
type VisibleResult = FunctionReturnType<typeof app_convex_api.files_visible.list>;
type MetadataResult = FunctionReturnType<typeof app_convex_api.files_metadata.search_nodes>;

// The 9,001-file fixture loads 181 owner pages before content search can start.
const SEARCH_TIMEOUT = 15_000;

const {
	visibleEntriesMock,
	visibleCursorsSeen,
	contentArgsSeen,
	contentResults,
	visibleResults,
	metadataResults,
	queryPushListeners,
	navigateMock,
} = vi.hoisted(() => ({
	visibleEntriesMock: vi.fn(),
	visibleCursorsSeen: new Set<string>(),
	contentArgsSeen: { current: [] as ContentArgs[] },
	contentResults: new Map<string, ContentResult | Error | undefined>(),
	visibleResults: new Map<string, VisibleResult | Error | undefined>(),
	metadataResults: new Map<string, MetadataResult | Error | undefined>(),
	queryPushListeners: new Set<() => void>(),
	navigateMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "team", workspaceName: "home" }),
	},
}));

// Keep the real palette, filters, and loading UI. Replace only the query boundary.
vi.mock("convex/react", async (importOriginal) => {
	const { useEffect, useState } = await import("react");
	const { getFunctionName } = await import("convex/server");
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useConvex: () => ({ query: async () => [] }),
		useQueries: (queries: Record<string, { query: FunctionReference<"query">; args: Record<string, unknown> }>) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((count) => count + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			const contentQueries = Object.entries(queries).filter(
				([, request]) => getFunctionName(request.query) === "files_nodes:search_content",
			);
			if (contentQueries.length > 0) {
				contentArgsSeen.current = contentQueries.map(([, request]) => request.args as ContentArgs);
			}
			return Object.fromEntries(
				Object.entries(queries).map(([key, request]) => {
					const name = getFunctionName(request.query);
					if (name === "files_visible:list") {
						const cursor = String(request.args.cursor ?? "0");
						visibleCursorsSeen.add(cursor);
						if (visibleResults.has(cursor)) return [key, visibleResults.get(cursor)];
						const entries: NonNullable<VisibleResult["_yay"]>["items"] = visibleEntriesMock();
						const start = Number(cursor);
						const end = start + Number(request.args.numItems);
						return [
							key,
							{
								_yay: {
									items: entries.slice(start, end),
									continueCursor: end < entries.length ? String(end) : null,
									isDone: end >= entries.length,
								},
							},
						];
					}
					if (name === "files_metadata:search_nodes")
						return [key, metadataResults.get(key) ?? { targets: [], truncated: false }];
					if (name !== "files_nodes:search_content") return [key, []];
					const args = request.args as ContentArgs;
					if ((args.targets?.length ?? 0) > 8192) return [key, new Error("ArrayTooLong")];
					const firstId = args.targets?.[0]?.id ?? "unfiltered";
					return [key, contentResults.has(firstId) ? contentResults.get(firstId) : { results: [], truncated: false }];
				}),
			);
		},
	};
});

function content_match(index: number) {
	return {
		target: { kind: "saved" as const, id: `node_${index}` as app_convex_Id<"files_nodes"> },
		path: `/file-${index}.md`,
		textChunk: "Budget details are ready.",
		lineStart: 1,
		matchCount: 1,
	};
}

async function open_search(query: string) {
	render(
		<AppHotkeysProvider>
			<FilesSearchPalette />
		</AppHotkeysProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Search files (Ctrl+Shift+F)" }));
	fireEvent.change(await screen.findByRole("combobox"), { target: { value: query } });
}

beforeEach(() => {
	contentArgsSeen.current = [];
	contentResults.clear();
	visibleResults.clear();
	visibleCursorsSeen.clear();
	metadataResults.clear();
	queryPushListeners.clear();
	navigateMock.mockClear();
	visibleEntriesMock.mockReset().mockReturnValue(
		Array.from({ length: 9001 }, (_, index) => ({
			target: { kind: "saved", id: `node_${index}` },
			name: `file-${index}.md`,
			path: `/file-${index}.md`,
			kind: "file",
			updatedAt: 1,
			updatedBy: "user_1",
			contentType: "text/markdown",
			preparing: false,
		})),
	);
});

afterEach(cleanup);

describe("FilesSearchPalette", () => {
	test("searches every filtered candidate in bounded groups and includes the final group", async () => {
		contentResults.set("node_0", { results: [content_match(0)], truncated: false });
		contentResults.set("node_9000", { results: [content_match(9000)], truncated: false });

		await open_search("file.kind:file budget");

		await waitFor(() => expect(contentArgsSeen.current).toHaveLength(10), { timeout: SEARCH_TIMEOUT });
		expect(contentArgsSeen.current.every((args) => args.targets!.length <= 1000)).toBe(true);
		expect(contentArgsSeen.current.flatMap((args) => args.targets)).toEqual(
			Array.from({ length: 9001 }, (_, index) => ({ kind: "saved", id: `node_${index}` })),
		);
		expect(await screen.findByText("file-0.md")).toBeTruthy();
		expect(await screen.findByText("file-9000.md")).toBeTruthy();
	});

	test("waits for the final group before showing results", async () => {
		contentResults.set("node_0", { results: [content_match(0)], truncated: false });
		contentResults.set("node_9000", undefined);

		await open_search("file.kind:file budget");

		await waitFor(() => expect(contentArgsSeen.current).toHaveLength(10), { timeout: SEARCH_TIMEOUT });
		expect(screen.getByRole("list", { name: "Search results" }).getAttribute("aria-busy")).toBe("true");
		expect(screen.queryByText("file-0.md")).toBeNull();
		act(() => {
			contentResults.set("node_9000", { results: [content_match(9000)], truncated: false });
			queryPushListeners.forEach((listener) => listener());
		});
		expect(await screen.findByText("file-0.md")).toBeTruthy();
		expect(await screen.findByText("file-9000.md")).toBeTruthy();
	});

	test("shows a failed final group instead of partial results", async () => {
		contentResults.set("node_0", { results: [content_match(0)], truncated: false });
		contentResults.set("node_1000", undefined);
		contentResults.set("node_9000", new Error("Search failed"));

		await open_search("file.kind:file budget");

		expect(
			await screen.findByText("Search failed. Try changing your query.", {}, { timeout: SEARCH_TIMEOUT }),
		).toBeTruthy();
		expect(screen.queryByText("file-0.md")).toBeNull();
	});

	test("keeps unfiltered text searches as one query", async () => {
		contentResults.set("unfiltered", { results: [content_match(9000)], truncated: false });

		await open_search("budget");

		expect(await screen.findByText("file-9000.md", {}, { timeout: SEARCH_TIMEOUT })).toBeTruthy();
		expect(contentArgsSeen.current).toEqual([{ membershipId: "membership_1", query: "budget" }]);
	});

	test("sends no content query when filters match no files", async () => {
		await open_search("file.kind:folder budget");

		expect(await screen.findByText("No matching files", {}, { timeout: SEARCH_TIMEOUT })).toBeTruthy();
		expect(contentArgsSeen.current).toEqual([]);
	});

	test("waits for the final owner page before treating filters as complete", async () => {
		visibleResults.set("9000", undefined);
		await open_search("file.kind:file budget");
		await waitFor(() => expect(visibleCursorsSeen.has("9000")).toBe(true), { timeout: SEARCH_TIMEOUT });
		expect(screen.getByRole("list", { name: "Search results" }).getAttribute("aria-busy")).toBe("true");
		expect(contentArgsSeen.current).toEqual([]);
		act(() => {
			visibleResults.delete("9000");
			queryPushListeners.forEach((listener) => listener());
		});
		await waitFor(() => expect(contentArgsSeen.current).toHaveLength(10), { timeout: SEARCH_TIMEOUT });
		expect(contentArgsSeen.current.at(-1)?.targets).toEqual([{ kind: "saved", id: "node_9000" }]);
	});

	test("opens a private name match with its private target", async () => {
		visibleEntriesMock.mockReturnValue([
			{
				target: { kind: "private", id: "private_1" },
				name: "Draft folder",
				path: "/Draft folder",
				kind: "folder",
				updatedAt: 1,
				updatedBy: "user_1",
				contentType: null,
				preparing: false,
			},
		]);
		await open_search("Draft");
		fireEvent.click(await screen.findByRole("button", { name: /Draft folder/ }));
		const call = navigateMock.mock.calls.at(-1)?.[0];
		expect(call.search({ nodeId: "old_saved", q: "keep-filter" })).toEqual({
			pendingNodeId: "private_1",
			q: "keep-filter",
		});
	});

	test("searches private content with a tagged filter candidate", async () => {
		const target = { kind: "private" as const, id: "private_1" as app_convex_Id<"files_pending_nodes"> };
		visibleEntriesMock.mockReturnValue([
			{
				target,
				name: "draft.txt",
				path: "/draft.txt",
				kind: "file",
				updatedAt: 1,
				updatedBy: "user_1",
				contentType: "text/plain",
				preparing: false,
			},
		]);
		contentResults.set("private_1", {
			results: [{ ...content_match(1), target, path: "/draft.txt" }],
			truncated: false,
		});
		await open_search("file.kind:file budget");
		expect(await screen.findByText("draft.txt")).toBeTruthy();
		expect(contentArgsSeen.current).toEqual([{ membershipId: "membership_1", query: "budget", targets: [target] }]);
	});

	test("does not show a negated metadata result when its query is truncated", async () => {
		visibleEntriesMock.mockReturnValue([
			{
				target: { kind: "private", id: "private_1" },
				name: "Draft",
				path: "/Draft",
				kind: "folder",
				updatedAt: 1,
				updatedBy: "user_1",
				contentType: null,
				preparing: false,
			},
		]);
		metadataResults.set("!status:open", { targets: [], truncated: true });
		await open_search("!status:open");
		expect(await screen.findByText("Search failed. Try changing your query.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Draft/ })).toBeNull();
		expect(contentArgsSeen.current).toEqual([]);
	});
});
