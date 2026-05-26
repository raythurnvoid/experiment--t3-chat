import "./file-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_u8_to_array_buffer,
	files_yjs_doc_clone,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_headless_tiptap_editor_create,
	files_monaco_create_editor_model,
	files_fetch_file_yjs_state_and_markdown,
} from "@/lib/files.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { editor as monaco_editor } from "monaco-editor";
import { useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { usePromiseValue } from "@/lib/async.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { RefreshCcw, Save } from "lucide-react";
import { Doc as YDoc, applyUpdate } from "yjs";
import { toast } from "sonner";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import { FileEditorPlainTextSkeleton } from "./file-editor-plain-text-skeleton.tsx";
import { FileEditorMonacoTopViewZone } from "../file-editor-monaco-top-view-zone.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";

// #region toolbar
type FileEditorPlainTextToolbarActions_ClassNames =
	| "FileEditorPlainTextToolbarActions"
	| "FileEditorPlainTextToolbarActions-button"
	| "FileEditorPlainTextToolbarActions-icon";

type FileEditorPlainTextToolbarActions_Props = {
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	isSaveDebouncing: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	toolbarPortalHost: HTMLElement;
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown: (markdown: string) => void;
	onClickSave: () => void;
	onClickSync: () => void;
};

const FileEditorPlainTextToolbarActions = memo(function FileEditorPlainTextToolbarActions(
	props: FileEditorPlainTextToolbarActions_Props,
) {
	const {
		isSaveDisabled,
		isSyncDisabled,
		isSaveDebouncing,
		nodeId,
		sessionId,
		toolbarPortalHost,
		getCurrentMarkdown,
		onApplySnapshotMarkdown,
		onClickSave,
		onClickSync,
	} = props;

	return createPortal(
		<div
			role="group"
			aria-label="Markdown editor actions"
			className={cn("FileEditorPlainTextToolbarActions" satisfies FileEditorPlainTextToolbarActions_ClassNames)}
		>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorPlainTextToolbarActions-button" satisfies FileEditorPlainTextToolbarActions_ClassNames,
				)}
				disabled={isSaveDisabled}
				aria-busy={isSaveDebouncing}
				onClick={onClickSave}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorPlainTextToolbarActions-icon" satisfies FileEditorPlainTextToolbarActions_ClassNames,
					)}
				>
					{isSaveDebouncing ? <MySpinner aria-label="Checking" /> : <Save />}
				</MyButtonIcon>
				Save
			</MyButton>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorPlainTextToolbarActions-button" satisfies FileEditorPlainTextToolbarActions_ClassNames,
				)}
				disabled={isSyncDisabled}
				onClick={onClickSync}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorPlainTextToolbarActions-icon" satisfies FileEditorPlainTextToolbarActions_ClassNames,
					)}
				>
					<RefreshCcw />
				</MyButtonIcon>
				Sync
			</MyButton>
			<FileEditorSnapshotsModal
				nodeId={nodeId}
				sessionId={sessionId}
				getCurrentMarkdown={getCurrentMarkdown}
				onApplySnapshotMarkdown={onApplySnapshotMarkdown}
			/>
		</div>,
		toolbarPortalHost,
	);
});
// #endregion toolbar

// #region top sticky floating container
type FileEditorPlainTextTopStickyFloatingContainer_ClassNames = "FileEditorPlainTextTopStickyFloatingContainer";

type FileEditorPlainTextTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

const FileEditorPlainTextTopStickyFloatingContainer = memo(function FileEditorPlainTextTopStickyFloatingContainer(
	props: FileEditorPlainTextTopStickyFloatingContainer_Props,
) {
	const { topStickyFloatingSlot } = props;

	return (
		<div
			className={cn(
				"FileEditorPlainTextTopStickyFloatingContainer" satisfies FileEditorPlainTextTopStickyFloatingContainer_ClassNames,
			)}
		>
			{topStickyFloatingSlot}
		</div>
	);
});
// #endregion top sticky floating container

