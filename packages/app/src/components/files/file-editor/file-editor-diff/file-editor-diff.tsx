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
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { CheckCheck, RefreshCcw, Save, SaveAll, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { useFn, useStateRef } from "@/hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import {
	files_monaco_create_editor_model,
	files_headless_tiptap_editor_create,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_fetch_file_yjs_state_and_markdown,
	files_u8_to_array_buffer,
	files_yjs_reconcile_branch_with_local_markdown,
	files_yjs_rebase_branch_with_local_markdown,
} from "@/lib/files.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { Result } from "../../../../lib/errors-as-values-utils.ts";
import { FileEditorDiffSkeleton } from "./file-editor-diff-skeleton.tsx";
import { FileEditorMonacoTopViewZone } from "../file-editor-monaco-top-view-zone.tsx";

// #region toolbar
type FileEditorDiffToolbarActions_ClassNames =
	| "FileEditorDiffToolbarActions"
	| "FileEditorDiffToolbarActions-button"
	| "FileEditorDiffToolbarActions-button-accept-all"
	| "FileEditorDiffToolbarActions-button-accept-all-and-save"
	| "FileEditorDiffToolbarActions-button-discard-all"
	| "FileEditorDiffToolbarActions-icon";

type FileEditorDiffToolbarActions_Props = {
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	isAcceptAllDisabled: boolean;
	isAcceptAllAndSaveDisabled: boolean;
	isDiscardAllDisabled: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	toolbarPortalHost: HTMLElement;
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown: (markdown: string) => void;
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
		isSaveDisabled,
		isSyncDisabled,
		isAcceptAllDisabled,
		isAcceptAllAndSaveDisabled,
		isDiscardAllDisabled,
		nodeId,
		sessionId,
		toolbarPortalHost,
		getCurrentMarkdown,
		onApplySnapshotMarkdown,
		onClickSave,
		onClickSync,
		onClickAcceptAll,
		onClickAcceptAllAndSave,
		onClickDiscardAll,
	} = props;

	return createPortal(
		<div
			role="group"
			aria-label="Diff editor actions"
			className={cn("FileEditorDiffToolbarActions" satisfies FileEditorDiffToolbarActions_ClassNames)}
		>
			<MyButton
				variant="ghost"
				className={cn("FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames)}
				disabled={isSaveDisabled}
				onClick={onClickSave}
			>
				<MyButtonIcon className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}>
					<Save />
				</MyButtonIcon>
				Save
			</MyButton>
			<MyButton
				variant="ghost"
				className={cn("FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames)}
				disabled={isSyncDisabled}
				onClick={onClickSync}
			>
				<MyButtonIcon className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}>
					<RefreshCcw />
				</MyButtonIcon>
				Sync
			</MyButton>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-accept-all" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				disabled={isAcceptAllDisabled}
				onClick={onClickAcceptAll}
			>
				<MyButtonIcon className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}>
					<CheckCheck />
				</MyButtonIcon>
				Accept all
			</MyButton>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-accept-all-and-save" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				disabled={isAcceptAllAndSaveDisabled}
				onClick={onClickAcceptAllAndSave}
			>
				<MyButtonIcon className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}>
					<SaveAll />
				</MyButtonIcon>
				Accept all + save
			</MyButton>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorDiffToolbarActions-button" satisfies FileEditorDiffToolbarActions_ClassNames,
					"FileEditorDiffToolbarActions-button-discard-all" satisfies FileEditorDiffToolbarActions_ClassNames,
				)}
				disabled={isDiscardAllDisabled}
				onClick={onClickDiscardAll}
			>
				<MyButtonIcon className={cn("FileEditorDiffToolbarActions-icon" satisfies FileEditorDiffToolbarActions_ClassNames)}>
					<Trash2 />
				</MyButtonIcon>
				Discard all
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

type FileEditorDiff_ClassNames = "FileEditorDiff" | "FileEditorDiff-editor" | "FileEditorDiff-anchor";

type FileEditorDiff_CssVars = {
	"--FileEditorDiff-anchor-name": string;
};

