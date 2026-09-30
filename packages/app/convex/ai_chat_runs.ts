// One `ai_chat_runs` doc per agent run execution: a `/api/chat` request or one `run_job_wakeup`
// action. A thread has at most one live run. Each run answers one trigger node (a user message or a
// job finish) with one reply node, whose parent never changes. The run saves each model call as a
// step doc. Stop raises the run's generation, and every fenced door refuses the old generation.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import app_convex_schema from "./schema.ts";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import {
	ai_chat_outputs_db_commit_owners,
	ai_chat_outputs_db_prepare_reply,
	ai_chat_outputs_db_release_run,
} from "./ai_chat_outputs.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { get_id_generator } from "../shared/generated-ids.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A run holds the thread's lease this long at most. A Convex action cannot run longer.
 */
export const ai_chat_runs_LEASE_MS = 10 * 60 * 1000;

/**
 * After Stop, the run action calls `finish` within seconds. If it does not, the action is gone, and
 * the run ends here instead of holding the thread until the watchdog. Convex ends an HTTP action when
 * its client disconnects. The AI SDK can also error the response stream when Stop lands during a
 * step ("The stream is not in a state that permits close"), and the action then ends without `finish`.
 */
const STOP_GRACE_MS = 30 * 1000;

/**
 * Ending a run also releases up to 50 reservations and 50 pending owners. Five runs per pass keep
 * one watchdog mutation well under the Convex limits on reads, writes and scheduled functions.
 */
const WATCHDOG_BATCH_SIZE = 5;

/**
 * Walks up or down one branch read one node per step. A longer walk continues in a scheduled
 * mutation, or treats the node as off the branch.
 */
const BRANCH_WALK_MAX = 256;

/**
 * A planned step keeps a tool input inline up to this size. The finished step's parts hold the
 * whole input anyway.
 */
const STEP_INPUT_INLINE_MAX_BYTES = 24 * 1024;

/**
 * Job finishes and claims read per mutation. A thread starts at most a few jobs at a time.
 */
const INBOX_BATCH_SIZE = 50;

/**
 * A tool receipt keeps a result inline up to this size. A bigger result is not kept.
 */
const TOOL_RECEIPT_RESULT_MAX_BYTES = 64 * 1024;

/**
 * One page of the chat view holds at most 50 nodes and about 2 MiB of messages.
 */
const BRANCH_PAGE_MAX_NODES = 50;
const BRANCH_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The branch switcher gets the newest 20 siblings of a node, plus the node itself.
 */
const BRANCH_SIBLINGS_MAX = 20;

/**
 * A compaction summary is short (the summary call writes at most a few thousand tokens). This caps
 * what a wrong model answer can add to every later history walk.
 */
const COMPACTION_SUMMARY_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

function json_bytes(value: unknown) {
	return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
}

/**
 * The key of one tool operation: its run, its provider request and the provider's tool call id.
 * Stored outputs and tool receipts use it, so a replay of the same call finds its earlier work.
 */
export async function ai_chat_runs_op_key(args: {
	runId: Id<"ai_chat_runs">;
	modelCallId: string;
	toolCallId: string;
}) {
	return await crypto_sha256_hex(`${args.runId}:${args.modelCallId}:${args.toolCallId}`);
}

// #region nodes

/**
 * Insert one message node. With `newest: "set"` it becomes the thread's newest node, which the
 * chat shows when no branch is picked. With `newest: "extend"` it becomes the newest node only
 * when it continues the current newest node. A job finish and its wake reply use "extend": they
 * land on the job's own branch, and that must not move the chat away from the branch the user
 * picked.
 */
export async function ai_chat_runs_db_insert_node(
	ctx: MutationCtx,
	args: {
		thread: Doc<"ai_chat_threads">;
		parentId: Id<"ai_chat_threads_messages_aisdk_5"> | null;
		createdBy: Id<"users">;
		clientGeneratedMessageId: string;
		content: Record<string, unknown>;
		status: Doc<"ai_chat_threads_messages_aisdk_5">["status"];
		runId: Id<"ai_chat_runs"> | null;
		wakePending: boolean;
		jobFinishInvocationId: Id<"ai_chat_bash_invocations"> | null;
		newest: "set" | "extend";
		now: number;
	},
) {
	const nodeId = await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
		organizationId: args.thread.organizationId,
		workspaceId: args.thread.workspaceId,
		parentId: args.parentId,
		threadId: args.thread._id,
		createdBy: args.createdBy,
		updatedAt: args.now,
		clientGeneratedMessageId: args.clientGeneratedMessageId,
		content: args.content,
		status: args.status,
		runId: args.runId,
		version: 0,
		wakePending: args.wakePending,
		bytes: json_bytes(args.content),
		...(args.jobFinishInvocationId ? { jobFinishInvocationId: args.jobFinishInvocationId } : {}),
	});
	// Read the thread again: an earlier insert in this mutation may have moved its newest node.
	const thread = await ctx.db.get("ai_chat_threads", args.thread._id);
	await ctx.db.patch("ai_chat_threads", args.thread._id, {
		...(args.newest === "set" || thread?.newestNodeId === args.parentId ? { newestNodeId: nodeId } : {}),
		lastMessageAt: args.now,
		updatedAt: args.now,
		updatedBy: args.createdBy,
	});
	return nodeId;
}

/**
 * The newest child of a node, or of the thread root when `parentId` is null.
 */
async function db_newest_child(
	ctx: QueryCtx | MutationCtx,
	args: { threadId: Id<"ai_chat_threads">; parentId: Id<"ai_chat_threads_messages_aisdk_5"> | null },
) {
	return await ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_thread_parent", (q) => q.eq("threadId", args.threadId).eq("parentId", args.parentId))
		.order("desc")
		.first();
}

