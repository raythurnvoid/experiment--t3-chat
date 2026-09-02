# Chitchat plugin page

Driving `plugins/bonobo-plugin-chitchat` in its real frame. Read
`references/plugin-marketplace.md` first for the bundle-swap background, and the plugin-frame
section of `references/known-hazards.md` before the first frame command — `snapshot()` answers about
the wrong surface inside any iframe, sometimes silently.

Verified 2026-08-24 against Chitchat 0.1.6 on the dev deployment, and again the same day against the
working-tree 0.1.8 build served through the bundle swap. The private-channel sections were verified the
same day against the working-tree 0.2.0 build, with two signed-in identities. The unreads/views/mentions
sections were verified 2026-08-24 against the working-tree 0.3.0 build, with the owner and viewer
`+clerk_test` accounts in two scratch Chromes.

**0.7.0 (2026-09-02) rewrote the data seam.** The plugin now calls the Convex doors directly with
`convex/react` hooks, because SDK 0.13.0 deleted the `client.data` / `client.members` /
`client.scopes` wrappers. Sections marked below as 0.5.x history no longer reproduce; the sections
on selectors, rows, threads, theme and transcripts still do.

## Route and frame

- The page is `/w/:organizationName/:workspaceName/plugins/chitchat/pages/chat`.
- **The plugin detail route has no link to it.** Only the main app sidebar lists plugin pages
  (`main-app-sidebar.tsx` is the single caller of `list_ui_pages` that renders links), so from
  `/plugins/chitchat` there is no way to click through — navigate by URL or use the sidebar item.
- Get a real Frame handle, never a FrameLocator, for evaluates:
  `state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1)`.
- The frame attaches a beat after `domcontentloaded`. A `frames()` read taken immediately after
  `goto` returns the host page only; wait ~8-10 s, or re-read, before deciding the frame is missing.

## Selectors

Everything below lives inside the frame.

| What | Selector |
| --- | --- |
| Channel rail button | `locator("button.channel-link", { hasText: "#alpha" })` — do NOT use an end-anchored `getByRole` name regex, see the unread-suffix note below |
| Create channel | `getByRole("button", { name: "Create channel" })`, then `getByLabel("Channel name")`, then `getByRole("button", { name: "Create", exact: true })`. Waiting on `[data-dialog-initial="true"]` can hang even when the dialog is already on screen (verified 2026-08-26). For a private channel, `getByLabel("Private channel").check()` before Create |
| Composer | `textarea.composer-input` — with a thread open there are TWO of them, so scope: the channel one by its aria-label `Message #<channel>`, the thread one as `section.thread textarea.composer-input` (aria-label `Reply in thread`). Since 0.5.0 (Ariakit-combobox mention picker) the composer carries `role="combobox"` with `aria-expanded` — the quickest live proof of a 0.5.0 frame. That role replaces the textarea's default one, so `getByRole("textbox")` matches NOTHING on this page and a locator built from it just hangs until the call times out. Use the class selector above. Typing `@` in a single-member workspace opens NO menu (the picker excludes the sender), `aria-expanded` stays `"false"`, and no `[role=listbox]` enters the DOM — verified 2026-08-25 |
| Message row | `li.message`, with `.is-leader` or `.is-continuation`, and `data-key` carrying the document key |
| Day divider | `li.day-divider` |
| Message body | `.message-text` |
| Message row actions | `.message-actions` holding buttons named `Reply in thread`, `Add reaction`, and for your own messages `Edit` / `Delete` — hover-revealed. Delete opens a confirm; click `getByRole("button", { name: "Delete message", exact: true })`. A click on `name: "Delete"` matches both the row action and the confirm and is a strict-mode violation |
| Reaction palette | `span.reaction-palette` (`role=group`, aria-label `Choose a reaction`), inline INSIDE the row — items are `button.reaction-palette-item` named `Thumbs up`, `Heart`, `Laugh`, `Wow`, `Sad` |
| Reaction chip | `button.reaction-chip` (aria-label `<name>, N reaction`), `.is-mine` when you reacted, count in `.reaction-chip-count` |
| Channel row | `.channel-item`, name in `.channel-name` |
| Row actions | one trigger, `button.ChannelRowMenu-trigger` (aria-label `Actions for #<name>`) — hidden at rest, see below. Its items are `role=menuitem` named `People in #<name>` (private rows only), `Rename #<name>`, and `Archive #<name>` / `Unarchive #<name>` |
| Row action menu | `.ChannelRowMenu-popover` (`role=menu`, same aria-label as the trigger) — portalled to the frame's `body`, so it is NOT inside `.channel-item` |
| Any dialog | `[role=dialog]` — only one is ever mounted, so this needs no open-state filter |
| Privacy line | `.channel-privacy` |
| Thread summary | `.message-thread-summary` — body content on a root with replies, so it needs no hover |
| Thread panel | `section.thread` (NOT `.thread-panel`) |
| Resize handle | `[role=separator][aria-label="Resize thread panel"]` |
| Load older control | `getByRole("button", { name: "Load older", exact: true })`, inside `.log-older` |

**There is only one "Load older" button since 0.7.0.** The separate "Load older messages" HTTP
control is gone with the deep-history door, so an older recipe that presses two different buttons
now presses one and reads the second press as a hang. The remaining button is the paginated
timeline's `loadMore` (see "Loading older messages" below).

**The channel row's accessible name changes with its unread state (0.3.0).** The name is the rail
initial plus the channel name plus a suffix: `D#design-reviewunread` when unread, or
`B#build-pipeline1 unread mentions` with a mention count. An end-anchored regex like
`/#design-review$/` matches a read channel and then silently stops matching the moment the channel
becomes unread — the click times out and a chained command reads as if the click landed. A
start-anchored `/^#design-review/` is also wrong twice over: the name may start with the rail
initial, and it also matches the thread-summary button in the Threads view (its text starts with
the channel name), and that ambiguous `frameLocator(...).getByRole(...).click()` crashed the CLI
with the `UV_HANDLE_CLOSING` exit-9 assertion instead of a strict-mode error. Use the class
locator with `hasText` from the table above; `Rename #x` / `Archive #x` are separate elements
without `.channel-link`, so `hasText` stays unambiguous. They are `role=menuitem`, NOT buttons, so
reach them with `getByRole("menuitem", ...)` — a `getByRole("button", { name: "Rename #x" })` matches
nothing and only hangs until the call times out.

