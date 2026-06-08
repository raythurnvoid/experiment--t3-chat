# Bash Tool Agent Evaluation

Use this playbook to evaluate whether Bash-tool changes make the in-app AI smoother or worse. This is not a smoke test: every Bash-tool change should go through the same loop of fixture readiness, baseline, one attempted change, repeated live-agent runs, scored comparison, and an explicit accept/reject/revert decision.

The Bash tool is a database-backed virtual filesystem. Exact POSIX compatibility is not the target. DB-backed correctness, safe pagination, cwd-safe continuation commands, and grounded final answers are the target.

## Non-Negotiables

- Use the user's existing local app tab. Do not start the dev server from Codex.
- Keep the same visible model, mode, fixture folder, and prompts for baseline and post-change runs.
- Start each scored scenario in a fresh chat unless the scenario is explicitly testing cwd persistence or cursor continuation.
- Ask the agent to use Bash so the chosen command is visible.
- Bash may print short cursor ids without an `@` prefix in `Next page:` commands; score continuation as correct only when the agent runs the exact printed command.
- If a prompt asks for exactly one continuation, score as incorrect when the agent runs a second continuation from the second page.
- Score only after fixture verification proves the required files and search data exist.
- Unit tests alone are insufficient for prompt/tool-description changes.
- Playwriter is a light evidence collector, not the evaluator. Scoring remains rubric-based because final-answer grounding and false claims need judgment.

## Evaluation Loop

1. Record the current diff label, branch/commit if available, visible model, visible mode, and app URL.
2. Create or verify the dedicated fixture folder.
3. Run fixture verification commands through the in-app agent.
4. Run a baseline on the current code if the model, mode, fixture, or prompts changed since the last baseline. Prefer the affected scenario set plus canaries; run the full matrix only when accepting a meaningful change.
5. Save a patch for the attempted files before editing when a revert may be needed.
6. Apply one attempted change at a time when possible.
7. Run deterministic unit/prompt tests for the changed surface.
8. Rerun affected Playwriter scenarios first, then the three canaries.
9. Accept, revise, or revert based on the scoring rules.
10. If accepted, run the smallest matrix that proves the change and update the ledger. Run the full matrix only for broad Bash behavior or prompt-surface changes.

When a live run exposes weird behavior, add the smallest deterministic unit or prompt assertion test that protects the command behavior or durable guidance before continuing.

## Playwriter Setup

Use Playwriter against the existing Chrome app tab. Commands that execute Node must go through Vite Plus.

Create a session and install the generic app harness when needed:

```powershell
$sessionOutput = vp env exec --node 24.16.0 -- pnpx.CMD playwriter session new
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
vp env exec --node 24.16.0 -- pnpx.CMD playwriter -s $session -e 'const fs = require("node:fs"); const code = fs.readFileSync(".agents/skills/app-playwriter-harness/scripts/install-harness.js", "utf8"); await eval(code);'
```

Use the app harness from `.agents/skills/app-playwriter-harness/` when writing snippets. Bind to the chat route:

```text
/w/personal/home/chat
```

Do not navigate away from the user's real app session unless the current evaluation step needs a new chat or the `/files` upload flow.

## Playwriter Light Protocol

Use short, single-purpose snippets. Do not create a monolithic matrix runner. Each Playwriter call should normally finish in under 5 seconds; only prompt submission or final evidence capture may use up to 30 seconds. If the agent is still streaming, wait outside Playwriter in small increments such as `Start-Sleep -Seconds 5`, then run the capture snippet again. Do not bake long sleeps into JavaScript.

Treat `../t3-chat-+personal/+ai/bash-live-eval-runner.js` as historical scratch evidence, not future infrastructure.

### Bind Snippet

Bind to the existing chat tab and print basic run context. This should not start the dev server or open a new browser.

```powershell
vp env exec --node 24.16.0 -- pnpx.CMD playwriter -s $session -e 'await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/w/personal/home/chat" }); state.page.setDefaultTimeout(5000); console.log(JSON.stringify({ url: state.page.url(), title: await state.page.title() }, null, 2));'
```

Record the visible model and mode from the UI in the ledger. If the snippet cannot read them reliably, record them manually from the browser instead of expanding the snippet.

### Fresh Chat Snippet

Start one clean scenario run. If this fails, inspect the page manually instead of adding fallback branches.

