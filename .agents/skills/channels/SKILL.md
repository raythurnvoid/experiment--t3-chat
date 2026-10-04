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
get a per-thread `threadSequence`. A retry uses the author's `clientMessageId` and returns the same
message without another counter or inbox write. Threads use their root message id in public doors,
URLs, and document marks. A reply cannot start another thread.

Inline replies target the same channel. A stored quote must be a substring of the target's plain
text. `channels_markdown_to_plain_text` uses the editor's shared Markdown reader. On read, drop a
quote that an edit removed. Deleted targets show a deleted notice. File attachments are shaped per
viewer; an unreadable file returns no file id, name, or path. Do not return raw attachment ids beside
the safe fields.

Authors edit with `expectedRevision`. Edits never notify or create new followers. Removing a mention
deletes only its mention inbox item, keeping a separate inline-reply item. Authors and managers can
delete under their channel rules. Deleted messages disappear, except a root with live replies keeps
a tombstone. Counts and inbox items leave in the delete transaction. Reaction docs drain in bounded
jobs. A deleted empty root loses its thread immediately; follower cleanup continues in batches when
there are more than 100 followers.

People mentions are unique user ids, at most 50. Each person must currently read the channel.
An owner who only reads a private/direct channel cannot be mentioned. Refusals never reveal another
workspace's profile name. Notifications use `channels_inbox` only. Inline reply authors also receive
an item when they still have access. Thread authors, reply authors, mentioned people, and inline
reply targets follow automatically. Unfollowing retains their read position.

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
params. Missing and hidden ids show the same notice. Browse lists public channels.

Activity lists current mention and inline-reply inbox items. Threads lists followed roots by
latest activity. Search keeps text, channel, person, attachment and UTC date filters in the URL.
All three use checked message previews and Open context. Posts and replies open their thread.
Opening a feed never marks its items read; visible channel and thread content advances the
existing read positions. Keep Load more after an empty readable page when a cursor remains.

`AppChannelsProvider` owns the followed-channel states, inbox and threads for each membership.
The main Messages dot and `(N) Press` title count followed channels with unread mentions, even
while Files is open. Channel row bold follows all/mentions/none. Activity, Threads and the bell
show unread loaded-item counts, with `+` while older pages remain. These are not history totals.
The bell reuses Activity and its inbox; Dismiss jobs and invites keeps the old archive writes.
There is no second notification producer or message-item read flag.

UI modules live in `src/components/channels`. The sidebar has starred channels, public/private
channels, direct conversations, and followed files. Settings and member actions follow the backend
permissions. Private and direct headers disclose the owner read rule. Narrow screens use a channel
drawer and replace the main pane with the thread. Lists have named landmarks and message ids.

`ChannelsComposer` is shared with Files comments. People chips store neutral Markdown positions
with ids in `mentionUserIds`. Render names from current profiles. The sender's local draft keeps raw
chip ids so it can restore them. Enter chooses a suggestion before sending; Shift+Enter adds a line.
Escape closes a suggestion first, then cancels reply/edit. Empty Up edits the latest own message.

The `@` popup includes people and saved files or folders. Load the full readable tree only while
the popup is open. Exclude archived nodes and private drafts. Search by name or path and cap the
combined list at 50. Messages and Files Comments use this same popup and composer.

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
thread's current activity time. The thread doc supplies the exact unread count during that sync.

`list_my_threads` and `list_my_inbox` read at most 50 docs per page and re-check current channel
access before returning any item. Inbox unread state comes from channel and thread read positions.
A broadcast is unread only while both positions are behind it. A post root uses the follower's
`pendingRootMention`, so visiting the channel cannot clear it. Deleted messages have no inbox item.

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

The shared composer owns existing Files attachments, the Upload files button, paste and drop.
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
`onConflict: fail`. The new copy follows Files write rules, storage limits and its own charge.
This copy uses browser memory for the downloaded blob.

# Cleanup and checks

Organization removal and user finalization drain members, reads, followers, and inbox. Keep messages,
reactions, and channel uploads as workspace content. Member deletion lowers `memberCount` in
the same transaction. Workspace purge deletes children before parents through tenant indexes.
See [Data deletion](../data-deletion/SKILL.md) and [Tenancy](../organizations-tenancy/SKILL.md).

Focused tests live in `convex/channels.test.ts` and `convex/channels_uploads.test.ts`. Run through Vite Plus:

`vp env exec pnpm --dir packages/app exec vitest run --project convex convex/channels.test.ts`

Files uses the channel door for every saved file. The old comment table, doors, composer, and orphan
attribute are removed. Feed, search, provider and bell tests cover the shared UI and read state.
