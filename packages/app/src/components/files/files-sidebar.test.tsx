// The create, focus, reveal, archive and search tests are in files-sidebar.rows.test.tsx, so the two files can
// run at the same time.
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
	type AnyRouter,
} from "@tanstack/react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";

import { FilesSidebar } from "./files-sidebar.tsx";
import { FilesClipboardProvider } from "./files-clipboard.tsx";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, type files_VisibleTreeNode } from "@/lib/files.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { FilesMoveIntake } from "@/lib/files-move-intake.ts";

const {
	treeState,
	tenantState,
	linkState,
	savedState,
	createNode,
	creationPolicy,
	preloadSnapshot,
	cancelSnapshotPreload,
	queryCalls,
	intakeState,
} = vi.hoisted(() => ({
	// `sharedRoots` holds the rows of the "Shared with you" group, `sharedRootsStatus` its pager status.
	// `sharedListeners` re-render the group after a change.
	treeState: {
		nodes: [] as files_VisibleTreeNode[],
		sharedRoots: [] as files_VisibleTreeNode[],
		sharedRootsStatus: "done" as "loading" | "more" | "done",
		loadMoreShared: vi.fn(),
		// The open folders of the last `useFolders` call. The real provider mounts one pager for each.
		requestedFolderIds: [] as string[],
		listeners: new Set<() => void>(),
		sharedListeners: new Set<() => void>(),
	},
	// The mocked tenant hook subscribes here. Like a real membership change, a notify re-renders
	// every component that called it. A parent rerender alone does not, because the React Compiler
	// keeps its output when props are unchanged.
	tenantState: { membershipId: "membership", listeners: new Set<() => void>() },
	// The workspace list of public links. `undefined` is loading, `null` is refused.
	linkState: {
		links: [] as unknown,
		listeners: new Set<() => void>(),
	},
	// The `search_saved` answers by clause. `undefined` keeps the first page loading, and a clause with
	// no answer is empty and done. `revision` changes with every answer, to re-render the search.
	savedState: {
		answers: new Map<string, { rows: unknown[]; isDone: boolean } | undefined>(),
		revision: 0,
		listeners: new Set<() => void>(),
	},
	createNode: vi.fn(),
	creationPolicy: vi.fn(),
	preloadSnapshot: vi.fn(),
	cancelSnapshotPreload: vi.fn(),
	// Every query a component read, by function name and args, so a test can see which node a dialog reads.
	queryCalls: [] as Array<[string, unknown]>,
	intakeState: { sourceIds: [] as app_convex_Id<"files_nodes">[] },
}));

function set_links(links: unknown) {
	linkState.links = links;
	for (const listener of linkState.listeners) listener();
}

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user" }) },
}));

vi.mock("@/lib/files-move-intake.ts", () => ({
	files_move_intake_load: async () => null,
	files_move_intake_save: async (args: { sourceIds: app_convex_Id<"files_nodes">[] }) => {
		intakeState.sourceIds = args.sourceIds;
	},
	files_move_intake_read_page: async (args: { request: FilesMoveIntake; offset: number }) =>
		intakeState.sourceIds.slice(args.offset, args.offset + 100),
	files_move_intake_update: async () => {},
	files_move_intake_delete: async () => {},
}));

