# Convex — codebase-specific guidelines

These extend the base Convex guidance in [../SKILL.md](../SKILL.md) with patterns that are specific to this repository. Read this file before writing or modifying Convex code under `packages/app/convex/**`.

# Convex terminology in comments

Use **doc/docs** when referring to entries in Convex tables in code comments, tests, and project guidance. Avoid **row/rows** unless quoting a Convex API field name, a database-neutral external source, or an existing identifier that must not be renamed.

# Environment variables: module-level consts, never accessor functions

Read required env vars once at module level, into a plain const, and throw at module root when they are missing. Never wrap the read in a `get_x()` / `x()` accessor function — a module-root throw fails the deploy immediately, while a function defers the failure to the first request that happens to call it.

```ts
// Correct — deploy fails immediately if unset (users.ts, r2.ts, data_deletion.ts, plugins_runtime.ts).
if (!process.env.PLUGIN_RUNNER_URL) {
	throw new Error("PLUGIN_RUNNER_URL is not set in Convex env");
}
const PLUGIN_RUNNER_URL = normalize_external_base_url(process.env.PLUGIN_RUNNER_URL);

// Wrong — hides the missing var until some request calls it.
function runner_url() {
	if (!process.env.PLUGIN_RUNNER_URL) {
		throw new Error("PLUGIN_RUNNER_URL is not set in Convex env");
	}
	return normalize_external_base_url(process.env.PLUGIN_RUNNER_URL);
}
```

- Derivations of the value (normalizing a URL, `as` narrowing like `POLAR_SERVER`) happen once at module level too, on the const.
- No non-null assertions: guard with `if (!process.env.X) throw`, never `process.env.X!`.
- Tests provide these vars in `setup-env.test.ts` **before** modules load, so module-level reads are test-safe; add new required vars there.
- Exceptions: deliberately optional vars stay module-level consts without a throw (`GITHUB_TOKEN_IMPORT`) or feature-gate at call time with a user-facing "unavailable" error (`EXA_API_KEY`, `CODE_EXECUTION_RUNNER_URL` in server-ai-tools.ts) — do not convert those to module-root throws. Cross-runtime modules under `shared/` that also run in the browser cannot hard-read `process.env` at module root (see `is_convex_runtime` in shared-utils.ts). `NODE_ENV` checks are runtime checks, not config reads.

# HTTP routes typing pattern (this repo)

This codebase uses a “route builder” pattern for app-owned, exact-path HTTP endpoints that are part of the typed API in `api_schemas_Main`. The pattern keeps runtime behavior and types in one place.

Use the typed builder for app-owned exact-path contracts that belong in `api_schemas_Main`; the consumer does not need to import that type. Register dynamic `pathPrefix` routes directly with `router.route(...)`, and let vendor components use their own route-registration API.

For a typed exact-path endpoint, follow this structure:

- Define routes inside a `*_http_routes(router)` function that **returns an object** shaped like:
  - `{ [pathLiteral]: { [methodLiteral]: { pathParams, searchParams, headers, body, response } } }`
- Keep every endpoint as an explicit property in `api_schemas_Main`. The duplication is deliberate:
  IDE navigation from a schema use should land on the exact entry for that endpoint. Its property key
  and its indexed `ReturnType` path must match the actual registered route; never declare a
  schema-only alias for a route that does not exist.
- Use a **literal** `path` and **literal** `method` via small IIFEs + `as const` so TypeScript keeps them as exact strings.
- Treat the outer path IIFE as a group. Put every method IIFE for that path inside its computed
  `[path]` object, so adding `GET` and `POST` for one path does not repeat the path definition.
- Use **computed keys** (`[path]`, `[method]`) so the returned object is keyed by the exact path/method.
- Implement a local `handler` function that returns `{ status, body, headers? }`.
- Keep every returned `status` literal narrow with `as const`; widening one status to `number`
  collapses the response schema into a numeric index signature.
- Register the real endpoint with `router.route({ path, method, handler: httpAction(...) })`.
- For the type schema, return a typed object whose `response` is derived from the handler:
  - `response: api_schemas_BuildResponseSpecFromHandler<typeof handler>`
- Keep the response-spec helper's small, localized `@ts-expect-error` annotations. They document
  TypeScript's inability to prove the generic handler indexed accesses and are preferable here to
  more complicated conditional-type machinery at every route.
- Request types may remain explicit or be derived from the runtime validator (`z.infer<...>`, or the
  successful branch of a hand-rolled validator). Response bodies and headers must be inferred from
  the handler rather than restated manually.
- A TypeScript `Body`, `Headers`, or `SearchParams` alias is not runtime validation. Validate every
  request field the handler consumes before using it.

