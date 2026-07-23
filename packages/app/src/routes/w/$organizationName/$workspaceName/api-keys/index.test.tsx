/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tenantContextMock, useQueryMock, mutationMock, copyButtonMock, apiUrlMock } = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	copyButtonMock: vi.fn(),
	apiUrlMock: vi.fn((path: string) => new URL(`https://api.test${path}`)),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
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
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
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
	credentialId: string;
	name: string;
	keyId: string;
	obfuscatedValue: string;
	scopes: Array<"files:list" | "files:read">;
	createdAt: number;
	revokedAt: number | null;
	lastUsedAt: number | null;
};

function createCredential(overrides?: Partial<TestCredential>): TestCredential {
	return {
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

describe("RouteApiKeys", () => {
	beforeEach(() => {
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

	test("renders loading, error, and empty states", () => {
		useQueryMock.mockReturnValue(undefined);
		const loading = renderRoute();
		expect(screen.getByRole("status").textContent).toContain("Loading API keys");
		loading.unmount();

		useQueryMock.mockReturnValue({ _nay: { message: "Permission denied" } });
		const error = renderRoute();
		expect(screen.getByRole("alert").textContent).toContain("API keys are unavailable");
		expect(screen.getByRole("alert").textContent).toContain("Permission denied");
		error.unmount();

		useQueryMock.mockReturnValue({ _yay: [] });
		renderRoute();
		expect(screen.getByRole("heading", { name: "No active API keys for this workspace" })).not.toBeNull();
		expect(screen.getByText("Create API keys for scripts and tools that access files in home.")).not.toBeNull();
		expect(screen.getAllByRole("button", { name: "Create API key" })).toHaveLength(2);
		expect(screen.queryByLabelText("API key")).toBeNull();
	});

	test("renders masked active and revoked keys as semantic lists", () => {
		useQueryMock.mockReturnValue({
			_yay: [
				createCredential({ credentialId: "active", name: "Active reader" }),
				createCredential({
					credentialId: "revoked",
					name: "Revoked reader",
					keyId: `pk_${"c".repeat(32)}`,
					revokedAt: Date.UTC(2026, 6, 21, 12, 0),
				}),
			],
		});

		renderRoute();

		expect(screen.getByRole("list", { name: "Active API keys" }).querySelectorAll("li")).toHaveLength(1);
		expect(screen.getByText("Active reader")).not.toBeNull();
		expect(screen.getAllByRole("group", { name: "Permissions" })).toHaveLength(2);
		expect(screen.getAllByText(/2026/u).length).toBeGreaterThan(0);
		expect(screen.getAllByText("pk_aaaa••••bbbb")).toHaveLength(2);
		expect(screen.queryByText(API_KEY)).toBeNull();
		expect(screen.getByText("Recent revoked keys (1)")).not.toBeNull();
		expect(screen.queryByRole("heading", { name: "Verify an API key" })).toBeNull();
	});

	test("shows the active-key empty state alongside revoked keys", () => {
		useQueryMock.mockReturnValue({
			_yay: [
				createCredential({
					credentialId: "revoked",
					name: "Revoked reader",
					revokedAt: Date.UTC(2026, 6, 21, 12, 0),
				}),
			],
		});

		renderRoute();

		expect(screen.getByRole("heading", { name: "No active API keys for this workspace" })).not.toBeNull();
		expect(screen.getByText("Recent revoked keys (1)")).not.toBeNull();
		expect(screen.queryByLabelText("API key")).toBeNull();
	});

	test("creates, tests, and clears a fixed read-only key", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
		vi.stubGlobal("fetch", fetchMock);
		mutationMock.mockResolvedValue({ _yay: { credentialId: "credential_2", keyId: KEY_ID, credential: API_KEY } });
		renderRoute();

		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		const nameInput = screen.getByRole("textbox", { name: "Name" });
		expect((nameInput.closest("form") as HTMLFormElement).noValidate).toBe(true);
		expect(document.getElementById(nameInput.getAttribute("aria-describedby") ?? "")).not.toBeNull();
		expect(screen.getByText("Read-only file access")).not.toBeNull();
		expect(screen.getByText("List files")).not.toBeNull();
		expect(screen.getByText("Read file content")).not.toBeNull();

		fireEvent.change(nameInput, { target: { value: "  Local script  " } });
		fireEvent.submit(nameInput.closest("form")!);

		await screen.findByRole("heading", { name: "Save your API key" });
		expect(mutationMock).toHaveBeenCalledWith("public_api.api_credential_create", {
			membershipId: "membership_1",
			name: "Local script",
			scopes: ["files:list", "files:read"],
		});
		expect(screen.getByText(API_KEY)).not.toBeNull();
		expect(copyButtonMock).toHaveBeenCalledWith(expect.objectContaining({ text: API_KEY }));

		fireEvent.click(screen.getByRole("button", { name: "Test key" }));
		await screen.findByText("Key verified. It can list files in this workspace.");
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("https://api.test/api/v1/files/list"),
			{
				method: "POST",
				credentials: "omit",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ path: "/", limit: 1 }),
			},
		);

		fireEvent.click(screen.getByRole("button", { name: "I saved the key" }));
		expect(screen.queryByText(API_KEY)).toBeNull();
	});

	test("validates the trimmed API key name length", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Create stopped for this test" } });
		renderRoute();
		fireEvent.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
		const input = screen.getByRole("textbox", { name: "Name" });

		fireEvent.change(input, { target: { value: "   " } });
		const form = input.closest("form")!;
		const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		submitButton.focus();
		expect(document.activeElement).toBe(submitButton);
		fireEvent.submit(form);
		expect(screen.getByText("API key name is required")).not.toBeNull();
		expect(document.activeElement).toBe(input);
		expect(mutationMock).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: ` ${"a".repeat(80)} ` } });
		fireEvent.submit(input.closest("form")!);
		await waitFor(() => {
			expect(mutationMock).toHaveBeenCalledTimes(1);
		});

		fireEvent.change(input, { target: { value: ` ${"a".repeat(81)} ` } });
		fireEvent.submit(input.closest("form")!);
		expect(screen.getByText("API key name must be 80 characters or fewer")).not.toBeNull();
		expect(mutationMock).toHaveBeenCalledTimes(1);
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
		const input = screen.getByRole("textbox", { name: "Name" });
		fireEvent.change(input, { target: { value: "Old workspace" } });
		fireEvent.submit(input.closest("form")!);

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
});
