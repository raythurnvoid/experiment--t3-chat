---
name: ai-chat-agent
description: Practical guide for the current app chat agent implementation (AI SDK 5 + Convex + files tools). Use this when implementing or modifying the chat agent, its HTTP routes, thread persistence, tool behavior, files semantics, pending-update integration, or OpenCode-inspired edit/search flows.
---

# Source Of Truth Files

Primary:

- `../../../packages/app/convex/ai_chat.ts`
- `../../../packages/app/convex/bash.ts`
- `../../../packages/app/server/bash.ts`
- `../../../packages/app/server/bash-cat-command.ts`
- `../../../packages/app/server/bash-cp-command.ts`
- `../../../packages/app/server/bash-find-command.ts`
- `../../../packages/app/server/bash-grep-command.ts`
- `../../../packages/app/server/bash-head-tail-wc-command.ts`
- `../../../packages/app/server/bash-ls-command.ts`
- `../../../packages/app/server/bash-search-command.ts`
- `../../../packages/app/server/bash-delegate.ts`
- `../../../packages/app/server/bash-meta-command.ts`
- `../../../packages/app/server/bash-mv-command.ts`
- `../../../packages/app/server/bash-nested-shell-command.ts`
- `../../../packages/app/server/bash-rm-command.ts`
- `../../../packages/app/server/bash-sed-command.ts`
- `../../../packages/app/server/bash-stat-command.ts`
- `../../../packages/app/server/bash-tee-command.ts`
- `../../../packages/app/server/bash-textgrep-command.ts`
- `../../../packages/app/server/bash-touch-command.ts`
- `../../../packages/app/server/bash-tree-command.ts`
- `../../../packages/app/server/bash-utils.ts`
- `../../../packages/app/server/bash-xargs-command.ts`
- `../../../packages/app/server/bash-which-command.ts`
- `../../../packages/app/server/server-ai-tools.ts`
- `../../../packages/app/convex/files_nodes.ts`
- `../../../packages/app/convex/r2.ts`
- `../../../packages/app/convex/files_pending_updates.ts`
- `../../../packages/app/server/files.ts`
- `../../../packages/app/server/files-markdown-chunking-mastra.ts`
- `../../../packages/app/src/hooks/ai-chat-controller.tsx`
- `../../../packages/app/src/components/ai-chat/ai-chat.tsx`
- `../../../packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx`
- `../files-agent-pending-updates/SKILL.md`

# Architecture Overview

The current agent is a Convex-backed AI chat runtime that streams AI SDK 5 UI messages, persists threads/messages in Convex, and exposes a small server-side toolbelt focused on Markdown files in the app file tree.

- Main request path: `POST /api/chat`
- Secondary title path: `POST /api/v1/runs/stream` for `assistant_id = "system/thread_title"`
- Main runtime owner: `ai_chat_http_routes` in `../../../packages/app/convex/ai_chat.ts`
- Thread/message storage: Convex tables for `ai_chat_threads` and `ai_chat_threads_messages_aisdk_5`
- Tool implementation: `../../../packages/app/server/server-ai-tools.ts`
- Files node data/query layer: `../../../packages/app/convex/files_nodes.ts`
- R2 upload/event metadata and source conversion/finalization: `../../../packages/app/convex/r2.ts`

The files system is a db-backed file/folder model scoped by organization/workspace membership. Folders are tree nodes only. Markdown files have Yjs snapshots/updates, Markdown chunks, and plain-text chunks; committed current content is read from the chunks, and R2 keeps only Yjs and version snapshot objects for editable files. Uploaded source files preserve the original binary in R2. Enabled `files.upload.completed` plugins may create ordinary visible Markdown siblings.

# Main Request Flow

For `POST /api/chat`:

1. Validate the request body, including allowlisted `model`, `mode`, and `trigger`, and require one of `threadId` or `clientGeneratedThreadId`.
2. Resolve the authenticated or anonymous app user and load the app `users` doc.
3. Load the membership doc, then rate-limit the request.
4. Check the workspace permission through `get_current_user_workspace_permission`: `content.read` in both modes, plus `content.write` for `mode: "agent"`. Two separate questions, not "the stronger one" — the catalog lets an owner compose a write-without-read role. Such a role never actually reached bash (`thread_get` and `thread_create` gate on `content.read` as well) but it got a 400 that reads like a malformed request, and the route was relying on another handler's gate; asking here makes it self-gating and the answer a correct 403. This runs before any tool executes, and it is **the** authorization boundary for the AI file tools — the internal file functions they call take a `userId` argument and check nothing themselves, so a gap here is a gap in the whole file surface. Ask mode is read-only because its write tools are left out of the tool registry handed to `streamText`, and bash **app-file** writes are gated by `allowDbFilesMkdir: false`. That flag does not touch the per-thread `/tmp` scratch filesystem, which stays writable in both modes. Excluding a tool from `activeTools` does **not** make it unreachable: the AI SDK uses `activeTools` only to build the provider payload, while parsing and execution look the name up in the `tools` record. Keep the registry itself mode-correct.
5. Derive the agent configuration and validate UI messages against the full registry (`validationTools`, which keeps the write tools so stored history from an agent-mode turn still validates in ask mode).
6. Enforce the image-attachment contract on incoming messages: every file part must use an allowlisted image media type (`ai_chat_MESSAGE_IMAGE_MEDIA_TYPES`) with a matching `data:<mediaType>;base64,` URL, with at most `ai_chat_MESSAGE_IMAGE_MAX_COUNT` file parts and `ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS` total URL chars per message. Anything else returns 400 `Invalid image attachments`.
7. Resolve the existing thread or keep the optimistic client thread id for a new thread, then credit-gate before LLM work.
8. Create the thread if needed and persist incoming user messages before generation.
9. Convert stored UI messages to model messages, then decode image data URLs into bytes. The AI SDK routes URL-shaped file parts through its download step and Convex `fetch` cannot request `data:` URLs, so without the decode the model call fails with "Failed to download data:...".
10. Run `streamText(...)` with the current tools and `activeTools`.
11. Stream UI message chunks back through `createUIMessageStreamResponse(...)`.
12. Persist the assistant response in `onFinish`.
13. If the thread has no title yet, generate a short title and persist it.
14. Emit `ai_usage` billing events from captured token usage after successful generation.

Non-obvious runtime details:

