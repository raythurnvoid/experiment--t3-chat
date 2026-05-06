/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access_control from "../access_control.js";
import type * as ai_chat from "../ai_chat.js";
import type * as billing from "../billing.js";
import type * as chat_messages from "../chat_messages.js";
import type * as crons from "../crons.js";
import type * as data_deletion from "../data_deletion.js";
import type * as files_nodes from "../files_nodes.js";
import type * as files_pending_updates from "../files_pending_updates.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as presence from "../presence.js";
import type * as quotas from "../quotas.js";
import type * as rate_limiter from "../rate_limiter.js";
import type * as users from "../users.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access_control: typeof access_control;
  ai_chat: typeof ai_chat;
  billing: typeof billing;
  chat_messages: typeof chat_messages;
  crons: typeof crons;
  data_deletion: typeof data_deletion;
  files_nodes: typeof files_nodes;
  files_pending_updates: typeof files_pending_updates;
  http: typeof http;
  migrations: typeof migrations;
  notifications: typeof notifications;
  presence: typeof presence;
  quotas: typeof quotas;
  rate_limiter: typeof rate_limiter;
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
  billing_workpool_bootstrap: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"billing_workpool_bootstrap">;
  billing_workpool_cancellation: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"billing_workpool_cancellation">;
  billing_workpool_usage_event: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"billing_workpool_usage_event">;
  rate_limiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rate_limiter">;
  r2: import("@convex-dev/r2/_generated/component.js").ComponentApi<"r2">;
};
