/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { queryMock, consentMock, mutationMock, store } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	consentMock: vi.fn(),
	mutationMock: vi.fn(),
	store: { revision: 0, listeners: new Set<() => void>() },
}));

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	const useQuery = (...args: unknown[]) => {
		const revision = useSyncExternalStore(
			(listener) => {
				store.listeners.add(listener);
				return () => {
					store.listeners.delete(listener);
				};
			},
			() => store.revision,
		);
		return revision < 0 ? undefined : queryMock(...args);
	};
	return { useQuery, usePaginatedQuery: useQuery };
});

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership_1" }) },
}));
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		access_control: { get_current_user_workspace_permission: "workspace_permission" },
		files_nodes: { get_visible_target_by_path: "visible_target" },
		plugins: { list_published_plugins: "catalog" },
		plugins_access: {
			get_my_run_as_grant: "my_grant",
			grant_run_as_me: "grant_me",
			revoke_run_as_me: "revoke_me",
			list_my_file_grants: "file_grants",
			grant_file_access_as_me: "grant_file",
			revoke_file_access_as_me: "revoke_file",
		},
	},
}));

import { useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { PluginsMyFilePermissions, PluginsMyRunPermissions, PluginsRunConsent } from "./plugins-run-consent.tsx";

function TestConsent(props: { capabilities?: string[]; canManage?: boolean }) {
	const { membershipId } = AppTenantProvider.useContext();
	return (
		<PluginsRunConsent
			membershipId={membershipId}
			capabilities={props.capabilities ?? ["workspace.files.read"]}
			canManage={props.canManage ?? true}
			onChange={consentMock}
		/>
	);
}

function TestMyPermissions() {
	const { membershipId } = AppTenantProvider.useContext();
	const plugin = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId })?.at(0);
	return plugin?.installationId ? (
		<PluginsMyRunPermissions membershipId={membershipId} installationId={plugin.installationId} canManage={false} />
	) : null;
}

function TestMyFilePermissions() {
	const { membershipId } = AppTenantProvider.useContext();
	const plugin = useQuery(app_convex_api.plugins.list_published_plugins, { membershipId })?.at(0);
	return plugin?.installationId ? (
		<PluginsMyFilePermissions membershipId={membershipId} installationId={plugin.installationId} />
	) : null;
}

function refreshQueries() {
	act(() => {
		store.revision += 1;
		for (const listener of store.listeners) listener();
	});
}

beforeEach(() => {
	queryMock
		.mockReset()
		.mockImplementation((query: string) =>
			query === "workspace_permission" ? true : query === "catalog" ? [{ installationId: "installation_1" }] : null,
		);
	mutationMock.mockReset().mockResolvedValue({ _yay: null });
	consentMock.mockReset();
});

afterEach(cleanup);

