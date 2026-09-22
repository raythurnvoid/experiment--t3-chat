import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

describe("ai_chat_context_ENABLED", () => {
	// Module resets belong in this file so they cannot replace another test's mocked R2 classes.
	test("turns the feature off when the optional environment value is unset", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const thread = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: db.userId })
			.mutation(api.ai_chat.thread_create, {
				membershipId: db.membershipId,
				clientGeneratedId: "context-gate",
				lastMessageAt: Date.now(),
			});
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			membershipId: db.membershipId,
			userId: db.userId,
		});
		if (thread._nay || captured._nay) throw new Error("Expected source chat");
		const source = { ...db, threadId: thread._yay.threadId, membershipLifetime: captured._yay.membershipLifetime };
		// The flag is read once at module load, so the env is stubbed and the registry reset before import.
		vi.stubEnv("AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED", undefined);
		vi.resetModules();
		try {
			const contextModule = await import("./ai_chat_context.ts");
			expect(contextModule.ai_chat_context_ENABLED).toBe(false);
			expect((await t.query(internal.ai_chat_context.discover_sources, { source }))._nay?.name).toBe("unavailable");
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});
