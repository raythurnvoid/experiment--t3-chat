import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import {
	create_bash_runner,
	drain_scheduled_continuations,
	get_seeded_node_id,
	test_db_files_mount,
} from "./bash.setup.test.ts";

const restricted_mount = "/home/cloud-usr/w/type-team/home";

async function create_restricted_runner(level: "read" | "write" = "read", withDraft = false) {
	const t = test_convex();
	const seeded = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "type-team", workspaceName: "home" }),
	);
	const owner = await create_bash_runner({
		shared: { t, seeded },
		extraFiles: [
			{ path: "/typed/a-locked/open/deep.dat", contentType: "image/png", withoutYjsState: true },
			{ path: "/typed/b-locked/notes.txt", content: "notes" },
			{ path: "/typed/z-hit.dat", contentType: "image/png", withoutYjsState: true },
		],
	});
	const member = await owner.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "type-find-member" });
		await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: owner.seeded.organizationId,
			workspaceId: owner.seeded.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: owner.seeded.organizationId,
			workspaceId: owner.seeded.workspaceId,
			userId,
			role: "member",
			now: Date.now(),
		});
		return { userId, membershipId };
	});
	const runner = await create_bash_runner({ shared: { t: owner.t, seeded: { ...owner.seeded, ...member } } });
	if (withDraft) {
		const draft = await runner.run({ command: `echo draft > ${restricted_mount}/typed/a-locked/open/draft.txt` });
		expect(draft.metadata.exitCode, draft.stderr).toBe(0);
		await drain_scheduled_continuations(runner);
	}
	const asOwner = owner.t.withIdentity({ issuer: "https://clerk.test", external_id: owner.seeded.userId });
	for (const path of ["/typed/a-locked", "/typed/b-locked"]) {
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: owner.seeded.membershipId,
			nodeId: await get_seeded_node_id(owner, path),
		});
		expect(restricted._nay).toBeUndefined();
		for (let round = 0; round < 4; round++) await drain_scheduled_continuations(owner);
	}
	const shared = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
		membershipId: owner.seeded.membershipId,
		nodeId: await get_seeded_node_id(owner, "/typed/a-locked/open"),
		principal: { kind: "user", userId: member.userId },
		level,
	});
	expect(shared._nay).toBeUndefined();
	for (let round = 0; round < 4; round++) await drain_scheduled_continuations(owner);
	return runner;
}

describe("bash_run_command", () => {
	describe("find --content-type", () => {
		test.each([false, true])("stops before a draft under a locked folder (moved: %s)", async (moved) => {
			const runner = await create_restricted_runner("write", true);
			if (moved) {
				const move = await runner.run({ command: `mv ${restricted_mount}/typed ${restricted_mount}/moved` });
				expect(move.metadata.exitCode, move.stderr).toBe(0);
			}
			await drain_scheduled_continuations(runner);
			const root = `${restricted_mount}/${moved ? "moved" : "typed"}`;
			const direct = await runner.run({ command: `find ${root}/a-locked/open --content-type text/` });
			expect(direct.metadata.exitCode, direct.stderr).toBe(0);
			expect(direct.stdout).toBe(`${root}/a-locked/open/draft.txt\n`);
			const result = await runner.run({ command: `find ${root} --content-type text/` });
			expect(result.stdout).not.toContain("draft.txt");
			expect(result.stderr).toBe(
				"0 matches.\n" +
					["a-locked", "b-locked"].map((name) => `find: '${root}/${name}': Permission denied\n`).join(""),
			);
			expect(result.metadata.exitCode).toBe(1);
		});

		test("stops at locked folders but allows an exact start inside a deep share", async () => {
			const runner = await create_restricted_runner();
			const exact = await runner.run({ command: `find ${restricted_mount}/typed/a-locked/open --content-type image/` });
			expect(exact.metadata.exitCode, exact.stderr).toBe(0);
			expect(exact.stdout).toBe(`${restricted_mount}/typed/a-locked/open/deep.dat\n`);
			const result = await runner.run({ command: `find ${restricted_mount}/typed --content-type image/` });
			expect.soft(result.stdout).toBe(`${restricted_mount}/typed/z-hit.dat\n`);
			expect.soft(result.stderr).toBe(
				["a-locked", "b-locked"]
					.map((name) => `find: '${restricted_mount}/typed/${name}': Permission denied\n`)
					.join(""),
			);
			expect.soft(result.metadata.exitCode).toBe(1);
		});

		test("pages and replays locked folder errors when the MIME type has no matches", async () => {
			const runner = await create_restricted_runner();
			let command = `find ${restricted_mount}/typed --content-type application/x-not-present --limit 1`;
			const denied: string[] = [];
			for (let page = 0; command && page < 10; page++) {
				const result = await runner.run({ command });
				const paths = result.stdout.split("\n").filter((line) => line.startsWith(restricted_mount));
				const errors = result.stderr.split("\n").filter((line) => line.startsWith("find: "));
				expect(paths).toEqual([]);
				expect(errors.length).toBeLessThanOrEqual(1);
				expect(result.metadata.exitCode).toBe(errors.length ? 1 : 0);
				denied.push(...errors);
				if (command.includes("--cursor")) {
					const replay = await runner.run({ command });
					expect(replay.stdout).toBe(result.stdout);
					expect(replay.metadata.exitCode).toBe(result.metadata.exitCode);
					expect(replay.stderr.replace(/Next page: .+/u, "Next page")).toBe(
						result.stderr.replace(/Next page: .+/u, "Next page"),
					);
				}
				command = result.stderr.match(/Next page: (.+)/u)?.[1] ?? "";
			}
			expect(command).toBe("");
			expect(denied).toEqual(
				["a-locked", "b-locked"].map((name) => `find: '${restricted_mount}/typed/${name}': Permission denied`),
			);
		});

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
				command = result.stderr.match(/Next page: (.+)/u)?.[1] ?? "";
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
				command = result.stderr.match(/Next page: (.+)/u)?.[1] ?? "";
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
				expect(result.stderr).toBe("0 matches.\n");
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
