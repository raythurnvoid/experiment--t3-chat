import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator, files_type_query_item_validator } from "./schema.ts";
import { files_db_authorize_file_read } from "./files_volume_access.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import { files_db_get_path_access, files_db_get_pending_update, files_db_get_visible_node_by_path } from "../server/files.ts";
import { files_access_version_db_get } from "../server/files-access-version.ts";
import {
	files_pending_review_facts_db_pin_structure,
	files_pending_review_facts_db_get_state,
} from "../server/files-pending-review-facts.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_search_generation,
	files_saved_placement_db_get_view,
} from "../server/files-saved-placement.ts";
import {
	files_type_query_db_consume,
	files_type_query_db_delete_batch,
	files_type_query_db_fill_stream,
	files_type_query_db_get_readiness,
	files_type_query_db_open_stream,
	files_type_query_db_work,
	files_type_query_request_matches,
} from "../server/files-type-query.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import {
	files_content_type_index_fields,
	files_parse_content_type_prefix,
	type files_VisibleEntry,
} from "../shared/files.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";

const request_args = {
	organizationId: doc(app_convex_schema, "files_type_queries").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_type_queries").fields.workspaceId,
	userId: v.id("users"),
	agentSource: v.optional(ai_chat_workspaces_source_validator),
	pluginReviewRoot: v.optional(v.string()),
	overlay: v.boolean(),
	rootPath: v.string(),
	contentType: v.string(),
	directoriesOnly: v.boolean(),
	limit: v.number(),
};
export const files_type_queries_request_validator = v.object(request_args);
export type files_type_queries_Request = Infer<typeof files_type_queries_request_validator>;
const page_validator = v.object({
	queryId: v.id("files_type_queries"),
	step: v.number(),
	state: v.union(v.literal("preparing"), v.literal("working"), v.literal("page")),
	items: v.array(files_type_query_item_validator),
	isDone: v.boolean(),
});
type Page = Infer<typeof page_validator>;
export type files_type_queries_PageResult =
	| {
			_yay: Omit<Page, "items"> & { items: ReadonlyArray<Infer<typeof files_type_query_item_validator>> };
			_nay?: undefined;
	  }
	| { _nay: { message: string; name?: string }; _yay?: undefined };
type Query = Doc<"files_type_queries">;
const TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 30_000;

function changed() {
	return Result({ _nay: { message: "The file search changed. Rerun find without --cursor." } });
}

function content_type(entry: files_VisibleEntry) {
	if (entry.kind === "saved") return entry.pendingUpdate?.pendingReplacement?.contentType ?? entry.node.contentType;
	const intent = entry.pendingUpdate.createIntent;
	return intent && intent.kind !== "folder" ? intent.contentType : null;
}

function matches(query: Query, contentType: string | null) {
	const type = files_parse_content_type_prefix(query.contentType)!;
	return files_content_type_index_fields(contentType)[type.field] === type.value;
}