Why this is type-safe:

- Each explicit `api_schemas_Main` entry indexes `ReturnType<typeof *_http_routes>` at that same path,
  preserving direct IDE navigation while deriving the endpoint schema from the route definition.
- The `response` type is inferred from what the handler can return (status/body/headers), so changing the handler automatically updates the API types.

## Example (template)

```ts
export function example_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/example" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const) => ({
					[method]: ((/* iife */) => {
						// 1) Define the request/response types in one place
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = { message: string };

						// 2) Implement the actual handler (runtime behavior)
						const handler = async (_ctx: ActionCtx, _request: Request) => {
							return {
								status: 200,
								body: { ok: true as const },
							} as const;
						};

						// 3) Register the endpoint in Convex
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						// 4) Return a type-only descriptor used by `api_schemas_Main`
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
```

# Vendor webhook payloads

Do not validate vendor webhook payloads with strict Convex object validators unless the app controls the exact payload contract. Vendors can add, remove, rename, or temporarily omit fields without coordinating with this codebase, and rejecting the entire webhook because our local validator is too strict is usually worse than ingesting the event and saving less data.

For vendor-owned webhooks:

- Accept the raw payload at the Convex boundary with a loose validator such as `v.any()`.
- Let signature verification and the vendor SDK identify the event; do not use a strict app-owned payload shape as an availability gate.
- Do not model every documented vendor field as optional in local TypeScript just because the Convex validator is loose. After the event is verified, use Zod or a small local assertion for the documented payload shape of the fields you use, and keep their real casing/nullability.
- Inside the handler, read only the fields the app needs, check those fields locally, and save whatever valid subset can be derived.
- If required fields for a specific local write are missing, skip that write or return `null` instead of failing the whole webhook delivery.
- Keep comments near the loose validator explaining that the webhook schema is vendor-owned and intentionally tolerant of payload changes.

# Testing Convex modules with Vitest

The base Convex skill covers the `convex-test` setup for regular Vitest files, including `import.meta.glob(...)` module maps. In this repo, also use the following pattern when adding in-source Vitest tests to a Convex module so private helpers can stay module-private.

Convex module analysis rejects runtime `import.meta`, but Convex's esbuild pass defines `process.env.NODE_ENV` as `"production"` while Vitest uses `"test"`. Keep the `NODE_ENV` check first so esbuild can erase the whole test block before Convex uploads and analyzes the function bundle, while Vitest still sees the standard in-source test syntax.

```ts
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest;

	describe("some_private_helper", () => {
		test("covers private helper behavior", () => {
			expect(some_private_helper()).toEqual("expected");
		});
	});
}
```

Rules for Convex in-source tests:

- Use the normal Vitest `import.meta.vitest` API inside the branch.
- Keep `process.env.NODE_ENV === "test"` as the first `&&` condition. Do not write `if (import.meta.vitest && ...)` in Convex modules because Convex analysis will still evaluate `import.meta`.
- Prefer in-source tests only for small module-private helpers where exporting the helper would damage the production module API.
- Keep broader behavior tests in regular `*.test.ts` files using `convex-test` and the module map guidance from the base Convex testing section.

# Errors as values (`Result`) in Convex handlers

This repository uses an errors-as-values pattern (`Result`) in many Convex helpers and handlers.

When a Convex function returns a Result-like payload, the `returns` validator must describe both branches:

- `_yay` success value
- `_nay` error object (usually `{ message }`, with `name` or validated `data` only when a consumer needs it)

Example:

```ts
export const create_file = mutation({
	args: { name: v.string() },
	returns: v_result({ _yay: v.object({ fileId: v.id("files") }) }),
	handler: async (ctx, args) => {
		const file = await do_create_file(ctx, args);
		if (file._nay) {
			return file;
		}
		return Result({ _yay: { fileId: file._yay } });
	},
});
```

When calling Result-returning helpers:

- Do not ignore the return value.
- Bubble `_nay` when possible.
- If bubbling is not possible at that boundary, at least log `_nay` with context.

## Convex logging format

Convex already tags backend logs with function/runtime context, so do not prefix Convex `console.log`, `console.warn`, or `console.error` messages with manual owner tags like `[OwnerSymbol.operation]` or `[r2.create_signed_download_url]`.

- Keep Convex log messages stable and concise.
- Put ids, errors, `_nay`, and other details in structured metadata objects.
- Do not include the module/function name in the message; Convex already supplies that context.
- Treat this as the Convex-specific exception to the app-wide log-prefix convention.

## Prefer `_nay` / `null` over `throw new Error` in Convex code

