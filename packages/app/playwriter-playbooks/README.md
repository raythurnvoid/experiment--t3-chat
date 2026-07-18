# Playwriter Playbooks

This folder contains manual-but-repeatable QA playbooks for live environments where stable seeded data is not guaranteed.

Use these playbooks when `@playwright/test` e2e would be too brittle due to changing production-like data.

## How to use

1. Load `.agents/skills/app-playwriter-harness/SKILL.md` and its routed references.
2. Open the target app tab or let Playwriter open a new one.
3. Run every Playwriter command through `vp env exec pnpx playwriter` from the repository root.
4. Run each snippet step-by-step with Playwriter.
5. Record pass/fail and notes.
6. Clean up artifacts (for example resolve test threads) when requested by the playbook.

## Conventions

- Use dynamic run IDs in comment/file names.
- Prefer accessible locators and normal clicks. If actionability fails, inspect and hit-test the blocker; do not bypass it with forced or DOM clicks.
- Re-open comment threads after refresh before asserting missing replies.
- Keep snippets small and debuggable; avoid one huge script.
- Write runners and output under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/`, never in the repository or OS temp directory.

## Playbooks

- `r2-file-content-regression.md` - deep R2-backed files, uploads, comments, and agent regression QA.

The other Markdown files in this folder are historical recipes. Their routes, selectors, and command wrappers have not been revalidated against the current harness. Use them only as research until a focused task updates and verifies them.
