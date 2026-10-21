# Create An API Key For The PC Upload CLI

Use this when the user asks you to create an API key in the app and set up the PC helper from the `press-api` skill (`.agents/skills/press-api/scripts/api.mjs`). The helper lists, reads, and uploads files from this PC. Its own guide is `.agents/skills/press-api/references/setup.md`. Read it first.

Do this only when the user asks. A key is a real credential on the user's account.

## Hard rules

- **Never print the key.** Keep it in `state` and print only its length. Mask `pk_[\w.\-*]+` before you print any page text.
- **Never write the key to a file.** Move it with the clipboard: the page's copy button, then `Get-Clipboard -Raw | ... login`. Clear the clipboard right after.
- **One workspace per key.** Ask which workspace when it is not clear. "My files" means `personal/home`.
- **Only the scopes the task needs.** Upload needs `files:list`, `files:read`, and `files:write`.
- Use your own tab in the QA Edge profile, and close it at the end. Do not sign in or out.

## Steps

Verified 2026-10-21 on the dev app. Run each step as a `-f` runner file from the task's personal `+ai` folder, with `--timeout 5000`.

1. **Find the API origin.** The dev app `https://app.dev.bonobo-senate.com` uses `https://grand-finch-267.convex.site`. If unsure, read `T3_API_ORIGIN` in the "Use an API key" code block on the page.
2. **Open your own tab.** Do not await the navigation (a cold page can take more than 5 s). Poll for the page in the next call.

   ```js
   state.page = await context.newPage();
   state.page.goto("https://app.dev.bonobo-senate.com/w/personal/home/api-keys").catch(() => {});
   ```

3. **Check the account.** The sidebar button reads `Account: <name>`. An anonymous user cannot create a key: the dialog then shows `Unauthenticated` at its end (see `known-hazards.md`, "Driving the public HTTP API"). The two app origins have separate sign-ins. On 2026-10-21 the QA profile was anonymous on `app.dev` (the page said "You do not have access to this organization/workspace") and signed in on `http://localhost:5173`. Both use the same deployment and API origin, so use whichever origin shows the account. On localhost, hot reload serves any uncommitted edits to the route. If the page goes blank with a page error, reload once.
4. **Open the create dialog.** Scope the click to the page header, because the dialog's submit button has the same name. The owned tab needs `bringToFront()` or the click can stall.

   ```js
   await state.page.bringToFront();
   await state.page.locator(".RouteApiKeysHeader").getByRole("button", { name: "Create API key" }).click({ timeout: 3000 });
   state.dialog = state.page.locator(".RouteApiKeysCreateModal");
   ```

5. **Put in the key setup.** The name and scopes are one JSON setup in a Monaco editor. Insert it as one line; do not `type()` it, because Monaco's auto-close doubles typed quotes and brackets. Then read the state and the scope list back before you submit.

   ```js
   await state.dialog.locator(".view-lines").click({ timeout: 2000 });
   await state.page.keyboard.press("Control+A");
   await state.page.keyboard.press("Delete");
   await state.page.keyboard.insertText('{"name": "Laptop upload CLI", "scopes": ["files:list", "files:read", "files:write"]}');
   console.log(await state.dialog.locator("form").getAttribute("data-api-key-setup-state")); // "valid"
   console.log(await state.dialog.getByRole("list", { name: "Scopes of the new key" }).innerText());
   ```

6. **Submit and keep the key in `state`.** The key is `pk_<32 hex>.<64 hex>`, 100 characters.

   ```js
   await state.dialog.locator("button[type=submit]").click({ timeout: 2000 });
   state.reveal = state.page.locator(".RouteApiKeysRevealModal");
   await state.reveal.getByRole("heading", { name: "Save your API key" }).waitFor({ timeout: 4000 });
   state.apiKey = (await state.reveal.innerText()).match(/pk_[0-9a-f]{32}\.[0-9a-f]{64}/)?.[0] ?? null;
   console.log("key length:", state.apiKey?.length ?? 0);
   ```

7. **Copy the key to the clipboard.** Use a real click on the page's copy button. A clipboard write from `page.evaluate` fails, because it has no user click. Then check the clipboard from PowerShell and print only `True` or `False`:

   ```js
   await state.page.bringToFront();
   await state.reveal.locator(".RouteApiKeysRevealModal-copy").click({ timeout: 2000 });
   ```

   ```powershell
   (Get-Clipboard -Raw).Trim() -cmatch '^pk_[0-9a-f]{32}\.[0-9a-f]{64}$'
   ```

8. **Save the key with `login`, then clear the clipboard.** `login` checks the key with `/api/v1/auth/verify` and saves it only when it works. Its output shows the scopes, not the key.

   ```powershell
   Get-Clipboard -Raw | vp env exec node <repo>\.agents\skills\press-api\scripts\api.mjs login --origin https://grand-finch-267.convex.site
   Set-Clipboard -Value $null
   ```

9. **Close up.** Click `I saved the key`, set `state.apiKey = null`, check that the new row shows the right scopes, then `await state.page.close()`.
10. **Check the setup.** Run `api.mjs status`. Then run `api.mjs upload <local folder> --to /Inbox --dry-run`. A dry run sends nothing. It exits 1 when any file would fail, for example an empty file.

## Notes

- The key file is `~/.config/bonobo-senate/credentials.json`. It is outside `AppData`, so the user's own terminal sees the same key as the Claude desktop app.
- `logout` deletes the key file but does not revoke the key. To revoke it, click `Revoke <name>` on the API keys page.
