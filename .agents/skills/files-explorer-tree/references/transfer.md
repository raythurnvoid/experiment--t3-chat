# Files transfer runs

`packages/app/convex/files_transfer.ts` owns human Cut/Copy/Paste and agent Bash `cp`, `mv`, and
`transfer` runs. `files_nodes_content.ts` captures and publishes copied content. Agent output uses
the same producer with private proposals. `files_pending_updates.ts` and
`files_pending_update_runs.ts` own later Save and Discard.

## Scope and saved state

- Runs use `files_transfer_runs.kind: move|copy`. Items live in `files_transfer_items`.
  The browser clipboard keeps `mode: cut|copy`; Paste translates Cut into Move at `start`.
- Human runs read saved content and publish saved output. Agent runs read the owner's current
  saved/private view and publish proposals. Each run stores `sourceView`, `publication`, and its
  immutable origin. It never changes modes during Retry.
- Activity owns status, progress, result, deadlines, and membership lifetime. A run keeps only
  immutable intent and executor state such as `step: discover|apply`, revision, and worker count.

- The in-memory clipboard lasts for the current tab and workspace. Paste saves a run, which can
  continue after navigation or reload. Only one run per user and workspace may be active.
- `start` accepts at most 200 selected nodes. It removes children whose selected ancestor already
  covers them. Sources and destination parents use tagged saved/private IDs. The destination path,
  parent, optional target name, and missing Copy parents are fixed at start. A repeated request ID
  returns its original run; changing that request's intent refuses.
- Copy discovers active descendants in pages of 50 before creating output, up to 10,000 items.
  This is a paged scan, not a snapshot of the whole tree at one instant. Later additions are not
  guaranteed to be included. Output starts only after discovery ends. The completed manifest stays
  fixed during Retry. Every publication checks source identity and destination placement. Copy into
  a descendant is allowed when it cannot replace or merge into a captured source. It never discovers
  its own output. Move into a descendant is refused.
- Two file workers may prepare bytes at once. The item records its attempt, assets, payer, and
  completed node. A repeated callback cannot create another copy or bill it again.
- Cut uses one atomic move transaction. It allows at most 500 affected nodes, including archived
  descendants, 2,000 scanned nodes, search chunks, and metadata docs, and separate 4 MiB read and write
  budgets. Permission checks are outside that scan counter. Every affected restricted scope needs
  write access, even when its nodes are hidden or archived. An oversized or unauthorized move fails
  before moving anything. It never falls back to partial batches.
- Saved Move and reviewed pending Move use the common preflight/apply plan in `files_nodes.ts`.
  Private publication uses that same plan for a saved replacement occupant. Moves stay within one
  workspace. OS links, ownership bits, timestamps, and subtree replacement are not supported.

## Conflicts and concurrent changes

- Check selected-root names after discovery. Check names again in each publication transaction.
  Root claims stay in argument order across planning pages, conflict replies, and worker completion.
  Two selected sources with the same target name conflict even when both would merge into one existing
  folder. Bash `-n` keeps the first claim and skips later branches, while existing folders still merge.
- Keep both allocates `report-copy-1.md`, then `report-copy-2.md`, preserving the extension.
  Publication keeps each planned name. A later outside collision chooses another name while keeping
  the other roots' planned names reserved.
  It tries at most 100 counter names. Each initial check and move commit has a 200-lookup budget;
  exceeding it returns a clear refusal. Copy also supports file replacement and folder merge;
  merge keeps the destination folder ID, metadata, and unrelated children. File replacement names
  the exact reviewed occupant and content version. Move replaces only an empty folder, never merges
  a nonempty one. Bash requires `mv -T -f` for exact empty-folder replacement. A file cannot replace
  a folder or a folder replace a file.
- A blocked item has two different shapes, and the review UI must keep them apart. A **name
  conflict** is stored with `conflictKind: "name_conflict"`. It can have a destination document,
  when something already occupies the name, or none at all, when another source in the same paste
  claimed a free name first. An **unavailable item** is one whose source moved, was archived, or is
  no longer readable.
  The public door returns `conflictKind` next to `conflict` for exactly this reason: `conflict` is
  the destination document and is null in the same-paste case, so it cannot be used to tell the two
  apart. Offer Keep both and Skip for every name conflict. Offer Replace and Merge only when a
  destination document exists, because only those two act on one. Offer only Skip for an unavailable
  item.
