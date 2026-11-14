import { z } from "zod";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import type { plugins_runtime_request_follow_up_Result } from "./plugins_runtime.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

const follow_up_body_validator = z.object({ state: z.string() }).strict();
export type plugins_follow_up_http_Body = z.infer<typeof follow_up_body_validator>;

export async function plugins_follow_up_http(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/plugin-runs/follow-up";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "runs:follow_up",
		allowedKinds: ["plugin_run"],
		route: path,
	});
	if (auth._nay) return auth._nay;
	const { principal, pluginCallId, presentedToken } = auth._yay;
	const body = await server_request_json_parse_and_validate(request, follow_up_body_validator);
	if (body._nay) {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 400,
			errorCode: "invalid_input",
			errorMessage: body._nay.message,
		});
		return { status: 400, body: { message: body._nay.message, errorCode: "invalid_input" } } as const;
	}
	const result = (await ctx.runMutation(internal.plugins_runtime.request_follow_up, {
		runId: principal.runId,
		callId: pluginCallId!,
		apiTokenHash: await crypto_sha256_hex(presentedToken),
		state: body._yay.state,
	})) as plugins_runtime_request_follow_up_Result;
	if (result._nay) {
		const message = result._nay.message;
		// Settle the plugin call with the same status and code the body gets.
		const fail = async <ErrorCode extends string>(failArgs: { status: number; errorCode: ErrorCode }) => {
			await public_api_settle_plugin_call_best_effort(ctx, {
				callId: pluginCallId,
				status: "failed",
				responseStatus: failArgs.status,
				errorCode: failArgs.errorCode,
				errorMessage: message,
			});
			return { message, errorCode: failArgs.errorCode };
		};

		if (message === "A follow-up is already requested") {
			return {
				status: 409,
				body: await fail({ status: 409, errorCode: "follow_up_already_requested" }),
			} as const;
		}
		if (message === "Plugin run chain limit exceeded") {
			return { status: 409, body: await fail({ status: 409, errorCode: "chain_limit" }) } as const;
		}
		if (message.startsWith("Follow-up state")) {
			return { status: 400, body: await fail({ status: 400, errorCode: "invalid_input" }) } as const;
		}
		if (message === "Permission denied") {
			return { status: 403, body: await fail({ status: 403, errorCode: "permission_denied" }) } as const;
		}
		return { status: 401, body: await fail({ status: 401, errorCode: "unauthenticated" }) } as const;
	}
	return { status: 200, body: { ok: true } } as const;
}
