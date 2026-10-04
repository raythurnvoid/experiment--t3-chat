---
name: quotas
description: Persisted per-user, per-organization, and per-workspace quota counters. Use when changing `packages/app/convex/quotas.ts`, quota helpers, quota schema docs, organization/workspace/API credential quota behavior, or tests for quotas.
---

# Mental model

- Quotas are **persisted documents**, not live doc-count queries at runtime.
- The quota state lives in one generic `quotas` table in `packages/app/convex/schema.ts`.
- Quotas are looked up by their typed scope fields:
	- `userId` plus `quotaName: "extra_organizations"` for user-level organization creation quota
	- `organizationId` plus `quotaName: "extra_workspaces"` for organization-level workspace creation quota
	- `userId`, `organizationId`, and `workspaceId` plus `quotaName: "active_api_credentials"` for a user's active API keys in one workspace
	- `organizationId`, `workspaceId`, and `quotaName: "stored_file_bytes"` for confirmed stored-file bytes
	- `userId`, `organizationId`, and `workspaceId` for `files_private_user_bytes` and `files_private_nodes`
	- `organizationId` plus `workspaceId` for `files_private_workspace_bytes`
	- `userId`, `organizationId`, and `workspaceId` for `ai_chat_output_user_bytes`; `organizationId` plus `workspaceId` for `ai_chat_output_workspace_bytes` and `ai_chat_output_workspace_objects`
- The product rule is still:
	- each user gets `personal` plus at most **2** extra organizations (**3** total organizations)
	- each organization gets `home` plus at most **5** extra workspaces (**6** total workspaces)
	- each user can have at most **20** active API keys in one workspace
	- `stored_file_bytes` starts at **10 GiB** per workspace. It is a safety cap. Raise it step by step as needed. Deleting or archiving files gives no bytes back.
	- private prepared content has **1 GiB** per user/workspace and **5 GiB** per workspace; each user/workspace also has **10,000** private new-node slots. These are live capacity counters. Saving or confirmed deletion returns capacity.
- Default entities do **not** consume quota usage:
	- default organization `personal`
	- default workspace `home`
- Revoked API keys do not consume active API credential quota. The separate 100-entry API key list bound only limits recent history returned to the UI.

# Source of truth

- Runtime quota reads are DB-authoritative.
- Use quota helpers from `packages/app/convex/quotas.ts` for ensure and required reads.
- Usage-changing mutations call `quotas_db_get(...)` and patch the quota doc directly with `ctx.db.patch(...)` in the owning write flow.
- Helper call sites pass only schema-typed quota names such as `"extra_organizations"` and `"extra_workspaces"`; `quotas.ts` maps those names to the shared definitions internally.
- Do **not** add runtime fallback behavior that:
	- recomputes `usedCount` from live docs
	- substitutes code `maxCount` defaults when a quota doc is missing
- Missing required quota docs in write flows should fail intentionally via `should_never_happen(...)` so bootstrap bugs stay visible.
- Exception: upload and private storage counters have no bootstrap owner, so the first consumer seeds them with `quotas_db_ensure`. A missing doc means nothing was consumed yet, and the public `quotas.get` arm returns the doc or `null` instead of failing. Private storage uses `files_private_storage_db_reserve`. Stored-file admission reads a missing counter as zero without writing. Settlement seeds it when charged bytes publish.
- Public quota queries may return `null` for stale identities or unauthorized quota scopes. Missing quota docs for authorized scopes fail intentionally.

# Schema

- `packages/app/convex/schema.ts` has one `quotas` table.
- Each quota doc stores:
	- `quotaName`
	- `userId` for user-scoped quotas
	- `organizationId` for organization-scoped quotas
	- `workspaceId` for workspace-scoped quotas
	- `usedCount`
	- `maxCount`
	- `createdAt`
	- `updatedAt`
- Scope indexes:
	- `quotas.by_user_quotaName`
	- `quotas.by_organization_quotaName`
	- `quotas.by_workspace_quotaName`
	- `quotas.by_user_organization_workspace_quotaName`
