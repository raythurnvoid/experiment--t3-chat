import "./file-editor-diff.css";
import { Check, Undo2 } from "lucide-react";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { CoalescedRunner } from "@/lib/async.ts";
import React, { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { editor as monaco_editor, Range as monaco_Range } from "monaco-editor";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, should_never_happen, sx } from "@/lib/utils.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { app_qa_register_monaco_editor } from "@/lib/app-qa.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import {
	file_editor_get_size_badge_text,
	file_editor_get_size_error_message,
	file_editor_get_size_status_message,
} from "@/lib/file-editor.ts";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { CheckCheck, RefreshCcw, Save, SaveAll, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { useFn, useStateRef } from "@/hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_fetch_file_pending_update_yjs_state,
	files_fetch_file_yjs_state_and_text,
	files_get_utf8_byte_size,
	files_monaco_create_editor_model,
	files_monaco_execute_edits_with_read_only_fallback,
	files_pending_update_has_yjs_content,
	files_persist_file_pending_update_rebased_state,
	files_u8_to_array_buffer,
	files_upsert_file_pending_update,
	files_yjs_reconcile_branch_with_local_text,
	files_yjs_rebase_branch_with_local_text,
	type files_YjsRootKind,
} from "@/lib/files.ts";
import { files_yjs_doc_clone, files_yjs_doc_create_from_array_buffer_update } from "../../../../../shared/files-yjs.ts";
import { files_headless_tiptap_editor_create, files_yjs_doc_get_text } from "../../../../../shared/files-tiptap.ts";
import { files_get_thread_ids_from_editor_state } from "../../../../../shared/files-tiptap-comments.ts";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { Result } from "common/errors-as-values-utils.ts";
import { FileEditorDiffSkeleton } from "./file-editor-diff-skeleton.tsx";
import { FileEditorMonacoTopViewZone } from "../file-editor-monaco-top-view-zone.tsx";

// #region toolbar
type FileEditorDiffToolbarActions_ClassNames =
	| "FileEditorDiffToolbarActions"
	| "FileEditorDiffToolbarActions-button"
	| "FileEditorDiffToolbarActions-button-accept-all"
	| "FileEditorDiffToolbarActions-button-accept-all-and-save"
	| "FileEditorDiffToolbarActions-button-discard-all"
	| "FileEditorDiffToolbarActions-icon"
	| "FileEditorDiffToolbarActions-size-badge";

type FileEditorDiffToolbarActions_Props = {
	byteSize: number;
	editable: boolean;
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	isAcceptAllDisabled: boolean;
	isAcceptAllAndSaveDisabled: boolean;
	isDiscardAllDisabled: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	toolbarPortalHost: HTMLElement;
	getCurrentText: () => string;
	onApplySnapshotText: (markdown: string) => void;
	onClickSave: () => void;
	onClickSync: () => void;
	onClickAcceptAll: () => void;
	onClickAcceptAllAndSave: () => void;
	onClickDiscardAll: () => void;
};

