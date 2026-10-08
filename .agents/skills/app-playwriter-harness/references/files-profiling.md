# Files action profiling

Load `perf-profiling` and `qa-data` before a run. Reuse their fixtures. Use an owned tab and a dated
personal AI folder for runners, raw samples, logs, and the progress table. Keep the normal app server.

## Prepare the run

1. Check the browser profile and relay CWD. Follow the machine's QA profile rule.
2. Install the harness on an owned tab. Disable React DevTools before its first navigation.
3. Wait for the Files UI. Check the account, membership, viewport, and open editor.
4. Wait for tests, builds, and HMR to finish. Save the commit and hashes of changed source files.
   Call `page.bringToFront()` before timing. Check at least six quiet animation frames. A tab can
   report visible and focused while Edge runs its frames about once a second. Require a normal
   frame gap before the action. Every one of the five gaps must be at most 50 ms. Check visibility
   again when saving the sample; keep runs without both checks provisional.
5. Start a bounded Convex log capture. Save Files completion metrics only. Drop log text and results.
6. Attach `getCDPSession({ page })` and enable `Network`. Check `Profiler.enable` separately. If it is
   unavailable, use long tasks and app state; do not claim CPU function attribution.

Use at least seven samples per scenario. Keep first open and cached reopen separate. Record each
failure. Do not report p95 from seven samples. Pace Yjs pushes and snapshot restores by at least five
seconds, including restoration writes. Push and snapshot writes use separate limiter buckets with
the same two-token burst.

## Replay with the timing helper

Load [files-profile-helpers.js](../scripts/files-profile-helpers.js) after the normal harness:

```powershell
vp env exec pnpx playwriter -s <session> --timeout 5000 -f "<absolute-repo>/.agents/skills/app-playwriter-harness/scripts/files-profile-helpers.js"
```

Create the personal run folder first. Save the following small steps in that folder and run each
with `-f` and `--timeout 5000`. Replace the example absolute path with the checked run path. Use
an owned tab at the ready root, with search cleared and no rename or dialog open.

```js
await state.qa.filesProfile.install({
  page: state.appPlaywriterHarness.page,
  outputPath: "C:/workspace/example-+personal/+ai/files-profile-YYYY-MM-DD/samples.jsonl",
});
await state.qa.filesProfile.arm({
  caseId: "C02",
  scenario: "root / empty folder / rename focus",
  eventType: "click",
  startSelector: '.FilesSidebarTopSection-actions-icon-button[aria-label="New folder"]',
  mainFunction: "files_nodes:create_folder_node",
  doneExpression: "document.activeElement?.getAttribute('aria-label')?.startsWith('Rename new-folder')",
});
await state.appPlaywriterHarness.page.locator(
  '.FilesSidebarTopSection-actions-icon-button[aria-label="New folder"]',
).click({ timeout: 2000 });
```

Poll `window.__filesProfile.active?.frame !== undefined` through short `page.evaluate` calls. When it
finishes, call `state.qa.filesProfile.saveSample()`. Save an incomplete sample on failure too, then
inspect state before any retry. Read the new route ID and `files_nodes.get_file_node_for_membership`
through the app client. Require the new ID, folder kind, root parent, active state, exact path, and
empty ready table. Save a later receipt with the raw case/start/startedAt and both final-state and
restoration checks. Keep the new ID as a named catalog fixture, or archive only this run's new item
after its checks. Repeat the full setup and action for seven samples.

Call `state.qa.filesProfile.cleanup()` when finished. It removes its own page and CDP listeners;
it leaves the shared CDP session open. Keep the raw output, receipts, source pin, replay scripts,
and result table together in the personal run folder.

## Record the right boundaries

- Start inside the page at the native `click`, `keydown`, `input`, `change`, or `drop` event.
- Record first feedback, confirmed state, required focus, and the next animation-frame callback.
  The callback does not prove paint or that typing works.
- Record each outgoing Action/Mutation ID with `performance.now()`. Match its CDP send and reply.
  Use a numeric request ID and the function name to align the clocks. Query-set changes have no
  request ID; do not match them by an undefined ID.
- Map query IDs to function names from sent frames. Keep queries separate and keep their normal args.
- Save times, IDs, status, and UTF-8 byte counts. Drop authentication frames, args, response bodies,
  signed URLs, and private text.
- Clip long tasks to the measured window, including tasks that began before the event. Keep cached
  server records separate. A function/time-window match is inferred, not an exact request match.
- Keep milestone observers alive after first feedback. Save incomplete and refused samples, but keep
  them out of successful UI medians. Check visibility and the DevTools stub for every sample.
- After each action, read current state and `getLatestLogs({ page, sinceLastCall: true })`.

## Proven selectors and checks

