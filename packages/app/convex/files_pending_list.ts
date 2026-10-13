// Stored Pending list pages. Content and draft views stay in files_pending_updates.ts.

import { query, type QueryCtx } from "./_generated/server.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error } from "../server/convex-utils.ts";
import app_convex_schema, { files_pending_target_validator, files_saved_stream_validator } from "./schema.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import { files_saved_placement_db_get_proposal } from "../server/files-saved-placement.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

/**
 * The page cap of `list_files_pending_updates`.
 */
const PENDING_LIST_PAGE_MAX_ITEMS = 5;

/**
 * The split guard of `list_files_pending_updates`. A row reads only its stored proposal, never its
 * path or access, so it costs 1 range at any depth (measured in `files_visible.test.ts`; the page
 * itself costs 2 more). With a 3,000-range budget: floor(3,000 / 1) = 3,000 rows. The page cap
 * keeps a first load far below it. A reactive rerun has no cap, so the guard is for those.
 */
const PENDING_LIST_SPLIT_GUARD = 3000;

/**
 * List keys: `"all"`, `"own"` (no chat touched the change) or a chat id.
 */
export function files_pending_list_normalize_key(ctx: QueryCtx, listKey: string) {
	return listKey === "all" || listKey === "own" ? listKey : ctx.db.normalizeId("ai_chat_threads", listKey);
}

/**
 * One page of the Pending tab, newest change first. A row has only stored fields. Resolving a path
 * and checking access can cost about 1,300 reads for a draft 255 folders deep, so 5 rows would not
 * fit in one query. Each shown row loads its own view with `get_file_pending_target` instead.
 */
export const list_files_pending_updates = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		listKey: v.string(),
		paginationOpts: paginationOptsValidator,
		savedStream: v.optional(files_saved_stream_validator),
	},
	returns: paginationResultValidator(
		v.object({
			target: files_pending_target_validator,
			pendingUpdateId: v.id("files_pending_updates"),
			revision: v.number(),
			updatedAt: v.number(),
			listRowCreationTime: v.number(),
			listRowId: v.id("files_pending_list_rows"),
			threadIds: v.optional(v.array(v.id("ai_chat_threads"))),
			// Ready content to review, for the editor's review pager. Same rule as the view's `readiness`.
			hasReadyContent: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return { page: [], isDone: true, continueCursor: "" };
		}

		const listKey = files_pending_list_normalize_key(ctx, args.listKey);
		if (listKey === null) return { page: [], isDone: true, continueCursor: "" };
		await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const tag = args.savedStream?.kind === "cohort" ? args.savedStream : undefined;

		// The overlay flush keeps one list row per listed proposal and list key.
		const result = await ctx.db
			.query("files_pending_list_rows")
			.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view)
					.eq("listKey", listKey),
			)
			.order("desc")
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, PENDING_LIST_PAGE_MAX_ITEMS),
			});

		// Split before any per-row read, like `files_tree_db_page_needs_split`: a reactive
		// rerun has no row cap, and a new change always lands on the first page.
		if (result.splitCursor && (result.page.length > PENDING_LIST_SPLIT_GUARD || result.pageStatus)) {
			return {
				page: [],
				isDone: result.isDone,
				continueCursor: result.continueCursor,
				splitCursor: result.splitCursor,
				pageStatus: "SplitRequired" as const,
			};
		}

		const rows = [];
		for (const row of result.page) {
			const pendingUpdate = await files_saved_placement_db_get_proposal(ctx.db, row.pendingUpdateId);
			if (!pendingUpdate) continue;
			const { target, preparation, createIntent, content } = pendingUpdate;
			rows.push({
				target,
				pendingUpdateId: pendingUpdate._id,
				revision: pendingUpdate.revision,
				updatedAt: row.updatedAt,
				listRowCreationTime: row._creationTime,
				listRowId: row._id,
				...(pendingUpdate.threadIds ? { threadIds: pendingUpdate.threadIds } : {}),
				hasReadyContent:
					content !== undefined &&
					(target.kind === "saved" ||
						(!preparation &&
							createIntent !== undefined &&
							(createIntent.kind !== "text" || content.base.kind === "new"))),
			});
		}

		return { ...result, page: rows };
	},
});

/**
 * The Pending tab's source dropdown: the list keys that have changes, newest change first. `"all"`
 * is left out, because the dropdown always shows it.
 */
export const list_files_pending_sources = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		paginationOpts: paginationOptsValidator,
		savedStream: v.optional(files_saved_stream_validator),
	},
	returns: paginationResultValidator(
		v.object({
			listKey: doc(app_convex_schema, "files_pending_list_keys").fields.listKey,
			lastUpdatedAt: v.number(),
			keyCreationTime: v.number(),
			keyId: v.id("files_pending_list_keys"),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return { page: [], isDone: true, continueCursor: "" };
		await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const tag = args.savedStream?.kind === "cohort" ? args.savedStream : undefined;

		const result = await ctx.db
			.query("files_pending_list_keys")
			.withIndex("by_org_ws_user_lastUpdatedAt", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view),
			)
			.order("desc")
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.flatMap((key) =>
				key.listKey === "all"
					? []
					: [
							{
								listKey: key.listKey,
								lastUpdatedAt: key.lastUpdatedAt,
								keyCreationTime: key._creationTime,
								keyId: key._id,
							},
						],
			),
		};
	},
});