const FileEditorDiffToolbarActions = memo(function FileEditorDiffToolbarActions(
	props: FileEditorDiffToolbarActions_Props,
) {
	const {
		byteSize,
		editable,
		isSaveDisabled,
		isSyncDisabled,
		isAcceptAllDisabled,
		isAcceptAllAndSaveDisabled,
		isDiscardAllDisabled,
		nodeId,
		sessionId,
		toolbarPortalHost,
		getCurrentText,
		onApplySnapshotText,
		onClickSave,
		onClickSync,
		onClickAcceptAll,
		onClickAcceptAllAndSave,
		onClickDiscardAll,
	} = props;

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return createPortal(
		<div
			role="group"
			aria-label="Diff editor actions"
			className={cn("FileEditorDiffToolbarActions" satisfies FileEditorDiffToolbarActions_ClassNames)}
		>
			<MyButton
				variant="ghost-highlightable"
				className={cn("FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames)}
				aria-label="Save staged changes"
				disabled={isSaveDisabled}
				onClick={onClickSave}
			>
				<MyButtonIcon
					className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					<Save />
				</MyButtonIcon>
				Save
			</MyButton>
			<MyButton
				variant="ghost-highlightable"
				className={cn("FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames)}
				aria-label="Sync with live file"
				disabled={isSyncDisabled}
				onClick={onClickSync}
			>
				<MyButtonIcon
					className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					<RefreshCcw />
				</MyButtonIcon>
				Sync
			</MyButton>
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-accept-all" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				aria-label="Accept all pending changes in this file"
				disabled={isAcceptAllDisabled}
				onClick={onClickAcceptAll}
			>
				<MyButtonIcon
					className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					<CheckCheck />
				</MyButtonIcon>
				Accept all
			</MyButton>
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-accept-all-and-save" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				aria-label="Accept all pending changes and save"
				disabled={isAcceptAllAndSaveDisabled}
				onClick={onClickAcceptAllAndSave}
			>
				<MyButtonIcon
					className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					<SaveAll />
				</MyButtonIcon>
				Accept all + save
			</MyButton>
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-discard-all" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				aria-label="Discard all pending changes in this file"
				disabled={isDiscardAllDisabled}
				onClick={onClickDiscardAll}
			>
				<MyButtonIcon
					className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					<Trash2 />
				</MyButtonIcon>
				Discard all
			</MyButton>
			{sizeBadge && (
				<MyBadge
					variant={sizeBadge.isOverCap ? "destructive" : "secondary"}
					className={cn("FileEditorDiffToolbarActions-size-badge" satisfies FileEditorDiffToolbarActions_ClassNames)}
				>
					{sizeBadge.label}
				</MyBadge>
			)}
			{/*
				The badge is silent, so without this a screen reader user only finds out the file is
				too big when Save is rejected, and the draft sync stops with no feedback at all.
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
type FileEditorDiffTopStickyFloatingContainer_ClassNames = "FileEditorDiffTopStickyFloatingContainer";

type FileEditorDiffTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

const FileEditorDiffTopStickyFloatingContainer = memo(function FileEditorDiffTopStickyFloatingContainer(
	props: FileEditorDiffTopStickyFloatingContainer_Props,
) {
	const { topStickyFloatingSlot } = props;

	return (
		<div
			className={cn(
				"FileEditorDiffTopStickyFloatingContainer" satisfies FileEditorDiffTopStickyFloatingContainer_ClassNames,
			)}
		>
			{topStickyFloatingSlot}
		</div>
	);
});
// #endregion top sticky floating container

// #region FileEditorDiffWidgetAcceptDiscard
export type FileEditorDiffWidgetAcceptDiscard_ClassNames =
	| "FileEditorDiffWidgetAcceptDiscard"
	| "FileEditorDiffWidgetAcceptDiscard-monaco-decoration"
	| "FileEditorDiffWidgetAcceptDiscard-accept-button"
	| "FileEditorDiffWidgetAcceptDiscard-discard-button"
	| "FileEditorDiffWidgetAcceptDiscard-icon";

export type FileEditorDiffWidgetAcceptDiscard_Props = {
	onAccept: () => void;
	onDiscard: () => void;
};

class FileEditorDiffWidgetAcceptDiscard_Monaco implements monaco_editor.IContentWidget {
	allowEditorOverflow: monaco_editor.IContentWidget["allowEditorOverflow"] = true;

	args: {
		editor: monaco_editor.IStandaloneCodeEditor;
		anchorName: string;
		index: number;
		lineNumber: number;
	};

	id: string;
	node: HTMLDivElement;

	decorations: monaco_editor.IEditorDecorationsCollection;

	disposeAbortController: AbortController;

	constructor(args: typeof this.args) {
		this.args = args;
		this.id = `FileEditorDiffWidgetAcceptDiscard-${this.args.index}`;

		this.node = document.createElement("div");
		this.node.classList.add("FileEditorDiffWidgetAcceptDiscard" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames);

		this.decorations = this.args.editor.createDecorationsCollection([this.createDecoration(this.args.lineNumber)]);

		this.disposeAbortController = new AbortController();

		const decorationsOnDidChangeDisposable = this.decorations.onDidChange(() => {
			this.args.editor.layoutContentWidget(this);
		});

		this.disposeAbortController.signal.addEventListener("abort", () => {
			decorationsOnDidChangeDisposable.dispose();
		});
	}

	getId: monaco_editor.IContentWidget["getId"] = () => {
		return this.id;
	};

	getDomNode: monaco_editor.IContentWidget["getDomNode"] = () => {
		return this.node;
	};

	getPosition: monaco_editor.IContentWidget["getPosition"] = () => {
		const range = this.decorations.getRange(0);
		if (!range) {
			const error = should_never_happen("[AcceptDiscardContentWidget.getPosition] Missing `range`", {
				range,
			});
			console.error(error);
			return null;
		}
		return {
			position: { lineNumber: range.startLineNumber, column: 1 },
			preference: [monaco_editor.ContentWidgetPositionPreference.EXACT],
			positionAffinity: monaco_editor.PositionAffinity.Right,
		};
	};

	beforeRender: monaco_editor.IContentWidget["beforeRender"] = () => {
		return {
			width: 52,
			height: 24,
		};
	};

	afterRender: monaco_editor.IContentWidget["afterRender"] = (position, coordinate) => {
		if (!coordinate) {
			this.node.style.display = "none";
			return;
		}

		this.node.style.transform = `translate3d(102px, 91px, 0)`;
		this.node.style.display = "flex";
		this.node.style.left = `anchor(left)`;
		this.node.style.setProperty("position-anchor", this.args.anchorName);
	};

	private createDecoration(lineNumber: number): monaco_editor.IModelDeltaDecoration {
		return {
			range: new monaco_Range(lineNumber, 1, lineNumber, 1),
			options: {
				className:
					"FileEditorDiffWidgetAcceptDiscard-monaco-decoration" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames,
				stickiness: monaco_editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				isWholeLine: false,
			},
		};
	}

	get disposed(): boolean {
		return this.disposeAbortController.signal.aborted;
	}

	updateLine(lineNumber: number) {
		this.args.lineNumber = lineNumber;
		this.decorations.set([this.createDecoration(lineNumber)]);
	}

	dispose() {
		this.disposeAbortController.abort();
		this.decorations.clear();
		this.args.editor.removeContentWidget(this);
	}
}

export const FileEditorDiffWidgetAcceptDiscard = memo(function FileEditorDiffWidgetAcceptDiscard(
	props: FileEditorDiffWidgetAcceptDiscard_Props,
) {
	const { onAccept, onDiscard } = props;

	const handleMouseDown = useFn((e: React.MouseEvent) => {
		e.preventDefault();
	});

	const handleClickAccept = useFn((e: React.MouseEvent) => {
		e.preventDefault();
		onAccept();
	});

	const handleClickDiscard = useFn((e: React.MouseEvent) => {
		e.preventDefault();
		onDiscard();
	});

	return (
		<>
			<MyTooltip timeout={0} placement="top">
				<MyTooltipTrigger>
					<button
						type="button"
						className={cn(
							"FileEditorDiffWidgetAcceptDiscard-accept-button" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Accept change"
						onMouseDown={handleMouseDown}
						onClick={handleClickAccept}
					>
						<Check
							className={cn(
								"FileEditorDiffWidgetAcceptDiscard-icon" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames,
							)}
						/>
					</button>
				</MyTooltipTrigger>
				<MyTooltipContent gutter={6}>
					<MyTooltipArrow />
					Accept change
				</MyTooltipContent>
			</MyTooltip>

			<MyTooltip timeout={0} placement="top">
				<MyTooltipTrigger>
					<button
						type="button"
						className={cn(
							"FileEditorDiffWidgetAcceptDiscard-discard-button" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Discard change"
						onMouseDown={handleMouseDown}
						onClick={handleClickDiscard}
					>
						<Undo2
							className={cn(
								"FileEditorDiffWidgetAcceptDiscard-icon" satisfies FileEditorDiffWidgetAcceptDiscard_ClassNames,
							)}
						/>
					</button>
				</MyTooltipTrigger>
				<MyTooltipContent gutter={6}>
					<MyTooltipArrow />
					Discard change
				</MyTooltipContent>
			</MyTooltip>
		</>
	);
});
// #endregion FileEditorDiffWidgetAcceptDiscard

// #region root
type RemoteEditorContentState = {
	baselineYjsDoc: YDoc;
	baselineMarkdown: string;
	stagedYjsDoc: YDoc;
	stagedMarkdown: string;
	unstagedYjsDoc: YDoc;
	unstagedMarkdown: string;
	yjsSequence: number;
};

function file_editor_diff_editor_base_yjs_sequence(args: {
	pendingUpdate: object | null | undefined;
	fileContentYjsSequence: number | undefined;
	remoteYjsSequence: number | undefined;
	lastSequenceSaved: number | undefined;
}) {
	if (args.pendingUpdate != null) {
		return args.remoteYjsSequence;
	}

	const sequenceCandidates = [args.fileContentYjsSequence, args.remoteYjsSequence, args.lastSequenceSaved].filter(
		(sequence): sequence is number => sequence != null,
	);

	if (sequenceCandidates.length === 0) {
		return undefined;
	}

	return Math.max(...sequenceCandidates);
}

function file_editor_diff_is_sync_disabled(args: {
	isSyncing: boolean;
	isSaving: boolean;
	serverSequence: number | null | undefined;
	editorBaseYjsSequence: number | undefined;
}) {
	return (
		args.isSyncing ||
		args.isSaving ||
		args.serverSequence == null ||
		args.editorBaseYjsSequence == null ||
		args.serverSequence <= args.editorBaseYjsSequence
	);
}

function file_editor_diff_should_apply_live_file_content_state(args: {
	pendingUpdate: object | null | undefined;
	isSaving: boolean;
	fileContentYjsSequence: number | undefined;
	lastSequenceSaved: number | undefined;
}) {
	if (args.pendingUpdate != null || args.isSaving || args.fileContentYjsSequence == null) {
		return false;
	}

	// Keep the post-save editor state until the fetched live file has caught up to
	// the sequence that save just committed. Content shape is not a staleness signal:
	// an empty file is a valid live state when its sequence is current.
	if (args.lastSequenceSaved != null && args.fileContentYjsSequence < args.lastSequenceSaved) {
		return false;
	}

	return true;
}

/**
 * Rejects content that the save would not be able to persist.
 *
 * Always measured from a raw model value, never from the `byteSize` state: "Accept all and
 * save" mutates the models and saves synchronously, so the state has not flushed yet.
 */
function check_markdown_fits_size_cap(markdown: string) {
	const markdownByteSize = files_get_utf8_byte_size(markdown);
	if (markdownByteSize <= files_MAX_TEXT_CONTENT_BYTES) {
		return true;
	}

	toast.error(file_editor_get_size_error_message(markdownByteSize));
	return false;
}

function editor_content_states_match(left: RemoteEditorContentState, right: RemoteEditorContentState) {
	return (
		left.baselineMarkdown === right.baselineMarkdown &&
		left.stagedMarkdown === right.stagedMarkdown &&
		left.unstagedMarkdown === right.unstagedMarkdown &&
		left.yjsSequence === right.yjsSequence
	);
}

/**
 * Load the three canonical branch states of one pending update and read each one's text. The
 * states live in paged `files_pending_update_yjs_states` families, so each role is fetched page
 * by page and reassembled locally; the shape comes from the route-resolved node, never from the
 * proposal.
 */
async function create_editor_content_state_from_pending_update(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	rootKind: files_YjsRootKind;
}) {
	const { membershipId, pendingUpdate, rootKind } = args;
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return Result({ _nay: { message: "Pending update has no content" } });
	}

	const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
		files_fetch_file_pending_update_yjs_state({
			membershipId,
			nodeId: pendingUpdate.fileNodeId,
			stateId: pendingUpdate.baseStateId,
		}),
		files_fetch_file_pending_update_yjs_state({
			membershipId,
			nodeId: pendingUpdate.fileNodeId,
			stateId: pendingUpdate.stagedStateId,
		}),
		files_fetch_file_pending_update_yjs_state({
			membershipId,
			nodeId: pendingUpdate.fileNodeId,
			stateId: pendingUpdate.unstagedStateId,
		}),
	]);
	if (baseBytes._nay) return baseBytes;
	if (stagedBytes._nay) return stagedBytes;
	if (unstagedBytes._nay) return unstagedBytes;

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseBytes._yay);
	const stagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(stagedBytes._yay);
	const unstagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(unstagedBytes._yay);

	const baseMarkdown = files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind });
	const stagedMarkdown = files_yjs_doc_get_text({ yjsDoc: stagedYjsDoc, rootKind });
	const unstagedMarkdown = files_yjs_doc_get_text({ yjsDoc: unstagedYjsDoc, rootKind });

	if (baseMarkdown._nay) return baseMarkdown;
	else if (stagedMarkdown._nay) return stagedMarkdown;
	else if (unstagedMarkdown._nay) return unstagedMarkdown;

	return Result({
		_yay: {
			baselineYjsDoc: baseYjsDoc,
			baselineMarkdown: baseMarkdown._yay,
			stagedYjsDoc,
			stagedMarkdown: stagedMarkdown._yay,
			unstagedYjsDoc,
			unstagedMarkdown: unstagedMarkdown._yay,
			yjsSequence: pendingUpdate.baseYjsSequence,
		} satisfies RemoteEditorContentState,
	});
}

function create_editor_content_state_from_file_content_data(
	fileContentData: NonNullable<Awaited<ReturnType<typeof files_fetch_file_yjs_state_and_text>>>,
) {
	if (fileContentData.text._nay) {
		return null;
	}

	const text = fileContentData.text._yay;
	return {
		baselineYjsDoc: fileContentData.yjsDoc,
		baselineMarkdown: text,
		stagedYjsDoc: files_yjs_doc_clone({ yjsDoc: fileContentData.yjsDoc }),
		stagedMarkdown: text,
		unstagedYjsDoc: files_yjs_doc_clone({ yjsDoc: fileContentData.yjsDoc }),
		unstagedMarkdown: text,
		yjsSequence: fileContentData.yjsSequence,
	} satisfies RemoteEditorContentState;
}

type FileEditorDiff_ClassNames =
	| "FileEditorDiff"
	| "FileEditorDiff-editor"
	| "FileEditorDiff-anchor"
	| "FileEditorDiff-refusal";

type FileEditorDiff_CssVars = {
	"--FileEditorDiff-anchor-name": string;
};

export type FileEditorDiff_Props = {
	className?: string;
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/**
	 * The node's document shape, threaded from the node the ROUTE already resolved — never from
	 * the nullable content fetch, which has no value in exactly the refused case.
	 */
	rootKind: files_YjsRootKind;
	/** Monaco language for the node, derived from its name via `files_get_monaco_language_id`. */
	monacoLanguageId: string;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	presenceStore: files_PresenceStore;
	threadId?: string;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	serverSequence?: number;
	topSafeArea?: number;
	onExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

type FileEditorDiffInner_Props = FileEditorDiff_Props & {
	hoistingContainer: HTMLElement;
	editorContentState: RemoteEditorContentState;
	isSaving: boolean;
	isSyncing: boolean;
	isSyncDisabled: boolean;
	onSave: (args: { flushPendingUpdateUpsertIfNeeded: () => Promise<boolean> }) => void;
	onClickSync: (editorValues: { stagedMarkdown: string; unstagedMarkdown: string }) => void;
};

const FileEditorDiffInner = memo(function FileEditorDiffInner(props: FileEditorDiffInner_Props) {
	const {
		className,
		nodeId,
		editable,
		rootKind,
		monacoLanguageId,
		pendingUpdateId,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		hoistingContainer,
		editorContentState,
		isSaving,
		isSyncing,
		isSyncDisabled,
		topSafeArea,
		onSave,
		onClickSync,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const id = useId();
	const anchorName = `${"--FileEditorDiff-anchor-name" satisfies keyof FileEditorDiff_CssVars}-${id}`;

	const editorRef = useRef<monaco_editor.IStandaloneDiffEditor | null>(null);
	const [mountedModifiedEditor, setMountedModifiedEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
	const pendingUpdateSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const ignoredProgrammaticModelChangesRef = useRef(0);
	const [pendingUpdateSyncRunner] = useState(() => new CoalescedRunner());
	const lastAppliedRemoteEditorContentStateRef = useRef(editorContentState);

	// Keep the initial diff inputs stable after mount because the React wrapper still watches these props.
	// Remote updates are applied through our owned Monaco models, so changing the props would reset the diff.
	const [initialOriginalMarkdown] = useState(editorContentState.stagedMarkdown);
	const [initialUnstagedMarkdown] = useState(editorContentState.unstagedMarkdown);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");
	const qaMonacoCleanupRef = useRef<(() => void) | null>(null);

	/** Content widgets for per-change actions (accept/discard) */
	const [contentWidgetsRef, setContentWidgets, contentWidgets] = useStateRef<
		FileEditorDiffWidgetAcceptDiscard_Monaco[]
	>([]);
	const isUnmountingRef = useRef(false);

	const monacoListenersDisposeAbortControllers = useRef<AbortController>(null);
	const [editorModelsRef, setEditorModels, editorModels] = useStateRef<{
		original: monaco_editor.ITextModel;
		modified: monaco_editor.ITextModel;
	} | null>(null);

	// `isDirty` compares staged content to the baseline.
	// `hasUnstagedChanges` compares staged content to the
	// unstaged diff buffer so save and accept/discard actions can enable independently
	// without depending on server state.
	const [isDirty, setIsDirty] = useState(() => {
		return editorContentState.stagedMarkdown !== editorContentState.baselineMarkdown;
	});
	const [hasUnstagedChanges, setHasUnstagedChanges] = useState(() => {
		return editorContentState.stagedMarkdown !== editorContentState.unstagedMarkdown;
	});

	// Both branches are sent on every draft sync and the server rejects the whole upsert if either
	// is over the cap, so the badge tracks the larger of the two: it answers "will my draft save?".
	const [byteSize, setByteSize] = useState(() => {
		return Math.max(
			files_get_utf8_byte_size(editorContentState.stagedMarkdown),
			files_get_utf8_byte_size(editorContentState.unstagedMarkdown),
		);
	});

	/**
	 * We can allow updated to the remote `pendingUpdate` to write in the editor
	 * only if there's no other local edit being sent to the server, otherwise
	 * we might end-up in situations where the user edits are reverted by the sync.
	 */
	const pendingUpdateSyncStatusRef = useRef<"idle" | "debouncing" | "mutation_in_flight">("idle");

	const isSaveDisabled = !editable || isSaving || isSyncing || !isDirty;
	const isAcceptAllDisabled = !editable || isSaving || isSyncing || !hasUnstagedChanges;
	const isAcceptAllAndSaveDisabled = !editable || isSaving || isSyncing || !hasUnstagedChanges;
	const isDiscardAllDisabled = !editable || isSaving || isSyncing || !hasUnstagedChanges;
	const hasTopViewZoneSlot = topViewZoneSlot != null && topViewZoneSlot !== false;
	const editorTopPadding = Math.max(16, topSafeArea ?? 0);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones
	// option updates and DOM references in these options are cyclic.
	const [diffEditorOptions] = useState(() => {
		return {
			overflowWidgetsDomNode: hoistingContainer,
			originalEditable: false,
			renderSideBySide: false,
			ignoreTrimWhitespace: false,
			glyphMargin: false,
			lineDecorationsWidth: 72,
			renderMarginRevertIcon: false,
			renderGutterMenu: false,
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

			// Name the two panes for screen readers; both would otherwise announce as bare "Editor".
			originalAriaLabel: "Original file content",
			modifiedAriaLabel: "Modified file content",
		} satisfies NonNullable<DiffEditorProps["options"]>;
	});

	const updateThreadIds = (markdown: string) => {
		// Comment threads live in Markdown comment marks, so only a rich-text document can have
		// them. Skip the headless Tiptap scan for plain-text nodes; their sidebar stays empty.
		if (rootKind !== "rich_text") {
			return;
		}

		const headlessEditor = files_headless_tiptap_editor_create({ initialContent: { markdown } });

		if (headlessEditor._nay) {
			console.error("[FileEditorDiff.updateThreadIds] Error while creating headless editor", {
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

	/**
	 * Port from VS Code: `applyLineChanges(original, modified, diffs): string`
	 * from `vscode/extensions/git/src/staging.ts`
	 **/
	const applyDiffs = (diffs: ReadonlyArray<monaco_editor.ILineChange>): string => {
		if (!editorModelsRef.current) {
			const error = should_never_happen("[FileEditorDiff.applyDiffs] Missing `editorModels`", {
				editorModels: editorModelsRef.current,
			});
			console.error(error);
			throw error;
		}

		const originalLineCount = editorModelsRef.current.original.getLineCount();
		const originalLastLineMaxColumn = editorModelsRef.current.original.getLineMaxColumn(originalLineCount);
		const modifiedLineCount = editorModelsRef.current.modified.getLineCount();
		const modifiedLastLineMaxColumn = editorModelsRef.current.modified.getLineMaxColumn(modifiedLineCount);

		const resultParts: string[] = [];
		let currentLine = 0; // zero-based

		for (const diff of diffs) {
			const isInsertion = diff.originalEndLineNumber === 0;
			const isDeletion = diff.modifiedEndLineNumber === 0;

			let endLine: number;
			let endCharacter: number;

			if (isInsertion) {
				// Correctly handle EOF insertions (Monaco can't point at lineCount + 1).
				if (diff.originalStartLineNumber === originalLineCount) {
					endLine = originalLineCount;
					endCharacter = originalLastLineMaxColumn;
				} else {
					// `+ 1` converts 0-based line indexes to Monaco's 1-based range.
					endLine = diff.originalStartLineNumber + 1;
					endCharacter = 1;
				}
			}
			// isDeletion
			else {
				if (diff.originalEndLineNumber === editorModelsRef.current.original.getLineCount()) {
					// if this is a deletion at the very end of the document,then we need to account
					// for a newline at the end of the last line which may have been deleted
					// https://github.com/microsoft/vscode/issues/59670
					if (diff.originalStartLineNumber <= 1) {
						// Monaco ranges are 1-based; when the deleted block starts on the first line,
						// the unchanged prefix is an empty range at 1:1.
						endLine = 1;
						endCharacter = 1;
					} else {
						endLine = diff.originalStartLineNumber - 1;
						endCharacter = editorModelsRef.current.original.getLineMaxColumn(endLine);
					}
				} else {
					// Regular index normalization to convert 0-based indexes from `diff` to 1-based indexes for Monaco ranges.
					endLine = diff.originalStartLineNumber;
					endCharacter = 1;
				}
			}

			resultParts.push(
				editorModelsRef.current.original.getValueInRange(
					new monaco_Range(
						// `+ 1` converts 0-based line index to Monaco's 1-based range.
						currentLine === originalLineCount ? originalLineCount : currentLine + 1,
						currentLine === originalLineCount ? originalLastLineMaxColumn : 1,
						endLine,
						endCharacter,
					),
				),
			);

			if (!isDeletion) {
				let fromLine: number;
				let fromCharacter: number;

				// if this is an insertion at the very end of the document,
				// then we must start the next range after the last character of the
				// previous line, in order to take the correct eol
				if (isInsertion && diff.originalStartLineNumber === editorModelsRef.current.original.getLineCount()) {
					if (diff.modifiedStartLineNumber <= 1) {
						fromLine = 0;
						fromCharacter = 0;
					} else {
						fromLine = diff.modifiedStartLineNumber - 2;
						fromCharacter = editorModelsRef.current.modified.getLineContent(fromLine + 1).length;
					}
				} else {
					fromLine = diff.modifiedStartLineNumber - 1;
					fromCharacter = 0;
				}

				resultParts.push(
					editorModelsRef.current.modified.getValueInRange(
						new monaco_Range(
							// `+ 1` converts 0-based line index to Monaco's 1-based range.
							fromLine === modifiedLineCount ? modifiedLineCount : fromLine + 1,
							fromLine === modifiedLineCount ? modifiedLastLineMaxColumn : fromCharacter + 1,
							// `+ 1` converts 0-based line index to Monaco's 1-based range.
							diff.modifiedEndLineNumber === modifiedLineCount ? modifiedLineCount : diff.modifiedEndLineNumber + 1,
							diff.modifiedEndLineNumber === modifiedLineCount ? modifiedLastLineMaxColumn : 1,
						),
					),
				);
			}

			currentLine = isInsertion ? diff.originalStartLineNumber : diff.originalEndLineNumber;
		}

		resultParts.push(
			editorModelsRef.current.original.getValueInRange(
				new monaco_Range(
					// `+ 1` converts 0-based line index to Monaco's 1-based range.
					currentLine === originalLineCount ? originalLineCount : currentLine + 1,
					currentLine === originalLineCount ? originalLastLineMaxColumn : 1,
					originalLineCount,
					originalLastLineMaxColumn,
				),
			),
		);

		return resultParts.join("");
	};

	const pushChangeToStagedEditor = (newMarkdown: string) => {
		if (!editorModelsRef.current) {
			const error = should_never_happen("[FileEditorDiff.pushChangeToStagedEditor] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels: editorModelsRef.current,
			});
			console.error(error);
			throw error;
		}

		// Apply edits at the model level so staged content can be updated even when
		// `originalEditable` is false (original editor is read-only).
		editorModelsRef.current.original.pushStackElement();
		editorModelsRef.current.original.applyEdits([
			{ range: editorModelsRef.current.original.getFullModelRange(), text: newMarkdown },
		]);
		editorModelsRef.current.original.pushStackElement();
	};

	const pushChangeToUnstagedEditor = (newMarkdown: string) => {
		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorDiff.pushChangeToUnstagedEditor] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		if (!editorModelsRef.current) {
			const error = should_never_happen("[FileEditorDiff.pushChangeToUnstagedEditor] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels: editorModelsRef.current,
			});
			console.error(error);
			throw error;
		}

		// Prefer editor-level edits so undo/redo behavior stays consistent with Monaco's normal
		// editing workflow while the user can type. Monaco refuses `executeEdits` while the editor
		// is read-only, which is the case when the user lost write permission; the helper then
		// falls back to a model-level edit, otherwise the modified pane would stay empty on mount
		// and keep stale content on remote updates. A model-level edit still fires the model
		// change event, so the programmatic-change counter above stays balanced.
		files_monaco_execute_edits_with_read_only_fallback({
			editor: editorRef.current.getModifiedEditor(),
			model: editorModelsRef.current.modified,
			edits: [{ range: editorModelsRef.current.modified.getFullModelRange(), text: newMarkdown }],
		});
	};

	const updateEditorValues = (editorValues: { stagedMarkdown: string; unstagedMarkdown: string }) => {
		if (editorModelsRef.current && editorRef.current) {
			if (editorModelsRef.current.original.getValue() !== editorValues.stagedMarkdown) {
				ignoredProgrammaticModelChangesRef.current += 1;
				pushChangeToStagedEditor(editorValues.stagedMarkdown);
			}

			if (editorModelsRef.current.modified.getValue() !== editorValues.unstagedMarkdown) {
				ignoredProgrammaticModelChangesRef.current += 1;
				pushChangeToUnstagedEditor(editorValues.unstagedMarkdown);
			}
		}

		setIsDirty(editorValues.stagedMarkdown !== editorContentState.baselineMarkdown);
		setHasUnstagedChanges(editorValues.stagedMarkdown !== editorValues.unstagedMarkdown);
		// Programmatic writes above bump `ignoredProgrammaticModelChangesRef`, so the model change
		// listeners early-return and the draft-sync measure never runs for them. Measure here too.
		setByteSize(
			Math.max(
				files_get_utf8_byte_size(editorValues.stagedMarkdown),
				files_get_utf8_byte_size(editorValues.unstagedMarkdown),
			),
		);
		updateThreadIds(editorValues.stagedMarkdown);
	};

	const upsertPendingUpdate = async () => {
		if (!editorModelsRef.current) {
			return false;
		}

		const stagedMarkdown = editorModelsRef.current.original.getValue();
		const unstagedMarkdown = editorModelsRef.current.modified.getValue();

		// This debounce already reads both branches, so measuring here is only the byte count on top.
		const nextByteSize = Math.max(files_get_utf8_byte_size(stagedMarkdown), files_get_utf8_byte_size(unstagedMarkdown));
		setByteSize(nextByteSize);

		// The server rejects an over-cap upsert anyway, so sending it would only burn a request on
		// every keystroke pause. Stay silent here and let the toolbar badge and its live region
		// report the state: a toast on a 250ms debounce would fire continuously while typing.
		if (nextByteSize > files_MAX_TEXT_CONTENT_BYTES) {
			return false;
		}

		pendingUpdateSyncStatusRef.current = "mutation_in_flight";

		return files_upsert_file_pending_update({
			membershipId,
			nodeId,
			pendingUpdateId,
			stagedText: stagedMarkdown,
			unstagedText: unstagedMarkdown,
		})
			.then((upsertResult) => {
				if (upsertResult._nay) {
					console.error("[FileEditorDiff.upsertPendingUpdateNow] Failed to sync pending updates", {
						nay: upsertResult._nay,
						nodeId,
					});
					return false;
				}

				return true;
			})
			.finally(() => {
				if (pendingUpdateSyncStatusRef.current === "mutation_in_flight") {
					pendingUpdateSyncStatusRef.current = "idle";
				}
			});
	};

	const scheduleUpsertPendingUpdate = () => {
		if (pendingUpdateSyncTimeoutRef.current != null) {
			window.clearTimeout(pendingUpdateSyncTimeoutRef.current);
		}

		pendingUpdateSyncStatusRef.current = "debouncing";
		pendingUpdateSyncTimeoutRef.current = setTimeout(() => {
			pendingUpdateSyncTimeoutRef.current = null;
			pendingUpdateSyncRunner
				.run(async () => upsertPendingUpdate())
				.catch((error) => {
					console.error("[FileEditorDiff.schedulePendingUpdateSync] Error on sync pending updates", {
						error,
					});
				});
		}, 250);
	};

	const flushPendingUpdateUpsertIfNeeded = async () => {
		if (pendingUpdateSyncTimeoutRef.current != null) {
			clearTimeout(pendingUpdateSyncTimeoutRef.current);
			pendingUpdateSyncTimeoutRef.current = null;
		}

		// Wait for older queued/in-flight work first, then force one fresh upsert from the
		// current editor models so save operates on the latest local draft state.
		const flushResult = await pendingUpdateSyncRunner.flush();
		if (flushResult.aborted) {
			return false;
		}

		const runResult = await pendingUpdateSyncRunner.run(async () => upsertPendingUpdate());
		if (runResult.aborted) {
			return false;
		}

		return runResult.value;
	};

	const discardAllDiffs = () => {
		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorDiff.discardAllDiffs] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		if (!editorModelsRef.current) {
			console.error(
				should_never_happen("[FileEditorDiff.discardAllDiffs] Missing `editorModels`", {
					editorModels: editorModelsRef.current,
				}),
			);
			return;
		}

		pushChangeToUnstagedEditor(editorModelsRef.current.original.getValue());
		editorRef.current.focus();
	};

	const acceptAllDiffs = () => {
		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorDiff.acceptAllDiffs] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		if (!editorModelsRef.current) {
			const error = should_never_happen("[FileEditorDiff.acceptAllDiffs] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels: editorModelsRef.current,
			});
			console.error(error);
			throw error;
		}

		const result = editorModelsRef.current.modified.getValue();
		pushChangeToStagedEditor(result);
		editorRef.current.focus();
	};

	/** "Accept all" promotes the unstaged content into staged, so that is the content to measure. */
	const checkAcceptAllFitsSizeCap = useFn(() => {
		const unstagedMarkdown = editorModelsRef.current?.modified.getValue();
		// Let `acceptAllDiffs` report the missing models instead of failing quietly here.
		if (unstagedMarkdown === undefined) return true;
		return check_markdown_fits_size_cap(unstagedMarkdown);
	});

	const doSave = () => {
		if (!editable) return;

		if (!editorModelsRef.current) {
			const error = should_never_happen("[FileEditorDiff.handleClickSave] Missing editor models", {
				editor: editorRef.current,
				editorModels: editorModelsRef.current,
			});
			console.error(error);
			throw error;
		}

		// `isDirty` state can be stale here so we need to check from real raw values
		// when this function is called with "Accept All and save"
		const currentStagedMarkdown = editorModelsRef.current.original.getValue();
		const isDirtyNow = currentStagedMarkdown !== editorContentState.baselineMarkdown;

		if (isSaving || isSyncing || !isDirtyNow) return;

		// Keep the over-cap content out of `flushPendingUpdateUpsertIfNeeded` further down.
		if (!check_markdown_fits_size_cap(currentStagedMarkdown)) return;

		onSave({ flushPendingUpdateUpsertIfNeeded });
	};

	const getCurrentText = useFn(() => {
		return editorModelsRef.current?.original.getValue() ?? editorContentState.stagedMarkdown;
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
					should_never_happen("[FileEditorDiff.handleApplySnapshotText] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			// Surface the refusal: a silent return would leave the editor showing content
			// the restore already replaced on the server.
			if (remoteData.text._nay) {
				console.error("[FileEditorDiff.handleApplySnapshotText] Error while fetching remote data", {
					nay: remoteData.text._nay,
				});
				toast.error("Failed to refresh the editor after the restore. Reload the file.");
				return;
			}

			updateEditorValues({
				stagedMarkdown: remoteData.text._yay,
				unstagedMarkdown: remoteData.text._yay,
			});
		})()
			.catch((err) => {
				console.error("[FileEditorDiff] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	});

	const handleClickSave = useFn(() => {
		if (!editable || isSaving || isSyncing) return;
		doSave();
	});

	const handleClickAcceptAllAndSave = useFn(() => {
		if (!editable || isSaving || isSyncing || !hasUnstagedChanges) return;
		// Check before accepting, not after: accepting copies the unstaged content into the staged
		// model, and an over-cap upsert is rejected, so an accept applied here would look applied
		// but silently disappear on reload.
		if (!checkAcceptAllFitsSizeCap()) return;
		acceptAllDiffs();
		doSave();
	});

	const handleClickAcceptAll = useFn(() => {
		if (!editable || isSaving || isSyncing || !hasUnstagedChanges) return;
		if (!checkAcceptAllFitsSizeCap()) return;
		acceptAllDiffs();
	});

	const handleClickDiscardAll = useFn(() => {
		if (!editable || isSaving || isSyncing || !hasUnstagedChanges) return;
		discardAllDiffs();
	});

	const handleClickSync = useFn(() => {
		if (!editable || isSyncDisabled) return;

		if (!editorModelsRef.current) {
			console.error(
				should_never_happen("[FileEditorDiff.handleClickSync] Missing local draft state", {
					nodeId,
					editor: editorRef.current,
					editorModels: editorModelsRef.current,
				}),
			);
			return;
		}

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			// Drain pending updates writes before sync so an older debounced upsert cannot land
			// after the rebase/persist flow.
			if (pendingUpdateSyncTimeoutRef.current != null) {
				await flushPendingUpdateUpsertIfNeeded();
			} else {
				await pendingUpdateSyncRunner.flush();
			}

			if (!editorModelsRef.current) {
				toast.error("Missing local draft state while syncing");
				return;
			}

			onClickSync({
				stagedMarkdown: editorModelsRef.current.original.getValue(),
				unstagedMarkdown: editorModelsRef.current.modified.getValue(),
			});
		})().catch((error) => {
			console.error("[FileEditorDiff.handleClickSync] Error while preparing sync", {
				error,
				nodeId,
			});
			toast.error("Error while preparing sync");
		});
	});

	const handleClickWidgetAccept = useFn((index: number) => {
		if (!editable) return;

		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorDiff.handleClickWidgetAccept] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			return;
		}

		const diffToApply = editorRef.current.getLineChanges()?.at(index);
		if (!diffToApply) {
			const error = should_never_happen("[FileEditorDiff.handleClickWidgetAccept] Missing `diff`", {
				editor: editorRef.current,
				index,
			});
			console.error(error);
			return;
		}

		const newEditorContent = applyDiffs([diffToApply]);
		pushChangeToStagedEditor(newEditorContent);
		editorRef.current.focus();
	});

	const handleClickWidgetDiscard = useFn((index: number) => {
		if (!editable) return;

		if (!editorRef.current) {
			const error = should_never_happen("[FileEditorDiff.handleClickWidgetDiscard] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			return;
		}

		const diffs = editorRef.current.getLineChanges();
		if (!diffs) {
			const error = should_never_happen("[FileEditorDiff.handleClickWidgetDiscard] Missing `diffs`", {
				editor: editorRef.current,
				index,
			});
			console.error(error);
			return;
		}

		const diffsToKeep = diffs.filter((_, i) => i !== index);
		if (diffsToKeep.length === diffs.length) {
			const error = should_never_happen("[FileEditorDiff.handleClickWidgetDiscard] No diff removed", {
				editor: editorRef.current,
				diffs,
				index,
			});
			console.error(error);
			return;
		}

		const newEditorContent = applyDiffs(diffsToKeep);
		pushChangeToUnstagedEditor(newEditorContent);
		editorRef.current.focus();
	});

	const handleOnMount = useFn<DiffEditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		editor.updateOptions({ readOnly: !editable });
		setMountedModifiedEditor(editor.getModifiedEditor());

		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		const nextModels = {
			original: files_monaco_create_editor_model(initialOriginalMarkdown, monacoLanguageId),
			modified: files_monaco_create_editor_model(initialUnstagedMarkdown, monacoLanguageId),
		};
		setEditorModels(nextModels);
		editor.setModel(nextModels);
		prevModels.forEach((model) => model?.dispose());

		updateThreadIds(initialOriginalMarkdown);

		qaMonacoCleanupRef.current?.();
		const qaOriginalCleanup = app_qa_register_monaco_editor("diffOriginal", editor.getOriginalEditor());
		const qaModifiedCleanup = app_qa_register_monaco_editor("diffModified", editor.getModifiedEditor());
		qaMonacoCleanupRef.current = () => {
			qaOriginalCleanup();
			qaModifiedCleanup();
		};

		monacoListenersDisposeAbortControllers.current?.abort();
		monacoListenersDisposeAbortControllers.current = new AbortController();

		const disposeListenersObjects = [
			editor.getOriginalEditor().onDidChangeModelContent(() => {
				if (ignoredProgrammaticModelChangesRef.current > 0) {
					ignoredProgrammaticModelChangesRef.current -= 1;
					return;
				}

				const nextStagedMarkdown = editorModelsRef.current?.original.getValue();
				if (nextStagedMarkdown != null) {
					updateThreadIds(nextStagedMarkdown);
				}

				if (editorModelsRef.current) {
					const stagedMarkdown = editorModelsRef.current.original.getValue();
					setIsDirty(stagedMarkdown !== editorContentState.baselineMarkdown);
					setHasUnstagedChanges(stagedMarkdown !== editorModelsRef.current.modified.getValue());
				}

				scheduleUpsertPendingUpdate();
			}),
			editor.getModifiedEditor().onDidChangeModelContent(() => {
				if (ignoredProgrammaticModelChangesRef.current > 0) {
					ignoredProgrammaticModelChangesRef.current -= 1;
					return;
				}

				if (editorModelsRef.current) {
					const stagedMarkdown = editorModelsRef.current.original.getValue();
					// Editing the modified/unstaged side should not affect whether the
					// staged branch differs from the baseline.
					setHasUnstagedChanges(stagedMarkdown !== editorModelsRef.current.modified.getValue());
				}

				scheduleUpsertPendingUpdate();
			}),
			editor.onDidUpdateDiff(() => {
				if (!editorRef.current) {
					const error = should_never_happen("[FileEditorDiff.handleOnMount] missing `editorRef.current`", {
						editorRef,
					});
					console.error(error);
					return;
				}

				const changes = editorRef.current.getLineChanges() ?? [];

				const modifiedEditor = editorRef.current.getModifiedEditor();
				const originalEditor = editorRef.current.getOriginalEditor();
				const modifiedModel = editorModelsRef.current?.modified;
				const originalModel = editorModelsRef.current?.original;
				if (!originalEditor || !modifiedEditor || !modifiedModel || !originalModel) {
					const error = should_never_happen("[FileEditorDiff.handleOnMount] missing deps", {
						originalEditor,
						modifiedEditor,
						modifiedModel,
						originalModel,
					});
					console.error(error);
					return;
				}

				const modifiedEditorDomNode = modifiedEditor.getDomNode();
				if (!modifiedEditorDomNode) {
					const error = should_never_happen(
						"[FileEditorDiff.handleOnMount modifiedEditor.getDomNode] Missing `modifiedEditorDomNode`",
						{
							modifiedEditor,
						},
					);
					console.error(error);
					return;
				}

				const newContentWidgets = [...contentWidgetsRef.current];

				// Remove widgets for changes that no longer exist
				const removedContentWidgets = newContentWidgets.splice(changes.length);
				for (const widget of removedContentWidgets) {
					widget.dispose();
				}

				// Create/update widgets
				changes.forEach((change, i) => {
					const lineNumber = change.modifiedEndLineNumber
						? change.modifiedStartLineNumber
						: change.originalStartLineNumber || 1;

					// Select the editor based on the changed lines to check if we are inserting or deleting text
					// to make sure the widget is correctly aligned with the diff.
					const isDeletion = change.modifiedEndLineNumber === 0;
					const targetEditor = isDeletion ? originalEditor : modifiedEditor;

					const existingWidget = newContentWidgets.at(i);

					if (existingWidget) {
						existingWidget.args.index = i;
						// If the widget for this index already exists,
						// and should target the same editor, update the line number
						if (existingWidget.args.editor === targetEditor) {
							existingWidget.updateLine(lineNumber);
							return; // continue;
						}

						// Otherwise, dispose the widget so that it can be recreated with
						// the new line number and target editor
						existingWidget.dispose();
					}

					const newWidget = new FileEditorDiffWidgetAcceptDiscard_Monaco({
						editor: targetEditor,
						anchorName,
						index: i,
						lineNumber,
					});
					targetEditor.addContentWidget(newWidget);

					if (existingWidget) {
						newContentWidgets[i] = newWidget;
					} else {
						newContentWidgets.push(newWidget);
					}
				});

				setContentWidgets(newContentWidgets);
			}),
		];

		monacoListenersDisposeAbortControllers.current.signal.addEventListener("abort", () => {
			for (const disposable of disposeListenersObjects) {
				disposable.dispose();
			}
		});
	});

	// A hidden tab can miss monaco's async diff update when the pending update doc dies in another tab:
	// the throttled worker roundtrip can fail ("no diff result available") and never re-runs once
	// the model content has settled, leaving stale hunk widgets over already-converged identical
	// models. On foregrounding, detect that settled-but-stale state and rebuild the diff session
	// so the editor always lands in the plain live-file view.
	const handleVisibilityChangeDiffRecovery = useFn(() => {
		if (document.visibilityState !== "visible") return;

		const editor = editorRef.current;
		const models = editorModelsRef.current;
		if (!editor || !models) return;

		const isLiveFileContentState =
			editorContentState.baselineMarkdown === editorContentState.stagedMarkdown &&
			editorContentState.stagedMarkdown === editorContentState.unstagedMarkdown;
		const hasSettledIdenticalModels = models.original.getValue() === models.modified.getValue();
		if (!isLiveFileContentState || !hasSettledIdenticalModels || contentWidgetsRef.current.length === 0) {
			return;
		}

		for (const widget of contentWidgetsRef.current) {
			widget.dispose();
		}
		setContentWidgets([]);

		// Re-setting the same models rebuilds the diff session, so the broken diff computation
		// re-runs against the identical models and clears the stale diff rendering.
		const viewState = editor.saveViewState();
		editor.setModel(models);
		if (viewState) {
			editor.restoreViewState(viewState);
		}
	});

	// Reconcile the remote editor content state with the local editor values,
	// Needs to be a layout effect to ensure the `isDirty` state calculated
	// when the editor model value changes is updated before paint.
	useLayoutEffect(() => {
		if (!editorModels || pendingUpdateSyncStatusRef.current !== "idle") {
			return;
		}

		const previousRemoteEditorContentState = lastAppliedRemoteEditorContentStateRef.current;
		if (editor_content_states_match(previousRemoteEditorContentState, editorContentState)) {
			return;
		}

		const mergedStagedBranchResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc: previousRemoteEditorContentState.stagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.stagedYjsDoc,
			localText: editorModels.original.getValue(),
			rootKind,
		});
		if (mergedStagedBranchResult._nay) {
			console.error("[FileEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile staged branch", {
				nay: mergedStagedBranchResult._nay,
				nodeId,
			});
			return;
		}

		const mergedUnstagedBranchResult = files_yjs_reconcile_branch_with_local_text({
			previousRemoteYjsDoc: previousRemoteEditorContentState.unstagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.unstagedYjsDoc,
			localText: editorModels.modified.getValue(),
			rootKind,
		});
		if (mergedUnstagedBranchResult._nay) {
			console.error("[FileEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile unstaged branch", {
				nay: mergedUnstagedBranchResult._nay,
				nodeId,
			});
			return;
		}

		updateEditorValues({
			stagedMarkdown: mergedStagedBranchResult._yay.mergedText,
			unstagedMarkdown: mergedUnstagedBranchResult._yay.mergedText,
		});
		lastAppliedRemoteEditorContentStateRef.current = editorContentState;
	}, [editorContentState, editorModels]);

	// The permission query can resolve or change after Monaco mounts. Update the live editor instead
	// of rebuilding its models, which would drop the cursor and undo history.
	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: !editable });
	}, [editable]);

	useEffect(() => {
		// In dev, React StrictMode may mount/unmount/mount to detect side effects.
		// Ensure we don't permanently disable host registration after the first cleanup.
		isUnmountingRef.current = false;

		document.addEventListener("visibilitychange", handleVisibilityChangeDiffRecovery);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChangeDiffRecovery);

			monacoListenersDisposeAbortControllers.current?.abort();
			monacoListenersDisposeAbortControllers.current = null;

			isUnmountingRef.current = true;

			for (const widget of contentWidgetsRef.current) {
				widget.dispose();
			}
			setContentWidgets([]);

			editorRef.current?.dispose();
			editorRef.current = null;

			editorModelsRef.current?.original.dispose();
			editorModelsRef.current?.modified.dispose();
			setEditorModels(null);

			if (pendingUpdateSyncTimeoutRef.current != null) {
				window.clearTimeout(pendingUpdateSyncTimeoutRef.current);
				pendingUpdateSyncTimeoutRef.current = null;
			}

			qaMonacoCleanupRef.current?.();
			qaMonacoCleanupRef.current = null;
		};
	}, []);

	return (
		<>
			<div
				className={cn("FileEditorDiff" satisfies FileEditorDiff_ClassNames, className)}
				aria-label="File diff editor"
				style={sx({
					"--FileEditorDiff-anchor-name": anchorName,
				} satisfies Partial<FileEditorDiff_CssVars>)}
			>
				<FileEditorDiffToolbarActions
					byteSize={byteSize}
					editable={editable}
					isSaveDisabled={isSaveDisabled}
					isSyncDisabled={isSyncDisabled || isSaving}
					isAcceptAllDisabled={isAcceptAllDisabled}
					isAcceptAllAndSaveDisabled={isAcceptAllAndSaveDisabled}
					isDiscardAllDisabled={isDiscardAllDisabled}
					nodeId={nodeId}
					sessionId={presenceStore.localSessionId}
					toolbarPortalHost={toolbarPortalHost}
					getCurrentText={getCurrentText}
					onApplySnapshotText={handleApplySnapshotText}
					onClickSave={handleClickSave}
					onClickSync={handleClickSync}
					onClickAcceptAll={handleClickAcceptAll}
					onClickAcceptAllAndSave={handleClickAcceptAllAndSave}
					onClickDiscardAll={handleClickDiscardAll}
				/>
				<FileEditorDiffTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<div className={"FileEditorDiff-editor" satisfies FileEditorDiff_ClassNames}>
					<DiffEditor
						height="100%"
						theme={app_monaco_THEME_NAME_DARK}
						onMount={handleOnMount}
						original={initialOriginalMarkdown}
						modified={initialUnstagedMarkdown}
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
			{editable
				? contentWidgets.map((widget) =>
						createPortal(
							<FileEditorDiffWidgetAcceptDiscard
								onAccept={() => handleClickWidgetAccept(widget.args.index)}
								onDiscard={() => handleClickWidgetDiscard(widget.args.index)}
							/>,
							widget.node,
							widget.id,
						),
					)
				: null}
		</>
	);
});

