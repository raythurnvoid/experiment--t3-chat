import "./page-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_update_from_markdown,
	pages_u8_to_array_buffer,
	pages_yjs_doc_clone,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_headless_tiptap_editor_create,
} from "@/lib/pages.ts";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { editor as monaco_editor } from "monaco-editor";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvex, useQuery, type ConvexReactClient, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChevronRight, RefreshCcw, Save } from "lucide-react";
import { MyIcon } from "@/components/my-icon.tsx";
import { Await } from "@/components/await.tsx";
import { Doc as YDoc, applyUpdate } from "yjs";
import { useLiveRef, useStateRef } from "../../../hooks/utils-hooks.ts";
import { toast } from "sonner";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";
import {
	page_editor_fetch_page_yjs_state_and_markdown,
	type PageEditorYjsLoad_InitialData,
} from "../page-editor-yjs-load.ts";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import type { human_thread_messages_Thread } from "@/lib/human-thread-messages.ts";
import { PageEditorCommentsThread, type PageEditorCommentsThread_Props } from "../page-editor-comments-thread.tsx";

// #region Error
type PageEditorPlainTextError_Props = ErrorComponentProps;

type PageEditorPlainTextError_ClassNames =
	| "PageEditorPlainTextError"
	| "PageEditorPlainTextError-content"
	| "PageEditorPlainTextError-title"
	| "PageEditorPlainTextError-description"
	| "PageEditorPlainTextError-actions"
	| "PageEditorPlainTextError-retry-button"
	| "PageEditorPlainTextError-technical-details"
	| "PageEditorPlainTextError-technical-details-toggle"
	| "PageEditorPlainTextError-technical-details-toggle-icon"
	| "PageEditorPlainTextError-technical-details-pre"
	| "PageEditorPlainTextError-technical-details-textarea";

