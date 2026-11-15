import { useQuery } from "convex/react";
import { memo, useEffect, useRef } from "react";

import type { PluginsUiFrame_AgentToolResult } from "@/components/plugins-ui-frame.tsx";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { ai_chat_ui_context_get_shown } from "@/lib/ai-chat-ui-context.ts";
import { ai_chat_ui_instance_get_id } from "@/lib/ai-chat-ui-instance.ts";
import { ai_chat_screen_capture_frame, ai_chat_screen_capture_is_supported } from "@/lib/ai-chat-screen-capture.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel.ts";

type UiCall = FunctionReturnType<typeof app_convex_api.ai_chat_ui_calls.list_pending>[number];

type UiCallResult = FunctionArgs<typeof app_convex_api.ai_chat_ui_calls.complete_call>["result"];

type PageToolRunner = (call: {
	callId: string;
	toolName: string;
	input: unknown;
}) => Promise<PluginsUiFrame_AgentToolResult>;

/**
 * The plugin pages of this tab that can run agent tool calls right now, by `pluginName:pageId`. A
 * page adds itself while its frame runs.
 */
const page_tool_runners = new Map<string, PageToolRunner>();

type SnapshotFrame = { label: string; describe: (ref: string | null) => Promise<string | null> };

/**
 * The running plugin frames of this tab. A frame adds itself while its bridge runs. `describe`
 * answers the page's text, or null when the page shares nothing.
 */
const snapshot_frames = new WeakMap<HTMLIFrameElement, SnapshotFrame>();

/**
 * The last snapshot build, so builds run one at a time. Two builds at once would fight over the
 * main thread and could hand out the same refs.
 */
let snapshot_queue: Promise<unknown> = Promise.resolve();

async function answer_ui_call(call: UiCall): Promise<UiCallResult> {
	const { request } = call;
	// The chat card answers a screenshot call after the member's click. This path runs only in a
	// browser that cannot take the picture.
	if (request.kind === "view_screenshot") {
		return { ok: false, reason: "unsupported" };
	}
	if (request.kind === "page_tool") {
		const runner = page_tool_runners.get(`${request.pluginName}:${request.pageId}`);
		if (!runner) {
			return { ok: false, error: "That plugin page is not open in this tab. Ask the user to open it and try again." };
		}

		const answer = await runner({
			callId: call.callId,
			toolName: request.toolName,
			input: JSON.parse(request.inputJson),
		});
		if (!answer.ok) {
			return { ok: false, error: answer.error };
		}
		try {
			return { ok: true, output: JSON.stringify(answer.output ?? null), snapshot: null };
		} catch {
			return { ok: false, error: "The page answered with a value that is not JSON" };
		}
	}

	const build = snapshot_queue.then(async () => {
		// Load the snapshot code only when the agent first asks, so the main bundle stays small.
		const { view_snapshot_build } = await import("@/lib/view-snapshot.ts");
		return await view_snapshot_build({
			request: { region: request.region, ref: request.ref },
			openPath: ai_chat_ui_context_get_shown()?.node?.path ?? null,
			// An iframe that is not a running plugin frame prints as not readable. A frame that fails to
			// answer prints as one that shared nothing, so one broken plugin does not lose the whole screen.
			describeFrame: async (iframe, ref) => {
				const frame = snapshot_frames.get(iframe);
				return frame ? { label: frame.label, text: await frame.describe(ref).catch(() => null) } : null;
			},
		});
	});
	snapshot_queue = build.catch(() => {});

	const built = await build;
	if (built._nay) {
		return { ok: false, error: built._nay.message };
	}
	return {
		ok: true,
		output: built._yay.text,
		snapshot: { truncated: built._yay.truncated, buildMs: built._yay.buildMs, plugins: built._yay.plugins },
	};
}

/**
 * Take one call for this tab, answer it, and save the answer.
 *
 * A refused claim means the call already ended or was taken, so there is nothing to do.
 */
async function relay_ui_call(args: { membershipId: Id<"organizations_workspaces_users">; call: UiCall }) {
	const { membershipId, call } = args;

	const claimed = await app_convex.mutation(app_convex_api.ai_chat_ui_calls.claim_call, {
		membershipId,
		callId: call.callId,
	});
	if (claimed._nay) {
		return;
	}

	const result = await answer_ui_call(call).catch((error: unknown): UiCallResult => {
		console.error("[AiChatUiCallResponder.relay_ui_call] Failed to answer a call", {
			error,
			callId: call.callId,
			kind: call.request.kind,
		});
		return {
			ok: false,
			error: call.request.kind === "view_snapshot" ? "The app tab failed to read the screen." : "The page call failed.",
		};
	});

	const completed = await app_convex.mutation(app_convex_api.ai_chat_ui_calls.complete_call, {
		membershipId,
		callId: call.callId,
		result,
	});
	if (completed._nay) {
		console.error("[AiChatUiCallResponder.relay_ui_call] Failed to save the answer", {
			error: completed._nay,
			callId: call.callId,
		});
	}
}

