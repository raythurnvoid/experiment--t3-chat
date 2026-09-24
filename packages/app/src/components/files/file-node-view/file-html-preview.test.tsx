import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, useState, type ComponentProps } from "react";
import { encodeStateAsUpdate } from "yjs";
import type { FileEditor_PreviewSnapshot } from "../file-editor/file-editor.tsx";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_VisibleEntry } from "@/lib/files.ts";
import { files_yjs_doc_create_from_text } from "../../../../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../../../../shared/files.ts";

const { queryMock, actionMock, savedReadMock, pendingReadMock, privateReadMock, tenantMock, queryValues } = vi.hoisted(
	() => ({
		queryMock: vi.fn(),
		actionMock: vi.fn(),
		savedReadMock: vi.fn(),
		pendingReadMock: vi.fn(),
		privateReadMock: vi.fn(),
		tenantMock: vi.fn(),
		queryValues: { pending: null as unknown, sequence: null as unknown },
	}),
);

vi.mock("@/lib/app-tenant-context.tsx", () => ({ AppTenantProvider: { useContext: () => tenantMock() } }));
vi.mock("convex/react", () => ({
	useQuery: (query: string, args: unknown) =>
		args === "skip" ? undefined : query === "get_file_pending_update" ? queryValues.pending : queryValues.sequence,
}));
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		query: (...args: unknown[]) => queryMock(...args),
		action: (...args: unknown[]) => actionMock(...args),
	},
	app_convex_api: {
		files_nodes: {
			get_file_node_for_membership: "get_file_node_for_membership",
			get_file_last_yjs_sequence: "get_file_last_yjs_sequence",
		},
		files_nodes_content: { get_non_collaborative_file_content: "get_non_collaborative_file_content" },
		files_pending_updates: {
			get_file_pending_update: "get_file_pending_update",
			get_file_pending_target: "get_file_pending_target",
		},
	},
}));
vi.mock("@/lib/files.ts", async () => ({
	...(await import("../../../../shared/files.ts")),
	files_fetch_file_yjs_state_and_text: (...args: unknown[]) => savedReadMock(...args),
	files_fetch_file_pending_update_yjs_state: (...args: unknown[]) => pendingReadMock(...args),
	files_fetch_private_file_pending_text: (...args: unknown[]) => privateReadMock(...args),
}));

import { FileHtmlPreview, type FileHtmlPreview_Source } from "./file-html-preview.tsx";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_1" as app_convex_Id<"files_nodes">;
const DOCUMENT_ID = "sequence_1" as app_convex_Id<"files_yjs_docs_last_sequences">;
const NODE = {
	_id: NODE_ID,
	_creationTime: 0,
	name: "brief.html",
	sortName: "brief.html",
	organizationId: "org_1" as app_convex_Id<"organizations">,
	workspaceId: "workspace_1" as app_convex_Id<"organizations_workspaces">,
	createdBy: "user_1" as app_convex_Id<"users">,
	updatedBy: "user_1" as app_convex_Id<"users">,
	updatedAt: 0,
	parentId: "root",
	path: "/brief.html",
	treePath: "/brief.html",
	pathDepth: 1,
	kind: "file",
	contentType: "text/html;charset=utf-8",
	assetId: "asset_1" as app_convex_Id<"files_r2_assets">,
	contentByteSize: 10,
	archiveOperationId: null,
	lowercaseExtension: "html",
	textKind: "plain_text",
	collaborationEnabled: true,
	yjsSnapshotId: "snapshot_1" as app_convex_Id<"files_yjs_snapshots">,
	yjsLastSequenceId: DOCUMENT_ID,
	statsId: null,
	contentTooLargeByteSize: null,
	contentShapeMismatchAt: null,
	contentYjsStateTooLargeByteSize: null,
	contentFrontmatterTooLargeFieldCount: null,
	contentFrontmatterTooLargeIndexDocumentCount: null,
	restrictedScopeNodeId: null,
	isRestrictedScopeRoot: false,
	writePolicy: null,
	canWrite: true,
	writeBlockedReason: null,
	writePolicyState: "none",
} as app_convex_Doc<"files_nodes">;

