---
name: ai-chat-agent
description: Practical guide for the current app chat agent implementation (AI SDK 5 + Convex + files tools). Use this when implementing or modifying the chat agent, its HTTP routes, thread persistence, tool behavior, files semantics, pending-update integration, or OpenCode-inspired edit/search flows.
---

# Source Of Truth Files

Primary:

- `../../../packages/app/convex/ai_chat.ts`
- `../../../packages/app/server/server-ai-tools.ts`
- `../../../packages/app/convex/files_nodes.ts`
- `../../../packages/app/convex/files_content.ts`
- `../../../packages/app/convex/r2.ts`
- `../../../packages/app/convex/files_pending_updates.ts`
- `../../../packages/app/server/files.ts`
- `../../../packages/app/server/files-markdown-chunking-mastra.ts`
- `../files-agent-pending-updates/SKILL.md`

# Architecture Overview

The current agent is a Convex-backed AI chat runtime that streams AI SDK 5 UI messages, persists threads/messages in Convex, and exposes a small server-side toolbelt focused on Markdown files in the project files.

- Main request path: `POST /api/chat`
- Secondary title path: `POST /api/v1/runs/stream` for `assistant_id = "system/thread_title"`
- Main runtime owner: `ai_chat_http_routes` in `../../../packages/app/convex/ai_chat.ts`
- Thread/message storage: Convex tables for `ai_chat_threads` and `ai_chat_threads_messages_aisdk_5`
- Tool implementation: `../../../packages/app/server/server-ai-tools.ts`
- Files node data/query layer: `../../../packages/app/convex/files_nodes.ts`
- Upload conversion/finalization: `../../../packages/app/convex/files_content.ts`
- R2 upload/event metadata: `../../../packages/app/convex/r2.ts`

The files system is a DB-backed file/folder model scoped by workspace/project membership. Folders are tree nodes only. Markdown files have Yjs snapshots/updates, Markdown content, Markdown chunks, and plain-text chunks. Uploaded source files preserve the original binary in R2 and currently become agent-readable through generated Markdown shadow files.

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
- Thread/file access is scoped by a `membershipId` row that determines the effective workspace/project scope.
- Auth falls back to an anonymous user identity when a signed-in identity is unavailable.
- The chat HTTP action resolves the current app `users` row once and passes `user._id` into AI file tools; file-tool internals should use that id instead of re-reading auth from Convex context.

# Current Toolbelt

The main tool object currently contains:

- `read_file`
- `list_files`
- `glob_files`
- `grep_files`
- `text_search_files`
- `write_file`
- `edit_file`
- `web_search`

Important limitation:

- These tools operate on DB-backed project files, not repo files on disk.
- The agent does not currently have a general shell/filesystem tool in this chat runtime.
- The agent does not currently read raw R2 binaries through this toolbelt.
- `read_file`, `write_file`, and `edit_file` require Markdown-backed file content.
- Uploaded source nodes may be discoverable through path listing, but are not directly readable unless the tool path resolves to Markdown content.
- `web_search` uses the server-side Exa integration and should be used for current public facts, docs, release notes, news, and information outside the workspace. Keep workspace file tools first when the answer should come from the user's files.

# Uploaded Source And Shadow Files

Current implementation:

- Uploaded source files are visible `files_nodes` rows with `uploadId` and later `assetId`.
- The original uploaded binary is preserved in R2.
- Finalization creates a generated Markdown **shadow file** linked from `files_r2_assets.shadowNodeId`.
- Shadow files are currently visible as `.shadow.md` Markdown files and can be opened/read like other Markdown-backed files.
- The generated shadow Markdown includes visible frontmatter/source metadata plus converted Markdown.
- Shadow Markdown is editable and participates in normal Markdown reads, searches, edits, and pending-update review flows.
- Editing shadow Markdown does not mutate the original R2 object.
- The DB upload/asset/source/shadow relationship is authoritative; visible frontmatter is contextual/editable content.
- `list_files` and `glob_files` may show uploaded source paths because they list file nodes. `read_file`, `grep_files`, `write_file`, and `edit_file` only succeed when the resolved node has Markdown content.

Committed product direction:

- Agents should address converted uploaded files by the source path, not the internal `.shadow.md` path.
- Future read/search/edit behavior on a converted source path should alias to the editable shadow Markdown.
- Search results for converted uploads should show the source path while using the shadow Markdown as the searchable representation.
- Normal tree/list/glob APIs should hide shadow files by default once hidden-shadow behavior is implemented.
- Native source-file reading is planned for provider-supported files, especially PDFs. The agent should decide when Markdown search/results are enough and when to read the original source file with provider-native capabilities.
- Original binary download is planned for users but is not implemented today.

# Tool Semantics

## `read_file`

- Reads one Markdown file by absolute path and returns numbered lines.
- Path must be absolute and resolve to a file node.
- Current behavior requires the resolved node to have `markdownContentId`; uploaded source paths do not yet alias to their shadows.
- Output uses line numbers like `00001| ...`.
- Reads through `internal.files_nodes.get_file_last_available_markdown_content_by_path`.
- That query overlays the passed `userId` user's pending `unstaged` branch if a pending update exists.
- Missing files may return sibling suggestions from the parent directory.

