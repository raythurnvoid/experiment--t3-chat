import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type PaginationResult } from "convex/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "./app-tenant-context.tsx";
import { FilesTreeProvider } from "./files-tree-context.tsx";

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

type TestRow = { _id: string; parentId: string; name: string };
type TestPage = PaginationResult<TestRow | { name: string }>;

const results = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
let client: ConvexReactClient;

/**
 * Key one watched query by its name, its args, and its page cursors. The pagination session id and
 * page size change between runs, so they are left out.
 */
function watch_key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as {
		paginationOpts?: { cursor: string | null; endCursor?: string | null };
	};
	const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify({ name, ...sorted, cursor: paginationOpts?.cursor, endCursor: paginationOpts?.endCursor });
}

function page_key(membershipId: string, cursor: string | null, endCursor?: string | null) {
	return watch_key(getFunctionName(app_convex_api.files_nodes.list_tree), {
		membershipId,
		paginationOpts: { cursor, endCursor },
	});
}

function children_key(parentId: string, kind: "folder" | "file", cursor: string | null, archived = false) {
	return watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_children), {
		membershipId: "membership_1",
		parentId,
		kind,
		archived,
		paginationOpts: { cursor },
	});
}

function shared_roots_key(archived = false) {
	return watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_shared_roots), {
		membershipId: "membership_1",
		archived,
	});
}

function ancestors_key(nodeId: string) {
	return watch_key(getFunctionName(app_convex_api.files_nodes.get_tree_ancestors), {
		membershipId: "membership_1",
		nodeId,
	});
}

function receive(key: string, result: unknown) {
	act(() => {
		results.set(key, result);
		listeners.get(key)?.forEach((listener) => listener());
	});
}

function receive_page(membershipId: string, cursor: string | null, result: TestPage, endCursor?: string | null) {
	receive(page_key(membershipId, cursor, endCursor), result);
}

function row(id: string, parentId = "root") {
	return { _id: id, parentId, name: id };
}

function TreeConsumer(props: { label: string }) {
	const nodes = FilesTreeProvider.useFullList(true);
	return (
		<>
			<output aria-label={props.label}>
				{nodes === undefined ? "Loading files" : nodes.map((node) => node.name).join(",")}
			</output>
			{nodes?.some((node) => node.name === "README.md") && (
				<textarea aria-label={`${props.label} draft`} defaultValue="Saved README" />
			)}
		</>
	);
}

function FoldersConsumer(props: { folderIds: string[]; archived?: boolean; pinnedNodeIds?: string[] }) {
	const folders = FilesTreeProvider.useFolders({
		folderIds: props.folderIds as app_convex_Id<"files_nodes">[],
		archived: props.archived ?? false,
		pinnedNodeIds: props.pinnedNodeIds ?? [],
	});
	return (
		<>
			<output aria-label="Rows">
				{folders.rows === undefined ? "Loading files" : folders.rows.map((node) => node._id).join(",")}
			</output>
			<output aria-label="Status">
				{[...folders.statusByFolderId].map(([folderId, status]) => `${folderId}:${status}`).join(",")}
			</output>
			<output aria-label="Hoisted">{[...folders.hoistedIds].join(",")}</output>
			{props.folderIds.map((folderId) => (
				<button
					key={folderId}
					type="button"
					onClick={() => folders.loadMore(folderId as app_convex_Id<"files_nodes">)}
				>{`More ${folderId}`}</button>
			))}
		</>
	);
}

function TestWorkspace(props: { membershipId: string; showTree?: boolean; children?: ReactNode }) {
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
						<TreeConsumer label="Mentions" />
						<TreeConsumer label="Search" />
					</>
				)}
				{props.children}
			</AppTenantProvider>
		</ConvexProvider>
	);
}

