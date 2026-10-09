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
| New file snapshot preload | `packages/app/src/lib/files-yjs-snapshot-preload.ts` and the creation handlers in `packages/app/src/components/files/files-sidebar.tsx` |
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

Proposal content lives in one optional `content` object. It holds `baseStateId`, `stagedStateId`, and `unstagedStateId`, plus a tagged `base`: `new`, `yjs` with `sequence` and `lineageGeneration`, or `asset` with `assetId`. Structural-only rows omit `content`. Use the shared content guards and narrow `base.kind` before reading base fields. Diff and HTML preview use this same object; do not read the removed top-level fields. Saved Yjs transport arguments such as rebase `baseYjsSequence` keep their existing names.

Every proposal has a `target`: `saved` points to `files_nodes`, and `private` points to the owner's `files_pending_nodes`. The editors, review pager, preview, and pending rows use this tag. Narrow `target.kind` before using its id. Private ids never enter saved-file permissions, presence, comments, snapshots, or Yjs reads. Proposal requests carry `target` and `reviewedRevision`. Ordinary saved-file doors keep `nodeId`. Cache ordering and preview identity use the integer `revision`; compare it only within the same proposal id. After Save, a retained proposal waits for `pendingUpdateRevision` in the query cache.

Private text opens from its ready, owned unstaged branch through `files_fetch_private_file_pending_text`. This checks the proposal id and revision again after loading. Preparing or failed reads must not produce an empty editor. Private Code and Rich text use the non-collaborative editor until publication, even when the captured create intent enables collaboration. Ordinary Save stages the current whole text and calls the common pending Save door through `files_save_private_file_pending_text`. Review keeps separate staged and unstaged branches and can publish a ready empty file. When Save returns a different target, navigate to it and rebuild the editor/provider key from its kind and id. Rich-text media uploads require a saved destination; private drafts can still display existing embeds.

Private Save can stage text successfully and then refuse publication, for example while copied media still needs Save. The helper reports its own successful upsert revision through `onUpserted` before publication. Each ordinary editor keeps that revision for retry without reloading or losing local text. It must not adopt a newer query revision from another edit; that stale retry still refuses.

The pending panel and floating review pager use `list_files_pending_updates` through `usePaginatedQuery`. Load more keeps short or empty continuing pages available. Bulk actions apply only to loaded, shown rows and carry each proposal id and revision. The open saved editor uses an exact `get_file_pending_update` query; the private editor reuses its exact owner view. Neither depends on its row being in a loaded list page. The chat strip and tab badge use `get_files_pending_updates_summary`; an incomplete count has a `+` suffix. A new chat with a null thread id skips that summary query.

Preparation, proposal Sync, and Save share the same line merge. Accepted changed lines win over saved overlaps, and unrelated saved text stays. Proposed text is merged separately, so a partial Save keeps unaccepted work. Build staged from the current base and unstaged from staged. Do not replay old branch delete sets into newer live text. Exact unique section moves keep their new position; accepted text in deleted sections keeps its paragraph breaks. If a rewritten saved block has extra lines and its target is unclear, refuse while keeping the proposal. Shared words can appear in an unrelated note, so they are not enough to choose a target.

Review prepares stale branches before allowing edits. Agent edit and shell-write tools also prepare automatically before reading fresh text; opening Review is not a prerequisite for agent work. Draft persistence, Sync, and Save carry the loaded proposal's id and `reviewedRevision`, so an old pane cannot accept a newer version.

Restore keeps every owner's proposals. The open diff view waits for preparation and reloads both prepared branches; it must not fill both panes with restored text. Retained branches use `contentRebaseRootKind` until preparation clears it and writes the current shape. Keep unsubmitted local text available for copying while replacing panes. Restoring stored bytes keeps text proposals too, but applying them to that stored-byte file remains undefined.

Files with collaboration off still support the views allowed by their shape. Their ordinary editors save the whole text through `replace_file_content`; proposal review uses the pending-update save path. Do not send these files through live Yjs loading.

# File View Dropdown And HTML Preview

