# Council Room And Dashboard Playbook

> **Most room claims below were last measured against `ROOM_REVISION = "council-room-r18"`, on
> 2026-08-23, and have not been re-measured since.** The recording-stage claims are the exception:
> they were re-measured on **`council-room-r22`** and carry that stamp wherever a measurement, rather
> than a read of the source, is what backs them. The room has moved again since both of those stamps.
> This file does not record what the marker reads today, and that is on purpose — see "Prove the
> Worker serves your tree" below for why a recorded value is the one way this proof can lie to you.
> The marker is **build-derived** since the 2026-08-31 room refactor: the build hashes the built JS
> and CSS filenames into `council-room-<8 hex>` and prints the value. Read it, do not bump it —
> there is no constant to bump any more. Compare the served marker with the value your last
> `run build` printed. Treat every "measured on r18" note below as history, not as the current
> behaviour — re-run the one you are about to rely on.
>
> **A matching revision proves this file is not stale. It does not prove it is complete.** In the
> string era the constant only moved when somebody bumped it by hand, and that got forgotten —
> once inside the very session a stamp was written, so two measurements read the same marker and
> disagreed about the layout. The build hash closed that hole for code and CSS, but a match still
> only says "the served build is the one I built", never "this document is current". Prove the
> served bytes separately — see "Prove the Worker serves your tree".
>
> **Pointers into the room-client modules and `routes-room.ts` are given by symbol name, not line
> number, and yours should be too.** Those files move by tens of lines a session. Every line
> number written into this file during round 10 was already wrong by the end of that same round.

Two Council surfaces run locally and are driven without any real provider or Convex host:

- **The meeting room** — a Vite-built document the Council Worker serves at `GET /room` from its
  assets store. Source: `packages/council/room-client/room.html` and `room.css` (the document),
  `packages/council/room-client/src/` (the typed client modules; start function in `client.ts`,
  one module per feature region), `packages/council/src/room-page.ts` (CSP + serving),
  `packages/council/src/routes-room.ts` (`POST /room/api/*`).
- **The plugin dashboard preview** — the Council plugin UI with a stubbed `window.fetch`. Source:
  `plugins/bonobo-plugin-council/src/preview.tsx` and `src/app.tsx`.

For the **deployed** Council page inside the app (`/w/<org>/<workspace>/plugins/council/pages/council`,
real Worker, real D1, real recordings) read the Council sections of `plugin-marketplace.md` instead.
This file is only about the local pair.

## The two local servers

The user starts these; do not start or stop them yourself. **"Do not start a server" is not "there is
no server" — check before concluding a surface is unreachable.** Two fixers in a row reported the
dashboard as impossible to QA because they were told not to start Vite, without ever probing the port.
It was already running both times. One `curl` settles it, and remember the IPv6 note below: a failing
`127.0.0.1:5199` proves nothing.

| Surface | Command | URL |
| --- | --- | --- |
| Room | terminal 1: `vp env exec pnpm --dir packages/council run build -- --watch`; terminal 2: `vp env exec pnpm --dir packages/council exec wrangler dev --local` (the pinned wrangler, not `pnpx`) | `http://127.0.0.1:8787/room?m=<meetingId>` |
| Dashboard preview | `vite --port 5199 --strictPort` in `plugins/bonobo-plugin-council` | `http://localhost:5199/preview.html?state=<fixture>` |

- The Worker answers on both `127.0.0.1:8787` and `localhost:8787`. The runners use `127.0.0.1`.
- The preview answers `localhost:5199` and `[::1]:5199` but **refuses** `127.0.0.1:5199`, because Vite
  binds the `localhost` name and that resolves to `::1` only here. See the IPv6 entry in
  `known-hazards.md` before deciding the preview is dead.
- `GET /room` needs no D1 row, no session, and no auth. It is a static document, so a Worker with an
  empty database still serves the whole room. Every stateful call is `POST /room/api/*`, and the
  recipes below intercept all of them.
- `preview.html` is the QA entrypoint. It loads `src/preview.tsx`, which renders the real `App` with
  `window.fetch` replaced by an in-memory Council service. So it needs **no Convex, no published plugin
  version, and no host app** — an unpublished plugin page on the dev deployment blocks nothing here.
  `index.html` boots `src/main.tsx` instead, which needs a real plugin host, so it is not usable
  standalone.

## Prove the Worker serves your tree

A browser result about `packages/council/**` means nothing if the Worker is serving stale
code. The document carries a marker for exactly this:

```js
await page.evaluate(() => document.querySelector('meta[name="council-room-revision"]').getAttribute("content"));
```

The marker is build-derived: `run build` hashes the built JS and CSS filenames into
`council-room-<8 hex>` and prints the value. This document deliberately does not record a current
value — any value written here is wrong within a round or two, and a reader who trusts it compares
the Worker against a number that was never the answer. Compare the served marker with the value
your own build printed. From the shell:

```sh
curl -s "http://127.0.0.1:8787/room?m=qa" | grep -o 'council-room-revision" content="[^"]*"'
```

`wrangler dev` serves whatever is in `room-client/dist/` and picks up a rebuilt assets directory
without a restart (verified 2026-08-31) — but nothing rebuilds for you. A source edit reaches the
served document only after `run build` runs again, so keep `run build -- --watch` running, and
mind that a comment-only edit changes no built bytes and so no marker. When in doubt, fall back to
the break-on-purpose rule: change one visible string, rebuild, reload, watch it change, put it
back.

## Room entry points and views

The real host link is `<origin>/room?m=<meetingId>#ticket=<ticket>` (`routes-page.ts`, the
`/api/meetings/room-ticket` route). The guest link is `<origin>/room?m=<meetingId>` with no fragment.

On load the boot script pulls `ticket` out of the fragment and erases the fragment before the
third-party SDK script runs. Then:

- **With a ticket** — `POST /room/api/session { ticket }`, then the lobby.
- **Without a ticket** — `POST /room/api/session { meetingId }` resumes the `__Host-council_session`
  cookie, where `meetingId` is the `?m=` value. The body is a bare `{}` only when `?m=` is missing
  (`client.ts`, the boot resume that reads `?m=`). That field is load-bearing, and it is the reason the rule below exists: one
  room cookie covers the whole origin, so a resume that names no meeting puts the visitor back into
  whatever meeting they were in last. A mock that asserts on a `{}` body will not match a real page.
  On a refusal the page shows the guest form **only if** `?m=<meetingId>` is in the query; without it
  the page shows the fatal error view instead. So always keep `?m=` on the URL.
- **Pasting a fresh ticket into the same document** works: the page listens for `hashchange`, so
  setting `location.hash` to `#ticket=<new>` and dispatching `HashChangeEvent` re-runs the exchange.
  That is the supported way back into the lobby after the call ended.

Six views, toggled with the `hidden` property. `#room-header` is visible only in `view-call`:

| View | id | Shown when |
| --- | --- | --- |
| Loading | `#view-loading` | before the first session answer |
| Guest form | `#view-guest` | session refused and `?m=` present |
| Lobby | `#view-lobby` | a session exists, before Join |
| Call | `#view-call` | joined |
| Ended | `#view-ended` | left, ended, or closed |
| Error | `#view-error` | fatal, unrecoverable |

Wait on `#view-call:not([hidden])`. It says the state you want, and it matches how the room switches
views. Never wait on the inverse, `#view-ended[hidden]`: `waitFor()` defaults to `state: "visible"`, so
that selector waits for a hidden element to become visible and always burns the whole timeout. Use
`page.waitForFunction(() => document.getElementById("view-ended").hidden === true)` for that direction.

## `POST /room/api/*` and what the real routes answer

Six paths, all POST, all same-origin. The four in-call paths need the `X-Council-Csrf` header the
session handed out; `/room/api/session` and `/room/api/guest-session` mint the session and need none.
The split is not a convention you have to remember: `room_session_auth` in `routes-room.ts` (the one
place that reads the header) is called from exactly four places, and all four are in the `in-room
calls` region.

| Path | `X-Council-Csrf` | Real success body |
| --- | --- | --- |
| `/room/api/session` | no — mints it | `{ csrfToken, meeting, participant: { id, role, displayName } }` |
| `/room/api/guest-session` | no — mints it | same shape as `/room/api/session` |
| `/room/api/join` | required | `{ authToken }` |
| `/room/api/state` | required | `{ meeting }` |
| `/room/api/host/start-recording` | required | `{ recording: true }` |
| `/room/api/host/close` | required | `{ status }` |

`meeting` is `meeting_room_view(...)` in `routes-room.ts`:

```js
{ id, title, status, deadlineAt, participantCount, maxParticipants, recordingStarted }
```

Include `recordingStarted`. `enterCall` seeds the recording stage from it, so a meeting that already
recorded must not be re-offered the button after a reload. A mock that omits the field can never
reproduce that case.

**`deadlineAt` is epoch MILLISECONDS, not an ISO string.** `renderLobby` formats it only when
`typeof deadlineAt === "number" && isFinite(deadlineAt)` (`renderLobby` in `client.ts`), and the else branch
writes the empty string. So an ISO string leaves `#lobby-deadline` present, visible and **blank** —
verified on `council-room-r18`: `{ text: "", hidden: false }` for
`new Date(…).toISOString()`, and `The room closes at 8/23/2026, 2:55:36 AM.` for `Date.now() + 3600e3`.
A blank line reads as a feature nobody built rather than as a bad fixture, which is the expensive way
to lose an hour.

**The recording stage does not survive a reload, so never re-navigate in the middle of an A/B.**
`state.recordingStage` lives only in memory, and `enterCall` re-seeds it on every boot from the meeting
fields alone: `recording_start_unknown` gives `unavailable`, `recordingStarted: true` gives `finished`,
and everything else gives `idle`. There is no path that carries `pending`, `requested`, `unsaved` or a
502-driven `unavailable` across a navigation. Verified on `council-room-r18`: driven to
`"Recording unavailable"`, then `goto` + rejoin with the same mocks, and the label came back
`"Start recording"` — the shortest label, and the only one that fits everywhere. Re-confirmed on
`council-room-r22` from the `requested` and `unavailable` stages. A width sweep
that reloads between its two halves therefore measures the longest label on one side and the shortest
on the other, and reports a threshold far weaker than the real one, with nothing on screen to say so.

Give a host fixture `participant.displayName: ""` unless the run needs a named host. `routes-room.ts`
inserts the host's participant row with an empty `display_name`: the insert is the
`INSERT OR IGNORE INTO meeting_participants` in the ticket branch, and the comment beside it says the
name stays empty until they type it in the lobby, because `Host` is a role and not a name. So the
empty string is the state every real first-time host reaches. The client gates the entire lobby naming
step on it — `hostNeedsName` is `participant.role === "host" && displayName === ""`
(`renderLobby` in `room-client/src/session.ts`) — and the Join handler only reads the field while `#host-name-field` is not
hidden. So a fixture that hands the host a ready-made name is the *returning* host, and it cannot reach
`#host-name`, its two refusals (`Enter the name to show to other participants.` and `That display name
is too long. Try a shorter one.`, each setting `aria-invalid` and pulling focus back to the input), or
anything downstream of them. Set the empty string and the first-time host is reachable.

