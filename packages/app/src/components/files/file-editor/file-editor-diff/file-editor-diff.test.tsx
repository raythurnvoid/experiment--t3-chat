import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, convexQueryMock, convexActionMock, monacoHarness } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	convexQueryMock: vi.fn(),
	convexActionMock: vi.fn(),
	// Shared state between the DiffEditor stub and the tests: the models the component created
	// (original first, then modified) and the change listeners it put on the modified pane.
	monacoHarness: {
		createdModels: [] as Array<{ getValue: () => string; setValue: (next: string) => void }>,
		changeListeners: [] as Array<() => void>,
	},
}));

// Network boundary: the collaborative diff editor reads through these hooks. Nothing in this file
// mounts it, but the module imports them at load time.
vi.mock("convex/react", () => ({
	useConvex: () => ({}),
	useQuery: () => undefined,
}));

vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: () => undefined,
}));

// Spy target: tests assert on the toasts the editor shows.
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), warning: vi.fn() },
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL).
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		query: (...args: unknown[]) => convexQueryMock(...args),
		action: (...args: unknown[]) => convexActionMock(...args),
	},
	app_convex_api: {
		files_nodes_content: {
			get_non_collaborative_file_content: "get_non_collaborative_file_content",
			replace_file_content: "replace_file_content",
		},
	},
}));

// Keep the real module. The model factory wrapper records each created model, which is how a test
// reads the two panes and edits the modified one.
vi.mock("@/lib/files.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/files.ts")>();
	return {
		...original,
		files_monaco_create_editor_model: (text: string, languageId: string) => {
			const model = original.files_monaco_create_editor_model(text, languageId);
			monacoHarness.createdModels.push(model as never);
			return model;
		},
	};
});

// The real component loads the Monaco runtime. The stub hands the component the small slice of the
// diff editor API it uses, and `executeEdits` reports "not applied" so the component's model-level
// fallback runs on the real models the test can read.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect } = await import("react");
	return {
		// The app Monaco config calls loader.config at import time.
		loader: { config: () => {} },
		DiffEditor: function DiffEditor(props: { onMount?: (editor: never, monaco: never) => void }) {
			const { onMount } = props;
			useEffect(() => {
				const fakePane = {
					updateOptions: () => {},
					onDidChangeModelContent: (listener: () => void) => {
						monacoHarness.changeListeners.push(listener);
						return { dispose() {} };
					},
					pushUndoStop: () => {},
					executeEdits: () => false,
				};
				const fakeEditor = {
					updateOptions: () => {},
					getModel: () => null,
					setModel: () => {},
					dispose: () => {},
					getOriginalEditor: () => fakePane,
					getModifiedEditor: () => fakePane,
				};
				onMount?.(fakeEditor as never, {} as never);
			}, []);
			return <div data-testid="monaco-diff-editor" />;
		},
	};
});

// The view zone drives real Monaco view-zone APIs the fake editor does not have.
vi.mock("../file-editor-monaco-top-view-zone.tsx", () => ({
	FileEditorMonacoTopViewZone: function FileEditorMonacoTopViewZone() {
		return null;
	},
}));

// The snapshots modal and comments sidebar pull their own query stacks; not under test here.
vi.mock("../file-editor-snapshots-modal.tsx", () => ({
	FileEditorSnapshotsModal: function FileEditorSnapshotsModal() {
		return null;
	},
}));
vi.mock("../file-editor-comments-sidebar.tsx", () => ({
	FileEditorCommentsSidebar: function FileEditorCommentsSidebar() {
		return null;
	},
}));

import { FileEditorDiffNonCollab } from "./file-editor-diff.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_markdown" as app_convex_Id<"files_nodes">;
const BASE_ASSET_ID = "asset_committed" as app_convex_Id<"files_r2_assets">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Answer the committed-content query the way the server does for a file with collaboration off.
 */
function resolveQueryWithNonCollaborativeContent(text: string, assetId = BASE_ASSET_ID) {
	convexQueryMock.mockResolvedValue({ _yay: { text, yjsRootKind: "rich_text", assetId } });
}

function renderNonCollabDiffEditor(args?: { editable?: boolean }) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	const rendered = render(
		<FileEditorDiffNonCollab
			nodeId={NODE_ID}
			editable={args?.editable ?? true}
			monacoLanguageId="markdown"
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
		/>,
	);
	return { ...rendered, toolbarPortalHost };
}

/**
 * Flush the content query and the editor mount that follows it.
 */
async function flushEditorMount() {
	await act(async () => {});
	await act(async () => {});
}

function getPanes() {
	const [original, modified] = monacoHarness.createdModels;
	if (!original || !modified) {
		throw new Error("Expected the mounted editor to have created both panes");
	}

	return { original, modified };
}

