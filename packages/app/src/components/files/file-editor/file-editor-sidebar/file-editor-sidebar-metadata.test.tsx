import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, useQueryMock, mutationMock, editorChangeRef, editorOptionsRef, editorValues, editorHandle } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	editorChangeRef: { current: null as ((value: string | undefined) => void) | null },
	editorOptionsRef: { current: null as Record<string, unknown> | null },
	editorValues: [] as string[],
	editorHandle: {
		options: {} as { readOnly?: boolean },
		updateOptions(next: { readOnly?: boolean }) {
			Object.assign(editorHandle.options, next);
		},
	},
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
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		files_metadata: {
			get_entries: "get_entries",
			set_entries: "set_entries",
		},
		files_nodes: {
			get_current_user_file_write_permission: "get_current_user_file_write_permission",
			get_node_read_only_management_state: "get_node_read_only_management_state",
		},
	},
}));

// Monaco owns a real code editor and a web worker. Stand in a textarea that reports the same value
// and calls the same onChange, so the panel's own draft handling is what these tests exercise. The
// stand-in also hands over an editor handle through onMount, because the panel pushes readOnly to
// that handle instead of through the options object, and a mock that never mounts would let that
// wiring disappear without a test noticing.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect } = await import("react");

	return {
		Editor: function Editor(props: {
			value?: string;
			onChange?: (value: string | undefined) => void;
			onMount?: (editor: unknown) => void;
			options?: Record<string, unknown>;
		}) {
			editorChangeRef.current = props.onChange ?? null;
			editorOptionsRef.current = props.options ?? null;
			editorValues.push(props.value ?? "");
			const onMount = props.onMount;

			useEffect(() => {
				onMount?.(editorHandle);
			}, [onMount]);

			return <textarea aria-label="File metadata YAML" readOnly value={props.value ?? ""} />;
		},
	};
});

vi.mock("@/lib/app-monaco-config.ts", () => ({
	app_monaco_THEME_NAME_DARK: "app-files-monaco-theme-dark",
}));

import { FileEditorSidebarMetadata } from "./file-editor-sidebar-metadata.tsx";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

const NODE = {
	_id: "node_1",
	_creationTime: 1_700_000_000_000,
	organizationId: "organization_1",
	workspaceId: "workspace_1",
	path: "/docs/notes.md",
	name: "notes.md",
	kind: "file",
	parentId: "root",
	createdBy: "user_1",
	updatedBy: "user_1",
	updatedAt: 1_700_000_000_000,
} as unknown as app_convex_Doc<"files_nodes">;

function mockQueries(args: {
	entries?: { key: string; value: string | number | boolean }[] | undefined;
	canWrite?: boolean | undefined;
	readOnlyState?: "writable" | "self" | "inherited";
}) {
	useQueryMock.mockImplementation((query: unknown) => {
		if (query === "get_entries") {
			return args.entries;
		}
		if (query === "get_current_user_file_write_permission") {
			return args.canWrite;
		}
		if (query === "get_node_read_only_management_state") {
			return {
				nodeId: NODE._id,
				canManage: true,
				readOnlyState: args.readOnlyState ?? "writable",
				hasInheritedParentLock: false,
				source: null,
			};
		}
		return undefined;
	});
}

// Render the way the app does. StrictMode runs state updaters twice, which is what catches an
// updater that is not pure — a ref written inside one made the panel report a false conflict.
function renderPanel() {
	return render(<FileEditorSidebarMetadata node={NODE} />, { wrapper: StrictMode });
}

function typeDraft(value: string) {
	act(() => {
		editorChangeRef.current?.(value);
	});
}

function clickSave() {
	act(() => {
		screen.getByRole("button", { name: "Save metadata" }).click();
	});
}

/**
 * Push a new stored map the way the reactive query would. The node prop has to be a fresh object,
 * or the memoized component keeps its old render and never reads the query mock again.
 */
async function pushServerEntries(
	rerender: (ui: ReactElement) => void,
	entries: { key: string; value: string | number | boolean }[],
) {
	mockQueries({ entries, canWrite: true });
	await act(async () => {
		rerender(<FileEditorSidebarMetadata node={{ ...NODE }} />);
	});
}

let monacoHoistingContainer: HTMLDivElement;

beforeEach(() => {
	// The app shell renders this host; Monaco overflow widgets are hoisted into it, and the panel
	// shows a skeleton until it exists.
	monacoHoistingContainer = document.createElement("div");
	monacoHoistingContainer.id = "app_monaco_hoisting_container";
	document.body.append(monacoHoistingContainer);
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	useQueryMock.mockReset();
	useQueryMock.mockReturnValue(undefined);
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: null });
	editorChangeRef.current = null;
	editorValues.length = 0;
	editorHandle.options = {};
});

afterEach(() => {
	cleanup();
	monacoHoistingContainer.remove();
});

