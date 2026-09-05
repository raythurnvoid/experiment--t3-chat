import { path_extract_segments_from } from "../../shared/paths.ts";

/**
 * URL helpers for organization/workspace scoped routes.
 *
 * Canonical path shape: `/w/{organizationName}/{workspaceName}/...`
 */
export function url_path_files(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/files`;
}

/**
 * Build the shareable URL for one file or folder node.
 *
 * The node id form is the canonical one because it survives renames and moves. The files splat
 * route accepts the readable `/files/{path}` shape too, but only as an entry point: it resolves
 * the path to a node id and then replaces the URL with this shape.
 */
export function url_path_file_by_node_id(args: { organizationName: string; workspaceName: string; nodeId: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/files?nodeId=${encodeURIComponent(args.nodeId)}`;
}

const URL_FILE_LINK_PATH_MARKER = "/files/";

/**
 * Read a pasted app link back into whatever it points at.
 *
 * This reverses both shapes the files route produces: the canonical `?nodeId=` URL that Copy link
 * emits, and the readable `/files/{path}` entry point. Anything else returns `null`, including
 * plain text that merely contains a slash, so callers can fall through to their own handling.
 */
export function url_parse_file_link(value: string): { nodeId: string } | { path: string } | null {
	if (!value.startsWith("http://") && !value.startsWith("https://")) {
		return null;
	}

	const url = URL.parse(value);
	if (!url) {
		return null;
	}

	const nodeId = url.searchParams.get("nodeId");
	if (nodeId) {
		return { nodeId };
	}

	const filesPathIndex = url.pathname.indexOf(URL_FILE_LINK_PATH_MARKER);
	if (filesPathIndex < 0) {
		return null;
	}

	// A hand-typed link can hold a raw `%` (`50% off.md`) or a broken escape, which
	// `decodeURIComponent` refuses with a throw. Such a link is plain text to the caller.
	let linkPath: string;
	try {
		linkPath = decodeURIComponent(url.pathname.slice(filesPathIndex + URL_FILE_LINK_PATH_MARKER.length));
	} catch {
		return null;
	}
	return { path: `/${path_extract_segments_from(linkPath).join("/")}` };
}

export function url_path_api_keys(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/api-keys`;
}

export function url_path_chat(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/chat`;
}

export function url_path_users(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/users`;
}

export function url_path_roles(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/roles`;
}

export function url_path_plugins(args: { organizationName: string; workspaceName: string }) {
	return `/w/${args.organizationName}/${args.workspaceName}/plugins`;
}

export function url_path_plugin_page(args: {
	organizationName: string;
	workspaceName: string;
	pluginName: string;
	pageId: string;
}) {
	return `/w/${args.organizationName}/${args.workspaceName}/plugins/${args.pluginName}/pages/${args.pageId}`;
}

export function app_tenant_scope_key(args: { organizationId: string; workspaceId: string }) {
	return `${args.organizationId}::${args.workspaceId}`;
}

type OrganizationFields = {
	_id: string;
	default: boolean;
	defaultWorkspaceId?: string;
	name: string;
};

type WorkspaceFields = {
	_id: string;
	default: boolean;
	name: string;
};

/**
 * Resolve the actual organization primary workspace when the client can see it.
 * If `defaultWorkspaceId` is present but omitted from `workspaces`, the primary is hidden to this user.
 */
export function app_tenant_primary_workspace_for_organization<Workspace extends WorkspaceFields>(args: {
	organization: OrganizationFields;
	workspaces: Workspace[];
}): Workspace | null {
	if (args.organization.defaultWorkspaceId) {
		return args.workspaces.find((workspace) => workspace._id === args.organization.defaultWorkspaceId) ?? null;
	}

	return args.workspaces.find((workspace) => workspace.default) ?? null;
}

/**
 * Pick a navigable default workspace for one organization using the same rules as `organizations.list`-based routing.
 */
export function app_tenant_default_workspace_for_organization(args: {
	organization: OrganizationFields;
	workspaces: WorkspaceFields[];
}): WorkspaceFields | null {
	const workspace = app_tenant_primary_workspace_for_organization(args) ?? args.workspaces[0];
	return workspace ?? null;
}

/**
 * Resolve default organization + workspace from `organizations.list` (same flags as server-side defaults).
 */
export function app_tenant_defaults_from_organization_list(args: {
	organizations: OrganizationFields[];
	organizationIdsWorkspacesDict: Record<string, WorkspaceFields[]>;
}): { organizationName: string; workspaceName: string } | null {
	const organization = args.organizations.find((candidate) => candidate.default) ?? args.organizations[0];
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
