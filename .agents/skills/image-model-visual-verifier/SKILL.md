---
name: image-model-visual-verifier
description: Use the image model as a visual verifier for browser screenshots, design references, generated mockups, and UI implementation checks in this app. Use when Codex needs to compare a current UI screenshot against a desired/reference image, ask what is missing visually, generate an annotated visual-diff report, or translate visual discrepancies into implementation guidance.
---

# Always Provide A Complete Evidence Packet

The image model does not reliably remember earlier screenshots, generated references, accepted decisions, rejected ideas, or code constraints. Provide every required screenshot, role label, accepted decision, and code constraint in the current prompt.

# Image Backend

Use a callable direct image-generation tool first. A direct generation call is the final action in its turn: the generated report image is the only turn output, and no local report path is guaranteed. Do not inspect, summarize, edit code, or send text after that call. If the task also needs a written verdict or implementation, say before generation that the workflow must continue in a later user turn. Continue only when the report is available as an attached or local image; ask the user to attach it again when it is not available. If no direct tool is callable, read [chatgpt-image-generator](../chatgpt-image-generator/SKILL.md) and follow its continuation-capable ChatGPT browser fallback.

When using the ChatGPT fallback:

- Upload both `REFERENCE` / `DESIRED VERSION` and `CURRENT IMPLEMENTATION` screenshots in the same composer.
- Open the composer plus menu and select `Create image` before submitting. This is mandatory — without it ChatGPT returns a text comparison instead of a generated report image, which is an invalid verifier run.
- Prepend `Generate an image:` to the prompt template below, and end the prompt with `Do not answer with only text. The required output is a generated image report.`
- Repeat the role labels in the prompt text because ChatGPT can invert `REFERENCE` and `CURRENT IMPLEMENTATION`. If the downloaded report inverts the roles or the text is unreadable, start a fresh ChatGPT tab, re-select `Create image`, and regenerate.
- Save the report, screenshots, and runners under `../t3-chat-+personal/+ai/visual-verification-YYYY-MM-DD/`, then open the report with your image-view tool before translating it into code.
- If the generator cannot run (login wall, captcha, Playwriter unavailable), say so plainly instead of inventing a verdict.

# Core Workflow

1. Capture the current implementation.
   - Use Playwriter or the Browser plugin to screenshot the live app.
   - Prefer a full modal/page screenshot when surrounding hierarchy matters.
   - Also capture a component crop when fine details such as shadows, borders, alignment, or icon centering matter.
   - For visual issues involving color, border, rim, shadow, pressed state, or layout constraints, capture the live computed CSS and dimensions. Include values such as `background`, `box-shadow`, `border`, `border-width`, `padding`, `box-sizing`, `background-clip`, `border-radius`, `width`, and `height`.
2. Locate or create the desired reference.
   - Use the exact generated-image path, user-provided screenshot, or accepted mockup path when available.
   - If the reference came from chat or an earlier image generation, include it again in the current image-model request.
3. Send both images to the image model in the same request.
   - Label one image `REFERENCE` or `DESIRED VERSION`.
   - Label the other image `CURRENT IMPLEMENTATION`.
   - Repeat the labels in the prompt because image models can invert roles.
4. Ask for a visual verification report.
   - Request side-by-side target-area comparison.
   - Request readable callouts and a ranked checklist.
   - Ask for `PASS`, `WARN`, or `FAIL`.
   - Ask what is missing for the current implementation to match the desired version.
5. Inspect the generated report with the browser fallback, or in a later turn when a direct-tool report is available as an attached or local image.
   - Open the generated image path.
   - Read the embedded verdict and callouts.
   - If the report is dense, illegible, or role-inverted, regenerate with fewer callouts and larger text.
   - If the report contradicts the live screenshot or computed browser facts, do not implement the hallucinated finding. Re-prompt with the live measurements as ground truth and ask the model to judge only remaining visual gaps.
6. Translate the report into code. Never do this after a direct image-generation call in the same turn.
   - Treat image-model CSS as approximate visual intent.
   - Map recommendations to this repo's real components, CSS files, and tokens.
   - Implement the smallest local change that matches the accepted visual direction.
7. Re-capture and iterate when needed.
   - Reuse the same reference image.
   - Provide the updated live screenshot.
   - Ask only whether the remaining visual differences are acceptable.

# Prompt Template

