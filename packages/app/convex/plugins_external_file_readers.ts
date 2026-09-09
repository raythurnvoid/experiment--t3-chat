import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalMutation, type ActionCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import { files_nodes_db_require_writable } from "./files_nodes.ts";
import { plugins_external_files_db_replace_readers } from "./plugins_external_files.ts";
import { plugins_external_files_db_authorize } from "./plugins_external_files_access.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import { rate_limiter_http_client_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { crypto_sha256_hex, crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

export const rollback = internalMutation({
	args: {
		writerId: v.id("plugins_external_file_writers"),
		operationId: v.string(),
		writerGeneration: v.number(),
		receiptId: v.optional(v.id("plugins_external_file_receipts")),
		originalReaderOperationId: v.optional(v.string()),
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			_id: v.union(v.id("plugins_external_file_receipts"), v.null()),
			readerRevision: v.number(),
			detached: v.boolean(),
			restored: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		if ((args.receiptId === undefined) === (args.originalReaderOperationId === undefined))
			return Result({ _nay: { message: "Choose one reader operation" } });
		const receipt = args.receiptId
			? await ctx.db.get("plugins_external_file_receipts", args.receiptId)
			: await ctx.db
					.query("plugins_external_file_receipts")
					.withIndex("by_writer_operationId", (q) =>
						q.eq("writerId", args.writerId).eq("operationId", args.originalReaderOperationId!),
					)
					.first();
		const change = receipt
			? await ctx.db
					.query("plugins_external_file_reader_changes")
					.withIndex("by_receipt", (q) => q.eq("receiptId", receipt._id))
					.first()
			: null;
		if (
			(args.receiptId && !receipt) ||
			(receipt &&
				(!change ||
					change.writerId !== args.writerId ||
					(receipt.operation !== "readers" && receipt.operation !== "cancel_readers")))
		)
			return Result({ _nay: { message: "Unauthenticated" } });
		const writer = await ctx.db.get("plugins_external_file_writers", args.writerId);
		if (!writer) return Result({ _nay: { message: "Unauthenticated" } });
		const installation = await ctx.db.get("plugins_workspace_installations", writer.installationId);
		if (
			!installation ||
			installation.status !== "enabled" ||
			!(await plugins_db_get_live_service_account(ctx, {
				installation,
				serviceAccountId: installation.serviceAccountId,
			})) ||
			![
				"plugin.service.connect",
				"workspace.files.write",
				"workspace.files.own-write",
				"workspace.files.own-access",
			].every((capability) => installation.acceptedCapabilities.some((accepted) => accepted === capability))
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const [workspace, registration] = await Promise.all([
			ctx.db.get("organizations_workspaces", installation.workspaceId),
			ctx.db
				.query("plugins_service_registrations")
				.withIndex("by_pluginName", (q) => q.eq("pluginName", installation.pluginName))
				.first(),
		]);
		if (
			!workspace ||
			workspace.organizationId !== installation.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			!registration?.scopes.includes("files:write") ||
			!crypto_timing_safe_equal(registration.exchangeSecretHash, args.serviceSecretHash)
		)
			return Result({ _nay: { message: "Unauthenticated" } });
		const grant = change
			? await ctx.db.get("plugin_service_grants", change.grantId)
			: await ctx.db
					.query("plugin_service_grants")
					.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
					.first();
		const proof = change ?? grant;
		// Report a proof mismatch only to the current registered service.
		if (
			!proof ||
			proof.installationId !== installation._id ||
			(!change &&
				(!grant ||
					grant.phase !== "processing" ||
					!grant.scopes.includes("files:write") ||
					grant.destinationPathPrefix !== writer.rootPath))
		)
			return Result({ _nay: { name: "reader_proof_mismatch", message: "Unauthenticated" } });
		// An old bearer proves only this undo. It cannot authorize new Files work.
		const matchesProof =
			crypto_timing_safe_equal(proof.tokenHash, args.tokenHash) ||
			Boolean(grant && crypto_timing_safe_equal(grant.tokenHash, args.tokenHash));
		const currentProof =
			installation.pluginVersionId === proof.pluginVersionId &&
			installation.serviceAccountId === proof.serviceAccountId;
		let recoveryGrant: Doc<"plugin_service_grants"> | null = null;
		if (!matchesProof || !currentProof) {
			if (matchesProof) return Result({ _nay: { name: "reader_proof_mismatch", message: "Unauthenticated" } });
			const presented = await ctx.db
				.query("plugin_service_grants")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
				.first();
			if (!presented) return Result({ _nay: { name: "reader_proof_mismatch", message: "Unauthenticated" } });
			// After an upgrade or rebind, recovery needs current authority for this exact destination.
			const authorized = await plugins_external_files_db_authorize(ctx, {
				grantId: presented._id,
				tokenHash: args.tokenHash,
				serviceSecretHash: args.serviceSecretHash,
				path: writer.path,
				allowSealRoot: true,
			});
			if (authorized._nay) return authorized;
			if (presented.installationId !== writer.installationId || presented.destinationPathPrefix !== writer.rootPath)
				return Result({ _nay: { message: "Permission denied" } });
			recoveryGrant = presented;
		}
		const authority = recoveryGrant ?? proof;
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `${installation._id}:rollback-readers`,
		});
		if (rateLimit) return Result({ _nay: { name: "rate_limit", message: rateLimit.message } });
		const originalOperationId = receipt?.operationId ?? args.originalReaderOperationId!;
		if (originalOperationId === args.operationId)
			return Result({ _nay: { name: "stale_write", message: "Use a separate rollback operation" } });
		const fingerprint = JSON.stringify([args.writerGeneration, originalOperationId]);
		const repeated = await ctx.db
			.query("plugins_external_file_receipts")
			.withIndex("by_writer_operationId", (q) => q.eq("writerId", writer._id).eq("operationId", args.operationId))
			.first();
		if (repeated && (repeated.operation !== "rollback_readers" || repeated.fingerprint !== fingerprint))
			return Result({ _nay: { name: "stale_write", message: "This operation was already used" } });
		const completed =
			repeated ??
			(change?.rollbackReceiptId ? await ctx.db.get("plugins_external_file_receipts", change.rollbackReceiptId) : null);
		if (completed)
			return Result({
				_yay: { _id: completed._id, readerRevision: completed.readerRevision!, detached: false, restored: true },
			});
		const [root, folder, binding] = await Promise.all([
			ctx.db.get("files_nodes", writer.rootNodeId),
			ctx.db.get("files_nodes", writer.folderNodeId),
			ctx.db
				.query("plugins_external_file_bindings")
				.withIndex("by_writer", (q) => q.eq("writerId", writer._id))
				.first(),
		]);
		if (
			!root ||
			root.path !== writer.rootPath ||
			root.archiveOperationId !== null ||
			!folder ||
			(receipt && folder._id !== receipt.nodeId) ||
			folder.path !== writer.path ||
			folder.archiveOperationId !== null ||
			!binding
		)
			return Result({ _nay: { name: "stale_write", message: "The output folder changed" } });
		if (binding.detachedAt !== null)
			return Result({ _yay: { _id: null, readerRevision: binding.revision, detached: true, restored: false } });
		if (
			recoveryGrant &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: writer.organizationId,
				workspaceId: writer.workspaceId,
				userId: recoveryGrant.actorUserId,
				serviceAccountId: recoveryGrant.serviceAccountId,
				fileNode: folder,
				permission: "content.permissions.manage",
			}))
		)
			return Result({ _nay: { message: "Permission denied" } });
		if (
			writer.generation !== args.writerGeneration ||
			(receipt && (receipt.writerGeneration !== args.writerGeneration || binding.revision !== receipt.readerRevision))
		)
			return Result({ _nay: { name: "stale_write", message: "A newer file access change exists" } });
		for (const node of [root, folder]) {
			if (
				(await files_metadata_db_read_entry(ctx, {
					organizationId: writer.organizationId,
					workspaceId: writer.workspaceId,
					fileNodeId: node._id,
					key: "plugin-name",
				})) !== installation.pluginName
			)
				return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: writer.organizationId,
			workspaceId: writer.workspaceId,
			writeContext: {
				writer: { kind: "service_account", serviceAccountId: authority.serviceAccountId },
				actorUserId: authority.actorUserId,
				resourceScope: { kind: "node", nodeId: folder._id },
				policyReach: "ancestors",
			},
			target: { kind: "node", node: folder },
		});
		if (writable._nay) return writable;
		let readerRevision = binding.revision;
		let originalReceiptId = receipt?._id;
		if (change) {
			const readers = [];
			for (const reader of change.previousReaders) {
				const membership = await organizations_membership_lifetimes_db_get(ctx, {
					workspaceId: writer.workspaceId,
					userId: reader.userId,
				});
				if (membership?.active && membership.lifetime === reader.membershipLifetime) readers.push(reader);
			}
			await plugins_external_files_db_replace_readers(ctx, { installation, nodeId: folder._id, readers });
			readerRevision++;
			await ctx.db.patch("plugins_external_file_bindings", binding._id, {
				revision: readerRevision,
				updatedAt: Date.now(),
			});
		} else {
			// Reserve the original ID before acknowledging cancellation, so a delayed apply cannot win.
			originalReceiptId = await ctx.db.insert("plugins_external_file_receipts", {
				organizationId: writer.organizationId,
				workspaceId: writer.workspaceId,
				installationId: installation._id,
				writerId: writer._id,
				operationId: originalOperationId,
				operation: "cancel_readers",
				fingerprint,
				path: writer.path,
				sequence: 0,
				writerGeneration: writer.generation,
				nodeId: folder._id,
				contentRevision: null,
				readerRevision,
				createdAt: Date.now(),
			});
		}
		const id = await ctx.db.insert("plugins_external_file_receipts", {
			organizationId: writer.organizationId,
			workspaceId: writer.workspaceId,
			installationId: installation._id,
			writerId: writer._id,
			operationId: args.operationId,
			operation: "rollback_readers",
			fingerprint,
			path: writer.path,
			sequence: 0,
			writerGeneration: writer.generation,
			nodeId: folder._id,
			contentRevision: null,
			readerRevision,
			createdAt: Date.now(),
		});
		if (change) {
			await ctx.db.patch("plugins_external_file_reader_changes", change._id, { rollbackReceiptId: id });
		} else {
			await ctx.db.insert("plugins_external_file_reader_changes", {
				organizationId: writer.organizationId,
				workspaceId: writer.workspaceId,
				installationId: installation._id,
				writerId: writer._id,
				receiptId: originalReceiptId!,
				grantId: grant!._id,
				tokenHash: args.tokenHash,
				pluginVersionId: proof.pluginVersionId,
				serviceAccountId: proof.serviceAccountId,
				actorUserId: proof.actorUserId,
				previousReaders: [],
				nextReaders: [],
				rollbackReceiptId: id,
			});
		}
		return Result({ _yay: { _id: id, readerRevision, detached: false, restored: true } });
	},
});
type rollback_Result = typeof rollback extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