**`.channel-link` and `.channel-name` also match the three view rows.** Unreads, Threads and
Activity carry the same classes, so "list the channels" over `.channel-link` answers six rows in a
three-channel workspace. Filter on the leading `#` (channel names always render as `#<name>`) or
scope to the rows under the `CHANNELS` heading before counting.

**Adding a reaction needs no popover hunt.** `Add reaction` toggles `aria-expanded` on itself and
reveals `span.reaction-palette` inline inside the same `li.message`, so a probe that looks for
`[role=dialog]` / `[role=menu]` / `.emoji-picker` finds nothing and reads as a broken control. Hover
the row, click `Add reaction`, then click the palette item by its accessible name:

```js
const row = fl.locator("li.message").nth(i);
await row.hover();
await row.getByRole("button", { name: "Add reaction" }).click();
await row.locator("[role=group][aria-label='Choose a reaction']").getByRole("button", { name: "Heart", exact: true }).click();
```

## Theme: the host's light class does not mean a light plugin

The host sends the frame the app's raw colour scales plus a `mode`. The SDK then writes every scale
onto the frame's `document.documentElement.style` and toggles a root `light` / `dark` class (the
same class names the app's theme provider uses). `chitchat.css` reads ten of those scales as
`var(--color-<scale>-NN, <fallback>)` and keeps its own literals for the rest.

Since 2026-08-24 `mode` is read from the **surface colour** the host actually paints
(`--color-base-1-01`), not from the root `.light` / `.dark` class (`plugins-ui-frame.tsx`). The
app's palette is dark-oriented and the theme provider does not swap it, so a member on "light"
still sees dark surfaces — and the frame correctly stays `dark` there. A run that expects the frame
root to say `light` under the host's light theme is reading the old bug, not a regression.

Check it by reading both sides:

```js
await state.page.evaluate(() => document.documentElement.className) // "light" or "dark"
await frame.evaluate(() => ({
	cls: document.documentElement.className, // "dark" or "light", set by the SDK
	scales: [...document.documentElement.style].filter((n) => n.startsWith("--color-")).length, // 104
	base: document.documentElement.style.getPropertyValue("--color-base-1-01"), // oklch(...)
	surface: getComputedStyle(document.documentElement).getPropertyValue("--cc-surface").trim(),
}))
```

`surface` must equal the host's own `getComputedStyle(document.documentElement).getPropertyValue("--color-base-1-01").trim()`.

To exercise the light branch live, make the host surface genuinely light and then toggle the root
class — the frame's observer watches `class` only, so a style-only change sends nothing:

```js
await state.page.evaluate(() => {
	const de = document.documentElement
	de.style.setProperty("--color-base-1-01", "oklch(0.98 0 0)")
	de.style.setProperty("--color-base-1-03", "oklch(0.95 0 0)")
	de.classList.remove("light")
	de.classList.add("dark")
})
```

The frame then reports `light` while the host class says `dark`, which is the whole point. Remove
both properties and put the original class back afterwards — this writes to the user's own tab.

**That recipe proves the mode switch, but it does NOT give you a screenshot of the light theme.**
Overriding only the two surface scales leaves every `--color-fg-*` step still holding the host's
**dark** value, so the frame paints near-white text on a white ground and almost nothing is
readable. That is the fixture being incoherent, not a plugin bug: a real host sends one consistent
set. Measured 2026-08-24, still true on the raw scales (2026-09-02).

To actually see the plugin's own light palette, strip the host scales so the fallbacks stand:

```js
await frame.evaluate(() => {
	const root = document.documentElement;
	for (const p of [...root.style].filter((n) => n.startsWith("--color-"))) root.style.removeProperty(p);
	root.classList.remove("dark");
	root.classList.add("light");
});
// --cc-surface #ffffff, --cc-text #1b1b20, color-scheme light
```

The next `bonobo:theme` message from the host writes the scales and the class back, so do the
readback right after the strip.

`color-scheme` is declared in both palette blocks (`dark` on `:root`, `light` on `:root.light`)
and a test asserts it. It is what makes the scrollbar match: the frame is its own document, so the
app's own `html.dark { color-scheme: dark }` never reaches it, and without it Chrome painted a light
scrollbar with stepper arrows down the middle of the dark message list.

## Seeding history

`runners/seed-deep-history.js` creates a channel and sends N messages through the real composer.
Budget for losses: at 450 ms between sends, 6 of 20 never landed. Count what the server actually
holds before drawing any conclusion from the row count —
`vp env exec pnpm --dir packages/app exec convex data plugins_data --limit 200` and filter by the
channel key prefix.

## Rebuilding the two-identity QA fixture from nothing

Proven end to end 2026-08-24 against Chitchat 0.3.0 in the `qa-browser` / `home` workspace, driving
two scratch Chromes over direct CDP (owner in one, `member` in the other — see
`clerk-test-accounts.md`). Every send landed on the first try, so the loss budget in "Seeding
history" is about fast unverified sends, not about the composer.

1. **Install first, in the target workspace.** `/w/<org>/<workspace>/plugins/chitchat`, wait for the
   text `Version`, `getByRole("button", { name: "Install", exact: true })`, then `Accept and install`.
   `Accept and install` sits in a dialog that is already in the DOM before you open it, so assert on
   the page flipping to `Installed` / `Uninstall`, not on the button existing. Read the installation
   id back from `convex data plugins_workspace_installations --order desc`.
2. **Create channels** with the recipe in the selector table. The new channel is selected on create,
   so the next create starts from a different channel — that is fine, creation is not scoped.
3. **Send with verification, not with sleeps.** Poll `li.message` count plus the last `.message-text`
   until both match what you sent, then move on. About 250 ms polling and a 500 ms gap between sends
   was enough; nothing was lost across 18 messages.
   **Click `Send` after it is enabled.** Enter while a send is still in flight drops the next
   message (observed 2026-08-25 while seeding 28 rows). Wait for the Send button to be enabled,
   then click it. Do not hold a loop on Enter.
4. **Alternate authors by alternating sessions**, one CLI call per author run. Each session drives its
   own tab, so the other side's rows arrive live and the leader/continuation grouping comes out real.
5. **Threads**: click `.message-thread-summary` when the root already has replies (no hover needed);
   otherwise hover `li.message` and click `Reply in thread`. Reply through
   `section.thread textarea.composer-input`, then `Close thread`.
6. **Unread state for a screenshot** is a two-step: park the reader on a DIFFERENT channel, then have
   the other identity send. Selecting a channel marks it read instantly, so any shot that needs the
   unread rail must be taken BEFORE you click into that channel — you cannot go back without seeding
   more messages.
