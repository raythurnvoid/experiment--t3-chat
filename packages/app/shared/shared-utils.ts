import { createIdGenerator } from "ai";
import type { KeysOfUnion, LiteralUnion } from "type-fest";

export const ai_chat_HARDCODED_ORG_ID = "app_workspace_local_dev";
export const ai_chat_HARDCODED_PROJECT_ID = "app_project_local_dev";

export const get_id_generator = ((/* iife */) => {
	function value(snakeCasePrefix: string) {
		return createIdGenerator({
			prefix: snakeCasePrefix,
			separator: "-",
			size: 32,
		});
	}

	const cache = new Map<string, ReturnType<typeof value>>();

	return function get_id_generator(snakeCasePrefix: string) {
		const cacheKey = snakeCasePrefix;
		const cachedValue = cache.get(cacheKey);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(snakeCasePrefix);
		cache.set(cacheKey, result);
		return result;
	};
})();

export function generate_id<T extends "page" | "ai_thread" | "ai_message">(snakeCasePrefix: T) {
	const idGenerator = get_id_generator(snakeCasePrefix);
	return idGenerator();
}

/**
 * Clamp a value between a minimum and maximum.
 *
 * @example
 *
 * ```ts
 * math_clamp(10, 0, 100); // 10
 * math_clamp(200, 0, 100); // 100
 * math_clamp(-10, 0, 100); // 0
 * ```
 **/
export function math_clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

export function should_never_happen(message: LiteralUnion<"Missing deps", string>, data: Record<string, any> = {}) {
	console.error("[should_never_happen]", message, data);

	const isDev = ((/* iife */) => {
		try {
			// Vite in the browser/dev server.
			return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
		} catch {
			// The runtime does not support `import.meta`.
			// This can happen in convex functions.
		}

		const nodeEnv = process.env.NODE_ENV;
		return nodeEnv != null ? nodeEnv !== "production" : false;
	})();

	if (isDev) {
		// eslint-disable-next-line no-debugger
		debugger;
	}
	return new Error(
		"[should_never_happen] " +
			message +
			"\n\t" +
			JSON.stringify(data, (_key, value) => (value === undefined ? "<undefined>" : value), "\t"),
	);
}

export function json_strigify_ensured(value: unknown, space: string | number = "\t") {
	try {
		const json = JSON.stringify(value, null, space);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

type ExtractTypeByProperty<O extends object, P extends KeysOfUnion<O>> = Extract<O, { [K in P]?: any }>;

type ExtractTypeByPropertyAndAssertNotUndefined<O extends object, P extends KeysOfUnion<O>> = ExtractTypeByProperty<
	O,
	P
> & {
	[K in P]: Exclude<ExtractTypeByProperty<O, K>[K], undefined>;
};

export function has_defined_property<O extends object, P extends KeysOfUnion<O>>(
	obj: O,
	property: P,
): obj is ExtractTypeByPropertyAndAssertNotUndefined<O, P> {
	return (
		property in obj &&
		/* @ts-expect-error */
		obj[property] !== undefined
	);
}

export function omit_properties<O extends object, P extends KeysOfUnion<O>>(
	obj: O,
	propertiesToExclude: Array<P> | Set<P>,
): Omit<O, P> {
	const propertiesToExcludeSet =
		propertiesToExclude instanceof Set ? propertiesToExclude : new Set(propertiesToExclude);

	const result = {} as Omit<O, P>;

	for (const key of Reflect.ownKeys(obj)) {
		if (propertiesToExcludeSet.has(key as P)) {
			continue;
		}

		Reflect.set(result, key, Reflect.get(obj, key));
	}

	return result;
}

// #region path
export function path_extract_segments_from(path: string): string[] {
	const normalizedPath = path.trim();
	if (normalizedPath === "" || normalizedPath === "/") return [];
	return normalizedPath
		.split(/(?<!\\)\//) // split on / not preceeded by \
		.filter(Boolean);
}

export function path_name_of(path: string): string {
	return path_extract_segments_from(path).at(-1) ?? "";
}
// #endregion path
