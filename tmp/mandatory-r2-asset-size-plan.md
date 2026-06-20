# Mandatory R2 Asset Size Execution Plan

## Goal

Make `files_r2_assets.size` mandatory in the empty-database schema, keep size canonical on the asset doc, and remove unnecessary duplicate R2 asset reads from bash command handling.

## Decisions

- No migration or compatibility phase is needed because the database is assumed empty.
- Size remains stored on `files_r2_assets`; do not denormalize it onto `files_nodes`.
- Bash may still read the asset doc once through a canonical helper when committed size is needed.
- Remove local duplicate/fallback R2 reads in command handlers, especially `stat`.
- Pending markdown edit size continues to override committed asset size.

## Implementation Steps

1. Change `files_r2_assets.size` in `packages/app/convex/schema.ts` from optional to mandatory.
2. Keep `r2.insert_asset` requiring size via the schema-backed validator.
3. Change `r2.patch_asset` so `size` is still an optional patch argument, because callers patch `r2Key`, `etag`, or `conversionWorkId` without changing size.
4. Add `size: 0` to any pre-created placeholder asset insertions that do not yet have object bytes.
5. Remove optional-size fallbacks on loaded asset docs where mandatory size now applies.
6. Update `get_app_file_byte_size` in `packages/app/convex/bash.ts` to:
   - load the file node once,
   - return pending update size first for editable files,
   - otherwise return mandatory size from the file node asset doc when an asset exists,
   - return `null` only for root, folders, missing nodes, or files without assets.
7. Remove the redundant `stat` fallback `internal.r2.get_asset_by_id` call and use only the helper result.
8. Remove now-unused `get_asset_by_id_Result` import from bash if no longer needed.
9. Update direct `files_r2_assets` test fixture insertions to include size.
10. Update tests that asserted no `r2:get_asset_by_id` call for committed size paths, because the canonical helper still reads the asset doc when there is no pending edit.
11. Keep tests asserting no committed asset read when pending update size is available.

## Verification

- Run focused Convex tests through Vite Plus:
  `vp env exec pnpm --dir packages/app exec vitest run --project convex convex/bash.ts convex/files_nodes.test.ts convex/files_pending_updates.test.ts convex/data_deletion.test.ts convex/workspaces.test.ts`
- If the focused set is too broad or slow, first run the narrower affected set:
  `vp env exec pnpm --dir packages/app exec vitest run --project convex convex/bash.ts convex/files_nodes.test.ts convex/files_pending_updates.test.ts`
- Do not run full lint or full tests unless needed after focused failures.
