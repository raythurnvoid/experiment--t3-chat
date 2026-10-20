# Saved AI conversations

Use an external personal API key with `ai_chat:read`, bound to the thread's workspace. The key can read only conversations its user created. Active guests may read their own conversations. Workspace owners and admins cannot use this API to read another creator's conversation. Service keys, plugin tokens, and in-app short grants are refused.

Human Messages channels and reply threads are a separate domain. These routes do not list/search threads, send messages, or export human Messages.

## Transcript pages

POST `/api/v1/ai-chat/threads/transcript` with `{ threadId, endMessageId: null, cursor: null }`. The last two fields are optional and nullable. The body cap is 32 KiB; a cursor may have at most 16 KiB of characters. An explicit end must belong to the authorized thread.

The first response is `{ kind: "header", thread: { id, title, endMessageId }, fragment: null, cursor, isDone }`. An empty conversation has no end or cursor and is done. Without an explicit end, the first request pins the saved `newestNodeId`. An explicit end exports exactly its parent path. The API does not walk to newer children or substitute a model summary.

Each later response is `{ kind: "fragment", threadId, endMessageId, fragment, cursor, isDone }`. A fragment contains `messageId`, `parentId`, `clientGeneratedMessageId`, `role`, `createdAt`, `updatedAt`, `status`, `version`, `metadata`, `stepIndex`, `stepStatus`, and `parts`. Message status is `streaming`, `done`, `stopped`, or `failed`. Inline messages have null step fields. Reply step status is `tools_running`, `done`, or `partial`.

One page keeps one inline message or saved reply step whole. The encoded response cap is 8 MiB. Empty replies remain real fragments with empty parts. Messages arrive newest first, reply steps highest index first. Reverse message order and sort reply steps upward to reconstruct the saved conversation. Preserve metadata, IDs, parent links, raw parts, empty messages, and step status.

Follow the returned cursor until `isDone`. Use the same key, workspace, thread, and selected end. Do not recalculate the end from a later thread state. A new message does not change that export's branch. A changed reply while paging inside it returns 409 `errorCode: "transcript_changed"`; discard that partial export and restart, preferably after the reply ends. A bad or tampered cursor, or one from another key or thread, returns 400 `errorCode: "invalid_cursor"`.

This is a saved view, not one frozen snapshot of an active conversation. `isDone` means the read reached the root, not that the AI finished. Unsaved streamed text and observations that were never stored cannot be recovered.

This generic example needs an existing key supplied by the external caller. It does not install credentials or run inside app `execute_code`.

```js
export async function readAiConversation({ origin, key, threadId, endMessageId = null, fetcher = fetch }) {
  let cursor = null;
  let thread = null;
  const messages = [];
  const byId = new Map();
  while (true) {
    const response = await fetcher(new URL("/api/v1/ai-chat/threads/transcript", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      credentials: "omit",
      body: JSON.stringify({ threadId, endMessageId, cursor }),
    });
    const page = await response.json();
    if (response.status === 409 && page.errorCode === "transcript_changed") {
      throw new Error("The reply changed. Discard this export and restart after it ends.");
    }
    if (response.status === 429) {
      throw new Error(`Rate limited. Retry after ${page.retryAfterMs ?? "the server's suggested delay"} ms.`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${page.message ?? "Transcript unavailable"}`);
    if (page.kind === "header") {
      thread = page.thread;
    } else {
      const { stepIndex, stepStatus, parts, ...message } = page.fragment;
      let saved = byId.get(message.messageId);
      if (!saved) {
        saved = { ...message, parts: [], steps: [] };
        byId.set(message.messageId, saved);
        messages.push(saved);
      }
      if (stepIndex === null) saved.parts = parts;
      else saved.steps.push({ stepIndex, stepStatus, parts });
    }
    if (page.isDone) break;
    if (!page.cursor) throw new Error("The unfinished page has no cursor.");
    cursor = page.cursor;
  }
  for (const message of messages) {
    message.steps.sort((a, b) => a.stepIndex - b.stepIndex);
    if (message.steps.length) message.parts = message.steps.flatMap((step) => step.parts);
  }
  return { thread, messages: messages.reverse() };
}
```

A 401 means the key or membership is no longer live. A 403 means the scope, token kind, or personal binding is not allowed. A missing conversation and another creator's or tenant's target both return 404. Successes and failures use `Cache-Control: no-store`. Keep transcripts private; they can contain user text and saved tool output.

## Full stored tool output

Large saved tool results can contain an output reference. It is not a download URL or an access grant. POST `/api/v1/ai-chat/threads/tool-output/read` with `{ threadId, outputId, offset: 0, limit: 65536 }`. Limit is optional, defaults to 65,536, and accepts integer values from 4 through 65,536. Offset must be a nonnegative safe integer.

Success is `{ text, offset, nextOffset, totalBytes }`. Offsets count UTF-8 bytes, not JavaScript characters. Append each `text`, then send `nextOffset` as the next offset until it equals `totalBytes`. Do not calculate the offset from `text.length`. Pages keep whole characters and advance before EOF. EOF returns empty text and equal offsets. An offset beyond EOF is 400.

Only a ready output with a committed owner in the exact authorized thread is readable. Copied conversations may share a stored output. Revocation, member removal, deletion, or lost ownership during storage I/O releases no text. A temporary storage failure returns 503 `Stored output is unavailable`. No storage key or signed output URL is returned.

Historical quote text stays in the transcript even when its file is no longer readable; its file pointer is cleared. Other saved file references remain references. Reading the transcript does not fetch current file names, content, attachments, or download URLs. Use separately authorized Files routes for fresh file access. Some output references describe omitted binary/structured blocks; stored text cannot restore data that was never saved.
