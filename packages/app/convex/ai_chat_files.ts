import { vOnCompleteArgs, vWorkId, Workpool, type WorkId } from "@convex-dev/workpool";
import { compareValues, v, type Infer } from "convex/values";
import { paginationOptsValidator, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { omit } from "convex-helpers";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api.js";
import app_convex_schema, {
	ai_chat_bash_job_live_output_validator,
	ai_chat_bash_result_validator,
	ai_chat_model_id_validator,
	ai_chat_workspaces_source_validator,
	bash_shell_state_validator,
	files_pending_target_validator,
	files_transfer_scope_validator,
} from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	activities_db_delete,
	activities_db_finish,
	activities_db_get_by_source_id,
	activities_db_start,
	activities_is_active,
} from "./activities_db.ts";
import { files_transfer_db_get_job_copy, files_transfer_db_request_stop } from "./files_transfer.ts";
import {
	files_ingestion_scope_validator,
	files_ingestion_prepare_args_validator,
	files_ingestion_prepare_result_validator,
	files_ingestion_finalize_args_validator,
	files_ingestion_file_validator,
	files_ingestion_db_prepare_file,
	files_ingestion_db_finalize_file,
} from "./files_ingestion.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { ai_chat_workspaces_db_authorize_file_scope, ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import { billing_db_check_paid_plan, billing_pick_billed_user_id } from "./billing_db.ts";
import { files_nodes_db_plan_private_node_by_path } from "./files_nodes.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_pending_nodes_db_resolve_read_target } from "./files_pending_nodes.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_STOPPED,
	bash_COMMAND_EXIT_TIMED_OUT,
	bash_JOB_COPY_PAGE_MAX_BYTES,
	bash_JOB_NUMBERS_MAX_COUNT,
	bash_job_exit_code,
	bash_text_head,
} from "../server/bash-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { get_id_generator } from "../shared/generated-ids.ts";
import { ai_chat_GENERATED_IMAGE_FORMAT } from "../shared/ai-chat.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const BASH_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BASH_RESULT_MAX_BYTES = 700 * 1024;
// Rows the daily sweep empties per pass. A row's result can be 700 KiB and its size is unknown
// before the read, so keep the pass well under the transaction byte limit and reschedule instead.
const BASH_RESULT_CLEANUP_BATCH_COUNT = 8;
const BASH_SHELL_MAX_COUNT = 10;
// The name becomes a `/shells/<name>` path segment, so it is checked here too, not only in the tool schema.
const BASH_SHELL_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;
// A shell keeps at most 1 MiB and 1,000 transcript entries; the oldest entries go first.
const BASH_SHELL_TRANSCRIPT_MAX_BYTES = 1_048_576;
const BASH_SHELL_TRANSCRIPT_MAX_ENTRIES = 1000;
// A single entry is cut just under the 1 MiB document limit, not down to a tidy number. The
// transcript is meant to keep a job's whole output, which is about 830 KiB in the worst case, so
// the cut must sit above that. It exists because a caller can still hand over more: the engine's
// output limit counts UTF-16 units rather than bytes, a compound statement that exits can carry
// its own unchecked output out, and the app appends diagnostic lines after the engine returns.
// Without the cut that insert fails and takes the whole Bash call down after its work was done.
const BASH_SHELL_TRANSCRIPT_ENTRY_MAX_BYTES = 960 * 1024;
// `read_shell_transcript` returns at most this many entries, well under the Convex array cap of 8192.
const BASH_SHELL_TRANSCRIPT_READ_MAX_ENTRIES = 1000;
// A job's budget starts when its worker starts, not when it was queued.
const BASH_JOB_RUN_MS = 8 * 60 * 1000;
const BASH_JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
// The worker aborts this long before the deadline, so the last 30 seconds store and settle.
const BASH_JOB_SETTLE_HEADROOM_MS = 30_000;
// Live jobs per user and workspace, counted on the Activity rows.
const BASH_JOB_LIVE_MAX_COUNT = 10;
// `jobs -a` shows this many of the newest jobs.
const BASH_JOB_LIST_MAX_COUNT = 8;
// A job's three clocks start at this placeholder; the worker's claim re-arms them from its start.
const BASH_JOB_PLACEHOLDER_MS = 10 * 60 * 1000;
// A job row must stay under the 1 MiB document cap once its result is stored, so the script and
// the shell snapshot are bounded at launch and emptied when the result lands.
const BASH_JOB_SCRIPT_MAX_BYTES = 64 * 1024;
const BASH_JOB_SHELL_STATE_MAX_BYTES = 128 * 1024;
// A job's Copy input must be saved, sealed and started within this time after its checkpoint is
// saved. The server sets it from its own clock, so the host clock does not matter.
const BASH_JOB_COPY_ADMISSION_MS = 10 * 60 * 1000;
// Copy input pages each cleanup pass deletes. A page can be 64 KiB, so keep the pass small.
const BASH_JOB_COPY_CLEANUP_BATCH_COUNT = 8;
// The wakeup message carries this much of each output stream; `jobs -o N` has the rest. The count is
// in UTF-16 code units, so `bash_text_head` keeps the cut off the middle of a character.
const BASH_JOB_WAKEUP_HEAD_CHARS = 4 * 1024;

// A wakeup run holds the thread's run lease this long at most. A Convex action cannot run longer.
export const BASH_JOB_WAKEUP_RUN_MS = 10 * 60 * 1000;

// The fixed head of the finish message, split around the job number. `bash_job_is_finish_message`
// matches these two halves; the text built below uses them so the two cannot drift apart.
const BASH_JOB_FINISH_MESSAGE_START = "Background job ";
const BASH_JOB_FINISH_MESSAGE_MIDDLE = " finished in shell ";

/**
 * Whether a stored message is a job finish message. The role check keeps user
 * quotes of the same words out: user text lands as role `user`, never `system`.
 */
export function bash_job_is_finish_message(role: string, text: string) {
	return (
		role === "system" && text.startsWith(BASH_JOB_FINISH_MESSAGE_START) && text.includes(BASH_JOB_FINISH_MESSAGE_MIDDLE)
	);
}

const ai_chat_bash_jobs_workpool = new Workpool(components.ai_chat_bash_jobs_workpool, {
	// Above the live-job cap, so one user cannot fill every slot.
	maxParallelism: 12,
	// A retried worker would replay the job's writes.
	retryActionsByDefault: false,
});

// Begin and lost-reply readback use the same immutable call identity.
const bash_invocation_identity = {
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	userId: v.id("users"),
	threadId: v.id("ai_chat_threads"),
	membershipId: v.id("organizations_workspaces_users"),
	membershipLifetime: v.number(),
	toolCallId: v.string(),
	commandHash: v.string(),
};

const bash_invocation_result = v.object({
	isNew: v.boolean(),
	invocationId: v.id("ai_chat_bash_invocations"),
	membershipId: v.id("organizations_workspaces_users"),
	deadlineAt: v.number(),
	transferDeadlineAt: v.number(),
	status: app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.status,
	result: v.union(ai_chat_bash_result_validator, v.null()),
	resultExpired: v.boolean(),
});

// A fresh begin also returns the shell it will run in and the thread's shell list for the
// `/shells` mount. A replayed begin returns the plain invocation result, like `get_bash_invocation`.
const bash_begin_result = v.union(
	bash_invocation_result,
	v.object({
		...bash_invocation_result.fields,
		shell: v.object({
			_id: v.id("ai_chat_bash_shells"),
			name: v.string(),
			cwd: v.string(),
			cwdTarget: app_convex_schema.tables.ai_chat_bash_shells.validator.fields.cwdTarget,
			state: app_convex_schema.tables.ai_chat_bash_shells.validator.fields.state,
		}),
		shells: v.array(v.object({ _id: v.id("ai_chat_bash_shells"), name: v.string() })),
	}),
);

/**
 * Append one transcript entry to a shell and trim the oldest entries while the shell is above
 * its byte or entry cap. The running totals on the shell row mean no scan. Call this inside the
 * mutation that changes the shell, so a shell never has an entry without its state.
 */
export async function ai_chat_files_db_append_shell_transcript(
	ctx: MutationCtx,
	shell: Doc<"ai_chat_bash_shells">,
	text: string,
) {
	const encoded = new TextEncoder().encode(text);
	// Cut the entry here, at the insert, so no caller can make the document too large. Decoding a
	// byte slice can leave one replacement character where a character was split; drop it.
	const entryText =
		encoded.byteLength > BASH_SHELL_TRANSCRIPT_ENTRY_MAX_BYTES
			? `${new TextDecoder().decode(encoded.slice(0, BASH_SHELL_TRANSCRIPT_ENTRY_MAX_BYTES)).replace(/�+$/u, "")}\n[transcript entry truncated]`
			: text;
	const bytes = new TextEncoder().encode(entryText).byteLength;
	await ctx.db.insert("ai_chat_bash_shell_transcripts", {
		organizationId: shell.organizationId,
		workspaceId: shell.workspaceId,
		threadId: shell.threadId,
		shellId: shell._id,
		seq: shell.transcriptSeq,
		text: entryText,
		bytes,
	});

	let transcriptBytes = shell.transcriptBytes + bytes;
	let transcriptEntries = shell.transcriptEntries + 1;
	if (transcriptBytes > BASH_SHELL_TRANSCRIPT_MAX_BYTES || transcriptEntries > BASH_SHELL_TRANSCRIPT_MAX_ENTRIES) {
		// One big entry can push out many small ones, so read the oldest entries as one page and
		// walk it. Asking for the oldest entry again after every delete would be one query per
		// deleted entry, and the mutation has its own time budget.
		const oldest = await ctx.db
			.query("ai_chat_bash_shell_transcripts")
			.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
			.take(BASH_SHELL_TRANSCRIPT_MAX_ENTRIES);
		for (const entry of oldest) {
			if (transcriptBytes <= BASH_SHELL_TRANSCRIPT_MAX_BYTES && transcriptEntries <= BASH_SHELL_TRANSCRIPT_MAX_ENTRIES)
				break;
			await ctx.db.delete("ai_chat_bash_shell_transcripts", entry._id);
			transcriptBytes -= entry.bytes;
			transcriptEntries -= 1;
		}
	}

	await ctx.db.patch("ai_chat_bash_shells", shell._id, {
		transcriptBytes,
		transcriptEntries,
		transcriptSeq: shell.transcriptSeq + 1,
	});
}

export async function ai_chat_files_db_get_invocation_membership(
	ctx: QueryCtx | MutationCtx,
	invocation: Pick<
		Doc<"ai_chat_bash_invocations">,
		"organizationId" | "workspaceId" | "userId" | "threadId" | "membershipId" | "membershipLifetime"
	>,
) {
	const membership = await ctx.db.get("organizations_workspaces_users", invocation.membershipId);
	if (
		!membership?.active ||
		membership.userId !== invocation.userId ||
		membership.organizationId !== invocation.organizationId ||
		membership.workspaceId !== invocation.workspaceId
	)
		return null;
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, invocation);
	if (
		!lifetime?.active ||
		lifetime.membershipId !== invocation.membershipId ||
		lifetime.lifetime !== invocation.membershipLifetime
	)
		return null;
	const user = await ctx.db.get("users", invocation.userId);
	if (!user || user.deletedAt !== undefined) return null;
	const workspace = await ctx.db.get("organizations_workspaces", invocation.workspaceId);
	if (
		!workspace ||
		workspace.organizationId !== invocation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return null;
	const thread = await ctx.db.get("ai_chat_threads", invocation.threadId);
	if (
		!thread ||
		thread.createdBy !== invocation.userId ||
		thread.organizationId !== invocation.organizationId ||
		thread.workspaceId !== invocation.workspaceId
	)
		return null;
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: invocation.userId },
		membership,
		permission: "content.read",
	});
	if (authorized._nay) return null;
	return membership;
}

/**
 * Keep a bounded replay even when multibyte output exceeds the shell's character cap.
 */
function bash_result_bounded(result: NonNullable<Doc<"ai_chat_bash_invocations">["result"]>) {
	if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= BASH_RESULT_MAX_BYTES) return result;
	const stdout = bash_text_head(result.stdout, 16_384);
	const stderr = bash_text_head(result.stderr, 16_384);
	return {
		title: bash_text_head(result.title, 256),
		output: `${stdout}${stderr ? `\n${stderr}` : ""}\n[Saved Bash result was truncated.]`,
		stdout,
		stderr,
		metadata: {
			...result.metadata,
			command: bash_text_head(result.metadata.command, 8192),
			cwd: bash_text_head(result.metadata.cwd, 1024),
			nextCwd: bash_text_head(result.metadata.nextCwd, 1024),
			stdoutTruncated: true,
			stderrTruncated: true,
			observedPaths: result.metadata.observedPaths.filter(({ path }) => path.length <= 256).slice(0, 20),
			observedPathsTruncated: true,
		},
	};
}

function invocation_result(
	invocation: Pick<
		Doc<"ai_chat_bash_invocations">,
		"_id" | "membershipId" | "deadlineAt" | "transferDeadlineAt" | "status" | "result" | "resultExpiresAt"
	>,
	isNew = false,
) {
	const now = Date.now();
	const status = invocation.status === "running" && invocation.deadlineAt <= now ? "interrupted" : invocation.status;
	const resultExpired = status === "finished" && (!invocation.result || (invocation.resultExpiresAt ?? 0) <= now);
	return {
		isNew,
		invocationId: invocation._id,
		membershipId: invocation.membershipId,
		deadlineAt: invocation.deadlineAt,
		transferDeadlineAt: invocation.transferDeadlineAt,
		status,
		result: resultExpired ? null : (invocation.result ?? null),
		resultExpired,
	};
}

