---
name: goal-driven-planning-execution
description: Goal-driven research, planning, and implementation workflow for complex repo work. Use when a user asks for a robust plan, implementation plan, end-to-end execution workflow, subagent organization, multi-pass verification, code-uniformity review, or explicit goal-setting before planning or coding.
---

# Goal-Driven Planning And Execution

Use this skill for work that must not be handled as a quick patch: architecture, public APIs, auth/security boundaries, multi-layer backend/frontend changes, tool/runtime changes, migrations, browser QA, or any task where the user asks for goals, subagents, deep research, a detailed plan, or high-confidence implementation.

The core rule: treat planning and implementation as separate workflows. Each workflow gets its own explicit goal, subagent organization, verification criteria, and final audit.

# Planning Workflow

Start by setting a detailed planning goal. Include:

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
- **QA lane:** identify verification surfaces before implementation begins.

For high-risk plans, do at least one challenge loop:

1. Draft the architecture outline.
2. Ask subagents to critique gaps and edge cases.
3. Revise the plan.
4. Ask for a second critique pass.
5. Write the final plan with accepted findings, rejected findings, remaining uncertainty, and verification steps.

The final plan should include, when applicable:

- feature summary;
- product goal;
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

Before coding, set a separate implementation goal. This goal should name:

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
6. Run broader lint/typecheck/tests after all slices pass.
7. Run Playwriter/browser QA for UI or live app behavior.
8. Run code-uniformity and vocabulary audit.
9. Re-read the final diff.
10. Report what changed, what passed, what was not verified, docs updated, and security/accessibility considerations.

Recommended implementation subagent lanes:

- **Domain implementation:** schema, backend, runtime, frontend, or migration slices.
- **Security review:** token/key handling, tenant isolation, scopes, revocation, logs, replay, and secret exposure.
- **Test/QA review:** missing positive/negative cases, focused commands, full-suite need, and browser checks.
- **Code-uniformity review:** organization, naming, comments/docs, tests/fixtures, and whole-diff vocabulary.

Do not accept subagent output just because it is confident. Read its diff or findings, keep only changes that match local evidence, and reject taste-only churn.

# Verification Standard

Verification should match risk and blast radius.

- For backend business logic: focused unit tests first, then broader tests when shared behavior changed.
- For Convex schema/routes/actions: Convex-focused tests plus `convex dev --once` analysis when schema/functions changed.
- For runtime/tooling Workers: package typecheck and package tests.
- For UI/live app behavior: Playwriter with the correct user profile, plus DOM attributes or persisted-doc readback when relevant.
- For broad changes: full app lint/typecheck, full tests if practical, `git diff --check`, and vocabulary audit.

Always say which checks ran and which were intentionally skipped.

# Planning And Execution Prompt Pattern

When creating a reusable prompt for another agent, include two distinct requirements:

- **Planning phase:** "Set a detailed planning goal before research. Use subagents for research, current-system tracing, security challenge, codebase-fit review, and QA planning. Do challenge loops before finalizing the plan."
- **Implementation phase:** "When executing the plan, set a separate implementation goal. Use implementation, security, QA, and code-uniformity subagents. Implement in slices with focused tests after each slice, then broad verification and final diff review."

This distinction matters. Planning subagents reduce architectural blind spots; execution subagents catch implementation bugs, style drift, missing tests, and QA gaps.

# Final Checklist

Before calling a complex task complete:

- The goal is actually satisfied, not just partially explored.
- The plan or implementation is saved in the requested durable location when asked.
- Research sources and code references are concrete.
- Subagent challenge/review findings were considered explicitly.
- Focused and broad verification are complete or clearly explained.
- Durable skills/spec docs were updated if behavior or canonical workflow changed.
- Git index was not changed unless explicitly requested.
