import {
	createCommandContext,
	InMemoryFs,
	MountableFs,
	type CommandContext,
	type CommandName,
} from "just-bash/browser";
import { describe, expect, test, vi } from "vitest";
import { bash_delegate_native_just_bash_tmp_command } from "./bash-delegate.ts";
import type { bash_DbFilesFs, bash_DbFilesRoots } from "./bash-utils.ts";

const teamPath = "/home/cloud-usr/w/team/work";
const personalPath = "/home/cloud-usr/w/personal/home";

function byte_string(value: string) {
	// This fixture uses ASCII, so each character is already one byte.
	return value as unknown as CommandContext["stdin"];
}

function create_runner(cwd = teamPath) {
	const teamFs = new InMemoryFs({ "/docs/readme.txt": "team secret\n" });
	const personalFs = new InMemoryFs({ "/docs/readme.txt": "personal secret\n" });
	// The delegate uses only root paths. Readable mounts prove it refuses access before storage.
	const roots: bash_DbFilesRoots = {
		app: { currentWorkspacePath: teamPath, fs: teamFs as unknown as bash_DbFilesFs },
		personal: { currentWorkspacePath: personalPath, fs: personalFs as unknown as bash_DbFilesFs },
		externalMounts: { currentWorkspacePath: "/.mounts", mounts: new Map() },
		plugins: { currentWorkspacePath: "/.plugins", mounts: new Map() },
	};
	const base = new InMemoryFs({ "/tmp/input.txt": "beta\nalpha\n", "/dev/zero": "\0".repeat(32), "/dev/null": "" });
	const writeFile = base.writeFile.bind(base);
	// The mounted base owns device behavior; the delegate only controls access.
	vi.spyOn(base, "writeFile").mockImplementation(async (path, content, options) => {
		if (path !== "/dev/null") await writeFile(path, content, options);
	});
	const fs = new MountableFs({
		base,
		mounts: [
			{ mountPoint: teamPath, filesystem: teamFs },
			{ mountPoint: personalPath, filesystem: personalFs },
		],
	});
	const run = (command: CommandName, args: string[], stdin = "") =>
		bash_delegate_native_just_bash_tmp_command(
			command,
			args,
			createCommandContext({ fs, cwd, stdin: byte_string(stdin) }),
			roots,
		);
	return { fs, roots, run };
}

