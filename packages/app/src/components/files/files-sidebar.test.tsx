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
import { getFunctionName, type FunctionReference } from "convex/server";

import { FilesSidebar } from "./files-sidebar.tsx";
import { FilesClipboardProvider } from "./files-clipboard.tsx";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, type files_VisibleTreeNode } from "@/lib/files.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_tree_stream_args } from "@/lib/files-tree-context.tsx";
import { global_custom_event_dispatch } from "@/lib/global-event.tsx";

const { treeState, tenantState, linkState, createNode, queryCalls } = vi.hoisted(() => ({
	// `sharedRoots` holds the rows of the "Shared with you" group, `sharedRootsStatus` its pager status.
	// `sharedListeners` re-render the group after a change.
	treeState: {
		nodes: [] as files_VisibleTreeNode[],
		sharedRoots: [] as files_VisibleTreeNode[],
		sharedRootsStatus: "done" as "loading" | "more" | "done",
		loadMoreShared: vi.fn(),
		listeners: new Set<() => void>(),
		sharedListeners: new Set<() => void>(),
	},
	// The mocked tenant hook subscribes here. Like a real membership change, a notify re-renders
	// every component that called it. A parent rerender alone does not, because the React Compiler
	// keeps its output when props are unchanged.
	tenantState: { membershipId: "membership", listeners: new Set<() => void>() },
	// The workspace list of public links. `undefined` is loading, `null` is refused. `results` is what
	// the search chips read through `useQueries`; it is a new object only when the list changes.
	linkState: {
		links: [] as unknown,
		results: { links: [] } as Record<string, unknown>,
		listeners: new Set<() => void>(),
	},
	createNode: vi.fn(),
	// Every query a component read, by function name and args, so a test can see which node a dialog reads.
	queryCalls: [] as Array<[string, unknown]>,
}));

function set_links(links: unknown) {
	linkState.links = links;
	linkState.results = { links };
	for (const listener of linkState.listeners) listener();
}

function link(nodeId: string) {
	return { nodeId, createdBy: "user", createdAt: 1 };
}

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	const { getFunctionName } = await import("convex/server");
	const { useSyncExternalStore } = await import("react");
	const queryResults = {};
	const subscribeLinks = (listener: () => void) => {
		linkState.listeners.add(listener);
		return () => {
			linkState.listeners.delete(listener);
		};
	};
	return {
		...original,
		useConvex: () => ({ query: async () => [], mutation: createNode, action: createNode }),
		useQuery: (query: FunctionReference<"query">, args: unknown) => {
			const links = useSyncExternalStore(subscribeLinks, () => linkState.links);
			if (args === "skip") return undefined;
			queryCalls.push([getFunctionName(query), args]);
			// The share and properties dialogs stay loading.
			if (
				getFunctionName(query) === "files_sharing:get_node_share_state" ||
				getFunctionName(query) === "files_nodes:get_file_node_for_membership"
			)
				return undefined;
			if (getFunctionName(query) === "files_transfer:get") return null;
			if (getFunctionName(query) === "files_share_links:list_workspace_links") return links;
			return getFunctionName(query) === "access_control:get_current_user_workspace_permission" ? true : [];
		},
		useQueries: (queries: Record<string, unknown>) => {
			const linkResults = useSyncExternalStore(subscribeLinks, () => linkState.results);
			return "links" in queries ? linkResults : queryResults;
		},
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

vi.mock("@/lib/files-tree-context.tsx", async (importOriginal) => {
	const { useEffect, useMemo, useState } = await import("react");
	const { files_tree_stream_args } = await importOriginal<typeof import("@/lib/files-tree-context.tsx")>();

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

	function useSharedRoots() {
		const [sharedRoots, setSharedRoots] = useState(() => ({
			rows: treeState.sharedRoots,
			status: treeState.sharedRootsStatus,
		}));
		useEffect(() => {
			const listener = () => setSharedRoots({ rows: treeState.sharedRoots, status: treeState.sharedRootsStatus });
			treeState.sharedListeners.add(listener);
			return () => {
				treeState.sharedListeners.delete(listener);
			};
		}, []);
		return sharedRoots;
	}

	return {
		files_tree_stream_args,
		FilesTreeProvider: {
			useFullList: function useFullList(enabled: boolean) {
				const nodes = useTreeNodes();
				return enabled ? nodes : undefined;
			},
			// Serve every fixture row as loaded. A row whose parent is not in the fixture is pinned under a
			// hidden folder, so the store would show it at the top.
			useFolders: function useFolders() {
				const nodes = useTreeNodes();
				const sharedRoots = useSharedRoots();
				return useMemo(() => {
					const nodeIds = new Set(nodes?.map((node) => node._id));
					return {
						rows: nodes,
						statusByFolderId: new Map(),
						hoistedIds: new Set(
							nodes?.filter((node) => node.parentId !== "root" && !nodeIds.has(node.parentId)).map((node) => node._id),
						),
						loadMore: () => {},
						sharedRoots: { ...sharedRoots, loadMore: treeState.loadMoreShared },
					};
				}, [nodes, sharedRoots]);
			},
		},
	};
});

vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));

