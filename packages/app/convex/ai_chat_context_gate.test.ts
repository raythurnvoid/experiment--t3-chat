import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

describe("ai_chat_context_ENABLED", () => {
	// Module resets belong in this file so they cannot replace another test's mocked R2 classes.
	test("turns the feature off when the optional environment value is unset", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const user = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		vi.stubEnv("AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED", undefined);
		vi.resetModules();
		try {
			const module = await import("./ai_chat_context.ts");
			expect(module.ai_chat_context_ENABLED).toBe(false);
			expect(await user.query(api.ai_chat_context.get_catalog, { membershipId: db.membershipId })).toEqual({
				enabled: false,
				status: "complete",
				instructions: [],
				skills: [],
			});
			expect(
				(await t.query(internal.ai_chat_context.discover_sources, { membershipId: db.membershipId, userId: db.userId }))
					._nay?.name,
			).toBe("unavailable");
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});
