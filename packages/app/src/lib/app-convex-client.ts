import { ConvexReactClient } from "convex/react";
import type { ai_chat_Message, ai_chat_Thread } from "./ai-chat.ts";
import type { Doc as app_convex_Doc, Id as app_convex_Id } from "../../convex/_generated/dataModel.js";
import type convex_schema from "../../convex/schema.ts";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { Result } from "./errors-as-values-utils.ts";

// Cannot be import.meta.env.VITE_CONVEX_URL because indirectly imported by the hono server via assistant-ui dep
export const app_convex_deployment_url = import.meta.env
	? (import.meta.env.VITE_CONVEX_URL as string)
	: (process.env.VITE_CONVEX_URL as string);

if (!app_convex_deployment_url) {
	throw new Error("`VITE_CONVEX_URL` env var is not set");
}

export const app_convex = new ConvexReactClient(app_convex_deployment_url);

export { api as app_convex_api } from "../../convex/_generated/api.js";

export type { app_convex_Doc, app_convex_Id };

/**
 * {@link convex_schema}
 */
type ConvexThread = app_convex_Doc<"threads">;

/**
 * {@link convex_schema}
 */
type ConvexMessage = app_convex_Doc<"messages">;

// #region Convex-App adapters

/*
The adapters are necessary because for how Convex is designed the data
in the database can't always match the format defined by Assistant UI,
while it is necessary to ensure our types are compatible with Assistant UI.
*/

/**
 * Converts a Convex thread meta to an App thread.
 *
 * @param convex_thread
 * @returns The adapted thread meta: {@link ai_chat_Thread}
 */
export function app_convex_adapt_convex_to_app_thread(convex_thread: ConvexThread): ai_chat_Thread {
	return {
		id: convex_thread._id,
		title: convex_thread.title,
		last_message_at: new Date(convex_thread.last_message_at),
		external_id: convex_thread.external_id,
		project_id: convex_thread.project_id,
		created_at: new Date(convex_thread._creationTime).toISOString(),
		updated_at: new Date(convex_thread.updated_at).toISOString(),
		workspace_id: convex_thread.workspace_id,
		is_archived: convex_thread.archived,
		metadata: {
			starred: convex_thread.starred,
		},
	};
}

/**
 * Converts a Convex message to an App message.
 *
 * @param convex_message
 * @returns The adapted message: {@link ai_chat_Message}
 */
export function app_convex_adapt_convex_to_app_message(convex_message: ConvexMessage): ai_chat_Message {
	return {
		id: convex_message._id,
		parent_id: convex_message.parent_id,
		thread_id: convex_message.thread_id,
		created_by: convex_message.created_by,
		created_at: new Date(convex_message._creationTime).toISOString(),
		updated_by: convex_message.updated_by,
		updated_at: new Date(convex_message.updated_at).toISOString(),
		format: convex_message.format,
		height: convex_message.height,
		content: convex_message.content as any,
	};
}

// #endregion Convex-App adapters

// #region helpers

export async function app_convex_wait_new_query_value<Q extends FunctionReference<"query", "public">>(
	query: Q,
	queryArgs?: FunctionArgs<Q>,
	args?: {
		signal?: AbortSignal;
	},
) {
	const watcher = app_convex.watchQuery(query, queryArgs);

	let canDispose = true;

	const valuePromise = new Promise<FunctionReturnType<Q> | undefined>((resolve) => {
		args?.signal?.addEventListener(
			"abort",
			() => {
				resolve(undefined);

				if (canDispose) {
					canDispose = false;
					dispose();
				}
			},
			{ once: true },
		);

		const dispose = watcher.onUpdate(() => {
			resolve(watcher.localQueryResult());

			if (canDispose) {
				canDispose = false;
				dispose();
			}
		});
	});

	const value = await valuePromise;

	if (value === undefined && canDispose) {
		return Result({ _nay: { name: "nay_abort", message: args?.signal?.reason?.message ?? "Query aborted" } });
	}

	return Result({ _yay: value });
}

// #endregion helpers