beforeEach(() => {
	results.clear();
	listeners.clear();
	client = new ConvexReactClient("https://tree-test.convex.cloud");
	// Keep the real pagination and subscription hooks. Only replace the server watches.
	vi.spyOn(client, "watchQuery").mockImplementation((query, args?, _options?) => {
		const key = watch_key(getFunctionName(query), args as Record<string, unknown>);
		return {
			onUpdate: (callback) => {
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(key, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => results.get(key) as never,
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

describe("FilesTreeProvider.useFullList", () => {
	test("does not subscribe on other workspace screens and stops when all tree consumers close", () => {
		const view = render(<TestWorkspace membershipId="membership_1" showTree={false} />);
		expect(listeners.size).toBe(0);

		view.rerender(<TestWorkspace membershipId="membership_1" />);
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(1);
		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: true, continueCursor: "a" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md");

		view.rerender(<TestWorkspace membershipId="membership_1" showTree={false} />);
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(0);
		results.clear();
		view.rerender(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, { page: [{ name: "new.md" }], isDone: false, continueCursor: "new" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("Loading files");
	});

	test("shares one tree walk and keeps loading through short and empty pages", () => {
		render(<TestWorkspace membershipId="membership_1" />);
		expect(screen.getByLabelText("Mentions").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(1);

		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: false, continueCursor: "a" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", "a"))?.size).toBe(1);

		receive_page("membership_1", "a", { page: [], isDone: false, continueCursor: "b" });
		expect(screen.getByLabelText("Search").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", "b"))?.size).toBe(1);

		receive_page("membership_1", "b", { page: [{ name: "c.md" }], isDone: true, continueCursor: "c" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md,c.md");
		expect(screen.getByLabelText("Search").textContent).toBe("a.md,c.md");

		// A changed permission removes a node from its existing subscribed page.
		receive_page("membership_1", null, { page: [], isDone: false, continueCursor: "a" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("c.md");
		expect(screen.getByLabelText("Search").textContent).toBe("c.md");
	});

	test("does not expose the previous workspace while another membership loads", () => {
		const view = render(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, { page: [{ name: "old.md" }], isDone: true, continueCursor: "old" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("old.md");

		view.rerender(<TestWorkspace membershipId="membership_2" />);
		expect(screen.getByLabelText("Mentions").textContent).toBe("Loading files");
		expect(listeners.get(page_key("membership_1", null))?.size).toBe(0);
		receive_page("membership_1", null, { page: [{ name: "late.md" }], isDone: true, continueCursor: "late" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("Loading files");

		receive_page("membership_2", null, { page: [{ name: "new.md" }], isDone: true, continueCursor: "new" });
		expect(screen.getByLabelText("Mentions").textContent).toBe("new.md");
		expect(screen.getByLabelText("Search").textContent).toBe("new.md");
	});

	test("keeps the complete list and an open draft mounted until both replacement pages arrive", () => {
		render(<TestWorkspace membershipId="membership_1" />);
		receive_page("membership_1", null, {
			page: [{ name: "a.md" }, { name: "README.md" }],
			isDone: true,
			continueCursor: "b",
		});
		const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Mentions draft" });
		fireEvent.change(editor, { target: { value: "Unsaved README" } });
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md,README.md");

		receive_page("membership_1", null, {
			page: [{ name: "a.md" }],
			isDone: true,
			continueCursor: "b",
			pageStatus: "SplitRequired",
			splitCursor: "a",
		});
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md,README.md");
		expect(screen.getByRole("textbox", { name: "Mentions draft" })).toBe(editor);

		receive_page("membership_1", null, { page: [{ name: "a.md" }], isDone: false, continueCursor: "a" }, "a");
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md,README.md");
		receive_page("membership_1", "a", { page: [{ name: "README.md" }], isDone: true, continueCursor: "b" }, "b");
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md,README.md");
		expect(screen.getByLabelText("Search").textContent).toBe("a.md,README.md");
		expect(screen.getByRole("textbox", { name: "Mentions draft" })).toBe(editor);
		expect(editor.value).toBe("Unsaved README");

		receive_page("membership_1", "a", { page: [], isDone: true, continueCursor: "b" }, "b");
		expect(screen.queryByRole("textbox", { name: "Mentions draft" })).toBeNull();
		expect(screen.getByLabelText("Mentions").textContent).toBe("a.md");
	});
});

describe("FilesTreeProvider.useFolders", () => {
	test("loads the root folders and files together, and never the full list", () => {
		render(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(screen.getByLabelText("Rows").textContent).toBe("Loading files");
		expect(listeners.has(page_key("membership_1", null))).toBe(false);
		expect(listeners.get(children_key("root", "folder", null))?.size).toBe(1);
		expect(listeners.get(children_key("root", "file", null))?.size).toBe(1);

		receive(shared_roots_key(), { rows: [], truncated: false });
		receive(children_key("root", "folder", null), { page: [row("docs")], isDone: true, continueCursor: "d" });
		// Wait for both kinds, so the files never show before the folders above them.
		expect(screen.getByLabelText("Rows").textContent).toBe("Loading files");

		receive(children_key("root", "file", null), { page: [row("a.md")], isDone: true, continueCursor: "a" });
		expect(screen.getByLabelText("Rows").textContent).toBe("docs,a.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
	});

	test("pages an open folder on demand and closes its pagers when it closes", () => {
		const view = render(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={["people"]} />
			</TestWorkspace>,
		);
		receive(shared_roots_key(), { rows: [], truncated: false });
		receive(children_key("root", "folder", null), { page: [row("people")], isDone: true, continueCursor: "p" });
		receive(children_key("root", "file", null), { page: [], isDone: true, continueCursor: "" });
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:loading");

		receive(children_key("people", "folder", null), { page: [], isDone: true, continueCursor: "" });
		receive(children_key("people", "file", null), {
			page: [row("ann.md", "people")],
			isDone: false,
			continueCursor: "ann",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("people,ann.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:more");
		expect(listeners.has(children_key("people", "file", "ann"))).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "More people" }));
		expect(listeners.get(children_key("people", "file", "ann"))?.size).toBe(1);
		receive(children_key("people", "file", "ann"), {
			page: [row("bob.md", "people")],
			isDone: true,
			continueCursor: "b",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("people,ann.md,bob.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:done");

		view.rerender(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(listeners.get(children_key("people", "file", null))?.size).toBe(0);
		expect(screen.getByLabelText("Rows").textContent).toBe("people");
	});

	test("keeps a folder's rows while Convex splits one of its pages", () => {
		render(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		receive(shared_roots_key(), { rows: [], truncated: false });
		receive(children_key("root", "folder", null), { page: [], isDone: true, continueCursor: "" });
		receive(children_key("root", "file", null), {
			page: [row("a.md"), row("b.md")],
			isDone: true,
			continueCursor: "c",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");

		receive(children_key("root", "file", null), {
			page: [row("a.md")],
			isDone: true,
			continueCursor: "c",
			pageStatus: "SplitRequired",
			splitCursor: "a",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
	});

	test("shows shared roots and pinned ancestors at the top when their parent is not readable", () => {
		render(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} pinnedNodeIds={["deep.md"]} />
			</TestWorkspace>,
		);
		receive(shared_roots_key(), { rows: [row("shared", "hidden")], truncated: false });
		receive(children_key("root", "folder", null), { page: [], isDone: true, continueCursor: "" });
		receive(children_key("root", "file", null), { page: [], isDone: true, continueCursor: "" });
		expect(screen.getByLabelText("Rows").textContent).toBe("shared");
		expect(screen.getByLabelText("Hoisted").textContent).toBe("shared");

		receive(ancestors_key("deep.md"), {
			node: row("deep.md", "inner"),
			ancestors: [row("outer", "secret"), row("inner", "outer")],
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("shared,outer,inner,deep.md");
		expect(screen.getByLabelText("Hoisted").textContent).toBe("shared,outer");
	});

	test("adds the archived pagers only while archived rows are shown", () => {
		const view = render(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(listeners.has(children_key("root", "folder", null, true))).toBe(false);
		expect(listeners.has(shared_roots_key(true))).toBe(false);

		view.rerender(
			<TestWorkspace membershipId="membership_1" showTree={false}>
				<FoldersConsumer folderIds={[]} archived />
			</TestWorkspace>,
		);
		expect(listeners.get(children_key("root", "folder", null, true))?.size).toBe(1);
		expect(listeners.get(shared_roots_key(true))?.size).toBe(1);
	});
});
