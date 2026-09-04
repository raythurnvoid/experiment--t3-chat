/**
 * @vitest-environment jsdom
 *
 * The consent modal promises an admin what a plugin reaches before install, and the Access screen
 * repeats that promise afterwards. Both are covered by rendering the route, not by reading the JSX.
 * They must say the same thing about the same surfaces, so a warning added to one and missed on the
 * other is the failure these tests exist to catch.
 */
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps, ReactElement, ReactNode, Ref } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { paramsMock, tenantContextMock, useQueryMock, mutationMock, actionMock, toastErrorMock } = vi.hoisted(() => ({
	paramsMock: vi.fn(),
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	actionMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({
		options,
		useParams: () => paramsMock(),
	}),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, success: vi.fn() },
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: mutationMock, action: actionMock },
	app_convex_api: {
		organizations: { list: "organizations.list" },
		plugins: {
			list_installations: "plugins.list_installations",
			list_published_plugins: "plugins.list_published_plugins",
			get_publisher_plugin: "plugins.get_publisher_plugin",
			get_installation_health: "plugins.get_installation_health",
			list_recent_runs: "plugins.list_recent_runs",
			list_installation_secrets: "plugins.list_installation_secrets",
			list_publisher_repository_secrets: "plugins.list_publisher_repository_secrets",
			upsert_publisher_repository_secrets: "plugins.upsert_publisher_repository_secrets",
			update_installation_configuration: "plugins.update_installation_configuration",
			install_version: "plugins.install_version",
			remove_repository: "plugins.remove_repository",
			get_publish_candidate_head: "plugins.get_publish_candidate_head",
			publish_version: "plugins.publish_version",
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
		return props.open ? (
			<div>
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

// The real menu is an Ariakit popover: it portals, only mounts its items while open, closes on
// item activation, and returns the menu's focus to the trigger. None of that runs here — this mock
// renders the trigger and the items inline so a test can reach both.
//
// Ariakit also blocks a disabled item's activation; the mocked item deliberately keeps firing
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
	return <PageComponent key={route_remount_key()} />;
}

function published_plugin(overrides: {
	name: string;
	canProcessFiles: boolean;
	capabilities?: string[];
	pages?: Array<{ id: string; title: string; entry: string; navItem: { label: string; icon: string | null } | null }>;
	fileViews?: Array<{ id: string; title: string; entry: string; contentTypes: string[] }>;
	uiOutboundOrigins?: string[];
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
		capabilities: overrides.capabilities ?? ["plugin.data.read"],
		outboundOrigins: [],
		uiOutboundOrigins: overrides.uiOutboundOrigins ?? [],
		pages: overrides.pages ?? [],
		fileViews: overrides.fileViews ?? [],
	};
}

function installed_item(plugin: ReturnType<typeof published_plugin>) {
	return {
		installation: {
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
			events: [],
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
		events: [],
		capabilities: ["plugin.data.read"],
		outboundOrigins: [],
		uiOutboundOrigins: [],
		pages: [],
		fileViews: [],
		artifactHash: "artifact_1",
		sourceCommitSha: "1234567890abcdef",
		updatedAt: 1_700_000_000_000,
	};
}

function setQueries(
	plugin: ReturnType<typeof published_plugin>,
	installations: unknown[] = [],
	publisherPlugin: unknown = null,
) {
	paramsMock.mockReturnValue({ organizationName: "team", workspaceName: "home", pluginName: plugin.name });
	useQueryMock.mockImplementation((query: string) => {
		switch (query) {
			case "organizations.list":
				return { workspaceIdsPermissionsDict: { workspace_1: ["workspace.plugins.manage"] } };
			case "plugins.list_published_plugins":
				return [plugin];
			case "plugins.list_installations":
				return installations;
			case "plugins.get_publisher_plugin":
				return publisherPlugin;
			default:
				return undefined;
		}
	});
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
		setQueries(published_plugin({ name: "media", canProcessFiles: true }));

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		expect(screen.getByRole("dialog").textContent).toContain("triggering upload");
	});

	test("does not promise the upload baseline for a page-only plugin", () => {
		// Council's shape: no backend entrypoint and no declared events, so no run ever starts and its
		// page token carries no write scope. Telling an admin otherwise overstates the grant.
		setQueries(published_plugin({ name: "council", canProcessFiles: false }));

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
		setQueries(
			published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
			}),
		);

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
		setQueries(
			published_plugin({
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
		);

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
		setQueries(
			published_plugin({
				name: "council",
				canProcessFiles: false,
				capabilities: ["plugin.data.read", "plugin.service.connect"],
				pages: [{ id: "room", title: "Council room", entry: "dist/frontend/index.html", navItem: null }],
			}),
		);

		render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Install" }));

		const dialog = screen.getByRole("dialog");
		// Assert the capability really rendered before trusting the warning below.
		expect(dialog.textContent).toContain("This plugin can use these capabilities");
		expect(dialog.textContent).toContain(
			"This plugin's pages and file views can pass their access to the publisher's own server",
		);
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

	test("warns that file views are trusted for a plugin that ships no pages", () => {
		// Video Player's shape: no pages, one file view. Its session is minted from the same table as a
		// page session and gets the same workspace-wide file scopes, so an admin reviewing this screen
		// must be shown the same warning. Gating it on `pages` hid it for exactly this plugin.
		setQueries(
			published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
			}),
		);

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
		setQueries(
			published_plugin({
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
		);

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
		setQueries(published_plugin({ name: "media", canProcessFiles: true }));

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
		setQueries(
			published_plugin({
				name: "video-player",
				canProcessFiles: false,
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				],
				uiOutboundOrigins: ["https://cdn.example.com"],
			}),
		);

		render(<PageComponent />);

		const access = access_section();
		expect(access.textContent).toContain("Page and file view network access");
		expect(access.textContent).toContain("https://cdn.example.com");
		expect(access.textContent).toContain("A plugin page and a file view both run in a member's browser");
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
		setQueries(plugin, [], publisher_plugin_fixture());

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
		setQueries(plugin, [installed_item(plugin)]);
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
		setQueries(plugin, [installed_item(plugin)]);
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
		setQueries(pluginA, [], publisher_plugin_fixture());
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Install" }));
		fireEvent.click(screen.getByRole("button", { name: "Accept and install" }));

		setQueries(pluginB, [], publisher_plugin_fixture());
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
		setQueries(pluginA, [installed_item(pluginA)], publisher_plugin_fixture());
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		setQueries(pluginB, [installed_item(pluginB)], publisher_plugin_fixture());
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
		setQueries(pluginA, [], publisher_plugin_fixture());
		const view = render(<RemountingPageComponent />);

		fireEvent.click(screen.getByRole("menuitem", { name: "Remove claim" }));
		setQueries(pluginB);
		view.rerender(<RemountingPageComponent />);
		setQueries(pluginA, [], publisher_plugin_fixture());
		view.rerender(<RemountingPageComponent />);

		const replacementTrigger = screen.getByRole("button", { name: "More actions" });
		act(() => replacementTrigger.focus());
		await act(async () => resolveRemove({ _yay: null }));
		setQueries(pluginA);
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
		setQueries(pluginA, [], publisherA);
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		setQueries(pluginB, [], publisherB);
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

	test("shows current permission loss below the repository publish dialog", async () => {
		const headSha = "fedcba9876543210fedcba9876543210fedcba98";
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		let finishHead!: (result: { _yay: { sourceCommitSha: string } }) => void;
		actionMock.mockReturnValueOnce(
			new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
				finishHead = resolve;
			}),
		);
		setQueries(plugin, [], publisher_plugin_fixture());
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		useQueryMock.mockImplementation((query: string) => {
			switch (query) {
				case "organizations.list":
					return { workspaceIdsPermissionsDict: { workspace_1: [] } };
				case "plugins.get_publisher_plugin":
					return null;
				default:
					return undefined;
			}
		});
		view.rerender(<PageComponent />);

		expect(screen.queryByText("Loading plugin...")).toBeNull();
		expect(screen.getByText("You don't have permission to manage plugins in this workspace.")).toBeTruthy();
		expect(screen.getByRole("dialog").textContent).toContain("Checking repository commit...");

		await act(async () => finishHead({ _yay: { sourceCommitSha: headSha } }));
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const denied = await screen.findByRole("alert");
		expect(denied.textContent).toContain("You don't have permission");
		await waitFor(() => expect(document.activeElement).toBe(denied));
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
		setQueries(pluginA, [], publisherA);
		const view = render(<PageComponent />);

		fireEvent.click(screen.getByRole("button", { name: "Publish ray/bonobo-plugin-media" }));
		fireEvent.change(await screen.findByRole("textbox"), { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		setQueries(pluginB, [], publisherB);
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
		setQueries(plugin, [installedItem], publisher_plugin_fixture());
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
		setQueries(plugin, [], publisher_plugin_fixture());
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
		setQueries(plugin, [installed_item(plugin)], publisher_plugin_fixture());
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
		setQueries(plugin);
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

		setQueries(plugin, [installed_item(plugin)]);
		rerender(<PageComponent />);

		expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "media" }));
	});

	test("remove claim keeps the trigger focusable, guards re-entry, and lands the focus", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries(plugin, [], publisher_plugin_fixture());
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

		// Mid-flight the trigger must stay enabled: the menu closed on activation and Ariakit
		// returns the menu's focus to the trigger, and a disabled control cannot take it.
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

		setQueries(plugin, [], null);
		rerender(<PageComponent />);

		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "media" })));
	});

	test("a publisher without manage who removes their claim lands the focus on the denied notice", async () => {
		// A publisher without workspace.plugins.manage is a supported visitor: the page derives the
		// whole detail view from get_publisher_plugin. Removing the claim takes that away, so the
		// next render shows the permission-denied block instead of the hero — the landing must
		// reach that block, because no hero h1 exists any more.
		const setPublisherOnlyQueries = (publisherPlugin: unknown) => {
			paramsMock.mockReturnValue({ pluginName: "media" });
			useQueryMock.mockImplementation((query: string) => {
				switch (query) {
					case "organizations.list":
						return { workspaceIdsPermissionsDict: { workspace_1: [] } };
					case "plugins.get_publisher_plugin":
						return publisherPlugin;
					default:
						return undefined;
				}
			});
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

		const denied = screen.getByRole("alert");
		expect(denied.textContent).toContain("You don't have permission");
		await waitFor(() => expect(document.activeElement).toBe(denied));
	});

	test("an install the backend refuses keeps the consent modal open while the request runs", async () => {
		const plugin = published_plugin({ name: "media", canProcessFiles: true });
		setQueries(plugin);
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
		setQueries(plugin);
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
