// Prefixed client-generated ids ("ai_thread-...", "ai_message-...").
//
// Lives in its own module because `createIdGenerator` comes from the "ai" package: importing it
// from `shared-utils.ts` used to pull the whole AI SDK into every Convex module's evaluation.

import { createIdGenerator } from "ai";

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

export type GeneratedIdPrefixKey = "file" | "ai_thread" | "ai_message";
export type GeneratedIdPrefix = `${GeneratedIdPrefixKey}-`;

export function generate_id<T extends GeneratedIdPrefixKey>(snakeCasePrefix: T): `${T}-${string}` {
	const idGenerator = get_id_generator(snakeCasePrefix);
	return idGenerator() as `${T}-${string}`;
}
