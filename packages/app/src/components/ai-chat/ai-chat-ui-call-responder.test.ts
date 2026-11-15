import { afterEach, describe, expect, test, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel.ts";

const calls: string[] = [];
const mutationMock = vi.fn(async (name: string, _args: unknown) => {
	calls.push(name);
	return { _yay: null };
});

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (name: string, args: unknown) => mutationMock(name, args),
	},
	app_convex_api: {
		ai_chat_ui_calls: {
			claim_call: "ai_chat_ui_calls.claim_call",
			complete_call: "ai_chat_ui_calls.complete_call",
			list_pending: "ai_chat_ui_calls.list_pending",
		},
	},
}));

const { AiChatUiCallResponder } = await import("./ai-chat-ui-call-responder.tsx");

describe("AiChatUiCallResponder.answerScreenshotCall", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		calls.length = 0;
		mutationMock.mockClear();
		document.body.replaceChildren();
	});

	// The browser opens the share prompt only while the click's user activation lasts. A network call
	// before it would make every Share click fail as if the member said no.
	test("opens the browser prompt before any network call", async () => {
		const content = document.createElement("div");
		content.id = "app_workspace_content";
		document.body.append(content);
		vi.stubGlobal("navigator", {
			mediaDevices: {
				getDisplayMedia: vi.fn(async () => {
					calls.push("getDisplayMedia");
					throw new DOMException("Closed", "NotAllowedError");
				}),
			},
		});

		const answered = await AiChatUiCallResponder.answerScreenshotCall({
			membershipId: "membership" as Id<"organizations_workspaces_users">,
			callId: "call" as Id<"ai_chat_ui_calls">,
			share: true,
		});

		expect(calls, "the prompt must open before the claim").toEqual([
			"getDisplayMedia",
			"ai_chat_ui_calls.claim_call",
			"ai_chat_ui_calls.complete_call",
		]);
		expect(mutationMock).toHaveBeenLastCalledWith("ai_chat_ui_calls.complete_call", {
			membershipId: "membership",
			callId: "call",
			result: { ok: false, reason: "denied" },
		});
		expect(answered).toBe(true);
	});
});