7. **Read the rail state back** instead of eyeballing the shot: `.channel-link.is-unread`,
   `.unread-dot`, `.mention-badge`, and `aria-current="page"` on the selected row.

## Loading older messages (0.7.0 paginated timeline)

Since Chitchat 0.7.0 the timeline is one Convex hook and nothing else:
`usePaginatedQuery(client.api.plugins_data.watch_documents_page, { collection: "messages", keyPrefix
}, { initialNumItems: 100 })` (`channel-view.tsx:2210`). There is no window manager, no capacity
state and no HTTP door. The old `smallwindow` bundle swaps existed to reach the capacity state, so
they no longer apply to this section — a channel with more than 100 messages is all you need.

`.log-older` holds the single "Load older" button while `timeline.status` is `CanLoadMore` or
`LoadingMore` (disabled while loading, so focus stays on it), and the whole `.log-older` block
leaves the DOM at `Exhausted` (`channel-view.tsx:2956`). So the pass condition for "all history is
loaded" is the **button being gone**, not a sentence — 0.7.0 prints no "you have reached the start"
line at all.

**The load must not touch `/api/v1/plugin-data/list`.** That is the whole point of the door, and it
is cheap to prove from inside the frame:

```js
performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/v1/plugin-data/list")).length
```

Measured 2026-09-02 on published Chitchat 0.7.0 (`personal` / `home`, channel `#deephist`, 103
messages): before the press 100 `li.message` rows and an enabled button, after it 103 rows and no
button, with the count staying at 4 across the press. It is 4 and not 0 because Chitchat's HTTP
**companion** lists (reactions, replies) still use that route; watch the count not change, do not
expect a zero.

**Read the live subscriptions from `client.convex.sync.state.querySet`.** It is a Map whose values
carry `canonicalizedUdfPath` and `args`. Two traps: `args` is the **args object**, not a positional
array, so `q.args[0].paginationOpts` answers `undefined` for every field and the probe reports rows
that look empty rather than failing; and the path key is `canonicalizedUdfPath`, not `udfPath`.
Same run, after the press: 12 subscriptions in total —
`watch_documents` ×4, `watch_changes` ×3, `watch_documents_page` ×3, `watch_recent`, `watch_my_scopes`
— with all three paginated ones on the same collection and `keyPrefix`, `numItems: 100`, one at
`cursor: null` and two at stored cursors. **Do not assert one subscription per press.** Convex's own
`usePaginatedQuery` splits a loaded page in two when the server flags `SplitRecommended` or
`SplitRequired` (`convex/dist/esm/react/use_paginated_query.js:160`), and the door pins
`maximumRowsRead: 100` beside a 100-row request, so the first page reaches that cap by design.

**A loaded page subscribes with `endCursor`, and that run has no row bound at all.** Measured 2026-09-02 on published 0.7.1 in `#deephist`: before the press the two paginated subscriptions both carried `endCursor`, and after it the three were one at `cursor: null` with `endCursor` set, one at a stored cursor with `endCursor` set, and one at a stored cursor with no `endCursor` (the newest page, still growing). Those end cursors come from the split, not from the press: `splitQuery` is the only place `usePaginatedQuery` sets `endCursor`, so a page carries one only after the hook split it, and then keeps it. That is why two of the three carry it before any press. On a run that carries an end cursor Convex ignores `numItems`, reads to that cursor, and also stops enforcing `maximumRowsRead`, because the whole interval has to come back for the answer to be correct. So such a page can hold more than 100 documents, and it can never come back `SplitRequired` from the row cap. What survives there is the soft limit of 75 rows, which flags `SplitRecommended`. Do not expect a `SplitRequired` from this door in the browser.

The runner that does all of this in one call is
`t3-chat-+personal/+ai/plugin-infra-primitives-2026-09-02/load-older.js` (row counts, button state,
resource count) with `query-set.js` beside it for the subscription read.

**0.5.1 swap runner.** After Chitchat 0.5.1 is published, the asset prefix is
`/plugins-ui/hn7j9kpdh4h76he1njpf33dny18d4q1v/`. The working-tree swap for that version lives at
`t3-chat-+personal/+ai/chitchat-change-feed-research-2026-08-25/runners/swap-plugin-bundle-051.js`.
Set `state.patchVariant` before the first plugin navigation on that page: `smallwindow` shrinks
the messages window page size to 2 and the HTTP page to 3; `smallwindow-nofeed` does the same and
also skips `apply_window` on the messages `watchChanges` callback (the break-on-purpose for frozen
rows). Serve `dist/frontend` on `127.0.0.1:5175` first. If the installed version id moved, fix the
constant in that runner the same way as v3.

**0.5.2 swap runner.** Published 0.5.2 is `hn7r8whxym0xsbnn0e74dqak2d8d70be` (asset prefix
`/plugins-ui/hn7r8whxym0xsbnn0e74dqak2d8d70be/`). Do not reuse the 051 file: the 0.5.2 minified
anchors are `uo(u.key)` and `var Do = 55,\n\tco = 100;` (051 had `lo` and `fo`). The 0.5.2 runner
is `t3-chat-+personal/+ai/chitchat-change-feed-research-2026-08-25/runners/swap-plugin-bundle-052.js`.
Same `patchVariant` values as 051. Prove the published frame first (frame URL contains that id,
and the detail page shows `Version 0.5.2` with only `Uninstall`); then install the swap **before**
that tab's next plugin navigation. A frozen-row smoke can edit from the published tab (page size
100, all history in the window) while the smallwindow tab watches the HTTP-loaded row.

**0.5.3 swap runner.** Published 0.5.3 is `hn7j8wbwhevx7wz038f1tcrnjd8d6a5h` (asset prefix
`/plugins-ui/hn7j8wbwhevx7wz038f1tcrnjd8d6a5h/`, entry `dist/frontend/index.html`). Do not reuse
the 052 file. The 0.5.3 minified anchors are `so(u.key)` and `var Lo = 55,\n\tho = 100,` — that
`ho` line ends with a comma, not a semicolon, because companion backoff (`qd = 1e3`, `NM = 3e4`)
shares the same `var`. The 0.5.3 runner is
`t3-chat-+personal/+ai/chitchat-cap-retry-2026-08-26/runners/swap-053-smallwindow.js`. It fetches
the published JS/CSS from the registry (no local static server). Prove the published frame first
(frame URL contains that id, detail page `Version 0.5.3` with only `Uninstall`, served JS sha256
`b1ca9b230749bd989b7f67789562e182eacefc2e16d3859ef94b5b419921694a`). This bundle still has SDK
0.9.5 `m0 = 24`. Cap 100 shipped in 0.5.4. After Save, the row text is
`<needle> (edited)` — an exact match on the needle alone misses it. `Add reaction` plus a palette
click can exceed an 8 s CLI timeout; the relay still finishes the click, so poll the chip instead
of retrying.

