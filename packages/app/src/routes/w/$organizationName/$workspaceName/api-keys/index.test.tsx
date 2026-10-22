/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { editor as monaco_editor } from "monaco-editor";
import type { JSX, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tenantContextMock, useQueryMock, mutationMock, copyButtonMock, apiUrlMock, searchMock, accountPermissionMock } =
	vi.hoisted(() => ({
		tenantContextMock: vi.fn(),
		useQueryMock: vi.fn(),
		mutationMock: vi.fn(),
		copyButtonMock: vi.fn(),
		apiUrlMock: vi.fn((path: string) => new URL(`https://api.test${path}`)),
		searchMock: vi.fn(() => ({})),
		accountPermissionMock: vi.fn(() => true),
	}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options, useSearch: searchMock }),
}));

vi.mock("convex/react", () => ({
	useQuery: (query: string, args: unknown) => {
		const result = useQueryMock(query, args);
		if (query === "account_permission") {
			return accountPermissionMock();
		}
		if (query === "anagraphic") {
			return { displayName: "Ada" };
		}
		if (query === "get_account") {
			return { _id: "account_1", name: "Publisher", revokedAt: null };
		}
		return result;
	},
	usePaginatedQuery: () => ({
		results: [{ _id: "account_1", name: "Publisher", revokedAt: null }],
		status: "Exhausted",
		loadMore: vi.fn(),
	}),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		users: { get_anagraphic: "anagraphic" },
		access_control: {
			get_current_user_workspace_permission: "account_permission",
			list_service_accounts: "list_accounts",
			get_service_account: "get_account",
		},
		public_api: {
			api_credentials_list: "public_api.api_credentials_list",
			api_credential_create: "public_api.api_credential_create",
			api_credential_rotate: "public_api.api_credential_rotate",
			api_credential_revoke: "public_api.api_credential_revoke",
		},
	},
}));

