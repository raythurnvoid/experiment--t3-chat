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

## Checks for a UI change

- No sentence is smaller than 15px. No text at all is smaller than 13px.
- Each block has one bright line at most, usually its label or heading.
- Paired controls look the same (for example `MyRadioButton` and `MyCheckboxButton`, which must stay in sync).
