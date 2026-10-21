# Files

Use the [route index](references/route-index.md) for caller kinds. Paths are workspace-relative and start with `/`. Public reads select saved files for every caller, including short grants. Pending creates are missing until Save. Pending moves, replacements, and deletes do not change the saved path or content. Bash remains pending-aware.

## List and access

POST `/api/v1/files/list` with `{ path, cursor: null, limit: 100 }`. Optional fields are `recursive`, `kind: "file" | "folder"`, `extension`, `contentTypePrefixes`, and `order: "asc" | "desc"`. `scanLimit` is accepted and ignored. The page size is at most 100. Without `recursive`, it lists direct children in name order, or reverse name order with `order: "desc"`. A cursor works only with the order it was made for. With `recursive: true`, it walks in path order.

Success is `{ items, cursor, isDone }`. Items have `path`, `name`, `kind`, `nodeId`, `contentType`, `updatedAt`, `status`, `size`, and `locked`. A file's status is `pending` until its upload is confirmed, then `ready`. Folders and locked items have `status: null`. Missing sizes are `null`.

List a readable folder to see its locked children. A locked row gives file facts, not content or custom fields. Recursive reads show a locked boundary once and never enter a locked folder. A guest with an exact folder share may get 403 for `/`; list the shared path instead.

- Missing or archived folder: 404 `Folder not found: <path>`.
- Locked folder or file, or any path below a locked folder: 403 `Permission denied: <path>`. A missing descendant under that folder gets the same refusal.
- Readable file passed as a folder: 400 `Path must point to a folder: <path>`.

Keep all list fields unchanged while following a cursor. A short page is not the end: follow until `isDone`. Move, Rename, access context, or membership changes can end a cursor. On 400 `errorCode: "invalid_cursor"`, restart with `cursor: null` and deduplicate already returned node IDs. Do not inspect or edit the sealed cursor.

`extension: "md"` selects one extension. For type families use `recursive: true` and 1–8 `contentTypePrefixes`, with no extension. Values are whole families such as `image/` or exact types such as `image/png`; `image/p` is an exact type, not a prefix search. Filters use indexes. Narrowing the output does not open locked folders.

## Text and byte reads

| Route suffix under `/api/v1/files/` | Body | Success |
| --- | --- | --- |
| `read` | `{ path, maxBytes? }` | `{ path, target: { kind: "saved", id }, content }` |
| `read-many` | `{ paths, maxBytes? }` | `{ files: [{ path, target, content }], errors: [{ path, message }], truncated }` |
| `read-bytes` | `{ path, offset, length, revision }` | Raw bytes and revision/size headers |

Text reads serve editable Markdown and plain text types. `read` returns a whole file up to 900,000 UTF-8 bytes; `maxBytes` can lower that limit. `read-many` accepts at most 50 paths per effective request, up to 128,000 bytes per file and 384,000 content bytes total. Extra paths or a reached content budget set `truncated`. Send smaller batches to recover the rest; use `read` for a file above the per-item limit. This is not cursor paging. Check `errors` even on HTTP 200.

`read` returns 403 `Permission denied: <path>` for locked paths. Missing or too-large content returns 404 `File not found or exceeds the read limit.` `read-many` reports those messages per path in `errors`.

For exact saved bytes, use `read-bytes` with a canonical path, safe nonnegative integer `offset`, `length` from 1 through 1,048,576, and `revision: null` first. Read with `arrayBuffer()`, not `json()`. Save `X-File-Revision`, then pass it unchanged on later ranges. `X-File-Size`, `X-File-Offset`, and `X-File-Content-Type` describe the saved file. Editable text returns UTF-8 of saved Files text. An empty file or EOF returns an empty 200 body; an offset past EOF returns 416. Revision changes return 409. Errors are JSON. Locked paths return 403; missing files return 404 `File unavailable`.

Short grants share an 8 MiB byte budget in one `execute_code` run, across current/personal. Requested lengths spend the budget before I/O. Failed calls and retries are not refunded. Ordinary keys have the range cap and rate limits without that per-run budget. Short grants never mint signed download URLs.

## Text writes and empty files

