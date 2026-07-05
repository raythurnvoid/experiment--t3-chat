# Video Plugin Transcription

Goal: validate the `video` plugin end-to-end — audio and video uploads produce `<name>.transcript.md` + `<name>.summary.md` siblings with diarized, correctly-timestamped content. Transcription is plugin-owned via Mistral Voxtral (`file_url` + diarization); video audio is extracted first by the Modal extractor; summaries come from plugin-owned OpenAI calls.

Route: an already-open Playwriter-enabled `/w/:organizationName/:workspaceName/files` tab.

## Scope

Covers the flows that regress when the video plugin worker, Modal extractor, publisher secrets, or runner change: upload fan-out for audio and video content types, Modal `POST /extract-audio` + signed `audioUrl` hand-off, Mistral multipart contract (`voxtral-mini-latest`, `file_url`, `diarize`, segment granularity, no `language`), transcript normalization/formatting, and the transcript-before-summary write order.

## Preflight

1. Confirm the dev app is running and the `video` plugin is installed and enabled.
2. Confirm all four publisher secrets exist: `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `MODAL_MEDIA_AUDIO_URL`, `MODAL_TOKEN`.
3. Check Modal extractor health: `GET <modal origin>/health` should return 200.
4. Create a Playwriter session and install the app harness (see `r2-file-content-regression.md` Preflight).
5. Warm the Convex dev deployment; use one unique folder per run, `aaa-pw-video-<timestamp>`.

Fixtures (registered in `references/files.md`):

- `.agents/skills/app-playwriter-harness/assets/files/speakers.wav` — ~39s, two distinct TTS voices alternating scripted lines about the quarterly budget, a penguin research station, the marketing plan, and a solar bicycle.
- `.agents/skills/app-playwriter-harness/assets/files/speakers.mp4` — the same audio muxed over a solid-color video track; exercises the Modal extraction path.

## Audio Path (wav → Mistral directly)

1. Upload `speakers.wav` into the run folder (`Upload file` is in the sidebar `More options` menu; a same-name re-upload opens the `File already exists` modal — rename in its `Filename` input and submit `Upload`).
2. Poll for both siblings: `speakers.wav.transcript.md` and `speakers.wav.summary.md` (allow ~3 minutes).
3. Open the transcript and assert content quality:
   - At least two distinct `## Speaker N` headings (diarization worked).
   - The scripted phrases appear (fuzzy, case-insensitive): quarterly budget, penguin research station, marketing plan, solar bicycle.
   - Timestamps `[HH:MM:SS – HH:MM:SS]` are monotonically increasing and the last end time is within the fixture duration ±10% (~35–43s).
4. Open the summary and verify it references the scripted topics (budget/marketing/penguin/bicycle — at least two) rather than generic filler.

## Video Path (mp4 → Modal → Mistral)

1. Upload `speakers.mp4` into the same folder.
2. Poll for `speakers.mp4.transcript.md` + `speakers.mp4.summary.md`. Video runs add the Modal extraction round trip; allow ~4 minutes.
3. Apply the same transcript and summary assertions as the audio path (same underlying audio).

## Run Telemetry

From `packages/app` (dev deployment only):

```powershell
vp env exec node node_modules/convex/bin/main.js data plugins_event_runs --limit 5 --order desc
vp env exec node node_modules/convex/bin/main.js data plugins_event_run_calls --limit 30 --order desc
```

Expected result:

- Both `video` runs `succeeded`.
- Run calls contain only `secretGet`, `sourceTemporaryUrl`, `outboundFetch`, and `writeMarkdown` — never `transcribeAudio`.
- The wav run's outbound calls hit `api.mistral.ai` and `api.openai.com` only; the mp4 run additionally hits the Modal origin (extract POST). Host-call budget stays well under 20.

## Negative Test (Missing Secret)

1. Delete the `MISTRAL_API_KEY` publisher secret (respect the `plugins_manage` rate limiter — ~15s between mutations).
2. Upload `speakers.wav` again (renamed or into a second folder).
3. Verify: run `failed` with `errorMessage: "Plugin execution failed"` (the runner sanitizes every worker throw — the specific `MISTRAL_API_KEY secret is not configured` message is never persisted); the run's calls show only a single `secretGet` for `MISTRAL_API_KEY` with no writes; **no** `.transcript.md` and no `.summary.md` siblings for this upload (secrets are read before any write).
4. Re-create `MISTRAL_API_KEY` (origins `https://api.mistral.ai`).

## Cleanup

1. Archive the run folders.
2. Confirm all four publisher secrets are present again.
3. Record skipped steps with the real blocker, not as pass.

## Failure Triage

- Transcript missing but summary logic suspected: transcript is written **before** the summary call — a lone `.transcript.md` with a `failed` run means the OpenAI summary stage failed; no files at all means the failure was at secrets/Modal/Mistral.
- Only the mp4 path fails: check Modal (`/health`, then the extract POST status in run calls — 401 token, 413 size, 422 ffmpeg). The wav path bypasses Modal entirely.
- Single-speaker transcript on this fixture: confirm the Mistral request included `diarize=true` and `timestamp_granularities=segment`; segments come back EMPTY if granularities are omitted (worker then falls back to unlabeled sections — that fallback appearing here is a regression).
- Run stuck `pending`: Convex cold start or runner deployment, same as the image playbook.
