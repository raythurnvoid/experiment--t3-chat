# Clerk Test Account Login And Logout

Use this when a QA check needs a **specific** signed-in account: a specific role, data already attached to an account, or a flow that anonymous users cannot reach. Start with the [qa-data account table](../../qa-data/SKILL.md#pick-an-account). For owner-and-member checks, it lists kept `chitchat-qa` members. Read current membership and billing before choosing an account.

The 2026-10-28 cleanup preserved all Clerk accounts, auth and billing links. It erased
`qa-browser` and `f5-repro-org` content. Old sign-in, role, credit and fixture observations below
are history, not current setup. Four anonymous members of kept workspaces were also preserved;
do not delete them as old QA leftovers.

Login and logout with the seeded `+clerk_test` accounts is a supported autonomous flow. The fixed test code `424242` is Clerk's public, documented test-mode constant. It is fixture data, not a secret, and it only works for `+clerk_test` addresses on a development instance.

## Hard rules

- **Only in an isolated scratch browser** (section "Isolated browser" below). Never sign in or out in the user's own browser profile: this Clerk instance runs in single-session mode, so a sign-in there would kick the user out of their own session.
- **Only on the dev instance.** Before signing in, read `window.Clerk.publishableKey` and require the `pk_test_` prefix. Never run this against `pk_live_`.
- **Only `+clerk_test` fixture addresses with the code `424242`.** Never type a real password, a real verification code, or any other real credential. If a check needs a real account, hand that step to the user.
- **One account per browser profile.** Single-session mode means one profile holds one signed-in user. For two users at once, use separate scratch sessions.

## Seeded accounts (dev DB, verified 2026-08-16; `qa.paid.owner` added 2026-10-20)

**Verify before building on these accounts.** A dev-data reset can drop them from the Clerk instance while this table still lists them: the sign-in form then answers `Couldn't find your account` for every prefix. That already happened once — a dev-data reset dropped all five, and they were reseeded on 2026-08-16 with the ids below. The `Couldn't find your account` message means the account no longer exists, not a typo — do not retry other prefixes hoping for a different result, and do not create a replacement account on your own initiative during a QA check. Report the missing accounts so the user can request a reseed (see "Reseeding" below). Use the anonymous identity in `second-user-fixtures.md` only when the check needs anonymous behavior.

All emails end with `+clerk_test@example.com` and all accept the code `424242`.

| Email prefix       | Convex `users` id                  | Notes                                                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `qa.perm.owner`    | `m575qvj9kyabtdn9jef1dgw0js8ck2dq` | Account and default home preserved. Former `qa-browser` owner; that workspace was erased. |
| `qa.perm.admin`    | `m572b1a4snqa1en3qqp1gfwwnn8cjxya` | Account and default home preserved. |
| `qa.perm.member`   | `m57f7hajv2kgw3rxfnv9z4bagh8ckq06` | Owns kept `qa-tmp-share/home`. Member of kept `chitchat-qa/home` and `xfer-qa-0914`. Read current roles and grants. |
| `qa.perm.viewer`   | `m572qhnpq7xw34askfcy6w97h18ck1f8` | Member of kept `chitchat-qa/home`. Read its current role; the account name does not define it. |
| `import-qa-member` | `m5754ckhv5yrt02vjf1dt2v4hd8cjsy4` | Deleted: its `users` doc has `deletedAt` (seen 2026-10-21). Do not use it. |
| `qa.paid.owner`    | `m5774tmwzz27knb7mwbzjbn9t58gn6fx` | Account, default home and billing links preserved. Former `f5-repro-org` owner. Seeded Pro plan was observed on 2026-10-21; read current billing and available workspaces before paid checks. |

**Check billing before agent chat.** On 2026-10-11, `qa.perm.owner` had a subscription, a usage snapshot and available credit. Its native Agent Bash check passed in `qa-browser/home`. This seeded state does not prove Polar can bootstrap an `example.com` account. For a second user, `ray-test-1+clerk_test@gmail.com` (Convex `users` id `m570f2kgg8jq3qka7snprkpeks8cme94`, code `424242`) held the `member` role in `chitchat-qa/home` and had credits on 2026-10-08. Read back billing and membership before using either fixture. By 2026-10-18 `qa-browser` had no credits left, so do not count on that older state.

**Uploads need a paid plan on the account that uploads.** Read `billing.get_usage_snapshot` and current membership first. The old `f5-repro-org/home` paid fixtures were erased. `qa.paid.owner` keeps its account and billing links; do not recreate that workspace or reseed billing just to follow an old recipe. Reseed only when the user asks.

**A guest must be a member.** A "guest" is a workspace member whose role has no `content.read`. `set_node_share_grant` refuses a user who is not a member (`This person is not a member of this workspace`). Historical example: on 2026-10-11 the owner invited `ray-test-1` into `qa-browser`, then gave it a temporary custom role with only `workspace.mcp.use`. The permission query answered `false`; the temporary membership and role were removed afterward. That erased workspace cannot be reused.

Do not infer membership or role from the account name. Before a check, read its membership with `organizations.get_membership_by_organization_workspace_name` from its signed-in tab, or the `organizations_workspaces_users` table over the Convex CLI. Use the current [QA catalog](../../qa-data/references/inventory.md#accounts). Old `qa-browser` member lists and fake seed accounts are historical; do not recreate them.

These accounts have no display name: the dev Clerk instance has both the name and the username attributes disabled (`Clerk.user.update` rejects `first_name`/`username` with `form_param_unknown`), and the app has no anagraphic edit UI, so `resolve_user` stores the fallback `User <clerkUserId>` as the display name on every sign-in. Build locators on emails and ids, never on display names.

## Reseeding (user-requested only)

Recreating dropped accounts is a sign-UP flow, done only when the user explicitly asks for a reseed. It mirrors the sign-in recipe (`window.Clerk.openSignUp()`, `#emailAddress-field`, `Continue` with `exact: true`, then the code `424242` in `.cl-otpCodeField input`), with two extra rules learned on 2026-08-16:

- **One sign-up per fresh scratch profile.** Clerk gates sign-up behind an invisible Cloudflare Turnstile. The first solve in a fresh `--user-data-dir` passes in a few seconds; every later sign-up attempt in that same profile wedges silently — no `sign_ups` POST ever fires, `Clerk.client.signUp.status` stays `null`, and the modal's form section hides itself. No amount of waiting, modal reopening, or page reloading recovers it. Kill the scratch Chrome and relaunch with a new scratch profile for each account. Sign-INS are not captcha-gated and keep working in a used profile.
- **Pause ~2.5s before typing the verification code.** Filling the moment the OTP field appears trips the code-before-send race far more often on sign-up than on sign-in, and the `Resend` button then sits behind a 30s countdown. With the pause, the flow lands cleanly; without it, the already-typed code is usually still accepted once the send settles, so observe before retrying.

After sign-up, the app upgrades the tab's current anonymous user in place (`resolve_user` branch 3), and Clerk's `external_id` is backfilled asynchronously — a token read right after sign-up can show `external_id: null`. Wait a few seconds and read again with `getToken({ template: "convex", skipCache: true })`.

## Polar bootstrap and seeded billing

Polar's sandbox refuses the whole `example.com` domain, so the Free-subscription bootstrap that runs
on every sign-in fails for all of them:

```
422 RequestValidationError
qa.perm.owner+clerk_test@example.com is not a valid email address:
The domain name example.com does not accept email.
```

On 2026-09-01, these accounts had no `billing_usage_snapshots` row. The credit check refused them
because they had no subscription. That is different from a Free account with no credit. Later QA
can seed billing through the app's billing handler below. Check the current state; do not infer it
from the email domain. The owner fixture had billing and could use Agent chat on 2026-10-11.

Two drain routes that do NOT work here, so do not spend time on them:

- `billing:grant_credit` splits on `clerkUserId` and sends a signed-in user's event to Polar, which
  has no customer for these addresses.
- `billing:ingest_anonymous_user_events` refuses a signed-in row outright and just logs.

What does work is the registered mutation the Polar webhook itself calls, so the balance is written
through the app's real path rather than a raw row edit:

```powershell
# state.activeMeters[0].balance is the credit balance; externalId is the Convex users id.
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable `
  billing:apply_polar_customer_state_refresh $argsJson
```

Two gotchas, both hit on 2026-09-01:

- **Re-apply inside the SAME `currentPeriodStart`.** A period the app has not credited yet is treated
  as a new one, and it applies the recurring Free credit on top of what you just set — a drain to 0
  came straight back as 1000. Set the period once, then reuse those exact dates for every later change.
- Only the **Free** plan is refused on a low balance; a paid plan passes regardless. Prove the seeded
  product really is Free with two points: balance 1000 -> `hasCredits: true`, balance 0 -> `false`.
  `billing:list_products` answers `[]` unless the caller is signed in, so a CLI `convex run` of it
  tells you nothing — call it with the account's own Clerk token.

## Isolated browser

Same setup as `second-user-fixtures.md` section 1: launch the installed Chrome for Testing with a scratch profile and attach over direct CDP. Put the profile in the task's personal AI folder (see AGENTS.md), never in the repo or `$env:TEMP`.

```powershell
$prof = "<personal AI folder>\<topic>-<YYYY-MM-DD>\qa-clerk-profile"
$chrome = "$env:USERPROFILE\.playwriter\browsers\chrome-<version>\chrome-win64\chrome.exe"
Start-Process $chrome -ArgumentList @("--remote-debugging-port=9223", "--user-data-dir=$prof", "--no-first-run", "--no-default-browser-check", "http://localhost:5173/")
vp env exec pnpx playwriter session new --direct 127.0.0.1:9223
```

Check that the port is free first (`netstat -ano | Select-String ":9223" | Select-String LISTEN`). Other agents use the same recipe, so 9223 can already hold another agent's scratch Chrome (seen 2026-10-11). Never attach to it; pick a free port such as 9224. After you kill your own Chrome, WMI and `netstat` can still list its old PIDs and a `LISTENING` socket for minutes, while `Get-Process` cannot find them and the port no longer answers. They are gone; do not kill anything else to clear them.

If the relay restarts between calls, the session dies (`Session <id> not found`) but the scratch Chrome keeps running. Recreate with `session new --direct 127.0.0.1:9223` and rebind `state.page` from `context.pages()`.

The URL passed to `Start-Process` does not always open: the first tab can sit on a blank page with an empty URL (observed 2026-08-09). Bind `context.pages()[0]` and call `page.goto("http://localhost:5173/")` yourself instead of relying on the launch argument.

## Sign in

For a new isolated profile, sign in before loading the app. This avoids creating an anonymous
account. Verified 2026-10-29 with the seeded member:

1. Fulfill one owned same-origin scratch URL with a plain HTML sign-in container. Do not load app
   scripts on that page.
2. Load the app's pinned Clerk JS version from its dev frontend API, set its public `pk_test_` key,
   call `Clerk.load()`, then `Clerk.mountSignIn(container)`. Follow the native email and test-code UI.
   Use the [Clerk JS script-tag setup](https://clerk.com/docs/js-frontend/getting-started/quickstart).
3. Check the exact expected `external_id` in the Convex token and confirm the app's anonymous-token
   storage key is absent. Never print the token.
4. Remove only that scratch page's route, then navigate to the app. Recheck the account before writes.

If the app was already loaded, use the cleanup path below.

The first app load in a fresh scratch profile mints an anonymous user with its own org and workspace. Signing in does not remove it, and after sign-in the tab no longer holds its token. So delete it **before** you sign in: `app_convex.action(app_convex_api.users.delete_current_user_account, {})` from that tab, then wait for `window.Clerk?.loaded` (see the reload note below). If you already signed in, record its id and creation time from the `users` table and delete it as operator cleanup. Seen 2026-09-30: two scratch browsers left two anonymous users.

Operator cleanup, from `packages/app` (the [convex-admin-ops](../../convex-admin-ops/SKILL.md) skill has the full rules):

1. Find the user: `vp env exec pnpm exec convex data users --limit 15 --order desc --format jsonLines`. It must have `clerkUserId: null`, an `anonymousAuthToken`, and a `_creationTime` from your session. Its `defaultOrganizationId` must not be a protected org. If any of this does not match, stop and ask.
2. Delete it with the same mode the in-app delete uses: `vp env exec pnpm exec convex run --typecheck disable --codegen disable users:hard_delete_user_now '{"userId":"<id>","purgeUserMod":"data_and_auth"}'`.
3. Read it back with `users:get`: `deletedAt` is set and `anonymousAuthToken` is gone. Done this way on 2026-10-22.

```js
state.page = context.pages().find((p) => p.url().includes("localhost:5173"));
const pk = await state.page.evaluate(() => window.Clerk.publishableKey);
if (!pk.startsWith("pk_test_")) throw new Error("Not the dev Clerk instance — stop");

await state.page.evaluate(() => window.Clerk.openSignIn());
await state.page.locator("#identifier-field").waitFor({ timeout: 8000 });
await state.page.locator("#identifier-field").fill("qa.perm.viewer+clerk_test@example.com");
await state.page
	.locator(".cl-rootBox, .cl-modalContent")
	.getByRole("button", { name: "Continue", exact: true })
	.click();

const otp = state.page.locator(".cl-otpCodeField input");
await otp.waitFor({ timeout: 8000 });
await otp.fill("424242");
await state.page.waitForFunction(() => window.Clerk?.user != null, { timeout: 15000 });
```

- `exact: true` on `Continue` is mandatory. Without it the locator matches `Continue with Google` first and opens a real Google account chooser (see `known-hazards.md`).
- **Code-before-send race:** if the modal says `You need to send a verification code before attempting to verify`, the code was typed before Clerk finished preparing the email factor. Click `Resend`, wait a moment, and fill `424242` again. Observed on the second sign-in of a session; the recovery works every time.
  Re-hit 2026-09-03 on the **first** sign-in of a session, so do not expect it only on the second.
- **A failed runner call does not mean a failed sign-in.** On 2026-09-03 the `Resend` recovery runner
  ended with a long `hono` stack trace and `[HINT: If this is an internal Playwright error, page/browser
  closed, or connection issue, call reset to reconnect.]`, but the sign-in had already landed: a plain
  follow-up read answered `qa.perm.owner+clerk_test@example.com`. Read `window.Clerk.user` before
  retrying a sign-in, or the retry opens a modal on an already signed-in session.

- **The delete action can take longer than the 5 s call limit.** On 2026-10-22 an awaited
  `delete_current_user_account` timed out and the user was not deleted. Start it without awaiting
  (`.then((r) => { window.__del = JSON.stringify(r); })`), end the call, then read `window.__del`
  after a few seconds. It answered `{"_yay":null}` about 10 s later.
- **Deleting the minted anonymous user reloads the tab.** After `users.delete_current_user_account`,
  the next call can fail with `Cannot read properties of undefined (reading 'user')`, because
  `window.Clerk` is gone while the page reloads. Wait for `window.Clerk?.loaded === true` before the
  sign-in. Verified 2026-09-27. On 2026-10-11 the same direct action call in the owner's Edge did not
  reload the tab and minted no new anonymous user, so do not wait for a reload that may not come; just
  check `window.Clerk?.loaded` before the sign-in.
- **The first Convex call after sign-in can answer `Unauthenticated`.** On 2026-09-27 the page also
  logged `useAppAuth must be used within AppAuthProvider`. A `page.reload` followed by waiting for
  `window.Clerk.user` fixed it, and every call after that worked. That error message kept showing
  after the reload, but it did not break any call.

## Verify who you are

- `window.Clerk.user.primaryEmailAddress.emailAddress` is the signed-in email.
- The Convex `users` id is the `external_id` claim of `await window.Clerk.session.getToken({ template: "convex" })`.
- The sidebar account button's accessible name flips from `Anonymous account: …` to `Account: …`.

## Sign out

```js
await state.page.evaluate(() => window.Clerk.signOut());
await state.page.waitForFunction(() => window.Clerk?.user == null, { timeout: 15000 });
```

- The tab can freeze for about 20 s after `Clerk.signOut()` (seen 2026-10-08). Opening a new tab in the same scratch browser gets it going again.
- After sign-out the app mints a **new** anonymous user (fresh `app::auth::anonymous_token_user_id`). You do not get the pre-sign-in anonymous identity back, so capture anything you need from it before signing in.
- The URL keeps its shape; `personal`/`home` re-resolve to the new identity's own default tenant.

## Clean up

- Do not sign out at the end: sign-out mints a new anonymous user that stays in the database. Close the scratch Chrome, remove its `--user-data-dir` folder, and delete the Playwriter session instead. The test account stays signed in only inside that deleted profile.
- `users.delete_current_user_account` is a soft delete: the `users` row stays with `deletedAt` set.
- Sign-in and sign-out themselves need no server-side cleanup. Clean up only the content fixtures the run created, as their owning account.
