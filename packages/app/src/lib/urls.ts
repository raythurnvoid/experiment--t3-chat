/**
 * URL helpers for organization/workspace scoped routes.
 *
 * Canonical path shape: `/w/{organizationName}/{workspaceName}/...`
 */
export function url_path_files(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/files`;
}

export function url_path_chat(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/chat`;
}

export function url_path_users(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/users`;
}

export function app_tenantPaths_scopeKey(args: { organizationId: string; workspaceId: string }) {
	return `${args.organizationId}::${args.workspaceId}`;
}

type App_tenant_organization_for_defaults = {
	_id: string;
	default: boolean;
	defaultWorkspaceId?: string;
	name: string;
};

type App_tenant_workspace_for_defaults = {
	_id: string;
	default: boolean;
	name: string;
};

/**
 * Resolve the actual organization primary workspace when the client can see it.
 * If `defaultWorkspaceId` is present but omitted from `workspaces`, the primary is hidden to this user.
 */
export function app_tenant_primary_workspace_for_organization(args: {
	organization: App_tenant_organization_for_defaults;
	workspaces: App_tenant_workspace_for_defaults[];
}): App_tenant_workspace_for_defaults | null {
	if (args.organization.defaultWorkspaceId) {
		return args.workspaces.find((p) => p._id === args.organization.defaultWorkspaceId) ?? null;
	}

	return args.workspaces.find((p) => p.default) ?? null;
}

/**
 * Pick a navigable default workspace for one organization using the same rules as `organizations.list`-based routing.
 */
export function app_tenant_default_workspace_for_organization(args: {
	organization: App_tenant_organization_for_defaults;
	workspaces: App_tenant_workspace_for_defaults[];
}): App_tenant_workspace_for_defaults | null {
	const workspace = app_tenant_primary_workspace_for_organization(args) ?? args.workspaces[0];
	return workspace ?? null;
}

/**
 * Resolve default organization + workspace from `organizations.list` (same flags as server-side defaults).
 */
export function app_tenant_defaults_from_organization_list(args: {
	organizations: App_tenant_organization_for_defaults[];
	organizationIdsWorkspacesDict: Record<string, App_tenant_workspace_for_defaults[]>;
}): { organizationName: string; workspaceName: string } | null {
	const organization = args.organizations.find((w) => w.default) ?? args.organizations[0];
	if (!organization) {
		return null;
	}

	const workspaces = args.organizationIdsWorkspacesDict[organization._id] ?? [];
	const workspace = app_tenant_default_workspace_for_organization({ organization, workspaces });
	if (!workspace) {
		return null;
	}

	return { organizationName: organization.name, workspaceName: workspace.name };
}
