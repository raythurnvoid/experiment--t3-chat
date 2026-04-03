---
name: auth-system
description: Auth and account-management system (Clerk + Convex + anonymous JWT) guidelines, including Convex-authoritative account lifecycle, anagraphic-first UI profile data, and planned permissions/upgrade behavior. Use when modifying auth flows, account/profile UI, delete-account behavior, Clerk cleanup/webhooks, or anonymous upgrade behavior.
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
- If `external_id` is missing, the frontend calls `/api/auth/resolve-user` to create/link the Convex user and then updates Clerk so future tokens include `external_id`.

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
- If `identity.external_id` already exists, returns it.
- Otherwise:
  - calls internal mutation `internal.users.resolve_user` to find/create/link the Convex user
  - calls Clerk API to set `external_id` to the Convex user id

Internal mutation behavior:

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

Related files:

- [users.ts](../../../packages/app/convex/users.ts)
- [account_deletion.ts](../../../packages/app/convex/account_deletion.ts)

### Account deletion and workspace/project data cleanup

User-account deletion is implemented in [account_deletion.ts](../../../packages/app/convex/account_deletion.ts): it tombstones the user, clears memberships and user-scoped rows, and immediately resolves any now-orphaned workspaces so their project structure is deleted before the purge cron runs.

For the full workspace/project deletion and purge lifecycle, use the canonical tenancy skill: [workspaces-tenancy: Workspace and project deletion and data purge](../workspaces-tenancy/SKILL.md#workspace-and-project-deletion-and-data-purge).

### Clerk webhook role

`record_clerk_user_deleted_webhook` is a safety net only.

- The webhook must not create a brand-new authoritative delete request if the app did not already decide to delete the user.

## Assistant UI token generation (Convex action)

File: [auth.ts](../../../packages/app/convex/auth.ts)

The action `generate_assistant_ui_token` uses `ctx.auth.getUserIdentity()` to decide the `userId`/`workspaceId` for Assistant UI Cloud tokens:

- Clerk user: uses `identity.external_id` (must exist)
- Anonymous user: detected by `identity.issuer === VITE_CONVEX_HTTP_URL`, uses `identity.subject`
- No identity: falls back to [shared-auth-constants.ts](../../../packages/app/shared/shared-auth-constants.ts) for `anonymous`

## Current workspace/project system

**Canonical detail:** see [workspaces-tenancy skill](../workspaces-tenancy/SKILL.md) (schema vs API guards, `personal`/`home`, rename/delete, invitations, [deletion and purge](../workspaces-tenancy/SKILL.md#workspace-and-project-deletion-and-data-purge), anonymous-upgrade tenancy continuity, and `ensure` semantics).

Summary:

- Tables: `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `workspaces_data_deletion_requests`; `users.defaultWorkspaceId` / `defaultProjectId`.
- Bootstrap: `users_create_anonymous_user` and `resolve_user` call `workspaces_db_ensure_default_workspace_and_project_for_user`.
- **Implementation note:** Many app surfaces may still use older hardcoded workspace/project ids outside this tenancy module—verify callsites.

Authorization stubs in `workspaces.ts` (`user_is_workspace_admin`, `user_is_project_admin`) are temporary; replace for real RBAC.

# Planned functionality (not fully implemented yet)

## Projects and workspaces

The app is organized into projects and workspaces so users can organize assets flexibly.

When an anonymous user is created:

- A project and workspace must be created as well.
- Other users (including anonymous, depending on visibility) can be invited into the project/workspace.

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

Permissions are intended to be granular and set per-asset and optionally per-user id (including anonymous user ids).

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

- If you change delete-account or webhook behavior, update [account_deletion.test.ts](../../../packages/app/convex/account_deletion.test.ts).
- If you change profile/anagraphic usage or fallback behavior materially, update [users.test.ts](../../../packages/app/convex/users.test.ts).
