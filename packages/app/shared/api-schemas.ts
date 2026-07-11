/*
Schema to store all api types grouped by api path for easy lookup.

# Format of the schema
```ts
{
    // A string with the format `/api/static/path/{path_param}/rest/of/the/path` (The param can also be camelCase)
    [apiPath]: {
        // Can be a value among `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`
        [httpMethod]: {
            searchParams: {
                [key]: string, string | boolean | number | string[] | boolean[] | number[]
            },
            pathParams: {
                [key]: string, string | boolean | number
            },
            body: (Any object or primitive. Union types are allowed),
            headers: {
              [key]: string
            },
            response: {
              // Must be a valid HTTP status code, usually `200`, `201`, `400`, `422`, `500`
              [statusCode]: {
                headers: {
                  [key]: string
                },
                body: (Any object or primitive. Union types are allowed)
              };
            };
          };
        };
    },
}
```

# Suggestions and rules

## Explicit main-schema entries
- Keep every endpoint as an explicit property in `api_schemas_Main`. This duplication is intentional:
  IDE navigation from a schema use should land on the exact entry that defines that endpoint.
- The explicit property key and the path indexed from its route function's `ReturnType` must be the
  same path, and that path must be registered at runtime. Do not add schema-only aliases for routes
  that do not exist.

## Route-definition grouping
- In each `*_http_routes` function, group first by a path IIFE and then place one or more method
  IIFEs inside that path. Multiple methods for one path share the path group instead of repeating it.
- Use the same `path`, `method`, and `handler` values for runtime registration and the computed schema keys.
- Infer `response` from the handler's literal `{ status, body, headers? }` return union. Keep every
  status literal narrow with `as const`.

## Data types to use in special scenarios
- Use `never` if the request body, response body, search params, path params are not supposed to be sent.
- Use `unknown` the type of a field is unknown.
- Use `Array<unknown>` if the type of a field is an array but the type of the elements is unknown.
- Use `Record<string, unknown>` if the type of the headers is unknown.

## If a field can be undefined, prefer setting it as optional

## Do not omit any field except for the http method and the status code to keep consistency

## The headers field are used for custom headers, or for headers that are valuable to specify.

## Schema group name pattern

```ts
interface api_schemas_<GroupNameInPascalCase> {
	// schema
}
```

# Zod schemas

```ts
const api_schemas_<GroupNameInPascalCase>_<api_path_in_snake_case>_body_schema = z.object({
	// schema
});

type api_schemas_<GroupNameInPascalCase>_<api_path_in_snake_case>_body_schema =
  z.infer<typeof api_schemas_<NameInPascalCase>_<api_path_in_snake_case>_body_schema>;
```
*/

import type { ai_chat_http_routes } from "../convex/ai_chat.ts";
import type { files_http_routes } from "../convex/files_nodes.ts";
import type { public_api_http_routes } from "../convex/public_api.ts";
import type { r2_http_routes } from "../convex/r2.ts";
import type { plugins_runtime_http_routes } from "../convex/plugins_runtime.ts";
import type { users_http_routes } from "../convex/users.ts";

// #region Schema validation
/*
The point of the following 2 types is only to validate the shape of the schema since it's AI generated.
If the schema is invalid, it will cause lint errors and the AI will retry to fix them.
*/
interface Validate<
	T extends {
		[K in keyof T]: {
			[Method in keyof T[K] & ("GET" | "POST" | "PATCH" | "DELETE" | "PUT")]: {
				searchParams: Record<string, string | boolean | number | string[] | boolean[] | number[]>;
				pathParams: Record<string, string | boolean | number>;
				body: {};
				headers: Record<string, string>;
				response: {
					[StatusCode: number]: {
						headers: Record<string, string>;
						body: {};
					};
				};
			};
		};
	},
> {}
//@ts-ignore
type _Validation = //
	Validate<api_schemas_Main>;
// #endregion Schema validation

// #region Main Schema

export interface api_schemas_Main {
	"/.well-known/jwks.json": ReturnType<typeof users_http_routes>["/.well-known/jwks.json"];

	"/api/auth/anonymous": ReturnType<typeof users_http_routes>["/api/auth/anonymous"];

	"/api/auth/resolve-user": ReturnType<typeof users_http_routes>["/api/auth/resolve-user"];

	"/api/chat": ReturnType<typeof ai_chat_http_routes>["/api/chat"];

	"/api/v1/runs/stream": ReturnType<typeof ai_chat_http_routes>["/api/v1/runs/stream"];

	"/api/v1/files/list": ReturnType<typeof public_api_http_routes>["/api/v1/files/list"];

	"/api/v1/files/read": ReturnType<typeof public_api_http_routes>["/api/v1/files/read"];

	"/api/v1/files/read-many": ReturnType<typeof public_api_http_routes>["/api/v1/files/read-many"];

	"/api/v1/files/write": ReturnType<typeof public_api_http_routes>["/api/v1/files/write"];

	"/api/v1/files/download-url": ReturnType<typeof public_api_http_routes>["/api/v1/files/download-url"];

	"/api/files/contextual-prompt": ReturnType<typeof files_http_routes>["/api/files/contextual-prompt"];

	"/api/r2/event": ReturnType<typeof r2_http_routes>["/api/r2/event"];

	"/api/internal/plugins/host/claim-runner-call": ReturnType<
		typeof plugins_runtime_http_routes
	>["/api/internal/plugins/host/claim-runner-call"];

	"/api/internal/plugins/host/finish-runner-call": ReturnType<
		typeof plugins_runtime_http_routes
	>["/api/internal/plugins/host/finish-runner-call"];

	"/api/internal/plugins/host/secret-get": ReturnType<typeof plugins_runtime_http_routes>["/api/internal/plugins/host/secret-get"];
}

export type api_schemas_Main_Path = keyof api_schemas_Main;

// #endregion Main Schema
