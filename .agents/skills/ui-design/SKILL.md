---
name: ui-design
description: Visual design principles for the app UI - readable font sizes, the text color hierarchy, and how to apply them. Use when creating or restyling any UI (components, dialogs, panels, routes), choosing a font size or text color, or reviewing a UI change for readability.
---

# UI Design Principles

Readability comes first. Small text can look neat, but it is hard to read. Later, teams will be able to choose their own font settings. Until then, pick sizes that are easy to read for everyone.

## Font sizes

Use this scale for new and restyled UI. It is the size in CSS `px`.

| Role | Size | Weight | Examples |
| --- | --- | --- | --- |
| Section heading | 18px | 600 | "Read-only", "Metadata", group headings in a dialog |
| Main text | 16px (the browser default) | 500 for labels, 400 for sentences | option and checkbox labels, names in a list, body text of a confirm dialog |
| Section description | 16px | 400 | the sentence under a section heading, like the subtitle in a dialog header |
| Secondary text | 15px | 400 | descriptions under an option label, helper text, notes, status lines, errors |
| Code and editors | 16px, line height 22px (same as the file editors) | 400 | Monaco editors, code samples |
| Smallest allowed | 13px | any | chips, badges |

- Do not go below 13px. Use 13px only for compact items, not for sentences someone has to read.
- When text grows, widen its container by the same ratio, so lines that fit on one line still do.
- Buttons keep the `MyButton` size (`0.875rem`, 14px). The accent and destructive buttons use 13px Cinzel capitals (see "Palazzo style" below).
- When a value must match another element (a Monaco line height, a placeholder on top of an editor), change both together.

The Properties modal (`packages/app/src/components/files/files-properties-modal.css`) follows this scale. Use it as the reference.

## Text colors

Only the main text is bright. Everything else is grey, so the eye goes to what matters.

- Main text: `--color-fg-11`. Headings, labels, names, the text the user came to read.
- Secondary text: `--color-fg-08`. Descriptions, helper text, notes, status lines.
- Placeholders and hints that must stay quiet: `--color-fg-06`.
- Errors: `--color-red-11`.

Do not make a description as bright as its label. If everything is bright, nothing stands out.

Choice buttons (`MyRadioButton` and `MyCheckboxButton` with a label and a description) follow the same idea:

- The chosen button has the bright label (`--color-fg-11`), the accent ring, and the accent dot or filled box.
- The other buttons have a dimmer label (`--color-fg-09`). It turns `--color-fg-10` on hover.
- The description is `--color-fg-08` in both states. Do not dim it more, because it would be too hard to read.
- Use `MyRadioButtonLabel` and `MyRadioButtonDescription`, or `MyCheckboxButtonContent`, `MyCheckboxButtonLabel` and `MyCheckboxButtonDescription`. Do not write a local label class for them.
- A disabled button dims its label and description with the rest of the button.

## Palazzo style

The app is a mix of two styles. From Palazzo it takes the skin: warm stone colors, cloudy marble,
Roman capitals, and a few carved ornaments in the frame. From the app's original style it keeps the
shapes and the depth: rounded corners, gradients, bevel lines, and drop shadows. The user chose
Palazzo on 2026-11-19, with two themes: the dark theme (palazzo at night) and the light theme
(palazzo in the sun). The same day the user asked for this mix: the app must not copy the square,
flat look of the user's other Palazzo apps (Busy Peasy and Only Whispers). The style changes the
skin, not where things are.

Fonts:

- Reading text is EB Garamond (`--app-font-sans`). Code stays monospace.
- Cinzel capitals (`--app-font-display`) are only for short labels the app writes: the logo, panel
  titles ("AI Chat", "Files", "Messages"), main nav items, and the accent and destructive buttons.
  Plugin page nav labels count as nav items: a manifest caps them at 40 characters, and the nav must
  look like one list.
- Never put Cinzel on user content: file names, chat titles, people, organization names, values in a
  select. Cinzel has only capitals, and canvas text measuring (Pretext) uses the reading face.
- EB Garamond is drawn 12% larger through `@font-face size-adjust` in `src/app-fonts.css`, so its
  small letters are as tall as other fonts. Use `size-adjust`, not `font-size-adjust`, because
  canvas text ignores `font-size-adjust`.

Shapes and states:

- Keep the original rounded corners (for example 6px on rows and buttons, 8px on the organization
  switcher, 12px on dialogs). Do not make controls square.
- A raised control or card has a two-step gradient, a light line on top, a dark line at the bottom,
  and a small drop shadow. A pressed control gets an inner shadow. Hover, selected, and active states
  are one or two steps higher on the scale, as in the original style.
- Write each rule for the light theme first, then repeat only the parts that differ in a nested
  `:where(.dark) & { … }` block at the end of the same rule. Do not add `--app-*` variables that only
  switch a value between themes. This is a user decision (2026-11-19). The shadow tokens below are the
  one exception.
