import { z } from "zod";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node as YamlNode } from "yaml";

import { Result } from "common/errors-as-values-utils.ts";
import { files_get_normalized_node_path_segments, files_get_utf8_byte_size } from "./files.ts";
import { organizations_name_autofix_and_validate } from "./organizations.ts";

export const plugins_RUNTIME_VERSION = "1";

/**
 * Which review policy the current code implements.
 *
 * A stored verdict is only reused when it was produced under this same value. Bump it whenever the
 * review prompts, the mechanical severities, the model or tool semantics, the file classifier, or the
 * required coverage change. Without the bump an old verdict would keep authorizing publishes under a
 * policy that no longer exists.
 *
 * Keep one value through a multi-step rollout, or invalidate every verdict produced by the interim
 * steps before any of them can authorize a publish.
 */
export const plugins_REVIEW_POLICY_VERSION = "10";

const MANIFEST_SCHEMA_VERSION = 1;
const EVENT_TYPES = ["files.upload.completed", "users.account.deleted"] as const;

/**
 * The event that fires when a member's account is deleted, so a plugin holding that user's id in its
 * own documents can render them as deleted.
 *
 * It has no file and no content type, and its only subject is one user, so the two things an upload
 * event declares — content types and path filters — are refused on it instead of ignored. A manifest
 * that declares them would register a handler nothing can ever match, and the author would find out
 * only when the event never arrived.
 */
const ACCOUNT_DELETED_EVENT_TYPE = "users.account.deleted";

const CAPABILITIES = [
	"plugin.secrets.read",
	"outbound.fetch",
	"workspace.files.read",
	"workspace.files.write",
	// Consent line: the files this installation creates through the sealed upload door may be locked
	// read-only, and it may release that one lock again to archive its own file. That release is the
	// only way this installation can remove a lock, and it matches a lock this exact service target
	// created, so this grants no write over content a member owns and no lock access anywhere else.
	//
	// It narrows `workspace.files.write` instead of replacing it, because a read-only file is still
	// a file this installation writes.
	"workspace.files.create-read-only",
	// Consent line: the plugin's backend may create, update, and archive files inside the folders
	// this plugin creates and owns. Every node it creates carries the plugin's ownership stamp, and
	// the write doors refuse any path whose existing chain does not carry that stamp, so this opens
	// no write over a member's own files.
	"workspace.files.own-write",
	// Consent line: the plugin may lock its own folders and files read-only and restrict them to its
	// own private scopes; the host keeps the reader lists equal to the scope members. It only ever
	// applies to nodes carrying this plugin's ownership stamp, so a member's files are out of reach.
	"workspace.files.own-access",
	"plugin.data.read",
	"plugin.data.write",
	// Consent line: the plugin's UI pages and file views may store and change this plugin's data as
	// the acting member, through the app. Kept apart from `plugin.data.write`, which is the plugin's
	// own backend or service writing as the installation: the two are different consents, and a
	// user-write door under the backend capability would widen consent nobody gave.
	"plugin.data.user-write",
	// Consent line: the plugin's pages and file views may run the plugin's backend on demand; the
	// backend then acts with the plugin's own API access. Kept apart from the event-driven runs the
	// backend already gets, because "a member's click runs publisher code that can write" is a
	// different consent from "an upload runs it".
	"plugin.backend.invoke",
	"plugin.service.connect",
	// The plugin's UI pages and file views, running in the browser, may call the origins in
	// `uiOutboundOrigins`. Kept apart from `outbound.fetch`, which is the plugin's backend calling out
	// from the runner. The two are different risks and get different consent text: a frame holds a
	// member's session token, and whatever it may reach can be reached by anything that manages to run
	// inside that frame.
	"ui.outbound.fetch",
	// Consent line: the plugin's UI pages and file views may read the whole member list of this
	// workspace. Without it a frame can only turn ids it already stored into names, 50 at a time,
	// which enumerates nobody. This is its own capability because enumeration is a different consent
	// from name resolution, and because every member reads the roster under one rule — including a
	// member who signed in anonymously.
	"workspace.members.read",
] as const;
export type plugins_Capability = (typeof CAPABILITIES)[number];

// Shared by env text parsing and the dist review scan.
const NEWLINE_REGEX = /\r?\n/u;

// #region installation configuration

const MAX_CONFIGURATION_BYTES = 16 * 1024;
const MAX_CONFIGURATION_PATH_VALUES = 32;
const MAX_CONFIGURATION_PATH_VALUE_LENGTH = 512;

export type plugins_ConfigurationValue =
	| null
	| boolean
	| number
	| string
	| plugins_ConfigurationValue[]
	| { [key: string]: plugins_ConfigurationValue };

const configuration_value_schema: z.ZodType<plugins_ConfigurationValue> = z.json();
const configuration_root_schema = z.record(z.string(), configuration_value_schema);

function configuration_node_or_null(value: unknown): YamlNode | null {
	if (value === null || isAlias(value) || isScalar(value) || isMap(value) || isSeq(value)) {
		return value;
	}
	return null;
}

