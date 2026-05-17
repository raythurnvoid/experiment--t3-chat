# Convex — codebase-specific guidelines

These extend the base Convex guidance in [../SKILL.md](../SKILL.md) with patterns that are specific to this repository. Read this file before writing or modifying Convex code under `packages/app/convex/**`.

# HTTP routes typing pattern (this repo)

This codebase defines HTTP routes using a “route builder” pattern that keeps runtime behavior and types in one place.

When you add or modify a Convex HTTP endpoint, follow this structure:

- Define routes inside a `*_http_routes(router)` function that **returns an object** shaped like:
  - `{ [pathLiteral]: { [methodLiteral]: { pathParams, searchParams, headers, body, response } } }`
- Use a **literal** `path` and **literal** `method` (usually via small IIFEs + `as const`) so TypeScript keeps them as exact strings.
- Use **computed keys** (`[path]`, `[method]`) so the returned object is keyed by the exact path/method.
- Implement a local `handler` function that returns `{ status, body, headers? }`.
- Register the real endpoint with `router.route({ path, method, handler: httpAction(...) })`.
- For the type schema, return a typed object whose `response` is derived from the handler:
  - `response: api_schemas_BuildResponseSpecFromHandler<typeof handler>`

Why this is type-safe:

- `api_schemas_Main` is built from `ReturnType<typeof *_http_routes>[path]`, so the schema is inferred from the route definitions.
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

- `_yay` success object
- `_nay` error object (API-safe shape, usually `{ name, message }`)

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

Convex already tags backend logs with function/runtime context, so do not prefix Convex `console.log`, `console.warn`, or `console.error` messages with manual owner tags like `[OwnerSymbol.operation]`.

- Keep Convex log messages stable and concise.
- Put ids, errors, `_nay`, and other details in structured metadata objects.
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
- Compare resource `workspaceId` and `projectId` against the membership row.
- Run any permission checks.
- Perform DB writes only after these fallible checks pass.

Standard `_nay.message` values for Result-returning handlers:

- `"Unauthenticated"`: Convex auth has no usable current user, or the identity cannot resolve to a `users` row.
- `"Unauthorized"`: the user is authenticated, but the supplied membership/scope is not valid for that user.
- `"Not found"`: the requested id is invalid, the requested row is missing, or the requested row is archived when active content is required.
- `"Permission denied"`: the user and resource are valid, but an explicit permission check failed.

If a validated requested resource points to missing server-owned data, treat that as a server bug instead of a user-facing not-found branch. Throw `should_never_happen(...)` with structured ids for missing linked rows such as file properties, asset rows, content rows, scheduled jobs, or other relationships that supported write paths must keep valid.

When a missing workspace/default project is discovered while setting up authorization from an existing membership row, log structured context and return `"Unauthorized"`. This keeps the authorization boundary generic for callers while still surfacing the impossible state in Convex logs.

Use domain-specific expected messages only when the caller or UI needs that exact distinction, for example rate-limit messages or user-facing business-rule messages.

Boundary-specific return style:

- Public queries for authenticated UI screens should usually `throw convex_error({ message: "Unauthenticated" })` when there is no current user, then return `null`, `[]`, or `false` for missing membership, missing resource, or denied access according to the query return shape.
- Mutations and actions with recoverable failures should return `Result({ _nay: { message: ... } })`.
- Internal queries may return `Result({ _nay: ... })` when they are serving an action/mutation that needs to preserve expected failure details across the Convex runtime boundary.
- Internal queries should throw `should_never_happen(...)` for impossible linked-row corruption after the expected auth/resource checks succeed.

## Membership-scoped Convex handlers

When a Convex handler is scoped by a membership row (for example `membershipId: v.id("workspaces_projects_users")`), keep the validation flow and error contract consistent:

- Put `membershipId` first in `args` and first in call-site object literals.
- For mutation handlers that can fail recoverably, use `returns: v_result(...)` and return `Result(...)` instead of throwing.
- For query handlers, prefer `null` on missing access/resource unless the API explicitly uses `Result`.
- In membership-scoped handlers, load `user` first, then load `membership`.
- If `membership` is missing, return `_nay.message = "Unauthorized"` (or `null` for nullable queries).
- If the membership exists but its workspace/default project data is missing during authorization setup, log structured ids and return `_nay.message = "Unauthorized"` unless the function boundary is already using exception semantics.
- After membership succeeds, normalize/load the requested resource.
- If the requested thread/message/resource id is invalid or the row does not exist, return `_nay.message = "Not found"` (or `null` for nullable queries).
- After loading the resource, compare `workspaceId` and `projectId` directly against the membership row. Do not use a helper for these thread-scoped checks.
- If the resource exists but belongs to a different workspace/project scope than the membership row, return `_nay.message = "Unauthorized"`.
- After the requested resource is validated, throw `should_never_happen(...)` when a stored linked id points to missing data. Do not collapse broken internal relationships into `"Not found"`.
- Keep DB writes after these fallible checks so `_nay` returns do not leave partial writes behind.

Small style rule for these handlers:

- Prefer inlining small repeated `Result({ _nay: ... })` returns and small `ctx.runMutation(..., { messages: [...] })` payloads instead of adding tiny local helper functions/variables only to avoid repetition.

## Module-private naming

Do not namespace module-private helpers, types, or constants with the module/file prefix.

- Use prefixes for exported symbols so import sites can see where a symbol comes from.
- Keep non-exported functions like `authorize_file_download`, not `r2_authorize_file_download`.
- Keep non-exported types and constants unprefixed too, unless a very local ambiguity makes the shorter name misleading.

## Inline Convex validators by default

When defining Convex `args`, `returns`, or small derived payload validators, keep the validator expression inline at the registration site.

- Do not store validators in separate local variables just to shorten the function registration.
- Start with an inline validator and only move it into a separate symbol when there is a very strong reason, such as the user explicitly asking for a reusable validator or an existing production reuse point that genuinely needs the same validator.
- Prefer the smallest local shape directly inside `args` / `returns`, even for nested `v.object(...)`, `v.array(...)`, `v.union(...)`, and `v.record(...)` payloads.

## Fail-fast concurrent Result loop (Result_all + Promise.all)

When processing many items concurrently and each item can fail with `_nay`, prefer this pattern:

```ts
const results = Result_all(
	await Promise.all(
		(function* (/* iife */) {
			let nayResult = undefined;

			for (const item of items) {
				yield (async (/* iife */) => {
					const value = await doStep(item);
					if (nayResult) return nayResult;

					if (!value) {
						return (nayResult = Result({
							_nay: { name: "nay", message: "Item not found", data: { item } },
						}));
					}

					return Result({ _yay: value });
				})();
			}
		})(),
	),
);

if (results._nay) {
	return results;
}
```

Use this when you want to:

- fan out work concurrently;
- bubble one `_nay` quickly and consistently;
- avoid additional expensive work in in-flight tasks after first failure (`if (nayResult) return nayResult`).

Important caveat:

- This does not cancel already started promises; it only short-circuits subsequent logic inside each task.
- Keep this phase validation-only when possible, and perform related DB writes after the `_nay` check.

## Regular `Result_all` flatten (no fail-fast guard)

Use `Result_all` by itself to convert `Array<Result<...>>` into one `Result`:

```ts
const results = Result_all(
	await Promise.all(
		items.map(async (item) => {
			const value = await doStep(item);
			if (!value) {
				return Result({
					_nay: { name: "nay", message: "Item not found", data: { item } },
				});
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

Use this variant when:

- you want all tasks to run fully;
- you do not need the shared `nayResult` short-circuit guard inside each task;
- you still want one flat `Result` at the end.

Outside a Result/null contract, do not throw `_nay.message` directly.
In Convex code, prefer `convex_error(...)`; outside Convex code, throw an ad hoc message and pass `_nay` via `cause`:

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
- If a failure branch must rollback all writes, `throw` only when the boundary cannot return `Result` or `null`; prefer `convex_error(...)` over raw `Error` in Convex code.
- Exception: explicit cleanup markers in `finally` can be intentional side effects; document this clearly.

## Type-safe `convex_error` pattern (this repo)

For thrown `convex_error(...)` typing, we attach error metadata to mutation args and extract it on the client.

Server side (in the mutation file):

```ts
function restore_snapshot_error() {
	return {
		_errors: v.optional(v.object({ message: v.literal("yjsSnapshotUpdates is not set") })),
	};
}

