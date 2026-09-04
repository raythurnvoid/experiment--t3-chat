/**
 * The `/api/v1/plugin-data/*` routes.
 *
 * They are the only way into `plugins_data.ts` from outside Convex. An external service cannot call a
 * Convex internal mutation, so every store operation needs a route here. The route proves who is
 * calling and shapes the body; the mutation it calls re-checks the installation, the capability, and
 * the caller's live permissions, because a role can be taken away between the token check and the write.
 */
import { z } from "zod";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import type {
	plugins_data_RefusalName,
	plugins_data_delete_document_Result,
	plugins_data_delete_versioned_document_Result,
	plugins_data_list_documents_Result,
	plugins_data_read_document_Result,
	plugins_data_release_reservation_Result,
	plugins_data_reserve_document_Result,
	plugins_data_write_document_Result,
	plugins_data_write_documents_batch_Result,
	plugins_data_write_versioned_document_Result,
} from "./plugins_data.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import type { public_api_Scope } from "../shared/public-api.ts";

// #region shared

/**
 * Must stay at or under the `public_api_plugin_data_write_bulk` bucket capacity, because the batch
 * charges one token per document. `plugins_data.ts` enforces the same number as its own limit.
 */
const PLUGIN_DATA_WRITE_BATCH_MAX_ITEMS = 50;
const PLUGIN_DATA_LIST_MAX_PAGE_SIZE = 100;
// A normal JSON serializer may escape each Unicode code point, so leave room above the 16 KiB
// stored-value limit. The batch cap is the same allowance for all 50 documents.
const PLUGIN_DATA_REQUEST_MAX_BYTES = 64 * 1024;
const PLUGIN_DATA_WRITE_BATCH_REQUEST_MAX_BYTES = 4 * 1024 * 1024;

const PLUGIN_DATA_VALUE_FIELD_NAME_MAX_LENGTH = 1024;
const PLUGIN_DATA_VALUE_MAX_ENTRIES = 1024;
const PLUGIN_DATA_VALUE_MAX_ARRAY_ITEMS = 8192;
// Convex refuses a document nested deeper than 16 levels. A plugin document holds the value one
// level inside itself, so the value may nest 15.
const PLUGIN_DATA_VALUE_MAX_DEPTH = 15;

function is_well_formed_string(value: string) {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			// Ask whether the next unit completes the pair, not whether it falls outside the low range.
			// Past the last character `charCodeAt` answers NaN, and every comparison against NaN is false,
			// so the outside-the-range form would call a string ending in a high surrogate well formed.
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
			continue;
		}

		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}

	return true;
}

/**
 * Stop reading a plugin-data request as soon as it crosses this route's limit.
 */
async function read_request_text_bounded(request: Request, maxBytes: number) {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function parse_request_json<T>(request: Request, schema: z.ZodSchema<T>, maxBytes: number) {
	const declaredBytes = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
		return { _nay: { message: "Request body is too large" } } as const;
	}

	const bodyText = await read_request_text_bounded(request, maxBytes);
	if (bodyText === null) {
		return { _nay: { message: "Request body is too large" } } as const;
	}

	try {
		const parsed = schema.safeParse(JSON.parse(bodyText));
		if (parsed.error) {
			return { _nay: { message: "Request body validation failed" } } as const;
		}

		return { _yay: parsed.data } as const;
	} catch {
		return { _nay: { message: "Failed to parse request body as JSON" } } as const;
	}
}

const request_string_validator = z
	.string()
	.refine(is_well_formed_string, "Strings must not contain an unpaired Unicode surrogate");

/**
 * Find the first part of a value Convex will not store, or null when the whole value is fine.
 *
 * Convex refuses a field name that starts with `$`, that holds a character outside printable ASCII,
 * or that is longer than 1024 characters. It also refuses an object with more than 1024 entries, an
 * array with more than 8192 items, and a document nested deeper than 16 levels. It applies the name
 * rules while it serializes the mutation arguments and the other three when it validates the
 * document, and every one of them throws.
 *
 * Those throws happen outside the store's own refusals, so the route would answer a server error for
 * a value the caller could have sent differently. Each one is easy to reach inside the 16 KiB value
 * ceiling: a participant map keyed by name arrives with one accented letter, and sixteen nested
 * objects are about a hundred bytes.
 *
 * The depth limit also bounds this walk, so a deeply nested body cannot exhaust the stack here.
 */
