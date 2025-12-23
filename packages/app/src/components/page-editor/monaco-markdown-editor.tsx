import "./monaco-markdown-editor.css";
import "@/lib/app-monaco-config.ts";
import { use, useEffect, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { editor as Monaco } from "monaco-editor";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { cn } from "@/lib/utils.ts";
import { MyButton } from "@/components/my-button.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChevronRight } from "lucide-react";
import { MyIcon } from "../my-icon.tsx";

// #region Inner
type MonacoMarkdownEditorInner_Props = {
	pageId: app_convex_Id<"pages">;
	initialValue: Promise<string>;
	presenceStore: pages_PresenceStore;
};

function MonacoMarkdownEditorInner(props: MonacoMarkdownEditorInner_Props) {
	const { pageId, presenceStore } = props;

	const convex = useConvex();

	const [editor, setEditor] = useState<Monaco.IStandaloneCodeEditor | null>(null);

	const initialValue = use(props.initialValue);

	const handleOnMount = (e: Monaco.IStandaloneCodeEditor) => {
		setEditor(e);
	};

	return (
		<div className={cn("MonacoMarkdownEditor flex h-full w-full flex-col", className)}>
			{/* Avatars bar showing current users */}
			<div className="MonacoMarkdownEditor-avatars flex items-center gap-2 border-b border-border/80 bg-background/50 p-2">
				{/* Current user avatar */}
				{presenceStore.presenceData.get(presenceStore.localSessionId) && (
					<div
						className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
						style={{
							backgroundColor: presenceStore.presenceData.get(presenceStore.localSessionId)?.color as string,
							color: "white",
						}}
						title={presenceStore.presenceData.get(presenceStore.localSessionId)?.name}
					>
						{presenceStore.presenceData.get(presenceStore.localSessionId)?.name ? (
							<span>{presenceStore.presenceData.get(presenceStore.localSessionId)!.name.charAt(0).toUpperCase()}</span>
						) : null}
					</div>
				)}
				{/* Other users' avatars */}
				{Array.from(presenceStore.presenceData.entries())
					.filter(([sessionId]) => sessionId !== presenceStore.localSessionId)
					.map(([sessionId, user]) => (
						<div
							key={sessionId}
							className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
							style={{
								backgroundColor: user.color as string,
								color: "white",
							}}
							title={user.name || "Anonymous"}
						>
							<span>{(user.name || "Anonymous").charAt(0).toUpperCase()}</span>
						</div>
					))}
			</div>
			{/* Monaco Editor */}
			<div className="MonacoMarkdownEditor-editor flex-1">
				<Editor
					height="100%"
					language="markdown"
					options={{
						wordWrap: "on",
					}}
					defaultValue={initialValue}
					onMount={handleOnMount}
				/>
			</div>
		</div>
	);
}
// #endregion Inner

// #region Error
type MonacoMarkdownEditorError_Props = ErrorComponentProps;

type MonacoMarkdownEditorError_ClassNames =
	| "MonacoMarkdownEditorError"
	| "MonacoMarkdownEditorError-content"
	| "MonacoMarkdownEditorError-title"
	| "MonacoMarkdownEditorError-description"
	| "MonacoMarkdownEditorError-actions"
	| "MonacoMarkdownEditorError-retry-button"
	| "MonacoMarkdownEditorError-technical-details"
	| "MonacoMarkdownEditorError-technical-details-toggle"
	| "MonacoMarkdownEditorError-technical-details-toggle-icon"
	| "MonacoMarkdownEditorError-technical-details-pre"
	| "MonacoMarkdownEditorError-technical-details-textarea";

function MonacoMarkdownEditorError(props: MonacoMarkdownEditorError_Props) {
	const { error, info } = props;

	const technicalDetails = [
		error.message && `Error message: ${error.message}`,
		error.stack && `Stack trace:\n${error.stack}`,
		info?.componentStack && `Component stack:\n${info.componentStack}`,
	]
		.filter(Boolean)
		.join("\n\n");

	return (
		<div className={cn("MonacoMarkdownEditorError" satisfies MonacoMarkdownEditorError_ClassNames)}>
			<div className={cn("MonacoMarkdownEditorError-content" satisfies MonacoMarkdownEditorError_ClassNames)}>
				<div className={cn("MonacoMarkdownEditorError-title" satisfies MonacoMarkdownEditorError_ClassNames)}>
					Editor failed to load.
				</div>
				<div className={cn("MonacoMarkdownEditorError-description" satisfies MonacoMarkdownEditorError_ClassNames)}>
					Try again, or reload the page if the problem persists.
				</div>
				<div className={cn("MonacoMarkdownEditorError-actions" satisfies MonacoMarkdownEditorError_ClassNames)}>
					<MyButton
						variant="secondary"
						className={cn("MonacoMarkdownEditorError-retry-button" satisfies MonacoMarkdownEditorError_ClassNames)}
						onClick={props.reset}
					>
						Try again
					</MyButton>
				</div>
				{technicalDetails && (
					<details
						className={cn("MonacoMarkdownEditorError-technical-details" satisfies MonacoMarkdownEditorError_ClassNames)}
					>
						<summary
							className={cn(
								"MonacoMarkdownEditorError-technical-details-toggle" satisfies MonacoMarkdownEditorError_ClassNames,
							)}
						>
							<span>Technical details</span>
							<MyIcon
								className={cn(
									"MonacoMarkdownEditorError-technical-details-toggle-icon" satisfies MonacoMarkdownEditorError_ClassNames,
								)}
							>
								<ChevronRight />
							</MyIcon>
						</summary>
						<pre
							className={cn(
								"MonacoMarkdownEditorError-technical-details-pre" satisfies MonacoMarkdownEditorError_ClassNames,
							)}
						>
							<textarea
								className={cn(
									"MonacoMarkdownEditorError-technical-details-textarea" satisfies MonacoMarkdownEditorError_ClassNames,
								)}
								readOnly
							>
								{technicalDetails}
							</textarea>
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}

// #endregion Error

// #region Root
export type MonacoMarkdownEditor_Props = {
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
};

export function MonacoMarkdownEditor(props: MonacoMarkdownEditor_Props) {
	const { pageId, presenceStore } = props;

	const convex = useConvex();

	const initialValuePromise = convex
		.query(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId,
		})
		.then((value) => value ?? "");

	return (
		<CatchBoundary
			getResetKey={() => 0}
			errorComponent={MonacoMarkdownEditorError}
			onCatch={(err) => {
				console.error("MonacoMarkdownEditor:", err);
			}}
		>
			<MonacoMarkdownEditorInner pageId={pageId} initialValue={initialValuePromise} presenceStore={presenceStore} />
		</CatchBoundary>
	);
}
// #endregion Root