describe("PluginsRunConsent", () => {
	test("allows personal file operations without a workspace or file proof", async () => {
		queryMock.mockImplementation((query: string) => (query === "workspace_permission" ? false : null));
		render(<TestConsent />);
		expect(
			queryMock.mock.calls.filter(([query, args]) => query === "workspace_permission" && args !== "skip"),
			"personal Files consent must skip the workspace Read query",
		).toEqual([]);
		expect(
			screen.queryByRole("textbox", { name: "Readable file or folder path" }),
			"personal run consent must not show a file proof path",
		).toBeNull();
		expect(screen.getByRole("checkbox", { name: "List my selected files" })).toHaveProperty("checked", true);
		expect(screen.getByRole("checkbox", { name: "Read my selected files" })).toHaveProperty("checked", true);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock, "personal run consent must not need a file proof").toHaveBeenLastCalledWith({
				scopes: ["files:list", "files:read"],
			}),
		);
	});

	test("keeps stored data checks separate from personal file operations", async () => {
		queryMock.mockImplementation((query: string) => (query === "workspace_permission" ? false : null));
		render(
			<TestConsent
				capabilities={["workspace.files.read", "plugin.data.read", "plugin.data.write"]}
				canManage={false}
			/>,
		);
		expect(queryMock).toHaveBeenCalledWith("workspace_permission", {
			membershipId: "membership_1",
			permission: "content.read",
		});
		expect(screen.getByRole("checkbox", { name: "Read this plugin's stored data" })).toHaveProperty("disabled", true);
		expect(screen.getByRole("checkbox", { name: "Write this plugin's stored data" })).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["files:list", "files:read"] }));
	});

	test("keeps consent empty until the user explicitly allows Me", async () => {
		render(<TestConsent />);
		expect(consentMock).toHaveBeenLastCalledWith(null);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({
				scopes: ["files:list", "files:read"],
			}),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		expect(consentMock).toHaveBeenLastCalledWith(null);
	});

	test("allows a list-only grant and uses only the accepted live capabilities", async () => {
		render(<TestConsent capabilities={["workspace.files.read", "plugin.schedule.run"]} canManage={false} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Read my selected files" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["files:list"] }));
		expect(screen.queryByRole("checkbox", { name: /Write read-only Mounts/ })).toBeNull();
	});

	test("offers a viewer only live plugin data read permission", async () => {
		queryMock.mockImplementation((query: string, args: { permission?: string } | "skip") =>
			query === "workspace_permission" && args !== "skip" ? args.permission === "content.read" : null,
		);
		render(<TestConsent capabilities={["plugin.data.read", "plugin.data.write"]} canManage={false} />);
		expect(
			screen.getByRole("checkbox", { name: "Write this plugin's stored data" }),
			"a viewer must not be offered plugin data write permission",
		).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["plugin_data:read"] }));
	});

	test("clears plugin data write when read is unchecked or live write is lost", async () => {
		let canWrite = true;
		queryMock.mockImplementation((query: string, args: { permission?: string } | "skip") =>
			query === "workspace_permission" && args !== "skip" ? args.permission === "content.read" || canWrite : null,
		);
		render(<TestConsent capabilities={["plugin.data.read", "plugin.data.write"]} canManage={false} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({
				scopes: ["plugin_data:read", "plugin_data:write"],
			}),
		);
		const read = screen.getByRole("checkbox", { name: "Read this plugin's stored data" });
		const write = screen.getByRole("checkbox", { name: "Write this plugin's stored data" });
		fireEvent.click(read);
		expect(write, "plugin data write must not remain selected without read").toHaveProperty("checked", false);
		expect(write).toHaveProperty("disabled", true);
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [] }));
		fireEvent.click(read);
		expect(write).toHaveProperty("checked", false);
		fireEvent.click(write);
		canWrite = false;
		refreshQueries();
		expect(write).toHaveProperty("checked", false);
		expect(write).toHaveProperty("disabled", true);
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["plugin_data:read"] }));
	});

	test("keeps management scopes unchecked for a member without installation management", async () => {
		render(
			<TestConsent
				capabilities={["plugin.schedule.run", "workspace.volumes.write", "plugin.secrets.read", "outbound.fetch"]}
				canManage={false}
			/>,
		);
		expect(screen.getByRole("checkbox", { name: "Write read-only Mounts, billed to the owner" })).toHaveProperty(
			"disabled",
			true,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [] }));
	});

	test("narrows a draft when accepted capabilities or management access change", async () => {
		const { rerender } = render(<TestConsent capabilities={["workspace.volumes.write"]} canManage />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["volumes:write"] }));
		rerender(<TestConsent capabilities={["workspace.volumes.write"]} canManage={false} />);
		expect(screen.getByRole("checkbox", { name: "Write read-only Mounts, billed to the owner" })).toHaveProperty(
			"checked",
			false,
		);
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [] }));
		rerender(<TestConsent capabilities={["plugin.schedule.run"]} canManage={false} />);
		expect(screen.queryByRole("checkbox", { name: /Write read-only Mounts/ })).toBeNull();
		expect(consentMock).toHaveBeenLastCalledWith({ scopes: [] });
	});
});

