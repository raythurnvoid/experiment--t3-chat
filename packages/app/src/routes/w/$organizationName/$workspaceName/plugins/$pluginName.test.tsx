/**
 * @vitest-environment jsdom
 *
 * The consent modal promises an admin what a plugin reaches before install, and the Access screen
 * repeats that promise afterwards. Both are covered by rendering the route, not by reading the JSX.
 * They must say the same thing about the same surfaces, so a warning added to one and missed on the
 * other is the failure these tests exist to catch.
 */
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore, type ComponentProps, type ReactElement, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
	paramsMock,
	tenantContextMock,
	useQueryMock,
	usePaginatedQueryMock,
	mutationMock,
	actionMock,
	toastErrorMock,
	routeStore,
	modalOptions,
} = vi.hoisted(() => ({
	paramsMock: vi.fn(),
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	usePaginatedQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	actionMock: vi.fn(),
	toastErrorMock: vi.fn(),
	modalOptions: { keepMounted: false },
	// The remount key and mocked hooks subscribe here. Like a real router or Convex update, a
	// change re-renders the component that read the snapshot. A parent rerender does not, because
	// the React Compiler keeps its output when props are unchanged.
	routeStore: {
		revision: 0,
		listeners: new Set<() => void>(),
	},
}));

/**
 * Tell every subscribed hook that params or query data changed.
 * `act` flushes that render before the test goes on.
 */
function notify_route_store() {
	act(() => {
		routeStore.revision += 1;
		for (const listener of routeStore.listeners) {
			listener();
		}
	});
}

vi.mock("@tanstack/react-router", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useLocation: () => ({ pathname: "/w/team/home/plugins/tracker", searchStr: "" }),
		createFileRoute: (_path: string) => (options: unknown) => ({
			options,
			useParams: () => {
				// Thread the revision into the return. An unused counter lets the compiler keep the old params.
				const revision = useSyncExternalStore(
					(listener) => {
						routeStore.listeners.add(listener);
						return () => {
							routeStore.listeners.delete(listener);
						};
					},
					() => routeStore.revision,
				);
				return revision < 0 ? undefined : paramsMock();
			},
		}),
	};
});

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQuery: (query: string, ...args: unknown[]) => {
			// Thread the revision into every return. The React Compiler keeps a hook's last result
			// when it does not see that value as an input.
			const revision = useSyncExternalStore(
				(listener) => {
					routeStore.listeners.add(listener);
					return () => {
						routeStore.listeners.delete(listener);
					};
				},
				() => routeStore.revision,
			);
			const result = useQueryMock(query, ...args);
			if (query === "get_account") {
				return revision < 0 ? undefined : { _id: "account_1", name: "Media worker", revokedAt: null };
			}
			if (query === "grant_management") {
				return revision < 0
					? undefined
					: {
							resource: { kind: "workspace" },
							level: null,
							canManage: true,
							grantableLevels: ["read", "write"],
							file: null,
						};
			}
			return revision < 0 ? undefined : result;
		},
		useQueries: () => ({}),
		usePaginatedQuery: (query: string, ...args: unknown[]) => {
			const revision = useSyncExternalStore(
				(listener) => {
					routeStore.listeners.add(listener);
					return () => {
						routeStore.listeners.delete(listener);
					};
				},
				() => routeStore.revision,
			);
			const result = usePaginatedQueryMock(query, ...args) ?? {
				results: query === "list_accounts" ? [{ _id: "account_1", name: "Media worker", revokedAt: null }] : [],
				status: "Exhausted",
				loadMore: vi.fn(),
			};
			return revision < 0 ? undefined : result;
		},
	};
});

vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, success: vi.fn() },
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: mutationMock, action: actionMock },
	app_convex_api: {
		access_control: {
			get_current_user_workspace_permission: "account_permission",
			list_service_accounts: "list_accounts",
			get_service_account: "get_account",
			get_service_account_grant_management_state: "grant_management",
		},
		files_nodes: {
			get_authorized_by_path: "get_authorized_by_path",
			get_visible_target_by_path: "get_visible_target_by_path",
		},
		users: { get_anagraphic: "get_anagraphic" },
		organizations: { list: "organizations.list" },
		plugins_access: {
			get_workspace_install_access: "plugins_access.get_workspace_install_access",
			get_installation_access: "plugins_access.get_installation_access",
			get_my_run_as_grant: "plugins_access.get_my_run_as_grant",
			grant_run_as_me: "plugins_access.grant_run_as_me",
			revoke_run_as_me: "plugins_access.revoke_run_as_me",
			list_eligible_run_users: "plugins_access.list_eligible_run_users",
			set_scheduled_run_user: "plugins_access.set_scheduled_run_user",
		},
		plugins: {
			list_installations: "plugins.list_installations",
			list_published_plugins: "plugins.list_published_plugins",
			get_publisher_plugin: "plugins.get_publisher_plugin",
			get_plugin_service_registration: "plugins.get_plugin_service_registration",
			set_plugin_service_registration: "plugins.set_plugin_service_registration",
			get_installation_health: "plugins.get_installation_health",
			list_recent_runs: "plugins.list_recent_runs",
			list_run_history: "plugins.list_run_history",
			list_run_calls: "plugins.list_run_calls",
			get_installation_schedule: "plugins.get_installation_schedule",
			get_installation_mounts: "plugins.get_installation_mounts",
			disable_installation: "plugins.disable_installation",
			run_schedule_now: "plugins.run_schedule_now",
			list_installation_secrets: "plugins.list_installation_secrets",
			list_publisher_repository_secrets: "plugins.list_publisher_repository_secrets",
			upsert_publisher_repository_secrets: "plugins.upsert_publisher_repository_secrets",
			update_installation_configuration: "plugins.update_installation_configuration",
			install_version: "plugins.install_version",
			set_installation_service_account: "plugins.set_installation_service_account",
			remove_repository: "plugins.remove_repository",
			get_publish_candidate_head: "plugins.get_publish_candidate_head",
			publish_version: "plugins.publish_version",
		},
		plugins_mcp: {
			get_installation_mcp_status: "plugins_mcp.get_installation_mcp_status",
		},
		plugins_mcp_oauth: {
			can_connect: "plugins_mcp_oauth.can_connect",
			start: "plugins_mcp_oauth.start",
			disconnect: "plugins_mcp_oauth.disconnect",
		},
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// Monaco cannot run in jsdom, so the stub is a textarea honoring `value` and `onChange`. That is
// enough for the configuration tests to edit the draft; everything else about the editor is out of
// scope here.
vi.mock("@monaco-editor/react", () => ({
	Editor: function Editor(props: {
		value?: string;
		options?: { ariaLabel?: string };
		onChange?: (value: string | undefined) => void;
	}) {
		return (
			<textarea
				aria-label={props.options?.ariaLabel ?? "Editor"}
				value={props.value}
				onChange={(event) => props.onChange?.(event.currentTarget.value)}
			/>
		);
	},
}));

vi.mock("monaco-editor", () => ({ editor: {} }));

// This module configures the real monaco languages at import time, which the stub above cannot serve.
vi.mock("@/lib/app-monaco-config.ts", () => ({ app_monaco_THEME_NAME_DARK: "app-dark" }));

vi.mock("@/components/plugins-header-breadcrumb.tsx", () => ({
	PluginsHeaderBreadcrumb: function PluginsHeaderBreadcrumb() {
		return <div>Breadcrumb</div>;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: ComponentProps<"button"> & { ref?: Ref<HTMLButtonElement> }) {
		const { ref, ...rest } = props;
		return <button type="button" ref={ref} {...rest} />;
	},
}));

vi.mock("@/components/my-badge.tsx", () => ({
	MyBadge: function MyBadge(props: { children?: ReactNode }) {
		return <span>{props.children}</span>;
	},
}));

// The real popover is an Ariakit dialog that portals and traps focus. Honor `open` so the test still
// has to click Install to see the consent copy, and render a close button while open so tests can
// drive the same open-state callback that Escape uses in the real app.
vi.mock("@/components/my-modal.tsx", () => ({
	MyModal: function MyModal(props: { open?: boolean; setOpen?: (open: boolean) => void; children?: ReactNode }) {
		return props.open || modalOptions.keepMounted ? (
			<div hidden={!props.open}>
				<button type="button" onClick={() => props.setOpen?.(false)}>
					Close modal
				</button>
				{props.children}
			</div>
		) : null;
	},
	MyModalPopover: function MyModalPopover(props: { children?: ReactNode }) {
		return <div role="dialog">{props.children}</div>;
	},
	MyModalCloseTrigger: function MyModalCloseTrigger() {
		return null;
	},
	MyModalDescription: function MyModalDescription(props: { children?: ReactNode }) {
		return <p>{props.children}</p>;
	},
	MyModalHeader: function MyModalHeader(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalHeading: function MyModalHeading(props: { children?: ReactNode }) {
		return <h2>{props.children}</h2>;
	},
	MyModalFooter: function MyModalFooter(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalScrollableArea: function MyModalScrollableArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

vi.mock("@/components/my-icon-button.tsx", () => ({
	MyIconButton: function MyIconButton(props: ComponentProps<"button"> & { tooltip?: string }) {
		const { tooltip, children, ...rest } = props;
		return (
			<button type="button" aria-label={tooltip} {...rest}>
				{children}
			</button>
		);
	},
	MyIconButtonIcon: function MyIconButtonIcon(props: { children?: ReactNode }) {
		return <span aria-hidden>{props.children}</span>;
	},
}));

// The real menu is a native-popovers menu: it shows in the top layer, only mounts its items
// while open, closes on item activation, and returns the menu's focus to the trigger. None of that
// runs here — this mock renders the trigger and the items inline so a test can reach both.
//
// The real menu also blocks a disabled item's activation; the mocked item deliberately keeps firing
// onClick instead, so a re-entry test proves a handler's own in-flight guard and not the UI block.
vi.mock("@/components/my-menu.tsx", () => ({
	MyMenu: function MyMenu(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyMenuTrigger: function MyMenuTrigger(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
	MyMenuPopover: function MyMenuPopover(props: { children?: ReactNode }) {
		return <div role="menu">{props.children}</div>;
	},
	MyMenuPopoverContent: function MyMenuPopoverContent(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyMenuItem: function MyMenuItem(props: {
		disabled?: boolean;
		onClick?: ComponentProps<"button">["onClick"];
		children?: ReactNode;
	}) {
		return (
			<button type="button" role="menuitem" aria-disabled={props.disabled || undefined} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
	MyMenuItemContent: function MyMenuItemContent(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyMenuItemContentIcon: function MyMenuItemContentIcon(props: { children?: ReactNode }) {
		return <span aria-hidden>{props.children}</span>;
	},
	MyMenuItemContentPrimary: function MyMenuItemContentPrimary(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

import { Route } from "./$pluginName.tsx";
import { PluginsPublishSessionProvider } from "@/components/plugins-publish-session.tsx";
import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

type PublishedPlugin = app_convex_FunctionReturnType<typeof app_convex_api.plugins.list_published_plugins>[number];

afterEach(() => usePaginatedQueryMock.mockReset());

const PageComponent = Route.options.component as () => JSX.Element;

function render(ui: ReactElement) {
	return testingRender(ui, { wrapper: PluginsPublishSessionProvider });
}

function route_remount_key() {
	const remountDeps = Route.options.remountDeps;
	if (!remountDeps) {
		throw new Error("Plugin detail route must remount when its identity changes");
	}

	return JSON.stringify(
		remountDeps({
			routeId: "/w/$organizationName/$workspaceName/plugins/$pluginName",
			loaderDeps: {},
			params: paramsMock(),
			search: {},
		} as Parameters<typeof remountDeps>[0]),
	);
}

function RemountingPageComponent() {
	// Read the remount key through the store. A plain call during render does not re-run when
	// paramsMock changes, because this component has no props and the React Compiler keeps it.
	const remountKey = useSyncExternalStore(
		(listener) => {
			routeStore.listeners.add(listener);
			return () => {
				routeStore.listeners.delete(listener);
			};
		},
		() => route_remount_key(),
	);
	return <PageComponent key={remountKey} />;
}

function published_plugin(overrides: {
	name: string;
	canProcessFiles: boolean;
	canInstall?: boolean;
	canManage?: boolean;
	installationId?: string | null;
	configuration?: { description: string; defaultYaml: string } | null;
	mounts?: NonNullable<PublishedPlugin["mounts"]>;
	events?: PublishedPlugin["events"];
	capabilities?: string[];
	pages?: Array<{ id: string; title: string; entry: string; navItem: { label: string; icon: string | null } | null }>;
	fileViews?: Array<{ id: string; title: string; entry: string; contentTypes: string[] }>;
	uiOutboundOrigins?: string[];
	mcpServers?: Array<{
		id: string;
		title: string;
		transport: "http";
		url: string;
		headers: Array<{ name: string; secret: string }>;
		auth:
			| { kind: "none" }
			| { kind: "secret_headers" }
			| { kind: "oauth"; issuer: string; resource: string | null; scopes: string[] };
		tools: string[] | null;
	}>;
	skills?: Array<{ name: string; path: string; description: string }>;
	organizationPolicy?: "allowed" | "blocked" | "needs_approval";
}) {
	return {
		pluginVersionId: "version_1",
		name: overrides.name,
		displayName: overrides.name,
		description: "A plugin",
		version: "0.2.0",
		publisherDisplayName: "Ray Publisher",
		reviewStatus: "passed",
		canProcessFiles: overrides.canProcessFiles,
		canInstall: overrides.canInstall ?? true,
		canManage: overrides.canManage ?? false,
		installationId: overrides.installationId ?? null,
		configuration: overrides.configuration ?? null,
		mounts: overrides.mounts ?? [],
		events: overrides.events ?? [],
		capabilities: overrides.capabilities ?? ["plugin.data.read"],
		outboundOrigins: [],
		uiOutboundOrigins: overrides.uiOutboundOrigins ?? [],
		pages: overrides.pages ?? [],
		fileViews: overrides.fileViews ?? [],
		mcpServers: overrides.mcpServers ?? [],
		mcpServersFingerprint: "mcp-servers-hash",
		skills: overrides.skills ?? [],
		organizationPolicy: overrides.organizationPolicy ?? "allowed",
	};
}

function installed_item(plugin: ReturnType<typeof published_plugin>) {
	return {
		installation: {
			serviceAccountId: "account_1",
			_id: "installation_1",
			pluginName: plugin.name,
			status: "enabled",
			configurationYaml: "note: server\n",
		},
		version: {
			version: plugin.version,
			capabilities: plugin.capabilities,
			outboundOrigins: plugin.outboundOrigins,
			uiOutboundOrigins: plugin.uiOutboundOrigins,
			pages: plugin.pages,
			fileViews: plugin.fileViews,
			mcpServers: plugin.mcpServers,
			mcpServersFingerprint: plugin.mcpServersFingerprint,
			skills: plugin.skills,
			events: plugin.events,
			mounts: plugin.mounts,
			configuration: { description: "Where this plugin runs.", defaultYaml: "note: server\n" },
		},
		handlers: [],
	};
}

// The shape the publisher UI reads: the repo identity in the hero, the ids the publish and
// remove-claim mutations take, and an empty release history.
function publisher_plugin_fixture() {
	return {
		repository: {
			_id: "repository_1",
			owner: "ray",
			repo: "bonobo-plugin-media",
			repositoryUrl: "https://github.com/ray/bonobo-plugin-media",
			lastPublishAttempt: undefined,
		},
		versions: [],
		reviews: [],
		historyIsTruncated: false,
	};
}

// The one-version shape a publisher-only member reaches the page through: the route derives the
// whole detail view from it, and the release history renders it as one published row.
function publisher_version_fixture(name: string) {
	return {
		_id: "publisher_version_1",
		name,
		displayName: name,
		description: "A plugin",
		version: "0.2.0",
		reviewStatus: "passed",
		reviewId: null,
		backendEntrypointFile: null,
		mounts: [],
		events: [],
		capabilities: ["plugin.data.read"],
		outboundOrigins: [],
		uiOutboundOrigins: [],
		pages: [],
		fileViews: [],
		mcpServers: [],
		mcpServersFingerprint: "mcp-servers-hash",
		skills: [],
		artifactHash: "artifact_1",
		sourceCommitSha: "1234567890abcdef",
		updatedAt: 1_700_000_000_000,
	};
}

const mcp_plugin_parts = {
	capabilities: ["agent.mcp.connect", "agent.skills.contribute"],
	mcpServers: [
		{
			id: "tracker",
			title: "Tracker",
			transport: "http" as const,
			url: "https://mcp.example.com/mcp",
			headers: [],
			auth: { kind: "oauth" as const, issuer: "https://auth.example.com", resource: null, scopes: ["read"] },
			tools: null,
		},
	],
	skills: [{ name: "triage", path: "skills/triage/SKILL.md", description: "Sort new issues." }],
};

// Both screens must carry this sentence in the same words.
const mcp_warning =
	"MCP servers are outside services. When the agent calls a tool, the chat sends that call's data to the server without asking.";

function scheduled_plugin() {
	return published_plugin({
		name: "importer",
		canProcessFiles: false,
		capabilities: ["plugin.schedule.run", "workspace.volumes.write"],
		configuration: {
			description: "Choose the mount name and interval.",
			defaultYaml: "mount:\n  name: sources\nschedule:\n  everyMinutes: 30\n",
		},
		mounts: [{ id: "source", description: "Outside source files", configurationPath: ["mount", "name"] }],
		events: [
			{
				type: "schedule.interval.elapsed",
				contentTypes: [],
				filters: [],
				schedule: { configurationPath: ["schedule", "everyMinutes"] },
			},
		],
	});
}

function setQueryResult(query: string, result: unknown) {
	const previous = useQueryMock.getMockImplementation();
	useQueryMock.mockImplementation((candidate: string, ...args: unknown[]) =>
		candidate === query ? result : previous?.(candidate, ...args),
	);
}

const SCHEDULE = {
	status: "enabled",
	intervalMinutes: 30,
	nextRunAt: 1_700_000_000_000,
	userId: "user_2",
	grantId: "grant_2",
	userName: "Ada",
	payerUserId: "owner_1",
	payerName: "Owner Ray",
	assignmentError: null,
	lastRun: { runId: "run_1", status: "failed", updatedAt: 1_700_000_000_000, errorMessage: "Source was unavailable" },
};

function setQueries(args: {
	plugin: ReturnType<typeof published_plugin>;
	installations?: unknown[];
	publisherPlugin?: unknown;
	canManageAccounts?: boolean;
}) {
	const { plugin, installations = [], publisherPlugin = null, canManageAccounts = true } = args;

	paramsMock.mockReturnValue({ organizationName: "team", workspaceName: "home", pluginName: plugin.name });
	useQueryMock.mockImplementation((query: string) => {
		switch (query) {
			case "organizations.list":
				return { workspaceIdsPermissionsDict: { workspace_1: ["content.read"] } };
			case "plugins.list_published_plugins":
				return [
					{
						...plugin,
						canInstall: installations.length === 0 && plugin.canInstall,
						canManage: installations.length > 0 || plugin.canManage,
						installationId: installations.length > 0 ? "installation_1" : plugin.installationId,
					},
				];
			case "plugins.list_installations":
				return installations;
			case "plugins.get_publisher_plugin":
				return publisherPlugin;
			case "account_permission":
				return canManageAccounts;
			case "plugins_access.get_workspace_install_access":
				return {
					canInstall: true,
					canManageSettings: false,
					mode: null,
					principals: [],
					organizationOwnerUserId: "owner_1",
				};
			case "get_anagraphic":
				return { displayName: "Owner Ray" };
			case "plugins_access.get_my_run_as_grant":
			case "plugins_access.get_installation_access":
			case "plugins.get_installation_schedule":
			case "plugins.get_installation_mounts":
				return null;
			default:
				return undefined;
		}
	});
	notify_route_store();
}

describe("RoutePluginsPluginConsentModal", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("promises the upload baseline for a plugin that can get a run", () => {
		setQueries({ plugin: published_plugin({ name: "media", canProcessFiles: true }) });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		expect(screen.getByRole("dialog").textContent).toContain("triggering upload");
	});

	test("installs a fresh empty account without account management permission", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [], publisherPlugin: null, canManageAccounts: false });
		mutationMock.mockResolvedValue({ _yay: { installationId: "installation_1" } });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const accept = screen.getByRole("button", { name: "Accept and install" }) as HTMLButtonElement;
		expect(accept.disabled, "fresh empty account install must stay available").toBe(false);
		expect(screen.getByRole("combobox", { name: "Service account" })).toHaveProperty("disabled", true);
		expect(screen.queryByRole("button", { name: "Add reviewed grant" })).toBeNull();
		expect(screen.getByRole("dialog").textContent).toContain("You can install with a new empty account.");
		fireEvent.click(accept);

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock).toHaveBeenCalledWith(
			"plugins.install_version",
			expect.objectContaining({ membershipId: "membership_1", pluginVersionId: "version_1" }),
		);
		const args = mutationMock.mock.calls[0]![1];
		expect(args).not.toHaveProperty("serviceAccountId");
		expect(args).not.toHaveProperty("serviceAccountGrants");
	});

	test("updates an exact managed installation without account or install permission", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true, canInstall: false });
		const installed = installed_item(plugin);
		installed.version.version = "0.1.0";
		setQueries({ plugin, installations: [installed], publisherPlugin: null, canManageAccounts: false });
		mutationMock.mockResolvedValue({ _yay: { installationId: "installation_1" } });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and update" }));

		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
		expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty("serviceAccountId");
		expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty("serviceAccountGrants");
		expect(screen.queryByRole("combobox", { name: "Replacement service account" })).toBeNull();
	});

	test("does not submit inferred grants during an ordinary update", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		const installed = installed_item(plugin);
		installed.version.version = "0.1.0";
		setQueries({ plugin, installations: [installed] });
		mutationMock.mockResolvedValue({ _yay: null });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and update" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(
				"plugins.install_version",
				expect.not.objectContaining({ serviceAccountGrants: expect.anything() }),
			),
		);
		const args = mutationMock.mock.calls.find((call) => call[0] === "plugins.install_version")?.[1];
		expect(args).not.toHaveProperty("serviceAccountId");
	});

	test("submits only a grant the user added to the consent form", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		const installed = installed_item(plugin);
		installed.version.version = "0.1.0";
		setQueries({ plugin, installations: [installed] });
		mutationMock.mockResolvedValue({ _yay: null });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		fireEvent.click(screen.getByRole("button", { name: "Add reviewed grant" }));
		expect(mutationMock).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Accept and update" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(
				"plugins.install_version",
				expect.objectContaining({ serviceAccountGrants: [{ resource: { kind: "workspace" }, level: "read" }] }),
			),
		);
	});

	test("rebinds only through the explicit account action", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [installed_item(plugin)] });
		mutationMock.mockResolvedValue({ _yay: null });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("combobox", { name: "Replacement service account" }));
		fireEvent.click(await screen.findByRole("option", { name: "Media worker" }));
		expect(mutationMock).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Change service account" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins.set_installation_service_account", {
				membershipId: "membership_1",
				installationId: "installation_1",
				serviceAccountId: "account_1",
			}),
		);
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test("does not promise the upload baseline for a page-only plugin", () => {
		// Council's shape: no backend entrypoint and no declared events, so no run ever starts and its
		// page token carries no write scope. Telling an admin otherwise overstates the grant.
		setQueries({ plugin: published_plugin({ name: "council", canProcessFiles: false }) });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		// Assert the dialog really opened before trusting the absence below.
		expect(dialog.textContent).toContain("This plugin can use these capabilities");
		expect(dialog.textContent).not.toContain("triggering upload");
	});

	test("names the file view surface and warns about it for a plugin with no pages", () => {
		// Video Player's shape: no pages, one file view. A file view runs the same frame on a session
		// token with the same workspace-wide scopes as a page, so an admin must be shown the surface
		// and the same warning. Gating either one on `pages` hides both for this plugin.
		setQueries({
			plugin: published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
			}),
		});

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("Video player");
		expect(dialog.textContent).toContain("video/mp4");
		expect(dialog.textContent).toContain("trusted with the data their capabilities expose");
	});

	test("names the page surface and warns about it for a plugin with no file views", () => {
		// The mirror of the test above, and the case every shipped plugin is in: Council, Gallery and
		// Chitchat all ship pages and no file views. Gating the warning on `fileViews` alone would drop
		// it for all of them, and only this direction catches that.
		setQueries({
			plugin: published_plugin({
				name: "gallery",
				canProcessFiles: false,
				pages: [
					{
						id: "browse",
						title: "Gallery browser",
						entry: "dist/frontend/index.html",
						navItem: { label: "Gallery", icon: "images" },
					},
				],
			}),
		});

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("Gallery browser");
		expect(dialog.textContent).toContain("trusted with the data their capabilities expose");
	});

	test("warns that a service capability outlives the frame that granted it", () => {
		// Council's shape. Every other capability is spent by code the app runs, so it stops when the
		// frame closes. This one hands a frame's access to the publisher's own server, which keeps
		// using it while nobody has the plugin open, so the dialog must say so before an admin accepts.
		// A file view starts that exchange exactly as a page does, so the copy must name both surfaces.
		setQueries({
			plugin: published_plugin({
				name: "council",
				canProcessFiles: false,
				capabilities: ["plugin.data.read", "plugin.service.connect"],
				pages: [{ id: "room", title: "Council room", entry: "dist/frontend/index.html", navItem: null }],
			}),
		});

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		// Assert the capability really rendered before trusting the warning below.
		expect(dialog.textContent).toContain("This plugin can use these capabilities");
		expect(dialog.textContent).toContain(
			"This plugin's pages and file views can pass their access to the publisher's own server",
		);
	});

	test("lists MCP servers and skills with the MCP warning", () => {
		setQueries({ plugin: published_plugin({ name: "tracker", canProcessFiles: false, ...mcp_plugin_parts }) });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("Tracker — mcp.example.com — each member signs in at auth.example.com");
		expect(dialog.textContent).toContain("triage — Sort new issues.");
		expect(dialog.textContent).toContain(mcp_warning);
	});
});