// #region root
type FileEditorPlainText_ClassNames = "FileEditorPlainText" | "FileEditorPlainText-editor";

type FileEditorPlainTextInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	initialData: {
		markdown: string;
		mut_yjsDoc: YDoc;
		yjsSequence: number;
	};
	topSafeArea?: number;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	serverSequence?: number;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

const FileEditorPlainTextInner = memo(function FileEditorPlainTextInner(props: FileEditorPlainTextInner_Props) {
	const {
		initialData,
		nodeId,
		topSafeArea,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		serverSequence,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const pushYjsUpdateMutation = useMutation(api.files_nodes.yjs_push_update);

	const [initialEditorModel] = useState(() => files_monaco_create_editor_model(initialData.markdown));

	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	const [mountedEditor, setMountedEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
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
	const activeServerSequence = serverSequence ?? initialData.yjsSequence;
	const isSyncDisabled = isSyncing || isSaving || workingYjsDocSequence === activeServerSequence;
	const hasTopViewZoneSlot = topViewZoneSlot != null && topViewZoneSlot !== false;
	const editorTopPadding = Math.max(16, topSafeArea ?? 0);

	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	const editorOptions = ((/* iife */) => {
		return {
			overflowWidgetsDomNode: hoistingContainer ?? undefined,
			fixedOverflowWidgets: true,
			fontSize: 16,
			lineHeight: 22,
			wordWrap: "on",
			scrollBeyondLastLine: false,
			minimap: { enabled: false },

			// Force the scrollbar to always be visible otherwise the default
			// auto behaviour does not work well with the top view zone.
			scrollbar: { vertical: "visible" },

			padding: { top: hasTopViewZoneSlot ? 0 : editorTopPadding, bottom: 64 },
			model: initialEditorModel,
		} satisfies NonNullable<EditorProps["options"]>;
	})();

	const updateThreadIds = (markdown: string) => {
		const headlessEditor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (headlessEditor._nay) {
			console.error("[FileEditorPlainText.updateThreadIds] Error while creating headless editor", {
				nay: headlessEditor._nay,
			});
			return;
		}
		const nextThreadIds = getThreadIdsFromEditorState(headlessEditor._yay.state).toSorted();
		headlessEditor._yay.destroy();

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
				const error = should_never_happen("[FileEditorPlainText.scheduleDirtyCheck] Missing `model`", {
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
			const error = should_never_happen("[FileEditorPlainText.resetToNewBaseline] Missing editor ref", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const prevModel = modelRef.current;
		const model = files_monaco_create_editor_model(markdown);
		editorRef.current.setModel(model);
		modelRef.current = model;
		prevModel?.dispose();
		updateDirtyBaseline(markdown);
		updateThreadIds(markdown);
		return model;
	};

	const pushChangeToEditor = (newMarkdown: string) => {
		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorPlainText.pushChangeToEditor] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const model = modelRef.current;

		if (!model) {
			const error = should_never_happen("[FileEditorPlainText.pushChangeToEditor] `model`", {
				editor: editorRef.current,
				model,
			});
			console.error(error);
			throw error;
		}

		editorRef.current.pushUndoStop();
		editorRef.current.executeEdits("app_files_sync", [
			{
				range: model.getFullModelRange(),
				text: newMarkdown,
			},
		]);
		editorRef.current.pushUndoStop();
		setDirtyCheckState("dirty");
	};

	const getCurrentMarkdown = useFn(() => {
		return modelRef.current?.getValue() ?? initialData.markdown;
	});

	const handleApplySnapshotMarkdown = useFn(() => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const remoteData = await files_fetch_file_yjs_state_and_markdown({
				membershipId,
				nodeId,
			});

			if (!remoteData) {
				console.error(
					should_never_happen("[FileEditorPlainText.handleApplySnapshotMarkdown] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			if (remoteData.markdown._nay) {
				console.error("[FileEditorPlainText.handleApplySnapshotMarkdown] Error while fetching remote data", {
					nay: remoteData.markdown._nay,
				});
				return;
			}

			resetToNewBaseline(remoteData.markdown._yay);
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);
		})()
			.catch((err) => {
				console.error("[FileEditorPlainText] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	});

	const handleClickSave = useFn(() => {
		const editorModel = modelRef.current;
		if (!editorModel) {
			const error = should_never_happen("[FileEditorPlainText.handleClickSave] Missing editorModel", {
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

			const localMarkdown = editorModel.getValue();
			const workingYjsDoc = files_yjs_doc_clone({ yjsDoc: baselineYjsDoc });

			const workingYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: localMarkdown,
			});
			if (workingYjsDocFromMarkdown._nay) {
				console.error("[FileEditorPlainText.handleClickSave] Error while rebuilding Y.Doc from markdown", {
					nay: workingYjsDocFromMarkdown._nay,
				});
				return;
			}

			// Diff update from baseline to working.
			const diffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: workingYjsDoc,
				yjsBeforeDoc: baselineYjsDoc,
			});

			if (diffUpdate) {
				const result = await pushYjsUpdateMutation({
					membershipId,
					nodeId,
					update: files_u8_to_array_buffer(diffUpdate),
					sessionId: presenceStore.localSessionId,
				});

				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to save");
					return;
				}

				// Update baseline yjs doc
				applyUpdate(baselineYjsDoc, diffUpdate);

				// Only update `workingYjsDocSequence` if we're in sync with remote (no concurrent updates).
				// If the returned remote sequence is `workingYjsDocSequence` + 1, we can safely update
				// because it means no other updates happened between our save and the server response.
				// Otherwise, keep `workingYjsDocSequence` unchanged so the user knows he has to sync.
				const pushPayload = result._yay;
				if (
					pushPayload &&
					typeof pushPayload === "object" &&
					"newSequence" in pushPayload &&
					pushPayload.newSequence === workingYjsDocSequence + 1
				) {
					setWorkingYjsSequence(pushPayload.newSequence);
				}
			}

			updateDirtyBaseline(localMarkdown);
			updateThreadIds(localMarkdown);
		})()
			.catch((err) => {
				console.error("[FileEditorPlainText.handleClickSave] Save failed", err);
				toast.error(err?.message ?? "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	});

	const handleClickSync = useFn(() => {
		if (isSyncing || isSaving) return;

		setDirtyCheckState("checking");
		clearTimeout(dirtyCheckTimeoutRef.current);
		dirtyCheckTimeoutRef.current = undefined;

		const model = modelRef.current;

		if (!model) {
			console.error(
				should_never_happen("[FileEditorPlainText.handleClickSync] Missing `model`", {
					model,
				}),
			);
			return;
		}

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const localMarkdown = model.getValue();
			const workingYjsDoc = files_yjs_doc_clone({ yjsDoc: baselineYjsDocRef.current });
			const workingYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: localMarkdown,
			});
			if (workingYjsDocFromMarkdown._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while rebuilding Y.Doc from markdown", {
					nay: workingYjsDocFromMarkdown._nay,
				});
				return;
			}

			const remoteData = await files_fetch_file_yjs_state_and_markdown({
				membershipId,
				nodeId,
			});

			if (!remoteData) {
				console.error(
					should_never_happen("[FileEditorPlainText.handleClickSync] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			if (remoteData.markdown._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while fetching remote data", {
					nay: remoteData.markdown._nay,
				});
				return;
			}

			// Diff update from working to remote.
			const diffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: remoteData.yjsDoc,
				yjsBeforeDoc: workingYjsDoc,
			});

			if (diffUpdate) {
				applyUpdate(workingYjsDoc, diffUpdate);
			}
			const mergedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: workingYjsDoc });
			if (mergedMarkdown._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while getting merged markdown", {
					nay: mergedMarkdown._nay,
				});
				return;
			}

			// Reset the Monaco model to a clean server baseline.
			resetToNewBaseline(remoteData.markdown._yay);
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);

			// Apply the merged content as a single undoable edit so the user can at least undo back to the
			// new server baseline (v0) after a sync.
			// TODO: if we save the local edits as incremental updates we can let the user undo granularly.
			if (mergedMarkdown._yay !== remoteData.markdown._yay) {
				pushChangeToEditor(mergedMarkdown._yay);
			}

			updateThreadIds(remoteData.markdown._yay);
		})()
			.catch((err) => {
				console.error("[FileEditorPlainText.handleClickSync] Sync failed", err);
			})
			.finally(() => {
				setIsSyncing(false);
			});
	});

	const handleOnMount = useFn<EditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		setMountedEditor(editor);
		modelRef.current = initialEditorModel;
		updateDirtyBaseline(initialData.markdown);
		updateThreadIds(initialData.markdown);

		editor.onDidChangeModelContent(() => {
			scheduleDirtyCheck();
		});
	});

	useEffect(() => {
		return () => {
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;
			modelRef.current = null;
		};
	}, []);

	return (
		<>
			<div className={"FileEditorPlainText" satisfies FileEditorPlainText_ClassNames}>
				<FileEditorPlainTextToolbarActions
					isSaveDisabled={isSaveDisabled}
					isSyncDisabled={isSyncDisabled}
					isSaveDebouncing={isSaveDebouncing}
					nodeId={nodeId}
					sessionId={presenceStore.localSessionId}
					toolbarPortalHost={toolbarPortalHost}
					getCurrentMarkdown={getCurrentMarkdown}
					onApplySnapshotMarkdown={handleApplySnapshotMarkdown}
					onClickSave={handleClickSave}
					onClickSync={handleClickSync}
				/>
				<FileEditorPlainTextTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<div className={"FileEditorPlainText-editor" satisfies FileEditorPlainText_ClassNames}>
					{hoistingContainer && (
						<>
							<Editor
								height="100%"
								language="markdown"
								theme={app_monaco_THEME_NAME_DARK}
								options={editorOptions}
								onMount={handleOnMount}
							/>
							<FileEditorMonacoTopViewZone editor={mountedEditor} topViewZoneGap={editorTopPadding}>
								{topViewZoneSlot}
							</FileEditorMonacoTopViewZone>
						</>
					)}
				</div>
			</div>
			{commentsPortalHost &&
				createPortal(<FileEditorCommentsSidebar threadIds={commentThreadIds} />, commentsPortalHost)}
		</>
	);
});

