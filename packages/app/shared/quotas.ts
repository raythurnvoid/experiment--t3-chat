import type { Doc } from "../convex/_generated/dataModel";

export const quotas = {
	extra_workspaces: {
		disabledReason: "You can only create 2 extra workspaces in addition to your personal workspace",
		maxCount: 2,
		tooltip_explanation:
			"Includes your personal workspace and any extra workspaces your plan allows. The fraction is how many workspaces you have out of the maximum total.",
	},
	extra_projects: {
		disabledReason:
			"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		maxCount: 1,
		tooltip_explanation:
			"Includes the default home project and any extra projects this workspace allows. The fraction is how many projects this workspace has out of the maximum total.",
	},
} as const satisfies Record<
	Doc<"quotas">["quotaName"],
	{ maxCount: number; disabledReason: string; tooltip_explanation: string }
>;
