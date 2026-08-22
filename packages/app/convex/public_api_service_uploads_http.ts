/**
 * The `/api/v1/files/service-uploads/*` routes.
 *
 * They are the only file surface a plugin service grant reaches. The generic `/api/v1/files/*`
 * routes never list `plugin_service` in their `allowedKinds`, so a service cannot write, touch, or
 * list files; it can only run this narrow create-target → upload → finalize pipeline — plus the delete
 * route for the files it stored and the archive route for its own destination folder — and only
 * with a sealed processing-phase grant bound to one destination prefix.
 *
 * The route proves who is calling and shapes the body; the mutation it calls re-checks the grant,
 * the installation, the capabilities, and the actor's live permissions, because any of them can be
 * taken away between the token check and the write.
 */
import { z } from "zod";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import type {
	public_api_service_uploads_RefusalName,
	public_api_service_uploads_archive_destination_Result,
	public_api_service_uploads_create_upload_target_Result,
	public_api_service_uploads_delete_upload_target_Result,
	public_api_service_uploads_finalize_upload_target_Result,
	public_api_service_uploads_remint_upload_target_Result,
} from "./public_api_service_uploads.ts";
import { public_api_authorize_request } from "./public_api_http_auth.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import type { public_api_Scope } from "../shared/public-api.ts";

// #region shared

/**
 * The refusal names `public_api_service_uploads.ts` tags, declared locally with the imported type
 * so a rename over there breaks the build here without pulling that module into route startup.
 */
const REFUSAL_CONFLICT: public_api_service_uploads_RefusalName = "conflict";
const REFUSAL_STORAGE_FULL: public_api_service_uploads_RefusalName = "storage_full";
const REFUSAL_PLAN_REQUIRED: public_api_service_uploads_RefusalName = "plan_required";
const REFUSAL_OUTSIDE_DESTINATION: public_api_service_uploads_RefusalName = "outside_destination";

/**
 * Turn one refusal from the storage module into a status. Storage ceilings, the plan gate, and the
 * destination fence answer 403 like the other permission refusals; replays that no longer match
 * answer 409.
 * `read_only` is what `files_node_require_writable` tags a locked ancestor with.
 */
function upload_failure(failure: { name?: string; message: string }) {
	const message = failure.message;

	if (failure.name === REFUSAL_CONFLICT) {
		return { status: 409, body: { message } } as const;
	}
	if (failure.name === REFUSAL_STORAGE_FULL) {
		return { status: 403, body: { message } } as const;
	}
	if (failure.name === REFUSAL_PLAN_REQUIRED) {
		return { status: 403, body: { message } } as const;
	}
	if (failure.name === REFUSAL_OUTSIDE_DESTINATION) {
		return { status: 403, body: { message } } as const;
	}
	if (failure.name === "read_only") {
		return { status: 409, body: { message } } as const;
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

/**
 * Authorize one service-upload call and shape the principal the mutations re-check.
 *
 * `allowedKinds` already restricts to `plugin_service`, and the scope narrowing in
 * `resolve_principal` only grants `files:write` together with a destination prefix. The phase gate
 * lives here because an interactive grant could in principle carry the scope: only the sealed
 * processing grant may upload.
 */
async function authorize_service_upload_request(ctx: ActionCtx, request: Request, route: string) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_service"],
		route,
	});
	if (auth._nay) {
		return { _nay: auth._nay } as const;
	}

	const principal = auth._yay.principal;
	if (principal.phase !== "processing" || principal.pathPrefix == null) {
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	return {
		_yay: {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			installationId: principal.installationId,
			grantId: principal.grantId,
			actorUserId: principal.actorUserId,
			principalKey: principal.principalKey,
			pathPrefix: principal.pathPrefix,
		},
	} as const;
}

// #endregion shared

// #region create target

const create_target_body_validator = z
	.object({
		idempotencyKey: z.string().min(1).max(128),
		targetKey: z.string().min(1).max(128),
		path: z.string().min(1),
		contentType: z.string().min(1).max(200),
		size: z.number().int().min(1),
		readOnly: z.boolean(),
		nonCollaborative: z.boolean(),
	})
	.strict();

export type public_api_service_uploads_http_create_target_Body = z.infer<typeof create_target_body_validator>;

