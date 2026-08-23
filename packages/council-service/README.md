# Bonobo Council service

The Cloudflare Worker behind the Council meeting plugin. It creates provider meetings, mints guest
tokens, serves the public meeting room on its own origin, and turns a finished meeting into a
recording, a speaker-attributed transcript, and a structured meeting summary in the workspace.

The meeting lifecycle, room security model, webhook intake, Queue consumer,
processing/deletion Workflow, and cleanup cron are implemented and tested. The current source has
migrations `0001` through `0007`. Migrations `0006` and `0007` are part of the Council `0.2.0`
release gate and must follow the in-flight meeting audit described below. Do not wipe D1 or apply
release migrations without that audit.

## Why the transcript is built from track files

RealtimeKit's own post-meeting transcript cannot say who spoke. Every segment comes back with the
literals `TEST`, `unique_id`, `user_id`, and `custom_participant_id` in `peerData`, while the session
participant endpoint reports the real names for that same session. The words are right and only the
speaker is wrong.

So Council never reads identity from the transcript. It reads identity from the file name:

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

Two provider limits shape the design and are not negotiable from this side: track recording is
**audio only**, and it accepts **no `storage_config`**, so the files stay in the provider's managed
bucket for seven days and Council has to fetch and copy them. That copy is what the Workflow is for —
Workers give a step unlimited wall-clock but cap persisted state, so a step streams the bytes into
the app's presigned upload URL and returns only a small record, never the bytes.

## Route surface

Three origins, one Worker:

Page API (`POST`, CORS locked to `COUNCIL_PLUGIN_ORIGIN`, bearer `plu_` page token exchanged
through Convex):

- `/api/meetings/create` — reserve the projection's document-store envelope, create the provider
  meeting, return the join code once. This books plugin-data bytes only; file storage is not booked
  anywhere.
- `/api/meetings/list`, `/api/meetings/get` — D1-backed views with artifacts.
- `/api/meetings/open` — seal the processing grant to the meeting folder, then set the deadline and
  open admission. Nothing is booked here: the workspace is charged per file, when the pipeline
  creates it.
- `/api/meetings/room-ticket` — mint a one-time host ticket for the room origin. The ticket stores
  the exact interactive grant that authorized it; another page exchange must not change which
  grant this room later verifies.
- `/api/meetings/close` — close admission, end the provider session, and STOP the recording
  explicitly — the provider does not stop a track recording when the session ends, and its track
  files publish only after the stop. With a recording, hand the meeting to processing (the grant
  already exists from open; the pipeline's discover poll repeats the stop until the recording
  leaves `RECORDING`, so a refused stop only costs poll attempts). Without a recording,
  close settles the meeting straight to `ready`: nothing else would ever transition it, and the
  plugin page polls `closed` as transitional.
- `/api/meetings/delete` — seal a FRESH processing grant from the requesting member's live grant
  (the open-time one has a fixed six-day life) and start the delete workflow. Refused while the
  meeting is `processing`.

Room API (`POST`, same-origin only, `__Host-` cookie session plus `X-Council-Csrf` header):

- `/room/api/session` — trade a one-time host ticket for a session. A host session keeps the
  ticket's exact service-grant id; a guest session has no actor grant.
- `/room/api/guest-session` — trade the meeting code for a guest session (IP, code, and
  installation rate buckets; requires `CF-Connecting-IP`).
- `/room/api/join` — mint the provider token (slot cap 25, verify-live fail-closed, idempotent
  replay). A host verifies the exact grant stored on their room session, never the newest grant for
  that actor.
- `/room/api/state` — the meeting view the room polls.
- `/room/api/host/start-recording` — host only; verify the room session's exact actor grant, then
  start track recording with the meeting-length cap. The
  recording id is attached only while the meeting is still `open` with no recording — a close (or a
  second start) can land while the provider answer is in the air, and close stops only the id it
  finds in the row. A refused attach stops the just-started recording itself and answers 409.
- `/room/api/host/close` — host only; same close path as the page API. It deliberately skips the
  actor recheck so a removed member can still stop and close a provider meeting they already
  opened.

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
another host screen by itself. It gives the host and future plugin UI a safe, installation-owned copy
without provider ids, admission secrets, tokens, or URLs.

## Council 0.2.0 release gate

