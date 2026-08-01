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
