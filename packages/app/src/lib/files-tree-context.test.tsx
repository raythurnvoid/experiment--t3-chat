import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { FunctionArgs, PaginationResult } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "./app-tenant-context.tsx";
import { FilesTreeProvider } from "./files-tree-context.tsx";

type TreeArgs = FunctionArgs<typeof app_convex_api.files_nodes.list_tree>;
type TestPage = PaginationResult<{ name: string }>;

const pages = new Map<string, TestPage>();
const listeners = new Map<string, Set<() => void>>();
let client: ConvexReactClient;

function page_key(membershipId: string, cursor: string | null, endCursor?: string | null) {
	return JSON.stringify({ membershipId, cursor, endCursor });
}

function receive_page(membershipId: string, cursor: string | null, result: TestPage, endCursor?: string | null) {
	const key = page_key(membershipId, cursor, endCursor);
	act(() => {
		pages.set(key, result);
		listeners.get(key)?.forEach((listener) => listener());
	});
}

function TreeConsumer(props: { label: string }) {
	const nodes = FilesTreeProvider.useContext();
	return (
		<>
			<output aria-label={props.label}>
				{nodes === undefined ? "Loading files" : nodes.map((node) => node.name).join(",")}
			</output>
			{nodes?.some((node) => node.name === "README.md") && (
				<textarea aria-label={`${props.label} README draft`} defaultValue="Saved README" />
			)}
		</>
	);
}

function TestWorkspace(props: { membershipId: string; showTree?: boolean }) {
	return (
		<ConvexProvider client={client}>
			<AppTenantProvider
				membershipId={props.membershipId as app_convex_Id<"organizations_workspaces_users">}
				workspaceId={"workspace_1" as app_convex_Id<"organizations_workspaces">}
				workspaceName="home"
				organizationId={"organization_1" as app_convex_Id<"organizations">}
				organizationName="team"
			>
				{props.showTree !== false && (
					<>
						<TreeConsumer label="Sidebar" />
						<TreeConsumer label="Search" />
					</>
				)}
			</AppTenantProvider>
		</ConvexProvider>
	);
}

beforeEach(() => {
	pages.clear();
	listeners.clear();
	client = new ConvexReactClient("https://tree-test.convex.cloud");
	// Keep the real pagination and subscription hooks. Only replace the server watches.
	vi.spyOn(client, "watchQuery").mockImplementation((_query, args?, _options?) => {
		const { membershipId, paginationOpts } = args as TreeArgs;
		const key = page_key(membershipId, paginationOpts.cursor, paginationOpts.endCursor);
		return {
			onUpdate: (callback) => {
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(key, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => pages.get(key),
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

describe("FilesTreeProvider", () => {
	test("does not subscribe on other workspace screens and stops when all tree consumers close", () => {
		const view = render(<TestWorkspace membershipId="membership_1" showTree={false} />);
		expect(listeners.size).toBe(0);

		view.rerender(<TestWorkspace membershipId="membership_1" />);
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(1);
		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: true, continueCursor: "a" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md");

		view.rerender(<TestWorkspace membershipId="membership_1" showTree={false} />);
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(0);
		pages.clear();
		view.rerender(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, { page: [{ name: "new.md" }], isDone: false, continueCursor: "new" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("Loading files");
	});

	test("shares one tree walk and keeps loading through short and empty pages", () => {
		render(<TestWorkspace membershipId="membership_1" />);
		expect(screen.getByLabelText("Sidebar").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(1);

		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: false, continueCursor: "a" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", "a"))?.size).toBe(1);

		receive_page("membership_1", "a", { page: [], isDone: false, continueCursor: "b" });
		expect(screen.getByLabelText("Search").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", "b"))?.size).toBe(1);

		receive_page("membership_1", "b", { page: [{ name: "c.md" }], isDone: true, continueCursor: "c" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md,c.md");
		expect(screen.getByLabelText("Search").textContent).toBe("a.md,c.md");

		// A changed permission removes a node from its existing subscribed page.
		receive_page("membership_1", null, { page: [], isDone: false, continueCursor: "a" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("c.md");
		expect(screen.getByLabelText("Search").textContent).toBe("c.md");
	});

	test("does not expose the previous workspace while another membership loads", () => {
		const view = render(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, { page: [{ name: "old.md" }], isDone: true, continueCursor: "old" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("old.md");

		view.rerender(<TestWorkspace membershipId="membership_2" />);
		expect(screen.getByLabelText("Sidebar").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(0);
		receive_page("membership_1", null, { page: [{ name: "late.md" }], isDone: true, continueCursor: "late" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("Loading files");

		receive_page("membership_2", null, { page: [{ name: "new.md" }], isDone: true, continueCursor: "new" });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("new.md");
		expect(screen.getByLabelText("Search").textContent).toBe("new.md");
	});

	test("keeps the complete tree and README draft mounted until both replacement pages arrive", () => {
		render(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, {
			page: [{ name: "a.md" }, { name: "README.md" }],
			isDone: true,
			continueCursor: "b",
		});
		const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Sidebar README draft" });
		fireEvent.change(editor, { target: { value: "Unsaved README" } });
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md,README.md");

		receive_page("membership_1", null, {
			page: [{ name: "a.md" }],
			isDone: true,
			continueCursor: "b",
			pageStatus: "SplitRequired",
			splitCursor: "a",
		});
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md,README.md");
		expect(screen.getByRole("textbox", { name: "Sidebar README draft" })).toBe(editor);

		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: false, continueCursor: "a" }, "a");
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md,README.md");
		receive_page("membership_1", "a", { page: [{ name: "README.md" }], isDone: true, continueCursor: "b" }, "b");
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md,README.md");
		expect(screen.getByLabelText("Search").textContent).toBe("a.md,README.md");
		expect(screen.getByRole("textbox", { name: "Sidebar README draft" })).toBe(editor);
		expect(editor.value).toBe("Unsaved README");

		receive_page("membership_1", "a", { page: [], isDone: true, continueCursor: "b" }, "b");
		expect(screen.queryByRole("textbox", { name: "Sidebar README draft" })).toBeNull();
		expect(screen.getByLabelText("Sidebar").textContent).toBe("a.md");
	});
});