function owner_scope(ctx: QueryCtx | MutationCtx, query: Pick<Query, "organizationId" | "workspaceId" | "userId">) {
	const organizationId = ctx.db.normalizeId("organizations", query.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", query.workspaceId);
	return organizationId && workspaceId ? { organizationId, workspaceId, userId: query.userId } : null;
}

export async function files_type_queries_db_authorize(
	ctx: QueryCtx | MutationCtx,
	query: Pick<Query, "organizationId" | "workspaceId" | "userId" | "agentSource" | "pluginReviewRoot" | "rootPath">,
) {
	const user = await ctx.db.get("users", query.userId);
	if (!user || user.deletedAt !== undefined) return false;
	// Review commands have no chat or installation. The host pins their only source tree.
	if (query.pluginReviewRoot !== undefined) {
		const rootPath = server_path_normalize(query.rootPath);
		if (
			query.agentSource !== undefined ||
			query.organizationId !== organizations_GLOBAL_ORGANIZATION_ID ||
			query.workspaceId !== organizations_GLOBAL_PLUGINS_WORKSPACE_ID ||
			!/^\/review-[a-f0-9]{32}$/u.test(query.pluginReviewRoot) ||
			(rootPath !== query.pluginReviewRoot && !rootPath.startsWith(`${query.pluginReviewRoot}/`))
		)
			return false;
		const root = await files_db_get_visible_node_by_path(ctx, { ...query, path: query.pluginReviewRoot });
		return root?.kind === "folder";
	}
	const scope = owner_scope(ctx, query);
	if (scope) {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", scope.userId)
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("active", true),
			)
			.first();
		if (!membership) return false;
	}
	const fileScope = files_db_resolve_scope(ctx, query.workspaceId);
	if (fileScope.kind === "reserved" && query.organizationId !== organizations_GLOBAL_ORGANIZATION_ID) return false;
	const allowed =
		fileScope.kind === "reserved"
			? query.agentSource?.userId === query.userId
				? await ai_chat_workspaces_db_resolve(ctx, { source: query.agentSource, workspace: "current" })
				: null
			: await files_db_authorize_file_read(ctx, query);
	if (!allowed || allowed._nay) return false;
	if (scope) return true;
	// Mounted trees are immutable, but cleanup can remove an old version between search slices.
	const parts = server_path_normalize(query.rootPath).split("/");
	if (fileScope.kind === "volume") {
		const generationId = ctx.db.normalizeId("plugins_volume_generations", parts[1] ?? "");
		const generation = generationId ? await ctx.db.get("plugins_volume_generations", generationId) : null;
		return (
			generation !== null &&
			generation.organizationId === query.organizationId &&
			generation.volumeId === fileScope.volumeId &&
			generation.publishedAt !== null &&
			(generation.status === "published" ||
				(generation.status === "retired" && (generation.expiresAt ?? 0) > Date.now()))
		);
	}
	if (query.workspaceId === organizations_GLOBAL_GITHUB_WORKSPACE_ID) {
		const mount = await ctx.db
			.query("github_mounts")
			.withIndex("by_name", (q) => q.eq("name", parts[1] ?? ""))
			.first();
		return mount !== null && mount.lastCommitSha !== null && mount.lastCommitSha === parts[2];
	}
	if (query.workspaceId === organizations_GLOBAL_PLUGINS_WORKSPACE_ID) {
		const versionId = ctx.db.normalizeId("plugins_versions", parts[1] ?? "");
		const version = versionId ? await ctx.db.get("plugins_versions", versionId) : null;
		if (version?.sourceStatus !== "ready") return false;
		const source = query.agentSource!;
		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginVersion", (q) =>
				q
					.eq("organizationId", source.organizationId)
					.eq("workspaceId", source.workspaceId)
					.eq("pluginVersionId", version._id),
			)
			.first();
		if (installation?.status !== "enabled") return false;
		const deletion = await ctx.db
			.query("plugins_registry_deletion_fences")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", version.name))
			.first();
		return deletion === null;
	}
	return false;
}

async function db_pin(ctx: MutationCtx, query: Query) {
	const scope = owner_scope(ctx, query);
	const view = await files_saved_placement_db_get_view(ctx.db, query);
	if (!scope) return { pin: JSON.stringify([view, query.agentSource ?? null]), view, preparing: false };
	const structure = await files_pending_review_facts_db_pin_structure(ctx.db, scope);
	const structureState = await files_pending_review_facts_db_get_state(ctx.db, scope);
	const pending = query.overlay
		? await ctx.db
				.query("files_pending_review_versions")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
				)
				.first()
		: null;
	const content = await ctx.db
		.query("files_content_versions")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.first();
	const access = await files_access_version_db_get(ctx.db, scope);
	const search = await files_saved_placement_db_get_search_generation(ctx.db, scope);
	return {
		pin: JSON.stringify([
			view,
			structureState?._id ?? null,
			structure.structureRevision,
			pending?._id ?? null,
			pending?.revision ?? 0,
			content?._id ?? null,
			content?.revision ?? 0,
			access,
			search,
		]),
		view,
		preparing: query.overlay && (await files_type_query_db_get_readiness(ctx.db, scope)).state === "updating",
	};
}