/**
 * The leaf below a node, following the newest child. Returns `reachedLeaf: false` when the walk
 * stopped at its limit, so the caller can continue from `node` later.
 */
async function db_walk_to_leaf(
	ctx: QueryCtx | MutationCtx,
	args: { threadId: Id<"ai_chat_threads">; fromId: Id<"ai_chat_threads_messages_aisdk_5"> },
) {
	let nodeId = args.fromId;
	for (let step = 0; step < BRANCH_WALK_MAX; step++) {
		const child = await db_newest_child(ctx, { threadId: args.threadId, parentId: nodeId });
		if (!child) return { nodeId, reachedLeaf: true };
		nodeId = child._id;
	}
	return { nodeId, reachedLeaf: false };
}

/**
 * Whether `originId` is `replyId` or one of its ancestors. An origin more than 256 nodes up counts as
 * off the branch: its finish then waits for its own wake run.
 */
async function db_is_on_branch(
	ctx: QueryCtx | MutationCtx,
	args: { originId: Id<"ai_chat_threads_messages_aisdk_5">; replyId: Id<"ai_chat_threads_messages_aisdk_5"> },
) {
	let nodeId: Id<"ai_chat_threads_messages_aisdk_5"> | null = args.replyId;
	for (let step = 0; nodeId !== null && step < BRANCH_WALK_MAX; step++) {
		if (nodeId === args.originId) return true;
		const node: Doc<"ai_chat_threads_messages_aisdk_5"> | null = await ctx.db.get(
			"ai_chat_threads_messages_aisdk_5",
			nodeId,
		);
		nodeId = node?.parentId ?? null;
	}
	return false;
}

/**
 * The UI message of a node. A reply node has no `parts` in its content: it keeps them in its step
 * docs, in step order. A reply has at most 25 steps.
 */
async function db_ui_message(ctx: QueryCtx | MutationCtx, node: Doc<"ai_chat_threads_messages_aisdk_5">) {
	if (Array.isArray(node.content.parts)) return node.content;
	const steps = await ctx.db
		.query("ai_chat_run_steps")
		.withIndex("by_message_stepIndex", (q) => q.eq("messageId", node._id))
		.collect();
	return { ...node.content, parts: steps.flatMap((step) => step.parts) };
}

// #endregion nodes

// #region lifecycle

/**
 * Take the thread's one run lease, and insert the run doc and its reply node below the trigger.
 * Returns null while another run holds the lease: a thread runs one agent at a time.
 */
export async function ai_chat_runs_db_begin(
	ctx: MutationCtx,
	args: {
		thread: Doc<"ai_chat_threads">;
		kind: Doc<"ai_chat_runs">["kind"];
		source: Pick<
			Doc<"ai_chat_runs">,
			"organizationId" | "workspaceId" | "userId" | "membershipId" | "membershipLifetime"
		>;
		triggerId: Id<"ai_chat_threads_messages_aisdk_5">;
		modeId: Doc<"ai_chat_runs">["modeId"];
		modelId: Doc<"ai_chat_runs">["modelId"];
		now: number;
	},
) {
	const { thread, now } = args;
	if (thread.activeRun && thread.activeRun.expiresAt > now) return null;
	// A run whose lease passed without a run end (its action died) ends here, before the next run
	// starts. Its waiting job finishes then go to its own branch, not to the new run. The finishes
	// wake at the end of the new run.
	if (thread.activeRun) {
		await db_end(ctx, { runId: thread.activeRun.runId, outcome: "failed", now, startWake: false });
	}

	const replyClientGeneratedId = get_id_generator("ai_message")();
	const replyId = await ai_chat_runs_db_insert_node(ctx, {
		thread,
		parentId: args.triggerId,
		createdBy: args.source.userId,
		clientGeneratedMessageId: replyClientGeneratedId,
		content: { id: replyClientGeneratedId, role: "assistant" },
		status: "streaming",
		runId: null,
		wakePending: false,
		jobFinishInvocationId: null,
		newest: args.kind === "job_wakeup" ? "extend" : "set",
		now,
	});
	const leaseExpiresAt = now + ai_chat_runs_LEASE_MS;
	const runId = await ctx.db.insert("ai_chat_runs", {
		organizationId: args.source.organizationId,
		workspaceId: args.source.workspaceId,
		threadId: thread._id,
		userId: args.source.userId,
		membershipId: args.source.membershipId,
		membershipLifetime: args.source.membershipLifetime,
		kind: args.kind,
		status: "running",
		generation: 1,
		triggerId: args.triggerId,
		replyId,
		modeId: args.modeId,
		modelId: args.modelId,
		heartbeatAt: now,
		stopRequestedAt: null,
		completedSteps: 0,
		leaseExpiresAt,
		endedAt: null,
	});
	await ctx.db.patch("ai_chat_threads_messages_aisdk_5", replyId, { runId });
	await ctx.db.patch("ai_chat_threads", thread._id, {
		activeRun: { kind: args.kind, expiresAt: leaseExpiresAt, runId, generation: 1 },
	});
	return { runId, replyId, replyClientGeneratedId, generation: 1 };
}

/**
 * Whether a write of this run generation may still happen: the run runs, and Stop has not raised
 * its generation.
 */
export async function ai_chat_runs_db_is_current(
	ctx: QueryCtx | MutationCtx,
	fence: { runId: Id<"ai_chat_runs">; generation: number },
) {
	const run = await ctx.db.get("ai_chat_runs", fence.runId);
	return run?.status === "running" && run.generation === fence.generation;
}

/**
 * Stop a running run. From now on every fenced door refuses the old generation. The run's action
 * sees the new generation, stops streaming and saves what it has through `finish`.
 */
