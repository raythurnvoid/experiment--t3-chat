/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { access_control_ENFORCED_PERMISSIONS } from "../../../../../../shared/access-control.ts";

const { tenantContextMock, authMock, useQueryMock, mutationMock, toastMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	authMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	toastMock: { error: vi.fn(), success: vi.fn() },
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
		organizations: { list: "organizations.list" },
		access_control: {
			list_roles: "access_control.list_roles",
			get_current_user_organization_permission: "access_control.get_current_user_organization_permission",
			create_role: "access_control.create_role",
			update_role: "access_control.update_role",
			delete_role: "access_control.delete_role",
		},
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("sonner", () => ({
	toast: toastMock,
}));

// Ariakit renders the modal and the tooltip through a portal and keeps them mounted when closed.
// The plain stand-ins below keep the test about this route instead of about Ariakit.
vi.mock("@/components/my-modal.tsx", () => ({
	MyModal: function MyModal(props: { open?: boolean; children?: ReactNode }) {
		return props.open ? <>{props.children}</> : null;
	},
	MyModalPopover: function MyModalPopover(props: { children?: ReactNode }) {
		return <div role="dialog">{props.children}</div>;
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
	MyModalScrollableArea: function MyModalScrollableArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalFooter: function MyModalFooter(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalCloseTrigger: function MyModalCloseTrigger() {
		return <button type="button">Close</button>;
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

import { Route } from "./index.tsx";

const ORGANIZATION_ID = "organization_1";
const WORKSPACE_ID = "workspace_1";

type TestRole = {
	_id: string;
	name: string;
	description: string;
	permissions: string[];
	assignmentCount: number;
	updatedAt: number;
};

function createRole(overrides?: Partial<TestRole>): TestRole {
	return {
		_id: "role_1",
		name: "editor",
		description: "Can write files",
		permissions: ["content.read", "content.write"],
		assignmentCount: 0,
		updatedAt: Date.UTC(2026, 6, 20, 12, 0),
		...overrides,
	};
}

/**
 * The route runs three queries. They are answered by the function reference, so a test can move one
 * of them without touching the other two.
 */
function setQueries(args: {
	organizationList?: unknown;
	roles?: unknown;
	rolesManagePermission?: unknown;
	organizationIsPersonal?: boolean;
	callerPermissions?: string[] | "all";
}) {
	const organizationList =
		args.organizationList === undefined
			? {
					organizations: [
						{
							_id: ORGANIZATION_ID,
							name: "qa-perm",
							default: args.organizationIsPersonal ?? false,
							defaultWorkspaceId: WORKSPACE_ID,
						},
					],
					organizationIdsWorkspacesDict: {},
					workspaceIdsPermissionsDict: {
						[WORKSPACE_ID]: args.callerPermissions ?? "all",
					},
				}
			: args.organizationList;

	useQueryMock.mockImplementation((fn: string) => {
		switch (fn) {
			case "organizations.list":
				return organizationList;
			case "access_control.list_roles":
				return args.roles === undefined ? [] : args.roles;
			case "access_control.get_current_user_organization_permission":
				return args.rolesManagePermission === undefined ? true : args.rolesManagePermission;
			default:
				return undefined;
		}
	});
}

const PageComponent = Route.options.component as () => JSX.Element;

function renderRoute() {
	return render(<PageComponent />);
}

describe("RouteRoles", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: ORGANIZATION_ID,
			organizationName: "qa-perm",
			workspaceId: WORKSPACE_ID,
			workspaceName: "home",
		});
		authMock.mockReturnValue({ userId: "user_1" });
		mutationMock.mockResolvedValue({ _yay: null });
		setQueries({});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("renders loading and unavailable states", () => {
		// Every query still loading. One `undefined` is enough to hold the page back, and this is the
		// state a real first paint is in.
		useQueryMock.mockImplementation(() => undefined);
		const loading = renderRoute();
		expect(screen.getByRole("status").textContent).toContain("Loading roles");
		loading.unmount();

		setQueries({
			organizationList: { organizations: [], organizationIdsWorkspacesDict: {}, workspaceIdsPermissionsDict: {} },
		});
		renderRoute();
		expect(screen.getByRole("alert").textContent).toContain("Organization roles unavailable");
	});

	test("lists the system roles read-only and says there are no custom roles yet", () => {
		renderRoute();

		for (const label of ["Admin", "Member", "Viewer"]) {
			const row = document.querySelector(`[data-role-name="${label}"]`);
			expect(row).not.toBeNull();
			// A system role lives in code, so it can never be edited or deleted.
			expect(row?.querySelector("button")).toBeNull();
		}

		// Owner is deliberately not a row: the owner holds no role assignment.
		expect(document.querySelector('[data-role-name="Owner"]')).toBeNull();
		expect(screen.getByText("No custom roles yet.")).not.toBeNull();
	});

	test("shows a custom role with its permissions, and marks it in use", () => {
		setQueries({ roles: [createRole({ assignmentCount: 2 })] });
		renderRoute();

		const row = document.querySelector('[data-role-id="role_1"]');
		expect(row).not.toBeNull();
		expect(row?.textContent).toContain("editor");
		expect(row?.textContent).toContain("Can write files");
		expect(row?.textContent).toContain("View workspace content");
		expect(row?.textContent).toContain("Edit workspace content");
		// The count is assignment docs, not people, so the UI must never turn it into a number.
		expect(row?.textContent).toContain("In use");
		expect(row?.textContent).not.toContain("2 members");
		const edit = screen.getByRole("button", { name: "Edit editor" });
		expect(edit).not.toBeNull();
		expect(edit.getAttribute("aria-disabled")).toBeNull();
		expect(screen.getByRole("button", { name: "Delete editor" })).not.toBeNull();
	});

	test("a role that gives more than you have keeps its buttons and says why", () => {
		// An admin holds everything except billing, so a billing role is one they could never have
		// created. `update_role` and `delete_role` both refuse it.
		setQueries({
			roles: [createRole({ name: "billing", permissions: ["organization.billing.manage"] })],
			callerPermissions: ["organization.roles.manage", "content.read"],
		});
		renderRoute();

		const edit = screen.getByRole("button", { name: "Edit billing" });
		const remove = screen.getByRole("button", { name: "Delete billing" });
		// The buttons stay. A row with no buttons next to rows that have them reads as a bug, and never
		// tells the user that the rule is deliberate.
		for (const button of [edit, remove]) {
			expect(button.getAttribute("aria-disabled")).toBe("true");
			// Never the real `disabled` attribute: it would drop the button out of the tab order and the
			// reason would never be reachable.
			expect(button.hasAttribute("disabled")).toBe(false);
			const reasonId = button.getAttribute("aria-describedby");
			expect(document.getElementById(reasonId ?? "")?.textContent).toContain("Manage billing");
		}
		// Both buttons point at the same reason element.
		expect(edit.getAttribute("aria-describedby")).toBe(remove.getAttribute("aria-describedby"));

		// Clicking must not open a form that could never be saved.
		fireEvent.click(edit);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("hides the row actions and explains the disabled New role button without permission", () => {
		setQueries({ roles: [createRole()], rolesManagePermission: false });
		renderRoute();

		expect(screen.queryByRole("button", { name: "Edit editor" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete editor" })).toBeNull();

		const createButton = screen.getByRole("button", { name: "New role" });
		// `aria-disabled`, never the `disabled` attribute, so the button keeps its place in the tab
		// order and can point at the reason.
		expect(createButton.getAttribute("aria-disabled")).toBe("true");
		expect(createButton.hasAttribute("disabled")).toBe(false);
		const reasonId = createButton.getAttribute("aria-describedby");
		expect(reasonId).not.toBeNull();
		expect(document.getElementById(reasonId ?? "")?.textContent).toContain("don't have permission");
	});

	test("says nothing about permission while the answer is still loading", () => {
		setQueries({ roles: [createRole()], rolesManagePermission: undefined });
		useQueryMock.mockImplementation((fn: string) =>
			fn === "access_control.get_current_user_organization_permission"
				? undefined
				: fn === "access_control.list_roles"
					? [createRole()]
					: {
							organizations: [
								{ _id: ORGANIZATION_ID, name: "qa-perm", default: false, defaultWorkspaceId: WORKSPACE_ID },
							],
							organizationIdsWorkspacesDict: {},
							workspaceIdsPermissionsDict: { [WORKSPACE_ID]: "all" },
						},
		);
		renderRoute();

		const createButton = screen.getByRole("button", { name: "New role" });
		expect(createButton.getAttribute("aria-disabled")).toBe("true");
		expect(createButton.getAttribute("aria-describedby")).toBeNull();
	});

	test("the personal organization disables New role with its own reason", () => {
		setQueries({ organizationIsPersonal: true });
		renderRoute();

		const createButton = screen.getByRole("button", { name: "New role" });
		expect(createButton.getAttribute("aria-disabled")).toBe("true");
		const reasonId = createButton.getAttribute("aria-describedby");
		expect(document.getElementById(reasonId ?? "")?.textContent).toContain("only yours");
	});

	test("the editor offers every enforced permission, grouped", () => {
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "New role" }));

		const dialog = screen.getByRole("dialog");
		// Counted from the list the editor filters by, never typed out here. A number written by hand
		// went stale the moment file sharing made `content.permissions.manage` enforced, and the suite
		// went red for a change that was correct.
		expect(dialog.querySelectorAll("[data-permission]")).toHaveLength(access_control_ENFORCED_PERMISSIONS.length);
		// Two ends of the catalog, so the grouping below cannot pass while a group is silently dropped.
		expect(dialog.querySelector('[data-permission="content.permissions.manage"]')).not.toBeNull();
		expect(dialog.querySelector('[data-permission="organization.billing.manage"]')).not.toBeNull();

		const groups = [...dialog.querySelectorAll("legend")].map((legend) => legend.textContent);
		expect(groups).toEqual(["Organization", "Workspaces", "Content", "Integrations"]);
	});

	test("a permission the user does not hold is shown locked instead of as a checkbox", () => {
		// An admin holds everything except billing.
		setQueries({ callerPermissions: ["content.read", "content.write", "organization.roles.manage"] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "New role" }));

		const billing = document.querySelector('[data-permission="organization.billing.manage"]');
		expect(billing).not.toBeNull();
		expect(billing?.querySelector('input[type="checkbox"]')).toBeNull();
		expect(billing?.textContent).toContain("You cannot give this away");

		const read = document.querySelector('[data-permission="content.read"]');
		expect(read?.querySelector('input[type="checkbox"]')).not.toBeNull();
	});

	test("create sends the trimmed name, description and picked permissions", async () => {
		mutationMock.mockResolvedValue({ _yay: { roleId: "role_new" } });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "New role" }));

		const save = screen.getByRole("button", { name: "Create role" });
		// The server refuses a role with no permission, so the form must refuse it first.
		expect((save as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  auditor  " } });
		fireEvent.change(screen.getByLabelText("Description"), { target: { value: "  reads only  " } });
		expect((save as HTMLButtonElement).disabled).toBe(true);

		const read = document.querySelector('[data-permission="content.read"] input') as HTMLInputElement;
		fireEvent.click(read);
		expect((screen.getByRole("button", { name: "Create role" }) as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Create role" }));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("access_control.create_role", {
			organizationId: ORGANIZATION_ID,
			name: "auditor",
			description: "reads only",
			permissions: ["content.read"],
		});
		await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Role created"));
	});

	test("editing a role opens the form filled in and saves through update_role", async () => {
		setQueries({ roles: [createRole()] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Edit editor" }));

		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("editor");
		expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Can write files");
		const write = document.querySelector('[data-permission="content.write"] input') as HTMLInputElement;
		expect(write.checked).toBe(true);

		fireEvent.click(write);
		fireEvent.click(screen.getByRole("button", { name: "Save role" }));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith("access_control.update_role", {
			roleId: "role_1",
			name: "editor",
			description: "Can write files",
			permissions: ["content.read"],
		});
	});

	test("the form cannot be dismissed while the save is in flight", async () => {
		// Closing mid-save would leave `saving` on for good: the next modal would open frozen and then
		// shut itself when this request finally answers.
		mutationMock.mockReturnValue(new Promise(() => {}));
		setQueries({ roles: [createRole()] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Edit editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Save role" }));

		await waitFor(() => expect(screen.getByRole("button", { name: "Saving..." })).not.toBeNull());
		expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	test("the form closes itself when somebody else deletes the role", async () => {
		setQueries({ roles: [createRole()] });
		const view = renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Edit editor" }));
		expect(screen.getByRole("dialog")).not.toBeNull();

		// Every save from here answers "Not found", so the form has to let go instead of trapping the user.
		setQueries({ roles: [] });
		view.rerender(<PageComponent />);

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(toastMock.error).toHaveBeenCalledWith("This role was deleted.");
	});

	test("a refused save keeps the form open and shows the server message", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Role name already exists" } });
		setQueries({ roles: [createRole()] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Edit editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Save role" }));

		await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Role name already exists"));
		expect(toastMock.success).not.toHaveBeenCalled();
		// The form stays open so the user can fix the name instead of retyping everything.
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	test("the delete dialog matches what the server really does, and calls delete_role", async () => {
		setQueries({ roles: [createRole()] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Delete editor" }));

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("editor");
		// `delete_role` refuses while an active member still holds the role. It never demotes them, so
		// the dialog must not promise that.
		expect(dialog.textContent).toContain("must get another role first");
		expect(dialog.textContent).not.toContain("become viewers");

		fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
		await waitFor(() => expect(mutationMock).toHaveBeenCalledWith("access_control.delete_role", { roleId: "role_1" }));
		await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Role deleted"));
	});

	test("a refused delete shows the server reason and keeps the dialog open", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Give this role's members another role first" } });
		setQueries({ roles: [createRole({ assignmentCount: 1 })] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Delete editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete role" }));

		await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Give this role's members another role first"));
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	test("a thrown mutation is caught and reported", async () => {
		mutationMock.mockRejectedValue(new Error("boom"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		setQueries({ roles: [createRole()] });
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Delete editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete role" }));

		await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Failed to delete role"));
	});
});
