# Plugin backend execution checks

Use the published `raythurnvoid/bonobo-plugin-data-probe` fixture. Version 0.2.1 contains
backend response cases and two PNG upload cases. Publish through the normal reviewed-SHA
flow, then update the installation. Keep existing service accounts, grants, settings, and store docs.

## Page checks

Open `/w/<organization>/<workspace>/plugins/data-probe/pages/data-probe`. Read the
frame URL and confirm its version ID before testing. The page has a `Response case`
select, a `Run` button, a status, and a short result summary. It does not print large
responses or credentials.

| Case | Check |
| --- | --- |
| JSON 200/400/409/500 | Outer 200 keeps the exact plugin status and message. |
| Empty 204 | Outer 200, plugin status 204, empty output. |
| Exact encoded 16 MiB | `encodedReplyBytes` is 16,777,216; verify the output hash. |
| Escaped text and Unicode | Same complete encoded limit; verify bytes and hash. |
| One byte over / raw limit over | A host error reaches the page with `response_too_large`. |
| Small body in one-byte chunks | Exact text hash; no dropped Unicode bytes. |
| Broken response stream | Failed run, no successful partial output. |
| Stalled response stream | Host stops near its 35-second deadline and removes run credentials. |
| Save, then 500 / throw | The test document remains after the run fails. |

Click `Refresh saved documents` to read the saved test keys. Also read the run, call
records, and stored document through Convex. Assert terminal status, no `apiTokenHash`
or `apiTokenExpiresAt`, settled calls, and the expected document revision. Never print
the token fields themselves. A successful HTTP status alone does not prove the writes were saved.

The real 16 MiB check must cross both Cloudflare and Convex. Local Node tests cannot
prove deployed memory capacity. A successful request is capacity evidence, not a peak
heap measurement.

## Upload checks

Use the current app's Files upload flow with two copies of the harness `shapes.png`:

- `noop-<unique-name>.png`: event status 204, succeeded, zero API calls and file writes.
- Another unique PNG name: event status 204, succeeded, one `plugin-data/write` call,
  zero file writes, and one `response_probes/qa-<runId>` document.

Keep the installation's configured folder filter in mind. Other installed media plugins
can receive the same upload; check the Data Probe run by installation and asset ID.
Clean up only task-created files and records. Never uninstall a preserved installation
to remove test records: uninstall deletes its store.

The plugin detail page's Uninstall button runs directly; do not wait for a confirmation
dialog. Wait for Install to appear, then verify the normal store/usage drain. For Chitchat
cleanup, open an existing thread through `.message-thread-summary`; a root with replies
does not have the separate Reply in thread button. Delete replies before their parent.

## Known tool and platform limits

- HMR can replace a frame between calls. Reacquire it from `page.frames()` before acting.
  Assert it exists before passing it to `auditAccessibility`; `undefined` audits the parent.
  Confirm the audit result's URL names the plugin frame.
- The existing Pages frontend is useful for stable invoke checks while localhost changes.
  It can lag behind current file-upload arguments. Use the current local frontend for uploads.
  Verify each tab's URL before writing, and do not reuse another agent's tab.
- In Playwriter 0.5.0, a scoped `snapshot({ locator })` can return the default tab's tree.
  Use `getCleanHTML({ locator })` to inspect the intended dialog or frame.
- If `pnpx` stalls on the package registry, reuse the installed Playwriter CLI through
  `vp env exec node <verified-package-path>/bin.js`. Find the path from the running relay
  or package metadata. Do not restart the shared relay to repair a registry timeout.
- Vitest 4.1.10 leaves `+` unescaped in browser `iframeId` URLs. Tests in a personal
  worktree can connect and then hang. `--project=browser --browser.isolate=false` avoids
  that path issue; report that the files shared a browser context. Keep caches local to
  the verification worktree.
- Data Probe 0.2.0 is not a valid saved-write or timeout fixture on this runner. Its
  `redirect: "error"` host request is refused, and its promise with no future event fails
  immediately as hung. Version 0.2.1 uses manual redirects with a non-2xx check and a
  cancellable 60-second timer. Browser-side SDK fetches have a different runtime.
- Host execution errors use HTTP 500 because the deployed `convex.site` edge replaces
  origin 502 bodies. Native checks confirmed that 500 preserves the message, run ID, and
  `response_too_large` code. Still check the actual page result when this path changes;
  a local JSON-response test cannot prove edge behavior.
  Cloudflare's [zone settings API](https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/get/)
  documents `origin_error_page_pass_thru` for keeping origin 502/504 bodies. Convex controls
  that zone. Do not claim the size-error code reached the page when it received a
  Cloudflare problem response instead.
