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
| Create channel | `getByRole("button", { name: "Create channel" })`, then `[data-dialog-initial="true"]`, then `getByRole("button", { name: "Create", exact: true })` |
| Composer | `textarea.composer-input` — with a thread open there are TWO of them, so scope: the channel one by its aria-label `Message #<channel>`, the thread one as `section.thread textarea.composer-input` (aria-label `Reply in thread`). Since 0.5.0 (Ariakit-combobox mention picker) the composer carries `role="combobox"` with `aria-expanded` — the quickest live proof of a 0.5.0 frame. Typing `@` in a single-member workspace opens NO menu (the picker excludes the sender), `aria-expanded` stays `"false"`, and no `[role=listbox]` enters the DOM — verified 2026-08-25 |
| Message row | `li.message`, with `.is-leader` or `.is-continuation`, and `data-key` carrying the document key |
| Day divider | `li.day-divider` |
| Message body | `.message-text` |
| Message row actions | `.message-actions` holding buttons named `Reply in thread`, `Add reaction`, and for your own messages `Edit` / `Delete` — hover-revealed |
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
| Window grow control | `getByRole("button", { name: "Load older", exact: true })` |
| HTTP deep-history control | `getByRole("button", { name: "Load older messages", exact: true })` |

**Use `exact: true` on both "Load older" buttons.** Without it, `name: "Load older"` also matches
"Load older messages", so a growth loop silently starts paging history over HTTP and the run reads
as a window that grew further than it can.

**The channel row's accessible name changes with its unread state (0.3.0).** The name is the rail
initial plus the channel name plus a suffix: `D#design-reviewunread` when unread, or
`B#build-pipeline1 unread mentions` with a mention count. An end-anchored regex like
`/#design-review$/` matches a read channel and then silently stops matching the moment the channel
becomes unread — the click times out and a chained command reads as if the click landed. A
start-anchored `/^#design-review/` is also wrong twice over: the name may start with the rail
initial, and it also matches the thread-summary button in the Threads view (its text starts with
the channel name), and that ambiguous `frameLocator(...).getByRole(...).click()` crashed the CLI
with the `UV_HANDLE_CLOSING` exit-9 assertion instead of a strict-mode error. Use the class
locator with `hasText` from the table above; `Rename #x` / `Archive #x` are separate buttons
without `.channel-link`, so `hasText` stays unambiguous.

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

The host sends the frame resolved colour values plus a `mode`. Since 2026-08-24 `mode` is read from
the **surface colour** the host actually paints, not from the root `.light` / `.dark` class
(`plugins-ui-frame.tsx`). The app's palette is dark-oriented and the theme provider does not swap
it, so a member on "light" still sees dark surfaces — and the frame now correctly stays on its dark
palette there. A run that expects `theme-light` on the document element under the host's light
theme is reading the old bug, not a regression.

Check it by reading both sides:

```js
await state.page.evaluate(() => document.documentElement.className) // "light" or "dark"
await frame.evaluate(() => ({
	cls: document.documentElement.className, // "" for dark, "theme-light" for light
	surface: getComputedStyle(document.documentElement).getPropertyValue("--cc-surface").trim(),
}))
```

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

The frame then reports `theme-light` while the host class says `dark`, which is the whole point.
Remove both properties and put the original class back afterwards — this writes to the user's own
tab.

**That recipe proves the mode switch, but it does NOT give you a screenshot of the light theme.** The
host writes all fourteen roles as inline `--bonobo-*` properties on the frame's documentElement, and
`chitchat.css` reads each one as `var(--bonobo-x, <light-fallback>)`. Overriding only the two surface
variables leaves every text role still holding the host's **dark** value, so the frame paints
near-white text on a white ground and almost nothing is readable. That is the fixture being
incoherent, not a plugin bug: a real host sends one consistent set. Measured 2026-08-24.

To actually see the plugin's own light palette, strip the host roles so the fallbacks stand:

```js
await frame.evaluate(() => {
	const root = document.documentElement;
	for (const p of [...root.style].filter((n) => n.startsWith("--bonobo-"))) root.style.removeProperty(p);
	root.classList.add("theme-light");
});
// --cc-surface #ffffff, --cc-text #1b1b20, color-scheme light
```

`color-scheme` is declared in both palette blocks (`dark` on `:root`, `light` on `:root.theme-light`)
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

## Reaching the deep-history control

The control only appears once the messages window reports `atCapacity`, which is 6 intervals of 100
— 600 real messages. Serve the bundle with `state.patchVariant = "smallwindow"`
(`runners/swap-plugin-bundle-v3.js`): it drops the window page size to 2 and the HTTP page size to
3, so a small channel reaches the same state and one press is observable.

