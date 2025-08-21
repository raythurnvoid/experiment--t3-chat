import "./monaco-markdown-editor.css";
import "../../lib/app-monaco-config.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { editor as M } from "monaco-editor";
import { useRoom } from "@liveblocks/react/suspense";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { MonacoBinding } from "y-monaco";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";
import type { Awareness } from "y-protocols/awareness";
import { useSelf, useOthers } from "@liveblocks/react/suspense";

export interface MonacoMarkdownEditor_Props {
	docId: string;
	className?: string;
}

/**
 * This component is inspired from Liveblocks example: liveblocks/examples/nextjs-yjs-monaco/src/components/CollaborativeEditor.tsx
 */
export function MonacoMarkdownEditor(props: MonacoMarkdownEditor_Props) {
	const { docId, className } = props;
	const room = useRoom();
	const selfUser = useSelf();
	const otherUsers = useOthers();
	const yProvider = useMemo(() => getYjsProviderForRoom(room), [room]);

	const initialContent = useQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: docId,
	});

	const [editorRef, setEditorRef] = useState<M.IStandaloneCodeEditor | null>(null);

	useEffect(() => {
		if (!editorRef) return;
		const yDoc = yProvider.getYDoc();
		const cfg = yDoc.getMap("liveblocks_config");
		const yText = yDoc.getText(`markdown:${docId}`);

		// Seed initial content once
		const seedKey = `monaco:hasContentSet:${docId}`;
		if (!cfg.get(seedKey) && typeof initialContent === "string" && initialContent.length > 0) {
			cfg.set(seedKey, true);
			yText.delete(0, yText.length);
			yText.insert(0, initialContent);
		}

		const model = editorRef.getModel();
		const awareness = yProvider.awareness as unknown as Awareness;
		const binding = ((/* iife */) => {
			if (model) {
				return new MonacoBinding(yText, model, new Set([editorRef]), awareness);
			}
		})();

		return () => {
			binding?.destroy();
		};
	}, [editorRef, yProvider, initialContent, docId]);

	const handleOnMount = useCallback((e: M.IStandaloneCodeEditor) => {
		setEditorRef(e);
	}, []);

	return (
		<div className={cn("MonacoMarkdownEditor flex h-full w-full flex-col", className)}>
			{/* Avatars bar showing current users */}
			<div className="MonacoMarkdownEditor-avatars flex items-center gap-2 border-b border-border/80 bg-background/50 p-2">
				{/* Current user avatar */}
				{selfUser && (
					<div
						className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
						style={{
							backgroundColor: selfUser.info?.color as string,
							color: "white",
						}}
						title={selfUser.info?.name}
					>
						{selfUser.info?.avatar ? (
							<img
								src={selfUser.info.avatar}
								alt={selfUser.info?.name}
								className="h-full w-full rounded-full object-cover"
							/>
						) : selfUser.info?.name ? (
							<span>{selfUser.info.name.charAt(0).toUpperCase()}</span>
						) : null}
					</div>
				)}
				{/* Other users' avatars */}
				{otherUsers.map((user) => (
					<div
						key={user.connectionId}
						className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
						style={{
							backgroundColor: user.info?.color as string,
							color: "white",
						}}
						title={user.info?.name || "Anonymous"}
					>
						{user.info?.avatar ? (
							<img
								src={user.info.avatar}
								alt={user.info?.name || "Anonymous"}
								className="h-full w-full rounded-full object-cover"
							/>
						) : (
							<span>{(user.info?.name || "Anonymous").charAt(0).toUpperCase()}</span>
						)}
					</div>
				))}
			</div>
			{/* Monaco Editor */}
			<div className="MonacoMarkdownEditor-editor flex-1">
				{/* Dynamic cursor styles for remote users (labels & colors) */}
				{yProvider?.awareness && (
					<MonacoMarkdownEditor_Cursors awareness={yProvider.awareness as unknown as Awareness} />
				)}
				<Editor
					height="100%"
					defaultLanguage="markdown"
					onMount={handleOnMount}
					options={{
						wordWrap: "on",
						minimap: { enabled: false },
						lineNumbers: "off",
						folding: false,
						lineDecorationsWidth: 0,
						lineNumbersMinChars: 0,
					}}
				/>
			</div>
		</div>
	);
}

type MonacoMarkdownEditor_Cursors_Props = {
	awareness: Awareness;
};

/**
 * This component is inspired from Liveblocks example: liveblocks/examples/nextjs-yjs-monaco/src/components/Cursors.tsx
 */
function MonacoMarkdownEditor_Cursors(props: MonacoMarkdownEditor_Cursors_Props) {
	const { awareness } = props;

	type UserAwareness = { user?: { name?: string; color?: string } };
	type AwarenessList = Array<[number, UserAwareness | undefined]>;
	const [awarenessUsers, setAwarenessUsers] = useState<AwarenessList>([]);
	const userInfo = useSelf((me) => me.info);

	useEffect(() => {
		const localUser: UserAwareness["user"] = userInfo;
		awareness.setLocalStateField("user", localUser);

		function setUsers() {
			setAwarenessUsers([...(awareness.getStates() as Map<number, UserAwareness>).entries()]);
		}

		awareness.on("change", setUsers);
		setUsers();

		return () => {
			awareness.off("change", setUsers);
		};
	}, [awareness, userInfo]);

	const cssContent = useMemo(() => {
		const escapeCssContent = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
		let styles = "";
		for (const [clientId, client] of awarenessUsers) {
			const color = client?.user?.color;
			const name = client?.user?.name;
			if (!color && !name) continue;

			if (color) {
				styles += cursor_styles.replaceAll("{{clientId}}", clientId.toString()).replaceAll("{{color}}", color);
			}

			if (name) {
				styles += cursor_styles_name
					.replaceAll("{{clientId}}", clientId.toString())
					.replaceAll("{{name}}", escapeCssContent(name));
			}
		}
		return styles;
	}, [awarenessUsers]);

	if (!cssContent) return null;
	return <style dangerouslySetInnerHTML={{ __html: cssContent }} />;
}

const cursor_styles = `\
.MonacoMarkdownEditor :where(.yRemoteSelection-{{clientId}}),
.MonacoMarkdownEditor :where(.yRemoteSelectionHead-{{clientId}}) {
	--user-color: {{color}};
}
`;

const cursor_styles_name = `\
.MonacoMarkdownEditor :where(.yRemoteSelectionHead-{{clientId}})::after {
	content: "{{name}}";
}
`;
