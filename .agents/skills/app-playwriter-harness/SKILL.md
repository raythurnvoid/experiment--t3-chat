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

Run this section again after a context compaction or when resuming an old conversation. Previous session ids are dead, every new session starts with an empty `state` (`{}`), and leftover runners from the old context may target tabs, accounts, or org routes that no longer exist. Read `references/known-hazards.md` before the first Playwriter command — it answers most first failures (empty `state`, bare `context` global, the 10s default `--timeout`, the sandbox filesystem, always-mounted dialogs).

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

For this project, use the Edge install whose profile the user reserved for QA. The profile name is personal, so it is deliberately not written in this repo — read it from the user's private global agent rules (`~/.claude/CLAUDE.md`), and never copy it into a committed file. Match it by the profile column in `browser list`, not by a remembered key — key ids change. Use whatever account is signed in there; do not sign in or out. If the profile choice is ever unclear, no command lists tabs per browser before a session exists: create a session on the most likely key and probe `context.pages().map((p) => p.url())`; if the target tab is not there, create a session on the next key and delete the wrong one with `session delete <id>`. If your shell does not keep variables between calls, inline the printed session id into later commands. After creating the session, run `vp env exec pnpx playwriter session list` and check the CWD column: `/home/rt0/C:\...` means the relay is running in WSL and no sandbox `fs` path will reach the Windows disk — follow the relay-topology recovery in `references/known-hazards.md` before continuing.

3. Install the helper namespace in that session. Pass the script with `-f` and an absolute path — the CLI reads the file from the real disk before the sandbox starts. Do not use `-e` with `fs.readFileSync`: the sandbox filesystem cannot read repo files reliably (see `references/known-hazards.md`):

```powershell
vp env exec pnpx playwriter -s $session -f "C:/Users/rt0/Documents/workspace/rt0/t3-chat/.agents/skills/app-playwriter-harness/scripts/install-harness.js"
```

4. Bind to the target app tab before acting. Use PowerShell single quotes around `-e` with double quotes inside the JavaScript — the `--%` stop-parsing token does not survive `vp env exec`, and the CLI then misreads the JavaScript as a command name:

```powershell
vp env exec pnpx playwriter -s $session -e 'await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/w/personal/home/files" });'
```

5. Create a reminder now for the end of the task: your final report MUST end with the "Process debt" block from "Leave The Process Better Than You Found It" below (friction log, accessibility screen, recipes). A QA report without that block is incomplete, even when every answer is "none". If you keep a todo list, add this as a todo now.

# Workflow

- Observe before acting: print the URL and call `state.appPlaywriterHarness.observe(...)` or raw `snapshot({ page: state.page })`.
- Prefer Playwriter accessibility locators and normal clicks. Do not use `{ force: true }`, `dispatchEvent`, or `element.click()` to bypass blockers.
- Use `state.appPlaywriterHarness.inspectElement(...)` or `hitTest(...)` for layout and clickability bugs before trying alternate clicks.
- After every navigation, click, submit, or other state-changing action, call `state.appPlaywriterHarness.latestLogs({ sinceLastCall: true })`. This catches logs from the action without installing page listeners. Also check logs when the app looks blank or an action fails.
- Use `state.appPlaywriterHarness.hitTest({ x, y })` only for layout or clickability bugs where a visible element may be covered.
- Use `state.appPlaywriterHarness.hoverCard({ anchor, card })` to open an Ariakit hovercard (`MyHovercardAction`). It parks the pointer before hovering, which these cards require — a plain `hover()` onto coordinates the pointer already occupies never opens them. Pass `card` and scope follow-up clicks to it, because the content is portalled and the same action is often rendered a second time outside the portal inside a `hidden` container.
- Use `state.appPlaywriterHarness.auditAccessibility({ selector, minTargetSize })` as a quick accessibility screen for a route or region. It skips controls hidden by an ancestor or a closed disclosure, then reports unlabeled controls, hit targets blocked by overlapping elements, targets smaller than `minTargetSize` (default 24px), and controls with negative `tabIndex` that need review. It is not a full accessibility audit. Also check keyboard access, focus order and management, semantics, labels and errors, contrast, zoom and responsive fit, target size, and reduced motion. For rule-level findings, inject axe-core with the recipe in `references/snippets.md`; for what assistive tech actually receives (accessible name, description, `focusable`/`disabled` state), read the browser's own tree with `Accessibility.queryAXTree` over `getCDPSession(...)` rather than trusting DOM attributes.
- For route-specific checks, read the relevant reference recipe and run it with generic helpers instead of adding a new helper function.
- Keep each execute call focused on one observation or one action, then observe again.
- Prefer small observe-act-observe scripts over bundled multi-step runners during interactive debugging and eval inspection. Batch only when the user explicitly asks for a runner or the flow is already stable and repeatable.

# Leave The Process Better Than You Found It

Improving the harness and its docs is part of every browser QA task, not a separate request. The user should never need to ask for it.

Before ending any task that used Playwriter, work through this checklist and end your final report with a "Process debt" block stating all three outcomes. A report without that block is an incomplete task, even when every answer is "none":

1. Friction log. Did any command, selector, or documented step fail or mislead you? Fix the doc in the same session: add or correct the entry in `references/known-hazards.md`, the route reference, or this SKILL.md. Follow the Memories rules below — reusable knowledge only, no run diaries. If nothing failed, say "no new hazards" in the report.
2. Accessibility. QA friction is often an accessibility bug: a control that cannot be located by role and accessible name is also broken for assistive tech. Run `state.appPlaywriterHarness.auditAccessibility(...)` on the main route you drove; skip it only for pure data-readback tasks and say so. Fix small app-side gaps (missing accessible name, wrong role, missing label) in the same session when they sit in or next to code the task already touches; for bigger findings, report them or spawn a follow-up task instead of derailing the current one.
3. Recipes. If you had to invent a working multi-step sequence for a flow no reference documents, record it in the nearest route reference so the next agent does not re-invent it.

Doc fixes from this checklist ride along with the task's commit or a small separate commit; do not leave them uncommitted.

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
- Read `references/second-user-fixtures.md` before testing any permission refusal, share grant, or other flow the org owner would bypass. It shows how to get a second identity in the browser without signing anything in.
- Read `references/clerk-test-accounts.md` when a check needs a specific signed-in account: how to log in and out as the seeded `+clerk_test` QA accounts in an isolated scratch browser, and the hard rules around it.
- Read `references/plugin-gallery.md` for driving the Gallery plugin page inside its sandboxed iframe.
- Read `references/plugin-marketplace.md` for installing, updating, and uninstalling plugins from the catalog and detail pages, and for embedding upload fixtures in runners.
- Read `references/plugin-configuration.md` for saving upload-folder YAML and proving matched and unmatched automatic runs.
- Read `references/file-node-view.md` for selected-file editor surfaces, comments, diff, and right-sidebar workflows.
- Read `references/collab-yjs-comments-regression.md` before changing the integrated collaboration code (`files-yjs-*.ts`, `file-editor-rich-text-*.ts`) or upgrading `@liveblocks/core`.
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
