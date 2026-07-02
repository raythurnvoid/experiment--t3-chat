import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { z } from "zod";

import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import app_convex_schema from "./schema.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import {
	plugins_LOCKFILE_PATH,
	plugins_RUNTIME_VERSION,
	plugins_SECRET_VALUE_MAX_BYTES,
	plugins_dist_review_mechanical_findings,
	plugins_name_autofix_and_validate,
	plugins_normalize_relative_path,
	plugins_origin_validate,
	plugins_parse_github_repository_url,
	plugins_manifest_schema,
	plugins_secret_name_validate,
	plugins_source_mount_name,
	plugins_validate_artifact,
} from "../shared/plugins.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_MOUNT_ROOT, files_get_utf8_byte_size } from "../shared/files.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_fetch_object_from_bucket, r2_put_object } from "./r2.ts";

const install_permission = "workspace.plugins.manage" as const;
const plugin_import_user_agent = "t3-chat-plugin-import";
const plugin_import_max_source_files = 500;
const plugin_import_max_source_bytes = 5 * 1024 * 1024;
const plugin_import_excluded_dir_segments = new Set(["node_modules", ".git", ".next", ".turbo", "coverage"]);
const plugin_import_binary_extensions = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"tiff",
	"avif",
	"heic",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"zip",
	"gz",
	"tgz",
	"7z",
	"rar",
	"tar",
	"mp3",
	"mp4",
	"wav",
	"ogg",
	"webm",
	"mov",
	"avi",
	"mkv",
	"flac",
	"m4a",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"wasm",
	"so",
	"dylib",
	"dll",
	"exe",
	"o",
	"a",
	"class",
	"jar",
	"node",
	"sqlite",
	"db",
	"bin",
	"dat",
	"pyc",
]);
const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

const github_repo_schema = z.object({ default_branch: z.string().min(1) });
const github_commit_schema = z.object({ sha: z.string().min(1) });
const github_tree_schema = z.object({
	truncated: z.boolean().optional(),
	tree: z.array(
		z.object({
			path: z.string(),
			type: z.string(),
			size: z.number().optional(),
		}),
	),
});

type PluginResult<T> = { _yay: T; _nay?: undefined } | { _nay: { message: string }; _yay?: undefined };
type PluginFileNodeResult = PluginResult<{ nodeId: Id<"files_nodes"> }>;
type PluginRegisterVerifiedVersionResult = PluginResult<{
	pluginVersionId: Id<"plugins_versions">;
	sourceMountName: string;
}>;
type PluginLockfileRefreshResult = PluginFileNodeResult;
type PluginVersionReviewResult = PluginResult<{
	status: "passed" | "rejected" | "flagged";
	mechanicalFindings: string[];
	aiFindings: string[];
}>;
type PluginArtifactFile = { path: string; sha256: string; bytes: number; contentType: string };
type PluginSourceFile = { path: string; rawText: string };

async function authorize_manage(
	ctx: Parameters<typeof organizations_db_get_membership>[0],
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const organization = await ctx.db.get("organizations", membership.organizationId);
	if (!organization?.defaultWorkspaceId) {
		console.error("organization.defaultWorkspaceId is not set", { organizationId: membership.organizationId });
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const hasPermission = await access_control_db_has_permission(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resourceKind: "workspace",
		resourceId: String(membership.workspaceId),
		permission: install_permission,
		userId: args.userId,
	});
	if (!hasPermission) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: { membership } });
}

function bytes_to_base64(bytes: Uint8Array) {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
		const chunk = bytes.subarray(offset, offset + 8192);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function base64_to_bytes(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

async function sha256_hex_bytes(bytes: BufferSource) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

const plugin_secret_key_version = 1;

async function secret_crypto_key(keyVersion: number) {
	if (keyVersion !== 1) {
		throw new Error(`Unsupported plugin secret key version ${keyVersion}`);
	}
	const secret = process.env.PLUGIN_SECRETS_ENCRYPTION_KEY;
	if (!secret) {
		throw new Error("PLUGIN_SECRETS_ENCRYPTION_KEY is not set in Convex env");
	}
	const digest = await crypto.subtle.digest("SHA-256", text_encoder.encode(secret));
	return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * AES-GCM additional data binds a ciphertext to its owning scope and name, so a
 * row copied onto another installation/publisher or renamed fails to decrypt.
 */
async function encrypt_secret_value(value: string, additionalData: string) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(plugin_secret_key_version),
		text_encoder.encode(value),
	);
	return {
		ciphertext: bytes_to_base64(new Uint8Array(ciphertext)),
		nonce: bytes_to_base64(nonce),
		keyVersion: plugin_secret_key_version,
	};
}

async function decrypt_secret_value(
	secret: { ciphertext: string; nonce: string; keyVersion: number },
	additionalData: string,
) {
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64_to_bytes(secret.nonce), additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(secret.keyVersion),
		base64_to_bytes(secret.ciphertext),
	);
	return text_decoder.decode(plaintext);
}

function validate_secret_input(args: { name: string; value: string }) {
	const name = plugins_secret_name_validate(args.name);
	if (name._nay) {
		return Result({ _nay: { message: name._nay.message } });
	}
	if (text_encoder.encode(args.value).byteLength > plugins_SECRET_VALUE_MAX_BYTES) {
		return Result({ _nay: { message: "Secret value is too large" } });
	}
	return Result({ _yay: { name: name._yay, value: args.value } });
}

async function upsert_installation_secret_doc(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		name: string;
		value: string;
		userId: Id<"users">;
		now: number;
	},
) {
	const encrypted = await encrypt_secret_value(args.value, `${args.installation._id}:${args.name}`);
	const existing = await ctx.db
		.query("plugins_workspace_installation_secrets")
		.withIndex("by_installation_name", (q) => q.eq("installationId", args.installation._id).eq("name", args.name))
		.first();

	if (existing) {
		await ctx.db.patch("plugins_workspace_installation_secrets", existing._id, {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			keyVersion: encrypted.keyVersion,
			valuePreview: "configured",
			updatedBy: args.userId,
			updatedAt: args.now,
		});
		return existing._id;
	}

	return await ctx.db.insert("plugins_workspace_installation_secrets", {
		organizationId: args.installation.organizationId,
		workspaceId: args.installation.workspaceId,
		installationId: args.installation._id,
		pluginName: args.installation.pluginName,
		name: args.name,
		ciphertext: encrypted.ciphertext,
		nonce: encrypted.nonce,
		keyVersion: encrypted.keyVersion,
		valuePreview: "configured",
		createdBy: args.userId,
		updatedBy: args.userId,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

async function upsert_publisher_secret_doc(
	ctx: MutationCtx,
	args: {
		publisher: Doc<"plugins_publishers">;
		name: string;
		value: string;
		/** Omitted means keep the existing origins (or none for a new secret). */
		allowedOrigins?: string[];
		now: number;
	},
) {
	const encrypted = await encrypt_secret_value(args.value, `${args.publisher._id}:${args.name}`);
	const existing = await ctx.db
		.query("plugins_publisher_secrets")
		.withIndex("by_publisher_name", (q) => q.eq("publisherId", args.publisher._id).eq("name", args.name))
		.first();

	if (existing) {
		await ctx.db.patch("plugins_publisher_secrets", existing._id, {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			keyVersion: encrypted.keyVersion,
			valuePreview: "configured",
			...(args.allowedOrigins === undefined ? {} : { allowedOrigins: args.allowedOrigins }),
			updatedAt: args.now,
		});
		return existing._id;
	}

	return await ctx.db.insert("plugins_publisher_secrets", {
		publisherId: args.publisher._id,
		name: args.name,
		ciphertext: encrypted.ciphertext,
		nonce: encrypted.nonce,
		keyVersion: encrypted.keyVersion,
		valuePreview: "configured",
		allowedOrigins: args.allowedOrigins ?? [],
		createdAt: args.now,
		updatedAt: args.now,
	});
}

function validate_allowed_origins_input(rawOrigins: string[]) {
	if (rawOrigins.length > 20) {
		return Result({ _nay: { message: "Too many allowed origins" } });
	}
	const allowedOrigins: string[] = [];
	for (const raw of rawOrigins) {
		const origin = plugins_origin_validate(raw);
		if (origin._nay) {
			return Result({ _nay: { message: origin._nay.message } });
		}
		if (!allowedOrigins.includes(origin._yay)) {
			allowedOrigins.push(origin._yay);
		}
	}
	return Result({ _yay: allowedOrigins });
}

function source_file_keep_reason(path: string) {
	const normalized = plugins_normalize_relative_path(path);
	if (normalized._nay) {
		return normalized;
	}
	const segments = normalized._yay.split("/");
	for (const segment of segments) {
		if (plugin_import_excluded_dir_segments.has(segment)) {
			return Result({ _nay: { message: `Source path is under excluded directory "${segment}"` } });
		}
	}
	const basename = segments.at(-1) ?? "";
	const extension = basename.includes(".") ? basename.slice(basename.lastIndexOf(".") + 1).toLowerCase() : "";
	if (extension && plugin_import_binary_extensions.has(extension)) {
		return Result({ _nay: { message: `Source path has binary extension ".${extension}"` } });
	}
	return Result({ _yay: normalized._yay });
}

function github_raw_url(args: { owner: string; repo: string; commitSha: string; path: string }) {
	const path = args.path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `https://raw.githubusercontent.com/${args.owner}/${args.repo}/${args.commitSha}/${path}`;
}

function github_error_message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function github_headers(accept?: string) {
	const headers: Record<string, string> = { "User-Agent": plugin_import_user_agent };
	if (accept) {
		headers.Accept = accept;
	}
	const token = process.env.PLUGIN_IMPORT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

async function fetch_github_json<T>(url: string, schema: z.ZodSchema<T>) {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: github_headers("application/vnd.github+json"),
		});
	} catch (error) {
		return Result({ _nay: { message: `GitHub request failed: ${github_error_message(error)}` } });
	}
	if (!response.ok) {
		return Result({ _nay: { message: `GitHub request failed with status ${response.status}` } });
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch (error) {
		return Result({ _nay: { message: `GitHub response was invalid JSON: ${github_error_message(error)}` } });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? "GitHub response was invalid" } });
	}
	return Result({ _yay: parsed.data });
}

