---
name: activities
description: Activity job status, progress, controls, visibility, plugin opt-in, deadlines, recovery, and history cleanup. Use when changing the shared job record, its feed or file badges, or a producer's Activity adapter.
---

# Ownership

[activities_db.ts](../../../packages/app/convex/activities_db.ts) owns the shared state helpers.
[activities.ts](../../../packages/app/convex/activities.ts) owns queries and producer dispatch.
The producer owns its files, credentials, attempts, conflicts, and result receipts. Update both
in one mutation. Workpool delivers work; it does not decide whether a job succeeded.

- Every transfer, pending review, and plugin run has one Activity, created with the run.
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

`activities_db_finish` accepts only active work. A late callback cannot change a finished result
or extend its retention. Transfer and review producers use `activities_get_result_status` for
natural completion, with counts from their item receipts:

- Natural completion with no failed, blocked, or canceled items succeeds, including all-skipped work.
- Natural completion with completed items and unsuccessful items is partial.
- Failed or blocked items without completed items fail. Canceled items without completed,
  failed, or blocked items settle as canceled, including a discarded Preparing file.
- User Stop settles as canceled; an execution deadline settles as timed out. Completed outputs stay.
- `resultKind` distinguishes saved work, proposals ready for review, discarded proposals, and
  plugin results. A proposal preparation job does not claim that the proposed file was saved.

Progress has one unit and counts discovered, completed, skipped, failed, blocked, and canceled
items. A retry does not add another item. `total` stays null while discovery is incomplete. A
terminal job stopped during discovery keeps that null and says it stopped while finding files.
When the total is known, terminal outcome counts sum to it. Conflict choices move items out of
blocked; Stop marks only unfinished discovered items canceled.

Activity keeps creation time, `updatedAt`, optional `startedAt`, `stopRequestedAt`, `finishedAt`,
and `expiresAt`, plus `deadlineAt`. Attempts keep their own upload leases. Pending proposals keep
their own expiry. These clocks serve different owners.

# Visibility and controls

`list_page` returns separate active and history pages, each capped at 50 scanned Activities.
Current membership is required. Hidden or dismissed entries can consume a page. Keep the raw
continuation and follow `isDone`; an empty visible page does not prove the feed ended.

- Transfer and review Activities are private to their requester, including against other workspace owners.
  Their summaries contain no source names or paths. Details recheck file access separately.
- Shared plugin Activities require current access to every target. A missing target or a changed
  target path hides the whole Activity. A shared Activity with no target requires workspace read.
- The server returns allowed controls after visibility checks. UI code uses those controls.
- `request_stop` accepts an Activity ID, checks scope and requester, and dispatches through an
  exhaustive source switch. A folder guest may stop their own work without workspace write.
  Repeated Stop is harmless. Plugin Stop stays unavailable until its producer supports it.
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
See the [plugin runtime spec](../plugin-system/SKILL.md).

# Recovery and deletion

- `activities.recover_expired` scans at most 50 expired jobs and dispatches to each producer.
  It reads its page before changing statuses. Stopping-only pages wait for the next cron, so an
  upload lease cannot cause an immediate retry loop.
- `files_transfer.recover_expired_attempts` only releases expired transfer attempts. Do not put
  a second job deadline or history scan back in that module.
- `files_pending_update_runs.recover` checks interrupted selection uploads, planning leases, and
  active units every five minutes. It retries planning at most three times and checks the Activity
  deadline before resuming work. It does not scan finished history.
- `activities.cleanup_history` owns retention: seven days after transfer or review finish and thirty days
  after plugin finish. It stops a pass after a bounded child cleanup page. Each producer deletes
  its own receipts. Dismissal docs drain first. The Activity and its producer are then deleted together.
- Deleting history does not delete saved files or pending proposals. Asset deletion jobs retain
  exact R2 keys and late-upload deadlines independently of Activity history.
- User deletion drains that user's dismissal docs. Tenant purge drains all dismissal docs for each
  Activity. Follow the [data deletion spec](../data-deletion/SKILL.md).

# Verification

Use `convex/activities.test.ts` for feed privacy, pagination, controls, deadline dispatch, and
retention. Producer tests cover final publication, late callbacks, tokens, and saved outputs.
`convex/files_pending_update_runs.test.ts` also checks review recovery and shared history cleanup.
`src/components/app-notifications.test.tsx` and `src/components/files/files-clipboard.test.tsx`
cover shared Stop state and the visible results. Verify reachable flows in the running app too.
