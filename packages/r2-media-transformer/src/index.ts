type R2ObjectBody = {
	body: ReadableStream<Uint8Array>;
};

type R2BucketBinding = {
	get: (key: string) => Promise<R2ObjectBody | null>;
};

type MediaOutput = {
	response: () => Promise<Response>;
};

type MediaInput = {
	transform: (options?: { width?: number; height?: number; fit?: "contain" | "cover" | "scale-down" }) => MediaInput;
	output: (options: {
		mode: "frame" | "audio";
		time?: string;
		duration?: string;
		format?: "jpg" | "m4a";
	}) => MediaOutput;
};

type MediaBinding = {
	input: (stream: ReadableStream<Uint8Array>) => MediaInput;
};

type MediaSource = { key: string } | { sourceUrl: string };

export type Env = {
	FILES_BUCKET: R2BucketBinding;
	MEDIA: MediaBinding;
	MEDIA_TRANSFORMER_SECRET: string;
	R2_UPLOAD_PREFIX: string;
};

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json_response(body: unknown, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function is_authorized(request: Request, env: Env) {
	const header = request.headers.get("Authorization");
	return header === `Bearer ${env.MEDIA_TRANSFORMER_SECRET}`;
}

async function read_json_request(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}

	return is_record(body) ? body : null;
}

function finite_non_negative_number(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parse_source_url(value: unknown) {
	if (typeof value !== "string") {
		return null;
	}

	const sourceUrl = value.trim();
	if (!sourceUrl) {
		return null;
	}

	let url: URL;
	try {
		url = new URL(sourceUrl);
	} catch {
		return null;
	}

	if (url.protocol !== "https:") {
		return null;
	}

	return sourceUrl;
}

function parse_base_request_body(body: Record<string, unknown>, env: Env) {
	// The endpoint is secret-gated: Convex authorizes the source file first, then
	// sends either an upload-owned R2 key or a presigned https URL for it.
	if (typeof body.key === "string" && body.key.startsWith(env.R2_UPLOAD_PREFIX)) {
		return { key: body.key } satisfies MediaSource;
	}

	const sourceUrl = parse_source_url(body.sourceUrl);
	if (!sourceUrl) {
		return null;
	}

	return { sourceUrl } satisfies MediaSource;
}

function parse_frame_request_body(body: Record<string, unknown> | null, env: Env) {
	if (!body) {
		return null;
	}

	const base = parse_base_request_body(body, env);
	if (!base || !finite_non_negative_number(body?.timeSeconds)) {
		return null;
	}

	return {
		source: base,
		timeSeconds: body.timeSeconds,
	};
}

function parse_audio_segment_request_body(body: Record<string, unknown> | null, env: Env) {
	if (!body) {
		return null;
	}

	const base = parse_base_request_body(body, env);
	if (!base || !finite_non_negative_number(body?.startSeconds) || !finite_non_negative_number(body?.durationSeconds)) {
		return null;
	}

	const startSeconds = body.startSeconds;
	const durationSeconds = body.durationSeconds;
	if (durationSeconds <= 0 || durationSeconds > 120) {
		return null;
	}

	return {
		source: base,
		startSeconds,
		durationSeconds,
	};
}

function cache_control_header() {
	return { "Cache-Control": "no-store" };
}

async function media_response_or_error(transform: () => Promise<Response>) {
	try {
		const response = await transform();
		if (!response.ok) {
			// Preserve Cloudflare Media's status/body so Convex can distinguish
			// deterministic extraction failures from transient Worker errors.
			return new Response(await response.arrayBuffer(), {
				status: response.status,
				headers: response.headers,
			});
		}

		return response;
	} catch (error) {
		console.error("Media transformation failed", { error });
		return json_response({ error: "Media transformation failed" }, 422);
	}
}

async function load_r2_video(key: string, env: Env) {
	const object = await env.FILES_BUCKET.get(key);
	if (!object) {
		return null;
	}

	return object.body;
}

async function load_source_url_video(sourceUrl: string) {
	let response: Response;
	try {
		response = await fetch(sourceUrl);
	} catch (error) {
		console.error("Source URL fetch failed", { error });
		return null;
	}

	if (!response.ok || !response.body) {
		return null;
	}

	return response.body;
}

async function load_video_source(source: MediaSource, env: Env) {
	if ("key" in source) {
		const stream = await load_r2_video(source.key, env);
		if (!stream) {
			return { response: json_response({ error: "R2 object not found" }, 404) };
		}

		return { stream };
	}

	const stream = await load_source_url_video(source.sourceUrl);
	if (!stream) {
		return { response: json_response({ error: "Source URL fetch failed" }, 400) };
	}

	return { stream };
}

export async function handle_frame_request(request: Request, env: Env) {
	if (!is_authorized(request, env)) {
		return json_response({ error: "Unauthorized" }, 401);
	}

	const body = await read_json_request(request);
	const parsed = parse_frame_request_body(body, env);
	if (!parsed) {
		return json_response({ error: "Invalid frame request" }, 400);
	}

	const loaded = await load_video_source(parsed.source, env);
	if ("response" in loaded) {
		return loaded.response;
	}

	const result = await media_response_or_error(async () => {
		return await env.MEDIA.input(loaded.stream)
			// Keep sampled frames small; they are prompt context, not downloadable
			// preview assets, and OpenAI only needs enough pixels to understand them.
			.transform({ width: 720, fit: "scale-down" })
			.output({ mode: "frame", time: `${parsed.timeSeconds}s`, format: "jpg" })
			.response();
	});
	result.headers.set("Content-Type", result.headers.get("Content-Type") ?? "image/jpeg");
	for (const [name, value] of Object.entries(cache_control_header())) {
		result.headers.set(name, value);
	}
	return result;
}

export async function handle_audio_segment_request(request: Request, env: Env) {
	if (!is_authorized(request, env)) {
		return json_response({ error: "Unauthorized" }, 401);
	}

	const body = await read_json_request(request);
	const parsed = parse_audio_segment_request_body(body, env);
	if (!parsed) {
		return json_response({ error: "Invalid audio segment request" }, 400);
	}

	const loaded = await load_video_source(parsed.source, env);
	if ("response" in loaded) {
		return loaded.response;
	}

	const result = await media_response_or_error(async () => {
		return await env.MEDIA.input(loaded.stream)
			.output({
				mode: "audio",
				time: `${parsed.startSeconds}s`,
				// Keep segment duration bounded by validation above so transcription
				// never receives an unexpectedly large Worker-produced payload.
				duration: `${parsed.durationSeconds}s`,
				format: "m4a",
			})
			.response();
	});
	result.headers.set("Content-Type", result.headers.get("Content-Type") ?? "audio/mp4");
	for (const [name, value] of Object.entries(cache_control_header())) {
		result.headers.set(name, value);
	}
	return result;
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		if (request.method !== "POST") {
			return json_response({ error: "Method not allowed" }, 405);
		}

		if (url.pathname === "/api/media/frame") {
			return await handle_frame_request(request, env);
		}

		if (url.pathname === "/api/media/audio-segment") {
			return await handle_audio_segment_request(request, env);
		}

		return json_response({ error: "Not found" }, 404);
	},
};