function find_unstorable_value_part(value: unknown, depth: number): string | null {
	if (typeof value === "string" && !is_well_formed_string(value)) {
		return "a string with an unpaired Unicode surrogate";
	}
	if (value === null || typeof value !== "object") {
		return null;
	}

	if (depth > PLUGIN_DATA_VALUE_MAX_DEPTH) {
		return `a value nested deeper than ${PLUGIN_DATA_VALUE_MAX_DEPTH} levels`;
	}

	if (Array.isArray(value)) {
		if (value.length > PLUGIN_DATA_VALUE_MAX_ARRAY_ITEMS) {
			return `an array of more than ${PLUGIN_DATA_VALUE_MAX_ARRAY_ITEMS} items`;
		}

		for (const item of value) {
			const found = find_unstorable_value_part(item, depth + 1);
			if (found !== null) {
				return found;
			}
		}

		return null;
	}

	const entries = Object.entries(value);
	if (entries.length > PLUGIN_DATA_VALUE_MAX_ENTRIES) {
		return `an object of more than ${PLUGIN_DATA_VALUE_MAX_ENTRIES} fields`;
	}

	for (const [name, item] of entries) {
		if (
			name.length > PLUGIN_DATA_VALUE_FIELD_NAME_MAX_LENGTH ||
			name.startsWith("$") ||
			!/^[\x20-\x7e]*$/u.test(name)
		) {
			return `the field name ${name}`;
		}

		const found = find_unstorable_value_part(item, depth + 1);
		if (found !== null) {
			return found;
		}
	}

	return null;
}

/**
 * A plugin document value is a JSON object. Its fields stay `unknown` here: the plugin owns their
 * meaning, and `plugins_data.ts` is what measures the value and refuses one that is too big.
 */
const value_validator = z
	.record(request_string_validator, z.unknown())
	.refine((value) => find_unstorable_value_part(value, 1) === null, "This value holds a shape Convex cannot store");

/**
 * Every kind except `user_api_key` already carries its installation, so naming one in the body would
 * let a caller ask for an installation its token does not cover. The optional field is only for keys.
 *
 * Every one of the nine bodies spreads this, including the four that only a service grant may call.
 * Those four need the field for the refusal alone: leaving it out of a validator makes Zod drop it
 * before `to_store_principal` can see it, so a service naming another installation would be answered
 * as if it had named nothing.
 */
const installation_field = {
	installationId: z
		.string()
		.min(1)
		.refine(is_well_formed_string, "Strings must not contain an unpaired Unicode surrogate")
		.optional(),
};

/**
 * The two refusal names `plugins_data.ts` tags, typed so a rename over there breaks the build here.
 */
const REFUSAL_CONFLICT: plugins_data_RefusalName = "conflict";
const REFUSAL_STORAGE_FULL: plugins_data_RefusalName = "storage_full";

/**
 * Turn one refusal from `plugins_data.ts` into a status.
 *
 * The status comes from the name the store tagged, so rewording a refusal cannot change it. Storage
 * ceilings answer 403 to match `/api/v1/files/upload-urls`, which already answers a full quota that
 * way. The three remaining messages are the stable domain words every route in this app refuses with.
 * Everything else is bad input from the caller: a name, a size, a revision, or a batch shape.
 */
function store_failure(failure: { name?: string; message: string }) {
	const message = failure.message;

	if (failure.name === REFUSAL_CONFLICT) {
		return { status: 409, body: { message } } as const;
	}
	if (failure.name === REFUSAL_STORAGE_FULL) {
		return { status: 403, body: { message } } as const;
	}
	if (message === "Unauthenticated") {
		return { status: 401, body: { message } } as const;
	}
	if (message === "Permission denied") {
		return { status: 403, body: { message } } as const;
	}
	if (message === "Not found") {
		return { status: 404, body: { message } } as const;
	}

	return { status: 400, body: { message } } as const;
}

type AuthorizedPrincipal = Extract<
	Awaited<ReturnType<typeof public_api_authorize_request>>,
	{ _yay: unknown }
>["_yay"]["principal"];

/**
 * Turn the authorized bearer principal into the shape `plugins_data.ts` judges calls with.
 *
 * A user API key belongs to a person, not to a plugin, so its request names the installation and the
 * store proves that installation is inside the key's own tenant. The plugin kinds already carry one,
 * so naming a second would be a way to reach another installation with the wrong token.
 */
