import "./page-editor-diff.css";
import { Check, Undo2 } from "lucide-react";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { CoalescedRunner, usePromiseValue } from "@/lib/async.ts";
import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { editor as monaco_editor, Range as monaco_Range } from "monaco-editor";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	cn,
	should_never_happen,
	type CSSPropertiesX,
} from "@/lib/utils.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { CheckCheck, RefreshCcw, Save, SaveAll, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Doc as YDoc, applyUpdate } from "yjs";
import { useStateRef } from "@/hooks/utils-hooks.ts";
import {
	pages_monaco_create_editor_model,
	pages_headless_tiptap_editor_create,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_clone,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
	pages_fetch_page_yjs_state_and_markdown,
} from "@/lib/pages.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { PageEditorCommentsSidebar } from "../page-editor-comments-sidebar.tsx";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";
import { Result } from "../../../lib/errors-as-values-utils.ts";

// #region toolbar
export type PageEditorDiffToolbar_ClassNames =
	| "PageEditorDiffToolbar"
	| "PageEditorDiffToolbar-scrollable-area"
	| "PageEditorDiffToolbar-button"
	| "PageEditorDiffToolbar-button-accept-all"
	| "PageEditorDiffToolbar-button-accept-all-and-save"
	| "PageEditorDiffToolbar-button-discard-all"
	| "PageEditorDiffToolbar-icon";

export type PageEditorDiffToolbar_Props = {
	isSaveDisabled: boolean;
	isSyncDisabled: boolean;
	isAcceptAllDisabled: boolean;
	isAcceptAllAndSaveDisabled: boolean;
	isDiscardAllDisabled: boolean;
	pageId: app_convex_Id<"pages">;
	sessionId: string;
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown: (markdown: string) => void;
	onClickSave: () => void;
	onClickSync: () => void;
	onClickAcceptAll: () => void;
	onClickAcceptAllAndSave: () => void;
	onClickDiscardAll: () => void;
};

