import type { LiteralUnion } from "type-fest";
import { convex_error } from "./convex-utils.ts";

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

export async function crypto_sha256_hex(input: string | BufferSource) {
	const bytes = typeof input === "string" ? text_encoder.encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Constant-time for equal-length inputs: no partial-prefix match changes the timing. The loop
 * still walks the longer input, so comparing a caller-controlled probe against a raw secret can
 * leak the secret's length; callers guarding a secret should compare fixed-length digests (hash
 * both sides first) so length carries no information.
 */
export function crypto_timing_safe_equal(left: string, right: string) {
	const leftBytes = text_encoder.encode(left);
	const rightBytes = text_encoder.encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const maxLength = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < maxLength; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

/**
 * 32 bytes (256 random bits) is the right count for secrets.
 */
export function crypto_random_hex(byteCount: LiteralUnion<32, number>) {
	const bytes = new Uint8Array(byteCount);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

if (!process.env.PLUGIN_SECRETS_ENCRYPTION_KEY) {
	throw convex_error({ message: "PLUGIN_SECRETS_ENCRYPTION_KEY is not set in Convex env" });
}

/**
 * Each secret type uses its own key.
 */
type SecretKeyName =
	| "PLUGIN_SECRETS_ENCRYPTION_KEY"
	| "MCP_SECRETS_ENCRYPTION_KEY"
	| "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY";

const secret_crypto_key = ((/* iife */) => {
	async function value(keyName: SecretKeyName) {
		// Missing optional keys must affect only their own feature.
		const key = process.env[keyName];
		if (!key) {
			throw convex_error({ message: `${keyName} is not set in Convex env` });
		}

		const digest = await crypto.subtle.digest("SHA-256", text_encoder.encode(key));
		return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
	}

	const cache = new Map<SecretKeyName, ReturnType<typeof value>>();

	return function secret_crypto_key(keyName: SecretKeyName) {
		if (cache.has(keyName)) {
			return cache.get(keyName)!;
		}

		const result = value(keyName);
		cache.set(keyName, result);
		return result;
	};
})();

/**
 * AES-GCM additional data binds a ciphertext to its owning scope and name, so a
 * row copied onto another installation/publisher or renamed fails to decrypt.
 */
export async function crypto_encrypt_secret_value(args: {
	value: string;
	additionalData: string;
	keyName: SecretKeyName;
}) {
	const { value, additionalData, keyName } = args;

	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(keyName),
		text_encoder.encode(value),
	);
	return {
		ciphertext,
		nonce: nonce.buffer,
	};
}

export async function crypto_decrypt_secret_value(args: {
	secret: { ciphertext: ArrayBuffer; nonce: ArrayBuffer };
	additionalData: string;
	keyName: SecretKeyName;
}) {
	const { secret, additionalData, keyName } = args;

	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: secret.nonce, additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(keyName),
		secret.ciphertext,
	);
	return text_decoder.decode(plaintext);
}

if (!process.env.LIST_CURSOR_SECRET) {
	throw convex_error({ message: "LIST_CURSOR_SECRET is not set in Convex env" });
}
// 32 random bytes as hex is 64 characters. A short value is a typo or a weak secret.
if (process.env.LIST_CURSOR_SECRET.length < 32) {
	throw convex_error({ message: "LIST_CURSOR_SECRET must be at least 32 characters" });
}
const LIST_CURSOR_SECRET = process.env.LIST_CURSOR_SECRET;
/**
 * Optional. After a rotation, keep the old secret here for a while, so cursors sealed with it still open.
 */
const LIST_CURSOR_SECRET_PREVIOUS = process.env.LIST_CURSOR_SECRET_PREVIOUS || null;
if (LIST_CURSOR_SECRET_PREVIOUS && LIST_CURSOR_SECRET_PREVIOUS.length < 32) {
	throw convex_error({ message: "LIST_CURSOR_SECRET_PREVIOUS must be at least 32 characters" });
}

/**
 * Each cursor kind gets its own key, so a cursor of one kind never opens as another kind.
 */
type CursorPurpose = "files_list";

