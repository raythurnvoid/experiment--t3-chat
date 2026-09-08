import { Result } from "common/errors-as-values-utils.ts";
import { v, type Infer } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalQuery, query, type QueryCtx } from "./_generated/server.js";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { path_tree_prefix_upper_bound, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { ai_chat_skills_LIMITS, ai_chat_skills_catalog, ai_chat_skills_parse } from "../shared/ai-chat-skills.ts";
import { files_get_utf8_byte_size, files_node_has_editable_yjs_state } from "../shared/files.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { file_content_materialization_state_validator, files_merge_contiguous_chunks } from "./files_nodes.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";

export const ai_chat_context_ENABLED = process.env.AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED === "true";

const MAX_SCANNED_NODES = 1000;
const MAX_SOURCE_CHUNKS = 128;
const MAX_YJS_BYTES = 1024 * 1024;
const SKILL_PATH_REGEX = /^\/\.agents\/skills\/[^/]+\/SKILL\.md$/u;
const RESOURCE_PATH_REGEX = /^\/\.agents\/skills\/[^/]+\/.+/u;

const source_validator = v.object({
	nodeId: v.id("files_nodes"),
	path: v.string(),
	version: v.string(),
	size: v.number(),
	status: v.union(v.literal("ready"), v.literal("updating"), v.literal("unavailable"), v.literal("too_large")),
});
export type ai_chat_context_SavedSource = Infer<typeof source_validator>;

async function get_scope(
	ctx: QueryCtx,
	args: { membershipId: Id<"organizations_workspaces_users">; userId: Id<"users"> },
) {
	if (!ai_chat_context_ENABLED) return null;
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) return null;
	const allowed = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership,
		permission: "content.read",
	});
	return allowed._nay ? null : membership;
}

async function get_current_user_id(ctx: QueryCtx) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
	if (!user || user.deletedAt != null) throw convex_error({ message: "Unauthenticated" });
	return user._id;
}

async function get_saved_state(
	ctx: QueryCtx,
	membership: Doc<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
) {
	const node = await ctx.db.get("files_nodes", nodeId);
	if (
		!node ||
		node.organizationId !== membership.organizationId ||
		node.workspaceId !== membership.workspaceId ||
		node.archiveOperationId !== null ||
		node.kind !== "file" ||
		/^\/(?:\.mounts|\.plugins|tmp)(?:\/|$)/u.test(node.path) ||
		(node.name !== "AGENTS.md" && !RESOURCE_PATH_REGEX.test(node.path))
	)
		return null;
	const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
		nodes: [node],
	});
	if (!readable) return null;
	const [asset, snapshot, lastSequence, proposals] = await Promise.all([
		node.assetId ? ctx.db.get("files_r2_assets", node.assetId) : null,
		node.yjsSnapshotId ? ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId) : null,
		node.yjsLastSequenceId ? ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId) : null,
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.take(101),
	]);
	// Eager creates belong to their author until a real saved edit moves the creation stamp.
	if (
		proposals.length > 100 ||
		proposals.some(
			(proposal) =>
				proposal.eagerCreated &&
				(!lastSequence || lastSequence.lastSequence === proposal.eagerCreated.committedSequence),
		)
	)
		return null;
	const maximum = node.name === "AGENTS.md" ? ai_chat_skills_LIMITS.instruction : ai_chat_skills_LIMITS.resource;
	let status: ai_chat_context_SavedSource["status"] = "ready";
	if (
		!asset ||
		!node.textKind ||
		node.contentShapeMismatchAt !== null ||
		node.contentYjsStateTooLargeByteSize !== null ||
		node.contentFrontmatterTooLargeFieldCount !== null ||
		node.contentFrontmatterTooLargeIndexDocumentCount !== null
	)
		status = "unavailable";
	else if (asset.size > maximum || node.contentTooLargeByteSize !== null) status = "too_large";
	else if (lastSequence && snapshot && lastSequence.lastSequence > snapshot.sequence) status = "updating";
	const source: ai_chat_context_SavedSource = {
		nodeId,
		path: node.path,
		size: asset?.size ?? 0,
		status,
		// This token is stored in tool history. It must not reveal the saved path or body.
		// Materialization replaces Yjs assets without changing the saved edit's sequence or lineage.
		version: await crypto_sha256_hex(
			JSON.stringify([
				node._id,
				node.path,
				node.textKind,
				node.collaborationEnabled,
				lastSequence
					? [lastSequence._id, lastSequence.lastSequence, lastSequence.lineageGeneration]
					: node.assetId,
			]),
		),
	};
	return { source, node, asset, snapshot, lastSequence };
}

