# Second User In The Browser

Use this when a check needs two identities at once: permission refusals, share grants, presence, or anything where the signed-in owner would bypass the code under test.

The org owner passes every permission check, so an owner-only run proves **no over-refusal** and never proves a refusal works. Do not report a permission fix as verified from owner flows alone.

For most checks you do not need a second Clerk account. The app mints an anonymous user for any visitor with no Clerk session, and `organizations.invite_user_to_organization_workspace` accepts `userIdToAdd` directly, so that anonymous user can be pulled into a workspace as a normal member.

## When a check needs a specific Clerk account

The dev database holds signable `qa.perm.owner` / `admin` / `member` / `viewer` accounts (`+clerk_test` addresses, fixed public test code `424242`). Login and logout with them is a supported autonomous flow — read `clerk-test-accounts.md` for the account list, the sign-in/sign-out recipes, and the hard rules (dev `pk_test_` instance only, `+clerk_test` fixtures only, never a real credential).

Two constraints shape the choice, both checked on 2026-08-02:

- This Clerk instance runs with `singleSessionMode === true` (read it from `Clerk.__unstable__environment.authConfig`). One browser profile holds one signed-in user, and the app has no account switcher (`packages/app/src/components/main-app-sidebar-account-control.tsx` renders only `Manage account` and `Sign out`). So test-account sign-in must happen **only** in the isolated scratch browser from section 1 below — in the user's own profile it would kick the user out of their own session.
- Prefer the anonymous identity below when the check only needs "some non-owner member": it needs no account and no sign-in, and it produces the same non-owner member with `content.write` that those accounts were created for. Reach for a Clerk test account when the check needs a specific role, a specific configuration, or data already attached to an account.

Hand the work back to the user only when a check needs a **real** account: the user's own data, a real credential, or an invite-by-email flow that needs a real address. That is the single step to ask a human for; everything around it you can still drive yourself.

## 1. Isolated browser for the second identity

The signed-in Clerk session lives in the user's own browser profile, so the second identity needs a profile of its own. The current Playwriter install can start an isolated headless browser directly:

```powershell
vp env exec pnpx playwriter session new --browser headless
```

If headless startup is unavailable on the machine, launch the installed Chrome for Testing yourself and attach over direct CDP:

```powershell
$prof = Join-Path $env:TEMP "qa-anon-profile"
$chrome = "C:\Users\rt0\.playwriter\browsers\chrome-<version>\chrome-win64\chrome.exe"
Start-Process $chrome -ArgumentList @("--remote-debugging-port=9223", "--user-data-dir=$prof", "--no-first-run", "--no-default-browser-check", "http://localhost:5173/")
```

```powershell
vp env exec pnpx playwriter session new --direct 127.0.0.1:9223
```

Notes:

- `browser install` reports the exact installed path and version. Use that path; do not guess.
- The first page in that context starts at `about:blank`, where `localStorage` throws `SecurityError`. `goto` the app before reading any storage.
- This scratch browser is yours, so `bringToFront()` and screenshots are free. Never foreground or navigate the user's own tabs.

## 2. Let the app mint the anonymous user

Load `http://localhost:5173/`, wait a few seconds, then read the identity:

- `localStorage["app::auth::anonymous_token_user_id"]` is the `users` id.
- `window.Clerk?.user` stays `null`, which is the proof the context is really isolated.
- The app gives the new user its own default `personal` organization, so the app shell renders normally.

## 2b. The anonymous user is also the Free-plan fixture

A freshly minted anonymous user is a real non-paying payer, so it is the cheapest way to test any door that is closed to `Free`. Its auto-seeded snapshot has no `subscription.productId` at all, which is the "payer with no billing state" case, and `billing_db_check_paid_plan` refuses it exactly like `Free`. It acts in its OWN default `personal`/`home` workspace, so no invite step is needed.

Do not try the other route — patching the signed-in account's `billing_usage_snapshots` row. It bricks the app; see the entry in `known-hazards.md`.

Upload plan gate, verified 2026-08-21 (both browser doors refuse with `This workspace's plan does not include file uploads`):

