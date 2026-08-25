import { compareValues, v, type Infer } from "convex/values";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type RegisteredMutation,
	type RegisteredQuery,
} from "convex/server";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_has_permission } from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import { billing_pick_billed_user_id } from "./billing_db.ts";
import type { billing_PRODUCTS } from "../shared/billing.ts";
import { public_api_service_uploads_db_drain_batch } from "./public_api_service_uploads.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_convex_get_plugin_session } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import {
	plugins_data_MAX_KEY_PREFIX_LENGTH,
	plugins_data_MAX_LIST_PAGE_SIZE,
	plugins_data_MAX_NAME_LENGTH,
	type plugins_Capability,
} from "../shared/plugins.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// #region limits

/**
 * One document's value, as UTF-8 bytes of its canonical JSON. Same size as a plugin secret value,
 * which keeps every stored document far below the 1 MiB Convex document limit.
 */
const MAX_VALUE_BYTES = 16 * 1024;
/**
 * The name and key length caps and the list/watch page cap live in `shared/plugins.ts`
 * (`plugins_data_MAX_NAME_LENGTH`, `plugins_data_MAX_KEY_PREFIX_LENGTH`,
 * `plugins_data_MAX_LIST_PAGE_SIZE`), because the plugins UI frame pre-checks watch inputs
 * against the same numbers before subscribing.
 */
/**
 * The largest 13-digit number. Storing `ceiling - now` as the key's time part makes a later
 * append sort lexicographically before an earlier one, so ascending key order reads newest
 * first. 13 digits cover every epoch millisecond until the year 2286.
 */
const APPEND_KEY_MS_CEILING = 9_999_999_999_999;
const MAX_COLLECTIONS = 16;
/** Stored value bytes plus bytes promised to live reservations, per installation. */
const MAX_INSTALLATION_BYTES = 16 * 1024 * 1024;
/**
 * Values, live reservations, and revision tombstones share one ceiling. The byte ceiling alone does
 * not stop a plugin from writing ten million empty documents, and each of those still costs database
 * and index space.
 */
const MAX_DOCUMENT_SLOTS = 10_000;
/**
 * The paid-plan slot ceiling, and the per-plan table the capacity check reads.
 *
 * Paid plans get ten times the Free ceiling: a plan benefit with one number to
 * explain, until usage data argues for splitting the two paid plans.
 *
 * An unknown plan (no billing state, no product, or a name outside the catalog)
 * reads as Free, the same way every billing gate treats unknown state.
 */
const PAID_MAX_DOCUMENT_SLOTS = 100_000;
const PLAN_MAX_DOCUMENT_SLOTS = {
	Free: MAX_DOCUMENT_SLOTS,
	"Pay As You Go": PAID_MAX_DOCUMENT_SLOTS,
	Pro: PAID_MAX_DOCUMENT_SLOTS,
} as const satisfies Record<keyof typeof billing_PRODUCTS, number>;
/**
 * How much of an installation's capacity one member may hold.
 *
 * These are fixed numbers rather than a share of the current membership. The ceiling check is a pure
 * function with no way to count members, and a share that moved when someone joined would
 * retroactively refuse a member who was inside it a moment earlier.
 *
 * Bytes: splitting 16 MiB across a 30-member workspace gives ~546 KiB, and this is three times that,
 * so an ordinary member never meets it. Slots: an anti-exhaustion bound at 30% of the installation,
 * because an equal split refuses the busiest member of a modelled workspace after two and a half
 * days with the store only a fifth full. Collections: half of the installation's 16, which still
 * leaves a plugin room to add a collection later and still stops one member pinning all of them.
 */
const MEMBER_MAX_BYTES = 1600 * 1024;
const MEMBER_MAX_DOCUMENT_SLOTS = 3_000;
const MEMBER_MAX_COLLECTIONS = MAX_COLLECTIONS / 2;
/**
 * Warn while an installation still has room to act on it. Derived, never transcribed: moving a
 * ceiling has to move its warning with it.
 */
const USAGE_WARN_FRACTION = 0.8;
const MAX_BATCH_DOCUMENTS = 50;
/** How many member ids one display-name resolve may ask about. Same size as a write batch. */
const MAX_MEMBER_RESOLVE_IDS = 50;
/**
 * How many members one roster page may return. Each row costs two document reads, so this is the
 * page size and not the roster size: a bigger workspace is read one page at a time.
 */
const MAX_MEMBER_LIST_PAGE_SIZE = 100;
/** How many people one private scope may name. Same size as a file share list. */
const MAX_SCOPE_PRINCIPALS = 50;
/**
 * How many scopes one member may be named in, per workspace.
 *
 * The cap exists because removing a member from the organization collects every grant they hold in
 * one unbounded read (`organizations.ts`). Bounding the grants bounds that read.
 *
 * It is only safe because a scope can be deleted. A member who reaches the cap deletes a private
 * channel they no longer need and creates the next one. Without a delete door the cap would wedge
 * them forever: a scope id is minted by the plugin, so an abandoned scope cannot be found again.
 */
const MAX_SCOPES_PER_MEMBER = 50;
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
function validate_name(raw: string, label: "Collection names" | "Keys" | "Idempotency keys" | "Scope ids") {
	if (raw.length === 0) {
		return Result({ _nay: { message: `${label} must not be empty` } });
	}
	if (raw.length > plugins_data_MAX_NAME_LENGTH) {
		return Result({ _nay: { message: `${label} must be at most ${plugins_data_MAX_NAME_LENGTH} characters` } });
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

/**
 * A key prefix is caller text the append completes into a full key, and the same rule bounds the
 * list route's prefix filter. Printable ASCII only (0x21-0x7E, no space): with that alphabet the
 * exclusive upper bound of a prefix scan can be built by incrementing the prefix's last
 * character, which a full Unicode alphabet would not allow.
 */
function validate_key_prefix(raw: string) {
	if (raw.length === 0) {
		return Result({ _nay: { message: "Key prefixes must not be empty" } });
	}
	if (raw.length > plugins_data_MAX_KEY_PREFIX_LENGTH) {
		return Result({ _nay: { message: `Key prefixes must be at most ${plugins_data_MAX_KEY_PREFIX_LENGTH} characters` } });
	}
	if (!/^[\x21-\x7e]+$/.test(raw)) {
		return Result({ _nay: { message: "Key prefixes must contain only printable ASCII characters" } });
	}

	return Result({ _yay: raw });
}

/**
 * The exclusive upper bound of a scan for keys that start with a validated key prefix.
 *
 * Replace the prefix's last character with the next character code. Every key that starts with the
 * prefix sorts below that bound, no matter what the rest of the key holds — including supplementary
 * Unicode characters, which sort above U+FFFF in Convex's UTF-8 index order. This only works
 * because `validate_key_prefix` pins the prefix alphabet to printable ASCII, so the incremented
 * character is at most 0x7F. The bound is a range endpoint, not a key, so it is not validated as one.
 */
function key_prefix_upper_bound(keyPrefix: string) {
	const lastCharCode = keyPrefix.charCodeAt(keyPrefix.length - 1);
	return keyPrefix.slice(0, -1) + String.fromCharCode(lastCharCode + 1);
}

/**
 * Intersect the key-prefix range with a watch's optional interval bounds into one index range.
 *
 * Convex index builders accept only one lower and one upper bound per field, and the prefix scan
 * already uses both, so this module picks the tighter side itself. Every comparison uses
 * `compareValues`, because the index orders strings by their UTF-8 bytes and a JS `<` would
 * disagree on supplementary-plane characters. An interval whose bounds cross reads as "empty"
 * instead of being refused, because detecting the inversion up front would need exactly that
 * broken JS order check.
 */
function intersect_key_ranges(args: {
	prefixRange: { lower: string; upper: string } | null;
	startExclusive: string | null;
	endInclusive: string | null;
}) {
	// Pick the tighter lower bound. On a tie the fencepost wins: the prefix's `gte` would keep the
	// boundary doc that the fencepost's `gt` must drop.
	let lower: { value: string; inclusive: boolean } | null = args.prefixRange
		? { value: args.prefixRange.lower, inclusive: true }
		: null;
	if (args.startExclusive !== null && (lower === null || compareValues(args.startExclusive, lower.value) >= 0)) {
		lower = { value: args.startExclusive, inclusive: false };
	}

	// Mirrored on the upper side: the prefix's exclusive `lt` wins a tie against the fencepost's
	// inclusive `lte`.
	let upper: { value: string; inclusive: boolean } | null = args.prefixRange
		? { value: args.prefixRange.upper, inclusive: false }
		: null;
	if (args.endInclusive !== null && (upper === null || compareValues(args.endInclusive, upper.value) < 0)) {
		upper = { value: args.endInclusive, inclusive: true };
	}

	// Crossed bounds hold nothing. Touching bounds hold their one shared key only when both sides
	// keep it.
	if (lower !== null && upper !== null) {
		const order = compareValues(lower.value, upper.value);
		if (order > 0 || (order === 0 && !(lower.inclusive && upper.inclusive))) {
			return "empty" as const;
		}
	}

	return { lower, upper };
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

	// The organization comes back because the capacity ceilings are plan-driven, and the payer
	// resolution needs `billingMode` and `ownerUserId`. It was already loaded above, so handing it
	// back costs no read.
	return Result({ _yay: { installation, organization } });
}

/**
 * Keep a plugin frame out of every write. `plugin_ui` is the principal of both frame kinds, because
 * a page and a file view each carry a `plu_` token and `public_api.ts` builds the principal from the
 * installation without reading the session's `fileNodeId`. So this refuses both.
 *
 * A frame session can belong to an anonymous identity. A frame is also the first thing a scripting
 * bug in a plugin reaches. A write door there would turn one such bug into stored data that plugin
 * backends later act on with their own secrets.
 *
 * Two other things already refuse a frame write. The routes leave `plugin_ui` out of every write
 * allowlist, and a UI token never carries the write scope. This guard is the third, and it is the
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
 * The document-slot ceiling this installation's plan buys, read fresh on every
 * write. There is no stored ceiling anywhere: a downgrade raises no stored value,
 * it only makes the next comparison refuse.
 *
 * The ceiling follows the billed user (`billing_pick_billed_user_id`): the owner in
 * an owner-billed organization, otherwise the acting member. Every door resolves it
 * the same way, so a member cannot get a different ceiling by choosing a door. In a
 * default `"user"`-mode shared organization the writer's own plan therefore sets the
 * ceiling, while the daily storage cron bills the owner (it has no actor to bill).
 */
async function db_resolve_document_slot_cap(
	ctx: QueryCtx,
	args: {
		actorUserId: Id<"users">;
		organization: Pick<Doc<"organizations">, "default" | "billingMode" | "ownerUserId">;
	},
) {
	const billedUserId = billing_pick_billed_user_id({
		userId: args.actorUserId,
		organization: args.organization,
	});

	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", billedUserId))
		.first();
	if (!usageSnapshot?.subscription) {
		return MAX_DOCUMENT_SLOTS;
	}

	const product = await ctx.runQuery(components.polar.lib.getProduct, {
		id: usageSnapshot.subscription.productId,
	});
	if (!product) {
		return MAX_DOCUMENT_SLOTS;
	}

	return PLAN_MAX_DOCUMENT_SLOTS[product.name as keyof typeof billing_PRODUCTS] ?? MAX_DOCUMENT_SLOTS;
}

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
 * Patch the accounting doc, and warn once when this write is what crosses 80% of a ceiling.
 *
 * The comparison lives here and not in `check_capacity`. That function is pure and runs before the
 * write is accepted, so from there it would warn for writes that are then refused for another
 * reason, and again on every optimistic-concurrency retry of the same logical write. This runs in
 * the transaction that commits the crossing, so one crossing is one line.
 *
 * The thresholds are 80% of the two aggregates `check_capacity` refuses on, not of `usedBytes` and
 * `usedDocuments` alone. Three callers never touch those two fields: a reservation moves
 * `reservedBytes` and `reservedDocuments`, and a revision tombstone moves `tombstoneDocuments`.
 * Those are the doors that fill the store fastest, so a threshold over the stored halves alone would
 * never fire for them and the installation would meet its ceiling unannounced.
 *
 * The slot threshold follows the plan-resolved ceiling the caller already resolved for its capacity
 * check, not the Free constant: a paid installation should warn at 80% of what it can hold.
 */
async function db_patch_usage(
	ctx: MutationCtx,
	args: {
		usage: Doc<"plugins_data_usage">;
		next: Partial<
			Pick<
				Doc<"plugins_data_usage">,
				"usedBytes" | "usedDocuments" | "reservedBytes" | "reservedDocuments" | "tombstoneDocuments" | "collectionNames"
			>
		>;
		now: number;
		maxDocumentSlots: number;
	},
) {
	const after = { ...args.usage, ...args.next };
	const beforeBytes = args.usage.usedBytes + args.usage.reservedBytes;
	const afterBytes = after.usedBytes + after.reservedBytes;
	const beforeSlots = args.usage.usedDocuments + args.usage.reservedDocuments + args.usage.tombstoneDocuments;
	const afterSlots = after.usedDocuments + after.reservedDocuments + after.tombstoneDocuments;
	const byteThreshold = MAX_INSTALLATION_BYTES * USAGE_WARN_FRACTION;
	const slotThreshold = args.maxDocumentSlots * USAGE_WARN_FRACTION;

	// A write that crosses both thresholds at once still logs one line, not two.
	if (
		(beforeBytes < byteThreshold && afterBytes >= byteThreshold) ||
		(beforeSlots < slotThreshold && afterSlots >= slotThreshold)
	) {
		console.warn("A plugin installation passed 80% of a storage ceiling", {
			installationId: args.usage.installationId,
			pluginName: args.usage.pluginName,
			usedBytes: afterBytes,
			maxBytes: MAX_INSTALLATION_BYTES,
			usedSlots: afterSlots,
			maxSlots: args.maxDocumentSlots,
		});
	}

	await ctx.db.patch("plugins_data_usage", args.usage._id, { ...args.next, updatedAt: args.now });
}

/**
 * Check the ceilings for one pending change before anything is written. An installation with no
 * usage document yet has stored nothing, so every counter reads as zero.
 *
 * `member` is present whenever the write will be charged to somebody — a frame door or a user API
 * key. A plugin backend passes none: refusing a backend because one member is full would let that
 * member block the whole plugin.
 */
function check_capacity(
	usage: Doc<"plugins_data_usage"> | null,
	change: { addedBytes: number; addedSlots: number; addedCollections: number },
	maxDocumentSlots: number,
	member?: {
		usage: Doc<"plugins_data_member_usage"> | null;
		change: { addedBytes: number; addedSlots: number; addedCollections: number };
	},
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
	if (usedSlots + change.addedSlots > maxDocumentSlots) {
		return Result({
			_nay: { name: REFUSAL_STORAGE_FULL, message: `This plugin has used its ${maxDocumentSlots} document slots` },
		});
	}
	if (usedCollections + change.addedCollections > MAX_COLLECTIONS) {
		return Result({
			_nay: { name: REFUSAL_STORAGE_FULL, message: `This plugin can use at most ${MAX_COLLECTIONS} collections` },
		});
	}

	if (!member) {
		return Result({ _yay: null });
	}

	// The member's own bytes are what they composed. Bytes a plugin backend wrote into their
	// documents count against the installation but not against them, or a backend could fill a
	// member's share and lock them out of a plugin they use.
	const memberBytes = member.usage ? member.usage.usedBytes - member.usage.machineBytes : 0;
	const memberSlots = member.usage ? member.usage.usedDocuments : 0;
	const memberCollections = member.usage ? member.usage.collectionNames.length : 0;

	// Each refusal below names the member's own share, so a page can tell "you are full" from "the
	// plugin is full" — they carry the same refusal name and the same HTTP status, so the message is
	// the only thing that distinguishes them.
	if (memberBytes + member.change.addedBytes > MEMBER_MAX_BYTES) {
		return Result({
			_nay: {
				name: REFUSAL_STORAGE_FULL,
				message: `You have used your ${(MEMBER_MAX_BYTES / (1024 * 1024)).toFixed(1)} MiB share of this plugin's storage`,
			},
		});
	}
	if (memberSlots + member.change.addedSlots > MEMBER_MAX_DOCUMENT_SLOTS) {
		return Result({
			_nay: {
				name: REFUSAL_STORAGE_FULL,
				message: `You have used your ${MEMBER_MAX_DOCUMENT_SLOTS} document slots in this plugin`,
			},
		});
	}
	if (memberCollections + member.change.addedCollections > MEMBER_MAX_COLLECTIONS) {
		return Result({
			_nay: {
				name: REFUSAL_STORAGE_FULL,
				message: `You can create at most ${MEMBER_MAX_COLLECTIONS} collections in this plugin`,
			},
		});
	}

	return Result({ _yay: null });
}

async function db_get_member_usage(
	ctx: QueryCtx,
	args: { installationId: Id<"plugins_workspace_installations">; userId: Id<"users"> },
) {
	return await ctx.db
		.query("plugins_data_member_usage")
		.withIndex("by_installation_user", (q) => q.eq("installationId", args.installationId).eq("userId", args.userId))
		.first();
}

/**
 * Move one member's counters by a delta, creating the row on the first charge and deleting it once
 * the member holds nothing.
 *
 * The row is deleted rather than left at zero on purpose. A clamped zero would keep one row per
 * member who ever wrote, so the table would grow with churn and a departed member would leave an id
 * behind for nothing.
 */
async function db_patch_member_usage(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		userId: Id<"users">;
		addedBytes: number;
		addedSlots: number;
		addedMachineBytes: number;
		addedCollections: string[];
	},
) {
	const existing = await db_get_member_usage(ctx, { installationId: args.installation._id, userId: args.userId });

	const collectionNames = existing ? [...existing.collectionNames] : [];
	for (const name of args.addedCollections) {
		if (!collectionNames.includes(name)) {
			collectionNames.push(name);
		}
	}

	const usedBytes = (existing?.usedBytes ?? 0) + args.addedBytes;
	const usedDocuments = (existing?.usedDocuments ?? 0) + args.addedSlots;
	const machineBytes = (existing?.machineBytes ?? 0) + args.addedMachineBytes;

	if (!existing) {
		// Only a write that takes a document over starts a member's row, and that is the one change
		// that adds a slot. Every other change naming a member can arrive after the member left: the
		// prune deleted their row, their documents stayed in the workspace, and deleting or patching
		// one of those still names them. Writing a row here would store counters for a user who is
		// gone, and a delete's counters are negative.
		if (args.addedSlots <= 0) {
			return;
		}

		await ctx.db.insert("plugins_data_member_usage", {
			organizationId: args.installation.organizationId,
			workspaceId: args.installation.workspaceId,
			installationId: args.installation._id,
			userId: args.userId,
			usedBytes,
			usedDocuments,
			machineBytes,
			collectionNames,
		});
		return;
	}

	// A stored zero would keep one row per member who ever wrote, so the table would grow with churn.
	if (usedBytes === 0 && usedDocuments === 0 && machineBytes === 0 && collectionNames.length === 0) {
		await ctx.db.delete("plugins_data_member_usage", existing._id);
		return;
	}

	await ctx.db.patch("plugins_data_member_usage", existing._id, {
		usedBytes,
		usedDocuments,
		machineBytes,
		collectionNames,
	});
}

/**
 * Remove a collection the installation just dropped from every member row of the installation.
 *
 * The installation's list shrinks when a collection stops holding documents and reservations. The
 * per-member lists have to shrink with it, or a member who created a collection and then emptied it
 * spends that share slot forever. The range is bounded by the workspace's member count and only runs
 * on the transaction that emptied a collection.
 */
async function db_drop_member_collection(
	ctx: MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		collection: string;
		storedNames: string[];
		nextNames: string[];
	},
) {
	if (args.nextNames.length === args.storedNames.length) {
		return;
	}

	const rows = await ctx.db
		.query("plugins_data_member_usage")
		.withIndex("by_installation_user", (q) => q.eq("installationId", args.installationId))
		.collect();

	for (const row of rows) {
		if (!row.collectionNames.includes(args.collection)) {
			continue;
		}

		const collectionNames = row.collectionNames.filter((name) => name !== args.collection);
		// Re-check the delete condition on this row too. The shrink can bring a member who holds no
		// documents down to fully empty, and that member has nothing left that would ever make
		// another write look at their row again.
		if (row.usedBytes === 0 && row.usedDocuments === 0 && row.machineBytes === 0 && collectionNames.length === 0) {
			await ctx.db.delete("plugins_data_member_usage", row._id);
			continue;
		}

		await ctx.db.patch("plugins_data_member_usage", row._id, { collectionNames });
	}
}

