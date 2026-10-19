// Limits of the archive and restore job in convex/files_archive_runs.ts. They live here so a test can
// lower them with `vi.mock` and cross them with a small tree. That module reuses its loaded context
// between calls, so it may not keep a value that a test changes.

/**
 * A check step reads at most this many nodes. It writes nothing, so it can read more than an apply step.
 */
export const files_archive_runs_CHECK_STEP_MAX_NODES = 500;

/**
 * The Archive or Restore request stamps at most this many nodes itself. A fast archive names at most
 * this many items, so the request stamps every named item. On dev one stamp costs about 60 ms of
 * database time (measured 2026-10-19), so the stamps stay near 0.6 s.
 */
export const files_archive_runs_REQUEST_MAX_NODES = 10;

/**
 * The Archive or Restore request checks at most this many nodes itself. The check costs about 6 ms per
 * node on dev (measured 2026-10-19). A bigger tree is checked in the background.
 */
export const files_archive_runs_REQUEST_MAX_CHECK_NODES = 100;