export const FileEditorDiff = memo(function FileEditorDiff(props: FileEditorDiff_Props) {
	const {
		nodeId,
		editable,
		rootKind,
		pendingUpdateId,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		className,
		serverSequence,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const convex = useConvex();
	const pendingUpdateResult = useStableQuery(api.files_pending_updates.get_file_pending_update, {
		membershipId,
		nodeId,
		pendingUpdateId,
	});
	// Move-only pending update docs carry no content to diff: treat them as "no pending update"
	// so the editor degrades to the plain live-file view. Loading (`undefined`) passes through.
	const pendingUpdate =
		pendingUpdateResult && !files_pending_update_has_yjs_content(pendingUpdateResult) ? null : pendingUpdateResult;
	const pendingUpdateLastSequenceSaved = useQuery(
		api.files_pending_updates.get_file_pending_update_last_sequence_saved,
		{
			membershipId,
			nodeId,
		},
	);

	const [fileContentData, setFileContentData] = useState<
		Awaited<ReturnType<typeof files_fetch_file_yjs_state_and_text>> | undefined
	>(undefined);
	// "refused" renders the refusal state instead of the editor: a fabricated empty stand-in
	// document would let every later Save diff the user's typing against emptiness.
	const [remoteEditorContentState, setRemoteEditorContentState] = useState<
		RemoteEditorContentState | "refused" | undefined
	>(undefined);
	const [isSaving, setIsSaving] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);
	const currentPendingUpdateId = pendingUpdate?._id ?? pendingUpdateId;

	const editorBaseYjsSequence = file_editor_diff_editor_base_yjs_sequence({
		pendingUpdate,
		fileContentYjsSequence: fileContentData?.yjsSequence,
		remoteYjsSequence: remoteEditorContentState === "refused" ? undefined : remoteEditorContentState?.yjsSequence,
		lastSequenceSaved: pendingUpdateLastSequenceSaved?.lastSequenceSaved,
	});

	const isSyncDisabled =
		!editable ||
		file_editor_diff_is_sync_disabled({
			isSyncing,
			isSaving,
			serverSequence,
			editorBaseYjsSequence,
		});

	/**
	 * The container for the tiptap hoisted elements.
	 * Used by the bubble to allow it to close when clicking on
	 * focusable elements in the file because it checks for the parent
	 * element to contain the focus relatedTarget and if the bubble
	 * is hoisted in the body, the body will always contain the focus relatedTarget
	 * preventing the bubble from closing.
	 */
	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);

	const setRemoteEditorContentStateIfNotMatch = (nextRemoteEditorContentState: RemoteEditorContentState) => {
		setRemoteEditorContentState((currentRemoteEditorContentState) => {
			if (
				currentRemoteEditorContentState &&
				currentRemoteEditorContentState !== "refused" &&
				editor_content_states_match(currentRemoteEditorContentState, nextRemoteEditorContentState)
			) {
				return currentRemoteEditorContentState;
			}

			return nextRemoteEditorContentState;
		});
	};

	const handleSave = useFn<FileEditorDiffInner_Props["onSave"]>(({ flushPendingUpdateUpsertIfNeeded }) => {
		if (!editable) return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const didSyncPendingUpdate = await flushPendingUpdateUpsertIfNeeded();
			if (!didSyncPendingUpdate) {
				toast.error("Failed to sync pending updates before save");
				return;
			}

			const savePendingResult = await convex.action(api.files_pending_updates.save_file_pending_update, {
				membershipId,
				nodeId,
				pendingUpdateId: currentPendingUpdateId,
			});
			if (savePendingResult._nay) {
				// "Stale save" means another tab's save advanced the pending update doc before this
				// save's read landed; nothing was written and the reactive queries already show the truth, so
				// resolve silently (like handleClickSync) — the user can just click Save again.
				if (savePendingResult._nay.message === "Stale save") {
					return;
				}
				toast.error(savePendingResult._nay.message ?? "Failed to save pending updates");
				return;
			}

			const [nextFileContentData] = await Promise.allSettled([
				files_fetch_file_yjs_state_and_text({
					membershipId,
					nodeId,
				}),
				// Fetch also the pending updates query to ensure we perform
				// the state cleanups only after we are sure the data is available
				// in the local convex cache.
				convex.query(api.files_pending_updates.get_file_pending_update, {
					membershipId,
					nodeId,
					pendingUpdateId: currentPendingUpdateId,
				}),
			]);

			if (nextFileContentData.status === "fulfilled") {
				const nextValue = nextFileContentData.value;
				if (
					nextValue &&
					savePendingResult._yay.newSequence != null &&
					nextValue.yjsSequence < savePendingResult._yay.newSequence
				) {
					// Keep the current editor state until a real live snapshot catches up.
					// Do not bump stale content to the saved sequence; that would make old
					// markdown look authoritative and can leave the editor dirty after save.
					return;
				} else {
					setFileContentData(nextValue);
				}
			}
		})()
			.catch((error) => {
				console.error("[FileEditorDiff.handleSave] Failed to refresh file content after save", {
					error,
					nodeId,
				});
			})
			.finally(() => {
				setIsSaving(false);
			});
	});

	const handleClickSync = useFn<FileEditorDiffInner_Props["onClickSync"]>((editorValues) => {
		if (!editable || isSyncing) return;

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			if (!remoteEditorContentState) {
				return Result({
					_nay: {
						message: "Missing remote editor state while syncing",
					},
				});
			}

			if (remoteEditorContentState === "refused") {
				return Result({
					_nay: {
						message: "The file content could not be read safely",
					},
				});
			}

			const nextFileContentData = await files_fetch_file_yjs_state_and_text({
				membershipId,
				nodeId,
			});
			if (!nextFileContentData) {
				return Result({
					_nay: {
						message: "Missing file content after sync",
					},
				});
			}
			if (nextFileContentData.text._nay) {
				return Result({
					_nay: {
						message: "Failed to reconstruct latest file content while syncing",
						cause: nextFileContentData.text._nay,
					},
				});
			}

			const rebasedStagedBranchResult = files_yjs_rebase_branch_with_local_text({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextFileContentData.yjsDoc,
				previousBranchYjsDoc: remoteEditorContentState.stagedYjsDoc,
				localText: editorValues.stagedMarkdown,
				rootKind,
			});
			if (rebasedStagedBranchResult._nay) {
				return Result({
					_nay: {
						message: "Failed to rebase staged branch while syncing",
						cause: rebasedStagedBranchResult._nay,
					},
				});
			}

			const rebasedUnstagedBranchResult = files_yjs_rebase_branch_with_local_text({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextFileContentData.yjsDoc,
				previousBranchYjsDoc: remoteEditorContentState.unstagedYjsDoc,
				localText: editorValues.unstagedMarkdown,
				rootKind,
			});
			if (rebasedUnstagedBranchResult._nay) {
				return Result({
					_nay: {
						message: "Failed to rebase unstaged branch while syncing",
						cause: rebasedUnstagedBranchResult._nay,
					},
				});
			}

			// Stage the three rebased states page by page and finish with the ids-only action.
			const persistRebasedStateResult = await files_persist_file_pending_update_rebased_state({
				membershipId,
				nodeId,
				pendingUpdateId: currentPendingUpdateId,
				baseYjsSequence: nextFileContentData.yjsSequence,
				baseYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(nextFileContentData.yjsDoc)),
				stagedBranchYjsUpdate: files_u8_to_array_buffer(
					encodeStateAsUpdate(rebasedStagedBranchResult._yay.rebasedBranchYjsDoc),
				),
				unstagedBranchYjsUpdate: files_u8_to_array_buffer(
					encodeStateAsUpdate(rebasedUnstagedBranchResult._yay.rebasedBranchYjsDoc),
				),
			});
			// "Not found" means the pending update doc was discarded, fully accepted, or replaced
			// by a newer proposal in another tab while this sync was in flight (persistence is
			// update-only and patches only the exact synced doc). "Stale save" means another tab's
			// save advanced the doc past this sync's captured base. Both are benign races, not
			// errors: fall through so the refreshed queries below let the editor converge.
			if (
				persistRebasedStateResult._nay &&
				persistRebasedStateResult._nay.message !== "Not found" &&
				persistRebasedStateResult._nay.message !== "Stale save"
			) {
				return persistRebasedStateResult;
			}

			// Fetch the pending updates query before publishing the refreshed file content so
			// sync cleanup waits for the authoritative pending-edit cache state to converge.
			await Promise.allSettled([
				convex.query(api.files_pending_updates.get_file_pending_update, {
					membershipId,
					nodeId,
					pendingUpdateId: currentPendingUpdateId,
				}),
			]);

			setFileContentData(nextFileContentData);

			return Result({ _yay: null });
		})()
			.then((result) => {
				if (result._nay) {
					console.error("[FileEditorDiff.handleClickSync] Sync failed", {
						error: result._nay,
						nodeId,
					});
					toast.error(result._nay.message ?? "Failed to sync");
				}
			})
			.catch((error) => {
				console.error("[FileEditorDiff.handleClickSync] Error while syncing", {
					error,
					nodeId,
				});
				toast.error("Error while syncing");
			})
			.finally(() => {
				setIsSyncing(false);
			});
	});

	// Reset state when `nodeId` changes
	useLayoutEffect(() => {
		setFileContentData(undefined);
		setRemoteEditorContentState(undefined);
		setIsSaving(false);
		setIsSyncing(false);
	}, [nodeId]);

	// Fetch file content for initial load and `nodeId` changes
	useEffect(() => {
		let didCancel = false;

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const nextFileContentData = await files_fetch_file_yjs_state_and_text({
				membershipId,
				nodeId,
			});
			if (didCancel) return;

			setFileContentData(nextFileContentData);
		})().catch((error) => {
			if (didCancel) return;

			console.error("[FileEditorDiff.useLayoutEffect] Failed to fetch file content data", error);
			setFileContentData(null);
		});

		return () => {
			didCancel = true;
		};
	}, [nodeId]);

	// Refetch live file content only after a pending-edit save marker advances past the local file snapshot.
	useEffect(() => {
		if (
			pendingUpdate !== null ||
			pendingUpdateLastSequenceSaved == null ||
			fileContentData == null ||
			pendingUpdateLastSequenceSaved.lastSequenceSaved <= fileContentData.yjsSequence
		) {
			return;
		}

		let didCancel = false;

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const nextFileContentData = await files_fetch_file_yjs_state_and_text({
				membershipId,
				nodeId,
			});
			if (didCancel) return;

			setFileContentData(nextFileContentData);
		})().catch((error) => {
			if (didCancel) return;

			console.error("[FileEditorDiff.savedSequenceRefetch] Failed to refetch file content data", {
				error,
				nodeId,
				lastSequenceSaved: pendingUpdateLastSequenceSaved.lastSequenceSaved,
			});
		});

		return () => {
			didCancel = true;
		};
	}, [fileContentData, nodeId, pendingUpdate, pendingUpdateLastSequenceSaved]);

	// Bootstrap the remote editor content state once `fileContentData` and `pendingUpdate` are
	// ready. The pending branch loads paged states, so it is async with a cancel guard.
	useLayoutEffect(() => {
		if (remoteEditorContentState !== undefined || pendingUpdate === undefined || fileContentData === undefined) {
			return;
		}

		if (pendingUpdate) {
			let didCancel = false;

			// Use an async IIFE because the React compiler has problems with try catch finally blocks
			(async (/* iife */) => {
				const pendingUpdateInitialEditorContentState = await create_editor_content_state_from_pending_update({
					membershipId,
					pendingUpdate,
					rootKind,
				});
				if (didCancel) return;
				if (pendingUpdateInitialEditorContentState._yay) {
					setRemoteEditorContentStateIfNotMatch(pendingUpdateInitialEditorContentState._yay);
					return;
				}

				// Refuse instead of falling through to the committed content or a fabricated empty
				// state: both stand-ins hide the user's proposal and let Save overwrite it.
				console.error("[FileEditorDiff] Failed to reconstruct initial remote editor content state", {
					error: pendingUpdateInitialEditorContentState._nay,
					nodeId,
				});
				setRemoteEditorContentState("refused");
			})().catch((error) => {
				if (didCancel) return;
				console.error("[FileEditorDiff.bootstrap] Unexpected error while loading the pending state", {
					error,
					nodeId,
				});
				setRemoteEditorContentState("refused");
			});

			return () => {
				didCancel = true;
			};
		}

		if (fileContentData) {
			const nextRemoteEditorContentState = create_editor_content_state_from_file_content_data(fileContentData);
			if (nextRemoteEditorContentState) {
				setRemoteEditorContentStateIfNotMatch(nextRemoteEditorContentState);
				setIsSyncing(false);
				return;
			}
		}

		// A missing or refused content read renders the refusal state, never three fabricated
		// empty documents: every downstream comparison would diff against fabricated emptiness.
		setRemoteEditorContentState("refused");
	}, [fileContentData, membershipId, nodeId, pendingUpdate, remoteEditorContentState, rootKind]);

	// Needs to be a layout effect so sync/save convergence updates the remote editor
	// state before paint, avoiding a brief render with stale button enablement. The pending
	// branch loads paged states, so its update lands one frame later with a cancel guard.
	useLayoutEffect(() => {
		if (!remoteEditorContentState || remoteEditorContentState === "refused") {
			return;
		}
		// Narrow for the closures below: the guard above excluded the refused marker.
		const currentRemoteEditorContentState = remoteEditorContentState;

		if (pendingUpdate) {
			let didCancel = false;

			// Use an async IIFE because the React compiler has problems with try catch finally blocks
			(async (/* iife */) => {
				const nextRemoteEditorContentState = await create_editor_content_state_from_pending_update({
					membershipId,
					pendingUpdate,
					rootKind,
				});
				if (didCancel) return;
				if (nextRemoteEditorContentState._nay) {
					// Keep the last good state: it holds real decoded content, not a stand-in.
					console.error("[FileEditorDiff.pendingUpdateReconcile] Failed to reconstruct remote editor content state", {
						error: nextRemoteEditorContentState._nay,
						nodeId,
					});
					setIsSyncing(false);
					return;
				}
				if (!editor_content_states_match(currentRemoteEditorContentState, nextRemoteEditorContentState._yay)) {
					setRemoteEditorContentState(nextRemoteEditorContentState._yay);
				}

				setIsSyncing(false);
			})().catch((error) => {
				if (didCancel) return;
				console.error("[FileEditorDiff.pendingUpdateReconcile] Unexpected error while loading the pending state", {
					error,
					nodeId,
				});
				setIsSyncing(false);
			});

			return () => {
				didCancel = true;
			};
		}

		if (!fileContentData) {
			setIsSyncing(false);
			return;
		}

		if (
			!file_editor_diff_should_apply_live_file_content_state({
				pendingUpdate,
				isSaving,
				fileContentYjsSequence: fileContentData.yjsSequence,
				lastSequenceSaved: pendingUpdateLastSequenceSaved?.lastSequenceSaved,
			})
		) {
			setIsSyncing(false);
			return;
		}

		const nextRemoteEditorContentState = create_editor_content_state_from_file_content_data(fileContentData);
		if (!nextRemoteEditorContentState) {
			setIsSyncing(false);
			return;
		}

		if (!editor_content_states_match(currentRemoteEditorContentState, nextRemoteEditorContentState)) {
			setRemoteEditorContentState(nextRemoteEditorContentState);
		}

		setIsSyncing(false);
	}, [
		fileContentData,
		isSaving,
		membershipId,
		nodeId,
		pendingUpdate,
		pendingUpdateLastSequenceSaved?.lastSequenceSaved,
		remoteEditorContentState,
		rootKind,
	]);

	// Keep this hardcoded while debugging the diff editor loading state.
	const forceLoading = false;

	// Never mount the editor over a refused read: a fabricated empty state is legal in
	// shape, so Save would diff the user's typing against emptiness and overwrite real content.
	return forceLoading ||
		hoistingContainer == null ||
		pendingUpdate === undefined ||
		fileContentData === undefined ||
		remoteEditorContentState === undefined ? (
		<FileEditorDiffSkeleton />
	) : remoteEditorContentState === "refused" ? (
		<div className={cn("FileEditorDiff" satisfies FileEditorDiff_ClassNames, className)}>
			<div role="alert" className={"FileEditorDiff-refusal" satisfies FileEditorDiff_ClassNames}>
				This file's changes could not be read safely, so the diff editor stays closed to protect them. Reload the file
				or contact support if this keeps happening.
			</div>
		</div>
	) : (
		<FileEditorDiffInner
			key={nodeId}
			{...props}
			className={className}
			nodeId={nodeId}
			pendingUpdateId={currentPendingUpdateId}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			hoistingContainer={hoistingContainer}
			editorContentState={remoteEditorContentState}
			isSaving={isSaving}
			isSyncing={isSyncing}
			isSyncDisabled={isSyncDisabled}
			onSave={handleSave}
			onClickSync={handleClickSync}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
});
// #endregion root

