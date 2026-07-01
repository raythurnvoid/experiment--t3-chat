import { describe, expect, test } from "vitest";

import {
	app_tenant_default_workspace_for_organization,
	app_tenant_defaults_from_organization_list,
	app_tenant_primary_workspace_for_organization,
} from "./urls.ts";

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
