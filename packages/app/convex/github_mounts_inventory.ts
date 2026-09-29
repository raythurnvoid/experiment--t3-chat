"use node";

// The SDK needs Node to parse list XML; default Convex has no DOMParser.
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v } from "convex/values";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { internalAction } from "./_generated/server.js";
import { v_result } from "../server/convex-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { r2 } from "./r2_client.ts";

const CONVEX_CLOUD_URL = process.env.CONVEX_CLOUD_URL;
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const CUTOVER_CLOUD_URL = "https://grand-finch-267.convex.cloud";
const CUTOVER_SITE_URL = "https://grand-finch-267.convex.site";
const CUTOVER_BUCKET = "bonobo-senate-press-files";
const CUTOVER_PREFIX = "organizations/GLOBAL/workspaces/GITHUB/";
const CUTOVER_PAGE_SIZE = 500;
const CUTOVER_CURSOR_MAX_LENGTH = 8192;
const CUTOVER_TIMEOUT_MS = 30_000;
const R2_ACCOUNT_ENDPOINT_REGEX = /^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com\/?$/;

/**
 * List one legacy R2 page for the dev cutover audit. This temporary action only reads keys and sizes.
 * The SDK list response parser needs the Node runtime.
 */
export const list_bucket_objects_for_cutover = internalAction({
	args: { cursor: v.optional(v.string()) },
	returns: v_result({
		_yay: v.object({
			cloudUrl: v.literal(CUTOVER_CLOUD_URL),
			siteUrl: v.literal(CUTOVER_SITE_URL),
			accountId: v.string(),
			bucket: v.literal(CUTOVER_BUCKET),
			prefix: v.literal(CUTOVER_PREFIX),
			page: v.array(v.object({ key: v.string(), size: v.number() })),
			continueCursor: v.union(v.string(), v.null()),
			isDone: v.boolean(),
		}),
	}),
	handler: async (_ctx, args) => {
		const cursor = z.string().min(1).max(CUTOVER_CURSOR_MAX_LENGTH).optional().safeParse(args.cursor);
		if (!cursor.success) {
			return Result({ _nay: { message: "Invalid R2 inventory cursor" } });
		}

		const accountMatch = R2_ACCOUNT_ENDPOINT_REGEX.exec(r2.config.endpoint);
		if (
			CONVEX_CLOUD_URL !== CUTOVER_CLOUD_URL ||
			CONVEX_SITE_URL !== CUTOVER_SITE_URL ||
			r2.config.bucket !== CUTOVER_BUCKET ||
			!accountMatch
		) {
			return Result({ _nay: { message: "R2 inventory target is not the allowed dev target" } });
		}

		try {
			const response: unknown = await r2.client.send(
				new ListObjectsV2Command({
					Bucket: CUTOVER_BUCKET,
					Prefix: CUTOVER_PREFIX,
					MaxKeys: CUTOVER_PAGE_SIZE,
					ContinuationToken: cursor.data,
				}),
				{ abortSignal: AbortSignal.timeout(CUTOVER_TIMEOUT_MS) },
			);
			const parsed = z
				.object({
					Name: z.literal(CUTOVER_BUCKET),
					Prefix: z.literal(CUTOVER_PREFIX),
					MaxKeys: z.literal(CUTOVER_PAGE_SIZE),
					KeyCount: z.number().int().min(0).max(CUTOVER_PAGE_SIZE),
					IsTruncated: z.boolean(),
					Contents: z
						.array(
							z.object({
								Key: z
									.string()
									.startsWith(CUTOVER_PREFIX)
									.max(1024)
									.refine((key) => files_get_utf8_byte_size(key) <= 1024),
								Size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
							}),
						)
						.max(CUTOVER_PAGE_SIZE)
						.optional()
						.default([]),
					NextContinuationToken: z.string().min(1).max(CUTOVER_CURSOR_MAX_LENGTH).optional(),
				})
				.safeParse(response);
			if (!parsed.success) {
				return Result({ _nay: { message: "Invalid R2 inventory page" } });
			}

			const page = parsed.data;
			const continueCursor = page.IsTruncated ? (page.NextContinuationToken ?? null) : null;
			// Only R2's final-page flag ends the scan. A short page can still have a next cursor.
			if (
				page.KeyCount !== page.Contents.length ||
				(page.IsTruncated && (continueCursor === null || continueCursor === cursor.data))
			) {
				return Result({ _nay: { message: "Invalid R2 inventory page" } });
			}

			return Result({
				_yay: {
					cloudUrl: CUTOVER_CLOUD_URL,
					siteUrl: CUTOVER_SITE_URL,
					accountId: accountMatch[1],
					bucket: CUTOVER_BUCKET,
					prefix: CUTOVER_PREFIX,
					page: page.Contents.map((object) => ({ key: object.Key, size: object.Size })),
					continueCursor,
					isDone: !page.IsTruncated,
				},
			});
		} catch {
			return Result({ _nay: { message: "Could not list legacy R2 objects" } });
		}
	},
});