export async function ai_chat_runs_db_stop(ctx: MutationCtx, args: { run: Doc<"ai_chat_runs">; now: number }) {
	const { run } = args;
	if (run.status !== "running") return;
	const generation = run.generation + 1;
	await ctx.db.patch("ai_chat_runs", run._id, { status: "stopping", generation, stopRequestedAt: args.now });
	await ctx.scheduler.runAfter(STOP_GRACE_MS, internal.ai_chat_runs.end_stopped_run, { runId: run._id, generation });
	const thread = await ctx.db.get("ai_chat_threads", run.threadId);
	if (thread?.activeRun?.runId === run._id) {
		await ctx.db.patch("ai_chat_threads", thread._id, { activeRun: { ...thread.activeRun, generation } });
	}
}

/**
 * Stop the run that streams in a chat, from any tab. A chat with no live run does nothing.
 * `replyId` is the streaming reply the user saw. A Stop that arrives after that run ended must not
 * stop the next run, such as a job wake run. Null stops whatever run is live.
 */
export const stop = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		replyId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return authorized;

		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (
			!thread ||
			thread.deletingAt !== undefined ||
			thread.copyingAt !== undefined ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId ||
			thread.createdBy !== userAuth.id
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const run = thread.activeRun ? await ctx.db.get("ai_chat_runs", thread.activeRun.runId) : null;
		if (run && (args.replyId === null || run.replyId === args.replyId)) {
			await ai_chat_runs_db_stop(ctx, { run, now: Date.now() });
		}
		return Result({ _yay: null });
	},
});

/**
 * What the run's action polls to notice Stop: the current generation and status.
 */
export const get_state = internalQuery({
	args: { runId: v.id("ai_chat_runs") },
	returns: v.union(
		v.object({ status: doc(app_convex_schema, "ai_chat_runs").fields.status, generation: v.number() }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		return run ? { status: run.status, generation: run.generation } : null;
	},
});

/**
 * Save one step doc, and delete the job finishes the step claimed: the step's parts show them now.
 */
async function db_save_step(
	ctx: MutationCtx,
	args: {
		run: Doc<"ai_chat_runs">;
		generation: number;
		stepIndex: number;
		status: "done" | "partial";
		parts: unknown[];
		finishReason: string | null;
		now: number;
	},
) {
	const { run } = args;

	// The job finishes this step claimed show at the start of its parts. The claims are deleted
	// below, so each finish is saved once: here or, if the step never saves, as a finish message.
	// A partial step saved at Stop holds every step the browser stream had not saved yet, so it
	// takes the claims of those later steps too. The model already saw them.
	const claims = (
		await ctx.db
			.query("ai_chat_run_inbox")
			.withIndex("by_thread_state", (q) => q.eq("threadId", run.threadId).eq("state", "claimed"))
			.take(INBOX_BATCH_SIZE)
	).filter(
		(inboxDoc) =>
			inboxDoc.claim?.runId === run._id &&
			(args.status === "partial"
				? inboxDoc.claim.stepIndex >= args.stepIndex
				: inboxDoc.claim.stepIndex === args.stepIndex),
	);
	const prepared = await ai_chat_outputs_db_prepare_reply(ctx, {
		runId: run._id,
		threadId: run.threadId,
		content: {
			parts: [...claims.map((inboxDoc) => ({ type: "data-job-finish", data: { text: inboxDoc.text } })), ...args.parts],
		},
	});
	const parts = prepared.content.parts;

	const existing = await ctx.db
		.query("ai_chat_run_steps")
		.withIndex("by_message_stepIndex", (q) => q.eq("messageId", run.replyId).eq("stepIndex", args.stepIndex))
		.first();
	const bytes = json_bytes(parts) + (existing ? json_bytes(existing.toolCalls) : 0);
	if (existing) {
		await ctx.db.patch("ai_chat_run_steps", existing._id, {
			status: args.status,
			parts,
			finishReason: args.finishReason,
			bytes,
		});
	} else {
		await ctx.db.insert("ai_chat_run_steps", {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			threadId: run.threadId,
			messageId: run.replyId,
			runId: run._id,
			generation: args.generation,
			stepIndex: args.stepIndex,
			// The usage save plans every step whose request finished. Only a step cut off before that
			// gets here with no plan.
			modelCallId: null,
			status: args.status,
			toolCalls: [],
			parts,
			finishReason: args.finishReason,
			bytes,
		});
	}
	await ai_chat_outputs_db_commit_owners(ctx, prepared.ownerIds);
	for (const inboxDoc of claims) {
		await ctx.db.delete("ai_chat_run_inbox", inboxDoc._id);
	}

	const reply = await ctx.db.get("ai_chat_threads_messages_aisdk_5", run.replyId);
	if (reply) {
		await ctx.db.patch("ai_chat_threads_messages_aisdk_5", reply._id, {
			version: reply.version + 1,
			bytes: reply.bytes + bytes - (existing?.bytes ?? 0),
			updatedAt: args.now,
		});
	}
	await ctx.db.patch("ai_chat_runs", run._id, {
		completedSteps: Math.max(run.completedSteps, args.stepIndex + 1),
		heartbeatAt: args.now,
	});
}

/**
 * Plan one step doc in the transaction that saves the step's usage, before any of its tools start.
 * A step whose generation is already stale (Stop won the race) gets no doc and no tools. The usage
 * save around it still commits: billing never waits for Stop.
 */
export async function ai_chat_runs_db_plan_step(
	ctx: MutationCtx,
	args: {
		runId: Id<"ai_chat_runs">;
		generation: number;
		stepIndex: number;
		modelCallId: string;
		toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
	},
) {
	const run = await ctx.db.get("ai_chat_runs", args.runId);
	if (!run || run.status !== "running" || run.generation !== args.generation) return { toolsAllowed: false };

	// A save retried after a timeout finds the doc it already planned.
	const existing = await ctx.db
		.query("ai_chat_run_steps")
		.withIndex("by_message_stepIndex", (q) => q.eq("messageId", run.replyId).eq("stepIndex", args.stepIndex))
		.first();
	if (existing) return { toolsAllowed: true };

	const toolCalls = await Promise.all(
		args.toolCalls.map(async (call) => {
			const inputJson = JSON.stringify(call.input) ?? "null";
			const bytes = encoder.encode(inputJson).byteLength;
			return {
				providerToolCallId: call.toolCallId,
				opKey: await ai_chat_runs_op_key({
					runId: run._id,
					modelCallId: args.modelCallId,
					toolCallId: call.toolCallId,
				}),
				toolName: call.toolName,
				input:
					bytes <= STEP_INPUT_INLINE_MAX_BYTES
						? { kind: "inline" as const, value: call.input }
						: { kind: "omitted" as const, bytes, sha256: await crypto_sha256_hex(inputJson) },
			};
		}),
	);
	await ctx.db.insert("ai_chat_run_steps", {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		threadId: run.threadId,
		messageId: run.replyId,
		runId: run._id,
		generation: args.generation,
		stepIndex: args.stepIndex,
		modelCallId: args.modelCallId,
		status: "tools_running",
		toolCalls,
		parts: [],
		finishReason: null,
		bytes: json_bytes(toolCalls),
	});
	return { toolsAllowed: true };
}

/**
 * Complete one step of a running run at its end. Returns `saved: false` when Stop already raised
 * the generation: the run's `finish` then saves what it has as the stopped step.
 */
export const step_complete = internalMutation({
	args: {
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		stepIndex: v.number(),
		parts: v.array(v.any()),
		finishReason: v.union(v.string(), v.null()),
	},
	returns: v.object({ saved: v.boolean() }),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (!run || run.status !== "running" || run.generation !== args.generation) return { saved: false };
		// A member who lost access gets no more reply steps. Stop the run, so its next tool call is
		// refused too.
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, run))) {
			// Log the dropped step (rule 11). Ids only, never the reply text.
			console.error("Chat data not saved", {
				reason: "access_lost",
				threadId: run.threadId,
				runId: run._id,
				messageId: run.replyId,
			});
			await ai_chat_runs_db_stop(ctx, { run, now: Date.now() });
			return { saved: false };
		}
		await db_save_step(ctx, {
			run,
			generation: args.generation,
			stepIndex: args.stepIndex,
			status: "done",
			parts: args.parts,
			finishReason: args.finishReason,
			now: Date.now(),
		});
		return { saved: true };
	},
});

