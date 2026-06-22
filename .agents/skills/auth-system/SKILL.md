---
name: auth-system
description: Auth and account-management system (Clerk + Convex + anonymous JWT) guidelines, including Convex-authoritative account lifecycle, anagraphic-first UI profile data, and planned permissions/upgrade behavior. Use when modifying auth flows, account/profile UI, delete-account behavior, Clerk cleanup, or anonymous upgrade behavior.
---

# Overview

Auth and account-management design + implementation notes (Clerk + Convex + anonymous JWT), including current delete-account authority, profile data sourcing, and planned projects/workspaces/assets privacy model and upgrade migration behavior.

# Auth system (Clerk + Convex + anonymous JWT), and planned permissions model for projects/workspaces/assets.

# High-level goals (product + security)

## App-first account authority

Account lifecycle and delete authority live in Convex first.

- The app must not depend on "delete in Clerk first, then sync locally" for correctness.
- Clerk is the auth/session provider and external identity surface, not the source of truth for whether an app account still exists.

## Cache-friendly query reuse

Prefer reusing existing generic Convex queries instead of creating narrowly tailored wrapper queries for each UI surface.

- Convex query results are cached client-side and kept consistent via subscriptions.
- Reusing the same query + args lets multiple UI surfaces share that cache entry.
- In this repo, this means profile UIs should prefer `users.get_anagraphic({ userId })` when they only need anagraphic fields, instead of adding a new "current profile" wrapper query.
- Favor generic, composable queries that can be reused in multiple places over UI-specific "view model" queries.

## Frictionless onboarding

The user must be able to create content without signing in. This means the app must mint and use an anonymous identity early so content can be associated with a stable user record.

## Anonymous is not “secure”

Anonymous identities are not to be treated as safe. Even though the app uses a JWT flow for anonymous users, it is not treated as secure enough for sensitive content:

- Anonymous users should be warned not to store sensitive information.
- “Public write” (edit by link) is intentionally unsafe and must be treated as a capability-style risk (link leak = edit access).

## Upgrade must secure everything by default

When an anonymous user signs up (upgrades to a Clerk account), the default behavior must secure their resources:

- All workspaces/projects/assets become private.
- Only signed-in workspace/project members can access/edit.
- Any anonymous/public access must be re-enabled explicitly by the owner after upgrade.

# Current implementation (how auth works today)

## Provider wiring (frontend)

Auth is coordinated by `ClerkProvider` + `AppAuthProvider` + Convex auth integration.

- Entry point: [main.tsx](../../../packages/app/src/main.tsx)
- Auth provider: [app-auth.tsx](../../../packages/app/src/components/app-auth.tsx)
- Root route gating: [\_\_root.tsx](../../../packages/app/src/routes/__root.tsx)
- Convex client: [app-convex-client.ts](../../../packages/app/src/lib/app-convex-client.ts)

`AppAuthProvider` provides:

- `isAuthenticated`, `isLoaded`, `isAnonymous`, `userId`
- `getToken()` returning either:
  - a Clerk JWT (`template: "convex"`) when signed in, or
  - an anonymous JWT when not signed in

Convex consumes the auth source via `ConvexProviderWithAuth` using `useAuth={AppAuthProvider.useAuth}`.

## Two identity modes

### Clerk (signed-in)

- The frontend requests a Clerk JWT with `template: "convex"`.
- The app expects the JWT to include `external_id`, which is used as the canonical Convex `users` document id.
- During signed-in bootstrap, the frontend calls `/api/auth/resolve-user` to validate that `external_id` still points to a live Convex user doc. If `external_id` is missing or stale after a local/dev data reset, the route creates/links the Convex user and updates Clerk so future tokens include the current user id.

### Anonymous (not signed in)

- The frontend calls `/api/auth/anonymous` (or refreshes it) to mint/refresh an anonymous JWT.
- The JWT subject is the Convex `users` id.
- The anonymous JWT is stored in `localStorage` and re-used until refreshed/cleared.

Anonymous token caching keys (frontend):

- `app::auth::anonymous_token`
- `app::auth::anonymous_token_user_id`

## HTTP routes and responsibilities (Convex)

