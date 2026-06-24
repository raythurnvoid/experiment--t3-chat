import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, useQueryMock, useStableQueryMock, actionMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	useStableQueryMock: vi.fn(),
	actionMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useConvex: () => ({ action: actionMock }),
}));

vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: (...args: unknown[]) => useStableQueryMock(...args),
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		files_pending_updates: {
			list_files_pending_updates: "list_files_pending_updates",
			upsert_file_pending_update: "upsert_file_pending_update",
			save_file_pending_update: "save_file_pending_update",
		},
		files_nodes: {
			list_tree: "list_tree",
		},
	},
}));

// Avoid the headless-tiptap decode: map each branch's stored bytes straight to canned Markdown so the
// action handlers see deterministic staged/unstaged content.
vi.mock("@/lib/files.ts", () => ({
	files_yjs_doc_create_from_array_buffer_update: (update: unknown) => update,
	files_yjs_doc_get_markdown: ({ yjsDoc }: { yjsDoc: unknown }) => ({ _yay: yjsDoc as string }),
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: ComponentPropsWithRef<"button">) {
		const { children, ...rest } = props;
		return <button {...rest}>{children}</button>;
	},
	MyButtonIcon: function MyButtonIcon(props: { className?: string; children?: ReactNode }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

vi.mock("@/components/my-icon.tsx", () => ({
	MyIcon: function MyIcon(props: { className?: string; children?: ReactNode }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

vi.mock("@/components/my-icon-button.tsx", () => ({
	MyIconButton: function MyIconButton(props: ComponentPropsWithRef<"button">) {
		const { children, ...rest } = props;
		return <button {...rest}>{children}</button>;
	},
	MyIconButtonIcon: function MyIconButtonIcon(props: { className?: string; children?: ReactNode }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

vi.mock("@/components/my-link.tsx", () => ({
	MyLink: function MyLink(props: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string>;
		className?: string;
		children?: ReactNode;
	}) {
		let href = props.to;
		for (const [key, value] of Object.entries(props.params ?? {})) {
			href = href.replace(`$${key}`, value);
		}
		const query = props.search ? `?${new URLSearchParams(props.search).toString()}` : "";
		return (
			<a href={`${href}${query}`} className={props.className}>
				{props.children}
			</a>
		);
	},
}));

vi.mock("@/components/monospace-block/monospace-block-diff.tsx", () => ({
	DiffMonospaceBlock: function DiffMonospaceBlock(props: { diffText: string; className?: string }) {
		return (
			<pre role="textbox" aria-label="Diff preview" className={props.className}>
				{props.diffText}
			</pre>
		);
	},
}));

import { files_pending_changes_build_rows } from "./file-editor-sidebar-pending-rows.ts";
import { FileEditorSidebarPending } from "./file-editor-sidebar-pending.tsx";

function makePendingUpdate(args: {
	id: string;
	fileNodeId: string;
	staged: string;
	unstaged: string;
}): app_convex_Doc<"files_pending_updates"> {
	return {
		_id: args.id,
		_creationTime: 0,
		workspaceId: "workspace_1",
		projectId: "project_1",
		userId: "user_1",
		fileNodeId: args.fileNodeId,
		baseYjsSequence: 0,
		baseYjsUpdate: "" as never,
		stagedBranchYjsUpdate: args.staged as never,
		unstagedBranchYjsUpdate: args.unstaged as never,
		size: 0,
		updatedAt: 1,
	} as unknown as app_convex_Doc<"files_pending_updates">;
}

function makeNode(args: { id: string; path: string }): app_convex_Doc<"files_nodes"> {
	return {
		_id: args.id,
		_creationTime: 0,
		path: args.path,
		kind: "file",
	} as unknown as app_convex_Doc<"files_nodes">;
}

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"workspaces_projects_users">;

beforeEach(() => {
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		workspaceId: "workspace_1",
		workspaceName: "team",
		projectId: "project_1",
		projectName: "home",
	});
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: null });
	useQueryMock.mockReset();
	useStableQueryMock.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("files_pending_changes_build_rows", () => {
	test("sorts rows by path regardless of input order", () => {
		const updates = [
			makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_m", fileNodeId: "node_m", staged: "s", unstaged: "u" }),
		];
		const nodesById = new Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>([
			["node_z" as app_convex_Id<"files_nodes">, makeNode({ id: "node_z", path: "zebra/notes.md" })],
			["node_a" as app_convex_Id<"files_nodes">, makeNode({ id: "node_a", path: "alpha/intro.md" })],
			["node_m" as app_convex_Id<"files_nodes">, makeNode({ id: "node_m", path: "mid/readme.md" })],
		]);

		const rows = files_pending_changes_build_rows(updates, nodesById);

		expect(rows.map((row) => row.path)).toEqual(["alpha/intro.md", "mid/readme.md", "zebra/notes.md"]);
	});

	test("keeps a fallback label when the file node is missing", () => {
		const updates = [makePendingUpdate({ id: "pu_x", fileNodeId: "node_missing", staged: "s", unstaged: "u" })];
		const rows = files_pending_changes_build_rows(updates, new Map());

		expect(rows).toHaveLength(1);
		expect(rows[0]?.path).toBe("(unknown file)");
	});
});

describe("FileEditorSidebarPending", () => {
	test("renders an empty state when there are no pending updates", () => {
		useQueryMock.mockReturnValue([]);
		useStableQueryMock.mockReturnValue([]);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("No pending changes")).toBeTruthy();
	});

	test("renders items sorted by path with full path visible", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_z", path: "zebra/notes.md" }),
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const paths = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-path")).map(
			(element) => element.textContent,
		);
		expect(paths).toEqual(["alpha/intro.md", "zebra/notes.md"]);
	});

	test("path link opens the file in the diff editor", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = container.querySelector(".FileEditorSidebarPending-item-path");
		const href = link?.getAttribute("href");
		expect(href).toContain("/w/team/home/files");
		expect(href).toContain("nodeId=node_a");
		expect(href).toContain("view=diff_editor");
	});

	test("Accept & save stages the unstaged content then saves", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept & save"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
		});
	});

	test("Discard reverts the unstaged content back to staged", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "STAGED_MD",
			unstagedMarkdown: "STAGED_MD",
		});
	});

	test("Accept all accepts and saves every pending update", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		// 2 rows x (upsert + save) = 4 action calls
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(4));
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "UNSTAGED_A",
			unstagedMarkdown: "UNSTAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
			stagedMarkdown: "UNSTAGED_B",
			unstagedMarkdown: "UNSTAGED_B",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
		});
	});

	test("Discard all reverts every pending update to staged", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		// 2 rows x upsert = 2 action calls, no save
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_a",
			stagedMarkdown: "STAGED_A",
			unstagedMarkdown: "STAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_b",
			stagedMarkdown: "STAGED_B",
			unstagedMarkdown: "STAGED_B",
		});
	});
});
