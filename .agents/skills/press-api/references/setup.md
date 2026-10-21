# PC setup and the helper script

This guide is for a terminal on a PC. Inside the app, use the hidden grants in [auth](references/auth.md) instead. The helper script there has no key and does not apply.

The helper is [api.mjs](scripts/api.mjs). It needs Node 22 or newer and has no dependencies. Run it by its path inside this skill folder, for example `node <skill folder>/scripts/api.mjs status`.

Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 4 no API key is set up.

## 1. Check for a key

Run `status` first. It prints where the key came from, the API origin, and the result of `/api/v1/auth/verify` (organization, workspace, scopes). It never prints the key.

- Exit 0: the key works. Check that its scopes cover the task, then go on.
- Exit 4: no key is set up. Go to step 2.
- Exit 1: the key does not work, for example because it was revoked. Go to step 2 for a new key.

The script reads `T3_API_KEY` and `T3_API_ORIGIN` when `T3_API_KEY` is set. Otherwise it reads `~/.config/bonobo-senate/credentials.json` (or `$XDG_CONFIG_HOME/bonobo-senate/credentials.json`). The key lives there, outside this skill folder, so a skill update cannot delete it and a copy of the skill cannot carry it. Do not read, print, copy, or move that file. Never put the key in chat, in a command line, or in a file you write.

## 2. Create a key (the user does this)

Do this only when the user asks for setup. An agent cannot create a key: only a signed-in user can, on the app's API keys page. Tell the user:

1. Open the workspace in the app, then open **API keys** (`/w/<organization>/<workspace>/api-keys`).
2. Create a key with only the scopes the task needs: `files:list` and `files:read` to read; add `files:write` to upload or write; add `files:download` for download URLs and byte reads.
3. Copy the key. The page shows it only once.
4. Copy the API origin from the "Use an API key" section of the same page (the `T3_API_ORIGIN` value). It is not the app website address.

A key works in one workspace only. Another workspace needs its own key.

## 3. Save the key (the user does this)

The user runs `login` in their own terminal, so the key never passes through the agent:

```sh
node <skill folder>/scripts/api.mjs login --origin <api origin>
```

It asks for the key with a hidden prompt, checks it with `/api/v1/auth/verify`, and saves it only when it works. Where the hidden prompt does not work (Git Bash in mintty, for example), pipe the key from the clipboard instead: `Get-Clipboard | node ... login --origin <api origin>` in PowerShell, or `pbpaste | node ...` on macOS.

If you can open a terminal tab that the user types into, you may start the command there and let the user paste. Do not ask the user to send you the key. Run `status` again when the user is done.

In a sandbox with a network allowlist (for example the Claude Code sandbox), the API origin's host must be allowed. If requests fail with a network error, tell the user. Do not move the key somewhere else to work around it.

## 4. Call a route

```sh
node <skill folder>/scripts/api.mjs call files/list '{"path":"/","cursor":null,"limit":100}'
```

`call <route> [json | -]` sends one POST to a route from the [route index](references/route-index.md). Use `-` to read the JSON body from stdin, which avoids shell quoting problems. With no body, it sends none (`auth/verify` needs none).

- Success: the JSON response goes to stdout. A raw byte response (`files/read-bytes`) goes to stdout unchanged, so redirect it to a file.
- Failure: `HTTP <status>: <message>` and the JSON error body go to stderr, with exit 1. `call` does not retry. On 429, wait `retryAfterMs`, then send the same request again.

## 5. Upload files and folders

```sh
node <skill folder>/scripts/api.mjs upload ./photos ./notes.md --to /Inbox --dry-run
node <skill folder>/scripts/api.mjs upload ./photos ./notes.md --to /Inbox
```

In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first. Otherwise Git Bash turns `--to /Inbox` into a Windows path such as `C:/Program Files/Git/Inbox`, and the script refuses it. Then write local paths as `C:/...`, not `/c/...`.

A local folder keeps its own name under `--to`, like `cp -R`: `./photos/a.png` becomes `/Inbox/photos/a.png`. Missing folders are created. Run `--dry-run` first: it prints every target path, type, and size, and sends nothing.

The script follows the upload steps in [Files](references/files.md): `upload-urls` in batches of 20, then one PUT per file. It waits and retries when rate limited. When the server refuses one file by path (a name clash with `--overwrite fail`, a locked folder), it reports that file and goes on with the rest. A refusal that hits every file (a bad key, a plan without uploads, full storage) stops the run, and every file left is reported with that reason.

The output is `{ uploaded: [{ local, path, nodeId }], failed: [{ local, path, message }] }`. Exit 1 means at least one file failed. Empty files are refused, because an upload needs at least 1 byte; use `files/touch` for an empty text file. `--overwrite replace` is the default. `--skip-processing` keeps text files as uploaded bytes instead of editable documents.

An uploaded file is `pending` until the server confirms its bytes. List its folder with `files/list` and wait for `status: "ready"` before you call the upload done.

## 6. Organize folders

The public API has no route to create an empty folder, move, rename, copy, or delete. Folders appear when you upload or write a file into them. Do not try other routes to get these effects. Tell the user the API cannot do it yet.

## 7. Log out

`logout` deletes the saved key file. It does not revoke the key. Tell the user to revoke it on the API keys page too.
