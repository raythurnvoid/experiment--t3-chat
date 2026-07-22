---
name: app-playwriter-harness
description: Use Playwriter to inspect, debug, test, and learn this browser app through the user's existing Chrome tabs. Use when working on localhost app flows, /files editor behavior, sidebar/navigation clickability, browser QA, app-specific Playwriter helpers, or durable Markdown memories for repeated browser actions.
---

# Keep The Installed Harness Generic

Use Playwriter directly, add only reusable primitives to the installed harness, and save task-specific workflows as Markdown recipes.

- Keep `scripts/install-harness.js` limited to generic browser QA primitives: tab binding, observation, logs, hit testing, generic element inspection, and memory-entry proposals.
- Do not add feature-specific helpers or one-off QA flows to the installed harness. If a helper name contains a feature, component, route, or bug name, it probably belongs in `references/*.md` instead.
- Put reusable feature recipes in the nearest reference doc, such as `references/files.md` for `/files` behavior or `references/snippets.md` for short copyable commands.
- Prefer composing generic helpers from docs over growing the helper namespace. Promote a recipe into the harness only when it is broadly reusable across routes and components.

# Start

1. Read the installed `playwriter` skill. Before the first Playwriter command in this session, run the CLI documentation through Vite Plus and read its full output. Do not truncate it:

```powershell
vp env exec pnpx playwriter skill
```

2. List connected browsers, copy the exact reported key for the browser that exposes the target app tab, and create an isolated session from the repo root:

```powershell
vp env exec pnpx playwriter browser list
$browserKey = "<exact KEY from browser list>"
$sessionOutput = vp env exec pnpx playwriter session new --browser $browserKey
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
```

3. Install the helper namespace in that session:

```powershell
vp env exec pnpx playwriter -s $session --% -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

4. Bind to the target app tab before acting:

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

# Workflow

- Observe before acting: print the URL and call `state.appPlaywriterHarness.observe(...)` or raw `snapshot({ page: state.page })`.
- Prefer Playwriter accessibility locators and normal clicks. Do not use `{ force: true }`, `dispatchEvent`, or `element.click()` to bypass blockers.
- Use `state.appPlaywriterHarness.inspectElement(...)` or `hitTest(...)` for layout and clickability bugs before trying alternate clicks.
- After every navigation, click, submit, or other state-changing action, call `state.appPlaywriterHarness.latestLogs({ sinceLastCall: true })`. This catches logs from the action without installing page listeners. Also check logs when the app looks blank or an action fails.
- Use `state.appPlaywriterHarness.hitTest({ x, y })` only for layout or clickability bugs where a visible element may be covered.
- Use `state.appPlaywriterHarness.auditAccessibility({ selector, minTargetSize })` as a quick accessibility screen for a route or region. It skips controls hidden by an ancestor or a closed disclosure, then reports unlabeled controls, hit targets blocked by overlapping elements, targets smaller than `minTargetSize` (default 24px), and controls with negative `tabIndex` that need review. It is not a full accessibility audit. Also check keyboard access, focus order and management, semantics, labels and errors, contrast, zoom and responsive fit, target size, and reduced motion.
- For route-specific checks, read the relevant reference recipe and run it with generic helpers instead of adding a new helper function.
- Keep each execute call focused on one observation or one action, then observe again.
- Prefer small observe-act-observe scripts over bundled multi-step runners during interactive debugging and eval inspection. Batch only when the user explicitly asks for a runner or the flow is already stable and repeatable.

# Run Playbooks Step By Step

Use the playbooks in `references/` for manual but repeatable QA when changing live data makes a stable `@playwright/test` setup impractical.

1. Read the routed reference docs and the playbook for the target flow.
2. Bind to the user's existing app tab or open the exact route required by the playbook.
3. Run each Playwriter snippet as a separate step and inspect the result before continuing.
4. Record pass, fail, skipped steps, and the evidence that supports each result.
5. Perform the playbook's cleanup only when it requests cleanup.

- Use dynamic run ids in temporary comment, folder, and file names.
- Prefer accessible locators and normal clicks. If actionability fails, inspect and hit-test the blocker; do not use forced clicks or DOM-dispatched clicks.
- Reopen comment threads after refresh before asserting that replies are missing.
- Keep snippets small and debuggable. Write runners and output only under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/`.
- Treat `references/r2-file-content-regression.md` as the currently maintained deep regression playbook. Treat the other playbooks as historical recipes until a focused task revalidates their routes, selectors, and command wrappers.

# Output Artifacts

Write every runner script, screenshot, CPU profile artifact, and scratch file to `../t3-chat-+personal/+ai/` under a descriptive `<topic>-YYYY-MM-DD` folder. The Playwriter CLI reads an `-f` runner before sandboxed code runs, so the runner may stay in the personal AI folder even though sandboxed `fs` cannot read sibling paths. Embed dynamic input in that runner or assign it to `state` in a short separate call. Do not create a second input file in the repository or OS temp directory. Use absolute personal-AI paths for Playwright output APIs. If the host cannot write to the personal AI folder, request approval. Promote a runner into `scripts/` only when it becomes a broadly reusable primitive.

# Memories

Use `state.appPlaywriterHarness.proposeMemory({ file, title, body })` only for reusable knowledge, such as stable selectors, route behavior, recurring blockers, or proven snippets. The helper returns a proposed Markdown entry; it does not write the file. Re-read the target reference, check for duplicates and private data, then add the entry with the agent's targeted edit tool.

Allowed memory files:

- `app-map.md`
- `agent-panel.md`
- `files.md`
- `known-hazards.md`
- `snippets.md`

Do not store secrets, cookies, tokens, user-private payloads, run diaries, raw coordinates, or one-off app state.

# References

- Read `references/app-map.md` for stable app routes, landmarks, and selectors.
- Read `references/agent-panel.md` for AI chat / agent panel selectors, the ProseMirror composer recipe, doneness polling, and backgrounded-tab recovery (`scripts/agent-chat-helpers.js` installs `state.qa`).
- Read `references/files.md` for `/files` route and file/sidebar basics.
- Read `references/plugin-gallery.md` for driving the Gallery plugin page inside its sandboxed iframe.
- Read `references/plugin-configuration.md` for saving upload-folder YAML and proving matched and unmatched automatic runs.
- Read `references/file-node-view.md` for selected-file editor surfaces, comments, diff, and right-sidebar workflows.
- Read `references/known-hazards.md` before debugging browser interaction failures.
- Read `references/snippets.md` for short Playwriter commands.
- Read `references/r2-file-content-regression.md` for deep R2-backed files, uploads, comments, and agent regression QA.
- Read `references/bash-tool-agent-eval.md` for the Bash agent fixture, scenario matrix, scoring, and acceptance loop.
- Read `references/bash-cursor-value-store-plan.md` as historical context for the Bash cursor-alias design and its live evaluation.
- Read `references/files-sidebar-smoke.md` for a historical files-sidebar smoke recipe.
- Read `references/comment-thread-persistence.md` for a historical comment persistence recipe.
- Read `references/rich-text-slash-command-keyboard.md` for a historical rich-text slash-menu keyboard recipe.
- Read `references/image-plugin-description.md` for a historical image-plugin upload and generated-description recipe.
- Read `references/video-plugin-transcription.md` for a historical audio/video transcription recipe.
