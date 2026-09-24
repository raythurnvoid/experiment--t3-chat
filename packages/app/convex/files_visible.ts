import { paginationOptsValidator, type RegisteredQuery } from "convex/server";
import { compareValues, v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import app_convex_schema, {
	files_pending_target_validator,
	files_pending_parent_validator,
	ai_chat_workspaces_source_validator,
} from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { files_db_get_visible_node_by_path } from "../server/files.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous, server_path_normalize } from "../server/server-utils.ts";
import type { files_PendingTarget, files_PendingParent, files_VisibleEntry } from "../shared/files.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { path_name_of } from "../shared/paths.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const listing_args = {
	folderPath: v.string(),
	mode: v.union(v.literal("children"), v.literal("subtree"), v.literal("recent")),
	numItems: v.number(),
	cursor: paginationOptsValidator.fields.cursor,
	order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	kind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
	lowercaseExtension: v.optional(v.string()),
	contentTypePrefixes: v.optional(v.array(v.string())),
	minDepth: v.optional(v.number()),
	maxDepth: v.optional(v.number()),
	pathQuery: v.optional(v.string()),
	orderBy: v.optional(v.union(v.literal("name"), v.literal("updatedAt"))),
};

const internal_listing_args = v.object({
	...listing_args,
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	visibilityUserId: v.id("users"),
	serviceAccountId: v.optional(v.id("access_control_service_accounts")),
	overlayUserId: v.optional(v.id("users")),
	// Transfer discovery must refuse an incomplete folder instead of hiding unreadable children.
	requireComplete: v.optional(v.boolean()),
});

/**
 * Reuse parent and permission reads within one query, leaving room for its own work.
 */
export async function files_visible_db_create_reader(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		readLimit?: number;
		/** Review preparation may read children before applying these exact parent deletes. */
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
	},
) {
	const budget = { exhausted: false, readCount: 0 };

	async function read<T>(run: () => Promise<T>): Promise<T | null> {
		if (budget.readCount >= (args.readLimit ?? 512)) {
			budget.exhausted = true;
			return null;
		}
		budget.readCount++;
		return await run();
	}

	const membership = await read(() =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.first(),
	);

	const readableByScope = new Map<string, Promise<boolean>>();
	async function can_read(node: Doc<"files_nodes"> | null) {
		if (!membership) return false;
		const key = node?.restrictedScopeNodeId ?? "workspace";
		let readable = readableByScope.get(key);
		if (!readable) {
			readable = access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.read",
				fileNode: node ?? undefined,
			}).then((result) => !result._nay);
			readableByScope.set(key, readable);
		}
		return await readable;
	}

	async function find_saved_move(parent: files_PendingParent, name: string) {
		const moves = ctx.db.query("files_pending_updates").withIndex("by_user_pendingMove_destParent_destName", (q) =>
			q
				.eq("userId", args.userId)
				.eq("pendingMove.destParent.kind", parent.kind)
				.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id)
				.eq("pendingMove.destName", name),
		);
		const iterator = moves[Symbol.asyncIterator]();
		try {
			while (true) {
				const next = await read(() => iterator.next());
				if (!next || next.done) return null;
				// Root claims share this index across workspaces. Private claims use the active-node
				// index because discarded proposals can remain until cleanup.
				if (
					next.value.organizationId === args.organizationId &&
					next.value.workspaceId === args.workspaceId &&
					next.value.target.kind === "saved"
				)
					return next.value;
			}
		} finally {
			await iterator.return?.();
		}
	}

	const resolving = new Set<string>();
	const resolved = new Map<string, { entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null } | null>();

	async function resolve_parent(
		parent: files_PendingParent,
	): Promise<{ path: string; accessNode: Doc<"files_nodes"> | null } | null> {
		if (parent.kind === "root") return { path: "", accessNode: null };
		if (parent.kind === "private") {
			const node = await read(() => ctx.db.get("files_pending_nodes", parent.id));
			if (
				node?.state === "published" &&
				node.userId === args.userId &&
				node.organizationId === args.organizationId &&
				node.workspaceId === args.workspaceId
			) {
				const receipt = await read(() =>
					ctx.db
						.query("files_pending_node_publish_receipts")
						.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parent.id))
						.unique(),
				);
				if (!receipt) return null;
				return await resolve_parent({ kind: "saved", id: receipt.savedNodeId });
			}
		}

		const result = await resolve(parent);
		if (!result || result.entry.node.kind !== "folder") return null;
		return { path: result.entry.path, accessNode: result.accessNode };
	}

	async function resolve(
		target: files_PendingTarget,
	): Promise<{ entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null } | null> {
		const key = `${target.kind}:${target.id}`;
		if (resolved.has(key)) return resolved.get(key)!;
		if (resolving.has(key) || resolving.size >= 256) return null;
		resolving.add(key);

		const pending = await read(() =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", args.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.unique(),
		);

		let result: { entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null } | null = null;
		if (!pending?.pendingArchive || args.reviewedArchiveIds?.has(pending._id)) {
			if (target.kind === "private") {
				const node = await read(() => ctx.db.get("files_pending_nodes", target.id));
				if (
					node &&
					pending &&
					node.state === "active" &&
					node.userId === args.userId &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const parent = await resolve_parent(node.parent);
					if (parent)
						result = {
							entry: { kind: "private", node, pendingUpdate: pending, path: `${parent.path}/${node.name}` },
							accessNode: parent.accessNode,
						};
				}
			} else {
				const node = await read(() => ctx.db.get("files_nodes", target.id));
				if (
					node &&
					node.archiveOperationId === null &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const parentTarget: files_PendingParent =
						node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
					const movedParent = pending?.pendingMove ? await resolve_parent(pending.pendingMove.destParent) : null;
					const parent = movedParent ?? (await resolve_parent(parentTarget));
					if (parent) {
						const name = movedParent && pending?.pendingMove ? pending.pendingMove.destName : node.name;
						result = {
							entry: { kind: "saved", node, pendingUpdate: pending, path: `${parent.path}/${name}` },
							accessNode: node,
						};

						if (!movedParent) {
							const parents: files_PendingParent[] = [parentTarget];
							if (parentTarget.kind === "saved") {
								const receipt = await read(() =>
									ctx.db
										.query("files_pending_node_publish_receipts")
										.withIndex("by_savedNode", (q) => q.eq("savedNodeId", parentTarget.id))
										.unique(),
								);
								if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
							}

							for (const parent of parents) {
								const privateClaim = await read(() =>
									ctx.db
										.query("files_pending_nodes")
										.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
											q
												.eq("organizationId", args.organizationId)
												.eq("workspaceId", args.workspaceId)
												.eq("userId", args.userId)
												.eq("parent.kind", parent.kind)
												.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
												.eq("state", "active")
												.eq("name", node.name),
										)
										.first(),
								);
								if (privateClaim) {
									result = null;
									break;
								}

								const moveClaim = await find_saved_move(parent, node.name);
								if (moveClaim && moveClaim.target.id !== target.id && !moveClaim.pendingArchive) {
									const claimantTarget = moveClaim.target;
									const claimant =
										claimantTarget.kind === "saved"
											? await read(() => ctx.db.get("files_nodes", claimantTarget.id))
											: null;
									if (claimant?.archiveOperationId === null) {
										result = null;
										break;
									}
								}
							}
						}
					}
				}
			}
		}

		resolving.delete(key);
		resolved.set(key, result);
		return result;
	}

	async function parent_aliases(parent: files_PendingParent) {
		const parents = [parent];
		if (parent.kind === "saved") {
			const receipt = await read(() =>
				ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_savedNode", (q) => q.eq("savedNodeId", parent.id))
					.unique(),
			);
			if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
		}
		return parents;
	}

	async function find_path(path: string) {
		const segments = server_path_normalize(path).split("/").filter(Boolean);
		let parent: files_PendingParent = { kind: "root" };
		let current: Awaited<ReturnType<typeof resolve>> = null;

		for (let index = 0; index < segments.length; index++) {
			const name = segments[index]!;

			const candidates = new Map<string, files_PendingTarget>();
			if (parent.kind !== "private") {
				const parentId = parent.kind === "root" ? "root" : parent.id;
				const saved = await read(() =>
					ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", parentId)
								.eq("archiveOperationId", null)
								.eq("name", name),
						)
						.first(),
				);
				if (saved) candidates.set(saved._id, { kind: "saved", id: saved._id });
			}

			for (const alias of await parent_aliases(parent)) {
				const privateNode = await read(() =>
					ctx.db
						.query("files_pending_nodes")
						.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("userId", args.userId)
								.eq("parent.kind", alias.kind)
								.eq("parent.id", alias.kind === "root" ? undefined : alias.id)
								.eq("state", "active")
								.eq("name", name),
						)
						.first(),
				);
				if (privateNode) candidates.set(privateNode._id, { kind: "private", id: privateNode._id });
				const move = await find_saved_move(alias, name);
				if (move) candidates.set(move.target.id, move.target);
			}

			current = null;
			const expectedPath = `/${segments.slice(0, index + 1).join("/")}`;

			for (const target of candidates.values()) {
				const result = await resolve(target);
				if (result?.entry.path !== expectedPath) continue;
				if (current) return null;
				current = result;
			}

			if (!current || (index < segments.length - 1 && current.entry.node.kind !== "folder")) return null;
			parent =
				current.entry.kind === "saved"
					? { kind: "saved", id: current.entry.node._id }
					: { kind: "private", id: current.entry.node._id };
		}

		return current;
	}

	return {
		active: membership !== null,
		get exhausted() {
			return budget.exhausted;
		},
		read,
		resolve,
		findPath: find_path,
		parentAliases: parent_aliases,
		canRead: can_read,
		async resolveTarget(target: files_PendingTarget) {
			if (!membership) return null;
			const result = await resolve(target);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
		},
		async resolvePath(path: string) {
			if (!membership) return null;
			const result = await find_path(path);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
		},
	};
}

