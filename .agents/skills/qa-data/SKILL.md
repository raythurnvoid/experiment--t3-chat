---
name: qa-data
description: Catalog of the test data that already exists on the dev Convex deployment, and the rules for reusing it. Load before any task creates data there — browser QA, Playwriter runs, `convex run` fixtures, agent evals, uploads, second users, new orgs or workspaces — and when looking for a file, folder, or account to test with. It says where each kind of test file already lives, what costs money, and how to refresh the catalog.
---

# Why This Exists

The dev deployment already holds thousands of test files: Markdown, plain text, HTML, JSON, PDF,
images, video, audio, Office files, large folders, deep folders, and files with write rules. Agents
kept making new ones for every check, and new data costs money. So the goal is simple: **find a
file that already exists and test with it.** Create new data only when nothing fits.

The catalog is [references/inventory.md](references/inventory.md). It lists the workspaces, the
accounts, and a "what do you need" table that points to real files.

# Rules

1. **Look in the catalog first.** Find the row for the kind of file or folder you need and use
   that file. A file with a different name but the right shape is fine.
2. **Test on what exists.** In the `reuse` workspaces you may open, edit, rename, move, copy,
   share, and comment on existing files. If a catalog row describes a file's content and you
   change it, put the content back when you are done.
3. **Do not touch `read-only` data.** That is `sybill-demo/demo`, Ray's own notes, and files that
   a plugin writes. Read them, but do not change them.
4. **Create only when nothing fits.** Then:
   - Make it small: an empty folder or a short text file beats an upload.
   - Put it next to similar files in the workspace the catalog names for that kind of test.
   - Give it a name that says what it is (`long-table.md`, `nested-10-levels/`), not a run id or
     a date, so the next agent can find it.
   - Add a row to the catalog in the same session.
5. **Reuse identities.** Use the seeded `+clerk_test` accounts in a scratch browser for a second
   user ([clerk-test-accounts.md](../app-playwriter-harness/references/clerk-test-accounts.md)).
   Every browser profile with no session (for example a new headless Playwriter session) makes a
   new anonymous user, a personal org, and a workspace. Do that only when the check is about
   anonymous users.
6. **Do not create orgs or workspaces** unless the check is about creating them.
7. **Do not delete existing data.** If you think something should go, ask the user.
8. **Ask before a big fixture.** Hundreds of files or drafts cost many writes. Ask the user first,
   and say which catalog entry was not enough.

# What Costs Money

| Action | What you pay for |
| --- | --- |
| Upload to `personal/home` | The image, pdf, video, and data-probe plugins run on **every** upload in that workspace (their upload folder is `/`). That means model calls on top of storage. Upload in a `chitchat-qa` workspace instead, unless you are testing those plugins. |
| Any upload or generated file | R2 storage for as long as the file exists, plus database rows. |
| Agent chat turn | Model tokens on every turn. Chats can only be archived, so they stay. Reuse one chat per task. |
| Plugin run, transcription | Model or Modal compute per file. |
| Cloud browser session | Runner minutes while it is open. |
| New user, org, or workspace | Rows in many tables that stay. |
| Big fixture (thousands of files or drafts) | Many writes, and slow background work. A Discard of 3,781 drafts took more than 20 minutes just to plan. |

Cheap choices, in order: an existing catalog file; an empty folder or a short text file; a private
folder draft from `files_nodes:create_private_node_by_path` (no upload, no model call, recipe in
[files.md](../app-playwriter-harness/references/files.md)); an upload of a small repo fixture from
[app-playwriter-harness/assets/files/](../app-playwriter-harness/assets/files/) into a workspace
without auto-run plugins.

# Refresh The Catalog

Do this when the catalog looks out of date. It only reads data. Write the exports to the task's
personal `+ai` folder, never to the repo.

`convex data` refuses a `--limit` of 50,000 or more, and it has no cursor. So `files_nodes` and
`files_r2_assets` are read twice: newest rows and oldest rows. Rows created between the two
windows are missing, so check the time ranges the script prints.

```powershell
$d = "C:/Users/rt0/Documents/workspace/rt0/t3-chat-+personal/+ai/<task>-<YYYY-MM-DD>"
foreach ($t in "users", "organizations", "organizations_workspaces", "organizations_workspaces_users", "plugins_workspace_installations", "ai_chat_threads", "files_nodes", "files_r2_assets") {
	vp env exec pnpm --dir packages/app exec convex data $t --format jsonArray --limit 8000 > "$d/$t.json"
	echo "$t EXIT: $LASTEXITCODE"
}
foreach ($t in "files_nodes", "files_r2_assets") {
	vp env exec pnpm --dir packages/app exec convex data $t --format jsonArray --limit 8000 --order asc > "$d/$t.asc.json"
	echo "$t asc EXIT: $LASTEXITCODE"
}
vp env exec node .agents/skills/qa-data/scripts/summarize-dev-data.mjs $d
```

The script prints the orgs, workspaces, and members; the plugins with automatic upload runs; each
file type with example paths; files with write rules; the biggest and deepest folders; and the
top folders of each workspace. It skips archived files, anonymous personal orgs, and the `GLOBAL`
scope. Update the catalog from it. Do not copy emails or tokens into the catalog.
