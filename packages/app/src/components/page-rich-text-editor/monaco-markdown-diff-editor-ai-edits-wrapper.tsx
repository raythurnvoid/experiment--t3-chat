import { useEffect, useRef, useImperativeHandle } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { MonacoMarkdownDiffEditor, type MonacoMarkdownDiffEditor_Ref } from "./monaco-markdown-diff-editor.tsx";
import type { RefObject } from "react";
import { cn } from "../../lib/utils.ts";
import { useLiveState } from "../../hooks/utils-hooks.ts";

export interface MonacoMarkdownDiffEditorAiEditsWrapper_Props {
	ref?: RefObject<MonacoMarkdownDiffEditor_Ref | undefined>;
	id?: string;
	className?: string;
	pageId: string;
	threadId: string;
	onExit: () => void;
}

export function MonacoMarkdownDiffEditorAiEditsWrapper(props: MonacoMarkdownDiffEditorAiEditsWrapper_Props) {
	const { ref, id, className, pageId, threadId, onExit } = props;
	const convex = useConvex();

	const diffRef = useRef<MonacoMarkdownDiffEditor_Ref | undefined>(undefined);

	// Forward imperative handle to parent via useImperativeHandle
	useImperativeHandle(
		ref,
		() => ({
			setModifiedContent: (value: string) => {
				diffRef.current?.setModifiedContent(value);
			},
		}),
		[],
	);

	const [initialModified, setInitialModified] = useLiveState<string | undefined>(undefined);

	// Watch pending edits only if we have a threadId
	useEffect(() => {
		if (!threadId) return;
		const watcher = convex.watchQuery(api.ai_chat.get_ai_pending_edit, {
			page_id: pageId,
			thread_id: threadId,
		});
		const unsubs = watcher.onUpdate(() => {
			const res = watcher.localQueryResult();
			if (res && typeof res === "object") {
				const { modified_content } = res;

				// If the modified content was already set, update it in the editor
				if (initialModified.current) {
					diffRef.current?.setModifiedContent(modified_content ?? "");
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
					ref={diffRef}
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