function to_store_principal(principal: AuthorizedPrincipal, bodyInstallationId: string | undefined) {
	if (principal.kind === "user_api_key") {
		if (!bodyInstallationId) {
			return { _nay: { status: 400, body: { message: "installationId is required for an API key" } } } as const;
		}

		return {
			_yay: {
				kind: principal.kind,
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				installationId: bodyInstallationId,
				actorUserId: principal.userId,
				principalKey: principal.principalKey,
			},
		} as const;
	}

	if (bodyInstallationId) {
		return {
			_nay: { status: 400, body: { message: "installationId is not allowed for this token" } },
		} as const;
	}

	if (principal.kind === "plugin_ui") {
		return {
			_yay: {
				kind: principal.kind,
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				installationId: principal.installationId,
				actorUserId: principal.userId,
				principalKey: principal.principalKey,
			},
		} as const;
	}

	if (principal.kind === "plugin_run") {
		return {
			_yay: {
				kind: principal.kind,
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				installationId: principal.installationId,
				actorUserId: principal.actorUserId,
				principalKey: principal.principalKey,
			},
		} as const;
	}

	if (principal.kind === "plugin_service") {
		return {
			_yay: {
				kind: principal.kind,
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				installationId: principal.installationId,
				actorUserId: principal.actorUserId,
				principalKey: principal.principalKey,
			},
		} as const;
	}

	// A read-only file grant has no installation and no plugin. Routes never allow this kind, so
	// reaching here would mean an `allowedKinds` list and this function disagree.
	return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
}

/**
 * The same failure vocabulary the file routes report on a settled plugin call.
 */
const ERROR_CODE_BY_STATUS: Record<number, string> = {
	400: "invalid_input",
	401: "unauthenticated",
	403: "permission_denied",
	404: "not_found",
	409: "conflict",
	429: "rate_limited",
};

/**
 * Plugin runs pay one call slot per API request and report how that call ended. Every other kind has
 * nothing to settle, and `public_api_settle_plugin_call_best_effort` already ignores a null id.
 */
async function settle(
	ctx: ActionCtx,
	callId: Parameters<typeof public_api_settle_plugin_call_best_effort>[1]["callId"],
	status: number,
	errorMessage?: string,
) {
	await public_api_settle_plugin_call_best_effort(ctx, {
		callId,
		status: status === 200 ? "succeeded" : "failed",
		responseStatus: status,
		errorCode: status === 200 ? undefined : (ERROR_CODE_BY_STATUS[status] ?? "invalid_input"),
		errorMessage,
	});
}

// #endregion shared

// #region read and list

const read_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
	})
	.strict();

export type plugins_data_http_read_Body = z.infer<typeof read_body_validator>;

export async function plugins_data_http_read(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-data/read") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:read" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, read_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		const response = { status: 400, body: { message: body._nay.message } } as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		await settle(ctx, auth._yay.pluginCallId, principal._nay.status, principal._nay.body.message);
		return principal._nay;
	}

	const read: plugins_data_read_document_Result = await ctx.runQuery(internal.plugins_data.read_document, {
		principal: principal._yay,
		collection: body._yay.collection,
		key: body._yay.key,
	});
	if (read._nay) {
		const response = store_failure(read._nay);
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const response = {
		status: 200,
		body: { document: read._yay },
		headers: { "Cache-Control": "no-store" },
	} as const;
	await settle(ctx, auth._yay.pluginCallId, 200);
	return response;
}

/**
 * Everything about a list request that decides which documents its index range covers.
 *
 * A Convex cursor only means something inside the query that produced it, and this route rebuilds
 * its range from the request body on every call. So a cursor sent beside a different range would be
 * reinterpreted there, and the page would silently skip or repeat history. The route therefore hands
 * back a cursor with this scope packed inside it, and refuses a cursor whose scope no longer matches.
 *
 * `route` is in here because a second paginated plugin-data route would run on a different index. A
 * `list` cursor and a `list-recent` call for the same collection would otherwise produce the same
 * scope, and the check would pass while the cursor crossed to another index. Any new paginated route
 * over this store adds its own range-narrowing arguments to this type.
 */
