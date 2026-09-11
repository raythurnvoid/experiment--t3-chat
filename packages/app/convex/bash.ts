"use node";

import { v, type Infer } from "convex/values";
import { internalAction } from "./_generated/server.js";

// Shell diagnostics live with `bash_run_command`, so the Convex action imports
// only the runner and does not need the lower-level shell constants.
import { bash_run_command, bash_run_plugin_review_command } from "../server/bash.ts";

const review_scratch = v.object({
	fileNodes: v.array(
		v.object({
			path: v.string(),
			kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
			mode: v.number(),
			size: v.number(),
			mtime: v.number(),
			symlinkTargetPath: v.optional(v.string()),
		}),
	),
	fileNodesContentDict: v.record(v.string(), v.bytes()),
});

export type bash_ReviewScratch = Infer<typeof review_scratch>;

export const run = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		organizationName: v.string(),
		workspaceName: v.string(),
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
			observedPaths: v.array(v.string()),
			observedPathsTruncated: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		return await bash_run_command(ctx, args);
	},
});

export const run_plugin_review = internalAction({
	args: {
		reviewRoot: v.string(),
		userId: v.id("users"),
		command: v.string(),
		cwd: v.string(),
		scratch: review_scratch,
	},
	returns: v.object({
		output: v.string(),
		exitCode: v.number(),
		cwd: v.string(),
		scratch: review_scratch,
	}),
	handler: async (ctx, args) => {
		return await bash_run_plugin_review_command(ctx, args);
	},
});
