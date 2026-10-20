# Move design and experiment record

Recorded on 20 October 2026. This covers the Move work through runtime commit
`79327ffa`. Main was `57b32b08` at closeout. These are historical results, not
a fresh test of later commits. The owning [skill](../SKILL.md) defines current
behavior. This record explains the reasons and keeps failed trials visible.

## Why the design changed

The old move put all selected items and their related documents in one Convex
transaction. Its 139-item refusal protected that transaction. Raising the
number would only move the failure to another database limit.

Folder moves already had background descendant work. That did not split the
work for a large selection of separate files. The new design stores the
selection and processes it in small transactions. One item and a large
selection use the same path.

A publication group is a set of changes that must become visible together.
The worker prepares its new paths and indexes in pages. Readers keep normal
names and the old view until a small transaction selects the new view.
Cleanup then finishes in pages. This avoids exposing temporary names during
linked moves. Completed groups stay saved if a later group fails or stops.

Each transaction proves current access. Reuse within one transaction must
not become an access cache across transactions. Budgets include the final
pending-overlay flush. They decide when to continue, never how many files
the user may select.

Later access work changed one product rule: Move carries locked folders
inside a selected folder and keeps their own people. Moving an item out of
a restricted folder still needs Can manage. Do not restore the old refusal
for a locked descendant. See `c07974ba` and the access-control skill.

## Changes kept on main

These are useful history points, not a list of every fix in between.

| Change | Why it stayed | History |
| --- | --- | --- |
| Store selection and publish prepared groups in pages | Remove the selection refusal while keeping normal names and recoverable progress. | `b17254cb` |
| Chain committed steps in one action and recover lost workers | Avoid a scheduler wait after every small phase. Keep a stored owner and generation so old deliveries cannot advance new work. | `0df3c089` |
| Start ready work in the accepting transaction | A ready small Move can publish before its request returns. Unfinished work continues through the same background path. | `01d403ca`, `7a83fc50` |
| Keep ordinary reads separate from heavy editor code; load content helpers only when needed | An ordinary Move should not pay to load text preparation it never uses. Fresh-module controls supported this cost, but did not prove browser speed. | `723198bf`, `0a9834b6` |
| Join native page work under the shared transaction budget | Keep real pagination while avoiding empty waits between small units. A page must see earlier writes in that transaction. | `49d19431`, `39fa43c5` |
| Skip unchanged content and media preparation for saved Move and Rename | Their content stays the same. Stage the one transfer item after owner discovery, then prepare side indexes. Review and Save still prepare content and media. | `79327ffa` |

The action's time and call bounds are checked between steps. One helper can
take longer. Hitting a bound queues more work; it does not reject files.
The scheduled owner and recovery checks are correctness rules, not optional
speed features.

Current code entry points:

- [Move worker](../../../../packages/app/convex/files_move_run.ts):
  action chaining, preparation loading and handoff.
- [Move group engine](../../../../packages/app/convex/files_move_cohorts.ts):
  `db_advance_step`, phase changes, checks and publication.
- [Transfer](../../../../packages/app/convex/files_transfer.ts):
  selection intake and the saved Move caller.
- [Overlay](../../../../packages/app/server/files-pending-overlay.ts):
  derived writes that must count toward the transaction budget.

## Evidence for the last retained change

For `79327ffa`, the local Empty fixture read 402 → 372 documents when moving
to Root, and 558 → 528 when moving into folder A. These counts include the
real final overlay flush. They are work counts, not hosted latency.

Paged Move tests with the metadata catalog had these separate peaks:
1,064 query calls; 1,994 documents read; 1,763,617 bytes read; 1,988 write
calls; 1,917,770 bytes written; four scheduled calls; 216 argument bytes.
Each peak may come from a different transaction. Do not add them together
or use this fixture as a promise for every tree.

The named assertion in
[Move start tests](../../../../packages/app/convex/files_move_start.test.ts)
is “A saved Move stages its item without entering content or media.”
Turning off the branch failed that assertion after saved-state checks passed.
Two lifecycle assertions also found `planned` instead of `staged`.
Restoring the exact code passed all three.

The two changed test files passed 16 tests. The wider focused run passed
344 tests, with five configured skips. Full app/test TypeScript and app lint
passed. Two correctness reviews and a separate code-style review found no
blocker. Browser Move and Rename passed, with saved-state and cleanup checks.
These behavior checks did not measure a new speed gain.

