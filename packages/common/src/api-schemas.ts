// TypeScript cannot prove these generic indexed accesses even though callers pass handlers that
// return { status, body, headers? }. Keep the errors localized here so route definitions stay direct.
// @ts-expect-error
type AllHandlerStatuses<T> = Awaited<ReturnType<T>>["status"];

// A handler may build one return object whose `status` is a union, for example
// `status: resolved._nay.message === "Permission denied" ? 403 : 401`. `Extract` cannot match such
// a member against one status, because `{ status: 401 | 403 }` does not extend `{ status: 401 }`,
// and the body under both keys came out as `never`. Keep a member when the status asked for is one
// of the statuses it can answer with.
type HandlerResponseByStatus<T, S> =
	// @ts-expect-error
	Awaited<ReturnType<T>> extends infer Response
		? Response extends { status: infer ResponseStatus }
			? S extends ResponseStatus
				? Response
				: never
			: never
		: never;

/** Builds the per-status response schema directly from a handler's literal return union. */
export type api_schemas_BuildResponseSpecFromHandler<T> = {
	// @ts-expect-error
	[status in AllHandlerStatuses<T>]: {
		headers: HandlerResponseByStatus<T, status> extends { headers: infer Headers extends Record<string, string> }
			? Headers
			: Record<string, string>;
		body: HandlerResponseByStatus<T, status>["body"];
	};
};

// #region split-status check
/*
The type above has to keep working for a handler that answers one object whose `status` is a union.
Two real handlers do that: `public_api_authorize_request` returns
`status: resolved._nay.message === "Permission denied" ? 403 : 401`, and `plugins_invoke.ts` builds
`status` as a `403 | 404 | 400` variable. With `Extract` those bodies came out as `never`, and the
generated SDK file showed `body: never` for those statuses.

The `//` after each `=` below is load-bearing, the same trick `packages/app/shared/api-schemas.ts`
uses. It pushes the checked type onto its own line, so the `@ts-ignore` above only silences the
unused-alias error on the name and still lets a failed check report.
*/

type Expect<Condition extends true> = Condition;

type SplitStatusHandler = () => Promise<
	{ status: 401 | 403; body: { message: string } } | { status: 200; body: { ok: true } }
>;

type SplitStatusResponses = api_schemas_BuildResponseSpecFromHandler<SplitStatusHandler>;

//@ts-ignore
type _SplitStatus401 = //
	Expect<{ message: string } extends SplitStatusResponses[401]["body"] ? true : false>;

//@ts-ignore
type _SplitStatus403 = //
	Expect<{ message: string } extends SplitStatusResponses[403]["body"] ? true : false>;

// The ordinary single-status member must still resolve, so a check that passed by matching
// everything would fail here.
//@ts-ignore
type _SplitStatus200 = //
	Expect<{ ok: true } extends SplitStatusResponses[200]["body"] ? true : false>;
// #endregion split-status check

export type { pluginRunnerApiSchema } from "../../plugin-runner/src/index.ts";
