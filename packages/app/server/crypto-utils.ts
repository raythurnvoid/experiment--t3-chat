import { Result } from "../shared/errors-as-values-utils.ts";
import { plugins_SECRET_VALUE_MAX_BYTES, plugins_validate_secret_name } from "../shared/plugins.ts";
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

if (!process.env.PLUGIN_SECRETS_ENCRYPTION_KEY) {
	throw convex_error({ message: "PLUGIN_SECRETS_ENCRYPTION_KEY is not set in Convex env" });
}

const PLUGIN_SECRETS_ENCRYPTION_KEY = process.env.PLUGIN_SECRETS_ENCRYPTION_KEY;

const secret_crypto_key = ((/* iife */) => {
	let keyPromise: Promise<CryptoKey> | undefined;

	return function secret_crypto_key() {
		keyPromise ??= (async () => {
			const digest = await crypto.subtle.digest("SHA-256", text_encoder.encode(PLUGIN_SECRETS_ENCRYPTION_KEY));
			return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
		})();
		return keyPromise;
	};
})();

export function crypto_validate_secret_input(args: { name: string; value: string }) {
	const name = plugins_validate_secret_name(args.name);
	if (name._nay) {
		return Result({ _nay: { message: name._nay.message } });
	}
	if (text_encoder.encode(args.value).byteLength > plugins_SECRET_VALUE_MAX_BYTES) {
		return Result({ _nay: { message: "Secret value is too large" } });
	}
	return Result({ _yay: { name: name._yay, value: args.value } });
}

/**
 * AES-GCM additional data binds a ciphertext to its owning scope and name, so a
 * row copied onto another installation/publisher or renamed fails to decrypt.
 */
export async function crypto_encrypt_secret_value(value: string, additionalData: string) {
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(),
		text_encoder.encode(value),
	);
	return {
		ciphertext,
		nonce: nonce.buffer,
	};
}

export async function crypto_decrypt_secret_value(
	secret: { ciphertext: ArrayBuffer; nonce: ArrayBuffer },
	additionalData: string,
) {
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: secret.nonce, additionalData: text_encoder.encode(additionalData) },
		await secret_crypto_key(),
		secret.ciphertext,
	);
	return text_decoder.decode(plaintext);
}
