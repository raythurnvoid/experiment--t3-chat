import { Workpool, vWorkId } from "@convex-dev/workpool";
import type { RegisteredMutation, RegisteredQuery, RouteSpec } from "convex/server";
import { v } from "convex/values";
import { R2 } from "@convex-dev/r2";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { components, internal } from "./_generated/api.js";
import {
	action,
	httpAction,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	json_parse_and_validate,
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { organizations_GLOBAL_ORGANIZATION_ID, organizations_GLOBAL_GITHUB_WORKSPACE_ID } from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { billing_event } from "../server/billing.ts";
import { billing_db_check_credits, billing_ingest_events, billing_pick_billed_user_id } from "./billing.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	type files_ContentType,
} from "../server/files.ts";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	db_insert_file_text_content,
	db_patch_file_chunks_scope,
	db_get_file_content_materialization_db_state,
	files_nodes_create_yjs_snapshot_update_from_markdown,
	files_nodes_db_create_node_recursively_at_path,
} from "./files_nodes.ts";

if (!process.env.R2_BUCKET_FILES) {
	throw convex_error({ message: "R2_BUCKET_FILES is not set in Convex env" });
}

const R2_BUCKET_FILES = process.env.R2_BUCKET_FILES;

if (!process.env.R2_ENDPOINT) {
	throw convex_error({ message: "R2_ENDPOINT is not set in Convex env" });
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;

if (!process.env.R2_ACCESS_KEY_ID) {
	throw convex_error({ message: "R2_ACCESS_KEY_ID is not set in Convex env" });
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;

if (!process.env.R2_SECRET_ACCESS_KEY) {
	throw convex_error({ message: "R2_SECRET_ACCESS_KEY is not set in Convex env" });
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

if (!process.env.CLOUDFLARE_EVENTS_SECRET) {
	throw convex_error({ message: "CLOUDFLARE_EVENTS_SECRET is not set in Convex env" });
}

const CLOUDFLARE_EVENTS_SECRET = process.env.CLOUDFLARE_EVENTS_SECRET;

if (!process.env.MODAL_FILE_CONVERTER_URL) {
	throw convex_error({ message: "MODAL_FILE_CONVERTER_URL is not set in Convex env" });
}

const MODAL_FILE_CONVERTER_URL = process.env.MODAL_FILE_CONVERTER_URL;

if (!process.env.MODAL_TOKEN) {
	throw convex_error({ message: "MODAL_TOKEN is not set in Convex env" });
}

const MODAL_TOKEN = process.env.MODAL_TOKEN;

if (!process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL) {
	throw convex_error({ message: "CLOUDFLARE_MEDIA_TRANSFORMER_URL is not set in Convex env" });
}

const CLOUDFLARE_MEDIA_TRANSFORMER_URL = process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL;

if (!process.env.CLOUDFLARE_MEDIA_TRANSFORMER_SECRET) {
	throw convex_error({ message: "CLOUDFLARE_MEDIA_TRANSFORMER_SECRET is not set in Convex env" });
}

const CLOUDFLARE_MEDIA_TRANSFORMER_SECRET = process.env.CLOUDFLARE_MEDIA_TRANSFORMER_SECRET;

if (!process.env.OPENAI_API_KEY) {
	throw convex_error({ message: "OPENAI_API_KEY is not set in Convex env" });
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MEDIA_DESCRIPTION_MODEL_ID = "gpt-5.4-mini";
const MEDIA_TRANSCRIPTION_MODEL_ID = "gpt-4o-transcribe";
const MEDIA_FRAME_SAMPLE_TIMES_SECONDS = [0, 5, 15, 30, 60, 120] as const;
const MEDIA_AUDIO_SEGMENT_START_SECONDS = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540] as const;
const MEDIA_AUDIO_SEGMENT_DURATION_SECONDS = 60;
const MEDIA_TRANSCRIPTION_MAX_BYTES = 24 * 1024 * 1024;

function generated_markdown_file_node_name(filename: string) {
	return `${filename}.md`;
}

function generated_image_description_file_node_name(filename: string) {
	return `${filename}.description.md`;
}

function generated_video_summary_file_node_name(filename: string) {
	return `${filename}.summary.md`;
}

function generated_video_transcript_file_node_name(filename: string) {
	return `${filename}.transcript.md`;
}

function normalized_content_type(contentType: string | undefined) {
	return contentType?.split(";")[0]?.trim().toLowerCase() ?? null;
}

function upload_content_type_media_kind(contentType: string | undefined) {
	switch (normalized_content_type(contentType)) {
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

function media_compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case MEDIA_TRANSCRIPTION_MODEL_ID:
			return args.inputTokens * 0.0006 + args.outputTokens * 0.001;
		case MEDIA_DESCRIPTION_MODEL_ID:
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

/**
 * Narrow file content-storage scope to a real organization/workspace at a sink that cannot accept the
 * reserved external-mount scope. Upload/media processing only ever runs on real user files, so the
 * reserved literals are unreachable here.
 */
function r2_require_real_scope(
	organizationId: Id<"organizations"> | typeof organizations_GLOBAL_ORGANIZATION_ID,
	workspaceId: Id<"organizations_workspaces"> | typeof organizations_GLOBAL_GITHUB_WORKSPACE_ID,
): { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> } {
	if (organizationId === organizations_GLOBAL_ORGANIZATION_ID || workspaceId === organizations_GLOBAL_GITHUB_WORKSPACE_ID) {
		const errorMessage = "Reserved external-mount scope reached a sink that requires a real organization/workspace id";
		const errorData = { organizationId, workspaceId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return { organizationId, workspaceId };
}

/**
 * Narrow a file author to a real user id at a sink that cannot accept the reserved SYSTEM author.
 */
function r2_require_real_author(createdBy: Id<"users"> | typeof users_SYSTEM_AUTHOR): Id<"users"> {
	if (createdBy === users_SYSTEM_AUTHOR) {
		const errorMessage = "Reserved SYSTEM author reached a sink that requires a real user id";
		const errorData = { createdBy };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return createdBy;
}

async function ingest_media_ai_usage_event(
	ctx: ActionCtx | MutationCtx,
	args: {
		sourceFileNode: Doc<"files_nodes">;
		billedUser: Doc<"users">;
		modelId: string;
		operationId: string;
		inputTokens: number;
		outputTokens: number;
	},
) {
	if (args.inputTokens + args.outputTokens === 0) {
		return;
	}

	const authorUserId = r2_require_real_author(args.sourceFileNode.createdBy);
	await billing_ingest_events(ctx, {
		billedUserEvents: [
			{
				billedUser: args.billedUser,
				event: billing_event({
					name: "ai_usage",
					externalCustomerId: args.billedUser._id,
					externalMemberId: authorUserId,
					externalId: composite_id(
						"billing",
						"ai_usage",
						args.billedUser._id,
						args.sourceFileNode.createdBy,
						args.sourceFileNode.organizationId,
						args.sourceFileNode.workspaceId,
						`media:${args.sourceFileNode._id}`,
						args.operationId,
					),
					metadata: {
						amount: media_compute_token_usage_cost_cents({
							modelId: args.modelId,
							inputTokens: args.inputTokens,
							outputTokens: args.outputTokens,
						}),
						actorUserId: authorUserId,
						billedUserId: args.billedUser._id,
						organizationId: args.sourceFileNode.organizationId,
						workspaceId: args.sourceFileNode.workspaceId,
						modelId: args.modelId,
						inputTokens: args.inputTokens,
						outputTokens: args.outputTokens,
						threadId: `media:${args.sourceFileNode._id}`,
						messageId: args.operationId,
					},
				}),
			},
		],
	});
}

const r2 = new R2(components.r2, {
	bucket: R2_BUCKET_FILES,
	endpoint: R2_ENDPOINT,
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
});

export async function r2_get_download_url(args: {
	key: Parameters<typeof r2.getUrl>[0];
	options?: Parameters<typeof r2.getUrl>[1];
}) {
	return await r2.getUrl(args.key, {
		...args.options,
	});
}

export function r2_get_bucket() {
	return r2.config.bucket;
}

export async function r2_generate_upload_url(key: Parameters<typeof r2.generateUploadUrl>[0]) {
	return await r2.generateUploadUrl(key);
}

export function r2_create_asset_key(args: { organizationId: string; workspaceId: string; assetId: Id<"files_r2_assets"> }) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.assetId}`;
}

function extract_asset_id_from_r2_key(key: string) {
	const assetId = key.split("/").at(-1);

	return assetId || null;
}

export const insert_asset = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_r2_assets").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_r2_assets").fields.workspaceId,
		kind: doc(app_convex_schema, "files_r2_assets").fields.kind,
		size: doc(app_convex_schema, "files_r2_assets").fields.size,
		createdBy: doc(app_convex_schema, "files_r2_assets").fields.createdBy,
	},
	returns: v.id("files_r2_assets"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: args.kind,
			r2Bucket: r2_get_bucket(),
			size: args.size,
			createdBy: args.createdBy,
			updatedAt: now,
		});
	},
});

export const patch_asset = internalMutation({
	args: {
		assetId: v.id("files_r2_assets"),
		r2Key: doc(app_convex_schema, "files_r2_assets").fields.r2Key,
		size: v.optional(doc(app_convex_schema, "files_r2_assets").fields.size),
		etag: doc(app_convex_schema, "files_r2_assets").fields.etag,
		conversionWorkId: v.optional(v.union(vWorkId, v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch("files_r2_assets", args.assetId, {
			...(args.r2Key === undefined ? {} : { r2Key: args.r2Key }),
			...(args.size === undefined ? {} : { size: args.size }),
			...(args.etag === undefined ? {} : { etag: args.etag }),
			...(args.conversionWorkId === undefined ? {} : { conversionWorkId: args.conversionWorkId }),
			updatedAt: Date.now(),
		});

		return null;
	},
});

export async function r2_put_object(
	ctx: ActionCtx,
	args: {
		key: string;
		body: BodyInit;
		contentType?: string;
	},
) {
	// Use signed PUT instead of r2.store() so deterministic content keys remain idempotent across Workpool retries.
	const upload = await r2_generate_upload_url(args.key);
	const response = await fetch(upload.url, {
		method: "PUT",
		headers: args.contentType ? { "Content-Type": args.contentType } : undefined,
		body: args.body,
	});
	if (!response.ok) {
		throw convex_error({
			message: "Failed to write R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	await r2.syncMetadata(ctx, args.key);
}

export async function r2_fetch_object_from_bucket(args: { key: string }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url);
	if (!response.ok) {
		throw convex_error({
			message: "Failed to read R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	return response;
}

/**
 * Fetch a bounded byte range of an R2 object via an HTTP Range request (R2 honors it and
 * returns 206 Partial Content). Lets callers read a window of a large object instead of the
 * whole thing. `start`/`endInclusive` are 0-based byte offsets; the response may be shorter
 * than requested at end-of-object.
 */
export async function r2_fetch_object_range_from_bucket(args: { key: string; start: number; endInclusive: number }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url, {
		headers: { Range: `bytes=${args.start}-${args.endInclusive}` },
	});
	// 206 = partial content (range honored); 200 = full object (range ignored by store) — both usable.
	if (!response.ok && response.status !== 206) {
		throw convex_error({
			message: "Failed to read R2 object range",
			cause: {
				status: response.status,
				key: args.key,
				range: `bytes=${args.start}-${args.endInclusive}`,
			},
		});
	}

	return response;
}

function normalize_external_base_url(value: string) {
	return value.replace(/\/+$/, "");
}

async function fetch_media_transformer_bytes(args: {
	path: "/api/media/frame" | "/api/media/audio-segment";
	body: Record<string, unknown>;
}) {
	const response = await fetch(`${normalize_external_base_url(CLOUDFLARE_MEDIA_TRANSFORMER_URL)}${args.path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${CLOUDFLARE_MEDIA_TRANSFORMER_SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(args.body),
	});
	if (response.status === 422) {
		// Treat Cloudflare Media's deterministic "cannot extract from this source"
		// result as an absent sample; the video action can still use other samples
		// or fall back to direct source transcription.
		return null;
	}
	if (!response.ok) {
		throw convex_error({
			message: "Failed to transform uploaded media",
			cause: {
				status: response.status,
				body: await response.text().catch(() => ""),
			},
		});
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	return bytes.byteLength === 0 ? null : bytes;
}

async function fetch_video_frame(args: { r2Key: string; timeSeconds: number }) {
	return await fetch_media_transformer_bytes({
		path: "/api/media/frame",
		body: {
			key: args.r2Key,
			timeSeconds: args.timeSeconds,
		},
	});
}

async function fetch_video_audio_segment(args: { r2Key: string; startSeconds: number; durationSeconds: number }) {
	return await fetch_media_transformer_bytes({
		path: "/api/media/audio-segment",
		body: {
			key: args.r2Key,
			startSeconds: args.startSeconds,
			durationSeconds: args.durationSeconds,
		},
	});
}

const openai_transcription_response_schema = z
	.object({
		text: z.string(),
		usage: z
			.object({
				input_tokens: z.number().optional(),
				output_tokens: z.number().optional(),
			})
			.optional(),
	})
	.passthrough();

function estimate_tokens_from_text(text: string) {
	return Math.ceil(text.length / 4);
}

function unwrap_generated_markdown_response(text: string) {
	const trimmed = text.trim();
	const fencedMarkdown = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
	return fencedMarkdown?.[1]?.trim() ?? trimmed;
}

function array_buffer_from_uint8_array(bytes: Uint8Array) {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

async function parse_openai_transcription_response(args: {
	response: Response;
	startSeconds: number;
	filename?: string;
}) {
	const responseBody = await args.response.text();
	if (!args.response.ok) {
		if (args.response.status === 400 || args.response.status === 413 || args.response.status === 422) {
			// Keep invalid/too-large media inputs terminal for this segment so one
			// bad sample does not poison the entire generated output job.
			console.warn("OpenAI transcription skipped a deterministic media input failure", {
				status: args.response.status,
				body: responseBody.slice(0, 1_000),
				startSeconds: args.startSeconds,
				filename: args.filename,
			});
			return null;
		}

		throw convex_error({
			message: "Failed to transcribe uploaded video audio",
			cause: {
				status: args.response.status,
				body: responseBody.slice(0, 1_000),
			},
		});
	}

	const payload = json_parse_and_validate(responseBody, openai_transcription_response_schema);
	if (payload._nay) {
		throw convex_error({
			message: "OpenAI transcription returned an invalid payload",
			cause: payload._nay,
		});
	}

	const text = payload._yay.text.trim();
	if (!text) {
		return null;
	}

	return {
		startSeconds: args.startSeconds,
		text,
		inputTokens: payload._yay.usage?.input_tokens ?? 0,
		outputTokens: payload._yay.usage?.output_tokens ?? estimate_tokens_from_text(text),
	};
}

function sanitize_multipart_filename(filename: string) {
	return filename.replace(/["\\\r\n]/g, "_");
}

function multipart_text_field(args: { boundary: string; name: string; value: string }) {
	return `--${args.boundary}\r\nContent-Disposition: form-data; name="${args.name}"\r\n\r\n${args.value}\r\n`;
}

function multipart_file_header(args: { boundary: string; filename: string; contentType: string }) {
	return (
		`--${args.boundary}\r\n` +
		`Content-Disposition: form-data; name="file"; filename="${sanitize_multipart_filename(args.filename)}"\r\n` +
		`Content-Type: ${args.contentType}\r\n\r\n`
	);
}

function create_transcription_multipart_stream(args: {
	boundary: string;
	fileStream: ReadableStream<Uint8Array>;
	filename: string;
	contentType: string;
}) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			// Stream the original R2 object into OpenAI instead of buffering it in
			// Convex; a 24 MB upload can exceed Convex's action memory once copied.
			controller.enqueue(
				encoder.encode(
					multipart_text_field({
						boundary: args.boundary,
						name: "model",
						value: MEDIA_TRANSCRIPTION_MODEL_ID,
					}),
				),
			);
			controller.enqueue(
				encoder.encode(
					multipart_text_field({
						boundary: args.boundary,
						name: "response_format",
						value: "json",
					}),
				),
			);
			controller.enqueue(
				encoder.encode(
					multipart_file_header({
						boundary: args.boundary,
						filename: args.filename,
						contentType: args.contentType,
					}),
				),
			);

			const reader = args.fileStream.getReader();
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					controller.enqueue(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}

			controller.enqueue(encoder.encode(`\r\n--${args.boundary}--\r\n`));
			controller.close();
		},
	});
}

async function transcribe_audio_segment(args: {
	audioBytes: Uint8Array;
	startSeconds: number;
	filename?: string;
	contentType?: string;
}) {
	if (args.audioBytes.byteLength > MEDIA_TRANSCRIPTION_MAX_BYTES) {
		return null;
	}

	// Worker-produced segments are intentionally small, so the standard FormData
	// path is simpler than the streaming fallback used for original uploads.
	const formData = new FormData();
	formData.append("model", MEDIA_TRANSCRIPTION_MODEL_ID);
	formData.append("response_format", "json");
	formData.append(
		"file",
		new Blob([array_buffer_from_uint8_array(args.audioBytes)], { type: args.contentType ?? "audio/mp4" }),
		args.filename ?? `segment-${args.startSeconds}.m4a`,
	);

	const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
		},
		body: formData,
	});
	return await parse_openai_transcription_response({
		response,
		startSeconds: args.startSeconds,
		filename: args.filename,
	});
}

async function transcribe_original_video_upload(args: {
	sourceAsset: Doc<"files_r2_assets">;
	sourceFileNode: Doc<"files_nodes">;
}) {
	if (!args.sourceAsset.r2Key || args.sourceAsset.size > MEDIA_TRANSCRIPTION_MAX_BYTES) {
		return null;
	}

	const response = await r2_fetch_object_from_bucket({ key: args.sourceAsset.r2Key });
	if (!response.body) {
		return null;
	}

	// Cloudflare Media Transformations currently rejects source videos over ten minutes.
	// Use OpenAI's upload-size limit as the bounded fallback for already-compressed MP4 uploads.
	const boundary = `t3-chat-${crypto.randomUUID()}`;
	const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body: create_transcription_multipart_stream({
			boundary,
			fileStream: response.body,
			filename: args.sourceFileNode.name,
			contentType: args.sourceFileNode.contentType ?? "video/mp4",
		}),
		duplex: "half",
	} as RequestInit & { duplex: "half" });

	return await parse_openai_transcription_response({
		response: transcriptionResponse,
		startSeconds: 0,
		filename: args.sourceFileNode.name,
	});
}

function format_seconds_timestamp(seconds: number) {
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function build_video_transcript_markdown(args: {
	filename: string;
	segments: Array<{ startSeconds: number; text: string }>;
}) {
	const body =
		args.segments.length === 0
			? "No speech transcript could be generated from the sampled audio segments."
			: args.segments
					.map((segment) => `## ${format_seconds_timestamp(segment.startSeconds)}\n\n${segment.text}`)
					.join("\n\n");

	return `# Transcript: ${args.filename}\n\n${body}`;
}

export async function r2_delete_object(ctx: MutationCtx, key: string) {
	await r2.deleteObject(ctx, key);
}

export const get_asset_by_r2_event_key = internalQuery({
	args: {
		bucket: v.string(),
		key: v.string(),
	},
	returns: v_result({
		_yay: doc(app_convex_schema, "files_r2_assets"),
	}),
	handler: async (ctx, args) => {
		const parsedAssetId = extract_asset_id_from_r2_key(args.key);
		const assetId = parsedAssetId ? ctx.db.normalizeId("files_r2_assets", parsedAssetId) : null;
		const asset = assetId ? await ctx.db.get("files_r2_assets", assetId) : null;

		if (!asset || asset.r2Bucket !== args.bucket) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		return Result({ _yay: asset });
	},
});

type get_asset_by_r2_event_key_Result =
	typeof get_asset_by_r2_event_key extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_asset_by_id = internalQuery({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
			return null;
		}

		return asset;
	},
});

