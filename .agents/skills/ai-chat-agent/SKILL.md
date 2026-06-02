---
name: ai-chat-agent
description: Practical guide for the current app chat agent implementation (AI SDK 5 + Convex + files tools). Use this when implementing or modifying the chat agent, its HTTP routes, thread persistence, tool behavior, files semantics, pending-update integration, or OpenCode-inspired edit/search flows.
---

# Source Of Truth Files

Primary:

- `../../../packages/app/convex/ai_chat.ts`
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

The files system is a DB-backed file/folder model scoped by workspace/project membership. Folders are tree nodes only. Markdown files have Yjs snapshots/updates, R2-backed committed Markdown assets, Markdown chunks, and plain-text chunks. Uploaded source files preserve the original binary in R2; generated Markdown outputs from upload processing are ordinary visible sibling files.

# Main Request Flow

For `POST /api/chat`:

1. Validate the request body, including allowlisted `model`, `mode`, and `trigger`, and require one of `threadId` or `clientGeneratedThreadId`.
2. Resolve the authenticated or anonymous app user and load the app `users` row.
3. Load the membership row, derive the agent configuration, and validate UI messages against the full tool registry.
4. Resolve the existing thread or keep the optimistic client thread id for a new thread.
5. Rate-limit and credit-gate the request before LLM work.
6. Create the thread if needed and persist incoming user messages before generation.
7. Convert stored UI messages to model messages.
8. Run `streamText(...)` with the current tools and `activeTools`.
9. Stream UI message chunks back through `createUIMessageStreamResponse(...)`.
10. Persist the assistant response in `onFinish`.
11. If the thread has no title yet, generate a short title and persist it.
12. Emit `ai_usage` billing events from captured token usage after successful generation.

Non-obvious runtime details:

- Ask mode keeps the full tool registry for UI-message validation, but removes `write_file` and `edit_file` from `activeTools`.
- User messages are persisted before generation so they survive aborts/stopped generations.
- Pre-stream send failures, such as rate-limit or credit-gate HTTP failures, remain transient client state in AI SDK `chat.error`; the UI shows inline feedback on the failed user message and retries by replacing that same client-only message from its original parent without appending a duplicate.
- Thread/file access is scoped by a `membershipId` row that determines the effective workspace/project scope.
- Auth falls back to an anonymous user identity when a signed-in identity is unavailable.
- The chat HTTP action resolves the current app `users` row once and passes `user._id` into AI file tools; file-tool internals should use that id instead of re-reading auth from Convex context.
- `bash` is presented as the normal shell interface for the app file tree mounted at `/home/cloud-usr/w/{workspaceName}/{projectName}`.
- Client-side thread selection is surface-owned through `AiChatController` in `../../../packages/app/src/hooks/ai-chat-controller.tsx`. Surfaces pass only their typed storage key: full-page chat uses `app_state::ai_chat_last_open::scope::<membershipId>`, while the file sidebar agent uses `app_state::file_editor_sidebar_agent_selected_tab::scope::<membershipId>` and the controller derives the matching open-tabs key internally. `AiChatController` is also the hook namespace for `useThreadList`, `useThreadRuntime`, and direct shared render-state selectors through `useStore`. Use `ai_chat_is_optimistic_thread` for thread objects. For stored ids, use a local `ai_thread-` prefix check whose dashed prefix satisfies `GeneratedIdPrefix`; `GeneratedIdPrefixKey` is the non-dashed key accepted by `generate_id`. The shared Zustand store keeps sessions, draft model/mode, message caches, running/error maps, and editing state, but does not own `selectedThreadId`.
- `ai_thread-*` ids are client-only optimistic thread ids. They are resumable only while their in-memory `ThreadSession.optimisticThread` exists; local-storage restore paths must ignore/drop stale `ai_thread-*` ids or upgrade them to the persisted Convex thread id before a send. A stale optimistic id sent as `threadId` causes `/api/chat` request validation failure; fresh optimistic sends must use `clientGeneratedThreadId`.

# Current Toolbelt

The main tool object currently contains:

