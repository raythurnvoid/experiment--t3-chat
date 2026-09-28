import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size } from "./files.ts";
import {
	plugins_HTTP_HEADER_NAME_REGEX,
	plugins_MCP_SERVER_URL_SECRET_WORDS,
	plugins_validate_mcp_server_url,
	plugins_validate_secret_name,
	plugins_validate_secret_value,
} from "./plugins.ts";

// Parse the JSON config that other MCP hosts use (Claude Desktop and Code, Cursor, Windsurf, VS Code, Cline)
// for the "MCP servers" page. The browser runs it for the preview, and Convex runs it again on save.

export const mcp_custom_config_MAX_SERVERS = 10;
export const mcp_custom_config_MAX_TEXT_BYTES = 64 * 1024;

const MAX_NAME_LENGTH = 64;
const MAX_HEADERS = 8;
const MAX_SECRETS = 8;
const MAX_HEADER_VALUE_BYTES = 4 * 1024;

// Press sets these headers itself, or they change how the request is framed. Wider than the plugin
// manifest rule, because a paste can hold any header a host sends.
const RESERVED_HEADER_NAMES = new Set([
	"cookie",
	"host",
	"content-type",
	"accept",
	"content-length",
	"transfer-encoding",
	"connection",
]);
// Anything but tab and printable Latin-1: so control characters and characters above U+00FF. A line break
// in a header value could add a second header, and `fetch` refuses a header with a character above U+00FF
// (this includes half characters).
const HEADER_VALUE_INVALID_REGEX = /[^\t\x20-\x7e\xa0-\xff]/u;

/**
 * Placeholders, in priority order: the first alternative that matches wins.
 * `${...}` never reads any env. It only names a secret field.
 */
const PLACEHOLDER_REGEX =
	/\$\{secret:(?<secret>[^}]*)\}|\$\{input:(?<input>[^}]*)\}|\$\{\{\s*secrets\.(?<ci>[^}\s]*)\s*\}\}|\$\{(?:env:)?(?<env>[^}:]*)(?::-[^}]*)?\}|<(?<angle>[^<>]*)>|(?<![A-Za-z0-9])(?<your>(?:YOUR|your)[_-][A-Za-z0-9_-]*)/gu;
// Whole header words that mean "put your value here". They have no usable secret name.
const PLACEHOLDER_WORDS = new Set(["...", "xxx", "TOKEN_HERE", "REPLACE_ME", "changeme"]);

const STREAMABLE_HTTP_TYPES = new Set(["http", "streamable-http", "streamableHttp", "streamable_http"]);
// Keys Press reads on a remote entry. Every other key is ignored and listed on the card.
const REMOTE_ENTRY_KEYS = new Set(["type", "url", "serverUrl", "headers", "requestOptions"]);
// Keys of an `mcp-remote` wrapper entry. `env` only feeds the local program, so Press has no use for it.
const MCP_REMOTE_ENTRY_KEYS = new Set(["type", "command", "args", "env"]);
const MCP_REMOTE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);

const REFUSAL_NOT_OBJECT = "This entry is not a JSON object.";
const REFUSAL_NO_URL = "This entry has no server URL.";
const REFUSAL_SSE =
	"This entry uses the old SSE transport. Press supports only Streamable HTTP. Look for a URL that ends in /mcp.";
const REFUSAL_WS = "This entry uses WebSocket. Press supports only Streamable HTTP.";
const REFUSAL_UNKNOWN_TYPE = "This entry uses a transport Press does not support. Press supports only Streamable HTTP.";
const REFUSAL_COMMAND_AND_URL = "This entry has both a command and a URL. Keep only the URL.";
const REFUSAL_FILE = "Press cannot read files from your computer. Remove the ${file:...} reference.";
const REFUSAL_OAUTH_CLIENT = "Press signs in with its own OAuth client. Remove the OAuth client settings.";
const REFUSAL_KEY_IN_URL = "This server puts a key in its address. Press can only keep keys in headers.";
const REFUSAL_HEADER_NOT_TEXT = "Header values must be text.";
const REFUSAL_TOO_MANY_HEADERS = `A server can have at most ${MAX_HEADERS} headers.`;
const REFUSAL_TOO_MANY_SECRETS = `A server can have at most ${MAX_SECRETS} secrets.`;
const REFUSAL_MCP_REMOTE_SSE_ONLY =
	"This entry forces the old SSE transport (--transport sse-only). Press supports only Streamable HTTP.";
