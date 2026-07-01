import { describe, expect, test, vi } from "vitest";
import {
	handle_audio_segment_request,
	handle_frame_request,
	type Env,
} from "./index.ts";

function make_env(args: { object?: Uint8Array | null } = {}) {
	const outputCalls: Array<unknown> = [];
	const transformCalls: Array<unknown> = [];
	const object = Object.hasOwn(args, "object") ? args.object : new Uint8Array([1, 2, 3]);
	const env: Env = {
		MEDIA_TRANSFORMER_SECRET: "secret",
		R2_UPLOAD_PREFIX: "organizations/",
		FILES_BUCKET: {
			get: vi.fn(async () => (object ? { body: new Response(object).body! } : null)),
		},
		MEDIA: {
			input: vi.fn(() => ({
				transform: vi.fn((options?: unknown) => {
					transformCalls.push(options);
					return {
						transform: vi.fn(),
						output: vi.fn((outputOptions: unknown) => {
							outputCalls.push(outputOptions);
							return {
								response: vi.fn(async () => new Response(new Uint8Array([4, 5, 6]), { status: 200 })),
							};
						}),
					};
				}),
				output: vi.fn((outputOptions: unknown) => {
					outputCalls.push(outputOptions);
					return {
						response: vi.fn(async () => new Response(new Uint8Array([7, 8, 9]), { status: 200 })),
					};
				}),
			})),
		},
	};

	return { env, outputCalls, transformCalls };
}

function authed_request(path: string, body: unknown, secret = "secret") {
	return new Request(`https://worker.test${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("handle_frame_request", () => {
	test("extracts a scaled JPEG frame from an R2 object", async () => {
		const { env, outputCalls, transformCalls } = make_env();

		const response = await handle_frame_request(
			authed_request("/api/media/frame", { key: "organizations/w/workspaces/p/assets/a", timeSeconds: 5 }),
			env,
		);

		expect(response.status).toBe(200);
		expect(await response.arrayBuffer()).toHaveProperty("byteLength", 3);
		expect(transformCalls).toEqual([{ width: 720, fit: "scale-down" }]);
		expect(outputCalls).toEqual([{ mode: "frame", time: "5s", format: "jpg" }]);
	});

	test("rejects requests outside the R2 upload prefix", async () => {
		const { env } = make_env();

		const response = await handle_frame_request(
			authed_request("/api/media/frame", { key: "other/key.mp4", timeSeconds: 5 }),
			env,
		);

		expect(response.status).toBe(400);
	});

	test("requires the bearer secret", async () => {
		const { env } = make_env();

		const response = await handle_frame_request(
			authed_request("/api/media/frame", { key: "organizations/w/workspaces/p/assets/a", timeSeconds: 5 }, "wrong"),
			env,
		);

		expect(response.status).toBe(401);
	});
});

describe("handle_audio_segment_request", () => {
	test("extracts an M4A audio segment from an R2 object", async () => {
		const { env, outputCalls } = make_env();

		const response = await handle_audio_segment_request(
			authed_request("/api/media/audio-segment", {
				key: "organizations/w/workspaces/p/assets/a",
				startSeconds: 10,
				durationSeconds: 30,
			}),
			env,
		);

		expect(response.status).toBe(200);
		expect(outputCalls).toEqual([{ mode: "audio", time: "10s", duration: "30s", format: "m4a" }]);
	});

	test("keeps segment duration bounded", async () => {
		const { env } = make_env();

		const response = await handle_audio_segment_request(
			authed_request("/api/media/audio-segment", {
				key: "organizations/w/workspaces/p/assets/a",
				startSeconds: 0,
				durationSeconds: 121,
			}),
			env,
		);

		expect(response.status).toBe(400);
	});

	test("returns 404 when the R2 object is missing", async () => {
		const { env } = make_env({ object: null });

		const response = await handle_audio_segment_request(
			authed_request("/api/media/audio-segment", {
				key: "organizations/w/workspaces/p/assets/a",
				startSeconds: 0,
				durationSeconds: 30,
			}),
			env,
		);

		expect(response.status).toBe(404);
	});
});
