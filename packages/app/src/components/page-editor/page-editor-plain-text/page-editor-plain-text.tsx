import "./page-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
	pages_u8_to_array_buffer,
	pages_yjs_doc_clone,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_headless_tiptap_editor_create,
	pages_monaco_create_editor_model,
	pages_fetch_page_yjs_state_and_markdown,
} from "@/lib/pages.ts";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { editor as monaco_editor } from "monaco-editor";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { cn, should_never_happen, type AppElementId } from "@/lib/utils.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/ui/my-spinner.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { RefreshCcw, Save } from "lucide-react";
import { Await } from "@/components/await.tsx";
import { Doc as YDoc, applyUpdate } from "yjs";
import { toast } from "sonner";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { PageEditorCommentsSidebar } from "../page-editor-comments-sidebar.tsx";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import type { AppDomId } from "@/lib/app-dom-id.ts";

// #region toolbar
export type PageEditorPlainTextToolbar_ClassNames =
	| "PageEditorPlainTextToolbar"
	| "PageEditorPlainTextToolbar-scrollable-area"
	| "PageEditorPlainTextToolbar-button"
	| "PageEditorPlainTextToolbar-icon";

export type PageEditorPlainTextToolbar_Props = {
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	isSaveDebouncing: boolean;
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
		isSaveDebouncing,
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
						aria-busy={isSaveDebouncing}
						onClick={onClickSave}
					>
						<MyButtonIcon
							className={cn("PageEditorPlainTextToolbar-icon" satisfies PageEditorPlainTextToolbar_ClassNames)}
						>
							{isSaveDebouncing ? <MySpinner aria-label="Checking" /> : <Save />}
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
// #endregion toolbar

// #region sidebar
export type PageEditorPlainTextSidebar_ClassNames =
	| "PageEditorPlainTextSidebar"
	| "PageEditorPlainTextSidebar-background"
	| "PageEditorPlainTextSidebar-toolbar"
	| "PageEditorPlainTextSidebar-toolbar-scrollable-area"
	| "PageEditorPlainTextSidebar-tabs-list"
	| "PageEditorPlainTextSidebar-tabs-panels"
	| "PageEditorPlainTextSidebar-panel"
	| "PageEditorPlainTextSidebar-agent";

export type PageEditorPlainTextSidebar_Props = {
	threadIds: string[];
};

function PageEditorPlainTextSidebar(props: PageEditorPlainTextSidebar_Props) {
	const { threadIds } = props;

	return (
		<>
			<div
				className={cn("PageEditorPlainTextSidebar-background" satisfies PageEditorPlainTextSidebar_ClassNames)}
			></div>
			<MyTabs defaultSelectedId={"app_page_editor_sidebar_tabs_comments" satisfies AppDomId}>
				<div className={cn("PageEditorPlainTextSidebar-toolbar" satisfies PageEditorPlainTextSidebar_ClassNames)}>
					<div
						className={cn(
							"PageEditorPlainTextSidebar-toolbar-scrollable-area" satisfies PageEditorPlainTextSidebar_ClassNames,
						)}
					>
						<MyTabsList
							className={cn("PageEditorPlainTextSidebar-tabs-list" satisfies PageEditorPlainTextSidebar_ClassNames)}
							aria-label="Sidebar tabs"
						>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_comments" satisfies AppDomId}>Comments</MyTabsTab>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_agent" satisfies AppDomId}>Agent</MyTabsTab>
						</MyTabsList>
					</div>
				</div>
				<MyTabsPanels
					className={cn("PageEditorPlainTextSidebar-tabs-panels" satisfies PageEditorPlainTextSidebar_ClassNames)}
				>
					<MyTabsPanel
						className={cn("PageEditorPlainTextSidebar-panel" satisfies PageEditorPlainTextSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_comments" satisfies AppDomId}
					>
						<PageEditorCommentsSidebar threadIds={threadIds} />
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("PageEditorPlainTextSidebar-panel" satisfies PageEditorPlainTextSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_agent" satisfies AppDomId}
					>
						<div className={cn("PageEditorPlainTextSidebar-agent" satisfies PageEditorPlainTextSidebar_ClassNames)}>
							Agent tools will appear here.
						</div>
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
}
// #endregion sidebar

// #region root
type PageEditorPlainText_ClassNames =
	| "PageEditorPlainText"
	| "PageEditorPlainText-editor"
	| "PageEditorPlainText-panels-group"
	| "PageEditorPlainText-editor-panel"
	| "PageEditorPlainText-panel-resize-handle-container"
	| "PageEditorPlainText-panel-resize-handle";

type PageEditorPlainText_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	initialData: {
		markdown: string;
		mut_yjsDoc: YDoc;
		yjsSequence: number;
	};
	presenceStore: pages_PresenceStore;
	headerSlot: ReactNode;
};

function PageEditorPlainText_Inner(props: PageEditorPlainText_Inner_Props) {
	const { initialData, headerSlot, pageId, presenceStore } = props;

	const pushYjsUpdateMutation = useMutation(api.ai_docs_temp.yjs_push_update);

	const serverSequenceData = useQuery(api.ai_docs_temp.get_page_last_yjs_sequence, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	const [initialEditorModel] = useState(() => pages_monaco_create_editor_model(initialData.markdown));

	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	const modelRef = useRef<monaco_editor.ITextModel | null>(initialEditorModel);
	const baselineYjsDocRef = useRef<YDoc>(initialData.mut_yjsDoc);
	const baselineMarkdownRef = useRef<string>(initialData.markdown);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");

	const [dirtyCheckState, setDirtyCheckState] = useState<"clean" | "checking" | "dirty">("clean");
	const dirtyCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const [workingYjsDocSequence, setWorkingYjsSequence] = useState(initialData.yjsSequence);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const isSaveDebouncing = dirtyCheckState === "checking";
	const isSaveDisabled = isSaving || isSyncing || dirtyCheckState !== "dirty";
	const serverSequence = serverSequenceData?.last_sequence;
	const isSyncDisabled = isSyncing || isSaving || serverSequence == null || workingYjsDocSequence === serverSequence;

	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);

	const updateThreadIds = (markdown: string) => {
		const headlessEditor = pages_headless_tiptap_editor_create({ initialContent: { markdown } });
		const nextThreadIds = getThreadIdsFromEditorState(headlessEditor.state).toSorted();
		headlessEditor.destroy();

		const nextKey = nextThreadIds.join("\n");
		if (nextKey === commentThreadIdsKeyRef.current) {
			return;
		}
		commentThreadIdsKeyRef.current = nextKey;
		setCommentThreadIds(nextThreadIds);
	};

	const updateDirtyBaseline = (newBaselineMarkdown: string) => {
		baselineMarkdownRef.current = newBaselineMarkdown;

		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;
		}
		setDirtyCheckState("clean");
	};

	const scheduleDirtyCheck = () => {
		if (!editorRef.current) return;

		setDirtyCheckState("checking");

		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
		}

		dirtyCheckTimeoutRef.current = setTimeout(() => {
			dirtyCheckTimeoutRef.current = undefined;

			const model = modelRef.current;
			if (!model) {
				const error = should_never_happen("[PageEditorPlainText.scheduleDirtyCheck] Missing `model`", {
					editor: editorRef.current,
					model,
				});
				console.error(error);
				return;
			}

			const isDirty = model.getValue() !== baselineMarkdownRef.current;
			setDirtyCheckState(isDirty ? "dirty" : "clean");
		}, 250);
	};

	const resetToNewBaseline = (markdown: string) => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorPlainText.resetToNewBaseline] Missing editor ref", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const prevModel = modelRef.current;
		const model = pages_monaco_create_editor_model(markdown);
		editorRef.current.setModel(model);
		modelRef.current = model;
		prevModel?.dispose();
		updateDirtyBaseline(markdown);
		updateThreadIds(markdown);
		return model;
	};

	const pushChangeToEditor = (newMarkdown: string) => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorPlainText.pushChangeToEditor] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const model = modelRef.current;

		if (!model) {
			const error = should_never_happen("[PageEditorPlainText.pushChangeToEditor] `model`", {
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
		setDirtyCheckState("dirty");
	};

	const getCurrentMarkdown = () => {
		return modelRef.current?.getValue() ?? initialData.markdown;
	};

	const handleApplySnapshotMarkdown = () => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const remoteData = await pages_fetch_page_yjs_state_and_markdown({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});

			if (!remoteData) {
				console.error(
					should_never_happen("[PageEditorPlainText.handleApplySnapshotMarkdown] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			resetToNewBaseline(remoteData.markdown);
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	};

	const handleClickSave = () => {
		const editorModel = modelRef.current;
		if (!editorModel) {
			const error = should_never_happen("[PageEditorPlainText.handleClickSave] Missing editorModel", {
				editor: editorRef.current,
				editorModel,
			});
			console.error(error);
			throw error;
		}

		if (isSaving || isSyncing || dirtyCheckState !== "dirty") return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const baselineYjsDoc = baselineYjsDocRef.current;

			const workingMarkdown = editorModel.getValue();
			const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDoc });

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

			updateDirtyBaseline(workingMarkdown);
			updateThreadIds(workingMarkdown);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText.handleClickSave] Save failed", err);
				toast.error(err?.message ?? "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	};

	const handleClickSync = () => {
		if (isSyncing || isSaving) return;

		setDirtyCheckState("checking");
		clearTimeout(dirtyCheckTimeoutRef.current);
		dirtyCheckTimeoutRef.current = undefined;

		const model = modelRef.current;

		if (!model) {
			console.error(
				should_never_happen("[PageEditorPlainText.handleClickSync] Missing `model`", {
					model,
				}),
			);
			return;
		}

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const workingMarkdown = model.getValue();
			const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDocRef.current });
			pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: workingMarkdown,
			});

			const remoteData = await pages_fetch_page_yjs_state_and_markdown({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});

			if (!remoteData) {
				console.error(
					should_never_happen("[PageEditorPlainText.handleClickSync] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			// Diff update from working to remote.
			const diffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: remoteData.yjsDoc,
				yjsBeforeDoc: workingYjsDoc,
			});

			if (diffUpdate) {
				applyUpdate(workingYjsDoc, diffUpdate);
			}
			const mergedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: workingYjsDoc });

			// Reset the Monaco model to a clean server baseline.
			resetToNewBaseline(remoteData.markdown);
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);

			// Apply the merged content as a single undoable edit so the user can at least undo back to the
			// new server baseline (v0) after a sync.
			// TODO: if we save the local edits as incremental updates we can let the user undo granularly.
			if (mergedMarkdown !== remoteData.markdown) {
				pushChangeToEditor(mergedMarkdown);
			}

			updateThreadIds(remoteData.markdown);
		})()
			.catch((err) => {
				console.error("[PageEditorPlainText.handleClickSync] Sync failed", err);
			})
			.finally(() => {
				setIsSyncing(false);
			});
	};

	const handleOnMount: EditorProps["onMount"] = (editor) => {
		editorRef.current = editor;
		modelRef.current = initialEditorModel;
		updateDirtyBaseline(initialData.markdown);
		updateThreadIds(initialData.markdown);

		editor.onDidChangeModelContent(() => {
			scheduleDirtyCheck();
		});
	};

	useEffect(() => {
		return () => {
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;
			modelRef.current = null;
		};
	}, []);

	return (
		<div className={"PageEditorPlainText" satisfies PageEditorPlainText_ClassNames}>
			{headerSlot}

			<PanelGroup
				direction="horizontal"
				className={"PageEditorPlainText-panels-group" satisfies PageEditorPlainText_ClassNames}
			>
				<Panel defaultSize={75} className={"PageEditorPlainText-editor-panel" satisfies PageEditorPlainText_ClassNames}>
					<PageEditorPlainTextToolbar
						isSaveDisabled={isSaveDisabled}
						isSyncDisabled={isSyncDisabled}
						isSaveDebouncing={isSaveDebouncing}
						pageId={pageId}
						sessionId={presenceStore.localSessionId}
						getCurrentMarkdown={getCurrentMarkdown}
						onApplySnapshotMarkdown={handleApplySnapshotMarkdown}
						onClickSave={handleClickSave}
						onClickSync={handleClickSync}
					/>
					<div className={"PageEditorPlainText-editor" satisfies PageEditorPlainText_ClassNames}>
						{hoistingContainer && (
							<Editor
								height="100%"
								language="markdown"
								theme={app_monaco_THEME_NAME_DARK}
								options={{
									overflowWidgetsDomNode: hoistingContainer,
									fixedOverflowWidgets: true,
									wordWrap: "on",
									scrollBeyondLastLine: false,
									model: initialEditorModel,
								}}
								onMount={handleOnMount}
							/>
						)}
					</div>
				</Panel>
				<div className={"PageEditorPlainText-panel-resize-handle-container" satisfies PageEditorPlainText_ClassNames}>
					<PanelResizeHandle
						className={"PageEditorPlainText-panel-resize-handle" satisfies PageEditorPlainText_ClassNames}
					/>
				</div>
				<Panel
					defaultSize={25}
					className={cn("PageEditorPlainTextSidebar" satisfies PageEditorPlainTextSidebar_ClassNames)}
				>
					<PageEditorPlainTextSidebar threadIds={commentThreadIds} />
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

	const pageContentData = pages_fetch_page_yjs_state_and_markdown({
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	return (
		<Suspense fallback={<>Loading</>}>
			<Await promise={pageContentData}>
				{(pageContentData) => (
					<PageEditorPlainText_Inner
						key={pageId}
						pageId={pageId}
						initialData={
							pageContentData
								? {
										markdown: pageContentData.markdown,
										mut_yjsDoc: pageContentData.yjsDoc,
										yjsSequence: pageContentData.yjsSequence,
									}
								: { markdown: "", mut_yjsDoc: new YDoc(), yjsSequence: 0 }
						}
						presenceStore={presenceStore}
						headerSlot={headerSlot}
					/>
				)}
			</Await>
		</Suspense>
	);
}
// #endregion root
