/*
Global custom events are used for cross-component communication without React context dependencies,
allowing for simple function calls to trigger events across different parts of the application.

They can be used also to listen and dispatch events outside of React components.
*/

import { useEffect } from "react";
import { useLiveRef } from "../hooks/utils-hooks.ts";
import type { app_convex_Id } from "./app-convex-client.ts";
import { XCustomEvent } from "./utils.ts";

export class global_event_Event extends XCustomEvent<{
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
		addEventListener<K extends keyof global_event_Event["__map"]>(
			event: K,
			listener: (event: global_event_Event["__map"][K]) => void,
			options?: AddEventListenerOptions,
		): void;

		removeEventListener<K extends keyof global_event_Event["__map"]>(
			event: K,
			listener: (event: global_event_Event["__map"][K]) => void,
			options?: EventListenerOptions,
		): void;
	}
}

export function global_event_dispatch<K extends keyof global_event_Event["__map"]>(
	event: K,
	payload: global_event_Event["__map"][K]["detail"],
) {
	window.dispatchEvent(new global_event_Event(event, { detail: payload }));
}

export function global_event_listen<K extends keyof global_event_Event["__map"]>(
	event: K,
	handler: (event: global_event_Event["__map"][K]) => void,
	options?: { signal?: AbortSignal },
) {
	window.addEventListener(event, handler, options);

	return function cleanup() {
		window.removeEventListener(event, handler);
	};
}

export function useGlobalEvent<K extends keyof global_event_Event["__map"]>(
	name: K,
	handler: (event: global_event_Event["__map"][K]) => void,
) {
	const handlerRef = useLiveRef(handler);

	useEffect(() => {
		const cleanup = global_event_listen(name, handlerRef.current);
		return cleanup;
	}, [name]);
}