export const begin_bash_invocation = internalMutation({
	// `shellName` is not part of the call identity shared with `get_bash_invocation`; keep it off
	// the identity object because the handler spreads that object into the invocation row.
	args: { ...bash_invocation_identity, shellName: v.string() },
	returns: v_result({ _yay: bash_begin_result }),
	handler: async (ctx, { shellName, ...args }) => {
		// `job:` ids belong to `start_bash_job`. Refuse one here, before the lookup: the index is
		// not unique, so a second row with that key would shadow the job for every `.first()` reader.
		if (
			!args.toolCallId ||
			args.toolCallId.length > 256 ||
			args.toolCallId.startsWith("job:") ||
			!/^[a-f0-9]{64}$/.test(args.commandHash)
		)
			return Result({ _nay: { message: "Invalid Bash call identity." } });
		if (!BASH_SHELL_NAME_REGEX.test(shellName)) return Result({ _nay: { message: "Invalid Bash shell name." } });
		// Keep the HTTP run's original membership lifetime, even before its first Bash call.
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, args)))
			return Result({ _nay: { message: "Unauthorized" } });
		const existing = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (existing) {
			if (
				existing.organizationId !== args.organizationId ||
				existing.workspaceId !== args.workspaceId ||
				existing.userId !== args.userId ||
				existing.membershipId !== args.membershipId ||
				existing.membershipLifetime !== args.membershipLifetime
			)
				return Result({ _nay: { message: "Unauthorized" } });
			if (existing.commandHash !== args.commandHash)
				return Result({
					_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
				});
			if (existing.status === "running" && existing.deadlineAt <= Date.now())
				await ctx.db.patch("ai_chat_bash_invocations", existing._id, { status: "interrupted", finishedAt: Date.now() });
			return Result({ _yay: invocation_result(existing) });
		}

		const now = Date.now();

		// Create-and-run: a shell that does not exist yet is created by the call that names it.
		// Read the whole thread range, so the count and the insert are one transaction and a
		// concurrent insert of an 11th shell retries instead of slipping past the cap.
		const shells = await ctx.db
			.query("ai_chat_bash_shells")
			.withIndex("by_thread_name", (q) => q.eq("threadId", args.threadId))
			.collect();
		let shell = shells.find((row) => row.name === shellName) ?? null;
		if (!shell) {
			if (shells.length >= BASH_SHELL_MAX_COUNT)
				return Result({
					_nay: {
						name: "shell_limit",
						message: `This thread already has ${BASH_SHELL_MAX_COUNT} shells (${shells.map((row) => row.name).join(", ")}). Reuse one of them.`,
					},
				});
			const shellId = await ctx.db.insert("ai_chat_bash_shells", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: args.threadId,
				name: shellName,
				// `"~"` means "start in the current workspace path"; the shell runner resolves it.
				cwd: "~",
				cwdTarget: null,
				state: null,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
				updatedBy: args.userId,
				updatedAt: now,
			});
			shell = await ctx.db.get("ai_chat_bash_shells", shellId);
			if (!shell) throw should_never_happen("Inserted Bash shell not found", { shellId });
			shells.push(shell);
		}

		const invocation = {
			...args,
			status: "running" as const,
			deadlineAt: now + 120_000,
			transferDeadlineAt: now + 90_000,
		};
		const invocationId = await ctx.db.insert("ai_chat_bash_invocations", invocation);
		await ctx.scheduler.runAt(invocation.deadlineAt, internal.ai_chat_files.interrupt_bash_invocation, {
			invocationId,
		});
		return Result({
			_yay: {
				...invocation_result({ ...invocation, _id: invocationId }, true),
				shell: { _id: shell._id, name: shell.name, cwd: shell.cwd, cwdTarget: shell.cwdTarget, state: shell.state },
				shells: shells.map((row) => ({ _id: row._id, name: row.name })),
			},
		});
	},
});

/**
 * The lazy `/shells/<name>/transcript` provider reads this mid-call. Only the thread creator with
 * current workspace read access may read it. The shell must belong to that same thread and scope.
 */
export const read_shell_transcript = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		shellId: v.id("ai_chat_bash_shells"),
	},
	returns: v.array(v.object({ seq: v.number(), text: v.string() })),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) throw convex_error({ message: membership._nay.message });

		const shell = await ctx.db.get("ai_chat_bash_shells", args.shellId);
		if (
			!shell ||
			shell.organizationId !== membership._yay.organizationId ||
			shell.workspaceId !== membership._yay.workspaceId ||
			shell.threadId !== args.threadId
		)
			throw convex_error({ message: "Not found" });

		const entries = await ctx.db
			.query("ai_chat_bash_shell_transcripts")
			.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
			.take(BASH_SHELL_TRANSCRIPT_READ_MAX_ENTRIES);
		return entries.map((entry) => ({ seq: entry.seq, text: entry.text }));
	},
});

export type ai_chat_files_read_shell_transcript_Result =
	typeof read_shell_transcript extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_bash_invocation = internalQuery({
	args: bash_invocation_identity,
	returns: v_result({ _yay: bash_invocation_result }),
	handler: async (ctx, args) => {
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, args)))
			return Result({ _nay: { message: "Unauthorized" } });
		const invocation = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (!invocation) return Result({ _nay: { message: "Not found" } });
		if (
			invocation.organizationId !== args.organizationId ||
			invocation.workspaceId !== args.workspaceId ||
			invocation.userId !== args.userId ||
			invocation.membershipId !== args.membershipId ||
			invocation.membershipLifetime !== args.membershipLifetime
		)
			return Result({ _nay: { message: "Unauthorized" } });
		if (invocation.commandHash !== args.commandHash)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
			});
		return Result({ _yay: invocation_result(invocation) });
	},
});

export const finish_bash_invocation = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		commandHash: v.string(),
		result: ai_chat_bash_result_validator,
	},
	returns: v_result({ _yay: bash_invocation_result }),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (!invocation) return Result({ _nay: { message: "Not found" } });
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
			return Result({ _nay: { message: "Unauthorized" } });
		if (invocation.commandHash !== args.commandHash)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
			});
		if (invocation.status !== "running") return Result({ _yay: invocation_result(invocation) });

		if (invocation.deadlineAt <= Date.now()) {
			const patch = { status: "interrupted" as const, finishedAt: Date.now() };
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
			return Result({ _yay: invocation_result({ ...invocation, ...patch }) });
		}

		const now = Date.now();
		const patch = {
			status: "finished" as const,
			finishedAt: now,
			result: bash_result_bounded(args.result),
			resultExpiresAt: now + BASH_RESULT_RETENTION_MS,
		};

		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
		await ctx.scheduler.runAt(patch.resultExpiresAt, internal.ai_chat_files.expire_bash_invocation_result, {
			invocationId: invocation._id,
		});

		return Result({ _yay: invocation_result({ ...invocation, ...patch }) });
	},
});

export const interrupt_bash_invocation = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (invocation?.status === "running")
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { status: "interrupted", finishedAt: Date.now() });
		return null;
	},
});

export const expire_bash_invocation_result = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (invocation?.resultExpiresAt !== undefined && invocation.resultExpiresAt <= Date.now())
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { result: undefined, resultExpiresAt: undefined });
		return null;
	},
});

export const cleanup_expired_bash_results = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		// A job row can hold a 700 KiB result and its size is unknown until it is read, so this
		// pass reads few rows and reschedules itself. Every finished row also has its own expiry
		// scheduled, so this sweep only picks up rows whose schedule was lost.
		const invocations = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_resultExpiresAt", (q) => q.gt("resultExpiresAt", 0).lte("resultExpiresAt", Date.now()))
			.take(BASH_RESULT_CLEANUP_BATCH_COUNT);
		for (const invocation of invocations)
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { result: undefined, resultExpiresAt: undefined });
		if (invocations.length === BASH_RESULT_CLEANUP_BATCH_COUNT)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_expired_bash_results, {});
		return null;
	},
});

/**
 * Keep the original chat separate from the output workspace. Files checks the exact destination.
 */
export async function ai_chat_files_db_authorize_file_output(
	ctx: MutationCtx,
	args: Infer<typeof files_ingestion_scope_validator> & {
		agentSource: Infer<typeof ai_chat_workspaces_source_validator>;
		threadId: Id<"ai_chat_threads">;
		modeId: "ask" | "agent";
	},
) {
	if (args.modeId !== "agent") return Result({ _nay: { message: "Agent mode is required to create files" } });
	if (args.threadId !== args.agentSource.threadId) return Result({ _nay: { message: "Unauthorized" } });
	return await ai_chat_workspaces_db_authorize_file_scope(ctx, args);
}

export const get_file_output_target = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: v.object({ kind: v.union(v.literal("saved"), v.literal("private")), id: v.string() }),
	},
	returns: v.union(
		v.object({
			target: files_pending_target_validator,
			path: v.string(),
			readiness: v.union(v.literal("preparing"), v.literal("ready")),
			organizationName: v.string(),
			workspaceName: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const current = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!current) return null;
		const user = (await ctx.db.get("users", userAuth.id))!;
		const personal = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", userAuth.id)
					.eq("organizationId", user.defaultOrganizationId!)
					.eq("workspaceId", user.defaultWorkspaceId!),
			)
			.first();
		let target: Doc<"files_pending_updates">["target"];
		if (args.target.kind === "saved") {
			const id = ctx.db.normalizeId("files_nodes", args.target.id);
			if (!id) return null;
			target = { kind: "saved", id };
		} else {
			const id = ctx.db.normalizeId("files_pending_nodes", args.target.id);
			if (!id) return null;
			target = { kind: "private", id };
		}
		// The target keeps its ID through Save. Try only these two authorized workspace scopes.
		for (const membership of personal && personal._id !== current._id ? [current, personal] : [current]) {
			const scope = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
			};
			const readTarget = await files_pending_nodes_db_resolve_read_target(ctx, { ...scope, target });
			if (!readTarget) continue;
			const reader = await files_visible_db_create_reader(ctx, { ...scope, readLimit: 2048 });
			const file = await reader.resolve(readTarget);
			if (!file || !(await reader.canRead(file.accessNode))) continue;
			const { entry } = file;
			if (entry.kind === "saved" && entry.node.archiveOperationId !== null) return null;
			const organization = (await ctx.db.get("organizations", membership.organizationId))!;
			const workspace = (await ctx.db.get("organizations_workspaces", membership.workspaceId))!;
			return {
				target: readTarget,
				path: entry.path,
				readiness: entry.pendingUpdate?.preparation ? ("preparing" as const) : ("ready" as const),
				organizationName: organization.name,
				workspaceName: workspace.name,
			};
		}
		return null;
	},
});

/**
 * Check the fixed output path before paying for image generation. Finalize checks it again.
 */
export const check_image_output = internalMutation({
	args: {
		source: ai_chat_workspaces_source_validator,
		workspace: v.union(v.literal("current"), v.literal("personal")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const destination = await ai_chat_workspaces_db_resolve(ctx, args);
		if (destination._nay) return destination;
		const organization = (await ctx.db.get("organizations", destination._yay.organizationId))!;
		const billedUserId = billing_pick_billed_user_id({ userId: args.source.userId, organization });
		if (!(await billing_db_check_paid_plan(ctx, { userId: billedUserId })).hasPaidPlan)
			return Result({ _nay: { message: "This workspace's plan does not include file uploads" } });
		const planned = await files_nodes_db_plan_private_node_by_path(ctx, {
			...destination._yay,
			userId: args.source.userId,
			path: `/generated/image.${ai_chat_GENERATED_IMAGE_FORMAT}`,
			kind: "file",
			uniqueName: true,
		});
		return planned._nay ? Result({ _nay: planned._nay }) : Result({ _yay: null });
	},
});

export const prepare_file_output = internalMutation({
	args: {
		...files_ingestion_prepare_args_validator.fields,
		agentSource: ai_chat_workspaces_source_validator,
		threadId: v.id("ai_chat_threads"),
		modeId: v.union(v.literal("ask"), v.literal("agent")),
	},
	returns: v_result({ _yay: files_ingestion_prepare_result_validator }),
	handler: (ctx, args) =>
		files_ingestion_db_prepare_file(ctx, args, () => ai_chat_files_db_authorize_file_output(ctx, args)),
});

export const finalize_file_output = internalMutation({
	args: {
		...files_ingestion_finalize_args_validator.fields,
		agentSource: ai_chat_workspaces_source_validator,
		threadId: v.id("ai_chat_threads"),
		modeId: v.union(v.literal("ask"), v.literal("agent")),
	},
	returns: v_result({ _yay: files_ingestion_file_validator }),
	handler: (ctx, args) =>
		files_ingestion_db_finalize_file(ctx, args, () => ai_chat_files_db_authorize_file_output(ctx, args)),
});

/**
 * Load a background job row. Callers return quietly on a missing row: purge and the user drain
 * can delete it while a worker, a watchdog or a pool callback is still in flight.
 */
async function db_get_job_row(ctx: QueryCtx | MutationCtx, invocationId: Id<"ai_chat_bash_invocations">) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", invocationId);
	if (!invocation) return null;
	const job = invocation.job;
	if (!job) throw should_never_happen("Bash invocation is not a background job", { invocationId });
	return { ...invocation, job };
}

type BashJobRow = NonNullable<Awaited<ReturnType<typeof db_get_job_row>>>;

async function db_check_bash_job_worker(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; workId: WorkId },
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	const job = invocation?.job;
	if (
		!invocation ||
		!job ||
		invocation.status !== "running" ||
		job.stopRequestedAt !== null ||
		job.workId !== args.workId
	)
		return Result({ _nay: { name: "stale_job", message: "This Bash worker is no longer active." } });
	if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
		return Result({ _nay: { message: "Unauthorized" } });
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (!activity || !activities_is_active(activity.status) || activity.status === "stopping")
		return Result({ _nay: { name: "stopped", message: "This Bash job has ended or is stopping." } });
	return Result({ _yay: { ...invocation, job } });
}

