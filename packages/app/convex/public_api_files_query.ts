// The public API door that reads Files by one custom field: `/api/v1/files/query` (route in
// `public_api_files_query_http_routes.ts`).
//
// Folder mode reads the children of one folder that have the field, in value order, from the same
// index as the folder table. Search mode runs the walk of the search box's custom-field search.
//
// Both modes read saved data only, and return only items the caller can open.

import { compareValues, ConvexError } from "convex/values";
import { z } from "zod";

import type { ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { access_control_Subject } from "./access_control.ts";
import type { files_metadata_get_query_items_Result } from "./files_metadata.ts";
import type { files_nodes_get_query_search_start_Result } from "./files_nodes.ts";
import type { files_tree_list_children_by_field_Result } from "./files_tree.ts";
import type { files_visible_internal_get_index_view_Result } from "./files_visible.ts";
import {
	public_api_has_same_authority,
	type public_api_get_file_read_membership_Result,
	type public_api_validate_and_finish_scheduled_file_read_Result,
} from "./public_api.ts";
import {
	public_api_authorize_request,
	public_api_is_path_inside_prefix,
	public_api_resolve_live_principal,
	public_api_settle_plugin_call_best_effort,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";
import type { r2_get_assets_ready_states_Result } from "./r2.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { convex_invalid_cursor_error } from "../server/convex-utils.ts";
import { crypto_open_cursor, crypto_seal_cursor, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_pending_overlay_list } from "../server/files-pending-overlay.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import type { files_IndexStream } from "../shared/files.ts";
import {
	files_metadata_parse_maybe_date,
	files_metadata_QUERY_FIELDS_MAX,
	files_metadata_QUERY_ITEMS_CHUNK,
	files_metadata_SEARCH_VALUE_MAX_LENGTH,
	type files_metadata_SearchPlan,
} from "../shared/files-metadata.ts";
import {
	files_search_query_field_path_is_valid,
	files_search_query_range_bound,
} from "../shared/files-search-query.ts";
import { files_sort_text_key, files_sort_TEXT_KEY_MAX_CODE_POINTS } from "../shared/files-sort.ts";
import { files_table_starts_with_ends_in_digit } from "../shared/files-table.ts";
import type { public_api_Scope } from "../shared/public-api.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const QUERY_MAX_ITEMS = 50;

const ROOT_NEEDED_HINT =
	"Prefix and range read the whole workspace and need access to /. Use eq or exists with a folder path, or folder mode.";

// How long a search page cursor lives in `value_store`: one day, like the search box cursor
// (`files_nodes.search_saved_metadata`).
const SEARCH_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

type PageArgs = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	visibilityUserId: Id<"users">;
	subject: access_control_Subject;
	path: string;
	numItems: number;
	cursor: string | null;
	/**
	 * The caller and every request field except `cursor` and `limit`. A cursor opens only with the
	 * same scope.
	 */
	cursorScope: string;
};

/**
 * The membership a page and its cursor are bound to. Null when the person behind the call has none.
 * An old membership has no lifetime yet, so the first page gives it one.
 */
async function get_pinned_membership(
	ctx: ActionCtx,
	args: PageArgs,
): Promise<public_api_get_file_read_membership_Result> {
	const membership: public_api_get_file_read_membership_Result = await ctx.runQuery(
		internal.public_api.get_file_read_membership,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
		},
	);
	if (membership && args.cursor === null && membership.lifetime === null) {
		return await ctx.runMutation(internal.public_api.pin_file_list_membership, {
			membershipId: membership.membershipId,
		});
	}

	return membership;
}

// #region folder mode

/**
 * The place of a field doc in the folder order: `[sortValue, sortName, name, _creationTime, _id]`
 * (see `files_tree.list_children_by_field`).
 */
type FolderKey = Array<string | number | boolean>;

const folder_cursor_schema = z.object({
	lastKey: z
		.array(z.union([z.string(), z.number(), z.boolean()]))
		.length(5)
		.nullable(),
	/**
	 * The last file the caller got, with `[sortValue, sortName, name]`. Null until a page has a row.
	 * `sortValue` keeps its type, so a number key is compared as a number.
	 */
	lastItem: z
		.object({ nodeId: z.string(), key: z.array(z.union([z.string(), z.number(), z.boolean()])).length(3) })
		.nullable(),
});