`FileNodeViewFile` owns the searchable `View: <label>` dropdown at the start of the content toolbar. It uses `MySearchSelect` with one search field and one flat list of plain names. Keep the trigger visible even for one option and while an alternate view is open. Do not add icons, plugin names, groups, badges, or default-view controls.

The stored shape decides the editor options: rich text offers Rich text, Markdown, and Review changes; plain text offers Code and Review changes. Editable HTML also offers Preview. All files offer File details, then matching plugin views follow in installation order. Plugin titles are display names; plugin name plus view id keeps each option distinct, including duplicate titles. Folders and Home use the same picker for an editable README's actual shape, with editor options only. A folder without an editable README has no picker.

Alternate view selection stays local to membership and node. The URL `view` still uses only `rich_text_editor`, `plain_text_editor`, and `diff_editor`. Review always returns to the editor, even when the URL already says `diff_editor`. Automatic editor mode changes update the URL without leaving the active alternate view. Opening, searching, hovering, and arrow-key movement must not activate a view or mint a plugin session. Click or Enter selects the view. Search trims whitespace and matches part of a name, ignoring case; closing clears it. Keep the current selection based on the full list while filtering.

The editor stays mounted in a named region, hidden and inert outside its editor view. A late plugin query must not replace it or lose a draft. Hidden editors keep queued writes but do not prepare stale reviews or take focus. Preview and plugin frames unmount when inactive; changing plugins mounts a frame with the selected view's key. If the active view disappears, return to the default with a notice and recover focus only when it has fallen to the page body. The picker has its own toolbar portal host, separate from the editor-actions host that is hidden outside the editor. Rich text keeps the route's scroll surface.

`FileHtmlPreview` reads a frozen snapshot from Saved, Editor draft, or Proposed changes. First activation prefers a dirty current editor model, then the member's proposal, then Saved. Refresh reloads the chosen source. New edits show Updates available; they do not rerun scripts while the member uses the preview. A changed document identity or unavailable source clears the snapshot. Recovery requires Refresh, including after a collaboration toggle or proposal sync. Code reads its current model directly. Proposal Diff reads the modified pane and compares it with the confirmed unstaged text. It must not use the staged pane or Diff's save-dirty flag as the local-draft check.

Private HTML offers Editor draft and Proposed changes only. Its identity includes the private target, creation generation, proposal id, and revision. Private stored media uses `create_private_pending_download_url` with those same guards and the captured asset. It never looks up an asset by a saved node id. `get_file_pending_target` controls ordinary visibility and edit access; losing read access removes the editor and preview. The owner's pending panel still allows exact whole-proposal Discard after destination access is lost.

The HTML runtime lives in `packages/file-preview`, on a separate origin with no app credentials. The app never inserts HTML into its DOM. See that package's README for local setup, `VITE_FILE_PREVIEW_URL`, the frame protocol, browser security tests, and deployment headers. Old HTML blobs and plain-text files named `.html` keep their stored type and do not gain Preview through a rename.

HTML Monaco uses syntax coloring only, like the other code files. `app-monaco-config.ts` disables its worker-backed language services because the app loads only the base editor worker. Keep this mode rule when adding a mapped language; otherwise folding, symbols, or links can call methods the worker does not provide.

# Trace Live Sync

The provider is app code adapted from Liveblocks. Convex stores and streams updates; R2 stores the snapshot bytes. The source comments name the read-only upstream reference files.

- `FilesConvexYjsStream` watches `files_nodes.yjs_get_incremental_updates` and sends merged local batches through `files_nodes.yjs_push_update`. The idle debounce is 500 ms. Failed batches stay ahead of newer edits.
- After the document has loaded, a `USER_EDIT` packet with the same `sessionId` is an acknowledgement only. It updates sync status without applying the edit again. Other origins are applied as remote edits.
- The first sync must include matching-session updates too: a fresh provider has not applied them yet.
- `sync()` merges the snapshot with later updates, applies the merged state, and advances `appliedSeq`. The backend returns updates in descending order; reconstruction applies them in ascending order and skips sequences already covered by the snapshot.
- Snapshot, update, and sequence reads must agree on `yjsLastSequenceId`. Numeric sequence values alone cannot identify a document after collaboration is toggled or its history is rebuilt.

