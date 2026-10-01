import { z } from "zod";

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const time = z.number().int().positive();

/**
 * The one command kind: a free Playwright script, like the cloud browser runs.
 */
export const playwriter_browser_operation_schema = z
	.object({ kind: z.literal("script"), code: z.string().min(1).max(20_000) })
	.strict();

const playwriter_browser_source_schema = z.object({ chatId: id, sourceMessageId: id, toolCallId: id }).strict();
const base = { connectionId: id, ownerId: id, organizationId: id, workspaceId: id };
const command_identity = {
	generation: revision,
	commandId: id,
	operationHash: z.string().regex(/^[a-f0-9]{64}$/u),
	source: playwriter_browser_source_schema,
	deadline: time,
	receiptResolutionDeadline: time,
};
export const playwriter_browser_receipt_request_schema = z.object({ ...base, ...command_identity }).strict();
export type PlaywriterBrowserReceiptRequest = z.infer<typeof playwriter_browser_receipt_request_schema>;

export const playwriter_browser_connect_schema = z
	.object({
		...base,
		shareId: z.string().regex(/^[a-f0-9]{32}$/u),
		attemptId: id,
		expectedTargetId: id.nullable(),
		paused: z.boolean(),
		idleExpiresAt: time,
		totalExpiresAt: time,
		sessionId: id,
		operations: revision,
		allowedVersions: z.array(z.string().min(1).max(32)).min(1).max(16),
		agentBlockedHosts: z.array(z.string().min(1).max(253)).max(100),
		agentAccess: z.boolean(),
		policyRevision: revision,
		controlRevision: revision,
	})
	.strict();
export type PlaywriterBrowserConnect = z.infer<typeof playwriter_browser_connect_schema>;

export const playwriter_browser_reconnect_schema = playwriter_browser_connect_schema
	.extend({ previousSessionId: id })
	.strict();

export const playwriter_browser_confirm_schema = z
	.object({ ...base, generation: revision, targetId: id, inventoryRevision: revision })
	.strict();
export const playwriter_browser_control_schema = z
	.object({ ...base, generation: revision, controlRevision: revision })
	.strict();
export const playwriter_browser_access_schema = z
	.object({
		...base,
		generation: revision,
		agentAccess: z.boolean(),
		policyRevision: revision,
		agentBlockedHosts: z.array(z.string().min(1).max(253)).max(100),
	})
	.strict();
export const playwriter_browser_status_schema = z.object(base).strict();
export const playwriter_browser_disconnect_schema = z.object({ ...base, generation: revision.optional() }).strict();
export const playwriter_browser_run_schema = z
	.object({
		...base,
		...command_identity,
		controlRevision: revision,
		policyRevision: revision,
		targetRevision: revision,
		navRevision: revision,
		targetId: id,
		allowedVersions: z.array(z.string().min(1).max(32)).min(1).max(16),
		operation: playwriter_browser_operation_schema,
		lastResolved: playwriter_browser_receipt_request_schema.optional(),
	})
	.strict();
export type PlaywriterBrowserRun = z.infer<typeof playwriter_browser_run_schema>;

const playwriter_browser_runtime_schema = z
	.object({
		generation: revision,
		state: z.enum([
			"connecting",
			"awaiting_confirmation",
			"connected",
			"paused",
			"needs_human",
			"expired",
			"disconnected",
			"failed",
		]),
		targets: z
			.array(z.object({ targetId: id, title: z.string().max(1024), url: z.string().max(8192) }).strict())
			.max(64),
		targetRevision: revision,
		navRevision: revision,
		confirmedTargetId: id.nullable(),
		controlRevision: revision,
		policyRevision: revision,
		agentAccess: z.boolean(),
		operations: revision,
		idleExpiresAt: time,
		totalExpiresAt: time,
		sessionId: id,
		inventoryRevision: revision,
	})
	.strict();
export type PlaywriterBrowserRuntime = z.infer<typeof playwriter_browser_runtime_schema>;

const completed_lease = z
	.object({
		generation: revision,
		controlRevision: revision,
		policyRevision: revision,
		confirmedTargetId: id,
		targetRevision: revision,
		navRevision: revision,
	})
	.strict();
export type PlaywriterBrowserCompletedLease = z.infer<typeof completed_lease>;

const playwriter_browser_result_schema = z
	.object({
		ok: z.boolean(),
		reason: z.string().max(128).nullable(),
		inputSent: z.boolean(),
		cleanup: z.enum(["complete", "unknown"]),
	})
	.strict();
export type PlaywriterBrowserResult = z.infer<typeof playwriter_browser_result_schema>;

/**
 * What a `script` command gives back. The runner sends it only with a `completed` receipt. The
 * limits match the cloud browser.
 */
const script_output = z
	.object({
		status: z.enum(["succeeded", "errored", "timed_out"]),
		resultJson: z.string().max(16_384).nullable(),
		resultTruncated: z.boolean(),
		error: z.object({ name: z.string().max(128), message: z.string().max(1001) }).strict().nullable(),
		logs: z.array(z.string().max(16_384)).max(100),
		logsTruncated: z.boolean(),
		consoleEntries: z.array(z.string().max(4096)).max(50),
		pageErrors: z.array(z.string().max(4096)).max(50),
		stateWarnings: z.array(z.string().max(400)).max(20),
		// Files the script emitted, for example a screenshot. Only a succeeded script has any. The
		// runner keeps them within 8 files and 8 MiB, and base64 turns every 3 bytes into 4 characters.
		files: z
			.array(
				z
					.object({
						workspace: z.enum(["current", "personal"]),
						path: z.string().min(1).max(1024),
						contentType: z.string().min(1).max(255).optional(),
						dataBase64: z.string().max(4 * Math.ceil((8 * 1024 * 1024) / 3)),
					})
					.strict(),
			)
			.max(8),
	})
	.strict();
export type PlaywriterBrowserScriptOutput = z.infer<typeof script_output>;

export const playwriter_browser_response_schema = z.union([
	z.object({ ok: z.literal(true), runtime: playwriter_browser_runtime_schema }).strict(),
	z
		.object({
			ok: z.literal(true),
			status: z.enum(["completed", "refused", "unknown", "in_progress", "not_started", "acknowledged"]),
			runtime: playwriter_browser_runtime_schema,
			completedLease: completed_lease.nullable(),
			result: playwriter_browser_result_schema.nullable(),
			script: script_output.optional(),
			consumedAck: playwriter_browser_receipt_request_schema.optional(),
		})
		.strict(),
	z
		.object({
			ok: z.literal(false),
			error: z.object({ code: z.string().max(128), message: z.string().max(256) }).strict(),
		})
		.strict(),
]);
