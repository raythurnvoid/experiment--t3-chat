/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { editor as monaco_editor } from "monaco-editor";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tenantContextMock, useQueryMock, actionMock, mutationMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	actionMock: vi.fn(),
	mutationMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
	useLocation: () => ({ pathname: "/w/team/home/mcp-servers", searchStr: "" }),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		action: (...args: unknown[]) => actionMock(...args),
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		mcp_custom_servers: {
			list: "mcp_custom_servers.list",
			save: "mcp_custom_servers.save",
			test_connection: "mcp_custom_servers.test_connection",
			set_enabled: "mcp_custom_servers.set_enabled",
			remove: "mcp_custom_servers.remove",
		},
		plugins_mcp: {
			list_member_plugin_connections: "plugins_mcp.list_member_plugin_connections",
		},
		plugins_mcp_oauth: {
			disconnect: "plugins_mcp_oauth.disconnect",
			can_connect: "plugins_mcp_oauth.can_connect",
			start: "plugins_mcp_oauth.start",
		},
	},
}));

// Monaco cannot run in happy-dom, so the stub is a textarea honoring `value` and `onChange`. Its
// mount handle holds a model from the `monaco-editor` test stub, so the page can set markers on it.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect, useState } = await import("react");
	const { editor } = await import("monaco-editor");

	return {
		Editor: function Editor(props: {
			value?: string;
			options?: { ariaLabel?: string };
			onChange?: (value: string | undefined) => void;
			onMount?: (editor: unknown) => void;
		}) {
			const { value, options, onChange, onMount } = props;
			const [model] = useState(() => editor.createModel(value ?? ""));

			useEffect(() => {
				model.setValue(value ?? "");
			}, [model, value]);

			useEffect(() => {
				onMount?.({ getModel: () => model, updateOptions: () => {} });
			}, [model, onMount]);

			return (
				<textarea
					aria-label={options?.ariaLabel ?? "Editor"}
					value={value}
					onChange={(event) => onChange?.(event.currentTarget.value)}
				/>
			);
		},
	};
});

// This module configures the real monaco languages at import time, which the stub cannot serve.
vi.mock("@/lib/app-monaco-config.ts", () => ({ app_monaco_THEME_NAME_DARK: "app-dark" }));

vi.mock("@/components/my-modal.tsx", () => {
	const Passthrough = (props: { children?: ReactNode }) => <div>{props.children}</div>;
	return {
		MyModal: (props: { open?: boolean; children?: ReactNode }) =>
			props.open ? <div role="dialog">{props.children}</div> : null,
		MyModalCloseTrigger: () => null,
		MyModalDescription: Passthrough,
		MyModalFooter: Passthrough,
		MyModalHeader: Passthrough,
		MyModalHeading: Passthrough,
		MyModalPopover: Passthrough,
		MyModalScrollableArea: Passthrough,
	};
});

import { Route } from "./index.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

const GITHUB_VS_CODE_SNIPPET = JSON.stringify({
	servers: {
		github: {
			type: "http",
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: "Bearer ${input:github_mcp_pat}" },
		},
	},
	inputs: [{ type: "promptString", id: "github_mcp_pat", description: "GitHub Personal Access Token", password: true }],
});

const STDIO_SNIPPET = JSON.stringify({
	mcpServers: {
		filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
	},
});

const BROWSERBASE_MCP_REMOTE_SNIPPET = JSON.stringify({
	mcpServers: { browserbase: { command: "npx", args: ["mcp-remote", "https://mcp.browserbase.com/mcp"] } },
});