const cursor_crypto_keys = ((/* iife */) => {
	async function derive(purpose: CursorPurpose, secret: string) {
		const [kidDigest, keyDigest] = await Promise.all([
			crypto.subtle.digest("SHA-256", text_encoder.encode(`cursor_kid\0${secret}`)),
			crypto.subtle.digest("SHA-256", text_encoder.encode(`cursor\0${purpose}\0${secret}`)),
		]);
		return {
			// The first 4 bytes tell which secret sealed a cursor.
			kid: new Uint8Array(kidDigest).slice(0, 4),
			key: await crypto.subtle.importKey("raw", keyDigest, "AES-GCM", false, ["encrypt", "decrypt"]),
		};
	}

	async function value(purpose: CursorPurpose) {
		return {
			current: await derive(purpose, LIST_CURSOR_SECRET),
			previous: LIST_CURSOR_SECRET_PREVIOUS ? await derive(purpose, LIST_CURSOR_SECRET_PREVIOUS) : null,
		};
	}

	const cache = new Map<CursorPurpose, ReturnType<typeof value>>();

	return function cursor_crypto_keys(purpose: CursorPurpose) {
		if (cache.has(purpose)) {
			return cache.get(purpose)!;
		}

		const result = value(purpose);
		cache.set(purpose, result);
		return result;
	};
})();

/**
 * Seal a page cursor with AES-GCM, so the caller can neither read nor change it. A cursor can point
 * at a doc the caller may not read, so its key must never leave the server as plain text. The scope
 * is bound as additional data: the cursor opens only for the same caller and the same request.
 */
export async function crypto_seal_cursor(args: { purpose: CursorPurpose; scope: string; payload: unknown }) {
	const { purpose, scope, payload } = args;

	const { current } = await cursor_crypto_keys(purpose);
	const json = text_encoder.encode(JSON.stringify(payload));
	// Pad with spaces to a multiple of 1 KiB. The JSON around the path is about 100 bytes, so the cursor
	// length does not tell how long a hidden path is, up to about 900 bytes.
	const plaintext = new Uint8Array(Math.ceil(json.length / 1024) * 1024).fill(0x20);
	plaintext.set(json);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: text_encoder.encode(`${purpose}\0${scope}`) },
		current.key,
		plaintext,
	);

	const bytes = new Uint8Array(4 + 12 + ciphertext.byteLength);
	bytes.set(current.kid);
	bytes.set(nonce, 4);
	bytes.set(new Uint8Array(ciphertext), 16);
	const base64url = btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	return `c1.${base64url}`;
}

/**
 * Open a cursor from `crypto_seal_cursor`. Answer `null` for any cursor we did not seal for this
 * purpose and scope: an edited or cut cursor, an old plain JSON cursor, or one sealed with a secret
 * we no longer have.
 */
export async function crypto_open_cursor(args: { purpose: CursorPurpose; scope: string; cursor: string }) {
	const { purpose, scope, cursor } = args;

	if (!/^c1\.[A-Za-z0-9_-]+$/.test(cursor)) return null;
	const keys = await cursor_crypto_keys(purpose);
	try {
		const base64 = cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/");
		const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
			char.charCodeAt(0),
		);
		// Key id, nonce, and the 16-byte GCM tag. A shorter cursor was cut.
		if (bytes.length < 4 + 12 + 16) return null;
		const kid = bytes.subarray(0, 4);
		const sealer = [keys.current, keys.previous].find((item) => item?.kid.every((byte, index) => byte === kid[index]));
		if (!sealer) return null;

		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes.subarray(4, 16), additionalData: text_encoder.encode(`${purpose}\0${scope}`) },
			sealer.key,
			bytes.subarray(16),
		);
		return JSON.parse(text_decoder.decode(plaintext)) as unknown;
	} catch {
		// Bad base64, a short cursor, or a failed GCM tag check.
		return null;
	}
}

/**
 * Keep link fingerprints separate from encryption and other HMAC uses.
 */
export async function crypto_hmac_sha256_hex(args: { value: string; purpose: string; keyName: SecretKeyName }) {
	const { value, purpose, keyName } = args;

	const secret = process.env[keyName];
	if (!secret) {
		throw convex_error({ message: `${keyName} is not set in Convex env` });
	}
	const digest = await crypto.subtle.digest("SHA-256", text_encoder.encode(`${purpose}\0${secret}`));
	const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, text_encoder.encode(value));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