/**
 * What one accepted write costs each member, before it is written.
 *
 * A member's write takes the whole document over: it charges the writer the new bytes and the slot,
 * and credits whoever held them before. A plugin backend's write charges nobody — an insert belongs
 * to the installation, and a patch leaves the stored member alone, because the document is still
 * theirs and only its size changed.
 */
function member_usage_deltas(args: {
	/** The member the write is charged to, or null for a plugin backend. */
	writer: Id<"users"> | null;
	existing: Doc<"plugins_data"> | null;
	collection: string;
	/** True when this write is what puts the collection on the installation's list. */
	addsCollection: boolean;
	byteSize: number;
}) {
	const storedBytes = args.existing?.byteSize ?? 0;
	const storedMachineBytes = args.existing?.machineBytes ?? 0;
	const storedChargedTo = args.existing?.chargedTo ?? null;

	if (args.writer === null) {
		// A backend patch on a member's document: their totals follow the new size, the slot stays
		// where it is, and the whole document is machine-written from now on.
		if (storedChargedTo === null) {
			return [];
		}

		return [
			{
				userId: storedChargedTo,
				addedBytes: args.byteSize - storedBytes,
				addedSlots: 0,
				addedMachineBytes: args.byteSize - storedMachineBytes,
				addedCollections: [],
			},
		];
	}

	const deltas = [];
	// Credit whoever held the document before, unless it is the writer: then the charge only moves
	// from the old size to the new one.
	if (storedChargedTo !== null && storedChargedTo !== args.writer) {
		deltas.push({
			userId: storedChargedTo,
			addedBytes: -storedBytes,
			addedSlots: -1,
			addedMachineBytes: -storedMachineBytes,
			addedCollections: [],
		});
	}

	const writerHeldIt = storedChargedTo === args.writer;
	deltas.push({
		userId: args.writer,
		addedBytes: args.byteSize - (writerHeldIt ? storedBytes : 0),
		addedSlots: writerHeldIt ? 0 : 1,
		// The member composed the value that is now stored, so the document's machine share is gone.
		addedMachineBytes: writerHeldIt ? -storedMachineBytes : 0,
		// A member's list holds the collections they introduced to the installation, so a member who
		// only writes into somebody else's collection never spends a share slot for it.
		addedCollections: args.addsCollection ? [args.collection] : [],
	});

	return deltas;
}

/**
 * The member half of the ceiling check for one pending write, in the same shape `check_capacity`
 * takes. It is what the writer's own share would hold after the write, not what the installation
 * would hold: bytes a backend wrote never count, and taking a document over costs a whole slot.
 */
function member_capacity_change(args: {
	existing: Doc<"plugins_data"> | null;
	writer: Id<"users">;
	/** True when this write is what puts the collection on the installation's list. */
	addsCollection: boolean;
	byteSize: number;
}) {
	const writerHeldIt = (args.existing?.chargedTo ?? null) === args.writer;
	const heldOwnBytes = writerHeldIt ? (args.existing?.byteSize ?? 0) - (args.existing?.machineBytes ?? 0) : 0;

	return {
		addedBytes: args.byteSize - heldOwnBytes,
		addedSlots: writerHeldIt ? 0 : 1,
		addedCollections: args.addsCollection ? 1 : 0,
	};
}

/**
 * Credit the member who held a document that is being deleted. A document charged to nobody, or to a
 * member whose row is already gone, credits nothing.
 */
