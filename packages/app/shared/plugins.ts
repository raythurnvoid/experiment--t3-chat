import { z } from "zod";

import { Result } from "./errors-as-values-utils.ts";
import { organizations_name_autofix_and_validate } from "./organizations.ts";

export const plugins_RUNTIME_VERSION = "1";

const MANIFEST_SCHEMA_VERSION = 1;
const EVENT_TYPES = ["files.upload.completed"] as const;

const CAPABILITIES = ["plugin.secrets.read", "outbound.fetch"] as const;
export type plugins_Capability = (typeof CAPABILITIES)[number];

const sha256_regex = /^sha256:[a-f0-9]{64}$/u;
const semver_regex = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const module_path_regex = /^[A-Za-z0-9._/-]+$/u;
const secret_name_regex = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const github_owner_regex = /^[A-Za-z0-9-]{1,39}$/u;
const github_repo_regex = /^[A-Za-z0-9._-]{1,100}$/u;
// Manifest paths are stored and joined verbatim, so require an already-normalized
// relative path: no leading/trailing/duplicate slashes and no "." / ".." segments.
const module_path_schema = z
	.string()
	.regex(module_path_regex)
	.refine(
		(path) => path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
		"Path must be a normalized relative path",
	);

// Plugin names share the organization/workspace slug rules.
function autofix_and_validate_name(raw: string) {
	return organizations_name_autofix_and_validate(raw);
}

export function plugins_validate_secret_name(raw: string) {
	const name = raw.trim();

	if (!secret_name_regex.test(name)) {
		return Result({ _nay: { message: "Secret names must use env key syntax" } });
	}

	return Result({ _yay: name });
}

export function plugins_validate_origin(raw: string) {
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

		const name = plugins_validate_secret_name(withoutExport.slice(0, equalsIndex));
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
	if (!github_owner_regex.test(owner) || !github_repo_regex.test(repo) || repo === "." || repo === "..") {
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
const dist_max_line_length = 1000;
const dist_max_avg_line_length = 200;
const dist_max_single_char_identifier_share = 0.3;
const dist_max_hex_unicode_escape_density = 0.01;
const dist_base64_literal_min_length = 256;
// Words that match the identifier regex but are language syntax, not names the
// author chose; excluding them keeps the single-char share meaningful.
const dist_js_keywords = new Set([
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
	if (longestLine > dist_max_line_length) {
		findings.push(
			`Longest line is ${longestLine} characters (limit ${dist_max_line_length}); the dist must be plain readable JavaScript, not minified`,
		);
	}
	const avgLineLength = lines.length > 0 ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
	if (avgLineLength > dist_max_avg_line_length) {
		findings.push(
			`Average line length is ${Math.round(avgLineLength)} characters (limit ${dist_max_avg_line_length}); the dist must be plain readable JavaScript, not minified`,
		);
	}

	const identifiers = (source.match(/[$A-Za-z_][$\w]*/gu) ?? []).filter((word) => !dist_js_keywords.has(word));
	const singleCharShare =
		identifiers.length > 0 ? identifiers.filter((word) => word.length === 1).length / identifiers.length : 0;
	if (singleCharShare > dist_max_single_char_identifier_share) {
		findings.push(
			`${Math.round(singleCharShare * 100)}% of identifiers are a single character (limit ${dist_max_single_char_identifier_share * 100}%); the dist must keep readable identifier names`,
		);
	}

	const escapeCount = (source.match(/\\[xu]/gu) ?? []).length;
	if (source.length > 0 && escapeCount / source.length > dist_max_hex_unicode_escape_density) {
		findings.push(
			`Dist is dense with \\x/\\u escape sequences (${escapeCount} escapes); encoded strings look obfuscated`,
		);
	}

	if (new RegExp(`["'\`][A-Za-z0-9+/]{${dist_base64_literal_min_length},}={0,2}["'\`]`, "u").test(source)) {
		findings.push(
			`Dist contains a base64-looking string literal of ${dist_base64_literal_min_length}+ characters; ship code and assets as plain files instead`,
		);
	}

	if (/\bFunction\s*\(/u.test(source)) {
		findings.push("Dist uses the Function constructor; dynamically-assembled code is not allowed");
	}

	return findings;
}

const event_schema = z
	.object({
		type: z.enum(EVENT_TYPES),
		contentTypes: z.array(z.string().min(1)).min(1),
	})
	.strict();

const page_schema = z
	.object({
		name: z.string().min(1),
		displayName: z.string().min(1),
		html: module_path_schema,
		assets: z.array(module_path_schema),
	})
	.strict();

const manifest_file_schema = z
	.object({
		path: module_path_schema,
		sha256: z.string().regex(sha256_regex),
		bytes: z.number().int().nonnegative(),
		contentType: z.string().min(1),
		r2Key: z.string().optional(),
	})
	.strict();

const manifest_schema = z
	.object({
		schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
		name: z.string(),
		displayName: z.string().min(1),
		version: z.string().regex(semver_regex),
		description: z.string(),
		compatibility: z
			.object({
				bonoboPluginRuntime: z.literal(plugins_RUNTIME_VERSION),
			})
			.strict(),
		backend: z
			.object({
				entry: module_path_schema,
				moduleName: module_path_schema,
				compatibilityDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u),
				compatibilityFlags: z.array(z.string().min(1)),
			})
			.strict()
			.optional(),
		events: z.array(event_schema),
		pages: z.array(page_schema),
		capabilities: z.array(z.enum(CAPABILITIES)),
		outboundOrigins: z.array(z.string()),
		files: z.array(manifest_file_schema),
	})
	.strict();

export function plugins_validate_manifest(input: unknown) {
	const parsed = manifest_schema.safeParse(input);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? "Invalid plugin manifest" } });
	}
	const name = autofix_and_validate_name(parsed.data.name);
	if (name._nay) {
		return Result({ _nay: { message: name._nay.message } });
	}
	if (name._yay !== parsed.data.name) {
		return Result({ _nay: { message: "Plugin name must already be normalized" } });
	}
	const outboundOrigins = new Set<string>();
	for (const origin of parsed.data.outboundOrigins) {
		const validated = plugins_validate_origin(origin);
		if (validated._nay) {
			return Result({ _nay: { message: validated._nay.message } });
		}
		if (validated._yay !== origin) {
			return Result({ _nay: { message: "Outbound origins must already be normalized" } });
		}
		if (outboundOrigins.has(origin)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate outbound origin "${origin}"` } });
		}
		outboundOrigins.add(origin);
	}
	const filePaths = new Set<string>();
	for (const file of parsed.data.files) {
		if (!file.path.startsWith("dist/")) {
			return Result({ _nay: { message: `Plugin file "${file.path}" must be under dist/` } });
		}
		if (filePaths.has(file.path)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate file path "${file.path}"` } });
		}
		filePaths.add(file.path);
	}
	return Result({ _yay: parsed.data });
}
