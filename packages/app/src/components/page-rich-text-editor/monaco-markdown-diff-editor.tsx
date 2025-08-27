import "./monaco-markdown-diff-editor.css";
import "../../lib/app-monaco-config.ts";
import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as M } from "monaco-editor";
import { useConvex, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";
import { makePatches, stringifyPatches } from "@sanity/diff-match-patch";
import { Button } from "../ui/button.tsx";

class AcceptDiscardContentWidget implements monaco.editor.IContentWidget {
	private readonly id: string;
	private readonly node: HTMLDivElement;
	private lineNumber: number;
	public readonly allowEditorOverflow = true;
	private anchorDecorationId: string | null = null;

	constructor(
		private readonly editor: M.IStandaloneCodeEditor,
		changeIndex: number,
		lineNumber: number,
		private readonly onAcceptClick: (index: number) => void,
		private readonly onDiscardClick: (index: number) => void,
	) {
		this.id = `MonacoMarkdownDiffEditor-widget-${changeIndex}`;
		this.lineNumber = lineNumber;
		this.node = document.createElement("div");
		this.node.className = "MonacoMarkdownDiffEditor-widget";
		this.node.style.pointerEvents = "auto";
		const acceptBtn = document.createElement("button");
		acceptBtn.className = "MonacoMarkdownDiffEditor-widget-accept";
		acceptBtn.setAttribute("aria-label", "Accept change");
		acceptBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onAcceptClick(changeIndex);
		});
		const discardBtn = document.createElement("button");
		discardBtn.className = "MonacoMarkdownDiffEditor-widget-discard";
		discardBtn.setAttribute("aria-label", "Discard change");
		discardBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onDiscardClick(changeIndex);
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
		const newDecos: monaco.editor.IModelDeltaDecoration[] = [
			{
				range: new monaco.Range(lineNumber, 1, lineNumber, 1),
				options: {
					stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					isWholeLine: false,
					className: "MonacoMarkdownDiffEditor-anchor",
					description: "anchor-decoration-for-content-widget",
				} as monaco.editor.IModelDecorationOptions,
			},
		];
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
		const model = this.editor.getModel();
		if (model) {
			const removeIds: string[] = [];
			if (this.anchorDecorationId) removeIds.push(this.anchorDecorationId);
			if (removeIds.length) model.deltaDecorations(removeIds, []);
			this.anchorDecorationId = null;
		}
	}
}

export interface MonacoMarkdownDiffEditor_Props {
	className?: string;
	docId: string;
	onExit: () => void;
}