type FolderPageArgs = PageArgs & {
	kind: Doc<"files_nodes">["kind"];
	field: string;
	match: { kind: "eq"; value: string | number | boolean } | { kind: "prefix"; value: string } | null;
	order: "asc" | "desc";
};

/**
 * One page of the children of one folder that have a field. The node ids come back in order.
 *
 * Answers `_nay` named `folder_unavailable` when the folder is missing or archived, `folder_locked`
 * when the caller cannot open it, `not_a_folder` when the path is a readable file, `listing_busy`
 * when files kept changing during the page, and `page_unavailable` when one page step is too large
 * to read even with one row.
 *
 * The folder checks follow `files_saved_list_page` (`server/files-saved-list.ts`), the folder
 * listing of `files/list`.
 */
async function read_folder_page(ctx: ActionCtx, args: FolderPageArgs) {
	const { organizationId, workspaceId, visibilityUserId, subject, path, numItems } = args;
	const viewArgs = { organizationId, workspaceId, visibilityUserId, subject, folderPath: path };
	// Check the folder on every page, so a folder archived between pages answers 404 too. The
	// workspace root has no doc.
	const get_root = async (): Promise<Doc<"files_nodes"> | null> =>
		path === "/"
			? null
			: await ctx.runQuery(internal.files_nodes.get_by_path, {
					organizationId,
					workspaceId,
					visibilityUserId,
					subject,
					path,
				});
	// The index view covers a Move and an index run. Both copy field docs between the normal docs and
	// the view docs.
	const get_view = async (): Promise<files_visible_internal_get_index_view_Result> =>
		await ctx.runQuery(internal.files_visible.internal_get_index_view, viewArgs);

	const [membership, root] = await Promise.all([get_pinned_membership(ctx, args), get_root()]);
	if (!membership) {
		return Result({ _nay: { name: "folder_locked", message: `Permission denied: ${path}` } });
	}
	// Locked, not hidden: a folder the caller cannot open, or any path below a locked folder, is
	// "Permission denied". Only a missing path is "not found". The workspace root is locked for a
	// guest, and for a plugin whose consent names folders only.
	if (!root) {
		const access: { status: "found" | "locked" | "missing" } = await ctx.runQuery(
			internal.files_nodes.get_path_access,
			{ organizationId, workspaceId, subject, path },
		);
		if (access.status === "locked") {
			return Result({ _nay: { name: "folder_locked", message: `Permission denied: ${path}` } });
		}
		if (path !== "/") {
			return Result({ _nay: { name: "folder_unavailable", message: `Folder not found: ${path}` } });
		}
	}
	if (root && root.kind !== "folder") {
		return Result({ _nay: { name: "not_a_folder", message: `Path must point to a folder: ${path}` } });
	}

	// The folder or the access changed during the page. A cursor cannot go on from there. A first page
	// can simply be sent again, and the next answer is exact.
	const folder_changed = (message: string) => {
		if (args.cursor !== null) throw convex_invalid_cursor_error(message);
		return Result({ _nay: { name: "listing_busy", message: "Files changed during this page. Retry it." } });
	};

	// The folder id is in the scope, so a cursor stops working when the folder is replaced at the same path.
	const scope = JSON.stringify([args.cursorScope, membership, root?._id ?? null]);
	let lastKey: FolderKey | null = null;
	let lastItem: z.infer<typeof folder_cursor_schema>["lastItem"] = null;
	if (args.cursor !== null) {
		const parsed = folder_cursor_schema.safeParse(
			await crypto_open_cursor({ purpose: "files_query", scope, cursor: args.cursor }),
		);
		if (!parsed.success) throw convex_invalid_cursor_error("The query scope changed.");
		lastKey = parsed.data.lastKey;
		lastItem = parsed.data.lastItem;
	}

	// Read one native range of one source. A range that is too large to read comes back as a split:
	// ask again for half the rows. "split" means even one row is too large. Null means the caller
	// cannot read the folder now.
	const read_phase = async (source: files_IndexStream, phase: number, phaseItems: number) => {
		for (let items = phaseItems; ; items = Math.floor(items / 2)) {
			const result: files_tree_list_children_by_field_Result = await ctx.runQuery(
				internal.files_tree.list_children_by_field,
				{
					organizationId,
					workspaceId,
					subject,
					folderId: root?._id ?? null,
					kind: args.kind,
					field: args.field,
					match: args.match,
					order: args.order,
					source,
					seek: { lastKey, phase },
					numItems: items,
				},
			);
			if (result === null || !result.split) return result;
			if (items === 1) return "split" as const;
		}
	};

	const order = args.order === "desc" ? -1 : 1;
	const page: Array<{ nodeId: Id<"files_nodes">; key: FolderKey }> = [];
	let isDone = false;
	let viewChanges = 0;
	// Page by seek, not by a native cursor. During a Move or an index run a field doc moves between
	// the sources, and a native cursor of one source would skip it. So every round reads each source
	// again from the last key the page used.
	//
	// Each round reads all sources of one index view. If a background job changes the view during the
	// round, a doc could move from a source not read yet to one already read. So read that round again
	// with the new view. Earlier rounds stay, because the seek key does not depend on the view. Every
	// save starts an index run, so checking per page instead would make busy workspaces fail often.
	//
	// A page can be short with a cursor: rows past the first unfinished source wait for the next
	// round, and rows that a background job has not reached yet are left out.
	for (let round = 0; round < 8 && page.length < numItems;) {
		const view = await get_view();
		if (!view) return folder_changed("The query scope changed.");
		const sources: files_IndexStream[] = [{ kind: "normal", generation: view.generation }];
		if (view.cohortId !== null && view.view !== null) {
			sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
		}
		// Source order follows the copy direction. A doc moved between these reads is seen at least once.
		if (view.migrationDirection === "to_normal") sources.reverse();

		const batches: Array<{
			rows: Array<{ nodeId: Id<"files_nodes">; key: FolderKey }>;
			frontier: FolderKey | null;
			done: boolean;
		}> = [];
		let viewChanged = false;
		try {
			for (const source of sources) {
				for (let phase = 0; ; phase++) {
					const result = await read_phase(source, phase, numItems - page.length);
					if (result === null) return folder_changed("The listed folder changed.");
					if (result === "split") {
						return Result({
							_nay: {
								name: "page_unavailable",
								message: "This page is too large to read. Retry with a smaller limit.",
							},
						});
					}
					const done = result.isDone && phase + 1 >= result.phaseCount;
					if (result.frontier || done) {
						batches.push({ rows: result.rows, frontier: result.frontier, done });
						break;
					}
				}
			}
			const current = await get_view();
			if (!current) return folder_changed("The query scope changed.");
			viewChanged =
				current.generation !== view.generation ||
				current.cohortId !== view.cohortId ||
				current.view !== view.view ||
				current.migrationDirection !== view.migrationDirection;
		} catch (error) {
			if (
				!(error instanceof ConvexError) ||
				(error.data?.reason !== "saved_index_view_changed" && error.data?.reason !== "saved_move_view_changed")
			)
				throw error;
			viewChanged = true;
		}
		if (viewChanged) {
			viewChanges++;
			if (viewChanges > 2) {
				return Result({ _nay: { name: "listing_busy", message: "Files changed during this page. Retry it." } });
			}
			continue;
		}
		round++;

		const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
		frontiers.sort((a, b) => compareValues(a, b) * order);
		const windowEnd = frontiers[0] ?? null;
		const rows = batches
			.flatMap((batch) => batch.rows)
			.filter((row) => windowEnd === null || compareValues(row.key, windowEnd) * order <= 0)
			.sort((a, b) => compareValues(a.key, b.key) * order);
		// During a copy one file has a field doc in both sources, with the same value and name. Return
		// it once. The copy of the previous page's last file comes right after it, so skip that one too.
		const seen = new Set<Id<"files_nodes">>(page.map((row) => row.nodeId));
		const unique = rows.filter((row) => {
			if (seen.has(row.nodeId)) return false;
			if (lastItem && row.nodeId === lastItem.nodeId && compareValues(row.key.slice(0, 3), lastItem.key) === 0) {
				return false;
			}
			seen.add(row.nodeId);
			return true;
		});
		const remaining = numItems - page.length;
		const allDone = batches.every((batch) => batch.done);
		// A full page ends at its last row, never at a doc it left out, so its cursor says nothing about
		// a row the caller cannot open.
		if (unique.length > remaining || (unique.length === remaining && !allDone)) {
			page.push(...unique.slice(0, remaining));
			lastKey = page.at(-1)!.key;
			break;
		}
		page.push(...unique);
		isDone = allDone;
		lastKey = windowEnd ?? page.at(-1)?.key ?? lastKey;
		if (isDone) break;
	}

	const [currentMembership, currentRoot] = await Promise.all([
		ctx.runQuery(internal.public_api.get_file_read_membership, {
			organizationId,
			workspaceId,
			userId: visibilityUserId,
		}),
		get_root(),
	]);
	if (
		root?._id !== currentRoot?._id ||
		root?.treePath !== currentRoot?.treePath ||
		root?.restrictedScopeNodeId !== currentRoot?.restrictedScopeNodeId
	) {
		return folder_changed("The listed folder changed.");
	}
	if (JSON.stringify(currentMembership) !== JSON.stringify(membership)) {
		return folder_changed("The query scope changed.");
	}

	const last = page.at(-1);
	if (last) lastItem = { nodeId: last.nodeId, key: last.key.slice(0, 3) };

	return Result({
		_yay: {
			nodeIds: page.map((row) => row.nodeId),
			// `lastKey` can be the key of a doc the caller may not read, so the cursor must hide it.
			cursor: isDone
				? null
				: await crypto_seal_cursor({ purpose: "files_query", scope, payload: { lastKey, lastItem } }),
		},
	});
}

