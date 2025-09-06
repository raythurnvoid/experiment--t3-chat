import "./monaco-markdown-diff-editor.css";
import "../../lib/app-monaco-config.ts";
import { useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as M } from "monaco-editor";
import { useConvex, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn, make } from "../../lib/utils.ts";
import { makePatches, stringifyPatches } from "@sanity/diff-match-patch";
import { Button } from "../ui/button.tsx";

class AcceptDiscardContentWidget implements monaco.editor.IContentWidget {
	private readonly id: string;
	private readonly node: HTMLDivElement;
	private lineNumber: number;
	public readonly allowEditorOverflow = true;
	public anchorDecorationId: string | null = null;
	public readonly editor: M.IStandaloneCodeEditor;
	private readonly onAcceptClick: (index: number) => void;
	private readonly onDiscardClick: (index: number) => void;

	private constructor(args: {
		editor: M.IStandaloneCodeEditor;
		changeIndex: number;
		lineNumber: number;
		onAcceptClick: (index: number) => void;
		onDiscardClick: (index: number) => void;
	}) {
		this.editor = args.editor;
		this.onAcceptClick = args.onAcceptClick;
		this.onDiscardClick = args.onDiscardClick;
		this.lineNumber = args.lineNumber;
		this.id = `MonacoMarkdownDiffEditor-widget-${args.changeIndex}`;
		this.node = document.createElement("div");
		this.node.className = "MonacoMarkdownDiffEditor-widget";
		this.node.style.pointerEvents = "auto";
		const acceptBtn = document.createElement("button");
		acceptBtn.className = "MonacoMarkdownDiffEditor-widget-accept";
		acceptBtn.setAttribute("aria-label", "Accept change");
		acceptBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onAcceptClick(args.changeIndex);
		});
		const discardBtn = document.createElement("button");
		discardBtn.className = "MonacoMarkdownDiffEditor-widget-discard";
		discardBtn.setAttribute("aria-label", "Discard change");
		discardBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onDiscardClick(args.changeIndex);
		});
		this.node.appendChild(acceptBtn);
		this.node.appendChild(discardBtn);

		// Anchor to a zero-length sticky decoration at column 1
		this.updateDecorations(this.lineNumber);
	}

	getId(): string {
		return this.id;
	}

	getDomNode(): HTMLElement {
		return this.node;
	}

	getPosition(): monaco.editor.IContentWidgetPosition | null {
		return {
			position: { lineNumber: this.lineNumber, column: 1 },
			preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
		};
	}

	updateLine(lineNumber: number) {
		this.lineNumber = lineNumber;
		this.updateDecorations(lineNumber);
		this.editor.layoutContentWidget(this);
	}

	private updateDecorations(lineNumber: number) {
		const model = this.editor.getModel();
		if (!model) return;
		const newDecos = make<monaco.editor.IModelDeltaDecoration[]>([
			{
				range: new monaco.Range(lineNumber, 1, lineNumber, 1),
				options: make<monaco.editor.IModelDecorationOptions>({
					stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					isWholeLine: false,
					className: "MonacoMarkdownDiffEditor-anchor",
				}),
			},
		]);
		const oldIds: string[] = [];
		if (this.anchorDecorationId) oldIds.push(this.anchorDecorationId);
		const result = model.deltaDecorations(oldIds, newDecos);
		this.anchorDecorationId = result[0] ?? null;
	}

	afterRender(position: monaco.editor.ContentWidgetPositionPreference | null) {
		// Force non-fixed layout and shift the widget left of the text by its width + gap
		this.node.style.position = "absolute";
		this.node.style.transform = `translate3d(calc(-100% - 5px), -2px, 0)`;
		this.node.style.display = "flex";
	}

	public dispose() {
		// const model = this.editor.getModel();
		// if (model) {
		// 	const removeIds: string[] = [];
		// 	if (this.anchorDecorationId) removeIds.push(this.anchorDecorationId);
		// 	if (removeIds.length) model.deltaDecorations(removeIds, []);
		// 	this.anchorDecorationId = null;
		// }
		this.editor.removeContentWidget(this);
	}

	static addToEditor(args: {
		editor: M.IStandaloneCodeEditor;
		changeIndex: number;
		lineNumber: number;
		onAcceptClick: (index: number) => void;
		onDiscardClick: (index: number) => void;
	}) {
		const widget = new AcceptDiscardContentWidget(args);
		args.editor.addContentWidget(widget);
		return widget;
	}
}

