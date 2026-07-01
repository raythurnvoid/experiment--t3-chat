---
name: image-model-design-ideation
description: Use the image model for UI/UX design ideation in this app, including screenshot-based critique, color and CSS token selection, visual alternatives, interaction-state exploration, and extracting implementation guidance from generated references. Use when the user asks to use the image tool/model for product design, compare current UI against available tokens, decide colors/spacing/borders/shadows, or turn generated design guidance into app CSS or component changes.
---

# Image Model Design Ideation

Use this skill when the image model should help make or critique a visual product-design decision before implementation.

## Non-Negotiables

- Use the image model when the user explicitly asks for it.
- Tell the user plainly if a prior answer did not actually use the image model.
- There is no native image tool here. Produce every image through `chatgpt-image-generator` (ChatGPT via Playwriter). If it cannot run, say so instead of pretending an image was generated.
- Treat every image-model prompt as a complete, fresh design brief. The image model does not reliably remember previous prompts, screenshots, feedback, accepted decisions, rejected ideas, generated images, or code context.
- Re-read relevant CSS, token files, and components immediately before prompting when the user says values changed.
- Inspect generated output before summarizing it. If labels are unreadable, crowded, or contradictory, re-prompt with a smaller comparison.
- Do not stop at image generation. After the generated image is available, continue by inspecting it and returning a written recommendation so the user never has to read the image annotations themselves.
- Treat image-model guidance as design intent. Map it back to real app tokens, components, and CSS yourself before editing code.

## Image Backend: ChatGPT via Playwriter

This agent has no native image-generation tool. Every image in this skill is generated through `chatgpt-image-generator`. Read [chatgpt-image-generator](../chatgpt-image-generator/SKILL.md) and follow its workflow: open a fresh ChatGPT tab in the personal Edge profile, click the composer plus button, select `Create image`, submit the prompt, download the generated image, and inspect the saved file yourself before summarizing. Selecting `Create image` is mandatory — prompt wording alone makes ChatGPT reply with text instead of an image. Save generated images and scratch screenshots under `tmp/design-ideation/<run-id>/`.

## Core Workflow

1. Gather the current visual and code context.
   - Use the user's screenshot, a fresh app screenshot, or both.
   - Read the relevant component CSS and global token definitions.
   - Capture current implementation values separately from available candidate values.
   - Include important neighboring visual elements, such as selected states, badges, disabled buttons, surfaces, and outer borders.
   - For border, shadow, active/pressed, hover, and focus decisions, include live computed values for `background`, `box-shadow`, `border`, `border-width`, `padding`, `box-sizing`, `background-clip`, `border-radius`, and component dimensions. A transparent real border can still create a visible rim and change where inset shadows start.
2. Build a complete image-model prompt.
   - Include the screenshot and the exact current CSS values.
   - Include candidate tokens with values, not token names alone.
   - State which visual decision is being made.
   - Ask for a verdict, rationale, hierarchy check, and implementation note.
   - Ask the model to compare against the current implementation, not just pick an ideal value in isolation.
3. Generate focused outputs.
	- Prefer one decision per image, such as divider color, selected-border color, button contrast, spacing density, or hover state.
	- Generate multiple images when comparing interaction states, competing visual directions, or dense token choices. Do not artificially collapse the exploration into one image when separate variants would make the decision clearer.
	- When multiple images are useful, separate them by purpose, such as a broad option board first and a focused final-spec board second.
	- Use fewer candidates when text readability matters.
	- Ask for large labels and a concise recommendation.
4. Inspect and translate.
   - Open the generated image.
   - Read the visible verdict and callouts.
   - Decide whether the recommendation is coherent with the app's actual tokens and hierarchy.
   - If implementation should change, identify the exact declarations to update.
5. Report before editing unless the user already asked to proceed.
   - Always provide the recommendation in normal text; never require the user to read or interpret the generated image.
   - Summarize the image model's recommendation in text.
   - Compare it to current code values.
   - Say whether token definitions need to change or only token usages need to change.
   - Mention generated image paths only when useful.
6. Implement narrowly when approved.
   - Re-read touched files first.
   - Change only the accepted CSS/component values.
   - Do not alter token definitions unless the recommendation truly requires a system-wide token change.
   - Verify with `git diff` and a targeted search.

## Prompt Checklist

Every prompt for color, spacing, or UI hierarchy should include:

- product surface and target component
- current screenshot or generated reference image
- current implementation tokens and CSS usages
- live computed box-model and paint values when judging shadows, borders, or pressed states
- available token names and raw values
- relevant theme, usually dark mode for this app unless the task says otherwise
- selected, hover, disabled, and empty states if they affect the decision
- hard constraints, such as "do not change layout" or "only choose from existing tokens"
- expected output: `verdict`, `compare with current`, `recommended token`, `why not the alternatives`, and `implementation note`

## Color And Token Decisions

For token selection tasks:

- Prefer existing tokens over new token definitions.
- Compare against nearby hierarchy, not only local contrast.
- Distinguish structural borders from interactive borders. Structural dividers should usually be quieter than selected, focus, or accent borders.
- Check whether the current token is intentionally stronger for accessibility or merely visually heavy.
- Ask the image model to rank the current value and candidates, then make a keep/change verdict.
- Use foreground and accent tokens only when the UI element is semantic or interactive enough to justify that emphasis.

Example prompt shape:

```text
Use this screenshot and the current CSS/token values to recommend the best existing token for [specific UI element].

Current implementation:
- Surface: --color-base-...
- Outer border: --color-base-...
- Current [element]: --color-base-...
- Selected/accent state: --color-accent-...

Available candidates:
- --color-base-...: oklch(...)
- --color-base-...: oklch(...)
- --color-base-...: oklch(...)

Compare the current value against the candidates. Choose "keep current" or "change to ...".
Prioritize visual hierarchy, clarity, and consistency with nearby borders. Do not propose new tokens.
Make the output readable and include a final implementation note.
```

## Interaction And Layout Decisions

For interaction-heavy UI, ask the image model to make explicit policy decisions:

- normal, hover, active, focus, selected, invalid, disabled, and loading states
- keyboard behavior
- whether invalid actions clamp, block, merge, snap, cancel, or ask for confirmation
- what message appears and what state is stored
- undo/redo implications when relevant

Use still images for visual policy and browser evidence for motion, timing, and event handling.

## Files Sidebar Selection Marker Lessons

When ideating Files sidebar tree selection, do not use bold text as the primary selected/navigated signal. Bold changes text metrics, creates jitter across folder/file names, and competes with dense metadata.

Accepted direction for the current app:

- Use a stable row-left accent rail for navigated rows.
- Keep all row text at regular `font-weight: 400`; do not change font size, row height, or icon spacing.
- Make non-selected idle row text one shade quieter than before (`--color-fg-07`), then restore hover and selected text to the navigated-row lightness (`--color-fg-10`) so filenames do not feel too dim during pointer exploration.
- Preserve the existing selected row fill as the surface state, then layer the accent rail as a marker.
- Place the rail at the far left of the selected row surface rather than following folder/file indentation.
- Use the app accent token for the accepted rail direction: `--color-accent-06` / `oklch(0.628 0.113 42)`.
- Use a small vertical pill marker: about `3px` wide, `28px` tall in a `44px` row, fully rounded.
- Treat keyboard focus as a separate top-layer outline using the existing focus token. Keep the rail below the focus layer, but offset it inside the focused surface enough that the ring stays continuous and the rail remains visible.
- Idle/non-renaming titles are implemented through a disabled transparent input; remove readonly/disabled title input chrome completely so the item name reads as plain text. Keep the input box transparent with no border, outline, or shadow outside rename mode, and make the disabled title control inherit the row color so selected and idle filenames have the same contrast relationship as their icons.
- Hover-only and focus-only rows should not show the rail; the rail belongs to the navigated/current route state.
- Menu/open action states should not replace or obscure the rail.

For follow-up prompts, ask the image model to show both folder and file navigated states, plus navigated+keyboard-focus combinations, because indentation can make a marker look aligned for one node type and wrong for another.

## Files Sidebar Drop Zone Lessons

When ideating Files sidebar drag/drop states, keep the prompt grounded in the real app tokens and current browser screenshots. Include the current row height, folder indentation, root/sidebar borders, tree rails, selected row styling, and the exact `app.css` token values under consideration.

Accepted constraints for the current app:

- Use the existing orange accent family for valid root/folder drop targets, especially `--color-accent-06` for dotted enclosure borders and `--color-accent-07` for indicator text/icon.
- Highlight folder drops as the whole visible folder subtree, not only the target folder row.
- Keep depth/tree guide lines neutral; do not color them as part of the drop target.
- Avoid white safe areas, glowing rectangles, gradients, halo borders, or new palette values unless the user explicitly asks for a new visual language.
- If an upload/drop label can overlap nearby file text, make the indicator itself dark, translucent, and blurred instead of adding a separate outer safe-area layer or reserving extra row height.
- Ask the image model to call out anti-patterns explicitly when a previous design was rejected, then verify the implementation screenshot against those rejected traits.

## Pressed Surface And Shadow Decisions

When ideating pressed buttons, icon buttons, cards, tabs, or list items:

- Ask whether the pressed state reads as a surface being pressed, not as a hole, black patch, or unrelated material.
- Compare the full state recipe, not only the shadow: fill gradient, text/icon color, real border, shadow, radius, padding, and dimensions all affect the result.
- Call out whether the design uses a real border or an inset/fake border. Real borders reserve space and can prevent inset shadows from visually reaching the outer edge.
- For small icon buttons, verify the target remains the intended size after border or padding changes.
- Use the closest accepted component state as the visual reference, such as the organization/workspace active list item when aligning other pressed controls.

## Output Contract

When using this skill, return:

- whether the image model was used
- what screenshots and code values were included
- whether generated output was inspected
- the image model's recommendation
- the comparison against current code
- the exact implementation change, if any
- what lint, type-check, or test commands were run, or that they were skipped