HTTP router entry: [http.ts](../../../packages/app/convex/http.ts)

Routes implemented in: [users.ts](../../../packages/app/convex/users.ts)

### `POST /api/auth/anonymous`

- With no body token: creates a new anonymous user record and mints a JWT.
- With `token`: refresh path:
  - extract user id from JWT
  - verify the provided token matches the stored token for that user
  - issue a new JWT and store it on the user record
- The create path is rate-limited by forwarded client IP headers with a stable fallback before minting a user/token. The refresh path is rate-limited by the resolved anonymous user id before reissuing a token. On deny the route returns `429` with `{ message: "Rate limit exceeded", retryAfterMs }`.

Anonymous JWT properties:

- `alg: ES256`
- `iss`: `VITE_CONVEX_HTTP_URL` (Convex env var)
- `aud`: `"convex"`
- `sub`: Convex `users` id
- expiry: `"30d"`

### `GET /.well-known/jwks.json`

Exposes public JWK(s) for the anonymous JWT signing key so JWT verifiers can validate anonymous tokens.

### `POST /api/auth/resolve-user`

Purpose: ensure a Clerk identity is linked to a Convex user id, and ensure Clerk `external_id` is set.

- Requires a valid Clerk-authenticated request (`ctx.auth.getUserIdentity()` must exist).
- If `identity.external_id` already exists and resolves to a live `users` doc, returns it without consuming the auth write rate limit.
- If `identity.external_id` is missing or points to a missing `users` doc, the route rate-limits by `identity.external_id` when present, otherwise by the Clerk subject. On deny it returns `429` with `{ message: "Rate limit exceeded", retryAfterMs }`.
- After the repair/create path is allowed:
  - calls internal mutation `internal.users.resolve_user` to find/create/link the Convex user
  - calls Clerk API to set `external_id` to the Convex user id

Internal mutation behavior:

- Signed-in `resolve_user` requires a non-empty Clerk email.
- Successful signed-in `resolve_user` paths persist the normalized email on the user anagraphic.
- If a tombstoned user exists for the same verified email:
  - the recovery key is the normalized signed-in email stored on the user anagraphic
  - reclaim that same Convex user row instead of creating a new one
  - clear `deletedAt`
  - re-link the new Clerk user id
  - reactivate memberships
  - remove the user-scope deletion request
  - return a restore marker so `/api/auth/resolve-user` can ask billing bootstrap to restore any Polar subscription still pending period-end cancellation
- If a different live user already owns the same normalized email:
  - return a recoverable conflict from `internal.users.resolve_user`
  - the HTTP route surfaces that conflict as `400`
- If `anonymousUserToken` is provided:
  - validates token and finds the anonymous user
  - links that same user record to the Clerk user (canonicalize anonymous into signed-in in place)
  - preserves the same Convex `users` id across upgrade
  - preserves the same default workspace/project in the normal upgrade path, so existing workspace/project memberships and data stay attached to the upgraded user
  - may delete other existing users for the same Clerk id so the anonymous record becomes canonical
- If no `anonymousUserToken`:
  - finds or creates a Convex user record for the Clerk user id

## Root route gating

The root layout waits for both:

- Convex auth to finish loading (`useConvexAuth().isLoading === false`)
- App auth provider to finish loading (`auth.isLoaded === true`)

If Convex is authenticated, the main app is rendered; otherwise an unauthenticated view is shown.

## Account management (current implementation)

### Profile data in the UI

Signed-in account UI should reuse `users.get_anagraphic({ userId })` with `auth.userId`.

- This is intentional so the sidebar and account modal share the same Convex query cache entry.
- UI fallbacks stay in the component layer:
  - anagraphic first
  - then Clerk display fields / image
  - anonymous synthetic display name when needed

Relevant files:

- [main-app-sidebar-account-control.tsx](../../../packages/app/src/components/main-app-sidebar-account-control.tsx)
- [main-app-account-management.tsx](../../../packages/app/src/components/main-app-account-management.tsx)
- [users.ts](../../../packages/app/convex/users.ts)

### Delete-account authority

`users.delete_current_user_account` is Convex-authoritative:

