import { describe, expect, test } from "vitest";
import {
	playwriter_browser_connect_schema,
	playwriter_browser_operation_schema,
	playwriter_browser_reconnect_schema,
	playwriter_browser_run_schema,
} from "./playwriter-browser.ts";

describe("playwriter_browser_operation_schema", () => {
	test("accepts fixed actions and rejects code, selectors and modifier keys", () => {
		expect(
			playwriter_browser_operation_schema.safeParse({
				kind: "act",
				action: "click",
				lastObservationRevision: "read",
				locator: { by: "role", role: "button", name: "Save" },
			}).success,
		).toBe(true);
		for (const value of [
			{ kind: "read", code: "page.close()" },
			{ kind: "act", action: "click", lastObservationRevision: "read", locator: { by: "css", selector: "body" } },
			{
				kind: "act",
				action: "press",
				lastObservationRevision: "read",
				locator: { by: "label", label: "Note" },
				key: "Control+W",
			},
		])
			expect(playwriter_browser_operation_schema.safeParse(value).success).toBe(false);
	});

	test("refuses Tab while keeping Enter in the fixed key set", () => {
		const operation = {
			kind: "act",
			action: "press",
			lastObservationRevision: "read",
			locator: { by: "label", label: "Note" },
		};
		expect(playwriter_browser_operation_schema.safeParse({ ...operation, key: "Enter" }).success).toBe(true);
		expect(
			playwriter_browser_operation_schema.safeParse({ ...operation, key: "Tab" }).success,
			"Tab must not be advertised as a supported key",
		).toBe(false);
	});
});

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
			selectionRevision: 1,
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
			selectionRevision: 1,
			targetRevision: 1,
			navRevision: 1,
			targetId: "target",
			operation: { kind: "read" },
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
