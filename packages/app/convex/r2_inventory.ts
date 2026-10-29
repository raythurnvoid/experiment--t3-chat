"use node";

// The SDK's XML response parser needs Node, while the scope query runs in Convex.
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v } from "convex/values";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { r2 } from "./r2_client.ts";
import type { get_inventory_scope_Result, get_live_default_inventory_scope_Result } from "./r2.ts";

const CONVEX_CLOUD_URL = process.env.CONVEX_CLOUD_URL;
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const INVENTORY_CLOUD_URL = "https://grand-finch-267.convex.cloud";
const INVENTORY_SITE_URL = "https://grand-finch-267.convex.site";
const INVENTORY_BUCKET = "bonobo-senate-press-files";
const INVENTORY_PAGE_SIZE = 500;
const INVENTORY_CURSOR_MAX_LENGTH = 8192;
const INVENTORY_TIMEOUT_MS = 30_000;
const R2_ACCOUNT_ENDPOINT_REGEX = /^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com\/?$/;
const ASSET_SUFFIX_REGEX = /^assets\/([^/]+)$/;

const inventory_page_validator = v.object({
	cloudUrl: v.literal(INVENTORY_CLOUD_URL),
	siteUrl: v.literal(INVENTORY_SITE_URL),
	accountId: v.string(),
	bucket: v.literal(INVENTORY_BUCKET),
	prefix: v.string(),
	organizationExists: v.boolean(),
	page: v.array(v.object({ keyHash: v.string(), size: v.number(), assetId: v.union(v.string(), v.null()) })),
	continueCursor: v.union(v.string(), v.null()),
	isDone: v.boolean(),
});

async function list_objects(args: {
	prefix: string;
	cursor: string | undefined;
	accountId: string;
	organizationExists: boolean;
}) {
	const response: unknown = await r2.client.send(
		new ListObjectsV2Command({
			Bucket: INVENTORY_BUCKET,
			Prefix: args.prefix,
			MaxKeys: INVENTORY_PAGE_SIZE,
			ContinuationToken: args.cursor,
		}),
		{ abortSignal: AbortSignal.timeout(INVENTORY_TIMEOUT_MS) },
	);
	const parsed = z
		.object({
			Name: z.literal(INVENTORY_BUCKET),
			Prefix: z.literal(args.prefix),
			MaxKeys: z.literal(INVENTORY_PAGE_SIZE),
			KeyCount: z.number().int().min(0).max(INVENTORY_PAGE_SIZE),
			IsTruncated: z.boolean(),
			Contents: z
				.array(
					z.object({
						Key: z
							.string()
							.startsWith(args.prefix)
							.max(1024)
							.refine((key) => files_get_utf8_byte_size(key) <= 1024),
						Size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
					}),
				)
				.max(INVENTORY_PAGE_SIZE)
				.optional()
				.default([]),
			NextContinuationToken: z.string().min(1).max(INVENTORY_CURSOR_MAX_LENGTH).optional(),
		})
		.safeParse(response);
	if (!parsed.success) {
		return Result({ _nay: { message: "Invalid R2 inventory page" } });
	}
	const page = parsed.data;
	const continueCursor = page.IsTruncated ? (page.NextContinuationToken ?? null) : null;
	// A short page may have a next cursor. Only the native final-page flag ends the scan.
	if (
		page.KeyCount !== page.Contents.length ||
		(page.IsTruncated && (continueCursor === null || continueCursor === args.cursor))
	) {
		return Result({ _nay: { message: "Invalid R2 inventory page" } });
	}
	return Result({
		_yay: {
			cloudUrl: INVENTORY_CLOUD_URL,
			siteUrl: INVENTORY_SITE_URL,
			accountId: args.accountId,
			bucket: INVENTORY_BUCKET,
			prefix: args.prefix,
			organizationExists: args.organizationExists,
			page: await Promise.all(
				page.Contents.map(async (object) => ({
					keyHash: await crypto_sha256_hex(object.Key),
					size: object.Size,
					assetId: ASSET_SUFFIX_REGEX.exec(object.Key.slice(args.prefix.length))?.[1] ?? null,
				})),
			),
			continueCursor,
			isDone: !page.IsTruncated,
		},
	});
}

/**
 * Read one object page for a missing workspace. The operator checks the ids against its cleanup
 * manifest. Live reset workspaces need a separate audit; this action never lists them.
 */
export const list_deleted_workspace_objects = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		cursor: v.optional(v.string()),
	},
	returns: v_result({ _yay: inventory_page_validator }),
	handler: async (ctx, args) => {
		const cursor = z.string().min(1).max(INVENTORY_CURSOR_MAX_LENGTH).optional().safeParse(args.cursor);
		if (!cursor.success) {
			return Result({ _nay: { message: "Invalid R2 inventory cursor" } });
		}

		const accountMatch = R2_ACCOUNT_ENDPOINT_REGEX.exec(r2.config.endpoint);
		if (
			CONVEX_CLOUD_URL !== INVENTORY_CLOUD_URL ||
			CONVEX_SITE_URL !== INVENTORY_SITE_URL ||
			r2.config.bucket !== INVENTORY_BUCKET ||
			!accountMatch
		) {
			return Result({ _nay: { message: "R2 inventory target is not the allowed dev target" } });
		}

		try {
			const scope: get_inventory_scope_Result = await ctx.runQuery(internal.r2.get_inventory_scope, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			});
			if (scope.workspaceExists) {
				return Result({ _nay: { message: "R2 inventory requires a missing workspace" } });
			}
			return await list_objects({
				prefix: `organizations/${args.organizationId}/workspaces/${args.workspaceId}/`,
				cursor: cursor.data,
				accountId: accountMatch[1],
				organizationExists: scope.organizationExists,
			});
		} catch {
			return Result({ _nay: { message: "Could not list deleted workspace R2 objects" } });
		}
	},
});

/**
 * The operator binds this exact owner/default pair to its approved reset manifest.
 */
export const list_live_default_workspace_objects = internalAction({
	args: {
		ownerUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		cursor: v.optional(v.string()),
	},
	returns: v_result({ _yay: inventory_page_validator }),
	handler: async (ctx, args) => {
		const cursor = z.string().min(1).max(INVENTORY_CURSOR_MAX_LENGTH).optional().safeParse(args.cursor);
		if (!cursor.success) {
			return Result({ _nay: { message: "Invalid R2 inventory cursor" } });
		}
		const accountMatch = R2_ACCOUNT_ENDPOINT_REGEX.exec(r2.config.endpoint);
		if (
			CONVEX_CLOUD_URL !== INVENTORY_CLOUD_URL ||
			CONVEX_SITE_URL !== INVENTORY_SITE_URL ||
			r2.config.bucket !== INVENTORY_BUCKET ||
			!accountMatch
		) {
			return Result({ _nay: { message: "R2 inventory target is not the allowed dev target" } });
		}
		try {
			const matches: get_live_default_inventory_scope_Result = await ctx.runQuery(
				internal.r2.get_live_default_inventory_scope,
				{ ownerUserId: args.ownerUserId, organizationId: args.organizationId, workspaceId: args.workspaceId },
			);
			if (!matches) {
				return Result({ _nay: { message: "R2 inventory requires this Clerk owner's live default workspace" } });
			}
			return await list_objects({
				prefix: `organizations/${args.organizationId}/workspaces/${args.workspaceId}/`,
				cursor: cursor.data,
				accountId: accountMatch[1],
				organizationExists: true,
			});
		} catch {
			return Result({ _nay: { message: "Could not list live default workspace R2 objects" } });
		}
	},
});
