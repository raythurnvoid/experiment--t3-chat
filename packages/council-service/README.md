# Bonobo Council service

The Cloudflare Worker behind the Council meeting plugin. It creates provider meetings, mints guest
tokens, serves the public meeting room on its own origin, and turns a finished meeting into a
recording, a transcript, and a structured meeting summary in the workspace.

The meeting lifecycle, room security model, webhook intake, Queue consumer,
processing/deletion Workflow, and cleanup cron are implemented and tested. The current source has
migrations `0001` through `0008`. Remote D1 has those eight files. `0006` still refuses to run on a
new database that already has artifact rows — follow the drain rule in the release gate before you
apply it there. Do not wipe D1.

Comments and migrations in this package say "Plan 2". That names the host's plugin document store,
`packages/app/convex/plugins_data.ts`, which this Worker reaches through the `/api/v1/plugin-data/*`
routes. It stores at most 16 KiB per document value, and that 16 KiB is the envelope one meeting
projection reserves.

## How the transcript names speakers

RealtimeKit's own post-meeting transcript cannot say who spoke. Every segment comes back with the
literals `TEST`, `unique_id`, `user_id`, and `custom_participant_id` in `peerData`, while the session
participant endpoint reports the real names for that same session. The words are right and only the
speaker is wrong.

Council starts a **composite** recording (`POST /recordings`). The provider bot writes one mixed
video and one mixed audio file. Those files stay in the provider's managed bucket for seven days,
so Council has to fetch and copy them. That copy is what the Workflow is for — Workers give a step
unlimited wall-clock but cap persisted state, so a step streams the bytes into the app's presigned
upload URL and returns only a small record, never the bytes.

The mixed audio has no speaker id. `src/tracks.ts` labels every line **Meeting**. It does not guess
a speaker from the names people typed in the room.

Older meetings used per-speaker **track** recording. That path hung live on long calls
(`UPLOADING`, duration 0, no files). Composite is the current start path because it is a different
recorder. Track file names still work in the pipeline so an older recording can finish.

When the provider still publishes per-speaker track files, identity comes from the file name:

1. Council generates the durable participant id and sends it as `custom_participant_id` to Add
   Participant.
2. Add Participant returns a separate provider id in `data.id`. Council stores it as
   `providerParticipantId` on the same participant record.
3. Track recording writes one audio file per participant and puts that provider id into the file name,
   `{prefix}_{userId}_{peerId}_{streamKind}_{mediaKind}_{unixMs}.webm`.
4. `src/tracks.ts` parses the name from its end, matches `providerParticipantId`, and emits the
   durable Council participant id. It drops any track whose provider id matches no participant
   rather than guessing the nearest one.

The template calls this filename field `userId`, but it is not Council's `custom_participant_id`.
The live provider run proved that it is the Add Participant response `data.id`.

A track whose speech is attributed by position rather than by that provider id fails the tests in
`src/tracks.test.ts`, which is the point of them.

## Route surface

Three origins, one Worker:

Page API (`POST`, CORS locked to `COUNCIL_PLUGIN_ORIGIN`, bearer `plu_` page token exchanged
through Convex; requires `CF-Connecting-IP`):

The exchange is the only Convex call a caller with no account can reach, so it is bounded per client
address (`page_exchange_ip`, 60 per 30 minutes) and spent only when the token misses
`page_token_cache`. Ordinary polling is served from that cache and never counts against the bucket.
Over it these routes answer 429; without `CF-Connecting-IP` they answer 400 unless
`COUNCIL_ALLOW_MISSING_CLIENT_IP` is `"true"`.

- `/api/meetings/create` — reserve the projection's document-store envelope, create the provider
  meeting, return the join code once. This books plugin-data bytes only; file storage is not booked
  anywhere. A full plugin-data store refuses the reserve; `convex-api.ts` names that refusal
  `data_store_full` (distinct from the pipeline's `storage_full`, which is the workspace file-storage
  quota), and create answers 403 telling the member to delete old meetings — freed space can take up
  to a day to come back, because a deleted document's slot stays held by a retry tombstone.
- `/api/meetings/list`, `/api/meetings/get` — D1-backed views with artifacts.
- `/api/meetings/open` — seal the processing grant to the meeting folder, then set the deadline and
  open admission. Nothing is booked here: the workspace is charged per file, when the pipeline
  creates it.
- `/api/meetings/room-ticket` — mint a one-time host ticket for the room origin. The ticket stores
  the exact interactive grant that authorized it; another page exchange must not change which
  grant this room later verifies.
- `/api/meetings/close` — close admission, STOP the recording while the session is still live,
  then kick everyone. Session end can stop a composite recording, but a stop after kick-all hung
  track recordings live, so close still stops first. With a recording, hand the meeting to
  processing (the grant
  already exists from open; the pipeline's discover poll repeats the stop until the recording
  leaves `RECORDING`, so a refused stop only costs poll attempts, while a recording the provider
  marks `ERRORED` fails the meeting on the first read instead of waiting the poll budget out).
  Without a recording,
  close settles the meeting straight to `ready`: nothing else would ever transition it, and the
  plugin page polls `closed` as transitional.
- `/api/meetings/delete` — seal a FRESH processing grant from the requesting member's live grant
  (the open-time one has a fixed six-day life) and start the delete workflow. Refused while the
  meeting is `processing`.

Room API (`POST`, same-origin only, `__Host-` cookie session):

