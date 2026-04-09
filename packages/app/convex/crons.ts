import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Once daily at 05:00 UTC.
crons.cron("cleanup old snapshots", "0 5 * * *", internal.ai_docs_temp.cleanup_old_snapshots);

// Once daily at 06:00 UTC — workspace/content purge plus eligible hard user-account deletes.
crons.cron("unified delayed data deletion pipeline", "0 6 * * *", internal.data_deletion.process_deletion_requests, {});

// Safety net: drain Polar meter outbox if scheduled drains lag behind enqueue spikes.
crons.interval("billing polar usage outbox drain", { minutes: 5 }, internal.billing.drain_outbox);

// Refresh cached Polar meter snapshots when they fall behind (~5m) or webhook misses occur.
crons.interval(
	"billing reconcile stale meter snapshots",
	{ minutes: 5 },
	internal.billing.reconcile_stale_billing_usage_snapshots,
);

export default crons;