- Cleanup indexes add `retiredAt` after the user, organization, or workspace. Cleanup selects the exact absent value so retained counters cannot block later batches. Retired private quotas keep their original scope and quota IDs.
- Organization quota read authorization checks active membership against the requested `organizationId` with `organizations_workspaces_users.by_active_user_organization_workspace`, then reads the quota doc by `organizationId` and `quotaName`.
- Stable definitions live in `packages/app/shared/quotas.ts`:
	- `quotas.extra_organizations`
	- `quotas.extra_workspaces`
	- `quotas.active_api_credentials`
	- `quotas.stored_file_bytes`
	- `quotas.files_private_user_bytes`
	- `quotas.files_private_workspace_bytes`
	- `quotas.files_private_nodes`

# Runtime write paths

## User bootstrap

- `users.create_anonymous_user` and signed-in restore/create flows ensure the user quota with `quotas_db_ensure({ quotaName: "extra_organizations", userId })`.
- `organizations_db_ensure_default_organization_and_workspace_for_user` creates `personal`/`home` when `users.defaultOrganizationId` is absent or points to a missing organization doc. If the pointed organization exists, it does not repair the workspace pointer or memberships.
- Default provisioning through `organizations_db_create(..., default: true)` does not consume the user extra-organization quota.

## Organization create

