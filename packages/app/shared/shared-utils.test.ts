import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { should_never_happen } from "./shared-utils.ts";

const convex_runtime_env_keys = ["CONVEX_CLOUD_URL", "CONVEX_SITE_URL", "CONVEX_URL", "VITE_CONVEX_HTTP_URL"] as const;

const original_runtime_env = Object.fromEntries(
	convex_runtime_env_keys.map((key) => [key, process.env[key]]),
) as Record<(typeof convex_runtime_env_keys)[number], string | undefined>;

function restore_runtime_env() {
	for (const key of convex_runtime_env_keys) {
		const value = original_runtime_env[key];
		if (value === undefined) {
			delete process.env[key];
			continue;
		}

		process.env[key] = value;
	}
}

describe("should_never_happen", () => {
	afterEach(() => {
		restore_runtime_env();
		vi.restoreAllMocks();
	});

	test("returns a plain Error outside Convex runtime", () => {
		for (const key of convex_runtime_env_keys) {
			delete process.env[key];
		}

		const error = should_never_happen("Plain error", { foo: "bar" });

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ConvexError);
		expect(error.message).toContain("[should_never_happen] Plain error");
		expect(error.message).toContain('"foo": "bar"');
	});

	test("returns a ConvexError in Convex runtime and snapshots debug data", () => {
		process.env.CONVEX_URL = "https://example.convex.cloud";
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const debugData = {
			list: [1],
			nested: {
				count: 1,
			},
		};

		const error = should_never_happen("Convex error", debugData);
		debugData.list.push(2);
		debugData.nested.count = 2;

		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<any>).data).toMatchObject({
			message: "[should_never_happen] Convex error",
			data: {
				list: [1],
				nested: {
					count: 1,
				},
			},
		});
		expect(consoleErrorSpy).toHaveBeenCalledWith("[should_never_happen]", "Convex error", expect.any(Object));
	});
});
