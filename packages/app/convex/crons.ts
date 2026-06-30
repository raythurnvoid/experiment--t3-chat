import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Once daily at 00:00 UTC.
crons.cron("reset due anonymous billing credits", "0 0 * * *", internal.billing.reset_due_anonymous_credits, {});

// Once daily at 03:00 UTC — refresh read-only GitHub repo mounts (real work only on commit movement).
crons.cron("sync github sources", "0 3 * * *", internal.github_sources.sync_all_sources, {});

// Once daily at 04:00 UTC.
crons.cron("cleanup extra notifications", "0 4 * * *", internal.notifications.cleanup_extra_notifications, {});

// Once daily at 04:30 UTC.
crons.cron("cleanup expired value store entries", "30 4 * * *", internal.value_store.cleanup_expired, {});

// Once daily at 05:00 UTC.
crons.cron("cleanup old snapshots", "0 5 * * *", internal.files_nodes.cleanup_old_snapshots, {});

// Once daily at 05:30 UTC.
crons.cron(
	"cleanup expired public API grants",
	"30 5 * * *",
	internal.public_api.cleanup_expired_grants_until_done,
	{},
);

// Once daily at 06:00 UTC — workspace/content purge plus eligible hard user-account deletes.
crons.cron("unified delayed data deletion pipeline", "0 6 * * *", internal.data_deletion.enqueue_deletion_requests_processing, {});

export default crons;