Root creation uses `.FilesSidebarTopSection-actions-icon-button[aria-label="New file"]` or
`.FilesSidebarTopSection-actions-icon-button[aria-label="New folder"]`. The folder toolbar opens a different flow. Read the new ID from the
route. Do not infer it from virtual rows.

For a file, require the matching provider from `window.__qa.filesYjs()` to have the new `nodeId`,
`status === "synchronized"`, and `loadFailed === false`. Require a **new** editor DOM instance,
`.FileEditorRichText-visible`, the expected text, and the new row's rename focus. The old root README
also says Welcome and can remain visible after the URL changes. Text alone gives an early result.

For a folder, require the new row and `input[aria-label="Rename <name>"]` to have focus. Record the
folder table's ready state separately. After rename, check the row, breadcrumb, and saved path.
No-op rename sends no mutation, so report it as a client-only case.

Use `a[aria-label="Home"]` for the root breadcrumb. It is not always inside the path-list class.
At root, that breadcrumb is absent. Check `nodeId=root` first and skip the Home click there.
Set a short page timeout for an async batch too. The CLI timeout does not stop a pending locator
inside a background runner. A missing Home link waited 60 seconds on Playwriter 0.7.0.
If a locator click stalls at `performing click action`, inspect state before retrying. Use the current
box and a hit test, then a real mouse click. Do not raise the timeout or force the click.

Search suggestions can cover a result row. Close them with Escape and check the hit target before
clicking. Start row timing on `.FilesSidebarTreeItem[data-file-id="<id>"]`, which includes its children.

Properties must be scoped to `[data-files-properties-modal][data-open="true"]`. The current footer
has one `Save` button for metadata and protection. It stays open after a successful save. Metadata
completion is `Metadata saved` plus `files_metadata.get_entries` readback, not modal close. Import
the exact already-loaded Monaco module URL and select the editor with `ariaLabel === "Metadata YAML"`.

Copy/Paste keeps its clipboard in the page. Navigate inside the app after Copy. A short copy without
a conflict can finish without a transfer dialog. Check the new row and then the completed run through
`files_transfer.get` and `files_transfer.list_items`. A copied folder row can appear before its children
finish. Completed move items can have `source: null`; use the output target and stored node path.

The top More options menu has no root Paste item. To paste at root, focus the Files tree container
and press Control+V. Focus on a folder row pastes into it. Focus on a file row pastes into its parent.

For a native drag, click the source first to clear other selected rows. Check `.FilesSidebarTree-dragging`
after drag start and the target indicator before release. Empty `DataTransfer.types` is normal: the
tree keeps internal drag items in its own state. Read `defaultPrevented` after event propagation.
No drop event or move request means an attempted drag, not a completed move sample.

Use Alt-click on the source PrimaryAction overlay to select it without opening it. Require exactly
that source in `aria-selected` before dragging. The outer treeitem is not the drag source. Hover a
different mounted row, then the destination folder center. Headless keeps a drag target cache across
canceled drags; changing the real hover tests that cache. Before release, require the exact overlay's
`FilesSidebarTreeItemPrimaryAction-drop-zone-included`, the folder drop area, and a trusted accepted
dragover after propagation. Native move uses `files_nodes.move_nodes`; folder descendants need their
own final path checks.

## Edit, review, history, and upload

For live typing, bind the visible editor and provider to the route ID. Require Unsaved, then Saved,
then read canonical text. Pace Undo too. A typed marker may span more than one Undo group; only
remove the run's own marker. Check the exact original text after restoration.

For non-collaborative Save, name the timing boundary. A successful reply and disabled button can
precede later snapshot work. Read the exact saved text separately and reopen it to check the model.
Collaboration-off refuses while the last Yjs sequence is ahead of the stored snapshot. Wait for the
normal job; do not bypass that guard. The Properties checkbox is a native input: read `checked`.

For pending changes, match the proposal ID and revision. Require both exact diff panes before Accept
or Discard. Match the final run and item state, saved text, and absence of a proposal. After Accept,
restore baseline text through another native review. A path label is on its parent `a[aria-label]`.

History Show archived selects archived versions only. Read the native input's `checked` value and
click its associated label if the role locator stalls. Active versions have `archivedAt <= 0`.
Read the original snapshot IDs first. For preview, require a new diff DOM node and exact text; removed
words use `FileEditorSnapshotsModalPreviewModalDiffBlock-removed`. Check every original version after
archive/unarchive. This query collects all versions, so keep small and large history cases separate.