async function db_credit_member_for_delete(
	ctx: MutationCtx,
	args: { installation: Doc<"plugins_workspace_installations">; document: Doc<"plugins_data"> },
) {
	if (!args.document.chargedTo) {
		return;
	}

	await db_patch_member_usage(ctx, {
		installation: args.installation,
		userId: args.document.chargedTo,
		addedBytes: -args.document.byteSize,
		addedSlots: -1,
		addedMachineBytes: -(args.document.machineBytes ?? 0),
		addedCollections: [],
	});
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
		const { installation, organization } = authorized._yay;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId: args.principal.actorUserId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
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
		const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
			actorUserId: args.principal.actorUserId,
			organization,
		});
		const capacity = check_capacity(
			usage,
			{
				addedBytes: args.maximumBytes,
				addedSlots: 1,
				addedCollections: addsCollection ? 1 : 0,
			},
			maxDocumentSlots,
		);
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
		await db_patch_usage(ctx, {
			usage: storedUsage,
			next: {
				reservedBytes: storedUsage.reservedBytes + args.maximumBytes,
				reservedDocuments: storedUsage.reservedDocuments + 1,
				collectionNames: addsCollection
					? [...storedUsage.collectionNames, collection._yay]
					: storedUsage.collectionNames,
			},
			now,
			maxDocumentSlots,
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
		maxDocumentSlots: number;
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
	await db_drop_member_collection(ctx, {
		installationId: args.usage.installationId,
		collection: args.reservation.collection,
		storedNames: args.usage.collectionNames,
		nextNames: collectionNames,
	});

	await db_patch_usage(ctx, {
		usage: args.usage,
		next: {
			reservedBytes: args.usage.reservedBytes - releasedBytes,
			// The doc itself survives as a retry record, so its slot moves rather than returning.
			reservedDocuments: args.usage.reservedDocuments - (args.reservedSlotStillHeld ? 1 : 0),
			// Only a still-held reserved slot becomes a tombstone here. If the first write already
			// converted reserved → used, the used slot covers the key. Adding a tombstone on top
			// would push used+tombstone over the slot cap and refuse the next in-place write.
			tombstoneDocuments: args.usage.tombstoneDocuments + (args.addUsageTombstone ? 1 : 0),
			collectionNames,
		},
		now: args.now,
		maxDocumentSlots: args.maxDocumentSlots,
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
		const releaseOrganization = authorized._yay.organization;

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
			maxDocumentSlots: await db_resolve_document_slot_cap(ctx, {
				actorUserId: args.principal.actorUserId,
				organization: releaseOrganization,
			}),
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
	ownership: v.union(v.literal("shared"), v.literal("owned")),
	createdBy: v.id("users"),
	updatedBy: v.id("users"),
	createdAt: v.number(),
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
		ownership: document.ownership,
		createdBy: document.createdBy,
		updatedBy: document.updatedBy,
		createdAt: document._creationTime,
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
		// A private document answers absent unless the person this call acts for is in its scope. It
		// reads as "not there" rather than "denied" on purpose: the two answers apart would tell a
		// caller that a private channel exists and which keys it holds.
		if (
			document?.scopeId !== undefined &&
			!(await db_can_use_scope(ctx, {
				installation,
				scopeId: document.scopeId,
				userId: args.principal.actorUserId,
				permission: "content.read",
			}))
		) {
			return Result({ _yay: null });
		}

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
		keyPrefix: v.optional(v.string()),
		keyStartExclusive: v.optional(v.string()),
		keyEndInclusive: v.optional(v.string()),
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
		const keyPrefix = args.keyPrefix === undefined ? Result({ _yay: null }) : validate_key_prefix(args.keyPrefix);
		if (keyPrefix._nay) {
			return keyPrefix;
		}
		// The deep-history continuation: the caller resends the last key of the page it just read as
		// `keyStartExclusive`. Both bounds are keys the caller copied from documents this door
		// returned, so they follow the same shape rules as keys. There is no order check between the
		// two, because `intersect_key_ranges` reads a crossed pair as empty.
		const keyStartExclusive =
			args.keyStartExclusive === undefined ? Result({ _yay: null }) : validate_name(args.keyStartExclusive, "Keys");
		if (keyStartExclusive._nay) {
			return keyStartExclusive;
		}
		const keyEndInclusive =
			args.keyEndInclusive === undefined ? Result({ _yay: null }) : validate_name(args.keyEndInclusive, "Keys");
		if (keyEndInclusive._nay) {
			return keyEndInclusive;
		}

		const keyRange =
			keyPrefix._yay === null ? null : { lower: keyPrefix._yay, upper: key_prefix_upper_bound(keyPrefix._yay) };
		const range = intersect_key_ranges({
			prefixRange: keyRange,
			startExclusive: keyStartExclusive._yay,
			endInclusive: keyEndInclusive._yay,
		});
		// Crossed bounds hold nothing, and this door has to say so with a *finished* page. An
		// unfinished empty page makes the route echo a non-null cursor, and a caller that follows it
		// asks for the same empty page forever. A fencepost reused against a different `keyPrefix`
		// crosses the bounds, so this is reachable from ordinary client code.
		if (range === "empty") {
			return Result({ _yay: { page: [], isDone: true, continueCursor: "" } });
		}

		// Same split as the reactive window: a prefix inside a private scope reads that scope once the
		// person this call acts for proves they are in it, and every other read sees the unscoped half.
		// A caller with no grant hears the finished-empty answer, which is also what an empty range
		// answers, so the refusal says nothing about whether the scope exists.
		const readScope =
			keyPrefix._yay === null
				? null
				: await db_resolve_scope(ctx, {
						installationId: installation._id,
						collection: collection._yay,
						key: keyPrefix._yay,
					});
		if (
			readScope &&
			!(await db_can_use_scope(ctx, {
				installation,
				scopeId: readScope.scopeId,
				userId: args.principal.actorUserId,
				permission: "content.read",
			}))
		) {
			return Result({ _yay: { page: [], isDone: true, continueCursor: "" } });
		}

		// The bounds ride the index as a range, never a post-index filter, so the pagination cursor
		// continues inside the narrowed range and every page stays full.
		const page = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_key", (q) => {
				const base = q
					.eq("installationId", installation._id)
					.eq("collection", collection._yay)
					.eq("scopeId", readScope?.scopeId);
				const lowerBounded =
					range.lower === null
						? base
						: range.lower.inclusive
							? base.gte("key", range.lower.value)
							: base.gt("key", range.lower.value);
				return range.upper === null
					? lowerBounded
					: range.upper.inclusive
						? lowerBounded.lte("key", range.upper.value)
						: lowerBounded.lt("key", range.upper.value);
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, plugins_data_MAX_LIST_PAGE_SIZE),
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
		actorUserId: Id<"users">;
		installation: Doc<"plugins_workspace_installations">;
		existing: Doc<"plugins_data"> | null;
		collection: string;
		key: string;
		value: Record<string, unknown>;
		byteSize: number;
		/** Only the user-write door sets this. Absent keeps the pre-door meaning: shared. */
		ownership?: "shared" | "owned";
		/** Only the user-write door's append sets this, for replay dedup. */
		userWrite?: { requestId: string; requestFingerprint: string };
		/**
		 * The member whose share holds this document after the write, or null when a plugin backend
		 * wrote it. A backend's insert is charged to the installation only; a backend's patch leaves
		 * the stored member where they are, because the document is still theirs.
		 */
		chargedTo: Id<"users"> | null;
		now: number;
	},
) {
	// Every writer resolves the scope here instead of being handed one. A caller that could name its
	// own scope could put a public document inside a private range, and a new write path that forgot
	// to pass one would do the same by accident.
	const scope = await db_resolve_scope(ctx, {
		installationId: args.installation._id,
		collection: args.collection,
		key: args.key,
	});

	if (args.existing) {
		await ctx.db.patch("plugins_data", args.existing._id, {
			value: args.value,
			byteSize: args.byteSize,
			revision: args.existing.revision + 1,
			updatedBy: args.actorUserId,
			updatedAt: args.now,
			// The binding is authoritative, so the stamp is rewritten on every write. Deleting a scope
			// clears it again the next time the document is touched.
			scopeId: scope?.scopeId,
			// A member's write takes the document over and zeroes its machine share, because the
			// member composed the value that is now stored. A backend's patch changes only the size.
			...(args.chargedTo === null
				? { machineBytes: args.byteSize }
				: { chargedTo: args.chargedTo, machineBytes: 0 }),
		});
		return;
	}

	await ctx.db.insert("plugins_data", {
		scopeId: scope?.scopeId,
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
		// The service and API writers never pass ownership; their docs are shared by definition.
		ownership: args.ownership ?? "shared",
		userWriteRequestId: args.userWrite?.requestId,
		userWriteRequestFingerprint: args.userWrite?.requestFingerprint,
		createdBy: args.actorUserId,
		updatedBy: args.actorUserId,
		updatedAt: args.now,
		chargedTo: args.chargedTo ?? undefined,
		machineBytes: args.chargedTo === null ? args.byteSize : 0,
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
	const { installation, organization } = authorized._yay;

	const now = Date.now();
	const usage = await db_get_usage(ctx, installation._id);
	const storedCollections = new Set(usage?.collectionNames ?? []);

	// An API key writes as the member who minted it, so this door is charged like a frame door. A
	// plugin backend charges nobody: its writes belong to the installation.
	const writer = args.principal.kind === "user_api_key" ? args.principal.actorUserId : null;
	const memberUsage = writer
		? await db_get_member_usage(ctx, { installationId: installation._id, userId: writer })
		: null;

	const seen = new Set<string>();
	const prepared: {
		collection: string;
		key: string;
		value: Record<string, unknown>;
		byteSize: number;
		addsCollection: boolean;
		existing: Doc<"plugins_data"> | null;
	}[] = [];
	let addedBytes = 0;
	let addedSlots = 0;
	const addedCollections = new Set<string>();
	let memberAddedBytes = 0;
	let memberAddedSlots = 0;

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

		// Nothing is written until the whole loop has passed, so refusing here refuses the batch.
		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId: args.principal.actorUserId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

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
		// An owned doc was created by one member through the user-write door and only that member may
		// change it. This is the storage layer, so every interactive writer is judged here, no
		// matter which route it came through.
		if (existing?.ownership === "owned" && existing.createdBy !== args.principal.actorUserId) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
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
		// A second item naming the same new collection must not be counted twice, so the batch's own
		// set decides, not the stored list alone.
		const addsCollection = !storedCollections.has(collection._yay) && !addedCollections.has(collection._yay);
		if (!storedCollections.has(collection._yay)) {
			addedCollections.add(collection._yay);
		}
		if (writer) {
			const memberChange = member_capacity_change({
				existing,
				writer,
				addsCollection,
				byteSize: byteSize._yay,
			});
			memberAddedBytes += memberChange.addedBytes;
			memberAddedSlots += memberChange.addedSlots;
		}
		prepared.push({
			collection: collection._yay,
			key: key._yay,
			value: input.value,
			byteSize: byteSize._yay,
			addsCollection,
			existing,
		});
	}

	const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
		actorUserId: args.principal.actorUserId,
		organization,
	});
	const capacity = check_capacity(
		usage,
		{
			addedBytes,
			addedSlots,
			addedCollections: addedCollections.size,
		},
		maxDocumentSlots,
		writer
			? {
					usage: memberUsage,
					change: {
						addedBytes: memberAddedBytes,
						addedSlots: memberAddedSlots,
						// Every collection this batch introduces is new to the writer too: a name on any
						// member's list is a name the installation still holds.
						addedCollections: addedCollections.size,
					},
				}
			: undefined,
	);
	if (capacity._nay) {
		return capacity;
	}

	// Past this line the batch is accepted, so the writes below run together and the accounting doc
	// is created if this is the installation's first document.
	for (const document of prepared) {
		await db_write_document(ctx, {
			actorUserId: args.principal.actorUserId,
			installation,
			existing: document.existing,
			collection: document.collection,
			key: document.key,
			value: document.value,
			byteSize: document.byteSize,
			chargedTo: writer,
			now,
		});
		for (const delta of member_usage_deltas({
			writer,
			existing: document.existing,
			collection: document.collection,
			addsCollection: document.addsCollection,
			byteSize: document.byteSize,
		})) {
			await db_patch_member_usage(ctx, { installation, ...delta });
		}
	}
	const storedUsage = usage ?? (await db_create_usage(ctx, { installation, now }));
	await db_patch_usage(ctx, {
		usage: storedUsage,
		next: {
			usedBytes: storedUsage.usedBytes + addedBytes,
			usedDocuments: storedUsage.usedDocuments + addedSlots,
			collectionNames: [...storedUsage.collectionNames, ...addedCollections],
		},
		now,
		maxDocumentSlots,
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
		const { installation, organization } = authorized._yay;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId: args.principal.actorUserId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
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
		// Same storage-layer ownership rule as the write path: only the member who created an owned
		// doc may delete it.
		if (existing.ownership === "owned" && existing.createdBy !== args.principal.actorUserId) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
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
		const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
			actorUserId: args.principal.actorUserId,
			organization,
		});

		await ctx.db.delete("plugins_data", existing._id);
		await db_credit_member_for_delete(ctx, { installation, document: existing });
		const collectionNames = await db_drop_collection_if_empty(ctx, { usage, collection: collection._yay });
		await db_drop_member_collection(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			storedNames: usage.collectionNames,
			nextNames: collectionNames,
		});
		await db_patch_usage(ctx, {
			usage,
			next: {
				usedBytes: usage.usedBytes - existing.byteSize,
				usedDocuments: usage.usedDocuments - 1,
				collectionNames,
			},
			now,
			maxDocumentSlots,
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

// #region user writes

/**
 * Member writes from a plugin frame. Both frame kinds reach these doors: a plugin page and a file
 * view. Only a file-view session sets `fileNodeId`, and nothing in this module reads that field, so
 * a file view writes here exactly as a page does.
 *
 * These are public mutations: the plugin iframe calls them directly, authenticated with its
 * plugin-session JWT (see plugins_ui.ts). The JWT's subject is a `plugins_ui_sessions` id, and
 * the session doc names the member, installation, and version the frame was minted for. Member
 * functions refuse that identity and these doors refuse every other identity, so each side of
 * the boundary answers only its own callers. An invited anonymous member mints frame sessions
 * like any other member, so it may write here too.
 */

/**
 * Prove the frame's member may write this plugin's documents, inside the same transaction as the
 * write. Everything tenant-scoped is derived from the session doc the JWT points at, and every
 * fact is re-read on every call, mirroring `resolve_principal` in public_api.ts: revoking the
 * session, disabling or upgrading the installation, or removing the member closes the door
 * immediately, even while the JWT itself is still signed-valid.
 *
 * The name says page because pages shipped first. This function looks the session doc up by id and
 * never reads its `fileNodeId`, so a file view passes through it too.
 */
async function db_authorize_page_write(
	ctx: MutationCtx,
	args: {
		/**
		 * Append charges the bucket itself, after its replay lookup: a replayed request already
		 * paid on its first call, and a retry refused by the bucket would report a delivered
		 * write as failed.
		 */
		skipRateLimit?: true;
	} = {},
) {
	const pluginSession = await server_convex_get_plugin_session(ctx);
	if (!pluginSession) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	// The session doc is the kill switch: revoke, expiry, uninstall, and account deletion all
	// delete it. Expiry deletes it through a scheduled job that can lag behind the wall clock,
	// so the door also compares expiresAt itself instead of trusting that the doc is gone.
	const session = await ctx.db.get("plugins_ui_sessions", pluginSession.sessionId);
	if (!session || session.expiresAt <= Date.now()) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	// The session dies with its installation: disabling, uninstalling, or upgrading it (an
	// upgrade changes pluginVersionId) revokes every outstanding frame session.
	const installation = await ctx.db.get("plugins_workspace_installations", session.installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== session.pluginVersionId ||
		installation.organizationId !== session.organizationId ||
		installation.workspaceId !== session.workspaceId
	) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	// The page acts on behalf of the minting user: a deleted account or a lost membership closes
	// the door even while the session doc still exists.
	const user = await ctx.db.get("users", session.userId);
	if (!user || user.deletedAt != null) {
		return Result({ _nay: { message: "Unauthorized" } });
	}
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", session.userId)
				.eq("organizationId", session.organizationId)
				.eq("workspaceId", session.workspaceId),
		)
		.first();
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	if (!args.skipRateLimit) {
		// Keyed by user and installation together, so one busy plugin page cannot drain the
		// member's write budget in every other installed plugin.
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_data_page_user_write",
			key: `${session.userId}:${session.installationId}`,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
	}

	// The page acts as the member, so the member must hold workspace content.write, checked the
	// same way `db_authorize` above checks the service principals.
	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", session.organizationId),
		ctx.db.get("organizations_workspaces", session.workspaceId),
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
		permission: "content.write",
		userId: session.userId,
	});
	if (!allowed) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	const version = await ctx.db.get("plugins_versions", session.pluginVersionId);
	if (!version) {
		return Result({ _nay: { message: "Not found" } });
	}
	// Both sides must still say yes on every call: the installed version declares the capability
	// and the workspace accepted it. An upgrade that drops the declaration or a consent change
	// closes the door immediately.
	if (
		!version.capabilities.includes("plugin.data.user-write" satisfies plugins_Capability) ||
		!installation.acceptedCapabilities.includes("plugin.data.user-write" satisfies plugins_Capability)
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	// The organization and the workspace come back because a scope check needs them: a
	// `plugin_scope` grant is looked up per organization and workspace, and the owner short-circuit
	// needs `ownerUserId`. Both were already loaded above, so handing them back costs no read.
	return Result({ _yay: { installation, userId: session.userId, organization, workspace } });
}