- `bash`
- `read_file`
- `list_files`
- `glob_files`
- `grep_files`
- `write_file`
- `edit_file`
- `web_search`

Important limitation:

- These tools operate on DB-backed app files, not repo files on disk.
- `bash` is a Just Bash runtime over the DB-backed app file tree, not the host shell.
- `bash` mounts app files at `/home/cloud-usr/w/{workspaceName}/{projectName}`, blocks file writes there, allows Agent-mode folder creation through `mkdir`, and provides per-invocation scratch space at `/tmp`.
- The bash internal action and Just Bash filesystem implementation live in the Node-runtime `bash.run` module because Just Bash bundles Node built-ins. Keep thread-state queries/mutations in default-runtime `ai_chat.ts`.
- `bash` persists the current working directory through the general `ai_chat.get_thread_state` / `ai_chat.set_thread_state` internal functions. The state row is stored in `ai_chat_threads_state`, linked from `ai_chat_threads.stateId` and back to `ai_chat_threads_state.threadId`. Thread creation inserts the state row with `~` (`/home/cloud-usr`) and stores home-relative values such as `~/w/personal/home/docs` after `cd`; cwd does not live directly on `ai_chat_threads`.
- The prompt and tool description should describe `bash` as the ordinary file shell instead of maintaining a synonym table for user wording. File listing, scanning, searching, reading, and path lookup requests should run through `bash` directly without asking the user to confirm routine inspection.
- For file inspection commands without a specific path, the app file tree `/home/cloud-usr/w/{workspaceName}/{projectName}` is the default target.
- `/home/cloud-usr` is the bash home directory, and the app file tree is mounted at `/home/cloud-usr/w/{workspaceName}/{projectName}`.
- Use the custom `search --limit N <query>` command inside `bash` for indexed plain-text content search.
- `grep` exists inside `bash` only as a compatibility hint and tells the model to use `search`; it does not scan app files itself.
- When using the agent itself to create large QA corpora, keep prompts to small batches and verify actual file nodes after each batch. Assistant summary text can say a batch succeeded even when the model stopped before issuing every requested `write_file` call.
- The agent does not currently read raw R2 binaries through this toolbelt.
- `read_file` and `grep_files` read Markdown-backed content through Convex actions that overlay pending edits and fetch committed Markdown from R2 when needed. Uploaded source paths do not alias to generated Markdown outputs.
- Uploaded source file nodes are discoverable through path listing; their raw R2 binaries are not directly read by this toolbelt.
- `web_search` uses the server-side Exa integration and should be used for current public facts, docs, release notes, news, and information outside the workspace. Keep workspace file tools first when the answer should come from the user's files.

# Uploaded Source And Generated Files

- Uploaded source files are visible `files_nodes` rows with an `assetId` pointing to the uploaded source R2 asset.
- The original uploaded binary is preserved in R2.
- Successful PDF source-to-Markdown conversion creates a generated Markdown sibling file node such as `<source-name>.md`.
- Upload processing is tracked by `files_r2_assets.conversionWorkId`: `undefined` means the upload/output is not accepted into processing yet, a Workpool id means processing is accepted/in flight/retrying, and `null` means terminal. Deterministic converter non-success, such as Modal `413` or `422`, is terminal and leaves generated output placeholders as stored-file/status rows rather than editable Markdown.
- Generated output files are regular visible file nodes. They can be opened, moved, archived, renamed, searched, and edited independently from the uploaded source file.
- The generated Markdown stores converted Markdown only; source/conversion metadata stays in DB/R2 metadata, not visible frontmatter.
- Editing generated Markdown does not mutate the original R2 object.
- Agents should read generated outputs through their exact visible paths. For example, `/a.pdf.md` is the generated Markdown output for the uploaded source file `/a.pdf`.
- `list_files`, `glob_files`, and `grep_files` expose generated outputs as ordinary files.
- `read_file("/report.pdf")` does not read generated Markdown; `read_file("/report.pdf.md")` reads the generated output once finalized.
- Native source-file reading is planned for provider-supported files, especially PDFs. The agent should decide when Markdown search/results are enough and when to read the original source file with provider-native capabilities.
- Original binary download is planned for users but is not implemented today.

