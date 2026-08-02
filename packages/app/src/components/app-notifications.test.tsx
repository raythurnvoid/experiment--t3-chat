/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mutationMock, useQueriesMock, useQueryMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	useQueriesMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

vi.mock("convex/react", () => ({
	useQueries: (...args: unknown[]) => useQueriesMock(...args),
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceName: "home",
		}),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		access_control: {
			get_current_user_workspace_permission: "access_control.get_current_user_workspace_permission",
		},
		activities: {
			archive_activity: "activities.archive_activity",
			archive_all_activities: "activities.archive_all_activities",
			list_recent: "activities.list_recent",
		},
		notifications: {
			archive_all_notifications: "notifications.archive_all_notifications",
			archive_notification: "notifications.archive_notification",
			list_current_notifications: "notifications.list_current_notifications",
		},
		organizations: {
			list: "organizations.list",
		},
		users: {
			get_anagraphic: "users.get_anagraphic",
		},
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("@/components/my-popover.tsx", () => ({
	MyPopover: function MyPopover(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyPopoverContent: function MyPopoverContent(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyPopoverTrigger: function MyPopoverTrigger(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: ComponentPropsWithRef<"button"> & { variant?: string }) {
		const { children, variant: _variant, ...rest } = props;
		return (
			<button type="button" {...rest}>
				{children}
			</button>
		);
	},
}));

vi.mock("@/components/my-icon-button.tsx", () => ({
	MyIconButton: function MyIconButton(
		props: ComponentPropsWithRef<"button"> & { tooltip?: string; variant?: string },
	) {
		const { children, tooltip: _tooltip, variant: _variant, ...rest } = props;
		return (
			<button type="button" {...rest}>
				{children}
			</button>
		);
	},
	MyIconButtonIcon: function MyIconButtonIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-icon.tsx", () => ({
	MyIcon: function MyIcon(props: { children?: ReactNode; className?: string }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

import { AppNotifications } from "./app-notifications.tsx";

describe("AppNotifications", () => {
	beforeEach(() => {
		useQueriesMock.mockReturnValue({});
		useQueryMock.mockImplementation((query: unknown) => {
			if (query === "notifications.list_current_notifications") return [];
			if (query === "activities.list_recent") {
				return [
					{
						_id: "activity_1",
						_creationTime: Date.UTC(2026, 7, 2, 12, 0),
						status: "failed",
						title: "Export report",
						errorMessage: "Export failed",
						targets: [],
						finishedAt: Date.UTC(2026, 7, 2, 12, 1),
					},
				];
			}
			if (query === "organizations.list") {
				return { organizations: [], organizationIdsWorkspacesDict: {} };
			}
			if (query === "access_control.get_current_user_workspace_permission") return false;
			return undefined;
		});
		mutationMock.mockResolvedValue({ _yay: null });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("keeps activity dismiss controls focusable but blocks them without content write", () => {
		render(<AppNotifications />);

		const dismissAll = screen.getByRole("button", { name: "Dismiss all" });
		const dismissActivity = screen.getByRole("button", { name: "Dismiss Export report" });

		for (const button of [dismissAll, dismissActivity]) {
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.hasAttribute("disabled")).toBe(false);
			expect(button.classList.contains("MyButton-state-disabled")).toBe(true);

			const reasonId = button.getAttribute("aria-describedby");
			expect(reasonId).not.toBeNull();
			expect(document.getElementById(reasonId!)?.textContent).toContain("Edit workspace content");
			button.focus();
			expect(document.activeElement).toBe(button);
			fireEvent.click(button);
		}

		expect(mutationMock).not.toHaveBeenCalled();
	});
});
