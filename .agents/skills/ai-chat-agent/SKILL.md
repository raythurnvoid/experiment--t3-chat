---
name: ai-chat-agent
description: Practical guide for the current app chat agent implementation (AI SDK 5 + Convex + page tools). Use this when implementing or modifying the chat agent, its HTTP routes, thread persistence, tool behavior, page-tool semantics, pending-edit integration, or OpenCode-inspired edit/search flows.
---

# Source Of Truth Files

Primary:

- `../../../packages/app/convex/ai_chat.ts`
- `../../../packages/app/server/server-ai-tools.ts`
- `../../../packages/app/convex/ai_docs_temp.ts`
- `../../../packages/app/server/server-ai-tools.test.ts`
- `../pages-agent-pending-edits/SKILL.md`

Related:

- `../../../packages/app/convex/pages_pending_edits.ts`
- `../../../packages/app/server/pages-markdown-chunking-mastra.ts`
- `../../../references-submodules/opencode/packages/opencode/src/tool/edit.ts`

# Architecture Overview

The current agent is a Convex-backed AI chat runtime that streams AI SDK 5 UI messages, persists threads/messages in Convex, and exposes a small server-side toolbelt focused on pages.

- Main request path: `POST /api/chat`
- Secondary title path: `POST /api/v1/runs/stream` for `assistant_id = "system/thread_title"`
- Main runtime owner: `ai_chat_http_routes` in `../../../packages/app/convex/ai_chat.ts`
- Thread/message storage: Convex tables for `ai_chat_threads` and `ai_chat_threads_messages_aisdk_5`
- Tool implementation: `../../../packages/app/server/server-ai-tools.ts`
- Page data/query layer: `../../../packages/app/convex/ai_docs_temp.ts`

Current runtime details:

- Main model: `openai("gpt-5-nano")`
- Main system prompt is intentionally tiny: "Either respond directly to the user or use the tools at your disposal."
- Tool choice: `auto`
- Max tool/model steps per response: `stepCountIs(5)`
- Title model: `openai("gpt-4.1-nano")`
- Thread runtime field: `"aisdk_5"`

# Main Request Flow

For `POST /api/chat`:

1. Validate the request body and require one of `threadId` or `clientGeneratedThreadId`.
2. Create the thread if needed and store the optimistic client thread id on the persisted thread.
3. Resolve the effective parent message id for persistence.
4. Persist incoming user messages before generation.
5. Convert stored UI messages to model messages.
6. Run `streamText(...)` with the current tools.
7. Stream UI message chunks back through `createUIMessageStreamResponse(...)`.
8. Persist the assistant response in `onFinish`.
9. If the thread has no title yet, generate a short title and persist it.

Non-obvious runtime details:

- User messages are persisted before generation so they survive aborts/stopped generations.
- Assistant responses are persisted in `onFinish` under the resolved persisted parent message.
- New threads store the optimistic `clientGeneratedThreadId` so the frontend can dedupe before the SSE mapping arrives.
- Thread/page access is scoped by a `membershipId` row that determines the effective workspace/project scope.
- Auth falls back to an anonymous user identity when a signed-in identity is unavailable.

# Thread Access And Error Contract

For thread-scoped Convex functions in `../../../packages/app/convex/ai_chat.ts`, keep membership checks, arg order, and error strings aligned.

Use this pattern:

1. Put `membershipId` first in `args`.
2. Load `user`.
3. Load `membership` from `membershipId`.
4. If `membership` is missing, return `"Unauthorized"` (or `null` for nullable queries).
5. Normalize/load the requested thread/message resource.
6. If the resource id is invalid or the row is missing, return `"Not found"` (or `null` for nullable queries).
7. Compare `thread.workspaceId` / `thread.projectId` directly to the membership row.
8. If the workspace/project on the resource does not match the membership row, return `"Unauthorized"`.

Important details:

- Prefer direct `workspaceId` / `projectId` comparisons over a small helper for thread-scoped access checks.
- Keep `thread_*` mutation handlers on `v_result(...)` when they have recoverable access/not-found failures.
- Keep `thread_*` queries nullable when the current API already uses `null` for inaccessible or missing resources.
- When `POST /api/chat` calls a Result-returning thread mutation, bubble `_nay.message` to the HTTP response/logging path instead of throwing.
- Prefer inlining small `messages: [...]` / `.map(...)` payloads into `ctx.runMutation(...)` calls rather than introducing tiny temporary variables only to avoid repetition.

# Current Toolbelt

The main tool object currently contains:

- `weather`
- `read_page`
- `list_pages`
- `glob_pages`
- `grep_pages`
- `text_search_pages`
- `write_page`
- `edit_page`

Important limitation:

- These tools operate on DB-backed pages, not repo files on disk.
- The agent does not currently have a general shell/filesystem tool in this chat runtime.
- The `weather` tool is a stub/demo tool, not a real integration.

# Tool Semantics

## `read_page`

Purpose:

- Read one page by absolute path and return numbered lines.

Important behavior:

- Path must be absolute.
- Output uses line numbers like `00001| ...`.
- The tool reads through `get_page_last_available_markdown_content_by_path`.
- That query overlays the current user's pending `modified` branch if a pending edit exists.
- Missing pages may return sibling suggestions from the parent directory.

Consequence:

- Follow-up reads can see uncommitted pending edits for the current user.
- `read_page` is not a pure "committed markdown only" read.

## `list_pages`

Purpose:

- Render a tree of descendant page paths under an absolute root path.

Important behavior:

- Uses `internal.ai_docs_temp.list_pages`.
- Supports `ignore`, `maxDepth`, and `limit`.
- Renders directories only, with truncation markers for depth-limited branches.

## `glob_pages`

Purpose:

- Find page paths by name/pattern matching.

Important behavior:

- Uses `list_pages` under the hood with include filtering.
- Returns paths sorted by newest `updatedAt` first.
- Best for filename/path discovery, not text search.

## `grep_pages`

Purpose:

- Regex search over pages.

Important behavior:

- Searches `pageName + "\n" + content`, not just markdown body.
- Uses JavaScript `RegExp`.
- Produces grouped line-oriented output similar to ripgrep.
- Sorts grouped results by page update time, newest first.
- Traversal still depends on `list_pages` scoping, `maxDepth`, `include`, and `limit`.

## `text_search_pages`

Purpose:

- Fast search over page content using Convex's plain-text chunk index.

Important behavior:

- Search happens on markdown-derived plain text chunks, not raw markdown syntax.
- Returned snippets are markdown chunks with `lineStart` / `lineEnd`.
- The query first uses Convex full-text search over `pages_plain_text_chunks`.
- Current behavior then exact-filters candidate chunks with `plainTextChunk.includes(query)`.
- Current behavior dedupes by `markdownChunkId`.
- Result ordering still starts from Convex search candidates, but only exact chunk matches survive.

Consequence:

- This tool is now closer to exact chunk string matching than general fuzzy search.
- It can still miss matches that cross chunk boundaries.
- It returns chunk hits, not page-level deduped results.

## `write_page`

Purpose:

- Propose full-page content for review.

Important behavior:

- Does not directly commit page content.
- Creates a page if the path does not exist.
- Stores the proposed result in `pages_pending_edits` via `upsert_pages_pending_edit_updates`.
- Returns diff metadata for the client review UI.
- Prefers editing existing pages unless the user explicitly asks for a new page.
- Paths are extensionless by default unless the user explicitly provides an extension.

Consequence:

- "Write" in chat means "create/update pending review state", not "save live page immediately".

## `edit_page`

Purpose:

- Propose targeted search-and-replace edits for review.

Important behavior:

- Requires an existing page.
- Uses an OpenCode-inspired replacer pipeline in `replace_once_or_all(...)`.
- Default behavior replaces one unique occurrence and fails if the match is missing or ambiguous.
- `replaceAll` is opt-in.
- Stores the modified markdown in `pages_pending_edits`, not the live page.
- If the user copies text from `read_page`, they must not include line-number prefixes.

Current active replacer pipeline:

1. Exact literal match
2. Line-trimmed match
3. Block-anchor match
4. Whitespace-normalized match
5. Indentation-flexible match
6. Escape-normalized match

Important nuance:

- Some optional OpenCode-style replacers are intentionally disabled.
- Keep the current active pipeline unless there is a clear reason to change edit semantics.

# Pending Edit Integration

This is the most important non-obvious system behavior.

Reads:

- `read_page` goes through `get_page_last_available_markdown_content_by_path`.
- That query checks `pages_pending_edits` for `(workspaceId, projectId, userId, pageId)`.
- If a pending row exists, it reconstructs markdown from `modifiedBranchYjsUpdate` and returns that instead of committed markdown.

Writes:

- `write_page` and `edit_page` call `api.pages_pending_edits.upsert_pages_pending_edit_updates`.
- They update the current user's pending `modified` branch.
- The client is expected to open a diff/review UI before the live page changes.

If you are changing page-agent behavior, also read:

- `../pages-agent-pending-edits/SKILL.md`

# OpenCode Lineage

Many tool semantics intentionally mirror OpenCode.

Current OpenCode-inspired areas in `../../../packages/app/server/server-ai-tools.ts`:

- `read_page`
- `list_pages`
- `glob_pages`
- `grep_pages`
- `write_page`
- `edit_page`
- The edit replacer pipeline

Practical guidance:

- Preserve OpenCode-like expectations for `edit_page`: unique-match defaults, replace-all opt-in, human-review-first workflow.
- Preserve OpenCode-like expectations for read/list/glob/grep output formatting unless there is a product reason to change them.
- If you change semantics, update the tool description text and tests together.

# Current Invariants

1. The agent operates on DB pages, not repo files.
2. Page reads are user-scoped because pending overlays are user-scoped.
3. `write_page` and `edit_page` create pending review state, not direct committed writes.
4. `text_search_pages` is chunk-based and currently exact-filters candidate chunks by `includes(query)`.
5. `grep_pages` is the precise regex tool; `glob_pages` is the path-discovery tool.
6. `read_page` output is line-numbered and those prefixes are not valid `edit_page.oldString` input.
7. The tool set is intentionally small and page-centric.
8. Request messages are persisted before generation; assistant responses are persisted after streaming finishes.
9. New thread dedupe depends on persisting the optimistic client thread id.
10. Thread titles are generated lazily and can also be streamed from the secondary title endpoint.

# Change Playbooks

## Add a new tool

1. Implement the tool in `../../../packages/app/server/server-ai-tools.ts`.
2. Register it in the `tools` object in `../../../packages/app/convex/ai_chat.ts`.
3. Add or update tests in `../../../packages/app/server/server-ai-tools.test.ts`.
4. Update this skill if the new tool changes agent behavior in a non-obvious way.

## Change page read behavior

1. Re-check `get_page_last_available_markdown_content_by_path`.
2. Decide whether reads should still see the current user's pending overlay.
3. Update the pending-edits skill if that invariant changes.

## Change write/edit behavior

1. Preserve human-in-the-loop review unless the product intentionally changes that workflow.
2. Re-check pending-edit mutations and page-diff UI expectations.
3. Update both this skill and `../pages-agent-pending-edits/SKILL.md` if the workflow changes.

## Change search behavior

1. Decide whether the tool is path search, regex line search, or chunk/plain-text search.
2. Keep `grep_pages` and `text_search_pages` semantics clearly distinct.
3. Re-check chunk-level vs page-level dedupe and exact-match behavior.

# Verification Checklist

- New threads still dedupe optimistic entries correctly.
- User messages persist even if generation is aborted mid-stream.
- Assistant responses persist under the correct parent message.
- `read_page` still sees the current user's pending modified branch when one exists.
- `write_page` and `edit_page` still create pending review state instead of silently saving live content.
- `edit_page` still fails on missing/ambiguous single-match replacements.
- `grep_pages` still behaves like regex/line search.
- `text_search_pages` still behaves like chunk search and returns markdown fragment context.
- Tool descriptions stay aligned with actual behavior.