/**
 * Edit the modified pane the way a member typing in it would, then let the 250 ms dirty debounce
 * land. The component subscribes to the pane editor, not to the model, so the change event has to
 * come from the stub's listener list.
 */
async function typeIntoModifiedPane(text: string) {
	act(() => {
		getPanes().modified.setValue(text);
		monacoHarness.changeListeners.forEach((listener) => listener());
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(250);
	});
}

beforeEach(() => {
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	convexQueryMock.mockReset();
	convexActionMock.mockReset();
	monacoHarness.createdModels.length = 0;
	monacoHarness.changeListeners.length = 0;
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
	cleanup();
});

describe("FileEditorDiffNonCollab", () => {
	test("mounts both panes on the committed text with nothing to save yet", async () => {
		resolveQueryWithNonCollaborativeContent("alpha\n");
		renderNonCollabDiffEditor();
		await flushEditorMount();

		expect(convexQueryMock).toHaveBeenCalledWith("get_non_collaborative_file_content", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
		});
		const panes = getPanes();
		expect(panes.original.getValue()).toBe("alpha\n");
		expect(panes.modified.getValue()).toBe("alpha\n");
		expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
		expect(
			screen.getByRole("button", { name: "Discard all changes in this file" }).hasAttribute("disabled"),
		).toBe(true);
	});

	test("a refused content read keeps the editor closed", async () => {
		convexQueryMock.mockResolvedValue({ _nay: { message: "Permission denied" } });
		renderNonCollabDiffEditor();
		await flushEditorMount();

		// Mounting a fabricated empty committed pane would let the next Save overwrite the file.
		expect(screen.getByRole("alert").className).toContain("FileEditorDiffNonCollab-refusal");
		expect(monacoHarness.createdModels).toHaveLength(0);
	});

	test("Save sends the whole modified pane and the next Save names the asset it wrote", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _yay: { assetId: "asset_saved" } });

			renderNonCollabDiffEditor();
			await flushEditorMount();

			const saveButton = screen.getByRole("button", { name: "Save" });
			await typeIntoModifiedPane("alpha beta\n");
			expect(saveButton.hasAttribute("disabled")).toBe(false);

			fireEvent.click(saveButton);
			await act(async () => {});

			expect(convexActionMock).toHaveBeenCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: "alpha beta\n",
				baseAssetId: BASE_ASSET_ID,
			});
			// The saved text is the new committed version, so the diff is empty again.
			expect(getPanes().original.getValue()).toBe("alpha beta\n");
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			await typeIntoModifiedPane("alpha beta gamma\n");
			fireEvent.click(saveButton);
			await act(async () => {});
			expect(convexActionMock).toHaveBeenLastCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: "alpha beta gamma\n",
				baseAssetId: "asset_saved",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("a refused Save shows the refusal and keeps the text in the modified pane", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _nay: { message: "This file changed while you were saving." } });

			renderNonCollabDiffEditor();
			await flushEditorMount();

			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});

			expect(toast.error).toHaveBeenCalledWith("This file changed while you were saving.");
			// Nothing was written, so the committed pane must not move and the text must survive.
			expect(getPanes().original.getValue()).toBe("alpha\n");
			expect(getPanes().modified.getValue()).toBe("alpha beta\n");
		} finally {
			vi.useRealTimers();
		}
	});

	test("Discard all puts the modified pane back on the committed text", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			renderNonCollabDiffEditor();
			await flushEditorMount();

			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Discard all changes in this file" }));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});

			expect(getPanes().modified.getValue()).toBe("alpha\n");
			expect(convexActionMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("warns with the lost text when the editor closes on unsaved changes", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			const { unmount } = renderNonCollabDiffEditor();
			await flushEditorMount();

			await typeIntoModifiedPane("alpha beta\n");
			unmount();

			expect(toast.warning).toHaveBeenCalledWith("Your unsaved changes to this file were discarded.", {
				duration: 30_000,
				action: { label: "Copy text", onClick: expect.any(Function) },
			});

			// The action has to hand back exactly what was in the pane, or the offer is useless.
			const clipboardWrite = vi.fn();
			vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
			const warningAction = vi.mocked(toast.warning).mock.calls[0]?.[1]?.action;
			if (typeof warningAction !== "object" || warningAction === null || !("onClick" in warningAction)) {
				throw new Error("Expected the warning to carry a Copy text action");
			}
			// The handler ignores its event, so an empty stand-in is enough to run the action.
			warningAction.onClick({} as Parameters<typeof warningAction.onClick>[0]);
			expect(clipboardWrite).toHaveBeenCalledWith("alpha beta\n");
			vi.unstubAllGlobals();
		} finally {
			vi.useRealTimers();
		}
	});

	test("no warning when the editor closes right after a successful Save", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _yay: { assetId: "asset_saved" } });

			const { unmount } = renderNonCollabDiffEditor();
			await flushEditorMount();

			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			unmount();

			expect(toast.warning).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
