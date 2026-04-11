/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_chat from "../ai_chat.js";
import type * as ai_docs_temp from "../ai_docs_temp.js";
import type * as billing from "../billing.js";
import type * as chat_messages from "../chat_messages.js";
import type * as crons from "../crons.js";
import type * as data_deletion from "../data_deletion.js";
import type * as http from "../http.js";
import type * as limits from "../limits.js";
import type * as migrations from "../migrations.js";
import type * as pages_pending_edits from "../pages_pending_edits.js";
import type * as presence from "../presence.js";
import type * as users from "../users.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai_chat: typeof ai_chat;
  ai_docs_temp: typeof ai_docs_temp;
  billing: typeof billing;
  chat_messages: typeof chat_messages;
  crons: typeof crons;
  data_deletion: typeof data_deletion;
  http: typeof http;
  limits: typeof limits;
  migrations: typeof migrations;
  pages_pending_edits: typeof pages_pending_edits;
  presence: typeof presence;
  users: typeof users;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  polar: import("@convex-dev/polar/_generated/component.js").ComponentApi<"polar">;
  presence: import("@convex-dev/presence/_generated/component.js").ComponentApi<"presence">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  billingUsageEventWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"billingUsageEventWorkpool">;
};
