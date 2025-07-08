import { ConvexReactClient } from "convex/react";
import type { ai_chat_Message, ai_chat_Thread } from "./ai_chat.ts";
import type {
	Doc as app_convex_Doc,
	Id as app_convex_Id,
} from "../../convex/_generated/dataModel.js";
import type convex_schema from "../../convex/schema.ts";

// Cannot be import.meta.env.VITE_CONVEX_URL because indirectly imported by the hono server via assistant-ui dep
const deploymentURL = import.meta.env
	? import.meta.env.VITE_CONVEX_URL
	: (process.env.VITE_CONVEX_URL as string);

export const app_convex = new ConvexReactClient(deploymentURL);

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
export function app_convex_adapt_convex_to_app_thread(
	convex_thread: ConvexThread
): ai_chat_Thread {
	return {
		id: convex_thread._id,
		title: convex_thread.title,
		last_message_at: new Date(convex_thread.last_message_at),
		metadata: {
			updated_by: convex_thread.updated_by,
			created_by: convex_thread.created_by,
		},
		external_id: convex_thread.external_id,
		project_id: convex_thread.project_id,
		created_at: new Date(convex_thread._creationTime).toISOString(),
		updated_at: new Date(convex_thread.updated_at).toISOString(),
		workspace_id: convex_thread.workspace_id,
		is_archived: convex_thread.archived,
	};
}

/**
 * Converts a Convex message to an App message.
 *
 * @param convex_message
 * @returns The adapted message: {@link ai_chat_Message}
 */
export function app_convex_adapt_convex_to_app_message(
	convex_message: ConvexMessage
): ai_chat_Message {
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
		content: convex_message.content,
	};
}

// #endregion Convex-App adapters