const entry_validator = v.object({
	target: files_pending_target_validator,
	path: v.string(),
	name: v.string(),
	kind: doc(app_convex_schema, "files_nodes").fields.kind,
	updatedAt: v.number(),
	updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
	contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
	preparing: v.boolean(),
});

const listing_result = v_result({
	_yay: v.object({
		items: v.array(entry_validator),
		continueCursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
	}),
});

async function db_list(ctx: QueryCtx, args: Infer<typeof internal_listing_args>) {
	const folderPath = server_path_normalize(args.folderPath);
	const limit = Math.max(1, Math.min(50, Math.floor(args.numItems)));

	const ownerScope =
		args.overlayUserId === args.visibilityUserId &&
		args.serviceAccountId === undefined &&
		!organizations_is_global_organization_id(args.organizationId) &&
		!organizations_is_reserved_workspace_id(args.workspaceId);

	const reader = ownerScope
		? await files_visible_db_create_reader(ctx, {
				organizationId: args.organizationId as Id<"organizations">,
				workspaceId: args.workspaceId as Id<"organizations_workspaces">,
				userId: args.visibilityUserId,
			})
		: null;

	if (reader && !reader.active) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });

	const rootEntry =
		folderPath === "/"
			? null
			: reader
				? (await reader.findPath(folderPath))?.entry
				: await files_db_get_visible_node_by_path(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						path: folderPath,
					});

	if (reader?.exhausted) return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });

	if (folderPath !== "/" && (!rootEntry || ("node" in rootEntry ? rootEntry.node.kind : rootEntry.kind) !== "folder")) {
		return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
	}

	const rootTarget: files_PendingParent =
		rootEntry === null || rootEntry === undefined
			? { kind: "root" }
			: "node" in rootEntry
				? rootEntry.kind === "private"
					? { kind: "private", id: rootEntry.node._id }
					: { kind: "saved", id: rootEntry.node._id }
				: { kind: "saved", id: rootEntry._id };

	const timeOrder = args.mode === "recent" || args.orderBy === "updatedAt";
	const order = args.order ?? (timeOrder ? "desc" : "asc");

	const scope = JSON.stringify([
		args.organizationId,
		args.workspaceId,
		args.visibilityUserId,
		args.serviceAccountId,
		args.overlayUserId,
		folderPath,
		rootTarget,
		args.mode,
		order,
		args.orderBy,
		args.kind,
		args.lowercaseExtension,
		args.contentTypePrefixes,
		args.minDepth,
		args.maxDepth,
		args.pathQuery,
		args.requireComplete,
	]);

	const parentSchema = z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("root") }),
		z.object({
			kind: z.literal("saved"),
			id: z.custom<Id<"files_nodes">>(
				(value) => typeof value === "string" && ctx.db.normalizeId("files_nodes", value) !== null,
			),
		}),
		z.object({
			kind: z.literal("private"),
			id: z.custom<Id<"files_pending_nodes">>(
				(value) => typeof value === "string" && ctx.db.normalizeId("files_pending_nodes", value) !== null,
			),
		}),
	]);

	const streamSchema = z.object({
		kind: z.enum(["saved", "private", "moved"]),
		parent: parentSchema,
		cursor: z.string().nullable(),
		done: z.boolean(),
	});

	const frameSchema = z.object({ parent: parentSchema, path: z.string(), streams: z.array(streamSchema).max(5) });
	type Stream = z.infer<typeof streamSchema>;
	type Frame = z.infer<typeof frameSchema>;

	async function create_frame(parent: files_PendingParent, path: string): Promise<Frame> {
		const streams: Stream[] = [];
		if (timeOrder || parent.kind !== "private") streams.push({ kind: "saved", parent, cursor: null, done: false });
		if (reader) {
			if (timeOrder) streams.push({ kind: "private", parent, cursor: null, done: false });
			else
				for (const alias of await reader.parentAliases(parent)) {
					streams.push(
						{ kind: "private", parent: alias, cursor: null, done: false },
						{ kind: "moved", parent: alias, cursor: null, done: false },
					);
				}
		}
		return { parent, path, streams };
	}

	let frames: Frame[];
	if (args.cursor !== null) {
		let raw: unknown;
		try {
			raw = JSON.parse(args.cursor);
		} catch {
			return Result({ _nay: { message: "Invalid listing cursor" } });
		}
		const parsed = z.object({ scope: z.literal(scope), frames: z.array(frameSchema).min(1).max(256) }).safeParse(raw);
		if (!parsed.success) return Result({ _nay: { message: "Listing changed. Start again." } });
		frames = parsed.data.frames;
	} else frames = [await create_frame(rootTarget, folderPath)];

	const depth = (path: string) => path.split("/").filter(Boolean).length;
	const baseDepth = depth(folderPath);
	const in_scope = (path: string) => folderPath === "/" || path.startsWith(`${folderPath}/`);

	const to_item = (entry: files_VisibleEntry): Infer<typeof entry_validator> => {
		const intent = entry.kind === "private" ? entry.pendingUpdate.createIntent : null;
		const replacement = entry.kind === "saved" ? entry.pendingUpdate?.pendingReplacement : undefined;
		return {
			target: entry.kind === "saved" ? { kind: "saved", id: entry.node._id } : { kind: "private", id: entry.node._id },
			path: entry.path,
			name: path_name_of(entry.path),
			kind: entry.node.kind,
			updatedAt: entry.kind === "private" ? entry.pendingUpdate.updatedAt : entry.node.updatedAt,
			updatedBy: entry.kind === "private" ? entry.node.userId : entry.node.updatedBy,
			contentType:
				entry.kind === "saved"
					? (replacement?.contentType ?? entry.node.contentType)
					: intent && intent.kind !== "folder"
						? intent.contentType
						: null,
			preparing: entry.kind === "private" && (!intent || (intent.kind === "text" && !entry.pendingUpdate.content)),
		};
	};

	const matches = (entry: Infer<typeof entry_validator>) => {
		if (!in_scope(entry.path)) return false;
		const relativeDepth = depth(entry.path) - baseDepth;
		if (args.minDepth !== undefined && relativeDepth < args.minDepth) return false;
		if (args.maxDepth !== undefined && relativeDepth > args.maxDepth) return false;
		if (args.kind !== undefined && entry.kind !== args.kind) return false;
		if (
			args.lowercaseExtension !== undefined &&
			(entry.kind !== "file" || entry.name.split(".").slice(1).at(-1)?.toLowerCase() !== args.lowercaseExtension)
		)
			return false;
		if (
			args.contentTypePrefixes !== undefined &&
			!args.contentTypePrefixes.some((prefix) => entry.contentType?.startsWith(prefix))
		)
			return false;
		return args.pathQuery === undefined || entry.path.toLowerCase().includes(args.pathQuery.toLowerCase());
	};

	type Head = { item: Infer<typeof entry_validator>; readable: boolean; nextCursor: string; done: boolean };
	const heads = new Map<Stream, Head>();
	let scanned = 0;
	let progressed = false;

	async function peek(stream: Stream, frame: Frame) {
		if (heads.has(stream)) return heads.get(stream)!;
		while (!stream.done && scanned < 100 && !reader?.exhausted) {
			scanned++;
			const page = (await ctx.runQuery(internal.files_visible.internal_page, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				visibilityUserId: args.visibilityUserId,
				kind: stream.kind,
				parent: stream.parent,
				cursor: stream.cursor,
				timeOrder,
				order,
			})) as files_visible_internal_page_Result;
			const { target, savedNode, cursor, done } = page;
			const resolved = target && reader ? await reader.resolve(target) : null;
			// Keep this candidate for the next page when its ancestry used the remaining reads.
			if (reader?.exhausted) break;
			let entry: files_VisibleEntry | null = reader
				? (resolved?.entry ?? null)
				: savedNode
					? { kind: "saved", node: savedNode, pendingUpdate: null, path: savedNode.path }
					: null;
			// Renamed saved children come from the destination-name index so name order stays correct.
			if (entry?.kind === "saved" && !timeOrder && stream.kind === "saved" && entry.pendingUpdate?.pendingMove)
				entry = null;
			const entryParentPath = entry?.path.slice(0, entry.path.lastIndexOf("/")) || "/";
			if (entry && in_scope(entry.path) && (args.mode === "recent" || entryParentPath === frame.path)) {
				let readable: boolean;
				if (reader && resolved) readable = await reader.canRead(resolved.accessNode);
				else {
					const nodes = savedNode ? [savedNode] : [];
					readable =
						(
							await access_control_db_filter_readable_file_nodes(ctx, {
								organizationId: args.organizationId,
								workspaceId: args.workspaceId,
								userId: args.visibilityUserId,
								serviceAccountId: args.serviceAccountId,
								nodes,
							})
						).length > 0;
				}
				const head = { item: to_item(entry), readable, nextCursor: cursor, done };
				heads.set(stream, head);
				return head;
			}
			stream.cursor = cursor;
			stream.done = done;
			progressed = true;
		}
		return null;
	}

	const items: Infer<typeof entry_validator>[] = [];

	while (frames.length > 0 && items.length < limit && scanned < 100 && !reader?.exhausted) {
		const frame = frames[frames.length - 1]!;
		let picked: { stream: Stream; head: Head } | null = null;
		let incomplete = false;
		for (const stream of frame.streams) {
			const head = await peek(stream, frame);
			if (!head && !stream.done) {
				incomplete = true;
				break;
			}
			if (!head) continue;
			const comparison = picked
				? timeOrder
					? head.item.updatedAt - picked.head.item.updatedAt ||
						(head.item.target.id < picked.head.item.target.id ? -1 : 1)
					: compareValues(head.item.name, picked.head.item.name)
				: 0;
			if (!picked || (order === "desc" ? comparison > 0 : comparison < 0)) picked = { stream, head };
		}
		if (incomplete) break;
		if (!picked) {
			frames.pop();
			progressed = true;
			continue;
		}
		const item = picked.head.item;
		if (args.requireComplete && !picked.head.readable) return Result({ _nay: { message: "Permission denied" } });
		const nextFrame =
			args.mode === "subtree" &&
			item.kind === "folder" &&
			(args.maxDepth === undefined || depth(item.path) - baseDepth < args.maxDepth)
				? await create_frame(item.target, item.path)
				: null;
		if (reader?.exhausted) break;
		picked.stream.cursor = picked.head.nextCursor;
		picked.stream.done = picked.head.done;
		heads.delete(picked.stream);
		progressed = true;
		if (picked.head.readable && matches(item)) items.push(item);
		if (nextFrame) frames.push(nextFrame);
	}

	if (reader?.exhausted && !progressed)
		return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });

	return Result({
		_yay: {
			items,
			continueCursor: frames.length === 0 ? null : JSON.stringify({ scope, frames }),
			isDone: frames.length === 0,
		},
	});
}

