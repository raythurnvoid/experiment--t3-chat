# Files transfer runs

`packages/app/convex/files_transfer.ts` owns saved file transfers started by human Cut/Copy/Paste.
`files_nodes_content.ts` prepares and publishes each copied file. Agent Bash copies keep their
separate pending-change flow.

## Scope and saved state

- Saved runs use `files_transfer_runs.kind: move|copy`. Items live in `files_transfer_items`.
  The browser clipboard keeps `mode: cut|copy`; Paste translates Cut into Move at `start`.

- The in-memory clipboard lasts for the current tab and workspace. Paste saves a run, which can
  continue after navigation or reload. Only one run per user and workspace may be active.
- `start` accepts at most 200 selected nodes. It removes children whose selected ancestor already
  covers them. The request id makes a repeated start return the same run.
- Copy discovers active descendants in pages of 50 before creating output, up to 10,000 items.
  This is a paged scan, not a snapshot of the whole tree at one instant. Later additions are not
  guaranteed to be included. Every publication checks the saved source and destination placement.
- Two file workers may prepare bytes at once. The item records its attempt, assets, payer, and
  completed node. A repeated callback cannot create another copy or bill it again.
- Cut uses one atomic move transaction. It allows at most 500 affected nodes, including archived
  descendants, 2,000 scanned nodes, search chunks, and metadata docs, and separate 4 MiB read and write
  budgets. Permission checks are outside that scan counter. Every affected restricted scope needs
  write access, even when its nodes are hidden or archived. An oversized or unauthorized move fails
  before moving anything. It never falls back to partial batches.

## Conflicts and concurrent changes

- Check selected-root names after discovery. Check names again in each publication transaction.
  Two selected sources with the same target name also conflict.
- Keep both allocates `report-copy-1.md`, then `report-copy-2.md`, preserving the extension.
  It tries at most 100 counter names. Each initial check and move commit has a 200-lookup budget;
  exceeding it returns a clear refusal. There is no replacement or folder merge.
- Skip creates nothing for that item. Skipping a folder also skips its descendants.
- Source or destination moves, renames, deletion, or lost access pause or refuse the affected work.
  Do not silently use a new path. Recheck membership, ACL, write policy, and workspace purge state.
- Conflict answers include the current run revision. A new unresolved conflict pauses every later
  publication. Already completed files stay. Do not expose names or paths after read access is lost.

## Copied content

- Copy saved content when each file attempt starts. Include saved Yjs updates after its snapshot.
  Keep content type, text shape, collaboration mode, and custom metadata.
- Build new node, content, Yjs, asset, and version docs. Rebuild frontmatter and search docs.
  Remove comment marks. Do not copy comment threads, history, pending proposals, grants, or runs.
- Media links keep their original node ids. Copying a folder does not rewrite those links.
- Stored files get new R2 assets through server-side object copy. Never share asset ownership.
  Copies do not dispatch upload-completed plugin events. Empty copied folders are normal output.
- A file whose upload is still saving can fail after its parent folder was copied. Keep completed
  output and show the first item failure reason in progress and Activity. Item failure messages
  must be safe without current source access: fixed text with no source names, paths, or raw errors.
- Save one payer at the first successful file billing check and keep it through retries. Recheck
  that payer's live credits and, for stored files, paid plan before publication. Emit one `file_save`
  event for each published file. Cut and folder creation have no file-save event.

## Stop, Activity, and cleanup

- Stop keeps completed copies. It first saves the stopping state, then cancels this run's queued
  work. In-flight storage may finish, but publication after Stop is refused.
- A move racing Stop either commits all non-skipped roots or moves none. The saved result wins.
- While Stop awaits confirmation, the dialog and Activity say `Stop requested. Waiting for the
  server…`. Track the pending Stop request in the clipboard provider so hiding or reopening either
  view does not lose it. Show it even before run details load. A saved stopping or final result takes
  priority. A failed request clears the waiting message and shows the error without claiming the
  run stopped.
- Hide, X, and Escape close the dialog without stopping work. Activity reopens progress or conflicts.
- Transfer Activities are private to the requester, including against other workspace owners.
  Current membership is still required. A folder guest can view, stop, and dismiss their own run.
  Active runs stay reachable even when the recent Activity feed has more than 50 entries.
- Activity sources use `source.kind` (`files_transfer_run` or `plugin_run`). File targets use
  `targets[].kind: file_node`. The source id links the Activity to its run. A transfer source stores
  `transferKind: move|copy` because its `kind` already identifies the producer.
- Attempts expire after 10 minutes. Running file attempts retry while their attempt number is below
  three. Conflict pauses may resume later. Progress refreshes the 30-minute run deadline; conflict
  choices expire after 24 hours. Finished history lasts seven days. The five-minute cron handles
  expired attempts, stops overdue runs, and removes expired history.
- Paused, stopped, failed, or expired attempts hand unpublished assets to the exact-key deletion
  ledger, including its late-upload deadline. Resume uses fresh assets. Keep published assets.
- User and tenant purge stop runs before draining their items and Activity docs in batches of 50.
  Private run cleanup never deletes completed files retained in a shared workspace.

## Verification

- `convex/files_transfer.test.ts`: ownership, discovery, names, Stop, retries, expiry, and receipts.
- `convex/files_nodes_content.test.ts`: saved content, new assets, comments, billing, and races.
- `convex/files_nodes.test.ts`: atomic move scope, cycles, read/write bounds, and policy checks.
- `convex/activities.test.ts` and `convex/data_deletion.test.ts`: private controls and bounded cleanup.
- Browser steps: [Files Cut, Copy, And Paste](../../app-playwriter-harness/references/files.md#file-cut-copy-and-paste).
