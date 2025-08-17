import { memo, useRef, useState } from "react";
import { QuickStart } from "./quick-start.tsx";
import { PageRichTextEditor } from "../page-rich-text-editor/page-rich-text-editor.tsx";
import { global_event_ai_chat_open_canvas, useGlobalEvent } from "../../lib/global-events.tsx";

export const Canvas = memo(() => {
	const [editorPageId, setEditorPageId] = useState<string | null>(null);

	const openCanvasGlobalEventDebounceTimeoutId = useRef<ReturnType<typeof setTimeout>>(undefined);

	useGlobalEvent(global_event_ai_chat_open_canvas.listen, (payload) => {
		// Debounce the event handling to prevent concurrent calls to create issues.
		clearTimeout(openCanvasGlobalEventDebounceTimeoutId.current);
		openCanvasGlobalEventDebounceTimeoutId.current = setTimeout(() => {
			setEditorPageId(payload.pageId);
		});
	});

	if (editorPageId) {
		return (
			<div className="Canvas h-full">
				<PageRichTextEditor pageId={editorPageId} />
			</div>
		);
	}

	return (
		<div className="Canvas h-full">
			<QuickStart onOpenEditor={(pageId) => setEditorPageId(pageId)} />
		</div>
	);
});
