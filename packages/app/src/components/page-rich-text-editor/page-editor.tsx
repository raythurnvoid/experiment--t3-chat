import "./page-editor.css";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { useAuth } from "../../lib/auth.ts";
import { app_fetch_ai_docs_liveblocks_auth } from "../../lib/fetch.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { PageRichTextEditorBody } from "./editor.tsx";
import { PageEditorSkeleton } from "./page-editor-skeleton.tsx";
import { useState, useImperativeHandle, type Ref } from "react";
import { Switch } from "../ui/switch.tsx";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor.tsx";
import { MonacoMarkdownDiffEditorAiEditsWrapper } from "./monaco-markdown-diff-editor-ai-edits-wrapper.tsx";
import { cn } from "../../lib/utils.ts";
import { MonacoMarkdownDiffEditor } from "./monaco-markdown-diff-editor.tsx";

function ai_docs_create_liveblocks_room_id(orgId: string, projectId: string, docId: string) {
	return `${orgId}:${projectId}:${docId}`;
}

export type PageEditor_ClassNames =
	| "PageEditor"
	| "PageEditor-switch-bar"
	| "PageEditor-diff-switch"
	| "PageEditor-switch-label"
	| "PageEditor-switch-container"
	| "PageEditor-editor-container";

export type PageEditor_Ref = {
	requestOpenDiff: (args: { pageId: string; modifiedEditorValue: string }) => void;
	getMode: () => PageEditor_Mode;
};

export type PageEditor_Props = {
	ref?: Ref<PageEditor_Ref>;
	pageId: string | null | undefined;
	threadId?: string;
};

export function PageEditor(props: PageEditor_Props) {
	const { ref: refProp, pageId, threadId } = props;

	const auth = useAuth();
	const [editorMode, setEditorMode] = useState<PageEditor_Mode>("rich");

	const handleDiffExit = () => {
		setEditorMode("rich");
	};

	useImperativeHandle(
		refProp,
		() => ({
			requestOpenDiff: (_args: { pageId: string; modifiedEditorValue: string }) => {
				setEditorMode("diff");
			},
			getMode: () => editorMode,
		}),
		[editorMode],
	);

	if (!pageId) {
		return <div>No document selected</div>;
	}

	const roomId = ai_docs_create_liveblocks_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, pageId);

	return (
		<LiveblocksProvider
			authEndpoint={async (room) => {
				const result = await app_fetch_ai_docs_liveblocks_auth({
					input: { room },
					auth: auth.isAuthenticated,
				});

				if (result._nay) {
					throw new Error(`Failed to authenticate: ${result._nay.message}`);
				}

				return result._yay.payload;
			}}
		>
			<RoomProvider id={roomId}>
				<ClientSideSuspense fallback={<PageEditorSkeleton />}>
					<div className={cn("PageEditor" satisfies PageEditor_ClassNames)}>
						<div className={cn("PageEditor-switch-bar" satisfies PageEditor_ClassNames)}>
							{/* Left: Diff switch (only in markdown mode) */}
							<div
								className={cn(
									"PageEditor-diff-switch" satisfies PageEditor_ClassNames,
									editorMode === "rich" && "invisible",
								)}
							>
								<span className="text-xs text-muted-foreground/80">Diff</span>
								<Switch
									checked={editorMode === "diff"}
									onCheckedChange={(checked: boolean) => setEditorMode(checked ? "diff" : "markdown")}
								/>
							</div>
							{/* Right: Rich/Markdown switch */}
							<div className="flex items-center gap-3">
								<span className={cn("PageEditor-switch-label" satisfies PageEditor_ClassNames)}>
									{editorMode === "rich" ? "Rich Text" : "Markdown"}
								</span>
								<div className={cn("PageEditor-switch-container" satisfies PageEditor_ClassNames)}>
									<span className="text-xs text-muted-foreground/80">Rich</span>
									<Switch
										checked={editorMode !== "rich"}
										onCheckedChange={(checked: boolean) => setEditorMode(checked ? "markdown" : "rich")}
									/>
									<span className="text-xs text-muted-foreground/80">Markdown</span>
								</div>
							</div>
						</div>
						<div className={cn("PageEditor-editor-container" satisfies PageEditor_ClassNames)}>
							{editorMode === "rich" ? (
								<PageRichTextEditorBody pageId={pageId} />
							) : editorMode === "diff" ? (
								threadId ? (
									<MonacoMarkdownDiffEditorAiEditsWrapper pageId={pageId} threadId={threadId} onExit={handleDiffExit} />
								) : (
									<MonacoMarkdownDiffEditor pageId={pageId} onExit={handleDiffExit} />
								)
							) : (
								<MonacoMarkdownEditor pageId={pageId} />
							)}
						</div>
					</div>
				</ClientSideSuspense>
			</RoomProvider>
		</LiveblocksProvider>
	);
}

export type PageEditor_Mode = "rich" | "markdown" | "diff";
