import { describe, expect, test } from "vitest";
import { create_bash_runner, drain_scheduled_continuations, test_db_files_mount } from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	describe("find --content-type", () => {
		test("merges drafts and moved shared subtrees into one alphabetical order", async () => {
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/mixed/b.txt", content: "b" },
					{ path: "/mixed/z.txt", content: "z" },
					{ path: "/source/d.txt", content: "d" },
				],
			});
			const changed = await runner.run({
				command: "echo a > mixed/a.txt; echo c > mixed/c.txt; mv source mixed/moved",
			});
			expect(changed.metadata.exitCode, changed.stderr).toBe(0);
			await drain_scheduled_continuations(runner);
			let command = "find mixed --content-type text/ --limit 1";
			const paths: string[] = [];
			for (let page = 0; command && page < 60; page++) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				paths.push(...result.stdout.split("\n").filter((line) => line.startsWith(test_db_files_mount)));
				command = result.stdout.match(/Next page: (.+)/u)?.[1] ?? "";
			}
			expect(command).toBe("");
			expect(paths).toEqual(
				["a.txt", "b.txt", "c.txt", "moved/d.txt", "z.txt"].map((path) => `${test_db_files_mount}/mixed/${path}`),
			);
			const movedRoot = await runner.run({ command: "find mixed/moved --content-type text/" });
			expect(movedRoot.metadata.exitCode, movedRoot.stderr).toBe(0);
			expect(movedRoot.stdout).toBe(`${test_db_files_mount}/mixed/moved/d.txt\n`);
		});

		test("matches MIME metadata and keeps alphabetical order across native pages", async () => {
			const files = Array.from({ length: 37 }, (_, index) => ({
				path: `/typed/${String(index).padStart(2, "0")}.dat`,
				content: "file",
				contentType: "image/png; version=1",
				withoutYjsState: true,
			}));
			const runner = await create_bash_runner({
				extraFiles: [
					...files,
					{ path: "/typed/not-a-png.png", content: "text", contentType: "text/plain" },
					{ path: "/outside.png", content: "file", contentType: "image/png", withoutYjsState: true },
				],
			});
			let command = "find typed --content-type=IMAGE/PNG --limit 5";
			const paths: string[] = [];
			for (let page = 0; command && page < 60; page++) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				paths.push(...result.stdout.split("\n").filter((line) => line.startsWith(test_db_files_mount)));
				command = result.stdout.match(/Next page: (.+)/u)?.[1] ?? "";
			}
			expect(command).toBe("");
			expect(paths).toEqual(files.map((file) => `${test_db_files_mount}${file.path}`));
		});

		test("checks exact files, directory-only operands, and unknown types", async () => {
			const runner = await create_bash_runner();
			const matching = await runner.run({ command: "find source.pdf --content-type application/" });
			expect(matching.metadata.exitCode, matching.stderr).toBe(0);
			expect(matching.stdout).toBe(`${test_db_files_mount}/source.pdf\n`);
			for (const command of [
				"find source.pdf --content-type text/plain",
				"find docs --content-type text/ -type d",
				"find docs --content-type application/x-not-present",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe("0 matches.\n");
			}
		});

		test("refuses unsupported scopes and predicates before running native find", async () => {
			const runner = await create_bash_runner();
			for (const command of [
				"find /tmp --content-type text/",
				"find /.mounts --content-type text/",
				"find /.plugins --content-type text/",
				"find docs --content-type text/ --content-type text/plain",
				"find docs --content-type '*.png'",
				"find docs --content-type text/ -name '*.md'",
				"find docs --content-type text/ -maxdepth 1",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode, command).toBe(2);
				expect(result.stdout).toBe("");
			}
		});
	});
});