export const internal_page = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		visibilityUserId: v.id("users"),
		kind: v.union(v.literal("saved"), v.literal("private"), v.literal("moved")),
		parent: files_pending_parent_validator,
		cursor: paginationOptsValidator.fields.cursor,
		timeOrder: v.boolean(),
		order: v.union(v.literal("asc"), v.literal("desc")),
	},
	returns: v.object({
		target: v.union(files_pending_target_validator, v.null()),
		savedNode: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
		cursor: v.string(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const stream = args;
		const timeOrder = args.timeOrder;
		const order = args.order;

		let target: files_PendingTarget | null = null;
		let savedNode: Doc<"files_nodes"> | null = null;
		let cursor: string;
		let done: boolean;

		if (stream.kind === "saved") {
			const parentId = stream.parent.kind === "saved" ? stream.parent.id : "root";

			const savedQuery = timeOrder
				? ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("archiveOperationId", null),
						)
				: ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", parentId)
								.eq("archiveOperationId", null),
						);

			const page = await savedQuery.order(order).paginate({ cursor: stream.cursor, numItems: 1 });
			savedNode = page.page[0] ?? null;
			target = savedNode ? { kind: "saved", id: savedNode._id } : null;
			cursor = page.continueCursor;
			done = page.isDone;
		} else if (stream.kind === "private" && !timeOrder) {
			const parent = stream.parent;

			const page = await ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", args.organizationId as Id<"organizations">)
						.eq("workspaceId", args.workspaceId as Id<"organizations_workspaces">)
						.eq("userId", args.visibilityUserId)
						.eq("parent.kind", parent.kind)
						.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
						.eq("state", "active"),
				)
				.order(order)
				.paginate({ cursor: stream.cursor, numItems: 1 });

			target = page.page[0] ? { kind: "private", id: page.page[0]._id } : null;
			cursor = page.continueCursor;
			done = page.isDone;
		} else {
			const parent = stream.parent;

			const pendingQuery = timeOrder
				? ctx.db.query("files_pending_updates").withIndex("by_organization_workspace_user_targetKind_updatedAt", (q) =>
						q
							.eq("organizationId", args.organizationId as Id<"organizations">)
							.eq("workspaceId", args.workspaceId as Id<"organizations_workspaces">)
							.eq("userId", args.visibilityUserId)
							.eq("target.kind", "private"),
					)
				: ctx.db.query("files_pending_updates").withIndex("by_user_pendingMove_destParent_destName", (q) =>
						q
							.eq("userId", args.visibilityUserId)
							.eq("pendingMove.destParent.kind", parent.kind)
							.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id),
					);

			const page = await pendingQuery.order(order).paginate({ cursor: stream.cursor, numItems: 1 });
			target = page.page[0]?.target ?? null;
			// Private replacement claims already appear in the private-node stream.
			if (!timeOrder && target?.kind === "private") target = null;
			cursor = page.continueCursor;
			done = page.isDone;
		}

		return { target, savedNode, cursor, done };
	},
});

