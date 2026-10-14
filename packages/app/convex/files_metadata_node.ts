"use node";

import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { action } from "./_generated/server.js";
import { files_pending_target_validator } from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_metadata_read_full_page } from "../server/files-metadata-read.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

export const get_full_field_values = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: files_pending_target_validator,
		field: v.string(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.object({ json: v.string(), cursor: v.union(v.string(), v.null()), isDone: v.boolean() }),
	}),
	handler: async (
		ctx,
		args,
	): Promise<
		| { _yay: { json: string; cursor: string | null; isDone: boolean }; _nay?: undefined }
		| { _nay: { message: string }; _yay?: undefined }
	> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!userAuth || !user || (userAuth.kind === "anonymous" && user.deletedAt !== undefined))
			return Result({ _nay: { message: "Unauthenticated" } });
		const result = await files_metadata_read_full_page(ctx, {
			caller: { kind: "field", membershipId: args.membershipId, target: args.target },
			field: args.field,
			format: "json",
			cursor: args.cursor,
		});
		if (result._nay) return result;
		const { json, cursor, isDone } = result._yay;
		return Result({ _yay: { json, cursor, isDone } });
	},
});
