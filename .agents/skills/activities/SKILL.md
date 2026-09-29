---
name: activities
description: Activity job status, progress, controls, visibility, plugin opt-in, deadlines, recovery, and history cleanup. Use when changing the shared job record, its feed or file badges, or a producer's Activity adapter.
---

# Ownership

[activities_db.ts](../../../packages/app/convex/activities_db.ts) owns the shared state helpers.
[activities.ts](../../../packages/app/convex/activities.ts) owns queries and producer dispatch.
The producer owns its files, credentials, attempts, conflicts, and result receipts. Update both
in one mutation. Workpool delivers work; it does not decide whether a job succeeded.

- Every transfer, pending review, plugin run, Bash background job, "Apply to contents" protection job,
  archive or restore job, and move or scope job (`files_subtree_ops`) has one Activity, created with
  the run or op. A small archive, restore, move, or scope change that finishes inside its request
  makes no run, no op, and no Activity.
- `source.id` and `activities.by_source_id` are the only link. Do not add a backlink to the run.
- Activity owns requester, status, progress, result kind, safe errors, and common times.
  Producer copies of tenant and user IDs exist only for immutable indexes.
- Transfer `step` describes executor work. It is not a second lifecycle status.
- Human Files jobs save membership ID and lifetime. Workers require that same active lifetime.
  Account-deletion plugin events keep their service checks and can run after their actor leaves.
- A missing Activity for an existing run is an invariant failure. Do not add a second status
  field or an old-record fallback to hide it.
- Producers import only `activities_db.ts`. That module must not import producers or public
  handlers. This keeps static dispatch imports from forming a cycle during module setup.
  Do not use dynamic imports in queries or mutations: the deployed Convex runtime rejects them.

# Lifecycle and progress

Active statuses are `queued`, `running`, `awaiting_input`, and `stopping`. Finished statuses are
`succeeded`, `partial`, `failed`, `canceled`, and `timed_out`.

A Bash background job is the one producer that moves an Activity backwards. A job that pauses goes
from `running` back to `queued` while it waits for its next run, and `startedAt` keeps the first
start. Read a paused job as still alive, not as one that never started.

`activities_db_finish` accepts only active work. A late callback cannot change a finished result
or extend its retention. Transfer, review, and protection producers use `activities_get_result_status` for
natural completion, with counts from their item receipts:

- Natural completion with no failed, blocked, or canceled items succeeds, including all-skipped work.
- Natural completion with completed items and unsuccessful items is partial.
- Failed or blocked items without completed items fail. Canceled items without completed,
  failed, or blocked items settle as canceled, including a discarded Preparing file.
- User Stop settles as canceled; an execution deadline settles as timed out. Completed outputs stay.
- `resultKind` distinguishes saved work, proposals ready for review, discarded proposals, plugin
  results, and Bash job results (`bash_result`). A proposal preparation job does not claim that the proposed file was saved.

Progress has one unit and counts discovered, completed, skipped, failed, blocked, and canceled
items. A retry does not add another item. `total` stays null while discovery is incomplete. A
terminal job stopped during discovery keeps that null and says it stopped while finding files.
Such a job offers no Retry (`canRetry` needs a known total), because its item list is incomplete.
The user starts a new Copy instead.
When the total is known, terminal outcome counts sum to it. Conflict choices move items out of
blocked; Stop marks only unfinished discovered items canceled.

Activity keeps creation time, `updatedAt`, optional `startedAt`, `stopRequestedAt`, `finishedAt`,
and `expiresAt`, plus `deadlineAt`. Attempts keep their own upload leases. Pending proposals keep
their own expiry. These clocks serve different owners.

# Visibility and controls

`list_page` returns separate active and history pages, each capped at 50 scanned Activities.
Current membership is required. Hidden or dismissed entries can consume a page. Keep the raw
continuation and follow `isDone`; an empty visible page does not prove the feed ended.

- Transfer, review, Bash job, protection job, archive job, and move or scope job Activities are private
  to their requester, including against other workspace owners. Their summaries contain no source names
  or paths. Archive jobs are titled "Archive files" or "Restore files". A move job (source kind
  `files_subtree_op`) is titled "Move files" and shows in the feed. A scope job (restrict or
  unrestrict) is titled "Restrict files" and has `feedVisible: false`: it exists only so the recover
  cron finds the op. A protection job, an archive job, and a move or scope job have no targets at all.
  Details recheck file access separately.
- Shared plugin Activities require current access to every target. A missing target or a changed
  target path hides the whole Activity. A shared Activity with no target requires workspace read.
- The server returns allowed controls after visibility checks. UI code uses those controls.
- `request_stop` accepts an Activity ID, checks scope and requester, and dispatches through an
  exhaustive source switch. A folder guest may stop their own work without workspace write.
  Repeated Stop is harmless. Plugin Stop stays unavailable until its producer supports it.
  `activities_get_controls` gives no Stop to a move or scope job, to an archive job, or to a restore
  job unless it is `awaiting_input` on a name clash. `request_stop` refuses when `canStop` is false.
- Dismiss applies only to finished work. `activities_user_states` stores one dismissal per viewer
  and Activity. It does not change another viewer's feed or stop execution. Bulk dismiss is paged.
- `AppActivitiesProvider` keeps pending Stop requests across dialog and bell changes. Different
  jobs can await Stop at once. Server stopping or final status takes priority over the pending label.

The bell can load older active and history pages. File badges share only the first page of each,
through [activities.ts](../../../packages/app/src/lib/activities.ts).

# Plugin opt-in and clocks

Plugin Activities start with `feedVisible: false`. `start_run_activity` reveals that existing
Activity, sets the title and source target, and keeps prior output targets within the 20-target
cap. It still requires a source file. A second opt-in returns the existing refusal.

