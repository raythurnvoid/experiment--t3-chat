---
name: channels
description: Human Messages channels and file comments. Load for channel access, members, message sends, threads, read positions, mentions, reactions, or channel cleanup.
---

# Model

Human Messages use `convex/channels.ts`, `convex/channels_messages.ts`, and `shared/channels.ts`.
AI agent chats remain private chats in `ai_chat.ts`. Human channels belong to one workspace.

Kinds:

- Public: workspace `content.read` reads; `content.write` posts. A channel manager, owner, or
  `workspace.channels.manage` holder manages it. Public names are unique in that workspace.
- Private: workspace read plus a channel member pinned to the current workspace membership reads.
  The owner can also read and manage. Members need workspace write to post. Private names may repeat.
- Direct: the participant set is fixed, at most 9 people including the caller. A sorted list of
  workspace membership doc ids forms `directKey`. The owner reads but cannot post unless a
  participant. A departed participant ends a two-person conversation; groups remain open.
- File: one channel per saved file. Live file `content.read`, `content.write`, and
  `content.permissions.manage` decide access. Names and paths come from the current file. Folders
  and unfinished upload placeholders cannot have comments. Copying a file does not copy its channel.

All doors use `channels_db_get_access`. Compare the tenant first. Missing access returns `Not found`
or a nullable query result. Missing or tombstoned current users return `Unauthenticated`. Private and
direct access requires the member's `workspaceMembershipId` to equal the current membership `_id`.
Account restore keeps that id. Removal and re-invite create a new one. The owner has no unread state
or mention items in a private/direct channel they have not joined.

Creation supports the messages layout. Direct always uses messages. File channels always use posts
and support resolve. Public/private resolve is off by default and a manager can enable it. Layout
never changes. Archived channels and archived files stay readable but refuse posts.

# Messages and threads

Bodies are Markdown, at most 16 KiB UTF-8. Keep the caps in `channels_LIMITS`. Check all access,
mentions, attachments, quote text, and field limits before the first content write. Rate buckets
are `channels_message_write`, `channels_reaction_write`, `channels_write`, and `channels_upload_write`.
Read-position writes take no rate token. Anchored confirm/discard also take no extra token.

Every send gets a `channelSequence`. Roots and broadcast replies get a `mainSequence`. Replies
get a per-thread `threadSequence`. A retry uses the author's pinned workspace membership and
`clientMessageId` and returns the same
message without another counter or inbox write. Threads use their root message id in public doors,
URLs, and document marks. A reply cannot start another thread.

Inline replies target the same channel. A stored quote must be a substring of the target's plain
text. `channels_messages.ts` reads it with the editor's shared Markdown reader,
`files_tiptap_markdown_to_plain_text`. Keep that import out of `shared/channels.ts`: `channels.ts`
imports that file, and the reader adds about 2 MB to its cold load. On read, drop a
quote that an edit removed. Deleted targets show a deleted notice. File attachments are shaped per
viewer; an unreadable file returns no file id, name, or path. Do not return raw attachment ids beside
the safe fields.

Authors edit with `expectedRevision`. Edits never notify or create new followers. Removing a mention
retires only its mention inbox item, keeping a separate inline-reply item. Authors and managers can
delete under their channel rules. Deleted messages disappear, except a root with live replies keeps
a tombstone. Readable inbox items leave in the delete transaction. Previously delivered items for
denied readers stay as inert locked rows until access returns. Reaction docs drain in bounded jobs.
A deleted empty root loses its thread immediately; a durable cursor job cleans readable followers.
Denied followers keep their locked row. Whole-channel deletion may remove those rows.

People mentions are unique user ids, at most 50. Each person must currently read the channel.
An owner who only reads a private/direct channel cannot be mentioned. Refusals never reveal another
workspace's profile name. Notifications use `channels_inbox` only. Inline reply authors also receive
an item when they still have access. Thread authors, reply authors, mentioned people, and inline
reply targets follow automatically. Unfollowing retains their read position.
Store `authorWorkspaceMembershipId` and the parallel `mentionWorkspaceMembershipIds` beside user
ids. Later thread creation and anchor confirmation use these exact pins. Never resolve an old
author or mention to a replacement membership. These internal pins do not enter message UI results.