describe("FileEditorSidebarMetadata", () => {
	test("shows the stored map as YAML and keeps Save disabled until the draft changes", () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });

		renderPanel();

		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toContain("created-by: slack");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);

		typeDraft("created-by: email\n");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(false);
	});

	test("mounts the editor on the stored YAML, not an empty draft", () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });

		renderPanel();

		expect(editorValues[0]).toContain("created-by: slack");
	});

	// The same rule on the cold path: the query has no answer yet on the first render, so the
	// skeleton must hold until the draft carries the stored map. Mounting the editor as soon as the
	// map arrives would create it empty and fill it one render later.
	test("waits for the stored map instead of mounting the editor empty", async () => {
		mockQueries({ entries: undefined, canWrite: true });
		const { rerender } = renderPanel();

		expect(editorValues).toEqual([]);

		await pushServerEntries(rerender, [{ key: "created-by", value: "slack" }]);

		expect(editorValues[0]).toContain("created-by: slack");
	});

	test("refuses an invalid draft in the panel and never calls the mutation", async () => {
		mockQueries({ entries: [], canWrite: true });

		renderPanel();
		typeDraft("owner:\n  name: nested\n");
		clickSave();

		expect(mutationMock).not.toHaveBeenCalled();
		expect((await screen.findByRole("alert")).textContent).toContain("must have a text, number, or true/false value");
	});

	test("saves the draft YAML through set_entries", () => {
		mockQueries({ entries: [], canWrite: true });

		renderPanel();
		typeDraft("created-by: agent\n");
		clickSave();

		expect(mutationMock).toHaveBeenCalledWith("set_entries", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: "node_1",
			metadataYaml: "created-by: agent\n",
		});
	});

	test("blocks saving on a read-only file and says why", () => {
		mockQueries({ entries: [], canWrite: true, readOnlyState: "inherited" });

		renderPanel();
		typeDraft("created-by: agent\n");

		expect(screen.getByRole("status").textContent).toBe("This file is read-only.");
		const save = screen.getByRole("button", { name: "Save metadata" });
		// Native `disabled` drops the button from the tab order, so a keyboard user never reaches
		// the reason. Keep it focusable with `aria-disabled`, the same way the users page does.
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
	});

	test("blocks saving without write permission and names the permission first", () => {
		mockQueries({ entries: [], canWrite: false, readOnlyState: "inherited" });

		renderPanel();

		expect(screen.getByRole("status").textContent).toBe("You don't have permission to edit this file.");
		const save = screen.getByRole("button", { name: "Save metadata" });
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
	});

	// Monaco traps Tab by default, which leaves a keyboard user stuck inside this small field with no
	// way to reach Save. Live QA found the trap; this pins the option that opens it.
	test("lets Tab leave the editor instead of typing a tab character", () => {
		mockQueries({ entries: [], canWrite: true });

		renderPanel();

		expect(editorOptionsRef.current?.tabFocusMode).toBe(true);
	});

	test("makes the editor itself read-only, not only the Save button", () => {
		mockQueries({ entries: [], canWrite: true, readOnlyState: "inherited" });

		renderPanel();

		expect(editorHandle.options.readOnly).toBe(true);
	});

	test("leaves the editor writable when the file is writable", () => {
		mockQueries({ entries: [], canWrite: true });

		renderPanel();

		expect(editorHandle.options.readOnly).toBe(false);
	});

	// The stored map is re-rendered as YAML on every push, so the text that comes back is almost never
	// the text that was sent. The editor uses CRLF and drops nothing. The map drops comments and
	// re-quotes values. Without this the panel treated its own save as somebody else's edit.
	test("adopts the server rendering of its own save instead of warning about a conflict", async () => {
		mockQueries({ entries: [], canWrite: true });
		const { rerender } = renderPanel();

		typeDraft("created-by: agent");
		clickSave();

		await pushServerEntries(rerender, [{ key: "created-by", value: "agent" }]);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("Metadata saved");
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);
	});

	// A draft that already reads like the stored map needs no re-rendering, so it lands on the branch
	// that clears a resolved conflict. That branch must not swallow the save confirmation.
	test("still confirms a save whose text the server did not have to re-render", async () => {
		mockQueries({ entries: [], canWrite: true });
		const { rerender } = renderPanel();

		typeDraft("created-by: agent\n");
		clickSave();

		await pushServerEntries(rerender, [{ key: "created-by", value: "agent" }]);

		expect(screen.getByRole("status").textContent).toBe("Metadata saved");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);
	});

	test("keeps an unsaved draft and warns when somebody else changes the metadata", async () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });
		const { rerender } = renderPanel();

		typeDraft("created-by: me\n");
		await pushServerEntries(rerender, [{ key: "created-by", value: "agent" }]);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Metadata changed elsewhere. Review this draft before saving it over the newer version.",
		);
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: me\n");
	});

	test("follows the server when the draft was never touched", async () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });
		const { rerender } = renderPanel();

		await pushServerEntries(rerender, [{ key: "created-by", value: "agent" }]);

		expect(screen.queryByRole("alert")).toBeNull();
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
	});
});