```text
Create a visual verification report image comparing these two screenshots.

Image A is the REFERENCE / DESIRED VERSION.
Image B is the CURRENT IMPLEMENTATION.
Do not invert them.

Target area: <specific component or state>.
Goal: make Image B match Image A only in the target area.

Focus on perceptual UI correctness, not pixel-perfect differences from image-generation noise.
Ignore unrelated page content, text rendering noise, compression artifacts, and tiny browser differences.

Produce one report image with:
- reference and current target areas side by side
- colored callouts for the most important visible differences
- readable text labels explaining what to change
- approximate CSS-style measurements only when helpful
- a short ranked checklist
- a PASS, WARN, or FAIL verdict

Do not write production code. Keep code-like notes as approximate styling guidance only.
```

# What To Ask The Image Model To Judge

- visual hierarchy and attention
- optical alignment and centering
- spacing, density, and rhythm
- component scale relative to the surrounding modal/page
- border radius, edge softness, and ring visibility
- color temperature, contrast, and token fit
- shadow, inset shadow, glow, blur, and depth
- whether a control feels too flat, too heavy, too loud, or unfinished
- consistency across idle, hover, active, selected, disabled, and open states

Do not ask the image model to decide final selectors, accessibility semantics, product state validity, or production-ready code.

# Verification Modes

## Reference Match

Use when there is an accepted mockup, generated design, or user-provided desired screenshot.

Provide:
- desired/reference screenshot
- current implementation screenshot
- target area and state
- constraints such as fixed size, token-only colors, or no transforms

Ask for side-by-side comparison, ranked differences, and a pass/warn/fail verdict.

## State Review

Use when validating interaction states.

Provide:
- idle screenshot
- hover screenshot
- active/open/disabled screenshot when relevant
- expected behavior for each state

Ask whether the progression reads correctly and what a still image cannot prove.

## Files Sidebar Drop Zone Review

When verifying Files sidebar drop-zone screenshots, provide the accepted visual constraints in the prompt instead of relying on previous chat context:

- root and folder drops should share an orange dotted enclosure based on existing app accent tokens
- folder drops should cover the visible folder subtree, not only the folder row
- depth/tree guide lines should stay neutral
- any overlapping indicator should itself be dark, translucent, and blurred without a separate outer safe-area layer
- reject white safe areas, glow, gradients, colored rails, and one-row-only folder highlights unless the user explicitly changed direction

## Box Model And Pressed Surface Review

Use this review shape for active/pressed controls, rim complaints, shadow-depth changes, and small icon buttons.

Provide:
- current active/pressed screenshot crop
- accepted reference state screenshot, if one exists
- live computed `background`, `box-shadow`, `border`, `border-width`, `padding`, `box-sizing`, `background-clip`, `border-radius`, `width`, and `height`
- expected material rule, such as "no real border", "no outer shadow while active", or "inset shadow should affect the whole visible surface"

Ask:
- whether any visible edge is a real unwanted border/rim or only normal antialiasing/material edge
- whether inset shadows visually start inside a reserved border area
- whether the pressed state reads like the same material as the reference, scaled to the current component
- whether padding or size compensation is needed after border changes

# Guideline Extraction

Use after accepting a generated design but before implementing.

Ask for:
- approximate sizes, gaps, padding, hit areas, alignment
- border, radius, opacity, fill, shadow, and depth direction
- typography hierarchy and density
- state styling for idle, hover, active, selected, disabled, invalid, and loading states

Map the guidance to real app tokens and CSS yourself.

# Practical Rules

- Always include screenshots in the current image-model request; do not say "use the previous image".
- Keep browser screenshots and generated reports in known artifact paths.
- Prefer component crops for tiny controls and full-page screenshots for hierarchy.
- Treat live browser measurements as ground truth. Image-model reports can redraw or simplify screenshots and may invent wrapping, rims, borders, or constraints that are not present.
- When a report is useful but stale because it analyzed the pre-fix screenshot, run a second verifier pass with the post-fix screenshot before declaring success.
- Ask the model to ignore unrelated page regions.
- Ask for large readable labels in generated reports.
- Inspect generated output before summarizing it when using the browser fallback, or in a later turn when a direct-tool output is inspectable.
- With the browser fallback, return a written verdict and implementation guidance so the user does not need to read the report image. With the direct tool, generation ends the current turn and written guidance must wait for a later turn.
- Use image-model reports as visual judgment, not acceptance tests. Verify behavior, keyboard semantics, disabled states, and data changes with Playwriter or code tests when relevant.

# Output Contract

After an inspected browser-fallback run, or in a later turn with an inspectable direct-tool report, return:

- reference image path
- current screenshot path
- image-model report path
- whether the report was inspected
- short verdict
- highest-impact visual gaps
- implementation changes made or recommended
- browser verification performed
- lint, type-check, and test commands run or intentionally skipped

For the direct generation turn itself, return only the generated report image as required by that backend. Do not claim a report path or inspection result.