describe("RoutePluginsPlugin scheduled runs", () => {
	beforeEach(() => {
		modalOptions.keepMounted = false;
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "organization_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
		mutationMock.mockReset().mockResolvedValue({ _yay: null });
	});

	afterEach(() => {
		cleanup();
		modalOptions.keepMounted = false;
		vi.clearAllMocks();
	});

	test("requires explicit Me consent and submits the edited first-install YAML", async () => {
		setQueries({ plugin: scheduled_plugin() });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const dialog = screen.getByRole("dialog");
		const accept = within(dialog).getByRole("button", { name: "Accept and install" });
		expect(accept, "a scheduled install must wait for direct Me consent").toHaveProperty("disabled", true);
		expect(dialog.textContent).toContain("Runs every 30 minutes");
		expect(dialog.textContent).toContain("Folder sharing limits do not apply");
		expect(dialog.textContent).toContain("Scheduled writes are billed to Owner Ray");
		expect(dialog.textContent).toContain("Other writes use this installation's billing settings");
		expect(dialog.textContent).not.toContain("triggering upload");
		fireEvent.change(within(dialog).getByRole("textbox", { name: "Configuration YAML" }), {
			target: { value: "mount:\n  name: fresh\nschedule:\n  everyMinutes: 45\n" },
		});
		expect(dialog.textContent).toContain("Runs every 45 minutes");
		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }),
		);
		await waitFor(() => expect(accept).toHaveProperty("disabled", false));
		fireEvent.click(accept);
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(
				"plugins.install_version",
				expect.objectContaining({
					configurationYaml: "mount:\n  name: fresh\nschedule:\n  everyMinutes: 45\n",
					scheduledRun: { kind: "me", scopes: ["volumes:write"], filesReadProof: undefined },
				}),
			),
		);
	});

	test("requires fresh Me consent after cancel and reopen with mounted dialog children", async () => {
		modalOptions.keepMounted = true;
		setQueries({ plugin: scheduled_plugin() });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", false),
		);
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const confirmation = screen.getByRole("checkbox", {
			name: "Allow this plugin to run as me while I am signed out.",
		});
		expect(confirmation, "reopening consent must start with Me unchecked").toHaveProperty("checked", false);
		expect(screen.getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", true);
		fireEvent.click(confirmation);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", false),
		);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each(["repair", "enable"] as const)(
		"blocks %s when a selected grant from a later page is removed",
		async (form) => {
			modalOptions.keepMounted = true;
			const plugin = scheduled_plugin();
			const installation = installed_item(plugin);
			installation.installation.configurationYaml = plugin.configuration!.defaultYaml;
			if (form === "enable") installation.installation.status = "disabled";
			setQueries({ plugin, installations: [installation] });
			setQueryResult("plugins.get_installation_schedule", { ...SCHEDULE, status: installation.installation.status });
			let eligibleUsers: Array<{ userId: string; grantId: string; displayName: string; scopes: string[] }> = [];
			let status = "CanLoadMore";
			usePaginatedQueryMock.mockImplementation((query: string) =>
				query === "plugins_access.list_eligible_run_users"
					? {
							results: eligibleUsers,
							status,
							loadMore: () => {
								eligibleUsers = [{ userId: "user_3", grantId: "grant_3", displayName: "Grace", scopes: [] }];
								status = "Exhausted";
								notify_route_store();
							},
						}
					: undefined,
			);
			render(<PageComponent />);
			if (form === "enable") fireEvent.click(screen.getByRole("button", { name: "Enable" }));
			const formElement =
				form === "enable" ? screen.getByRole("dialog") : screen.getByRole("region", { name: "Schedule" });
			fireEvent.click(within(formElement).getByRole("button", { name: "Load more users" }));
			fireEvent.click(within(formElement).getByRole("combobox", { name: "Run as" }));
			fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
			const submit = within(formElement).getByRole("button", {
				name: form === "enable" ? "Accept and enable" : "Change scheduled user",
			});
			await waitFor(() => expect(submit).toHaveProperty("disabled", false));
			status = "LoadingFirstPage";
			notify_route_store();
			expect(within(formElement).queryByText(/selected user's permission is no longer available/)).toBeNull();
			eligibleUsers = [];
			status = "Exhausted";
			notify_route_store();
			await waitFor(() =>
				expect(submit, "a removed live grant must block submission").toHaveProperty("disabled", true),
			);
			expect(within(formElement).getByText(/selected user's permission is no longer available/)).not.toBeNull();
			if (form === "enable") {
				expect(
					within(formElement).queryByRole("checkbox", {
						name: "Allow this plugin to run as me while I am signed out.",
					}),
				).toBeNull();
			}
			fireEvent.click(submit);
			expect(mutationMock).not.toHaveBeenCalled();
		},
	);

	test("names the configured old folder when an update drops its mount", () => {
		const oldPlugin = scheduled_plugin();
		const installation = installed_item(oldPlugin);
		installation.installation.configurationYaml = "mount:\n  name: customer-records\nschedule:\n  everyMinutes: 30\n";
		const plugin = {
			...oldPlugin,
			version: "0.3.0",
			mounts: [],
		};
		setQueries({ plugin, installations: [installation] });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		const warning = within(screen.getByRole("dialog")).getByRole("alert");
		expect(warning.textContent, "the dropped folder warning must use its old configured path").toContain(
			"/.mounts/customer-records",
		);
	});

	test("explains ordinary billing for a mount-only plugin", () => {
		setQueries({ plugin: { ...scheduled_plugin(), capabilities: ["workspace.volumes.write"], events: [] } });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).toContain("Other writes use this installation's billing settings");
		expect(within(dialog).queryByRole("checkbox", { name: /Allow this plugin to run as me/ })).toBeNull();
		expect(within(dialog).getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", false);
	});

	test("keeps invalid schedule YAML out of the install request", async () => {
		setQueries({ plugin: scheduled_plugin() });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const dialog = screen.getByRole("dialog");
		fireEvent.change(within(dialog).getByRole("textbox", { name: "Configuration YAML" }), {
			target: { value: "mount:\n  name: sources\nschedule:\n  everyMinutes: 1\n" },
		});
		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }),
		);
		await waitFor(() =>
			expect(within(dialog).getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", true),
		);
		expect(within(dialog).getByRole("textbox", { name: "Configuration YAML" })).toHaveProperty("validity.valid", false);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows an install permission refusal inline and keeps consent open", async () => {
		setQueries({ plugin: scheduled_plugin() });
		mutationMock.mockResolvedValue({ _nay: { message: "Permission denied" } });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Accept and install" })).toHaveProperty("disabled", false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Accept and install" }));
		expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveProperty(
			"textContent",
			"Permission denied",
		);
	});

	test("lets a member reach only their run permissions through the public installation ID", async () => {
		const plugin = { ...scheduled_plugin(), installationId: "installation_1", canInstall: false, canManage: false };
		setQueries({ plugin });
		setQueryResult("plugins_access.get_my_run_as_grant", {
			pluginName: "importer",
			displayName: "Importer",
			capabilities: ["plugin.schedule.run"],
			isAssigned: true,
			grant: { grantId: "grant_me", scopes: [], valid: true },
		});
		render(<PageComponent />);
		expect(screen.getByRole("region", { name: "My run permissions" })).not.toBeNull();
		expect(screen.getByText("Installed")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Plugin configuration YAML" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Schedule" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Plugin management access" })).toBeNull();
		expect(screen.queryByText("Service account")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Revoke my run permissions" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins_access.revoke_run_as_me", {
				membershipId: "membership_1",
				installationId: "installation_1",
			}),
		);
		expect(useQueryMock.mock.calls.some((call) => call[0] === "plugins.get_installation_schedule")).toBe(false);
	});

	test("repairs an invalid actor with another person's own grant and separates the payer", async () => {
		const plugin = scheduled_plugin();
		setQueries({ plugin, installations: [installed_item(plugin)] });
		setQueryResult("plugins.get_installation_schedule", {
			...SCHEDULE,
			assignmentError: "The scheduled user must grant access again",
		});
		usePaginatedQueryMock.mockImplementation((query: string) =>
			query === "plugins_access.list_eligible_run_users"
				? {
						results: [{ userId: "user_3", grantId: "grant_3", displayName: "Grace", scopes: [] }],
						status: "Exhausted",
						loadMore: vi.fn(),
					}
				: undefined,
		);
		render(<PageComponent />);
		const schedule = screen.getByRole("region", { name: "Schedule" });
		expect(schedule.textContent).toContain("Ada");
		expect(schedule.textContent).toContain("Owner Ray");
		expect(within(schedule).getByRole("button", { name: "Run now" })).toHaveProperty("disabled", true);
		fireEvent.click(within(schedule).getByRole("combobox", { name: "Run as" }));
		fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
		fireEvent.click(within(schedule).getByRole("button", { name: "Change scheduled user" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins_access.set_scheduled_run_user", {
				membershipId: "membership_1",
				installationId: "installation_1",
				userId: "user_3",
				grantId: "grant_3",
			}),
		);
		expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty("payerUserId");
	});

	test.each([true, false])("moves assignment focus to feedback only when still on submit (%s)", async (keepsFocus) => {
		const plugin = scheduled_plugin();
		const installation = installed_item(plugin);
		installation.installation.configurationYaml = plugin.configuration!.defaultYaml;
		setQueries({ plugin, installations: [installation] });
		setQueryResult("plugins.get_installation_schedule", SCHEDULE);
		usePaginatedQueryMock.mockImplementation((query: string) =>
			query === "plugins_access.list_eligible_run_users"
				? {
						results: [{ userId: "user_3", grantId: "grant_3", displayName: "Grace", scopes: [] }],
						status: "Exhausted",
						loadMore: vi.fn(),
					}
				: undefined,
		);
		let resolveAssignment!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveAssignment = resolve;
			}),
		);
		render(<PageComponent />);
		const schedule = screen.getByRole("region", { name: "Schedule" });
		fireEvent.click(within(schedule).getByRole("combobox", { name: "Run as" }));
		fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
		const assign = within(schedule).getByRole("button", { name: "Change scheduled user" });
		act(() => assign.focus());
		fireEvent.click(assign);
		setQueryResult("plugins.get_installation_schedule", {
			...SCHEDULE,
			userId: "user_3",
			grantId: "grant_3",
			userName: "Grace",
		});
		notify_route_store();
		expect(assign).toHaveProperty("disabled", false);
		expect(document.activeElement).toBe(assign);
		const run = within(schedule).getByRole("button", { name: "Run now" });
		if (!keepsFocus) act(() => run.focus());
		await act(async () => resolveAssignment({ _yay: null }));
		const feedback = within(schedule).getByRole("status");
		expect(assign).toHaveProperty("disabled", true);
		expect(
			document.activeElement,
			keepsFocus ? "focused_assignment_lands_on_feedback" : "assignment_does_not_steal_later_focus",
		).toBe(keepsFocus ? feedback : run);
	});

	test("queues Run now once and displays a live permission refusal", async () => {
		const plugin = scheduled_plugin();
		setQueries({ plugin, installations: [installed_item(plugin)] });
		setQueryResult("plugins.get_installation_schedule", SCHEDULE);
		let finish: ((value: { _nay: { message: string } }) => void) | undefined;
		mutationMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(<PageComponent />);
		const run = screen.getByRole("button", { name: "Run now" });
		fireEvent.click(run);
		fireEvent.click(run);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(run.getAttribute("aria-busy")).toBe("true");
		await act(async () => finish?.({ _nay: { message: "The scheduled assignment changed" } }));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The scheduled assignment changed");
	});

	test("disables through the public door and keeps Enable consent explicit", async () => {
		const plugin = scheduled_plugin();
		const installation = installed_item(plugin);
		installation.installation.configurationYaml = plugin.configuration!.defaultYaml;
		setQueries({ plugin, installations: [installation] });
		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins.disable_installation", {
				membershipId: "membership_1",
				installationId: "installation_1",
			}),
		);
		installation.installation.status = "disabled";
		setQueries({ plugin, installations: [installation] });
		fireEvent.click(screen.getByRole("button", { name: "Enable" }));
		expect(screen.getByRole("button", { name: "Accept and enable" })).toHaveProperty("disabled", true);
		expect(screen.getByRole("textbox", { name: "Configuration YAML" })).toHaveProperty(
			"value",
			plugin.configuration!.defaultYaml,
		);
	});

	test("clears the old Schedule choice after Enable as Me", async () => {
		modalOptions.keepMounted = true;
		const plugin = scheduled_plugin();
		const installation = installed_item(plugin);
		installation.installation.configurationYaml = plugin.configuration!.defaultYaml;
		setQueries({ plugin, installations: [installation] });
		setQueryResult("plugins.get_installation_schedule", SCHEDULE);
		let eligibleUsers = [{ userId: "user_3", grantId: "grant_3", displayName: "Grace", scopes: [] }];
		usePaginatedQueryMock.mockImplementation((query: string) =>
			query === "plugins_access.list_eligible_run_users"
				? { results: eligibleUsers, status: "Exhausted", loadMore: vi.fn() }
				: undefined,
		);
		render(<PageComponent />);
		const schedule = screen.getByRole("region", { name: "Schedule" });
		fireEvent.click(within(schedule).getByRole("combobox", { name: "Run as" }));
		fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
		fireEvent.click(within(schedule).getByRole("button", { name: "Change scheduled user" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins_access.set_scheduled_run_user", {
				membershipId: "membership_1",
				installationId: "installation_1",
				userId: "user_3",
				grantId: "grant_3",
			}),
		);
		setQueryResult("plugins.get_installation_schedule", {
			...SCHEDULE,
			userId: "user_3",
			grantId: "grant_3",
			userName: "Grace",
		});
		notify_route_store();
		eligibleUsers = [];
		const revokedSchedule = {
			...SCHEDULE,
			userId: "user_3",
			grantId: null,
			userName: "Grace",
			assignmentError: "The scheduled user must grant access again",
		};
		setQueryResult("plugins.get_installation_schedule", revokedSchedule);
		notify_route_store();
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		await waitFor(() => expect(mutationMock).toHaveBeenCalledWith("plugins.disable_installation", expect.anything()));
		setQueryResult("plugins.list_installations", [
			{ ...installation, installation: { ...installation.installation, status: "disabled" } },
		]);
		setQueryResult("plugins.get_installation_schedule", { ...revokedSchedule, status: "disabled" });
		notify_route_store();
		fireEvent.click(screen.getByRole("button", { name: "Enable" }));
		const dialog = screen.getByRole("dialog");
		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: "Allow this plugin to run as me while I am signed out." }),
		);
		const accept = within(dialog).getByRole("button", { name: "Accept and enable" });
		await waitFor(() => expect(accept).toHaveProperty("disabled", false));
		fireEvent.click(accept);
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(
				"plugins.install_version",
				expect.objectContaining({
					scheduledRun: { kind: "me", scopes: ["volumes:write"], filesReadProof: undefined },
				}),
			),
		);
		eligibleUsers = [{ userId: "user_2", grantId: "grant_me_new", displayName: "Ada", scopes: [] }];
		setQueryResult("plugins.list_installations", [installation]);
		setQueryResult("plugins.get_installation_schedule", { ...SCHEDULE, grantId: "grant_me_new" });
		notify_route_store();
		expect(screen.getByRole("region", { name: "Schedule" })).toBe(schedule);
		expect(schedule.textContent).toContain("Ada");
		expect(
			within(schedule).queryByText(/selected user's permission is no longer available/),
			"enable_as_me_clears_stale_schedule_warning",
		).toBeNull();
		expect(within(schedule).getByRole("button", { name: "Change scheduled user" })).toHaveProperty("disabled", true);
		expect(within(schedule).getByRole("button", { name: "Run now" })).toHaveProperty("disabled", false);
	});

	test("keeps a draft during schedule refresh but clears it when the saved grant changes", async () => {
		const plugin = scheduled_plugin();
		setQueries({ plugin, installations: [installed_item(plugin)] });
		setQueryResult("plugins.get_installation_schedule", SCHEDULE);
		usePaginatedQueryMock.mockImplementation((query: string) =>
			query === "plugins_access.list_eligible_run_users"
				? {
						results: [{ userId: "user_3", grantId: "grant_3", displayName: "Grace", scopes: [] }],
						status: "Exhausted",
						loadMore: vi.fn(),
					}
				: undefined,
		);
		render(<PageComponent />);
		const schedule = screen.getByRole("region", { name: "Schedule" });
		fireEvent.click(within(schedule).getByRole("combobox", { name: "Run as" }));
		fireEvent.click(await screen.findByRole("option", { name: "Grace" }));
		const assign = within(schedule).getByRole("button", { name: "Change scheduled user" });
		await waitFor(() => expect(assign).toHaveProperty("disabled", false));
		setQueryResult("plugins.get_installation_schedule", { ...SCHEDULE, nextRunAt: SCHEDULE.nextRunAt + 60_000 });
		notify_route_store();
		expect(assign, "a due-time refresh must keep the unsaved choice").toHaveProperty("disabled", false);
		setQueryResult("plugins.get_installation_schedule", { ...SCHEDULE, grantId: "grant_2_new" });
		notify_route_store();
		expect(assign, "a new saved grant must clear the old choice").toHaveProperty("disabled", true);
		expect(within(schedule).getByRole("combobox", { name: "Run as" }).textContent).toContain(
			"Choose a user who granted access",
		);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("renders mount copies, deletion, shared visibility, and storage limits", () => {
		const plugin = scheduled_plugin();
		setQueries({ plugin, installations: [installed_item(plugin)] });
		setQueryResult("plugins.get_installation_mounts", {
			mounts: [{ mountId: "source", name: "sources" }],
			volumes: [
				{
					volumeId: "volume_1",
					mountId: "source",
					mountName: "sources",
					volumeKey: "repo",
					deleting: false,
					published: { revision: null, publishedAt: 1_700_000_000_000, fileCount: 8, bytes: 1200 },
					staging: { stagingId: "staging_1", revision: null, expiresAt: 1_700_000_100_000, fileCount: 3, bytes: 800 },
				},
				{
					volumeId: "volume_2",
					mountId: "removed",
					mountName: null,
					volumeKey: "old",
					deleting: true,
					published: null,
					staging: null,
				},
			],
			usage: { fileCount: 11, bytes: 2000, dailyFilesLeft: 9989 },
			limits: {
				copyFiles: 5000,
				copyBytes: 30_000_000,
				installationFiles: 20_000,
				installationBytes: 200_000_000,
				dailyFiles: 10_000,
				volumesPerMount: 32,
				volumesPerInstallation: 128,
			},
		});
		render(<PageComponent />);
		const mounts = screen.getByRole("region", { name: "Mounts" });
		expect(mounts.textContent).toContain("/.mounts/sources/repo");
		expect(mounts.textContent).toContain("Open staging copy");
		expect(mounts.textContent).toContain("Deleting");
		expect(mounts.textContent).toContain("9,989");
		expect(mounts.textContent).toContain("Folder sharing limits do not apply");
		expect(mounts.textContent).toContain("Hidden or not provided");
	});

	test("pages retained history and loads bounded API calls only on expansion", async () => {
		const plugin = scheduled_plugin();
		setQueries({ plugin, installations: [installed_item(plugin)] });
		const loadMore = vi.fn();
		usePaginatedQueryMock.mockImplementation((query: string) =>
			query === "plugins.list_run_history"
				? {
						results: [
							{
								_id: "run_1",
								event: "schedule.interval.elapsed",
								status: "succeeded",
								actorUserId: "user_2",
								actorName: "Ada",
								runAsGrantId: "grant_2",
								chainRootRunId: "run_root",
								chainIndex: 1,
								apiCallCount: 1,
								outputWriteCount: 2,
								errorMessage: null,
								errorCode: null,
								createdAt: 1_700_000_000_000,
								updatedAt: 1_700_000_000_100,
								startedAt: 1_700_000_000_000,
								finishedAt: 1_700_000_000_100,
								file: null,
							},
						],
						status: "CanLoadMore",
						loadMore,
					}
				: undefined,
		);
		setQueryResult("plugins.list_run_calls", [
			{
				_id: "call_1",
				runId: "run_1",
				sequence: 1,
				kind: "http",
				route: "/api/v1/volumes/publish",
				status: "succeeded",
				responseStatus: 200,
				requestBytes: 44,
				responseBytes: 12,
				errorMessage: null,
				startedAt: 1_700_000_000_000,
				finishedAt: 1_700_000_000_100,
				elapsedMs: 100,
			},
		]);
		render(<PageComponent />);
		fireEvent.click(screen.getByText("Activity"));
		expect(screen.getByText("Run history is kept without a time limit.")).not.toBeNull();
		expect(screen.getByText(/Run as Ada/).textContent).toContain("Step 2");
		expect(useQueryMock).toHaveBeenCalledWith("plugins.list_run_calls", "skip");
		fireEvent.click(screen.getByRole("button", { name: "Show API calls" }));
		expect(screen.getByText("1. /api/v1/volumes/publish")).not.toBeNull();
		expect(useQueryMock).toHaveBeenCalledWith("plugins.list_run_calls", {
			membershipId: "membership_1",
			installationId: "installation_1",
			runId: "run_1",
		});
		fireEvent.click(screen.getByRole("button", { name: "Load more runs" }));
		expect(loadMore).toHaveBeenCalledWith(25);
	});
});

