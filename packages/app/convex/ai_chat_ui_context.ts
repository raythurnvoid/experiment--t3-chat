import { Result } from "common/errors-as-values-utils.ts";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_node } from "./access_control.ts";
import { ai_chat_ui_context_validate_parts, type ai_chat_UiContext } from "../shared/ai-chat-ui-context.ts";

async function get_readable_node(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	fileNodeId: string,
) {
	const nodeId = ctx.db.normalizeId("files_nodes", fileNodeId);
	if (!nodeId) return null;
	const read = await access_control_db_authorize_node(ctx, {
		membership,
		userAuth: { id: membership.userId },
		nodeId,
		permission: "content.read",
	});
	return !read._nay && read._yay.fileNode.archiveOperationId === null ? read._yay.fileNode : null;
}

/**
 * Check the screen info of a new message inside the send transaction, and return the message parts
 * to store. The stored path and kind come from the saved node, not from the browser.
 *
 * The app adds screen info by itself, so it never blocks a send. A node the sender cannot read now
 * (archived, locked, another workspace, or an old message whose id history already cleared) is
 * dropped from the info instead.
 */
export async function ai_chat_ui_context_db_rewrite_parts(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; parts: unknown },
) {
	const context = ai_chat_ui_context_validate_parts(args.parts);
	if (context._nay) return context;
	const parts = args.parts as unknown[];
	if (!context._yay?.node) return Result({ _yay: parts });

	let node: ai_chat_UiContext["node"] = null;
	// A null id is the workspace root, which has no node doc.
	if (context._yay.node.fileNodeId === null) {
		node = context._yay.node.path === "/" && context._yay.node.kind === "folder" ? context._yay.node : null;
	} else {
		const fileNode = await get_readable_node(ctx, args.membership, context._yay.node.fileNodeId);
		node = fileNode ? { fileNodeId: fileNode._id, path: fileNode.path, kind: fileNode.kind } : null;
	}

	const data: ai_chat_UiContext = { ...context._yay, node };
	return Result({
		_yay: parts.flatMap((part) => {
			if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-ui-context") {
				return [part];
			}
			// Info with neither a node nor a plugin says nothing, so drop the whole part.
			return data.node || data.plugin ? [{ ...part, data }] : [];
		}),
	});
}

/**
 * History reads keep the sent path and clear a node id the reader can no longer open, like file
 * quotes.
 */
export async function ai_chat_ui_context_db_shape(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users"> | null; context: ai_chat_UiContext },
) {
	const node = args.context.node;
	if (node?.fileNodeId == null) return args.context;
	const readable = args.membership !== null && (await get_readable_node(ctx, args.membership, node.fileNodeId));
	return readable ? args.context : { ...args.context, node: { ...node, fileNodeId: null } };
}
