import z from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_node } from "./access_control.ts";
import { file_quotes_MAX_COUNT, file_quotes_schema, type file_quotes_Quote } from "../shared/file-quotes.ts";

async function can_read_file(
	ctx: QueryCtx | MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
	fileNodeId: string,
) {
	const nodeId = ctx.db.normalizeId("files_nodes", fileNodeId);
	if (!nodeId) return false;
	const read = await access_control_db_authorize_node(ctx, {
		membership,
		userAuth: { id: membership.userId },
		nodeId,
		permission: "content.read",
	});
	return !read._nay && read._yay.fileNode.kind === "file" && read._yay.fileNode.archiveOperationId === null;
}

/**
 * Repeat access checks inside the send transaction, after any HTTP validation.
 */
export async function file_quotes_db_validate(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; quotes: unknown },
) {
	const parsed = z.array(file_quotes_schema).max(file_quotes_MAX_COUNT).safeParse(args.quotes);
	if (!parsed.success) return Result({ _nay: { message: "Invalid file quotes" } });
	for (const quote of parsed.data) {
		if (quote.fileNodeId !== null && !(await can_read_file(ctx, args.membership, quote.fileNodeId)))
			return Result({ _nay: { message: "File unavailable" } });
	}
	return Result({ _yay: parsed.data });
}

export async function file_quotes_db_shape(
	ctx: QueryCtx | MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users"> | null; quotes: readonly file_quotes_Quote[] },
) {
	return await Promise.all(
		args.quotes.map(async (quote) => ({
			fileNodeId:
				quote.fileNodeId !== null && args.membership && (await can_read_file(ctx, args.membership, quote.fileNodeId))
					? quote.fileNodeId
					: null,
			text: quote.text,
		})),
	);
}