- apply the local app tombstone first
- then attempt Clerk cleanup as best-effort follow-up
- do not fail the app-local deletion just because Clerk deletion failed
- rate-limit the user-facing action by current user id before starting local deletion, Clerk cleanup, or billing cancellation work. Result callers receive `_nay.message === "Rate limit exceeded"` when throttled.
- before tombstoning, the frontend and backend user-facing action must block while the current user still owns non-personal workspaces that are not already queued for workspace deletion. Account management lets users either follow a `Transfer ownership` link to the workspace Users page or explicitly confirm deleting the workspace through the normal delete-workspace mutation, then retries account deletion.

Related files:

- [users.ts](../../../packages/app/convex/users.ts)
- [data_deletion.ts](../../../packages/app/convex/data_deletion.ts)

### Account deletion and workspace/project data cleanup

User-account deletion is implemented across [users.ts](../../../packages/app/convex/users.ts) and [data_deletion.ts](../../../packages/app/convex/data_deletion.ts):

- `users.delete_current_user_account` is the UI-facing entrypoint.
- `users.list_current_user_account_deletion_blocking_workspaces` is the current-user preflight query for account management. It returns owned non-personal workspaces where `workspaces.ownerUserId` is the current user and no `scope: "workspace"` deletion request is already queued, with the default project doc so the UI can link to the workspace Users page.
- `users.delete_current_user_account` repeats that blocker check and returns `_nay.message === "Resolve owned workspaces before deleting account"` when blockers remain. Do this before local tombstoning, Clerk cleanup, or billing cancellation work.
- `access_control.transfer_workspace_ownership` remains the ownership-transfer endpoint on the regular workspace Users page. Account management links there for transfers instead of duplicating the transfer flow inline. `workspaces.delete_workspace` remains the workspace deletion endpoint and account management may call it inline after explicit per-workspace confirmation.
- Transferring ownership preserves the shared workspace for active members because the owner row and quota usage change before the user tombstone starts.
- `internal.data_deletion.init_user_deletion` remains owned-workspace-aware for internal/admin lifecycle paths. If it is called directly for a user that still owns non-personal workspaces, it queues those workspaces for deletion, immediately removes that workspace’s memberships and access-control rows, then leaves the heavy tenant content purge to the existing delayed workspace deletion worker.
- The reversible user phase creates or reuses the `scope: "user"` row in `data_deletion_requests`, sets `users.deletedAt`, marks remaining memberships inactive, and removes the user from every room tracked by the `@convex-dev/presence` component (via `components.presence.public.listUser` + `removeRoomUser`).
- Phase 1 does not delete projects, workspaces, files, or billing usage snapshots.
- `billing_usage_snapshots` must be preserved whenever the Convex `users` row is retained, including retained tombstones. Delete the snapshot only when the user record is purged or when Polar customer deletion is part of that full purge.
- Phase 1 also does not backfill or repair missing anagraphic email; deleted-account recovery only works for users whose normalized email was already stored before deletion.
- `users.delete_current_user_account` also enqueues retryable cleanup work that truly cancels any paid Polar subscription at the close of the current billing period. This is deletion cleanup, not normal billing-panel cancellation; normal user subscription cancellation downgrades to `Free`. Keep subscription mirror rows Polar-owned until Polar reports the subscription/customer lifecycle change.
- `data_deletion.process_user_deletion_request` is the destructive phase 2 step that runs after the fixed retention period (or explicit `eligibleAt`) and advances hard deletion through the same retryable, Workpool-orchestrated batched worker used by project/workspace purge.
- `users.hard_delete_user_now` is the direct admin path for immediate local hard deletion or reset. Its `purgeUserMod` defaults to `"data"`:
- `"data"` is an account data reset for local/admin cleanup. It keeps the user doc usable, preserves Clerk and anonymous auth state, preserves profile and billing/customer state, cancels the user-scope deletion request, keeps resource-scope queue docs until the reset consumes or clears them, ensures a usable `personal` / `home` default tenant, and then loops the limited project/workspace purge worker until the reset-owned data is gone. The default workspace/project docs remain, content inside the default project is purged, extra personal projects are deleted, and non-default workspaces/projects are deleted only when the reset user is the only active participant in that tenant scope.
- `"data_and_auth"` deletes tenant/user data and auth state, attempts Clerk deletion, removes anonymous auth tokens, keeps the final tombstoned user row, preserves `billing_usage_snapshots`, enqueues the same retryable period-end cancellation used by the normal delete flow, and drains or schedules any queued tenant purge requests through the Workpool-backed worker.
- `"data_auth_and_user_record"` deletes tenant/user data and auth state, revokes the Polar subscription immediately, deletes the Polar customer immediately, deletes the local `billing_usage_snapshots` row, drains or schedules any queued tenant purge requests through the Workpool-backed worker, and then purges the final local tombstone. Local Polar customer mapping and local subscription rows are cleared through Polar deletion webhooks (`customer.updated`/`customer.state_changed` with `deleted_at`, or `customer.deleted`).
- Restoring a deleted account during retention reclaims the same Convex user row, removes the user deletion request, reactivates memberships, and marks the auth response so billing bootstrap can undo a deletion-triggered Polar period-end cancellation while Polar still allows it. If the prior subscription has fully ended, billing bootstrap creates a new `Free` subscription rather than recreating a paid plan.

