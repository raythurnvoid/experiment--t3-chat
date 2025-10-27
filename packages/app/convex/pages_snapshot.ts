"use node";

import { action } from "./_generated/server.js";
import { Liveblocks } from "@liveblocks/node";
import { withProsemirrorDocument } from "@liveblocks/node-prosemirror";
import { v } from "convex/values";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { ai_docs_create_liveblocks_room_id } from "../shared/pages.ts";
import {
	server_page_editor_markdown_to_json,
	server_page_editor_get_schema,
	server_page_editor_DEFAULT_FIELD,
} from "../server/page-editor.ts";
import { internal, api } from "./_generated/api.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

const LIVEBLOCKS_SECRET_KEY = process.env.LIVEBLOCKS_SECRET_KEY!;
if (!LIVEBLOCKS_SECRET_KEY) {
	throw new Error("LIVEBLOCKS_SECRET_KEY env var is not set");
}

export const restore_snapshot = action({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
		pageSnapshotId: v.id("pages_snapshots"),
	},
	returns: v.union(
		v.object({
			_yay: v.null(),
		}),
		v.object({
			_nay: v.object({
				name: v.string(),
				message: v.string(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		try {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);

			const snapshotContent = await ctx.runQuery(api.ai_docs_temp.get_page_snapshot_content, {
				page_id: args.pageId,
				page_snapshot_id: args.pageSnapshotId,
			});

			if (!snapshotContent) {
				const msg = "Snapshot content not found";
				console.error(msg);
				return Result({ _nay: { message: msg } });
			}

			const pageTextContent = await ctx.runQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
			});

			if (pageTextContent === null) {
				const msg = "Page not found";
				console.error(msg);
				return Result({ _nay: { message: msg } });
			}

			const roomId = ai_docs_create_liveblocks_room_id(args.workspaceId, args.projectId, args.pageId);
			const editorDocJson = server_page_editor_markdown_to_json(snapshotContent.content);

			if (editorDocJson._nay) {
				const msg = `Failed to parse markdown to JSON: ${editorDocJson._nay.message}`;
				console.error(msg);
				return Result({ _nay: { message: msg } });
			}

			const json = editorDocJson._yay;
			const liveblocks = new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
			const schema = server_page_editor_get_schema();

			try {
				await withProsemirrorDocument(
					{ roomId, client: liveblocks, schema, field: server_page_editor_DEFAULT_FIELD },
					async (docApi) => {
						await docApi.setContent(json);
					},
				);
			} catch (error) {
				const msg = `Failed to update Liveblocks document: ${(error as Error)?.message ?? error}`;
				console.error(msg);
				return Result({
					_nay: {
						message: msg,
					},
				});
			}

			await Promise.all([
				ctx.runMutation(internal.ai_docs_temp.store_version_snapshot, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					page_id: args.pageId,
					content: pageTextContent,
					created_by: user.name,
				}),

				ctx.runMutation(internal.ai_docs_temp.store_version_snapshot, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					page_id: args.pageId,
					content: snapshotContent.content,
					created_by: user.name,
				}),
			]);

			return Result({ _yay: null });
		} catch (error) {
			const msg = `Failed to restore snapshot: ${(error as Error)?.message ?? error}`;
			console.error(msg);
			return Result({
				_nay: { message: msg },
			});
		}
	},
});
