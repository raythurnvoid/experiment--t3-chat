import "./page-editor-diff.css";
import { Check, Undo2 } from "lucide-react";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import React, { Suspense, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { editor as monaco_editor, Range as monaco_Range } from "monaco-editor";
import { useMutation, useQuery } from "convex/react";
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
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { CheckCheck, RefreshCcw, Save, SaveAll, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Await } from "@/components/await.tsx";
import { Doc as YDoc, applyUpdate } from "yjs";
import { useStateRef } from "@/hooks/utils-hooks.ts";
import {
	pages_monaco_create_editor_model,
	pages_headless_tiptap_editor_create,
	pages_u8_to_array_buffer,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_yjs_doc_clone,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
	pages_fetch_page_yjs_state_and_markdown,
} from "@/lib/pages.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { PageEditorCommentsSidebar } from "../page-editor-comments-sidebar.tsx";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";

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

type PageEditorDiff_Inner_Props = PageEditorDiff_Props & {
	hoistingContainer: HTMLElement;
	initialData: {
		markdown: string;
		mut_yjsDoc: YDoc;
		yjsSequence: number;
	};
};

function PageEditorDiff_Inner(props: PageEditorDiff_Inner_Props) {
	const {
		ref,
		className,
		pageId,
		presenceStore,
		modifiedInitialValue,
		pendingEditUpdatedAt,
		commentsPortalHost,
		hoistingContainer,
		initialData,
		topStickyFloatingSlot,
	} = props;

	const id = useId();
	const anchorName = `${"--PageEditorDiff-anchor-name" satisfies keyof PageEditorDiff_CssVars}-${id}`;

	const pushYjsUpdateMutation = useMutation(api.ai_docs_temp.yjs_push_update);
	const clearPendingEditMutation = useMutation(api.ai_chat.clear_ai_pending_edit);

	const serverSequenceData = useQuery(api.ai_docs_temp.get_page_last_yjs_sequence, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	const editorRef = useRef<monaco_editor.IStandaloneDiffEditor | null>(null);
	const baselineYjsDocRef = useRef<YDoc>(initialData.mut_yjsDoc);
	const baselineMarkdownRef = useRef<string>(initialData.markdown);

	const [isDirtyRef, setIsDirty, isDirty] = useStateRef(false);

	const [workingYjsSequence, setWorkingYjsSequence] = useState(initialData.yjsSequence);

	const [hasDiffs, setHasDiffs] = useState(false);

	const [isSyncing, setIsSyncing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

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

	const pendingModifiedContentRef = useRef<string | null>(null);

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

	const updateDirtyBaseline = (newBaselineMarkdown: string) => {
		baselineMarkdownRef.current = newBaselineMarkdown;
		setIsDirty(false);
	};

	const clearPendingEdit = async () => {
		if (pendingEditUpdatedAt == null) {
			return;
		}

		await clearPendingEditMutation({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
			expectedUpdatedAt: pendingEditUpdatedAt,
		});
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

	const updateIsStagedDirty = () => {
		const original = modelsRef.current?.original.getValue();
		if (original == null) return;
		setIsDirty(original !== baselineMarkdownRef.current);
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
			const baselineYjsDoc = baselineYjsDocRef.current;

			const workingMarkdown = originalEditorModel.getValue();
			const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDoc });

			const updatedYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: workingMarkdown,
			});

			if (updatedYjsDocFromMarkdown._nay) {
				console.error(updatedYjsDocFromMarkdown._nay);
				return;
			}

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
				if (result && result.newSequence === workingYjsSequence + 1) {
					setWorkingYjsSequence(result.newSequence);
				}
			}

			updateDirtyBaseline(workingMarkdown);
			updateThreadIds(workingMarkdown);

			await clearPendingEdit().catch((error) => {
				console.error("[PageEditorDiff.handleClickSave] Failed to clear pending edit", error);
			});
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

			// Reset baselines and sequences
			baselineYjsDocRef.current = remoteData.yjsDoc;
			setWorkingYjsSequence(remoteData.yjsSequence);
			updateDirtyBaseline(remoteData.markdown._yay);

			// Apply the restored content to both Monaco models
			pushChangeToWorkingEditor(remoteData.markdown._yay);
			pushChangeToUnstagedEditor(remoteData.markdown._yay);

			// Update thread IDs based on the new baseline
			updateThreadIds(remoteData.markdown._yay);

			// Ensure hasDiffs is false since both models now have the same content
			setHasDiffs(false);
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

		const editorModels = modelsRef.current;

		if (!editorModels) {
			console.error(
				should_never_happen("[PageEditorDiff.handleClickSync] Missing `editorModels`", {
					editorModels,
				}),
			);
			return;
		}

		setIsSyncing(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const workingMarkdown = editorModels.original.getValue();
			const unstagedMarkdown = editorModels.modified.getValue();
			const workingYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDocRef.current });
			const workingYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: workingYjsDoc,
				markdown: workingMarkdown,
			});
			if (workingYjsDocFromMarkdown._nay) {
				console.error("[PageEditorDiff.handleClickSync] Error while rebuilding working Y.Doc from markdown", {
					nay: workingYjsDocFromMarkdown._nay,
				});
				return;
			}
			const unstagedYjsDoc = pages_yjs_doc_clone({ yjsDoc: baselineYjsDocRef.current });
			const unstagedYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
				mut_yjsDoc: unstagedYjsDoc,
				markdown: unstagedMarkdown,
			});
			if (unstagedYjsDocFromMarkdown._nay) {
				console.error("[PageEditorDiff.handleClickSync] Error while rebuilding unstaged Y.Doc from markdown", {
					nay: unstagedYjsDocFromMarkdown._nay,
				});
				return;
			}

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

			if (remoteData.markdown._nay) {
				console.error("[PageEditorDiff.handleClickSync] Error while fetching remote data", {
					nay: remoteData.markdown._nay,
				});
				return;
			}

			// Make sure both working and unstaged editors are synced with the remote.

			// Diff update from working to remote.
			const workingToRemoveDiffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: remoteData.yjsDoc,
				yjsBeforeDoc: workingYjsDoc,
			});

			if (workingToRemoveDiffUpdate) {
				applyUpdate(workingYjsDoc, workingToRemoveDiffUpdate);
			}

			// Diff update from unstaged to remote.
			const unstagedToRemoveDiffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
				yjsDoc: remoteData.yjsDoc,
				yjsBeforeDoc: unstagedYjsDoc,
			});

			if (unstagedToRemoveDiffUpdate) {
				applyUpdate(unstagedYjsDoc, unstagedToRemoveDiffUpdate);
			}

			const mergedWorkingMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: workingYjsDoc });
			const mergedUnstagedMarkdown = pages_yjs_doc_get_markdown({ yjsDoc: unstagedYjsDoc });

			if (mergedWorkingMarkdown._nay) {
				console.error("[PageEditorDiff.handleClickSync] Error while getting merged working markdown", {
					nay: mergedWorkingMarkdown._nay,
				});
				return;
			}
			if (mergedUnstagedMarkdown._nay) {
				console.error("[PageEditorDiff.handleClickSync] Error while getting merged unstaged markdown", {
					nay: mergedUnstagedMarkdown._nay,
				});
				return;
			}

			// Update dirty detection baseline.
			baselineYjsDocRef.current = remoteData.yjsDoc;
			updateDirtyBaseline(mergedWorkingMarkdown._yay);
			setWorkingYjsSequence(remoteData.yjsSequence);

			// Apply the merged content as a single undoable edit.
			// TODO: if we save the local edits as incremental updates we can let the user undo granularly.
			if (mergedWorkingMarkdown._yay !== remoteData.markdown._yay) {
				pushChangeToWorkingEditor(mergedWorkingMarkdown._yay);
			}
			if (mergedUnstagedMarkdown._yay !== remoteData.markdown._yay) {
				pushChangeToUnstagedEditor(mergedUnstagedMarkdown._yay);
			}

			updateThreadIds(remoteData.markdown._yay);
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

		(async (/* iife */) => {
			await clearPendingEdit();
		})().catch((error) => {
			console.error("[PageEditorDiff.handleClickDiscardAll] Failed to clear pending edit", error);
			toast.error("Failed to clear pending edits");
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

		const prevModels = [editor.getModel()?.original, editor.getModel()?.modified];
		modelsRef.current = {
			original: pages_monaco_create_editor_model(initialData.markdown),
			modified: pages_monaco_create_editor_model(modifiedInitialValue ?? initialData.markdown),
		};
		editor.setModel(modelsRef.current);
		prevModels.forEach((model) => model?.dispose());

		// If there were "pending edits" to show pending,
		// show them and clear the pending value.
		if (pendingModifiedContentRef.current != null) {
			pushChangeToUnstagedEditor(pendingModifiedContentRef.current);
			pendingModifiedContentRef.current = null;
		}

		updateThreadIds(initialData.markdown);

		monacoListenersDisposeAbortControllers.current?.abort();
		monacoListenersDisposeAbortControllers.current = new AbortController();

		const disposeListenersObjects = [
			editor.getOriginalEditor().onDidChangeModelContent(() => {
				updateIsStagedDirty();
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

			modelsRef.current?.original.dispose();
			modelsRef.current?.modified.dispose();
			modelsRef.current = null;
			pendingModifiedContentRef.current = null;
		};
	}, []);

	useImperativeHandle(
		ref,
		() =>
			({
				setModifiedContent: (value: string) => {
					// If the editor is mounted we can apply the diff value immediately.
					if (editorRef.current) {
						pushChangeToUnstagedEditor(value);
					}
					// Otherwise, we need to wait for the editor to be mounted to apply the changes.
					else {
						pendingModifiedContentRef.current = value;
					}
				},
			}) satisfies PageEditorDiff_Ref,
		[],
	);

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
						original={initialData.markdown}
						modified={modifiedInitialValue ?? initialData.markdown}
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

export type PageEditorDiff_Ref = {
	setModifiedContent: (value: string) => void;
};

export type PageEditorDiff_Props = {
	ref?: Ref<PageEditorDiff_Ref>;
	className?: string;
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	threadId?: string;
	modifiedInitialValue?: string;
	pendingEditUpdatedAt?: number;
	commentsPortalHost: HTMLElement | null;
	onExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
};

export function PageEditorDiff(props: PageEditorDiff_Props) {
	const { pageId, presenceStore, modifiedInitialValue, commentsPortalHost, className, topStickyFloatingSlot } = props;

	const pageContentData = pages_fetch_page_yjs_state_and_markdown({
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

	return (
		hoistingContainer != null && (
			<Suspense fallback={<>Loading</>}>
				<Await promise={pageContentData}>
					{(pageContentData) => {
						if (pageContentData?.markdown._nay) {
							console.error("[PageEditorDiff] Error while fetching page content data", pageContentData.markdown._nay);
						}

						return (
							<PageEditorDiff_Inner
								key={pageId}
								{...props}
								className={className}
								pageId={pageId}
								presenceStore={presenceStore}
								modifiedInitialValue={modifiedInitialValue}
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
					}}
				</Await>
			</Suspense>
		)
	);
}
// #endregion root
