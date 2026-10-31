import { createContext, memo, use, useRef, useState, type ReactNode } from "react";
import { ActivityJobToast } from "@/components/activity-job-toast.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { FilesArchiveRunModal } from "@/components/files/files-archive-modal.tsx";
import { FilesPendingReviewModal } from "@/components/files/files-pending-review.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";

type ActivitySourceId = app_convex_Doc<"activities">["source"]["id"];
type StopResult = app_convex_FunctionReturnType<typeof app_convex_api.activities.request_stop>;
type ReviewSelection = Pick<
	app_convex_FunctionArgs<typeof app_convex_api.files_pending_update_runs.start>,
	"kind" | "items"
>;

const AppActivitiesContext = createContext<{
	pendingStopSourceIds: ReadonlySet<ActivitySourceId>;
	stop: (args: { activityId: app_convex_Id<"activities">; sourceId: ActivitySourceId }) => Promise<StopResult>;
	isStartingReview: boolean;
	startReview: (selection: ReviewSelection) => Promise<void>;
	/** `kind` names the run before it loads, so the dialog heading does not flip. */
	openReviewRun: (runId: app_convex_Id<"files_pending_update_runs">, kind?: ReviewSelection["kind"]) => void;
	openArchiveRun: (runId: app_convex_Id<"files_archive_runs">) => void;
	/**
	 * Show a toast while a Save or Discard runs. The user opens its dialog from the toast or Activity.
	 */
	watchReviewRun: (args: WatchedReviewRun) => void;
	/**
	 * Show a toast while a Delete permanently or Empty archive job runs.
	 */
	watchArchiveRun: (args: WatchedArchiveRun) => void;
} | null>(null);

type WatchedReviewRun = {
	runId: app_convex_Id<"files_pending_update_runs">;
	kind: ReviewSelection["kind"];
	/**
	 * What the job acts on, for example `3 changes` or `your changes`.
	 */
	subject: string;
};

type WatchedArchiveRun = {
	runId: app_convex_Id<"files_archive_runs">;
	/**
	 * The verb in three forms, for example `["delete", "Deleting", "Deleted"]`.
	 */
	verbs: readonly [string, string, string];
	/**
	 * What the job acts on, for example `3 items`.
	 */
	subject: string;
};

const REVIEW_VERBS = {
	accept: ["save", "Saving", "Saved"],
	discard: ["discard", "Discarding", "Discarded"],
} as const;

