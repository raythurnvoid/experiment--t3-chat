// Limits of the review job in convex/files_pending_update_runs.ts. They live here so a test can lower them
// with `vi.mock` and cross them with fewer items. That module reuses its loaded context between calls, so
// it may not keep a value that a test changes.

/** One page of review items or units. A call, a plan write and a planning read hold at most this many. */
export const files_pending_update_runs_SELECTION_PAGE_SIZE = 100;
