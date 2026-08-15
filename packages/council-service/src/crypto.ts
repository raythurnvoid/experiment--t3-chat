/**
 * Hashing, HMAC, token generation, and at-rest encryption for the Council Worker.
 *
 * The rule every caller leans on: no raw token, code, ticket, or guest email is ever stored or
 * logged. D1 holds hashes for lookups, a keyed HMAC for the two-hour join-retry window, and
 * AES-GCM ciphertext for the few provider/Convex secrets the service must be able to present
 * again. All key material derives from `COUNCIL_ROOM_COOKIE_SECRET` with a purpose label, so one
 * deployed secret backs every derived key without any key ever being reused across purposes.
 */

const encoder = new TextEncoder();

function to_hex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function from_base64(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function to_base64(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export async function council_sha256_hex(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return to_hex(new Uint8Array(digest));
}

/**
 * A 256-bit random token as 64 hex characters. Used for join codes, tickets, session tokens, and
 * CSRF tokens; only the SHA-256 of the value is stored.
 */
export function council_random_token() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return to_hex(bytes);
}

async function derive_key_bytes(secret: string, purpose: string) {
	// One deployed secret, one derived key per purpose. SHA-256 over secret + label is enough here:
	// the secret is already high-entropy, so a KDF's stretching would add cost without adding safety.
	return await crypto.subtle.digest("SHA-256", encoder.encode(`${secret}\u0000council\u0000${purpose}`));
}

/**
 * Keyed HMAC of a normalized guest email. Stored for two hours so a retried join is recognized as
 * the same person; the plaintext email is discarded after this is computed.
 */
export async function council_email_hmac(secret: string, normalizedEmail: string) {
	const keyBytes = await derive_key_bytes(secret, "email-hmac");
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(normalizedEmail));
	return to_hex(new Uint8Array(signature));
}

async function encryption_key(secret: string) {
	const keyBytes = await derive_key_bytes(secret, "at-rest-encryption");
	return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt a secret for D1 at-rest storage. The result is base64 of `iv || ciphertext`; a D1 read
 * alone is not the secret, because the key never leaves the Worker's environment.
 */
export async function council_encrypt(secret: string, plaintext: string) {
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const key = await encryption_key(secret);
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return to_base64(combined);
}

export async function council_decrypt(secret: string, encrypted: string) {
	const combined = from_base64(encrypted);
	const iv = combined.slice(0, 12);
	const key = await encryption_key(secret);
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined.slice(12));
	return new TextDecoder().decode(plaintext);
}

/**
 * Verify the provider's RSA-SHA256 webhook signature over the exact raw body bytes. The PEM is the
 * SPKI public key the deployment configures; a body parsed before this returns true is a bug.
 */
export async function council_verify_rsa_signature(args: {
	publicKeyPem: string;
	signatureBase64: string;
	// The concrete ArrayBuffer-backed shape WebCrypto's BufferSource requires under TS 5.7 generics.
	bodyBytes: Uint8Array<ArrayBuffer>;
}) {
	const pemBody = args.publicKeyPem
		.replace("-----BEGIN PUBLIC KEY-----", "")
		.replace("-----END PUBLIC KEY-----", "")
		.replace(/\s+/gu, "");
	try {
		const key = await crypto.subtle.importKey(
			"spki",
			from_base64(pemBody),
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, from_base64(args.signatureBase64), args.bodyBytes);
	} catch {
		// A malformed key or signature is a refusal, not a crash: the caller answers 401 either way.
		return false;
	}
}
