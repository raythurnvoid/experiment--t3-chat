import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Id } from "../../../convex/_generated/dataModel.ts";

// The responder reads its tenant, its pending calls, and the snapshot build from these. `set`
// renders the responder again, like a live query update or a route change would.
const tab = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	const value = {
		version: 0,
		membershipId: "membership_a",
		pendingCalls: [] as unknown[],
		finishBuild: null as ((built: unknown) => void) | null,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set: (next: { membershipId?: string; pendingCalls?: unknown[] }) => {
			Object.assign(value, next, { version: value.version + 1 });
			for (const listener of listeners) listener();
		},
	};
	return value;
});

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQuery: () => {
			useSyncExternalStore(tab.subscribe, () => tab.version);
			return tab.pendingCalls;
		},
	};
});

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: tab.membershipId }) },
}));

vi.mock("@/lib/view-snapshot.ts", () => ({
	view_snapshot_build: () =>
		new Promise((resolve) => {
			tab.finishBuild = resolve;
		}),
}));

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

describe("AiChatUiCallResponder", () => {
	const snapshot_call = (callId: string) => ({
		callId,
		toolCallId: `tool_${callId}`,
		request: { kind: "view_snapshot", region: "screen", ref: null },
	});

	const built = (text: string) => ({ _yay: { text, truncated: false, buildMs: 1, plugins: [] } });

	// Read the resolver through a function: TypeScript narrows `tab.finishBuild` to null after the reset below.
	const finish_build = (text: string) => tab.finishBuild?.(built(text));

	// The responder stays mounted when the tab opens another workspace. A screen read that was still
	// building then reads the new workspace, and must not save it into the old workspace's chat.
	test("sends no screen text after the tab moved to another workspace", async () => {
		tab.set({ pendingCalls: [snapshot_call("call_same")] });
		const view = render(createElement(AiChatUiCallResponder));
		await vi.waitFor(() => expect(tab.finishBuild).not.toBeNull());
		finish_build("Workspace A screen");
		await vi.waitFor(() =>
			expect(mutationMock, "a tab that stayed sends its screen").toHaveBeenLastCalledWith(
				"ai_chat_ui_calls.complete_call",
				expect.objectContaining({ result: expect.objectContaining({ ok: true, output: "Workspace A screen" }) }),
			),
		);

		tab.finishBuild = null;
		act(() => tab.set({ pendingCalls: [snapshot_call("call_moved")] }));
		await vi.waitFor(() => expect(tab.finishBuild).not.toBeNull());
		act(() => tab.set({ membershipId: "membership_b", pendingCalls: [] }));
		finish_build("Workspace B screen");
		await vi.waitFor(() =>
			expect(mutationMock, "a tab that moved sends no screen").toHaveBeenLastCalledWith(
				"ai_chat_ui_calls.complete_call",
				{
					membershipId: "membership_a",
					callId: "call_moved",
					result: { ok: false, error: "The app tab moved to another workspace while it read the screen." },
				},
			),
		);
		view.unmount();
	});
});