`/room/api/session` and `/room/api/guest-session` hand the session out together with its CSRF token,
so neither one requires an `X-Council-Csrf` header. The four in-call routes below do require it:
they are the only callers of `room_session_auth`, which checks the cookie and the header on every
call.

- `/room/api/session` — trade a one-time host ticket for a session. A host session keeps the
  ticket's exact service-grant id; a guest session has no actor grant.
- `/room/api/guest-session` — trade the meeting code for a guest session (IP, code, and
  installation rate buckets; requires `CF-Connecting-IP`).
- `/room/api/join` — mint the provider token (slot cap 25, verify-live fail-closed, idempotent
  replay). A host verifies the exact grant stored on their room session, never the newest grant for
  that actor.
- `/room/api/state` — the meeting view the room polls.
- `/room/api/host/start-recording` — host only; verify the room session's exact actor grant, then
  start a composite recording with the meeting-length cap. The
  recording id is attached only while the meeting is still `open` with no recording — a close (or a
  second start) can land while the provider answer is in the air, and close stops only the id it
  finds in the row. A refused attach stops the just-started recording itself and answers 409.
- `/room/api/host/close` — host only; same close path as the page API. It deliberately skips the
  actor recheck so a removed member can still stop and close a provider meeting they already
  opened. The answer carries `recorded` — the server's read of the recording id after admission
  closed — and the room prefers it over its own recording stage when telling the host whether
  files are coming.

Other:

- `GET /room` — the meeting room page (HTML from `src/room/page.ts`, strict CSP).
- `POST /webhooks/realtimekit` — RSA-SHA256 verified intake, fail-closed without a configured key.
- `GET /health`.

Working on the room page:

- `src/room/client.ts` is one large template string that the page embeds, so `tsc` never checks its
  body and prettier never formats it. The tests in `client.test.ts` are the only gate on that code —
  a clean typecheck says nothing about it.
- Every `client.ts` change must bump `ROOM_REVISION` in `src/room/page.ts`, and the check ends by
  reading the marker back from the served page (a bumped constant proves the edit, the served marker
  proves the running Worker picked it up):

```bash
curl -s "http://127.0.0.1:8787/room?m=qa" | grep -o 'council-room-revision" content="[^"]*"'
```

Room controls: Microphone, Camera, **Share**, Participants, Start recording (host), End for all
(host), and Leave. Share is a toggle named `Share` in both states. Guests may share. The room
allows one share at a time and refuses a second with a line that starts
`Screen share unavailable.` If two shares still appear (the provider may accept more than one),
the room shows the newest share this browser saw and a note that says
`Showing the most recent share`. That note is not a server rule. Tab audio from a shared tab
plays through the same Play audio recovery as remote microphone audio. The camera is unchanged.
The consent line says shared screens are captured in the recording.

## Meeting states

`created → open → closed → processing → ready | failed` (an unrecorded meeting goes
`closed → ready` directly), plus:

- `create_unknown` / `recording_start_unknown` — the provider answer was lost. Never auto-retried;
  a second create or start-recording could double the resource. Unopened meetings expire after a
  day. An unknown-recording meeting still closes, but it stores no recording id, so nothing is
  processed; whatever the provider recorded is an operator-repair case.
- `expired` — a created meeting nobody opened within a day.
- `deleting → deleted_tombstone | delete_failed` — the delete workflow. Delete is refused while a
  meeting is `processing` — it would race the running pipeline — and allowed again at `ready` or
  `failed`. The tombstone refuses late webhooks for eight days, then the cron erases the row
  entirely. `delete_failed` retries hourly with a fresh work generation while the sealed delete
  grant is alive; once that grant dies, retries stop and a member's next delete from the page
  seals fresh authority.

Transitions are enforced twice: a static map in `src/db.ts` and a guarded
`UPDATE ... WHERE status IN (...)` so racing writers cannot skip a state.

## Outbox design

Two outboxes in D1, both written in the same atomic batch as the state change that requires them:

- `event_outbox` — one row per (meeting, kind, generation) of Workflow work. A dispatcher sends a
  pointer message to the Queue and marks `handoff_pending`; the consumer creates the
  deterministically named Workflow instance (`council-<kind>-<meetingId>-g<generation>`), persists
  the association, and only then acks. Lost sends, lost acks, and dead instances are re-driven by
  the cron; DLQ messages mark the row `dead` for operator redrive.
- `projection_outbox` — ordered, monotonic revisions of the display-safe meeting document,
  delivered through the Convex `write-versioned`/`delete-versioned` routes. A revision the receiver
  already applied is treated as delivered; a delete supersedes every pending older revision.

D1 stays authoritative. The projection is never read back for a service decision. The current
Council page also reads the Worker directly; writing this Convex document does not make it appear in
another host screen by itself. The host copies each public meeting document into
`/meetings/<meetingId>/meeting.md` so the Files tree and the workspace agent can see the meeting
even when no recording uploaded. That note is derived: the store stays the source of truth, and the
file never holds a join code, guest secret, or host ticket. Recordings still land in the same folder
only after a successful service upload. The Convex document gives the host and future plugin UI a
safe, installation-owned copy with no meeting code, ticket, email, token, admission secret, or
provider URL. A leftover track artifact still carries the provider's own file name, because that is the
name the file has in the workspace, and the provider builds that name from the participant's
provider and peer ids. Current composite files use the fixed names `recording.mp4` and
`recording-audio.m4a`. A finished recorded meeting folder is meant to hold those two files plus
`transcript.md`, `summary.md`, and `provider-transcript.json` when the provider published one.
`provider-transcript.json` is best-effort: the pipeline continues without it. Do not rename the
two recording files. The Council dashboard still shows both composite files as one Recording
badge (`plugins/bonobo-plugin-council/src/app.tsx`).