describe("RoutePluginsPluginAccess", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The consent dialog carries the same warning in the same words, so read this screen by its own
	// heading. Asserting on the whole document would pass on the dialog's copy alone.
	function access_section() {
		const section = screen.getByRole("heading", { name: "Access & automation" }).closest("section");
		if (!section) {
			throw new Error("Access section not found");
		}

		return section;
	}

	test.each([true, false])("shows the account-deletion trigger only with an active handler: %s", (active) => {
		const plugin = published_plugin({ name: "account-listener", canProcessFiles: false });
		const installed = installed_item(plugin);
		setQueries({
			plugin,
			installations: [
				{
					...installed,
					version: {
						...installed.version,
						events: [{ type: "users.account.deleted", contentTypes: [], filters: [] }],
					},
					handlers: active ? [{ event: "users.account.deleted" }] : [],
				},
			],
		});

		render(<PageComponent />);

		expect(access_section().textContent?.includes("Users Account Deleted")).toBe(active);
		expect(access_section().textContent?.includes("No active triggers.")).toBe(!active);
	});

	test("warns that file views are trusted for a plugin that ships no pages", () => {
		// Video Player's shape: no pages, one file view. Its session is minted from the same table as a
		// page session and gets the same workspace-wide file scopes, so an admin reviewing this screen
		// must be shown the same warning. Gating it on `pages` hid it for exactly this plugin.
		setQueries({
			plugin: published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
			}),
		});

		render(<PageComponent />);

		const access = access_section();
		// Assert the surface really rendered before trusting the warning below.
		expect(access.textContent).toContain("Video player");
		expect(access.textContent).toContain(
			"Plugin pages and file views are trusted with the data their capabilities expose",
		);
	});

	test("warns that pages are trusted for a plugin that ships no file views", () => {
		// The mirror of the test above. Council, Gallery and Chitchat all ship pages and no file views,
		// so a gate on `fileViews` alone hides this warning on every plugin that exists today, and only
		// this direction catches that.
		setQueries({
			plugin: published_plugin({
				name: "gallery",
				canProcessFiles: false,
				pages: [
					{
						id: "browse",
						title: "Gallery browser",
						entry: "dist/frontend/index.html",
						navItem: { label: "Gallery", icon: "images" },
					},
				],
			}),
		});

		render(<PageComponent />);

		const access = access_section();
		// Assert the plugin really ships one surface and not the other before trusting the warning.
		expect(access.textContent).toContain("Gallery browser");
		expect(access.textContent).toContain("No file views.");
		expect(access.textContent).toContain(
			"Plugin pages and file views are trusted with the data their capabilities expose",
		);
	});

	test("stays silent about frame trust for a plugin with neither surface", () => {
		setQueries({ plugin: published_plugin({ name: "media", canProcessFiles: true }) });

		render(<PageComponent />);

		const access = access_section();
		// Assert both surfaces really are absent before trusting the absence below.
		expect(access.textContent).toContain("No UI pages.");
		expect(access.textContent).toContain("No file views.");
		expect(access.textContent).not.toContain("trusted with the data their capabilities expose");
	});

	test("names both frame surfaces on the origins a member's browser can call", () => {
		// One `uiOutboundOrigins` list is set on the version and applied to every plugin asset response,
		// so it widens a file view's policy exactly as it widens a page's.
		setQueries({
			plugin: published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
				uiOutboundOrigins: ["https://cdn.example.com"],
			}),
		});

		render(<PageComponent />);

		const access = access_section();
		expect(access.textContent).toContain("Page and file view network access");
		expect(access.textContent).toContain("https://cdn.example.com");
		expect(access.textContent).toContain("A plugin page and a file view both run in a member's browser");
	});

	test("lists MCP servers with their policy and sign-in, skills, and the MCP warning", () => {
		const plugin = published_plugin({ name: "tracker", canProcessFiles: false, ...mcp_plugin_parts });
		setQueries({ plugin, installations: [installed_item(plugin)] });
		const queries = useQueryMock.getMockImplementation()!;
		useQueryMock.mockImplementation((query: string, ...args: unknown[]) =>
			query === "plugins_mcp.get_installation_mcp_status"
				? [{ serverId: "tracker", health: "healthy", policy: "blocked", connection: null }]
				: queries(query, ...args),
		);
		notify_route_store();

		render(<PageComponent />);

		const access = access_section();
		const server = within(access).getByText(/^Tracker — mcp\.example\.com/);
		expect(server.getAttribute("data-organization-policy")).toBe("blocked");
		expect(server.textContent).toContain("Blocked by your organization's MCP policy");
		expect(server.textContent).toContain("Not connected");
		expect(access.textContent).toContain("triage — Sort new issues.");
		expect(access.textContent).toContain(mcp_warning);
		expect(within(access).queryByRole("button", { name: "Connect Tracker" })).toBeNull();
	});

	test.each([
		{ connection: null, button: "Connect Tracker" },
		{
			connection: { status: "connected", scopes: ["read"], authorizationHost: "auth.example.com", connectedAt: 1 },
			button: "Disconnect Tracker",
		},
	])("an allowed sign-in server offers $button", async ({ connection, button }) => {
		const plugin = published_plugin({ name: "tracker", canProcessFiles: false, ...mcp_plugin_parts });
		setQueries({ plugin, installations: [installed_item(plugin)] });
		const queries = useQueryMock.getMockImplementation()!;
		useQueryMock.mockImplementation((query: string, ...args: unknown[]) =>
			query === "plugins_mcp.get_installation_mcp_status"
				? [{ serverId: "tracker", health: "healthy", policy: "allowed", connection }]
				: query === "plugins_mcp_oauth.can_connect"
					? true
					: queries(query, ...args),
		);
		notify_route_store();
		actionMock.mockResolvedValue({ _nay: { message: "Stop here" } });
		mutationMock.mockResolvedValue({ _yay: null });

		render(<PageComponent />);

		const target = { kind: "plugin", installationId: "installation_1", serverId: "tracker" };
		await act(async () => {
			fireEvent.click(within(access_section()).getByRole("button", { name: button }));
		});
		if (connection === null) {
			expect(actionMock).toHaveBeenCalledWith("plugins_mcp_oauth.start", {
				membershipId: "membership_1",
				target,
				returnPath: "/w/team/home/plugins/tracker",
			});
		} else {
			expect(mutationMock).toHaveBeenCalledWith("plugins_mcp_oauth.disconnect", {
				membershipId: "membership_1",
				target,
			});
		}
	});
});

