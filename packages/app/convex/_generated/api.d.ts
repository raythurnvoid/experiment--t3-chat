/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as ai_chat from "../ai_chat.js";
import type * as ai_docs_temp from "../ai_docs_temp.js";
import type * as auth from "../auth.js";
import type * as http from "../http.js";
import type * as lib_server_ai_tools from "../lib/server_ai_tools.js";
import type * as lib_server_utils from "../lib/server_utils.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  ai_chat: typeof ai_chat;
  ai_docs_temp: typeof ai_docs_temp;
  auth: typeof auth;
  http: typeof http;
  "lib/server_ai_tools": typeof lib_server_ai_tools;
  "lib/server_utils": typeof lib_server_utils;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
