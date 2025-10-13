import { useRef } from "react";
import { QuickStart } from "./quick-start.tsx";
import { PageEditor, type PageEditor_Ref } from "../page-rich-text-editor/page-editor.tsx";
import {
	global_event_ai_chat_open_canvas,
	global_event_ai_chat_open_canvas_by_path,
	useGlobalEvent,
} from "../../lib/global-events.tsx";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { useLiveState, useRenderPromise } from "../../hooks/utils-hooks.ts";

export function Canvas() {
	const [editorPageId, setEditorPageId] = useLiveState<string | null>(null);
	const [threadId, setThreadId] = useLiveState<string | undefined>(undefined);
	const editor = useRef<PageEditor_Ref | null>(null);
	const convex = useConvex();

	const openCanvasGlobalEventDebounce = useRef<ReturnType<typeof globalThis.setTimeout>>(undefined);

	const renderPromise = useRenderPromise();

	useGlobalEvent(global_event_ai_chat_open_canvas.listen, (payload) => {
		// Debounce the event handling to prevent concurrent calls to create issues.
		clearTimeout(openCanvasGlobalEventDebounce.current);

		openCanvasGlobalEventDebounce.current = globalThis.setTimeout(async () => {
			// Don't open the new diff if a page is already opened
			// AND the editor is currently in diff mode.
			// It's useful when the AI writes in multiple pages at once,
			// but still allows switching when user is in normal mode.
			if (
				editorPageId.current &&
				editorPageId.current !== payload.pageId &&
				payload.mode === "diff" &&
				editor.current?.getMode?.() === "diff"
			) {
				return;
			}

			setEditorPageId(payload.pageId);
			setThreadId(payload.threadId);
			await renderPromise();

			if (!editor.current) {
				console.warn("Canvas: open requested but editor not initialized");
				return;
			}

			if (payload.mode === "diff" && payload.modifiedContent) {
				editor.current.requestOpenDiff({
					pageId: payload.pageId,
					modifiedEditorValue: payload.modifiedContent ?? "",
				});
			}
		});
	});

	useGlobalEvent(global_event_ai_chat_open_canvas_by_path.listen, (payload) => {
		clearTimeout(openCanvasGlobalEventDebounce.current);
		openCanvasGlobalEventDebounce.current = globalThis.setTimeout(async () => {
			try {
				const page = await convex.query(api.ai_docs_temp.get_page_by_path, {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					path: payload.path,
				});
				if (page && page.page_id) {
					setEditorPageId(page.page_id);
				}
			} catch (e) {
				console.error("Failed to resolve page by path:", e);
			}
		});
	});

	if (editorPageId.current) {
		return (
			<div className="Canvas h-full">
				<PageEditor ref={editor} pageId={editorPageId.current} threadId={threadId.current} />
			</div>
		);
	}

	return (
		<div className="Canvas h-full">
			<QuickStart onOpenEditor={(pageId) => setEditorPageId(pageId)} />
		</div>
	);
}