A 60-minute composite video measured about 144–187 MiB in the 2026-08-27 provider probe
(low-motion, about two-minute samples). The host upload cap is now 2 GiB
(`files_MAX_UPLOADS_BYTES`). That probe fits. Cloudflare's published 720p live-stream
worst case is 2.7 GB per hour, which is past 2 GiB at 48 minutes. Create still accepts
the 60-minute product default. If the configured length would overflow even at that
pessimistic rate, the Worker logs an error and continues. The checked-in Worker var is 60.

If a recording file is still over the cap at upload time, create-target answers 400
`File too large`. The pipeline marks that artifact `failed` with
`recording too large to store: N MiB over the limit`, does not retry that target, and
lets the rest of the run finish so the meeting can reach `ready`. The card and
`meeting.md` then carry a fixed sentence: the video was too large to store, and the
audio file was still saved. Do not promise a speech transcript or summary —
composite audio crosses the 24 MB Whisper cap at about 17 minutes. The badge list
still shows only finalized files, so a saved audio file still makes one Recording
badge. Operators read `meeting_artifacts.failure_reason` for the exact overflow.

Apply `0009_artifact_failure_reason.sql` before the Worker that writes that column.
Deploying the Worker first makes an over-cap recording throw on the missing column
and fall back into retry. The dashboard sentence needs a plugin publish. `meeting.md`
needs the Convex projection change.

The mixed audio in that same probe was about 83 MiB per hour, which is over the 24 MB
transcription read cap at about 17–18 minutes. See "Composite transcript path" below.
Do not raise the 24 MB cap here.

## Council 0.2.0 release gate

This is the operator runbook. Run every command through Vite Plus. Never print secrets, provider
tokens, download URLs, join codes, or host room links.

The checked-in `COUNCIL_MAINTENANCE` value is `false`. A cutover deploy may override it to `"true"`
so `/api/meetings/create` refuses new meetings. The bridge does not close already-created meetings.
A `created` meeting can still be opened while the bridge is on, and each open seals a fresh
processing grant.

Source work alone does not authorize these remote actions. Run them only after an explicit release
request.

### Live state on 2026-08-27 (read this before repeating work)

These items already landed. Do not redo them:

- Remote D1 has `0001` through `0009`. `0006` already rebuilt `meeting_artifacts` and added
  `meeting_summaries`. `0007` added the join-attempt columns. `0008` dropped unused
  `meeting_tracks.participant_id` and `meeting_tracks.start_offset_ms`. `0009` added
  `meeting_artifacts.failure_reason`.
- Ten meetings are `ready`. Two meetings are `deleted_tombstone`. No meeting is `created`,
  `open`, `closed`, `processing`, or `deleting`.
- Those ready meetings still have finalized artifact rows. **Do not delete them.** `0006`
  already ran. A later drain would only hide files the dashboard already shows.
- Council plugin `0.2.2` is published (`sourceCommitSha`
  `ce8906c7a9f8001e41bf965aea789512af3a68d6`). The parent gitlink matches. The SDK pin
  resolves to `0.9.2`. Do not publish a second copy.
- The installs that run live meetings already accepted `workspace.files.create-read-only`
  and are on `0.2.2`.
- The host upload cap is 2 GiB on the Convex deployment. The checked-in Worker var
  `COUNCIL_MEETING_MAX_MINUTES` is `60`. `GET /room` serves `council-room-r32`.
  Leave `COUNCIL_MAINTENANCE` as `"false"`.

A later room-client fix is live as `council-room-r32`. Chrome's Stop sharing bar now clears the
Share button `aria-pressed` state, and a failed in-app stop no longer names the screen-share
permission.

Update 2026-08-30:

- The Worker serves the custom domain `https://council.bonobo-senate.com` beside the workers.dev
  host (`routes` + `workers_dev: true` in `wrangler.jsonc`). Ticket and guest URLs follow whichever
  host served the request. The provider webhook target still points at the workers.dev host, so do
  not turn `workers_dev` off.
- Council plugin `0.2.3` (`sourceCommitSha` `7496551eacff664d1a9ee832cba42c24f8078498`) moves
  `COUNCIL_SERVICE_ORIGIN` and the manifest `uiOutboundOrigins` to the custom domain. Updating an
  installation to it asks to re-accept that origin.

### 1. Probe the live Worker and D1 (read-only)

Compare the served room marker with `ROOM_REVISION` in `src/room/page.ts`:

```bash
curl -s "https://bonobo-council-service.ray-thurne-void.workers.dev/room?m=qa" | grep -o 'council-room-revision" content="[^"]*"'
```

List applied migrations, meeting counts, and artifact counts. Never select `upload_body`, tokens,
or provider ids:

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "SELECT name FROM d1_migrations ORDER BY name;"
```

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "SELECT status, COUNT(*) AS n FROM meetings GROUP BY status ORDER BY status;"
```

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "SELECT kind, status, COUNT(*) AS n FROM meeting_artifacts GROUP BY kind, status ORDER BY kind, status;"
```

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "PRAGMA table_info(meeting_tracks);"
```

