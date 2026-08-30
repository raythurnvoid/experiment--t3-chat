---
name: auth-system
description: Auth and account-management system (Clerk + Convex + anonymous JWT + plugin-session JWT) guidelines, including Convex-authoritative account lifecycle, anagraphic-first UI profile data, and planned permissions/upgrade behavior. Use when modifying auth flows, account/profile UI, delete-account behavior, Clerk cleanup, or anonymous upgrade behavior.
---

# Product And Security Invariants

## App-first account authority

Account lifecycle and delete authority live in Convex first.

- The app must not depend on "delete in Clerk first, then sync locally" for correctness.
- Clerk is the auth/session provider and external identity surface, not the source of truth for whether an app account still exists.

## Cache-friendly query reuse

Prefer reusing existing generic Convex queries instead of creating narrowly tailored wrapper queries for each UI surface.

- Convex query results are cached client-side and kept consistent via subscriptions.
- Reusing the same query + args lets multiple UI surfaces share that cache entry.
- `users.get_anagraphic` requires an authenticated identity — anonymous accounts included — and returns `null` without one. Cross-user calls are fine and deliberate: it accepts any `users` id and returns the display name and avatar, because those render beside file edits, snapshots and notifications where the caller often shares no tenant with the person named.
- `email` is the exception, and the decision is settled: it comes back only when you ask about yourself, and is `""` for everyone else. `""` is the value anonymous users already carry, so every reader already has a no-email branch. Do not widen the query to "fix" a caller that wants somebody else's address. Same-workspace callers use `users.get_workspace_member_anagraphic({ organizationId, workspaceId, userId })`, which proves both people are active members of that workspace before it returns the address.
- Favor generic, composable queries only when their authorization and returned fields are safe for every intended caller.

## Frictionless onboarding

The user must be able to create content without signing in. This means the app must mint and use an anonymous identity early so content can be associated with a stable user record.

## Anonymous is not “secure”

Anonymous identities are not to be treated as safe. Even though the app uses a JWT flow for anonymous users, it is not treated as secure enough for sensitive content:

- Anonymous users should be warned not to store sensitive information.
- “Public write” (edit by link) is intentionally unsafe and must be treated as a capability-style risk (link leak = edit access).

## Upgrade must secure everything by default

When an anonymous user signs up (upgrades to a Clerk account), the default behavior must secure their resources:

- All organizations/workspaces/assets become private.
- Only signed-in organization/workspace members can access/edit.
- Any anonymous/public access must be re-enabled explicitly by the owner after upgrade.

# Current Auth Flow

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
  - a short-lived anonymous access JWT when not signed in

Convex consumes the auth source via `ConvexProviderWithAuth` using `useAuth={AppAuthProvider.useAuth}`.

## Three token identities

`auth.config.ts` verifies three providers: Clerk, the anonymous custom JWT, and the plugin-session custom JWT. Only the first two are member identities; the third is deliberately refused by member functions.

### Clerk (signed-in)

- The frontend requests a Clerk JWT with `template: "convex"`.
- The app expects the JWT to include `external_id`, which is used as the canonical Convex `users` document id.
- During signed-in bootstrap, the frontend calls `/api/auth/resolve-user` to validate that `external_id` still points to a live Convex user doc. If `external_id` is missing or stale after a local/dev data reset, the route creates/links the Convex user and updates Clerk so future tokens include the current user id.

### Anonymous (not signed in)

The design is the standard OAuth token split: a long-lived refresh token that only the token endpoint accepts, and a short-lived access token used on API calls (RFC 6749 §1.5; rotation guidance in RFC 9700 §4.14 "Refresh Token Protection"). The `previousToken` grace field below is the industry mitigation for rotation races — Auth0's refresh-token-rotation docs call it the "reuse interval": strict one-time-use rotation breaks multi-tab apps, so the just-replaced token stays accepted until the next rotation.

Anonymous auth uses two JWTs signed with the same key, split by audience:

- The **refresh token** (`aud "anonymous-refresh"`, 30 days) lives in `localStorage` and is also stored byte-for-byte in `users_anon_tokens`. It only works against `/api/auth/anonymous`, where it is checked against that table. Convex rejects it because `auth.config.ts` only accepts `aud "convex"`.
- The **access token** (`aud "convex"`, 1 hour) is what Convex actually verifies. It is minted by pure signing (no table read) and lives only in memory; the Convex client asks for a new one shortly before expiry. The one-hour life is the revocation window: deleting the anonymous user stops the next refresh, so a revoked identity dies within the hour.
- Both JWTs carry the Convex `users` id as `sub` and the `users_anon_tokens` id as `jti`.

Client behavior on refresh failure (`auth_get_anonymous_convex_token` in [app-auth.tsx](../../../packages/app/src/components/app-auth.tsx)):

- Only a `401` or `400` clears both localStorage keys and mints a fresh anonymous user, because only those mean the server read the refresh token and refused it (stale dev-reset token, deleted user, pre-split token).
- On a `429`, a `5xx` or a network failure the client keeps the stored refresh token and retries with backoff (it honors `retryAfterMs`, caps waits at 30s, and re-reads localStorage before each attempt). It must never resolve `null` there: the Convex client treats `null` as "signed out for sure" and never asks again, and the refresh token cannot stand in for an access token because Convex rejects its audience.

Anonymous token caching keys (frontend, refresh token only — the access token is never stored):

- `app::auth::anonymous_token`
- `app::auth::anonymous_token_user_id`

## HTTP routes and responsibilities (Convex)

HTTP router entry: [http.ts](../../../packages/app/convex/http.ts)

Routes implemented in: [users.ts](../../../packages/app/convex/users.ts)

### `POST /api/auth/anonymous`

- With no body: creates a new anonymous user record and responds `{ token, refreshToken, userId }` (access JWT, refresh JWT, users id).
- With `refreshToken`: refresh path:
  - decode the JWT (no signature check on this path) and refuse it with `401` unless its audience contains `"anonymous-refresh"`. This check is load-bearing, not defense in depth: validity comes from byte-equality with the stored row, and a pre-split dual-role JWT (aud `"convex"`) still byte-matches its row — only the audience check retires those.
  - load the `users_anon_tokens` row and require the presented token to byte-match `token` **or** `previousToken`. The grace field exists because two tabs share one localStorage: a tab that read it just before a rotation must converge instead of losing the identity.
  - the row lookup rejects a tombstoned user (`users.deletedAt`), so a deleted anonymous user cannot refresh.
  - always mint a fresh 1-hour access JWT (pure signing, no table write).
  - rotate the stored refresh JWT only when the presented token is the current one and is inside its last 7 days. Rotation goes through a compare-and-swap (`set_anonymous_auth_token` with `expectedCurrentToken`): if another tab rotated first, the route returns the winner's token and the client converges on it. The replaced token becomes `previousToken`.
  - respond `{ token, refreshToken, userId }`; `refreshToken` is the stored current token (rotated or not).
- The create path is rate-limited by forwarded client IP headers with a stable fallback before minting a user/token. On deny the route returns `429` with `{ message: "Rate limit exceeded", retryAfterMs }`.
- The refresh path is rate-limited by the resolved anonymous user id. Every refresh spends `auth_http_refresh` (capacity 10), which is deliberately well above a normal page load: a load validates the stored token at least twice, and charging that to the strict `auth_http` bucket (capacity 2) made ordinary reloads return `429`. Rotation is a write, so it also spends `auth_http`.

### Anonymous deletion: closed and remaining gaps

**Closed:**

- The refresh lookup checks `users.deletedAt` (`get_with_anagraphic_and_anonymous_auth_token`), so a tombstoned anonymous user cannot mint fresh tokens. Covered by a test asserting `401`.
- The token split caps how long a pre-tombstone token keeps working. Convex only accepts the 1-hour access JWT, so after a tombstone the identity dies as soon as the current access token expires and the next refresh is refused — within the hour, instead of the old 30 days.
- The anonymous-to-Clerk upgrade path refuses a tombstoned anonymous source (`resolve_user` treats it like a missing user), so sign-in cannot resurrect a deleted account through the anonymous link.

