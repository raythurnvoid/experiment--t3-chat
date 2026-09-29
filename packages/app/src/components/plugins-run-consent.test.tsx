/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { queryMock, consentMock, mutationMock, store } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	consentMock: vi.fn(),
	mutationMock: vi.fn(),
	store: { revision: 0, listeners: new Set<() => void>() },
}));

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQuery: (...args: unknown[]) => {
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
		},
	};
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
		plugins_access: { get_my_run_as_grant: "my_grant", grant_run_as_me: "grant_me", revoke_run_as_me: "revoke_me" },
	},
}));

import { useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { PluginsMyRunPermissions, PluginsRunConsent } from "./plugins-run-consent.tsx";

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
	test("keeps consent empty until the user explicitly allows Me", async () => {
		render(<TestConsent />);
		expect(consentMock).toHaveBeenLastCalledWith(null);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({
				scopes: ["files:list", "files:read"],
				filesReadProof: { kind: "workspace" },
			}),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		expect(consentMock).toHaveBeenLastCalledWith(null);
	});

	test("uses a readable saved folder as proof and drops it after replacement", async () => {
		let target = { target: { kind: "saved", id: "folder_1" }, kind: "folder" };
		queryMock.mockImplementation((query: string, args: { path?: string } | "skip") =>
			query === "workspace_permission"
				? false
				: query === "visible_target" && args !== "skip" && args.path === "/shared"
					? target
					: null,
		);
		render(<TestConsent />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		const path = screen.getByRole("textbox", { name: "Readable file or folder path" });
		fireEvent.change(path, { target: { value: "/shared" } });
		expect(consentMock).toHaveBeenLastCalledWith(null);
		fireEvent.click(await screen.findByRole("button", { name: "Use this folder: /shared" }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({
				scopes: ["files:list", "files:read"],
				filesReadProof: { kind: "file", nodeId: "folder_1" },
			}),
		);
		target = { target: { kind: "saved", id: "folder_2" }, kind: "folder" };
		refreshQueries();
		expect(consentMock, "a replacement must not keep the old saved-target proof").toHaveBeenLastCalledWith(null);
		fireEvent.click(screen.getByRole("button", { name: "Use this folder: /shared" }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith(
				expect.objectContaining({ filesReadProof: { kind: "file", nodeId: "folder_2" } }),
			),
		);
		fireEvent.change(path, { target: { value: "/missing" } });
		expect(consentMock).toHaveBeenLastCalledWith(null);
	});

	test.each(["unavailable", "private"])("does not accept a %s path as saved Files proof", async (kind) => {
		queryMock.mockImplementation((query: string) =>
			query === "workspace_permission"
				? false
				: query === "visible_target"
					? kind === "private"
						? { target: { kind: "private", id: "draft_1" }, kind: "file" }
						: null
					: null,
		);
		render(<TestConsent />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		const path = screen.getByRole("textbox", { name: "Readable file or folder path" });
		fireEvent.change(path, { target: { value: "/candidate" } });
		fireEvent.blur(path);
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"Choose a saved file or folder you can read.",
		);
		expect(path).toHaveProperty("validity.valid", false);
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();
		expect(consentMock).toHaveBeenLastCalledWith(null);
	});

	test("allows a list-only grant and uses only the accepted live capabilities", async () => {
		render(<TestConsent capabilities={["workspace.files.read", "plugin.schedule.run"]} canManage={false} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Read files I can read" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["files:list"], filesReadProof: { kind: "workspace" } }),
		);
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
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["plugin_data:read"], filesReadProof: undefined }),
		);
	});

	test.each(["file", "folder"] as const)(
		"keeps a readable %s proof available without workspace KV access",
		async (kind) => {
			queryMock.mockImplementation((query: string) =>
				query === "workspace_permission"
					? false
					: query === "visible_target"
						? { target: { kind: "saved", id: "node_1" }, kind }
						: null,
			);
			render(
				<TestConsent
					capabilities={["workspace.files.read", "plugin.data.read", "plugin.data.write"]}
					canManage={false}
				/>,
			);
			expect(screen.getByRole("checkbox", { name: "Read this plugin's stored data" })).toHaveProperty("disabled", true);
			expect(screen.getByRole("checkbox", { name: "Write this plugin's stored data" })).toHaveProperty(
				"disabled",
				true,
			);
			fireEvent.change(screen.getByRole("textbox", { name: "Readable file or folder path" }), {
				target: { value: "/shared" },
			});
			fireEvent.click(screen.getByRole("button", { name: `Use this ${kind}: /shared` }));
			fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
			await waitFor(() =>
				expect(consentMock).toHaveBeenLastCalledWith({
					scopes: ["files:list", "files:read"],
					filesReadProof: { kind: "file", nodeId: "node_1" },
				}),
			);
		},
	);

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
				filesReadProof: undefined,
			}),
		);
		const read = screen.getByRole("checkbox", { name: "Read this plugin's stored data" });
		const write = screen.getByRole("checkbox", { name: "Write this plugin's stored data" });
		fireEvent.click(read);
		expect(write, "plugin data write must not remain selected without read").toHaveProperty("checked", false);
		expect(write).toHaveProperty("disabled", true);
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [], filesReadProof: undefined }));
		fireEvent.click(read);
		expect(write).toHaveProperty("checked", false);
		fireEvent.click(write);
		canWrite = false;
		refreshQueries();
		expect(write).toHaveProperty("checked", false);
		expect(write).toHaveProperty("disabled", true);
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["plugin_data:read"], filesReadProof: undefined }),
		);
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
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [], filesReadProof: undefined }));
	});

	test("narrows a draft when accepted capabilities or management access change", async () => {
		const { rerender } = render(<TestConsent capabilities={["workspace.volumes.write"]} canManage />);
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(consentMock).toHaveBeenLastCalledWith({ scopes: ["volumes:write"], filesReadProof: undefined }),
		);
		rerender(<TestConsent capabilities={["workspace.volumes.write"]} canManage={false} />);
		expect(screen.getByRole("checkbox", { name: "Write read-only Mounts, billed to the owner" })).toHaveProperty(
			"checked",
			false,
		);
		await waitFor(() => expect(consentMock).toHaveBeenLastCalledWith({ scopes: [], filesReadProof: undefined }));
		rerender(<TestConsent capabilities={["plugin.schedule.run"]} canManage={false} />);
		expect(screen.queryByRole("checkbox", { name: /Write read-only Mounts/ })).toBeNull();
		expect(consentMock).toHaveBeenLastCalledWith({ scopes: [], filesReadProof: undefined });
	});
});

describe("PluginsMyRunPermissions", () => {
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
				filesReadProof: undefined,
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
			screen.getByText(
				"Permission granted for this workspace membership. Each operation still checks your current access.",
			),
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