/**
 * Claim the job finishes waiting for this run at a step boundary. Waiting docs exist only while
 * their run lives, because the run end turns them into finish messages. So every waiting doc of
 * the thread belongs to this run's branch.
 */
export const claim_inbox = internalMutation({
	args: { runId: v.id("ai_chat_runs"), generation: v.number(), stepIndex: v.number() },
	returns: v.array(v.object({ inboxId: v.id("ai_chat_run_inbox"), text: v.string() })),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (!run || run.status !== "running" || run.generation !== args.generation) return [];
		const waiting = await ctx.db
			.query("ai_chat_run_inbox")
			.withIndex("by_thread_state", (q) => q.eq("threadId", run.threadId).eq("state", "waiting"))
			.take(INBOX_BATCH_SIZE);
		for (const inboxDoc of waiting) {
			await ctx.db.patch("ai_chat_run_inbox", inboxDoc._id, {
				state: "claimed",
				claim: { runId: run._id, generation: args.generation, stepIndex: args.stepIndex },
			});
		}
		return waiting.map((inboxDoc) => ({ inboxId: inboxDoc._id, text: inboxDoc.text }));
	},
});

/**
 * The last write of a run's action, on every end path. It saves the unfinished step (after Stop,
 * an error or an abort) and ends the run. After Stop, this is the only write the old generation
 * may still make.
 */