// #endregion folder mode

// #region search mode

const search_cursor_schema = z.object({ valueStoreId: z.string() });

/**
 * The `value_store` value of a search page cursor. `kind` keeps out other stored values.
 */
const search_stored_cursor_schema = z.object({ kind: z.literal("files_query"), cursor: z.string() });

/**
 * One page of a custom-field search under one folder. The node ids come back in the walk's order.
 *
 * Answers `_nay` named `folder_unavailable`, `folder_locked` or `not_a_folder` like folder mode,
 * `invalid_input` for a search the index cannot run, and `listing_busy` when files changed during
 * the first page.
 */
async function read_search_page(ctx: ActionCtx, args: PageArgs & { plan: files_metadata_SearchPlan }) {
	const { organizationId, workspaceId, visibilityUserId, subject, path, plan } = args;
	const start: files_nodes_get_query_search_start_Result = await ctx.runQuery(
		internal.files_nodes.get_query_search_start,
		{ organizationId, workspaceId, subject, plan, folderPath: path },
	);
	if (start.kind === "problem") {
		switch (start.name) {
			case "invalid_plan":
				return Result({
					_nay: {
						name: "invalid_input",
						message: `${plan.fieldPath} cannot be searched with ${plan.op}. Check the field and the match.`,
					},
				});
			case "value_too_long":
				return Result({
					_nay: {
						name: "invalid_input",
						message: `A search value can have at most ${files_metadata_SEARCH_VALUE_MAX_LENGTH} characters.`,
					},
				});
			case "folder_locked":
				return Result({
					_nay: {
						name: "folder_locked",
						// Prefix and range only work at `/`, so for them the fix is root access or another query.
						message:
							path !== "/"
								? `Permission denied: ${path}`
								: plan.op === "prefix" || plan.op === "range"
									? `Permission denied: /. ${ROOT_NEEDED_HINT}`
									: "Permission denied: /. Pass the path of a folder you can open.",
					},
				});
			case "folder_missing":
				return Result({ _nay: { name: "folder_unavailable", message: `Folder not found: ${path}` } });
			case "not_a_folder":
				return Result({ _nay: { name: "not_a_folder", message: `Path must point to a folder: ${path}` } });
		}
	}
	const membership = await get_pinned_membership(ctx, args);
	if (!membership) return Result({ _nay: { name: "folder_locked", message: `Permission denied: ${path}` } });

	// A page of another search view could skip or repeat rows, so the view is in the scope.
	const scope = JSON.stringify([args.cursorScope, membership, start.folderNodeId, start.searchGeneration]);
	let overlayCursor: string | null = null;
	if (args.cursor !== null) {
		const opened = search_cursor_schema.safeParse(
			await crypto_open_cursor({ purpose: "files_query", scope, cursor: args.cursor }),
		);
		if (!opened.success) throw convex_invalid_cursor_error("The query scope changed.");
		// `value_store.get` does not check who owns the value. That is safe here only because the id
		// never leaves the sealed cursor, and the seal opens only for the caller it was made for.
		const value: { value: string } | null = await ctx.runQuery(internal.value_store.get, {
			id: opened.data.valueStoreId,
		});
		let raw: unknown = null;
		try {
			raw = value ? JSON.parse(value.value) : null;
		} catch {
			// Not JSON: not a cursor of this route.
		}
		const stored = search_stored_cursor_schema.safeParse(raw);
		if (!stored.success) throw convex_invalid_cursor_error("The query cursor expired.");
		overlayCursor = stored.data.cursor;
	}

	const result = await files_pending_overlay_list(ctx, {
		organizationId,
		workspaceId,
		visibilityUserId,
		subject,
		folderPath: path,
		mode: "metadata",
		plan,
		order: "asc",
		// `prefix` and `range` read the whole open area by value. Only a caller who can open the
		// workspace root may run them.
		requireRoot: plan.op === "prefix" || plan.op === "range",
		numItems: args.numItems,
		cursor: overlayCursor,
	});
	if (result._nay) {
		if (result._nay.name === "permission_denied") {
			return Result({ _nay: { name: "folder_locked", message: `Permission denied: ${path}. ${ROOT_NEEDED_HINT}` } });
		}
		// The other refusals have no name. With a cursor they mean the listing changed under it.
		if (args.cursor !== null) throw convex_invalid_cursor_error("The query listing changed.");
		return Result({ _nay: { name: "listing_busy", message: "Files changed during this page. Retry it." } });
	}

	// No overlay user, so every row is saved. One row per file per page: an `eq` on a list field can
	// match one file through several list items.
	const nodeIds: Id<"files_nodes">[] = [];
	const seen = new Set<Id<"files_nodes">>();
	for (const item of result._yay.items) {
		if (item.target.kind !== "saved") continue;
		// A metadata search reads no value of a file the caller cannot open, so it returns no locked item.
		if (item.locked) throw should_never_happen("A metadata search returned a locked item", { path: item.path });
		if (seen.has(item.target.id)) continue;
		seen.add(item.target.id);
		nodeIds.push(item.target.id);
	}

	// The walk cursor holds full paths and values and can be longer than the cursor input cap. So
	// keep it in `value_store` and seal only its id.
	let cursor: string | null = null;
	if (result._yay.continueCursor !== null) {
		const valueStoreId: Id<"value_store"> = await ctx.runMutation(internal.value_store.put, {
			value: JSON.stringify({
				kind: "files_query",
				cursor: result._yay.continueCursor,
			} satisfies z.infer<typeof search_stored_cursor_schema>),
			userId: visibilityUserId,
			ttl: SEARCH_CURSOR_TTL_MS,
		});
		cursor = await crypto_seal_cursor({
			purpose: "files_query",
			scope,
			payload: { valueStoreId } satisfies z.infer<typeof search_cursor_schema>,
		});
	}

	return Result({ _yay: { nodeIds, cursor } });
}