vi.mock("@/lib/fetch.ts", () => ({
	app_fetch_main_api_url: (path: string) => apiUrlMock(path),
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("@/components/copy-icon-button.tsx", () => ({
	CopyIconButton: function CopyIconButton(props: { text?: string; tooltipCopy: string }) {
		copyButtonMock(props);
		return <button aria-label={props.tooltipCopy}>{props.tooltipCopy}</button>;
	},
}));

vi.mock("@/components/my-modal.tsx", () => ({
	MyModal: function MyModal(props: { open?: boolean; children?: ReactNode }) {
		return props.open ? <>{props.children}</> : null;
	},
	MyModalPopover: function MyModalPopover(props: { children?: ReactNode; className?: string }) {
		return (
			<div role="dialog" className={props.className}>
				{props.children}
			</div>
		);
	},
	MyModalHeader: function MyModalHeader(props: { children?: ReactNode }) {
		return <header>{props.children}</header>;
	},
	MyModalHeading: function MyModalHeading(props: { children?: ReactNode }) {
		return <h2>{props.children}</h2>;
	},
	MyModalDescription: function MyModalDescription(props: { children?: ReactNode }) {
		return <p>{props.children}</p>;
	},
	MyModalScrollableArea: function MyModalScrollableArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyModalFooter: function MyModalFooter(props: { children?: ReactNode }) {
		return <footer>{props.children}</footer>;
	},
	MyModalCloseTrigger: function MyModalCloseTrigger(props: { disabled?: boolean }) {
		return (
			<button type="button" aria-label="Close" disabled={props.disabled}>
				Close
			</button>
		);
	},
}));

// Monaco cannot run in happy-dom, so the stub is a textarea honoring `value` and `onChange`. Its
// mount handle holds a model from the `monaco-editor` test stub, so the page can set markers on it.
// Keep one handle per editor: `useFn` is mocked above, so `onMount` changes on every render, and a new
// handle each time would make the page store a new editor on every render, forever.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect, useRef, useState } = await import("react");
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
			// Let an edit made through the handle reach the latest `onChange`, like Monaco's change event.
			const onChangeRef = useRef(onChange);
			onChangeRef.current = onChange;
			const [handle] = useState(() => ({
				getModel: () => model,
				updateOptions: () => {},
				setPosition: () => {},
				revealPositionInCenterIfOutsideViewport: () => {},
				focus: () => {},
				pushUndoStop: () => {},
				onDidPaste: () => ({ dispose: () => {} }),
				executeEdits: (_source: string, edits: Array<{ text: string }>) => {
					model.setValue(edits[0]!.text);
					onChangeRef.current?.(edits[0]!.text);
				},
			}));

			useEffect(() => {
				model.setValue(value ?? "");
			}, [model, value]);

			useEffect(() => {
				onMount?.(handle);
			}, [handle, onMount]);

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

vi.mock("@/components/my-tabs.tsx", () => ({
	MyTabs: function MyTabs(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsList: function MyTabsList(props: { children?: ReactNode; "aria-label"?: string }) {
		return <div aria-label={props["aria-label"]}>{props.children}</div>;
	},
	MyTabsTab: function MyTabsTab(props: { children?: ReactNode }) {
		return <button>{props.children}</button>;
	},
	MyTabsPanels: function MyTabsPanels(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyTabsPanel: function MyTabsPanel(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
}));

vi.mock("@/components/monospace-block/monospace-block-text.tsx", () => ({
	TextMonospaceBlock: function TextMonospaceBlock(props: { text?: string; "aria-label"?: string }) {
		return <pre aria-label={props["aria-label"]}>{props.text}</pre>;
	},
}));

import { Route } from "./index.tsx";

const KEY_ID = `pk_${"a".repeat(32)}`;
const API_KEY = `${KEY_ID}.${"b".repeat(64)}`;

type TestCredential = {
	serviceAccountId: string | null;
	serviceAccountName: string | null;
	sponsorUserId: string;
	credentialId: string;
	name: string;
	keyId: string;
	obfuscatedValue: string;
	scopes: Array<
		"files:list" | "files:read" | "files:download" | "files:write" | "plugin_data:read" | "plugin_data:write"
	>;
	createdAt: number;
	revokedAt: number | null;
	lastUsedAt: number | null;
};

function createCredential(overrides?: Partial<TestCredential>): TestCredential {
	return {
		serviceAccountId: null,
		serviceAccountName: null,
		sponsorUserId: "user_1",
		credentialId: "credential_1",
		name: "Local reader",
		keyId: KEY_ID,
		obfuscatedValue: "pk_aaaa••••bbbb",
		scopes: ["files:list", "files:read"],
		createdAt: Date.UTC(2026, 6, 20, 12, 0),
		revokedAt: null,
		lastUsedAt: null,
		...overrides,
	};
}

function renderRoute() {
	const PageComponent = Route.options.component as () => JSX.Element;
	return render(<PageComponent />);
}

function getSetupEditor() {
	return screen.getByRole("textbox", { name: "API key setup JSON" });
}

/**
 * Replace the setup text, like a paste into the editor.
 */
function pasteSetup(setup: { name: string; scopes: string[] } | string) {
	fireEvent.change(getSetupEditor(), {
		target: { value: typeof setup === "string" ? setup : JSON.stringify(setup, null, 2) },
	});
}

function submitSetup() {
	fireEvent.submit(getSetupEditor().closest("form")!);
}

describe("RouteApiKeys", () => {
	beforeEach(() => {
		searchMock.mockReturnValue({});
		accountPermissionMock.mockReturnValue(true);
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "organization_1",
			organizationName: "personal",
			workspaceId: "workspace_1",
			workspaceName: "home",
		});
		useQueryMock.mockReturnValue({ _yay: [] });
		mutationMock.mockResolvedValue({ _yay: null });
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	test("creates, tests, and clears a key from a pasted setup", async () => {
		// The verify route answers with the scopes the key still has, so the message can name them.
		const fetchMock = vi.fn().mockResolvedValue({
			status: 200,
			json: async () => ({
				organizationId: "organization_1",
				workspaceId: "workspace_1",
				scopes: ["files:list", "files:read"],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		mutationMock.mockResolvedValue({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } });
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		// The untouched default setup only lacks a name. It shows no problems until Create is pressed.
		const form = getSetupEditor().closest("form")!;
		expect(form.getAttribute("data-api-key-setup-state")).toBe("default");
		expect(screen.queryByRole("status", { name: "Problems in the setup" })).toBeNull();
		submitSetup();
		expect(form.getAttribute("data-api-key-setup-state")).toBe("invalid");
		expect(screen.getByRole("status", { name: "Problems in the setup" }).textContent).toContain(
			"API key name is required",
		);
		expect(mutationMock).not.toHaveBeenCalled();

		pasteSetup({ name: "  Local script  ", scopes: ["files:list", "files:read", "files:list"] });
		expect(screen.getByRole("list", { name: "Scopes of the new key" }).textContent).toBe(
			"List files files:listRead file content files:read",
		);
		submitSetup();

		await screen.findByRole("heading", { name: "Save your API key" });
		expect(mutationMock).toHaveBeenCalledWith("public_api.api_credential_create", {
			serviceAccountId: null,
			membershipId: "membership_1",
			name: "Local script",
			scopes: ["files:list", "files:read"],
		});
		expect(screen.getByText(API_KEY)).not.toBeNull();
		expect(copyButtonMock).toHaveBeenCalledWith(expect.objectContaining({ text: API_KEY }));

		fireEvent.click(screen.getByRole("button", { name: "Test key" }));
		await screen.findByText("Key verified. It can use: files:list, files:read.");
		expect(fetchMock).toHaveBeenCalledWith(new URL("https://api.test/api/v1/auth/verify"), {
			method: "POST",
			credentials: "omit",
			headers: {
				Authorization: `Bearer ${API_KEY}`,
			},
		});

		fireEvent.click(screen.getByRole("button", { name: "I saved the key" }));
		expect(screen.queryByText(API_KEY)).toBeNull();
	});

	test("uses the account link and refuses scopes that service account keys cannot use", async () => {
		searchMock.mockReturnValue({ serviceAccountId: "account_1" });
		mutationMock.mockResolvedValue({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } });
		renderRoute();
		expect(screen.getByRole("combobox", { name: "Identity" }).textContent).toContain("Publisher");

		pasteSetup({ name: "Deploy key", scopes: ["files:list", "files:publish"] });
		expect(screen.getByRole("status", { name: "Problems in the setup" }).textContent).toContain(
			"Service account keys cannot use files:publish.",
		);
		submitSetup();
		expect(mutationMock).not.toHaveBeenCalled();

		pasteSetup({ name: "Deploy key", scopes: ["files:list", "files:permissions"] });
		submitSetup();
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("public_api.api_credential_create", {
				membershipId: "membership_1",
				name: "Deploy key",
				serviceAccountId: "account_1",
				scopes: ["files:list", "files:permissions"],
			}),
		);
	});

	test("refuses account binding when its management permission is missing", () => {
		searchMock.mockReturnValue({ serviceAccountId: "account_1" });
		accountPermissionMock.mockReturnValue(false);
		renderRoute();
		pasteSetup({ name: "Refused key", scopes: ["files:list"] });
		submitSetup();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("says the key is valid but useless when its permissions allow no scope", async () => {
		// The key resolves, so the route answers 200. Its scopes are all filtered out because the
		// person behind it lost the permissions they need, and the message must say that instead of
		// claiming the key works.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 200,
				json: async () => ({ organizationId: "organization_1", workspaceId: "workspace_1", scopes: [] }),
			}),
		);
		mutationMock.mockResolvedValue({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } });
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		pasteSetup({ name: "Local script", scopes: ["files:list"] });
		submitSetup();

		await screen.findByRole("heading", { name: "Save your API key" });
		fireEvent.click(screen.getByRole("button", { name: "Test key" }));
		await screen.findByText("The key is valid, but your current permissions allow none of its scopes.");
	});

	test("a setup with problems lists them, marks them, and creates nothing", () => {
		const setModelMarkers = vi.spyOn(monaco_editor, "setModelMarkers");
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		pasteSetup('{\n  "name": "Importer",\n  "scopes": ["files:raed"]\n}');

		expect(screen.getByRole("status", { name: "Problems in the setup" }).textContent).toContain(
			'Unknown scope "files:raed".',
		);
		const markers = setModelMarkers.mock.lastCall?.[2] as Array<{ startLineNumber: number; startColumn: number }>;
		expect(markers).toEqual([expect.objectContaining({ startLineNumber: 3, startColumn: 14 })]);

		submitSetup();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows the write warning while any scope that changes stored data is in the setup", () => {
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		pasteSetup({ name: "Reader", scopes: ["files:list", "plugin_data:read"] });
		expect(screen.queryByText(/Treat it like a password/)).toBeNull();

		pasteSetup({ name: "Writer", scopes: ["files:list", "plugin_data:write"] });
		expect(screen.queryByText(/Treat it like a password/)).not.toBeNull();
	});

	test("presets and scope checkboxes write the scopes into the setup and keep the typed name", () => {
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		pasteSetup({ name: "Uploader", scopes: ["files:list"] });
		fireEvent.click(screen.getByRole("button", { name: "Upload CLI" }));
		fireEvent.click(screen.getByRole("checkbox", { name: /^Read file content/ }));

		expect(JSON.parse((getSetupEditor() as HTMLTextAreaElement).value)).toEqual({
			name: "Uploader",
			scopes: ["files:list", "files:write"],
		});
		expect(screen.getByRole("checkbox", { name: /^Write files/ })).toHaveProperty("checked", true);
	});

	test("shows rotate and revoke confirmations with safe values", async () => {
		useQueryMock.mockReturnValue({ _yay: [createCredential()] });
		mutationMock
			.mockResolvedValueOnce({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } })
			.mockResolvedValueOnce({ _yay: null });
		renderRoute();

		fireEvent.click(screen.getByRole("button", { name: "Rotate Local reader" }));
		expect(screen.getByRole("heading", { name: "Rotate “Local reader”?" })).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
		await screen.findByRole("heading", { name: "Save your new API key" });
		fireEvent.click(screen.getByRole("button", { name: "I saved the key" }));

		fireEvent.click(screen.getByRole("button", { name: "Revoke Local reader" }));
		expect(screen.getByRole("heading", { name: "Revoke “Local reader”?" })).not.toBeNull();
		expect(screen.getAllByText("pk_aaaa••••bbbb").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
		await waitFor(() => {
			expect(mutationMock).toHaveBeenLastCalledWith("public_api.api_credential_revoke", {
				membershipId: "membership_1",
				credentialId: "credential_1",
			});
		});
	});

	test("ignores a late create result after the workspace changes", async () => {
		let resolveCreate: ((value: unknown) => void) | undefined;
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}),
		);
		const view = renderRoute();
		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		pasteSetup({ name: "Old workspace", scopes: ["files:list"] });
		submitSetup();

		tenantContextMock.mockReturnValue({
			membershipId: "membership_2",
			organizationId: "organization_1",
			organizationName: "personal",
			workspaceId: "workspace_2",
			workspaceName: "other",
		});
		const PageComponent = Route.options.component as () => JSX.Element;
		view.rerender(<PageComponent />);
		await act(async () => {
			resolveCreate?.({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } });
		});

		expect(screen.queryByText(API_KEY)).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("renders safe curl and Node examples with exact list and read routes", () => {
		renderRoute();

		const curl = screen.getByLabelText("curl API example").textContent ?? "";
		const node = screen.getByLabelText("Node.js API example").textContent ?? "";
		for (const example of [curl, node]) {
			expect(example).toContain("T3_API_KEY");
			expect(example).toContain("/api/v1/files/list");
			expect(example).toContain("/api/v1/files/read");
			expect(example).not.toContain(API_KEY);
		}
		expect(node).toContain("result.isDone");
	});

	test("quick-start samples list Markdown files by extension", () => {
		renderRoute();

		const curl = screen.getByLabelText("curl API example").textContent ?? "";
		const node = screen.getByLabelText("Node.js API example").textContent ?? "";
		expect(curl).toContain('"extension":"md"');
		expect(node).toContain('extension: "md"');
		expect(node).toContain("No Markdown files found");
	});
});
