"use node";

import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import type { files_nodes_create_file_node_internal_Result } from "./files_nodes_content.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_random_hex } from "../server/crypto-utils.ts";
import { files_get_utf8_byte_size, files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { organizations_GLOBAL_PLUGINS_WORKSPACE_ID } from "../shared/organizations.ts";
import { plugins_module_path_schema } from "../shared/plugins.ts";

// Stage source outside the review loop. Bash later reads only the requested indexed ranges.
export const stage_sources = internalAction({
	args: {
		files: v.array(v.object({ path: v.string(), source: v.string() })),
	},
	returns: v_result({ _yay: v.object({ reviewRoot: v.string() }) }),
	handler: async (ctx, args) => {
		const paths = new Set<string>();
		for (const file of args.files) {
			if (!plugins_module_path_schema.safeParse(file.path).success || paths.has(file.path)) {
				return Result({ _nay: { message: "Plugin review source paths must be unique normalized relative paths" } });
			}
			if (files_get_utf8_byte_size(file.source) > files_MAX_TEXT_CONTENT_BYTES) {
				return Result({ _nay: { message: `Plugin review source exceeds ${files_MAX_TEXT_CONTENT_BYTES} bytes` } });
			}
			paths.add(file.path);
		}
		const reviewRoot = `/review-${crypto_random_hex(16)}`;
		// Schedule first so an interrupted staging or model call still loses its temporary source.
		await ctx.scheduler.runAfter(60 * 60 * 1000, internal.plugins.delete_review_source_tree, { reviewRoot });
		let staged = false;
		try {
			for (const file of args.files) {
				const created = (await ctx.runAction(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path: `${reviewRoot}/${file.path}`,
					rawText: file.source,
				})) as files_nodes_create_file_node_internal_Result;
				if (created._nay) return Result({ _nay: created._nay });
			}
			staged = true;
			return Result({ _yay: { reviewRoot } });
		} finally {
			if (!staged) {
				await ctx.scheduler.runAfter(0, internal.plugins.delete_review_source_tree, { reviewRoot });
			}
		}
	},
});
