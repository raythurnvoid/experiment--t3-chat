import "./monaco-markdown-editor.css";
import "../../lib/app-monaco-config.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { editor as M } from "monaco-editor";
import { useRoom } from "@liveblocks/react/suspense";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { MonacoBinding } from "y-monaco";
import { useConvex, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { cn } from "../../lib/utils.ts";
import type { Awareness } from "y-protocols/awareness";
import { useSelf, useOthers } from "@liveblocks/react/suspense";

export interface MonacoMarkdownEditor_Props {
	pageId: string;
	className?: string;
}

/**
 * This component is inspired from Liveblocks example: liveblocks/examples/nextjs-yjs-monaco/src/components/CollaborativeEditor.tsx
 */
export function MonacoMarkdownEditor(props: MonacoMarkdownEditor_Props) {
	const { pageId, className } = props;
	const room = useRoom();
	const convex = useConvex();
	const selfUser = useSelf();
	const otherUsers = useOthers();
	const yProvider = useMemo(() => getYjsProviderForRoom(room), [room]);

	const [editor, setEditor] = useState<M.IStandaloneCodeEditor | null>(null);
	const updateAndBroadcastRichtext = useMutation(api.ai_docs_temp.update_page_and_broadcast_richtext);
	const isApplyingBroadcastRef = useRef(false);
	const textContentWatchRef = useRef<{ unsubscribe: () => void } | null>(null);
	const [initialValue, setInitialValue] = useState<string | null | undefined>(undefined);

	// Approximate useIsEditorReady for Monaco/Yjs: ready when Yjs provider is synchronizing or synchronized
	const [isYjsReady, setIsYjsReady] = useState(false);
	useEffect(() => {
		const provider = yProvider;
		if (!provider) return;
		const updateStatus = () => {
			const status = provider.getStatus();
			setIsYjsReady(status === "synchronizing" || status === "synchronized");
		};
		updateStatus();
		const handler = () => updateStatus();
		provider.on("status", handler);
		return () => {
			provider.off("status", handler);
		};
	}, [yProvider]);

	useEffect(() => {
		if (!editor) return;
		console.log("editor");

		const yDoc = yProvider.getYDoc();
		const yText = yDoc.getText(`markdown:${pageId}`);

		const model = editor.getModel();
		const awareness = yProvider.awareness as unknown as Awareness;
		const binding = ((/* iife */) => {
			if (model) {
				return new MonacoBinding(yText, model, new Set([editor]), awareness);
			}
		})();

		return () => {
			binding?.destroy();
		};
	}, [editor, yProvider, pageId]);

	// Listen for updates once
	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: pageId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			if (initialValue === undefined) {
				const v = watcher.localQueryResult();
				setInitialValue(typeof v === "string" ? v : "");
			}
		});

		textContentWatchRef.current = {
			unsubscribe: () => {
				unsubscribe();
				textContentWatchRef.current = null;
			},
		};

		return () => {
			textContentWatchRef.current?.unsubscribe();
		};
	}, [convex, pageId, initialValue]);

	// After editor mounts, fetch latest value once and set initialValue if still undefined
	useEffect(() => {
		if (!editor || initialValue !== undefined) return;
		void (async () => {
			const fetchedValue = await convex.query(api.ai_docs_temp.get_page_text_content_by_page_id, {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: pageId,
			});

			// Set the initial value if it's not already set
			if (fetchedValue) {
				setInitialValue((currentValue) => currentValue ?? fetchedValue);
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [convex, pageId]);

	// Apply initialValue once editor is mounted, then unsubscribe the watch
	useEffect(() => {
		if (!editor || !isYjsReady || initialValue === undefined) return;
		const yDoc = yProvider.getYDoc();
		const seed = typeof initialValue === "string" ? initialValue : "";
		if (seed.length > 0) {
			const yText = yDoc.getText(`markdown:${pageId}`);
			yText.delete(0, yText.length);
			yText.insert(0, seed);
		}
		// Unsubscribe the text watcher now that we seeded once
		textContentWatchRef.current?.unsubscribe();
	}, [editor, isYjsReady, initialValue, yProvider, pageId]);

	// Listen for Convex markdown broadcasts
	useEffect(() => {
		if (!editor) return;
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_updates_markdown_broadcast_latest, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: pageId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			const update = watcher.localQueryResult();
			if (!editor || !update) return;
			const model = editor.getModel();
			if (!model) return;
			const current = model.getValue();
			if (current === update.text_content) return;
			isApplyingBroadcastRef.current = true;
			model.setValue(update.text_content);
			// Small delay to allow Monaco to emit change event, then clear the flag
			queueMicrotask(() => {
				isApplyingBroadcastRef.current = false;
			});
		});

		return () => {
			unsubscribe();
		};
	}, [convex, editor, pageId]);

	// On Monaco content changes, update Convex and broadcast to richtext
	useEffect(() => {
		if (!editor) return;
		const disposable = editor.onDidChangeModelContent(async () => {
			if (isApplyingBroadcastRef.current) return;
			const value = editor.getValue();
			await updateAndBroadcastRichtext({
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: pageId,
				text_content: value,
			});
		});
		return () => {
			disposable.dispose();
		};
	}, [editor, updateAndBroadcastRichtext, pageId]);

	const handleOnMount = useCallback((e: M.IStandaloneCodeEditor) => {
		setEditor(e);
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
					language="markdown"
					onMount={handleOnMount}
					options={{
						wordWrap: "on",
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