Clear search and expand the selected destination before upload timing. A successful upload can be
hidden by a name search. Copy the deterministic harness fixture to the checked personal run folder
before the relay reads it. The single-file sidebar input consumes only its first file. Folder import
uses the separate `webkitdirectory` input; sending two files to the single input is not a batch test.
If the native folder input fails, use the documented `File`/`DataTransfer` fallback in
[known-hazards.md](known-hazards.md). Label it as a browser File import, not OS picker timing.
After upload or Replace, check parent/path, published asset, processing state, exact bytes, and hash.
For editable text, conversion publishes a `content_snapshot` asset and the expected node `textKind`.
That new asset has no upload `processingWorkId`; checking it for `null` gives a false failure.
Replace must create a new ID and archive the old ID. Archive only this run's outputs after checks.

For bulk conflicts, select the exact two owned sources, then Copy/Paste through the app. At the known
conflict, Stop must reach a terminal run. Retry must have a new run ID. Keep both plus Continue must
finish all items. Read completed outputs retained by Stop too. Compare every copy's bytes with its
source, archive only new output IDs, and check all source paths and content again.

Use the native Copy menu after checking the selection. Control+C can leave the old app clipboard
when browser text is selected. Check source IDs in the returned run before timing its controls.
A terminal Partial run is a failed copy result. Record its finished time separately from successful
completion. Two small Markdown copies reproduced a media-version refusal in this run; the copy
workers can invalidate each other's workspace version check. Trace that check before changing it.
Three fresh retries on 2026-10-05 all ended Partial with the same media-validation error. Either
source can fail. Stop and Retry passed, output bytes matched, and the sources stayed unchanged.
Keep these retries separate from the earlier baseline. They do not add successful Copy timings.

## Keep the report honest

Save each write check with its case ID, native start time, and ISO start date. Batch receipts must
name those exact samples, have a later check date, and confirm final state and restoration. Keep
timing validity separate from completion validity. A label or sample number alone cannot join a
receipt after a retry or reload. Keep duplicate reads and failures in raw data, outside success
medians. A baseline covers its named scenario; it does not cover every scale or permission variant.

The extension may refuse CPU profiling and browser-level download commands. In that case, keep
native download fetch timing separate from disk completion. Do not invent a completion time from
an event, file modification date, or `download.saveAs` when no artifact exists.

## Full action checklist

For the 2026-10-05 profiling work, the user deferred D01 Download. Leave it out of the active
work and totals until the user adds it back. Keep its old samples and generic recipe for later.

Keep this list in the run's personal progress table. Split compound actions into separate scenarios.
Mark a row complete only after its raw samples, final-state check, and restoration notes are saved.

| IDs | Actions | Required final checks |
| --- | --- | --- |
| C01, C02 | Create file; create folder | New ID, path, rename focus, bound editor or folder ready |
| R01, R02 | Rename file; rename folder | Confirmed name, path, descendants, any job |
| M01, M02, M03 | Drag file; drag folder; Cut/Paste | Source and destination paths, clipboard, any job |
| P01, P02 | Copy file; copy folder | New IDs, text or bytes, first item and whole run |
| A01, A02, A03 | Archive file; archive folder; restore | Archive state, focus, descendants, conflicts, any job |
| O01, O02, O03 | Open Markdown; plain text; stored preview | Matching provider/model/preview and correct content |
| O04, O05, O06 | Open folder; workspace/link; A/B/A | Table, breadcrumb, selected ID, editor identity |
| T01, T02, T03, T04 | Expand; page/scroll; sort/filter; archived items | New rows, page bounds, order, busy state |
| S01, S02 | Name/path search; content/metadata search | Exact results, count, query completion |
| U01, U02, U03 | Upload; batch/folder import; replace | Published node, bytes, asset, upload/conversion job |
| E01, E02 | Live edit sync; non-collaborative Save | Local input, write reply, second client or reload |
| E03, E04 | Pending diff; Save/Discard | Proposal ID/revision, panes, saved text, final proposal state |
| H01, H02 | History/preview; restore/archive version | Loaded preview, saved content, history state |
| D01 | Download | First byte, finished download, expected byte hash |
| Q01, Q02, Q03 | Properties/metadata; sharing; protection/collaboration | Saved map, grants/link, policy, editor, any job |
| B01, B02 | Bulk/conflicts; Stop/Retry | First/final item, terminal run, retained completed copies |
| F01 | Refusal/no change | Error/focus recovery and no unwanted stored change |

Use the recipes in [files.md](files.md) for these flows. Turning collaboration off removes shared
edit history. Use an owned simple file or an existing non-collaborative fixture. Restore original
text, metadata, paths, grants, and policy after each batch. Keep added snapshots and created IDs in
the notes. Never delete existing catalog data.

Remove only this run's observers, patched methods, routes, and CDP handlers. Close only owned tabs.
Stop the owned log capture. Check persisted state and `git status` at the end.