type ListCursorScope = {
	route: string;
	/**
	 * The resolved installation, never the body field. The body field is only ever set for an API
	 * key: every plugin token takes its installation from the token itself, so hashing the body
	 * value would compare `undefined` with `undefined` for exactly the callers this guard is for.
	 */
	installationId: string;
	collection: string;
	keyPrefix: string | null;
	keyStartExclusive: string | null;
	keyEndInclusive: string | null;
};

/**
 * The cursor is packed, not signed. Forging one only hands the forger a page from their own
 * installation that does not follow their own previous page, which is precisely what they get today
 * by inventing a cursor. It crosses no tenant boundary: `list_documents` still authorizes the
 * resolved principal, and that principal comes from the token, not from the cursor.
 */
function encode_list_cursor(scope: ListCursorScope, cursor: string) {
	const bytes = new TextEncoder().encode(JSON.stringify({ scope, cursor }));
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

function decode_list_cursor(token: string) {
	try {
		const binary = atob(token);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (
			typeof decoded !== "object" ||
			decoded === null ||
			!("scope" in decoded) ||
			!("cursor" in decoded) ||
			typeof decoded.cursor !== "string" ||
			typeof decoded.scope !== "object" ||
			decoded.scope === null
		) {
			return null;
		}

		return decoded as { scope: Partial<ListCursorScope>; cursor: string };
	} catch {
		return null;
	}
}

/**
 * Names the first scope field the replay changed, so the caller is not left diffing their own body.
 */
function find_changed_cursor_field(sent: Partial<ListCursorScope>, current: ListCursorScope) {
	const fields = [
		"route",
		"installationId",
		"collection",
		"keyPrefix",
		"keyStartExclusive",
		"keyEndInclusive",
	] as const satisfies readonly (keyof ListCursorScope)[];

	return fields.find((field) => sent[field] !== current[field]) ?? null;
}

const list_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		keyPrefix: request_string_validator.optional(),
		// A key range and a cursor are both continuations and they compose: the cursor carries the
		// range it was minted in, so paging stays inside it. Resending the last key of the page as
		// `keyStartExclusive` with no cursor is the other continuation, and it survives a process
		// restart, which a cursor does not.
		keyStartExclusive: request_string_validator.optional(),
		keyEndInclusive: request_string_validator.optional(),
		cursor: request_string_validator.nullable().optional(),
		limit: z.number().int().min(1).max(PLUGIN_DATA_LIST_MAX_PAGE_SIZE).optional(),
	})
	.strict();

export type plugins_data_http_list_Body = z.infer<typeof list_body_validator>;

export async function plugins_data_http_list(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-data/list") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:read" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, list_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		const response = { status: 400, body: { message: body._nay.message } } as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		await settle(ctx, auth._yay.pluginCallId, principal._nay.status, principal._nay.body.message);
		return principal._nay;
	}

	// The cursor carries the range it was minted in. Unpack it, check it still describes this request,
	// and hand the bare Convex cursor to the query. `cursor: null` is a legal first page, so the test
	// is the type, not truthiness.
	const scope: ListCursorScope = {
		route: path,
		installationId: principal._yay.installationId,
		collection: body._yay.collection,
		keyPrefix: body._yay.keyPrefix ?? null,
		keyStartExclusive: body._yay.keyStartExclusive ?? null,
		keyEndInclusive: body._yay.keyEndInclusive ?? null,
	};
	let storeCursor: string | null = null;
	if (typeof body._yay.cursor === "string") {
		const unpacked = decode_list_cursor(body._yay.cursor);
		if (unpacked === null) {
			const response = {
				status: 400,
				body: { message: "cursor is not a cursor this route issued" },
			} as const;
			await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
			return response;
		}

		const changedField = find_changed_cursor_field(unpacked.scope, scope);
		if (changedField !== null) {
			const response = {
				status: 400,
				body: { message: `cursor was issued for a different ${changedField}. Start a new page instead of reusing it.` },
			} as const;
			await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
			return response;
		}

		storeCursor = unpacked.cursor;
	}

	const listed: plugins_data_list_documents_Result = await ctx.runQuery(internal.plugins_data.list_documents, {
		principal: principal._yay,
		collection: body._yay.collection,
		...(body._yay.keyPrefix === undefined ? {} : { keyPrefix: body._yay.keyPrefix }),
		...(body._yay.keyStartExclusive === undefined ? {} : { keyStartExclusive: body._yay.keyStartExclusive }),
		...(body._yay.keyEndInclusive === undefined ? {} : { keyEndInclusive: body._yay.keyEndInclusive }),
		paginationOpts: {
			cursor: storeCursor,
			numItems: body._yay.limit ?? PLUGIN_DATA_LIST_MAX_PAGE_SIZE,
		},
	});
	if (listed._nay) {
		const response = store_failure(listed._nay);
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const response = {
		status: 200,
		body: {
			documents: listed._yay.page,
			// A key range gets a cursor like any other page now: the token carries the range, so
			// sending it back continues inside it. Past the end there is nothing to continue, so an
			// exhausted page answers `null` and `isDone: true` together.
			cursor: listed._yay.isDone ? null : encode_list_cursor(scope, listed._yay.continueCursor),
			isDone: listed._yay.isDone,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
	await settle(ctx, auth._yay.pluginCallId, 200);
	return response;
}

// #endregion read and list

// #region write and delete

const write_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
		value: value_validator,
	})
	.strict();

