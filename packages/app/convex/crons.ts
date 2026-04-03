import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Once daily at 05:00 UTC.
crons.cron("cleanup old snapshots", "0 5 * * *", internal.ai_docs_temp.cleanup_old_snapshots);

// Once daily at 06:00 UTC.
crons.cron("process queued user deletions", "0 6 * * *", internal.account_deletion.process_user_deletion_requests);

// Once daily at 06:30 UTC.
crons.cron("purge queued workspace data deletions", "30 6 * * *", internal.workspaces.purge_data_deletion_requests, {});

export default crons;