const REFUSAL_MCP_REMOTE_FLAGS = new Map([
	["--allow-http", "This entry allows plain http (--allow-http). Press connects only over https."],
	["--static-oauth-client-info", REFUSAL_OAUTH_CLIENT],
	["--static-oauth-client-metadata", REFUSAL_OAUTH_CLIENT],
	["--header-file", "Press cannot read files from your computer. Remove --header-file."],
]);

export type mcp_custom_config_DraftPart =
	| { kind: "text"; text: string }
	/**
	 * A URL placeholder. The member types plain text; it is stored in the URL, never secret.
	 */
	| { kind: "field"; fieldName: string; hint: string | null }
	/**
	 * A header secret. `prefill` is the pasted literal value (null for a placeholder). `canBeText` is true for a
	 * literal value, so the "Not secret" switch is offered. `stored` is true for `${secret:NAME}` (Edit text): the
	 * value is already saved.
	 */
	| {
			kind: "secret";
			secretName: string;
			prefill: string | null;
			hint: string | null;
			canBeText: boolean;
			stored: boolean;
	  };

export type mcp_custom_config_Draft = {
	/**
	 * Stable key of the entry in the paste: its name in the server map, or "server" for one bare entry.
	 * Used to pick the draft again on save.
	 */
	key: string;
	/**
	 * Suggested name: the entry name, trimmed, cut to 64 characters.
	 */
	name: string;
	state: "ready" | "needs_values" | "refused";
	/**
	 * Fixed plain-English reason when state is "refused", else null.
	 */
	refusal: string | null;
	/**
	 * True when the entry was an `mcp-remote` wrapper and got turned into the remote form
	 * ("Use the remote server instead").
	 */
	convertedFromMcpRemote: boolean;
	/**
	 * Unknown keys on the entry, ignored and listed ("Ignored: autoApprove, timeout").
	 */
	ignoredKeys: string[];
	/**
	 * Only "text" and "field" parts.
	 */
	urlParts: mcp_custom_config_DraftPart[];
	/**
	 * Only "text" and "secret" parts.
	 */
	headers: Array<{ name: string; parts: mcp_custom_config_DraftPart[] }>;
};

/**
 * The member's choices for one draft.
 */
export type mcp_custom_config_Fill = {
	name: string;
	urlFields: Array<{ name: string; value: string }>;
	/**
	 * Header names whose literal value the member marked "Not secret".
	 */
	notSecretHeaders: string[];
	secretValues: Array<{ name: string; value: string }>;
	/**
	 * Secret names that already have a stored value (Edit). A missing typed value is fine for these.
	 */
	keptSecretNames: string[];
};

/**
 * The stored server shape (the Convex doc minus toolPrefix, auth, fingerprint, and bookkeeping).
 */
export type mcp_custom_config_Server = {
	name: string;
	url: string;
	headers: Array<{
		name: string;
		parts: Array<{ kind: "text"; text: string } | { kind: "secret"; secretName: string }>;
	}>;
};

function is_object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn a placeholder name into env key syntax: uppercase, other characters become `_`.
 */
function normalize_name(raw: string) {
	const name = raw.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
	return /^[0-9]/u.test(name) ? `_${name}` : name;
}

/**
 * Use the placeholder name when it has a letter or digit and is a valid secret name.
 * `...` or `<...>` has no usable name, so it gets the fallback.
 */
function to_secret_name(raw: string, fallback: string) {
	const name = normalize_name(raw);
	return /[A-Z0-9]/u.test(name) && !plugins_validate_secret_name(name)._nay ? name : fallback;
}

