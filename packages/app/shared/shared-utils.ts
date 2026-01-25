import { createIdGenerator } from "ai";
import type { LiteralUnion } from "type-fest";

export const ai_chat_HARDCODED_ORG_ID = "app_workspace_local_dev";
export const ai_chat_HARDCODED_PROJECT_ID = "app_project_local_dev";

const get_id_generator = ((/* iife */) => {
	function value(snakeCasePrefix: string) {
		return createIdGenerator({
			prefix: snakeCasePrefix,
			separator: "-",
			size: 32,
		});
	}

	const cache = new Map<string, ReturnType<typeof value>>();

	return function get_id_generator(snakeCasePrefix: string) {
		const cachedValue = cache.get(snakeCasePrefix);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(snakeCasePrefix);
		cache.set(snakeCasePrefix, result);
		return result;
	};
})();

export function generate_id<T extends "page" | "ai_thread">(snakeCasePrefix: T) {
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