async function fetch_github_text(args: {
	owner: string;
	repo: string;
	commitSha: string;
	path: string;
}): Promise<PluginResult<string>> {
	let response: Response;
	try {
		response = await fetch(github_raw_url(args), { headers: github_headers() });
	} catch (error) {
		return Result({ _nay: { message: `GitHub file "${args.path}" request failed: ${github_error_message(error)}` } });
	}
	if (!response.ok) {
		return Result({ _nay: { message: `GitHub file "${args.path}" failed with status ${response.status}` } });
	}
	const text = await response.text();
	if (files_get_utf8_byte_size(text) > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({ _nay: { message: `GitHub file "${args.path}" is too large` } });
	}
	return { _yay: text };
}

async function fetch_github_bytes(args: {
	owner: string;
	repo: string;
	commitSha: string;
	path: string;
}): Promise<PluginResult<ArrayBuffer>> {
	let response: Response;
	try {
		response = await fetch(github_raw_url(args), { headers: github_headers() });
	} catch (error) {
		return Result({ _nay: { message: `GitHub file "${args.path}" request failed: ${github_error_message(error)}` } });
	}
	if (!response.ok) {
		return Result({ _nay: { message: `GitHub file "${args.path}" failed with status ${response.status}` } });
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({ _nay: { message: `GitHub file "${args.path}" is too large` } });
	}
	return Result({ _yay: buffer });
}

function parse_json_text<T>(text: string, schema: z.ZodSchema<T>, errorMessage: string): PluginResult<T> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return Result({ _nay: { message: errorMessage } });
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? errorMessage } });
	}
	return { _yay: parsed.data };
}

function plugin_r2_key(args: { name: string; version: string; commitSha: string; path: string }) {
	return `plugins/${args.name}/${args.version}/${args.commitSha}/${args.path}`;
}

function source_file_path(args: { mountName: string; sourceFilePath: string }) {
	const relativePath = plugins_normalize_relative_path(args.sourceFilePath);
	if (relativePath._nay) {
		return relativePath;
	}
	return Result({ _yay: `/${args.mountName}/${relativePath._yay}` });
}

function lockfile_json(args: {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	updatedAt: number;
	installations: Array<{
		installation: Doc<"plugins_workspace_installations">;
		version: Doc<"plugins_versions">;
		sourceMount: Doc<"plugins_source_mounts"> | null;
	}>;
}) {
	const plugins = args.installations
		.toSorted((a, b) => a.installation.pluginName.localeCompare(b.installation.pluginName))
		.map(({ installation, version, sourceMount }) => ({
			name: installation.pluginName,
			displayName: version.displayName,
			version: version.version,
			artifactHash: version.artifactHash,
			sourceRepositoryUrl: version.sourceRepositoryUrl,
			sourceCommitSha: version.sourceCommitSha,
			sourceMountPath:
				sourceMount?.mountPath ?? (version.sourceMountName ? `${files_MOUNT_ROOT}/${version.sourceMountName}` : null),
			status: installation.status,
			acceptedCapabilities: installation.acceptedCapabilities,
			events: version.events,
			installationId: String(installation._id),
			pluginVersionId: String(version._id),
		}));

	return `${JSON.stringify(
		{
			schemaVersion: 1,
			organizationId: String(args.organizationId),
			workspaceId: String(args.workspaceId),
			updatedAt: args.updatedAt,
			plugins,
		},
		null,
		2,
	)}\n`;
}

export const register_verified_version = internalAction({
	args: {
		name: v.string(),
		displayName: v.string(),
		version: v.string(),
		description: v.string(),
		publisherId: v.id("plugins_publishers"),
		reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
		artifactHash: v.string(),
		sourceRepositoryUrl: v.string(),
		sourceOwner: v.string(),
		sourceRepo: v.string(),
		sourceDefaultBranch: v.string(),
		sourceCommitSha: v.string(),
		manifestR2Key: v.string(),
		artifactR2Key: v.string(),
		backend: doc(app_convex_schema, "plugins_versions").fields.backend,
		events: doc(app_convex_schema, "plugins_versions").fields.events,
		pages: doc(app_convex_schema, "plugins_versions").fields.pages,
		capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
		outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
		files: doc(app_convex_schema, "plugins_versions").fields.files,
		createdBy: v.id("users"),
		sourceFiles: v.array(v.object({ path: v.string(), rawText: v.string() })),
	},
	returns: v_result({ _yay: v.object({ pluginVersionId: v.id("plugins_versions"), sourceMountName: v.string() }) }),
	handler: async (ctx, args): Promise<PluginRegisterVerifiedVersionResult> => {
		const name = plugins_name_autofix_and_validate(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}
		if (name._yay !== args.name) {
			return Result({ _nay: { message: "Plugin name must already be normalized" } });
		}
		for (const sourceFile of args.sourceFiles) {
			const sourcePath = plugins_normalize_relative_path(sourceFile.path);
			if (sourcePath._nay) {
				return Result({ _nay: { message: sourcePath._nay.message } });
			}
		}

		const sourceMountName = plugins_source_mount_name({
			name: args.name,
			version: args.version,
			artifactHash: args.artifactHash,
		});
		const { sourceFiles, ...versionArgs } = args;
		const registered = (await ctx.runMutation(internal.plugins.register_verified_version_in_db, {
			...versionArgs,
			sourceMountName,
		})) as { _yay?: { pluginVersionId: Id<"plugins_versions"> }; _nay?: { message: string } };
		if (registered._nay) {
			return Result({ _nay: { message: registered._nay.message } });
		}
		if (!registered._yay) {
			return Result({ _nay: { message: "Failed to register plugin version" } });
		}

		let totalBytes = 0;
		for (const sourceFile of sourceFiles) {
			const sourcePath = source_file_path({ mountName: sourceMountName, sourceFilePath: sourceFile.path });
			if (sourcePath._nay) {
				await ctx.runMutation(internal.plugins.upsert_source_mount, {
					pluginVersionId: registered._yay.pluginVersionId,
					sourceRepositoryUrl: args.sourceRepositoryUrl,
					sourceCommitSha: args.sourceCommitSha,
					artifactHash: args.artifactHash,
					mountName: sourceMountName,
					status: "error",
					fileCount: sourceFiles.length,
					totalBytes,
					lastError: sourcePath._nay.message,
				});
				return Result({ _nay: { message: sourcePath._nay.message } });
			}
			totalBytes += sourceFile.rawText.length;
			const created = (await ctx.runAction(internal.files_nodes.create_file_node_internal, {
				path: sourcePath._yay,
				rawText: sourceFile.rawText,
			})) as PluginFileNodeResult;
			if (created._nay) {
				if (created._nay.message === "This file already exists.") {
					continue;
				}
				await ctx.runMutation(internal.plugins.upsert_source_mount, {
					pluginVersionId: registered._yay.pluginVersionId,
					sourceRepositoryUrl: args.sourceRepositoryUrl,
					sourceCommitSha: args.sourceCommitSha,
					artifactHash: args.artifactHash,
					mountName: sourceMountName,
					status: "error",
					fileCount: sourceFiles.length,
					totalBytes,
					lastError: created._nay.message,
				});
				return Result({ _nay: { message: created._nay.message } });
			}
		}

		await ctx.runMutation(internal.plugins.upsert_source_mount, {
			pluginVersionId: registered._yay.pluginVersionId,
			sourceRepositoryUrl: args.sourceRepositoryUrl,
			sourceCommitSha: args.sourceCommitSha,
			artifactHash: args.artifactHash,
			mountName: sourceMountName,
			status: "ready",
			fileCount: sourceFiles.length,
			totalBytes,
			lastError: null,
		});

		return Result({ _yay: { pluginVersionId: registered._yay.pluginVersionId, sourceMountName } });
	},
});

