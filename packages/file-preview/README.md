# HTML file preview

This static site runs HTML file snapshots from Press. It uses native HTML, CSS, classic scripts, and module scripts. It has no auth, database, file API, or plugin bridge.

Press embeds this site on a separate origin with `sandbox="allow-scripts allow-same-origin"`. This site puts the HTML inside a second frame with `sandbox="allow-scripts"`. The inner frame has an opaque origin. It cannot read Press or the runtime page, use origin storage, or share storage with another preview.

`parse5` adds a status relay at the start of the document head. Complete, well-formed HTML keeps its native script order. Parsing can repair malformed markup before scripts run, so scripts that depend on parser repair may behave differently. Stored source is never changed. The relay is inside a function so its names do not clash with file scripts.

## Local use

Run commands from the repository root. Reuse any existing service on port 5175. Do not start a second copy or stop another user's server.

```powershell
vp env exec pnpm --dir packages/file-preview run build:local
vp env exec pnpm --dir packages/file-preview run preview:local
```

The runtime is `http://127.0.0.1:5175/v0`. Set the app's `VITE_FILE_PREVIEW_URL` to this URL. Port 5175 is fixed and fails if busy. The allowed local parents are exactly `http://localhost:5173` and `http://127.0.0.1:5173`.

Use the built preview server for QA. It reads its headers from `dist/_headers`, so a later environment change cannot silently replace the built policy. There is no HMR exception to the policy. Rebuild after editing runtime code.

## Messages

Import the shared contract from `bonobo-file-preview/protocol`.

Every host/runtime message has `protocol: "bonobo-file-preview"`, `version: 1`, `type`, and a UUID `sessionId`. After the outer frame's native load, Press sends `hello`. The runtime replies `ready` to that exact parent origin. Press then sends `load_html` with a UUID `loadId` and `html`.

The runtime returns `loaded` or `error` for the current load. Errors contain only a message of at most 500 characters. Both sides must check the exact window, origin, schema, session, and load. The source limit is 900,000 UTF-8 bytes. The runtime accepts one session per outer frame. A new load creates a new inner frame.

The inner frame uses the separate `bonobo-file-preview-document` status protocol. The runtime accepts it only from the current inner window, with origin `null` and the current load ID. It builds a new host status message rather than forwarding the child payload.

Press owns the load timeout, Retry, source selection, and frame teardown. Each source change, Refresh, or Retry creates a fresh outer frame. Hiding Preview removes the frame. Error text stays outside the frame. An error is not cleared by a later native load event from that document.

Status is advisory. File scripts can report their own status. A loaded document may still have asynchronous work running. Status must never grant access, save files, or start automatic AI repair.

## Security policy

`security.ts` builds both the exact parent allowlist and the HTTP headers. The build emits `_headers` for every asset and fallback path. The browser copies the runtime CSP into the inner `srcdoc` document.

- Scripts may be inline, from this runtime, or from `https://esm.sh`. `eval` is blocked.
- CSP limits fetch, XHR, WebSocket, and similar connections to esm.sh. Images and media may use runtime, data, or blob URLs. Fonts may use runtime or data URLs.
- Workers, objects, base URLs, and form actions are blocked. Frame URLs are limited to this runtime and blobs.
- Sandbox permissions omit top navigation, popups, downloads, forms, modals, and storage access.
- Referrers are disabled on both frames and by HTTP/meta policy. Camera, microphone, location, payment, and credential APIs are denied by Permissions Policy.
- Opener and origin isolation headers are retained. They do not impose CPU or memory limits.

esm.sh is a trusted external service. It receives module requests, and downloaded code can read the preview. Do not put private content in CDN URLs. This is not an offline or zero-leak guarantee. In Chromium, WebRTC can send STUN traffic despite this CSP and sandbox; camera and microphone denial does not block data channels. Use pinned browser-ready modules and visible loading/error states. Libraries that require extra permissions are outside this contract.

## Production build and hosting

Choose a dedicated HTTPS runtime host outside the app's cookie scope before deployment. The runtime must not share an origin with Press, Convex, R2 file delivery, or plugin assets. No production host is selected by this package.

Set `FILE_PREVIEW_PARENT_ORIGINS` to a comma-separated list of exact HTTPS Press origins, without paths, credentials, trailing slashes, or wildcards. The production build fails when this is missing or invalid. For example:

```powershell
$env:FILE_PREVIEW_PARENT_ORIGINS = 'https://your-press-host.example'
vp env exec pnpm --dir packages/file-preview run build
```

Update `wrangler.jsonc` with the approved deployment name and domain, then deploy it with the repo's Wrangler workflow. This package uses only Cloudflare Static Assets and SPA fallback. Do not add a Worker fetch handler without also attaching the security headers to every response it returns. Static `_headers` rules do not cover Worker-generated responses.

Set the app's `VITE_FILE_PREVIEW_URL` to the approved runtime's `/v0` URL. The app must reject a missing, invalid, or same-origin URL before mounting. HTTP is for the documented local origins only.

After deployment, read the actual HTTP headers for `/v0` and a missing path. Confirm the CSP, exact `frame-ancestors` origins, no-referrer policy, nosniff, and Permissions Policy. Then repeat the browser checks against the approved host. A successful local build does not prove deployment headers.

Rollback removes the Preview UI and runtime while keeping HTML text support, so newly created HTML files stay readable and editable.

## Checks

```powershell
vp env exec pnpm --dir packages/file-preview run typecheck
vp env exec pnpm --dir packages/file-preview run test:once
```

Browser checks use a fresh Chromium profile and actual runtime HTTP responses. Set `FILE_PREVIEW_TEST_RUN_DIR` to an absolute scratch folder under the personal sibling's `+ai/<task>-<date>/` directory. It must be outside the repository. Then run:

```powershell
vp env exec pnpm --dir packages/file-preview run test:browser
```

The test starts port 5175 only if it is unused, and closes only the server it started. It uses a test host at the approved local parent origin in a fresh browser profile. It grants local network access because the intercepted host response has no real network address. CSP and sandbox rules stay unchanged. It does not use the user's signed-in browser. Tests cover classic/module execution, a pinned d3 esm.sh chart, message checks, error bounds, storage/parent isolation, blocked network and navigation paths, and teardown. The tests use full Chromium because the bundled headless shell can crash on blocked blob navigation.

Sources: [Cloudflare Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/), [Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/), [CSP inheritance](https://www.w3.org/TR/CSP3/#security-inherit-csp), [srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc), [parse5](https://parse5.js.org/), [esm.sh](https://esm.sh/).
