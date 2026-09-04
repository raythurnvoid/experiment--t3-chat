import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { tenantContextMock, convexQueryMock, convexActionMock, stableQueryMock, editorHarness } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	convexQueryMock: vi.fn(),
	convexActionMock: vi.fn(),
	stableQueryMock: vi.fn(),
	// The drag handle is the one mounted child that already receives the Tiptap instance, so the
	// stub below hands it to the tests. That is how a test types into the real document.
	editorHarness: { editor: null as null | import("@tiptap/core").Editor },
}));

// Spy target: tests assert on the toasts the editor shows.
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
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
		chat_messages: {
			chat_messages_threads_list: "chat_messages_threads_list",
		},
	},
}));

// The anchored comments layer asks for its threads through this hook. No thread data is under
// test, but the arguments show which document the layer is currently reading.
vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: (...args: unknown[]) => {
		stableQueryMock(...args);
		return undefined;
	},
}));

// The snapshots modal owns its own query stack. The stub only exposes the restore callback, so a
// test can trigger a restore the way a confirmed snapshot does.
vi.mock("../file-editor-snapshots-modal.tsx", () => ({
	FileEditorSnapshotsModal: function FileEditorSnapshotsModal(props: { onApplySnapshotText: () => void }) {
		return (
			<button type="button" onClick={props.onApplySnapshotText}>
				Apply snapshot
			</button>
		);
	},
}));

vi.mock("../file-editor-comments-sidebar.tsx", () => ({
	FileEditorCommentsSidebar: function FileEditorCommentsSidebar() {
		return null;
	},
}));

// The real drag handle measures DOM boxes the test environment does not lay out. The stub keeps
// the editor instance it is given so tests can edit the document the way a member would.
vi.mock("./file-editor-rich-text-drag-handle.tsx", () => ({
	FileEditorRichTextDragHandle: function FileEditorRichTextDragHandle(props: { editor: never }) {
		editorHarness.editor = props.editor;
		return null;
	},
}));

import { FileEditorRichTextNonCollab } from "./file-editor-rich-text.tsx";
import { files_REPLACE_FILE_CONTENT_STALE_MESSAGE, type files_PresenceStore } from "@/lib/files.ts";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_markdown" as app_convex_Id<"files_nodes">;
const BASE_ASSET_ID = "asset_committed" as app_convex_Id<"files_r2_assets">;

const presenceStore = { localSessionId: "session_1" } as unknown as files_PresenceStore;

/**
 * Answer the committed-content query the way the server does for a file with collaboration off.
 */
function resolveQueryWithNonCollaborativeContent(text: string, assetId = BASE_ASSET_ID) {
	convexQueryMock.mockResolvedValue({ _yay: { text, assetId } });
}

function renderNonCollabRichEditor(args?: { editable?: boolean }) {
	const toolbarPortalHost = document.createElement("div");
	document.body.append(toolbarPortalHost);
	const rendered = render(
		<FileEditorRichTextNonCollab
			nodeId={NODE_ID}
			editable={args?.editable ?? true}
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
		/>,
	);
	return { ...rendered, toolbarPortalHost };
}

/**
 * One paragraph carrying a comment mark, written the way the serializer writes it.
 */
function comment_markdown(threadId: string, word: string) {
	return `<span data-type="comment" data-lb-thread-id="${threadId}">${word}</span>\n`;
}

/**
 * The thread ids the anchored comments layer asked for on its last render. The layer passes
 * "skip" instead of arguments while the document carries no comment mark.
 */
function last_requested_thread_ids() {
	const lastArgs = stableQueryMock.mock.calls.at(-1)?.[1];
	if (lastArgs === "skip" || lastArgs == null) {
		return null;
	}

	return (lastArgs as { threadIds: string[] }).threadIds;
}

/**
 * Flush the content query, the editor mount, and the effects the mount schedules.
 */
async function flushEditorMount() {
	await act(async () => {});
	// Novel creates the editor from a timer, so a test on fake timers has to let it run.
	if (vi.isFakeTimers()) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
	}
	await act(async () => {});
}

/**
 * Type at the end of the document, then let the 400 ms dirty debounce land.
 */
async function typeIntoEditor(content: string) {
	const editor = editorHarness.editor;
	if (!editor) {
		throw new Error("Expected the mounted editor to be captured");
	}

	act(() => {
		// Append at the end of the last text block; the mounted selection sits at the start.
		editor.commands.insertContentAt(editor.state.doc.content.size - 1, content);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(400);
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
	stableQueryMock.mockReset();
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.info).mockClear();
	vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
	cleanup();
});