export type get_asset_by_id_Result =
	typeof get_asset_by_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_create_signed_download_url = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			fileNode: doc(app_convex_schema, "files_nodes"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			materializationState: v.union(
				v.object({
					fileNode: doc(app_convex_schema, "files_nodes"),
					yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
					yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
					yjsUpdatesDocs: v.array(doc(app_convex_schema, "files_yjs_updates")),
					asset: doc(app_convex_schema, "files_r2_assets"),
					yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
				}),
				v.null(),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!fileNode.assetId ||
			!fileNode.contentType
		) {
			return null;
		}

		const assetId = fileNode.assetId;
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
			const errorData = {
				fileNodeId: fileNode._id,
				assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			fileNode,
			asset,
			materializationState: files_node_has_editable_yjs_state(fileNode)
				? await db_get_file_content_materialization_db_state(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						nodeId: fileNode._id,
					})
				: null,
		};
	},
});

type get_data_for_create_signed_download_url_Result =
	typeof get_data_for_create_signed_download_url extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Return a signed R2 URL for download.
 *
 * For Markdown files, ensure the R2 snapshot is up to date before returning the URL.
 */
export const create_signed_download_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			url: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const data = (await ctx.runQuery(internal.r2.get_data_for_create_signed_download_url, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			fileNodeId: args.fileNodeId,
		})) as get_data_for_create_signed_download_url_Result;
		if (!data) {
			return Result({ _nay: { message: "Not found" } });
		}

		const { fileNode, asset, materializationState } = data;
		if (!fileNode.contentType) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (files_node_has_editable_yjs_state(fileNode)) {
			if (!materializationState) {
				console.warn("Markdown file materialization state is missing", {
					materializationState,
					fileNodeId: fileNode._id,
					yjsSnapshotId: fileNode.yjsSnapshotId,
					yjsLastSequenceId: fileNode.yjsLastSequenceId,
				});
			} else if (materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence) {
				// Try to update the committed Markdown asset, but still allow downloading the current R2 asset if this fails.
				const materializeScope = r2_require_real_scope(fileNode.organizationId, fileNode.workspaceId);
				const materialized = await ctx.runAction(internal.files_nodes.materialize_file_content, {
					organizationId: materializeScope.organizationId,
					workspaceId: materializeScope.workspaceId,
					nodeId: fileNode._id,
					userId: userAuth.id,
					targetSequence: materializationState.yjsLastSequenceDoc.lastSequence,
				});
				if (materialized._nay) {
					console.warn("Failed to materialize Markdown before download", {
						fileNodeId: fileNode._id,
						nay: materialized._nay,
					});
				}
			}
		}

		if (!asset.r2Key) {
			return Result({ _nay: { message: "Not found" } });
		}

		const url = await r2_get_download_url({
			key: asset.r2Key,
			options: {
				// 15 minutes.
				expiresIn: 15 * 60,
			},
		});

		return Result({ _yay: { url } });
	},
});

