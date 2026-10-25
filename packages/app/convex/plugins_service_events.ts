// Signed access notices for plugin services: a thin "your installation has access changes up to revision
// R" POST to the version's `serviceEventsUrl`. The service then pulls the changes itself through
// `/api/v1/plugins/access/changes`, so the notice holds no member data.
//
// The flow has three steps. `dispatch` maps feed docs to receivers and raises their pending revision.
// `start_delivery` claims one receiver and schedules `deliver`, which POSTs the notice. `record_delivery`
// saves the answer and plans the next try.

import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalAction, type MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	crypto_decrypt_secret_value,
	crypto_encrypt_secret_value,
	crypto_random_hex,
	crypto_timing_safe_equal,
} from "../server/crypto-utils.ts";
import { mcp_guarded_fetch_is_allowed_url } from "../server/mcp-guarded-fetch.ts";

/**
 * Wait after failed tries in a row: 5 s, 30 s, 2 min, 10 min, 30 min, then every hour. There is no
 * last try: the service does not poll, so giving up would hide changes until its next lease.
 */
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The watchdog waits at least this long after the request timeout. The action may start late, and it
 * still has to decrypt the key and record the answer.
 */
const WATCHDOG_MARGIN_MS = 30_000;
const RETRY_AFTER_MIN_MS = 5_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
const MAX_REPLY_BYTES = 4096;
const PAUSE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const SIGNING_KEY_BYTES = 32;
const DISPATCH_FEED_BATCH_SIZE = 50;
const DISPATCH_RECEIVER_BATCH_SIZE = 100;

async function db_job_is_live(ctx: MutationCtx, jobId: Id<"_scheduled_functions"> | null) {
	const job = jobId ? await ctx.db.system.get("_scheduled_functions", jobId) : null;
	return job?.state.kind === "pending" || job?.state.kind === "inProgress";
}

// #region receivers

/**
 * Keep the receiver of one installation in step with its installed version. Call it in every
 * transaction that installs, upgrades, or re-enables an installation.
 */
export async function plugins_service_events_db_sync_receiver(
	ctx: MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		pluginName: string;
		serviceAccountId: Id<"access_control_service_accounts">;
		serviceEventsUrl: string | undefined;
	},
) {
	const receiver = await ctx.db
		.query("plugins_service_event_receivers")
		.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
		.first();

	// A version without the event gets no notices, so its old receiver goes away.
	if (args.serviceEventsUrl === undefined) {
		if (receiver) await db_delete_receiver(ctx, receiver);
		return;
	}

	if (receiver) {
		await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
			serviceAccountId: args.serviceAccountId,
			url: args.serviceEventsUrl,
		});
		// An upgrade or an enable is a fresh start: a new URL or a fixed server may answer now. So clear a
		// pause and try at once, not after the next lease or pull.
		await db_wake_receiver(ctx, receiver);
		return;
	}

	// Start at the head: the service reads older changes from its first snapshot, not from notices.
	const state = await ctx.db
		.query("access_control_change_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	const revision = state?.revision ?? 0;
	await ctx.db.insert("plugins_service_event_receivers", {
		installationId: args.installationId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		pluginName: args.pluginName,
		serviceAccountId: args.serviceAccountId,
		url: args.serviceEventsUrl,
		pendingRevision: revision,
		deliveredRevision: revision,
		finalRevision: null,
		attempt: 0,
		claim: null,
		wakeJobId: null,
		lastStatus: null,
		failingSince: null,
		pausedAt: null,
	});
}

/**
 * Follow a new service account, so feed docs of that account find this receiver.
 */
export async function plugins_service_events_db_set_receiver_account(
	ctx: MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		serviceAccountId: Id<"access_control_service_accounts">;
	},
) {
	const receiver = await ctx.db
		.query("plugins_service_event_receivers")
		.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
		.first();
	if (receiver)
		await ctx.db.patch("plugins_service_event_receivers", receiver._id, { serviceAccountId: args.serviceAccountId });
}