A first `d1 execute --remote` in a session can fail with Cloudflare `7403` even when
`wrangler whoami` shows `d1 (write)`. Retry the same command once. If it still fails, query D1
through the Cloudflare API (`POST /accounts/<account>/d1/database/<id>/query`) with the same SQL.

### 2. Stop creates only when work is still in flight

Turn the bridge on when any meeting is `created`, `open`, `closed`, `processing`, or `deleting`,
or when `0006` has not been applied yet.

Apply `0009` before any deploy of this source, including this maintenance deploy. This
Worker writes `meeting_artifacts.failure_reason`. If that column is missing, an
over-cap recording that is already processing throws and stays in retry.

Then deploy the **same final source** with the var override. Do not commit `"true"`:

```bash
vp env exec pnpx wrangler deploy --config packages/council-service/wrangler.jsonc --var COUNCIL_MAINTENANCE:true --message "Council maintenance on"
```

Prove create is closed from the plugin page (the create form shows the maintenance message). Then
finish the audit.

If every meeting is already `ready` or `failed`, and `0006` is already in `d1_migrations`, skip the
override. Deploy the checked-in config once (step 5).

### 3. Drain only for a first `0006` apply

`0006` refuses to run while `meeting_artifacts` has any row. Old create-target bodies also lack the
strict host flags, so those rows cannot be replayed. Erase the D1 artifact rows **only when `0006`
is not in `d1_migrations` yet**. Close or fail any `processing` meeting first. Then:

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "DELETE FROM meeting_artifacts;"
```

Read the count back. It must be `0` before you apply `0006`. Do not run that delete after `0006`
has already succeeded.

### 4. Apply pending D1 migrations

For the recording-cap Worker, apply `0009` here before step 5. That Worker writes
`meeting_artifacts.failure_reason`. If the column is missing, an over-cap recording
throws and the run stays in retry.

```bash
vp env exec pnpx wrangler d1 migrations apply bonobo-council --remote --config packages/council-service/wrangler.jsonc
```

Non-interactive Wrangler answers `yes` to the availability prompt. Read the migrations and
`PRAGMA table_info(meeting_tracks)` back. After `0008`, that table must not list `participant_id`
or `start_offset_ms`. An applied migration is not the same as a served schema — always read back.

### 5. Deploy this Worker

Required secrets already exist on `bonobo-council-service`. Do not put them again.

```bash
vp env exec pnpx wrangler deploy --config packages/council-service/wrangler.jsonc --message "Council room screen share"
```

Prove the live document, not the local constant:

```bash
curl -s "https://bonobo-council-service.ray-thurne-void.workers.dev/room?m=qa" | grep -o 'council-room-revision" content="[^"]*"'
```

If you turned maintenance on in step 2, deploy the same source again **without** `--var` after
capability consent, so the checked-in `"false"` is what the Worker serves. Then create still works
for the smoke.

Do not run `wrangler tail` on this Worker while a meeting is `processing`. Enabling tail can reset
the Workflow Durable Object.

### 6. Plugin, SDK, and capability

Confirm the pin, then stop if it already matches:

- `plugins/bonobo-plugin-council/package.json` points at SDK commit
  `d32091deb17af467229ba980b73b2b09c01d4eaa`.
- `pnpm-lock.yaml` in that repo resolves that commit to version `0.9.2`. Do not push a second
  mirror and do not re-pin Council.
- Parent gitlink `plugins/bonobo-plugin-council` equals the published `sourceCommitSha`.
- The installation's `acceptedCapabilities` includes `workspace.files.create-read-only`.

If a new plugin commit is required, follow `plugins/bonobo-plugin-council/README.md` (build twice,
`git status --porcelain` empty, push the submodule, update the gitlink, publish that SHA, then
accept the new capability). A CLI install does not refresh an open plugin frame — reload the
Council page.

### 7. Live share smoke

Drive the Council **dashboard** from the signed-in app tab. Drive **Join** in two scratch Chromes.
Do not Join from the reserved QA Edge profile: the microphone permission prompt wedges
`getUserMedia` there.

Use a workspace on **Pay As You Go** or **Pro**. Anonymous and Free workspaces refuse service
uploads with 403, and the meeting then fails even when the provider recorded files.

1. Create a meeting from the Council plugin. Copy the join code and guest link before
   `Done, I saved the invite`. The service cannot show the code again.
2. Select **Open meeting**. Then **Get host room link**. The host link is single-use and lasts two
   minutes — mint it only when the host scratch Chrome is ready.
3. Join as host and as guest in the two scratch browsers. Confirm Share is visible, named Share,
   and starts unpressed.
4. Guest shares a tab with readable text and some motion. The presentation area shows that share.
   The host hears tab audio if the guest shared it.
5. Host presses Share while the guest is still sharing. The status line starts with
   `Screen share unavailable.` and says someone else is already sharing. The guest share stays on
   screen.
6. Guest stops. Host shares. The refusal line clears. The presentation area shows the host share.
7. Start recording. Keep the share up for at least one minute. End the meeting.
8. Poll D1 `meetings.status` until `ready` or `failed`. Do not reload the dashboard to force that
   change. After processing, the meeting folder has `recording.mp4`, `recording-audio.m4a`,
   `transcript.md`, `summary.md`, and `provider-transcript.json` when the provider published one.
9. Open `recording.mp4`. The shared screen is visible and the 720p text is readable.
10. Open `transcript.md` and `summary.md`. They are usable. A meeting longer than about 18 minutes
    may note a rejected audio file because of the 24 MB transcription cap. That is expected. Do
    not raise the cap here.

Then create one more meeting and confirm create is still open.

### 7a. How to drive that smoke without guessing

Do this on the GitHub Pages dashboard
(`https://raythurnvoid.github.io/experiment--t3-chat/w/personal/home/plugins/council/pages/council`).
`localhost:5173` is often down. Do not start `pnpm run dev`. Do not Join from the reserved QA Edge
profile.

