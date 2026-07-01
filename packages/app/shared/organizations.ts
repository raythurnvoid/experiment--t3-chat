import { Result } from "./errors-as-values-utils.ts";

// #region names
export const organizations_DEFAULT_ORGANIZATION_NAME = "personal";
export const organizations_DEFAULT_WORKSPACE_NAME = "home";

export const organizations_NAME_MIN_LENGTH = 3;
export const organizations_NAME_MAX_LENGTH = 20;

export type organizations_name_autofix_Options = {
	/**
	 * When `false`, keep trailing hyphens while the user is typing so separators (space, `_`, punctuation)
	 * stay visible as `-` instead of disappearing after end-trim.
	 * Leading hyphens are still removed once the string contains a letter (slug prefix rule).
	 */
	trim_trailing_hyphens?: boolean;
};

/**
 * Normalize user-provided organization or workspace name input to kebab-case: ASCII letters, optional digits after the first letter, single hyphens.
 * Lowercase ASCII letters, map other separators to `-`, collapse hyphens, trim leading/trailing hyphens (unless `trim_trailing_hyphens: false`).
 * Drop leading digits until a letter appears so the result can start with a letter when possible.
 */
export function organizations_name_autofix(raw: string, options?: organizations_name_autofix_Options) {
	const trim_trailing_hyphens = options?.trim_trailing_hyphens ?? true;

	const lower = raw.toLowerCase();
	let out = "";
	for (let i = 0; i < lower.length; i++) {
		const ch = lower[i]!;
		const code = ch.charCodeAt(0);
		if (code >= 97 && code <= 122) {
			out += ch;
		} else if (code >= 48 && code <= 57) {
			// Allow digits only after at least one letter is present in the raw output (first char must be a-z).
			if (/[a-z]/.test(out)) {
				out += ch;
			}
		} else {
			out += "-";
		}
	}

	out = out.replace(/-+/g, "-");

	if (trim_trailing_hyphens) {
		out = out.replace(/^-+|-+$/g, "");
	} else {
		// Keep a lone `-` (or hyphens before any letter) so draft input shows converted separators.
		if (/[a-z]/.test(out)) {
			out = out.replace(/^-+/, "");
		}
	}

	return out;
}

/** Letters, digits (not first char), single hyphens between segments; min length enforced separately. */
const organization_workspace_name_regex = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validate an organization or workspace name after autofix (or whenever the string is already normalized).
 */
export function organizations_name_validate(name: string) {
	const trimmed = name.trim();

	if (trimmed === "") {
		return Result({
			_nay: {
				name: "nay",
				message: "Name cannot be empty",
			},
		});
	}

	if (trimmed.length < organizations_NAME_MIN_LENGTH) {
		return Result({
			_nay: {
				name: "nay",
				message: "Name must be at least 3 characters",
			},
		});
	}

	if (trimmed.length > organizations_NAME_MAX_LENGTH) {
		return Result({
			_nay: {
				name: "nay",
				message: "Name must be at most 20 characters",
			},
		});
	}

	if (trimmed.endsWith("-")) {
		return Result({
			_nay: {
				name: "nay",
				message: "Name cannot end with a hyphen",
			},
		});
	}

	if (!organization_workspace_name_regex.test(trimmed)) {
		return Result({
			_nay: {
				name: "nay",
				message: "Invalid name",
			},
		});
	}

	return Result({
		_yay: trimmed,
	});
}

/**
 * Maximum stored length for organization/workspace description (after trim).
 */
export const organizations_DESCRIPTION_MAX_LENGTH = 50;

/**
 * Normalize user-provided description: trim; empty after trim → store as `""`; reject when longer than
 * {@link organizations_DESCRIPTION_MAX_LENGTH}.
 */
export function organizations_description_normalize(raw: string) {
	const trimmed = raw.trim();

	if (trimmed.length > organizations_DESCRIPTION_MAX_LENGTH) {
		return Result({
			_nay: {
				name: "nay",
				message: "Description is too long",
			},
		});
	}

	return Result({
		_yay: trimmed,
	});
}

export type organizations_switcher_list_secondary_line_Args = {
	storedDescription: string;
	isDefaultOrganization: boolean;
	isPrimaryWorkspace: boolean;
};

/**
 * Build secondary line copy for organization/workspace switcher lists: prefer stored description, then default labels.
 */
export function organizations_switcher_list_secondary_line(args: organizations_switcher_list_secondary_line_Args) {
	const text = args.storedDescription;
	if (text !== "") {
		return text;
	}
	if (args.isDefaultOrganization) {
		return "Default organization";
	}
	if (args.isPrimaryWorkspace) {
		return "Default workspace";
	}
	return "";
}

/**
 * Apply autofix, then validate. Use at API boundaries so callers accept messy user input safely.
 */
