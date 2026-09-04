import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const {
	tenantContextMock,
	pushMutationMock,
	fetchFileYjsStateAndTextMock,
	convexQueryMock,
	convexActionMock,
	monacoHarness,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	pushMutationMock: vi.fn(),
	fetchFileYjsStateAndTextMock: vi.fn(),
	convexQueryMock: vi.fn(),
	convexActionMock: vi.fn(),
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
// A non-collaborative file never touches the Yjs mutation: it reads through the query and saves
// through the action, so both are mocked here.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		query: (...args: unknown[]) => convexQueryMock(...args),
		action: (...args: unknown[]) => convexActionMock(...args),
	},
	app_convex_api: {
		files_nodes: {
			yjs_push_update: "yjs_push_update",
		},
		files_nodes_content: {
			get_non_collaborative_file_content: "get_non_collaborative_file_content",
			replace_file_content: "replace_file_content",
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
const BASE_ASSET_ID = "asset_committed" as app_convex_Id<"files_r2_assets">;
const LAST_SEQUENCE_ID = "last_sequence_a" as app_convex_Id<"files_yjs_docs_last_sequences">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Resolve the fetch mock with a real plain-text Y.Doc built from `text`, like the production
 * fetch would return for a converted `.json` upload.
 */
function resolveFetchWithPlainTextDoc(text: string, yjsLastSequenceId = LAST_SEQUENCE_ID) {
	const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: "plain_text" });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	fetchFileYjsStateAndTextMock.mockResolvedValue({
		text: { _yay: text },
		yjsDoc,
		yjsSequence: 3,
		yjsRootKind: "plain_text",
		yjsLastSequenceId,
	});
}

/**
 * Answer the committed-content query the way the server does for a file with collaboration off.
 */
function resolveQueryWithNonCollaborativeContent(text: string) {
	convexQueryMock.mockResolvedValue({
		_yay: { text, yjsRootKind: "plain_text", assetId: BASE_ASSET_ID },
	});
}