- The light theme mirrors the steps, so the gradient lists them the other way around. Light:
  `linear-gradient(<lower step>, <higher step>)`, top line `oklch(1 0 0 / N)`, bottom line
  `oklch(0.55 0.04 60 / N)`, shadows in warm brown `oklch(0.3 0.04 55 / N)`. Dark:
  `linear-gradient(<higher step>, <lower step>)`, top line
  `color-mix(in oklch, var(--color-fg-11) N%, transparent)`, bottom line
  `color-mix(in oklch, var(--color-base-1-02) N%, transparent)`, shadows `oklch(0 0 0 / N)`.
- Shadows that more than one component uses are `--app-shadow-*` tokens in `app.css`: `bevel-1` to
  `-3`, `pressed-1` and `-2`, `raised`, `lifted`, `floating`, `popover`, `outline`, `hairline`. Each token
  holds its light value in `:root` and its dark value in `.dark`, so a rule that uses only tokens needs
  no dark block. Combine them in one list: `box-shadow: var(--app-shadow-bevel-1), var(--app-shadow-raised);`.
  Keep rings (`inset 0 0 0 2px var(--color-…)`) first in the list, because the first shadow paints on top.
- One token is one exact shadow, the same everywhere (a user decision, 2026-11-19). Use a token only
  where the old value matches it exactly in both themes. A shadow that differs a little gets its own
  token or stays hardcoded; never round it to the nearest token without asking, because that changes how
  the app looks. A shadow used by only one component stays in that component. In a numbered family, a
  higher number is stronger: the bevel's bottom line is darker, and pressed-2 is deeper. Do not name
  tokens with a rank across different shapes (the user found `shadow-0` to `-5` unclear).
- Use `:where(.dark) &`, not `.dark &`. `:where()` adds no specificity, so a later variant or state
  rule (for example a disabled or ghost button) still wins in the dark theme, as it does in the light
  one. Always nest the dark rule with `&`; never write a separate top-level `:where(.dark) …` rule
  (a user decision, 2026-11-19). `&` cannot stand for a pseudo-element, so end the selector at the
  element and nest both parts: `&::before { … }` and `:where(.dark) &::before { … }`.