Errors are `{ message }` plus a status. The client shows `message`, or `Request failed (<status>)`
when there is none. Some answers have their own branch:

- `start-recording` has **three outcomes, and the status is what separates them**. The client tests
  for 502 and for 500 by number; every other status, 503 included, falls to the same default branch.
  Measured on `council-room-r22`, including a 504, which landed on the same stage and the same end
  dialog as the 503 — so pick 503 for readability, not because the client looks for it.
  **502** means the provider never answered: the meeting moves to `recording_start_unknown`, records
  nothing, admits nobody new, and refuses a second start. The client closes the control for good and
  says the meeting will not be saved and nobody else can join.
  **503** means the provider answered and refused: nothing was ever recorded, the meeting is
  untouched, so the stage goes back to `idle` and pressing again can still work.
  **500** means the provider did start a recording and the service could not store its id. That
  attempt can never produce files, but the meeting is still open with no recording on it, so the
  stage goes to `unsaved`, which offers a fresh start exactly as `idle` does. Anything else returns
  to `idle`. Every non-502 case writes `#host-error`. The 500 writes a fixed sentence of its own
  there instead of the server's `message`, while the default branch echoes the `message` your mock
  sent — so a runner can tell a 500 from a 503 by whether the banner repeats its own text. Two more
  cases in the same `catch` replace the message with fixed text and would break that rule of thumb:
  a request that aborted on the 30 s deadline, and an answer that lands after the provider has
  already started recording. Read all of them off `startRecording` in `room-client/src/host-controls.ts`.
  **`idle` and `unsaved` wear the same label, `Start recording`, so the control cannot tell you which
  one you are in.** The end dialog can: open `#host-confirm` and read `#host-confirm-text`, which
  says no recording was started on `idle` and that the recording could not be saved on `unsaved`.
  Those two sentences are written by `openEndConfirm` in `room-client/src/host-controls.ts`, one `if` branch each —
  read them out of that function rather than out of a copy here, because a product sentence pasted
  into this file goes stale the moment somebody rewords it and no gate would notice. Nothing cheaper
  separates the two stages, because `state` lives inside the client's IIFE and no page global exposes
  it. Cancel the dialog afterwards, or every later control-bar hit test reads false — see the trap
  below.
  Mock the status you actually mean — a 503 mocked as 502 makes a retryable refusal look like a dead
  meeting, and the client has no other way to tell them apart.
- `/room/api/state` is polled every 10 s. A status that is neither `open` nor `recording_start_unknown`
  ends the call locally.

Route them all in one handler:

```js
await page.route("**/room/api/**", async (route) => {
	const path = new URL(route.request().url()).pathname;
	// Hold the request open forever. A handler that just returns falls through to the real Worker.
	if (path === "/room/api/host/close" && state.hangClose) {
		await new Promise(() => {});
	}
	const replies = { "/room/api/session": session, "/room/api/join": { authToken: "qa-token" } /* … */ };
	const body = replies[path];
	await route.fulfill({
		status: body ? 200 : 500,
		contentType: "application/json",
		body: JSON.stringify(body ?? { message: "No QA handler for " + path }),
	});
});
```

Keep the hang flags on `state` (not captured by value), so a later execute call can flip one without
re-registering the route.

## The fake RealtimeKit

The document loads the provider SDK from one pinned URL with an `integrity` hash:

```
https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js
```

Abort it, or the real SDK wins and tries to reach `api.realtime.cloudflare.com`:

```js
await page.route("https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js", (route) => route.abort());
```

Install the fake **after** the lobby is visible and **before** clicking `#join-button`. The join
handler checks `typeof RealtimeKitClient === "undefined"` right after `/room/api/join` answers, and
without the global it fails with `The meeting software did not load.`

```js
window.RealtimeKitClient = { init: async () => sdk };
```

`init` is called as `RealtimeKitClient.init({ authToken, defaults: { audio: true, video: false } })`.

### The SDK object the room reads

```js
const sdk = {
	self,                          // emitter, see below
	participants: { joined, audioSubscribed }, // joined: emitter with .toArray(); audioSubscribed: a Set
	recording,                     // emitter with .recordingState
	meta,                          // emitter with .meetingStartedTimestamp
	join: async () => { self.roomJoined = true; self.emit("roomJoined", { reconnected: false }); },
	leave: async () => {},
};
```

- `sdk.self` needs `roomJoined`, `audioEnabled`, `videoEnabled`, `audioTrack`, `videoTrack`, `name`,
  `id`, `customParticipantId`, plus `enableAudio` / `disableAudio` / `enableVideo` / `disableVideo`,
  `screenShareEnabled`, `screenShareTracks` (`{ audio, video }`), and `enableScreenShare` /
  `disableScreenShare`. All six toggles may return a promise; return a never-settling promise to
  simulate an open browser permission prompt. The room judges a share by the **track**, not the
  promise: `screenShareEnabled === true` and a `screenShareTracks.video` track. A resolved
  `enableScreenShare()` with no video track is a failed share.
- **`videoTrack` and `screenShareTracks.video` / `.audio` must be real `MediaStreamTrack`s, not
  stubs.** A plain `{ kind: "video" }` object throws `Failed to construct 'MediaStream'` inside
  `updateParticipantTile` or `updateSharePresentation`, and the room then reads as a client crash
  rather than a bad fixture — you will debug the app instead of your fake. Use
  `canvas.captureStream(5).getVideoTracks()[0]` for share video and an `AudioContext` oscillator
  into `createMediaStreamDestination()` for tab audio (see "Making tile chrome contrast measurable"
  below). Observed 2026-08-22 for camera tracks; the share stage uses the same `MediaStream`
  constructor.
- The room also checks `navigator.mediaDevices.getDisplayMedia` before it calls `enableScreenShare`.
  A fake that never installs that function cannot start a share; the status line says this browser
  cannot share a screen. Desktop Edge has the API. Unit tests cover the missing-API branch.
- `sdk.participants.joined.toArray()` returns the remote participants. Each remote is the same shape
  as `self` minus the toggles.
- `sdk.participants.audioSubscribed` is a `Set` of the peer ids whose audio the room really receives.
  `updateParticipantTile` calls `.has(peerId)` on it to choose the mic chip: a peer with audio off
  that IS in the set says "Mic off", one that is NOT says "No audio". Leave the field out and every
  muted remote says "Mic off", so the "No audio" chip cannot be reproduced from the fake at all. The
  local tile always says "Mic off"; it is never asked.
- Tile identity is `custom:<customParticipantId>`, else `peer:<id>`, else `local` for self. It lands on
  the tile as `data-participant-key`, so give every fake participant a distinct `customParticipantId`.
- `sdk.recording.recordingState` is the string. `STARTING` and `RECORDING` both count as active.
- `sdk.meta.meetingStartedTimestamp` is a `Date` or anything `new Date(...)` parses.

A minimal emitter is enough. The room calls `on`, and `off` or `removeListener` on teardown:

```js
function emitter(fields) {
	const handlers = new Map();
	const target = Object.assign({}, fields);
	target.on = (event, handler) => {
		if (!handlers.has(event)) handlers.set(event, new Set());
		handlers.get(event).add(handler);
		return target;
	};
	target.off = (event, handler) => {
		handlers.get(event)?.delete(handler);
		return target;
	};
	target.emit = (event, payload) => {
		for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
	};
	return target;
}
```

### Events the room subscribes to

Checked against `wireCallEvents` in `room-client/src/call-state.ts`, `createRoomJoinedWaiter` in
`room-client/src/join.ts`, and `createTile` and `updateParticipantTile` in `room-client/src/media.ts`.

| Emitter | Event | Payload the room reads |
| --- | --- | --- |
| `sdk.self` | `roomJoined` | ignored — ends the join wait, and clears the reconnect banner |
| `sdk.self` | `roomLeft` | `{ state }`; `disconnected` reconnects, `failed` is terminal (own pill and wording), anything else ends the call |
| `sdk.self` | `audioUpdate` | ignored — re-reads `sdk.self.audioEnabled` |
| `sdk.self` | `videoUpdate` | ignored — re-reads `sdk.self.videoEnabled` |
| `sdk.self` | `mediaPermissionUpdate` | `{ kind: "audio" \| "video" \| "screenshare", message }`; `ACCEPTED` is the only silent one — see below |
| `sdk.participants.joined` | `participantJoined` | the participant object; it wins over the snapshot for that key |
| `sdk.participants.joined` | `participantLeft` | ignored — re-reads `toArray()` |
| `sdk.participants.joined` | `participantsCleared` | ignored — drops every remote tile and re-reads `toArray()` |
| each participant (self and remotes) | `audioUpdate`, `videoUpdate`, `screenShareUpdate` | ignored — re-reads that participant's fields. `screenShareUpdate` also records arrival order for newest-share-wins |
| `sdk.recording` | `recordingUpdate` | a bare string, otherwise it re-reads `sdk.recording.recordingState` |
| `sdk.meta` | `meetingStartTimeUpdate` | ignored — re-reads `sdk.meta.meetingStartedTimestamp` |
| `sdk.meta` | `socketConnectionUpdate` | `{ state: "connected" \| "disconnected" \| "reconnecting" \| "failed" }` |

`socketConnectionUpdate` is on `sdk.meta`, not on `sdk.self`. Putting it on `self` emits into nothing
and the connection chip never moves.

`mediaPermissionUpdate` shows a notice for **every** message except `ACCEPTED` — do not assume only
the two denial values do. `handleMediaPermissionUpdate` in `client.ts` returns early on `ACCEPTED`
alone, then splits screenshare **before** the camera/mic branches. Screenshare notices all open with
`Screen share unavailable.` A cancelled picker is `CANCELED`, not `DENIED`. Do not treat that as
"no screen was found." `NO_DEVICES_AVAILABLE` on screenshare uses the permission sentence, not the
camera "no camera was found" wording.

Camera and microphone notices still open with the same
`Camera unavailable.` / `Microphone unavailable.` prefix and only the sentence after it differs:

| Message | Sentence after the prefix (camera wording) |
| --- | --- |
| `COULD_NOT_START` | `Close any other app using it, then turn the camera on.` |
| `NO_DEVICES_AVAILABLE` | `No camera was found. Connect one, then turn the camera on.` |
| anything else, `NOT_REQUESTED` and `DENIED` included | `Check the browser camera permission.` |

`NO_DEVICES_AVAILABLE` is the one to watch: it is the newest branch, and this file described only
three outcomes until 2026-08-23. The SDK sends it when the browser lists no input of that kind at all
— a desktop with no webcam, an unplugged headset — so the permission sentence would send that person
to a panel that already says allow. A fake that never emits it cannot reach the branch.

The shared prefix is deliberate: `clearCallStatus(prefix)` clears by prefix, so a notice that started
with anything else would survive a later successful toggle. A `COULD_NOT_START` producing a visible
`#call-status` was measured, so a runner that asserts "no notice" there records a false pass.

`participantsCleared` is the event the SDK fires on every socket re-join: it empties the collection
and adds the fresh peers back one by one, without one `participantLeft` per peer. A fake that omits
it can never reproduce the stale-tile path the listener exists for — emit it, then emit
`participantJoined` for whichever peers came back (none, to check that every remote tile is gone).