**Create and invite**

- Put a host-page listener on `/api/meetings/create` *before* you press Create, and park
  `{meeting, joinCode, guestUrl}` on session `state`. Never print those values. The meeting id is
  the one reportable field.
- Do not `fill()` the title box. Click it, `Control+A`, then `pressSequentially`. `fill()` can hang
  inside the Convex `plugins-ui` iframe until the CLI timeout. The submit button is named
  `Create meeting`, not `Create`.
- The one-time join code lives in `section.created-panel`, not in `li.meeting`. The row only rebuilds
  the guest link. Reading the row first looks like the code is gone.
- On this GitHub Pages host, `navigator.clipboard.writeText` from `page.evaluate` can hang until the
  timeout. Copy with a textarea and `document.execCommand("copy")` on the host page. Scratch Chrome
  may only *read* the clipboard, on the Worker origin.

**Scratch Chromes**

Launch system Chrome, not Playwriter's chrome. Use a fresh `--user-data-dir` and a new CDP port
(9223 is often already taken). Park each browser on `/room?m=qa` so you can grant microphone and
clipboard-read on the Worker origin before you assign the real URL.

```text
--use-fake-ui-for-media-capture
--use-fake-ui-for-media-stream
--use-fake-device-for-media-capture
--use-file-for-fake-audio-capture=<speech.wav>
--autoplay-policy=no-user-gesture-required
--auto-select-tab-capture-source-by-title=<fixture-tab-title>
```

Do not also set `--auto-select-desktop-capture-source`. That flag is a substring match. When nothing
matches, Chrome 151 on this machine picks a whole monitor. The 2026-08-27 run captured DISPLAY1
(`1680x1050` at `X=-1680`), not the titled tab, even with the tab-title flag. RealtimeKit
`enableScreenShare()` follows that desktop-capture path.

To make the live share show the fixture anyway:

1. Serve a page whose `<title>` is unique, with huge readable text and a ticking counter.
2. Open that page in the guest Chrome.
3. After Share is pressed, read the host `#share-video` size. If it matches a monitor
   (`1680x1050` here), the picker took a screen.
4. List Windows screens. Move the fixture Chrome onto the captured monitor. Pin it topmost
   (`HWND_TOPMOST`) so it sits above whatever else is on that display. Unpin when the meeting ends.
5. Prove the host stage shows the fixture text *before* you start recording. A share of the wrong
   screen fails the gate.

The host ticket lobby can require `#host-name` when the ticket has no display name
(`hostNeedsName`). Fill it before Join. The guest Continue button is `#guest-submit`.

Mint **Get host room link** only after the host Chrome is up. The ticket lasts two minutes and is
single-use. `page.waitForFunction` returns a JSHandle, not a string — read the input with
`evaluate` after it appears. Do not click Get host room link again if the first click already
minted; that would replace the ticket.

**After End meeting**

Poll D1 by title only:

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --json --command "SELECT status, title FROM meetings WHERE title LIKE 'Share smoke%' ORDER BY created_at DESC LIMIT 5;"
```

Do not select `upload_body`, tokens, or download URLs. Do not run `wrangler tail` while status is
`processing`. Do not reload the dashboard to force the change. Processing often takes a few
minutes.

Playwriter recipes for the dashboard, clipboard handoff, and room controls live in
`.agents/skills/app-playwriter-harness/references/plugin-marketplace.md` (Council sections) and
`references/council-room.md`.

## Commands

Run every command through Vite Plus so it uses the repo's pinned Node.

```bash
vp env exec pnpm --dir packages/council-service run test
```

```bash
vp env exec pnpm --dir packages/council-service run typecheck
```

```bash
vp env exec pnpx wrangler d1 migrations apply bonobo-council --remote --config packages/council-service/wrangler.jsonc
```

Reading the remote schema back, because an applied migration is not the same as a served one:

```bash
vp env exec pnpx wrangler d1 execute bonobo-council --remote --config packages/council-service/wrangler.jsonc --command "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;"
```

## Cloud resources that already exist

| Resource          | Name                        | Note                                                                                                                                       |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker            | `bonobo-council-service`    | Deployed at `https://council.bonobo-senate.com` (custom domain) and `https://bonobo-council-service.ray-thurne-void.workers.dev`           |
| D1 database       | `bonobo-council`            | `b32e1b59-11ad-4086-9c92-72480e820e16`, region WEUR, migrations `0001` through `0008` applied to remote. Do not re-apply `0004`–`0008`. |
| Queue             | `bonobo-council-events`     | 8-day message retention; consumer on this Worker, `max_batch_size` 1, `max_retries` 5                                                      |
| Dead-letter queue | `bonobo-council-events-dlq` | 8-day message retention; consumed by this Worker to mark outbox rows `dead`                                                                |
| Workflow          | `bonobo-council-workflow`   | Binding `COUNCIL_WORKFLOW`, class `CouncilWorkflow`; created on first deploy                                                               |
| Workers AI        | binding `AI`                | Whisper Turbo per-track transcription and Llama 3.1 8B fast structured summaries                                                           |
| Cron              | `*/15 * * * *`              | Expiries, deadline closes, processing retries, outbox and projection reconciliation, delete retries, tombstone erasure                     |

