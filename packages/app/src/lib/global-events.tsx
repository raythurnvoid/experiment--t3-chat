/*
Global events are used for cross-component communication without React context dependencies,
allowing for simple function calls to trigger events across different parts of the application.

They can be used also to listen and dispatch events outside of React components.
*/

import { useEffect } from "react";
import { useLiveRef } from "../hooks/utils-hooks.ts";
import type { app_convex_Id } from "./app-convex-client.ts";

// #region Core
type Key = "ai_chat::open_canvas" | "ai_chat::open_canvas_by_path";

type CleanupFn = () => void;

type HandlerFn = (...args: any[]) => void;

type GlobalEventOptions = {
	signal?: AbortSignal;
};

export namespace global_event {
	export function dispatch(eventName: Key, payload?: any) {
		const domEvent = new CustomEvent(eventName, { detail: payload });
		window.dispatchEvent(domEvent);
	}

	export function listen(eventName: Key, handler: (payload?: any) => void, options?: { signal?: AbortSignal }) {
		function listener(e: Event) {
			const event = e as CustomEvent<any>;
			handler(event.detail);
		}

		window.addEventListener(eventName, listener, options);

		return function cleanup() {
			window.removeEventListener(eventName, listener);
		};
	}
}

export function useGlobalEvent<Handler extends HandlerFn>(listenFn: (handler: Handler) => CleanupFn, handler: Handler) {
	const handlerRef = useLiveRef(handler);

	useEffect(() => {
		const cleanup = listenFn(((...args) => {
			handlerRef.current(...args);
		}) as Handler);

		return cleanup;
	}, []);
}
// #endregion Core

// Extended payload supports opening in diff mode with an optional modified seed
type global_event_ai_chat_open_canvas_Payload = {
	pageId: app_convex_Id<"pages">;
	mode: "diff" | "editor";
	modifiedContent?: string;
	threadId: string;
};

export namespace global_event_ai_chat_open_canvas {
	export function listen(
		handler: (payload: global_event_ai_chat_open_canvas_Payload) => void,
		options?: GlobalEventOptions,
	) {
		return global_event.listen("ai_chat::open_canvas", handler, options);
	}

	export function dispatch(payload: global_event_ai_chat_open_canvas_Payload) {
		return global_event.dispatch("ai_chat::open_canvas", payload);
	}
}

// Open canvas by path. Canvas will resolve the pageId from Convex and open the editor.
type global_event_ai_chat_open_canvas_by_path_Payload = {
	path: string;
};

export namespace global_event_ai_chat_open_canvas_by_path {
	export function listen(
		handler: (payload: global_event_ai_chat_open_canvas_by_path_Payload) => void,
		options?: GlobalEventOptions,
	) {
		return global_event.listen("ai_chat::open_canvas_by_path", handler, options);
	}

	export function dispatch(payload: global_event_ai_chat_open_canvas_by_path_Payload) {
		return global_event.dispatch("ai_chat::open_canvas_by_path", payload);
	}
}
