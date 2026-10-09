# Move and Save job migration

This is a later migration plan. This change does not run it or deploy a schema.
Read the Convex migrations skill before implementing or running it.

The user chose: **keep data, but stop unfinished jobs**.

- Keep every saved file, private draft, completed move and publication receipt.
- Stop unfinished Move and Save jobs. Users restart the remaining work.
- Do not rebuild old plans. Do not add old-schema readers or fallback executors.
- Never reset or touch the `sybill` workspace in the personal organization.

## Cutover

1. Audit the exact deployment and job families. Save counts, IDs and current progress outside the repo.
   Choose explicit scopes before any write. Do not infer that development data may be erased.
2. Close new intake and fence unfinished workers. Let already published work finish physical repair.
   Abort unpublished candidates. Keep original drafts and completed output.
3. Set unfinished parent Activities to a stopped result. Release their holds only after repair ends.
   Preserve completed counts and receipts. Retire unused prepared resources through their owners.
4. Backfill required fields in retained job history. Review runs need `planEpoch` and `graphPlanId`.
   Review items need frozen `reviewHeader` and `reviewSource`; terminal old items may use their
   allowed null form. Units need `planEpoch`, `cohortId` and `publicationRecorded`. Transfer items
   need their new cohort/publication fields. Check the final schema diff for the complete list.
   Retained transfer Activities need `source.isRename`, derived from their run's Rename intent.
   These values describe stopped history. They must never enable old work to resume.
5. Build the changed indexes. Normal source docs have no cohort tag. New jobs own every tagged doc.
   Audit source, slot and asset reservations, private quota holds, and delayed resource owners.
   Let each running overlay worker finish. Cancel pending old schedules while intake is closed.
   Keep each accepted overlay job, cursor, remaining work and parked cohort. Rebuild its
   schedule with the same `nextAttemptAt`
   stored on the job and passed to `files_pending_overlay.run_job`. Keep parked jobs parked;
   their current wake helper creates the new schedule after repair. Audit these schedules
   before intake reopens. Do not erase accepted work to make the required argument fit.
   Rebuild normal `files_pending_review_facts` for every kept proposal, including content-only
   and unresolved drafts. Use its current revision and fresh source and destination paths.
   Finish that rebuild and required repairs. Audit the workspace fact state before review intake
   reopens. Preserve existing proposal and review revisions and unrelated editor batches.
6. Deploy the strict current schema and code. Remove temporary migration code after the audit.
   Reopen intake only after the normal saved and pending readers pass their readback checks.

## Required audit

Compare saved IDs, paths, content versions, draft IDs/revisions and completed receipts with the
pre-migration record. No unfinished old job may publish after its fence. No orphan hold may block
new work. Check a restarted one-item Move, a large selection and a linked Save group.

Do not roll back to an executor that cannot read cohort tags. Stop intake, settle active groups,
and audit normal docs before any rollback. Keep delayed storage cleanup receipts until their
last possible upload and exact-key deletion have settled.
