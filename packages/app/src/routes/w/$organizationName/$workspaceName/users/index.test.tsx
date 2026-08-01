/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { access_control_SYSTEM_ROLE_MATRIX } from "../../../../../../shared/access-control.ts";

const { tenantContextMock, authMock, useQueryMock, useQueriesMock, mutationMock, toastMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	authMock: vi.fn(),
	useQueryMock: vi.fn(),
	useQueriesMock: vi.fn(),
	mutationMock: vi.fn(),
	toastMock: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useQueries: (...args: unknown[]) => useQueriesMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => authMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		organizations: {
			list: "organizations.list",
			list_organization_workspace_users: "organizations.list_organization_workspace_users",
			invite_user_to_organization_workspace: "organizations.invite_user_to_organization_workspace",
			remove_user_from_organization: "organizations.remove_user_from_organization",
		},
		users: { get_anagraphic: "users.get_anagraphic" },
		access_control: {
			list_roles: "access_control.list_roles",
			get_current_user_role: "access_control.get_current_user_role",
			get_current_user_organization_permission: "access_control.get_current_user_organization_permission",
			get_organization_workspace_user_role: "access_control.get_organization_workspace_user_role",
			set_user_role: "access_control.set_user_role",
			transfer_organization_ownership: "access_control.transfer_organization_ownership",
		},
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("sonner", () => ({
	toast: toastMock,
}));

vi.mock("@/components/my-avatar.tsx", () => ({
	MyAvatar: function MyAvatar(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
	MyAvatarImage: function MyAvatarImage() {
		return null;
	},
	MyAvatarFallback: function MyAvatarFallback(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

vi.mock("@/components/my-modal.tsx", () => ({
	MyModal: function MyModal(props: { open?: boolean; children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyModalTrigger: function MyModalTrigger(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyModalPopover: function MyModalPopover() {
		return null;
	},
	MyModalHeader: function MyModalHeader(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalHeading: function MyModalHeading(props: { children?: ReactNode }) {
		return <h2>{props.children}</h2>;
	},
	MyModalDescription: function MyModalDescription(props: { children?: ReactNode }) {
		return <p>{props.children}</p>;
	},
	MyModalCloseTrigger: function MyModalCloseTrigger() {
		return null;
	},
}));

vi.mock("@/components/my-tooltip.tsx", () => ({
	MyTooltip: function MyTooltip(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyTooltipTrigger: function MyTooltipTrigger(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyTooltipContent: function MyTooltipContent(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

// The real select portals its list and only mounts it when open. The stand-in keeps every option in
// the DOM as a button, so a test can pick one without driving Ariakit.
vi.mock("@/components/my-select.tsx", async () => {
	const { createContext, useContext } = await import("react");
	const SelectContext = createContext<(value: string) => void>(() => {});

	return {
		MySelect: function MySelect(props: { setValue?: (value: string) => void; children?: ReactNode }) {
			return <SelectContext.Provider value={props.setValue ?? (() => {})}>{props.children}</SelectContext.Provider>;
		},
		MySelectTrigger: function MySelectTrigger(props: { children?: ReactNode }) {
			return <>{props.children}</>;
		},
		MySelectPopover: function MySelectPopover(props: { children?: ReactNode }) {
			return <>{props.children}</>;
		},
		MySelectPopoverScrollableArea: function MySelectPopoverScrollableArea(props: { children?: ReactNode }) {
			return <>{props.children}</>;
		},
		MySelectPopoverContent: function MySelectPopoverContent(props: { children?: ReactNode }) {
			return <>{props.children}</>;
		},
		MySelectItem: function MySelectItem(props: { value?: string; children?: ReactNode }) {
			const setValue = useContext(SelectContext);
			return (
				<button type="button" data-select-option={props.value} onClick={() => setValue(props.value ?? "")}>
					{props.children}
				</button>
			);
		},
		MySelectItemIndicator: function MySelectItemIndicator() {
			return null;
		},
		MySelectOpenIndicator: function MySelectOpenIndicator() {
			return null;
		},
	};
});

import { Route } from "./index.tsx";

const ORGANIZATION_ID = "organization_1";
const DEFAULT_WORKSPACE_ID = "workspace_default";
const OTHER_WORKSPACE_ID = "workspace_other";
const SELF_USER_ID = "user_self";
const OWNER_USER_ID = "user_owner";
const TARGET_USER_ID = "user_target";

/**
 * Everything an admin holds. The one permission missing is billing, which only the owner has.
 *
 * Read from the matrix, never typed out again. A copy of this list went stale when file sharing
 * made `content.permissions.manage` enforced and gave it to admins: the fake caller was then an
 * admin missing one admin permission, so the page correctly stopped offering the Admin role and two
 * tests failed over a change that was right.
 */
const ADMIN_PERMISSIONS = [...access_control_SYSTEM_ROLE_MATRIX.admin.permissions];

const BILLING_ROLE = {
	_id: "role_billing",
	name: "Billing manager",
	description: "Pays the bills",
	permissions: ["organization.billing.manage"],
	assignmentCount: 0,
	updatedAt: 0,
};

const EDITOR_ROLE = {
	_id: "role_editor",
	name: "Editor",
	description: "Writes files",
	permissions: ["content.read", "content.write"],
	assignmentCount: 0,
	updatedAt: 0,
};

function setQueries(args?: {
	workspaceId?: string;
	callerPermissions?: string[] | "all";
	otherWorkspacePermissions?: string[] | "all";
	organizationMembersManage?: boolean | undefined;
	customRoles?: unknown[];
}) {
	const workspaceId = args?.workspaceId ?? DEFAULT_WORKSPACE_ID;

	tenantContextMock.mockReturnValue({
		membershipId: "membership_1",
		organizationId: ORGANIZATION_ID,
		organizationName: "qa-perm",
		workspaceId,
		workspaceName: workspaceId === DEFAULT_WORKSPACE_ID ? "home" : "team",
	});

	useQueryMock.mockImplementation((fn: string) => {
		switch (fn) {
			case "organizations.list":
				return {
					organizations: [
						{ _id: ORGANIZATION_ID, name: "qa-perm", default: false, defaultWorkspaceId: DEFAULT_WORKSPACE_ID },
					],
					organizationIdsWorkspacesDict: {
						[ORGANIZATION_ID]: [
							{ _id: DEFAULT_WORKSPACE_ID, name: "home", default: true },
							{ _id: OTHER_WORKSPACE_ID, name: "team", default: false },
						],
					},
					workspaceIdsPermissionsDict: {
						[DEFAULT_WORKSPACE_ID]: args?.callerPermissions ?? ADMIN_PERMISSIONS,
						[OTHER_WORKSPACE_ID]: args?.otherWorkspacePermissions ?? args?.callerPermissions ?? ADMIN_PERMISSIONS,
					},
				};
			case "organizations.list_organization_workspace_users":
				return [OWNER_USER_ID, SELF_USER_ID, TARGET_USER_ID];
			case "access_control.list_roles":
				return args?.customRoles ?? [];
			case "access_control.get_current_user_role":
				return { kind: "system", role: "admin" };
			case "access_control.get_current_user_organization_permission":
				return args?.organizationMembersManage ?? true;
			default:
				return undefined;
		}
	});

	useQueriesMock.mockImplementation((props: Record<string, { query: string }>) =>
		Object.fromEntries(
			Object.entries(props).map(([userId, entry]) => {
				if (entry.query === "users.get_anagraphic") {
					return [userId, { displayName: userId, avatarUrl: null }];
				}

				return [userId, userId === OWNER_USER_ID ? { kind: "owner" } : { kind: "system", role: "member" }];
			}),
		),
	);
}

const PageComponent = Route.options.component as () => JSX.Element;

function roleSelectFor(userId: string) {
	return document.querySelector(`[data-user-id="${userId}"] .RouteUsersUserListItem-role-select`);
}

/** The option labels the select offers for one member, in order. */
function roleOptionsFor(userId: string) {
	return [...document.querySelectorAll(`[data-user-id="${userId}"] [data-select-option]`)].map(
		(option) => option.textContent,
	);
}

describe("RouteUsers role select", () => {
	beforeEach(() => {
		authMock.mockReturnValue({ userId: SELF_USER_ID });
		mutationMock.mockResolvedValue({ _yay: null });
		setQueries();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("only another member gets a select; the owner and yourself keep the read-only badge", () => {
		render(<PageComponent />);

		expect(roleSelectFor(TARGET_USER_ID)).not.toBeNull();
		// The owner holds no role assignment, and lowering your own role has no way back.
		expect(roleSelectFor(OWNER_USER_ID)).toBeNull();
		expect(roleSelectFor(SELF_USER_ID)).toBeNull();
		expect(document.querySelector(`[data-user-id="${OWNER_USER_ID}"] [data-role-kind="owner"]`)).not.toBeNull();
	});

	test("the list leaves out a role that grants more than the caller holds", () => {
		setQueries({ customRoles: [EDITOR_ROLE, BILLING_ROLE] });
		render(<PageComponent />);

		// `set_user_role` refuses any role holding a permission the caller lacks, so offering the billing
		// role would only ever produce an error toast.
		expect(roleOptionsFor(TARGET_USER_ID)).toEqual(["Admin", "Member", "Viewer", "Editor"]);
	});

	test("the default workspace has no revoke entry, and picking a role sends it", async () => {
		render(<PageComponent />);

		// Here the assignment *is* the organization role, so there is nothing extra to take back.
		expect(roleOptionsFor(TARGET_USER_ID)).toEqual(["Admin", "Member", "Viewer"]);

		fireEvent.click(
			document.querySelector(`[data-user-id="${TARGET_USER_ID}"] [data-select-option="viewer"]`) as HTMLElement,
		);

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("access_control.set_user_role", {
				organizationId: ORGANIZATION_ID,
				workspaceId: DEFAULT_WORKSPACE_ID,
				userId: TARGET_USER_ID,
				role: "viewer",
			}),
		);
		await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Role updated"));
	});

	test("another workspace offers the revoke entry, which sends role null", async () => {
		setQueries({ workspaceId: OTHER_WORKSPACE_ID });
		render(<PageComponent />);

		// Without this entry an workspace role could never be taken back: every weaker role is
		// refused by the "adds nothing" rule, and `delete_role` then refuses forever too.
		expect(roleOptionsFor(TARGET_USER_ID)[0]).toBe("No workspace role");

		fireEvent.click(
			document.querySelector(`[data-user-id="${TARGET_USER_ID}"] [data-select-option=""]`) as HTMLElement,
		);

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("access_control.set_user_role", {
				organizationId: ORGANIZATION_ID,
				workspaceId: OTHER_WORKSPACE_ID,
				userId: TARGET_USER_ID,
				role: null,
			}),
		);
		await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Workspace role removed"));
	});

	test("workspace members management is enough outside the default workspace", () => {
		// This caller cannot invite or remove anybody, but `set_user_role` still takes them here.
		setQueries({
			workspaceId: OTHER_WORKSPACE_ID,
			organizationMembersManage: false,
			callerPermissions: ["content.read"],
			otherWorkspacePermissions: ["content.read", "content.write", "workspace.members.manage"],
		});
		render(<PageComponent />);

		expect(roleSelectFor(TARGET_USER_ID)).not.toBeNull();
		// Still only the roles they can hand out: Admin and Member both need more than they hold.
		expect(roleOptionsFor(TARGET_USER_ID)).toEqual(["No workspace role", "Viewer"]);
	});

	test("the same permission in the default workspace changes nothing on its own", () => {
		setQueries({
			organizationMembersManage: false,
			callerPermissions: ["content.read", "workspace.members.manage"],
		});
		render(<PageComponent />);

		// `workspace.members.manage` never works in the default workspace, and the server ignores it there.
		expect(roleSelectFor(TARGET_USER_ID)).toBeNull();
	});

	test("the row waits for the answer instead of taking a second pick", async () => {
		mutationMock.mockReturnValue(new Promise(() => {}));
		render(<PageComponent />);

		fireEvent.click(
			document.querySelector(`[data-user-id="${TARGET_USER_ID}"] [data-select-option="viewer"]`) as HTMLElement,
		);

		await waitFor(() => expect(roleSelectFor(TARGET_USER_ID)?.getAttribute("aria-busy")).toBe("true"));
		expect(roleSelectFor(TARGET_USER_ID)?.textContent).toContain("Saving...");
		// Only the row that is waiting.
		expect(roleSelectFor(OWNER_USER_ID)).toBeNull();
	});

	test("a refused change shows the server message", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "This role adds nothing to the member's organization role" } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		setQueries({ workspaceId: OTHER_WORKSPACE_ID });
		render(<PageComponent />);

		fireEvent.click(
			document.querySelector(`[data-user-id="${TARGET_USER_ID}"] [data-select-option="viewer"]`) as HTMLElement,
		);

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith("This role adds nothing to the member's organization role"),
		);
		expect(toastMock.success).not.toHaveBeenCalled();
	});
});