export const restore_snapshot = mutation({
	args: {
		// ...real args
		...({} as ReturnType<typeof restore_snapshot_error>),
	},
	handler: async (ctx, args) => {
		throw convex_error({
			message: "yjsSnapshotUpdates is not set" satisfies NonNullable<(typeof args)["_errors"]>["message"],
		});
	},
});
```

Client side:

- Import `app_convex_Error` from `@/lib/app-convex-client.ts`.
- Narrow caught errors with `instanceof ConvexError`.
- Compare against a typed literal using `satisfies app_convex_Error<typeof app_convex_api.module.fn>["message"]`.

# Query and document patterns

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

Use `v.object({...})` only when you intentionally return a **subset** or a **derived shape** that is not the full document.

## Performance: fetching many related documents

When the user requests code that needs to fetch _many_ related documents (e.g. per item in a list), you must **avoid `await ctx.db...` inside a `for` loop**. Sequential awaits can be much slower.

This guidance is for server-side code that is already processing a server-owned list inside one query, mutation, or action. Do not use it as a reason to create public batch/list APIs when the client already has stable document ids; in that case, prefer reusable single-id queries so the Convex client cache can share and invalidate each document-shaped result independently.

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

- Query the related table using an index to fetch all needed rows (or a superset).
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

When the caller already has the stored related-document id, use `ctx.db.get`. When the caller only has a foreign key and would need to load a parent document solely to discover the related-document id, prefer a specific single-row index lookup on that foreign key instead. One indexed read is usually better than loading the parent just to do a second primary-key read.

## Performance: avoid `collect().find(...)` for single-row lookups

Treat `.collect()` as a heavy read because it materializes the full result set in memory.

- Do not replace a single-row index lookup with `collect().find(...)` when the schema can answer the question directly.
- Prefer adding or using a more specific index, then finish with `first()`.
- Avoid `unique()` on normal read paths because it throws when duplicate rows exist. Use it only when throwing on duplicates is the behavior you explicitly want.
- Keep `collect` + JS filtering only for predicates Convex cannot express cleanly, especially missing optional-field logic.

## Query cache and composition

Convex query results are automatically cached by the client and kept consistent via subscriptions. In this codebase, treat query-cache reuse as a first-class design constraint when shaping public queries.

- Prefer reusing an existing generic query over adding a new narrowly tailored wrapper query that returns nearly the same data.
- Favor stable, composable query shapes that multiple screens can call with the same args and therefore share the same cache entry.
- Public queries should usually return domain rows or small reusable domain shapes, not UI-specific view models that join unrelated data only for one screen.
- Do not optimize primarily for "fewer client-side requests". A few extra client-side queries are acceptable, especially when they can run in parallel or hit warm cache.
- It is often better to compose 2-3 smaller queries in the client than to create one larger query whose cache entry is more specific and gets invalidated or busted more often.
- Once the client has stable ids, prefer repeated single-id public queries over public batch/list wrapper queries. Single-id query results are lower-level cache primitives that more screens can reuse, and unrelated writes to one item do not invalidate a larger joined list result.
- Avoid public list or batch queries whose only job is joining known ids for one UI. Introduce a combined query only when the combined shape is a real shared domain API, when backend authorization requires resolving the data together, or when the client composition has a concrete measured performance problem.
- Small waterfalls are acceptable when they preserve better cache reuse and query composability.
- When the UI only needs app-owned profile fields, prefer reusing a generic profile/anagraphic query over creating a "current X view model" query just to reshape the payload.

Practical implication for this repo:

- If both a sidebar and a modal need the same user anagraphic, prefer both calling `users.get_anagraphic({ userId })` instead of introducing a separate `get_current_profile` wrapper just for one of them.

# Migrations

When the user asks for a Convex migration, you must implement it as an `internalMutation` in [../../../packages/app/convex/migrations.ts](../../../packages/app/convex/migrations.ts).

Keep migrations safe and repeatable:

- Always include `args` and `returns` validators.
- Prefer indexes (`withIndex`) over table scans. If you must scan, keep it small and return counts.
- Delete related records first, then delete the parent record.
- Do not rely on querying `undefined` from Convex. If you need “missing optional field” logic, collect and filter in JS.
- Return a small summary object (counts) so the user can verify what changed.
