import { z } from "zod";

import { Result } from "./errors-as-values-utils.ts";
import { files_SYSTEM_ROOT } from "./files.ts";
import { organizations_name_autofix_and_validate } from "./organizations.ts";

export const plugins_MANIFEST_SCHEMA_VERSION = 1;
export const plugins_RUNTIME_VERSION = "1";
export const plugins_LOCKFILE_PATH = `${files_SYSTEM_ROOT}/plugins.lock.json`;
export const plugins_SECRET_VALUE_MAX_BYTES = 16_000;

export const plugins_EVENT_TYPES = ["files.upload.completed"] as const;

export const plugins_CAPABILITIES = [
	"uploads.source.read",
	"files.source.temporaryUrl",
	"files.markdown.write",
	"plugin.secrets.read",
	"outbound.fetch",
	"ai.generateText",
	"media.video.frame",
	"media.video.audioSegment",
	"pdf.toMarkdown",
	"gallery.media.read",
	"gallery.documents.read",
] as const;
export type plugins_Capability = (typeof plugins_CAPABILITIES)[number];

const plugins_sha256_regex = /^sha256:[a-f0-9]{64}$/u;
const plugins_semver_regex = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const plugins_module_path_regex = /^[A-Za-z0-9._/-]+$/u;
const plugins_secret_name_regex = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const plugins_github_owner_regex = /^[A-Za-z0-9-]{1,39}$/u;
const plugins_github_repo_regex = /^[A-Za-z0-9._-]{1,100}$/u;
const plugins_module_path_schema = z
	.string()
	.regex(plugins_module_path_regex)
	.refine(
		(path) => plugins_normalize_relative_path(path)._yay !== undefined,
		"Path must be a normalized relative path",
	);

export function plugins_name_autofix_and_validate(raw: string) {
	return organizations_name_autofix_and_validate(raw);
}

/**
 * Compare two `plugins_semver_regex` versions; positive when `a` is newer. Major/minor/patch
 * compare numerically (so 0.1.10 > 0.1.9); on a tie a bare version outranks one with a
 * `-`/`+` suffix, and two suffixes compare as plain strings. Call sites may tie-break by
 * `createdAt` when the compare returns 0.
 */
export function plugins_compare_semver(a: string, b: string) {
	const parse = (version: string) => {
		// Major/minor/patch are digits and dots only, so the first `-`/`+` starts the suffix.
		const suffixIndex = version.search(/[-+]/u);
		const core = suffixIndex === -1 ? version : version.slice(0, suffixIndex);
		const suffix = suffixIndex === -1 ? null : version.slice(suffixIndex);
		const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
		return { major, minor, patch, suffix };
	};
	const left = parse(a);
	const right = parse(b);
	if (left.major !== right.major) {
		return left.major - right.major;
	}
	if (left.minor !== right.minor) {
		return left.minor - right.minor;
	}
	if (left.patch !== right.patch) {
		return left.patch - right.patch;
	}
	if (left.suffix === null || right.suffix === null) {
		return (left.suffix === null ? 1 : 0) - (right.suffix === null ? 1 : 0);
	}
	return left.suffix < right.suffix ? -1 : left.suffix > right.suffix ? 1 : 0;
}

export function plugins_source_mount_name(args: { name: string; version: string; artifactHash: string }) {
	const hash = args.artifactHash.startsWith("sha256:")
		? args.artifactHash.slice("sha256:".length, "sha256:".length + 12)
		: "unknown";
	const versionSlug = args.version.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "");
	return `plugin-${args.name}-${versionSlug}-${hash}`.slice(0, 63);
}

export function plugins_normalize_relative_path(raw: string) {
	if (raw.includes("\\")) {
		return Result({ _nay: { message: "Path must use / separators" } });
	}

	const path = raw.replace(/^\/+/u, "");
	const segments = path.split("/");
	if (!path || segments.some((segment) => !segment || segment === "." || segment === "..")) {
		return Result({ _nay: { message: "Path must be a normalized relative path" } });
	}

	return Result({ _yay: path });
}

export function plugins_secret_name_validate(raw: string) {
	const name = raw.trim();
	if (!plugins_secret_name_regex.test(name)) {
		return Result({ _nay: { message: "Secret names must use env key syntax" } });
	}
	return Result({ _yay: name });
}

export function plugins_origin_validate(raw: string) {
	const trimmed = raw.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return Result({ _nay: { message: "Origin must be a valid URL" } });
	}
	if (url.protocol !== "https:") {
		return Result({ _nay: { message: "Origin must use https" } });
	}
	if (url.username || url.password) {
		return Result({ _nay: { message: "Origin must not include credentials" } });
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		return Result({ _nay: { message: "Origin must be a bare https origin without path, query, or hash" } });
	}
	const lowered = trimmed.toLowerCase();
	if (lowered !== url.origin && lowered !== `${url.origin}/`) {
		return Result({ _nay: { message: "Origin must be a bare https origin without path, query, or hash" } });
	}
	return Result({ _yay: url.origin });
}