# Tool Semantics

## `bash`

- Runs Just Bash commands against the app file tree mounted at `/home/cloud-usr/w/{workspaceName}/{projectName}`.
- Never exposes or runs against the host filesystem.
- Starts in `~` (`/home/cloud-usr`) for new chat threads.
- Presents `/home/cloud-usr/w/{workspaceName}/{projectName}` as the shell path for app files.
- Does not alias `/` to app files; `/` only exposes normal mount-point directories such as `/home` and `/tmp`.
- Loads Markdown file content through `get_file_last_available_markdown_content_by_path`, preserving the current user's pending-update overlay.
- Lists app file paths through `files_nodes.list_files`.
- Treats file writes under the app file tree as read-only; persistent content changes must use `write_file` or `edit_file`.
- Convert bash paths to app paths before calling `write_file` or `edit_file` by removing the `/home/cloud-usr/w/{workspaceName}/{projectName}` prefix.
- Creates persistent folders only through `mkdir` under the app file tree in Agent-mode `bash`; Ask-mode `bash` rejects durable folder creation.
- Provides `/tmp` as writable scratch space for one tool invocation only. `/tmp` is reset on the next `bash` call.
- Persists `cd` only when the final cwd is `~` or a directory below `/home/cloud-usr`. It does not persist `/tmp` or other paths outside the cloud user home.
- Includes a custom `search [--limit N] <query...>` command backed by the `files_nodes.text_search_files` plain-text index query.
- Keeps `grep` as a lightweight compatibility command that prints guidance to use `search` so app file content search goes through the Convex text index.
- Uses an aggressively bounded synchronous path cache and capped directory reads for Just Bash traversal. Wide `ls`, `find`, `tree`, and glob expansion may miss paths past the cap; narrow the path for listing and use `search` when content-search completeness matters.

## `read_file`

- Reads one Markdown file by absolute path and returns numbered lines.
- Path must be absolute and resolve to a file node.
- Uploaded source paths do not resolve to generated Markdown outputs; use the generated output file path directly.
- Output uses line numbers like `00001| ...`.
- Reads through `internal.files_nodes.get_file_last_available_markdown_content_by_path`, an internal action because committed Markdown may live in R2.
- That action overlays the passed `userId` user's pending `unstaged` branch if a pending update exists.
- Missing files may return sibling suggestions from the parent directory.

## `list_files`

- Lists descendant folders and files under an absolute root path.
- Uses `internal.files_nodes.list_files`.
- Supports `ignore`, `maxDepth`, and `limit`.
- Folder items are marked with a trailing `/` in tool output.
- Generated upload outputs are normal visible files and appear in list results by their actual paths.

## `glob_files`

- Finds file/folder paths by glob pattern.
- Uses `list_files` under the hood with include filtering.
- Returns paths sorted by newest `updatedAt` first.
- Follows `list_files`, so generated upload outputs appear by their actual paths.

## `grep_files`

- Regex search over file names plus committed/pending Markdown content. Committed content is fetched from R2 through the same read action used by `read_file`.
- Uses JavaScript `RegExp`.
- Searches only file nodes; folder nodes are traversed for discovery but not read.
- Uploaded source paths are not Markdown-readable unless the source itself has editable Markdown state.
- Produces grouped line-oriented output similar to ripgrep.

## `write_file`

- Proposes full Markdown file content for review.
- Does not directly commit file content.
- Creates the file path if it does not exist; intermediate path segments become folders.
- Missing-file creation uses the internal server file path flow and starts from empty committed content; the proposed body lives in the pending update instead of inheriting the UI welcome document.
- Paths must be real Markdown paths ending in `.md`, for example `/readme.md` or `/docs/setup.md`.
- Stores the proposed result in `files_pending_updates` through `upsert_file_pending_update_internal_action`, which fetches the latest R2-backed base before the mutation writes.
- `write_file` remains Markdown-path-oriented and is not the normal way to target converted uploaded sources such as PDFs.