/**
 * The worker check for doors that end a worker slice. The helper checks the work ID before
 * access, so "Unauthorized" means the current worker lost access. End the job now, like a
 * refused pause. Without this, the job stays running with no worker until its watchdog reports
 * a timeout.
 */
async function db_check_bash_job_worker_or_cancel(
	ctx: MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; workId: WorkId },
) {
	const checked = await db_check_bash_job_worker(ctx, args);
	if (checked._nay?.message === "Unauthorized") {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (invocation)
			await db_settle_bash_job(ctx, invocation, { status: "canceled", errorMessage: null, now: Date.now() });
	}
	return checked;
}

/**
 * Checks only. Transfer start uses this before any accepted input is written.
 */
export async function ai_chat_files_db_check_copy_admission(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number; workId: WorkId },
) {
	const checked = await db_check_bash_job_worker(ctx, args);
	if (checked._nay) return checked;
	const invocation = checked._yay;
	const checkpoint = invocation.job.copy;
	if (!checkpoint || checkpoint.commandNumber !== args.commandNumber || checkpoint.phase === "delivering")
		return Result({ _nay: { name: "stale_job", message: "This Bash Copy checkpoint is no longer active." } });
	if (checkpoint.phase === "admitting") {
		if (!checkpoint.sealed)
			return Result({ _nay: { name: "incomplete_input", message: "Seal the Bash Copy input before starting Copy." } });
		if (checkpoint.admissionDeadlineAt <= Date.now() || invocation.transferDeadlineAt <= Date.now())
			return Result({ _nay: { name: "timed_out", message: "This Bash Copy admission timed out." } });
	}
	return Result({ _yay: { invocation, checkpoint } });
}

/**
 * Source pages have fixed positions, so one request reads at most two docs.
 */
export async function ai_chat_files_db_check_copy_sources(
	ctx: QueryCtx | MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		offset: number;
		sources: Infer<typeof files_pending_target_validator>[];
	},
) {
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.sources.length < 1 ||
		args.sources.length > files_TRANSFER_SELECTION_PAGE_SIZE
	)
		return Result({ _nay: { name: "invalid_selection", message: "Invalid source page position or size." } });
	const firstPage = Math.floor(args.offset / files_TRANSFER_SELECTION_PAGE_SIZE);
	const lastPage = Math.floor((args.offset + args.sources.length - 1) / files_TRANSFER_SELECTION_PAGE_SIZE);
	const savedSources: Infer<typeof files_pending_target_validator>[] = [];
	for (let page = firstPage; page <= lastPage; page++) {
		const saved = await ctx.db
			.query("ai_chat_bash_job_copy_pages")
			.withIndex("by_invocation_command_page", (q) =>
				q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber).eq("page", page),
			)
			.unique();
		if (!saved)
			return Result({ _nay: { name: "request_changed", message: "Copy sources do not match the saved Bash input." } });
		savedSources.push(...saved.sources);
	}
	const pageOffset = args.offset % files_TRANSFER_SELECTION_PAGE_SIZE;
	const selected = savedSources.slice(pageOffset, pageOffset + args.sources.length);
	if (
		selected.length !== args.sources.length ||
		selected.some((source, index) => source.kind !== args.sources[index]!.kind || source.id !== args.sources[index]!.id)
	)
		return Result({ _nay: { name: "request_changed", message: "Copy sources do not match the saved Bash input." } });
	return Result({ _yay: null });
}

/**
 * Called after run insertion: a refusal must roll back the whole start mutation.
 */
export async function ai_chat_files_db_link_copy_admission(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		workId: WorkId;
		runId: Id<"files_transfer_runs">;
	},
) {
	const checked = await ai_chat_files_db_check_copy_admission(ctx, args);
	if (checked._nay) throw convex_error(checked._nay);
	const { invocation, checkpoint } = checked._yay;
	if (checkpoint.runId === args.runId) return null;
	if (checkpoint.phase !== "admitting" || checkpoint.runId !== null)
		throw convex_error({ message: "This Bash Copy checkpoint already belongs to another transfer." });
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
		job: { ...invocation.job, copy: { ...checkpoint, runId: args.runId } },
	});
	return null;
}

/**
 * Called inside transfer seal, together with discovery scheduling.
 */
export async function ai_chat_files_db_seal_copy_admission(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		workId: WorkId;
		runId: Id<"files_transfer_runs">;
		deadlineAt: number;
		now: number;
	},
) {
	const checked = await ai_chat_files_db_check_copy_admission(ctx, args);
	if (checked._nay) throw convex_error(checked._nay);
	const { invocation, checkpoint } = checked._yay;
	if (checkpoint.runId !== args.runId)
		throw convex_error({ message: "This Bash Copy checkpoint belongs to another transfer." });
	// A lost seal reply must not reset the start of the excluded wait interval.
	if (checkpoint.phase === "waiting") return null;
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (!activity) throw convex_error({ message: "Bash job Activity not found." });
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
	const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
		args.deadlineAt,
		internal.ai_chat_files.timeout_bash_job,
		{ invocationId: invocation._id, expectedDeadlineAt: args.deadlineAt },
	);
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
		deadlineAt: args.deadlineAt,
		job: {
			...invocation.job,
			watchdogId,
			copy: {
				phase: "waiting",
				commandNumber: checkpoint.commandNumber,
				lastArg: checkpoint.lastArg,
				runId: args.runId,
				waitStartedAt: args.now,
			},
		},
	});
	await ctx.db.patch("activities", activity._id, { deadlineAt: args.deadlineAt, updatedAt: args.now });
	return null;
}

const bash_copy_admission_validator =
	app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.job.fields.copy.members[0];

/**
 * Checkpoint fields that `save_bash_job_copy_checkpoint` sets itself. The worker sends the rest.
 */
const BASH_COPY_ADMISSION_SERVER_FIELDS = [
	"pageCount",
	"argsCount",
	"sourcesCount",
	"sealed",
	"admissionDeadlineAt",
	"runId",
] as const;

/**
 * Capture both memberships before staging. Do not retarget already resolved operands.
 */
export const capture_bash_job_copy_scopes = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		sourceWorkspace: v.union(v.literal("current"), v.literal("personal")),
		destinationWorkspace: v.union(v.literal("current"), v.literal("personal")),
		source: v.object({ organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") }),
		destination: v.object({ organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") }),
	},
	returns: v_result({
		_yay: v.object({ sourceScope: files_transfer_scope_validator, destinationScope: files_transfer_scope_validator }),
	}),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker(ctx, args);
		if (checked._nay) return checked;
		const capture = async (workspace: "current" | "personal", expected: typeof args.source) => {
			const resolved = await ai_chat_workspaces_db_resolve(ctx, { source: checked._yay, workspace });
			if (resolved._nay) return resolved;
			const { organizationId, workspaceId, membershipId } = resolved._yay;
			if (organizationId !== expected.organizationId || workspaceId !== expected.workspaceId)
				return Result({ _nay: { message: "The Copy workspace changed. Start a new command." } });
			const membership = await organizations_db_get_membership(ctx, { userId: checked._yay.userId, membershipId });
			if (!membership) return Result({ _nay: { message: "Copy workspace access is no longer available." } });
			const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
			return Result({ _yay: { organizationId, workspaceId, membershipId, membershipLifetime } });
		};
		const source = await capture(args.sourceWorkspace, args.source);
		if (source._nay) return source;
		const destination = await capture(args.destinationWorkspace, args.destination);
		if (destination._nay) return destination;
		return Result({ _yay: { sourceScope: source._yay, destinationScope: destination._yay } });
	},
});

/**
 * Save expansion once. Incomplete input is never an automatic shell replay point.
 */
export const save_bash_job_copy_checkpoint = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		checkpoint: bash_copy_admission_validator.omit(...BASH_COPY_ADMISSION_SERVER_FIELDS),
		output: v.object({ stdout: v.string(), stderr: v.string() }),
		resume: v.object({
			script: v.string(),
			commandNumber: v.number(),
			launchedJobNumbers: v.array(v.number()),
			shellState: bash_shell_state_validator,
			cwd: v.string(),
			cwdTarget: v.union(files_pending_target_validator, v.null()),
		}),
		liveOutput: v.union(ai_chat_bash_job_live_output_validator, v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker(ctx, args);
		if (checked._nay) return checked;
		const invocation = checked._yay;
		// The cp parser already guarantees at least one source and a destination, so the counts
		// are not checked again here.
		if (
			!Number.isSafeInteger(args.checkpoint.commandNumber) ||
			args.checkpoint.commandNumber < 0 ||
			args.resume.commandNumber !== args.checkpoint.commandNumber + 1 ||
			invocation.transferDeadlineAt <= Date.now() ||
			new TextEncoder().encode(args.resume.script).byteLength > BASH_JOB_SCRIPT_MAX_BYTES ||
			new TextEncoder().encode(JSON.stringify(args.resume.shellState)).byteLength > BASH_JOB_SHELL_STATE_MAX_BYTES
		)
			return Result({ _nay: { name: "invalid_input", message: "Invalid Bash Copy checkpoint." } });
		const previous = invocation.job.copy;
		if (previous && previous.phase !== "delivering") {
			// A lost reply sends the same input again. Compare only the fields the worker sent,
			// because this door set the counters and the deadline itself.
			if (
				previous.phase === "admitting" &&
				compareValues(omit(previous, [...BASH_COPY_ADMISSION_SERVER_FIELDS]), args.checkpoint) === 0 &&
				invocation.job.resumeScript === args.resume.script &&
				compareValues(invocation.job.shellState, args.resume.shellState) === 0 &&
				invocation.job.startCwd === args.resume.cwd &&
				compareValues(invocation.job.startCwdTarget, args.resume.cwdTarget) === 0 &&
				invocation.job.resumeCommandNumber === args.resume.commandNumber &&
				compareValues(invocation.job.resumeLaunchedJobNumbers, args.resume.launchedJobNumbers) === 0
			)
				return Result({ _yay: null });
			return Result({
				_nay: { name: "request_changed", message: "This Bash job already has another Copy checkpoint." },
			});
		}
		if (previous && (previous.workId !== args.workId || args.checkpoint.commandNumber <= previous.commandNumber))
			return Result({ _nay: { name: "stale_job", message: "This Bash Copy result belongs to another worker." } });
		if (previous)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_bash_job_copy_pages, {
				invocationId: invocation._id,
				commandNumber: previous.commandNumber,
			});
		const shell = await ctx.db.get("ai_chat_bash_shells", invocation.job.shellId);
		if (!shell) throw should_never_happen("Job shell not found", { shellId: invocation.job.shellId });
		await ai_chat_files_db_append_shell_transcript(
			ctx,
			shell,
			`$ [${new Date().toISOString()}] job ${invocation.job.jobNumber} suspended for Copy in shell ${shell.name}\n${args.output.stdout}\n${args.output.stderr}`,
		);
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			job: {
				...invocation.job,
				copy: {
					...args.checkpoint,
					pageCount: 0,
					argsCount: 0,
					sourcesCount: 0,
					sealed: false,
					admissionDeadlineAt: Date.now() + BASH_JOB_COPY_ADMISSION_MS,
					runId: null,
				},
				resumeScript: args.resume.script,
				resumeCommandNumber: args.resume.commandNumber,
				resumeLaunchedJobNumbers: args.resume.launchedJobNumbers,
				shellState: args.resume.shellState,
				startCwd: args.resume.cwd,
				startCwdTarget: args.resume.cwdTarget,
				liveOutput: args.liveOutput ?? undefined,
			},
		});
		return Result({ _yay: null });
	},
});

export const stage_bash_job_copy_page = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		commandNumber: v.number(),
		page: v.number(),
		args: v.array(v.string()),
		sources: v.array(files_pending_target_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker(ctx, args);
		if (checked._nay) return checked;
		const invocation = checked._yay;
		const checkpoint = invocation.job.copy;
		if (
			!checkpoint ||
			checkpoint.phase !== "admitting" ||
			checkpoint.commandNumber !== args.commandNumber ||
			checkpoint.admissionDeadlineAt <= Date.now() ||
			invocation.transferDeadlineAt <= Date.now()
		)
			return Result({ _nay: { name: "stale_job", message: "This Bash Copy input is no longer active." } });
		if (
			!Number.isSafeInteger(args.page) ||
			args.page < 0 ||
			args.page > checkpoint.pageCount ||
			args.args.length > files_TRANSFER_SELECTION_PAGE_SIZE ||
			args.sources.length > files_TRANSFER_SELECTION_PAGE_SIZE ||
			args.args.length + args.sources.length === 0 ||
			new TextEncoder().encode(JSON.stringify({ args: args.args, sources: args.sources })).byteLength >
				bash_JOB_COPY_PAGE_MAX_BYTES
		)
			return Result({ _nay: { name: "invalid_input", message: "Invalid Bash Copy input page." } });
		if (args.page < checkpoint.pageCount) {
			const previous = await ctx.db
				.query("ai_chat_bash_job_copy_pages")
				.withIndex("by_invocation_command_page", (q) =>
					q.eq("invocationId", invocation._id).eq("commandNumber", args.commandNumber).eq("page", args.page),
				)
				.unique();
			return previous &&
				compareValues(previous.args, args.args) === 0 &&
				compareValues(previous.sources, args.sources) === 0
				? Result({ _yay: null })
				: Result({
						_nay: { name: "request_changed", message: "This Bash Copy page was already saved with different input." },
					});
		}
		// Sources fill full transfer-sized pages first, so each saved page is one transfer page.
		// Args may spill into later args-only pages.
		if (
			checkpoint.sealed ||
			args.sources.length !==
				Math.min(files_TRANSFER_SELECTION_PAGE_SIZE, checkpoint.expectedSourceCount - checkpoint.sourcesCount) ||
			checkpoint.argsCount + args.args.length > checkpoint.expectedArgCount
		)
			return Result({ _nay: { name: "invalid_input", message: "Copy input pages must be complete and in order." } });
		await ctx.db.insert("ai_chat_bash_job_copy_pages", {
			invocationId: invocation._id,
			commandNumber: args.commandNumber,
			page: args.page,
			args: args.args,
			sources: args.sources,
		});
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			job: {
				...invocation.job,
				copy: {
					...checkpoint,
					pageCount: checkpoint.pageCount + 1,
					argsCount: checkpoint.argsCount + args.args.length,
					sourcesCount: checkpoint.sourcesCount + args.sources.length,
				},
			},
		});
		return Result({ _yay: null });
	},
});