export const get_asset = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!fileNode.assetId
		) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			return null;
		}

		return asset;
	},
});

export const get_file_node_by_asset_id = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("assetId", args.assetId),
			)
			.first();
	},
});

type get_file_node_by_asset_id_Result =
	typeof get_file_node_by_asset_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function db_finalize_markdown_file_node_from_r2_assets(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		fileNodeId: Id<"files_nodes">;
		path: Doc<"files_nodes">["path"];
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		userId: Id<"users">;
		markdownAssetId: Id<"files_r2_assets">;
		markdownSize: number;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
		markdownContent: string;
		/**
		 * Assets that share this conversion job and should become terminal
		 * when the file is published.
		 */
		conversionWorkAssetIds: Array<Id<"files_r2_assets">>;
		now: number;
	},
) {
	// Create editable Yjs metadata for an existing node whose R2 objects were
	// already written by the caller.
	const [yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			sequence: 0,
			assetId: args.yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			lastSequence: 0,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.fileNodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: 0,
			contentType: "text/markdown;charset=utf-8",
			textContent: args.markdownContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk Markdown file",
					cause: chunks._nay,
				});
			}
			return chunks;
		}),
	] as const).catch((error) => {
		const errorMessage = "Failed to finalize Markdown file node";
		console.error(errorMessage, {
			error,
			fileNodeId: args.fileNodeId,
		});
		throw convex_error({
			message: errorMessage,
			cause: error,
		});
	});

	// Publish the editable file state and clear every asset that represented
	// this Workpool job.
	await Promise.all([
		ctx.db.patch("files_nodes", args.fileNodeId, {
			assetId: args.markdownAssetId,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			yjsSnapshotId,
			yjsLastSequenceId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.markdownAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.markdownAssetId,
			}),
			size: args.markdownSize,
			...(args.conversionWorkAssetIds.includes(args.markdownAssetId) ? { conversionWorkId: null } : {}),
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			updatedAt: args.now,
		}),
		...args.conversionWorkAssetIds
			.filter((assetId) => assetId !== args.markdownAssetId)
			.map((assetId) =>
				ctx.db.patch("files_r2_assets", assetId, {
					conversionWorkId: null,
					updatedAt: args.now,
				}),
			),
		ctx.db.insert("files_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

/**
 * Finish an upload conversion after the converted R2 objects are written.
 *
 * Patch the pre-created generated Markdown node into an editable file and clear
 * the conversion job in one mutation.
 */
export const finalize_upload_conversion_to_markdown = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		/** The original uploaded file node, such as the source PDF being converted. */
		fileNodeId: v.id("files_nodes"),
		uploadAssetId: v.id("files_r2_assets"),
		output: v.object({
			/** The generated Markdown file node that becomes the editable conversion output. */
			fileNodeId: v.id("files_nodes"),
			markdownContent: v.string(),
			markdownAssetId: v.id("files_r2_assets"),
			markdownSize: v.number(),
			yjsSnapshotAssetId: v.id("files_r2_assets"),
			yjsSnapshotSize: v.number(),
			versionSnapshotAssetId: v.id("files_r2_assets"),
			versionSnapshotSize: v.number(),
		}),
	},
	returns: v_result({
		_yay: v.object({
			fileNodeId: v.id("files_nodes"),
		}),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const sourceFileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!sourceFileNode ||
			sourceFileNode.organizationId !== args.organizationId ||
			sourceFileNode.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const output = args.output;
		const outputFileNode = await ctx.db.get("files_nodes", output.fileNodeId);
		if (
			!outputFileNode ||
			outputFileNode.organizationId !== args.organizationId ||
			outputFileNode.workspaceId !== args.workspaceId ||
			outputFileNode.kind !== "file" ||
			outputFileNode.assetId !== output.markdownAssetId
		) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const finalizeScope = r2_require_real_scope(args.organizationId, args.workspaceId);
		const finalized = await db_finalize_markdown_file_node_from_r2_assets(ctx, {
			organizationId: finalizeScope.organizationId,
			workspaceId: finalizeScope.workspaceId,
			fileNodeId: output.fileNodeId,
			path: outputFileNode.path,
			archiveOperationId: outputFileNode.archiveOperationId,
			userId: args.userId,
			markdownAssetId: output.markdownAssetId,
			markdownSize: output.markdownSize,
			yjsSnapshotAssetId: output.yjsSnapshotAssetId,
			yjsSnapshotSize: output.yjsSnapshotSize,
			versionSnapshotAssetId: output.versionSnapshotAssetId,
			versionSnapshotSize: output.versionSnapshotSize,
			markdownContent: output.markdownContent,
			conversionWorkAssetIds: [args.uploadAssetId, output.markdownAssetId],
			now,
		});
		if (finalized._nay) {
			return finalized;
		}

		return Result({ _yay: { fileNodeId: output.fileNodeId } });
	},
});