/**
 * Refuse taking a key a service producer holds. A live reservation promises the key to its
 * producer, and a tombstone marks a key its producer deleted. A member write on either would
 * squat the producer's key, exactly what the interactive write path refuses too.
 */
async function db_refuse_service_held_key(
	ctx: QueryCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; key: string },
) {
	const [reservation, tombstone] = await Promise.all([db_get_live_reservation(ctx, args), db_get_tombstone(ctx, args)]);
	if (reservation || tombstone) {
		return Result({
			_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
		});
	}

	return Result({ _yay: null });
}

/**
 * Compare-and-set guard shared by the four door mutations below. `expectedRevision` is the
 * revision the caller read before deciding to write, and 0 means the caller expects no document
 * at all — the first stored revision is 1. On a mismatch the caller re-reads and decides again
 * instead of overwriting a write it never saw. Absent means optimistic: the write happens
 * whatever the current revision is, like before the field existed.
 *
 * Delete followed by recreate starts over at revision 1, so a caller can pass this check against
 * a same-revision successor document. The doors accept that: a revision orders writes within one
 * document lifetime, it is not a content hash.
 *
 * The refusal carries no current revision on purpose. This door never proved the caller may read,
 * so the fresh revision must arrive through a read surface, not through a refused write.
 */
function refuse_revision_mismatch(existing: Doc<"plugins_data"> | null, expectedRevision: number | undefined) {
	if (expectedRevision === undefined) {
		return Result({ _yay: null });
	}
	if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
		return Result({ _nay: { message: "Expected revisions must be non-negative integers" } });
	}
	if ((existing?.revision ?? 0) !== expectedRevision) {
		return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document changed since it was read" } });
	}

	return Result({ _yay: null });
}

/**
 * One accepted door write: price it, store it, and update the accounting doc in this transaction.
 * The caller has already authorized the member and refused every conflicting key state, so this
 * only enforces the capacity ceilings.
 */
async function db_user_write_document(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		organization: Pick<Doc<"organizations">, "default" | "billingMode" | "ownerUserId">;
		userId: Id<"users">;
		existing: Doc<"plugins_data"> | null;
		collection: string;
		key: string;
		value: Record<string, unknown>;
		byteSize: number;
		ownership: "shared" | "owned";
		userWrite?: { requestId: string; requestFingerprint: string };
	},
) {
	const now = Date.now();
	const usage = await db_get_usage(ctx, args.installation._id);
	const addsCollection = !(usage?.collectionNames ?? []).includes(args.collection);
	const memberUsage = await db_get_member_usage(ctx, {
		installationId: args.installation._id,
		userId: args.userId,
	});
	const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
		actorUserId: args.userId,
		organization: args.organization,
	});
	const capacity = check_capacity(
		usage,
		{
			addedBytes: args.byteSize - (args.existing?.byteSize ?? 0),
			addedSlots: args.existing ? 0 : 1,
			addedCollections: addsCollection ? 1 : 0,
		},
		maxDocumentSlots,
		{
			usage: memberUsage,
			change: member_capacity_change({
				existing: args.existing,
				writer: args.userId,
				addsCollection,
				byteSize: args.byteSize,
			}),
		},
	);
	if (capacity._nay) {
		return capacity;
	}

	await db_write_document(ctx, {
		actorUserId: args.userId,
		installation: args.installation,
		existing: args.existing,
		collection: args.collection,
		key: args.key,
		value: args.value,
		byteSize: args.byteSize,
		ownership: args.ownership,
		userWrite: args.userWrite,
		chargedTo: args.userId,
		now,
	});

	for (const delta of member_usage_deltas({
		writer: args.userId,
		existing: args.existing,
		collection: args.collection,
		addsCollection,
		byteSize: args.byteSize,
	})) {
		await db_patch_member_usage(ctx, { installation: args.installation, ...delta });
	}

	const storedUsage = usage ?? (await db_create_usage(ctx, { installation: args.installation, now }));
	await db_patch_usage(ctx, {
		usage: storedUsage,
		next: {
			usedBytes: storedUsage.usedBytes + args.byteSize - (args.existing?.byteSize ?? 0),
			usedDocuments: storedUsage.usedDocuments + (args.existing ? 0 : 1),
			collectionNames: addsCollection
				? [...storedUsage.collectionNames, args.collection]
				: storedUsage.collectionNames,
		},
		now,
		maxDocumentSlots,
	});

	return Result({ _yay: { revision: (args.existing?.revision ?? 0) + 1, byteSize: args.byteSize } });
}

/**
 * One accepted door delete, with the same accounting as the interactive delete.
 */
async function db_user_delete_document(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		organization: Pick<Doc<"organizations">, "default" | "billingMode" | "ownerUserId">;
		actorUserId: Id<"users">;
		existing: Doc<"plugins_data">;
	},
) {
	const now = Date.now();
	// A stored document was created by a write path that always writes the accounting doc in the
	// same transaction, so it exists here.
	const usage = await db_get_usage(ctx, args.installation._id);
	if (!usage) {
		const errorMessage = "Plugin data document without a usage doc";
		const errorData = { documentId: args.existing._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	await ctx.db.delete("plugins_data", args.existing._id);
	await db_credit_member_for_delete(ctx, { installation: args.installation, document: args.existing });
	const collectionNames = await db_drop_collection_if_empty(ctx, { usage, collection: args.existing.collection });
	await db_drop_member_collection(ctx, {
		installationId: args.installation._id,
		collection: args.existing.collection,
		storedNames: usage.collectionNames,
		nextNames: collectionNames,
	});
	await db_patch_usage(ctx, {
		usage,
		next: {
			usedBytes: usage.usedBytes - args.existing.byteSize,
			usedDocuments: usage.usedDocuments - 1,
			collectionNames,
		},
		now,
		maxDocumentSlots: await db_resolve_document_slot_cap(ctx, {
			actorUserId: args.actorUserId,
			organization: args.organization,
		}),
	});
}

export const user_append_document = mutation({
	args: {
		collection: v.string(),
		keyPrefix: v.optional(v.string()),
		value: v.record(v.string(), v.any()),
		clientRequestId: v.string(),
	},
	returns: v_result({ _yay: v.object({ key: v.string(), revision: v.number(), byteSize: v.number() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx, { skipRateLimit: true });
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization } = authorized._yay;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const clientRequestId = validate_name(args.clientRequestId, "Idempotency keys");
		if (clientRequestId._nay) {
			return clientRequestId;
		}
		const keyPrefix = args.keyPrefix === undefined ? Result({ _yay: "" }) : validate_key_prefix(args.keyPrefix);
		if (keyPrefix._nay) {
			return keyPrefix;
		}
		const byteSize = validate_value(args.value);
		if (byteSize._nay) {
			return byteSize;
		}

		// The same request replayed after a lost response must answer with the key the first call
		// stored, and a different request under the same idempotency key must be refused rather than
		// quietly appending a second document. The value can be large, so the doc keeps a digest of
		// the request instead of the request itself.
		const requestFingerprint = await crypto_sha256_hex(
			canonical_json({
				collection: collection._yay,
				keyPrefix: keyPrefix._yay,
				ownership: "owned",
				value: args.value,
			}),
		);
		const replay = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_createdBy_requestId", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("collection", collection._yay)
					.eq("createdBy", userId)
					.eq("userWriteRequestId", clientRequestId._yay),
			)
			.first();
		if (replay) {
			if (replay.userWriteRequestFingerprint !== requestFingerprint) {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This idempotency key was already used for a different write" },
				});
			}

			return Result({ _yay: { key: replay.key, revision: replay.revision, byteSize: replay.byteSize } });
		}

		// Only a genuinely new append charges the bucket; the replay above answered without paying
		// twice for one delivered write.
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_data_page_user_write",
			key: `${userId}:${installation._id}`,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		// Two appends in the same millisecond can draw the same suffix, and a duplicate key would
		// break the one-doc-per-key rule every `.first()` lookup relies on. So probe the candidate
		// and draw a fresh suffix on a hit. A key a service producer holds is avoided the same way.
		const invertedMs = String(APPEND_KEY_MS_CEILING - Date.now()).padStart(13, "0");
		let key: string | null = null;
		for (let attempt = 0; attempt < 3 && key === null; attempt += 1) {
			const candidate = `${keyPrefix._yay}${invertedMs}:${crypto_random_hex(2)}`;
			const [document, serviceHeld] = await Promise.all([
				db_get_document(ctx, { installationId: installation._id, collection: collection._yay, key: candidate }),
				db_refuse_service_held_key(ctx, {
					installationId: installation._id,
					collection: collection._yay,
					key: candidate,
				}),
			]);
			if (!document && !serviceHeld._nay) {
				key = candidate;
			}
		}
		if (key === null) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "Could not assign a unique key, try again" } });
		}

		// Checked on the key that will really be stored, not on the caller's prefix: a scope may cover
		// only part of a prefix, and the prefix itself is never written.
		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId,
			collection: collection._yay,
			key,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

		const written = await db_user_write_document(ctx, {
			installation,
			organization,
			userId,
			existing: null,
			collection: collection._yay,
			key,
			value: args.value,
			byteSize: byteSize._yay,
			ownership: "owned",
			userWrite: { requestId: clientRequestId._yay, requestFingerprint },
		});
		if (written._nay) {
			return written;
		}

		return Result({ _yay: { key, revision: written._yay.revision, byteSize: written._yay.byteSize } });
	},
});

export const user_put_document = mutation({
	args: {
		collection: v.string(),
		key: v.string(),
		value: v.record(v.string(), v.any()),
		expectedRevision: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ revision: v.number(), byteSize: v.number() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx);
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization } = authorized._yay;

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

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		// A versioned key belongs to a producer's ordered outbox, exactly like the interactive path.
		if (existing?.writeMode === "versioned") {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}
		// The target decides: a shared doc takes any member's put, an owned doc only its creator's.
		if (existing?.ownership === "owned" && existing.createdBy !== userId) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		// CAS after ownership: a writer refused for the doc's ownership hears that refusal whatever
		// revision they guess, so the guess cannot change which refusal comes back.
		const revisionMismatch = refuse_revision_mismatch(existing, args.expectedRevision);
		if (revisionMismatch._nay) {
			return revisionMismatch;
		}
		if (!existing) {
			const serviceHeld = await db_refuse_service_held_key(ctx, {
				installationId: installation._id,
				collection: collection._yay,
				key: key._yay,
			});
			if (serviceHeld._nay) {
				return serviceHeld;
			}
		}

		// A put on an absent key creates a shared doc. Owned docs are only created by append and
		// putOwned, whose keys carry the creator's identity.
		return await db_user_write_document(ctx, {
			installation,
			organization,
			userId,
			existing,
			collection: collection._yay,
			key: key._yay,
			value: args.value,
			byteSize: byteSize._yay,
			ownership: "shared",
		});
	},
});

