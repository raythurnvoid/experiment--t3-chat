import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, pushMutationMock, fetchFileYjsStateAndTextMock, monacoHarness } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	pushMutationMock: vi.fn(),
	fetchFileYjsStateAndTextMock: vi.fn(),
	// Shared state between the Editor mock and the tests: the created models with their language,
	// and the model-change listeners the component registered on mount.
	monacoHarness: {
		createdModels: [] as Array<{ model: { getValue: () => string; setValue: (next: string) => void }; languageId: string }>,
		changeListeners: [] as Array<() => void>,
	},
}));

// Network boundary: the real hook talks to a live Convex client; tests feed the push result.
vi.mock("convex/react", () => ({
	useMutation: () => pushMutationMock,
}));

// Spy target: tests assert on toast.error calls.
vi.mock("sonner", () => ({
	toast: { error: vi.fn() },
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL).
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {},
	app_convex_api: {
		files_nodes: {
			yjs_push_update: "yjs_push_update",
		},
	},
}));

// Keep the real module. Fake only the network read; the Save path below runs the REAL
// text -> Y.Doc -> diff-update pipeline on real documents. The model factory wrapper records
// each created model so tests can drive edits and assert the Monaco language it was given.
vi.mock("@/lib/files.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/files.ts")>();
	return {
		...original,
		files_fetch_file_yjs_state_and_text: (...args: unknown[]) => fetchFileYjsStateAndTextMock(...args),
		files_monaco_create_editor_model: (text: string, languageId: string) => {
			const model = original.files_monaco_create_editor_model(text, languageId);
			monacoHarness.createdModels.push({ model: model as never, languageId });
			return model;
		},
	};
});

// The real component loads the Monaco runtime; the stub only reports the language it received
// and hands the component a minimal editor on mount, like @monaco-editor/react would.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect } = await import("react");
	return {
		// The app Monaco config calls loader.config at import time.
		loader: { config: () => {} },
		Editor: function Editor(props: { language?: string; onMount?: (editor: never, monaco: never) => void }) {
			const { language, onMount } = props;
			useEffect(() => {
				const fakeEditor = {
					updateOptions: () => {},
					getModel: () => null,
					setModel: () => {},
					onDidChangeModelContent: (listener: () => void) => {
						monacoHarness.changeListeners.push(listener);
						return { dispose() {} };
					},
					pushUndoStop: () => {},
					executeEdits: () => true,
				};
				onMount?.(fakeEditor as never, {} as never);
			}, []);
			return <div data-testid="monaco-editor" data-language={language} />;
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

import { FileEditorPlainText } from "./file-editor-plain-text.tsx";
import {
	files_get_editable_text_yjs_root_kind,
	files_get_monaco_language_id,
	files_resolve_effective_editor_view,
	type files_PresenceStore,
} from "@/lib/files.ts";
import { files_yjs_doc_create_from_text } from "../../../../../shared/files-tiptap.ts";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_json" as app_convex_Id<"files_nodes">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Resolve the fetch mock with a real plain-text Y.Doc built from `text`, like the production
 * fetch would return for a converted `.json` upload.
 */
function resolveFetchWithPlainTextDoc(text: string) {
	const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: "plain_text" });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	fetchFileYjsStateAndTextMock.mockResolvedValue({
		text: { _yay: text },
		yjsDoc,
		yjsSequence: 3,
		yjsRootKind: "plain_text",
	});
}

function renderPlainTextEditor(args?: { monacoLanguageId?: string; editable?: boolean }) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	return render(
		<FileEditorPlainText
			nodeId={NODE_ID}
			editable={args?.editable ?? true}
			monacoLanguageId={args?.monacoLanguageId ?? "json"}
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
		/>,
	);
}

let hoistingContainer: HTMLDivElement;

beforeEach(() => {
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	pushMutationMock.mockReset();
	pushMutationMock.mockResolvedValue({ _yay: { newSequence: 4 } });
	fetchFileYjsStateAndTextMock.mockReset();
	monacoHarness.createdModels.length = 0;
	monacoHarness.changeListeners.length = 0;
	vi.mocked(toast.error).mockClear();

	// The component renders Monaco only when the app's overflow-widget host exists.
	hoistingContainer = document.createElement("div");
	hoistingContainer.id = "app_monaco_hoisting_container";
	document.body.append(hoistingContainer);
});

