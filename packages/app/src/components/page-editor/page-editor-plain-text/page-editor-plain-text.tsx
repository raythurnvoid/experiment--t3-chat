import "./page-editor-plain-text.css";
import "@/lib/app-monaco-config.ts";
import {
	pages_MONACO_THEME_NAME_DARK,
	pages_monaco_register_themes,
	pages_yjs_doc_create_from_markdown,
	pages_yjs_doc_get_markdown,
	pages_yjs_create_doc_from_array_buffer_update,
} from "@/lib/pages.ts";
import React, { Suspense, useState } from "react";
import { Editor, type EditorProps } from "@monaco-editor/react";
import type { editor as monaco_editor } from "monaco-editor";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "@/../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { cn, compute_fallback_user_name, should_never_happen } from "@/lib/utils.ts";
import { MyButton } from "@/components/my-button.tsx";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChevronRight } from "lucide-react";
import { MyIcon } from "@/components/my-icon.tsx";
import { Await } from "@/components/await.tsx";
import {
	MyAvatar,
	MyAvatarFallback,
	MyAvatarImage,
	MyAvatarSkeleton,
	MyAvatarLoading,
} from "@/components/my-avatar.tsx";
import { Doc as YDoc } from "yjs";

// #region Error
type PageEditorPlainTextError_Props = ErrorComponentProps;

type PageEditorPlainTextError_ClassNames =
	| "PageEditorPlainTextError"
	| "PageEditorPlainTextError-content"
	| "PageEditorPlainTextError-title"
	| "PageEditorPlainTextError-description"
	| "PageEditorPlainTextError-actions"
	| "PageEditorPlainTextError-retry-button"
	| "PageEditorPlainTextError-technical-details"
	| "PageEditorPlainTextError-technical-details-toggle"
	| "PageEditorPlainTextError-technical-details-toggle-icon"
	| "PageEditorPlainTextError-technical-details-pre"
	| "PageEditorPlainTextError-technical-details-textarea";