type finalize_upload_conversion_to_markdown_Result =
	typeof finalize_upload_conversion_to_markdown extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const convert_upload_to_markdown = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		sourceAssetId: v.id("files_r2_assets"),
		/**
		 * Pre-created generated Markdown asset; resolve the node by asset so
		 * moves/renames do not break finalization.
		 */
		outputAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode, convertedOutputFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.outputAssetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result, get_file_node_by_asset_id_Result];
		if (!sourceAsset) {
			return null;
		}
		if (!sourceFileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (files_node_has_editable_yjs_state(sourceFileNode)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!convertedOutputFileNode || convertedOutputFileNode.kind !== "file") {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}

		// Give Modal a signed read URL so conversion does not proxy file bytes through Convex.
		// Trust the R2 event finalizer: it patches r2Key before enqueueing conversion work.
		const sourceR2Key = sourceAsset.r2Key!;
		const sourceUrl = await r2_get_download_url({
			key: sourceR2Key,
			options: {
				// Keep the signed URL short-lived; the Workpool job uses it immediately.
				expiresIn: 15 * 60,
			},
		});

		// Ask the converter for Markdown while passing the same limits enforced by the app.
		let conversionResponse: Response;
		try {
			conversionResponse = await fetch(MODAL_FILE_CONVERTER_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${MODAL_TOKEN}`,
				},
				body: JSON.stringify({
					sourceUrl,
					filename: sourceFileNode.name,
					contentType: sourceFileNode.contentType,
					maxBytes: files_MAX_UPLOADS_BYTES,
					maxMarkdownBytes: files_MAX_TEXT_CONTENT_BYTES,
				}),
			});
		} catch (error) {
			console.error("Failed to call Modal file converter", { error, key: sourceR2Key });
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: {
					message: "Failed to call Modal file converter",
				},
			});
		}

		const conversionResponseBody = await conversionResponse.text();
		if (!conversionResponse.ok) {
			if (conversionResponse.status === 413 || conversionResponse.status === 422) {
				// Modal reached a deterministic no-Markdown outcome; leave generated placeholders terminal.
				await Promise.all([
					ctx.runMutation(internal.r2.patch_asset, {
						assetId: sourceAsset._id,
						conversionWorkId: null,
					}),
					ctx.runMutation(internal.r2.patch_asset, {
						assetId: args.outputAssetId,
						conversionWorkId: null,
					}),
				]);
				return null;
			}

			console.error("Modal file converter returned an error", {
				status: conversionResponse.status,
				body: conversionResponseBody.slice(0, 1_000),
				key: sourceR2Key,
			});
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: {
					message: "Modal file converter failed",
					status: conversionResponse.status,
				},
			});
		}

		// Validate the external payload before using it to create app-owned file data.
		const conversionPayload = json_parse_and_validate(
			conversionResponseBody,
			z.object({
				markdown: z.string(),
				converter: z.string(),
			}),
		);
		if (conversionPayload._nay) {
			console.error("Modal file converter returned an invalid payload", {
				error: conversionPayload._nay,
				key: sourceR2Key,
			});
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: conversionPayload._nay,
			});
		}

		// Keep converted Markdown within the same product limit as first-party Markdown content.
		const convertedMarkdownBytes = files_get_utf8_byte_size(conversionPayload._yay.markdown);
		if (convertedMarkdownBytes > files_MAX_TEXT_CONTENT_BYTES) {
			await Promise.all([
				ctx.runMutation(internal.r2.patch_asset, {
					assetId: sourceAsset._id,
					conversionWorkId: null,
				}),
				ctx.runMutation(internal.r2.patch_asset, {
					assetId: args.outputAssetId,
					conversionWorkId: null,
				}),
			]);
			return null;
		}

		// Build the editable Markdown state from Modal output, but do not publish
		// DB pointers until all R2 writes succeed.
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(conversionPayload._yay.markdown);
		if (snapshotUpdate._nay) {
			throw convex_error({
				message: "Failed to create uploaded file conversion snapshot",
				cause: snapshotUpdate._nay,
			});
		}

		const markdownSize = files_get_utf8_byte_size(conversionPayload._yay.markdown);
		const markdownAssetId = args.outputAssetId;
		const [yjsSnapshotAssetId, versionSnapshotAssetId] = await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: sourceFileNode.organizationId,
				workspaceId: sourceFileNode.workspaceId,
				kind: "yjs_snapshot",
				size: snapshotUpdate._yay.byteLength,
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: sourceFileNode.organizationId,
				workspaceId: sourceFileNode.workspaceId,
				kind: "content_snapshot",
				size: markdownSize,
				createdBy: sourceFileNode.createdBy,
			}),
		]);

		const markdownR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: markdownAssetId,
		});
		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		// Write the R2 objects before the finalizing mutation publishes DB pointers to them.
		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: conversionPayload._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: conversionPayload._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalizedConversion = (await ctx.runMutation(internal.r2.finalize_upload_conversion_to_markdown, {
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			userId: r2_require_real_author(sourceFileNode.createdBy),
			fileNodeId: sourceFileNode._id,
			uploadAssetId: sourceAsset._id,
			output: {
				fileNodeId: convertedOutputFileNode._id,
				markdownContent: conversionPayload._yay.markdown,
				markdownAssetId,
				markdownSize,
				yjsSnapshotAssetId,
				yjsSnapshotSize: snapshotUpdate._yay.byteLength,
				versionSnapshotAssetId,
				versionSnapshotSize: markdownSize,
			},
		})) as finalize_upload_conversion_to_markdown_Result;
		if (finalizedConversion._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded file",
				cause: finalizedConversion._nay,
			});
		}

		return null;
	},
});

export const finalize_markdown_file_node_from_r2_assets = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		fileNodeId: v.id("files_nodes"),
		path: doc(app_convex_schema, "files_nodes").fields.path,
		archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
		userId: v.id("users"),
		markdownAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
		markdownContent: v.string(),
		conversionWorkAssetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const finalizeScope = r2_require_real_scope(args.organizationId, args.workspaceId);
		return await db_finalize_markdown_file_node_from_r2_assets(ctx, {
			...args,
			organizationId: finalizeScope.organizationId,
			workspaceId: finalizeScope.workspaceId,
			now,
		});
	},
});

type finalize_markdown_file_node_from_r2_assets_Result =
	typeof finalize_markdown_file_node_from_r2_assets extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

const uploaded_media_markdown_output_validator = v.object({
	fileNodeId: v.id("files_nodes"),
	markdownContent: v.string(),
	markdownAssetId: v.id("files_r2_assets"),
	markdownSize: v.number(),
	yjsSnapshotAssetId: v.id("files_r2_assets"),
	yjsSnapshotSize: v.number(),
	versionSnapshotAssetId: v.id("files_r2_assets"),
	versionSnapshotSize: v.number(),
});

export const finalize_uploaded_media_markdown_outputs = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		sourceAssetId: v.id("files_r2_assets"),
		outputs: v.array(uploaded_media_markdown_output_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const sourceAsset = await ctx.db.get("files_r2_assets", args.sourceAssetId);
		if (
			!sourceAsset ||
			sourceAsset.organizationId !== args.organizationId ||
			sourceAsset.workspaceId !== args.workspaceId ||
			sourceAsset.kind !== "upload"
		) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const finalizeScope = r2_require_real_scope(args.organizationId, args.workspaceId);
		const conversionWorkAssetIds = [args.sourceAssetId, ...args.outputs.map((output) => output.markdownAssetId)];
		for (const output of args.outputs) {
			const outputFileNode = await ctx.db.get("files_nodes", output.fileNodeId);
			if (
				!outputFileNode ||
				outputFileNode.organizationId !== args.organizationId ||
				outputFileNode.workspaceId !== args.workspaceId ||
				outputFileNode.kind !== "file" ||
				outputFileNode.assetId !== output.markdownAssetId
			) {
				return Result({ _nay: { name: "nay", message: "Not found" } });
			}

			const finalized = await db_finalize_markdown_file_node_from_r2_assets(ctx, {
				organizationId: finalizeScope.organizationId,
				workspaceId: finalizeScope.workspaceId,
				fileNodeId: output.fileNodeId,
				path: outputFileNode.path,
				archiveOperationId: outputFileNode.archiveOperationId,
				userId: args.userId,
				markdownAssetId: output.markdownAssetId,
				markdownSize: output.markdownSize,
				yjsSnapshotAssetId: output.yjsSnapshotAssetId,
				yjsSnapshotSize: output.yjsSnapshotSize,
				versionSnapshotAssetId: output.versionSnapshotAssetId,
				versionSnapshotSize: output.versionSnapshotSize,
				markdownContent: output.markdownContent,
				conversionWorkAssetIds,
				now,
			});
			if (finalized._nay) {
				return finalized;
			}
		}

		return Result({ _yay: null });
	},
});

type finalize_uploaded_media_markdown_outputs_Result =
	typeof finalize_uploaded_media_markdown_outputs extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

async function write_uploaded_media_markdown_output_objects(
	ctx: ActionCtx,
	args: {
		sourceFileNode: Doc<"files_nodes">;
		outputFileNode: Doc<"files_nodes">;
		outputAssetId: Id<"files_r2_assets">;
		markdownContent: string;
	},
) {
	const markdownSize = files_get_utf8_byte_size(args.markdownContent);
	if (markdownSize > files_MAX_TEXT_CONTENT_BYTES) {
		throw convex_error({
			message: "Generated media markdown is too large",
			cause: {
				nodeId: args.outputFileNode._id,
				byteSize: markdownSize,
			},
		});
	}

	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(args.markdownContent);
	if (snapshotUpdate._nay) {
		throw convex_error({
			message: "Failed to create generated media markdown snapshot",
			cause: snapshotUpdate._nay,
		});
	}

	const [yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.sourceFileNode.organizationId,
			workspaceId: args.sourceFileNode.workspaceId,
			kind: "yjs_snapshot",
			size: snapshotUpdate._yay.byteLength,
			createdBy: args.sourceFileNode.createdBy,
		}),
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.sourceFileNode.organizationId,
			workspaceId: args.sourceFileNode.workspaceId,
			kind: "content_snapshot",
			size: markdownSize,
			createdBy: args.sourceFileNode.createdBy,
		}),
	])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

	const markdownR2Key = r2_create_asset_key({
		organizationId: args.sourceFileNode.organizationId,
		workspaceId: args.sourceFileNode.workspaceId,
		assetId: args.outputAssetId,
	});
	const yjsSnapshotR2Key = r2_create_asset_key({
		organizationId: args.sourceFileNode.organizationId,
		workspaceId: args.sourceFileNode.workspaceId,
		assetId: yjsSnapshotAssetId,
	});
	const versionSnapshotR2Key = r2_create_asset_key({
		organizationId: args.sourceFileNode.organizationId,
		workspaceId: args.sourceFileNode.workspaceId,
		assetId: versionSnapshotAssetId,
	});

	// Write the same storage shape as a user-created Markdown file so generated
	// media outputs become editable, searchable files instead of status-only rows.
	await Promise.all([
		r2_put_object(ctx, {
			key: markdownR2Key,
			body: args.markdownContent,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		}),
		r2_put_object(ctx, {
			key: yjsSnapshotR2Key,
			body: snapshotUpdate._yay,
			contentType: "application/octet-stream" satisfies files_ContentType,
		}),
		r2_put_object(ctx, {
			key: versionSnapshotR2Key,
			body: args.markdownContent,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		}),
	]);

	return {
		fileNodeId: args.outputFileNode._id,
		markdownContent: args.markdownContent,
		markdownAssetId: args.outputAssetId,
		markdownSize,
		yjsSnapshotAssetId,
		yjsSnapshotSize: snapshotUpdate._yay.byteLength,
		versionSnapshotAssetId,
		versionSnapshotSize: markdownSize,
	};
}

async function clear_upload_processing_assets(ctx: ActionCtx, assetIds: Array<Id<"files_r2_assets">>) {
	await Promise.all(
		assetIds.map((assetId) =>
			ctx.runMutation(internal.r2.patch_asset, {
				assetId,
				conversionWorkId: null,
			}),
		),
	);
}

async function get_billed_user_for_media_processing(ctx: ActionCtx, sourceFileNode: Doc<"files_nodes">) {
	const scope = r2_require_real_scope(sourceFileNode.organizationId, sourceFileNode.workspaceId);
	const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
		userId: r2_require_real_author(sourceFileNode.createdBy),
		organizationId: scope.organizationId,
		minimumRequiredCents: 1,
	});
	if (!creditCheck.hasCredits || !creditCheck.billedUser) {
		return null;
	}

	return creditCheck.billedUser;
}

async function db_has_media_processing_credits(ctx: MutationCtx, sourceFileNode: Doc<"files_nodes">) {
	const scope = r2_require_real_scope(sourceFileNode.organizationId, sourceFileNode.workspaceId);
	const createdBy = r2_require_real_author(sourceFileNode.createdBy);
	const organization = await ctx.db.get("organizations", scope.organizationId);
	if (!organization) {
		throw should_never_happen("Organization not found while checking media upload credits", {
			userId: createdBy,
			organizationId: scope.organizationId,
		});
	}

	const billedUserId = billing_pick_billed_user_id({
		userId: createdBy,
		organization,
	});
	const creditCheck = await billing_db_check_credits(ctx, {
		userId: billedUserId,
		minimumRequiredCents: 1,
	});
	return creditCheck.hasCredits;
}

async function archive_active_node_and_descendants(
	ctx: MutationCtx,
	args: {
		node: {
			_id: Id<"files_nodes">;
			organizationId: Doc<"files_nodes">["organizationId"];
			workspaceId: Doc<"files_nodes">["workspaceId"];
			path: string;
		};
		updatedBy: Id<"users">;
		now: number;
	},
) {
	const archiveOperationId = crypto.randomUUID();
	const descendantsPathPrefix = `${args.node.path}/`;
	// Archive existing descendants with a range query so a generated output can
	// take over the active name atomically.
	const descendants = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.node.organizationId)
				.eq("workspaceId", args.node.workspaceId)
				.gte("path", descendantsPathPrefix)
				.lt("path", `${descendantsPathPrefix}\uffff`),
		)
		.collect();

	await Promise.all([
		(async () => {
			const node = await ctx.db.get("files_nodes", args.node._id);
			await ctx.db.patch("files_nodes", args.node._id, {
				archiveOperationId,
				updatedBy: args.updatedBy,
				updatedAt: args.now,
			});
			if (node?.kind === "file") {
				await db_patch_file_chunks_scope(ctx, {
					organizationId: args.node.organizationId,
					workspaceId: args.node.workspaceId,
					nodeId: args.node._id,
					archiveOperationId,
				});
			}
		})(),
		...descendants
			.filter((descendant) => descendant.archiveOperationId === undefined)
			.map(async (descendant) => {
				await ctx.db.patch("files_nodes", descendant._id, {
					archiveOperationId,
					updatedBy: args.updatedBy,
					updatedAt: args.now,
				});
				if (descendant.kind === "file") {
					await db_patch_file_chunks_scope(ctx, {
						organizationId: descendant.organizationId,
						workspaceId: descendant.workspaceId,
						nodeId: descendant._id,
						archiveOperationId,
					});
				}
			}),
	]);
}

async function create_generated_markdown_output_node(
	ctx: MutationCtx,
	args: {
		sourceFileNode: {
			organizationId: Doc<"files_nodes">["organizationId"];
			workspaceId: Doc<"files_nodes">["workspaceId"];
			parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
			createdBy: Doc<"files_nodes">["createdBy"];
		};
		name: string;
		now: number;
	},
) {
	const authorUserId = r2_require_real_author(args.sourceFileNode.createdBy);
	const createScope = r2_require_real_scope(args.sourceFileNode.organizationId, args.sourceFileNode.workspaceId);
	// Expose the generated output as a normal file immediately; finalization
	// later fills in its R2 key and Yjs state.
	const activeNameConflict = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", args.sourceFileNode.organizationId)
				.eq("workspaceId", args.sourceFileNode.workspaceId)
				.eq("parentId", args.sourceFileNode.parentId)
				.eq("name", args.name)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (activeNameConflict) {
		await archive_active_node_and_descendants(ctx, {
			node: activeNameConflict,
			updatedBy: authorUserId,
			now: args.now,
		});
	}

	const assetId = await ctx.db.insert("files_r2_assets", {
		organizationId: args.sourceFileNode.organizationId,
		workspaceId: args.sourceFileNode.workspaceId,
		kind: "content",
		r2Bucket: r2_get_bucket(),
		size: 0,
		createdBy: args.sourceFileNode.createdBy,
		updatedAt: args.now,
	});

	const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
		userId: authorUserId,
		organizationId: createScope.organizationId,
		workspaceId: createScope.workspaceId,
		parentId: args.sourceFileNode.parentId,
		path: args.name,
		kind: "file",
		contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		assetId,
		now: args.now,
	});
	if (node._nay) {
		return node;
	}

	return Result({ _yay: { nodeId: node._yay, assetId } });
}

export const describe_image_upload_to_markdown = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		sourceAssetId: v.id("files_r2_assets"),
		outputAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode, outputFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.outputAssetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result, get_file_node_by_asset_id_Result];
		if (!sourceAsset) {
			return null;
		}
		if (
			!sourceFileNode ||
			!outputFileNode ||
			outputFileNode.kind !== "file" ||
			files_node_has_editable_yjs_state(sourceFileNode) ||
			upload_content_type_media_kind(sourceFileNode.contentType) !== "image"
		) {
			await clear_upload_processing_assets(ctx, [sourceAsset._id, args.outputAssetId]);
			return null;
		}
		if (!sourceAsset.r2Key) {
			const errorMessage = "sourceAsset.r2Key is not set";
			console.error(errorMessage, { sourceAssetId: sourceAsset._id });
			throw should_never_happen(errorMessage, { sourceAssetId: sourceAsset._id });
		}

		const billedUser = await get_billed_user_for_media_processing(ctx, sourceFileNode);
		if (!billedUser) {
			await clear_upload_processing_assets(ctx, [sourceAsset._id, args.outputAssetId]);
			return null;
		}

		const sourceUrl = await r2_get_download_url({
			key: sourceAsset.r2Key,
			options: {
				expiresIn: 15 * 60,
			},
		});
		const result = await generateText({
			model: openai(MEDIA_DESCRIPTION_MODEL_ID),
			system:
				"Describe uploaded images for an app file tree. " +
				"Write useful, concrete Markdown for a reader who cannot see the image. " +
				"Include visible text, UI details, objects, people, layout, and any uncertainty. " +
				"Return raw Markdown without wrapping it in a code fence.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `Describe this uploaded image named ${sourceFileNode.name}.`,
						},
						{
							type: "image",
							image: sourceUrl,
						},
					],
				},
			],
			maxOutputTokens: 900,
		});

		await ingest_media_ai_usage_event(ctx, {
			sourceFileNode,
			billedUser,
			modelId: MEDIA_DESCRIPTION_MODEL_ID,
			operationId: "image_description",
			inputTokens: result.totalUsage.inputTokens ?? 0,
			outputTokens: result.totalUsage.outputTokens ?? 0,
		});

		const description = unwrap_generated_markdown_response(result.text) || "No image description could be generated.";
		const markdownContent = `# Image description: ${sourceFileNode.name}\n\n${description}`;
		const output = await write_uploaded_media_markdown_output_objects(ctx, {
			sourceFileNode,
			outputFileNode,
			outputAssetId: args.outputAssetId,
			markdownContent,
		});
		const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_media_markdown_outputs, {
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			userId: r2_require_real_author(sourceFileNode.createdBy),
			sourceAssetId: sourceAsset._id,
			outputs: [output],
		})) as finalize_uploaded_media_markdown_outputs_Result;
		if (finalized._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded image description",
				cause: finalized._nay,
			});
		}

		return null;
	},
});

