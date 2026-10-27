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
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		files_sharing: {
			get_node_share_state: "sharing",
			set_node_share_grant: "set_grant",
			remove_node_share_grant: "remove_grant",
			restrict_node: "restrict_node",
			unrestrict_node: "unrestrict_node",
			set_node_workspace_view: "set_workspace_view",
			set_node_public: "set_public",
		},
		files_share_links: { set_node_share_link: "set_link" },
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
		servicePluginName: string | null;
		coverage: { base: string | null; folder: null; role: null; workspace: null } | null;
	}[],
	// The owner is looking, so a restrict or an unrestrict never asks about their own access.
	callerUserId: "owner_1",
	callerCoverage: { base: "manage", folder: null, role: null, workspace: null },
	callerRoles: [] as string[],
	baseScope: null as { nodeId: string; name: string; path: string; workspaceView: boolean | null } | null,
	linksInside: false,
	pluginArea: null,
	access: "restricted_root",
	workspaceView: false,
	canAddPeople: true,
	inheritedFrom: { restricted: null, extended: [] },
	link: null as { token: string; createdBy: string; createdAt: number } | null,
	public: null as { isPublic: boolean; canChange: boolean; mediaKind: "image" | "video" } | null,
};

/**
 * A manager's view of a file, not a folder, so the public link section shows.
 */
const FILE_SHARE = { ...SHARE, nodeName: "notes.md", nodeKind: "file", scope: null, access: "inherits" };

/**
 * A manager's view of an image file, so the section also has the public flag.
 */
const IMAGE_SHARE = {
	...FILE_SHARE,
	nodeName: "photo.png",
	public: { isPublic: false, canChange: true, mediaKind: "image" as const },
};

/**
 * A folder in the open part of the workspace, with nobody added yet.
 */
const OPEN_SHARE = { ...SHARE, scope: null, access: "inherits" };

/**
 * A file inside the restricted folder Team.
 */
const INSIDE_SHARE = {
	...SHARE,
	nodeName: "notes.md",
	nodeKind: "file",
	scope: { nodeId: "node_0", name: "Team", path: "/Team", isSelf: false },
	baseScope: { nodeId: "node_0", name: "Team", path: "/Team", workspaceView: false },
	access: "inherits",
	inheritedFrom: {
		restricted: {
			nodeId: "node_0",
			name: "Team",
			path: "/Team",
			workspaceView: false,
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "read",
					serviceAccountName: null,
					servicePluginName: null,
				},
			],
		},
		extended: [],
	},
};

/**
 * A folder restricted on its own inside the restricted folder Team. The server sends no
 * `inheritedFrom.restricted` for a restricted item.
 */
const TEAM_ROOT_SHARE = {
	...INSIDE_SHARE,
	nodeName: "Reports",
	nodeKind: "folder",
	scope: { ...SHARE.scope },
	access: "restricted_root",
	inheritedFrom: { restricted: null, extended: [] },
};

// Midday UTC, so the date reads the same in every time zone the tests may run in.
const LINK = { token: "token_1", createdBy: "user_1", createdAt: Date.UTC(2026, 8, 27, 12) };

function mockShareState(shareState: object) {
	queryMock.mockImplementation((query: string) =>
		query === "sharing" ? shareState : query === "users" ? ["owner_1", "user_1"] : query === "roles" ? [] : undefined,
	);
}

function generalSection() {
	return document.querySelector("[data-share-general]") as HTMLElement;
}

/**
 * Pick one option in the General access select.
 */
async function chooseGeneral(name: string) {
	await waitForDialogFocus();
	fireEvent.click(screen.getByRole("combobox", { name: "Who can open this" }));
	fireEvent.click(await screen.findByRole("option", { name }));
}

function linkSection() {
	return document.querySelector("[data-share-link]") as HTMLElement | null;
}