function saved_server(overrides: Record<string, unknown> = {}) {
	return {
		customServerId: "custom_1",
		name: "Linear",
		toolPrefix: "my-linear",
		url: "https://mcp.linear.app/mcp",
		host: "mcp.linear.app",
		enabled: true,
		auth: { kind: "headers" },
		headers: [
			{
				name: "Authorization",
				parts: [
					{ kind: "text", text: "Bearer " },
					{ kind: "secret", secretName: "LINEAR_AUTHORIZATION", set: true, updatedAt: 1_700_000_000_000 },
				],
			},
		],
		connection: null,
		policy: "allowed",
		health: "healthy",
		lastTest: { at: 1_700_000_000_000, outcome: "ok", toolCount: 12 },
		...overrides,
	};
}

function plugin_server(overrides: Record<string, unknown> = {}) {
	return {
		target: { kind: "plugin", installationId: "installation_1", serverId: "linear" },
		pluginName: "linear-plugin",
		serverTitle: "Linear",
		serverHost: "mcp.linear.app",
		authorizationHost: "linear.app",
		installationEnabled: true,
		health: "healthy",
		policy: "allowed",
		connection: null,
		...overrides,
	};
}

function setQueries(args: { canUse?: boolean; servers?: unknown[]; pluginServers?: unknown[] }) {
	const canUse = args.canUse ?? true;
	useQueryMock.mockImplementation((query: string) => {
		switch (query) {
			case "mcp_custom_servers.list":
				return { canUse, servers: args.servers ?? [] };
			case "plugins_mcp.list_member_plugin_connections":
				return { canUse, servers: args.pluginServers ?? [] };
			case "plugins_mcp_oauth.can_connect":
				return true;
			default:
				return undefined;
		}
	});
}

function paste(text: string) {
	fireEvent.change(screen.getByRole("textbox", { name: "MCP server config JSON" }), { target: { value: text } });
}