## Secrets

The Convex-side settings belong to the confirmed development deployment `grand-finch-267`. Set them
directly; these commands do not deploy Convex code:

```powershell
vp env exec -- pnpm --dir packages/app exec convex env set COUNCIL_PLUGIN_NAME council --deployment grand-finch-267
vp env exec -- pnpm --dir packages/app exec convex env set COUNCIL_SERVICE_EXCHANGE_SECRET --deployment grand-finch-267
```

The second command prompts for the value, so it does not put the secret in shell history. Keep that
value: the first Worker deployment needs the same `COUNCIL_SERVICE_EXCHANGE_SECRET` below.

`COUNCIL_PLUGIN_NAME` is a non-secret Convex setting and must be exactly `council`. Do not add it as a
Wrangler secret. Convex deployment settings and Wrangler secrets are separate stores; setting one
does not set the other.

For the first deployment on a new account, `wrangler secret put` cannot set secrets before the Worker
exists. Create a dotenv file outside the repository instead. It must contain all five required Worker
secrets, must never be committed, and should be readable only by your Windows account. This
PowerShell example creates and protects the file before opening it:

```powershell
$councilSecretsFile = Join-Path $env:USERPROFILE ".bonobo-council-first-deploy.env"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType File -Path $councilSecretsFile -ErrorAction Stop | Out-Null
icacls $councilSecretsFile /inheritance:r /grant:r "${currentUser}:(F)"
notepad $councilSecretsFile
```

Replace every placeholder before saving the file:

```dotenv
COUNCIL_SERVICE_EXCHANGE_SECRET=<same value entered in Convex>
REALTIMEKIT_API_TOKEN=<value>
REALTIMEKIT_ACCOUNT_ID=<value>
REALTIMEKIT_APP_ID=<value>
COUNCIL_ROOM_COOKIE_SECRET=<value>
```

Deploy once with that file, then delete it even if the deploy fails:

```powershell
try {
	vp env exec pnpx wrangler deploy --secrets-file $councilSecretsFile --config packages/council-service/wrangler.jsonc
} finally {
	Remove-Item -LiteralPath $councilSecretsFile
}
```

After the Worker exists, rotate one secret with the interactive
`vp env exec pnpx wrangler secret put <NAME> --config packages/council-service/wrangler.jsonc`
command. `wrangler.jsonc` lists every required name under `secrets.required`, so a later deploy also
fails if any required secret is absent.

- `COUNCIL_SERVICE_EXCHANGE_SECRET` — must equal the value Convex holds. It is what
  `/api/internal/plugins/service-grants/exchange` checks before it looks at the page token.
- `REALTIMEKIT_API_TOKEN`, `REALTIMEKIT_ACCOUNT_ID`, `REALTIMEKIT_APP_ID` — the provider REST calls
  go to `https://api.cloudflare.com/client/v4/accounts/{account}/realtime/kit/{app}/...` with
  `Authorization: Bearer <token>`. The older `api.realtime.cloudflare.com/v2` host with Basic auth is
  the legacy Dyte API and is not what this Worker speaks.
- `COUNCIL_ROOM_COOKIE_SECRET` — derives the keys that encrypt stored grant and provider tokens at
  rest, and the key for the email HMAC (AES-GCM, purpose-scoped derivation). Despite the name it does
  **not** sign the room session cookie: that cookie is a random token stored as an unkeyed SHA-256 in
  `room_sessions.token_hash`. So rotating this secret does not end a single live room session, and it
  does make every stored grant and provider token undecryptable. Do not reach for it as a way to log
  everybody out.

  After a rotation, whether a route recovers depends on which grant it verifies. The docblock on
  `council_verify_meeting_grant` in `src/grants.ts` splits the routes the same way.

  A route that verifies the caller's own grant repairs itself. The stored grant can no longer be
  decrypted, so `council_verify_grant` answers `grant_dead`. `council_page_auth` treats exactly that
  name as "exchange the member's page token again", and that exchange seals a new grant under the new
  secret. It only runs once the one-minute liveness window (`PAGE_TOKEN_CACHE_MS`) since the last
  Convex answer has passed. So the page close, the host room ticket mint, and the seals behind open
  and delete refuse for at most that minute and then work again.

  A route that verifies the meeting's pinned grant does not repair itself. Join and start recording
  answer 409 "The meeting's authority is no longer live", and nothing re-pins an already-open
  meeting. `handle_open` refuses any status other than `created`, and it is the only place that
  re-pins `service_grant_id` after create. So an open meeting keeps refusing both for the rest of its
  life.

  The room host close is the one route a rotation never blocks. It verifies no grant at all, on
  purpose. The host cookie is the proof they were admitted, and refusing there would strand everyone
  already in the call. The page close is a separate route, and it sits in the first group above.

  Plan a rotation for a window with no open meetings. An open meeting cannot be repaired. Close it
  and create a new one.

Non-secret vars worth knowing (`wrangler.jsonc` `vars`):

- `REALTIMEKIT_WEBHOOK_PUBLIC_KEY` — the provider's RSA public key (SPKI PEM). Empty means the
  webhook route answers 503 for every delivery: fail closed, never unverified.
