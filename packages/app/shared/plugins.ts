import { z } from "zod";

import { Result } from "common/errors-as-values-utils.ts";
import { organizations_name_autofix_and_validate } from "./organizations.ts";

export const plugins_RUNTIME_VERSION = "1";

const MANIFEST_SCHEMA_VERSION = 1;
const EVENT_TYPES = ["files.upload.completed"] as const;

const CAPABILITIES = ["plugin.secrets.read", "outbound.fetch", "workspace.files.read"] as const;
export type plugins_Capability = (typeof CAPABILITIES)[number];

// Shared by env text parsing and the dist review scan.
const NEWLINE_REGEX = /\r?\n/u;

// Plugin names share the organization/workspace slug rules.
function autofix_and_validate_name(raw: string) {
	return organizations_name_autofix_and_validate(raw);
}

// #region secret names

const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_SECRET_NAME_LENGTH = 128;

export function plugins_validate_secret_name(raw: string) {
	const name = raw.trim();
	if (name.length > MAX_SECRET_NAME_LENGTH) {
		return Result({ _nay: { message: `Secret names must be at most ${MAX_SECRET_NAME_LENGTH} characters` } });
	}

	if (!SECRET_NAME_REGEX.test(name)) {
		return Result({ _nay: { message: "Secret names must use env key syntax" } });
	}

	return Result({ _yay: name });
}

// #endregion secret names

const MAX_OUTBOUND_ORIGIN_LENGTH = 255;

export function plugins_validate_origin(raw: string) {
	const trimmed = raw.trim();
	if (trimmed.length > MAX_OUTBOUND_ORIGIN_LENGTH) {
		return Result({
			_nay: { message: `Origins must be at most ${MAX_OUTBOUND_ORIGIN_LENGTH} characters` },
		});
	}
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

// #region env text

// Strips the invisible byte-order mark some editors put at the start of a file.
const BOM_REGEX = /^\uFEFF/u;
// Escape sequences unquoted from double-quoted .env values.
const ESCAPED_NEWLINE_REGEX = /\\n/gu;
const ESCAPED_CARRIAGE_RETURN_REGEX = /\\r/gu;
const ESCAPED_TAB_REGEX = /\\t/gu;
const ESCAPED_QUOTE_REGEX = /\\"/gu;
const ESCAPED_BACKSLASH_REGEX = /\\\\/gu;

export function plugins_parse_env_text(raw: string) {
	const secrets = new Map<string, string>();
	const lines = raw.replace(BOM_REGEX, "").split(NEWLINE_REGEX);
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
					.replace(ESCAPED_NEWLINE_REGEX, "\n")
					.replace(ESCAPED_CARRIAGE_RETURN_REGEX, "\r")
					.replace(ESCAPED_TAB_REGEX, "\t")
					.replace(ESCAPED_QUOTE_REGEX, '"')
					.replace(ESCAPED_BACKSLASH_REGEX, "\\");
			}
		}

		secrets.set(name._yay, value);
	}

	return Result({
		_yay: Array.from(secrets, ([name, value]) => ({ name, value })),
	});
}

// #endregion env text

// #region github repository

const GITHUB_OWNER_REGEX = /^[A-Za-z0-9-]{1,39}$/u;
const GITHUB_REPO_REGEX = /^[A-Za-z0-9._-]{1,100}$/u;
const GITHUB_SSH_URL_REGEX = /^git@github\.com:([^/]+)\/(.+)$/u;
const GIT_SUFFIX_REGEX = /\.git$/u;

