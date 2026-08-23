---
name: adversarial-review-loop
description: How to run a multi-round, multi-reviewer adversarial review loop over a large feature with subagents. Use when the user asks for a deep review loop, an exhaustive audit with fixes, or a "review until clean" pass over a feature area. Covers reviewer briefing, triage, red-first fix proofs, mutant checks, gates, the ledger, and the stop condition. Findings must be user-reachable: a defect only a test harness can produce is test debt, not a product finding. Distilled from the 18-round Council review loop (evidence trail in t3-chat-+personal/+ai/council-production-room-2026-08-22/loop-review-log.md).
---

# Adversarial Review Loop

One master agent runs rounds of: review (N independent reviewer subagents) → triage (master verifies every
claim) → fix (fixer subagents with disjoint file ownership) → re-verify (gates) → loop. The loop ends only
when a round comes back clean, or when every remaining report is individually adjudicated with written
evidence.

## Roles and round shape

- **Master** owns the ledger, the briefs, all triage verdicts, gate runs, server lifecycle, and the final
  report. The master never trusts a reviewer or fixer claim without checking it against the code.
- **Reviewers** (six lenses worked well: product/UI/accessibility; browser/media/lifecycle;
  backend/security/concurrency; plugin/SDK/build/release; pipeline/migrations/tests/recovery; code
  uniformity and prose truth) are read-only in the shared tree. Probes and mutants go in a package copy
  under the personal `+ai` folder, never the tree.
- **Fixers** get explicit, disjoint file ownership per worker. Two fixers never share a file. If a fix
  seems to need a file another worker owns, the fixer reports instead of editing.
- A reviewer with nothing to report returns exactly `NO ACTIONABLE ISSUES` plus an honest boundary
  statement (what it did not read). A clean verdict over an unread surface is not a clean surface — the
  boundary statement is what makes recovery possible when a later round reads that surface.

## Briefing rules

- Write one shared preamble (constraints, output format, verified tree facts, baselines, traps) and one
  private lens block per reviewer. No reviewer sees another's block.
- Give reviewers **verified facts, not findings**: describe what changed in the tree as facts to verify,
  never as a findings list. Prior-round findings poison independence; known-wrong premises become false
  positives.
- Point every lens at the user. Brief reviewers that a finding must name harm a real member can reach
  through a supported flow — a route, a click, a webhook, a cron — and must lead with the user-visible
  consequence: what a member sees, loses, or can do that they should not. Rank findings by that
  consequence, not by how interesting the code path is.
- Carry an **adjudicated-closed list** ("do not re-file without new evidence") so settled questions do not
  burn reviewer time every round. After a fix phase, list the fixes as adjudicated with the re-file bar
  "only if the FIX itself is wrong, with evidence about the fix".
- Refresh baselines every round (file/test counts, served markers) and mark them dispatch-time values — a
  count is only a baseline if the run that produced it exited 0.

## Triage discipline

- The master re-verifies every finding against the code before accepting it: open the cited lines, check
  the producer path is real, and say plainly when a report is wrong. "The schema allows it" is not a
  finding; every claim needs a concrete route, mutation, cron, workflow, or user action.
- Reachability decides whether it is a finding at all. A defect that only shows under harness
  conditions — a fixture value no real producer can emit, an interleaving no browser or worker can
  schedule, a jsdom/happy-dom behavior gap — is test debt at most, never a product finding, and never
  blocks closing. The loop exists to protect users, not to make the test suite feel complete. Before
  accepting, the master answers one question in the ledger: "which user, doing what, hits this?" — and
  rejects the report when the honest answer is "only a unit test".
- Record every report in the ledger with a verdict: accepted (P0–P3), rejected-with-evidence, or duplicate.
- Independent convergence (two reviewers finding the same defect) is strong signal; count it once.

## Fix discipline

- **Red-first, at a named assertion.** Before running, the fixer names the exact assertion and line it
  expects to fail. Run the new test against the unfixed code; the red run counts only if THAT assertion
  failed with the predicted message. A red run from a fixture error or a different assertion proved
  nothing. Then fix and watch green.
- **Mutants for guard-shaped fixes.** Flip the guard in a scratch copy (never the shared tree) and confirm
  the named test is the sole killer. Calibrate the instrument: one known-fatal mutant must be KILLED and
  one known-inert must SURVIVE at the exact baseline.
- Comment-only fixes get no invented red-first proof — say plainly that no gate reads prose, and prove
  comment-only-ness with a git diff whose changed lines are all comment lines.
- Fixers take their own per-file test counts before and after, and reconcile only their own delta —
  sibling fixers grow the suite concurrently, so a shared total is not attributable.

## Verification traps (each cost a round somewhere)

- Never read a gate's exit code through a pipe: `cmd > file 2>&1; echo "EXIT: $?"` in one shell call, then
  read the tool's own summary line too — a tool can print failure and still exit 0.
- A wrong targeted-vitest path prints `No test files found, exiting with code 0` — read the reported file
  and test counts, never the exit code alone.
- Fixture-class check on every test that "proves" a branch: can the producer actually emit the fixture's
  value, and can the runtime actually produce the asserted behavior? The worst shape is an environment
  that cannot reproduce the behavior (jsdom/happy-dom focus and blur, for example) — the test then pins
  the runner, not the product. Such tests must carry an honest comment naming the boundary.
- An assertion added to an existing test changes no count; only a new `test(...)` does.
- Do not carry a verified finding's shape to its twin; re-measure at every site.
- Do not run `pnpm --dir <copy>` against a scratch copy (implicit install breaks); invoke the real tree's
  vitest with `--config <copy>/vitest.config.mjs`.
- Prose is ungated: no gate in this repository reads comments or Markdown. A dedicated prose-truth lens
  ("does this comment describe the code beside it?") caught real product-rule drift every round it ran.

## The ledger

Append-only Markdown file in the task's personal `+ai` folder. Every dispatch, report, triage verdict,
fix, gate run, adjudication, and teardown gets an append. The ledger is what makes an honest close
possible: the stop condition demands written evidence per report, and the ledger is that evidence.

## Stop condition and closing

Stop only when a full round returns `NO ACTIONABLE ISSUES` from every reviewer, **or** every remaining
report is individually adjudicated — noise, duplicate, already fixed, out of scope by explicit user
decision, or an external release gap — each with written evidence in the ledger, **in the current
session**. Handing findings to a future session is not adjudication by itself; record the user's scope
decision per finding, in a table, with the user's directive quoted.

User-decision boundaries learned the hard way: do not start fixers without the user's go-ahead when they
have asked to control scope; a fix phase always triggers one more verification round, so tell the user the
real cost of "fix them" versus "descope and close". Never hide unresolved findings in a summary — descoped
items are listed in the final report with their severity and consequence.

The final report states exact test counts per gate, everything that could not be verified (and why),
every descoped item, and a verdict: CLEAN, CLEAN WITH DOCUMENTED EXTERNAL GAPS, or NOT CLEAN.