export const user_remove_document = mutation({
	args: {
		collection: v.string(),
		key: v.string(),
		expectedRevision: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ deleted: v.boolean() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx);
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization } = authorized._yay;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});
		if (existing?.writeMode === "versioned") {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This document is written by a service and cannot be changed here" },
			});
		}
		if (!existing) {
			// An absent doc still answers the revision guess: expecting a live revision of a doc that
			// is gone means the doc changed since it was read. Expecting 0 or nothing keeps the
			// idempotent "already deleted" answer.
			const revisionMismatch = refuse_revision_mismatch(null, args.expectedRevision);
			if (revisionMismatch._nay) {
				return revisionMismatch;
			}
			return Result({ _yay: { deleted: false } });
		}
		// The target decides, like the put above: an owned doc is only removed by its creator.
		if (existing.ownership === "owned" && existing.createdBy !== userId) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		const revisionMismatch = refuse_revision_mismatch(existing, args.expectedRevision);
		if (revisionMismatch._nay) {
			return revisionMismatch;
		}

		await db_user_delete_document(ctx, { installation, organization, actorUserId: userId, existing });
		return Result({ _yay: { deleted: true } });
	},
});

export const user_put_owned_document = mutation({
	args: {
		collection: v.string(),
		key: v.string(),
		value: v.record(v.string(), v.any()),
		expectedRevision: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ key: v.string(), revision: v.number(), byteSize: v.number() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx);
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization } = authorized._yay;

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

		// The server appends the acting member's id, so identity inside the key can never be forged.
		// A `:` smuggled into the caller's key just stays part of the caller's key.
		const storedKey = `${key._yay}:${userId}`;
		if (storedKey.length > plugins_data_MAX_NAME_LENGTH) {
			return Result({
				_nay: { message: `Keys must be at most ${plugins_data_MAX_NAME_LENGTH} characters after the writer id is appended` },
			});
		}

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId,
			collection: collection._yay,
			key: storedKey,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: storedKey,
		});
		// Only the member's own owned doc may sit at the composed key. Anything else there — a shared
		// doc squatting the key, a service doc, another creator's doc — refuses.
		if (existing && (existing.ownership !== "owned" || existing.createdBy !== userId)) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		// CAS after ownership, like the put above.
		const revisionMismatch = refuse_revision_mismatch(existing, args.expectedRevision);
		if (revisionMismatch._nay) {
			return revisionMismatch;
		}
		if (!existing) {
			const serviceHeld = await db_refuse_service_held_key(ctx, {
				installationId: installation._id,
				collection: collection._yay,
				key: storedKey,
			});
			if (serviceHeld._nay) {
				return serviceHeld;
			}
		}

		const written = await db_user_write_document(ctx, {
			installation,
			organization,
			userId,
			existing,
			collection: collection._yay,
			key: storedKey,
			value: args.value,
			byteSize: byteSize._yay,
			ownership: "owned",
		});
		if (written._nay) {
			return written;
		}

		return Result({ _yay: { key: storedKey, revision: written._yay.revision, byteSize: written._yay.byteSize } });
	},
});

export const user_remove_owned_document = mutation({
	args: {
		collection: v.string(),
		key: v.string(),
		expectedRevision: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ deleted: v.boolean() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx);
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization } = authorized._yay;

		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return collection;
		}
		const key = validate_name(args.key, "Keys");
		if (key._nay) {
			return key;
		}

		const storedKey = `${key._yay}:${userId}`;
		if (storedKey.length > plugins_data_MAX_NAME_LENGTH) {
			return Result({
				_nay: { message: `Keys must be at most ${plugins_data_MAX_NAME_LENGTH} characters after the writer id is appended` },
			});
		}

		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId,
			collection: collection._yay,
			key: storedKey,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
		}

		const existing = await db_get_document(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: storedKey,
		});
		if (!existing) {
			// Same absent-doc rule as the shared remove above.
			const revisionMismatch = refuse_revision_mismatch(null, args.expectedRevision);
			if (revisionMismatch._nay) {
				return revisionMismatch;
			}
			return Result({ _yay: { deleted: false } });
		}
		// Same rule as the put above: only the member's own owned doc may sit at the composed key.
		if (existing.ownership !== "owned" || existing.createdBy !== userId) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This document belongs to another writer" } });
		}
		const revisionMismatch = refuse_revision_mismatch(existing, args.expectedRevision);
		if (revisionMismatch._nay) {
			return revisionMismatch;
		}

		await db_user_delete_document(ctx, { installation, organization, actorUserId: userId, existing });
		return Result({ _yay: { deleted: true } });
	},
});

// #endregion user writes

// #region scopes

/**
 * Where one scope's permission grants live.
 *
 * The installation is part of the id because two installations may mint the same scope id, and a
 * grant must never cross from one to the other.
 */
function scope_resource_id(installationId: Id<"plugins_workspace_installations">, scopeId: string) {
	return `${installationId}:${scopeId}`;
}

/**
 * The private scope a key falls in, or null when the key is in the public part of the collection.
 *
 * One indexed read answers it. Walking scope prefixes downwards from the key gives the greatest
 * prefix that is not above the key, and that row is the only one that can match: any other prefix
 * sitting between a real match and the key would have to start with that match, and the create door
 * refuses a prefix that overlaps another. So if the first row is not a prefix of the key, no row is.
 *
 * Every writer goes through here rather than being handed a scope, so a new write path cannot
 * quietly put a public document inside a private range.
 */
async function db_resolve_scope(
	ctx: QueryCtx | MutationCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; key: string },
) {
	const candidate = await ctx.db
		.query("plugins_data_scopes")
		.withIndex("by_installation_collection_prefix", (q) =>
			q.eq("installationId", args.installationId).eq("collection", args.collection).lte("keyPrefix", args.key),
		)
		.order("desc")
		.first();

	return candidate && args.key.startsWith(candidate.keyPrefix) ? candidate : null;
}

/**
 * Another scope whose key range touches this one, or null when the range is free.
 *
 * Two reads, because overlap has two shapes. An existing prefix may sit above the new one — read
 * prefixes downwards from it and test the first, the same walk `db_resolve_scope` explains. Or an
 * existing prefix may sit inside the new one — read the new prefix's own range forwards.
 */
async function db_find_overlapping_scope(
	ctx: QueryCtx | MutationCtx,
	args: { installationId: Id<"plugins_workspace_installations">; collection: string; keyPrefix: string },
) {
	const above = await db_resolve_scope(ctx, {
		installationId: args.installationId,
		collection: args.collection,
		key: args.keyPrefix,
	});
	if (above) {
		return above;
	}

	return await ctx.db
		.query("plugins_data_scopes")
		.withIndex("by_installation_collection_prefix", (q) =>
			q
				.eq("installationId", args.installationId)
				.eq("collection", args.collection)
				.gte("keyPrefix", args.keyPrefix)
				.lt("keyPrefix", key_prefix_upper_bound(args.keyPrefix)),
		)
		.first();
}

/**
 * Whether one member may read or write inside one scope.
 *
 * Every read door asks this before it scans a scope's key range, and every write door asks it before
 * it touches a key. The organization is loaded here so the doors do not each carry the same three ids
 * around.
 */
async function db_can_use_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		scopeId: string;
		userId: Id<"users">;
		permission: access_control_Permission;
	},
) {
	const organization = await ctx.db.get("organizations", args.installation.organizationId);
	if (!organization?.defaultWorkspaceId) {
		return false;
	}

	return await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: args.installation.workspaceId,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "plugin_scope", id: scope_resource_id(args.installation._id, args.scopeId) },
		permission: args.permission,
		userId: args.userId,
	});
}

/**
 * Prove a member may write at one key, given the scope that key falls in.
 *
 * A public key needs nothing beyond the workspace write the door already checked. A key inside a
 * scope needs a grant on that exact scope, and a role gives nothing there.
 *
 * Every write door asks this, not only the ones a plugin frame reaches. An API key writes as the
 * member who minted it and a backend run writes as the member who triggered it, so a member outside
 * a private channel could otherwise inject documents into it over HTTP — they could not read the
 * channel back, but the message would be there.
 *
 * Ask it before the first write of a batch, never inside the loop. A Convex mutation that returns a
 * refusal after it has already inserted keeps those inserts.
 */
async function db_refuse_scoped_write(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		userId: Id<"users">;
		collection: string;
		key: string;
	},
) {
	const scope = await db_resolve_scope(ctx, {
		installationId: args.installation._id,
		collection: args.collection,
		key: args.key,
	});
	if (!scope) {
		return Result({ _yay: null });
	}

	const allowed = await db_can_use_scope(ctx, {
		installation: args.installation,
		scopeId: scope.scopeId,
		userId: args.userId,
		permission: "content.write",
	});
	if (!allowed) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: null });
}

/**
 * What each scope level hands out, one grant document per permission, like file sharing.
 *
 * `member` reads and writes inside the scope. `manage` adds the right to change who else is in it,
 * and that third permission is the one the lifecycle mutation checks before it touches another
 * principal's grants.
 */
const SCOPE_LEVEL_PERMISSIONS = {
	member: ["content.read", "content.write"],
	manage: ["content.read", "content.write", "content.permissions.manage"],
} as const satisfies Record<string, readonly access_control_Permission[]>;

type plugins_data_ScopeLevel = keyof typeof SCOPE_LEVEL_PERMISSIONS;

/**
 * Every user grant on one scope.
 *
 * Read one document past the cap so a full page proves there is more, the way file sharing counts
 * its own principals.
 */
function db_scope_grants(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceId: string;
	},
) {
	return ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", "plugin_scope")
				.eq("resourceId", args.resourceId)
				.eq("principalKind", "user"),
		)
		.take(MAX_SCOPE_PRINCIPALS * SCOPE_LEVEL_PERMISSIONS.manage.length + 1);
}

/**
 * Refuse when one member is already named in as many scopes as they may hold.
 *
 * Counts scopes and not grant rows: one member holds several rows per scope, and a cap on rows
 * would change meaning the day a level gains a permission. `exceptResourceId` is the scope being
 * changed, so raising or lowering somebody already in it never counts as one more.
 */
async function db_refuse_member_scope_cap(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		exceptResourceId?: string;
	},
) {
	const grants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_user_organization_workspace_resource_permission", (q) =>
			q
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", "plugin_scope"),
		)
		.take(MAX_SCOPES_PER_MEMBER * SCOPE_LEVEL_PERMISSIONS.manage.length + 1);

	const scopes = new Set(grants.map((grant) => grant.resourceId));
	if (args.exceptResourceId !== undefined) {
		scopes.delete(args.exceptResourceId);
	}
	if (scopes.size >= MAX_SCOPES_PER_MEMBER) {
		return Result({
			_nay: {
				message: `This member is already in ${MAX_SCOPES_PER_MEMBER} private scopes, which is the most they can be in. Delete one first.`,
			},
		});
	}

	return Result({ _yay: null });
}

/**
 * Replace one principal's grants on one scope.
 *
 * Delete first and insert after, so lowering `manage` to `member` really drops
 * `content.permissions.manage` instead of leaving the old row beside the new ones. A null level
 * removes the principal.
 */
async function db_set_scope_principal(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceId: string;
		userId: Id<"users">;
		level: plugins_data_ScopeLevel | null;
		now: number;
	},
) {
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", "plugin_scope")
				.eq("resourceId", args.resourceId)
				.eq("principalKind", "user")
				.eq("userId", args.userId),
		)
		.take(SCOPE_LEVEL_PERMISSIONS.manage.length + 1);
	await Promise.all(existing.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)));

	if (args.level === null) {
		return;
	}

	await Promise.all(
		SCOPE_LEVEL_PERMISSIONS[args.level].map((permission) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				resourceKind: "plugin_scope",
				resourceId: args.resourceId,
				principalKind: "user",
				userId: args.userId,
				permission,
				createdAt: args.now,
				updatedAt: args.now,
			}),
		),
	);
}

/**
 * Delete a scope and every grant on it, in one transaction.
 *
 * One scope holds one row per collection it covers, and all of them go. A row left behind would keep
 * its own collection's key range private with no grant able to reach it.
 *
 * The grants have to go too. A scope id is minted by the plugin and stored only on the scope
 * documents, so once they are gone nothing can find the leftover grants to remove them, and they
 * would count against their holders' cap forever.
 */