const AppActivitiesProvider = Object.assign(
	memo(function AppActivitiesProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const [pendingStopSourceIds, setPendingStopSourceIds] = useState<ReadonlySet<ActivitySourceId>>(new Set());
		const pendingStops = useRef(new Map<ActivitySourceId, Promise<StopResult>>());
		const [reviewRun, setReviewRun] = useState<{
			id: app_convex_Id<"files_pending_update_runs">;
			kind: ReviewSelection["kind"] | undefined;
		} | null>(null);
		const [archiveRunId, setArchiveRunId] = useState<app_convex_Id<"files_archive_runs"> | null>(null);
		const [watchedReviewRuns, setWatchedReviewRuns] = useState<WatchedReviewRun[]>([]);
		const [watchedArchiveRuns, setWatchedArchiveRuns] = useState<WatchedArchiveRun[]>([]);
		const [isStartingReview, setIsStartingReview] = useState(false);
		const reviewPending = useRef(false);
		const reviewRequest = useRef<{
			signature: string;
			requestId: string;
			runId?: app_convex_Id<"files_pending_update_runs">;
		} | null>(null);

		const stop = useFn((args: { activityId: app_convex_Id<"activities">; sourceId: ActivitySourceId }) => {
			// The bell and a job dialog can request the same Stop before either re-renders.
			const pending = pendingStops.current.get(args.sourceId);
			if (pending) return pending;

			const request = app_convex
				.mutation(app_convex_api.activities.request_stop, { membershipId, activityId: args.activityId })
				.then((result) => {
					// A later click must start new work after this review was stopped.
					if (!result._nay && reviewRequest.current?.runId === args.sourceId) reviewRequest.current = null;
					return result;
				})
				.finally(() => {
					pendingStops.current.delete(args.sourceId);
					setPendingStopSourceIds((current) => {
						const next = new Set(current);
						next.delete(args.sourceId);
						return next;
					});
				});
			pendingStops.current.set(args.sourceId, request);
			setPendingStopSourceIds((current) => new Set(current).add(args.sourceId));
			return request;
		});

		const openReviewRun = useFn((runId: app_convex_Id<"files_pending_update_runs">, kind?: ReviewSelection["kind"]) =>
			setReviewRun({ id: runId, kind }),
		);

		const openArchiveRun = useFn((runId: app_convex_Id<"files_archive_runs">) => setArchiveRunId(runId));

		// A Save or Discard never asks a question, so its dialog never opens by itself.
		const watchReviewRun = useFn((watchedRun: WatchedReviewRun) => {
			setWatchedReviewRuns((current) =>
				current.some((item) => item.runId === watchedRun.runId) ? current : [...current, watchedRun],
			);
		});

		const watchArchiveRun = useFn((watchedRun: WatchedArchiveRun) => {
			setWatchedArchiveRuns((current) =>
				current.some((item) => item.runId === watchedRun.runId) ? current : [...current, watchedRun],
			);
		});

		const startReview = useFn(async (selection: ReviewSelection) => {
			if (reviewPending.current) throw new Error("Your changes are already being sent.");
			if (selection.items.length === 0) throw new Error("Select at least one pending change.");
			reviewPending.current = true;
			setIsStartingReview(true);
			// Keep the same request and pages after a lost reply. Only Seal starts the worker.
			const signature = JSON.stringify(selection);
			if (reviewRequest.current?.signature !== signature) {
				reviewRequest.current = { signature, requestId: crypto.randomUUID() };
			}
			const request = reviewRequest.current;
			// The React Compiler has trouble lowering `try`/`finally` inside a component, so the
			// cleanup runs in `.finally(...)` on this IIFE instead.
			return (async (/* iife */) => {
				const started = await app_convex.mutation(app_convex_api.files_pending_update_runs.start, {
					membershipId,
					requestId: request.requestId,
					kind: selection.kind,
					expectedItemCount: selection.items.length,
					items: selection.items.slice(0, 100),
				});
				if (started._nay) {
					reviewRequest.current = null;
					throw new Error(started._nay.message);
				}
				const runId = started._yay.runId;
				request.runId = runId;
				const count = selection.items.length;
				watchReviewRun({ runId, kind: selection.kind, subject: `${count} ${count === 1 ? "change" : "changes"}` });
				for (let offset = 100; offset < selection.items.length; offset += 100) {
					const appended = await app_convex.mutation(app_convex_api.files_pending_update_runs.append_items, {
						membershipId,
						runId,
						offset,
						items: selection.items.slice(offset, offset + 100),
					});
					if (appended._nay) {
						reviewRequest.current = null;
						throw new Error(appended._nay.message);
					}
				}
				const sealed = await app_convex.mutation(app_convex_api.files_pending_update_runs.seal, {
					membershipId,
					runId,
				});
				if (sealed._nay) {
					reviewRequest.current = null;
					throw new Error(sealed._nay.message);
				}
				reviewRequest.current = null;
			})().finally(() => {
				reviewPending.current = false;
				setIsStartingReview(false);
			});
		});

		return (
			<AppActivitiesContext.Provider
				value={{
					pendingStopSourceIds,
					stop,
					isStartingReview,
					startReview,
					openReviewRun,
					openArchiveRun,
					watchReviewRun,
					watchArchiveRun,
				}}
			>
				{children}
				{watchedReviewRuns.map((item) => (
					<ActivityJobToast
						key={item.runId}
						membershipId={membershipId}
						job={{ kind: "files_pending_update_run", id: item.runId }}
						verbs={REVIEW_VERBS[item.kind]}
						subject={item.subject}
						onOpen={() => openReviewRun(item.runId, item.kind)}
						onNeedsInput={null}
						onFinish={() => setWatchedReviewRuns((current) => current.filter((run) => run.runId !== item.runId))}
					/>
				))}
				{watchedArchiveRuns.map((item) => (
					<ActivityJobToast
						key={item.runId}
						membershipId={membershipId}
						job={{ kind: "files_archive_run", id: item.runId }}
						verbs={item.verbs}
						subject={item.subject}
						onOpen={() => openArchiveRun(item.runId)}
						onNeedsInput={null}
						onFinish={() => setWatchedArchiveRuns((current) => current.filter((run) => run.runId !== item.runId))}
					/>
				))}
				{reviewRun ? (
					<FilesPendingReviewModal
						key={reviewRun.id}
						membershipId={membershipId}
						runId={reviewRun.id}
						kind={reviewRun.kind}
						onClose={() => setReviewRun(null)}
					/>
				) : null}
				{archiveRunId ? (
					<FilesArchiveRunModal
						key={archiveRunId}
						membershipId={membershipId}
						runId={archiveRunId}
						onClose={() => setArchiveRunId(null)}
					/>
				) : null}
			</AppActivitiesContext.Provider>
		);
	}),
	{
		useContext() {
			const value = use(AppActivitiesContext);
			if (!value) throw new Error("AppActivitiesProvider.useContext must be used within AppActivitiesProvider");
			return value;
		},
	},
);

export { AppActivitiesProvider };