/**
 * Delete the receiver of one installation. The registry hard delete uses it, because that path writes
 * no `revoked` feed doc that would end the receiver.
 */
export async function plugins_service_events_db_delete_installation_receiver(
	ctx: MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
) {
	const receiver = await ctx.db
		.query("plugins_service_event_receivers")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
	if (receiver) await db_delete_receiver(ctx, receiver);
}

/**
 * Delete up to `limit` receivers of a plugin name. Returns how many it deleted.
 */
export async function plugins_service_events_db_delete_plugin_receivers(
	ctx: MutationCtx,
	args: { pluginName: string; limit: number },
) {
	const receivers = await ctx.db
		.query("plugins_service_event_receivers")
		.withIndex("by_pluginName", (q) => q.eq("pluginName", args.pluginName))
		.take(args.limit);
	for (const receiver of receivers) await db_delete_receiver(ctx, receiver);
	return receivers.length;
}

async function db_delete_receiver(ctx: MutationCtx, receiver: Doc<"plugins_service_event_receivers">) {
	if (receiver.wakeJobId && (await db_job_is_live(ctx, receiver.wakeJobId)))
		await ctx.scheduler.cancel(receiver.wakeJobId);
	await ctx.db.delete("plugins_service_event_receivers", receiver._id);
}

/**
 * A service call from the installation shows its server is back. Clear the failure state and send the
 * waiting notice now. A call while nothing failed writes nothing.
 */
async function db_wake_receiver(ctx: MutationCtx, receiver: Doc<"plugins_service_event_receivers">) {
	// A delivery in flight plans its own next try when it records its answer. The plugin server may pull
	// inside that delivery, so a reset here would restart the delays and the 3-day pause on every try.
	if (receiver.claim !== null) return;
	if (receiver.failingSince === null && receiver.pausedAt === null) return;

	await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
		failingSince: null,
		pausedAt: null,
		attempt: 0,
	});
	if (receiver.pendingRevision <= receiver.deliveredRevision) return;

	if (receiver.wakeJobId && (await db_job_is_live(ctx, receiver.wakeJobId)))
		await ctx.scheduler.cancel(receiver.wakeJobId);
	const wakeJobId = await ctx.scheduler.runAfter(0, internal.plugins_service_events.start_delivery, {
		receiverId: receiver._id,
	});
	await ctx.db.patch("plugins_service_event_receivers", receiver._id, { wakeJobId });
}

/**
 * Wake the receiver of an installation whose service just called the lease or pull route.
 */
export async function plugins_service_events_db_wake_installation(
	ctx: MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
) {
	const receiver = await ctx.db
		.query("plugins_service_event_receivers")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
	if (receiver) await db_wake_receiver(ctx, receiver);
}

// #endregion receivers

// #region dispatch

/**
 * Schedule a delivery now, unless one runs, one waits for its retry time, or the receiver is paused.
 */
async function db_schedule_delivery(ctx: MutationCtx, receiver: Doc<"plugins_service_event_receivers">) {
	if (receiver.claim !== null || receiver.pausedAt !== null) return;
	if (await db_job_is_live(ctx, receiver.wakeJobId)) return;

	const wakeJobId = await ctx.scheduler.runAfter(0, internal.plugins_service_events.start_delivery, {
		receiverId: receiver._id,
	});
	await ctx.db.patch("plugins_service_event_receivers", receiver._id, { wakeJobId });
}

/**
 * The receivers a feed doc of this scope reaches, in creation order after the cursor.
 */
