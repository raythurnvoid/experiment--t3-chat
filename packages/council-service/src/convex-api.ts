/**
 * Every Convex HTTP call the Council service makes, in one module, so a host contract change
 * touches one file.
 *
 * Three route families:
 *
 * - `/api/internal/plugins/service-grants/*` — two credentials: the shared exchange secret proves
 *   the call comes from the deployed Council service, the bearer says which installation and
 *   member it is for.
 * - `/api/v1/plugin-data/*` — bearer is the `psg_` grant alone.
 * - `/api/v1/files/service-uploads/*` — bearer is the sealed processing `psg_` grant alone. Bodies
 *   are strict JSON, so an unknown key is a 400. Create and finalize identify a target by its
 *   upload run and target key. Delete uses the target key across upload runs.
 */

import { Result } from "./result.ts";
import type { Env } from "./env.ts";

function convex_url(env: Env, path: string) {
	return `${env.CONVEX_HTTP_URL.replace(/\/+$/u, "")}${path}`;
}

/**
 * POST one JSON body and parse one JSON answer. `_nay.name` carries the HTTP status class so
 * callers can branch without string-matching messages. The helper separates the three named 403s —
 * a full workspace, a plan that does not include service storage, and a full plugin-data store —
 * from ordinary authorization refusals. A 409 is route-specific: grant verification fails closed,
 * while upload create may retry after stale staging cleanup finishes.
 */