export async function public_api_service_uploads_http_create_target(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/service-uploads/create-target",
) {
	const auth = await authorize_service_upload_request(ctx, request, path);
	if (auth._nay) {
		return auth._nay;
	}

	const body = await server_request_json_parse_and_validate(request, create_target_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const created: public_api_service_uploads_create_upload_target_Result = await ctx.runMutation(
		internal.public_api_service_uploads.create_upload_target,
		{
			principal: auth._yay,
			idempotencyKey: body._yay.idempotencyKey,
			targetKey: body._yay.targetKey,
			path: body._yay.path,
			contentType: body._yay.contentType,
			size: body._yay.size,
			readOnly: body._yay.readOnly,
			nonCollaborative: body._yay.nonCollaborative,
		},
	);
	if (created._nay) {
		return upload_failure(created._nay);
	}

	return {
		status: 200,
		body: created._yay,
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion create target

// #region remint

const remint_body_validator = z
	.object({
		idempotencyKey: z.string().min(1).max(128),
		targetKey: z.string().min(1).max(128),
	})
	.strict();

export type public_api_service_uploads_http_remint_Body = z.infer<typeof remint_body_validator>;

export async function public_api_service_uploads_http_remint(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/service-uploads/remint",
) {
	const auth = await authorize_service_upload_request(ctx, request, path);
	if (auth._nay) {
		return auth._nay;
	}

	const body = await server_request_json_parse_and_validate(request, remint_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const reminted: public_api_service_uploads_remint_upload_target_Result = await ctx.runMutation(
		internal.public_api_service_uploads.remint_upload_target,
		{
			principal: auth._yay,
			idempotencyKey: body._yay.idempotencyKey,
			targetKey: body._yay.targetKey,
		},
	);
	if (reminted._nay) {
		return upload_failure(reminted._nay);
	}

	return {
		status: 200,
		body: reminted._yay,
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion remint

// #region finalize

const finalize_body_validator = z
	.object({
		idempotencyKey: z.string().min(1).max(128),
		targetKey: z.string().min(1).max(128),
	})
	.strict();

export type public_api_service_uploads_http_finalize_Body = z.infer<typeof finalize_body_validator>;

export async function public_api_service_uploads_http_finalize(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/service-uploads/finalize",
) {
	const auth = await authorize_service_upload_request(ctx, request, path);
	if (auth._nay) {
		return auth._nay;
	}

	const body = await server_request_json_parse_and_validate(request, finalize_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const finalized: public_api_service_uploads_finalize_upload_target_Result = await ctx.runMutation(
		internal.public_api_service_uploads.finalize_upload_target,
		{
			principal: auth._yay,
			idempotencyKey: body._yay.idempotencyKey,
			targetKey: body._yay.targetKey,
		},
	);
	if (finalized._nay) {
		return upload_failure(finalized._nay);
	}

	return {
		status: 200,
		body: finalized._yay,
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion finalize

// #region delete

const delete_body_validator = z
	.object({
		idempotencyKey: z.string().min(1).max(128),
		targetKey: z.string().min(1).max(128),
	})
	.strict();

export type public_api_service_uploads_http_delete_Body = z.infer<typeof delete_body_validator>;

export async function public_api_service_uploads_http_delete(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/service-uploads/delete",
) {
	const auth = await authorize_service_upload_request(ctx, request, path);
	if (auth._nay) {
		return auth._nay;
	}

	const body = await server_request_json_parse_and_validate(request, delete_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const deleted: public_api_service_uploads_delete_upload_target_Result = await ctx.runMutation(
		internal.public_api_service_uploads.delete_upload_target,
		{
			principal: auth._yay,
			idempotencyKey: body._yay.idempotencyKey,
			targetKey: body._yay.targetKey,
		},
	);
	if (deleted._nay) {
		return upload_failure(deleted._nay);
	}

	return {
		status: 200,
		body: deleted._yay,
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion delete

// #region archive

/** The destination comes from the grant's seal, so there is nothing for the caller to say. */
const archive_destination_body_validator = z.object({}).strict();

export type public_api_service_uploads_http_archive_destination_Body = z.infer<
	typeof archive_destination_body_validator
>;

export async function public_api_service_uploads_http_archive_destination(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/service-uploads/archive-destination",
) {
	const auth = await authorize_service_upload_request(ctx, request, path);
	if (auth._nay) {
		return auth._nay;
	}

	const body = await server_request_json_parse_and_validate(request, archive_destination_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const archived: public_api_service_uploads_archive_destination_Result = await ctx.runMutation(
		internal.public_api_service_uploads.archive_destination,
		{
			principal: auth._yay,
		},
	);
	if (archived._nay) {
		return upload_failure(archived._nay);
	}

	return {
		status: 200,
		body: { archivedNodes: archived._yay.archivedNodes },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion archive
