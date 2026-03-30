export const user_limits = {
	EXTRA_WORKSPACES: {
		disabledReason: "You can only create 1 extra workspace in addition to your personal workspace",
		maxCount: 1,
		name: "extra_workspaces",
		tooltip_explanation:
			"Includes your personal workspace and any extra workspaces your plan allows. The fraction is how many workspaces you have out of the maximum total.",
	},
} as const;

export const workspace_limits = {
	EXTRA_PROJECTS: {
		disabledReason:
			"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		maxCount: 1,
		name: "extra_projects",
		tooltip_explanation:
			"Includes the default home project and any extra projects this workspace allows. The fraction is how many projects this workspace has out of the maximum total.",
	},
} as const;