async function read_saved_chunks(ctx: QueryCtx, state: NonNullable<Awaited<ReturnType<typeof get_saved_state>>>) {
	if (state.source.status !== "ready")
		return Result({ _nay: { name: "unavailable", message: "This source has no current saved text." } });
	const chunks = await ctx.db
		.query("files_text_chunks")
		.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
			q
				.eq("organizationId", state.node.organizationId)
				.eq("workspaceId", state.node.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", state.node._id),
		)
		.take(MAX_SOURCE_CHUNKS + 1);
	if (chunks.length > MAX_SOURCE_CHUNKS)
		return Result({
			_nay: { name: "limit", message: "Shorten this source or reduce its Markdown sections, then save it again." },
		});
	if (chunks.length > 0 && chunks[0].startIndex !== 0)
		return Result({ _nay: { name: "unavailable", message: "This source has no current saved text." } });
	const content = chunks.length ? files_merge_contiguous_chunks(chunks) : state.source.size === 0 ? "" : null;
	return content !== null && files_get_utf8_byte_size(content) === state.source.size
		? Result({ _yay: content })
		: Result({ _nay: { name: "unavailable", message: "This source has no current saved text." } });
}

async function discover(ctx: QueryCtx, membership: Doc<"organizations_workspaces_users">) {
	const instructionNodes = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_archiveOperation_name", (q) =>
			q
				.eq("organizationId", membership.organizationId)
				.eq("workspaceId", membership.workspaceId)
				.eq("archiveOperationId", null)
				.eq("name", "AGENTS.md"),
		)
		.take(MAX_SCANNED_NODES + 1);
	const skillRoot = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", membership.organizationId)
				.eq("workspaceId", membership.workspaceId)
				.eq("path", "/.agents/skills")
				.eq("archiveOperationId", null),
		)
		.first();
	const folders =
		skillRoot?.kind === "folder"
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("parentId", skillRoot._id)
							.eq("archiveOperationId", null),
					)
					.take(MAX_SCANNED_NODES + 1)
			: [];
	if (instructionNodes.length > MAX_SCANNED_NODES || folders.length > MAX_SCANNED_NODES) {
		return Result({ _nay: { name: "limit", message: "There are too many instruction or skill sources to inspect." } });
	}
	const readableFolders = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
		nodes: folders.filter((folder) => folder.kind === "folder"),
	});
	const instructions: ai_chat_context_SavedSource[] = [];
	const skills: ai_chat_context_SavedSource[] = [];
	for (const node of instructionNodes) {
		const state = await get_saved_state(ctx, membership, node._id);
		if (state) instructions.push(state.source);
	}
	instructions.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
	for (const folder of readableFolders) {
		const node = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("parentId", folder._id)
					.eq("name", "SKILL.md")
					.eq("archiveOperationId", null),
			)
			.first();
		if (!node || !SKILL_PATH_REGEX.test(node.path)) continue;
		const state = await get_saved_state(ctx, membership, node._id);
		if (state) skills.push(state.source);
		if (skills.length > ai_chat_skills_LIMITS.discovered) {
			return Result({ _nay: { name: "limit", message: "Keep the workspace catalog at or below 100 skills." } });
		}
	}
	return Result({ _yay: { instructions, skills } });
}