- In Convex actions and mutations, prefer `returns: v_result(...)` plus `Result({ _nay: ... })` for expected or recoverable failures instead of `throw new Error(...)`.
- In Convex queries, prefer `return null` for missing / unauthorized / not-found branches unless the API already uses `Result`.
- If a Convex query truly must throw a typed app-level error, use `convex_error(...)`, not `throw new Error(...)`.
- Reserve throws for cases where the handler truly needs exception semantics (for example rollback or an external boundary that cannot use `Result`), and prefer `convex_error(...)` over raw `Error` in Convex code.

## Standard validation and expected error messages

Use the same validation order and stable messages for new membership-scoped APIs and when touching old code. Keep messages concise and do not include resource names unless the product surface specifically needs that wording.

Default validation order:

- Resolve the current app user first.
- Resolve the membership or owning scope next.
- Normalize/load the requested resource.
- Compare resource `organizationId` and `workspaceId` against the membership doc.
- Run any permission checks.
- Perform DB writes only after these fallible checks pass.

Standard `_nay.message` values for Result-returning handlers:

- `"Unauthenticated"`: Convex auth has no usable current user, or the identity cannot resolve to a `users` doc.
- `"Unauthorized"`: the user is authenticated, but the supplied membership/scope is not valid for that user.
- `"Not found"`: the requested id is invalid, the requested doc is missing, or the requested doc is archived when active content is required.
- `"Permission denied"`: the user and resource are valid, but an explicit permission check failed.

Validate requested docs at the supported handler boundary that loads them. If a private helper only runs after that handler has already checked existence, scope, and kind, do not repeat those defensive checks inside the helper. Pass the already-validated fields the helper needs, such as `path` or `archiveOperationId`, and trust the caller contract.

Treat every public Convex function's args as untrusted, including calls from this app's frontend. Argument validators enforce the data shape, but the public boundary must also enforce the auth, tenancy, resource ownership, path, size, and format rules needed for stored data or downstream systems to stay correct. Do not duplicate cosmetic UI normalization unless backend correctness depends on it. Private helpers may trust the validated contract established by their owning public boundary.

If a validated requested resource points to missing server-owned data, treat that as a server bug instead of a user-facing not-found branch. Log the invariant failure with `console.error(errorMessage, errorData)` and then throw `should_never_happen(errorMessage, errorData)` with structured ids for missing linked docs such as file properties, asset docs, content docs, scheduled jobs, or other relationships that supported write paths must keep valid.

For missing fields that supported write paths must set, use the exact field path in the invariant message: `"fileNode.yjsLastSequenceId is not set"` or `"organization.defaultWorkspaceId is not set"`. Use `fileNode`, not `file`, when the doc is from `files_nodes`.

When the field is set but points to a missing or mismatched linked doc, say that the field points to the broken link, for example `"fileNode.assetId points to a missing files_r2_assets doc"`.

Use the same message variable for the explicit log and the thrown error so future logging integrations can hook `console.error` without losing the exact thrown invariant message:

```ts
const errorMessage = "fileNode.yjsLastSequenceId is not set";
const errorData = {
	fileNodeId: fileNode._id,
	yjsLastSequenceId: fileNode.yjsLastSequenceId,
};
console.error(errorMessage, errorData);
throw should_never_happen(errorMessage, errorData);
```

Keep the `console.error` data structured instead of embedding ids in the message. Passing the same `errorData` again to `should_never_happen(...)` is acceptable; the explicit log is the standard integration point for Sentry or other logging products, while the thrown error preserves the Convex failure path.

When a missing organization/default workspace is discovered while setting up authorization from an existing membership doc, log structured context and return `"Unauthorized"`. This keeps the authorization boundary generic for callers while still surfacing the impossible state in Convex logs.

Use domain-specific expected messages only when the caller or UI needs that exact distinction, for example rate-limit messages or user-facing business-rule messages.

Boundary-specific return style:

- Public queries for authenticated UI screens should usually `throw convex_error({ message: "Unauthenticated" })` when there is no current user, then return `null`, `[]`, or `false` for missing membership, missing resource, or denied access according to the query return shape.
- Mutations and actions with recoverable failures should return `Result({ _nay: { message: ... } })`.
- Internal queries may return `Result({ _nay: ... })` when they are serving an action/mutation that needs to preserve expected failure details across the Convex runtime boundary.
- Internal queries should log with `console.error(errorMessage, errorData)` and throw `should_never_happen(errorMessage, errorData)` for impossible linked-doc corruption after the expected auth/resource checks succeed.

## Membership-scoped Convex handlers

