# R2 File Content Regression

Goal: validate the unified R2-backed file-content flows after the asset-first refactor.

Route: an already-open Playwriter-enabled `/w/:organizationName/:workspaceName/files` tab.

## Scope

Use this playbook together with the backend test suite. It covers the user-facing flows that can regress when Markdown, Yjs snapshots, uploads, comments, and agent edits move through R2 assets.

## Preflight

1. Confirm the dev app is already running and a `/files` tab is open.
2. Run `vp env exec pnpx playwriter skill` before using Playwriter and read its full output.
3. Create a Playwriter session and install the app harness:

```powershell
vp env exec pnpx playwriter browser list
$browserKey = "<exact KEY from browser list>"
$sessionOutput = vp env exec pnpx playwriter session new --browser $browserKey
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
vp env exec pnpx playwriter -s $session -f "C:/Users/rt0/Documents/workspace/rt0/t3-chat/.agents/skills/app-playwriter-harness/scripts/install-harness.js"
vp env exec pnpx playwriter -s $session -e 'await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/files" }); console.log(await state.appPlaywriterHarness.observe({ label: "files tab", search: /Files|Agent|Comments|Toolbar|Upload|New file|New folder/i }));'
```

4. Use one unique folder per run, for example `aaa-pw-r2-<timestamp>`, and archive it during cleanup.
5. Keep screenshots and logs only when a step fails or shows suspicious behavior.

## Automated Verification

Run these before browser QA:

```powershell
vp env exec pnpm --dir packages/app exec vitest run convex/files_nodes.test.ts convex/r2.test.ts convex/files_pending_updates.test.ts convex/data_deletion.test.ts src/lib/files-yjs-provider.test.ts
vp env exec pnpm --dir packages/app run test:once
vp env exec pnpm --dir packages/r2-upload-finalizer test
vp env exec pnpm --dir packages/app run lint
```

Expected result: all commands pass. If the full app test or lint command fails, capture the first failing test/file and stop browser QA only when the failure prevents the app from loading.

## File Tree And Markdown Creation

1. Open the root files view or the currently selected folder browser.
2. Create `aaa-pw-r2-<timestamp>` with `New folder`.
3. Open the new folder and verify the `File actions` toolbar exposes `New file` and `New folder`. `Upload file` is not in that toolbar — it is a sidebar `More options` menu item.
4. Create `server-seeded-<timestamp>.md`.
5. Open the file and verify it mounts the rich text editor without client-side bootstrap fallback.
6. Type a unique token such as `r2-playwriter-token-<timestamp>`.
7. Switch between rich text, plain text, and diff/review modes when available; verify the token stays visible or the review surface opens cleanly.
8. Reload the page and verify the token is still present after the Yjs snapshot is fetched from R2.

Expected result: the Markdown node opens as an editable file, the server-owned initial content is present, edits persist after save/reload, and no console/page errors mention missing `assetId`, `r2Key`, or `snapshotUpdate`. Since 2026-08-10 Markdown is one of 20 editable text extensions — the other 19 (`.json`, `.yaml`, ...) open in the Monaco plain editor instead of the rich editor — but this flow's rich-editor steps stay `.md`-specific.

## Duplicate, Rename, Move, Drag/Drop, Archive, Unarchive

1. Try to create the same `server-seeded-<timestamp>.md` again in the same folder.
2. Verify duplicate-name validation blocks creation.
3. Rename the file to `renamed-server-seeded-<timestamp>.md`.
4. Move the file to a nested folder with the available move/drag/drop UI.
5. Drag the file back to the run folder using real Playwright mouse movement over visible rows.
6. Archive the file and verify it disappears from active rows.
7. Unarchive it from the archive/trash UI if exposed in the current build, then reopen it.

Expected result: path operations update the tree and routing without losing editor content, comments, or R2-backed snapshots. If unarchive UI is not reachable in the current tab, record the blocker and rely on backend coverage for that branch.

## Uploads And Generated Markdown Siblings

