---
name: files-editors
description: Map and debugging guide for the Files rich text, Monaco text, and diff editors, their Convex-backed Yjs provider, comment anchors, and portal containers. Use when changing editor UI or tracing sync, stale content, comment placement, or diff widget problems.
---

# Start With The Owning Files

Paths below are relative to the repository root. Open the files for the affected surface first.

| Area | Files |
| --- | --- |
| Editor selection and shared slots | `packages/app/src/components/files/file-editor/file-editor.tsx` |
| Rich text | `packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text.tsx` |
| Monaco text | `packages/app/src/components/files/file-editor/file-editor-plain-text/file-editor-plain-text.tsx` |
| Diff review and hunk widgets | `packages/app/src/components/files/file-editor/file-editor-diff/file-editor-diff.tsx` and its paired CSS |
| Client loading, rebasing, Monaco models, and presence | `packages/app/src/lib/files.ts` |
| Yjs provider and its hook | `packages/app/src/lib/files-yjs-provider.ts`, `packages/app/src/lib/files-yjs-doc.ts`, `packages/app/src/lib/files-yjs-awareness.ts`, `packages/app/src/hooks/files-hooks.ts` |
| Text conversion and Yjs updates | `packages/app/shared/files-tiptap.ts`, `packages/app/shared/files-yjs.ts` |
| Proposal text merge | `packages/app/shared/files-pending-text-merge.ts` |
| Live updates and stored content | `packages/app/convex/files_nodes.ts`, `packages/app/convex/files_nodes_content.ts`, `packages/app/convex/schema.ts` |
| Proposal persistence | `packages/app/convex/files_pending_updates.ts` |

Read the existing specs when the task touches their rules:

- [Editable text](../files-editable-text/SKILL.md): document shapes, collaboration mode, write checks, size limits, and stored content.
- [Pending updates](../files-agent-pending-updates/SKILL.md): proposal branches, Accept, Discard, Save, and Sync.
- [Rich text embeds](../files-rich-text-embeds/SKILL.md): image and video nodes, uploads, and shared extension sets.
- [Read-only files](../files-read-only/SKILL.md): file locks and how they affect writes.
- [Convex](../convex/SKILL.md): backend changes.
- [Browser QA](../app-playwriter-harness/SKILL.md): live editor checks. Its [file view notes](../app-playwriter-harness/references/file-node-view.md) cover selectors and sidebar flows.

# Keep Editor View And File Mode Separate

`textKind` chooses the document shape. Markdown uses rich text; other editable text uses `Y.Text`. `collaborationEnabled` separately decides whether the file has a live Yjs document. Both node fields are null for stored blobs and folders. See the editable-text spec for the full mode rules.

The collaborative rich editor sends edits through the provider as the user types. Monaco text edits stay local until Save. Its Sync merges remote changes into the local text while keeping undo history. This prevents incomplete Markdown edits from reaching the rich editor on each keystroke.

Diff review has its own pending branches. Accepting a hunk changes the staged branch; Save commits it. Do not treat an accepted hunk as a saved file. Follow the pending-updates spec for partial saves and rebasing.

Preparation, proposal Sync, and Save share the same line merge. Accepted changed lines win over saved overlaps, and unrelated saved text stays. Proposed text is merged separately, so a partial Save keeps unaccepted work. Build staged from the current base and unstaged from staged. Do not replay old branch delete sets into newer live text. Exact unique section moves keep their new position; accepted text in deleted sections keeps its paragraph breaks. If a rewritten saved block has extra lines and its target is unclear, refuse while keeping the proposal. Shared words can appear in an unrelated note, so they are not enough to choose a target.

Review prepares stale branches before allowing edits. Agent edit and shell-write tools also prepare automatically before reading fresh text; opening Review is not a prerequisite for agent work. Draft persistence, Sync, and Save carry the loaded proposal's `reviewedUpdatedAt`, so an old pane cannot accept a newer version.

Restore keeps every owner's proposals. The open diff view waits for preparation and reloads both prepared branches; it must not fill both panes with restored text. Retained branches use `contentRebaseRootKind` until preparation clears it and writes the current shape. Keep unsubmitted local text available for copying while replacing panes. Restoring stored bytes keeps text proposals too, but applying them to that stored-byte file remains undefined.

