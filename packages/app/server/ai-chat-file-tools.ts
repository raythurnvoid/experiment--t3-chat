import { tool, type ToolResultPart } from "ai";
import z from "zod";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { r2_fetch_object_from_bucket } from "../convex/r2_client.ts";
import { ai_chat_file_result } from "../shared/ai-chat-files.ts";
import {
	files_ingestion_MAX_BYTES,
	files_ingestion_encode_base64,
	files_ingestion_read_bytes,
} from "./files-ingestion.ts";

/**
 * Private observations live only in this turn, keyed by the SDK's tool call id.
 *
 * Before each model step, check the exact source again. Chat history never rebuilds this map.
 */
export type ai_chat_Observation = {
	toolName: "view_image" | "browser_run";
	output: ToolResultPart["output"];
	isCurrent: () => Promise<boolean>;
};

const IMAGE_MAX_EDGE = 8192;
const IMAGE_MAX_PIXELS = 16_000_000;

/**
 * Read the image canvas from bounded headers, without decoding pixels.
 *
 * The provider still validates compressed image data. Names and declared MIME types do not
 * decide whether bytes are an image. Animated formats use their canvas, not all frames.
 */
function image_header(bytes: Uint8Array) {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let mediaType: string;
	const matches = (offset: number, text: string) =>
		offset + text.length <= bytes.length &&
		[...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

	if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
		if (data.getUint32(8) !== 13 || !matches(12, "IHDR")) return null;
		width = data.getUint32(16);
		height = data.getUint32(20);
		mediaType = "image/png";
	} else if (bytes.length >= 13 && (matches(0, "GIF87a") || matches(0, "GIF89a"))) {
		width = data.getUint16(6, true);
		height = data.getUint16(8, true);
		mediaType = "image/gif";
	} else if (bytes.length >= 12 && matches(0, "RIFF") && matches(8, "WEBP")) {
		const end = data.getUint32(4, true) + 8;
		if (end > bytes.length || end < 20) return null;
		mediaType = "image/webp";

		// Advance over each chunk once. Never copy the remaining buffer while scanning.
		for (let offset = 12; offset + 8 <= end; ) {
			const length = data.getUint32(offset + 4, true);
			const start = offset + 8;
			if (start + length > end) return null;
			if (matches(offset, "VP8X") && length === 10) {
				width = 1 + bytes[start + 4]! + (bytes[start + 5]! << 8) + (bytes[start + 6]! << 16);
				height = 1 + bytes[start + 7]! + (bytes[start + 8]! << 8) + (bytes[start + 9]! << 16);
				break;
			}
			if (matches(offset, "VP8 ") && length >= 10) {
				if (
					(bytes[start]! & 1) !== 0 ||
					bytes[start + 3] !== 0x9d ||
					bytes[start + 4] !== 1 ||
					bytes[start + 5] !== 0x2a
				)
					return null;
				width = data.getUint16(start + 6, true) & 0x3fff;
				height = data.getUint16(start + 8, true) & 0x3fff;
				break;
			}
			if (matches(offset, "VP8L") && length >= 5) {
				if (bytes[start] !== 0x2f) return null;
				const dimensions = data.getUint32(start + 1, true);
				if (dimensions >>> 29 !== 0) return null;
				width = (dimensions & 0x3fff) + 1;
				height = ((dimensions >>> 14) & 0x3fff) + 1;
				break;
			}
			offset = start + length + (length & 1);
		}
	} else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		mediaType = "image/jpeg";
		let offset = 2;
		while (offset < bytes.length) {
			if (bytes[offset++] !== 0xff) return null;
			while (offset < bytes.length && bytes[offset] === 0xff) offset++;
			if (offset >= bytes.length) return null;
			const marker = bytes[offset++]!;
			if (marker === 0xda || marker === 0xd9 || marker === 0x00) return null;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			if (offset + 2 > bytes.length) return null;
			const length = data.getUint16(offset);
			if (length < 2 || offset + length > bytes.length) return null;
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				if (length < 8 || length !== 8 + 3 * bytes[offset + 7]!) return null;
				height = data.getUint16(offset + 3);
				width = data.getUint16(offset + 5);
				break;
			}
			offset += length;
		}
	} else {
		return null;
	}

	if (!width || !height || width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE || width * height > IMAGE_MAX_PIXELS)
		return null;
	return { mediaType, width, height };
}

