import { memo, useState } from "react";
import { QuickStart } from "./quick-start.tsx";
import { PageRichTextEditor } from "../page-rich-text-editor/page-rich-text-editor.tsx";

export const Canvas = memo(() => {
	const [editorPageId, setEditorPageId] = useState<string | null>(null);

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