describe("FileEditorRichTextNonCollab", () => {
	test("mounts the loaded text and reports its word count", async () => {
		resolveQueryWithNonCollaborativeContent("alpha beta gamma\n");
		renderNonCollabRichEditor();
		await flushEditorMount();

		expect(convexQueryMock).toHaveBeenCalledWith("get_non_collaborative_file_content", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
		});
		expect(await screen.findByRole("group", { name: "Rich text editor actions" })).toBeTruthy();
		expect(screen.getByText("3 Words")).toBeTruthy();
	});

	test("a snapshot restore refreshes the comment anchors without waiting for the next edit", async () => {
		resolveQueryWithNonCollaborativeContent(comment_markdown("thread_a", "alpha"));
		renderNonCollabRichEditor();
		await flushEditorMount();
		expect(last_requested_thread_ids()).toEqual(["thread_a"]);

		// The restore already landed on the server, so the editor re-reads the committed text.
		resolveQueryWithNonCollaborativeContent(
			comment_markdown("thread_b", "beta"),
			"asset_restored" as app_convex_Id<"files_r2_assets">,
		);
		fireEvent.click(screen.getByRole("button", { name: "Apply snapshot" }));
		await flushEditorMount();

		// The comments layer is memoized and its props did not change, so only an editor
		// transaction can move it to the restored document. Without one it keeps asking for the
		// threads of the text that was replaced, and every mark renders at the old position.
		expect(screen.getByText("1 Words")).toBeTruthy();
		expect(last_requested_thread_ids()).toEqual(["thread_b"]);
	});

	test("Save replaces the whole text and the next Save names the asset it wrote", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _yay: { assetId: "asset_saved" } });

			renderNonCollabRichEditor();
			await flushEditorMount();

			const saveButton = screen.getByRole("button", { name: "Save" });
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			await typeIntoEditor(" beta");
			expect(saveButton.hasAttribute("disabled")).toBe(false);

			fireEvent.click(saveButton);
			await act(async () => {});

			expect(convexActionMock).toHaveBeenCalledWith("replace_file_content", {
				membershipId: MEMBERSHIP_ID,
				nodeId: NODE_ID,
				text: "alpha beta\n",
				baseAssetId: BASE_ASSET_ID,
			});
			expect(toast.error).not.toHaveBeenCalled();
			expect(saveButton.hasAttribute("disabled")).toBe(true);

			// The next Save must name the asset this one wrote, or the server would call it stale.
			await typeIntoEditor(" gamma");
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

	test("a refused Save shows the refusal and keeps the text in the editor", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			convexActionMock.mockResolvedValue({ _nay: { message: files_REPLACE_FILE_CONTENT_STALE_MESSAGE } });

			renderNonCollabRichEditor();
			await flushEditorMount();

			const saveButton = screen.getByRole("button", { name: "Save" });
			await typeIntoEditor(" beta");
			fireEvent.click(saveButton);
			await act(async () => {});

			// The refusal must be visible, and Save must stay armed: the text is still only local.
			expect(toast.error).toHaveBeenCalledWith(files_REPLACE_FILE_CONTENT_STALE_MESSAGE);
			expect(saveButton.hasAttribute("disabled")).toBe(false);
			expect(screen.getByText("2 Words")).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	test("warns about the reformat only while the serializer would rewrite the stored bytes", async () => {
		// Two spaces after the heading marker: the serializer writes one, so the first save rewrites
		// a line the member never touched.
		resolveQueryWithNonCollaborativeContent("#  Title\n");
		renderNonCollabRichEditor();
		await flushEditorMount();

		expect(screen.getByText("Saving from the rich editor will reformat this file's Markdown.")).toBeTruthy();
	});

	test("no reformat warning when the stored bytes already match the serializer", async () => {
		resolveQueryWithNonCollaborativeContent("alpha\n");
		renderNonCollabRichEditor();
		await flushEditorMount();

		expect(screen.queryByText("Saving from the rich editor will reformat this file's Markdown.")).toBeNull();
	});

	test("warns with the lost text when the editor closes on unsaved changes", async () => {
		vi.useFakeTimers();
		try {
			resolveQueryWithNonCollaborativeContent("alpha\n");
			const { unmount } = renderNonCollabRichEditor();
			await flushEditorMount();

			await typeIntoEditor(" beta");
			unmount();

			expect(toast.warning).toHaveBeenCalledWith("Your unsaved changes to this file were discarded.", {
				duration: 30_000,
				action: { label: "Copy text", onClick: expect.any(Function) },
			});

			// The action has to hand back exactly what was in the editor, or the offer is useless.
			const clipboardWrite = vi.fn();
			vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
			vi.mocked(toast.warning).mock.calls[0]?.[1]?.action?.onClick?.(new MouseEvent("click"));
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

			const { unmount } = renderNonCollabRichEditor();
			await flushEditorMount();

			await typeIntoEditor(" beta");
			fireEvent.click(screen.getByRole("button", { name: "Save" }));
			await act(async () => {});
			unmount();

			expect(toast.warning).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