export function plugins_parse_github_repository_url(raw: string) {
	const value = raw.trim();
	let owner: string;
	let repo: string;

	const sshMatch = GITHUB_SSH_URL_REGEX.exec(value);
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

	repo = repo.replace(GIT_SUFFIX_REGEX, "");
	if (!GITHUB_OWNER_REGEX.test(owner) || !GITHUB_REPO_REGEX.test(repo) || repo === "." || repo === "..") {
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

// #endregion github repository

// #region dist review

// Thresholds calibrated against the first-party plugin readable dists (max line 278,
// avg line 33, single-char identifier share 0.072) vs the same worker minified
// with esbuild (max line 3228, avg 316, share 0.482).
const MAX_LINE_LENGTH = 1000;
const MAX_AVG_LINE_LENGTH = 200;
const MAX_SINGLE_CHAR_IDENTIFIER_SHARE = 0.3;
const MAX_HEX_UNICODE_ESCAPE_DENSITY = 0.01;
const BASE64_LITERAL_MIN_LENGTH = 256;

const IDENTIFIER_REGEX = /[$A-Za-z_][$\w]*/gu;
const HEX_UNICODE_ESCAPE_REGEX = /\\[xu]/gu;
const FUNCTION_CONSTRUCTOR_REGEX = /\bFunction\s*\(/u;
const BASE64_LITERAL_REGEX = new RegExp(`["'\`][A-Za-z0-9+/]{${BASE64_LITERAL_MIN_LENGTH},}={0,2}["'\`]`, "u");

// Words that match the identifier regex but are language syntax, not names the
// author chose; excluding them keeps the single-char share meaningful.
const JS_KEYWORDS = new Set([
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

/**
 * Static readability checks on a plugin dist source file, run before publish.
 * Plugin dists must ship as plain readable text so they can be reviewed;
 * this catches the mechanical signs of minified or obfuscated code (very long
 * lines, mostly single-character names, dense escape sequences, huge base64
 * blobs, the Function constructor) without spending an AI review call.
 *
 * Returns one human-readable message per failed check; an empty array means
 * the source passed. Any finding rejects the version.
 */
export function plugins_dist_review_mechanical_findings(source: string, options?: { javaScript?: boolean }) {
	const findings: string[] = [];
	const readableKind = options?.javaScript === false ? "text" : "JavaScript";

	// Blank lines are dropped so they don't drag the average down.
	const lines = source.split(NEWLINE_REGEX).filter((line) => line.trim().length > 0);

	// Minifiers pack whole programs onto one line; readable code stays well under the limit.
	const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
	if (longestLine > MAX_LINE_LENGTH) {
		findings.push(
			`Longest line is ${longestLine} characters (limit ${MAX_LINE_LENGTH}); the dist must be plain readable ${readableKind}, not minified`,
		);
	}

	// The average catches minified output that was split across a few still-long lines.
	const avgLineLength = lines.length > 0 ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
	if (avgLineLength > MAX_AVG_LINE_LENGTH) {
		findings.push(
			`Average line length is ${Math.round(avgLineLength)} characters (limit ${MAX_AVG_LINE_LENGTH}); the dist must be plain readable ${readableKind}, not minified`,
		);
	}

	// Minifiers rename variables to a, b, c...; a high share of single-character
	// names means the original names are gone. Keywords are excluded because the
	// author didn't choose them.
	if (options?.javaScript !== false) {
		const identifiers = (source.match(IDENTIFIER_REGEX) ?? []).filter((word) => !JS_KEYWORDS.has(word));
		const singleCharShare =
			identifiers.length > 0 ? identifiers.filter((word) => word.length === 1).length / identifiers.length : 0;
		if (singleCharShare > MAX_SINGLE_CHAR_IDENTIFIER_SHARE) {
			findings.push(
				`${Math.round(singleCharShare * 100)}% of identifiers are a single character (limit ${MAX_SINGLE_CHAR_IDENTIFIER_SHARE * 100}%); the dist must keep readable identifier names`,
			);
		}
	}

	// Lots of \x/\u escapes usually means strings were encoded to hide their contents.
	const escapeCount = (source.match(HEX_UNICODE_ESCAPE_REGEX) ?? []).length;
	if (source.length > 0 && escapeCount / source.length > MAX_HEX_UNICODE_ESCAPE_DENSITY) {
		findings.push(
			`Dist is dense with \\x/\\u escape sequences (${escapeCount} escapes); encoded strings look obfuscated`,
		);
	}

	// A giant base64 string literal is a common way to smuggle code or assets past review.
	if (BASE64_LITERAL_REGEX.test(source)) {
		findings.push(
			`Dist contains a base64-looking string literal of ${BASE64_LITERAL_MIN_LENGTH}+ characters; ship code and assets as plain files instead`,
		);
	}

	// Code built from strings at runtime can't be reviewed, so ban the Function constructor.
	if (options?.javaScript !== false && FUNCTION_CONSTRUCTOR_REGEX.test(source)) {
		findings.push("Dist uses the Function constructor; dynamically-assembled code is not allowed");
	}

	return findings;
}

// #endregion dist review

// #region manifest

const SHA256_REGEX = /^sha256:[a-f0-9]{64}$/u;
const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const MODULE_PATH_REGEX = /^[A-Za-z0-9._/-]+$/u;
const COMPATIBILITY_DATE_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

// These limits are checked before any file is fetched. Publishing downloads, buffers, and uploads
// whatever the manifest declares, so without them a huge manifest would mean a huge publish.
const MAX_FILES = 64;
const MAX_PAGES = 16;
const MAX_NAV_ITEMS = 8;
const MAX_EVENTS = 8;
const MAX_CONTENT_TYPES_PER_EVENT = 32;
const MAX_EXPANDED_EVENT_CONTENT_TYPES = 64;
const MAX_OUTBOUND_ORIGINS = 16;
const MAX_FILE_PATH_LENGTH = 512;
const MAX_CONTENT_TYPE_LENGTH = 255;
// Matches files_MAX_TEXT_CONTENT_BYTES: every artifact file must fit the app's text-content cap.
const MAX_FILE_BYTES = 900_000;

/** Byte cap for the whole artifact. Publishing checks it twice: on the declared sizes, then on the actual downloaded bytes. */
export const plugins_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Manifest paths are stored and joined verbatim, so require an already-normalized
 * relative path: no leading/trailing/duplicate slashes and no "." / ".." segments.
 */
const module_path_schema = z
	.string()
	.max(MAX_FILE_PATH_LENGTH)
	.regex(MODULE_PATH_REGEX)
	.refine(
		(path) => path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
		"Path must be a normalized relative path",
	);

const event_schema = z
	.object({
		type: z.enum(EVENT_TYPES),
		contentTypes: z
			.array(
				z
					.string()
					.min(1)
					.max(MAX_CONTENT_TYPE_LENGTH, `Event content types must be at most ${MAX_CONTENT_TYPE_LENGTH} characters`),
			)
			.min(1)
			.max(
				MAX_CONTENT_TYPES_PER_EVENT,
				`Plugin events can declare at most ${MAX_CONTENT_TYPES_PER_EVENT} content types`,
			),
	})
	.strict();

const manifest_file_schema = z
	.object({
		path: module_path_schema,
		sha256: z.string().regex(SHA256_REGEX),
		bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
		contentType: z.string().min(1).max(MAX_CONTENT_TYPE_LENGTH),
		r2Key: z.string().optional(),
	})
	.strict();

const PAGE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// Lucide icon names are kebab-case; the app maps them through an allowlist with a fallback.
const PAGE_NAV_ICON_REGEX = /^[a-z0-9-]{1,64}$/u;

/**
 * The lucide icon names the app sidebar can render for page nav items. Any other `navItem.icon`
 * (or none) falls back to the generic Puzzle icon when rendered. Publish never rejects an icon
 * name, so new names can be added here without breaking already-published manifests. Plain
 * strings only: Convex code imports this module, so it must never depend on lucide-react.
 */
export const plugins_PAGE_NAV_ICON_NAMES = ["images", "image", "film", "gallery-vertical-end"] as const;

const page_nav_item_schema = z
	.object({
		label: z.string().min(1).max(40),
		icon: z.string().regex(PAGE_NAV_ICON_REGEX).optional(),
	})
	.strict();

const page_schema = z
	.object({
		id: z.string().regex(PAGE_ID_REGEX),
		title: z.string().min(1).max(80),
		/** Must match a files[] entry with contentType "text/html"; served into a sandboxed iframe. */
		entry: module_path_schema,
		/** Presence is the explicit opt-in for a main-sidebar nav item. */
		navItem: page_nav_item_schema.optional(),
	})
	.strict();

const manifest_schema = z
	.object({
		schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
		name: z.string(),
		displayName: z.string().min(1),
		version: z.string().regex(SEMVER_REGEX),
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
				compatibilityDate: z.string().regex(COMPATIBILITY_DATE_REGEX),
				compatibilityFlags: z.array(z.string().min(1)),
			})
			.strict()
			.optional(),
		events: z.array(event_schema).max(MAX_EVENTS, `Plugin manifests can declare at most ${MAX_EVENTS} events`),
		pages: z.array(page_schema).max(MAX_PAGES).optional(),
		capabilities: z.array(z.enum(CAPABILITIES)),
		outboundOrigins: z
			.array(z.string())
			.max(MAX_OUTBOUND_ORIGINS, `Plugin manifests can declare at most ${MAX_OUTBOUND_ORIGINS} outbound origins`),
		files: z.array(manifest_file_schema).max(MAX_FILES),
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
	const eventSubscriptions = new Set<string>();
	let expandedEventSubscriptionCount = 0;
	for (const event of parsed.data.events) {
		for (const contentType of event.contentTypes) {
			const subscription = `${event.type}\u0000${contentType}`;
			if (eventSubscriptions.has(subscription)) {
				return Result({
					_nay: { message: `Plugin manifest has duplicate ${event.type} content type "${contentType}"` },
				});
			}
			eventSubscriptions.add(subscription);
			expandedEventSubscriptionCount += 1;
			if (expandedEventSubscriptionCount > MAX_EXPANDED_EVENT_CONTENT_TYPES) {
				return Result({
					_nay: {
						message: `Plugin manifest declares more than ${MAX_EXPANDED_EVENT_CONTENT_TYPES} event content-type subscriptions`,
					},
				});
			}
		}
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
	let declaredArtifactBytes = 0;
	for (const file of parsed.data.files) {
		if (!file.path.startsWith("dist/")) {
			return Result({ _nay: { message: `Plugin file "${file.path}" must be under dist/` } });
		}
		if (filePaths.has(file.path)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate file path "${file.path}"` } });
		}
		filePaths.add(file.path);
		declaredArtifactBytes += file.bytes;
		if (declaredArtifactBytes > plugins_MAX_ARTIFACT_BYTES) {
			return Result({ _nay: { message: "Plugin manifest declares more than 16 MiB of artifact bytes" } });
		}
	}
	const pageIds = new Set<string>();
	let navItemCount = 0;
	for (const page of parsed.data.pages ?? []) {
		if (pageIds.has(page.id)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate page id "${page.id}"` } });
		}
		pageIds.add(page.id);
		if (page.navItem) {
			navItemCount += 1;
			if (navItemCount > MAX_NAV_ITEMS) {
				return Result({ _nay: { message: `Plugin manifest declares more than ${MAX_NAV_ITEMS} nav items` } });
			}
		}
		const entryFile = parsed.data.files.find((file) => file.path === page.entry);
		if (!entryFile) {
			return Result({ _nay: { message: `Plugin page "${page.id}" entry must be a listed file` } });
		}
		if (entryFile.contentType !== "text/html") {
			return Result({ _nay: { message: `Plugin page "${page.id}" entry must be a text/html file` } });
		}
	}
	const capabilities = new Set<string>();
	for (const capability of parsed.data.capabilities) {
		if (capabilities.has(capability)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate capability "${capability}"` } });
		}
		capabilities.add(capability);
	}
	return Result({ _yay: parsed.data });
}

// #endregion manifest