async function db_list_scope_receivers(
	ctx: MutationCtx,
	args: { scope: Doc<"access_control_changes">["scope"]; afterCreationTime: number | null; limit: number },
) {
	const { scope, afterCreationTime, limit } = args;
	const table = ctx.db.query("plugins_service_event_receivers");
	switch (scope.kind) {
		case "installation":
			return await table
				.withIndex("by_installation", (q) => {
					const range = q.eq("installationId", scope.installationId);
					return afterCreationTime === null ? range : range.gt("_creationTime", afterCreationTime);
				})
				.take(limit);
		case "workspace":
			return await table
				.withIndex("by_organization_workspace", (q) => {
					const range = q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId);
					return afterCreationTime === null ? range : range.gt("_creationTime", afterCreationTime);
				})
				.take(limit);
		case "organization":
			return await table
				.withIndex("by_organization", (q) => {
					const range = q.eq("organizationId", scope.organizationId);
					return afterCreationTime === null ? range : range.gt("_creationTime", afterCreationTime);
				})
				.take(limit);
		case "plugin":
			return await table
				.withIndex("by_pluginName", (q) => {
					const range = q.eq("pluginName", scope.pluginName);
					return afterCreationTime === null ? range : range.gt("_creationTime", afterCreationTime);
				})
				.take(limit);
		case "service_account":
			return await table
				.withIndex("by_serviceAccount", (q) => {
					const range = q.eq("serviceAccountId", scope.serviceAccountId);
					return afterCreationTime === null ? range : range.gt("_creationTime", afterCreationTime);
				})
				.take(limit);
	}
}

/**
 * Raise the pending revision of every receiver each feed doc reaches, in feed order.
 *
 * It reads every feed doc once and only the receivers each doc reaches, so it is not a scan. One run
 * handles at most 50 feed docs and 100 receivers. A feed doc that reaches more receivers continues in
 * the next run from the receiver cursor.
 */
export const dispatch = internalMutation({
	args: {
		afterRevision: v.number(),
		receiverCursor: v.union(v.object({ revision: v.number(), afterCreationTime: v.number() }), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const dispatcher = await ctx.db
			.query("plugins_service_event_dispatcher")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		// The feed writer creates this doc before it schedules the first run.
		if (!dispatcher) return null;

		const changes = await ctx.db
			.query("access_control_changes")
			.withIndex("by_revision", (q) => q.gt("revision", args.afterRevision))
			.take(DISPATCH_FEED_BATCH_SIZE);

		let remaining = DISPATCH_RECEIVER_BATCH_SIZE;
		let dispatchedRevision = args.afterRevision;
		let receiverCursor: typeof args.receiverCursor = null;
		for (const change of changes) {
			// The `revoked` doc is the last notice of an installation.
			const final = change.event.kind === "revoked";

			const receivers = await db_list_scope_receivers(ctx, {
				scope: change.scope,
				afterCreationTime:
					args.receiverCursor?.revision === change.revision ? args.receiverCursor.afterCreationTime : null,
				limit: remaining,
			});
			for (const receiver of receivers) {
				// Nothing after the last notice, and nothing older than the receiver itself.
				if (receiver.finalRevision !== null || change.revision <= receiver.pendingRevision) continue;

				// A disabled installation gets only its own installation docs (the disable and the enable) and its
				// final notice. After the enable, its next pull reads every change it missed.
				if (
					!final &&
					change.scope.kind !== "installation" &&
					(await ctx.db.get("plugins_workspace_installations", receiver.installationId))?.status === "disabled"
				)
					continue;

				// A paused receiver waits for a lease or pull of its installation. A removed installation makes
				// neither, so end the receiver now.
				if (final && receiver.pausedAt !== null) {
					await db_delete_receiver(ctx, receiver);
					continue;
				}

				const raised = {
					...receiver,
					pendingRevision: change.revision,
					finalRevision: final ? change.revision : null,
				};
				await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
					pendingRevision: raised.pendingRevision,
					finalRevision: raised.finalRevision,
				});
				await db_schedule_delivery(ctx, raised);
			}

			remaining -= receivers.length;
			// A full page may have more receivers. Continue this feed doc after the last one in the next run.
			if (remaining === 0) {
				receiverCursor = { revision: change.revision, afterCreationTime: receivers.at(-1)!._creationTime };
				break;
			}
			dispatchedRevision = change.revision;
		}

		// Read the head here, so a writer that commits during this run conflicts with it and the run
		// sees its docs. A lost wake-up is then impossible.
		const state = await ctx.db
			.query("access_control_change_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		const head = state?.revision ?? 0;
		// A short page read every feed doc up to the head in this transaction. Revisions with no doc are gaps,
		// so the run is done. Without this, a head with no doc of its own would reschedule the run forever.
		if (receiverCursor === null && changes.length < DISPATCH_FEED_BATCH_SIZE)
			dispatchedRevision = Math.max(dispatchedRevision, head);
		if (receiverCursor === null && dispatchedRevision >= head) {
			await ctx.db.patch("plugins_service_event_dispatcher", dispatcher._id, { jobId: null, dispatchedRevision });
			return null;
		}

		const jobId = await ctx.scheduler.runAfter(0, internal.plugins_service_events.dispatch, {
			afterRevision: dispatchedRevision,
			receiverCursor,
		});
		await ctx.db.patch("plugins_service_event_dispatcher", dispatcher._id, { jobId, dispatchedRevision });
		return null;
	},
});