export const finish = internalMutation({
	args: {
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		outcome: v.union(v.literal("done"), v.literal("stopped"), v.literal("failed")),
		tail: v.union(v.object({ stepIndex: v.number(), parts: v.array(v.any()) }), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (!run) return null;
		if (run.status === "ended") {
			// The Stop grace end or the watchdog ended the run first. Log the tail it drops (rule 11).
			if (args.tail && args.tail.parts.length > 0) {
				console.error("Chat data not saved", {
					reason: "run_already_ended",
					threadId: run.threadId,
					runId: run._id,
					messageId: run.replyId,
				});
			}
			return null;
		}
		const now = Date.now();

		const tailAllowed =
			(run.status === "running" && run.generation === args.generation) ||
			(run.status === "stopping" && run.generation === args.generation + 1);
		if (
			args.tail &&
			args.tail.parts.length > 0 &&
			tailAllowed &&
			(await ai_chat_files_db_get_invocation_membership(ctx, run))
		) {
			await db_save_step(ctx, {
				run,
				generation: args.generation,
				stepIndex: args.tail.stepIndex,
				status: "partial",
				// The provider metadata holds OpenAI item ids of a response that never finished. OpenAI does
				// not keep those items, so the next turn fails with "Item not found" if it sends them back.
				parts: args.tail.parts.map((part: Record<string, unknown>) => {
					const { providerMetadata: _providerMetadata, callProviderMetadata: _callProviderMetadata, ...rest } = part;
					return rest;
				}),
				finishReason: null,
				now,
			});
		}

		await db_end(ctx, { runId: run._id, outcome: args.outcome, now, startWake: true });
		return null;
	},
});

/**
 * End a stopped run whose action never called `finish`. A later Stop of the same run does nothing
 * here, because only a run still stopping at this generation ends.
 */
export const end_stopped_run = internalMutation({
	args: { runId: v.id("ai_chat_runs"), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (run?.status !== "stopping" || run.generation !== args.generation) return null;
		// The step the action held in memory, if any, is lost with it (rule 11).
		console.error("Chat data not saved", {
			reason: "finish_missing",
			threadId: run.threadId,
			runId: run._id,
			messageId: run.replyId,
		});
		await db_end(ctx, { runId: run._id, outcome: "stopped", now: Date.now(), startWake: true });
		return null;
	},
});

/**
 * End a run on any path: its action's `finish`, the Stop grace end, or the watchdog after a killed
 * action. Claims go back first, so no job finish is lost. Then the waiting finishes become finish
 * messages under the reply, and the next wake starts. Ending an ended run does nothing.
 *
 * The run also gives back the output reservations and pending output owners it left. An attach
 * that arrives later is refused, because the run is no longer running.
 */
async function db_end(
	ctx: MutationCtx,
	args: { runId: Id<"ai_chat_runs">; outcome: "done" | "stopped" | "failed"; now: number; startWake: boolean },
) {
	const run = await ctx.db.get("ai_chat_runs", args.runId);
	if (!run || run.status === "ended") return;
	await ctx.db.patch("ai_chat_runs", run._id, { status: "ended", endedAt: args.now });

	if (await ai_chat_outputs_db_release_run(ctx, run._id)) {
		await ctx.scheduler.runAfter(0, internal.ai_chat_outputs.release_run, { runId: run._id });
	}

	// Claims the run never committed go back to waiting.
	const claimed = await ctx.db
		.query("ai_chat_run_inbox")
		.withIndex("by_thread_state", (q) => q.eq("threadId", run.threadId).eq("state", "claimed"))
		.take(INBOX_BATCH_SIZE);
	for (const inboxDoc of claimed) {
		if (inboxDoc.claim?.runId === run._id) {
			await ctx.db.patch("ai_chat_run_inbox", inboxDoc._id, { state: "waiting", claim: null });
		}
	}

	// A step planned before a crash never completed. Keep its tool calls as a partial step.
	const steps = await ctx.db
		.query("ai_chat_run_steps")
		.withIndex("by_message_stepIndex", (q) => q.eq("messageId", run.replyId))
		.collect();
	for (const step of steps) {
		if (step.status === "tools_running") await ctx.db.patch("ai_chat_run_steps", step._id, { status: "partial" });
	}

	const reply = await ctx.db.get("ai_chat_threads_messages_aisdk_5", run.replyId);
	if (reply) {
		await ctx.db.patch("ai_chat_threads_messages_aisdk_5", reply._id, {
			status: run.status === "stopping" ? "stopped" : args.outcome,
			version: reply.version + 1,
			updatedAt: args.now,
		});
	}

	const thread = await ctx.db.get("ai_chat_threads", run.threadId);
	if (!thread) return;
	if (thread.activeRun?.runId === run._id) {
		await ctx.db.patch("ai_chat_threads", thread._id, { activeRun: undefined });
	}
	// Delete chat drains everything; start no more work there.
	if (thread.deletingAt !== undefined || thread.copyingAt !== undefined) return;

	// Finishes still waiting for this run become finish messages chained under its reply, oldest
	// first. The wake below answers the newest of them, with the others in its history.
	const waiting = await ctx.db
		.query("ai_chat_run_inbox")
		.withIndex("by_thread_state", (q) => q.eq("threadId", run.threadId).eq("state", "waiting"))
		.take(INBOX_BATCH_SIZE);
	let parentId = run.replyId;
	for (const inboxDoc of waiting) {
		parentId = await db_insert_finish_node(ctx, {
			thread,
			parentId,
			invocationId: inboxDoc.invocationId,
			userId: run.userId,
			text: inboxDoc.text,
			now: args.now,
		});
		await ctx.db.delete("ai_chat_run_inbox", inboxDoc._id);
	}

	if (args.startWake) {
		await db_wake_select(ctx, { threadId: thread._id, endedReplyId: run.replyId, now: args.now });
	}
}

/**
 * End runs whose lease passed without a run end, for example after a killed action.
 */
export const end_expired_runs = internalMutation({
	args: { _test_now: v.optional(v.number()), _test_disableReschedule: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const expired = [
			...(await ctx.db
				.query("ai_chat_runs")
				.withIndex("by_status_leaseExpiresAt", (q) => q.eq("status", "running").lte("leaseExpiresAt", now))
				.take(WATCHDOG_BATCH_SIZE)),
			...(await ctx.db
				.query("ai_chat_runs")
				.withIndex("by_status_leaseExpiresAt", (q) => q.eq("status", "stopping").lte("leaseExpiresAt", now))
				.take(WATCHDOG_BATCH_SIZE)),
		];
		for (const run of expired) {
			await db_end(ctx, { runId: run._id, outcome: "failed", now, startWake: true });
		}

		// A full batch means more runs may still be waiting.
		if (expired.length >= WATCHDOG_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.ai_chat_runs.end_expired_runs, {});
		}
		return null;
	},
});

// #endregion lifecycle

// #region job finishes

async function db_insert_finish_node(
	ctx: MutationCtx,
	args: {
		thread: Doc<"ai_chat_threads">;
		parentId: Id<"ai_chat_threads_messages_aisdk_5">;
		invocationId: Id<"ai_chat_bash_invocations">;
		userId: Id<"users">;
		text: string;
		now: number;
	},
) {
	const messageId = get_id_generator("ai_message")();
	return await ai_chat_runs_db_insert_node(ctx, {
		thread: args.thread,
		parentId: args.parentId,
		createdBy: args.userId,
		clientGeneratedMessageId: messageId,
		content: { id: messageId, role: "system", parts: [{ type: "text", text: args.text }] },
		status: "done",
		runId: null,
		wakePending: true,
		jobFinishInvocationId: args.invocationId,
		newest: "extend",
		now: args.now,
	});
}

