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
vp env exec pnpx playwriter -s $session --% -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/files' }); await state.appPlaywriterHarness.observe({ label: 'files tab', search: /Files|Agent|Comments|Toolbar|Upload|New file|New folder/i });"
```

4. Use one unique folder per run, for example `aaa-pw-r2-<timestamp>`, and archive it during cleanup.
5. Keep screenshots and logs only when a step fails or shows suspicious behavior.

## Automated Verification

Run these before browser QA:

```powershell
vp env exec pnpm --dir packages/app exec vitest run convex/files_nodes.test.ts convex/r2.test.ts convex/files_pending_updates.test.ts convex/data_deletion.test.ts src/lib/liveblocks-yjs-provider.test.ts
vp env exec pnpm --dir packages/app run test:once
vp env exec pnpm --dir packages/r2-upload-finalizer test
vp env exec pnpm --dir packages/app run lint
```

Expected result: all commands pass. If the full app test or lint command fails, capture the first failing test/file and stop browser QA only when the failure prevents the app from loading.

## File Tree And Markdown Creation

1. Open the root files view or the currently selected folder browser.
2. Create `aaa-pw-r2-<timestamp>` with `New folder in current folder`.
3. Open the new folder and verify the empty-folder toolbar exposes `New file in current folder`, `New folder in current folder`, and `Upload file`.
4. Create `server-seeded-<timestamp>.md`.
5. Open the file and verify it mounts the rich text editor without client-side bootstrap fallback.
6. Type a unique token such as `r2-playwriter-token-<timestamp>`.
7. Switch between rich text, plain text, and diff/review modes when available; verify the token stays visible or the review surface opens cleanly.
8. Reload the page and verify the token is still present after the Yjs snapshot is fetched from R2.

Expected result: the Markdown node opens as an editable file, the server-owned initial content is present, edits persist after save/reload, and no console/page errors mention missing `assetId`, `r2Key`, `snapshotUpdate`, or `markdownContentId`.

## Duplicate, Rename, Move, Drag/Drop, Archive, Unarchive

1. Try to create the same `server-seeded-<timestamp>.md` again in the same folder.
2. Verify duplicate-name validation blocks creation.
3. Rename the file to `renamed-server-seeded-<timestamp>.md`.
4. Move the file to a nested folder with the available move/drag/drop UI.
5. Drag the file back to the run folder using real Playwright mouse movement over visible rows.
6. Archive the file and verify it disappears from active rows.
7. Unarchive it from the archive/trash UI if exposed in the current build, then reopen it.

Expected result: path operations update the tree and routing without losing editor content, comments, or R2-backed snapshots. If unarchive UI is not reachable in the current tab, record the blocker and rely on backend coverage for that branch.

## Uploads And Source-To-Shadow Conversion

1. Select the run folder before uploading.
2. Upload `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.
3. Verify a normal source file node appears immediately.
4. Open it and verify the stored-file panel shows waiting/processing until the source asset has `uploadedAt` and conversion work starts.
5. Wait for conversion when the local environment has R2/Modal/finalizer configured.
6. Verify the generated shadow Markdown opens through the source node once available.
7. Upload the same PDF again in the same folder.
8. Test `Upload renamed file` and verify the renamed source node appears.
9. Test `Replace` and verify the active source node is replaced while the previous active source is archived.
10. Upload `packages/app/playwriter-playbooks/fixtures/r2-upload-markdown-sample.md` and verify it becomes a normal editable Markdown node, not a source conversion panel.

Expected result: source uploads use asset-id R2 keys, event handling creates shadows only for source assets, Markdown uploads route to editable nodes, and duplicate PDF paths follow the collision UI.

## Comments

1. Open the edited Markdown file.
2. Select editor text and click `Comment`.
3. Submit a root comment containing `comment-r2-<timestamp>`.
4. Open the comments sidebar and verify the thread appears.
5. Add a reply, reload, reopen the thread, and verify both messages remain.
6. If the Markdown file came from a converted source, verify comments attach to the active editor/shadow node, not the stored source node.

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
5. Download the uploaded PDF source after `uploadedAt` is available.

Expected result: snapshot preview/restore and downloads use asset-backed R2 URLs and materialize stale Markdown before download.

## Cleanup

1. Archive `aaa-pw-r2-<timestamp>` and any renamed upload/source artifacts created during the run.
2. Capture `state.appPlaywriterHarness.latestLogs()` or equivalent console/page error output.
3. Record skipped steps with the real blocker, not as pass.

## Failure Triage

- If a click fails, inspect the target and hit-test before retrying; do not use force clicks or `dispatchEvent` to bypass UI behavior.
- If upload conversion does not complete, check whether R2 events, the upload-finalizer Worker, Modal, and Convex env vars are configured for the local app.
- If agent search/edit does not run, record whether the failure is auth, model credentials, tool-call UI, or pending-update application.
- If initial Markdown content is missing after reload, inspect Liveblocks/Yjs logs first because the provider snapshot fetch path is sensitive.