When a Convex handler is scoped by a membership doc (for example `membershipId: v.id("organizations_workspaces_users")`), keep the validation flow and error contract consistent:

- Put `membershipId` first in `args` and first in call-site object literals.
- For mutation handlers that can fail recoverably, use `returns: v_result(...)` and return `Result(...)` instead of throwing.
- For query handlers, prefer `null` on missing access/resource unless the API explicitly uses `Result`.
- Resolve the current user and membership before loading the requested resource. Independent reads may start concurrently, but validate the current user before treating the membership as authorized.
- If `membership` is missing, return `_nay.message = "Unauthorized"` (or `null` for nullable queries).
- If the membership exists but its organization/default workspace data is missing during authorization setup, log structured ids and return `_nay.message = "Unauthorized"` unless the function boundary is already using exception semantics.
- After membership succeeds, normalize/load the requested resource.
- If the requested thread/message/resource id is invalid or the doc does not exist, return `_nay.message = "Not found"` (or `null` for nullable queries).
- After loading the resource, compare `organizationId` and `workspaceId` directly against the membership doc. Do not use a helper for these thread-scoped checks.
- If the resource exists but belongs to a different organization/workspace scope than the membership doc, return `_nay.message = "Unauthorized"`.
- After the requested resource is validated, log and throw `should_never_happen(errorMessage, errorData)` when a stored linked id points to missing data. Do not collapse broken internal relationships into `"Not found"`.
- Keep DB writes after these fallible checks so `_nay` returns do not leave partial writes behind.

Small style rule for these handlers:

- Prefer inlining small repeated `Result({ _nay: ... })` returns and small `ctx.runMutation(..., { messages: [...] })` payloads instead of adding tiny local helper functions/variables only to avoid repetition.

## Public actions own their auth and any applicable rate limit

Public actions resolve the current user and apply any rate limit at the public boundary instead of delegating those decisions to an internal mutation:

- Resolve the user in the action with `server_convex_get_user_fallback_to_anonymous(ctx)`; it accepts an `ActionCtx`.
- Require `kind === "signed_in"` only for signed-in-only product features. File and other anonymous-capable flows may accept an authenticated anonymous user.
- When the endpoint has a rate limit, call `rate_limiter_limit_by_key(ctx, { name, key: userAuth.id })` directly from the action. It accepts `MutationCtx | ActionCtx`.
- Pass the resolved `userId` into internal queries/mutations as an explicit arg and keep those internal functions pure lookups/writes. Live examples: `billing.generate_checkout_link`, and `plugins.publish_version` calling `plugins.get_owned_publisher_repository`.

Do not bundle auth + rate limiting + a db read into one internal mutation just so the action makes a single call; that turns a read-only lookup into a mutation and buries the auth boundary.

## Module-private naming

Do not namespace module-private helpers, types, or constants with the module/file prefix.

- Use prefixes for exported symbols so import sites can see where a symbol comes from.
- Keep non-exported functions like `authorize_file_download`, not `r2_authorize_file_download`.
- Keep non-exported types and constants unprefixed too, unless a very local ambiguity makes the shorter name misleading.
- Non-exported module-level constants are UPPER_SNAKE (`REVIEW_MODEL_ID`, `HOST_TOKEN_TTL_MS`, `UPLOAD_COMPLETED_EVENT_TYPE`) and live in the top-of-file constants block, not next to their first user.
- Guard model-id constants with the existing union type: `const REVIEW_MODEL_ID = "gpt-5.4-mini" as const satisfies ai_chat_ModelId;`. The constant's type becomes the literal, so a variable reassigned across different model ids needs a wider annotation (`let modelId: string = ...`).
- Do not export a symbol that has no consumer outside its module. Documented exception: mutable spy-seam objects that tests must stub in place (for example `plugins_ai_review`) — module-internal calls dereference the same object, so the seam cannot work unexported.
- This rule is about module/file prefixes, not meaningful boundary prefixes. If the surrounding file already uses a boundary prefix for a specific kind of helper, follow it. For example, in `files_nodes.ts`, private helpers that fetch or query Convex docs use `db_`, while pure helpers stay unprefixed.

## Inline Convex validators by default

When defining Convex `args`, `returns`, or small derived payload validators, keep the validator expression inline at the registration site.

- Do not store validators in separate local variables just to shorten the function registration.
- Start with an inline validator and only move it into a separate symbol when there is a very strong reason, such as the user explicitly asking for a reusable validator or an existing production reuse point that genuinely needs the same validator.
- Prefer the smallest local shape directly inside `args` / `returns`, even for nested `v.object(...)`, `v.array(...)`, `v.union(...)`, and `v.record(...)` payloads.

