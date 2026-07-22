# Gallery Plugin Page Playbook

Reusable recipes for driving the Gallery plugin page (`/w/:organizationName/:workspaceName/plugins/gallery/pages/gallery`) with Playwriter. The SPA runs inside the sandboxed iframe `.RoutePluginsPluginPage-frame` with an opaque origin — app-level locators do not reach it.

## Reaching the SPA document

`contentDocument` is null from the app document — the sandbox omits `allow-same-origin`, so the SPA runs in an opaque origin. Use the Playwright frame handle instead (CDP attaches per frame regardless of origin):

```js
const frame = state.page.frames().find((f) => f.url().includes("/plugins-ui/"));
const tiles = await frame.evaluate(() => document.querySelectorAll(".tile").length);
```

- The tab is often backgrounded: prefer `frame.evaluate()` DOM reads (`textContent`, `getComputedStyle`, counts) over snapshots/screenshots.
- Handshake completion signal: the SPA replaces the boot screen (`role="status"` "Connecting…") with the `.gallery` grid or an error (`role="alert"`).

## Gallery DOM map

- Grid: `.gallery-grid` containing `.tile` wrappers; each tile has an `<a class="tile-link" href="#/file/<nodeId>">` and reveals `.tile-name` on hover or `:focus-visible`.
- Failed tile: `.tile-placeholder.is-failed` plus a sibling real button `.tile-retry` (aria-label `Retry <name>`).
- Load more: `.button` with text `Load more`. It stays visible while buffered/pending work remains — including after a capped scan that found nothing yet (no false empty state).
- Item count: text `N items`; empty state text `No images or videos yet.` appears only at visible completion.
- Detail view (`#/file/<nodeId>`): `.viewer` with `.viewer-back` link, full-size `<img>` or `<video>`, `role="alert"` error + Retry button on media failure.
- Loading regions use `role="status"` / `aria-live="polite"`; all errors use `role="alert"`.

## Behavior contracts to verify after changes

- One "Load more" click exposes at most 12 new unique tiles; a dense 100-item source page buffers the overflow and later clicks drain the buffer without network calls (watch the network log for `/api/v1/files/list`).
- List requests send `limit: 100`, `kind: "file"`, `contentTypePrefixes: ["image/", "video/"]`; a 429 retries the same cursor after 3 s / 6 s.
- Initial media URLs coalesce into `/api/v1/files/download-urls` batches of at most 12 items. Batches and single-item renewals share one four-request queue and same-item in-flight deduplication.
- Media URLs renew once automatically per failure episode (expired signed URL → one silent renewal); repeated failure shows a Retry button; video renewal restores playback position and paused/playing state.
- Reduced motion: emulate `prefers-reduced-motion: reduce` and confirm the tile-pulse animation and hover transitions are off.
- Keyboard: tile links and buttons show a visible focus ring; tile labels appear on focus. Buttons keep a 44px minimum height.
- Narrow layout: check 360px and 390px viewports plus 200% zoom. The grid must not create required horizontal scrolling.

## Known hazards

- `fetch()` from the opaque-origin page to R2 fails by design (connect-src CSP) — probe media via element `readyState`/`naturalWidth`, not fetch.
- The extension relay does not support `Emulation.*` CDP methods: `page.emulateMedia()` and `page.unrouteAll()` fail. To restore real network after `page.route()` interception, register a later route with the same pattern that calls `route.continue()` (last-registered wins).
- Frame handles detach when the host startup deadline (or Retry) re-keys the iframe; `frame.evaluate` then throws "Execution context was destroyed". Re-find the frame each call and try/catch per frame — stale entries linger in `page.frames()`.
- Current SDK pages read the canonical host origin and fresh frame nonce from the URL fragment, then send nonce-bound ready immediately and every 500ms until init or page unload. The asset query stays empty, and the fragment is not sent in the asset request or referrer. The host alone owns the 15s startup deadline; Retry re-keys the iframe with a fresh fragment nonce and session.
- Canonical assets use `/plugins-ui/<versionId>/<path>`. Responses are immutable for the published plugin version, so any asset or header-policy change requires a plugin version bump and republish.
- A second iframe load disables the bridge and replaces the frame with a Retry error. Always re-find the frame after this state change; an already-started request cannot be inferred from DOM state alone.
- Cold scratch-profile Edge can starve media loads during the first ~60 s (extension sync); let the profile settle before judging thumbnail readyState.