export const seal_bash_job_copy_checkpoint = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), workId: vWorkId, commandNumber: v.number() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker(ctx, args);
		if (checked._nay) return checked;
		const invocation = checked._yay;
		const checkpoint = invocation.job.copy;
		if (
			!checkpoint ||
			checkpoint.phase !== "admitting" ||
			checkpoint.commandNumber !== args.commandNumber ||
			checkpoint.admissionDeadlineAt <= Date.now() ||
			invocation.transferDeadlineAt <= Date.now()
		)
			return Result({ _nay: { name: "stale_job", message: "This Bash Copy input is no longer active." } });
		if (
			checkpoint.argsCount !== checkpoint.expectedArgCount ||
			checkpoint.sourcesCount !== checkpoint.expectedSourceCount
		)
			return Result({ _nay: { name: "incomplete_input", message: "Save all Bash Copy input before sealing." } });
		if (!checkpoint.sealed)
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
				job: { ...invocation.job, copy: { ...checkpoint, sealed: true } },
			});
		return Result({ _yay: null });
	},
});

export const read_bash_job_copy_page = internalQuery({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		commandNumber: v.number(),
		page: v.number(),
	},
	returns: v.union(doc(app_convex_schema, "ai_chat_bash_job_copy_pages"), v.null()),
	handler: async (ctx, args) => {
		const checked = await ai_chat_files_db_check_copy_admission(ctx, args);
		if (checked._nay) return null;
		return await ctx.db
			.query("ai_chat_bash_job_copy_pages")
			.withIndex("by_invocation_command_page", (q) =>
				q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber).eq("page", args.page),
			)
			.unique();
	},
});

export const read_bash_job_copy_invocation = internalQuery({
	args: { invocationId: v.id("ai_chat_bash_invocations"), workId: vWorkId },
	returns: v.union(doc(app_convex_schema, "ai_chat_bash_invocations"), v.null()),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker(ctx, args);
		return checked._nay ? null : checked._yay;
	},
});

/**
 * Old input is no longer needed after delivery. Delete it in bounded pages.
 */
export const cleanup_bash_job_copy_pages = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), commandNumber: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (invocation?.job?.copy?.commandNumber === args.commandNumber) return null;
		const pages = await ctx.db
			.query("ai_chat_bash_job_copy_pages")
			.withIndex("by_invocation_command_page", (q) =>
				q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber),
			)
			.take(BASH_JOB_COPY_CLEANUP_BATCH_COUNT);
		await Promise.all(pages.map((page) => ctx.db.delete("ai_chat_bash_job_copy_pages", page._id)));
		if (pages.length === BASH_JOB_COPY_CLEANUP_BATCH_COUNT)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_bash_job_copy_pages, args);
		return null;
	},
});

/**
 * Copy progress and terminal delivery have fixed owner deadlines. Reads never extend them.
 */
async function db_bash_job_copy_deadline(ctx: QueryCtx | MutationCtx, invocation: BashJobRow) {
	const copy = invocation.job.copy;
	if (!copy) return null;
	if (copy.phase === "admitting") return copy.sealed ? copy.admissionDeadlineAt : null;
	if (copy.phase === "delivering") return null;
	const checked = await files_transfer_db_get_job_copy(ctx, {
		runId: copy.runId,
		invocationId: invocation._id,
		commandNumber: copy.commandNumber,
	});
	if (checked._nay) return null;
	const copyActivity = checked._yay.activity;
	const excluded =
		(invocation.job.excludedCopyWaitMs ?? 0) +
		Math.max(0, (copyActivity.finishedAt ?? Date.now()) - copy.waitStartedAt);
	if (Date.now() - invocation._creationTime - excluded >= BASH_JOB_LIFETIME_MS) return null;
	return copyActivity.finishedAt === undefined
		? copyActivity.deadlineAt
		: copyActivity.finishedAt + BASH_JOB_PLACEHOLDER_MS;
}

/**
 * Switch the checkpoint to one-shot delivery under this worker. The worker gets a fresh run
 * lease for the rest of the shell script.
 */
async function db_deliver_bash_job_copy(
	ctx: MutationCtx,
	args: {
		invocation: BashJobRow;
		copy: {
			commandNumber: number;
			lastArg: string;
			runId: Id<"files_transfer_runs"> | null;
			workId: WorkId;
			result: { stdout: string; stderr: string; exitCode: number };
		};
		now: number;
	},
) {
	const { invocation, copy, now } = args;
	const deadlineAt = now + BASH_JOB_RUN_MS;
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
	const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
		deadlineAt,
		internal.ai_chat_files.timeout_bash_job,
		{ invocationId: invocation._id, expectedDeadlineAt: deadlineAt },
	);
	const job = {
		...invocation.job,
		watchdogId,
		copy: {
			phase: "delivering" as const,
			commandNumber: copy.commandNumber,
			lastArg: copy.lastArg,
			runId: copy.runId,
			workId: copy.workId,
			result: copy.result,
		},
	};
	const patch = { job, deadlineAt, transferDeadlineAt: deadlineAt - BASH_JOB_SETTLE_HEADROOM_MS };
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (activity) await ctx.db.patch("activities", activity._id, { deadlineAt, updatedAt: now });
	return { ...invocation, ...patch };
}

/**
 * Claim one terminal result before running later shell statements. A lost reply is
 * readable by this worker only; a lost worker must never replay those statements.
 */
export const take_bash_job_copy_result = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), commandNumber: v.number(), workId: vWorkId },
	returns: v.union(doc(app_convex_schema, "ai_chat_bash_invocations"), v.null()),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (
			!invocation ||
			invocation.status !== "running" ||
			invocation.job.workId !== args.workId ||
			invocation.job.stopRequestedAt !== null
		)
			return null;
		const copy = invocation.job.copy;
		if (!copy || copy.phase === "admitting" || copy.commandNumber !== args.commandNumber) return null;
		// A refused start never created a run, so there is no transfer to check.
		if (copy.runId === null) return copy.phase === "delivering" && copy.workId === args.workId ? invocation : null;
		const checked = await files_transfer_db_get_job_copy(ctx, { ...args, runId: copy.runId });
		const now = Date.now();
		if (checked._nay) {
			await db_settle_bash_job(ctx, invocation, { status: "canceled", errorMessage: checked._nay.message, now });
			return null;
		}
		if (copy.phase === "delivering") return copy.workId === args.workId ? invocation : null;
		const copyActivity = checked._yay.activity;
		if (activities_is_active(copyActivity.status)) return null;
		const finishedAt = copyActivity.finishedAt;
		if (finishedAt === undefined)
			throw should_never_happen("Finished Copy without its finish time", { runId: copy.runId });
		const excludedCopyWaitMs = (invocation.job.excludedCopyWaitMs ?? 0) + Math.max(0, finishedAt - copy.waitStartedAt);
		if (
			finishedAt + BASH_JOB_PLACEHOLDER_MS <= now ||
			now - invocation._creationTime - excludedCopyWaitMs >= BASH_JOB_LIFETIME_MS
		) {
			await db_settle_bash_job(ctx, invocation, { status: "timed_out", errorMessage: null, now });
			return null;
		}
		const progress = copyActivity.progress;
		const result = {
			stdout: `Transfer ${copy.runId}: ${progress.completed ?? 0} ready for review, ${progress.skipped ?? 0} skipped, ${progress.failed ?? 0} failed. Activity ${copyActivity._id}. Review in Files.\n`,
			stderr: copyActivity.errorMessage ? `cp: ${copyActivity.errorMessage}\n` : "",
			exitCode: copyActivity.status === "succeeded" ? 0 : 1,
		};
		return await db_deliver_bash_job_copy(ctx, {
			invocation: { ...invocation, job: { ...invocation.job, excludedCopyWaitMs } },
			copy: { ...copy, workId: args.workId, result },
			now,
		});
	},
});

/**
 * Deliver a final admission refusal as the failed `cp` result, as the bounded path prints it.
 * A retry would only get the same refusal until the admission deadline. A lost reply is
 * readable by this worker only, like a Copy result.
 */
export const deliver_bash_job_copy_refusal = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		commandNumber: v.number(),
		workId: vWorkId,
		result: v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() }),
	},
	returns: v.union(doc(app_convex_schema, "ai_chat_bash_invocations"), v.null()),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker_or_cancel(ctx, args);
		if (checked._nay) return null;
		const invocation = checked._yay;
		const copy = invocation.job.copy;
		if (copy?.phase === "delivering" && copy.commandNumber === args.commandNumber)
			return copy.workId === args.workId ? invocation : null;
		if (copy?.phase !== "admitting" || copy.commandNumber !== args.commandNumber) return null;
		const now = Date.now();
		// Stop a run that already accepted input, so no Copy work starts after the refusal.
		if (copy.runId !== null) await files_transfer_db_request_stop(ctx, { runId: copy.runId, reason: "user", now });
		return await db_deliver_bash_job_copy(ctx, {
			invocation,
			copy: { ...copy, workId: args.workId, result: args.result },
			now,
		});
	},
});

/**
 * Only complete input or a waiting Copy can survive a lost worker. Never replay shell code.
 */
async function db_requeue_bash_job_copy(ctx: MutationCtx, invocation: BashJobRow, now: number) {
	const copy = invocation.job.copy;
	if (!copy || copy.phase === "delivering" || (copy.phase === "admitting" && !copy.sealed)) return false;
	if (invocation.job.workId === null) return false;
	const checked = await db_check_bash_job_worker(ctx, { invocationId: invocation._id, workId: invocation.job.workId });
	if (checked._nay) return false;
	const deadlineAt = await db_bash_job_copy_deadline(ctx, invocation);
	if (deadlineAt === null || deadlineAt <= now) return false;
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (!activity) return false;
	const workerGeneration = invocation.job.workerGeneration + 1;
	const workId = await ai_chat_bash_jobs_workpool.enqueueAction(
		ctx,
		internal.bash.run_job,
		{ invocationId: invocation._id, workerGeneration },
		{
			onComplete: internal.ai_chat_files.handle_bash_job_complete,
			context: { invocationId: invocation._id },
			runAfter: 2_000,
		},
	);
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
	const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
		deadlineAt,
		internal.ai_chat_files.timeout_bash_job,
		{ invocationId: invocation._id, expectedDeadlineAt: deadlineAt },
	);
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
		deadlineAt,
		job: { ...invocation.job, workId, workerGeneration, watchdogId },
	});
	await ctx.db.patch("activities", activity._id, { status: "queued", deadlineAt, updatedAt: now });
	return true;
}

export const requeue_bash_job_copy = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), workId: vWorkId },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const checked = await db_check_bash_job_worker_or_cancel(ctx, args);
		if (checked._nay) return false;
		const queued = await db_requeue_bash_job_copy(ctx, checked._yay, Date.now());
		if (!queued)
			await db_settle_bash_job(ctx, checked._yay, {
				status: "failed",
				errorMessage: "Copy continuation is no longer available.",
				now: Date.now(),
			});
		return queued;
	},
});

/**
 * The fence for the internal doors the Bash worker calls with a passed `userId`. The caller must
 * own the thread and be an active member of its workspace with `content.read`. Each door then
 * checks the doc it reads against that thread and workspace.
 */
async function db_get_door_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		threadId: Id<"ai_chat_threads">;
	},
) {
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_user_organization_workspace_active", (q) =>
			q
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("active", true),
		)
		.first();
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	if (
		!thread ||
		thread.createdBy !== args.userId ||
		thread.organizationId !== membership.organizationId ||
		thread.workspaceId !== membership.workspaceId
	)
		return Result({ _nay: { message: "Unauthorized" } });
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership,
		permission: "content.read",
	});
	if (authorized._nay) return authorized;
	return Result({ _yay: membership });
}

/**
 * Resolve a job number for the `jobs`, `wait` and `kill` doors. The index carries the user and
 * the thread, so another member's job never resolves.
 */
async function db_get_job_activity(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; threadId: Id<"ai_chat_threads">; jobNumber: number },
) {
	const activity = await ctx.db
		.query("activities")
		.withIndex("by_user_source_kind_thread_jobNumber", (q) =>
			q
				.eq("userId", args.userId)
				.eq("source.kind", "ai_chat_bash_job")
				.eq("source.threadId", args.threadId)
				.eq("source.jobNumber", args.jobNumber),
		)
		.unique();
	if (!activity) return null;
	const source = activity.source;
	if (source.kind !== "ai_chat_bash_job")
		throw should_never_happen("Job Activity has another source kind", { activityId: activity._id });
	return { ...activity, source };
}

const bash_job_summary = v.object({
	jobNumber: v.number(),
	status: app_convex_schema.tables.activities.validator.fields.status,
	shellName: v.string(),
	scriptPreview: v.string(),
	parentJobNumber: v.union(v.number(), v.null()),
	invocationId: v.id("ai_chat_bash_invocations"),
	startedAt: v.optional(v.number()),
	finishedAt: v.optional(v.number()),
});

/**
 * `jobs` lines come from the small Activity row, never from the invocation row (up to 700 KiB).
 */
