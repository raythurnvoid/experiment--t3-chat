# Iterating To A Bar

Use this when the user gives an open-ended bar such as "as good as Linear's", "AAA quality", or "don't stop until". Follow the planning and implementation workflows in [SKILL.md](../SKILL.md), with the changes below.

Convert the bar into claims that can fail. For any quality that still needs judgement, fix a reference at kickoff and use the [blind-comparison protocol](blind-comparison.md). A generic word such as "great" alone does not require a blind comparison.

Before starting the loop, tell the user that its round count is not fixed. After every loud round, give a short checkpoint: what changed, whether the architecture is still moving, what the next round will check, and that the user may stop with the current evidence-backed result. This is a progress update, not a request for permission. If the user asks to stop, report which exit conditions remain unmet.

Wrap implementation in rounds, even when the bar arrives after planning finished in spec mode. Each round:

1. Build a coherent checkpoint with implementation steps 1–3 and 5 from `SKILL.md`. Its closing steps 6–10 wait until this loop ends. The attack below replaces step 4.
2. Prove the checkpoint under the verification standard, including running-app checks for what it touched. The full QA pass in implementation step 7 runs at the end.
3. Attack it with reviewers in parallel, one lens each and every finding cited. Run one review pass for the checkpoint.
4. Mark each objective met or unmet from evidence. Re-run evidence when later work changes the surface it covered. Use blind comparison for judgement that remains after falsifiable claims.
5. Feed accepted findings into the next round.

Optimize only after correctness holds and only against a measurement. State the number before and after; use the repo's profiling skill when it has one.

Stop when every objective has evidence and the final state survives two consecutive quiet attack rounds. One may be the round that built it; at least one must be attack-only. An attack-only round re-runs the lenses that still apply without building. A finding rejected with reasons, or already reported as unmet, does not count as new.

When the loop ends, run implementation steps 6–10 once. If a closing step finds a failure, fix it. Re-run evidence for every changed surface, including blind comparison when the judged surface changed. Run attack-only rounds on changes made during closing until two in a row are quiet. If evidence fails, reopen build rounds. Re-run an already completed closing step only when its surface changed.

Stop early when rounds stop making progress, such as the same findings returning or only cosmetic changes remaining. Report which objectives are met, which are not, and why. The final report must say whether the stop condition was met.
