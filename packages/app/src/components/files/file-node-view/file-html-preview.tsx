import "./file-html-preview.css";

import { MyButton } from "@/components/my-button.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectLabel,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	files_editable_text_content_type_of,
	files_fetch_file_pending_update_yjs_state,
	files_fetch_file_yjs_state_and_text,
	files_node_has_editable_text_content,
	files_pending_update_content_is_stale,
	files_pending_update_has_content,
} from "@/lib/files.ts";
import {
	file_preview_MaxHtmlBytes,
	file_preview_ProtocolName,
	file_preview_ProtocolVersion,
	file_preview_RuntimeMessageSchema,
	type file_preview_HostMessage,
} from "bonobo-file-preview/protocol";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { files_yjs_doc_get_text } from "../../../../shared/files-tiptap.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../../../../shared/files-yjs.ts";
import type { FileEditor_PreviewSnapshot } from "../file-editor/file-editor.tsx";

export type FileHtmlPreview_Source = "saved" | "editor_draft" | "proposed_changes";

type FileHtmlPreview_ClassNames =
	| "FileHtmlPreview"
	| "FileHtmlPreview-toolbar"
	| "FileHtmlPreview-source"
	| "FileHtmlPreview-status"
	| "FileHtmlPreview-message"
	| "FileHtmlPreview-frame";

type FileHtmlPreview_Node = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_nodes.get_file_node_for_membership>
>;

function pending_content_key(pending: FileEditor_PreviewSnapshot["pendingUpdate"]) {
	return pending
		? JSON.stringify([
				pending._id,
				pending.updatedAt,
				pending.baseStateId,
				pending.stagedStateId,
				pending.unstagedStateId,
				pending.baseAssetId,
				pending.baseLineageGeneration,
			])
		: null;
}

function preview_runtime_url() {
	const configuredUrl = import.meta.env.VITE_FILE_PREVIEW_URL as string | undefined;
	const localApp = ["http://localhost:5173", "http://127.0.0.1:5173"].includes(window.location.origin);
	const value = configuredUrl || (import.meta.env.DEV && localApp ? "http://127.0.0.1:5175/v0" : null);
	if (!value) return null;
	try {
		const url = new URL(value);
		const localRuntime = ["http://localhost:5175", "http://127.0.0.1:5175"].includes(url.origin);
		if (
			url.origin === window.location.origin ||
			url.username ||
			url.password ||
			(url.protocol !== "https:" && !(import.meta.env.DEV && localApp && localRuntime))
		) {
			return null;
		}
		return url;
	} catch {
		return null;
	}
}

async function read_preview_source(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	node: FileHtmlPreview_Node;
	source: FileHtmlPreview_Source;
	draft: FileEditor_PreviewSnapshot | null;
	pendingUpdate: FunctionReturnType<typeof app_convex_api.files_pending_updates.get_file_pending_update>;
}) {
	const { membershipId, node, source, draft, pendingUpdate } = args;
	const assertCurrentNode = (current: FileHtmlPreview_Node | null) => {
		if (
			!current ||
			current._id !== node._id ||
			current.textKind !== "plain_text" ||
			current.contentType !== node.contentType ||
			current.archiveOperationId !== null ||
			!files_node_has_editable_text_content(current) ||
			current.collaborationEnabled !== node.collaborationEnabled ||
			current.yjsLastSequenceId !== node.yjsLastSequenceId ||
			(!node.collaborationEnabled && current.assetId !== node.assetId)
		) {
			throw new Error("The file changed or access ended. Refresh to try again.");
		}
	};
	// Local editor text still needs a current read-access check before leaving Press.
	assertCurrentNode(
		await app_convex.query(app_convex_api.files_nodes.get_file_node_for_membership, {
			membershipId,
			fileNodeId: node._id,
		}),
	);
	let html: string;
	if (source === "editor_draft") {
		if (draft?.sourceKind !== "editor_draft") throw new Error("Choose an available source.");
		html = draft.text;
	} else if (source === "proposed_changes") {
		if (!files_pending_update_has_content(pendingUpdate)) throw new Error("Choose an available source.");
		if (draft?.sourceKind === "proposed_changes") {
			html = draft.text;
		} else {
			const state = await files_fetch_file_pending_update_yjs_state({
				membershipId,
				nodeId: node._id,
				stateId: pendingUpdate.unstagedStateId,
			});
			if (state._nay) throw new Error(state._nay.message);
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(state._yay);
			try {
				const text = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
				if (text._nay) throw new Error(text._nay.message);
				html = text._yay;
			} finally {
				yjsDoc.destroy();
			}
		}
		const currentPending = await app_convex.query(app_convex_api.files_pending_updates.get_file_pending_update, {
			membershipId,
			nodeId: node._id,
		});
		if (
			pending_content_key(currentPending) !== pending_content_key(pendingUpdate) ||
			currentPending?.contentNeedsRebase
		) {
			throw new Error("The proposed changes changed while loading. Refresh to try again.");
		}
	} else if (node.collaborationEnabled) {
		const saved = await files_fetch_file_yjs_state_and_text({ membershipId, nodeId: node._id });
		if (!saved) throw new Error("Saved content is not available. Refresh to try again.");
		try {
			if (saved.text._nay) throw new Error(saved.text._nay.message);
			if (saved.textKind !== "plain_text" || saved.yjsLastSequenceId !== node.yjsLastSequenceId) {
				throw new Error("The file changed while loading. Refresh to try again.");
			}
			html = saved.text._yay;
		} finally {
			saved.yjsDoc.destroy();
		}
	} else {
		const saved = await app_convex.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId,
			nodeId: node._id,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (saved._yay.textKind !== "plain_text") throw new Error("This file is no longer available for Preview.");
		html = saved._yay.text;
	}
	assertCurrentNode(
		await app_convex.query(app_convex_api.files_nodes.get_file_node_for_membership, {
			membershipId,
			fileNodeId: node._id,
		}),
	);
	if (new TextEncoder().encode(html).byteLength > file_preview_MaxHtmlBytes) {
		throw new Error("HTML exceeds the 900,000-byte preview limit.");
	}
	return html;
}

