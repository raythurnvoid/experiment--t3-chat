# Gallery Plugin Page Playbook

Reusable recipes for driving the Gallery plugin page (`/w/:organizationName/:workspaceName/plugins/gallery/pages/gallery`) with Playwriter. The SPA runs inside the sandboxed iframe `.PluginsUiFrame` on the Convex asset/API origin. That origin differs from the app, so app-level locators do not reach it.

## Reaching the SPA document

`contentDocument` is null from the app document because the app and iframe use different origins. Use the Playwright frame handle instead (CDP attaches per frame regardless of origin):

```js
const frame = state.page.frames().find((f) => f.url().includes("/plugins-ui/"));
const tiles = await frame.evaluate(() => document.querySelectorAll(".tile").length);
```

- The tab is often backgrounded: prefer `frame.evaluate()` DOM reads (`textContent`, `getComputedStyle`, counts) over snapshots/screenshots.
- Handshake completion signal: the SPA replaces the boot screen (`role="status"` "Connecting…") with the `.gallery` grid or an error (`role="alert"`).
- Public API requests are same-origin inside the frame. A normal JSON request with `Authorization` must produce one `POST` and no CORS `OPTIONS` request.

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

- `fetch()` from the plugin page to R2 fails by design because CSP limits `connect-src` to the Convex origin. Probe media via element `readyState`/`naturalWidth`, not fetch.
- The extension relay does not support `Emulation.*` CDP methods: `page.emulateMedia()` and `page.unrouteAll()` fail. To restore real network after `page.route()` interception, register a later route with the same pattern that calls `route.continue()` (last-registered wins).
- Routes added after the plugin iframe exists can intercept its later API fetches, but cached immutable plugin assets may bypass them. Do not rewrite the iframe document with `context.route()` plus `route.fetch()` / `route.fulfill()` to force a different asset: this killed the Windows relay and lost the session in two separate runs. Test a candidate bundle in a local top-level preview, or publish a new plugin version for a real iframe comparison.
- Frame handles detach when the host startup deadline, Retry, or client navigation re-keys the iframe; `frame.evaluate` then throws "Execution context was destroyed". Re-find the frame each call. Stale entries linger in `page.frames()`, so after navigation use `page.frames().filter((frame) => frame.url().includes("/plugins-ui/")).at(-1)` instead of `find(...)`, which returns the oldest stale frame.
- Current SDK pages read the canonical host origin and fresh frame nonce from the URL fragment, then send nonce-bound ready immediately and every 500ms until init or page unload. The asset query stays empty, and the fragment is not sent in the asset request or referrer. The host alone owns the 15s startup deadline; Retry re-keys the iframe with a fresh fragment nonce and session.
- Canonical assets use `/plugins-ui/<versionId>/<path>`. Responses are immutable for the published plugin version, so any asset or header-policy change requires a plugin version bump and republish.
- A second iframe load disables the bridge and replaces the frame with a Retry error. Always re-find the frame after this state change; an already-started request cannot be inferred from DOM state alone.
- Cold scratch-profile Edge can starve media loads during the first ~60 s (extension sync); let the profile settle before judging thumbnail readyState.

## Testing a plugin API boundary with a real session token

Use this when a check needs a genuine plugin credential. A forged `plu_`/`plr_` token only ever proves
the 401 path, so it cannot tell "no credential" apart from "valid credential, capability not granted".

The SDK keeps its token in module scope, so it is not on `window` and cannot be read out of the frame.
Capture the host's `bonobo:init` message instead. The init script has to be installed before the frame
loads, so add it and then reload:

```js
await state.page.addInitScript(() => {
	window.__capturedInit = null;
	window.addEventListener("message", (event) => {
		const data = event.data;
		if (data && typeof data === "object" && data.type === "bonobo:init") {
			window.__capturedInit = data;
		}
	});
});
await state.page.reload({ waitUntil: "domcontentloaded" });
```

Then call the API from inside the frame. The frame is same-origin with `/api/v1/*`, so the request goes
out without a preflight, exactly as the plugin's own code would send it:

```js
const frame = state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1);
const result = await frame.evaluate(async () => {
	const token = window.__capturedInit.token;
	const response = await fetch("/api/v1/plugin-data/write", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ collection: "probe", key: "probe", value: {} }),
	});
	return { status: response.status, body: (await response.text()).slice(0, 140) };
});
```

Rules:

- Never print the token, and never write it to a file. Return the status and body only. `token.slice(0, 4)`
  is enough to confirm you captured a `plu_` and not something else.
- Always pair a refusal with a positive control in the same frame and the same moment: call a route the
  installation did consent to and show it returns 200. Without it, a 403 could equally be an expired
  session or a bad route, and the check proves nothing about the capability gate.
- Finish by reading the target tables back through `convex data`. "Refused" and "wrote nothing" are two
  separate claims, and only the readback settles the second one.
- Observed 2026-08-14 against the Gallery installation, which consents to `workspace.files.read` only:
  `/api/v1/files/list` returned 200 while all four `/api/v1/plugin-data/*` routes returned 403
  `Permission denied` for the same token.