const PENDING = {
	_id: "pending_1" as app_convex_Id<"files_pending_updates">,
	_creationTime: 0,
	organizationId: NODE.organizationId as app_convex_Id<"organizations">,
	workspaceId: NODE.workspaceId as app_convex_Id<"organizations_workspaces">,
	userId: "user_1" as app_convex_Id<"users">,
	target: { kind: "saved" as const, id: NODE_ID },
	revision: 1,
	content: {
		base: { kind: "yjs" as const, sequence: 0, lineageGeneration: 0 },
		baseStateId: "base_1" as app_convex_Id<"files_pending_update_yjs_states">,
		stagedStateId: "staged_1" as app_convex_Id<"files_pending_update_yjs_states">,
		unstagedStateId: "unstaged_1" as app_convex_Id<"files_pending_update_yjs_states">,
	},
	updatedAt: 1,
	expiresAt: 1,
	size: 10,
	currentYjsLastSequenceId: DOCUMENT_ID,
};

const PRIVATE_PENDING = {
	...PENDING,
	target: { kind: "private", id: "private_1" as app_convex_Id<"files_pending_nodes"> },
	content: { ...PENDING.content, base: { kind: "new" } },
	createIntent: {
		kind: "text",
		textKind: "plain_text",
		contentType: "text/html;charset=utf-8",
		collaborationEnabled: false,
		metadata: [] as { key: string; value: string | number | boolean }[],
	},
	currentYjsLastSequenceId: null,
} as const;
const PRIVATE_ENTRY = {
	kind: "private",
	node: {
		_id: PRIVATE_PENDING.target.id,
		_creationTime: 0,
		organizationId: NODE.organizationId as app_convex_Id<"organizations">,
		workspaceId: NODE.workspaceId as app_convex_Id<"organizations_workspaces">,
		userId: "user_1" as app_convex_Id<"users">,
		kind: "file",
		name: NODE.name,
		parent: { kind: "root" },
		structuralRevision: 0,
		creationGeneration: 1,
		state: "active",
		closedAt: null,
	},
	pendingUpdate: PRIVATE_PENDING,
	path: "/brief.html",
} as Extract<files_VisibleEntry, { kind: "private" }>;

function editor_snapshot(overrides: Partial<FileEditor_PreviewSnapshot> = {}): FileEditor_PreviewSnapshot {
	return {
		text: "<p>Unsaved draft</p>",
		sourceKind: "editor_draft",
		isDirty: true,
		membershipId: MEMBERSHIP_ID,
		target: { kind: "saved", id: NODE_ID },
		rootKind: "plain_text",
		yjsLastSequenceId: DOCUMENT_ID,
		pendingUpdate: null,
		...overrides,
	};
}

function pending_bytes(text: string) {
	const doc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text });
	if ("_nay" in doc) throw new Error(doc._nay.message);
	const bytes = files_u8_to_array_buffer(encodeStateAsUpdate(doc));
	doc.destroy();
	return { _yay: bytes };
}

function Preview(props: {
	node?: typeof NODE;
	entry?: ComponentProps<typeof FileHtmlPreview>["entry"];
	editorRevision?: number;
	getEditorSnapshot?: () => FileEditor_PreviewSnapshot | null;
	initialSource?: FileHtmlPreview_Source | null;
}) {
	const [source, setSource] = useState<FileHtmlPreview_Source | null>(props.initialSource ?? null);
	return (
		<FileHtmlPreview
			entry={props.entry ?? { kind: "saved", node: props.node ?? NODE, pendingUpdate: null, path: "/brief.html" }}
			getEditorSnapshot={props.getEditorSnapshot ?? (() => null)}
			editorRevision={props.editorRevision ?? 0}
			selectedSource={source}
			onSourceChange={setSource}
		/>
	);
}

async function start_frame() {
	const frame = await screen.findByTitle<HTMLIFrameElement>("HTML preview: brief.html");
	const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
	post.mockClear();
	fireEvent.load(frame);
	const hello = post.mock.calls.at(-1)?.[0] as { sessionId: string };
	expect(hello).toMatchObject({ type: "hello", protocol: "bonobo-file-preview", version: 1 });
	return { frame, post, hello };
}

function send_status(
	frame: HTMLIFrameElement,
	data: unknown,
	origin = "https://preview.test",
	source = frame.contentWindow,
) {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
	});
}