Plugin `timeoutMs` predicts duration. It sets `expectedFinishAt` and may show Overdue. It never
stops execution. The server deadline is separate. Recovery clears the token and fences output
before finishing as timed out. The cached principal carries the earlier of token expiry and
Activity deadline; its consumer checks the clock after reading the cache.

The existing plugin run-history query still returns `queued`, `running`, `succeeded`, or `failed`.
It derives that response from Activity; canceled and timed-out outcomes map to failed there.
The paged `plugins.list_run_history` query reports the full status and original actor/chain pins.
Scheduled runs stay hidden and cannot opt into the feed. Their history has no automatic expiry;
terminal paths still clear tokens and temporary state. Ordinary plugin retention stays thirty days.
See the [plugin runtime spec](../plugin-system/SKILL.md).

# Recovery and deletion

- `activities.recover_expired` scans at most 50 expired jobs and dispatches to each producer.
  It reads its page before changing statuses. Stopping-only pages wait for the next cron, so an
  upload lease cannot cause an immediate retry loop.
- A protection job (`files_write_policy_runs`) has no worker. Stop and the deadline finish its Activity
  at once, and a step that was already scheduled then does nothing. Its progress, `updatedAt`, and `deadlineAt`
  move only when 50 more items are counted or the job ends, so the deadline works as an idle limit. See the
  [read-only spec](../files-read-only/SKILL.md#apply-to-contents).
- An archive or restore job (`files_archive_runs`) is not stopped by its 30-minute idle deadline.
  Recovery moves the deadline and schedules the step again (`files_subtree_ops_db_recover`). A restore
  that waits on a name clash is `awaiting_input` until `resolve_conflicts`, with a 24-hour deadline
  like a paused paste. The clash can be of a top item or of an item inside a restored folder. Only that wait can time out (`timed_out`) or be stopped. Its Stop ends the whole
  Unarchive request, with the queued restore jobs of that request. The done part stays archived or
  restored. The restore jobs of one Unarchive request run one at a time: the ones after the first
  start as `queued`, with `feedVisible: false`, a 24-hour deadline, and no scheduled step. A restore
  also waits as `queued` while it overlaps another subtree op. Its op marks at most 64 paths busy, so
  a restore of many top items can mark a whole shared folder, or `/`, busy. When an op ends,
  `files_subtree_ops_db_delete` starts each waiter that overlaps nothing any more: promote marks it
  `running`, shows its card, and schedules its first step. Each waiter's check reads every op of the
  workspace, so the delete stops near the transaction limits and `files_subtree_ops.release_waiters`
  goes on with the rest. A queued job whose deadline passes gets 24 more hours.
- A copy that runs during a restore copies the items that are active when it reads them. Items the
  restore has not brought back yet are not copied. This holds for a copy into another workspace too,
  which never waits for an op of the source workspace.
- A move or scope job (`files_subtree_ops`, source kind `files_subtree_op`) has a 5-minute deadline
  (`files_subtree_ops_RECOVER_AFTER_MS`). `recover_expired` never stops it. It moves the deadline and
  schedules the step again. Each scheduled step carries a step number, so an old step that still runs
  does nothing. A successful scheduling mutation also creates one retry for that step 60 seconds
  later. If the first step worked, the retry does nothing; if it failed, the retry runs the same step.
  A queued paste Copy recovers the same way instead of stopping. The last step deletes
  the op and finishes the Activity as `succeeded`.
- `files_transfer.recover_expired_attempts` only releases expired transfer attempts. Do not put
  a second job deadline or history scan back in that module.
- `files_pending_update_runs.recover` checks interrupted selection uploads, planning leases, and
  active units every five minutes. It retries planning at most three times and checks the Activity
  deadline before resuming work. It does not scan finished history.
- `activities.cleanup_history` owns retention: seven days after transfer, review, Bash job, protection job, archive job, or move or scope job finish and thirty days
  after ordinary plugin finish. Scheduled plugin history has no automatic expiry. A move or scope op is already deleted when its walk ends, so cleanup deletes only its Activity. A Bash job row can hold a 700 KiB result, so a pass reads at most eight job rows and reschedules for the rest; the job row is deleted with its Activity, while the foreground Bash call row beside it stays until thread purge. It stops a pass after a bounded child cleanup page. Each producer deletes
  its own receipts. Transfer and review producers also release their proposal holds first. Dismissal docs drain first. The Activity and its producer are then deleted together.
- Deleting history does not delete saved files or pending proposals. Asset deletion jobs retain
  exact R2 keys and late-upload deadlines independently of Activity history.
- User deletion drains that user's dismissal docs. Tenant purge drains all dismissal docs for each
  Activity. Follow the [data deletion spec](../data-deletion/SKILL.md).

# Verification

Use `convex/activities.test.ts` for feed privacy, pagination, controls, deadline dispatch, and
retention. Producer tests cover final publication, late callbacks, tokens, and saved outputs.
`convex/files_pending_update_runs.test.ts` also checks review recovery and shared history cleanup.
`convex/files_write_policy_runs.test.ts` checks the protection job steps, Stop, deadlines, and cleanup.
`convex/files_archive_runs.test.ts` checks archive and restore job steps, Stop, clashes, and cleanup.
`convex/files_subtree_ops.test.ts` checks op overlap and how waiting ops start. `convex/files_nodes.test.ts`
checks the move and scope job Activities and walks.
`src/components/app-notifications.test.tsx` and `src/components/files/files-clipboard.test.tsx`
cover shared Stop state and the visible results. Verify reachable flows in the running app too.
