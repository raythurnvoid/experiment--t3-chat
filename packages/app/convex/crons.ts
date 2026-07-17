import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Once daily at 00:00 UTC.
crons.cron("reset due anonymous billing credits", "0 0 * * *", internal.billing.reset_due_anonymous_credits, {});

// Once daily at 03:00 UTC — refresh read-only GitHub repo mounts (real work only on commit movement).
crons.cron("sync github mounts", "0 3 * * *", internal.github_mounts.sync_all_mounts, {});

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

// Once daily at 06:00 UTC — organization/content purge plus eligible hard user-account deletes.
crons.cron("unified delayed data deletion pipeline", "0 6 * * *", internal.data_deletion.enqueue_deletion_requests_processing, {});

// Once hourly — fail plugin runs whose executor died (crash/deploy) past their TTL.
crons.cron("fail expired plugin event runs", "0 * * * *", internal.plugins_runtime.fail_expired_event_runs, {});

// Once hourly — reap staged file writes that were never published (crashed action, dead caller).
crons.cron(
	"cleanup expired file write stages",
	"30 * * * *",
	internal.public_api.cleanup_expired_file_write_stages,
	{},
);

// Once daily at 06:30 UTC — delete terminal plugin runs and their call docs past retention.
crons.cron("cleanup old plugin event runs", "30 6 * * *", internal.plugins_runtime.cleanup_old_event_runs, {});

// Once daily at 06:45 UTC — delete expired plugin UI page sessions.
crons.cron("cleanup expired plugin ui sessions", "45 6 * * *", internal.plugins_ui.cleanup_expired_ui_sessions, {});

// Once hourly — clean up files uploaded by interrupted publishes whose scheduled cleanup run never happened (crash, failed retry).
crons.cron(
	"cleanup stale plugin publish artifacts",
	"15 * * * *",
	internal.plugins.schedule_due_publish_artifact_cleanup_attempts,
	{},
);

// Every 5 minutes — close running activities past their caller-set deadline as "timeout".
crons.cron("timeout stale activities", "*/5 * * * *", internal.activities.timeout_stale_activities, {});

export default crons;