// #endregion search mode

const range_bound_validator = z.union([z.number(), z.string()]);

const body_validator = z
	.object({
		mode: z.enum(["folder", "search"]),
		path: z.string().optional(),
		field: z.string(),
		match: z
			.union([
				z.object({ eq: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
				z.object({ prefix: z.string() }).strict(),
				z.object({ exists: z.literal(true) }).strict(),
				z
					.object({
						range: z
							.object({
								gte: range_bound_validator.optional(),
								gt: range_bound_validator.optional(),
								lte: range_bound_validator.optional(),
								lt: range_bound_validator.optional(),
							})
							.strict(),
					})
					.strict(),
			])
			.optional(),
		order: z.enum(["asc", "desc"]).optional(),
		kind: z.enum(["file", "folder"]).optional(),
		fields: z.array(z.string()).optional(),
		limit: z.number().int().min(1).optional(),
		// A real cursor is a few KB at most. The cap stops a huge string before the server decodes it.
		cursor: z.string().max(16384).nullable().optional(),
	})
	.strict();

export type public_api_files_query_http_Body = z.infer<typeof body_validator>;

export async function public_api_files_query_http(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/query";
}) {
	const { ctx, request, path: route } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:read" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_ui", "plugin_run"],
		route,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Authorizing consumed a plugin run's call slot, and a run that ends with a call still open is
	// failed as "Plugin left API calls unfinished". So every branch below settles it, including the
	// successful one. Every error body carries the same stable `errorCode`.
	const fail = async <ErrorCode extends string>(failArgs: {
		status: number;
		message: string;
		errorCode: ErrorCode;
	}) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message, errorCode: failArgs.errorCode };
	};
	const invalid_input = async (message: string) =>
		({ status: 400, body: await fail({ status: 400, message, errorCode: "invalid_input" }) }) as const;
	const permission_denied = async (message: string) =>
		({ status: 403, body: await fail({ status: 403, message, errorCode: "permission_denied" }) }) as const;

	// The list and the file details need both scopes. `requiredScope` above checks one.
	if (!principal.scopes.includes("files:list")) {
		return await permission_denied("Permission denied: this caller needs the files:list scope.");
	}

	const parsed = await server_request_json_parse_and_validate(request, body_validator);
	if (parsed._nay) {
		// `server_request_json_parse_and_validate` names only unknown fields. Name the first bad field too.
		const issue = parsed._nay.cause instanceof z.ZodError ? parsed._nay.cause.issues[0] : undefined;
		if (parsed._nay.message !== "Request body validation failed" || !issue || issue.path.length === 0) {
			return await invalid_input(parsed._nay.message);
		}
		const field = issue.path.map(String).join(".");
		return await invalid_input(
			field.startsWith("match")
				? `Request field "${field}" is not valid. Send match as exactly one of { eq }, { prefix }, { exists: true } or { range }.`
				: `Request field "${field}" is not valid: ${issue.message}.`,
		);
	}
	const body = parsed._yay;

	const requestedPath = server_path_normalize(body.path ?? "/");
	if (!public_api_is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
		return await permission_denied("Permission denied");
	}

	if (!files_search_query_field_path_is_valid(body.field)) {
		return await invalid_input('field must be a qualified field, such as "metadata.status" or "frontmatter.due".');
	}
	const fields = [...new Set(body.fields ?? [])];
	if (fields.length > files_metadata_QUERY_FIELDS_MAX) {
		return await invalid_input(`fields can name at most ${files_metadata_QUERY_FIELDS_MAX} fields.`);
	}
	const badField = fields.find((field) => !files_search_query_field_path_is_valid(field));
	if (badField !== undefined) {
		return await invalid_input(
			`fields has a bad field: ${JSON.stringify(badField)}. Use a qualified field, such as "metadata.status".`,
		);
	}

	const organizationId = principal.organizationId;
	const workspaceId = principal.workspaceId;
	const visibilityUserId = public_api_visibility_user_id(principal);
	const subject = principal.subject;
	const numItems = Math.min(body.limit ?? QUERY_MAX_ITEMS, QUERY_MAX_ITEMS);
	const pageArgs = {
		organizationId,
		workspaceId,
		visibilityUserId,
		subject,
		path: requestedPath,
		numItems,
		cursor: body.cursor ?? null,
	};
	// `fields` only picks the values each item shows, so a caller may change it between pages.
	const cursor_scope = (modeFields: object) =>
		JSON.stringify([principal.principalKey, visibilityUserId, subject, requestedPath, body.field, modeFields]);

	let page: Awaited<ReturnType<typeof read_folder_page>> | Awaited<ReturnType<typeof read_search_page>>;
	try {
		if (body.mode === "folder") {
			// `exists` is what folder mode reads anyway: every child that has the field.
			const match = body.match && "exists" in body.match ? undefined : body.match;
			if (match && "range" in match) {
				return await invalid_input(
					"range works in search mode only. In folder mode, sort by the field and stop paging at your bound.",
				);
			}
			// `eq` keeps its type, because the stored sort key does: the number 850 and the text "850" are
			// two values.
			const folderMatch = !match
				? null
				: "eq" in match
					? { kind: "eq" as const, value: match.eq }
					: { kind: "prefix" as const, value: match.prefix };
			// Only a text value has the limits below. A number or a boolean is its own key.
			if (folderMatch && typeof folderMatch.value === "string") {
				if (folderMatch.value.length < 1 || folderMatch.value.length > files_metadata_SEARCH_VALUE_MAX_LENGTH) {
					return await invalid_input(
						`A match value must have 1 to ${files_metadata_SEARCH_VALUE_MAX_LENGTH} characters.`,
					);
				}
				// Folder mode compares sort keys. A digit run is stored with its length, so a prefix that
				// ends inside a number would not match the longer numbers.
				if (folderMatch.kind === "prefix" && files_table_starts_with_ends_in_digit(folderMatch.value)) {
					return await invalid_input(
						'In folder mode a prefix must not end in a digit. Use match.eq, or add the next character, such as "2026-".',
					);
				}
				// The stored sort key is cut at this length. A value this long could match other values
				// that share its first part.
				if (Array.from(files_sort_text_key(folderMatch.value)).length >= files_sort_TEXT_KEY_MAX_CODE_POINTS) {
					return await invalid_input(
						"This match value is too long for folder mode. Use a shorter value, or search mode.",
					);
				}
			}
			const order = body.order ?? "asc";
			const kind = body.kind ?? "file";
			page = await read_folder_page(ctx, {
				...pageArgs,
				kind,
				field: body.field,
				match: folderMatch,
				order,
				cursorScope: cursor_scope({ mode: "folder", match: folderMatch, order, kind }),
			});
		} else {
			const { match } = body;
			if (body.order !== undefined || body.kind !== undefined) {
				return await invalid_input(
					"order and kind work in folder mode only. Search mode returns files and folders in its own order.",
				);
			}
			if (!match) {
				return await invalid_input("Search mode needs match: eq, prefix, exists or range.");
			}
			let plan: files_metadata_SearchPlan;
			if ("exists" in match) plan = { op: "exists", fieldPath: body.field };
			else if ("eq" in match) plan = { op: "eq", fieldPath: body.field, value: match.eq };
			else if ("prefix" in match) plan = { op: "prefix", fieldPath: body.field, value: match.prefix };
			else {
				const bounds = Object.entries(match.range).flatMap(([comparator, value]) =>
					value === undefined ? [] : [{ comparator: comparator as "gte" | "gt" | "lte" | "lt", value }],
				);
				const isNumber = bounds.every((bound) => typeof bound.value === "number");
				const isDate = bounds.every(
					(bound) => typeof bound.value === "string" && files_metadata_parse_maybe_date(bound.value) !== null,
				);
				if (
					bounds.length === 0 ||
					(!isNumber && !isDate) ||
					(match.range.gte !== undefined && match.range.gt !== undefined) ||
					(match.range.lte !== undefined && match.range.lt !== undefined)
				) {
					return await invalid_input(
						'range needs one lower bound (gte or gt), one upper bound (lte or lt), or both. Use all numbers, or all ISO dates such as "2026-09-30".',
					);
				}
				plan = { op: "range", fieldPath: body.field, valueKind: isNumber ? "number" : "maybe_date" };
				for (const bound of bounds) {
					// A date without a time names a whole UTC day, like the search box: `lte` keeps the
					// whole day and `gt` starts on the next day.
					const range =
						typeof bound.value === "number"
							? { comparator: bound.comparator, bound: bound.value }
							: files_search_query_range_bound({ op: "range", comparator: bound.comparator, value: bound.value });
					if (range === null) throw should_never_happen("A checked range bound did not parse", bound);
					plan[range.comparator] = range.bound;
				}
			}
			if (plan.op === "prefix" || plan.op === "range") {
				if (requestedPath !== "/") {
					return await invalid_input(
						"Prefix and range search the whole workspace. Leave out path, or use folder mode.",
					);
				}
			}
			// A search page runs the same walk as the search box, so it has the same limit per person. The
			// principal bucket above is per person and installation, and would not bound that walk.
			const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_query_search", key: visibilityUserId });
			if (rateLimit) {
				return {
					status: 429,
					body: {
						...(await fail({ status: 429, message: rateLimit.message, errorCode: "rate_limited" })),
						retryAfterMs: rateLimit.retryAfterMs,
					},
				} as const;
			}
			page = await read_search_page(ctx, {
				...pageArgs,
				plan,
				cursorScope: cursor_scope({ mode: "search", match }),
			});
		}
	} catch (error) {
		if (
			!(error instanceof ConvexError) ||
			!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
		)
			throw error;
		// A replaced folder, another caller, a changed request, an expired or edited cursor cannot
		// safely continue.
		return {
			status: 400,
			body: await fail({
				status: 400,
				message: "This query cursor changed. Start a new page.",
				errorCode: "invalid_cursor",
			}),
		} as const;
	}
	if (page._nay) {
		const { message } = page._nay;
		switch (page._nay.name) {
			case "listing_busy":
				return { status: 503, body: await fail({ status: 503, message, errorCode: "listing_busy" }) } as const;
			// `files/search` answers the same case, a page too large to read, with this public code.
			case "page_unavailable":
				return { status: 503, body: await fail({ status: 503, message, errorCode: "search_unavailable" }) } as const;
			// A readable file is 400, not 404: a 404 would tell an agent that the path is free.
			case "not_a_folder":
			case "invalid_input":
				return await invalid_input(message);
			case "folder_locked":
				return await permission_denied(message);
			case "folder_unavailable":
				return { status: 404, body: await fail({ status: 404, message, errorCode: "not_found" }) } as const;
		}
	}

	// Read the item details and the field values in their own queries, a few items each, so every query
	// stays small. Each one checks its items again, and leaves out an item the caller cannot open now.
	const chunks: Id<"files_nodes">[][] = [];
	for (let index = 0; index < page._yay.nodeIds.length; index += files_metadata_QUERY_ITEMS_CHUNK) {
		chunks.push(page._yay.nodeIds.slice(index, index + files_metadata_QUERY_ITEMS_CHUNK));
	}
	const items: files_metadata_get_query_items_Result = (
		await Promise.all(
			chunks.map(
				async (nodeIds): Promise<files_metadata_get_query_items_Result> =>
					await ctx.runQuery(internal.files_metadata.get_query_items, {
						organizationId,
						workspaceId,
						subject,
						nodeIds,
						fields,
					}),
			),
		)
	).flat();

	// Read the upload states in one more query, like `files/list`, so the values queries stay small.
	const assetIds = items.flatMap((item) => (item.kind === "file" && item.assetId ? [item.assetId] : []));
	const assetStates: r2_get_assets_ready_states_Result =
		assetIds.length > 0 ? await ctx.runQuery(internal.r2.get_assets_ready_states, { assetIds }) : {};

	// The reads above take time. Resolve the same bearer again, so a key or a plugin page that lost
	// its rights meanwhile gets no answer.
	const current = await public_api_resolve_live_principal(ctx, {
		presented: auth._yay.presentedToken,
		now: Date.now(),
		requiredScope: "files:read",
	});
	if (current._nay) {
		const { message } = current._nay;
		if (message === "Permission denied") return await permission_denied(message);
		return { status: 401, body: await fail({ status: 401, message, errorCode: "unauthenticated" }) } as const;
	}
	if (!public_api_has_same_authority(principal, current._yay, ["files:read", "files:list"])) {
		return {
			status: 401,
			body: await fail({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" }),
		} as const;
	}

	let callSettled = false;
	if (principal.kind === "plugin_run" && pluginCallId) {
		const checked: public_api_validate_and_finish_scheduled_file_read_Result = await ctx.runMutation(
			internal.public_api.validate_and_finish_scheduled_file_read,
			{
				runId: principal.runId,
				callId: pluginCallId,
				tokenHash: await crypto_sha256_hex(auth._yay.presentedToken),
				route,
				nodes: items.map((item) => ({ nodeId: item.nodeId, path: item.path })),
			},
		);
		if (checked._nay?.name === "locked") return await permission_denied(checked._nay.message);
		if (checked._nay) {
			return {
				status: 404,
				body: await fail({ status: 404, message: "File unavailable", errorCode: "not_found" }),
			} as const;
		}
		callSettled = checked._yay;
	}
	if (!callSettled) {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "succeeded",
			responseStatus: 200,
		});
	}
	console.info("Public API files queried", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		mode: body.mode,
		count: items.length,
		isDone: page._yay.cursor === null,
	});

	return {
		status: 200,
		body: {
			items: items.map((item) => {
				const assetState = item.assetId ? assetStates[item.assetId] : undefined;
				return {
					path: item.path,
					name: item.name,
					nodeId: item.nodeId,
					kind: item.kind,
					contentType: item.contentType,
					updatedAt: item.updatedAt,
					// The same meaning as `files/list`: a file stays pending until its R2 object is confirmed.
					status:
						item.kind === "file" ? (assetState && !assetState.ready ? ("pending" as const) : ("ready" as const)) : null,
					size: assetState ? assetState.size : null,
					readOnly: item.readOnly,
					fields: Object.fromEntries(item.fields.map(({ field, value, isPreview }) => [field, { value, isPreview }])),
				};
			}),
			cursor: page._yay.cursor,
			isDone: page._yay.cursor === null,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}