**The one rule that matters: the room re-reads state off the SDK objects, and ignores most payloads.**
Mutate the field first, then emit:

```js
qa.recording.recordingState = "RECORDING";
qa.recording.emit("recordingUpdate", { recordingState: "RECORDING" });   // object payload -> falls back to the field
qa.recording.emit("recordingUpdate", "RECORDING");                       // or just emit the string
```

```js
qa.remotes[0].audioEnabled = false;
qa.remotes[0].emit("audioUpdate", { audioEnabled: false, audioTrack: qa.remotes[0].audioTrack });
```

```js
// Join-mid-share: put the tracks on the remote *before* join. Do not emit screenShareUpdate.
qa.remotes[0].screenShareEnabled = true;
qa.remotes[0].screenShareTracks = { video: shareVideoTrack, audio: shareAudioTrack };

// Live start after join: mutate, then emit. Newest emit wins when two remotes share.
qa.remotes[0].screenShareEnabled = true;
qa.remotes[0].screenShareTracks = { video: shareVideoTrack, audio: shareAudioTrack };
qa.remotes[0].emit("screenShareUpdate");
```

Park the fake on `window.__councilQa` so later execute calls can reach `self`, `joined`, `remotes`,
`recording`, `meta`, and the `emitter` factory without rebuilding them.

When this room page is `context.newPage()`, pass that page as `frame` to
`auditAccessibility`, or also set `state.appPlaywriterHarness.page`. The helper otherwise
audits another tab and times out on `.control-bar`. The same trap is in `known-hazards.md`
under `getHarnessPage`.

Real media without a device: paint a `<canvas>` and use `canvas.captureStream(5).getVideoTracks()[0]`
for video, and an `AudioContext` oscillator into `createMediaStreamDestination()` for audio. That is
enough for the tile to switch to `data-video="on"` and for the autoplay path to run.

### Making tile chrome contrast measurable

Every label, chip, and button on a tile sits on top of whatever the video paints, so its contrast is
a question about the worst background it can meet. Give one fake peer a plain **white** canvas track
and `audioEnabled: false`, and that worst case is on screen and reproducible:

```js
const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
const context = canvas.getContext("2d");
context.fillStyle = "#ffffff";
context.fillRect(0, 0, canvas.width, canvas.height);
const track = canvas.captureStream(5).getVideoTracks()[0];
```

White is the hardest background for light text, and `audioEnabled: false` makes the mic chip render
at the same time, so one tile answers every chrome question at once.

`getComputedStyle` cannot score that tile. It reports the declared colour, not what the pixel ended
up as, so it says nothing about a `backdrop-filter`, an opacity-composited group, or an outline drawn
over moving video. Read the real painted pixels instead:

1. `const cdp = await getCDPSession({ page: state.page })`, then
   `const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true })`.
2. Hand `shot.data` back into the page and decode it there **without the network**: `atob` ->
   `Uint8Array` -> `new Blob([bytes])` -> `createImageBitmap(blob)`. Do not `fetch` the data URL —
   the room's `connect-src` does not list `data:` and the fetch dies with `TypeError: Failed to
   fetch`, which reads as a broken page.
3. Draw the bitmap to a `<canvas>` and read `getImageData` at the points you care about.

Sample several points per element, not one: a chip over video meets a different background at each
corner. Inset every sample past the element's border radius first — the bounding rect covers the
corner squares the radius cut away, so those samples read the backdrop and land in the histogram as
false extremes. Take the worst remaining sample as the answer. Keep `scale: 1` on the capture — a
clip with any other scale loses its `x`/`y`. Both traps are recorded in `known-hazards.md`.

The header clock ticks every second, so two screenshots of the same state never match. One runner
pinned it before `goto` with `await page.clock.setFixedTime(new Date("2026-08-22T12:24:08Z"))`.

## Element ids

Every id below was read out of the document the local Worker served, and matched against
`room-client/room.html`. Ids are stable — this document is hand-written HTML, not a component tree.

**Guest form** — `#guest-form`, `#guest-code`, `#guest-name`, `#guest-email` (optional), `#guest-submit`,
`#guest-error`. A refused field also gets `aria-invalid="true"` and keyboard focus.

**Lobby** — `#lobby-heading`, `#lobby-meeting`, `#lobby-name`, `#lobby-avatar`, `#lobby-role`,
`#lobby-deadline`, `#lobby-error`, `#lobby-progress`, `#join-button`. `#host-name-field` wraps
`#host-name` and is shown only for a host whose `displayName` is still empty.

`#lobby-form` wraps the field, the error and the button, and `#join-button` is its submit button, so
Enter in `#host-name` joins the meeting. Drive the join with a form submit or a real button press, not
by dispatching a bare `submit` event — that skips constraint validation. Note the button's
`type="submit"` is load-bearing for the **button**: measured in the served build, changing it to
`type="button"` leaves Enter working (a form with one field and no submit button still submits on
Enter) while the Join button stops firing submit entirely.

**Call header** — `#meeting-title`, `#meeting-elapsed`, `#connection-status` (`data-state` is
`connected` / `reconnecting` / `problem`), `#recording-indicator`.

**Call body** — `#call-heading`, `#call-status`, `#play-audio-button`, `#share-stage` (hidden until a
share is showing; holds `#share-video`, `#share-note`, `#share-label`), `#participant-list`,
`#audio-bin`, `#recording-live`, `#host-error`. `#share-note` reads `Showing the most recent share`
and is hidden unless this client can see more than one share. Tab audio is a second `#audio-bin`
`<audio data-share-audio>` per remote sharer, never for self. Tear it down when the share stops,
not only when the tile leaves.

**Controls** — `#mute-button`, `#camera-button`, `#share-button`, `#participant-count-status`, `#start-recording-button`,
`#end-meeting-button`, `#leave-button`. Each holds a `.control-label` span with the visible words.
Share is named `Share` in both states. A second share is refused with a line that starts
`Screen share unavailable.` The client refuses; do not claim the provider also refused.

**Host confirm dialog** — `#host-confirm` (`role="dialog"`, `aria-modal`), `#host-confirm-heading`,
`#host-confirm-text`, `#host-confirm-cancel`, `#host-confirm-yes`.

**Ended / error** — `#ended-heading`, `#ended-message`, `#rejoin-button`, `#error-heading`,
`#error-message`.

Notes that bite:

- `#participant-count-status` looks like a button and sits in the control bar, but it is a
  `<p role="status">`. `getByRole("button")` never finds it.
- `#start-recording-button` and `#end-meeting-button` are `hidden` unless the session mock says
  `participant.role === "host"`.
- **`#rejoin-button` appears after a deliberate Leave and after a back/forward-cache suspend** — two
  ends, not one. `endLocally(message, canRejoin)` shows the button only when `canRejoin === true`, and
  exactly two callers pass it: the Leave button (the `#leave-button` listener in `client.ts`) and `handlePageHide` when
  `event.persisted === true` (`handlePageHide` in `client.ts`), which ends the call with
  `This page was put to sleep, so you left the meeting.` Every other end hides it, because the room
  cookie is the only end a participant can undo. The heading reads the same flag, so assert the pair:
  `You left the meeting` with the button, `Meeting ended` without it.
- Busy controls stay enabled and carry `aria-busy="true"`. The room does this on purpose: a disabled
  control blurs and focus never comes back. So assert `aria-busy`, not `disabled`, for a pending
  press on `#guest-submit`, `#join-button`, `#mute-button`, `#camera-button`,
  `#share-button`, `#start-recording-button`, or `#rejoin-button`. A re-press while `aria-busy="true"` is ignored, so
  a held Enter cannot fire the request twice.
- **`#host-confirm-yes` is the one exception — it really does disable.** It can afford to, because
  `confirmEndMeeting` moves focus to `#host-confirm-cancel` *before* disabling it, so focus never
  reaches the body. Assert `disabled` there, not `aria-busy`.
- `#start-recording-button` label text comes from `RECORDING_LABELS`: `Start recording`,
  `Starting recording…`, `Recording requested`, `Recording finished`, `Recording unavailable`, and
  `Recording` while a recording is live. That is five strings for **six** stages: `idle` and `unsaved`
  both read `Start recording`, so the label alone never tells you which stage you are in. Read the end
  dialog for that.
- **While the provider says a recording is live, the control is disabled and reads `Recording`
  whatever the stage is.** `renderRecordingState` takes the live branch before it looks at the stage,
  so a `recordingUpdate("RECORDING")` closes the control even on a stage that would otherwise offer a
  start, and the stop edge opens it again. Measured on `council-room-r22` from `unsaved`:
  `Start recording` / enabled, then `Recording` / disabled, then `Start recording` / enabled. So a
  probe that reads the control during a live recording learns nothing about the stage underneath it.

**Participant tiles** are built by the client into `#participant-list`:

- `#participant-list` carries `data-count`, and `data-layout` = `featured` (3–5 tiles) or `grid`
  (6+); 1–2 tiles carry neither. `data-side-columns` is `1` at 3 tiles and `2` at 4–5.
- Each tile is `.participant-tile[data-participant-key][data-featured][data-video]` holding
  `.participant-video`, `.participant-avatar`, `.participant-pin` (a real button with `aria-pressed`),
  and a `.participant-meta` row of `.participant-name`, `.participant-video-state`, and
  `.participant-mic[data-muted]`.
- **`.participant-video-state` reads `No video` on a tile with no picture and `""` when video is
  playing.** It deliberately does not name a reason. The SDK sets `videoEnabled = false` **and** clears
  `videoTrack` when a peer leaves the subscribed set, which is byte-identical to a peer who turned their
  camera off — the two causes cannot be told apart, so any wording naming one would be a guess. Expect
  this label on every peer past the subscription limit (6 by default), which is the case it exists for.
- **`data-featured` is on every tile at every count**, as `"true"` or `"false"` — it does not follow
  `data-layout`. So `[data-featured]` selects all tiles, including the 1–2 tile case that has no
  `data-layout` at all. Match on `[data-featured="true"]` when you want the featured one.
- **`data-featured="true"` can match nothing, and that is correct.** Outside the featured layout a tile
  is only marked when someone has actually pinned it — the implicit featured key is the host's own tile,
  and nobody asked for a border there. So a 2-person call with no pin, and a 6+ grid with no pin, have
  **zero** `"true"` tiles. Do not assert "exactly one featured tile"; assert against the pin state you
  set up.
- **`.participant-mic` is only visible when that participant is muted.**
  `.participant-mic[data-muted="false"] { display: none }`, so there is no "Mic on" badge to assert.
  A tile with no visible mic chip means unmuted, not missing state. The visible chip carries one of
  two labels: `Mic off` for a peer the room really receives, and the neutral `No audio` for a peer
  past the SDK's audio subscription limit, whose audio the room never gets and whose mute state it
  therefore cannot claim. Both keep `data-muted="true"` and both paint red, so read the text, not
  the attribute, when you care which one you have.
- **The chips in `.participant-meta` wrap onto their own lines instead of shrinking.** `Mic off` and
  `No video` never shrink and never break a word; only `.participant-name` truncates, with an
  ellipsis. On a small tile the row is two or three stacked lines and covers most of the tile: at
  720x450 with five tiles the side tile is 171x140 and the row is 66px, at 560x420 it is 129x140 and
  the row is 102px. That is the layout working, not a defect to report.
