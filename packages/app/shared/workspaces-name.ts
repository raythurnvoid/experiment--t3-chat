import { Result } from "./errors-as-values-utils.ts";

const workspace_project_name_regex = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * Normalize user-provided workspace or project name input to kebab-case segments (`a-z`, single hyphens).
 * Map every non-letter to `-`, lowercase ASCII letters, collapse hyphens, trim leading/trailing hyphens.
 */
export function workspaces_name_autofix(raw: string) {
	const lower = raw.toLowerCase();
	let out = "";
	for (let i = 0; i < lower.length; i++) {
		const code = lower.charCodeAt(i);
		if (code >= 97 && code <= 122) {
			out += lower[i];
		} else {
			out += "-";
		}
	}

	out = out.replace(/-+/g, "-");
	out = out.replace(/^-+|-+$/g, "");

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
