import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { FileEditor, type FileEditor_Props } from "./file-editor.tsx";
import { files_PresenceStore } from "@/lib/files.ts";
import { files_yjs_preload_snapshot } from "@/lib/files-yjs-snapshot-preload.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { permission, client, watchers, registerProvider } = vi.hoisted(() => ({
	permission: { value: undefined as boolean | undefined, listeners: new Set<() => void>() },
	client: { action: vi.fn(), query: vi.fn(), mutation: vi.fn() },
	watchers: new Set<() => void>(),
	registerProvider: vi.fn((_provider: import("@/lib/files-yjs-provider.ts").files_yjs_Provider) => () => {}),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		...client,
		watchQuery: () => ({
			localQueryResult: () => ({ yjsLastSequenceId: "document", updates: [] }),
			onUpdate: (callback: () => void) => {
				watchers.add(callback);
				return () => watchers.delete(callback);
			},
		}),
	},
	app_convex_api: {
		files_nodes: {
			get_current_user_file_write_permission: "get_current_user_file_write_permission",
			get_file_last_yjs_sequence: "get_file_last_yjs_sequence",
			yjs_prepare_doc_last_snapshot: "yjs_prepare_doc_last_snapshot",
			yjs_get_incremental_updates: "yjs_get_incremental_updates",
			yjs_push_update: "yjs_push_update",
		},
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership" }) },
}));
vi.mock("@/lib/app-qa.ts", () => ({ app_qa_register_files_yjs_provider: registerProvider }));
vi.mock("convex/react", async (importOriginal) => {
	const { useSyncExternalStore } = await import("react");
	return {
		...(await importOriginal<typeof import("convex/react")>()),
		useQuery: () =>
			useSyncExternalStore(
				(listener) => {
					permission.listeners.add(listener);
					return () => permission.listeners.delete(listener);
				},
				() => permission.value,
			),
	};
});

// Keep the real hook and provider. Tiptap's view is not part of this loading boundary.
vi.mock("./file-editor-rich-text/file-editor-rich-text.tsx", async () => {
	const { useFilesYjs } = await import("@/hooks/files-hooks.ts");
	return {
		FileEditorRichText: function FileEditorRichText(
			props: Omit<import("@/hooks/files-hooks.ts").useFilesYjs_Props, "membershipId">,
		) {
			const filesYjs = useFilesYjs({
				...props,
				membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			});
			return <div>{`${filesYjs?.syncStatus ?? "loading"} ${props.editable ? "editable" : "read-only"}`}</div>;
		},
		FileEditorRichTextNonCollab: () => <div>Stored rich text</div>,
	};
});
vi.mock("./file-editor-plain-text/file-editor-plain-text.tsx", () => ({
	FileEditorPlainText: () => <div>Code editor</div>,
}));
vi.mock("./file-editor-diff/file-editor-diff.tsx", () => ({
	FileEditorDiff: () => <div>Review editor</div>,
	FileEditorDiffNonCollab: () => <div>Stored review</div>,
}));

const args = {
	membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
	nodeId: "file" as app_convex_Id<"files_nodes">,
};
let presenceStore: files_PresenceStore;
let editorProps: FileEditor_Props;
let fetchMock: ReturnType<typeof vi.fn>;

async function flushProvider() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
		for (const callback of watchers) callback();
	});
	await act(async () => {});
}

beforeEach(() => {
	vi.useFakeTimers();
	permission.value = undefined;
	permission.listeners.clear();
	client.action.mockReset().mockResolvedValue({
		snapshot: { sequence: 0 },
		snapshotUrl: "https://r2.test/snapshot",
		yjsLastSequenceId: "document",
	});
	client.query.mockReset().mockResolvedValue({ yjsLastSequenceId: "document", lastSequence: 0 });
	client.mutation.mockReset().mockResolvedValue({ _yay: { newSequence: 1 } });
	registerProvider.mockClear();
	watchers.clear();
	const snapshot = new Y.Doc();
	snapshot.getText("content").insert(0, "Welcome");
	const bytes = new Uint8Array(Y.encodeStateAsUpdate(snapshot)).buffer;
	fetchMock = vi.fn(async () => new Response(bytes));
	vi.stubGlobal("fetch", fetchMock);
	snapshot.destroy();
	presenceStore = new files_PresenceStore({
		data: {
			sessionToken: "token",
			sessions: [{ sessionId: "session", userId: "user" }],
			sessionsData: { session: { color: "#000000" } },
			usersAnagraphics: {
				user: { displayName: "User" } as ConstructorParameters<
					typeof files_PresenceStore
				>[0]["data"]["usersAnagraphics"][string],
			},
		},
		localSessionId: "session",
		onSetSessionData: vi.fn(),
	});
	editorProps = {
		target: { kind: "saved", id: args.nodeId },
		writeBlockedReason: null,
		rootKind: "rich_text",
		monacoLanguageId: "markdown",
		nonCollaborative: false,
		committedAssetId: null,
		pendingUpdatesLoaded: true,
		yjsLastSequenceId: "document" as app_convex_Id<"files_yjs_docs_last_sequences">,
		editorMode: "rich_text_editor",
		presenceStore,
		commentsPortalHost: null,
		toolbarPortalHost: document.createElement("div"),
		onEditorModeChange: vi.fn(),
	};
});