**Still open:**

- `server_convex_get_user_fallback_to_anonymous` trusts the JWT subject without loading a live user doc, so account-level writes inside the remaining 1-hour window still pass handlers that check nothing else. Require a live user doc for anonymous account-level writes (see "Current app user resolution" below).
- Rotating the signing `kid` would invalidate every outstanding access token at once, but it is a production-incident lever, not a routine tool: Convex caches `/.well-known/jwks.json` per its `Cache-Control: public, max-age=86400`, so a new kid can be unverifiable for up to a day. Do not bump the kid to "reset" dev identities; the refresh route's audience check already retires pre-split tokens without touching the key.

Anonymous JWT properties (both tokens, signed with the same ES256 key):

- `alg: ES256`, `iss`: `VITE_CONVEX_HTTP_URL` (Convex env var), `sub`: Convex `users` id, `jti`: `users_anon_tokens` id
- access token: `aud "convex"`, expiry `"1h"`
- refresh token: `aud "anonymous-refresh"`, expiry `"30d"`

### Plugin-session (plugin UI iframes)

A plugin-session JWT identifies a person with fewer permissions: the member behind a plugin UI iframe. It is signed with the same ES256 key as the anonymous tokens and served by the same JWKS; the issuer `${VITE_CONVEX_HTTP_URL}/plugins-ui` is the only discriminator, because Convex never exposes `aud` to app code. Its `sub` is the `plugins_ui_sessions` id, not a `users` id — every plugin-facing door loads that session doc on each run, so revoking or expiring the session kills the identity even while the JWT is still signed-valid.

The classifier in [server-utils.ts](../../../packages/app/server/server-utils.ts) is fail-closed: `server_convex_get_user_fallback_to_anonymous` returns `null` for this issuer, so member functions treat a plugin frame as unauthenticated. That covers both frame kinds. A plugin page and a file view mint from the same `plugins_ui_sessions` table and carry the same issuer, so the classifier cannot tell them apart, and `server_convex_get_plugin_session` hands back only the session id — no frame kind. Only that helper resolves this issuer, and only the plugin-facing doors call it. The classifier treats every unknown issuer as Clerk, so adding a fourth provider to `auth.config.ts` requires extending the classifier first — both files carry a comment saying so.

The SDK obtains this JWT by exchanging the host-minted UI session token (`plu_...`, minted for a page and for a file view alike) at `POST /plugins-ui/session-jwt` (10-minute life, capped at session expiry; the exchange never extends the session). Full exchange-route contract and door model: `../plugin-system/SKILL.md`.

### `GET /.well-known/jwks.json`

Exposes public JWK(s) for the shared ES256 signing key so JWT verifiers can validate anonymous and plugin-session tokens.

### `POST /api/auth/resolve-user`

Purpose: ensure a Clerk identity is linked to a Convex user id, and ensure Clerk `external_id` is set.

- Requires a valid Clerk-authenticated request (`ctx.auth.getUserIdentity()` must exist).
- Refuses the anonymous and plugin-session issuers explicitly with `401`. This route links Clerk accounts, so a custom-JWT identity here would be misread as a Clerk user id; the old protection (those tokens carry no email) was an accident, not a rule.
- If `identity.external_id` resolves to a non-tombstoned `users` doc with both default-tenant pointer fields set, returns it without consuming the auth write rate limit. This fast path checks that the pointers are present, not that their target docs exist.
- If `identity.external_id` is missing or points to a missing `users` doc, the route rate-limits by `identity.external_id` when present, otherwise by the Clerk subject. On deny it returns `429` with `{ message: "Rate limit exceeded", retryAfterMs }`.
- After the repair/create path is allowed:
  - calls internal mutation `internal.users.resolve_user` to find/create/link the Convex user
  - calls Clerk API to set `external_id` to the Convex user id

