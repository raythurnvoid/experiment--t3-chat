import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with, test_move_nodes } from "../convex/setup.test.ts";
import {
	test_db_files_mount,
	create_bash_runner,
	default_organization_files,
	drain_scheduled_continuations,
	get_seeded_node_id,
	list_pending_updates,
	list_pending_updates_for_node,
	runner_as_user,
} from "./bash.setup.test.ts";

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
