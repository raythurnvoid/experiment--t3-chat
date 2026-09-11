import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";

import { FilesSidebar } from "./files-sidebar.tsx";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, type files_VisibleTreeNode } from "@/lib/files.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { treeState } = vi.hoisted(() => ({
	treeState: { nodes: [] as files_VisibleTreeNode[], listeners: new Set<() => void>() },
}));

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	const { getFunctionName } = await import("convex/server");
	const queryResults = {};
	return {
		...original,
		useConvex: () => ({ query: async () => [] }),
		useQuery: (query: FunctionReference<"query">, args: unknown) => {
			if (args === "skip") return undefined;
			return getFunctionName(query) === "access_control:get_current_user_workspace_permission" ? true : [];
		},
		useQueries: () => queryResults,
		usePaginatedQuery: () => ({ results: [], status: "Exhausted", isLoading: false, loadMore: () => {} }),
	};
});

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership",
			organizationId: "organization",
			organizationName: "organization",
			workspaceId: "workspace",
			workspaceName: "workspace",
		}),
	},
}));

vi.mock("@/lib/files-tree-context.tsx", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		FilesTreeProvider: {
			useContext: function useContext() {
				return useSyncExternalStore(
					(listener) => {
						treeState.listeners.add(listener);
						return () => treeState.listeners.delete(listener);
					},
					() => treeState.nodes,
				);
			},
		},
	};
});

vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));

beforeEach(() => {
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
});

describe("FilesSidebar", () => {
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
				return (
					<RouterContextProvider router={router}>
						<FilesSidebar
							selectedNodeId={props.selectedNodeId}
							view="rich_text_editor"
							initialSearchQuery={searchQuery}
							onClose={handleAction}
							onArchive={handleAction}
							onPrimaryAction={handleAction}
							onSearchQueryChange={setSearchQuery}
						/>
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
});
