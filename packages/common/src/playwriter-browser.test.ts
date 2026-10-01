import { describe, expect, test } from "vitest";
import {
	playwriter_browser_connect_schema,
	playwriter_browser_reconnect_schema,
	playwriter_browser_run_schema,
} from "./playwriter-browser.ts";

describe("playwriter_browser_reconnect_schema", () => {
	test("requires the old session identity only on an explicit human restart", () => {
		const input = {
			connectionId: "connection",
			ownerId: "owner",
			organizationId: "org",
			workspaceId: "workspace",
			shareId: "a".repeat(32),
			attemptId: "attempt",
			expectedTargetId: "target",
			paused: true,
			idleExpiresAt: 1,
			totalExpiresAt: 2,
			sessionId: "next",
			operations: 0,
			allowedVersions: ["0.5.0"],
			agentBlockedHosts: [],
			agentAccess: false,
			policyRevision: 1,
			controlRevision: 1,
		};
		expect(playwriter_browser_connect_schema.safeParse(input).success).toBe(true);
		expect(playwriter_browser_reconnect_schema.safeParse(input).success).toBe(false);
		expect(playwriter_browser_reconnect_schema.safeParse({ ...input, previousSessionId: "old" }).success).toBe(true);
		expect(playwriter_browser_connect_schema.safeParse({ ...input, previousSessionId: "old" }).success).toBe(false);
	});
});

describe("playwriter_browser_run_schema", () => {
	test("requires a bounded current version list on trusted Run", () => {
		const input = {
			connectionId: "connection",
			ownerId: "owner",
			organizationId: "org",
			workspaceId: "workspace",
			generation: 1,
			commandId: "command",
			operationHash: "a".repeat(64),
			source: { chatId: "chat", sourceMessageId: "message", toolCallId: "read" },
			deadline: 1,
			receiptResolutionDeadline: 2,
			controlRevision: 1,
			policyRevision: 1,
			targetRevision: 1,
			navRevision: 1,
			targetId: "target",
			operation: { kind: "script", code: "return 1" },
		};
		expect(
			playwriter_browser_run_schema.safeParse(input).success,
			"Run must require the current allowed version list",
		).toBe(false);
		expect(playwriter_browser_run_schema.safeParse({ ...input, allowedVersions: ["0.6.0"] }).success).toBe(true);
		for (const allowedVersions of [[], [""], ["a".repeat(33)], Array.from({ length: 17 }, () => "0.6.0")])
			expect(playwriter_browser_run_schema.safeParse({ ...input, allowedVersions }).success).toBe(false);
	});
});