/**
 * Deliver a finished job's message to its origin branch. While the run on that branch streams,
 * the finish waits in the run's inbox and shows inside the reply at the next step. Otherwise it
 * becomes a finish message under the leaf of the origin branch, and a wake run answers it.
 */
export async function ai_chat_runs_db_add_job_finish(
	ctx: MutationCtx,
	args: { invocation: Doc<"ai_chat_bash_invocations">; text: string; now: number },
) {
	const { invocation } = args;
	const thread = await ctx.db.get("ai_chat_threads", invocation.threadId);
	if (!thread) throw should_never_happen("Job thread not found", { threadId: invocation.threadId });
	// Only a job started outside a chat run (tests) has no origin reply. It goes under the newest node.
	const originReplyId = invocation.originReplyId ?? thread.newestNodeId;
	if (!originReplyId) throw should_never_happen("Job has no branch", { invocationId: invocation._id });

	const liveRun =
		thread.activeRun && thread.activeRun.expiresAt > args.now
			? await ctx.db.get("ai_chat_runs", thread.activeRun.runId)
			: null;
	if (
		liveRun &&
		liveRun.status !== "ended" &&
		(await db_is_on_branch(ctx, { originId: originReplyId, replyId: liveRun.replyId }))
	) {
		await ctx.db.insert("ai_chat_run_inbox", {
			organizationId: invocation.organizationId,
			workspaceId: invocation.workspaceId,
			threadId: thread._id,
			invocationId: invocation._id,
			text: args.text,
			state: "waiting",
			claim: null,
		});
		return;
	}

	await db_place_finish(ctx, {
		threadId: thread._id,
		invocationId: invocation._id,
		fromId: originReplyId,
		text: args.text,
		now: args.now,
	});
}

async function db_place_finish(
	ctx: MutationCtx,
	args: {
		threadId: Id<"ai_chat_threads">;
		invocationId: Id<"ai_chat_bash_invocations">;
		fromId: Id<"ai_chat_threads_messages_aisdk_5">;
		text: string;
		now: number;
	},
) {
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	if (!thread || thread.deletingAt !== undefined || thread.copyingAt !== undefined) return;
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	if (!invocation) return;

	const leaf = await db_walk_to_leaf(ctx, { threadId: thread._id, fromId: args.fromId });
	// A very long branch: continue the walk in a new mutation. The finish is placed under the leaf
	// found when the walk ends, so its branch is fixed at insert time.
	if (!leaf.reachedLeaf) {
		await ctx.scheduler.runAfter(0, internal.ai_chat_runs.place_finish, {
			threadId: thread._id,
			invocationId: invocation._id,
			fromId: leaf.nodeId,
			text: args.text,
		});
		return;
	}

	await db_insert_finish_node(ctx, {
		thread,
		parentId: leaf.nodeId,
		invocationId: invocation._id,
		userId: invocation.userId,
		text: args.text,
		now: args.now,
	});
	await db_wake_select(ctx, { threadId: thread._id, endedReplyId: null, now: args.now });
}

export const place_finish = internalMutation({
	args: {
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
		fromId: v.id("ai_chat_threads_messages_aisdk_5"),
		text: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await db_place_finish(ctx, { ...args, now: Date.now() });
		return null;
	},
});

/**
 * Start the next wake run when the thread has no live run. It picks one trigger: the deepest
 * waiting finish below the reply that just ended. Else it takes the oldest waiting finish in the
 * thread, or the deepest waiting finish below it.
 * One transaction clears the pick's `wakePending`, inserts the run and its reply, and takes the
 * lease, so a replay finds nothing to pick.
 */
async function db_wake_select(
	ctx: MutationCtx,
	args: {
		threadId: Id<"ai_chat_threads">;
		endedReplyId: Id<"ai_chat_threads_messages_aisdk_5"> | null;
		now: number;
	},
) {
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	if (!thread || thread.deletingAt !== undefined || thread.copyingAt !== undefined) return;
	if (thread.activeRun && thread.activeRun.expiresAt > args.now) return;

	// The deepest waiting finish in the chain of finish messages below a node. The wake answers it,
	// so the finishes above it are in its history.
	const deepest_waiting_finish = async (fromId: Id<"ai_chat_threads_messages_aisdk_5">) => {
		let found: Doc<"ai_chat_threads_messages_aisdk_5"> | null = null;
		let node = await db_newest_child(ctx, { threadId: thread._id, parentId: fromId });
		for (let step = 0; node?.jobFinishInvocationId !== undefined && step < BRANCH_WALK_MAX; step++) {
			if (node.wakePending) found = node;
			node = await db_newest_child(ctx, { threadId: thread._id, parentId: node._id });
		}
		return found;
	};

	let trigger = args.endedReplyId ? await deepest_waiting_finish(args.endedReplyId) : null;
	if (!trigger) {
		const oldest = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("by_thread_wakePending", (q) => q.eq("threadId", thread._id).eq("wakePending", true))
			.first();
		if (!oldest) return;
		trigger = (await deepest_waiting_finish(oldest._id)) ?? oldest;
	}

	// The wake run answers the trigger with the finishes above it in its history, so none of them
	// may start a wake of its own.
	let node: Doc<"ai_chat_threads_messages_aisdk_5"> | null = trigger;
	for (let step = 0; node?.jobFinishInvocationId !== undefined && step < BRANCH_WALK_MAX; step++) {
		if (node.wakePending) await ctx.db.patch("ai_chat_threads_messages_aisdk_5", node._id, { wakePending: false });
		node = node.parentId ? await ctx.db.get("ai_chat_threads_messages_aisdk_5", node.parentId) : null;
	}

	const invocation = trigger.jobFinishInvocationId
		? await ctx.db.get("ai_chat_bash_invocations", trigger.jobFinishInvocationId)
		: null;
	if (!invocation?.job) return;
	// A member who lost access gets no wake run. The finish message stays in the chat.
	const membership = await ai_chat_files_db_get_invocation_membership(ctx, invocation);
	if (!membership) return;

	const begun = await ai_chat_runs_db_begin(ctx, {
		thread,
		kind: "job_wakeup",
		source: invocation,
		triggerId: trigger._id,
		modeId: invocation.job.allowDbFilesMkdir ? "agent" : "ask",
		modelId: invocation.job.wakeAgent?.modelId ?? ai_chat_DEFAULT_MODEL_ID,
		now: args.now,
	});
	if (!begun) return;
	await ctx.scheduler.runAfter(0, internal.ai_chat.run_job_wakeup, { runId: begun.runId });
}