// Keep the fixed pager results used by this component test.
vi.mock("@/hooks/files-paginated-query-hooks.ts", async () => {
	const { usePaginatedQuery } = await import("convex/react");
	return { useFilesPaginatedQuery: usePaginatedQuery };
});

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
	const subscribeSaved = (listener: () => void) => {
		savedState.listeners.add(listener);
		return () => {
			savedState.listeners.delete(listener);
		};
	};
	return {
		...original,
		useConvex: () => ({
			query: async (query: FunctionReference<"query">, args: unknown) =>
				getFunctionName(query) === "files_transfer_queries:get_move_acceptance" ? null : creationPolicy(query, args),
			mutation: createNode,
			action: createNode,
		}),
		useQuery: (query: FunctionReference<"query">, args: unknown) => {
			const links = useSyncExternalStore(subscribeLinks, () => linkState.links);
			if (args === "skip") return undefined;
			queryCalls.push([getFunctionName(query), args]);
			// The share and properties dialogs stay loading.
			if (
				getFunctionName(query) === "files_sharing:get_node_share_state" ||
				getFunctionName(query) === "files_tree:get_file_node_for_membership"
			)
				return undefined;
			if (getFunctionName(query) === "files_transfer_queries:get") return null;
			if (getFunctionName(query) === "files_tree:get_workspace_move_view")
				return { cohortId: null, view: null, generation: 0, searchGeneration: 0 };
			if (getFunctionName(query) === "files_share_links:list_workspace_links") return links;
			return getFunctionName(query) === "access_control:get_current_user_workspace_permission" ? true : [];
		},
		useQueries: () => queryResults,
		usePaginatedQuery: (query: FunctionReference<"query">, args: { clause?: unknown } | "skip") => {
			useSyncExternalStore(subscribeSaved, () => savedState.revision);
			if (args === "skip") return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
			if (getFunctionName(query) === "files_nodes:search_saved") {
				const key = JSON.stringify(args.clause);
				const answer = savedState.answers.has(key) ? savedState.answers.get(key) : { rows: [], isDone: true };
				if (answer === undefined) {
					return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
				}
				return {
					results: answer.rows,
					status: answer.isDone ? "Exhausted" : "CanLoadMore",
					isLoading: false,
					loadMore: () => {},
				};
			}
			return { results: [], status: "Exhausted", isLoading: false, loadMore: () => {} };
		},
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
			// Serve every fixture row as loaded. A row whose parent is not in the fixture is pinned under a
			// hidden folder, so the store would show it at the top.
			useFolders: function useFolders(request: { folderIds: string[] }) {
				treeState.requestedFolderIds = request.folderIds;
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
vi.mock("@/lib/files-yjs-snapshot-preload.ts", () => ({ files_yjs_preload_snapshot: preloadSnapshot }));

beforeEach(() => {
	createNode.mockReset();
	creationPolicy.mockReset().mockResolvedValue([]);
	cancelSnapshotPreload.mockReset();
	preloadSnapshot.mockReset().mockReturnValue(cancelSnapshotPreload);
	queryCalls.length = 0;
	tenantState.membershipId = "membership";
	set_links([]);
	savedState.answers.clear();
	treeState.sharedRoots = [];
	treeState.sharedRootsStatus = "done";
	treeState.loadMoreShared.mockReset();
	treeState.requestedFolderIds = [];
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
	savedState.listeners.clear();
});

describe("FilesSidebar", () => {
	function CreateSidebar(props: {
		router: AnyRouter;
		selectedNodeId: string;
		view?: "rich_text_editor" | "plain_text_editor" | "diff_editor";
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
						userId={"user" as app_convex_Id<"users">}
						membershipId={membershipId as app_convex_Id<"organizations_workspaces_users">}
					>
						<FilesSidebar
							selectedNodeId={props.selectedNodeId}
							view={props.view ?? "rich_text_editor"}
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
			{ ...bravo!, restrictedScopeNodeId: bravo!._id },
			{
				...alpha!,
				_id: "secret" as app_convex_Id<"files_nodes">,
				restrictedScopeNodeId: "secret" as app_convex_Id<"files_nodes">,
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
			restrictedScopeNodeId: name as app_convex_Id<"files_nodes">,
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

	test("Show more leaves focus in a row menu the user opened while the page loaded", async () => {
		treeState.sharedRoots = [share("s1")];
		treeState.sharedRootsStatus = "more";
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });
		const showMore = within(group).getByRole("button", { name: "Show more" });

		showMore.focus();
		fireEvent.click(showMore);
		const row = within(group).getByRole("button", { name: "s1 restricted" });
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "F10", shiftKey: true });
		const menu = await view.findByRole("menu");
		await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
		set_shared_roots([share("s1"), share("s2")], "done");
		await waitFor(() => expect(within(group).getAllByRole("button")).toHaveLength(2));
		expect(view.queryByRole("menu")).toBe(menu);
		expect(menu.contains(document.activeElement)).toBe(true);
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

	test("rename keeps the old name and opens the accepted Move", async () => {
		createNode.mockResolvedValue({ _yay: { runId: "rename-run", activityId: "rename-activity" } });
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "bravo" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Rename" }));
		const input = await view.findByRole("textbox", { name: "Rename bravo" });
		fireEvent.change(input, { target: { value: "renamed" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		await waitFor(() =>
			expect(createNode).toHaveBeenCalledWith(app_convex_api.files_nodes.rename_node, {
				membershipId: "membership",
				requestId: expect.any(String),
				nodeId: "bravo",
				path: "renamed",
			}),
		);
		expect(createNode.mock.calls[0]).toHaveLength(2);
		expect(view.getByRole("treeitem", { name: "bravo" })).toBeTruthy();
		expect(view.queryByRole("treeitem", { name: "renamed" })).toBeNull();
		await waitFor(() =>
			expect(queryCalls).toContainEqual(["files_transfer_queries:get", { membershipId: "membership", runId: "rename-run" }]),
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
		await waitFor(() => expect(createNode).toHaveBeenCalled());
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
			"files_tree:get_file_node_for_membership",
			{ membershipId: "membership", fileNodeId: "secret" },
		]);
	});

	test.each([
		["Share", "Close"],
		["Archive", "Cancel"],
	])("closing %s with %s from a Shared with you row focuses that row, not its tree row", async (action, close) => {
		// `bravo` also shows in the tree.
		treeState.sharedRoots = [{ ...treeState.nodes[1]!, restrictedScopeNodeId: treeState.nodes[1]!._id }];
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

	test("a Shared with you row of an item with added people is not marked restricted", async () => {
		// An open item with added people keeps `restrictedScopeNodeId` of its area, here none.
		treeState.sharedRoots = [{ ...share("added"), restrictedScopeNodeId: null }];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });

		const row = within(group).getByRole("button", { name: "added" });
		expect(row.querySelector("[data-file-restricted]")).toBeNull();
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

	test("a confirmed archive of a Shared with you row finds the row again when the group remounted", async () => {
		treeState.sharedRoots = [share("s1"), share("s2"), share("s3")];
		vi.spyOn(app_convex, "mutation").mockImplementation(async () => {
			// The group hides and comes back before the archive resolves, so its rows are new elements.
			for (const rows of [[], [share("s1"), share("s2"), share("s3")]]) {
				treeState.sharedRoots = rows;
				for (const listener of treeState.sharedListeners) listener();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			return { _yay: null };
		});
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const group = await view.findByRole("region", { name: "Shared with you" });

		fireEvent.contextMenu(within(group).getByRole("button", { name: "s2 restricted" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Archive" }));
		const dialog = await view.findByRole("dialog", { name: "Archive “s2”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
		set_shared_roots([share("s1"), share("s3")], "done");
		// Wait past the tree's focus timer.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const remountedGroup = view.getByRole("region", { name: "Shared with you" });
		expect(remountedGroup).not.toBe(group);
		expect(document.activeElement).toBe(within(remountedGroup).getByRole("button", { name: "s3 restricted" }));
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
		await waitFor(() => expect(createNode).toHaveBeenCalled());
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
		await waitFor(() => expect(createNode).toHaveBeenCalled());
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
		await waitFor(() => expect(createNode).toHaveBeenCalled());
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
		await waitFor(() => expect(createNode).toHaveBeenCalled());
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

	/**
	 * A child the user cannot open, as the tree streams give it: only its name and facts.
	 */
	function locked_node(name: string, archiveOperationId: string | null = null) {
		return {
			_id: name,
			_creationTime: 1,
			parentId: files_ROOT_ID,
			name,
			path: `/${name}`,
			kind: "folder",
			contentType: null,
			lowercaseExtension: null,
			contentByteSize: null,
			updatedAt: 1,
			archiveOperationId,
			locked: true,
		} as unknown as files_VisibleTreeNode;
	}

	test("a locked folder has no expand arrow and opens the locked screen", async () => {
		treeState.nodes = [...treeState.nodes, locked_node("team")];
		const onPrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" onPrimaryAction={onPrimaryAction} />);
		const row = await view.findByRole("treeitem", { name: "team, you don't have access" });

		expect(row.getAttribute("data-file-locked")).toBe("on");
		expect(view.getByRole("button", { name: "Expand folder alpha" })).toBeTruthy();
		expect(view.queryByRole("button", { name: /^Expand folder team/ })).toBeNull();
		expect(row.hasAttribute("aria-expanded")).toBe(false);
		// The arrow keys do not open it either.
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "ArrowRight", code: "ArrowRight" });
		expect(treeState.requestedFolderIds).not.toContain("team");
		expect(row.hasAttribute("aria-expanded")).toBe(false);

		// Click and Enter open it. The node route shows the locked screen.
		fireEvent.click(row.querySelector(".FilesSidebarTreeItemPrimaryAction")!);
		expect(onPrimaryAction).toHaveBeenCalledWith("team", "folder");
		onPrimaryAction.mockClear();
		fireEvent.keyDown(row, { key: "Enter", code: "Enter" });
		expect(onPrimaryAction).toHaveBeenCalledWith("team", "folder");
	});

	test("a locked row has only Copy path and Properties", async () => {
		treeState.nodes = [...treeState.nodes, locked_node("team")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		const row = await view.findByRole("treeitem", { name: "team, you don't have access" });

		fireEvent.contextMenu(row);
		await view.findByRole("menuitem", { name: "Copy path" });
		expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy path", "Properties"]);
		fireEvent.click(view.getByRole("menuitem", { name: "Properties" }));
		expect(await view.findByRole("dialog", { name: "Properties" })).toBeTruthy();
		// Its share state, write access and node are never read.
		expect(queryCalls.some(([, args]) => JSON.stringify(args).includes('"team"'))).toBe(false);
	});

	test("F2 and Delete do nothing on a locked row", async () => {
		treeState.nodes = [...treeState.nodes, locked_node("team")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		// F2 renames an open row, so the key reaches the tree.
		const bravo = await view.findByRole("treeitem", { name: "bravo" });
		act(() => bravo.focus());
		fireEvent.keyDown(bravo, { key: "F2", code: "F2" });
		fireEvent.keyUp(bravo, { key: "F2", code: "F2" });
		const input = await view.findByRole("textbox", { name: "Rename bravo" });
		fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());

		const row = view.getByRole("treeitem", { name: "team, you don't have access" });
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "F2", code: "F2" });
		fireEvent.keyUp(row, { key: "F2", code: "F2" });
		fireEvent.keyDown(row, { key: "Delete", code: "Delete" });
		fireEvent.keyUp(row, { key: "Delete", code: "Delete" });
		expect(view.queryByRole("textbox")).toBeNull();
		expect(view.queryByRole("dialog")).toBeNull();
		expect(createNode).not.toHaveBeenCalled();
	});

	test("a rename to a locked sibling's name is refused on the client", async () => {
		treeState.nodes = [...treeState.nodes, locked_node("team")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		await view.findByRole("treeitem", { name: "team, you don't have access" });
		fireEvent.click(view.getByRole("button", { name: "More actions for bravo" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Rename" }));
		const input = await view.findByRole("textbox", { name: "Rename bravo" });
		fireEvent.change(input, { target: { value: "team" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(await view.findByText(/already exists/)).toBeTruthy();
		expect(createNode).not.toHaveBeenCalled();
	});

	test("a locked archived row has no Restore", async () => {
		treeState.nodes = [...treeState.nodes, locked_node("old", "qa-archive")];
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		fireEvent.click(await view.findByRole("button", { name: "More options" }));
		const showArchived = await view.findByRole("menuitemcheckbox", { name: "Show archived items" });
		fireEvent.click(showArchived);
		fireEvent.keyDown(showArchived, { key: "Escape" });
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());

		fireEvent.contextMenu(await view.findByRole("treeitem", { name: "old archived, you don't have access" }));
		await view.findByRole("menuitem", { name: "Copy path" });
		expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy path", "Properties"]);
		expect(view.queryByRole("menuitem", { name: "Restore" })).toBeNull();
	});

	test("a Restore that throws shows an error toast", async () => {
		const errorToast = vi.spyOn(toast, "error").mockReturnValue("error");
		vi.spyOn(console, "error").mockImplementation(() => {});
		createNode.mockRejectedValue(new Error("Read too much data"));
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="bravo" />);
		fireEvent.click(await view.findByRole("button", { name: "More options" }));
		const showArchived = await view.findByRole("menuitemcheckbox", { name: "Show archived items" });
		fireEvent.click(showArchived);
		fireEvent.keyDown(showArchived, { key: "Escape" });
		await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
		act(() => {
			treeState.nodes = treeState.nodes.map((node) =>
				node._id === "alpha" ? { ...node, archiveOperationId: "qa-archive" } : node,
			);
			for (const listener of treeState.listeners) listener();
		});
		await view.findByRole("treeitem", { name: "alpha archived" });
		fireEvent.click(view.getByRole("button", { name: "More actions for alpha archived" }));
		fireEvent.click(await view.findByRole("menuitem", { name: "Restore" }));

		await waitFor(() =>
			expect(createNode).toHaveBeenCalledWith(app_convex_api.files_nodes.unarchive_nodes, {
				membershipId: "membership",
				nodeIds: ["alpha"],
			}),
		);
		await waitFor(() => expect(errorToast).toHaveBeenCalledWith("Failed to restore. Try again."));
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

	test("preloads a newly created file before navigating to its rich editor", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
		createNode.mockResolvedValue({ _yay: { nodeId: "created-node" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		fireEvent.click(view.getByRole("button", { name: "New file" }));
		await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
		expect(preloadSnapshot).toHaveBeenCalledExactlyOnceWith({ membershipId: "membership", nodeId: "created-node" });
		expect(preloadSnapshot.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
		view.rerender(<CreateSidebar router={router} selectedNodeId="created-node" />);
		expect(cancelSnapshotPreload).not.toHaveBeenCalled();
	});

	test.each(["folder", "plain_text_editor", "diff_editor", "refused"] as const)(
		"does not preload a %s creation",
		async (mode) => {
			const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
			vi.spyOn(router, "navigate").mockResolvedValue(undefined);
			vi.spyOn(console, "error").mockImplementation(() => {});
			createNode.mockResolvedValue(
				mode === "refused" ? { _nay: { message: "Permission denied" } } : { _yay: { nodeId: "created-node" } },
			);
			const view = render(
				<CreateSidebar
					router={router}
					selectedNodeId="alpha"
					view={mode === "plain_text_editor" || mode === "diff_editor" ? mode : "rich_text_editor"}
				/>,
			);
			fireEvent.click(view.getByRole("button", { name: mode === "folder" ? "New folder" : "New file" }));
			await waitFor(() => expect(createNode).toHaveBeenCalledOnce());
			await act(async () => {});
			expect(preloadSnapshot).not.toHaveBeenCalled();
		},
	);

	test.each(["route", "workspace", "unmount", "navigation failed"] as const)(
		"cancels the created file's pending preload on %s",
		async (stage) => {
			const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
			const navigation = Promise.withResolvers<void>();
			vi.spyOn(router, "navigate").mockReturnValue(navigation.promise);
			vi.spyOn(console, "error").mockImplementation(() => {});
			createNode.mockResolvedValue({ _yay: { nodeId: "created-node" } });
			const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
			fireEvent.click(view.getByRole("button", { name: "New file" }));
			await waitFor(() => expect(preloadSnapshot).toHaveBeenCalledOnce());
			view.rerender(<CreateSidebar router={router} selectedNodeId="created-node" />);
			expect(cancelSnapshotPreload).not.toHaveBeenCalled();
			if (stage === "route") {
				view.rerender(<CreateSidebar router={router} selectedNodeId="alpha" />);
			} else if (stage === "workspace") {
				act(() => {
					tenantState.membershipId = "other-membership";
					for (const listener of tenantState.listeners) listener();
				});
			} else if (stage === "unmount") {
				view.unmount();
			} else {
				await act(async () => navigation.reject(new Error("Navigation failed")));
			}
			expect(cancelSnapshotPreload).toHaveBeenCalledOnce();
			await act(async () => navigation.resolve());
		},
	);

	test("preloads a file created through the sidebar's name modal before navigation", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
		creationPolicy.mockResolvedValue("read_only");
		createNode.mockResolvedValue({ _yay: { nodeId: "created-node" } });
		const view = render(<CreateSidebar router={router} selectedNodeId="alpha" />);
		fireEvent.click(await view.findByRole("button", { name: "Add file to alpha" }));
		const submit = await view.findByRole("button", { name: "Create file" });
		fireEvent.click(submit);
		await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
		expect(preloadSnapshot).toHaveBeenCalledExactlyOnceWith({ membershipId: "membership", nodeId: "created-node" });
		expect(preloadSnapshot.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
	});
});