export const discover_sources = internalQuery({
	args: { membershipId: v.id("organizations_workspaces_users"), userId: v.id("users") },
	returns: v_result({ _yay: v.object({ instructions: v.array(source_validator), skills: v.array(source_validator) }) }),
	handler: async (ctx, args) => {
		const membership = await get_scope(ctx, args);
		if (!membership)
			return Result({ _nay: { name: "unavailable", message: "Instructions and skills are unavailable." } });
		return await discover(ctx, membership);
	},
});

export const check_sources = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		sources: v.array(v.object({ nodeId: v.id("files_nodes"), version: v.string() })),
	},
	returns: v_result({ _yay: v.array(source_validator) }),
	handler: async (ctx, args) => {
		const membership = await get_scope(ctx, args);
		if (!membership)
			return Result({ _nay: { name: "unavailable", message: "Instructions and skills are unavailable." } });
		if (
			args.sources.length >
			MAX_SCANNED_NODES + ai_chat_skills_LIMITS.discovered + ai_chat_skills_LIMITS.resourcesPerTurn
		)
			return Result({ _nay: { name: "limit", message: "Too many sources." } });
		const sources: ai_chat_context_SavedSource[] = [];
		for (const source of args.sources) {
			const state = await get_saved_state(ctx, membership, source.nodeId);
			if (state) sources.push(state.source);
		}
		// Saved edits do not replace a body already pinned for this turn. Callers compare versions for new reads.
		return Result({ _yay: sources });
	},
});

export const get_skill_resources = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		skillId: v.id("files_nodes"),
		version: v.string(),
	},
	returns: v_result({ _yay: v.array(source_validator) }),
	handler: async (ctx, args) => {
		const membership = await get_scope(ctx, args);
		const skill = membership ? await get_saved_state(ctx, membership, args.skillId) : null;
		if (!membership || !skill || !SKILL_PATH_REGEX.test(skill.source.path))
			return Result({ _nay: { name: "unavailable", message: "This skill is unavailable." } });
		if (skill.source.version !== args.version)
			return Result({ _nay: { name: "changed", message: "This skill changed. Load it again." } });
		const prefix = skill.source.path.slice(0, -"SKILL.md".length);
		const nodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("archiveOperationId", null)
					.gte("treePath", prefix)
					.lt("treePath", path_tree_prefix_upper_bound(prefix)),
			)
			.take(MAX_SCANNED_NODES + 1);
		if (nodes.length > MAX_SCANNED_NODES)
			return Result({ _nay: { name: "limit", message: "This skill has too many resources to inspect." } });
		const resources: ai_chat_context_SavedSource[] = [];
		for (const node of nodes) {
			if (node._id === args.skillId || node.kind !== "file") continue;
			const state = await get_saved_state(ctx, membership, node._id);
			if (state) resources.push(state.source);
			if (resources.length > ai_chat_skills_LIMITS.resourcesPerSkill)
				return Result({ _nay: { name: "limit", message: "Keep a skill at or below 200 resource files." } });
		}
		return Result({ _yay: resources });
	},
});

