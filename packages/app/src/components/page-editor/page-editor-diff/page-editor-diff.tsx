import "./page-editor-diff.css";
import { Check, Undo2 } from "lucide-react";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { CoalescedRunner } from "@/lib/async.ts";
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { editor as monaco_editor, Range as monaco_Range } from "monaco-editor";
import { useConvex, useQuery } from "convex/react";
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
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { useStateRef } from "@/hooks/utils-hooks.ts";
import {
	pages_monaco_create_editor_model,
	pages_headless_tiptap_editor_create,
	pages_yjs_doc_clone,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_get_markdown,
	pages_fetch_page_yjs_state_and_markdown,
	pages_u8_to_array_buffer,
	pages_yjs_reconcile_branch_with_local_markdown,
	pages_yjs_rebase_branch_with_local_markdown,
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
type RemoteEditorContentState = {
	baselineYjsDoc: YDoc;
	baselineMarkdown: string;
	stagedYjsDoc: YDoc;
	stagedMarkdown: string;
	unstagedYjsDoc: YDoc;
	unstagedMarkdown: string;
	yjsSequence: number;
};

type PageEditorDiff_ClassNames = "PageEditorDiff" | "PageEditorDiff-editor" | "PageEditorDiff-anchor";

type PageEditorDiff_CssVars = {
	"--PageEditorDiff-anchor-name": string;
};

export type PageEditorDiff_Props = {
	className?: string;
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	threadId?: string;
	commentsPortalHost: HTMLElement | null;
	onExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
};

type PageEditorDiff_Inner_Props = PageEditorDiff_Props & {
	hoistingContainer: HTMLElement;
	editorContentState: RemoteEditorContentState;
	isSaving: boolean;
	isSyncing: boolean;
	isSyncDisabled: boolean;
	onSave: (args: { flushPendingEditUpsertIfNeeded: () => Promise<boolean> }) => void;
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

function create_editor_content_state_from_pending_edit(pendingEdit: app_convex_Doc<"pages_pending_edits">) {
	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(pendingEdit.baseYjsUpdate);
	const stagedYjsDoc = pages_yjs_doc_create_from_array_buffer_update(pendingEdit.stagedBranchYjsUpdate);
	const unstagedYjsDoc = pages_yjs_doc_create_from_array_buffer_update(pendingEdit.unstagedBranchYjsUpdate);

	const baseMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: baseYjsDoc });
	const stagedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: stagedYjsDoc });
	const unstagedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: unstagedYjsDoc });

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
			yjsSequence: pendingEdit.baseYjsSequence,
		} satisfies RemoteEditorContentState,
	});
}

function create_editor_content_state_from_page_content_data(
	pageContentData: NonNullable<Awaited<ReturnType<typeof pages_fetch_page_yjs_state_and_markdown>>>,
) {
	if (pageContentData.markdown._nay) {
		return null;
	}

	return {
		baselineYjsDoc: pageContentData.yjsDoc,
		baselineMarkdown: pageContentData.markdown._yay,
		stagedYjsDoc: pages_yjs_doc_clone({ yjsDoc: pageContentData.yjsDoc }),
		stagedMarkdown: pageContentData.markdown._yay,
		unstagedYjsDoc: pages_yjs_doc_clone({ yjsDoc: pageContentData.yjsDoc }),
		unstagedMarkdown: pageContentData.markdown._yay,
		yjsSequence: pageContentData.yjsSequence,
	} satisfies RemoteEditorContentState;
}

