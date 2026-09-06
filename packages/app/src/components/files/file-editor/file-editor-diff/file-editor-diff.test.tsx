import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

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
	FileEditorSnapshotsModal: function FileEditorSnapshotsModal() {
		return <div data-testid="file-editor-snapshots-modal" />;
	},
}));
vi.mock("../file-editor-comments-sidebar.tsx", () => ({
	FileEditorCommentsSidebar: function FileEditorCommentsSidebar() {
		return null;
	},
}));

import { FileEditorDiff, FileEditorDiffNonCollab } from "./file-editor-diff.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Doc } from "@/lib/app-convex-client.ts";
import { getFunctionName } from "convex/server";
import { encodeStateAsUpdate } from "yjs";
import { files_PENDING_UPDATE_STALE_BASE_MESSAGE } from "../../../../../shared/files.ts";
import { files_yjs_doc_create_plain_text_from_text } from "../../../../../shared/files-yjs.ts";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_markdown" as app_convex_Id<"files_nodes">;
const PENDING_UPDATE_ID = "pu_1" as app_convex_Id<"files_pending_updates">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Answer the committed-content query the way the server does for a file with collaboration off.
 */
function resolveQueryWithNonCollaborativeContent(text: string) {
	convexQueryMock.mockResolvedValue({ _yay: { text, yjsRootKind: "rich_text" } });
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
	convexMutationMock.mockReset();
	useStableQueryMock.mockReset();
	useQueryMock.mockReset();
	convexWatchQueryMock.mockReset();
	waitNewQueryValueMock.mockReset();
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

function renderNonCollabProposalReview(args: { committedAssetId: string; onExit?: () => void }) {
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
			className={`render-${(renderCount += 1)}`}
			nodeId={NODE_ID}
			editable={true}
			rootKind="plain_text"
			monacoLanguageId="plaintext"
			pendingUpdateId={PENDING_UPDATE_ID}
			nonCollaborative={true}
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
				? { _yay: null }
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
		expect(actionArgs).toEqual({ membershipId: MEMBERSHIP_ID, nodeId: NODE_ID, pendingUpdateId: PENDING_UPDATE_ID });
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

	test("a stale proposal is read-only and offers only Discard proposal", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		convexMutationMock.mockResolvedValue({ _yay: null });
		const { toolbarPortalHost } = renderNonCollabProposalReview({ committedAssetId: "asset_2" });
		await flushNonCollabProposalMount();

		const status = screen.getByRole("status");
		expect(status.textContent).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		const discardButton = screen.getByRole("button", { name: "Discard proposal" });
		expect(discardButton.getAttribute("aria-describedby")).toBe(status.id);
		expect(toolbarPortalHost.querySelectorAll("button")).toHaveLength(1);
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
			convexActionMock.mockResolvedValue({ _yay: null });
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
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Discard proposal" }));

		// The agent wrote again: the fresh toolbar is back, and so is the focus.
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
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		monacoHarness.lineChanges.push({
			originalStartLineNumber: 1,
			originalEndLineNumber: 1,
			modifiedStartLineNumber: 1,
			modifiedEndLineNumber: 1,
		});
		// A member saved the file: the proposal opens stale, with focus on its only button.
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_2" });
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

	test("a failed reload of the rewritten branches leaves the review", async () => {
		useStableQueryMock.mockReturnValue(nonCollabPendingUpdate);
		resolveStatePages({ base: "alpha\n", staged: "alpha\n", unstaged: "alpha beta\n" });
		const onExit = vi.fn();
		const { rerenderWith } = renderNonCollabProposalReview({ committedAssetId: "asset_2", onExit });
		await flushNonCollabProposalMount();

		// The agent wrote again, but a page of the new branches is missing.
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

		// The panes hold branches of a base the file no longer has, so the review closes instead of
		// staying busy for good.
		expect(toast.error).toHaveBeenCalledWith("Failed to load the updated proposal. Open it again.");
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	test("a thrown reload of the rewritten branches leaves the review", async () => {
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

		expect(toast.error).toHaveBeenCalledWith("Failed to load the updated proposal. Open it again.");
		expect(onExit).toHaveBeenCalledTimes(1);
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
				reference === "upsert_file_pending_update" ? { _yay: null } : { _nay: { message: "Insufficient funds" } },
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
