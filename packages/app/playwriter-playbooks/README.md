# Playwriter Playbooks

This folder contains manual-but-repeatable QA playbooks for live environments where stable seeded data is not guaranteed.

Use these playbooks when `@playwright/test` e2e would be too brittle due to changing production-like data.

## How to use

1. Open the target app tab (or let Playwriter open a new one).
2. Run each snippet step-by-step with Playwriter.
3. Record pass/fail and notes.
4. Clean up artifacts (for example resolve test threads) when requested by the playbook.

## Conventions

- Use dynamic run IDs in comment/page names.
- Prefer visible labels first, then DOM-click fallback for flaky actionability.
- Re-open comment threads after refresh before asserting missing replies.
- Keep snippets small and debuggable; avoid one huge script.

## Playbooks

- `comment-thread-persistence.md` - create comment + reply, refresh, verify persistence.
- `pages-sidebar-smoke.md` - basic sidebar interaction sanity for `/pages`.