1. Select the run folder before uploading.
2. Upload `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`. For the direct PUT checks below, capture this first upload before selecting the file.
3. Verify a normal source file node appears immediately.
4. Open it and verify the stored-file panel shows waiting/processing. The asset's `r2Key` confirms stored bytes; `processingWorkId` tracks host processing. Neither alone proves the PDF plugin finished.
5. Wait for conversion when R2 events, the finalizer, and the PDF plugin are configured. The workspace must have the PDF plugin installed, its upload trigger must include this folder, and its Modal settings must be ready.
6. Verify `r2-upload-sample.pdf.md` appears as an ordinary sibling and opens in the rich text editor. The PDF node keeps its stored-file panel.
7. Upload the same PDF again in the same folder.
8. Rename in the conflict modal's `Filename` input and submit `Upload` (the destructive alternative is `Replace`); verify the renamed source node appears.
9. Test `Replace` and verify the active source node is replaced while the previous active source is archived.
10. Upload `.agents/skills/app-playwriter-harness/assets/files/r2-upload-markdown-sample.md` and verify it becomes a normal editable Markdown node, not a source conversion panel. Since 2026-08-10 the other 19 editable text extensions convert the same way: upload `qa-plain.yaml` (pinned fixture, see `files.md`) and verify it becomes an editable plain-text document in Monaco, not a stored card.

Expected result: each upload attempt uses a fresh asset-id R2 key and a direct, signed create-only PUT. PDF plugin output is a regular Markdown sibling. Editable text uploads (Markdown plus the 19 plain-text extensions) become editable nodes, and duplicate PDF paths follow the collision UI.

### Direct PUT, Repeated URL, And Signed Headers

Keep signed URLs in Playwriter `state` memory only. Never print or save raw requests, URLs, or error bodies. Run these snippets from personal `+ai` runner files with `-f`. This recipe needs the current backend and R2 CORS rules deployed.

1. Select the run folder. Inspect the sidebar inputs and confirm `.FilesSidebar input[type=file]:not([webkitdirectory])` matches the single-file input. Under a Windows relay, use `setInputFiles` first; use the fallback in `known-hazards.md` only after an actual failure.
2. Capture the native PUT while uploading the PDF fixture. Do not call a finalize mutation from the probe:

```js
state.r2Put = state.page.waitForRequest((request) => {
  const url = new URL(request.url());
  return request.method() === "PUT" && url.pathname.includes("/assets/") && url.searchParams.has("X-Amz-Signature");
});
await state.page.locator(".FilesSidebar input[type=file]:not([webkitdirectory])").setInputFiles("C:/Users/rt0/Documents/workspace/rt0/t3-chat/.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf");
state.r2Request = await state.r2Put;
state.r2Upload = {
  url: state.r2Request.url(),
  headers: Object.fromEntries(["content-type", "if-none-match"].map((name) => [name, state.r2Request.headers()[name]])),
};
console.log({ status: (await state.r2Request.response())?.status(), createOnly: state.r2Upload.headers["if-none-match"] === "*", conditionSigned: new URL(state.r2Upload.url).searchParams.get("X-Amz-SignedHeaders")?.split(";").includes("if-none-match") });
```

3. Require a successful native PUT and both header checks to be true. Record the node id and asset id through read-only app readback. Wait for the normal R2 event to publish `r2Key` and for the PDF to be downloadable. Save its byte hash for comparison.
4. Before the URL expires, run this browser probe once for each mode: `repeat`, `omit`, and `change`. Browser `fetch` exercises R2 CORS; a server-side fetch does not.

```js
console.log(await state.page.evaluate(async ({ upload, mode }) => {
  const headers = { ...upload.headers };
  if (mode === "omit") delete headers["if-none-match"];
  if (mode === "change") headers["if-none-match"] = '"different-etag"';
  try {
    const response = await fetch(upload.url, { method: "PUT", headers, body: "different upload bytes" });
    const error = new DOMParser().parseFromString(await response.text(), "application/xml");
    return { status: response.status, code: error.querySelector("Code")?.textContent ?? null };
  } catch {
    return { status: null, error: "browser_fetch_failed" };
  }
}, { upload: state.r2Upload, mode: "repeat" }));
```

