import { memo, useEffect } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";

import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";

type ActivityJobToast_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	job:
		| { kind: "files_transfer_run"; id: app_convex_Id<"files_transfer_runs"> }
		| { kind: "files_pending_update_run"; id: app_convex_Id<"files_pending_update_runs"> };
	/**
	 * The verb in three forms, for example `["move", "Moving", "Moved"]`.
	 */
	verbs: readonly [string, string, string];
	/**
	 * What the job acts on, for example `3 items` or `"a.md" to "b.md"`.
	 */
	subject: string;
	onOpen: () => void;
	/**
	 * Called when the job starts to wait for an answer, like a name conflict choice. `null` when the
	 * job never asks.
	 */
	onNeedsInput: (() => void) | null;
	onFinish: () => void;
};

/**
 * Show one toast while a background job runs, and update the same toast when the job ends.
 *
 * A job dialog opens by itself only when the job needs an answer. Finder, Explorer, Google Drive and
 * Dropbox do the same: they show no dialog for a job that needs nothing from the user.
 */
export const ActivityJobToast = memo(function ActivityJobToast(props: ActivityJobToast_Props) {
	const { membershipId, job, verbs, subject, onOpen, onNeedsInput, onFinish } = props;
	const [verbBase, verbRunning, verbDone] = verbs;
	const transferRun = useQuery(
		app_convex_api.files_transfer_status.get,
		job.kind === "files_transfer_run" ? { membershipId, runId: job.id } : "skip",
	);
	const reviewRun = useQuery(
		app_convex_api.files_pending_update_runs.get,
		job.kind === "files_pending_update_run" ? { membershipId, runId: job.id } : "skip",
	);
	const run = job.kind === "files_transfer_run" ? transferRun : reviewRun;

	const status = run?.activity.status;
	// A job that is no longer available counts as finished, so its owner stops waiting for it.
	const isGone = run === null;
	const isFinished = isGone || run?.activity.finishedAt !== undefined;
	const isWaitingForAnswer = status === "awaiting_input" && onNeedsInput !== null;
	const hasProgress = run?.activity.progress !== undefined;
	const completed = run?.activity.progress?.completed ?? 0;
	// Skipped items were already in place or the person chose Skip. So, like the Activity card, only
	// failed and blocked items count as missed.
	const missed = (run?.activity.progress?.failed ?? 0) + (run?.activity.progress?.blocked ?? 0);
	const unit = run?.activity.progress?.unit ?? "items";
	const errorMessage = run?.activity.errorMessage;

	// The callers pass new functions on each render. Keep stable ones so the effects below run only
	// when the job changes.
	const handleOpen = useFn(() => onOpen());
	const handleNeedsInput = useFn(() => onNeedsInput?.());
	const handleFinish = useFn(() => onFinish());

	useEffect(() => {
		// Run once each time the job starts to wait, so a dialog the user hid does not open again.
		if (!isWaitingForAnswer) return;
		toast.dismiss(job.id);
		handleNeedsInput();
	}, [handleNeedsInput, isWaitingForAnswer, job.id]);

	useEffect(() => {
		if (isWaitingForAnswer) return;

		// The toast id is the job id, so each call replaces the same toast.
		const viewOptions = { id: job.id, action: { label: "View", onClick: handleOpen } };
		const detailsOptions = { id: job.id, action: { label: "Details", onClick: handleOpen } };

		if (isGone) {
			toast.dismiss(job.id);
		} else if (!isFinished) {
			toast.loading(`${verbRunning} ${subject}…`, viewOptions);
		} else if (status === "canceled") {
			toast.info(`Stopped ${verbRunning.toLowerCase()} ${subject}.`, viewOptions);
		} else if (status === "succeeded" && hasProgress && completed === 0) {
			// Every item was skipped, for example because it was already in place.
			toast.info(`Nothing was ${verbDone.toLowerCase()}.`, viewOptions);
		} else if (hasProgress ? completed === 0 : status !== "succeeded") {
			// Some error messages end with a period and some do not.
			const reason = errorMessage ? `: ${errorMessage.replace(/\.?$/, ".")}` : ".";
			toast.error(`Could not ${verbBase} ${subject}${reason}`, detailsOptions);
		} else if (missed > 0) {
			toast.warning(`${verbDone} ${completed} of ${completed + missed} ${unit}.`, detailsOptions);
		} else {
			toast.success(`${verbDone} ${subject}.`, viewOptions);
		}

		if (isFinished) handleFinish();
	}, [
		completed,
		errorMessage,
		handleFinish,
		handleOpen,
		hasProgress,
		isFinished,
		isGone,
		isWaitingForAnswer,
		job.id,
		missed,
		status,
		subject,
		unit,
		verbBase,
		verbDone,
		verbRunning,
	]);

	return null;
});
