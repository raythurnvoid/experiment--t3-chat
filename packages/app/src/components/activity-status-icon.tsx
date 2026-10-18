import "./activity-status-icon.css";

import { CircleCheck, CircleMinus, CircleX, createLucideIcon, LoaderCircle, TriangleAlert } from "lucide-react";
import { __iconNode as circle_check_icon_node } from "lucide-react/dist/esm/icons/circle-check.js";
import { __iconNode as circle_dashed_icon_node } from "lucide-react/dist/esm/icons/circle-dashed.js";
import { memo } from "react";

import type { app_convex_Doc } from "@/lib/app-convex-client.ts";
import { files_MOVE_REPAIR_STUCK_CODE } from "@/lib/files.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Lucide has no dashed circle with a check. Build one from Lucide's own shapes: the dashed circle,
 * plus the check mark of `CircleCheck`.
 */
const CircleDashedCheck = createLucideIcon("circle-dashed-check", [
	...circle_dashed_icon_node,
	...circle_check_icon_node.filter(([tag]) => tag === "path"),
]);

type ActivityStatusIcon_Kind = "running" | "action_needed" | "succeeded" | "partial" | "failed" | "canceled";

type ActivityStatusIcon_ClassNames =
	| "ActivityStatusIcon"
	| `ActivityStatusIcon-kind-${ActivityStatusIcon_Kind}`
	| "ActivityStatusIcon-spinning";

type ActivityStatusIcon_CustomAttributes = {
	"data-activity-status-icon": ActivityStatusIcon_Kind;
};

type ActivityStatusIcon_Props = {
	className?: string;
	activity: Pick<app_convex_Doc<"activities">, "status" | "finishedAt" | "errorCode">;
	/**
	 * The job ended `partial` only because it refused items the person may not change, like a
	 * read-only file. That is expected, so the job shows as completed.
	 */
	isRefusalOnly: boolean;
};

/**
 * The one status icon of a job: on its Activity card and in its job dialog heading.
 */
export const ActivityStatusIcon = memo(function ActivityStatusIcon(props: ActivityStatusIcon_Props) {
	const { className, activity, isRefusalOnly } = props;

	const isActive = activity.finishedAt === undefined;
	// A stuck Move cleanup waits for the person to press Try again, like a name conflict.
	const kind: ActivityStatusIcon_Kind =
		isActive && (activity.status === "awaiting_input" || activity.errorCode === files_MOVE_REPAIR_STUCK_CODE)
			? "action_needed"
			: isActive
				? "running"
				: activity.status === "succeeded" || isRefusalOnly
					? "succeeded"
					: activity.status === "partial"
						? "partial"
						: activity.status === "canceled"
							? "canceled"
							: "failed";
	const Icon = {
		running: LoaderCircle,
		action_needed: TriangleAlert,
		succeeded: CircleCheck,
		partial: CircleDashedCheck,
		failed: CircleX,
		canceled: CircleMinus,
	}[kind];

	return (
		<span
			{...({ "data-activity-status-icon": kind } satisfies ActivityStatusIcon_CustomAttributes)}
			className={cn(
				"ActivityStatusIcon" satisfies ActivityStatusIcon_ClassNames,
				`ActivityStatusIcon-kind-${kind}` satisfies ActivityStatusIcon_ClassNames,
				// A queued or stopping job shows the same circle, but it stays still.
				activity.status === "running" && ("ActivityStatusIcon-spinning" satisfies ActivityStatusIcon_ClassNames),
				className,
			)}
			aria-hidden
		>
			<Icon />
		</span>
	);
});