Do not deploy this source over live meeting work without an explicit audit. First stop new meeting
opens through the release maintenance bridge. Inspect every `created`, `open`, `closed`,
`processing`, `failed`, and deleting meeting plus every pending or committed upload target. In
particular, an older run may already own 14 audio targets; adding `summary.md` would make its redrive
ask for a seventeenth target. The release owner must choose migration or erasure for those exact
runs and for any stored old create-target body. Migration `0006` now refuses to run while any old
artifact row remains, so this choice cannot be skipped by mistake.

Use this coupled order after separate release approval:

1. Turn on the meeting maintenance bridge. Audit and drain every old artifact row and matching host target.
2. Apply D1 migrations `0006` and `0007`.
3. Deploy the strict core upload contract and the new read-only capability.
4. Deploy this Worker.
5. Mirror and verify SDK `0.9.2`.
6. Build Council twice, push its exact commit, update the parent gitlink, and publish that exact SHA.
7. Accept the new capability on the installation and run the create, join, close, and artifact smoke test.
8. Reopen meeting creation.

The checked-in `COUNCIL_MAINTENANCE` value is `false`. A coupled release deploys the same final
source with that value overridden to `true`, then deploys the checked-in config again only after the
capability consent and smoke test are ready.

Source work alone does not authorize any of these remote actions.

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
| Worker            | `bonobo-council-service`    | Deployed at `https://bonobo-council-service.ray-thurne-void.workers.dev`                                                                   |
| D1 database       | `bonobo-council`            | `b32e1b59-11ad-4086-9c92-72480e820e16`, region WEUR, migrations `0001` through `0005` applied to remote. Do not re-apply `0004` or `0005`. |
| Queue             | `bonobo-council-events`     | 8-day message retention; consumer on this Worker, `max_batch_size` 1, `max_retries` 5                                                      |
| Dead-letter queue | `bonobo-council-events-dlq` | 8-day message retention; consumed by this Worker to mark outbox rows `dead`                                                                |
| Workflow          | `bonobo-council-workflow`   | Binding `COUNCIL_WORKFLOW`, class `CouncilWorkflow`; created on first deploy                                                               |
| Workers AI        | binding `AI`                | Whisper Turbo per-track transcription and Llama 3.1 8B fast structured summaries                                                           |
| Cron              | `*/15 * * * *`              | Expiries, deadline closes, seal retries, outbox and projection reconciliation, delete retries, tombstone erasure                           |

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
- `COUNCIL_ROOM_COOKIE_SECRET` — signs the room session cookie and derives the keys that encrypt
  stored grant and provider tokens at rest (AES-GCM, purpose-scoped derivation).

Non-secret vars worth knowing (`wrangler.jsonc` `vars`):

- `REALTIMEKIT_WEBHOOK_PUBLIC_KEY` — the provider's RSA public key (SPKI PEM). Empty means the
  webhook route answers 503 for every delivery: fail closed, never unverified.
- `COUNCIL_DESTINATION_PATH_PREFIX` — where artifacts land in the workspace
  (`<prefix>/<meetingId>/...`).
- `COUNCIL_ALLOW_MISSING_CLIENT_IP` — `"true"` only in local testing; production guest joins
  require the `CF-Connecting-IP` edge header for the IP rate bucket.

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
   same refusal back and only delays the reason the member reads. Every other create-target failure
   still retries. The plan has to be raised, or the storage ceiling lifted, before a redrive can
   work. Reaching `ready` or `failed` releases nothing — the counter only grows. An operator redrive
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

Every Council artifact is read-only. The text artifacts (`summary.md`, `transcript.md`, and
`provider-transcript.json`) are also non-collaborative, so they do not pay the Yjs storage and sync
cost of a shared editor document. Audio tracks stay non-collaborative stored blobs. No Council
service upload starts plugin upload events.

One real cap to know: an upload run allows at most **16 targets**. The transcript and provider
diagnostic spend two, and the generated summary spends one, so at most 13 raw audio tracks are
stored. Every track is still transcribed — the attributed transcript stays complete — but a large
meeting's extra raw audio is not stored, and the pipeline logs when that happens. If filenames have
the same provider timestamp, their names provide the stable final ordering.

The summary uses the fast Llama 3.1 8B model through Workers AI JSON Schema mode. Council treats
transcript lines as untrusted quoted data, validates the full model response, caps the input at 12
chunks of 48,000 characters, and runs one bounded reduce call when several chunks exist. If the
source exceeds that cap, `summary.md` says that later content was not summarized.

Every test here mocks Convex and the provider. The flows have also been driven end to end against
the live dev deployment and the live provider through the plugin page.
