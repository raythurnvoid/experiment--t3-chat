# Plugin backend execution checks

Use the published `raythurnvoid/bonobo-plugin-data-probe` fixture. Version 0.4.0 keeps
the response and PNG cases and adds scheduled permission checks. Version 0.3.0 added
the MCP fixture and skill. Publish through the normal reviewed-SHA flow. Keep existing
service accounts, grants, upload settings, and store docs when updating an installation.

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

## Scheduled permission checks

Use the exact installed source and [fixture README](../../../../plugins/bonobo-plugin-data-probe/README.md).
Keep the weekly interval of 10080 minutes and existing upload filters. The default `idle`
makes no API calls. The checks use public APIs and the selected user's real self-grant.

1. Seed one `write-500` document through the page and confirm it with Refresh. Use that
   saved `qa-<runId>` key in `kv-read-only` or `revoke-hold`.
2. For `kv-read-only`, first use a KV write grant as the control. Confirm read and write
   both return 200 and the diagnostic fails. Select a real read-only grant. Require a
   successful run with one KV read. Source checks require write and Files read to return
   403. A missing file path proves the scope check, not an existing file's access rule.
3. Check the user's actual role; a test account's name does not define it. A Viewer write
   grant request must refuse without changing consent. Restore any temporary role.
4. For `files-read`, reuse two small saved QA files. The installation account must read
   both; the selected user must read only the allowed folder. Run the owner control first,
   then require the same check to pass as the folder-only user. The file proof adds no access.
   Check the role and both root and leaf shares. A Member may have workspace-wide read
   access; use a temporary role without it when needed. Grant the account read access to
   both folders, and the user read access only to the allowed folder. Use that user's own
   consent form and file proof before assignment.
   Hash the bytes returned by the saved-file API. Rich-text Yjs reads can add a final LF
   that the saved bytes do not have. Compare privately; do not change the file to fix the hash.
   The owner control must reach the denied-file read with 200, then fail the named success
   check. With the same YAML, the user run must succeed with four finished calls: list 200,
   allowed read 200 with the expected bytes, denied read 404 `not_found`, and list 200.
   The reviewed fixture checks that the last list is empty. Save or assignment makes the
   schedule due now; select the fresh root created after that action, not an older result.
5. For `revoke-hold`, start the private, bounded runner log watch before saving settings.
   Confirm the new run is running and its `scheduled-waiting` KV marker exists. The selected
   user revokes their own grant during the real 30-second wait. Require the exact run's
   completed runner status 204, which the reviewed source returns only after both old-token
   requests return 401. Canceled history or a waiting marker alone does not prove those calls.
6. Compare complete history and call pages before and after assignment, revocation and
   rejoin. Old actor and grant IDs must stay. Restore `idle` and only owned QA changes.

If the live watch misses completion, use stored Workers Logs after an authorized login.
Open the Worker's Observability Events page through the dashboard. Search the exact run
ID and time window. The chart's Success count does not prove the plugin result. The
[query reply](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
keeps the console message in `result.events.events[].source`. Save only the matching
Worker, run ID, status, elapsed time, timestamp and artifact hashes. Match the hashes to
the published backend file before accepting 204. Keep request bodies and headers private.

Save full, safe JSON receipts outside the repo. Large console output can hide rows.
Use a new receipt name and keep failed checks. Never log tokens, raw provider data or
unrelated runner logs. Keep provider credentials on Convex, per `convex-admin-ops`.

After the Files check, disable the temporary installation and revoke each user's own
consent. Restore the original role before deleting a temporary role. Remove only owned
account grants and user shares, then undo only the restriction the check added. Compare
both roots and leaves with the saved baseline, plus file hashes and Yjs sequence IDs.
Restore the original policy entries. Uninstall only a disposable installation; normal
uninstall keeps finished history and its reusable service account. A retained account
must have no leftover QA grants. Leave existing plugin installations and data alone.

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