export const register_verified_version_in_db = internalMutation({
	args: {
		name: v.string(),
		displayName: v.string(),
		version: v.string(),
		description: v.string(),
		publisherId: v.id("plugins_publishers"),
		reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
		artifactHash: v.string(),
		sourceRepositoryUrl: v.string(),
		sourceOwner: v.string(),
		sourceRepo: v.string(),
		sourceDefaultBranch: v.string(),
		sourceCommitSha: v.string(),
		manifestR2Key: v.string(),
		artifactR2Key: v.string(),
		backend: doc(app_convex_schema, "plugins_versions").fields.backend,
		events: doc(app_convex_schema, "plugins_versions").fields.events,
		pages: doc(app_convex_schema, "plugins_versions").fields.pages,
		capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
		outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
		files: doc(app_convex_schema, "plugins_versions").fields.files,
		sourceMountName: v.string(),
		createdBy: v.id("users"),
	},
	returns: v_result({ _yay: v.object({ pluginVersionId: v.id("plugins_versions") }) }),
	handler: async (ctx, args) => {
		// A plugin name is bound to the publisher that first published it.
		const existingNamed = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.first();
		if (existingNamed && existingNamed.publisherId !== args.publisherId) {
			return Result({ _nay: { message: "Plugin name is already owned by another publisher" } });
		}

		const existingSameArtifact = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name_version_artifactHash", (q) =>
				q.eq("name", args.name).eq("version", args.version).eq("artifactHash", args.artifactHash),
			)
			.first();
		if (existingSameArtifact) {
			await ctx.db.patch("plugins_versions", existingSameArtifact._id, {
				displayName: args.displayName,
				description: args.description,
				reviewStatus: args.reviewStatus,
				sourceRepositoryUrl: args.sourceRepositoryUrl,
				sourceOwner: args.sourceOwner,
				sourceRepo: args.sourceRepo,
				sourceDefaultBranch: args.sourceDefaultBranch,
				sourceCommitSha: args.sourceCommitSha,
				manifestR2Key: args.manifestR2Key,
				artifactR2Key: args.artifactR2Key,
				backend: args.backend,
				events: args.events,
				pages: args.pages,
				capabilities: args.capabilities,
				outboundOrigins: args.outboundOrigins,
				files: args.files,
				sourceMountName: args.sourceMountName,
				updatedAt: Date.now(),
			});
			return Result({ _yay: { pluginVersionId: existingSameArtifact._id } });
		}

		const existingVersion = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name_version", (q) => q.eq("name", args.name).eq("version", args.version))
			.first();
		if (existingVersion) {
			return Result({ _nay: { message: "Plugin name and version already exist with a different artifact hash" } });
		}

		const now = Date.now();
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: args.name,
			displayName: args.displayName,
			version: args.version,
			description: args.description,
			publisherId: args.publisherId,
			reviewStatus: args.reviewStatus,
			runtimeVersion: plugins_RUNTIME_VERSION,
			artifactHash: args.artifactHash,
			sourceRepositoryUrl: args.sourceRepositoryUrl,
			sourceOwner: args.sourceOwner,
			sourceRepo: args.sourceRepo,
			sourceDefaultBranch: args.sourceDefaultBranch,
			sourceCommitSha: args.sourceCommitSha,
			manifestR2Key: args.manifestR2Key,
			artifactR2Key: args.artifactR2Key,
			backend: args.backend,
			events: args.events,
			pages: args.pages,
			capabilities: args.capabilities,
			outboundOrigins: args.outboundOrigins,
			files: args.files,
			sourceMountName: args.sourceMountName,
			createdBy: args.createdBy,
			createdAt: now,
			updatedAt: now,
		});

		return Result({ _yay: { pluginVersionId } });
	},
});

export const upsert_source_mount = internalMutation({
	args: {
		pluginVersionId: v.id("plugins_versions"),
		sourceRepositoryUrl: v.string(),
		sourceCommitSha: v.string(),
		artifactHash: v.string(),
		mountName: v.string(),
		status: doc(app_convex_schema, "plugins_source_mounts").fields.status,
		fileCount: v.number(),
		totalBytes: v.number(),
		lastError: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query("plugins_source_mounts")
			.withIndex("by_pluginVersion", (q) => q.eq("pluginVersionId", args.pluginVersionId))
			.first();
		const patch = {
			sourceRepositoryUrl: args.sourceRepositoryUrl,
			sourceCommitSha: args.sourceCommitSha,
			artifactHash: args.artifactHash,
			mountKind: "global-github-temporary" as const,
			mountName: args.mountName,
			mountPath: `${files_MOUNT_ROOT}/${args.mountName}`,
			storageOrganizationId: organizations_GLOBAL_ORGANIZATION_ID,
			storageWorkspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			status: args.status,
			fileCount: args.fileCount,
			totalBytes: args.totalBytes,
			lastError: args.lastError,
			updatedAt: now,
		};
		if (existing) {
			await ctx.db.patch("plugins_source_mounts", existing._id, patch);
			return null;
		}

		await ctx.db.insert("plugins_source_mounts", {
			pluginVersionId: args.pluginVersionId,
			...patch,
			createdAt: now,
		});
		return null;
	},
});

export const authorize_publish_scope = internalMutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v_result({
		_yay: v.object({
			userId: v.id("users"),
			publisherSlug: v.string(),
			owner: v.string(),
			repo: v.string(),
			repositoryUrl: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (repository.publisherId !== publisher._id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return Result({
			_yay: {
				userId: userAuth.id,
				publisherSlug: publisher.slug,
				owner: repository.owner,
				repo: repository.repo,
				repositoryUrl: repository.repositoryUrl,
			},
		});
	},
});

const plugin_review_model_id = "gpt-5.4-mini";

const plugin_review_verdict_schema = z.object({
	verdict: z.enum(["passed", "rejected", "flagged"]),
	findings: z.array(z.string()),
});

// Kept as a spy-able object so tests can stub the verdict without mocking OpenAI HTTP responses.
export const plugins_ai_review = {
	generate_verdict: async (args: { prompt: string }) => {
		const result = await generateObject({
			model: openai(plugin_review_model_id),
			temperature: 0,
			schema: plugin_review_verdict_schema,
			prompt: args.prompt,
		});
		return result.object;
	},
};

function plugin_review_line_diff(previousSource: string, nextSource: string) {
	const remaining = new Map<string, number>();
	for (const line of previousSource.split(/\r?\n/u)) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}
	const added: string[] = [];
	for (const line of nextSource.split(/\r?\n/u)) {
		const count = remaining.get(line) ?? 0;
		if (count > 0) {
			remaining.set(line, count - 1);
		} else {
			added.push(line);
		}
	}
	const removed: string[] = [];
	for (const [line, count] of remaining) {
		for (let index = 0; index < count; index++) {
			removed.push(line);
		}
	}
	return { added, removed };
}

function plugin_review_prompt(args: {
	distSource: string;
	capabilities: string[];
	outboundOrigins: string[];
	secretNames: string[];
	diff: { baseArtifactHash: string; added: string[]; removed: string[] } | null;
}) {
	return [
		"You review the backend dist of a workspace plugin before it is registered.",
		"Verdict rules:",
		'- "rejected": the code sends secret values to origins other than the declared outbound origins, writes secret values into file outputs, is obfuscated or dynamically assembled, or clearly does something outside its declared capabilities.',
		'- "flagged": suspicious but not clearly malicious — especially module-level mutable state that outlives one run (a module-level cache can be legitimate, but state shared across runs deserves a manual look).',
		'- "passed": none of the above.',
		'"Secret values" means the raw injected values of the secrets listed below — not content derived from user files or model responses. Writing derived content to file outputs is normal when a file-write capability is declared.',
		"Secrets that hold a host-configured URL or base URL count as declared outbound origins: the host enforces a runtime egress allowlist, so requests built from such secrets are not exfiltration by themselves.",
		"List one finding per concern; findings are shown to the plugin publisher.",
		"",
		`Declared capabilities: ${JSON.stringify(args.capabilities)}`,
		`Declared outbound origins: ${JSON.stringify(args.outboundOrigins)}`,
		`Secret names the plugin can read at runtime (values are injected by the host): ${JSON.stringify(args.secretNames)}`,
		...(args.diff
			? [
					"",
					`A previous version of this plugin already passed review (artifact ${args.diff.baseArtifactHash}). Focus on the changed lines.`,
					`Added lines:\n${args.diff.added.join("\n")}`,
					`Removed lines:\n${args.diff.removed.join("\n")}`,
				]
			: []),
		"",
		"Full dist source:",
		args.distSource,
	].join("\n");
}

export const get_version_review_by_artifact_hash = internalQuery({
	args: { artifactHash: v.string() },
	returns: v.union(doc(app_convex_schema, "plugins_version_reviews"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_artifactHash", (q) => q.eq("artifactHash", args.artifactHash))
			.first();
	},
});

export const get_version_review_context = internalQuery({
	args: {
		publisherId: v.id("plugins_publishers"),
		pluginName: v.string(),
	},
	returns: v.object({
		secretNames: v.array(v.string()),
		previousPassed: v.union(
			v.object({ artifactHash: v.string(), backendR2Key: v.union(v.string(), v.null()) }),
			v.null(),
		),
	}),
	handler: async (ctx, args) => {
		const secrets = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_publisher", (q) => q.eq("publisherId", args.publisherId))
			.take(100);
		const versions = await ctx.db
			.query("plugins_versions")
			.withIndex("by_name", (q) => q.eq("name", args.pluginName))
			.order("desc")
			.take(100);
		const previousPassed = versions.find((version) => version.reviewStatus === "passed") ?? null;
		return {
			secretNames: secrets.map((secret) => secret.name).toSorted((a, b) => a.localeCompare(b)),
			previousPassed: previousPassed
				? { artifactHash: previousPassed.artifactHash, backendR2Key: previousPassed.backend?.r2Key ?? null }
				: null,
		};
	},
});

export const store_version_review = internalMutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		artifactHash: v.string(),
		pluginName: v.string(),
		version: v.string(),
		status: doc(app_convex_schema, "plugins_version_reviews").fields.status,
		mechanicalFindings: v.array(v.string()),
		aiFindings: v.array(v.string()),
		model: v.string(),
		diffBaseArtifactHash: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_artifactHash", (q) => q.eq("artifactHash", args.artifactHash))
			.first();
		if (existing) {
			await ctx.db.patch("plugins_version_reviews", existing._id, { ...args, createdAt: Date.now() });
			return null;
		}
		await ctx.db.insert("plugins_version_reviews", { ...args, createdAt: Date.now() });
		return null;
	},
});