The full app suite and the optional full-size matrix were not repeated for
this small phase change. An earlier full suite at `b331147f` passed 12,024
tests, with 21 configured skips and zero failures, in 553.895 seconds.
That was a shared-machine run and is not a full-suite result for `79327ffa`.

## Speed trials kept out of main

Each row below is a separate controlled comparison. Do not compare numbers
between rows as if their source, load and setup were identical. Root and A
are the two destinations for the same empty-folder fixture.

| Trial | Observed result | Decision and evidence file |
| --- | --- | --- |
| Reuse parent liveness checks (`f25eb1ec` product candidate) | Fewer reads, but frame medians rose about 9.10% to Root and 5.22% to A. Shared load also drifted. | Reject. `move-parent-results-review-20261019.md` |
| Share directory-page subscriptions | Initial subscriptions fell from 24 to 16. Frame medians improved only 0.84% and 2.21%. | Reject. `move-directory-pages-er-result-review-20261020.md` |
| Give the chat count a smaller module (`08c36502` study source) | Frame medians improved 6.38% to Root and 4.38% to A. A failed the required 5% gain. | Reject. `move-chat-count-results-review-20261020.md` |
| Finish selected item/node validation earlier (`95247961`) | Frame medians rose 4.58% to Root and 5.85% to A. The accepted runtime remained `79327ffa`. | Reject. `move-selected-node-native-decision-20261020.md` |

These results did not meet the fixed adoption rule. They do not prove that
each candidate caused a slowdown. Lower read counts, fewer subscriptions
and smaller modules alone did not establish a useful visible gain.

The last trial kept all 64 saved Moves: eight warmups and 56 measured rows.
Each version and direction had 14 measured rows. Its control/candidate
medians were 1,147.25/1,199.85 ms to Root and 1,385.40/1,466.40 ms to A.
None of those 56 measured frame times was under one second.

## Measurement lessons

- Keep request acceptance, visible row update and completed cleanup separate.
  A small Move can publish in the initial request. Repair may finish later.
- The native timing ends at the next frame callback after the row appears.
  It is not a measured paint time or total background-job time.
- Keep every slow sample. Freeze the comparison rule before the trial.
  A failed setup stays recorded and cannot supply a replacement timing row.
- Match loaded frontend and backend source to each trial. Passing local
  tests does not prove that the browser ran that source.
- Do not add parallel call times or subtract unrelated medians. Runtime
  duration is not CPU time. Browser arrivals alone cannot identify the
  exact hosted query batch that caused a wait.
- Excess trace logging hit Convex's log-line limit and lost final markers
  in the large-folder capture. That incomplete trace could not explain
  the whole Move. Reduce trace output; do not guess the missing phases.
- Fixes need a named failing assertion with the fix off, then a passing
  run after restoration. A setup failure is not proof of the fix.

The under-one-second target was not met. The user closed this performance
round. A fresh bulk-throughput check and deeper timing remain unrun.
Exact hosted query-batch timing and the final wrapper's separate flush
times were still unknown. Neither is a proven cause. Earlier node-proof
completion remains a proposal, not a shipped fix or a measured speed gain.

## Where the full evidence lives

The local archive is outside Git in
`<repo>-+personal/+ai/move-chunking-2026-10-07/`. Start with:

- `execution-log.md` and `fast-move-continuation.md`: the wider work history.
  Their older “next” sections are historical, not current instructions.
- `fast-move-reader-startup-result.md`: fresh-module on/off/restored proof.
- `fast-move-b331-verification.md`: the earlier full-suite and budget checks.
- `move-unchanged-content-verification-20261020.md` and
  `move-unchanged-content-budget-report-20261020.json`: the retained change.
- The four decision files in the rejected-trials table: source pins, raw
  inputs, hashes, checks and limits for those comparisons.
- `move-selected-node-rejection-next-step-20261020.md`: independent replay
  of all 64 rows and 339 bound input files.
- `cleanup-closeout-20261020.md`: removed worktrees and branches, recovery
  bundles, the local dependency repair and its checks.

The raw reports remain unchanged where checks bind their hashes. Owned
worktrees, the deploy clone and trial branches were removed at closeout.
`cleanup-recovery-20261020/` keeps verified bundles and patches, including
rejected work. Old checkout links in raw reports may no longer open.
Do not treat a recovered experiment as approved code.