async function db_replay(ctx: MutationCtx, query: Query, step: Doc<"files_type_query_steps">) {
	const current = await db_pin(ctx, query);
	if (!(await files_type_queries_db_authorize(ctx, query)) || current.preparing || query.pin !== current.pin)
		return changed();
	const scope = owner_scope(ctx, query);
	// Candidate access stays proved while the exact access pin and live source authority still match.
	// A saved type may change without its path changing. Replay must not return that old match.
	for (const item of step.items) {
		if (item.target.kind !== "saved") continue;
		const node = await files_saved_placement_db_get_node(ctx.db, item.target.id);
		if (
			!node ||
			node.organizationId !== query.organizationId ||
			node.workspaceId !== query.workspaceId ||
			node.archiveOperationId !== null ||
			node.kind !== "file" ||
			((!query.overlay || !scope) && node.path !== item.path)
		)
			return changed();
		const proposal =
			query.overlay && scope ? await files_db_get_pending_update(ctx, { ...scope, target: item.target }) : null;
		const selected = proposal ? await files_saved_placement_db_get_proposal(ctx.db, proposal._id) : null;
		if (!matches(query, selected?.pendingReplacement?.contentType ?? node.contentType)) return changed();
	}
	return Result({
		_yay: { queryId: query._id, step: step.step + 1, state: "page" as const, items: step.items, isDone: step.isDone },
	});
}

export const begin = internalMutation({
	args: request_args,
	returns: v_result({ _yay: v.object({ queryId: v.id("files_type_queries"), step: v.number() }) }),
	handler: async (ctx, args) => {
		if (
			!files_parse_content_type_prefix(args.contentType) ||
			!Number.isInteger(args.limit) ||
			args.limit < 1 ||
			args.limit > 50
		)
			return Result({ _nay: { message: "Invalid file search options" } });
		if (!(await files_type_queries_db_authorize(ctx, args)))
			return Result({ _nay: { message: "File search unavailable" } });
		const queryId = await ctx.db.insert("files_type_queries", {
			...args,
			// A later call may resume this query. Its own run is checked at the caller boundary.
			agentSource: args.agentSource ? { ...args.agentSource, run: null } : undefined,
			rootPath: server_path_normalize(args.rootPath),
			contentType: args.contentType.trim().toLowerCase(),
			expiresAt: Date.now() + TTL_MS,
			state: "preparing",
			root: null,
			pin: null,
			resolverGeneration: 0,
			step: 0,
			lease: null,
		});
		return Result({ _yay: { queryId, step: 0 } });
	},
});

/**
 * Advance one durable slice. Every source position and its effect commit together.
 */