/**
 * Wait until the dialog has moved focus inside itself. A list opened before that closes again when
 * the focus moves to the first control, such as the add picker.
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
	test("renders while the share state is still loading", () => {
		queryMock.mockImplementation((query: string) => (query === "users" ? ["owner_1", "user_1"] : undefined));
		renderModal();

		expect(screen.getByRole("status", { name: "Loading sharing" }).getAttribute("aria-busy")).toBe("true");
	});

	test("adds an active service account with a permitted level", async () => {
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or app to add" }));
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
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or app to add" }));
		fireEvent.click(await screen.findByRole("option", { name: "Report bot" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for the new person, role, or app" }));

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
								servicePluginName: null,
							},
						],
					}
				: query === "users"
					? ["owner_1"]
					: [],
		);

		renderModal();
		const row = document.querySelector('[data-share-principal="service_account:account_1"]') as HTMLElement;
		expect(row.textContent).toContain("App unavailable");

		fireEvent.click(within(row).getByRole("button", { name: "Remove App unavailable" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("remove_grant", {
				membershipId: "membership_1",
				nodeId: "node_1",
				principal: { kind: "service_account", serviceAccountId: "account_1" },
			}),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("says when a service account entry backs a plugin", () => {
		mockShareState({
			...SHARE,
			entries: [
				{
					principal: { kind: "service_account", serviceAccountId: "account_1" },
					level: "read",
					serviceAccountName: "Chitchat bot",
					servicePluginName: "chitchat",
				},
			],
		});

		renderModal();
		const row = document.querySelector('[data-share-principal="service_account:account_1"]') as HTMLElement;
		expect(row.textContent).toContain("Used by plugin chitchat: this also changes the folders the plugin can use.");
	});

	test("add people is available on an open folder", () => {
		mockShareState(OPEN_SHARE);
		renderModal();

		expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
		expect(
			screen.getByText("They also get everything inside this folder, except restricted items inside it."),
		).toBeTruthy();
		expect(screen.getByText("Everyone in this workspace")).toBeTruthy();
	});

	test("add people is available on a file inside a restricted folder", () => {
		mockShareState(INSIDE_SHARE);
		renderModal();

		expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
		// The help text is about what is inside a folder, so a file does not show it.
		expect(
			screen.queryByText("They also get everything inside this folder, except restricted items inside it."),
		).toBeNull();
	});

	test("Only people added restricts at once, without asking", async () => {
		mockShareState({
			...OPEN_SHARE,
			access: "extended_root",
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "read",
					serviceAccountName: null,
					servicePluginName: null,
					coverage: { base: "write", folder: null, role: null, workspace: null },
				},
			],
		});
		renderModal();
		await chooseGeneral("Only people added");

		expect(document.querySelector("[data-share-confirm]")).toBeNull();
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("restrict_node", { membershipId: "membership_1", nodeId: "node_1" }),
		);
	});

	test("opening to the workspace again asks first when someone loses manage", async () => {
		mockShareState({
			...SHARE,
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "manage",
					serviceAccountName: null,
					servicePluginName: null,
					// The workspace role gives edit only, so Ada can no longer change access after.
					coverage: { base: "write", folder: null, role: null, workspace: null },
				},
			],
		});
		renderModal();
		await chooseGeneral("Everyone in this workspace");

		// The box shows next to the select that started the change.
		const confirmBox = generalSection().querySelector('[data-share-confirm="unrestrict"]') as HTMLElement;
		expect([...within(confirmBox).getByRole("alert").querySelectorAll("p")].map((line) => line.textContent)).toEqual([
			"Ada can no longer change who has access.",
		]);
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.click(within(confirmBox).getByRole("button", { name: "Change" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("unrestrict_node", { membershipId: "membership_1", nodeId: "node_1" }),
		);
	});

	test("lowering your own only manage asks first and says where you land", async () => {
		mockShareState({
			...SHARE,
			callerUserId: "user_1",
			callerCoverage: { base: "write", folder: null, role: null, workspace: null },
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "manage",
					serviceAccountName: null,
					servicePluginName: null,
					coverage: { base: "write", folder: null, role: null, workspace: null },
				},
			],
		});
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for You" }));
		fireEvent.click(await screen.findByRole("option", { name: "Can edit" }));

		// The item is restricted, so the workspace role gives nothing and the row is all you have.
		const confirmBox = document.querySelector('[data-share-confirm="set"]') as HTMLElement;
		expect(within(confirmBox).getByRole("alert").textContent).toBe("You'll only be able to edit this.");
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.click(within(confirmBox).getByRole("button", { name: "Change" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_grant", {
				membershipId: "membership_1",
				nodeId: "node_1",
				principal: { kind: "user", userId: "user_1" },
				level: "write",
			}),
		);
	});

	test("General access says why it cannot restrict when the caller cannot", async () => {
		mockShareState({ ...INSIDE_SHARE, canRestrict: false });
		renderModal();

		expect(generalSection().textContent).toContain("You need Can edit here to restrict this.");
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Who can open this" }));
		expect((await screen.findByRole("option", { name: "Only people added" })).getAttribute("aria-disabled")).toBe(
			"true",
		);
	});

	test("General access names the folder above and its people", async () => {
		mockShareState(INSIDE_SHARE);
		renderModal();

		const section = generalSection();
		expect(section.textContent).toContain("People with access to Team");
		expect(section.textContent).toContain("Ada (Can view)");

		fireEvent.click(within(section).getByRole("button", { name: "Manage on Team" }));
		await waitFor(() =>
			expect(queryMock).toHaveBeenCalledWith("sharing", { membershipId: "membership_1", nodeId: "node_0" }),
		);
	});

	test("inherited names are hidden from a viewer who cannot manage that folder", () => {
		mockShareState({
			...INSIDE_SHARE,
			canManage: false,
			canRestrict: false,
			canShareWithServiceAccounts: false,
			canAddPeople: false,
			callerUserId: "user_1",
			callerCoverage: null,
			baseScope: { ...INSIDE_SHARE.baseScope, workspaceView: null },
			inheritedFrom: {
				restricted: { ...INSIDE_SHARE.inheritedFrom.restricted, entries: null, workspaceView: null },
				extended: [],
			},
		});
		renderModal();

		const section = generalSection();
		expect(section.textContent).toContain("Change on Team.");
		expect(section.textContent).not.toContain("Ada");
		expect(within(section).queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Manage on Team" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
		expect(screen.getByText("Only people who can manage this can change access.")).toBeTruthy();
	});

	test("Everyone can view from the workspace asks only because the file's public link ends", async () => {
		mockShareState({ ...FILE_SHARE, link: LINK });
		renderModal();
		await chooseGeneral("Everyone in this workspace can view");

		const confirmBox = generalSection().querySelector('[data-share-confirm="workspace_view"]') as HTMLElement;
		expect(within(confirmBox).getByRole("heading").textContent).toBe(
			'Change to "Everyone in this workspace can view"?',
		);
		expect(within(confirmBox).getByRole("alert").textContent).toBe(
			"The public link turns off. Changing who can open this always turns it off. You can turn it on again after.",
		);
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.click(within(confirmBox).getByRole("button", { name: "Change" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_workspace_view", {
				membershipId: "membership_1",
				nodeId: "node_1",
				enabled: true,
			}),
		);
		cleanup();
		mutationMock.mockClear();

		// Without a link it goes at once.
		mockShareState(FILE_SHARE);
		renderModal();
		await chooseGeneral("Everyone in this workspace can view");
		expect(document.querySelector("[data-share-confirm]")).toBeNull();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
	});

	test("Only people added on a view-only item turns the workspace grant off", async () => {
		mockShareState({ ...SHARE, workspaceView: true });
		renderModal();
		await chooseGeneral("Only people added");

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_workspace_view", {
				membershipId: "membership_1",
				nodeId: "node_1",
				enabled: false,
			}),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("Everyone can view is offered inside a restricted folder only when that folder has it on", async () => {
		mockShareState(INSIDE_SHARE);
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Who can open this" }));
		expect(await screen.findByRole("option", { name: "Only people added" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "Everyone in this workspace can view" })).toBeNull();
		cleanup();

		// A restricted item inside Team gets no `inheritedFrom.restricted`, so the flag comes from `baseScope`.
		mockShareState({ ...TEAM_ROOT_SHARE, baseScope: { ...TEAM_ROOT_SHARE.baseScope, workspaceView: true } });
		renderModal();
		await chooseGeneral("Everyone in this workspace can view");
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_workspace_view", {
				membershipId: "membership_1",
				nodeId: "node_1",
				enabled: true,
			}),
		);
	});

	test("going back to a restricted folder that is not open to the workspace warns that members lose view", async () => {
		mockShareState({ ...TEAM_ROOT_SHARE, workspaceView: true });
		renderModal();
		await chooseGeneral("People with access to Team");

		const confirmBox = generalSection().querySelector('[data-share-confirm="unrestrict"]') as HTMLElement;
		expect(within(confirmBox).getByRole("alert").textContent).toBe(
			"People in this workspace who cannot open Team lose access.",
		);
		expect(mutationMock).not.toHaveBeenCalled();
		cleanup();

		// When everyone can view Team too, nobody loses access, so it goes at once.
		mockShareState({
			...TEAM_ROOT_SHARE,
			workspaceView: true,
			baseScope: { ...TEAM_ROOT_SHARE.baseScope, workspaceView: true },
		});
		renderModal();
		await chooseGeneral("People with access to Team");
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("unrestrict_node", { membershipId: "membership_1", nodeId: "node_1" }),
		);
	});

	test("a change that runs at once closes the confirm box of another change", async () => {
		mockShareState({
			...SHARE,
			callerUserId: "user_1",
			callerCoverage: { base: "write", folder: null, role: null, workspace: null },
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "manage",
					serviceAccountName: null,
					servicePluginName: null,
					coverage: { base: "write", folder: null, role: null, workspace: null },
				},
			],
		});
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for You" }));
		fireEvent.click(await screen.findByRole("option", { name: "Can edit" }));
		expect(document.querySelector('[data-share-confirm="set"]')).not.toBeNull();

		// Turning view on keeps the caller's own row, so it runs at once.
		await chooseGeneral("Everyone in this workspace can view");

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("set_workspace_view", {
				membershipId: "membership_1",
				nodeId: "node_1",
				enabled: true,
			}),
		);
		expect(document.querySelector("[data-share-confirm]")).toBeNull();
	});

	test("the level select has no manage on an Add-people item", async () => {
		mockShareState(OPEN_SHARE);
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for the new person, role, or app" }));

		expect(await screen.findByRole("option", { name: "Can edit" })).toBeTruthy();
		expect(screen.getByRole("option", { name: "Can view" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "Can manage" })).toBeNull();
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
		fireEvent.click(screen.getByRole("combobox", { name: "Person, role, or app to add" }));

		expect(screen.queryByRole("option", { name: "Report bot" })).toBeNull();
		expect(await screen.findByRole("option", { name: "Ada" })).toBeTruthy();
	});

	test("shows the public link section to a manager of a file, and the flag alone to an image editor", () => {
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
		// A file that is not an image or video has no flag.
		expect(document.querySelector("[data-share-public]")).toBeNull();
		cleanup();

		// An editor who does not manage the image changes only the flag.
		mockShareState({ ...IMAGE_SHARE, canManage: false });
		renderModal();
		expect(linkSection()?.dataset.shareLink).toBe("hidden");
		expect(screen.queryByRole("combobox", { name: "Anyone with the link" })).toBeNull();
		expect(screen.getByRole("combobox", { name: "Inside public documents" })).toBeTruthy();
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

	test("shows an image inside public documents and shows a refusal beside the control", async () => {
		mockShareState(IMAGE_SHARE);
		mutationMock.mockResolvedValue({ _yay: { public: true } });
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Inside public documents" }));
		fireEvent.click(await screen.findByRole("option", { name: "Shown" }));

		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Shown inside public documents"));
		expect(mutationMock).toHaveBeenCalledWith("set_public", {
			membershipId: "membership_1",
			nodeId: "node_1",
			enabled: true,
		});
		cleanup();

		mutationMock.mockResolvedValue({ _nay: { message: "This item is being moved. Try again when the Move ends." } });
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Inside public documents" }));
		fireEvent.click(await screen.findByRole("option", { name: "Shown" }));

		const section = screen.getByRole("region", { name: "Public link" });
		expect((await within(section).findByRole("alert")).textContent).toBe(
			"This item is being moved. Try again when the Move ends.",
		);
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	test("shows the flag without a select to a manager who cannot edit the image", () => {
		mockShareState({ ...IMAGE_SHARE, public: { ...IMAGE_SHARE.public, isPublic: true, canChange: false } });
		renderModal();
		const flag = document.querySelector("[data-share-public]") as HTMLElement;
		expect(flag.dataset.sharePublic).toBe("on");
		expect(flag.textContent).toContain("Public documents that use this image show it.");
		expect(screen.queryByRole("combobox", { name: "Inside public documents" })).toBeNull();
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
