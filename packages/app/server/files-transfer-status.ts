// Limits of the transfer reads in convex/files_transfer_status.ts. They live here so a test can lower them
// with `vi.mock` and cross them with fewer files. That module reuses its loaded context between calls, so
// it may not keep a value that a test changes.

/**
 * The transfer view reads at most this many conflicts and moved roots. One conflict choice call holds at
 * most this many choices.
 */
export const files_transfer_status_MAX_SELECTED_NODES = 200;