// #endregion dispatch

// #region notice signing key

/**
 * The AES-GCM additional data of one registration's key. A key copied to another registration does not open.
 */
function signing_key_additional_data(registrationId: Id<"plugins_service_registrations">) {
	return `plugins-service-events-key:${registrationId}`;
}

/**
 * Return the registration's encrypted signing key. Create it the first time a notice or the key route
 * needs it.
 */
async function db_ensure_signing_key(ctx: MutationCtx, registration: Doc<"plugins_service_registrations">) {
	if (registration.eventsSigningKey) return registration.eventsSigningKey;

	// Standard Webhooks key format: `whsec_` and the base64 of 32 random bytes.
	const bytes = crypto.getRandomValues(new Uint8Array(SIGNING_KEY_BYTES));
	const key = `whsec_${btoa(String.fromCharCode(...bytes))}`;
	const encrypted = await crypto_encrypt_secret_value({
		value: key,
		additionalData: signing_key_additional_data(registration._id),
		keyName: "PLUGIN_SECRETS_ENCRYPTION_KEY",
	});
	const eventsSigningKey = { ...encrypted, createdAt: Date.now() };
	await ctx.db.patch("plugins_service_registrations", registration._id, { eventsSigningKey });
	return eventsSigningKey;
}

/**
 * The key route: give a plugin service its notice signing key. The service proves itself with its
 * `pse_` service secret, like on the other service routes.
 *
 * It wakes no paused receiver. A caller with only the service secret could then undo every pause of
 * the plugin. A lease or pull of the installation wakes its receiver instead.
 */
export const get_signing_key = internalMutation({
	args: { pluginName: v.string(), serviceSecretHash: v.string() },
	returns: v_result({ _yay: v.object({ key: v.string(), createdAt: v.number() }) }),
	handler: async (ctx, args) => {
		const registration = await ctx.db
			.query("plugins_service_registrations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", args.pluginName))
			.first();
		if (!registration || !crypto_timing_safe_equal(registration.exchangeSecretHash, args.serviceSecretHash))
			return Result({ _nay: { message: "Unauthorized" } });

		const limited = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `plugin-events-key:${registration._id}`,
		});
		if (limited) return Result({ _nay: { message: limited.message } });

		const encrypted = await db_ensure_signing_key(ctx, registration);
		const key = await crypto_decrypt_secret_value({
			secret: encrypted,
			additionalData: signing_key_additional_data(registration._id),
			keyName: "PLUGIN_SECRETS_ENCRYPTION_KEY",
		});
		return Result({ _yay: { key, createdAt: encrypted.createdAt } });
	},
});

export type plugins_service_events_get_signing_key_Result =
	typeof get_signing_key extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion notice signing key

// #region delivery

function retry_delay_ms(attempt: number) {
	return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
}