function configuration_node_has_alias_or_tag(node: YamlNode | null): "alias" | "tag" | null {
	if (node === null) {
		return null;
	}
	if (isAlias(node)) {
		return "alias";
	}
	if (node.tag != null) {
		return "tag";
	}
	if (isMap(node)) {
		for (const pair of node.items) {
			const unsupported =
				configuration_node_has_alias_or_tag(configuration_node_or_null(pair.key)) ??
				configuration_node_has_alias_or_tag(configuration_node_or_null(pair.value));
			if (unsupported) {
				return unsupported;
			}
		}
	}
	if (isSeq(node)) {
		for (const item of node.items) {
			const unsupported = configuration_node_has_alias_or_tag(configuration_node_or_null(item));
			if (unsupported) {
				return unsupported;
			}
		}
	}
	return null;
}

function configuration_value_at_path(value: plugins_ConfigurationValue, path: string[]) {
	let current: plugins_ConfigurationValue = value;
	for (const segment of path) {
		if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
			return null;
		}
		current = current[segment]!;
	}
	return current;
}

function validate_event_filter_values(args: {
	configuration: plugins_ConfigurationValue;
	filter: plugins_EventFilter;
}) {
	const value = configuration_value_at_path(args.configuration, args.filter.configurationPath);
	const configurationPath = args.filter.configurationPath.join(".");
	if (!Array.isArray(value)) {
		return Result({ _nay: { message: `Plugin configuration "${configurationPath}" must be an array` } });
	}
	if (value.length > MAX_CONFIGURATION_PATH_VALUES) {
		return Result({
			_nay: {
				message: `Plugin configuration "${configurationPath}" can include at most ${MAX_CONFIGURATION_PATH_VALUES} paths`,
			},
		});
	}

	const paths = new Set<string>();
	for (const path of value) {
		if (typeof path !== "string") {
			return Result({ _nay: { message: `Plugin configuration "${configurationPath}" must contain only paths` } });
		}
		if (path.length > MAX_CONFIGURATION_PATH_VALUE_LENGTH) {
			return Result({
				_nay: {
					message: `Plugin configuration paths must be at most ${MAX_CONFIGURATION_PATH_VALUE_LENGTH} characters`,
				},
			});
		}
		if (paths.has(path)) {
			return Result({ _nay: { message: `Plugin configuration has duplicate path "${path}"` } });
		}

		if (path !== "/") {
			const normalized = files_get_normalized_node_path_segments({ kind: "folder", nameOrPath: path });
			if (
				!normalized ||
				"validationMessage" in normalized ||
				`/${normalized.normalizedPathSegments.join("/")}` !== path
			) {
				return Result({ _nay: { message: `Plugin configuration path "${path}" must be a canonical absolute path` } });
			}
		}

		paths.add(path);
	}

	return Result({ _yay: [...paths] });
}

export function plugins_parse_installation_configuration_yaml(args: {
	configurationYaml: string;
	events: plugins_Event[];
}) {
	if (!args.configurationYaml.trim()) {
		return Result({ _nay: { message: "Plugin configuration cannot be blank" } });
	}
	if (files_get_utf8_byte_size(args.configurationYaml) > MAX_CONFIGURATION_BYTES) {
		return Result({ _nay: { message: "Plugin configuration must be at most 16 KiB" } });
	}

	const documents = parseAllDocuments(args.configurationYaml, {
		version: "1.2",
		schema: "core",
		// Keep tags visible in the syntax tree so this strict app-owned format can reject them.
		resolveKnownTags: false,
	});
	if (documents.length !== 1) {
		return Result({ _nay: { message: "Plugin configuration must contain exactly one YAML document" } });
	}

	const document = documents[0]!;
	if (document.errors.length > 0) {
		return Result({ _nay: { message: "Plugin configuration must be valid YAML" } });
	}

	const unsupportedYaml = configuration_node_has_alias_or_tag(configuration_node_or_null(document.contents));
	if (unsupportedYaml === "alias") {
		return Result({ _nay: { message: "Plugin configuration must not use YAML aliases" } });
	}
	if (unsupportedYaml === "tag" || document.warnings.length > 0) {
		return Result({ _nay: { message: "Plugin configuration must not use YAML tags" } });
	}

	const parsed = configuration_root_schema.safeParse(document.toJS({ maxAliasCount: 0 }));
	if (!parsed.success) {
		return Result({ _nay: { message: "Plugin configuration must be a YAML object" } });
	}

	for (const event of args.events) {
		for (const filter of event.filters) {
			const values = validate_event_filter_values({ configuration: parsed.data, filter });
			if (values._nay) {
				return values;
			}
		}
	}

	return Result({
		_yay: {
			configurationYaml: args.configurationYaml,
			configuration: parsed.data,
		},
	});
}

