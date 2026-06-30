"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server.js";

// Shell diagnostics live with `bash_run_command`, so the Convex action imports
// only the runner and does not need the lower-level shell constants.
import { bash_run_command } from "../server/bash.ts";

export const run = internalAction({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		workspaceName: v.string(),
		projectName: v.string(),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		command: v.string(),
		allowDbFilesMkdir: v.boolean(),
	},
	returns: v.object({
		title: v.string(),
		output: v.string(),
		stdout: v.string(),
		stderr: v.string(),
		metadata: v.object({
			command: v.string(),
			cwd: v.string(),
			nextCwd: v.string(),
			exitCode: v.number(),
			stdoutTruncated: v.boolean(),
			stderrTruncated: v.boolean(),
			stdoutLength: v.number(),
			stderrLength: v.number(),
			pathIndexTruncated: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		return await bash_run_command(ctx, args);
	},
});