export const advance = internalMutation({
	args: {
		...request_args,
		queryId: v.id("files_type_queries"),
		step: v.number(),
		token: v.string(),
		seal: v.boolean(),
	},
	returns: v_result({ _yay: page_validator }),
	handler: async (ctx, args): Promise<files_type_queries_PageResult> => {
		const query = await ctx.db.get("files_type_queries", args.queryId);
		if (!query || !files_type_query_request_matches(query, args)) return changed();
		if (query.state === "canceled") return Result({ _nay: { message: "File search was stopped" } });
		if (query.expiresAt <= Date.now())
			return Result({ _nay: { message: "File search expired. Rerun find without --cursor." } });
		if (!(await files_type_queries_db_authorize(ctx, args)) || !(await files_type_queries_db_authorize(ctx, query)))
			return Result({ _nay: { message: "File search unavailable" } });
		let stored = await ctx.db
			.query("files_type_query_steps")
			.withIndex("by_query_step", (q) => q.eq("queryId", query._id).eq("step", args.step))
			.first();
		if (stored?.sealed) return await db_replay(ctx, query, stored);
		if (query.state === "done") return changed();
		if (args.step !== query.step) return changed();
		const response = (state: Page["state"]) =>
			Result({ _yay: { queryId: query._id, step: query.step, state, items: [], isDone: false } });
		if (query.lease && query.lease.token !== args.token && query.lease.until > Date.now()) return response("working");
		await ctx.db.patch("files_type_queries", query._id, { lease: { token: args.token, until: Date.now() + LEASE_MS } });
		const current = await db_pin(ctx, query);
		if (query.pin !== null && query.pin !== current.pin && query.state !== "preparing") return changed();
		if (current.preparing) return response("preparing");
		const scope = owner_scope(ctx, query);
		// A preparation cursor can join newer source work before its first page.
		const generation = query.resolverGeneration + (query.pin !== null && query.pin !== current.pin ? 1 : 0);
		const reader = scope
			? await files_visible_db_create_reader(ctx, {
					...scope,
					pending: query.overlay,
					resume: { store: files_type_query_db_work(ctx.db, query._id, generation), fence: current.pin },
				})
			: null;
		if (query.pin !== current.pin)
			await ctx.db.patch("files_type_queries", query._id, { pin: current.pin, resolverGeneration: generation });
		if (query.root === null) {
			const resolved = query.rootPath === "/" ? null : reader ? await reader.resumePath(query.rootPath) : null;
			if (resolved?.status === "unfinished") return response("preparing");
			if (resolved?.status === "invalidated") return changed();
			const entry = resolved?.status === "resolved" ? resolved.value.entry : null;
			const saved =
				!reader && query.rootPath !== "/"
					? await files_db_get_visible_node_by_path(ctx, { ...query, path: query.rootPath })
					: null;
			const permissionDenied = { name: "permission_denied", message: "Permission denied" };
			if (query.rootPath !== "/" && !entry && !saved) {
				// A missing name below a locked folder answers like the folder, so the name does not leak.
				const access = scope
					? await files_db_get_path_access(ctx, {
							...scope,
							subject: { kind: "user", userId: query.userId, plugin: null },
							path: query.rootPath,
						})
					: null;
				return Result({
					_nay: access?.status === "locked" ? permissionDenied : { message: "File or folder not found" },
				});
			}
			// A root the reader cannot open is locked, not missing.
			if (
				reader &&
				!(await reader.canRead(
					entry?.kind === "saved" ? entry.node : resolved?.status === "resolved" ? resolved.value.accessNode : null,
				))
			)
				return Result({ _nay: permissionDenied });
			const root =
				entry?.kind === "saved"
					? { kind: "saved" as const, id: entry.node._id }
					: entry?.kind === "private"
						? { kind: "private" as const, id: entry.node._id }
						: saved
							? { kind: "saved" as const, id: saved._id }
							: { kind: "root" as const };
			const prefix = query.rootPath === "/" ? "/" : `${query.rootPath}/`;
			const isFile = (entry?.node.kind ?? saved?.kind) === "file";
			await ctx.db.patch("files_type_queries", query._id, { root, state: "running" });
			const items: Infer<typeof files_type_query_item_validator>[] = [];
			const mime = entry ? content_type(entry) : (saved?.contentType ?? null);
			if (isFile && !query.directoriesOnly && matches(query, mime) && root.kind !== "root")
				items.push({ target: root, path: query.rootPath, contentType: mime });
			await ctx.db.insert("files_type_query_steps", {
				queryId: query._id,
				step: query.step,
				items,
				sealed: false,
				isDone: isFile || query.directoriesOnly,
			});
			if (!isFile && !query.directoriesOnly) {
				await files_type_query_db_open_stream(ctx.db, {
					queryId: query._id,
					kind: "saved",
					moveTargetId: null,
					savedPrefix: prefix,
					ownerPrefix: prefix,
				});
				if (reader && query.overlay) {
					await files_type_query_db_open_stream(ctx.db, {
						queryId: query._id,
						kind: "content",
						moveTargetId: null,
						savedPrefix: prefix,
						ownerPrefix: prefix,
					});
					await files_type_query_db_open_stream(ctx.db, {
						queryId: query._id,
						kind: "move",
						moveTargetId: null,
						savedPrefix: prefix,
						ownerPrefix: prefix,
					});
					if (entry?.kind === "saved" && resolved?.status === "resolved" && resolved.value.appliedMoveTarget) {
						await files_type_query_db_open_stream(ctx.db, {
							queryId: query._id,
							kind: "saved",
							moveTargetId: resolved.value.appliedMoveTarget.id,
							savedPrefix: `${entry.node.path}/`,
							ownerPrefix: prefix,
						});
					}
				}
			}
			return response("working");
		}
		if (!stored) {
			const stepId = await ctx.db.insert("files_type_query_steps", {
				queryId: query._id,
				step: query.step,
				items: [],
				sealed: false,
				isDone: false,
			});
			stored = await ctx.db.get("files_type_query_steps", stepId);
		}
		const step = stored!;
		const stream = await ctx.db
			.query("files_type_query_streams")
			.withIndex("by_query_done_lower", (q) => q.eq("queryId", query._id).eq("done", false))
			.first();
		if (args.seal || step.items.length >= query.limit || !stream || step.isDone) {
			const final = await db_pin(ctx, query);
			if (final.preparing || final.pin !== current.pin) return changed();
			const isDone = step.isDone || stream === null;
			await ctx.db.patch("files_type_query_steps", step._id, { sealed: true, isDone });
			await ctx.db.patch("files_type_queries", query._id, {
				step: query.step + 1,
				lease: null,
				state: isDone ? "done" : "running",
			});
			return await db_replay(ctx, { ...query, pin: current.pin }, { ...step, sealed: true, isDone });
		}
		if (stream.buffer.length === 0) {
			await files_type_query_db_fill_stream(ctx.db, query, stream, current.view);
			return response("working");
		}
		const candidate = stream.buffer[0]!;
		const resolved = reader ? await reader.resumeTarget(candidate.key.target) : null;
		if (resolved?.status === "unfinished") return response("working");
		if (resolved?.status === "invalidated") return changed();
		let entry = resolved?.status === "resolved" ? resolved.value.entry : null;
		if (!reader && candidate.key.target.kind === "saved") {
			const node = await files_saved_placement_db_get_node(ctx.db, candidate.key.target.id);
			if (
				node &&
				node.organizationId === query.organizationId &&
				node.workspaceId === query.workspaceId &&
				node.archiveOperationId === null
			)
				entry = { kind: "saved", node, path: node.path, pendingUpdate: null };
		}
		if (
			entry &&
			entry.path === candidate.key.path.replace(/\/$/u, "") &&
			(resolved?.status !== "resolved" || !resolved.value.hidden)
		) {
			const explicit = entry.kind === "private" || entry.pendingUpdate?.pendingReplacement !== undefined;
			const moveId = resolved?.status === "resolved" ? (resolved.value.appliedMoveTarget?.id ?? null) : null;
			if (
				stream.kind === "move" &&
				entry.kind === "saved" &&
				resolved?.status === "resolved" &&
				resolved.value.moveApplied &&
				!explicit
			) {
				if (entry.node.kind === "folder")
					await files_type_query_db_open_stream(ctx.db, {
						queryId: query._id,
						kind: "saved",
						moveTargetId: entry.node._id,
						savedPrefix: `${entry.node.path}/`,
						ownerPrefix: `${entry.path}/`,
					});
				else if (matches(query, content_type(entry)))
					await ctx.db.patch("files_type_query_steps", step._id, {
						items: [
							...step.items,
							{ target: candidate.key.target, path: entry.path, contentType: content_type(entry) },
						],
					});
			} else if (
				entry.node.kind === "file" &&
				matches(query, content_type(entry)) &&
				((stream.kind === "content" && explicit) ||
					(stream.kind === "saved" && !explicit && moveId === stream.moveTargetId))
			) {
				await ctx.db.patch("files_type_query_steps", step._id, {
					items: [...step.items, { target: candidate.key.target, path: entry.path, contentType: content_type(entry) }],
				});
			}
		}
		await files_type_query_db_consume(ctx.db, stream);
		return response("working");
	},
});

export const release = internalMutation({
	args: { queryId: v.id("files_type_queries"), token: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const query = await ctx.db.get("files_type_queries", args.queryId);
		if (query?.lease?.token === args.token) await ctx.db.patch("files_type_queries", query._id, { lease: null });
		return null;
	},
});

// Trusted command setup and the claimed worker read this header. Advance checks live authority.
export const get = internalQuery({
	args: { queryId: v.string() },
	returns: v.union(doc(app_convex_schema, "files_type_queries"), v.null()),
	handler: async (ctx, args) => {
		const queryId = ctx.db.normalizeId("files_type_queries", args.queryId);
		return queryId ? await ctx.db.get("files_type_queries", queryId) : null;
	},
});

export const cleanup_expired = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const query = await ctx.db
			.query("files_type_queries")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
			.first();
		if (query) {
			await files_type_query_db_delete_batch(ctx.db, query._id, 50);
			await ctx.scheduler.runAfter(0, internal.files_type_queries.cleanup_expired, {});
		}
		return null;
	},
});
