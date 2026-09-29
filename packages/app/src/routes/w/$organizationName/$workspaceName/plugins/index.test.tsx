/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { managementAccessMock, tenantContextMock, useQueryMock } = vi.hoisted(() => ({
	managementAccessMock: vi.fn(),
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		organizations: { list: "organizations.list" },
		plugins: {
			list_installations: "plugins.list_installations",
			list_published_plugins: "plugins.list_published_plugins",
		},
	},
}));

vi.mock("@/components/plugins-header-breadcrumb.tsx", () => ({
	PluginsHeaderBreadcrumb: function PluginsHeaderBreadcrumb() {
		return <div>Breadcrumb</div>;
	},
}));

vi.mock("@/components/plugins-management-access.tsx", () => ({
	PluginsManagementAccess: managementAccessMock,
}));

vi.mock("@/components/my-link.tsx", () => ({
	MyLink: function MyLink(props: { children?: ReactNode }) {
		return <a href="/publisher">{props.children}</a>;
	},
	MyLinkIcon: function MyLinkIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-input.tsx", () => ({
	MyInput: function MyInput(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyInputArea: function MyInputArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyInputBackground: function MyInputBackground() {
		return null;
	},
	MyInputBox: function MyInputBox() {
		return null;
	},
	MyInputControl: function MyInputControl(props: ComponentProps<"input">) {
		return <input {...props} />;
	},
	MyInputIcon: function MyInputIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/plugins-gallery-card.tsx", () => ({
	PluginsGalleryCard: function PluginsGalleryCard(props: { displayName: string; installed: boolean }) {
		return (
			<div>
				{props.displayName}
				{props.installed ? " — Installed" : ""}
			</div>
		);
	},
}));

import { Route } from "./index.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

function setQueries() {
	useQueryMock.mockImplementation((query: string) => {
		switch (query) {
			case "plugins.list_installations":
			case "plugins.list_published_plugins":
				return [];
			default:
				return undefined;
		}
	});
}

describe("RoutePlugins", () => {
	beforeEach(() => {
		managementAccessMock.mockReturnValue(null);
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "organization_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("shows the catalog without a broad plugin role permission", () => {
		setQueries();

		render(<PageComponent />);

		expect(screen.getByText("No plugins published yet.")).not.toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("Publisher")).not.toBeNull();
		expect(useQueryMock).not.toHaveBeenCalledWith("plugins.list_installations", { membershipId: "membership_1" });
		expect(useQueryMock).toHaveBeenCalledWith("plugins.list_published_plugins", { membershipId: "membership_1" });
	});

	test("shows setup access in the default workspace", () => {
		setQueries();
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "organization_1",
			organizationName: "personal",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
		managementAccessMock.mockImplementation(() => (
			<section aria-label="Plugin setup access">
				<h2>Plugin setup access</h2>
			</section>
		));

		render(<PageComponent />);

		expect(
			screen.queryByRole("region", { name: "Plugin setup access" }),
			"primary workspace must expose plugin setup settings",
		).not.toBeNull();
		expect(managementAccessMock.mock.calls[0]?.[0]).toEqual({
			membershipId: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
	});

	test("shows installed state from the public catalog for a member without management", () => {
		useQueryMock.mockImplementation((query: string) =>
			query === "plugins.list_published_plugins"
				? [
						{
							pluginVersionId: "version_1",
							name: "importer",
							displayName: "Importer",
							description: "Outside files",
							version: "1.0.0",
							publisherDisplayName: "Publisher",
							reviewStatus: "passed",
							installationId: "installation_1",
							canInstall: false,
							canManage: false,
						},
					]
				: undefined,
		);
		render(<PageComponent />);
		expect(screen.getByText("Importer — Installed")).not.toBeNull();
		expect(useQueryMock.mock.calls.some((call) => call[0] === "plugins.list_installations")).toBe(false);
	});
});
