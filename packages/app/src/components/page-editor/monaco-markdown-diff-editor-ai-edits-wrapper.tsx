import React, { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { PageEditorDiff, type PageEditorDiff_Ref } from "./page-editor-diff/page-editor-diff.tsx";
import { cn } from "../../lib/utils.ts";
import { useStateRef } from "../../hooks/utils-hooks.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

export interface MonacoMarkdownDiffEditorAiEditsWrapper_Props {
	ref?: Ref<PageEditorDiff_Ref>;
	id?: string;
	className?: string;
	headerSlot?: React.ReactNode;
	pageId: app_convex_Id<"pages">;
	onExit: () => void;
}

export function MonacoMarkdownDiffEditorAiEditsWrapper(props: MonacoMarkdownDiffEditorAiEditsWrapper_Props) {
	const { ref, id, className, headerSlot, pageId, onExit } = props;
	const convex = useConvex();

	const [initialModified, setInitialModified] = useStateRef<string | undefined>(undefined);

	const diffEditorRef = useRef<PageEditorDiff_Ref>(null);
	useImperativeHandle(ref, () => diffEditorRef.current!, []);

	// Watch pending edits for this page
	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_chat.get_ai_pending_edit, {
			pageId: pageId,
		});

		const unsubs = watcher.onUpdate(() => {
			const res = watcher.localQueryResult();
			if (res && typeof res === "object") {
				const { modifiedContent } = res;

				// If the modified content was already set, update it in the editor
				if (initialModified.current) {
					diffEditorRef.current?.setModifiedContent(modifiedContent ?? "");
				} else {
					setInitialModified(modifiedContent);
				}
			}
		});
		return () => {
			unsubs();
		};
	}, [convex, pageId]);

	return (
		<div id={id} className={cn("MonacoMarkdownDiffEditorAiEditsWrapper h-full w-full", className)}>
			{initialModified.current && (
				// @ts-expect-error
				<PageEditorDiff
					ref={diffEditorRef}
					className={className}
					headerSlot={headerSlot}
					pageId={pageId}
					modifiedInitialValue={initialModified.current}
					onExit={onExit}
				/>
			)}
		</div>
	);
}
