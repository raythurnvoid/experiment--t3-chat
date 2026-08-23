import { describe, expect, test } from "vitest";

import {
	council_decrypt,
	council_email_hmac,
	council_encrypt,
	council_random_token,
	council_verify_rsa_signature,
} from "./crypto.ts";
import { make_test_rsa } from "../test/rsa.ts";

describe("council_encrypt", () => {
	test("round-trips, and the ciphertext alone is not the secret", async () => {
		const encrypted = await council_encrypt("secret", "psg_the_grant_token");
		expect(encrypted).not.toContain("psg_the_grant_token");
		expect(await council_decrypt("secret", encrypted)).toBe("psg_the_grant_token");
	});

	test("a different deployment secret cannot decrypt", async () => {
		const encrypted = await council_encrypt("secret", "value");
		await expect(council_decrypt("other-secret", encrypted)).rejects.toThrow();
	});

	test("picks a new nonce every time, so one key never encrypts twice under the same IV", async () => {
		// One AES-GCM key is derived per purpose from the deployment secret, and every at-rest secret
		// shares it: grant tokens and provider participant tokens. Reusing a nonce under one AES-GCM
		// key breaks both confidentiality and forgery resistance, so a fixed IV is not a small bug.
		// Round-tripping cannot see this — encrypt/decrypt works fine with a constant nonce — so
		// compare two encryptions of the same plaintext instead.
		const first = await council_encrypt("secret", "psg_the_grant_token");
		const second = await council_encrypt("secret", "psg_the_grant_token");
		expect(first).not.toBe(second);
		expect(await council_decrypt("secret", first)).toBe("psg_the_grant_token");
		expect(await council_decrypt("secret", second)).toBe("psg_the_grant_token");
	});
});

describe("council_email_hmac", () => {
	test("is deterministic per secret and never contains the email", async () => {
		const first = await council_email_hmac("secret", "person@example.com");
		expect(first).toBe(await council_email_hmac("secret", "person@example.com"));
		expect(first).not.toContain("person");
		expect(first).not.toBe(await council_email_hmac("other", "person@example.com"));
	});
});

describe("council_random_token", () => {
	test("is 64 hex characters — 256 bits", () => {
		const token = council_random_token();
		expect(token).toMatch(/^[0-9a-f]{64}$/u);
		expect(token).not.toBe(council_random_token());
	});
});

describe("council_verify_rsa_signature", () => {
	test("accepts the right key and body, refuses a wrong key", async () => {
		const rsa = await make_test_rsa();
		const otherRsa = await make_test_rsa();
		const body = new TextEncoder().encode('{"event":"x"}');
		const signature = await rsa.sign(body);

		expect(
			await council_verify_rsa_signature({ publicKeyPem: rsa.publicKeyPem, signatureBase64: signature, bodyBytes: body }),
		).toBe(true);
		expect(
			await council_verify_rsa_signature({
				publicKeyPem: otherRsa.publicKeyPem,
				signatureBase64: signature,
				bodyBytes: body,
			}),
		).toBe(false);
	});

	test("a malformed key or signature refuses instead of crashing", async () => {
		const body = new TextEncoder().encode("{}");
		expect(
			await council_verify_rsa_signature({ publicKeyPem: "not a pem", signatureBase64: "AAAA", bodyBytes: body }),
		).toBe(false);
	});
});
