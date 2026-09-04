/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
	authMock,
	beginManagementActionMock,
	finishManagementActionMock,
	mutationMock,
	publishSessionMock,
	setRouteFocusTargetMock,
	useQueryMock,
} = vi.hoisted(() => ({
	authMock: vi.fn(),
	beginManagementActionMock: vi.fn(),
	finishManagementActionMock: vi.fn(),
	mutationMock: vi.fn(),
	publishSessionMock: vi.fn(),
	setRouteFocusTargetMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({ options }),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => authMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		action: vi.fn(),
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		plugins: {
			claim_repository: "plugins.claim_repository",
			list_user_published_repositories: "plugins.list_user_published_repositories",
			publish_version: "plugins.publish_version",
			remove_repository: "plugins.remove_repository",
		},
		users: { get_anagraphic: "users.get_anagraphic" },
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ workspaceId: "workspace_1" }),
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: ComponentProps<"button">) {
		return <button {...props} />;
	},
}));

vi.mock("@/components/my-input.tsx", () => ({
	MyInput: function MyInput(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyInputArea: function MyInputArea(props: { children?: ReactNode }) {
		return <div>{props.children}</div>;
	},
	MyInputBackground: function MyInputBackground() {
		return null;
	},
	MyInputBox: function MyInputBox() {
		return null;
	},
	MyInputControl: function MyInputControl(props: ComponentProps<"input">) {
		return <input {...props} />;
	},
	MyInputLabel: function MyInputLabel(props: { children?: ReactNode }) {
		return <label>{props.children}</label>;
	},
}));

vi.mock("@/components/plugins-gallery-card.tsx", () => ({
	PluginsGalleryCard: function PluginsGalleryCard(props: { displayName: string }) {
		return (
			<a href="/current-plugin" aria-label={`Open plugin page for ${props.displayName}`}>
				{props.displayName}
			</a>
		);
	},
}));

vi.mock("@/components/plugins-header-breadcrumb.tsx", () => ({
	PluginsHeaderBreadcrumb: function PluginsHeaderBreadcrumb() {
		return <div>Breadcrumb</div>;
	},
}));

vi.mock("@/components/plugins-publish-button.tsx", () => ({
	PluginsPublishButton: function PluginsPublishButton(props: { repositoryLabel: string }) {
		return <button aria-label={`Publish ${props.repositoryLabel}`}>Publish</button>;
	},
}));

vi.mock("@/components/plugins-publish-session.tsx", () => ({
	PluginsPublishSessionProvider: {
		useContext: () => publishSessionMock(),
	},
}));

import { Route } from "./index.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

type RepositoryFixture = {
	repository: {
		_id: string;
		owner: string;
		repo: string;
		repositoryUrl: string;
		lastPublishAttempt: {
			at: number;
			pluginName: string | null;
			status: string;
			message: string;
		};
	};
	readyVersions: Array<{
		name: string;
		displayName: string;
		description: string;
		version: string;
		reviewStatus: string;
	}>;
};

function makeRepositories(): RepositoryFixture[] {
	return [
		{
			repository: {
				_id: "repository_published",
				owner: "octo",
				repo: "plugins",
				repositoryUrl: "https://github.com/octo/plugins",
				lastPublishAttempt: {
					at: Date.UTC(2026, 7, 15, 12, 0),
					pluginName: "previous-plugin",
					status: "failed",
					message: "Artifact file hash mismatch",
				},
			},
			readyVersions: [
				{
					name: "current-plugin",
					displayName: "Current Plugin",
					description: "Current release",
					version: "1.0.0",
					reviewStatus: "passed",
				},
				{
					name: "gallery-plugin",
					displayName: "Gallery Plugin",
					description: "Gallery release",
					version: "0.2.0",
					reviewStatus: "passed",
				},
			],
		},
		{
			repository: {
				_id: "repository_unpublished",
				owner: "octo",
				repo: "new-plugin",
				repositoryUrl: "https://github.com/octo/new-plugin",
				lastPublishAttempt: {
					at: Date.UTC(2026, 7, 15, 12, 0),
					pluginName: null,
					status: "failed",
					message: "Plugin manifest is invalid JSON",
				},
			},
			readyVersions: [],
		},
	];
}

function setRepositories(repositories: ReturnType<typeof makeRepositories> = makeRepositories()) {
	useQueryMock.mockImplementation((query: string) => {
		if (query === "users.get_anagraphic") {
			return null;
		}
		if (query !== "plugins.list_user_published_repositories") {
			return undefined;
		}

		return repositories;
	});
}

describe("RoutePluginsPublisher", () => {
	beforeEach(() => {
		authMock.mockReturnValue({ isAnonymous: false, userId: "user_1" });
		beginManagementActionMock.mockReturnValue(1);
		publishSessionMock.mockReturnValue({
			session: null,
			managementAction: null,
			beginManagementAction: beginManagementActionMock,
			finishManagementAction: finishManagementActionMock,
			setRouteFocusTarget: setRouteFocusTargetMock,
		});
		setRepositories();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("shows a published repository failure outside the current plugin link", () => {
		render(<PageComponent />);

		const pluginLink = screen.getByRole("link", { name: "Open plugin page for Current Plugin" });
		const repositoryItem = pluginLink.closest(".RoutePluginsPublisherRepositoryItem");
		expect(repositoryItem).not.toBeNull();
		expect(pluginLink.parentElement).toBe(repositoryItem);
		const failure = within(repositoryItem as HTMLElement).getByText(/Last publish for previous-plugin/);
		expect(failure.textContent).toContain("Artifact file hash mismatch");
		expect(pluginLink.contains(failure)).toBe(false);
		expect(failure.closest(".PluginsPublisherLastAttempt")?.parentElement).toBe(repositoryItem);
	});

	test("shows a pre-manifest failure outside the unpublished repository card", () => {
		render(<PageComponent />);

		const repositoryName = screen.getByText("octo/new-plugin");
		const unpublishedCard = repositoryName.closest(".RoutePluginsPublisherUnpublishedCard");
		expect(unpublishedCard).not.toBeNull();
		expect(
			within(unpublishedCard as HTMLElement).getByRole("button", { name: "Publish octo/new-plugin" }),
		).toBeTruthy();
		const repositoryItem = unpublishedCard?.closest(".RoutePluginsPublisherRepositoryItem");
		expect(repositoryItem).not.toBeNull();
		expect(unpublishedCard?.parentElement).toBe(repositoryItem);
		const failure = within(repositoryItem as HTMLElement).getByText(/Last publish for this repository/);
		expect(failure.textContent).toContain("Plugin manifest is invalid JSON");
		expect(unpublishedCard?.contains(failure)).toBe(false);
		expect(failure.closest(".PluginsPublisherLastAttempt")?.parentElement).toBe(repositoryItem);
	});

	test("passes distinct owner and repository labels to two unpublished fork actions", () => {
		const unpublished = makeRepositories()[1];
		setRepositories([
			unpublished,
			{
				...unpublished,
				repository: {
					...unpublished.repository,
					_id: "repository_fork",
					owner: "fork",
					repositoryUrl: "https://github.com/fork/new-plugin",
				},
			},
		]);
		render(<PageComponent />);

		expect(screen.getByRole("button", { name: "Publish octo/new-plugin" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Publish fork/new-plugin" })).toBeTruthy();
	});

	test("keeps Remove locked after the card remounts during its publish session", () => {
		publishSessionMock.mockReturnValue({
			session: { repositoryId: "repository_unpublished" },
			managementAction: null,
			beginManagementAction: beginManagementActionMock,
			finishManagementAction: finishManagementActionMock,
			setRouteFocusTarget: setRouteFocusTargetMock,
		});
		const firstView = render(<PageComponent />);
		expect(
			(screen.getByRole("button", { name: "Remove claim on octo/new-plugin" }) as HTMLButtonElement).disabled,
		).toBe(true);

		firstView.unmount();
		render(<PageComponent />);
		expect(
			(screen.getByRole("button", { name: "Remove claim on octo/new-plugin" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	test("shows one card per ready plugin name on the same repository", () => {
		render(<PageComponent />);

		const current = screen.getByRole("link", { name: "Open plugin page for Current Plugin" });
		const gallery = screen.getByRole("link", { name: "Open plugin page for Gallery Plugin" });
		const repositoryItem = current.closest(".RoutePluginsPublisherRepositoryItem");
		expect(repositoryItem).not.toBeNull();
		expect(gallery.closest(".RoutePluginsPublisherRepositoryItem")).toBe(repositoryItem);
	});

	test("holds the provider management lock until an in-flight claim finishes", async () => {
		let finishClaim!: (result: { _yay: { repositoryUrl: string } }) => void;
		mutationMock.mockReturnValueOnce(
			new Promise<{ _yay: { repositoryUrl: string } }>((resolve) => {
				finishClaim = resolve;
			}),
		);
		render(<PageComponent />);
		const repositoryInput = screen.getByPlaceholderText("https://github.com/owner/plugin-repo");
		fireEvent.change(repositoryInput, { target: { value: "https://github.com/octo/third-plugin" } });
		const claimButton = screen.getByRole("button", { name: "Claim" });
		claimButton.focus();
		fireEvent.click(claimButton);
		expect((repositoryInput as HTMLInputElement).disabled).toBe(false);
		expect((repositoryInput as HTMLInputElement).readOnly).toBe(true);
		expect((claimButton as HTMLButtonElement).disabled).toBe(false);
		expect(claimButton.getAttribute("aria-busy")).toBe("true");
		fireEvent.click(claimButton);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(beginManagementActionMock).toHaveBeenCalledWith("claim_repository");

		await act(async () => finishClaim({ _yay: { repositoryUrl: "https://github.com/octo/third-plugin" } }));

		expect(finishManagementActionMock).toHaveBeenCalledWith(1);
		expect(document.activeElement).toBe(repositoryInput);
		expect((repositoryInput as HTMLInputElement).readOnly).toBe(false);
		expect((repositoryInput as HTMLInputElement).value).toBe("");
	});

	test("keeps claim focus stable on failure and after an explicit focus move", async () => {
		let finishClaim!: (result: { _nay?: { message: string }; _yay?: { repositoryUrl: string } }) => void;
		mutationMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishClaim = resolve;
			}),
		);
		const view = render(<PageComponent />);
		const repositoryInput = screen.getByPlaceholderText("https://github.com/owner/plugin-repo");
		fireEvent.change(repositoryInput, { target: { value: "https://github.com/octo/third-plugin" } });
		const claimButton = screen.getByRole("button", { name: "Claim" });
		claimButton.focus();
		fireEvent.click(claimButton);

		await act(async () => finishClaim({ _nay: { message: "Already claimed" } }));
		expect(document.activeElement).toBe(claimButton);
		expect((repositoryInput as HTMLInputElement).readOnly).toBe(false);

		mutationMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finishClaim = resolve;
			}),
		);
		fireEvent.click(claimButton);
		const explicitTarget = screen.getByRole("link", { name: "Open plugin page for Current Plugin" });
		explicitTarget.focus();
		await act(async () => finishClaim({ _yay: { repositoryUrl: "https://github.com/octo/third-plugin" } }));
		view.rerender(<PageComponent />);
		expect(document.activeElement).toBe(explicitTarget);
	});

	test("moves focus to the claim field after a repository claim is removed", async () => {
		const repositories = makeRepositories();
		setRepositories(repositories);
		mutationMock.mockResolvedValueOnce({ _yay: {} });
		const view = render(<PageComponent />);
		const remove = screen.getByRole("button", { name: "Remove claim on octo/new-plugin" });
		remove.focus();
		fireEvent.click(remove);
		expect(
			(screen.getByRole("button", { name: "Removing claim on octo/new-plugin" }) as HTMLButtonElement).disabled,
		).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Removing claim on octo/new-plugin" }));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(beginManagementActionMock).toHaveBeenCalledWith("remove_repository");
		expect(finishManagementActionMock).toHaveBeenCalledWith(1);

		setRepositories([repositories[0]]);
		view.rerender(<PageComponent />);

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByPlaceholderText("https://github.com/owner/plugin-repo")),
		);
	});

	test("moves focus to the claim field after a repository claim is published", async () => {
		const repositories = makeRepositories();
		setRepositories(repositories);
		const view = render(<PageComponent />);
		screen.getByRole("button", { name: "Publish octo/new-plugin" }).focus();

		setRepositories([
			repositories[0],
			{
				...repositories[1],
				readyVersions: repositories[0].readyVersions.slice(0, 1),
			},
		]);
		view.rerender(<PageComponent />);

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByPlaceholderText("https://github.com/owner/plugin-repo")),
		);
	});

	test("registers the claim field as the route focus target and clears it on unmount", () => {
		const view = render(<PageComponent />);
		const repositoryInput = screen.getByPlaceholderText("https://github.com/owner/plugin-repo");
		expect(setRouteFocusTargetMock).toHaveBeenCalledWith(repositoryInput, "workspace_1/plugins/publisher");

		setRouteFocusTargetMock.mockClear();
		view.unmount();
		expect(setRouteFocusTargetMock).toHaveBeenCalledWith(null, "workspace_1/plugins/publisher");
	});

	test("does not steal focus when the person moves before a repository claim disappears", async () => {
		const repositories = makeRepositories();
		setRepositories(repositories);
		mutationMock.mockResolvedValueOnce({ _yay: {} });
		const view = render(<PageComponent />);
		fireEvent.click(screen.getByRole("button", { name: "Remove claim on octo/new-plugin" }));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		fireEvent.change(screen.getByPlaceholderText("https://github.com/owner/plugin-repo"), {
			target: { value: "https://github.com/octo/another-plugin" },
		});
		const claim = screen.getByRole("button", { name: "Claim" });
		claim.focus();

		setRepositories([repositories[0]]);
		view.rerender(<PageComponent />);

		await waitFor(() => expect(document.activeElement).toBe(claim));
	});
});
