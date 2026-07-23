import type { Doc } from "../convex/_generated/dataModel";

export const quotas = {
	extra_organizations: {
		disabledReason: "You can only create 2 extra organizations in addition to your personal organization",
		maxCount: 2,
		tooltip_explanation:
			"Includes your personal organization and any extra organizations your plan allows. The fraction is how many organizations you have out of the maximum total.",
	},
	extra_workspaces: {
		disabledReason:
			"This organization already has 6 workspaces. Each organization can contain up to 6 workspaces total, including home",
		maxCount: 5,
		tooltip_explanation:
			"Includes the default home workspace and any extra workspaces this organization allows. The fraction is how many workspaces this organization has out of the maximum total.",
	},
	active_api_credentials: {
		disabledReason: "You can have up to 20 active API keys in this workspace",
		maxCount: 20,
		tooltip_explanation:
			"Counts your active API keys in this workspace. Revoked keys do not count toward this limit.",
	},
} as const satisfies Record<
	Doc<"quotas">["quotaName"],
	{ maxCount: number; disabledReason: string; tooltip_explanation: string }
>;
