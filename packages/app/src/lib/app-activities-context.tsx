import { createContext, memo, use, useRef, useState, type ReactNode } from "react";
import { useFn } from "@/hooks/utils-hooks.ts";
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
	openReviewRun: (runId: app_convex_Id<"files_pending_update_runs">) => void;
} | null>(null);

const AppActivitiesProvider = Object.assign(
	memo(function AppActivitiesProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const [pendingStopSourceIds, setPendingStopSourceIds] = useState<ReadonlySet<ActivitySourceId>>(new Set());
		const pendingStops = useRef(new Map<ActivitySourceId, Promise<StopResult>>());
		const [reviewRunId, setReviewRunId] = useState<app_convex_Id<"files_pending_update_runs"> | null>(null);
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

		const openReviewRun = useFn((runId: app_convex_Id<"files_pending_update_runs">) => setReviewRunId(runId));

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
				openReviewRun(runId);
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
				value={{ pendingStopSourceIds, stop, isStartingReview, startReview, openReviewRun }}
			>
				{children}
				{reviewRunId ? (
					<FilesPendingReviewModal
						key={reviewRunId}
						membershipId={membershipId}
						runId={reviewRunId}
						onClose={() => setReviewRunId(null)}
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
