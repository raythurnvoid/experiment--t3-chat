import "./monaco-markdown-diff-editor.css";
import "../../lib/app-monaco-config.ts";
import { useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { editor as M } from "monaco-editor";
import { useConvex, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn, make, msg_with_nullish_values as msg_with_nullish_values_get } from "../../lib/utils.ts";
import { makePatches, stringifyPatches } from "@sanity/diff-match-patch";
import { Button } from "../ui/button.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const CLASS_NAMES = {
	root: "MonacoMarkdownDiffEditor",
	widget: "MonacoMarkdownDiffEditor-widget",
	widgetAccept: "MonacoMarkdownDiffEditor-widget-accept",
	widgetDiscard: "MonacoMarkdownDiffEditor-widget-discard",
	anchor: "MonacoMarkdownDiffEditor-anchor",
	header: "MonacoMarkdownDiffEditor-header",
	headerAccept: "MonacoMarkdownDiffEditor-header-accept",
	headerDiscard: "MonacoMarkdownDiffEditor-header-discard",
	headerSave: "MonacoMarkdownDiffEditor-header-save",
	headerTitle: "MonacoMarkdownDiffEditor-header-title",
	headerActions: "MonacoMarkdownDiffEditor-header-actions",
};

export type MonacoMarkdownDiffEditor_Ref = {
	setModifiedContent: (value: string) => void;
};

export type MonacoMarkdownDiffEditor_Props = {
	ref?: Ref<MonacoMarkdownDiffEditor_Ref>;
	className?: string;
	pageId: app_convex_Id<"pages">;
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

class AcceptDiscardContentWidget implements monaco.editor.IContentWidget {
	private readonly id: string;
	private readonly node: HTMLDivElement;
	private lineNumber: number;
	readonly allowEditorOverflow = true;
	anchorDecorationId: string | null = null;
	readonly editor: M.IStandaloneCodeEditor;
	private readonly onAcceptClick: (index: number) => void;
	private readonly onDiscardClick: (index: number) => void;

	private constructor(args: {
		editor: M.IStandaloneCodeEditor;
		diffIndex: number;
		lineNumber: number;
		onAcceptClick: (index: number) => void;
		onDiscardClick: (index: number) => void;
	}) {
		this.editor = args.editor;
		this.onAcceptClick = args.onAcceptClick;
		this.onDiscardClick = args.onDiscardClick;
		this.lineNumber = args.lineNumber;
		this.id = `MonacoMarkdownDiffEditor-widget-${args.diffIndex}`;
		this.node = document.createElement("div");
		this.node.className = CLASS_NAMES.widget;
		this.node.style.pointerEvents = "auto";
		const acceptBtn = document.createElement("button");
		acceptBtn.className = CLASS_NAMES.widgetAccept;
		acceptBtn.setAttribute("aria-label", "Accept change");
		acceptBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onAcceptClick(args.diffIndex);
		});
		const discardBtn = document.createElement("button");
		discardBtn.className = CLASS_NAMES.widgetDiscard;
		discardBtn.setAttribute("aria-label", "Discard change");
		discardBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.onDiscardClick(args.diffIndex);
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
			positionAffinity: monaco.editor.PositionAffinity.Right,
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
					className: CLASS_NAMES.anchor,
				}),
			},
		]);
		const oldIds: string[] = [];
		if (this.anchorDecorationId) oldIds.push(this.anchorDecorationId);
		const result = model.deltaDecorations(oldIds, newDecos);
		this.anchorDecorationId = result[0] ?? null;
	}

	afterRender() {
		// Force non-fixed layout and shift the widget left of the text by its width + gap
		this.node.style.position = "absolute";
		const layoutInfo = this.editor.getOption(monaco.editor.EditorOption.layoutInfo);
		const layoutBaselineLeft = layoutInfo?.contentLeft ?? 0;
		this.node.style.transform = `translate3d(calc(-100% - 5px + ${layoutBaselineLeft}px), -2px, 0)`;
		this.node.style.display = "flex";
	}

	dispose() {
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
		diffIndex: number;
		lineNumber: number;
		onAcceptClick: (index: number) => void;
		onDiscardClick: (index: number) => void;
	}) {
		const widget = new AcceptDiscardContentWidget(args);
		args.editor.addContentWidget(widget);
		return widget;
	}
}