- Ask mode drops the write tools (`ai_chat_WRITE_TOOL_NAMES`, today just `edit_file`) from the `tools` record `streamText` receives, not only from `activeTools`. `validationTools` keeps the whole registry so a thread that ran in agent mode still validates its stored `edit_file` parts when reopened in ask mode. Agent-mode file writes otherwise go through `bash` shell writes.
- User messages are persisted before generation so they survive aborts/stopped generations.
- As soon as a running user message is visible, the shared message list shows a temporary `Thinking` assistant row without message actions. This covers the time before AI SDK creates the assistant message. While the running assistant message has no visible text, reasoning, tool, file, or source part, its renderer keeps showing `Thinking`. Active runs use their live parts so the placeholder disappears with the first visible part and does not remain beside later streaming text or tool calls. Empty text and reasoning parts do not count as visible content. Do not show the placeholder for a non-running empty assistant message.
- Pre-stream send failures, such as credit-gate HTTP failures, remain transient client state in AI SDK `chat.error`; the UI shows inline feedback on the failed user message and retries by replacing that same client-only message from its original parent without appending a duplicate.
- A running thread accepts up to 10 client-only queued user messages. Keep them in the shared thread session and do not add them to the visible transcript until each turn starts. Their current array order is their execution order. Each queued message keeps the text, image attachments, model, and mode selected when it was added; the tray row shows an image count next to the text. The tray uses the message as its Edit and Reorder action, keeps Remove separate, and has no user-facing Clear action. A click edits the message, while a pointer or keyboard drag reorders it. Editing uses the main composer and a session-owned copy of the queued item. The edit composer shows only the Save action. Save replaces that item by stable id and does not send by itself; pressing Escape cancels and leaves it unchanged. Keep the normal composer draft separate. Let earlier queued messages keep draining while a later item is being edited, but never claim the edited item itself. Reorder only unstarted items by stable id and keep the edited item selected by id after a move. Block queue claims from drag start through drag end so a row cannot start while the user is moving it. Normally drain only the selected persisted thread after the exact prior AI SDK request settles and its latest message is persisted in Convex (has a Convex id). The chat transport treats an HTTP 429 with a valid `retryAfterMs` as part of the same exact request. It waits, retries the same message id, and stays abortable through Stop. Any other failed active turn stays visible with the normal failed-send feedback and pauses every later queued message without changing their order or text. This also applies when the thread is still optimistic, when an empty assistant placeholder exists, and when Convex persisted the failed user before the stream broke. Resume retries that visible failed turn before unpausing its followers. The failed message's Retry action does the same. Another failure pauses the followers again; a successful retry lets them drain normally. Stop also pauses unstarted queued messages, including a message queued before the stopped request finishes settling, but it does not create failed-send feedback. Once the stopped request settles, the normal composer uses Send and starts a new direct turn without removing or resuming the older queued messages. A queue paused by an error still uses Queue. Resume clears a Stop-owned pause when there is no failed turn to retry; editing the next queued message can still block draining. If Stop leaves an empty client-only assistant, drop it only after its parent is persisted. The store-only `clearQueuedUserMessages` action handles lifecycle cleanup. Reload, tenant changes, archive/delete, branch-anchor changes, transcript edits, and regeneration clear stale queued messages; switching between mounted chat surfaces in the same tab keeps them.
- While a response runs, the composer has one action button. Empty content (no text and no image attachments) shows Stop. Text or attachments show Queue with the normal send icon. The accessible name and tooltip change with the action.
- The composer supports `@` file mentions (`../../../packages/app/src/components/ai-chat/ai-chat-composer-file-mention.tsx`). Typing `@` at a word start opens a caret-anchored popup over the workspace tree (`files_nodes.list_tree`, archived nodes excluded); picking an item inserts an inline chip. On send the chip serializes into the plain message text as `@/path/to/file.md`, or `@/docs/` with a trailing slash for a folder, so the message stays one plain string and no structured mention data exists anywhere. The system prompt tells the model to resolve those tokens under the current workspace path. Reloading a stored string into the composer (draft restore, queue edit, message edit) shows the token as plain text, which sends identically. While the popup is open, the composer's own Enter/Escape/Arrow handlers yield through `ai_chat_composer_file_mention_PLUGIN_KEY`, so Enter picks a row instead of submitting and Escape closes only the popup.
- The composer accepts image attachments through clipboard paste, drag-and-drop, and a file picker opened by the plus button that sits last in the configurations row, after the Mode and Model selects (36x36 `MyIconButton`, tooltip "Attach images"). Pasted files are ingested only when the clipboard has no real text, because spreadsheet cells copy as text plus an image render; whitespace-only `text/plain` does not count as text. Dropped files are captured at the form level in the capture phase so ProseMirror never handles file drops. The attachments bar above the editor renders only while at least one attachment exists and holds one removable chip per image, built from the shared `MyChip`/`MyChipRow` primitives in `../../../packages/app/src/components/my-chip.tsx` (20px thumbnail, truncating label, and a full-bleed 36x36 remove button filling the chip's right end). Attaching the first image grows the composer by one chip row and removing the last one shrinks it back; while the bar exists, the chip row reserves the measured horizontal scrollbar gutter inside its own height (`--app-scrollbar-w`, 0 on overlay-scrollbar systems), so the sideways scrollbar appears below the chips without shifting layout. The editor area gives the bar row a definite height when the bar exists, because Chromium leaves the bar out of the subgrid composer's intrinsic height measurement; the message-edit bubble sizes itself from that measurement, so with an auto row the bar overflowed the bubble and the rows painted over each other. Overflowing chips scroll sideways with a visible scrollbar, and the row also maps plain vertical wheel input to that sideways scroll (shift+wheel is left to the browser's native horizontal scroll). The chip row is one tab stop: Left/Right arrows move between the remove buttons, and a keyboard removal (Delete, Backspace, Enter, or Space) moves focus to the next chip, else the previous one, else back to the editor, while a pointer removal always returns focus to the editor. The client re-encodes images before attaching (2048px long-edge cap, WebP with JPEG fallback, GIF passthrough) and stores each one as a base64 data URL inside an AI SDK `FileUIPart`. The shared caps in `../../../packages/app/shared/ai-chat.ts` bound the count and the total data-URL size so the stored message fits in one Convex document. Non-image files and over-cap images get a toast and attach nothing. Submit is blocked while an image is still being decoded and compressed, so a fast Enter after a paste cannot send the message without its image. An image-only message is a valid send everywhere: draft send, new chat, queue, queue edit save, retry, and message edit. Draft attachments live in the thread session next to the draft text and survive the optimistic-to-persisted thread swap. Explicitly removing every image in a message edit or queue edit sends without images; the transcript renders user file parts as inline images from the stored data URL.
- Thread/file access is scoped by a `membershipId` doc that determines the effective organization/workspace scope.
- Auth falls back to an anonymous user identity when a signed-in identity is unavailable.
- The chat HTTP action resolves the current app `users` doc once and passes `user._id` into AI file tools; file-tool internals should use that id instead of re-reading auth from Convex context.
- `bash` is presented as the normal shell interface for the current workspace path `/home/cloud-usr/w/{organizationName}/{workspaceName}` under the app mount `/home/cloud-usr/w`.
- Client-side thread selection is surface-owned through `AiChatController` in `../../../packages/app/src/hooks/ai-chat-controller.tsx`. Surfaces pass only their typed storage key: full-page chat uses `app_state::ai_chat_last_open::scope::<membershipId>` and the `/chat` route owns the shareable `threadId` search param, while the file sidebar agent uses `app_state::file_editor_sidebar_agent_selected_tab::scope::<membershipId>` and the controller derives the matching open-tabs key internally. The full-page route should validate persisted `threadId` values through `ai_chat.thread_get`, restore the selected thread from the URL on refresh, update the URL when the selected thread changes, and clear a missing `threadId` while selecting the first visible chat. `AiChatController` is also the hook namespace for `useThreadList`, `useThreadRuntime`, and direct shared render-state selectors through `useStore`. Use `ai_chat_is_optimistic_thread` for thread objects. For stored ids, use a local `ai_thread-` prefix check whose dashed prefix satisfies `GeneratedIdPrefix`; `GeneratedIdPrefixKey` is the non-dashed key accepted by `generate_id`. The shared Zustand store keeps sessions, draft model/mode, message caches, running/error maps, and editing state, but does not own `selectedThreadId`.
- `ai_thread-*` ids are client-only optimistic thread ids. Local-storage restore paths may rehydrate them as ordinary client sessions, drop them, or upgrade them to the persisted Convex thread id matched by `clientGeneratedId`, but must never send them as persisted thread ids. Request preparation should classify optimistic threads from the `ai_thread-*` id prefix and send `clientGeneratedThreadId`; an `ai_thread-*` id sent as `threadId` causes `/api/chat` request validation failure.
- Frontend message identity is normalized once in `AiChatController`: persisted messages and live AI SDK messages matched by `clientGeneratedMessageId` should carry `metadata.convexId`, `metadata.convexParentId`, and `metadata.parentClientGeneratedId`. Every rendered message also carries its own `metadata.clientGeneratedId`: persisted rows copy `clientGeneratedMessageId`, and the controller stamps live AI SDK messages with their own id. Send, retry, and can-send logic should trust `metadata.convexId` instead of re-deriving persisted identity from several lookup maps.
- When a streamed message finishes and its persisted row syncs back, the UI message id flips from the client-generated id to the Convex id in place. The message list uses index keys and `ai-chat-message.tsx` keys each message's content by `metadata.clientGeneratedId`, so open tool-output disclosures survive that swap instead of remounting closed. Keep both keys stable across this transition when changing message rendering.
- Optimistic thread list items are derived display objects, not session state. Keep their object identity stable with the module-level keyed cache in `AiChatController`; do not replace it with a render-read `useRef` map because React Compiler lint rejects ref reads during render.

# Current Toolbelt

The main tool object contains exactly four tools:

- `bash`
- `edit_file` (the whole of `ai_chat_WRITE_TOOL_NAMES`; absent from the registry in ask mode)
- `web_search`
- `execute_code`

`read_file`, `list_files`, `glob_files`, `grep_files`, and `write_file` were deleted, not deactivated — `bash` replaced all five, and the `BASH_REPLACED_TOOL_NAMES` list that used to hold them is gone too. Old threads still render their stored parts, because rendering reads the message, not the registry.

Important limitation:

- These tools operate on db-backed app files, not repo files on disk.
- `bash` is the active shell interface for the cloud file environment. It is still not the host shell, but `/tmp` exposes the safe Just Bash native-style scratch command surface while the app mount stays db-backed.
- `bash` mounts app files at the current workspace path `/home/cloud-usr/w/{organizationName}/{workspaceName}` and provides durable per-thread scratch space at `/tmp`. In Agent mode, shell content writes (`>`, `>>`, heredoc redirects, `touch`, `tee`) create pending content proposals through `bash_DbFilesFs.writeFile`/`appendFile`, `mkdir` creates folders, app-to-app `mv` creates pending move or rename proposals, app-to-app `cp` creates pending copy or replacement proposals, and `rm` creates pending delete proposals (accept archives the file; `rm -r` archives a folder with its contents; `rm` on the acting user's own not-yet-accepted new file removes it immediately). Links and `sed -i` remain rejected. Ask mode rejects all these durable app mutations.
- App-mount limitations apply only to paths under `/home/cloud-usr/w/{organizationName}/{workspaceName}` or the app mount `/home/cloud-usr/w`. Do not describe those limits as global Bash limitations. For commands that touch only `/tmp` paths or stdin, use normal scratch command behavior.
- Native-style `/tmp` commands use Just Bash's own argument parsing and include safe text/file utilities such as `du`, `diff`, `rg`, `jq`, `base64`, `sha256sum`, `nl`, `rev`, and `tac`; the Unix `file` command is intentionally unavailable.
- If `file` fails or the user asks for it, do not stop after reporting that it is unavailable; run supported recovery commands such as `stat`, `wc`, `head`, or `cat` on the same `/tmp` path when that answers the request.
- `/tmp` native commands are Just Bash browser commands, not host GNU coreutils. Prefer simple portable forms such as `du file`; if a `/tmp` option fails but the command is useful, retry once with simpler native syntax.
- When retrying a `/tmp` command option, prefer doing related scratch work in one call when convenient, but previous `/tmp` files are available in later calls in the same chat.
- `/tmp` persists across Bash calls in this chat and reloads from Convex if the warm backend runtime cache is gone. It is not shared with new chats and is not app file storage; use app file tools for durable user-visible files.
- Do not call `/tmp` ephemeral or temporary in a way that implies same-chat data loss. If a fresh chat cannot read a `/tmp` path created in another chat, that is expected evidence of per-chat isolation, not a global Bash failure.
- The bash internal action lives in `../../../packages/app/convex/bash.ts` as `internal.bash.run`; keep Convex action registration and validators there. The exported `bash_run_command` runner in `../../../packages/app/server/bash.ts` owns thread-state reads/writes, `/tmp` patch mutations, logging, action result shaping, and Just Bash filesystem/runtime construction. Keep `bash_fs_create`, `BashTmpFs`, `ReadOnlyBaseFs`, command factories, helpers, and in-source command tests private there. Shared path and db-files helpers live in `../../../packages/app/server/bash-utils.ts`; built-in delegation and native scratch behavior live in `../../../packages/app/server/bash-delegate.ts`. The `cat`, `cp`, `find`, `grep`, `head`/`tail`/`wc`, `ls`, `meta`, `mv`, nested-shell, `rm`, `search`, `sed`, `stat`, `tee`, `textgrep`, `touch`, `tree`, `which`, and `xargs` commands live in their matching `bash-*-command.ts` modules. Keep thread-state queries/mutations in default-runtime `ai_chat.ts`.
- Extracted Bash command modules should preserve the original monolithic function signatures, use no command-region markers, and avoid factory dependency bags.
- `bash` persists the current working directory through the general `ai_chat.get_thread_state` / `ai_chat.set_thread_state` internal functions. The state doc is stored in `ai_chat_threads_state`, linked from `ai_chat_threads.stateId` and back to `ai_chat_threads_state.threadId`. Thread creation still inserts the legacy `~` marker, but the bash action expands that initial/default marker to the current workspace path `/home/cloud-usr/w/{organizationName}/{workspaceName}`. After `cd`, app paths persist as home-relative values such as `~/w/personal/home/docs`; an explicit home cwd persists as `/home/cloud-usr` so it is not confused with the default marker. Cwd does not live directly on `ai_chat_threads`.
- The prompt and tool description should tell the model that cwd persists across tool calls in the same chat and that it should use bare or relative commands instead of repeating `cd` when the previous Bash output already shows the desired cwd.
- The prompt and tool description should describe `bash` as the normal shell for this environment, while explicitly warning that only app-mount files are db-backed and do not have full POSIX/GNU filesystem semantics.
- For file inspection commands without a specific path, cwd is the target. New bash sessions start at the current workspace path, so bare or relative commands inspect app files by default without a special command-level fallback.
- `/home/cloud-usr` is the bash home directory, `/home/cloud-usr/w` is the app mount, and `/home/cloud-usr/w/{organizationName}/{workspaceName}` is the current workspace path.
- Bash command behavior is performance-first because app files are a db-backed virtual filesystem, not POSIX files. Match native command shape where practical, but prefer db indexes, then Convex `.filter()` when an index cannot express the condition, and use JavaScript filtering/sorting only as a last resort with an explicit reason.
- When reporting Bash results, treat app-only flags such as `--limit`, `--cursor`, `--path-query`, and `--extension` as supported app Bash syntax. Do not warn that a successful app command is non-standard or replace it with native POSIX syntax.
- Printed `Next page:` commands use short cursor ids without an `@` prefix; run the exact printed command to continue. If the user asks for exactly one continuation, one continuation, or one next page, run only the first printed continuation and then stop even if that page prints another `Next page:` command. If the user asked for continuations from multiple commands, continue each requested command before summarizing.
- When a user names an app-root path like `/docs`, run it as `/home/cloud-usr/w/{organizationName}/{workspaceName}/docs` or `cd /home/cloud-usr/w/{organizationName}/{workspaceName}` and use `docs`. Do not treat `/docs` as a host-root path.
- If a failed Bash command prints a `Try:` command that directly matches the user's request, run that `Try:` command next instead of only reporting the failure.
- When using `bash -c` or `sh -c` to compare `/tmp` and app-mount behavior, use separate nested invocations in one outer Bash call so a blocked app redirect cannot hide earlier `/tmp` stdout.
- For `xargs` path checks, print pathnames into `xargs`, such as `printf '%s\n' <path> | xargs cat`. Do not pipe file content to `xargs` when the input is meant to be a pathname. When feeding many pathnames such as `find ... | xargs cat`, add `xargs -n 10` so each reader invocation stays within the 10-file per-command cap.
- `ls --limit` and `find --limit` are app-file pagination commands. Relative paths resolve against the current working directory.
- When listing the current directory, the prompt and tool description should prefer `ls --limit N` over `ls --limit N <current-cwd>` and should not tell the model to restate cwd as a path argument for certainty.
- Content-vs-path rule: use `search` for text inside files, and use `find` only for path/name discovery. Plain requests like "search for X with limit N" mean content search, so run `search --limit N X`. If the user says "search for the X file", "find the X file", "file named X", or "path/name contains X", use `find`. If the user says "search inside <folder> for X", "where does X appear", or "files mention X", run `search --path <folder> X` or `search X`; do not substitute `find --path-query`.
- For `search --path`, the app-root path rule still applies: pass `/home/cloud-usr/w/{organizationName}/{workspaceName}/folder` or relative `folder`, never raw `/folder`.
- For recursive grep requests over an app folder, the first Bash command should be `search --path <folder> <content terms>`; do not run `ls`, native `rg`, or multi-file `grep` first.
- Use `ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]` for app listings. Bare `ls --limit N` lists the current directory. Without `--cursor`, `ls` can mix app paths and `/tmp` scratch paths in one command. `--cursor` continues one listing target only. When asked to continue a listing, run the printed `Next page:` command as the next Bash call; do not just report that it exists, and do not invent `--next-page`.
- `ls -t` / `ls -rt` with no path list the whole workspace by update time. `ls -t <dir>` / `ls -rt <dir>` list that directory's immediate children by update time. After `cd <dir>`, use `ls -t --limit N .` for that folder's recent immediate children; bare `ls -t` is still workspace-wide. `ls -Rt <dir>` is unsupported.
- `ls -R` lists a paginated subtree as full app shell paths; when a tree-shaped view is needed, use `tree`, not `ls -R`; `ls -d` lists the target entry itself and wins over `-R`; `ls -l` uses app metadata, not POSIX permissions, owners, groups, inodes, blocks, symlinks, or real sizes. Unsupported sort/filter flags still fail.
- Use `find <path> [-maxdepth N] [-mindepth N] [-type f|d] [--limit N] [--cursor CURSOR]` for subtree discovery.
- Use `find --prefix <prefix> --limit N [--cursor CURSOR]` when a folder-boundary subtree scan is intended without first requiring the prefix to resolve to an existing folder. It uses the same `treePath` boundary as subtree mode, so sibling-prefix paths such as `/docs-archive` are excluded from `/docs`.
- Use `find -name QUERY` or `find --path-query QUERY` only for indexed app-file path/name word search; `find -name` is case-insensitive like `-iname`. Prefer `--path-query QUERY` for natural "path/name contains QUERY" requests; pass a plain token such as `readme`, not `*readme*`. For regex path requests against app files, say regex is unsupported and use token search when a plain token is obvious; do not summarize successful `--path-query` output as native glob/regex syntax. Use `find <dir> -maxdepth 1 -name QUERY` for indexed immediate-child app-file path search under one directory. Use `find <path> --extension md -type f` for exact indexed extension search. Simple `find -name '*.md'` and `find <dir>/*.md` are accepted as extension-search recovery, not general glob support. App `find` searches paths/names only, not file content. When asked for app files under a folder, include `-type f`; when asked for folders, include `-type d`. General glob/regex patterns and GNU find extensions are unsupported for app paths, but native `find` syntax can be used for `/tmp` paths.
- Use the custom `search [--limit N] [--cursor CURSOR] <content terms...>` command inside `bash` for full-text content search. Pass one distinctive word or a few plain terms that should appear in the document body; the text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. It is implemented with db full-text search, but it is not regex/glob/exact grep or path/name search. Do not pass app paths as positional operands, do not use it as a pipeline filter, and do not treat it as substring grep. If cwd is inside the app tree, bare `search` scopes to that cwd; use `search --path <folder> <content terms>` to choose another folder. Broad scopes with common terms can be heavier. For requests like "where does X appear" or "which files mention X", run `search` first; do not substitute `find`. For recursive grep, `grep -R`, or `rg` wording over an app folder, do not try native `rg` or multi-file `grep` first; run `search --path <folder> <content terms>` directly.
- Use the custom `meta search --where '<json>' [--format paths|json] [--path <folder>] [--limit N] [--cursor CURSOR]` command for indexed Markdown YAML frontmatter. The `where` JSON supports one positive predicate per command: `{"exists":"frontmatter.cc"}`, `{"eq":["frontmatter.from","alice@example.com"]}`, `{"prefix":["frontmatter.subject","Invoice"]}`, or `{"range":["frontmatter.amount",{"gte":100,"lt":500}]}`. Range bounds may also be ISO date strings such as `{"range":["frontmatter.realStartTime",{"gte":"2026-07-27","lt":"2026-08-02"}]}`; they match date-like string fields through their indexed `maybe_date` companion values, and one range must use all numbers or all ISO date strings. The bound type picks which indexed values are scanned, so a numeric field queried with date bounds (or the reverse) returns an empty result, not an error. Bounds must be a full `YYYY-MM-DD`; a date-only bound means midnight UTC, so prefer an exclusive upper bound (`lt` the next day) over `lte` on the same day. Fields must be qualified `frontmatter.*` names. Default output is one shell path per hit; `--format json` returns hit details and a short cursor id. Use shell tools to intersect or union path output across multiple `meta search` calls. `meta get <file> [--format text|json]` returns the indexed metadata visible to the acting user for one exact file; a date-like string field appears twice in text output, once as a plain string line and once as a line marked `(maybe_date)`. JSON output uses `valueKind` instead.
- If metadata field names are unclear, read nearby `README.md` files because folders may document their frontmatter conventions.
- `grep [-n] [-i] [-F] PATTERN <file>` scans one exact app file over Markdown chunks. Normal single-file `grep` uses regex matching; `-F` / `--fixed-strings` uses literal substring matching. It supports `-c`, `-l`, `-v`, and `-A`/`-B`/`-C N` context. Large-file grep is bounded; if stderr prints `Next scan: grep --start-line ...` or `Next scan: grep --start-index ...`, run that exact command to continue. Multiple-file and app-folder grep still use indexed text search only, because exact regex/substring scans are intentionally limited to one file for performance. For rendered plain-text chunk scans, use `textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>` for one app file, or `textgrep -R PATTERN <folder>` for a recursive folder scan via indexed full-text search (not exact recursive regex/fixed-string grep, like `grep -R`). Single-file `textgrep` uses regex by default; `-F`/`--fixed-strings` uses literal substring matching, `-v` inverts, `-c` counts, `-l` prints the path; it is plain-text-only and app-file-only. `textgrep -n` and context flags are rejected with a pointer to `grep`, and `textgrep -R -F` is rejected because recursive scans cannot do exact fixed-string matching. Simple `grep -R PATTERN <app-folder>` is recovered through indexed full-text search, but complex or multi-file grep forms are not exact recursive grep; prefer `search --path`.
- `tree [PATH] [--limit N] [--cursor CURSOR]` renders a paginated app tree page. Native pattern/depth/output flags are unsupported for app paths.
- `cat [-n] [--] [FILE...]`, `head`, `tail`, `wc`, and `stat` provide exact reads for app-file operands. They keep their native Just Bash behavior for supported non-app operands such as `/tmp` paths and devices; `cat`, `head`, `tail`, and `wc` also keep stdin behavior. `cat -- -file.md` treats `-file.md` as an operand, while `cat -- -` still reads stdin. `wc` supports `-l`, `-w`, `-c`, and `-m`; line/word/character counts may be lower bounds for large files. Large-file continuation and lower-bound notes from `cat`, `head`, `tail`, `sed`, and `wc` are stderr diagnostics, not file content. `cat` unreadable-source advisories are stderr and a nonzero exit; `head`, `tail`, and `wc` may still show readable-sibling advisories as command output.
- `sort`, `uniq`, `cut`, `sed`, `awk`, and the broader native-style scratch utilities are stream or `/tmp` processors for app work. Use `cat exact-app-file | sort` or similar pipelines; do not pass app files as direct operands to scratch/native utilities unless that command has an explicit app-aware implementation.
- Keep Bash commands simple: avoid strict-mode boilerplate such as `set -euo pipefail` because `pipefail` is unsupported, comments inside command strings, and process substitution. For multi-command inspection or eval checks, do not use `set -e` or hide stderr with `2>/dev/null`; later commands and visible stderr should still be observed.
- Only summarize actual Bash stdout/stderr. The blank line between the shell prompt and output is transcript formatting, not file content. If stdout is empty or a command failed, say that instead of inferring likely filesystem contents.
- In Agent mode, create or overwrite app files with shell redirects (`cat > file <<'EOF' ... EOF`, `>`), append with `>>`, and use `edit_file` for targeted edits. These shell writes, like Agent-mode app-to-app `mv`, `cp`, and `rm`, are reviewable pending proposals, not immediate committed filesystem mutations (accepting an `rm` archives the file instead of hard-deleting it, and the agent's own reads see a pending-deleted path as gone). Links are still not shell operations. App-to-`/tmp` copy remains immediate thread scratch. Do not work around an unsupported app operation by copying app files to `/tmp` unless the user asked for a scratch copy.
- Legacy `read_file`, `list_files`, `glob_files`, `grep_files`, and `write_file` no longer exist in code at all — not in the registry, not in `validationTools`, not under any "replaced tool names" list. `bash` and `edit_file` cover what they did. Their stored parts in old threads still render, because rendering reads the message, not the registry.
- When using the agent itself to create large QA corpora, keep prompts to small batches and verify actual app files after each batch. Assistant summary text can say a batch succeeded even when the model stopped before issuing every requested write.
- The agent does not currently read raw R2 binaries through this toolbelt.
- `read_file` and `grep_files` read Markdown-backed content through Convex actions that overlay pending edits and fetch committed Markdown from R2 when needed. Uploaded source paths do not alias to generated Markdown outputs.
- Uploaded source files are discoverable through path listing; their raw R2 binaries are not directly read by this toolbelt.
- `web_search` uses the server-side Exa integration and should be used for current public facts, docs, release notes, news, and information outside the app files. Keep file tools first when the answer should come from the user's files.
- `execute_code` runs an untrusted JavaScript snippet in an isolated Cloudflare Dynamic Worker (Worker Loader) hosted by the separate `bonobo-senate-code-execution-runner` Worker, reached over HTTP from the Convex action (`CODE_EXECUTION_RUNNER_URL` + `CODE_EXECUTION_RUNNER_SECRET` env). Use it for computation, JSON shaping, parsing, quick algorithmic work, gatewayed fetches, or file-aware calculations that are better expressed in code. The snippet body is `async (input) => { ... }`: it `return`s a JSON-serializable value and may `console.*`; `input` is an opaque optional JSON argument. The app tool creates a short-lived `public_api_grants` doc with explicit file read/list scopes and a nullable path prefix, then passes the token privately to the runner gateway; the snippet sees `fetch` and `process.env.T3_APP_ORIGIN`, not the raw grant token. To read app files, code should `POST` to `${process.env.T3_APP_ORIGIN}/api/v1/files/list` for discovery, `/api/v1/files/read-many` for folder-scale reads, and `/api/v1/files/read` for one-off reads; the runner gateway authorizes those app API requests. Do not pass app file paths or contents through `input`.
- User API credentials and public API grants both authorize through `public_api.ts`. Any signed-in active workspace member can create and manage their own reveal-once `pk_...` credentials, and there is no workspace-wide key administration, so no permission gates this. User credentials support `files:list`, `files:read`, `files:write`, and `files:download`, while public API grants remain read-only. The workspace `API keys` page creates fixed list/read keys, shows the full key only after create or rotate, lets the user test that revealed key through the real list route, and provides list/read examples. User API key reads return committed content only; public API grant reads keep the current user's pending overlay.

# Uploaded Source And Plugin-Generated Files

- Uploaded source files are visible `files_nodes` docs with an `assetId` pointing to the uploaded source R2 asset.
- The original uploaded binary is preserved in R2.
- R2 finalization handles Markdown MIME uploads in the host. Other terminal uploads dispatch `files.upload.completed` to eligible installed plugins.
- The first-party PDF plugin writes `<source-name>.md`; the image plugin writes `<source-name>.description.md`; the video plugin writes `<source-name>.summary.md` and `<source-name>.transcript.md`. These outputs exist only when the matching plugin is installed, enabled, and able to run with its required secrets.
- The plugins own provider calls, conversion details, output creation, and their failure behavior. Do not describe the removed host-owned image/video Workpool pipeline as a current Convex invariant.
- `files_r2_assets.processingWorkId` tracks the host upload/finalization job for the source. Plugin event-run progress is separate.
- Generated output files are regular visible app files. They can be opened, moved, archived, renamed, searched, and edited independently from the uploaded source file.
- The generated Markdown stores converted Markdown only; source/conversion metadata stays in db/R2 metadata, not visible frontmatter.
- Editing generated Markdown does not mutate the original R2 object.
- Agents should read generated outputs through their exact visible paths. For example, `/a.pdf.md` is the generated Markdown output for the uploaded source file `/a.pdf`.
- If a Bash unreadable-source advisory suggests generated output paths, read the exact generated output path when the user wants converted text; do not expect the uploaded source path to auto-read or alias to that sibling.
- For images and videos, read `/a.png.description.md`, `/clip.mp4.summary.md`, or `/clip.mp4.transcript.md`; do not treat `/a.png` or `/clip.mp4` as aliases for the generated files.
- Bash discovery commands expose generated outputs as ordinary files. Use exact Bash reads such as `cat /home/cloud-usr/w/{organizationName}/{workspaceName}/report.pdf.md` once generated output is finalized.
- In an old thread, a stored `read_file("/report.pdf")` part did not read generated Markdown; `read_file("/report.pdf.md")` was the path that did. The tool itself is gone — use a Bash read.
- Native source-file reading is planned for provider-supported files, especially PDFs. The agent should decide when Markdown search/results are enough and when to read the original source file with provider-native capabilities.
- Original binary access is exposed to authorized plugin runs through short-lived download URLs. Do not infer a user-facing download UI from that backend route.

# Tool Semantics

## `bash`

- Runs a curated Just Bash command surface against the current workspace path `/home/cloud-usr/w/{organizationName}/{workspaceName}` and the safe native-style scratch command surface against `/tmp`.
- Never exposes or runs against the host filesystem.
- Starts at the current workspace path `/home/cloud-usr/w/{organizationName}/{workspaceName}` for new chat threads.
- Presents `/home/cloud-usr/w/{organizationName}/{workspaceName}` as the shell path for app files.
- Does not alias `/` to app files; `/` only exposes normal mount-point directories such as `/home` and `/tmp`.
- `cat` reads app-file operands from materialized Markdown chunks and preserves the current user's pending-update overlay. It does not fall back to full-content reconstruction for unreadable or unmaterialized files; summarize stderr as an advisory or failure, not file content.
- Lists direct app children through `files_nodes.list_children`, and folder subtrees through `files_nodes.list_subtree` after exact targets are resolved with `files_nodes.get_by_path`.
- Agent-mode shell content writes (`>`, `>>`, heredoc redirects, `touch`, `tee`) create pending content proposals through `bash_DbFilesFs.writeFile`/`appendFile` in `server/bash-utils.ts`; a missing target is eagerly created empty and stamped `eagerCreated`. An existing target at the requested path is always written as-is; a missing target whose name normalization would silently change the path (README casing, leading dots, spaces) is refused with the normalized path in the error, while normalization that lands on an existing file overwrites that file. Ask mode rejects app writes; `sed -i` stays rejected in both modes. Agent-mode `mv`, `cp`, and `rm` use pending structural proposals instead of direct mutations; Ask mode rejects app `rm` too.
- Convert bash paths to app paths before calling `edit_file` by removing the current workspace path prefix `/home/cloud-usr/w/{organizationName}/{workspaceName}` while preserving the full remaining suffix. For example, `/home/cloud-usr/w/personal/home/folder/README.md` becomes `/folder/README.md`, never `/README.md`.
- Creates persistent folders only through `mkdir` under the app file tree in Agent-mode `bash`; Ask-mode `bash` rejects durable folder creation.
- Provides `/tmp` as writable durable scratch space scoped to the chat thread. `/tmp` persists across later `bash` calls in the same chat and reloads from Convex if the warm backend runtime cache is gone, but a new chat has a separate scratch filesystem. App-mount guards should not prevent `/tmp`-only commands from using native-style scratch utilities.
- Persists `cd` only when the final cwd is `~` or a directory below `/home/cloud-usr`. It does not persist `/tmp` or other paths outside the cloud user home.
- Includes a custom `search [--limit N] [--cursor CURSOR] <content terms...>` command backed by the `files_nodes.text_search_files` unified plain-text index query. It expects one distinctive word or a few plain terms from the document body, not paths, glob patterns, regexes, or exact grep syntax. Scoped `search --path` and app-cwd `search` use a db-side filter before pagination. The query searches `files_plain_text_chunks`, which materializes committed chunks and the acting user's pending chunks in one full-text index, then suppresses committed chunks for files that user has pending edits on. `files_search_chunks` no longer exists. Search uses Convex native cursor pagination; do not expect or construct the old pending/committed composite cursor. Avoid broad/common scoped searches when unscoped search or a more distinctive token is enough.
- Supports `grep [-n] [-i] [-F] PATTERN <file>` for one exact app file through a bounded Markdown chunk scan. Normal single-file `grep` uses regex; `-F` / `--fixed-strings` uses literal substring matching. Bounded grep continuations use `--start-line N --max-lines N` for normal line windows and `--start-index N --max-chars N` only for long-line text slices. Supports `textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>` for one app file's rendered plain text and `textgrep -R PATTERN <folder>` (indexed full-text search, like `grep -R`) for recursive folder scans. Simple `grep -R PATTERN <app-folder>` is recovered through indexed full-text search. Complex or multi-file grep forms print guidance to use indexed `search`.
- Includes native `ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]` and `find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] --limit N [--cursor CURSOR]` for bounded continuation through large file trees. Short cursor ids are app Bash syntax; continuation commands are printed in stdout.
- Shell pathname expansion is available for `/tmp` scratch paths. General app-file and mount glob operands are rejected because those trees are db-backed; use indexed commands such as `find <folder> --extension md -type f`. Only common simple find extension mistakes such as `*.md` are auto-fixed into indexed `--extension md` search; do not add or assume general app/mount glob or regex evaluation.
- TODO: if more common glob mistakes appear in live eval, auto-fix only those that can map to an indexed app-file query. Do not add JavaScript suffix filtering after pagination.
- Blocks app directory enumeration through the generic Just Bash filesystem APIs. Use native `ls`, `find`, or paginated `tree`; do not rely on Just Bash `readdir`, `getAllPaths`, or glob expansion for app files.

### Agent-only read-only external source mounts (`/.mounts`)

- Read-only mirrors of external sources (e.g. a synced public GitHub repo) are exposed to Bash under `/.mounts/<name>`, separate from the user's app file tree. They are backend-only agent context, not user-visible app files. `bash_EXTERNAL_MOUNTS_ROOT` (`/.mounts`, in `server/bash-utils.ts`) is the single source of truth for the prefix; the mount roots are agent-shell concepts, so they live in the server bash layer, not `shared/`. `bash-utils.ts` keeps its just-bash imports type-only so isolate-runtime code (ai_chat.ts via server-ai-tools.ts) can import it; just-bash VALUE imports (`Bash`, `getCommandNames`) live only in `server/bash-delegate.ts`.
- All materialized mounts share ONE reserved scope (`organizations_GLOBAL_ORGANIZATION_ID` / `organizations_GLOBAL_GITHUB_WORKSPACE_ID`). Storage is commit-keyed and immutable: each sync ingests a fresh root `/<name>/<commitSha>/<rel>` (no `.mounts` segment) while the previous root keeps serving reads, finalize flips the `github_mounts.lastCommitSha` pointer, and orphan roots are collected by `gc_sweep_mount_roots` after a delay. `/.mounts` is only the bash-visible mount point; the commit sha never appears in shell paths.
- Reserved docs are identified by the global organization. The reserved workspace ids (`organizations_GLOBAL_GITHUB_WORKSPACE_ID` for GitHub mirrors, `organizations_GLOBAL_PLUGINS_WORKSPACE_ID` for plugin sources; `organizations_is_reserved_workspace_id` covers both) and `users_SYSTEM_AUTHOR` are valid only inside `organizations_GLOBAL_ORGANIZATION_ID`; do not use a reserved workspace id or SYSTEM author with a real tenant organization. If future mounts need organization/workspace-level ownership, store them in the normal tenant organization/workspace path instead of adding another virtual workspace sentinel.
- Visibility is gated per bash run: `bash_run_command` fetches the raw mount docs via `internal.github_mounts.list_mounts` (name-ordered by index; no bash knowledge in `github_mounts.ts`), and `bash_fs_create` mounts only docs with a non-null `lastCommitSha`, creating one `bash_DbFilesFs` per mount with `dbFilesPathPrefix: "/<name>/<commitSha>"`, mounted at `/.mounts/<name>` — the same shape as plugin mounts. The sha is pinned for the whole run, so a pointer flip mid-run never tears reads; an in-progress or failed first sync exposes nothing. `/.mounts` itself does not exist with zero synced mounts, and `/.mounts/<unknown>` resolves to plain ENOENT (no existence leak). `bash_resolve_db_files_shell_path` in `bash-utils.ts` maps each shell path against the available `bash_DbFilesRoots` (`app`, per-mount `externalMounts`, and per-plugin `plugins` mounts) to a `bash_DbFilesShellPathResolution` (`app | outside_db_files | external_mount | external_mounts_root | plugins_root`) and read commands branch on it.
- External mount content is committed-only: it has no Yjs snapshot/sequence docs, never creates `files_pending_updates`, and reads through committed chunks/assets only.
- Read commands (`ls`, `find`, `tree`, `cat`, `head`, `tail`, `wc`, `stat`, `sed`, `grep`, `textgrep`) work against mounts exactly like app files. Bare `ls /.mounts` lists the mounted names (synthesized from the mount table, no Convex call). Root-scope `search`, `tree`, and `find` at `/.mounts` fan out across every mount in name order via `bash_external_mounts_fan_out_paginate` with a composite cursor pinning the `[name, commitSha]` listing snapshot — a resync between pages fails the continuation with "listing changed; rerun without --cursor". `meta search` and `find --prefix` still require a single-mount scope.
- Agent-only external mounts are strictly read-only. Shell redirects, `touch`, `rm`, `mv`, `tee`, and `cp` into `/.mounts` are rejected with `bash_read_only_mount_error`; `cp /.mounts/<name>/<file> /tmp/<name>` (copy OUT to scratch) is allowed. Mount files cannot be loaded as shell code through `bash`, `sh`, `source`, `.`, nested `bash`/`sh -c` command reads, or `xargs source`/`xargs .`. The same shell-code rule covers app files. Explicit `/tmp` script files and command reads remain available. `edit_file` rejects `/.mounts` paths.
- Agent-only external mounts never appear in the Files sidebar or public file API. They are a Bash-only read surface; `execute_code` reads files through tenant-scoped `/api/v1/files/*` grants and cannot list/read `GLOBAL`/`GITHUB` mount docs.

### Workspace-gated plugin source mounts (`/.plugins`)

- Read-only sources of plugins installed in the current workspace are exposed to Bash under `/.plugins/<pluginName>`. `bash_PLUGINS_MOUNT_ROOT` (`/.plugins`, in `server/bash-utils.ts`) is the prefix source of truth; per-family checks use `bash_is_path_under(bash_PLUGINS_MOUNT_ROOT, path)`, and `bash_is_path_under_read_only_mounts` covers `/.mounts` and `/.plugins` together for write/exec guards.
- Storage is version-keyed and shared: `register_plugin_version` writes each version's source tree once to the reserved `GLOBAL`/`PLUGINS` scope under the opaque root `/<pluginVersionId>/...` (bookkeeping lives on `plugins_versions.source*`: `sourceStatus`, `sourceFileCount`, `sourceTotalBytes`, `sourceLastError`). There is no per-workspace copy and no `plugins_source_mounts` table anymore.
- Visibility is gated per workspace by enabled `plugins_workspace_installations` rows: `bash_run_command` calls `internal.plugins.list_bash_source_mounts` (backed by the `by_organization_workspace_status_pluginName` index) and creates one `bash_DbFilesFs` per installed plugin with `dbFilesPathPrefix: "/<pluginVersionId>"`, mounted at `/.plugins/<pluginName>`. The installation row acts as the symlink: upgrades retarget the version root atomically, uninstall removes visibility, and workspaces share one tree with zero copies.
- No installation → no existence: `/.plugins` itself does not exist when the workspace has zero enabled installations, and `/.plugins/<notInstalled>` resolves to plain ENOENT (no existence leak). Publishers get no special access; they must install the plugin to browse its source via the agent.
- Bare `ls /.plugins` lists installed plugin names (synthesized from the mount table, no Convex call). Inside one plugin, read commands (`ls`, `cat`, `head`, `tail`, `wc`, `stat`, `sed`, `grep`, `textgrep`, `search`, `meta search`, `tree`, `find`) work exactly like `/.mounts` through the translated `dbFilesPath`. Root-scope `search`, `tree`, and `find` at `/.plugins` fan out across every installed plugin in plugin-name order via `bash_plugins_fan_out_paginate` (`bash-utils.ts`): each plugin's version-keyed tree is paged sequentially with the existing single-scope queries, results are rewritten to `/.plugins/<pluginName>/...` paths, and the continuation carries a composite cursor pinning the `[pluginName, pluginVersionId]` listing snapshot — if installations change between pages the continuation fails with "listing changed; rerun without --cursor". `find` depth predicates are translated by -1 per plugin (plugin folders sit at depth 1 under `/.plugins`); `find --prefix /.plugins` and root-scope `meta search` still print guidance to scope to one plugin.
- Same read-only rules as `/.mounts`: all writes (shell redirects, `touch`, `rm`, `mv`, `tee`, `cp` destination, `edit_file`) are rejected, every supported direct or nested shell-code loader rejects plugin files, `cp /.plugins/<pluginName>/<file> /tmp/<name>` (copy OUT to scratch) is allowed, and `cd` into a plugin mount persists across turns. Plugin source is committed-only content with no pending-update overlay.
- Registry hard deletes sweep each version's `GLOBAL`/`PLUGINS` tree (`db_delete_plugin_source_tree_batch`) before deleting the version doc; `plugins.delete_plugin_source_tree_batch` drains one version's tree standalone.
- `execute_code` and the public file API cannot reach `/.plugins`: grants are tenant-scoped and never authorize reserved-scope docs.

## Legacy `read_file`

These tools are **deleted**. The sections below stay only so an old assistant message that still carries their parts can be read and rendered correctly. They cannot be called, and they are not in `validationTools` either. The app does not send them — `prepareSendMessagesRequest` posts `messagesToAppend`, at most the one new user message, never the transcript — but that is client behaviour, not a guarantee: the route validates whatever `body.messages` contains, so a client that ever posted a stored legacy tool part would get a `400`. Use Bash exact reads and discovery instead.

- Reads one Markdown file by absolute path and returns numbered lines.
- Path must be absolute and resolve to an app file.
- Uploaded source paths do not resolve to generated Markdown outputs; use the generated output file path directly.
- Output uses line numbers like `00001| ...`.
- Reads through `internal.files_nodes.get_file_last_available_markdown_content_by_path`, an internal action because committed Markdown may live in R2.
- That action overlays the passed `userId` user's pending `unstaged` branch if a pending update exists.
- Missing files may return sibling suggestions from the parent directory.

## Legacy `list_files`

- Lists descendant folders and files under an absolute root path.
- Uses `internal.files_nodes.list_files`.
- Supports `ignore`, `maxDepth`, and `limit`.
- Folder items are marked with a trailing `/` in tool output.
- Generated upload outputs are normal visible files and appear in list results by their actual paths.

## Legacy `glob_files`

- Finds file/folder paths by glob pattern.
- Uses `list_files` under the hood with include filtering.
- Returns paths sorted by newest `updatedAt` first.
- Follows `list_files`, so generated upload outputs appear by their actual paths.

## Legacy `grep_files`

- Regex search over file names plus committed/pending Markdown content. Committed content is fetched from R2 through the same read action used by `read_file`.
- Uses JavaScript `RegExp`.
- Searches only app files; folders are traversed for discovery but not read.
- Uploaded source paths are not Markdown-readable unless the source itself has editable Markdown state.
- Produces grouped line-oriented output similar to ripgrep.

## Legacy `write_file`

- Deleted, like the other legacy tools above. Agent-mode file creation/overwrite goes through `bash` shell writes with the same pending-proposal behavior. The rest of this section describes what its stored parts mean, not something that can run.
- Proposes full Markdown file content for review.
- Does not directly commit file content.
- Creates the file path if it does not exist; intermediate path segments become folders.
- Missing-file creation uses the internal server file path flow and starts from empty committed content; the proposed body lives in the pending update instead of inheriting the UI welcome document.
- Paths must be real Markdown paths ending in `.md`, for example `/readme.md` or `/docs/setup.md`.
- When converting a Bash path, preserve the full suffix after `/home/cloud-usr/w/{organizationName}/{workspaceName}`; do not collapse nested files to their basename.
- Stores the proposed result in `files_pending_updates` through `upsert_file_pending_update_internal_action`, which fetches the latest R2-backed base before the mutation writes.
- It was Markdown-path-oriented, so a stored part never targeted a converted upload source such as a PDF directly.

## `edit_file`

- Proposes targeted search-and-replace edits for review.
- Requires an existing app file.
- Uses the OpenCode-inspired replacer pipeline in `replace_once_or_all(...)`.
- Default behavior replaces one unique occurrence and fails if the match is missing or ambiguous.
- `replaceAll` is opt-in.
- Stores modified Markdown in `files_pending_updates`, not live file content.
- When converting a Bash path, preserve the full suffix after `/home/cloud-usr/w/{organizationName}/{workspaceName}`; do not collapse nested files to their basename.
- If the user copies text from `read_file`, they must not include line-number prefixes.
- Generated upload outputs are editable Markdown files; pending updates belong to the generated output app file.

## `execute_code`

- Runs an untrusted JavaScript snippet in an isolated Cloudflare Dynamic Worker. The Convex action creates a `public_api_grants` doc, then `POST`s `{ executionId, code, input?, network, app }` to `bonobo-senate-code-execution-runner` (`/internal/execute-code`) with `Authorization: Bearer <CODE_EXECUTION_RUNNER_SECRET>`; the factory is `ai_chat_tool_create_execute_code` in `../../../packages/app/server/server-ai-tools.ts`, and the host Worker lives in `../../../packages/code-execution-runner/src/index.ts`.
- The snippet is the body of `async (input) => { ... }`. It `return`s a JSON-serializable value (the tool reports `Result: <json>`) and may `console.log/info/warn/error` (captured, bounded to 100 lines / 16 KB). `input` is the optional JSON argument.
- Default isolation of the runner is still sealed when no app/network capability is supplied: `globalOutbound: null` means `fetch()`/`connect()` throw and no platform `env` is passed. The app chat tool normally supplies both gatewayed public HTTP and the app file capability, so snippets can do real fetch work and can call the app file APIs directly.
- The normal app chat path intentionally allows app file reads and public HTTPS fetches in the same snippet. Treat this as a powerful code-worker capability, not an exfiltration boundary; keep generated snippets scoped to the user's task.
- App file access is fetch-based. Use `${process.env.T3_APP_ORIGIN}/api/v1/files/list` with `{ path, recursive, kind, extension, cursor, limit }` to discover files, following `cursor` while `isDone` is false before aggregating a whole folder.
- Use `/api/v1/files/read-many` with `{ paths, maxBytes }` to batch-read Markdown content, and `/api/v1/files/read` with `{ path, maxBytes }` for one-off reads. Folder calculations should inspect `read-many` `errors` and `truncated`, then return compact aggregates rather than file contents so the runner result cap stays small.
- `execute_code` cannot access read-only mounts under `/.mounts` or `/.plugins`: those docs live in the reserved `GLOBAL`/`GITHUB` and `GLOBAL`/`PLUGINS` scopes, while public API grants are tenant-scoped to the current organization/workspace.
- The public file HTTP routes resolve either a user API credential or a private public API grant token through the public API verifier, enforce expiry/revocation, file scope, active membership, and optional grant path prefix, then call `internal.files_nodes.list_subtree` or `internal.files_nodes.get_file_last_available_markdown_content_by_path`; public API grant reads preserve the current user's pending `unstaged` branch overlay.
- The runner gateway allows HTTPS fetches through `ExecuteCodeHttpGateway`, blocks IP literals, single-label hostnames, localhost/internal-style hostnames, non-443 explicit ports, and blocked redirects, and caps request/response bytes, redirects, request count, and time. It forwards deliberate public API headers such as `Authorization` but strips cookies, host/proxy/forwarded/CF/security headers. For app public file routes, it injects the private execution grant token at the gateway; the token is not exposed in `process.env`. `CODE_EXECUTION_NETWORK_DISABLED=true` disables outbound fetch.
- Time bounds: async code is cut at an in-sandbox 5 s timeout (`status: "timed_out"`); a synchronous infinite loop cannot be preempted by either JS timer and runs until workerd's platform CPU limit (~30 s) kills the isolate, which is also reported as `timed_out`. A parent-side 7 s backstop covers a stalled RPC. There is no per-snippet `cpuMs` cap because the Worker Loader API has no `limits` field.
- Outcomes map to `status: "succeeded" | "errored" | "timed_out"`. Caps: `code` ≤ 20 KB, direct `input` ≤ 32 KB at the app tool boundary, runner input ≤ 64 KB, per-fetch request/response bytes are capped, and result ≤ 16 KB (truncated past that). Operational logs carry only metadata (executionId, codeHash, byte sizes, hashed outbound host metadata), never raw code/input/result/logs, file contents, tokens, or raw hostnames.
- Available in both Agent and Ask modes (it does not mutate app state). If `CODE_EXECUTION_RUNNER_URL`/`_SECRET` are unset, the tool reports that code execution is unavailable; a `CODE_EXECUTION_DISABLED` kill switch on the Worker returns "disabled".

## Public Files API

- Credential management and public file reads live in `../../../packages/app/convex/public_api.ts`. Credentials are reveal-once, stored as `sha256(secret)` plus an obfuscated display value, and scoped to one organization/workspace/user membership.
- The public file routes accept either a `Bearer pk_...` credential or a gateway-injected public API grant token. They check active membership through the shared verifier, enforce explicit file scopes, rate-limit both pre-auth and per principal, log route use, and update `api_credentials.lastUsedAt` for user API keys. Active signed-in members can create, list, rotate, and revoke only their own keys in the current workspace. Keys are limited to 20 active keys per user/workspace, names are required and limited to 80 characters, and member removal permanently revokes keys for the organization.
- The file HTTP route family is `/api/v1/files/list`, `/api/v1/files/read`, `/api/v1/files/read-many`, `/api/v1/files/write`, `/api/v1/files/touch`, and `/api/v1/files/download-urls`. `write` and `touch` commit Markdown; they are not general binary upload. Do not add `/api/code-execution/*` compatibility aliases.
- Public file routes are scoped to real tenant organization/workspace ids. They do not authorize reserved `GLOBAL`/`GITHUB` or `GLOBAL`/`PLUGINS` docs, even when the requested path looks like `/.mounts/<name>`, `/.plugins/<pluginName>`, or a stored reserved-scope path.

# Pending Update Integration

Reads:

- `read_file` goes through `get_file_last_available_markdown_content_by_path`.
- That action resolves visible app paths through the current user's pending structural overlay before reading content. Pending destinations are visible, vacated or replaced paths are hidden, and descendants follow a pending folder move.
- After path resolution, it checks `files_pending_updates` for `(organizationId, workspaceId, userId, fileNodeId)` and overlays the current pending `unstaged` branch when content exists.
- If a pending update doc exists, it reconstructs Markdown from the pending `unstaged` branch and returns that instead of committed Markdown.
- Bash exact readers (`cat`, `head`, `tail`, `wc`, `grep`, and pipelines fed by `cat`) use the same pending-aware read path, with chunk/R2 fallbacks only when no pending update doc exists.
- Read-only mounts (`/.mounts` and `/.plugins`) skip pending-update lookups entirely because reserved-scope files are not editable and never have pending docs.
- Bash and legacy list/read/search/meta/tree/find surfaces use the same current-user structural path overlay. Other users continue to see the committed tree.
- Bash `search` queries the unified `files_plain_text_chunks` full-text search docs. Pending docs are user-scoped inside that table, other users' pending chunks are filtered out, and stale committed chunk hits are hidden only for files the acting user has pending edits on. Exact Markdown reads and regex scans use unified `files_markdown_chunks`; the old separate search and pending chunk tables no longer exist.
- Bash `meta search` queries unified `files_metadata_docs` with the same current-user pending overlay rule as Bash `search`: other users' pending metadata is invisible, and stale committed metadata is hidden for files the acting user has pending edits on.

Writes:

- Agent-mode bash shell writes (`bash_DbFilesFs.writeFile`/`appendFile`) and `edit_file` call action-aware pending-update helpers so the latest R2-backed base Yjs state is resolved before internal mutations write docs.
- They update the current user's pending `unstaged` branch.
- Agent-mode app-to-app `mv` stores `pendingMove`. App-to-app `cp` stores `copiedFrom` and may mark a newly created destination as `eagerCreated` so discard or expiry can remove it safely. A replacement proposal records the replaced destination instead of committing over it immediately. `cp -n` and `cp --no-clobber` leave an existing final destination unchanged and create no replacement proposal, including when the destination appears during eager creation. Bash shell writes to a missing path also eagerly create the node and stamp `eagerCreated`.
- The client is expected to open the diff/review UI before live file content changes.

# Current Invariants

1. The agent operates on db-backed app files, not repo files.
2. Folder nodes are not content-readable or content-writable by AI file tools.
3. File reads are user-scoped because pending overlays are user-scoped.
4. `bash` can read, list, navigate, and search app files. In Agent mode it can create folders, write file content as pending proposals (redirects, `tee`, and `touch` on a new path; `touch` on an existing app file is a no-op), and propose app-to-app moves, copies, and deletes (accepting a delete archives the node); links still fail.
5. `mkdir`, nested bash write paths, and pending copy destinations may create persistent intermediate folders. Do not claim `mkdir` is the only AI path that creates folders.
6. Bash shell writes, `edit_file`, app-to-app `mv`, and app-to-app `cp` create pending review state rather than immediately committing the proposed content or structure.
7. Bash shell writes pass the already-resolved `userId` into `create_file_by_path`; pending-update docs store the same id.
8. Use Bash `search` for full-text content search, Bash `meta search` for indexed frontmatter metadata, and Bash `find` for path discovery; `grep_files` / `glob_files` no longer exist.
9. Line-numbered `read_file` output in an old thread is not valid `edit_file.oldString` input — the prefixes are not part of the file.
10. Request messages are persisted before generation; assistant responses are persisted after streaming finishes. `thread_messages_add` is idempotent by thread and client-generated message id so finish/abort/retry overlap cannot create duplicate sibling messages.
11. Current chat file tools do not read raw uploaded R2 binaries; plugin-generated Markdown outputs are ordinary Markdown files whose committed Markdown is also stored in R2.
12. Source-path reads must preserve the product distinction between the original R2 object and generated editable Markdown outputs.
13. Generated upload outputs are regular visible files; tools should not apply hidden-file or path-alias behavior.
14. Client-side failed-send feedback is not persisted; retry keeps the existing failed user message as the final chat message and resubmits it in place from that message's original persisted parent.
15. Persisted chat-selection storage must not restore `ai_thread-*` ids as real thread ids. Rehydrate them as optimistic sessions, drop them, or replace them with the persisted Convex thread id matched by `clientGeneratedId`.
16. Server-side AI tool calls stream and persist through `/api/chat`; the client must not use AI SDK `sendAutomaticallyWhen` to resubmit completed server-side tool messages.
17. Message image attachments are `FileUIPart`s with allowlisted media types and base64 data URLs. The chat route rejects any other file-part shape with a 400, and the public `thread_messages_add` mutation enforces the same contract, because stored file parts are forwarded to the model provider on later turns and a remote URL must never reach it.
18. The chat route decodes image data URLs into bytes after `convertToModelMessages`. Without that, the AI SDK's download step tries to fetch the data URL and Convex `fetch` rejects it.

# Verification Checklist

- New threads still dedupe optimistic entries correctly.
- User messages persist even if generation is aborted mid-stream.
- Assistant responses persist under the correct parent message.
- Duplicate persistence attempts with the same client-generated message id return the existing message id and do not create branch siblings.
- Completed server-side tool messages do not trigger an automatic client resubmit.
- Four or more queued followers drain in their current execution order with one active request at a time. Cover both timing orders: request settlement before Convex persistence, and Convex persistence before request settlement.
- A 429 with a valid `retryAfterMs` retries the same request and message id before the queue advances. Stop aborts the wait. A malformed 429 follows the normal request-failure path.
- A request failure keeps the failed user visible with normal Retry feedback and pauses all later queued messages, whether the failed user is still client-only or was persisted before the assistant stream failed. Resume and Retry must retry the failed turn before later messages can drain.
- Stop keeps unstarted queued messages paused after the active request settles. Resume starts one follower from the persisted parent, including when Stop left an empty client-only assistant.
- After Stop settles, a normal composer submission starts directly while older queued messages stay paused. Its response must finish before Resume can start the older queue, and an error-paused queue must keep using Queue instead.
- Queued-message editing preserves the item id and order and preserves the normal draft. Earlier items keep draining, but the edited item waits when it reaches the front. Save updates the item without sending by itself, but it can unblock the normal drain. Cover a full numbered sequence where the final item stays edited while every earlier item runs.
- Reordering changes the later request order while keeping one active request. Cover full, paused, missing-id, claim-race, and active-drag barrier cases.
- An optimistic-to-persisted thread move transfers each queued message once, even when more than one chat surface is mounted.
- `execute_code` can list and read app files by fetching `/api/v1/files/list` and `/api/v1/files/read-many` from inside the snippet, so folder calculations such as summing `/payments/*.md` happen in code without passing paths or file contents through `input`.
- `bash` can run `pwd`, `ls /home/cloud-usr/w/{organizationName}/{workspaceName}`, `cat /home/cloud-usr/w/{organizationName}/{workspaceName}/<path>`, `search --limit N <content terms>`, and preserves cwd across turns.
- `/tmp` is durable per-thread scratch. It persists across later `bash` calls in the same chat, reloads from Convex after warm runtime cache loss, and is not app file storage.
- Agent-mode `bash` file writes under the app file tree create pending proposals; Ask-mode writes and mount writes fail with clear errors.
- Agent mode can create folders with `bash` `mkdir`, write files with shell redirects/`tee` (and `touch` for new empty files only), propose app-to-app moves and copies with `mv` and `cp`, and call `edit_file`; Ask mode can call `bash` for reads/searches but rejects durable app mutations and does not expose `edit_file`.
- Bash exact reads, Bash discovery/search surfaces, and legacy file tools see the current user's structural path overlay and pending unstaged content when present.
- Bash shell writes, `edit_file`, app-to-app `mv`, and app-to-app `cp` create reviewable pending state instead of silently committing live changes.
- Accept and discard checks cover pending moves, copies, replacements, eager-created destinations, and mixed content-plus-structure rows.
- `edit_file` fails on missing/ambiguous single-match replacements.
- Stored `grep_files` parts in old threads show regex/line search output.
- Uploaded source files are not described as raw-binary-readable until a native source-file tool exists.
- With the matching upload plugin installed and enabled, generated outputs are read, searched, edited, and listed by their actual visible paths, preferably through Bash (including shell writes) plus `edit_file`.
- Pasting, dropping, or picking an image through the configurations-row plus button shows a removable chip; non-image files show a toast and attach nothing. Removing the chip disables an image-only send again. With no attachments the chip bar is absent; the first attach grows the composer by one chip row, the last removal shrinks it back, and extra chips scroll sideways without changing heights. Arrow keys move between chip remove buttons in one tab stop, and a keyboard removal keeps focus on a neighbor chip (or the editor when none is left). Editing a one-line message shows no overlap between the editor text and the configurations row, and editing with attachments grows the edit bubble to fit the bar.
- A sent image renders in the transcript, survives a reload from Convex, and the model can describe it. Image-only sends work, and a queued message drains with its images.
- A crafted `/api/chat` body with a remote file URL, a non-allowlisted media type, or more file parts than the cap returns 400 `Invalid image attachments`; a direct `thread_messages_add` call with the same shapes returns `_nay`.
- Tool descriptions stay aligned with actual behavior.

# TODO / Hardening Backlog

Defensive limits against pathologically large / long-line content. These are NOT about the
agent read path — that is already bounded (`bash` reads use a 64 KB scan window, a 30 KB
stdout cap, and per-line display truncation at `files_READ_MAX_LINE_CHARS = 8000` in
`convex/files_nodes.ts`). The gap below is about **storage and materialization cost** of
content written/typed into the workspace.

- [ ] **Cap total written-document size (the real gap).** Uploads are size-capped via
      `files_MAX_UPLOADS_BYTES` from `shared/files.ts`, but typed/written Markdown has no
      size limit. Add a content-agnostic per-document byte cap at the write choke points
      — bash shell writes / `edit_file` (`server/server-ai-tools.ts` → `create_file_by_path` /
      `action_create_markdown_node` / the edit pending-update path in `convex/files_nodes.ts`)
      and ideally the editor save/materialization — rejecting oversized content with a clear
      error (mirror the upload "File too large" path). This bounds a 10 MB single line and 10 MB
      across many lines equally, covers all write paths at one layer, and corrupts nothing.
- [ ] **(Optional) Cap chunk count at materialization** so a borderline-large doc degrades
      gracefully: index the first N chunks of `files_markdown_chunks` / `files_plain_text_chunks`
      and mark "content too large to fully index" instead of doing unbounded chunking work in
      `finalize_file_content_materialization` / `db_replace_file_chunks`.
- [ ] **(Optional, belt-and-suspenders) Editor-side soft guard:** warn on a "document too
      large" threshold in the rich editor. Note this only covers the editor path (the agent/API
      write paths bypass it), so it is a UX nicety, not the security boundary.

Rejected approach (do not implement): forcing a newline / hard-wrapping long lines during
Markdown conversion or materialization. It mutates user content (breaks code fences, long
URLs, base64, tables), diverges the editor's Yjs source of truth from the derived Markdown
that `bash`/`search` see, and does not reduce total stored size. Prefer a total-size cap over
any line-length enforcement at the storage layer.
