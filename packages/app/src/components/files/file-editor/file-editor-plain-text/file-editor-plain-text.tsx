import "./file-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	files_u8_to_array_buffer,
	files_monaco_create_editor_model,
	files_fetch_file_yjs_state_and_markdown,
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
} from "@/lib/files.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../../../../../shared/files-yjs.ts";
import {
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_headless_tiptap_editor_create,
} from "../../../../../shared/files-tiptap.ts";
import {
	file_editor_get_size_badge_text,
	file_editor_get_size_error_message,
	file_editor_get_size_status_message,
} from "@/lib/file-editor.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { editor as monaco_editor, Range as monaco_Range } from "monaco-editor";
import { useMutation } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { usePromiseValue } from "@/lib/async.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { RefreshCcw, Save } from "lucide-react";
import { Doc as YDoc, applyUpdate } from "yjs";
import { toast } from "sonner";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { files_get_thread_ids_from_editor_state } from "../../../../../shared/files-tiptap-comments.ts";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import { FileEditorPlainTextSkeleton } from "./file-editor-plain-text-skeleton.tsx";
import { FileEditorMonacoTopViewZone } from "../file-editor-monaco-top-view-zone.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";

// #region toolbar
type FileEditorPlainTextToolbarActions_ClassNames =
	| "FileEditorPlainTextToolbarActions"
	| "FileEditorPlainTextToolbarActions-button"
	| "FileEditorPlainTextToolbarActions-icon"
	| "FileEditorPlainTextToolbarActions-size-badge";

