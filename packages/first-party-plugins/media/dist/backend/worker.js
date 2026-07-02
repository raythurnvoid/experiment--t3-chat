const TEMPORARY_URL_EXPIRES_SECONDS = 15 * 60;
const VIDEO_FRAME_SAMPLE_SECONDS = [0];
const VIDEO_AUDIO_SEGMENT_START_SECONDS = [0];
const VIDEO_AUDIO_SEGMENT_DURATION_SECONDS = 60;
const VIDEO_TRANSFORM_RETRY_ATTEMPTS = 1;
const VIDEO_TRANSFORM_RETRY_DELAY_MS = 5000;
const SOURCE_TRANSCRIPTION_MAX_BYTES = 5 * 1024 * 1024;
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

const IMAGE_SYSTEM_PROMPT =
	"Describe uploaded images for an app file tree. Write useful, concrete Markdown for a reader who cannot see the image. Include visible text, UI details, objects, people, layout, and any uncertainty. Return raw Markdown without wrapping it in a code fence.";

const VIDEO_SUMMARY_SYSTEM_PROMPT =
	"Summarize uploaded videos for an app file tree. Use the transcript and sampled frames to produce concise, useful Markdown. Call out visible UI, slides, people, actions, and uncertainty when the samples are incomplete. Return raw Markdown without wrapping it in a code fence.";

function normalizeContentType(value) {
	return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : null;
}

function mediaKind(contentType) {
	switch (normalizeContentType(contentType)) {
		case "image/jpeg":
		case "image/png":
		case "image/webp":
		case "image/gif":
			return "image";
		case "video/mp4":
		case "video/webm":
		case "video/mpeg":
		case "video/quicktime":
			return "video";
		default:
			return null;
	}
}

function skipped() {
	return new Response(null, {
		status: 204,
		headers: { "X-Bonobo-Skipped": "unsupported_content_type" },
	});
}

function json(body, status = 200) {
	return Response.json(body, { status });
}

