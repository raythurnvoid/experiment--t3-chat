import { createContext, memo, use, useCallback, useEffect, useState, type ReactNode } from "react";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";

const FilesTreeContext = createContext<{
	nodes: FunctionReturnType<typeof app_convex_api.files_nodes.list_tree>["page"] | undefined;
	registerConsumer: () => () => void;
} | null>(null);

const FilesTreeProvider = Object.assign(
	memo(function FilesTreeProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const [consumerCount, setConsumerCount] = useState(0);
		const registerConsumer = useCallback(() => {
			setConsumerCount((count) => count + 1);
			return () => setConsumerCount((count) => count - 1);
		}, []);
		// Each paginated hook gets its own session. Share this one across every tree consumer.
		const { results, status, loadMore } = usePaginatedQuery(
			app_convex_api.files_nodes.list_tree,
			consumerCount > 0 ? { membershipId } : "skip",
			{ initialNumItems: 500 },
		);
		const [completeTree, setCompleteTree] = useState<{
			membershipId: typeof membershipId;
			nodes: typeof results;
		} | null>(null);
		const clearCompleteTree = consumerCount === 0 || completeTree?.membershipId !== membershipId;
		if (status === "Exhausted" && completeTree?.nodes !== results) {
			setCompleteTree({ membershipId, nodes: results });
		} else if (clearCompleteTree && completeTree !== null) {
			setCompleteTree(null);
		}

		useEffect(() => {
			if (status === "CanLoadMore") {
				loadMore(500);
			} else if (status === "LoadingFirstPage") {
				// A split briefly reports this status in a discarded render. Clear only after it settles.
				setCompleteTree(null);
			}
		}, [status, loadMore]);

		// Keep the last complete query result while Convex replaces a split page.
		// Folder README editors must keep their node id and stay mounted during that wait.
		const nodes = status === "Exhausted" ? results : clearCompleteTree ? undefined : completeTree?.nodes;
		return <FilesTreeContext.Provider value={{ nodes, registerConsumer }}>{children}</FilesTreeContext.Provider>;
	}),
	{
		useContext: function useContext() {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useContext must be used within FilesTreeProvider");
			}
			useEffect(value.registerConsumer, [value.registerConsumer]);
			return value.nodes;
		},
	},
);

export { FilesTreeProvider };