```powershell
vp env exec --node 24.16.0 -- pnpx.CMD playwriter -s $session -e 'state.page.setDefaultTimeout(5000); await state.page.getByRole("button", { name: /new chat/i }).first().click(); console.log(JSON.stringify({ url: state.page.url(), bodyPreview: (await state.page.locator("body").innerText()).slice(0, 800) }, null, 2));'
```

### Send Prompt Snippet

Submit exactly one scenario prompt. Do not wait for the full answer here.

```powershell
$prompt = @'
Use Bash to search for basheval-common-<runId> with limit 1. If Bash prints a Next page command, run exactly one continuation.
'@
$promptJson = $prompt | ConvertTo-Json -Compress
$code = "state.page.setDefaultTimeout(5000); const prompt = $promptJson; const textbox = state.page.getByRole('textbox').last(); await textbox.fill(prompt); await textbox.press('Enter'); console.log('submitted');"
vp env exec --node 24.16.0 -- pnpx.CMD playwriter -s $session -e $code
```

### Capture Snippet

Capture evidence from the current chat only. If the current selector captures stale chat history, record that as an evaluation tooling issue and inspect the transcript manually; do not expand this into a large runner.

```powershell
vp env exec --node 24.16.0 -- pnpx.CMD playwriter -s $session -e 'state.page.setDefaultTimeout(5000); const text = await state.page.locator("main, [role=main], body").first().innerText({ timeout: 5000 }); const bashLabels = await state.page.locator("summary[aria-label^=\"Bash:\"], button").evaluateAll((els) => els.map((el) => el.textContent?.trim() || el.getAttribute("aria-label") || "").filter((text) => /bash/i.test(text)).slice(-12)); console.log(JSON.stringify({ url: state.page.url(), bashLabels, transcriptTail: text.slice(-6000) }, null, 2));'
```

For each scored run, paste the evidence into the ledger with:

For each run, save:

- prompt text;
- commands selected by the agent;
- stdout/stderr snippets that support the final answer;
- final answer text;
- score and notes.

Use this compact ledger row while evaluating one scenario at a time:

| Run | Scenario | Prompt | Commands | Evidence | Score | Decision Notes |
| --- | --- | --- | --- | --- | ---: | --- |

## Fixture Readiness

Before every full evaluation, create or verify one dedicated app fixture folder:

```text
/home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId>
```

Use a stable `<runId>` such as `2026-06-06-a`. Keep the same fixture for baseline and post-change runs.

### Required Contents

- A normal small Markdown file containing a distinctive token.
- Multiple `.md` files under nested folders so `find`, `tree`, extension search, and path search have real results.
- A large Markdown file with at least 120 lines and enough bytes to trigger Bash large-file paging.
- A broad token appearing in multiple files so `search --limit 1` can print a real `Next page`.
- An uploaded PDF/source file using `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.
- A readable sibling such as `<uploaded>.pdf.md` so unreadable-source recovery can actually continue.

### Markdown Fixture Prompt

Fixture files used for scored `search` scenarios must be committed app content with materialized plain-text chunks. Unapplied `write_file` / `edit_file` pending updates are not enough: Bash exact reads may see pending content, but indexed `search` only proves committed searchable data after the changes are applied/materialized. Prefer a committed setup path such as `files_nodes:create_file_by_path` with `markdownContent`, or explicitly apply and verify pending writes before scoring.

Use Agent mode and app file writes only when the run is evaluating pending-update behavior or when the writes will be applied before scoring. Replace `<runId>` with the actual value.

```text
Use file-writing tools to create this app fixture folder:
/home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId>

Create:
- README.md with the token basheval-distinctive-<runId> and the broad token basheval-common-<runId>.
- docs/guide.md with basheval-common-<runId>.
- docs/reference/readme-notes.md with basheval-common-<runId>.
- docs/reference/deep/topic.md with basheval-common-<runId>.
- notes/today.md with basheval-common-<runId>.
- large/large-paged.md with at least 140 numbered lines. Include basheval-large-<runId> on line 1 and basheval-common-<runId> on several later lines.

