import type { LiteralUnion } from "type-fest";

export const ai_chat_HARDCODED_ORG_ID = "app_workspace_local_dev";
export const ai_chat_HARDCODED_PROJECT_ID = "app_project_local_dev";

export function generate_timestamp_uuid<T extends string>(snakeCasePrefix: T): `${T}-${number}-${string}` {
	return `${snakeCasePrefix}-${Date.now()}-${crypto.randomUUID()}`;
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
	if (import.meta.env.DEV) {
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