export const FileHtmlPreview = memo(function FileHtmlPreview(props: {
	node: FileHtmlPreview_Node;
	getEditorSnapshot: () => FileEditor_PreviewSnapshot | null;
	editorRevision: number;
	selectedSource: FileHtmlPreview_Source | null | undefined;
	onSourceChange: (source: FileHtmlPreview_Source) => void;
}) {
	const { node, getEditorSnapshot, editorRevision, selectedSource, onSourceChange } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const pendingUpdate = useQuery(app_convex_api.files_pending_updates.get_file_pending_update, {
		membershipId,
		nodeId: node._id,
	});
	const lastSequence = useQuery(
		app_convex_api.files_nodes.get_file_last_yjs_sequence,
		node.collaborationEnabled ? { membershipId, nodeId: node._id } : "skip",
	);
	const runtimeUrl = preview_runtime_url();
	const eligible =
		files_editable_text_content_type_of(node.contentType) === "text/html;charset=utf-8" &&
		node.textKind === "plain_text" &&
		files_node_has_editable_text_content(node) &&
		node.archiveOperationId === null;
	// A loaded snapshot is stale the moment any of these inputs change.
	const scope = JSON.stringify([membershipId, node._id, node.yjsLastSequenceId, node.collaborationEnabled, eligible]);
	const hasProposal = files_pending_update_has_content(pendingUpdate);
	const pendingKey = pending_content_key(pendingUpdate ?? null);
	const staleProposal =
		hasProposal &&
		(files_pending_update_content_is_stale(pendingUpdate, node) ||
			pendingUpdate.currentYjsLastSequenceId !== node.yjsLastSequenceId);
	// undefined is a real fourth state: no source chosen yet, and the checks below test `!== undefined`.
	const [editorSource, setEditorSource] = useState<"editor_draft" | "proposed_changes" | null>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [snapshot, setSnapshot] = useState<{
		id: string;
		html: string;
		source: FileHtmlPreview_Source;
		scope: string;
		contentKey: string;
		pendingId: string | null;
	} | null>(null);
	const requestRef = useRef(0);
	const autoCaptureSourceRef = useRef<FileHtmlPreview_Source | null>(null);

	const readEditorSnapshot = useFn(() => {
		const draft = getEditorSnapshot();
		if (
			!draft ||
			!draft.isDirty ||
			draft.membershipId !== membershipId ||
			draft.nodeId !== node._id ||
			draft.rootKind !== node.textKind ||
			draft.yjsLastSequenceId !== node.yjsLastSequenceId ||
			(draft.sourceKind === "proposed_changes" && pending_content_key(draft.pendingUpdate) !== pendingKey)
		) {
			return null;
		}
		return draft;
	});

	useLayoutEffect(() => {
		// Keep only availability in React state. Read the text when the user runs Preview.
		setEditorSource(readEditorSnapshot()?.sourceKind ?? null);
	}, [readEditorSnapshot, scope, pendingKey, editorRevision]);

	const sourceError = !eligible
		? "This file is no longer available for Preview."
		: selectedSource === "editor_draft" && editorSource !== undefined && editorSource !== "editor_draft"
			? "Choose an available source."
			: selectedSource === "proposed_changes" && pendingUpdate !== undefined && !hasProposal
				? "Choose an available source."
				: selectedSource === "proposed_changes" && staleProposal
					? "Review and sync these changes first."
					: null;
	const contentKey =
		selectedSource === "editor_draft"
			? String(editorRevision)
			: selectedSource === "proposed_changes"
				? `${pendingKey}:${editorSource === "proposed_changes" ? editorRevision : ""}`
				: node.collaborationEnabled
					? `${lastSequence?.yjsLastSequenceId}:${lastSequence?.lastSequence}`
					: String(node.assetId);
	const sourceReady =
		pendingUpdate !== undefined &&
		editorSource !== undefined &&
		(selectedSource !== "saved" || !node.collaborationEnabled || lastSequence !== undefined);
	const pendingSourceId = selectedSource === "proposed_changes" ? pendingUpdate?._id : null;
	const canShowSnapshot =
		snapshot &&
		!sourceError &&
		snapshot.scope === scope &&
		snapshot.source === selectedSource &&
		(selectedSource !== "proposed_changes" || snapshot.pendingId === pendingUpdate?._id);
	const updatesAvailable = canShowSnapshot && snapshot.contentKey !== contentKey;

	const isCurrentRequest = useFn((request: number, capturedScope: string, source: FileHtmlPreview_Source) => {
		return requestRef.current === request && scope === capturedScope && selectedSource === source;
	});
	const isCurrentContent = useFn((capturedKey: string) => !sourceError && capturedKey === contentKey);

	const captureSnapshot = useFn(async () => {
		if (!selectedSource || !runtimeUrl || sourceError || !sourceReady || pendingUpdate === undefined) return;
		const request = ++requestRef.current;
		const capturedScope = scope;
		const source = selectedSource;
		const capturedKey = contentKey;
		const capturedPending = pendingUpdate;
		setSnapshot(null);
		setError(null);
		setLoading(true);
		const html = await read_preview_source({
			membershipId,
			node,
			source,
			draft: readEditorSnapshot(),
			pendingUpdate,
		}).catch((cause: unknown) => {
			if (isCurrentRequest(request, capturedScope, source)) {
				setError(cause instanceof Error ? cause.message : "Preview could not load. Refresh to try again.");
			}
			return null;
		});
		if (!isCurrentRequest(request, capturedScope, source)) return;
		setLoading(false);
		if (html === null) return;
		if (!isCurrentContent(capturedKey)) {
			setError("The source changed while loading. Refresh to try again.");
			return;
		}
		setSnapshot({
			id: crypto.randomUUID(),
			html,
			source,
			scope: capturedScope,
			contentKey: capturedKey,
			pendingId: capturedPending?._id ?? null,
		});
	});

	useEffect(() => {
		if (selectedSource == null && pendingUpdate !== undefined && editorSource !== undefined) {
			onSourceChange(editorSource ?? (hasProposal ? "proposed_changes" : "saved"));
		}
	}, [selectedSource, pendingUpdate, editorSource, hasProposal, onSourceChange]);

	useLayoutEffect(() => {
		// Discard invalid snapshots so a recovered source cannot restart old scripts.
		setSnapshot(null);
		setError(null);
		setLoading(false);
		return () => {
			requestRef.current++;
		};
	}, [selectedSource, scope, sourceError, sourceReady, pendingSourceId, runtimeUrl?.href]);

	useEffect(() => {
		// Only first activation or a new source choice starts a capture automatically.
		if (!selectedSource || !sourceReady || autoCaptureSourceRef.current === selectedSource) return;
		autoCaptureSourceRef.current = selectedSource;
		void captureSnapshot();
	}, [captureSnapshot, selectedSource, sourceReady]);

	const handleSourceChange = useFn((value: string) => {
		if (value === "saved" || value === "editor_draft" || value === "proposed_changes") onSourceChange(value);
	});
	const proposalLabel =
		editorSource === "proposed_changes" ? "Proposed changes with unsaved edits" : "Proposed changes";
	const sourceLabel =
		selectedSource === "saved"
			? "Saved content"
			: selectedSource === "editor_draft"
				? "Editor draft"
				: selectedSource === "proposed_changes"
					? proposalLabel
					: "Choose a source";

	return (
		<div className={"FileHtmlPreview" satisfies FileHtmlPreview_ClassNames}>
			<div className={"FileHtmlPreview-toolbar" satisfies FileHtmlPreview_ClassNames}>
				<div className={"FileHtmlPreview-source" satisfies FileHtmlPreview_ClassNames}>
					<MySelect value={selectedSource ?? ""} setValue={handleSourceChange}>
						<MySelectLabel>Source</MySelectLabel>
						<MySelectTrigger disabled={pendingUpdate === undefined || editorSource === undefined}>
							<MyButton variant="outline">
								{sourceLabel}
								<MySelectOpenIndicator />
							</MyButton>
						</MySelectTrigger>
						<MySelectPopover>
							<MySelectPopoverScrollableArea>
								<MySelectPopoverContent>
									<MySelectItem value="saved">Saved content</MySelectItem>
									{editorSource === "editor_draft" && <MySelectItem value="editor_draft">Editor draft</MySelectItem>}
									{hasProposal && <MySelectItem value="proposed_changes">{proposalLabel}</MySelectItem>}
								</MySelectPopoverContent>
							</MySelectPopoverScrollableArea>
						</MySelectPopover>
					</MySelect>
				</div>
				<MyButton
					variant="outline"
					disabled={loading || !runtimeUrl || !!sourceError || !sourceReady}
					onClick={captureSnapshot}
				>
					Refresh
				</MyButton>
				{updatesAvailable && (
					<span className={"FileHtmlPreview-status" satisfies FileHtmlPreview_ClassNames} role="status">
						Updates available
					</span>
				)}
			</div>
			{!runtimeUrl ? (
				<p className={"FileHtmlPreview-message" satisfies FileHtmlPreview_ClassNames} role="alert">
					Preview is not configured
				</p>
			) : sourceError || error ? (
				<p className={"FileHtmlPreview-message" satisfies FileHtmlPreview_ClassNames} role="alert">
					{sourceError ?? error}
				</p>
			) : canShowSnapshot ? (
				<FileHtmlPreviewFrame
					key={snapshot.id}
					html={snapshot.html}
					name={node.name}
					runtimeUrl={runtimeUrl.href}
					onRetry={captureSnapshot}
				/>
			) : (
				<p className={"FileHtmlPreview-message" satisfies FileHtmlPreview_ClassNames} role="status">
					{loading || pendingUpdate === undefined ? "Loading preview…" : "Refresh to preview this source."}
				</p>
			)}
		</div>
	);
});