## Concurrent `Result_all` flatten

Use `Result_all` after concurrent tasks return expected failures as fulfilled `Result` values. An `_nay` value does not end `Promise.all` early or cancel other tasks. If a task rejects unexpectedly, `Promise.all` rejects early, but the other started tasks keep running.

```ts
const results = Result_all(
	await Promise.all(
		items.map(async (item) => {
			const value = await doStep(item);
			if (value === null) {
				return Result({ _nay: { message: "Step failed" } });
			}

			return Result({ _yay: value });
		}),
	),
);

if (results._nay) {
	return results;
}

const values = results._yay;
```

Use this pattern when:

- you want all tasks to run fully;
- you still want one flat `Result` at the end.

Outside a `Result`/`null` contract, do not expose `_nay.message` as a thrown message by default. A narrow adapter may use `throw new Error(result._nay.message, { cause: result._nay })` only when the producer documents that message as API-safe or user-facing and the receiving interface intentionally uses `Error.message` as its public contract. Never throw the message string itself. Otherwise, use a stable operation message and preserve `_nay` as structured context. In Convex code, prefer `convex_error(...)`:

```ts
if (result._nay) {
	throw convex_error({
		message: "Failed to create file",
		cause: result._nay,
	});
}
```

## Warning about early returns after DB writes

This applies to any mutation flow, not only errors-as-values:

- Any normal return (including `_nay`, `null`, `{ error: ... }`, etc.) does **not** rollback prior writes in that mutation.
- Keep validation/fallible non-DB work first, and group DB writes at the end.
- Avoid early returns between related DB writes unless partial writes are explicitly intended.
- If a failure branch must roll back prior writes, throw. Prefer arranging all fallible work before writes; use `Result` or `null` only when no related prior writes need rollback. Prefer `convex_error(...)` over raw `Error` in Convex code.
- Exception: explicit cleanup markers in `finally` can be intentional side effects; document this clearly.

## Type-safe `convex_error` pattern (this repo)

Add `_errors` metadata only when a real client catches a thrown `ConvexError` and needs to narrow its message. Result-returning APIs already expose their error contract in `returns`, so do not add `_errors` to them. Keep the validator inline with the owning registration.

Server side (in the mutation file):

```ts
export const update_example = mutation({
	args: {
		value: v.string(),
		_errors: v.optional(v.object({ message: v.literal("Example update failed") })),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		throw convex_error({
			message: "Example update failed" satisfies NonNullable<(typeof args)["_errors"]>["message"],
		});
	},
});
```

Client side:

- Import `app_convex_Error` from `@/lib/app-convex-client.ts`.
- Narrow caught errors with `instanceof ConvexError`.
- Compare against a typed literal using `satisfies app_convex_Error<typeof app_convex_api.module.fn>["message"]`.

# Query and document patterns

## TypeScript circular inference around generated function refs

When a Convex module reports TS7023/TS7024/TS7022 after adding or changing `ctx.runQuery`,
`ctx.runMutation`, command factories, action builders, or other callback-heavy code, fix the
smallest local inference knot first.

Use this order:

1. Read the first errors in the owning module. Treat later implicit-`any` errors in tests,
   components, or downstream callers as cascade noise until the first module-level errors are gone.
2. Keep existing Convex call style: call direct generated refs such as `internal.files_nodes.get_by_path`.
   Do not add new `FunctionReference` aliases, grouped ref objects, or module-specific ref exports unless
   the surrounding code already uses that pattern.
3. If TypeScript names a local value in TS7022, annotate that value directly. Prefer existing result
   types for shared query results and simple concrete types for local collections. A local annotation is
   enough; do not also cast the awaited expression unless the value is inline or otherwise has no local
   annotation to carry the type:

```ts
const entry: files_nodes_get_by_path_Result =
	appFileNodePath === "/"
		? null
		: await ctx.runQuery(internal.files_nodes.get_by_path, {
				organizationId,
				workspaceId,
				path: appFileNodePath,
			});

const lines: string[] = condition ? [path] : ["0 matches."];
```

4. Re-run the focused lint/type check after grounding those locals. Many TS7023/TS7024 errors on the
   enclosing function disappear once the shared query result, ternary array, accumulator, or promise
   result that TypeScript named is explicitly grounded.
5. Use a broader function return annotation only after local annotations fail, and explain why the
   boundary is needed. Prefer local annotations over annotating command factory returns or callback
   parameters.

## Derived `_Result` types for `internal.*` call casts

