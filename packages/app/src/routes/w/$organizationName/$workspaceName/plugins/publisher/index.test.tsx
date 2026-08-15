/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, useQueryMock } = vi.hoisted(() => ({
	authMock: vi.fn(),
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
		mutation: vi.fn(),
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

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
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

import { Route } from "./index.tsx";

const PageComponent = Route.options.component as () => JSX.Element;

function setRepositories() {
	useQueryMock.mockImplementation((query: string) => {
		if (query === "users.get_anagraphic") {
			return null;
		}
		if (query !== "plugins.list_user_published_repositories") {
			return undefined;
		}

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
	});
}

describe("RoutePluginsPublisher", () => {
	beforeEach(() => {
		authMock.mockReturnValue({ isAnonymous: false, userId: "user_1" });
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
		expect(failure.closest(".RoutePluginsPublisherLastAttempt")?.parentElement).toBe(repositoryItem);
	});

	test("shows a pre-manifest failure outside the unpublished repository card", () => {
		render(<PageComponent />);

		const repositoryName = screen.getByText("octo/new-plugin");
		const unpublishedCard = repositoryName.closest(".RoutePluginsPublisherUnpublishedCard");
		expect(unpublishedCard).not.toBeNull();
		const repositoryItem = unpublishedCard?.closest(".RoutePluginsPublisherRepositoryItem");
		expect(repositoryItem).not.toBeNull();
		expect(unpublishedCard?.parentElement).toBe(repositoryItem);
		const failure = within(repositoryItem as HTMLElement).getByText(/Last publish for this repository/);
		expect(failure.textContent).toContain("Plugin manifest is invalid JSON");
		expect(unpublishedCard?.contains(failure)).toBe(false);
		expect(failure.closest(".RoutePluginsPublisherLastAttempt")?.parentElement).toBe(repositoryItem);
	});

	test("shows one card per ready plugin name on the same repository", () => {
		render(<PageComponent />);

		const current = screen.getByRole("link", { name: "Open plugin page for Current Plugin" });
		const gallery = screen.getByRole("link", { name: "Open plugin page for Gallery Plugin" });
		const repositoryItem = current.closest(".RoutePluginsPublisherRepositoryItem");
		expect(repositoryItem).not.toBeNull();
		expect(gallery.closest(".RoutePluginsPublisherRepositoryItem")).toBe(repositoryItem);
	});
});
