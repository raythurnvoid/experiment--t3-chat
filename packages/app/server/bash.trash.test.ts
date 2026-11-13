import { describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with, test_move_nodes } from "../convex/setup.test.ts";
import {
	test_db_files_mount,
	create_bash_runner,
	default_organization_files,
	drain_scheduled_continuations,
	get_seeded_node,
	get_seeded_node_id,
	list_pending_updates,
	list_pending_updates_for_node,
	push_unsaved_rich_text_edit,
	readme_seed_content,
	runner_as_user,
} from "./bash.setup.test.ts";
import * as resolver from "./files-visible-resolve.ts";

type Runner = Awaited<ReturnType<typeof create_bash_runner>>;

/**
 * Move items to Trash the way the user does in Files. A small delete ends inside the request.
 */
async function archive(runner: Runner, paths: string[]) {
	const nodeIds = await Promise.all(paths.map((path) => get_seeded_node_id(runner, path)));
	const archived = await runner_as_user(runner).mutation(api.files_nodes.archive_nodes, {
		membershipId: runner.seeded.membershipId,
		nodeIds,
	});
	expect(archived._nay).toBeUndefined();
	// A folder moves to Trash in a background job.
	await drain_scheduled_continuations(runner);
	for (const nodeId of nodeIds) expect((await read_node(runner, nodeId)).archiveOperationId).not.toBeNull();
	return { nodeIds, activityId: archived._yay?.activityId ?? null };
}

async function read_node(runner: Runner, nodeId: Id<"files_nodes">) {
	return (await runner.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
}

/**
 * The rows of a text `trash ls`, each split into its columns.
 */
function rows_of(stdout: string) {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

const team_mount = "/home/cloud-usr/w/trash-team/home";

/**
 * An owner runner in a team workspace with the default files. Each member's own workspace is named
 * `personal`, so the team workspace needs another name.
 */
async function create_team_runner(extraFiles: Array<{ path: string; content: string; withoutYjsState: true }> = []) {
	const t = test_convex();
	const seeded = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "trash-team", workspaceName: "home" }),
	);
	return await create_bash_runner({
		shared: { t, seeded },
		extraFiles: [...default_organization_files, ...extraFiles],
	});
}

/**
 * Add a workspace member (or a guest, without a role) to the runner's workspace, with their own chat.
 */
async function add_member(runner: Runner, args: { clerkUserId: string; role: "member" | null }) {
	const member = await runner.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: args.clerkUserId });
		await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
			displayName: "",
			sortDisplayName: "",
		});
		if (args.role)
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId,
				role: args.role,
				now: Date.now(),
			});
		return { userId, membershipId };
	});
	return await create_bash_runner({ shared: { t: runner.t, seeded: { ...runner.seeded, ...member } } });
}

async function restrict(runner: Runner, path: string) {
	const restricted = await runner_as_user(runner).mutation(api.files_sharing.restrict_node, {
		membershipId: runner.seeded.membershipId,
		nodeId: await get_seeded_node_id(runner, path),
	});
	expect(restricted._nay).toBeUndefined();
	await drain_scheduled_continuations(runner);
}