export const summarize_video_upload_to_markdown = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		sourceAssetId: v.id("files_r2_assets"),
		summaryOutputAssetId: v.id("files_r2_assets"),
		transcriptOutputAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode, summaryOutputFileNode, transcriptOutputFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.summaryOutputAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.transcriptOutputAssetId,
			}),
		])) as [
			get_asset_by_id_Result,
			get_file_node_by_asset_id_Result,
			get_file_node_by_asset_id_Result,
			get_file_node_by_asset_id_Result,
		];
		if (!sourceAsset) {
			return null;
		}

		const workAssetIds = [sourceAsset._id, args.summaryOutputAssetId, args.transcriptOutputAssetId];
		if (
			!sourceFileNode ||
			!summaryOutputFileNode ||
			!transcriptOutputFileNode ||
			summaryOutputFileNode.kind !== "file" ||
			transcriptOutputFileNode.kind !== "file" ||
			files_node_has_editable_yjs_state(sourceFileNode) ||
			upload_content_type_media_kind(sourceFileNode.contentType) !== "video"
		) {
			await clear_upload_processing_assets(ctx, workAssetIds);
			return null;
		}
		if (!sourceAsset.r2Key) {
			const errorMessage = "sourceAsset.r2Key is not set";
			console.error(errorMessage, { sourceAssetId: sourceAsset._id });
			throw should_never_happen(errorMessage, { sourceAssetId: sourceAsset._id });
		}

		const billedUser = await get_billed_user_for_media_processing(ctx, sourceFileNode);
		if (!billedUser) {
			await clear_upload_processing_assets(ctx, workAssetIds);
			return null;
		}

		// Use sparse frame samples as visual context; the transcript is the
		// authoritative long-form signal for summaries.
		const frames: Array<{ timeSeconds: number; bytes: Uint8Array }> = [];
		for (const timeSeconds of MEDIA_FRAME_SAMPLE_TIMES_SECONDS) {
			const bytes = await fetch_video_frame({ r2Key: sourceAsset.r2Key, timeSeconds });
			if (!bytes) {
				if (timeSeconds > 0) break;
				continue;
			}

			frames.push({ timeSeconds, bytes });
		}

		const transcriptSegments: Array<{ startSeconds: number; text: string }> = [];
		let transcriptionInputTokens = 0;
		let transcriptionOutputTokens = 0;
		for (const startSeconds of MEDIA_AUDIO_SEGMENT_START_SECONDS) {
			// Prefer bounded Worker-extracted audio segments so Convex does not
			// proxy full video bytes for normal, short upload processing.
			const audioBytes = await fetch_video_audio_segment({
				r2Key: sourceAsset.r2Key,
				startSeconds,
				durationSeconds: MEDIA_AUDIO_SEGMENT_DURATION_SECONDS,
			});
			if (!audioBytes) {
				if (startSeconds > 0) break;
				continue;
			}

			const segment = await transcribe_audio_segment({ audioBytes, startSeconds });
			if (!segment) {
				continue;
			}

			transcriptSegments.push({
				startSeconds: segment.startSeconds,
				text: segment.text,
			});
			transcriptionInputTokens += segment.inputTokens;
			transcriptionOutputTokens += segment.outputTokens;
		}
		if (transcriptSegments.length === 0) {
			// Recover compressed long MP4s that Cloudflare Media refuses because of
			// source-duration limits, while still respecting OpenAI's byte cap.
			const sourceSegment = await transcribe_original_video_upload({ sourceAsset, sourceFileNode });
			if (sourceSegment) {
				transcriptSegments.push({
					startSeconds: sourceSegment.startSeconds,
					text: sourceSegment.text,
				});
				transcriptionInputTokens += sourceSegment.inputTokens;
				transcriptionOutputTokens += sourceSegment.outputTokens;
			}
		}

		await ingest_media_ai_usage_event(ctx, {
			sourceFileNode,
			billedUser,
			modelId: MEDIA_TRANSCRIPTION_MODEL_ID,
			operationId: "video_transcript",
			inputTokens: transcriptionInputTokens,
			outputTokens: transcriptionOutputTokens,
		});

		const transcriptMarkdown = build_video_transcript_markdown({
			filename: sourceFileNode.name,
			segments: transcriptSegments,
		});

		let summaryText = "No video summary could be generated from the sampled frames or audio.";
		if (frames.length > 0 || transcriptSegments.length > 0) {
			const frameContent = frames.flatMap((frame) => [
				{
					type: "text" as const,
					text: `Frame at ${format_seconds_timestamp(frame.timeSeconds)}:`,
				},
				{
					type: "image" as const,
					image: frame.bytes,
				},
			]);
			const result = await generateText({
				model: openai(MEDIA_DESCRIPTION_MODEL_ID),
				system:
					"Summarize uploaded videos for an app file tree. " +
					"Use the transcript and sampled frames to produce concise, useful Markdown. " +
					"Call out visible UI, slides, people, actions, and uncertainty when the samples are incomplete. " +
					"Return raw Markdown without wrapping it in a code fence.",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text:
									`Summarize the uploaded video named ${sourceFileNode.name}.\n\n` +
									`Transcript samples:\n\n${transcriptMarkdown}`,
							},
							...frameContent,
						],
					},
				],
				maxOutputTokens: 1_200,
			});

			await ingest_media_ai_usage_event(ctx, {
				sourceFileNode,
				billedUser,
				modelId: MEDIA_DESCRIPTION_MODEL_ID,
				operationId: "video_summary",
				inputTokens: result.totalUsage.inputTokens ?? 0,
				outputTokens: result.totalUsage.outputTokens ?? 0,
			});
			summaryText = unwrap_generated_markdown_response(result.text) || summaryText;
		}

		const [summaryOutput, transcriptOutput] = await Promise.all([
			write_uploaded_media_markdown_output_objects(ctx, {
				sourceFileNode,
				outputFileNode: summaryOutputFileNode,
				outputAssetId: args.summaryOutputAssetId,
				markdownContent: `# Video summary: ${sourceFileNode.name}\n\n${summaryText}`,
			}),
			write_uploaded_media_markdown_output_objects(ctx, {
				sourceFileNode,
				outputFileNode: transcriptOutputFileNode,
				outputAssetId: args.transcriptOutputAssetId,
				markdownContent: transcriptMarkdown,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_media_markdown_outputs, {
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			userId: r2_require_real_author(sourceFileNode.createdBy),
			sourceAssetId: sourceAsset._id,
			outputs: [summaryOutput, transcriptOutput],
		})) as finalize_uploaded_media_markdown_outputs_Result;
		if (finalized._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded video markdown outputs",
				cause: finalized._nay,
			});
		}

		return null;
	},
});

