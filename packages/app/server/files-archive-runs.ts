// Limits of the archive and restore job in convex/files_archive_runs.ts. They live here so a test can
// lower them with `vi.mock` and cross them with a small tree. That module reuses its loaded context
// between calls, so it may not keep a value that a test changes.

/**
 * A check step reads at most this many nodes. It writes nothing, so it can read more than an apply step.
 */
export const files_archive_runs_CHECK_STEP_MAX_NODES = 500;
