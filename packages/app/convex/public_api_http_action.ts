import { httpAction, type ActionCtx } from "./_generated/server.js";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";

type InternalErrorBody = { message: string; errorCode: "internal_error" };

/**
 * Use instead of `httpAction` for every /api/v1 route.
 *
 * If a route throws an error that it did not catch, Convex answers its own 500. On a dev deployment that
 * body holds the error text and a stack trace, in a `code` field. So catch here, keep the error in the
 * server log, and answer the same `{ message, errorCode }` shape as every other public API error.
 */
export function public_api_http_action(handler: (ctx: ActionCtx, request: Request) => Promise<Response>) {
	return httpAction(async (ctx, request) => {
		try {
			return await handler(ctx, request);
		} catch (error) {
			console.error("Uncaught error in a public API route", { path: new URL(request.url).pathname, error });
			return Response.json({ message: "Internal error", errorCode: "internal_error" } satisfies InternalErrorBody, {
				status: 500,
			});
		}
	});
}

/**
 * The response types of a route that `public_api_http_action` wraps.
 *
 * They are the handler's own answers plus the 500 `internal_error` above, which any route can send.
 * A handler that already answers 500 (for example `storage_failure`) keeps that body too.
 */
export type public_api_http_action_ResponseSpec<Handler> = Omit<
	api_schemas_BuildResponseSpecFromHandler<Handler>,
	500
> & {
	500: {
		headers: Record<string, string>;
		body:
			| (api_schemas_BuildResponseSpecFromHandler<Handler> extends { 500: { body: infer Body } } ? Body : never)
			| InternalErrorBody;
	};
};