File mentions use `fileMentionIds`: at most 50 unique saved file or folder ids. Check current file
read access before sending. Store neutral positions in Markdown. Shape every reference for the
reader, including reply previews and agent reads. An unavailable mention has no id, name, path,
or link. The returned message's raw `fileMentionIds` array stays empty.

Selected file quotes use the shared `{ fileNodeId: string | null, text }` shape in
`shared/file-quotes.ts`. Allow at most 20 quotes and 4,096 UTF-8 bytes per quote. Body plus quote
text must fit the 16 KiB message cap. Quotes require readable, unarchived saved files. Reads keep
the selected text but replace an unreadable file id with null. The current file query supplies
the name and link. Never store copied names or paths. Edits may retain a quote whose id is null.

# Messages UI and agent reads

Routes live under `/w/:organizationName/:workspaceName/messages`. The index restores the last
readable channel for the current membership. `:channelId` accepts `thread` and `message` search
params. Missing or unreadable ids show the same unavailable notice. A personally closed DM remains
readable; explicit navigation can reopen it through the revision-checked Open door. Browse lists public channels.

Activity lists current mention and inline-reply inbox items. Threads lists followed roots by
latest activity. Search keeps text, channel, person, attachment and UTC date filters in the URL.
The Person filter is a search select over the member search below, with Anyone first.
All three use checked message previews and Open context. Posts and replies open their thread.
Opening a feed never marks its items read; visible channel and thread content advances the
existing read positions. Keep Load more after an empty readable page when a cursor remains.

`AppChannelsProvider` owns one summary query per active membership. Pane components own their pages
and visible row queries. The main Messages dot and `(N) Bonobo Senate` title count followed channels
with unread mentions, even while Files is open. Channel row bold follows all/mentions/none. Activity,
Threads and the bell use stored full-history totals. Totals can lag while durable work runs; the UI
says so. During access repair, show Updating without a number or dot. Never derive a global total
from loaded pages. The bell reuses Activity; Dismiss jobs and invites keeps the old archive writes.
There is no second notification producer or message-item read flag.

UI modules live in `src/components/channels`. The sidebar has starred channels, public/private
channels, direct conversations, and followed files, each with its own indexed pages and Show more.
Member pages set native row and byte read limits before checking each channel's access. Reactive
end cursors can grow a page beyond its initial size; keep native split metadata and every read item.
Starred rows use star recency, named rows use A–Z, direct rows use main-message recency, and files use
accepted comment activity. Archived named channels stay out of these sections. Settings and member actions follow the backend
permissions. Private and direct headers disclose the owner read rule. Lists have named landmarks
and message ids. Pane headers and neutral surfaces follow Files. There is no extra Messages bar.

People in the UI follow one rule: never load the workspace member list in the browser.
`channels-people.ts` reads a known id with `users.get_workspace_member_anagraphic`, then with
`users.get_anagraphic` for someone who is no longer an active member. Direct names add "(left)"
for that person and show "…" while loading, never an early "(left)". Every place where a user
picks people ("@", Message someone, add to a private channel, the Person filter) pages through
`organizations_member_names.search_workspace_members` 20 at a time, with Show more people.
Add people keeps the loaded channel members in the list, locked with "Member". Adding a current
member again changes nothing on the server, and the same direct group reopens its conversation.

The header shows the stored `channels_activity.memberCount`. It never pages the member list to
count. `list_channel_members` and the agent `channels members` return every member row with a
status: `active`, `left` (its pinned workspace membership is no longer active), or `locked` (the
person cannot read the channel now). They never drop rows, so the list and the count agree. The
members dialog shows "(left)" and "(can't see this)". A manager can remove both; a `left` row
cannot change level, and Add people does not lock a person whose row is `left`.

Measure the Messages region after the global navigation. At 1200px and above, show the sidebar,
channel and open thread. At 940–1199px, an open thread moves the sidebar into a drawer. At
820–939px, show the sidebar and thread. Below 820px, show one conversation with a channel drawer.
The sidebar defaults to 240px (220–320px); the thread defaults to 380px (360–480px). Split channels
keep at least 560px. Save the two widths separately. Hidden channel panes stay mounted so drafts,
attachments and the visible message survive thread opens and resize. The root and replies share
one scroll area. Back or Close returns focus to the opener when it is still present.