afterEach(() => {
	cleanup();
	presenceStore.dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([true, false])("waits for initial write access before taking the preload: %s", async (canWrite) => {
	files_yjs_preload_snapshot(args);
	render(<FileEditor {...editorProps} />);
	await flushProvider();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(registerProvider).not.toHaveBeenCalled();
	act(() => {
		permission.value = canWrite;
		for (const listener of permission.listeners) listener();
	});
	await flushProvider();
	expect(screen.getByText(`synchronized ${canWrite ? "editable" : "read-only"}`)).toBeTruthy();
	expect(registerProvider).toHaveBeenCalledOnce();
	expect(registerProvider.mock.calls[0]?.[0].getYDoc().getText("content").toString()).toBe("Welcome");
	expect(client.action).toHaveBeenCalledOnce();
	expect(fetchMock).toHaveBeenCalledOnce();
});

test.each(["absent", "other node", "other membership"] as const)(
	"opens normally with unknown write access when the preload is %s",
	async (preload) => {
		const cancel =
			preload === "absent"
				? null
				: files_yjs_preload_snapshot({
						membershipId: preload === "other membership" ? ("other" as typeof args.membershipId) : args.membershipId,
						nodeId: preload === "other node" ? ("other" as typeof args.nodeId) : args.nodeId,
					});
		render(<FileEditor {...editorProps} />);
		await flushProvider();
		expect(registerProvider).toHaveBeenCalledOnce();
		expect(screen.getByText("synchronized read-only")).toBeTruthy();
		expect(client.action).toHaveBeenCalledTimes(preload === "absent" ? 1 : 2);
		cancel?.();
	},
);

test("still replaces the provider and drops queued edits after real write access is lost", async () => {
	permission.value = true;
	files_yjs_preload_snapshot(args);
	render(<FileEditor {...editorProps} />);
	await flushProvider();
	const first = registerProvider.mock.calls[0]?.[0];
	if (!first) throw new Error("Missing initial provider");
	const destroy = vi.spyOn(first, "destroy");
	act(() => first.getYDoc().getText("content").insert(7, " unsaved"));
	act(() => {
		permission.value = false;
		for (const listener of permission.listeners) listener();
	});
	await flushProvider();
	expect(screen.getByText("synchronized read-only")).toBeTruthy();
	expect(destroy).toHaveBeenCalledOnce();
	expect(registerProvider).toHaveBeenCalledTimes(2);
	expect(client.action).toHaveBeenCalledTimes(2);
	expect(client.mutation).not.toHaveBeenCalled();
});

test.each(["private", "noncollaborative", "plain_text_editor", "diff_editor"] as const)(
	"does not add an access wait to %s",
	async (mode) => {
		const props = { ...editorProps };
		if (mode === "private") {
			props.target = { kind: "private", id: "draft" as app_convex_Id<"files_pending_nodes"> };
			props.privateCanEdit = true;
		} else if (mode === "noncollaborative") {
			props.nonCollaborative = true;
		} else {
			props.editorMode = mode;
		}
		render(<FileEditor {...props} />);
		expect(
			screen.getByText(
				mode === "private" || mode === "noncollaborative"
					? "Stored rich text"
					: mode === "plain_text_editor"
						? "Code editor"
						: "Review editor",
			),
		).toBeTruthy();
		expect(registerProvider).not.toHaveBeenCalled();
	},
);