type MonacoMarkdownDiffEditor_Impl_Props = MonacoMarkdownDiffEditor_Props & {
	initialValue: string;
	onEditorMount: () => void;
};

function MonacoMarkdownDiffEditor_Impl(props: MonacoMarkdownDiffEditor_Impl_Props) {
	const { ref, className, pageId, threadId, modifiedInitialValue, initialValue, onExit } = props;
	const applyPatchToPageAndBroadcast = useMutation(api.ai_docs_temp.apply_patch_to_page_and_broadcast);

	const diffEditor = useRef<M.IStandaloneDiffEditor | null>(null);

	const modifiedContent = useRef<string>("");
	const originalContent = useRef<string>("");
	const lineChanges = useRef<M.ILineChange[] | null>(null);

	/** Content widgets for per-change actions (accept/discard) */
	const contentWidgets = useRef<AcceptDiscardContentWidget[]>([]);

	const diffEditorListenersDisposable = useRef<monaco.IDisposable[]>([]);

	/**
	 * Port from VS Code: `applyLineChanges(original, modified, diffs): string`
	 * from `vscode/extensions/git/src/staging.ts`
	 **/
	const applyDiffs = (
		originalEditorModel: M.ITextModel,
		modifiedEditorModel: M.ITextModel,
		diffs: ReadonlyArray<M.ILineChange>,
	): string => {
		const resultParts: string[] = [];
		let currentLine = 0; // zero-based

		for (const diff of diffs) {
			const isInsertion = diff.originalEndLineNumber === 0;
			const isDeletion = diff.modifiedEndLineNumber === 0;

			let endLine =
				(isInsertion ? diff.originalStartLineNumber : diff.originalStartLineNumber - 1) +
				1; /* +1 because monaco APIs are 1 based */
			let endCharacter = 1; /* monaco APIs are 1 based */

			// if this is a deletion at the very end of the document,then we need to account
			// for a newline at the end of the last line which may have been deleted
			// https://github.com/microsoft/vscode/issues/59670
			if (isDeletion && diff.originalEndLineNumber === originalEditorModel.getLineCount()) {
				endLine -= 1;
				endCharacter = originalEditorModel.getLineContent(endLine).length;
			}

			resultParts.push(originalEditorModel.getValueInRange(new monaco.Range(currentLine, 1, endLine, endCharacter)));

			if (!isDeletion) {
				let fromLine = diff.modifiedStartLineNumber - 1 + 1; /* +1 because monaco APIs are 1 based */
				let fromCharacter = 1; /* monaco APIs are 1 based */

				// if this is an insertion at the very end of the document,
				// then we must start the next range after the last character of the
				// previous line, in order to take the correct eol
				if (isInsertion && diff.originalStartLineNumber === originalEditorModel.getLineCount()) {
					fromLine -= 1;
					fromCharacter = modifiedEditorModel.getLineContent(fromLine).length;
				}

				resultParts.push(
					modifiedEditorModel.getValueInRange(
						new monaco.Range(
							fromLine,
							fromCharacter,
							diff.modifiedEndLineNumber + 1 /* +1 because monaco APIs are 1 based */,
							1,
						),
					),
				);
			}

			currentLine =
				(isInsertion ? diff.originalStartLineNumber : diff.originalEndLineNumber) +
				1; /* +1 because monaco APIs are 1 based */
		}

		resultParts.push(
			originalEditorModel.getValueInRange(new monaco.Range(currentLine, 1, originalEditorModel.getLineCount(), 1)),
		);

		return resultParts.join("");
	};

	const applyReversibleContentUpdate = (
		editor: M.IStandaloneCodeEditor,
		editorModel: M.ITextModel,
		newText: string,
	) => {
		editor.pushUndoStop();
		editor.executeEdits("MonacoMarkdownDiffEditor.accept.vscode", [
			{ range: editorModel.getFullModelRange(), text: newText },
		]);
		editor.pushUndoStop();
	};

	const getMsgIfEmptyDiffsOrInvalidChangeIndex = (name: string, diffs: M.ILineChange[], diffIndex: number) => {
		if (diffs.length === 0) {
			return `${name}: diffs array is empty`;
		}
		if (diffIndex < 0 || diffIndex >= diffs.length) {
			return `${name}: diffIndex is invalid: \`${diffIndex}\``;
		}
		return null;
	};

	const acceptChangeAtIndex = (diffIndex: number) => {
		const originalEditor = diffEditor.current?.getOriginalEditor();
		const modifiedEditor = diffEditor.current?.getModifiedEditor();
		const originalEditorModel = originalEditor?.getModel();
		const modifiedEditorModel = modifiedEditor?.getModel();
		const diffs = diffEditor.current?.getLineChanges();
		if (
			!diffEditor.current ||
			!originalEditor ||
			!modifiedEditor ||
			!originalEditorModel ||
			!modifiedEditorModel ||
			!diffs
		) {
			const msg = msg_with_nullish_values_get("acceptChangeAtIndex", {
				diffEditor: diffEditor.current,
				originalEditor,
				modifiedEditor,
				originalEditorModel,
				modifiedEditorModel,
				diffs,
			});
			msg && console.error(msg);
			return;
		}

		const msgIfEmptyDiffsOrInvalidChangeIndex = getMsgIfEmptyDiffsOrInvalidChangeIndex(
			"acceptChangeAtIndex",
			diffs,
			diffIndex,
		);
		if (msgIfEmptyDiffsOrInvalidChangeIndex) {
			console.error(msgIfEmptyDiffsOrInvalidChangeIndex);
			return;
		}

		const diffsToApply = [diffs[diffIndex]];
		const newEditorContent = applyDiffs(originalEditorModel, modifiedEditorModel, diffsToApply);
		applyReversibleContentUpdate(originalEditor, originalEditorModel, newEditorContent);
		diffEditor.current.focus();
	};

	const discardChangeAtIndex = (diffIndex: number) => {
		const originalEditor = diffEditor.current?.getOriginalEditor();
		const modifiedEditor = diffEditor.current?.getModifiedEditor();
		const originalEditorModel = originalEditor?.getModel();
		const modifiedEditorModel = modifiedEditor?.getModel();
		const diffs = diffEditor.current?.getLineChanges();
		if (
			!diffEditor.current ||
			!originalEditor ||
			!modifiedEditor ||
			!originalEditorModel ||
			!modifiedEditorModel ||
			!diffs
		) {
			const msg = msg_with_nullish_values_get("discardChangeAtIndex", {
				diffEditor: diffEditor.current,
				originalEditor,
				modifiedEditor,
				originalEditorModel,
				modifiedEditorModel,
				diffs,
			});
			msg && console.error(msg);
			return;
		}

		const msgIfEmptyDiffsOrInvalidChangeIndex = getMsgIfEmptyDiffsOrInvalidChangeIndex(
			"discardChangeAtIndex",
			diffs,
			diffIndex,
		);
		if (msgIfEmptyDiffsOrInvalidChangeIndex) {
			console.error(msgIfEmptyDiffsOrInvalidChangeIndex);
			return;
		}

		const diffsToKeep = diffs.filter((_, i) => i !== diffIndex);
		const newEditorContent = applyDiffs(originalEditorModel, modifiedEditorModel, diffsToKeep);
		applyReversibleContentUpdate(modifiedEditor, modifiedEditorModel, newEditorContent);
		modifiedContent.current = newEditorContent;
		diffEditor.current.focus();
	};

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

					// Select the editor based on the changed lines to check
					// if we are inserting or deleting text to make sure the widget is
					// correctly aligned with the diff.
					const isDeletion = change.modifiedEndLineNumber === 0;
					const targetEditor = isDeletion ? originalEditor : modifiedEditor;

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
							diffIndex: i,
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
		const originalEditor = diffEditor.current?.getOriginalEditor();
		const modifiedEditor = diffEditor.current?.getModifiedEditor();
		const originalEditorModel = originalEditor?.getModel();
		const modifiedEditorModel = modifiedEditor?.getModel();
		if (!diffEditor.current || !originalEditor || !modifiedEditor || !originalEditorModel || !modifiedEditorModel) {
			const msg = msg_with_nullish_values_get("handleDiscardAll", {
				diffEditor: diffEditor.current,
				originalEditor,
				modifiedEditor,
				originalEditorModel,
				modifiedEditorModel,
			});
			msg && console.error(msg);
			return;
		}

		const result = applyDiffs(originalEditorModel, modifiedEditorModel, []);
		applyReversibleContentUpdate(modifiedEditor, modifiedEditorModel, result);
		modifiedContent.current = result;
		diffEditor.current.focus();
	};

	const handleAcceptAll = () => {
		const originalEditor = diffEditor.current?.getOriginalEditor();
		const modifiedEditor = diffEditor.current?.getModifiedEditor();
		const originalEditorModel = originalEditor?.getModel();
		const modifiedEditorModel = modifiedEditor?.getModel();
		if (!diffEditor.current || !originalEditor || !modifiedEditor || !originalEditorModel || !modifiedEditorModel) {
			const msg = msg_with_nullish_values_get("handleAcceptAll", {
				diffEditor: diffEditor.current,
				originalEditor,
				modifiedEditor,
				originalEditorModel,
				modifiedEditorModel,
			});
			msg && console.error(msg);
			return;
		}

		const diffs = diffEditor.current.getLineChanges() ?? [];
		const result = applyDiffs(originalEditorModel, modifiedEditorModel, diffs);
		applyReversibleContentUpdate(originalEditor, originalEditorModel, result);
		diffEditor.current.focus();
	};

	const handleSaveAndExit = async () => {
		const originalEditor = diffEditor.current?.getOriginalEditor();
		const originalEditorModel = originalEditor?.getModel();
		if (!diffEditor.current || !originalEditor || !originalEditorModel) {
			const msg = msg_with_nullish_values_get("handleSaveAndExit", {
				diffEditor: diffEditor.current,
				baseEditor: originalEditor,
				baseModel: originalEditorModel,
			});
			msg && console.error(msg);
			return;
		}

		const before = originalContent.current.replace(/\r\n?/g, "\n");
		const after = originalEditorModel.getValue().replace(/\r\n?/g, "\n");
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
			console.error("handleSaveAndExit failed", err);
		}
	};

	useImperativeHandle(
		ref,
		() => ({
			setModifiedContent: (value: string) => {
				const modifiedEditor = diffEditor.current?.getModifiedEditor();
				const modifiedEditorModel = modifiedEditor?.getModel();
				if (!diffEditor.current || !modifiedEditor || !modifiedEditorModel) {
					const msg = msg_with_nullish_values_get("useImperativeHandle.setModifiedContent", {
						diffEditor: diffEditor.current,
						modifiedEditor,
						modifiedModel: modifiedEditorModel,
					});
					msg && console.error(msg);
					return;
				}

				applyReversibleContentUpdate(modifiedEditor, modifiedEditorModel, value);
				modifiedContent.current = value;
			},
		}),
		[diffEditor],
	);

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
		<div className={cn(CLASS_NAMES.root, "flex h-full w-full flex-col", className)}>
			{/* Header similar to regular editor avatars bar, with actions on the right */}
			<div className={cn(CLASS_NAMES.header, "flex items-center gap-2 border-b border-border/80 bg-background/50 p-2")}>
				<div className={cn(CLASS_NAMES.headerTitle, "text-sm text-muted-foreground")}>Review changes</div>
				<div className={cn(CLASS_NAMES.headerActions, "ml-auto flex items-center gap-2")}>
					<Button variant="destructive" size="sm" className={cn(CLASS_NAMES.headerDiscard)} onClick={handleDiscardAll}>
						Discard All
					</Button>
					<Button
						size="sm"
						className={cn(CLASS_NAMES.headerAccept, "text-white")}
						style={{ background: "hsl(var(--success, 142 76% 36%))" }}
						onClick={handleAcceptAll}
					>
						Accept All
					</Button>
					<Button size="sm" className={cn(CLASS_NAMES.headerSave)} onClick={handleSaveAndExit}>
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
