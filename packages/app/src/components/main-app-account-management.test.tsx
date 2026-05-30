import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
	appConvexActionMock,
	appConvexMutationMock,
	appConvexQueryMock,
	clerkSignOutMock,
	clerkUserMock,
	getSessionsMock,
	onOpenChangeMock,
	useQueryMock,
} = vi.hoisted(() => {
	const getSessionsMock = vi.fn();

	return {
		appConvexActionMock: vi.fn(),
		appConvexMutationMock: vi.fn(),
		appConvexQueryMock: vi.fn(),
		clerkSignOutMock: vi.fn(),
		clerkUserMock: {
			externalAccounts: [],
			fullName: "Delete User",
			getSessions: getSessionsMock,
			imageUrl: "",
			primaryEmailAddress: {
				emailAddress: "delete-user@test.local",
			},
			username: null,
		},
		getSessionsMock,
		onOpenChangeMock: vi.fn(),
		useQueryMock: vi.fn(),
	};
});

type MockButton_Props = ComponentProps<"button">;
type MockInput_Props = ComponentProps<"input">;

vi.mock("@clerk/clerk-react", () => ({
	useClerk: () => ({
		signOut: clerkSignOutMock,
	}),
	useUser: () => ({
		isLoaded: true,
		user: clerkUserMock,
	}),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: function Link(props: { children?: ReactNode; onClick?: () => void; to: string }) {
		return (
			<a href={props.to} onClick={props.onClick}>
				{props.children}
			</a>
		);
	},
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => ({
			isAnonymous: false,
			isAuthenticated: true,
			isLoaded: true,
			resetAnonymousSession: vi.fn(),
			userId: "user_1",
		}),
	},
}));

vi.mock("@/components/billing/billing-account-management-panel.tsx", () => ({
	BillingAccountManagementPanel: function BillingAccountManagementPanel() {
		return <div>Billing panel</div>;
	},
}));