Rows show local 24-hour timestamps, with the full date on focus or hover. Keep the existing
five-minute grouping and entry unread boundary. Reply in thread is separate from Quote reply
in More; R still quotes. More holds thread follow, rename and resolve actions. Rename opens a form.
Touch exposes More beside the message, without adding a separate action row. Person mentions
use current names; file mentions stay inline.
Activity and search use flat rows with four-line previews and no preview scrollbar. Search filters
open from Filters; applied filters can be removed. Never invent a search total or match range.

`ChannelsComposer` is shared with Files comments. People chips store neutral Markdown positions
with ids in `mentionUserIds`. Render names from current profiles; a chip reads its name by id.
The composer's `mentionTarget` (a channel or a file) turns on `@` and `#`. The sender's local draft keeps raw
chip ids so it can restore them. Enter chooses a suggestion before sending; Shift+Enter adds a line.
Escape closes a suggestion first, then cancels reply/edit. Empty Up edits the latest own message.

Formatting opens an optional tools row. Bold, Italic, Strike, Link, inline code, code block and
both list types run real editor commands. Pressed states follow the editor selection. The local
editor supports undo and keeps these Markdown marks and blocks when restoring a draft or edit.
The Tiptap Markdown writer keeps edge spaces outside emphasis, so text beside a file quote
keeps its formatting after send or restore.
Enter still sends from lists and code blocks; Shift+Enter adds a line. Link addresses use http,
https or mailto. The link form sits outside the message form and stops its submit event, so Apply
link and Enter in its field cannot send the message. Files comments share these tools.

The `@` popup lists matching people first, then saved files or folders from the
shared `FilesNodePicker`, excluding archived nodes and private drafts. It browses one folder at a
time or searches names in pages of 50; an open folder offers "Mention this folder". People show
only at the root while the text has no `/`. The popup asks `get_mentionable_users` about the
loaded people only, one page of ids per query. A person who cannot be mentioned stays in the list as
"Name (can't see this)" with a lock, and a pick does nothing, like Slack shows people outside a
channel. A row can be picked until its answer arrives; send checks every id again. The `#` popup
pages public and joined private channel prefixes from the server. Messages and Files Comments use
this same popup and composer.

Browse and channel pickers use normalized whole-name prefix ranges. Public Browse uses the workspace,
kind, archived and name index. Private search uses exact-membership name projections. Discovery pages
must carry the current `accessScopeKey`; a stale key returns no rows before reading the name range.
Mount each page group by that key so old cached names leave immediately after an access change.
Private search keeps joined matches after read access is lost. Match the last readable name and
return only a generic No access row; a hidden rename must not change that match. Public Browse
still requires workspace read access.

A sidebar or feed row whose reader loses access returns only its stable personal row id, immutable
kind, and `locked` state. Render No access without mounting name, profile, path or message queries.
Keep its last readable sort and archive fields frozen. Hidden activity, rename, archive and message
deletion must not move it or change access status. Current access is checked again when opening.
An authorized reader whose source disappeared gets Unavailable until cleanup. Files use current
saved placement, including the published Move view, for this check.

Close is personal to one exact membership. It stores the current main sequence and advances a
visibility revision. Only a later readable main message, broadcast reply, or explicit Open reopens
a direct conversation. Ordinary thread replies and send retries do not. Explicit Open compares the
expected revision, so an Open that captured an older revision cannot undo Close. Navigation waits for
readable state, captures that revision once, and never retries with a newer one. Close also cancels
pending navigation in the same tab. A different tab that has not loaded any state yet can load the
post-Close revision and reopen. Keep this rule so direct links work with one click; Close hides a
conversation and does not revoke access. Restoring the same membership catches up main activity
after its saved cutoff. A new membership gets fresh personal state.
Visible and stale-revision Open calls take no write token. A real reopen checks the write rate limit
after access and revision checks, before changing personal state.