When a Convex function calls another function in the same module (or across a module import cycle) via `ctx.runQuery` / `ctx.runMutation` / `ctx.runAction`, the generated types collapse and the result needs a cast. Never write the result shape inline (`as { _yay?: ...; _nay?: { message: string } }`) — inline shapes silently go stale when the callee's return changes. Derive the type from the callee instead, placed right below the callee's definition:

```ts
type upsert_plugin_Result =
	typeof upsert_plugin extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
```

- Use `RegisteredQuery` / `RegisteredAction` for queries and actions; import them as types from `"convex/server"`.
- Keep the type non-exported when the cast site is in the same module. For cross-module casts, export it with the module prefix (`files_nodes_create_file_node_internal_Result`, `r2_get_data_for_public_download_url_Result`) and import it type-only — type imports do not create runtime cycles.
- Derive related payload types by indexing instead of redefining them, for example `NonNullable<get_owned_publisher_repository_Result["_yay"]>` for a validated-scope parameter.
- The derived union preserves `_yay`/`_nay` narrowing. After converting a cast, delete the dead code the inline shape was hiding: `|| !x._yay` halves, `?? "fallback message"` branches, and `x._yay ?? null` when `_yay` already includes `null`.
- If the compiler then reports `_nay` as `never`, the callee cannot fail — delete the error handling, and if nothing reads the result, drop the cast and the result variable entirely.

## Derive whole-doc mutation `args` from the schema

When an internal mutation writes or upserts essentially a whole table doc, do not re-define the field validators inline — inline shapes drift from the schema. Reference each field from the schema with `doc(app_convex_schema, "table_name").fields.<field>`, listing exactly the fields the caller provides. Do not use `omit(...)`/`pick(...)` on validator fields — the explicit per-field list is preferred:

```ts
import { doc } from "convex-helpers/validators";

export const upsert_version_review = internalMutation({
	args: {
		createdBy: doc(app_convex_schema, "plugins_version_reviews").fields.createdBy,
		artifactHash: doc(app_convex_schema, "plugins_version_reviews").fields.artifactHash,
		// ... every field except the ones the handler derives itself
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const review = { ...args, createdAt: Date.now() };
		// index lookup, then patch-or-insert `review`
	},
});
```

- Leave out only what the handler derives itself: timestamps, literal storage ids, and fields initialized by the handler (`sourceStatus` bookkeeping on insert).
- Nested object fields work the same way: `doc(app_convex_schema, "plugins_publisher_repositories").fields.lastPublishAttempt.fields.status`.
- Spread `{ ...args }` into the insert/patch so a new schema field surfaces as a validation error instead of being silently dropped.
- Name patch-or-insert mutations `upsert_*` (`upsert_plugin`, `upsert_version_review`).

## Prefer `doc(app_convex_schema, "...")` for DB document shapes

When a Convex function returns documents fetched from `ctx.db` (or objects that embed full documents), **avoid re-defining the whole schema with `v.object({...})`**.

- **Use the schema-backed doc validator**:

  - Import the schema: `import app_convex_schema from "./schema.ts";`
  - Import the helper: `import { doc } from "convex-helpers/validators";`
  - Then use: `returns: doc(app_convex_schema, "table_name")`

- **Use id validators for document ids**:

  - Prefer `v.id("table_name")` over `v.string()` for `_id`-like fields you control.
  - If you receive ids as strings (e.g. from URL params), normalize first:
    - `const id = ctx.db.normalizeId("table_name", args.idString);`
    - Return `null` (or drop the item) if normalization fails, instead of widening validators back to `v.string()`.

- **Records keyed by ids**:
  - Prefer `v.record(v.id("users"), doc(app_convex_schema, "users_anagraphics"))` (and the matching TS type `Record<Id<"users">, Doc<"users_anagraphics">>`).

Use `v.object({...})` only when you intentionally return a **subset** or a **derived shape** that is not the full document. For subset fields, reference the schema per field with `doc(app_convex_schema, "table_name").fields.<field>` — do not use `pick(...)` for validators or handler payloads.

## Performance: fetching many related documents

When the user requests code that needs to fetch _many_ related documents (e.g. per item in a list), you must **avoid `await ctx.db...` inside a `for` loop**. Sequential awaits can be much slower.

This guidance is for server-side code that is already processing a server-owned list inside one query, mutation, or action. Do not use it as a reason to create public batch/list APIs when the client already has stable document ids; in that case, prefer reusable single-id queries so the Convex client cache can share and invalidate each document-shaped result independently.

When weighing a big aggregate query against granular queries, count consumers across the whole system, not only frontend components. Client subscriptions with the same query and arguments share cached results. Do not assume separate `ctx.runQuery` calls from actions share that client cache unless current primary documentation or a focused measurement proves it. A granular query with one consumer may still cost an extra auth-gate derivation and loading state.

