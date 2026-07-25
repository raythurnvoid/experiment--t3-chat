/**
 * Helpers for app file paths, e.g. `/docs/api.md`.
 *
 * These are string helpers only, with no notion of a real file or of the current tenant.
 * A segment can contain an escaped `\/`, so always split through `path_extract_segments_from`
 * instead of a plain `split("/")`.
 */
export function path_extract_segments_from(path: string): string[] {
	if (path === "" || path === "/") return [];
	return path
		.split(/(?<!\\)\//) // split on / not preceeded by \
		.filter(Boolean);
}

export function path_name_of(path: string): string {
	return path_extract_segments_from(path).at(-1) ?? "";
}

/**
 * A value reads as a path once it carries a separator, e.g. `/docs`, `docs/api.md` or `docs/`.
 **/
export function path_is_path_like(value: string): boolean {
	return value.includes("/");
}