- Remote `<audio>` elements live in `#audio-bin`, one per remote tile, not inside the tile.

To prove a chip is cut, do not read `textContent` and do not squint at a screenshot: the text node keeps
every character whether it paints or not, and `text-overflow: ellipsis` changes the paint only. Walk the
node one character at a time and ask which rects sit inside the element's own box.

```js
const node = element.firstChild;
const box = element.getBoundingClientRect();
const range = document.createRange();
const lines = new Map();
for (let i = 0; i < node.textContent.length; i += 1) {
	range.setStart(node, i);
	range.setEnd(node, i + 1);
	const rect = range.getBoundingClientRect();
	if (!rect.width && !rect.height) continue;
	const key = Math.round(rect.top); // one entry per line box
	if (!lines.has(key)) lines.set(key, { shown: "", clipped: "" });
	const inside = rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.bottom <= box.bottom + 0.5;
	lines.get(key)[inside ? "shown" : "clipped"] += node.textContent[i];
}
```

That returns `[{ shown: "Mic", clipped: " " }, { shown: "off" }]` for a wrapped-and-cut chip and one
whole line for a healthy one. Two limits: a chip that wraps has more than one line-box key, so read the
array length as the wrap count, and an ellipsis is invisible to this — the characters under it still
report as `clipped`, so confirm the mark itself in an image.

## Driving a second participant

Open a second page in the same context and give it its own routes. Nothing is shared between the two
pages except the browser, so a host page and a guest page can be in the "same" meeting at once — the
two fake SDKs simply describe each other.

The guest path needs the session route to refuse first, so the guest form appears:

```js
state.guestHasSession = false;
await guest.route("**/room/api/**", async (route) => {
	const path = new URL(route.request().url()).pathname;
	if (path === "/room/api/session" && !state.guestHasSession) {
		return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Unauthorized" }) });
	}
	if (path === "/room/api/guest-session") {
		state.guestBody = route.request().postDataJSON();   // assert the fields, never log them
		state.guestHasSession = true;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) });
	}
	// … session / join / state as above
});
await guest.goto("http://127.0.0.1:8787/room?m=qa-meeting", { waitUntil: "domcontentloaded" });
await guest.locator("#view-guest:not([hidden])").waitFor();
```

- Fill `#guest-code` and `#guest-name`, then click `#guest-submit`. Email is optional.
- The client sends `{ meetingId, code, displayName, email, joinAttemptId }`. `joinAttemptId` is a
  `crypto.randomUUID()` keyed on code + name + email, so re-submitting the same three values replays
  the same attempt id — that is what makes the real route idempotent.
- Answer the guest session with `participant.role: "guest"` and the two host controls stay hidden.
  That is the cheapest proof the host-only gate holds; the room hides them purely from that field.
- No real second identity is needed here, because the room has no Clerk session at all. For app-side
  permission work read `second-user-fixtures.md` instead.

## The dashboard preview

`http://localhost:5199/preview.html?state=<fixture>`. The value is matched in `preview.tsx`, and every
value except `all`, `empty`, `stale`, `loading`, and `error` is matched against a meeting **status**:

| `state=` | What renders |
| --- | --- |
| `all` (default) | all seven fixture cards |
| `empty` | `No meetings yet. Create one to get a guest invite.` |
| `loading` | the list request never settles, so `Loading meetings…` stays |
| `error` | the first list call 503s, so the full-page error plus `Retry` |
| `stale` | all seven cards, then every later poll 503s — the `.refresh-error` banner over kept cards |
| `open` | Weekly planning, with `Get host room link` and `Close meeting` |
| `recording_start_unknown` | Vendor call — `Recording failed`, still counting down, still closeable |
| `processing` | Customer review — `Council is preparing the saved files.`, Delete disabled |
| `ready` | Design critique — four artifact badges and a `Saved to` path |
| `failed` | Partner interview, with a `failureReason` |
| `delete_failed` | Hiring sync — a closed meeting whose `failureReason` is the `delete_failed` sentence from `failure_sentence` (`routes-page.ts`) |
| anything with no fixture — including `created`, `closed`, `deleting` | a card titled `Preview has no fixture for ?state=<value>` |

Two things this list corrects:

- A value the preview has no fixture for now **says so on the card**, instead of silently rendering a
  plausible `created` card. So a typo looks like a typo. Note the card still renders with status
  `created`, because it has to render as something — read the title, not the chip. Several real
  statuses (`created`, `closed`, `expired`, `create_unknown`, `deleting`) simply have
  no fixture here and land on that card too; that is a missing fixture, not a bug.
- `?state=ready` always resolves to the **first** `ready` fixture, which is Design critique. The
  artifact-less `Budget check` card (`Council saved no files for this meeting.`) only appears under
  `all` and `stale`. That sentence used to read "No recording was started, so nothing was saved.",
  which was changed because Council cannot prove it: a meeting whose recording start was attempted and
  lost also settles with no artifacts, so the card must claim only what Council knows.

The stub answers `create`, `list`, `open`, `room-ticket`, `close`, and `delete`, so the whole
create → open → host room link → close → delete loop is drivable offline. The room link it hands back
is `https://council.example.test/room?m=<meeting id>#ticket=single-use`. That shape matches the real
route, which answers `/room?m=<meeting id>#ticket=<ticket>`: the room reads the meeting id from the
`m` search param and the ticket from the `ticket` fragment key. The host is still a placeholder, so
the URL is not reachable — only its shape is real.

One step of that loop changed shape: the one-time invite panel now **stays** after `Open meeting`. It
used to unmount, which destroyed the only copy of the join code — the panel warns that Council cannot
show the code again, and the primary-styled button next to that warning was what discarded it. After
opening, the panel keeps the code and swaps the button for a `role="status"` line, and only
`Done, I saved the invite` dismisses it. So a driver reading the join code after `Open meeting` will
now find it; a runner written against the old behaviour that expected the panel to disappear will not.

Selectors: the root is `.council`; rows are `li.meeting[data-meeting-id]` inside `.meeting-list`,
grouped into `Active` and `Recent`. Field ids come from React `useId`, so they are not stable — locate
controls by role and accessible name. Every row action carries the meeting title in its `aria-label`
(`Open meeting <title>`, `Get host room link <title>`, `Close meeting <title>`, `Delete <title>`), and
a copy button's name is composed as `Copy <label>` from the row above it: `Copy join code`,
`Copy guest link`, `Copy host room link`.

**Three names are not unique, so scope the lookup or you will match the wrong node.** `Copy guest link`
now appears both in the invite panel and on every `created`/`open` card, so a bare name lookup on a
populated dashboard matches several. While a just-created meeting is on screen, `Open meeting <title>`
matches **two** buttons — the panel's and that meeting's card — until the meeting opens, when both go.
And cards now carry their own `role="status"` nodes (each copy row has one), so a bare
`getByRole("status")` is ambiguous: read announcements from `.council-announcer`, which is the page's
single live region.

**A meeting title is `h4.meeting-title`.** The dashboard headings run `h1` Council -> `h2` New meeting
/ Meetings -> `h3` Active / Recent -> `h4` the titles. So `document.querySelectorAll("h3")` returns
`["Active", "Recent"]` — the two group headings — and never a meeting. This is worth stating because of
how it fails: a row census written against `h3` reports the same two strings before and after a delete,
so "the title is gone" is true no matter what happened, and a delete that silently did nothing looks
identical to one that worked. Count `h4.meeting-title`, or count the `Delete <title>` buttons, which
carry the title in their accessible name and cannot drift from the row.

**The delete confirmation deliberately does not focus its confirm button.** Pressing `Delete` moves
focus to the warning paragraph (`Delete <title>? Any files Council saved for it move to the Files
archive…`). That is not an oversight to report: a `<button>` activates on Enter **keydown**, so if the
confirm button took focus, the auto-repeat from the same still-held Enter that opened the panel would
activate it and destroy the row before the member read one word. Tab order from the warning is
`Confirm delete` -> `Cancel` -> the next row's action. `Confirm delete` stays enabled with
`aria-busy`; `Cancel` restores focus to the row's `Delete` button. After a successful delete, focus
lands on the `Meetings` `h2` (`tabIndex={-1}`), which is also where a finished retry sends it.

**To verify where focus goes around an async settle, record a focus trail instead of reading
`document.activeElement` once.** A single read after waiting on some UI change races the settle: the
focus move and the change you waited on land in the same tick, so the read can run before the move and
report the wrong element. Before driving, install a capture-phase `focusin` listener that pushes
`{t: performance.now(), tag, id}` into an array on `window`. Then wrap the preview's stubbed
`window.fetch`: delay the target route (for example `/api/meetings/delete`) by a second or two, and
record the resolve timestamp on `window` when it settles. Drive the flow, wait until that timestamp
exists, then compare the trail against it — the entries after the resolve time are the focus moves the
settle caused. Working runner: `r15-1-delete-focus-trail.js` in
`t3-chat-+personal/+ai/r15-1-2026-08-23/`.

For a walk-away check, make the stub delay much longer than the walk-away clicks — 4 seconds, not 1.5.
Playwright's actionability retries can spend more than a second per click, so with a short delay the
walk-away can land after the settle and the run silently measures the focus-was-still-in-the-card case
instead. Read the walk-away's own timestamp and confirm it is before the resolve timestamp before
trusting the run (`r15-1-delete-focus-walkaway-fix.js` in the same folder does both).

**`Delete after processing` is the one genuinely `disabled` control** (bare `disabled`, on a card whose
status is `processing`). It is disabled from render rather than transiently, so it can never blur focus
to `<body>` — unlike a busy control, which is why every other pending control here uses `aria-busy`
instead. Do not "fix" it to match the others.

**axe reports contrast on this route as `incomplete`, not as a pass.** A run with the delete
confirmation open gives `violations: []` and `passes: 28` — but also **60 `color-contrast` nodes under
`incomplete`**, because axe cannot resolve the effective background. The violation count therefore says
nothing about contrast here. Resolving the background by walking the ancestor chain and computing the
ratios directly gives 28 distinct text styles, **all passing**, the closest being `.button-primary` at
**4.94:1** (`#5461e8` on white text, 14px/650). So the route really is clean — but only the direct
computation proves it, and a future change to those colours will not show up in the violation count.

The list polls every 5 s and never stops. Waiting for polling to end never ends.

### Running the preview under the host's sandbox

For ordinary dashboard QA, drive `preview.html` as a plain top-level page. Every locator is direct and
`snapshot()` works. Only wrap it in an iframe when the check is about the **deployed** condition — the
plugin runs inside the app's sandboxed frame, and that is what decides whether a Copy button, a form
submit, or a storage read works at all. The host frame is
`packages/app/src/components/plugins-ui-frame.tsx`, and it renders
`sandbox="allow-scripts allow-same-origin allow-forms"` with `allow="clipboard-write"` and
`referrerPolicy="no-referrer"`. Copy those three attributes exactly; a missing token changes what the
page is allowed to do.

