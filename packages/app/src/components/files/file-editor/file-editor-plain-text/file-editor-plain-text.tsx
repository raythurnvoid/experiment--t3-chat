import "./file-editor-plain-text.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	files_u8_to_array_buffer,
	files_monaco_create_editor_model,
	files_monaco_execute_edits_with_read_only_fallback,
	files_fetch_file_yjs_state_and_text,
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	type files_YjsRootKind,
} from "@/lib/files.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../../../../../shared/files-yjs.ts";
import { files_text_diff_TOO_LARGE_MESSAGE } from "../../../../../shared/files-text-diff.ts";
import {
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
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
import { app_qa_register_monaco_editor } from "@/lib/app-qa.ts";
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
	getCurrentText: () => string;
	onApplySnapshotText: (text: string) => void;
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
		getCurrentText,
		onApplySnapshotText,
		onClickSave,
		onClickSync,
	} = props;

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return createPortal(
		<div
			role="group"
			aria-label="Text editor actions"
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
				getCurrentText={getCurrentText}
				onApplySnapshotText={onApplySnapshotText}
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

type FileEditorPlainText_ClassNames =
	| "FileEditorPlainText"
	| "FileEditorPlainText-editor"
	| "FileEditorPlainText-refusal";

type FileEditorPlainTextInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/** The node's document shape, resolved by the snapshot fetch; Save/Sync dispatch on it. */
	rootKind: files_YjsRootKind;
	/** The Monaco language id derived from the node name (`files_get_monaco_language_id`). */
	monacoLanguageId: string;
	initialData: {
		text: string;
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
		rootKind,
		monacoLanguageId,
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

	const [initialEditorModel] = useState(() => files_monaco_create_editor_model(initialData.text, monacoLanguageId));

	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	const [mountedEditor, setMountedEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
	const modelRef = useRef<monaco_editor.ITextModel | null>(initialEditorModel);
	const baselineYjsDocRef = useRef<YDoc>(initialData.mut_yjsDoc);
	const baselineMarkdownRef = useRef<string>(initialData.text);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");
	const qaMonacoCleanupRef = useRef<(() => void) | null>(null);

	const [dirtyCheckState, setDirtyCheckState] = useState<"clean" | "checking" | "dirty">("clean");
	const dirtyCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const [workingYjsDocSequence, setWorkingYjsSequence] = useState(initialData.yjsSequence);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const [byteSize, setByteSize] = useState(() => files_get_utf8_byte_size(initialData.text));

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
			// Screen readers hear which pane this is; the diff editor names its panes separately.
			ariaLabel: "File content editor",
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
		// Comment marks only exist in rich text documents, and the Comments tab is hidden for
		// plain text files, so skip the Markdown comment-mark scan entirely there.
		if (rootKind !== "rich_text") {
			return;
		}

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

		// The helper falls back to model-level edits when Monaco is read-only, so a sync or
		// restore that finishes after write permission was removed still updates the model
		// before the flow advances the Yjs baseline and working sequence below.
		files_monaco_execute_edits_with_read_only_fallback({
			editor: editorRef.current,
			model,
			edits: [
				{
					range: monaco_Range.fromPositions(model.getPositionAt(edit.startOffset), model.getPositionAt(edit.endOffset)),
					text: edit.text,
				},
			],
		});
	};

	const getCurrentText = useFn(() => {
		return modelRef.current?.getValue() ?? initialData.text;
	});

	// No `editable` guard here on purpose: this runs only after the backend already committed the
	// restore, so skipping the refresh when permission was removed mid-restore would leave the
	// editor showing stale content. The pre-action gate lives in the snapshots modal.
	const handleApplySnapshotText = useFn(() => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const remoteData = await files_fetch_file_yjs_state_and_text({
				membershipId,
				nodeId,
			});

			if (!remoteData) {
				console.error(
					should_never_happen("[FileEditorPlainText.handleApplySnapshotText] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			// Surface the refusal: a silent return would leave the editor showing content
			// the restore already replaced on the server.
			if (remoteData.text._nay) {
				console.error("[FileEditorPlainText.handleApplySnapshotText] Error while fetching remote data", {
					nay: remoteData.text._nay,
				});
				toast.error("Failed to refresh the editor after the restore. Reload the file.");
				return;
			}

			// Write into the current model instead of building a new one. A new model starts with an
			// empty undo stack, and `setModel` also rebuilds the editor view, which drops the top view
			// zone without re-adding it.
			pushChangeToEditor(remoteData.text._yay);
			updateDirtyBaseline(remoteData.text._yay);
			updateThreadIds(remoteData.text._yay);
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

			const workingYjsDocFromText = files_yjs_doc_update_from_text({
				mut_yjsDoc: workingYjsDoc,
				text: localMarkdown,
				rootKind,
			});
			// Surface the refusal: a silent return would leave Save looking like a no-op
			// while the buffer keeps content that will never persist. The diff module defines its
			// budget message as user-facing, so show it verbatim; other setter refusals keep the
			// generic message.
			if (workingYjsDocFromText._nay) {
				console.error("[FileEditorPlainText.handleClickSave] Error while rebuilding Y.Doc from the buffer", {
					nay: workingYjsDocFromText._nay,
				});
				toast.error(
					workingYjsDocFromText._nay.message === files_text_diff_TOO_LARGE_MESSAGE
						? files_text_diff_TOO_LARGE_MESSAGE
						: "Failed to save: the file content cannot be applied safely",
				);
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
			const workingYjsDocFromText = files_yjs_doc_update_from_text({
				mut_yjsDoc: workingYjsDoc,
				text: localMarkdown,
				rootKind,
			});
			// A setter refusal means the local buffer cannot be represented: tell the user instead
			// of silently aborting the Sync before its fetch. The diff module defines its
			// budget message as user-facing, so show it verbatim; other setter refusals keep the
			// generic message.
			if (workingYjsDocFromText._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while rebuilding Y.Doc from the buffer", {
					nay: workingYjsDocFromText._nay,
				});
				toast.error(
					workingYjsDocFromText._nay.message === files_text_diff_TOO_LARGE_MESSAGE
						? files_text_diff_TOO_LARGE_MESSAGE
						: "Failed to sync: the editor content cannot be applied safely",
				);
				return;
			}

			const remoteData = await files_fetch_file_yjs_state_and_text({
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

			// A remote read refusal means the remote state is unreadable: Sync must visibly not run
			// rather than appear to have run.
			if (remoteData.text._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while fetching remote data", {
					nay: remoteData.text._nay,
				});
				toast.error("Failed to sync: the file content cannot be read safely");
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
			const mergedText = files_yjs_doc_get_text({ yjsDoc: workingYjsDoc, rootKind });
			if (mergedText._nay) {
				console.error("[FileEditorPlainText.handleClickSync] Error while getting the merged text", {
					nay: mergedText._nay,
				});
				toast.error("Failed to sync: the merged content cannot be read safely");
				return;
			}

			// Write the merged content into the model the user has been typing in. Only the part that
			// actually changed is rewritten, so everything the user did before the sync stays in the
			// undo stack and one Ctrl+Z undoes the sync alone.
			pushChangeToEditor(mergedText._yay);

			// The server content is the new baseline, even though the editor keeps the merged content.
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);
			updateDirtyBaseline(remoteData.text._yay);
			updateThreadIds(remoteData.text._yay);

			// `updateDirtyBaseline` measured the server content and marked the file clean. The editor
			// shows the merged content instead, so correct both when the merge kept local edits that
			// Save still has to push.
			if (mergedText._yay !== remoteData.text._yay) {
				setByteSize(files_get_utf8_byte_size(mergedText._yay));
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
		updateDirtyBaseline(initialData.text);
		updateThreadIds(initialData.text);
		qaMonacoCleanupRef.current?.();
		qaMonacoCleanupRef.current = app_qa_register_monaco_editor("plainText", editor);

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
			qaMonacoCleanupRef.current?.();
			qaMonacoCleanupRef.current = null;
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
					getCurrentText={getCurrentText}
					onApplySnapshotText={handleApplySnapshotText}
					onClickSave={handleClickSave}
					onClickSync={handleClickSync}
				/>
				<FileEditorPlainTextTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<div className={"FileEditorPlainText-editor" satisfies FileEditorPlainText_ClassNames}>
					{hoistingContainer && (
						<>
							<Editor
								height="100%"
								language={monacoLanguageId}
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
				createPortal(
					<FileEditorCommentsSidebar threadIds={commentThreadIds} canResolve={editable} />,
					commentsPortalHost,
				)}
		</>
	);
});

export type FileEditorPlainText_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/** The Monaco language id derived from the node name (`files_get_monaco_language_id`). */
	monacoLanguageId: string;
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
		monacoLanguageId,
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
		return files_fetch_file_yjs_state_and_text({
			membershipId,
			nodeId,
		});
	}, [membershipId, nodeId]);
	const fileContentData = usePromiseValue(fileContentDataPromise);

	if (fileContentData?.text._nay) {
		console.error("[FileEditorPlainText] Error while fetching file content data", fileContentData.text._nay);
	}

	// On a refused or missing read, do not mount the editor over a stand-in document.
	// a fabricated empty baseline is legal in shape, so every later Save would diff the user's
	// typing against emptiness and push it into the real document's log. The refusal state is the
	// only place this corruption can be stopped. A legitimate `_yay: ""` is NOT a refusal — an
	// empty file mounts with its real document and server sequence.
	return fileContentData === undefined ? (
		<FileEditorPlainTextSkeleton />
	) : fileContentData === null || fileContentData.text._nay ? (
		<div className={"FileEditorPlainText" satisfies FileEditorPlainText_ClassNames}>
			<div role="alert" className={"FileEditorPlainText-refusal" satisfies FileEditorPlainText_ClassNames}>
				This file's content could not be read safely, so the editor stays closed to protect it. Reload the file or
				contact support if this keeps happening.
			</div>
		</div>
	) : (
		<FileEditorPlainTextInner
			key={nodeId}
			nodeId={nodeId}
			editable={editable}
			rootKind={fileContentData.yjsRootKind}
			monacoLanguageId={monacoLanguageId}
			initialData={{
				text: fileContentData.text._yay,
				mut_yjsDoc: fileContentData.yjsDoc,
				yjsSequence: fileContentData.yjsSequence,
			}}
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