// #endregion job finishes

// #region tool receipts

/**
 * Start one Files write or code run of a tool call. The receipt is keyed by the call's operation
 * key, so a replay of the same call finds its saved result instead of running twice, and a
 * different input under the same key is refused. A call of a stopped run never starts.
 */
export const tool_receipt_begin = internalMutation({
	args: {
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		opKey: v.string(),
		toolName: v.string(),
		inputHash: v.string(),
	},
	returns: v.union(
		v.object({ kind: v.literal("start") }),
		v.object({ kind: v.literal("replay"), result: v.any() }),
		v.object({ kind: v.literal("refused"), message: v.string() }),
	),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (!run || run.status !== "running" || run.generation !== args.generation) {
			return { kind: "refused" as const, message: "Stopped. This call was not run." };
		}

		const existing = await ctx.db
			.query("ai_chat_tool_receipts")
			.withIndex("by_thread_opKey", (q) => q.eq("threadId", run.threadId).eq("opKey", args.opKey))
			.first();
		if (existing) {
			if (existing.toolName !== args.toolName || existing.inputHash !== args.inputHash) {
				return { kind: "refused" as const, message: "This tool call already ran with another input." };
			}
			if (existing.status === "finished" && existing.result !== null) {
				return { kind: "replay" as const, result: existing.result };
			}
			// The earlier attempt may have written already. Running it again could write twice.
			return {
				kind: "refused" as const,
				message: "This tool call already started. Check its result before trying again.",
			};
		}

		await ctx.db.insert("ai_chat_tool_receipts", {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			threadId: run.threadId,
			opKey: args.opKey,
			runId: run._id,
			generation: args.generation,
			toolName: args.toolName,
			inputHash: args.inputHash,
			status: "started",
			result: null,
		});
		return { kind: "start" as const };
	},
});

/**
 * Save the result of a started tool receipt. A result over 64 KiB is not kept: a replay of that
 * call is refused instead.
 */
export const tool_receipt_finish = internalMutation({
	args: { threadId: v.id("ai_chat_threads"), opKey: v.string(), result: v.any() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await ctx.db
			.query("ai_chat_tool_receipts")
			.withIndex("by_thread_opKey", (q) => q.eq("threadId", args.threadId).eq("opKey", args.opKey))
			.first();
		if (!receipt || receipt.status === "finished") return null;
		await ctx.db.patch("ai_chat_tool_receipts", receipt._id, {
			status: "finished",
			result: json_bytes(args.result) <= TOOL_RECEIPT_RESULT_MAX_BYTES ? args.result : null,
		});
		return null;
	},
});

// #endregion tool receipts

// #region history

/**
 * One page of the branch the chat view shows, newest node first. The branch goes from the root
 * through `anchorId` (or the thread's newest node) and down the newest children to a leaf.
 * `fromId` starts an older page at that node. A page ends before `stopId`, where the next loaded
 * page starts. Each node carries its siblings' ids, oldest first, for the branch switcher.
 */
export const branch_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		anchorId: v.union(v.string(), v.null()),
		fromId: v.union(v.string(), v.null()),
		stopId: v.union(v.string(), v.null()),
	},
	returns: v.union(
		v.object({
			nodes: v.array(
				v.object({
					_id: v.id("ai_chat_threads_messages_aisdk_5"),
					parentId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
					clientGeneratedMessageId: v.string(),
					status: doc(app_convex_schema, "ai_chat_threads_messages_aisdk_5").fields.status,
					version: v.number(),
					content: v.any(),
					siblingIds: v.array(v.id("ai_chat_threads_messages_aisdk_5")),
				}),
			),
			/**
			 * Where the next older page starts, or null at the root.
			 */
			nextId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return null;

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		const thread = threadId ? await ctx.db.get("ai_chat_threads", threadId) : null;
		if (
			!thread ||
			thread.deletingAt !== undefined ||
			thread.copyingAt !== undefined ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId ||
			thread.createdBy !== userAuth.id
		) {
			return null;
		}

		// An older page starts where the client asks. The newest page starts at the leaf of the shown
		// branch. An anchor from another thread falls back to the newest node.
		const normalizeNodeId = (id: string | null) =>
			id === null ? null : ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", id);
		let nodeId = normalizeNodeId(args.fromId);
		if (!nodeId) {
			const anchorId = normalizeNodeId(args.anchorId);
			const anchor = anchorId ? await ctx.db.get("ai_chat_threads_messages_aisdk_5", anchorId) : null;
			const startId = anchor?.threadId === thread._id ? anchor._id : thread.newestNodeId;
			nodeId = startId ? (await db_walk_to_leaf(ctx, { threadId: thread._id, fromId: startId })).nodeId : null;
		}
		const stopId = normalizeNodeId(args.stopId);

		const nodes = [];
		let bytes = 0;
		while (nodeId !== null && nodeId !== stopId && nodes.length < BRANCH_PAGE_MAX_NODES) {
			const node: Doc<"ai_chat_threads_messages_aisdk_5"> | null = await ctx.db.get(
				"ai_chat_threads_messages_aisdk_5",
				nodeId,
			);
			if (!node || node.threadId !== thread._id) {
				nodeId = null;
				break;
			}
			if (nodes.length > 0 && bytes + node.bytes > BRANCH_PAGE_MAX_BYTES) break;

			const siblings = await ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_thread_parent", (q) => q.eq("threadId", thread._id).eq("parentId", node.parentId))
				.order("desc")
				.take(BRANCH_SIBLINGS_MAX);
			const siblingIds = siblings.map((sibling) => sibling._id).reverse();
			// The node is older than the newest siblings, so it goes first.
			if (!siblingIds.includes(node._id)) siblingIds.unshift(node._id);

			nodes.push({
				_id: node._id,
				parentId: node.parentId,
				clientGeneratedMessageId: node.clientGeneratedMessageId,
				status: node.status,
				version: node.version,
				content: await db_ui_message(ctx, node),
				siblingIds,
			});
			bytes += node.bytes;
			nodeId = node.parentId;
		}
		return { nodes, nextId: nodeId };
	},
});

