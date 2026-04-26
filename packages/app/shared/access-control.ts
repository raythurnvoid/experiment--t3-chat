import type { Doc } from "../convex/_generated/dataModel";

export type access_control_Role = Doc<"access_control_role_assignments">["role"];
export type access_control_Permission = Doc<"access_control_permission_grants">["permission"];
export type access_control_ResourceKind = Doc<"access_control_permission_grants">["resourceKind"];
export type access_control_PrincipalKind = Doc<"access_control_permission_grants">["principalKind"];