- Skip creates nothing for that item. Skipping a folder also skips its descendants.
- Source or destination moves, renames, deletion, or lost access pause or refuse the affected work.
  Do not silently use a new path. Recheck membership, ACL, write policy, and workspace purge state.
- Conflict answers include the current run revision and, for replacement, the exact target and
  version shown in that conflict. A new unresolved conflict pauses every later
  publication. Already completed files stay. Do not expose names or paths after read access is lost.

## Copied content

- Pin each file's version, snapshot or sealed pending-state recipe, and custom metadata at its first
  successful preparation. Include saved Yjs updates only through that version's sequence. Agent
  reads use the owner's current proposed content. A captured pending branch has its own paged state
  owned by the transfer item. Later edits and metadata changes never refresh the capture. Keep
  content type, text shape, and collaboration mode.
- Prepare independent assets under the attempt, then seal them under `item.capture.artifact` and
  clear their unfinished-asset check deadline in one mutation. Keep `putMayArriveUntil` on the asset.
  Retries reuse sealed content and the same fresh Yjs
  snapshot. Before sealing, missing pinned bytes fail the item instead of copying newer content.
- Recheck the source's identity, type, shape, collaboration mode, and Yjs history at each write.
  Ordinary edits may advance its asset or sequence. Current membership, read access, destination,
  write policy, Stop, Activity deadline, attempt, and work id still control publication.
- New saved output gets new node, content, Yjs, asset, and version docs. Rebuild frontmatter and search docs.
  Remove comment marks. Do not copy comment threads, history, pending proposals, grants, or runs.
- Media links keep their original node ids. Copying a folder does not rewrite those links.
- Stored files get new R2 assets through server-side object copy. Never share asset ownership.
  Copies do not dispatch upload-completed plugin events. Empty copied folders are normal output.
- A file whose upload is still saving can fail after its parent folder was copied. Keep completed
  output and show the first item failure reason in progress and Activity. Item failure messages
  must be safe without current source access: fixed text with no source names, paths, or raw errors.
- Save one payer at the first successful file billing check and keep it through retries. Recheck
  that payer's live credits and, for stored files, paid plan before publication. Emit one `file_save`
  event for each saved file. Preparing a private proposal does not bill a file Save. Cut and folder
  creation have no file-save event.

## Private publication and review

- A new agent Copy target gets an owner-only private node. A file says Preparing until its content
  and create intent are sealed. Preparing files cannot be edited, moved, copied, or saved. A failed
  or stopped preparation retires only that private generation and its owned assets.
- Copy over a saved file creates `pendingReplacement`, bound to its exact saved content version.
  Accept keeps the saved destination ID, permissions, metadata, and history. Text over text keeps
  the destination collaboration mode. Text over stored content uses the source's mode. Replacing
  collaborative text with stored content requires turning collaboration off first.
- Agent Move changes a private source's parent and name immediately. A saved source gets a move
  proposal. Its saved name and parent stay unchanged until Save. Both keep the source content type.
- Forced file Move supports every saved/private source and occupant pair. A private occupant must
  be ready and, for a folder, empty. Current access and policies are checked before it is retired.
  The surviving source keeps both proposals' contributing chats. A private occupant's saved
  replacement claim follows the source with the same saved ID and content version.
  A saved occupant with its own pending Move must be saved or discarded before it can be replaced.
- A saved occupant stays intact while a private source claims its name. Single Save and bulk Save
  archive that exact occupant and publish the source in one transaction. Active saved children,
  private children, pending moves into the folder, changed content, a new occupant, or lost access
  refuse the affected Save. Discard, expiry, and moving away keep the saved occupant unchanged.
- Bulk review stores the selected proposal IDs, revisions, and content states. Connected parent,
  move, content, and replacement work commits as one bounded unit. An unselected affected proposal,
  including another chat's proposal on the occupant, requires a new selection. The worker never
  silently includes it. A partial private Save keeps unresolved text on the same proposal, retargets
  it to the saved source, and removes the completed create and move claims.
- Private destination parents keep their identity through Save using their owner-scoped publication
  receipt. Retry keeps that same parent. A moved or discarded parent pauses instead of adopting
  whichever folder now owns the old path. See the [pending spec](../../files-agent-pending-updates/SKILL.md).

