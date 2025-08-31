import { useEffect, useRef, useState } from "react";
import { QuickStart } from "./quick-start.tsx";
import { PageRichTextEditor, type PageRichTextEditor_Ref } from "../page-rich-text-editor/page-rich-text-editor.tsx";
import {
	global_event_ai_chat_open_canvas,
	global_event_ai_chat_open_canvas_by_path,
	useGlobalEvent,
} from "../../lib/global-events.tsx";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";

export function Canvas() {
	const [editorPageId, setEditorPageId] = useState<string | null>(null);
	const editorRef = useRef<PageRichTextEditor_Ref | null>(null);
	const nextDiffRef = useRef<{ modified: string } | null>(null);
	const convex = useConvex();

	const openCanvasGlobalEventDebounce = useRef<ReturnType<typeof globalThis.setTimeout>>(undefined);

	useGlobalEvent(global_event_ai_chat_open_canvas.listen, (payload) => {
		// Debounce the event handling to prevent concurrent calls to create issues.
		clearTimeout(openCanvasGlobalEventDebounce.current);
		openCanvasGlobalEventDebounce.current = globalThis.setTimeout(() => {
			setEditorPageId(payload.pageId);
			if (payload.mode === "diff" || typeof payload.modifiedSeed === "string") {
				nextDiffRef.current = { modified: payload.modifiedSeed ?? "" };
			} else {
				nextDiffRef.current = null;
			}
		});
	});

	useGlobalEvent(global_event_ai_chat_open_canvas_by_path.listen, (payload) => {
		clearTimeout(openCanvasGlobalEventDebounce.current);
		openCanvasGlobalEventDebounce.current = globalThis.setTimeout(async () => {
			try {
				const page = await convex.query(api.ai_docs_temp.get_page_by_path, {
					workspace_id: ai_chat_HARDCODED_ORG_ID,
					project_id: ai_chat_HARDCODED_PROJECT_ID,
					path: payload.path,
				});
				if (page && page.page_id) {
					setEditorPageId(page.page_id);
					nextDiffRef.current = null;
				}
			} catch (e) {
				console.error("Failed to resolve page by path:", e);
			}
		});
	});

	useEffect(() => {
		if (!editorPageId) return;
		if (nextDiffRef.current && editorRef.current) {
			const modifiedValue = nextDiffRef.current.modified;
			nextDiffRef.current = null;
			editorRef.current.requestOpenDiff({ pageId: editorPageId, modifiedEditorValue: modifiedValue });
		}
	}, [editorPageId]);

	if (editorPageId) {
		return (
			<div className="Canvas h-full">
				<PageRichTextEditor ref={editorRef} pageId={editorPageId} />
			</div>
		);
	}

	return (
		<div className="Canvas h-full">
			<QuickStart onOpenEditor={(pageId) => setEditorPageId(pageId)} />
		</div>
	);
}
