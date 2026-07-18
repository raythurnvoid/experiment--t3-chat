import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, useQueryMock, useStableQueryMock, actionMock, mutationMock, truncatePathForWidthMock } =
	vi.hoisted(() => ({
		tenantContextMock: vi.fn(),
		useQueryMock: vi.fn(),
		useStableQueryMock: vi.fn(),
		actionMock: vi.fn(),
		mutationMock: vi.fn(),
		truncatePathForWidthMock: vi.fn((args: { path: string }) => args.path),
	}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useConvex: () => ({ action: actionMock, mutation: mutationMock }),
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
			apply_file_pending_move: "apply_file_pending_move",
			discard_file_pending_structural: "discard_file_pending_structural",
		},
		files_nodes: {
			list_tree: "list_tree",
		},
	},
}));

// Avoid the headless-tiptap decode: map each branch's stored bytes straight to canned Markdown so the
// action handlers see deterministic staged/unstaged content. The type guard mirrors the real shared
// implementation (presence of the 4 Yjs fields).
vi.mock("@/lib/files.ts", () => ({
	files_ROOT_ID: "root",
	files_pending_update_has_yjs_content: (
		row:
			| {
					baseYjsSequence?: unknown;
					baseYjsUpdate?: unknown;
					stagedBranchYjsUpdate?: unknown;
					unstagedBranchYjsUpdate?: unknown;
			  }
			| null
			| undefined,
	) =>
		row != null &&
		row.baseYjsSequence !== undefined &&
		row.baseYjsUpdate !== undefined &&
		row.stagedBranchYjsUpdate !== undefined &&
		row.unstagedBranchYjsUpdate !== undefined,
	files_yjs_doc_create_from_array_buffer_update: (update: unknown) => update,
	files_yjs_doc_get_markdown: ({ yjsDoc }: { yjsDoc: unknown }) => ({ _yay: yjsDoc as string }),
}));

