/*
Schema to store all api types grouped by api path for easy lookup.

# Format of the schema
```ts
{
    // A string with the format `/api/static/path/{path_param}/rest/of/the/path` (The param can also be camelCase)
    [apiPath]: {
        // Can be a value among `get`, `post`, `put`, `delete`, `patch`, `options`, `head`
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

import type { AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { PrepareSendMessagesRequest, UIMessage } from "ai";
import z from "zod";

// #region Schema validation
/*
The point of the following 2 types is only to validate the shape of the schema since it's AI generated.
If the schema is invalid, it will cause lint errors and the AI will retry to fix them.
*/
interface Validate<
	T extends {
		[K in keyof T]: {
			[Method in keyof T[K] & ("get" | "post" | "patch" | "delete" | "put")]: {
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

export const api_schemas_Main_api_chat_body_schema = z.object({
	// AI SDK fields
	id: z.string(),
	messages: z.array(z.any()),
	trigger: z.enum(["submit-message", "regenerate-message"]),
	messageId: z.string().optional(),

	// Assistant UI fields
	system: z.string().optional(),
	tools: z.record(z.string(), z.unknown()),

	// Custom fields
	threadId: z.string(),
	parentId: z.string().optional(),
});

type api_schemas_Main_api_chat_body_schema = z.infer<typeof api_schemas_Main_api_chat_body_schema>;

export const api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema = z.object({
	prompt: z.string(),
	option: z.string().optional(),
	command: z.string().optional(),
});

type api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema = z.infer<
	typeof api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema
>;

export interface api_schemas_Main {
	"/api/chat": {
		get: {
			pathParams: never;
			searchParams: never;
			/**
			 * See {@link PrepareSendMessagesRequest}.
			 *
			 * See {@link AssistantChatTransport.prepareSendMessagesRequest}.
			 **/
			body: {
				// AI SDK fields
				id: api_schemas_Main_api_chat_body_schema["id"];
				messages: UIMessage[];
				trigger: api_schemas_Main_api_chat_body_schema["trigger"];
				messageId: api_schemas_Main_api_chat_body_schema["messageId"];

				// Assistant UI fields
				system?: api_schemas_Main_api_chat_body_schema["system"];
				tools: api_schemas_Main_api_chat_body_schema["tools"];

				// Custom fields
				threadId: api_schemas_Main_api_chat_body_schema["threadId"];
				parentId: api_schemas_Main_api_chat_body_schema["parentId"];
			};
			headers: {
				Authorization: string;
			};
			response: {
				200: {
					headers: {};
					body: any;
				};
			};
		};
	};

	"/api/v1/runs/stream": {
		post: {
			pathParams: never;
			searchParams: never;
			body: {
				thread_id: string;
				assistant_id: string;
				messages: readonly unknown[];
				response_format?: string;
			};
			headers: {
				Authorization: string;
			};
			response: {
				200: {
					headers: {};
					body: any;
				};
			};
		};
	};

	"/api/ai-docs-temp/contextual-prompt": {
		post: {
			pathParams: never;
			searchParams: never;
			body: {
				prompt: api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema["prompt"];
				option?: api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema["option"];
				command?: api_schemas_Main_api_ai_docs_temp_contextual_prompt_body_schema["command"];
			};
			headers: {
				Authorization: string;
			};
			response: {
				200: {
					headers: {};
					body: string; // streaming text response
				};
			};
		};
	};
}

export type api_schemas_MainPaths = keyof api_schemas_Main;

// #endregion Main Schema