type FileEditorPlainTextToolbarActions_Props = {
	byteSize: number;
	editable: boolean;
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
		byteSize,
		editable,
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

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return createPortal(
		<div
			role="group"
			aria-label="Markdown editor actions"
			className={cn("FileEditorPlainTextToolbarActions" satisfies FileEditorPlainTextToolbarActions_ClassNames)}
		>
			<MyButton
				variant="ghost-highlightable"
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
				variant="ghost-highlightable"
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
			{sizeBadge && (
				<MyBadge
					variant={sizeBadge.isOverCap ? "destructive" : "secondary"}
					className={cn(
						"FileEditorPlainTextToolbarActions-size-badge" satisfies FileEditorPlainTextToolbarActions_ClassNames,
					)}
				>
					{sizeBadge.label}
				</MyBadge>
			)}
			{/*
				The badge is silent, so without this a screen reader user only finds out the file
				is too big when Save is rejected.
				*/}
			<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{file_editor_get_size_status_message({ byteSize, blocks: "saving" })}
			</span>
			<FileEditorSnapshotsModal
				nodeId={nodeId}
				sessionId={sessionId}
				editable={editable}
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
function is_high_surrogate(codeUnit: number) {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function is_low_surrogate(codeUnit: number) {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Find the one stretch of text that differs between two versions.
 *
 * Monaco can then rewrite only that stretch instead of the whole document, so the cursor and the
 * undo history survive a write that the user did not type.
 */
function compute_minimal_text_edit(previousText: string, nextText: string) {
	if (previousText === nextText) {
		return null;
	}

	const shortestLength = Math.min(previousText.length, nextText.length);

	let prefixLength = 0;
	while (prefixLength < shortestLength && previousText[prefixLength] === nextText[prefixLength]) {
		prefixLength += 1;
	}

	// Stop the shared ending before it reaches the shared beginning, otherwise the two would
	// overlap and the replacement range would be inverted.
	let suffixLength = 0;
	while (
		suffixLength < shortestLength - prefixLength &&
		previousText[previousText.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	// A character outside the basic plane, such as an emoji, is stored as two code units. Never
	// cut between them: Monaco silently grows a range that starts or ends inside such a pair, so
	// the replacement text would no longer rebuild `nextText` and the user would lose characters.
	if (prefixLength > 0 && is_high_surrogate(previousText.charCodeAt(prefixLength - 1))) {
		prefixLength -= 1;
	}
	if (suffixLength > 0 && is_low_surrogate(previousText.charCodeAt(previousText.length - suffixLength))) {
		suffixLength -= 1;
	}

	return {
		startOffset: prefixLength,
		endOffset: previousText.length - suffixLength,
		text: nextText.slice(prefixLength, nextText.length - suffixLength),
	};
}

type FileEditorPlainText_ClassNames = "FileEditorPlainText" | "FileEditorPlainText-editor";

type FileEditorPlainTextInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
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
		editable,
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

	const [byteSize, setByteSize] = useState(() => files_get_utf8_byte_size(initialData.markdown));

	const isSaveDebouncing = dirtyCheckState === "checking";
	const isSaveDisabled = !editable || isSaving || isSyncing || dirtyCheckState !== "dirty";
	const activeServerSequence = serverSequence ?? initialData.yjsSequence;
	const isSyncDisabled = !editable || isSyncing || isSaving || workingYjsDocSequence === activeServerSequence;
	const hasTopViewZoneSlot = topViewZoneSlot != null && topViewZoneSlot !== false;
	const editorTopPadding = Math.max(16, topSafeArea ?? 0);

	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones
	// option updates and DOM references in these options are cyclic.
	const [editorOptions] = useState(() => {
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

			padding: { top: 0, bottom: 64 },
		} satisfies NonNullable<EditorProps["options"]>;
	});

	const updateThreadIds = (markdown: string) => {
		const headlessEditor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (headlessEditor._nay) {
			console.error("[FileEditorPlainText.updateThreadIds] Error while creating headless editor", {
				nay: headlessEditor._nay,
			});
			return;
		}
		const nextThreadIds = files_get_thread_ids_from_editor_state(headlessEditor._yay.state).toSorted();
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
		setByteSize(files_get_utf8_byte_size(newBaselineMarkdown));

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

			// This debounce already reads the full value for the dirty check, so measuring the
			// content size here is only the byte count on top.
			const localMarkdown = model.getValue();
			setByteSize(files_get_utf8_byte_size(localMarkdown));

			const isDirty = localMarkdown !== baselineMarkdownRef.current;
			setDirtyCheckState(isDirty ? "dirty" : "clean");
		}, 250);
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

		const edit = compute_minimal_text_edit(model.getValue(), newMarkdown);
		if (!edit) {
			return;
		}

		editorRef.current.pushUndoStop();
		editorRef.current.executeEdits("app_files_sync", [
			{
				range: monaco_Range.fromPositions(
					model.getPositionAt(edit.startOffset),
					model.getPositionAt(edit.endOffset),
				),
				text: edit.text,
			},
		]);
		editorRef.current.pushUndoStop();
	};

	const getCurrentMarkdown = useFn(() => {
		return modelRef.current?.getValue() ?? initialData.markdown;
	});

	const handleApplySnapshotMarkdown = useFn(() => {
		if (!editable) return;

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

			// Write into the current model instead of building a new one. A new model starts with an
			// empty undo stack, and `setModel` also rebuilds the editor view, which drops the top view
			// zone without re-adding it.
			pushChangeToEditor(remoteData.markdown._yay);
			updateDirtyBaseline(remoteData.markdown._yay);
			updateThreadIds(remoteData.markdown._yay);
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
		if (!editable) return;

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

			// Nothing is persisted until this point, so the cap is enforced here instead of on
			// paste. The content stays in the editor, so the user can trim it and save again.
			const localByteSize = files_get_utf8_byte_size(localMarkdown);
			if (localByteSize > files_MAX_TEXT_CONTENT_BYTES) {
				toast.error(file_editor_get_size_error_message(localByteSize));
				return;
			}

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
		if (!editable || isSyncing || isSaving) return;

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

			// Write the merged content into the model the user has been typing in. Only the part that
			// actually changed is rewritten, so everything the user did before the sync stays in the
			// undo stack and one Ctrl+Z undoes the sync alone.
			pushChangeToEditor(mergedMarkdown._yay);

			// The server content is the new baseline, even though the editor keeps the merged content.
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);
			updateDirtyBaseline(remoteData.markdown._yay);
			updateThreadIds(remoteData.markdown._yay);

			// `updateDirtyBaseline` measured the server content and marked the file clean. The editor
			// shows the merged content instead, so correct both when the merge kept local edits that
			// Save still has to push.
			if (mergedMarkdown._yay !== remoteData.markdown._yay) {
				setByteSize(files_get_utf8_byte_size(mergedMarkdown._yay));
				setDirtyCheckState("dirty");
			}
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
		editor.updateOptions({ readOnly: !editable });
		setMountedEditor(editor);
		const prevModel = editor.getModel();
		editor.setModel(initialEditorModel);
		prevModel?.dispose();
		modelRef.current = initialEditorModel;
		updateDirtyBaseline(initialData.markdown);
		updateThreadIds(initialData.markdown);

		editor.onDidChangeModelContent(() => {
			scheduleDirtyCheck();
		});
	});

	// The permission query can resolve or change after Monaco mounts. Update the live editor instead
	// of rebuilding its model, which would drop the cursor and undo history.
	useEffect(() => {
		mountedEditor?.updateOptions({ readOnly: !editable });
	}, [editable, mountedEditor]);

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
					byteSize={byteSize}
					editable={editable}
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
								{hasTopViewZoneSlot ? topViewZoneSlot : <div aria-hidden={true} />}
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
	editable: boolean;
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
		editable,
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
			editable={editable}
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

// #region tests
// The NODE_ENV check comes first so client builds erase this block; `import.meta.vitest` is
// only defined when vitest runs this file.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("compute_minimal_text_edit", () => {
		test("returns null when nothing changed", () => {
			expect(compute_minimal_text_edit("same text", "same text")).toBe(null);
		});

		test("replaces only the part between the shared start and the shared end", () => {
			expect(compute_minimal_text_edit("hello brave world", "hello cruel world")).toEqual({
				startOffset: 6,
				endOffset: 11,
				text: "cruel",
			});
		});

		test("reports an inserted line as an empty range", () => {
			// The shared start runs past the line break into `line t`, so the range is tighter than
			// the whole inserted line. Monaco only needs the replacement to rebuild the same text.
			expect(compute_minimal_text_edit("line one\nline three", "line one\nline two\nline three")).toEqual({
				startOffset: 15,
				endOffset: 15,
				text: "wo\nline t",
			});
		});

		test("reports a deleted line as empty replacement text", () => {
			expect(compute_minimal_text_edit("line one\nline two\nline three", "line one\nline three")).toEqual({
				startOffset: 15,
				endOffset: 24,
				text: "",
			});
		});

		test("keeps the range valid when the shared start and the shared end overlap", () => {
			// Both texts repeat `a`, so a naive shared-end scan would run past the shared start and
			// produce an inverted range.
			expect(compute_minimal_text_edit("aaa", "aaaaa")).toEqual({
				startOffset: 3,
				endOffset: 3,
				text: "aa",
			});
		});

		test("replaces everything when the two versions share nothing", () => {
			expect(compute_minimal_text_edit("old", "new")).toEqual({
				startOffset: 0,
				endOffset: 3,
				text: "new",
			});
		});

		test("handles an empty starting document", () => {
			expect(compute_minimal_text_edit("", "first line")).toEqual({
				startOffset: 0,
				endOffset: 0,
				text: "first line",
			});
		});

		test("never cuts an emoji in half", () => {
			// Both emoji start with the same code unit, so an unguarded scan would put the range
			// boundary between the two halves of one character.
			expect(compute_minimal_text_edit("😀😁\n", "😁\n")).toEqual({
				startOffset: 0,
				endOffset: 4,
				text: "😁",
			});
			expect(compute_minimal_text_edit("😀", "😁")).toEqual({
				startOffset: 0,
				endOffset: 2,
				text: "😁",
			});
		});

		test("applying the edit rebuilds the next version", () => {
			const cases: [string, string][] = [
				["# Welcome\nold body", "# Welcome\nnew body"],
				["one\ntwo\nthree", "one\nthree"],
				["one\nthree", "one\ntwo\nthree"],
				["aaa", "aaaaa"],
				["😀😁\n", "😁\n"],
				["😀", "😁"],
				["", "anything"],
				["anything", ""],
			];

			for (const [previousText, nextText] of cases) {
				const edit = compute_minimal_text_edit(previousText, nextText);
				const applied = edit
					? previousText.slice(0, edit.startOffset) + edit.text + previousText.slice(edit.endOffset)
					: previousText;
				expect(applied).toBe(nextText);
			}
		});
	});
}
// #endregion tests
