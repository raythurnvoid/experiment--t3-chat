# Plugin Marketplace QA (install / uninstall / update)

Recipes for driving the Plugins catalog and plugin detail pages. Selectors and behavior verified 2026-08-01 on the dev deployment.

## Naming trap

- `video` is the transcription plugin (auto-runs on video uploads, needs publisher secrets). `video-player` is the file-view player plugin. The catalog card titles ("Video" vs "Video Player") look alike — confirm the route name before installing. When unsure, read `name` in the plugin repo's `bonobo.plugin.json`.
- Detail page route: `/w/<org>/<workspace>/plugins/<pluginName>`.

## Page readiness

After `goto`, the SPA renders a bootstrap shell ("Preparing organization") first. Wait for real content, not a fixed timeout:

```js
await state.page.goto("http://localhost:5173/w/personal/home/plugins/video-player", {
	waitUntil: "domcontentloaded",
	timeout: 45000,
});
await state.page.waitForFunction(() => document.body.innerText.includes("Version"), { timeout: 30000 });
```

These in-script waits exceed the CLI's default 10s execute timeout. Size the CLI flag above the longest in-script wait (for example `--timeout 50000`), or split the `goto` and the readiness poll into separate short calls.

Read install state from the page text: the detail page shows `Installed` plus a `Version x.y.z` line, and the action button is `Install`, `Update`, or `Uninstall`.

## Install / update / uninstall

- Install: click `Install` (`exact: true`), then the consent modal's `Accept and install`.
- Update: click `Update` (`exact: true`), then `Accept and update`. Match `/Accept and (install|update)/` when the flow may be either.
- Uninstall: `Uninstall` (`exact: true`) applies immediately — there is no confirm dialog.
- The `plugins_manage` rate limiter is a token bucket (capacity 2, ~6/min). Space install/uninstall/update mutations ~15 seconds apart, or the next mutation fails.
- Before clicking, check that no open dialog backdrop covers the page. The org/workspace switcher is a frequent blocker — close it with its own `Cancel`. Do not treat `querySelector('[role="dialog"]')` as proof a dialog is open (see `known-hazards.md`: many dialogs stay mounted while closed).

## Publisher pages

After a successful publish, the publisher card turns into a link to the plugin detail page. The `Publish` button for a republish lives on the detail page, not on the card.

The claim form's submit button is named `Claim` (`exact: true`) — there is no button named "Claim repository".

## Publishing a QA fixture plugin without GitHub

When a check needs a plugin with an arbitrary manifest (for example specific `secrets[]` declarations), publishing through GitHub is overkill. Claim a fake repository URL through the publisher UI as the signed-in user, then register the version with the operator-invokable internal mutations from the CLI (see the CLI recipe in `snippets.md` for the command wrapper and the JSON5 args syntax):

1. In the browser, claim a unique URL like `https://github.com/<user>/qa-health-<date>` with the `Claim` button.
2. Read the new claim's `_id` and `ownerUserId` back with `convex data plugins_publisher_repositories` — do not trust an older seeded claim, the owner differs.
3. Run `plugins:upsert_plugin` with the manifest fields (pass `createdBy` = the claim's `ownerUserId` so publisher-tier rules match), then `plugins:finalize_plugin_version` to flip it `ready`.
4. Cleanup: uninstall from every workspace, then run `plugins:hard_delete_plugin_from_registry "{pluginName:'<name>'}"` repeatedly until it returns `done: true`, and check the claim is gone from `plugins_publisher_repositories`.

## Manage secrets dialog

Reachable only for an **installed** plugin that declares `plugin.secrets.read` (`video` does,
`video-player` does not). The panel is `.RoutePluginsPluginSecrets`; open the dialog with the
`Manage secrets` button.

Inside the dialog the Name field is `input[placeholder=OPENAI_API_KEY]` — the placeholder is a
literal example, not the stored secret. Buttons are `Save`, `Close`, and one
`Delete workspace secret <NAME>` per stored secret. Scope with
`locator("[role=dialog]").filter({ hasText: "Manage secrets" })`; many dialogs stay mounted while
closed on this route.

To drive the **batch** (`.env`) import path, write the KEY=value text to the clipboard and paste into
the **Name** field — pasting multi-line text there is what triggers the batch mutation. A paste into
Value refuses multi-line input by design:

```js
await state.page.evaluate(() => navigator.clipboard.writeText("A=1\nB=2"));
await dialog.locator("input[placeholder=OPENAI_API_KEY]").click();
await state.page.keyboard.press("Control+v");
```

Read `[data-sonner-toast]` in the **same** execute call as the paste; the batch result is reported
only as a toast, and sonner auto-dismisses it.

## Minting a plugin_ui token for API checks

A file view's `plu_` token never appears in main-frame network traffic — `page.on("request")` on the
host page captures nothing, because the host mints the token over the Convex websocket and hands it
to the sandboxed iframe. To exercise the token directly, mint one through the app's own authenticated
client (this runs as the signed-in user, so it is a user path, not a bypass):

```js
const { app_convex, app_convex_api } = await import("/src/lib/app-convex-client.ts");
const { app_fetch_main_api_url } = await import("/src/lib/fetch.ts");
const membership = await app_convex.query(
	app_convex_api.organizations.get_membership_by_organization_workspace_name,
	{ organizationName: "personal", workspaceName: "home" },
);
const views = await app_convex.query(app_convex_api.plugins_ui.list_file_views, {
	membershipId: membership._id,
});
const minted = await app_convex.mutation(app_convex_api.plugins_ui.mint_file_view_session, {
	membershipId: membership._id,
	pluginName: views[0].pluginName,
	fileViewId: views[0].fileViews[0].id,
	fileNodeId: "<a node whose contentType the view declares>",
});
```

`membershipId` is not readable from the DOM; this query is the way to get it. `/api/v1/files/read`
takes a **path**, not a node id, so a cross-file check is `body: { path: "/README.md" }`.

## Upload fixtures for file-view QA

The sandbox cannot read repo or personal-folder files, so an upload runner must embed its payload. Generate the runner from a fixture with PowerShell, then run it with `-f`:

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("path/to/fixture.mp4"))
Set-Content runner.js ("const FILE_B64 = `"$b64`";`n" + (Get-Content -Raw upload-template.js))
```

In the runner, target the hidden file input on the `/files` route:

```js
const input = state.page.locator('input[type="file"][aria-hidden="true"]');
await input.setInputFiles({ name: "fixture.mp4", mimeType: "video/mp4", buffer: Buffer.from(FILE_B64, "base64") });
```
