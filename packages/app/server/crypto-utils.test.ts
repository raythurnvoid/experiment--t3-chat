import { afterEach, describe, expect, test, vi } from "vitest";
import {
	crypto_decrypt_secret_value,
	crypto_encrypt_secret_value,
	crypto_hmac_sha256_hex,
	crypto_open_cursor,
	crypto_seal_cursor,
} from "./crypto-utils.ts";

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

describe("crypto_seal_cursor", () => {
	const scope = '["caller",1]';
	const payload = { lastKey: { value: "/secret/salary.xlsx", createdAt: 1, nodeId: "node" } };

	test("opens only the unchanged cursor for the same scope", async () => {
		const cursor = await crypto_seal_cursor({ purpose: "files_list", scope, payload });
		expect(cursor).not.toContain("secret");
		expect(await crypto_open_cursor({ purpose: "files_list", scope, cursor })).toEqual(payload);

		const edited = `${cursor.slice(0, 10)}${cursor[10] === "A" ? "B" : "A"}${cursor.slice(11)}`;
		for (const [name, input] of [
			["other scope", { scope: '["caller",2]', cursor }],
			["edited", { scope, cursor: edited }],
			["cut", { scope, cursor: cursor.slice(0, 30) }],
			["old plain JSON", { scope, cursor: JSON.stringify({ scope, ...payload }) }],
		] as const) {
			expect(await crypto_open_cursor({ purpose: "files_list", ...input }), name).toBeNull();
		}
	});

	test("keeps the same length for short and long paths", async () => {
		const seal = (value: string) =>
			crypto_seal_cursor({
				purpose: "files_list",
				scope,
				payload: { lastKey: { createdAt: 1760000000000.123, nodeId: "k".repeat(32), value } },
			});
		expect((await seal("/a")).length).toBe((await seal(`/${"a".repeat(880)}`)).length);
	});

	test("seals a large full sort key without expanding all bytes into arguments", async () => {
		const largePayload = { lastKey: "a".repeat(256 * 1024) };
		const pending = crypto_seal_cursor({ purpose: "files_list", scope, payload: largePayload });
		await expect(pending, "A large full key must seal without an argument-count error").resolves.toMatch(/^c1\./);
		const cursor = await pending;
		expect(await crypto_open_cursor({ purpose: "files_list", scope, cursor })).toEqual(largePayload);
	});

	test("opens cursors of the previous secret after a rotation, and refuses an unknown secret", async () => {
		const cursor = await crypto_seal_cursor({ purpose: "files_list", scope, payload });

		// The module reads the secrets once at load, so load it again after each change.
		vi.resetModules();
		vi.stubEnv("LIST_CURSOR_SECRET_PREVIOUS", process.env.LIST_CURSOR_SECRET);
		vi.stubEnv("LIST_CURSOR_SECRET", "LIST_CURSOR_SECRET_ROTATED_AT_LEAST_32_CHARS");
		const rotated = await import("./crypto-utils.ts");
		expect(await rotated.crypto_open_cursor({ purpose: "files_list", scope, cursor })).toEqual(payload);

		vi.resetModules();
		vi.stubEnv("LIST_CURSOR_SECRET_PREVIOUS", "");
		const later = await import("./crypto-utils.ts");
		expect(await later.crypto_open_cursor({ purpose: "files_list", scope, cursor })).toBeNull();
	});

	test("fails to load without LIST_CURSOR_SECRET", async () => {
		vi.resetModules();
		vi.stubEnv("LIST_CURSOR_SECRET", "");
		await expect(import("./crypto-utils.ts")).rejects.toThrow("LIST_CURSOR_SECRET is not set");
	});

	test("fails to load with a short secret", async () => {
		vi.resetModules();
		vi.stubEnv("LIST_CURSOR_SECRET", "a".repeat(31));
		await expect(import("./crypto-utils.ts")).rejects.toThrow("LIST_CURSOR_SECRET must be at least 32 characters");

		vi.resetModules();
		vi.stubEnv("LIST_CURSOR_SECRET", "a".repeat(32));
		vi.stubEnv("LIST_CURSOR_SECRET_PREVIOUS", "b".repeat(31));
		await expect(import("./crypto-utils.ts")).rejects.toThrow(
			"LIST_CURSOR_SECRET_PREVIOUS must be at least 32 characters",
		);
	});
});