export type FileEditorDiff_Props = {
	className?: string;
	nodeId: app_convex_Id<"files_nodes">;
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

function editor_content_states_match(left: RemoteEditorContentState, right: RemoteEditorContentState) {
	return (
		left.baselineMarkdown === right.baselineMarkdown &&
		left.stagedMarkdown === right.stagedMarkdown &&
		left.unstagedMarkdown === right.unstagedMarkdown &&
		left.yjsSequence === right.yjsSequence
	);
}

function create_editor_content_state_from_pending_update(pendingUpdate: app_convex_Doc<"files_pending_updates">) {
	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.baseYjsUpdate);
	const stagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.stagedBranchYjsUpdate);
	const unstagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate);

	const baseMarkdown = files_yjs_doc_get_markdown({ yjsDoc: baseYjsDoc });
	const stagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: stagedYjsDoc });
	const unstagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: unstagedYjsDoc });

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
	fileContentData: NonNullable<Awaited<ReturnType<typeof files_fetch_file_yjs_state_and_markdown>>>,
) {
	if (fileContentData.markdown._nay) {
		return null;
	}

	return {
		baselineYjsDoc: fileContentData.yjsDoc,
		baselineMarkdown: fileContentData.markdown._yay,
		stagedYjsDoc: files_yjs_doc_clone({ yjsDoc: fileContentData.yjsDoc }),
		stagedMarkdown: fileContentData.markdown._yay,
		unstagedYjsDoc: files_yjs_doc_clone({ yjsDoc: fileContentData.yjsDoc }),
		unstagedMarkdown: fileContentData.markdown._yay,
		yjsSequence: fileContentData.yjsSequence,
	} satisfies RemoteEditorContentState;
}

