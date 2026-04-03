import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Once daily at 05:00 UTC.
crons.cron("cleanup old snapshots", "0 5 * * *", internal.ai_docs_temp.cleanup_old_snapshots);

// Once daily at 06:00 UTC — workspace/content purge plus eligible hard user-account deletes.
crons.cron("unified delayed data deletion pipeline", "0 6 * * *", internal.data_deletion.process_deletion_requests);

export default crons;
