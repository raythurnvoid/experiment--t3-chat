import "./file-editor-diff-non-collab.css";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_get_comment_thread_ids_from_markdown,
	files_monaco_create_editor_model,
	files_monaco_execute_edits_with_read_only_fallback,
	type files_YjsRootKind,
} from "@/lib/files.ts";
import {
	file_editor_get_size_badge_text,
	file_editor_get_size_error_message,
	file_editor_get_size_status_message,
	file_editor_warn_unsaved_text_dropped,
} from "@/lib/file-editor.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { editor as monaco_editor } from "monaco-editor";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { usePromiseValue } from "@/lib/async.ts";
import { app_qa_register_monaco_editor } from "@/lib/app-qa.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import { FileEditorDiffSkeleton } from "./file-editor-diff-skeleton.tsx";
import { FileEditorMonacoTopViewZone } from "../file-editor-monaco-top-view-zone.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";

// #region toolbar
type FileEditorDiffNonCollabToolbarActions_ClassNames =
	| "FileEditorDiffNonCollabToolbarActions"
	| "FileEditorDiffNonCollabToolbarActions-button"
	| "FileEditorDiffNonCollabToolbarActions-button-discard-all"
	| "FileEditorDiffNonCollabToolbarActions-icon"
	| "FileEditorDiffNonCollabToolbarActions-size-badge";

type FileEditorDiffNonCollabToolbarActions_Props = {
	byteSize: number;
	editable: boolean;
	isSaveDisabled: boolean;
	isSaveDebouncing: boolean;
	isDiscardAllDisabled: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	/**
	 * The asset the open text was read from; a version restore goes through the replace door.
	 */
	nonCollaborativeBaseAssetId: app_convex_Id<"files_r2_assets">;
	sessionId: string;
	toolbarPortalHost: HTMLElement;
	getCurrentText: () => string;
	onApplySnapshotText: (text: string) => void;
	onClickSave: () => void;
	onClickDiscardAll: () => void;
};

