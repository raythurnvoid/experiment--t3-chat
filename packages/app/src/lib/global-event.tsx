/*
Global custom events are used for cross-component communication without React context dependencies,
allowing for simple function calls to trigger events across different parts of the application.

They can be used also to listen and dispatch events outside of React components.
*/

import { useEffect } from "react";
import { useLiveRef } from "../hooks/utils-hooks.ts";
import type { app_convex_Id } from "./app-convex-client.ts";
import { XCustomEvent } from "./utils.ts";

// #region custom events
export class global_custom_event_Event extends XCustomEvent<{
	"ai_chat::open_canvas": {
		pageId: app_convex_Id<"pages">;
		mode: "diff" | "editor";
		modifiedContent?: string;
		threadId: string;
	};
	"ai_chat::open_canvas_by_path": {
		path: string;
	};
}> {}

declare global {
	interface Window {
		addEventListener<K extends keyof global_custom_event_Event["__map"]>(
			event: K,
			listener: (event: global_custom_event_Event["__map"][K]) => void,
			options?: AddEventListenerOptions,
		): void;

		removeEventListener<K extends keyof global_custom_event_Event["__map"]>(
			event: K,
			listener: (event: global_custom_event_Event["__map"][K]) => void,
			options?: EventListenerOptions,
		): void;
	}
}

export function global_custom_event_dispatch<K extends keyof global_custom_event_Event["__map"]>(
	event: K,
	payload: global_custom_event_Event["__map"][K]["detail"],
) {
	window.dispatchEvent(new global_custom_event_Event(event, { detail: payload }));
}

export function global_custom_event_listen<K extends keyof global_custom_event_Event["__map"]>(
	event: K,
	handler: (event: global_custom_event_Event["__map"][K]) => void,
	options?: { signal?: AbortSignal },
) {
	window.addEventListener(event, handler, options);

	return function cleanup() {
		window.removeEventListener(event, handler);
	};
}

export function useGlobalCustomEvent<K extends keyof global_custom_event_Event["__map"]>(
	name: K,
	handler: (event: global_custom_event_Event["__map"][K]) => void,
) {
	const handlerRef = useLiveRef(handler);

	useEffect(() => {
		return global_custom_event_listen(name, (event) => handlerRef.current(event));
	}, [name]);
}
// #endregion custom events

// #region global events
export function global_event_listen<K extends keyof GlobalEventHandlersEventMap>(
	event: K,
	handler: (event: GlobalEventHandlersEventMap[K]) => void,
	options?: AddEventListenerOptions,
) {
	window.addEventListener(event, handler, options);

	return function cleanup() {
		window.removeEventListener(event, handler, options);
	};
}

export function global_event_listen_all<K extends keyof GlobalEventHandlersEventMap>(
	events: K[],
	handler: (event: GlobalEventHandlersEventMap[K]) => void,
	options?: AddEventListenerOptions,
) {
	events.forEach((event) => {
		window.addEventListener(event, handler, options);
	});

	return function cleanup() {
		events.forEach((event) => {
			window.removeEventListener(event, handler, options);
		});
	};
}

export function useGlobalEvent<K extends keyof GlobalEventHandlersEventMap>(
	event: K,
	handler: (event: GlobalEventHandlersEventMap[K]) => void,
	options?: AddEventListenerOptions,
) {
	const handlerRef = useLiveRef(handler);

	useEffect(() => {
		return global_event_listen(event, (e) => handlerRef.current(e), options);
	}, [event]);
}

export function useGlobalEventList<K extends keyof GlobalEventHandlersEventMap>(
	events: K[],
	handler: (event: GlobalEventHandlersEventMap[K]) => void,
	options?: AddEventListenerOptions,
) {
	const handlerRef = useLiveRef(handler);

	useEffect(() => {
		return global_event_listen_all(events, (e) => handlerRef.current(e), options);
	}, [events]);
}
// #endregion global events