export function plugins_consent_diff(args: {
	current: { capabilities: plugins_Capability[]; outboundOrigins: string[] } | null;
	target: { capabilities: plugins_Capability[]; outboundOrigins: string[] };
}) {
	const currentCapabilities = new Set(args.current?.capabilities ?? []);
	const currentOrigins = new Set(args.current?.outboundOrigins ?? []);
	return {
		newCapabilities: args.target.capabilities.filter((capability) => !currentCapabilities.has(capability)),
		newOutboundOrigins: args.target.outboundOrigins.filter((origin) => !currentOrigins.has(origin)),
	};
}

export function plugins_parse_env_text(raw: string) {
	const secrets = new Map<string, string>();
	const lines = raw.replace(/^\uFEFF/u, "").split(/\r?\n/u);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
		const equalsIndex = withoutExport.indexOf("=");
		if (equalsIndex <= 0) {
			return Result({ _nay: { message: `Line ${index + 1} must be KEY=value` } });
		}

		const name = plugins_secret_name_validate(withoutExport.slice(0, equalsIndex));
		if (name._nay) {
			return Result({ _nay: { message: `Line ${index + 1}: ${name._nay.message}` } });
		}

		let value = withoutExport.slice(equalsIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			const quote = value[0];
			value = value.slice(1, -1);
			if (quote === '"') {
				value = value
					.replace(/\\n/gu, "\n")
					.replace(/\\r/gu, "\r")
					.replace(/\\t/gu, "\t")
					.replace(/\\"/gu, '"')
					.replace(/\\\\/gu, "\\");
			}
		}

		secrets.set(name._yay, value);
	}

	return Result({
		_yay: Array.from(secrets, ([name, value]) => ({ name, value })),
	});
}

export function plugins_parse_github_repository_url(raw: string) {
	const value = raw.trim();
	let owner: string;
	let repo: string;

	const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/u.exec(value);
	if (sshMatch) {
		owner = sshMatch[1]!;
		repo = sshMatch[2]!;
	} else {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return Result({ _nay: { message: "Repository URL must be a GitHub URL" } });
		}
		if (url.hostname !== "github.com") {
			return Result({ _nay: { message: "Repository URL must be on github.com" } });
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 2) {
			return Result({ _nay: { message: "Repository URL must include owner and repo" } });
		}
		owner = parts[0]!;
		repo = parts[1]!;
	}

	repo = repo.replace(/\.git$/u, "");
	if (
		!plugins_github_owner_regex.test(owner) ||
		!plugins_github_repo_regex.test(repo) ||
		repo === "." ||
		repo === ".."
	) {
		return Result({ _nay: { message: "Repository URL has an invalid owner or repo" } });
	}

	return Result({
		_yay: {
			owner,
			repo,
			repositoryUrl: `https://github.com/${owner}/${repo}`,
		},
	});
}

// Thresholds calibrated against the first-party plugin readable dists (max line 278,
// avg line 33, single-char identifier share 0.072) vs the same worker minified
// with esbuild (max line 3228, avg 316, share 0.482).
const plugins_dist_max_line_length = 1000;
const plugins_dist_max_avg_line_length = 200;
const plugins_dist_max_single_char_identifier_share = 0.3;
const plugins_dist_max_hex_unicode_escape_density = 0.01;
const plugins_dist_base64_literal_min_length = 256;
// Words that match the identifier regex but are language syntax, not names the
// author chose; excluding them keeps the single-char share meaningful.
const plugins_dist_js_keywords = new Set([
	"const",
	"let",
	"var",
	"function",
	"return",
	"await",
	"async",
	"if",
	"else",
	"for",
	"while",
	"new",
	"throw",
	"try",
	"catch",
	"finally",
	"class",
	"export",
	"import",
	"default",
	"typeof",
	"instanceof",
	"in",
	"of",
	"null",
	"true",
	"false",
	"undefined",
	"this",
	"switch",
	"case",
	"break",
	"continue",
	"do",
	"delete",
	"void",
	"yield",
	"static",
	"get",
	"set",
	"extends",
	"super",
	"from",
]);

