import { afterEach, describe, expect, test, vi } from "vitest";
import { crypto_decrypt_secret_value, crypto_encrypt_secret_value, crypto_hmac_sha256_hex } from "./crypto-utils.ts";

afterEach(() => vi.unstubAllEnvs());

describe("crypto_encrypt_secret_value", () => {
	test("remote secrets open only in their original scope", async () => {
		vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", "remote-test-key");
		const encrypted = await crypto_encrypt_secret_value({
			value: "private-share",
			additionalData: "connection:owner:workspace",
			keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
		});
		expect(
			await crypto_decrypt_secret_value({
				secret: encrypted,
				additionalData: "connection:owner:workspace",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).toBe("private-share");
		await expect(
			crypto_decrypt_secret_value({
				secret: encrypted,
				additionalData: "connection:other-owner:workspace",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).rejects.toThrow();
		await expect(
			crypto_decrypt_secret_value({
				secret: encrypted,
				additionalData: "connection:owner:other-workspace",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).rejects.toThrow();
	});
});

describe("crypto_hmac_sha256_hex", () => {
	test("the same link has a stable private fingerprint", async () => {
		vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", "remote-test-key");
		const first = await crypto_hmac_sha256_hex({
			value: "a".repeat(32),
			purpose: "playwriter-link",
			keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
		});
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await crypto_hmac_sha256_hex({
				value: "a".repeat(32),
				purpose: "playwriter-link",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).toBe(first);
		expect(
			await crypto_hmac_sha256_hex({
				value: "b".repeat(32),
				purpose: "playwriter-link",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).not.toBe(first);
	});

	test("key rotation and a different purpose change the fingerprint", async () => {
		vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", "remote-test-key");
		const first = await crypto_hmac_sha256_hex({
			value: "a".repeat(32),
			purpose: "playwriter-link",
			keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
		});
		expect(
			await crypto_hmac_sha256_hex({
				value: "a".repeat(32),
				purpose: "other-purpose",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).not.toBe(first);
		vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", "rotated-test-key");
		expect(
			await crypto_hmac_sha256_hex({
				value: "a".repeat(32),
				purpose: "playwriter-link",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).not.toBe(first);
	});

	test("missing remote configuration fails only remote fingerprinting", async () => {
		vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", undefined);
		await expect(
			crypto_hmac_sha256_hex({
				value: "a".repeat(32),
				purpose: "playwriter-link",
				keyName: "BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
			}),
		).rejects.toThrow("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY");
		const encrypted = await crypto_encrypt_secret_value({
			value: "plugin-secret",
			additionalData: "plugin",
			keyName: "PLUGIN_SECRETS_ENCRYPTION_KEY",
		});
		expect(
			await crypto_decrypt_secret_value({
				secret: encrypted,
				additionalData: "plugin",
				keyName: "PLUGIN_SECRETS_ENCRYPTION_KEY",
			}),
		).toBe("plugin-secret");
	});
});
