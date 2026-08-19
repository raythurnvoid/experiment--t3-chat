import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, useQueryMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

// Network boundary: the real hook talks to a live Convex client; tests feed query data directly.
vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL), and the
// codegen'd api object is a Proxy; plain-string function refs keep call assertions readable.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		r2: {
			get_asset_by_file_node_id: "get_asset_by_file_node_id",
		},
		users: {
			get_anagraphic: "get_anagraphic",
		},
	},
}));

// The sidebar mounts every tab panel (Ariakit only hides the unselected ones), so the Agent and
// Pending panels would pull their whole query stack into this test. The gating under test does
// not involve them.
vi.mock("@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx", () => ({
	FileEditorSidebarAgent: function FileEditorSidebarAgent() {
		return <div data-testid="agent-panel" />;
	},
}));
vi.mock("@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx", () => ({
	FileEditorSidebarPending: function FileEditorSidebarPending() {
		return <div data-testid="pending-panel" />;
	},
}));
vi.mock("@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx", () => ({
	FILE_EDITOR_SIDEBAR_TAB_ID_PENDING: "app_file_editor_sidebar_tabs_pending",
	FileEditorSidebarPendingTabBadge: function FileEditorSidebarPendingTabBadge() {
		return null;
	},
}));

import { FileEditorSidebar } from "./file-editor-sidebar.tsx";
import { FileEditorSidebarDetails } from "./file-editor-sidebar-details.tsx";
import { app_local_storage_get_value, app_local_storage_set_value } from "@/lib/storage.ts";
import { users_SYSTEM_AUTHOR } from "../../../../../shared/users.ts";

function makeNode(args: {
	id: string;
	name: string;
	path: string;
	kind?: "file" | "folder";
	yjsRootKind?: "rich_text" | "plain_text";
	contentType?: string;
	hasEditableYjsState?: boolean;
	createdBy?: string;
	updatedBy?: string;
}): app_convex_Doc<"files_nodes"> {
	return {
		_id: args.id,
		_creationTime: 1_700_000_000_000,
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		path: args.path,
		name: args.name,
		kind: args.kind ?? "file",
		parentId: "root",
		assetId: `asset_${args.id}`,
		...(args.hasEditableYjsState === false
			? {}
			: {
					yjsSnapshotId: `snapshot_${args.id}`,
					yjsLastSequenceId: `sequence_${args.id}`,
				}),
		...(args.yjsRootKind ? { yjsRootKind: args.yjsRootKind } : {}),
		...(args.contentType ? { contentType: args.contentType } : {}),
		createdBy: args.createdBy ?? "user_1",
		updatedBy: args.updatedBy ?? "user_1",
		updatedAt: 1_700_000_000_000,
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
	useQueryMock.mockReset();
	useQueryMock.mockReturnValue(undefined);
	// The storage module caches values per key at module level, so reset through its own setter.
	app_local_storage_set_value("app_state::files_last_tab", null);
});

afterEach(() => {
	cleanup();
});

describe("FileEditorSidebar", () => {
	test("a plain text node shows Details instead of Comments and selects it by default", () => {
		const node = makeNode({ id: "node_json", name: "config.json", path: "docs/config.json", yjsRootKind: "plain_text" });

		render(<FileEditorSidebar node={node} commentsContainerRef={() => {}} />);

		expect(screen.getByRole("tab", { name: "Details", selected: true })).toBeTruthy();
		expect(screen.queryByRole("tab", { name: "Comments" })).toBeNull();
		// The Details panel content is mounted for the selected tab.
		expect(screen.getByRole("region", { name: "File details" })).toBeTruthy();
	});

	test("a rich text node keeps the Comments tab", () => {
		const node = makeNode({ id: "node_md", name: "notes.md", path: "docs/notes.md", yjsRootKind: "rich_text" });

		render(<FileEditorSidebar node={node} commentsContainerRef={() => {}} />);

		expect(screen.getByRole("tab", { name: "Comments", selected: true })).toBeTruthy();
		expect(screen.queryByRole("tab", { name: "Details" })).toBeNull();
	});

	test("a stored file without editable state keeps the Comments tab", () => {
		const node = makeNode({ id: "node_png", name: "photo.png", path: "docs/photo.png", hasEditableYjsState: false });

		render(<FileEditorSidebar node={node} commentsContainerRef={() => {}} />);

		expect(screen.getByRole("tab", { name: "Comments", selected: true })).toBeTruthy();
		expect(screen.queryByRole("tab", { name: "Details" })).toBeNull();
	});

	test("a stored Comments selection falls back to Details without being overwritten", () => {
		app_local_storage_set_value("app_state::files_last_tab", "app_file_editor_sidebar_tabs_comments");
		const node = makeNode({ id: "node_yaml", name: "deploy.yaml", path: "ops/deploy.yaml", yjsRootKind: "plain_text" });

		render(<FileEditorSidebar node={node} commentsContainerRef={() => {}} />);

		// The hidden tab falls back to the first available one for this node...
		expect(screen.getByRole("tab", { name: "Details", selected: true })).toBeTruthy();
		// ...but the stored selection stays, so a rich-text file restores the user's real choice.
		expect(app_local_storage_get_value("app_state::files_last_tab")).toBe("app_file_editor_sidebar_tabs_comments");
	});

	test("a stored Agent selection survives the plain-text tab swap", () => {
		app_local_storage_set_value("app_state::files_last_tab", "app_file_editor_sidebar_tabs_agent");
		const node = makeNode({ id: "node_json", name: "config.json", path: "docs/config.json", yjsRootKind: "plain_text" });

		render(<FileEditorSidebar node={node} commentsContainerRef={() => {}} />);

		expect(screen.getByRole("tab", { name: "Agent", selected: true })).toBeTruthy();
	});
});

