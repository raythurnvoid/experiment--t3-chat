import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api.js";

export type chat_messages_Thread = NonNullable<
	FunctionReturnType<typeof api.chat_messages.chat_messages_threads_list>["threads"][number]
>;

export type chat_messages_Message = NonNullable<
	FunctionReturnType<typeof api.chat_messages.chat_messages_list>["messages"][number]
>;
