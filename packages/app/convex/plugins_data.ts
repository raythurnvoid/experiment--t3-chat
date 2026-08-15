import { v, type Infer } from "convex/values";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type RegisteredMutation,
	type RegisteredQuery,
} from "convex/server";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_has_permission } from "./access_control.ts";
import { public_api_service_uploads_db_drain_batch } from "./public_api_service_uploads.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// #region limits

/**
 * One document's value, as UTF-8 bytes of its canonical JSON. Same size as a plugin secret value,
 * which keeps every stored document far below the 1 MiB Convex document limit.
 */
const MAX_VALUE_BYTES = 16 * 1024;
/** Collection names and keys. Same length a plugin secret name may have. */
const MAX_NAME_LENGTH = 128;
const MAX_COLLECTIONS = 16;
/** Stored value bytes plus bytes promised to live reservations, per installation. */
const MAX_INSTALLATION_BYTES = 16 * 1024 * 1024;
/**
 * Values, live reservations, and revision tombstones share one ceiling. The byte ceiling alone does
 * not stop a plugin from writing ten million empty documents, and each of those still costs database
 * and index space.
 */
const MAX_DOCUMENT_SLOTS = 10_000;
const MAX_BATCH_DOCUMENTS = 50;
const MAX_LIST_PAGE_SIZE = 100;
/**
 * The longest a reservation may hold capacity.
 *
 * Council's projection reservation runs to the meeting's eight-day recovery horizon: the provider
 * keeps a recording URL for seven days, plus one day. A shorter ceiling here would refuse the one
 * reservation this store was built for.
 */
const MAX_RESERVATION_TTL_MS = 8 * 24 * 60 * 60 * 1000;
/**
 * How long a released reservation and a revision tombstone stay after their work is done.
 *
 * A producer that never saw its HTTP response retries the same request. Within this window the retry
 * gets the same answer as the first call instead of reserving twice or resurrecting a deleted key.
 * The record costs one document slot until it is swept.
 */
const RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Names for the two refusals whose HTTP status is not the default 400.
 *
 * `plugins_data_http.ts` reads the name to pick the status. Before these names existed, that route
 * matched the English text of the refusal, so rewording one message silently turned a 409 into a 400.
 * Everything not named here is bad input from the caller and answers 400.
 *
 * The route declares its own two constants with this same type instead of importing the values. That
 * module is loaded on demand, and importing a value from here would pull this whole module into its
 * startup. A type import costs nothing at run time and still fails the build on both sides if a name
 * here changes.
 */
export type plugins_data_RefusalName = "conflict" | "storage_full";

const REFUSAL_CONFLICT: plugins_data_RefusalName = "conflict";
const REFUSAL_STORAGE_FULL: plugins_data_RefusalName = "storage_full";

// #endregion limits

// #region validation

/**
 * Encode a value the same way every time, so its byte size and its payload hash do not depend on the
 * order Convex happens to return object fields in. Object keys are sorted at every depth; arrays keep
 * their order because their order is data.
 */
function canonical_json(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonical_json(item)).join(",")}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical_json(item)}`).join(",")}}`;
}

/**
 * Collection names and keys are echoed back to plugin pages and to the workspace UI, so control and
 * format characters are refused for the same reason secret descriptions refuse them: they can hide or
 * visually reorder text. Surrounding whitespace is refused because two keys that look identical must
 * not be two different docs.
 */
function validate_name(raw: string, label: "Collection names" | "Keys" | "Idempotency keys") {
	if (raw.length === 0) {
		return Result({ _nay: { message: `${label} must not be empty` } });
	}
	if (raw.length > MAX_NAME_LENGTH) {
		return Result({ _nay: { message: `${label} must be at most ${MAX_NAME_LENGTH} characters` } });
	}
	if (raw !== raw.trim()) {
		return Result({ _nay: { message: `${label} must not start or end with whitespace` } });
	}
	if (/[\p{Cc}\p{Cf}]/u.test(raw)) {
		return Result({ _nay: { message: `${label} must not contain control characters` } });
	}

	return Result({ _yay: raw });
}

function validate_value(value: Record<string, unknown>) {
	const byteSize = files_get_utf8_byte_size(canonical_json(value));
	if (byteSize > MAX_VALUE_BYTES) {
		return Result({ _nay: { message: `Plugin document values must be at most ${MAX_VALUE_BYTES / 1024} KiB` } });
	}

	return Result({ _yay: byteSize });
}

// #endregion validation

// #region access

/**
 * Who a plugin-data call acts as. The HTTP route resolves the bearer token into this shape; the
 * mutation below still re-checks everything it can, because the route only proves who called, not
 * that they may still act.
 */
const store_principal_validator = v.object({
	kind: v.union(
		v.literal("user_api_key"),
		v.literal("plugin_run"),
		v.literal("plugin_ui"),
		v.literal("plugin_service"),
	),
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	/**
	 * Derived from the principal for plugin kinds. A user API key has no installation of its own, so
	 * its request names one and this module proves the named installation is inside the key's tenant.
	 *
	 * It stays a plain string because that request body is outside the application. A `v.id` validator
	 * throws on a malformed value, which an HTTP caller would see as a server error instead of a
	 * refusal, so `db_authorize` normalizes it and answers "Not found" like any other unknown id.
	 */
	installationId: v.string(),
	/** The person the call acts for. Reads and writes are judged with their permissions. */
	actorUserId: v.id("users"),
	/** Stable producer identity. Versioned keys and reservations belong to it. */
	principalKey: v.string(),
});

type StorePrincipal = Infer<typeof store_principal_validator>;

const CAPABILITY_BY_PERMISSION = {
	"content.read": "plugin.data.read",
	"content.write": "plugin.data.write",
} as const satisfies Record<"content.read" | "content.write", plugins_Capability>;

/**
 * Prove the call may still touch this installation's documents, inside the same transaction as the
 * read or write. The token check at the HTTP boundary happened earlier and cannot see a role that was
 * taken away since, and a `plugin_run` skips the app-permission check there on purpose.
 */