async function convex_post(
	env: Env,
	args: {
		path: string;
		bearer: string;
		serviceSecret?: boolean;
		body: Record<string, unknown>;
	},
) {
	let response: Response;
	try {
		response = await fetch(convex_url(env, args.path), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${args.bearer}`,
				"Content-Type": "application/json",
				...(args.serviceSecret
					? { "X-Bonobo-Service-Authorization": `Bearer ${env.COUNCIL_SERVICE_EXCHANGE_SECRET}` }
					: {}),
			},
			body: JSON.stringify(args.body),
		});
	} catch (error) {
		return Result<never>({ _nay: { name: "network", message: `Convex request to ${args.path} failed`, cause: error } });
	}

	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		// Two 403s are their own refusals: a full workspace and a plan without service storage.
		// `upload_artifact` in `pipeline.ts` throws a NonRetryableError for both, because neither
		// clears while the run is going. An ordinary 403 stays a plain retryable Error there, because
		// a permission change might clear it, so the three must not collapse into one name. The
		// refusal name never crosses HTTP: the host sends these exact messages for its storage
		// ceiling and its plan door, so matching the text is the only way to tell them apart.
		const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
		const storageFull =
			response.status === 403 && bodyRecord?.message === "This workspace has used its plugin service storage";
		const planRequired =
			response.status === 403 &&
			bodyRecord?.message === "This workspace's plan does not include plugin service file storage";
		// The plugin-data store refuses its own three ceilings — bytes, document slots, collections —
		// with 403 too. `handle_create` in `routes-page.ts` branches on this name to tell a store
		// Council has filled apart from a member who lost write permission; collapsed into
		// `unauthorized`, a full store would send an admin to review access that is fine. These
		// messages carry a number the host computes ("its 16 MiB of storage"), so they are matched by
		// shape instead of by equality. Keep the shapes exact: a plain "Permission denied" must keep
		// falling through to `unauthorized`.
		const dataStoreFull =
			response.status === 403 &&
			typeof bodyRecord?.message === "string" &&
			/^This plugin (?:has used its \d+ (?:MiB of storage|document slots)|can use at most \d+ collections)$/u.test(
				bodyRecord.message,
			);
		const name = storageFull
			? "storage_full"
			: planRequired
				? "plan_required"
				: dataStoreFull
					? "data_store_full"
					: response.status === 401 || response.status === 403
						? "unauthorized"
						: response.status === 404
							? "not_found"
							: response.status === 409
								? "conflict"
								: response.status === 429
									? "rate_limited"
									: "refused";
		// Carry the host's own reason when it sent one. Without it a stored failure says only which
		// route answered 409, so an operator reading it cannot tell a locked file from a full quota,
		// and cannot tell the member which one to clear.
		const reason = typeof bodyRecord?.message === "string" ? `: ${bodyRecord.message}` : "";
		return Result<never>({
			_nay: { name, message: `Convex ${args.path} returned HTTP ${response.status}${reason}` },
		});
	}
	return Result({ _yay: body as Record<string, unknown> });
}

function require_string(value: unknown, field: string, path: string) {
	if (typeof value !== "string" || value.length === 0) {
		return Result<never>({ _nay: { name: "bad_response", message: `Convex ${path} answered without ${field}` } });
	}
	return Result({ _yay: value });
}

function require_number(value: unknown, field: string, path: string) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return Result<never>({ _nay: { name: "bad_response", message: `Convex ${path} answered without ${field}` } });
	}
	return Result({ _yay: value });
}

// #region service grants

/**
 * Trade a page's `plu_` token for a `psg_` grant. The only call that can create tenant authority;
 * everything the grant may touch comes from the live installation, never from this body.
 */
export async function council_convex_exchange(env: Env, pluToken: string) {
	const path = "/api/internal/plugins/service-grants/exchange";
	const answer = await convex_post(env, { path, bearer: pluToken, serviceSecret: true, body: {} });
	if (answer._nay) {
		return answer;
	}

	const body = answer._yay;
	const token = require_string(body.token, "token", path);
	if (token._nay) return token;
	const expiresAt = require_number(body.expiresAt, "expiresAt", path);
	if (expiresAt._nay) return expiresAt;
	const actorUserId = require_string(body.actorUserId, "actorUserId", path);
	if (actorUserId._nay) return actorUserId;
	const organizationId = require_string(body.organizationId, "organizationId", path);
	if (organizationId._nay) return organizationId;
	const workspaceId = require_string(body.workspaceId, "workspaceId", path);
	if (workspaceId._nay) return workspaceId;
	const installationId = require_string(body.installationId, "installationId", path);
	if (installationId._nay) return installationId;
	const principalKey = require_string(body.principalKey, "principalKey", path);
	if (principalKey._nay) return principalKey;

	return Result({
		_yay: {
			token: token._yay,
			expiresAt: expiresAt._yay,
			scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : [],
			principalKey: principalKey._yay,
			actorUserId: actorUserId._yay,
			organizationId: organizationId._yay,
			workspaceId: workspaceId._yay,
			installationId: installationId._yay,
		},
	});
}

export type council_VerifyLiveClaims = {
	installationId: string;
	phase: "interactive" | "processing";
	destinationPathPrefix: string | null;
	scopes: ("plugin_data:read" | "plugin_data:write" | "files:write")[];
};

/**
 * Ask whether the grant is still allowed to do what the service is about to do. Any mismatch is a
 * 409 and the caller fails closed. Runs before every privileged action: open, guest token mint,
 * start recording, seal.
 */
export async function council_convex_verify_live(env: Env, psgToken: string, claims: council_VerifyLiveClaims) {
	const path = "/api/internal/plugins/service-grants/verify-live";
	const answer = await convex_post(env, { path, bearer: psgToken, serviceSecret: true, body: claims });
	if (answer._nay) {
		return answer;
	}
	return Result({ _yay: { live: true as const } });
}

/**
 * Seal the live interactive grant into a processing-phase grant limited to this meeting's
 * destination, carrying `files:write`. The prefix must be a normalized absolute path with every
 * segment lowercase. The sealed grant lives seal + 6 days, FIXED: renew rotates its token but
 * never moves `expiresAt`, so all uploads must land inside that window. Sealing a sealed grant is
 * a 403.
 */
export async function council_convex_seal_processing(
	env: Env,
	psgToken: string,
	args: { destinationPathPrefix: string },
) {
	const path = "/api/internal/plugins/service-grants/seal-processing";
	const answer = await convex_post(env, {
		path,
		bearer: psgToken,
		serviceSecret: true,
		body: { destinationPathPrefix: args.destinationPathPrefix },
	});
	if (answer._nay) {
		return answer;
	}
	const token = require_string(answer._yay.token, "token", path);
	if (token._nay) return token;
	const expiresAt = require_number(answer._yay.expiresAt, "expiresAt", path);
	if (expiresAt._nay) return expiresAt;
	return Result({
		_yay: {
			token: token._yay,
			expiresAt: expiresAt._yay,
			scopes: Array.isArray(answer._yay.scopes) ? (answer._yay.scopes as string[]) : [],
		},
	});
}

// #endregion service grants

// #region plugin data

/**
 * Reserve the meeting projection's 16 KiB Plan 2 envelope before the provider call, so a meeting
 * that the store cannot hold is refused before any provider effect exists.
 */
export async function council_convex_data_reserve(
	env: Env,
	psgToken: string,
	args: { collection: string; key: string; maximumBytes: number; idempotencyKey: string; expiresAt: number },
) {
	const path = "/api/v1/plugin-data/reserve";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	return Result({ _yay: { reservationId: answer._yay.reservationId } });
}

export async function council_convex_data_release_reservation(
	env: Env,
	psgToken: string,
	args: { collection: string; key: string; idempotencyKey: string },
) {
	const path = "/api/v1/plugin-data/release-reservation";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	return Result({ _yay: { released: true as const } });
}

/**
 * Deliver one ordered projection revision. The receiver enforces the order: only the next
 * non-delete revision applies, and an exact duplicate is idempotent, so replaying a delivered
 * revision is safe.
 */
export async function council_convex_data_write_versioned(
	env: Env,
	psgToken: string,
	args: { collection: string; key: string; revision: number; value: unknown },
) {
	const path = "/api/v1/plugin-data/write-versioned";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	return Result({ _yay: { revision: args.revision } });
}

/** Terminal versioned delete: tombstones the projection document at a revision above every write. */
export async function council_convex_data_delete_versioned(
	env: Env,
	psgToken: string,
	args: { collection: string; key: string; revision: number },
) {
	const path = "/api/v1/plugin-data/delete-versioned";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	return Result({ _yay: { revision: args.revision } });
}

// #endregion plugin data

// #region service uploads

/**
 * One upload target's state, as create-target and finalize report it. `pending` carries a signed
 * staging PUT (15-minute TTL) that must be used with exactly the returned headers; `committed`
 * means the file exists and its target key answers the same way forever; `released` (finalize
 * only) means the upload was given up on before it committed, so the target holds no file any
 * more.
 *
 * `uploadUrlExpiresAt` is always the answering call's own deadline, because the host mints the URL
 * inside that same call. No caller reads it. It is parsed so a host that stops sending it is
 * caught here instead of going unnoticed.
 */
export type council_UploadTargetState =
	| {
			state: "pending";
			nodeId: string;
			uploadUrl: string;
			headers: Record<string, string>;
			uploadUrlExpiresAt: number;
	  }
	| { state: "committed"; nodeId: string; actualBytes: number | null }
	| { state: "released" };

function parse_target_state(body: Record<string, unknown>, path: string) {
	if (body.state === "committed") {
		const nodeId = require_string(body.nodeId, "nodeId", path);
		if (nodeId._nay) return nodeId;
		return Result({
			_yay: {
				state: "committed",
				nodeId: nodeId._yay,
				actualBytes: typeof body.actualBytes === "number" ? body.actualBytes : null,
			} satisfies council_UploadTargetState as council_UploadTargetState,
		});
	}
	if (body.state === "released") {
		return Result({ _yay: { state: "released" } satisfies council_UploadTargetState as council_UploadTargetState });
	}
	const nodeId = require_string(body.nodeId, "nodeId", path);
	if (nodeId._nay) return nodeId;
	const uploadUrl = require_string(body.uploadUrl, "uploadUrl", path);
	if (uploadUrl._nay) return uploadUrl;
	const expires = require_number(body.uploadUrlExpiresAt, "uploadUrlExpiresAt", path);
	if (expires._nay) return expires;
	const headers =
		typeof body.headers === "object" && body.headers !== null ? (body.headers as Record<string, string>) : {};
	return Result({
		_yay: {
			state: "pending",
			nodeId: nodeId._yay,
			uploadUrl: uploadUrl._yay,
			headers,
			uploadUrlExpiresAt: expires._yay,
		} satisfies council_UploadTargetState as council_UploadTargetState,
	});
}

/**
 * Mint one upload target inside the sealed prefix. The path must be STRICTLY inside the grant's
 * prefix with a canonical dotted lowercase file name, at most 16 targets per upload run.
 *
 * A replay is answered from the target's own state, never from the earlier answer. A committed
 * target answers `committed`. A pending one is reminted on the host side and answers a newly
 * signed URL, so the caller can always PUT to what it gets back. A replay whose previous staging
 * bytes are still being cleaned up answers 409 instead, and the step's retry asks again once that
 * cleanup has finished.
 */
export async function council_convex_uploads_create_target(
	env: Env,
	psgToken: string,
	args: {
		idempotencyKey: string;
		targetKey: string;
		path: string;
		contentType: string;
		size: number;
		readOnly: boolean;
		nonCollaborative: boolean;
	},
) {
	const path = "/api/v1/files/service-uploads/create-target";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	return parse_target_state(answer._yay, path);
}

/**
 * Ask the host to commit the finished PUT. `pending` means the storage event has not settled yet —
 * the caller polls this same call with the same body until `committed`. Unlike create-target, a
 * pending answer here carries no upload URL, so it has its own parse.
 */
export async function council_convex_uploads_finalize(
	env: Env,
	psgToken: string,
	args: { idempotencyKey: string; targetKey: string },
) {
	const path = "/api/v1/files/service-uploads/finalize";
	const answer = await convex_post(env, { path, bearer: psgToken, body: { ...args } });
	if (answer._nay) {
		return answer;
	}
	const body = answer._yay;
	if (body.state === "committed") {
		const nodeId = require_string(body.nodeId, "nodeId", path);
		if (nodeId._nay) return nodeId;
		return Result({
			_yay: {
				state: "committed" as const,
				nodeId: nodeId._yay,
				actualBytes: typeof body.actualBytes === "number" ? body.actualBytes : null,
			},
		});
	}
	if (body.state === "released") {
		return Result({ _yay: { state: "released" as const, nodeId: null, actualBytes: null } });
	}
	return Result({ _yay: { state: "pending" as const, nodeId: null, actualBytes: null } });
}

/**
 * Archive the meeting folder this grant was sealed to, with every file still inside it.
 *
 * The host takes no path: the seal names the folder. A destination that was never created, or one
 * a member already archived, answers zero archived nodes, so a replayed delete is happy.
 */
export async function council_convex_uploads_archive_destination(env: Env, psgToken: string) {
	const path = "/api/v1/files/service-uploads/archive-destination";
	const answer = await convex_post(env, { path, bearer: psgToken, body: {} });
	if (answer._nay) {
		return answer;
	}
	const archivedNodes = require_number(answer._yay.archivedNodes, "archivedNodes", path);
	if (archivedNodes._nay) {
		return archivedNodes;
	}
	return Result({ _yay: { archivedNodes: archivedNodes._yay } });
}

// #endregion service uploads