beforeEach(() => {
	createNode.mockReset();
	queryCalls.length = 0;
	tenantState.membershipId = "membership";
	set_links([]);
	treeState.sharedRoots = [];
	treeState.sharedRootsStatus = "done";
	treeState.loadMoreShared.mockReset();
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
	treeState.sharedListeners.clear();
	tenantState.listeners.clear();
	linkState.listeners.clear();
});

describe("FilesSidebar", () => {
	function CreateSidebar(props: {
		router: AnyRouter;
		selectedNodeId: string;
		onPrimaryAction?: (nodeId: string, kind: string) => void;
	}) {
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
							onPrimaryAction={props.onPrimaryAction ?? handleAction}
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

	test("shows a member's shares in their own group, apart from the tree rows, and opens one", async () => {
		const [alpha, bravo] = treeState.nodes;
		treeState.sharedRoots = [
			// `bravo` also shows in the tree, so the group row needs its own id.
			bravo!,
			{
				...alpha!,
				_id: "secret" as app_convex_Id<"files_nodes">,
				name: "secret",
				parentId: "hidden" as app_convex_Id<"files_nodes">,
				archiveOperationId: "archive-1",
			},
		];
		const onPrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" onPrimaryAction={onPrimaryAction} />);
		await view.findByRole("treeitem", { name: "bravo" });

		const group = view.getByRole("region", { name: "Shared with you" });
		const rows = within(group).getAllByRole("button");
		expect(rows.map((row) => row.getAttribute("data-shared-row-id"))).toEqual(["shared:bravo", "shared:secret"]);
		expect(rows[0]!.getAttribute("aria-current")).toBe("page");
		// Named like a tree row, so the "Archived" text does not run into the name.
		expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
			"bravo restricted",
			"secret restricted archived",
		]);
		expect(view.getAllByRole("treeitem", { name: "bravo" })).toHaveLength(1);
		fireEvent.click(rows[1]!);
		expect(onPrimaryAction).toHaveBeenCalledWith("secret", "folder");

		// Search lists every match itself, so the group hides.
		fireEvent.change(view.getByRole("combobox"), { target: { value: "alp" } });
		await waitFor(() => expect(view.queryByRole("region", { name: "Shared with you" })).toBeNull());
	});

	function share(name: string) {
		return {
			...treeState.nodes[0]!,
			_id: name as app_convex_Id<"files_nodes">,
			name,
			path: `/hidden/${name}`,
			parentId: "hidden" as app_convex_Id<"files_nodes">,
		};
	}

	function set_shared_roots(rows: files_VisibleTreeNode[], status: typeof treeState.sharedRootsStatus) {
		act(() => {
			treeState.sharedRoots = rows;
			treeState.sharedRootsStatus = status;
			for (const listener of treeState.sharedListeners) listener();
		});
	}

	test("Show more in the Shared with you group keeps focus while more remain, then moves it to the first new row", async () => {
		treeState.sharedRoots = [share("s1")];
		treeState.sharedRootsStatus = "more";
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const showMore = within(group).getByRole("button", { name: "Show more" });

		showMore.focus();
		fireEvent.click(showMore);
		expect(treeState.loadMoreShared).toHaveBeenCalledTimes(1);
		set_shared_roots([share("s1"), share("s2")], "more");
		expect(document.activeElement).toBe(showMore);

		fireEvent.click(showMore);
		set_shared_roots([share("s1"), share("s2"), share("s3")], "done");
		await waitFor(() => expect(document.activeElement?.getAttribute("data-shared-row-id")).toBe("shared:s3"));
		expect(within(group).queryByRole("button", { name: "Show more" })).toBeNull();
	});

	test("Show more leaves focus alone when the user moved it out of the group", async () => {
		treeState.sharedRoots = [share("s1")];
		treeState.sharedRootsStatus = "more";
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const showMore = within(group).getByRole("button", { name: "Show more" });

		showMore.focus();
		fireEvent.click(showMore);
		const search = view.getByRole("combobox");
		act(() => search.focus());
		set_shared_roots([share("s1"), share("s2")], "done");
		await waitFor(() => expect(within(group).getAllByRole("button")).toHaveLength(2));
		expect(document.activeElement).toBe(search);
	});

	test("Show more focuses the first new active row when archived shares show below", async () => {
		const archivedShare = { ...share("a1"), archiveOperationId: "archive-1" };
		treeState.sharedRoots = [share("s1"), archivedShare];
		treeState.sharedRootsStatus = "more";
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const showMore = within(group).getByRole("button", { name: "Show more" });

		showMore.focus();
		fireEvent.click(showMore);
		// The provider lists the active shares first, so the new active row comes before the archived one.
		set_shared_roots([share("s1"), share("s2"), archivedShare], "done");
		await waitFor(() => expect(document.activeElement?.getAttribute("data-shared-row-id")).toBe("shared:s2"));
	});

	test("shows the Shared with you group with only Show more while its loaded pages hold no row", async () => {
		treeState.sharedRootsStatus = "more";
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });

		expect(
			within(group)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Show more"]);
	});

	test("a grant-only member with shares sees no No files yet. under the group", async () => {
		treeState.nodes = [];
		treeState.sharedRoots = [share("s1")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="s1" />);
		await view.findByRole("region", { name: "Shared with you" });
		expect(view.queryByText("No files yet.")).toBeNull();

		set_shared_roots([], "done");
		expect(await view.findByText("No files yet.")).toBeTruthy();
	});

	test("the rename optimistic update reaches the restricted twin, the share streams and the Shared with you group", async () => {
		createNode.mockReturnValue(new Promise(() => {}));
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "bravo" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Rename" }));
		const input = await view.findByRole("textbox", { name: "Rename bravo" });
		fireEvent.change(input, { target: { value: "renamed" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		await waitFor(() =>
			expect(createNode).toHaveBeenCalledWith(
				app_convex_api.files_nodes.rename_node,
				expect.anything(),
				expect.anything(),
			),
		);

		// One cached page per stream that can hold the row, under the exact args the tree reads.
		const bravo = treeState.nodes[1]!;
		const page = { page: [bravo], isDone: true, continueCursor: "" };
		const paginationOpts = { numItems: 200, cursor: null };
		const streamArgs = files_tree_stream_args({
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			folderId: "root",
			kind: "folder",
			archived: false,
		});
		const cached = [
			[app_convex_api.files_nodes.list_tree_children, { ...streamArgs.children(true), paginationOpts }],
			...([0, 1, 2] as const).flatMap((principalIndex) => [
				[
					app_convex_api.files_nodes.list_tree_children_shared,
					{ ...streamArgs.shared(principalIndex), paginationOpts },
				],
				[
					app_convex_api.files_nodes.list_tree_shared_roots,
					{ membershipId: "membership", archived: false, principalIndex, paginationOpts },
				],
			]),
		] as Array<[FunctionReference<"query">, Record<string, unknown>]>;
		const written: Array<[string, string]> = [];
		const localStore = {
			getAllQueries: (query: FunctionReference<"query">) =>
				cached
					.filter(([cachedQuery]) => getFunctionName(cachedQuery) === getFunctionName(query))
					.map(([, args]) => ({ args, value: page })),
			setQuery: (query: FunctionReference<"query">, args: Record<string, unknown>, value: typeof page) =>
				written.push([
					`${getFunctionName(query)}:${String(args.principalIndex ?? args.restricted)}`,
					value.page[0]!.name,
				]),
			getQuery: () => undefined,
		};
		const options = createNode.mock.calls[0]![2] as { optimisticUpdate: (store: typeof localStore) => void };
		options.optimisticUpdate(localStore);

		expect(written.sort()).toEqual(
			[
				"files_nodes:list_tree_children:true",
				...[0, 1, 2].flatMap((index) => [
					`files_nodes:list_tree_children_shared:${index}`,
					`files_nodes:list_tree_shared_roots:${index}`,
				]),
			]
				.map((key): [string, string] => [key, "renamed"])
				.sort(),
		);
	});

	test("a Shared with you row has the tree row menu, which archives that row only", async () => {
		treeState.sharedRoots = [share("secret")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });

		fireEvent.contextMenu(within(group).getByRole("button", { name: "secret restricted" }));
		for (const name of ["Copy path", "Copy link", "Copy node id", "Share", "Properties"]) {
			expect((await view.findByRole("menuitem", { name })).matches("[aria-disabled='true']")).toBe(false);
		}
		expect(view.getByRole("menuitem", { name: "Rename" }).getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(view.getByRole("menuitem", { name: "Archive" }));
		expect(await view.findByRole("dialog", { name: "Archive “secret”?" })).toBeTruthy();
	});

	test("a Shared with you row opens its menu from the keyboard, and Paste, Share and Properties act on the shared folder", async () => {
		treeState.sharedRoots = [share("secret")];
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const row = within(group).getByRole("button", { name: "secret restricted" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());

		// Paste goes into the shared folder.
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "F10", shiftKey: true });
		fireEvent.click(await view.findByRole("menuitem", { name: "Paste" }));
		expect(createNode.mock.calls[0]![1]).toMatchObject({
			kind: "copy",
			sourceIds: ["bravo"],
			targetParentId: "secret",
		});
		await act(async () => {
			await createNode.mock.results[0]!.value;
		});

		// Share and Properties read the node id, not the group row's DOM id.
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "ContextMenu" });
		fireEvent.click(await view.findByRole("menuitem", { name: "Share" }));
		const shareDialog = await view.findByRole("dialog");
		expect(queryCalls).toContainEqual([
			"files_sharing:get_node_share_state",
			{ membershipId: "membership", nodeId: "secret" },
		]);
		fireEvent.click(within(shareDialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

		fireEvent.keyDown(row, { key: "ContextMenu" });
		fireEvent.click(await view.findByRole("menuitem", { name: "Properties" }));
		await view.findByRole("dialog");
		expect(queryCalls).toContainEqual([
			"files_nodes:get_file_node_for_membership",
			{ membershipId: "membership", fileNodeId: "secret" },
		]);
	});

	test.each([
		["Share", "Close"],
		["Archive", "Cancel"],
	])("closing %s with %s from a Shared with you row focuses that row, not its tree row", async (action, close) => {
		// `bravo` also shows in the tree.
		treeState.sharedRoots = [treeState.nodes[1]!];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const row = within(group).getByRole("button", { name: "bravo restricted" });

		act(() => row.focus());
		fireEvent.keyDown(row, { key: "ContextMenu" });
		fireEvent.click(await view.findByRole("menuitem", { name: action }));
		fireEvent.click(within(await view.findByRole("dialog")).getByRole("button", { name: close }));
		await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
		// The tree would focus its row from a timer, so wait past it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(row);
	});

	test("a confirmed archive of a Shared with you row moves focus to the next group row", async () => {
		treeState.sharedRoots = [share("s1"), share("s2"), share("s3")];
		vi.spyOn(app_convex, "mutation").mockImplementation(async () => {
			await Promise.resolve();
			treeState.sharedRoots = [share("s1"), share("s3")];
			for (const listener of treeState.sharedListeners) listener();
			return { _yay: null };
		});
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });

		fireEvent.contextMenu(within(group).getByRole("button", { name: "s2 restricted" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Archive" }));
		const dialog = await view.findByRole("dialog", { name: "Archive “s2”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(within(group).queryByRole("button", { name: "s2 restricted" })).toBeNull());
		// s2 has no tree row, so the tree's first row must not take focus.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(within(group).getByRole("button", { name: "s3 restricted" }));
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
			fireEvent.click(view.getByRole("button", { name: "More actions for alpha" }));
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
		// A one-source paste opens no dialog. The paste would open it right after the start call.
		await act(async () => {
			await createNode.mock.results[0]!.value;
		});
		expect(view.queryByRole("dialog")).toBeNull();
	});

	test("a menu on an unselected row copies only that row", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		createNode.mockResolvedValue({ _yay: { runId: "run" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "bravo" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		view.rerender(<CreateSidebar router={router} selectedNodeId={files_ROOT_ID} />);
		// A click on empty tree space focuses the tree itself. Paste then goes into the root.
		const tree = view.getByRole("tree", { name: "Files" });
		tree.focus();
		fireEvent.keyDown(tree, { key: "v", code: "KeyV", ctrlKey: true });
		fireEvent.keyUp(tree, { key: "v", code: "KeyV", ctrlKey: true });
		expect(createNode.mock.calls[0]![1]).toMatchObject({ sourceIds: ["bravo"], targetParentId: files_ROOT_ID });
		// A one-source paste opens no dialog. The paste would open it right after the start call.
		await act(async () => {
			await createNode.mock.results[0]!.value;
		});
		expect(view.queryByRole("dialog")).toBeNull();
	});

	test("the More options menu has no Cut, Copy, or Paste", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		fireEvent.click(await view.findByRole("button", { name: "More options" }));
		await view.findByRole("menuitem", { name: "Upload file" });
		expect(view.queryByRole("menuitem", { name: /^(Cut|Copy|Paste)/ })).toBeNull();
	});

	test.each(["Cut", "Copy"] as const)("keeps collapsed selected children for %s from the keyboard", async (mode) => {
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
		const key = mode === "Cut" ? "x" : "c";
		const code = mode === "Cut" ? "KeyX" : "KeyC";
		const delta = view.getByRole("treeitem", { name: "delta" });
		fireEvent.keyDown(delta, { key, code, ctrlKey: true });
		fireEvent.keyUp(delta, { key, code, ctrlKey: true });
		view.rerender(<CreateSidebar router={router} selectedNodeId={files_ROOT_ID} />);
		const tree = view.getByRole("tree", { name: "Files" });
		tree.focus();
		fireEvent.keyDown(tree, { key: "v", code: "KeyV", ctrlKey: true });
		fireEvent.keyUp(tree, { key: "v", code: "KeyV", ctrlKey: true });
		expect(createNode.mock.calls[0]![1]).toMatchObject({
			sourceIds: ["bravo", "charlie", "delta"],
			targetParentId: files_ROOT_ID,
		});
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

	test("a multi-select archive that holds a read-only item asks for every selected item and then clears the selection", async () => {
		treeState.nodes = [
			...treeState.nodes,
			{
				...treeState.nodes[0],
				_id: "locked" as app_convex_Id<"files_nodes">,
				kind: "file",
				name: "locked.md",
				parentId: "alpha" as app_convex_Id<"files_nodes">,
				path: "/alpha/locked.md",
				treePath: "/alpha/locked.md/",
				pathDepth: 2,
				canWrite: false,
				writeBlockedReason: "read_only",
				writePolicyState: "read_only",
			},
		];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(bravo.getAttribute("aria-selected")).toBe("true"));
		const alpha = view.getByRole("treeitem", { name: "alpha" });
		fireEvent.click(alpha.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		expect(alpha.getAttribute("aria-selected")).toBe("true");

		// Alpha holds a read-only file. The server refuses it and archives bravo, so the dialog names both.
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Archive" }));
		const dialog = await view.findByRole("dialog", { name: "Archive 2 items?" });
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("alpha\nbravo");

		// The request had 2 items, so the selection clears even though only bravo was archived.
		vi.spyOn(app_convex, "mutation").mockResolvedValue({
			_yay: { runId: "run", activityId: "activity", isDone: true, notArchivedNodeIds: ["alpha"] },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(view.queryByRole("dialog", { name: "Archive 2 items?" })).toBeNull());
		expect(alpha.getAttribute("aria-selected")).not.toBe("true");
	});

	test("the header archive of a selection with a read-only row still asks to archive every selected item", async () => {
		treeState.nodes = [
			...treeState.nodes,
			{
				...treeState.nodes[0],
				_id: "locked" as app_convex_Id<"files_nodes">,
				kind: "file",
				name: "locked.md",
				path: "/locked.md",
				treePath: "/locked.md/",
				canWrite: false,
				writeBlockedReason: "read_only",
				writePolicyState: "read_only",
			},
		];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(bravo.getAttribute("aria-selected")).toBe("true"));
		const locked = view.getByRole("treeitem", { name: /^locked\.md/ });
		fireEvent.click(locked.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		expect(locked.getAttribute("aria-selected")).toBe("true");

		// The server refuses locked.md and archives bravo, so the header action stays enabled.
		fireEvent.click(view.getByRole("button", { name: "More options" }));
		fireEvent.click(await view.findByRole("menuitem", { name: /^Archive 2 selected/ }));
		const dialog = await view.findByRole("dialog", { name: "Archive 2 items?" });
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("bravo\nlocked.md");
	});

	test("the menu of a read-only row in a selection still archives the selection", async () => {
		treeState.nodes = [
			...treeState.nodes,
			{
				...treeState.nodes[0],
				_id: "locked" as app_convex_Id<"files_nodes">,
				kind: "file",
				name: "locked.md",
				path: "/locked.md",
				treePath: "/locked.md/",
				canWrite: false,
				writeBlockedReason: "read_only",
				writePolicyState: "read_only",
			},
		];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		await waitFor(() => expect(bravo.getAttribute("aria-selected")).toBe("true"));
		const locked = view.getByRole("treeitem", { name: /^locked\.md/ });
		fireEvent.click(locked.querySelector(".FilesSidebarTreeItemPrimaryAction")!, { ctrlKey: true });
		expect(locked.getAttribute("aria-selected")).toBe("true");

		// Bravo can be archived, so the read-only row's menu archives the selection like the header action.
		fireEvent.click(view.getByRole("button", { name: /^More actions for locked\.md/ }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Archive" }));
		const dialog = await view.findByRole("dialog", { name: "Archive 2 items?" });
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("bravo\nlocked.md");
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

	test("marks public files in the tree and names the link in the label and tooltip", async () => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo"
				? { ...node, kind: "file" }
				: node._id === "charlie"
					? { ...node, kind: "file", restrictedScopeNodeId: node._id }
					: node._id === "delta"
						? { ...node, kind: "file", canWrite: false }
						: node,
		);
		set_links([link("bravo"), link("charlie"), link("delta")]);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);

		const bravo = await view.findByRole("treeitem", { name: "bravo, public link" });
		const charlie = view.getByRole("treeitem", { name: "charlie restricted, public link" });
		view.getByRole("treeitem", { name: "delta, read-only, public link" });
		const alpha = view.getByRole("treeitem", { name: "alpha" });
		expect(bravo.getAttribute("data-file-public-link")).toBe("on");
		expect(alpha.hasAttribute("data-file-public-link")).toBe(false);
		expect(bravo.querySelector(".FilesSidebarTreeItemIcon-public-link")).not.toBeNull();
		expect(alpha.querySelector(".FilesSidebarTreeItemIcon-public-link")).toBeNull();
		// A restricted file shows both marks.
		expect(charlie.querySelector("[data-file-restricted='self'] .FilesSidebarTreeItemIcon-public-link")).not.toBeNull();

		// The link comes first in the row tooltip. The restricted row keeps its Files access note.
		const bravoAction = bravo.querySelector(".FilesSidebarTreeItemPrimaryAction")!;
		fireEvent.pointerEnter(bravoAction);
		fireEvent.pointerMove(bravoAction);
		expect((await within(document.body).findByRole("tooltip", {}, { timeout: 4_000 })).textContent).toMatch(
			/^Anyone with the link can view\. Updated .+ by /,
		);
		fireEvent.pointerLeave(bravoAction);
		await waitFor(() => expect(within(document.body).queryByRole("tooltip")).toBeNull(), { timeout: 4_000 });
		const charlieAction = charlie.querySelector(".FilesSidebarTreeItemPrimaryAction")!;
		fireEvent.pointerEnter(charlieAction);
		fireEvent.pointerMove(charlieAction);
		expect((await within(document.body).findByRole("tooltip", {}, { timeout: 4_000 })).textContent).toBe(
			"Anyone with the link can view. In Files, only chosen people and roles have access.",
		);

		// Turning a link off removes its mark.
		act(() => set_links([link("charlie")]));
		await view.findByRole("treeitem", { name: "bravo" });
		expect(view.getByRole("treeitem", { name: "bravo" }).hasAttribute("data-file-public-link")).toBe(false);
	});

	test("file.link:public finds a public file in a closed folder, and Enter waits for the link list", async () => {
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
				: node._id === "charlie"
					? { ...node, kind: "file" }
					: node,
		);
		set_links(undefined);
		const handlePrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" onPrimaryAction={handlePrimaryAction} />);
		expect((await view.findByRole("treeitem", { name: "alpha" })).getAttribute("aria-expanded")).toBe("false");

		// Enter right away cannot open anything while the link list is loading. The first Enter turns the
		// typed filter into a chip, and the second one has to wait.
		const searchInput = view.getByRole("combobox");
		act(() => searchInput.focus());
		fireEvent.change(searchInput, { target: { value: "file.link:public" } });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).not.toHaveBeenCalled();
		expect(view.getByText(/Still searching/)).toBeTruthy();

		act(() => set_links([link("bravo")]));
		await waitFor(() => expect(view.queryByRole("treeitem", { name: "bravo, public link" })).not.toBeNull(), {
			timeout: 5_000,
		});
		expect(view.queryByRole("treeitem", { name: "charlie" })).toBeNull();
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).toHaveBeenCalledWith("bravo", "file");
	});

	test("!file.link:public shows nothing while the link list failed, then every file without a link", async () => {
		treeState.nodes = treeState.nodes.map((node) =>
			node._id === "bravo" || node._id === "charlie" ? { ...node, kind: "file" } : node,
		);
		set_links(null);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" />);
		await view.findByRole("treeitem", { name: "charlie" });

		const searchInput = view.getByRole("combobox");
		act(() => searchInput.focus());
		fireEvent.change(searchInput, { target: { value: "!file.link:public" } });
		// A failed answer is unknown, so the negated chip must not turn it into a match.
		await waitFor(() => expect(view.queryAllByRole("treeitem")).toHaveLength(0), { timeout: 5_000 });

		act(() => set_links([]));
		await waitFor(() => expect(view.queryByRole("treeitem", { name: "charlie" })).not.toBeNull(), { timeout: 5_000 });
		act(() => set_links([link("charlie")]));
		await waitFor(() => expect(view.queryByRole("treeitem", { name: "charlie, public link" })).toBeNull(), {
			timeout: 5_000,
		});
		expect(view.queryByRole("treeitem", { name: "bravo" })).not.toBeNull();
	});
});
