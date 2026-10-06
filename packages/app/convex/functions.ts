// The app's mutation builders. Every `convex/` module imports `mutation` and `internalMutation`
// from here, never from `_generated/server`, so one wrapper runs around every mutation.
// `functions.test.ts` checks both rules.
//
// Keep value imports here to `_generated`, npm packages and leaf modules. Each mutation module
// imports this file, so an app module imported here would be imported by all of them.

import { customMutation } from "convex-helpers/server/customFunctions";
import {
	internalMutation as raw_internal_mutation,
	mutation as raw_mutation,
	type MutationCtx,
} from "./_generated/server.js";
import { files_pending_overlay_db_flush, files_pending_overlay_db_wrap } from "../server/files-pending-overlay.ts";

/**
 * One customization for both builders. It captures writes to the pending overlay's source tables
 * and flushes the overlay before the mutation ends, in the same transaction.
 */
const customization = {
	args: {},
	input: async (ctx: MutationCtx) => {
		const wrapped = files_pending_overlay_db_wrap(ctx);
		return {
			ctx: wrapped,
			args: {},
			// `onSuccess` gets the raw ctx, so flush the wrapped one that holds the captured writes.
			onSuccess: async () => {
				await files_pending_overlay_db_flush({ ...ctx, ...wrapped });
			},
		};
	},
};

export const mutation = customMutation(raw_mutation, customization);

export const internalMutation = customMutation(raw_internal_mutation, customization);