describe("PluginsMyRunPermissions", () => {
	test("uses personal file choices for saved run permissions", () => {
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "my_grant"
					? {
							capabilities: ["workspace.files.read"],
							isAssigned: true,
							grant: { grantId: "grant_1", scopes: ["files:list", "files:read"], valid: true },
						}
					: null,
		);
		render(<TestMyPermissions />);
		expect(
			screen.queryByRole("checkbox", { name: "Read my selected files" }),
			"saved personal run controls must use selected-file labels",
		).not.toBeNull();
		expect(
			screen.getByText("Permission granted for this workspace membership. File access comes from My file permissions."),
		).not.toBeNull();
	});

	test("saves only the member's direct consent and shows a refusal inline", async () => {
		const permission = {
			pluginName: "importer",
			displayName: "Importer",
			capabilities: ["plugin.schedule.run"],
			isAssigned: false,
			grant: null,
		};
		queryMock.mockImplementation((query: string) =>
			query === "catalog" ? [{ installationId: "installation_1" }] : query === "my_grant" ? permission : null,
		);
		mutationMock.mockResolvedValue({ _nay: { message: "Permission denied" } });
		render(<TestMyPermissions />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Save my run permissions" })).toHaveProperty("disabled", false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save my run permissions" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("grant_me", {
				membershipId: "membership_1",
				installationId: "installation_1",
				scopes: [],
			}),
		);
		expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty("userId");
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Permission denied");
	});

	test("explains membership validity and revokes through the self-only door", async () => {
		const permission = {
			pluginName: "importer",
			displayName: "Importer",
			capabilities: ["plugin.schedule.run"],
			isAssigned: true,
			grant: { grantId: "grant_1", scopes: [], valid: true },
		};
		queryMock.mockImplementation((query: string) =>
			query === "catalog" ? [{ installationId: "installation_1" }] : query === "my_grant" ? permission : null,
		);
		render(<TestMyPermissions />);
		expect(
			screen.getByText("Permission granted for this workspace membership. File access comes from My file permissions."),
		).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Revoke my run permissions" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("revoke_me", {
				membershipId: "membership_1",
				installationId: "installation_1",
			}),
		);
		expect(
			await screen.findByText("Your run permissions were revoked. Work running as you was stopped."),
		).not.toBeNull();
	});
});