/**
 * Claim one receiver and send its newest pending revision.
 *
 * A scheduled action runs at most once, and nothing tells us when it dies. So this mutation first arms
 * a watchdog: itself again, after the request timeout plus the retry delay (at least 30 s). If the
 * action never records an answer, the watchdog counts that as one failure and tries again. The claim
 * token stops a late answer of the dead try from changing the receiver.
 */
export const start_delivery = internalMutation({
	args: { receiverId: v.id("plugins_service_event_receivers") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const receiver = await ctx.db.get("plugins_service_event_receivers", args.receiverId);
		if (!receiver) return null;

		const now = Date.now();
		let attempt = receiver.attempt;
		let failingSince = receiver.failingSince;
		// The earlier try never recorded an answer.
		if (receiver.claim !== null) {
			attempt += 1;
			failingSince ??= now;
		}

		const delivered = receiver.deliveredRevision >= receiver.pendingRevision;
		const expired = failingSince !== null && failingSince <= now - PAUSE_AFTER_MS;
		if (delivered || expired) {
			// A receiver with a last notice ends with that notice, or after 3 days of failure.
			if (receiver.finalRevision !== null) {
				await ctx.db.delete("plugins_service_event_receivers", receiver._id);
				return null;
			}
			await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
				attempt,
				failingSince,
				claim: null,
				wakeJobId: null,
				pausedAt: delivered ? null : now,
			});
			return null;
		}

		const registration = await ctx.db
			.query("plugins_service_registrations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", receiver.pluginName))
			.first();
		// No registration means no key to sign with. Count it as a failure, so the receiver pauses later.
		if (!registration) {
			const wakeJobId = await ctx.scheduler.runAfter(
				retry_delay_ms(attempt),
				internal.plugins_service_events.start_delivery,
				args,
			);
			await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
				attempt: attempt + 1,
				failingSince: failingSince ?? now,
				lastStatus: 0,
				claim: null,
				wakeJobId,
			});
			return null;
		}

		const encrypted = await db_ensure_signing_key(ctx, registration);
		const claim = crypto_random_hex(16);
		const wakeJobId = await ctx.scheduler.runAfter(
			REQUEST_TIMEOUT_MS + Math.max(retry_delay_ms(attempt), WATCHDOG_MARGIN_MS),
			internal.plugins_service_events.start_delivery,
			args,
		);
		await ctx.db.patch("plugins_service_event_receivers", receiver._id, { attempt, failingSince, claim, wakeJobId });
		await ctx.scheduler.runAfter(0, internal.plugins_service_events.deliver, {
			receiverId: receiver._id,
			claim,
			url: receiver.url,
			installationId: receiver.installationId,
			revision: receiver.pendingRevision,
			registrationId: registration._id,
			key: { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce },
		});
		return null;
	},
});

/**
 * POST one signed notice and record the answer. Standard Webhooks v1: the signature is the base64
 * HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the base64-decoded part of the
 * `whsec_` key.
 */
