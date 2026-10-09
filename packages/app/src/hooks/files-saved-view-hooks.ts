import { useQuery } from "convex/react";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_SavedStream } from "../../shared/files.ts";

/**
 * Both saved streams use one workspace view. A switch restarts their pagers together.
 */
export function useFilesSavedView(membershipId: app_convex_Id<"organizations_workspaces_users">, enabled = true) {
	const view = useQuery(app_convex_api.files_nodes.get_workspace_move_view, enabled ? { membershipId } : "skip");
	const normal: files_SavedStream | null = view ? { kind: "normal", generation: view.generation } : null;
	const cohort: files_SavedStream | null = view?.cohortId !== null && view?.view != null
		? { kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation }
		: null;
	return { normal, cohort, searchGeneration: view?.searchGeneration ?? null, loading: enabled && view === undefined };
}
