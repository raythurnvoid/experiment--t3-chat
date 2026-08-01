# Attack Lenses

The SKILL.md names work lanes for planning and implementation. These are the
lenses for reviewing work that already exists — a finished slice, or the attack
phase of the bar loop — when the job is to make it fail.

## One Lens Each

Narrow critics each see a different failure mode; diversity of angle catches
what redundancy cannot.

- **Correctness** — the input that produces a wrong answer or a crash.
- **Ordering and durability** — for anything transactional: does a refusal ever
  land *after* a write, so the operation reports failure and commits anyway?
- **Security** — authority boundaries, tenant escape, leaks, replay, stale
  access, broad scopes, abuse paths.
- **Over-strictness** — the security lens's mirror, and the one people forget.
  Does a check refuse an action that would have granted nothing? A false denial
  is a real bug; it just arrives as "the app is broken" rather than "the app is
  unsafe".
- **Reach** — for data protection: every door, not just the obvious one. The
  API, search, logs, caches, exports, chat transcripts, scratch files, presence.
  The file layer is usually the door people harden and rarely the one that leaks.
- **Comment truth** — does any comment claim behaviour the code does not have?
  Worse than a missing comment, because the next reader trusts it.
- **Performance** — what is quadratic, what runs per render, what refetches.
  Measure before asserting a number; use the repo's profiling skill when it
  has one.
- **Accessibility** — keyboard path, focus order, contrast, accessible names,
  what a screen reader actually announces.
- **Uniformity** — does this read as though the author of the surrounding
  file wrote it? Check placement, names, comments, spacing, and test grouping
  against the nearest similar code, and load the repo's own uniformity skill
  when it has one.
- **UX states** — empty, loading, error, one item, ten thousand items, slow
  network, navigation mid-action.
- **Test quality** — hunt the proof gaps in your own new tests: refusal tests
  with no positive control, asserting the return but not the side effect, tests
  that pass with the code deleted.

Pick the lenses the work actually has surface for. Running all eleven on a CSS
change wastes a round.