✅ Prefer concurrent fetches with `Promise.all`:

```ts
const results = await Promise.all(
	items.map(async (item) => {
		const doc = await ctx.db
			.query("someTable")
			.withIndex("by_foreign_key", (q) => q.eq("foreignKey", item.foreignKey))
			.first();

		if (!doc) return null;
		return { item, doc };
	}),
);

const joined = results.filter((r): r is NonNullable<typeof r> => r !== null);
```

✅ Prefer “batch then join” when there are duplicates / large lists:

- Query the related table using an index to fetch all needed docs (or a superset).
- Build a `Map`/`Record` keyed by the join key.
- Map your original list to the joined result using that in-memory map.

This reduces repeated queries for the same key and keeps read patterns predictable.

## Performance: prefer `ctx.db.get` over `ctx.db.query` when you have ids

When the user requests fetching documents by id, you should prefer `ctx.db.get(...)` because it is an **\(O(1)\)** lookup by primary key.

This is especially useful for “follow the reference” patterns where a parent document stores the id of a related document. For example:

```ts
const user = await ctx.db.get("users", userId);
if (!user?.anagraphic) return null;

const anagraphic = await ctx.db.get("users_anagraphics", user.anagraphic);
if (!anagraphic) return null;
```

If your code always resolves the relationship via stored ids (rather than querying by a foreign key), you often do **not** need a secondary index for that relationship.

When the caller already has the stored related-document id, use `ctx.db.get`. When the caller only has a foreign key and would need to load a parent document solely to discover the related-document id, prefer a specific single-doc index lookup on that foreign key instead. One indexed read is usually better than loading the parent just to do a second primary-key read.

## Performance: avoid `collect().find(...)` for single-doc lookups

Treat `.collect()` as a heavy read because it materializes the full result set in memory.