## `list_files`

- Lists descendant folders and files under an absolute root path.
- Uses `internal.files_nodes.list_files`.
- Supports `ignore`, `maxDepth`, and `limit`.
- Folder items are marked with a trailing `/` in tool output.
- Current behavior can list uploaded source nodes and visible shadow files. Future hidden-shadow behavior should omit shadow files and expose source paths.

## `glob_files`

- Finds file/folder paths by glob pattern.
- Uses `list_files` under the hood with include filtering.
- Returns paths sorted by newest `updatedAt` first.
- Current behavior follows `list_files`, so visible `.shadow.md` paths can appear until hidden-shadow behavior is implemented.

## `grep_files`

- Regex search over file names plus committed/pending Markdown content.
- Uses JavaScript `RegExp`.
- Searches only file nodes; folder nodes are traversed for discovery but not read.
- Current behavior reads Markdown-backed paths only. Uploaded source paths are not searched directly until source-path aliasing is implemented.
- Produces grouped line-oriented output similar to ripgrep.

## `text_search_files`

- Fast search over file content using Convex's plain-text chunk index.
- Search happens on markdown-derived plain text chunks, not raw markdown syntax.
- Returned snippets are markdown chunks with line ranges and source character ranges.
- Current behavior exact-filters candidate chunks with `plainTextChunk.includes(query)` and dedupes by markdown chunk id.
- Current uploaded-file search comes from shadow Markdown chunks. Future results should report the uploaded source path, not the hidden shadow path.

## `write_file`

- Proposes full Markdown file content for review.
- Does not directly commit file content.
- Creates the file path if it does not exist; intermediate path segments become folders.
- Paths must be real Markdown paths ending in `.md`, for example `/readme.md` or `/docs/setup.md`.
- Stores the proposed result in `files_pending_updates` through `upsert_file_pending_update_internal`.
- Current behavior writes Markdown files only. Future source-path aliasing may allow writes to a converted uploaded source path by editing its shadow Markdown.

## `edit_file`

- Proposes targeted search-and-replace edits for review.
- Requires an existing file node.
- Uses the OpenCode-inspired replacer pipeline in `replace_once_or_all(...)`.
- Default behavior replaces one unique occurrence and fails if the match is missing or ambiguous.
- `replaceAll` is opt-in.
- Stores modified Markdown in `files_pending_updates`, not live file content.
- If the user copies text from `read_file`, they must not include line-number prefixes.
- Current behavior edits Markdown-backed files only. Future source-path aliasing may edit a converted upload's shadow Markdown when the agent targets the source path.

# Pending Update Integration

Reads:

- `read_file` goes through `get_file_last_available_markdown_content_by_path`.
- That query checks `files_pending_updates` for `(workspaceId, projectId, userId, nodeId)`.
- If a pending row exists, it reconstructs Markdown from the pending `unstaged` branch and returns that instead of committed Markdown.

Writes:

- `write_file` and `edit_file` call internal mutations in `files_pending_updates`.
- They update the current user's pending `unstaged` branch.
- The client is expected to open the diff/review UI before live file content changes.

# Current Invariants

1. The agent operates on DB-backed project files, not repo files.
2. Folder nodes are not readable/writable by AI file tools.
3. File reads are user-scoped because pending overlays are user-scoped.
4. `write_file` and `edit_file` create pending review state, not direct committed writes.
5. `write_file` passes the already-resolved `userId` into `create_file_by_path`; pending-update rows store the same id.
6. `text_search_files` is chunk-based and exact-filters candidate chunks by `includes(query)`.
7. `grep_files` is the precise regex tool; `glob_files` is the path-discovery tool.
8. `read_file` output is line-numbered and those prefixes are not valid `edit_file.oldString` input.
9. Request messages are persisted before generation; assistant responses are persisted after streaming finishes.
10. Current tools do not read raw R2 binaries; uploaded content is available through Markdown shadow files.
11. Future source-path aliasing must preserve the product distinction between the original R2 object and the editable Markdown representation.
12. `.shadow.md` is a system-reserved implementation suffix; normal agent-facing paths should move toward source paths once shadows are hidden.

# Verification Checklist

- New threads still dedupe optimistic entries correctly.
- User messages persist even if generation is aborted mid-stream.
- Assistant responses persist under the correct parent message.
- `read_file` sees the current user's pending unstaged branch when one exists.
- `write_file` and `edit_file` create pending review state instead of silently saving live content.
- `edit_file` fails on missing/ambiguous single-match replacements.
- `grep_files` behaves like regex/line search.
- `text_search_files` behaves like chunk search and returns markdown fragment context.
- Uploaded source files are not described as raw-binary-readable until a native source-file tool exists.
- Source/shadow current behavior and planned alias behavior remain documented separately.
- Tool descriptions stay aligned with actual behavior.