## `edit_file`

- Proposes targeted search-and-replace edits for review.
- Requires an existing file node.
- Uses the OpenCode-inspired replacer pipeline in `replace_once_or_all(...)`.
- Default behavior replaces one unique occurrence and fails if the match is missing or ambiguous.
- `replaceAll` is opt-in.
- Stores modified Markdown in `files_pending_updates`, not live file content.
- If the user copies text from `read_file`, they must not include line-number prefixes.
- Generated upload outputs are editable Markdown files; pending updates belong to the generated output file node.

# Pending Update Integration

Reads:

- `read_file` goes through `get_file_last_available_markdown_content_by_path`.
- That action resolves the exact Markdown file path and checks `files_pending_updates` for `(workspaceId, projectId, userId, nodeId)`.
- If a pending row exists, it reconstructs Markdown from the pending `unstaged` branch and returns that instead of committed Markdown.

Writes:

- `write_file` and `edit_file` call action-aware pending-update helpers so the latest R2-backed base Yjs state is resolved before internal mutations write rows.
- They update the current user's pending `unstaged` branch.
- The client is expected to open the diff/review UI before live file content changes.

# Current Invariants

1. The agent operates on DB-backed app files, not repo files.
2. Folder nodes are not content-readable or content-writable by AI file tools.
3. File reads are user-scoped because pending overlays are user-scoped.
4. `bash` can read, list, navigate, search app files, and create folders in Agent mode, but file writes under the app file tree fail by design.
5. `bash` `mkdir` under `/home/cloud-usr/w/{workspaceName}/{projectName}` is the only AI path that creates persistent folder nodes.
6. `write_file` and `edit_file` create pending review state, not direct committed writes.
7. `write_file` passes the already-resolved `userId` into `create_file_by_path`; pending-update rows store the same id.
8. `grep_files` is the precise regex tool; `glob_files` is the path-discovery tool.
9. `read_file` output is line-numbered and those prefixes are not valid `edit_file.oldString` input.
10. Request messages are persisted before generation; assistant responses are persisted after streaming finishes.
11. Current tools do not read raw uploaded R2 binaries; generated Markdown outputs from uploads are ordinary Markdown files whose committed Markdown is also stored in R2.
12. Source-path reads must preserve the product distinction between the original R2 object and generated editable Markdown outputs.
13. Generated upload outputs are regular visible files; tools should not apply hidden-file or path-alias behavior.
14. Client-side failed-send feedback is not persisted; retry keeps the existing failed user message as the final chat message and resubmits it in place from that message's original persisted parent.
15. Persisted chat-selection storage must not restore stale `ai_thread-*` ids as real thread ids. Either drop the unsent optimistic tab or replace it with the persisted Convex thread id matched by `clientGeneratedId`.

# Verification Checklist

- New threads still dedupe optimistic entries correctly.
- User messages persist even if generation is aborted mid-stream.
- Assistant responses persist under the correct parent message.
- `bash` can run `pwd`, `ls /home/cloud-usr/w/{workspaceName}/{projectName}`, `cat /home/cloud-usr/w/{workspaceName}/{projectName}/<path>`, `search --limit N <query>`, and preserves cwd across turns.
- `/tmp` works inside one `bash` call and resets before the next one.
- `bash` file writes under the app file tree fail with a read-only filesystem error.
- Agent mode can create folders with `bash` `mkdir /home/cloud-usr/w/{workspaceName}/{projectName}/<folder>` and can call `write_file` and `edit_file`; Ask mode can call `bash` for reads/searches but cannot create folders or call write tools.
- `read_file` sees the current user's pending unstaged branch when one exists.
- `write_file` and `edit_file` create pending review state instead of silently saving live content.
- `edit_file` fails on missing/ambiguous single-match replacements.
- `grep_files` behaves like regex/line search.
- Uploaded source files are not described as raw-binary-readable until a native source-file tool exists.
- Generated upload outputs are read, searched, edited, and listed by their actual visible paths.
- Tool descriptions stay aligned with actual behavior.