/**
 * One page of a branch for the model, walking up from `fromId`. The caller asks for pages until
 * `full` or until `nextId` is null, and passes `usedBytes` and `hasUserMessage` on. The walk stops
 * at `maxBytes` in total, but the first node of the branch is always in.
 */
export const history_page = internalQuery({
	args: {
		threadId: v.id("ai_chat_threads"),
		fromId: v.id("ai_chat_threads_messages_aisdk_5"),
		usedBytes: v.number(),
		maxBytes: v.number(),
		hasUserMessage: v.boolean(),
	},
	returns: v.object({
		messages: v.array(
			v.object({
				id: v.id("ai_chat_threads_messages_aisdk_5"),
				role: v.string(),
				bytes: v.number(),
				content: v.any(),
			}),
		),
		nextId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
		usedBytes: v.number(),
		hasUserMessage: v.boolean(),
		/**
		 * The byte budget stopped the walk. Older messages were left out.
		 */
		full: v.boolean(),
		/**
		 * The summary that stands in for the older part of the branch. The walk ends at it.
		 */
		summary: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const messages = [];
		let usedBytes = args.usedBytes;
		let hasUserMessage = args.hasUserMessage;
		let full = false;
		let summary: string | null = null;
		let nodeId: Id<"ai_chat_threads_messages_aisdk_5"> | null = args.fromId;
		for (let step = 0; nodeId !== null && step < BRANCH_WALK_MAX; step++) {
			const node: Doc<"ai_chat_threads_messages_aisdk_5"> | null = await ctx.db.get(
				"ai_chat_threads_messages_aisdk_5",
				nodeId,
			);
			if (!node || node.threadId !== args.threadId) {
				nodeId = null;
				break;
			}
			const isUserMessage = node.content.role === "user";
			// A compaction ends at this node, so its summary replaces the node and everything older.
			// Every branch through this node reuses it. The newest summary also covers older ones.
			// The model must still see the newest user message. Regenerate can start the walk at a
			// tail, so look for a summary only from that message on, and keep a tail that is that message.
			const compaction =
				hasUserMessage || isUserMessage
					? await ctx.db
							.query("ai_chat_compactions")
							.withIndex("by_thread_tailNode", (q) => q.eq("threadId", args.threadId).eq("tailNodeId", node._id))
							.order("desc")
							.first()
					: null;
			if (compaction && hasUserMessage) {
				summary = compaction.summary;
				usedBytes += compaction.bytes;
				nodeId = null;
				break;
			}
			if (usedBytes > 0 && usedBytes + node.bytes > args.maxBytes) {
				full = true;
				if (hasUserMessage) break;
				// The model must always see the newest user message. Skip the nodes that do not fit
				// until that message.
				if (!isUserMessage) {
					nodeId = node.parentId;
					continue;
				}
			}
			hasUserMessage ||= isUserMessage;
			messages.push({
				id: node._id,
				role: String(node.content.role),
				bytes: node.bytes,
				content: await db_ui_message(ctx, node),
			});
			usedBytes += node.bytes;
			nodeId = node.parentId;
			if (compaction) {
				summary = compaction.summary;
				usedBytes += compaction.bytes;
				nodeId = null;
				break;
			}
		}
		return { messages, nextId: nodeId, usedBytes, hasUserMessage, full, summary };
	},
});

/**
 * Save a summary of the branch up to `tailNodeId`. Only the live run of the chat may save one, so a
 * stopped or old run cannot change the history of the next run. Returns false when it was refused.
 */
export const save_compaction = internalMutation({
	args: {
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		headNodeId: v.id("ai_chat_threads_messages_aisdk_5"),
		tailNodeId: v.id("ai_chat_threads_messages_aisdk_5"),
		summary: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("ai_chat_runs", args.runId);
		if (!run || run.status !== "running" || run.generation !== args.generation) return false;
		const thread = await ctx.db.get("ai_chat_threads", run.threadId);
		if (!thread || thread.deletingAt !== undefined || thread.copyingAt !== undefined) return false;
		const [head, tail] = await Promise.all([
			ctx.db.get("ai_chat_threads_messages_aisdk_5", args.headNodeId),
			ctx.db.get("ai_chat_threads_messages_aisdk_5", args.tailNodeId),
		]);
		if (head?.threadId !== thread._id || tail?.threadId !== thread._id) return false;

		const bytes = encoder.encode(args.summary).byteLength;
		if (bytes > COMPACTION_SUMMARY_MAX_BYTES) return false;

		await ctx.db.insert("ai_chat_compactions", {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			threadId: thread._id,
			runId: run._id,
			headNodeId: args.headNodeId,
			tailNodeId: args.tailNodeId,
			summary: args.summary,
			bytes,
		});
		return true;
	},
});

// #endregion history
