import "./monaco-markdown-editor.css";
import "../../lib/app-monaco-config.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { editor as M } from "monaco-editor";
import { useRoom } from "@liveblocks/react";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { MonacoBinding } from "y-monaco";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";
import type { Awareness } from "y-protocols/awareness";
import { useSelf, useOthers } from "@liveblocks/react";

// real time users see https://github.com/shauryag2002/real-time-monaco/tree/main

export interface MonacoMarkdownEditor_Props {
	docId: string;
	className?: string;
}

export function MonacoMarkdownEditor(props: MonacoMarkdownEditor_Props) {
	const { docId, className } = props;
	const room = useRoom();
	const self = useSelf();
	const others = useOthers();
	const provider = useMemo(() => getYjsProviderForRoom(room), [room]);

	const initialContent = useQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: docId,
	});

	const [ed, setEd] = useState<M.IStandaloneCodeEditor | null>(null);
	const bindingRef = useRef<MonacoBinding | null>(null);

	// Generate stable color from user ID
	const generateColor = (userId: string) => {
		let hash = 0;
		for (let i = 0; i < userId.length; i++) {
			hash = userId.charCodeAt(i) + ((hash << 5) - hash);
		}
		const hue = hash % 360;
		return `hsl(${hue}, 70%, 50%)`;
	};

	useEffect(() => {
		if (!ed) return;
		const ydoc = provider.getYDoc();
		const cfg = ydoc.getMap("liveblocks_config");
		const yText = ydoc.getText(`markdown:${docId}`);

		// Seed initial content once
		const seedKey = `monaco:hasContentSet:${docId}`;
		if (!cfg.get(seedKey) && typeof initialContent === "string" && initialContent.length > 0) {
			cfg.set(seedKey, true);
			yText.delete(0, yText.length);
			yText.insert(0, initialContent);
		}

		const model = ed.getModel();
		if (model) {
			// Cast awareness to the expected type from y-protocols/awareness
			const awareness = provider.awareness as unknown as Awareness;

			// Set local user presence for cursor decorations
			const userId = self?.id || "anonymous";
			const userColor = generateColor(userId);
			awareness.setLocalStateField("user", {
				name: self?.info?.name || "You",
				color: userColor,
			});

			bindingRef.current = new MonacoBinding(yText, model, new Set([ed]), awareness);
		}
		return () => {
			// Clean up local state before destroying binding
			provider.awareness.setLocalState(null);
			bindingRef.current?.destroy();
			bindingRef.current = null;
		};
	}, [ed, provider, initialContent, docId, self?.id, self?.info?.name]);

	return (
		<div className={cn("MonacoMarkdownEditor flex h-full w-full flex-col", className)}>
			{/* Avatars bar showing current users */}
			<div className="MonacoMarkdownEditor-avatars flex items-center gap-2 border-b border-border/80 bg-background/50 p-2">
				{/* Current user avatar */}
				{self && (
					<div
						className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
						style={{ backgroundColor: generateColor(self.id || "anonymous"), color: "white" }}
						title={self.info?.name || "You"}
					>
						{self.info?.avatar ? (
							<img
								src={self.info.avatar}
								alt={self.info?.name || "You"}
								className="h-full w-full rounded-full object-cover"
							/>
						) : (
							<span>{(self.info?.name || "You").charAt(0).toUpperCase()}</span>
						)}
					</div>
				)}
				{/* Other users' avatars */}
				{others.map((user) => (
					<div
						key={user.connectionId}
						className="MonacoMarkdownEditor-avatar flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-current text-xs font-medium"
						style={{ backgroundColor: generateColor(user.id || "anonymous"), color: "white" }}
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
				<Editor
					height="100%"
					defaultLanguage="markdown"
					onMount={(e) => setEd(e)}
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
