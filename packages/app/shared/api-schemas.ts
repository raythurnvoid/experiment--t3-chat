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

## Avoid referencing values internally, instead prefer duplicating code and define types in a single block.

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

import type { Promisable } from "type-fest";
import type { ai_chat_http_routes } from "../convex/ai_chat.ts";
import type { pages_http_routes } from "../convex/ai_docs_temp.ts";
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

	"/api/auth/jwks": ReturnType<typeof users_http_routes>["/.well-known/jwks.json"];

	"/api/auth/anonymous": ReturnType<typeof users_http_routes>["/api/auth/anonymous"];

	"/api/auth/resolve-user": ReturnType<typeof users_http_routes>["/api/auth/resolve-user"];

	"/api/chat": ReturnType<typeof ai_chat_http_routes>["/api/chat"];

	"/api/v1/runs/stream": ReturnType<typeof ai_chat_http_routes>["/api/v1/runs/stream"];

	"/api/ai-docs-temp/contextual-prompt": ReturnType<typeof pages_http_routes>["/api/ai-docs-temp/contextual-prompt"];
}

export type api_schemas_Main_Path = keyof api_schemas_Main;

// @ts-expect-error
type AllHandlerStatuses<T> = Awaited<ReturnType<T>>["status"];
// @ts-expect-error
type HandlerResponseByStatus<T, S> = Extract<Awaited<ReturnType<T>>, { status: S }>;

export type api_schemas_BuildResponseSpecFromHandler<
	T extends (...args: any[]) => Promisable<{
		status: number;
		body: unknown;
		headers?: Record<string, string>;
	}>,
> = {
	[status in AllHandlerStatuses<T>]: {
		headers: HandlerResponseByStatus<T, status>["headers"] extends Record<string, string>
			? HandlerResponseByStatus<T, status>["headers"]
			: Record<string, string>;
		body: HandlerResponseByStatus<T, status>["body"];
	};
};

// #endregion Main Schema