// #region tests
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("file_editor_diff_sync_gate", () => {
		test("does not enable sync during post-save convergence window", () => {
			const duringSave = file_editor_diff_is_sync_disabled({
				isSyncing: false,
				isSaving: true,
				serverSequence: 6,
				editorBaseYjsSequence: file_editor_diff_editor_base_yjs_sequence({
					pendingUpdate: null,
					fileContentYjsSequence: 5,
					remoteYjsSequence: 5,
					lastSequenceSaved: 6,
				}),
			});
			expect(duringSave).toBe(true);

			const afterSaveBeforeFetch = file_editor_diff_is_sync_disabled({
				isSyncing: false,
				isSaving: false,
				serverSequence: 6,
				editorBaseYjsSequence: file_editor_diff_editor_base_yjs_sequence({
					pendingUpdate: null,
					fileContentYjsSequence: 5,
					remoteYjsSequence: 5,
					lastSequenceSaved: 6,
				}),
			});
			expect(afterSaveBeforeFetch).toBe(true);

			const afterSaveWithBumpedFile = file_editor_diff_is_sync_disabled({
				isSyncing: false,
				isSaving: false,
				serverSequence: 6,
				editorBaseYjsSequence: file_editor_diff_editor_base_yjs_sequence({
					pendingUpdate: null,
					fileContentYjsSequence: 6,
					remoteYjsSequence: 5,
					lastSequenceSaved: 6,
				}),
			});
			expect(afterSaveWithBumpedFile).toBe(true);
		});

		test("enables sync only when server sequence is ahead of editor base", () => {
			const hasRemoteDrift = file_editor_diff_is_sync_disabled({
				isSyncing: false,
				isSaving: false,
				serverSequence: 7,
				editorBaseYjsSequence: file_editor_diff_editor_base_yjs_sequence({
					pendingUpdate: { _id: "pending" },
					fileContentYjsSequence: 6,
					remoteYjsSequence: 6,
					lastSequenceSaved: 6,
				}),
			});
			expect(hasRemoteDrift).toBe(false);

			const inSync = file_editor_diff_is_sync_disabled({
				isSyncing: false,
				isSaving: false,
				serverSequence: 6,
				editorBaseYjsSequence: file_editor_diff_editor_base_yjs_sequence({
					pendingUpdate: null,
					fileContentYjsSequence: 6,
					remoteYjsSequence: 6,
					lastSequenceSaved: 6,
				}),
			});
			expect(inSync).toBe(true);
		});

		test("applies live file content only after post-save sequence convergence", () => {
			const stalePostSaveFetch = file_editor_diff_should_apply_live_file_content_state({
				pendingUpdate: null,
				isSaving: false,
				fileContentYjsSequence: 5,
				lastSequenceSaved: 6,
			});
			expect(stalePostSaveFetch).toBe(false);

			const currentPostSaveFetch = file_editor_diff_should_apply_live_file_content_state({
				pendingUpdate: null,
				isSaving: false,
				fileContentYjsSequence: 6,
				lastSequenceSaved: 6,
			});
			expect(currentPostSaveFetch).toBe(true);
		});

		test("does not reject legitimate empty live content by content shape", () => {
			const shouldApplyEmptyContentAtCurrentSequence = file_editor_diff_should_apply_live_file_content_state({
				pendingUpdate: null,
				isSaving: false,
				fileContentYjsSequence: 7,
				lastSequenceSaved: 6,
			});

			expect(shouldApplyEmptyContentAtCurrentSequence).toBe(true);
		});
	});
}
// #endregion tests