describe("bash_run_command", () => {
	describe("trash ls", () => {
		test("lists the user's own rm first, then the saved Trash", async () => {
			const runner = await create_bash_runner();
			const summaryId = await get_seeded_node_id(runner, "/reports/summary.md");
			const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
			await archive(runner, ["/reports/summary.md"]);
			expect((await runner.run({ command: "rm docs/readme.md" })).metadata.exitCode).toBe(0);

			const listed = await runner.run({ command: "trash ls" });

			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			const rows = rows_of(listed.stdout);
			expect(rows.map((row) => row.slice(1))).toEqual([
				["file", "you", `${readmeId}:pending`, `${test_db_files_mount}/docs/readme.md (pending delete)`],
				[
					"file",
					"you",
					`${summaryId}:${(await read_node(runner, summaryId)).archiveOperationId}`,
					`${test_db_files_mount}/reports/summary.md`,
				],
			]);
			expect(listed.stderr).toContain(`Trash of '${test_db_files_mount}'`);
		});

		test("pages the pending deletes of one area without reading the other areas", async () => {
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/Team/a.md", content: "a\n", withoutYjsState: true },
					{ path: "/Team/b.md", content: "b\n", withoutYjsState: true },
					...Array.from({ length: 60 }, (_, index) => ({
						path: `/bulk/f${index}.md`,
						content: "x\n",
						withoutYjsState: true,
					})),
				],
			});
			await restrict(runner, "/Team");
			const teamId = await get_seeded_node_id(runner, "/Team");
			expect((await runner.run({ command: "rm Team/a.md Team/b.md" })).metadata.exitCode).toBe(0);
			// More newer deletes in the open area than one page.
			const removed = await runner.run({
				command: `rm ${Array.from({ length: 60 }, (_, index) => `bulk/f${index}.md`).join(" ")}`,
			});
			expect(removed.metadata.exitCode, removed.stderr).toBe(0);

			const listed = await runner.run({ command: "trash ls Team --limit 2" });

			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(rows_of(listed.stdout).map((row) => row[4])).toEqual([
				`${test_db_files_mount}/Team/b.md (pending delete)`,
				`${test_db_files_mount}/Team/a.md (pending delete)`,
			]);
			expect(listed.stderr).toContain("Next page: trash ls Team --limit 2 --cursor");
			const pendingAreas = (await list_pending_updates(runner)).map((row) => row.pendingArchive?.area);
			expect(pendingAreas.filter((area) => area === teamId)).toHaveLength(2);
			expect(pendingAreas.filter((area) => area === null)).toHaveLength(60);
		});

		test("lists only the items of the same delete inside a deleted folder, page by page", async () => {
			const runner = await create_bash_runner();
			const docsId = await get_seeded_node_id(runner, "/docs");
			// An earlier delete of one file inside the folder. It is its own Trash item.
			await archive(runner, ["/docs/tutorial.md"]);
			await archive(runner, ["/docs"]);
			const id = `${docsId}:${(await read_node(runner, docsId)).archiveOperationId}`;

			const paths: string[] = [];
			let command = `trash ls --in ${id} --limit 1`;
			for (let page = 0; page < 5; page++) {
				const listed = await runner.run({ command });
				expect(listed.metadata.exitCode, listed.stderr).toBe(0);
				paths.push(...rows_of(listed.stdout).map((row) => row[4]));
				const next = /Next page: (.*)\n/.exec(listed.stderr);
				if (!next) break;
				command = next[1];
			}

			expect(paths).toEqual([`${test_db_files_mount}/docs/nested/`, `${test_db_files_mount}/docs/readme.md`]);
		});

		test("prints the path of the agent's view after a draft move of the folder", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "mv docs renamed && rm renamed/readme.md" })).metadata.exitCode).toBe(0);

			const listed = await runner.run({ command: "trash ls" });
			const restored = await runner.run({ command: "trash restore renamed/readme.md" });

			expect(rows_of(listed.stdout).map((row) => row[4])).toEqual([
				`${test_db_files_mount}/renamed/readme.md (pending delete)`,
			]);
			expect(restored.metadata.exitCode, restored.stderr).toBe(0);
		});

		test("gives each pending row its own path read limit", async () => {
			const paths = Array.from({ length: 8 }, (_, index) => `/deep${index}/a/b/f.md`);
			const runner = await create_bash_runner({
				extraFiles: paths.map((path) => ({ path, content: "x\n", withoutYjsState: true })),
			});
			const removed = await runner.run({ command: `rm ${paths.map((path) => path.slice(1)).join(" ")}` });
			expect(removed.metadata.exitCode, removed.stderr).toBe(0);
			// Lower the limit of one path lookup, so these shallow rows cost more than one limit together.
			const create = resolver.files_visible_resolve_db_create;
			const spy = vi
				.spyOn(resolver, "files_visible_resolve_db_create")
				.mockImplementation((db, args) =>
					create(db, args.includeHidden && args.readLimit === 2048 ? { ...args, readLimit: 32 } : args),
				);
			try {
				const listed = await runner.run({ command: "trash ls" });

				expect(listed.metadata.exitCode, listed.stderr).toBe(0);
				expect(rows_of(listed.stdout)).toHaveLength(8);
			} finally {
				spy.mockRestore();
			}
		});

		test("keeps the user's rm of an item that another user moved to Trash", async () => {
			const owner = await create_team_runner();
			const readmeId = await get_seeded_node_id(owner, "/docs/readme.md");
			const member = await add_member(owner, { clerkUserId: "trash-member", role: "member" });
			expect((await member.run({ command: "rm docs/readme.md" })).metadata.exitCode).toBe(0);
			await archive(owner, ["/docs/readme.md"]);

			const listed = await member.run({ command: "trash ls" });
			const restored = await member.run({ command: `trash restore --id ${readmeId}:pending` });

			expect(rows_of(listed.stdout)[0]?.slice(3)).toEqual([
				`${readmeId}:pending`,
				`${team_mount}/docs/readme.md (pending delete, now in Trash)`,
			]);
			expect(restored.stderr).toContain("it is in Trash now.");
		});
	});

	describe("trash restore", () => {
		test("undoes the agent's rm and leaves no Pending row", async () => {
			const runner = await create_bash_runner();
			const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
			expect((await runner.run({ command: "rm docs/readme.md" })).metadata.exitCode).toBe(0);
			expect(await list_pending_updates_for_node(runner, readmeId)).toHaveLength(1);

			const restored = await runner.run({ command: "trash restore docs/readme.md && cat docs/readme.md" });

			expect(restored.metadata.exitCode, restored.stderr).toBe(0);
			expect(restored.stdout).toContain(`restored: ${test_db_files_mount}/docs/readme.md`);
			expect(restored.stdout).toContain("unique-token");
			expect(await list_pending_updates_for_node(runner, readmeId)).toEqual([]);
		});

		test("asks to restore the folder first for a file inside a removed folder", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "rm -r docs" })).metadata.exitCode).toBe(0);

			const restored = await runner.run({ command: "trash restore docs/readme.md" });

			expect(restored.metadata.exitCode).toBe(1);
			expect(restored.stderr).toBe(
				"trash: cannot restore 'docs/readme.md': its folder is deleted too. Restore the folder first.\n",
			);
		});
	});

	describe("trash cat", () => {
		test("reads saved text exactly and leaves an old content draft alone", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/exact.txt", content: "saved text", nonCollaborative: true }],
			});
			const nodeId = await get_seeded_node_id(runner, "/exact.txt");
			expect((await runner.run({ command: "echo 'draft text' > exact.txt" })).metadata.exitCode).toBe(0);
			const drafts = await list_pending_updates_for_node(runner, nodeId);
			expect(drafts).toHaveLength(1);
			await archive(runner, ["/exact.txt"]);
			const id = `${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId}`;

			const read = await runner.run({ command: `trash cat ${id}` });

			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toBe("saved text");
			expect(read.stderr).toBe("");
			expect(await list_pending_updates_for_node(runner, nodeId)).toEqual(drafts);
		});

		test("follows line pages beyond the second page without skipping text", async () => {
			const content = Array.from({ length: 1200 }, (_, index) => `${index + 1}: ${"a".repeat(80)}\n`).join("");
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/large.txt", content, nonCollaborative: true }],
			});
			const {
				nodeIds: [nodeId],
			} = await archive(runner, ["/large.txt"]);
			const id = `${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId}`;
			let command = `trash cat ${id}`;
			const pages: string[] = [];
			for (let index = 0; index < 6; index++) {
				const read = await runner.run({ command });
				expect(read.metadata.exitCode, read.stderr).toBe(0);
				expect(new TextEncoder().encode(read.stdout).length).toBeLessThanOrEqual(64 * 1024);
				pages.push(read.stdout);
				const next = /Next page: (.*)\n/.exec(read.stderr);
				if (!next) break;
				command = next[1];
			}
			expect(pages.length).toBeGreaterThanOrEqual(3);
			expect(pages.join("")).toBe(content);
			const pastEnd = await runner.run({ command: `trash cat ${id} --start-line 9999` });
			expect(pastEnd.metadata.exitCode, pastEnd.stderr).toBe(0);
			expect(pastEnd.stdout).toBe("");
			expect(pastEnd.stderr).toBe("");
		});

		test("uses an explicit line window for a small file", async () => {
			const runner = await create_bash_runner();
			const {
				nodeIds: [nodeId],
			} = await archive(runner, ["/docs/readme.md"]);
			const read = await runner.run({
				command: `trash cat ${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId} --start-line 2`,
			});
			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toBe(readme_seed_content.split("\n").slice(1).join("\n"));
		});

		test("names a scan-bound long line separately from unavailable text", async () => {
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/long.txt", content: "x".repeat(300_000), nonCollaborative: true },
					{ path: "/unavailable.txt", content: "not materialized", materialized: false },
				],
			});
			const { nodeIds } = await archive(runner, ["/long.txt", "/unavailable.txt"]);
			for (const [index, nodeId] of nodeIds.entries()) {
				const read = await runner.run({
					command: `trash cat ${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId}`,
				});
				expect(read.metadata.exitCode).toBe(1);
				expect(read.stdout).toBe("");
				expect(read.stderr).toContain(index === 0 ? "This line is too long" : "Text is not available");
			}
		});

		test("refuses stale saved chunks without collecting the update log", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
			await push_unsaved_rich_text_edit({
				runner,
				fileNode: await get_seeded_node(runner, "/docs/readme.md"),
				text: "new editor text",
			});
			await archive(runner, ["/docs/readme.md"]);
			const read = await runner.run({
				command: `trash cat ${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId}`,
			});
			expect(read.metadata.exitCode).toBe(1);
			expect(read.stdout).toBe("");
			expect(read.stderr).toContain("Text is not available");
		});
	});

	describe("trash requests", () => {
		test("proposes several saved restores and cancels only the named request", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "echo 'old draft' > docs/readme.md" })).metadata.exitCode).toBe(0);
			const { nodeIds } = await archive(runner, ["/docs/readme.md", "/reports/summary.md"]);
			const drafts = await list_pending_updates(runner);
			const nodes = await Promise.all(nodeIds.map((id) => read_node(runner, id)));
			const proposed = await runner.run({
				command: `trash restore --id ${nodes.map((node) => `${node._id}:${node.archiveOperationId}`).join(" ")}`,
			});
			expect(proposed.metadata.exitCode, proposed.stderr).toBe(0);
			expect(proposed.stdout.match(/restore request created:/g)).toHaveLength(2);
			expect(await Promise.all(nodeIds.map((id) => read_node(runner, id)))).toEqual(nodes);
			const listed = await runner.run({ command: "trash requests --format json --limit 1" });
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			const first = JSON.parse(listed.stdout);
			expect(first.requests).toHaveLength(1);
			expect(first.requests[0]).toMatchObject({ kind: "restore", status: "waiting" });
			expect(first.nextCursor).toBeTruthy();
			const textPage = await runner.run({ command: "trash requests --limit=1" });
			expect(textPage.stderr).toContain("Next page: trash requests --limit 1 --cursor");
			const nextCommand = /Next page: (.*)\n/.exec(textPage.stderr)![1];
			const textNext = await runner.run({ command: nextCommand });
			expect(textNext.metadata.exitCode, textNext.stderr).toBe(0);
			expect(textNext.stdout).not.toContain(first.requests[0].requestId);
			const next = await runner.run({ command: `trash requests --format json --limit 1 --cursor ${first.nextCursor}` });
			expect(next.metadata.exitCode, next.stderr).toBe(0);
			expect(JSON.parse(next.stdout).requests[0].requestId).not.toBe(first.requests[0].requestId);
			expect((await runner.run({ command: `trash cancel ${first.requests[0].requestId}` })).metadata.exitCode).toBe(0);
			const remaining = await runner.run({ command: "trash requests --format json" });
			expect(JSON.parse(remaining.stdout).requests).toHaveLength(1);
			expect(await list_pending_updates(runner)).toEqual(drafts);
			expect(await Promise.all(nodeIds.map((id) => read_node(runner, id)))).toEqual(nodes);
		});

		test("proposes purge and Empty without deleting anything, and refuses a pending purge", async () => {
			const runner = await create_bash_runner();
			const {
				nodeIds: [nodeId],
			} = await archive(runner, ["/docs/readme.md"]);
			const node = await read_node(runner, nodeId);
			const purge = await runner.run({ command: `trash purge --id ${nodeId}:${node.archiveOperationId}` });
			expect(purge.metadata.exitCode, purge.stderr).toBe(0);
			expect(purge.stdout).toContain("purge request created:");
			const empty = await runner.run({ command: "trash empty" });
			expect(empty.metadata.exitCode, empty.stderr).toBe(0);
			expect(empty.stdout).toContain("when accepted");
			expect(await read_node(runner, nodeId)).toEqual(node);
			const pending = await runner.run({ command: `trash purge --id ${nodeId}:pending` });
			expect(pending.metadata.exitCode).toBe(1);
			expect(pending.stderr).toContain("save the pending delete first");
		});

		test("allows reads in Ask and refuses every request write", async () => {
			const runner = await create_bash_runner({ allowDbFilesMkdir: false });
			const {
				nodeIds: [nodeId],
			} = await archive(runner, ["/docs/readme.md"]);
			const id = `${nodeId}:${(await read_node(runner, nodeId)).archiveOperationId}`;
			for (const command of [`trash cat ${id}`, "trash requests"]) {
				const read = await runner.run({ command });
				expect(read.metadata.exitCode, read.stderr).toBe(0);
			}
			for (const command of [`trash restore --id ${id}`, `trash purge --id ${id}`, "trash empty", "trash cancel x"]) {
				const write = await runner.run({ command });
				expect(write.metadata.exitCode).toBe(1);
				expect(write.stderr).toContain("Ask mode is read-only");
			}
		});
	});

	describe("guests", () => {
		test("get the guest message from every trash command", async () => {
			const owner = await create_team_runner();
			const docsId = await get_seeded_node_id(owner, "/docs");
			const guest = await add_member(owner, { clerkUserId: "trash-guest", role: null });

			for (const command of [
				"trash ls",
				"trash areas",
				`trash ls --in ${docsId}:t000000000000001-x`,
				`trash restore --id ${docsId}:pending`,
				`trash restore --id ${docsId}:t000000000000001-x`,
				`trash purge --id ${docsId}:t000000000000001-x`,
				`trash cat ${docsId}:t000000000000001-x`,
				"trash empty",
				"trash requests",
				"trash cancel x",
			]) {
				const result = await guest.run({ command });
				expect(result.metadata.exitCode, `${command}\n${result.stdout}${result.stderr}`).toBe(1);
				expect(result.stderr, command).toContain("Guests have no Trash view.");
			}
		});
	});

	describe("locked items", () => {
		test("say Permission denied before they say anything about the item", async () => {
			const owner = await create_team_runner([{ path: "/Locked/inside.md", content: "x\n", withoutYjsState: true }]);
			await restrict(owner, "/Locked");
			const lockedId = await get_seeded_node_id(owner, "/Locked");
			await archive(owner, ["/Locked"]);
			const member = await add_member(owner, { clerkUserId: "trash-member", role: "member" });

			const listed = await member.run({ command: "trash ls" });
			const wrongOperation = await member.run({ command: `trash ls --in ${lockedId}:t000000000000001-x` });

			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(rows_of(listed.stdout).map((row) => row.slice(1))).toEqual([
				["folder", "-", "-", `${team_mount}/Locked/ (locked)`],
			]);
			expect(wrongOperation.metadata.exitCode).toBe(1);
			expect(wrongOperation.stderr).toBe(`trash: cannot open '${lockedId}:t000000000000001-x': Permission denied\n`);
			for (const command of ["cat", "restore --id", "purge --id"]) {
				const denied = await member.run({ command: `trash ${command} ${lockedId}:t000000000000001-x` });
				expect(denied.metadata.exitCode).toBe(1);
				expect(denied.stderr).toContain("Permission denied");
				expect(denied.stderr).not.toContain("changed");
				expect(denied.stderr).not.toContain("directory");
			}
		});

		test("restore by path says Permission denied inside a locked folder, for a missing name too", async () => {
			const owner = await create_team_runner([{ path: "/Locked/inside.md", content: "x\n", withoutYjsState: true }]);
			await restrict(owner, "/Locked");
			const member = await add_member(owner, { clerkUserId: "trash-member", role: "member" });

			const restored = await member.run({ command: "trash restore Locked/inside.md Locked/missing.md" });

			expect(restored.metadata.exitCode).toBe(1);
			expect(restored.stderr).toBe(
				"trash: cannot restore 'Locked/inside.md': Permission denied\n" +
					"trash: cannot restore 'Locked/missing.md': Permission denied\n",
			);
		});

		test("restore by a draft path into a locked folder answers like for a missing name", async () => {
			const owner = await create_team_runner([
				{ path: "/outer/locked/inside.md", content: "x\n", withoutYjsState: true },
			]);
			const member = await add_member(owner, { clerkUserId: "trash-member", role: "member" });
			// The member's draft move keeps the folder at a new path, which the saved path check does not know.
			expect((await member.run({ command: "mv outer moved" })).metadata.exitCode).toBe(0);
			await restrict(owner, "/outer/locked");

			const restored = await member.run({ command: "trash restore moved/locked/inside.md moved/locked/missing.md" });

			expect(restored.metadata.exitCode).toBe(1);
			expect(restored.stderr).toBe(
				"trash: cannot restore 'moved/locked/inside.md': No such file or directory\n" +
					"trash: cannot restore 'moved/locked/missing.md': No such file or directory\n",
			);
		});
	});

	describe("pendingArchive.area", () => {
		test("follows the item when its folder is restricted and opened again", async () => {
			const runner = await create_bash_runner();
			const docsId = await get_seeded_node_id(runner, "/docs");
			const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
			expect((await runner.run({ command: "rm docs/readme.md" })).metadata.exitCode).toBe(0);
			const area = async () => (await list_pending_updates_for_node(runner, readmeId))[0]?.pendingArchive?.area;
			expect(await area()).toBeNull();

			await restrict(runner, "/docs");
			expect(await area()).toBe(docsId);
			const inDocs = await runner.run({ command: "trash ls docs" });
			expect(rows_of(inDocs.stdout).map((row) => row[4])).toEqual([
				`${test_db_files_mount}/docs/readme.md (pending delete)`,
			]);

			const opened = await runner_as_user(runner).mutation(api.files_sharing.unrestrict_node, {
				membershipId: runner.seeded.membershipId,
				nodeId: docsId,
			});
			expect(opened._nay).toBeUndefined();
			await drain_scheduled_continuations(runner);
			expect(await area()).toBeNull();
		});

		// A Move skips the overlay flush, so its cleanup must update the area itself.
		test("follows the item when a Move puts it in a restricted folder", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/Team/keep.md", content: "k\n", withoutYjsState: true }],
			});
			await restrict(runner, "/Team");
			const teamId = await get_seeded_node_id(runner, "/Team");
			const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
			expect((await runner.run({ command: "rm docs/readme.md" })).metadata.exitCode).toBe(0);

			const moved = await test_move_nodes(runner.t, runner_as_user(runner), {
				membershipId: runner.seeded.membershipId,
				itemIds: [readmeId],
				targetParentId: teamId,
			});

			expect(moved._nay).toBeUndefined();
			expect((await read_node(runner, readmeId)).restrictedScopeNodeId).toBe(teamId);
			expect((await list_pending_updates_for_node(runner, readmeId))[0]?.pendingArchive?.area).toBe(teamId);
		});
	});

	describe("jobs --activity", () => {
		test("reads the user's own Trash job and refuses another user's", async () => {
			const owner = await create_team_runner();
			// A folder delete runs as a job with an Activity.
			const { activityId } = await archive(owner, ["/docs"]);
			const member = await add_member(owner, { clerkUserId: "trash-member", role: "member" });

			const own = await owner.run({ command: `jobs --activity ${activityId}` });
			const other = await member.run({ command: `jobs --activity ${activityId}` });

			expect(own.metadata.exitCode, own.stderr).toBe(0);
			expect(own.stdout).toContain(`Activity ${activityId}: move to Trash succeeded`);
			expect(other.metadata.exitCode).toBe(1);
			expect(other.stderr).toBe("bash: jobs: status is unavailable\n");
		});
	});
});
