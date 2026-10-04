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
		tooltip_explanation: "Counts your active API keys in this workspace. Revoked keys do not count toward this limit.",
	},
	stored_file_bytes: {
		disabledReason: "This workspace has reached its storage limit",
		// Starting value, not a product rule. It only protects the system. Raise it step by step as needed.
		maxCount: 10 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts published stored files in this workspace. Deleting or archiving files does not give space back.",
	},
	files_private_user_bytes: {
		disabledReason: "Your pending files in this workspace have reached 1 GiB. Save or discard work to free space",
		// Starting value, not a product rule. It only protects the system. Raise it step by step as needed.
		maxCount: 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts your stored pending content and prepared copies. Space returns after the content is saved or its stored bytes are deleted.",
	},
	files_private_workspace_bytes: {
		disabledReason: "Pending files in this workspace have reached 5 GiB. Save or discard work to free space",
		// Starting value, not a product rule. It only protects the system. Raise it step by step as needed.
		maxCount: 5 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts all stored pending content and prepared copies in this workspace. Cleanup keeps using space until deletion finishes.",
	},
	files_private_nodes: {
		disabledReason: "You have 10,000 pending new files and folders in this workspace. Save or discard some first",
		// Starting value, not a product rule. It only protects the system. Raise it step by step as needed.
		maxCount: 10_000,
		tooltip_explanation:
			"Counts your new private files and folders until they are saved or fully removed. Changes to saved files do not use these slots.",
	},
	ai_chat_output_workspace_bytes: {
		disabledReason: "Chat storage is full for this workspace. Delete chats or ask for a higher limit.",
		maxCount: 5 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts the full text of large tool results that chats in this workspace keep. Deleting a chat gives its space back. Archiving does not.",
	},
	ai_chat_output_user_bytes: {
		disabledReason: "Your chat storage is full in this workspace. Delete chats or ask for a higher limit.",
		maxCount: 2 * 1024 * 1024 * 1024,
		tooltip_explanation:
			"Counts the full text of large tool results that your chats in this workspace keep. Deleting a chat gives its space back. Archiving does not.",
	},
	ai_chat_output_workspace_objects: {
		disabledReason: "Chat storage is full for this workspace. Delete chats or ask for a higher limit.",
		maxCount: 50_000,
		tooltip_explanation:
			"Counts the large tool results that chats in this workspace keep. Deleting a chat gives them back. Archiving does not.",
	},
} as const satisfies Record<
	Doc<"quotas">["quotaName"],
	{ maxCount: number; disabledReason: string; tooltip_explanation: string }
>;