```js
const m = await import("/src/lib/app-convex-client.ts");
const membership = await m.app_convex.query(
	m.app_convex_api.organizations.get_membership_by_organization_workspace_name,
	{ organizationName: "personal", workspaceName: "home" },
);
// single upload
await m.app_convex.mutation(m.app_convex_api.files_nodes.create_upload_node, {
	membershipId: membership._id,
	parentId: "root",
	filename: "x.txt",
	contentType: "text/plain",
	size: 25,
});
// folder import
await m.app_convex.mutation(m.app_convex_api.files_nodes.create_upload_nodes, {
	membershipId: membership._id,
	parentId: "root",
	onConflict: "skip",
	items: [{ relativePath: "f/a.txt", contentType: "text/plain", size: 10 }],
});
```

The sidebar shows the same string in a sonner toast, but that toast is short-lived: one `allInnerTexts()` after a fixed wait misses it. Poll in a loop (40 × 250ms) and collect into a `Set`. Text writes are NOT plan-gated — `files_nodes_content.create_text_node` still succeeds for this user, which is the control that proves the refusal came from the upload gate and not from the identity.

## 3. Invite it into a workspace

`create_organization` refuses anonymous callers, and `invite_user_to_organization_workspace` refuses the **default** organization (`Cannot add user to default organization`). So the fixture org must be a new non-default org created by the signed-in user:

```js
const created = await cx.mutation(api.organizations.create_organization, { name: "qa-…", description: "QA throwaway" });
await cx.mutation(api.organizations.invite_user_to_organization_workspace, {
	organizationId: created._yay.organizationId,
	workspaceId: created._yay.defaultWorkspaceId,
	userIdToAdd: "<anonymous users id>",
});
```

- `description` is short-capped; a sentence trips `Description is too long`.
- The invitee lands with the `member` system role: `content.read` and `content.write`, and **no** `content.permissions.manage`. That is exactly the shape most permission refusals need.
- Each side reads its own membership with `organizations.get_membership_by_organization_workspace_name({ organizationName, workspaceName })`.
- Confirm the granted level per permission with `access_control.get_current_user_workspace_permission({ membershipId, permission })` — it takes the membership id, not org/workspace ids.

## 4. Content the second user can act on

A freshly minted anonymous user now gets an auto-seeded `billing_usage_snapshots` row (balance 1000, Free product, null Polar ids), so its **content** writes work with no unblock step — verified 2026-08-03: `files_pending_updates.upsert_file_pending_update` drafts succeed for the invited anonymous member. Still create committed fixture files as the signed-in owner; that stays the simplest path, and metadata work (create, rename, move, archive, restore, share) was never credit-gated anyway.

Owner-side fixture calls:

- `files_nodes.create_folder_node({ membershipId, parentId: "root", path })`
- `files_nodes_content.create_text_node({ membershipId, parentId, path })` (an action, not a mutation)
- `files_sharing.restrict_node({ membershipId, nodeId })`
- `files_sharing.set_node_share_grant({ membershipId, nodeId, principal: { kind: "user", userId }, level: "read" | "write" | "manage" })` — `nodeId` must be the restricted node itself
- `files_nodes.move_nodes({ membershipId, itemIds, targetParentId })` — `itemIds` is an array and the target is a single sibling field, not per-item

Live demotion recipe: `restrict_node` + `set_node_share_grant(level: "read")` on a node the member could write is the per-file demotion path, and it applies reactively — run it as the owner WHILE the second user holds an open rename input, a drag source, or a writable diff tab to test permission-reactive UI (rename aborts itself, folder-view rows de-register as drag sources without a reload, editors flip read-only). Two gotchas, both verified 2026-08-03: the window between the two mutations has NO access, so the second user's open tab can fall back to `?nodeId=root` (see the demotion entry in `known-hazards.md`), and restricting renames the sidebar row to `<name> restricted`, which breaks name-based locators.

## 5. Clean up

- Delete the fixture organization with `organizations.delete_organization({ organizationId })` as its owner.
- Delete the throwaway identity from its own session with `app_convex.action(app_convex_api.users.delete_current_user_account, {})` — it is a Convex action, not a mutation. This is the app's supported flow and it works for anonymous users, whose only owned org is their default one.
- Close the scratch Chrome and remove its `--user-data-dir` folder.
- Close only the tab you opened in the user's browser. Snapshot `context.pages()` URLs before opening it and compare after closing.
