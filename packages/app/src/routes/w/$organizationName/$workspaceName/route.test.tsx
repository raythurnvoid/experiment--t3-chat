/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_unsaved_text_capture, files_unsaved_text_set_user } from "@/lib/files-unsaved-text.ts";

const { authMock, membershipMock, fileNodeMock, openSignInMock, paramsMock, setWorkspaceFocusTargetMock } = vi.hoisted(
	() => ({
		authMock: vi.fn(),
		membershipMock: vi.fn(),
		fileNodeMock: vi.fn(),
		openSignInMock: vi.fn(),
		paramsMock: vi.fn(),
		setWorkspaceFocusTargetMock: vi.fn(),
	}),
);

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
	Navigate: function Navigate() {
		return null;
	},
	useMatch: () => true,
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
	useQuery: (query: string, args: unknown) =>
		query === "files_tree.get_file_node_for_membership" ? fileNodeMock(args) : membershipMock(),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		organizations: {
			get_membership_by_organization_workspace_name: "organizations.get_membership_by_organization_workspace_name",
		},
		files_tree: { get_file_node_for_membership: "files_tree.get_file_node_for_membership" },
	},
}));

vi.mock("@/lib/files.ts", () => ({ files_download_blob: vi.fn() }));

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
		files_unsaved_text_set_user("user_1");
		paramsMock.mockReturnValue({ organizationName: "team", workspaceName: "home" });
		membershipMock.mockReturnValue(undefined);
		fileNodeMock.mockReturnValue(null);
		authMock.mockReturnValue({ isAnonymous: false, userId: "user_1" });
	});

	afterEach(() => {
		cleanup();
		files_unsaved_text_set_user(null);
		vi.clearAllMocks();
		vi.unstubAllGlobals();
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

	test.each([false, true])(
		"keeps local text reachable when workspace access ends (anonymous: %s)",
		async (isAnonymous) => {
			authMock.mockReturnValue({ isAnonymous, userId: "user_1" });
			membershipMock.mockReturnValue({
				_id: "membership_1",
				organizationId: "organization_1",
				workspaceId: "workspace_1",
			});
			const view = render(<PageComponent />);
			files_unsaved_text_capture({
				userId: "user_1",
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				target: { kind: "saved", id: "file_1" as app_convex_Id<"files_nodes"> },
				documentId: "editor_1",
				rootKind: "plain_text",
				text: "text from the closed editor",
				reason: "permission",
			});
			membershipMock.mockReturnValue(null);
			view.rerender(<PageComponent />);
			expect(screen.queryByText("Sidebar")).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "Unsaved text (1)" }));
			expect(
				(screen.getByRole("textbox", { name: "Unsaved text for Unavailable file" }) as HTMLTextAreaElement).value,
			).toBe("text from the closed editor");
			expect(fileNodeMock).toHaveBeenCalledWith({ membershipId: "membership_1", fileNodeId: "file_1" });
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { clipboard: { writeText } });
			fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
			await waitFor(() => expect(writeText).toHaveBeenCalledWith("text from the closed editor"));
		},
	);

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