type files_visible_internal_page_Result =
	typeof internal_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const visible_entry_validator = v.union(
	v.object({
		kind: v.literal("saved"),
		node: doc(app_convex_schema, "files_nodes"),
		pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		path: v.string(),
	}),
	v.object({
		kind: v.literal("private"),
		node: doc(app_convex_schema, "files_pending_nodes"),
		pendingUpdate: doc(app_convex_schema, "files_pending_updates"),
		path: v.string(),
	}),
	v.null(),
);

export const internal_get_by_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
	},
	returns: visible_entry_validator,
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		const reader = await files_visible_db_create_reader(ctx, args);
		const entry = await reader.resolvePath(args.path);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry;
	},
});

export const internal_get_by_target = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
	},
	returns: visible_entry_validator,
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		const reader = await files_visible_db_create_reader(ctx, args);
		const entry = await reader.resolveTarget(args.target);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry;
	},
});

/**
 * A chat keeps folder identity across moves and private publication, with current read access.
 */
export const internal_get_directory_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
	},
	returns: v.union(v.object({ target: files_pending_target_validator, path: v.string() }), v.null()),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		let target = args.target;
		if (target.kind === "private") {
			const node = await ctx.db.get("files_pending_nodes", target.id);
			if (
				!node ||
				node.organizationId !== args.organizationId ||
				node.workspaceId !== args.workspaceId ||
				node.userId !== args.userId ||
				node.state === "discarded"
			)
				return null;
			if (node.state === "published") {
				const receipt = await ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
					.unique();
				if (!receipt) {
					const message = "Published private node has no receipt";
					const data = { privateNodeId: node._id };
					console.error(message, data);
					throw should_never_happen(message, data);
				}
				target = { kind: "saved", id: receipt.savedNodeId };
			}
		}
		const reader = await files_visible_db_create_reader(ctx, { ...args, readLimit: 4096 });
		const entry = await reader.resolveTarget(target);
		if (reader.exhausted) throw convex_error({ message: "Folder path lookup exceeded its read limit." });
		return entry?.node.kind === "folder" ? { target, path: entry.path } : null;
	},
});

export const internal_list = internalQuery({
	args: {
		...internal_listing_args.fields,
		agentSource: v.optional(ai_chat_workspaces_source_validator),
	},
	returns: listing_result,
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
				userId: args.visibilityUserId,
			});
			if (authorized._nay) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
		}
		return await db_list(ctx, args);
	},
});

export type files_visible_internal_list_Result =
	typeof internal_list extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_path = query({
	args: { membershipId: v.id("organizations_workspaces_users"), target: files_pending_target_validator },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const reader = await files_visible_db_create_reader(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		});
		const entry = await reader.resolveTarget(args.target);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry?.path ?? null;
	},
});

export const list = query({
	args: { ...listing_args, membershipId: v.id("organizations_workspaces_users") },
	returns: listing_result,
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
		return await db_list(ctx, {
			...args,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			visibilityUserId: userAuth.id,
			overlayUserId: userAuth.id,
		});
	},
});