Slack documents [opening or resuming a DM](https://docs.slack.dev/reference/methods/conversations.open/),
but does not promise an order for this two-tab race. Rocket.Chat's
[room loader](https://github.com/RocketChat/Rocket.Chat/blob/7a174fd05604dac39af95f76ea9db73db2b3ca5f/apps/meteor/client/views/room/hooks/useOpenRoomById.tsx)
loads the room and subscription before opening a hidden room. Our one-click rule follows that pattern;
the revision check adds protection for an Open that already read older state.

Both human and AI composers use `components/file-quotes/file-quote-extension.tsx` and `FileQuote`.
Private local drafts keep encoded quote markers; human sends replace them with neutral quote
positions and typed `fileQuotes`. Restore drafts with the composer's own Markdown parser, so
custom quote and mention nodes survive. A quote request appends to the draft once and waits while
a message is being edited. A refused send keeps the same draft.

The message window keeps a separate live head and bounded history: five main pages, two thread
pages, and a three-MiB budget. Editing pins its message. Reconnect keeps cached rows. Read positions
advance only for visible rows. Inline replies use selected body text. Reactions load their emoji
picker only when opened. The existing-file picker checks current access and upload readiness in
batches of 50. Sending checks these again.

Agent reads use `server/bash-channels-command.ts`, registered beside `meta`. The commands are
`channels ls`, `channels members`, `channels read`, and `channels search`. Their internal queries check the acting user,
workspace membership, and source lifetime before channel access. Scope is current workspace or
personal home only. References include ids, public names, file ids/paths, and Messages URLs.
Read dates are UTC; until is exclusive. Pages cap at 50 and short cursors last 24 hours. Cursors keep
workspace, source, reference, query, author, attachment/date filters, and page size.
See the [agent spec](../ai-chat-agent/SKILL.md).

`channels ls` never reads a channel the user is not in, except public channels. Private, direct
and file channels come from the user's own member rows through `channels_members.channelKind`, a
copy of the channel's kind, which never changes. This matches Slack and Discord, which hide private
channels from non-members. The owner can still open any private channel by id, but `ls` lists only
the ones they joined. File channels are listed this way too. Listing every file channel would show
which files in locked folders have comments. A readable file the user never joined is read with
`channels read file:<path>`.

A joined channel the user can no longer open stays in the page as a locked row with only its id
and kind. Its file may now sit in a locked folder. Platforms differ here: Teams keeps old group
chats readable, Dropbox removes unshared files, and Linear removes subscriptions. So this rule is
our own choice, not a copy of one product.

Public channels come from the workspace channel index and need workspace `content.read`. A guest
cannot browse them, like guests in Slack, Google Chat and Mattermost. `--kind public` then answers
"Permission denied: public channel browsing needs workspace read access. Ask an owner or admin for
access." Without `--kind`, the public part is skipped and every page prints a notice on stderr, so
the agent does not read a short list as "no public channels". The check runs on each call, so an
old cursor into public channels is skipped after access is lost. The check stays in `agent_list`,
not in the shared agent context, because a guest can still use `read`, `members` and `search` on
shared files.

Without `--kind`, pages walk public, private, direct, then file. Each page reads one kind, so a page
can be short or empty where a kind ends.

Search reads the stored body index. Use 1–16 words and at most 512 characters; the shared schema
checks UI, Bash and backend inputs. Tenant equality is inside the search index. Optional channel,
author and attachment equality filters precede the inclusive Since and exclusive Until filter.
Each page returns at most 50 candidates, then checks current channel/message access and shapes
references. An author's unconfirmed comment stays private to that author. Deleted hits disappear.
Convex search ignores maximumRowsRead and maximumBytesRead and has a 1024-candidate scan limit.
Do not claim a 50-total-document read limit. Keep continuation through hidden or deleted hits.

# File comments and anchors

File comments use `send_message` with `target.kind: file_comment`. It creates the file channel in
the send transaction. General comments ignore write policy because they do not change file content.
An anchored comment checks the same human write-policy helper as Yjs writes.

An anchored root starts with `anchor.confirmedAt: null`, channel sequence zero, and no main sequence.
It does not advance public activity or read positions. Only its author can read it. Replies,
reactions, resolve, and titles refuse until confirmation. Add and save the document mark, then call
`confirm_comment_anchor`. That call assigns the next public sequences and activity time, then
publishes mentions, followers, and the author's channel membership. An earlier visit cannot mark
this newly visible root read. Confirmation drops people who lost access and updates their body
positions, so a remaining chip still names the same person. Repeating confirmation has no effect.
Discard after a failed mark with `discard_unconfirmed_comment`. The hourly cron removes
unconfirmed roots older than one hour with no replies. Resolve changes the thread sidecar, not Yjs.
Replies reopen resolved threads.

`ChannelsPosts` shows Open, Resolved and All pages with at most 50 roots loaded at once. Files uses
the same post list and `ChannelsConversationPane` for replies. Rich text keeps open marked roots
beside the text and leaves them out of the general list. Confirmed roots with missing marks show
Original text removed and their excerpt. The shared composer exposes a multiline textbox role.

`get_mentionable_users` checks the sender's target access and at most 50 candidate ids. The composer
uses the same `can_mention` rules as send. File candidates work before the first file channel exists.

# Read state

Messages layout reads `mainSequence`; posts layout reads `channelSequence`. Forward writes clamp
to the latest sequence and keep the maximum. Mark unread stores the sequence before a message.
Ordinary thread replies do not make the main stream unread. Broadcast replies do.

A posts visit captures its latest channel sequence once. Mark only that captured value, keeping
new activity during the visit unread. Keep the visit's old read position for New labels. Posting in
posts moves the author's channel cursor only if they were already caught up. It always reads their
own replies in that post. Root mentions set `pendingRootMention` on a follower and stay unread until
the post opens. Channel visits do not clear this flag. Channel mention badges count at most 100.

Thread followers store reply read positions and a following flag. `mark_thread_read` clears a root
mention and advances the reply cursor. Follower ordering syncs in batches after a reply, using the
thread's current activity time. The thread doc supplies current unread state during that sync.
New auto-follows made while denied start off the feed; access restoration can reveal them.
Previously visible denied followers stay locked at their last readable position.

`list_my_threads` and `list_my_inbox` read at most 50 source docs per page and re-check current channel
access before returning any item. Inbox unread state comes from channel and thread read positions.
A broadcast is unread only while both positions are behind it. A post root uses the follower's
`pendingRootMention`, so visiting the channel cannot clear it. Removing a root mention queues the
sequence-zero interval even if the reply cursor did not move. Deleted messages have no readable
inbox item; denied readers retain their locked receipt until access restoration can clean it.

Global totals live in `channels_summaries`, keyed by exact workspace membership. Each member,
receipt and follower stores its summary id, generation and current boolean contribution. A write
replaces that contribution in the same transaction; a hard delete subtracts it first. Baseline repair
zeros totals, advances the generation and pages members, receipts, then followers. Both summary id
and generation must match before an old contribution can be subtracted. Concurrent writes stamp
the current generation, so a later baseline visit cannot count them twice.

`server/channels-notifications.ts` owns count writes, Messages authority clocks and durable job enqueue.
`convex/channels_notifications.ts` owns worker doors and the summary query. Scope access changes bump
Messages clocks and page actual summaries; private/direct member changes advance the member's own
authority revision. File content, names and archive changes do not bump these access clocks. Move
publication requires a complete bounded semantic access proof before advancing a clock. Summary
readiness checks clock doc ids and revisions plus the stored member authority repair target.

Sidebar and follower fan-out use stable source indexes with coalesced pass revisions. Read changes
queue exact receipt intervals. Workers recompute current predicates instead of applying old numeric
deltas. The recovery cron pages one job kind per call with a fixed cutoff and native cursor. It skips
pending scheduled calls but still continues past that page. Failed calls retry from stored progress.
Ordinary writes may leave delayed totals; access mismatch hides them until repair finishes.

# Uploads

Channel uploads use `convex/channels_uploads.ts`, a `channels_uploads` link and a
`files_r2_assets` doc of kind `channel_upload`. They live outside the Files tree. A target needs
post access, the upload rate token and the shared paid storage admission before either doc exists.
A saved file target may create its file channel only after every refusal passes. Upload minting
does not join or follow the channel. Keep the original leaf name; refuse blank names, separators,
control characters and more than 255 UTF-16 units.

PUT is create-only and signed for 15 minutes. The client settlement action and R2 event both call
`r2.settle_channel_upload_asset`. That mutation guards publication before charging real bytes
through `files_stored_uploads`, with a null file node id. It never converts text or starts Files
plugin events. Oversize queues exact-key deletion with the late PUT window, deletes the link and
asset, and emits no charge. Replays count and charge nothing.

Sending validates the uploader, channel, settled bytes, expiry and unused message link. Refuse
duplicate upload ids in one send. Attach and clear the 24-hour asset deadline in the message
transaction. Shaped reads return only the checked upload id, name, type and size. Agent text
prints the name and upload id; it never includes a signed URL.

Download actions check current channel access. Unattached bytes are private to their uploader.
Attached bytes also require a live, visible message; an unconfirmed anchor stays author-only.
Sign GET for at most 15 minutes using the Files safe type and disposition helper. Deleted messages
release uploads with an immediate cleanup deadline. Discard and stale-anchor cleanup do the same.
The existing R2 cleanup removes both docs and queues exact-key deletion. Deletion gives no refund.

The shared composer owns existing Files attachments, the Attach files menu, paste and drop.
Attach files offers Upload from computer and Attach from workspace. Attach from workspace uses
`FilesNodePicker`; one pick attaches one file and closes the dialog. A file that
`get_attachable_files` refuses (unreadable, or its upload has not finished) shows disabled with
"This file cannot be attached"; send checks again. Each file chip reads its name by id with
`files_tree.get_file_node_for_membership`; it says "Loading…" until the answer arrives and
"File unavailable" for a file that is unreadable or archived. Text, quote/edit context,
attachments and a visible Send button share one input box. The editor scrolls when it grows.
File Comments use this same composer and thread pane, with Back to comments.
Each local upload shows its name, progress, Ready or its error, and Remove. Failed uploads have
Retry. Pending and failed uploads block Send, Enter and form submit. Attachment-only messages
work in channels, replies, posts and file comments. A successful send clears the local files.

Retry settles the same attempt first, since a lost PUT response may still have stored the bytes.
Reuse a live create-only PUT. Mint a new attempt only after its URL expires and no object exists.
A discarded anchor releases its uploads, so reset their targets and the message retry id. Keep
the local files with an error and Retry; the next attempt must upload them again.

The shared upload renderer previews allowed images and videos up to 20 MiB. Refresh checked
URLs before their 15-minute expiry. Lost access removes the upload from the shaped message and
unmounts its preview. Larger files and unsafe media types still offer Download and Save to Files.
Save to Files downloads the bytes and uses the ordinary create-only Files upload door with
`onConflict: fail`. Its folder picker opens folders, and "Save here" saves into the open folder or
the root. "Save here" is disabled with "You cannot add files to this folder" when
`get_current_user_file_write_permission` refuses that folder; the upload door checks again. The new copy follows Files write rules, storage limits and its own charge.
This copy uses browser memory for the downloaded blob.

# Cleanup and checks

Organization removal and user finalization drain members, reads, followers, inbox, summaries and
their member jobs. Cleanup must not recreate derived state for a deleted user. Keep messages,
reactions, and channel uploads as workspace content. Member deletion lowers `memberCount` in
the same transaction. Workspace purge also drains authority clocks, Move proofs and all durable
Messages jobs before deleting parents through tenant indexes.
See [Data deletion](../data-deletion/SKILL.md) and [Tenancy](../organizations-tenancy/SKILL.md).

Delete permanently of an archived file deletes its comment channel too, with every message, reply,
reaction, member, read position, follower, inbox row, Messages job and upload in it (`channels_db_purge_channel_batch`). It deletes
one table at a time, children before parents, in the workspace purge order, and the channel doc goes
last. Only this path deletes a single channel. Archiving a file keeps its channel.

Focused tests live in `convex/channels.test.ts`, `convex/channels_notifications.test.ts` and
`convex/channels_uploads.test.ts`. Run through Vite Plus:

`vp env exec pnpm --dir packages/app exec vitest run --project convex convex/channels.test.ts convex/channels_notifications.test.ts convex/channels_uploads.test.ts`

Files uses the channel door for every saved file. The old comment table, doors, composer, and orphan
attribute are removed. Feed, search, provider and bell tests cover the shared UI and read state.