export type FileEditorPlainText_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	serverSequence?: number;
	topSafeArea?: number;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

export const FileEditorPlainText = memo(function FileEditorPlainText(props: FileEditorPlainText_Props) {
	const {
		nodeId,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		serverSequence,
		topSafeArea,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const fileContentDataPromise = useMemo(() => {
		return files_fetch_file_yjs_state_and_markdown({
			membershipId,
			nodeId,
		});
	}, [membershipId, nodeId]);
	const fileContentData = usePromiseValue(fileContentDataPromise);

	if (fileContentData?.markdown._nay) {
		console.error("[FileEditorPlainText] Error while fetching file content data", fileContentData.markdown._nay);
	}

	return fileContentData === undefined ? (
		<FileEditorPlainTextSkeleton />
	) : (
		<FileEditorPlainTextInner
			key={nodeId}
			nodeId={nodeId}
			initialData={
				fileContentData?.markdown._yay
					? {
							markdown: fileContentData.markdown._yay,
							mut_yjsDoc: fileContentData.yjsDoc,
							yjsSequence: fileContentData.yjsSequence,
						}
					: { markdown: "", mut_yjsDoc: new YDoc(), yjsSequence: 0 }
			}
			topSafeArea={topSafeArea}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			serverSequence={serverSequence}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
});
// #endregion root