export const deliver = internalAction({
	args: {
		receiverId: v.id("plugins_service_event_receivers"),
		claim: v.string(),
		url: v.string(),
		installationId: v.id("plugins_workspace_installations"),
		revision: v.number(),
		registrationId: v.id("plugins_service_registrations"),
		key: v.object({ ciphertext: v.bytes(), nonce: v.bytes() }),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const key = await crypto_decrypt_secret_value({
			secret: args.key,
			additionalData: signing_key_additional_data(args.registrationId),
			keyName: "PLUGIN_SECRETS_ENCRYPTION_KEY",
		});
		const webhookId = `${args.installationId}:${args.revision}`;
		const timestamp = Math.floor(Date.now() / 1000);
		const body = JSON.stringify({
			type: "workspace.access.changed",
			timestamp: new Date(timestamp * 1000).toISOString(),
			data: { installationId: args.installationId, revision: args.revision },
		});
		const hmacKey = await crypto.subtle.importKey(
			"raw",
			Uint8Array.from(atob(key.slice("whsec_".length)), (char) => char.charCodeAt(0)),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = new Uint8Array(
			await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`)),
		);

		// 0 means no answer: a network error, a timeout, or a reply cut off by the timeout.
		let status = 0;
		let retryAfterSeconds: number | null = null;
		try {
			// Check the URL again with the app's fetch guard. It also refuses Bonobo Senate's own hosts, which
			// the manifest check at publish time does not know. A refused URL counts as no answer.
			if (!mcp_guarded_fetch_is_allowed_url(args.url)) throw new Error("Blocked URL");

			const response = await fetch(args.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"webhook-id": webhookId,
					"webhook-timestamp": String(timestamp),
					"webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
				},
				body,
				// A redirect would send the notice to a URL nobody consented to. It counts as a failure.
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const retryAfter = Number(response.headers.get("Retry-After") ?? Number.NaN);
			retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : null;

			// Read a little of the reply so the connection can close, then drop it.
			const reader = response.body?.getReader();
			let readBytes = 0;
			while (reader && readBytes < MAX_REPLY_BYTES) {
				const chunk = await reader.read();
				if (chunk.done) break;
				readBytes += chunk.value.byteLength;
			}
			await reader?.cancel();
			status = response.status;
		} catch {
			// The status stays 0. `record_delivery` plans the retry.
		}

		await ctx.runMutation(internal.plugins_service_events.record_delivery, {
			receiverId: args.receiverId,
			claim: args.claim,
			revision: args.revision,
			status,
			retryAfterSeconds,
		});
		return null;
	},
});

/**
 * Save the answer of one try and plan the next one.
 *
 * - 2xx: the service applied everything up to the revision.
 * - 503 with `Retry-After`: the service is still catching up. Wait as it asks (5 s to 1 h) and do not
 *   grow the delay, because it made progress. The time still counts toward the 3-day pause.
 * - Anything else, including 401 and a redirect: a failure. Wait the next retry delay.
 */
export const record_delivery = internalMutation({
	args: {
		receiverId: v.id("plugins_service_event_receivers"),
		claim: v.string(),
		revision: v.number(),
		status: v.number(),
		retryAfterSeconds: v.union(v.number(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const receiver = await ctx.db.get("plugins_service_event_receivers", args.receiverId);
		// The watchdog already gave up on this try and started another one.
		if (!receiver || receiver.claim !== args.claim) return null;

		if (receiver.wakeJobId && (await db_job_is_live(ctx, receiver.wakeJobId)))
			await ctx.scheduler.cancel(receiver.wakeJobId);

		if (args.status >= 200 && args.status < 300) {
			const deliveredRevision = Math.max(receiver.deliveredRevision, args.revision);
			if (receiver.finalRevision !== null && deliveredRevision >= receiver.finalRevision) {
				await ctx.db.delete("plugins_service_event_receivers", receiver._id);
				return null;
			}
			// Changes that came during the request get the next notice at once.
			const wakeJobId =
				receiver.pendingRevision > deliveredRevision
					? await ctx.scheduler.runAfter(0, internal.plugins_service_events.start_delivery, {
							receiverId: receiver._id,
						})
					: null;
			await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
				deliveredRevision,
				attempt: 0,
				failingSince: null,
				lastStatus: args.status,
				claim: null,
				wakeJobId,
			});
			return null;
		}

		const catchingUp = args.status === 503 && args.retryAfterSeconds !== null;
		const delayMs = catchingUp
			? Math.min(Math.max(args.retryAfterSeconds! * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
			: retry_delay_ms(receiver.attempt);
		const wakeJobId = await ctx.scheduler.runAfter(delayMs, internal.plugins_service_events.start_delivery, {
			receiverId: receiver._id,
		});
		await ctx.db.patch("plugins_service_event_receivers", receiver._id, {
			attempt: catchingUp ? 0 : receiver.attempt + 1,
			failingSince: receiver.failingSince ?? Date.now(),
			lastStatus: args.status,
			claim: null,
			wakeJobId,
		});
		return null;
	},
});

// #endregion delivery