export const review_version_artifact = internalAction({
	args: {
		publisherId: v.id("plugins_publishers"),
		pluginName: v.string(),
		version: v.string(),
		artifactHash: v.string(),
		/** Backend dist source, or null when the artifact ships no backend. */
		distSource: v.union(v.string(), v.null()),
		capabilities: v.array(v.string()),
		outboundOrigins: v.array(v.string()),
		/** Publisher owner requesting the review; fresh system-billed AI reviews are rate limited per this user. */
		requestedBy: v.id("users"),
	},
	returns: v_result({
		_yay: v.object({
			status: doc(app_convex_schema, "plugins_version_reviews").fields.status,
			mechanicalFindings: v.array(v.string()),
			aiFindings: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args): Promise<PluginVersionReviewResult> => {
		const cached = (await ctx.runQuery(internal.plugins.get_version_review_by_artifact_hash, {
			artifactHash: args.artifactHash,
		})) as Doc<"plugins_version_reviews"> | null;
		if (cached) {
			return Result({
				_yay: { status: cached.status, mechanicalFindings: cached.mechanicalFindings, aiFindings: cached.aiFindings },
			});
		}

		let review: {
			status: "passed" | "rejected" | "flagged";
			mechanicalFindings: string[];
			aiFindings: string[];
			model: string;
			diffBaseArtifactHash?: string;
		};
		if (args.distSource === null) {
			// Nothing runs server-side without a backend dist; there is no code to review.
			review = { status: "passed", mechanicalFindings: [], aiFindings: [], model: "none" };
		} else {
			const mechanicalFindings = plugins_dist_review_mechanical_findings(args.distSource);
			if (mechanicalFindings.length > 0) {
				review = { status: "rejected", mechanicalFindings, aiFindings: [], model: "none" };
			} else {
				// Only fresh verdicts cost a system-billed model call; cached hashes returned above stay free.
				const rateLimit = await rate_limiter_limit_by_key(ctx, {
					name: "plugins_publish_review",
					key: args.requestedBy,
				});
				if (rateLimit) {
					return Result({
						_nay: {
							message: `Plugin AI review rate limit exceeded; try again in ${Math.ceil(rateLimit.retryAfterMs / 1000)}s`,
						},
					});
				}
				const context = (await ctx.runQuery(internal.plugins.get_version_review_context, {
					publisherId: args.publisherId,
					pluginName: args.pluginName,
				})) as {
					secretNames: string[];
					previousPassed: { artifactHash: string; backendR2Key: string | null } | null;
				};
				let diff: { baseArtifactHash: string; added: string[]; removed: string[] } | null = null;
				if (context.previousPassed?.backendR2Key) {
					const previousDist = await r2_fetch_object_from_bucket({ key: context.previousPassed.backendR2Key });
					diff = {
						baseArtifactHash: context.previousPassed.artifactHash,
						...plugin_review_line_diff(await previousDist.text(), args.distSource),
					};
				}
				let verdict: z.infer<typeof plugin_review_verdict_schema>;
				try {
					verdict = await plugins_ai_review.generate_verdict({
						prompt: plugin_review_prompt({
							distSource: args.distSource,
							capabilities: args.capabilities,
							outboundOrigins: args.outboundOrigins,
							secretNames: context.secretNames,
							diff,
						}),
					});
				} catch (error) {
					console.error("Plugin AI review failed", { artifactHash: args.artifactHash, error });
					return Result({ _nay: { message: "Plugin AI review is unavailable; the version was not registered" } });
				}
				review = {
					status: verdict.verdict,
					mechanicalFindings: [],
					aiFindings: verdict.findings,
					model: plugin_review_model_id,
					diffBaseArtifactHash: diff?.baseArtifactHash,
				};
			}
		}

		await ctx.runMutation(internal.plugins.store_version_review, {
			publisherId: args.publisherId,
			artifactHash: args.artifactHash,
			pluginName: args.pluginName,
			version: args.version,
			...review,
		});
		return Result({
			_yay: { status: review.status, mechanicalFindings: review.mechanicalFindings, aiFindings: review.aiFindings },
		});
	},
});

export const publish_version = action({
	args: {
		publisherId: v.id("plugins_publishers"),
		repositoryId: v.id("plugins_publisher_repositories"),
		commitSha: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			pluginVersionId: v.id("plugins_versions"),
			sourceMountName: v.string(),
			sourceCommitSha: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const authorized = (await ctx.runMutation(internal.plugins.authorize_publish_scope, {
			publisherId: args.publisherId,
			repositoryId: args.repositoryId,
		})) as {
			_yay?: {
				userId: Id<"users">;
				publisherSlug: string;
				owner: string;
				repo: string;
				repositoryUrl: string;
			};
			_nay?: { message: string };
		};
		if (authorized._nay || !authorized._yay) {
			return Result({ _nay: { message: authorized._nay?.message ?? "Unauthorized" } });
		}
		const source = authorized._yay;

		const repo = await fetch_github_json(
			`https://api.github.com/repos/${source.owner}/${source.repo}`,
			github_repo_schema,
		);
		if (repo._nay) {
			return Result({ _nay: { message: repo._nay.message } });
		}

		const sourceDefaultBranch = repo._yay.default_branch;
		const ref = args.commitSha?.trim() || sourceDefaultBranch;
		const commit = await fetch_github_json(
			`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
			github_commit_schema,
		);
		if (commit._nay) {
			return Result({ _nay: { message: commit._nay.message } });
		}
		const sourceCommitSha = commit._yay.sha;

		const manifestText = await fetch_github_text({
			owner: source.owner,
			repo: source.repo,
			commitSha: sourceCommitSha,
			path: "bonobo.plugin.json",
		});
		if (manifestText._nay) {
			return Result({ _nay: { message: manifestText._nay.message } });
		}
		const manifest = parse_json_text(manifestText._yay, plugins_manifest_schema, "Plugin manifest is invalid");
		if (manifest._nay) {
			return Result({ _nay: { message: manifest._nay.message } });
		}
		if (manifest._yay.publisher !== source.publisherSlug) {
			return Result({ _nay: { message: 'Plugin manifest "publisher" must match your publisher slug' } });
		}

		const artifactText = await fetch_github_text({
			owner: source.owner,
			repo: source.repo,
			commitSha: sourceCommitSha,
			path: manifest._yay.artifact,
		});
		if (artifactText._nay) {
			return Result({ _nay: { message: artifactText._nay.message } });
		}
		let artifactJson: unknown;
		try {
			artifactJson = JSON.parse(artifactText._yay);
		} catch {
			return Result({ _nay: { message: "Plugin artifact is invalid JSON" } });
		}
		const artifact = plugins_validate_artifact(artifactJson);
		if (artifact._nay) {
			return Result({ _nay: { message: artifact._nay.message } });
		}
		if (manifest._yay.name !== artifact._yay.plugin.name || manifest._yay.version !== artifact._yay.plugin.version) {
			return Result({ _nay: { message: "Plugin manifest and artifact identify different versions" } });
		}

		const artifactHash = `sha256:${await sha256_hex_bytes(text_encoder.encode(artifactText._yay))}`;
		const manifestR2Key = plugin_r2_key({
			name: artifact._yay.plugin.name,
			version: artifact._yay.plugin.version,
			commitSha: sourceCommitSha,
			path: "bonobo.plugin.json",
		});
		const artifactR2Key = plugin_r2_key({
			name: artifact._yay.plugin.name,
			version: artifact._yay.plugin.version,
			commitSha: sourceCommitSha,
			path: manifest._yay.artifact,
		});

		const files: Array<PluginArtifactFile & { r2Key: string }> = [];
		const fileUploads: Array<{ key: string; body: ArrayBuffer; contentType: string }> = [];
		for (const file of artifact._yay.files) {
			const fileBytes = await fetch_github_bytes({
				owner: source.owner,
				repo: source.repo,
				commitSha: sourceCommitSha,
				path: file.path,
			});
			if (fileBytes._nay) {
				return Result({ _nay: { message: fileBytes._nay.message } });
			}
			const fileHash = `sha256:${await sha256_hex_bytes(fileBytes._yay)}`;
			if (fileHash !== file.sha256) {
				return Result({ _nay: { message: `Artifact file hash mismatch for "${file.path}"` } });
			}
			if (fileBytes._yay.byteLength !== file.bytes) {
				return Result({ _nay: { message: `Artifact file byte size mismatch for "${file.path}"` } });
			}
			const r2Key = plugin_r2_key({
				name: artifact._yay.plugin.name,
				version: artifact._yay.plugin.version,
				commitSha: sourceCommitSha,
				path: file.path,
			});
			fileUploads.push({ key: r2Key, body: fileBytes._yay, contentType: file.contentType });
			files.push({ ...file, r2Key });
		}

		const backendEntry = artifact._yay.backend;
		let backend: (NonNullable<typeof artifact._yay.backend> & { r2Key: string }) | null = null;
		let backendDistSource: string | null = null;
		if (backendEntry) {
			const backendFile = files.find((file) => file.path === backendEntry.entry);
			const backendUpload = fileUploads.find((upload) => upload.key === backendFile?.r2Key);
			if (!backendFile || !backendUpload) {
				return Result({ _nay: { message: "Plugin backend entry is missing from artifact files" } });
			}
			backend = { ...backendEntry, r2Key: backendFile.r2Key };
			backendDistSource = text_decoder.decode(backendUpload.body);
		}

		// Review the dist before anything is uploaded or registered; "rejected" blocks the publish.
		const review = (await ctx.runAction(internal.plugins.review_version_artifact, {
			publisherId: args.publisherId,
			pluginName: artifact._yay.plugin.name,
			version: artifact._yay.plugin.version,
			artifactHash,
			distSource: backendDistSource,
			capabilities: artifact._yay.capabilities,
			outboundOrigins: artifact._yay.outboundOrigins,
			requestedBy: source.userId,
		})) as PluginVersionReviewResult;
		if (review._nay || !review._yay) {
			return Result({ _nay: { message: review._nay?.message ?? "Plugin review failed" } });
		}
		if (review._yay.status === "rejected") {
			const reasons = [...review._yay.mechanicalFindings, ...review._yay.aiFindings];
			return Result({ _nay: { message: `Plugin review rejected this version: ${reasons.join(" | ")}` } });
		}

		const tree = await fetch_github_json(
			`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${sourceCommitSha}?recursive=1`,
			github_tree_schema,
		);
		if (tree._nay) {
			return Result({ _nay: { message: tree._nay.message } });
		}
		if (tree._yay.truncated) {
			return Result({ _nay: { message: "GitHub source tree is too large for plugin import" } });
		}

		const sourceFiles: PluginSourceFile[] = [];
		let sourceBytes = 0;
		for (const entry of tree._yay.tree) {
			if (entry.type !== "blob") {
				continue;
			}
			if (entry.size !== undefined && entry.size > files_MAX_TEXT_CONTENT_BYTES) {
				continue;
			}
			const keep = source_file_keep_reason(entry.path);
			if (keep._nay) {
				continue;
			}
			if (sourceFiles.length >= plugin_import_max_source_files) {
				return Result({ _nay: { message: `Plugin source tree exceeds ${plugin_import_max_source_files} files` } });
			}
			const sourceText = await fetch_github_text({
				owner: source.owner,
				repo: source.repo,
				commitSha: sourceCommitSha,
				path: keep._yay,
			});
			if (sourceText._nay) {
				return Result({ _nay: { message: sourceText._nay.message } });
			}
			sourceBytes += files_get_utf8_byte_size(sourceText._yay);
			if (sourceBytes > plugin_import_max_source_bytes) {
				return Result({ _nay: { message: `Plugin source tree exceeds ${plugin_import_max_source_bytes} bytes` } });
			}
			sourceFiles.push({ path: keep._yay, rawText: sourceText._yay });
		}

		await r2_put_object(ctx, {
			key: manifestR2Key,
			body: manifestText._yay,
			contentType: "application/json",
		});
		await r2_put_object(ctx, {
			key: artifactR2Key,
			body: artifactText._yay,
			contentType: "application/json",
		});
		for (const fileUpload of fileUploads) {
			await r2_put_object(ctx, {
				key: fileUpload.key,
				body: fileUpload.body,
				contentType: fileUpload.contentType,
			});
		}

		const registered = (await ctx.runAction(internal.plugins.register_verified_version, {
			name: artifact._yay.plugin.name,
			displayName: artifact._yay.plugin.displayName,
			version: artifact._yay.plugin.version,
			description: manifest._yay.description,
			publisherId: args.publisherId,
			reviewStatus: review._yay.status,
			artifactHash,
			sourceRepositoryUrl: source.repositoryUrl,
			sourceOwner: source.owner,
			sourceRepo: source.repo,
			sourceDefaultBranch,
			sourceCommitSha,
			manifestR2Key,
			artifactR2Key,
			backend,
			events: artifact._yay.events,
			pages: artifact._yay.pages,
			capabilities: artifact._yay.capabilities,
			outboundOrigins: artifact._yay.outboundOrigins,
			files,
			createdBy: source.userId,
			sourceFiles,
		})) as { _yay?: { pluginVersionId: Id<"plugins_versions">; sourceMountName: string }; _nay?: { message: string } };
		if (registered._nay || !registered._yay) {
			return Result({ _nay: { message: registered._nay?.message ?? "Failed to register plugin version" } });
		}

		return Result({
			_yay: {
				pluginVersionId: registered._yay.pluginVersionId,
				sourceMountName: registered._yay.sourceMountName,
				sourceCommitSha,
			},
		});
	},
});

export const create_publisher = mutation({
	args: {
		slug: v.string(),
		displayName: v.string(),
	},
	returns: v_result({ _yay: v.object({ publisherId: v.id("plugins_publishers"), slug: v.string() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const slug = plugins_name_autofix_and_validate(args.slug);
		if (slug._nay) {
			return Result({ _nay: { message: slug._nay.message } });
		}
		const displayName = args.displayName.trim();
		if (!displayName) {
			return Result({ _nay: { message: "Publisher display name is required" } });
		}

		const ownedPublisher = await ctx.db
			.query("plugins_publishers")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", userAuth.id))
			.first();
		if (ownedPublisher) {
			return Result({ _nay: { message: "You already have a publisher" } });
		}
		const slugPublisher = await ctx.db
			.query("plugins_publishers")
			.withIndex("by_slug", (q) => q.eq("slug", slug._yay))
			.first();
		if (slugPublisher) {
			return Result({ _nay: { message: "Publisher slug is already taken" } });
		}

		const now = Date.now();
		const publisherId = await ctx.db.insert("plugins_publishers", {
			slug: slug._yay,
			displayName,
			ownerUserId: userAuth.id,
			createdAt: now,
			updatedAt: now,
		});
		return Result({ _yay: { publisherId, slug: slug._yay } });
	},
});

export const get_my_publisher = query({
	args: {},
	returns: v.union(
		v.object({
			publisher: doc(app_convex_schema, "plugins_publishers"),
			repositories: v.array(doc(app_convex_schema, "plugins_publisher_repositories")),
		}),
		v.null(),
	),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}
		const publisher = await ctx.db
			.query("plugins_publishers")
			.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", userAuth.id))
			.first();
		if (!publisher) {
			return null;
		}
		const repositories = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_publisher", (q) => q.eq("publisherId", publisher._id))
			.take(100);
		return {
			publisher,
			repositories: repositories.toSorted((a, b) => a.repositoryUrl.localeCompare(b.repositoryUrl)),
		};
	},
});

export const claim_repository = mutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		repositoryUrl: v.string(),
	},
	returns: v_result({
		_yay: v.object({ repositoryId: v.id("plugins_publisher_repositories"), repositoryUrl: v.string() }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const repository = plugins_parse_github_repository_url(args.repositoryUrl);
		if (repository._nay) {
			return Result({ _nay: { message: repository._nay.message } });
		}

		const claimed = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_repositoryUrl", (q) => q.eq("repositoryUrl", repository._yay.repositoryUrl))
			.first();
		if (claimed) {
			if (claimed.publisherId === publisher._id) {
				return Result({ _yay: { repositoryId: claimed._id, repositoryUrl: claimed.repositoryUrl } });
			}
			return Result({ _nay: { message: "Repository is already claimed by another publisher" } });
		}

		const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
			publisherId: publisher._id,
			repositoryUrl: repository._yay.repositoryUrl,
			owner: repository._yay.owner,
			repo: repository._yay.repo,
			createdAt: Date.now(),
		});
		return Result({ _yay: { repositoryId, repositoryUrl: repository._yay.repositoryUrl } });
	},
});

export const remove_repository = mutation({
	args: {
		repositoryId: v.id("plugins_publisher_repositories"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const repository = await ctx.db.get("plugins_publisher_repositories", args.repositoryId);
		if (!repository) {
			return Result({ _nay: { message: "Not found" } });
		}
		const publisher = await ctx.db.get("plugins_publishers", repository.publisherId);
		if (!publisher) {
			const errorMessage = "repository.publisherId points to a missing plugins_publishers doc";
			const errorData = { repositoryId: repository._id, publisherId: repository.publisherId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.db.delete("plugins_publisher_repositories", args.repositoryId);
		return Result({ _yay: null });
	},
});

export const list_publisher_secrets = query({
	args: {
		publisherId: v.id("plugins_publishers"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_publisher_secrets"),
			name: v.string(),
			valuePreview: v.string(),
			allowedOrigins: v.array(v.string()),
			updatedAt: v.number(),
			lastUsedAt: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher || publisher.ownerUserId !== userAuth.id) {
			return [];
		}

		const secrets = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_publisher", (q) => q.eq("publisherId", publisher._id))
			.take(100);

		return secrets
			.toSorted((a, b) => a.name.localeCompare(b.name))
			.map((secret) => ({
				_id: secret._id,
				name: secret.name,
				valuePreview: secret.valuePreview,
				allowedOrigins: secret.allowedOrigins,
				updatedAt: secret.updatedAt,
				lastUsedAt: secret.lastUsedAt ?? null,
			}));
	},
});

export const list_publisher_reviews = query({
	args: {
		publisherId: v.id("plugins_publishers"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_version_reviews"),
			pluginName: v.string(),
			version: v.string(),
			status: doc(app_convex_schema, "plugins_version_reviews").fields.status,
			mechanicalFindings: v.array(v.string()),
			aiFindings: v.array(v.string()),
			model: v.string(),
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher || publisher.ownerUserId !== userAuth.id) {
			return [];
		}

		const reviews = await ctx.db
			.query("plugins_version_reviews")
			.withIndex("by_publisher", (q) => q.eq("publisherId", publisher._id))
			.order("desc")
			.take(50);

		return reviews.map((review) => ({
			_id: review._id,
			pluginName: review.pluginName,
			version: review.version,
			status: review.status,
			mechanicalFindings: review.mechanicalFindings,
			aiFindings: review.aiFindings,
			model: review.model,
			createdAt: review.createdAt,
		}));
	},
});

export const upsert_publisher_secret = mutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		name: v.string(),
		value: v.string(),
		allowedOrigins: v.array(v.string()),
	},
	returns: v_result({ _yay: v.object({ secretId: v.id("plugins_publisher_secrets") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const secret = validate_secret_input(args);
		if (secret._nay) {
			return secret;
		}
		const allowedOrigins = validate_allowed_origins_input(args.allowedOrigins);
		if (allowedOrigins._nay) {
			return allowedOrigins;
		}

		let secretId: Id<"plugins_publisher_secrets">;
		try {
			secretId = await upsert_publisher_secret_doc(ctx, {
				publisher,
				name: secret._yay.name,
				value: secret._yay.value,
				allowedOrigins: allowedOrigins._yay,
				now: Date.now(),
			});
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { secretId } });
	},
});

export const upsert_publisher_secrets = mutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		secrets: v.array(v.object({ name: v.string(), value: v.string() })),
	},
	returns: v_result({ _yay: v.object({ count: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		if (args.secrets.length === 0 || args.secrets.length > 50) {
			return Result({ _nay: { message: "Secret batch size is invalid" } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const secrets = new Map<string, string>();
		for (const input of args.secrets) {
			const secret = validate_secret_input(input);
			if (secret._nay) {
				return secret;
			}
			secrets.set(secret._yay.name, secret._yay.value);
		}

		const now = Date.now();
		try {
			for (const [name, value] of secrets) {
				await upsert_publisher_secret_doc(ctx, {
					publisher,
					name,
					value,
					now,
				});
			}
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { count: secrets.size } });
	},
});

export const update_publisher_secret_origins = mutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		name: v.string(),
		allowedOrigins: v.array(v.string()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const name = plugins_secret_name_validate(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}
		const allowedOrigins = validate_allowed_origins_input(args.allowedOrigins);
		if (allowedOrigins._nay) {
			return allowedOrigins;
		}

		const existing = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_publisher_name", (q) => q.eq("publisherId", publisher._id).eq("name", name._yay))
			.first();
		if (!existing) {
			return Result({ _nay: { message: "Not found" } });
		}

		await ctx.db.patch("plugins_publisher_secrets", existing._id, {
			allowedOrigins: allowedOrigins._yay,
			updatedAt: Date.now(),
		});
		return Result({ _yay: null });
	},
});

export const delete_publisher_secret = mutation({
	args: {
		publisherId: v.id("plugins_publishers"),
		name: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const publisher = await ctx.db.get("plugins_publishers", args.publisherId);
		if (!publisher) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (publisher.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const name = plugins_secret_name_validate(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}

		const existing = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_publisher_name", (q) => q.eq("publisherId", publisher._id).eq("name", name._yay))
			.first();
		if (existing) {
			await ctx.db.delete("plugins_publisher_secrets", existing._id);
		}
		return Result({ _yay: null });
	},
});

export const install_version = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginVersionId: v.id("plugins_versions"),
		acceptedCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		acceptedOutboundOrigins: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.object({ installationId: v.id("plugins_workspace_installations"), lockfileNodeId: v.id("files_nodes") }),
	}),
	handler: async (ctx, args) => {
		const installed = (await ctx.runMutation(internal.plugins.install_version_in_db, args)) as {
			_yay?: {
				installationId: Id<"plugins_workspace_installations">;
				organizationId: Id<"organizations">;
				workspaceId: Id<"organizations_workspaces">;
				userId: Id<"users">;
			};
			_nay?: { message: string };
		};
		if (installed._nay) {
			return Result({ _nay: { message: installed._nay.message } });
		}
		if (!installed._yay) {
			return Result({ _nay: { message: "Failed to install plugin" } });
		}

		const refreshed = (await ctx.runAction(internal.plugins.refresh_workspace_lockfile_internal, {
			organizationId: installed._yay.organizationId,
			workspaceId: installed._yay.workspaceId,
			userId: installed._yay.userId,
		})) as { _yay?: { nodeId: Id<"files_nodes"> }; _nay?: { message: string } };
		if (refreshed._nay) {
			return Result({ _nay: { message: refreshed._nay.message } });
		}
		if (!refreshed._yay) {
			return Result({ _nay: { message: "Failed to refresh plugin lockfile" } });
		}

		return Result({ _yay: { installationId: installed._yay.installationId, lockfileNodeId: refreshed._yay.nodeId } });
	},
});

export const install_version_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginVersionId: v.id("plugins_versions"),
		acceptedCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		acceptedOutboundOrigins: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			installationId: v.id("plugins_workspace_installations"),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			userId: v.id("users"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return authorization;
		}
		const installationScope = {
			userId: userAuth.id,
			organizationId: authorization._yay.membership.organizationId,
			workspaceId: authorization._yay.membership.workspaceId,
		};

		const pluginVersion = await ctx.db.get("plugins_versions", args.pluginVersionId);
		if (!pluginVersion) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pluginVersion.reviewStatus === "rejected" || pluginVersion.reviewStatus === "flagged") {
			return Result({ _nay: { message: "Plugin version failed review and cannot be installed" } });
		}

		// Consent must exactly cover what the version declares; anything else is a stale or partial consent screen.
		const acceptedCapabilities = new Set(args.acceptedCapabilities);
		if (
			pluginVersion.capabilities.length !== acceptedCapabilities.size ||
			pluginVersion.capabilities.some((capability) => !acceptedCapabilities.has(capability))
		) {
			return Result({ _nay: { message: "Install must accept exactly the capabilities the plugin declares" } });
		}
		const acceptedOutboundOrigins = new Set(args.acceptedOutboundOrigins);
		if (
			pluginVersion.outboundOrigins.length !== acceptedOutboundOrigins.size ||
			pluginVersion.outboundOrigins.some((origin) => !acceptedOutboundOrigins.has(origin))
		) {
			return Result({ _nay: { message: "Install must accept exactly the outbound origins the plugin declares" } });
		}

		const now = Date.now();
		const existingInstallation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", installationScope.organizationId)
					.eq("workspaceId", installationScope.workspaceId)
					.eq("pluginName", pluginVersion.name),
			)
			.first();

		let installationId: Id<"plugins_workspace_installations">;
		let installationCreatedAt = now;
		if (existingInstallation) {
			const existingVersion = await ctx.db.get("plugins_versions", existingInstallation.pluginVersionId);
			if (!existingVersion || existingVersion.sourceRepositoryUrl !== pluginVersion.sourceRepositoryUrl) {
				return Result({ _nay: { message: "Plugin name already installed from a different source" } });
			}
			installationId = existingInstallation._id;
			installationCreatedAt = existingInstallation.createdAt;
			await ctx.db.patch("plugins_workspace_installations", existingInstallation._id, {
				pluginVersionId: pluginVersion._id,
				status: "enabled",
				acceptedCapabilities: pluginVersion.capabilities,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: pluginVersion.outboundOrigins,
				outboundOriginsAcceptedAt: now,
				updatedBy: installationScope.userId,
				updatedAt: now,
			});
		} else {
			installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: installationScope.organizationId,
				workspaceId: installationScope.workspaceId,
				pluginVersionId: pluginVersion._id,
				pluginName: pluginVersion.name,
				status: "enabled",
				acceptedCapabilities: pluginVersion.capabilities,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: pluginVersion.outboundOrigins,
				outboundOriginsAcceptedAt: now,
				installedBy: installationScope.userId,
				updatedBy: installationScope.userId,
				createdAt: now,
				updatedAt: now,
			});
		}

		const existingHandlers = await ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.collect();
		await Promise.all(
			existingHandlers.map((handler) => ctx.db.delete("plugins_workspace_event_handlers", handler._id)),
		);

		for (const event of pluginVersion.events) {
			for (const contentType of event.contentTypes) {
				await ctx.db.insert("plugins_workspace_event_handlers", {
					organizationId: installationScope.organizationId,
					workspaceId: installationScope.workspaceId,
					installationId,
					pluginVersionId: pluginVersion._id,
					pluginName: pluginVersion.name,
					event: event.type,
					contentType,
					status: "enabled",
					installationCreatedAt,
					createdAt: now,
					updatedAt: now,
				});
			}
		}

		return Result({
			_yay: {
				installationId,
				organizationId: installationScope.organizationId,
				workspaceId: installationScope.workspaceId,
				userId: installationScope.userId,
			},
		});
	},
});

export const list_installations_for_lockfile = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.array(
		v.object({
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			sourceMount: v.union(doc(app_convex_schema, "plugins_source_mounts"), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_updatedAt", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("status", "enabled"),
			)
			.collect();

		const docs = [];
		for (const installation of installations) {
			const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
			if (!version) {
				continue;
			}
			const sourceMount = await ctx.db
				.query("plugins_source_mounts")
				.withIndex("by_pluginVersion", (q) => q.eq("pluginVersionId", version._id))
				.first();
			docs.push({ installation, version, sourceMount });
		}

		return docs;
	},
});

export const refresh_workspace_lockfile_internal = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args): Promise<PluginLockfileRefreshResult> => {
		const installations = await ctx.runQuery(internal.plugins.list_installations_for_lockfile, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		});
		const rawText = lockfile_json({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			updatedAt: Date.now(),
			installations,
		});
		return (await ctx.runAction(internal.files_nodes.upsert_readonly_text_file_by_path, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: plugins_LOCKFILE_PATH,
			rawText,
		})) as PluginLockfileRefreshResult;
	},
});

export const list_installations = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			installation: doc(app_convex_schema, "plugins_workspace_installations"),
			version: doc(app_convex_schema, "plugins_versions"),
			handlers: v.array(doc(app_convex_schema, "plugins_workspace_event_handlers")),
			sourceMount: v.union(doc(app_convex_schema, "plugins_source_mounts"), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return [];
		}
		const membership = authorization._yay.membership;

		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_updatedAt", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.collect();
		const docs = [];
		for (const installation of installations) {
			const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
			if (!version) {
				continue;
			}
			const [handlers, sourceMount] = await Promise.all([
				ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
					.collect(),
				ctx.db
					.query("plugins_source_mounts")
					.withIndex("by_pluginVersion", (q) => q.eq("pluginVersionId", version._id))
					.first(),
			]);
			docs.push({ installation, version, handlers, sourceMount });
		}

		return docs.toSorted((a, b) => a.installation.pluginName.localeCompare(b.installation.pluginName));
	},
});

export const list_registered_plugins = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginVersionId: v.id("plugins_versions"),
			name: v.string(),
			displayName: v.string(),
			description: v.string(),
			version: v.string(),
			publisherSlug: v.union(v.string(), v.null()),
			reviewStatus: doc(app_convex_schema, "plugins_versions").fields.reviewStatus,
			capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
			outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
			createdAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return [];
		}

		const versions = await ctx.db.query("plugins_versions").withIndex("by_name").take(200);
		const latestByName = new Map<string, Doc<"plugins_versions">>();
		for (const version of versions) {
			const current = latestByName.get(version.name);
			if (!current || version.createdAt > current.createdAt) {
				latestByName.set(version.name, version);
			}
		}

		const docs = [];
		for (const version of latestByName.values()) {
			const publisher = await ctx.db.get("plugins_publishers", version.publisherId);
			docs.push({
				pluginVersionId: version._id,
				name: version.name,
				displayName: version.displayName,
				description: version.description,
				version: version.version,
				publisherSlug: publisher?.slug ?? null,
				reviewStatus: version.reviewStatus,
				capabilities: version.capabilities,
				outboundOrigins: version.outboundOrigins,
				createdAt: version.createdAt,
			});
		}

		return docs.toSorted((a, b) => a.name.localeCompare(b.name));
	},
});

export const list_installation_secrets = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_workspace_installation_secrets"),
			installationId: v.id("plugins_workspace_installations"),
			name: v.string(),
			valuePreview: v.string(),
			updatedAt: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return [];
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return [];
		}

		const secrets = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", authorization._yay.membership.organizationId)
					.eq("workspaceId", authorization._yay.membership.workspaceId)
					.eq("installationId", installation._id),
			)
			.take(100);

		return secrets
			.toSorted((a, b) => a.name.localeCompare(b.name))
			.map((secret) => ({
				_id: secret._id,
				installationId: secret.installationId,
				name: secret.name,
				valuePreview: secret.valuePreview,
				updatedAt: secret.updatedAt,
			}));
	},
});

export const upsert_installation_secret = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
		value: v.string(),
	},
	returns: v_result({ _yay: v.object({ secretId: v.id("plugins_workspace_installation_secrets") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return authorization;
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!installation.acceptedCapabilities.includes("plugin.secrets.read")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const secret = validate_secret_input(args);
		if (secret._nay) {
			return secret;
		}

		let secretId: Id<"plugins_workspace_installation_secrets">;
		try {
			secretId = await upsert_installation_secret_doc(ctx, {
				installation,
				name: secret._yay.name,
				value: secret._yay.value,
				userId: userAuth.id,
				now: Date.now(),
			});
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { secretId } });
	},
});

export const upsert_installation_secrets = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		secrets: v.array(v.object({ name: v.string(), value: v.string() })),
	},
	returns: v_result({ _yay: v.object({ count: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		if (args.secrets.length === 0 || args.secrets.length > 50) {
			return Result({ _nay: { message: "Secret batch size is invalid" } });
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return authorization;
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!installation.acceptedCapabilities.includes("plugin.secrets.read")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const secrets = new Map<string, string>();
		for (const input of args.secrets) {
			const secret = validate_secret_input(input);
			if (secret._nay) {
				return secret;
			}
			secrets.set(secret._yay.name, secret._yay.value);
		}

		const now = Date.now();
		try {
			for (const [name, value] of secrets) {
				await upsert_installation_secret_doc(ctx, {
					installation,
					name,
					value,
					userId: userAuth.id,
					now,
				});
			}
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}

		return Result({ _yay: { count: secrets.size } });
	},
});

export const delete_installation_secret = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return authorization;
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		const name = plugins_secret_name_validate(args.name);
		if (name._nay) {
			return Result({ _nay: { message: name._nay.message } });
		}

		const existing = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_installation_name", (q) => q.eq("installationId", installation._id).eq("name", name._yay))
			.first();
		if (existing) {
			await ctx.db.delete("plugins_workspace_installation_secrets", existing._id);
		}
		return Result({ _yay: null });
	},
});

export const get_secret_for_runtime = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		name: v.string(),
	},
	returns: v.union(
		v.object({
			tier: v.literal("installation"),
			secret: doc(app_convex_schema, "plugins_workspace_installation_secrets"),
		}),
		v.object({
			tier: v.literal("publisher"),
			secret: doc(app_convex_schema, "plugins_publisher_secrets"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const installationSecret = await ctx.db
			.query("plugins_workspace_installation_secrets")
			.withIndex("by_installation_name", (q) => q.eq("installationId", args.installationId).eq("name", args.name))
			.first();
		if (installationSecret) {
			if (
				installationSecret.organizationId !== args.organizationId ||
				installationSecret.workspaceId !== args.workspaceId
			) {
				return null;
			}
			return { tier: "installation" as const, secret: installationSecret };
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== args.organizationId ||
			installation.workspaceId !== args.workspaceId
		) {
			return null;
		}
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version) {
			return null;
		}
		const publisherSecret = await ctx.db
			.query("plugins_publisher_secrets")
			.withIndex("by_publisher_name", (q) => q.eq("publisherId", version.publisherId).eq("name", args.name))
			.first();
		if (!publisherSecret) {
			return null;
		}
		await ctx.db.patch("plugins_publisher_secrets", publisherSecret._id, { lastUsedAt: Date.now() });
		return { tier: "publisher" as const, secret: publisherSecret };
	},
});

export const decrypt_secret_for_runtime = internalAction({
	args: {
		resolved: v.union(
			v.object({
				tier: v.literal("installation"),
				secret: doc(app_convex_schema, "plugins_workspace_installation_secrets"),
			}),
			v.object({
				tier: v.literal("publisher"),
				secret: doc(app_convex_schema, "plugins_publisher_secrets"),
			}),
		),
	},
	returns: v_result({ _yay: v.union(v.string(), v.null()) }),
	handler: async (_ctx, args) => {
		try {
			const additionalData =
				args.resolved.tier === "installation"
					? `${args.resolved.secret.installationId}:${args.resolved.secret.name}`
					: `${args.resolved.secret.publisherId}:${args.resolved.secret.name}`;
			return Result({ _yay: await decrypt_secret_value(args.resolved.secret, additionalData) });
		} catch (error) {
			return Result({ _nay: { message: error instanceof Error ? error.message : String(error) } });
		}
	},
});

export const list_run_calls = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		runId: v.id("plugins_event_runs"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_event_run_calls"),
			runId: v.id("plugins_event_runs"),
			sequence: v.number(),
			operation: doc(app_convex_schema, "plugins_event_run_calls").fields.operation,
			status: doc(app_convex_schema, "plugins_event_run_calls").fields.status,
			errorMessage: v.union(v.string(), v.null()),
			outputPath: v.optional(v.string()),
			outputOverwrite: v.optional(v.union(v.literal("replace"), v.literal("fail"))),
			markdownBytes: v.optional(v.number()),
			expiresInSeconds: v.optional(v.number()),
			secretName: v.optional(v.string()),
			secretFound: v.optional(v.boolean()),
			secretTier: v.optional(v.union(v.literal("installation"), v.literal("publisher"))),
			modelId: v.optional(v.string()),
			systemBytes: v.optional(v.number()),
			promptBytes: v.optional(v.number()),
			outputTextBytes: v.optional(v.number()),
			includeSourceImage: v.optional(v.boolean()),
			maxOutputTokens: v.optional(v.number()),
			requestBytes: v.optional(v.number()),
			responseBytes: v.optional(v.number()),
			responseStatus: v.optional(v.number()),
			createdAt: v.number(),
			startedAt: v.optional(v.number()),
			finishedAt: v.optional(v.number()),
			elapsedMs: v.optional(v.number()),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return [];
		}
		const [installation, run] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", args.installationId),
			ctx.db.get("plugins_event_runs", args.runId),
		]);
		if (
			!installation ||
			!run ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId ||
			run.organizationId !== installation.organizationId ||
			run.workspaceId !== installation.workspaceId ||
			run.installationId !== installation._id
		) {
			return [];
		}

		const calls = await ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
			.collect();
		return calls.map((call) => ({
			_id: call._id,
			runId: call.runId,
			sequence: call.sequence,
			operation: call.operation,
			status: call.status,
			errorMessage: call.errorMessage,
			...(call.outputPath === undefined ? {} : { outputPath: call.outputPath }),
			...(call.outputOverwrite === undefined ? {} : { outputOverwrite: call.outputOverwrite }),
			...(call.markdownBytes === undefined ? {} : { markdownBytes: call.markdownBytes }),
			...(call.expiresInSeconds === undefined ? {} : { expiresInSeconds: call.expiresInSeconds }),
			...(call.secretName === undefined ? {} : { secretName: call.secretName }),
			...(call.secretFound === undefined ? {} : { secretFound: call.secretFound }),
			...(call.secretTier === undefined ? {} : { secretTier: call.secretTier }),
			...(call.modelId === undefined ? {} : { modelId: call.modelId }),
			...(call.systemBytes === undefined ? {} : { systemBytes: call.systemBytes }),
			...(call.promptBytes === undefined ? {} : { promptBytes: call.promptBytes }),
			...(call.outputTextBytes === undefined ? {} : { outputTextBytes: call.outputTextBytes }),
			...(call.includeSourceImage === undefined ? {} : { includeSourceImage: call.includeSourceImage }),
			...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
			...(call.requestBytes === undefined ? {} : { requestBytes: call.requestBytes }),
			...(call.responseBytes === undefined ? {} : { responseBytes: call.responseBytes }),
			...(call.responseStatus === undefined ? {} : { responseStatus: call.responseStatus }),
			createdAt: call.createdAt,
			...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
			...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }),
			...(call.elapsedMs === undefined ? {} : { elapsedMs: call.elapsedMs }),
		}));
	},
});

export const list_recent_runs = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.array(
		v.object({
			_id: v.id("plugins_event_runs"),
			event: v.literal("files.upload.completed"),
			eventId: v.string(),
			status: doc(app_convex_schema, "plugins_event_runs").fields.status,
			hostCallCount: v.number(),
			hostWriteCount: v.number(),
			errorMessage: v.union(v.string(), v.null()),
			runnerHttpStatus: v.optional(v.number()),
			runnerElapsedMs: v.optional(v.number()),
			pluginStatus: v.optional(v.number()),
			runnerOutputBytes: v.optional(v.number()),
			runnerOutputTruncated: v.optional(v.boolean()),
			createdAt: v.number(),
			updatedAt: v.number(),
			startedAt: v.optional(v.number()),
			finishedAt: v.optional(v.number()),
			source: v.union(
				v.object({
					name: v.string(),
					path: v.string(),
					contentType: v.union(v.string(), v.null()),
					size: v.number(),
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const authorization = await authorize_manage(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (authorization._nay) {
			return [];
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.organizationId !== authorization._yay.membership.organizationId ||
			installation.workspaceId !== authorization._yay.membership.workspaceId
		) {
			return [];
		}

		const runs = await ctx.db
			.query("plugins_event_runs")
			.withIndex("by_installation_updatedAt", (q) => q.eq("installationId", installation._id))
			.order("desc")
			.take(10);

		const docs = [];
		for (const run of runs) {
			const [sourceFileNode, sourceAsset] = await Promise.all([
				ctx.db.get("files_nodes", run.sourceFileNodeId),
				ctx.db.get("files_r2_assets", run.sourceAssetId),
			]);
			docs.push({
				_id: run._id,
				event: run.event,
				eventId: run.eventId,
				status: run.status,
				hostCallCount: run.hostCallCount,
				hostWriteCount: run.hostWriteCount,
				errorMessage: run.errorMessage,
				...(run.runnerHttpStatus === undefined ? {} : { runnerHttpStatus: run.runnerHttpStatus }),
				...(run.runnerElapsedMs === undefined ? {} : { runnerElapsedMs: run.runnerElapsedMs }),
				...(run.pluginStatus === undefined ? {} : { pluginStatus: run.pluginStatus }),
				...(run.runnerOutputBytes === undefined ? {} : { runnerOutputBytes: run.runnerOutputBytes }),
				...(run.runnerOutputTruncated === undefined ? {} : { runnerOutputTruncated: run.runnerOutputTruncated }),
				createdAt: run.createdAt,
				updatedAt: run.updatedAt,
				...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
				...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
				source:
					sourceFileNode && sourceAsset
						? {
								name: sourceFileNode.name,
								path: sourceFileNode.path,
								contentType: sourceFileNode.contentType ?? null,
								size: sourceAsset.size,
							}
						: null,
			});
		}

		return docs;
	},
});
