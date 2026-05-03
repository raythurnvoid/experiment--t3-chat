import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppTenantContextValue } from "@/lib/app-tenant-context.tsx";

const { tenantContextMock, localStorageSetterMock, useQueryMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	localStorageSetterMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: function Link(props: { to: string; className?: string; children?: ReactNode }) {
		return (
			<a href={props.to} className={props.className}>
				{props.children}
			</a>
		);
	},
	useRouterState: (args: { select: (state: { location: { pathname: string } }) => string }) =>
		args.select({ location: { pathname: "/w/team/home/files" } }),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		workspaces: {
			list: "workspaces.list",
		},
	},
}));

vi.mock("@/lib/storage.ts", () => ({
	useAppLocalStorageStateValue: (key: string) => {
		if (key === "app_state::sidebar::main_app_open") {
			return [true, localStorageSetterMock] as const;
		}

		return [false, localStorageSetterMock] as const;
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("@/components/app-hotkeys.tsx", () => ({
	AppHotkeysProvider: {
		useHotkey: vi.fn(),
	},
}));

vi.mock("@/hooks/presence-hooks.ts", () => ({
	app_presence_set_enabled: vi.fn(),
	usePresence: () => ({ roomToken: "room-token" }),
	usePresenceEnabled: () => false,
	usePresenceList: () => ({ users: [] }),
}));

vi.mock("@/components/theme-provider.tsx", () => ({
	useThemeContext: () => ({
		mode: "system",
		resolved_theme: "light",
		set_mode: vi.fn(),
	}),
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuthenticated: () => ({ userId: "user_1" }),
	},
}));

vi.mock("@/components/logo.tsx", () => ({
	Logo: function Logo(props: { className?: string }) {
		return <div className={props.className}>Logo</div>;
	},
}));

vi.mock("@/components/main-app-sidebar-account-control.tsx", () => ({
	MainAppSidebarAccountControl: function MainAppSidebarAccountControl() {
		return <div>Account</div>;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: { children?: ReactNode; className?: string; onClick?: () => void }) {
		return (
			<button type="button" className={props.className} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
}));

vi.mock("@/components/my-icon-button.tsx", () => ({
	MyIconButton: function MyIconButton(props: { children?: ReactNode; className?: string; onClick?: () => void }) {
		return (
			<button type="button" className={props.className} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
	MyIconButtonIcon: function MyIconButtonIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-hovercard.tsx", () => ({
	MyHoverCard: function MyHoverCard(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyHoverCardArrow: function MyHoverCardArrow() {
		return null;
	},
	MyHoverCardContent: function MyHoverCardContent(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

vi.mock("@/components/my-sidebar.tsx", () => ({
	MySidebar: function MySidebar(props: { children?: ReactNode; className?: string }) {
		return <aside className={props.className}>{props.children}</aside>;
	},
	MySidebarFooter: function MySidebarFooter(props: { children?: ReactNode; className?: string }) {
		return <div className={props.className}>{props.children}</div>;
	},
	MySidebarHeader: function MySidebarHeader(props: { children?: ReactNode; className?: string }) {
		return <header className={props.className}>{props.children}</header>;
	},
	MySidebarHovercardAction: function MySidebarHovercardAction(props: { children?: ReactNode; className?: string }) {
		return <div className={props.className}>{props.children}</div>;
	},
	MySidebarList: function MySidebarList(props: { children?: ReactNode; className?: string; "aria-label"?: string }) {
		return (
			<ul className={props.className} aria-label={props["aria-label"]}>
				{props.children}
			</ul>
		);
	},
	MySidebarListItem: function MySidebarListItem(props: { children?: ReactNode; className?: string }) {
		return <li className={props.className}>{props.children}</li>;
	},
	MySidebarListItemIcon: function MySidebarListItemIcon(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
	MySidebarPrimaryAction: function MySidebarPrimaryAction(props: {
		children?: ReactNode;
		className?: string;
		onClick?: () => void;
	}) {
		return (
			<button type="button" className={props.className} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
	MySidebarScrollableArea: function MySidebarScrollableArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MySidebarSection: function MySidebarSection(props: { children?: ReactNode; className?: string }) {
		return <section className={props.className}>{props.children}</section>;
	},
	MySidebarListItemPrimaryAction: function MySidebarListItemPrimaryAction(props: {
		children?: ReactNode;
		className?: string;
		onClick?: () => void;
	}) {
		return (
			<button type="button" className={props.className} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
	MySidebarListItemPrimaryActionLink: function MySidebarListItemPrimaryActionLink(props: {
		children?: ReactNode;
		className?: string;
		to: string;
	}) {
		return (
			<a href={props.to} className={props.className}>
				{props.children}
			</a>
		);
	},
	MySidebarListItemTitle: function MySidebarListItemTitle(props: { children?: ReactNode; className?: string }) {
		return <span className={props.className}>{props.children}</span>;
	},
}));

import { MainAppSidebar } from "./main-app-sidebar.tsx";

function createTenantContext() {
	return {
		membershipId: "membership_1" as AppTenantContextValue["membershipId"],
		projectId: "project_1" as AppTenantContextValue["projectId"],
		projectName: "home",
		workspaceId: "workspace_1" as AppTenantContextValue["workspaceId"],
		workspaceName: "team",
	} satisfies AppTenantContextValue;
}

function createWorkspaceList(args: { workspaceIsDefault: boolean }) {
	return {
		workspaces: [
			{
				_id: "workspace_1",
				default: args.workspaceIsDefault,
			},
		],
	};
}

describe("MainAppSidebar", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue(createTenantContext());
		useQueryMock.mockReturnValue(createWorkspaceList({ workspaceIsDefault: false }));
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("hides Users navigation in the personal workspace", () => {
		useQueryMock.mockReturnValue(createWorkspaceList({ workspaceIsDefault: true }));

		render(<MainAppSidebar />);

		expect(screen.getByText("Chat")).not.toBeNull();
		expect(screen.getByText("Files")).not.toBeNull();
		expect(screen.queryByText("Users")).toBeNull();
	});

	test("shows Users navigation in non-default workspaces", () => {
		render(<MainAppSidebar />);

		expect(screen.getByText("Users")).not.toBeNull();
	});
});