describe("RouteMcpServers", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});

		// The editor mounts only when the app's Monaco hoisting container exists, because the real
		// editor parks its overflow widgets there.
		const hoistingContainer = document.createElement("div");
		hoistingContainer.id = "app_monaco_hoisting_container";
		document.body.appendChild(hoistingContainer);
	});

	afterEach(() => {
		cleanup();
		document.getElementById("app_monaco_hoisting_container")?.remove();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	test("the VS Code GitHub snippet shows one card with one password field", () => {
		setQueries({});
		const { container } = render(<PageComponent />);

		paste(GITHUB_VS_CODE_SNIPPET);

		const cards = screen.getAllByRole("article");
		expect(cards).toHaveLength(1);
		expect(cards[0].getAttribute("data-mcp-draft-state")).toBe("needs_values");

		const secretField = screen.getByLabelText("Authorization (GITHUB_MCP_PAT)");
		expect(secretField.getAttribute("type")).toBe("password");
		expect(secretField.getAttribute("data-secret-state")).toBe("missing");
		expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
		expect(within(cards[0]).getByText("GitHub Personal Access Token")).not.toBeNull();

		fireEvent.change(secretField, { target: { value: "ghp_example" } });
		expect(secretField.getAttribute("data-secret-state")).toBe("set");
	});

	test("a stdio snippet shows the refusal", () => {
		setQueries({});
		render(<PageComponent />);

		paste(STDIO_SNIPPET);

		const card = screen.getByRole("article");
		expect(card.getAttribute("data-mcp-draft-state")).toBe("refused");
		expect(within(card).getByRole("alert").textContent).toContain("This server runs as a program on your computer");
		expect(within(card).queryByRole("button", { name: "Save filesystem" })).toBeNull();
	});

	test("an mcp-remote snippet says it uses the remote server instead", () => {
		setQueries({});
		render(<PageComponent />);

		paste(BROWSERBASE_MCP_REMOTE_SNIPPET);

		const card = screen.getByRole("article");
		expect(card.getAttribute("data-mcp-draft-state")).toBe("ready");
		expect(within(card).getByText(/Use the remote server instead/)).not.toBeNull();
		expect(within(card).getByText("https://mcp.browserbase.com/mcp")).not.toBeNull();
	});

	test("broken JSON shows the problem list and Monaco markers", () => {
		setQueries({});
		const setModelMarkers = vi.spyOn(monaco_editor, "setModelMarkers");
		render(<PageComponent />);

		paste('{\n  "mcpServers": {\n    "a": 1 2\n  }\n}');

		expect(screen.getByRole("status", { name: "Problems in the pasted text" }).textContent).toContain("Comma expected");
		const markers = setModelMarkers.mock.lastCall?.[2] as Array<{ message: string; startLineNumber: number }>;
		expect(markers[0]).toMatchObject({ message: "Comma expected", startLineNumber: 3 });
	});

	test("a saved row shows Set and never a value", () => {
		setQueries({ servers: [saved_server()] });
		render(<PageComponent />);

		const row = screen.getByRole("listitem", { name: "Linear" });
		expect(row.getAttribute("data-mcp-server-status")).toBe("ready");
		const secret = within(row).getByText("Set");
		expect(secret.getAttribute("data-secret-state")).toBe("set");
		expect(row.textContent).toContain("Last test: ok, 12 tools");
		for (const label of ["Test Linear", "Edit Linear", "Turn off Linear", "Delete Linear"]) {
			expect(within(row).getByRole("button", { name: label })).not.toBeNull();
		}
	});

	test("Edit fills the editor and Save keeps the stored secret", async () => {
		setQueries({ servers: [saved_server()] });
		actionMock.mockResolvedValueOnce({ _yay: { outcome: "ok", message: null, toolCount: 12, toolNames: [] } });
		actionMock.mockResolvedValue({ _yay: { customServerId: "custom_1", outcome: "ok", message: null, toolCount: 12 } });
		render(<PageComponent />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Test Linear" }));
		});
		expect(screen.getByText("Test passed. Found 12 tools.")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Edit Linear" }));

		const editor = screen.getByRole("textbox", { name: "MCP server config JSON" }) as HTMLTextAreaElement;
		const editedText = editor.value;
		expect(editedText).toContain("Bearer ${secret:LINEAR_AUTHORIZATION}");
		const secretField = screen.getByLabelText("Authorization (LINEAR_AUTHORIZATION)");
		expect(secretField.getAttribute("data-secret-state")).toBe("set");

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Save Linear" }));
		});

		expect(actionMock).toHaveBeenCalledWith("mcp_custom_servers.save", {
			membershipId: "membership_1",
			customServerId: "custom_1",
			text: editedText,
			draftKey: "Linear",
			fill: {
				name: "Linear",
				urlFields: [],
				notSecretHeaders: [],
				secretValues: [],
				keptSecretNames: ["LINEAR_AUTHORIZATION"],
			},
		});
		expect(screen.getByText("Saved Linear. Found 12 tools.")).not.toBeNull();
		expect(editor.value).toBe("");
		// The test result described the server before the edit.
		expect(screen.queryByText("Test passed. Found 12 tools.")).toBeNull();
	});

	test("an edit refuses a second server in the text", () => {
		setQueries({ servers: [saved_server()] });
		render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Edit Linear" }));
		paste(
			JSON.stringify({
				mcpServers: {
					Linear: { url: "https://mcp.linear.app/mcp" },
					other: { url: "https://mcp.example.com/mcp" },
				},
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save other" }));

		expect(actionMock).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toBe(
			"Edit one server at a time. Remove the other servers from the text, or cancel the edit.",
		);
	});

	test("a saved card stays saved after the text changes", async () => {
		setQueries({});
		actionMock.mockResolvedValue({ _yay: { customServerId: "custom_1", outcome: "ok", message: null, toolCount: 2 } });
		render(<PageComponent />);
		const twoServers = (otherUrl: string) =>
			JSON.stringify({ mcpServers: { first: { url: "https://mcp.example.com/mcp" }, second: { url: otherUrl } } });

		paste(twoServers("https://mcp.example.com/second"));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Save first" }));
		});
		paste(twoServers("https://mcp.example.com/fixed"));

		expect((screen.getByRole("button", { name: "Save first" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText("Saved first. Found 2 tools.")).not.toBeNull();
		expect((screen.getByRole("button", { name: "Save second" }) as HTMLButtonElement).disabled).toBe(false);
	});

	test("Edit waits for a running save, and a failed probe shows its message", async () => {
		setQueries({ servers: [saved_server()] });
		let finishSave = (_value: unknown) => {};
		actionMock.mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
		render(<PageComponent />);

		paste(JSON.stringify({ mcpServers: { first: { url: "https://mcp.example.com/mcp" } } }));
		fireEvent.click(screen.getByRole("button", { name: "Save first" }));

		expect((screen.getByRole("button", { name: "Edit Linear" }) as HTMLButtonElement).disabled).toBe(true);
		await act(async () => {
			finishSave({
				_yay: {
					customServerId: "custom_2",
					outcome: "network_error",
					message: "Press could not reach the MCP server.",
					toolCount: null,
				},
			});
		});
		expect(
			screen.getByText("Saved first, but the connection test failed: Press could not reach the MCP server."),
		).not.toBeNull();
		expect((screen.getByRole("button", { name: "Edit Linear" }) as HTMLButtonElement).disabled).toBe(false);
	});

	test("an edited address warns only when the member is signed in", () => {
		setQueries({
			servers: [saved_server({ connection: { status: "connected", scopes: [], connectedAt: 1_700_000_000_000 } })],
		});
		render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Edit Linear" }));
		const warning = "The server address changed. You will need to sign in again.";
		expect(screen.queryByText(warning)).toBeNull();

		const editor = screen.getByRole("textbox", { name: "MCP server config JSON" }) as HTMLTextAreaElement;
		paste(editor.value.replace("https://mcp.linear.app/mcp", "https://mcp.linear.app/v2/mcp"));
		expect(screen.getByText(warning)).not.toBeNull();
	});

	test("the Plugin servers section shows Disconnect for a connected sign-in server and Connect for the others", async () => {
		setQueries({
			pluginServers: [
				plugin_server({ connection: { status: "connected", scopes: ["read"], connectedAt: 1_700_000_000_000 } }),
				plugin_server({
					target: { kind: "plugin", installationId: "installation_1", serverId: "sentry" },
					serverTitle: "Sentry",
					authorizationHost: "sentry.io",
				}),
			],
		});
		mutationMock.mockResolvedValue({ _yay: null });
		render(<PageComponent />);

		const connected = screen.getByRole("listitem", { name: "Linear" });
		expect(connected.getAttribute("data-mcp-connection-status")).toBe("connected");
		expect(connected.textContent).toContain("You will sign in at linear.app");

		const notConnected = screen.getByRole("listitem", { name: "Sentry" });
		expect(notConnected.getAttribute("data-mcp-connection-status")).toBe("needs_sign_in");
		expect(within(connected).queryByRole("button", { name: "Connect Linear" })).toBeNull();
		expect(within(notConnected).queryByRole("button", { name: "Disconnect Sentry" })).toBeNull();

		await act(async () => {
			fireEvent.click(within(connected).getByRole("button", { name: "Disconnect Linear" }));
		});
		expect(mutationMock).toHaveBeenCalledWith("plugins_mcp_oauth.disconnect", {
			membershipId: "membership_1",
			target: { kind: "plugin", installationId: "installation_1", serverId: "linear" },
		});

		actionMock.mockResolvedValue({
			_yay: { authorizationUrl: "https://sentry.io/authorize?state=s", authorizationHost: "sentry.io" },
		});
		await act(async () => {
			fireEvent.click(within(notConnected).getByRole("button", { name: "Connect Sentry" }));
		});
		expect(actionMock).toHaveBeenCalledWith("plugins_mcp_oauth.start", {
			membershipId: "membership_1",
			target: { kind: "plugin", installationId: "installation_1", serverId: "sentry" },
			returnPath: "/w/team/home/mcp-servers",
		});
		expect(within(notConnected).getByRole("status").textContent).toBe("You will sign in at sentry.io");
	});

	test("a saved sign-in server shows Connect until it is connected, then Disconnect", async () => {
		const oauth = { kind: "oauth", authorizationHost: "linear.app" };
		setQueries({
			servers: [
				saved_server({ auth: oauth, headers: [] }),
				saved_server({
					customServerId: "custom_2",
					name: "Sentry",
					auth: oauth,
					headers: [],
					connection: { status: "connected", scopes: [], connectedAt: 1_700_000_000_000 },
				}),
			],
		});
		mutationMock.mockResolvedValue({ _yay: null });
		render(<PageComponent />);

		const notConnected = screen.getByRole("listitem", { name: "Linear" });
		expect(within(notConnected).getByRole("button", { name: "Connect Linear" })).not.toBeNull();
		expect(within(notConnected).queryByRole("button", { name: "Disconnect Linear" })).toBeNull();

		const connected = screen.getByRole("listitem", { name: "Sentry" });
		expect(within(connected).queryByRole("button", { name: "Connect Sentry" })).toBeNull();
		await act(async () => {
			fireEvent.click(within(connected).getByRole("button", { name: "Disconnect Sentry" }));
		});
		expect(mutationMock).toHaveBeenCalledWith("plugins_mcp_oauth.disconnect", {
			membershipId: "membership_1",
			target: { kind: "custom", customServerId: "custom_2" },
		});
	});

	test("a sign-in server that answers auth_required shows ready and needs sign-in", async () => {
		const authRequired = { at: 1_700_000_000_000, outcome: "auth_required", toolCount: null };
		setQueries({
			servers: [
				// The probe sends no token, so a server that lists tools only after sign-in answers auth_required.
				saved_server({ auth: { kind: "oauth", authorizationHost: "linear.app" }, headers: [], lastTest: authRequired }),
				// A server with headers answers auth_required when a value is wrong, so that is a failure.
				saved_server({ customServerId: "custom_2", name: "Sentry", lastTest: authRequired }),
			],
		});
		render(<PageComponent />);

		const row = screen.getByRole("listitem", { name: "Linear" });
		expect(row.getAttribute("data-mcp-server-status")).toBe("ready");
		expect(row.textContent).toContain("Last test: needs sign-in");
		const headersRow = screen.getByRole("listitem", { name: "Sentry" });
		expect(headersRow.getAttribute("data-mcp-server-status")).toBe("error");
		expect(headersRow.textContent).toContain("Last test: failed");

		actionMock.mockResolvedValueOnce({
			_yay: { outcome: "auth_required", message: "x", toolCount: null, authorizationHost: "linear.app", toolNames: [] },
		});
		await act(async () => {
			fireEvent.click(within(row).getByRole("button", { name: "Test Linear" }));
		});
		expect(within(row).getByRole("status").textContent).toBe(
			"The server lists its tools only after sign-in at linear.app.",
		);
	});

	test("a member without the permission sees the notice and no editor", () => {
		setQueries({ canUse: false, servers: [saved_server()] });
		render(<PageComponent />);

		expect(screen.getByText(/You cannot add or test MCP servers in this workspace/)).not.toBeNull();
		expect(screen.queryByRole("textbox", { name: "MCP server config JSON" })).toBeNull();
		const row = screen.getByRole("listitem", { name: "Linear" });
		expect((within(row).getByRole("button", { name: "Test Linear" }) as HTMLButtonElement).disabled).toBe(true);
		expect((within(row).getByRole("button", { name: "Turn off Linear" }) as HTMLButtonElement).disabled).toBe(false);
		expect((within(row).getByRole("button", { name: "Delete Linear" }) as HTMLButtonElement).disabled).toBe(false);
	});
});