vi.mock("@/lib/file-paths.ts", () => ({
	files_truncate_path_for_width: (args: { path: string; width: number; font: string; letterSpacing: number }) =>
		truncatePathForWidthMock(args),
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
		"aria-label"?: string;
		title?: string;
		children?: ReactNode;
	}) {
		let href = props.to;
		for (const [key, value] of Object.entries(props.params ?? {})) {
			href = href.replace(`$${key}`, value);
		}
		const query = props.search ? `?${new URLSearchParams(props.search).toString()}` : "";
		return (
			<a href={`${href}${query}`} aria-label={props["aria-label"]} title={props.title}>
				<span className={props.className}>{props.children}</span>
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
	staged?: string;
	unstaged?: string;
	pendingMove?: { destParentId: string; destName: string; fromPath: string; replacesNodeId?: string };
	copiedFrom?: { nodeId: string; path: string };
	eagerCreated?: { committedSequence: number };
}): app_convex_Doc<"files_pending_updates"> {
	return {
		_id: args.id,
		_creationTime: 0,
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		userId: "user_1",
		fileNodeId: args.fileNodeId,
		// Structural-only rows leave all 4 Yjs fields unset, like the server does.
		...(args.staged != null && args.unstaged != null
			? {
					baseYjsSequence: 0,
					baseYjsUpdate: "" as never,
					stagedBranchYjsUpdate: args.staged as never,
					unstagedBranchYjsUpdate: args.unstaged as never,
				}
			: {}),
		...(args.pendingMove ? { pendingMove: args.pendingMove } : {}),
		...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
		...(args.eagerCreated ? { eagerCreated: args.eagerCreated } : {}),
		size: 0,
		updatedAt: 1,
	} as unknown as app_convex_Doc<"files_pending_updates">;
}

function makeNode(args: { id: string; path: string; kind?: "file" | "folder" }): app_convex_Doc<"files_nodes"> {
	return {
		_id: args.id,
		_creationTime: 0,
		path: args.path,
		kind: args.kind ?? "file",
	} as unknown as app_convex_Doc<"files_nodes">;
}

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

beforeEach(() => {
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: null });
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: null });
	truncatePathForWidthMock.mockReset();
	truncatePathForWidthMock.mockImplementation((args: { path: string }) => args.path);
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

	test("derives row kinds from field presence", () => {
		const pendingMove = { destParentId: "root", destName: "dest.md", fromPath: "/from.md" };
		const updates = [
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_move", fileNodeId: "node_b", pendingMove }),
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_c",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
			makePendingUpdate({ id: "pu_mixed", fileNodeId: "node_d", staged: "s", unstaged: "u", pendingMove }),
		];
		const nodesById = new Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>([
			["node_a" as app_convex_Id<"files_nodes">, makeNode({ id: "node_a", path: "/a.md" })],
			["node_b" as app_convex_Id<"files_nodes">, makeNode({ id: "node_b", path: "/b.md" })],
			["node_c" as app_convex_Id<"files_nodes">, makeNode({ id: "node_c", path: "/c.md" })],
			["node_d" as app_convex_Id<"files_nodes">, makeNode({ id: "node_d", path: "/d.md" })],
		]);

		const rows = files_pending_changes_build_rows(updates, nodesById);

		expect(rows.map((row) => row.kind)).toEqual(["content", "move", "copy", "content_and_move"]);
	});

	test("resolves the move destination path from the tree", () => {
		const updates = [
			makePendingUpdate({
				id: "pu_root",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "a.md", fromPath: "/from/a.md" },
			}),
			makePendingUpdate({
				id: "pu_nested",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "node_docs", destName: "b.md", fromPath: "/from/b.md" },
			}),
			makePendingUpdate({
				id: "pu_missing",
				fileNodeId: "node_c",
				pendingMove: { destParentId: "node_gone", destName: "c.md", fromPath: "/from/c.md" },
			}),
		];
		const nodesById = new Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>([
			["node_a" as app_convex_Id<"files_nodes">, makeNode({ id: "node_a", path: "/from/a.md" })],
			["node_b" as app_convex_Id<"files_nodes">, makeNode({ id: "node_b", path: "/from/b.md" })],
			["node_c" as app_convex_Id<"files_nodes">, makeNode({ id: "node_c", path: "/from/c.md" })],
			["node_docs" as app_convex_Id<"files_nodes">, makeNode({ id: "node_docs", path: "/docs", kind: "folder" })],
		]);

		const rows = files_pending_changes_build_rows(updates, nodesById);

		expect(rows.map((row) => row.moveDestinationPath)).toEqual(["/a.md", "/docs/b.md", "…/c.md"]);
	});

	test("keeps the node kind and falls back to fromPath when the source node is missing", () => {
		const updates = [
			makePendingUpdate({
				id: "pu_folder",
				fileNodeId: "node_folder",
				pendingMove: { destParentId: "root", destName: "archive", fromPath: "/old-archive" },
			}),
			makePendingUpdate({
				id: "pu_gone",
				fileNodeId: "node_gone",
				pendingMove: { destParentId: "root", destName: "gone.md", fromPath: "/from/gone.md" },
			}),
		];
		const nodesById = new Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>([
			[
				"node_folder" as app_convex_Id<"files_nodes">,
				makeNode({ id: "node_folder", path: "/old-archive", kind: "folder" }),
			],
		]);

		const rows = files_pending_changes_build_rows(updates, nodesById);

		expect(rows[0]?.path).toBe("/from/gone.md");
		expect(rows[0]?.nodeKind).toBeUndefined();
		expect(rows[1]?.path).toBe("/old-archive");
		expect(rows[1]?.nodeKind).toBe("folder");
	});

	test("marks rows whose proposal created the file as added", () => {
		const updates = [
			makePendingUpdate({
				id: "pu_added",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				eagerCreated: { committedSequence: 0 },
			}),
			makePendingUpdate({ id: "pu_edit", fileNodeId: "node_b", staged: "s", unstaged: "u" }),
		];
		const nodesById = new Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>([
			["node_a" as app_convex_Id<"files_nodes">, makeNode({ id: "node_a", path: "/a.md" })],
			["node_b" as app_convex_Id<"files_nodes">, makeNode({ id: "node_b", path: "/b.md" })],
		]);

		const rows = files_pending_changes_build_rows(updates, nodesById);

		expect(rows.map((row) => row.isAddedFile)).toEqual([true, false]);
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

		const paths = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-path-text")).map(
			(element) => element.textContent,
		);
		expect(paths).toEqual(["alpha/intro.md", "zebra/notes.md"]);
	});

	test("path link opens the file in the diff editor and preserves the full path metadata", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/deeply/nested/intro.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "alpha/deeply/nested/intro.md" });
		const href = link?.getAttribute("href");
		expect(href).toContain("/w/team/home/files");
		expect(href).toContain("nodeId=node_a");
		expect(href).toContain("view=diff_editor");
		expect(link.getAttribute("aria-label")).toBe("alpha/deeply/nested/intro.md");
		expect(link.getAttribute("title")).toBe("alpha/deeply/nested/intro.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text")?.textContent).toBe(
			"alpha/deeply/nested/intro.md",
		);
	});

	test("truncates visible path text while preserving full path metadata", () => {
		const path = "alpha/deeply/nested/intro.md";
		const truncatedPath = "alpha/de…/intro.md";
		const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(80);
		truncatePathForWidthMock.mockReturnValue(truncatedPath);
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: path });
		const pathText = container.querySelector(".FileEditorSidebarPending-item-path-text");
		expect(pathText?.textContent).toBe(truncatedPath);
		expect(link.getAttribute("aria-label")).toBe(path);
		expect(link.getAttribute("title")).toBe(path);
		expect(truncatePathForWidthMock).toHaveBeenCalledWith({
			path,
			width: 80,
			font: expect.stringContaining("system-ui"),
			letterSpacing: 0,
		});

		clientWidthSpy.mockRestore();
	});

	test("Accept stages the unstaged content then saves", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

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

	test("move row renders from → dest without an accordion or diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /docs/a.md" });
		const href = link.getAttribute("href");
		expect(href).toContain("nodeId=node_a");
		expect(href).not.toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
		expect(container.querySelector("details")).toBeNull();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("added row shows the green Added caption and path and keeps the diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/recorded.md" },
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/copy.md" }),
			makeNode({ id: "node_src", path: "/source.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Added");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")?.textContent).toBe("/copy.md");
		const link = screen.getByRole("link", { name: "/copy.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(container.querySelector("details")).toBeTruthy();
	});

	test("replace-copy row shows the Replaced caption without the green path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_replace_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/target.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test("plain edit rows show the Modified caption without the green path", () => {
		useQueryMock.mockReturnValue([makePendingUpdate({ id: "pu_edit", fileNodeId: "node_a", staged: "s", unstaged: "u" })]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Modified");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test("mixed row keeps the accordion and shows the from → dest move label", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /b.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
		expect(container.querySelector("details")).toBeTruthy();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("move replace row shows the Replaced caption", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
	});

	test("mixed replace row shows the Replaced caption instead of Added", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(screen.queryByText("Added")).toBeNull();
	});

	test("move Accept applies the pending move with a single mutation", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_move",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("move Discard issues a single structural discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_move",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("copy Discard issues only the structural discard, never the content-revert upsert", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_copy",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("eagerly created file Discard issues only the structural discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_added",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				eagerCreated: { committedSequence: 0 },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/new.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_added",
		});
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("copy Accept keeps the existing upsert + save pair", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_copy",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_copy",
		});
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("mixed Accept applies the move first, then accepts and saves the content", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
		});
		expect(actionMock).toHaveBeenNthCalledWith(1, "upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
			stagedMarkdown: "UNSTAGED_MD",
			unstagedMarkdown: "UNSTAGED_MD",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
		});
		expect(mutationMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(actionMock.mock.invocationCallOrder[0] ?? 0);
	});

	test("mixed Discard reverts the content first, then discards the move", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenCalledTimes(1);
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
			stagedMarkdown: "STAGED_MD",
			unstagedMarkdown: "STAGED_MD",
		});
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_mixed",
		});
		expect(actionMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(mutationMock.mock.invocationCallOrder[0] ?? 0);
	});

	test("Accept all routes each row through its kind dispatcher", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "c.md", fromPath: "/b.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		// content row → upsert + save; move row → one mutation
		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(2));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("apply_file_pending_move", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_move",
		});
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
			stagedMarkdown: "UNSTAGED_A",
			unstagedMarkdown: "UNSTAGED_A",
		});
		expect(actionMock).toHaveBeenCalledWith("save_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
		});
	});

	test("Discard all routes each row through its kind dispatcher", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_b",
				staged: "STAGED_B",
				unstaged: "UNSTAGED_B",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		useStableQueryMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		// content row → content-revert upsert; copy row → one structural discard mutation
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(actionMock).toHaveBeenCalledTimes(1);
		expect(actionMock).toHaveBeenCalledWith("upsert_file_pending_update", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_a",
			pendingUpdateId: "pu_content",
			stagedMarkdown: "STAGED_A",
			unstagedMarkdown: "STAGED_A",
		});
		expect(mutationMock).toHaveBeenCalledWith("discard_file_pending_structural", {
			membershipId: MEMBERSHIP_ID,
			nodeId: "node_b",
			pendingUpdateId: "pu_copy",
		});
	});
});
