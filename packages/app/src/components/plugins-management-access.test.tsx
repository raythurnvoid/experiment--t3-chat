/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { queryMock, mutationMock } = vi.hoisted(() => ({ queryMock: vi.fn(), mutationMock: vi.fn() }));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => queryMock(...args),
	useQueries: (queries: Record<string, unknown>) =>
		Object.fromEntries(
			Object.keys(queries).map((key) => [
				key,
				{ displayName: key === "owner_1" ? "Owner Ray" : key === "user_1" ? "Ada" : "Workspace member" },
			]),
		),
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationId: "organization_1", workspaceId: "workspace_1" }),
	},
}));
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		plugins: { list_published_plugins: "catalog" },
		plugins_access: {
			get_workspace_install_access: "workspace_access",
			get_installation_access: "installation_access",
			update_workspace_install_access: "save_workspace",
			update_installation_access: "save_installation",
		},
		organizations: { list_organization_workspace_users: "users" },
		access_control: { list_roles: "roles" },
		users: { get_anagraphic: "anagraphic" },
	},
}));

import { useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { PluginsManagementAccess } from "./plugins-management-access.tsx";

function TestAccess(props: { installation?: boolean }) {
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const plugin = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId })?.at(0);
	return (
		<PluginsManagementAccess
			membershipId={membershipId}
			organizationId={organizationId}
			workspaceId={workspaceId}
			installationId={props.installation ? (plugin?.installationId ?? undefined) : undefined}
		/>
	);
}

function mockAccess(access: {
	mode: string;
	principals: Array<{ kind: string; userId?: string; role?: string }>;
	canManageSettings?: boolean;
}) {
	queryMock.mockImplementation((query: string) => {
		if (query === "workspace_access" || query === "installation_access")
			return { canInstall: true, canManageSettings: true, organizationOwnerUserId: "owner_1", ...access };
		if (query === "catalog") return [{ installationId: "installation_1" }];
		if (query === "users") return ["owner_1", "user_1"];
		if (query === "roles") return [{ _id: "role_1", name: "Import helpers" }];
		return undefined;
	});
}

beforeEach(() => {
	queryMock.mockReset();
	mutationMock.mockReset().mockResolvedValue({ _yay: null });
	mockAccess({ mode: "owner", principals: [] });
});
afterEach(cleanup);

describe("PluginsManagementAccess", () => {
	test("saves the workspace setup list with a real person and custom role choice", async () => {
		render(<TestAccess />);
		fireEvent.click(screen.getByRole("combobox", { name: "Who can install plugins" }));
		fireEvent.click(await screen.findByRole("option", { name: "Selected people and roles" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Person or role to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Ada" }));
		fireEvent.click(screen.getByRole("button", { name: "Add to access list" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Person or role to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Import helpers" }));
		fireEvent.click(screen.getByRole("button", { name: "Add to access list" }));
		fireEvent.click(screen.getByRole("button", { name: "Save plugin access" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("save_workspace", {
				membershipId: "membership_1",
				mode: "selected",
				principals: [
					{ kind: "user", userId: "user_1" },
					{ kind: "role", role: "role_1" },
				],
			}),
		);
		expect(screen.getByText("Owner Ray (owner) always has access.")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Remove Owner Ray" })).toBeNull();
	});

	test("saves only one installation and keeps a refused edit in the form", async () => {
		mockAccess({ mode: "selected", principals: [{ kind: "user", userId: "user_1" }] });
		mutationMock.mockResolvedValue({ _nay: { message: "This role is already on 50 plugin access lists" } });
		render(<TestAccess installation />);
		fireEvent.click(screen.getByRole("combobox", { name: "Person or role to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Import helpers" }));
		fireEvent.click(screen.getByRole("button", { name: "Add to access list" }));
		fireEvent.click(screen.getByRole("button", { name: "Save plugin access" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("save_installation", {
				membershipId: "membership_1",
				installationId: "installation_1",
				mode: "selected",
				principals: [
					{ kind: "user", userId: "user_1" },
					{ kind: "role", role: "role_1" },
				],
			}),
		);
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"This role is already on 50 plugin access lists",
		);
		expect(screen.getByText("Import helpers (role)")).not.toBeNull();
	});

	test("offers default roles and saves Everybody without a run-as grant", async () => {
		mockAccess({ mode: "selected", principals: [] });
		render(<TestAccess installation />);
		fireEvent.click(screen.getByRole("combobox", { name: "Person or role to add" }));
		expect(await screen.findByRole("option", { name: "Viewer" })).not.toBeNull();
		fireEvent.keyDown(screen.getByRole("combobox", { name: "Person or role to add" }), { key: "Escape" });
		fireEvent.click(screen.getByRole("combobox", { name: "Who can manage this plugin" }));
		fireEvent.click(await screen.findByRole("option", { name: "Everybody in this workspace" }));
		expect(
			screen.getByText(
				"Every active workspace member can use this access. This does not grant permission to run as another person.",
			),
		).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Save plugin access" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("save_installation", {
				membershipId: "membership_1",
				installationId: "installation_1",
				mode: "workspace",
				principals: [],
			}),
		);
		expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty("runAs");
	});

	test("shows the 50-principal limit and does not add a 51st entry", async () => {
		mockAccess({
			mode: "selected",
			principals: Array.from({ length: 50 }, (_, index) => ({ kind: "user", userId: `member_${index}` })),
		});
		render(<TestAccess />);
		fireEvent.click(screen.getByRole("combobox", { name: "Person or role to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Ada" }));
		expect(screen.getByRole("button", { name: "Add to access list" })).toHaveProperty("disabled", true);
		expect(document.querySelectorAll("[data-plugin-principal]")).toHaveLength(50);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("keeps setup settings hidden from a member who cannot manage them", () => {
		mockAccess({ mode: "owner", principals: [], canManageSettings: false });
		render(<TestAccess />);
		expect(screen.queryByRole("region", { name: "Plugin setup access" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save plugin access" })).toBeNull();
	});
});