export const finalize_uploaded_markdown_file = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		sourceAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.sourceAssetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result];
		if (!sourceAsset) {
			return null;
		}

		if (!sourceFileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!sourceFileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (files_node_has_editable_yjs_state(sourceFileNode)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!sourceAsset.r2Key) {
			const errorMessage = "sourceAsset.r2Key is not set";
			const errorData = {
				sourceAssetId: sourceAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const response = await r2_fetch_object_from_bucket({ key: sourceAsset.r2Key });
		const markdownContent = await response.text();
		if (files_get_utf8_byte_size(markdownContent) > files_MAX_TEXT_CONTENT_BYTES) {
			// Treat over-limit Markdown uploads as processed stored files; retrying cannot make the content smaller.
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}

		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(markdownContent);
		if (snapshotUpdate._nay) {
			throw convex_error({
				message: "Failed to create uploaded Markdown snapshot",
				cause: snapshotUpdate._nay,
			});
		}

		// Promote Markdown uploads into normal Markdown-owned assets; downstream reads should not distinguish upload vs app-created files.
		const [markdownAssetId, yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: sourceFileNode.organizationId,
				workspaceId: sourceFileNode.workspaceId,
				kind: "content",
				size: files_get_utf8_byte_size(markdownContent),
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: sourceFileNode.organizationId,
				workspaceId: sourceFileNode.workspaceId,
				kind: "yjs_snapshot",
				size: snapshotUpdate._yay.byteLength,
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: sourceFileNode.organizationId,
				workspaceId: sourceFileNode.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(markdownContent),
				createdBy: sourceFileNode.createdBy,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">, Id<"files_r2_assets">];

		const markdownR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: markdownAssetId,
		});
		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: markdownContent,
				contentType: sourceFileNode.contentType,
			}),
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: markdownContent,
				contentType: sourceFileNode.contentType,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.r2.finalize_markdown_file_node_from_r2_assets, {
			organizationId: sourceFileNode.organizationId,
			workspaceId: sourceFileNode.workspaceId,
			fileNodeId: sourceFileNode._id,
			path: sourceFileNode.path,
			archiveOperationId: sourceFileNode.archiveOperationId,
			userId: r2_require_real_author(sourceFileNode.createdBy),
			markdownAssetId,
			markdownSize: files_get_utf8_byte_size(markdownContent),
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(markdownContent),
			markdownContent,
			conversionWorkAssetIds: [sourceAsset._id],
		})) as finalize_markdown_file_node_from_r2_assets_Result;
		if (finalized._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded Markdown file",
				cause: finalized._nay,
			});
		}

		return null;
	},
});

const upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export const process_uploaded_asset_event = internalMutation({
	args: {
		assetId: v.id("files_r2_assets"),
		r2Key: v.string(),
		size: v.number(),
		etag: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset) {
			const errorMessage = "args.assetId points to a missing files_r2_assets doc";
			const errorData = {
				assetId: args.assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const sourceFileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", asset.organizationId).eq("workspaceId", asset.workspaceId).eq("assetId", asset._id),
			)
			.first();

		const now = Date.now();
		await ctx.db.patch("files_r2_assets", asset._id, {
			r2Key: args.r2Key,
			size: args.size,
			...(args.etag === undefined ? {} : { etag: args.etag }),
			updatedAt: now,
		});

		if (asset.kind !== "upload") {
			return Result({ _yay: null });
		}

		const shouldStartProcessing = asset.conversionWorkId === undefined;
		if (!shouldStartProcessing) {
			return Result({ _yay: null });
		}
		if (
			!sourceFileNode ||
			sourceFileNode.archiveOperationId !== undefined ||
			files_node_has_editable_yjs_state(sourceFileNode)
		) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				conversionWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		const sourceFileNodeIsMarkdown =
			sourceFileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;
		const sourceFileNodeIsPdf = sourceFileNode.contentType?.startsWith("application/pdf") ?? false;
		const sourceFileNodeMediaKind = upload_content_type_media_kind(sourceFileNode.contentType);
		if (!sourceFileNodeIsMarkdown && !sourceFileNodeIsPdf && !sourceFileNodeMediaKind) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				conversionWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		try {
			if (sourceFileNodeIsMarkdown) {
				const workId = await upload_conversion_workpool.enqueueAction(
					ctx,
					internal.r2.finalize_uploaded_markdown_file,
					{
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						sourceAssetId: asset._id,
					},
				);

				await ctx.db.patch("files_r2_assets", asset._id, {
					conversionWorkId: workId,
					updatedAt: now,
				});
				return Result({ _yay: null });
			}

			if (sourceFileNodeMediaKind) {
				// Gate before creating AI-generated siblings so users without credits
				// do not see placeholder files for work that will never start.
				const hasCredits = await db_has_media_processing_credits(ctx, sourceFileNode);
				if (!hasCredits) {
					await ctx.db.patch("files_r2_assets", asset._id, {
						conversionWorkId: null,
						updatedAt: now,
					});
					return Result({ _yay: null });
				}

				if (sourceFileNodeMediaKind === "image") {
					// Create the visible sibling first; the action later replaces its
					// status-only asset with finalized Markdown/Yjs content.
					const descriptionOutput = await create_generated_markdown_output_node(ctx, {
						sourceFileNode,
						name: generated_image_description_file_node_name(sourceFileNode.name),
						now,
					});
					if (descriptionOutput._nay) {
						throw convex_error({
							message: "Failed to create generated image description output",
							cause: descriptionOutput._nay,
						});
					}

					const workId = await upload_conversion_workpool.enqueueAction(
						ctx,
						internal.r2.describe_image_upload_to_markdown,
						{
							organizationId: asset.organizationId,
							workspaceId: asset.workspaceId,
							sourceAssetId: asset._id,
							outputAssetId: descriptionOutput._yay.assetId,
						},
					);

					await Promise.all([
						ctx.db.patch("files_r2_assets", asset._id, {
							conversionWorkId: workId,
							updatedAt: now,
						}),
						ctx.db.patch("files_r2_assets", descriptionOutput._yay.assetId, {
							conversionWorkId: workId,
							updatedAt: now,
						}),
					]);
					return Result({ _yay: null });
				}

				// Summary and transcript are independent editable outputs, so create
				// both visible siblings before the shared video processing job starts.
				const [summaryOutput, transcriptOutput] = await Promise.all([
					create_generated_markdown_output_node(ctx, {
						sourceFileNode,
						name: generated_video_summary_file_node_name(sourceFileNode.name),
						now,
					}),
					create_generated_markdown_output_node(ctx, {
						sourceFileNode,
						name: generated_video_transcript_file_node_name(sourceFileNode.name),
						now,
					}),
				]);
				if (summaryOutput._nay || transcriptOutput._nay) {
					throw convex_error({
						message: "Failed to create generated video Markdown outputs",
						cause: summaryOutput._nay ?? transcriptOutput._nay,
					});
				}

				const workId = await upload_conversion_workpool.enqueueAction(
					ctx,
					internal.r2.summarize_video_upload_to_markdown,
					{
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						sourceAssetId: asset._id,
						summaryOutputAssetId: summaryOutput._yay.assetId,
						transcriptOutputAssetId: transcriptOutput._yay.assetId,
					},
				);

				await Promise.all([
					ctx.db.patch("files_r2_assets", asset._id, {
						conversionWorkId: workId,
						updatedAt: now,
					}),
					ctx.db.patch("files_r2_assets", summaryOutput._yay.assetId, {
						conversionWorkId: workId,
						updatedAt: now,
					}),
					ctx.db.patch("files_r2_assets", transcriptOutput._yay.assetId, {
						conversionWorkId: workId,
						updatedAt: now,
					}),
				]);
				return Result({ _yay: null });
			}

			const convertedMarkdownOutput = await create_generated_markdown_output_node(ctx, {
				sourceFileNode,
				name: generated_markdown_file_node_name(sourceFileNode.name),
				now,
			});
			if (convertedMarkdownOutput._nay) {
				throw convex_error({
					message: "Failed to create generated Markdown output",
					cause: convertedMarkdownOutput._nay,
				});
			}

			// Mark both the source upload and generated placeholder with the same
			// job id so either screen can show processing.
			const workId = await upload_conversion_workpool.enqueueAction(ctx, internal.r2.convert_upload_to_markdown, {
				organizationId: asset.organizationId,
				workspaceId: asset.workspaceId,
				sourceAssetId: asset._id,
				outputAssetId: convertedMarkdownOutput._yay.assetId,
			});

			await Promise.all([
				ctx.db.patch("files_r2_assets", asset._id, {
					conversionWorkId: workId,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", convertedMarkdownOutput._yay.assetId, {
					conversionWorkId: workId,
					updatedAt: now,
				}),
			]);
			return Result({ _yay: null });
		} catch (error) {
			console.error("Failed to enqueue R2 upload processing", {
				error,
				assetId: asset._id,
			});
			throw convex_error({
				message: "Failed to enqueue upload processing",
				cause: error,
			});
		}
	},
});

