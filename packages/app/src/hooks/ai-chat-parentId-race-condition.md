# AI Chat: parentId client-generated ID race condition

## Problem

The `/api/chat` endpoint crashes with `500 Internal Server Error` ("Failed to reconstruct messages") when `body.parentId` is a client-generated ID (`ai_message-*` prefix) instead of a Convex doc ID.

## Root cause

There are two ID systems in play:

- **Convex doc IDs** (e.g. `n574t2ah...`) — assigned by Convex when messages are persisted via `thread_messages_add`
- **Client-generated IDs** (e.g. `ai_message-Lyy7...`) — assigned by the AI SDK's `generateId` when messages are created during streaming

The server's message reconstruction code builds a `messagesMap` keyed only by Convex doc IDs (`msg._id`). When `body.parentId` is a client-generated ID, the lookup fails.

## When does the client send a client-generated ID?

The frontend computes `parentId` in `prepareSendMessagesRequest` as `options.messages.at(-2)?.id`. Before sending, `sendUserText` sets `chat.messages = activeBranchMessages.list`, which is built from `persistedMessagesData` (Convex IDs) and `pendingMessagesData` (client-generated IDs).

**The race condition:** `onFinish` persists messages via a Convex mutation, but the Convex real-time subscription hasn't delivered the update to the client yet. So `persistedMessagesData` doesn't include the newly persisted messages, and `activeBranchMessages` still contains them with client-generated IDs.

This happens in **normal usage** — simply sending two messages in quick succession (before the Convex subscription round-trip completes) triggers it. Verified with runtime logs:

```
// Second message: parentId is a Convex doc ID (subscription delivered in time)
parentId: "n573qq77ebmfx33cz0d08qcveh80m8ff"
msgsIds: ["n57db1k3...", "n573qq77...", "ai_message-1bfhWbEua"]

// Third message: parentId is a client-generated ID (subscription NOT delivered yet)
parentId: "ai_message-1bfhWbEuaIjMewRBheFwBlX9cY1n6I8o"
msgsIds: ["n57db1k3...", "n573qq77...", "ai_message-1bfhWbEua", "ai_message-G1V6SNjox"]
```

The same issue also affects the SDK's `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` auto-retry path (for future client-side tools), where `chat.messages` is not reset via `sendUserText`.

## Fix applied

Two changes in `packages/app/convex/ai_chat.ts`:

1. **Dual-key message map** — index by both `msg._id` and `msg.clientGeneratedMessageId` so lookups succeed regardless of ID format:

```typescript
const messagesMap = new Map<string, ...>();
for (const msg of threadMessagesResult.messages) {
    messagesMap.set(msg._id, msg);
    if (msg.clientGeneratedMessageId) {
        messagesMap.set(msg.clientGeneratedMessageId, msg);
    }
}
```

2. **Resolve parentId for persistence** — before `onFinish` calls `thread_messages_add`, resolve the client-generated ID to a Convex doc ID so `normalizeId()` doesn't silently return `null`:

```typescript
let resolvedParentId: string | undefined = body.parentId;
// ... after reconstruction ...
if (body.parentId) {
    const parentMsg = messagesMap.get(body.parentId);
    if (parentMsg) {
        resolvedParentId = parentMsg._id;
    }
}
// ... in onFinish ...
parentId: resolvedParentId, // instead of body.parentId
```

## Alternative considered: block client until Convex syncs

Could prevent the client from sending messages until `persistedMessagesData` includes all messages from the Chat. Downsides:

- Adds noticeable latency (100-500ms+ round-trip: mutation → subscription push → React re-render)
- Hurts conversational UX (disabled composer after every message)
- Doesn't cover all edge cases (SDK auto-retries bypass `sendUserText`)

The server-side fix is preferred because it handles all cases in one place with no UX cost.

## `sendAutomaticallyWhen` and `providerExecuted`

The AI SDK's `lastAssistantMessageIsCompleteWithToolCalls` filters out tool parts where `providerExecuted: true`. For server-side tools (with `execute`), the SDK sets `providerExecuted: true` on tool results. However, the check only looks at the **last step's** tool calls. If the AI's final step is a text response (no tool calls), `sendAutomaticallyWhen` returns `false` and no auto-retry occurs.

In practice during testing, the auto-retry never fired because the AI's final step was always text. But it could fire if the AI exhausts `stepCountIs(5)` with tool calls still pending in the last step.