const body_validator = z
	.object({
		writerId: z.string(),
		operationId: z.string().min(1).max(128),
		writerGeneration: z.number().int().positive(),
		receiptId: z.string().optional(),
		originalReaderOperationId: z.string().min(1).max(128).optional(),
	})
	.strict()
	.refine(
		(body) => (body.receiptId === undefined) !== (body.originalReaderOperationId === undefined),
		"Choose one reader operation",
	);
export type plugins_external_file_readers_http_undo_Body = z.infer<typeof body_validator>;

export async function plugins_external_file_readers_http_undo(ctx: ActionCtx, request: Request) {
	const token = request.headers.get("Authorization")?.match(/^Bearer (psg_[A-Za-z0-9_-]+)$/)?.[1];
	const secret = request.headers.get("X-Bonobo-Service-Authorization")?.match(/^Bearer (.+)$/)?.[1];
	const body = await server_request_json_parse_and_validate(request, body_validator);
	if (body._nay) return { status: 400, body: { message: body._nay.message } } as const;
	if (!token || !secret) return { status: 401, body: { message: "Unauthenticated" } } as const;

	const checked = await ctx.runQuery(internal.plugins_external_files.check_public_request, {
		writerId: body._yay.writerId,
		receiptId: body._yay.receiptId,
	});
	if (checked._nay) return { status: 400, body: { message: checked._nay.message } } as const;

	const result: rollback_Result = await ctx.runMutation(internal.plugins_external_file_readers.rollback, {
		...body._yay,
		writerId: body._yay.writerId as Id<"plugins_external_file_writers">,
		receiptId: body._yay.receiptId as Id<"plugins_external_file_receipts"> | undefined,
		tokenHash: await crypto_sha256_hex(token),
		serviceSecretHash: await crypto_sha256_hex(secret),
	});
	if (!result._nay) return { status: 200, body: result._yay, headers: { "Cache-Control": "no-store" } } as const;
	if (result._nay.message === "Unauthenticated") {
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_auth",
			key: `${rate_limiter_http_client_key(request)}:rollback-readers`,
		});
		if (rateLimit) return { status: 429, body: { message: rateLimit.message } } as const;
		return {
			status: 401,
			body: {
				message: result._nay.message,
				...(result._nay.name === "reader_proof_mismatch" ? { code: "reader_proof_mismatch" } : {}),
			},
		} as const;
	}
	if (result._nay.name === "rate_limit") return { status: 429, body: { message: result._nay.message } } as const;
	return {
		status: result._nay.name === "stale_write" || result._nay.name === "read_only" ? 409 : 403,
		body: { message: result._nay.message },
	} as const;
}
