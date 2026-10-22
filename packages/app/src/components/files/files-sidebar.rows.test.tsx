// The create, focus, reveal, archive and search tests, split from files-sidebar.test.tsx so the two files can
// run at the same time. Keep the mocks the same as in that file.
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

function set_saved(clause: unknown, answer: { rows: unknown[]; isDone: boolean } | undefined) {
	savedState.answers.set(JSON.stringify(clause), answer);
	savedState.revision++;
	for (const listener of savedState.listeners) listener();
}

function saved_row(path: string, kind: "file" | "folder" = "file") {
	return { kind, nodeId: path.slice(path.lastIndexOf("/") + 1), path };
}

function link(nodeId: string) {
	return { nodeId, createdBy: "user", createdAt: 1 };
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
				getFunctionName(query) === "files_transfer_status:get_move_acceptance" ? null : creationPolicy(query, args),
			mutation: createNode,
			// The custom-field search answers by its metadata clause, with all its rows at once.
			action: async (action: FunctionReference<"action">, args: { plan?: unknown }) => {
				if (getFunctionName(action) !== "files_nodes:search_saved_metadata") return createNode(action, args);
				const answer = savedState.answers.get(JSON.stringify({ kind: "metadata", plan: args.plan }));
				return { _yay: { page: answer?.rows ?? [], cursor: null, isDone: true } };
			},
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
			if (getFunctionName(query) === "files_transfer_status:get") return null;
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
vi.mock("@/lib/files-yjs-snapshot.ts", () => ({ files_yjs_preload_snapshot: preloadSnapshot }));

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
								userId={"user" as app_convex_Id<"users">}
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

	test("Expand root folders loads only the open folders on screen, and the others once their rows scroll into view", async () => {
		treeState.nodes = Array.from({ length: 500 }, (_, index) => ({
			...treeState.nodes[0],
			_id: `folder-${index}` as app_convex_Id<"files_nodes">,
			path: `/folder-${index}`,
			treePath: `/folder-${index}/`,
			name: `folder-${index}`,
		}));
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="folder-0" />);
		await view.findByRole("treeitem", { name: "folder-0" });

		fireEvent.click(view.getByRole("button", { name: "Expand root folders" }));
		await waitFor(() => expect(treeState.requestedFolderIds).toContain("folder-0"));
		// Every folder is open, but only the rendered rows load. Loading all 500 would mount 500 pagers.
		expect(treeState.requestedFolderIds.length).toBeGreaterThan(1);
		expect(treeState.requestedFolderIds.length).toBeLessThan(30);
		expect(treeState.requestedFolderIds).not.toContain("folder-400");

		// An open folder row is 90 px: its row and its placeholder row.
		const content = view.container.querySelector(".FilesSidebar-content")!;
		vi.spyOn(content, "scrollHeight", "get").mockReturnValue(500 * 90);
		act(() => {
			content.scrollTop = 400 * 90;
			content.dispatchEvent(new Event("scroll"));
		});
		const folder400 = await view.findByRole("treeitem", { name: "folder-400" });
		expect(folder400.getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(treeState.requestedFolderIds).toContain("folder-400"));
		// A folder that scrolled away keeps loading, so the rows above the screen do not change height.
		expect(treeState.requestedFolderIds).toContain("folder-0");
		expect(treeState.requestedFolderIds.length).toBeLessThan(60);
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
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("/alpha\n/bravo");

		// The request had 2 items, so the selection clears even though only bravo was archived.
		vi.spyOn(app_convex, "mutation").mockResolvedValue({
			_yay: {
				runId: "run",
				activityId: "activity",
				isDone: true,
				notArchivedNodeIds: ["alpha"],
				refusedItems: [{ nodeId: "alpha", message: '"/alpha/locked.md" is read-only. Unlock it, then try again.' }],
				waitingNodeIds: [],
				isChecking: false,
			},
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
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("/bravo\n/locked.md");
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
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("/bravo\n/locked.md");
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

		set_saved({ kind: "name", text: "charlie" }, { rows: [saved_row("/charlie", "folder")], isDone: true });
		const searchInput = view.getByRole("combobox");
		act(() => searchInput.focus());
		fireEvent.change(searchInput, { target: { value: "charlie" } });
		await view.findByRole("button", { name: "charlie in /" }, { timeout: 5_000 });
		expect(view.queryAllByRole("treeitem")).toHaveLength(0);

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

	test("file.link:public lists a public file with its folder, and Enter waits for the list", async () => {
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
		set_saved({ kind: "link" }, undefined);
		const handlePrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" onPrimaryAction={handlePrimaryAction} />);
		expect((await view.findByRole("treeitem", { name: "alpha" })).getAttribute("aria-expanded")).toBe("false");

		// The first Enter turns the typed filter into a chip. Enter cannot open anything while the list
		// loads its first page.
		const searchInput = view.getByRole("combobox");
		act(() => searchInput.focus());
		fireEvent.change(searchInput, { target: { value: "file.link:public" } });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		const results = await view.findByRole("region", { name: "Search results" }, { timeout: 5_000 });
		await within(results).findByText("Searching…");
		expect(view.queryByText(/Still searching/)).toBeNull();
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).not.toHaveBeenCalled();
		expect(view.getByText(/Still searching/)).toBeTruthy();

		act(() => set_saved({ kind: "link" }, { rows: [saved_row("/alpha/bravo")], isDone: true }));
		const row = await within(results).findByRole("button", { name: "bravo in /alpha" });
		expect(row.textContent).toBe("bravo/alpha");
		expect(view.getAllByText("1 match").length).toBeGreaterThan(0);
		// One finished match opens with Enter.
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).toHaveBeenCalledWith("bravo", "file");
		fireEvent.click(row);
		expect(handlePrimaryAction).toHaveBeenCalledTimes(2);
	});

	test("Enter right after typing waits for the search of the typed text", async () => {
		set_saved({ kind: "name", text: "bravo" }, { rows: [saved_row("/bravo", "folder")], isDone: true });
		const handlePrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" onPrimaryAction={handlePrimaryAction} />);
		await view.findByRole("treeitem", { name: "alpha" });

		const searchInput = view.getByRole("combobox");
		fireEvent.change(searchInput, { target: { value: "bravo" } });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).not.toHaveBeenCalled();
		expect(view.getByText(/Still searching/)).toBeTruthy();

		await view.findByRole("button", { name: "bravo in /" }, { timeout: 5_000 });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).toHaveBeenCalledWith("bravo", "folder");
	});

	test("the search list counts its loaded matches and keeps the row menu", async () => {
		set_saved(
			{ kind: "name", text: "notes" },
			{ rows: [saved_row("/a/notes.md"), saved_row("/b/notes-2.md")], isDone: false },
		);
		const handlePrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" onPrimaryAction={handlePrimaryAction} />);
		await view.findByRole("treeitem", { name: "alpha" });

		const searchInput = view.getByRole("combobox");
		fireEvent.change(searchInput, { target: { value: "notes" } });
		const results = await view.findByRole("region", { name: "Search results" }, { timeout: 5_000 });
		// The status line and its screen reader copy both read the count.
		expect((await view.findAllByText("2+ matches")).length).toBeGreaterThan(0);
		expect(within(results).getByRole("button", { name: "Show more" })).toBeTruthy();
		// More pages can load, so Enter opens nothing.
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		expect(handlePrimaryAction).not.toHaveBeenCalled();

		fireEvent.contextMenu(within(results).getByRole("button", { name: "notes-2.md in /b" }));
		expect(await view.findByRole("menuitem", { name: "Properties" })).toBeTruthy();
		expect(view.getByRole("menuitem", { name: "Rename" }).getAttribute("aria-disabled")).toBe("true");
	});

	test("a locked search hit shows the lock, opens its page, and has only Copy path and Properties", async () => {
		set_saved(
			{ kind: "name", text: "plan" },
			{ rows: [{ ...saved_row("/team/plan.md"), contentType: null, locked: true }], isDone: true },
		);
		const handlePrimaryAction = vi.fn();
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" onPrimaryAction={handlePrimaryAction} />);
		await view.findByRole("treeitem", { name: "alpha" });

		fireEvent.change(view.getByRole("combobox"), { target: { value: "plan" } });
		const results = await view.findByRole("region", { name: "Search results" }, { timeout: 5_000 });
		const row = await within(results).findByRole("button", { name: "plan.md in /team, you don't have access" });
		expect(row.classList.contains("FilesSidebarSearchResults-row-locked")).toBe(true);
		expect(row.getAttribute("title")).toBe("You don't have access");
		fireEvent.click(row);
		expect(handlePrimaryAction).toHaveBeenCalledWith("plan.md", "file");

		fireEvent.contextMenu(row);
		await view.findByRole("menuitem", { name: "Copy path" });
		expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy path", "Properties"]);
	});

	test("while archived items show, the search says it lists active items only", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" />);
		await view.findByRole("treeitem", { name: "alpha" });
		fireEvent.click(view.getByRole("button", { name: "More options" }));
		fireEvent.click(await view.findByRole("menuitemcheckbox", { name: "Show archived items" }));

		fireEvent.change(view.getByRole("combobox"), { target: { value: "notes" } });
		const results = await view.findByRole("region", { name: "Search results" }, { timeout: 5_000 });
		expect(within(results).getByText("Search shows active items only.")).toBeTruthy();
		expect(within(results).getByText("No files match your search.")).toBeTruthy();
	});

	test("a date in a folder says it matches only the same text", async () => {
		set_saved(
			{ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.due", value: "2026-09-04" } },
			{ rows: [saved_row("/docs/a.md")], isDone: true },
		);
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		const view = render(<CreateSidebar router={router} selectedNodeId="delta" />);
		await view.findByRole("treeitem", { name: "alpha" });

		const searchInput = view.getByRole("combobox");
		fireEvent.change(searchInput, { target: { value: "file.path:/docs metadata.due:2026-09-04" } });
		fireEvent.keyDown(searchInput, { key: "Enter", code: "Enter" });
		const results = await view.findByRole("region", { name: "Search results" }, { timeout: 5_000 });
		expect(await within(results).findByRole("button", { name: "a.md in /docs" })).toBeTruthy();
		expect(within(results).getByText("In a folder, a date matches only values written the same way.")).toBeTruthy();
	});
});