Internal mutation behavior:

- Signed-in `resolve_user` requires a non-empty Clerk email.
- Successful signed-in `resolve_user` paths persist the normalized email on the user anagraphic.
- If a tombstoned user exists for the same verified email:
  - the recovery key is the normalized signed-in email stored on the user anagraphic
  - if `users.deletionFinalizationStartedAt` is set, return `Account deletion is being finalized` instead of restoring; the HTTP route maps this retryable state to `400`
  - reclaim that same Convex user row instead of creating a new one
  - clear `deletedAt`
  - re-link the new Clerk user id
  - reactivate ordinary inactive memberships, but skip rows marked `pendingOrganizationRemoval`
  - remove the user-scope deletion request
  - return a restore marker so `/api/auth/resolve-user` can ask billing bootstrap to restore any Polar subscription still pending period-end cancellation
- If a different live user already owns the same normalized email:
  - return a recoverable conflict from `internal.users.resolve_user`
  - the HTTP route surfaces that conflict as `400`
- A live Clerk-linked user takes precedence, even when `anonymousUserToken` is supplied.
- Anonymous upgrade runs only when no live Clerk-linked user and no same-email deleted account was selected. In that case, it validates the token, upgrades the anonymous user in place, preserves the same Convex `users` id, and keeps its default organization/workspace plus attached data.
- The current upgrade path does not delete another live Clerk-linked user.
- Product policy has not decided whether a returning Clerk user should keep winning or whether anonymous data should merge into that existing account. If this precedence changes, use full dependent cleanup or an explicit merge; do not rely on raw user-row deletion.
- If no `anonymousUserToken`:
  - finds or creates a Convex user record for the Clerk user id

## Root route gating

The root layout waits for:

- Convex auth to finish loading (`useConvexAuth().isLoading === false`)
- App auth provider to finish loading (`auth.isLoaded === true`)
- for a signed-in user, the current subscription and usage snapshot bootstrap queries to finish

It renders the main app only when App auth and Convex auth are both authenticated. After loading, an unhealthy auth state throws `Failed to start session` to the route error boundary.

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
- before tombstoning, the frontend and backend user-facing action must block while the current user still owns non-personal organizations that are not already queued for organization deletion. Account management lets users either follow a `Transfer ownership` link to the organization Users page or explicitly confirm deleting the organization through the normal delete-organization mutation, then retries account deletion.

Related files:

- [users.ts](../../../packages/app/convex/users.ts)
- [data_deletion.ts](../../../packages/app/convex/data_deletion.ts)

### Account deletion and organization/workspace data cleanup

User-account deletion is implemented across [users.ts](../../../packages/app/convex/users.ts) and [data_deletion.ts](../../../packages/app/convex/data_deletion.ts):

