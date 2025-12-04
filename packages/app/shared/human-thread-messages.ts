import type { FunctionReturnType } from "convex/server";
import type { api } from "../convex/_generated/api.js";

export type human_thread_messages_Thread = NonNullable<
	FunctionReturnType<typeof api.human_thread_messages.human_thread_messages_threads_list>["threads"][number]
>;

export type human_thread_messages_Message = NonNullable<
	FunctionReturnType<typeof api.human_thread_messages.human_thread_messages_list>["messages"][number]
>;