export function organizations_name_autofix_and_validate(raw: string) {
	const fixed = organizations_name_autofix(raw);
	return organizations_name_validate(fixed);
}

// #endregion names

// #region special ids

/**
 * Special non-`Id` organization sentinel for read-only mounts (e.g. the GitHub mirror). NOT a real
 * `Id<"organizations">` and has no backing doc; only legal in the file/source-mount content-storage tables,
 * where the schema accepts it via `v.literal(...)`. This constant is the single source of truth — the
 * schema literal type and `typeof organizations_GLOBAL_ORGANIZATION_ID` track it, so changing the value propagates.
 */
export const organizations_GLOBAL_ORGANIZATION_ID = "GLOBAL";

/**
 * Special non-`Id` workspace sentinel for the GitHub read-only mount. NOT a real `Id<"organizations_workspaces">`
 * and has no backing doc; only legal in the file/source-mount content-storage tables, where the schema
 * accepts it via `v.literal(...)`. The stored value is `"GITHUB"`. This constant is the single source of
 * truth — the schema literal type and `typeof organizations_GLOBAL_GITHUB_WORKSPACE_ID` track it, so changing
 * the value propagates.
 */
export const organizations_GLOBAL_GITHUB_WORKSPACE_ID = "GITHUB";

/**
 * Type guard that narrows a `realId | sentinel` organization field to its real-id arm in the false branch
 * (e.g. `Id<"organizations"> | "GLOBAL"` → `Id<"organizations">`). Generic so `shared/` stays free of the
 * Convex `Id<...>` types; the predicate subtracts the sentinel literal from the caller's union.
 */
export function organizations_is_global_organization_id<T>(
	organizationId: T | typeof organizations_GLOBAL_ORGANIZATION_ID,
): organizationId is typeof organizations_GLOBAL_ORGANIZATION_ID {
	return organizationId === organizations_GLOBAL_ORGANIZATION_ID;
}

/**
 * Type guard that narrows a `realId | sentinel` workspace field to its real-id arm in the false branch
 * (e.g. `Id<"organizations_workspaces"> | "GITHUB"` → `Id<"organizations_workspaces">`). Generic so `shared/` stays
 * free of the Convex `Id<...>` types; the predicate subtracts the sentinel literal from the caller's union.
 */
export function organizations_is_global_github_workspace_id<T>(
	workspaceId: T | typeof organizations_GLOBAL_GITHUB_WORKSPACE_ID,
): workspaceId is typeof organizations_GLOBAL_GITHUB_WORKSPACE_ID {
	return workspaceId === organizations_GLOBAL_GITHUB_WORKSPACE_ID;
}

// #endregion special ids

// #region list sort

/**
 * Stable presentation order for `organizations.list`: default rows first, then locale-aware name order, `_id` tiebreaker.
 * Keep in sync with routing fallbacks in `app_tenant_default_workspace_for_organization` (defaultWorkspaceId, then `default` flag).
 */

export type organizations_list_sort_OrganizationShape = {
	_id: string;
	name: string;
	default: boolean;
	defaultWorkspaceId?: string;
};

export type organizations_list_sort_WorkspaceShape = {
	_id: string;
	name: string;
	default: boolean;
};

export function organizations_list_sort_compare_name_then_id(
	a: { name: string; _id: string },
	b: { name: string; _id: string },
): number {
	const primary = a.name.localeCompare(b.name, undefined, {
		numeric: true,
		sensitivity: "base",
	});
	if (primary !== 0) {
		return primary;
	}

	return a._id.localeCompare(b._id);
}

export function organizations_list_sort_organizations<T extends organizations_list_sort_OrganizationShape>(
	organizations: T[],
): T[] {
	return [...organizations].sort((a, b) => {
		const rank = (organization: organizations_list_sort_OrganizationShape) => (organization.default ? 0 : 1);
		const byDefault = rank(a) - rank(b);
		if (byDefault !== 0) {
			return byDefault;
		}

		return organizations_list_sort_compare_name_then_id(a, b);
	});
}

export function organizations_list_sort_workspaces_for_organization<
	TWorkspace extends organizations_list_sort_WorkspaceShape,
	TOrganization extends organizations_list_sort_OrganizationShape,
>(organization: TOrganization, workspaces: TWorkspace[]): TWorkspace[] {
	return [...workspaces].sort((a, b) => {
		const rank = (p: organizations_list_sort_WorkspaceShape) =>
			(organization.defaultWorkspaceId !== undefined && p._id === organization.defaultWorkspaceId) || p.default ? 0 : 1;
		const byPrimary = rank(a) - rank(b);
		if (byPrimary !== 0) {
			return byPrimary;
		}

		return organizations_list_sort_compare_name_then_id(a, b);
	});
}

// #endregion list sort