- An inline style (for example the toaster's) cannot use the class. Pick the value from
  `resolved_theme` of `useThemeContext()` instead. A shadow token works inline as it is
  (`boxShadow: "var(--app-shadow-floating)"`), because the root's `.dark` class switches it.
- Focus is a 2px accent ring (`--color-accent-07`).
- Orange means "active" or "press me". Do not use it as decoration.
- The primary button is a dark orange fill with near-white text, and the destructive button a dark
  red one. The fills come from the scale: `accent-06` to `-08` and `red-10` to `-12` in the light
  theme. The scale is mirrored in the dark theme, so the dark block picks lower steps (`accent-04` to
  `-02`, `red-06` to `-04`) to keep the fill dark. Each state rule (normal, hover, pressed) uses the
  scale variables directly and has its own dark block, like the other button variants. Do not wrap
  scale steps in component variables only to save dark blocks. The bevel uses fixed white and black lines.
- Take every color from the scale (a user decision, 2026-11-19). When a component needs a different
  step in the dark theme, pick it in a dark block; do not add a fixed color or an `--app-*` color.
  The user removed `--app-accent-deep` and the other fixed button colors for this reason.

Marble and ornaments:

- The window is marble under a stone wash (the `body` rule in `app.css`). The header and the main
  sidebar add the `app-marble` class. An owner may set `--app-marble-stone` (base-1-03 by default)
  and must not set its own `background`. Keep marble off boxes that scroll, because a fixed background repaints on scroll.
- The app has no ornaments (carved edges, columns, mouldings). An ornament must not take space from
  content, and the app is dense, so there is no room for one. The user removed a Roman column on
  the main sidebar's edge and an 8px egg-and-dart moulding under the header for this reason
  (2026-11-19). The header's bottom edge is only its shadow. This is a product rule.

Themes:

- The light theme is the default. `:root` holds the light theme colors and `.dark` the dark theme
  ones. The root also gets a `.light` class, but no CSS reads it. Every step keeps its role in both
  themes: base step 01 is the page, higher base steps are hover, selected, and lines; fg-11 is the
  main text in both. So a component written with the scale works in both themes without extra rules.
- fg-02 to fg-04 are also divider lines, so in the light theme they stay a warm line color.
- After a color change, run `generate:app-colors` (Monaco and plugin frames read the generated map),
  then run the contrast check: text at least 4.5:1, placeholders at least 3:1, in both themes.

## Setting text stays fixed

The label and the description of a setting say what it does. They do not change when the setting
is turned on or off, or when it is blocked. This is a product rule, decided by the user.

- Keep the description short and free of technical details.
- Add a help button only when the setting needs extra text (plugin and API key rules, for example).
  Use the `CircleHelp` (`?`) icon, like the help in the header and the Metadata help button.
- The help opens on hover, on keyboard focus, and on a click or tap. A click only opens it, so it
  never hides text the hover has just shown. Touch never opens a tooltip, so without the click a
  phone could not read it. Clicking the icon does not change the setting.
- The icon must not change the size or layout of the setting, and it keeps the standard
  `MyIconButton` size. Do not shrink it to fit. Center it on the box's right side, outside the
  clickable label, like a trailing control in a list row. Give the box enough right padding so no
  text runs under it.
- A setting with no extra text gets no icon. When it is blocked, hovering the box shows why
  (`open={reason ? undefined : false}`, like the billing tooltips in the header).

`FilesPropertiesModalSetting` in the Properties modal is the reference.

## Button labels stay fixed while the action runs

A button keeps its label while its action runs. Do not swap "Move to Trash" for "Moving to Trash...". This is
a product rule, decided by the user.

- While the action runs, set `disabled` (or `aria-disabled` when focus must stay on the button) and
  `aria-busy`. `MyButton` shows a wait cursor for `aria-busy`.
- Why: most actions end in well under a second, so a swapped label only flickers. It also changes
  the button's width, and it changes the button's name, which speech input, Playwriter and tests
  use. The result is the feedback: the dialog closes, a toast shows, or the row changes.
- Exception: an action that usually takes several seconds or more keeps its progress text, because
  nothing else shows that work is going on. Today these are starting a cloud browser, Playwriter
  Connect, and plugin publish.
- Status text that is not a button label (a `role="status"` line, a "Load more" row that shows
  "Loading…") is not covered by this rule.

## Disabled menu items say why

When a menu item is disabled for a reason the user can act on, hovering it shows that reason. This
is a product rule, decided by the user.

- Pass the reason as `tooltip` to `MyMenuItem`. A disabled item with a tooltip keeps the hover, and
  it still ignores clicks.
- Name the item or the cause in plain words, for example "This folder contains items you cannot
  change." Leave out the tooltip when the reason is obvious, such as Paste with an empty clipboard.
- The Move to Trash item in the Files row menus is the reference (`files_get_archive_disabled_reason`
  in `shared/files.ts`).

## Dialog titles name the item, the body shows the path

A dialog about one file or folder names it in the title, on one line. The body shows its full path.
This is a product rule, decided by the user.

- Use `FilesNameHeading` (`components/files/files-name-heading.tsx`). A long name is cut in the
  middle with Pretext, so the extension stays visible, and the heading keeps the full text as the
  dialog's accessible name.
- Show the path in a read-only `TextMonospaceBlock`, one path per line, also for one item. A dialog
  for several items counts them in the title ("Move 3 items to Trash?") and lists every path.
- References: Move to Trash, Delete permanently and Share.

## Loading skeletons are all or nothing

A popover, menu or suggestion list opens at once, with skeleton rows, and keeps its size when the
data arrives. This is a product rule, decided by the user.

- Show one skeleton row for every row the list will surely show. Count the rows you already know
  (the six default columns, the built-in fields, the static groups) and the rows the first page
  always adds (at least one: a result, Show more, or a "nothing found" message). Use the real group
  headings, so only the rows change.
- All or nothing: while the first page loads, show no real rows at all, not even the ones that are
  ready. When the page arrives, replace every skeleton row with every real row in one step. Never show
  some real rows and then skeleton rows, or rows that appear one group after another.
- Make a skeleton row exactly as tall as a real row. Then the default case does not resize at all.
- The list may grow when the data has more rows than the skeleton. It must never shrink.
- While newer text loads, older rows of the same list stay on screen, disabled, with no skeleton.

`useFilesMetadataCatalogPages` gives `noRowsYet` for this: the first page loads and no older rows
are held. The Columns menu, the folder filter bar and the files search box follow this rule. They
also keep their first page in the query cache, so closing and opening a menu again shows its rows
at once, with no skeleton, also with text left in the box.

The Notifications popover follows it too. Its header, which is always mounted, subscribes to every
query the popover shows, so only the first open after a page load can show the skeleton.

## Phone layout

Only the agent chat has a phone layout. Other pages keep the desktop layout on a phone (see "Phone Layout" in the `ai-chat-agent` skill).

- Use the phone query from `src/hooks/use-mobile.ts`: `(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (max-height: 500px)`. Do not use width alone, because a narrow desktop window must keep the desktop layout.
- Make touch targets at least 44px tall.
- Keep content clear of the notch and the home bar with `env(safe-area-inset-*)`. The viewport meta has `viewport-fit=cover`.
- Use `dvh`, not `vh`, for heights that must fit the screen. On iOS, `vh` includes the space under the browser toolbar.
- Inputs need text of at least 16px. iOS zooms the page in when a smaller input takes focus.

## Checks for a UI change

- No sentence is smaller than 15px. No text at all is smaller than 13px.
- Each block has one bright line at most, usually its label or heading.
- Paired controls look the same (for example `MyRadioButton` and `MyCheckboxButton`, which must stay in sync).
- The change looks right in both themes, dark and light.
- No Cinzel on user content. The rule is written for the light theme, and a `:where(.dark) &` block repeats only what differs, so the light edge stays on top in both themes.
- A shadow that matches an `--app-shadow-*` token exactly, in both themes, uses the token.