- `organizations_db_create(..., default: false)` reads the creator `"extra_organizations"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Every organization creation ensures the organization `"extra_workspaces"` quota with `usedCount: 0`.
- Missing user quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Organization quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## Workspace create

- `organizations_db_create_workspace` reads the organization `"extra_workspaces"` quota with `quotas_db_get` and increments `usedCount` directly when capacity remains.
- Missing organization quota docs should fail through `quotas_db_get`. Exhausted quota callers return `_nay.message === "Workspace quota reached"` and frontend callers map that message to the shared quota-specific UI copy.

## API credential create, revoke, and rotate

- Membership creation ensures one `active_api_credentials` quota doc for the user, organization, and workspace tuple.
- `public_api.api_credential_create` reads the persisted quota with `quotas_db_get`, blocks when `usedCount >= maxCount`, and increments the counter in the same mutation as the credential insert.
- `public_api.api_credential_revoke` decrements the counter only when it changes an active credential to revoked.
- `public_api.api_credential_rotate` revokes one credential and creates one credential in the same mutation, so the active counter does not change.
- Do not count active credential docs at create time. The persisted quota is the runtime source of truth.

## Stored-file admission and settlement

- All stored-file paths use `convex/files_stored_uploads.ts`: Files uploads, public API uploads, service uploads, browser downloads, stored producer output, copies, and stored snapshot restores.
- Admission checks the payer's paid plan before any node, asset, or quota write. It accepts safe integer sizes from zero through 2 GiB. Service uploads require at least one byte.
- Admission checks the full accepted batch's declared bytes against remaining `stored_file_bytes` capacity. Skipped conflicts use no capacity. It reserves and charges nothing.
- Settlement checks real bytes against declared bytes before publication. A larger object is deleted and never published. Service finalize returns `oversized_upload` → HTTP 409.
- Valid publication adds real bytes and emits one `file_upload` event in the same transaction. Accepted uploads may settle after the cap fills. Publication receipts guard both the event and counter from replay.
- Late superseded or canceled service attempts only queue exact-key deletion. They add no bytes and emit no event. `chargedBytes` records the winning target's counted size; `actualBytes` records its published size.
- Operator imports alone may mint `uploadBillingExempt: true`. They still check size, but add no bytes and emit no event. Text saves keep `file_save` and do not read this cap.
- A new cap in `shared/quotas.ts` applies to new docs. Raising an existing cap also needs an audited update of that doc's `maxCount`. Never recalculate `usedCount` from current files.

## Private prepared storage

- Scope each hold to the workspace that owns its resource, not the chat workspace. Cross-workspace transfer captures remain source-owned; copied assets and proposal states use destination counters. Personal/home follows the same limits. Agent-run billing remains separate from these storage limits.
- `files_private_storage_reservations` holds one receipt per physical resource: R2 asset/key, pending state family, temporary text input, trusted update stage, or private node. Pages inherit their state's hold. Count stored payload bytes once per resource; separate state encodings and copied assets count separately. Derived search and metadata docs keep their own existing bounds.
- Reserve before storing payload or starting a remote write. An empty allocation that fails admission must leave no resource behind. State growth reserves the new total in the same mutation as new pages. Both byte counters must fit before either changes. A repeated reservation does not charge again. New positive capacity refuses with `storage_full` while over cap; reading, saving and discarding retained work stay available.
- Reserve and release resources in sequence within one mutation. Concurrent helper calls in that mutation could both read the same old counter. Separate Convex mutations use normal transaction conflict checks.
- Reviewed Save batches may use 20 MiB of temporary publication space per workspace when a normal byte cap is full. The batch names either exact output assets or one trusted Yjs update; only those resources and its output states qualify. This covers saved and private targets. The helper checks the proposal revision and private generation again. All bytes still increase the normal counters. A bounded index read includes at most 128 held publication resources; a full allowance waits for physical cleanup. Public edit batches cannot mark themselves as publication batches.
- Ownership changes from capture to proposal, or active to retired state, keep the hold. Saving releases only resources handed to saved ownership. Residual or retired state pages stay charged until their last page is deleted.
- `files_private_storage_db_release` records settlement and decrements the counters together. Database-only cleanup calls it only after the exact resource family is deleted. R2 cleanup calls it only after the current deletion generation is confirmed at or after the last possible late PUT. Failed, stale, or early deletes release nothing. The receipt survives the asset and the deletion job, so replay cannot charge or release it twice.
- Account and tenant cleanup use `quotas_db_delete`. A private quota with held receipts gets `retiredAt`; the normal cleanup index then skips it. Final settlement deletes a retired counter only when no held resources remain, including zero-byte resources. Cleanup uses the retained quota IDs after the user or workspace is gone.
- Account and workspace purge remove private proposals, pages, inputs, batches, and private identities before releasing their DB storage holds. Children go before private parents. Failed Save assets go to exact-key deletion jobs with their last upload deadline. Their bytes remain held until remote deletion settles. Published files are outside user-private cleanup.
- A recovered account or preserved reset workspace may use the same scope again. `quotas_db_ensure` reuses and reactivates its retained quota, including bytes still awaiting deletion. It never starts a second zero counter while the old hold remains.
- Byte counts cover payloads, not database encoding or index overhead. Private storage limits are separate from usage billing and the monotonic stored-file counter.

## Chat stored tool output

- Three live capacity counters hold stored tool outputs (see the ai-chat-agent skill): `ai_chat_output_workspace_bytes` (5 GiB per workspace), `ai_chat_output_user_bytes` (2 GiB per user in a workspace), and `ai_chat_output_workspace_objects` (50,000 per workspace). Archiving a chat does not give space back. Deleting it does.
- `ai_chat_outputs_storage_db_reserve` (`convex/ai_chat_outputs_storage.ts`) seeds the counters on first use with `quotas_db_ensure`. All three must fit before any of them changes; otherwise it returns `storage_full` with the definition's `disabledReason`, and the tool does not run.
- The reservation holds the largest size the tool can store (Bash 1 MiB, MCP 2 MiB). A small result releases it. A stored result shrinks it to the real size. The hold stays until the R2 deletion job of the object settles, so a late PUT can never be stored without a charge.
- Each object doc keeps the three quota ids it charged. `quotas_db_delete` retires a chat output counter that still has an object with its id (indexes `by_workspaceBytesQuota`, `by_userBytesQuota`, `by_workspaceObjectsQuota`), and the last settle deletes the retired counter.
- The per-chat cap of 10,000 stored results is `outputOwnerCount` on the thread, not a quota doc.

## Delete flows

- `delete_workspace` reads the organization extra-workspace quota and decrements `usedCount` directly when deleting a non-default workspace.
- Immediate workspace deletion keeps `stored_file_bytes` through retention. Content purge removes it after targets, assets, and files are gone. A data-only reset also removes it, so the next charged publication starts at zero.
- `delete_organization` reads the owner from `organizations.ownerUserId`, decrements that owner's extra-organization quota directly, and defers deleting the organization quota doc until `data_deletion.process_organization_deletion_request`.
- Account deletion uses the same direct owner quota decrement when the backend queues a still-owned organization for deletion instead of the frontend transferring it first.
- `data_deletion.process_organization_deletion_request` and `data_deletion.process_user_deletion_request` delete their scoped quota docs, except private counters retained for outstanding cleanup as described above.
- Organization deletion requests are expected to reference an existing organization and delete quota docs by the request organization id before deleting the organization doc. If a user-scope queued request finds the user shell doc already gone, treat that request as stale and still delete the matching user quota docs by user id.

## Ownership transfer

- `access_control.transfer_organization_ownership` must respect the recipient’s persisted `extra_organizations` quota doc.
- Transfer reads the current owner's quota alongside the recipient eligibility reads. It reads the recipient's quota only after proving that user is live and an active organization member. It then releases one old-owner usage unit and consumes one new-owner quota unit in the same mutation write phase as patching `organizations.ownerUserId`, deleting all of the new owner's assignments in that organization, and giving the old owner a `member` assignment.
- Auth-removing user finalization must preserve a shared organization when another active member remains. It transfers ownership to the first remaining default-workspace member and increments that user's persisted usage even when the user is already at the normal creation limit. In that forced handoff, `usedCount` may exceed `maxCount`; new organization creation stays blocked until later deletions bring usage below the limit.
- Do not recompute quota usage from organization docs during normal product flows; use audits or explicit maintenance flows if drift ever needs investigation.

# Public API

- Quota queries live in `packages/app/convex/quotas.ts`.
- Use `api.quotas.get({ quotaName: "extra_organizations", userId })` for user quotas.
- Use `api.quotas.get({ quotaName: "extra_workspaces", organizationId })` for organization quotas.
- Use `api.quotas.get({ quotaName: "active_api_credentials", membershipId })` for the current user's active API credential quota in that membership's workspace.
- Use `api.quotas.get({ quotaName: "stored_file_bytes", membershipId })` for confirmed stored bytes. It returns `null` until the first charged publication.
- The three `files_private_*` quotas and the three `ai_chat_output_*` quotas also take `membershipId` and return `null` before first use. User quotas always resolve the authenticated user; workspace bytes require the caller's active membership. Passing another user's membership cannot reveal that user's counter.
- Returned objects are the persisted quota docs. Frontend callers derive remaining capacity from `usedCount` and `maxCount`, and use `packages/app/shared/quotas.ts` for quota-specific display copy.

# Tests

- Main coverage lives in `packages/app/convex/organizations.test.ts`.
- API credential counter coverage lives in `packages/app/convex/public_api.test.ts`.
- Shared admission and settlement tests live in `convex/files_stored_uploads.test.ts`. Each upload door also tests admission, publication, and replay. Service tests cover terminal oversized refusal and late-attempt cleanup.
- Account-deletion quota behavior is also covered in `packages/app/convex/data_deletion.test.ts` and `packages/app/convex/users.test.ts`.
- Tests and setup must seed quota docs through `quotas_db_ensure(...)` or the real user/membership bootstrap path before exercising the related quota write flow.
- Focused verification for this feature is:
	- `vp env exec pnpm --dir packages/app exec vitest run convex/organizations.test.ts`
	- `vp env exec pnpm --dir packages/app exec vitest run convex/data_deletion.test.ts convex/users.test.ts`
	- `vp env exec pnpm --dir packages/app exec vitest run convex/public_api.test.ts`

# Not quotas

The plugin document store keeps its own counters in `plugins_data_usage`, one doc per installation, and does not use the `quotas` table. Keep it that way. A quota is a product allowance the user can see and, in principle, buy more of; the plugin-data ceilings are safety limits on one plugin's storage, scoped to an installation that can disappear at any time. They also move in both directions — a reservation gives bytes back and a delete frees slots — while quota counters here are release-on-delete or monotonic by product rule. See `../plugin-system/SKILL.md` for the store's limits and accounting.

The slot ceiling among those limits is plan-driven: `db_resolve_document_slot_cap` in `plugins_data.ts` reads the organization owner's synced Polar product on every write (Free 10,000 slots, paid 100,000; unknown state reads as Free). The owner's plan sets one ceiling for every member. It still never touches the `quotas` table — there is no persisted `maxCount` to update on upgrade or downgrade, and the ceiling is not visible in `quotas.get`.

Stored plugin-data bytes are not billed. The byte and slot ceilings are the only limits; they are safety limits, not allowances the user can buy more of.

The per-member share in `plugins_data_member_usage` is the same kind of thing: a safety limit, not an allowance. It stops one member of a workspace from filling a shared installation on their own. `MEMBER_MAX_BYTES`, `MEMBER_MAX_DOCUMENT_SLOTS` and `MEMBER_MAX_COLLECTIONS` in `packages/app/convex/plugins_data.ts` are its constants, and a refusal carries the same `storage_full` name as the installation ceiling. Only the message tells the two apart, so a page that shows the refusal should show the server's message rather than one of its own.

**State its blast radius when you document it.** The share counts every document a member is charged for, and a shared document is charged to whoever wrote it last. So a member who reaches the slot share cannot patch **any** shared document in that installation — in Chitchat that means they can no longer rename or archive a channel, not only that they cannot send. Bytes a plugin backend wrote into a member's documents are tracked separately in `machineBytes` and do not count against the member, or a backend could fill a member's share and lock them out of a plugin they use.

Ordinary chat traffic moves no `quotas` counter at all. Nothing in the plugin document store touches the `quotas` table, so a workspace can write plugin documents all day and its quota docs never change.

## Plugin Mount storage limits

Mount storage uses `plugins_volume_usage`, one doc per installation, rather than `quotas`.
It counts published and staging generations: at most 20,000 files and 200,000,000 bytes per
installation. Each staging copy has a 5,000-file and 30,000,000-byte cap. Retiring a copy releases
its counts once; deletion later removes its files. At most 32 volumes belong to each mount and
128 volume docs belong to each installation. Deleting docs still count, including old mount IDs
dropped by an upgrade. This keeps uninstall marking and list reads bounded.

The daily limit is 10,000 new stored paths per UTC day. `plugins_volume_daily_files` is a fixed
window bucket with `start: 0`, keyed by organization, workspace and plugin name. Reinstalling
does not reset it. A replacement within the same staging copy uses no daily token. The writer
checks the count before R2 upload and consumes tokens in the final file transaction.
List reads recalculate saved bucket state using the request clock, so midnight resets cached state.
These limits are storage and cost brakes. They are not plan allowances.

## Cloud browser brakes

The cloud browser has daily brakes. They are safety limits against start and stop loops, not allowances. They never touch the `quotas` table, and the user cannot buy more. The daily-brake constants live in `packages/app/convex/files_browser.ts`.

- File mode: `BROWSER_DAILY_STARTS_MAX` (30 starts) and `BROWSER_DAILY_CAPTURES_MAX` (100 draft captures) per workspace per UTC day, counted in `files_browser_daily_use`.
- Web mode: `BROWSER_DAILY_WEB_STARTS_MAX` (50 starts) per user per UTC day, counted in `files_browser_user_daily_use`. The limit follows the user, not the workspace, so a user cannot get more starts by opening more workspaces. Web starts do not count against the workspace brake.
- A file start counts when its starting doc is created. A web start counts only when it commits. So a web start that the runner refused (busy, blocked address, failed open) does not count. A reattach to the live session does not count either.
- The refusal messages are `Daily browser start limit reached.` and `Daily browser capture limit reached.` in file mode, and `Daily limit reached` in web mode. The web Start card turns it into its own sentence.
- The sweep cron deletes old day docs of both tables. Account deletion drains the user's `files_browser_user_daily_use` docs.
- Concurrency caps live in the runner, not in `files_browser.ts` (`LIMITS` in `packages/browser-runner/src/index.ts`, checked by `BrowserRegistry`): at most 2 live browsers per user, 2 per workspace, 4 per organization, and 10 per deployment. `browser_open_refusal_message` turns `user_limit` into `You already have 2 browsers open in other workspaces. End one first.` and `organization_limit` into `Your organization already has 4 browsers open. Try again later.` A full workspace or deployment shows `Browser did not start`.

The browser's paid-plan check and its per-minute price are billing rules, not brakes. See `../billing-system/SKILL.md`.

# Guardrails

- Keep rate limiting separate; rate-limiter names, config, and copy still use rate-limit terminology.
- Apply the approved data policy to schema and quota changes. Private storage migration counts every retained physical resource, including retired work and unresolved deletion jobs, before enabling new admission. Existing over-cap work must remain readable, acceptable, and discardable.
- Cross-check tenancy/product rules with `../organizations-tenancy/SKILL.md`.
