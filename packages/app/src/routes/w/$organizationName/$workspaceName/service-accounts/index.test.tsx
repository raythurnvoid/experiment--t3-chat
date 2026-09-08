import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { queryMock, pageMock, mutationMock, loadMoreMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	pageMock: vi.fn(),
	mutationMock: vi.fn(),
	loadMoreMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
	Link: (props: { children: ReactNode; search: { serviceAccountId: string } }) => (
		<a href={`api-keys?serviceAccountId=${props.search.serviceAccountId}`}>{props.children}</a>
	),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => queryMock(...args),
	usePaginatedQuery: (...args: unknown[]) => pageMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationName: "personal", workspaceName: "home" }),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		access_control: {
			get_current_user_workspace_permission: "permission",
			list_service_accounts: "accounts",
			get_service_account: "account",
			create_service_account: "create",
			rename_service_account: "rename",
			revoke_service_account: "revoke",
			list_service_account_grants: "grants",
			get_service_account_grant_management_state: "management",
			set_service_account_grant: "set_grant",
			remove_service_account_grant: "remove_grant",
		},
		files_nodes: { get_authorized_by_path: "node" },
	},
}));

import { Route } from "./index.tsx";

const ACCOUNT = {
	_id: "account_1",
	name: "Build bot",
	createdBy: "user_1",
	createdAt: 1,
	updatedAt: 1,
	revokedAt: null as number | null,
};

const WORKSPACE_GRANT = {
	resource: { kind: "workspace" },
	level: "read",
	file: null,
	canManage: true,
	grantableLevels: ["read", "write"],
};

function renderRoute() {
	const Page = Route.options.component as () => JSX.Element;
	return render(<Page />);
}

beforeEach(() => {
	mutationMock.mockReset().mockResolvedValue({ _yay: null });
	loadMoreMock.mockReset();

	queryMock.mockReset().mockImplementation((query: string, args: unknown) => {
		if (args === "skip") {
			return undefined;
		}
		if (query === "permission") {
			return true;
		}
		if (query === "account") {
			return ACCOUNT;
		}
		if (query === "management") {
			return { ...WORKSPACE_GRANT, level: null };
		}
		if (query === "node") {
			return { nodeId: "child_1" };
		}
		return undefined;
	});

	pageMock
		.mockReset()
		.mockImplementation((query: string) => ({
			results: query === "accounts" ? [ACCOUNT] : [],
			status: "Exhausted",
			loadMore: loadMoreMock,
		}));
});

afterEach(cleanup);

describe("RouteServiceAccounts", () => {
	test("supports personal workspaces and links the active identity to key creation", () => {
		renderRoute();

		expect(screen.getByRole("button", { name: "Create account" }).hasAttribute("disabled")).toBe(false);
		expect(screen.getByRole("link", { name: "Create API key" }).getAttribute("href")).toContain(
			"serviceAccountId=account_1",
		);
		expect(pageMock).toHaveBeenCalledWith(
			"accounts",
			{ membershipId: "membership_1", includeRevoked: true },
			{ initialNumItems: 50 },
		);
	});

	test("creates an account without grants and returns focus", async () => {
		renderRoute();
		const create = screen.getByRole("button", { name: "Create account" });
		fireEvent.click(create);

		const name = screen.getByRole("textbox", { name: "Name" });
		expect(name.getAttribute("maxlength")).toBe("80");

		fireEvent.change(name, { target: { value: "  Daily report  " } });
		fireEvent.click(screen.getByRole("button", { name: "Save account" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("create", { membershipId: "membership_1", name: "Daily report" }),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(document.activeElement).toBe(create));
	});

	test("keeps the same account when renaming and shows refused changes", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Permission changed" } });

		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed bot" } });
		fireEvent.click(screen.getByRole("button", { name: "Save account" }));

		expect(mutationMock).toHaveBeenCalledWith("rename", {
			membershipId: "membership_1",
			serviceAccountId: "account_1",
			name: "Renamed bot",
		});
		expect((await screen.findByRole("alert")).textContent).toBe("Permission changed");
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	test("confirms revocation while explaining preserved file policies", async () => {
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

		expect(screen.getByText(/Protected files keep their policies/)).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Revoke account" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("revoke", {
				membershipId: "membership_1",
				serviceAccountId: "account_1",
			}),
		);
	});

	test("uses the management answer before the first grant exists", async () => {
		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Manage grants" }));

		expect(screen.getByText("No grants yet.")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Save grant" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_grant", {
				membershipId: "membership_1",
				serviceAccountId: "account_1",
				resource: { kind: "workspace" },
				level: "read",
			}),
		);
	});

	test("shows and submits the actual restricted scope for a child path", async () => {
		queryMock.mockImplementation((query: string, args: { resource?: { kind: string } } | "skip") => {
			if (args === "skip") {
				return undefined;
			}
			if (query === "permission") {
				return true;
			}
			if (query === "account") {
				return ACCOUNT;
			}
			if (query === "node") {
				return { nodeId: "child_1" };
			}
			if (query === "management") {
				return args.resource?.kind === "file"
					? {
							...WORKSPACE_GRANT,
							level: null,
							resource: { kind: "file", nodeId: "scope_1" },
							file: { path: "/protected", name: "protected", scope: "restricted_scope" },
						}
					: { ...WORKSPACE_GRANT, level: null };
			}
		});

		renderRoute();
		fireEvent.click(screen.getByRole("button", { name: "Manage grants" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Resource" }));
		fireEvent.click(await screen.findByRole("option", { name: "File or folder" }));
		fireEvent.change(screen.getByRole("textbox", { name: "File or folder path" }), {
			target: { value: "/protected/child" },
		});

		expect(screen.getByText("/protected — This restricted scope")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Save grant" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_grant", {
				membershipId: "membership_1",
				serviceAccountId: "account_1",
				resource: { kind: "file", nodeId: "scope_1" },
				level: "read",
			}),
		);
	});

	test("removes only the selected grant and keeps revoked accounts visible", async () => {
		const account = { ...ACCOUNT, revokedAt: 2 };
		queryMock.mockImplementation((query: string, args: unknown) =>
			args === "skip" ? undefined : query === "permission" ? true : query === "account" ? account : undefined,
		);
		pageMock.mockImplementation((query: string) => ({
			results: query === "accounts" ? [account] : [WORKSPACE_GRANT],
			status: "Exhausted",
			loadMore: loadMoreMock,
		}));

		renderRoute();

		expect(screen.getByText("Revoked")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Create API key" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Manage grants" }));
		expect(screen.queryByRole("button", { name: "Save grant" })).toBeNull();

		fireEvent.click(
			within(screen.getByRole("list", { name: "Account grants" })).getByRole("button", { name: "Remove" }),
		);

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("remove_grant", {
				membershipId: "membership_1",
				serviceAccountId: "account_1",
				resource: { kind: "workspace" },
			}),
		);
	});

	test("does not expose account management without the workspace permission", () => {
		queryMock.mockReturnValue(false);
		renderRoute();

		expect(screen.getByRole("alert").textContent).toContain("don't have permission");
		expect(screen.getByRole("button", { name: "Create account" }).hasAttribute("disabled")).toBe(true);
		expect(screen.queryByRole("list")).toBeNull();
		expect(pageMock).toHaveBeenCalledWith("accounts", "skip", { initialNumItems: 50 });
	});
});