async function db_authorize(
	ctx: QueryCtx,
	args: {
		principal: StorePrincipal;
		permission: "content.read" | "content.write";
	},
) {
	const installationId = ctx.db.normalizeId("plugins_workspace_installations", args.principal.installationId);
	const installation = installationId ? await ctx.db.get("plugins_workspace_installations", installationId) : null;
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.organizationId !== args.principal.organizationId ||
		installation.workspaceId !== args.principal.workspaceId
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	// The workspace consented to this plugin storing data. Without that consent there is nothing to
	// read, and a write would store documents the plugin itself may never read back.
	if (!installation.acceptedCapabilities.includes(CAPABILITY_BY_PERMISSION[args.permission])) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.principal.actorUserId)
				.eq("organizationId", args.principal.organizationId)
				.eq("workspaceId", args.principal.workspaceId),
		)
		.first();
	if (!membership) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", args.principal.organizationId),
		ctx.db.get("organizations_workspaces", args.principal.workspaceId),
	]);
	if (!organization?.defaultWorkspaceId || !workspace || workspace.organizationId !== organization._id) {
		return Result({ _nay: { message: "Not found" } });
	}

	const allowed = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "workspace", id: String(workspace._id) },
		permission: args.permission,
		userId: args.principal.actorUserId,
	});
	if (!allowed) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: { installation } });
}

/**
 * Keep a plugin page out of every write.
 *
 * A page session can belong to an anonymous identity. A page is also the first thing a scripting bug
 * in a plugin reaches. A write door there would turn one such bug into stored data that plugin
 * backends later act on with their own secrets.
 *
 * Two other things already refuse a page write. The routes leave `plugin_ui` out of every write
 * allowlist, and a page token never carries the write scope. This guard is the third, and it is the
 * only one inside the transaction. It still refuses a caller that reaches the mutation directly, and
 * it still refuses one wrong edit to an `allowedKinds` list. `require_service_principal` gives the
 * ordered mutations the same kind of protection.
 */
function refuse_page_principal(principal: StorePrincipal) {
	if (principal.kind === "plugin_ui") {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: null });
}

// #endregion access

// #region usage accounting

/**
 * One accounting document per installation. It is created by the installation's first accepted
 * write, so a refused write leaves no trace at all.
 *
 * Every write updates it in the same transaction as the document it changes, so the ceilings are
 * answered without counting docs. That makes it a hot document: two writes for the same installation
 * at the same time can lose an optimistic-concurrency race, and Convex retries the loser.
 */
async function db_get_usage(ctx: QueryCtx, installationId: Id<"plugins_workspace_installations">) {
	return await ctx.db
		.query("plugins_data_usage")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
}

async function db_create_usage(
	ctx: MutationCtx,
	args: { installation: Doc<"plugins_workspace_installations">; now: number },
) {
	const usageId = await ctx.db.insert("plugins_data_usage", {
		organizationId: args.installation.organizationId,
		workspaceId: args.installation.workspaceId,
		installationId: args.installation._id,
		pluginName: args.installation.pluginName,
		usedBytes: 0,
		reservedBytes: 0,
		usedDocuments: 0,
		reservedDocuments: 0,
		tombstoneDocuments: 0,
		collectionNames: [],
		updatedAt: args.now,
	});
	const created = await ctx.db.get("plugins_data_usage", usageId);
	if (!created) {
		const errorMessage = "Plugin data usage doc missing right after insert";
		const errorData = { usageId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return created;
}

/**
 * Check the ceilings for one pending change before anything is written. An installation with no
 * usage document yet has stored nothing, so every counter reads as zero.
 */
function check_capacity(
	usage: Doc<"plugins_data_usage"> | null,
	change: { addedBytes: number; addedSlots: number; addedCollections: number },
) {
	const usedBytes = usage ? usage.usedBytes + usage.reservedBytes : 0;
	const usedSlots = usage ? usage.usedDocuments + usage.reservedDocuments + usage.tombstoneDocuments : 0;
	const usedCollections = usage ? usage.collectionNames.length : 0;

	if (usedBytes + change.addedBytes > MAX_INSTALLATION_BYTES) {
		return Result({
			_nay: {
				name: REFUSAL_STORAGE_FULL,
				message: `This plugin has used its ${MAX_INSTALLATION_BYTES / (1024 * 1024)} MiB of storage`,
			},
		});
	}
	if (usedSlots + change.addedSlots > MAX_DOCUMENT_SLOTS) {
		return Result({
			_nay: { name: REFUSAL_STORAGE_FULL, message: `This plugin has used its ${MAX_DOCUMENT_SLOTS} document slots` },
		});
	}
	if (usedCollections + change.addedCollections > MAX_COLLECTIONS) {
		return Result({
			_nay: { name: REFUSAL_STORAGE_FULL, message: `This plugin can use at most ${MAX_COLLECTIONS} collections` },
		});
	}

	return Result({ _yay: null });
}

/**
 * Delete the collection name once the collection holds neither a document nor a live reservation.
 *
 * A reservation counts because reserving is a promise that the later write will be accepted, and the
 * 16-collection rule is one of the things that could otherwise refuse it.
 */
async function db_drop_collection_if_empty(
	ctx: MutationCtx,
	args: { usage: Doc<"plugins_data_usage">; collection: string },
) {
	const document = await ctx.db
		.query("plugins_data")
		.withIndex("by_installation_collection_key", (q) =>
			q.eq("installationId", args.usage.installationId).eq("collection", args.collection),
		)
		.first();
	if (document) {
		return args.usage.collectionNames;
	}

	const liveReservation = await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_installation_state_collection_key", (q) =>
			q.eq("installationId", args.usage.installationId).eq("state", "live").eq("collection", args.collection),
		)
		.first();
	if (liveReservation) {
		return args.usage.collectionNames;
	}

	return args.usage.collectionNames.filter((name) => name !== args.collection);
}

// #endregion usage accounting

// #region reservations

/**
 * The one reservation currently holding capacity for this exact document, if any.
 *
 * The index asks for `live` docs directly. Released records stay behind as replay answers until their
 * retry horizon, and one key can collect many of them, so a query that read the key's docs and then
 * filtered would have to read past all of them to find the live one.
 */
async function db_get_live_reservation(
	ctx: QueryCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; key: string },
) {
	return await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_installation_state_collection_key", (q) =>
			q
				.eq("installationId", args.installationId)
				.eq("state", "live")
				.eq("collection", args.collection)
				.eq("key", args.key),
		)
		.first();
}

/**
 * Find a released retry that still owns a usage tombstone slot for this exact producer and key.
 * Delete-versioned converts that slot into its revision tombstone instead of charging twice.
 */
async function db_get_released_reservation_holding_slot(
	ctx: QueryCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		collection: string;
		key: string;
		ownerPrincipalKey: string;
	},
) {
	return await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_installation_state_collection_key_owner_holds_slot", (q) =>
			q
				.eq("installationId", args.installationId)
				.eq("state", "released")
				.eq("collection", args.collection)
				.eq("key", args.key)
				.eq("ownerPrincipalKey", args.ownerPrincipalKey)
				.eq("holdsUsageTombstoneSlot", true),
		)
		.first();
}