- `COUNCIL_DESTINATION_PATH_PREFIX` — where artifacts land in the workspace
  (`<prefix>/<meetingId>/...`).
- `COUNCIL_ALLOW_MISSING_CLIENT_IP` — `"true"` only in local testing. In production both doors that
  key a rate bucket on the caller's address need the `CF-Connecting-IP` edge header: the guest join
  (`guest_join_ip`) and every page API call (`page_exchange_ip`). Either one answers 400 without it.
  Setting this `"true"` keys both buckets on the literal `loopback`, so every caller shares one.

## Convex file surface

Council never stores or logs a raw code, ticket, session token, CSRF token, guest email, or
provider URL — hashes and HMACs only — and every Convex HTTP call lives in one adapter,
`src/convex-api.ts`. The file surface is the real service-uploads contract (see the app repo's
`public-api` skill):

- `/api/internal/plugins/service-grants/seal-processing` — trades the live interactive grant for a
  processing grant sealed to `/meetings/<meetingId>` (canonical lowercase prefix), carrying
  `files:write`, expiring six FIXED days after the seal. Renew rotates the token, never the expiry.
- `/api/v1/files/service-uploads/create-target|remint|finalize|archive-destination` — bearer is the
  processing `psg_` grant alone. Strict JSON bodies; a replayed `idempotencyKey` answers only for an
  identical body, so each create-target body lives in `meeting_artifacts.upload_body` and replays
  re-send the stored bytes. The upload key itself is derived (`council-uploads-<meetingId>`), so a
  crash cannot lose it.

The lifecycle this implies (plan-3 E8):

1. **Open** seals the grant to `/meetings/<meetingId>` and opens admission. No storage is claimed.
2. **Processing** streams each artifact through create-target → signed PUT (exactly the returned
   headers) → finalize, polling finalize with bounded backoff until the storage event settles as
   `committed`. Every call carries the same derived key, `council-uploads-<meetingId>`, and
   `targetKey` names one file inside that run. Create-target charges nothing and creates the file
   straight away; the workspace's plugin service storage quota is charged once, for the size R2
   confirms for the stored file. A `403` fails the run. `storage_full` means the workspace is already
   full. The host also refuses a workspace whose plan does not include service file storage at all —
   only `Pay As You Go` and `Pro` do, and an owner-billed organization answers to the owner's plan.
   Both fail the run at once (no Workflow step retries), the same way a member lock fails a delete:
   the plan does not change mid-run, and the storage counter only counts up, so every retry gets the
   same refusal back and only delays the moment the page tells the member the meeting failed. A
   create-target 400 whose message is exactly `File too large` is different when the file is a
   stored recording: that target is marked `failed` with the over-cap reason, and the rest of the
   run continues. Any other 400 still retries. Every other create-target failure still retries. The plan has to be raised, or the storage ceiling
   lifted, before a redrive can work. Reaching `ready` or `failed` releases nothing — the counter only grows. An operator redrive
   of a `failed` meeting (the cron and
   `council_request_processing_redrive` bump `processing_generation` and insert a fresh outbox row;
   moving `failed -> processing` on the same generation dispatches a row that never runs) keeps the
   same upload key on purpose: a file that never finished uploading is re-used, and files that
   already committed are skipped by their D1 status. The redrive needs the sealed processing grant
   to still be alive (six days), which stays inside the provider's seven-day recording retention.
   The validated AI summary is first rendered and stored in D1. A redrive uploads those exact
   stored bytes and does not ask the model for a second answer.
3. **Delete** (page-initiated) seals a fresh grant, archives the meeting folder, then runs the
   D1/projection/tombstone arm. The archive takes no path — the seal names the folder — and it
   removes the folder and everything inside it from the file tree in one archive operation a member
   can restore. Deleting a file in this product means archiving it, and a stored transcript is a
   real file, so the meeting delete archives the files instead of deleting them; the stored bytes
   stay charged, because the files still exist. An upload that never finished left an empty file in
   the same folder, and the archive takes that away too. It runs even when the meeting stored
   nothing, so a failed meeting does not leave its empty folder behind. A member lock or a dead
   grant fails the delete immediately (`delete_failed`, no Workflow step retries): those refusals
   will not clear themselves. A network error still retries. The delete works again once they clear
   the lock.

A track recording that stays `UPLOADING` with `recording_duration: 0` and no files after the full
poll is treated as a hang, not a slow upload. The run finishes `ready` and builds `transcript.md`
from the provider transcript when that file has sentences. A later redrive cannot add audio to
that finalized transcript. A recording that is still `UPLOADING` without duration 0 still fails,
so a redrive can pick the files up if they appear.

A redrive cannot repair an artifact that already finalized. `render_and_upload_markdown` skips a
finalized `transcript.md`, and `store_summary_markdown` skips a `meeting_summaries` row that already
exists. So a meeting whose transcript finalized as `_No speech was recorded._` keeps that text
however often it is redriven. That wording now means what it says — a meeting that really was
silent. A meeting that lost tracks to the per-track cap finalizes with a dropped-track count
instead, and that text is just as unrepairable by redrive. Repairing one means deleting that meeting's rows in
`meeting_artifacts` and `meeting_summaries` in D1 first, and only then redriving.