5. `repeat` must return 412. `omit` and `change` must fail signature/auth checks (403). Verified on 2026-09-07: the valid repeated PUT returned 412 in the browser, but the two signature-error responses lacked `Access-Control-Allow-Origin`, so browser `fetch` threw. Playwriter sandbox `fetch` confirmed 403 for both, and the original content stayed unchanged. A CORS error alone does not prove signature enforcement. If the browser probe throws, confirm the statuses outside `page.evaluate`, using the same memory-only URL:

```js
const statuses = [];
for (const mode of ["omit", "change"]) {
  const headers = { ...state.r2Upload.headers };
  if (mode === "omit") delete headers["if-none-match"];
  if (mode === "change") headers["if-none-match"] = '"different-etag"';
  try {
    const response = await fetch(state.r2Upload.url, { method: "PUT", headers, body: "different upload bytes" });
    await response.body?.cancel();
    statuses.push({ mode, status: response.status });
  } catch {
    statuses.push({ mode, status: null });
  }
}
console.log(statuses);
if (statuses.some(({ status }) => status !== 403)) throw new Error("Signature rejection was not confirmed");
```

This fallback confirms R2 rejection; it does not test browser CORS. A 412 from an invalid-header probe is not a pass. Keep only status/error codes in the report, and record a blocker if no 403 can be confirmed before the URL expires.

6. Verify the same node and asset remain, then download again and compare the bytes with the first download and fixture. A 412 means an object already exists; it does not prove the new body matches it. This manual probe checks R2 and node persistence. Focused client tests check that the sidebar/embed 412 branch preserves the node and waits for normal readiness.
7. Repeat the upload through the native input and choose `Replace`. Verify a new active node and asset at the path, the old node has `archiveOperationId`, and its old bytes remain readable. Delete the signed URL/request fields from `state` after the checks.

## Comments

1. Open the edited Markdown file.
2. Select editor text and click `Comment`.
3. Submit a root comment containing `comment-r2-<timestamp>`.
4. Open the comments sidebar and verify the thread appears.
5. Add a reply, reload, reopen the thread, and verify both messages remain.
6. If the Markdown file came from the PDF plugin, verify comments attach to that Markdown sibling's node.

Expected result: comments remain visible after reload and route changes.

## Agent Panel

1. Open the `Agent` tab while the edited Markdown file is selected.
2. Ask the agent to search for the unique token, read the matching file, and make a small edit that adds another unique token.
3. Verify tool disclosures include search/read/edit behavior.
4. Review the pending edit through `[data-testid="review-changes-button"]` and apply it.
5. Verify the editor shows the agent-created token and the pending-edit banner clears.

Expected result: agent search/read/edit use the R2-aware Markdown helpers and pending updates save through the current materialization flow. If the local agent backend or model credentials are unavailable, record the exact UI/backend error.

## Snapshot And Download Checks

1. Open snapshot history for the edited Markdown file when visible.
2. Preview a snapshot and verify content is read from R2.
3. Restore a snapshot and verify the editor reloads to restored content.
4. Download the Markdown file and verify the browser receives a signed URL-backed download.
5. Download the uploaded PDF source after its asset has `r2Key`.

Expected result: snapshot preview/restore and downloads use asset-backed R2 URLs and materialize stale Markdown before download.

## Cleanup

1. Archive `aaa-pw-r2-<timestamp>` and any renamed upload/source artifacts created during the run.
2. Failed PUT probes can add signed URLs to browser logs. Use `getLatestLogs` directly and sanitize its URL text before printing or saving it. The harness `latestLogs()` wrapper logs the raw result:

```js
const logs = await getLatestLogs({ page: state.page, search: /error|warn|fail|cors/i });
console.log(logs.map((line) => line.replace(/https?:\/\/[^\s"'<>]+/g, "[redacted URL]")));
```

3. Record skipped steps with the real blocker, not as pass.

## Failure Triage

- If a click fails, inspect the target and hit-test before retrying; do not use force clicks or `dispatchEvent` to bypass UI behavior.
- If upload conversion does not complete, check whether R2 events, the upload-finalizer Worker, Modal, and Convex env vars are configured for the local app.
- If agent search/edit does not run, record whether the failure is auth, model credentials, tool-call UI, or pending-update application.
- If initial Markdown content is missing after reload, inspect Liveblocks/Yjs logs first because the provider snapshot fetch path is sensitive.
