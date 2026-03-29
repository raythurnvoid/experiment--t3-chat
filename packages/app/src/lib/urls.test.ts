import { describe, expect, test } from "vitest";

import {
	app_tenant_default_project_for_workspace,
	app_tenant_defaults_from_workspace_list,
	app_tenant_primary_project_for_workspace,
} from "./urls.ts";

describe("app_tenant_primary_project_for_workspace", () => {
	test("returns the visible workspace defaultProjectId match", () => {
		const workspace = {
			_id: "ws_1",
			name: "acme",
			default: false,
			defaultProjectId: "proj_home",
		};

		const primary = app_tenant_primary_project_for_workspace({
			workspace,
			projects: [
				{ _id: "proj_side", name: "side", default: false },
				{ _id: "proj_home", name: "home", default: true },
			],
		});

		expect(primary?._id).toBe("proj_home");
	});

	test("returns null when workspace.defaultProjectId is hidden from the visible project list", () => {
		const primary = app_tenant_primary_project_for_workspace({
			workspace: {
				_id: "ws_1",
				name: "acme",
				default: false,
				defaultProjectId: "proj_home",
			},
			projects: [{ _id: "proj_side", name: "side", default: false }],
		});

		expect(primary).toBeNull();
	});

	test("falls back to project.default when workspace.defaultProjectId is absent", () => {
		const primary = app_tenant_primary_project_for_workspace({
			workspace: {
				_id: "ws_1",
				name: "acme",
				default: false,
			},
			projects: [
				{ _id: "proj_side", name: "side", default: false },
				{ _id: "proj_home", name: "home", default: true },
			],
		});

		expect(primary?._id).toBe("proj_home");
	});
});

describe("app_tenant_default_project_for_workspace", () => {
	test("keeps the existing navigable fallback when the true primary is hidden", () => {
		const project = app_tenant_default_project_for_workspace({
			workspace: {
				_id: "ws_1",
				name: "acme",
				default: false,
				defaultProjectId: "proj_home",
			},
			projects: [
				{ _id: "proj_alpha", name: "alpha", default: false },
				{ _id: "proj_zeta", name: "zeta", default: false },
			],
		});

		expect(project?._id).toBe("proj_alpha");
	});
});

describe("app_tenant_defaults_from_workspace_list", () => {
	test("prefers the default workspace and its primary project from the loaded list", () => {
		const defaults = app_tenant_defaults_from_workspace_list({
			workspaces: [
				{ _id: "ws_1", name: "personal", default: true, defaultProjectId: "proj_1" },
				{ _id: "ws_2", name: "team", default: false, defaultProjectId: "proj_2" },
			],
			workspaceIdsProjectsDict: {
				ws_1: [{ _id: "proj_1", name: "home", default: true }],
				ws_2: [{ _id: "proj_2", name: "docs", default: true }],
			},
		});

		expect(defaults).toEqual({
			workspaceName: "personal",
			projectName: "home",
		});
	});

	test("falls back to the first visible workspace when no workspace is marked default", () => {
		const defaults = app_tenant_defaults_from_workspace_list({
			workspaces: [
				{ _id: "ws_1", name: "acme", default: false, defaultProjectId: "proj_1" },
				{ _id: "ws_2", name: "team", default: false, defaultProjectId: "proj_2" },
			],
			workspaceIdsProjectsDict: {
				ws_1: [{ _id: "proj_1", name: "alpha", default: true }],
				ws_2: [{ _id: "proj_2", name: "docs", default: true }],
			},
		});

		expect(defaults).toEqual({
			workspaceName: "acme",
			projectName: "alpha",
		});
	});
});
