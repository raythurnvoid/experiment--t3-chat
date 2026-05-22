import { afterEach, describe, expect, test, vi } from "vitest";
import { handle_r2_event_message, type Env, type QueueMessage, type R2EventNotification } from "./index.ts";

const env = {
	CONVEX_HTTP_URL: "https://example.convex.site/",
	EVENTS_SECRET: "test-secret",
	R2_FILES_BUCKET: "files-bucket",
	R2_UPLOAD_PREFIX: "workspaces/",
} satisfies Env;

function r2_event(overrides: Partial<R2EventNotification> = {}) {
	return {
		action: "object-create",
		bucket: "files-bucket",
		object: {
			key: "workspaces/workspace_1/projects/project_1/assets/asset_1",
			size: 42,
			eTag: "etag",
		},
		eventTime: "2026-05-11T00:00:00.000Z",
		...overrides,
	} satisfies R2EventNotification;
}

function queue_message(body: unknown, overrides: Partial<QueueMessage<unknown>> = {}) {
	return {
		id: "message_1",
		attempts: 1,
		body,
		ack: vi.fn(),
		retry: vi.fn(),
		...overrides,
	} satisfies QueueMessage<unknown>;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("handle_r2_event_message", () => {
	test("forwards valid R2 events to Convex", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await handle_r2_event_message(queue_message(r2_event()), env);

		expect(result).toEqual({
			type: "ack",
			reason: "Convex accepted the event",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.convex.site/api/r2/event",
			expect.objectContaining({
				method: "POST",
				headers: {
					Authorization: "Bearer test-secret",
					"Content-Type": "application/json",
				},
			}),
		);
	});

	test("acks events for other buckets without forwarding", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await handle_r2_event_message(queue_message(r2_event({ bucket: "other-bucket" })), env);

		expect(result.type).toBe("ack");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("acks events outside the upload prefix without forwarding", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await handle_r2_event_message(
			queue_message(
				r2_event({
					object: {
						key: "avatars/user_1.png",
					},
				}),
			),
			env,
		);

		expect(result.type).toBe("ack");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("retries retryable Convex statuses", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("retry", { status: 503 })));

		const result = await handle_r2_event_message(queue_message(r2_event(), { attempts: 2 }), env);

		expect(result).toEqual({
			type: "retry",
			reason: "Convex returned retryable status 503",
			delaySeconds: 4,
		});
	});

	test("retries network failures", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

		const result = await handle_r2_event_message(queue_message(r2_event()), env);

		expect(result).toEqual({
			type: "retry",
			reason: "Convex HTTP request failed",
			delaySeconds: 2,
		});
	});
});
