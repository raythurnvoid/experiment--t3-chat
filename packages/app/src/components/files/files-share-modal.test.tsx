import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { queryMock, mediaQueryMock, pageMock, mutationMock, anagraphicsMock, toastSuccessMock, toastErrorMock } =
	vi.hoisted(() => ({
		queryMock: vi.fn(),
		mediaQueryMock: vi.fn(),
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
		query: (...args: unknown[]) => mediaQueryMock(...args),
	},
	app_convex_api: {
		files_share_links: { get_media_to_share: "media_to_share" },
		files_sharing: {
			get_node_share_state: "sharing",
			set_node_share_grant: "set_grant",
			remove_node_share_grant: "remove_grant",
			restrict_node: "restrict_node",
			unrestrict_node: "unrestrict_node",
			set_node_share_link: "set_link",
			set_node_public: "set_public",
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
		servicePluginName: string | null;
	}[],
	access: "restricted_root",
	canAddPeople: true,
	inheritedFrom: { restricted: null, extended: [] },
	link: null as { token: string; createdBy: string; createdAt: number } | null,
	public: "off" as "on" | "inherited" | "off",
};

/**
 * A manager's view of a file, not a folder, so the public link section shows.
 */
const FILE_SHARE = { ...SHARE, nodeName: "notes.md", nodeKind: "file", scope: null, access: "inherits" };

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
	access: "inherits",
	inheritedFrom: {
		restricted: {
			nodeId: "node_0",
			name: "Team",
			path: "/Team",
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
	mediaQueryMock.mockReset().mockResolvedValue({ media: [] });
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
		await waitForDialogFocus();
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
		await waitForDialogFocus();
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

	test("lists the restricted folder's people on an item inside it", () => {
		const entry = {
			principal: { kind: "service_account", serviceAccountId: "account_1" },
			level: "read",
			serviceAccountName: "Report bot",
			servicePluginName: null,
		};
		mockShareState({
			...SHARE,
			scope: { nodeId: "node_0", name: "Reports", path: "/Reports", isSelf: false },
			access: "inherits",
			entries: [],
			inheritedFrom: {
				restricted: { nodeId: "node_0", name: "Reports", path: "/Reports", entries: [entry] },
				extended: [],
			},
		});

		renderModal();
		const row = document.querySelector('[data-share-principal="service_account:account_1"]') as HTMLElement;
		expect(row.textContent).toContain("Report bot");
	});

	test("add people is available on an open folder", () => {
		mockShareState(OPEN_SHARE);
		renderModal();

		expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
		expect(
			screen.getByText("They also get everything inside this folder, except restricted items inside it."),
		).toBeTruthy();
		expect(screen.getByText("Everyone in this workspace can open this.")).toBeTruthy();
		expect(screen.getByText("Nobody yet.")).toBeTruthy();
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

	test("restrict asks before removing people added here", async () => {
		mockShareState({
			...OPEN_SHARE,
			access: "extended_root",
			entries: [
				{
					principal: { kind: "user", userId: "user_1" },
					level: "read",
					serviceAccountName: null,
					servicePluginName: null,
				},
			],
		});
		renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Restrict access" }));

		expect(screen.getByRole("alert").textContent).toBe(
			"Only you will have access. People added here (1) will lose access. You can add people again after.",
		);
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Restrict" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("restrict_node", { membershipId: "membership_1", nodeId: "node_1" }),
		);
	});

	test("inherited access names the folder it comes from", async () => {
		mockShareState(INSIDE_SHARE);
		renderModal();

		const line = document.querySelector('[data-share-inherited="node_0"]') as HTMLElement;
		expect(within(line).getByRole("heading", { name: 'From "Team" (restricted)' })).toBeTruthy();
		const row = line.querySelector('[data-share-principal="user:user_1"]') as HTMLElement;
		expect(row.textContent).toContain("Ada");
		// A row from the folder above is read-only here.
		expect(within(row).queryByRole("combobox")).toBeNull();

		fireEvent.click(within(line).getByRole("button", { name: "Manage on Team" }));
		await waitFor(() =>
			expect(queryMock).toHaveBeenCalledWith("sharing", { membershipId: "membership_1", nodeId: "node_0" }),
		);
	});

	test("inherited names are hidden from a viewer who cannot manage that folder", () => {
		mockShareState({
			...INSIDE_SHARE,
			canManage: false,
			canAddPeople: false,
			inheritedFrom: { restricted: { ...INSIDE_SHARE.inheritedFrom.restricted, entries: null }, extended: [] },
		});
		renderModal();

		const line = document.querySelector('[data-share-inherited="node_0"]') as HTMLElement;
		expect(within(line).getByRole("heading", { name: 'From "Team" (restricted)' })).toBeTruthy();
		expect(line.querySelector("[data-share-principal]")).toBeNull();
		expect(screen.queryByRole("button", { name: "Manage on Team" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
	});

	test("the level select has no manage on an Add-people item", async () => {
		mockShareState(OPEN_SHARE);
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Access level for the new person, role, or account" }));

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

	test("makes a file public and shows a refusal beside the control", async () => {
		mockShareState(FILE_SHARE);
		mutationMock.mockResolvedValue({ _yay: { public: "on" } });
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Anyone on the web" }));
		fireEvent.click(await screen.findByRole("option", { name: "Public" }));

		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Made public"));
		expect(mutationMock).toHaveBeenCalledWith("set_public", {
			membershipId: "membership_1",
			nodeId: "node_1",
			enabled: true,
		});
		cleanup();

		mutationMock.mockResolvedValue({ _nay: { message: "This item is being moved. Try again when the Move ends." } });
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Anyone on the web" }));
		fireEvent.click(await screen.findByRole("option", { name: "Public" }));

		const section = screen.getByRole("region", { name: "Anyone on the web" });
		expect((await within(section).findByRole("alert")).textContent).toBe(
			"This item is being moved. Try again when the Move ends.",
		);
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	test("hides the public control inside a public folder and from a non-manager", () => {
		mockShareState({ ...FILE_SHARE, public: "inherited" });
		renderModal();
		const section = document.querySelector("[data-share-public]") as HTMLElement;
		expect(section.dataset.sharePublic).toBe("inherited");
		expect(section.textContent).toContain("A public folder above makes this file public.");
		expect(screen.queryByRole("combobox", { name: "Anyone on the web" })).toBeNull();
		cleanup();

		mockShareState({ ...FILE_SHARE, canManage: false });
		renderModal();
		expect(document.querySelector("[data-share-public]")).toBeNull();
	});

	test("lists the media of a linked file and makes a readable image public", async () => {
		mockShareState({ ...FILE_SHARE, link: LINK });
		const photo = { available: true, kind: "image", nodeId: "image_1", name: "Photo.png", canManage: true };
		mediaQueryMock
			.mockResolvedValueOnce({
				media: [
					{ ...photo, isPublic: false },
					{ available: false, kind: "video", isPublic: false },
				],
			})
			// The new answer can list the rows in another order.
			.mockResolvedValueOnce({
				media: [
					{ available: false, kind: "video", isPublic: false },
					{ ...photo, isPublic: true },
				],
			});
		mutationMock.mockResolvedValue({ _yay: { public: "on" } });
		renderModal();
		await waitForDialogFocus();
		// The list reads the whole file, so it loads only on request.
		expect(mediaQueryMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Check images and videos" }));
		fireEvent.click(await screen.findByRole("button", { name: "Make Photo.png public" }));
		// A file the caller cannot open stays unnamed and has no button.
		expect(screen.getByText("This video is not public, and you cannot open it.")).toBeTruthy();

		await waitFor(() => expect(document.querySelector('[data-share-media="public"]')).toBeTruthy());
		expect(screen.queryByRole("alert")).toBeNull();
		// The clicked button is gone, so focus must not fall out of the dialog.
		expect(document.activeElement).toBe(screen.getByRole("list", { name: "Images and videos in the public link" }));
		expect(mutationMock).toHaveBeenCalledWith("set_public", {
			membershipId: "membership_1",
			nodeId: "image_1",
			enabled: true,
		});
		expect(mediaQueryMock).toHaveBeenCalledTimes(2);
		expect(mediaQueryMock).toHaveBeenCalledWith("media_to_share", { membershipId: "membership_1", nodeId: "node_1" });
	});

	test("says when a public image still cannot show, and shows rows the caller cannot change", async () => {
		mockShareState({ ...FILE_SHARE, link: LINK });
		const photo = {
			available: true,
			kind: "image",
			nodeId: "image_1",
			name: "Photo.png",
			canManage: true,
			isPublic: false,
		};
		const media = [
			photo,
			{ available: true, kind: "image", nodeId: "image_2", name: "Logo.png", canManage: false, isPublic: false },
			{ available: false, kind: "image", isPublic: true },
		];
		// The second answer still hides the photo, for example while its upload finishes.
		mediaQueryMock.mockResolvedValue({ media });
		mutationMock.mockResolvedValue({ _yay: { public: "on" } });
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("button", { name: "Check images and videos" }));
		fireEvent.click(await screen.findByRole("button", { name: "Make Photo.png public" }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"This file is public, but this page cannot show it yet. It may still be uploading.",
		);
		expect(screen.queryByRole("button", { name: "Make Logo.png public" })).toBeNull();
		const logoRow = screen.getByText("Logo.png").closest("li")!;
		expect(within(logoRow).getByText("Not public")).toBeTruthy();
		expect(screen.getByText("This image is public.")).toBeTruthy();
	});

	test("says an item stays public when a folder above still makes it public", async () => {
		mockShareState({ ...FILE_SHARE, public: "on" });
		// Like the live query, the dialog reads the new state after the write.
		mutationMock.mockImplementation(async () => {
			mockShareState({ ...FILE_SHARE, public: "inherited" });
			return { _yay: { public: "inherited" } };
		});
		renderModal();
		await waitForDialogFocus();
		fireEvent.click(screen.getByRole("combobox", { name: "Anyone on the web" }));
		fireEvent.click(await screen.findByRole("option", { name: "Not public" }));

		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Still public through a folder above"));
		// The select is gone for an inherited item, so focus must not fall out of the dialog.
		await waitFor(() => expect(screen.queryByRole("combobox", { name: "Anyone on the web" })).toBeNull());
		expect(document.activeElement).toBe(document.querySelector('[data-share-public="inherited"]'));
		expect(mutationMock).toHaveBeenCalledWith("set_public", {
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