function renderPlainTextEditor(args?: {
	monacoLanguageId?: string;
	editable?: boolean;
	nonCollaborative?: boolean;
	withYjsLastSequenceId?: boolean;
}) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	const rendered = render(
		<FileEditorPlainText
			nodeId={NODE_ID}
			editable={args?.editable ?? true}
			nonCollaborative={args?.nonCollaborative ?? false}
			yjsLastSequenceId={
				args?.nonCollaborative || args?.withYjsLastSequenceId === false ? undefined : LAST_SEQUENCE_ID
			}
			monacoLanguageId={args?.monacoLanguageId ?? "json"}
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
		/>,
	);
	return { ...rendered, toolbarPortalHost };
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
	convexQueryMock.mockReset();
	convexActionMock.mockReset();
	monacoHarness.createdModels.length = 0;
	monacoHarness.changeListeners.length = 0;
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.warning).mockClear();

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
	test("waits for the collaborative lineage before fetching file content", async () => {
		const { container } = renderPlainTextEditor({ withYjsLastSequenceId: false });
		await act(async () => {});

		expect(container.querySelector(".FileEditorPlainTextSkeleton")).not.toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(fetchFileYjsStateAndTextMock).not.toHaveBeenCalled();
	});

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
				expectedYjsLastSequenceId: LAST_SEQUENCE_ID,
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

	test("reloads the same node when its collaboration mode and lineage change", async () => {
		vi.useFakeTimers();
		try {
			resolveFetchWithPlainTextDoc('{"mode":"collaborative-a"}\n');
			const { rerender, toolbarPortalHost } = renderPlainTextEditor();
			await act(async () => {});
			expect(monacoHarness.createdModels.at(-1)?.model.getValue()).toBe('{"mode":"collaborative-a"}\n');

			resolveQueryWithNonCollaborativeContent('{"mode":"off"}\n');
			rerender(
				<FileEditorPlainText
					nodeId={NODE_ID}
					editable={true}
					nonCollaborative={true}
					monacoLanguageId="json"
					presenceStore={presenceStore}
					commentsPortalHost={null}
					toolbarPortalHost={toolbarPortalHost}
				/>,
			);
			await act(async () => {});
			expect(monacoHarness.createdModels.at(-1)?.model.getValue()).toBe('{"mode":"off"}\n');

			const lastSequenceB = "last_sequence_b" as app_convex_Id<"files_yjs_docs_last_sequences">;
			resolveFetchWithPlainTextDoc('{"mode":"collaborative-b"}\n', lastSequenceB);
			rerender(
				<FileEditorPlainText
					nodeId={NODE_ID}
					editable={true}
					nonCollaborative={false}
					yjsLastSequenceId={lastSequenceB}
					monacoLanguageId="json"
					presenceStore={presenceStore}
					commentsPortalHost={null}
					toolbarPortalHost={toolbarPortalHost}
				/>,
			);
			await act(async () => {});

			const currentModel = monacoHarness.createdModels.at(-1)?.model;
			expect(currentModel?.getValue()).toBe('{"mode":"collaborative-b"}\n');
			act(() => {
				currentModel?.setValue('{"mode":"saved-b"}\n');
				monacoHarness.changeListeners.at(-1)?.();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			expect(pushMutationMock).toHaveBeenLastCalledWith(
				expect.objectContaining({ expectedYjsLastSequenceId: lastSequenceB }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("reloads the same collaborative mode when only its lineage changes", async () => {
		vi.useFakeTimers();
		try {
			resolveFetchWithPlainTextDoc('{"lineage":"a"}\n');
			const { rerender, toolbarPortalHost } = renderPlainTextEditor();
			await act(async () => {});

			const lastSequenceB = "last_sequence_b" as app_convex_Id<"files_yjs_docs_last_sequences">;
			resolveFetchWithPlainTextDoc('{"lineage":"b"}\n', lastSequenceB);
			rerender(
				<FileEditorPlainText
					nodeId={NODE_ID}
					editable={true}
					nonCollaborative={false}
					yjsLastSequenceId={lastSequenceB}
					monacoLanguageId="json"
					presenceStore={presenceStore}
					commentsPortalHost={null}
					toolbarPortalHost={toolbarPortalHost}
				/>,
			);
			await act(async () => {});

			const currentModel = monacoHarness.createdModels.at(-1)?.model;
			expect(currentModel?.getValue()).toBe('{"lineage":"b"}\n');
			act(() => {
				currentModel?.setValue('{"lineage":"saved-b"}\n');
				monacoHarness.changeListeners.at(-1)?.();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			expect(pushMutationMock).toHaveBeenLastCalledWith(
				expect.objectContaining({ expectedYjsLastSequenceId: lastSequenceB }),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a non-collaborative Save replaces the whole text and names the asset it was built on", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("{}\n");
			convexActionMock.mockResolvedValue({ _yay: { assetId: "asset_saved" } });

			renderPlainTextEditor({ nonCollaborative: true });
			await act(async () => {});

			// The committed text comes from the query, not from the Yjs fetch. A file with no
			// document must never reach that fetch.
			expect(convexQueryMock).toHaveBeenCalledWith("get_non_collaborative_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
			});
			expect(fetchFileYjsStateAndTextMock).not.toHaveBeenCalled();

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

			// The whole buffer goes, with the asset this text was built on. No Yjs update is pushed.
			expect(convexActionMock).toHaveBeenCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: '{"answer": 42}\n',
				baseAssetId: BASE_ASSET_ID,
			});
			expect(pushMutationMock).not.toHaveBeenCalled();
			expect(toast.error).not.toHaveBeenCalled();
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			// The next Save must name the asset this one wrote, or the server would call it stale.
			act(() => {
				model?.setValue('{"answer": 43}\n');
				for (const listener of monacoHarness.changeListeners) listener();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			fireEvent.click(saveButton);
			await act(async () => {});
			expect(convexActionMock).toHaveBeenLastCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: '{"answer": 43}\n',
				baseAssetId: "asset_saved",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("typing while Save is in flight keeps Save enabled", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("{}\n");

			// Hold the save open so the test can type inside the in-flight window, the way a slow
			// network lets a member keep typing after pressing Save.
			let finishSave: (value: unknown) => void = () => {};
			convexActionMock.mockReturnValue(
				new Promise((resolve) => {
					finishSave = resolve;
				}),
			);

			renderPlainTextEditor({ nonCollaborative: true });
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

			// Keystrokes that land after the save took its snapshot of the text.
			act(() => {
				model?.setValue('{"answer": 43}\n');
				for (const listener of monacoHarness.changeListeners) listener();
			});

			await act(async () => {
				finishSave({ _yay: { assetId: "asset_saved" } });
			});

			// The save persisted `42`, so `43` is still only local and Save must stay usable.
			expect(convexActionMock).toHaveBeenCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: '{"answer": 42}\n',
				baseAssetId: BASE_ASSET_ID,
			});
			expect(model?.getValue()).toBe('{"answer": 43}\n');
			expect(saveButton.hasAttribute("disabled")).toBe(false);

			// And that second Save names the asset the first one wrote.
			fireEvent.click(saveButton);
			await act(async () => {});
			expect(convexActionMock).toHaveBeenLastCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: '{"answer": 43}\n',
				baseAssetId: "asset_saved",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("a refused non-collaborative Save shows the refusal and keeps the buffer dirty", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("{}\n");
			convexActionMock.mockResolvedValue({
				_nay: {
					message:
						"This file changed while you were saving. Copy your local changes before reloading, then try again.",
				},
			});

			renderPlainTextEditor({ nonCollaborative: true });
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

			// The refusal must be visible, and Save must stay armed: the text is still only local.
			expect(toast.error).toHaveBeenCalledWith(
				"This file changed while you were saving. Copy your local changes before reloading, then try again.",
			);
			expect(saveButton.hasAttribute("disabled")).toBe(false);
			expect(model?.getValue()).toBe('{"answer": 42}\n');
		} finally {
			vi.useRealTimers();
		}
	});

	test("warns with the lost text when the editor closes on unsaved changes", async () => {
		resolveQueryWithNonCollaborativeContent("{}\n");
		const { unmount } = renderPlainTextEditor({ nonCollaborative: true });
		await act(async () => {});

		const model = monacoHarness.createdModels[0]?.model;
		act(() => {
			model?.setValue('{"answer": 42}\n');
			for (const listener of monacoHarness.changeListeners) listener();
		});
		unmount();

		expect(toast.warning).toHaveBeenCalledWith("Your unsaved changes to this file were discarded.", {
			duration: 30_000,
			action: { label: "Copy text", onClick: expect.any(Function) },
		});

		// The action has to hand back exactly what was in the editor, or the offer is useless.
		const clipboardWrite = vi.fn();
		vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
		const warningAction = vi.mocked(toast.warning).mock.calls[0]?.[1]?.action;
		if (typeof warningAction !== "object" || warningAction === null || !("onClick" in warningAction)) {
			throw new Error("Expected the warning to carry a Copy text action");
		}
		// The handler ignores its event, so an empty stand-in is enough to run the action.
		warningAction.onClick({} as Parameters<typeof warningAction.onClick>[0]);
		expect(clipboardWrite).toHaveBeenCalledWith('{"answer": 42}\n');
		vi.unstubAllGlobals();
	});

	test("no warning when a collaborative file closes with local edits", async () => {
		// A collaborative file keeps every keystroke in its shared document, so nothing is lost.
		resolveFetchWithPlainTextDoc("{}\n");
		const { unmount } = renderPlainTextEditor();
		await act(async () => {});

		const model = monacoHarness.createdModels[0]?.model;
		act(() => {
			model?.setValue('{"answer": 42}\n');
			for (const listener of monacoHarness.changeListeners) listener();
		});
		unmount();

		expect(toast.warning).not.toHaveBeenCalled();
	});

	test("no warning when the editor closes right after a successful Save", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("{}\n");
			convexActionMock.mockResolvedValue({ _yay: { assetId: "asset_saved" } });

			const { unmount } = renderPlainTextEditor({ nonCollaborative: true });
			await act(async () => {});

			const model = monacoHarness.createdModels[0]?.model;
			act(() => {
				model?.setValue('{"answer": 42}\n');
				for (const listener of monacoHarness.changeListeners) listener();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			unmount();

			expect(toast.warning).not.toHaveBeenCalled();
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