export function MonacoMarkdownDiffEditor(props: MonacoMarkdownDiffEditor_Props) {
	const { className, docId, onExit } = props;
	const convex = useConvex();
	const applyPatchToPageAndBroadcast = useMutation(api.ai_docs_temp.apply_patch_to_page_and_broadcast);

	const [diffEditor, setDiffEditor] = useState<M.IStandaloneDiffEditor | null>(null);
	const textContentWatchRef = useRef<{ unsubscribe: () => void } | null>(null);
	const [initialValue, setInitialValue] = useState<string | null | undefined>(undefined);

	// Local copy of modified content for quick access without re-renders
	const modifiedContentRef = useRef<string>("");

	// Keep the original seeded content to build patches on Save & Exit
	const originalSeedRef = useRef<string>("");

	// Latest line changes without triggering React re-renders
	const lineChangesRef = useRef<M.ILineChange[] | null>(null);

	// Content widgets for per-change actions (accept/discard) keyed by change index
	const contentWidgetsRef = useRef<Map<number, monaco.editor.IContentWidget>>(new Map());

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

	const test = useRef(false);

	function acceptChangeAtIndex(changeIndex: number) {
		if (!diffEditor) return;

		test.current = true;

		const baseEditor = diffEditor.getOriginalEditor();
		const modifiedEditor = diffEditor.getModifiedEditor();
		const baseModel = baseEditor.getModel();
		const modifiedModel = modifiedEditor.getModel();
		const diffs = diffEditor.getLineChanges() ?? [];
		if (!baseModel || !modifiedModel || changeIndex < 0 || changeIndex >= diffs.length) return;

		// Preserve selections and visible ranges (VS Code-like behavior)
		const selectionsBefore = baseEditor.getSelections();
		const visibleRangesBefore = baseEditor.getVisibleRanges();

		const originalText = baseModel.getValue();
		const modifiedText = modifiedModel.getValue();
		const selected = [diffs[changeIndex]!];
		const result = applyLineChanges_like_vscode(originalText, modifiedText, selected);

		baseEditor.pushUndoStop();
		baseEditor.executeEdits("MonacoMarkdownDiffEditor.accept.vscode", [
			{ range: baseModel.getFullModelRange(), text: result, forceMoveMarkers: false },
		]);
		baseEditor.pushUndoStop();

		// Restore selections and reveal previous viewport
		if (selectionsBefore) {
			baseEditor.setSelections(selectionsBefore);
		}
		const vr = visibleRangesBefore && visibleRangesBefore.length ? visibleRangesBefore[0] : undefined;
		if (vr) {
			baseEditor.revealRange(vr, monaco.editor.ScrollType.Smooth);
		}
	}

	function discardChangeAtIndex(changeIndex: number) {
		if (!diffEditor) return;
		const baseEditor = diffEditor.getOriginalEditor();
		const modifiedEditor = diffEditor.getModifiedEditor();
		const baseModel = baseEditor.getModel();
		const modifiedModel = modifiedEditor.getModel();
		const diffs = diffEditor.getLineChanges() ?? [];
		if (!baseModel || !modifiedModel || changeIndex < 0 || changeIndex >= diffs.length) return;

		// Preserve selections and visible ranges (VS Code-like behavior)
		const selectionsBefore = modifiedEditor.getSelections();
		const visibleRangesBefore = modifiedEditor.getVisibleRanges();

		const originalText = baseModel.getValue();
		const modifiedText = modifiedModel.getValue();
		const keep = diffs.filter((_, i) => i !== changeIndex);
		const result = applyLineChanges_like_vscode(originalText, modifiedText, keep);

		modifiedEditor.pushUndoStop();
		modifiedEditor.executeEdits("MonacoMarkdownDiffEditor.discard.vscode", [
			{ range: modifiedModel.getFullModelRange(), text: result, forceMoveMarkers: false },
		]);
		modifiedEditor.pushUndoStop();
		modifiedContentRef.current = result;

		// Restore selections and reveal previous viewport
		if (selectionsBefore) {
			modifiedEditor.setSelections(selectionsBefore);
		}
		const vr = visibleRangesBefore && visibleRangesBefore.length ? visibleRangesBefore[0] : undefined;
		if (vr) {
			modifiedEditor.revealRange(vr, monaco.editor.ScrollType.Smooth);
		}
	}

	// Listen for updates once and also fetch latest as a fallback
	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: docId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			const v = watcher.localQueryResult();
			setInitialValue((currentValue) => currentValue ?? (typeof v === "string" ? v : ""));
		});

		textContentWatchRef.current = {
			unsubscribe: () => {
				unsubscribe();
				textContentWatchRef.current = null;
			},
		};

		void (async () => {
			const fetchedValue = await convex.query(api.ai_docs_temp.get_page_text_content_by_page_id, {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: docId,
			});
			if (typeof fetchedValue === "string") {
				setInitialValue((currentValue) => currentValue ?? fetchedValue);
			}
		})();

		return () => {
			textContentWatchRef.current?.unsubscribe();
		};
	}, [convex, docId]);

	// Apply initialValue once editor is mounted, then unsubscribe the watch
	useEffect(() => {
		if (!diffEditor || initialValue === undefined) return;
		const baseEditor = diffEditor.getOriginalEditor();
		const modifiedEditor = diffEditor.getModifiedEditor();
		const baseModel = baseEditor?.getModel();
		const modifiedModel = modifiedEditor?.getModel();
		if (!baseModel || !modifiedModel) return;
		const seed = typeof initialValue === "string" ? initialValue : "";
		baseModel.setValue(seed);
		modifiedModel.setValue(seed);
		// Force consistent EOL across both models
		baseModel.setEOL(monaco.editor.EndOfLineSequence.LF);
		modifiedModel.setEOL(monaco.editor.EndOfLineSequence.LF);
		// Seed local value for modified copy
		modifiedContentRef.current = seed;
		// Preserve the original content for later patch creation
		originalSeedRef.current = seed;
		// Unsubscribe the text watcher now that we seeded once
		textContentWatchRef.current?.unsubscribe();
	}, [diffEditor, initialValue]);

	// Track modified editor content and listen for diff updates
	useEffect(
		() => {
			if (!diffEditor) return;

			const modifiedEditor = diffEditor.getModifiedEditor();

			if (!modifiedEditor) return;

			const listeners = [
				modifiedEditor.onDidChangeModelContent(() => {
					const v = modifiedEditor.getValue();
					modifiedContentRef.current = v;
					// Immediately realign widgets based on their anchor decorations
					const modelNow = modifiedEditor.getModel();
					if (!modelNow) return;

					for (const [, w] of contentWidgetsRef.current) {
						const anyWidget = w as unknown as {
							anchorDecorationId?: string | null;
							updateLine: (ln: number) => void;
						};

						const decoId = anyWidget.anchorDecorationId;
						if (decoId) {
							const range = modelNow.getDecorationRange(decoId);
							if (range) {
								anyWidget.updateLine(range.startLineNumber);
								continue;
							}
						}
					}
				}),

				diffEditor.onDidUpdateDiff(() => {
					const changes = diffEditor.getLineChanges();
					if (!changes) return;
					lineChangesRef.current = changes;
					// Create/update floating content widgets at the top-left of content
					const modifiedEditor = diffEditor.getModifiedEditor();
					const model = modifiedEditor.getModel();
					if (!modifiedEditor || !model) return;

					const existing = contentWidgetsRef.current;
					const seen = new Set<number>();

					for (let i = 0; i < changes.length; i++) {
						const change = changes[i]!;
						const line = change.modifiedStartLineNumber || change.originalStartLineNumber || 1;
						seen.add(i);
						const key = i;
						const existingWidget = existing.get(key) as AcceptDiscardContentWidget | undefined;
						if (existingWidget) {
							existingWidget.updateLine(line);
							continue;
						}
						const widget = new AcceptDiscardContentWidget(
							modifiedEditor,
							key,
							line,
							(index) => {
								acceptChangeAtIndex(index);
							},
							(index) => {
								discardChangeAtIndex(index);
							},
						);
						modifiedEditor.addContentWidget(widget);
						existing.set(key, widget);
					}

					// Remove widgets for changes that no longer exist
					for (const [key, widget] of Array.from(existing.entries())) {
						if (!seen.has(key)) {
							(modifiedEditor as any).removeContentWidget(widget);
							if ((widget as any).dispose) (widget as any).dispose();
							existing.delete(key);
						}
					}
				}),
			];

			return () => {
				for (const listener of listeners) {
					listener.dispose();
				}
			};
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[diffEditor],
	);

	// Cleanup content widgets on unmount/editor dispose
	useEffect(() => {
		const mapRef = contentWidgetsRef.current;
		return () => {
			if (!diffEditor) return;
			const modifiedEditor = diffEditor.getModifiedEditor();
			if (!modifiedEditor) return;
			for (const [, widget] of mapRef) {
				modifiedEditor.removeContentWidget(widget);
				if ((widget as any).dispose) (widget as any).dispose();
			}
			mapRef.clear();
		};
	}, [diffEditor]);

	// Gutter click handler removed; actions handled via content widget buttons

	function handleOnMount(e: M.IStandaloneDiffEditor) {
		setDiffEditor(e);
	}

	function handleDiscardAll() {
		if (!diffEditor) return;
		const baseEditor = diffEditor.getOriginalEditor();
		const modifiedEditor = diffEditor.getModifiedEditor();
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
		modifiedContentRef.current = result;

		// Restore selections and reveal previous viewport
		if (selectionsBefore) {
			modifiedEditor.setSelections(selectionsBefore);
		}
		const vrDiscardAll = visibleRangesBefore && visibleRangesBefore.length ? visibleRangesBefore[0] : undefined;
		if (vrDiscardAll) {
			modifiedEditor.revealRange(vrDiscardAll, monaco.editor.ScrollType.Smooth);
		}
	}

	function handleAcceptAll() {
		if (!diffEditor) return;
		const baseEditor = diffEditor.getOriginalEditor();
		const modifiedEditor = diffEditor.getModifiedEditor();
		const baseModel = baseEditor.getModel();
		const modifiedModel = modifiedEditor.getModel();
		if (!baseModel || !modifiedModel) return;
		const originalText = baseModel.getValue();
		const modifiedText = modifiedModel.getValue();
		const diffs = diffEditor.getLineChanges() ?? [];
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
	}

	async function handleSaveAndExit() {
		if (!diffEditor) return;
		const baseEditor = diffEditor.getOriginalEditor();
		const baseModel = baseEditor.getModel();
		if (!baseModel) return;
		const before = (originalSeedRef.current ?? "").replace(/\r\n?/g, "\n");
		const after = baseModel.getValue().replace(/\r\n?/g, "\n");
		try {
			const patches = makePatches(before, after, { margin: 100 });
			const patchText = stringifyPatches(patches);
			await applyPatchToPageAndBroadcast({
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: docId,
				patch: patchText,
			});
			onExit();
		} catch (err) {
			console.error("MonacoMarkdownDiffEditor save-and-exit: patch generation/apply failed", err);
		}
	}

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
					renderLineHighlight: "all", // or "gutter" if you only want the gutter
					renderLineHighlightOnlyWhenFocus: true,
				}}
			/>
		</div>
	);
}
