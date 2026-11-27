import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { convexToJson, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { internalAction, internalQuery, type QueryCtx } from "./_generated/server.js";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_update_index_revision } from "../shared/files.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// The idle probes are shared by every row in this transaction's migration batch.
const checked = new WeakMap<object, Set<string>>();
async function check_search_idle(ctx: Pick<QueryCtx, "db">) {
	if (checked.has(ctx)) return;
	const active = await Promise.all([
		ctx.db
			.query("files_move_cohorts")
			.withIndex("by_deadline", (q) => q.lt("phase", "complete"))
			.first(),
		ctx.db
			.query("files_move_cohorts")
			.withIndex("by_deadline", (q) => q.gt("phase", "complete"))
			.first(),
		ctx.db.query("files_index_runs").first(),
		ctx.db.query("files_index_candidates").first(),
		ctx.db.query("files_subtree_ops").first(),
		ctx.db
			.query("files_index_states")
			.withIndex("by_needsRun_nextAttemptAt", (q) => q.eq("needsRun", true))
			.first(),
		ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope"))
			.first(),
	]);
	if (active.some(Boolean)) throw new Error("Wait for Move and index work to drain before migrating search rows");
	checked.set(ctx, new Set());
}

async function check_search_owner(ctx: Pick<QueryCtx, "db">, row: Doc<"files_plain_text_chunks">) {
	// Rows for one file often share an owner. Cache only the fields already checked in this batch.
	const owner = JSON.stringify(
		row.sourceKind === "committed"
			? [row.organizationId, row.workspaceId, row.contentHeadId, row.fileNodeId]
			: [
					row.organizationId,
					row.workspaceId,
					row.pendingUpdateId,
					row.userId,
					row.target.kind,
					row.target.id,
					row.proposalRevision,
				],
	);
	const owners = checked.get(ctx)!;
	if (owners.has(owner)) return;
	if (row.sourceKind === "pending") {
		const proposal = await ctx.db.get("files_pending_updates", row.pendingUpdateId);
		if (!proposal || files_pending_update_index_revision(proposal) !== row.proposalRevision)
			throw new Error(`Search row ${row._id} has no current draft. Wait for its cleanup.`);
		if (
			proposal.userId !== row.userId ||
			proposal.organizationId !== row.organizationId ||
			proposal.workspaceId !== row.workspaceId ||
			proposal.target.kind !== row.target.kind ||
			proposal.target.id !== row.target.id
		)
			throw new Error(`Search draft owner differs for ${row._id}.`);
	} else {
		const head = row.contentHeadId && (await ctx.db.get("files_saved_content_heads", row.contentHeadId));
		if (
			!head ||
			!head.ready ||
			head.retired ||
			head.organizationId !== row.organizationId ||
			head.workspaceId !== row.workspaceId ||
			head.fileNodeId !== row.fileNodeId
		)
			throw new Error(`Search row ${row._id} has no readable source head.`);
	}
	owners.add(owner);
}

async function check_search_link(ctx: Pick<QueryCtx, "db">, row: Doc<"files_plain_text_chunks">) {
	// A discarded draft can lose its exact chunk before its search row drains.
	await check_search_owner(ctx, row);
	const exact = await ctx.db.get("files_text_chunks", row.textChunkId);
	if (
		!exact ||
		row.moveView !== undefined ||
		exact.moveView !== undefined ||
		exact.organizationId !== row.organizationId ||
		exact.workspaceId !== row.workspaceId ||
		exact.chunkIndex !== row.chunkIndex ||
		exact.startIndex !== row.startIndex ||
		exact.endIndex !== row.endIndex ||
		exact.lineStart !== row.lineStart ||
		exact.lineEnd !== row.lineEnd ||
		exact.chunkFlags !== row.chunkFlags ||
		(row.textChunk !== undefined && exact.textChunk !== row.textChunk) ||
		(exact.sourceKind === "committed"
			? row.sourceKind !== "committed" ||
				exact.fileNodeId !== row.fileNodeId ||
				!exact.contentHeadId ||
				exact.contentHeadId !== row.contentHeadId ||
				exact.yjsSequence !== row.yjsSequence
			: row.sourceKind !== "pending" ||
				exact.userId !== row.userId ||
				exact.pendingUpdateId !== row.pendingUpdateId ||
				exact.proposalRevision !== row.proposalRevision ||
				exact.target.kind !== row.target.kind ||
				exact.target.id !== row.target.id)
	)
		throw new Error(`Search source differs for ${row._id}. Keep the stored snippet and investigate.`);
	return exact.textChunk;
}