function PageEditorPlainTextError(props: PageEditorPlainTextError_Props) {
	const { error, info } = props;

	const technicalDetails = [
		error.message && `Error message: ${error.message}`,
		error.stack && `Stack trace:\n${error.stack}`,
		info?.componentStack && `Component stack:\n${info.componentStack}`,
	]
		.filter(Boolean)
		.join("\n\n");

	return (
		<div className={cn("PageEditorPlainTextError" satisfies PageEditorPlainTextError_ClassNames)}>
			<div className={cn("PageEditorPlainTextError-content" satisfies PageEditorPlainTextError_ClassNames)}>
				<div className={cn("PageEditorPlainTextError-title" satisfies PageEditorPlainTextError_ClassNames)}>
					Editor failed to load.
				</div>
				<div className={cn("PageEditorPlainTextError-description" satisfies PageEditorPlainTextError_ClassNames)}>
					Try again, or reload the page if the problem persists.
				</div>
				<div className={cn("PageEditorPlainTextError-actions" satisfies PageEditorPlainTextError_ClassNames)}>
					<MyButton
						variant="secondary"
						className={cn("PageEditorPlainTextError-retry-button" satisfies PageEditorPlainTextError_ClassNames)}
						onClick={props.reset}
					>
						Try again
					</MyButton>
				</div>
				{technicalDetails && (
					<details
						className={cn("PageEditorPlainTextError-technical-details" satisfies PageEditorPlainTextError_ClassNames)}
					>
						<summary
							className={cn(
								"PageEditorPlainTextError-technical-details-toggle" satisfies PageEditorPlainTextError_ClassNames,
							)}
						>
							<span>Technical details</span>
							<MyIcon
								className={cn(
									"PageEditorPlainTextError-technical-details-toggle-icon" satisfies PageEditorPlainTextError_ClassNames,
								)}
							>
								<ChevronRight />
							</MyIcon>
						</summary>
						<pre
							className={cn(
								"PageEditorPlainTextError-technical-details-pre" satisfies PageEditorPlainTextError_ClassNames,
							)}
						>
							<textarea
								className={cn(
									"PageEditorPlainTextError-technical-details-textarea" satisfies PageEditorPlainTextError_ClassNames,
								)}
								readOnly
								value={technicalDetails}
							></textarea>
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}

// #endregion Error

async function fetch_page_markdown_content_and_yjs_doc(
	convex: ConvexReactClient,
	args: {
		workspaceId: string;
		projectId: string;
		pageId: app_convex_Id<"pages">;
	},
) {
	const queryResult = await convex.query(api.ai_docs_temp.try_get_markdown_content_or_fallback_to_yjs_data, args);

	if (queryResult == null) {
		// Return empty state
		const emptyYjsDoc = new YDoc();
		return { markdown: "", mut_yjsDoc: emptyYjsDoc };
	}

	if (queryResult.kind === "markdown_content") {
		const markdown = queryResult.markdownContentDoc.content;
		const yjsDoc = pages_yjs_doc_create_from_markdown({ markdown });
		return { markdown, mut_yjsDoc: yjsDoc };
	}

	if (queryResult.kind === "yjs_snapshot") {
		const yjsDoc = pages_yjs_create_doc_from_array_buffer_update(queryResult.yjsSnapshotDoc.snapshot_update);
		const markdown = pages_yjs_doc_get_markdown({ yjsDoc });
		return { markdown, mut_yjsDoc: yjsDoc };
	}

	if (queryResult.kind === "yjs_snapshots_with_incremental_updates") {
		const yjsUpdatesDocs = queryResult.yjsUpdatesDocs;
		const yjsDoc = pages_yjs_create_doc_from_array_buffer_update(queryResult.yjsSnapshotDoc.snapshot_update, {
			additionalIncrementalArrayBufferUpdates: yjsUpdatesDocs.map((d) => d.update),
		});
		const markdown = pages_yjs_doc_get_markdown({ yjsDoc });
		return { markdown, mut_yjsDoc: yjsDoc };
	}

	throw should_never_happen("fetch_page_markdown_content_and_yjs_doc: Invalid page content data", { queryResult });
}

// #region Root
type PageEditorPlainText_ClassNames =
	| "PageEditorPlainText"
	| "PageEditorPlainText-avatars"
	| "PageEditorPlainText-avatar"
	| "PageEditorPlainText-avatar-border"
	| "PageEditorPlainText-editor";

type PageEditorPlainText_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	initialValue: string;
	presenceStore: pages_PresenceStore;
	onlineUsers: Array<{ userId: string; isSelf: boolean; color: string }>;
	headerSlot: React.ReactNode;
};

function PageEditorPlainText_Inner(props: PageEditorPlainText_Inner_Props) {
	const { initialValue, onlineUsers, headerSlot, pageId: _pageId, presenceStore: _presenceStore } = props;

	const [_editor, setEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);

	const handleOnMount: EditorProps["onMount"] = (e, monaco) => {
		pages_monaco_register_themes(monaco);
		monaco.editor.setTheme(pages_MONACO_THEME_NAME_DARK);
		setEditor(e);

		// Force consistent EOL to LF like in the diff editor
		const editorModel = e.getModel();
		if (editorModel) {
			editorModel.setEOL(monaco.editor.EndOfLineSequence.LF);
			editorModel.setValue(initialValue);
		}
	};

	return (
		<div className={"PageEditorPlainText" satisfies PageEditorPlainText_ClassNames}>
			{headerSlot}

			<div className={"PageEditorPlainText-avatars" satisfies PageEditorPlainText_ClassNames}>
				{onlineUsers.map((user) => (
					<MyAvatar key={user.userId} className={"PageEditorPlainText-avatar" satisfies PageEditorPlainText_ClassNames}>
						<MyAvatarImage />
						<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
						<MyAvatarLoading>
							<MyAvatarSkeleton />
						</MyAvatarLoading>
						<span className={"PageEditorPlainText-avatar-border" satisfies PageEditorPlainText_ClassNames}></span>
					</MyAvatar>
				))}
			</div>

			<div className={"PageEditorPlainText-editor" satisfies PageEditorPlainText_ClassNames}>
				<Editor
					height="100%"
					language="markdown"
					theme={pages_MONACO_THEME_NAME_DARK}
					options={{
						wordWrap: "on",
					}}
					onMount={handleOnMount}
				/>
			</div>
		</div>
	);
}

export type PageEditorPlainText_Props = {
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	onlineUsers: Array<{ userId: string; isSelf: boolean; color: string }>;
	headerSlot: React.ReactNode;
};

export function PageEditorPlainText(props: PageEditorPlainText_Props) {
	const { pageId, presenceStore, onlineUsers, headerSlot } = props;

	const convex = useConvex();

	const pageContentData = fetch_page_markdown_content_and_yjs_doc(convex, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});

	return (
		<CatchBoundary
			getResetKey={() => 0}
			errorComponent={PageEditorPlainTextError}
			onCatch={(err) => {
				console.error("PageEditorPlainText:", err);
			}}
		>
			<Suspense fallback={<>Loading</>}>
				<Await promise={pageContentData}>
					{(pageContentData) => (
						<PageEditorPlainText_Inner
							pageId={pageId}
							initialValue={pageContentData.markdown}
							presenceStore={presenceStore}
							onlineUsers={onlineUsers}
							headerSlot={headerSlot}
						/>
					)}
				</Await>
			</Suspense>
		</CatchBoundary>
	);
}
// #endregion Root