beforeEach(() => {
	vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(function (this: HTMLIFrameElement) {
		vi.spyOn(this.contentWindow!, "postMessage").mockImplementation(() => {});
	});
	vi.stubEnv("VITE_FILE_PREVIEW_URL", "https://preview.test/v0");
	tenantMock.mockReturnValue({ membershipId: MEMBERSHIP_ID });
	queryValues.pending = null;
	queryValues.sequence = { yjsLastSequenceId: DOCUMENT_ID, lastSequence: 0 };
	queryMock.mockImplementation(async (query: string) => {
		if (query === "get_file_node_for_membership") return NODE;
		if (query === "get_file_pending_update") return queryValues.pending;
		return { _yay: { text: "<p>Saved</p>", textKind: "plain_text" } };
	});
	savedReadMock.mockImplementation(async () => {
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text: "<p>Saved</p>" });
		return {
			text: { _yay: "<p>Saved</p>" },
			yjsDoc,
			yjsSequence: 0,
			textKind: "plain_text",
			yjsLastSequenceId: DOCUMENT_ID,
		};
	});
	pendingReadMock.mockResolvedValue(pending_bytes("<p>Proposed</p>"));
	privateReadMock.mockResolvedValue({
		_yay: { text: "<p>Private</p>", rootKind: "plain_text", pendingUpdate: PRIVATE_PENDING },
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("FileHtmlPreview", () => {
	test("captures the first activation in StrictMode", async () => {
		render(<Preview initialSource="saved" />, { wrapper: StrictMode });
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ html: "<p>Saved</p>" }), "https://preview.test");
	});

	test.each([false, true])("reads an owner draft with local edits: %s", async (localEdits) => {
		queryValues.pending = PRIVATE_PENDING;
		queryMock.mockResolvedValue({ entry: PRIVATE_ENTRY, readiness: "ready", canEdit: true, canAccept: true });
		render(
			<Preview
				entry={PRIVATE_ENTRY}
				getEditorSnapshot={() =>
					localEdits
						? editor_snapshot({
								target: PRIVATE_PENDING.target,
								sourceKind: "proposed_changes",
								yjsLastSequenceId: null,
								pendingUpdate: PRIVATE_PENDING,
								text: "<p>Private local edits</p>",
							})
						: null
				}
			/>,
		);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: localEdits ? "<p>Private local edits</p>" : "<p>Private</p>" }),
			"https://preview.test",
		);
		expect(queryMock).toHaveBeenCalledTimes(2);
		expect(queryMock).toHaveBeenCalledWith("get_file_pending_target", {
			membershipId: MEMBERSHIP_ID,
			target: PRIVATE_PENDING.target,
		});
		expect(savedReadMock).not.toHaveBeenCalled();
		expect(pendingReadMock).not.toHaveBeenCalled();
		expect(privateReadMock).toHaveBeenCalledTimes(localEdits ? 0 : 1);
		fireEvent.click(screen.getByRole("combobox"));
		expect(screen.queryByRole("option", { name: "Saved content" })).toBeNull();
	});

	test.each(["missing", "preparing", "new generation", "new revision"])(
		"refuses a private draft that is %s",
		async (change) => {
			queryValues.pending = PRIVATE_PENDING;
			queryMock.mockResolvedValue(
				change === "missing"
					? null
					: {
							entry: {
								...PRIVATE_ENTRY,
								node: { ...PRIVATE_ENTRY.node, creationGeneration: change === "new generation" ? 2 : 1 },
								pendingUpdate: { ...PRIVATE_PENDING, revision: change === "new revision" ? 2 : 1 },
							},
							readiness: change === "preparing" ? "preparing" : "ready",
							canEdit: true,
							canAccept: true,
						},
			);
			render(<Preview entry={PRIVATE_ENTRY} />);
			await screen.findByText("The draft changed or access ended. Refresh to try again.");
			expect(privateReadMock).not.toHaveBeenCalled();
			expect(savedReadMock).not.toHaveBeenCalled();
			expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		},
	);

	test("drops private bytes when owner access ends during the read", async () => {
		queryValues.pending = PRIVATE_PENDING;
		queryMock
			.mockResolvedValueOnce({ entry: PRIVATE_ENTRY, readiness: "ready", canEdit: true, canAccept: true })
			.mockResolvedValue(null);
		render(<Preview entry={PRIVATE_ENTRY} />);
		await screen.findByText("The draft changed or access ended. Refresh to try again.");
		expect(privateReadMock).toHaveBeenCalledOnce();
		expect(savedReadMock).not.toHaveBeenCalled();
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("captures an immediate editor draft before the pending proposal", async () => {
		queryValues.pending = PENDING;
		render(<Preview getEditorSnapshot={() => editor_snapshot()} />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: "load_html", html: "<p>Unsaved draft</p>" }),
			"https://preview.test",
		);
		expect(screen.getByRole("combobox").textContent).toContain("Editor draft");
		expect(pendingReadMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(queryMock).toHaveBeenCalledWith("get_file_node_for_membership", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: NODE_ID,
		});
	});

	test("waits for queries before restoring the selected draft", async () => {
		queryValues.pending = undefined;
		const view = render(<Preview initialSource="editor_draft" getEditorSnapshot={() => editor_snapshot()} />);
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		queryValues.pending = null;
		view.rerender(<Preview initialSource="editor_draft" getEditorSnapshot={() => editor_snapshot()} />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Unsaved draft</p>" }),
			"https://preview.test",
		);
	});

	test("waits for pending discovery before choosing a source", async () => {
		queryValues.pending = undefined;
		const view = render(<Preview />);
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		queryValues.pending = PENDING;
		view.rerender(<Preview />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ html: "<p>Proposed</p>" }), "https://preview.test");
		expect(pendingReadMock).toHaveBeenCalledWith({
			membershipId: MEMBERSHIP_ID,
			target: { kind: "saved", id: NODE_ID },
			stateId: PENDING.content.unstagedStateId,
		});
		expect(savedReadMock).not.toHaveBeenCalled();
	});

	test("requires the current frame, origin, version, session, and load", async () => {
		render(<Preview />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" }, "https://wrong.test");
		send_status(frame, { ...hello, type: "ready" }, "https://preview.test", window);
		send_status(frame, { ...hello, type: "ready", version: 2 });
		send_status(frame, { ...hello, type: "ready", sessionId: crypto.randomUUID() });
		expect(post).toHaveBeenCalledTimes(1);
		send_status(frame, { ...hello, type: "ready" });
		const load = post.mock.calls.at(-1)![0] as { loadId: string };
		send_status(frame, { ...hello, type: "loaded", loadId: crypto.randomUUID() });
		expect(screen.queryByText("Preview loaded")).toBeNull();
		send_status(frame, { ...hello, type: "loaded", loadId: load.loadId });
		expect(screen.getByText("Preview loaded")).toBeDefined();
	});

	test("keeps running text frozen and refreshes the selected proposal", async () => {
		queryValues.pending = PENDING;
		const view = render(<Preview initialSource="proposed_changes" />);
		const { frame, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		queryValues.pending = {
			...PENDING,
			revision: 2,
			updatedAt: 2,
			content: { ...PENDING.content, unstagedStateId: "unstaged_2" },
		};
		pendingReadMock.mockResolvedValue(pending_bytes("<p>Revised</p>"));
		view.rerender(<Preview initialSource="proposed_changes" />);
		expect(screen.getByText("Updates available")).toBeDefined();
		expect(screen.getByTitle("HTML preview: brief.html")).toBe(frame);
		expect(pendingReadMock).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(screen.getByTitle("HTML preview: brief.html")).not.toBe(frame));
		const next = await start_frame();
		send_status(next.frame, { ...next.hello, type: "ready" });
		expect(next.post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Revised</p>" }),
			"https://preview.test",
		);
	});

	test("waits for Refresh after the saved document changes", async () => {
		let currentNode = NODE;
		queryMock.mockImplementation(async (query: string) =>
			query === "get_file_node_for_membership"
				? currentNode
				: { _yay: { text: "<p>Saved with collaboration off</p>", textKind: "plain_text" } },
		);
		const view = render(<Preview initialSource="saved" />);
		const first = await start_frame();
		send_status(first.frame, { ...first.hello, type: "ready" });
		currentNode = { ...NODE, collaborationEnabled: false, yjsLastSequenceId: null, yjsSnapshotId: null };
		await act(async () => view.rerender(<Preview node={currentNode} initialSource="saved" />));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(queryMock).not.toHaveBeenCalledWith("get_non_collaborative_file_content", expect.anything());
		expect(screen.getByText("Refresh to preview this source.")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		const next = await start_frame();
		expect(next.frame).not.toBe(first.frame);
		send_status(next.frame, { ...next.hello, type: "ready" });
		expect(next.post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Saved with collaboration off</p>" }),
			"https://preview.test",
		);
	});

	test("waits for Refresh after a stale proposal becomes current again", async () => {
		let currentNode = { ...NODE, collaborationEnabled: false, yjsLastSequenceId: null, yjsSnapshotId: null };
		const proposal = {
			...PENDING,
			content: { ...PENDING.content, base: { kind: "asset", assetId: NODE.assetId } },
			currentYjsLastSequenceId: null,
		};
		queryValues.pending = proposal;
		queryMock.mockImplementation(async (query: string) =>
			query === "get_file_node_for_membership" ? currentNode : queryValues.pending,
		);
		const view = render(<Preview node={currentNode} initialSource="proposed_changes" />);
		const first = await start_frame();
		send_status(first.frame, { ...first.hello, type: "ready" });
		// A member save makes this proposal stale. Agent preparation keeps its id.
		currentNode = { ...currentNode, assetId: "asset_2" as typeof NODE.assetId };
		view.rerender(<Preview node={currentNode} initialSource="proposed_changes" />);
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(screen.getByText("Review and sync these changes first.")).toBeDefined();
		queryValues.pending = {
			...proposal,
			content: {
				...proposal.content,
				base: { kind: "asset", assetId: currentNode.assetId },
				unstagedStateId: "unstaged_2",
			},
			updatedAt: 2,
			revision: 2,
		};
		pendingReadMock.mockResolvedValue(pending_bytes("<p>Prepared proposal</p>"));
		await act(async () => view.rerender(<Preview node={currentNode} initialSource="proposed_changes" />));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(pendingReadMock).toHaveBeenCalledOnce();
		expect(screen.getByText("Refresh to preview this source.")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		const next = await start_frame();
		send_status(next.frame, { ...next.hello, type: "ready" });
		expect(next.post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Prepared proposal</p>" }),
			"https://preview.test",
		);
	});

	test("stops a removed proposal and waits for a source choice", async () => {
		queryValues.pending = PENDING;
		const view = render(<Preview />);
		await start_frame();
		queryValues.pending = null;
		view.rerender(<Preview />);
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain("Choose an available source");
		expect(savedReadMock).not.toHaveBeenCalled();
	});

	test("does not read a private proposal through the saved preview", async () => {
		queryValues.pending = { ...PENDING, target: { kind: "private", id: NODE_ID } };
		render(<Preview initialSource="proposed_changes" />);
		await screen.findByText("Choose an available source.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(pendingReadMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("refuses stale proposals without preparing or reading their pages", async () => {
		queryValues.pending = { ...PENDING, contentNeedsRebase: true };
		render(<Preview />);
		await screen.findByText("Review and sync these changes first.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(pendingReadMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("drops a paged proposal read when its revision changes within the same timestamp", async () => {
		queryValues.pending = PENDING;
		const deferred = Promise.withResolvers<ReturnType<typeof pending_bytes>>();
		pendingReadMock.mockReturnValue(deferred.promise);
		const view = render(<Preview />);
		await waitFor(() => expect(pendingReadMock).toHaveBeenCalled());
		queryValues.pending = { ...PENDING, revision: 2 };
		view.rerender(<Preview />);
		await act(async () => deferred.resolve(pending_bytes("<p>Old proposal</p>")));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain("changed while loading");
	});

	test("ignores an old read after switching sources", async () => {
		queryValues.pending = PENDING;
		const deferred = Promise.withResolvers<ReturnType<typeof pending_bytes>>();
		pendingReadMock.mockReturnValue(deferred.promise);
		const props = {
			entry: { kind: "saved", node: NODE, pendingUpdate: null, path: "/brief.html" } as const,
			getEditorSnapshot: () => null,
			editorRevision: 0,
			onSourceChange: vi.fn(),
		};
		const view = render(<FileHtmlPreview {...props} selectedSource="proposed_changes" />);
		await waitFor(() => expect(pendingReadMock).toHaveBeenCalled());
		view.rerender(<FileHtmlPreview {...props} selectedSource="saved" />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ html: "<p>Saved</p>" }), "https://preview.test");
		await act(async () => deferred.resolve(pending_bytes("<p>Old proposal</p>")));
		expect(screen.getByTitle("HTML preview: brief.html")).toBe(frame);
		expect(post).toHaveBeenCalledTimes(2);
	});

	test("ignores an old read after switching memberships", async () => {
		const deferred = Promise.withResolvers<ReturnType<typeof pending_bytes>>();
		queryValues.pending = PENDING;
		pendingReadMock.mockReturnValueOnce(deferred.promise);
		const view = render(<Preview initialSource="proposed_changes" />);
		await waitFor(() => expect(pendingReadMock).toHaveBeenCalledOnce());
		tenantMock.mockReturnValue({ membershipId: "membership_2" });
		await act(async () => view.rerender(<Preview initialSource="proposed_changes" />));
		await act(async () => deferred.resolve(pending_bytes("<p>Old membership text</p>")));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(pendingReadMock).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ html: "<p>Proposed</p>" }), "https://preview.test");
		expect(queryMock).toHaveBeenCalledWith("get_file_node_for_membership", {
			membershipId: "membership_2",
			fileNodeId: NODE_ID,
		});
	});

	test("uses the Diff modified draft only when its proposal identity matches", async () => {
		queryValues.pending = PENDING;
		render(
			<Preview
				getEditorSnapshot={() =>
					editor_snapshot({ sourceKind: "proposed_changes", text: "<p>Local proposal</p>", pendingUpdate: PENDING })
				}
			/>,
		);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Local proposal</p>" }),
			"https://preview.test",
		);
		expect(screen.getByRole("combobox").textContent).toContain("Proposed changes with unsaved edits");
		expect(pendingReadMock).not.toHaveBeenCalled();
	});

	test("ignores a Diff draft from an older proposal", async () => {
		queryValues.pending = PENDING;
		render(
			<Preview
				getEditorSnapshot={() =>
					editor_snapshot({ sourceKind: "proposed_changes", pendingUpdate: { ...PENDING, revision: 0 } })
				}
			/>,
		);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ html: "<p>Proposed</p>" }), "https://preview.test");
		expect(pendingReadMock).toHaveBeenCalledTimes(1);
	});

	test("reads saved content with collaboration off", async () => {
		const node = { ...NODE, collaborationEnabled: false, yjsLastSequenceId: null, yjsSnapshotId: null };
		queryMock.mockImplementation(async (query: string) =>
			query === "get_file_node_for_membership"
				? node
				: { _yay: { text: "<p>Saved bytes</p>", textKind: "plain_text" } },
		);
		render(<Preview node={node} />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		expect(post).toHaveBeenLastCalledWith(
			expect.objectContaining({ html: "<p>Saved bytes</p>" }),
			"https://preview.test",
		);
		expect(queryMock).toHaveBeenCalledWith("get_non_collaborative_file_content", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
		});
		expect(savedReadMock).not.toHaveBeenCalled();
	});

	test("drops a saved read when its asset changes with collaboration off", async () => {
		const node = { ...NODE, collaborationEnabled: false, yjsLastSequenceId: null, yjsSnapshotId: null };
		const deferred = Promise.withResolvers<{ _yay: { text: string; textKind: string } }>();
		let currentNode = node;
		queryMock.mockImplementation(async (query: string) =>
			query === "get_file_node_for_membership" ? currentNode : deferred.promise,
		);
		const view = render(<Preview node={node} />);
		await waitFor(() =>
			expect(queryMock).toHaveBeenCalledWith("get_non_collaborative_file_content", expect.anything()),
		);
		currentNode = { ...node, assetId: "asset_2" as typeof node.assetId };
		view.rerender(<Preview node={currentNode} />);
		await act(async () => deferred.resolve({ _yay: { text: "<p>Old saved text</p>", textKind: "plain_text" } }));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain("file changed or access ended");
	});

	test("refuses a draft after read access ends", async () => {
		queryMock.mockResolvedValue(null);
		render(<Preview getEditorSnapshot={() => editor_snapshot()} />);
		await screen.findByText("The file changed or access ended. Refresh to try again.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(savedReadMock).not.toHaveBeenCalled();
	});

	test("drops a read when access ends before completion", async () => {
		queryValues.pending = PENDING;
		const deferred = Promise.withResolvers<ReturnType<typeof pending_bytes>>();
		pendingReadMock.mockReturnValue(deferred.promise);
		render(<Preview />);
		await waitFor(() => expect(pendingReadMock).toHaveBeenCalled());
		queryMock.mockImplementation(async (query: string) => (query === "get_file_pending_update" ? PENDING : null));
		await act(async () => deferred.resolve(pending_bytes("<p>Private text</p>")));
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		expect(screen.getByRole("alert").textContent).toContain("access ended");
	});

	test("destroys the temporary saved document when the document identity changed", async () => {
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text: "<p>Old document</p>" });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const destroy = vi.spyOn(yjsDoc, "destroy");
		savedReadMock.mockResolvedValue({
			text: { _yay: "<p>Old document</p>" },
			yjsDoc,
			textKind: "plain_text",
			yjsLastSequenceId: "old_sequence",
		});
		render(<Preview />);
		await screen.findByText("The file changed while loading. Refresh to try again.");
		expect(destroy).toHaveBeenCalledOnce();
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("keeps an error visible after a later loaded message and retries in a fresh frame", async () => {
		render(<Preview />);
		const { frame, post, hello } = await start_frame();
		send_status(frame, { ...hello, type: "ready" });
		const load = post.mock.calls.at(-1)![0] as { loadId: string };
		send_status(frame, { ...hello, type: "error", loadId: load.loadId, message: "<b>Runtime failed</b>" });
		send_status(frame, { ...hello, type: "loaded", loadId: load.loadId });
		expect(screen.getByRole("alert").textContent).toBe("<b>Runtime failed</b>");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		const next = await start_frame();
		expect(next.frame).not.toBe(frame);
		expect(next.hello.sessionId).not.toBe(hello.sessionId);
		send_status(next.frame, { ...hello, type: "ready" });
		expect(next.post).toHaveBeenCalledTimes(1);
	});

	test("removes the frame when the runtime times out", async () => {
		const timeout = vi.spyOn(window, "setTimeout");
		render(<Preview />);
		await start_frame();
		const call = timeout.mock.calls.find((entry) => entry[1] === 15_000);
		expect(call).toBeDefined();
		act(() => {
			const callback = call![0];
			if (typeof callback !== "function") throw new Error("Expected timeout callback");
			callback();
		});
		expect(screen.getByRole("alert").textContent).toBe("Preview timed out. Try again.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("refuses an over-cap draft before it reaches a frame", async () => {
		render(<Preview getEditorSnapshot={() => editor_snapshot({ text: "x".repeat(900_001) })} />);
		await screen.findByText("HTML exceeds the 900,000-byte preview limit.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("counts UTF-8 bytes before sending a draft", async () => {
		render(<Preview getEditorSnapshot={() => editor_snapshot({ text: "😀".repeat(225_001) })} />);
		await screen.findByText("HTML exceeds the 900,000-byte preview limit.");
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("does not parse an old HTML blob with no editable shape", () => {
		render(<Preview node={{ ...NODE, textKind: null, yjsLastSequenceId: null, yjsSnapshotId: null }} />);
		expect(screen.getByRole("alert").textContent).toBe("This file is no longer available for Preview.");
		expect(savedReadMock).not.toHaveBeenCalled();
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test("rejects a preview URL on the Press origin", async () => {
		vi.stubEnv("VITE_FILE_PREVIEW_URL", `${window.location.origin}/v0`);
		render(<Preview />);
		expect(screen.getByText("Preview is not configured")).toBeDefined();
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});

	test.each([
		"javascript:alert(1)",
		"data:text/html,hello",
		"http://preview.test/v0",
		"https://user:password@preview.test/v0",
	])("rejects unsafe runtime URL %s", (url) => {
		vi.stubEnv("VITE_FILE_PREVIEW_URL", url);
		render(<Preview />);
		expect(screen.getByText("Preview is not configured")).toBeDefined();
		expect(screen.queryByTitle("HTML preview: brief.html")).toBeNull();
	});
});