export function plugins_event_matches_configuration(args: {
	configuration: plugins_ConfigurationValue;
	event: plugins_Event;
	source: { path: string };
}) {
	return args.event.filters.every((filter) => {
		const values = validate_event_filter_values({ configuration: args.configuration, filter });
		if (values._nay) {
			return false;
		}
		return values._yay.some(
			(path) => path === "/" || args.source.path === path || args.source.path.startsWith(`${path}/`),
		);
	});
}

export function plugins_get_event_filter_values(args: {
	configuration: plugins_ConfigurationValue;
	event: plugins_Event;
}) {
	return args.event.filters.map((filter) => {
		const values = validate_event_filter_values({ configuration: args.configuration, filter });
		return {
			filter,
			values: values._nay ? [] : values._yay,
		};
	});
}

// #endregion installation configuration

// Plugin names share the organization/workspace slug rules.
function autofix_and_validate_name(raw: string) {
	return organizations_name_autofix_and_validate(raw);
}

// #region secrets

const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_SECRET_NAME_LENGTH = 128;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;

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

/**
 * Keep a secret value small enough that its encrypted document stays far below the 1 MiB Convex
 * document limit. Without this cap a large value makes `ctx.db.insert` throw, and in a batch
 * upsert that throw lands after sibling secrets in the same batch have already been written.
 *
 * Do not trim the value. Whitespace can be part of a real secret, and `plugins_parse_env_text`
 * already handles env quoting.
 */
export function plugins_validate_secret_value(raw: string) {
	if (files_get_utf8_byte_size(raw) > MAX_SECRET_VALUE_BYTES) {
		return Result({ _nay: { message: `Secret values must be at most ${MAX_SECRET_VALUE_BYTES / 1024} KiB` } });
	}

	return Result({ _yay: raw });
}

// #endregion secrets

// #region plugin data store

/**
 * Collection names and keys in the plugin data store. Same length a plugin secret name may have.
 */
export const plugins_data_MAX_NAME_LENGTH = 128;
/**
 * An append completes the caller's prefix into a full key by adding the 13-digit inverted
 * millisecond stamp, one `:`, and 4 random characters. The budget reserves those 18 characters
 * plus one spare, so the composed key always fits the key length limit.
 */
export const plugins_data_MAX_KEY_PREFIX_LENGTH = plugins_data_MAX_NAME_LENGTH - (13 + 1 + 4 + 1);
/**
 * The largest page or window one plugin-data read may return.
 */
export const plugins_data_MAX_LIST_PAGE_SIZE = 100;

/**
 * The one rule for a plugin-data collection, key, scope id, or idempotency key.
 * The manifest and the write doors must agree, so both call this.
 */
export function plugins_data_is_valid_name(raw: string) {
	return (
		raw.length > 0 && raw.length <= plugins_data_MAX_NAME_LENGTH && raw === raw.trim() && !/[\p{Cc}\p{Cf}]/u.test(raw)
	);
}

