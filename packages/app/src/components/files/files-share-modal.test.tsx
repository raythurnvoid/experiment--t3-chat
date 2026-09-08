import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { queryMock, pageMock, mutationMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	pageMock: vi.fn(),
	mutationMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => queryMock(...args),
	usePaginatedQuery: (...args: unknown[]) => pageMock(...args),
	useQueries: () => ({ owner_1: { displayName: "Owner" }, user_1: { displayName: "Ada" } }),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationId: "organization_1", workspaceId: "workspace_1" }),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		files_sharing: {
			get_node_share_state: "sharing",
			set_node_share_grant: "set_grant",
			remove_node_share_grant: "remove_grant",
			restrict_node: "restrict_node",
			unrestrict_node: "unrestrict_node",
		},
		organizations: { list_organization_workspace_users: "users" },
		access_control: { list_roles: "roles", list_service_accounts: "accounts" },
		users: { get_anagraphic: "anagraphic" },
	},
}));

import { FilesShareModal } from "./files-share-modal.tsx";

const SHARE = {
	nodeId: "node_1",
	nodeName: "Reports",
	nodeKind: "folder",
	organizationOwnerUserId: "owner_1",
	canManage: true,
	canRestrict: true,
	canShareWithRoles: true,
	canShareWithServiceAccounts: true,
	serviceGrantableLevels: ["read", "write"],
	scope: { nodeId: "node_1", name: "Reports", path: "/Reports", isSelf: true },
	entries: [] as {
		principal: { kind: "service_account"; serviceAccountId: string };
		level: "read";
		serviceAccountName: string | null;
	}[],
};

function renderModal() {
	return render(<FilesShareModal nodeId={"node_1" as app_convex_Id<"files_nodes">} onClose={() => {}} />);
}

beforeEach(() => {
	queryMock
		.mockReset()
		.mockImplementation((query: string) =>
			query === "sharing" ? SHARE : query === "users" ? ["owner_1", "user_1"] : query === "roles" ? [] : undefined,
		);
	pageMock.mockReset().mockReturnValue({
		results: [{ _id: "account_1", name: "Report bot", revokedAt: null }],
		status: "Exhausted",
		loadMore: vi.fn(),
	});
	mutationMock.mockReset().mockResolvedValue({ _yay: null });
});

afterEach(cleanup);

describe("FilesShareModal", () => {
	test("adds an active service account with a permitted level", async () => {
		renderModal();
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or service account to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Report bot" }));
		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_grant", {
				membershipId: "membership_1",
				nodeId: "node_1",
				principal: { kind: "service_account", serviceAccountId: "account_1" },
				level: "read",
			}),
		);
		expect(pageMock).toHaveBeenCalledWith(
			"accounts",
			{ membershipId: "membership_1", includeRevoked: false },
			{ initialNumItems: 50 },
		);
	});

	test("disables levels above the service grant ceiling", async () => {
		renderModal();
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or service account to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Report bot" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for the new person, role, or account" }));

		expect((await screen.findByRole("option", { name: "Can manage" })).getAttribute("aria-disabled")).toBe("true");
	});

	test("keeps unavailable accounts distinct and removes only the service principal", async () => {
		queryMock.mockImplementation((query: string) =>
			query === "sharing"
				? {
						...SHARE,
						entries: [
							{
								principal: { kind: "service_account", serviceAccountId: "account_1" },
								level: "read",
								serviceAccountName: null,
							},
						],
					}
				: query === "users"
					? ["owner_1"]
					: [],
		);

		renderModal();
		const row = document.querySelector('[data-share-principal="service_account:account_1"]') as HTMLElement;
		expect(row.textContent).toContain("Service account unavailable");

		fireEvent.click(within(row).getByRole("button", { name: "Remove Service account unavailable" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("remove_grant", {
				membershipId: "membership_1",
				nodeId: "node_1",
				principal: { kind: "service_account", serviceAccountId: "account_1" },
			}),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("hides service choices when the caller cannot manage service accounts", async () => {
		queryMock.mockImplementation((query: string) =>
			query === "sharing"
				? { ...SHARE, canShareWithServiceAccounts: false }
				: query === "users"
					? ["owner_1", "user_1"]
					: [],
		);

		renderModal();
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or service account to add" }));

		expect(screen.queryByRole("option", { name: "Report bot" })).toBeNull();
		expect(await screen.findByRole("option", { name: "Ada" })).toBeTruthy();
	});
});