function PageEditorDiff_Inner(props: PageEditorDiff_Inner_Props) {
	const {
		className,
		pageId,
		presenceStore,
		commentsPortalHost,
		hoistingContainer,
		editorContentState,
		isSaving,
		isSyncing,
		isSyncDisabled,
		onSave,
		onClickSync,
		topStickyFloatingSlot,
	} = props;

	const id = useId();
	const anchorName = `${"--PageEditorDiff-anchor-name" satisfies keyof PageEditorDiff_CssVars}-${id}`;

	const convex = useConvex();

	const editorRef = useRef<monaco_editor.IStandaloneDiffEditor | null>(null);
	const pendingEditSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const ignoredProgrammaticModelChangesRef = useRef(0);
	const [pendingEditSyncRunner] = useState(() => new CoalescedRunner());
	const lastAppliedRemoteEditorContentStateRef = useRef(editorContentState);

	// Keep the initial diff inputs stable after mount because the React wrapper still watches these props.
	// Remote updates are applied through our owned Monaco models, so changing the props would reset the diff.
	const [initialOriginalMarkdown] = useState(editorContentState.stagedMarkdown);
	const [initialUnstagedMarkdown] = useState(editorContentState.unstagedMarkdown);

	const [commentThreadIds, setCommentThreadIds] = useState<string[]>([]);
	const commentThreadIdsKeyRef = useRef<string>("");

	/** Content widgets for per-change actions (accept/discard) */
	const [contentWidgetsRef, setContentWidgets, contentWidgets] = useStateRef<
		PageEditorDiffWidgetAcceptDiscard_Monaco[]
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

	const isSaveDisabled = isSaving || isSyncing || !isDirty;
	const isAcceptAllDisabled = isSaving || isSyncing || !hasUnstagedChanges;
	const isAcceptAllAndSaveDisabled = isSaving || isSyncing || !hasUnstagedChanges;
	const isDiscardAllDisabled = isSaving || isSyncing || !hasUnstagedChanges;

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
		if (!editorModelsRef.current) {
			const error = should_never_happen("[PageEditorDiff.applyDiffs] Missing `editorModels`", {
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
			const error = should_never_happen("[PageEditorDiff.pushChangeToStagedEditor] Missing `editorModels`", {
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
			const error = should_never_happen("[PageEditorDiff.pushChangeToUnstagedEditor] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		if (!editorModelsRef.current) {
			const error = should_never_happen("[PageEditorDiff.pushChangeToUnstagedEditor] Missing `editorModels`", {
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
		modifiedEditor.executeEdits("app_pages_sync", [
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

	const upsertPendingEdit = async () => {
		if (!editorModelsRef.current) {
			return false;
		}

		const upsertResult = await convex.mutation(api.pages_pending_edit.upsert_pages_pending_edit_updates, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
			stagedMarkdown: editorModelsRef.current.original.getValue(),
			unstagedMarkdown: editorModelsRef.current.modified.getValue(),
		});
		if (upsertResult._nay) {
			console.error("[PageEditorDiff.upsertPendingEditNow] Failed to sync pending edits", {
				nay: upsertResult._nay,
				pageId,
			});
			return false;
		}

		return true;
	};

	const scheduleUpsertPendingEdit = () => {
		if (pendingEditSyncTimeoutRef.current != null) {
			window.clearTimeout(pendingEditSyncTimeoutRef.current);
		}

		pendingEditSyncTimeoutRef.current = setTimeout(() => {
			pendingEditSyncTimeoutRef.current = null;
			pendingEditSyncRunner
				.run(async () => upsertPendingEdit())
				.catch((error) => {
					console.error("[PageEditorDiff.schedulePendingEditSync] Error on sync pending edits", {
						error,
					});
				});
		}, 250);
	};

	const flushPendingEditUpsertIfNeeded = async () => {
		if (pendingEditSyncTimeoutRef.current != null) {
			clearTimeout(pendingEditSyncTimeoutRef.current);
			pendingEditSyncTimeoutRef.current = null;
		}

		// Wait for older queued/in-flight work first, then force one fresh upsert from the
		// current editor models so save operates on the latest local draft state.
		const flushResult = await pendingEditSyncRunner.flush();
		if (flushResult.aborted) {
			return false;
		}

		const runResult = await pendingEditSyncRunner.run(async () => upsertPendingEdit());
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

		if (!editorModelsRef.current) {
			console.error(
				should_never_happen("[PageEditorDiff.discardAllDiffs] Missing `editorModels`", {
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
			const error = should_never_happen("[PageEditorDiff.acceptAllDiffs] Missing `editorRef.current`", {
				editor: editorRef.current,
			});
			console.error(error);
			throw error;
		}

		if (!editorModelsRef.current) {
			const error = should_never_happen("[PageEditorDiff.acceptAllDiffs] Missing `editorModels`", {
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
			const error = should_never_happen("[PageEditorDiff.handleClickSave] Missing editor models", {
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

		onSave({ flushPendingEditUpsertIfNeeded });
	};

	const getCurrentMarkdown = () => {
		return editorModelsRef.current?.original.getValue() ?? editorContentState.stagedMarkdown;
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

			updateEditorValues({
				stagedMarkdown: remoteData.markdown._yay,
				unstagedMarkdown: remoteData.markdown._yay,
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

	const handleClickAcceptAllAndSave = () => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		acceptAllDiffs();
		doSave();
	};

	const handleClickAcceptAll = () => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		acceptAllDiffs();
	};

	const handleClickDiscardAll = () => {
		if (isSaving || isSyncing || !hasUnstagedChanges) return;
		discardAllDiffs();
	};

	const handleClickSync = () => {
		if (isSyncDisabled) return;

		if (!editorModelsRef.current) {
			console.error(
				should_never_happen("[PageEditorDiff.handleClickSync] Missing local draft state", {
					pageId,
					editor: editorRef.current,
					editorModels: editorModelsRef.current,
				}),
			);
			return;
		}

		Promise.try(async () => {
			// Drain pending edits writes before sync so an older debounced upsert cannot land
			// after the rebase/persist flow.
			if (pendingEditSyncTimeoutRef.current != null) {
				await flushPendingEditUpsertIfNeeded();
			} else {
				await pendingEditSyncRunner.flush();
			}

			if (!editorModelsRef.current) {
				toast.error("Missing local draft state while syncing");
				return;
			}

			onClickSync({
				stagedMarkdown: editorModelsRef.current.original.getValue(),
				unstagedMarkdown: editorModelsRef.current.modified.getValue(),
			});
		}).catch((error) => {
			console.error("[PageEditorDiff.handleClickSync] Error while preparing sync", {
				error,
				pageId,
			});
			toast.error("Error while preparing sync");
		});
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
		pushChangeToStagedEditor(newEditorContent);
		editorRef.current.focus();
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

		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		const nextModels = {
			original: pages_monaco_create_editor_model(initialOriginalMarkdown),
			modified: pages_monaco_create_editor_model(initialUnstagedMarkdown),
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

				scheduleUpsertPendingEdit();
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

				scheduleUpsertPendingEdit();
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

				const modifiedEditor = editorRef.current.getModifiedEditor();
				const originalEditor = editorRef.current.getOriginalEditor();
				const modifiedModel = editorModelsRef.current?.modified;
				const originalModel = editorModelsRef.current?.original;
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

	// Reconcile the remote editor content state with the local editor values,
	// Needs to be a layout effect to ensure the `isDirty` state calculated
	// when the editor model value changes is updated before paint.
	useLayoutEffect(() => {
		if (!editorModels) {
			return;
		}

		const previousRemoteEditorContentState = lastAppliedRemoteEditorContentStateRef.current;
		if (editor_content_states_match(previousRemoteEditorContentState, editorContentState)) {
			return;
		}

		const mergedStagedBranchResult = pages_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc: previousRemoteEditorContentState.stagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.stagedYjsDoc,
			localMarkdown: editorModels.original.getValue(),
		});
		if (mergedStagedBranchResult._nay) {
			console.error("[PageEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile staged branch", {
				nay: mergedStagedBranchResult._nay,
				pageId,
			});
			return;
		}

		const mergedUnstagedBranchResult = pages_yjs_reconcile_branch_with_local_markdown({
			previousRemoteYjsDoc: previousRemoteEditorContentState.unstagedYjsDoc,
			nextRemoteYjsDoc: editorContentState.unstagedYjsDoc,
			localMarkdown: editorModels.modified.getValue(),
		});
		if (mergedUnstagedBranchResult._nay) {
			console.error("[PageEditorDiff.reconcileRemoteEditorContentState] Failed to reconcile unstaged branch", {
				nay: mergedUnstagedBranchResult._nay,
				pageId,
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
					isSyncDisabled={isSyncDisabled || isSaving}
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
						original={initialOriginalMarkdown}
						modified={initialUnstagedMarkdown}
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

export function PageEditorDiff(props: PageEditorDiff_Props) {
	const { pageId, presenceStore, commentsPortalHost, className, topStickyFloatingSlot } = props;

	const convex = useConvex();
	const pendingEdit = useQuery(api.pages_pending_edit.get_pages_pending_edit, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});
	const pendingEditLastSequenceSaved = useQuery(api.pages_pending_edit.get_pages_pending_edit_last_sequence_saved, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});
	const serverSequenceData = useQuery(api.ai_docs_temp.get_page_last_yjs_sequence, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	const [pageContentData, setPageContentData] = useState<
		Awaited<ReturnType<typeof pages_fetch_page_yjs_state_and_markdown>> | undefined
	>(undefined);
	const [remoteEditorContentState, setRemoteEditorContentState] = useState<RemoteEditorContentState | undefined>(
		undefined,
	);
	const [isSaving, setIsSaving] = useState(false);
	const [isSyncing, setIsSyncing] = useState(false);

	const isSyncDisabled =
		isSyncing ||
		serverSequenceData == null ||
		remoteEditorContentState == null ||
		remoteEditorContentState.yjsSequence === serverSequenceData.lastSequence;

	/**
	 * The container for the tiptap hoisted elements.
	 * Used by the bubble to allow it to close when clicking on
	 * focusable elements in the page because it checks for the parent
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

	const handleSave: PageEditorDiff_Inner_Props["onSave"] = ({ flushPendingEditUpsertIfNeeded }) => {
		setIsSaving(true);

		Promise.try(async () => {
			const didSyncPendingEdit = await flushPendingEditUpsertIfNeeded();
			if (!didSyncPendingEdit) {
				toast.error("Failed to sync pending edits before save");
				return;
			}

			const savePendingResult = await convex.mutation(api.pages_pending_edit.save_pages_pending_edit, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});
			if (savePendingResult._nay) {
				toast.error(savePendingResult._nay.message ?? "Failed to save pending edits");
				return;
			}

			const [nextPageContentData] = await Promise.allSettled([
				pages_fetch_page_yjs_state_and_markdown({
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
				}),
				// Fetch also the pending edits query to ensure we perform
				// the state cleanups only after we are sure the data is available
				// in the local convex cache.
				convex.query(api.pages_pending_edit.get_pages_pending_edit, {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
				}),
			]);

			if (nextPageContentData.status === "fulfilled") {
				setPageContentData(nextPageContentData.value);
			}
		})
			.catch((error) => {
				console.error("[PageEditorDiff.handleSave] Failed to refresh page content after save", {
					error,
					pageId,
				});
			})
			.finally(() => {
				setIsSaving(false);
			});
	};

	const handleClickSync: PageEditorDiff_Inner_Props["onClickSync"] = (editorValues) => {
		if (isSyncing) return;

		setIsSyncing(true);

		Promise.try(async () => {
			if (!remoteEditorContentState) {
				return Result({
					_nay: {
						message: "Missing remote editor state while syncing",
					},
				});
			}

			const nextPageContentData = await pages_fetch_page_yjs_state_and_markdown({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});
			if (!nextPageContentData) {
				return Result({
					_nay: {
						message: "Missing page content after sync",
					},
				});
			}
			if (nextPageContentData.markdown._nay) {
				return Result({
					_nay: {
						message: "Failed to reconstruct latest page content while syncing",
						cause: nextPageContentData.markdown._nay,
					},
				});
			}

			const rebasedStagedBranchResult = pages_yjs_rebase_branch_with_local_markdown({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextPageContentData.yjsDoc,
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

			const rebasedUnstagedBranchResult = pages_yjs_rebase_branch_with_local_markdown({
				previousBaseYjsDoc: remoteEditorContentState.baselineYjsDoc,
				nextBaseYjsDoc: nextPageContentData.yjsDoc,
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

			const persistRebasedStateResult = await convex.mutation(
				api.pages_pending_edit.persist_pages_pending_edit_rebased_state,
				{
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
					baseYjsSequence: nextPageContentData.yjsSequence,
					baseYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(nextPageContentData.yjsDoc)),
					stagedBranchYjsUpdate: pages_u8_to_array_buffer(
						encodeStateAsUpdate(rebasedStagedBranchResult._yay.rebasedBranchYjsDoc),
					),
					unstagedBranchYjsUpdate: pages_u8_to_array_buffer(
						encodeStateAsUpdate(rebasedUnstagedBranchResult._yay.rebasedBranchYjsDoc),
					),
				},
			);
			if (persistRebasedStateResult._nay) {
				return persistRebasedStateResult;
			}

			// Fetch the pending edits query before publishing the refreshed page content so
			// sync cleanup waits for the authoritative pending-edit cache state to converge.
			await Promise.allSettled([
				convex.query(api.pages_pending_edit.get_pages_pending_edit, {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId,
				}),
			]);

			setPageContentData(nextPageContentData);

			return Result({ _yay: null });
		})
			.then((result) => {
				if (result._nay) {
					console.error("[PageEditorDiff.handleClickSync] Sync failed", {
						error: result._nay,
						pageId,
					});
					toast.error(result._nay.message ?? "Failed to sync");
				}
			})
			.catch((error) => {
				console.error("[PageEditorDiff.handleClickSync] Error while syncing", {
					error,
					pageId,
				});
				toast.error("Error while syncing");
			})
			.finally(() => {
				setIsSyncing(false);
			});
	};

	// Reset state when `pageId` changes
	useLayoutEffect(() => {
		setPageContentData(undefined);
		setRemoteEditorContentState(undefined);
		setIsSaving(false);
		setIsSyncing(false);
	}, [pageId]);

	// Fetch page content for initial load and `pageId` changes
	useEffect(() => {
		let didCancel = false;

		Promise.try(async () => {
			const nextPageContentData = await pages_fetch_page_yjs_state_and_markdown({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});
			if (didCancel) return;

			setPageContentData(nextPageContentData);
		}).catch((error) => {
			if (didCancel) return;

			console.error("[PageEditorDiff.useLayoutEffect] Failed to fetch page content data", error);
			setPageContentData(null);
		});

		return () => {
			didCancel = true;
		};
	}, [pageId]);

	// Refetch live page content only after a pending-edit save marker advances past the local page snapshot.
	useEffect(() => {
		if (
			pendingEdit !== null ||
			pendingEditLastSequenceSaved == null ||
			pageContentData == null ||
			pendingEditLastSequenceSaved.lastSequenceSaved <= pageContentData.yjsSequence
		) {
			return;
		}

		let didCancel = false;

		Promise.try(async () => {
			const nextPageContentData = await pages_fetch_page_yjs_state_and_markdown({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId,
			});
			if (didCancel) return;

			setPageContentData(nextPageContentData);
		}).catch((error) => {
			if (didCancel) return;

			console.error("[PageEditorDiff.savedSequenceRefetch] Failed to refetch page content data", {
				error,
				pageId,
				lastSequenceSaved: pendingEditLastSequenceSaved.lastSequenceSaved,
			});
		});

		return () => {
			didCancel = true;
		};
	}, [pageContentData, pageId, pendingEdit, pendingEditLastSequenceSaved]);

	// Bootstrap the remote editor content state once `pageContentData` and `pendingEdit` are ready
	useLayoutEffect(() => {
		if (remoteEditorContentState !== undefined || pendingEdit === undefined || pageContentData === undefined) {
			return;
		}

		if (pendingEdit) {
			const pendingEditInitialEditorContentState = create_editor_content_state_from_pending_edit(pendingEdit);
			if (pendingEditInitialEditorContentState._yay) {
				setRemoteEditorContentStateIfNotMatch(pendingEditInitialEditorContentState._yay);
				return;
			}

			console.error("[PageEditorDiff] Failed to reconstruct initial remote editor content state", {
				error: pendingEditInitialEditorContentState._nay,
				pageId,
			});
		}

		if (pageContentData) {
			const nextRemoteEditorContentState = create_editor_content_state_from_page_content_data(pageContentData);
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
				stagedYjsDoc: pages_yjs_doc_clone({ yjsDoc: emptyYjsDoc }),
				stagedMarkdown: "",
				unstagedYjsDoc: pages_yjs_doc_clone({ yjsDoc: emptyYjsDoc }),
				unstagedMarkdown: "",
				yjsSequence: 0,
			} satisfies RemoteEditorContentState;
		});
	}, [pageContentData, pageId, pendingEdit, remoteEditorContentState]);

	// Needs to be a layout effect so sync/save convergence updates the remote editor
	// state before paint, avoiding a brief render with stale button enablement.
	useLayoutEffect(() => {
		if (!remoteEditorContentState) {
			return;
		}

		if (pendingEdit) {
			const nextRemoteEditorContentState = create_editor_content_state_from_pending_edit(pendingEdit);
			if (nextRemoteEditorContentState._nay) {
				console.error("[PageEditorDiff.pendingEditReconcile] Failed to reconstruct remote editor content state", {
					error: nextRemoteEditorContentState._nay,
					pageId,
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

		if (!pageContentData) {
			setIsSyncing(false);
			return;
		}

		const nextRemoteEditorContentState = create_editor_content_state_from_page_content_data(pageContentData);
		if (
			nextRemoteEditorContentState &&
			!editor_content_states_match(remoteEditorContentState, nextRemoteEditorContentState)
		) {
			setRemoteEditorContentState(nextRemoteEditorContentState);
		}

		setIsSyncing(false);
	}, [pageContentData, pageId, pendingEdit, remoteEditorContentState]);

	return hoistingContainer == null ||
		pendingEdit === undefined ||
		pageContentData === undefined ||
		remoteEditorContentState === undefined ? (
		<>Loading</>
	) : (
		<PageEditorDiff_Inner
			key={pageId}
			{...props}
			className={className}
			pageId={pageId}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			hoistingContainer={hoistingContainer}
			editorContentState={remoteEditorContentState}
			isSaving={isSaving}
			isSyncing={isSyncing}
			isSyncDisabled={isSyncDisabled}
			onSave={handleSave}
			onClickSync={handleClickSync}
			topStickyFloatingSlot={topStickyFloatingSlot}
		/>
	);
}
// #endregion root
