/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tenantContextMock, useQueryMock } = vi.hoisted(() => ({
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
	PluginsGalleryCard: function PluginsGalleryCard() {
		return <div>Plugin card</div>;
	},
}));

import { Route } from "./index.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

function setQueries(canManagePlugins: boolean) {
	useQueryMock.mockImplementation((query: string) => {
		switch (query) {
			case "organizations.list":
				return {
					workspaceIdsPermissionsDict: {
						workspace_1: canManagePlugins ? ["workspace.plugins.manage"] : ["content.read"],
					},
				};
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
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("shows the permission message without plugin management", () => {
		setQueries(false);

		render(<PageComponent />);

		expect(screen.getByRole("alert").textContent).toContain(
			"You don't have permission to manage plugins in this workspace.",
		);
		expect(screen.queryByText("No plugins published yet.")).toBeNull();
		expect(screen.getByText("Publisher")).not.toBeNull();
		expect(useQueryMock).toHaveBeenCalledWith("plugins.list_installations", "skip");
	});

	test("shows the empty catalog with plugin management", () => {
		setQueries(true);

		render(<PageComponent />);

		expect(screen.getByText("No plugins published yet.")).not.toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