async function db_delete_scope(ctx: MutationCtx, scopes: Doc<"plugins_data_scopes">[]) {
	const first = scopes[0];
	const grants = await db_scope_grants(ctx, {
		organizationId: first.organizationId,
		workspaceId: first.workspaceId,
		resourceId: scope_resource_id(first.installationId, first.scopeId),
	});
	await Promise.all(grants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)));
	await Promise.all(scopes.map((scope) => ctx.db.delete("plugins_data_scopes", scope._id)));
}

/**
 * Create a private scope, change who is in it, or delete it.
 *
 * One mutation owns the whole lifecycle, the way `files_sharing.set_node_share_grant` both inserts
 * and deletes its grants. Splitting the growth path from the shrink path is how a share list ends
 * up append-only: a member can add a colleague and then has no door to remove them.
 *
 * Creating a scope names every collection it covers, and the key prefix is the same in all of them.
 * That is one scope against the member's cap for one private area, however many collections the
 * plugin spreads it over. Every named collection is checked before anything is written, so a scope
 * is never created over half of its own range.
 *
 * Who may do what: creating a scope needs the same workspace write the other member doors need, and
 * the creator gets the first `manage` grant. Everything after that needs a `manage` grant on that
 * exact scope. A role's own permissions give nothing here — that is what makes the scope private —
 * so an admin who was never named cannot add themselves.
 *
 * The organization owner still passes every check. That is deliberate, and it is the plugin's job to
 * say so in its own copy: a feature that says "private" while the owner reads everything is a
 * disclosure, not a bug.
 *
 * Only user principals are ever written. A role principal would hand the scope to everybody holding
 * that role, and it would also make the role undeletable: `delete_role` refuses on the first role
 * grant of any kind and names a file-share dialog that cannot reach a plugin scope.
 */
export const user_manage_scope = mutation({
	args: {
		action: v.union(
			v.object({
				kind: v.literal("create"),
				scopeId: v.string(),
				collections: v.array(v.string()),
				keyPrefix: v.string(),
			}),
			v.object({
				kind: v.literal("set_principal"),
				scopeId: v.string(),
				userId: v.id("users"),
				level: v.union(v.literal("member"), v.literal("manage")),
			}),
			v.object({ kind: v.literal("remove_principal"), scopeId: v.string(), userId: v.id("users") }),
			v.object({ kind: v.literal("delete"), scopeId: v.string() }),
		),
	},
	returns: v_result({ _yay: v.object({ scopeId: v.string() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_write(ctx);
		if (authorized._nay) {
			return authorized;
		}
		const { installation, userId, organization, workspace } = authorized._yay;
		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const scopeId = validate_name(args.action.scopeId, "Scope ids");
		if (scopeId._nay) {
			return scopeId;
		}

		const existing = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) => q.eq("installationId", installation._id).eq("scopeId", scopeId._yay))
			.take(MAX_COLLECTIONS + 1);

		const now = Date.now();
		const resourceId = scope_resource_id(installation._id, scopeId._yay);

		if (args.action.kind === "create") {
			// Held in a local because the checks below read it inside callbacks, where TypeScript no
			// longer remembers which branch of the action union this is.
			const requestedPrefix = args.action.keyPrefix;
			const requested = [...new Set(args.action.collections)].sort();
			if (requested.length === 0) {
				return Result({ _nay: { message: "Name at least one collection for this scope" } });
			}
			if (requested.length > MAX_COLLECTIONS) {
				return Result({ _nay: { message: `One scope can cover at most ${MAX_COLLECTIONS} collections` } });
			}

			// Creating the same scope twice is what a retried request looks like, so answer yes instead
			// of an error. The same id over a different key range is a real mistake and is refused.
			if (existing.length > 0) {
				const covered = [...new Set(existing.map((scope) => scope.collection))].sort();
				const sameRange =
					existing.every((scope) => scope.keyPrefix === requestedPrefix) &&
					covered.length === requested.length &&
					covered.every((collection, index) => collection === requested[index]);
				if (!sameRange) {
					return Result({
						_nay: { name: REFUSAL_CONFLICT, message: "This scope id already covers a different key range" },
					});
				}
				return Result({ _yay: { scopeId: scopeId._yay } });
			}

			const collections: string[] = [];
			for (const raw of requested) {
				const collection = validate_name(raw, "Collection names");
				if (collection._nay) {
					return collection;
				}
				collections.push(collection._yay);
			}
			const keyPrefix = validate_key_prefix(requestedPrefix);
			if (keyPrefix._nay) {
				return keyPrefix;
			}

			for (const collection of collections) {
				// Two scopes may not overlap. That is what lets one indexed read resolve a key's scope:
				// with no overlaps the greatest prefix at or below a key is the only one that can match
				// it. Overlap is per collection, because a scope only owns the range in the collections
				// it names.
				const overlapping = await db_find_overlapping_scope(ctx, {
					installationId: installation._id,
					collection,
					keyPrefix: keyPrefix._yay,
				});
				if (overlapping) {
					return Result({
						_nay: { name: REFUSAL_CONFLICT, message: "Another scope already covers part of this key range" },
					});
				}

				// The range has to be empty. A document written before the scope existed would carry no
				// scope id, so it would stay readable by the whole workspace inside a range that now
				// claims to be private. It also closes the way back in after a delete: the scope's old
				// documents are still there, so the same range cannot be claimed again and handed to
				// somebody else.
				const occupant = await ctx.db
					.query("plugins_data")
					.withIndex("by_installation_collection_key", (q) =>
						q
							.eq("installationId", installation._id)
							.eq("collection", collection)
							.gte("key", keyPrefix._yay)
							.lt("key", key_prefix_upper_bound(keyPrefix._yay)),
					)
					.first();
				if (occupant) {
					return Result({
						_nay: { name: REFUSAL_CONFLICT, message: "This key range already holds documents" },
					});
				}
			}

			const capReached = await db_refuse_member_scope_cap(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				userId,
			});
			if (capReached._nay) {
				return capReached;
			}

			await Promise.all(
				collections.map((collection) =>
					ctx.db.insert("plugins_data_scopes", {
						organizationId: organization._id,
						workspaceId: workspace._id,
						installationId: installation._id,
						scopeId: scopeId._yay,
						collection,
						keyPrefix: keyPrefix._yay,
						createdByUserId: userId,
						createdAt: now,
						updatedAt: now,
					}),
				),
			);
			// The creator has to stay in. A role gives nothing inside a scope, so without this the
			// member would create a private channel and lose it in the same call.
			await db_set_scope_principal(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				resourceId,
				userId,
				level: "manage",
				now,
			});
			return Result({ _yay: { scopeId: scopeId._yay } });
		}

		if (existing.length === 0) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Everything below changes who is in the scope, so it needs a `manage` grant on this exact
		// scope. For a `plugin_scope` resource that answer comes from the grant alone, so holding the
		// workspace-wide permission is not enough.
		const canManage = await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "plugin_scope", id: resourceId },
			permission: "content.permissions.manage",
			userId,
		});
		if (!canManage) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (args.action.kind === "delete") {
			await db_delete_scope(ctx, existing);
			return Result({ _yay: { scopeId: scopeId._yay } });
		}

		const target = args.action.userId;

		if (args.action.kind === "remove_principal") {
			// A scope with nobody left in it can never be reached again, and nothing could delete it.
			// So the last manager deletes the scope instead of removing their own grants.
			if (target === userId) {
				return Result({ _nay: { message: "Delete the scope instead of removing yourself from it" } });
			}
			await db_set_scope_principal(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				resourceId,
				userId: target,
				level: null,
				now,
			});
			return Result({ _yay: { scopeId: scopeId._yay } });
		}

		// Only a live member of this workspace may be named. Otherwise a frame could hand a scope to
		// any user id it invented, including one from another organization.
		const targetMembership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", target)
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId),
			)
			.first();
		if (!targetMembership) {
			return Result({ _nay: { message: "Not found" } });
		}

		const grants = await db_scope_grants(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			resourceId,
		});
		const principals = new Set(grants.map((grant) => grant.userId));
		if (!principals.has(target) && principals.size >= MAX_SCOPE_PRINCIPALS) {
			return Result({ _nay: { message: `One scope can name at most ${MAX_SCOPE_PRINCIPALS} people` } });
		}

		const targetCap = await db_refuse_member_scope_cap(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			userId: target,
			exceptResourceId: resourceId,
		});
		if (targetCap._nay) {
			return targetCap;
		}

		await db_set_scope_principal(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			resourceId,
			userId: target,
			level: args.action.level,
			now,
		});
		return Result({ _yay: { scopeId: scopeId._yay } });
	},
});

/**
 * Who is in one private scope.
 *
 * The plugin's own share dialog needs this. Without a read door a member can add somebody to a
 * private channel and can never see or change the list afterwards, which is the append-only shape
 * `user_manage_scope` was built to avoid.
 *
 * A caller who is not in the scope gets null, the same answer as a scope that was never created. A
 * refusal that said "you may not see this one" would name a private channel to somebody it is
 * hidden from.
 *
 * There is no `truncated` flag because there is nothing to truncate: `user_manage_scope` refuses the
 * principal past `MAX_SCOPE_PRINCIPALS`, and `db_scope_grants` reads every row those principals can
 * hold.
 */
export const watch_scope_principals = query({
	args: { scopeId: v.string() },
	returns: v.union(
		v.array(v.object({ userId: v.id("users"), level: v.union(v.literal("member"), v.literal("manage")) })),
		v.null(),
	),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized || !db_page_grants(authorized, "plugin.data.read")) {
			return null;
		}
		const installation = authorized.installation;

		const scopeId = validate_name(args.scopeId, "Scope ids");
		if (scopeId._nay) {
			return null;
		}
		const scope = await ctx.db
			.query("plugins_data_scopes")
			.withIndex("by_installation_scope", (q) => q.eq("installationId", installation._id).eq("scopeId", scopeId._yay))
			.first();
		if (!scope) {
			return null;
		}
		if (!(await db_can_use_scope(ctx, { installation, scopeId: scopeId._yay, userId: authorized.userId, permission: "content.read" }))) {
			return null;
		}

		const grants = await db_scope_grants(ctx, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			resourceId: scope_resource_id(installation._id, scopeId._yay),
		});

		// One grant row per permission, so fold the rows back into the level that issued them. Manage
		// is the only permission `member` does not carry, so it decides the level whichever order the
		// rows arrive in.
		const levels = new Map<Id<"users">, "member" | "manage">();
		for (const grant of grants) {
			if (!grant.userId) {
				continue;
			}
			if (grant.permission === "content.permissions.manage") {
				levels.set(grant.userId, "manage");
			} else if (!levels.has(grant.userId)) {
				levels.set(grant.userId, "member");
			}
		}

		return [...levels].map(([userId, level]) => ({ userId, level }));
	},
});

/**
 * The private scopes this member is in.
 *
 * A read with no key range answers only the public part of a collection. So a plugin that keeps
 * private documents beside public ones cannot find them again on its own: the plugin mints the scope
 * id, and from then on it lives only inside the range it hides. Without this door a member creates a
 * private channel and it disappears from the list, for everybody including the person who made it.
 * The frame reads this first, then opens one ranged read per scope beside its public one.
 *
 * Listing follows the grant, not the workspace. The organization owner may read every scope, but
 * only the scopes they were added to are listed here. A private channel nobody invited them to stays
 * out of their own list, which is what the product copy promises.
 *
 * There is no `truncated` flag because there is nothing to truncate: `user_manage_scope` refuses to
 * put a member in more than `MAX_SCOPES_PER_MEMBER` scopes across the whole workspace, so another
 * plugin minting its own scopes cannot push this installation's grants past the read below. One scope
 * holds at most `MAX_COLLECTIONS` rows.
 */
export const watch_my_scopes = query({
	args: {},
	returns: v.union(
		v.array(
			v.object({
				scopeId: v.string(),
				keyPrefix: v.string(),
				collections: v.array(v.string()),
				level: v.union(v.literal("member"), v.literal("manage")),
			}),
		),
		v.null(),
	),
	handler: async (ctx) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized || !db_page_grants(authorized, "plugin.data.read")) {
			return null;
		}
		const installation = authorized.installation;

		const grants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_user_organization_workspace_resource_permission", (q) =>
				q
					.eq("userId", authorized.userId)
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("resourceKind", "plugin_scope"),
			)
			.take(MAX_SCOPES_PER_MEMBER * SCOPE_LEVEL_PERMISSIONS.manage.length + 1);

		// One grant row per permission, folded back into the level that issued them, the same way
		// `watch_scope_principals` does it. Another installation in this workspace mints its own scope
		// ids, so the resource id prefix is what keeps that installation's scopes out of this answer.
		const resourceIdPrefix = `${installation._id}:`;
		const levels = new Map<string, plugins_data_ScopeLevel>();
		for (const grant of grants) {
			if (!grant.resourceId.startsWith(resourceIdPrefix)) {
				continue;
			}
			const scopeId = grant.resourceId.slice(resourceIdPrefix.length);
			if (grant.permission === "content.permissions.manage") {
				levels.set(scopeId, "manage");
			} else if (!levels.has(scopeId)) {
				levels.set(scopeId, "member");
			}
		}

		const scopes = await Promise.all(
			[...levels].map(async ([scopeId, level]) => {
				const rows = await ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) =>
						q.eq("installationId", installation._id).eq("scopeId", scopeId),
					)
					.take(MAX_COLLECTIONS);
				const [first] = rows;
				if (!first) {
					// A grant lives exactly as long as its scope rows: `db_delete_scope` removes both in
					// the same mutation. So this only answers TypeScript.
					return null;
				}

				// Every row of one scope carries the same prefix, so the first row answers for all of them.
				return {
					scopeId,
					keyPrefix: first.keyPrefix,
					collections: rows.map((row) => row.collection).sort(),
					level,
				};
			}),
		);

		return scopes.filter((scope) => scope !== null).sort((a, b) => a.scopeId.localeCompare(b.scopeId));
	},
});

