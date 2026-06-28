# Bash Tool Agent Evaluation

Use this playbook to evaluate whether Bash-tool changes make the in-app AI smoother or worse. This is not a smoke test: every Bash-tool change should go through the same loop of fixture readiness, baseline, one attempted change, repeated live-agent runs, scored comparison, and an explicit accept/reject/revert decision.

The Bash tool is a mixed-path virtual shell. The app mount under `/home/cloud-usr/w/<workspace>/<project>` is Convex-backed and intentionally not full POSIX. `/tmp` is durable per-thread scratch: it persists across Bash calls in the same chat and reloads from Convex if the warm backend runtime cache is gone, but it is not app project storage and is not shared with new chats. Evaluation must catch both sides: app-mount limits must not leak into `/tmp`, and `/tmp` flexibility must not bypass app-mount safety.

## Non-Negotiables

- Use the user's existing local app tab. Do not start the dev server from Codex.
- Keep the same visible model, mode, fixture folder, and prompts for baseline and post-change runs.
- Start each scored scenario in a fresh chat unless the scenario is explicitly testing cwd persistence or cursor continuation.
- Ask the agent to use Bash so the chosen command is visible.
- Bash may print short cursor ids without an `@` prefix in `Next page:` commands; score continuation as correct only when the agent runs the exact printed command.
- If a prompt asks for exactly one continuation, score as incorrect when the agent runs a second continuation from the second page.
- The expected behavior for "one continuation", "exactly one continuation", or "one next page" is to run only the first printed continuation and then stop, even if that page prints another `Next page`.
- App-mount limitations are path-specific. Score as a false claim when the final answer describes a failed app-mount command as a global Bash limitation, or when it tells the user `/tmp` cannot use native-style scratch commands because app files are Convex-backed.
- `/tmp` is durable per chat thread, reloads from Convex after warm runtime cache loss, is not shared with new chats, and is not app project storage. Score as a false claim when the final answer says same-chat `/tmp` must reset after every Bash call, says it is only warm-memory best-effort, says new chats share it, or treats it as user-visible project storage.
- Do not accept answers that call `/tmp` ephemeral or temporary in a way that implies same-chat data loss. In a fresh-chat isolation scenario, `No such file` for a path created in another chat is expected evidence of per-chat isolation, not a global Bash failure.
- The Unix `file` command is intentionally unavailable. Score as correct when the agent avoids `file` or, after `file` fails, runs supported recovery commands such as `stat`, `wc`, `head`, or `cat` on the same `/tmp` path. Score down if it only offers to recover later.
- `set -euo pipefail` is unsupported in this shell. Score down if the agent aborts a path-behavior check on strict-mode boilerplate and does not retry without it.
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
9. For broad Bash behavior or prompt-surface changes, report old-overlap and expanded-matrix scores separately.
10. Accept, revise, or revert based on the scoring rules.
11. If accepted, run the smallest matrix that proves the change and update the ledger. Run the full matrix only for broad Bash behavior or prompt-surface changes.

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

Fixture files used for committed-content `search` scenarios must be committed app content with materialized plain-text chunks. Bash `search` also overlays the current user's unapplied `write_file` / `edit_file` pending updates, so pending-edit scenarios should deliberately leave the proposal unapplied and then verify both Bash exact reads and `search` against the pending token.

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

This is a cloud-backed app environment, so fixture data can drift between attempts. If the uploaded PDF source or readable sibling is missing during verification, treat that as fixture setup drift and repair it before scoring:

1. Confirm the local source asset still exists at `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.
2. Re-upload it through the `/files` UI and place or move it under `<fixture>/uploads/` when the UI supports that flow.
3. If upload conversion is unavailable, create the readable sibling `<fixture>/uploads/r2-upload-sample.pdf.md` manually so the recovery wording can still be evaluated.
4. Rerun the fixture verification commands below before scoring any upload-dependent scenario.

Only leave the unreadable-source scenario unscored after an actual upload or repair attempt fails. Record the exact failure, including whether the local asset was missing, the UI upload failed, the move into the fixture folder failed, or conversion/readable-sibling creation failed.

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
- `find --extension pdf -type f` finds the uploaded source. If it does not, repair or recreate the uploaded source fixture and rerun verification before scoring.

Do not score a scenario that depends on missing fixture data. Do not treat a missing required fixture as a valid eval result until the repair flow above has been attempted and failed.

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

For broad Bash changes, keep two aggregate rows:

- `Old overlap`: the existing core, bad-habit, reliability, and canary scenarios that are comparable to the previous best score.
- `Expanded mixed-path`: the new `/tmp`, app-mount, and mixed-path scenarios below.

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
11. Pending edit search/read:
   `Use edit_file on the app path derived from <fixture>/README.md by removing only the /home/cloud-usr/w/<workspace>/<project> prefix and preserving the full remaining suffix, never collapsing it to /README.md. Replace the exact line "Common token: basheval-common-<runId>." with "Common token: basheval-common-<runId>. pending-token-<runId>" without applying it. Then use Bash search for pending-token-<runId>, Bash head on the same file, and cat <file> | cut to prove the pending version is what Bash reads.`

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

### Expanded Mixed-Path Scenarios

Run these when changing bash implementation, tool description, system prompt, or error hints for `/tmp` or app-mount behavior.

#### `/tmp` Native-Style Scratch

1. Scratch text utilities:
   `Use Bash in /tmp to create a small text file and a JSON file, then run rev, tac, nl, jq, sha256sum, du, diff, rg, and base64 on /tmp data. Summarize only the observed output.`
2. Scratch mutation:
   `Use Bash in /tmp to create a folder, touch a file, copy it, move it, tee into another file, remove one file, and list the final /tmp folder contents.`
3. Scratch persistence:
   `Use Bash to write /tmp/bash-eval-persist-<runId>.txt with a unique token, then run Bash again in the same chat to read it back. Explain what persisted it and whether it is an app project file.`
4. Native option boundary:
   `Use Bash to run du, rg, and native find -mtime on /tmp data. Do not use app files.`
5. Unavailable file command:
   `Use Bash to create /tmp/sample.txt, identify its type with the file command, then recover using supported Bash output without claiming app Convex limits apply to /tmp.`
6. Cache-loss wording:
   `Use Bash to create a /tmp scratch file, then explain whether it survives warm backend runtime cache loss and whether a new chat can see it.`

#### App-Mount Limits

1. Direct native utility app operand:
   `Use Bash to run du on <fixture>. If it fails, explain exactly why and what app-aware command would answer the closest question.`
2. Direct rg app operand:
   `Use Bash to run rg basheval-common-<runId> on <fixture>/README.md. If it fails, recover with the supported app command.`
3. App write rejection:
   `Use Bash to write "hello" directly into <fixture>/tmp-write.md with a redirect. Explain the result and do not use write_file.`
4. App move/delete rejection:
   `Use Bash to move then delete <fixture>/README.md through shell commands. Report only what Bash allowed or rejected.`
5. App-mount wording:
   `Use Bash to run a command that fails because it targets <fixture>. Explain whether the limitation applies to /tmp too.`
6. Scratch symlink escape:
   `Use Bash to try creating a /tmp symlink or path escape that points at <fixture>/README.md, then read it. Report only what Bash allowed or rejected.`

#### Mixed App And `/tmp`

1. App read to scratch:
   `Use Bash to copy <fixture>/README.md to /tmp/readme-copy.md, then run native-style scratch commands on the /tmp copy.`
2. App read through stdin:
   `Use Bash to cat <fixture>/README.md and pipe it into rev and sha256sum.`
3. `/tmp` to app blocked:
   `Use Bash to create /tmp/native-output.md, then try to copy it into <fixture>/native-output.md. Explain the result.`
4. Mixed redirect blocked:
   `Use Bash to tee output to both /tmp/tee-ok.txt and <fixture>/tee-blocked.md, then show whether /tmp/tee-ok.txt exists in the same command.`
5. Script text false positive:
   `Use Bash to cat <fixture>/README.md and pipe it through sed using a script string that contains /home/cloud-usr/w/personal/home as literal replacement text.`
6. Nested shell safety:
   `Use Bash with separate bash -c or sh -c invocations in one outer Bash call to write /tmp/nested-ok.txt and to try writing into <fixture>/nested-blocked.md.`
7. Xargs safety:
   `Use Bash to print <fixture>/README.md as a pathname into xargs cat, then print one token into xargs with sh -c to try writing into <fixture>/xargs-blocked.md. Explain both results.`

#### `/tmp` Cap Eviction

Run these when changing the `/tmp` persistence caps, the eviction/discard stderr wording, or the flush logic. The caps are deliberately small in dev (`BASH_TMP_SESSION_MAX_PATHS` = 10 paths, `BASH_TMP_SESSION_MAX_BYTES` = 4000 total bytes, `BASH_TMP_SESSION_MAX_FILE_BYTES` = 2000 bytes per file in `packages/app/convex/bash.ts`); read the current constants before scoring and size the prompts so they actually overflow. Eviction happens at flush, so the note prints on the call that overflowed and the evicted files are gone on the next call. These scenarios deliberately share one chat across calls, because between-call persistence is the thing under test. Report this block as its own sub-block row when comparing against ledger baselines recorded before it existed (those expanded aggregates were computed over 19 scenarios).

For byte-generation prompts, `/dev/zero` is available as a synthetic Native Just Bash device. Prefer idioms such as `head -c 1700 /dev/zero > /tmp/cap-c-1.txt` over Python, `yes`, or host filesystem paths; the point of these rows is eviction behavior, not discovering a byte source.

1. Path-cap eviction:
   `Use Bash to create eleven small files /tmp/cap-a-01.txt through /tmp/cap-a-11.txt in one call. Then run Bash again to list /tmp and report exactly which files survived and why.`
2. Per-file cap discard:
   `Use Bash to write about 3000 bytes into /tmp/cap-b-big.txt and the word keep into /tmp/cap-b-keep.txt in one call. Then run Bash again to check which of the two files still exists and explain what the first call's output said about it.`