describe("RoutePluginsPluginSecretsModalPanel", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	// The publisher scope mounts the panel with the fewest moving parts: no installation, so no
	// health or configuration sections, and the modal holds a single untabbed panel.
	function open_publisher_secrets_form() {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [], publisherPlugin: publisher_plugin_fixture() });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Manage secrets" }));

		return {
			nameInput: screen.getByLabelText("Name"),
			valueInput: screen.getByLabelText("Value"),
			saveButton: screen.getByRole("button", { name: "Save" }) as HTMLButtonElement,
		};
	}

	test("a multi-line env paste that saves lands the fallen focus on the Name input", async () => {
		let resolveImport!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveImport = resolve;
			}),
		);
		const { nameInput, valueInput, saveButton } = open_publisher_secrets_form();

		// Half-typed fields keep the Save button enabled, so the member can move onto it mid-import.
		fireEvent.change(nameInput, { target: { value: "HALF_TYPED" } });
		fireEvent.change(valueInput, { target: { value: "half value" } });
		fireEvent.paste(nameInput, { clipboardData: { getData: () => "API_KEY=one\nAPI_URL=two\n" } });
		// Assert the paste really started the import before trusting the landing below.
		expect(mutationMock).toHaveBeenCalledTimes(1);
		act(() => saveButton.focus());

		await act(async () => {
			resolveImport({ _yay: { count: 2 } });
		});

		// The finished import cleared both fields, which disables Save, and a browser blurs a
		// focused control the moment it becomes disabled. The deliberate landing is the Name input,
		// where the next secret starts.
		expect(saveButton.disabled).toBe(true);
		expect(document.activeElement).toBe(nameInput);
	});

	test("an env paste that settles after the member moved on leaves focus where it is", async () => {
		let resolveImport!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveImport = resolve;
			}),
		);
		const { nameInput, valueInput } = open_publisher_secrets_form();

		fireEvent.change(nameInput, { target: { value: "HALF_TYPED" } });
		fireEvent.change(valueInput, { target: { value: "half value" } });
		fireEvent.paste(nameInput, { clipboardData: { getData: () => "API_KEY=one\nAPI_URL=two\n" } });
		expect(mutationMock).toHaveBeenCalledTimes(1);
		act(() => valueInput.focus());

		await act(async () => {
			resolveImport({ _yay: { count: 2 } });
		});

		expect(document.activeElement).toBe(valueInput);
	});

	test("a second env paste while an import is in flight is refused with a toast and does not start another mutation", async () => {
		let resolveImport!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveImport = resolve;
			}),
		);
		const { nameInput } = open_publisher_secrets_form();

		fireEvent.paste(nameInput, { clipboardData: { getData: () => "API_KEY=one\nAPI_URL=two\n" } });
		expect(mutationMock).toHaveBeenCalledTimes(1);

		fireEvent.paste(nameInput, { clipboardData: { getData: () => "OTHER_KEY=three\nOTHER_URL=four\n" } });
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(toastErrorMock).toHaveBeenCalledWith("Cannot import secrets while a save or delete is in progress");

		await act(async () => {
			resolveImport({ _yay: { count: 2 } });
		});
	});
});

