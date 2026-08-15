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
	public_api_upload_bytes: {
		disabledReason: "This workspace has used its 50 GB budget for file uploads through the API",
		maxCount: 50 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts the declared bytes of files uploaded through the public API in this workspace. The counter only grows: deleting files does not give the budget back.",
	},
	plugin_service_storage_bytes: {
		disabledReason: "This workspace has used its 10 GB of plugin service storage",
		maxCount: 10 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts the bytes plugin services reserve and store in this workspace through the service upload path. Deleting those stored files gives the space back.",
	},
} as const satisfies Record<
	Doc<"quotas">["quotaName"],
	{ maxCount: number; disabledReason: string; tooltip_explanation: string }
>;