export type MonacoMarkdownDiffEditor_Ref = {
	setModifiedContent: (value: string) => void;
};

export type MonacoMarkdownDiffEditor_Props = {
	ref?: Ref<MonacoMarkdownDiffEditor_Ref>;
	className?: string;
	pageId: string;
	threadId?: string;
	modifiedInitialValue?: string;
	onExit: () => void;
};

export function MonacoMarkdownDiffEditor(props: MonacoMarkdownDiffEditor_Props) {
	const { pageId } = props;

	const convex = useConvex();

	const [initialValue, setInitialValue] = useState<string>();

	const currentContentWatchUnsubscribe = useRef<() => void>(null);

	// Listen for updates once and also fetch latest as a fallback
	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pageId,
		});

		currentContentWatchUnsubscribe.current = watcher.onUpdate(() => {
			const value = watcher.localQueryResult();
			setInitialValue((currentValue) => currentValue ?? (typeof value === "string" ? value : ""));
		});

		(async (/* iife */) => {
			const fetchedValue = await convex.query(api.ai_docs_temp.get_page_text_content_by_page_id, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: pageId,
			});
			if (typeof fetchedValue === "string") {
				setInitialValue((currentValue) => currentValue ?? fetchedValue);
			}
		})().catch(console.error);

		return () => {
			if (currentContentWatchUnsubscribe.current) {
				currentContentWatchUnsubscribe.current();
			}
		};
	}, [convex, pageId]);

	const handleOnEditorMount: MonacoMarkdownDiffEditor_Impl_Props["onEditorMount"] = () => {
		currentContentWatchUnsubscribe.current = null;
	};

	return (
		<>
			{initialValue != null && (
				<MonacoMarkdownDiffEditor_Impl
					key={pageId}
					{...props}
					initialValue={initialValue}
					onEditorMount={handleOnEditorMount}
				></MonacoMarkdownDiffEditor_Impl>
			)}
		</>
	);
}

type MonacoMarkdownDiffEditor_Impl_Props = MonacoMarkdownDiffEditor_Props & {
	initialValue: string;
	onEditorMount: () => void;
};

