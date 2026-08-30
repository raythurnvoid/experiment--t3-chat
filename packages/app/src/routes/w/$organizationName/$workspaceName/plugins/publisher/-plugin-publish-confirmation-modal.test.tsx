/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { actionMock } = vi.hoisted(() => ({ actionMock: vi.fn() }));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { action: (...args: unknown[]) => actionMock(...args) },
	app_convex_api: {
		billing: {
			get_current_user_subscription: "billing.get_current_user_subscription",
			get_usage_snapshot: "billing.get_usage_snapshot",
		},
		plugins: {
			get_publish_candidate_head: "plugins.get_publish_candidate_head",
			publish_version: "plugins.publish_version",
		},
	},
}));

vi.mock("convex/react", () => ({
	useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
	useQuery: () => undefined,
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => ({
			isLoaded: true,
			isAuthenticated: true,
			isAnonymous: true,
			userId: "user_1",
		}),
	},
}));

vi.mock("@/components/app-tanstack-router-dev-tools.tsx", () => ({
	AppTanStackRouterDevTools: () => null,
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

import { PluginPublishConfirmationModal } from "./-plugin-publish-confirmation-modal.tsx";
import { PluginPublishSessionProvider } from "./-plugin-publish-session.tsx";
import { Route as appRootRoute } from "../../../../../__root.tsx";

function render(ui: ReactElement) {
	return testingRender(ui, { wrapper: PluginPublishSessionProvider });
}

function WorkspaceOnlyPublishPage(props: { repositoryName: string }) {
	const { repositoryName } = props;
	const publishSession = PluginPublishSessionProvider.useContext();
	const workspaceRef = useRef<HTMLDivElement>(null);
	const workspaceKey = "org/workspace";

	useEffect(() => {
		publishSession.setWorkspaceFocusTarget(workspaceRef.current, workspaceKey);
		return () => publishSession.setWorkspaceFocusTarget(null, workspaceKey);
	}, [publishSession]);

	return (
		<div ref={workspaceRef} role="region" aria-label="Workspace content" tabIndex={-1}>
			<PluginPublishConfirmationModal
				key={repositoryName}
				repositoryId={`repository_${repositoryName}` as never}
				repositoryLabel={`octo/${repositoryName}`}
			/>
		</div>
	);
}

let routerPermission: boolean | undefined;
const routerPublishedMock = vi.fn();
let finishRouterManagementAction: (() => void) | undefined;

const routerManagementActions = [
	{ label: "Install", kind: "install" },
	{ label: "Uninstall", kind: "uninstall" },
	{ label: "Remove claim", kind: "remove_repository" },
	{ label: "Claim repository", kind: "claim_repository" },
] as const;

function RouterPublishPage() {
	const { pluginName } = publishRoute.useParams();
	const publishSession = PluginPublishSessionProvider.useContext();
	const titleRef = useRef<HTMLHeadingElement>(null);
	const routeKey = `plugin:${pluginName}`;
	const [runningManagementAction, setRunningManagementAction] =
		useState<(typeof routerManagementActions)[number]["kind"]>();

	useEffect(() => {
		publishSession.setRouteFocusTarget(titleRef.current, routeKey);
		return () => publishSession.setRouteFocusTarget(null, routeKey);
	});

	return (
		<main>
			<h1 ref={titleRef} tabIndex={-1}>
				{pluginName}
			</h1>
			<button type="button">Destination action {pluginName}</button>
			{routerManagementActions.map((action) => (
				<button
					key={action.kind}
					type="button"
					disabled={
						Boolean(publishSession.session) ||
						(Boolean(publishSession.managementAction) && runningManagementAction !== action.kind)
					}
					onClick={() => {
						const version = publishSession.beginManagementAction(action.kind);
						if (version === null) {
							return;
						}

						setRunningManagementAction(action.kind);
						finishRouterManagementAction = () => {
							publishSession.finishManagementAction(version);
							setRunningManagementAction(undefined);
						};
					}}
				>
					{runningManagementAction === action.kind ? `${action.label} running` : action.label}
				</button>
			))}
			<PluginPublishConfirmationModal
				repositoryId={`repository_${pluginName}` as never}
				repositoryLabel={`octo/${pluginName}`}
				onPublished={routerPublishedMock}
			/>
		</main>
	);
}

const workspaceRoute = createRoute({
	getParentRoute: () => appRootRoute,
	path: "w/$organizationName/$workspaceName",
	component: function WorkspaceRoute() {
		const { organizationName, workspaceName } = workspaceRoute.useParams();
		const publishSession = PluginPublishSessionProvider.useContext();
		const focusTargetRef = useRef<HTMLElement>(null);
		const workspaceKey = `${organizationName}/${workspaceName}`;
		const setFocusTargetRef = (target: HTMLElement | null) => {
			focusTargetRef.current = target;
			publishSession.setWorkspaceFocusTarget(target, workspaceKey);
		};

		useEffect(() => {
			publishSession.setWorkspaceFocusTarget(focusTargetRef.current, workspaceKey);
			return () => publishSession.setWorkspaceFocusTarget(null, workspaceKey);
		}, [publishSession, workspaceKey]);

		if (routerPermission === undefined) {
			return (
				<main ref={setFocusTargetRef} role="status" tabIndex={-1}>
					Loading {organizationName}/{workspaceName}
				</main>
			);
		}

		if (routerPermission === false) {
			return (
				<main ref={setFocusTargetRef} role="alert" aria-label="Organization access denied" tabIndex={-1}>
					No access to {organizationName}/{workspaceName}
				</main>
			);
		}

		return (
			<div
				ref={setFocusTargetRef}
				data-testid="workspace-content"
				role="region"
				aria-label={`${organizationName}/${workspaceName} workspace content`}
				tabIndex={-1}
			>
				<Outlet />
			</div>
		);
	},
});
const publishRoute = createRoute({
	getParentRoute: () => workspaceRoute,
	path: "plugins/$pluginName",
	component: RouterPublishPage,
});
const filesRoute = createRoute({
	getParentRoute: () => workspaceRoute,
	path: "files",
	component: function FilesPage() {
		return <main>Files</main>;
	},
});
const routeTree = appRootRoute.addChildren([workspaceRoute.addChildren([publishRoute, filesRoute])]);

function renderRouter() {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: ["/w/org-a/workspace-a/plugins/plugin-a"] }),
	});
	return { router, view: testingRender(<RouterProvider router={router} />) };
}