function job_summary(activity: Doc<"activities">) {
	const source = activity.source;
	if (source.kind !== "ai_chat_bash_job")
		throw should_never_happen("Job Activity has another source kind", { activityId: activity._id });
	return {
		jobNumber: source.jobNumber,
		status: activity.status,
		shellName: source.shellName,
		scriptPreview: source.scriptPreview,
		parentJobNumber: source.parentJobNumber,
		invocationId: source.id,
		startedAt: activity.startedAt,
		finishedAt: activity.finishedAt,
	};
}

/**
 * Append the job's finish entry to its shell transcript. `started` is the Activity's `startedAt`,
 * so a job that never ran has no `started` part. Read the script off the row before the caller
 * empties it.
 */
async function db_append_job_finish_entry(
	ctx: MutationCtx,
	invocation: BashJobRow,
	args: { exitCode: number; stdout: string; stderr: string; startedAt: number | undefined; now: number },
) {
	const shell = await ctx.db.get("ai_chat_bash_shells", invocation.job.shellId);
	if (!shell) throw should_never_happen("Job shell not found", { shellId: invocation.job.shellId });
	const started =
		args.startedAt === undefined ? "" : `, started ${new Date(args.startedAt).toISOString().slice(11, 19)}`;
	await ai_chat_files_db_append_shell_transcript(
		ctx,
		shell,
		`$ [${new Date(args.now).toISOString()}] job ${invocation.job.jobNumber} finished (exit ${args.exitCode}) in shell ${shell.name}${started}\n${invocation.job.script ?? ""}\n${args.stdout}\n${args.stderr}`,
	);
}

/**
 * The message a finished job owes the thread. Store a system message with the
 * job's outcome under the newest leaf of the thread. When no run holds the
 * thread's lease, also take the `job_wakeup` lease and schedule
 * `run_job_wakeup`, which answers that message. When a chat request or another
 * wakeup holds the lease, only the message is stored: the running turn reads it
 * at its next step boundary, and the turn-end catch schedules a wake run for
 * anything it never injected. `wakeNotifiedAt` keeps a job to one message, so
 * the settle and a late worker result can both try: only the first writes.
 * Shape borrowed from opencode background tasks (`task.ts`: `background`,
 * `jobId` in metadata, `notify` then `inject` as a fresh prompt), read at pin
 * `3dd1b305`.
 */
async function db_wake_agent_for_job(
	ctx: MutationCtx,
	invocation: BashJobRow,
	args: { exitCode: number; stdout: string; stderr: string; now: number },
) {
	if (invocation.wakeNotifiedAt !== undefined) return;
	// A job whose member lost access must not write into the thread or hold its run lease. The claim
	// settles exactly such a job, and that settle would otherwise wake the agent for a member who is
	// no longer there. Check the same permissions `get_job_wakeup_context` checks a moment later. A
	// role change keeps the membership. Without these checks the message would land in a thread the
	// member may no longer read, and the run it starts would be refused anyway.
	const membership = await ai_chat_files_db_get_invocation_membership(ctx, invocation);
	if (!membership) return;
	const thread = await ctx.db.get("ai_chat_threads", invocation.threadId);
	if (!thread) throw should_never_happen("Job thread not found", { threadId: invocation.threadId });
	// Read the lease once. A re-read later in this mutation would see the same snapshot, so it
	// cannot catch a release that lands mid-write. Convex serializes the two mutations and retries
	// this one with fresh state instead, which then takes the freed lease.
	const runActive = thread.activeRun !== undefined && thread.activeRun.expiresAt > args.now;
	const shell = await ctx.db.get("ai_chat_bash_shells", invocation.job.shellId);
	if (!shell) throw should_never_happen("Job shell not found", { shellId: invocation.job.shellId });

	// The newest message of the thread. That is the leaf of the branch the chat shows: with no branch
	// picked the client starts from the newest message and walks up to its root. A thread can have
	// more than one root, because editing the first user message stores the new one with no parent,
	// so walking down from the newest root instead would put the message on a branch the chat does not
	// render and give the woken run the wrong conversation to answer.
	const newestMessage = await ctx.db
		.query("ai_chat_threads_messages_aisdk_5")
		.withIndex("by_organization_workspace_thread", (q) =>
			q.eq("organizationId", thread.organizationId).eq("workspaceId", thread.workspaceId).eq("threadId", thread._id),
		)
		.order("desc")
		.first();
	const leafId = newestMessage?._id ?? null;

	const head = (text: string) =>
		text.length > BASH_JOB_WAKEUP_HEAD_CHARS
			? `${bash_text_head(text, BASH_JOB_WAKEUP_HEAD_CHARS)}\n[truncated]`
			: text;
	const jobNumber = invocation.job.jobNumber;
	const messageId = get_id_generator("ai_message")();
	const finishMessageId = await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
		organizationId: thread.organizationId,
		workspaceId: thread.workspaceId,
		parentId: leafId,
		threadId: thread._id,
		createdBy: invocation.userId,
		updatedAt: args.now,
		jobFinishInvocationId: invocation._id,
		clientGeneratedMessageId: messageId,
		content: {
			id: messageId,
			role: "system",
			parts: [
				{
					type: "text",
					text:
						`${BASH_JOB_FINISH_MESSAGE_START}${jobNumber}${BASH_JOB_FINISH_MESSAGE_MIDDLE}${shell.name} with exit ${args.exitCode}.\n` +
						`stdout:\n${head(args.stdout)}\nstderr:\n${head(args.stderr)}\n` +
						`Full output: jobs -o ${jobNumber} or /shells/${shell.name}/transcript.`,
				},
			],
		},
	});
	// Mark the message before anything can try again: the settle and a late worker result both call
	// this, and only one of them may write.
	await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { wakeNotifiedAt: args.now });
	// A run is still writing under this leaf, so take no lease and schedule
	// nothing. The running turn injects this message at its next step
	// boundary, and its turn-end catch schedules a wake run for anything left.
	if (runActive) {
		await ctx.db.patch("ai_chat_threads", thread._id, {
			lastMessageAt: args.now,
			updatedAt: args.now,
			updatedBy: invocation.userId,
		});
		return;
	}
	await ctx.db.patch("ai_chat_threads", thread._id, {
		lastMessageAt: args.now,
		updatedAt: args.now,
		updatedBy: invocation.userId,
		activeRun: { kind: "job_wakeup", expiresAt: args.now + BASH_JOB_WAKEUP_RUN_MS },
	});
	await ctx.scheduler.runAfter(0, internal.ai_chat.run_job_wakeup, {
		invocationId: invocation._id,
		threadId: thread._id,
		finishMessageId,
	});
}

async function db_stop_bash_job_transfers(
	ctx: MutationCtx,
	invocation: BashJobRow,
	reason: "user" | "timeout",
	now: number,
) {
	// One command at a time owns this job's transfer lane, so a live run is among the newest receipts.
	// Read only the newest five to keep this settle bounded.
	const transfers = await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) => q.eq("invocationId", invocation._id))
		.order("desc")
		.take(5);
	for (const transfer of transfers) await files_transfer_db_request_stop(ctx, { runId: transfer.runId, reason, now });
}

/**
 * Settle a job that stored no result: the watchdog, a Stop while queued, a crashed worker, or a
 * dead membership at claim or pause. Only the settle that finds the job doc still running marks it
 * `interrupted` and writes the finish entry. A retried settle cannot write a duplicate line.
 * The first settle wins on the Activity; `activities_db_finish` ignores the rest.
 */
async function db_settle_bash_job(
	ctx: MutationCtx,
	invocation: BashJobRow,
	args: { status: "failed" | "canceled" | "timed_out"; errorMessage: string | null; now: number },
) {
	if (invocation.status === "running") {
		await db_stop_bash_job_transfers(ctx, invocation, args.status === "timed_out" ? "timeout" : "user", args.now);
		if (invocation.job.copy)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_bash_job_copy_pages, {
				invocationId: invocation._id,
				commandNumber: invocation.job.copy.commandNumber,
			});
		const activity = await activities_db_get_by_source_id(ctx, invocation._id);
		// Empty the same fields `finish_bash_job` empties: the job is over, so nothing needs the script
		// or the paused state again, and a killed paused job would otherwise keep 128 KiB of state
		// until the row is deleted. The lines below read the copy taken before this patch, so the
		// finish entry still prints the script. A worker never runs the emptied row: this mutation also
		// finishes the Activity, and `claim_bash_job` returns nothing for a job whose Activity is not
		// active any more.
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			status: "interrupted",
			finishedAt: args.now,
			job: {
				...invocation.job,
				script: null,
				shellState: null,
				resumeScript: undefined,
				resumeCommandNumber: undefined,
				resumeLaunchedJobNumbers: undefined,
				liveOutput: undefined,
				copy: undefined,
			},
		});
		// The worker stored no result, so the output it flushed so far is all the transcript gets.
		const outcome = {
			exitCode: bash_job_exit_code(args.status, null),
			stdout: invocation.job.liveOutput?.stdout ?? "",
			stderr: invocation.job.liveOutput?.stderr ?? "",
			now: args.now,
		};
		await db_append_job_finish_entry(ctx, invocation, { ...outcome, startedAt: activity?.startedAt });
		await db_wake_agent_for_job(ctx, invocation, outcome);
	}
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
	await activities_db_finish(ctx, {
		sourceId: invocation._id,
		status: args.status,
		errorMessage: args.errorMessage,
		now: args.now,
	});
}

/**
 * The launch behind `&`. The hook calls it from a foreground call and from a job worker (a job
 * may start jobs). One transaction: the cap, the job number, the row, the Activity, the start
 * entry, the pool item and the placeholder watchdog. The synthetic `toolCallId` lets a replayed
 * launch find the row it already made.
 */
export const start_bash_job = internalMutation({
	args: {
		/**
		 * The caller's own row: a call or a job. The job copies its membership and lifetime, so a
		 * job dies with the session that launched it.
		 */
		parentInvocationId: v.id("ai_chat_bash_invocations"),
		commandNumber: v.number(),
		shellId: v.id("ai_chat_bash_shells"),
		script: v.string(),
		startCwd: v.string(),
		startCwdTarget: v.union(files_pending_target_validator, v.null()),
		shellState: bash_shell_state_validator,
		allowDbFilesMkdir: v.boolean(),
		/**
		 * Present when the launching call asked to be woken when the job ends.
		 */
		wakeAgent: v.optional(v.object({ modelId: ai_chat_model_id_validator })),
	},
	returns: v_result({ _yay: v.object({ jobNumber: v.number() }) }),
	handler: async (ctx, args) => {
		const parent = await ctx.db.get("ai_chat_bash_invocations", args.parentInvocationId);
		if (!parent || !(await ai_chat_files_db_get_invocation_membership(ctx, parent)))
			return Result({ _nay: { message: "Unauthorized" } });
		const shell = await ctx.db.get("ai_chat_bash_shells", args.shellId);
		if (!shell || shell.threadId !== parent.threadId) return Result({ _nay: { message: "Unauthorized" } });
		if (!Number.isSafeInteger(args.commandNumber) || args.commandNumber < 0)
			return Result({ _nay: { message: "Invalid Bash command number." } });

		// A lost reply replays the launch; the synthetic id finds the row it already made.
		const toolCallId = `job:${parent._id}:${args.commandNumber}`;
		const existing = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", parent.threadId).eq("toolCallId", toolCallId))
			.first();
		if (existing) {
			if (!existing.job) throw should_never_happen("Job row without job fields", { invocationId: existing._id });
			return Result({ _yay: { jobNumber: existing.job.jobNumber } });
		}

		// A stopping or already finished job must not start children. A chat call is not an Activity
		// source, so only a job parent is checked, and with a non-throwing read: the drain can
		// delete a parent's Activity while its worker still runs, and that parent must not start
		// children either. A parent the feed already shows as ended is the stronger case of the
		// same rule, so refuse any parent that is no longer active.
		if (parent.job) {
			const parentActivity = await activities_db_get_by_source_id(ctx, parent._id);
			if (
				!parentActivity ||
				!activities_is_active(parentActivity.status) ||
				parentActivity.status === "stopping" ||
				parentActivity.stopRequestedAt !== undefined ||
				parent.job.stopRequestedAt !== null
			)
				return Result({ _nay: { message: "the parent job has ended or is stopping" } });
		}

		if (new TextEncoder().encode(args.script).byteLength > BASH_JOB_SCRIPT_MAX_BYTES)
			return Result({ _nay: { message: "the job script is larger than 64 KiB" } });
		if (new TextEncoder().encode(JSON.stringify(args.shellState)).byteLength > BASH_JOB_SHELL_STATE_MAX_BYTES)
			return Result({ _nay: { message: "the shell state is larger than 128 KiB" } });

		// Live jobs per user and workspace, on the Activity rows. Nested jobs count too, so a
		// runaway job stops at the cap.
		let live = 0;
		for (const status of ["queued", "running", "stopping"] as const) {
			live += (
				await ctx.db
					.query("activities")
					.withIndex("by_user_workspace_source_kind_status", (q) =>
						q
							.eq("userId", parent.userId)
							.eq("workspaceId", parent.workspaceId)
							.eq("source.kind", "ai_chat_bash_job")
							.eq("status", status),
					)
					.take(BASH_JOB_LIVE_MAX_COUNT + 1)
			).length;
			if (live >= BASH_JOB_LIVE_MAX_COUNT)
				return Result({
					_nay: {
						name: "limit",
						message: `${BASH_JOB_LIVE_MAX_COUNT} jobs are already active across your workspace (queued, running or stopping). Some may be in another chat, where \`jobs\` and \`wait\` cannot name them. Wait for one of this chat's jobs, or start more in a later call.`,
					},
				});
		}

		// Job numbers only grow. Rows are deleted 7 days after finishing, so the highest stored
		// number can be gone while lower ones remain.
		const thread = await ctx.db.get("ai_chat_threads", parent.threadId);
		if (!thread) throw should_never_happen("Job thread not found", { threadId: parent.threadId });
		const jobNumber = (thread.bashJobCounter ?? 0) + 1;
		await ctx.db.patch("ai_chat_threads", thread._id, { bashJobCounter: jobNumber });

		const now = Date.now();
		const deadlineAt = now + BASH_JOB_PLACEHOLDER_MS;
		const scriptPreview = bash_text_head(args.script.replace(/\s+/g, " ").trim(), 80);
		const invocationId = await ctx.db.insert("ai_chat_bash_invocations", {
			organizationId: parent.organizationId,
			workspaceId: parent.workspaceId,
			userId: parent.userId,
			threadId: parent.threadId,
			toolCallId,
			commandHash: await crypto_sha256_hex(JSON.stringify([args.script, args.allowDbFilesMkdir])),
			membershipId: parent.membershipId,
			membershipLifetime: parent.membershipLifetime,
			status: "running",
			deadlineAt,
			transferDeadlineAt: deadlineAt,
			job: {
				jobNumber,
				shellId: shell._id,
				parentInvocationId: parent._id,
				commandNumber: args.commandNumber,
				script: args.script,
				startCwd: args.startCwd,
				startCwdTarget: args.startCwdTarget,
				shellState: args.shellState,
				allowDbFilesMkdir: args.allowDbFilesMkdir,
				workId: null,
				workerGeneration: 0,
				watchdogId: null,
				stopRequestedAt: null,
				wakeAgent: args.wakeAgent,
			},
		});
		await activities_db_start(ctx, {
			organizationId: parent.organizationId,
			workspaceId: parent.workspaceId,
			userId: parent.userId,
			membershipId: parent.membershipId,
			membershipLifetime: parent.membershipLifetime,
			source: {
				kind: "ai_chat_bash_job",
				id: invocationId,
				threadId: parent.threadId,
				jobNumber,
				shellName: shell.name,
				parentJobNumber: parent.job?.jobNumber ?? null,
				scriptPreview,
			},
			title: `Background command ${jobNumber}`,
			targets: [],
			visibility: "requester",
			feedVisible: true,
			status: "queued",
			resultKind: "bash_result",
			deadlineAt,
			now,
		});
		await ai_chat_files_db_append_shell_transcript(
			ctx,
			shell,
			`[${new Date(now).toISOString()}] job ${jobNumber} started in shell ${shell.name}: ${scriptPreview}`,
		);

		// Both ids go on the row: `handle_bash_job_complete` fences on `workId`, and every stop path
		// cancels `watchdogId`. The annotation breaks a type cycle through the generated `internal`.
		const workId = await ai_chat_bash_jobs_workpool.enqueueAction(
			ctx,
			internal.bash.run_job,
			{ invocationId, workerGeneration: 0 },
			{ onComplete: internal.ai_chat_files.handle_bash_job_complete, context: { invocationId } },
		);
		const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
			deadlineAt,
			internal.ai_chat_files.timeout_bash_job,
			{ invocationId, expectedDeadlineAt: deadlineAt },
		);
		const inserted = await db_get_job_row(ctx, invocationId);
		if (!inserted) throw should_never_happen("Inserted Bash job not found", { invocationId });
		await ctx.db.patch("ai_chat_bash_invocations", invocationId, { job: { ...inserted.job, workId, watchdogId } });
		return Result({ _yay: { jobNumber } });
	},
});