const FileHtmlPreviewFrame = memo(function FileHtmlPreviewFrame(props: {
	html: string;
	name: string;
	runtimeUrl: string;
	onRetry: () => void;
}) {
	const { html, name, runtimeUrl, onRetry } = props;
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [status, setStatus] = useState("Loading preview…");
	const [error, setError] = useState<string | null>(null);

	useLayoutEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const runtimeOrigin = new URL(runtimeUrl).origin;
		const sessionId = crypto.randomUUID();
		const loadId = crypto.randomUUID();
		let ready = false;
		let failed = false;
		const send = (message: file_preview_HostMessage) => frame.contentWindow?.postMessage(message, runtimeOrigin);
		const fail = (message: string) => {
			failed = true;
			window.clearTimeout(timeout);
			setError(message);
		};
		const timeout = window.setTimeout(() => fail("Preview timed out. Try again."), 15_000);
		const handleLoad = () => {
			if (failed) return;
			send({ protocol: file_preview_ProtocolName, version: file_preview_ProtocolVersion, type: "hello", sessionId });
		};
		const handleMessage = (event: MessageEvent<unknown>) => {
			if (failed || event.source !== frame.contentWindow || event.origin !== runtimeOrigin) return;
			const parsed = file_preview_RuntimeMessageSchema.safeParse(event.data);
			if (!parsed.success || parsed.data.sessionId !== sessionId) return;
			const message = parsed.data;
			if (message.type === "ready") {
				if (ready) return;
				ready = true;
				send({
					protocol: file_preview_ProtocolName,
					version: file_preview_ProtocolVersion,
					type: "load_html",
					sessionId,
					loadId,
					html,
				});
			} else if (ready && message.loadId === loadId) {
				if (message.type === "error") fail(message.message);
				else {
					window.clearTimeout(timeout);
					setStatus("Preview loaded");
				}
			}
		};
		// Listen before navigation so a fast runtime cannot win the handshake race.
		window.addEventListener("message", handleMessage);
		frame.addEventListener("load", handleLoad);
		frame.src = runtimeUrl;
		return () => {
			failed = true;
			window.clearTimeout(timeout);
			window.removeEventListener("message", handleMessage);
			frame.removeEventListener("load", handleLoad);
		};
	}, [html, runtimeUrl]);

	return error ? (
		<div className={"FileHtmlPreview-message" satisfies FileHtmlPreview_ClassNames}>
			<p role="alert">{error}</p>
			<MyButton variant="outline" onClick={onRetry}>
				Retry
			</MyButton>
		</div>
	) : (
		<>
			<span className={"FileHtmlPreview-status" satisfies FileHtmlPreview_ClassNames} role="status">
				{status}
			</span>
			<iframe
				ref={frameRef}
				className={"FileHtmlPreview-frame" satisfies FileHtmlPreview_ClassNames}
				title={`HTML preview: ${name}`}
				// allow-same-origin is safe only because preview_runtime_url() refuses the app's own origin.
				sandbox="allow-scripts allow-same-origin"
				referrerPolicy="no-referrer"
			/>
		</>
	);
});
