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
import type * as activities from "../activities.js";
import type * as ai_chat from "../ai_chat.js";
import type * as ai_chat_files from "../ai_chat_files.js";
import type * as ai_chat_http_routes from "../ai_chat_http_routes.js";
import type * as bash from "../bash.js";
import type * as billing from "../billing.js";
import type * as billing_db from "../billing_db.js";
import type * as billing_http from "../billing_http.js";
import type * as billing_http_routes from "../billing_http_routes.js";
import type * as billing_polar from "../billing_polar.js";
import type * as chat_messages from "../chat_messages.js";
import type * as crons from "../crons.js";
import type * as data_deletion from "../data_deletion.js";
import type * as data_deletion_requests from "../data_deletion_requests.js";
import type * as data_import from "../data_import.js";
import type * as files_metadata from "../files_metadata.js";
import type * as files_nodes from "../files_nodes.js";
import type * as files_nodes_ai from "../files_nodes_ai.js";
import type * as files_nodes_ai_http_routes from "../files_nodes_ai_http_routes.js";
import type * as files_nodes_content from "../files_nodes_content.js";
import type * as files_pending_updates from "../files_pending_updates.js";
import type * as files_sharing from "../files_sharing.js";
import type * as github_mounts from "../github_mounts.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as organizations from "../organizations.js";
import type * as plugins from "../plugins.js";
import type * as plugins_data from "../plugins_data.js";
import type * as plugins_data_http from "../plugins_data_http.js";
import type * as plugins_data_http_routes from "../plugins_data_http_routes.js";
import type * as plugins_runtime from "../plugins_runtime.js";
import type * as plugins_runtime_http_routes from "../plugins_runtime_http_routes.js";
import type * as plugins_service from "../plugins_service.js";
import type * as plugins_service_http_routes from "../plugins_service_http_routes.js";
import type * as plugins_ui from "../plugins_ui.js";
import type * as plugins_ui_http_routes from "../plugins_ui_http_routes.js";
import type * as presence from "../presence.js";
import type * as public_api from "../public_api.js";
import type * as public_api_files_list_http from "../public_api_files_list_http.js";
import type * as public_api_http_auth from "../public_api_http_auth.js";
import type * as public_api_http_routes from "../public_api_http_routes.js";
import type * as public_api_service_uploads from "../public_api_service_uploads.js";
import type * as public_api_service_uploads_http from "../public_api_service_uploads_http.js";
import type * as public_api_service_uploads_http_routes from "../public_api_service_uploads_http_routes.js";
import type * as quotas from "../quotas.js";
import type * as r2 from "../r2.js";
import type * as r2_client from "../r2_client.js";
import type * as r2_http_routes from "../r2_http_routes.js";
import type * as rate_limiter from "../rate_limiter.js";
import type * as users from "../users.js";
import type * as users_http_routes from "../users_http_routes.js";
import type * as value_store from "../value_store.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access_control: typeof access_control;
  activities: typeof activities;
  ai_chat: typeof ai_chat;
  ai_chat_files: typeof ai_chat_files;
  ai_chat_http_routes: typeof ai_chat_http_routes;
  bash: typeof bash;
  billing: typeof billing;
  billing_db: typeof billing_db;
  billing_http: typeof billing_http;
  billing_http_routes: typeof billing_http_routes;
  billing_polar: typeof billing_polar;
  chat_messages: typeof chat_messages;
  crons: typeof crons;
  data_deletion: typeof data_deletion;
  data_deletion_requests: typeof data_deletion_requests;
  data_import: typeof data_import;
  files_metadata: typeof files_metadata;
  files_nodes: typeof files_nodes;
  files_nodes_ai: typeof files_nodes_ai;
  files_nodes_ai_http_routes: typeof files_nodes_ai_http_routes;
  files_nodes_content: typeof files_nodes_content;
  files_pending_updates: typeof files_pending_updates;
  files_sharing: typeof files_sharing;
  github_mounts: typeof github_mounts;
  http: typeof http;
  migrations: typeof migrations;
  notifications: typeof notifications;
  organizations: typeof organizations;
  plugins: typeof plugins;
  plugins_data: typeof plugins_data;
  plugins_data_http: typeof plugins_data_http;
  plugins_data_http_routes: typeof plugins_data_http_routes;
  plugins_runtime: typeof plugins_runtime;
  plugins_runtime_http_routes: typeof plugins_runtime_http_routes;
  plugins_service: typeof plugins_service;
  plugins_service_http_routes: typeof plugins_service_http_routes;
  plugins_ui: typeof plugins_ui;
  plugins_ui_http_routes: typeof plugins_ui_http_routes;
  presence: typeof presence;
  public_api: typeof public_api;
  public_api_files_list_http: typeof public_api_files_list_http;
  public_api_http_auth: typeof public_api_http_auth;
  public_api_http_routes: typeof public_api_http_routes;
  public_api_service_uploads: typeof public_api_service_uploads;
  public_api_service_uploads_http: typeof public_api_service_uploads_http;
  public_api_service_uploads_http_routes: typeof public_api_service_uploads_http_routes;
  quotas: typeof quotas;
  r2: typeof r2;
  r2_client: typeof r2_client;
  r2_http_routes: typeof r2_http_routes;
  rate_limiter: typeof rate_limiter;
  users: typeof users;
  users_http_routes: typeof users_http_routes;
  value_store: typeof value_store;
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
  files_content_materialization_workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"files_content_materialization_workpool">;
  files_upload_conversion_workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"files_upload_conversion_workpool">;
  data_deletion_workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"data_deletion_workpool">;
  github_mounts_workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"github_mounts_workpool">;
  plugins_runtime_workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"plugins_runtime_workpool">;
  rate_limiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rate_limiter">;
  r2: import("@convex-dev/r2/_generated/component.js").ComponentApi<"r2">;
};