async function db_get_tombstone(
	ctx: QueryCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; key: string },
) {
	return await ctx.db
		.query("plugins_data_revision_tombstones")
		.withIndex("by_installation_collection_key", (q) =>
			q.eq("installationId", args.installationId).eq("collection", args.collection).eq("key", args.key),
		)
		.first();
}

/**
 * Only a service reserves or writes with revisions. Those calls come from one external producer that
 * keeps its own order, and the routes already restrict the kind. Checking it again here means a new
 * caller cannot reach the ordered path by calling the mutation directly.
 */
function require_service_principal(principal: StorePrincipal) {
	if (principal.kind !== "plugin_service") {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: null });
}

export const reserve_document = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
		maximumBytes: v.number(),
		idempotencyKey: v.string(),
		expiresAt: v.number(),
	},
	returns: v_result({
		_yay: v.object({ reservationId: v.string(), remainingBytes: v.number(), expiresAt: v.number() }),
	}),
	handler: async (ctx, args) => {
		const service = require_service_principal(args.principal);
		if (service._nay) {
			return service;
		}
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}
		const idempotencyKey = validate_name(args.idempotencyKey, "Idempotency keys");
		if (idempotencyKey._nay) {
			return idempotencyKey;
		}
		if (!Number.isInteger(args.maximumBytes) || args.maximumBytes < 1 || args.maximumBytes > MAX_VALUE_BYTES) {
			return Result({ _nay: { message: `A reservation holds 1 to ${MAX_VALUE_BYTES} bytes` } });
		}

		const now = Date.now();
		if (args.expiresAt <= now || args.expiresAt > now + MAX_RESERVATION_TTL_MS) {
			return Result({
				_nay: { message: `A reservation expires within ${MAX_RESERVATION_TTL_MS / (24 * 60 * 60 * 1000)} days` },
			});
		}

		// The same request replayed after a lost response must answer the same thing, and a different
		// request under the same key must be refused rather than quietly reserving a second time.
		const requestFingerprint = canonical_json({
			collection: collection._yay,
			key: key._yay,
			maximumBytes: args.maximumBytes,
			expiresAt: args.expiresAt,
		});
		const replay = await ctx.db
			.query("plugins_data_reservations")
			.withIndex("by_installation_principal_idempotencyKey", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("ownerPrincipalKey", args.principal.principalKey)
					.eq("idempotencyKey", idempotencyKey._yay),
			)
			.first();
		if (replay) {
			if (replay.requestFingerprint !== requestFingerprint) {
				return Result({
					_nay: {
						name: REFUSAL_CONFLICT,
						message: "This idempotency key was already used for a different reservation",
					},
				});
			}
			// A released reservation holds nothing. Answering the replay from the row would hand the
			// producer zero remaining bytes, and it would learn that only after doing the outside work this
			// reservation was meant to protect. So refuse and say the reservation is over. The way forward
			// is a fresh idempotency key, because the released row no longer fences the key.
			if (replay.state === "released") {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This reservation was already released" },
				});
			}

			// Answer from the live row, not from a stored first answer. The row keeps no reserve result on
			// purpose. An ordered write spends part of a live reservation, so a repeated first answer would
			// promise bytes the producer already wrote.
			return Result({
				_yay: {
					reservationId: String(replay._id),
					remainingBytes: replay.remainingBytes,
					expiresAt: replay.expiresAt,
				},
			});
		}

		const live = await db_get_live_reservation(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (live) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document already has a live reservation" } });
		}

		// Reserving binds the key to this producer for good, so it may not take over a key the plugin
		// already writes interactively, or a key another producer owns.
		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (
			existing &&
			(existing.writeMode !== "versioned" || existing.producerPrincipalKey !== args.principal.principalKey)
		) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		const tombstone = await db_get_tombstone(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (tombstone && tombstone.producerPrincipalKey !== args.principal.principalKey) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		if (tombstone) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document was deleted by its service" } });
		}

		const usage = await db_get_usage(ctx, installation._id);
		const addsCollection = !(usage?.collectionNames ?? []).includes(collection._yay);
		const capacity = check_capacity(usage, {
			addedBytes: args.maximumBytes,
			addedSlots: 1,
			addedCollections: addsCollection ? 1 : 0,
		});
		if (capacity._nay) {
			return capacity;
		}

		const reservationId = await ctx.db.insert("plugins_data_reservations", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: installation._id,
			pluginName: installation.pluginName,
			collection: collection._yay,
			key: key._yay,
			ownerPrincipalKey: args.principal.principalKey,
			maximumBytes: args.maximumBytes,
			remainingBytes: args.maximumBytes,
			state: "live",
			holdsUsageTombstoneSlot: false,
			idempotencyKey: idempotencyKey._yay,
			requestFingerprint,
			expiresAt: args.expiresAt,
			retryHorizonExpiresAt: args.expiresAt + RETRY_HORIZON_MS,
			updatedAt: now,
		});

		const storedUsage = usage ?? (await db_create_usage(ctx, { installation, now }));
		await ctx.db.patch("plugins_data_usage", storedUsage._id, {
			reservedBytes: storedUsage.reservedBytes + args.maximumBytes,
			reservedDocuments: storedUsage.reservedDocuments + 1,
			collectionNames: addsCollection ? [...storedUsage.collectionNames, collection._yay] : storedUsage.collectionNames,
			updatedAt: now,
		});

		return Result({
			_yay: { reservationId: String(reservationId), remainingBytes: args.maximumBytes, expiresAt: args.expiresAt },
		});
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_reserve_document_Result =
	typeof reserve_document extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Give back what a reservation still holds and keep the doc as the answer to a replayed release.
 *
 * Bytes already spent on a stored value stay spent, and the value is never touched. Called by the
 * release route, by the terminal versioned delete, and by the expiry cron.
 *
 * The collection name is dropped here rather than by each caller. A live reservation is one of the
 * two things that keep a collection name alive, so every release has to check the name again. The
 * expiry cron used to be the one caller that skipped that check. A producer that reserved in a new
 * collection and then crashed left the name in place with nothing behind it. A collection name is
 * one slot out of sixteen, so sixteen such crashes refused every later write on an installation that
 * stored nothing at all.
 */
