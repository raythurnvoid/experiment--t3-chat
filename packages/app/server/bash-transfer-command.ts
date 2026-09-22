import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { CommandContext, ExecResult } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import {
	files_TRANSFER_SELECTION_PAGE_SIZE,
	type files_PendingParent,
	type files_PendingTarget,
} from "../shared/files.ts";
import { path_name_of, path_extract_segments_from } from "../shared/paths.ts";
import {
	bash_ABORT_REASON_STOPPED,
	bash_COMMAND_EXIT_STOPPED,
	bash_COMMAND_EXIT_TIMED_OUT,
	bash_resolve_db_files_shell_path,
	bash_resolve_path,
	bash_parse_cp_mv_operands,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";

export type bash_TransferContext = {
	invocationId: Id<"ai_chat_bash_invocations">;
	membershipId: Id<"organizations_workspaces_users">;
	deadlineAt: number;
	signal: AbortSignal;
	abort: (reason?: unknown) => void;
	nextCommandNumber: () => number;
	/**
	 * The job row when this shell is a background job's worker, `null` in a foreground call. A
	 * job's copy waits for a busy lane instead of failing, and polls slower.
	 */
	jobId: Id<"ai_chat_bash_invocations"> | null;
};

// Up to 10 live jobs share one transfer lane per user and workspace. A job's copy waits this long for it.
const LANE_WAIT_MAX_MS = 60_000;
const LANE_WAIT_POLL_MS = 2_000;

async function stop_transfer(
	ctx: ActionCtx,
	scope: {
		membershipId: Id<"organizations_workspaces_users">;
		threadId: Id<"ai_chat_threads">;
		runId: Id<"files_transfer_runs">;
	},
	reason: "user" | "timeout",
) {
	try {
		const stopped = await ctx.runMutation(internal.files_transfer.stop_for_agent, { ...scope, reason });
		if (stopped._yay === null) return;
	} catch {
		// Read back a lost Stop reply before allowing later shell statements.
	}

	const view = await ctx.runQuery(internal.files_transfer.get_for_agent, scope);
	if (!view || ["queued", "running", "awaiting_input"].includes(view.activity.status))
		throw new Error(`Stop could not be confirmed for transfer ${scope.runId}`);
}

/**
 * How an abort ends a copy. A job Stop aborts the shell with its own reason: the transfer is
 * stopped as "user" and the command reports 143. Anything else is the deadline: "timeout", 124.
 */
function abort_outcome(signal: AbortSignal) {
	return signal.reason === bash_ABORT_REASON_STOPPED
		? { reason: "user" as const, exitCode: bash_COMMAND_EXIT_STOPPED, word: "stopped" }
		: { reason: "timeout" as const, exitCode: bash_COMMAND_EXIT_TIMED_OUT, word: "timed out" };
}

/**
 * Resolve exact input before admission. This only reads entries; it starts no work.
 */
export async function bash_transfer_command_prepare(args: {
	ctx: ActionCtx;
	dbFilesRoots: bash_DbFilesRoots;
	transferContext: bash_TransferContext | undefined;
	command: "cp" | "mv";
	commandCtx: Pick<CommandContext, "cwd">;
	parsed: NonNullable<ReturnType<typeof bash_parse_cp_mv_operands>["_yay"]>;
}) {
	const { dbFilesRoots, command, commandCtx, parsed, transferContext } = args;
	const fail = (message: string) => ({ result: { stdout: "", stderr: `${command}: ${message}\n`, exitCode: 1 } });

	if (!dbFilesRoots.app.fs.allowDbFilesMkdir) return fail("app file writes require Agent mode");

	// The current root owns the chat even when both operands point to personal files.
	const threadId = dbFilesRoots.app.fs.ctxData.threadId;
	if (!transferContext || !threadId) return fail("this command has no active Bash invocation");

	const aborted = () => {
		const outcome = abort_outcome(transferContext.signal);
		return { result: { stdout: "", stderr: `${command}: transfer ${outcome.word}\n`, exitCode: outcome.exitCode } };
	};
	if (transferContext.signal.aborted || Date.now() >= transferContext.deadlineAt) return aborted();

	const resolvedSources = parsed.sources.map((source) => ({
		source,
		root: bash_resolve_db_files_shell_path(bash_resolve_path(commandCtx.cwd, source.path), dbFilesRoots),
	}));
	const sourceRoot = resolvedSources[0]!.root;
	const destinationRoot = bash_resolve_db_files_shell_path(
		bash_resolve_path(commandCtx.cwd, parsed.destination.path),
		dbFilesRoots,
	);
	const destinationPath = destinationRoot.dbFilesPath;
	if (
		resolvedSources.some(({ root }) => root.kind !== "app" || root.dbFilesPath === null) ||
		destinationRoot.kind !== "app" ||
		destinationPath === null
	)
		return fail("all sources and the destination must be app paths");

	// Check every resolved workspace before reading files or preparing any output.
	if (
		command === "mv" &&
		resolvedSources.some(
			({ root }) =>
				root.ctxData.organizationId !== destinationRoot.ctxData.organizationId ||
				root.ctxData.workspaceId !== destinationRoot.ctxData.workspaceId,
		)
	)
		return fail(
			"Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.",
		);

	if (
		resolvedSources.some(
			({ root }) =>
				root.ctxData.organizationId !== sourceRoot.ctxData.organizationId ||
				root.ctxData.workspaceId !== sourceRoot.ctxData.workspaceId,
		)
	)
		return fail("all sources must be in one workspace; run a separate command for each source workspace");

	const sources: files_PendingTarget[] = [];
	for (const { source, root } of resolvedSources) {
		const entry = await root.fs.getEntry(root.dbFilesPath!);
		if (!entry?.target || entry.target.kind === "root") return fail(`source '${source.path}' is not available`);
		if (entry.preparing) return fail(`draft '${source.path}' is still preparing`);
		if (source.requiresFolder && entry.kind !== "folder") return fail(`'${source.path}' is not a directory`);
		if (command === "cp" && entry.kind === "folder" && !parsed.recursive) return fail("copying a folder requires -R");
		sources.push(entry.target);
	}

	if (command === "mv" && sources.length > 200) return fail("select at most 200 sources");

	const destination = await destinationRoot.fs.getEntry(destinationPath);
	if (destination?.preparing) return fail("the destination draft is still preparing");

	if (parsed.destination.requiresFolder && destination?.kind !== "folder")
		return fail("the destination must be an existing directory");

	let targetPath: string;
	let targetParent: files_PendingParent;
	let targetName: string | null = null;
	const missingParentNames: string[] = [];

	if (destination?.kind === "folder" && !parsed.noTargetDirectory) {
		targetPath = destinationPath;
		if (!destination.target) return fail("the destination is not available");
		targetParent = destination.target;
	} else {
		if (sources.length !== 1) return fail("multiple sources require a directory destination");

		// Let the transfer check the literal path before normalizing a missing name.
		targetName = path_name_of(destinationPath);
		targetPath = `/${path_extract_segments_from(destinationPath).slice(0, -1).join("/")}`;

		let parent = await destinationRoot.fs.getEntry(targetPath);
		// The transfer start refuses more than 32 missing parents. Stop the walk at that count.
		// The check below then refuses this command with the destination message.
		while (!parent && command === "cp" && targetPath !== "/" && missingParentNames.length < 32) {
			missingParentNames.unshift(path_name_of(targetPath));
			targetPath = `/${path_extract_segments_from(targetPath).slice(0, -1).join("/")}`;
			parent = await destinationRoot.fs.getEntry(targetPath);
		}

		if (parent?.kind !== "folder" || !parent.target) return fail("the destination parent is not a directory");
		targetParent = parent.target;

		if (
			command === "mv" &&
			destination?.target &&
			destination.target.kind === sources[0]!.kind &&
			destination.target.id === sources[0]!.id
		)
			return { result: { stdout: "", stderr: "", exitCode: 0 } };
	}

	return {
		prepared: {
			threadId,
			transferContext,
			sourceRoot,
			destinationRoot,
			sourceWorkspace: sourceRoot.fs === dbFilesRoots.app.fs ? ("current" as const) : ("personal" as const),
			destinationWorkspace: destinationRoot.fs === dbFilesRoots.app.fs ? ("current" as const) : ("personal" as const),
			sources,
			targetParent,
			targetPath,
			targetName,
			missingParentNames,
		},
	};
}

/**
 * App copies and moves use the same durable transfer jobs as Files.
 */
export async function bash_transfer_command_run(
	args: Parameters<typeof bash_transfer_command_prepare>[0],
): Promise<ExecResult> {
	const preparation = await bash_transfer_command_prepare(args);
	if (!("prepared" in preparation)) return preparation.result;
	const {
		threadId,
		transferContext,
		sourceRoot,
		destinationRoot,
		sourceWorkspace,
		destinationWorkspace,
		sources,
		targetParent,
		targetPath,
		targetName,
		missingParentNames,
	} = preparation.prepared;
	const { ctx, command, parsed } = args;
	const commandNumber = transferContext.nextCommandNumber();
	const fail = (message: string) => ({ stdout: "", stderr: `${command}: ${message}\n`, exitCode: 1 });
	const aborted = () => {
		const outcome = abort_outcome(transferContext.signal);
		return { stdout: "", stderr: `${command}: transfer ${outcome.word}\n`, exitCode: outcome.exitCode };
	};

	// A job waits for a busy lane instead of failing: up to 10 live jobs share one lane per user and
	// workspace. The wait reads only this non-charging query, so it never spends the rate limit
	// the user's own Files UI shares; `start_for_agent` then runs once, and its `busy` is final.
	if (transferContext.jobId !== null) {
		const until = Math.min(Date.now() + LANE_WAIT_MAX_MS, transferContext.deadlineAt);
		for (;;) {
			const current = await ctx.runQuery(internal.files_transfer.get_current_activity_for_agent, {
				membershipId: transferContext.membershipId,
				threadId,
			});
			if (!current) break;
			if (current.status === "awaiting_input")
				return fail(`a transfer in this workspace is waiting for input (activity ${current.activityId})`);
			if (transferContext.signal.aborted || Date.now() >= until) break;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LANE_WAIT_POLL_MS, until - Date.now())));
		}
		// A Stop that landed during the wait must not start a copy.
		if (transferContext.signal.aborted) return aborted();
	}

	const started = await ctx
		.runMutation(internal.files_transfer.start_for_agent, {
			membershipId: transferContext.membershipId,
			threadId,
			sourceWorkspace,
			destinationWorkspace,
			invocation: { id: transferContext.invocationId, commandNumber },
			requestId: `${transferContext.invocationId}:${commandNumber}`,
			kind: command === "cp" ? "copy" : "move",
			sources: command === "cp" ? sources.slice(0, files_TRANSFER_SELECTION_PAGE_SIZE) : sources,
			...(command === "cp" ? { expectedSourceCount: sources.length } : {}),
			targetParent,
			targetPath,
			targetName,
			missingParentNames,
			conflictPolicy: {
				file: parsed.conflictPolicy,
				folder:
					command === "cp"
						? "merge"
						: parsed.conflictPolicy === "skip"
							? "skip"
							: parsed.noTargetDirectory && parsed.conflictPolicy === "replace"
								? "replace_empty"
								: "error",
			},
		})
		.catch((error: unknown) => {
			// A lost start reply may hide an accepted job. End this shell call before later writes.
			transferContext.abort(error);
			throw error;
		});

	if (started._nay)
		return {
			...fail(started._nay.message + (started._nay.data ? ` (activity ${started._nay.data.activityId})` : "")),
			exitCode: started._nay.name === "timed_out" ? bash_COMMAND_EXIT_TIMED_OUT : 1,
		};

	const { runId, activityId } = started._yay;
	const scope = { membershipId: transferContext.membershipId, threadId, runId };

	try {
		if (command === "cp") {
			// Copy cannot execute until every selected source has been accepted and sealed.
			for (let offset = files_TRANSFER_SELECTION_PAGE_SIZE; ; offset += files_TRANSFER_SELECTION_PAGE_SIZE) {
				if (transferContext.signal.aborted || Date.now() >= transferContext.deadlineAt) {
					await stop_transfer(ctx, scope, abort_outcome(transferContext.signal).reason);
					return aborted();
				}
				const intake =
					offset < sources.length
						? await ctx.runMutation(internal.files_transfer.append_sources_for_agent, {
								...scope,
								offset,
								sources: sources.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
							})
						: await ctx.runMutation(internal.files_transfer.seal_for_agent, scope);
				if (intake._nay) {
					await stop_transfer(ctx, scope, "user");
					return fail(intake._nay.message);
				}
				if (offset >= sources.length) break;
			}
		}

		for (;;) {
			const view = await ctx.runQuery(internal.files_transfer.get_for_agent, scope);
			if (!view) throw new Error("Transfer access changed");
			const { activity } = view;
			if (!["queued", "running", "stopping"].includes(activity.status)) {
				const progress = activity.progress;
				const summary = `${progress?.completed ?? 0} ready for review, ${progress?.skipped ?? 0} skipped, ${progress?.failed ?? 0} failed`;
				return {
					stdout: `Transfer ${runId}: ${summary}. Activity ${activityId}. Review in Files.\n`,
					stderr: activity.errorMessage ? `${command}: ${activity.errorMessage}\n` : "",
					exitCode: activity.status === "succeeded" ? 0 : 1,
				};
			}

			if (transferContext.signal.aborted || Date.now() >= transferContext.deadlineAt) {
				const outcome = abort_outcome(transferContext.signal);
				await stop_transfer(ctx, scope, outcome.reason);
				return {
					stdout: "",
					stderr: `${command}: transfer ${outcome.word}; remaining work was stopped. Activity ${activityId}\n`,
					exitCode: outcome.exitCode,
				};
			}

			// A job's copy is long-lived; a foreground copy answers within the call's 90 seconds.
			await new Promise<void>((resolve) => setTimeout(resolve, transferContext.jobId !== null ? 2_000 : 200));
		}
	} catch (error) {
		// A lost intake reply may have committed. Stop accepted work before any later shell write.
		try {
			await stop_transfer(
				ctx,
				scope,
				transferContext.signal.aborted ? abort_outcome(transferContext.signal).reason : "user",
			);
		} finally {
			transferContext.abort(error);
		}
		throw error;
	} finally {
		sourceRoot.fs.resetProposalCaches();
		if (destinationRoot.fs !== sourceRoot.fs) destinationRoot.fs.resetProposalCaches();
	}
}
