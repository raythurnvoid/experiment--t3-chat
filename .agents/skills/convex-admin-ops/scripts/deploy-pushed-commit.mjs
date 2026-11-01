// Usage: vp env exec node deploy-pushed-commit.mjs <empty folder outside the repo> [--push]
// Pushes origin/main to the dev deployment from a clean worktree, so other agents' uncommitted
// edits in the shared checkout never reach the server. See "Push Only A Pushed Commit" in
// convex-admin-ops/SKILL.md. Without --push it only builds and removes the worktree.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../../..");
const dir = process.argv[2];
const push = process.argv.includes("--push");
if (!dir || !path.isAbsolute(dir) || fs.existsSync(dir) || path.resolve(dir).startsWith(repo + path.sep)) {
	console.error("Pass an absolute folder that does not exist yet and is outside the repo.");
	process.exit(1);
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// pnpm is a .cmd file on Windows, so it needs a shell. No argument here has spaces.
const pnpm = (args, env) => spawnSync(`pnpm ${args}`, { cwd: dir, shell: true, encoding: "utf8", env });

git(repo, "fetch", "-q", "origin");
git(repo, "worktree", "add", "--detach", dir, "origin/main");
let exitCode = 0;
try {
	// Clone only the workspace submodules, from the local checkout's git dirs, so there is no network fetch.
	// Submodule names can differ from their paths (`novel` is `packages/app/vendor/novel`).
	//
	// `.gitmodules` lists `packages/app/vendor/novel` under two names, and git may read either one. This
	// config is shared by all worktrees, so an old run can leave a wrong URL under the other name. Set
	// every URL first, then update.
	const subPaths = [];
	for (const line of git(dir, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$").split("\n")) {
		const [key, subPath] = line.split(" ");
		if (!/^packages\/app\/vendor\/|^packages\/native-popovers$/.test(subPath)) continue;
		const name = key.replace(/^submodule\./, "").replace(/\.path$/, "");
		git(dir, "config", `submodule.${name}.url`, git(path.join(repo, subPath), "rev-parse", "--absolute-git-dir"));
		subPaths.push(subPath);
	}
	for (const subPath of new Set(subPaths)) {
		git(dir, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--", subPath);
	}

	const install = pnpm("install --frozen-lockfile");
	if (install.status !== 0) throw new Error(`pnpm install failed:\n${install.stdout}${install.stderr}`);

	// If origin/main moved during the install, this push would take the newer code off the server.
	git(dir, "fetch", "-q", "origin");
	const head = git(dir, "rev-parse", "HEAD");
	if (head !== git(dir, "rev-parse", "origin/main")) throw new Error("origin/main moved. Run the script again.");
	console.log(`worktree ready at ${head.slice(0, 8)}`);

	if (push) {
		// A fresh worktree has no .env.local, so the CLI prints "Provisioned a dev deployment" and writes one
		// for the deployment named here. That is expected and goes away with the worktree.
		const result = pnpm("--dir packages/app exec convex dev --once --typecheck disable", {
			...process.env,
			CONVEX_DEPLOYMENT: "dev:grand-finch-267",
		});
		const output = `${result.stdout}${result.stderr}`;
		console.log(output);
		if (result.status !== 0 || !output.includes("Convex functions ready!")) throw new Error("Push failed.");
		// Another branch may have added these on the server. Find its owner before the next push.
		const deleted = output.split("\n").filter((outputLine) => /Deleted/i.test(outputLine));
		if (deleted.length) {
			console.error(`Check these deletions before you continue:\n${deleted.join("\n")}`);
			exitCode = 2;
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	exitCode = 1;
} finally {
	// rmdir removes the pnpm junctions without following them into the store. Right after the install, a
	// scanner can still hold a few new files open, so the first try can leave folders behind.
	for (let attempt = 0; attempt < 5 && fs.existsSync(dir); attempt++) {
		if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
		spawnSync("cmd", ["/c", "rmdir", "/s", "/q", dir]);
	}
	if (fs.existsSync(dir)) console.error(`Could not remove ${dir}. Run: cmd /c rmdir /s /q "${dir}"`);
	git(repo, "worktree", "prune");
}
process.exit(exitCode);