async function db_release_reservation(
	ctx: MutationCtx,
	args: {
		reservation: Doc<"plugins_data_reservations">;
		usage: Doc<"plugins_data_usage">;
		now: number;
		/**
		 * True when this reservation still holds the document slot. False when a write already
		 * converted reserved -> used (or a delete already moved the used slot to a revision
		 * tombstone). The document may already be gone by the time this runs, so callers pass the
		 * fact instead of looking it up here.
		 */
		reservedSlotStillHeld: boolean;
		/**
		 * True when this release itself turns the reserved slot into a usage tombstone. False when
		 * a delete already inserted a revision tombstone for the same slot. Adding another usage
		 * tombstone on top would charge two slots for one key.
		 */
		addUsageTombstone: boolean;
	},
) {
	const releasedBytes = args.reservation.remainingBytes;
	await ctx.db.patch("plugins_data_reservations", args.reservation._id, {
		state: "released",
		remainingBytes: 0,
		releaseResult: { releasedBytes },
		holdsUsageTombstoneSlot: args.addUsageTombstone,
		releasedAt: args.now,
		// The retry window starts now, because the release is the call a producer may have to replay.
		// The insert set this from the reservation's own expiry, which is the right deadline only while
		// the reservation is live. Leaving it there would hold the document slot for days after a
		// long-lived reservation was released in a minute.
		retryHorizonExpiresAt: args.now + RETRY_HORIZON_MS,
		updatedAt: args.now,
	});

	// Drop the name after the patch above. `db_drop_collection_if_empty` looks for live reservations
	// in this collection, and before the patch it would find this one and keep the name.
	const collectionNames = await db_drop_collection_if_empty(ctx, {
		usage: args.usage,
		collection: args.reservation.collection,
	});

	await ctx.db.patch("plugins_data_usage", args.usage._id, {
		reservedBytes: args.usage.reservedBytes - releasedBytes,
		// The doc itself survives as a retry record, so its slot moves rather than returning.
		reservedDocuments: args.usage.reservedDocuments - (args.reservedSlotStillHeld ? 1 : 0),
		// Only a still-held reserved slot becomes a tombstone here. If the first write already
		// converted reserved → used, the used slot covers the key. Adding a tombstone on top
		// would push used+tombstone over the 10_000 cap and refuse the next in-place write.
		tombstoneDocuments: args.usage.tombstoneDocuments + (args.addUsageTombstone ? 1 : 0),
		collectionNames,
		updatedAt: args.now,
	});

	return releasedBytes;
}