// #endregion plugin data store

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
	current: { capabilities: plugins_Capability[]; outboundOrigins: string[]; uiOutboundOrigins: string[] } | null;
	target: { capabilities: plugins_Capability[]; outboundOrigins: string[]; uiOutboundOrigins: string[] };
}) {
	const currentCapabilities = new Set(args.current?.capabilities ?? []);
	const currentOrigins = new Set(args.current?.outboundOrigins ?? []);
	// Backend and UI egress are consented separately. The same origin can appear in both lists and
	// still be new to one of them, so the two sets never share entries.
	const currentUiOrigins = new Set(args.current?.uiOutboundOrigins ?? []);
	return {
		newCapabilities: args.target.capabilities.filter((capability) => !currentCapabilities.has(capability)),
		newOutboundOrigins: args.target.outboundOrigins.filter((origin) => !currentOrigins.has(origin)),
		newUiOutboundOrigins: args.target.uiOutboundOrigins.filter((origin) => !currentUiOrigins.has(origin)),
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
 * The two arrays have different power. `findings` rejects the version.
 * `advisoryFindings` is shown to the publisher and blocks nothing.
 *
 * The shape checks (line length, average line length, single-character
 * identifier share) are advisory because a normal vendored or bundled
 * dependency trips them and the plugin author cannot fix it. The content
 * checks stay rejecting: dense escapes, a huge base64 literal, and the
 * Function constructor are patterns an author writes on purpose, and each one
 * hides code from the review that follows.
 */
export function plugins_dist_review_mechanical_findings(source: string, options?: { javaScript?: boolean }) {
	const findings: string[] = [];
	const advisoryFindings: string[] = [];
	const readableKind = options?.javaScript === false ? "text" : "JavaScript";

	// Blank lines are dropped so they don't drag the average down.
	const lines = source.split(NEWLINE_REGEX).filter((line) => line.trim().length > 0);

	// Minifiers pack whole programs onto one line; readable code stays well under the limit.
	const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
	if (longestLine > MAX_LINE_LENGTH) {
		advisoryFindings.push(
			`Longest line is ${longestLine} characters (limit ${MAX_LINE_LENGTH}); the dist must be plain readable ${readableKind}, not minified`,
		);
	}

	// The average catches minified output that was split across a few still-long lines.
	const avgLineLength = lines.length > 0 ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
	if (avgLineLength > MAX_AVG_LINE_LENGTH) {
		advisoryFindings.push(
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
			advisoryFindings.push(
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

	return { findings, advisoryFindings };
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
const MAX_FILE_VIEWS = 8;
const MAX_EVENTS = 8;
const MAX_EVENT_FILTERS = 8;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_VERSION_LENGTH = 100;
const MAX_COMPATIBILITY_FLAGS = 32;
const MAX_COMPATIBILITY_FLAG_LENGTH = 64;
const MAX_BACKEND_ENDPOINTS = 8;
const MAX_BACKEND_ENDPOINT_PATH_LENGTH = 256;
const MAX_USER_WRITABLE_COLLECTIONS = 16;
const MAX_STORED_MANIFEST_BYTES = 64 * 1024;
const MAX_CONFIGURATION_PATH_SEGMENTS = 16;
const MAX_CONFIGURATION_PATH_SEGMENT_LENGTH = 128;
const MAX_CONFIGURATION_DESCRIPTION_LENGTH = 500;
const MAX_CONTENT_TYPES_PER_EVENT = 32;
const MAX_EXPANDED_EVENT_CONTENT_TYPES = 64;
const MAX_CONTENT_TYPES_PER_FILE_VIEW = 32;
const MAX_EXPANDED_FILE_VIEW_CONTENT_TYPES = 64;
const MAX_OUTBOUND_ORIGINS = 16;
const MAX_SECRETS = 32;
const MAX_SECRET_DESCRIPTION_LENGTH = 300;
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

const event_filter_schema = z
	.object({
		field: z.literal("source.path"),
		operator: z.literal("pathIsUnderAny"),
		configurationPath: z
			.array(z.string().min(1).max(MAX_CONFIGURATION_PATH_SEGMENT_LENGTH))
			.min(1)
			.max(MAX_CONFIGURATION_PATH_SEGMENTS),
	})
	.strict();

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
			.max(
				MAX_CONTENT_TYPES_PER_EVENT,
				`Plugin events can declare at most ${MAX_CONTENT_TYPES_PER_EVENT} content types`,
			)
			.default([]),
		filters: z.array(event_filter_schema).max(MAX_EVENT_FILTERS).default([]),
	})
	.strict()
	// The list stays a plain array so every reader keeps one type. Which events may fill it is a rule
	// about this event vocabulary, not about the field, so it lives here.
	.superRefine((event, ctx) => {
		if (event.type === ACCOUNT_DELETED_EVENT_TYPE) {
			if (event.contentTypes.length > 0) {
				ctx.addIssue({
					code: "custom",
					path: ["contentTypes"],
					message: `${ACCOUNT_DELETED_EVENT_TYPE} carries no file, so it cannot declare content types`,
				});
			}

			if (event.filters.length > 0) {
				ctx.addIssue({
					code: "custom",
					path: ["filters"],
					message: `${ACCOUNT_DELETED_EVENT_TYPE} has one subject, so it cannot declare filters`,
				});
			}

			return;
		}

		if (event.contentTypes.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["contentTypes"],
				message: `${event.type} must declare at least one content type`,
			});
		}
	});

const plugin_configuration_schema = z
	.object({
		description: z.string().min(1).max(MAX_CONFIGURATION_DESCRIPTION_LENGTH),
		defaultYaml: z.string(),
	})
	.strict();

type plugins_EventFilter = z.infer<typeof event_filter_schema>;
type plugins_Event = z.infer<typeof event_schema>;

const manifest_file_schema = z
	.object({
		path: module_path_schema,
		sha256: z.string().regex(SHA256_REGEX),
		bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
		contentType: z.string().min(1).max(MAX_CONTENT_TYPE_LENGTH),
	})
	.strict();

// Same shape as PAGE_ID_REGEX, kept separate because endpoint ids are their own namespace.
const BACKEND_ENDPOINT_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// Printable ASCII only, starting with `/`. The path becomes the synthetic request URL the runner
// builds, so anything outside this range would have to be escaped somewhere and compared somewhere
// else — refuse it at publish instead.
const BACKEND_ENDPOINT_PATH_REGEX = /^\/[\x21-\x7E]*$/u;
// The runner delivers host events on paths under this prefix. A manifest endpoint on it could make
// a member's page invoke look like a host event delivery to the plugin's own code.
const RESERVED_BACKEND_PATH_PREFIX = "/__bonobo_senate";

const backend_endpoint_schema = z
	.object({
		id: z
			.string()
			.regex(BACKEND_ENDPOINT_ID_REGEX, "Backend endpoint ids must be lowercase letters, digits, and dashes"),
		path: z
			.string()
			.max(
				MAX_BACKEND_ENDPOINT_PATH_LENGTH,
				`Backend endpoint paths must be at most ${MAX_BACKEND_ENDPOINT_PATH_LENGTH} characters`,
			)
			.regex(BACKEND_ENDPOINT_PATH_REGEX, "Backend endpoint paths must start with / and use printable ASCII")
			// The runner builds a URL from this path, and the URL constructor collapses `.` and
			// `..` segments. A path like `/x/../__bonobo_senate/run` would pass the prefix check
			// below and still reach the reserved prefix, so refuse dot segments outright.
			.refine(
				(path) => path.split("/").every((segment) => segment !== "." && segment !== ".."),
				"Backend endpoint paths must not contain . or .. segments",
			)
			.refine(
				(path) => !path.startsWith(RESERVED_BACKEND_PATH_PREFIX),
				`Backend endpoint paths must not start with ${RESERVED_BACKEND_PATH_PREFIX}`,
			),
		serialization: z.enum(["installation", "caller-key"]).optional(),
	})
	.strict();

const service_scope_schema = z.enum(["plugin_data:read", "plugin_data:write", "files:write"]);

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

const file_view_schema = z
	.object({
		id: z.string().regex(PAGE_ID_REGEX),
		title: z.string().min(1).max(80),
		/** Must match a files[] entry with contentType "text/html"; served into a sandboxed iframe. */
		entry: module_path_schema,
		/** Exact stored file content types this view opens for; matched against `files_nodes.contentType`. */
		contentTypes: z
			.array(
				z
					.string()
					.min(1)
					.max(
						MAX_CONTENT_TYPE_LENGTH,
						`File view content types must be at most ${MAX_CONTENT_TYPE_LENGTH} characters`,
					),
			)
			.min(1)
			.max(
				MAX_CONTENT_TYPES_PER_FILE_VIEW,
				`Plugin file views can declare at most ${MAX_CONTENT_TYPES_PER_FILE_VIEW} content types`,
			),
	})
	.strict();

const secret_declaration_schema = z
	.object({
		name: z.string(),
		/** Publisher-authored text. The details page renders it escaped and attributed, never as markup. */
		description: z
			.string()
			.max(
				MAX_SECRET_DESCRIPTION_LENGTH,
				`Secret descriptions must be at most ${MAX_SECRET_DESCRIPTION_LENGTH} characters`,
			),
		optional: z.boolean().default(false),
	})
	.strict();

const manifest_schema = z
	.object({
		schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
		name: z.string(),
		displayName: z
			.string()
			.min(1)
			.max(MAX_DISPLAY_NAME_LENGTH, `Plugin display names must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`),
		version: z
			.string()
			.max(MAX_VERSION_LENGTH, `Plugin versions must be at most ${MAX_VERSION_LENGTH} characters`)
			.regex(SEMVER_REGEX),
		description: z
			.string()
			.max(MAX_DESCRIPTION_LENGTH, `Plugin descriptions must be at most ${MAX_DESCRIPTION_LENGTH} characters`),
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
				compatibilityFlags: z
					.array(
						z
							.string()
							.min(1)
							.max(
								MAX_COMPATIBILITY_FLAG_LENGTH,
								`Compatibility flags must be at most ${MAX_COMPATIBILITY_FLAG_LENGTH} characters`,
							),
					)
					.max(
						MAX_COMPATIBILITY_FLAGS,
						`Plugin backends can declare at most ${MAX_COMPATIBILITY_FLAGS} compatibility flags`,
					),
				/**
				 * HTTP-invokable entrypoints for the invoke door; requires `plugin.backend.invoke`.
				 */
				endpoints: z
					.array(backend_endpoint_schema)
					.max(MAX_BACKEND_ENDPOINTS, `Plugin backends can declare at most ${MAX_BACKEND_ENDPOINTS} endpoints`)
					.optional(),
			})
			.strict()
			.optional(),
		/**
		 * Consent copy for the plugin's outside service. The service-registration row in the host is
		 * the exchange authority; this block only tells the consent screens what the service will ask
		 * for, so the two are deliberately not cross-checked at publish.
		 */
		service: z
			.object({
				scopes: z.array(service_scope_schema).min(1, "Plugin service declarations must name at least one scope"),
			})
			.strict()
			.optional(),
		configuration: plugin_configuration_schema.nullable().default(null),
		events: z.array(event_schema).max(MAX_EVENTS, `Plugin manifests can declare at most ${MAX_EVENTS} events`),
		pages: z.array(page_schema).max(MAX_PAGES).optional(),
		fileViews: z
			.array(file_view_schema)
			.max(MAX_FILE_VIEWS, `Plugin manifests can declare at most ${MAX_FILE_VIEWS} file views`)
			.optional(),
		capabilities: z.array(z.enum(CAPABILITIES)),
		/**
		 * The collections a member-identity writer may write. Absent means every collection stays
		 * user-writable; an empty array means none is. Machine writers are never restricted by this
		 * list — it exists so the backend can own some collections alone.
		 */
		userWritableCollections: z
			.array(z.string())
			.max(
				MAX_USER_WRITABLE_COLLECTIONS,
				`Plugin manifests can declare at most ${MAX_USER_WRITABLE_COLLECTIONS} user-writable collections`,
			)
			.optional(),
		secrets: z
			.array(secret_declaration_schema)
			.max(MAX_SECRETS, `Plugin manifests can declare at most ${MAX_SECRETS} secrets`)
			.default([]),
		outboundOrigins: z
			.array(z.string())
			.max(MAX_OUTBOUND_ORIGINS, `Plugin manifests can declare at most ${MAX_OUTBOUND_ORIGINS} outbound origins`),
		// Where the plugin's UI pages and file views may send requests. This becomes the `connect-src`
		// of the asset response, so the browser stops any other destination even if the frame's code
		// asks for it.
		uiOutboundOrigins: z
			.array(z.string())
			.max(MAX_OUTBOUND_ORIGINS, `Plugin manifests can declare at most ${MAX_OUTBOUND_ORIGINS} UI outbound origins`)
			.default([]),
		files: z.array(manifest_file_schema).max(MAX_FILES),
	})
	.strict();