// #endregion scopes

// #region user reads

/**
 * Member reads from a plugin frame. Both frame kinds reach these doors, the same way they reach the
 * write doors above: a plugin page and a file view.
 *
 * These are public queries: the plugin iframe subscribes to them directly with its plugin-session
 * JWT (see plugins_ui.ts). Their answer is also the kill signal: the query throws only when there
 * is no auth identity at all, and answers null for every denial, so a revoked frame sees its
 * subscription die instead of an error.
 *
 * The server deliberately does not cap live subscriptions per session. Convex gives a query no
 * subscribe hook to count against, so a hostile frame that talks to Convex directly can open more
 * subscriptions than the SDK's own per-frame caps allow. Those caps live inside one SDK client
 * closure and each mounted frame builds its own client, so they bound a frame and never a member or
 * an installation. Accepted risk: it is bounded only by the 30-minute session TTL and revocation,
 * and stays on the ask list for the Convex team.
 */

/**
 * Prove the frame's member may read this plugin's documents. Everything tenant-scoped is derived
 * from the session doc the JWT points at, mirroring `resolve_principal` in public_api.ts. Reading
 * the session, installation, and membership docs inside the query is what makes a revocation
 * re-run every live subscription into null.
 *
 * Named for pages for the same reason as the write door above, and open to a file view in the same
 * way: the session doc is loaded by id and its `fileNodeId` is never read.
 */
async function db_authorize_page_read(ctx: QueryCtx) {
	const pluginSession = await server_convex_get_plugin_session(ctx);
	// A caller with no identity at all is misconfigured and hears an error. Any authenticated
	// caller that is not a plugin session hears null, like every other denial below.
	if (!pluginSession) {
		const identity = await ctx.auth.getUserIdentity().catch(() => null);
		if (!identity) {
			throw convex_error({ message: "Unauthenticated" });
		}
		return null;
	}
	const session = await ctx.db.get("plugins_ui_sessions", pluginSession.sessionId);
	if (!session || session.expiresAt <= Date.now()) {
		return null;
	}

	// Same liveness chain as the write door above, with null in place of every refusal.
	const installation = await ctx.db.get("plugins_workspace_installations", session.installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== session.pluginVersionId ||
		installation.organizationId !== session.organizationId ||
		installation.workspaceId !== session.workspaceId
	) {
		return null;
	}
	const user = await ctx.db.get("users", session.userId);
	if (!user || user.deletedAt != null) {
		return null;
	}
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", session.userId)
				.eq("organizationId", session.organizationId)
				.eq("workspaceId", session.workspaceId),
		)
		.first();
	if (!membership) {
		return null;
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", session.organizationId),
		ctx.db.get("organizations_workspaces", session.workspaceId),
	]);
	if (!organization?.defaultWorkspaceId || !workspace || workspace.organizationId !== organization._id) {
		return null;
	}
	const allowed = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "workspace", id: String(workspace._id) },
		permission: "content.read",
		userId: session.userId,
	});
	if (!allowed) {
		return null;
	}

	const version = await ctx.db.get("plugins_versions", session.pluginVersionId);
	if (!version) {
		return null;
	}

	// The capability the frame needs depends on which door it knocked on, so each door asks
	// `db_page_grants` for its own. Reading documents gates on the read capability alone: a plugin
	// without the user-write door can still show its documents.
	//
	// `userId` comes back because a private scope is judged per member, not per installation.
	return { installation, version, userId: session.userId };
}

/**
 * Ask whether this frame may use one capability right now.
 *
 * Both sides must still say yes on every call, like the write door: the installed version declares
 * the capability and the workspace accepted it. An upgrade rewrites `acceptedCapabilities`, so a
 * version that added a capability stays shut until an admin accepts the new list.
 */
function db_page_grants(
	authorized: { installation: Doc<"plugins_workspace_installations">; version: Doc<"plugins_versions"> },
	capability: plugins_Capability,
) {
	return (
		authorized.version.capabilities.includes(capability) &&
		authorized.installation.acceptedCapabilities.includes(capability)
	);
}

export const watch_documents = query({
	args: {
		collection: v.string(),
		keyPrefix: v.optional(v.string()),
		keyStartExclusive: v.optional(v.string()),
		keyEndInclusive: v.optional(v.string()),
		limit: v.number(),
	},
	returns: v.union(v.object({ docs: v.array(document_validator), truncated: v.boolean() }), v.null()),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized || !db_page_grants(authorized, "plugin.data.read")) {
			return null;
		}
		const installation = authorized.installation;

		// Bad input answers null like a denial: the host kills the subscription either way, and a
		// window the store can never answer should die the same way a revoked one does.
		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return null;
		}
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > plugins_data_MAX_LIST_PAGE_SIZE) {
			return null;
		}
		const keyPrefix = args.keyPrefix === undefined ? Result({ _yay: null }) : validate_key_prefix(args.keyPrefix);
		if (keyPrefix._nay) {
			return null;
		}
		// Interval bounds are fenceposts the host copied from previously delivered keys, so they
		// follow the same shape rules as keys. There is no order check between the two bounds:
		// `intersect_key_ranges` reads an inverted pair as empty.
		const keyStartExclusive =
			args.keyStartExclusive === undefined ? Result({ _yay: null }) : validate_name(args.keyStartExclusive, "Keys");
		if (keyStartExclusive._nay) {
			return null;
		}
		const keyEndInclusive =
			args.keyEndInclusive === undefined ? Result({ _yay: null }) : validate_name(args.keyEndInclusive, "Keys");
		if (keyEndInclusive._nay) {
			return null;
		}

		const keyRange =
			keyPrefix._yay === null ? null : { lower: keyPrefix._yay, upper: key_prefix_upper_bound(keyPrefix._yay) };
		const range = intersect_key_ranges({
			prefixRange: keyRange,
			startExclusive: keyStartExclusive._yay,
			endInclusive: keyEndInclusive._yay,
		});
		if (range === "empty") {
			return { docs: [], truncated: false };
		}

		// Which half of the collection this read is allowed to see. A prefix that falls inside a
		// private scope reads that scope, once the member proves they are in it. Every other read —
		// including a read with no prefix at all — sees the unscoped half and nothing else, so a member
		// cannot reach a private channel by simply leaving the prefix out.
		//
		// The scope becomes part of the index range rather than a filter over the rows that come back.
		// A filter would return fewer rows than `limit` while `truncated` still described the raw read,
		// and the host would seam its window against a count that was never true.
		const readScope =
			keyPrefix._yay === null
				? null
				: await db_resolve_scope(ctx, {
						installationId: installation._id,
						collection: collection._yay,
						key: keyPrefix._yay,
					});
		if (
			readScope &&
			!(await db_can_use_scope(ctx, {
				installation,
				scopeId: readScope.scopeId,
				userId: authorized.userId,
				permission: "content.read",
			}))
		) {
			return null;
		}

		// Never read the usage doc here. Every accepted write for the installation updates it, so one
		// read would re-run every live subscription on every write anywhere in the store, not only on
		// writes inside the watched window.
		//
		// Ascending index order is the whole ordering story: the door's inverted-millisecond keys make
		// ascending read newest first, and the query itself stays order-neutral for any other key
		// scheme.
		//
		// Read one past the limit so `truncated` can say whether the range holds more documents. The
		// extra document never leaves the server.
		const documents = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope_key", (q) => {
				const base = q
					.eq("installationId", installation._id)
					.eq("collection", collection._yay)
					.eq("scopeId", readScope?.scopeId);
				const lowerBounded =
					range.lower === null
						? base
						: range.lower.inclusive
							? base.gte("key", range.lower.value)
							: base.gt("key", range.lower.value);
				return range.upper === null
					? lowerBounded
					: range.upper.inclusive
						? lowerBounded.lte("key", range.upper.value)
						: lowerBounded.lt("key", range.upper.value);
			})
			.take(args.limit + 1);

		const truncated = documents.length > args.limit;
		return { docs: (truncated ? documents.slice(0, args.limit) : documents).map(to_public_document), truncated };
	},
});

/**
 * Reads one collection in creation order, from a fencepost the caller already holds.
 *
 * Ascending is the catch-up read: a member stores the creation time of the last document they have
 * seen and asks for what arrived after it. Descending is the feed read: the newest documents first,
 * with `before` as the paging fencepost. The key index cannot answer either. The append door builds
 * keys from inverted milliseconds, so its ascending key order is newest first, and a plugin using
 * any other key scheme has no time order in its keys at all.
 *
 * Creation order, never `updatedAt` order. Editing a document and soft-deleting it both patch it, so
 * an `updatedAt` read would deliver a three-month-old message as new because someone fixed a typo in
 * it, and would deliver a tombstone as the newest thing in the collection.
 *
 * Keep `limit` small. This window covers a whole collection, so every accepted write anywhere in that
 * collection re-runs it for every subscribed client — much broader than the key-ranged windows above.
 * The scan itself is short, which is what makes the re-run affordable; a large `limit` is not.
 */
export const watch_recent = query({
	args: {
		collection: v.string(),
		/**
		 * Scan direction over creation time. Defaults to ascending. Each fencepost belongs to one
		 * direction — `since` to ascending, `before` to descending — so a caller cannot page a feed
		 * with the catch-up argument and silently truncate the wrong end.
		 */
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
		/**
		 * Exclusive lower bound on creation time, in epoch milliseconds. The caller copies it from the
		 * `createdAt` of the last document it has already handled, the same fencepost shape
		 * `keyStartExclusive` uses above. Omit it to start from the beginning of the collection.
		 */
		since: v.optional(v.number()),
		/**
		 * Exclusive upper bound on creation time, for paging a descending feed. The caller copies it
		 * from the `createdAt` of the oldest document it has already rendered. Omit it to start from
		 * the newest document.
		 */
		before: v.optional(v.number()),
		limit: v.number(),
		/**
		 * Read one private scope instead of the public half of the collection. This read has no key
		 * range to resolve a scope from, so a caller that wants a private channel's new documents names
		 * it. Omit it and the read sees only unscoped documents.
		 */
		scopeId: v.optional(v.string()),
	},
	returns: v.union(v.object({ docs: v.array(document_validator), truncated: v.boolean() }), v.null()),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized || !db_page_grants(authorized, "plugin.data.read")) {
			return null;
		}
		const installation = authorized.installation;

		// Bad input answers null like a denial, for the same reason as `watch_documents`: the host
		// kills the subscription either way.
		const collection = validate_name(args.collection, "Collection names");
		if (collection._nay) {
			return null;
		}
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > plugins_data_MAX_LIST_PAGE_SIZE) {
			return null;
		}
		if (args.since !== undefined && !Number.isFinite(args.since)) {
			return null;
		}
		if (args.before !== undefined && !Number.isFinite(args.before)) {
			return null;
		}
		// Each fencepost belongs to one direction. A caller mixing them asked for an order it does
		// not understand, and the wrong end of the read would be truncated silently.
		const order = args.order ?? "asc";
		if (order === "asc" && args.before !== undefined) {
			return null;
		}
		if (order === "desc" && args.since !== undefined) {
			return null;
		}
		if (
			args.scopeId !== undefined &&
			!(await db_can_use_scope(ctx, { installation, scopeId: args.scopeId, userId: authorized.userId, permission: "content.read" }))
		) {
			return null;
		}

		// Read one past the limit so `truncated` can say whether more documents follow, exactly as the
		// key-ranged watch does. The extra document never leaves the server.
		const documents = await ctx.db
			.query("plugins_data")
			.withIndex("by_installation_collection_scope", (q) => {
				const base = q
					.eq("installationId", installation._id)
					.eq("collection", collection._yay)
					.eq("scopeId", args.scopeId);
				if (order === "desc") {
					return args.before === undefined ? base : base.lt("_creationTime", args.before);
				}
				return args.since === undefined ? base : base.gt("_creationTime", args.since);
			})
			.order(order)
			.take(args.limit + 1);

		const truncated = documents.length > args.limit;
		return { docs: (truncated ? documents.slice(0, args.limit) : documents).map(to_public_document), truncated };
	},
});