export const release_reservation = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
		idempotencyKey: v.string(),
	},
	returns: v_result({ _yay: v.object({ releasedBytes: v.number() }) }),
	handler: async (ctx, args) => {
		const service = require_service_principal(args.principal);
		if (service._nay) {
			return service;
		}
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const reservation = await ctx.db
			.query("plugins_data_reservations")
			.withIndex("by_installation_principal_idempotencyKey", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("ownerPrincipalKey", args.principal.principalKey)
					.eq("idempotencyKey", args.idempotencyKey),
			)
			.first();
		if (!reservation || reservation.collection !== args.collection || reservation.key !== args.key) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (reservation.releaseResult) {
			return Result({ _yay: reservation.releaseResult });
		}

		const now = Date.now();
		const usage = await db_get_usage(ctx, installation._id);
		if (!usage) {
			const errorMessage = "Plugin data reservation without a usage doc";
			const errorData = { reservationId: reservation._id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const stored = await db_get_document(ctx, {
			installationId: installation._id,
			collection: reservation.collection,
			key: reservation.key,
		});
		const releasedBytes = await db_release_reservation(ctx, {
			reservation,
			usage,
			now,
			reservedSlotStillHeld: stored === null,
			addUsageTombstone: stored === null,
		});

		return Result({ _yay: { releasedBytes } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_release_reservation_Result =
	typeof release_reservation extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion reservations

// #region documents

const document_validator = v.object({
	collection: v.string(),
	key: v.string(),
	value: v.record(v.string(), v.any()),
	revision: v.number(),
	byteSize: v.number(),
	writeMode: v.union(v.literal("normal"), v.literal("versioned")),
	updatedAt: v.number(),
});

function to_public_document(document: Doc<"plugins_data">): Infer<typeof document_validator> {
	return {
		collection: document.collection,
		key: document.key,
		value: document.value,
		revision: document.revision,
		byteSize: document.byteSize,
		writeMode: document.writeMode,
		updatedAt: document.updatedAt,
	};
}

async function db_get_document(
	ctx: QueryCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; key: string },
) {
	return await ctx.db
		.query("plugins_data")
		.withIndex("by_installation_collection_key", (q) =>
			q.eq("installationId", args.installationId).eq("collection", args.collection).eq("key", args.key),
		)
		.first();
}

export const read_document = internalQuery({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
	},
	returns: v_result({ _yay: v.union(document_validator, v.null()) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.read" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const document = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		return Result({ _yay: document ? to_public_document(document) : null });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_read_document_Result =
	typeof read_document extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_documents = internalQuery({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({ _yay: paginationResultValidator(document_validator) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.read" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}

		const page = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_key", (q) =>
				q.eq("installationId", installation._id).eq("collection", collection._yay),
			)
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, MAX_LIST_PAGE_SIZE),
			});

		return Result({ _yay: { ...page, page: page.page.map(to_public_document) } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_list_documents_Result =
	typeof list_documents extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * One accepted write, already checked against the caller and the ceilings. `write_document` and
 * `write_documents_batch` both go through here so a batch item cannot follow different rules.
 */
async function db_write_document(
	ctx: MutationCtx,
	args: {
		principal: StorePrincipal;
		installation: Doc<"plugins_workspace_installations">;
		existing: Doc<"plugins_data"> | null;
		collection: string;
		key: string;
		value: Record<string, unknown>;
		byteSize: number;
		now: number;
	},
) {
	if (args.existing) {
		await ctx.db.patch("plugins_data", args.existing._id, {
			value: args.value,
			byteSize: args.byteSize,
			revision: args.existing.revision + 1,
			updatedBy: args.principal.actorUserId,
			updatedAt: args.now,
		});
		return;
	}

	await ctx.db.insert("plugins_data", {
		organizationId: args.installation.organizationId,
		workspaceId: args.installation.workspaceId,
		installationId: args.installation._id,
		pluginName: args.installation.pluginName,
		collection: args.collection,
		key: args.key,
		value: args.value,
		byteSize: args.byteSize,
		revision: 1,
		writeMode: "normal",
		createdBy: args.principal.actorUserId,
		updatedBy: args.principal.actorUserId,
		updatedAt: args.now,
	});
}

export const write_document = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
		value: v.record(v.string(), v.any()),
	},
	returns: v_result({ _yay: v.object({ revision: v.number(), byteSize: v.number() }) }),
	handler: async (ctx, args) => {
		const written = await db_write_documents(ctx, {
			principal: args.principal,
			documents: [{ collection: args.collection, key: args.key, value: args.value }],
		});
		if (written._nay) {
			return written;
		}

		const only = written._yay.documents[0];
		return Result({ _yay: { revision: only.revision, byteSize: only.byteSize } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_write_document_Result =
	typeof write_document extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const write_documents_batch = internalMutation({
	args: {
		principal: store_principal_validator,
		documents: v.array(v.object({ collection: v.string(), key: v.string(), value: v.record(v.string(), v.any()) })),
	},
	returns: v_result({
		_yay: v.object({
			documents: v.array(
				v.object({ collection: v.string(), key: v.string(), revision: v.number(), byteSize: v.number() }),
			),
		}),
	}),
	handler: async (ctx, args) => await db_write_documents(ctx, args),
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_write_documents_batch_Result =
	typeof write_documents_batch extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Validate and price the whole batch before the first write.
 *
 * A Convex mutation that returns a value commits. So a batch that wrote three documents and then
 * returned `_nay` for the fourth would keep those three while telling the caller nothing was written.
 * Every refusal below therefore happens before `db_write_document` is called even once.
 */
async function db_write_documents(
	ctx: MutationCtx,
	args: {
		principal: StorePrincipal;
		documents: { collection: string; key: string; value: Record<string, unknown> }[];
	},
) {
	if (args.documents.length === 0 || args.documents.length > MAX_BATCH_DOCUMENTS) {
		return Result({ _nay: { message: `A write batch holds 1 to ${MAX_BATCH_DOCUMENTS} documents` } });
	}

	const pagePrincipal = refuse_page_principal(args.principal);
	if (pagePrincipal._nay) {
		return pagePrincipal;
	}
	const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
	if (authorized._nay) {
		return authorized;
	}
	const installation = authorized._yay.installation;

	const now = Date.now();
	const usage = await db_get_usage(ctx, installation._id);
	const storedCollections = new Set(usage?.collectionNames ?? []);

	const seen = new Set<string>();
	const prepared: {
		collection: string;
		key: string;
		value: Record<string, unknown>;
		byteSize: number;
		existing: Doc<"plugins_data"> | null;
	}[] = [];
	let addedBytes = 0;
	let addedSlots = 0;
	const addedCollections = new Set<string>();

	for (const input of args.documents) {
		const collection = validate_name(input.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(input.key, "Keys");
		if (key._nay) {
			return key;
		}
		const byteSize = validate_value(input.value);
		if (byteSize._nay) {
			return byteSize;
		}

		// Two items for the same document in one batch would each price against the stored size, so
		// the counters would drift by the difference.
		const identity = JSON.stringify([collection._yay, key._yay]);
		if (seen.has(identity)) {
			return Result({ _nay: { message: "A write batch names the same document twice" } });
		}
		seen.add(identity);

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		// A versioned key belongs to one external producer that keeps its own order. A normal write
		// here would land between two of its ordered writes and silently lose one of them.
		if (existing?.writeMode === "versioned") {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}
		const reserved = await db_get_live_reservation(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (reserved) {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}
		// A terminal versioned delete removes the value doc and releases the reservation, so for a while
		// the only thing left holding the key is the tombstone. Without this check the key would look
		// free, a normal write would take it as its own, and the service that owns the key could never
		// reserve or write it again.
		const tombstone = await db_get_tombstone(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (tombstone) {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}

		addedBytes += byteSize._yay - (existing?.byteSize ?? 0);
		if (!existing) {
			addedSlots += 1;
		}
		if (!storedCollections.has(collection._yay)) {
			addedCollections.add(collection._yay);
		}
		prepared.push({
			collection: collection._yay,
			key: key._yay,
			value: input.value,
			byteSize: byteSize._yay,
			existing,
		});
	}

	const capacity = check_capacity(usage, {
		addedBytes,
		addedSlots,
		addedCollections: addedCollections.size,
	});
	if (capacity._nay) {
		return capacity;
	}

	// Past this line the batch is accepted, so the writes below run together and the accounting doc
	// is created if this is the installation's first document.
	for (const document of prepared) {
		await db_write_document(ctx, {
			principal: args.principal,
			installation,
			existing: document.existing,
			collection: document.collection,
			key: document.key,
			value: document.value,
			byteSize: document.byteSize,
			now,
		});
	}
	const storedUsage = usage ?? (await db_create_usage(ctx, { installation, now }));
	await ctx.db.patch("plugins_data_usage", storedUsage._id, {
		usedBytes: storedUsage.usedBytes + addedBytes,
		usedDocuments: storedUsage.usedDocuments + addedSlots,
		collectionNames: [...storedUsage.collectionNames, ...addedCollections],
		updatedAt: now,
	});

	return Result({
		_yay: {
			documents: prepared.map((document) => ({
				collection: document.collection,
				key: document.key,
				revision: (document.existing?.revision ?? 0) + 1,
				byteSize: document.byteSize,
			})),
		},
	});
}

export const delete_document = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
	},
	returns: v_result({ _yay: v.object({ deleted: v.boolean() }) }),
	handler: async (ctx, args) => {
		const pagePrincipal = refuse_page_principal(args.principal);
		if (pagePrincipal._nay) {
			return pagePrincipal;
		}
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		// A versioned key belongs to the producer's ordered outbox, so a normal delete may not take it.
		// The write path refuses two more things here, a live reservation and a tombstone. Neither can
		// apply to a delete. A reservation is never taken over a normal document, and a tombstone only
		// exists once the value is already gone.
		if (existing?.writeMode === "versioned") {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}
		if (!existing) {
			return Result({ _yay: { deleted: false } });
		}

		const now = Date.now();
		// A stored document was created by the write path, which always writes the accounting doc in
		// the same transaction, so it exists here.
		const usage = await db_get_usage(ctx, installation._id);
		if (!usage) {
			const errorMessage = "Plugin data document without a usage doc";
			const errorData = { documentId: existing._id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		await ctx.db.delete("plugins_data", existing._id);
		await ctx.db.patch("plugins_data_usage", usage._id, {
			usedBytes: usage.usedBytes - existing.byteSize,
			usedDocuments: usage.usedDocuments - 1,
			collectionNames: await db_drop_collection_if_empty(ctx, { usage, collection: collection._yay }),
			updatedAt: now,
		});

		return Result({ _yay: { deleted: true } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_delete_document_Result =
	typeof delete_document extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion documents

// #region versioned documents

/**
 * Ordered writes from one external producer.
 *
 * The producer keeps an outbox and may retry any entry, so the receiver decides the order instead of
 * trusting arrival order. Revision 1 is only accepted on a key that holds neither a value nor a
 * tombstone, and revision n only when the stored revision is exactly n - 1. Resending the same
 * revision with the same payload answers with the stored result, so a lost response costs nothing.
 * Writing the same key through the normal routes is refused, so a plugin page cannot slip a write
 * between two ordered ones.
 */
export const write_versioned_document = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
		revision: v.number(),
		value: v.record(v.string(), v.any()),
	},
	returns: v_result({ _yay: v.object({ revision: v.number(), byteSize: v.number() }) }),
	handler: async (ctx, args) => {
		const service = require_service_principal(args.principal);
		if (service._nay) {
			return service;
		}
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}
		const byteSize = validate_value(args.value);
		if (byteSize._nay) {
			return byteSize;
		}
		if (!Number.isInteger(args.revision) || args.revision < 1) {
			return Result({ _nay: { message: "A revision is a whole number from 1" } });
		}

		// A delete is terminal. Every write the producer sent before it and that arrives after it is
		// refused until the tombstone's retry horizon passes.
		const tombstone = await db_get_tombstone(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (tombstone) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document was deleted by its service" } });
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (
			existing &&
			(existing.writeMode !== "versioned" || existing.producerPrincipalKey !== args.principal.principalKey)
		) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		if (!existing && args.revision !== 1) {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document does not have the revision before this one" },
			});
		}
		if (existing) {
			// The producer resent an entry whose response it never saw. Same revision and same payload
			// is that retry, so answer it with what the first call stored.
			if (args.revision === existing.revision) {
				if (canonical_json(args.value) !== canonical_json(existing.value)) {
					return Result({
						_nay: { name: REFUSAL_CONFLICT, message: "This revision was already written with a different value" },
					});
				}

				return Result({ _yay: { revision: existing.revision, byteSize: existing.byteSize } });
			}
			if (args.revision !== existing.revision + 1) {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This document does not have the revision before this one" },
				});
			}
		}

		const now = Date.now();
		const usage = await db_get_usage(ctx, installation._id);
		const reservation = await db_get_live_reservation(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		const ownedReservation = reservation?.ownerPrincipalKey === args.principal.principalKey ? reservation : null;

		// Growth spends the reservation first, so the bytes it promised are the bytes it pays with.
		// Shrinking gives them back to the same reservation, up to what it originally held.
		const delta = byteSize._yay - (existing?.byteSize ?? 0);
		const spentFromReservation = ownedReservation && delta > 0 ? Math.min(delta, ownedReservation.remainingBytes) : 0;
		const returnedToReservation =
			ownedReservation && delta < 0
				? Math.min(-delta, ownedReservation.maximumBytes - ownedReservation.remainingBytes)
				: 0;
		const addsCollection = !(usage?.collectionNames ?? []).includes(collection._yay);
		// Reserve already held this key's slot. The first write converts reserved -> used instead of
		// charging a second slot, so a store at the ceiling can still store the key it reserved.
		const convertsReservedSlot = !existing && ownedReservation !== null;
		const capacity = check_capacity(usage, {
			addedBytes: delta - spentFromReservation,
			addedSlots: existing || convertsReservedSlot ? 0 : 1,
			addedCollections: addsCollection ? 1 : 0,
		});
		if (capacity._nay) {
			return capacity;
		}

		if (existing) {
			await ctx.db.patch("plugins_data", existing._id, {
				value: args.value,
				byteSize: byteSize._yay,
				revision: args.revision,
				updatedBy: args.principal.actorUserId,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("plugins_data", {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				installationId: installation._id,
				pluginName: installation.pluginName,
				collection: collection._yay,
				key: key._yay,
				value: args.value,
				byteSize: byteSize._yay,
				revision: args.revision,
				writeMode: "versioned",
				producerPrincipalKey: args.principal.principalKey,
				createdBy: args.principal.actorUserId,
				updatedBy: args.principal.actorUserId,
				updatedAt: now,
			});
		}

		if (ownedReservation && (spentFromReservation > 0 || returnedToReservation > 0)) {
			await ctx.db.patch("plugins_data_reservations", ownedReservation._id, {
				remainingBytes: ownedReservation.remainingBytes - spentFromReservation + returnedToReservation,
				updatedAt: now,
			});
		}

		const storedUsage = usage ?? (await db_create_usage(ctx, { installation, now }));
		await ctx.db.patch("plugins_data_usage", storedUsage._id, {
			usedBytes: storedUsage.usedBytes + delta,
			usedDocuments: storedUsage.usedDocuments + (existing ? 0 : 1),
			reservedBytes: storedUsage.reservedBytes - spentFromReservation + returnedToReservation,
			reservedDocuments: storedUsage.reservedDocuments - (convertsReservedSlot ? 1 : 0),
			collectionNames: addsCollection ? [...storedUsage.collectionNames, collection._yay] : storedUsage.collectionNames,
			updatedAt: now,
		});

		return Result({ _yay: { revision: args.revision, byteSize: byteSize._yay } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_write_versioned_document_Result =
	typeof write_versioned_document extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The producer's terminal delete for one key.
 *
 * Its revision may skip ahead of the stored one, because the point is to supersede entries the
 * producer has not managed to send yet. The value is removed and its bytes come back right away. The
 * tombstone that stays behind only refuses those late entries, until its retry horizon passes.
 */
export const delete_versioned_document = internalMutation({
	args: {
		principal: store_principal_validator,
		collection: v.string(),
		key: v.string(),
		revision: v.number(),
	},
	returns: v_result({ _yay: v.object({ deleted: v.boolean(), revision: v.number() }) }),
	handler: async (ctx, args) => {
		const service = require_service_principal(args.principal);
		if (service._nay) {
			return service;
		}
		const authorized = await db_authorize(ctx, { principal: args.principal, permission: "content.write" });
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}
		if (!Number.isInteger(args.revision) || args.revision < 1) {
			return Result({ _nay: { message: "A revision is a whole number from 1" } });
		}

		const tombstone = await db_get_tombstone(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (tombstone) {
			if (tombstone.producerPrincipalKey !== args.principal.principalKey) {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
			}
			if (args.revision < tombstone.revision) {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document was deleted by its service" } });
			}

			// The producer resent the delete, or sent a later one. Either way the key is already gone.
			return Result({ _yay: { deleted: false, revision: tombstone.revision } });
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (
			existing &&
			(existing.writeMode !== "versioned" || existing.producerPrincipalKey !== args.principal.principalKey)
		) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		if (existing && args.revision <= existing.revision) {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document does not have the revision before this one" },
			});
		}

		const now = Date.now();
		const reservation = await db_get_live_reservation(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		const ownedReservation = reservation?.ownerPrincipalKey === args.principal.principalKey ? reservation : null;
		const releasedReservation = await db_get_released_reservation_holding_slot(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
			ownerPrincipalKey: args.principal.principalKey,
		});
		const releasedSlotAlreadyHeld = releasedReservation !== null;

		// Deleting a stored document is never refused for capacity. It frees the value's bytes, and its
		// tombstone takes the slot the value just gave back. Refusing it would leave the producer with
		// no way to free anything once the store filled up.
		const usage = (await db_get_usage(ctx, installation._id)) ?? (await db_create_usage(ctx, { installation, now }));

		// Deleting a key that was never stored is a different thing. Nothing is given back, so the
		// tombstone is a brand new slot and has to fit. Without this a producer could delete keys that
		// never existed all day and fill the store with tombstones alone. A live reservation already
		// holds that slot, so the tombstone converts it instead of charging a second one. A released
		// never-stored retry record already holds it the same way.
		if (!existing && ownedReservation === null && !releasedSlotAlreadyHeld) {
			const capacity = check_capacity(usage, { addedBytes: 0, addedSlots: 1, addedCollections: 0 });
			if (capacity._nay) {
				return capacity;
			}
		}

		if (existing) {
			await ctx.db.delete("plugins_data", existing._id);
		}
		await ctx.db.insert("plugins_data_revision_tombstones", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: installation._id,
			pluginName: installation.pluginName,
			collection: collection._yay,
			key: key._yay,
			revision: args.revision,
			producerPrincipalKey: args.principal.principalKey,
			deletedAt: now,
			expiresAt: now + RETRY_HORIZON_MS,
		});
		await ctx.db.patch("plugins_data_usage", usage._id, {
			usedBytes: usage.usedBytes - (existing?.byteSize ?? 0),
			usedDocuments: usage.usedDocuments - (existing ? 1 : 0),
			// A released never-stored retry already counted this slot. Adding another would
			// double-count and refuse the last-slot Council delete after the reservation TTL.
			tombstoneDocuments: usage.tombstoneDocuments + (releasedSlotAlreadyHeld ? 0 : 1),
			updatedAt: now,
		});
		if (releasedReservation) {
			// The revision tombstone now owns this slot. Keep the release result for idempotent
			// replies, but stop its expiry from returning the same slot a second time.
			await ctx.db.patch("plugins_data_reservations", releasedReservation._id, {
				holdsUsageTombstoneSlot: false,
			});
		}

		// The delete ends the work this reservation was holding capacity for, so give the bytes back
		// now instead of waiting for the expiry cron. Read the usage doc again because the patch above
		// already changed it.
		if (ownedReservation) {
			const beforeRelease = await db_get_usage(ctx, installation._id);
			if (!beforeRelease) {
				const errorMessage = "Plugin data usage doc missing mid-delete";
				const errorData = { installationId: installation._id };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			await db_release_reservation(ctx, {
				reservation: ownedReservation,
				usage: beforeRelease,
				now,
				// If a value existed, the write converted this slot earlier and the revision tombstone
				// took it. If it never existed, the reservation still holds reservedDocuments; drop
				// that count here. Do not add a usage tombstone either way: the revision tombstone
				// above already occupies the slot.
				reservedSlotStillHeld: existing === null,
				addUsageTombstone: false,
			});
		}

		// Drop the collection name last, once the value, the tombstone, and the reservation state are
		// all final.
		const afterWrites = await db_get_usage(ctx, installation._id);
		if (!afterWrites) {
			const errorMessage = "Plugin data usage doc missing after delete";
			const errorData = { installationId: installation._id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		await ctx.db.patch("plugins_data_usage", afterWrites._id, {
			collectionNames: await db_drop_collection_if_empty(ctx, { usage: afterWrites, collection: collection._yay }),
			updatedAt: now,
		});

		return Result({ _yay: { deleted: existing != null, revision: args.revision } });
	},
});

/** The route calls this through the generated `internal` object, which erases the return type. */
export type plugins_data_delete_versioned_document_Result =
	typeof delete_versioned_document extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion versioned documents

// #region deletion

/** One drain pass deletes at most this many docs, so the mutation stays inside one transaction. */
const DELETION_BATCH_SIZE = 100;

/**
 * Delete one bounded batch of stored plugin data, for one installation or for a whole workspace.
 *
 * None of these five tables points at another, so the order between them is free. What is not free is
 * stopping early: the caller must keep calling until `done`, because one pass deletes at most
 * `batchSize` docs. The accounting doc goes last so that it is never the survivor: while the drain is
 * unfinished the counters are wrong either way, and a leftover accounting doc with no documents left
 * would look like a real installation to anything that reads it.
 */
export async function plugins_data_db_drain_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		/** Null drains every installation in the workspace. */
		installationId: Id<"plugins_workspace_installations"> | null;
		batchSize: number;
	},
) {
	// Every one of these five tables carries the same three scope fields in the same index, so each
	// pass narrows to the workspace and, when the caller named one, to the single installation.
	const reservations = await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (reservations.length > 0) {
		await Promise.all(reservations.map((doc) => ctx.db.delete("plugins_data_reservations", doc._id)));
		return { done: false, deletedCount: reservations.length };
	}

	const tombstones = await ctx.db
		.query("plugins_data_revision_tombstones")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (tombstones.length > 0) {
		await Promise.all(tombstones.map((doc) => ctx.db.delete("plugins_data_revision_tombstones", doc._id)));
		return { done: false, deletedCount: tombstones.length };
	}

	const documents = await ctx.db
		.query("plugins_data")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (documents.length > 0) {
		await Promise.all(documents.map((doc) => ctx.db.delete("plugins_data", doc._id)));
		return { done: false, deletedCount: documents.length };
	}

	const grants = await ctx.db
		.query("plugin_service_grants")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (grants.length > 0) {
		await Promise.all(grants.map((doc) => ctx.db.delete("plugin_service_grants", doc._id)));
		return { done: false, deletedCount: grants.length };
	}

	// The service upload reservations live in their own module because they charge a workspace
	// quota, not the plugin-data counters. Their drain releases live envelopes back to the quota
	// before deleting, so it runs as its own pass here.
	const serviceUploads = await public_api_service_uploads_db_drain_batch(ctx, args);
	if (!serviceUploads.done) {
		return { done: false, deletedCount: serviceUploads.deletedCount };
	}

	const usage = await ctx.db
		.query("plugins_data_usage")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (usage.length > 0) {
		await Promise.all(usage.map((doc) => ctx.db.delete("plugins_data_usage", doc._id)));
		return { done: false, deletedCount: usage.length };
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Finish deleting an uninstalled plugin's data.
 *
 * Uninstall removes the installation doc in its own transaction, so this drain cannot look the scope
 * up afterwards. The uninstall passes the tenant and installation id it already holds, and this
 * mutation reschedules itself until nothing is left.
 */
export const drain_uninstalled_installation = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ done: v.boolean(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		const drained = await plugins_data_db_drain_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			batchSize: DELETION_BATCH_SIZE,
		});
		if (!drained.done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_data.drain_uninstalled_installation, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				installationId: args.installationId,
			});
		}

		return drained;
	},
});

/**
 * How much stored data one installation still holds. The admin deletion preview reports it.
 *
 * The document numbers come from the accounting doc instead of counting docs. One installation may
 * hold ten thousand documents of sixteen kilobytes each, and reading them all to learn how many there
 * are would exceed what one Convex query may read. The counters are maintained in the same
 * transaction as every write, so they are the same answer for one read.
 *
 * `tombstones` therefore covers released reservation records and delete tombstones together, because
 * one counter pays for both of their slots.
 */
export async function plugins_data_db_count_installation_docs(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
	},
) {
	const [usage, serviceGrants] = await Promise.all([
		db_get_usage(ctx, args.installationId),
		ctx.db
			.query("plugin_service_grants")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("installationId", args.installationId),
			)
			.collect(),
	]);

	return {
		usageDocs: usage ? 1 : 0,
		documents: usage?.usedDocuments ?? 0,
		liveReservations: usage?.reservedDocuments ?? 0,
		tombstones: usage?.tombstoneDocuments ?? 0,
		serviceGrants: serviceGrants.length,
	};
}

// #endregion deletion

// #region expiry

/**
 * Give back what expired reservations and old retry records still hold.
 *
 * No request owns this. A producer that crashes never releases its reservation, and without this cron
 * those bytes would stay reserved forever. The passes run in order and each one returns as soon as it
 * did work, so one transaction stays small; the mutation reschedules itself while work remains.
 */
export const cleanup_expired_plugin_data = internalMutation({
	args: {
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ done: v.boolean(), releasedCount: v.number(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		const result = await run_expiry_pass(ctx);
		if (!result.done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_data.cleanup_expired_plugin_data, {});
		}

		return result;
	},
});

async function run_expiry_pass(ctx: MutationCtx) {
	const now = Date.now();

	// Pass 1: a live reservation past its expiry. Releasing keeps the doc as the answer to a
	// replayed release and gives back only what the producer never spent.
	const expired = await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_state_expiresAt", (q) => q.eq("state", "live").lte("expiresAt", now))
		.take(DELETION_BATCH_SIZE);
	if (expired.length > 0) {
		for (const reservation of expired) {
			const usage = await db_get_usage(ctx, reservation.installationId);
			if (!usage) {
				const errorMessage = "Plugin data reservation without a usage doc";
				const errorData = { reservationId: reservation._id };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			const stored = await db_get_document(ctx, {
				installationId: reservation.installationId,
				collection: reservation.collection,
				key: reservation.key,
			});
			await db_release_reservation(ctx, {
				reservation,
				usage,
				now,
				reservedSlotStillHeld: stored === null,
				addUsageTombstone: stored === null,
			});
		}

		return { done: false, releasedCount: expired.length, deletedCount: 0 };
	}

	// Pass 2: the retry record itself, once no reply can still arrive for it. Its slot returns here.
	const staleReservations = await ctx.db
		.query("plugins_data_reservations")
		.withIndex("by_retryHorizonExpiresAt", (q) => q.lte("retryHorizonExpiresAt", now))
		.take(DELETION_BATCH_SIZE);
	if (staleReservations.length > 0) {
		for (const reservation of staleReservations) {
			// The released retry doc records whether it still owns a slot. Current key state is not
			// enough: a fresh reservation may have written the same key after this release.
			if (reservation.holdsUsageTombstoneSlot) {
				await db_return_tombstone_slot(ctx, { installationId: reservation.installationId, now });
			}
			await ctx.db.delete("plugins_data_reservations", reservation._id);
		}

		return { done: false, releasedCount: 0, deletedCount: staleReservations.length };
	}

	// Pass 3: a delete's tombstone, once every entry the producer sent before it has given up.
	const staleTombstones = await ctx.db
		.query("plugins_data_revision_tombstones")
		.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
		.take(DELETION_BATCH_SIZE);
	if (staleTombstones.length > 0) {
		for (const tombstone of staleTombstones) {
			await db_return_tombstone_slot(ctx, { installationId: tombstone.installationId, now });
			await ctx.db.delete("plugins_data_revision_tombstones", tombstone._id);
		}

		return { done: false, releasedCount: 0, deletedCount: staleTombstones.length };
	}

	// Pass 4: expired service grants. Their tokens already stopped resolving, so this only removes
	// the docs.
	const staleGrants = await ctx.db
		.query("plugin_service_grants")
		.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
		.take(DELETION_BATCH_SIZE);
	if (staleGrants.length > 0) {
		await Promise.all(staleGrants.map((grant) => ctx.db.delete("plugin_service_grants", grant._id)));
		return { done: false, releasedCount: 0, deletedCount: staleGrants.length };
	}

	return { done: true, releasedCount: 0, deletedCount: 0 };
}

/**
 * Give one tombstone slot back to an installation. Both retry records and delete tombstones hold a
 * slot while they exist, and both give it back the same way when they are deleted.
 */
async function db_return_tombstone_slot(
	ctx: MutationCtx,
	args: { installationId: Id<"plugins_workspace_installations">; now: number },
) {
	const usage = await db_get_usage(ctx, args.installationId);
	// The installation's data may already be drained by an uninstall, which deletes the accounting doc
	// too. Then there is no counter left to correct.
	if (!usage) {
		return;
	}

	await ctx.db.patch("plugins_data_usage", usage._id, {
		tombstoneDocuments: Math.max(0, usage.tombstoneDocuments - 1),
		updatedAt: args.now,
	});
}

// #endregion expiry