export type plugins_data_http_write_Body = z.infer<typeof write_body_validator>;

export async function plugins_data_http_write(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-data/write") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, write_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		const response = { status: 400, body: { message: body._nay.message } } as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		await settle(ctx, auth._yay.pluginCallId, principal._nay.status, principal._nay.body.message);
		return principal._nay;
	}

	const written: plugins_data_write_document_Result = await ctx.runMutation(internal.plugins_data.write_document, {
		principal: principal._yay,
		collection: body._yay.collection,
		key: body._yay.key,
		value: body._yay.value,
	});
	if (written._nay) {
		const response = store_failure(written._nay);
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const response = {
		status: 200,
		body: { revision: written._yay.revision, byteSize: written._yay.byteSize },
		headers: { "Cache-Control": "no-store" },
	} as const;
	await settle(ctx, auth._yay.pluginCallId, 200);
	return response;
}

const write_batch_body_validator = z
	.object({
		...installation_field,
		documents: z
			.array(
				z
					.object({
						collection: request_string_validator,
						key: request_string_validator,
						value: value_validator,
					})
					.strict(),
			)
			.min(1)
			.max(PLUGIN_DATA_WRITE_BATCH_MAX_ITEMS),
	})
	.strict();

export type plugins_data_http_write_batch_Body = z.infer<typeof write_batch_body_validator>;

export async function plugins_data_http_write_batch(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/plugin-data/write-batch",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const body = await parse_request_json(request, write_batch_body_validator, PLUGIN_DATA_WRITE_BATCH_REQUEST_MAX_BYTES);
	if (body._nay) {
		const response = { status: 400, body: { message: body._nay.message } } as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		await settle(ctx, auth._yay.pluginCallId, principal._nay.status, principal._nay.body.message);
		return principal._nay;
	}

	// Charge the whole batch before anything is written, so a batch that costs more than the caller
	// has left is refused as one request instead of writing part of it.
	const batchRateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_plugin_data_write_bulk",
		key: `${auth._yay.principal.kind}:${auth._yay.principal.principalKey}`,
		count: body._yay.documents.length,
	});
	if (batchRateLimit) {
		const response = {
			status: 429,
			body: { message: batchRateLimit.message, retryAfterMs: batchRateLimit.retryAfterMs },
		} as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const written: plugins_data_write_documents_batch_Result = await ctx.runMutation(
		internal.plugins_data.write_documents_batch,
		{
			principal: principal._yay,
			documents: body._yay.documents,
		},
	);
	if (written._nay) {
		const response = store_failure(written._nay);
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const response = {
		status: 200,
		body: { documents: written._yay.documents },
		headers: { "Cache-Control": "no-store" },
	} as const;
	await settle(ctx, auth._yay.pluginCallId, 200);
	return response;
}

const delete_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
	})
	.strict();

export type plugins_data_http_delete_Body = z.infer<typeof delete_body_validator>;

export async function plugins_data_http_delete(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-data/delete") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, delete_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		const response = { status: 400, body: { message: body._nay.message } } as const;
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		await settle(ctx, auth._yay.pluginCallId, principal._nay.status, principal._nay.body.message);
		return principal._nay;
	}

	const removed: plugins_data_delete_document_Result = await ctx.runMutation(internal.plugins_data.delete_document, {
		principal: principal._yay,
		collection: body._yay.collection,
		key: body._yay.key,
	});
	if (removed._nay) {
		const response = store_failure(removed._nay);
		await settle(ctx, auth._yay.pluginCallId, response.status, response.body.message);
		return response;
	}

	const response = {
		status: 200,
		body: { deleted: removed._yay.deleted },
		headers: { "Cache-Control": "no-store" },
	} as const;
	await settle(ctx, auth._yay.pluginCallId, 200);
	return response;
}