- `users.delete_current_user_account` is the UI-facing entrypoint.
- `users.list_current_user_account_deletion_blocking_organizations` is the current-user preflight query for account management. It returns owned non-personal organizations where `organizations.ownerUserId` is the current user and no `scope: "organization"` deletion request is already queued, with the default workspace doc so the UI can link to the organization Users page.
- `users.delete_current_user_account` repeats that blocker check and returns `_nay.message === "Resolve owned organizations before deleting account"` when blockers remain. Do this before local tombstoning, Clerk cleanup, or billing cancellation work.
- `access_control.transfer_organization_ownership` remains the ownership-transfer endpoint on the regular organization Users page. Account management links there for transfers instead of duplicating the transfer flow inline. `organizations.delete_organization` remains the organization deletion endpoint and account management may call it inline after explicit per-organization confirmation.
- Transferring ownership preserves the shared organization for active members because the owner field and quota usage change before the user tombstone starts.
- `internal.data_deletion.init_user_deletion` remains owned-organization-aware for internal/admin lifecycle paths. If it is called directly for a user that still owns non-personal organizations, it queues those organizations for deletion, immediately removes that organization’s memberships and access-control docs, then leaves the heavy tenant content purge to the existing delayed organization deletion worker.
- The reversible user phase creates or reuses the `scope: "user"` row in `data_deletion_requests`, sets `users.deletedAt`, marks remaining memberships inactive, and removes the user from every room tracked by the `@convex-dev/presence` component (via `components.presence.public.listUser` + `removeRoomUser`).
- Phase 1 does not delete workspaces, organizations, files, or billing usage snapshots.
- `billing_usage_snapshots` must be preserved whenever the Convex `users` row is retained, including retained tombstones. Delete the snapshot only when the user record is purged or when Polar customer deletion is part of that full purge.
- Phase 1 also does not backfill or repair missing anagraphic email; deleted-account recovery only works for users whose normalized email was already stored before deletion.
- `users.delete_current_user_account` also enqueues retryable cleanup work that truly cancels any paid Polar subscription at the close of the current billing period. This is deletion cleanup, not normal billing-panel cancellation; normal user subscription cancellation downgrades to `Free`. Keep subscription mirror rows Polar-owned until Polar reports the subscription/customer lifecycle change.
- `data_deletion.process_user_deletion_request` is the destructive phase 2 step that runs after the fixed retention period (or explicit `eligibleAt`) and advances hard deletion through the same retryable, Workpool-orchestrated batched worker used by organization/workspace purge.
- `users.hard_delete_user_now` is the direct admin path for immediate local hard deletion or reset. Its `purgeUserMod` defaults to `"data"`:
- `"data"` is an account data reset for local/admin cleanup. It keeps the user doc usable, preserves Clerk and anonymous auth state, preserves profile and billing/customer state, cancels the user-scope deletion request, keeps resource-scope queue docs until the reset consumes or clears them, and ensures a usable `personal` / `home` default tenant. The action runs bounded batches and schedules the same user/mode if more reset-owned data remains; callers invoke it once and wait for reset readback before reseeding.
- `"data_and_auth"` tombstones the local user before provider cleanup, drains user-owned plugin UI sessions and publisher docs, schedules period-end Polar cancellation, deletes Clerk auth, finalizes local data/auth, keeps the tombstone and `billing_usage_snapshots`, then enqueues the tenant-deletion Workpool once when resource requests remain.
- `"data_auth_and_user_record"` tombstones the local user before provider cleanup, drains user-owned plugin UI sessions and publisher docs, revokes the Polar subscription, deletes the Polar customer, deletes Clerk auth, and finalizes local data/auth/billing state. Its final local mutation durably schedules any tenant cleanup and atomically deletes the anagraphic and user, so same-email recovery cannot run between fence removal and record purge. A plugin review still linked from a global version is kept with its creator cleared; an unreferenced review is deleted. Polar and Clerk deletes treat their supported already-missing states as successful retries.
- `hard_delete_user_now` returns `null`. It never processes the global deletion queue inline: bounded user-local continuation stays on the same action, while organization/workspace continuation belongs only to `data_deletion_workpool`.
- Restoring a deleted account before destructive finalization starts, or after retained-tombstone finalization succeeds, reclaims the same Convex user row, removes the user deletion request, reactivates ordinary inactive memberships, and marks the auth response so billing bootstrap can undo a deletion-triggered Polar period-end cancellation while Polar still allows it. While bounded finalization is active, `users.deletionFinalizationStartedAt` blocks recovery. The queued worker and admin hard-delete path set it before the first destructive batch and keep it through every indexed user-family and tenant-request continuation and through provider failures. The final small local transaction either clears it for a retained tombstone or removes the identity for a full user-record purge. Memberships marked `pendingOrganizationRemoval` stay inactive and receive no recreated role because that removal drain must finish. If the prior subscription has fully ended, billing bootstrap creates a new `Free` subscription rather than recreating a paid plan.