**0.5.4 published bundle.** Published 0.5.4 is `hn7kn3bbjg85wpmpwtzx506ppx8d79y3` (asset prefix
`/plugins-ui/hn7kn3bbjg85wpmpwtzx506ppx8d79y3/`, entry `dist/frontend/index.html`). Served JS sha256
`2471c14986c2a9252c70f7bbe100f8f5c25458c0ae2bbaf8ae9f55ed08977198`. The 100-subscription backstop is
in this bundle: served JS has `m0 = 100` and does not have `m0 = 24`. Do not confuse that with
`ho = 100` in `var Lo = 55,\n\tho = 100,` — `ho` is the HTTP page size. Companion backoff is still
`qd = 1e3` / `NM = 3e4`. Window prefix helper is still `so(u.key)`. Prove the cap from **inside**
the plugin frame (`frame.evaluate` + `fetch("assets/index.js")`). A host-page `fetch` of the Convex
asset is CORS-blocked. Same `patchVariant` smallwindow values as 053 if you need a frozen-row
smoke; reuse the 053 runner only after changing its `versionId` constant to this id.

**Edit a frozen row in two Playwriter calls.** Hover the `li.message`, click `Edit`, then in a
**second** call fill the `Edit message` textbox and click `Save`. One 15s call that does hover +
Edit + fill + Save can time out after fill even when `editValue` already holds the new text
(observed 2026-08-25). Prefer `frame.evaluate` for reads; use hover + locator click for row
actions, not `evaluate` click.

## Frozen rows (0.5.1 change feed)

A row loaded through "Load older messages" is outside the live window. 0.5.1 applies
`watchChanges({ collection: "messages", updatedSince })` so those rows update without a reload
(edit, delete, thread reply, reaction add/remove). Say in the report that the cap was patched
when you used `smallwindow`.

**This whole section describes 0.5.x and no longer reproduces.** Since 0.7.0 every loaded page is a
live Convex subscription, so there are no frozen rows to thaw: an edit to a row loaded by "Load
older" arrives through the timeline itself. The change feed is still there
(`useQuery(client.api.plugins_data.watch_changes, …)`), but it can no longer be proven by freezing a
row. Keep the section for reading old reports, not for planning new ones.

Live proof, two tabs, **same user**, no `bringToFront`:

1. Tab A: `page.route` with `smallwindow` **before** opening the plugin page, then seed ~28
   messages, grow to capacity, HTTP-load until the target row is on screen.
2. Tab B: `context.newPage()`, set `state.patchVariant = "smallwindow-nofeed"`, install the same
   051 swap **before** that page's first plugin navigation, park → `#channel` in **separate**
   calls, grow, HTTP-load the same frozen row.
3. On tab A, edit that row. Tab A shows the new text. Tab B must keep the old text — a local
   edit on B would still look live through the write path, so the editor has to be the other tab.
   Own edits of HTTP-loaded rows on a feed-on tab still update; the nofeed tab is what proves
   the feed, not the write.

Private non-member is a different check (see Private channels). Do not use the organization
owner as the outsider — the owner reads every scope.

**Switching channels needs its own call.** Clicking `#alpha` and then `#deephist` inside one
`-e` script left the view on `#alpha`, and the row counts that followed described the wrong channel.
Read `document.querySelector("[role=log]").getAttribute("aria-label")` back — it is
`Messages in #<channel>` — before believing any row count.

To see what the route actually answered, patch `window.fetch` inside the frame before pressing.
This is the only way to read `cursor` and `isDone`, because `page.route` never sees a plugin frame's
subresource requests:

```js
await frame.evaluate(() => {
	window.__ccCaptured = []
	const orig = window.fetch
	window.fetch = async (...args) => {
		const res = await orig(...args)
		const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || ""
		if (url.includes("/plugin-data/list")) {
			res.clone()
				.text()
				.then((t) => window.__ccCaptured.push(JSON.parse(t)))
		}
		return res
	}
})
```

Take it off again — or reload the frame — before running any other network probe, because a patched
`window.fetch` answers your own probes too (see `known-hazards.md`).

## Proving the browser runs your Convex tree

Chitchat's timeline is the cheapest end-to-end probe of `plugins_data.ts`, and it takes about a
minute. Put a temporary `return emptyPage;` at the top of the `watch_documents_page` handler
(`packages/app/convex/plugins_data.ts`), let the running `convex dev` watcher push it (about 20 s;
with no watcher, `vp env exec pnpm --dir packages/app exec convex dev --once`), then reload the page
and open a channel that has messages.

Done 2026-09-02 on published Chitchat 0.7.0, `#deephist` in `personal` / `home`: with the break in,
the channel answered 0 `li.message` rows, one `.channel-status` reading "No messages yet" and no
"Load older" button; after restoring and pushing again it answered 100 rows and the button was back.
**The sidebar kept all 15 channels through the broken pass**, because the channel list reads
`watch_documents`, a different door — that is what makes this probe isolate the paginated door
instead of just proving the frame loaded.

Read `git status --short` after restoring. A break-on-purpose that stays in the tree is worse than
no proof at all.

## The bundle swap captures `dist/` once, so a rebuild needs the runner re-run

`runners/swap-plugin-bundle-v3.js` reads the built assets from the static dist server **once**, at the
moment the route is installed, and the handler only replays those bytes. Rebuilding the plugin and
reloading the page therefore serves the previous build, and every check passes or fails for the wrong
reason. Measured 2026-08-24: after a rebuild the reloaded frame still reported the pre-edit CSS.

The order is always: build → re-run the swap runner → reload. Then read a marker that only the new
build can produce before trusting anything on the page.

```js
await f.evaluate(() => getComputedStyle(document.querySelector(".composer-bar")).borderTopWidth);
// "0px" = stale published bundle, "1px" = this working tree
```

**The runner's own `meta[name="cc-swap"]` marker only names the SCRIPT hash.** A CSS-only edit
rebuilds `index.css`, which the runner inlines in a `<style>` tag, so the marker is byte-identical
across the change and reads as "nothing was swapped". The runner's printed `html=<length>` does move
(measured 773050 → 773525 on a CSS-only change), and so does any computed style you read off the
page. So for a CSS-only edit, confirm with a `getComputedStyle` probe on a declaration you just
changed, not with the marker.

## Accessibility