export const get_read_state = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		version: v.string(),
		maxBytes: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			source: source_validator,
			content: v.optional(v.string()),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await get_scope(ctx, args);
		const state = membership ? await get_saved_state(ctx, membership, args.nodeId) : null;
		if (!membership || !state || state.source.status === "unavailable")
			return Result({ _nay: { name: "unavailable", message: "This source is unavailable." } });
		if (state.source.version !== args.version)
			return Result({ _nay: { name: "changed", message: "This source changed. Load it again." } });
		if (
			state.source.status === "too_large" ||
			state.source.size > args.maxBytes ||
			args.maxBytes > ai_chat_skills_LIMITS.resource ||
			args.maxBytes < 0
		)
			return Result({ _nay: { name: "too_large", message: "This source exceeds the text limit." } });
		const content = await read_saved_chunks(ctx, state);
		if (!content._nay)
			return Result({ _yay: { source: state.source, content: content._yay, materializationState: null } });
		if (content._nay.name === "limit") return content;
		const { node, asset, snapshot, lastSequence } = state;
		if (
			!asset ||
			!snapshot ||
			!lastSequence ||
			!files_node_has_editable_yjs_state(node) ||
			state.source.status !== "updating"
		)
			return Result({ _nay: { name: "unavailable", message: "This source has no current saved text." } });
		const snapshotAsset = await ctx.db.get("files_r2_assets", snapshot.assetId);
		// Counters bound the query before fetching update docs, each of which can be large.
		if (
			!snapshotAsset ||
			snapshotAsset.size > MAX_YJS_BYTES ||
			lastSequence.unmaterializedUpdateCount > 128 ||
			lastSequence.unmaterializedUpdateBytes > MAX_YJS_BYTES
		)
			return Result({
				_nay: { name: "limit", message: "This source is still updating. Try again after it is saved." },
			});
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("fileNodeId", node._id)
					.gt("sequence", snapshot.sequence)
					.lte("sequence", lastSequence.lastSequence),
			)
			.take(129);
		if (updates.length > 128 || updates.reduce((sum, update) => sum + update.update.byteLength, 0) > MAX_YJS_BYTES)
			return Result({
				_nay: { name: "limit", message: "This source is still updating. Try again after it is saved." },
			});
		return Result({
			_yay: {
				source: state.source,
				materializationState: {
					fileNode: node,
					asset,
					yjsSnapshotDoc: snapshot,
					yjsLastSequenceDoc: lastSequence,
					yjsSnapshotAsset: snapshotAsset,
					yjsUpdatesDocs: updates,
				},
			},
		});
	},
});

type ReadState =
	typeof get_read_state extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const read_source = internalAction({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		version: v.string(),
		maxBytes: v.number(),
	},
	returns: v_result({ _yay: v.object({ source: source_validator, content: v.string() }) }),
	handler: async (
		ctx,
		args,
	): Promise<
		Result<
			{ _yay: { source: ai_chat_context_SavedSource; content: string } } | { _nay: { name: string; message: string } }
		>
	> => {
		const before = (await ctx.runQuery(internal.ai_chat_context.get_read_state, args)) as ReadState;
		if (before._nay) return before;
		let content = "content" in before._yay ? before._yay.content : undefined;
		if (content === undefined && before._yay.materializationState) {
			try {
				const result = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
					state: before._yay.materializationState,
				});
				if (result._nay)
					return Result({ _nay: { name: "unavailable", message: "This source has no readable saved text." } });
				content = result._yay.text;
				result._yay.yjsDoc.destroy();
			} catch {
				return Result({ _nay: { name: "unavailable", message: "This source has no readable saved text." } });
			}
		}
		if (content === undefined)
			return Result({ _nay: { name: "unavailable", message: "This source has no readable saved text." } });
		if (files_get_utf8_byte_size(content) > args.maxBytes)
			return Result({ _nay: { name: "too_large", message: "This source exceeds the text limit." } });
		const after = await ctx.runQuery(internal.ai_chat_context.check_sources, {
			membershipId: args.membershipId,
			userId: args.userId,
			sources: [{ nodeId: args.nodeId, version: args.version }],
		});
		if (after._nay || !after._yay[0])
			return Result({ _nay: { name: "unavailable", message: "This source is no longer available." } });
		if (after._yay[0].version !== args.version)
			return Result({ _nay: { name: "changed", message: "This source changed. Load it again." } });
		return Result({ _yay: { source: before._yay.source, content } });
	},
});

