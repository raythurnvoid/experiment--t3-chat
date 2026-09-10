import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";
import { createRef, type Ref } from "react";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import type { FileEditor_Ref } from "../file-editor.tsx";

const {
	tenantContextMock,
	convexQueryMock,
	convexActionMock,
	convexMutationMock,
	useStableQueryMock,
	useQueryMock,
	convexWatchQueryMock,
	waitNewQueryValueMock,
	monacoHarness,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	convexQueryMock: vi.fn(),
	convexActionMock: vi.fn(),
	convexMutationMock: vi.fn(),
	useStableQueryMock: vi.fn(),
	useQueryMock: vi.fn(),
	convexWatchQueryMock: vi.fn(),
	waitNewQueryValueMock: vi.fn(),
	// Shared state between the DiffEditor stub and the tests: the models the component created
	// (original first, then modified), the change listeners it put on the modified pane, and the
	// options it set on the diff editor.
	monacoHarness: {
		createdModels: [] as Array<{ getValue: () => string; setValue: (next: string) => void }>,
		changeListeners: [] as Array<() => void>,
		updateOptionsCalls: [] as Array<Record<string, unknown>>,
		// The line changes the fake diff editor reports, and the listeners the component put on
		// its diff updates. A test fills the first and fires the second to get hunk widgets.
		lineChanges: [] as Array<{
			originalStartLineNumber: number;
			originalEndLineNumber: number;
			modifiedStartLineNumber: number;
			modifiedEndLineNumber: number;
		}>,
		diffListeners: [] as Array<() => void>,
	},
}));

// Network boundary: the collaborative diff editor reads the pending doc through these hooks and
// writes through the client the `useConvex` stub returns.
vi.mock("convex/react", () => ({
	useConvex: () => ({
		query: (...args: unknown[]) => convexQueryMock(...args),
		action: (...args: unknown[]) => convexActionMock(...args),
		mutation: (...args: unknown[]) => convexMutationMock(...args),
		watchQuery: (...args: unknown[]) => convexWatchQueryMock(...args),
	}),
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: (...args: unknown[]) => useStableQueryMock(...args),
}));

// Spy target: tests assert on the toasts the editor shows.
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
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
		mutation: (...args: unknown[]) => convexMutationMock(...args),
	},
	app_convex_wait_new_query_value: (...args: unknown[]) => waitNewQueryValueMock(...args),
	app_convex_api: {
		files_nodes_content: {
			get_non_collaborative_file_content: "get_non_collaborative_file_content",
			replace_file_content: "replace_file_content",
		},
		files_pending_updates: {
			get_file_pending_update_state_page: "get_file_pending_update_state_page",
			create_file_pending_update_operation_batch: "create_file_pending_update_operation_batch",
			stage_file_pending_update_text_input: "stage_file_pending_update_text_input",
			upsert_file_pending_update: "upsert_file_pending_update",
		},
	},
}));

// Keep the real module. The model factory wrapper records each created model, which is how a test
// reads the two panes and edits the modified one.
vi.mock("@/lib/files.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/files.ts")>();
	return {
		...original,
		files_fetch_file_yjs_state_and_text: vi.fn().mockResolvedValue(null),
		files_yjs_rebase_branch_with_local_text: vi.fn(original.files_yjs_rebase_branch_with_local_text),
		files_persist_file_pending_update_rebased_state: vi.fn(original.files_persist_file_pending_update_rebased_state),
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
					getDomNode: () => document.createElement("div"),
					// Attach the hunk widget's node to the document, so its Accept and Discard buttons
					// can be queried like the toolbar's.
					addContentWidget: (widget: { getDomNode: () => HTMLElement }) => {
						document.body.append(widget.getDomNode());
					},
					removeContentWidget: (widget: { getDomNode: () => HTMLElement }) => {
						widget.getDomNode().remove();
					},
					layoutContentWidget: () => {},
					createDecorationsCollection: () => ({
						set: () => {},
						clear: () => {},
						onDidChange: () => ({ dispose() {} }),
					}),
					focus: () => {},
				};
				const fakeEditor = {
					layout: () => {},
					updateOptions: (options: Record<string, unknown>) => {
						monacoHarness.updateOptionsCalls.push(options);
					},
					getModel: () => null,
					setModel: () => {},
					dispose: () => {},
					focus: () => {},
					getOriginalEditor: () => fakePane,
					getModifiedEditor: () => fakePane,
					// Monaco never computes a diff here. A test sets `lineChanges` and fires the diff
					// listeners to make the editor build its hunk widgets.
					getLineChanges: () => monacoHarness.lineChanges,
					onDidUpdateDiff: (listener: () => void) => {
						monacoHarness.diffListeners.push(listener);
						return { dispose() {} };
					},
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

// The snapshots modal and comments sidebar pull their own query stacks; not under test here. The
// modal stub leaves a marker so a test can check whether the toolbar rendered it.
vi.mock("../file-editor-snapshots-modal.tsx", () => ({
	FileEditorSnapshotsModal: function FileEditorSnapshotsModal(props: { onApplySnapshotText: (text: string) => void }) {
		return (
			<button data-testid="file-editor-snapshots-modal" onClick={() => props.onApplySnapshotText("restored\n")}>
				Restore test snapshot
			</button>
		);
	},
}));
vi.mock("../file-editor-comments-sidebar.tsx", () => ({
	FileEditorCommentsSidebar: function FileEditorCommentsSidebar() {
		return null;
	},
}));

import { FileEditorDiff, FileEditorDiffNonCollab } from "./file-editor-diff.tsx";
import {
	files_fetch_file_yjs_state_and_text,
	files_persist_file_pending_update_rebased_state,
	files_yjs_rebase_branch_with_local_text,
	type files_PresenceStore,
} from "@/lib/files.ts";
import type { app_convex_Doc } from "@/lib/app-convex-client.ts";
import { getFunctionName } from "convex/server";
import { encodeStateAsUpdate } from "yjs";
import { files_yjs_doc_clone, files_yjs_doc_create_plain_text_from_text } from "../../../../../shared/files-yjs.ts";
import { files_yjs_doc_update_from_text } from "../../../../../shared/files-tiptap.ts";
import { Result } from "common/errors-as-values-utils.ts";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_markdown" as app_convex_Id<"files_nodes">;
const PENDING_UPDATE_ID = "pu_1" as app_convex_Id<"files_pending_updates">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Answer the committed-content query the way the server does for a file with collaboration off.
 */
function resolveQueryWithNonCollaborativeContent(text: string) {
	convexQueryMock.mockResolvedValue({ _yay: { text, textKind: "rich_text" } });
}

function renderNonCollabDiffEditor(args?: {
	ref?: Ref<Pick<FileEditor_Ref, "getPreviewSnapshot">>;
	editable?: boolean;
}) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	const rendered = render(
		<FileEditorDiffNonCollab
			ref={args?.ref}
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
	convexActionMock.mockReset().mockReturnValue(new Promise(() => {}));
	convexMutationMock.mockReset();
	useStableQueryMock.mockReset();
	useQueryMock.mockReset();
	convexWatchQueryMock.mockReset();
	waitNewQueryValueMock.mockReset();
	vi.mocked(files_fetch_file_yjs_state_and_text).mockReset().mockResolvedValue(null);
	vi.mocked(files_yjs_rebase_branch_with_local_text).mockClear();
	vi.mocked(files_persist_file_pending_update_rebased_state).mockReset();
	monacoHarness.createdModels.length = 0;
	monacoHarness.changeListeners.length = 0;
	monacoHarness.updateOptionsCalls.length = 0;
	monacoHarness.lineChanges.length = 0;
	monacoHarness.diffListeners.length = 0;
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.warning).mockClear();
	vi.mocked(toast.success).mockClear();
});

afterEach(() => {
	cleanup();
	document.getElementById("app_monaco_hoisting_container")?.remove();
});

