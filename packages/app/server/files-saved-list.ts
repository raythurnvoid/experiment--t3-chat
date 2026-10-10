import type { FunctionArgs } from "convex/server";
import { compareValues } from "convex/values";
import { z } from "zod";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_nodes_list_subtree_Result } from "../convex/files_nodes.ts";
import type { files_SavedStream } from "../shared/files.ts";
import { convex_invalid_cursor_error } from "./convex-utils.ts";

const key_schema = z.object({
	value: z.string(),
	createdAt: z.number(),
	nodeId: z.string(),
});
const cursor_schema = z.object({ scope: z.string(), lastKey: key_schema.nullable() });
type Key = z.infer<typeof key_schema>;

function compare_keys(a: Key, b: Key) {
	return compareValues([a.value, a.createdAt, a.nodeId], [b.value, b.createdAt, b.nodeId]);
}

/**
 * Merge native pages after one global full key. Unused docs are read again by an exact seek.
 */
export async function files_saved_list_page(
	ctx: Pick<ActionCtx, "runQuery">,
	args: Omit<
		FunctionArgs<typeof internal.files_nodes.list_subtree>,
		"savedStream" | "seek" | "organizationId" | "workspaceId" | "contentTypePrefix"
	> & {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		cursorScope: string;
		/** Families like `image/` or exact types like `image/png`. A row in two streams is listed once. */
		contentTypePrefixes?: string[];
	},
) {
	const { cursorScope, cursor, numItems, contentTypePrefixes, ...queryArgs } = args;
	const viewArgs = {
		agentSource: args.agentSource,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		visibilityUserId: args.visibilityUserId,
		serviceAccountId: args.serviceAccountId,
		folderPath: args.folderPath,
	};
	const memberArgs = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.visibilityUserId,
	};
	const view = await ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs);
	if (!view) return { page: [], continueCursor: "", isDone: true };
	const membership = await ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs);
	if (!membership) return { page: [], continueCursor: "", isDone: true };
	const sources: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
	if (view.cohortId !== null && view.view !== null) {
		sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
	}
	const scope = JSON.stringify([cursorScope, membership, queryArgs, contentTypePrefixes ?? null, sources]);
	let lastKey: Key | null = null;
	if (cursor !== null) {
		let input: unknown;
		try {
			input = JSON.parse(cursor);
		} catch {
			throw convex_invalid_cursor_error("Invalid saved list cursor.");
		}
		const parsed = cursor_schema.safeParse(input);
		if (!parsed.success || parsed.data.scope !== scope)
			throw convex_invalid_cursor_error("The saved list scope changed.");
		lastKey = parsed.data.lastKey;
	}
	const order = args.order === "desc" ? -1 : 1;
	const key_of = (node: Doc<"files_nodes">): Key => ({
		value: args.maxDepth === 1 ? node.name : node.treePath,
		createdAt: node._creationTime,
		nodeId: node._id,
	});
	const page: Doc<"files_nodes">[] = [];
	let isDone = false;
	// Source order follows migration. A doc moved between these reads is seen at least once.
	if (view.migrationDirection === "to_normal") sources.reverse();
	// Sparse access can leave a short page with a cursor.
	for (let round = 0; round < 8 && page.length < numItems; round++) {
		const batches: Array<{ rows: Doc<"files_nodes">[]; frontier: Key | null; done: boolean }> = [];
		// One stream per source and per type value. Each reads one index range of matching rows only.
		for (const source of sources) {
			for (const contentTypePrefix of contentTypePrefixes ?? [undefined]) {
				for (let phase = 0; ; phase++) {
					const result: files_nodes_list_subtree_Result = await ctx.runQuery(internal.files_nodes.list_subtree, {
						...queryArgs,
						contentTypePrefix,
						cursor: null,
						numItems: Math.min(100, numItems - page.length),
						savedStream: source,
						seek: {
							lowerKey: order === 1 ? lastKey : null,
							upperKey: order === -1 ? lastKey : null,
							phase,
						},
					});
					const phaseCount = "phaseCount" in result ? (result.phaseCount ?? 1) : 1;
					const frontier = "frontier" in result ? (result.frontier ?? null) : null;
					const done = result.isDone && phase + 1 >= phaseCount;
					if (frontier || done) {
						batches.push({ rows: result.page, frontier, done });
						break;
					}
				}
			}
		}
		const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
		frontiers.sort((a, b) => compare_keys(a, b) * order);
		const windowEnd = frontiers[0] ?? null;
		const rows = batches
			.flatMap((batch) => batch.rows)
			.filter((node) => windowEnd === null || compare_keys(key_of(node), windowEnd) * order <= 0)
			.sort((a, b) => compare_keys(key_of(a), key_of(b)) * order);
		// Staging or cleanup may expose the same stable node in both sequential snapshots.
		const seen = new Set<Id<"files_nodes">>();
		const unique = rows.filter((node) => {
			if (seen.has(node._id)) return false;
			seen.add(node._id);
			return true;
		});
		const remaining = numItems - page.length;
		if (unique.length > remaining) {
			page.push(...unique.slice(0, remaining));
			lastKey = key_of(page.at(-1)!);
			break;
		}
		page.push(...unique);
		isDone = batches.every((batch) => batch.done);
		lastKey = windowEnd ?? (page.length > 0 ? key_of(page.at(-1)!) : lastKey);
		if (isDone) break;
		// Re-seek both sources. A native cursor ahead of this common window can lose migrating docs.
	}
	const current = await ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs);
	const currentMembership = await ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs);
	if (
		!current ||
		current.generation !== view.generation ||
		current.cohortId !== view.cohortId ||
		current.view !== view.view ||
		current.migrationDirection !== view.migrationDirection ||
		JSON.stringify(currentMembership) !== JSON.stringify(membership)
	) {
		throw convex_invalid_cursor_error("The saved Move view changed.");
	}
	return { page, continueCursor: isDone ? "" : JSON.stringify({ scope, lastKey }), isDone };
}