The sidebar starts the normal snapshot action and R2 byte fetch after New file succeeds, before navigation, when it will open Rich text. This covers inline creation and the sidebar's name modal. Folder, Code, and Review creation do not preload. The file-view toolbar's name modal does not open the new file, so it does not preload either.

The preload holds one pending read for an exact membership and node. The next provider takes it once and still creates its own document. Sidebar cleanup cancels an unclaimed read after leaving the expected route, changing membership, closing the sidebar, or failed navigation. After the provider takes it, the provider owns cleanup. StrictMode's existing deferred provider setup stays in place. A later provider or sync uses a fresh action.

Saved collaborative Rich text with a matching pending New file preload waits for the existing write-permission query to answer before mounting its provider. The read-only preload accessor checks membership and node; render never takes the slot. Use the current rich-text skeleton while that answer is unknown. A known false answer still opens a read-only provider. Without this wait, startup can create a temporary read-only provider, cancel its claimed preload, and start a second snapshot read when write access loads. Later real access changes still replace the provider and drop queued edits after write access is lost. Ordinary opens, other views, private drafts, and stored text keep their current loading paths.

An early snapshot can become stale when materialization deletes covered update packets. Before applying a preload, the provider reads the existing separate `get_file_last_yjs_sequence` query and checks the latest update log. It requires a full sequence from the snapshot through that head. A gap or an old preloaded document id starts a fresh snapshot read. A null result still means the read was refused. Ordinary snapshot reads keep their existing path. Measure this extra sequence wait when checking the preload's gain; do not assume that starting earlier makes the editor ready earlier.

For a one-time client read, start at `files_fetch_file_yjs_state_and_text` in `packages/app/src/lib/files.ts`. It checks the document ids across the three reads, fetches the R2 snapshot, applies later updates, and extracts text using the stored shape.

When opening file B shows file A's text, compare the route's `nodeId`, the hook's `providerNodeId`, and the rendered editor content. Inspect `useFilesYjs` and the caller's provider checks. Test repeated A/B switches after the fix.

# Separate Live State, Stored Text, And Version History

`files_yjs_docs_last_sequences.lastSequence` tracks live updates. `files_yjs_snapshots` points to a compacted R2 Yjs state; `files_yjs_updates` holds later packets. User-facing history uses `files_snapshots` and content assets.

`materialize_file_content` and `finalize_file_content_materialization` in `files_nodes_content.ts` publish derived text and snapshots. If search or agent reads seem stale, trace this job and its refusal markers, then inspect the reader's choice of committed or pending content. Use the editable-text and pending-updates specs for those contracts. Stored text may lag live typing; reconstruct Yjs when the caller needs live state.

# Comment Anchors

Comment marks hold `channels_messages` root ids inside rich text. Comment content and state use file channels. The shared extension is `packages/app/shared/files-tiptap-comments.ts`. The Comments sidebar uses the same composer, message renderer, and thread pane as Messages.

The rich editor reads root ids from editor state and calls `channels_messages.get_thread_by_root` per mark. Monaco and diff keep reading mark ids through `files_get_comment_thread_ids_from_markdown` for anchor information. Their list comes from `channels_messages.list_posts`, including general comments. Saved plain text, code, and stored files all have comments. Private pending files do not.

Anchored roots start hidden from other people. They do not advance public read positions. Add the returned root id as a mark, wait for Yjs to save it or save a non-collaborative file, then confirm the anchor. Confirmation assigns the next public sequence. A failed mark is removed and the hidden root is discarded. Non-collaborative anchors still require a clean editor before send. General comments ignore the local read-only policy, but still require content-write permission.

Keep the selection menu while its comment popover is open. Disabling Send can drop focus to the page during a slow save. That must not close the composer or lose its draft.

Comments use the shared Messages attachment controls too: existing Files, Upload files, paste
and drop. Pending or failed uploads block Send and Enter. Attachment-only comments are allowed.
Anchored uploads stay author-only until the mark is saved and confirmed. If saving the mark
fails, discard the hidden root and reset the upload targets and message retry id. Keep the local
files for Retry. The discarded upload ids cannot be attached again.