## Stop, Activity, and cleanup

- Stop keeps completed copies. It first saves the stopping state, then cancels this run's queued
  work. It drains at most 50 unfinished items per mutation and moves blocked counts to canceled.
  It keeps worker IDs until callbacks or upload leases settle. Publication after Stop is refused.
- A move racing Stop either commits all non-skipped roots or moves none. The saved result wins.
- While Stop awaits confirmation, the dialog and Activity say `Stop requested. Waiting for the
  server…`. Track the pending Stop request in `AppActivitiesProvider` so hiding or reopening either
  view does not lose it. Show it even before run details load. A saved stopping or final result takes
  priority. A failed request clears the waiting message and shows the error without claiming the
  run stopped.
- Hide, X, and Escape close the dialog without stopping work. Activity reopens progress or conflicts.
- Transfer Activities are private to the requester, including against other workspace owners.
  Current membership is still required. A folder guest can view, stop, and dismiss their own run.
  Active and history pages are separate, so an old running job stays reachable. Dismiss is per
  viewer. See the [Activity spec](../../activities/SKILL.md) for statuses, counts, and controls.
- Activity sources use `source.kind` (`files_transfer_run` or `plugin_run`). File targets use
  `targets[].kind: file_node`. The source id links the Activity to its run. A transfer source stores
  `transferKind: move|copy` because its `kind` already identifies the producer.
- Attempts expire after 10 minutes. Running file attempts retry while their attempt number is below
  three. Conflict pauses may resume later. Progress refreshes the 30-minute Activity deadline;
  conflict choices expire after 24 hours. Finished history lasts seven days. The transfer cron
  releases expired attempts; common Activity recovery stops overdue jobs and owns history cleanup.
- Ordinary Bash transfers share the durable invocation's fixed deadline and command-number receipt.
  Replaying a completed tool call does not start the transfer twice. Explicit background `transfer`
  runs can outlive the shell call and have start/status/wait/stop controls. A shell success means its
  requested saved or proposal work completed; waiting, refusal, Stop, and deadline results keep their
  actual exit status.
- Failed or expired attempts hand unfinished upload staging to the exact-key deletion ledger,
  including the asset's `putMayArriveUntil`. Allocation sets it to 25 minutes later: two ten-minute
  action windows for the worker and nested R2 copy, plus the existing five-minute upload margin.
  Cleanup copies this deadline without adding the margin again. It must not use the attempt's
  enqueue time, because a queued worker may start near attempt expiry. An automatic retry keeps sealed capture assets. A name
  conflict also keeps them for Keep both. Skip, Stop, source/destination conflicts, permanent failure,
  and run deletion release unused capture assets, including assets that already have R2 keys.
- Publishing the file, its content and version docs, billing event, receipt, and capture ownership
  handoff is one mutation. The item then has no asset ownership. A lost response or later run
  deletion cannot remove saved output or bill it twice.
- A private completion hands captured assets and states to the exact private proposal in one
  mutation. Transfer cleanup cannot reclaim them after that handoff. Save later moves those holds
  to the saved file; Discard gives them to durable cleanup.
- User and tenant purge stop runs before draining their items and Activity viewer state in batches of 50.
  Private run cleanup never deletes completed files retained in a shared workspace.

## Verification

- `convex/files_transfer.test.ts`: ownership, discovery, names, Stop, retries, expiry, and receipts.
- `convex/files_nodes_content.test.ts`: saved content, new assets, comments, billing, and races.
- `convex/files_nodes.test.ts`: atomic move scope, cycles, read/write bounds, and policy checks.
- `convex/files_pending_updates.test.ts`: all saved/private Move pairs, exact replacements,
  contributor review, empty folders, late edits and children, partial Save, Discard, and expiry.
- `convex/files_pending_update_runs*.test.ts`: selected connected units, transaction bounds,
  preparation, retry, Stop, and cleanup.
- `server/bash*.test.ts`: normal and explicit transfer commands, invocation replay, cwd identity,
  mixed operations, exit status, and deadlines.
- `convex/activities.test.ts` and `convex/data_deletion.test.ts`: private controls and bounded cleanup.
- Browser steps: [Files Cut, Copy, And Paste](../../app-playwriter-harness/references/files.md#file-cut-copy-and-paste).