function PageEditorPlainTextError(props: PageEditorPlainTextError_Props) {
	const { error, info } = props;

	const technicalDetails = [
		error.message && `Error message: ${error.message}`,
		error.stack && `Stack trace:\n${error.stack}`,
		info?.componentStack && `Component stack:\n${info.componentStack}`,
	]
		.filter(Boolean)
		.join("\n\n");

	return (
		<div className={cn("PageEditorPlainTextError" satisfies PageEditorPlainTextError_ClassNames)}>
			<div className={cn("PageEditorPlainTextError-content" satisfies PageEditorPlainTextError_ClassNames)}>
				<div className={cn("PageEditorPlainTextError-title" satisfies PageEditorPlainTextError_ClassNames)}>
					Editor failed to load.
				</div>
				<div className={cn("PageEditorPlainTextError-description" satisfies PageEditorPlainTextError_ClassNames)}>
					Try again, or reload the page if the problem persists.
				</div>
				<div className={cn("PageEditorPlainTextError-actions" satisfies PageEditorPlainTextError_ClassNames)}>
					<MyButton
						variant="secondary"
						className={cn("PageEditorPlainTextError-retry-button" satisfies PageEditorPlainTextError_ClassNames)}
						onClick={props.reset}
					>
						Try again
					</MyButton>
				</div>
				{technicalDetails && (
					<details
						className={cn("PageEditorPlainTextError-technical-details" satisfies PageEditorPlainTextError_ClassNames)}
					>
						<summary
							className={cn(
								"PageEditorPlainTextError-technical-details-toggle" satisfies PageEditorPlainTextError_ClassNames,
							)}
						>
							<span>Technical details</span>
							<MyIcon
								className={cn(
									"PageEditorPlainTextError-technical-details-toggle-icon" satisfies PageEditorPlainTextError_ClassNames,
								)}
							>
								<ChevronRight />
							</MyIcon>
						</summary>
						<pre
							className={cn(
								"PageEditorPlainTextError-technical-details-pre" satisfies PageEditorPlainTextError_ClassNames,
							)}
						>
							<textarea
								className={cn(
									"PageEditorPlainTextError-technical-details-textarea" satisfies PageEditorPlainTextError_ClassNames,
								)}
								readOnly
								value={technicalDetails}
							></textarea>
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}

// #endregion Error

type PageEditorPlainText_InitialData = {
	markdown: string;
	mut_yjsDoc: YDoc;
	yjsSequence: number;
};

async function fetch_page_yjs_state_and_markdown(
	convex: ConvexReactClient,
	args: {
		workspaceId: string;
		projectId: string;
		pageId: app_convex_Id<"pages">;
	},
): Promise<PageEditorPlainText_InitialData> {
	const [snapshotDoc, updatesData, lastSequenceData] = await Promise.all([
		convex.query(api.ai_docs_temp.yjs_get_doc_last_snapshot, args),
		convex.query(api.ai_docs_temp.yjs_get_incremental_updates, args).then((updatesData) => updatesData?.updates ?? []),
		convex.query(api.ai_docs_temp.get_page_last_yjs_sequence, args),
	]);

	if (snapshotDoc == null) {
		// Return empty state
		const emptyYjsDoc = new YDoc();
		return { markdown: "", mut_yjsDoc: emptyYjsDoc, yjsSequence: 0 };
	}

	// By default the API returns updates in descending order; normalize to ascending and filter
	// to only include updates that are after the snapshot.
	const filteredIncrementalUpdates = updatesData.filter((u) => u.sequence > snapshotDoc.sequence).reverse();

	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshotDoc.snapshot_update, {
		additionalIncrementalArrayBufferUpdates: filteredIncrementalUpdates.map((u) => u.update),
	});
	const markdown = pages_yjs_doc_get_markdown({ yjsDoc });

	const yjsSequence = lastSequenceData?.last_sequence ?? snapshotDoc.sequence;
	return { markdown, mut_yjsDoc: yjsDoc, yjsSequence };
}

// #region Toolbar
export type PageEditorPlainTextToolbar_ClassNames =
	| "PageEditorPlainTextToolbar"
	| "PageEditorPlainTextToolbar-scrollable-area"
	| "PageEditorPlainTextToolbar-button"
	| "PageEditorPlainTextToolbar-icon";

export type PageEditorPlainTextToolbar_Props = {
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	pageId: app_convex_Id<"pages">;
	sessionId: string;
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown: (markdown: string) => void;
	onClickSave: () => void;
	onClickSync: () => void;
};

function PageEditorPlainTextToolbar(props: PageEditorPlainTextToolbar_Props) {
	const {
		isSaveDisabled,
		isSyncDisabled,
		pageId,
		sessionId,
		getCurrentMarkdown,
		onApplySnapshotMarkdown,
		onClickSave,
		onClickSync,
	} = props;

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);

	return (
		<div
			ref={setPortalElement}
			role="toolbar"
			aria-label="Toolbar"
			aria-orientation="horizontal"
			className={cn("PageEditorPlainTextToolbar" satisfies PageEditorPlainTextToolbar_ClassNames)}
		>
			{portalElement && (
				<div
					className={cn("PageEditorPlainTextToolbar-scrollable-area" satisfies PageEditorPlainTextToolbar_ClassNames)}
				>
					<MyButton
						variant="ghost"
						className={cn("PageEditorPlainTextToolbar-button" satisfies PageEditorPlainTextToolbar_ClassNames)}
						disabled={isSaveDisabled}
						onClick={onClickSave}
					>
						<MyButtonIcon
							className={cn("PageEditorPlainTextToolbar-icon" satisfies PageEditorPlainTextToolbar_ClassNames)}
						>
							<Save />
						</MyButtonIcon>
						Save
					</MyButton>
					<MyButton
						variant="ghost"
						className={cn("PageEditorPlainTextToolbar-button" satisfies PageEditorPlainTextToolbar_ClassNames)}
						disabled={isSyncDisabled}
						onClick={onClickSync}
					>
						<MyButtonIcon
							className={cn("PageEditorPlainTextToolbar-icon" satisfies PageEditorPlainTextToolbar_ClassNames)}
						>
							<RefreshCcw />
						</MyButtonIcon>
						Sync
					</MyButton>
					<PageEditorSnapshotsModal
						pageId={pageId}
						sessionId={sessionId}
						getCurrentMarkdown={getCurrentMarkdown}
						onApplySnapshotMarkdown={onApplySnapshotMarkdown}
					/>
				</div>
			)}
		</div>
	);
}
// #endregion Toolbar

// #region CommentsSidebar
type PageEditorPlainTextCommentsSidebarThread_Props = {
	thread: human_thread_messages_Thread;
};

function PageEditorPlainTextCommentsSidebarThread(props: PageEditorPlainTextCommentsSidebarThread_Props) {
	const { thread } = props;

	const [isOpen, setIsOpen] = useState(false);

	const handleToggle: PageEditorCommentsThread_Props["onToggle"] = (e) => {
		setIsOpen(e.currentTarget.open);
	};

	return <PageEditorCommentsThread thread={thread} isOpen={isOpen} onToggle={handleToggle} />;
}

export type PageEditorPlainTextCommentsSidebar_ClassNames =
	| "PageEditorPlainTextCommentsSidebar"
	| "PageEditorPlainTextCommentsSidebar-header"
	| "PageEditorPlainTextCommentsSidebar-filter"
	| "PageEditorPlainTextCommentsSidebar-filter-mode"
	| "PageEditorPlainTextCommentsSidebar-filter-input"
	| "PageEditorPlainTextCommentsSidebar-list"
	| "PageEditorPlainTextCommentsSidebar-empty";

export type PageEditorPlainTextCommentsSidebar_Props = {
	threadIds: string[];
};

function PageEditorPlainTextCommentsSidebar(props: PageEditorPlainTextCommentsSidebar_Props) {
	const { threadIds } = props;

	const [filterMode, setFilterMode] = useState<"text" | "id">("text");
	const [filterValue, setFilterValue] = useState("");

	const threadsQuery = useStableQuery(
		app_convex_api.human_thread_messages.human_thread_messages_threads_list,
		threadIds.length > 0
			? {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					threadIds,
					isArchived: false,
				}
			: "skip",
	);

	const filteredThreads = useMemo(() => {
		const threads = threadsQuery?.threads ?? [];

		const sortedThreads = [...threads].sort((a, b) => b.last_message_at - a.last_message_at);

		const q = filterValue.trim().toLowerCase();
		if (!q) return sortedThreads;

		return sortedThreads.filter((thread) => {
			if (filterMode === "id") {
				return `${thread.id}`.toLowerCase().includes(q);
			}
			return thread.content.toLowerCase().includes(q);
		});
	}, [filterMode, filterValue, threadsQuery?.threads]);

	return (
		<aside className={"PageEditorPlainTextCommentsSidebar" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}>
			<div
				className={"PageEditorPlainTextCommentsSidebar-header" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}
			>
				<b>Comments</b> <small>({threadIds.length})</small>
			</div>

			<div
				className={"PageEditorPlainTextCommentsSidebar-filter" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}
			>
				<div
					className={
						"PageEditorPlainTextCommentsSidebar-filter-mode" satisfies PageEditorPlainTextCommentsSidebar_ClassNames
					}
				>
					<MyButton variant="ghost" aria-pressed={filterMode === "text"} onClick={() => setFilterMode("text")}>
						Text
					</MyButton>
					<MyButton variant="ghost" aria-pressed={filterMode === "id"} onClick={() => setFilterMode("id")}>
						ID
					</MyButton>
				</div>

				<input
					className={
						"PageEditorPlainTextCommentsSidebar-filter-input" satisfies PageEditorPlainTextCommentsSidebar_ClassNames
					}
					placeholder={filterMode === "id" ? "Search by thread id…" : "Search by first message…"}
					value={filterValue}
					onChange={(e) => setFilterValue(e.target.value)}
				/>
			</div>

			<div
				className={"PageEditorPlainTextCommentsSidebar-list" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}
			>
				{filteredThreads.length === 0 ? (
					<div
						className={
							"PageEditorPlainTextCommentsSidebar-empty" satisfies PageEditorPlainTextCommentsSidebar_ClassNames
						}
					>
						<i>No threads</i>
					</div>
				) : (
					filteredThreads.map((thread) => (
						<PageEditorPlainTextCommentsSidebarThread key={`${thread.id}`} thread={thread} />
					))
				)}
			</div>
		</aside>
	);
}
// #endregion CommentsSidebar

// #region Root
type PageEditorPlainText_ClassNames = "PageEditorPlainText" | "PageEditorPlainText-editor";

type PageEditorPlainText_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	initialData: PageEditorPlainText_InitialData;
	presenceStore: pages_PresenceStore;
	headerSlot: ReactNode;
};