export function plugins_validate_manifest(input: unknown) {
	const parsed = manifest_schema.safeParse(input);
	if (!parsed.success) {
		return Result({ _nay: { message: parsed.error.issues[0]?.message ?? "Invalid plugin manifest" } });
	}
	// A publisher query reads a bounded release window. Keep each stored version small enough that
	// the whole window stays far below Convex's transaction read limit.
	if (files_get_utf8_byte_size(JSON.stringify(parsed.data)) > MAX_STORED_MANIFEST_BYTES) {
		return Result({ _nay: { message: "Plugin manifest stores more than 64 KiB of metadata" } });
	}
	const name = autofix_and_validate_name(parsed.data.name);
	if (name._nay) {
		return Result({ _nay: { message: name._nay.message } });
	}
	if (name._yay !== parsed.data.name) {
		return Result({ _nay: { message: "Plugin name must already be normalized" } });
	}
	if (parsed.data.configuration === null && parsed.data.events.some((event) => event.filters.length > 0)) {
		return Result({ _nay: { message: "Plugin event filters require a configuration declaration" } });
	}
	if (parsed.data.configuration !== null) {
		const defaultConfiguration = plugins_parse_installation_configuration_yaml({
			configurationYaml: parsed.data.configuration.defaultYaml,
			events: parsed.data.events,
		});
		if (defaultConfiguration._nay) {
			return Result({
				_nay: { message: `Plugin default configuration is invalid: ${defaultConfiguration._nay.message}` },
			});
		}
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

	const uiOutboundOrigins = new Set<string>();
	for (const origin of parsed.data.uiOutboundOrigins) {
		const validated = plugins_validate_origin(origin);
		if (validated._nay) {
			return Result({ _nay: { message: validated._nay.message } });
		}
		if (validated._yay !== origin) {
			return Result({ _nay: { message: "UI outbound origins must already be normalized" } });
		}
		if (uiOutboundOrigins.has(origin)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate UI outbound origin "${origin}"` } });
		}
		uiOutboundOrigins.add(origin);
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
		// The review prompt lists every shipped file on its own line and prints this value on that
		// line. A newline here would let a publisher add inventory lines for files nobody shipped, and
		// a bidi override or zero-width character could hide part of a real line from the reviewer.
		if (/[\p{Cc}\p{Cf}]/u.test(file.contentType)) {
			return Result({
				_nay: { message: `Plugin file "${file.path}" content type must not contain control characters` },
			});
		}
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
	// File view ids share the pages id namespace: both address one sandboxed iframe entry per id.
	const fileViewContentTypes = new Set<string>();
	let expandedFileViewContentTypeCount = 0;
	for (const fileView of parsed.data.fileViews ?? []) {
		if (pageIds.has(fileView.id)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate file view id "${fileView.id}"` } });
		}
		pageIds.add(fileView.id);
		// One manifest must not declare the same content type in two file views: the files UI
		// shows at most one tab per plugin for a content type, so two would be ambiguous.
		for (const contentType of fileView.contentTypes) {
			if (fileViewContentTypes.has(contentType)) {
				return Result({
					_nay: { message: `Plugin manifest has duplicate file view content type "${contentType}"` },
				});
			}
			fileViewContentTypes.add(contentType);
			expandedFileViewContentTypeCount += 1;
			if (expandedFileViewContentTypeCount > MAX_EXPANDED_FILE_VIEW_CONTENT_TYPES) {
				return Result({
					_nay: {
						message: `Plugin manifest declares more than ${MAX_EXPANDED_FILE_VIEW_CONTENT_TYPES} file view content types`,
					},
				});
			}
		}
		const entryFile = parsed.data.files.find((file) => file.path === fileView.entry);
		if (!entryFile) {
			return Result({ _nay: { message: `Plugin file view "${fileView.id}" entry must be a listed file` } });
		}
		if (entryFile.contentType !== "text/html") {
			return Result({ _nay: { message: `Plugin file view "${fileView.id}" entry must be a text/html file` } });
		}
	}

	const endpointIds = new Set<string>();
	const endpointPaths = new Set<string>();
	for (const endpoint of parsed.data.backend?.endpoints ?? []) {
		if (endpointIds.has(endpoint.id)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate backend endpoint id "${endpoint.id}"` } });
		}
		endpointIds.add(endpoint.id);
		if (endpointPaths.has(endpoint.path)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate backend endpoint path "${endpoint.path}"` } });
		}
		endpointPaths.add(endpoint.path);
	}

	const serviceScopes = new Set<string>();
	for (const scope of parsed.data.service?.scopes ?? []) {
		if (serviceScopes.has(scope)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate service scope "${scope}"` } });
		}
		serviceScopes.add(scope);
	}

	const userWritableCollections = new Set<string>();
	for (const collection of parsed.data.userWritableCollections ?? []) {
		// The write doors judge membership in this list with the same rule they judge collection
		// names, so a name the doors would refuse can never be declared here.
		if (!plugins_data_is_valid_name(collection)) {
			return Result({
				_nay: { message: "User-writable collection names must be valid plugin-data collection names" },
			});
		}
		if (userWritableCollections.has(collection)) {
			return Result({
				_nay: { message: `Plugin manifest has duplicate user-writable collection "${collection}"` },
			});
		}
		userWritableCollections.add(collection);
	}

	const capabilities = new Set<string>();
	for (const capability of parsed.data.capabilities) {
		if (capabilities.has(capability)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate capability "${capability}"` } });
		}
		capabilities.add(capability);
	}
	const secretNames = new Set<string>();
	for (const secret of parsed.data.secrets) {
		// A name that fails the env-key rules could never be configured or read, so the
		// installation would stay "incomplete" forever. Reject it at publish instead.
		const validated = plugins_validate_secret_name(secret.name);
		if (validated._nay) {
			return Result({ _nay: { message: validated._nay.message } });
		}
		if (validated._yay !== secret.name) {
			return Result({ _nay: { message: "Secret names must already be normalized" } });
		}
		if (secretNames.has(secret.name)) {
			return Result({ _nay: { message: `Plugin manifest has duplicate secret "${secret.name}"` } });
		}
		secretNames.add(secret.name);
		// The description renders in the manager UI next to a credential input. Control and
		// format characters (bidi overrides, zero-width) can visually reorder or hide text
		// there, so reject them at publish.
		if (/[\p{Cc}\p{Cf}]/u.test(secret.description)) {
			return Result({
				_nay: { message: `Secret "${secret.name}" description must not contain control characters` },
			});
		}
	}
	// The converse is allowed: plugin.secrets.read without secrets[] stays valid for
	// already-published plugins that never declared their secret names.
	if (parsed.data.secrets.length > 0 && !capabilities.has("plugin.secrets.read" satisfies plugins_Capability)) {
		return Result({ _nay: { message: "Plugin secrets declarations require the plugin.secrets.read capability" } });
	}
	// A plugin that can write its own documents must also be able to read them back. Without the read
	// capability the workspace would consent to durable writes it can never see through the plugin.
	if (
		capabilities.has("plugin.data.write" satisfies plugins_Capability) &&
		!capabilities.has("plugin.data.read" satisfies plugins_Capability)
	) {
		return Result({ _nay: { message: "The plugin.data.write capability requires the plugin.data.read capability" } });
	}
	// Same rule for member writes through the app: a page that stores data the plugin can never
	// read back would ask the workspace to consent to writes with no visible product behind them.
	if (
		capabilities.has("plugin.data.user-write" satisfies plugins_Capability) &&
		!capabilities.has("plugin.data.read" satisfies plugins_Capability)
	) {
		return Result({
			_nay: { message: "The plugin.data.user-write capability requires the plugin.data.read capability" },
		});
	}
	// This capability only picks the lock mode of the sealed upload door, so on its own it opens no
	// door at all. Without the write capability the workspace would consent to a lock the installation
	// can never reach.
	if (
		capabilities.has("workspace.files.create-read-only" satisfies plugins_Capability) &&
		!capabilities.has("workspace.files.write" satisfies plugins_Capability)
	) {
		return Result({
			_nay: {
				message: "The workspace.files.create-read-only capability requires the workspace.files.write capability",
			},
		});
	}
	// plugin.service.connect only lets an outside service borrow the capabilities the workspace
	// already granted this plugin. On its own it can obtain no scope at all, so the grant mint would
	// always refuse it. Reject that manifest at publish instead of letting the plugin install and
	// then fail the first time its page tries to connect.
	if (
		capabilities.has("plugin.service.connect" satisfies plugins_Capability) &&
		!capabilities.has("plugin.data.read" satisfies plugins_Capability) &&
		!capabilities.has("workspace.files.write" satisfies plugins_Capability)
	) {
		return Result({
			_nay: {
				message:
					"The plugin.service.connect capability requires the plugin.data.read or workspace.files.write capability",
			},
		});
	}
	// The two must agree in both directions, unlike `plugin.secrets.read` above. The `connect-src` of
	// every UI frame, page and file view alike, is built from this list. So a capability with an empty
	// list consents to nothing, and a list without the capability would open the frame's egress with no
	// consent text ever shown.
	if (
		capabilities.has("ui.outbound.fetch" satisfies plugins_Capability) &&
		parsed.data.uiOutboundOrigins.length === 0
	) {
		return Result({
			_nay: { message: "The ui.outbound.fetch capability requires at least one UI outbound origin" },
		});
	}
	if (parsed.data.uiOutboundOrigins.length > 0 && !capabilities.has("ui.outbound.fetch" satisfies plugins_Capability)) {
		return Result({ _nay: { message: "UI outbound origins require the ui.outbound.fetch capability" } });
	}
	// Endpoints live inside the backend block, so this first rule catches the capability declared
	// with no backend at all; the pair below then agrees in both directions like ui.outbound.fetch.
	if (capabilities.has("plugin.backend.invoke" satisfies plugins_Capability) && !parsed.data.backend) {
		return Result({ _nay: { message: "The plugin.backend.invoke capability requires a plugin backend" } });
	}
	if (capabilities.has("plugin.backend.invoke" satisfies plugins_Capability) && endpointIds.size === 0) {
		return Result({
			_nay: { message: "The plugin.backend.invoke capability requires at least one backend endpoint" },
		});
	}
	if (endpointIds.size > 0 && !capabilities.has("plugin.backend.invoke" satisfies plugins_Capability)) {
		return Result({ _nay: { message: "Backend endpoints require the plugin.backend.invoke capability" } });
	}
	// Own-access only creates and releases locks on files own-write maintains, so on its own it
	// would consent to authority over files this plugin can never produce.
	if (
		capabilities.has("workspace.files.own-access" satisfies plugins_Capability) &&
		!capabilities.has("workspace.files.own-write" satisfies plugins_Capability)
	) {
		return Result({
			_nay: {
				message: "The workspace.files.own-access capability requires the workspace.files.own-write capability",
			},
		});
	}
	// Own-write is a narrower door on the same file surface, and keeping the base capability
	// visible keeps the consent honest.
	if (
		capabilities.has("workspace.files.own-write" satisfies plugins_Capability) &&
		!capabilities.has("workspace.files.write" satisfies plugins_Capability)
	) {
		return Result({
			_nay: { message: "The workspace.files.own-write capability requires the workspace.files.write capability" },
		});
	}
	if (parsed.data.service && !capabilities.has("plugin.service.connect" satisfies plugins_Capability)) {
		return Result({ _nay: { message: "Plugin service declarations require the plugin.service.connect capability" } });
	}
	// Each declared service scope needs the capability that gates it at exchange time, so the
	// consent screens never promise a scope the exchange would refuse.
	for (const scope of parsed.data.service?.scopes ?? []) {
		const requiredCapability: plugins_Capability =
			scope === "plugin_data:read"
				? "plugin.data.read"
				: scope === "plugin_data:write"
					? "plugin.data.write"
					: "workspace.files.write";
		if (!capabilities.has(requiredCapability)) {
			return Result({
				_nay: { message: `The ${scope} service scope requires the ${requiredCapability} capability` },
			});
		}
	}

	if (
		parsed.data.userWritableCollections !== undefined &&
		!capabilities.has("plugin.data.user-write" satisfies plugins_Capability)
	) {
		return Result({
			_nay: { message: "User-writable collections require the plugin.data.user-write capability" },
		});
	}
	return Result({ _yay: parsed.data });
}

// #endregion manifest

// #region file view matching

/**
 * List every plugin file view that matches a file's content type. The result is ordered by
 * installation creation time, so the tab order in the files UI stays stable and does not depend
 * on query order. A manifest rejects duplicate content types across its file views, so each
 * plugin contributes at most one match.
 */
export function plugins_list_file_view_matches<
	Plugin extends { installationCreatedAt: number; fileViews: { contentTypes: string[] }[] },
>(plugins: Plugin[] | undefined, contentType: string | undefined) {
	if (!plugins || !contentType) {
		return [];
	}

	const matches: { plugin: Plugin; fileView: Plugin["fileViews"][number]; contentType: string }[] = [];
	for (const plugin of plugins) {
		const fileView = plugin.fileViews.find((item) => item.contentTypes.includes(contentType));
		if (fileView) {
			matches.push({ plugin, fileView, contentType });
		}
	}
	matches.sort((a, b) => a.plugin.installationCreatedAt - b.plugin.installationCreatedAt);
	return matches;
}

// #endregion file view matching