Navigate a page to the preview origin first, then inject the frame, so the relative `src` resolves:

```js
state.p = await context.newPage();
await state.p.goto("http://localhost:5199/index.html", { waitUntil: "domcontentloaded" });
await state.p.evaluate(() => {
	const frame = document.createElement("iframe");
	frame.id = "qa-plugin-frame";
	frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
	frame.setAttribute("allow", "clipboard-write");
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.style.cssText = "width: 1000px; height: 700px; border: 0;";
	frame.src = "/preview.html?state=ready";
	document.body.appendChild(frame);
});
state.frame = state.p.frames().find((f) => f !== state.p.mainFrame() && f.url().includes("preview.html"));
```

`index.html` is the shell to use. Outside a plugin host it fails its handshake and renders one line,
`Missing host bridge fragment — the page must be embedded by the Bonobo host app`, with no `.council`
root — so nothing on the outer page can be mistaken for the dashboard inside the frame. A second
`preview.html` would render a whole second dashboard and every reading would become ambiguous. That line
carries `role="alert"`, so scope a role lookup to the frame rather than searching the outer page for
alerts.

One thing this does not reproduce: parent and frame share an origin here, so the frame stays in the same
process. The real host frame is cross-origin and out-of-process. The sandbox rules are real, the process
isolation is not.

Which handle each call accepts, all verified 2026-08-22 on playwriter 0.4.0 against this same-origin
frame:

| Call | Result |
| --- | --- |
| `frames().find(...)` then `frame.evaluate(...)` | works — this is the real `Frame` |
| `frameLocator("#qa-plugin-frame")` clicks and role queries | works |
| `getCleanHTML({ locator: frameLocator(...).locator(...) })` | works — reads the frame |
| `locator.contentFrame()` | a **FrameLocator**: no `evaluate`, no `url` |
| `snapshot({ frame })`, with either handle | throws `Frame with the given frameId is not found` |
| `snapshot({ locator: frameLocator(...).locator(...) })` | **silently returns a different tab** |

The last row is the expensive one, so do not reach for `snapshot()` inside this frame at all. Asking for
the frame's `.council` root returned a tree byte-identical to `snapshot({ page })` of the shared default
`page`, which at the time was a leftover Council **room** tab — so the answer was a full, plausible
accessibility tree of a surface the run was not testing, with no error anywhere. The locator itself is
fine; the same locator with a selector that does not exist waits and times out against the frame, as it
should. It is `snapshot()` that reads the wrong surface. Use `getCleanHTML` for structure and
`frame.evaluate` for exact values. The cross-origin half of this is the plugin-frame entry in
`known-hazards.md`.

## Traps

- **`.call-notices` still sits on top of the top-row pins, it just no longer eats their clicks.**
  The box is `pointer-events: none` and only `.audio-recovery` takes pointer events back, so with
  `Connection lost. Reconnecting…` showing, `elementFromPoint` at every visible pin centre answers
  `participant-pin` at 1440x900, 1024x600, 720x450, 390x844 and 320x640. Before r9 the status line
  took pointer events too and answered `call-status` for two to three of five pins. The notice is
  still painted over those pins, though — a screenshot check will see them covered while a message
  is up, and that is the current design, not a regression.
- **Every control-bar hit test reads false while `#host-confirm` is open.** The dialog is
  `position: fixed; inset: 0; z-index: 30`, so it covers the viewport and `elementFromPoint` returns it
  at every control coordinate — at every viewport size, which reads as a real reflow finding rather
  than as leftover state. Observed 2026-08-22: a reviewer reported the bar unreachable at 1440x900 and
  390x844, then found the dialog left open by the previous step in the same runner; with it closed, all
  five controls and every `.participant-pin` hit-tested true at 1440x900, 390x844, 1024x600 and
  720x450. Assert the dialog is hidden in the same runner that does the hit test, and say that you did.
  Same shape as the tooltip-portal and Playwriter-toolbar traps in `known-hazards.md` — a bare overlay
  answering for the control underneath it.
- **A `route` handler that just returns falls through to the real Worker.** To hold a request open,
  `await new Promise(() => {})` inside the handler. Returning early instead makes the Worker answer,
  and the "hang" check silently tests the happy path.
- **The preview patches `window.fetch`, so `page.evaluate(() => fetch(...))` is answered by the page's
  own mock**, not by the network. A probe meant to ask "is the server up?" came back 404 from the stub
  while the server was serving normally. Ask from outside the page or from the shell. Full entry in
  `known-hazards.md`.
- **`locator("#host-confirm[hidden]").waitFor()` can never resolve** — it waits for a hidden element to
  become visible. Use `page.waitForFunction(() => document.getElementById("host-confirm").hidden === true)`.
  Same for every `#view-*`. `round1-f3-close-wedge-sweep.js` still has the broken form; the later
  `round1-f3-close-deadline.js` has the working one. Full entry in `known-hazards.md`.
- **`auditAccessibility` runs on the install-time page.** These recipes all use `context.newPage()`, so
  the harness still points at the CLI's `about:blank` tab and the audit answers
  `{ url: "about:blank", controlCount: 0, … }` — which reads exactly like a clean surface. Set both
  `state.page` and `state.appPlaywriterHarness.page` to your page first, and read the `url` field
  before believing any result. Full entry in `known-hazards.md`.
- **To learn what a screen reader actually receives when a field is refused, read it synchronously
  inside the field's own `focus` event.** Reading the `aria-describedby` target a few hundred
  milliseconds after the refusal shows the finished message and hides whether that text existed yet
  at the moment focus arrived — so it fails in the direction of "no problem here", which is the
  direction that costs a run. Attach a `focus` listener on the field, resolve `aria-describedby` and
  read its text inside that handler, and run a `MutationObserver` over
  `[role="alert"],[role="status"],[aria-live]` across the whole refusal so you also catch a live
  region that announces late or never. What the user hears is what existed when focus landed, not
  what the DOM settled on afterwards. The room's own lobby name refusals do write the message before
  they call `focus()` (`joinMeeting` in `room-client/src/join.ts`, the empty and 128-byte checks) — but that ordering is the
  thing to prove, not the thing to assume.
- **The client's own deadlines are 30 s each** — join, start recording, close, and the guest session
  (which also covers the ticket exchange and the cookie resume) — and the meeting-state poll is 10 s. A wedge check has to sit through a real 30 s, so give `waitForFunction`
  a 60 s timeout and remember the Playwriter CLI's own `--timeout` defaults to 10 s.
- **The room is `frame-ancestors 'none'`.** It cannot be embedded anywhere, the app included, so drive
  it as a top-level page. Its CSP also allows only the SDK, API, and socket origins; a fetch you add
  to any other host is blocked by the page, not by the network.
- **Aborting the SDK URL logs a script-load error.** That console line is the setup working, not a
  failure. Read `getLatestLogs({ page, sinceLastCall: true })` after each action anyway — the room
  swallows most provider errors on purpose. Passing `page` does not scope that buffer to your page,
  though, and this is the route where it bites hardest: leftover room tabs from earlier sessions keep
  hitting `127.0.0.1:8787` and drop their own `401`/`502`/`503` lines into the same buffer, which
  reads exactly like a broken route mock. Confirm any status on a `page.on("response")` listener of
  your own before acting on it. Full entry in `known-hazards.md`.
- **`#host-confirm` is always mounted**, like the app's dialogs. Its `hidden` property is the state,
  and `#host-confirm-yes` disables itself while a close is in flight while `#host-confirm-cancel`
  stays enabled as the way out. Escape aborts the request, not only the dialog.
- **End meeting stops the recording before kick-all.** There is no Stop in the room. Confirm
  (`#host-confirm-yes`) hits `/room/api/host/close`, and that path stops the provider
  recording while people are still in the session, then kicks everyone. Start recording now
  uses composite `POST /recordings`, not per-speaker track. Track start still hung
  on 2026-08-27 (`Stop first 27 Aug`, ~13 minutes, no Stop: RealtimeKit
  `UPLOADING`, duration 0, no download URL). Composite start on the same day
  (`Composite first 27 Aug`, ~14 minutes 37 seconds, no Stop) finished
  RealtimeKit `UPLOADED` with duration above 0 and both download URLs. After the
  billed workspace could store plugin files, Council saved the mixed video,
  mixed audio, transcript, and summary and the card showed Ready plus
  Recording. Do not wait on `UPLOADED` in the room — the close budget is 30 s.
  Do not Join from QA Edge for this check.
- **The dialog opens with focus on Cancel**, not on the confirm button, and Cancel keeps focus while
  the close is pending — both Tab directions are trapped onto it because it is the only control left.
  So `activeElement` is `#host-confirm-cancel` both at open and during the request. Do not expect the
  destructive button to be focused at either moment.
- **A successful close fully resets the dialog** — `hidden` back to `true`, `#host-confirm-yes`
  re-enabled and relabelled `End meeting`, `#host-confirm-text` restored, and `#end-meeting-button`
  re-enabled. This matters only if you drive a second call in the same document: without the reset the
  next call would start underneath a modal saying a running meeting is being ended. If you are
  asserting a clean second call, assert those five things rather than `hidden` alone.
- **`context.cookies(url)` hides the room cookie when the url is `http://`.** The session cookie is
  `__Host-council_session`, which is always `Secure`, and Playwright's URL filter drops Secure cookies
  for an `http` url. So `cookies("http://127.0.0.1:8787")` returns `[]` while the cookie is stored and
  the browser is sending it happily. That empty list makes a visitor with a live session look exactly
  like a visitor with no session, which is how a wrong-meeting check can record a false pass. Call
  `context.cookies()` with no argument and match on the name.
- **A live Worker that still serves an old `ROOM_REVISION` resumes `{}`.** Tree `client.ts` sends
  `{ meetingId }` on boot so a leftover `__Host-council_session` cannot put a guest URL into another
  meeting. The deployed room can lag that by many revisions. Measured 2026-08-26 before deploy: the
  live Worker served `council-room-r3` while the tree was `council-room-r28`, and `resumeOrGuest`
  posted `{}`. Opening `/room?m=<liveMeeting>` in a profile that had earlier consumed a host ticket
  then showed the **old** meeting's lobby (Role Host, old title, old deadline) and Join answered
  `This meeting has ended. It cannot be joined anymore.` The `?m=` meeting was still `open`. The tell
  is lobby title ≠ URL id.
  After deploying this package (Worker version `2df566c7-a207-47db-b965-4deea1c2ff95`, same day),
  the same leftover cookie plus the same guest URL posted `{ meetingId }`, the resume answered 401,
  and `#view-guest` appeared. That is the current served behaviour only while the served marker
  still matches the one your build printed. Compare the served `council-room-revision` before
  blaming the tree. Do not Join from the QA Edge profile.
- **A browser cannot reach the guest join without `CF-Connecting-IP`.** `COUNCIL_ALLOW_MISSING_CLIENT_IP`
  is `"false"` in `wrangler.jsonc`, and only Cloudflare's edge sets that header, so
  `POST /room/api/guest-session` from a local browser answers `400 Missing client address` before it
  looks at anything else. Add it for the whole page:
  `await page.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.9" });`