/**
 * Answer a screenshot call after the member clicked Share or Decline on the chat card. Return false
 * when the call already ended, so nothing was sent.
 *
 * Share opens the browser prompt first: `getDisplayMedia` works only while the click's user
 * activation lasts, so no network call may come before it. The claim runs at the same time, so the
 * call cannot expire while the member picks what to share. If the claim is refused, the picture is
 * dropped.
 */
async function answer_screenshot_call(args: {
	membershipId: Id<"organizations_workspaces_users">;
	callId: Id<"ai_chat_ui_calls">;
	share: boolean;
}) {
	const { membershipId, callId, share } = args;

	const target = document.getElementById("app_workspace_content" satisfies AppElementId);
	const capture = share && target ? ai_chat_screen_capture_frame(target) : null;
	const claimed = await app_convex.mutation(app_convex_api.ai_chat_ui_calls.claim_call, { membershipId, callId });
	// Wait for the prompt even after a refused claim, so its sharing stops before we return.
	const picture = await capture;
	if (claimed._nay) {
		return false;
	}

	const result: UiCallResult = !share
		? { ok: false, reason: "declined" }
		: !picture
			? { ok: false, reason: "failed" }
			: picture._nay
				? { ok: false, reason: picture._nay.name }
				: { ok: true, image: picture._yay };
	const completed = await app_convex.mutation(app_convex_api.ai_chat_ui_calls.complete_call, {
		membershipId,
		callId,
		result,
	});
	if (completed._nay) {
		console.error("[AiChatUiCallResponder.answer_screenshot_call] Failed to save the answer", {
			error: completed._nay,
			callId,
		});
		return false;
	}
	return true;
}

/**
 * Answer the calls the chat agent sends to this tab: `view_snapshot` and plugin page tools. The chat
 * card answers `view_screenshot` after the member's click. Mount it once in the workspace layout. The list is read for this workspace only, so a tab that shows another
 * workspace never puts that screen into the chat.
 */
const AiChatUiCallResponder = Object.assign(
	memo(function AiChatUiCallResponder() {
		const { membershipId } = AppTenantProvider.useContext();
		// Calls this tab already tried to claim. The live query can list a call again before its claim
		// lands, and a second claim from the same tab would only be refused.
		const seenCallIdsRef = useRef(new Set<string>());

		const pendingCalls = useQuery(app_convex_api.ai_chat_ui_calls.list_pending, {
			membershipId,
			uiInstanceId: ai_chat_ui_instance_get_id(),
		});

		useEffect(() => {
			for (const call of pendingCalls ?? []) {
				if (
					seenCallIdsRef.current.has(call.callId) ||
					(call.request.kind === "view_screenshot" && ai_chat_screen_capture_is_supported())
				) {
					continue;
				}
				seenCallIdsRef.current.add(call.callId);

				relay_ui_call({ membershipId, call }).catch((error: unknown) => {
					console.error("[AiChatUiCallResponder] Unexpected call error", { error, callId: call.callId });
				});
			}
		}, [pendingCalls, membershipId]);

		return null;
	}),
	{
		/**
		 * The screenshot call of one chat tool call, while this tab still has to answer it. Null in
		 * other tabs and after the answer.
		 */
		useScreenshotCall: function useScreenshotCall(toolCallId: string) {
			const { membershipId } = AppTenantProvider.useContext();
			// The same query as the responder, so Convex keeps one subscription.
			const pendingCalls = useQuery(app_convex_api.ai_chat_ui_calls.list_pending, {
				membershipId,
				uiInstanceId: ai_chat_ui_instance_get_id(),
			});

			const call = pendingCalls?.find((pendingCall) => pendingCall.toolCallId === toolCallId);
			return call?.request.kind === "view_screenshot" ? { callId: call.callId, reason: call.request.reason } : null;
		},
		answerScreenshotCall: answer_screenshot_call,
		/**
		 * Let a plugin page run the agent's tool calls for it while its frame runs. Call the returned
		 * function when the frame stops.
		 */
		registerPageToolRunner(args: { pluginName: string; pageId: string; run: PageToolRunner }) {
			const key = `${args.pluginName}:${args.pageId}`;
			page_tool_runners.set(key, args.run);
			return () => {
				if (page_tool_runners.get(key) === args.run) {
					page_tool_runners.delete(key);
				}
			};
		},
		/**
		 * Let the screen snapshot ask a plugin frame what it shows. Call the returned function when the
		 * frame stops.
		 */
		registerSnapshotFrame(iframe: HTMLIFrameElement, frame: SnapshotFrame) {
			snapshot_frames.set(iframe, frame);
			return () => {
				if (snapshot_frames.get(iframe) === frame) {
					snapshot_frames.delete(iframe);
				}
			};
		},
	},
);

export { AiChatUiCallResponder };
