# Gallery Plugin Page Playbook

Reusable recipes for driving the Gallery plugin page (`/w/:organizationName/:workspaceName/plugins/gallery/pages/gallery`) with Playwriter. The SPA runs inside the sandboxed iframe `.RoutePluginsPluginPage-frame` with an opaque origin — app-level locators do not reach it.

## Reaching the SPA document

`contentDocument` is null from the app document — the sandbox omits `allow-same-origin`, so the SPA runs in an opaque origin. Use the Playwright frame handle instead (CDP attaches per frame regardless of origin):

```js
const frame = state.page.frames().find((f) => f.url().includes("/plugins-ui/"));
const tiles = await frame.evaluate(() => document.querySelectorAll(".tile").length);
```

- The tab is often backgrounded: prefer `frame.evaluate()` DOM reads (`textContent`, `getComputedStyle`, counts) over snapshots/screenshots.
- Handshake completion signal: the SPA replaces the boot screen (`role="status"` "Loading gallery…") with the `.gallery` grid or an error (`role="alert"`).

## Gallery DOM map (v0.1.3+ layout)

- Grid: `.grid` containing `.tile` wrappers; each tile has an `<a class="tile-link" href="#/file/<nodeId>">` and reveals `.tile-name` on hover or `:focus-visible`.
- Failed tile: `.tile-placeholder.is-failed` plus a sibling real button `.tile-retry` (aria-label `Retry <name>`).
- Load more: `.button` with text `Load more`. It stays visible while buffered/pending work remains — including after a capped scan that found nothing yet (no false empty state).
- Item count: text `N items`; empty state text `No images or videos yet.` appears only at visible completion.
- Detail view (`#/file/<nodeId>`): `.viewer` with `.viewer-back` link, full-size `<img>` or `<video>`, `role="alert"` error + Retry button on media failure.
- Loading regions use `role="status"` / `aria-live="polite"`; all errors use `role="alert"`.

## Behavior contracts to verify after changes

- One "Load more" click exposes at most 12 new unique tiles; a dense 100-item source page buffers the overflow and later clicks drain the buffer without network calls (watch the network log for `/api/v1/files/list`).
- List requests send `limit: 100`, `kind: "file"`, `contentTypePrefixes: ["image/", "video/"]`; a 429 retries the same cursor after 3 s / 6 s.
- Media URLs renew once automatically per failure episode (expired signed URL → one silent renewal); repeated failure shows a Retry button; video renewal restores playback position and paused state.
- Reduced motion: emulate `prefers-reduced-motion: reduce` and confirm the tile-pulse animation and hover transitions are off.
- Keyboard: tile links and buttons show a visible focus ring; tile labels appear on focus.

## Known hazards

- `fetch()` from the opaque-origin page to R2 fails by design (connect-src CSP) — probe media via element `readyState`/`naturalWidth`, not fetch.
- The extension relay does not support `Emulation.*` CDP methods: `page.emulateMedia()` and `page.unrouteAll()` fail. To restore real network after `page.route()` interception, register a later route with the same pattern that calls `route.continue()` (last-registered wins).
- Frame handles detach when the host startup deadline (or Retry) re-keys the iframe; `frame.evaluate` then throws "Execution context was destroyed". Re-find the frame each call and try/catch per frame — stale entries linger in `page.frames()`.
- The SDK posts `bonobo:ready` exactly once with no retry; a lost handshake surfaces as the host's 15 s deadline alert, and clicking Retry re-keys the iframe for a fresh attempt.
- Asset responses are pinned per versionId by Cloudflare for their immutable TTL. Asset/header changes need a version bump + republish; re-curling old URLs proves nothing.
- Cold scratch-profile Edge can starve media loads during the first ~60 s (extension sync); let the profile settle before judging thumbnail readyState.