export const strip_search_chunks = app_migrations.define({
	table: "files_plain_text_chunks",
	batchSize: 16,
	migrateOne: async (ctx, row) => {
		await check_search_idle(ctx);
		if (row.textChunk === undefined && row.path === undefined) return;
		await check_search_link(ctx, row);
		const { _id, _creationTime, path: _path, textChunk: _raw, ...next } = row;
		await ctx.db.replace("files_plain_text_chunks", _id, next);
	},
});
export const run_strip_search_chunks = app_migrations.runner(internal.migrations.strip_search_chunks);

// Component dry-run logs document bodies. Roll back one real batch and return only its progress.
export const preview_search_chunks = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = (await ctx.runMutation(internal.migrations.strip_search_chunks, {
			cursor: args.cursor,
			batchSize: 16,
			oneBatchOnly: true,
			dryRun: false,
		})) as { continueCursor: string; processed: number; isDone: boolean };
		const { bytesRead, bytesWritten, documentsRead, documentsWritten, databaseQueries } =
			await ctx.meta.getTransactionMetrics();
		throw new Error(
			`Search preview rolled back: ${JSON.stringify({ rows: page.processed, bytesRead, bytesWritten, documentsRead, documentsWritten, databaseQueries })}`,
		);
	},
});

const audit_args = {
	cutoff: v.number(),
	afterTime: v.union(v.number(), v.null()),
	cursor: v.union(v.string(), v.null()),
	digest: v.string(),
	strict: v.boolean(),
	pageSize: v.number(),
};

export const audit_search_chunks = internalQuery({
	args: audit_args,
	returns: v.object({ cursor: v.string(), done: v.boolean(), rows: v.number(), digest: v.string() }),
	handler: async (ctx, args) => {
		await check_search_idle(ctx);
		const page = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_creation_time", (q) =>
				args.afterTime === null
					? q.lte("_creationTime", args.cutoff)
					: q.gt("_creationTime", args.afterTime).lte("_creationTime", args.cutoff),
			)
			.paginate({
				cursor: args.cursor,
				numItems: Math.max(1, Math.min(128, args.pageSize)),
				maximumBytesRead: 256 * 1024,
			});
		let digest = args.digest;
		for (const row of page.page) {
			const exact = await check_search_link(ctx, row);
			const { path, textChunk, ...kept } = row;
			if (args.strict && (path !== undefined || textChunk !== undefined))
				throw new Error(`Legacy search fields remain on ${row._id}.`);
			// Convex sorts nested keys. Chaining each row makes the hash independent of page size.
			digest = await crypto_sha256_hex(JSON.stringify([digest, convexToJson(kept), textChunk ?? exact]));
		}
		return { cursor: page.continueCursor, done: page.isDone, rows: page.page.length, digest };
	},
});

export const hash_search_pages = internalAction({
	args: { ...audit_args, cutoff: v.union(v.null(), v.number()) },
	returns: v.object({
		cutoff: v.number(),
		cursor: v.string(),
		done: v.boolean(),
		rows: v.number(),
		digest: v.string(),
	}),
	handler: async (
		ctx,
		args,
	): Promise<{ cutoff: number; cursor: string; done: boolean; rows: number; digest: string }> => {
		const cutoff = args.cutoff ?? Date.now();
		let cursor = args.cursor;
		let digest = args.digest;
		let rows = 0;
		const started = Date.now();
		for (let pass = 0; ; pass++) {
			const page: { cursor: string; digest: string; done: boolean; rows: number } = await ctx.runQuery(
				internal.migrations.audit_search_chunks,
				{ ...args, cutoff, cursor, digest },
			);
			cursor = page.cursor;
			digest = page.digest;
			rows += page.rows;
			if (page.done || pass === 7 || Date.now() - started > 10_000)
				return { cutoff, cursor, digest, rows, done: page.done };
		}
	},
});