- **CDP will not let you inject a `__Host-` cookie over `http`.** `addCookies` answers
  `Protocol error (Storage.setCookies): Invalid cookie fields` whether you pass `url` or
  `domain` + `path`, with `secure` either way. Do not fight it: join the meeting for real through
  `/room/api/guest-session` and let the Worker's own `Set-Cookie` land. It is also the better check,
  because it exercises the path a visitor actually takes.
- **A fixture meeting must have a future `deadline_at`, not just `status = 'open'`.** Both join guards
  in `routes-room.ts` refuse a null deadline with the same
  `This meeting has ended. It cannot be joined anymore.` that an expired meeting gets, so a hand-built
  row with only the status set looks like a closed meeting. Grep that message: it has three call sites
  now, and the two that matter here are the host and guest join paths.
- **At 512x384 two `.participant-pin` buttons always come back as `blockedHitTargets`, and they are
  fine.** The stage scrolls its second row out of view there: `.participant-stage` runs y 56..221 and
  those two pins sit at y 229..273, about 52px below the scroll bottom. They are clipped, not
  covered. This is the documented half-scrolled case, so check the numbers before treating it as a
  finding — scroll the row into view and the entry disappears. Measured on `council-room-r13`.
  **It happens at 320x256 too** — one pin at y 79..123 while the stage runs only y 56..93, so it sits
  about 30px below the scroll bottom. Do not read the second size as a new finding: it was A/B'd on
  `council-room-r17` by injecting `.control-label { white-space: nowrap !important }` to reproduce the
  pre-wrap layout, and the same pin is blocked either way. Treat any `blockedHitTargets` entry on a pin
  as this case until the numbers say otherwise — compare the pin's rect against the stage's scroll
  bottom before writing it up.
  **Read the new `blockedPoints` field before you judge any entry.** Harness 0.6.3 hit-tests the four
  inset corners as well as the centre, so an entry can now mean "one edge is covered" rather than "this
  control is unreachable". `topAtCenter` keeps its old meaning and is `null` when only an edge is
  covered; `blockedPoints` names which of the five samples resolved elsewhere. Before 0.6.3 the audit
  tested the centre alone, so an edge-covered control returned a clean pass — every
  `blockedHitTargets: []` recorded by an earlier round is weaker evidence than it looks.
- **Never click `#leave-button` in the middle of a measurement.** It is the one control in the bar
  that ends the run rather than changing it: the click calls `endLocally("You left the meeting.", true)`
  (the `#leave-button` listener in `client.ts`), which sets `state.over`, tears the call down and switches to `#view-ended`. Every
  later read then measures the ended screen. Nothing throws and no locator fails, because the ids the
  runner asks for are still in the document — they are just hidden and stale, so a sweep that walks the
  control bar keeps returning plausible numbers for a call that is over. If a sweep touches controls by
  position or iterates the whole bar, exclude `#leave-button` and `#end-meeting-button` by id, and
  assert `#view-call:not([hidden])` between steps.
- **Forcing `button.disabled = false` does not make `#start-recording-button` fire.** The disabled
  attribute is the symptom, not the gate: `startRecording` returns immediately unless
  `recordingCanStart()` is true and no recording is active (`startRecording` in `client.ts`).
  `recordingCanStart()` is `state.recordingStage === "idle" || state.recordingStage === "unsaved"`.
  Re-driven on `council-room-r22` in the `unavailable` stage — setting `disabled = false` from
  `page.evaluate` and clicking produced **zero** `/room/api/host/start-recording` requests, no
  `aria-busy`, no label change and an empty `#host-error`. That silence is the trap: the click reports
  success, so a runner that only checks "did the click throw" records a pass for a request that never
  left. Reach the stage through the client instead, and count the requests rather than trusting the
  click.
  **Do not read this the other way round, as "a press outside `idle` is inert".** `unsaved` is not
  `idle` and its press really works. Measured on `council-room-r22`: after a mocked 500 the control is
  `{ label: "Start recording", disabled: false }` with focus on it, and pressing it again really sent
  a second request — the route mock's own counter went up by one. The label then reached
  `Recording requested`, and the end dialog moved to the wording that promises files, which is the
  `else` branch of `openEndConfirm`. A driver who believes only `idle` can start will never attempt
  that retry, and will report the control as dead.
- **A `#call-status` line left from an earlier probe contaminates the next one.** The element is
  shared by every notice the room writes, and several of them have no auto-clear, so a check that
  asserts on its text can pass or fail because of the probe before it. Reboot the room between
  semantic groups rather than trusting a clear.
- **To force the "provider broadcast wins the race" ordering, hold the HTTP answer open and fire the
  socket event first.** Route `POST /room/api/host/start-recording` to a handler that awaits a
  promise your runner keeps, emit `recordingUpdate("RECORDING")` on the fake SDK, then resolve the
  promise. That is the only way to reach the branch where the success handler runs after the state is
  already live — the ordering cannot be produced by timing alone.
- **To force the CSRF-rotation recovery, count 401s per path rather than globally.** Give each room
  API path its own one-shot counter that answers 401 on the first call and passes afterwards. A
  single global counter spends its 401 on whichever request happens to arrive first, usually the
  state poll, so the path you meant to test never sees one. Watch the request sequence, not just the
  final status: the recovery is `<path> → session → <path>`, and a check that only asserts the last
  status passes even when no refresh happened.
- **Number mock CSRF tokens from the session count, not from a fixed list.** A fake that hands out
  `csrf-2` for the boot session as well as for the refresh makes "the token changed" assertions pass
  while nothing rotated. Derive the value from `sessionBodies.length` so every issued token differs.

- **A bare `Unauthorized` in `#lobby-error` from Join is a real regression. Do not dismiss it as the
  CSRF rotation.** Join now goes through `apiPostWithCsrfRefresh` (`joinMeeting` in `client.ts`), so a 401 makes the
  page resume the session, take the fresh token and repeat the call by itself. Only a **second** 401
  gives up, and it replaces the message with
  `This room page is no longer the active one. Reload the page.` (`apiPostWithCsrfRefresh` in `client.ts`). The bare word
  `Unauthorized` therefore cannot reach `#lobby-error` from Join at all any more: if you see it, the
  refresh did not run, and that is the finding.
  The shape underneath is still worth knowing, because it decides what a two-page runner sees.
  `/room/api/join` is the only pre-call route that carries the CSRF token; `/room/api/session` and
  `/room/api/guest-session` both mint their own session and need none. So a second document resuming
  the shared cookie session still rotates the token out from under the first page — that is now
  survivable, and the two wordings above are how you tell a rotation that recovered from one that did
  not.

## Recipes worth reusing

Three probes written for the round-6 review that answered questions a plain look at the page could
not. All three are saved as runnable files under
`t3-chat-+personal/+ai/council-production-room-2026-08-22/r6-reviewer1/`. Reuse them rather than
writing your own — each one exists because the obvious approach gave a wrong answer first.

**Fake SDK that mimics the pinned RealtimeKit 2.0.1 device failure** (`room-nomic.js`). This is the
only way to reach the room's join-time media branches. Copy the real 2.0.1 behaviour exactly or the
probe proves nothing: `enableAudio()` swallows the device error in an EMPTY catch, RESOLVES anyway
with `audioEnabled` still `false`, and emits `mediaPermissionUpdate` *during* that call. A fake that
rejects instead takes a branch the real SDK never takes. This is what exposed the room naming a
false cause at join — see the `## The fake RealtimeKit` section above for the base fake to extend.

**Character-level clipping walk** (`room-320-evidence.js`). Turns "something looks cut off" into
"the glyphs `eo` are outside the tile". Walk the text node one character at a time with
`Range.getBoundingClientRect()` and test each rect against the ANCESTOR box that actually owns
`overflow: hidden` — not the text element's own box, which does not clip. Return the shown and
clipped substrings per line. It also distinguishes a real text loss from harmless padding overhang,
which a naive `scrollWidth > clientWidth` check does not: one chip overflowed by 8px and lost
nothing, another overflowed by 21px and lost two letters.

**Focus-indicator probe across both activation routes** (`dash-dismiss-focus.js`). Runs the same
flow twice, once by keyboard and once by mouse, then reads `outlineStyle`, `outlineColor` and
`:focus-visible` off `document.activeElement` — and SEPARATELY asserts whether that element matches
the stylesheet's focus selector list. Run both routes: they disagreed here, and only the mouse route
showed `outlineStyle: "none"`. The keyboard route fell back to the browser's own ring, which looks
like a pass until you notice the page declares no `color-scheme`, so Chromium paints its
light-scheme dark ring on a dark panel at 1.05:1. Checking the selector list separately is what
turns "the ring looks wrong" into "this element is not in the rule".

**Focus-loss trail on the room's own controls** (`07-focus-ticks.js`, `08-broadcast-focus.js` and the
browser calibration `09-calibrate-blur.js`, under
`t3-chat-+personal/+ai/council-room-doc-fixerbc-2026-08-23/`). Reading `document.activeElement`
once after an action tells you where focus ended up. It does not tell you whether focus was ever
lost. The room loses focus and puts it back on purpose — `catchFocusOnCallNotice` in `client.ts` runs
on every path that can close the recording control under the host — so "never lost it" and "lost it
and recovered" are exactly the two cases you need to separate, and one read cannot. Record the trail
instead: `focusin` and `focusout` listeners in the capture phase, plus one read taken in the same
statement that flips `disabled`.

That synchronous read needs a property patch, not a `MutationObserver`. An observer callback is a
microtask, so it already runs after the room's own recovery call in the same block, and it can never
see the state in between. Patch the element's own accessor over the prototype descriptor:

```js
const desc = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, "disabled");
Object.defineProperty(button, "disabled", {
	configurable: true,
	get() { return desc.get.call(this); },
	set(value) {
		const was = desc.get.call(this);
		desc.set.call(this, value);
		if (was === value) return;
		push("sync"); // each push() reads document.activeElement and stamps performance.now()
		Promise.resolve().then(() => push("microtask"));
		requestAnimationFrame(() => { push("raf1"); requestAnimationFrame(() => push("raf2")); });
		setTimeout(() => push("timeout50"), 50);
	},
});
button.focus();
```

**Calibrate the browser before you read the room.** Run the same probe on a `<button>` your own
script creates and appends, with no room code involved: focus it, disable it, and read
`document.activeElement` in the next statement. In the attached Edge, on `council-room-r22`, that
read already said `BODY` and the button's `focusout` had already fired. So **this browser blurs a
disabled control synchronously, and a same-tick read does not report the pre-blur state.** Do the
calibration every time. It is one short block, and without it you cannot tell a room behaviour from a
browser behaviour — which is the whole difficulty here.

Then the room itself, in the attached Edge, on `#start-recording-button` with the fixture the
recording notes above use. The 502 case was measured on `council-room-r22`, the broadcast case was
re-measured on `council-room-r23`:

- **502 — the room loses focus and puts it back.** `focusout start-recording-button` fires before the
  `disabled = true` assignment returns, so the synchronous read already says `BODY`.
  `catchFocusOnCallNotice()` then runs later in that same block, sees the body, and focuses
  `#call-status`. That landing is in the trail before the first microtask.