const FileEditorDiffInner = memo(function FileEditorDiffInner(props: FileEditorDiffInner_Props) {
	const {
		className,
		nodeId,
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

	const convex = useConvex();

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

	/**
	 * We can allow updated to the remote `pendingUpdate` to write in the editor
	 * only if there's no other local edit being sent to the server, otherwise
	 * we might end-up in situations where the user edits are reverted by the sync.
	 */
	const pendingUpdateSyncStatusRef = useRef<"idle" | "debouncing" | "mutation_in_flight">("idle");

	const isSaveDisabled = isSaving || isSyncing || !isDirty;
	const isAcceptAllDisabled = isSaving || isSyncing || !hasUnstagedChanges;
	const isAcceptAllAndSaveDisabled = isSaving || isSyncing || !hasUnstagedChanges;
	const isDiscardAllDisabled = isSaving || isSyncing || !hasUnstagedChanges;
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
		} satisfies NonNullable<DiffEditorProps["options"]>;
	});

	const updateThreadIds = (markdown: string) => {
		const headlessEditor = files_headless_tiptap_editor_create({ initialContent: { markdown } });

		if (headlessEditor._nay) {
			console.error("[FileEditorDiff.updateThreadIds] Error while creating headless editor", {
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

		// The modified/unstaged editor is writable; use editor-level edits so undo/redo behavior
		// stays consistent with Monaco's normal editing workflow.
		const modifiedEditor = editorRef.current.getModifiedEditor();
		modifiedEditor.pushUndoStop();
		modifiedEditor.executeEdits("app_files_sync", [
			{ range: editorModelsRef.current.modified.getFullModelRange(), text: newMarkdown },
		]);
		modifiedEditor.pushUndoStop();
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
		updateThreadIds(editorValues.stagedMarkdown);
	};

	const upsertPendingUpdate = async () => {
		if (!editorModelsRef.current) {
			return false;
		}

		const stagedMarkdown = editorModelsRef.current.original.getValue();
		const unstagedMarkdown = editorModelsRef.current.modified.getValue();

		pendingUpdateSyncStatusRef.current = "mutation_in_flight";

		return convex
			.action(api.files_pending_updates.upsert_file_pending_update, {
				membershipId,
				nodeId,
				pendingUpdateId,
				stagedMarkdown,
				unstagedMarkdown,
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

	const doSave = () => {
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

		onSave({ flushPendingUpdateUpsertIfNeeded });
	};

	const getCurrentMarkdown = useFn(() => {
		return editorModelsRef.current?.original.getValue() ?? editorContentState.stagedMarkdown;
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
					should_never_happen("[FileEditorDiff.handleApplySnapshotMarkdown] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			if (remoteData.markdown._nay) {
				console.error("[FileEditorDiff.handleApplySnapshotMarkdown] Error while fetching remote data", {
					nay: remoteData.markdown._nay,
				});
				return;
			}

			updateEditorValues({
				stagedMarkdown: remoteData.markdown._yay,
				unstagedMarkdown: remoteData.markdown._yay,
			});
		})()
			.catch((err) => {
				console.error("[FileEditorDiff] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	});

	const handleClickSave = useFn(() => {
		if (isSaving || isSyncing) return;
		doSave();
	});

	const handleClickAcceptAllAndSave = useFn(() => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		acceptAllDiffs();
		doSave();
	});

	const handleClickAcceptAll = useFn(() => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		acceptAllDiffs();
	});

	const handleClickDiscardAll = useFn(() => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		discardAllDiffs();
	});

	const handleClickSync = useFn(() => {
		if (isSyncDisabled) return;

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
		setMountedModifiedEditor(editor.getModifiedEditor());

		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		const nextModels = {
			original: files_monaco_create_editor_model(initialOriginalMarkdown),
			modified: files_monaco_create_editor_model(initialUnstagedMarkdown),
		};
		setEditorModels(nextModels);
		editor.setModel(nextModels);
		prevModels.forEach((model) => model?.dispose());

		updateThreadIds(initialOriginalMarkdown);

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

		const mergedStagedBranchResult = files_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc: previousRemoteEditorContentState.stagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.stagedYjsDoc,
			localMarkdown: editorModels.original.getValue(),
		});
		if (mergedStagedBranchResult._nay) {
			console.error("[FileEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile staged branch", {
				nay: mergedStagedBranchResult._nay,
				nodeId,
			});
			return;
		}

		const mergedUnstagedBranchResult = files_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc: previousRemoteEditorContentState.unstagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.unstagedYjsDoc,
			localMarkdown: editorModels.modified.getValue(),
		});
		if (mergedUnstagedBranchResult._nay) {
			console.error("[FileEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile unstaged branch", {
				nay: mergedUnstagedBranchResult._nay,
				nodeId,
			});
			return;
		}

		updateEditorValues({
			stagedMarkdown: mergedStagedBranchResult._yay.mergedMarkdown,
			unstagedMarkdown: mergedUnstagedBranchResult._yay.mergedMarkdown,
		});
		lastAppliedRemoteEditorContentStateRef.current = editorContentState;
	}, [editorContentState, editorModels]);

	useEffect(() => {
		// In dev, React StrictMode may mount/unmount/mount to detect side effects.
		// Ensure we don't permanently disable host registration after the first cleanup.
		isUnmountingRef.current = false;

		return () => {
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
					isSaveDisabled={isSaveDisabled}
					isSyncDisabled={isSyncDisabled || isSaving}
					isAcceptAllDisabled={isAcceptAllDisabled}
					isAcceptAllAndSaveDisabled={isAcceptAllAndSaveDisabled}
					isDiscardAllDisabled={isDiscardAllDisabled}
					nodeId={nodeId}
					sessionId={presenceStore.localSessionId}
					toolbarPortalHost={toolbarPortalHost}
					getCurrentMarkdown={getCurrentMarkdown}
					onApplySnapshotMarkdown={handleApplySnapshotMarkdown}
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
						originalLanguage="markdown"
						modifiedLanguage="markdown"
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
				createPortal(<FileEditorCommentsSidebar threadIds={commentThreadIds} />, commentsPortalHost)}
			{contentWidgets.map((widget) =>
				createPortal(
					<FileEditorDiffWidgetAcceptDiscard
						onAccept={() => handleClickWidgetAccept(widget.args.index)}
						onDiscard={() => handleClickWidgetDiscard(widget.args.index)}
					/>,
					widget.node,
					widget.id,
				),
			)}
		</>
	);
});

export const FileEditorDiff = memo(function FileEditorDiff(props: FileEditorDiff_Props) {
	const {
		nodeId,
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
	const pendingUpdate = useStableQuery(api.files_pending_updates.get_file_pending_update, {
		membershipId,
		nodeId,
		pendingUpdateId,
	});
	const pendingUpdateLastSequenceSaved = useQuery(api.files_pending_updates.get_file_pending_update_last_sequence_saved, {
		membershipId,
		nodeId,
	});

	const [fileContentData, setFileContentData] = useState<
		Awaited<ReturnType<typeof files_fetch_file_yjs_state_and_markdown>> | undefined
	>(undefined);
	const [remoteEditorContentState, setRemoteEditorContentState] = useState<RemoteEditorContentState | undefined>(
		undefined,
	);
	const [isSaving, setIsSaving] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);
	const currentPendingUpdateId = pendingUpdate?._id ?? pendingUpdateId;

	const isSyncDisabled =
		isSyncing ||
		serverSequence == null ||
		remoteEditorContentState == null ||
		remoteEditorContentState.yjsSequence === serverSequence;

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
				editor_content_states_match(currentRemoteEditorContentState, nextRemoteEditorContentState)
			) {
				return currentRemoteEditorContentState;
			}

			return nextRemoteEditorContentState;
		});
	};

	const handleSave = useFn<FileEditorDiffInner_Props["onSave"]>(({ flushPendingUpdateUpsertIfNeeded }) => {
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
				toast.error(savePendingResult._nay.message ?? "Failed to save pending updates");
				return;
			}

			const [nextFileContentData] = await Promise.allSettled([
				files_fetch_file_yjs_state_and_markdown({
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
				setFileContentData(nextFileContentData.value);
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
		if (isSyncing) return;

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

			const nextFileContentData = await files_fetch_file_yjs_state_and_markdown({
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
			if (nextFileContentData.markdown._nay) {
				return Result({
					_nay: {
						message: "Failed to reconstruct latest file content while syncing",
						cause: nextFileContentData.markdown._nay,
					},
				});
			}

			const rebasedStagedBranchResult = files_yjs_rebase_branch_with_local_markdown({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextFileContentData.yjsDoc,
				previousBranchYjsDoc: remoteEditorContentState.stagedYjsDoc,
				localMarkdown: editorValues.stagedMarkdown,
			});
			if (rebasedStagedBranchResult._nay) {
				return Result({
					_nay: {
						message: "Failed to rebase staged branch while syncing",
						cause: rebasedStagedBranchResult._nay,
					},
				});
			}

			const rebasedUnstagedBranchResult = files_yjs_rebase_branch_with_local_markdown({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextFileContentData.yjsDoc,
				previousBranchYjsDoc: remoteEditorContentState.unstagedYjsDoc,
				localMarkdown: editorValues.unstagedMarkdown,
			});
			if (rebasedUnstagedBranchResult._nay) {
				return Result({
					_nay: {
						message: "Failed to rebase unstaged branch while syncing",
						cause: rebasedUnstagedBranchResult._nay,
					},
				});
			}

			const persistRebasedStateResult = await convex.action(
				api.files_pending_updates.persist_file_pending_update_rebased_state,
				{
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
				},
			);
			if (persistRebasedStateResult._nay) {
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
			const nextFileContentData = await files_fetch_file_yjs_state_and_markdown({
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
			const nextFileContentData = await files_fetch_file_yjs_state_and_markdown({
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

	// Bootstrap the remote editor content state once `fileContentData` and `pendingUpdate` are ready
	useLayoutEffect(() => {
		if (remoteEditorContentState !== undefined || pendingUpdate === undefined || fileContentData === undefined) {
			return;
		}

		if (pendingUpdate) {
			const pendingUpdateInitialEditorContentState = create_editor_content_state_from_pending_update(pendingUpdate);
			if (pendingUpdateInitialEditorContentState._yay) {
				setRemoteEditorContentStateIfNotMatch(pendingUpdateInitialEditorContentState._yay);
				return;
			}

			console.error("[FileEditorDiff] Failed to reconstruct initial remote editor content state", {
				error: pendingUpdateInitialEditorContentState._nay,
				nodeId,
			});
		}

		if (fileContentData) {
			const nextRemoteEditorContentState = create_editor_content_state_from_file_content_data(fileContentData);
			if (nextRemoteEditorContentState) {
				setRemoteEditorContentStateIfNotMatch(nextRemoteEditorContentState);
				setIsSyncing(false);
				return;
			}
		}

		setRemoteEditorContentState(() => {
			const emptyYjsDoc = new YDoc();
			return {
				baselineYjsDoc: emptyYjsDoc,
				baselineMarkdown: "",
				stagedYjsDoc: files_yjs_doc_clone({ yjsDoc: emptyYjsDoc }),
				stagedMarkdown: "",
				unstagedYjsDoc: files_yjs_doc_clone({ yjsDoc: emptyYjsDoc }),
				unstagedMarkdown: "",
				yjsSequence: 0,
			} satisfies RemoteEditorContentState;
		});
	}, [fileContentData, nodeId, pendingUpdate, remoteEditorContentState]);

	// Needs to be a layout effect so sync/save convergence updates the remote editor
	// state before paint, avoiding a brief render with stale button enablement.
	useLayoutEffect(() => {
		if (!remoteEditorContentState) {
			return;
		}

		if (pendingUpdate) {
			const nextRemoteEditorContentState = create_editor_content_state_from_pending_update(pendingUpdate);
			if (nextRemoteEditorContentState._nay) {
				console.error("[FileEditorDiff.pendingUpdateReconcile] Failed to reconstruct remote editor content state", {
					error: nextRemoteEditorContentState._nay,
					nodeId,
				});
				setIsSyncing(false);
				return;
			}
			if (!editor_content_states_match(remoteEditorContentState, nextRemoteEditorContentState._yay)) {
				setRemoteEditorContentState(nextRemoteEditorContentState._yay);
			}

			setIsSyncing(false);
			return;
		}

		if (!fileContentData) {
			setIsSyncing(false);
			return;
		}

		const nextRemoteEditorContentState = create_editor_content_state_from_file_content_data(fileContentData);
		if (
			nextRemoteEditorContentState &&
			!editor_content_states_match(remoteEditorContentState, nextRemoteEditorContentState)
		) {
			setRemoteEditorContentState(nextRemoteEditorContentState);
		}

		setIsSyncing(false);
	}, [fileContentData, nodeId, pendingUpdate, remoteEditorContentState]);

	// Keep this hardcoded while debugging the diff editor loading state.
	const forceLoading = false;

	return forceLoading ||
		hoistingContainer == null ||
		pendingUpdate === undefined ||
		fileContentData === undefined ||
		remoteEditorContentState === undefined ? (
		<FileEditorDiffSkeleton />
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