- Do not replace a single-doc index lookup with `collect().find(...)` when the schema can answer the question directly.
- Prefer adding or using a more specific index, then finish with `first()`.
- Avoid `unique()` on normal read paths because it throws when duplicate docs exist. Use it only when throwing on duplicates is the behavior you explicitly want.
- Keep `collect` + JS filtering only for predicates Convex cannot express cleanly, especially missing optional-field logic.
- Do not use `.take(N)` + JS `.find(...)` for "newest doc matching a predicate": queries stream lazily, so `.order("desc").filter(...).first()` reads only until the first match and has no silent N cap. Reserve `.take(N)` for genuinely bounded top-N reads.
- When the function needs every doc of a naturally small set (for example a repository's secret names), use `.collect()` and say so; do not add an arbitrary `.take(100)` as a stand-in cap for "all of them".

## Performance: prefix scans via index ranges

Do not use `prefix + "\uffff"` as a general upper bound for a string-prefix scan. `\uffff` is only the largest Basic Multilingual Plane code point. Valid strings can contain supplementary Unicode characters that sort above it, so that bound can silently omit matching docs.

Use a real exclusive lexicographic successor for the stored key, or validate a restricted stored alphabet at the owning public boundary and derive the bound from that contract. The successor rule must be covered by tests for the full allowed alphabet before it becomes a shared helper or documented pattern.

For file-tree scans, query the materialized `files_nodes.treePath` key instead of raw `path`. Files and root store their canonical path, and non-root folders store `path + "/"`. Because a descendant prefix ends in `/`, its exclusive upper bound can replace that final slash with `0`: `treePath >= "/docs/" && treePath < "/docs0"`. The differing `/` and `0` characters decide the ordering before any descendant Unicode content, so the range includes the `/docs` folder and all descendants while excluding sibling-prefix paths such as `/docs-archive`.

This only works on regular indexes. Search indexes (`withSearchIndex`) accept exactly one `.search()` plus `.eq()` on `filterFields` — equality only, no `gte`/`lt` — so a prefix constraint on a full-text query cannot ride the search index. Express the same range as a post-index `.filter()` instead (see the next section for what `.filter()` does to pagination):

```ts
const treePathUpperBound = `${treePathPrefix.slice(0, -1)}0`;

const results = await ctx.db
	.query("files_nodes")
	.withSearchIndex("search_path", (q) =>
		q
			.search("path", words)
			.eq("organizationId", organizationId)
			.eq("workspaceId", workspaceId)
			.eq("archiveOperationId", undefined),
	)
	.filter((q) =>
		q.and(
			q.gte(q.field("treePath"), treePathPrefix),
			q.lt(q.field("treePath"), treePathUpperBound),
		),
	);
```

Apply this bound when fixing `files_nodes.search_paths`; do not copy its current `\uffff` bound.

## Pagination: `.filter()` semantics, short pages, and empty pages

`.filter()` is never index-backed: the query scans every doc the index range yields and drops non-matches one by one, exactly like filtering in JS afterwards. What differs is the pagination accounting (verified live against a dev deployment):

- **`.filter()` before `.paginate()`**: `numItems` counts docs that _pass_ the filter. For regular queries, the scan continues past non-matching docs until the page fills, the range ends, or an enforced `maximumRowsRead` / `maximumBytesRead` budget runs out. At that budget, a page can be short or empty with `isDone: false` and `pageStatus: "SplitRequired"`. Those pagination budget options are not enforced for search queries in the installed Convex version, so do not use them to predict `withSearchIndex(...)` page behavior.
- **JS post-filter after `.paginate()`**: paginate reads exactly `numItems` docs, then survivors are dropped, so pages thin — possibly to zero — while `isDone` stays false. Per-call reads stay flat and limited.

Rules that follow:

- **Never treat an empty page as "done".** An empty page can follow JS post-filtering or a budget split. Only `isDone` ends pagination; continue with `continueCursor` whenever it is false.
- Both approaches scan the same docs overall — choose by who pays. Prefer `.filter()` when the consumer wants full pages (fewer round-trips); prefer the JS post-filter only when per-call read cost must stay flat.
- Either way, `.filter()`/JS filtering is the fallback, not the default: express the predicate on an index (`withIndex` range, search-index `filterFields` equality) whenever the schema allows.

## Query cache and composition

Convex query results are automatically cached by the client and kept consistent via subscriptions. In this codebase, treat query-cache reuse as a first-class design constraint when shaping public queries.

- Prefer reusing an existing generic query over adding a new narrowly tailored wrapper query that returns nearly the same data.
- Favor stable, composable query shapes that multiple screens can call with the same args and therefore share the same cache entry.
- Public queries should usually return domain docs or small reusable domain shapes, not UI-specific view models that join unrelated data only for one screen.
- Do not optimize primarily for "fewer client-side requests". A few extra client-side queries are acceptable, especially when they can run in parallel or hit warm cache.
- It is often better to compose 2-3 smaller queries in the client than to create one larger query whose cache entry is more specific and gets invalidated or busted more often.
- Once the client has stable ids, prefer repeated single-id public queries over public batch/list wrapper queries. Single-id query results are lower-level cache primitives that more screens can reuse, and unrelated writes to one item do not invalidate a larger joined list result.
- Avoid public list or batch queries whose only job is joining known ids for one UI. Introduce a combined query only when the combined shape is a real shared domain API, when backend authorization requires resolving the data together, or when the client composition has a concrete measured performance problem.
- Small waterfalls are acceptable when they preserve better cache reuse and query composability.
- When the UI only needs app-owned profile fields, prefer a reusable query with the correct audience and authorization over creating a "current X view model" query only to reshape the payload.

Practical implication for this repo:

- For the current user's own profile, reuse the current-user-safe profile query from both surfaces. For another user's profile, use only a public-safe display-profile query that enforces the required tenant or audience scope. Do not add new cross-user calls to `users.get_anagraphic`: it currently has no auth or tenancy check and returns the full anagraphic doc, including email. Treat that endpoint as a known privacy gap until production code is fixed.

# Migrations

Load the [Convex migrations skill](../../convex-migrations/SKILL.md) before designing or running a migration. It owns the rollout phases, commands, operator checks, and component API details.

In this repo, add data migrations to [packages/app/convex/migrations.ts](../../../../packages/app/convex/migrations.ts) with the existing `app_migrations` component:

- Define each per-doc migration with `app_migrations.define(...)` and make `migrateOne` idempotent.
- Export a named runner such as `run_backfill_example = app_migrations.runner(internal.migrations.backfill_example)`.
- Use a hand-written `internalMutation` only for custom work that the component cannot express.
- The component handles bounded batches. The current `app_migrations` instance does not pass a `schema` option. Use `customRange` only after wiring the app schema into `Migrations`; indexed custom ranges require it.
- When existing data must remain usable, keep the rollout in separate compatibility, run, and tighten phases. If approved development data is disposable, follow the root clean-slate rule and the `dev-data-reset` skill instead of adding compatibility code. Inspect the target deployment, dry-run risky work, run to completion, and verify stored docs before tightening the schema.
- Delete children before parents only when the migration actually removes related docs.

From the repository root, run a named migration with:

```powershell
vp env exec pnpm --dir packages/app exec convex run "migrations:run_<migration_name>"
```