vi.mock("@/components/my-avatar.tsx", () => ({
	MyAvatar: function MyAvatar(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyAvatarFallback: function MyAvatarFallback(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyAvatarImage: function MyAvatarImage() {
		return null;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: MockButton_Props) {
		return <button {...props} />;
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
	MyInputControl: function MyInputControl(props: MockInput_Props) {
		return <input {...props} />;
	},
	MyInputLabel: function MyInputLabel(props: { children?: ReactNode }) {
		return <label>{props.children}</label>;
	},
}));

vi.mock("@/components/my-link.tsx", () => ({
	MyLink: function MyLink(props: {
		children?: ReactNode;
		onClick?: () => void;
		params?: { workspaceName: string; projectName: string };
		to: string;
	}) {
		const href = props.params ? `/w/${props.params.workspaceName}/${props.params.projectName}/users` : props.to;

		return (
			<a href={href} onClick={props.onClick}>
				{props.children}
			</a>
		);
	},
	MyLinkIcon: function MyLinkIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-tooltip.tsx", () => ({
	MyTooltip: function MyTooltip(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTooltipContent: function MyTooltipContent(props: { children?: ReactNode }) {
		return <div role="tooltip">{props.children}</div>;
	},
	MyTooltipTrigger: function MyTooltipTrigger(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-modal.tsx", () => ({
	MyModal: function MyModal(props: { children?: ReactNode; open: boolean }) {
		return props.open ? <div>{props.children}</div> : null;
	},
	MyModalCloseTrigger: function MyModalCloseTrigger() {
		return null;
	},
	MyModalDescription: function MyModalDescription(props: { children?: ReactNode }) {
		return <p>{props.children}</p>;
	},
	MyModalHeader: function MyModalHeader(props: { children?: ReactNode }) {
		return <header>{props.children}</header>;
	},
	MyModalFooter: function MyModalFooter(props: { children?: ReactNode }) {
		return <footer>{props.children}</footer>;
	},
	MyModalHeading: function MyModalHeading(props: { children?: ReactNode }) {
		return <h1>{props.children}</h1>;
	},
	MyModalPopover: function MyModalPopover(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalScrollableArea: function MyModalScrollableArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

vi.mock("@/components/my-tabs.tsx", () => ({
	MyTabs: function MyTabs(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsList: function MyTabsList(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsPanel: function MyTabsPanel(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsPanels: function MyTabsPanels(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsTab: function MyTabsTab(props: { children?: ReactNode }) {
		return <button type="button">{props.children}</button>;
	},
	MyTabsTabSurface: function MyTabsTabSurface(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(handler: T) => handler,
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		action: appConvexActionMock,
		mutation: appConvexMutationMock,
		query: appConvexQueryMock,
	},
	app_convex_api: {
		users: {
			delete_current_user_account: "users.delete_current_user_account",
			get_anagraphic: "users.get_anagraphic",
			list_current_user_account_deletion_blocking_workspaces:
				"users.list_current_user_account_deletion_blocking_workspaces",
		},
		workspaces: {
			delete_workspace: "workspaces.delete_workspace",
		},
	},
}));

import { app_convex_api } from "@/lib/app-convex-client.ts";

import { MainAppAccountManagement } from "./main-app-account-management.tsx";

function renderAccountManagement(args: { open?: boolean } = {}) {
	render(<MainAppAccountManagement open={args.open ?? true} onOpenChange={onOpenChangeMock} />);
}

function createBlockingWorkspace() {
	return {
		workspace: {
			_id: "workspace_1",
			description: "Team workspace for product work",
			name: "team",
		},
		defaultProject: {
			_id: "project_1",
			name: "home",
		},
	};
}

describe("MainAppAccountManagement", () => {
	beforeEach(() => {
		appConvexActionMock.mockResolvedValue({ _yay: null });
		appConvexMutationMock.mockResolvedValue({ _yay: null });
		appConvexQueryMock.mockResolvedValue([]);
		clerkSignOutMock.mockResolvedValue(undefined);
		getSessionsMock.mockResolvedValue([]);
		useQueryMock.mockReturnValue({
			displayName: "Delete User",
			email: "delete-user@test.local",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("unmounts the account management modal when closed", () => {
		renderAccountManagement({ open: false });

		expect(screen.queryByText("Manage account")).toBeNull();
		expect(useQueryMock).not.toHaveBeenCalled();
	});

	test("renders Transfer ownership links when account deletion is blocked by owned workspaces", async () => {
		appConvexQueryMock.mockResolvedValue([createBlockingWorkspace()]);

		renderAccountManagement();

		fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

		expect(await screen.findByText("Resolve owned workspaces")).not.toBeNull();
		const transferOwnershipLink = await screen.findByRole("link", { name: "Transfer ownership" });
		expect(transferOwnershipLink.getAttribute("href")).toBe("/w/team/home/users");
		expect(screen.getByText("team")).not.toBeNull();
		expect(screen.getByText("Team workspace for product work")).not.toBeNull();
		expect(appConvexActionMock).not.toHaveBeenCalled();

		fireEvent.click(transferOwnershipLink);

		expect(onOpenChangeMock).toHaveBeenCalledWith(false);
	});

	test("keeps resolver submit disabled until every workspace has a valid resolution", async () => {
		appConvexQueryMock.mockResolvedValue([createBlockingWorkspace()]);

		renderAccountManagement();

		fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

		const submitButton = (await screen.findByRole("button", {
			name: "Confirm account deletion",
		})) as HTMLButtonElement;
		expect(submitButton.disabled).toBe(true);
		expect(
			screen.getByText(
				"Before you can delete your account, transfer ownership of each workspace or confirm deleting the workspace.",
			),
		).not.toBeNull();

		fireEvent.click(screen.getByLabelText("Delete workspace and data"));

		expect(
			(screen.getByRole("button", { name: "Confirm account deletion" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});

	test("deletes a workspace before account deletion", async () => {
		const blockingWorkspace = createBlockingWorkspace();
		appConvexQueryMock.mockResolvedValueOnce([blockingWorkspace]).mockResolvedValueOnce([]);

		renderAccountManagement();

		fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
		await screen.findByText("Resolve owned workspaces");
		fireEvent.click(screen.getByLabelText("Delete workspace and data"));
		fireEvent.click(screen.getByRole("button", { name: "Confirm account deletion" }));

		await waitFor(() => {
			expect(appConvexMutationMock).toHaveBeenCalledWith(app_convex_api.workspaces.delete_workspace, {
				workspaceId: blockingWorkspace.workspace._id,
			});
		});
		await waitFor(() => {
			expect(appConvexActionMock).toHaveBeenCalledWith(app_convex_api.users.delete_current_user_account, {});
		});
	});

	test("leaves resolver open when a workspace resolution mutation fails", async () => {
		appConvexQueryMock.mockResolvedValue([createBlockingWorkspace()]);
		appConvexMutationMock.mockResolvedValue({
			_nay: {
				message: "Workspace quota reached",
			},
		});

		renderAccountManagement();

		fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
		await screen.findByText("Resolve owned workspaces");
		fireEvent.click(screen.getByLabelText("Delete workspace and data"));
		fireEvent.click(screen.getByRole("button", { name: "Confirm account deletion" }));

		await waitFor(() => {
			expect(appConvexMutationMock).toHaveBeenCalled();
		});
		expect(appConvexActionMock).not.toHaveBeenCalled();
		expect(screen.getByText("Resolve owned workspaces")).not.toBeNull();
	});

	test("calls the delete action when no owned workspaces block account deletion", async () => {
		renderAccountManagement();

		fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
		fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

		await waitFor(() => {
			expect(appConvexActionMock).toHaveBeenCalledWith(app_convex_api.users.delete_current_user_account, {});
		});
		expect(onOpenChangeMock).toHaveBeenCalledWith(false);
		expect(clerkSignOutMock).toHaveBeenCalled();
	});
});