export const get_catalog = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({
			enabled: v.boolean(),
			status: v.union(v.literal("complete"), v.literal("limit")),
			instructions: v.array(
				v.object({
					nodeId: v.id("files_nodes"),
					path: v.string(),
					status: source_validator.fields.status,
					message: v.optional(v.string()),
				}),
			),
			skills: v.array(
				v.object({
					skillId: v.id("files_nodes"),
					path: v.string(),
					name: v.string(),
					description: v.string(),
					compatibility: v.optional(v.string()),
					scriptStatus: v.optional(v.union(v.literal("supported"), v.literal("unsupported"))),
					status: v.union(
						v.literal("available"),
						v.literal("invalid"),
						v.literal("updating"),
						v.literal("unavailable"),
						v.literal("too_large"),
					),
					message: v.optional(v.string()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userId = await get_current_user_id(ctx);
		if (!ai_chat_context_ENABLED) return { enabled: false, status: "complete" as const, instructions: [], skills: [] };
		const membership = await get_scope(ctx, { ...args, userId });
		if (!membership) return null;
		const discovered = await discover(ctx, membership);
		if (discovered._nay) return { enabled: true, status: "limit" as const, instructions: [], skills: [] };
		const instructions = discovered._yay.instructions.map(({ nodeId, path, status }) => ({ nodeId, path, status }));
		const skills: Array<{
			skillId: Id<"files_nodes">;
			path: string;
			name: string;
			description: string;
			compatibility?: string;
			scriptStatus?: "supported" | "unsupported";
			status: "available" | "invalid" | "updating" | "unavailable" | "too_large";
			message?: string;
		}> = [];
		for (const source of discovered._yay.skills) {
			const state = await get_saved_state(ctx, membership, source.nodeId);
			if (!state) continue;
			const entry = { skillId: source.nodeId, path: source.path, name: source.path.split("/").at(-2)!, description: "" };
			if (source.status !== "ready") {
				skills.push({ ...entry, status: source.status, ...(source.status === "updating" ? {} : {
					message: source.status === "too_large" ? "This source exceeds the text limit." : "This source is unavailable.",
				}) });
				continue;
			}
			const content = await read_saved_chunks(ctx, state);
			if (content._nay) {
				skills.push({
					...entry,
					status: content._nay.name === "limit" ? "too_large" : "unavailable",
					message: content._nay.message,
				});
				continue;
			}
			const parsed = ai_chat_skills_parse(content._yay, entry.name);
			if (parsed._nay) {
				skills.push({
					...entry,
					status: parsed._nay.name === "too_large" ? "too_large" : "invalid",
					message: parsed._nay.message,
				});
				continue;
			}
			const runtime = parsed._yay.metadata?.["bonobo-script-runtime"];
			const scriptStatus = runtime === undefined ? undefined : runtime === "worker-async-body-v1" ? "supported" : "unsupported";
			skills.push({
				...entry,
				name: parsed._yay.name,
				description: parsed._yay.description,
				...(parsed._yay.compatibility !== undefined ? { compatibility: parsed._yay.compatibility } : {}),
				...(scriptStatus !== undefined ? { scriptStatus } : {}),
				// Unsupported scripts do not block the skill's instructions.
				status: "available",
			});
		}
		if (ai_chat_skills_catalog(skills).bytes > ai_chat_skills_LIMITS.catalog)
			return { enabled: true, status: "limit" as const, instructions, skills: [] };
		return { enabled: true, status: "complete" as const, instructions, skills };
	},
});

export const get_source = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.string() },
	returns: v.union(v.null(), v.object({ nodeId: v.id("files_nodes"), path: v.string(), name: v.string() })),
	handler: async (ctx, args) => {
		const userId = await get_current_user_id(ctx);
		const membership = await get_scope(ctx, { membershipId: args.membershipId, userId });
		// Failed model calls can leave a made-up id in otherwise valid tool history.
		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		const state = membership && nodeId ? await get_saved_state(ctx, membership, nodeId) : null;
		return state ? { nodeId: state.node._id, path: state.node.path, name: state.node.name } : null;
	},
});
