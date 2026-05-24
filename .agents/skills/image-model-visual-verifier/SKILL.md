---
name: image-model-visual-verifier
description: Use the image model as a visual verifier for browser screenshots, design references, generated mockups, and UI implementation checks in this app. Use when Codex needs to compare a current UI screenshot against a desired/reference image, ask what is missing visually, generate an annotated visual-diff report, or translate visual discrepancies into implementation guidance.
---

# Image Model Visual Verifier

Use this skill when visual correctness matters and DOM inspection is not enough. The image model acts as a visual reviewer that compares screenshots and produces readable instructions for Codex to implement.

The image model does not reliably remember earlier screenshots, generated references, accepted decisions, rejected ideas, or code constraints. Always provide the complete packet in the current prompt.

## Core Workflow

1. Capture the current implementation.
   - Use Playwriter or the Browser plugin to screenshot the live app.
   - Prefer a full modal/page screenshot when surrounding hierarchy matters.
   - Also capture a component crop when fine details such as shadows, borders, alignment, or icon centering matter.
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
5. Inspect the generated report yourself.
   - Open the generated image path.
   - Read the embedded verdict and callouts.
   - If the report is dense, illegible, or role-inverted, regenerate with fewer callouts and larger text.
6. Translate the report into code.
   - Treat image-model CSS as approximate visual intent.
   - Map recommendations to this repo's real components, CSS files, and tokens.
   - Implement the smallest local change that matches the accepted visual direction.
7. Re-capture and iterate when needed.
   - Reuse the same reference image.
   - Provide the updated live screenshot.
   - Ask only whether the remaining visual differences are acceptable.

## Prompt Template

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

## What To Ask The Image Model To Judge

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

## Verification Modes

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

## Guideline Extraction

Use after accepting a generated design but before implementing.

Ask for:
- approximate sizes, gaps, padding, hit areas, alignment
- border, radius, opacity, fill, shadow, and depth direction
- typography hierarchy and density
- state styling for idle, hover, active, selected, disabled, invalid, and loading states

Map the guidance to real app tokens and CSS yourself.

## Practical Rules

- Always include screenshots in the current image-model request; do not say "use the previous image".
- Keep browser screenshots and generated reports in known artifact paths.
- Prefer component crops for tiny controls and full-page screenshots for hierarchy.
- Ask the model to ignore unrelated page regions.
- Ask for large readable labels in generated reports.
- Inspect generated output before summarizing it.
- Do not stop at image generation; return a written verdict and implementation guidance so the user does not need to read the report image.
- Use image-model reports as visual judgment, not acceptance tests. Verify behavior, keyboard semantics, disabled states, and data changes with Playwriter or code tests when relevant.

## Output Contract

When using this skill, return:

- reference image path
- current screenshot path
- image-model report path
- whether the report was inspected
- short verdict
- highest-impact visual gaps
- implementation changes made or recommended
- browser verification performed
- lint, type-check, and test commands run or intentionally skipped