/**
 * Read one placeholder match: its raw name, whether it is a saved `${secret:NAME}`, and its hint.
 * Only a VS Code `${input:id}` has a hint: the input's description.
 */
function read_placeholder(match: RegExpMatchArray, inputHints: Map<string, string>) {
	const groups = match.groups ?? {};
	if (groups.secret !== undefined) {
		return { rawName: groups.secret, stored: true, hint: null };
	}

	if (groups.input !== undefined) {
		return { rawName: groups.input, stored: false, hint: inputHints.get(groups.input) ?? null };
	}

	return { rawName: groups.ci ?? groups.env ?? groups.angle ?? groups.your ?? "", stored: false, hint: null };
}

/**
 * Split a header value into text and secret parts.
 *
 * A placeholder takes its whole space-separated word: `fc-YOUR_API_KEY` is one secret, and `Bearer <token>`
 * keeps `Bearer ` as text. Only `${secret:NAME}` is exact, so the Edit text of a saved server comes back as it was.
 */
function parse_header_value(args: {
	value: string;
	headerName: string;
	draftName: string;
	inputHints: Map<string, string>;
}) {
	const { value, headerName, draftName, inputHints } = args;
	const fallbackName = normalize_name(`${draftName}_${headerName}`).slice(0, 128);
	const parts: mcp_custom_config_DraftPart[] = [];
	let text = "";

	const pushSecret = (secretName: string, hint: string | null, stored: boolean) => {
		if (text !== "") {
			parts.push({ kind: "text", text });
			text = "";
		}
		parts.push({ kind: "secret", secretName, prefill: null, hint, canBeText: false, stored });
	};

	for (const word of value.split(/( +)/u)) {
		const matches = [...word.matchAll(PLACEHOLDER_REGEX)];

		// Keep text around saved `${secret:NAME}` refs as text.
		if (matches.some((match) => match.groups?.secret !== undefined)) {
			let index = 0;
			for (const match of matches) {
				if (match.groups?.secret === undefined) {
					continue;
				}

				text += word.slice(index, match.index);
				pushSecret(to_secret_name(match.groups.secret, fallbackName), null, true);
				index = (match.index ?? 0) + match[0].length;
			}
			text += word.slice(index);
		} else if (matches.length > 0) {
			const placeholder = read_placeholder(matches[0], inputHints);
			pushSecret(to_secret_name(placeholder.rawName, fallbackName), placeholder.hint, false);
		} else if (PLACEHOLDER_WORDS.has(word)) {
			pushSecret(fallbackName, null, false);
		} else {
			text += word;
		}
	}

	if (parts.length > 0) {
		if (text !== "") {
			parts.push({ kind: "text", text });
		}
		return parts;
	}

	// No placeholder: the pasted value is a real secret. Keep the scheme word of a two-word
	// `Authorization` value (`Bearer abc123`) as text.
	const words = value.split(" ");
	const literalSecret = (prefill: string) =>
		({
			kind: "secret",
			secretName: fallbackName,
			prefill: prefill === "" ? null : prefill,
			hint: null,
			canBeText: true,
			stored: false,
		}) satisfies mcp_custom_config_DraftPart;
	if (headerName.toLowerCase() === "authorization" && words.length === 2 && words[0] !== "" && words[1] !== "") {
		return [{ kind: "text", text: `${words[0]} ` }, literalSecret(words[1])] satisfies mcp_custom_config_DraftPart[];
	}

	return [literalSecret(value)] satisfies mcp_custom_config_DraftPart[];
}

/**
 * Split a command line into words, keeping quoted text together.
 */
