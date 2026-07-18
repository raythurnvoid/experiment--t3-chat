---
name: custom-global-events
description: Use when adding or changing app-wide custom events, or when subscribing to native window events through global-event.tsx. Covers the typed global_custom_event_* API, useGlobalCustomEvent, and the separate global_event_* native DOM listener helpers.
---

# Keep App And Native Events Separate

The module has two separate APIs. Do not mix them.

# App Custom Events

Declare each app custom event in the map owned by `global_custom_event_Event` in [global-event.tsx](../../../packages/app/src/lib/global-event.tsx). The map is currently empty.

This is a template, not a registered current event:

```ts
export class global_custom_event_Event extends XCustomEvent<{
	"feature::changed": {
		id: string;
	};
}> {}
```

Use these helpers for app custom events:

- `global_custom_event_dispatch`
- `global_custom_event_listen`
- `useGlobalCustomEvent`

Handlers receive the typed event object. Read the payload from `event.detail`.

```ts
global_custom_event_dispatch("feature::changed", { id: "example" });

useGlobalCustomEvent("feature::changed", (event) => {
	console.info(event.detail.id);
});
```

For non-React lifecycle control:

```ts
const controller = new AbortController();

const cleanup = global_custom_event_listen(
	"feature::changed",
	(event) => {
		console.info(event.detail.id);
	},
	{ signal: controller.signal },
);

controller.abort();
cleanup();
```

Keep custom keys centralized in `global_custom_event_Event`. Do not dispatch ad hoc `CustomEvent` strings elsewhere.

No app custom-event keys are currently registered, so production use does not establish a naming convention. For a new typed custom event, use `module::event_name` as the project's recommended convention unless the user defines another convention for that feature.

# Native Window Events

Use the non-custom helpers only for built-in DOM events typed by `GlobalEventHandlersEventMap`:

- `global_event_listen`
- `global_event_listen_all`
- `useGlobalEvent`
- `useGlobalEventList`

```ts
useGlobalEvent("keydown", (event) => {
	console.info(event.key);
});

useGlobalEventList(["pointerdown", "focusin"], (event) => {
	console.info(event.type);
});
```

Current native-event consumers include:

- [files-sidebar.tsx](../../../packages/app/src/components/files/files-sidebar.tsx)
- [file-editor-comments-sidebar.tsx](../../../packages/app/src/components/files/file-editor/file-editor-comments-sidebar.tsx)
- [file-editor-rich-text.tsx](../../../packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text.tsx)

# Implementation References

- Typed event base: `XCustomEvent` in [utils.ts](../../../packages/app/src/lib/utils.ts)
- Stale-closure-safe hook helper: `useLiveRef` in [utils-hooks.ts](../../../packages/app/src/hooks/utils-hooks.ts)