export type ai_chat_files_start_bash_job_Result =
	typeof start_bash_job extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The worker's own settle. Store the bounded result with the foreground retention, empty the big
 * job fields in the same patch so they never coexist with the result, write the finish entry and
 * settle the Activity. Accept a row the watchdog already marked `interrupted` and refuse only
 * `finished`: the worker's real output is worth more than the watchdog's 124, but on such a row
 * the finish entry, the Activity and the wakeup are left to the settle that already did them.
 * There is no membership gate: a job that lost its membership stops through the poll, and a gate
 * here would drop its result.
 */
export const finish_bash_job = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), workId: vWorkId, result: ai_chat_bash_result_validator },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (!invocation || invocation.status === "finished" || invocation.job.workId !== args.workId) return null;
		// The watchdog beat the worker to the row: it marked it `interrupted` and already told the
		// user the job ended.
		const settled = invocation.status !== "running";

		const now = Date.now();
		const exitCode = args.result.metadata.exitCode;
		const status =
			exitCode === 0
				? "succeeded"
				: exitCode === bash_COMMAND_EXIT_STOPPED
					? "canceled"
					: exitCode === bash_COMMAND_EXIT_TIMED_OUT
						? "timed_out"
						: "failed";
		await db_stop_bash_job_transfers(ctx, invocation, status === "timed_out" ? "timeout" : "user", now);
		if (invocation.job.copy)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_bash_job_copy_pages, {
				invocationId: invocation._id,
				commandNumber: invocation.job.copy.commandNumber,
			});
		// `liveOutput: undefined` drops the field: Convex leaves an undefined field out of a nested
		// object, and the patch replaces the whole `job` object.
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			status: "finished",
			finishedAt: now,
			result: bash_result_bounded(args.result),
			resultExpiresAt: now + BASH_RESULT_RETENTION_MS,
			job: {
				...invocation.job,
				script: null,
				shellState: null,
				resumeScript: undefined,
				resumeCommandNumber: undefined,
				resumeLaunchedJobNumbers: undefined,
				liveOutput: undefined,
				copy: undefined,
			},
		});
		if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
		// Strip this row's own result on time, like a foreground call does. Without it the daily
		// cron is the only thing that empties a job row, and a job result can be 700 KiB.
		await ctx.scheduler.runAt(now + BASH_RESULT_RETENTION_MS, internal.ai_chat_files.expire_bash_invocation_result, {
			invocationId: invocation._id,
		});

		const activity = await activities_db_get_by_source_id(ctx, invocation._id);
		const outcome = {
			// The message the agent reads must not contradict `wait`, `jobs -o` and the feed. A watchdog or
			// a Stop can settle the Activity while this worker is still finishing, and the code stored
			// above is then the code of a script that ran to its end. The Activity decides, as it does
			// for the two commands. On the normal path the Activity is still running here, so this is
			// the stored code.
			exitCode: bash_job_exit_code(activity?.status ?? status, exitCode),
			stdout: args.result.stdout,
			stderr: args.result.stderr,
			now,
		};
		// A settle that ran first already wrote the finish entry and ended the Activity. The result
		// above is still stored, because that is the worker's real output, but these two run once: a
		// second entry would contradict the first one's exit code.
		if (!settled) {
			// The transcript keeps the full output; the row keeps the bounded copy.
			await db_append_job_finish_entry(ctx, invocation, { ...outcome, startedAt: activity?.startedAt });
			await activities_db_finish(ctx, {
				sourceId: invocation._id,
				status,
				errorMessage: status === "failed" ? `Command exited with code ${exitCode}` : null,
				now,
			});
		}

		// The wake runs even on a settled row. The first of settle or this result stores the
		// message. The other finds `wakeNotifiedAt` set and adds nothing.
		await db_wake_agent_for_job(ctx, invocation, outcome);
		return null;
	},
});

/**
 * The `wait` door of a call that ends the turn (`wakeOnJobFinish`): stamp the caller's own
 * live jobs with the turn's model for their wake run, and return the numbers armed. A job
 * that already ended is skipped; `wait` then reads its result the normal way.
 */
export const arm_bash_job_wakeup = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		jobNumbers: v.array(v.number()),
		modelId: ai_chat_model_id_validator,
	},
	returns: v.array(v.number()),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) return [];
		const armed: number[] = [];
		for (const jobNumber of args.jobNumbers.slice(0, bash_JOB_NUMBERS_MAX_COUNT)) {
			const activity = await db_get_job_activity(ctx, { ...args, jobNumber });
			if (
				!activity ||
				activity.organizationId !== membership._yay.organizationId ||
				activity.workspaceId !== membership._yay.workspaceId ||
				!activities_is_active(activity.status)
			)
				continue;
			const invocation = await db_get_job_row(ctx, activity.source.id);
			if (!invocation || invocation.status !== "running") continue;
			if (!invocation.job.wakeAgent)
				await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
					job: { ...invocation.job, wakeAgent: { modelId: args.modelId } },
				});
			armed.push(jobNumber);
		}
		return armed;
	},
});

/**
 * The worker's first call. Re-arm the three clocks from the worker start, swap the watchdog, and
 * hand back what the worker needs to build its file system. Return `null` without reviving the
 * job when it was stopped or settled while queued: `handle_bash_job_complete` settles the Stop
 * case, and a dead membership is settled `canceled` here so the Activity never sits `queued`
 * until `recover_expired` mislabels it.
 */
export const claim_bash_job = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), workerGeneration: v.number() },
	returns: v.union(
		v.null(),
		v.object({
			row: doc(app_convex_schema, "ai_chat_bash_invocations"),
			organizationName: v.string(),
			workspaceName: v.string(),
			shells: v.array(v.object({ _id: v.id("ai_chat_bash_shells"), name: v.string() })),
		}),
	),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		// An older queued worker must not claim a later pause or rearm its clocks.
		if (!invocation || invocation.job.workerGeneration !== args.workerGeneration) return null;
		const now = Date.now();

		// The membership helper binds the row's tenant fields; read the names only after it.
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))) {
			await db_settle_bash_job(ctx, invocation, { status: "canceled", errorMessage: null, now });
			return null;
		}
		const organization = await ctx.db.get("organizations", invocation.organizationId);
		const workspace = await ctx.db.get("organizations_workspaces", invocation.workspaceId);
		if (!organization || !workspace) return null;

		const activity = await activities_db_get_by_source_id(ctx, invocation._id);
		if (
			!activity ||
			!activities_is_active(activity.status) ||
			activity.status === "stopping" ||
			invocation.job.stopRequestedAt !== null
		)
			return null;

		const copy = invocation.job.copy;
		if (copy && (copy.phase === "delivering" || (copy.phase === "admitting" && !copy.sealed))) {
			await db_settle_bash_job(ctx, invocation, {
				status: "failed",
				errorMessage: "Copy continuation cannot be replayed after a lost worker.",
				now,
			});
			return null;
		}
		const deadlineAt = copy ? await db_bash_job_copy_deadline(ctx, invocation) : now + BASH_JOB_RUN_MS;
		if (
			deadlineAt === null ||
			deadlineAt <= now ||
			(copy?.phase !== "waiting" &&
				now - invocation._creationTime - (invocation.job.excludedCopyWaitMs ?? 0) >= BASH_JOB_LIFETIME_MS)
		) {
			await db_settle_bash_job(ctx, invocation, { status: "timed_out", errorMessage: null, now });
			return null;
		}
		if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
		// The annotation breaks a type cycle: the id flows into the returned row, and the generated
		// `internal` type depends on this function's return type.
		const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
			deadlineAt,
			internal.ai_chat_files.timeout_bash_job,
			{
				invocationId: invocation._id,
				expectedDeadlineAt: deadlineAt,
			},
		);
		const patch = {
			deadlineAt,
			transferDeadlineAt: Math.min(
				now + BASH_JOB_RUN_MS - BASH_JOB_SETTLE_HEADROOM_MS,
				copy?.phase === "admitting" ? deadlineAt : Infinity,
			),
			job: { ...invocation.job, watchdogId },
		};
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
		// A run after a pause keeps the job's first start time.
		await ctx.db.patch("activities", activity._id, {
			status: "running",
			startedAt: activity.startedAt ?? now,
			deadlineAt,
			updatedAt: now,
		});

		const shells = await ctx.db
			.query("ai_chat_bash_shells")
			.withIndex("by_thread_name", (q) => q.eq("threadId", invocation.threadId))
			.collect();
		// `ctx.db.patch` does not change the fetched doc, so merge the armed clocks by hand.
		return {
			row: { ...invocation, ...patch },
			organizationName: organization.name,
			workspaceName: workspace.name,
			shells: shells.map((shell) => ({ _id: shell._id, name: shell.name })),
		};
	},
});

export type ai_chat_files_claim_bash_job_Result =
	typeof claim_bash_job extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The watchdog. A placeholder watchdog can run after `claim_bash_job` re-armed the clocks, since
 * `scheduler.cancel` cannot recall a mutation that was already dispatched. It settles only when
 * the row still carries the deadline it was scheduled for.
 */
export const timeout_bash_job = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations"), expectedDeadlineAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		const now = Date.now();
		if (!invocation || invocation.deadlineAt !== args.expectedDeadlineAt || invocation.deadlineAt > now) return null;
		await ai_chat_files_db_request_job_stop(ctx, { invocationId: invocation._id, reason: "timeout", now });
		return null;
	},
});

/**
 * The pool callback. `pool.cancel` only removes a queued item and a worker is never retried, so
 * this is the settle for a Stop while queued and for a worker that threw. A plain success means
 * the worker already stored through `finish_bash_job` or exited on a settled Activity; a success
 * after a Stop is the worker that left `claim_bash_job` with `null`.
 */
export const handle_bash_job_complete = internalMutation({
	args: vOnCompleteArgs(v.object({ invocationId: v.id("ai_chat_bash_invocations") })),
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.context.invocationId);
		// A superseded worker's callback must no-op.
		if (!invocation || invocation.job.workId !== args.workId) return null;

		const now = Date.now();
		const stopRequested = invocation.job.stopRequestedAt !== null;
		if (args.result.kind === "success" && !stopRequested) return null;
		if (args.result.kind === "failed" && !stopRequested) {
			if (await db_requeue_bash_job_copy(ctx, invocation, now)) return null;
			await db_settle_bash_job(ctx, invocation, { status: "failed", errorMessage: "Background command crashed", now });
			return null;
		}
		await db_settle_bash_job(ctx, invocation, { status: "canceled", errorMessage: null, now });
		return null;
	},
});

