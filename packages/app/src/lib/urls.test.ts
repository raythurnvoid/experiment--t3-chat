import { describe, expect, test } from "vitest";

import {
	app_tenant_default_workspace_for_organization,
	app_tenant_defaults_from_organization_list,
	app_tenant_primary_workspace_for_organization,
	url_parse_file_link,
	url_path_file_by_node_id,
} from "./urls.ts";

describe("url_parse_file_link", () => {
	test("reads back the node id from a link built by url_path_file_by_node_id", () => {
		const link = url_path_file_by_node_id({ organizationName: "acme", workspaceName: "main", nodeId: "k57abc" });

		expect(url_parse_file_link(`http://localhost:5173${link}`)).toEqual({ nodeId: "k57abc" });
	});

	test("keeps other search params out of the way", () => {
		expect(
			url_parse_file_link("https://app.test/w/acme/main/files?view=plain_text_editor&nodeId=k57abc&q=api"),
		).toEqual({
			nodeId: "k57abc",
		});
	});

	test("reads the readable splat form as an absolute path", () => {
		expect(url_parse_file_link("https://app.test/w/acme/main/files/docs/api.md")).toEqual({ path: "/docs/api.md" });
	});

	test("decodes percent-encoded segments", () => {
		expect(url_parse_file_link("https://app.test/w/acme/main/files/my%20docs/api.md")).toEqual({
			path: "/my docs/api.md",
		});
	});

	test("prefers the node id when a link carries both shapes", () => {
		expect(url_parse_file_link("https://app.test/w/acme/main/files/docs/api.md?nodeId=k57abc")).toEqual({
			nodeId: "k57abc",
		});
	});

	test("returns null for plain text, bare paths and non-files app links", () => {
		expect(url_parse_file_link("/docs/api.md")).toBeNull();
		// A raw `%` or a broken escape cannot be decoded, so the link is plain text, not a throw.
		expect(url_parse_file_link("https://app.test/w/acme/main/files/50% off.md")).toBeNull();
		expect(url_parse_file_link("https://app.test/w/acme/main/files/%ZZ")).toBeNull();
		expect(url_parse_file_link("api.md")).toBeNull();
		expect(url_parse_file_link("https://app.test/w/acme/main/chat")).toBeNull();
		expect(url_parse_file_link("not a url at all")).toBeNull();
	});
});

describe("app_tenant_primary_workspace_for_organization", () => {
	test("returns the visible organization defaultWorkspaceId match", () => {
		const organization = {
			_id: "org_1",
			name: "acme",
			default: false,
			defaultWorkspaceId: "workspace_home",
		};

		const primary = app_tenant_primary_workspace_for_organization({
			organization,
			workspaces: [
				{ _id: "workspace_side", name: "side", default: false },
				{ _id: "workspace_home", name: "home", default: true },
			],
		});

		expect(primary?._id).toBe("workspace_home");
	});

	test("returns null when organization.defaultWorkspaceId is hidden from the visible workspace list", () => {
		const primary = app_tenant_primary_workspace_for_organization({
			organization: {
				_id: "org_1",
				name: "acme",
				default: false,
				defaultWorkspaceId: "workspace_home",
			},
			workspaces: [{ _id: "workspace_side", name: "side", default: false }],
		});

		expect(primary).toBeNull();
	});

	test("falls back to workspace.default when organization.defaultWorkspaceId is absent", () => {
		const primary = app_tenant_primary_workspace_for_organization({
			organization: {
				_id: "org_1",
				name: "acme",
				default: false,
			},
			workspaces: [
				{ _id: "workspace_side", name: "side", default: false },
				{ _id: "workspace_home", name: "home", default: true },
			],
		});

		expect(primary?._id).toBe("workspace_home");
	});
});

describe("app_tenant_default_workspace_for_organization", () => {
	test("keeps the existing navigable fallback when the true primary is hidden", () => {
		const workspace = app_tenant_default_workspace_for_organization({
			organization: {
				_id: "org_1",
				name: "acme",
				default: false,
				defaultWorkspaceId: "workspace_home",
			},
			workspaces: [
				{ _id: "workspace_alpha", name: "alpha", default: false },
				{ _id: "workspace_zeta", name: "zeta", default: false },
			],
		});

		expect(workspace?._id).toBe("workspace_alpha");
	});
});

describe("app_tenant_defaults_from_organization_list", () => {
	test("prefers the default organization and its primary workspace from the loaded list", () => {
		const defaults = app_tenant_defaults_from_organization_list({
			organizations: [
				{ _id: "org_1", name: "personal", default: true, defaultWorkspaceId: "workspace_1" },
				{ _id: "org_2", name: "team", default: false, defaultWorkspaceId: "workspace_2" },
			],
			organizationIdsWorkspacesDict: {
				org_1: [{ _id: "workspace_1", name: "home", default: true }],
				org_2: [{ _id: "workspace_2", name: "docs", default: true }],
			},
		});

		expect(defaults).toEqual({
			organizationName: "personal",
			workspaceName: "home",
		});
	});

	test("falls back to the first visible organization when no organization is marked default", () => {
		const defaults = app_tenant_defaults_from_organization_list({
			organizations: [
				{ _id: "org_1", name: "acme", default: false, defaultWorkspaceId: "workspace_1" },
				{ _id: "org_2", name: "team", default: false, defaultWorkspaceId: "workspace_2" },
			],
			organizationIdsWorkspacesDict: {
				org_1: [{ _id: "workspace_1", name: "alpha", default: true }],
				org_2: [{ _id: "workspace_2", name: "docs", default: true }],
			},
		});

		expect(defaults).toEqual({
			organizationName: "acme",
			workspaceName: "alpha",
		});
	});
});
