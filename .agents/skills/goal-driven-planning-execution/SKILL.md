---
name: goal-driven-planning-execution
description: Goal-driven research, planning, and implementation workflow for complex repo work. Use when a user asks for a robust plan, implementation plan, end-to-end execution workflow, subagent organization or fan-out ("fan out subagents"), multi-pass verification, uniformity or code-style review passes inside a larger implementation, or explicit goal-setting before planning or coding. Also use when the request attaches a quality bar instead of a spec — "make it perfect", "AAA quality", "production quality", "make it beautiful", "loop until", "don't stop until", "keep going until it's great" — which switches on the skill's iterate-to-a-bar loop. Not for small single-file edits with a clear spec.
---

# Separate Planning From Implementation

Treat planning and implementation as separate workflows. Give each workflow its own plan, subagent organization, verification criteria, and final audit.

Use the goal tool only when the user explicitly asks you to set a goal; a request for a plan, review, or complex implementation does not by itself authorize goal creation. When no goal was requested, track the work with the normal plan tool instead. When a goal is requested, inspect the current goal first:

- an unfinished goal covers the same task: continue it;
- no unfinished goal exists: create one;
- an unrelated goal is unfinished: stop and report the conflict instead of replacing it.

The goal tool is Codex's goals feature. In a harness without one, say so and use the plan tool under these same rules — and lacking any tracking tool, a plain written checklist. Leftover plan items are ordinary tracking, replaceable as usual; plan items standing in for a goal you were asked to set are not — the conflict rule above still covers them.

# Planning Workflow

Start by defining a detailed planning objective. If the user explicitly requested a goal, apply the goal rules above before creating a planning goal. Include:

- what must be researched;
- which local code, skills, docs, and reference repos must be inspected;
- which external docs or repos should be fetched if local references are insufficient;
- which architecture questions must be resolved;
- what makes the plan complete enough for another agent to execute;
- where scratch artifacts or the final plan should be saved.

Do not write a substantial plan from memory. Trace the current system first, then research adjacent implementations.

State the objective as claims that can come back false. "Performance is good" and "the UI is beautiful" cannot fail, so work against them never terminates and nobody notices. "10k tree nodes scroll at 60fps on this machine" and "a non-member gets a refusal and no doc is written" can be checked and found wanting.

When the user gives a bar rather than a spec, convert everything you can into falsifiable claims; the residue that stays a judgement becomes a blind comparison against a reference fixed at kickoff. `references/blind-comparison.md` has the protocol, including the visual case.

Use subagents during planning when the design is broad or security-sensitive — that phrase is the test, and the usual triggers are: it touches auth, tenancy, billing, or deletion; crosses more than one layer (schema, backend, UI); changes shared modules other features import; or handles untrusted input (a parser of arbitrary input counts, even in a library whose current callers are internal). The same rubric decides "high-risk" everywhere below; "blast radius" is a separate measure — how much surface the change touches. In a harness without subagents, run the lanes yourself, sequentially — this fallback applies to every lane, reviewer, and attack round in this skill, except the blind-comparison critic, which has its own fallback. Prefer disjoint lanes:

- **Research lane:** local references first, then official docs or public repos if local material is insufficient. Report concrete patterns, not generic advice.
- **Current-system lane:** trace the existing code path end to end and name exact files, symbols, payload shapes, and invariants.
- **Security/threat-model lane:** challenge authority boundaries, leaks, replay, stale access, tenant escape, logging, broad scopes, and abuse paths.
- **Codebase-fit lane:** check local backend/frontend/test/style patterns so the plan lands in the repo's dialect.
- **QA lane:** identify verification surfaces before implementation begins. For UI work, include the user flow, visible states, responsive behavior, keyboard and focus behavior, accessible names and errors, and the running-app checks needed to verify them.

For high-risk plans, do at least one challenge loop:

1. Draft the architecture outline.
2. Ask subagents to critique gaps and edge cases.
3. Revise the plan.
4. Ask for a second critique pass.
5. Write the final plan with accepted findings, rejected findings, remaining uncertainty, and verification steps.

The final plan should include, when applicable:

- feature summary;
- product goal;
- UI/UX behavior and accessibility expectations;
- current-system context with code references;
- reference modules and why they matter;
- persistent docs and API shape;
- implementation steps by file/module;
- security/privacy model;
- migration and rollback;
- validation plan;
- execution workflow;
- open questions and assumptions.

# Implementation Workflow

Before coding, finish the planning workflow. A goal requested for the whole task covers both phases; create a separate implementation goal only when the user explicitly asked for one, completing the planning goal first. When no goal was requested, track implementation with a new plan. The implementation objective should name:

- implementation milestones;
- expected files/modules to modify;
- subagent lanes for implementation and review;
- focused test commands;
- lint/typecheck expectations;
- running-app checks when the repo has a runnable app and the change reaches it;
- docs/skills/spec updates;
- uniformity passes;
- completion criteria.

When you create the implementation plan or todo list, copy closing steps 6–10 below into it as literal items, including what the final report must contain. Remembered obligations do not survive context compaction; todo items do.

Execute iteratively:

1. Implement the smallest coherent slice.
2. Run focused verification for that slice.
3. Fix failures before broadening scope.
4. Use subagents to review the slice when the surface is broad or security-sensitive.
5. Repeat for the next slice.
6. Run broader scoped lint/typecheck/tests after all slices pass, per the verification standard below.
7. Verify in the running app when the repo has one and the change reaches it, per the verification standard's running-app and deployment rules below. Not only for UI work: backend changes the app can reach deserve the same check. When nothing runnable exists or the change does not reach the app, skip this step and say so.
8. Run the uniformity pass below, including its vocabulary audit on broad or multi-file diffs.
9. Re-read the final diff.
10. Report what changed, what passed, what was not verified, docs updated, and security/accessibility considerations. The report must also settle every open question the plan listed: each one resolved, or deferred with a reason — an open question nobody noticed surviving to the end is a report defect.

For work that uses review lanes or spans more than a couple of slices, create `execution-log.md` in the task's scratch folder at kickoff and append one line at each boundary the loop already has: a slice verified, a finding kept or dropped with the reason, a break-on-purpose proof run. The log is not a diary; it is the state a resumed or compacted session needs to continue without re-deriving decisions.

Recommended implementation subagent lanes:

- **Domain implementation:** schema, backend, runtime, frontend, or migration slices.
- **Security review:** the planning lane's threat surface checked in the diff, plus token/key handling, revocation, and secret exposure.
- **Test/QA review:** missing positive/negative cases, focused commands, whether broad suites are justified, and running-app checks when the change reaches a running app.
- **Uniformity review:** placement and test ownership; comments, logs, and docs wording; names and whole-diff vocabulary — split into one auditor each when the diff is broad.
- **Over-strictness review:** the mirror of the security lane — does a check refuse an action that would have granted nothing?

Give each reviewer one lens and nothing else. A generalist stops at the first thing it notices and never reaches the fourth. `references/attack-lenses.md` is the lens catalog for reviewing existing work — slice reviews here, and attack rounds in the bar loop below.

Do not accept subagent output just because it is confident. Read its diff or findings, keep only changes that match local evidence, and reject taste-only churn.

Concretely: open the cited `file:line` before you act on a finding or repeat it to the user. Subagents misread code, read files while another agent is mid-edit, and sometimes produce whole reviews of code that does not exist, with plausible line numbers attached. When the file does not say what the report says, drop the finding and say you dropped it. Require every finding to carry a citation and a concrete path — which caller, which input, which entry point, in what order — because an uncited finding cannot be checked, and unchecked findings reach the user as fact. Ask each reviewer to state its confidence and what it did not check.

Give writing subagents disjoint file ownership, or their own worktree. When they share a tree, one agent's half-finished experiment gets read by another as if it were the real code.

Reviewers need the mirror-image protection: pin the diff before spawning review lanes (a commit, `git stash create`, or a worktree) and name that revision in each reviewer prompt. Otherwise they read files you are still editing, and their citations go stale before you can check them.

# Verification Standard

Verification should match risk and blast radius.