export function plugins_dist_review_mechanical_findings(source: string) {
	const findings: string[] = [];

	const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
	const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
	if (longestLine > plugins_dist_max_line_length) {
		findings.push(
			`Longest line is ${longestLine} characters (limit ${plugins_dist_max_line_length}); the dist must be plain readable JavaScript, not minified`,
		);
	}
	const avgLineLength = lines.length > 0 ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
	if (avgLineLength > plugins_dist_max_avg_line_length) {
		findings.push(
			`Average line length is ${Math.round(avgLineLength)} characters (limit ${plugins_dist_max_avg_line_length}); the dist must be plain readable JavaScript, not minified`,
		);
	}

	const identifiers = (source.match(/[$A-Za-z_][$\w]*/gu) ?? []).filter((word) => !plugins_dist_js_keywords.has(word));
	const singleCharShare =
		identifiers.length > 0 ? identifiers.filter((word) => word.length === 1).length / identifiers.length : 0;
	if (singleCharShare > plugins_dist_max_single_char_identifier_share) {
		findings.push(
			`${Math.round(singleCharShare * 100)}% of identifiers are a single character (limit ${plugins_dist_max_single_char_identifier_share * 100}%); the dist must keep readable identifier names`,
		);
	}

	const escapeCount = (source.match(/\\[xu]/gu) ?? []).length;
	if (source.length > 0 && escapeCount / source.length > plugins_dist_max_hex_unicode_escape_density) {
		findings.push(
			`Dist is dense with \\x/\\u escape sequences (${escapeCount} escapes); encoded strings look obfuscated`,
		);
	}

	if (new RegExp(`["'\`][A-Za-z0-9+/]{${plugins_dist_base64_literal_min_length},}={0,2}["'\`]`, "u").test(source)) {
		findings.push(
			`Dist contains a base64-looking string literal of ${plugins_dist_base64_literal_min_length}+ characters; ship code and assets as plain files instead`,
		);
	}

	if (/\bFunction\s*\(/u.test(source)) {
		findings.push("Dist uses the Function constructor; dynamically-assembled code is not allowed");
	}

	return findings;
}

export const plugins_event_schema = z
	.object({
		type: z.enum(plugins_EVENT_TYPES),
		contentTypes: z.array(z.string().min(1)).min(1),
	})
	.strict();

export const plugins_page_schema = z
	.object({
		name: z.string().min(1),
		displayName: z.string().min(1),
		html: plugins_module_path_schema,
		assets: z.array(plugins_module_path_schema),
	})
	.strict();

export const plugins_artifact_file_schema = z
	.object({
		path: plugins_module_path_schema,
		sha256: z.string().regex(plugins_sha256_regex),
		bytes: z.number().int().nonnegative(),
		contentType: z.string().min(1),
		r2Key: z.string().optional(),
	})
	.strict();

export const plugins_artifact_schema = z
	.object({
		schemaVersion: z.literal(plugins_MANIFEST_SCHEMA_VERSION),
		plugin: z
			.object({
				name: z.string(),
				displayName: z.string().min(1),
				version: z.string().regex(plugins_semver_regex),
			})
			.strict(),
		compatibility: z
			.object({
				bonoboPluginRuntime: z.literal(plugins_RUNTIME_VERSION),
			})
			.strict(),
		backend: z
			.object({
				entry: plugins_module_path_schema,
				moduleName: plugins_module_path_schema,
				compatibilityDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u),
				compatibilityFlags: z.array(z.string().min(1)),
			})
			.strict()
			.optional(),
		events: z.array(plugins_event_schema),
		pages: z.array(plugins_page_schema),
		capabilities: z.array(z.enum(plugins_CAPABILITIES)),
		outboundOrigins: z.array(z.string()),
		files: z.array(plugins_artifact_file_schema),
		provenance: z.null(),
	})
	.strict();

export const plugins_manifest_schema = z
	.object({
		schemaVersion: z.literal(plugins_MANIFEST_SCHEMA_VERSION),
		name: z.string(),
		displayName: z.string().min(1),
		version: z.string().regex(plugins_semver_regex),
		description: z.string(),
		artifact: plugins_module_path_schema,
	})
	.strict();

export function plugins_validate_artifact(input: unknown) {
	const parsed = plugins_artifact_schema.safeParse(input);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? "Invalid plugin artifact" } });
	}
	const name = plugins_name_autofix_and_validate(parsed.data.plugin.name);
	if (name._nay) {
		return Result({ _nay: { message: name._nay.message } });
	}
	if (name._yay !== parsed.data.plugin.name) {
		return Result({ _nay: { message: "Plugin name must already be normalized" } });
	}
	const outboundOrigins = new Set<string>();
	for (const origin of parsed.data.outboundOrigins) {
		const validated = plugins_origin_validate(origin);
		if (validated._nay) {
			return Result({ _nay: { message: validated._nay.message } });
		}
		if (validated._yay !== origin) {
			return Result({ _nay: { message: "Outbound origins must already be normalized" } });
		}
		if (outboundOrigins.has(origin)) {
			return Result({ _nay: { message: `Plugin artifact has duplicate outbound origin "${origin}"` } });
		}
		outboundOrigins.add(origin);
	}
	const filePaths = new Set<string>();
	for (const file of parsed.data.files) {
		if (filePaths.has(file.path)) {
			return Result({ _nay: { message: `Plugin artifact has duplicate file path "${file.path}"` } });
		}
		filePaths.add(file.path);
	}
	return Result({ _yay: parsed.data });
}
