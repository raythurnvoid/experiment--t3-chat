import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.daily(
	"cleanup old snapshots",
	{ hourUTC: 5, minuteUTC: 0 }, // 5AM UTC
	internal.ai_docs_temp.cleanup_old_snapshots,
);

export default crons;