function MonacoMarkdownDiffEditor_Impl(props: MonacoMarkdownDiffEditor_Impl_Props) {
	const { ref, className, pageId, threadId, modifiedInitialValue, initialValue, onExit } = props;
	const applyPatchToPageAndBroadcast = useMutation(api.ai_docs_temp.apply_patch_to_page_and_broadcast);

	const diffEditor = useRef<M.IStandaloneDiffEditor | null>(null);

	// Local copy of modified content for quick access without re-renders
	const modifiedContent = useRef<string>("");

	// Keep the original seeded content to build patches on Save & Exit
	const originalContent = useRef<string>("");

	// Latest line changes without triggering React re-renders
	const lineChanges = useRef<M.ILineChange[] | null>(null);

	/** Content widgets for per-change actions (accept/discard) */
	const contentWidgets = useRef<AcceptDiscardContentWidget[]>([]);

	const diffEditorListenersDisposable = useRef<monaco.IDisposable[]>([]);

	// Expose imperative handle to update only the modified editor content
	useImperativeHandle(
		ref,
		() => ({
			setModifiedContent: (value: string) => {
				if (!diffEditor.current) return;

				const modifiedEditor = diffEditor.current.getModifiedEditor();
				const modifiedModel = modifiedEditor.getModel();
				if (!modifiedModel) return;
				modifiedEditor.pushUndoStop();
				modifiedEditor.executeEdits("MonacoMarkdownDiffEditor.setModified", [
					{ range: modifiedModel.getFullModelRange(), text: value, forceMoveMarkers: false },
				]);
				modifiedEditor.pushUndoStop();
				modifiedContent.current = value;
			},
		}),
		[diffEditor],
	);

	// Class moved to module scope above

	// (legacy helper kept for reference) toExclusiveLineRange no longer used

	// retained helper previously used for minimal edits; no longer used in applyLineChanges path
	// function getLines(model: M.ITextModel, startLine: number, endLine: number) {
	// 	if (startLine <= 0 || endLine <= 0 || endLine < startLine) return "";
	// 	const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
	// 	return model.getValueInRange(range);
	// }

	// VS Code accurate algorithm: applyLineChanges(original, modified, diffs) → string
	function applyLineChanges_like_vscode(
		originalText: string,
		modifiedText: string,
		diffs: ReadonlyArray<M.ILineChange>,
	): string {
		function computeLineIndex(text: string) {
			const lineStarts: number[] = [0];
			const lineContentEnds: number[] = [];
			for (let i = 0; i < text.length; i++) {
				const ch = text.charCodeAt(i);
				if (ch === 10 /* \n */) {
					const prevIdx = i - 1;
					const prevWasCR = prevIdx >= 0 && text.charCodeAt(prevIdx) === 13; /* \r */
					lineContentEnds.push(prevWasCR ? i - 1 : i);
					lineStarts.push(i + 1);
				}
			}
			// Last line (may have no trailing EOL)
			lineContentEnds.push(text.length);
			return { lineStarts, lineContentEnds, lineCount: lineStarts.length };
		}

		function getTextRange(
			text: string,
			index: { lineStarts: number[]; lineContentEnds: number[]; lineCount: number },
			startLineZero: number,
			startChar: number,
			endLineZeroExclusive: number,
			endChar: number,
		): string {
			// Clamp line indices to valid bounds to avoid out-of-range indexing when accepting EOF insertions
			const startLineClamped = Math.max(0, Math.min(index.lineCount, startLineZero));
			const endLineClamped = Math.max(0, Math.min(index.lineCount, endLineZeroExclusive));
			const startOffset =
				startLineClamped >= index.lineCount ? text.length : index.lineStarts[startLineClamped]! + startChar;
			const endOffset = endLineClamped >= index.lineCount ? text.length : index.lineStarts[endLineClamped]! + endChar;
			const from = Math.max(0, Math.min(startOffset, text.length));
			const to = Math.max(from, Math.min(endOffset, text.length));
			return text.substring(from, to);
		}

		const original = computeLineIndex(originalText);
		const modified = computeLineIndex(modifiedText);

		const resultParts: string[] = [];
		let currentLine = 0; // zero-based

		for (const diff of diffs) {
			const isInsertion = diff.originalEndLineNumber === 0;
			const isDeletion = diff.modifiedEndLineNumber === 0;

			let endLine = isInsertion ? diff.originalStartLineNumber : diff.originalStartLineNumber - 1; // zero-based
			let endCharacter = 0;

			// deletion at end of document: account for trailing EOL of the last kept line
			if (isDeletion && diff.originalEndLineNumber === original.lineCount) {
				endLine -= 1;
				const contentEndOffset = original.lineContentEnds[endLine]!;
				endCharacter = contentEndOffset - original.lineStarts[endLine]!;
			}

			// keep original chunk up to start of this diff
			if (endLine >= currentLine) {
				const kept = getTextRange(originalText, original, currentLine, 0, endLine, endCharacter);
				resultParts.push(kept);
			}

			if (!isDeletion) {
				let fromLine = diff.modifiedStartLineNumber - 1; // zero-based
				let fromCharacter = 0;
				// insertion at or after end of original: take correct EOL of the last existing line
				if (isInsertion && diff.originalStartLineNumber >= original.lineCount) {
					fromLine -= 1;
					const contentEndOffset = modified.lineContentEnds[fromLine]!;
					fromCharacter = contentEndOffset - modified.lineStarts[fromLine]!;
				}
				resultParts.push(getTextRange(modifiedText, modified, fromLine, fromCharacter, diff.modifiedEndLineNumber, 0));
			}

			// Move currentLine to the next segment in original. Guard against EOF insertions using clamping.
			const nextCurrentLineOneBased = isInsertion ? diff.originalStartLineNumber : diff.originalEndLineNumber;
			// Convert to zero-based exclusive start for the remainder copy
			currentLine = Math.max(0, Math.min(original.lineCount, nextCurrentLineOneBased));
		}

		// append the remainder of the original text
		resultParts.push(getTextRange(originalText, original, currentLine, 0, original.lineCount, 0));
		return resultParts.join("");
	}

	function acceptChangeAtIndex(changeIndex: number) {
		if (!diffEditor.current) return;
		const originalEditor = diffEditor.current.getOriginalEditor();
		const modifiedEditor = diffEditor.current.getModifiedEditor();
		const originalEditorModel = originalEditor.getModel();
		const modifiedEditorModel = modifiedEditor.getModel();
		const diffs = diffEditor.current.getLineChanges();
		if (!diffs || !originalEditorModel || !modifiedEditorModel || changeIndex < 0 || changeIndex >= diffs.length) {
			return;
		}

		const originalText = originalEditorModel.getValue();
		const modifiedText = modifiedEditorModel.getValue();
		const selected = [diffs[changeIndex]!];
		const result = applyLineChanges_like_vscode(originalText, modifiedText, selected);

		originalEditor.pushUndoStop();
		originalEditor.executeEdits("MonacoMarkdownDiffEditor.accept.vscode", [
			{ range: originalEditorModel.getFullModelRange(), text: result, forceMoveMarkers: true },
		]);
		originalEditor.pushUndoStop();

		diffEditor.current.focus();
	}

	function discardChangeAtIndex(changeIndex: number) {
		if (!diffEditor.current) return;
		const originalEditor = diffEditor.current.getOriginalEditor();
		const modifiedEditor = diffEditor.current.getModifiedEditor();
		const originalEditorModel = originalEditor.getModel();
		const modifiedEditorModel = modifiedEditor.getModel();
		const diffs = diffEditor.current.getLineChanges();
		if (!diffs || !originalEditorModel || !modifiedEditorModel || changeIndex < 0 || changeIndex >= diffs.length) {
			return;
		}

		const originalText = originalEditorModel.getValue();
		const modifiedText = modifiedEditorModel.getValue();
		const keep = diffs.filter((_, i) => i !== changeIndex);
		const result = applyLineChanges_like_vscode(originalText, modifiedText, keep);

		modifiedEditor.pushUndoStop();
		modifiedEditor.executeEdits("MonacoMarkdownDiffEditor.discard.vscode", [
			{ range: modifiedEditorModel.getFullModelRange(), text: result, forceMoveMarkers: false },
		]);
		modifiedEditor.pushUndoStop();
		modifiedContent.current = result;

		diffEditor.current.focus();
	}

	const handleOnMount: DiffEditorProps["onMount"] = (e) => {
		diffEditor.current = e;

		// Apply initialValue once editor is mounted, then unsubscribe the watch
		if (!diffEditor.current || initialValue === undefined) return;

		const originalEditor = diffEditor.current.getOriginalEditor();
		const modifiedEditor = diffEditor.current.getModifiedEditor();
		const originalEditorModel = originalEditor?.getModel();
		const modifiedEditorModel = modifiedEditor?.getModel();
		if (!originalEditorModel || !modifiedEditorModel) return;

		// Force consistent EOL across both models
		originalEditorModel.setEOL(monaco.editor.EndOfLineSequence.LF);
		modifiedEditorModel.setEOL(monaco.editor.EndOfLineSequence.LF);

		// Preserve the original content for later patch creation
		originalContent.current = initialValue;
		originalEditorModel.setValue(initialValue);

		// Seed local value for modified copy
		modifiedContent.current = modifiedInitialValue ?? initialValue;
		modifiedEditorModel.setValue(modifiedContent.current);

		// Listen for modified editor content and diff updates
		diffEditorListenersDisposable.current = [
			modifiedEditor.onDidChangeModelContent(() => {
				modifiedContent.current = modifiedEditor.getValue();

				const modifiedEditorModel = modifiedEditor.getModel();
				if (!modifiedEditorModel) return;

				// Immediately realign widgets on content change
				// because the onDifUpdateDiff event will take more
				// time to fire.
				for (const widget of contentWidgets.current) {
					const decoId = widget.anchorDecorationId;
					if (decoId) {
						const range = modifiedEditorModel.getDecorationRange(decoId);
						if (range) {
							widget.updateLine(range.startLineNumber);
							continue;
						}
					}
				}
			}),

			diffEditor.current.onDidUpdateDiff(() => {
				if (!diffEditor.current) return;

				const changes = diffEditor.current.getLineChanges();
				if (!changes) return;
				lineChanges.current = changes;
				const modifiedEditor = diffEditor.current.getModifiedEditor();
				const originalEditor = diffEditor.current.getOriginalEditor();
				const model = modifiedEditor.getModel();
				if (!originalEditor || !modifiedEditor || !model) return;

				// Remove widgets for changes that no longer exist
				for (const widget of contentWidgets.current.splice(changes.length)) {
					widget.dispose();
				}

				// Create/update widgets
				for (let i = 0; i < changes.length; i++) {
					const change = changes[i];

					const line = change.modifiedEndLineNumber
						? change.modifiedStartLineNumber
						: change.originalStartLineNumber || 1;

					// Select the editor based on the changed lines to make sure the widget is always
					// aligned with either the modified or original editor.
					const targetEditor = change.modifiedEndLineNumber ? modifiedEditor : originalEditor;

					const existingWidget = contentWidgets.current.at(i);

					// If the widget exists and its editor matches
					// the expected target editor, update the line,
					if (existingWidget) {
						if (existingWidget.editor === targetEditor) {
							existingWidget.updateLine(line);
							continue;
						}
						// if the editor does not match, dispose the widget.
						else {
							existingWidget.dispose();
							contentWidgets.current.splice(i, 1);
						}
					}

					// If the widget does not exist or the target editor did not match,
					// create a new one.
					contentWidgets.current.push(
						AcceptDiscardContentWidget.addToEditor({
							editor: targetEditor,
							changeIndex: i,
							lineNumber: line,
							onAcceptClick: (index) => {
								acceptChangeAtIndex(index);
							},
							onDiscardClick: (index) => {
								discardChangeAtIndex(index);
							},
						}),
					);
				}
			}),
		];
	};

	const handleDiscardAll = () => {
		if (!diffEditor.current) return;

		const baseEditor = diffEditor.current.getOriginalEditor();
		const modifiedEditor = diffEditor.current.getModifiedEditor();
		const baseModel = baseEditor.getModel();
		const modifiedModel = modifiedEditor.getModel();
		if (!baseModel || !modifiedModel) return;
		const originalText = baseModel.getValue();
		const modifiedText = modifiedModel.getValue();
		// VS Code: applyLineChanges(original, modified, []) -> original text
		const result = applyLineChanges_like_vscode(originalText, modifiedText, []);

		// Preserve selections and visible ranges (VS Code-like behavior)
		const selectionsBefore = modifiedEditor.getSelections();
		const visibleRangesBefore = modifiedEditor.getVisibleRanges();
		modifiedEditor.pushUndoStop();
		modifiedEditor.executeEdits("MonacoMarkdownDiffEditor.discardAll.vscode", [
			{ range: modifiedModel.getFullModelRange(), text: result, forceMoveMarkers: false },
		]);
		modifiedEditor.pushUndoStop();
		modifiedContent.current = result;

		// Restore selections and reveal previous viewport
		if (selectionsBefore) {
			modifiedEditor.setSelections(selectionsBefore);
		}
		const vrDiscardAll = visibleRangesBefore && visibleRangesBefore.length ? visibleRangesBefore[0] : undefined;
		if (vrDiscardAll) {
			modifiedEditor.revealRange(vrDiscardAll, monaco.editor.ScrollType.Smooth);
		}
	};

	const handleAcceptAll = () => {
		if (!diffEditor.current) return;

		const baseEditor = diffEditor.current.getOriginalEditor();
		const modifiedEditor = diffEditor.current.getModifiedEditor();
		const baseModel = baseEditor.getModel();
		const modifiedModel = modifiedEditor.getModel();
		if (!baseModel || !modifiedModel) return;
		const originalText = baseModel.getValue();
		const modifiedText = modifiedModel.getValue();
		const diffs = diffEditor.current.getLineChanges() ?? [];
		const result = applyLineChanges_like_vscode(originalText, modifiedText, diffs);

		// Preserve selections and visible ranges (VS Code-like behavior)
		const selectionsBefore = baseEditor.getSelections();
		const visibleRangesBefore = baseEditor.getVisibleRanges();

		baseEditor.pushUndoStop();
		baseEditor.executeEdits("MonacoMarkdownDiffEditor.acceptAll.vscode", [
			{ range: baseModel.getFullModelRange(), text: result, forceMoveMarkers: false },
		]);
		baseEditor.pushUndoStop();

		// Restore selections and reveal previous viewport
		if (selectionsBefore) {
			baseEditor.setSelections(selectionsBefore);
		}
		const vrAcceptAll = visibleRangesBefore && visibleRangesBefore.length ? visibleRangesBefore[0] : undefined;
		if (vrAcceptAll) {
			baseEditor.revealRange(vrAcceptAll, monaco.editor.ScrollType.Smooth);
		}
	};

	const handleSaveAndExit = async () => {
		if (!diffEditor.current) return;
		const baseEditor = diffEditor.current.getOriginalEditor();
		const baseModel = baseEditor.getModel();
		if (!baseModel) return;
		const before = (originalContent.current ?? "").replace(/\r\n?/g, "\n");
		const after = baseModel.getValue().replace(/\r\n?/g, "\n");
		try {
			const patches = makePatches(before, after, { margin: 100 });
			const patchText = stringifyPatches(patches);
			await applyPatchToPageAndBroadcast({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: pageId,
				patch: patchText,
				threadId: threadId,
			});
			onExit();
		} catch (err) {
			console.error("MonacoMarkdownDiffEditor save-and-exit: patch generation/apply failed", err);
		}
	};

	// Cleanup widgets on unmount
	useEffect(() => {
		return () => {
			// Dispose editor event listeners
			for (const disposable of diffEditorListenersDisposable.current) {
				disposable.dispose();
			}

			// Dispose widgets
			if (!diffEditor.current) return;
			const modifiedEditor = diffEditor.current.getModifiedEditor();
			if (!modifiedEditor) return;
			for (const widget of contentWidgets.current.splice(0)) {
				widget.dispose();
			}
		};
	}, []);

	return (
		<div className={cn("MonacoMarkdownDiffEditor flex h-full w-full flex-col", className)}>
			{/* Header similar to regular editor avatars bar, with actions on the right */}
			<div className="MonacoMarkdownDiffEditor-header flex items-center gap-2 border-b border-border/80 bg-background/50 p-2">
				<div className="MonacoMarkdownDiffEditor-header-title text-sm text-muted-foreground">Review changes</div>
				<div className="MonacoMarkdownDiffEditor-header-actions ml-auto flex items-center gap-2">
					<Button
						variant="destructive"
						size="sm"
						className="MonacoMarkdownDiffEditor-header-discard"
						onClick={handleDiscardAll}
					>
						Discard All
					</Button>
					<Button
						size="sm"
						className="MonacoMarkdownDiffEditor-header-accept text-white"
						style={{ background: "hsl(var(--success, 142 76% 36%))" }}
						onClick={handleAcceptAll}
					>
						Accept All
					</Button>
					<Button size="sm" className="MonacoMarkdownDiffEditor-header-save" onClick={handleSaveAndExit}>
						Save and exit
					</Button>
				</div>
			</div>
			<DiffEditor
				height="100%"
				onMount={handleOnMount}
				originalLanguage="markdown"
				modifiedLanguage="markdown"
				options={{
					originalEditable: true,
					renderSideBySide: false,
					wordWrap: "on",
					glyphMargin: false,
					lineDecorationsWidth: 72,
					renderMarginRevertIcon: false,
					renderGutterMenu: false,
					fixedOverflowWidgets: false,

					lineNumbers: "on",
					renderLineHighlight: "all",
					renderLineHighlightOnlyWhenFocus: true,
				}}
			/>
		</div>
	);
}