Axe cannot be added to the frame after load — see the CSP entry in `known-hazards.md`. Serve it
inside the same swapped response with `state.axeUrl` (v3 of the swap runner inlines it with its own
CSP hash). Then:

```js
const report = await frame.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }))
```

Read `window.axe.version` back into the evidence. A clean run on 2026-08-24 was axe 4.12.1, zero
violations, with a thread open.

The harness screen needs the frame handed to it — `auditAccessibility({ frame, selector: "body" })`.
Without `frame` it reads the host page and reports a clean route it never looked at. A clean screen of
the frame on 2026-08-24 was 10 controls, none unlabeled, none undersized, and four blocked hit targets
that are the hover-revealed message actions at rest.

A bigger clean screen, 2026-09-02 on published 0.7.0 with a 103-message channel open: 445 controls,
`unlabeled: 0`, `smallTargets: 0`, `negativeTabIndex: 0`, and 183 blocked hit targets. Every blocked
one was a `ChannelRowMenu-trigger` or a `button message-action`, covered by the row's own
`channel-link`, `message-text` or composer — the hover-revealed clusters at rest, which is the
designed state (see the row-actions section below). The count scales with the number of rows on
screen, so compare the **classes** in `blockedHitTargets`, never the count.

## Row actions hide with opacity, and only hover or real keyboard focus reveals them

`.channel-item-actions` is `opacity: 0` with `pointer-events: none`. Three selectors reveal it:
`:hover`, `.channel-item:has(:focus-visible)`, and `.channel-item:has([aria-expanded="true"])`. It is
not `display: none` — the trigger stays in the tab order on purpose (WCAG 2.1.1) — so a plain
`click()` on it fails on actionability rather than on visibility.

The third selector is why the menu is usable at all: Ariakit sets `aria-expanded="true"` on the
trigger while the menu is open, and without that rule the pointer moving from the row up to the
portalled popover would drop the `:hover`, fade the trigger out, and close the menu under the pointer.

**A mouse click on the row does not reveal the cluster.** That is deliberate: `:focus-within` used to
match the click that opens a channel, so the row a member had just chosen answered by covering its own
name. Only keyboard focus reveals it.

Reaching it by keyboard needs **real key presses**. A bare `el.focus()` from `evaluate` is a script
focus and never matches `:focus-visible` (see the ring-probe entry in `known-hazards.md`), so seed the
focus, then step off and back with real keys:

```js
await frame.evaluate(() => {
	const row = [...document.querySelectorAll(".channel-item")].find((n) => n.textContent.includes("#secret"));
	row.querySelector("button.channel-link").focus();
});
await state.page.keyboard.press("Shift+Tab");
await state.page.keyboard.press("Tab"); // now :focus-visible, trigger revealed
await state.page.keyboard.press("Tab"); // the row menu trigger
await state.page.keyboard.press("Enter"); // opens the menu and focuses its first item
```

Tab order inside a focused row is channel link → menu trigger. Everything that used to be a separate
tab stop is now a menu item reached with the arrow keys. The same resting state is why
`auditAccessibility` reports the trigger as a blocked hit target: that is by design, not a finding.

**The popover is portalled out of the row, and it only exists while it is open.** `Ariakit.Menu` has
`portal`, so the open menu is a child of the frame's `body`, not of `.channel-item`. Scoping the item
lookup to the row finds nothing, and reads as "the menu never opened". It also has `unmountOnHide`, so
`document.querySelectorAll(".ChannelRowMenu-popover")` answers **0** with every menu closed and **1**
with one open — counting them is the cheapest open-state probe. Without `unmountOnHide` Ariakit keeps
every row's menu in the document, and the first `querySelector` hit is then some closed row's menu
sitting at 0×0, which reads as "the menu opened but has no size". Open it from the row, then look the
item up from the frame root:

```js
await fl.locator("button.channel-link", { hasText: "#secret" }).locator(".channel-name").hover();
await fl.getByRole("button", { name: "Actions for #secret" }).click();
await fl.getByRole("menuitem", { name: "Rename #secret" }).click();
```

## Click and hover the channel **name**, never the row centre

The revealed trigger is absolutely positioned over the end of its row. It is only 28px wide now, and
the row reserves `padding-right: 42px` for it, so the row's geometric centre is no longer inside it —
but aim at the label anyway. The centre is still the wrong target when the sidebar is narrow, and the
label is the target a member actually uses:

```js
await fl.locator("button.channel-link", { hasText: "#design-review" }).locator(".channel-name").click();
```

Before the menu replaced the three inline buttons the cluster spanned x≈99–221 on a 215px row and
swallowed every centre-aimed `click()` and `hover()` with `intercepts pointer events`. If that error
ever comes back, the reserve and the trigger width have drifted apart again.

Match the row with `hasText`, not with an anchored accessible-name regex: the name carries an unread
suffix, so `/#design-review$/` stops matching the moment the channel has unread messages.

## Private channels

A private channel is an ordinary channel whose key starts with `p/`, wrapped in a plugin scope over
all four collections. Two things follow for QA:

- **A member who is not in the scope sees nothing at all** — no row, no name, no placeholder.
  "Nothing rendered" is the pass condition, so assert on the absence of the name in `.channel-name`,
  and back it with `watch_my_scopes` answering `[]` and a ranged read of the prefix dying denied. A
  screenshot alone cannot tell "correctly hidden" from "broken sidebar". The cheapest live tell is
  `document.body.innerText` inside the frame: the insider's text includes the channel name, the
  outsider's does not (verified 2026-08-25 on published 0.5.1 in `qa-browser` / `home`, channel
  `#secretfeed`; re-verified 2026-09-02 on published 0.7.0 in the same workspace, insider sidebar
  `#secretfeed (private)` present, outsider sidebar three public rows and neither private name).
- **The organization owner reads every scope**, so an owner-only run proves nothing about a refusal.
  Use a second identity — `second-user-fixtures.md` and `clerk-test-accounts.md` — in an isolated
  scratch browser, never in the signed-in profile the user works in. Two anonymous members in
  `qa-browser` is enough: invite both, create the private channel as one of them with nobody else
  ticked, then open Chitchat as the other. If `create_organization` answers `Organization quota
  reached`, invite into `qa-browser` instead of making a new org.

Driving scope membership from the browser means calling the doors yourself. Since SDK 0.13.0 the
`client.scopes` wrapper is gone and `window.__ccClient` with it; reach the live client through the
React fiber walk in `plugin-marketplace.md` ("Calling the plugin doors from inside a frame"), then:

```js
await frame.evaluate(async ({ key, userId }) => {
	const client = /* fiber walk, see plugin-marketplace.md */;
	const write = await client.convex.mutation(client.api.plugins_data.user_manage_scope, {
		action: { kind: "set_principal", scopeId: key, userId, level: "member" },
	});
	if (write._nay) throw new Error(write._nay.message);
	// Raw `principals | null`, not a Result — an exact `null` is "unreadable or absent".
	return await client.convex.query(client.api.plugins_data.watch_scope_principals, { scopeId: key });
}, { key: privateChannelKey, userId: otherUserId });
```

An exact `null` result means the scope is absent or no longer readable. A **rejected promise** is a
transport failure, not a refusal, so retry it instead of treating the member as removed — 0.13.0
removed the `unavailable` `_nay` name that used to say this.

Adding and removing a principal must change the other browser's sidebar **live**, with no reload —
that is what the `watch_my_scopes` subscription is for, so read the other session's sidebar without
navigating it.

Cleaning up afterwards: delete the scope first (`{ kind: "delete", scopeId }`), which takes its grants with it, then
remove the channel documents. The private channel's own document stays behind on purpose — a deleted
scope leaves its documents in place so nobody can claim that key range again — and the uninstall drain
is what removes it.

## Unreads, mentions, and the views (0.3.0)

Selectors, all inside the frame: view rows are `.view-list .view-item` (buttons named `Unreads`,
`Threads`, `Activity`), a channel row's unread state is `.channel-link.is-unread` with an amber
`.unread-dot` (`oklch(0.617 0.15 52)`) or an amber `.mention-badge` pill when mentions exist, view
content rows are `.view-row-button`, Activity groups are `.view-group-title` with `.view-row.mention-self`
on mention rows, and rendered mention spans in message text are `.message-text .mention` /
`.mention.mention-self`. Each view has a `.view-note` boundary sentence — assert on it, it is part of
the contract (the 100-message horizon, "Private channels are not shown here.").

Recipes proven 2026-08-24, two identities (owner A, viewer B), no reloads anywhere except the
persistence check:

- **Live unread**: A selects one channel; B sends in another through the real composer; A's row gains
  `is-unread` + the dot within ~2 s. Selection clears it instantly (local echo) and a full page reload
  proves the cursor write persisted — assert `unreadRows` is empty after the reload, and read the
  `cc-swap` meta tag again first, because the reload re-runs the swap route.
- **Mention**: append a message whose `mentions` array carries the target's Convex users id and whose
  text contains `@<resolved display name>` (for the QA accounts that is `@User <clerkUserId>` — they
  have no profile names). The row badge, the Unreads aggregate ("N mentions of you"), the Activity
  `mention-self` emphasis, and the in-channel `.mention-self` span all follow from that one doc.
- **Channel keys are UUIDs.** `chat_channel_key` is a client UUID, so a hand-built append with a
  name-shaped prefix (`"random:"`) succeeds at the store and lands in NO channel — the fold maps
  messages to channels by key prefix, so the doc is invisible everywhere except the raw feed. Read the
  real key first (a message row's `data-key` up to the second-to-last `:`-part, or the
  `watch_my_scopes` door for private ones), and remove any stray doc you created with
  `client.convex.mutation(client.api.plugins_data.user_remove_document, { collection, key })`.
- **The @-menu**: since the 0.3.0 publish (2026-08-24) the installable version declares
  `workspace.members.read`, so a fresh install answers the roster and the menu is drivable live.
  Type `@` in the composer (`pressSequentially`, the menu opens on the query change), read
  `[role=listbox][aria-label="Mention somebody"]` and its `[role=option]` rows; **the menu excludes
  the sender**, so a two-member workspace offers exactly one option and a blind Enter happens to be
  right — read the option texts and `ArrowDown` to the one you want instead of relying on that. The
  pick inserts `@<name> ` WITH a trailing space, so appending more text needs no leading space of its
  own. The first Enter picks (closes the menu, sends nothing), the second Enter sends, and the stored
  value's `mentions` array carries the member's users id, not the name. An installed version that
  predates the capability still answers `not_consented` and degrades the composer to plain text by
  design — capabilities come from the installation record, so a bundle swap cannot change them. On
  such an install, drive the mention path with
  `client.convex.mutation(client.api.plugins_data.user_append_document, { collection: "messages",
  keyPrefix: "<channelKey>:", value: { text, attachments: [], editedAt: null, deletedAt: null,
  mentions: [<userId>] }, clientRequestId: crypto.randomUUID() })` — the same write the composer
  makes — and leave the menu to the unit tests.
- **The swap runner's `versionId` is a hardcoded constant.** `swap-plugin-bundle-v3.js` routes on the
  asset prefix of one published version, and the installed version moved when 0.3.0 was published
  (`hn7x5j1hg4e630j7t4mkcr3h118d3632`). 0.5.1 is `hn7j9kpdh4h76he1njpf33dny18d4q1v` (see the 051
  runner in "Frozen rows" above). 0.5.2 is `hn7r8whxym0xsbnn0e74dqak2d8d70be` (see the 052 runner
  there). 0.5.3 is `hn7j8wbwhevx7wz038f1tcrnjd8d6a5h` (see the 053 runner there). 0.5.4 is
  `hn7kn3bbjg85wpmpwtzx506ppx8d79y3` (see the 054 published-bundle note there). Before any swap, read the real prefix from the frame URL and
  fix the constant, or the route matches nothing and the frame silently runs the published bundle.
- **Private unread**: A sends in a private channel both are in; B's row gains the dot with no cursor
  map involvement (the sender stamps `lastMessageAt` on the channel doc). B opening the channel writes
  `<channelKey>:read` into the `channels` collection INSIDE the scope. The decisive check is
  server-side: `convex data plugins_data --format jsonl`, then assert every `cursors`-collection doc's
  `value.channels` holds no key starting `p/`, and the private cursor doc exists with key
  `p/<uuid>:read:<userId>`.
- **Threads view**: B replies through the thread panel ("Reply in thread" is hover-revealed — `hover()`
  the `li.message` row first, then the locator click; a `frame.evaluate` that calls `.focus()`/`.click()`
  on it crashed the CLI twice with `UV_HANDLE_CLOSING`, the hover+locator path worked first try). A's
  Threads view lists one row per root ("N reply · author: text") and clicking it opens the channel with
  the thread panel on that root.

## What cannot be driven from the app

