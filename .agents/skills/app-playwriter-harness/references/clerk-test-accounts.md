# Clerk Test Account Login And Logout

Use this when a QA check needs a **specific** signed-in account: a specific role, data already attached to an account, or a flow that anonymous users cannot reach. For a generic "some non-owner member" check, prefer the anonymous identity in `second-user-fixtures.md` — it needs no account and no sign-in at all.

Login and logout with the seeded `+clerk_test` accounts is a supported autonomous flow. The fixed test code `424242` is Clerk's public, documented test-mode constant. It is fixture data, not a secret, and it only works for `+clerk_test` addresses on a development instance.

## Hard rules

- **Only in an isolated scratch browser** (section "Isolated browser" below). Never sign in or out in the user's own browser profile: this Clerk instance runs in single-session mode, so a sign-in there would kick the user out of their own session.
- **Only on the dev instance.** Before signing in, read `window.Clerk.publishableKey` and require the `pk_test_` prefix. Never run this against `pk_live_`.
- **Only `+clerk_test` fixture addresses with the code `424242`.** Never type a real password, a real verification code, or any other real credential. If a check needs a real account, hand that step to the user.
- **One account at a time.** Single-session mode means one browser profile holds one signed-in user. To use several accounts, cycle sign-out → sign-in in the same scratch profile.

## Seeded accounts (dev DB, verified 2026-08-02)

All emails end with `+clerk_test@example.com` and all accept the code `424242`.

| Email prefix       | Convex `users` id                  | Notes                                                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `qa.perm.owner`    | `m5747621ndk84yed1mg11f1ca98bcrbj` | Owns the `qa-browser` organization.                                                               |
| `qa.perm.admin`    | `m57dtqtg7wwvn6s7ta282b0fbx8bdsj8` | Not a member of `qa-browser`.                                                                     |
| `qa.perm.member`   | `m57ajc3qefttt0921x41ayhdrh8bcn06` | Owns `qa-tmp-share`. Not a member of `qa-browser` — opening it shows the access-denied screen.    |
| `qa.perm.viewer`   | `m5712hffzcfd0615e7qshgp6wd8bdgw3` | Member of `qa-browser` holding the `member` role (the name is misleading; see `app-map.md`).      |
| `import-qa-member` | `m57bevz11d996z3qrkyz63erfd8bnxx7` | Import QA fixture.                                                                                |

Do not infer membership or role from the account name. Before building a check on an account, read its membership back: `organizations.get_membership_by_organization_workspace_name` from its signed-in tab, or the `organizations_workspaces_users` table over the Convex CLI. The `qa-browser` members named `Bob Reader`, `New Owner` and charlie carry seeded fake `clerkUserId`s and cannot be signed in as.

## Isolated browser

Same setup as `second-user-fixtures.md` section 1: launch the installed Chrome for Testing with a temp profile and attach over direct CDP.

```powershell
$prof = Join-Path $env:TEMP "qa-clerk-profile"
$chrome = "C:\Users\rt0\.playwriter\browsers\chrome-<version>\chrome-win64\chrome.exe"
Start-Process $chrome -ArgumentList @("--remote-debugging-port=9223", "--user-data-dir=$prof", "--no-first-run", "--no-default-browser-check", "http://localhost:5173/")
vp env exec pnpx playwriter session new --direct 127.0.0.1:9223
```

If the relay restarts between calls, the session dies (`Session <id> not found`) but the scratch Chrome keeps running. Recreate with `session new --direct 127.0.0.1:9223` and rebind `state.page` from `context.pages()`.

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
