import "./monaco-markdown-diff-editor.css";
import "../../lib/app-monaco-config.ts";
import { useCallback, useEffect, useRef, useState } from "react";
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

	function getLines(model: M.ITextModel, startLine: number, endLine: number) {
		if (startLine <= 0 || endLine <= 0 || endLine < startLine) return "";
		const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		return model.getValueInRange(range);
	}

	const acceptChange = useCallback(
		(change: M.ILineChange) => {
			if (!diffEditor) return;
			const original = diffEditor.getOriginalEditor();
			const modified = diffEditor.getModifiedEditor();
			const originalModel = original.getModel();
			const modifiedModel = modified.getModel();
			if (!originalModel || !modifiedModel) return;

			const newSegment =
				change.modifiedEndLineNumber === 0
					? ""
					: getLines(modifiedModel, change.modifiedStartLineNumber, change.modifiedEndLineNumber);

			// Determine target range in original model
			const start = change.originalStartLineNumber || change.originalEndLineNumber || 1;
			const end = change.originalEndLineNumber || 0;
			const startLine = Math.max(start, 1);
			const endLine = Math.max(end, 0);
			const startPos = new monaco.Position(startLine, 1);
			const endPos = new monaco.Position(endLine, endLine > 0 ? originalModel.getLineMaxColumn(endLine) : 1);
			const replaceRange = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);

			// Apply minimal edit to original model to avoid full reset in the editor
			originalModel.pushEditOperations(
				[],
				[
					{
						range: replaceRange,
						text: newSegment,
						forceMoveMarkers: false,
					},
				],
				() => null,
			);

			// No patch here anymore; patch is created on Save & Exit
		},
		[diffEditor],
	);

	const discardChange = useCallback(
		(change: M.ILineChange) => {
			if (!diffEditor) return;
			const original = diffEditor.getOriginalEditor();
			const modified = diffEditor.getModifiedEditor();
			const originalModel = original.getModel();
			const modifiedModel = modified.getModel();
			if (!originalModel || !modifiedModel) return;

			const newSegment =
				change.originalEndLineNumber === 0
					? ""
					: getLines(originalModel, change.originalStartLineNumber, change.originalEndLineNumber);

			const start = change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1;
			const end = change.modifiedEndLineNumber || 0;
			const startLine = Math.max(start, 1);
			const endLine = Math.max(end, 0);
			const startPos = new monaco.Position(startLine, 1);
			const endPos = new monaco.Position(endLine, endLine > 0 ? modifiedModel.getLineMaxColumn(endLine) : 1);
			const replaceRange = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);

			modifiedModel.pushEditOperations(
				[],
				[
					{
						range: replaceRange,
						text: newSegment,
						forceMoveMarkers: false,
					},
				],
				() => null,
			);
			modifiedContentRef.current = modifiedModel.getValue();

			// No patch on discard per requirement
		},
		[diffEditor],
	);

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
		const original = diffEditor.getOriginalEditor();
		const modified = diffEditor.getModifiedEditor();
		const originalModel = original?.getModel();
		const modifiedModel = modified?.getModel();
		if (!originalModel || !modifiedModel) return;
		const seed = typeof initialValue === "string" ? initialValue : "";
		originalModel.setValue(seed);
		modifiedModel.setValue(seed);
		// Seed local value for modified copy
		modifiedContentRef.current = seed;
		// Preserve the original content for later patch creation
		originalSeedRef.current = seed;
		// Unsubscribe the text watcher now that we seeded once
		textContentWatchRef.current?.unsubscribe();
	}, [diffEditor, initialValue]);

	// Track modified editor content and listen for diff updates
	useEffect(() => {
		if (!diffEditor) return;
		const modified = diffEditor.getModifiedEditor();

		const modifiedEditor = modified;

		const contentDisposable = modifiedEditor
			? modified.onDidChangeModelContent(() => {
					const v = modified.getValue();
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
						anyWidget.updateLine((w as any).lineNumber ?? 1);
					}
				})
			: null;

		const diffDisposable = diffEditor.onDidUpdateDiff(() => {
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
						const list = lineChangesRef.current ?? [];
						const c = list[index];
						if (c) acceptChange(c);
					},
					(index) => {
						const list = lineChangesRef.current ?? [];
						const c = list[index];
						if (c) discardChange(c);
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
		});

		return () => {
			contentDisposable?.dispose();
			diffDisposable.dispose();
		};
	}, [diffEditor, acceptChange, discardChange]);

	// Cleanup content widgets on unmount/editor dispose
	useEffect(() => {
		const mapRef = contentWidgetsRef.current;
		return () => {
			if (!diffEditor) return;
			const modified = diffEditor.getModifiedEditor();
			if (!modified) return;
			for (const [, widget] of mapRef) {
				modified.removeContentWidget(widget);
				if ((widget as any).dispose) (widget as any).dispose();
			}
			mapRef.clear();
		};
	}, [diffEditor]);

	// Gutter click handler removed; actions handled via content widget buttons

	const handleOnMount = useCallback((e: M.IStandaloneDiffEditor) => {
		setDiffEditor(e);
	}, []);

	const handleDiscardAll = useCallback(() => {
		if (!diffEditor) return;
		const original = diffEditor.getOriginalEditor();
		const modified = diffEditor.getModifiedEditor();
		const originalModel = original.getModel();
		const modifiedModel = modified.getModel();
		if (!originalModel || !modifiedModel) return;
		const originalText = originalModel.getValue();
		modifiedModel.setValue(originalText);
		modifiedContentRef.current = originalText;
	}, [diffEditor]);

	const handleAcceptAll = useCallback(() => {
		if (!diffEditor) return;
		const original = diffEditor.getOriginalEditor();
		const modified = diffEditor.getModifiedEditor();
		const originalModel = original.getModel();
		const modifiedModel = modified.getModel();
		if (!originalModel || !modifiedModel) return;
		const modifiedText = modifiedModel.getValue();
		originalModel.setValue(modifiedText);
	}, [diffEditor]);

	const handleSaveAndExit = useCallback(async () => {
		if (!diffEditor) return;
		const original = diffEditor.getOriginalEditor();
		const originalModel = original.getModel();
		if (!originalModel) return;
		const before = (originalSeedRef.current ?? "").replace(/\r\n?/g, "\n");
		const after = originalModel.getValue().replace(/\r\n?/g, "\n");
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
	}, [diffEditor, applyPatchToPageAndBroadcast, docId, onExit]);

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