- **The member picker**, when the installed version predates `workspace.members.read`. The picker
  renders Chitchat's own copy, keyed off the refusal name, not the SDK's message: "This workspace has
  not allowed Chitchat to read the member list yet. An admin can accept the plugin's current
  permissions." A `getByText` on the SDK wording matches nothing. Capabilities come from the
  installation record, so a bundle swap cannot change them — only publishing and upgrading.

Since 0.6.0 Chitchat declares **both** `plugin.data.user-write` and `plugin.data.write`, and its
backend writes through the non-frame `POST /api/v1/plugin-data/write` door on every run. That door is
drivable once a 0.6.0 installation exists; earlier notes here said it was permanently refused.

## Layout checks worth repeating

The thread panel is the narrow surface, so overflow shows up there first and nowhere else. After any
change to the message row, open a thread and compare `clientWidth` with `scrollWidth` on
`section.thread`, `.thread .message-list` and `.thread .message-head`. Two real bugs were found this
way on 2026-08-24 and neither was visible in the wide log: a display name with no break opportunity,
and the hover action cluster with `flex-wrap: nowrap`.

`matchMedia`-driven state lags a viewport change. After `setViewportSize` or
`Emulation.clearDeviceMetricsOverride`, the narrow/wide label and the `inert` attribute can still
report the previous state 1.5 s later. Wait ~2.5 s before reading them, or a correct component looks
broken.

**Check the expanded drawer whenever you change the channel row.** The rail has three layouts and the
drawer is the one nobody looks at: it is the icon rail expanded back over the content, and it lives in
`@media (min-width: 720px) and (max-width: 903px)` measured on the FRAME, with a thread open. It keeps
its own copies of the row-action rules, so a base-rule change silently leaves it behind — the hover
reserve stayed at the old three-button `min(150px, 55%)` there after the base moved to `42px`, which
held 118px of a 215px row for a 28px trigger and cut the channel name by 8px. Reaching it needs all
three steps, in order:

```js
await state.page.setViewportSize({ width: 1106, height: 900 }); // -> 850px frame
await fl.locator(".message-thread-summary").first().click(); // adds .has-thread, collapses the rail
await fl.locator(".sidebar-expand").click(); // adds .is-expanded
```

At a 1440px viewport the frame is 1184px and `.sidebar-expand` is in the DOM but not visible, so the
click just times out after 60 s. Read `.channel-link`'s computed `paddingRight` rather than trusting
the stylesheet, and compare the name's right edge with the link's content box to see real clipping.

## Channel transcript files (`/chitchat` in Files) — 0.6.0 backend flow

Since Chitchat 0.6.0 the plugin's own backend writes the channel transcript files during its invoke
runs (message send/edit/delete, reply, reaction, channel manage), through the plugin file doors. The
host projection engine, its 2s debounce, its sync runs, and its hourly cron are gone from the app —
its functions no longer exist in `convex function-spec`.

**Proven live 2026-09-01** against the published 0.6.0 (version doc `hn7kbydkvgax91wxvp3bn1hnc58dg1z4`)
in the QA workspace. A freshly random marker sent on `#alpha` appeared in `/chitchat/alpha.md` about
four seconds later, stamped `2026-09-01 02:01 UTC`, while every earlier block in that file still read
`2026-08-24`. A random marker cannot arrive from a cache or an older run, so its presence is the
proof that this backend wrote the file now.

- Drive the plugin in an **owned** tab (see the OOPIF `bindOpenTab` bullet in `known-hazards.md`),
  send on a uniquely named public channel, then open `/w/:org/:workspace/files?nodeId=root` and
  open the folder with `getByRole("treeitem", { name: "chitchat, read-only" })` (see `files.md` for
  the locked-row name). The transcript is written by the same backend run that commits the send, so
  it should appear within a few seconds, with no separate sync wait.
- Folder status: `This folder is read-only.` File status: `Read-only because /chitchat is locked.`
- Channel file: `/chitchat/<slug>.md` with `<!-- chitchat:msg:... -->` blocks. Open a row with
  `getByRole("link", { name: "Open <slug>.md" })`. Edits show `(edited)`, deletes show
  `(message deleted)` and hide the body, reactions show as `reactions:`.
- Messages inside one file are oldest first. Send unique older then newer markers; the older
  marker must appear first in the file text.
- Private channels do not appear next to the public files. They live under
  `/chitchat/private/<slug>-<digest8>/` — see the next section. Expand `Show more` before treating
  a missing name as proof.
- The workspace agent can `cat` those paths with bash and is refused on write
  (`cannot write '...': This item is read-only.`).
- The store and the file system commit separately, so a backend run can crash between them. The
  store is the source of truth: a missing or stale block in the transcript is a repair case for the
  plugin's `reconcile` endpoint, not data loss. Check the Chitchat page before diagnosing a
  transcript gap as a lost message.
- **Opening a channel fires exactly one `reconcile` invoke, and re-clicking the open channel fires
  none.** The effect is keyed on `[client, channel.key]` (`channel-view.tsx:2286`), so it runs per
  distinct channel open. It rebuilds the transcript from the store in the background: no spinner and
  no error surface, so a refused reconcile leaves the composer enabled and shows nothing at all.
  Count the invokes by patching `window.fetch` **inside the frame** — the SDK fetches
  `/api/v1/plugin-backend/invoke` from frame context (`bonobo-plugin-sdk/frontend.js:1580`), so a
  recorder installed on the HOST page records zero and reads as "the open fired nothing".
- **The reconcile rebuild is also what hides the duplicate-block bug below.** Read the transcript
  before reopening the channel: the next open heals the file back to one block per message, so a
  check that reopens first can never see the defect.