For the full workspace/project deletion and purge lifecycle, use the canonical tenancy skill: [workspaces-tenancy: Workspace and project deletion and data purge](../workspaces-tenancy/SKILL.md#workspace-and-project-deletion-and-data-purge).

### Clerk cleanup role

There is no Clerk deletion webhook safety-net in the current architecture. Account deletion is app-driven:

- apply the local Convex deletion flow first
- attempt Clerk user deletion as best-effort follow-up
- do not recreate an app-local delete request from external Clerk events

## Current workspace/project system

**Canonical detail:** see [workspaces-tenancy skill](../workspaces-tenancy/SKILL.md) (schema vs API guards, `personal`/`home`, rename/delete, invitations, [deletion and purge](../workspaces-tenancy/SKILL.md#workspace-and-project-deletion-and-data-purge), anonymous-upgrade tenancy continuity, and `ensure` semantics).

Summary:

- Tables: `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `access_control_role_assignments`, `access_control_permission_grants`, `notifications`, `data_deletion_requests`; `users.defaultWorkspaceId` / `defaultProjectId`.
- Bootstrap: `create_anonymous_user` and `resolve_user` call `workspaces_db_ensure_default_workspace_and_project_for_user`.
- The default `personal` workspace is private. Invites/member-management writes reject it.
- Non-personal workspace ownership lives in `workspaces.ownerUserId`; a mirrored default-project owner role assignment remains for role display and access-control compatibility.
- **Implementation note:** Many app surfaces may still use older hardcoded workspace/project ids outside this tenancy module—verify callsites.

Authorization helpers in `workspaces.ts` call the backend access-control permission checker. Frontend guards and full permission-management UI are intentionally incremental follow-up work.

# Planned functionality (not fully implemented yet)

## Projects and workspaces

The app is organized into projects and workspaces so users can organize assets flexibly.

When an anonymous user is created:

- A personal workspace and home project must be created as well.
- V1 invitations are immediate in-app access for existing signed-in users by exact email. No outbound email is sent.

## Public vs private semantics

### “Public” is link-only

Public access is implemented by possessing the asset id in a URL (not indexable content, no separate share token).

### Public workspace/project

If the workspace/project is public:

- anonymous collaborators can be invited
- anonymous collaborators can have permissions like any other user id (subject to the permission system)

### Public asset

If an asset is public:

- it can be accessed by anonymous users without an invite
- the owner can choose whether anonymous users can write or only read

Important: “public write” means anyone who knows the asset id can write (shared edit capability).

## Granular permissions system

Canonical access-control details live in `../access-control/SKILL.md`.

Permissions are represented by allow-only rows in `access_control_permission_grants`. Grants can target roles, specific users, or public access for `workspace`, `project`, `page`, and `thread` resources.

Current roles are `owner`, `admin`, and `member`. The owner is a system role on the workspace default project with full workspace authority; admin/member authority is represented by seeded grant rows. Direct user and public grants allow asset-level access without changing a user’s role.

The owner may:

- allow anonymous users to write on a public asset (edit-by-link)
- allow anonymous users to read only
- grant write permissions to a specific anonymous user id (while keeping others read-only)

## Upgrade behavior (anonymous → signed-in)

When the user upgrades by signing up (Clerk-authenticated, linked to Convex user id):

- The anonymous user record is linked to the Clerk identity in place.
- The same Convex `users` id remains canonical after upgrade.
- The user keeps the same default workspace/project and therefore keeps the same associated workspace/project-scoped data in the normal upgrade path.
- The user must not be able to access the same private resources while logged out.
- Default security migration:
  - all workspaces become private
  - all projects become private
  - all assets become private
  - all anonymous write access is removed
  - all anonymous/public access is removed by default

The owner can later re-publicize assets explicitly.

# Implementation constraints (to follow when modifying this system)

When the user requests changes in this area, you must:

# Preserve the canonical user id design

- The canonical app identity is the Convex `users` document id.
- Clerk `external_id` is used as a pointer to that Convex user id in tokens.
- Trust Clerk session invalidation after delete. Do not add extra app-side session-state checks or deleted-user guards just to defend against a supposedly still-valid Clerk session.

# Current app user resolution

When a public Convex handler needs the current live app user, resolve auth with `server_convex_get_user_fallback_to_anonymous(ctx)` and then load the `users` row by the returned `id`. Treat both missing pieces as `Unauthenticated`:

- Convex auth returns no usable identity.
- Convex auth returns a user id, but that id does not resolve to a row in the `users` table.

Reserve `Unauthorized` for a resolved app user who lacks permission for a resource. Use `Not found`, `User not found`, or a more specific message for target resources or target users, not for the current caller principal.

`server_convex_get_user_fallback_to_anonymous` intentionally does not load the `users` table; see [server-utils.ts](../../../packages/app/server/server-utils.ts). Handlers that require the current app account own the row-existence check. Current examples include [users.delete_current_user_account](../../../packages/app/convex/users.ts) and [workspaces.get_membership_by_workspace_project_name](../../../packages/app/convex/workspaces.ts).

For `Result`-returning handlers:

```ts
const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((user) => {
	if (!user) {
		return null;
	}

	return ctx.runQuery(internal.users.get, {
		userId: user.id,
	});
});
if (!user) {
	return Result({
		_nay: {
			message: "Unauthenticated",
		},
	});
}
```

For query handlers that use Convex errors:

```ts
const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((user) => {
	if (!user) {
		return null;
	}

	return ctx.db.get("users", user.id);
});

if (!user) {
	throw convex_error({ message: "Unauthenticated" });
}
```

If a handler intentionally treats a missing/deleted current user row as stale client state or as an idempotent no-op, leave a short comment explaining that product-specific exception at the branch.

# Prefer cache-friendly query composition

- Reuse existing generic queries before creating new wrapper queries.
- Treat Convex query cache reuse as more important than minimizing the number of client-side query calls.
- Multiple small queries are often better than one wide query when they can be reused across screens and remain cached independently.
- Parallel client-side queries are fine.
- Even 2-3 levels of UI waterfalls can be preferable to a single complex query whose cache gets busted more often.
- Prefer narrow, stable, reusable query shapes. Add a new specialized query only when the combined server-side shape is truly the shared domain API, not just a convenience for one screen.
- Keep provider-specific fallback logic in the client when doing so preserves reuse of generic app-owned queries.

# Keep anonymous flows robust

- Anonymous token fetch must be resilient and should not crash the app.
- Token suppliers used by Convex should resolve (not reject) so auth state can transition cleanly.

# Treat “public write” as intentionally unsafe

- Do not accidentally enable public write by default.
- When implementing the upgrade migration, ensure “everything becomes private” is enforced.

# Verification touchpoints

- If you change delete-account behavior, update [data_deletion.test.ts](../../../packages/app/convex/data_deletion.test.ts) and [users.test.ts](../../../packages/app/convex/users.test.ts).
- If you change profile/anagraphic usage or fallback behavior materially, update [users.test.ts](../../../packages/app/convex/users.test.ts).

# TODO / known gaps

- Deleted-account recovery currently supports only the same verified email path. Changed-email recovery or manual account merge is not implemented.
