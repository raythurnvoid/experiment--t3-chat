---
name: goal-driven-planning-execution
description: Goal-driven research, planning, and implementation workflow for complex repo work. Use when a user asks for a robust plan, implementation plan, end-to-end execution workflow, subagent organization, multi-pass verification, code-uniformity review, or explicit goal-setting before planning or coding.
---

# Separate Planning From Implementation

Treat planning and implementation as separate workflows. Give each workflow its own plan, subagent organization, verification criteria, and final audit.

Use the goal tool only when the user explicitly asks you to set a goal. A request for a plan, review, or complex implementation does not by itself authorize goal creation. When a goal is requested, inspect the current goal first. Continue an unfinished goal for the same task; do not replace an unrelated unfinished goal. When no goal was requested, track the work with the normal plan tool instead.

# Planning Workflow

Start by defining a detailed planning objective. If the user explicitly requested a goal, inspect the current goal first. Continue it when it covers the same task. Create the planning goal only when no unfinished goal exists at all. If an unrelated goal is unfinished, stop and report that conflict instead of trying to replace it. Include:

- what must be researched;
- which local code, skills, docs, and reference repos must be inspected;
- which external docs or repos should be fetched if local references are insufficient;
- which architecture questions must be resolved;
- what makes the plan complete enough for another agent to execute;
- where scratch artifacts or the final plan should be saved.

Do not write a substantial plan from memory. Trace the current system first, then research adjacent implementations.

Use subagents during planning when the design is broad or security-sensitive. Prefer disjoint lanes:

- **Research lane:** local references first, then official docs or public repos if local material is insufficient. Report concrete patterns, not generic advice.
- **Current-system lane:** trace the existing code path end to end and name exact files, symbols, payload shapes, and invariants.
- **Security/threat-model lane:** challenge authority boundaries, leaks, replay, stale access, tenant escape, logging, broad scopes, and abuse paths.
- **Codebase-fit lane:** check local Convex/server/frontend/test/style patterns so the plan lands in the repo's dialect.
- **QA lane:** identify verification surfaces before implementation begins. For UI work, include the user flow, visible states, responsive behavior, keyboard and focus behavior, accessible names and errors, and the browser checks needed to verify them.

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

Before coding, finish the planning workflow. If the user separately authorized implementation and explicitly requested goal tracking for it, complete the planning goal before creating a separate implementation goal. Otherwise, start a new implementation plan without creating a goal. The implementation objective should name:

- implementation milestones;
- expected files/modules to modify;
- subagent lanes for implementation and review;
- focused test commands;
- lint/typecheck expectations;
- browser/Playwriter checks when UI or live app behavior is touched;
- docs/skills/spec updates;
- code-uniformity passes;
- completion criteria.

Execute iteratively:

1. Implement the smallest coherent slice.
2. Run focused verification for that slice.
3. Fix failures before broadening scope.
4. Use subagents to review the slice when the surface is broad or security-sensitive.
5. Repeat for the next slice.
6. Run broader scoped lint/typecheck/tests after all slices pass when the change's risk or blast radius justifies them. Run full suites only when the user explicitly requested broad verification.
7. Run Playwriter/browser QA for UI or live app behavior.
8. Run code-uniformity and vocabulary audit.
9. Re-read the final diff.
10. Report what changed, what passed, what was not verified, docs updated, and security/accessibility considerations.

Recommended implementation subagent lanes:

- **Domain implementation:** schema, backend, runtime, frontend, or migration slices.
- **Security review:** token/key handling, tenant isolation, scopes, revocation, logs, replay, and secret exposure.
- **Test/QA review:** missing positive/negative cases, focused commands, whether broad suites are justified, and browser checks.
- **Code-uniformity review:** organization, naming, comments/docs, tests/fixtures, and whole-diff vocabulary.

Do not accept subagent output just because it is confident. Read its diff or findings, keep only changes that match local evidence, and reject taste-only churn.

# Verification Standard

Verification should match risk and blast radius.

- For backend business logic: focused unit tests first, then broader tests when shared behavior changed.
- For Convex schema/routes/actions: run focused Convex tests first. `convex dev --once` changes deployment state and can regenerate files, so do not use it as a read-only analysis command. Load the Convex admin operations skill and run `vp env exec pnpm --dir packages/app exec convex dev --once` only when the task requires that deployment check and the user has authorized the state change.
- For runtime/tooling Workers: package typecheck and package tests.
- For UI/live app behavior: load the Playwriter and app harness skills, attach to the user's exact existing browser session/tab, and use DOM attributes or persisted-doc readback when relevant.
- For broad changes: decide which broader scoped checks are justified by the affected surface. Always use focused checks first, and run full app lint or full tests only when the user explicitly requested broad verification. Run `git diff --check` and the vocabulary audit when they apply.

Always say which checks ran and which were intentionally skipped.

# Planning And Execution Prompt Pattern

When creating a reusable prompt for another agent, include two distinct requirements. Mention goal creation only when the user explicitly requested it:

- **Planning phase:** "Define a detailed planning objective before research. If the user explicitly requested goal tracking, inspect the current goal first. Continue it when it covers the same task. Create a planning goal only when no unfinished goal exists at all. Stop and report an unrelated unfinished goal instead of replacing it. Use subagents for research, current-system tracing, security challenge, codebase-fit review, and QA planning. Do challenge loops before finalizing the plan."
- **Implementation phase:** "When executing the plan, use a separate implementation plan. If the user explicitly requested a separate implementation goal, complete the planning goal before creating it. Use implementation, security, QA, and code-uniformity subagents. Implement in slices with focused tests after each slice, then risk-based verification and final diff review."

This distinction matters. Planning subagents reduce architectural blind spots; execution subagents catch implementation bugs, style drift, missing tests, and QA gaps.

# Final Checklist

Before calling a complex task complete:

- The goal is actually satisfied, not just partially explored.
- The plan or implementation is saved in the requested durable location when asked.
- Research sources and code references are concrete.
- Subagent challenge/review findings were considered explicitly.
- Focused verification is complete. Broader scoped verification was run when justified, full suites ran only when explicitly requested, and skipped checks are clearly explained.
- Durable skills/spec docs were updated if behavior or canonical workflow changed.
- Git index was not changed unless explicitly requested.
