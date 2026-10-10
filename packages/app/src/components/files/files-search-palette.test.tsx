import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import type { app_convex_api } from "@/lib/app-convex-client.ts";
import { FilesSearchPalette } from "./files-search-palette.tsx";

type SavedArgs = FunctionArgs<typeof app_convex_api.files_nodes.search_saved>;
type SavedRow = FunctionReturnType<typeof app_convex_api.files_nodes.search_saved>["page"][number];

// `savedPages` answers `search_saved` by its clause and folder: each entry is one server page, and
// `undefined` keeps the first page loading. A query with no entry is empty and done.
const { savedArgsSeen, savedPages, queryPushListeners, navigateMock } = vi.hoisted(() => ({
	savedArgsSeen: [] as SavedArgs[],
	savedPages: new Map<string, SavedRow[][] | undefined>(),
	queryPushListeners: new Set<() => void>(),
	navigateMock: vi.fn().mockResolvedValue(undefined),
}));

const saved_key = (clause: SavedArgs["clause"], folderPath?: string) => JSON.stringify([clause, folderPath ?? null]);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigateMock,
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "team", workspaceName: "home" }),
	},
}));

// Keep the real palette, filters, and loading UI. Replace only the query boundary.
vi.mock("convex/react", async (importOriginal) => {
	const { useEffect, useState } = await import("react");
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useConvex: () => ({ query: async () => [] }),
		// Only the input's suggestions use `useQueries` and `useQuery` here. They stay empty.
		useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((key) => [key, []])),
		useQuery: (query: FunctionReference<"query">, args: unknown) =>
			args === "skip"
				? undefined
				: getFunctionName(query) === "files_nodes:get_workspace_move_view"
					? { generation: 1, cohortId: null, view: null, searchGeneration: 1 }
					: null,
		usePaginatedQuery: (query: FunctionReference<"query">, args: SavedArgs | "skip") => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((count) => count + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			const key = args === "skip" ? "skip" : saved_key(args.clause, args.folderPath);
			const [loaded, setLoaded] = useState({ key, pageCount: 1 });
			const pageCount = loaded.key === key ? loaded.pageCount : 1;
			// The input's key and value suggestions page the metadata catalog. They stay empty.
			if (getFunctionName(query).startsWith("files_metadata:")) {
				return { results: [], status: "Exhausted", isLoading: false, loadMore: () => {} };
			}
			if (args === "skip") {
				return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
			}
			savedArgsSeen.push(args);
			const pages = savedPages.has(key) ? savedPages.get(key) : [[]];
			if (pages === undefined) {
				return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
			}
			return {
				results: pages.slice(0, pageCount).flat(),
				status: pageCount >= pages.length ? "Exhausted" : "CanLoadMore",
				isLoading: false,
				loadMore: () => setLoaded({ key, pageCount: pageCount + 1 }),
			};
		},
	};
});

const saved_row = (path: string, extra: Partial<{ textChunk: string; lineStart: number }> = {}) =>
	({ kind: "file", nodeId: `node${path}`, path, ...extra }) as SavedRow;

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
	savedArgsSeen.length = 0;
	savedPages.clear();
	queryPushListeners.clear();
	navigateMock.mockClear();
});

afterEach(cleanup);