const FileEditorDiffNonCollabToolbarActions = memo(function FileEditorDiffNonCollabToolbarActions(
	props: FileEditorDiffNonCollabToolbarActions_Props,
) {
	const {
		byteSize,
		editable,
		isSaveDisabled,
		isSaveDebouncing,
		isDiscardAllDisabled,
		nodeId,
		nonCollaborativeBaseAssetId,
		sessionId,
		toolbarPortalHost,
		getCurrentText,
		onApplySnapshotText,
		onClickSave,
		onClickDiscardAll,
	} = props;

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return createPortal(
		<div
			role="group"
			aria-label="Diff editor actions"
			className={cn("FileEditorDiffNonCollabToolbarActions" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames)}
		>
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorDiffNonCollabToolbarActions-button" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
				)}
				disabled={isSaveDisabled}
				aria-busy={isSaveDebouncing}
				onClick={onClickSave}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorDiffNonCollabToolbarActions-icon" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
					)}
				>
					{isSaveDebouncing ? <MySpinner aria-label="Checking" /> : <Save />}
				</MyButtonIcon>
				Save
			</MyButton>
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorDiffNonCollabToolbarActions-button" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
					"FileEditorDiffNonCollabToolbarActions-button-discard-all" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
				)}
				aria-label="Discard all changes in this file"
				disabled={isDiscardAllDisabled}
				onClick={onClickDiscardAll}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorDiffNonCollabToolbarActions-icon" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
					)}
				>
					<Trash2 />
				</MyButtonIcon>
				Discard all
			</MyButton>
			{sizeBadge && (
				<MyBadge
					variant={sizeBadge.isOverCap ? "destructive" : "secondary"}
					className={cn(
						"FileEditorDiffNonCollabToolbarActions-size-badge" satisfies FileEditorDiffNonCollabToolbarActions_ClassNames,
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
				nonCollaborativeBaseAssetId={nonCollaborativeBaseAssetId}
				getCurrentText={getCurrentText}
				onApplySnapshotText={onApplySnapshotText}
			/>
		</div>,
		toolbarPortalHost,
	);
});
// #endregion toolbar

// #region top sticky floating container
type FileEditorDiffNonCollabTopStickyFloatingContainer_ClassNames = "FileEditorDiffNonCollabTopStickyFloatingContainer";

type FileEditorDiffNonCollabTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

const FileEditorDiffNonCollabTopStickyFloatingContainer = memo(
	function FileEditorDiffNonCollabTopStickyFloatingContainer(
		props: FileEditorDiffNonCollabTopStickyFloatingContainer_Props,
	) {
		const { topStickyFloatingSlot } = props;

		return (
			<div
				className={cn(
					"FileEditorDiffNonCollabTopStickyFloatingContainer" satisfies FileEditorDiffNonCollabTopStickyFloatingContainer_ClassNames,
				)}
			>
				{topStickyFloatingSlot}
			</div>
		);
	},
);
// #endregion top sticky floating container

// #region root
type FileEditorDiffNonCollab_ClassNames =
	| "FileEditorDiffNonCollab"
	| "FileEditorDiffNonCollab-editor"
	| "FileEditorDiffNonCollab-refusal";

/**
 * What the loader read before the editor mounted: the committed text, the document shape, and the
 * asset the text was read from. Save replaces the whole text against that asset.
 */
type FileEditorDiffNonCollab_LoadedContent = {
	text: string;
	rootKind: files_YjsRootKind;
	baseAssetId: app_convex_Id<"files_r2_assets">;
};

type FileEditorDiffNonCollabInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/**
	 * The Monaco language id derived from the node name (`files_get_monaco_language_id`).
	 */
	monacoLanguageId: string;
	initialData: FileEditorDiffNonCollab_LoadedContent;
	topSafeArea?: number;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

const FileEditorDiffNonCollabInner = memo(function FileEditorDiffNonCollabInner(
	props: FileEditorDiffNonCollabInner_Props,
) {
	const {
		initialData,
		nodeId,
		editable,
		monacoLanguageId,
		topSafeArea,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const editorRef = useRef<monaco_editor.IStandaloneDiffEditor | null>(null);
	const [mountedModifiedEditor, setMountedModifiedEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
	const editorModelsRef = useRef<{
		original: monaco_editor.ITextModel;
		modified: monaco_editor.ITextModel;
	} | null>(null);

	// The original pane holds the committed text and a successful save rewrites it, so the next
	// save has to be based on the asset that save produced.
	const [nonCollaborativeBaseAssetId, setNonCollaborativeBaseAssetId] = useState(initialData.baseAssetId);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");
	const qaMonacoCleanupRef = useRef<(() => void) | null>(null);

	const [dirtyCheckState, setDirtyCheckState] = useState<"clean" | "checking" | "dirty">("clean");
	const dirtyCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const [isSaving, setIsSaving] = useState(false);

	const [byteSize, setByteSize] = useState(() => files_get_utf8_byte_size(initialData.text));

	const isSaveDebouncing = dirtyCheckState === "checking";
	const isSaveDisabled = !editable || isSaving || dirtyCheckState !== "dirty";
	const isDiscardAllDisabled = !editable || isSaving || dirtyCheckState !== "dirty";
	const hasTopViewZoneSlot = topViewZoneSlot != null && topViewZoneSlot !== false;
	const editorTopPadding = Math.max(16, topSafeArea ?? 0);

	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones
	// option updates and DOM references in these options are cyclic.
	const [diffEditorOptions] = useState(() => {
		return {
			overflowWidgetsDomNode: hoistingContainer ?? undefined,
			originalEditable: false,
			renderSideBySide: false,
			ignoreTrimWhitespace: false,
			glyphMargin: false,
			lineDecorationsWidth: 72,
			// Monaco's built-in per-hunk revert replaces the accept/discard widgets of the
			// pending-updates diff editor: here every hunk is the member's own unsaved edit, and
			// reverting one just restores the committed text for that stretch.
			//
			// It must come from the gutter menu, not from `renderMarginRevertIcon`. Monaco turns the
			// margin arrow off whenever `renderSideBySide` is false, so on this inline diff that
			// option renders nothing at all (`shouldRenderOldRevertArrows` in Monaco's
			// diffEditorOptions).
			renderGutterMenu: true,
			fixedOverflowWidgets: true,
			fontSize: 16,
			lineHeight: 22,
			wordWrap: "on",
			scrollBeyondLastLine: false,
			minimap: { enabled: false },
			scrollbar: { vertical: "visible" },
			padding: { top: 0, bottom: 64 },

			lineNumbers: "on",
			renderLineHighlight: "all",
			renderLineHighlightOnlyWhenFocus: true,

			// The two panes are named for screen readers in `handleOnMount` instead. Passing
			// `originalAriaLabel` / `modifiedAriaLabel` here does nothing: they never reach the inner
			// editors, so both panes keep an empty `aria-label`.
		} satisfies NonNullable<DiffEditorProps["options"]>;
	});

	const updateThreadIds = (markdown: string) => {
		const nextThreadIds = files_get_comment_thread_ids_from_markdown(markdown, initialData.rootKind);
		if (!nextThreadIds) {
			return;
		}

		const nextKey = nextThreadIds.join("\n");
		if (nextKey === commentThreadIdsKeyRef.current) {
			return;
		}
		commentThreadIdsKeyRef.current = nextKey;
		setCommentThreadIds(nextThreadIds);
	};

	const scheduleDirtyCheck = () => {
		if (!editorModelsRef.current) return;

		setDirtyCheckState("checking");

		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
		}

		dirtyCheckTimeoutRef.current = setTimeout(() => {
			dirtyCheckTimeoutRef.current = undefined;

			const editorModels = editorModelsRef.current;
			if (!editorModels) {
				const error = should_never_happen("[FileEditorDiffNonCollab.scheduleDirtyCheck] Missing `editorModels`", {
					editor: editorRef.current,
					editorModels,
				});
				console.error(error);
				return;
			}

			// This debounce already reads the full value for the dirty check, so measuring the
			// content size here is only the byte count on top.
			const localMarkdown = editorModels.modified.getValue();
			setByteSize(files_get_utf8_byte_size(localMarkdown));

			// The original pane always holds the committed text, so it is the dirty baseline.
			const isDirty = localMarkdown !== editorModels.original.getValue();
			setDirtyCheckState(isDirty ? "dirty" : "clean");
		}, 250);
	};

	const pushChangeToOriginalEditor = (newMarkdown: string) => {
		const editorModels = editorModelsRef.current;
		if (!editorModels) {
			const error = should_never_happen(
				"[FileEditorDiffNonCollab.pushChangeToOriginalEditor] Missing `editorModels`",
				{
					editor: editorRef.current,
					editorModels,
				},
			);
			console.error(error);
			throw error;
		}

		// Apply edits at the model level so the committed pane can be updated even though
		// `originalEditable` is false (original editor is read-only).
		editorModels.original.pushStackElement();
		editorModels.original.applyEdits([{ range: editorModels.original.getFullModelRange(), text: newMarkdown }]);
		editorModels.original.pushStackElement();
	};

	const pushChangeToModifiedEditor = (newMarkdown: string) => {
		const editor = editorRef.current;
		const editorModels = editorModelsRef.current;
		if (!editor || !editorModels) {
			const error = should_never_happen("[FileEditorDiffNonCollab.pushChangeToModifiedEditor] Missing editor", {
				editor,
				editorModels,
			});
			console.error(error);
			throw error;
		}

		// The helper falls back to model-level edits when Monaco is read-only, so a restore that
		// finishes after write permission was removed still updates the pane.
		files_monaco_execute_edits_with_read_only_fallback({
			editor: editor.getModifiedEditor(),
			model: editorModels.modified,
			edits: [{ range: editorModels.modified.getFullModelRange(), text: newMarkdown }],
		});
	};

	const getCurrentText = useFn(() => {
		return editorModelsRef.current?.modified.getValue() ?? initialData.text;
	});

	// No `editable` guard here on purpose: this runs only after the backend already committed the
	// restore, so skipping the refresh when permission was removed mid-restore would leave the
	// editor showing stale content. The pre-action gate lives in the snapshots modal.
	const handleApplySnapshotText = useFn(() => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			// The restore replaced the whole text, so re-read it together with the asset it now
			// lives in. That asset is the base of the user's next save.
			const restored = await app_convex.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId,
				nodeId,
			});
			if (restored._nay) {
				console.error("[FileEditorDiffNonCollab.handleApplySnapshotText] Error while reading the restored content", {
					nay: restored._nay,
				});
				toast.error("Failed to refresh the editor after the restore. Reload the file.");
				return;
			}

			// The restored text is the new committed version and the new starting point of the
			// member's edits, so both panes show it and the diff is empty.
			pushChangeToOriginalEditor(restored._yay.text);
			pushChangeToModifiedEditor(restored._yay.text);
			updateThreadIds(restored._yay.text);
			setNonCollaborativeBaseAssetId(restored._yay.assetId);
			setByteSize(files_get_utf8_byte_size(restored._yay.text));

			if (dirtyCheckTimeoutRef.current) {
				clearTimeout(dirtyCheckTimeoutRef.current);
				dirtyCheckTimeoutRef.current = undefined;
			}
			setDirtyCheckState("clean");
		})().catch((err) => {
			console.error("[FileEditorDiffNonCollab] Failed to apply snapshot restore", err);
			toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
		});
	});

	const handleClickSave = useFn(() => {
		if (!editable) return;

		const editorModels = editorModelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[FileEditorDiffNonCollab.handleClickSave] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels,
			});
			console.error(error);
			throw error;
		}

		if (isSaving || dirtyCheckState !== "dirty") return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const localMarkdown = editorModels.modified.getValue();

			// Nothing is persisted until this point, so the cap is enforced here instead of on
			// paste. The content stays in the editor, so the user can trim it and save again.
			const localByteSize = files_get_utf8_byte_size(localMarkdown);
			if (localByteSize > files_MAX_TEXT_CONTENT_BYTES) {
				toast.error(file_editor_get_size_error_message(localByteSize));
				return;
			}

			// No document to diff, no branch to merge. Send the whole text and name the asset it
			// was built on, so a save that landed meanwhile is refused instead of silently
			// overwritten.
			const replaced = await app_convex.action(app_convex_api.files_nodes_content.replace_file_content, {
				membershipId,
				nodeId,
				text: localMarkdown,
				baseAssetId: nonCollaborativeBaseAssetId,
			});
			if (replaced._nay) {
				console.error("[FileEditorDiffNonCollab.handleClickSave] Error while replacing the file content", {
					nay: replaced._nay,
				});
				toast.error(replaced._nay.message);
				return;
			}

			// The save wrote a new version, and the next save has to be based on it. The saved text
			// becomes the committed pane.
			setNonCollaborativeBaseAssetId(replaced._yay.assetId);
			pushChangeToOriginalEditor(localMarkdown);
			updateThreadIds(localMarkdown);

			// If the member typed while the save was waiting, the extra typing stays in the
			// modified pane as unsaved hunks against the text the save captured.
			const currentModified = editorModels.modified.getValue();
			setByteSize(files_get_utf8_byte_size(currentModified));
			setDirtyCheckState(currentModified !== localMarkdown ? "dirty" : "clean");
		})()
			.catch((err) => {
				console.error("[FileEditorDiffNonCollab.handleClickSave] Save failed", err);
				toast.error(err?.message ?? "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	});

	const handleClickDiscardAll = useFn(() => {
		if (!editable || isSaving) return;

		const editorModels = editorModelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[FileEditorDiffNonCollab.handleClickDiscardAll] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels,
			});
			console.error(error);
			return;
		}

		// The committed pane is the baseline, so restoring the modified pane to it clears every
		// hunk. The content-change listener then schedules the dirty check that lands on clean.
		pushChangeToModifiedEditor(editorModels.original.getValue());
	});

	const handleOnMount = useFn<DiffEditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		editor.updateOptions({ readOnly: !editable });
		setMountedModifiedEditor(editor.getModifiedEditor());

		// Both panes start on the committed text: the modified pane is where the member edits, and
		// the diff fills in as they type.
		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		const nextModels = {
			original: files_monaco_create_editor_model(initialData.text, monacoLanguageId),
			modified: files_monaco_create_editor_model(initialData.text, monacoLanguageId),
		};
		editorModelsRef.current = nextModels;
		editor.setModel(nextModels);
		prevModels.forEach((model) => model?.dispose());

		updateThreadIds(initialData.text);

		qaMonacoCleanupRef.current?.();
		const qaOriginalCleanup = app_qa_register_monaco_editor("diffOriginal", editor.getOriginalEditor());
		const qaModifiedCleanup = app_qa_register_monaco_editor("diffModified", editor.getModifiedEditor());
		qaMonacoCleanupRef.current = () => {
			qaOriginalCleanup();
			qaModifiedCleanup();
		};

		editor.getModifiedEditor().onDidChangeModelContent(() => {
			scheduleDirtyCheck();
		});
	});

	// The permission query can resolve or change after Monaco mounts. Update the live editor instead
	// of rebuilding its models, which would drop the cursor and undo history.
	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: !editable });
	}, [editable]);

	// Name each pane for screen readers. This has to run after the mount, not inside `onMount`:
	// Monaco rebuilds the two inner editors' options right after the diff editor is created, and
	// that pass overwrites the label with an empty string. The diff-level `originalAriaLabel` /
	// `modifiedAriaLabel` options never arrive at the inner editors at all, so without this both
	// panes announce with no name.
	useEffect(() => {
		if (!mountedModifiedEditor) {
			return;
		}

		editorRef.current?.getOriginalEditor().updateOptions({ ariaLabel: "Original file content" });
		editorRef.current?.getModifiedEditor().updateOptions({ ariaLabel: "Modified file content" });
	}, [mountedModifiedEditor]);

	/**
	 * Warn before this editor goes away with text that was never saved.
	 *
	 * The committed pane is the baseline, so the unsaved text is whatever the modified pane holds
	 * on top of it. Read both models instead of the debounced dirty state, because that state is
	 * up to 250 ms behind and would miss the last words typed.
	 */
	const warnIfUnsavedTextIsDropped = useFn(() => {
		const editorModels = editorModelsRef.current;
		if (!editorModels) {
			return;
		}

		const currentModified = editorModels.modified.getValue();
		if (currentModified === editorModels.original.getValue()) {
			return;
		}

		file_editor_warn_unsaved_text_dropped(currentModified);
	});

	// Run only on unmount, and before the cleanup below disposes the models. The cleanup reads a
	// stable callback, so no other change may re-run it: a rerun would warn about text that is
	// still on screen.
	useEffect(() => warnIfUnsavedTextIsDropped, [warnIfUnsavedTextIsDropped]);

	useEffect(() => {
		return () => {
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;

			editorRef.current?.dispose();
			editorRef.current = null;

			editorModelsRef.current?.original.dispose();
			editorModelsRef.current?.modified.dispose();
			editorModelsRef.current = null;

			qaMonacoCleanupRef.current?.();
			qaMonacoCleanupRef.current = null;
		};
	}, []);

	return (
		<>
			<div
				className={"FileEditorDiffNonCollab" satisfies FileEditorDiffNonCollab_ClassNames}
				aria-label="File diff editor"
			>
				<FileEditorDiffNonCollabToolbarActions
					byteSize={byteSize}
					editable={editable}
					isSaveDisabled={isSaveDisabled}
					isSaveDebouncing={isSaveDebouncing}
					isDiscardAllDisabled={isDiscardAllDisabled}
					nodeId={nodeId}
					nonCollaborativeBaseAssetId={nonCollaborativeBaseAssetId}
					sessionId={presenceStore.localSessionId}
					toolbarPortalHost={toolbarPortalHost}
					getCurrentText={getCurrentText}
					onApplySnapshotText={handleApplySnapshotText}
					onClickSave={handleClickSave}
					onClickDiscardAll={handleClickDiscardAll}
				/>
				<FileEditorDiffNonCollabTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<div className={"FileEditorDiffNonCollab-editor" satisfies FileEditorDiffNonCollab_ClassNames}>
					<DiffEditor
						height="100%"
						theme={app_monaco_THEME_NAME_DARK}
						onMount={handleOnMount}
						original={initialData.text}
						modified={initialData.text}
						originalLanguage={monacoLanguageId}
						modifiedLanguage={monacoLanguageId}
						// We own our own models, so we need to keep them alive even after the editor is disposed,
						// because we dispose them manually
						keepCurrentOriginalModel={true}
						keepCurrentModifiedModel={true}
						options={diffEditorOptions}
					/>
					<FileEditorMonacoTopViewZone editor={mountedModifiedEditor} topViewZoneGap={editorTopPadding}>
						{hasTopViewZoneSlot ? topViewZoneSlot : <div aria-hidden={true} />}
					</FileEditorMonacoTopViewZone>
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

export type FileEditorDiffNonCollab_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/**
	 * The Monaco language id derived from the node name (`files_get_monaco_language_id`).
	 */
	monacoLanguageId: string;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topSafeArea?: number;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

/**
 * The diff view for a file with collaboration turned off. There is no pending update and no shared
 * document here: the original pane shows the committed text, the modified pane is where the member
 * edits, and Save replaces the whole text against the asset the committed pane was read from.
 */
export const FileEditorDiffNonCollab = memo(function FileEditorDiffNonCollab(props: FileEditorDiffNonCollab_Props) {
	const {
		nodeId,
		editable,
		monacoLanguageId,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topSafeArea,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const fileContentDataPromise = useMemo(() => {
		// Collaboration off: the server sends the committed text and the asset the next save has
		// to name.
		return app_convex
			.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, { membershipId, nodeId })
			.then((result): FileEditorDiffNonCollab_LoadedContent | null => {
				if (result._nay) {
					console.error("[FileEditorDiffNonCollab] Error while reading the file content", result._nay);
					return null;
				}

				return {
					text: result._yay.text,
					rootKind: result._yay.yjsRootKind,
					baseAssetId: result._yay.assetId,
				};
			});
	}, [membershipId, nodeId]);
	const fileContentData = usePromiseValue(fileContentDataPromise);

	// On a refused or missing read, do not mount the editor over a stand-in document. A fabricated
	// empty committed pane is legal in shape, so every later Save would replace the real content
	// with whatever the member typed over emptiness. The refusal state is the only place this
	// corruption can be stopped. A legitimate `_yay: ""` is NOT a refusal — an empty file mounts
	// with its real committed text and base asset.
	return fileContentData === undefined ? (
		<FileEditorDiffSkeleton />
	) : fileContentData === null ? (
		<div className={"FileEditorDiffNonCollab" satisfies FileEditorDiffNonCollab_ClassNames}>
			<div role="alert" className={"FileEditorDiffNonCollab-refusal" satisfies FileEditorDiffNonCollab_ClassNames}>
				This file's content could not be read safely, so the editor stays closed to protect it. Reload the file or
				contact support if this keeps happening.
			</div>
		</div>
	) : (
		<FileEditorDiffNonCollabInner
			key={`non_collaborative:${fileContentData.baseAssetId}`}
			nodeId={nodeId}
			editable={editable}
			monacoLanguageId={monacoLanguageId}
			initialData={fileContentData}
			topSafeArea={topSafeArea}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
});
// #endregion root
