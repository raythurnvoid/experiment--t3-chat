/**
 * Workers AI Whisper behind one function, so pipeline tests mock the model call instead of the
 * platform binding, and a model swap touches this file only.
 */

import { Result } from "./result.ts";
import type { Env } from "./env.ts";
import type { council_TrackSegment } from "./tracks.ts";

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * A track over this size is refused rather than transcribed. Track files are audio-only WebM, so
 * a 60-minute meeting stays far below this; hitting the cap means the file is not what we think.
 */
export const council_TRACK_TRANSCRIBE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Read a stream fully with a hard byte cap. This is the pipeline's only full read of audio, sized
 * for the bounded per-track transcription input; recording bodies are never read this way for
 * storage — uploads stream.
 */
export async function council_read_stream_with_limit(stream: ReadableStream<Uint8Array>, maxBytes: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return Result<never>({ _nay: { name: "too_large", message: `Stream exceeded ${maxBytes} bytes` } });
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return Result({ _yay: combined });
}

function to_base64(bytes: Uint8Array) {
	let binary = "";
	// Chunked so a multi-megabyte track does not blow the argument limit of one call.
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

/**
 * Transcribe one track's audio bytes into segments on the track's own clock. Whisper reports
 * seconds; the caller moves segments onto the meeting clock with the track offset.
 */
export async function council_transcribe_track(env: Env, audioBytes: Uint8Array) {
	let raw: unknown;
	try {
		raw = await env.AI.run(WHISPER_MODEL, { audio: to_base64(audioBytes) });
	} catch (error) {
		return Result<never>({ _nay: { name: "ai_failed", message: "Whisper transcription failed", cause: error } });
	}

	const output = raw as { text?: unknown; segments?: unknown } | null;
	if (typeof output?.text !== "string") {
		return Result<never>({ _nay: { name: "ai_failed", message: "Whisper answered without text" } });
	}

	const segments: council_TrackSegment[] = [];
	if (Array.isArray(output.segments)) {
		for (const segment of output.segments as { start?: unknown; end?: unknown; text?: unknown }[]) {
			if (typeof segment.start === "number" && typeof segment.end === "number" && typeof segment.text === "string") {
				const text = segment.text.trim();
				if (text.length > 0) {
					segments.push({ startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), text });
				}
			}
		}
	}
	// A model answer with text but no usable segments still carries the speech; keep it as one line
	// at the track start rather than dropping a participant's words.
	if (segments.length === 0 && output.text.trim().length > 0) {
		segments.push({ startMs: 0, endMs: 0, text: output.text.trim() });
	}

	return Result({ _yay: segments });
}
