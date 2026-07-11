// TypeScript cannot prove these generic indexed accesses even though callers pass handlers that
// return { status, body, headers? }. Keep the errors localized here so route definitions stay direct.
// @ts-expect-error
type AllHandlerStatuses<T> = Awaited<ReturnType<T>>["status"];
// @ts-expect-error
type HandlerResponseByStatus<T, S> = Extract<Awaited<ReturnType<T>>, { status: S }>;

/** Builds the per-status response schema directly from a handler's literal return union. */
export type api_schemas_BuildResponseSpecFromHandler<T> = {
	// @ts-expect-error
	[status in AllHandlerStatuses<T>]: {
		headers: HandlerResponseByStatus<T, status> extends { headers: infer Headers extends Record<string, string> }
			? Headers
			: Record<string, string>;
		// @ts-expect-error
		body: HandlerResponseByStatus<T, status>["body"];
	};
};

export type { pluginRunnerApiSchema } from "../../plugin-runner/src/index.ts";