People mentions in Comments and Messages use the same typed data and `channels_inbox` producer.
They appear in the bell and Messages Activity through the same checked preview. Opening a file
channel does not clear a post-root mention; opening its post does. Lost file access hides the
whole comment item. The bell's dismiss action only archives jobs and invites.

The rich selection menu also has Quote in Agent and Quote in Comments. Both use the shared quote
shape, view, and Tiptap extension from `shared/file-quotes.ts` and `src/components/file-quotes`.
They carry only a saved file id and selected plain text, at most 4,096 UTF-8 bytes. Names and links
come from the current file query. Lost file access keeps the sent text and hides file details.

`files::quote_selection` carries membership, target, and quote. The sidebar selects Agent or
Comments. Each target keeps the request until its normal composer is ready, then appends it once
without replacing the draft. A first AI chat must exist before its composer accepts the quote.
Message edits and queued AI edits keep the quote pending for the normal draft.

Read-only rich editors show a quote-only selection menu. Quote in Comments still needs file
content-write permission, even when a local read-only policy blocks text edits. Write actions
remain hidden. Private pending files have no quote action. Code view has no selection bubble,
so it does not add a quote toolbar.

Resolve and reopen never write file content. `setCommentThreads` changes plugin metadata to show only open marks. The document has no orphan attribute. Missing confirmed marks appear in the list with their saved excerpt. The old comment table and doors are removed.

For missing or misplaced rich-text comments, read:

- `packages/app/src/lib/file-editor-rich-text-anchored-threads.tsx` for measured thread positions.
- `packages/app/src/components/files/file-editor/file-editor-rich-text/file-editor-rich-text-comments.tsx` for filtering and document order.
- Its paired CSS for the transform using `--lb-tiptap-anchored-threads-top`.
- `file-editor-rich-text-tools-comment.tsx` in the same folder for comment creation.

Check the thread list, document marks, scroll container, and CSS transform together.

# Diff Widgets And Portals

Diff hunk controls are Monaco content widgets. The editor CSS sets `anchor-name` from `--FileEditorDiff-anchor-name`; each widget sets `position-anchor` and uses `anchor(left)`. Monaco's EXACT overflow position is relative to the editor, so `afterRender` adds `anchor(top)` to `coordinate.top`. This follows the toolbar and status rows above the editor without a fixed header offset. Hidden editors remove the portalled hunk buttons through `isActive`. For misplaced controls, check both ends of that anchor link, the widget's current hunk position, and browser support before changing offsets.

`packages/app/src/routes/__root.tsx` owns `app_tiptap_hoisting_container` and `app_monaco_hoisting_container`. Editors use these DOM containers for menus and overflow widgets. For focus or outside-click bugs, trace the portal target and event handling as well as the visible editor.

Mounted Tiptap editors use `injectCSS: false`. Keep their styles in app-owned CSS layers. Headless conversion editors keep `element: null`. Follow the editor CSS rules in `AGENTS.md`.

The Files rich editor uses warm neutral styles in `file-editor-rich-text.css`, shared by both editor variants. Body text uses `fg-11` and headings use `fg-12`. Quotes and code blocks use `base-1-03` with `base-1-07` borders. Tables use `base-1-05` headers and alternate `base-1-02` / `base-1-03` rows. Only links use the accent color; code syntax and default highlights stay neutral. Explicit colors saved in text and highlight marks still apply.

Focus outlines use the shared 4px radius from `app.css`, after Tailwind's reset. Use `fg-12` for non-link focus outlines, matching shared buttons and inputs; links keep the accent color. Native task checkboxes ignore corner radii, so their existing labels draw the rounded outline with `:has(input:focus-visible)`. Keep the input's own outline hidden only while that label outline is shown.

Keep document styles scoped to the two rich editor content classes. The global `.ProseMirror` / `.app-doc` rules also serve other editors and chat. Task-list and horizontal-rule spacing belongs in the Files CSS, without competing utility classes in the browser extension list. Code blocks expose their existing language as `data-language` for a CSS label; this adds no document text and does not change Markdown serialization. Code and frontmatter labels use `::before`, so the node selection fill uses `::after`.

The app surface stays dark with either the `light` or `dark` theme class. Check both classes and both rich editor variants when changing these styles.