function create_editor_model(markdown: string) {
	const model = monaco_editor.createModel(markdown, "markdown");
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}

function PageEditorPlainText_Inner(props: PageEditorPlainText_Inner_Props) {
	const { initialData, headerSlot, pageId, presenceStore } = props;

	const convex = useConvex();

	const pushYjsUpdateMutation = useMutation(api.ai_docs_temp.yjs_push_update);

	const serverSequenceData = useQuery(api.ai_docs_temp.get_page_last_yjs_sequence, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	const [initialEditorModel] = useState(() => create_editor_model(initialData.markdown));

	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	const baselineYjsDocRef = useRef<YDoc>(initialData.mut_yjsDoc);
	const workingYjsDocRef = useRef<YDoc>(pages_yjs_doc_clone({ yjsDoc: initialData.mut_yjsDoc }));

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");

	const [isDirtyRef, setIsDirty, isDirty] = useStateRef(false);
	const baselineAltVersionIdRef = useRef<number>(0);

	const [workingYjsDocSequence, setWorkingYjsSequence] = useState(initialData.yjsSequence);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const isSaveDisabled = isSaving || isSyncing || !isDirty;
	const serverSequence = serverSequenceData?.last_sequence;
	const serverSequenceRef = useLiveRef(serverSequence);
	const isSyncDisabled = isSyncing || isSaving || serverSequence == null || workingYjsDocSequence === serverSequence;

	function updateThreadIds(markdown: string) {
		const headlessEditor = pages_headless_tiptap_editor_create({ initialContent: { markdown } });
		debugger;
		const nextThreadIds = getThreadIdsFromEditorState(headlessEditor.state).toSorted();
		headlessEditor.destroy();

		const nextKey = nextThreadIds.join("\n");
		if (nextKey === commentThreadIdsKeyRef.current) {
			return;
		}
		commentThreadIdsKeyRef.current = nextKey;
		setCommentThreadIds(nextThreadIds);
	}

	function updateDirtyBaseline() {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorPlainText.updateDirtyBaseline] Missing editor ref", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const model = editorRef.current.getModel();

		if (!model) {
			const error = should_never_happen("[PageEditorPlainText.updateDirtyBaseline] Missing model", {
				editor: editorRef.current,
				model,
			});
			console.error(error);
			throw error;
		}

		baselineAltVersionIdRef.current = model.getAlternativeVersionId();
		setIsDirty(false);
	}

	function resetToNewBaseline(markdown: string) {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorPlainText.resetToNewBaseline] Missing editor ref", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const prevModel = editorRef.current.getModel();

		if (!prevModel) {
			const error = should_never_happen("[PageEditorPlainText.resetToNewBaseline] Missing prevModel", {
				editor: editorRef.current,
				prevModel: prevModel,
			});
			console.error(error);
			throw error;
		}

		const model = create_editor_model(markdown);
		editorRef.current.setModel(model);
		prevModel.dispose();
		updateDirtyBaseline();
		updateThreadIds(markdown);
		return model;
	}

	function pushChangeToEditor(newMarkdown: string) {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorPlainText.pushChangeToEditor] Missing editor ref", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const model = editorRef.current.getModel();

		if (!model) {
			const error = should_never_happen("[PageEditorPlainText.pushChangeToEditor] Missing model", {
				editor: editorRef.current,
				model,
			});
			console.error(error);
			throw error;
		}

		editorRef.current.pushUndoStop();
		editorRef.current.executeEdits("app_pages_sync", [
			{
				range: model.getFullModelRange(),
				text: newMarkdown,
			},
		]);
		editorRef.current.pushUndoStop();
		setIsDirty(true);
	}

	const getCurrentMarkdown = () => {
		return editorRef.current?.getModel()?.getValue() ?? initialData.markdown;
	};

	const handleApplySnapshotMarkdown = () => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const remoteData = await fetch_page_yjs_state_and_markdown(convex, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});

			resetToNewBaseline(remoteData.markdown);
			baselineYjsDocRef.current = remoteData.mut_yjsDoc;
			workingYjsDocRef.current = pages_yjs_doc_clone({ yjsDoc: remoteData.mut_yjsDoc });
			setWorkingYjsSequence(remoteData.yjsSequence);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	};

	const handleOnMount: EditorProps["onMount"] = (editor) => {
		editorRef.current = editor;
		updateDirtyBaseline();
		debugger;
		updateThreadIds(initialData.markdown);

		editor.onDidChangeModelContent(() => {
			const model = editor.getModel();
			if (!model) {
				const error = should_never_happen(
					"[PageEditorPlainText.handleOnMount editor.onDidChangeModelContent] Missing model",
					{
						editor,
						model,
					},
				);
				console.error(error);
				return;
			}

			const nextDirty = model.getAlternativeVersionId() !== baselineAltVersionIdRef.current;
			if (nextDirty === isDirtyRef.current) return;

			setIsDirty(nextDirty);
		});
	};

	const handleClickSave = () => {
		const editorModel = editorRef.current?.getModel();
		if (!editorModel) {
			const error = should_never_happen("[PageEditorPlainText.handleClickSave] Missing editorModel", {
				editor: editorRef.current,
				editorModel,
			});
			console.error(error);
			throw error;
		}

		if (isSaving || isSyncing || !isDirty) return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const baselineYjsDoc = baselineYjsDocRef.current;

			const workingMarkdown = editorModel.getValue();
			const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDoc });
			debugger;
			pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: workingMarkdown,
			});

			// Diff update from baseline to working.
			const diffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: workingYjsDoc,
				yjsBeforeDoc: baselineYjsDoc,
			});

			if (diffUpdate) {
				const result = await pushYjsUpdateMutation({
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
					update: pages_u8_to_array_buffer(diffUpdate),
					sessionId: presenceStore.localSessionId,
				});

				// Update baseline yjs doc
				applyUpdate(baselineYjsDoc, diffUpdate);

				// Only update `workingYjsDocSequence` if we're in sync with remote (no concurrent updates).
				// If the returned remote sequence is `workingYjsDocSequence` + 1, we can safely update
				// because it means no other updates happened between our save and the server response.
				// Otherwise, keep `workingYjsDocSequence` unchanged so the user knows he has to sync.
				if (result && result.newSequence === workingYjsDocSequence + 1) {
					setWorkingYjsSequence(result.newSequence);
				}
			}

			workingYjsDocRef.current = workingYjsDoc;
			updateDirtyBaseline();
			updateThreadIds(workingMarkdown);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText] Save failed", err);
				toast.error(err?.message ?? "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	};

	const handleClickSync = () => {
		if (isSyncing) return;

		const editor = editorRef.current?.getModel();
		const workingYjsDoc = workingYjsDocRef.current;

		if (!editor || !workingYjsDoc) {
			console.error(
				should_never_happen("[PageEditorPlainText.handleClickSync] Missing deps", {
					editor,
					workingYjsDoc,
					serverSequence: serverSequenceRef.current,
				}),
			);
			return;
		}

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const workingMarkdown = editor.getValue();
			pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: workingMarkdown,
			});

			const [snapshotDoc, updatesData] = await Promise.all([
				convex.query(api.ai_docs_temp.yjs_get_doc_last_snapshot, {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
				}),
				convex
					.query(api.ai_docs_temp.yjs_get_incremental_updates, {
						workspaceId: ai_chat_HARDCODED_ORG_ID,
						projectId: ai_chat_HARDCODED_PROJECT_ID,
						pageId,
					})
					.then((updatesData) => updatesData?.updates ?? []),
			]);

			if (!snapshotDoc) {
				console.error(
					should_never_happen("[PageEditorPlainText.handleClickSync] Missing snapshotDoc", {
						snapshotDoc,
					}),
				);
				return;
			}

			// By default the API returns updates in descending order; normalize to ascending and filter
			// to only include updates that are after the snapshot.
			const filteredIncrementalUpdates = updatesData.filter((u) => u.sequence > snapshotDoc.sequence).reverse();
			const remoteYjsDocSequence = filteredIncrementalUpdates.at(-1)?.sequence ?? snapshotDoc?.sequence;

			if (remoteYjsDocSequence == null) {
				console.error(
					should_never_happen("[PageEditorPlainText.handleClickSync] Missing serverSequence", {
						serverSequence: remoteYjsDocSequence,
					}),
				);
				return;
			}

			const remoteYjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshotDoc.snapshot_update, {
				additionalIncrementalArrayBufferUpdates: filteredIncrementalUpdates.map((u) => u.update),
			});

			const remoteMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: remoteYjsDoc });

			// Diff update from working to remote.
			const diffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: remoteYjsDoc,
				yjsBeforeDoc: workingYjsDoc,
			});

			if (diffUpdate) {
				applyUpdate(workingYjsDoc, diffUpdate);
			}
			const mergedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: workingYjsDoc });

			// Reset the Monaco model to a clean server baseline.
			resetToNewBaseline(remoteMarkdown);
			baselineYjsDocRef.current = remoteYjsDoc;

			// Apply the merged content as a single undoable edit so the user can at least undo back to the
			// new server baseline (v0) after a sync.
			// TODO: if we save the local edits as incremental updates we can let the user undo granularly.
			if (mergedMarkdown !== remoteMarkdown) {
				pushChangeToEditor(mergedMarkdown);
			}

			updateThreadIds(remoteMarkdown);
			setWorkingYjsSequence(remoteYjsDocSequence);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText] Sync failed", err);
			})
			.finally(() => {
				setIsSyncing(false);
			});
	};

	useEffect(() => {
		return () => {
			editorRef.current?.getModel()?.dispose();
		};
	}, []);

	return (
		<div className={"PageEditorPlainText" satisfies PageEditorPlainText_ClassNames}>
			{headerSlot}

			<PageEditorPlainTextToolbar
				isSaveDisabled={isSaveDisabled}
				isSyncDisabled={isSyncDisabled}
				pageId={pageId}
				sessionId={presenceStore.localSessionId}
				getCurrentMarkdown={getCurrentMarkdown}
				onApplySnapshotMarkdown={handleApplySnapshotMarkdown}
				onClickSave={handleClickSave}
				onClickSync={handleClickSync}
			/>

			<PanelGroup direction="horizontal" className={"PageEditorPlainText-panels-group"}>
				<Panel defaultSize={75} className={"PageEditorPlainText-editor-panel"}>
					<div className={"PageEditorPlainText-editor" satisfies PageEditorPlainText_ClassNames}>
						<Editor
							height="100%"
							language="markdown"
							theme={app_monaco_THEME_NAME_DARK}
							options={{
								wordWrap: "on",
								scrollBeyondLastLine: false,
								model: initialEditorModel,
							}}
							onMount={handleOnMount}
						/>
					</div>
				</Panel>
				<div className={"PageEditorPlainText-panel-resize-handle-container"}>
					<PanelResizeHandle className={"PageEditorPlainText-panel-resize-handle"} />
				</div>
				<Panel defaultSize={25} className={"PageEditorPlainText-comments-panel"}>
					<PageEditorPlainTextCommentsSidebar threadIds={commentThreadIds} />
				</Panel>
			</PanelGroup>
		</div>
	);
}

export type PageEditorPlainText_Props = {
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	headerSlot: ReactNode;
};

export function PageEditorPlainText(props: PageEditorPlainText_Props) {
	const { pageId, presenceStore, headerSlot } = props;

	const convex = useConvex();

	const pageContentData = fetch_page_yjs_state_and_markdown(convex, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	return (
		<CatchBoundary
			getResetKey={() => 0}
			errorComponent={PageEditorPlainTextError}
			onCatch={(err) => {
				console.error("PageEditorPlainText:", err);
			}}
		>
			<Suspense fallback={<>Loading</>}>
				<Await promise={pageContentData}>
					{(pageContentData) => (
						<PageEditorPlainText_Inner
							key={pageId}
							pageId={pageId}
							initialData={pageContentData}
							presenceStore={presenceStore}
							headerSlot={headerSlot}
						/>
					)}
				</Await>
			</Suspense>
		</CatchBoundary>
	);
}
// #endregion Root
