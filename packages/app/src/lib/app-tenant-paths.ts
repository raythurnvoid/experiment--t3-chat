/**
 * URL helpers for workspace/project scoped routes.
 *
 * Canonical path shape: `/w/{workspaceId}/p/{projectId}/...`
 */
export function app_tenantPaths_tenantPrefix(args: { workspaceId: string; projectId: string }) {
	return `/w/${args.workspaceId}/p/${args.projectId}`;
}

export function app_tenantPaths_pages(args: { workspaceId: string; projectId: string }) {
	return `${app_tenantPaths_tenantPrefix(args)}/pages`;
}

export function app_tenantPaths_chat(args: { workspaceId: string; projectId: string }) {
	return `${app_tenantPaths_tenantPrefix(args)}/chat`;
}

export function app_tenantPaths_scopeKey(args: { workspaceId: string; projectId: string }) {
	return `${args.workspaceId}::${args.projectId}`;
}

type App_tenant_workspace_for_defaults = {
	_id: string;
	default: boolean;
	defaultProjectId?: string;
};

type App_tenant_project_for_defaults = {
	_id: string;
	default: boolean;
};

/**
 * Pick default project for one workspace using the same rules as `workspaces.list`-based routing.
 */
export function app_tenant_default_project_for_workspace(args: {
	workspace: App_tenant_workspace_for_defaults;
	projects: App_tenant_project_for_defaults[];
}): App_tenant_project_for_defaults | null {
	const project =
		(args.workspace.defaultProjectId
			? args.projects.find((p) => p._id === args.workspace.defaultProjectId)
			: undefined) ??
		args.projects.find((p) => p.default) ??
		args.projects[0];
	return project ?? null;
}

/**
 * Resolve default workspace + project from `workspaces.list` (same flags as server-side defaults).
 */
export function app_tenant_defaults_from_workspace_list(args: {
	workspaces: App_tenant_workspace_for_defaults[];
	workspaceIdsProjectsDict: Record<string, App_tenant_project_for_defaults[]>;
}): { workspaceId: string; projectId: string } | null {
	const workspace = args.workspaces.find((w) => w.default) ?? args.workspaces[0];
	if (!workspace) {
		return null;
	}

	const projects = args.workspaceIdsProjectsDict[workspace._id] ?? [];
	const project = app_tenant_default_project_for_workspace({ workspace, projects });
	if (!project) {
		return null;
	}

	return { workspaceId: workspace._id, projectId: project._id };
}