export function r2_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/r2/event" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						/**
						 * Cloudflare R2 event notification payload.
						 *
						 * @see https://developers.cloudflare.com/r2/buckets/event-notifications/#message-format
						 */
						const bodyValidator = z.object({
							cloudflareMessageId: z.string(),
							attempts: z.number(),
							event: z.discriminatedUnion("action", [
								z.object({
									account: z.string().optional(),
									action: z.literal("PutObject"),
									bucket: z.string(),
									object: z.object({
										key: z.string(),
										size: z.number(),
										eTag: z.string().optional(),
									}),
									eventTime: z.string(),
								}),
								z.object({
									account: z.string().optional(),
									action: z.literal("CopyObject"),
									bucket: z.string(),
									object: z.object({
										key: z.string(),
										size: z.number(),
										eTag: z.string().optional(),
									}),
									eventTime: z.string(),
								}),
								z.object({
									account: z.string().optional(),
									action: z.literal("CompleteMultipartUpload"),
									bucket: z.string(),
									object: z.object({
										key: z.string(),
										size: z.number(),
										eTag: z.string().optional(),
									}),
									eventTime: z.string(),
								}),
								z.object({
									account: z.string().optional(),
									action: z.literal("DeleteObject"),
									bucket: z.string(),
									object: z.object({
										key: z.string(),
										size: z.undefined().optional(),
										eTag: z.undefined().optional(),
									}),
									eventTime: z.string(),
								}),
								z.object({
									account: z.string().optional(),
									action: z.literal("LifecycleDeletion"),
									bucket: z.string(),
									object: z.object({
										key: z.string(),
										size: z.undefined().optional(),
										eTag: z.undefined().optional(),
									}),
									eventTime: z.string(),
								}),
							]),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								// Accept only the trusted Cloudflare event forwarder for R2 notifications.
								if (request.headers.get("Authorization") !== `Bearer ${CLOUDFLARE_EVENTS_SECRET}`) {
									return {
										status: 401,
										body: {
											message: "Unauthenticated",
										},
									} as const;
								}

								const body = await server_request_json_parse_and_validate(request, bodyValidator);
								if (body._nay) {
									return {
										status: 400,
										body: body._nay,
									} as const;
								}

								if (body._yay.event.action === "DeleteObject" || body._yay.event.action === "LifecycleDeletion") {
									return {
										status: 204,
										body: {},
									} as const;
								}

								const asset = (await ctx.runQuery(internal.r2.get_asset_by_r2_event_key, {
									bucket: body._yay.event.bucket,
									key: body._yay.event.object.key,
								})) as get_asset_by_r2_event_key_Result;
								if (asset._nay) {
									return {
										status: asset._nay.message === "Not found" ? 404 : 503,
										body: {
											message: asset._nay.message,
										},
									} as const;
								}

								if (asset._yay.kind !== "upload") {
									// The finalizer is upload-oriented. Generated objects are written by Convex actions.
									return {
										status: 204,
										body: {},
									} as const;
								}

								await ctx.runMutation(internal.r2.process_uploaded_asset_event, {
									assetId: asset._yay._id,
									r2Key: body._yay.event.object.key,
									size: body._yay.event.object.size,
									etag: body._yay.event.object.eTag,
								});

								// The mutation owns idempotency and enqueues any needed upload work.
								return {
									status: 204,
									body: {},
								} as const;
							} catch (error: unknown) {
								console.error("R2 event HTTP route failed", { error });
								return {
									status: 500,
									body: {
										message: "Internal server error",
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 204) {
									return new Response(null, { status: result.status });
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("generated_markdown_file_node_name", () => {
		test("appends .md to the full source name without parsing extensions", () => {
			expect(generated_markdown_file_node_name("report.pdf")).toBe("report.pdf.md");
			expect(generated_markdown_file_node_name("report.final.v2.pdf")).toBe("report.final.v2.pdf.md");
			expect(generated_markdown_file_node_name("README")).toBe("README.md");
		});
	});

	describe("generated media file node names", () => {
		test("uses full source names for image and video generated siblings", () => {
			expect(generated_image_description_file_node_name("a.png")).toBe("a.png.description.md");
			expect(generated_video_summary_file_node_name("clip.mp4")).toBe("clip.mp4.summary.md");
			expect(generated_video_transcript_file_node_name("clip.mp4")).toBe("clip.mp4.transcript.md");
		});
	});

	describe("upload_content_type_media_kind", () => {
		test("detects supported image and video MIME types", () => {
			expect(upload_content_type_media_kind("image/png")).toBe("image");
			expect(upload_content_type_media_kind("image/gif")).toBe("image");
			expect(upload_content_type_media_kind("video/mp4")).toBe("video");
			expect(upload_content_type_media_kind("video/quicktime; charset=binary")).toBe("video");
			expect(upload_content_type_media_kind("application/pdf")).toBeNull();
		});
	});

	describe("unwrap_generated_markdown_response", () => {
		test("removes one wrapping Markdown code fence", () => {
			expect(unwrap_generated_markdown_response("```markdown\n# Summary\n\nBody\n```")).toBe("# Summary\n\nBody");
			expect(unwrap_generated_markdown_response("# Summary\n\nBody")).toBe("# Summary\n\nBody");
		});
	});
}
