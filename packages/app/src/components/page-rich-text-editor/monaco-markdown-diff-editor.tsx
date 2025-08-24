import "./monaco-markdown-editor.css";
import "../../lib/app-monaco-config.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as M } from "monaco-editor";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";

export interface MonacoMarkdownDiffEditor_Props {
	docId: string;
	className?: string;
}

export function MonacoMarkdownDiffEditor(props: MonacoMarkdownDiffEditor_Props) {
	const { docId, className } = props;
	const convex = useConvex();

	const [diffEditor, setDiffEditor] = useState<M.IStandaloneDiffEditor | null>(null);
	const isApplyingBroadcastRef = useRef(false);
	const textContentWatchRef = useRef<{ unsubscribe: () => void } | null>(null);
	const [initialValue, setInitialValue] = useState<string | null | undefined>(undefined);

	// Listen for updates once
	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: docId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			if (initialValue === undefined) {
				const v = watcher.localQueryResult();
				setInitialValue(typeof v === "string" ? v : "");
			}
		});

		textContentWatchRef.current = {
			unsubscribe: () => {
				unsubscribe();
				textContentWatchRef.current = null;
			},
		};

		return () => {
			textContentWatchRef.current?.unsubscribe();
		};
	}, [convex, docId, initialValue]);

	// After editor mounts, fetch latest value once and set initialValue if still undefined
	useEffect(() => {
		if (!diffEditor || initialValue !== undefined) return;
		void (async () => {
			const fetchedValue = await convex.query(api.ai_docs_temp.get_page_text_content_by_page_id, {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: docId,
			});

			// Set the initial value if it's not already set
			if (fetchedValue) {
				setInitialValue((currentValue) => currentValue ?? fetchedValue);
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
		// Unsubscribe the text watcher now that we seeded once
		textContentWatchRef.current?.unsubscribe();
	}, [diffEditor, initialValue]);

	// Listen for Convex markdown broadcasts; update original side only
	useEffect(() => {
		if (!diffEditor) return;
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_updates_markdown_broadcast_latest, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: docId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			const update = watcher.localQueryResult();
			if (!diffEditor || !update) return;
			const original = diffEditor.getOriginalEditor();
			const model = original?.getModel();
			if (!model) return;
			const current = model.getValue();
			if (current === update.text_content) return;
			isApplyingBroadcastRef.current = true;
			model.setValue(update.text_content);
			// Small delay to allow Monaco to emit change event, then clear the flag
			queueMicrotask(() => {
				isApplyingBroadcastRef.current = false;
			});
		});

		return () => {
			unsubscribe();
		};
	}, [convex, diffEditor, docId]);

	// Track modified editor content locally only
	const modifiedLocalValueRef = useRef<string>("");
	useEffect(() => {
		if (!diffEditor) return;
		const modified = diffEditor.getModifiedEditor();
		if (!modified) return;
		const disposable = modified.onDidChangeModelContent(() => {
			modifiedLocalValueRef.current = modified.getValue();
		});
		return () => {
			disposable.dispose();
		};
	}, [diffEditor]);

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
				}}
			/>
		</div>
	);
}
