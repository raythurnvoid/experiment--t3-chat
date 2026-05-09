import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { composite_id, composite_key, should_never_happen } from "./shared-utils.ts";

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

describe("composite_id", () => {
	test("joins files room ids with double colons", () => {
		const id = composite_id("rooms", "files_nodes", "workspace_1", "project_1", "file_1");

		expect(id).toBe("files_nodes::workspace_1::project_1::file_1");
	});

	test("joins billing event ids with double colons", () => {
		const id = composite_id("billing", "manual_credit", "user_1", 123456);

		expect(id).toBe("manual_credit::user_1::123456");
	});

	test("joins file save ids with double colons", () => {
		const id = composite_id(
			"billing",
			"file_save",
			"billed_user_1",
			"actor_user_1",
			"workspace_1",
			"project_1",
			"file_1",
			42,
		);

		expect(id).toBe("file_save::billed_user_1::actor_user_1::workspace_1::project_1::file_1::42");
	});

	test("joins monthly credit ids with double colons", () => {
		const id = composite_id("billing", "monthly_credit", "user_1", "sub_1", "2026-01-01");

		expect(id).toBe("monthly_credit::user_1::sub_1::2026-01-01");
	});

	test("joins AI usage ids with double colons", () => {
		const id = composite_id(
			"billing",
			"ai_usage",
			"billed_user_1",
			"actor_user_1",
			"workspace_1",
			"project_1",
			"thread_1",
			"message_1",
		);

		expect(id).toBe("ai_usage::billed_user_1::actor_user_1::workspace_1::project_1::thread_1::message_1");
	});
});

describe("composite_key", () => {
	test("joins arbitrary cache key parts with double colons", () => {
		const key = composite_key("node_path_validation_cache_key", "scope_1", "parent_1", "file", "docs/readme.md");

		expect(key).toBe("node_path_validation_cache_key::scope_1::parent_1::file::docs/readme.md");
	});
});

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

		if (error instanceof ConvexError) {
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
		} else {
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ConvexError);
			expect(error.message).toContain("[should_never_happen] Convex error");
			expect(error.message).toContain('"list": [');
			expect(error.message).toContain('"nested": {');
			expect(error.message).toContain('"count": 1');
		}

		expect(consoleErrorSpy).toHaveBeenCalledWith("[should_never_happen]", "Convex error", expect.any(Object));
	});
});