/**
 * The stop path shared by the Activity Stop button, `kill`, the watchdog and `recover_expired`.
 * A user stop is cooperative: it records the flag, the worker's poll sees it and aborts with 143.
 * Only the `"timeout"` reason settles, because `recover_expired` reads expired rows oldest first
 * and an unsettled row would take one slot in every batch forever.
 */
export async function ai_chat_files_db_request_job_stop(
	ctx: MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; reason: "user" | "timeout"; now: number },
) {
	const invocation = await db_get_job_row(ctx, args.invocationId);
	if (!invocation) return;

	// A user Stop that reaches its deadline is still a stop, not a timeout.
	if (args.reason === "timeout") {
		if (
			invocation.job.copy?.phase === "waiting" &&
			invocation.job.stopRequestedAt === null &&
			(await ai_chat_files_db_get_invocation_membership(ctx, invocation))
		) {
			const deadlineAt = await db_bash_job_copy_deadline(ctx, invocation);
			if (deadlineAt !== null && deadlineAt > args.now) {
				if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
				const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
					deadlineAt,
					internal.ai_chat_files.timeout_bash_job,
					{ invocationId: invocation._id, expectedDeadlineAt: deadlineAt },
				);
				await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
					deadlineAt,
					job: { ...invocation.job, watchdogId },
				});
				const activity = await activities_db_get_by_source_id(ctx, invocation._id);
				if (activity) await ctx.db.patch("activities", activity._id, { deadlineAt, updatedAt: args.now });
				return;
			}
		}
		await db_settle_bash_job(
			ctx,
			invocation,
			invocation.job.stopRequestedAt !== null
				? { status: "canceled", errorMessage: null, now: args.now }
				: { status: "timed_out", errorMessage: null, now: args.now },
		);
		return;
	}

	if (invocation.job.stopRequestedAt === null)
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			job: { ...invocation.job, stopRequestedAt: args.now },
		});
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (activity && activities_is_active(activity.status) && activity.status !== "stopping")
		await ctx.db.patch("activities", activity._id, {
			status: "stopping",
			stopRequestedAt: args.now,
			updatedAt: args.now,
		});
	if (invocation.job.workId !== null) await ai_chat_bash_jobs_workpool.cancel(ctx, invocation.job.workId);
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);

	await db_stop_bash_job_transfers(ctx, invocation, "user", args.now);
}

/**
 * The `kill` door. `content.read` is enough: an Ask-mode member can launch a job, and the
 * Activity Stop button works for them too. Returns whether a stop was recorded; `kill` prints
 * "no such job" otherwise and never ends the call.
 */
export const request_bash_job_stop = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		jobNumber: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) return false;
		const activity = await db_get_job_activity(ctx, args);
		if (
			!activity ||
			activity.organizationId !== membership._yay.organizationId ||
			activity.workspaceId !== membership._yay.workspaceId ||
			!activities_is_active(activity.status)
		)
			return false;
		await ai_chat_files_db_request_job_stop(ctx, { invocationId: activity.source.id, reason: "user", now: Date.now() });
		return true;
	},
});

/**
 * The worker's flush on its poll tick: the output head so far, for `jobs -o N`. Only a running
 * row takes it; a settle that raced ahead already wrote the finish entry and must not get a
 * head back on the row. The pool item id fences a worker that paused: its late flush must not
 * put an older head over the one the next run stores.
 */
export const flush_bash_job_output = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		liveOutput: ai_chat_bash_job_live_output_validator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (!invocation || invocation.status !== "running" || invocation.job.workId !== args.workId) return null;
		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			job: { ...invocation.job, liveOutput: args.liveOutput },
		});
		return null;
	},
});

/**
 * The worker's pause before a top-level statement: a bare `sleep` of 5 seconds or more, or the
 * run budget nearly used. Store what the next run needs (the remaining statements, the command
 * count, the jobs this job started, the state snapshot, the cwd and the output head), enqueue the
 * next run on the same pool after the sleep, swap the watchdog for a placeholder one, put the
 * Activity back to `queued` and append the pause entry with this run's output. Refuse a row that is
 * no longer running or has a Stop pending: the worker then returns without a result and the usual
 * settle path ends the job.
 */
export const pause_bash_job = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		workId: vWorkId,
		resume: v.object({
			script: v.string(),
			/**
			 * How many commands this run counted. The next run keeps counting from here so its
			 * launches and transfers get their own synthetic ids.
			 */
			commandNumber: v.number(),
			/**
			 * The jobs this run and the runs before it started, for a bare `wait`.
			 */
			launchedJobNumbers: v.array(v.number()),
			shellState: bash_shell_state_validator,
			cwd: v.string(),
			cwdTarget: v.union(files_pending_target_validator, v.null()),
		}),
		/**
		 * The head of the whole job's output so far, `null` while nothing was printed.
		 */
		liveOutput: v.union(ai_chat_bash_job_live_output_validator, v.null()),
		/**
		 * This run's output and exit code, for the pause entry.
		 */
		outcome: v.object({ exitCode: v.number(), stdout: v.string(), stderr: v.string() }),
		/**
		 * Why the job pauses, for the pause entry.
		 */
		reason: v.string(),
		runAfterMs: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (
			!invocation ||
			invocation.status !== "running" ||
			invocation.job.stopRequestedAt !== null ||
			invocation.job.workId !== args.workId
		)
			return false;
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))) {
			// A refused pause ends this worker; do not leave its Activity running until the watchdog.
			await db_settle_bash_job(ctx, invocation, { status: "canceled", errorMessage: null, now: Date.now() });
			return false;
		}
		const activity = await activities_db_get_by_source_id(ctx, invocation._id);
		if (!activity || !activities_is_active(activity.status) || activity.status === "stopping") return false;
		const shell = await ctx.db.get("ai_chat_bash_shells", invocation.job.shellId);
		if (!shell) throw should_never_happen("Job shell not found", { shellId: invocation.job.shellId });

		// The placeholder clocks cover the wait; the next claim re-arms them from its start.
		const now = Date.now();
		if (
			invocation.job.copy &&
			(invocation.job.copy.phase !== "delivering" || invocation.job.copy.workId !== args.workId)
		)
			return false;
		const ageDeadlineAt = invocation._creationTime + BASH_JOB_LIFETIME_MS + (invocation.job.excludedCopyWaitMs ?? 0);
		if (ageDeadlineAt <= now) {
			await db_settle_bash_job(ctx, invocation, { status: "timed_out", errorMessage: null, now });
			return false;
		}
		const deadlineAt = Math.min(now + args.runAfterMs + BASH_JOB_PLACEHOLDER_MS, ageDeadlineAt);
		if (invocation.job.copy)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_bash_job_copy_pages, {
				invocationId: invocation._id,
				commandNumber: invocation.job.copy.commandNumber,
			});
		if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);
		const workId = await ai_chat_bash_jobs_workpool.enqueueAction(
			ctx,
			internal.bash.run_job,
			{ invocationId: invocation._id, workerGeneration: invocation.job.workerGeneration + 1 },
			{
				onComplete: internal.ai_chat_files.handle_bash_job_complete,
				context: { invocationId: invocation._id },
				runAfter: args.runAfterMs,
			},
		);
		const watchdogId: Id<"_scheduled_functions"> = await ctx.scheduler.runAt(
			deadlineAt,
			internal.ai_chat_files.timeout_bash_job,
			{ invocationId: invocation._id, expectedDeadlineAt: deadlineAt },
		);

		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, {
			deadlineAt,
			transferDeadlineAt: deadlineAt,
			job: {
				...invocation.job,
				resumeScript: args.resume.script,
				resumeCommandNumber: args.resume.commandNumber,
				resumeLaunchedJobNumbers: args.resume.launchedJobNumbers,
				shellState: args.resume.shellState,
				startCwd: args.resume.cwd,
				startCwdTarget: args.resume.cwdTarget,
				liveOutput: args.liveOutput ?? undefined,
				workId,
				copy: undefined,
				workerGeneration: invocation.job.workerGeneration + 1,
				watchdogId,
			},
		});
		// The job waits for its next run like a fresh job waits for its first; `startedAt` stays.
		await ctx.db.patch("activities", activity._id, { status: "queued", deadlineAt, updatedAt: now });

		await ai_chat_files_db_append_shell_transcript(
			ctx,
			shell,
			`$ [${new Date(now).toISOString()}] job ${invocation.job.jobNumber} paused (exit ${args.outcome.exitCode}) in shell ${shell.name}: ${args.reason}\n${args.outcome.stdout}\n${args.outcome.stderr}`,
		);
		return true;
	},
});

/**
 * The worker's 5 s poll. `stopRequested` is the flag itself, not the row status: the watchdog can
 * mark the row `interrupted` while a slow worker is alive in its last 30 seconds, and that
 * worker must abort with the deadline reason, not the stop reason. `authorized` re-checks what
 * the chat route checked at launch: source read access. Each file write checks its destination.
 */
export const poll_bash_job = internalQuery({
	args: { invocationId: v.id("ai_chat_bash_invocations") },
	returns: v.object({
		status: v.union(app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.status, v.literal("missing")),
		stopRequested: v.boolean(),
		authorized: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const invocation = await db_get_job_row(ctx, args.invocationId);
		if (!invocation) return { status: "missing" as const, stopRequested: false, authorized: false };
		const stopRequested = invocation.job.stopRequestedAt !== null;
		// This helper is what sees a purge in progress and a removed member.
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, invocation);
		if (!membership) return { status: invocation.status, stopRequested, authorized: false };
		const copy = invocation.job.copy;
		if (invocation.status === "running" && copy && copy.phase !== "admitting" && copy.runId !== null) {
			const checked = await files_transfer_db_get_job_copy(ctx, {
				invocationId: invocation._id,
				commandNumber: copy.commandNumber,
				runId: copy.runId,
			});
			if (checked._nay) return { status: invocation.status, stopRequested, authorized: false };
		}
		return { status: invocation.status, stopRequested, authorized: true };
	},
});

export type ai_chat_files_poll_bash_job_Result =
	typeof poll_bash_job extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete one job in bounded passes: pool item and watchdog first, then Copy input and transfer receipts,
 * then the Activity, then the row. Never leave an Activity without its row, and never delete the
 * row after a `done: false` Activity page. `cleanup_history` and both deletion paths call this.
 */
export async function ai_chat_files_db_delete_job_batch(
	ctx: MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; batchSize: number },
) {
	const invocation = await db_get_job_row(ctx, args.invocationId);
	if (!invocation) return { done: true, deletedCount: 0 };
	if (invocation.job.workId !== null) await ai_chat_bash_jobs_workpool.cancel(ctx, invocation.job.workId);
	if (invocation.job.watchdogId !== null) await ctx.scheduler.cancel(invocation.job.watchdogId);

	const batchSize = Math.max(1, Math.min(50, args.batchSize));
	const pages = await ctx.db
		.query("ai_chat_bash_job_copy_pages")
		.withIndex("by_invocation_command_page", (q) => q.eq("invocationId", invocation._id))
		.take(batchSize);
	await Promise.all(pages.map((page) => ctx.db.delete("ai_chat_bash_job_copy_pages", page._id)));
	if (pages.length === batchSize) return { done: false, deletedCount: pages.length };
	const transfers = await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) => q.eq("invocationId", invocation._id))
		.take(batchSize - pages.length);
	await Promise.all(transfers.map((transfer) => ctx.db.delete("ai_chat_bash_invocation_transfers", transfer._id)));
	if (pages.length + transfers.length === batchSize) return { done: false, deletedCount: batchSize };

	let deletedCount = pages.length + transfers.length;
	const activity = await activities_db_get_by_source_id(ctx, invocation._id);
	if (activity) {
		const deletedActivity = await activities_db_delete(ctx, activity._id);
		deletedCount += deletedActivity.deletedCount;
		if (!deletedActivity.done) return { done: false, deletedCount };
	}
	await ctx.db.delete("ai_chat_bash_invocations", invocation._id);
	return { done: true, deletedCount: deletedCount + 1 };
}

/**
 * The door behind `jobs`, `jobs -a` and `wait`. Rows come from the Activity index, so one page
 * never reads an invocation row.
 */
export const list_thread_jobs = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		/**
		 * `live`: still queued, running or stopping (`jobs`). `newest`: the newest 8 by job number
		 * (`jobs -a`). `numbers`: the named jobs, unknown numbers skipped (`wait N`).
		 */
		select: v.union(
			v.object({ kind: v.literal("live") }),
			v.object({ kind: v.literal("newest") }),
			v.object({ kind: v.literal("numbers"), jobNumbers: v.array(v.number()) }),
		),
	},
	returns: v.array(bash_job_summary),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) throw convex_error({ message: membership._nay.message });
		const inScope = (activity: Doc<"activities">) =>
			activity.organizationId === membership._yay.organizationId &&
			activity.workspaceId === membership._yay.workspaceId;

		switch (args.select.kind) {
			case "live": {
				// A paste can use `.unique()` because one occupies the lane; four jobs can share a
				// status, so read a page. The cap keeps the page small, and it is per workspace, so
				// jobs of other threads are read and dropped here.
				const live: Doc<"activities">[] = [];
				for (const status of ["queued", "running", "stopping"] as const) {
					live.push(
						...(await ctx.db
							.query("activities")
							.withIndex("by_user_workspace_source_kind_status", (q) =>
								q
									.eq("userId", args.userId)
									.eq("workspaceId", membership._yay.workspaceId)
									.eq("source.kind", "ai_chat_bash_job")
									.eq("status", status),
							)
							.take(BASH_JOB_LIVE_MAX_COUNT + 1)),
					);
				}
				return live
					.filter(
						(activity) =>
							inScope(activity) &&
							activity.source.kind === "ai_chat_bash_job" &&
							activity.source.threadId === args.threadId,
					)
					.map(job_summary)
					.sort((a, b) => a.jobNumber - b.jobNumber);
			}
			case "newest": {
				const newest = await ctx.db
					.query("activities")
					.withIndex("by_user_source_kind_thread_jobNumber", (q) =>
						q.eq("userId", args.userId).eq("source.kind", "ai_chat_bash_job").eq("source.threadId", args.threadId),
					)
					.order("desc")
					.take(BASH_JOB_LIST_MAX_COUNT);
				return newest.filter(inScope).map(job_summary);
			}
			case "numbers": {
				// One index read per named number, so the list must be bounded. A validator cannot
				// limit an array's length, so refuse it here as well as in `wait`.
				if (args.select.jobNumbers.length > bash_JOB_NUMBERS_MAX_COUNT)
					throw convex_error({
						message: `Too many job numbers: at most ${bash_JOB_NUMBERS_MAX_COUNT} can be read at once`,
					});

				const found = [];
				for (const jobNumber of args.select.jobNumbers) {
					const activity = await db_get_job_activity(ctx, { userId: args.userId, threadId: args.threadId, jobNumber });
					if (activity && inScope(activity)) found.push(job_summary(activity));
				}
				return found;
			}
			default:
				throw should_never_happen("Unknown job selection", args.select satisfies never);
		}
	},
});