- **`recordingUpdate("RECORDING")` with no request in flight — the room loses focus and puts it back
  on the recording pill.** The broadcast disables the focused control inside
  `renderRecordingState`, so the synchronous read says `BODY`. `handleRecordingUpdate` then calls the
  recovery. Both notice lines are hidden on this path, but the same render has just shown
  `#recording-indicator`, and the pill outranks the clipped heading in the ladder. Measured on
  `council-room-r25` in the attached Edge: focus lands on the pill with a real keyboard ring,
  `solid 3px rgb(142, 171, 255)` on an 84x20 box, and `:focus-visible` matching. Only when the pill
  is hidden too — the stop edge — does the ladder fall through to `#call-heading`, which is 1px and
  clipped with its outline off: a position in the page and no visible mark. The pair is pinned by
  "catches the host's focus when a recording nobody here started closes the control" and
  "falls back past the hidden pill when the recording stops" in `client.test.ts`.
  **This bullet used to say the landing was the heading and marked nothing, and before that, that
  nothing put focus back at all.** Each was true when written. The ladder grew its pill rung
  afterwards, so re-read `catchFocusOnCallNotice` and `handleRecordingUpdate` rather than trusting
  any wording here.
- **The status line clearing under the host — `hideCallStatus` walks the same ladder.** A host the
  room parked on "Recording is starting." loses that line to the provider's own broadcast:
  `renderRecordingState` shows the pill and then clears the line by prefix, and `hideCallStatus` in
  `setCallStatus` hands the host to the host-error banner, else the visible pill, else the heading —
  the same order as `catchFocusOnCallNotice`, minus the dying line itself. Measured on
  `council-room-r25` in the attached Edge, keyboard-driven: parked on `#call-status` after the start
  answer, then the broadcast landed focus on `#recording-indicator` with the ring painted
  (`solid 3px rgb(142, 171, 255)`, 84x20, `:focus-visible` matching). Before r25 this path parked
  the host on the invisible heading even while the pill was lit — same problem class as the rescue
  above, through a different door. The stop edge is unchanged: the pill hides and focus falls
  through to `#call-heading`. Runner: `02-status-line-landing.js` under
  `t3-chat-+personal/+ai/fixer-bs-2026-08-23/`, on top of that folder's `01-boot-and-join.js`.

Sample out to the second animation frame and the timeout anyway. It costs nothing, and it is what
proves the value settled rather than proving only that you read it early. **Take the measurement in
the attached browser and nowhere else.** The disable-blur entry in `known-hazards.md` records
headless doing the opposite — leaving `activeElement` on the button until the second
`requestAnimationFrame` — and the P2 that reading nearly produced against correct code. A trail taken
there would describe a browser the user does not run.

**Hold a route answer open so the provider broadcast wins the race**
(`06-broadcast-beats-answer.js` under `t3-chat-+personal/+ai/fixer-bk-2026-08-23/`, re-run as
`05-broadcast-beats-answer.js` under `t3-chat-+personal/+ai/fixer-bn-2026-08-23/`). The room's start
button has two things racing for it: this browser's own answer from `POST /room/api/host/start-recording`,
and the provider's `recordingUpdate` broadcast. Both close the control, and each one puts the host's
focus back in a different place. You cannot test the order that matters by emitting faster, because a
mocked route answers almost at once. Hold the answer open instead.

Give the route handler a flag it spins on before it answers. The flag lives on `state`, so a later
step can release it from outside the page:

```js
if (path === "/room/api/host/start-recording") {
	// Let a later step hold the answer in the air so the provider broadcast can win the race.
	while (state.bn.holdStart) {
		await new Promise((r) => setTimeout(r, 50));
	}
	return json(state.bn.startStatus, { message: "QA forced " + state.bn.startStatus });
}
```

Then: set the flag, walk to the control with real `Tab` presses and press `Enter`, emit
`recordingUpdate("RECORDING")` on the fake SDK, read focus, clear the flag, and wait for
`#host-error:not([hidden])` before reading focus again. Press by keyboard, not by
`button.click()` from `page.evaluate` — see the `:focus-visible` entry in `known-hazards.md` for why a
script focus makes every ring read say `none`.

Measured on `council-room-r23` in the attached Edge, holding a 500:

1. **Pressed, answer held.** The control keeps focus and its ring, and its label reads the pending
   wording. It marks itself busy rather than disabling itself, which is what lets it keep focus.
2. **Broadcast lands, answer still held.** The control turns disabled and focus drops to `BODY` —
   and it stays there. No rescue runs, because `handleRecordingUpdate` skips it while this browser's
   own request is still in the air.
3. **Answer released.** The banner appears and focus lands on `#host-error`, with a real ring.

Step 2 is the whole point. A rescue there would park the host on the recording pill — the broadcast
has just shown it — and the answer's own recovery in step 3 only acts on a host who is on the body,
so it could no longer claim them: they would be left on the pill instead of on the sentence
explaining what happened.

Two tests in `client.test.ts` pin that order, and dropping the guard in a scratch copy took both of
them red, each on the assertion that matters. Re-run on the `council-room-r25` sources — since the
ladder grew its pill rung, the stray landing in both wordings is the pill, not the heading:

- "leaves the answer to put the host back when the broadcast beats it" —
  `expected <p class="room-recording"> to be <body>`, the rescue firing when it should not.
- "gives focus back when a held start-recording request fails behind a live broadcast" —
  `expected <p class="room-recording"> to be <p class="host-error">`, the answer no longer able to
  claim a host who is not on the body.

The second one is the damage, and it only appears one step after the mistake. Mutate the guard rather
than reading it if you ever need to re-check this.

**Two documents sharing ONE session row** (`r6-reviewer2/06-lobby-csrf-deadend.js`,
`07-two-tab-in-call.js`). The room's CSRF behaviour only appears when both pages share a single
server-side session, so give both pages route handlers that close over one `server = { csrf }`
object and rotate it on `/room/api/session`. Two separate mocks with separate state cannot show it.
This is faithful to `resume_room_session`, which rotates the token unconditionally on every valid
resume. It is the only way to reproduce either the in-call ping-pong (which works) or the lobby dead
end (which did not).

**Modal focus-trap probe** (`r6-reviewer2/09-dialog-shift-tab.js`, `16-leak-triggers.js`). Open the
dialog, click something inside it that is NOT a button — the backdrop, the heading, the warning text
— then press Shift+Tab and read `byId("host-confirm").contains(document.activeElement)`. Clicking a
non-button puts focus on `<body>`, and a trap written as `activeElement === firstButton ||
activeElement === lastButton` does nothing from there. Always include a no-click control run: the
trap holds in that case, which is why this survives casual testing.

## Proving a room fix in this package's unit tests

Browser QA on this page pairs with the room test files in `packages/council`, and a
break-on-purpose proof has to run ONE named test. The package is its own repository with its own
vitest (installed by `vp env exec pnpm --dir packages/council --ignore-workspace install`; the
root install does not cover it). The test path is relative to `packages/council`, not to the repo
root:

```powershell
vp env exec pnpm --dir packages/council exec vitest run room-client/src/client.test.ts -t "<test name>"
```

The client behavior tests live in `room-client/src/client.test.ts`; the markup and CSS claims in
`room-client/src/room-document.test.ts`; the source-text claims in
`room-client/src/client-source.test.ts`.

`vp env exec pnpm --dir packages/council run test` stays the gate for the whole suite.

Two happy-dom facts decide whether a focus test proves anything here. happy-dom does **not** blur a
focused control when it turns `disabled`, and `blur()` on an already-disabled control does nothing
either. A test that means "the browser dropped focus when the control turned disabled" must
`blur()` first and disable after. Written the other way round the control keeps focus, the recovery
branch never runs, and the test passes with its fix removed.

## Measuring what the tiles cut off

The tile clips, not the chip. `.participant-tile` sets `overflow: hidden` and `.participant-meta`
does not, so a chip can sit outside its own row and still paint in full. Compare each chip's rect
against the **tile's** rect, and read `scrollWidth`/`clientWidth` beside it: a chip whose box
overhangs can still show all its text. At 320x256 `.participant-mic` overhangs its tile by 8px and
stays readable, while `.participant-video-state` lost two letters and read "No vid".

Resize the meeting without re-booting the page. That is what separates a layout bug from a
participant-count bug, and the fake's `joined.toArray()` reads `window.__councilQa.remotes` live:

```js
const qa = window.__councilQa;
qa.remotes.length = 2; // host + 2 peers => featured, data-side-columns="1"
qa.joined.emit("participantsCleared");
for (const peer of qa.remotes) qa.joined.emit("participantJoined", peer);
```

Sweep counts 2–5 against widths 320–410 before writing any chip rule. That sweep is what showed the
"No video" clipping belongs to `[data-side-columns="2"]` side tiles below 410px and to nothing else:
the featured tile is 123px wide at 320x256 and shows the chip whole, three-person rooms give 97px
side tiles, and from 410px the two side tiles are back to 90px.


## Two checks that only fail in a state you have to drive to

Both come from the round-9 review, and both exist because the default state of the room passes the
check while a state a real user reaches does not.

### Drive every `RECORDING_LABELS` value before calling a reflow sweep clean

The technique here is still the point. `RECORDING_LABELS` (`client.ts`) has six stages and five
strings, and the short one, `"Start recording"`, covers two of the six stages: `idle` and `unsaved`.
It fits everywhere. The longest, `"Recording unavailable"`,
measures 125px at the shipped 12px label size, and it is the string every width in `room-client/room.css` is
derived against. A sweep that measures the **idle** control measures the one value that cannot fail —
and so does a sweep that measures `unsaved`, which looks like a driven state and is not a wider one.
Nine rounds of reflow sweeps in this loop reported the room clean for exactly that reason.

Drive the state through the client, not by hand — set the label text directly and you are measuring your
own string, not the app's:

- 502 or block the recording endpoint so `renderRecordingState` writes `"Recording unavailable"` itself.
- Then read `getBoundingClientRect()` on `#start-recording-button .control-label` and compare it against
  **its own control's** right edge and against `#end-meeting-button`, the control it can reach into.
- Also read `document.documentElement.scrollWidth`. The phone block sets `html, body { overflow: hidden }`,
  so overflowing text is **not** reachable by scrolling — a clipped label is simply gone.

**The phone-width overflow this section used to describe is fixed. Do not go hunting for it.** The
paragraph here claimed `.control-label` was `white-space: nowrap` everywhere and that four of the five
labels overflowed "on every common phone width". Both halves were true before round 9 and false after
it: the phone block and the short-landscape block each override the label to `white-space: normal`
(`page.ts`), so the label wraps to two lines and sits inside its control. Measured on
`council-room-r18` with `"Recording unavailable"` on screen, all in `white-space: normal`:

| Window | Label vs its own control | Label vs `#end-meeting-button` |
| --- | --- | --- |
| 390x844 | 8px inside | bar wrapped — see below |
| 430x932 | 6px inside | 14px gap |
| 360x740 | 8px inside | bar wrapped — see below |
| 320x640 | 8px inside | 16px gap |
| 320x256 | 9px inside | 17px gap |
| 512x384 | 9px inside | 17px gap |

