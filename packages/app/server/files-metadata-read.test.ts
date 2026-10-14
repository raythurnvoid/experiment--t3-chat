import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { api, internal } from "../convex/_generated/api.js";
import { test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_metadata_stringify_entries_yaml } from "../shared/files-metadata.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { create_bash_runner, get_seeded_node } from "./bash.setup.test.ts";

const page_schema = z.object({
	fields: z.array(z.string()),
	values: z.array(
		z.object({
			valueIndex: z.number(),
			field: z.string(),
			valueKind: z.string(),
			value: z.union([z.string(), z.number(), z.boolean()]).optional(),
			fragment: z.string().optional(),
			offset: z.number().optional(),
			totalLength: z.number().optional(),
		}),
	),
	isDone: z.boolean(),
	continueCursor: z.string().nullable(),
});

describe("full metadata reads", () => {
	test("Bash and the table action read full saved values while search keeps a short copy", async () => {
		const runner = await create_bash_runner();
		const node = await get_seeded_node(runner, "/docs/readme.md");
		const value = "x".repeat(32 * 1024 - 4) + "TAIL";
		const asUser = runner.t.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId });
		expect(
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: runner.seeded.membershipId,
				fileNodeId: node._id,
				metadataYaml: files_metadata_stringify_entries_yaml([{ key: "description", value }]),
			}),
		).toEqual({ _yay: null });
		const result = await runner.run({ command: "meta get docs/readme.md --format json --field metadata.description" });
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(page_schema.parse(JSON.parse(result.stdout))).toMatchObject({
			isDone: true,
			continueCursor: null,
			values: [{ field: "metadata.description", value, valueKind: "string", valueIndex: 0 }],
		});
		const full = await asUser.action(api.files_metadata_node.get_full_field_values, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: node._id },
			field: "metadata.description",
			cursor: null,
		});
		if (full._nay) throw new Error(full._nay.message);
		expect(page_schema.parse(JSON.parse(full._yay.json)).values[0]?.value).toBe(value);
		const index = await runner.t.query(internal.files_metadata.get_index_values_by_path, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			path: "/docs/readme.md",
		});
		expect(index?.values[0]?.stringValue).toHaveLength(1025);
	});

	test("separate Bash pages join escaped values exactly and stay inside the output page size", async () => {
		const runner = await create_bash_runner();
		const value = "\0".repeat(32 * 1024 - 8) + "😀TAIL";
		expect(
			(
				await runner.t.mutation(internal.files_metadata.update_entries_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					userId: runner.seeded.userId,
					path: "/docs/readme.md",
					set: [{ key: "description", value }],
					remove: [],
				})
			)._nay,
		).toBeUndefined();
		let command: string | null = "meta get docs/readme.md --format json --field metadata.description";
		let joined = "";
		let pages = 0;
		while (command !== null) {
			if (++pages > 100) throw new Error("Expected full metadata pages to finish");
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).toBe(0);
			expect(files_get_utf8_byte_size(result.stdout + result.stderr)).toBeLessThanOrEqual(64 * 1024);
			const page = page_schema.parse(JSON.parse(result.stdout));
			for (const fragment of page.values) {
				expect(fragment.valueIndex).toBe(0);
				expect(fragment.offset).toBe(joined.length);
				expect(fragment.totalLength).toBe(value.length);
				expect(fragment.fragment).toBeDefined();
				joined += fragment.fragment!;
				expect(joined.endsWith("\ud83d")).toBe(false);
			}
			command = result.stderr.startsWith("Next page: ") ? result.stderr.slice("Next page: ".length).trim() : null;
			expect(page.isDone).toBe(command === null);
			expect(page.continueCursor === null).toBe(command === null);
		}
		expect(pages).toBeGreaterThan(1);
		expect(joined, "The full value includes its last characters").toBe(value);
	});

	test("frontmatter keeps distinct long array tails and escaped lone surrogates", async () => {
		const prefix = "x".repeat(1025);
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/full.md",
					nonCollaborative: true,
					content: `---\ntags: ["${prefix}ONE", "${prefix}TWO"]\nescaped: "\\uD800"\n---\nBody\n`,
				},
			],
		});
		const result = await runner.run({ command: "meta get full.md --format json" });
		expect(result.metadata.exitCode).toBe(0);
		const page = page_schema.parse(JSON.parse(result.stdout));
		expect(page.isDone).toBe(true);
		expect(page.values.filter((item) => item.field === "frontmatter.tags").map((item) => item.value)).toEqual([
			prefix + "ONE",
			prefix + "TWO",
		]);
		expect(page.values.find((item) => item.field === "frontmatter.escaped")?.value).toBe("\ud800");
	});

	test("large frontmatter pages keep emoji pairs whole", async () => {
		const value = "😀".repeat(20000) + "TAIL";
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/emoji.md",
					nonCollaborative: true,
					content: `---\nmessage: ${value}\n---\nBody\n`,
				},
			],
		});
		let command: string | null = "meta get emoji.md --format json --field frontmatter.message";
		let joined = "";
		while (command !== null) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).toBe(0);
			expect(files_get_utf8_byte_size(result.stdout + result.stderr)).toBeLessThanOrEqual(64 * 1024);
			for (const fragment of page_schema.parse(JSON.parse(result.stdout)).values) {
				expect(fragment.offset).toBe(joined.length);
				expect(fragment.fragment!.startsWith("\ude00")).toBe(false);
				expect(fragment.fragment!.endsWith("\ud83d")).toBe(false);
				joined += fragment.fragment!;
			}
			command = result.stderr.startsWith("Next page: ") ? result.stderr.slice("Next page: ".length).trim() : null;
		}
		expect(joined).toBe(value);
	});

	test("a full metadata field skips file text and stale cursors refuse a mixed version", async () => {
		const runner = await create_bash_runner();
		const args = {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			path: "/docs/readme.md",
			remove: [],
		};
		expect(
			(
				await runner.t.mutation(internal.files_metadata.update_entries_by_path, {
					...args,
					set: [{ key: "description", value: "\0".repeat(32000) }],
				})
			)._nay,
		).toBeUndefined();
		const start = await runner.run({ command: "meta get docs/readme.md --format json --field metadata.description" });
		expect(start.metadata.exitCode).toBe(0);
		const next = start.stderr.slice("Next page: ".length).trim();
		expect(next).toContain("--cursor");
		expect(
			runner.runAction.mock.calls.some(
				([ref]) =>
					getFunctionName(ref as Parameters<typeof getFunctionName>[0]) ===
					"files_nodes_content:get_file_last_available_text_content_by_path",
			),
		).toBe(false);
		expect(
			(
				await runner.t.mutation(internal.files_metadata.update_entries_by_path, {
					...args,
					set: [{ key: "description", value: "revised" }],
				})
			)._nay,
		).toBeUndefined();
		const changed = await runner.run({ command: next });
		expect(changed.metadata.exitCode).toBe(1);
		expect(changed.stdout).toBe("");
		expect(changed.stderr).toContain("File changed. Start a new read.");
	});

	test("the table action refuses unauthenticated and foreign targets", async () => {
		const runner = await create_bash_runner();
		const node = await get_seeded_node(runner, "/docs/readme.md");
		const args = {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved" as const, id: node._id },
			field: "metadata.description",
			cursor: null,
		};
		expect(await runner.t.action(api.files_metadata_node.get_full_field_values, args)).toEqual({
			_nay: { message: "Unauthenticated" },
		});
		const second = await runner.t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = runner.t.withIdentity({ issuer: "https://clerk.test", external_id: second.userId });
		expect(
			await asUser.action(api.files_metadata_node.get_full_field_values, {
				...args,
				membershipId: second.membershipId,
			}),
		).toEqual({ _nay: { message: "Not found" } });
	});
});
