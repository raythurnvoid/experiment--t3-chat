# Second User In The Browser

Use this when a check needs two identities at once: permission refusals, share grants, presence, or anything where the signed-in owner would bypass the code under test.

The org owner passes every permission check, so an owner-only run proves **no over-refusal** and never proves a refusal works. Do not report a permission fix as verified from owner flows alone.

You do not need a second Clerk account, and you must never type a credential to get one. The app mints an anonymous user for any visitor with no Clerk session, and `organizations.invite_user_to_organization_workspace` accepts `userIdToAdd` directly, so that anonymous user can be pulled into a workspace as a normal member.

## 1. Isolated browser for the second identity

The signed-in Clerk session lives in the user's own browser profile, so the second identity needs a profile of its own. `session new --browser headless` does not work here (the relay cannot resolve the browser inside its sandbox), so launch the installed Chrome for Testing yourself and attach over direct CDP:

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

The anonymous user has no billing snapshot, so **content** writes fail with `Insufficient funds`. Create the files as the signed-in owner and let the second user do only metadata work (create, rename, move, archive, restore, share) — none of that is credit-gated.

Owner-side fixture calls:

- `files_nodes.create_folder_node({ membershipId, parentId: "root", path })`
- `files_nodes_content.create_markdown_node({ membershipId, parentId, path })` (an action, not a mutation)
- `files_sharing.restrict_node({ membershipId, nodeId })`
- `files_sharing.set_node_share_grant({ membershipId, nodeId, principal: { kind: "user", userId }, level: "read" | "write" | "manage" })` — `nodeId` must be the restricted node itself
- `files_nodes.move_nodes({ membershipId, itemIds, targetParentId })` — `itemIds` is an array and the target is a single sibling field, not per-item

## 5. Clean up

- Delete the fixture organization with `organizations.delete_organization({ organizationId })` as its owner.
- Delete the throwaway identity from its own session with `users.delete_current_user_account({})` — that is the app's supported flow and it works for anonymous users, whose only owned org is their default one.
- Close the scratch Chrome and remove its `--user-data-dir` folder.
- Close only the tab you opened in the user's browser. Snapshot `context.pages()` URLs before opening it and compare after closing.