describe("RoutePluginsPluginConfiguration", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});

		// The configuration editor mounts only when the app's Monaco hoisting container exists,
		// because the real editor parks its overflow widgets there.
		const hoistingContainer = document.createElement("div");
		hoistingContainer.id = "app_monaco_hoisting_container";
		document.body.appendChild(hoistingContainer);
	});

	afterEach(() => {
		cleanup();
		document.getElementById("app_monaco_hoisting_container")?.remove();
		vi.clearAllMocks();
	});

	test("a save keeps its button focusable and lands the focus on the saved status line", async () => {
		const plugin = published_plugin({ name: "gallery", canProcessFiles: true });
		setQueries({ plugin, installations: [installed_item(plugin)] });
		let resolveSave!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
		);

		render(<PageComponent />);

		const editor = screen.getByRole("textbox", { name: "Plugin configuration YAML" });
		fireEvent.change(editor, { target: { value: "note: draft\n" } });
		const saveButton = screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement;
		act(() => saveButton.focus());
		fireEvent.click(saveButton);

		// While the save runs the button must stay enabled: a browser blurs a focused control the
		// moment it becomes disabled, and the focus would fall to the page body.
		expect(saveButton.disabled).toBe(false);
		expect(saveButton.getAttribute("aria-busy")).toBe("true");
		expect(document.activeElement).toBe(saveButton);

		await act(async () => {
			resolveSave({ _yay: null });
		});

		// The saved draft now equals the server text, which legitimately disables Save, so the
		// deliberate landing is the status line announcing the result.
		const status = screen.getByText("Configuration saved");
		expect(status.getAttribute("role")).toBe("status");
		expect(document.activeElement).toBe(status);
		expect(saveButton.disabled).toBe(true);
	});

	test("a save that settles after the member moved on leaves focus where it is", async () => {
		const plugin = published_plugin({ name: "gallery", canProcessFiles: true });
		setQueries({ plugin, installations: [installed_item(plugin)] });
		let resolveSave!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
		);

		render(<PageComponent />);

		const editor = screen.getByRole("textbox", { name: "Plugin configuration YAML" });
		fireEvent.change(editor, { target: { value: "note: draft\n" } });
		const saveButton = screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement;
		act(() => saveButton.focus());
		fireEvent.click(saveButton);
		act(() => editor.focus());

		await act(async () => {
			resolveSave({ _yay: null });
		});

		expect(screen.getByText("Configuration saved")).not.toBeNull();
		expect(document.activeElement).toBe(editor);
	});
});