describe("bash_delegate_native_just_bash_tmp_command", () => {
	describe.each([teamPath, personalPath])("app root %s", (rootPath) => {
		test.each(["du", "diff", "rg", "ln"] as const)(
			"%s refuses direct app operands with the matching root",
			async (command) => {
				const { fs, run } = create_runner();
				const path = `${rootPath}/docs/readme.txt`;
				const original = await fs.readFile(path);
				const args =
					command === "rg"
						? ["secret", path]
						: command === "ln"
							? ["-s", path, "/tmp/link"]
							: command === "diff"
								? [path, "/tmp/input.txt"]
								: [path];
				const result = await run(command, args);

				expect(result.exitCode).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
				expect(result.stderr).toContain("For app path '/docs/readme.txt'");
				expect(result.stderr).toContain(`cp ${path} /tmp/<name>`);
				expect(result.stderr).not.toContain("<path>");
				if (command === "rg") expect(result.stderr).toContain(`Try: grep secret ${path}`);
				if (command === "du") expect(result.stderr).toContain(`Try: stat ${path} && find ${path}`);
				expect(await fs.readFile(path)).toBe(original);
				expect(await fs.exists("/tmp/link")).toBe(false);
			},
		);

		test("names a refused relative read without treating the sed script as a path", async () => {
			const { fs, run } = create_runner(`${rootPath}/docs`);
			expect(await fs.readFile(`${rootPath}/docs/readme.txt`)).toContain("secret");
			const result = await run("sed", ["s/a/b/", "readme.txt"]);

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
			expect(result.stderr).toContain(`'${rootPath}/docs/readme.txt'`);
			expect(result.stderr).toContain("For app path '/docs/readme.txt'");
			expect(result.stderr).not.toContain("/s/a/b/");
		});

		test("names the refused app cwd when du has no operand", async () => {
			const { run } = create_runner(`${rootPath}/docs`);
			const result = await run("du", []);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
			expect(result.stderr).toContain("For app path '/docs'");
		});

		test("refuses binary reads and names the matching root", async () => {
			const { run } = create_runner();
			const result = await run("base64", [`${rootPath}/docs/readme.txt`]);

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
		});

		test("does not let a scratch operand hide a refused app read", async () => {
			const { run } = create_runner();
			expect(await run("sed", ["s/alpha/ALPHA/", "/tmp/input.txt"])).toMatchObject({
				exitCode: 0,
				stdout: "beta\nALPHA\n",
				stderr: "",
			});
			const result = await run("sed", ["s/alpha/ALPHA/", "/tmp/input.txt", `${rootPath}/docs/readme.txt`]);

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
			expect(result.stderr).toContain("For app path '/docs/readme.txt'");
		});

		test("refuses native writes without changing the app file", async () => {
			const { fs, run } = create_runner();
			const path = `${rootPath}/docs/readme.txt`;
			const original = await fs.readFile(path);
			const result = await run("sort", ["-o", path, "/tmp/input.txt"]);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain(`The app file tree at '${rootPath}' is db-backed`);
			expect(await fs.readFile(path)).toBe(original);
		});

		test("keeps scratch files, stdin, and zero/null devices usable from the app cwd", async () => {
			const { fs, run } = create_runner(rootPath);
			expect(await run("sort", ["-o", "/tmp/sorted.txt", "/tmp/input.txt"])).toMatchObject({ exitCode: 0, stderr: "" });
			expect(await fs.readFile("/tmp/sorted.txt")).toBe("alpha\nbeta\n");
			expect(await run("sort", [], "beta\nalpha\n")).toMatchObject({
				exitCode: 0,
				stdout: "alpha\nbeta\n",
				stderr: "",
			});
			expect(await run("head", ["-c", "5", "/dev/zero"])).toMatchObject({
				exitCode: 0,
				stdout: "\0".repeat(5),
				stderr: "",
			});
			expect(await run("tee", ["/dev/null"], "discarded\n")).toMatchObject({
				exitCode: 0,
				stdout: "discarded\n",
				stderr: "",
			});
			expect(await run("cat", ["/dev/null"])).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
		});

		test("does not add app guidance to bad durations, options, or missing scratch files", async () => {
			const { run } = create_runner(rootPath);
			const results = [
				await run("sleep", ["abc"]),
				await run("rev", ["--bogus"]),
				await run("sed", ["s/a/b/", "/tmp/missing"]),
				await run("rg", ["--bogus", "secret", "/tmp/input.txt"]),
			];
			expect(results[0].stderr).toContain("invalid time interval");
			for (const result of results) {
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).not.toContain("db-backed");
				expect(result.stderr).not.toContain("cannot access app files directly");
			}
		});
	});

	test.each([
		`${personalPath}-other/docs/readme.txt`,
		`${teamPath}-other/docs/readme.txt`,
		`${personalPath}/../other/docs/readme.txt`,
	])("refuses outside path %s without naming either app root", async (path) => {
		const { fs, run } = create_runner();
		await fs.mkdir(fs.resolvePath(path, ".."), { recursive: true });
		await fs.writeFile(path, "outside secret\n");
		const result = await run("sort", [path]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("db-backed");
		expect(result.stderr).not.toContain("cannot access app files directly");
		expect(await fs.readFile(path)).toBe("outside secret\n");
	});

	test("keeps the current-root guard when no separate personal root is mounted", async () => {
		const { roots, run } = create_runner();
		roots.personal = null;
		const result = await run("du", [teamPath]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(`The app file tree at '${teamPath}' is db-backed`);
	});
});