export type ai_chat_files_list_thread_jobs_Result =
	typeof list_thread_jobs extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The caller's live jobs in one thread, for the chat's tool spinner and jobs
 * popover. Same read as the `live` select of `list_thread_jobs`, but through
 * the caller's own membership: a member sees only the jobs they started.
 */
export const list_live_thread_jobs = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
	},
	returns: v.array(bash_job_summary),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return [];
		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) return [];
		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (
			!thread ||
			thread.createdBy !== userAuth.id ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		)
			return [];
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return [];
		const live: Doc<"activities">[] = [];
		for (const status of ["queued", "running", "stopping"] as const) {
			live.push(
				...(await ctx.db
					.query("activities")
					.withIndex("by_user_workspace_source_kind_status", (q) =>
						q
							.eq("userId", userAuth.id)
							.eq("workspaceId", membership.workspaceId)
							.eq("source.kind", "ai_chat_bash_job")
							.eq("status", status),
					)
					.take(BASH_JOB_LIVE_MAX_COUNT + 1)),
			);
		}
		return live
			.filter(
				(activity) =>
					activity.organizationId === membership.organizationId &&
					activity.source.kind === "ai_chat_bash_job" &&
					activity.source.threadId === threadId,
			)
			.map(job_summary)
			.sort((a, b) => a.jobNumber - b.jobNumber);
	},
});

/**
 * The door behind `jobs -o N`. `activityStatus` says whether the job is still live, because that is
 * the status the feed and `jobs -a` show. The finish message prints the matching exit code.
 * `liveOutput` is the head a running worker flushed so far. `wait` reads `read_job_exit_codes`
 * instead, which returns no output.
 */
export const read_job_output = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		jobNumber: v.number(),
	},
	returns: v.union(
		v.null(),
		v.object({
			activityStatus: app_convex_schema.tables.activities.validator.fields.status,
			result: v.union(ai_chat_bash_result_validator, v.null()),
			liveOutput: v.union(ai_chat_bash_job_live_output_validator, v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) throw convex_error({ message: membership._nay.message });
		const activity = await db_get_job_activity(ctx, args);
		if (
			!activity ||
			activity.organizationId !== membership._yay.organizationId ||
			activity.workspaceId !== membership._yay.workspaceId
		)
			return null;
		// The delete batch removes the Activity and the row in one pass, so the row is here.
		const invocation = await ctx.db.get("ai_chat_bash_invocations", activity.source.id);
		if (!invocation)
			throw should_never_happen("Job Activity points to a missing invocation", { activityId: activity._id });
		return {
			activityStatus: activity.status,
			result: invocation_result(invocation).result,
			liveOutput: invocation.job?.liveOutput ?? null,
		};
	},
});

export type ai_chat_files_read_job_output_Result =
	typeof read_job_output extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The exit code `wait` reports for each job it waited. `bash_job_exit_code` holds the rule, so the
 * `jobs -o` marker reports the same code for the same job.
 *
 * Only the codes come back, because a stored result is up to 700 KiB and `wait` needs one number per
 * job. The rows are still read here. A row whose Activity settled as timed out or stopped is skipped,
 * and the rest are finished rows, whose other large fields are already nulled, so the read is about
 * 700 KiB per job: 12 of them stay near 8.2 MiB in one transaction, against the 16 MiB a transaction
 * may read. The cleanup pass in this file keeps its own job-row reads at 8 for the same byte reason,
 * over a set whose length it does not know; this list cannot be longer than
 * `bash_JOB_NUMBERS_MAX_COUNT`.
 */
export const read_job_exit_codes = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		jobNumbers: v.array(v.number()),
	},
	returns: v.array(v.object({ jobNumber: v.number(), exitCode: v.number() })),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, args);
		if (membership._nay) throw convex_error({ message: membership._nay.message });
		// One index read per named number, so the list must be bounded. A validator cannot limit an
		// array's length, so refuse it here as well as in `wait`.
		if (args.jobNumbers.length > bash_JOB_NUMBERS_MAX_COUNT)
			throw convex_error({
				message: `Too many job numbers: at most ${bash_JOB_NUMBERS_MAX_COUNT} can be read at once`,
			});

		const codes = [];
		for (const jobNumber of args.jobNumbers) {
			const activity = await db_get_job_activity(ctx, { userId: args.userId, threadId: args.threadId, jobNumber });
			if (
				!activity ||
				activity.organizationId !== membership._yay.organizationId ||
				activity.workspaceId !== membership._yay.workspaceId
			) {
				codes.push({ jobNumber, exitCode: bash_COMMAND_EXIT_FAILURE });
				continue;
			}
			// A settled Activity already decides the code, so skip the row read for those two.
			if (activity.status === "timed_out" || activity.status === "canceled") {
				codes.push({ jobNumber, exitCode: bash_job_exit_code(activity.status, null) });
				continue;
			}
			// The delete batch removes the Activity and the row in one pass, so the row is here.
			const invocation = await ctx.db.get("ai_chat_bash_invocations", activity.source.id);
			if (!invocation)
				throw should_never_happen("Job Activity points to a missing invocation", { activityId: activity._id });
			const { result } = invocation_result(invocation);
			codes.push({ jobNumber, exitCode: bash_job_exit_code(activity.status, result?.metadata.exitCode ?? null) });
		}
		return codes;
	},
});

export type ai_chat_files_read_job_exit_codes_Result =
	typeof read_job_exit_codes extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export async function ai_chat_files_db_get_bash_transfer(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number },
) {
	return await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) =>
			q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber),
		)
		.first();
}

/**
 * The producer calls this in the same mutation that accepts the transfer.
 */
export async function ai_chat_files_db_link_bash_transfer(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		runId: Id<"files_transfer_runs">;
		activityId: Id<"activities">;
	},
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	if (!invocation || !(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
		return Result({ _nay: { message: "Unauthorized" } });
	if (!Number.isSafeInteger(args.commandNumber) || args.commandNumber < 0)
		return Result({ _nay: { message: "Invalid Bash command number." } });
	const existing = await ai_chat_files_db_get_bash_transfer(ctx, args);
	if (existing) {
		if (existing.runId !== args.runId || existing.activityId !== args.activityId)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash command already started another transfer." },
			});
		return Result({ _yay: existing });
	}
	if (invocation.status !== "running" || invocation.deadlineAt <= Date.now())
		return Result({
			_nay: { name: "invocation_interrupted", message: "This Bash call has ended. Start a new command." },
		});
	// A user stop does not change the row status, so the flag is checked on its own.
	if (invocation.job && invocation.job.stopRequestedAt !== null)
		return Result({ _nay: { name: "stopped", message: "This job is stopping. No new transfer can start." } });
	const link = {
		...args,
		organizationId: invocation.organizationId,
		workspaceId: invocation.workspaceId,
		threadId: invocation.threadId,
	};
	const id = await ctx.db.insert("ai_chat_bash_invocation_transfers", link);
	return Result({ _yay: (await ctx.db.get("ai_chat_bash_invocation_transfers", id))! });
}

/**
 * Accepted jobs are observable while the Bash action is still awaiting its result.
 */
export const list_bash_invocation_transfers = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		toolCallId: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.union(
		v.null(),
		v.object({
			invocationId: v.id("ai_chat_bash_invocations"),
			status: app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.status,
			page: v.array(
				v.object({ commandNumber: v.number(), runId: v.id("files_transfer_runs"), activityId: v.id("activities") }),
			),
			isDone: v.boolean(),
			continueCursor: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const invocation = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (!invocation || invocation.userId !== userAuth.id || invocation.membershipId !== args.membershipId) return null;
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, invocation);
		if (!membership) return null;
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return null;
		const result = await ctx.db
			.query("ai_chat_bash_invocation_transfers")
			.withIndex("by_invocation_commandNumber", (q) => q.eq("invocationId", invocation._id))
			.paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)) });
		return {
			invocationId: invocation._id,
			status: invocation_result(invocation).status,
			page: result.page.map(({ commandNumber, runId, activityId }) => ({ commandNumber, runId, activityId })),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const load_thread_tmp_files = internalQuery({
	args: {
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
	},
	returns: v.object({
		file_nodes: v.array(doc(app_convex_schema, "ai_chat_files")),
		file_nodes_content_dict: v.record(v.id("ai_chat_files"), doc(app_convex_schema, "ai_chat_files_content")),
	}),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (
			!invocation ||
			invocation.threadId !== args.threadId ||
			!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))
		)
			throw convex_error({ message: "Unauthorized" });

		const fileNodes = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContentDict: Record<Id<"ai_chat_files">, Doc<"ai_chat_files_content">> = {};
		for (const content of fileNodesContent) {
			fileNodesContentDict[content.fileNodeId] = content;
		}

		return {
			file_nodes: fileNodes,
			file_nodes_content_dict: fileNodesContentDict,
		};
	},
});

export type ai_chat_files_load_thread_tmp_files_Result =
	typeof load_thread_tmp_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const patch_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
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
		// A path is a value here, never a field name: Convex allows only printable ASCII field names, so a
		// record keyed by path refuses the whole call for a file named `café.txt`.
		fileNodesContent: v.array(v.object({ path: v.string(), content: v.bytes() })),
		deletePaths: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (
			!invocation ||
			invocation.organizationId !== args.organizationId ||
			invocation.workspaceId !== args.workspaceId ||
			invocation.threadId !== args.threadId ||
			!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))
		) {
			throw convex_error({ message: "The Bash thread is no longer available." });
		}

		// Rejoining does not let an old call write into the creator's thread scratch.
		const existingAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const existingByPath = new Map(existingAiChatFiles.map((fileNode) => [fileNode.path, fileNode]));

		await Promise.all(
			args.deletePaths.map(async (path) => {
				const existing = existingByPath.get(path);
				if (!existing) {
					return;
				}
				const aiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
					.collect();
				await Promise.all([
					...aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)),
					ctx.db.delete("ai_chat_files", existing._id),
				]);
			}),
		);

		const contentByPath = new Map(args.fileNodesContent.map((entry) => [entry.path, entry.content]));
		await Promise.all(
			args.fileNodes.map(async (fileNode) => {
				const doc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.kind === "symlink" && fileNode.symlinkTargetPath !== undefined
						? { symlinkTargetPath: fileNode.symlinkTargetPath }
						: {}),
				};
				const existing = existingByPath.get(fileNode.path);
				const fileNodeId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
				if (existing) {
					await ctx.db.replace("ai_chat_files", existing._id, doc);
				}

				if (fileNode.kind !== "file") {
					if (existing) {
						const aiChatFilesContent = await ctx.db
							.query("ai_chat_files_content")
							.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
							.collect();
						await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
					}
					return;
				}

				const bytes = contentByPath.get(fileNode.path);
				if (bytes === undefined) {
					return;
				}
				const existingAiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", fileNodeId))
					.first();
				const contentDoc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					fileNodeId,
					bytes,
				};
				if (existingAiChatFilesContent) {
					await ctx.db.replace("ai_chat_files_content", existingAiChatFilesContent._id, contentDoc);
				} else {
					await ctx.db.insert("ai_chat_files_content", contentDoc);
				}
			}),
		);

		return null;
	},
});

export type ai_chat_files_patch_thread_tmp_files_Args =
	typeof patch_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer Args, infer _ReturnValue>
		? Args
		: never;

export const copy_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const membership = await db_get_door_membership(ctx, { ...args, threadId: args.sourceThreadId });
		if (membership._nay) throw convex_error({ message: membership._nay.message });
		const targetThread = await ctx.db.get("ai_chat_threads", args.targetThreadId);
		if (
			!targetThread ||
			targetThread.createdBy !== args.userId ||
			targetThread.organizationId !== membership._yay.organizationId ||
			targetThread.workspaceId !== membership._yay.workspaceId
		)
			throw convex_error({ message: "Unauthorized" });

		const sourceAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const sourceAiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const contentByFileNodeId = new Map(sourceAiChatFilesContent.map((content) => [content.fileNodeId, content]));

		// The branch target is created in the same transaction, so source rows are inserted as-is.
		await Promise.all(
			sourceAiChatFiles.map(async (fileNode) => {
				const fileNodeId = await ctx.db.insert("ai_chat_files", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.targetThreadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.symlinkTargetPath !== undefined ? { symlinkTargetPath: fileNode.symlinkTargetPath } : {}),
				});
				const content = contentByFileNodeId.get(fileNode._id);
				if (content) {
					await ctx.db.insert("ai_chat_files_content", {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						threadId: args.targetThreadId,
						fileNodeId,
						bytes: content.bytes,
					});
				}
			}),
		);

		return null;
	},
});