- For backend business logic: focused unit tests first, then broader tests when shared behavior changed.
- For schema, route, or deployment-adjacent changes: commands that push, deploy, or regenerate files change shared state, so do not run them as read-only analysis. Push or deploy only when the task requires that check and it is authorized: when the repo deploys through a dev watcher, the running watcher already covers the working tree; an explicit request to implement the change authorizes the configured dev target; shared or production targets always require asking. Follow the repo's own deployment skill or docs for the exact command when it has one. Whenever any check, at any point in any loop, needs a push that is not authorized: ask once, and if the run must continue without an answer, skip the check and say so.
- For tooling or infrastructure packages: focused tests first, then package-scoped typecheck and tests when the change's blast radius justifies them.
- For anything a running app can reach, UI or backend: verify in the app itself, not only in tests — exercise it through its native interface (browser for web apps, HTTP for services, the command line for CLIs), prefer the user's existing session where one exists, and assert observable output (for web apps, DOM state over screenshots) plus, when the change persists anything, persisted state (stored-data readback). Use the repo's QA or browser-automation skill when it has one; without a runnable app, this bullet does not apply.
- Prove every fix by breaking it on purpose first. A check that still passes with the fix removed did not test the fix. This applies to tests and to running-app checks. Read *how* it fails, not only that it failed: a test that goes red on a fixture error instead of your assertion was never exercising the code. `references/proof-gaps.md` expands this rule and adds the rest: positive controls, asserting the side effect and not just the return value, and the ways a test passes without testing anything.
- For broad changes: decide which broader scoped checks are justified by the affected surface. Always use focused checks first. Run checks broader than the affected surface only when the user explicitly requested broad verification; a package suite over a surface that spans the whole package is within the surface, not beyond it. On broad or multi-file diffs in a git repo, run `git diff --check`; the vocabulary audit belongs to implementation step 8.

Always say which checks ran and which were intentionally skipped.

# Uniformity Pass

Make the change look like the same engineer wrote it, in this codebase, on the same day. Local fit is the bar, not generic cleanliness: a slightly less elegant implementation that matches the module beats a cleaner one that introduces a new dialect, because the dialect is what every later reader has to learn. When the repo ships its own uniformity skill, load it and follow it instead of this section — this section is the general case for repos without one. Implementation step 8's vocabulary audit runs either way; use the repo skill's version when it has one.

Derive the style from evidence, not memory:

1. Read the diff, then the target file around the changed area.
2. Read at least two nearby implementations that already solve a similar problem.
3. State the local pattern concretely — where code lives, what names look like, how much abstraction is normal, how errors travel, how tests are grouped, what stays inline — then edit to that.
4. Split the lens when the diff is broad: placement first, comments second, names third. One pass looking for everything finds the first thing only.
5. Re-read the final diff as a style review rather than a correctness review, and drop the changes that are only your taste.

What to check:

- **Placement** — new code sits beside the nearest similar helper, query, hook, component, or test, and helpers are defined before their callers when the file already does that.
- **Names** — follow local naming. Add a file or domain prefix only when the symbol is exported and needs context at the import site.
- **Granularity** — one-off logic stays inline unless a helper removes real duplication or hides an external-system detail. Do not add an abstraction the file would not add.
- **Existing dependencies** — before hand-rolling diffing, parsing, or formatting, check the manifest and nearby usage for something the repo already depends on.
- **Types** — keep one-off shapes inline unless the type is exported, reused, recursive, mirrors an external API, or names a real domain concept.
- **Errors** — match the local boundary: the same return-or-throw shape the surrounding code uses.
- **Comments** — only for non-obvious intent, gotchas, and external-system behavior, never narration of the code below. Use the concrete nouns the code uses. Put a comment about a branch or loop above it, so it stays visible when the block is folded.
- **Sections and spacing** — preserve existing regions or ordered sections and never nest them; one blank line between logical chunks, not after every statement.
- **Tests** — the same grouping and naming rhythm the file already uses; prove public behavior rather than private helpers.
- **Docs** — update durable docs only when behavior, architecture, or an agent-facing workflow actually changed.

Vocabulary is part of uniformity, and the vocabulary audit is its named check: on a broad or multi-file diff, search the diff for the terms it introduced — abstract nouns like `data`, `state`, `handler`, `manager`, and `thing` are the usual offenders — and replace each with the concrete thing involved. Do not invent an umbrella term when listing the real nouns is clearer. If the user pushes back on one word, sweep the whole diff instead of fixing that word alone.

