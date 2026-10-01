import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { queryMock, pageMock, mutationMock, anagraphicsMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	pageMock: vi.fn(),
	mutationMock: vi.fn(),
	anagraphicsMock: vi.fn(),
	toastSuccessMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => queryMock(...args),
	usePaginatedQuery: (...args: unknown[]) => pageMock(...args),
	useQueries: (...args: unknown[]) => anagraphicsMock(...args),
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccessMock, error: toastErrorMock },
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
			set_node_share_link: "set_link",
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
	link: null as { token: string; createdBy: string; createdAt: number } | null,
};

/**
 * A manager's view of a file, not a folder, so the public link section shows.
 */
const FILE_SHARE = { ...SHARE, nodeName: "notes.md", nodeKind: "file", scope: null };

// Midday UTC, so the date reads the same in every time zone the tests may run in.
const LINK = { token: "token_1", createdBy: "user_1", createdAt: Date.UTC(2026, 8, 27, 12) };

function mockShareState(shareState: object) {
	queryMock.mockImplementation((query: string) =>
		query === "sharing" ? shareState : query === "users" ? ["owner_1", "user_1"] : query === "roles" ? [] : undefined,
	);
}

function linkSection() {
	return document.querySelector("[data-share-link]") as HTMLElement | null;
}

/**
 * Wait until the dialog has moved focus inside itself. A list opened before that closes again when
 * the focus moves to the first control, such as "Restrict access".
 */
async function waitForDialogFocus() {
	await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));
}

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
	anagraphicsMock.mockReset().mockReturnValue({ owner_1: { displayName: "Owner" }, user_1: { displayName: "Ada" } });
	toastSuccessMock.mockReset();
	toastErrorMock.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

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

	test("shows the public link section only to a manager of a file", () => {
		// `SHARE` is a folder.
		renderModal();
		expect(linkSection()).toBeNull();
		cleanup();

		mockShareState({ ...FILE_SHARE, canManage: false });
		renderModal();
		expect(linkSection()).toBeNull();
		cleanup();

		mockShareState(FILE_SHARE);
		renderModal();
		expect(linkSection()?.dataset.shareLink).toBe("off");
		expect(linkSection()?.textContent).toContain("Only people with access can open this file.");
	});

	test("turns the public link on", async () => {
		mockShareState(FILE_SHARE);
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Anyone with the link" }));
		fireEvent.click(await screen.findByRole("option", { name: "Can view" }));

		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Public link created"));
		expect(mutationMock).toHaveBeenCalledWith("set_link", {
			membershipId: "membership_1",
			nodeId: "node_1",
			enabled: true,
		});
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("shows a refused link beside the control instead of in a toast", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "One workspace can have at most 500 public links." } });
		mockShareState(FILE_SHARE);
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Anyone with the link" }));
		fireEvent.click(await screen.findByRole("option", { name: "Can view" }));

		const alert = await within(linkSection()!).findByRole("alert");
		expect(alert.textContent).toBe("One workspace can have at most 500 public links.");
		expect(toastErrorMock).not.toHaveBeenCalled();
		expect(linkSection()?.dataset.shareLink).toBe("off");
	});

	test("names the creator, copies the full link, and turns the link off", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		mockShareState({ ...FILE_SHARE, link: LINK });
		renderModal();
		await waitForDialogFocus();

		expect(linkSection()?.dataset.shareLink).toBe("on");
		expect(linkSection()?.textContent).toContain("Link created by Ada on Sep 27, 2026.");

		fireEvent.click(within(linkSection()!).getByRole("button", { name: "Copy link" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/token_1`));

		fireEvent.click(screen.getByRole("combobox", { name: "Anyone with the link" }));
		fireEvent.click(await screen.findByRole("option", { name: "No access" }));

		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Public link turned off"));
		expect(mutationMock).toHaveBeenCalledWith("set_link", {
			membershipId: "membership_1",
			nodeId: "node_1",
			enabled: false,
		});
	});

	test("names a creator who left, and shows Unknown when the profile is missing or failed", () => {
		mockShareState({ ...FILE_SHARE, link: { ...LINK, createdBy: "gone_1" } });

		// The creator is no longer a member, but the dialog still asks for their name.
		anagraphicsMock.mockReturnValue({
			owner_1: { displayName: "Owner" },
			user_1: { displayName: "Ada" },
			gone_1: { displayName: "Old Ana" },
		});
		renderModal();
		expect(Object.keys(anagraphicsMock.mock.lastCall?.[0] ?? {})).toContain("gone_1");
		expect(linkSection()?.textContent).toContain("Link created by Old Ana on");
		cleanup();

		anagraphicsMock.mockReturnValue({
			owner_1: { displayName: "Owner" },
			user_1: { displayName: "Ada" },
			gone_1: null,
		});
		renderModal();
		expect(linkSection()?.textContent).toContain("Link created by Unknown on");
		cleanup();

		anagraphicsMock.mockReturnValue({
			owner_1: { displayName: "Owner" },
			user_1: { displayName: "Ada" },
			gone_1: new Error("failed"),
		});
		renderModal();
		expect(linkSection()?.textContent).toContain("Link created by Unknown on");
	});
});
