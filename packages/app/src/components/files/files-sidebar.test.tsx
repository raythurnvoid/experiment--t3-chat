import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
	type AnyRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";

import { FilesSidebar } from "./files-sidebar.tsx";
import { FilesClipboardProvider } from "./files-clipboard.tsx";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, type files_VisibleTreeNode } from "@/lib/files.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { global_custom_event_dispatch } from "@/lib/global-event.tsx";

const { treeState, tenantState, createNode } = vi.hoisted(() => ({
	treeState: { nodes: [] as files_VisibleTreeNode[], listeners: new Set<() => void>() },
	// The mocked tenant hook subscribes here. Like a real membership change, a notify re-renders
	// every component that called it. A parent rerender alone does not, because the React Compiler
	// keeps its output when props are unchanged.
	tenantState: { membershipId: "membership", listeners: new Set<() => void>() },
	createNode: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	const { getFunctionName } = await import("convex/server");
	const queryResults = {};
	return {
		...original,
		useConvex: () => ({ query: async () => [], mutation: createNode, action: createNode }),
		useQuery: (query: FunctionReference<"query">, args: unknown) => {
			if (args === "skip") return undefined;
			if (getFunctionName(query) === "files_transfer:get") return null;
			return getFunctionName(query) === "access_control:get_current_user_workspace_permission" ? true : [];
		},
		useQueries: () => queryResults,
		usePaginatedQuery: () => ({ results: [], status: "Exhausted", isLoading: false, loadMore: () => {} }),
	};
});

vi.mock("@/lib/app-tenant-context.tsx", async () => {
	const { useSyncExternalStore } = await import("react");

	return {
		AppTenantProvider: {
			useContext: function useContext() {
				const membershipId = useSyncExternalStore(
					(listener) => {
						tenantState.listeners.add(listener);
						return () => {
							tenantState.listeners.delete(listener);
						};
					},
					() => tenantState.membershipId,
				);

				return {
					membershipId,
					organizationId: "organization",
					organizationName: "organization",
					workspaceId: "workspace",
					workspaceName: "workspace",
				};
			},
		},
	};
});

vi.mock("@/lib/files-tree-context.tsx", async () => {
	const { useEffect, useMemo, useState } = await import("react");

	// State and an effect, like the real Convex query hook. An update sent outside `act` then
	// renders on React's normal schedule, together with other pending state updates.
	function useTreeNodes() {
		const [nodes, setNodes] = useState(() => treeState.nodes);
		useEffect(() => {
			const listener = () => setNodes(treeState.nodes);
			treeState.listeners.add(listener);
			listener();
			return () => {
				treeState.listeners.delete(listener);
			};
		}, []);
		return nodes;
	}

	return {
		FilesTreeProvider: {
			useFullList: function useFullList(enabled: boolean) {
				const nodes = useTreeNodes();
				return enabled ? nodes : undefined;
			},
			// Serve every fixture row as loaded. A row whose parent is not in the fixture was shared on its
			// own, like a row of `list_tree_shared_roots`, so the store would show it at the top.
			useFolders: function useFolders() {
				const nodes = useTreeNodes();
				return useMemo(() => {
					const nodeIds = new Set(nodes?.map((node) => node._id));
					return {
						rows: nodes,
						statusByFolderId: new Map(),
						hoistedIds: new Set(
							nodes?.filter((node) => node.parentId !== "root" && !nodeIds.has(node.parentId)).map((node) => node._id),
						),
						loadMore: () => {},
					};
				}, [nodes]);
			},
		},
	};
});

vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));

beforeEach(() => {
	createNode.mockReset();
	tenantState.membershipId = "membership";
	treeState.nodes = ["alpha", "bravo", "charlie", "delta"].map((name) => ({
		...files_SYNTHETIC_ROOT_FOLDER,
		_id: name as app_convex_Id<"files_nodes">,
		organizationId: "organization" as app_convex_Id<"organizations">,
		workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
		parentId: files_ROOT_ID,
		path: `/${name}`,
		treePath: `/${name}/`,
		pathDepth: 1,
		name,
		createdBy: "user" as app_convex_Id<"users">,
		updatedBy: "user" as app_convex_Id<"users">,
		updatedAt: 1,
		canWrite: true,
	}));
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(450);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(450);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	treeState.listeners.clear();
	tenantState.listeners.clear();
});