describe("PluginsMyFilePermissions", () => {
	test("shows that personal file choices are active", () => {
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [], status: "Exhausted", loadMore: vi.fn() }
					: null,
		);
		render(<TestMyFilePermissions />);
		expect(
			screen.queryByText("Plugins do not use these choices yet. They will after a later update."),
			"personal file controls must not claim that choices are inactive",
		).toBeNull();
		expect(
			screen.getByText(
				"Access changes apply in the background. The plugin keeps its current access until each change finishes.",
			),
		).not.toBeNull();
	});

	test("requires an explicit saved target and saves file consent without run consent", async () => {
		let target = { target: { kind: "saved", id: "folder_1" }, kind: "folder" };
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [], status: "Exhausted", loadMore: vi.fn() }
					: query === "visible_target"
						? target
						: null,
		);
		render(<TestMyFilePermissions />);
		const path = screen.getByRole("textbox", { name: "File or folder path" });
		fireEvent.change(path, { target: { value: "/shared" } });
		const save = screen.getByRole("button", { name: "Save" });
		expect(save, "lookup alone must not select the target").toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "Use this folder: /shared" }));
		fireEvent.click(screen.getByRole("radio", { name: "Can edit" }));
		fireEvent.click(save);
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("grant_file", {
				membershipId: "membership_1",
				installationId: "installation_1",
				rootNodeId: "folder_1",
				level: "write",
			}),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		const feedback = await screen.findByText("Your file permission was saved. The change is pending.");
		await waitFor(() => expect(document.activeElement, "Save must focus its feedback").toBe(feedback));
		expect(screen.queryByRole("checkbox", { name: /Allow this plugin to run/ })).toBeNull();
		target = { target: { kind: "saved", id: "folder_2" }, kind: "folder" };
		refreshQueries();
		expect(save, "a replaced saved target needs a new explicit choice").toHaveProperty("disabled", true);
	});

	test("shows chosen and current access, pending and ended text, and loads only the next page", () => {
		const loadMore = vi.fn();
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? {
							results: [
								{
									consentId: "consent_1",
									path: "/shared",
									requestedLevel: "write",
									appliedLevel: "read",
									state: "pending",
									open: true,
									endedReason: null,
								},
								{
									consentId: "consent_2",
									path: null,
									requestedLevel: "read",
									appliedLevel: null,
									state: "ended",
									open: false,
									endedReason: "Access ended.",
								},
							],
							status: "CanLoadMore",
							loadMore,
						}
					: null,
		);
		render(<TestMyFilePermissions />);
		expect(screen.getByText("Chosen: Can edit")).not.toBeNull();
		expect(screen.getByText("Current: Can view")).not.toBeNull();
		expect(screen.getByText("Change pending.")).not.toBeNull();
		expect(screen.getByText("Ended. Access ended.")).not.toBeNull();
		expect(screen.queryByText("Unavailable item"), "a missing path must not claim the item was deleted").not.toBeNull();
		expect(screen.getByText("Current: No access")).not.toBeNull();
		expect(loadMore, "render must not drain the whole list").not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(loadMore).toHaveBeenCalledExactlyOnceWith(20);
		expect(queryMock).toHaveBeenCalledWith(
			"file_grants",
			{
				membershipId: "membership_1",
				installationId: "installation_1",
			},
			{ initialNumItems: 20 },
		);
	});

	test.each([
		["Can view", "read"],
		["Can edit", "write"],
	])("saves whole-workspace %s with no saved root", async (label, level) => {
		const response = Promise.withResolvers<{ _yay: { consentId: string } }>();
		mutationMock.mockReturnValue(response.promise);
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [], status: "Exhausted", loadMore: vi.fn() }
					: query === "visible_target"
						? { target: { kind: "saved", id: "folder_1" }, kind: "folder" }
						: null,
		);
		render(<TestMyFilePermissions />);
		const fileScope = screen.getByRole("radio", { name: "File or folder" });
		const workspaceScope = screen.getByRole("radio", { name: "Whole workspace" });
		const view = screen.getByRole("radio", { name: "Can view" });
		expect(fileScope).toHaveProperty("checked", true);
		expect(workspaceScope.getAttribute("name")).not.toBe(view.getAttribute("name"));
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toHaveProperty("disabled", true);
		fireEvent.change(screen.getByRole("textbox", { name: "File or folder path" }), {
			target: { value: "/shared" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Use this folder: /shared" }));
		workspaceScope.focus();
		expect(document.activeElement, "the workspace choice must keep native radio focus").toBe(workspaceScope);
		fireEvent.click(workspaceScope);
		fireEvent.click(screen.getByRole("radio", { name: label }));
		expect(workspaceScope).toHaveProperty("checked", true);
		expect(screen.queryByRole("textbox", { name: "File or folder path" })).toBeNull();
		expect(
			screen.getByText("Includes current and future open files. Restricted folders need separate permission."),
		).not.toBeNull();
		fireEvent.click(save);
		expect(mutationMock, "workspace consent must send null instead of the earlier saved folder").toHaveBeenCalledWith(
			"grant_file",
			{ membershipId: "membership_1", installationId: "installation_1", rootNodeId: null, level },
		);
		expect(workspaceScope).toHaveProperty("disabled", true);
		expect(fileScope).toHaveProperty("disabled", true);
		expect(view).toHaveProperty("disabled", true);
		expect(save.getAttribute("aria-busy")).toBe("true");
		fireEvent.click(save);
		expect(mutationMock, "a pending save must not submit again").toHaveBeenCalledTimes(1);
		await act(async () => response.resolve({ _yay: { consentId: "workspace_consent" } }));
		const feedback = await screen.findByText("Your file permission was saved. The change is pending.");
		await waitFor(() => expect(document.activeElement).toBe(feedback));
		expect(workspaceScope).toHaveProperty("disabled", false);
	});

	test("stops saved path lookups while whole workspace is selected", () => {
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [], status: "Exhausted", loadMore: vi.fn() }
					: null,
		);
		render(<TestMyFilePermissions />);
		fireEvent.change(screen.getByRole("textbox", { name: "File or folder path" }), {
			target: { value: "/shared" },
		});
		queryMock.mockClear();
		fireEvent.click(screen.getByRole("radio", { name: "Whole workspace" }));
		expect(queryMock, "workspace consent must skip the saved-path lookup").toHaveBeenCalledWith(
			"visible_target",
			"skip",
		);
		expect(queryMock).not.toHaveBeenCalledWith("visible_target", { membershipId: "membership_1", path: "/shared" });
		fireEvent.click(screen.getByRole("radio", { name: "File or folder" }));
		expect(queryMock).toHaveBeenCalledWith("visible_target", { membershipId: "membership_1", path: "/shared" });
		expect(screen.getByRole("button", { name: "Save" }), "changing scope must not select a saved path").toHaveProperty(
			"disabled",
			true,
		);
	});

	test("keeps the whole-workspace label after removal and removes only that consent", async () => {
		let grant = {
			consentId: "workspace_consent",
			rootNodeId: null,
			path: "/",
			requestedLevel: "read",
			appliedLevel: "read" as string | null,
			state: "applied",
			open: true,
			endedReason: null as string | null,
		};
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [grant], status: "Exhausted", loadMore: vi.fn() }
					: null,
		);
		render(<TestMyFilePermissions />);
		const row = screen.getByRole("listitem");
		expect(within(row).queryByText("Whole workspace"), "workspace history must name its scope").not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Remove permission for whole workspace" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("revoke_file", {
				membershipId: "membership_1",
				installationId: "installation_1",
				consentId: "workspace_consent",
			}),
		);
		const feedback = await screen.findByText("Your file permission was removed.");
		await waitFor(() => expect(document.activeElement).toBe(feedback));
		grant = { ...grant, appliedLevel: null, state: "ended", open: false, endedReason: "You removed this permission." };
		refreshQueries();
		expect(within(row).queryByText("Whole workspace"), "ended workspace consent must keep its scope").not.toBeNull();
		expect(within(row).getByText("Ended. You removed this permission.")).not.toBeNull();
		expect(within(row).getByText("Current: No access")).not.toBeNull();
		expect(within(row).queryByRole("button")).toBeNull();
	});

	test("removes a selection without looking up its file and focuses the result", async () => {
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? {
							results: [
								{
									consentId: "consent_1",
									path: "/unreadable",
									requestedLevel: "read",
									appliedLevel: "read",
									state: "applied",
									open: true,
									endedReason: null,
								},
							],
							status: "Exhausted",
							loadMore: vi.fn(),
						}
					: null,
		);
		render(<TestMyFilePermissions />);
		fireEvent.click(screen.getByRole("button", { name: "Remove permission for /unreadable" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("revoke_file", {
				membershipId: "membership_1",
				installationId: "installation_1",
				consentId: "consent_1",
			}),
		);
		const feedback = await screen.findByText("Your file permission was removed.");
		await waitFor(() => expect(document.activeElement, "Remove must focus its feedback").toBe(feedback));
		expect(queryMock).toHaveBeenCalledWith("visible_target", "skip");
	});

	test("refuses a private draft as a selected saved target", () => {
		queryMock.mockImplementation((query: string) =>
			query === "catalog"
				? [{ installationId: "installation_1" }]
				: query === "file_grants"
					? { results: [], status: "Exhausted", loadMore: vi.fn() }
					: query === "visible_target"
						? { target: { kind: "private", id: "draft_1" }, kind: "file" }
						: null,
		);
		render(<TestMyFilePermissions />);
		const path = screen.getByRole("textbox", { name: "File or folder path" });
		fireEvent.change(path, { target: { value: "/draft" } });
		fireEvent.blur(path);
		expect(screen.getByRole("alert")).toHaveProperty("textContent", "Choose a saved file or folder you can read.");
		expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();
	});
});
