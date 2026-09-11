import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { FilesSearchPalette } from "./files-search-palette.tsx";

type ContentArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_content>;
type ContentResult = FunctionReturnType<typeof app_convex_api.files_nodes.search_content>;

const { treeNodesMock, contentArgsSeen, contentResults, queryPushListeners } = vi.hoisted(() => ({
	treeNodesMock: vi.fn(),
	contentArgsSeen: { current: [] as ContentArgs[] },
	contentResults: new Map<string, ContentResult | Error | undefined>(),
	queryPushListeners: new Set<() => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "team", workspaceName: "home" }),
	},
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useContext: () => treeNodesMock() },
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
				contentQueries.map(([key, request]) => {
					const args = request.args as ContentArgs;
					if ((args.nodeIds?.length ?? 0) > 8192) return [key, new Error("ArrayTooLong")];
					const firstId = args.nodeIds?.[0] ?? "unfiltered";
					return [key, contentResults.has(firstId) ? contentResults.get(firstId) : { results: [] }];
				}),
			);
		},
	};
});

function content_match(index: number) {
	return {
		nodeId: `node_${index}` as app_convex_Id<"files_nodes">,
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
	queryPushListeners.clear();
	treeNodesMock.mockReset().mockReturnValue(
		Array.from({ length: 9001 }, (_, index) => ({
			_id: `node_${index}`,
			name: `file-${index}.md`,
			path: `/file-${index}.md`,
			kind: "file",
			archiveOperationId: null,
		})),
	);
});

afterEach(cleanup);

describe("FilesSearchPalette", () => {
	test("searches every filtered candidate in bounded groups and includes the final group", async () => {
		contentResults.set("node_0", { results: [content_match(0)] });
		contentResults.set("node_9000", { results: [content_match(9000)] });

		await open_search("file.kind:file budget");

		await waitFor(() => expect(contentArgsSeen.current).toHaveLength(10));
		expect(contentArgsSeen.current.every((args) => args.nodeIds!.length <= 1000)).toBe(true);
		expect(contentArgsSeen.current.flatMap((args) => args.nodeIds)).toEqual(
			Array.from({ length: 9001 }, (_, index) => `node_${index}`),
		);
		expect(await screen.findByText("file-0.md")).toBeTruthy();
		expect(await screen.findByText("file-9000.md")).toBeTruthy();
	});

	test("waits for the final group before showing results", async () => {
		contentResults.set("node_0", { results: [content_match(0)] });
		contentResults.set("node_9000", undefined);

		await open_search("file.kind:file budget");

		await waitFor(() => expect(contentArgsSeen.current).toHaveLength(10));
		expect(screen.getByRole("list", { name: "Search results" }).getAttribute("aria-busy")).toBe("true");
		expect(screen.queryByText("file-0.md")).toBeNull();
		act(() => {
			contentResults.set("node_9000", { results: [content_match(9000)] });
			queryPushListeners.forEach((listener) => listener());
		});
		expect(await screen.findByText("file-0.md")).toBeTruthy();
		expect(await screen.findByText("file-9000.md")).toBeTruthy();
	});

	test("shows a failed final group instead of partial results", async () => {
		contentResults.set("node_0", { results: [content_match(0)] });
		contentResults.set("node_1000", undefined);
		contentResults.set("node_9000", new Error("Search failed"));

		await open_search("file.kind:file budget");

		expect(await screen.findByText("Search failed. Try changing your query.")).toBeTruthy();
		expect(screen.queryByText("file-0.md")).toBeNull();
	});

	test("keeps unfiltered text searches as one query", async () => {
		contentResults.set("unfiltered", { results: [content_match(9000)] });

		await open_search("budget");

		expect(await screen.findByText("file-9000.md")).toBeTruthy();
		expect(contentArgsSeen.current).toEqual([{ membershipId: "membership_1", query: "budget" }]);
	});

	test("sends no content query when filters match no files", async () => {
		await open_search("file.kind:folder budget");

		expect(await screen.findByText("No matching files")).toBeTruthy();
		expect(contentArgsSeen.current).toEqual([]);
	});
});