Every Council artifact is read-only. The text artifacts (`summary.md`, `transcript.md`, and
`provider-transcript.json`) are also non-collaborative, so they do not pay the Yjs storage and sync
cost of a shared editor document. Audio tracks are read-only too, but they are uploaded with
`nonCollaborative: false`: the host only accepts that flag for names its editable-text classifier
knows, and `.webm` is not one, so asking for it would make every `track_audio` target return 400 and
fail the run. A stored `.webm` is a binary file the editor never opens, so the flag changes nothing
for it either way. No Council service upload starts plugin upload events.

### Composite transcript path

`transcript.md` for a composite run is built from Workers AI Whisper on `recording-audio.m4a`,
not from `provider-transcript.json`.

1. `transcribe_track` in `src/pipeline.ts` downloads each discovered file. Composite video is
   skipped. Composite audio is sent to `council_transcribe_track` only when the download is at
   most `council_TRACK_TRANSCRIBE_MAX_BYTES` (24 MB) in `src/ai.ts`.
2. `load_attributed_transcript` reads rows with status `transcribed` and turns composite
   segments into Meeting lines.
3. `fetch_provider_transcript` stores `provider-transcript.json` as a diagnostic. Speaker ids
   there are still placeholder values, so those sentences are not merged into `transcript.md`.
4. The provider transcript becomes the product text only when track files never arrived
   (`filesNeverPublished`) and attribution has no lines. That is the hang / missing-files
   fallback. A composite file that existed and was rejected for size does **not** take that
   fallback. The document then carries the dropped-track sentence and no speech lines.

The 2026-08-27 probe measured about 1.38 MB/min of composite audio (~83 MB/hour). 24 MB is
about 17 minutes. A longer composite run loses Whisper text for that file. The raw audio can
still land in the folder when it is under the 2 GiB upload cap. This cap is a Workers memory
ceiling, not an upload ceiling. Do not raise it here. That is its own job.

One real cap to know: an upload run allows at most **16 targets**. The transcript and provider
diagnostic spend two, and the generated summary spends one, so at most 13 recording files are
stored. A composite recording uses two of those slots (the mixed video and the mixed audio) and
stores each under its real type. A leftover per-participant audio track still uses `audio/webm`.
A file that is not speech or a composite file is refused. A large meeting's extra raw audio is not
stored, and the pipeline logs when that happens.

A second cap applies per track: transcription reads at most **24 MB** of one file
(`council_TRACK_TRANSCRIBE_MAX_BYTES`), sized to the 128 MB isolate rather than to the file, because
the peak cost is about 3.3x the byte count. A track past it is marked `rejected` and **the run
continues** — so the transcript is not always complete. An hour of Opus is roughly 14 MB at 32 kbps
and 29 MB at 64 kbps, so a full-length track can land either side of this. The 2026-08-27
composite probe measured about 83 MiB of mixed AAC per hour, so a one-hour composite audio file
crosses this cap at about 17–18 minutes. Every refusal is logged
at the point it happens, and both `transcript.md` and `summary.md` carry a count of the tracks that
could not be transcribed, so neither document claims silence for audio that was recorded. If filenames have
the same provider timestamp, their names provide the stable final ordering, compared by code unit
rather than by locale collation, so a redrive always picks the same thirteen files.

The summary uses the fast Llama 3.1 8B model through Workers AI JSON Schema mode. Council treats
transcript lines as untrusted quoted data — a value may not carry the fence that marks the block it
sits in, so every `<` in a serialized transcript entry and in the serialized partials it merges is
replaced with its JSON escape `\u003c`, which leaves no `<` for `<transcript_jsonl>` or
`<partial_summaries_json>` to be built from — validates the full model response, and caps the input
at 12 chunks of 48,000 characters. That validation accepts two `response` shapes. Workers AI answers
this model's JSON Schema request with `response` already parsed into an object.
`@cloudflare/workers-types` declares a plain string for every text-generation model, so the
documented shape and the typed shape disagree. The parser takes a JSON string too and parses it
before validating.
The tokens are escaped rather than stripped by name because a
value can nest a token inside a copy of itself: a strip removes the inner copy, and the halves left
on either side join into a working token. Nesting one token inside a *different* token does not
defeat a strip, because a second pass re-reads whatever the first pass produced — so a test built on
that shape proves nothing. `ai.test.ts` carries a payload of the surviving shape for both fences. When several chunks exist it runs one reduce call held to
that same 48,000-character budget: 12 full-size partials serialize far past
it, so the partials that do not fit are dropped. If the source exceeded the chunk cap, or partials
were dropped from the reduce call, `summary.md` says that later content was not summarized.

The summary is the one step that could fail forever. The hourly cron redrives a `failed` meeting
into a new generation, and no summary row exists yet, so a model that keeps answering badly would be
asked again every hour until the sealed grant dies six days later, and the meeting would never
reach `ready` even with a good `transcript.md` in place. So Council reads the failed run's stored
`failure_reason`. Once a previous generation already failed on the summary itself, the next bad
answer stores a fixed "The summary could not be generated for this meeting." text instead of failing
again, and the run finishes. The generation number cannot decide this: a redrive bumps it for every
kind of failure, so a meeting that failed three times on an upload would spend its very first model
answer on the fixed text. Every summary failure message starts with the same two words, and
`ai.ts` says so next to the constant that builds them. The model is still asked first on every
generation, because an operator may have fixed whatever made it answer badly.

Every test here mocks Convex and the provider. The flows have also been driven end to end against
the live dev deployment and the live provider through the plugin page.