function split_command(command: string) {
	return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * Read an `npx mcp-remote <url>` wrapper. It only runs a local bridge to a remote server, so Press can call
 * that server directly. `_yay` is null when the command is not an `mcp-remote` wrapper.
 */
function parse_mcp_remote(tokens: string[]) {
	const runnerLength = MCP_REMOTE_RUNNERS.has(tokens[0] ?? "")
		? 1
		: (tokens[0] === "pnpm" || tokens[0] === "yarn") && tokens[1] === "dlx"
			? 2
			: 0;
	if (runnerLength === 0) {
		return Result({ _yay: null });
	}

	// Skip runner flags such as `-y`.
	let index = runnerLength;
	while (tokens[index]?.startsWith("-")) {
		index += 1;
	}
	if (!/^mcp-remote(@\S+)?$/u.test(tokens[index] ?? "")) {
		return Result({ _yay: null });
	}

	let url: string | null = null;
	const headers: Array<{ name: string; value: string }> = [];
	const rest = tokens.slice(index + 1);
	for (let restIndex = 0; restIndex < rest.length; restIndex += 1) {
		const token = rest[restIndex];
		const refusal = REFUSAL_MCP_REMOTE_FLAGS.get(token);
		if (refusal) {
			return Result({ _nay: { message: refusal } });
		}

		if (token === "--transport" && rest[restIndex + 1] === "sse-only") {
			return Result({ _nay: { message: REFUSAL_MCP_REMOTE_SSE_ONLY } });
		}

		// `--header "Name: value"`, also without a space after the colon.
		if (token === "--header") {
			restIndex += 1;
			const raw = rest[restIndex] ?? "";
			const colon = raw.indexOf(":");
			headers.push(
				colon === -1
					? { name: raw.trim(), value: "" }
					: { name: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() },
			);
		} else if (url === null && /^[a-z]+:\/\//iu.test(token)) {
			url = token;
		}
	}

	return Result({ _yay: url === null ? null : { url, headers } });
}

function parse_entry(key: string, value: unknown, inputHints: Map<string, string>): mcp_custom_config_Draft {
	const name = key.trim().slice(0, MAX_NAME_LENGTH);
	let convertedFromMcpRemote = false;
	let ignoredKeys: string[] = [];

	const refuse = (refusal: string): mcp_custom_config_Draft => ({
		key,
		name,
		state: "refused",
		refusal,
		convertedFromMcpRemote,
		ignoredKeys,
		urlParts: [],
		headers: [],
	});

	if (!is_object(value)) {
		return refuse(REFUSAL_NOT_OBJECT);
	}

	const entryText = JSON.stringify(value);
	if (entryText.includes("${file:")) {
		return refuse(REFUSAL_FILE);
	}

	// A static OAuth client: Cursor `auth.CLIENT_ID`, VS Code `oauth.clientId`, or a client secret anywhere.
	if (
		(is_object(value.auth) && "CLIENT_ID" in value.auth) ||
		(is_object(value.oauth) && "clientId" in value.oauth) ||
		entryText.includes("CLIENT_SECRET")
	) {
		return refuse(REFUSAL_OAUTH_CLIENT);
	}

	const entryUrl = value.url ?? value.serverUrl;
	let url: string;
	let rawHeaders: Array<{ name: string; value: string }> = [];

	// A command runs a program on the member's computer. Only an `mcp-remote` wrapper can become a remote server.
	if (value.command !== undefined) {
		if (entryUrl !== undefined) {
			return refuse(REFUSAL_COMMAND_AND_URL);
		}

		const command = typeof value.command === "string" ? value.command : "";
		const args = Array.isArray(value.args) ? value.args.filter((arg) => typeof arg === "string") : [];
		const mcpRemote = parse_mcp_remote([...split_command(command), ...args]);
		if (mcpRemote._nay) {
			return refuse(mcpRemote._nay.message);
		}

		if (mcpRemote._yay === null) {
			return refuse(
				`This server runs as a program on your computer (${[command, ...args].join(" ")}). ` +
					"Press can only use remote servers. Look in the server's docs for a remote URL.",
			);
		}

		convertedFromMcpRemote = true;
		ignoredKeys = Object.keys(value).filter((entryKey) => !MCP_REMOTE_ENTRY_KEYS.has(entryKey));
		url = mcpRemote._yay.url;
		rawHeaders = mcpRemote._yay.headers;
	} else {
		ignoredKeys = Object.keys(value).filter((entryKey) => !REMOTE_ENTRY_KEYS.has(entryKey));

		if (value.type === "sse") {
			return refuse(REFUSAL_SSE);
		}

		if (value.type === "ws") {
			return refuse(REFUSAL_WS);
		}

		if (value.type !== undefined && !STREAMABLE_HTTP_TYPES.has(String(value.type))) {
			return refuse(REFUSAL_UNKNOWN_TYPE);
		}

		if (typeof entryUrl !== "string") {
			return refuse(REFUSAL_NO_URL);
		}

		url = entryUrl;
		// Continue puts headers under `requestOptions.headers`.
		for (const headerObject of [value.headers, is_object(value.requestOptions) ? value.requestOptions.headers : null]) {
			for (const [headerName, headerValue] of Object.entries(is_object(headerObject) ? headerObject : {})) {
				if (typeof headerValue !== "string") {
					return refuse(REFUSAL_HEADER_NOT_TEXT);
				}
				rawHeaders.push({ name: headerName, value: headerValue });
			}
		}
	}

	// Header names.
	if (rawHeaders.length > MAX_HEADERS) {
		return refuse(REFUSAL_TOO_MANY_HEADERS);
	}
	const seenHeaderNames = new Set<string>();
	for (const header of rawHeaders) {
		const lowerName = header.name.toLowerCase();
		if (!plugins_HTTP_HEADER_NAME_REGEX.test(header.name)) {
			return refuse(`The header name "${header.name}" is not valid.`);
		}

		if (RESERVED_HEADER_NAMES.has(lowerName) || lowerName.startsWith("mcp-")) {
			return refuse(`Press sets the ${header.name} header itself. Remove it.`);
		}

		if (seenHeaderNames.has(lowerName)) {
			return refuse(`The header ${header.name} appears twice.`);
		}
		seenHeaderNames.add(lowerName);
	}

	// URL. A placeholder here becomes a plain field, because the URL is stored and shown to policy managers.
	const urlParts: mcp_custom_config_DraftPart[] = [];
	const urlFieldRawNames: string[] = [];
	let urlIndex = 0;
	let dummyUrl = "";
	for (const match of url.matchAll(PLACEHOLDER_REGEX)) {
		const placeholder = read_placeholder(match, inputHints);
		const textBefore = url.slice(urlIndex, match.index);
		if (textBefore !== "") {
			urlParts.push({ kind: "text", text: textBefore });
		}
		urlParts.push({
			kind: "field",
			fieldName: to_secret_name(placeholder.rawName, normalize_name(`${name}_URL`)),
			hint: placeholder.hint,
		});
		// A saved secret never belongs in the URL.
		urlFieldRawNames.push(placeholder.stored ? "secret" : placeholder.rawName);
		dummyUrl += `${textBefore}x`;
		urlIndex = (match.index ?? 0) + match[0].length;
	}
	if (urlIndex < url.length) {
		urlParts.push({ kind: "text", text: url.slice(urlIndex) });
		dummyUrl += url.slice(urlIndex);
	}

	// Check the URL with each field replaced by a safe dummy. `mcp_custom_config_build` checks it again
	// with the real values.
	const urlCheck = plugins_validate_mcp_server_url(dummyUrl);
	if (urlCheck._nay) {
		return refuse(urlCheck._nay.message);
	}

	if (
		urlFieldRawNames.some((rawName) => {
			const folded = rawName.toLowerCase().replaceAll(/[-_]/gu, "");
			// The same words as the URL query rule: a placeholder with one of them names a key.
			return plugins_MCP_SERVER_URL_SECRET_WORDS.some((word) => folded.includes(word));
		})
	) {
		return refuse(REFUSAL_KEY_IN_URL);
	}

	// Header values.
	const headers = rawHeaders.map((header) => ({
		name: header.name,
		parts: parse_header_value({ value: header.value, headerName: header.name, draftName: name, inputHints }),
	}));
	const secretParts = headers.flatMap((header) => header.parts.filter((part) => part.kind === "secret"));
	if (new Set(secretParts.map((part) => part.secretName)).size > MAX_SECRETS) {
		return refuse(REFUSAL_TOO_MANY_SECRETS);
	}

	// A pasted value gets a name made from the header name, so `X-Key` and `X_Key` get the same name. Two
	// parts with one name share one stored value, which is right only when a placeholder repeats.
	const clash = secretParts.find(
		(part) => part.canBeText && secretParts.filter((other) => other.secretName === part.secretName).length > 1,
	);
	if (clash) {
		return refuse(`Two headers use the secret name ${clash.secretName}. Rename one of them.`);
	}

	const needsValues =
		urlParts.some((part) => part.kind === "field") || secretParts.some((part) => part.prefill === null && !part.stored);

	return {
		key,
		name,
		state: needsValues ? "needs_values" : "ready",
		refusal: null,
		convertedFromMcpRemote,
		ignoredKeys,
		urlParts,
		headers,
	};
}

/**
 * Parse pasted MCP host config text into one draft per server.
 *
 * Broken JSON, a paste that is too big, and too many servers are whole-paste `errors` with no drafts.
 * A server Press cannot use is a draft with state "refused" and a fixed reason.
 */
export function mcp_custom_config_parse(text: string) {
	const drafts: mcp_custom_config_Draft[] = [];
	const errors: Array<{ offset: number; length: number; message: string }> = [];

	if (files_get_utf8_byte_size(text) > mcp_custom_config_MAX_TEXT_BYTES) {
		errors.push({ offset: 0, length: 0, message: "The text must be at most 64 KiB." });
		return { drafts, errors };
	}

	// JSONC: `//` comments and trailing commas are fine.
	const parseErrors: ParseError[] = [];
	const root: unknown = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		for (const parseError of parseErrors) {
			// "CommaExpected" becomes "Comma expected".
			const words = printParseErrorCode(parseError.error).replaceAll(/(?<=[a-z])(?=[A-Z])/gu, " ");
			errors.push({
				offset: parseError.offset,
				length: parseError.length,
				message: words.charAt(0) + words.slice(1).toLowerCase(),
			});
		}
		return { drafts, errors };
	}

	if (!is_object(root)) {
		errors.push({ offset: 0, length: text.length, message: "Paste a JSON object." });
		return { drafts, errors };
	}

	// Accepted shapes: `{ mcpServers }`, VS Code `{ servers, inputs }`, one bare entry, or a bare map of entries.
	const inputHints = new Map<string, string>();
	let servers: unknown = root;
	if ("mcpServers" in root) {
		servers = root.mcpServers;
	} else if ("servers" in root) {
		servers = root.servers;
		for (const input of Array.isArray(root.inputs) ? root.inputs : []) {
			if (is_object(input) && typeof input.id === "string" && typeof input.description === "string") {
				inputHints.set(input.id, input.description);
			}
		}
	} else if (["url", "serverUrl", "command", "type"].some((entryKey) => entryKey in root)) {
		servers = { server: root };
	}

	if (!is_object(servers) || Object.keys(servers).length === 0) {
		errors.push({ offset: 0, length: 0, message: "No MCP servers found in the text." });
		return { drafts, errors };
	}

	if (Object.keys(servers).length > mcp_custom_config_MAX_SERVERS) {
		errors.push({
			offset: 0,
			length: 0,
			message: `Paste at most ${mcp_custom_config_MAX_SERVERS} servers at a time.`,
		});
		return { drafts, errors };
	}

	for (const [key, value] of Object.entries(servers)) {
		drafts.push(parse_entry(key, value, inputHints));
	}

	return { drafts, errors };
}