afterEach(() => {
	cleanup();
	hoistingContainer.remove();
});

describe("view gating", () => {
	test("a `.json` node renders the plain-text editor", async () => {
		// The upload producer stamps the document shape from the file NAME, never the client MIME.
		const rootKind = files_get_editable_text_yjs_root_kind("config.json");
		expect(rootKind).toBe("plain_text");

		// The route clamp redirects the rich default to the plain editor for that shape.
		const effectiveView = files_resolve_effective_editor_view({
			requestedView: "rich_text_editor",
			rootKind: rootKind ?? "rich_text",
		});
		expect(effectiveView).toBe("plain_text_editor");

		// And the mounted editor speaks the node's Monaco language.
		const monacoLanguageId = files_get_monaco_language_id("config.json");
		expect(monacoLanguageId).toBe("json");

		resolveFetchWithPlainTextDoc('{"answer": 42}\n');
		renderPlainTextEditor({ monacoLanguageId });

		expect(await screen.findByRole("group", { name: "Text editor actions" })).toBeTruthy();
		expect(screen.getByTestId("monaco-editor").getAttribute("data-language")).toBe("json");
		expect(monacoHarness.createdModels).toHaveLength(1);
		expect(monacoHarness.createdModels[0]?.languageId).toBe("json");
		expect(monacoHarness.createdModels[0]?.model.getValue()).toBe('{"answer": 42}\n');
		expect(fetchFileYjsStateAndTextMock).toHaveBeenCalledWith({
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
		});
	});
});

describe("FileEditorPlainText", () => {
	test("Save pushes the edit and surfaces a push refusal as a visible error", async () => {
		vi.useFakeTimers();
		try {
			resolveFetchWithPlainTextDoc("{}\n");
			pushMutationMock.mockResolvedValue({ _nay: { message: "Permission denied" } });

			renderPlainTextEditor();
			// Flush the content fetch so the editor mounts and registers its change listener.
			await act(async () => {});

			const saveButton = screen.getByRole("button", { name: "Save" });
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			// Type into the model like Monaco would, then let the dirty-check debounce fire.
			const model = monacoHarness.createdModels[0]?.model;
			expect(model).toBeTruthy();
			act(() => {
				model?.setValue('{"answer": 42}\n');
				for (const listener of monacoHarness.changeListeners) listener();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			expect(saveButton.hasAttribute("disabled")).toBe(false);

			fireEvent.click(saveButton);
			await act(async () => {});

			expect(pushMutationMock).toHaveBeenCalledTimes(1);
			expect(pushMutationMock).toHaveBeenCalledWith({
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				update: expect.any(ArrayBuffer),
				sessionId: "session_1",
			});
			// The refused Save must not look like a no-op: the buffer keeps content that did not persist.
			expect(toast.error).toHaveBeenCalledWith("Permission denied");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a successful Save returns the toolbar to clean", async () => {
		vi.useFakeTimers();
		try {
			resolveFetchWithPlainTextDoc("{}\n");

			renderPlainTextEditor();
			await act(async () => {});

			const saveButton = screen.getByRole("button", { name: "Save" });
			const model = monacoHarness.createdModels[0]?.model;
			act(() => {
				model?.setValue('{"answer": 42}\n');
				for (const listener of monacoHarness.changeListeners) listener();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});

			fireEvent.click(saveButton);
			await act(async () => {});

			expect(pushMutationMock).toHaveBeenCalledTimes(1);
			expect(toast.error).not.toHaveBeenCalled();
			// The pushed content is the new baseline, so Save disarms again.
			expect(saveButton.hasAttribute("disabled")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a refused content read keeps the editor closed with a visible alert", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			fetchFileYjsStateAndTextMock.mockResolvedValue({
				text: { _nay: { name: "nay", message: "Failed to reconstruct content" } },
			});

			renderPlainTextEditor();

			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toContain("the editor stays closed");
			// No editor mounts over a stand-in document: a fabricated empty baseline would make
			// every later Save diff the user's typing against emptiness.
			expect(screen.queryByTestId("monaco-editor")).toBeNull();
			expect(monacoHarness.createdModels).toHaveLength(0);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});
});
