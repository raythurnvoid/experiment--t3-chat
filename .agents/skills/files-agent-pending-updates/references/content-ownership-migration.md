# Content ownership migration

This is temporary migration support. Current reads still use saved nodes and Move places.
Do not remove Restore guards or switch readers based only on this bridge.

## What the bridge owns

`server/files-content-heads.ts` wraps physical writes inside the permission and Move wrappers.
This reaches tagged staging writes and cleanup writes too. It sets ownership at the write and
copies final content fields after the pending overlay flush. Worker budget checks include that flush.

One ordinary file has a current content head. Every prepared file Review has a separate
candidate, even when its accepted bytes are unchanged. Review copies need separate owners.
Plain Move uses the same head on both location sides. A candidate becomes ready only
after its content seals. Published Review cleanup may already have deleted old content. Migration
must preserve the surviving accepted docs without rebuilding the deleted old docs.

Backfill also repairs ownership tags written by an older bridge for unchanged Review copies.
Normal writes keep an existing tag when cleanup clears its Move side.

The bridge keeps public `yjsLastSequenceId` values unchanged. It copies candidate sequence counters
into the head. Changing an ordinary Review's public sequence ID would reconnect editors. The later
reader switch must preserve this editor contract.

Only committed text chunks, search chunks, Yjs updates, and `frontmatter.*` docs receive content
ownership. Pending docs and user-written `metadata.*` stay untouched. Promotion keeps an existing
head ID when it clears a Move side. File identity, draft state IDs and bytes, expiry, billing, quota,
and history receipts must not change during backfill.

Sealing also captures the small list of original private resources that Review will consume.
Backfill adds this list to old sealed work before cleanup finishes. It checks the original
proposal revision first. Completed history gets an empty list and does not claim current drafts.

Completed Review history must not borrow today's content owner during backfill. History cleanup
may remove its already-mapped old heads, but it must never change the file's current head. File
deletion removes that one current head. Prior and candidate heads stay with the existing paged
cohort cleanup. Do not scan all heads for a file: retained Review history can grow with each Save.

## Rollout order

1. Deploy the optional schema and matching write support together.
   Keep the old side-tag readers, write guards, and physical-field flush in this phase.
2. Run `migrations:run_backfill_content_heads` only after the live migration is authorized.
   It runs nodes, Review content, saved places, text, search, Yjs updates, and metadata in order.
3. Audit every selected content owner and its docs. A runner returning does not prove completion.
   Test each live batch size before using it. Updates use single-doc pages because their bytes can
   be large. Other definitions use small pages. The local tests also use single-doc pages to
   interleave migration and cleanup.
4. Implement and verify the final content read/write and cleanup switch. Keep asset retention
   through nodes, snapshots, and Move claims until head-based retention is ready and audited.
5. Switch only after the backfill and current-state audit pass. Then strip old fields, tighten the
   schema, and remove this bridge, its migration definitions, its migration-only tests, and this guide.

Use the [migration skill](../../convex-migrations/SKILL.md) for the full deployment and audit rules.
No live migration is part of the local support tests.

## Checks

`convex/migrations.content_heads.test.ts` starts real file, Review, and Move operations. It strips
only new ownership fields to represent old data. It interleaves migration pages with cleanup and
checks exact public text and editor bytes. It also checks draft state, receipts, page retries,
frontmatter ownership, and cancellation. Keep these fixtures small. Large scale probes belong
outside the default suite.
