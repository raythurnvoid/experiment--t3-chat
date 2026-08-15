# Clerk Test Account Login And Logout

Use this when a QA check needs a **specific** signed-in account: a specific role, data already attached to an account, or a flow that anonymous users cannot reach. For a generic "some non-owner member" check, prefer the anonymous identity in `second-user-fixtures.md` — it needs no account and no sign-in at all.

Login and logout with the seeded `+clerk_test` accounts is a supported autonomous flow. The fixed test code `424242` is Clerk's public, documented test-mode constant. It is fixture data, not a secret, and it only works for `+clerk_test` addresses on a development instance.

## Hard rules

- **Only in an isolated scratch browser** (section "Isolated browser" below). Never sign in or out in the user's own browser profile: this Clerk instance runs in single-session mode, so a sign-in there would kick the user out of their own session.
- **Only on the dev instance.** Before signing in, read `window.Clerk.publishableKey` and require the `pk_test_` prefix. Never run this against `pk_live_`.
- **Only `+clerk_test` fixture addresses with the code `424242`.** Never type a real password, a real verification code, or any other real credential. If a check needs a real account, hand that step to the user.
- **One account at a time.** Single-session mode means one browser profile holds one signed-in user. To use several accounts, cycle sign-out → sign-in in the same scratch profile.

## Seeded accounts (dev DB, verified 2026-08-16)

**Verify before building on these accounts.** A dev-data reset can drop them from the Clerk instance while this table still lists them: the sign-in form then answers `Couldn't find your account` for every prefix. That already happened once — a dev-data reset dropped all five, and they were reseeded on 2026-08-16 with the ids below. The `Couldn't find your account` message means the account no longer exists, not a typo — do not retry other prefixes hoping for a different result, and do not create a replacement account on your own initiative during a QA check. Fall back to the anonymous identity in `second-user-fixtures.md` when the check does not need a specific role, and report the missing accounts so the user can request a reseed (see "Reseeding" below).

All emails end with `+clerk_test@example.com` and all accept the code `424242`.

| Email prefix       | Convex `users` id                  | Notes                                                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `qa.perm.owner`    | `m575qvj9kyabtdn9jef1dgw0js8ck2dq` | Owns the `qa-browser` organization.                                                               |
| `qa.perm.admin`    | `m572b1a4snqa1en3qqp1gfwwnn8cjxya` | Not a member of `qa-browser`.                                                                     |
| `qa.perm.member`   | `m57f7hajv2kgw3rxfnv9z4bagh8ckq06` | Owns `qa-tmp-share`. Not a member of `qa-browser` — opening it shows the access-denied screen.    |
| `qa.perm.viewer`   | `m572qhnpq7xw34askfcy6w97h18ck1f8` | Member of `qa-browser` holding the `member` role (the name is misleading; see `app-map.md`).      |
| `import-qa-member` | `m5754ckhv5yrt02vjf1dt2v4hd8cjsy4` | Accounts-only import QA fixture: no extra memberships.                                            |

Do not infer membership or role from the account name. Before building a check on an account, read its membership back: `organizations.get_membership_by_organization_workspace_name` from its signed-in tab, or the `organizations_workspaces_users` table over the Convex CLI. Since the 2026-08-16 reseed, `qa-browser` has exactly two members (`qa.perm.owner` as owner, `qa.perm.viewer` with the `member` role) — the fake members named `Bob Reader`, `New Owner` and charlie were artifacts of an older DB seed and no longer exist; do not expect them and do not recreate them.

These accounts have no display name: the dev Clerk instance has both the name and the username attributes disabled (`Clerk.user.update` rejects `first_name`/`username` with `form_param_unknown`), and the app has no anagraphic edit UI, so `resolve_user` stores the fallback `User <clerkUserId>` as the display name on every sign-in. Build locators on emails and ids, never on display names.

## Reseeding (user-requested only)

Recreating dropped accounts is a sign-UP flow, done only when the user explicitly asks for a reseed. It mirrors the sign-in recipe (`window.Clerk.openSignUp()`, `#emailAddress-field`, `Continue` with `exact: true`, then the code `424242` in `.cl-otpCodeField input`), with two extra rules learned on 2026-08-16:

- **One sign-up per fresh scratch profile.** Clerk gates sign-up behind an invisible Cloudflare Turnstile. The first solve in a fresh `--user-data-dir` passes in a few seconds; every later sign-up attempt in that same profile wedges silently — no `sign_ups` POST ever fires, `Clerk.client.signUp.status` stays `null`, and the modal's form section hides itself. No amount of waiting, modal reopening, or page reloading recovers it. Kill the scratch Chrome and relaunch with a new temp profile for each account. Sign-INS are not captcha-gated and keep working in a used profile.
- **Pause ~2.5s before typing the verification code.** Filling the moment the OTP field appears trips the code-before-send race far more often on sign-up than on sign-in, and the `Resend` button then sits behind a 30s countdown. With the pause, the flow lands cleanly; without it, the already-typed code is usually still accepted once the send settles, so observe before retrying.

After sign-up, the app upgrades the tab's current anonymous user in place (`resolve_user` branch 3), and Clerk's `external_id` is backfilled asynchronously — a token read right after sign-up can show `external_id: null`. Wait a few seconds and read again with `getToken({ template: "convex", skipCache: true })`.

## Isolated browser

Same setup as `second-user-fixtures.md` section 1: launch the installed Chrome for Testing with a temp profile and attach over direct CDP.

```powershell
$prof = Join-Path $env:TEMP "qa-clerk-profile"
$chrome = "C:\Users\rt0\.playwriter\browsers\chrome-<version>\chrome-win64\chrome.exe"
Start-Process $chrome -ArgumentList @("--remote-debugging-port=9223", "--user-data-dir=$prof", "--no-first-run", "--no-default-browser-check", "http://localhost:5173/")
vp env exec pnpx playwriter session new --direct 127.0.0.1:9223
```

If the relay restarts between calls, the session dies (`Session <id> not found`) but the scratch Chrome keeps running. Recreate with `session new --direct 127.0.0.1:9223` and rebind `state.page` from `context.pages()`.

The URL passed to `Start-Process` does not always open: the first tab can sit on a blank page with an empty URL (observed 2026-08-09). Bind `context.pages()[0]` and call `page.goto("http://localhost:5173/")` yourself instead of relying on the launch argument.

## Sign in

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

## Verify who you are

- `window.Clerk.user.primaryEmailAddress.emailAddress` is the signed-in email.
- The Convex `users` id is the `external_id` claim of `await window.Clerk.session.getToken({ template: "convex" })`.
- The sidebar account button's accessible name flips from `Anonymous account: …` to `Account: …`.

## Sign out

```js
await state.page.evaluate(() => window.Clerk.signOut());
await state.page.waitForFunction(() => window.Clerk?.user == null, { timeout: 15000 });
```

- After sign-out the app mints a **new** anonymous user (fresh `app::auth::anonymous_token_user_id`). You do not get the pre-sign-in anonymous identity back, so capture anything you need from it before signing in.
- The URL keeps its shape; `personal`/`home` re-resolve to the new identity's own default tenant.

## Clean up

- Sign out, close the scratch Chrome, remove its `--user-data-dir` folder, and delete the Playwriter session.
- Sign-in and sign-out themselves need no server-side cleanup. Clean up only the content fixtures the run created, as their owning account.
