import { convexToJson, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, type QueryCtx } from "./_generated/server.js";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

export const metadata_cutoff = internalQuery({
	args: {},
	handler: async (ctx) => {
		await require_idle_moves(ctx);
		return Date.now();
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// Every write batch checks the Move indexes in its own transaction. A concurrent Move retries the batch.
async function require_idle_moves(ctx: Pick<QueryCtx, "db">) {
	const cohorts = ctx.db.query("files_move_cohorts");
	const active = await Promise.all([
		...(["queued", "running", "awaiting_input", "stopping"] as const).map((status) =>
			ctx.db
				.query("activities")
				.withIndex("by_transferKind_status", (q) => q.eq("source.transferKind", "move").eq("status", status))
				.first(),
		),
		cohorts.withIndex("by_deadline", (q) => q.lt("phase", "complete")).first(),
		cohorts.withIndex("by_deadline", (q) => q.gt("phase", "complete")).first(),
	]);
	if (active.some(Boolean)) throw new Error("Wait for active Moves to finish.");
}

type Metadata = Extract<Doc<"files_index_candidates">, { kind: "metadata" }>["value"];

function canonical_value(row: Metadata) {
	const { stringValue, numberValue, booleanValue, searchValue } = row;
	const legacy = [stringValue, numberValue, booleanValue].filter((value) => value !== undefined);
	const value = searchValue ?? legacy[0];
	const kind = row.valueKind === "maybe_date" ? "number" : row.valueKind;
	if (
		legacy.length > 1 ||
		(legacy.length === 1 && !Object.is(legacy[0], value)) ||
		(row.docKind === "field" ? kind !== undefined || value !== undefined : kind !== typeof value)
	)
		throw new Error("Metadata kind or value differs. Keep the original row.");
	return value;
}

const metadata_page_args = {
	table: v.union(v.literal("files_metadata_docs"), v.literal("files_index_candidates")),
	cursor: v.union(v.string(), v.null()),
	cutoff: v.number(),
};

export const migrate_metadata_values = internalMutation({
	args: { ...metadata_page_args, operation: v.literal("backfill"), preview: v.boolean() },
	handler: async (ctx, args) => {
		await require_idle_moves(ctx);
		const page = await ctx.db
			.query(args.table)
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", args.cutoff))
			.paginate({ cursor: args.cursor, numItems: 32, maximumBytesRead: 256 * 1024 });
		let changed = 0;
		for (const row of page.page) {
			if ("kind" in row && row.kind === "text") continue;
			const doc = "value" in row ? row.value : row;
			const searchValue = canonical_value(doc);
			if (Object.is(doc.searchValue, searchValue)) continue;
			if ("value" in row)
				await ctx.db.patch("files_index_candidates", row._id, { value: { ...row.value, searchValue } });
			else await ctx.db.patch("files_metadata_docs", row._id, { searchValue });
			changed++;
		}
		const { bytesRead, bytesWritten, documentsRead, documentsWritten } = await ctx.meta.getTransactionMetrics();
		const result = { changed, rows: page.page.length, bytesRead, bytesWritten, documentsRead, documentsWritten };
		if (args.preview) throw new Error("Metadata preview rolled back " + JSON.stringify(result));
		return { ...result, cursor: page.continueCursor, done: page.isDone };
	},
});

export const audit_metadata_values = internalQuery({
	args: {
		...metadata_page_args,
		digest: v.string(),
		layout: v.union(v.literal("original"), v.literal("dual"), v.literal("strict")),
	},
	handler: async (ctx, args) => {
		await require_idle_moves(ctx);
		const page = await ctx.db
			.query(args.table)
			.withIndex("by_creation_time", (q) => q.lte("_creationTime", args.cutoff))
			.paginate({ cursor: args.cursor, numItems: 128, maximumBytesRead: 512 * 1024 });
		let digest = args.digest;
		let count = 0;
		for (const row of page.page) {
			if ("kind" in row && row.kind === "text") continue;
			const doc = "value" in row ? row.value : row;
			const value = canonical_value(doc);
			const { stringValue, numberValue, booleanValue, searchValue, ...kept } = doc;
			const legacy = stringValue ?? numberValue ?? booleanValue;
			if (
				(args.layout !== "original" && !Object.is(searchValue, value)) ||
				(args.layout === "strict" ? legacy !== undefined : !Object.is(legacy, value))
			)
				throw new Error("Metadata layout differs on " + row._id);
			const normalized = { ...kept, ...(value === undefined ? {} : { searchValue: value }) };
			const entry = "value" in row ? { ...row, value: normalized } : normalized;
			digest = await crypto_sha256_hex(JSON.stringify([digest, convexToJson(entry)]));
			count++;
		}
		return { count, digest, cursor: page.continueCursor, done: page.isDone };
	},
});
