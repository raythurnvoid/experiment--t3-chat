import { httpAction, type ActionCtx } from "./_generated/server.js";

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
			return Response.json({ message: "Internal error", errorCode: "internal_error" }, { status: 500 });
		}
	});
}
