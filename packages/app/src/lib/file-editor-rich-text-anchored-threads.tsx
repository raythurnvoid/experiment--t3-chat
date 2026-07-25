// Adapted from `references-submodules/liveblocks/packages/liveblocks-react-tiptap/src/comments/AnchoredThreads.tsx`. Threads come
// from Convex now, so the thread type is the app's own `chat_messages_Thread`.
//
// The `lb-tiptap-*` class names and the `--lb-tiptap-anchored-threads-top` variable are kept: the variable is
// read by `file-editor-rich-text-comments.css` to position each thread.
import { type Editor, useEditorState } from "@tiptap/react";
import type { ComponentPropsWithoutRef, ComponentPropsWithRef, ReactNode } from "react";
import { createContext, use, useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from "react";

import { files_THREADS_PLUGIN_KEY } from "../../shared/files-tiptap-comments.ts";
import { file_editor_rich_text_get_rect_from_coords } from "@/lib/file-editor-rich-text-utils.ts";
import type { chat_messages_Thread } from "@/lib/chat-messages.ts";
import { cn } from "@/lib/utils.ts";

function readThreadElementDataset(element: HTMLElement) {
	const threadId = element.dataset.threadId;
	const isActive = element.dataset.threadActive === "true";
	return { threadId, isActive };
}

function useThreadsEditorState(editor: Editor) {
	const state = useEditorState({
		editor,
		selector: (ctx) => {
			if (!ctx.editor.state) return { pluginState: undefined };
			const state = files_THREADS_PLUGIN_KEY.getState(ctx.editor.state);
			return {
				pluginState: state,
			};
		},
		equalityFn: (prev, next) => {
			if (!prev || !next) return false;

			// Read both plugin states into locals first. The React Compiler cannot lower optional chaining
			// inside a `&&` test, and this callback is part of a component's render path.
			const prevPluginState = prev.pluginState;
			const nextPluginState = next.pluginState;
			if (!prevPluginState || !nextPluginState) return prevPluginState === nextPluginState;

			return (
				prevPluginState.selectedThreadId === nextPluginState.selectedThreadId &&
				prevPluginState.threadPositions === nextPluginState.threadPositions
			); // new map is made each time threadPos updates so shallow equality is fine
		},
	});

	return useMemo(
		() =>
			state.pluginState
				? {
						selectedThreadId: state.pluginState.selectedThreadId,
						threadPositions: state.pluginState.threadPositions,
					}
				: undefined,
		[state.pluginState],
	);
}

type FileEditorRichTextAnchoredThreadsContext_Value = NonNullable<ReturnType<typeof useThreadsEditorState>>;

const FileEditorRichTextAnchoredThreadsContext = createContext<FileEditorRichTextAnchoredThreadsContext_Value | null>(
	null,
);

type FileEditorRichTextAnchoredThreadsItemContext_Value = {
	isActive: boolean;
};

const FileEditorRichTextAnchoredThreadsItemContext =
	createContext<FileEditorRichTextAnchoredThreadsItemContext_Value | null>(null);

export type FileEditorRichTextAnchoredThreadsItem_Props = ComponentPropsWithRef<"div"> & {
	className?: string;
	thread: chat_messages_Thread;
	children: ReactNode;
};

export function FileEditorRichTextAnchoredThreadsItem(props: FileEditorRichTextAnchoredThreadsItem_Props) {
	const { className, thread, children, ...rest } = props;

	const context = use(FileEditorRichTextAnchoredThreadsContext);
	if (!context)
		throw new Error(
			"FileEditorRichTextAnchoredThreadsItem must be used within a FileEditorRichTextAnchoredThreads component",
		);

	const threadId = thread.id;
	const isActive = Boolean(context.selectedThreadId) && context.selectedThreadId === thread.id;

	return (
		<FileEditorRichTextAnchoredThreadsItemContext.Provider value={{ isActive }}>
			<div
				className={cn(className, "lb-tiptap-anchored-threads-item")}
				data-thread-id={threadId}
				data-thread-active={isActive ? "true" : "false"}
				{...rest}
			>
				{children}
			</div>
		</FileEditorRichTextAnchoredThreadsItemContext.Provider>
	);
}

FileEditorRichTextAnchoredThreadsItem.useContext = () => {
	const context = use(FileEditorRichTextAnchoredThreadsItemContext);
	if (!context)
		throw new Error(
			"FileEditorRichTextAnchoredThreadsItem.useContext must be used within a FileEditorRichTextAnchoredThreadsItem component",
		);
	return context;
};

/**
 * CSS variables supported by FileEditorRichTextAnchoredThreads component.
 * These can be set via inline styles or CSS to customize thread positioning.
 */
export type FileEditorRichTextAnchoredThreads_CssVars = {
	"--lb-tiptap-anchored-threads-top": string;
};

type ThreadWithEditorPosition = {
	thread: chat_messages_Thread;
	position: { from: number; to: number };
};

export interface FileEditorRichTextAnchoredThreads_Props extends ComponentPropsWithoutRef<"div"> {
	/**
	 * The threads to display.
	 */
	threads: chat_messages_Thread[];

	/**
	 * The Tiptap editor.
	 */
	editor: Editor;
}

export function FileEditorRichTextAnchoredThreads(props: FileEditorRichTextAnchoredThreads_Props) {
	const { threads, className, style, editor, children, ...rest } = props;

	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [threadsWithEditorPosition, setThreadsWithEditorPosition] = useState<ThreadWithEditorPosition[]>([]);

	const threadsEditorState = useThreadsEditorState(editor);

	// TODO: lexical supoprts multiple threads being active, should probably do that here as well
	const handlePositionThreads = useEffectEvent(() => {
		if (container === null || !editor.view) return;

		let activeIndex = 0;
		const elements: HTMLElement[] = [];
		const elementsHeights = new Map<HTMLElement, number>();
		const elementsThreadsEditorPositionMap = new Map<HTMLElement, (typeof threadsWithEditorPosition)[number]>();

		for (const c of container.children) {
			const child = c as HTMLElement;
			elements.push(child);
			elementsHeights.set(child, child.getBoundingClientRect().height);
			const elDataset = readThreadElementDataset(child);
			if (elDataset.threadId != null) {
				const threadWithEditorPosition = threadsWithEditorPosition.find((t) => t.thread.id === elDataset.threadId);

				if (threadWithEditorPosition) {
					elementsThreadsEditorPositionMap.set(child, threadWithEditorPosition);
				}
				if (elDataset.isActive) {
					activeIndex = elements.indexOf(child);
				}
			}
		}

		const ascending = activeIndex !== -1 ? elements.slice(activeIndex) : elements;
		const descending = activeIndex !== -1 ? elements.slice(0, activeIndex) : [];

		const containerTop = container.getBoundingClientRect().top;
		let baselineTop = undefined;
		let currentTop = 0;

		// Iterate over each thread and calculate its new position by taking into account
		// the position of the previously positioned threads
		for (const el of ascending) {
			const threadWithEditorPosition = elementsThreadsEditorPositionMap.get(el);

			if (threadWithEditorPosition) {
				const coords = editor.view.coordsAtPos(
					Math.min(threadWithEditorPosition.position.from, editor.view.state.doc.content.size - 1),
				);
				const rect = file_editor_rich_text_get_rect_from_coords(coords);
				currentTop = Math.max(currentTop, rect.top - containerTop);
			}

			if (baselineTop === undefined) {
				baselineTop = currentTop;
			}

			el.style.setProperty(
				"--lb-tiptap-anchored-threads-top" satisfies keyof FileEditorRichTextAnchoredThreads_CssVars,
				`${currentTop}px`,
			);

			const elHeight = elementsHeights.get(el) ?? 0;
			currentTop += elHeight;
		}

		// Iterate over elements above the active one and set their position by taking into account
		// the position of elements positioned below
		currentTop = baselineTop ?? 0;

		for (const el of descending.reverse()) {
			const elHeight = elementsHeights.get(el) ?? 0;
			currentTop -= elHeight;

			const threadWithEditorPosition = elementsThreadsEditorPositionMap.get(el);

			if (threadWithEditorPosition) {
				const coords = editor.view.coordsAtPos(
					Math.min(threadWithEditorPosition.position.from, editor.view.state.doc.content.size - 1),
				);
				const rect = file_editor_rich_text_get_rect_from_coords(coords);
				currentTop = Math.min(currentTop, rect.top - containerTop);
			}

			el.style.setProperty(
				"--lb-tiptap-anchored-threads-top" satisfies keyof FileEditorRichTextAnchoredThreads_CssVars,
				`${currentTop}px`,
			);
		}
	});

	useEffect(() => {
		if (!threadsEditorState?.threadPositions) return;
		const nextThreadsWithEditorPosition = Array.from(threadsEditorState.threadPositions, ([threadId, position]) => ({
			threadId,
			position,
		})).reduce((acc, { threadId, position }) => {
			const thread = threads.find((thread) => thread.id === threadId && !thread.isArchived);
			if (!thread) return acc;
			acc.push({ thread, position });
			return acc;
		}, [] as ThreadWithEditorPosition[]);
		setThreadsWithEditorPosition(nextThreadsWithEditorPosition);
	}, [threadsEditorState, threads]);

	useLayoutEffect(() => {
		handlePositionThreads();
	}, [threadsWithEditorPosition]);

	useLayoutEffect(() => {
		if (!container) return;

		const resizeObserver = new ResizeObserver(() => handlePositionThreads());

		const mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const addedNode of mutation.addedNodes) {
					if (addedNode instanceof HTMLElement) {
						resizeObserver.observe(addedNode);
					}
				}
			}
		});

		if (editor.view?.dom) {
			resizeObserver.observe(editor.view.dom);
		}
		for (const element of container.children) {
			resizeObserver.observe(element);
		}

		mutationObserver.observe(container, {
			childList: true,
		});

		return () => {
			mutationObserver.disconnect();
			resizeObserver.disconnect();
		};
	}, [container, editor]);

	if (!threadsEditorState) return null;

	return (
		<FileEditorRichTextAnchoredThreadsContext.Provider value={threadsEditorState}>
			<div
				{...rest}
				className={cn(className, "lb-tiptap-anchored-threads")}
				ref={setContainer}
				style={{
					position: "relative",
					...style,
				}}
			>
				{children}
			</div>
		</FileEditorRichTextAnchoredThreadsContext.Provider>
	);
}

FileEditorRichTextAnchoredThreads.useContext = () => {
	const context = use(FileEditorRichTextAnchoredThreadsContext);
	if (!context)
		throw new Error(
			"FileEditorRichTextAnchoredThreads.useContext must be used within a FileEditorRichTextAnchoredThreads component",
		);
	return context;
};