Before calling the pass done: would any of this look surprising to someone reading the surrounding file for the first time?

# Iterating To A Bar

The workflow above runs once and ends at a checklist. That is right when the user gave a spec. When they gave a bar — "as good as Linear's", "AAA quality", "don't stop until" — one pass cannot decide whether you reached it, because the thing that decides is an attacker, not a checklist.

In that case, wrap the implementation workflow in rounds. First convert the bar as in the planning workflow — falsifiable claims, plus a fixed reference for judgement residue when the blind-comparison protocol calls for one — even when the bar arrives with the implement message after planning finished in spec mode. Each round:

1. Build, as above: run the implementation loop (its steps 1–3 and 5 — the attack below covers the review) to a coherent checkpoint — one slice or a few related ones. That loop's closing steps 6–10 wait until this bar loop ends — by converging or by stopping early; the closing-out rules after the stop condition say how to run them.
2. Prove it, per the verification standard — including its running-app checks for the surface this checkpoint touched; implementation step 7's full QA pass runs at the end, not per checkpoint.
3. Attack it: reviewers in parallel, one lens each, every finding cited. This attack replaces implementation step 4's slice review for the checkpoint — run one review pass, not two.
4. Mark each objective met or not — falsifiable claims by their checks, judgement residue by the blind comparison — naming the evidence that settled it. An objective with no recorded evidence is not met, and evidence goes stale when later work changes the surface it covered — re-run it.
5. Feed what survived into the next round.

Optimize only once correctness holds, and only against a measurement. Say the number before and after; use the repo's profiling skill or tooling when it has one.

Stop when every objective is met with recorded evidence **and** the final state has survived two consecutive quiet attack rounds — the round that built it plus at least one attack-only round, or two attack-only rounds; one quiet round can be luck. An attack-only round has no build step: it re-runs the lenses that still have surface against the work as it stands. A finding rejected with reasons — in this round or an earlier one — does not count as new, and neither does a finding already reported as an unmet objective.

**Closing out.** When the loop ends — the stop condition holds, or the early stop below fires — run the implementation loop's closing steps 6–10 once, then apply these rules until nothing changes:

- If a closing step finds a failure, fix it.
- If a closing step, a fix, or a reopened build round changes the work, re-run the evidence that covered what changed — the blind comparison included when the judged surface changed. Handle re-runs as each change lands or batched after the remaining closing steps.
- If the change came from a closing step or a fix, also run attack-only rounds on the changed state until two in a row are quiet; a reopened loop answers to the stop condition instead. The two-quiet requirement applies to the final state either way.
- If a re-run of evidence comes back failed, an objective you counted as met no longer is: the loop reopens — return to build rounds until your exit holds again (the stop condition, or an accurate early-stop report), then finish the remaining closing steps.
- Re-run a closing step that already ran only if its surface changed.

Stop early, and say so, when rounds stop producing progress — the same findings returning, or only cosmetic ones. A converged loop that keeps running burns the user's money for nothing. Report which objectives are met, name the ones that are not, and say why; an accurate partial result is worth more than a complete-sounding wrong one.

# Planning And Execution Prompt Pattern

When writing a reusable prompt for another agent, restate both phases separately: a planning phase — planning objective, the goal rules above when the user requested goal tracking, research/current-system/security/codebase-fit/QA lanes and challenge loops when the risk rubric above calls for them — and an implementation phase — a separate plan, implementation/security/QA/uniformity/over-strictness lanes, slices with focused tests, risk-based verification, final diff review. The distinction matters: planning subagents reduce architectural blind spots; execution subagents catch implementation bugs, style drift, missing tests, and QA gaps.

# Final Checklist

Before calling a complex task complete:

- The requested outcome is actually achieved, not just partially explored.
- The plan or implementation is saved in the requested durable location when asked.
- Research sources and code references are concrete.
- Subagent challenge/review findings were considered explicitly.
- Focused verification is complete, broader checks matched the verification standard, and skipped checks are clearly explained.
- Durable skills/spec docs were updated if behavior or canonical workflow changed.
- When iterating to a bar: the stop condition was met, or the report names the unmet objectives and why.