Every one of the old "overlap" figures is now a gap. Two reading traps in that table: the numbers are
**clearances**, so a bigger number is healthier, not worse; and on the narrowest phones the bar wraps
to two rows, which puts `#end-meeting-button` on a different line from the recording control. A raw
`labelRight - neighbourLeft` then compares controls that never meet and returns a large positive
number that looks like a catastrophic overlap. It was +364px at 390x844. Check that both controls
share a row before reading that subtraction at all.

The cost of leaving this paragraph wrong was not a re-introduced bug — it was a reviewer's whole
measurement round this session, spent verifying an overflow that r17 already did not produce.

#### The middle block: a landscape window 600–638px wide

Neither override reaches every window, and the gap between them is a real one that ten rounds never
drove. The phone block is `(max-width: 760px) and (aspect-ratio <= 1/1)`, so a **landscape** window
never matches it. The short-landscape overrides live in
`(max-height: 650px) and (aspect-ratio > 1/1) and (max-width: …px)`, and that last term used to be
`599px`. So a landscape window 600px wide and wider kept the base `nowrap` and the floating bar, and
`"Recording unavailable"` painted straight out of its control into `End for all`. Measured at height
450 before the fix, with `nowrap` and an 88px bar: 19px outside its own control and 11px into the
neighbour at 600px, shrinking to first contact at 622px, and clear of its own control by 638px.
`aspect-ratio > 1/1` already means width > height, so the `max-height: 650px` term is implied inside
that band and you do not need to satisfy it separately.

**Write the resolution down rather than re-deriving it, because the obvious fix is the wrong one.**
Round 9 left a note saying only two of the three control-sizing blocks needed the treatment and that
nobody should "complete" the fix by adding a third. That note's *reason* was wrong — the middle block
is not exempt, it has a real defect — but its *conclusion* was right. The trap is writing a **new
third block that sets `white-space: normal` and nothing else**. Two reviewers measured that
independently and rejected it: wrapping the label grows the control bar from **88px to 106px**, and in
this band the bar is still floating over the stage, sized from the 566px control-width derivation
(`page.ts`, the 566 + 40 + 20 + 2 = 628 comment). A taller floating bar there eats the stage rather
than sitting under it.

Read that together with the second part of the landed fix below, or the two look contradictory:
`white-space: normal` **is** what the band ends up with. What makes it safe is that it arrives as part
of the whole short-landscape block, which also takes the bar out of the float. The wrap is fine; the
wrap without the rest of that block is not.

What landed instead, in two parts:

- `pointer-events: none` on the **base** `.control-label`. The label is text on a button and never a
  target of its own, so taking it out of hit testing hands the press back to whichever control is
  painted underneath. This changes no geometry at all — the overlap still paints, it just stops
  stealing the click. Verified at 600x450: `elementFromPoint` on the covered strip answered
  `end-meeting-button`, and `auditAccessibility` on `.control-bar` returned `blockedHitTargets: []`
  with `#host-confirm` confirmed hidden.
- The short-landscape breakpoint moved from `max-width: 599px` to `max-width: 659px`, which brings the
  existing block's whole rule set into the band — including the un-floated bar that makes the 106px
  height acceptable there. The number is 659 and not 622 or 638 on purpose: 660px is the width a
  reader can re-derive from the labels, and the width where the first pixel of overlap happens is not.
  Do not move it down to match a measurement.

After both parts, the same sweep at height 450 reads `white-space: normal` from 599px through 659px
with the label 9px inside its control and 17px clear of the neighbour, and `nowrap` with the bar back
to 88px and capped at 628px from 660px up.

One process note worth more than the numbers: the breakpoint landed **between two of the measurements
above**, in the same session, without the `ROOM_REVISION` marker moving. The same room served two
different layouts under one revision string. That is the concrete reason the stamp at the top of this
file says a matching revision proves staleness and not completeness.

### Read `aria-pressed` and the accessible name together, in both states

Either one alone looks fine. A toggle button that flips its `aria-label` to the next *action*
("Turn microphone off") while `aria-pressed` reports the current *condition* (`true`) is contradictory,
and you only see it when you read the pair in the same snapshot, in both states.

Use the CDP AX tree (`Accessibility.getPartialAXTree`), not the DOM attribute alone, because the
accessible name may come from element content rather than a label. Note `page.accessibility.snapshot()`
is gone from the Playwright build Playwriter 0.4.0 ships — it throws
`Cannot read properties of undefined (reading 'snapshot')`. Go through `getCDPSession` instead:
`Accessibility.enable`, `DOM.getDocument`, `DOM.querySelector`, then `Accessibility.getPartialAXTree`.

**The room does not have one of each pattern. Both of its toggles are already correct, and only
`.participant-pin` changes its name.** Read it as the positive example, not as a calibration pair:

- `.participant-pin` — the name leads with the state and still contains the visible text. Measured on
  `council-room-r18`: `"Pin Casey"` with `aria-pressed="false"`, `"Pinned — unpin Casey"` with
  `aria-pressed="true"`. That is the shape WAI-ARIA APG and WCAG 2.5.3 both want.
- `#mute-button` / `#camera-button` / `#share-button` — **the name does not move.** All three write
  only `aria-pressed` and take their accessible name from the `.control-label` text in the markup.
  Measured on the same build, in both states: `aria-label` is `null` and the AX name stays
  `"Microphone"`, `"Camera"`, and `"Share"` while `aria-pressed` flips. Share is pressed only when
  this browser has a share **video track**, not when `enableScreenShare()` resolved. Chrome's
  floating Stop sharing bar ends the capture and emits `screenShareUpdate` without clicking Share.
  After that stop, `#share-button` must already be `aria-pressed="false"`. A failed in-app stop
  must say it could not stop, not that the screen-share permission is missing.

That is a decision somebody made, not an omission. The reason is written in the comment at the top of
`renderLocalControls` in `client.ts`, and the test
`"names the media controls from their visible text in both states"` in `client.test.ts` pins it: it
asserts `aria-label === null` and the visible names in the first state, clicks both controls, waits
for each `aria-pressed` to flip, and re-asserts all three. Its comment ends "Do not add one back as a
fix." So adding an `aria-label` here is not a fix — it is a red test.

Both pointers are given by name on purpose. `client.ts` and `client.test.ts` move constantly: while
this section was being written the test slid from line 1255 to 1278 and `renderLocalControls` from
1166 to 1213, in one session. Grep for the name.

This section used to claim the opposite: that the two toggles flipped their names, and it cited
WCAG 2.5.3 Label-in-Name as the reason to change them. The citation was right about the rule and wrong
about the room. A name that changes with state **is** a Label-in-Name problem whenever the visible text
stays put — a button reading "Microphone" on screen whose accessible name is "Turn microphone on"
leaves a speech-input user saying "click Microphone" reaching nothing. That is exactly why the room was
built the way it is. Keep the past tense: it is the reason for the current shape, not a defect to go
and find.

## Scoring a busy control, and why the obvious probe passes it

Both the room (`room-client/room.css`) and the dashboard (`council.css`) mark work in flight with
`aria-busy="true"` on a `.button`, and the label is the only progress feedback a user gets. So the
label's contrast in that state is a real WCAG 1.4.3 question, and it is one a look at the page cannot
answer — a faded button looks fine next to a bright one.

Read the numbers out of the page and do the compositing yourself. Three things decide whether the
answer means anything:

- **Calibrate in both directions, in the same call that measures.** Send the probe a known-good sample
  and a known-bad one built from the same colours. A probe that only agrees with the resting control
  proves nothing about the faded one. The group-`opacity` layer model is easy to get wrong and the
  wrong model reports a **pass** — see the contrast entry in `known-hazards.md`.
- **Kill the transition before you read.** `el.style.transition = "none"` first. On a backgrounded tab
  the frames stop, the transition freezes on frame one, and `getComputedStyle` hands back an opaque
  `oklab(...)` that looks like a broken stylesheet. Same entry in `known-hazards.md`.
- **Parse `color(srgb r g b / a)`, not just `rgb()`.** `color-mix()` computes to that form. A parser
  that only knows `rgb()` returns null, and null reads as a broken page rather than a missing case.

The exemption question is settled by the DOM, not by how the control looks. WCAG exempts an *inactive*
component; a busy one here is not inactive. Measured on `council-room-r22`: a busy `#join-button`
reports `disabled: false`, `aria-disabled: null`, `tabIndex: 0`, matches `:enabled`, and keeps focus.
It is still in the tab order and its label is still the sentence being read, so the exemption does not
apply and the ratio counts.

One CSS trap when fixing this. `.button[aria-busy="true"]` is (0,2,0) and out-ranks `.button-primary`
at (0,1,0), so a single `background` on the generic selector repaints a busy primary in the plain grey
fill — the wrong-colour swap the existing hover comments in both files already warn about. Dim per
family (`.button-primary[aria-busy="true"]`, `.button-quiet[…]`, `.button-danger[…]`) instead.

Ratios over a translucent fill are **floors, not point values**. The fill lets the `.council` radial
gradient through, so the same button measures a slightly different ratio depending on where it sits.
Phrase a comment as "stays above X anywhere on the gradient" — that survives a re-measure, and it is
the fact that matters.

Runners: `t3-chat-+personal/+ai/fixer-av-2026-08-23/fixer-av-verify-after.js` measures room and
dashboard in one pass with both calibration samples inline.

## Matching `.host-error` to the floating control bar

`.host-error` is `position: absolute` with a `bottom` offset, and the control bar floats above it, so
the banner is only clear of the bar when that offset clears the bar's **whole footprint** — the bar's
own height plus the gap it is held off the viewport bottom. Do not trust the number already in the
rule. Measure the bar and derive the offset:

- Desktop: bar 100px + 18px offset = **118px**. The base `.host-error` said `bottom: 106px`, so the
  banner sat 12px under the bar. Measured at 1440x900 and 1280x800 on `council-room-r22`.
- Short landscape (`@media (max-height: 620px) and (orientation: landscape)`): footprint **106px**,
  rule said 96px, 10px under. Measured at 900x600 and 683x384.

`.participant-stage` already carried the right numbers in both blocks — its bottom padding is the same
footprint. When one moves the other must move with it, which is why both `page.ts` comments now say so.

Hide the other views before hit-testing the bar. The room's own client script switches views while you
work, and an A/B over `#view-call` that does not pin the view reports the banner blocked by
`view-lobby` or `view-card` — a fixture artifact that looks like a finding. Set `hidden = true` on
`view-loading`, `view-guest`, `view-ended`, `view-error` and `view-lobby` first.

### `button.participant-pin` "blocked by `#room-header`" is a scroll artifact

An audit of a scrolled stage can report pins blocked at all five points by `#room-header`. It is not an
overlay. `#room-header` is `position: static` with `z-index: auto` and cannot cover anything. Checked on
`council-room-r22`: unscrolled, all five pins hit themselves; scrolled to the bottom of the stage the
flagged pins report `rect.top: 13` against the stage's own `top: 72`. They have been scrolled up out of
`.participant-stage`, which is `overflow-y: auto`, and `elementFromPoint` at a screen position above a
clipping container answers with whatever paints there — the header. The tell is `rect.top` above the
scroll container's top. Re-check the pin after scrolling it into view before filing anything.