export const resolve_member_display = query({
	args: {
		userIds: v.array(v.id("users")),
	},
	returns: v.union(v.object({ members: v.record(v.id("users"), v.union(v.string(), v.null())) }), v.null()),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized || !db_page_grants(authorized, "plugin.data.read")) {
			return null;
		}
		const installation = authorized.installation;

		if (args.userIds.length === 0 || args.userIds.length > MAX_MEMBER_RESOLVE_IDS) {
			return null;
		}

		const resolved = await Promise.all(
			args.userIds.map(async (userId) => {
				// Only a live member of this exact workspace resolves to a name. Anything else answers a
				// null entry, so stored ids cannot be turned into names from outside the workspace, and a
				// former or deleted member reads as null instead of leaking a name.
				const membership = await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", userId)
							.eq("organizationId", installation.organizationId)
							.eq("workspaceId", installation.workspaceId),
					)
					.first();
				if (!membership) {
					return [userId, null] as const;
				}

				const user = await ctx.db.get("users", userId);
				if (!user?.anagraphic) {
					return [userId, null] as const;
				}
				const anagraphic = await ctx.db.get("users_anagraphics", user.anagraphic);
				return [userId, anagraphic?.displayName ?? null] as const;
			}),
		);

		const members: Record<Id<"users">, string | null> = {};
		for (const [userId, displayName] of resolved) {
			members[userId] = displayName;
		}
		return { members };
	},
});

/**
 * The workspace roster, one page at a time, for a member picker or a mention list.
 *
 * Pages ride the membership index, so the order follows the user id and carries no meaning. The
 * caller sorts what it shows. An index on creation time would cost a stored field and a backfill to
 * order a list nobody reads in that order.
 *
 * This is the enumeration door, and it has its own capability. The resolve door above turns ids the
 * frame already stored into names and enumerates nobody, so it stays on the data-read capability.
 * This one hands over the list itself.
 *
 * An installation that never accepted `workspace.members.read` hears `refusal: "not_consented"` and
 * not an empty page. A page that received an empty page would tell the member this workspace has
 * nobody in it, and an admin would never learn there is a consent to accept.
 *
 * A row carries the user id and the display name and nothing else. Do not switch this to
 * `users.get_workspace_member_anagraphic`: that helper answers the whole anagraphic document, which
 * carries the member's email, and a plugin frame may post whatever it reads to the publisher's own
 * origin.
 *
 * Every live member of the workspace may read the roster, including a member who signed in
 * anonymously. `mint_page_session` resolves an anonymous identity to a normal user, and this door
 * draws no line the rest of the workspace does not draw.
 */
export const list_members = query({
	args: {
		limit: v.number(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(
		v.object({
			members: v.array(v.object({ userId: v.id("users"), displayName: v.union(v.string(), v.null()) })),
			cursor: v.union(v.string(), v.null()),
		}),
		v.object({ refusal: v.literal("not_consented") }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_page_read(ctx);
		if (!authorized) {
			return null;
		}
		// Keep "the workspace never granted this" apart from "this frame is dead". An admin accepting
		// the updated permissions fixes the first; only a reload or a reinstall fixes the second, and
		// the page shows a different thing for each.
		if (!db_page_grants(authorized, "workspace.members.read")) {
			return { refusal: "not_consented" as const };
		}
		const installation = authorized.installation;

		// Bad input answers null like a denial, the same way the watch doors above do.
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_MEMBER_LIST_PAGE_SIZE) {
			return null;
		}

		const page = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_organization_workspace_user", (q) =>
				q
					.eq("active", true)
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId),
			)
			.paginate({ numItems: args.limit, cursor: args.cursor ?? null });

		const members = await Promise.all(
			page.page.map(async (membership) => {
				const user = await ctx.db.get("users", membership.userId);
				if (!user?.anagraphic) {
					return { userId: membership.userId, displayName: null };
				}
				const anagraphic = await ctx.db.get("users_anagraphics", user.anagraphic);
				return { userId: membership.userId, displayName: anagraphic?.displayName ?? null };
			}),
		);

		// A finished page answers a null cursor, so a caller that follows the cursor stops instead of
		// asking for the same empty page forever.
		return { members, cursor: page.isDone ? null : page.continueCursor };
	},
});

// #endregion user reads

// #region versioned documents

/**
 * Ordered writes from one external producer.
 *
 * The producer keeps an outbox and may retry any entry, so the receiver decides the order instead of
 * trusting arrival order. Revision 1 is only accepted on a key that holds neither a value nor a
 * tombstone, and revision n only when the stored revision is exactly n - 1. Resending the same
 * revision with the same payload answers with the stored result, so a lost response costs nothing.
 * Writing the same key through the normal routes is refused, so a plugin frame cannot slip a write
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
		const { installation, organization } = authorized._yay;

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


		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId: args.principal.actorUserId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
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
		const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
			actorUserId: args.principal.actorUserId,
			organization,
		});
		const capacity = check_capacity(
			usage,
			{
				addedBytes: delta - spentFromReservation,
				addedSlots: existing || convertsReservedSlot ? 0 : 1,
				addedCollections: addsCollection ? 1 : 0,
			},
			maxDocumentSlots,
		);
		if (capacity._nay) {
			return capacity;
		}

		// A producer's outbox key can land inside a private range like any other key, so it carries the
		// same stamp. Without it the projection would be the one document in a private channel that
		// the whole workspace can read.
		const scope = await db_resolve_scope(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			key: key._yay,
		});

		if (existing) {
			await ctx.db.patch("plugins_data", existing._id, {
				value: args.value,
				byteSize: byteSize._yay,
				revision: args.revision,
				updatedBy: args.principal.actorUserId,
				updatedAt: now,
				scopeId: scope?.scopeId,
			});
		} else {
			await ctx.db.insert("plugins_data", {
				scopeId: scope?.scopeId,
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
				// The versioned service projection is workspace-visible data, not member-owned.
				ownership: "shared",
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
		await db_patch_usage(ctx, {
			usage: storedUsage,
			next: {
				usedBytes: storedUsage.usedBytes + delta,
				usedDocuments: storedUsage.usedDocuments + (existing ? 0 : 1),
				reservedBytes: storedUsage.reservedBytes - spentFromReservation + returnedToReservation,
				reservedDocuments: storedUsage.reservedDocuments - (convertsReservedSlot ? 1 : 0),
				collectionNames: addsCollection
					? [...storedUsage.collectionNames, collection._yay]
					: storedUsage.collectionNames,
			},
			now,
			maxDocumentSlots,
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
		const { installation, organization } = authorized._yay;

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


		const scopedWrite = await db_refuse_scoped_write(ctx, {
			installation,
			userId: args.principal.actorUserId,
			collection: collection._yay,
			key: key._yay,
		});
		if (scopedWrite._nay) {
			return scopedWrite;
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
		const maxDocumentSlots = await db_resolve_document_slot_cap(ctx, {
			actorUserId: args.principal.actorUserId,
			organization,
		});

		// Deleting a key that was never stored is a different thing. Nothing is given back, so the
		// tombstone is a brand new slot and has to fit. Without this a producer could delete keys that
		// never existed all day and fill the store with tombstones alone. A live reservation already
		// holds that slot, so the tombstone converts it instead of charging a second one. A released
		// never-stored retry record already holds it the same way.
		if (!existing && ownedReservation === null && !releasedSlotAlreadyHeld) {
			const capacity = check_capacity(usage, { addedBytes: 0, addedSlots: 1, addedCollections: 0 }, maxDocumentSlots);
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
		await db_patch_usage(ctx, {
			usage,
			next: {
				usedBytes: usage.usedBytes - (existing?.byteSize ?? 0),
				usedDocuments: usage.usedDocuments - (existing ? 1 : 0),
				// A released never-stored retry already counted this slot. Adding another would
				// double-count and refuse the last-slot Council delete after the reservation TTL.
				tombstoneDocuments: usage.tombstoneDocuments + (releasedSlotAlreadyHeld ? 0 : 1),
			},
			now,
			maxDocumentSlots,
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
				maxDocumentSlots,
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

		const collectionNames = await db_drop_collection_if_empty(ctx, {
			usage: afterWrites,
			collection: collection._yay,
		});
		await db_drop_member_collection(ctx, {
			installationId: installation._id,
			collection: collection._yay,
			storedNames: afterWrites.collectionNames,
			nextNames: collectionNames,
		});
		await db_patch_usage(ctx, { usage: afterWrites, next: { collectionNames }, now, maxDocumentSlots });

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
 * None of these six tables points at another, so the order between them is free. What is not free is
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
	// Every one of these six tables carries the same three scope fields in the same index, so each
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

	// The service upload targets live in their own module because they charge a workspace quota,
	// not the plugin-data counters. An uninstall leaves them alone: only a workspace teardown
	// deletes them, so this pass does nothing for an installation-scoped drain.
	const serviceUploads = await public_api_service_uploads_db_drain_batch(ctx, args);
	if (!serviceUploads.done) {
		return { done: false, deletedCount: serviceUploads.deletedCount };
	}

	// Before the accounting doc, because these rows name members: a drain that left them for last
	// would keep user ids in the store for as long as the reschedule loop takes.
	const memberUsage = await ctx.db
		.query("plugins_data_member_usage")
		.withIndex("by_organization_workspace_installation", (q) => {
			const tenant = q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId);
			return args.installationId ? tenant.eq("installationId", args.installationId) : tenant;
		})
		.take(args.batchSize);
	if (memberUsage.length > 0) {
		await Promise.all(memberUsage.map((doc) => ctx.db.delete("plugins_data_member_usage", doc._id)));
		return { done: false, deletedCount: memberUsage.length };
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

/** How many service grants one installation's preview counts before it answers "this many or more". */
const SERVICE_GRANT_COUNT_LIMIT = 100;

/**
 * How much stored data one installation still holds. The admin deletion preview reports it.
 *
 * The document numbers come from the accounting doc instead of counting docs. One installation may
 * hold up to ten thousand documents inside a sixteen-megabyte ceiling, and reading them all to learn
 * how many there are would exceed what one Convex query may read. The counters are maintained in the
 * same transaction as every write, so they are the same answer for one read.
 *
 * `tombstones` therefore covers released reservation records and delete tombstones together, because
 * one counter pays for both of their slots.
 *
 * The per-member share rows have no counter either, and they are bounded by the workspace's member
 * count, so they are counted by reading them.
 *
 * Service grants have no such counter, so they are the one number here that is found by reading docs.
 * That read is bounded: an outside service decides how many grants it mints, and this query is the
 * required first step of registry deletion, so a service that mints too many must not be able to make
 * the preview unanswerable. Past `SERVICE_GRANT_COUNT_LIMIT` the count stops there and
 * `serviceGrantsTruncated` is true, which the reader should show as `100+` rather than as an exact
 * number.
 */
export async function plugins_data_db_count_installation_docs(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
	},
) {
	const [usage, memberUsage, serviceGrants] = await Promise.all([
		db_get_usage(ctx, args.installationId),
		ctx.db
			.query("plugins_data_member_usage")
			.withIndex("by_installation_user", (q) => q.eq("installationId", args.installationId))
			.collect(),
		ctx.db
			.query("plugin_service_grants")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("installationId", args.installationId),
			)
			// Read one past the bound so the answer can say whether more grants are there. The extra
			// doc never leaves the server.
			.take(SERVICE_GRANT_COUNT_LIMIT + 1),
	]);

	const serviceGrantsTruncated = serviceGrants.length > SERVICE_GRANT_COUNT_LIMIT;
	return {
		usageDocs: usage ? 1 : 0,
		documents: usage?.usedDocuments ?? 0,
		usedBytes: usage?.usedBytes ?? 0,
		liveReservations: usage?.reservedDocuments ?? 0,
		tombstones: usage?.tombstoneDocuments ?? 0,
		collectionNames: usage?.collectionNames ?? [],
		memberUsageDocs: memberUsage.length,
		serviceGrants: serviceGrantsTruncated ? SERVICE_GRANT_COUNT_LIMIT : serviceGrants.length,
		serviceGrantsTruncated,
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
			const organization = await ctx.db.get("organizations", usage.organizationId);
			if (!organization) {
				const errorMessage = "Plugin data reservation without an organization doc";
				const errorData = { installationId: reservation.installationId, organizationId: usage.organizationId };
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
				// No actor exists here. Passing the owner makes the payer resolution land on the
				// owner either way, which is who pays in both billing modes.
				maxDocumentSlots: await db_resolve_document_slot_cap(ctx, {
					actorUserId: organization.ownerUserId,
					organization,
				}),
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

	await db_patch_usage(ctx, {
		usage,
		next: { tombstoneDocuments: Math.max(0, usage.tombstoneDocuments - 1) },
		now: args.now,
		// The Free constant is safe here without resolving the plan: this patch only
		// lowers a slot count, and the 80% warning fires only on an upward crossing,
		// so the cap value can never be compared or logged from this path.
		maxDocumentSlots: MAX_DOCUMENT_SLOTS,
	});
}

// #endregion expiry
