import "./page-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_update_from_markdown,
	pages_u8_to_array_buffer,
	pages_yjs_doc_clone,
	pages_yjs_compute_diff_update_from_yjs_doc,
} from "@/lib/pages.ts";
import React, { Suspense, useEffect, useRef, useState } from "react";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { editor as monaco_editor } from "monaco-editor";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvex, useQuery, type ConvexReactClient, useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChevronRight, RefreshCcw, Save } from "lucide-react";
import { MyIcon } from "@/components/my-icon.tsx";
import { Await } from "@/components/await.tsx";
import { Doc as YDoc, applyUpdate } from "yjs";
import { useLiveRef, useStateRef } from "../../../hooks/utils-hooks.ts";
import { toast } from "sonner";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";

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

// #region Root
type PageEditorPlainText_ClassNames = "PageEditorPlainText" | "PageEditorPlainText-editor";

type PageEditorPlainText_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	initialData: PageEditorPlainText_InitialData;
	presenceStore: pages_PresenceStore;
	headerSlot: React.ReactNode;
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

	const [isDirtyRef, setIsDirty, isDirty] = useStateRef(false);
	const baselineAltVersionIdRef = useRef<number>(0);

	const [workingYjsDocSequence, setWorkingYjsSequence] = useState(initialData.yjsSequence);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const isSaveDisabled = isSaving || isSyncing || !isDirty;
	const serverSequence = serverSequenceData?.last_sequence;
	const serverSequenceRef = useLiveRef(serverSequence);
	const isSyncDisabled = isSyncing || isSaving || serverSequence == null || workingYjsDocSequence === serverSequence;

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

	const handleOnMount: EditorProps["onMount"] = (editor, monaco) => {
		editorRef.current = editor;
		updateDirtyBaseline();

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
		</div>
	);
}

export type PageEditorPlainText_Props = {
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	headerSlot: React.ReactNode;
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