describe("FilesSearchPalette", () => {
	test("plain text shows a Names list and a Contents list, each with its count", async () => {
		savedPages.set(saved_key({ kind: "name", text: "budget" }), [
			[saved_row("/a/budget.md"), saved_row("/b/budget-2026.md")],
			[saved_row("/c/budget-old.md")],
		]);
		savedPages.set(saved_key({ kind: "content", text: "budget" }), [
			[saved_row("/notes.md", { textChunk: "The budget is ready.", lineStart: 4 })],
		]);
		await open_search("budget");

		const names = await screen.findByRole("group", { name: "Names" });
		const contents = screen.getByRole("group", { name: "Contents" });
		expect(within(names).getByText("2+ matches")).toBeTruthy();
		expect(within(names).getByRole("button", { name: /budget\.md/ })).toBeTruthy();
		expect(within(contents).getByText("1 match")).toBeTruthy();
		expect(within(contents).getByText("The budget is ready.")).toBeTruthy();
		expect(screen.getByText("More matches may be available · Add more words to narrow the search")).toBeTruthy();

		// Show more loads the next page. When it is the last one, focus moves to the first new row.
		const showMore = within(names).getByRole("button", { name: "Show more" });
		act(() => showMore.focus());
		fireEvent.click(showMore);
		await waitFor(() => expect(within(names).getByText("3 matches")).toBeTruthy());
		expect(within(names).queryByRole("button", { name: "Show more" })).toBeNull();
		expect(document.activeElement).toBe(within(names).getByRole("button", { name: /budget-old\.md/ }));
		expect(screen.getByText("↑ ↓ Navigate · Enter Open · Esc Close")).toBeTruthy();
	});

	test("counts a file that matches by name and by contents once", async () => {
		savedPages.set(saved_key({ kind: "name", text: "budget" }), [
			[saved_row("/a/budget.md"), saved_row("/b/budget.md")],
		]);
		savedPages.set(saved_key({ kind: "content", text: "budget" }), [
			[saved_row("/a/budget.md", { textChunk: "budget" }), saved_row("/notes.md", { textChunk: "budget" })],
		]);
		await open_search("budget");
		await screen.findByRole("group", { name: "Names" });

		// The status shows in the input and to screen readers.
		expect(screen.getAllByText("3 matches").length).toBeGreaterThan(0);
	});

	test("Enter opens the first Names row", async () => {
		savedPages.set(saved_key({ kind: "name", text: "budget" }), [
			[saved_row("/a/budget.md"), saved_row("/b/budget.md")],
		]);
		savedPages.set(saved_key({ kind: "content", text: "budget" }), [[saved_row("/notes.md", { textChunk: "budget" })]]);
		await open_search("budget");
		await screen.findByRole("button", { name: /\/a\/budget\.md/ });

		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock.mock.calls.at(-1)?.[0].search({ q: "budget" })).toEqual({
			q: "budget",
			nodeId: "node/a/budget.md",
		});
	});

	test("with a folder, names search inside it and Contents says why it is empty", async () => {
		savedPages.set(saved_key({ kind: "name", text: "plan" }, "/docs"), [[saved_row("/docs/plan.md")]]);
		await open_search("file.path:/docs plan");

		const contents = await screen.findByRole("group", { name: "Contents" });
		expect(
			within(contents).getByText(
				"Contents search does not work inside a folder. Remove the folder to search contents.",
			),
		).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "Names" })).getByRole("button", { name: /plan\.md/ })).toBeTruthy();
		expect(savedArgsSeen.some((args) => args.clause.kind === "content")).toBe(false);
	});

	test("shows the problem the search answered for its list", async () => {
		savedPages.set(saved_key({ kind: "name", text: "plan" }, "/missing"), [
			[{ kind: "problem", message: "Folder not found" }],
		]);
		await open_search("file.path:/missing plan");

		const names = await screen.findByRole("group", { name: "Names" });
		expect(await within(names).findByText("Folder not found")).toBeTruthy();
		expect(within(names).queryByText(/match/)).toBeNull();
	});

	test("a pasted draft link says how to open it, and Enter opens the draft", async () => {
		await open_search("http://localhost/w/team/home/files?pendingNodeId=draft_1");

		expect(await screen.findByText("This is a link to a draft. Press Enter to open it.")).toBeTruthy();
		expect(savedArgsSeen).toEqual([]);
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock.mock.calls.at(-1)?.[0].search({ q: "old" })).toEqual({ q: "old", pendingNodeId: "draft_1" });
	});

	test("an exact path shows its one row", async () => {
		savedPages.set(saved_key({ kind: "path", path: "/docs/plan.md" }), [[saved_row("/docs/plan.md")]]);
		await open_search("/docs/plan.md");

		const matches = await screen.findByRole("group", { name: "Matches" });
		expect(within(matches).getByText("1 match")).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Contents" })).toBeNull();
	});

	test("Enter right after pasting a path or a draft link opens it at once, and a node id link waits", async () => {
		await open_search("/docs/plan.md");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock.mock.calls.at(-1)?.[0]).toMatchObject({
			to: "/w/$organizationName/$workspaceName/files/$",
			params: { _splat: "/docs/plan.md" },
		});
		cleanup();

		await open_search("http://localhost/w/team/home/files?pendingNodeId=draft_1");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock.mock.calls.at(-1)?.[0].search({})).toEqual({ q: undefined, pendingNodeId: "draft_1" });
		cleanup();

		// The node may be in another workspace, so Enter waits for the search, which checks it.
		await open_search("http://localhost/w/team/home/files?nodeId=node_1");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock).toHaveBeenCalledTimes(2);
		expect(screen.getByText(/Still searching/)).toBeTruthy();
	});

	test("a metadata filter shows one list and keeps Use filters in sidebar", async () => {
		const filterRows = [saved_row("/tasks/a.md")];
		savedPages.set(saved_key({ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.status", value: "open" } }), [
			filterRows,
		]);
		await open_search("metadata.status:open");
		// The first Enter turns the typed filter into a chip.
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

		const matches = await screen.findByRole("group", { name: "Matches" });
		expect(await within(matches).findByRole("button", { name: /a\.md/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Use filters in sidebar" })).toBeTruthy();
	});

	test("a date in a folder says it matches only the same text", async () => {
		savedPages.set(
			saved_key({ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.due", value: "2026-09-04" } }, "/docs"),
			[[saved_row("/docs/a.md")]],
		);
		await open_search("file.path:/docs metadata.due:2026-09-04");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

		const matches = await screen.findByRole("group", { name: "Matches" });
		expect(await within(matches).findByRole("button", { name: /a.md/ })).toBeTruthy();
		expect(within(matches).getByText("In a folder, a date matches only values written the same way.")).toBeTruthy();
	});

	test("a finished list at the index limit says it shows the top matches", async () => {
		savedPages.set(saved_key({ kind: "name", text: "log" }), [
			Array.from({ length: 1024 }, (_, index) => saved_row(`/logs/log-${index}.txt`)),
		]);
		await open_search("log");

		const names = await screen.findByRole("group", { name: "Names" });
		expect(within(names).getByText("1024 matches")).toBeTruthy();
		expect(within(names).getByText("Showing the top 1,024 matches. Add more words to narrow the search.")).toBeTruthy();
	});

	test("waits for the names before Enter opens a row", async () => {
		savedPages.set(saved_key({ kind: "name", text: "budget" }), undefined);
		await open_search("budget");
		const names = await screen.findByRole("group", { name: "Names" });
		expect(names.getAttribute("aria-busy")).toBe("true");

		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock).not.toHaveBeenCalled();
		expect(screen.getByText(/Still searching/)).toBeTruthy();
		act(() => {
			savedPages.set(saved_key({ kind: "name", text: "budget" }), [[saved_row("/budget.md")]]);
			queryPushListeners.forEach((listener) => listener());
		});
		await within(names).findByRole("button", { name: /budget\.md/ });
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(navigateMock).toHaveBeenCalledTimes(1);
	});
});