For the full organization/workspace deletion and purge lifecycle, use the canonical tenancy skill: [organizations-tenancy: Organization and workspace deletion and data purge](../organizations-tenancy/SKILL.md#organization-and-workspace-deletion-and-data-purge).

### Clerk cleanup role

There is no Clerk deletion webhook safety-net in the current architecture. Account deletion is app-driven:

- apply the local Convex deletion flow first
- attempt Clerk user deletion as best-effort follow-up
- do not recreate an app-local delete request from external Clerk events

## Current organization/workspace system

**Canonical detail:** see [organizations-tenancy skill](../organizations-tenancy/SKILL.md) (schema vs API guards, `personal`/`home`, rename/delete, invitations, [deletion and purge](../organizations-tenancy/SKILL.md#organization-and-workspace-deletion-and-data-purge), anonymous-upgrade tenancy continuity, and `ensure` semantics).

Summary:

- Tables: `organizations`, `organizations_workspaces`, `organizations_workspaces_users`, `access_control_role_assignments`, `access_control_permission_grants`, `notifications`, `data_deletion_requests`; `users.defaultOrganizationId` / `defaultWorkspaceId`.
- Bootstrap: `create_anonymous_user` and `resolve_user` call `organizations_db_ensure_default_organization_and_workspace_for_user`.
- The default `personal` organization is private. Invites/member-management writes reject it.
- Organization ownership lives in `organizations.ownerUserId` for default and non-default organizations. Owners hold **no** role assignment; role display resolves ownership from `ownerUserId` before reading assignments. Only non-default ownership consumes the extra-organization quota and can be transferred.
- **Implementation note:** Many app surfaces may still use older hardcoded organization/workspace ids outside this tenancy module—verify callsites.

Authorization helpers in `organizations.ts` call the backend access-control permission checker. Frontend guards and full permission-management UI are intentionally incremental follow-up work.

# Planned Privacy And Permission Model

## Workspaces and organizations

The app is organized into workspaces and organizations so users can organize assets flexibly.

When an anonymous user is created:

- A personal organization and home workspace must be created as well.
- V1 invitations are immediate in-app access for existing signed-in users by exact email. No outbound email is sent.

## Public vs private semantics

### “Public” is link-only

Public access is implemented by possessing the asset id in a URL (not indexable content, no separate share token).

### Public organization/workspace

If the organization/workspace is public:

- anonymous collaborators can be invited
- anonymous collaborators can have permissions like any other user id (subject to the permission system)

### Public asset

If an asset is public:

- it can be accessed by anonymous users without an invite
- the owner can choose whether anonymous users can write or only read

Important: “public write” means anyone who knows the asset id can write (shared edit capability).

## Granular permissions system

Canonical access-control details live in `../access-control/SKILL.md`.

Role authority is **code**, not data: system roles live in `access_control_SYSTEM_ROLE_MATRIX`.
`access_control_permission_grants` is allow-only and used for per-file sharing — the schema can target a
role, a specific user, or public access for `organization`, `workspace`, `file` and `thread` resources,
but today the only writer is `files_sharing.ts`, and it writes only user and role grants on `file`
resources (the restricted scope node).

System roles are `admin`, `member`, `viewer`. Ownership is `organizations.ownerUserId` and carries no
doc; there is no `owner` role. Direct user grants allow file-level access without changing anyone's
role. The checker also honors public grants, but nothing writes one yet.

Per-file sharing ships user and role share grants today. Handing them out requires
`content.permissions.manage`, which file sharing enforces on every share change (no `enforcedBy` mark
remains in the catalog). The public/anonymous arm is still future work:

- allow anonymous users to write on a public file (edit-by-link)
- allow anonymous users to read only
- grant write permissions to a specific anonymous user id (while keeping others read-only)

## Upgrade behavior (anonymous → signed-in)

When the user upgrades by signing up (Clerk-authenticated, linked to Convex user id):

- The anonymous user record is linked to the Clerk identity in place.
- The same Convex `users` id remains canonical after upgrade.
- The user keeps the same default organization/workspace and therefore keeps the same associated organization/workspace-scoped data in the normal upgrade path.
- The user must not be able to access the same private resources while logged out.
- Default security migration:
  - all organizations become private
  - all workspaces become private
  - all assets become private
  - all anonymous write access is removed
  - all anonymous/public access is removed by default

The owner can later re-publicize assets explicitly.

# Preserve the canonical user id design

- The canonical app identity is the Convex `users` document id.
- Clerk `external_id` is used as a pointer to that Convex user id in tokens.
- Do not assume Clerk session invalidation always completes after account deletion. Clerk cleanup is best effort after the Convex tombstone, so a provider failure can leave the old identity valid. Account-level provider writes must load the app user and reject a missing or tombstoned doc.

# Current app user resolution

When a public Convex handler needs the current app user, resolve auth with `server_convex_get_user_fallback_to_anonymous(ctx)` and then load the `users` row by the returned `id`. Keep `userAuth.kind` while doing that lookup. Treat these cases as `Unauthenticated`:

- Convex auth returns no usable identity.
- Convex auth returns a user id, but that id does not resolve to a row in the `users` table.
- The caller is anonymous and the resolved row has `deletedAt`.
- The caller presents a plugin-session JWT: the helper answers `null` for that issuer by design. Plugin-facing doors are the only handlers that resolve it, through `server_convex_get_plugin_session`.

`access_control_db_authorize_membership` applies the `deletedAt` rejection to **every** caller, anonymous or signed in, at all of its call sites. The four public Polar actions do the same before any provider call. Recovery clears the tombstone before normal access resumes: `users.resolve_user` patches `deletedAt: undefined`, and `/api/auth/resolve-user` refuses a tombstoned user on the read-only fast path so it must fall through to that patch. Keep these checks even though account deletion asks Clerk to delete the identity, because that best-effort request can fail.

Reserve `Unauthorized` for a resolved app user who lacks permission for a resource. Use `Not found`, `User not found`, or a more specific message for target resources or target users, not for the current caller principal.

`server_convex_get_user_fallback_to_anonymous` intentionally does not load the `users` table; see [server-utils.ts](../../../packages/app/server/server-utils.ts). Handlers that require the current app account own the doc-existence check. Current examples include [users.delete_current_user_account](../../../packages/app/convex/users.ts), the public Polar actions in [billing.ts](../../../packages/app/convex/billing.ts), and [organizations.get_membership_by_organization_workspace_name](../../../packages/app/convex/organizations.ts).

For `Result`-returning handlers:

```ts
const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
const user = userAuth
	? await ctx.runQuery(internal.users.get, {
			userId: userAuth.id,
		})
	: null;
if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
	return Result({
		_nay: {
			message: "Unauthenticated",
		},
	});
}
```

For query handlers that use Convex errors:

```ts
const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;

if (!user || (userAuth?.kind === "anonymous" && user.deletedAt !== undefined)) {
	throw convex_error({ message: "Unauthenticated" });
}
```

If a handler intentionally treats a missing row or a deleted anonymous user as stale client state or as an idempotent no-op, leave a short comment explaining that product-specific exception at the branch.

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
- Token suppliers used by Convex should resolve (not reject) so auth state can transition cleanly — but never resolve `null` on a transient failure. The Convex client treats `null` as a definitive "signed out" and stops asking; only a server `401`/`400` justifies it.
- Treat anonymous localStorage as disposable client cache. The stored refresh JWT can never reach Convex directly (wrong audience); every Convex access token comes from `/api/auth/anonymous`, so a stale dev-reset identity is always caught there first.

# Treat “public write” as intentionally unsafe

- Do not accidentally enable public write by default.
- When implementing the upgrade migration, ensure “everything becomes private” is enforced.

# Verification touchpoints

- If you change delete-account behavior, update [data_deletion.test.ts](../../../packages/app/convex/data_deletion.test.ts) and [users.test.ts](../../../packages/app/convex/users.test.ts).
- If you change profile/anagraphic usage or fallback behavior materially, update [users.test.ts](../../../packages/app/convex/users.test.ts).

# Known Gaps

- Deleted-account recovery currently supports only the same verified email path. Changed-email recovery or manual account merge is not implemented.
