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
crons.cron(
	"unified delayed data deletion pipeline",
	"0 6 * * *",
	internal.data_deletion.enqueue_deletion_requests_processing,
	{},
);

// Every 5 minutes — stop expired jobs through their producer's publication fences.
crons.cron("recover expired activities", "*/5 * * * *", internal.activities.recover_expired, {});

// Once hourly — reap staged file writes that were never published (crashed action, dead caller).
crons.cron(
	"cleanup expired file write stages",
	"30 * * * *",
	internal.public_api.cleanup_expired_file_write_stages,
	{},
);

// Once hourly — delete asset docs (and any landed bytes) whose R2 object was never confirmed.
crons.cron("cleanup expired unfinalized assets", "45 * * * *", internal.r2.cleanup_expired_unfinalized_assets, {});

// Once hourly — delete expired draft captures with their blobs, starting sessions that never
// committed, old daily-use counters, settled sessions past their retention, and saved browser
// profiles unused for 90 days.
crons.cron("cleanup expired browser docs", "5 * * * *", internal.files_browser.cleanup_expired_browser_docs, {});

// Every 5 minutes — close web browsers whose owner lost access, and bill browser sessions that ended
// without a settle (failed End, lost status check).
crons.cron("settle browser usage", "*/5 * * * *", internal.files_browser.settle_pending_browser_usage, {});

// Every 5 minutes — ask the browser runner to delete the stored bytes of deleted saved profiles,
// and retry failed wipes whose backoff is over. Each deletion also starts this job at once.
crons.cron("process browser profile wipes", "*/5 * * * *", internal.files_browser.process_browser_profile_wipes, {});

// Each hour, schedule up to 50 R2 deletion jobs whose retry time has passed.
crons.cron(
	"process due r2 object deletion jobs",
	"50 * * * *",
	internal.r2_client.schedule_due_object_deletion_jobs,
	{},
);

// Once daily at 06:30 UTC — delete expired history, producer receipts, and viewer state in bounded passes.
crons.cron("cleanup activity history", "30 6 * * *", internal.activities.cleanup_history, {});

// Once daily — remove seven-day Bash results while keeping terminal call identities.
crons.cron("cleanup expired bash results", "35 6 * * *", internal.ai_chat_files.cleanup_expired_bash_results, {});

// Once daily — remove old private publication links after their last caller releases them.
crons.cron(
	"cleanup private publication receipts",
	"40 6 * * *",
	internal.files_pending_nodes.cleanup_published_nodes,
	{},
);

// Once daily at 06:45 UTC — delete expired plugin UI page sessions.
crons.cron("cleanup expired plugin ui sessions", "45 6 * * *", internal.plugins_ui.cleanup_expired_ui_sessions, {});

// Once hourly — release plugin-data reservations a crashed producer never released, then delete the
// retry records, delete tombstones and append receipts, and delete expired service grants.
//
// Hourly, not daily: a retry record only becomes deletable 24 hours after its release, so a daily
// pass would often miss the rows that just became eligible and hold their slots for another day.
crons.cron("cleanup expired plugin data", "20 * * * *", internal.plugins_data.cleanup_expired_plugin_data, {});

// Once hourly — clean up files uploaded by interrupted publishes whose scheduled cleanup run never happened (crash, failed retry).
crons.cron(
	"cleanup stale plugin publish artifacts",
	"15 * * * *",
	internal.plugins.schedule_due_publish_artifact_cleanup_attempts,
	{},
);

// Every 5 minutes — release expired transfer attempts, including uploads that outlive Stop.
crons.cron("recover expired transfer attempts", "*/5 * * * *", internal.files_transfer.recover_expired_attempts, {});

// Every 5 minutes — resume interrupted review plans and commits.
crons.cron("recover pending review jobs", "*/5 * * * *", internal.files_pending_update_runs.recover, {});

// Every 15 minutes — crash/abandon fallback for paged pending states: expired temporary
// states/batches/text inputs, expired trusted-update stages, and retired-state cleanup tasks.
crons.cron(
	"cleanup expired pending state rows",
	"*/15 * * * *",
	internal.files_pending_updates.cleanup_expired_pending_state_rows,
	{},
);

// Every 15 minutes — delete media mapping docs left by an interrupted cleanup.
crons.cron("recover media dependency cleanup", "*/15 * * * *", internal.files_media_dependencies.recover_cleanup, {});

// Every 15 minutes — release draft holds left by finished or interrupted jobs.
crons.cron("recover pending draft holds", "*/15 * * * *", internal.files_pending_holds.recover, {});

// Every 15 minutes — retire unfinished ingestion and remove old retry receipts.
crons.cron(
	"cleanup expired file ingestion receipts",
	"*/15 * * * *",
	internal.files_ingestion.cleanup_expired_receipts,
	{},
);

// Every 15 minutes — resume private Discard cleanup after a failed continuation.
crons.cron(
	"recover private draft cleanup",
	"*/15 * * * *",
	internal.files_pending_nodes.recover_discarded_node_cleanup,
	{},
);

// Every 15 minutes — resume Yjs cleanup left by a failed scheduled continuation.
crons.cron(
	"recover file yjs cleanup tasks",
	"*/15 * * * *",
	internal.files_nodes_content.recover_file_yjs_cleanup_tasks,
	{},
);

export default crons;