describe("RoutePluginsPlugin", () => {
	beforeEach(() => {
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationName: "team",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("shows public details without exposing an unmanaged installation", () => {
		const plugin = published_plugin({
			name: "media",
			canProcessFiles: true,
			canInstall: false,
			canManage: false,
			capabilities: ["plugin.secrets.read"],
		});
		setQueries({ plugin });

		render(<PageComponent />);

		expect(useQueryMock, "members must query the public plugin catalog").toHaveBeenCalledWith(
			"plugins.list_published_plugins",
			{ membershipId: "membership_1" },
		);
		expect(screen.getByRole("heading", { level: 1, name: "media" })).not.toBeNull();
		expect(useQueryMock).toHaveBeenCalledWith("plugins.list_installations", { membershipId: "membership_1" });
		expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Manage secrets" })).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Plugin configuration YAML" })).toBeNull();
	});

	test("says why the organization policy blocks an install and disables Install", () => {
		setQueries({
			plugin: published_plugin({ name: "media", canProcessFiles: true, organizationPolicy: "needs_approval" }),
		});

		const { container } = render(<PageComponent />);

		expect(screen.getByRole("button", { name: "Install" })).toHaveProperty("disabled", true);
		expect(screen.getByText("Needs your organization owner's approval.")).toBeTruthy();
		expect(container.querySelector("header")?.getAttribute("data-organization-policy")).toBe("needs_approval");
	});

	test("enables a disabled installation by installing the same version again", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		const installed = installed_item(plugin);
		installed.installation.status = "disabled";
		setQueries({ plugin, installations: [installed] });
		mutationMock.mockResolvedValue({ _yay: { installationId: "installation_1" } });

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Enable" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and enable" }));

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(
				"plugins.install_version",
				expect.objectContaining({ pluginVersionId: "version_1" }),
			),
		);
	});

	test("allows a service registration with no data or Files scopes", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [], publisherPlugin: publisher_plugin_fixture() });
		const previousQuery = useQueryMock.getMockImplementation()!;
		useQueryMock.mockImplementation((query: string) =>
			query === "plugins.get_plugin_service_registration"
				? { exists: false, scopes: [], updatedAt: null }
				: previousQuery(query),
		);
		mutationMock.mockResolvedValue({ _yay: { exchangeSecret: "pse_example" } });
		render(<PageComponent />);
		for (const name of ["plugin_data:read", "plugin_data:write", "files:write"])
			fireEvent.click(screen.getByRole("checkbox", { name }));
		fireEvent.click(screen.getByRole("button", { name: "Generate secret" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("plugins.set_plugin_service_registration", {
				pluginName: "media",
				scopes: [],
			}),
		);
		expect(await screen.findByText("pse_example")).toBeTruthy();
	});

	test("remounts plugin-local state when any route identity changes", () => {
		const remountKeys = [
			{ organizationName: "team", workspaceName: "home", pluginName: "media" },
			{ organizationName: "other-team", workspaceName: "home", pluginName: "media" },
			{ organizationName: "team", workspaceName: "other-workspace", pluginName: "media" },
			{ organizationName: "team", workspaceName: "home", pluginName: "other-plugin" },
		].map((params) => {
			paramsMock.mockReturnValue(params);
			return route_remount_key();
		});

		expect(new Set(remountKeys).size).toBe(remountKeys.length);
	});

	test("does not show plugin A install progress or dialog on plugin B", async () => {
		const pluginA = published_plugin({ name: "media-a", canProcessFiles: true });
		const pluginB = published_plugin({ name: "media-b", canProcessFiles: true });
		let resolveInstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveInstall = resolve;
			}),
		);
		setQueries({ plugin: pluginA, installations: [], publisherPlugin: publisher_plugin_fixture() });
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and install" }));

		setQueries({ plugin: pluginB, installations: [], publisherPlugin: publisher_plugin_fixture() });
		view.rerender(<RemountingPageComponent />);

		expect(screen.queryByRole("dialog")).toBeNull();
		const installButton = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
		expect(installButton.disabled).toBe(true);
		expect(installButton.getAttribute("aria-busy")).toBeNull();
		expect(
			(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.getByRole("menuitem", { name: "Remove claim" }).getAttribute("aria-disabled")).toBe("true");

		const destinationControl = screen.getByRole("button", { name: "More actions" });
		act(() => destinationControl.focus());
		await act(async () => resolveInstall({ _yay: null }));

		await waitFor(() => expect(installButton.disabled).toBe(false));
		expect(document.activeElement).toBe(destinationControl);
	});

	test("does not show plugin A uninstall progress or move focus on plugin B", async () => {
		const pluginA = published_plugin({ name: "media-a", canProcessFiles: true });
		const pluginB = published_plugin({ name: "media-b", canProcessFiles: true });
		let resolveUninstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveUninstall = resolve;
			}),
		);
		setQueries({
			plugin: pluginA,
			installations: [installed_item(pluginA)],
			publisherPlugin: publisher_plugin_fixture(),
		});
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		setQueries({
			plugin: pluginB,
			installations: [installed_item(pluginB)],
			publisherPlugin: publisher_plugin_fixture(),
		});
		view.rerender(<RemountingPageComponent />);

		const uninstallButton = screen.getByRole("button", { name: "Uninstall" }) as HTMLButtonElement;
		expect(uninstallButton.disabled).toBe(true);
		expect(uninstallButton.getAttribute("aria-busy")).toBe("false");

		const destinationControl = screen.getByRole("button", { name: "More actions" });
		act(() => destinationControl.focus());
		await act(async () => resolveUninstall({ _yay: null }));

		await waitFor(() => expect(uninstallButton.disabled).toBe(false));
		expect(document.activeElement).toBe(destinationControl);
	});

	test("repairs remove-claim focus after leaving and returning to the plugin", async () => {
		const pluginA = published_plugin({ name: "media-a", canProcessFiles: true });
		const pluginB = published_plugin({ name: "media-b", canProcessFiles: true });
		let resolveRemove!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveRemove = resolve;
			}),
		);
		setQueries({ plugin: pluginA, installations: [], publisherPlugin: publisher_plugin_fixture() });
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("menuitem", { name: "Remove claim" }));
		setQueries({ plugin: pluginB });
		view.rerender(<RemountingPageComponent />);
		setQueries({ plugin: pluginA, installations: [], publisherPlugin: publisher_plugin_fixture() });
		view.rerender(<RemountingPageComponent />);

		// Remount must clear plugin-local removing state. Without it the label stays on
		// "Removing claim..." from the earlier A visit, and the provider focus repair is not what ran.
		expect(screen.queryByRole("menuitem", { name: "Removing claim..." })).toBeNull();
		expect(screen.getByRole("menuitem", { name: "Remove claim" })).toBeTruthy();

		const replacementTrigger = screen.getByRole("button", { name: "More actions" });
		act(() => replacementTrigger.focus());
		await act(async () => resolveRemove({ _yay: null }));
		setQueries({ plugin: pluginA });
		view.rerender(<RemountingPageComponent />);

		const title = screen.getByRole("heading", { level: 1, name: "media-a" });
		await waitFor(() => expect(document.activeElement).toBe(title));
	});

	test("shows current plugin B while retrying the exact repository A publish", async () => {
		const headSha = "fedcba9876543210fedcba9876543210fedcba98";
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const pluginA = published_plugin({ name: "media-a", canProcessFiles: true });
		const pluginB = published_plugin({ name: "media-b", canProcessFiles: true });
		const publisherA = publisher_plugin_fixture();
		const publisherB = {
			...publisherA,
			repository: {
				...publisherA.repository,
				_id: "repository_2",
				owner: "fork",
				repo: "bonobo-plugin-media-b",
				repositoryUrl: "https://github.com/fork/bonobo-plugin-media-b",
			},
		};
		let finishHead!: (result: { _yay: { sourceCommitSha: string } }) => void;
		let finishPublish!: (result: { _nay: { name: string; message: string } }) => void;
		actionMock
			.mockReturnValueOnce(
				new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
					finishHead = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise<{ _nay: { name: string; message: string } }>((resolve) => {
					finishPublish = resolve;
				}),
			)
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } })
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		setQueries({ plugin: pluginA, installations: [], publisherPlugin: publisherA });
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		setQueries({ plugin: pluginB, installations: [], publisherPlugin: publisherB });
		view.rerender(<PageComponent />);
		expect(screen.getByRole("heading", { level: 1, name: "media-b" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Publish ray/bonobo-plugin-media" })).toBeNull();
		expect(
			(screen.getByRole("button", { name: "Publish fork/bonobo-plugin-media-b" }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.getByRole("dialog").textContent).toContain("Checking repository commit...");

		await act(async () => finishHead({ _yay: { sourceCommitSha: headSha } }));
		const reviewedCommit = await screen.findByRole("textbox");
		expect(screen.getByRole("dialog").textContent).toContain("Publish ray/bonobo-plugin-media");
		fireEvent.change(reviewedCommit, { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		await act(async () => {
			finishPublish({ _nay: { name: "conflict", message: "Repository A changed after review" } });
		});
		expect((await screen.findByRole("alert")).textContent).toBe("Repository A changed after review");
		const nextReviewedCommit = await screen.findByRole("textbox");
		expect((nextReviewedCommit as HTMLInputElement).value).toBe("");
		expect(screen.getByRole("dialog").textContent).toContain(nextHeadSha);
		fireEvent.change(nextReviewedCommit, { target: { value: nextHeadSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		await waitFor(() =>
			expect(actionMock).toHaveBeenNthCalledWith(4, "plugins.publish_version", {
				repositoryId: "repository_1",
				expectedSourceCommitSha: nextHeadSha,
			}),
		);
		await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "media-b" })).toBeTruthy());
		expect(screen.getByRole("button", { name: "Publish fork/bonobo-plugin-media-b" })).toBeTruthy();
	});

	test("keeps public details when publisher access is lost below the publish dialog", async () => {
		const headSha = "fedcba9876543210fedcba9876543210fedcba98";
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		let finishHead!: (result: { _yay: { sourceCommitSha: string } }) => void;
		actionMock.mockReturnValueOnce(
			new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
				finishHead = resolve;
			}),
		);
		setQueries({ plugin, installations: [], publisherPlugin: publisher_plugin_fixture() });
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		useQueryMock.mockImplementation((query: string) => {
			switch (query) {
				case "plugins.list_published_plugins":
					return [{ ...plugin, canInstall: false, canManage: false }];
				case "plugins.list_installations":
					return [];
				case "plugins.get_publisher_plugin":
					return null;
				default:
					return undefined;
			}
		});
		notify_route_store();
		view.rerender(<PageComponent />);

		expect(screen.queryByText("Loading plugin...")).toBeNull();
		expect(screen.getByRole("heading", { level: 1, name: "media" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
		expect(screen.getByRole("dialog").textContent).toContain("Checking repository commit...");

		await act(async () => finishHead({ _yay: { sourceCommitSha: headSha } }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const title = screen.getByRole("heading", { level: 1, name: "media" });
		await waitFor(() => expect(document.activeElement).toBe(title));
	});

	test("keeps a thrown A publish error visible after navigation and releases B on Cancel", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const headSha = "fedcba9876543210fedcba9876543210fedcba98";
		const pluginA = published_plugin({ name: "media-a", canProcessFiles: true });
		const pluginB = published_plugin({ name: "media-b", canProcessFiles: true });
		const publisherA = publisher_plugin_fixture();
		const publisherB = {
			...publisherA,
			repository: {
				...publisherA.repository,
				_id: "repository_2",
				owner: "fork",
				repo: "bonobo-plugin-media-b",
				repositoryUrl: "https://github.com/fork/bonobo-plugin-media-b",
			},
		};
		let rejectPublish!: (error: unknown) => void;
		actionMock.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } }).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectPublish = reject;
			}),
		);
		setQueries({ plugin: pluginA, installations: [], publisherPlugin: publisherA });
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		fireEvent.change(await screen.findByRole("textbox"), { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		setQueries({ plugin: pluginB, installations: [], publisherPlugin: publisherB });
		view.rerender(<PageComponent />);
		await act(async () => rejectPublish(new Error("network down")));
		expect((await screen.findByRole("alert")).textContent).toBe("Failed to publish plugin");
		expect(screen.getByRole("heading", { level: 1, name: "media-b" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await screen.findByRole("heading", { level: 1, name: "media-b" });
		expect(screen.getByRole("button", { name: "Publish fork/bonobo-plugin-media-b" })).toBeTruthy();
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	test("a publish HEAD check blocks install, uninstall, and claim removal", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		const installedItem = installed_item(plugin);
		installedItem.version.version = "0.1.0";
		setQueries({ plugin, installations: [installedItem], publisherPlugin: publisher_plugin_fixture() });
		let resolveHead!: (value: unknown) => void;
		actionMock.mockReturnValue(
			new Promise((resolve) => {
				resolveHead = resolve;
			}),
		);

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));

		const updateButton = screen.getByRole("button", { name: "Update" }) as HTMLButtonElement;
		const uninstallButton = screen.getByRole("button", { name: "Uninstall" }) as HTMLButtonElement;
		const removeItem = screen.getByRole("menuitem", { name: "Remove claim" });
		expect(updateButton.disabled).toBe(true);
		expect(uninstallButton.disabled).toBe(true);
		expect(removeItem.getAttribute("aria-disabled")).toBe("true");

		fireEvent.click(updateButton);
		fireEvent.click(uninstallButton);
		// The menu mock still calls a disabled item's handler, which proves the handler guard too.
		fireEvent.click(removeItem);
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();

		await act(async () => {
			resolveHead({ _nay: { name: "nay", message: "HEAD unavailable" } });
		});
	});

	test("an install in flight keeps its own control enabled and blocks publish and claim removal", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [], publisherPlugin: publisher_plugin_fixture() });
		let resolveInstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveInstall = resolve;
			}),
		);

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const acceptButton = screen.getByRole("button", { name: "Accept and install" }) as HTMLButtonElement;
		fireEvent.click(acceptButton);

		const publishButton = screen.getByRole("button", {
			name: "Publish ray/bonobo-plugin-media",
		}) as HTMLButtonElement;
		expect(acceptButton.disabled).toBe(false);
		expect(publishButton.disabled).toBe(true);
		expect(screen.getByRole("menuitem", { name: "Remove claim" }).getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(publishButton);
		expect(actionMock).not.toHaveBeenCalled();

		await act(async () => {
			resolveInstall({ _nay: { name: "nay", message: "Install refused" } });
		});
	});

	test("an uninstall in flight keeps its button enabled and blocks publish and claim removal", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [installed_item(plugin)], publisherPlugin: publisher_plugin_fixture() });
		let resolveUninstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveUninstall = resolve;
			}),
		);

		render(<PageComponent />);
		const uninstallButton = screen.getByRole("button", { name: "Uninstall" }) as HTMLButtonElement;
		fireEvent.click(uninstallButton);

		const publishButton = screen.getByRole("button", {
			name: "Publish ray/bonobo-plugin-media",
		}) as HTMLButtonElement;
		expect(uninstallButton.disabled).toBe(false);
		expect(uninstallButton.getAttribute("aria-busy")).toBe("true");
		expect(publishButton.disabled).toBe(true);
		expect(screen.getByRole("menuitem", { name: "Remove claim" }).getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(publishButton);
		expect(actionMock).not.toHaveBeenCalled();

		await act(async () => {
			resolveUninstall({ _nay: { name: "nay", message: "Uninstall refused" } });
		});
	});

	test("a finished install lands the fallen focus on the plugin title", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin });
		let resolveInstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveInstall = resolve;
			}),
		);

		const { rerender } = render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and install" }));

		await act(async () => {
			resolveInstall({ _yay: null });
		});

		// The mocked modal cannot model Ariakit's focus restore. In the real app the closing modal
		// puts the focus back on the Install button, and the reactive installations update then
		// unmounts that button, dropping the focus to the page body. jsdom already has the focus on
		// the body here, so this test pins the app's own landing effect, not the Ariakit step
		// before it.
		expect(document.activeElement).toBe(document.body);

		setQueries({ plugin, installations: [installed_item(plugin)] });
		rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "media" }));
	});

	test("remove claim keeps the trigger focusable, guards re-entry, and lands the focus", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin, installations: [], publisherPlugin: publisher_plugin_fixture() });
		let resolveRemove!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveRemove = resolve;
			}),
		);

		const { rerender } = render(<PageComponent />);
		expect(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" })).toBeTruthy();
		const removeItem = screen.getByRole("menuitem", { name: "Remove claim" });
		fireEvent.click(removeItem);

		// Mid-flight the trigger must stay enabled: the menu closed on activation and gave its focus
		// back to the trigger, and a disabled control cannot take it.
		const trigger = screen.getByRole("button", { name: "More actions" }) as HTMLButtonElement;
		expect(trigger.disabled).toBe(false);

		// The mocked menu item keeps firing onClick while disabled (see the mock), so this second
		// activation proves the handler's own in-flight guard, not the UI block.
		fireEvent.click(removeItem);
		expect(mutationMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveRemove({ _yay: null });
		});

		// Same honesty note as the install test: jsdom leaves the focus on the body, which is where
		// the unmounting trigger drops it in the real app, so this pins the app's landing effect.
		expect(document.activeElement).toBe(document.body);

		setQueries({ plugin, installations: [], publisherPlugin: null });
		rerender(<PageComponent />);

		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "media" })));
	});

	test("a publisher fallback that loses its claim lands focus on the missing notice", async () => {
		// The public catalog has no version here. The publisher query is the only detail source.
		const setPublisherOnlyQueries = (publisherPlugin: unknown) => {
			paramsMock.mockReturnValue({ pluginName: "media" });
			useQueryMock.mockImplementation((query: string) => {
				switch (query) {
					case "plugins.list_published_plugins":
					case "plugins.list_installations":
						return [];
					case "plugins.get_publisher_plugin":
						return publisherPlugin;
					default:
						return undefined;
				}
			});
			notify_route_store();
		};
		setPublisherOnlyQueries({ ...publisher_plugin_fixture(), versions: [publisher_version_fixture("media")] });
		let resolveRemove!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveRemove = resolve;
			}),
		);

		const { rerender } = render(<PageComponent />);
		fireEvent.click(screen.getByRole("menuitem", { name: "Remove claim" }));

		await act(async () => {
			resolveRemove({ _yay: null });
		});

		// Same honesty note as the test above: jsdom leaves the focus on the body, which is where
		// the unmounting trigger drops it in the real app, so this pins the app's landing effect.
		expect(document.activeElement).toBe(document.body);

		setPublisherOnlyQueries(null);
		rerender(<PageComponent />);

		const missing = screen.getByRole("alert");
		expect(missing.textContent).toContain('No published plugin is named "media".');
		await waitFor(() => expect(document.activeElement).toBe(missing));
	});

	test("an install the backend refuses keeps the consent modal open while the request runs", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin });
		let resolveInstall!: (value: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveInstall = resolve;
			}),
		);

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const accept = screen.getByRole("button", { name: "Accept and install" });
		accept.focus();
		fireEvent.click(accept);

		// Escape asks the controlled modal to close. Ignore it until the request settles so Ariakit
		// never tries to restore focus to the disabled Install trigger behind the modal.
		fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(document.activeElement).toBe(accept);

		await act(async () => {
			resolveInstall({ _nay: { name: "nay", message: "Install refused" } });
		});

		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(document.activeElement).toBe(accept);
	});

	test("an install that fails outright keeps the consent modal and its focus the same way", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries({ plugin });
		let rejectInstall!: (error: unknown) => void;
		mutationMock.mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectInstall = reject;
			}),
		);

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		const accept = screen.getByRole("button", { name: "Accept and install" });
		accept.focus();
		fireEvent.click(accept);

		// Same Escape stand-in as the refusal test above.
		fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(document.activeElement).toBe(accept);

		await act(async () => {
			rejectInstall(new Error("network down"));
		});

		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(document.activeElement).toBe(accept);
	});
});

describe("app.css normalize summary", () => {
	// The route's Activity section is a <details>/<summary>, so its focus ring depends on this
	// app-wide rule. jsdom does not paint outlines, so pin the stylesheet text instead, the way the
	// council plugin's app.test.tsx reads its css off disk. Vitest's root is packages/app, so
	// process.cwd() reaches src/app.css directly; a css import would be stubbed to an empty string.
	test("keeps the summary outline restorable by the global focus ring", () => {
		const css = readFileSync(join(process.cwd(), "src", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

		// Match the whole one-tab-indented `summary { ... }` block, including its nested marker
		// rule. Assert the match first so a renamed block fails here instead of passing vacuously.
		const summaryRule = /\n\tsummary \{\n([\s\S]*?)\n\t\}/.exec(css);
		expect(summaryRule, "app.css no longer has the normalize summary block").not.toBeNull();

		// The app-wide focus ring is `* { outline: 2px solid transparent }` restored by a
		// color-only `*:focus-visible { outline-color: ... }`. An element-level outline reset sets
		// outline-style, which the restore never puts back, so no <summary> in the app could ever
		// show a focus ring.
		expect(summaryRule![1]).not.toMatch(/outline(?:-style)?\s*:\s*(?:none|0)/);
	});
});