describe("FileEditorDiffNonCollab", () => {
	test("preview reads the modified draft before its dirty check", async () => {
		const ref = createRef<Pick<FileEditor_Ref, "getPreviewSnapshot">>();
		resolveQueryWithNonCollaborativeContent("saved\n");
		renderNonCollabDiffEditor({ ref });
		await flushEditorMount();
		expect(ref.current?.getPreviewSnapshot()).toMatchObject({
			text: "saved\n",
			sourceKind: "editor_draft",
			isDirty: false,
			pendingUpdate: null,
		});
		act(() => {
			getPanes().modified.setValue("local draft\n");
			monacoHarness.changeListeners.forEach((listener) => listener());
		});
		expect(ref.current?.getPreviewSnapshot()).toMatchObject({ text: "local draft\n", isDirty: true });
		expect(convexActionMock).not.toHaveBeenCalled();
	});

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
		expect(screen.getByRole("button", { name: "Discard all changes in this file" }).hasAttribute("disabled")).toBe(
			true,
		);
	});

	test("a refused content read keeps the editor closed", async () => {
		convexQueryMock.mockResolvedValue({ _nay: { message: "Permission denied" } });
		renderNonCollabDiffEditor();
		await flushEditorMount();

		// Mounting a fabricated empty committed pane would let the next Save overwrite the file.
		expect(screen.getByRole("alert").className).toContain("FileEditorDiffNonCollab-refusal");
		expect(monacoHarness.createdModels).toHaveLength(0);
	});

	test("each Save sends the whole modified pane and updates the committed pane", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _yay: null });

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
			});
			// The saved text is the new committed version, so the diff is empty again.
			expect(convexActionMock.mock.calls.at(-1)?.[1]).not.toHaveProperty("baseAssetId");
			expect(getPanes().original.getValue()).toBe("alpha beta\n");
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			await typeIntoModifiedPane("alpha beta gamma\n");
			fireEvent.click(saveButton);
			await act(async () => {});
			expect(convexActionMock).toHaveBeenLastCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: "alpha beta gamma\n",
			});
			expect(getPanes().original.getValue()).toBe("alpha beta gamma\n");
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a refused Save shows the refusal and keeps the text in the modified pane", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _nay: { message: "This file is read-only." } });

			renderNonCollabDiffEditor();
			await flushEditorMount();

			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});

			expect(toast.error).toHaveBeenCalledWith("This file is read-only.");
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
			convexActionMock.mockResolvedValue({ _yay: null });

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

	test("no warning when the agent's review replaces the view during a Save that then lands", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			// The save waits while the chooser swaps this view for the review of a new proposal.
			let settleSave: (result: unknown) => void = () => {};
			convexActionMock.mockImplementation(
				() =>
					new Promise<unknown>((resolve) => {
						settleSave = resolve;
					}),
			);

			const { unmount } = renderNonCollabDiffEditor();
			await flushEditorMount();
			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			unmount();
			expect(toast.warning).not.toHaveBeenCalled();

			await act(async () => {
				settleSave({ _yay: null });
			});
			expect(toast.warning).not.toHaveBeenCalled();
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("the warning names the text typed after Save when the view is replaced during the save", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			let settleSave: (result: unknown) => void = () => {};
			convexActionMock.mockImplementation(
				() =>
					new Promise<unknown>((resolve) => {
						settleSave = resolve;
					}),
			);

			const { unmount } = renderNonCollabDiffEditor();
			await flushEditorMount();
			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			// The save carries "alpha beta"; the words typed after the click are only in the pane.
			await typeIntoModifiedPane("alpha beta gamma\n");
			unmount();

			expect(toast.warning).toHaveBeenCalledWith("Your unsaved changes to this file were discarded.", {
				duration: 30_000,
				action: { label: "Copy text", onClick: expect.any(Function) },
			});
			await act(async () => {
				settleSave({ _yay: null });
			});
			expect(toast.warning).toHaveBeenCalledTimes(1);
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("the warning comes from the Save itself when it fails after the view was replaced", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			let settleSave: (result: unknown) => void = () => {};
			convexActionMock.mockImplementation(
				() =>
					new Promise<unknown>((resolve) => {
						settleSave = resolve;
					}),
			);

			const { unmount } = renderNonCollabDiffEditor();
			await flushEditorMount();
			await typeIntoModifiedPane("alpha beta\n");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			unmount();
			expect(toast.warning).not.toHaveBeenCalled();

			// The text is off the screen and the server refused it: the member must get it back.
			await act(async () => {
				settleSave({ _nay: { message: "Not found" } });
			});
			expect(toast.error).toHaveBeenCalledWith("Not found");
			expect(toast.warning).toHaveBeenCalledWith("Your unsaved changes to this file were discarded.", {
				duration: 30_000,
				action: { label: "Copy text", onClick: expect.any(Function) },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

// Collaboration off: the review of a proposal on a file with no Yjs document.

/**
 * A proposal on a file with collaboration off, the way `get_file_pending_update` returns it: an
 * asset base instead of a Yjs sequence, and three branch states.
 */
const nonCollabPendingUpdate = {
	_id: PENDING_UPDATE_ID,
	_creationTime: 1,
	fileNodeId: NODE_ID,
	updatedAt: 1,
	baseAssetId: "asset_1",
	baseStateId: "state_base",
	stagedStateId: "state_staged",
	unstagedStateId: "state_unstaged",
	currentYjsLastSequenceId: null,
} as unknown as app_convex_Doc<"files_pending_updates">;

/**
 * One state page holding a plain text Yjs document with `text`.
 */
function statePageOf(text: string) {
	const bytes = encodeStateAsUpdate(files_yjs_doc_create_plain_text_from_text({ text }));
	return {
		bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		pageCount: 1,
		totalBytes: bytes.byteLength,
	};
}

/**
 * Serve the three branch states as one-page plain text Yjs documents, keyed by state id.
 */
function resolveStatePages(texts: { base: string; staged: string; unstaged: string }) {
	const pages: Record<string, ReturnType<typeof statePageOf>> = {
		state_base: statePageOf(texts.base),
		state_staged: statePageOf(texts.staged),
		state_unstaged: statePageOf(texts.unstaged),
	};
	convexQueryMock.mockImplementation((name: unknown, args: unknown) => {
		if (name !== "get_file_pending_update_state_page") return Promise.resolve(undefined);
		const { stateId } = args as { stateId: string };
		return Promise.resolve(pages[stateId] ?? null);
	});
}

function renderNonCollabProposalReview(args: {
	ref?: Ref<Pick<FileEditor_Ref, "getPreviewSnapshot">>;
	isActive?: boolean;
	onPreviewSnapshotChange?: () => void;
	committedAssetId: string;
	rootKind?: "plain_text" | "rich_text";
	nonCollaborative?: boolean;
	yjsLastSequenceId?: string;
	serverSequence?: number;
	pendingUpdateId?: string | null;
	onExit?: () => void;
}) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	// The collaborative editor waits for the app's hoisting container before it mounts.
	const hoistingContainer = document.createElement("div");
	hoistingContainer.id = "app_monaco_hoisting_container";
	document.body.append(hoistingContainer);
	// The component is memoized, so a rerender with equal props changes nothing. `rerenderWith` gives
	// each rerender a new className, which is enough to make it read the query mocks again.
	let renderCount = 0;
	const makeElement = (overrides: Partial<typeof args> = {}) => (
		<FileEditorDiff
			ref={args.ref}
			isActive={overrides.isActive ?? args.isActive}
			onPreviewSnapshotChange={args.onPreviewSnapshotChange}
			className={`render-${(renderCount += 1)}`}
			nodeId={NODE_ID}
			editable={true}
			rootKind={overrides.rootKind ?? args.rootKind ?? "plain_text"}
			monacoLanguageId="plaintext"
			pendingUpdateId={
				args.pendingUpdateId === null
					? undefined
					: ((args.pendingUpdateId ?? PENDING_UPDATE_ID) as app_convex_Id<"files_pending_updates">)
			}
			nonCollaborative={overrides.nonCollaborative ?? args.nonCollaborative ?? true}
			serverSequence={overrides.serverSequence ?? args.serverSequence}
			yjsLastSequenceId={
				("yjsLastSequenceId" in overrides ? overrides.yjsLastSequenceId : args.yjsLastSequenceId) as
					| app_convex_Id<"files_yjs_docs_last_sequences">
					| undefined
			}
			committedAssetId={(overrides.committedAssetId ?? args.committedAssetId) as app_convex_Id<"files_r2_assets">}
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
			onExit={args.onExit ?? (() => {})}
		/>
	);
	const rendered = render(makeElement());
	return {
		...rendered,
		toolbarPortalHost,
		rerenderWith: (overrides: Partial<typeof args> = {}) => rendered.rerender(makeElement(overrides)),
	};
}

/**
 * Flush the three state page reads, the Yjs decode, and the editor mount that follows.
 */
async function flushNonCollabProposalMount() {
	for (let index = 0; index < 4; index += 1) {
		await act(async () => {});
	}
}

/**
 * Mock one Save round trip: the upsert flush (a batch, two stage inputs, the upsert action), the
 * save action answering `pendingUpdateUpdatedAt`, and the doc query cache, which still holds the
 * old doc when the action result lands and shows `nextDoc` only once the returned function runs.
 */
function mockSaveDocQuery(args: {
	pendingUpdateUpdatedAt: number | null;
	nextDoc: app_convex_Doc<"files_pending_updates"> | null;
}) {
	convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
	// The upsert goes through the mocked `app_convex_api` (plain strings); the save goes through
	// `useConvex()` with the real `api`.
	convexActionMock.mockImplementation((reference: unknown) =>
		Promise.resolve(
			reference === "upsert_file_pending_update"
				? { _yay: { pendingUpdate: { ...nonCollabPendingUpdate, updatedAt: 2 }, currentYjsLastSequenceId: null } }
				: { _yay: { newSequence: null, pendingUpdateUpdatedAt: args.pendingUpdateUpdatedAt } },
		),
	);
	let cachedDoc: app_convex_Doc<"files_pending_updates"> | null = nonCollabPendingUpdate;
	convexWatchQueryMock.mockReturnValue({ localQueryResult: () => cachedDoc });
	let deliverNextValue = () => {};
	waitNewQueryValueMock.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				deliverNextValue = () => {
					cachedDoc = args.nextDoc;
					resolve();
				};
			}),
	);
	return () => deliverNextValue();
}

describe("FileEditorDiff draft versions", () => {
	test("preview reads the modified proposal and detects immediate local edits", async () => {
		const ref = createRef<Pick<FileEditor_Ref, "getPreviewSnapshot">>();
		const onPreviewSnapshotChange = vi.fn();
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "saved\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { unmount } = renderNonCollabProposalReview({ ref, onPreviewSnapshotChange, committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		expect(ref.current?.getPreviewSnapshot()).toMatchObject({
			text: "proposed\n",
			sourceKind: "proposed_changes",
			isDirty: false,
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			pendingUpdate: { _id: PENDING_UPDATE_ID, updatedAt: 1, unstagedStateId: "state_unstaged" },
		});
		onPreviewSnapshotChange.mockClear();
		act(() => {
			getPanes().modified.setValue("proposed with typing\n");
			monacoHarness.changeListeners.forEach((listener) => listener());
		});
		expect(ref.current?.getPreviewSnapshot()).toMatchObject({ text: "proposed with typing\n", isDirty: true });
		expect(onPreviewSnapshotChange).toHaveBeenCalled();
		expect(convexActionMock).not.toHaveBeenCalled();
		unmount();
		expect(ref.current).toBeNull();
	});

	test("a hidden stale review waits to prepare until Editor is selected", async () => {
		const ref = createRef<Pick<FileEditor_Ref, "getPreviewSnapshot">>();
		useStableQueryMock.mockReturnValue({ ...nonCollabPendingUpdate, contentNeedsRebase: true });
		resolveStatePages({ base: "saved\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({ ref, isActive: false, committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		expect(convexActionMock.mock.calls).toHaveLength(0);
		expect(ref.current?.getPreviewSnapshot()).toBeNull();
		rerenderWith({ isActive: true });
		await flushNonCollabProposalMount();
		expect(convexActionMock).toHaveBeenCalledTimes(1);
		expect(getFunctionName(convexActionMock.mock.calls[0]![0])).toBe(
			"files_pending_updates:prepare_file_pending_update_for_review",
		);
	});

	test("typing queued before Preview still persists while the editor is hidden", async () => {
		vi.useFakeTimers();
		try {
			const ref = createRef<Pick<FileEditor_Ref, "getPreviewSnapshot">>();
			useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
			resolveStatePages({ base: "saved\n", staged: "saved\n", unstaged: "proposed\n" });
			convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
			convexActionMock.mockResolvedValue({
				_yay: {
					pendingUpdate: { ...nonCollabPendingUpdate, updatedAt: 2, unstagedStateId: "state_unstaged_2" },
					currentYjsLastSequenceId: null,
				},
			});
			const { rerenderWith } = renderNonCollabProposalReview({ ref, committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) =>
				statePageOf(args.stateId === "state_unstaged_2" ? "proposed with typing\n" : "saved\n"),
			);
			act(() => {
				getPanes().modified.setValue("proposed with typing\n");
				monacoHarness.changeListeners.forEach((listener) => listener());
			});
			rerenderWith({ isActive: false });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});

			expect(convexActionMock.mock.calls).toHaveLength(1);
			expect(convexActionMock.mock.calls[0]![0]).toBe("upsert_file_pending_update");
			expect(convexMutationMock).toHaveBeenCalledWith("stage_file_pending_update_text_input", {
				membershipId: MEMBERSHIP_ID,
				operationBatchId: "batch_1",
				role: "unstaged",
				text: "proposed with typing\n",
			});
			expect(ref.current?.getPreviewSnapshot()).toMatchObject({
				text: "proposed with typing\n",
				isDirty: false,
				pendingUpdate: { updatedAt: 2 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("a hidden review does not recover focus when its toolbar becomes stale", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "saved\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		act(() => screen.getByRole("button", { name: "Save staged changes" }).focus());
		useStableQueryMock.mockReturnValue({ ...nonCollabPendingUpdate, contentNeedsRebase: true });
		rerenderWith({ isActive: false });
		await flushNonCollabProposalMount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(document.activeElement).toBe(document.body);
		expect(convexActionMock.mock.calls).toHaveLength(0);
	});

	test("typing during an ordinary page reload stays editable and is saved after the pages arrive", async () => {
		vi.useFakeTimers();
		try {
			const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
			let persisted = { ...nonCollabPendingUpdate };
			let savedText = "base\n";
			let pausePages = false;
			const pagesFinished = Promise.withResolvers<void>();
			useStableQueryMock.mockReturnValue(persisted);
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
				if (reference !== "get_file_pending_update_state_page") return persisted;
				if (pausePages) await pagesFinished.promise;
				const doc = files_yjs_doc_clone({ yjsDoc: baseDoc });
				if (args.stateId === persisted.unstagedStateId)
					files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: savedText, rootKind: "plain_text" });
				const bytes = encodeStateAsUpdate(doc);
				return {
					bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
					pageCount: 1,
					totalBytes: bytes.byteLength,
				};
			});
			convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
				if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged") savedText = args.text!;
				return { _yay: { operationBatchId: "batch_1" } };
			});
			convexActionMock.mockImplementation(async () => {
				persisted = { ...persisted, updatedAt: persisted.updatedAt + 1 };
				return { _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: null } };
			});
			const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			await typeIntoModifiedPane("base A\n");
			pausePages = true;
			useStableQueryMock.mockReturnValue(persisted);
			rerenderWith({});
			await flushNonCollabProposalMount();
			expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
			await typeIntoModifiedPane("base A B\n");
			expect(convexActionMock).toHaveBeenCalledTimes(1);
			pausePages = false;
			await act(async () => {
				pagesFinished.resolve();
			});
			await flushNonCollabProposalMount();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			expect(convexActionMock).toHaveBeenCalledTimes(2);
			expect(convexActionMock.mock.calls[1]![1].reviewedUpdatedAt).toBe(2);
			expect(savedText).toBe("base A B\n");
			expect(getPanes().modified.getValue()).toBe("base A B\n");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a proposal id can receive new reviewed content after a content discard kept its move", async () => {
		vi.useFakeTimers();
		try {
			const initial = {
				...nonCollabPendingUpdate,
				baseAssetId: undefined,
				baseYjsSequence: 0,
				baseLineageGeneration: 0,
				currentYjsLastSequenceId: "sequence_live",
				pendingMove: { fromPath: "old.txt", toPath: "new.txt" },
			};
			useStableQueryMock.mockReturnValue(initial);
			resolveStatePages({ base: "base\n", staged: "base\n", unstaged: "proposal\n" });
			vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
				text: Result({ _yay: "base\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "base\n" }),
				yjsSequence: 0,
				textKind: "plain_text",
				yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
			});
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_live",
				pendingUpdateId: null,
			});
			await flushNonCollabProposalMount();
			useStableQueryMock.mockReturnValue({
				...initial,
				updatedAt: 2,
				baseYjsSequence: undefined,
				baseLineageGeneration: undefined,
				baseStateId: undefined,
				stagedStateId: undefined,
				unstagedStateId: undefined,
			});
			rerenderWith({});
			await flushNonCollabProposalMount();
			act(() => {
				monacoHarness.changeListeners.forEach((listener) => listener());
			});
			let current = { ...initial, updatedAt: 3 };
			let savedText = "base\n";
			convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
				if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged") savedText = args.text!;
				return { _yay: { operationBatchId: "batch_1" } };
			});
			convexActionMock.mockImplementation(async () => ({
				_yay: { pendingUpdate: current, currentYjsLastSequenceId: "sequence_live" },
			}));
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) =>
				reference !== "get_file_pending_update_state_page"
					? current
					: statePageOf(args.stateId === initial.unstagedStateId ? savedText : "base\n"),
			);
			await typeIntoModifiedPane("fresh content\n");
			useStableQueryMock.mockReturnValue(current);
			rerenderWith({});
			await flushNonCollabProposalMount();
			current = { ...current, updatedAt: 4 };
			await typeIntoModifiedPane("fresh content with typing\n");
			expect(convexActionMock.mock.calls.at(-1)![1].pendingUpdateId).toBe(PENDING_UPDATE_ID);
			expect(convexActionMock.mock.calls.at(-1)![1].reviewedUpdatedAt).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an older query cannot replay typing already confirmed by two newer draft writes", async () => {
		vi.useFakeTimers();
		try {
			const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
			const unstagedDoc = files_yjs_doc_clone({ yjsDoc: baseDoc });
			const pages: Record<string, ReturnType<typeof statePageOf>> = {};
			let persisted = { ...nonCollabPendingUpdate };
			const savePages = () => {
				for (const [id, doc] of [
					[persisted.baseStateId!, baseDoc],
					[persisted.stagedStateId!, baseDoc],
					[persisted.unstagedStateId!, unstagedDoc],
				] as const) {
					const bytes = encodeStateAsUpdate(doc);
					pages[id] = {
						bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
						pageCount: 1,
						totalBytes: bytes.byteLength,
					};
				}
			};
			savePages();
			let submittedText = "base\n";
			useStableQueryMock.mockReturnValue(persisted);
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) =>
				reference === "get_file_pending_update_state_page" ? pages[args.stateId!] : persisted,
			);
			convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
				if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged")
					submittedText = args.text!;
				return { _yay: { operationBatchId: "batch_1" } };
			});
			convexActionMock.mockImplementation(async () => {
				files_yjs_doc_update_from_text({ mut_yjsDoc: unstagedDoc, text: submittedText, rootKind: "plain_text" });
				persisted = {
					...persisted,
					updatedAt: persisted.updatedAt + 1,
					unstagedStateId: `unstaged_${persisted.updatedAt + 1}` as app_convex_Id<"files_pending_update_yjs_states">,
				};
				savePages();
				return { _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: null } };
			});
			const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			await typeIntoModifiedPane("base\ntyping-one");
			const firstSaved = persisted;
			await typeIntoModifiedPane("base\ntyping-one typing-two");
			expect(convexActionMock).toHaveBeenCalledTimes(2);
			useStableQueryMock.mockReturnValue(firstSaved);
			rerenderWith({});
			await flushNonCollabProposalMount();
			expect(getPanes().modified.getValue()).toBe("base\ntyping-one typing-two");
			useStableQueryMock.mockReturnValue(persisted);
			rerenderWith({});
			await flushNonCollabProposalMount();
			expect(getPanes().modified.getValue()).toBe("base\ntyping-one typing-two");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a cached proposal query after an upsert cannot replay the saved typing", async () => {
		vi.useFakeTimers();
		try {
			const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
			const unstagedDoc = files_yjs_doc_clone({ yjsDoc: baseDoc });
			const pages: Record<string, ReturnType<typeof statePageOf>> = {};
			let persisted = { ...nonCollabPendingUpdate };
			let cached = persisted;
			const savePages = () => {
				for (const [id, doc] of [
					[persisted.baseStateId!, baseDoc],
					[persisted.stagedStateId!, baseDoc],
					[persisted.unstagedStateId!, unstagedDoc],
				] as const) {
					const bytes = encodeStateAsUpdate(doc);
					pages[id] = {
						bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
						pageCount: 1,
						totalBytes: bytes.byteLength,
					};
				}
			};
			savePages();
			let submittedText = "base\n";
			useStableQueryMock.mockReturnValue(cached);
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) =>
				reference === "get_file_pending_update_state_page" ? pages[args.stateId!] : cached,
			);
			convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
				if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged")
					submittedText = args.text!;
				return { _yay: { operationBatchId: "batch_1" } };
			});
			convexActionMock.mockImplementation(async () => {
				files_yjs_doc_update_from_text({ mut_yjsDoc: unstagedDoc, text: submittedText, rootKind: "plain_text" });
				persisted = {
					...persisted,
					updatedAt: persisted.updatedAt + 1,
					unstagedStateId: `unstaged_${persisted.updatedAt + 1}` as app_convex_Id<"files_pending_update_yjs_states">,
				};
				savePages();
				return { _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: null } };
			});
			const { rerenderWith, unmount } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			await typeIntoModifiedPane("base\ntyping-one");
			expect(convexActionMock).toHaveBeenCalledTimes(1);
			act(() => {
				getPanes().modified.setValue("base\ntyping-one typing-two");
				for (const listener of monacoHarness.changeListeners) listener();
			});
			cached = persisted;
			useStableQueryMock.mockReturnValue(cached);
			rerenderWith({});
			await flushNonCollabProposalMount();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			await flushNonCollabProposalMount();
			expect(getPanes().modified.getValue()).toBe("base\ntyping-one typing-two");
			expect(submittedText).toBe("base\ntyping-one typing-two");
			// The response confirms the second write while the query still shows the first.
			// A later member save must not capture that confirmed text as an unsaved draft.
			convexActionMock.mockReturnValue(new Promise(() => {}));
			rerenderWith({ committedAssetId: "asset_2" });
			await flushNonCollabProposalMount();
			unmount();
			expect(toast.warning).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test.each([
		"Not found",
		"Pending update changed, retry the write",
		"Pending changes were revised, review the latest version",
	])(
		"keeps later typing for copying when a reviewed write is refused with %s before its first query result",
		async (message) => {
			vi.useFakeTimers();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
			try {
				const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
				vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
					text: Result({ _yay: "base\n" }),
					yjsDoc: baseDoc,
					yjsSequence: 0,
					textKind: "plain_text",
					yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
				});
				useStableQueryMock.mockReturnValue(null);
				const initial = {
					...nonCollabPendingUpdate,
					baseAssetId: undefined,
					baseYjsSequence: 0,
					baseLineageGeneration: 0,
					currentYjsLastSequenceId: "sequence_live",
				};
				let persisted: typeof initial | null = null;
				let savedText = "base\n";
				let stagedInput = "base\n";
				convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
					if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged")
						stagedInput = args.text!;
					return { _yay: { operationBatchId: "batch_1" } };
				});
				convexActionMock.mockImplementation(async (_reference: unknown, args: { pendingUpdateId?: string }) => {
					if (!persisted && args.pendingUpdateId) return { _nay: { message } };
					persisted = { ...initial };
					savedText = stagedInput;
					return { _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" } };
				});
				convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
					if (reference !== "get_file_pending_update_state_page") return persisted;
					const doc = files_yjs_doc_clone({ yjsDoc: baseDoc });
					if (args.stateId === initial.unstagedStateId)
						files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: savedText, rootKind: "plain_text" });
					const bytes = encodeStateAsUpdate(doc);
					return {
						bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
						pageCount: 1,
						totalBytes: bytes.byteLength,
					};
				});
				renderNonCollabProposalReview({
					committedAssetId: "asset_1",
					nonCollaborative: false,
					yjsLastSequenceId: "sequence_live",
					pendingUpdateId: null,
				});
				await flushNonCollabProposalMount();
				await typeIntoModifiedPane("base\nsaved proposal\n");
				// Another tab discards P. Creation and deletion coalesce into the same null query result.
				persisted = null;
				await typeIntoModifiedPane("base\nsaved proposal\nlater typing\n");
				expect(convexActionMock).toHaveBeenCalledTimes(2);
				expect(convexActionMock.mock.calls[1]![1].reviewedUpdatedAt).toBe(1);
				expect(
					convexQueryMock.mock.calls.filter(([reference]) => reference !== "get_file_pending_update_state_page"),
				).toHaveLength(0);
				expect(getPanes().modified.getValue()).toBe("base\nsaved proposal\nlater typing\n");
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
				expect(screen.getByText("This proposal changed. Copy any unsaved text, then reopen Review.")).toBeTruthy();
				fireEvent.click(screen.getByRole("button", { name: "Copy unsaved proposed text" }));
				await act(async () => {});
				expect(writeText).toHaveBeenCalledWith("base\nsaved proposal\nlater typing\n");
				await typeIntoModifiedPane("base\nnew draft\n");
				expect(convexActionMock).toHaveBeenCalledTimes(2);
				expect(savedText).toBe("base\nsaved proposal\n");
			} finally {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		},
	);

	test.each(["missing", "refused"])(
		"keeps both texts for copying and stops queued writes when saved state pages are %s",
		async (pageFailure) => {
			vi.useFakeTimers();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
			try {
				useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
				resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposal\n" });
				const { rerenderWith, unmount } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
				await flushNonCollabProposalMount();
				const saved = { ...nonCollabPendingUpdate, updatedAt: 2, unstagedStateId: "saved_unstaged" };
				const newer = { ...saved, updatedAt: 3, unstagedStateId: "newer_unstaged" };
				const savedPage = Promise.withResolvers<null>();
				convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) => {
					if (args.stateId === "saved_unstaged") return savedPage.promise;
					return statePageOf(
						args.stateId === "state_base"
							? "base\n"
							: args.stateId === "state_staged"
								? "accepted\n"
								: "newer proposal\n",
					);
				});
				convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
				convexActionMock.mockResolvedValue({ _yay: { pendingUpdate: saved, currentYjsLastSequenceId: null } });
				await typeIntoModifiedPane("saved typing\n");
				await typeIntoModifiedPane("saved typing\nlater typing\n");
				useStableQueryMock.mockReturnValue(newer);
				rerenderWith({});
				await flushNonCollabProposalMount();
				await act(async () => {
					if (pageFailure === "missing") savedPage.resolve(null);
					else savedPage.reject(new Error("Unauthenticated"));
				});
				await flushNonCollabProposalMount();
				await act(async () => {
					await vi.advanceTimersByTimeAsync(500);
				});
				expect(convexActionMock).toHaveBeenCalledTimes(1);
				expect(getPanes().modified.getValue()).toBe("saved typing\nlater typing\n");
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
				expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);
				expect(screen.getByText("This proposal changed. Copy any unsaved text, then reopen Review.")).toBeTruthy();
				fireEvent.click(screen.getByRole("button", { name: "Copy unsaved accepted text" }));
				fireEvent.click(screen.getByRole("button", { name: "Copy unsaved proposed text" }));
				await act(async () => {});
				expect(writeText).toHaveBeenCalledWith("accepted\n");
				expect(writeText).toHaveBeenCalledWith("saved typing\nlater typing\n");
				unmount();
				monacoHarness.createdModels.length = 0;
				monacoHarness.changeListeners.length = 0;
				renderNonCollabProposalReview({ committedAssetId: "asset_1" });
				await flushNonCollabProposalMount();
				expect(getPanes().modified.getValue()).toBe("newer proposal\n");
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
			} finally {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		},
	);

	test("a late saved-state read cannot restore an ended proposal as the typing target", async () => {
		vi.useFakeTimers();
		try {
			const initial = {
				...nonCollabPendingUpdate,
				baseAssetId: undefined,
				baseYjsSequence: 0,
				baseLineageGeneration: 0,
				currentYjsLastSequenceId: "sequence_live",
			};
			useStableQueryMock.mockReturnValue(initial);
			resolveStatePages({ base: "base\n", staged: "base\n", unstaged: "proposal\n" });
			vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
				text: Result({ _yay: "base\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "base\n" }),
				yjsSequence: 0,
				textKind: "plain_text",
				yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
			});
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_live",
				pendingUpdateId: null,
			});
			await flushNonCollabProposalMount();
			const pagesFinished = Promise.withResolvers<void>();
			convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
			convexActionMock.mockResolvedValue({
				_yay: { pendingUpdate: { ...initial, updatedAt: 2 }, currentYjsLastSequenceId: "sequence_live" },
			});
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
				if (reference !== "get_file_pending_update_state_page") return { ...initial, updatedAt: 2 };
				const page = statePageOf(args.stateId === initial.unstagedStateId ? "saved typing\n" : "base\n");
				await pagesFinished.promise;
				return page;
			});
			await typeIntoModifiedPane("saved typing\n");
			useStableQueryMock.mockReturnValue(null);
			rerenderWith({});
			await flushNonCollabProposalMount();
			await act(async () => {
				pagesFinished.resolve();
			});
			await flushNonCollabProposalMount();
			convexQueryMock.mockResolvedValue(null);
			act(() => {
				monacoHarness.changeListeners.forEach((listener) => listener());
			});
			await typeIntoModifiedPane("new typing\n");
			expect(convexActionMock.mock.calls.at(-1)![1].pendingUpdateId).toBeUndefined();
			expect(convexActionMock.mock.calls.at(-1)![1].reviewedUpdatedAt).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test.each(["Save", "Discard", "Save before the proposal query", "Discard before the proposal query"] as const)(
		"creates a new proposal after %s ends the saved draft",
		async (ending) => {
			vi.useFakeTimers();
			try {
				let committedText = "base\n";
				let committedSequence = 0;
				let stagedText = committedText;
				let unstagedText = committedText;
				const pendingTemplate = {
					...nonCollabPendingUpdate,
					baseAssetId: undefined,
					baseYjsSequence: 0,
					baseLineageGeneration: 0,
					currentYjsLastSequenceId: "sequence_live",
				};
				let persisted: typeof pendingTemplate | null = null;
				useStableQueryMock.mockReturnValue(null);
				vi.mocked(files_fetch_file_yjs_state_and_text).mockImplementation(async () => ({
					text: Result({ _yay: committedText }),
					yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: committedText }),
					yjsSequence: committedSequence,
					textKind: "plain_text",
					yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
				}));
				convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
					if (reference === "stage_file_pending_update_text_input") {
						if (args.role === "staged") stagedText = args.text!;
						if (args.role === "unstaged") unstagedText = args.text!;
					}
					return { _yay: { operationBatchId: "batch_1" } };
				});
				convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
					if (reference !== "get_file_pending_update_state_page") return persisted;
					return statePageOf(
						args.stateId === pendingTemplate.stagedStateId
							? stagedText
							: args.stateId === pendingTemplate.unstagedStateId
								? unstagedText
								: committedText,
					);
				});
				convexActionMock.mockImplementation(async (reference: unknown, args: { pendingUpdateId?: string }) => {
					if (reference === "upsert_file_pending_update") {
						if (!persisted && args.pendingUpdateId) return { _nay: { message: "Not found" } };
						persisted =
							stagedText === committedText && unstagedText === committedText
								? null
								: { ...pendingTemplate, updatedAt: (persisted?.updatedAt ?? 0) + 1 };
						return { _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" } };
					}
					committedText = stagedText;
					committedSequence += 1;
					persisted = null;
					useStableQueryMock.mockReturnValue(null);
					return { _yay: { newSequence: committedSequence, pendingUpdateUpdatedAt: null } };
				});
				const { rerenderWith } = renderNonCollabProposalReview({
					committedAssetId: "asset_1",
					nonCollaborative: false,
					yjsLastSequenceId: "sequence_live",
					pendingUpdateId: null,
				});
				await flushNonCollabProposalMount();
				await typeIntoModifiedPane("base draft\n");
				if (!ending.includes("before")) {
					useStableQueryMock.mockReturnValue(persisted);
					rerenderWith({});
					await flushNonCollabProposalMount();
				}
				if (ending.startsWith("Save")) {
					fireEvent.click(screen.getByRole("button", { name: "Accept all pending changes and save" }));
				} else if (ending.includes("before")) {
					fireEvent.click(screen.getByRole("button", { name: "Discard all pending changes in this file" }));
					act(() => {
						monacoHarness.changeListeners.forEach((listener) => listener());
					});
					await act(async () => {
						await vi.advanceTimersByTimeAsync(250);
					});
				} else {
					// A content discard from the pending sidebar removes this exact proposal.
					persisted = null;
					useStableQueryMock.mockReturnValue(null);
					rerenderWith({});
				}
				await flushNonCollabProposalMount();
				expect(getPanes().modified.getValue()).toBe(committedText);
				act(() => {
					monacoHarness.changeListeners.forEach((listener) => listener());
				});
				await typeIntoModifiedPane("next draft\n");
				expect(convexActionMock.mock.calls.at(-1)![0]).toBe("upsert_file_pending_update");
				expect(convexActionMock.mock.calls.at(-1)![1].pendingUpdateId).toBeUndefined();
				expect(convexActionMock.mock.calls.at(-1)![1].reviewedUpdatedAt).toBeUndefined();
				expect(getPanes().modified.getValue()).toBe("next draft\n");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	test.each(["before", "after"] as const)(
		"sends typing queued while the previous draft arrives through the query %s its action finishes",
		async (queryOrder) => {
			vi.useFakeTimers();
			try {
				const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
				let persisted = {
					...nonCollabPendingUpdate,
					baseAssetId: undefined,
					baseYjsSequence: 0,
					baseLineageGeneration: 0,
					currentYjsLastSequenceId: "sequence_live",
				};
				let savedText = "base\n";
				useStableQueryMock.mockReturnValue(persisted);
				convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
					if (reference !== "get_file_pending_update_state_page") return persisted;
					const doc = files_yjs_doc_clone({ yjsDoc: baseDoc });
					if (args.stateId === persisted.unstagedStateId) {
						files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: savedText, rootKind: "plain_text" });
					}
					const bytes = encodeStateAsUpdate(doc);
					return {
						bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
						pageCount: 1,
						totalBytes: bytes.byteLength,
					};
				});
				convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
				const firstUpsert = Promise.withResolvers<{
					_yay: { pendingUpdate: typeof persisted; currentYjsLastSequenceId: string };
				}>();
				convexActionMock.mockReturnValueOnce(firstUpsert.promise).mockImplementation(async () => ({
					_yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" },
				}));
				const { rerenderWith } = renderNonCollabProposalReview({
					committedAssetId: "asset_1",
					nonCollaborative: false,
					yjsLastSequenceId: "sequence_live",
				});
				await flushNonCollabProposalMount();
				await typeIntoModifiedPane("base A\n");
				expect(convexActionMock).toHaveBeenCalledTimes(1);
				act(() => {
					getPanes().modified.setValue("base A B\n");
					monacoHarness.changeListeners.forEach((listener) => listener());
				});
				savedText = "base A\n";
				persisted = { ...persisted, updatedAt: 2 };
				if (queryOrder === "after")
					await act(async () => {
						firstUpsert.resolve({ _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" } });
					});
				useStableQueryMock.mockReturnValue(persisted);
				rerenderWith({});
				await flushNonCollabProposalMount();
				if (queryOrder === "before") {
					await act(async () => {
						firstUpsert.resolve({ _yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" } });
					});
					await flushNonCollabProposalMount();
				}
				expect(getPanes().modified.getValue()).toBe("base A B\n");
				await act(async () => {
					await vi.advanceTimersByTimeAsync(250);
				});
				expect(convexActionMock).toHaveBeenCalledTimes(2);
				expect(convexActionMock.mock.calls[1]![1].reviewedUpdatedAt).toBe(2);
				expect(convexMutationMock).toHaveBeenLastCalledWith(
					"stage_file_pending_update_text_input",
					expect.objectContaining({ role: "unstaged", text: "base A B\n" }),
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	test("keeps normal typing on the live document and advances the review timestamp only after loading its saved draft", async () => {
		vi.useFakeTimers();
		try {
			const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "base\n" });
			vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
				text: Result({ _yay: "base\n" }),
				yjsDoc: baseDoc,
				yjsSequence: 0,
				textKind: "plain_text",
				yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
			});
			useStableQueryMock.mockReturnValue(null);
			let savedText = "base\n";
			let persisted = {
				...nonCollabPendingUpdate,
				baseAssetId: undefined,
				baseYjsSequence: 0,
				baseLineageGeneration: 0,
				currentYjsLastSequenceId: "sequence_live",
			};
			convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
				if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged") savedText = args.text!;
				return { _yay: { operationBatchId: "batch_1" } };
			});
			convexActionMock.mockImplementation(async () => ({
				_yay: { pendingUpdate: persisted, currentYjsLastSequenceId: "sequence_live" },
			}));
			convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
				if (reference !== "get_file_pending_update_state_page") return persisted;
				const doc = files_yjs_doc_clone({ yjsDoc: baseDoc });
				if (args.stateId === persisted.unstagedStateId)
					files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: savedText, rootKind: "plain_text" });
				const bytes = encodeStateAsUpdate(doc);
				return {
					bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
					pageCount: 1,
					totalBytes: bytes.byteLength,
				};
			});
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_live",
				pendingUpdateId: null,
			});
			await flushNonCollabProposalMount();
			await typeIntoModifiedPane("first draft\n");
			expect(convexActionMock.mock.calls[0]![1].reviewedUpdatedAt).toBeUndefined();
			useStableQueryMock.mockReturnValue(persisted);
			rerenderWith({});
			await flushNonCollabProposalMount();
			expect(screen.queryByText("Your unsaved text was kept here while the proposal changed.")).toBeNull();
			expect(getPanes().modified.getValue()).toBe("first draft\n");
			persisted = { ...persisted, updatedAt: 2 };
			await typeIntoModifiedPane("second draft\n");
			await flushNonCollabProposalMount();
			expect(convexActionMock.mock.calls[1]![1].reviewedUpdatedAt).toBe(1);
			persisted = { ...persisted, updatedAt: 3 };
			await typeIntoModifiedPane("third draft\n");
			await flushNonCollabProposalMount();
			expect(convexActionMock.mock.calls[2]![1].reviewedUpdatedAt).toBe(2);
			expect(getPanes().modified.getValue()).toBe("third draft\n");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("FileEditorDiff after a collaboration change", () => {
	test("Sync sends the captured proposal revision with both rebased branches", async () => {
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			updatedAt: 3,
			baseAssetId: undefined,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
			currentYjsLastSequenceId: "sequence_live",
		});
		resolveStatePages({ base: "Budget: 100\n", staged: "Budget: 150\n", unstaged: "Budget: 170\n" });
		renderNonCollabProposalReview({
			committedAssetId: "asset_1",
			nonCollaborative: false,
			yjsLastSequenceId: "sequence_live",
			serverSequence: 1,
		});
		await flushNonCollabProposalMount();
		vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
			text: Result({ _yay: "Budget: 120\n" }),
			yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "Budget: 120\n" }),
			yjsSequence: 1,
			textKind: "plain_text",
			yjsLastSequenceId: "sequence_live" as app_convex_Id<"files_yjs_docs_last_sequences">,
		});
		vi.mocked(files_persist_file_pending_update_rebased_state).mockResolvedValue(
			Result({ _yay: { pendingUpdate: null } }),
		);

		fireEvent.click(screen.getByRole("button", { name: "Sync with live file" }));
		await flushNonCollabProposalMount();
		expect(files_persist_file_pending_update_rebased_state).toHaveBeenCalledWith(
			expect.objectContaining({
				pendingUpdateId: PENDING_UPDATE_ID,
				reviewedUpdatedAt: 3,
				baseYjsSequence: 1,
			}),
		);
		const [accepted, proposed] = vi.mocked(files_yjs_rebase_branch_with_local_text).mock.results;
		expect(accepted?.value._yay.rebasedBranchText).toBe("Budget: 150\n");
		expect(proposed?.value._yay.rebasedBranchText).toBe("Budget: 170\n");
		expect(vi.mocked(files_yjs_rebase_branch_with_local_text).mock.calls[1]?.[0].nextBranchYjsDoc).toBe(
			accepted?.value._yay.rebasedBranchYjsDoc,
		);
	});

	test("loads preserved branches using their source shape before preparing the new shape", async () => {
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			contentNeedsRebase: true,
			contentRebaseRootKind: "plain_text",
		});
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		renderNonCollabProposalReview({ committedAssetId: "asset_2", rootKind: "rich_text" });
		await flushNonCollabProposalMount();

		expect(getPanes().original.getValue()).toBe("accepted\n");
		expect(getPanes().modified.getValue()).toBe("proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		expect(
			convexActionMock.mock.calls.some(
				([reference]) =>
					getFunctionName(reference as never) === "files_pending_updates:prepare_file_pending_update_for_review",
			),
		).toBe(true);
	});

	test("restore leaves the accepted and proposed panes intact until preparation reloads them", async () => {
		const initial = {
			...nonCollabPendingUpdate,
			baseAssetId: undefined,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
			currentYjsLastSequenceId: "sequence_old",
		};
		useStableQueryMock.mockReturnValue(initial);
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({
			committedAssetId: "asset_1",
			nonCollaborative: false,
			yjsLastSequenceId: "sequence_old",
		});
		await flushNonCollabProposalMount();
		vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
			text: Result({ _yay: "restored\n" }),
			yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "restored\n" }),
			yjsSequence: 1,
			textKind: "plain_text",
			yjsLastSequenceId: "sequence_old" as app_convex_Id<"files_yjs_docs_last_sequences">,
		});

		fireEvent.click(screen.getByRole("button", { name: "Restore test snapshot" }));
		await flushNonCollabProposalMount();
		expect(getPanes().original.getValue()).toBe("accepted\n");
		expect(getPanes().modified.getValue()).toBe("proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });

		// Preparation may finish before the tab receives the temporary marker.
		const prepared = {
			...initial,
			updatedAt: 2,
			baseYjsSequence: 1,
			baseStateId: "restored_base",
			stagedStateId: "restored_staged",
			unstagedStateId: "restored_unstaged",
		};
		convexActionMock.mockResolvedValue({ _yay: { pendingUpdate: prepared } });
		useStableQueryMock.mockReturnValue(prepared);
		const restoredPages: Record<string, ReturnType<typeof statePageOf>> = {
			restored_base: statePageOf("restored\n"),
			restored_staged: statePageOf("restored accepted\n"),
			restored_unstaged: statePageOf("restored proposed\n"),
		};
		convexQueryMock.mockImplementation(
			async (_reference: unknown, args: { stateId: string }) => restoredPages[args.stateId],
		);
		rerenderWith({});
		await flushNonCollabProposalMount();
		expect(getPanes().original.getValue()).toBe("restored accepted\n");
		expect(getPanes().modified.getValue()).toBe("restored proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
	});

	test.each([true, false])(
		"restore waits for its confirmed panes; prepared pages arrived first: %s",
		async (pagesArrivedFirst) => {
			const initial = {
				...nonCollabPendingUpdate,
				baseAssetId: undefined,
				baseYjsSequence: 0,
				baseLineageGeneration: 0,
				currentYjsLastSequenceId: "sequence_live",
			};
			const prepared = {
				...initial,
				updatedAt: 2,
				baseYjsSequence: 1,
				baseStateId: "restored_base",
				stagedStateId: "restored_staged",
				unstagedStateId: "restored_unstaged",
			};
			const pages: Record<string, ReturnType<typeof statePageOf>> = {
				state_base: statePageOf("base\n"),
				state_staged: statePageOf("accepted\n"),
				state_unstaged: statePageOf("proposed\n"),
				restored_base: statePageOf("restored\n"),
				restored_staged: statePageOf("restored accepted\n"),
				restored_unstaged: statePageOf("restored proposed\n"),
			};
			convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) => pages[args.stateId]);
			useStableQueryMock.mockReturnValue(pagesArrivedFirst ? prepared : initial);
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_live",
			});
			await flushNonCollabProposalMount();
			expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });

			// The action can confirm preparation before or after its query and pages reach the panes.
			convexActionMock.mockResolvedValue({ _yay: { pendingUpdate: prepared } });
			fireEvent.click(screen.getByRole("button", { name: "Restore test snapshot" }));
			await flushNonCollabProposalMount();
			if (!pagesArrivedFirst) {
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
				expect(getPanes().modified.getValue()).toBe("proposed\n");
				useStableQueryMock.mockReturnValue(prepared);
				rerenderWith({});
				await flushNonCollabProposalMount();
			}
			expect(getPanes().original.getValue()).toBe("restored accepted\n");
			expect(getPanes().modified.getValue()).toBe("restored proposed\n");
			expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
			expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(false);
		},
	);

	test("an editor-created draft pauses when its document changes before a proposal doc exists", async () => {
		vi.useFakeTimers();
		try {
			useStableQueryMock.mockReturnValue(null);
			vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
				text: Result({ _yay: "old\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "old\n" }),
				yjsSequence: 10,
				textKind: "plain_text",
				yjsLastSequenceId: "sequence_old" as app_convex_Id<"files_yjs_docs_last_sequences">,
			});
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_old",
				pendingUpdateId: null,
			});
			await flushNonCollabProposalMount();
			act(() => {
				getPanes().modified.setValue("unsent old draft\n");
				monacoHarness.changeListeners.forEach((listener) => listener());
			});
			const nextContent = {
				text: Result({ _yay: "new\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "new\n" }),
				yjsSequence: 0,
				textKind: "plain_text" as const,
				yjsLastSequenceId: "sequence_new" as app_convex_Id<"files_yjs_docs_last_sequences">,
			};
			const fetchFinished = Promise.withResolvers<typeof nextContent>();
			vi.mocked(files_fetch_file_yjs_state_and_text).mockReturnValue(fetchFinished.promise);
			rerenderWith({ yjsLastSequenceId: "sequence_new" });
			await flushNonCollabProposalMount();
			expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			expect(convexMutationMock).not.toHaveBeenCalled();
			await act(async () => {
				fetchFinished.resolve(nextContent);
			});
			await flushNonCollabProposalMount();
			expect(getPanes().modified.getValue()).toBe("new\n");
			expect(screen.getByRole("button", { name: "Copy unsaved proposed text" })).toBeTruthy();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(250);
			});
			expect(convexMutationMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("Sync does not rebase a fetched document against panes from an older document", async () => {
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			baseAssetId: undefined,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
			currentYjsLastSequenceId: "sequence_old",
		});
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		renderNonCollabProposalReview({
			committedAssetId: "asset_1",
			nonCollaborative: false,
			yjsLastSequenceId: "sequence_old",
			serverSequence: 1,
		});
		await flushNonCollabProposalMount();
		vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValue({
			text: Result({ _yay: "new document\n" }),
			yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "new document\n" }),
			yjsSequence: 1,
			textKind: "plain_text",
			yjsLastSequenceId: "sequence_new" as app_convex_Id<"files_yjs_docs_last_sequences">,
		});
		fireEvent.click(screen.getByRole("button", { name: "Sync with live file" }));
		await flushNonCollabProposalMount();
		expect(files_yjs_rebase_branch_with_local_text).not.toHaveBeenCalled();
		expect(files_persist_file_pending_update_rebased_state).not.toHaveBeenCalled();
		expect(convexMutationMock).not.toHaveBeenCalled();
		expect(getPanes().modified.getValue()).toBe("proposed\n");
	});

	test.each(["Save", "Sync"] as const)(
		"a late %s refresh cannot replace the document after a mode cycle",
		async (action) => {
			useStableQueryMock.mockReturnValue({
				...nonCollabPendingUpdate,
				baseAssetId: undefined,
				baseYjsSequence: 0,
				baseLineageGeneration: 0,
				currentYjsLastSequenceId: "sequence_old",
			});
			resolveStatePages({ base: "old\n", staged: "old accepted\n", unstaged: "old accepted\n" });
			const oldRefresh = {
				text: Result({ _yay: "old saved\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "old saved\n" }),
				yjsSequence: 10,
				textKind: "plain_text" as const,
				yjsLastSequenceId: "sequence_old" as app_convex_Id<"files_yjs_docs_last_sequences">,
			};
			const newContent = {
				text: Result({ _yay: "new document\n" }),
				yjsDoc: files_yjs_doc_create_plain_text_from_text({ text: "new document\n" }),
				yjsSequence: 0,
				textKind: "plain_text" as const,
				yjsLastSequenceId: "sequence_new" as app_convex_Id<"files_yjs_docs_last_sequences">,
			};
			const { rerenderWith } = renderNonCollabProposalReview({
				committedAssetId: "asset_1",
				nonCollaborative: false,
				yjsLastSequenceId: "sequence_old",
				serverSequence: 10,
			});
			await flushNonCollabProposalMount();
			const queryFinished = Promise.withResolvers<null>();
			const fetchFinished = Promise.withResolvers<typeof oldRefresh>();
			const readStatePage = convexQueryMock.getMockImplementation()!;
			convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
			convexActionMock.mockImplementation(async (reference: unknown) =>
				reference === "upsert_file_pending_update"
					? {
							_yay: {
								pendingUpdate: {
									...nonCollabPendingUpdate,
									baseAssetId: undefined,
									baseYjsSequence: 0,
									baseLineageGeneration: 0,
									updatedAt: 2,
								},
								currentYjsLastSequenceId: "sequence_old",
							},
						}
					: { _yay: { newSequence: 10, pendingUpdateUpdatedAt: null } },
			);
			if (action === "Save") {
				// The query waits for the saved proposal after the draft flush's exact action result.
				convexQueryMock.mockImplementation((reference: unknown, args: unknown) => {
					if (reference === "get_file_pending_update_state_page") return readStatePage(reference, args);
					return queryFinished.promise;
				});
				vi.mocked(files_fetch_file_yjs_state_and_text)
					.mockReturnValueOnce(fetchFinished.promise)
					.mockResolvedValue(newContent);
			} else {
				convexQueryMock.mockImplementation((reference: unknown, args: unknown) =>
					reference === "get_file_pending_update_state_page" ? readStatePage(reference, args) : queryFinished.promise,
				);
				vi.mocked(files_fetch_file_yjs_state_and_text).mockResolvedValueOnce(oldRefresh).mockResolvedValue(newContent);
				vi.mocked(files_persist_file_pending_update_rebased_state).mockResolvedValue(
					Result({ _yay: { pendingUpdate: null } }),
				);
			}
			fireEvent.click(
				screen.getByRole("button", { name: action === "Save" ? "Save staged changes" : "Sync with live file" }),
			);
			await flushNonCollabProposalMount();
			expect(files_fetch_file_yjs_state_and_text).toHaveBeenCalledTimes(2);
			useStableQueryMock.mockReturnValue(null);
			rerenderWith({ yjsLastSequenceId: "sequence_new", serverSequence: 0 });
			await flushNonCollabProposalMount();
			await act(async () => {
				fetchFinished.resolve(oldRefresh);
				queryFinished.resolve(null);
			});
			await flushNonCollabProposalMount();
			expect(getPanes().original.getValue()).toBe("new document\n");
			expect(getPanes().modified.getValue()).toBe("new document\n");
		},
	);

	test("new proposal pages can arrive before the node's new document id", async () => {
		const initial = {
			...nonCollabPendingUpdate,
			baseAssetId: undefined,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
			currentYjsLastSequenceId: "sequence_old",
		};
		useStableQueryMock.mockReturnValue(initial);
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({
			committedAssetId: "asset_1",
			nonCollaborative: false,
			yjsLastSequenceId: "sequence_old",
		});
		await flushNonCollabProposalMount();
		const prepared = {
			...initial,
			updatedAt: 2,
			baseStateId: "base_2",
			stagedStateId: "staged_2",
			unstagedStateId: "unstaged_2",
			currentYjsLastSequenceId: "sequence_new",
		};
		const texts: Record<string, string> = { base_2: "new\n", staged_2: "new accepted\n", unstaged_2: "new proposed\n" };
		convexQueryMock.mockImplementation(async (_name: unknown, args: { stateId: string }) =>
			statePageOf(texts[args.stateId]!),
		);
		useStableQueryMock.mockReturnValue(prepared);
		rerenderWith({});
		await flushNonCollabProposalMount();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		rerenderWith({ yjsLastSequenceId: "sequence_new" });
		await flushNonCollabProposalMount();
		expect(getPanes().original.getValue()).toBe("new accepted\n");
		expect(getPanes().modified.getValue()).toBe("new proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
	});

	test.each(["on", "off"] as const)(
		"new proposal pages stay blocked until collaboration switches %s in the parent",
		async (mode) => {
			vi.useFakeTimers();
			try {
				const initial =
					mode === "on"
						? nonCollabPendingUpdate
						: {
								...nonCollabPendingUpdate,
								baseAssetId: undefined,
								baseYjsSequence: 0,
								baseLineageGeneration: 0,
								currentYjsLastSequenceId: "sequence_old",
							};
				useStableQueryMock.mockReturnValue(initial);
				resolveStatePages({ base: "old\n", staged: "old accepted\n", unstaged: "old proposed\n" });
				const { rerenderWith } = renderNonCollabProposalReview({
					committedAssetId: "asset_1",
					nonCollaborative: mode === "on",
					yjsLastSequenceId: mode === "off" ? "sequence_old" : undefined,
				});
				await flushNonCollabProposalMount();
				let prepared = {
					...nonCollabPendingUpdate,
					updatedAt: 2,
					baseStateId: "base_2",
					stagedStateId: "staged_2",
					unstagedStateId: "unstaged_2",
					baseAssetId: mode === "on" ? undefined : "asset_2",
					baseYjsSequence: mode === "on" ? 0 : undefined,
					baseLineageGeneration: mode === "on" ? 0 : undefined,
					currentYjsLastSequenceId: mode === "on" ? "sequence_new" : null,
				};
				const baseDoc = files_yjs_doc_create_plain_text_from_text({ text: "new\n" });
				let savedText = "new proposed\n";
				convexQueryMock.mockImplementation(async (reference: unknown, args: { stateId?: string }) => {
					if (reference !== "get_file_pending_update_state_page") return prepared;
					const doc = files_yjs_doc_clone({ yjsDoc: baseDoc });
					if (args.stateId === prepared.stagedStateId)
						files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: "new accepted\n", rootKind: "plain_text" });
					if (args.stateId === prepared.unstagedStateId)
						files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: savedText, rootKind: "plain_text" });
					const bytes = encodeStateAsUpdate(doc);
					return {
						bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
						pageCount: 1,
						totalBytes: bytes.byteLength,
					};
				});
				useStableQueryMock.mockReturnValue(prepared);
				rerenderWith({});
				await flushNonCollabProposalMount();
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
				const nextProps = {
					nonCollaborative: mode === "off",
					yjsLastSequenceId: mode === "on" ? "sequence_new" : undefined,
					committedAssetId: mode === "on" ? "asset_1" : "asset_2",
				};
				rerenderWith(nextProps);
				await flushNonCollabProposalMount();
				expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
				// Monaco reports the two programmatic pane replacements before the next user edit.
				act(() => {
					monacoHarness.changeListeners.forEach((listener) => listener());
				});
				convexMutationMock.mockImplementation(async (reference: string, args: { role?: string; text?: string }) => {
					if (reference === "stage_file_pending_update_text_input" && args.role === "unstaged") savedText = args.text!;
					return { _yay: { operationBatchId: "batch_1" } };
				});
				convexActionMock.mockImplementation(async () => {
					prepared = { ...prepared, updatedAt: prepared.updatedAt + 1 };
					return { _yay: { pendingUpdate: prepared, currentYjsLastSequenceId: prepared.currentYjsLastSequenceId } };
				});
				await typeIntoModifiedPane("new proposed A\n");
				useStableQueryMock.mockReturnValue(prepared);
				rerenderWith(nextProps);
				await flushNonCollabProposalMount();
				expect(getPanes().modified.getValue()).toBe("new proposed A\n");
				await typeIntoModifiedPane("new proposed A B\n");
				expect(convexActionMock).toHaveBeenCalledTimes(2);
				expect(convexActionMock.mock.calls[1]![1].reviewedUpdatedAt).toBe(3);
				expect(getPanes().modified.getValue()).toBe("new proposed A B\n");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	test.each([true, false])("prepares once and waits for query and pages with a toggle marker: %s", async (marked) => {
		const pending = { ...nonCollabPendingUpdate, contentNeedsRebase: marked || undefined } as const;
		const prepared = {
			...nonCollabPendingUpdate,
			updatedAt: 2,
			baseAssetId: "asset_2",
			baseStateId: "base_2",
			stagedStateId: "staged_2",
			unstagedStateId: "unstaged_2",
		} as unknown as app_convex_Doc<"files_pending_updates">;
		useStableQueryMock.mockReturnValue(pending);
		resolveStatePages({ base: "old\n", staged: "old accepted\n", unstaged: "old proposed\n" });
		const action = Promise.withResolvers<{ _yay: { pendingUpdate: typeof prepared } }>();
		convexActionMock.mockReturnValue(action.promise);
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();
		expect(convexActionMock).toHaveBeenCalledTimes(1);
		expect(getFunctionName(convexActionMock.mock.calls[0]![0])).toBe(
			"files_pending_updates:prepare_file_pending_update_for_review",
		);
		expect(convexActionMock.mock.calls[0]![1]).toEqual({
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			pendingUpdateId: PENDING_UPDATE_ID,
		});
		expect(screen.getByRole("status").textContent).toContain("Updating this proposal");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		await act(async () => {
			action.resolve({ _yay: { pendingUpdate: prepared } });
		});
		expect(screen.queryByRole("button", { name: "Save staged changes" })).toBeNull();

		const pages = Promise.withResolvers<void>();
		const newTexts: Record<string, string> = {
			base_2: "new\n",
			staged_2: "new accepted\n",
			unstaged_2: "new proposed\n",
		};
		convexQueryMock.mockImplementation(async (_name: unknown, args: { stateId: string }) => {
			await pages.promise;
			return statePageOf(newTexts[args.stateId]!);
		});
		useStableQueryMock.mockReturnValue(prepared);
		rerenderWith({});
		await act(async () => {});
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);
		expect(getPanes().modified.getValue()).toBe("old proposed\n");
		await act(async () => {
			pages.resolve();
		});
		await flushNonCollabProposalMount();
		expect(getPanes().original.getValue()).toBe("new accepted\n");
		expect(getPanes().modified.getValue()).toBe("new proposed\n");
		expect(monacoHarness.createdModels).toHaveLength(2);
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
	});

	test.each([true, false])("a conflict keeps both copies and Retry with a toggle marker: %s", async (marked) => {
		useStableQueryMock.mockReturnValue({ ...nonCollabPendingUpdate, contentNeedsRebase: marked || undefined });
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		convexActionMock.mockResolvedValue({ _nay: { message: "These changes overlap newer file text." } });
		convexMutationMock.mockResolvedValue({ _yay: null });
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		try {
			renderNonCollabProposalReview({ committedAssetId: "asset_2" });
			await flushNonCollabProposalMount();
			expect(convexActionMock).toHaveBeenCalledTimes(1);
			expect(screen.getByRole("status").textContent).toContain("overlap newer file text");
			fireEvent.click(screen.getByRole("button", { name: "Copy accepted text" }));
			fireEvent.click(screen.getByRole("button", { name: "Copy proposed text" }));
			await act(async () => {});
			expect(writeText.mock.calls).toEqual([["accepted\n"], ["proposed\n"]]);
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			await flushNonCollabProposalMount();
			expect(convexActionMock).toHaveBeenCalledTimes(2);
			fireEvent.click(screen.getByRole("button", { name: "Discard proposal" }));
			await act(async () => {});
			expect(getFunctionName(convexMutationMock.mock.calls[0]![0])).toBe(
				"files_pending_updates:discard_file_pending_content",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test.each([true, false])(
		"a changed file keeps unsent text after preparation with a toggle marker: %s",
		async (marked) => {
			vi.useFakeTimers();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
			try {
				useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
				resolveStatePages({ base: "base\n", staged: "base\n", unstaged: "proposed\n" });
				convexActionMock.mockReturnValue(new Promise(() => {}));
				const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
				await flushNonCollabProposalMount();
				act(() => {
					getPanes().modified.setValue("unsent typing\n");
					monacoHarness.changeListeners.forEach((listener) => listener());
				});
				useStableQueryMock.mockReturnValue({ ...nonCollabPendingUpdate, contentNeedsRebase: marked || undefined });
				rerenderWith({ committedAssetId: "asset_2" });
				await flushNonCollabProposalMount();
				await act(async () => {
					await vi.advanceTimersByTimeAsync(250);
				});
				expect(convexMutationMock).not.toHaveBeenCalled();
				const prepared = {
					...nonCollabPendingUpdate,
					updatedAt: 2,
					baseAssetId: "asset_2",
					baseStateId: "base_2",
					stagedStateId: "staged_2",
					unstagedStateId: "unstaged_2",
				};
				const texts: Record<string, string> = { base_2: "new\n", staged_2: "new\n", unstaged_2: "new proposed\n" };
				convexQueryMock.mockImplementation(async (_name: unknown, args: { stateId: string }) =>
					statePageOf(texts[args.stateId]!),
				);
				useStableQueryMock.mockReturnValue(prepared);
				rerenderWith({ committedAssetId: "asset_2" });
				await flushNonCollabProposalMount();
				expect(getPanes().modified.getValue()).toBe("new proposed\n");
				fireEvent.click(screen.getByRole("button", { name: "Copy unsaved proposed text" }));
				await act(async () => {});
				expect(writeText).toHaveBeenCalledWith("unsent typing\n");
			} finally {
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		},
	);

	test.each([
		["before capture", true],
		["after capture", true],
		["after capture", false],
	] as const)("Review closing %s keeps unsent copies; accepted text changed: %s", async (order, acceptedChanged) => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		try {
			useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
			resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
			convexActionMock.mockReturnValue(new Promise(() => {}));
			const { rerenderWith, unmount } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			act(() => {
				if (acceptedChanged) getPanes().original.setValue("unsent accepted\n");
				getPanes().modified.setValue("unsent proposed\n");
				monacoHarness.changeListeners.forEach((listener) => listener());
			});
			if (order === "after capture") {
				rerenderWith({ committedAssetId: "asset_2" });
				await flushNonCollabProposalMount();
			}
			// FileEditor removes Review immediately when another tab's preparation settles its doc.
			unmount();
			const warnings = vi.mocked(toast.warning).mock.calls;
			expect(warnings).toHaveLength(acceptedChanged ? 2 : 1);
			expect(warnings.map(([message]) => message)).toEqual(
				acceptedChanged
					? ["Review closed with unsaved accepted text.", "Review closed with unsaved proposed text."]
					: ["Review closed with unsaved proposed text."],
			);
			for (const [, options] of warnings) {
				expect(options?.duration).toBe(30_000);
				const action = options?.action;
				if (!action || typeof action !== "object" || !("onClick" in action)) {
					throw new Error("Expected a copy action");
				}
				action.onClick({} as never);
			}
			await act(async () => {});
			expect(writeText.mock.calls).toEqual(
				acceptedChanged ? [["unsent accepted\n"], ["unsent proposed\n"]] : [["unsent proposed\n"]],
			);
			expect(convexMutationMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	test("closing clean Review does not warn about stored proposal text", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { unmount } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		unmount();
		expect(toast.warning).not.toHaveBeenCalled();
	});

	test("prepared asset pages stay read-only until the parent receives the same saved asset", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			updatedAt: 2,
			baseAssetId: "asset_2",
			baseStateId: "new_base",
			stagedStateId: "new_staged",
			unstagedStateId: "new_unstaged",
		});
		const texts: Record<string, string> = {
			new_base: "current\n",
			new_staged: "current accepted\n",
			new_unstaged: "current proposed\n",
		};
		convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) =>
			statePageOf(texts[args.stateId]!),
		);
		rerenderWith({});
		await flushNonCollabProposalMount();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		expect(screen.queryByRole("button", { name: "Save staged changes" })).toBeNull();
		rerenderWith({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();
		expect(getPanes().original.getValue()).toBe("current accepted\n");
		expect(getPanes().modified.getValue()).toBe("current proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
		expect(convexMutationMock).not.toHaveBeenCalled();
	});

	test("prepared panes replace old text while an older draft response is still waiting", async () => {
		vi.useFakeTimers();
		try {
			useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
			resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
			convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
			const oldWrite = Promise.withResolvers<{
				_yay: { pendingUpdate: typeof nonCollabPendingUpdate; currentYjsLastSequenceId: null };
			}>();
			convexActionMock.mockImplementation((reference: unknown) =>
				reference === "upsert_file_pending_update" ? oldWrite.promise : new Promise(() => {}),
			);
			const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();
			await typeIntoModifiedPane("old typing\n");
			rerenderWith({ committedAssetId: "asset_2" });
			await flushNonCollabProposalMount();
			const prepared = {
				...nonCollabPendingUpdate,
				updatedAt: 3,
				baseAssetId: "asset_2",
				baseStateId: "new_base",
				stagedStateId: "new_staged",
				unstagedStateId: "new_unstaged",
			};
			const texts: Record<string, string> = {
				new_base: "current\n",
				new_staged: "current accepted\n",
				new_unstaged: "current proposed\n",
			};
			convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) =>
				statePageOf(texts[args.stateId]!),
			);
			useStableQueryMock.mockReturnValue(prepared);
			rerenderWith({ committedAssetId: "asset_2" });
			await flushNonCollabProposalMount();
			expect(getPanes().modified.getValue()).toBe("current proposed\n");
			const pageCalls = convexQueryMock.mock.calls.length;
			await act(async () => {
				oldWrite.resolve({
					_yay: { pendingUpdate: { ...nonCollabPendingUpdate, updatedAt: 2 }, currentYjsLastSequenceId: null },
				});
			});
			await flushNonCollabProposalMount();
			expect(convexQueryMock.mock.calls.length).toBe(pageCalls);
			expect(getPanes().modified.getValue()).toBe("current proposed\n");
			// Report Monaco's two programmatic pane changes before the next member edit.
			act(() => monacoHarness.changeListeners.forEach((listener) => listener()));
			convexActionMock.mockResolvedValue({ _yay: { pendingUpdate: prepared, currentYjsLastSequenceId: null } });
			await typeIntoModifiedPane("current proposed\nnext typing\n");
			expect(convexActionMock.mock.calls.at(-1)?.[1].reviewedUpdatedAt).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a mode cycle with the same counter blocks the old family even when its marker was missed", async () => {
		const initial = {
			...nonCollabPendingUpdate,
			baseAssetId: undefined,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
			currentYjsLastSequenceId: "sequence_old",
		};
		useStableQueryMock.mockReturnValue(initial);
		resolveStatePages({ base: "base\n", staged: "accepted\n", unstaged: "proposed\n" });
		const { rerenderWith } = renderNonCollabProposalReview({
			committedAssetId: "asset_1",
			nonCollaborative: false,
			yjsLastSequenceId: "sequence_old",
		});
		await flushNonCollabProposalMount();
		rerenderWith({ yjsLastSequenceId: "sequence_new" });
		await flushNonCollabProposalMount();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);
		useStableQueryMock.mockReturnValue({
			...initial,
			updatedAt: 2,
			baseStateId: "base_2",
			stagedStateId: "staged_2",
			unstagedStateId: "unstaged_2",
			currentYjsLastSequenceId: "sequence_new",
		});
		const texts: Record<string, string> = { base_2: "base\n", staged_2: "accepted\n", unstaged_2: "proposed\n" };
		convexQueryMock.mockImplementation(async (_name: unknown, args: { stateId: string }) =>
			statePageOf(texts[args.stateId]!),
		);
		rerenderWith({ yjsLastSequenceId: "sequence_new" });
		await flushNonCollabProposalMount();
		expect(monacoHarness.createdModels).toHaveLength(2);
		expect(getPanes().modified.getValue()).toBe("proposed\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
	});
});

describe("FileEditorDiff with collaboration off", () => {
	test("loads the proposal without the live file and hides Sync and versions", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		// The member accepted one hunk already: the original pane shows the staged branch, not the base.
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\nbeta\n" });
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		// Only the branch states were read: no Yjs snapshot, no saved-sequence query.
		expect(convexQueryMock.mock.calls.every(([name]) => name === "get_file_pending_update_state_page")).toBe(true);
		expect(
			useQueryMock.mock.calls.some(
				([reference, queryArgs]) =>
					getFunctionName(reference as never) === "files_pending_updates:get_file_pending_update_last_sequence_saved" &&
					queryArgs === "skip",
			),
		).toBe(true);
		const panes = getPanes();
		expect(panes.original.getValue()).toBe("alpha\nstaged\n");
		expect(panes.modified.getValue()).toBe("alpha\nstaged\nbeta\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
		const saveButton = screen.getByRole("button", { name: "Save staged changes" });
		expect((saveButton as HTMLButtonElement).disabled).toBe(false);
		expect(screen.queryByRole("button", { name: "Sync with live file" })).toBeNull();
		expect(screen.queryByTestId("file-editor-snapshots-modal")).toBeNull();
		// The status line is mounted before it gets text, so a later stale flip is announced.
		const staleLine = document.querySelector(".FileEditorDiff-stale");
		expect(staleLine?.getAttribute("role")).toBe("status");
		expect(staleLine?.textContent).toBe("");
	});

	test("Save stays busy until the doc query shows the save", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		// One hunk is staged already, so Save has something to send.
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\n" });
		// The save deletes the doc. The cache shows the deletion only with the next query value.
		const deliverNextValue = mockSaveDocQuery({ pendingUpdateUpdatedAt: null, nextDoc: null });
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		fireEvent.click(screen.getByRole("button", { name: "Save staged changes" }));
		await act(async () => {});

		expect(convexActionMock.mock.calls[0]?.[0]).toBe("upsert_file_pending_update");
		const [reference, actionArgs] = convexActionMock.mock.calls[1] ?? [];
		expect(getFunctionName(reference as never)).toBe("files_pending_updates:save_file_pending_update");
		expect(actionArgs).toEqual({
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			pendingUpdateId: PENDING_UPDATE_ID,
			reviewedUpdatedAt: 2,
		});
		expect(toast.success).toHaveBeenCalledWith("Changes saved");
		// The action result is in, but the cache still shows the old doc: the view stays busy and
		// waits for the next value instead of reloading the branches the save deleted.
		expect(waitNewQueryValueMock).toHaveBeenCalledTimes(1);
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);

		await act(async () => {
			deliverNextValue();
		});
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	test("a stale proposal stays read-only and offers copies and Discard while preparing", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		convexMutationMock.mockResolvedValue({ _yay: null });
		const { toolbarPortalHost } = renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();

		const status = screen.getByRole("status");
		expect(status.textContent).toContain("Updating this proposal");
		const discardButton = screen.getByRole("button", { name: "Discard proposal" });
		expect(discardButton.getAttribute("aria-describedby")).toBe(status.id);
		expect(toolbarPortalHost.querySelectorAll("button")).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Copy accepted text" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy proposed text" })).toBeTruthy();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });

		fireEvent.click(discardButton);
		await act(async () => {});

		const [reference, mutationArgs] = convexMutationMock.mock.calls[0] ?? [];
		expect(getFunctionName(reference as never)).toBe("files_pending_updates:discard_file_pending_content");
		expect(mutationArgs).toEqual({ membershipId: MEMBERSHIP_ID, nodeId: NODE_ID, pendingUpdateId: PENDING_UPDATE_ID });
		expect(toast.success).toHaveBeenCalledWith("Proposal discarded");
	});

	test("a stale Discard on a doc that also moves the file says the move stays", async () => {
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			pendingMove: { destParentId: "root", destName: "moved.txt", fromPath: "/old.txt" },
		} as unknown as app_convex_Doc<"files_pending_updates">);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		convexMutationMock.mockResolvedValue({ _yay: null });
		renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();

		fireEvent.click(screen.getByRole("button", { name: "Discard proposal" }));
		await act(async () => {});

		expect(toast.success).toHaveBeenCalledWith("Text change discarded. The move is still pending.");
	});

	test("a stale Discard on a doc that also deletes the file says the delete stays", async () => {
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			pendingArchive: { fromPath: "/old.txt" },
		} as unknown as app_convex_Doc<"files_pending_updates">);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		convexMutationMock.mockResolvedValue({ _yay: null });
		renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();

		fireEvent.click(screen.getByRole("button", { name: "Discard proposal" }));
		await act(async () => {});

		expect(toast.success).toHaveBeenCalledWith("Text change discarded. The delete is still pending.");
	});

	test("a refused stale Discard shows the refusal and frees the button", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		convexMutationMock.mockResolvedValue({ _nay: { message: "Not found" } });
		renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();

		const discardButton = screen.getByRole("button", { name: "Discard proposal" });
		fireEvent.click(discardButton);
		await act(async () => {});

		expect(toast.error).toHaveBeenCalledWith("Not found");
		expect(toast.success).not.toHaveBeenCalled();
		expect(discardButton.getAttribute("aria-busy")).toBe("false");
	});

	test("typing the proposal back onto the saved text ends it with a toast", async () => {
		vi.useFakeTimers();
		try {
			useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
			resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
			convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
			convexActionMock.mockResolvedValue({ _yay: { pendingUpdate: null, currentYjsLastSequenceId: null } });
			renderNonCollabProposalReview({ committedAssetId: "asset_1" });
			await flushNonCollabProposalMount();

			await typeIntoModifiedPane("alpha gamma\n");
			await flushNonCollabProposalMount();
			expect(convexActionMock.mock.calls.some(([reference]) => reference === "upsert_file_pending_update")).toBe(true);
			expect(toast.success).not.toHaveBeenCalled();

			await typeIntoModifiedPane("alpha\n");
			await flushNonCollabProposalMount();

			// The server deletes a doc whose branches all equal the saved text, and the view exits.
			expect(convexActionMock.mock.calls.some(([reference]) => reference === "upsert_file_pending_update")).toBe(true);
			expect(toast.success).toHaveBeenCalledWith("Proposal discarded");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a doc that is already gone shows the skeleton, not the refusal", async () => {
		useStableQueryMock.mockReturnValue(null);
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		// `FileEditorInner` leaves the view once the doc is gone; the refusal must not flash first.
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("Loading changes…");
		expect(monacoHarness.createdModels).toHaveLength(0);
	});

	test("a stale proposal renders no hunk widgets, a fresh one does", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		monacoHarness.lineChanges.push({
			originalStartLineNumber: 1,
			originalEndLineNumber: 1,
			modifiedStartLineNumber: 1,
			modifiedEndLineNumber: 1,
		});
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		await act(async () => {
			monacoHarness.diffListeners.forEach((listener) => listener());
		});
		// Positive control: the fresh proposal shows the widget for the one change.
		expect(screen.getByRole("button", { name: "Accept change" })).toBeTruthy();

		// A member saved the file: the widget's Accept would edit a proposal the server refuses.
		rerenderWith({ committedAssetId: "asset_2" });
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Accept change" })).toBeNull();
		expect(screen.getByRole("button", { name: "Discard proposal" })).toBeTruthy();
	});

	test("an inactive editor hides its floating hunk controls and restores them on return", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		monacoHarness.lineChanges.push({
			originalStartLineNumber: 1,
			originalEndLineNumber: 1,
			modifiedStartLineNumber: 1,
			modifiedEndLineNumber: 1,
		});
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		await act(async () => {
			monacoHarness.diffListeners.forEach((listener) => listener());
		});
		expect(screen.getByRole("button", { name: "Accept change" })).toBeTruthy();

		rerenderWith({ isActive: false });
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Accept change" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Discard change" })).toBeNull();

		rerenderWith({ isActive: true });
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Accept change" })).toBeTruthy();
	});

	test("a toolbar swap keeps keyboard focus in the toolbar, and leaves focus alone elsewhere", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		const acceptAllName = "Accept all pending changes in this file";
		act(() => screen.getByRole("button", { name: acceptAllName }).focus());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: acceptAllName }));

		// A member saved the file: the fresh toolbar is removed under the focused button.
		rerenderWith({ committedAssetId: "asset_2" });
		await act(async () => {});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy accepted text" }));

		// The current version matches again: the fresh toolbar is back, and so is the focus.
		rerenderWith({ committedAssetId: "asset_1" });
		await act(async () => {});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: acceptAllName }));

		// Positive control: focus that left the toolbar before the swap is not pulled back in.
		act(() => (document.activeElement as HTMLElement).blur());
		await act(async () => {});
		rerenderWith({ committedAssetId: "asset_2" });
		await act(async () => {});
		expect(document.activeElement).toBe(document.body);
	});

	test("Save after a partial accept stays busy until the doc query shows the rewritten doc", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\nbeta\n" });
		// The unstaged hunk survives the save, so the doc stays and only its `updatedAt` moves.
		const deliverNextValue = mockSaveDocQuery({
			pendingUpdateUpdatedAt: 5,
			nextDoc: { ...nonCollabPendingUpdate, updatedAt: 5 },
		});
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		fireEvent.click(screen.getByRole("button", { name: "Save staged changes" }));
		await act(async () => {});
		const [watchReference, watchArgs] = convexWatchQueryMock.mock.calls[0] ?? [];
		expect(getFunctionName(watchReference as never)).toBe("files_pending_updates:get_file_pending_update");
		expect(watchArgs).toEqual({ membershipId: MEMBERSHIP_ID, nodeId: NODE_ID, pendingUpdateId: PENDING_UPDATE_ID });
		// The cache still holds the doc from before the save (`updatedAt` 1): keep waiting.
		expect(waitNewQueryValueMock).toHaveBeenCalledTimes(1);
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);

		await act(async () => {
			deliverNextValue();
		});
		expect(waitNewQueryValueMock).toHaveBeenCalledTimes(1);
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	test("Save stops waiting when the doc query shows a newer proposal with another id", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\n" });
		// The agent wrote again right after the save: the cache skips from the old doc to a new one.
		const deliverNextValue = mockSaveDocQuery({
			pendingUpdateUpdatedAt: 5,
			nextDoc: { ...nonCollabPendingUpdate, _id: "pu_other" as typeof nonCollabPendingUpdate._id },
		});
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		fireEvent.click(screen.getByRole("button", { name: "Save staged changes" }));
		await act(async () => {});
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(true);

		await act(async () => {
			deliverNextValue();
		});
		expect(waitNewQueryValueMock).toHaveBeenCalledTimes(1);
		expect((screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	test("the fresh toolbar stays busy while the rewritten branches load, then takes the focus", async () => {
		const ref = createRef<Pick<FileEditor_Ref, "getPreviewSnapshot">>();
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		monacoHarness.lineChanges.push({
			originalStartLineNumber: 1,
			originalEndLineNumber: 1,
			modifiedStartLineNumber: 1,
			modifiedEndLineNumber: 1,
		});
		// A member saved the file: the proposal opens stale, with focus on its only button.
		const { rerenderWith } = renderNonCollabProposalReview({ ref, committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();
		act(() => screen.getByRole("button", { name: "Discard proposal" }).focus());

		// The agent wrote again: the doc moves to the saved base with new branch states, whose
		// pages arrive later.
		const pageResolvers: Array<() => void> = [];
		const rewrittenPages: Record<string, ReturnType<typeof statePageOf>> = {
			state_base_2: statePageOf("alpha\nmember\n"),
			state_staged_2: statePageOf("alpha\nmember\n"),
			state_unstaged_2: statePageOf("alpha\nmember\nbeta\n"),
		};
		convexQueryMock.mockImplementation((name: unknown, args: unknown) => {
			if (name !== "get_file_pending_update_state_page") return Promise.resolve(undefined);
			const { stateId } = args as { stateId: string };
			return new Promise((resolve) => pageResolvers.push(() => resolve(rewrittenPages[stateId] ?? null)));
		});
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			updatedAt: 2,
			baseAssetId: "asset_2",
			baseStateId: "state_base_2",
			stagedStateId: "state_staged_2",
			unstagedStateId: "state_unstaged_2",
		} as unknown as app_convex_Doc<"files_pending_updates">);
		rerenderWith({});
		await act(async () => {});

		// The panes still hold the old branches: every fresh button is disabled until the reload
		// lands, so nothing can send the old text into the fresh doc.
		const acceptAllName = "Accept all pending changes in this file";
		expect(screen.queryByRole("button", { name: "Discard proposal" })).toBeNull();
		expect((screen.getByRole("button", { name: acceptAllName }) as HTMLButtonElement).disabled).toBe(true);
		expect(pageResolvers).toHaveLength(3);
		expect(ref.current?.getPreviewSnapshot()).toBeNull();
		// The swap is silent otherwise: the status line says what is going on.
		expect(document.querySelector(".FileEditorDiff-stale")?.textContent).toBe("Loading the updated proposal…");
		// The body is locked the same way: no hunk widget, and the modified pane is read-only.
		await act(async () => {
			monacoHarness.diffListeners.forEach((listener) => listener());
		});
		expect(screen.queryByRole("button", { name: "Accept change" })).toBeNull();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });

		await act(async () => {
			pageResolvers.forEach((resolve) => resolve());
		});
		await flushNonCollabProposalMount();
		expect((screen.getByRole("button", { name: acceptAllName }) as HTMLButtonElement).disabled).toBe(false);
		expect(document.querySelector(".FileEditorDiff-stale")?.textContent).toBe("");
		expect(getPanes().modified.getValue()).toBe("alpha\nmember\nbeta\n");
		expect(ref.current?.getPreviewSnapshot()).toMatchObject({
			text: "alpha\nmember\nbeta\n",
			isDirty: false,
			pendingUpdate: { updatedAt: 2, baseAssetId: "asset_2", unstagedStateId: "state_unstaged_2" },
		});
		await act(async () => {
			monacoHarness.diffListeners.forEach((listener) => listener());
		});
		expect(screen.getByRole("button", { name: "Accept change" })).toBeTruthy();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
		// Focus was in the toolbar at the swap: it lands on the first button once the toolbar is idle.
		// The rescue waits for the settled render (a zero timer).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: acceptAllName }));
	});

	test("a missing prepared page keeps the old copies and Retry reloads without another preparation", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		const onExit = vi.fn();
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_2", onExit });
		await flushNonCollabProposalMount();

		// Preparation committed, but a page of its new branches cannot be read yet.
		convexQueryMock.mockImplementation((name: unknown) =>
			Promise.resolve(name === "get_file_pending_update_state_page" ? null : undefined),
		);
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			updatedAt: 2,
			baseAssetId: "asset_2",
			baseStateId: "state_base_2",
			stagedStateId: "state_staged_2",
			unstagedStateId: "state_unstaged_2",
		} as unknown as app_convex_Doc<"files_pending_updates">);
		rerenderWith({});
		await flushNonCollabProposalMount();

		expect(onExit).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Failed to read the proposal. Retry to load its text.");
		expect(getPanes().modified.getValue()).toBe("alpha beta\n");
		expect(screen.getByRole("button", { name: "Copy proposed text" })).toBeTruthy();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		const preparationCount = convexActionMock.mock.calls.length;
		const texts: Record<string, string> = {
			state_base_2: "alpha\nmember\n",
			state_staged_2: "alpha\nmember\n",
			state_unstaged_2: "alpha beta\nmember\n",
		};
		convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) =>
			statePageOf(texts[args.stateId]!),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await flushNonCollabProposalMount();
		expect(convexActionMock).toHaveBeenCalledTimes(preparationCount);
		expect(getPanes().modified.getValue()).toBe("alpha beta\nmember\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
		expect(convexMutationMock).not.toHaveBeenCalled();
	});

	test("a thrown prepared-page read keeps the old copies and Retry reloads without another preparation", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		const onExit = vi.fn();
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_2", onExit });
		await flushNonCollabProposalMount();

		convexQueryMock.mockRejectedValue(new Error("Unauthenticated"));
		useStableQueryMock.mockReturnValue({
			...nonCollabPendingUpdate,
			updatedAt: 2,
			baseAssetId: "asset_2",
			baseStateId: "state_base_2",
			stagedStateId: "state_staged_2",
			unstagedStateId: "state_unstaged_2",
		} as unknown as app_convex_Doc<"files_pending_updates">);
		rerenderWith({});
		await flushNonCollabProposalMount();

		expect(onExit).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Failed to read the proposal. Retry to load its text.");
		expect(getPanes().original.getValue()).toBe("alpha\n");
		expect(getPanes().modified.getValue()).toBe("alpha beta\n");
		expect(screen.getByRole("button", { name: "Copy accepted text" })).toBeTruthy();
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: true });
		const preparationCount = convexActionMock.mock.calls.length;
		const texts: Record<string, string> = {
			state_base_2: "alpha\nmember\n",
			state_staged_2: "alpha\nmember\n",
			state_unstaged_2: "alpha beta\nmember\n",
		};
		convexQueryMock.mockImplementation(async (_reference: unknown, args: { stateId: string }) =>
			statePageOf(texts[args.stateId]!),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await flushNonCollabProposalMount();
		expect(convexActionMock).toHaveBeenCalledTimes(preparationCount);
		expect(getPanes().modified.getValue()).toBe("alpha beta\nmember\n");
		expect(monacoHarness.updateOptionsCalls.at(-1)).toMatchObject({ readOnly: false });
		expect(convexMutationMock).not.toHaveBeenCalled();
	});

	test("focus comes back to the toolbar after a partial Save", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\nbeta\n" });
		const deliverSavedDoc = mockSaveDocQuery({
			pendingUpdateUpdatedAt: 5,
			nextDoc: { ...nonCollabPendingUpdate, updatedAt: 5 },
		});
		const { toolbarPortalHost } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		const saveButton = screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement;
		act(() => saveButton.focus());
		fireEvent.click(saveButton);
		await act(async () => {});
		expect(saveButton.disabled).toBe(true);
		// The browser drops the focus of a disabled button to body. jsdom keeps it, and its blur() is
		// a no-op on a disabled button, so move focus to a throwaway element and remove that.
		const throwaway = document.createElement("button");
		document.body.append(throwaway);
		act(() => throwaway.focus());
		throwaway.remove();
		expect(document.activeElement).toBe(document.body);

		await act(async () => {
			deliverSavedDoc();
		});
		expect(saveButton.disabled).toBe(false);
		// The rescue waits for the settled render (a zero timer).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.activeElement).not.toBe(document.body);
		expect(toolbarPortalHost.contains(document.activeElement)).toBe(true);
	});

	test("focus comes back to the toolbar after a refused Accept all and save", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\nbeta\n" });
		convexMutationMock.mockResolvedValue({ _yay: { operationBatchId: "batch_1" } });
		convexActionMock.mockImplementation((reference: unknown) =>
			Promise.resolve(
				reference === "upsert_file_pending_update"
					? { _yay: { pendingUpdate: nonCollabPendingUpdate, currentYjsLastSequenceId: null } }
					: { _nay: { message: "Insufficient funds" } },
			),
		);
		const { toolbarPortalHost } = renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();

		const acceptAllAndSaveButton = screen.getByRole("button", { name: "Accept all pending changes and save" });
		act(() => acceptAllAndSaveButton.focus());
		fireEvent.click(acceptAllAndSaveButton);
		// The browser drops the focus of the disabled button to body; see the partial Save test.
		const throwaway = document.createElement("button");
		document.body.append(throwaway);
		act(() => throwaway.focus());
		throwaway.remove();
		expect(document.activeElement).toBe(document.body);
		await act(async () => {});

		expect(toast.error).toHaveBeenCalledWith("Insufficient funds");
		// The rescue waits for the settled render (a zero timer).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.activeElement).not.toBe(document.body);
		expect(toolbarPortalHost.contains(document.activeElement)).toBe(true);
	});

	test("focus stays where the member put it during a partial Save", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\nstaged\n", unstaged: "alpha\nstaged\nbeta\n" });
		const deliverSavedDoc = mockSaveDocQuery({
			pendingUpdateUpdatedAt: 5,
			nextDoc: { ...nonCollabPendingUpdate, updatedAt: 5 },
		});
		renderNonCollabProposalReview({ committedAssetId: "asset_1" });
		await flushNonCollabProposalMount();
		const elsewhere = document.createElement("input");
		document.body.append(elsewhere);

		const saveButton = screen.getByRole("button", { name: "Save staged changes" }) as HTMLButtonElement;
		act(() => saveButton.focus());
		fireEvent.click(saveButton);
		await act(async () => {});
		act(() => elsewhere.focus());

		await act(async () => {
			deliverSavedDoc();
		});
		expect(saveButton.disabled).toBe(false);
		// The rescue waits for the settled render (a zero timer).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.activeElement).toBe(elsewhere);
		elsewhere.remove();
	});
});