/**
 * Turn a draft and the member's choices into the stored server and the secret values to save.
 */
export function mcp_custom_config_build(draft: mcp_custom_config_Draft, fill: mcp_custom_config_Fill) {
	if (draft.state === "refused") {
		return Result({ _nay: { message: draft.refusal ?? "Press cannot use this server." } });
	}

	const name = fill.name.trim();
	if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
		return Result({ _nay: { message: `Names must be 1 to ${MAX_NAME_LENGTH} characters.` } });
	}

	// URL.
	let urlText = "";
	for (const part of draft.urlParts) {
		if (part.kind === "text") {
			urlText += part.text;
		}

		if (part.kind === "field") {
			const value = fill.urlFields.find((field) => field.name === part.fieldName)?.value ?? "";
			if (value === "") {
				return Result({ _nay: { message: `Fill in ${part.fieldName}.` } });
			}

			if (/\s/u.test(value)) {
				return Result({ _nay: { message: `${part.fieldName} must not contain spaces.` } });
			}

			urlText += value;
		}
	}
	const url = plugins_validate_mcp_server_url(urlText);
	if (url._nay) {
		return Result({ _nay: { message: url._nay.message } });
	}

	// Headers.
	const headers: mcp_custom_config_Server["headers"] = [];
	const secretValues = new Map<string, string>();
	for (const header of draft.headers) {
		const notSecret = fill.notSecretHeaders.includes(header.name);
		const parts: mcp_custom_config_Server["headers"][number]["parts"] = [];
		const invalidValueMessage = `The ${header.name} value must be at most 4 KiB, with no line breaks and no characters beyond Latin-1.`;
		let text = "";

		for (const part of header.parts) {
			if (part.kind === "text") {
				text += part.text;
			}

			if (part.kind === "secret") {
				const typed = fill.secretValues.find((secretValue) => secretValue.name === part.secretName)?.value;
				const value = typed !== undefined && typed !== "" ? typed : part.prefill;

				if (
					value !== null &&
					(files_get_utf8_byte_size(value) > MAX_HEADER_VALUE_BYTES ||
						HEADER_VALUE_INVALID_REGEX.test(value) ||
						plugins_validate_secret_value(value)._nay)
				) {
					return Result({ _nay: { message: invalidValueMessage } });
				}

				// "Not secret" only applies to a pasted literal value, never to a placeholder.
				if (notSecret && part.canBeText) {
					if (value === null) {
						return Result({ _nay: { message: `Fill in ${header.name}.` } });
					}
					text += value;
					continue;
				}

				if (value === null && !fill.keptSecretNames.includes(part.secretName)) {
					return Result({ _nay: { message: `Fill in ${part.secretName}.` } });
				}

				if (text !== "") {
					parts.push({ kind: "text", text });
					text = "";
				}
				parts.push({ kind: "secret", secretName: part.secretName });
				// A kept secret with no typed value keeps its stored value, so it is not returned.
				if (value !== null) {
					secretValues.set(part.secretName, value);
				}
			}
		}
		if (text !== "") {
			parts.push({ kind: "text", text });
		}

		if (
			parts.some(
				(part) =>
					part.kind === "text" &&
					(files_get_utf8_byte_size(part.text) > MAX_HEADER_VALUE_BYTES || HEADER_VALUE_INVALID_REGEX.test(part.text)),
			)
		) {
			return Result({ _nay: { message: invalidValueMessage } });
		}

		headers.push({ name: header.name, parts });
	}

	return Result({
		_yay: {
			server: { name, url: url._yay, headers } satisfies mcp_custom_config_Server,
			secretValues: [...secretValues].map(([secretName, value]) => ({ name: secretName, value })),
		},
	});
}

/**
 * Canonical JSON for Edit, with `${secret:NAME}` refs and no values.
 *
 * A header with only text comes back from `mcp_custom_config_parse` as a prefilled secret that can be text.
 * Pass its name in `notSecretHeaders` to keep it as text.
 */
export function mcp_custom_config_to_text(server: mcp_custom_config_Server) {
	const entry: Record<string, unknown> = { type: "http", url: server.url };
	if (server.headers.length > 0) {
		entry.headers = Object.fromEntries(
			server.headers.map((header) => [
				header.name,
				header.parts.map((part) => (part.kind === "text" ? part.text : `\${secret:${part.secretName}}`)).join(""),
			]),
		);
	}

	return JSON.stringify({ mcpServers: { [server.name]: entry } }, null, "\t");
}
