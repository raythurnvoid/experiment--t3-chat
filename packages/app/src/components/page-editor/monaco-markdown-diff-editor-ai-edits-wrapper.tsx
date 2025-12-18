import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { MonacoMarkdownDiffEditor, type MonacoMarkdownDiffEditor_Ref } from "./monaco-markdown-diff-editor.tsx";
import { cn } from "../../lib/utils.ts";
import { useLiveState } from "../../hooks/utils-hooks.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

export interface MonacoMarkdownDiffEditorAiEditsWrapper_Props {
	ref?: Ref<MonacoMarkdownDiffEditor_Ref>;
	id?: string;
	className?: string;
	pageId: app_convex_Id<"pages">;
	threadId: string;
	onExit: () => void;
}

export function MonacoMarkdownDiffEditorAiEditsWrapper(props: MonacoMarkdownDiffEditorAiEditsWrapper_Props) {
	const { ref, id, className, pageId, threadId, onExit } = props;
	const convex = useConvex();

	const [initialModified, setInitialModified] = useLiveState<string | undefined>(undefined);

	const diffEditorRef = useRef<MonacoMarkdownDiffEditor_Ref>(null);
	useImperativeHandle(ref, () => diffEditorRef.current!, []);

	// Watch pending edits only if we have a threadId
	useEffect(() => {
		if (!threadId) return;
		const watcher = convex.watchQuery(api.ai_chat.get_ai_pending_edit, {
			pageId: pageId,
			threadId: threadId,
		});

		const unsubs = watcher.onUpdate(() => {
			const res = watcher.localQueryResult();
			if (res && typeof res === "object") {
				const { modified_content } = res;

				// If the modified content was already set, update it in the editor
				if (initialModified.current) {
					diffEditorRef.current?.setModifiedContent(modified_content ?? "");
				} else {
					setInitialModified(modified_content);
				}
			}
		});
		return () => {
			unsubs();
		};
	}, [convex, pageId, threadId]);

	return (
		<div id={id} className={cn("MonacoMarkdownDiffEditorAiEditsWrapper h-full w-full", className)}>
			{initialModified.current && (
				<MonacoMarkdownDiffEditor
					ref={diffEditorRef}
					className={className}
					pageId={pageId}
					threadId={threadId}
					modifiedInitialValue={initialModified.current}
					onExit={onExit}
				/>
			)}
		</div>
	);
}