// #endregion write and delete

// #region ordered writes

const write_versioned_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
		revision: z.number().int().min(1),
		value: value_validator,
	})
	.strict();

export type plugins_data_http_write_versioned_Body = z.infer<typeof write_versioned_body_validator>;

export async function plugins_data_http_write_versioned(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/plugin-data/write-versioned",
) {
	// Ordered writes come from one external producer that keeps its own outbox, so only a service
	// grant may use them. A page or a key has no ordering of its own to enforce.
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, write_versioned_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		return principal._nay;
	}

	const written: plugins_data_write_versioned_document_Result = await ctx.runMutation(
		internal.plugins_data.write_versioned_document,
		{
			principal: principal._yay,
			collection: body._yay.collection,
			key: body._yay.key,
			revision: body._yay.revision,
			value: body._yay.value,
		},
	);
	if (written._nay) {
		return store_failure(written._nay);
	}

	return {
		status: 200,
		body: { revision: written._yay.revision, byteSize: written._yay.byteSize },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const delete_versioned_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
		revision: z.number().int().min(1),
	})
	.strict();

export type plugins_data_http_delete_versioned_Body = z.infer<typeof delete_versioned_body_validator>;

export async function plugins_data_http_delete_versioned(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/plugin-data/delete-versioned",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, delete_versioned_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		return principal._nay;
	}

	const removed: plugins_data_delete_versioned_document_Result = await ctx.runMutation(
		internal.plugins_data.delete_versioned_document,
		{
			principal: principal._yay,
			collection: body._yay.collection,
			key: body._yay.key,
			revision: body._yay.revision,
		},
	);
	if (removed._nay) {
		return store_failure(removed._nay);
	}

	return {
		status: 200,
		body: { deleted: removed._yay.deleted, revision: removed._yay.revision },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion ordered writes

// #region reservations

const reserve_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
		maximumBytes: z.number().int().min(1),
		idempotencyKey: request_string_validator,
		expiresAt: z.number().int(),
	})
	.strict();

export type plugins_data_http_reserve_Body = z.infer<typeof reserve_body_validator>;

export async function plugins_data_http_reserve(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-data/reserve") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, reserve_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		return principal._nay;
	}

	const reserved: plugins_data_reserve_document_Result = await ctx.runMutation(internal.plugins_data.reserve_document, {
		principal: principal._yay,
		collection: body._yay.collection,
		key: body._yay.key,
		maximumBytes: body._yay.maximumBytes,
		idempotencyKey: body._yay.idempotencyKey,
		expiresAt: body._yay.expiresAt,
	});
	if (reserved._nay) {
		return store_failure(reserved._nay);
	}

	return {
		status: 200,
		body: {
			reservationId: reserved._yay.reservationId,
			remainingBytes: reserved._yay.remainingBytes,
			expiresAt: reserved._yay.expiresAt,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const release_reservation_body_validator = z
	.object({
		...installation_field,
		collection: request_string_validator,
		key: request_string_validator,
		idempotencyKey: request_string_validator,
	})
	.strict();

export type plugins_data_http_release_reservation_Body = z.infer<typeof release_reservation_body_validator>;

export async function plugins_data_http_release_reservation(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/plugin-data/release-reservation",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "plugin_data:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}

	const body = await parse_request_json(request, release_reservation_body_validator, PLUGIN_DATA_REQUEST_MAX_BYTES);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const principal = to_store_principal(auth._yay.principal, body._yay.installationId);
	if (principal._nay) {
		return principal._nay;
	}

	const released: plugins_data_release_reservation_Result = await ctx.runMutation(
		internal.plugins_data.release_reservation,
		{
			principal: principal._yay,
			collection: body._yay.collection,
			key: body._yay.key,
			idempotencyKey: body._yay.idempotencyKey,
		},
	);
	if (released._nay) {
		return store_failure(released._nay);
	}

	return {
		status: 200,
		body: { releasedBytes: released._yay.releasedBytes },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion reservations