async function readEvent(request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function getSource(event) {
	const source = event && typeof event === "object" ? event.source : null;
	if (!source || typeof source !== "object" || typeof source.name !== "string") {
		return null;
	}

	return source;
}

async function requireSecret(env, name) {
	const value = await env.BONOBO.secrets.get(name);
	if (!value) {
		throw new Error(`${name} is not configured`);
	}
	return value;
}

function normalizeBaseUrl(value) {
	return value.replace(/\/+$/u, "");
}

function unwrapMarkdown(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
	return fenced?.[1]?.trim() ?? trimmed;
}

function base64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function bytesToBase64(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
		const chunk = bytes.subarray(offset, offset + 8192);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function textBytes(text) {
	return new TextEncoder().encode(text);
}

function concatBytes(chunks) {
	const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function sanitizeMultipartFilename(filename) {
	return filename.replace(/["\\\r\n]/gu, "_");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function outboundBase64(env, args, serviceName) {
	let response = null;
	for (let attempt = 0; attempt < VIDEO_TRANSFORM_RETRY_ATTEMPTS; attempt += 1) {
		response = await env.BONOBO.outbound.fetch({
			...args,
			responseType: "base64",
		});
		if (response.status !== 404 || attempt === VIDEO_TRANSFORM_RETRY_ATTEMPTS - 1) {
			break;
		}
		await sleep(VIDEO_TRANSFORM_RETRY_DELAY_MS);
	}
	if (response?.status === 404 || response?.status === 422) {
		return null;
	}
	if (!response?.ok) {
		throw new Error(`${serviceName} returned HTTP ${response?.status ?? "unknown"}`);
	}
	if (!response.bodyBase64) {
		return null;
	}

	return {
		bodyBase64: response.bodyBase64,
		contentType: headerValue(response.headers, "content-type") ?? "application/octet-stream",
	};
}

function headerValue(headers, name) {
	if (!headers || typeof headers !== "object") {
		return null;
	}
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && typeof value === "string") {
			return value;
		}
	}
	return null;
}

async function sourceTemporaryUrl(env) {
	const result = await env.BONOBO.files.source.temporaryUrl({
		expiresInSeconds: TEMPORARY_URL_EXPIRES_SECONDS,
	});
	if (!result || typeof result.url !== "string") {
		throw new Error("Source temporary URL is unavailable");
	}
	return result.url;
}

async function mediaSourceFor(env, source) {
	return { sourceUrl: await sourceTemporaryUrl(env) };
}

async function hostGenerateText(env, args) {
	const result = await env.BONOBO_HOST.generateText(args);
	if (!result || typeof result.text !== "string") {
		throw new Error("Host generateText returned no text");
	}
	return unwrapMarkdown(result.text);
}

async function describeImage(env, source) {
	const description = await hostGenerateText(env, {
		system: IMAGE_SYSTEM_PROMPT,
		prompt: `Describe this uploaded image named ${source.name}.`,
		includeSourceImage: true,
		maxOutputTokens: 900,
	});

	const markdown = `# Image description: ${source.name}\n\n${description || "No image description could be generated."}`;
	await env.BONOBO.files.writeMarkdown({
		path: `${source.name}.description.md`,
		markdown,
		overwrite: "replace",
	});
	return json({ ok: true, files: [`${source.name}.description.md`] });
}

async function fetchVideoFrame(env, transformerUrl, transformerSecret, mediaSource, timeSeconds) {
	return await outboundBase64(
		env,
		{
			url: `${normalizeBaseUrl(transformerUrl)}/api/media/frame`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${transformerSecret}`,
				"Content-Type": "application/json",
			},
			bodyText: JSON.stringify({ ...mediaSource, timeSeconds }),
		},
		"Cloudflare media transformer frame extraction",
	);
}

async function fetchVideoAudioSegment(env, transformerUrl, transformerSecret, mediaSource, startSeconds) {
	return await outboundBase64(
		env,
		{
			url: `${normalizeBaseUrl(transformerUrl)}/api/media/audio-segment`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${transformerSecret}`,
				"Content-Type": "application/json",
			},
			bodyText: JSON.stringify({
				...mediaSource,
				startSeconds,
				durationSeconds: VIDEO_AUDIO_SEGMENT_DURATION_SECONDS,
			}),
		},
		"Cloudflare media transformer audio extraction",
	);
}

async function transcribeAudioSegment(env, audio, startSeconds) {
	const result = await env.BONOBO.ai.transcribeAudio({
		audioBase64: audio.bodyBase64,
		contentType: audio.contentType || "audio/mp4",
		language: "en",
	});
	const text = result && typeof result.text === "string" ? result.text.trim() : "";
	return text ? { startSeconds, text } : null;
}

function transcriptionTextFromPayload(payload) {
	if (!payload || typeof payload !== "object") {
		return "";
	}
	if (typeof payload.text === "string") {
		return payload.text.trim();
	}
	if (Array.isArray(payload.segments)) {
		return payload.segments
			.map((segment) => (segment && typeof segment.text === "string" ? segment.text.trim() : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

async function transcribeSourceUpload(env, source) {
	try {
		const sourceBytes = await env.BONOBO.files.source.base64({ maxBytes: SOURCE_TRANSCRIPTION_MAX_BYTES });
		if (!sourceBytes || typeof sourceBytes.bodyBase64 !== "string") {
			return null;
		}
		const sourceContentType =
			typeof sourceBytes.contentType === "string" && sourceBytes.contentType.length > 0
				? sourceBytes.contentType
				: source.contentType || "video/mp4";
		try {
			const workersAiResult = await env.BONOBO.ai.transcribeAudio({
				audioBase64: sourceBytes.bodyBase64,
				contentType: sourceContentType,
				language: "en",
			});
			const workersAiText =
				workersAiResult && typeof workersAiResult.text === "string" ? workersAiResult.text.trim() : "";
			if (workersAiText) {
				return { startSeconds: 0, text: workersAiText };
			}
		} catch (error) {
			console.warn("Workers AI source transcription failed", {
				message: error instanceof Error ? error.message : String(error),
			});
		}

		const openaiKey = await requireSecret(env, "OPENAI_API_KEY");
		const boundary = `bonobo-plugin-${crypto.randomUUID()}`;
		const sourceBinary = base64ToBytes(sourceBytes.bodyBase64);
		const bodyBytes = concatBytes([
			textBytes(
				`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${OPENAI_TRANSCRIPTION_MODEL}\r\n` +
					`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
					`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${sanitizeMultipartFilename(
						source.name,
					)}"\r\nContent-Type: ${sourceContentType}\r\n\r\n`,
			),
			sourceBinary,
			textBytes(`\r\n--${boundary}--\r\n`),
		]);

		const response = await env.BONOBO.outbound.fetch({
			url: "https://api.openai.com/v1/audio/transcriptions",
			method: "POST",
			headers: {
				Authorization: `Bearer ${openaiKey}`,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			bodyBase64: bytesToBase64(bodyBytes),
			responseType: "text",
		});
		if (response.status === 400 || response.status === 413 || response.status === 422) {
			return null;
		}
		if (!response.ok) {
			throw new Error(`OpenAI transcription returned HTTP ${response.status}`);
		}
		const payload = JSON.parse(response.bodyText || "{}");
		const text = transcriptionTextFromPayload(payload);
		return text ? { startSeconds: 0, text } : null;
	} catch (error) {
		console.warn("Source transcription failed", {
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function collectVideoSamples(env, transformerUrl, transformerSecret, mediaSource) {
	const [frames, segments] = await Promise.all([
		(async () => {
			const frames = [];
			for (const timeSeconds of VIDEO_FRAME_SAMPLE_SECONDS) {
				const frame = await fetchVideoFrame(env, transformerUrl, transformerSecret, mediaSource, timeSeconds);
				if (!frame) {
					if (timeSeconds > 0) break;
					continue;
				}
				frames.push({ timeSeconds, ...frame });
			}
			return frames;
		})(),
		(async () => {
			const segments = [];
			for (const startSeconds of VIDEO_AUDIO_SEGMENT_START_SECONDS) {
				const audio = await fetchVideoAudioSegment(env, transformerUrl, transformerSecret, mediaSource, startSeconds);
				if (!audio) {
					if (startSeconds > 0) break;
					continue;
				}
				const segment = await transcribeAudioSegment(env, audio, startSeconds);
				if (segment) {
					segments.push(segment);
				}
			}
			return segments;
		})(),
	]);

	return { frames, segments };
}

function formatSeconds(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function transcriptMarkdown(sourceName, segments) {
	const body =
		segments.length === 0
			? "No speech transcript could be generated from the sampled audio segments."
			: segments.map((segment) => `## ${formatSeconds(segment.startSeconds)}\n\n${segment.text}`).join("\n\n");
	return `# Transcript: ${sourceName}\n\n${body}`;
}

function fallbackVideoSummary(frames, segments) {
	const transcriptText = segments.map((segment) => segment.text).join("\n\n").trim();
	if (transcriptText) {
		return `Transcript was generated from the uploaded video. Summary generation from the host model was unavailable, so this file includes the transcript text that the plugin extracted:\n\n${transcriptText}`;
	}
	if (frames.length > 0) {
		return `The plugin extracted ${frames.length} sampled frame${frames.length === 1 ? "" : "s"}, but no speech transcript was generated.`;
	}
	return "No video summary could be generated from the sampled frames or audio.";
}

async function summarizeVideo(env, source) {
	const [transformerUrl, transformerSecret] = await Promise.all([
		requireSecret(env, "CLOUDFLARE_MEDIA_TRANSFORMER_URL"),
		requireSecret(env, "CLOUDFLARE_MEDIA_TRANSFORMER_SECRET"),
	]);
	const mediaSource = await mediaSourceFor(env, source);
	let { frames, segments } = await collectVideoSamples(env, transformerUrl, transformerSecret, mediaSource);
	if (frames.length === 0 && segments.length === 0 && "key" in mediaSource) {
		const sourceUrl = await sourceTemporaryUrl(env);
		({ frames, segments } = await collectVideoSamples(env, transformerUrl, transformerSecret, { sourceUrl }));
	}
	if (segments.length === 0) {
		const sourceSegment = await transcribeSourceUpload(env, source);
		if (sourceSegment) {
			segments = [sourceSegment];
		}
	}

	const transcript = transcriptMarkdown(source.name, segments);
	let summary = fallbackVideoSummary(frames, segments);
	if (frames.length > 0 || segments.length > 0) {
		try {
			summary =
				(await hostGenerateText(env, {
				system: VIDEO_SUMMARY_SYSTEM_PROMPT,
				prompt:
					`Summarize the uploaded video named ${source.name}.\n\n` +
					`Transcript samples:\n\n${transcript}\n\n` +
					`Sampled frame count: ${frames.length}. The host model call is text-only for video summaries in this plugin version.`,
				includeSourceImage: false,
				maxOutputTokens: 1200,
				})) || summary;
		} catch (error) {
			console.warn("Video summary generation failed", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const transcriptPath = `${source.name}.transcript.md`;
	const summaryPath = `${source.name}.summary.md`;
	await Promise.all([
		env.BONOBO.files.writeMarkdown({
			path: transcriptPath,
			markdown: transcript,
			overwrite: "replace",
		}),
		env.BONOBO.files.writeMarkdown({
			path: summaryPath,
			markdown: `# Video summary: ${source.name}\n\n${summary}`,
			overwrite: "replace",
		}),
	]);

	return json({ ok: true, files: [transcriptPath, summaryPath] });
}

export default {
	async fetch(request, env) {
		const event = await readEvent(request);
		const source = getSource(event);
		if (!source) {
			return json({ error: "Upload source is missing" }, 400);
		}

		const kind = mediaKind(source.contentType);
		if (kind === "image") {
			return await describeImage(env, source);
		}
		if (kind === "video") {
			return await summarizeVideo(env, source);
		}

		return skipped();
	},
};
