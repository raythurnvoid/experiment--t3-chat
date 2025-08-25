import "./monaco-markdown-editor.css";
import "../../lib/app-monaco-config.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as M } from "monaco-editor";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";
import { makePatches, stringifyPatches } from "@sanity/diff-match-patch";

export interface MonacoMarkdownDiffEditor_Props {
	docId: string;
	className?: string;
}

export function MonacoMarkdownDiffEditor(props: MonacoMarkdownDiffEditor_Props) {
	const { docId, className } = props;
	const convex = useConvex();

	const [diffEditor, setDiffEditor] = useState<M.IStandaloneDiffEditor | null>(null);
	const textContentWatchRef = useRef<{ unsubscribe: () => void } | null>(null);
	const [initialValue, setInitialValue] = useState<string | null | undefined>(undefined);

	// Local copy of modified content for quick access without re-renders
	const modifiedContentRef = useRef<string>("");

	// Latest line changes without triggering React re-renders
	const lineChangesRef = useRef<M.ILineChange[] | null>(null);

	// Decorations collection for custom actions in the line decorations gutter
	const lineActionsCollectionRef = useRef<M.IEditorDecorationsCollection | null>(null);

	function getLines(model: M.ITextModel, startLine: number, endLine: number) {
		if (startLine <= 0 || endLine <= 0 || endLine < startLine) return "";
		const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
		return model.getValueInRange(range);
	}

	function logPatchForModelChange(
		model: M.ITextModel,
		startPos: monaco.Position,
		endPos: monaco.Position,
		newSegment: string,
		action: "accept" | "discard",
		baseTextOverride?: string,
	) {
		try {
			const oldText = baseTextOverride ?? model.getValue();
			const startOffset = model.getOffsetAt(startPos);
			const endOffset = model.getOffsetAt(endPos);
			const newText = oldText.slice(0, startOffset) + newSegment + oldText.slice(endOffset);
			const patches = makePatches(oldText, newText, { margin: 100 });
			const patchText = stringifyPatches(patches);
			// For now we only log; caller will handle sending to DB later
			console.log(
				"MonacoMarkdownDiffEditor patch",
				{ action, startOffset, endOffset, newSegmentLength: newSegment.length },
				patchText,
			);
		} catch (err) {
			console.error("MonacoMarkdownDiffEditor patch generation failed", err);
		}
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

			// Capture original content BEFORE applying the edit
			const oldOriginalText = originalModel.getValue();

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

			// Prepare patch for DB (accept updates original content based on modified)
			logPatchForModelChange(
				originalModel,
				startPos,
				endPos,
				newSegment,
				"accept",
				/* baseTextOverride */ oldOriginalText,
			);
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
		// Unsubscribe the text watcher now that we seeded once
		textContentWatchRef.current?.unsubscribe();
	}, [diffEditor, initialValue]);

	// Track modified editor content and listen for diff updates
	useEffect(() => {
		if (!diffEditor) return;
		const modified = diffEditor.getModifiedEditor();

		const contentDisposable = modified
			? modified.onDidChangeModelContent(() => {
					const v = modified.getValue();
					modifiedContentRef.current = v;
				})
			: null;

		const diffDisposable = diffEditor.onDidUpdateDiff(() => {
			const changes = diffEditor.getLineChanges();
			if (!changes) return;
			lineChangesRef.current = changes;
			// Update gutter decorations immediately (no React state)
			const modifiedEditor = diffEditor.getModifiedEditor();
			const model = modifiedEditor.getModel();
			if (!modifiedEditor || !model) return;
			// Ensure a decorations collection exists (preferred over deltaDecorations)
			if (!lineActionsCollectionRef.current) {
				lineActionsCollectionRef.current = modifiedEditor.createDecorationsCollection();
			}
			const decorations: monaco.editor.IModelDeltaDecoration[] = [];
			for (let i = 0; i < changes.length; i++) {
				const change = changes[i]!;
				const line = change.modifiedStartLineNumber || change.originalStartLineNumber || 1;
				decorations.push(
					{
						range: new monaco.Range(line, 1, line, 1),
						options: {
							isWholeLine: false,
							linesDecorationsClassName: `MonacoMarkdownDiffEditor-accept MonacoMarkdownDiffEditor-accept-${i}`,
							hoverMessage: { value: "Accept this change" },
						},
					} as monaco.editor.IModelDeltaDecoration,
					{
						range: new monaco.Range(line, 1, line, 1),
						options: {
							isWholeLine: false,
							linesDecorationsClassName: `MonacoMarkdownDiffEditor-discard MonacoMarkdownDiffEditor-discard-${i}`,
							hoverMessage: { value: "Discard this change" },
						},
					} as monaco.editor.IModelDeltaDecoration,
				);
			}
			lineActionsCollectionRef.current.set(decorations);
		});

		return () => {
			contentDisposable?.dispose();
			diffDisposable.dispose();
		};
	}, [diffEditor]);

	// Clear decorations on unmount/editor dispose
	useEffect(() => {
		return () => {
			if (!diffEditor) return;
			const modified = diffEditor.getModifiedEditor();
			if (!modified) return;
			lineActionsCollectionRef.current?.clear();
			lineActionsCollectionRef.current = null;
		};
	}, [diffEditor]);

	// Handle clicks on the line decorations gutter to trigger accept/discard
	useEffect(() => {
		if (!diffEditor) return;
		const modified = diffEditor.getModifiedEditor();
		if (!modified) return;

		const d = modified.onMouseDown((e) => {
			if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
			const el = e.target.element as HTMLElement | null;
			if (!el) return;

			// Determine which button was clicked and extract its hunk index
			let isAccept = false;
			let idxFromClass: number | null = null;
			for (const cls of Array.from(el.classList)) {
				const m = cls.match(/^MonacoMarkdownDiffEditor-(accept|discard)-(\d+)$/);
				if (m) {
					isAccept = m[1] === "accept";
					idxFromClass = Number(m[2]);
					break;
				}
			}
			if (idxFromClass == null) return;

			const changes = lineChangesRef.current ?? [];
			const change = changes[idxFromClass] ?? null;
			if (!change) return;
			if (isAccept) acceptChange(change);
			else discardChange(change);
			e.event.preventDefault();
			e.event.stopPropagation();
		});

		return () => {
			d.dispose();
		};
	}, [diffEditor, acceptChange, discardChange]);

	const handleOnMount = useCallback((e: M.IStandaloneDiffEditor) => {
		setDiffEditor(e);
	}, []);

	return (
		<div className={cn("MonacoMarkdownDiffEditor flex h-full w-full flex-col", className)}>
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
					lineHeight: 24,
					renderMarginRevertIcon: false,
					renderGutterMenu: true,
				}}
			/>
		</div>
	);
}
