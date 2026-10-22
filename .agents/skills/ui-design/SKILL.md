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
| Section heading | 18px | 600 | "Who can edit", "Metadata", group headings in a dialog |
| Main text | 16px (the browser default) | 500 for labels, 400 for sentences | option and checkbox labels, names in a list, body text of a confirm dialog |
| Section description | 16px | 400 | the sentence under a section heading, like the subtitle in a dialog header |
| Secondary text | 15px | 400 | descriptions under an option label, helper text, notes, status lines, errors |
| Code and editors | 16px, line height 22px (same as the file editors) | 400 | Monaco editors, code samples |
| Smallest allowed | 13px | any | chips, badges |

- Do not go below 13px. Use 13px only for compact items, not for sentences someone has to read.
- When text grows, widen its container by the same ratio, so lines that fit on one line still do.
- Buttons keep the `MyButton` size (`0.875rem`, 14px).
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

## Popovers only grow while they load

A popover, menu or suggestion list must not shrink when its data arrives. A shrink right after
opening looks like the popover is shaking.

- Show the parts that are ready at once.
- For the part that is still loading, show nothing: no loading text and no skeleton rows. A
  placeholder that goes away makes the popover shrink when the result is smaller.
- When the result arrives, the popover may grow. If the result adds nothing, the popover keeps its size.
- While newer text loads, older rows may stay on screen, disabled.

Full pages and panels that fill a fixed area (the folder table, the file editors) may still use
skeletons, because their size does not depend on the content.

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