After writing, use Bash to verify the fixture exists.
```

### Uploaded Source Fixture

Use the `/files` UI upload flow with:

```text
.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf
```

Place or move it under the fixture folder when the UI supports that flow. If upload conversion is unavailable locally, create the readable sibling manually:

```text
/home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId>/uploads/r2-upload-sample.pdf.md
```

The fallback does not prove upload conversion, but it still lets the Bash recovery wording be evaluated.

### Fixture Verification Commands

The in-app agent must run these before scoring:

```bash
find /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId> -maxdepth 3 --limit 20
search --path /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId> --limit 1 basheval-distinctive-<runId>
head -n 3 /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId>/large/large-paged.md
find /home/cloud-usr/w/personal/home/bash-eval-smoothness-fixture-<runId> --extension pdf -type f --limit 5
```

Pass criteria:

- `find` shows the nested Markdown structure.
- `search --path` returns a real matching result, not an empty page with speculation.
- `head -n 3` returns the top of the large file and, when large enough, a continuation hint.
- `find --extension pdf -type f` finds the uploaded source, or the run is marked as missing-upload-fixture and the unreadable-source scenario is not scored.

Do not score a scenario that depends on missing fixture data.

## Baseline And Attempt Records

For each attempt, record:

- hypothesis;
- touched files;
- saved patch location if one was created;
- unit or prompt tests run;
- Playwriter run IDs or chat identifiers;
- before/after score tables;
- accepted, revised, or rejected decision;
- rollback notes;
- follow-up candidates.

Save attempt patches outside the repo when useful, for example:

```powershell
git diff -- packages/app/convex/bash.ts packages/app/server/server-ai-tools.ts > ..\t3-chat-+personal\+ai\bash-tool-attempt-<n>.patch
```

Do not use `git reset --hard`, `git checkout --`, or staging-index changes as part of this workflow. Revert only the attempt's own patch, never unrelated user changes.

## Evaluation Matrix

Run baseline and post-change against the same fixture, visible model, and mode.

Run each scenario 3 times as separate scenario-level runs, not as one long loop script. Use 5 runs if behavior is noisy or if the change is prompt/tool-description wording.

### Core Scenarios

1. Scoped content search with explicit folder:
   `Use Bash to search inside <fixture> for basheval-distinctive-<runId> with one result.`
2. Scoped content search through cwd:
   `Use Bash. Go into <fixture>, search for basheval-distinctive-<runId> with limit 1, and summarize the result.`
3. Project-wide content search:
   `Use Bash to find where basheval-distinctive-<runId> appears anywhere in the project.`
4. Search cursor continuation:
   `Use Bash to search for basheval-common-<runId> with limit 1. If Bash prints a Next page command, run exactly one continuation.`
5. Tree cursor continuation:
   `Use Bash to show a tree for <fixture> with limit 3. If Bash prints a Next page command, run one continuation.`
6. Find type/depth:
   `Use Bash to list files under <fixture> at max depth 2.`
7. Path word search:
   `Use Bash to find files whose path/name contains readme under <fixture>.`
8. Name lookup carve-out:
   `Use Bash to search for the README file under <fixture>.`
9. Recent immediate children:
   `Use Bash to list the recent immediate children of <fixture>.`
10. Recent immediate children through cwd:
   `Use Bash. Go into <fixture>, then list the recent immediate children of the current directory.`

### Bad-Habit Scenarios

1. Recursive grep request:
   `Use Bash to grep recursively under <fixture> for basheval-common-<runId>.`
2. Pipe temptation:
   `Use Bash to cat <fixture>/README.md and pipe it to grep/head to find basheval-distinctive-<runId>.`
3. Simple glob request:
   `Use Bash to find *.md files under <fixture>.`
4. Extension filtering request:
   `Use Bash to find markdown files under <fixture> using extension filtering.`
5. Regex path request:
   `Use Bash to search paths matching a regex for readme under <fixture>.`

### Reliability Scenarios

1. Large-file continuation after cwd change:
   `Use Bash. From <fixture>, page large/large-paged.md with head -n 3. Then cd to /home/cloud-usr and run exactly the printed Next page command.`
2. Prefix continuation after cwd change:
   `Use Bash. From <fixture>, run find --prefix docs --limit 1. Then cd to /home/cloud-usr and run exactly the printed continuation.`
3. Unknown command:
   `Use Bash to show disk usage of <fixture> with du.`
4. Fancy single-file grep flag:
   `Use Bash to grep -o basheval-distinctive-<runId> in <fixture>/README.md.`
5. Unreadable uploaded source:
   `Use Bash to head <fixture>/uploads/r2-upload-sample.pdf.`
6. Large-file byte mode:
   `Use Bash to read the first 100 bytes of <fixture>/large/large-paged.md with head -c.`
7. Literal command-not-found content:
   `Use Bash to cat a fixture file containing the literal line "example: command not found", then grep for "command not found" in that file.`
8. Regex-looking single-file grep:
   `Use Bash to grep '^# Readme' in <fixture>/README.md.`
9. Literal wildcard single-file grep:
   `Use Bash to grep 'basheval.*common' in <fixture>/README.md.`
10. Unicode cat pipe:
   `Use Bash to cat <fixture>/unicode.md and pipe it to wc -c.`
11. Combined wc flags:
   `Use Bash to run wc -lw <fixture>/README.md.`

### Canaries

These must always pass:

1. `ls -t <fixture>` remains immediate-child recency and does not claim subtree recency.
2. `search --limit 1 basheval-common-<runId>` follows exactly one printed continuation if present.
3. `tree <fixture> --limit 3` follows exactly one printed continuation if present.

## Scoring

Score each run from 0 to 3.

- `3`: smooth pass; one or two good commands, correct scope, concise grounded answer.
- `2`: recovered; first command unsupported or suboptimal, then correct recovery.
- `1`: rough; correct final answer but extra commands, confusing text, or weak grounding.
- `0`: fail; wrong scope, missed cursor, hallucinated support/output, false claim, or no recovery.

Track these metrics:

- average score;
- count of `3/2/1/0`;
- average Bash command count;
- DB-backed first-command rate;
- unsupported-command rate;
- false-claim rate;
- cursor correctness;
- scope correctness;
- final-answer grounding rate.

Use this table for each run:

| Run | Scenario | Prompt | Commands | Score | Cmd Count | DB First | Unsupported | Cursor OK | Scope OK | Grounded | False Claim | Notes |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |

Use this table for aggregates:

| Phase | Avg Score | 3/2/1/0 | Avg Cmds | DB First | Unsupported | False Claims | Cursor OK | Scope OK | Grounded |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

## Acceptance

Accept a change only if:

- all deterministic unit tests and prompt assertion tests for the changed surface pass;
- all canaries pass;
- no core scenario scores `0`;
- false-claim rate is `0`;
- cursor correctness is `100%`;
- aggregate average improves, or the change fixes a correctness bug with no aggregate regression;
- average command count does not increase unless the extra command is a necessary recovery.

Reject or revise if:

- a core canary regresses;
- a prompt improvement helps one bad habit but worsens normal DB-backed commands;
- the agent starts using unsupported native syntax more often;
- the final answer summarizes anything not present in Bash stdout/stderr.

## Revert And Alternative Loop

Before each attempt:

- record the current diff label and touched files;
- save a patch for only the files the attempt will touch when practical;
- run baseline on the current code if model, mode, fixture, or prompts changed since the previous baseline.

During each attempt:

- change one idea at a time when possible: Bash behavior, Bash error wording, system prompt wording, or tool description wording;
- add a deterministic test when a live failure maps to stable Bash output or prompt text;
- try at most two narrower alternatives if the first solution regresses.

If worse:

- revert only the attempt's own patch;
- record the rejected hypothesis, exact failing prompts, commands chosen, and metric delta;
- keep rejected wording out of durable docs;
- if the change fixed a real correctness bug but worsened smoothness, keep the behavior fix and search for a prompt/tool-description alternative that restores smoothness.

## Required Verification

After code or prompt changes:

```powershell
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app exec vitest run --project convex convex/bash.ts convex/ai_chat.ts server/server-ai-tools.test.ts
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app run lint
git diff --check
```

After verification:

- run affected Playwriter scenarios first;
- run the three canaries;
- if accepted, run the full matrix;
- update `../t3-chat-+personal/+ai/bash-tool-smoothness-eval.md` with before/after tables and the final decision.

## Final Report Format

Every evaluation pass should report:

- fixes or attempted changes;
- vitest, lint, and `git diff --check` results;
- before/after aggregate table;
- pass/recovery/rough/fail counts;
- examples of improved and worsened behavior;
- remaining risks and follow-up candidates;
- whether the change was accepted, revised, or reverted.

## Durable Notes

- `search` is full-text content search: pass one distinctive word or a few plain terms from the document body. The text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. It is implemented with Convex full-text search, but it is not regex/glob/exact grep or path/name search.
- `find --extension md -type f` is exact indexed extension search.
- Simple `find -name '*.md'` and `find <dir>/*.md` are recovery syntax for extension search only, not general glob support.
- General glob and regex behavior should stay unsupported unless they map to a DB-backed query.
- Scoped `search --path <folder>` is filtered before pagination, but broad scopes with common terms can still be heavier.
- `ls -t <dir>` is immediate-child recency only.
