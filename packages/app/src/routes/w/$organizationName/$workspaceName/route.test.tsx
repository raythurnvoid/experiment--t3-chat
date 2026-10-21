/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, membershipMock, openSignInMock, paramsMock, setWorkspaceFocusTargetMock } = vi.hoisted(() => ({
	authMock: vi.fn(),
	membershipMock: vi.fn(),
	openSignInMock: vi.fn(),
	paramsMock: vi.fn(),
	setWorkspaceFocusTargetMock: vi.fn(),
}));

vi.mock("@clerk/clerk-react", () => ({
	useClerk: () => ({ openSignIn: openSignInMock }),
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => authMock(),
	},
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({
		options,
		useParams: () => paramsMock(),
	}),
	Outlet: function Outlet() {
		return (
			<main>
				Workspace page
				<button type="button">Workspace action</button>
			</main>
		);
	},
}));

vi.mock("convex/react", () => ({
	useQuery: () => membershipMock(),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		organizations: {
			get_membership_by_organization_workspace_name: "organizations.get_membership_by_organization_workspace_name",
		},
	},
}));

vi.mock("@/components/main-app-header.tsx", () => ({
	MainAppHeader: function MainAppHeader() {
		return (
			<>
				<header>
					Header
					<button type="button">Header action</button>
				</header>
				{createPortal(<button type="button">Header portal action</button>, document.body)}
			</>
		);
	},
}));

vi.mock("@/components/main-app-sidebar.tsx", () => ({
	MainAppSidebar: function MainAppSidebar() {
		return <aside>Sidebar</aside>;
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: function AppTenantProvider(props: { children: ReactNode }) {
		return props.children;
	},
}));

vi.mock("@/components/plugins-publish-session.tsx", () => ({
	PluginsPublishSessionProvider: {
		useContext: () => ({ setWorkspaceFocusTarget: setWorkspaceFocusTargetMock }),
	},
}));

import { Route } from "./route.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

describe("RouteTenantOrganizationWorkspaceLayout", () => {
	beforeEach(() => {
		paramsMock.mockReturnValue({ organizationName: "team", workspaceName: "home" });
		membershipMock.mockReturnValue(undefined);
		authMock.mockReturnValue({ isAnonymous: false });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("moves loading-target focus to the loaded workspace target", () => {
		const view = render(<PageComponent />);
		const loading = screen.getByRole("status", { name: "Organization loading" });
		loading.focus();

		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		view.rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("region", { name: "team/home workspace content" }));
	});

	test("keeps transferred focus when loaded content is replaced by denied state", () => {
		const view = render(<PageComponent />);
		screen.getByRole("status", { name: "Organization loading" }).focus();

		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		view.rerender(<PageComponent />);
		expect(document.activeElement).toBe(screen.getByRole("region", { name: "team/home workspace content" }));

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);
		expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Organization access denied" }));
	});

	test("keeps loading-target focus on the denied replacement", () => {
		const view = render(<PageComponent />);
		const loading = screen.getByRole("status", { name: "Organization loading" });
		loading.focus();

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Organization access denied" }));
	});

	test("moves child focus to the denied replacement when access ends", () => {
		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		const view = render(<PageComponent />);
		screen.getByRole("button", { name: "Workspace action" }).focus();

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Organization access denied" }));
	});

	test("moves header focus to the denied replacement when access ends", () => {
		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		const view = render(<PageComponent />);
		screen.getByRole("button", { name: "Header action" }).focus();

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Organization access denied" }));
	});

	test("moves workspace portal focus to the denied replacement when access ends", () => {
		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		const view = render(<PageComponent />);
		screen.getByRole("button", { name: "Header portal action" }).focus();

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("alert", { name: "Organization access denied" }));
	});

	test("shows log in instead of denied to a logged-out visitor and returns to the same URL without the hash", () => {
		window.history.replaceState(null, "", "/w/team/home/files?x=1#top");
		authMock.mockReturnValue({ isAnonymous: true });
		const view = render(<PageComponent />);
		screen.getByRole("status", { name: "Organization loading" }).focus();

		membershipMock.mockReturnValue(null);
		view.rerender(<PageComponent />);

		expect(screen.queryByRole("alert", { name: "Organization access denied" })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("main", { name: "Workspace log in" }));

		fireEvent.click(screen.getByRole("button", { name: "Log in" }));

		// Clerk finishes the sign-in only after a full page load, and a hash-only change does not reload.
		const sameUrl = expect.stringMatching(/\/w\/team\/home\/files\?x=1$/);
		expect(openSignInMock).toHaveBeenCalledWith({ forceRedirectUrl: sameUrl, signUpForceRedirectUrl: sameUrl });
	});

	test("keeps the workspace open for an anonymous member", () => {
		authMock.mockReturnValue({ isAnonymous: true });
		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		render(<PageComponent />);

		expect(screen.getByRole("region", { name: "team/home workspace content" })).toBeTruthy();
	});

	test("does not move focus when the user picked another target during loading", () => {
		const view = render(
			<>
				<button type="button">Destination action</button>
				<PageComponent />
			</>,
		);
		const loading = screen.getByRole("status", { name: "Organization loading" });
		const destination = screen.getByRole("button", { name: "Destination action" });
		loading.focus();
		destination.focus();

		membershipMock.mockReturnValue({
			_id: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
		});
		view.rerender(
			<>
				<button type="button">Destination action</button>
				<PageComponent />
			</>,
		);

		expect(document.activeElement).toBe(destination);
	});
});
