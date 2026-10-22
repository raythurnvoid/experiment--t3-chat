---
name: gmail-plugin
description: Work on the Gmail plugin (`plugins/bonobo-plugin-gmail`) — email sync to Files, the Mail page and its draft tools, Gmail push through Google Pub/Sub, releases, and live mail checks. Use when changing the plugin's code, releasing a new version, setting up Gmail push or OAuth for another Google account, rotating the push token, or checking that new mail reaches Files.
---

# Gmail plugin

The plugin lives in the submodule `plugins/bonobo-plugin-gmail` (its own GitHub repo under `<owner>`). It has its own Convex deployment, named in its ignored `.env.local`. Bonobo Senate only hosts its pages and Files. See "Plugin Boundaries" in the root `CLAUDE.md`.

The plugin `README.md` is the spec: sync timing, recovery, limits, the Mail page, drafts, and Google setup. Read the section you touch before you change it, and update it in the same change. Release history (what each version changed and its live check) is in `../plugin-system/SKILL.md`, in the Gmail paragraphs.

Load `../plugin-system/SKILL.md` for publishing, and `../convex/SKILL.md` before changing its Convex code.

## Private notes

Setup values (Google project id, topic, subscription, accounts) are private. Do not commit them, here or in the plugin repo. They are in `../t3-chat-+personal/+ai/gmail-push-setup-2026-10-22/setup-steps.md` (path from the repo root), outside the repo. That file also has the full Cloud Console click path with every field value. Update it when the setup changes.

## Secrets

- Never print or log a token, key, or a raw `convex data gmail_accounts` row: rows hold encrypted tokens and private addresses. Write the rows to a file in the scratch folder and print only the fields you need with a small Node script.
- `convex env list` prints every value. Write it to a file and print only the names.
- Do not type a secret through Playwriter: it logs typed text (see "Playwriter logs every value you type" in `../app-playwriter-harness/references/known-hazards.md`).
- The push token is in the Pub/Sub subscription URL and in `GMAIL_PUSH_TOKEN`. Never log `request.url` in the push route. To rotate it, follow "To change the token" in the README.

## Checks

From `plugins/bonobo-plugin-gmail`, all through `vp env exec`: `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:once` (about 2 minutes). The files are not prettier-formatted, so do not run prettier on them.

## Release

1. Bump `version` in `package.json` and `bonobo.plugin.json`. Do not write them with PowerShell `Set-Content -Encoding utf8`: it adds a BOM, and pnpm then fails with "expected value at line 1 column 1".
2. `vp env exec pnpm run build`, then the checks above.
3. Commit in the plugin repo and push it (pinned-token recipe in the root `CLAUDE.md`, with the plugin repo's remote).
4. Deploy the backend from that pushed commit while no slice runs: `vp env exec pnpm exec convex dev --once --typecheck disable`. A schema change that makes a field required needs two deploys: first optional plus a backfill, then required (see `../convex-migrations/SKILL.md`).
5. Publish in the app and press Update on the installation. The publish review sometimes ends with "could not finish its assessment". Retry the same commit; 0.3.12 needed three tries.
6. Open the Gmail or Mail page and keep it open until the next slice. The update makes Bonobo Senate refuse the old sync grant, and only an open page renews it.
7. Update the gitlink in this repo, add a Gmail paragraph to `../plugin-system/SKILL.md`, commit and push.

## Live checks

- Send test mail only between the two accounts named in the private notes, in the direction they say. Do not send to anyone else.
- A new email should reach Files within about a minute while push is on. Read the account's `lastSyncedAt`, `nextSyncAt`, `idleSlices` and `watchExpiresAt` with the safe script, and the plugin deployment logs with `convex logs` (it streams forever, so run it in the background and stop it).
- The Gmail page card has `data-gmail-push="on"` while the watch is live.
- Do not send CDP commands to a tab that has a plugin frame (see known-hazards).

## Push setup for another Google account

Follow "Push notifications" in the plugin README, and the private notes for the exact field values. Each OAuth client's project needs its own topic, Publisher grant, subscription and token. The topic must be in the same Google Cloud project as the OAuth client.
