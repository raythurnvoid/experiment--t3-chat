import type { api_schemas_Main } from "../shared/api-schemas.ts";

/**
 * Walks a type and rebuilds it as a plain structure, so declaration emit prints the shape instead
 * of the alias that produced it.
 *
 * The route schema is built from `typeof` everywhere: `ReturnType<typeof x_http_routes>`,
 * `z.infer<typeof validator>`, `api_schemas_BuildResponseSpecFromHandler<typeof handler>`. The
 * generator's alias inliner copies an alias's right-hand side as source text and refuses `typeof`,
 * because that text would still point at the app. So the schema cannot be copied. It has to be
 * resolved by the compiler first, and this mapped type is what forces that.
 *
 * Details worth knowing before changing this type:
 *
 * - The `string | number | boolean | null | undefined` branch keeps `GenericId<"users">` intact.
 *   That type is `string & { __tableName }`, so without the branch the mapped type would walk
 *   every method of `string` and print them all.
 * - `-readonly` drops the `readonly` marker every property inherits from the handlers' `as const`
 *   return unions. The `?: undefined` filler properties those unions also produce are left alone;
 *   they are harmless, and removing them belongs in the handlers, not here.
 * - `& {}` is the usual way to stop the printer from writing the alias name instead of the shape.
 *   Measured on 2026-09-03 with this repo's TypeScript: the mapped type already expands without
 *   it, and taking it away changed no byte of the generated file. It is kept as a guard, not
 *   because it is doing work today.
 *
 * What is really load-bearing is `Expand` itself. Take the wrapper off and the emitted declaration
 * is one line naming `api_schemas_Main`, with a top-level import the generator refuses.
 */
type Expand<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends (...args: never[]) => unknown
		? T
		: T extends readonly (infer U)[]
			? Expand<U>[]
			: T extends object
				? { -readonly [K in keyof T]: Expand<T[K]> } & {}
				: T;

function expand<T>(): Expand<T> {
	return {} as Expand<T>;
}

/**
 * The host HTTP routes a plugin may call, typed as the app declares them.
 *
 * `generate-plugin-sdk-types.ts` emits this module's declaration and writes it to
 * `packages/bonobo-plugin-sdk/http-api.d.ts`. Keep this file outside `convex/` for the reason
 * `plugin-sdk-api-entry.ts` gives: Convex codegen lists every module there. Nothing imports this
 * file at runtime.
 *
 * Include public routes for plugin pages, runners, and external services, plus the SDK session
 * exchange. Service credentials stay on the plugin's server. Internal host routes stay private.
 * Check the list against the app with
 * `rg "allowedKinds: \[" packages/app/convex` before changing it.
 */
export const bonobo_http_api = expand<
	Pick<
		api_schemas_Main,
		| "/api/v1/plugin-data/read"
		| "/api/v1/plugin-data/list"
		| "/api/v1/plugin-data/write"
		| "/api/v1/plugin-data/write-batch"
		| "/api/v1/plugin-data/delete"
		| "/api/v1/files/list"
		| "/api/v1/files/read"
		| "/api/v1/files/write"
		| "/api/v1/files/touch"
		| "/api/v1/files/download-urls"
		| "/api/v1/files/plugin-folders/ensure"
		| "/api/v1/files/plugin-archive"
		| "/api/v1/files/plugin-access/set"
		| "/api/v1/files/plugin-access/undo"
		| "/api/v1/files/plugin-writers/inspect"
		| "/api/v1/files/plugin-writers/advance"
		| "/api/v1/plugins/identity/exchange"
		| "/api/v1/plugins/members/list"
		| "/api/v1/plugins/access/changes"
		| "/api/v1/plugins/service-grants/exchange"
		| "/api/v1/plugins/service-grants/recover"
		| "/api/v1/plugins/service-grants/renew"
		| "/api/v1/plugins/service-grants/seal-processing"
		| "/api/v1/plugins/service-grants/verify-live"
		| "/api/v1/activities/start"
		| "/api/v1/plugin-backend/invoke"
		| "/plugins-ui/session-jwt"
	>
>();