describe("FileEditorSidebarDetails", () => {
	test("renders the seven populated metadata rows for a converted upload", () => {
		useQueryMock.mockImplementation((query: unknown, args: unknown) => {
			if (query === "get_asset_by_file_node_id") {
				return { size: 2048 };
			}
			if (query === "get_anagraphic") {
				return args === "skip" ? undefined : { displayName: "Ada Lovelace" };
			}
			return undefined;
		});
		const node = makeNode({
			id: "node_json",
			name: "config.json",
			path: "docs/config.json",
			yjsRootKind: "plain_text",
			contentType: "application/json",
			createdBy: "user_created",
			updatedBy: users_SYSTEM_AUTHOR,
		});

		const { container } = render(<FileEditorSidebarDetails node={node} />);

		const labels = Array.from(container.querySelectorAll(".FileEditorSidebarDetails-label")).map(
			(element) => element.textContent,
		);
		expect(labels).toEqual(["Content type", "Size", "Location", "Created", "Created by", "Last edited", "Last edited by"]);
		const rowValue = (label: string) =>
			Array.from(container.querySelectorAll(".FileEditorSidebarDetails-row"))
				.find((row) => row.querySelector(".FileEditorSidebarDetails-label")?.textContent === label)
				?.querySelector(".FileEditorSidebarDetails-value")?.textContent;
		expect(rowValue("Content type")).toBe("application/json");
		expect(rowValue("Size")).toBe("2.0 KB");
		expect(rowValue("Location")).toBe("docs");
		expect(rowValue("Created by")).toBe("Ada Lovelace");
		expect(rowValue("Last edited by")).toBe("System");

		expect(useQueryMock).toHaveBeenCalledWith("get_asset_by_file_node_id", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: "node_json",
		});
		// A SYSTEM author has no user doc, so its anagraphic query must be skipped.
		expect(useQueryMock).toHaveBeenCalledWith("get_anagraphic", { userId: "user_created" });
		expect(useQueryMock).toHaveBeenCalledWith("get_anagraphic", "skip");
	});

	test("shows the size as Unknown for an in-app file without an asset", () => {
		useQueryMock.mockImplementation((query: unknown, args: unknown) => {
			if (query === "get_asset_by_file_node_id") {
				return null;
			}
			if (query === "get_anagraphic") {
				return args === "skip" ? undefined : { displayName: "Ada Lovelace" };
			}
			return undefined;
		});
		const node = makeNode({
			id: "node_txt",
			name: "notes.txt",
			path: "/notes.txt",
			yjsRootKind: "plain_text",
			contentType: "text/plain",
		});

		const { container } = render(<FileEditorSidebarDetails node={node} />);

		const sizeRow = Array.from(container.querySelectorAll(".FileEditorSidebarDetails-row")).find(
			(row) => row.querySelector(".FileEditorSidebarDetails-label")?.textContent === "Size",
		);
		expect(sizeRow?.querySelector(".FileEditorSidebarDetails-value")?.textContent).toBe("Unknown");
		// A root-level file shows the root as its location.
		const locationRow = Array.from(container.querySelectorAll(".FileEditorSidebarDetails-row")).find(
			(row) => row.querySelector(".FileEditorSidebarDetails-label")?.textContent === "Location",
		);
		expect(locationRow?.querySelector(".FileEditorSidebarDetails-value")?.textContent).toBe("/");
	});

	test("shows skeleton rows while the queries load", () => {
		useQueryMock.mockReturnValue(undefined);
		const node = makeNode({ id: "node_json", name: "config.json", path: "docs/config.json", yjsRootKind: "plain_text" });

		const { container } = render(<FileEditorSidebarDetails node={node} />);

		expect(container.querySelectorAll(".FileEditorSidebarDetails-row")).toHaveLength(7);
		expect(container.querySelectorAll(".FileEditorSidebarDetails-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText("Content type")).toBeNull();
	});
});