describe("FilesSidebar", () => {
	function CreateSidebar(props: { router: AnyRouter; selectedNodeId: string }) {
		const handleAction = () => {};
		const { membershipId } = AppTenantProvider.useContext();
		return (
			<RouterContextProvider router={props.router}>
				<AppActivitiesProvider
					key={membershipId}
					membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
				>
					<FilesClipboardProvider
						key={membershipId}
						membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
					>
						<FilesSidebar
							selectedNodeId={props.selectedNodeId}
							view="rich_text_editor"
							initialSearchQuery=""
							onClose={handleAction}
							onArchive={handleAction}
							onPrimaryAction={handleAction}
							onSearchQueryChange={handleAction}
						/>
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			</RouterContextProvider>
		);
	}

	test("opens a private path outside the saved tree through the path route", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "alpha" });
		const input = view.getByRole("combobox");
		fireEvent.change(input, { target: { value: "/private/Brand New.md" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "/w/$organizationName/$workspaceName/files/$",
				params: { organizationName: "organization", workspaceName: "workspace", _splat: "/private/Brand New.md" },
			}),
		);
	});

	test("copies the tree selection and keeps its source IDs after navigation", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const alpha = await view.findByRole("treeitem", { name: "alpha" });
		await waitFor(() => expect(alpha.getAttribute("aria-selected")).toBe("true"));
		const bravo = view.getByRole("treeitem", { name: "bravo" });
		fireEvent.click(bravo.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		expect(await view.findByRole("menuitem", { name: "Copy path" })).toBeTruthy();
		expect(view.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
		expect(view.getByRole("menuitem", { name: "Copy node id" })).toBeTruthy();
		fireEvent.click(view.getByRole("menuitem", { name: /^Copy$/ }));
		// Control+V does nothing while a tree menu is open.
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		view.rerender(<CreateSidebar router={router} selectedNodeId="delta" />);
		const delta = await view.findByRole("treeitem", { name: "delta" });
		await waitFor(() => expect(delta.hasAttribute("data-focused")).toBe(true));
		fireEvent.keyDown(delta, { key: "v", code: "KeyV", ctrlKey: true });
		fireEvent.keyUp(delta, { key: "v", code: "KeyV", ctrlKey: true });
		expect(createNode.mock.calls[0]![1]).toMatchObject({
			kind: "copy",
			sourceIds: ["alpha", "bravo"],
			targetParentId: "delta",
		});
		await waitFor(() => expect(view.queryByRole("dialog")).not.toBeNull());
	});

	test.each([
		["Cut", "row menu"],
		["Copy", "row menu"],
		["Cut", "selection menu"],
		["Copy", "selection menu"],
		["Cut", "keyboard"],
		["Copy", "keyboard"],
	] as const)("keeps only the selected parent for %s from the %s", async (mode, entrypoint) => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo"
				? {
						...node,
						parentId: "alpha" as app_convex_Id<"files_nodes">,
						path: "/alpha/bravo",
						treePath: "/alpha/bravo/",
						pathDepth: 2,
					}
				: node,
		);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(bravo.getAttribute("aria-selected")).toBe("true"));
		const alpha = view.getByRole("treeitem", { name: "alpha" });
		fireEvent.click(alpha.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		expect(alpha.getAttribute("aria-selected")).toBe("true");
		expect(bravo.getAttribute("aria-selected")).toBe("true");
		if (entrypoint === "keyboard") {
			const key = mode === "Cut" ? "x" : "c";
			const code = mode === "Cut" ? "KeyX" : "KeyC";
			fireEvent.keyDown(alpha, { key, code, ctrlKey: true });
			fireEvent.keyUp(alpha, { key, code, ctrlKey: true });
		} else {
			fireEvent.click(
				view.getByRole("button", { name: entrypoint === "row menu" ? "More actions for alpha" : "More options" }),
			);
			fireEvent.click(await view.findByRole("menuitem", { name: new RegExp(`^${mode}$`) }));
			// Control+V does nothing while a tree menu is open.
			await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		}
		view.rerender(<CreateSidebar router={router} selectedNodeId="delta" />);
		const delta = await view.findByRole("treeitem", { name: "delta" });
		await waitFor(() => expect(delta.hasAttribute("data-focused")).toBe(true));
		fireEvent.keyDown(delta, { key: "v", code: "KeyV", ctrlKey: true });
		fireEvent.keyUp(delta, { key: "v", code: "KeyV", ctrlKey: true });
		expect(createNode.mock.calls[0]![1]).toMatchObject({
			kind: mode === "Cut" ? "move" : "copy",
			sourceIds: ["alpha"],
			targetParentId: "delta",
		});
		await waitFor(() => expect(view.queryByRole("dialog")).not.toBeNull());
	});

	test("a menu on an unselected row copies only that row", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "bravo" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Copy$/ }));
		view.rerender(<CreateSidebar router={router} selectedNodeId={files_ROOT_ID} />);
		fireEvent.click(view.getByRole("button", { name: "More options" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Paste into root folder" }));
		expect(createNode.mock.calls[0]![1]).toMatchObject({ sourceIds: ["bravo"], targetParentId: files_ROOT_ID });
		await waitFor(() => expect(view.queryByRole("dialog")).not.toBeNull());
	});

	test.each([
		["Cut", "keyboard"],
		["Copy", "keyboard"],
		["Cut", "selection menu"],
		["Copy", "selection menu"],
	] as const)("keeps collapsed selected children for %s from the %s", async (mode, entrypoint) => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo" || node._id === "charlie"
				? {
						...node,
						parentId: "alpha" as app_convex_Id<"files_nodes">,
						path: `/alpha/${node.name}`,
						treePath: `/alpha/${node.name}/`,
						pathDepth: 2,
					}
				: node,
		);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(bravo.getAttribute("aria-selected")).toBe("true"));
		for (const name of ["charlie", "delta"]) {
			fireEvent.click(view.getByRole("treeitem", { name }).querySelector(".FilesSidebarTreeItemPrimaryAction")!, {
				ctrlKey: true,
			});
		}
		fireEvent.click(view.getByRole("button", { name: "Collapse folder alpha" }));
		await waitFor(() => expect(view.queryByRole("treeitem", { name: "bravo" })).toBeNull());
		if (entrypoint === "keyboard") {
			const key = mode === "Cut" ? "x" : "c";
			const code = mode === "Cut" ? "KeyX" : "KeyC";
			const delta = view.getByRole("treeitem", { name: "delta" });
			fireEvent.keyDown(delta, { key, code, ctrlKey: true });
			fireEvent.keyUp(delta, { key, code, ctrlKey: true });
		} else {
			fireEvent.click(view.getByRole("button", { name: "More options" }));
			fireEvent.click(await view.findByRole("menuitem", { name: new RegExp(`^${mode}$`) }));
		}
		view.rerender(<CreateSidebar router={router} selectedNodeId={files_ROOT_ID} />);
		fireEvent.click(view.getByRole("button", { name: "More options" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Paste into root folder" }));
		expect(createNode.mock.calls[0]![1]).toMatchObject({ sourceIds: ["bravo", "charlie", "delta"] });
		await waitFor(() => expect(view.queryByRole("dialog")).not.toBeNull());
	});

	test("does not paste into a focused archived folder", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		fireEvent.click(await view.findByRole("button", { name: "More options" }));
		const showArchived = await view.findByRole("menuitemcheckbox", { name: "Show archived items" });
		fireEvent.click(showArchived);
		fireEvent.keyDown(showArchived, { key: "Escape" });
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		fireEvent.click(await view.findByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(view.queryByRole("menuitem", { name: /^Copy$/ })).toBeNull());
		act(() => {
			treeState.nodes = treeState.nodes.map((node) =>
				node._id === "alpha" ? { ...node, archiveOperationId: "qa-archive" } : node,
			);
			for (const listener of treeState.listeners) listener();
		});
		view.rerender(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const alpha = await view.findByRole("treeitem", { name: "alpha archived" });
		await waitFor(() => expect(alpha.hasAttribute("data-focused")).toBe(true));
		fireEvent.keyDown(alpha, { key: "v", code: "KeyV", ctrlKey: true });
		fireEvent.keyUp(alpha, { key: "v", code: "KeyV", ctrlKey: true });
		expect(createNode).not.toHaveBeenCalled();
	});

	test("marks a cut row and clears it with Escape", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const row = await view.findByRole("treeitem", { name: "alpha" });
		await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
		// The search box has focus after mount, and hotkeys skip keys typed while an input has focus.
		// A user presses Control+X on a focused row, so move focus there first.
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "x", code: "KeyX", ctrlKey: true });
		fireEvent.keyUp(row, { key: "x", code: "KeyX", ctrlKey: true });
		expect(row.getAttribute("aria-label")).toBe("alpha, ready to move");
		expect(row.classList.contains("FilesSidebarTreeItem-content-cut")).toBe(true);
		fireEvent.keyDown(row, { key: "Escape", code: "Escape" });
		fireEvent.keyUp(row, { key: "Escape", code: "Escape" });
		expect(row.getAttribute("aria-label")).toBe("alpha");
		expect(createNode).not.toHaveBeenCalled();
	});

	test.each([
		["folder", "tree first"],
		["folder", "route first"],
		["file", "tree first"],
		["file", "route first"],
	] as const)("selects and renames a created %s with %s", async (kind, order) => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const navigation = Promise.withResolvers<void>();
		const navigate = vi.spyOn(router, "navigate").mockReturnValue(navigation.promise);
		const name = kind === "folder" ? "new-folder" : "new-file.md";
		createNode.mockResolvedValue({ _yay: { nodeId: "created-node" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await waitFor(() =>
			expect(view.getByRole("treeitem", { name: "alpha" }).getAttribute("aria-selected")).toBe("true"),
		);
		fireEvent.click(view.getByRole("button", { name: kind === "folder" ? "New folder" : "New file" }));
		await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
		expect(view.getByRole("treeitem", { name: "alpha" }).getAttribute("aria-selected")).toBe("true");
		expect(view.queryByRole("textbox")).toBeNull();
		if (order === "route first") {
			await act(async () => navigation.resolve());
			view.rerender(<CreateSidebar router={router} selectedNodeId="created-node" />);
			expect(view.queryByRole("textbox")).toBeNull();
			expect(view.getByRole("button", { name: "New folder" }).matches(":disabled")).toBe(true);
		}

		act(() => {
			treeState.nodes = [
				...treeState.nodes,
				{
					...treeState.nodes[0],
					_id: "created-node" as app_convex_Id<"files_nodes">,
					kind,
					name,
					path: `/${name}`,
					treePath: `/${name}/`,
				},
			];
			for (const listener of treeState.listeners) listener();
		});
		if (order === "tree first") {
			expect(view.getByRole("treeitem", { name: "alpha" }).getAttribute("aria-selected")).toBe("true");
			view.rerender(<CreateSidebar router={router} selectedNodeId="created-node" />);
		}
		await waitFor(() => expect(document.activeElement).toBe(view.getByRole("textbox", { name: `Rename ${name}` })));
		expect(view.getByRole("treeitem", { name }).getAttribute("aria-selected")).toBe("true");
		expect(view.getByRole("treeitem", { name: "alpha" }).getAttribute("aria-selected")).toBe("false");
		expect(view.getByRole("button", { name: "New folder" }).matches(":disabled")).toBe(false);
		await act(async () => navigation.resolve());
	});

	test.each(["before response", "waiting for row", "workspace change", "unmount"])(
		"cancels create navigation on leaving %s",
		async (stage) => {
			const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
			const navigation = Promise.withResolvers<void>();
			const navigate = vi.spyOn(router, "navigate").mockReturnValue(navigation.promise);
			const creation = Promise.withResolvers<{ _yay: { nodeId: string } }>();
			createNode.mockReturnValue(creation.promise);
			const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
			fireEvent.click(view.getByRole("button", { name: "New folder" }));
			await waitFor(() => expect(createNode).toHaveBeenCalledOnce());
			if (stage === "waiting for row") {
				await act(async () => creation.resolve({ _yay: { nodeId: "new-folder" } }));
				view.rerender(<CreateSidebar router={router} selectedNodeId="new-folder" />);
				await act(async () => navigation.resolve());
				expect(view.getByRole("button", { name: "New folder" }).matches(":disabled")).toBe(true);
			}

			if (stage === "unmount") {
				view.unmount();
			} else if (stage === "workspace change") {
				act(() => {
					tenantState.membershipId = "other-membership";
					for (const listener of tenantState.listeners) listener();
				});
			} else {
				view.rerender(
					<CreateSidebar router={router} selectedNodeId={stage === "waiting for row" ? "alpha" : "bravo"} />,
				);
			}
			await act(async () => creation.resolve({ _yay: { nodeId: "new-folder" } }));
			expect(navigate).toHaveBeenCalledTimes(stage === "waiting for row" ? 1 : 0);
			if (stage === "unmount") return;
			expect(view.getByRole("button", { name: "New folder" }).matches(":disabled")).toBe(false);
			act(() => {
				treeState.nodes = [
					...treeState.nodes,
					{
						...treeState.nodes[0],
						_id: "new-folder" as app_convex_Id<"files_nodes">,
						name: "new-folder",
						path: "/new-folder",
						treePath: "/new-folder/",
					},
				];
				for (const listener of treeState.listeners) listener();
			});
			view.rerender(<CreateSidebar router={router} selectedNodeId="new-folder" />);
			expect(view.queryByRole("textbox")).toBeNull();
		},
	);

	test.each(["refused", "create failed", "navigation failed"])("clears create busy state when %s", async (failure) => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		vi.spyOn(console, "error").mockImplementation(() => {});
		if (failure === "refused") {
			createNode.mockResolvedValue({ _nay: { message: "Permission denied" } });
		} else if (failure === "create failed") {
			createNode.mockRejectedValue(new Error("Create failed"));
		} else {
			createNode.mockResolvedValue({ _yay: { nodeId: "new-folder" } });
			vi.spyOn(router, "navigate").mockRejectedValue(new Error("Navigation failed"));
		}
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		fireEvent.click(view.getByRole("button", { name: "New folder" }));
		await waitFor(() => expect(console.error).toHaveBeenCalledOnce());
		await waitFor(() => expect(view.getByRole("button", { name: "New folder" }).matches(":disabled")).toBe(false));
		expect(view.queryByRole("textbox")).toBeNull();
	});

	test.each([
		[files_ROOT_ID, "focus"],
		[files_ROOT_ID, "ctrlKey"],
		[files_ROOT_ID, "shiftKey"],
		["alpha", "focus"],
		["alpha", "ctrlKey"],
		["alpha", "shiftKey"],
	] as const)(
		"keeps keyboard focus through live updates on route %s with %s",
		async (selectedNodeId, selectionMethod) => {
			const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
			const handleAction = vi.fn();
			function TestSidebar(props: { selectedNodeId: string }) {
				const [searchQuery, setSearchQuery] = useState("");
				const { membershipId } = AppTenantProvider.useContext();
				return (
					<RouterContextProvider router={router}>
						<AppActivitiesProvider
							key={membershipId}
							membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
						>
							<FilesClipboardProvider
								key={membershipId}
								membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
							>
								<FilesSidebar
									selectedNodeId={props.selectedNodeId}
									view="rich_text_editor"
									initialSearchQuery={searchQuery}
									onClose={handleAction}
									onArchive={handleAction}
									onPrimaryAction={handleAction}
									onSearchQueryChange={setSearchQuery}
								/>
							</FilesClipboardProvider>
						</AppActivitiesProvider>
					</RouterContextProvider>
				);
			}

			const view = render(<TestSidebar selectedNodeId={selectedNodeId} />);
			await waitFor(() =>
				expect(view.getByRole("treeitem", { name: "alpha" }).hasAttribute("data-focused")).toBe(true),
			);
			const bravo = view.getByRole("treeitem", { name: "bravo" });
			act(() => bravo.focus());
			if (selectionMethod !== "focus") {
				fireEvent.click(bravo.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { [selectionMethod]: true });
				expect(bravo.getAttribute("aria-selected")).toBe("true");
			}
			expect(bravo.hasAttribute("data-focused")).toBe(true);
			act(() => {
				treeState.nodes = treeState.nodes.map((node) => ({ ...node, updatedAt: 2 }));
				for (const listener of treeState.listeners) listener();
			});
			expect(bravo.hasAttribute("data-focused")).toBe(true);
			expect(document.activeElement).toBe(bravo);
			expect(
				view
					.getAllByRole("treeitem")
					.filter((item) => item.getAttribute("aria-selected") === "true")
					.map((item) => item.getAttribute("data-file-id")),
			).toEqual(selectedNodeId === files_ROOT_ID ? [] : [selectedNodeId]);
			fireEvent.keyDown(bravo, { key: "ArrowDown", code: "ArrowDown" });
			fireEvent.keyUp(bravo, { key: "ArrowDown", code: "ArrowDown" });
			await waitFor(() => expect(document.activeElement?.getAttribute("data-file-id")).toBe("charlie"));
			act(() => view.getByRole("button", { name: "More options" }).focus());
			expect(view.getByRole("treeitem", { name: "charlie" }).hasAttribute("data-focused")).toBe(true);
			if (selectionMethod !== "focus") {
				act(() => bravo.focus());
				fireEvent.click(bravo.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { [selectionMethod]: true });
				act(() => view.getByRole("button", { name: "Close" }).focus());
				expect(
					view
						.getByRole("treeitem", { name: selectedNodeId === files_ROOT_ID ? "bravo" : selectedNodeId })
						.hasAttribute("data-focused"),
				).toBe(true);
				expect(bravo.getAttribute("aria-selected")).toBe("false");
			}

			view.rerender(<TestSidebar selectedNodeId="echo" />);
			act(() => bravo.focus());
			act(() => {
				treeState.nodes = treeState.nodes.map((node) => ({ ...node, updatedAt: 3 }));
				for (const listener of treeState.listeners) listener();
			});
			expect(bravo.hasAttribute("data-focused")).toBe(true);
			act(() => {
				treeState.nodes = [
					...treeState.nodes,
					{
						...treeState.nodes[0],
						_id: "echo" as app_convex_Id<"files_nodes">,
						name: "echo",
						path: "/echo",
						treePath: "/echo/",
					},
				];
				for (const listener of treeState.listeners) listener();
			});
			await waitFor(
				() => expect(view.getByRole("treeitem", { name: "echo" }).hasAttribute("data-focused")).toBe(true),
				{ timeout: 5_000 },
			);
			const searchInput = view.getByRole("combobox");
			act(() => searchInput.focus());
			fireEvent.change(searchInput, { target: { value: "bravo" } });
			await waitFor(
				() => {
					expect(view.queryAllByRole("treeitem")).toHaveLength(1);
					expect(view.getByRole("treeitem", { name: "bravo" }).hasAttribute("data-focused")).toBe(true);
				},
				{ timeout: 5_000 },
			);
			fireEvent.click(view.getByRole("button", { name: "Clear search" }));
			await waitFor(
				() => {
					expect(view.queryAllByRole("treeitem")).toHaveLength(5);
					expect(view.getByRole("treeitem", { name: "bravo" }).hasAttribute("data-focused")).toBe(true);
				},
				{ timeout: 5_000 },
			);

			view.rerender(<TestSidebar selectedNodeId="delta" />);
			await waitFor(
				() => expect(view.getByRole("treeitem", { name: "delta" }).hasAttribute("data-focused")).toBe(true),
				{ timeout: 5_000 },
			);
			act(() => {
				treeState.nodes = treeState.nodes.filter((node) => node._id !== "delta");
				for (const listener of treeState.listeners) listener();
			});
			await waitFor(
				() => {
					expect(view.queryByRole("treeitem", { name: "delta" })).toBeNull();
					expect(view.getByRole("treeitem", { name: "alpha" }).hasAttribute("data-focused")).toBe(true);
				},
				{ timeout: 5_000 },
			);
			fireEvent.change(searchInput, { target: { value: "charlie" } });
			await waitFor(
				() => {
					expect(view.queryAllByRole("treeitem")).toHaveLength(1);
					expect(view.getByRole("treeitem", { name: "charlie" }).hasAttribute("data-focused")).toBe(true);
				},
				{ timeout: 5_000 },
			);
		},
	);

	test("a reveal event expands the folder above the row and focuses the row", async () => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo"
				? {
						...node,
						kind: "file",
						parentId: "alpha" as app_convex_Id<"files_nodes">,
						path: "/alpha/bravo",
						treePath: "/alpha/bravo/",
						pathDepth: 2,
					}
				: node,
		);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		// Select a sibling, so the route does not expand `alpha` by itself.
		const view = render(<CreateSidebar router={router} selectedNodeId="charlie" />);
		const alpha = await view.findByRole("treeitem", { name: "alpha" });
		expect(alpha.getAttribute("aria-expanded")).toBe("false");
		expect(view.queryByRole("treeitem", { name: "bravo" })).toBeNull();

		act(() =>
			global_custom_event_dispatch("files::reveal_node", {
				membershipId: "other_membership" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: "bravo" as app_convex_Id<"files_nodes">,
			}),
		);
		expect(alpha.getAttribute("aria-expanded")).toBe("false");

		act(() =>
			global_custom_event_dispatch("files::reveal_node", {
				membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: "bravo" as app_convex_Id<"files_nodes">,
			}),
		);
		await waitFor(() => expect(alpha.getAttribute("aria-expanded")).toBe("true"));
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		// Headless Tree focuses the row from a timer once the row element exists.
		await waitFor(() => expect(document.activeElement).toBe(bravo), { timeout: 5_000 });
		expect(bravo.tabIndex).toBe(0);
		expect(bravo.hasAttribute("data-focused")).toBe(true);
	});

	test("a confirmed row-menu archive moves focus to the next row", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		// Like Convex, the tree update arrives together with the mutation result, and React renders it
		// after the mutation promise has resolved. The first `await` leaves the click's `act` scope, so
		// the update is not rendered at once.
		const archive = vi.spyOn(app_convex, "mutation").mockImplementation(async () => {
			await Promise.resolve();
			treeState.nodes = treeState.nodes.filter((node) => node._id !== "bravo");
			for (const listener of treeState.listeners) listener();
			return { _yay: null };
		});
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "bravo" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Archive" }));
		const dialog = await view.findByRole("dialog", { name: "Archive “bravo”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
		await waitFor(() =>
			expect(archive).toHaveBeenCalledWith(app_convex_api.files_nodes.archive_nodes, {
				membershipId: "membership",
				nodeIds: ["bravo"],
			}),
		);
		await waitFor(() => expect(view.queryByRole("treeitem", { name: "bravo" })).toBeNull());

		// Bravo's menu button left with its row, so the dialog has nothing to give focus back to. The
		// sidebar picked the row after bravo while bravo was still there.
		const charlie = view.getByRole("treeitem", { name: "charlie" });
		await waitFor(() => expect(document.activeElement).toBe(charlie), { timeout: 5_000 });
		expect(charlie.hasAttribute("data-focused")).toBe(true);
	});

	test("a cancelled multi-select archive keeps the selection", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const alpha = await view.findByRole("treeitem", { name: "alpha" });
		await waitFor(() => expect(alpha.getAttribute("aria-selected")).toBe("true"));
		const bravo = view.getByRole("treeitem", { name: "bravo" });
		fireEvent.click(bravo.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		expect(bravo.getAttribute("aria-selected")).toBe("true");

		// The header menu is not a tree menu, so nothing else keeps the selection while the dialog is open.
		fireEvent.click(view.getByRole("button", { name: "More options" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Archive 2 selected/ }));
		const dialog = await view.findByRole("dialog", { name: "Archive 2 items?" });
		// The closed menu unmounts a moment later. While it is still there, the sidebar treats every
		// outside interaction as the menu closing, which would hide what this test checks.
		await waitFor(() => expect(document.querySelector(".MyMenuPopover[data-files-sidebar-tree-context]")).toBeNull());
		// Focus and clicks inside the dialog are outside the tree, but they must not reset the selection.
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });
		act(() => cancel.focus());
		fireEvent.pointerDown(cancel);
		expect(alpha.getAttribute("aria-selected")).toBe("true");
		expect(bravo.getAttribute("aria-selected")).toBe("true");

		fireEvent.click(cancel);
		await waitFor(() => expect(view.queryByRole("dialog", { name: "Archive 2 items?" })).toBeNull());
		expect(alpha.getAttribute("aria-selected")).toBe("true");
		expect(bravo.getAttribute("aria-selected")).toBe("true");
	});

	test("a reveal event during a search keeps the folder expanded once the search closes", async () => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo"
				? {
						...node,
						kind: "file",
						parentId: "alpha" as app_convex_Id<"files_nodes">,
						path: "/alpha/bravo",
						treePath: "/alpha/bravo/",
						pathDepth: 2,
					}
				: node,
		);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="charlie" />);
		const alpha = await view.findByRole("treeitem", { name: "alpha" });
		expect(alpha.getAttribute("aria-expanded")).toBe("false");

		const searchInput = view.getByRole("combobox");
		act(() => searchInput.focus());
		fireEvent.change(searchInput, { target: { value: "charlie" } });
		await waitFor(() => expect(view.queryAllByRole("treeitem")).toHaveLength(1), { timeout: 5_000 });

		act(() =>
			global_custom_event_dispatch("files::reveal_node", {
				membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: "bravo" as app_convex_Id<"files_nodes">,
			}),
		);
		// The file view clears the search through the route. Here the clear button does the same.
		fireEvent.click(view.getByRole("button", { name: "Clear search" }));
		await waitFor(
			() => expect(view.getByRole("treeitem", { name: "alpha" }).getAttribute("aria-expanded")).toBe("true"),
			{ timeout: 5_000 },
		);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(document.activeElement).toBe(bravo), { timeout: 5_000 });
	});
});
