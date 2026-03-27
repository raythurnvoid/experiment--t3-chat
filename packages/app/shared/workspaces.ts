import { Result } from "./errors-as-values-utils.ts";

// #region names

/** Letters, digits (not first char), single hyphens between segments; min length enforced separately. */
const workspace_project_name_regex = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const workspace_project_name_min_length = 3;

export type workspaces_name_autofix_Options = {
	/**
	 * When `false`, keep trailing hyphens while the user is typing so separators (space, `_`, punctuation)
	 * stay visible as `-` instead of disappearing after end-trim.
	 * Leading hyphens are still removed once the string contains a letter (slug prefix rule).
	 */
	trim_trailing_hyphens?: boolean;
};

/**
 * Normalize user-provided workspace or project name input to kebab-case: ASCII letters, optional digits after the first letter, single hyphens.
 * Lowercase ASCII letters, map other separators to `-`, collapse hyphens, trim leading/trailing hyphens (unless `trim_trailing_hyphens: false`).
 * Drop leading digits until a letter appears so the result can start with a letter when possible.
 */
export function workspaces_name_autofix(raw: string, options?: workspaces_name_autofix_Options) {
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

/**
 * Validate a workspace or project name after autofix (or whenever the string is already normalized).
 */
export function workspaces_name_validate(name: string) {
	const trimmed = name.trim();

	if (trimmed === "") {
		return Result({
			_nay: {
				name: "nay",
				message: "Name cannot be empty",
			},
		});
	}

	if (trimmed.length < workspace_project_name_min_length) {
		return Result({
			_nay: {
				name: "nay",
				message: "Name must be at least 3 characters",
			},
		});
	}

	if (!workspace_project_name_regex.test(trimmed)) {
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
 * Apply autofix, then validate. Use at API boundaries so callers accept messy user input safely.
 */
export function workspaces_name_autofix_and_validate(raw: string) {
	const fixed = workspaces_name_autofix(raw);
	return workspaces_name_validate(fixed);
}

// #endregion names

// #region list sort

/**
 * Stable presentation order for `workspaces.list`: default rows first, then locale-aware name order, `_id` tiebreaker.
 * Keep in sync with routing fallbacks in `app_tenant_default_project_for_workspace` (defaultProjectId, then `default` flag).
 */

export type workspaces_list_sort_WorkspaceShape = {
	_id: string;
	name: string;
	default: boolean;
	defaultProjectId?: string;
};

export type workspaces_list_sort_ProjectShape = {
	_id: string;
	name: string;
	default: boolean;
};

export function workspaces_list_sort_compare_name_then_id(
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

function workspaces_list_sort_project_is_primary_for_workspace(
	workspace: workspaces_list_sort_WorkspaceShape,
	project: workspaces_list_sort_ProjectShape,
): boolean {
	if (workspace.defaultProjectId !== undefined && project._id === workspace.defaultProjectId) {
		return true;
	}

	return project.default;
}

export function workspaces_list_sort_workspaces<T extends workspaces_list_sort_WorkspaceShape>(workspaces: T[]): T[] {
	return [...workspaces].sort((a, b) => {
		const rank = (w: workspaces_list_sort_WorkspaceShape) => (w.default ? 0 : 1);
		const byDefault = rank(a) - rank(b);
		if (byDefault !== 0) {
			return byDefault;
		}

		return workspaces_list_sort_compare_name_then_id(a, b);
	});
}

export function workspaces_list_sort_projects_for_workspace<
	TProject extends workspaces_list_sort_ProjectShape,
	TWorkspace extends workspaces_list_sort_WorkspaceShape,
>(workspace: TWorkspace, projects: TProject[]): TProject[] {
	return [...projects].sort((a, b) => {
		const rank = (p: workspaces_list_sort_ProjectShape) =>
			workspaces_list_sort_project_is_primary_for_workspace(workspace, p) ? 0 : 1;
		const byPrimary = rank(a) - rank(b);
		if (byPrimary !== 0) {
			return byPrimary;
		}

		return workspaces_list_sort_compare_name_then_id(a, b);
	});
}

// #endregion list sort