POST `/api/v1/files/write` with `{ path, content, overwrite?: "replace" | "fail", skipIfUnchanged?, nonCollaborative?, contentType? }`. Success includes `path`, `nodeId`, `contentType`, and optionally `unchanged`. Empty text is refused; use `touch` with `{ paths: [...] }` for up to eight empty editable files.

`write-many` takes `{ files: [{ path, content, overwrite?, nonCollaborative?, contentType? }], skipIfUnchanged? }`: at most 20 files and 8,000,000 request bytes. Success is `{ written: [...], errors: [{ path, message, errorCode }] }`. Body validation is for the whole request. Runtime writes have per-item results; do not assume the whole batch rolled back. A mid-batch lost credential can return 401 after earlier writes finished. Reconcile saved results before retrying.

Writes save directly. Filling an editable file keeps its node ID. Replacing a stored binary file archives the old node and creates a new one. `overwrite: "fail"` returns 409 `A file already exists at this path`, also for a visible locked name. Overwriting a locked file, or writing any name below a locked folder, returns 403. A write policy can still refuse an otherwise allowed write.

An omitted type uses the new name's type hint; an existing editable file keeps its stored type. A requested type must be editable and match an existing editable target. `nonCollaborative: true` chooses saved-text storage for a new file; it does not change an existing file's mode. `skipIfUnchanged` can avoid a needless fill. Text saves need available credits and charge a file-save event when content is published. `touch` has no credit gate or save charge.

Names have at most 255 characters; new paths have at most 1,024. One action can add at most 32 new folders per path. Upload batches also limit distinct folder prefixes to 64. Split requests or use a nearer existing folder when a limit refuses a path. Conventional names such as `AGENTS.md` and `SKILL.md` are normalized at creation. Reads keep exact saved paths.

## Uploads and downloads

`upload-urls` takes `{ files: [{ path, contentType, size }], overwrite?, skipProcessing? }`, up to 20 files. Use the returned signed PUT URL and its required headers to send each complete file. Do not send the API key to that URL. Wait for list status `ready`; API acceptance is not proof that the bytes arrived. Uploads need a plan that supports them and available storage. Replacing a path changes its node ID. Editable text uploads convert unless processing is skipped. A signed PUT may remain usable until expiry after key revocation, so do not retain or share it. On a PC, the helper script in [setup](references/setup.md) does these steps for local files and folders.

`download-urls` takes `{ fileNodeIds, expiresInSeconds?, download? }`. Send at most 20 IDs to avoid clipping. Success has `items`, `errors`, and `truncated`; each item has its authorized URL and file facts. Maximum URL life is 900 seconds. `download: true` asks for attachment download. Check every per-ID error; a locked ID says `Permission denied`. URLs are temporary credentials. Do not publish or log them. Files scope checks remain separate from AI transcript access.

## Local write policy

`write-policy/get` takes `{ nodeId }`. `write-policy/set` takes `{ nodeId, writePolicy }`. Policies are `null`, `{ mode: "read_only" }`, or `{ mode: "writer", writers: [...] }`. A writer is `{ kind: "user", userId }` or `{ kind: "service_account", serviceAccountId }`. A writer list must contain one or more different active writers. Setting policy requires management permission on that target; a scope alone is insufficient.

## Anyone on the web

`public/set` takes `{ nodeId, public }`, where `public` is a boolean. Success is `{ nodeId, public: "on" | "inherited" | "off" }`. It needs `files:publish` and a personal key. A public file, or a file inside a public folder, can show as an image or video on public link pages. It never opens the file by ID. Turning it on needs management and read permission on the target; turning it off needs management. A scope alone is insufficient.

- `inherited` means a public folder above makes the item public. Turning such an item off returns 403; turn it off on that folder.
- Repeating the current value changes nothing.
- 400: bad body. 401: the key or its membership is unavailable. 404: missing, archived, or not managed by the key's user, or not readable for On. 409: the item is being moved; retry after the Move. 429: too many Sharing changes; wait `retryAfterMs`. 403: other refusals, such as a running access change above the item or a plugin-bound folder.

Plugin conditional writes, folder access, and sealed uploads have extra fields and retry rules. Read [plugin runtime](references/plugin-runtime.md) before using them. There is no public API to turn public file links on or off or retrieve their link tokens.