/**
 * Supply checked image bytes for inspection. Execution owns I/O and the turn budget.
 *
 * Conversion is a pure lookup. Repeated SDK conversions cannot read or charge twice.
 */
export function ai_chat_tool_create_view_image(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		getThreadId: () => Id<"ai_chat_threads"> | null;
		observations: Map<string, ai_chat_Observation>;
	},
) {
	// The same 8 MiB ceiling the file writer uses, spent here on bytes read into the model.
	let imageBytesRemaining = files_ingestion_MAX_BYTES;
	return tool({
		description:
			"Inspect a PNG, JPEG, WEBP, or GIF in Files. Use its canonical workspace path, such as /reports/chart.png. Up to 8 MiB per turn, 8192 pixels per edge, and 16 million canvas pixels. Read text with Bash. Read or transform other bytes with execute_code and the Files byte API.",
		inputSchema: z.object({ path: z.string().min(1).max(1024).startsWith("/") }).strict(),
		strict: true,
		execute: async ({ path }, options) => {
			const unavailable = () => ai_chat_file_result("View image", "errored", [], "unavailable");
			const threadId = args.getThreadId();
			if (!threadId) return unavailable();
			const readArgs = { userId: args.userId, membershipId: args.membershipId, threadId, path };
			try {
				options.abortSignal?.throwIfAborted();
				const checked = await ctx.runQuery(internal.files_nodes_content.get_file_read_source, readArgs);
				if (checked._nay) return unavailable();
				const file = checked._yay;
				if (file.size === 0) return ai_chat_file_result("View image", "errored", [], "unsupported_image");
				if (file.size > imageBytesRemaining) return ai_chat_file_result("View image", "errored", [], "limit");

				// Reserve before the GET so parallel calls cannot spend the same bytes.
				imageBytesRemaining -= file.size;
				const response = await r2_fetch_object_from_bucket({ key: file.r2Key, signal: options.abortSignal });
				const bytes = await files_ingestion_read_bytes(response, file.size);
				if (bytes.byteLength !== file.size) return unavailable();
				const header = image_header(bytes);
				if (!header) return ai_chat_file_result("View image", "errored", [], "unsupported_image");

				const isCurrent = async () => {
					const fresh = await ctx.runQuery(internal.files_nodes_content.get_file_read_source, {
						...readArgs,
						target: file.target,
					});
					return (
						!fresh._nay &&
						fresh._yay.assetId === file.assetId &&
						fresh._yay.revision === file.revision &&
						fresh._yay.target.kind === file.target.kind &&
						fresh._yay.target.id === file.target.id
					);
				};
				if (!(await isCurrent())) return unavailable();
				options.abortSignal?.throwIfAborted();
				args.observations.set(options.toolCallId, {
					toolName: "view_image",
					isCurrent,
					output: {
						type: "content",
						value: [
							{ type: "text", text: `Image bytes supplied for inspection: ${file.path}` },
							{ type: "image-data", data: files_ingestion_encode_base64(bytes), mediaType: header.mediaType },
						],
					},
				});
				return ai_chat_file_result("View image", "succeeded", [file.target]);
			} catch {
				return options.abortSignal?.aborted ? ai_chat_file_result("View image", "cancelled") : unavailable();
			}
		},
		toModelOutput: ({ toolCallId, output }) =>
			args.observations.get(toolCallId)?.output ?? { type: "text", value: output.output },
	});
}
