import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import {
	create_bash_runner,
	get_seeded_node_id,
	test_db_files_mount,
	test_r2_objects,
} from "../server/bash.setup.test.ts";

describe("saved-only public reads", () => {
	test.each(["content", "create", "move", "delete", "replacement"] as const)(
		"keeps saved text, bytes, type and revision despite a pending %s",
		async (change) => {
			const text = "saved café\n";
			const binary = "saved\0bytes";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/saved.txt", content: text, contentType: "text/plain;charset=utf-8" },
					{ path: "/saved.bin", content: binary, contentType: "application/octet-stream" },
					{ path: "/source.json", content: '{"private":true}\n', contentType: "application/json" },
					{ path: "/source.png", content: "private bytes", contentType: "image/png" },
				],
			});
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = test_r2_objects.get(args.sourceKey);
				if (!body) return { outcome: "source_missing" as const };
				test_r2_objects.set(args.destinationKey, body.slice());
				return { outcome: "copied" as const, size: body.byteLength };
			});
			const token = "c".repeat(64);
			await runner.t.mutation(internal.public_api.create_grant, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				threadId: null,
				principalKey: "saved-reader",
				tokenHash: await crypto_sha256_hex(token),
				scopes: ["files:list", "files:read", "files:download"],
				pathPrefix: null,
				now: Date.now(),
			});
			const request = (route: string, body: Record<string, unknown>) =>
				runner.t.fetch(`/api/v1/files/${route}`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			const read_bytes = (path: string, revision: string | null = null) =>
				request("read-bytes", { path, offset: 0, length: 100, revision });
			const nodeId = await get_seeded_node_id(runner, "/saved.txt");
			const revisions = new Map<string, string>();
			for (const path of ["/saved.txt", "/saved.bin"]) {
				const response = await read_bytes(path);
				expect(response.status).toBe(200);
				const revision = response.headers.get("X-File-Revision");
				expect(revision).toMatch(/^[0-9a-f]{64}$/u);
				revisions.set(path, revision!);
			}
			const mount = test_db_files_mount;
			const commands = {
				content: [`printf 'private text' > ${mount}/saved.txt`],
				create: [
					`printf 'private text' > ${mount}/draft.txt`,
					`cp ${mount}/source.png ${mount}/draft.png`,
				],
				move: [
					`mv ${mount}/saved.txt ${mount}/moved.txt`,
					`mv ${mount}/saved.bin ${mount}/moved.bin`,
				],
				delete: [`rm ${mount}/saved.txt ${mount}/saved.bin`],
				replacement: [
					`cp ${mount}/source.json ${mount}/saved.txt`,
					`cp ${mount}/source.png ${mount}/saved.bin`,
				],
			};
			for (const command of commands[change]) {
				const proposed = await runner.run({ command });
				expect(proposed.metadata.exitCode, proposed.output).toBe(0);
			}
			const single = await request("read", { path: "/saved.txt" });
			expect(single.status, "pending changes must not hide the saved text path").toBe(200);
			expect(await single.json(), "grants must read saved text").toEqual({
				path: "/saved.txt",
				target: { kind: "saved", id: nodeId },
				content: text,
			});
			const many = await request("read-many", { paths: ["/saved.txt", "/missing.txt"] });
			expect(await many.json()).toEqual({
				files: [{ path: "/saved.txt", target: { kind: "saved", id: nodeId }, content: text }],
				errors: [{ path: "/missing.txt", message: "File not found or exceeds the read limit." }],
				truncated: false,
			});
			for (const [path, content, contentType] of [
				["/saved.txt", text, "text/plain;charset=utf-8"],
				["/saved.bin", binary, "application/octet-stream"],
			]) {
				const response = await read_bytes(path, revisions.get(path)!);
				expect(response.status, "pending changes must not alter the saved byte revision").toBe(200);
				expect(await response.text(), "grants must read saved bytes").toBe(content);
				expect(response.headers.get("X-File-Content-Type"), "grants must read the saved type").toBe(contentType);
				expect(response.headers.get("X-File-Revision")).toBe(revisions.get(path));
			}
			for (const path of ["/draft.txt", "/draft.png", "/moved.txt", "/moved.bin"]) {
				expect((await request("read", { path })).status).toBe(404);
				expect((await read_bytes(path)).status).toBe(404);
			}
		},
	);
});

describe("public_api_http_read_file", () => {
	test("returns a whole saved file over 128 KB, while read-many keeps its item cap", async () => {
		const text = "a saved line of text\n".repeat(10_000);
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/big.txt", content: text, contentType: "text/plain;charset=utf-8" }],
		});
		const token = "d".repeat(64);
		await runner.t.mutation(internal.public_api.create_grant, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			threadId: null,
			principalKey: "big-reader",
			tokenHash: await crypto_sha256_hex(token),
			scopes: ["files:read"],
			pathPrefix: null,
			now: Date.now(),
		});
		const request = (route: string, body: Record<string, unknown>) =>
			runner.t.fetch(`/api/v1/files/${route}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

		const single = await request("read", { path: "/big.txt" });
		expect(single.status, "a file under the text limit must be readable").toBe(200);
		expect(((await single.json()) as { content: string }).content).toBe(text);

		const many = await request("read-many", { paths: ["/big.txt"] });
		expect(await many.json()).toEqual({
			files: [],
			errors: [{ path: "/big.txt", message: "File not found or exceeds the read limit." }],
			truncated: false,
		});
	});
});
