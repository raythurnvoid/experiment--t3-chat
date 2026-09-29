import { z } from "zod";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import type { plugins_runtime_request_follow_up_Result } from "./plugins_runtime.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

const follow_up_body_validator = z.object({ state: z.string() }).strict();
export type plugins_follow_up_http_Body = z.infer<typeof follow_up_body_validator>;

export async function plugins_follow_up_http(ctx: ActionCtx, request: Request, path: "/api/v1/plugin-runs/follow-up") {
	const auth = await public_api_authorize_request(ctx, request, {
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
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	const result = (await ctx.runMutation(internal.plugins_runtime.request_follow_up, {
		runId: principal.runId,
		callId: pluginCallId!,
		apiTokenHash: await crypto_sha256_hex(presentedToken),
		state: body._yay.state,
	})) as plugins_runtime_request_follow_up_Result;
	if (result._nay) {
		const message = result._nay.message;
		const status =
			message === "A follow-up is already requested" || message === "Plugin run chain limit exceeded"
				? 409
				: message.startsWith("Follow-up state")
					? 400
					: message === "Permission denied"
						? 403
						: 401;
		const conflictCode = message === "A follow-up is already requested" ? "follow_up_already_requested" : "chain_limit";
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: status,
			errorCode: status === 400 ? "invalid_input" : status === 409 ? conflictCode : "permission_denied",
			errorMessage: message,
		});
		if (status === 409) return { status, body: { message, errorCode: conflictCode } } as const;
		return { status, body: { message } } as const;
	}
	return { status: 200, body: { ok: true } } as const;
}