Then the sequence is: open the channel, press "Load older" until it disappears, and read
`.log-older`. At capacity it holds a `role="status"` line ("The live view stopped growing. Older
messages load on request.") and the "Load older messages" button. One press merges the next HTTP
page and, when the server reports `isDone`, replaces both with "You have reached the start of
#<channel>."

**Seed about 28 messages, not 13.** With the small window the channel opens on 2 rows and reaches
capacity at 12, after exactly 5 presses of "Load older". Everything below row 12 is what the HTTP
door then walks. A 14-message channel leaves only 2 there, so the very first press comes back
`isDone: true` and never exercises the full-page branch — the one that answers a **non-null cursor**
beside a key range. Measured 2026-08-24: 28 messages gave five full pages of 3 with `isDone: false`
and a non-null cursor, then a final page of 1 with `isDone: true` and `cursor: null`.

**0.5.1 swap runner.** After Chitchat 0.5.1 is published, the asset prefix is
`/plugins-ui/hn7j9kpdh4h76he1njpf33dny18d4q1v/`. The working-tree swap for that version lives at
`t3-chat-+personal/+ai/chitchat-change-feed-research-2026-08-25/runners/swap-plugin-bundle-051.js`.
Set `state.patchVariant` before the first plugin navigation on that page: `smallwindow` shrinks
the messages window page size to 2 and the HTTP page to 3; `smallwindow-nofeed` does the same and
also skips `apply_window` on the messages `watchChanges` callback (the break-on-purpose for frozen
rows). Serve `dist/frontend` on `127.0.0.1:5175` first. If the installed version id moved, fix the
constant in that runner the same way as v3.

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

Chitchat's deep-history door is the cheapest end-to-end probe of `plugins_data_http.ts`. Comment out
`keyStartExclusive` in `list_body_validator`, push with
`vp env exec pnpm --dir packages/app exec convex dev --once`, and press the control: the row grows a
`role="alert"` line reading `/api/v1/plugin-data/list responded 400: {"message":"Request body
validation failed"}` and no rows merge. Restore, push again, press again, and the page merges. Done
on 2026-08-24; it takes about two minutes and it is the only thing that proves a green run was not
green against a stale deployment.

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
  and back it with `scopes.watchMine` answering `[]` and a ranged read of the prefix dying denied. A
  screenshot alone cannot tell "correctly hidden" from "broken sidebar". The cheapest live tell is
  `document.body.innerText` inside the frame: the insider's text includes the channel name, the
  outsider's does not (verified 2026-08-25 on published 0.5.1 in `qa-browser` / `home`, channel
  `#secretfeed`).
- **The organization owner reads every scope**, so an owner-only run proves nothing about a refusal.
  Use a second identity — `second-user-fixtures.md` and `clerk-test-accounts.md` — in an isolated
  scratch browser, never in the signed-in profile the user works in. Two anonymous members in
  `qa-browser` is enough: invite both, create the private channel as one of them with nobody else
  ticked, then open Chitchat as the other. If `create_organization` answers `Organization quota
  reached`, invite into `qa-browser` instead of making a new org.

With the swap runner's `expose-client` variant, `window.__ccClient` is the live SDK client, which is
the only practical way to drive scope membership from the browser:

```js
await frame.evaluate(async ({ key, userId }) => {
	await window.__ccClient.scopes.setPrincipal({ scopeId: key, userId, level: "member" });
	return window.__ccClient.scopes.listPrincipals({ scopeId: key });
}, { key: privateChannelKey, userId: otherUserId });
```

Adding and removing a principal must change the other browser's sidebar **live**, with no reload —
that is what the `scopes.watchMine` subscription is for, so read the other session's sidebar without
navigating it.

Cleaning up afterwards: delete the scope first (`scopes.delete`), which takes its grants with it, then
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
  real key first (a message row's `data-key` up to the second-to-last `:`-part, or `scopes.watchMine`
  for private ones), and `data.remove` any stray doc you created.
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
  such an install, drive the mention path with `window.__ccClient.data.append({ collection:
  "messages", keyPrefix: "<channelKey>:", value: { text, attachments: [], editedAt: null, deletedAt:
  null, mentions: [<userId>] }, clientRequestId: crypto.randomUUID() })` — the same write the
  composer makes — and leave the menu to the unit tests.
- **The swap runner's `versionId` is a hardcoded constant.** `swap-plugin-bundle-v3.js` routes on the
  asset prefix of one published version, and the installed version moved when 0.3.0 was published
  (`hn7x5j1hg4e630j7t4mkcr3h118d3632`). 0.5.1 is `hn7j9kpdh4h76he1njpf33dny18d4q1v` (see the 051
  runner in "Frozen rows" above). Before any swap, read the real prefix from the frame URL and
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

- **The HTTP write door** (`POST /api/v1/plugin-data/write`). `db_authorize` checks
  `acceptedCapabilities` before any scope logic, and Chitchat declares `plugin.data.user-write`, never
  `plugin.data.write`. Every non-frame write for this installation is refused `Permission denied`
  whatever key range it names, so this route cannot exercise the scope guard. Cover that surface with
  `packages/app/convex/plugins_data.test.ts`.
- **The member picker**, when the installed version predates `workspace.members.read`. The dialog says
  "This workspace has not granted this plugin the member list" and offers no names. Capabilities come
  from the installation record, so a bundle swap cannot change them — only publishing and upgrading.

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