> **`<!-- chitchat:msg:<key> -->` markers do not survive storage, and an uncertain send therefore
> duplicates its block (found 2026-09-01 on Chitchat 0.6.0; FIXED in 0.6.1 for files created from
> 0.6.1 on — see the closing paragraph for the files that keep the old behaviour).**
> The backend writes a marker line above
> every block (`markdown.ts:202`), but **no stored transcript in the dev deployment contains a single
> marker** — measured on `/chitchat/alpha.md` and `/chitchat/delta.md`. Markdown structure survives
> the round trip (the `#` heading and the `**author**` bold are intact); only the HTML comment is
> dropped. Cause: `files_write` in the plugin backend posts
> `{ path, content, access: { readOnly: true } }` with **no `nonCollaborative: true`**
> (`worker.ts:199`), so the app stores the file through the collaborative Yjs/Tiptap path, and
> ProseMirror keeps no comment nodes.
>
> The damage is in the replay path. A replayed send calls `repair_replayed_block`
> (`worker.ts:712`), which appends the block only when `chatbe_file_contains_block` cannot find the
> marker (`worker.ts:932`). The lookup is a plain `content.indexOf(marker)`, so with the markers
> gone it always answers "absent" and always appends. Measured live: a send whose answer was thrown
> away left **one** message in the channel and **two** identical blocks in `/chitchat/delta.md`.
> Reopening the channel healed it back to one, because reconcile rebuilds from the store.
>
> The plugin's own unit tests pass because they hold the file content in memory, where the marker is
> never stripped. Only an end-to-end read of the stored file shows it.
>
> **Fixed in Chitchat 0.6.1** by adding `nonCollaborative: true` to `files_write`. That covers **new**
> files only: `/api/v1/files/write` deliberately refuses to flip an existing collaborative file,
> because turning collaboration off deletes the edit history and only the Properties dialog may ask
> for that (`public_api.test.ts:752-776`).
>
> The live A/B that proves it, both halves run by the same 0.6.1 plugin in one session on 2026-09-01:
> a channel created after the update stored **2 markers for 2 messages** and its node carries a
> `nonCollaborativeBaseAssetId`; `/chitchat/delta.md`, created before the update, took a new block and
> still stored **0 markers** with `nonCollaborativeBaseAssetId: null`. Read both with the raw-text
> recipe in `known-hazards.md` — the editor never paints a comment, so a DOM read cannot see either
> result.
>
> The transcripts created before 0.6.1 keep the old behaviour, and **no door can recreate them**:
> `files_nodes:archive_nodes` refuses a read-only node, and a plugin's own lock is releasable only by
> `plugin-access/set`, `plugin-archive`, and that plugin's `archive-destination` — Chitchat calls
> `plugin-archive` only for rolled files past the live tail, never the tail itself. So do not plan a
> repair around the Files UI or an admin mutation; it needs a Chitchat change. Reconcile still heals
> those files on every channel open, so the duplicate they grow is transient, not permanent.
>
> **The user decided on 2026-09-01 to leave those files as they are.** Treat the pre-0.6.1
> transcripts as expected state, not as a bug to report or repair.

## Private transcripts (`/chitchat/private/<slug>-<digest8>/` in Files)

A private channel's transcript lives in its own restricted folder,
`/chitchat/private/<slug>-<digest8(channelKey)>/<slug>-<digest8>.md`, readable by the channel's
scope members — and by the organization owner, who reads every restricted file in the workspace,
which is why an owner-only run proves nothing. The digest suffix comes from the channel key (a
client UUID), so two same-named private channels get separate folders and a guessed channel name
cannot be confirmed by probing the path. The backend binds the folder to the channel's data scope
(`access.readScopeId`, binding table `plugins_file_access_bindings`), and the host mirrors one
`content.read` grant per scope member onto it. Adds and removals are BOTH synchronous inside the
scope mutation — the old "adds wait for the next sync" asymmetry is gone.

**Proven live 2026-09-01, after the fix below.** A private channel created in `personal/home` now
projects to `/chitchat/private/<slug>-<digest8>/<slug>-<digest8>.md` within a few seconds, holding the
message and the disclosure header, and one `plugins_file_access_bindings` row appears for the
channel's scope. Before the fix that table was empty across the whole deployment.

> **This was broken from 0.6.0 until 2026-09-01, in the APP, not the plugin.** Worth knowing, because
> the older private folders in dev (`secretfeed`, `projqapriv0826`) carry **no digest suffix** — they
> predate 0.6.0, so do not treat them as evidence that the current path works.
>
> Two defects, one masking the other, both in the plugin-folders ensure door:
>
> 1. `db_apply_owned_access` refused `readOnly: true` whenever ANY ancestor held a lock, including the
>    plugin's own. Chitchat locks `/chitchat` and then ensures `/chitchat/private` read-only, so every
>    run answered `409` / `"This item is read-only."` and `worker.ts:523` was never reached.
> 2. `ensure_plugin_folder` created folders without `inheritParentReadOnlyScope`, unlike the write
>    doors in `public_api.ts`, so a folder made under a locked root came out carrying no lock pointer.
>
> Defect 1 hid defect 2: while the call refused, nobody could see that the folder would not have been
> locked anyway. Fixing only the refusal produces a private folder that is NOT read-only — a worse
> outcome than the 409. If you touch this door, assert the folder's own `readOnlyScopeNodeId`, not
> just the status code.

Two things that will mislead you while setting this up, both hit 2026-09-01:

- **On a BEHIND installation, a message surviving a reload does NOT mean the backend ran.** The old
  frontend bundle writes messages straight to the plugin store over `/api/v1/plugin-data/*`, so a
  message appears with no run at all. Check `plugins_event_runs` (and `plugins_event_run_calls` for
  the per-route outcome) to see whether a run happened — `convex data plugins_event_runs --limit 5
  --order desc`, then compare `_creationTime` against now. On 0.6.0 the send itself IS the
  `message-send` invoke (`channel-view.tsx:212`) and the backend mints the message key, so there a
  delivered message really does prove the backend ran. Read the installed version before using
  either rule.
- **The plugins LIST shows the catalog version with an "Installed" badge**, which reads as "0.6.0 is
  installed" even when the installation is older. A behind installation keeps the old
  `acceptedCapabilities`: `qa-browser` held only `["plugin.data.read", "plugin.data.user-write",
  "workspace.files.read", "workspace.members.read"]` — no `plugin.backend.invoke` — so no run fired on
  send and nothing projected, with no error anywhere in the UI. Confirm on the plugin DETAIL page
  (an "Update" button means you are behind) or read the installation's `acceptedCapabilities` from
  `plugins_workspace_installations`.

- The file opens read-only like the public ones. The disclosure line naming who can read it sits in
  the file header, on the third line, not at the end. The `/chitchat/private` container above the
  channel folders is plugin-locked but not restricted, so every member's tree can show it.
- Full second-identity cycle (needs `second-user-fixtures.md`): the viewer's files tree shows the
  `private` container but no channel folder inside it — the container is unrestricted, so assert on
  the channel name, not on `private` being absent → add the viewer via the People dialog → the
  viewer sees the channel folder and can open the file, disclosure included → remove the viewer →
  the folder disappears without a reload.
- Archiving the channel (the plugin's "delete channel") does NOT archive its transcript folder or
  file. The `channel-manage` `update` action stamps `archivedAt` and refreshes the projection; the
  only `files_archive` call in the backend drops surplus rollover files. So the archived channel just
  falls out of the README list while its file stays in place, and unarchiving reuses that same
  folder. Read this before writing an assertion about a folder disappearing.