3. Total-byte eviction:
   `Use Bash to write about 1700 bytes into each of /tmp/cap-c-1.txt and /tmp/cap-c-2.txt in one call, then about 1700 bytes into /tmp/cap-c-3.txt in a second call. Then list /tmp in a third call and report which files were kept and what limit caused any eviction.`

Scoring notes for this block:

- The eviction/discard stderr is designed behavior, not a failure: a `3` requires the agent to relay the printed note accurately (which paths were dropped and which cap caused it) and report the surviving files from real `ls` output.
- Score a false claim when the final answer calls `/tmp` broken, ephemeral, or unreliable because of an eviction, or asserts files were lost without quoting the eviction note.

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
- old-overlap average score;
- expanded mixed-path average score.

Use this table for each run:

| Run | Scenario | Prompt | Commands | Score | Cmd Count | DB First | Unsupported | Cursor OK | Scope OK | Tmp Cache Hit | Grounded | False Claim | Notes |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- |

Use this table for aggregates:

| Phase | Avg Score | 3/2/1/0 | Avg Cmds | DB First | Unsupported | False Claims | Cursor OK | Scope OK | Tmp Cache Hit | Grounded |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |

For broad Bash changes, use both rows:

| Matrix | Avg Score | 3/2/1/0 | Avg Cmds | Unsupported | False Claims | Cursor OK | Scope OK | Tmp Cache Hit | Grounded |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Old overlap |  |  |  |  |  |  |  |  |
| Expanded mixed-path |  |  |  |  |  |  |  |  |

## Acceptance

Accept a change only if:

- all deterministic unit tests and prompt assertion tests for the changed surface pass;
- all canaries pass;
- no core scenario scores `0`;
- false-claim rate is `0`;
- cursor correctness is `100%`;
- for broad Bash changes, the old-overlap score is at least the previous accepted best, currently `2.67` unless the ledger records a newer best;
- the expanded mixed-path score is reported separately and improves across iterations or lands at an accepted level with no app-mount safety regression;
- `/tmp` persistence scenarios report hydration, flush, persisted-count, and cache-hit evidence when available, preferably from Bash metadata or Convex logs; deterministic tests must include both a warm same-thread hit and a cold reload from Convex;
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
- include `/tmp` hydration/flush/cache-hit observations for persistence scenarios in the ledger notes.

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
- Single-file `grep [-n] [-i] [-F] PATTERN <file>` scans Markdown chunks with regex matching by default; `-F` / `--fixed-strings` uses literal substring matching.
- For rendered plain-text chunk scans, use `textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>` for one app file, or `textgrep -R PATTERN <folder>` for a recursive folder scan via indexed full-text search (not exact recursive regex/fixed-string grep, like `grep -R`). `textgrep` has no `-n` or context flags.
- `find --extension md -type f` is exact indexed extension search.
- Simple `find -name '*.md'` and `find <dir>/*.md` are recovery syntax for extension search only, not general glob support.
- General glob and regex behavior should stay unsupported unless they map to a DB-backed query.
- Scoped `search --path <folder>` is filtered before pagination, but broad scopes with common terms can still be heavier.
- `ls -t <dir>` is immediate-child recency only.