function PageEditorDiffToolbar(props: PageEditorDiffToolbar_Props) {
	const {
		isSaveDisabled,
		isSyncDisabled,
		isAcceptAllDisabled,
		isAcceptAllAndSaveDisabled,
		isDiscardAllDisabled,
		pageId,
		sessionId,
		getCurrentMarkdown,
		onApplySnapshotMarkdown,
		onClickSave,
		onClickSync,
		onClickAcceptAll,
		onClickAcceptAllAndSave,
		onClickDiscardAll,
	} = props;

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);

	return (
		<div
			ref={setPortalElement}
			role="toolbar"
			aria-label="Toolbar"
			aria-orientation="horizontal"
			className={cn("PageEditorDiffToolbar" satisfies PageEditorDiffToolbar_ClassNames)}
		>
			{portalElement && (
				<div className={cn("PageEditorDiffToolbar-scrollable-area" satisfies PageEditorDiffToolbar_ClassNames)}>
					<MyButton
						variant="ghost"
						className={cn("PageEditorDiffToolbar-button" satisfies PageEditorDiffToolbar_ClassNames)}
						disabled={isSaveDisabled}
						onClick={onClickSave}
					>
						<MyButtonIcon className={cn("PageEditorDiffToolbar-icon" satisfies PageEditorDiffToolbar_ClassNames)}>
							<Save />
						</MyButtonIcon>
						Save
					</MyButton>
					<MyButton
						variant="ghost"
						className={cn("PageEditorDiffToolbar-button" satisfies PageEditorDiffToolbar_ClassNames)}
						disabled={isSyncDisabled}
						onClick={onClickSync}
					>
						<MyButtonIcon className={cn("PageEditorDiffToolbar-icon" satisfies PageEditorDiffToolbar_ClassNames)}>
							<RefreshCcw />
						</MyButtonIcon>
						Sync
					</MyButton>
					<MyButton
						variant="ghost"
						className={cn(
							"PageEditorDiffToolbar-button" satisfies PageEditorDiffToolbar_ClassNames,
							"PageEditorDiffToolbar-button-accept-all" satisfies PageEditorDiffToolbar_ClassNames,
						)}
						disabled={isAcceptAllDisabled}
						onClick={onClickAcceptAll}
					>
						<MyButtonIcon className={cn("PageEditorDiffToolbar-icon" satisfies PageEditorDiffToolbar_ClassNames)}>
							<CheckCheck />
						</MyButtonIcon>
						Accept all
					</MyButton>
					<MyButton
						variant="ghost"
						className={cn(
							"PageEditorDiffToolbar-button" satisfies PageEditorDiffToolbar_ClassNames,
							"PageEditorDiffToolbar-button-accept-all-and-save" satisfies PageEditorDiffToolbar_ClassNames,
						)}
						disabled={isAcceptAllAndSaveDisabled}
						onClick={onClickAcceptAllAndSave}
					>
						<MyButtonIcon className={cn("PageEditorDiffToolbar-icon" satisfies PageEditorDiffToolbar_ClassNames)}>
							<SaveAll />
						</MyButtonIcon>
						Accept all + save
					</MyButton>
					<MyButton
						variant="ghost"
						className={cn(
							"PageEditorDiffToolbar-button" satisfies PageEditorDiffToolbar_ClassNames,
							"PageEditorDiffToolbar-button-discard-all" satisfies PageEditorDiffToolbar_ClassNames,
						)}
						disabled={isDiscardAllDisabled}
						onClick={onClickDiscardAll}
					>
						<MyButtonIcon className={cn("PageEditorDiffToolbar-icon" satisfies PageEditorDiffToolbar_ClassNames)}>
							<Trash2 />
						</MyButtonIcon>
						Discard all
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

// #region top sticky floating container
type PageEditorDiffTopStickyFloatingContainer_ClassNames = "PageEditorDiffTopStickyFloatingContainer";

type PageEditorDiffTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

function PageEditorDiffTopStickyFloatingContainer(props: PageEditorDiffTopStickyFloatingContainer_Props) {
	const { topStickyFloatingSlot } = props;

	return (
		<div
			className={cn(
				"PageEditorDiffTopStickyFloatingContainer" satisfies PageEditorDiffTopStickyFloatingContainer_ClassNames,
			)}
		>
			{topStickyFloatingSlot}
		</div>
	);
}
// #endregion top sticky floating container

// #region PageEditorDiffWidgetAcceptDiscard
export type PageEditorDiffWidgetAcceptDiscard_ClassNames =
	| "PageEditorDiffWidgetAcceptDiscard"
	| "PageEditorDiffWidgetAcceptDiscard-moanco-widget-container"
	| "PageEditorDiffWidgetAcceptDiscard-monaco-decoration"
	| "PageEditorDiffWidgetAcceptDiscard-accept-button"
	| "PageEditorDiffWidgetAcceptDiscard-discard-button"
	| "PageEditorDiffWidgetAcceptDiscard-icon";

export type PageEditorDiffWidgetAcceptDiscard_Props = {
	onAccept: () => void;
	onDiscard: () => void;
};

class PageEditorDiffWidgetAcceptDiscard_Monaco implements monaco_editor.IContentWidget {
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
		this.id = `PageEditorDiffWidgetAcceptDiscard-${this.args.index}`;

		this.node = document.createElement("div");
		this.node.classList.add(
			"PageEditorDiffWidgetAcceptDiscard-moanco-widget-container" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
		);

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

		this.node.style.transform = `translate3d(95px, 91px, 0)`;
		this.node.style.display = "flex";
		this.node.style.left = `anchor(left)`;
		this.node.style.setProperty("position-anchor", this.args.anchorName);
	};

	private createDecoration(lineNumber: number): monaco_editor.IModelDeltaDecoration {
		return {
			range: new monaco_Range(lineNumber, 1, lineNumber, 1),
			options: {
				className:
					"PageEditorDiffWidgetAcceptDiscard-monaco-decoration" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
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

export function PageEditorDiffWidgetAcceptDiscard(props: PageEditorDiffWidgetAcceptDiscard_Props) {
	const { onAccept, onDiscard } = props;

	const handleMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
	};

	const handleClickAccept = (e: React.MouseEvent) => {
		e.preventDefault();
		onAccept();
	};

	const handleClickDiscard = (e: React.MouseEvent) => {
		e.preventDefault();
		onDiscard();
	};

	return (
		<>
			<MyTooltip timeout={0} placement="top">
				<MyTooltipTrigger>
					<button
						type="button"
						className={cn(
							"PageEditorDiffWidgetAcceptDiscard-accept-button" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Accept change"
						onMouseDown={handleMouseDown}
						onClick={handleClickAccept}
					>
						<Check
							className={cn(
								"PageEditorDiffWidgetAcceptDiscard-icon" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
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
							"PageEditorDiffWidgetAcceptDiscard-discard-button" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Discard change"
						onMouseDown={handleMouseDown}
						onClick={handleClickDiscard}
					>
						<Undo2
							className={cn(
								"PageEditorDiffWidgetAcceptDiscard-icon" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
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
}
// #endregion PageEditorDiffWidgetAcceptDiscard

// #region root

type PageEditorDiff_ClassNames = "PageEditorDiff" | "PageEditorDiff-editor" | "PageEditorDiff-anchor";

type PageEditorDiff_CssVars = {
	"--PageEditorDiff-anchor-name": string;
};

type PageEditorDiff_PendingEdit = app_convex_Doc<"pages_pending_edits">;

type PageEditorDiff_PendingEditState = {
	baselineYjsDoc: YDoc;
	baselineMarkdown: string;
	workingMarkdown: string;
	modifiedMarkdown: string;
	yjsSequence: number;
	hasPendingEdit: boolean;
};

function page_editor_diff_pending_edit_state_create_from_values(args: {
	baselineYjsDoc: YDoc;
	baselineMarkdown: string;
	workingMarkdown: string;
	modifiedMarkdown: string;
	yjsSequence: number;
	hasPendingEdit?: boolean;
}) {
	return {
		baselineYjsDoc: args.baselineYjsDoc,
		baselineMarkdown: args.baselineMarkdown,
		workingMarkdown: args.workingMarkdown,
		modifiedMarkdown: args.modifiedMarkdown,
		yjsSequence: args.yjsSequence,
		hasPendingEdit:
			args.hasPendingEdit ??
			(args.workingMarkdown !== args.baselineMarkdown || args.modifiedMarkdown !== args.baselineMarkdown),
	} satisfies PageEditorDiff_PendingEditState;
}

function page_editor_diff_pending_edit_states_match(args: {
	left: PageEditorDiff_PendingEditState;
	right: PageEditorDiff_PendingEditState;
}) {
	return (
		args.left.baselineMarkdown === args.right.baselineMarkdown &&
		args.left.workingMarkdown === args.right.workingMarkdown &&
		args.left.modifiedMarkdown === args.right.modifiedMarkdown &&
		args.left.yjsSequence === args.right.yjsSequence &&
		args.left.hasPendingEdit === args.right.hasPendingEdit
	);
}

function page_editor_diff_pending_edit_state_from_pending_edit(pendingEdit: PageEditorDiff_PendingEdit) {
	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(pendingEdit.baseYjsUpdate);
	const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baseYjsDoc });
	const modifiedYjsDoc = pages_yjs_doc_clone({ yjsDoc: baseYjsDoc });

	if (pendingEdit.workingUpdateFromBase.byteLength > 0) {
		applyUpdate(workingYjsDoc, new Uint8Array(pendingEdit.workingUpdateFromBase));
	}

	if (pendingEdit.modifiedUpdateFromBase.byteLength > 0) {
		applyUpdate(modifiedYjsDoc, new Uint8Array(pendingEdit.modifiedUpdateFromBase));
	}

	const baseMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: baseYjsDoc });
	const workingMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: workingYjsDoc });
	const modifiedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: modifiedYjsDoc });

	if (baseMarkdown._nay) return baseMarkdown;
	else if (workingMarkdown._nay) return workingMarkdown;
	else if (modifiedMarkdown._nay) return modifiedMarkdown;

	const value = page_editor_diff_pending_edit_state_create_from_values({
		baselineYjsDoc: baseYjsDoc,
		baselineMarkdown: baseMarkdown._yay,
		workingMarkdown: workingMarkdown._yay,
		modifiedMarkdown: modifiedMarkdown._yay,
		yjsSequence: pendingEdit.baseYjsSequence,
		hasPendingEdit: true,
	});

	return Result({
		_yay: value,
	});
}

type PageEditorDiff_Inner_Props = PageEditorDiff_Props & {
	pendingEdit: PageEditorDiff_PendingEdit | null;
	hoistingContainer: HTMLElement;
	initialData: {
		markdown: string;
		mut_yjsDoc: YDoc;
		yjsSequence: number;
	};
};

function PageEditorDiff_Inner(props: PageEditorDiff_Inner_Props) {
	const {
		className,
		pageId,
		presenceStore,
		pendingEdit,
		commentsPortalHost,
		hoistingContainer,
		initialData,
		topStickyFloatingSlot,
	} = props;

	const id = useId();
	const anchorName = `${"--PageEditorDiff-anchor-name" satisfies keyof PageEditorDiff_CssVars}-${id}`;

	const upsertPendingEditUpdatesMutation = useMutation(api.ai_chat.upsert_pages_pending_edit_updates);
	const syncPendingEditUpdatesMutation = useMutation(api.ai_chat.sync_pages_pending_edit_updates);
	const savePendingEditMutation = useMutation(api.ai_chat.save_pages_pending_edit);
	const convex = useConvex();

	const serverSequenceData = useQuery(api.ai_docs_temp.get_page_last_yjs_sequence, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	const pendingEditInitialState = ((/* iife */) => {
		if (pendingEdit) {
			const value = page_editor_diff_pending_edit_state_from_pending_edit(pendingEdit);
			if (value._nay) {
				throw new Error(
					`[page-editor-diff.PageEditorDiff_Inner] Failed to reconstruct pending edit state from pending edit`,
					{
						cause: value._nay,
					},
				);
			}
			return value._yay;
		}

		return page_editor_diff_pending_edit_state_create_from_values({
			baselineYjsDoc: initialData.mut_yjsDoc,
			baselineMarkdown: initialData.markdown,
			workingMarkdown: initialData.markdown,
			modifiedMarkdown: initialData.markdown,
			yjsSequence: initialData.yjsSequence,
			hasPendingEdit: false,
		});
	})();

	const editorRef = useRef(null);
	const baselineYjsDocRef = useRef(pendingEditInitialState.baselineYjsDoc);
	const baselineMarkdownRef = useRef(pendingEditInitialState.baselineMarkdown);
	const hasPendingEditRef = useRef(pendingEditInitialState.hasPendingEdit);
	const pendingEditSyncTimeoutRef = useRef(null);
	const [pendingEditSyncRunner] = useState(() => new CoalescedRunner());

	const [oritinalMarkdownStable] = useState(pendingEditInitialState.workingMarkdown);
	const [modifiedMarkdownStable] = useState(pendingEditInitialState.modifiedMarkdown);

	const [isDirtyRef, setIsDirty, isDirty] = useStateRef(
		pendingEditInitialState.workingMarkdown !== pendingEditInitialState.baselineMarkdown,
	);

	const [workingYjsSequence, setWorkingYjsSequence] = useState(pendingEditInitialState.yjsSequence);

	const [hasDiffs, setHasDiffs] = useState(false);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isEditorReady, setIsEditorReady] = useState(false);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");

	/** Content widgets for per-change actions (accept/discard) */
	const [contentWidgetsRef, setContentWidgets, contentWidgets] = useStateRef<
		PageEditorDiffWidgetAcceptDiscard_Monaco[]
	>([]);
	const isUnmountingRef = useRef(false);

	const serverSequence = serverSequenceData?.last_sequence;
	const isSaveDisabled = isSaving || isSyncing || !isDirty;
	const isSyncDisabled = isSyncing || isSaving || serverSequence == null || workingYjsSequence === serverSequence;
	const isAcceptAllDisabled = isSaving || isSyncing || !hasDiffs;
	const isAcceptAllAndSaveDisabled = isSaving || isSyncing || !hasDiffs;
	const isDiscardAllDisabled = isSaving || isSyncing || !hasDiffs;

	const monacoListenersDisposeAbortControllers = useRef<AbortController>(null);
	const modelsRef = useRef<{
		original: monaco_editor.ITextModel;
		modified: monaco_editor.ITextModel;
	} | null>(null);

	const updateThreadIds = (markdown: string) => {
		const headlessEditor = pages_headless_tiptap_editor_create({ initialContent: { markdown } });

		if (headlessEditor._nay) {
			console.error("[PageEditorDiff.updateThreadIds] Error while creating headless editor", {
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
		const editorModels = modelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[PageEditorDiff.applyDiffs] Missing `editorModels`", {
				editorModels,
			});
			console.error(error);
			throw error;
		}

		const originalLineCount = editorModels.original.getLineCount();
		const originalLastLineMaxColumn = editorModels.original.getLineMaxColumn(originalLineCount);
		const modifiedLineCount = editorModels.modified.getLineCount();
		const modifiedLastLineMaxColumn = editorModels.modified.getLineMaxColumn(modifiedLineCount);

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
				if (diff.originalEndLineNumber === editorModels.original.getLineCount()) {
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
						endCharacter = editorModels.original.getLineMaxColumn(endLine);
					}
				} else {
					// Regular index normalization to convert 0-based indexes from `diff` to 1-based indexes for Monaco ranges.
					endLine = diff.originalStartLineNumber;
					endCharacter = 1;
				}
			}

			resultParts.push(
				editorModels.original.getValueInRange(
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
				if (isInsertion && diff.originalStartLineNumber === editorModels.original.getLineCount()) {
					if (diff.modifiedStartLineNumber <= 1) {
						fromLine = 0;
						fromCharacter = 0;
					} else {
						fromLine = diff.modifiedStartLineNumber - 2;
						fromCharacter = editorModels.modified.getLineContent(fromLine + 1).length;
					}
				} else {
					fromLine = diff.modifiedStartLineNumber - 1;
					fromCharacter = 0;
				}

				resultParts.push(
					editorModels.modified.getValueInRange(
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
			editorModels.original.getValueInRange(
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

	const pushChangeToWorkingEditor = (newMarkdown: string) => {
		const editorModels = modelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[PageEditorDiff.pushChangeToWorkingEditor] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels,
			});
			console.error(error);
			throw error;
		}

		// Apply edits at the model level so working/staged content can be updated even when
		// `originalEditable` is false (original editor is read-only).
		editorModels.original.pushStackElement();
		editorModels.original.applyEdits([{ range: editorModels.original.getFullModelRange(), text: newMarkdown }]);
		editorModels.original.pushStackElement();
	};

	const pushChangeToUnstagedEditor = (newMarkdown: string) => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorDiff.pushChangeToUnstagedEditor] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const editorModels = modelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[PageEditorDiff.pushChangeToUnstagedEditor] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels,
			});
			console.error(error);
			throw error;
		}

		// The modified/unstaged editor is writable; use editor-level edits so undo/redo behavior
		// stays consistent with Monaco's normal editing workflow.
		const modifiedEditor = editorRef.current.getModifiedEditor();
		modifiedEditor.pushUndoStop();
		modifiedEditor.executeEdits("app_pages_sync", [
			{ range: editorModels.modified.getFullModelRange(), text: newMarkdown },
		]);
		modifiedEditor.pushUndoStop();
	};

	const createCurrentPendingEditState = () => {
		const editorModels = modelsRef.current;
		if (!editorModels) {
			return null;
		}

		return page_editor_diff_pending_edit_state_create_from_values({
			baselineYjsDoc: baselineYjsDocRef.current,
			baselineMarkdown: baselineMarkdownRef.current,
			workingMarkdown: editorModels.original.getValue(),
			modifiedMarkdown: editorModels.modified.getValue(),
			yjsSequence: workingYjsSequence,
		});
	};

	const createPendingEditStateYjsDocs = (args: { state: PageEditorDiff_PendingEditState; logOwnerSymbol: string }) => {
		const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: args.state.baselineYjsDoc });
		const workingYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: workingYjsDoc,
			markdown: args.state.workingMarkdown,
		});
		if (workingYjsDocFromMarkdown._nay) {
			console.error(`${args.logOwnerSymbol} Failed to rebuild working Y.Doc from markdown`, {
				nay: workingYjsDocFromMarkdown._nay,
			});
			return null;
		}

		const modifiedYjsDoc = pages_yjs_doc_clone({ yjsDoc: args.state.baselineYjsDoc });
		const modifiedYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: modifiedYjsDoc,
			markdown: args.state.modifiedMarkdown,
		});
		if (modifiedYjsDocFromMarkdown._nay) {
			console.error(`${args.logOwnerSymbol} Failed to rebuild modified Y.Doc from markdown`, {
				nay: modifiedYjsDocFromMarkdown._nay,
			});
			return null;
		}

		return { workingYjsDoc, modifiedYjsDoc };
	};

	const mergePendingEditStates = (args: {
		localState: PageEditorDiff_PendingEditState;
		remoteState: PageEditorDiff_PendingEditState;
		logOwnerSymbol: string;
	}) => {
		const localYjsDocs = createPendingEditStateYjsDocs({
			state: args.localState,
			logOwnerSymbol: args.logOwnerSymbol,
		});
		if (!localYjsDocs) {
			return null;
		}

		const remoteYjsDocs = createPendingEditStateYjsDocs({
			state: args.remoteState,
			logOwnerSymbol: args.logOwnerSymbol,
		});
		if (!remoteYjsDocs) {
			return null;
		}

		const workingDiffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: remoteYjsDocs.workingYjsDoc,
			yjsBeforeDoc: localYjsDocs.workingYjsDoc,
		});
		if (workingDiffUpdate) {
			applyUpdate(localYjsDocs.workingYjsDoc, workingDiffUpdate);
		}

		const modifiedDiffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: remoteYjsDocs.modifiedYjsDoc,
			yjsBeforeDoc: localYjsDocs.modifiedYjsDoc,
		});
		if (modifiedDiffUpdate) {
			applyUpdate(localYjsDocs.modifiedYjsDoc, modifiedDiffUpdate);
		}

		const mergedWorkingMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: localYjsDocs.workingYjsDoc });
		if (mergedWorkingMarkdown._nay) {
			console.error(`${args.logOwnerSymbol} Failed to get merged working markdown`, {
				nay: mergedWorkingMarkdown._nay,
			});
			return null;
		}

		const mergedModifiedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: localYjsDocs.modifiedYjsDoc });
		if (mergedModifiedMarkdown._nay) {
			console.error(`${args.logOwnerSymbol} Failed to get merged modified markdown`, {
				nay: mergedModifiedMarkdown._nay,
			});
			return null;
		}

		return page_editor_diff_pending_edit_state_create_from_values({
			baselineYjsDoc: args.remoteState.baselineYjsDoc,
			baselineMarkdown: args.remoteState.baselineMarkdown,
			workingMarkdown: mergedWorkingMarkdown._yay,
			modifiedMarkdown: mergedModifiedMarkdown._yay,
			yjsSequence: args.remoteState.yjsSequence,
		});
	};

	const applyServerAppliedState = (args: { state: PageEditorDiff_PendingEditState }) => {
		const { state } = args;

		baselineYjsDocRef.current = state.baselineYjsDoc;
		baselineMarkdownRef.current = state.baselineMarkdown;
		hasPendingEditRef.current = state.hasPendingEdit;
		setWorkingYjsSequence(state.yjsSequence);
		setIsDirty(state.workingMarkdown !== state.baselineMarkdown);
		setHasDiffs(state.workingMarkdown !== state.modifiedMarkdown);

		const editorModels = modelsRef.current;
		if (editorModels && editorRef.current) {
			if (editorModels.original.getValue() !== state.workingMarkdown) {
				pushChangeToWorkingEditor(state.workingMarkdown);
			}

			if (editorModels.modified.getValue() !== state.modifiedMarkdown) {
				pushChangeToUnstagedEditor(state.modifiedMarkdown);
			}
		}

		updateThreadIds(state.workingMarkdown);
	};

	const updateIsStagedDirty = () => {
		const original = modelsRef.current?.original.getValue();
		if (original == null) return;
		setIsDirty(original !== baselineMarkdownRef.current);
	};

	const upsertPendingEditNow = async (args?: { force?: boolean }) => {
		const editorModels = modelsRef.current;
		if (!editorModels) {
			return false;
		}

		const force = args?.force ?? false;
		const workingMarkdown = editorModels.original.getValue();
		const modifiedMarkdown = editorModels.modified.getValue();

		if (
			!force &&
			!hasPendingEditRef.current &&
			workingMarkdown === baselineMarkdownRef.current &&
			modifiedMarkdown === baselineMarkdownRef.current
		) {
			return true;
		}

		const upsertResult = await upsertPendingEditUpdatesMutation({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
			workingMarkdown,
			modifiedMarkdown,
		});
		if (upsertResult._nay) {
			console.error("[PageEditorDiff.upsertPendingEditNow] Failed to sync pending edits", {
				nay: upsertResult._nay,
				pageId,
			});
			return false;
		}

		const hasPendingEdit =
			workingMarkdown !== baselineMarkdownRef.current || modifiedMarkdown !== baselineMarkdownRef.current;
		hasPendingEditRef.current = hasPendingEdit;

		return true;
	};

	const runPendingEditUpsertNow = async () => {
		const runResult = await pendingEditSyncRunner.run(async () => upsertPendingEditNow());
		if (runResult.aborted) {
			return true;
		}

		return runResult.value;
	};

	const syncPendingEditNow = async () => {
		const editorModels = modelsRef.current;
		if (!editorModels) {
			return false;
		}

		const workingMarkdown = editorModels.original.getValue();
		const modifiedMarkdown = editorModels.modified.getValue();

		const syncResult = await syncPendingEditUpdatesMutation({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
			workingMarkdown,
			modifiedMarkdown,
		});
		if ("_nay" in syncResult && syncResult._nay) {
			console.error("[PageEditorDiff.syncPendingEditNow] Failed to sync pending edits", {
				nay: syncResult._nay,
				pageId,
			});
			return false;
		}

		const hasPendingEdit =
			workingMarkdown !== baselineMarkdownRef.current || modifiedMarkdown !== baselineMarkdownRef.current;
		hasPendingEditRef.current = hasPendingEdit;

		return true;
	};

	const schedulePendingEditSync = () => {
		if (pendingEditSyncTimeoutRef.current != null) {
			window.clearTimeout(pendingEditSyncTimeoutRef.current);
		}

		pendingEditSyncTimeoutRef.current = window.setTimeout(() => {
			pendingEditSyncTimeoutRef.current = null;
			runPendingEditUpsertNow().catch((error) => {
				console.error("[PageEditorDiff.schedulePendingEditSync] Failed to sync pending edits", {
					error,
				});
			});
		}, 250);
	};

	const flushPendingEditUpsertIfNeeded = async () => {
		if (pendingEditSyncTimeoutRef.current != null) {
			window.clearTimeout(pendingEditSyncTimeoutRef.current);
			pendingEditSyncTimeoutRef.current = null;
		}

		const runResult = await pendingEditSyncRunner.flush(async () => upsertPendingEditNow());
		if (runResult.aborted) {
			return false;
		}

		return runResult.value;
	};

	const discardAllDiffs = () => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorDiff.discardAllDiffs] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const editorModels = modelsRef.current;
		if (!editorModels) {
			console.error(
				should_never_happen("[PageEditorDiff.discardAllDiffs] Missing `editorModels`", {
					editorModels,
				}),
			);
			return;
		}

		pushChangeToUnstagedEditor(editorModels.original.getValue());
		editorRef.current.focus();
	};

	const acceptAllDiffs = () => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorDiff.acceptAllDiffs] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		const editorModels = modelsRef.current;
		if (!editorModels) {
			const error = should_never_happen("[PageEditorDiff.acceptAllDiffs] Missing `editorModels`", {
				editor: editorRef.current,
				editorModels,
			});
			console.error(error);
			throw error;
		}

		const result = editorModels.modified.getValue();
		pushChangeToWorkingEditor(result);
		editorRef.current.focus();

		updateIsStagedDirty();
	};

	const applyRemoteDataAsBaseline = (args: { markdown: string; yjsDoc: YDoc; yjsSequence: number }) => {
		applyServerAppliedState({
			state: page_editor_diff_pending_edit_state_create_from_values({
				baselineYjsDoc: args.yjsDoc,
				baselineMarkdown: args.markdown,
				workingMarkdown: args.markdown,
				modifiedMarkdown: args.markdown,
				yjsSequence: args.yjsSequence,
			}),
		});
	};

	const fetchRemotePagePendingEditState = async (logOwnerSymbol: string) => {
		const remoteData = await pages_fetch_page_yjs_state_and_markdown({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
		});

		if (!remoteData) {
			console.error(
				should_never_happen(`${logOwnerSymbol} Missing \`remoteData\``, {
					remoteData,
					pageId,
				}),
			);
			return null;
		}

		if (remoteData.markdown._nay) {
			console.error(`${logOwnerSymbol} Failed to fetch remote page markdown`, {
				nay: remoteData.markdown._nay,
				pageId,
			});
			return null;
		}

		return page_editor_diff_pending_edit_state_create_from_values({
			baselineYjsDoc: remoteData.yjsDoc,
			baselineMarkdown: remoteData.markdown._yay,
			workingMarkdown: remoteData.markdown._yay,
			modifiedMarkdown: remoteData.markdown._yay,
			yjsSequence: remoteData.yjsSequence,
		});
	};

	const doSave = () => {
		const originalEditorModel = modelsRef.current?.original;
		if (!originalEditorModel) {
			const error = should_never_happen("[PageEditorDiff.handleClickSave] Missing editorModel", {
				editor: editorRef.current,
				originalEditorModel,
			});
			console.error(error);
			throw error;
		}

		if (isSaving || isSyncing || !isDirtyRef.current) return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const workingMarkdown = originalEditorModel.getValue();
			const workingYjsSequenceBeforeSave = workingYjsSequence;

			const didSyncPendingEdit = await flushPendingEditUpsertIfNeeded();
			if (!didSyncPendingEdit) {
				toast.error("Failed to sync pending edits before save");
				return;
			}

			const savePendingResult = await savePendingEditMutation({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});

			if ("_nay" in savePendingResult && savePendingResult._nay) {
				toast.error(savePendingResult._nay.message ?? "Failed to save pending edits");
				return;
			}

			const pendingEditAfterSave = await convex.query(api.ai_chat.get_pages_pending_edit, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});

			if (
				pendingEditAfterSave?.baseYjsUpdate &&
				pendingEditAfterSave.modifiedUpdateFromBase &&
				pendingEditAfterSave.baseYjsSequence != null
			) {
				const savedBaseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(pendingEditAfterSave.baseYjsUpdate);
				const savedModifiedYjsDoc = pages_yjs_doc_clone({
					yjsDoc: savedBaseYjsDoc,
				});

				if (pendingEditAfterSave.modifiedUpdateFromBase.byteLength > 0) {
					applyUpdate(savedModifiedYjsDoc, new Uint8Array(pendingEditAfterSave.modifiedUpdateFromBase));
				}

				const savedBaseMarkdown = pages_yjs_doc_get_markdown({
					yjsDoc: savedBaseYjsDoc,
				});
				const savedModifiedMarkdown = pages_yjs_doc_get_markdown({
					yjsDoc: savedModifiedYjsDoc,
				});
				if (savedBaseMarkdown._nay || savedModifiedMarkdown._nay) {
					console.error("[PageEditorDiff.handleClickSave] Failed to reconstruct pending markdown after save", {
						baseMarkdown: savedBaseMarkdown,
						modifiedMarkdown: savedModifiedMarkdown,
						pageId,
						pendingEditAfterSave,
					});
				} else {
					applyServerAppliedState({
						state: page_editor_diff_pending_edit_state_create_from_values({
							baselineYjsDoc: savedBaseYjsDoc,
							baselineMarkdown: savedBaseMarkdown._yay,
							workingMarkdown: savedBaseMarkdown._yay,
							modifiedMarkdown: savedModifiedMarkdown._yay,
							yjsSequence: pendingEditAfterSave.baseYjsSequence,
						}),
					});
					return;
				}
			}

			const savedBaseYjsDoc = pages_yjs_doc_clone({
				yjsDoc: baselineYjsDocRef.current,
			});
			const savedBaseYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: savedBaseYjsDoc,
				markdown: workingMarkdown,
			});
			if (savedBaseYjsDocFromMarkdown._nay) {
				console.error("[PageEditorDiff.handleClickSave] Failed to rebuild saved base Y.Doc after save", {
					nay: savedBaseYjsDocFromMarkdown._nay,
					pageId,
				});
			} else {
				let nextBaselineYjsDoc = savedBaseYjsDoc;
				let nextWorkingYjsSequence = workingYjsSequenceBeforeSave;

				const remoteData = await pages_fetch_page_yjs_state_and_markdown({
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
				});

				if (!remoteData) {
					console.error(
						should_never_happen("[PageEditorDiff.handleClickSave] Missing `remoteData` after save", {
							remoteData,
						}),
					);
				} else if (remoteData.markdown._nay) {
					console.error("[PageEditorDiff.handleClickSave] Failed to get markdown after save", {
						nay: remoteData.markdown._nay,
					});
				} else if (remoteData.markdown._yay === workingMarkdown) {
					nextBaselineYjsDoc = remoteData.yjsDoc;
					nextWorkingYjsSequence = remoteData.yjsSequence;
				}

				applyServerAppliedState({
					state: page_editor_diff_pending_edit_state_create_from_values({
						baselineYjsDoc: nextBaselineYjsDoc,
						baselineMarkdown: workingMarkdown,
						workingMarkdown,
						modifiedMarkdown: workingMarkdown,
						yjsSequence: nextWorkingYjsSequence,
					}),
				});
			}
		})()
			.catch((err) => {
				console.error("[PageEditorDiff.handleClickSave] Save failed", err);
				toast.error(err?.message ?? "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	};

	const getCurrentMarkdown = () => {
		return modelsRef.current?.original.getValue() ?? initialData.markdown;
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
					should_never_happen("[PageEditorDiff.handleApplySnapshotMarkdown] Missing `remoteData`", {
						remoteData,
					}),
				);
				return;
			}

			if (remoteData.markdown._nay) {
				console.error("[PageEditorDiff.handleApplySnapshotMarkdown] Error while fetching remote data", {
					nay: remoteData.markdown._nay,
				});
				return;
			}

			applyRemoteDataAsBaseline({
				markdown: remoteData.markdown._yay,
				yjsDoc: remoteData.yjsDoc,
				yjsSequence: remoteData.yjsSequence,
			});
		})()
			.catch((err) => {
				console.error("[PageEditorDiff] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	};

	const handleClickSave = () => {
		if (isSaving || isSyncing) return;
		doSave();
	};

	const handleClickSync = () => {
		if (isSyncing || isSaving) return;

		if (!modelsRef.current) {
			console.error(
				should_never_happen("[PageEditorDiff.handleClickSync] Missing `editorModels`", {
					editorModels: modelsRef.current,
				}),
			);
			return;
		}

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const currentState = createCurrentPendingEditState();
			if (!currentState) {
				return;
			}

			const remoteState = await fetchRemotePagePendingEditState("[PageEditorDiff.handleClickSync]");
			if (!remoteState) {
				return;
			}

			const nextServerAppliedState = mergePendingEditStates({
				localState: currentState,
				remoteState,
				logOwnerSymbol: "[PageEditorDiff.handleClickSync]",
			});
			if (!nextServerAppliedState) {
				return;
			}

			applyServerAppliedState({
				state: nextServerAppliedState,
			});

			if (!pendingEdit && !nextServerAppliedState.hasPendingEdit) {
				return;
			}

			const didSyncPendingEdit = await syncPendingEditNow();
			if (!didSyncPendingEdit) {
				toast.error("Failed to sync pending edits after refresh");
			}
		})()
			.catch((err) => {
				console.error("[PageEditorDiff.handleClickSync] Sync failed", err);
				toast.error(err?.message ?? "Failed to sync");
			})
			.finally(() => {
				setIsSyncing(false);
			});
	};

	const handleClickAcceptAllAndSave = () => {
		if (isSaving || isSyncing || !hasDiffs) return;
		acceptAllDiffs();
		doSave();
	};

	const handleClickAcceptAll = () => {
		if (isSaving || isSyncing || !hasDiffs) return;
		acceptAllDiffs();
	};

	const handleClickDiscardAll = () => {
		if (isSaving || isSyncing || !hasDiffs) return;
		discardAllDiffs();
	};

	const handleClickWidgetAccept = (index: number) => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorDiff.handleClickWidgetAccept] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			return;
		}

		const diffToApply = editorRef.current.getLineChanges()?.at(index);
		if (!diffToApply) {
			const error = should_never_happen("[PageEditorDiff.handleClickWidgetAccept] Missing `diff`", {
				editor: editorRef.current,
				index,
			});
			console.error(error);
			return;
		}

		const newEditorContent = applyDiffs([diffToApply]);
		pushChangeToWorkingEditor(newEditorContent);
		editorRef.current.focus();

		updateIsStagedDirty();
	};

	const handleClickWidgetDiscard = (index: number) => {
		if (!editorRef.current) {
			const error = should_never_happen("[PageEditorDiff.handleClickWidgetDiscard] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			return;
		}

		const diffs = editorRef.current.getLineChanges();
		if (!diffs) {
			const error = should_never_happen("[PageEditorDiff.handleClickWidgetDiscard] Missing `diffs`", {
				editor: editorRef.current,
				index,
			});
			console.error(error);
			return;
		}

		const diffsToKeep = diffs.filter((_, i) => i !== index);
		if (diffsToKeep.length === diffs.length) {
			const error = should_never_happen("[PageEditorDiff.handleClickWidgetDiscard] No diff removed", {
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
	};

	const handleOnMount: DiffEditorProps["onMount"] = (editor) => {
		editorRef.current = editor;
		setIsEditorReady(true);

		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		modelsRef.current = {
			original: pages_monaco_create_editor_model(oritinalMarkdownStable),
			modified: pages_monaco_create_editor_model(modifiedMarkdownStable),
		};
		editor.setModel(modelsRef.current);
		prevModels.forEach((model) => model?.dispose());

		updateThreadIds(oritinalMarkdownStable);

		monacoListenersDisposeAbortControllers.current?.abort();
		monacoListenersDisposeAbortControllers.current = new AbortController();

		const disposeListenersObjects = [
			editor.getOriginalEditor().onDidChangeModelContent(() => {
				updateIsStagedDirty();
				schedulePendingEditSync();
			}),
			editor.getModifiedEditor().onDidChangeModelContent(() => {
				schedulePendingEditSync();
			}),
			editor.onDidUpdateDiff(() => {
				if (!editorRef.current) {
					const error = should_never_happen("[PageEditorDiff.handleOnMount] missing `editorRef.current`", {
						editorRef,
					});
					console.error(error);
					return;
				}

				const changes = editorRef.current.getLineChanges() ?? [];
				setHasDiffs(changes.length > 0);

				const modifiedEditor = editorRef.current.getModifiedEditor();
				const originalEditor = editorRef.current.getOriginalEditor();
				const modifiedModel = modelsRef.current?.modified;
				const originalModel = modelsRef.current?.original;
				if (!originalEditor || !modifiedEditor || !modifiedModel || !originalModel) {
					const error = should_never_happen("[PageEditorDiff.handleOnMount] missing deps", {
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
						"[PageEditorDiff.handleOnMount modifiedEditor.getDomNode] Missing `modifiedEditorDomNode`",
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

					const newWidget = new PageEditorDiffWidgetAcceptDiscard_Monaco({
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
	};

	useEffect(() => {
		if (!isEditorReady || !modelsRef.current) {
			return;
		}

		let didCancel = false;

		(async (/* iife */) => {
			const currentState = createCurrentPendingEditState();
			if (!currentState) {
				return;
			}

			if (pendingEdit == null) {
				if (currentState.hasPendingEdit) {
					return;
				}

				const remotePageState = await fetchRemotePagePendingEditState("[PageEditorDiff.pendingEditReconcile]");
				if (didCancel || !remotePageState) {
					return;
				}

				if (page_editor_diff_pending_edit_states_match({ left: currentState, right: remotePageState })) {
					return;
				}

				applyServerAppliedState({
					state: remotePageState,
				});
				return;
			}

			const remoteState = page_editor_diff_pending_edit_state_from_pending_edit(pendingEdit);
			if (didCancel || !remoteState) {
				return;
			}

			if (page_editor_diff_pending_edit_states_match({ left: currentState, right: remoteState })) {
				return;
			}

			const nextServerAppliedState = mergePendingEditStates({
				localState: currentState,
				remoteState,
				logOwnerSymbol: "[PageEditorDiff.pendingEditReconcile]",
			});
			if (didCancel || !nextServerAppliedState) {
				return;
			}

			if (page_editor_diff_pending_edit_states_match({ left: currentState, right: nextServerAppliedState })) {
				return;
			}

			applyServerAppliedState({
				state: nextServerAppliedState,
			});
		})().catch((error) => {
			console.error("[PageEditorDiff.pendingEditReconcile] Failed to reconcile pending edit query", {
				error,
				pageId,
			});
		});

		return () => {
			didCancel = true;
		};
	}, [pageId, pendingEdit, isEditorReady]);

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
			setIsEditorReady(false);

			modelsRef.current?.original.dispose();
			modelsRef.current?.modified.dispose();
			modelsRef.current = null;

			if (pendingEditSyncTimeoutRef.current != null) {
				window.clearTimeout(pendingEditSyncTimeoutRef.current);
				pendingEditSyncTimeoutRef.current = null;
			}
		};
	}, []);

	return (
		<>
			<div
				className={cn("PageEditorDiff" satisfies PageEditorDiff_ClassNames, className)}
				aria-label="Page diff editor"
				style={{
					...({
						"--PageEditorDiff-anchor-name": anchorName,
					} satisfies Partial<PageEditorDiff_CssVars> as CSSPropertiesX),
				}}
			>
				<PageEditorDiffToolbar
					isSaveDisabled={isSaveDisabled}
					isSyncDisabled={isSyncDisabled}
					isAcceptAllDisabled={isAcceptAllDisabled}
					isAcceptAllAndSaveDisabled={isAcceptAllAndSaveDisabled}
					isDiscardAllDisabled={isDiscardAllDisabled}
					pageId={pageId}
					sessionId={presenceStore.localSessionId}
					getCurrentMarkdown={getCurrentMarkdown}
					onApplySnapshotMarkdown={handleApplySnapshotMarkdown}
					onClickSave={handleClickSave}
					onClickSync={handleClickSync}
					onClickAcceptAll={handleClickAcceptAll}
					onClickAcceptAllAndSave={handleClickAcceptAllAndSave}
					onClickDiscardAll={handleClickDiscardAll}
				/>
				<PageEditorDiffTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<div className={"PageEditorDiff-editor" satisfies PageEditorDiff_ClassNames}>
					<DiffEditor
						height="100%"
						theme={app_monaco_THEME_NAME_DARK}
						onMount={handleOnMount}
						original={oritinalMarkdownStable}
						modified={modifiedMarkdownStable}
						originalLanguage="markdown"
						modifiedLanguage="markdown"
						// We own our own models, so we need to keep them alive even after the editor is disposed,
						// because we dispose them manually
						keepCurrentOriginalModel={true}
						keepCurrentModifiedModel={true}
						options={{
							overflowWidgetsDomNode: hoistingContainer,
							originalEditable: false,
							renderSideBySide: false,
							ignoreTrimWhitespace: false,
							glyphMargin: false,
							lineDecorationsWidth: 72,
							renderMarginRevertIcon: false,
							renderGutterMenu: false,
							fixedOverflowWidgets: true,
							wordWrap: "on",
							scrollBeyondLastLine: false,

							lineNumbers: "on",
							renderLineHighlight: "all",
							renderLineHighlightOnlyWhenFocus: true,
						}}
					/>
				</div>
			</div>
			{commentsPortalHost &&
				createPortal(<PageEditorCommentsSidebar threadIds={commentThreadIds} />, commentsPortalHost)}
			{contentWidgets.map((widget) =>
				createPortal(
					<PageEditorDiffWidgetAcceptDiscard
						onAccept={() => handleClickWidgetAccept(widget.args.index)}
						onDiscard={() => handleClickWidgetDiscard(widget.args.index)}
					/>,
					widget.node,
					widget.id,
				),
			)}
		</>
	);
}

export type PageEditorDiff_Props = {
	className?: string;
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	threadId?: string;
	commentsPortalHost: HTMLElement | null;
	onExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
};

export function PageEditorDiff(props: PageEditorDiff_Props) {
	const { pageId, presenceStore, commentsPortalHost, className, topStickyFloatingSlot } = props;

	const pageContentData = usePromiseValue(
		pages_fetch_page_yjs_state_and_markdown({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
		}),
	);
	const pendingEdit = useQuery(api.ai_chat.get_pages_pending_edit, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	/**
	 * The container for the tiptap hoisted elements.
	 * Used by the bubble to allow it to close when clicking on
	 * focusable elements in the page because it checks for the parent
	 * element to contain the focus relatedTarget and if the bubble
	 * is hoisted in the body, the body will always contain the focus relatedTarget
	 * preventing the bubble from closing.
	 */
	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);

	if (pageContentData?.markdown._nay) {
		console.error("[PageEditorDiff] Error while fetching page content data", pageContentData.markdown._nay);
	}

	return hoistingContainer == null ? null : pageContentData === undefined || pendingEdit === undefined ? (
		<>Loading</>
	) : (
		<PageEditorDiff_Inner
			key={pageId}
			{...props}
			className={className}
			pageId={pageId}
			presenceStore={presenceStore}
			pendingEdit={pendingEdit}
			commentsPortalHost={commentsPortalHost}
			hoistingContainer={hoistingContainer}
			initialData={
				pageContentData?.markdown._yay
					? {
							markdown: pageContentData.markdown._yay,
							mut_yjsDoc: pageContentData.yjsDoc,
							yjsSequence: pageContentData.yjsSequence,
						}
					: { markdown: "", mut_yjsDoc: new YDoc(), yjsSequence: 0 }
			}
			topStickyFloatingSlot={topStickyFloatingSlot}
		/>
	);
}
// #endregion root