const reviewedSha = "0123456789abcdef0123456789abcdef01234567";
const headSha = "fedcba9876543210fedcba9876543210fedcba98";
const repositoryLabel = "octo/plugin";

describe("PluginPublishConfirmationModal", () => {
	beforeEach(() => {
		routerPermission = true;
		finishRouterManagementAction = undefined;
		actionMock
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("requires an independently entered matching SHA and sends it to publish", async () => {
		const onSessionChange = vi.fn();
		render(
			<PluginPublishConfirmationModal
				repositoryId={"repository_1" as never}
				repositoryLabel={repositoryLabel}
				onSessionChange={onSessionChange}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		expect(onSessionChange).toHaveBeenCalledWith(true);
		const dialog = await screen.findByRole("dialog", { name: `Publish ${repositoryLabel}` });
		expect(actionMock).toHaveBeenNthCalledWith(1, "plugins.get_publish_candidate_head", {
			repositoryId: "repository_1",
		});
		const cancel = screen.getByRole("button", { name: "Cancel" });
		await waitFor(() => expect(document.activeElement).toBe(cancel));
		const input = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(dialog.textContent).toContain(headSha);
		const confirm = screen.getByRole("button", { name: "Publish reviewed commit" });
		expect((input as HTMLInputElement).value).toBe("");
		expect((confirm as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(input, { target: { value: reviewedSha } });
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Paste the reviewed commit SHA shown above");
		expect(input.getAttribute("aria-describedby")).toBe(alert.id);
		expect((input as HTMLInputElement).validity.valid).toBe(false);
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		expect(actionMock).toHaveBeenCalledTimes(1);

		fireEvent.change(input, { target: { value: headSha } });
		expect(screen.queryByRole("alert")).toBeNull();
		expect(input.getAttribute("aria-describedby")).toBeNull();
		expect((input as HTMLInputElement).validity.valid).toBe(true);
		expect((confirm as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(confirm);

		await waitFor(() =>
			expect(actionMock).toHaveBeenNthCalledWith(2, "plugins.publish_version", {
				repositoryId: "repository_1",
				expectedSourceCommitSha: headSha,
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(onSessionChange.mock.calls).toEqual([[true], [false]]);
	});

	test("rechecks HEAD after a publish conflict and requires the new SHA", async () => {
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let finishRecheck!: (result: { _yay: { sourceCommitSha: string } }) => void;
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockResolvedValueOnce({
				_nay: {
					name: "conflict",
					message: "The repository changed after review. Review the new commit before publishing",
				},
			})
			.mockReturnValueOnce(
				new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
					finishRecheck = resolve;
				}),
			)
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		render(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel={repositoryLabel} />);

		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		const input = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		fireEvent.change(input, { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("The repository changed after review. Review the new commit before publishing");
		expect(screen.queryByRole("textbox", { name: "Reviewed commit SHA" })).toBeNull();
		expect(screen.queryByText("Current default-branch HEAD")).toBeNull();
		expect(screen.getByRole("dialog").textContent).not.toContain(headSha);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(actionMock).toHaveBeenNthCalledWith(3, "plugins.get_publish_candidate_head", {
			repositoryId: "repository_1",
		});

		await act(async () => finishRecheck({ _yay: { sourceCommitSha: nextHeadSha } }));

		const nextInput = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(screen.getByRole("dialog").textContent).toContain(nextHeadSha);
		expect((nextInput as HTMLInputElement).value).toBe("");
		expect((screen.getByRole("button", { name: "Publish reviewed commit" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("alert").textContent).toBe(
			"The repository changed after review. Review the new commit before publishing",
		);

		fireEvent.change(nextInput, { target: { value: nextHeadSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));
		await waitFor(() =>
			expect(actionMock).toHaveBeenNthCalledWith(4, "plugins.publish_version", {
				repositoryId: "repository_1",
				expectedSourceCommitSha: nextHeadSha,
			}),
		);
	});

	test("a failed conflict recheck never shows the old SHA as current and can restart", async () => {
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockResolvedValueOnce({
				_nay: {
					name: "conflict",
					message: "The repository changed after review. Review the new commit before publishing",
				},
			})
			.mockResolvedValueOnce({ _nay: { name: "unavailable", message: "GitHub unavailable" } })
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		render(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel={repositoryLabel} />);

		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		const input = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		fireEvent.change(input, { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The repository changed after review");
		expect(alert.textContent).toContain("Failed to read the new repository commit: GitHub unavailable");
		expect(screen.queryByText("Current default-branch HEAD")).toBeNull();
		expect(screen.getByRole("dialog").textContent).not.toContain(headSha);
		expect(screen.queryByRole("button", { name: "Publish reviewed commit" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		const restartedInput = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(screen.getByRole("dialog").textContent).toContain(nextHeadSha);
		expect((restartedInput as HTMLInputElement).value).toBe("");
	});

	test("ignores a late conflict recheck after Cancel and a fresh session", async () => {
		const lateHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const freshHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		let finishLateRecheck!: (result: { _yay: { sourceCommitSha: string } }) => void;
		let finishFreshPreflight!: (result: { _yay: { sourceCommitSha: string } }) => void;
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockResolvedValueOnce({
				_nay: {
					name: "conflict",
					message: "The repository changed after review",
				},
			})
			.mockReturnValueOnce(
				new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
					finishLateRecheck = resolve;
				}),
			)
			.mockReturnValueOnce(
				new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
					finishFreshPreflight = resolve;
				}),
			);
		render(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel={repositoryLabel} />);

		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		const input = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		fireEvent.change(input, { target: { value: headSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));
		await screen.findByText("Checking repository commit...");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.click(screen.getByRole("button", { name: `Publish ${repositoryLabel}` }));
		await screen.findByText("Checking repository commit...");
		await act(async () => finishLateRecheck({ _yay: { sourceCommitSha: lateHeadSha } }));
		expect(screen.getByRole("dialog").textContent).not.toContain(lateHeadSha);
		expect(screen.queryByRole("textbox", { name: "Reviewed commit SHA" })).toBeNull();

		await act(async () => finishFreshPreflight({ _yay: { sourceCommitSha: freshHeadSha } }));
		const freshInput = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(screen.getByRole("dialog").textContent).toContain(freshHeadSha);
		expect(screen.getByRole("dialog").textContent).not.toContain(lateHeadSha);
		expect((freshInput as HTMLInputElement).value).toBe("");
	});

	test("Escape closes the dialog and returns focus to the trigger", async () => {
		render(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel={repositoryLabel} />);
		const trigger = screen.getByRole("button", { name: `Publish ${repositoryLabel}` });
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", { name: `Publish ${repositoryLabel}` });
		await screen.findByRole("textbox", { name: "Reviewed commit SHA" });

		fireEvent.keyDown(dialog, { key: "Escape" });

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(trigger);
		expect(actionMock).toHaveBeenCalledTimes(1);
	});

	test("returns focus to the publisher trigger when only a workspace target is registered", async () => {
		render(<WorkspaceOnlyPublishPage repositoryName="plugin-a" />);
		const trigger = screen.getByRole("button", { name: "Publish octo/plugin-a" });
		fireEvent.click(trigger);
		await screen.findByRole("textbox", { name: "Reviewed commit SHA" });

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(document.activeElement).not.toBe(screen.getByRole("region", { name: "Workspace content" }));
	});

	test("an older close callback does not move focus out of a newer publish dialog", async () => {
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockReturnValueOnce(new Promise(() => undefined));
		const view = render(<WorkspaceOnlyPublishPage repositoryName="plugin-a" />);
		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin-a" }));
		await screen.findByRole("textbox", { name: "Reviewed commit SHA" });

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		view.rerender(<WorkspaceOnlyPublishPage repositoryName="plugin-b" />);
		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin-b" }));
		const newDialog = await screen.findByRole("dialog", { name: "Publish octo/plugin-b" });
		const newCancel = within(newDialog).getByRole("button", { name: "Cancel" });
		await waitFor(() => expect(document.activeElement).toBe(newCancel));

		await act(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);

		expect(screen.getByRole("dialog", { name: "Publish octo/plugin-b" })).toBe(newDialog);
		expect(document.activeElement).toBe(newCancel);
	});

	test("keeps the dialog and focus locked while publishing", async () => {
		let finishPublish!: (result: { _yay: { sourceCommitSha: string } }) => void;
		const pendingPublish = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishPublish = resolve;
		});
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockReturnValueOnce(pendingPublish);
		render(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel={repositoryLabel} />);
		const trigger = screen.getByRole("button", { name: `Publish ${repositoryLabel}` });
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", { name: `Publish ${repositoryLabel}` });
		fireEvent.change(await screen.findByRole("textbox", { name: "Reviewed commit SHA" }), {
			target: { value: headSha },
		});
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		const publishing = await within(dialog).findByRole("button", { name: "Publishing..." });
		expect((publishing as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("textbox", { name: "Reviewed commit SHA" }) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
		expect(document.activeElement).toBe(dialog);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.getByRole("dialog", { name: `Publish ${repositoryLabel}` })).toBe(dialog);
		expect(document.activeElement).toBe(dialog);
		const backdrop = document.querySelector<HTMLElement>("[data-backdrop]");
		expect(backdrop).not.toBeNull();
		fireEvent.pointerDown(backdrop!);
		fireEvent.pointerUp(backdrop!);
		fireEvent.click(backdrop!);
		expect(screen.getByRole("dialog", { name: `Publish ${repositoryLabel}` })).toBe(dialog);
		expect(document.activeElement).toBe(dialog);
		expect(actionMock.mock.calls.filter(([action]) => action === "plugins.publish_version")).toHaveLength(1);

		await act(async () => finishPublish({ _yay: { sourceCommitSha: headSha } }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	test("shows B below A's pending preflight and ignores A's late HEAD result after Cancel", async () => {
		let finishPreflight!: (result: { _yay: { sourceCommitSha: string } }) => void;
		const pendingPreflight = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishPreflight = resolve;
		});
		actionMock.mockReset().mockReturnValueOnce(pendingPreflight);
		const { router } = renderRouter();

		fireEvent.click(await screen.findByRole("button", { name: "Publish octo/plugin-a" }));
		await act(async () =>
			router.navigate({
				to: "/w/$organizationName/$workspaceName/plugins/$pluginName",
				params: { organizationName: "org-b", workspaceName: "workspace-b", pluginName: "plugin-b" },
			}),
		);

		expect(screen.getByRole("heading", { name: "plugin-b" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Publish octo/plugin-a" })).toBeNull();
		expect((screen.getByRole("button", { name: "Publish octo/plugin-b" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole("dialog", { name: "Publish octo/plugin-a" }).textContent).toContain(
			"Checking repository commit...",
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const pluginBHeading = await screen.findByRole("heading", { name: "plugin-b" });
		await waitFor(() => expect(document.activeElement).toBe(pluginBHeading));
		await act(async () => finishPreflight({ _yay: { sourceCommitSha: headSha } }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect((screen.getByRole("button", { name: "Publish octo/plugin-b" }) as HTMLButtonElement).disabled).toBe(false);
		expect(actionMock).toHaveBeenCalledTimes(1);
	});

	test("moves Cancel focus to the new workspace when the publisher route is reused", async () => {
		const { router } = renderRouter();
		const trigger = await screen.findByRole("button", { name: "Publish octo/plugin-a" });
		fireEvent.click(trigger);
		await screen.findByRole("textbox", { name: "Reviewed commit SHA" });

		await act(async () =>
			router.navigate({
				to: "/w/$organizationName/$workspaceName/plugins/$pluginName",
				params: { organizationName: "org-b", workspaceName: "workspace-b", pluginName: "plugin-a" },
			}),
		);
		expect(screen.getByRole("button", { name: "Publish octo/plugin-a" })).toBe(trigger);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const workspaceContent = screen.getByRole("region", { name: "org-b/workspace-b workspace content" });
		await waitFor(() => expect(document.activeElement).toBe(workspaceContent));
	});

	test("moves focus to the workspace content after leaving plugin routes during preflight", async () => {
		let finishPreflight!: (result: { _yay: { sourceCommitSha: string } }) => void;
		const pendingPreflight = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishPreflight = resolve;
		});
		actionMock.mockReset().mockReturnValueOnce(pendingPreflight);
		const { router } = renderRouter();

		fireEvent.click(await screen.findByRole("button", { name: "Publish octo/plugin-a" }));
		await act(async () =>
			router.navigate({
				to: "/w/$organizationName/$workspaceName/files",
				params: { organizationName: "org-a", workspaceName: "workspace-a" },
			}),
		);
		expect(screen.getByText("Files")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Publish octo/plugin-a" })).toBeNull();

		expect(screen.getByRole("dialog", { name: "Publish octo/plugin-a" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		const workspaceContent = screen.getByRole("region", { name: "org-a/workspace-a workspace content" });
		await waitFor(() => expect(document.activeElement).toBe(workspaceContent));
		await act(async () => finishPreflight({ _yay: { sourceCommitSha: headSha } }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test.each(["Install", "Uninstall", "Remove claim", "Claim repository"])(
		"keeps an in-flight %s lock across route and workspace unmounts",
		async (actionLabel) => {
			const { router } = renderRouter();
			fireEvent.click(await screen.findByRole("button", { name: actionLabel }));

			await act(async () =>
				router.navigate({
					to: "/w/$organizationName/$workspaceName/files",
					params: { organizationName: "org-a", workspaceName: "workspace-a" },
				}),
			);
			expect(screen.getByText("Files")).toBeTruthy();
			await act(async () =>
				router.navigate({
					to: "/w/$organizationName/$workspaceName/plugins/$pluginName",
					params: { organizationName: "org-b", workspaceName: "workspace-b", pluginName: "plugin-b" },
				}),
			);

			for (const action of routerManagementActions) {
				expect((screen.getByRole("button", { name: action.label }) as HTMLButtonElement).disabled).toBe(true);
			}
			expect((screen.getByRole("button", { name: "Publish octo/plugin-b" }) as HTMLButtonElement).disabled).toBe(true);

			await act(async () => finishRouterManagementAction?.());

			await waitFor(() =>
				expect((screen.getByRole("button", { name: "Publish octo/plugin-b" }) as HTMLButtonElement).disabled).toBe(
					false,
				),
			);
			for (const action of routerManagementActions) {
				expect((screen.getByRole("button", { name: action.label }) as HTMLButtonElement).disabled).toBe(false);
			}
		},
	);

	test("keeps exact A publish retries above a real B workspace after refusal and an error", async () => {
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let finishFirstPublish!: (result: { _nay: { name: string; message: string } }) => void;
		const firstPublish = new Promise<{ _nay: { name: string; message: string } }>((resolve) => {
			finishFirstPublish = resolve;
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockReturnValueOnce(firstPublish)
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } })
			.mockRejectedValueOnce(new Error("network failed"))
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		const { router } = renderRouter();

		fireEvent.click(await screen.findByRole("button", { name: "Publish octo/plugin-a" }));
		await screen.findByRole("dialog", { name: "Publish octo/plugin-a" });
		fireEvent.change(await screen.findByRole("textbox", { name: "Reviewed commit SHA" }), {
			target: { value: headSha },
		});
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));
		routerPermission = false;
		await act(async () =>
			router.navigate({
				to: "/w/$organizationName/$workspaceName/plugins/$pluginName",
				params: { organizationName: "org-b", workspaceName: "workspace-b", pluginName: "plugin-b" },
			}),
		);
		await act(async () => finishFirstPublish({ _nay: { name: "conflict", message: "Repository A moved" } }));

		const dialog = screen.getByRole("dialog", { name: "Publish octo/plugin-a" });
		expect((await within(dialog).findByRole("alert")).textContent).toBe("Repository A moved");
		const nextReviewedCommit = await within(dialog).findByRole("textbox", { name: "Reviewed commit SHA" });
		expect((nextReviewedCommit as HTMLInputElement).value).toBe("");
		expect(dialog.textContent).toContain(nextHeadSha);
		fireEvent.change(nextReviewedCommit, { target: { value: nextHeadSha } });
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));
		expect((await within(dialog).findByRole("alert")).textContent).toBe("Failed to publish plugin");
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		const denied = await screen.findByRole("alert", { name: "Organization access denied" });
		expect(denied.textContent).toBe("No access to org-b/workspace-b");
		await waitFor(() => expect(document.activeElement).toBe(denied));
		expect(actionMock.mock.calls.slice(1)).toEqual([
			["plugins.publish_version", { repositoryId: "repository_plugin-a", expectedSourceCommitSha: headSha }],
			["plugins.get_publish_candidate_head", { repositoryId: "repository_plugin-a" }],
			["plugins.publish_version", { repositoryId: "repository_plugin-a", expectedSourceCommitSha: nextHeadSha }],
			["plugins.publish_version", { repositoryId: "repository_plugin-a", expectedSourceCommitSha: nextHeadSha }],
		]);
		expect(routerPublishedMock).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledTimes(1);
	});

	test("keeps a pending publish bound to its repository after the route changes", async () => {
		let finishFirstPublish!: (result: { _nay: { name: string; message: string } }) => void;
		let finishRetryPublish!: (result: { _yay: { sourceCommitSha: string } }) => void;
		const firstPublish = new Promise<{ _nay: { name: string; message: string } }>((resolve) => {
			finishFirstPublish = resolve;
		});
		const retryPublish = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishRetryPublish = resolve;
		});
		const onFirstBusyChange = vi.fn();
		const onNextBusyChange = vi.fn();
		const onFirstSessionChange = vi.fn();
		const onNextSessionChange = vi.fn();
		const onFirstPublished = vi.fn();
		const onNextPublished = vi.fn();
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockReturnValueOnce(firstPublish)
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockReturnValueOnce(retryPublish);
		const { rerender } = render(
			<PluginPublishConfirmationModal
				repositoryId={"repository_1" as never}
				repositoryLabel="octo/plugin"
				onBusyChange={onFirstBusyChange}
				onSessionChange={onFirstSessionChange}
				onPublished={onFirstPublished}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin" }));
		const dialog = await screen.findByRole("dialog", { name: "Publish octo/plugin" });
		onFirstBusyChange.mockClear();
		fireEvent.change(await screen.findByRole("textbox", { name: "Reviewed commit SHA" }), {
			target: { value: headSha },
		});
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		rerender(
			<PluginPublishConfirmationModal
				repositoryId={"repository_2" as never}
				repositoryLabel="fork/plugin"
				onBusyChange={onNextBusyChange}
				onSessionChange={onNextSessionChange}
				onPublished={onNextPublished}
			/>,
		);
		expect(screen.getByRole("dialog", { name: "Publish octo/plugin" })).toBe(dialog);
		expect(screen.queryByRole("dialog", { name: "Publish fork/plugin" })).toBeNull();
		expect((screen.getByRole("button", { name: "Publish fork/plugin" }) as HTMLButtonElement).disabled).toBe(true);
		expect(actionMock).toHaveBeenNthCalledWith(2, "plugins.publish_version", {
			repositoryId: "repository_1",
			expectedSourceCommitSha: headSha,
		});

		await act(async () =>
			finishFirstPublish({
				_nay: { name: "conflict", message: "The repository changed after review" },
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("The repository changed after review");
		expect(screen.getByRole("dialog", { name: "Publish octo/plugin" })).toBe(dialog);
		const nextReviewedCommit = await screen.findByRole("textbox", { name: "Reviewed commit SHA" });
		expect((nextReviewedCommit as HTMLInputElement).value).toBe("");
		fireEvent.change(nextReviewedCommit, { target: { value: headSha } });
		const retry = screen.getByRole("button", { name: "Publish reviewed commit" });
		await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(retry);

		await waitFor(() =>
			expect(actionMock).toHaveBeenNthCalledWith(4, "plugins.publish_version", {
				repositoryId: "repository_1",
				expectedSourceCommitSha: headSha,
			}),
		);
		await act(async () => finishRetryPublish({ _yay: { sourceCommitSha: headSha } }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const nextTrigger = screen.getByRole("button", { name: "Publish fork/plugin" });
		expect(nextTrigger.textContent).toContain("Publish");
		expect(nextTrigger.textContent).not.toContain("Publishing...");
		expect(onFirstBusyChange.mock.calls).toEqual([[true], [false], [true], [false]]);
		expect(onNextBusyChange).not.toHaveBeenCalled();
		expect(onFirstSessionChange.mock.calls).toEqual([[true], [false]]);
		expect(onNextSessionChange).not.toHaveBeenCalled();
		expect(onFirstPublished).toHaveBeenCalledTimes(1);
		expect(onNextPublished).not.toHaveBeenCalled();
	});

	test("shows a cancelable check and returns focus to the trigger when the HEAD preflight fails", async () => {
		let finishPreflight!: (result: { _nay: { message: string } }) => void;
		const pendingPreflight = new Promise<{ _nay: { message: string } }>((resolve) => {
			finishPreflight = resolve;
		});
		actionMock.mockReset().mockReturnValueOnce(pendingPreflight);
		const onSessionChange = vi.fn();
		render(
			<PluginPublishConfirmationModal
				repositoryId={"repository_1" as never}
				repositoryLabel={repositoryLabel}
				onSessionChange={onSessionChange}
			/>,
		);
		const trigger = screen.getByRole("button", { name: `Publish ${repositoryLabel}` });
		trigger.focus();

		fireEvent.click(trigger);
		const checking = await screen.findByRole("button", { name: `Publish ${repositoryLabel}` });
		expect(checking.textContent).toContain("Checking commit...");
		expect((checking as HTMLButtonElement).disabled).toBe(false);
		const dialog = screen.getByRole("dialog", { name: `Publish ${repositoryLabel}` });
		expect(dialog.textContent).toContain("Checking repository commit...");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
		fireEvent.click(checking);
		expect(actionMock).toHaveBeenCalledTimes(1);

		await act(async () => finishPreflight({ _nay: { message: "Repository unavailable" } }));

		await waitFor(() => expect(actionMock).toHaveBeenCalledTimes(1));
		expect(document.activeElement).toBe(trigger);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onSessionChange.mock.calls).toEqual([[true], [false]]);
	});

	test("does not steal explicit B focus when A's HEAD preflight fails", async () => {
		let finishPreflight!: (result: { _nay: { message: string } }) => void;
		actionMock.mockReset().mockReturnValueOnce(
			new Promise<{ _nay: { message: string } }>((resolve) => {
				finishPreflight = resolve;
			}),
		);
		const { router } = renderRouter();

		fireEvent.click(await screen.findByRole("button", { name: "Publish octo/plugin-a" }));
		await act(async () =>
			router.navigate({
				to: "/w/$organizationName/$workspaceName/plugins/$pluginName",
				params: { organizationName: "org-b", workspaceName: "workspace-b", pluginName: "plugin-b" },
			}),
		);
		const destinationAction = screen.getByRole("button", { name: "Destination action plugin-b" });
		destinationAction.focus();

		await act(async () => finishPreflight({ _nay: { message: "Repository unavailable" } }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(destinationAction);
	});

	test("keeps a pending HEAD check bound to its repository until the session closes", async () => {
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let finishFirstPreflight!: (result: { _yay: { sourceCommitSha: string } }) => void;
		let finishNextPreflight!: (result: { _yay: { sourceCommitSha: string } }) => void;
		const firstPreflight = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishFirstPreflight = resolve;
		});
		const nextPreflight = new Promise<{ _yay: { sourceCommitSha: string } }>((resolve) => {
			finishNextPreflight = resolve;
		});
		actionMock
			.mockReset()
			.mockReturnValueOnce(firstPreflight)
			.mockReturnValueOnce(nextPreflight)
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		const { rerender } = render(
			<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel="octo/plugin" />,
		);

		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin" }));
		rerender(<PluginPublishConfirmationModal repositoryId={"repository_2" as never} repositoryLabel="fork/plugin" />);
		expect((screen.getByRole("button", { name: "Publish fork/plugin" }) as HTMLButtonElement).disabled).toBe(true);

		await act(async () => finishFirstPreflight({ _yay: { sourceCommitSha: headSha } }));
		const firstDialog = await screen.findByRole("dialog", { name: "Publish octo/plugin" });
		expect(await within(firstDialog).findByRole("textbox", { name: "Reviewed commit SHA" })).toBeTruthy();
		expect(firstDialog.textContent).toContain(headSha);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Publish fork/plugin" }));

		await act(async () => finishNextPreflight({ _yay: { sourceCommitSha: nextHeadSha } }));
		const dialog = await screen.findByRole("dialog", { name: "Publish fork/plugin" });
		await within(dialog).findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(dialog.textContent).toContain(nextHeadSha);
		expect(dialog.textContent).not.toContain(headSha);
		fireEvent.change(screen.getByRole("textbox", { name: "Reviewed commit SHA" }), {
			target: { value: nextHeadSha },
		});
		fireEvent.click(screen.getByRole("button", { name: "Publish reviewed commit" }));

		await waitFor(() =>
			expect(actionMock).toHaveBeenNthCalledWith(3, "plugins.publish_version", {
				repositoryId: "repository_2",
				expectedSourceCommitSha: nextHeadSha,
			}),
		);
	});

	test("keeps an opened preflight until Cancel and does not reopen it later", async () => {
		const nextHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		actionMock
			.mockReset()
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: headSha } })
			.mockResolvedValueOnce({ _yay: { sourceCommitSha: nextHeadSha } });
		const { rerender } = render(
			<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel="octo/plugin" />,
		);

		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin" }));
		const firstDialog = await screen.findByRole("dialog", { name: "Publish octo/plugin" });
		await within(firstDialog).findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(firstDialog.textContent).toContain(headSha);

		rerender(<PluginPublishConfirmationModal repositoryId={"repository_2" as never} repositoryLabel="fork/plugin" />);
		expect(screen.getByRole("dialog", { name: "Publish octo/plugin" }).textContent).toContain(headSha);
		expect((screen.getByRole("button", { name: "Publish fork/plugin" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		rerender(<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel="octo/plugin" />);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(screen.queryByText(headSha)).toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Publish octo/plugin" }));
		const freshDialog = await screen.findByRole("dialog", { name: "Publish octo/plugin" });
		await within(freshDialog).findByRole("textbox", { name: "Reviewed commit SHA" });
		expect(freshDialog.textContent).toContain(nextHeadSha);
		expect(actionMock).toHaveBeenCalledTimes(2);
	});

	test("names two repository triggers and dialogs with their exact owners", async () => {
		actionMock.mockReset().mockResolvedValue({ _yay: { sourceCommitSha: headSha } });
		render(
			<>
				<PluginPublishConfirmationModal repositoryId={"repository_1" as never} repositoryLabel="octo/plugin" />
				<PluginPublishConfirmationModal repositoryId={"repository_2" as never} repositoryLabel="fork/plugin" />
			</>,
		);

		const octoTrigger = screen.getByRole("button", { name: "Publish octo/plugin" });
		const forkTrigger = screen.getByRole("button", { name: "Publish fork/plugin" });
		fireEvent.click(octoTrigger);
		expect(await screen.findByRole("dialog", { name: "Publish octo/plugin" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		fireEvent.click(forkTrigger);
		expect(await screen.findByRole("dialog", { name: "Publish fork/plugin" })).toBeTruthy();
		expect(actionMock).toHaveBeenNthCalledWith(1, "plugins.get_publish_candidate_head", {
			repositoryId: "repository_1",
		});
		expect(actionMock).toHaveBeenNthCalledWith(2, "plugins.get_publish_candidate_head", {
			repositoryId: "repository_2",
		});
	});
});