Files with collaboration off still support the views allowed by their shape. Their ordinary editors save the whole text through `replace_file_content`; proposal review uses the pending-update save path. Do not send these files through live Yjs loading.

# Trace Live Sync

The provider is app code adapted from Liveblocks. Convex stores and streams updates; R2 stores the snapshot bytes. The source comments name the read-only upstream reference files.

- `FilesConvexYjsStream` watches `files_nodes.yjs_get_incremental_updates` and sends merged local batches through `files_nodes.yjs_push_update`. The idle debounce is 500 ms. Failed batches stay ahead of newer edits.
- After the document has loaded, a `USER_EDIT` packet with the same `sessionId` is an acknowledgement only. It updates sync status without applying the edit again. Other origins are applied as remote edits.
- The first sync must include matching-session updates too: a fresh provider has not applied them yet.
- `sync()` merges the snapshot with later updates, applies the merged state, and advances `appliedSeq`. The backend returns updates in descending order; reconstruction applies them in ascending order and skips sequences already covered by the snapshot.
- Snapshot, update, and sequence reads must agree on `yjsLastSequenceId`. Numeric sequence values alone cannot identify a document after collaboration is toggled or its history is rebuilt.

For a one-time client read, start at `files_fetch_file_yjs_state_and_text` in `packages/app/src/lib/files.ts`. It checks the document ids across the three reads, fetches the R2 snapshot, applies later updates, and extracts text using the stored shape.

When opening file B shows file A's text, compare the route's `nodeId`, the hook's `providerNodeId`, and the rendered editor content. Inspect `useFilesYjs` and the caller's provider checks. Test repeated A/B switches after the fix.

# Separate Live State, Stored Text, And Version History

`files_yjs_docs_last_sequences.lastSequence` tracks live updates. `files_yjs_snapshots` points to a compacted R2 Yjs state; `files_yjs_updates` holds later packets. User-facing history uses `files_snapshots` and content assets.

`materialize_file_content` and `finalize_file_content_materialization` in `files_nodes_content.ts` publish derived text and snapshots. If search or agent reads seem stale, trace this job and its refusal markers, then inspect the reader's choice of committed or pending content. Use the editable-text and pending-updates specs for those contracts. Stored text may lag live typing; reconstruct Yjs when the caller needs live state.

# Comment Anchors

Comment marks hold thread ids inside rich text. Message content lives in Convex `chat_messages`. The shared extension is `packages/app/shared/files-tiptap-comments.ts`; the browser integration is `packages/app/src/lib/file-editor-rich-text-extension.ts`.

The rich editor reads thread ids from editor state. Monaco views call `files_get_comment_thread_ids_from_markdown` in `packages/app/src/lib/files.ts`, which uses a headless Tiptap editor for rich text and skips plain-text document shapes. `file-editor-comments-sidebar.tsx` loads the matching threads through `chat_messages.chat_messages_threads_list`.

For missing or misplaced rich-text comments, read:

- `packages/app/src/lib/file-editor-rich-text-anchored-threads.tsx` for measured thread positions.
- `packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-comments.tsx` for filtering and document order.
- Its paired CSS for the transform using `--lb-tiptap-anchored-threads-top`.
- `file-editor-rich-text-tools-comment.tsx` in the same folder for comment creation.

Check the thread list, document marks, scroll container, and CSS transform together.

# Diff Widgets And Portals

Diff hunk controls are Monaco content widgets. The editor CSS sets `anchor-name` from `--FileEditorDiff-anchor-name`; each widget sets `position-anchor` and uses `anchor(left)`. For misplaced controls, check both ends of that anchor link, the widget's current hunk position, and browser support before changing offsets.

`packages/app/src/routes/__root.tsx` owns `app_tiptap_hoisting_container` and `app_monaco_hoisting_container`. Editors use these DOM containers for menus and overflow widgets. For focus or outside-click bugs, trace the portal target and event handling as well as the visible editor.

Mounted Tiptap editors use `injectCSS: false`. Keep their styles in app-owned CSS layers. Headless conversion editors keep `element: null`. Follow the editor CSS rules in `AGENTS.md`.
