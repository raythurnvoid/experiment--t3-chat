// The cwd, moved folder path and Native Just Bash command tests, split from bash.writes.test.ts so the two files
// can run at the same time.
import { R2 } from "@convex-dev/r2";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { r2_server_side_copy } from "../convex/r2_client.ts";
import {
	test_save_file_pending_update,
	test_apply_file_pending_move,
	test_convex,
	test_mocks_fill_db_with,
} from "../convex/setup.test.ts";
import {
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_COMMAND_EXIT_NOT_FOUND,
	bash_COMMAND_EXIT_USAGE,
} from "./bash-utils.ts";
import {
	test_db_files_mount,
	function_name_of,
	test_r2_objects,
	readme_seed_content,
	default_organization_files,
	seed_organization_node,
	create_bash_runner,
	get_shell,
	get_seeded_node,
	get_seeded_node_id,
	get_private_entry,
	list_pending_updates,
	runner_as_user,
	list_pending_updates_for_node,
	pending_review_for_test,
	save_private_copy_for_test,
	read_committed_text,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	test("keeps a private cwd after another chat renames and saves its folder", async () => {
		const runner = await create_bash_runner();
		const entered = await runner.run({ command: "mkdir draft-cwd && cd draft-cwd" });
		expect(entered.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-cwd");
		const target = { kind: "private" as const, id: draft.node._id };
		const moved = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			target,
			destParent: { kind: "root" },
			destName: "renamed-cwd",
		});
		expect(moved._nay).toBeUndefined();
		const read = await runner.run({ command: "pwd" });
		expect(read.stdout).toBe(`${test_db_files_mount}/renamed-cwd\n`);
		const proposal = await runner.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdate._id));
		const saved = await test_save_file_pending_update(
			runner.t.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId }),
			{
				membershipId: runner.seeded.membershipId,
				target,
				pendingUpdateId: draft.pendingUpdate._id,
				reviewedRevision: proposal!.revision,
			},
		);
		if (saved._nay) throw new Error(saved._nay.message);
		expect((await runner.run({ command: "pwd" })).stdout).toBe(`${test_db_files_mount}/renamed-cwd\n`);
		expect((await get_shell({ t: runner.t, threadId: runner.threadId }))?.cwdTarget).toEqual(saved._yay.target);
	});

	test("leaves a discarded cwd instead of adopting a new folder at the same path", async () => {
		const runner = await create_bash_runner();
		expect((await runner.run({ command: "mkdir draft-cwd && cd draft-cwd" })).metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-cwd");
		const discarded = await runner.t
			.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId })
			.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: runner.seeded.membershipId,
				target: { kind: "private", id: draft.node._id },
				pendingUpdateId: draft.pendingUpdate._id,
				reviewedRevision: draft.pendingUpdate.revision,
			});
		expect(discarded._nay).toBeUndefined();
		const replacement = await runner.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			path: "/draft-cwd",
			kind: "folder",
		});
		expect(replacement._nay).toBeUndefined();
		expect((await runner.run({ command: "pwd" })).stdout).toBe(`${test_db_files_mount}\n`);
	});

	test("mv of the current working folder follows the pending move for cwd", async () => {
		const runner = await create_bash_runner();

		const cdResult = await runner.run({ command: `cd ${test_db_files_mount}/docs` });
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);

		// Moving the cwd's own folder keeps the shell inside it at its new visible path
		// instead of resetting to the workspace root.
		const moved = await runner.run({ command: "mv ../docs ../archive" });
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);

		// The next call runs from the moved folder and reads through the overlay.
		const read = await runner.run({ command: "cat readme.md" });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("# Readme");
	});

	test.each(["", "; cat ../docs/replacement.txt", "; (cd ..; cd docs; cat replacement.txt)"])(
		"keeps the moved cwd when the old path is reused%s",
		async (afterReuse) => {
			const runner = await create_bash_runner();
			const folderId = await get_seeded_node_id(runner, "/docs");
			expect((await runner.run({ command: "cd docs" })).metadata.exitCode).toBe(0);
			const moved = await runner.run({
				command: `mv ../docs ../archive; mkdir ../docs; printf replacement > ../docs/replacement.txt${afterReuse}`,
			});
			expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);
			expect((await get_shell({ t: runner.t, threadId: runner.threadId }))?.cwdTarget).toEqual({
				kind: "saved",
				id: folderId,
			});
			expect((await runner.run({ command: "cat readme.md" })).stdout).toContain("# Readme");
			expect((await runner.run({ command: "cat ../docs/replacement.txt" })).stdout).toBe("replacement");
		},
	);

	test.each(["cd ..; cd docs", "cd .", "builtin cd .", "go=cd; $go ."])(
		"cd can enter a new folder at the moved cwd's old path: %s",
		async (command) => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "cd docs" })).metadata.exitCode).toBe(0);
			const entered = await runner.run({ command: `mv ../docs ../archive; mkdir ../docs; ${command}` });
			expect(entered.metadata.exitCode, entered.stderr).toBe(0);
			expect(entered.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
			const replacement = await get_private_entry(runner, "/docs");
			expect((await get_shell({ t: runner.t, threadId: runner.threadId }))?.cwdTarget).toEqual({
				kind: "private",
				id: replacement.node._id,
			});
		},
	);

	test.each(["PWD=/tmp", "unset PWD", "exit 0"])("persists the actual cwd after %s", async (command) => {
		const runner = await create_bash_runner();
		const entered = await runner.run({ command: `cd docs; ${command}` });
		expect(entered.metadata.exitCode, entered.stderr).toBe(0);
		expect(entered.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
		expect((await runner.run({ command: "cat readme.md" })).stdout).toContain("# Readme");
	});

	test("keeps the outer cwd when a subshell moves it before any app command observes it", async () => {
		const runner = await create_bash_runner();
		const moved = await runner.run({ command: "cd docs; (cd ..; mv docs archive; mkdir docs)" });
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(moved.metadata.nextCwd).toBe(`${test_db_files_mount}/archive`);
		expect((await runner.run({ command: "cat readme.md" })).stdout).toContain("# Readme");
	});

	test("leaves an archived cwd when a new folder reuses its path in the same call", async () => {
		const runner = await create_bash_runner();
		const archived = await runner.run({ command: "cd docs; rm -r ../docs; mkdir ../docs" });
		expect(archived.metadata.exitCode, archived.stderr).toBe(0);
		expect(archived.metadata.nextCwd).toBe(test_db_files_mount);
	});

	test("a stale thread cwd follows a pending move proposed outside the thread", async () => {
		const runner = await create_bash_runner();

		const cdResult = await runner.run({ command: `cd ${test_db_files_mount}/reports` });
		expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/reports`);

		// The same user proposes the folder move from another thread at the workspace
		// root, so this thread's persisted cwd is never touched by the end-of-command
		// projection of that call.
		const otherThread = await create_bash_runner({ shared: { t: runner.t, seeded: runner.seeded } });
		const moved = await otherThread.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.metadata.nextCwd).toBe(test_db_files_mount);

		// The next call in the original thread starts inside the moved folder's visible
		// path instead of resetting to the workspace root.
		const read = await runner.run({ command: "pwd && cat summary.md" });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.metadata.cwd).toBe(`${test_db_files_mount}/archive`);
		expect(read.stdout).toContain(`${test_db_files_mount}/archive`);
		expect(read.stdout).toContain("summary");
	});

	test("mv into an existing folder keeps the visible name of a moved source", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md` });

		// Moving by the visible path into a folder keeps its visible name.
		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/reports`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);
		expect(folderMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const list = await runner.run({ command: `ls ${test_db_files_mount}/reports` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("guide.md");
		expect(list.stdout).not.toContain("tutorial.md");
	});

	test("mv into a moved destination folder uses its visible path", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// The parent keeps its saved identity while the shell uses its visible path.
		const move = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive`,
		});
		expect(move.stderr).toBe("");
		expect(move.metadata.exitCode).toBe(0);
		expect(move.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const list = await runner.run({ command: `ls ${test_db_files_mount}/archive` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("tutorial.md");
	});

	test("mv into a moved destination folder surfaces the visible-name conflict", async () => {
		const runner = await create_bash_runner({
			// The -f content replacement fetches the committed child's yjs snapshot from R2.
			extraFiles: [
				{ path: "/old/report.md", content: "old report\n", withRealYjsSnapshot: true },
				{ path: "/other/report.md", content: "new report\n", withRealYjsSnapshot: true },
				{ path: "/other/claim.md", content: "claim body\n" },
				{ path: "/third/claim.md", content: "third body\n" },
			],
		});

		const folderMove = await runner.run({ command: `mv ${test_db_files_mount}/old ${test_db_files_mount}/new` });
		expect(folderMove.metadata.exitCode).toBe(0);

		// The committed child at the visible destination is a real conflict, not a claim.
		const conflict = await runner.run({
			command: `mv ${test_db_files_mount}/other/report.md ${test_db_files_mount}/new`,
		});
		expect(conflict.metadata.exitCode).not.toBe(0);
		expect(conflict.stderr).toBe("mv: The destination already exists\n");

		// A visible path claimed by a file's own pending move is still rejected: one visible path, one proposal.
		const claim = await runner.run({
			command: `mv ${test_db_files_mount}/other/claim.md ${test_db_files_mount}/new/claim.md`,
		});
		expect(claim.metadata.exitCode).toBe(0);
		const claimedDest = await runner.run({
			command: `mv ${test_db_files_mount}/third/claim.md ${test_db_files_mount}/new`,
		});
		expect(claimedDest.metadata.exitCode).not.toBe(0);
		expect(claimedDest.stderr).toBe("mv: The destination already exists\n");

		// -f proposes the structural replace on the committed child, under the folder's
		// committed identity, so the replacement travels with the folder when its move is accepted.
		const forced = await runner.run({
			command: `mv -f ${test_db_files_mount}/other/report.md ${test_db_files_mount}/new`,
		});
		expect(forced.stderr).toBe("");
		expect(forced.metadata.exitCode).toBe(0);
		expect(forced.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const oldId = await get_seeded_node_id(runner, "/old");
		const targetId = await get_seeded_node_id(runner, "/old/report.md");
		const sourceId = await get_seeded_node_id(runner, "/other/report.md");
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: oldId },
			destName: "report.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(sourceRows[0].copiedFrom).toBeUndefined();
		const targetRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(targetRows).toHaveLength(0);
	});

	test("mv -f onto a committed child of a moved destination folder proposes the replace", async () => {
		const runner = await create_bash_runner({
			// The -f content replacement fetches the committed child's yjs snapshot from R2.
			extraFiles: [
				{ path: "/docs/incoming.md", content: "incoming body\n", withRealYjsSnapshot: true },
				{ path: "/reports/existing.md", content: "existing target\n", withRealYjsSnapshot: true },
				{ path: "/reports/plain.md", content: "plain target\n" },
			],
		});
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// Without -f the committed child at the exact visible path is a normal conflict,
		// not a claimed-by-pending-move rejection.
		const conflict = await runner.run({
			command: `mv ${test_db_files_mount}/docs/incoming.md ${test_db_files_mount}/archive/existing.md`,
		});
		expect(conflict.metadata.exitCode).not.toBe(0);
		expect(conflict.stderr).toBe("mv: The destination already exists\n");

		// -f proposes the structural replace on the committed child.
		const forced = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/incoming.md ${test_db_files_mount}/archive/existing.md`,
		});
		expect(forced.stderr).toBe("");
		expect(forced.metadata.exitCode).toBe(0);
		expect(forced.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const targetId = await get_seeded_node_id(runner, "/reports/existing.md");
		const sourceId = await get_seeded_node_id(runner, "/docs/incoming.md");
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "existing.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(await list_pending_updates_for_node(runner, targetId)).toHaveLength(0);

		// A stored upload keeps the same structural replacement on the committed identity,
		// so the replacement travels with the folder when the move is accepted.
		const uploadedId = await get_seeded_node_id(runner, "/uploaded.md");
		const plainId = await get_seeded_node_id(runner, "/reports/plain.md");
		const structural = await runner.run({
			command: `mv -f ${test_db_files_mount}/uploaded.md ${test_db_files_mount}/archive/plain.md`,
		});
		expect(structural.stderr).toBe("");
		expect(structural.metadata.exitCode).toBe(0);
		expect(structural.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const structuralRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", uploadedId))
				.collect(),
		);
		expect(structuralRows).toHaveLength(1);
		expect(structuralRows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "plain.md",
			replacesTarget: { kind: "saved", id: plainId },
		});

		// An exact dest path presented by its own pending move is still rejected.
		const claim = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/claim.md`,
		});
		expect(claim.metadata.exitCode).toBe(0);
		const claimedDest = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/claim.md`,
		});
		expect(claimedDest.metadata.exitCode).not.toBe(0);
		expect(claimedDest.stderr).toBe("mv: Path already exists\n");
	});

	test("cp into an existing folder keeps the visible name of a moved source", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md` });

		// Copying by the visible path into a folder keeps the visible basename, like real cp.
		const folderCopy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/reports`,
		});
		expect(folderCopy.metadata.exitCode).toBe(0);
		expect(folderCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const read = await runner.run({ command: `cat ${test_db_files_mount}/reports/guide.md` });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");
	});

	test("cp into a moved destination folder creates the file under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// cp uses the moved folder's visible path.
		const copy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive`,
		});
		expect(copy.stderr).toBe("");
		expect(copy.metadata.exitCode).toBe(0);
		expect(copy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The new file lists under the visible folder path and reads back.
		const list = await runner.run({ command: `ls ${test_db_files_mount}/archive` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("tutorial.md");
		const read = await runner.run({ command: `cat ${test_db_files_mount}/archive/tutorial.md` });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");

		// The private child keeps the saved folder's identity as its parent.
		const created = await get_private_entry(runner, "/archive/tutorial.md");
		expect(created.node.parent).toEqual({ kind: "saved", id: reportsId });
	});

	test("cp with an explicit dest path under a moved folder creates under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// cp can name a new private child under the moved folder's visible path.
		const copy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/archive/copy.md`,
		});
		expect(copy.stderr).toBe("");
		expect(copy.metadata.exitCode).toBe(0);
		expect(copy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The child stays private while its parent has a pending move.
		const created = await get_private_entry(runner, "/archive/copy.md");
		expect(created.node.parent).toEqual({ kind: "saved", id: reportsId });
		const committedArchive = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/archive")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedArchive).toBeNull();

		const list = await runner.run({ command: `ls ${test_db_files_mount}/archive` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("copy.md");

		// Saving the parent move keeps the same private child at the visible path.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-cp-accept",
			external_id: runner.seeded.userId,
			email: "bash-cp-accept@test.local",
		});
		const accepted = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, reportsId));
		expect(accepted._nay).toBeUndefined();
		const movedFolder = await get_seeded_node(runner, "/archive");
		expect(movedFolder._id).toBe(reportsId);
		const movedCopy = await get_private_entry(runner, "/archive/copy.md");
		expect(movedCopy.node._id).toBe(created.node._id);
		const savedCopyId = await save_private_copy_for_test(runner, "/archive/copy.md");
		expect((await get_seeded_node(runner, "/archive/copy.md"))._id).toBe(savedCopyId);
	});

	test("mkdir under a moved folder's visible path creates under the committed folder", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// mkdir at the moved folder's VISIBLE path succeeds, plain and -p.
		const made = await runner.run({ command: `mkdir ${test_db_files_mount}/archive/sub` });
		expect(made.stderr).toBe("");
		expect(made.metadata.exitCode).toBe(0);
		const madeRecursive = await runner.run({ command: `mkdir -p ${test_db_files_mount}/archive/deep/sub` });
		expect(madeRecursive.stderr).toBe("");
		expect(madeRecursive.metadata.exitCode).toBe(0);

		const list = await runner.run({ command: `ls ${test_db_files_mount}/archive` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toContain("sub/");
		expect(list.stdout.trim().split("\n")).toContain("deep/");

		// New folders stay private and keep their parent's identity.
		const sub = await get_private_entry(runner, "/archive/sub");
		expect(sub.node.parent).toEqual({ kind: "saved", id: reportsId });
		const deepSub = await get_private_entry(runner, "/archive/deep/sub");
		const committedArchive = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/archive")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedArchive).toBeNull();

		// Saving the parent move keeps both private folders in place.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-mkdir-accept",
			external_id: runner.seeded.userId,
			email: "bash-mkdir-accept@test.local",
		});
		const accepted = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, reportsId));
		expect(accepted._nay).toBeUndefined();
		const movedSub = await get_private_entry(runner, "/archive/sub");
		expect(movedSub.node._id).toBe(sub.node._id);
		const movedDeepSub = await get_private_entry(runner, "/archive/deep/sub");
		expect(movedDeepSub.node._id).toBe(deepSub.node._id);
	});

	test("mkdir can create private folders at a path vacated by the user's pending move", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports ${test_db_files_mount}/archive`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);

		// Plain mkdir still needs a visible parent. Recursive mkdir creates private parents.
		const plain = await runner.run({ command: `mkdir ${test_db_files_mount}/reports/sub` });
		expect(plain.metadata.exitCode).not.toBe(0);
		expect(plain.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/reports/sub': No such file or directory`,
		);
		const recursive = await runner.run({ command: `mkdir -p ${test_db_files_mount}/reports/sub` });
		expect(recursive.metadata.exitCode, recursive.stderr).toBe(0);
		const parent = await get_private_entry(runner, "/reports");
		const child = await get_private_entry(runner, "/reports/sub");
		expect(child.node.parent).toEqual({ kind: "private", id: parent.node._id });

		// No committed node was created under the vacated path.
		const committedSub = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/reports/sub")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedSub).toBeNull();
	});

	test("mkdir -p under a pending file-move claim is rejected without creating committed folders", async () => {
		const runner = await create_bash_runner();

		// The pending file move makes /foo.md a visible file; nothing sits there committed.
		const fileMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/foo.md`,
		});
		expect(fileMove.metadata.exitCode).toBe(0);

		const made = await runner.run({ command: `mkdir -p ${test_db_files_mount}/foo.md/sub` });
		expect(made.metadata.exitCode).not.toBe(0);
		expect(made.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/foo.md/sub': Not a directory`,
		);

		// No committed folder grew under the pending file claim.
		const committedFoo = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/foo.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedFoo).toBeNull();
	});

	test("cp under a pending file-move claim is rejected without creating committed folders", async () => {
		const runner = await create_bash_runner();

		const fileMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/foo.md`,
		});
		expect(fileMove.metadata.exitCode).toBe(0);

		const copy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/foo.md/sub/y.md`,
		});
		expect(copy.metadata.exitCode).not.toBe(0);
		expect(copy.stderr).toBe("cp: the destination parent is not a directory\n");

		// No committed folder grew under the pending file claim.
		const committedFoo = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/foo.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedFoo).toBeNull();
	});

	test("mkdir -p under a committed file fails without creating committed folders", async () => {
		const runner = await create_bash_runner();

		const made = await runner.run({ command: `mkdir -p ${test_db_files_mount}/docs/readme.md/sub` });
		expect(made.metadata.exitCode).not.toBe(0);
		expect(made.stderr).toContain(
			`mkdir: cannot create directory '${test_db_files_mount}/docs/readme.md/sub': Not a directory`,
		);

		const committedSub = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/docs/readme.md/sub")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(committedSub).toBeNull();
	});

	test("rejects unsupported app copy shapes without creating proposals", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/conflict/readme.md", kind: "folder" }],
		});

		const sameFile = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs`,
		});
		expect(sameFile.metadata.exitCode).not.toBe(0);
		expect(sameFile.stderr).toBe("cp: A copy cannot replace or merge into its sources\n");

		const folderOccupant = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/conflict`,
		});
		expect(folderOccupant.metadata.exitCode).not.toBe(0);
		expect(folderOccupant.stderr).toBe("cp: The source and destination types differ\n");

		const folderSource = await runner.run({
			command: `cp ${test_db_files_mount}/docs ${test_db_files_mount}/docs-copy`,
		});
		expect(folderSource.metadata.exitCode).not.toBe(0);
		expect(folderSource.stderr).toBe("cp: copying a folder requires -R\n");

		const missingSource = await runner.run({
			command: `cp ${test_db_files_mount}/nope.md ${test_db_files_mount}/copy.md`,
		});
		expect(missingSource.metadata.exitCode).not.toBe(0);
		expect(missingSource.stderr).toBe(`cp: source '${test_db_files_mount}/nope.md' is not available\n`);

		const rows = await runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(rows).toHaveLength(0);
	});

	test.each(["cp", "mv"] as const)("%s handles multiple app sources in one transfer", async (command) => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/one.txt", content: "one\n" },
				{ path: "/data/two.txt", content: "two\n" },
			],
		});
		const result = await runner.run({
			command: `${command} ${test_db_files_mount}/data/one.txt ${test_db_files_mount}/data/two.txt ${test_db_files_mount}/reports`,
		});
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 2 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(
			(
				await runner.run({
					command: `cat ${test_db_files_mount}/reports/one.txt ${test_db_files_mount}/reports/two.txt`,
				})
			).stdout,
		).toBe("one\ntwo\n");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.target.kind)).toEqual([
			command === "cp" ? "private" : "saved",
			command === "cp" ? "private" : "saved",
		]);
		expect((await get_seeded_node(runner, "/data/one.txt")).path).toBe("/data/one.txt");
		expect((await get_seeded_node(runner, "/data/two.txt")).path).toBe("/data/two.txt");
	});

	test("cp -R creates a private folder tree with its child content", async () => {
		const runner = await create_bash_runner();
		const result = await runner.run({ command: `cp -R ${test_db_files_mount}/docs ${test_db_files_mount}/docs-copy` });
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 5 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const folder = await get_private_entry(runner, "/docs-copy");
		const nested = await get_private_entry(runner, "/docs-copy/nested");
		const child = await get_private_entry(runner, "/docs-copy/nested/deep.md");
		expect(nested.node.parent).toEqual({ kind: "private", id: folder.node._id });
		expect(child.node.parent).toEqual({ kind: "private", id: nested.node._id });
		expect((await runner.run({ command: `cat ${test_db_files_mount}/docs-copy/nested/deep.md` })).stdout).toBe(
			"one:two\nthree:four\n",
		);
		expect(await list_pending_updates(runner)).toHaveLength(5);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path.startsWith("/docs-copy")),
			),
		).toEqual([]);
	});

	test("cp -R into a descendant copies only the checked source tree", async () => {
		const runner = await create_bash_runner();
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await runner.run({
			command: `cp -R ${test_db_files_mount}/docs ${test_db_files_mount}/docs/nested`,
		});
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 5 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await runner.run({ command: `cat ${test_db_files_mount}/docs/nested/docs/nested/deep.md` })).stdout).toBe(
			"one:two\nthree:four\n",
		);
		const items = await runner.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(5);
		expect(items.every((item) => item.state === "completed" && item.outputTarget?.kind === "private")).toBe(true);
		expect(items.some((item) => item.sourcePath.startsWith("/docs/nested/docs"))).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("cp of a stored file stages a byte copy that accepting turns into the same kind of file", async () => {
		const runner = await create_bash_runner();
		// The copy happens on the R2 server side. Stand in for it with the in-memory objects.
		const copySpy = vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, copyArgs) => {
			const bytes = test_r2_objects.get(copyArgs.sourceKey);
			if (!bytes) {
				return { outcome: "source_missing" as const };
			}
			test_r2_objects.set(copyArgs.destinationKey, bytes);
			return { outcome: "copied" as const, size: bytes.byteLength, etag: "copied-etag" };
		});
		const sourceId = await get_seeded_node_id(runner, "/source.pdf");

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/source.pdf ${test_db_files_mount}/source-copy.pdf`,
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(copySpy).toHaveBeenCalledTimes(1);

		// The private copy owns the same bytes and type as its source.
		const draft = await get_private_entry(runner, "/source-copy.pdf");
		expect(draft.pendingUpdate.copiedFrom).toMatchObject({
			target: { kind: "saved", id: sourceId },
			path: "/source.pdf",
		});
		const intent = draft.pendingUpdate.createIntent;
		if (intent?.kind !== "stored") throw new Error("Expected a stored copy");
		expect(intent).toMatchObject({ contentType: "application/pdf", size: 4096 });
		const copyAsset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", intent.assetId));
		expect(test_r2_objects.get(copyAsset!.r2Key!)).toEqual(test_r2_objects.get("bash-test/source.pdf"));

		// Accepting makes the copy a stored PDF like its source: no text and no document.
		const savedId = await save_private_copy_for_test(runner, "/source-copy.pdf");
		const accepted = await get_seeded_node(runner, "/source-copy.pdf");
		expect(accepted._id).toBe(savedId);
		expect(accepted.contentType).toBe("application/pdf");
		expect(accepted.textKind).toBeNull();
		expect(accepted.yjsSnapshotId).toBeNull();
		expect(accepted.assetId).toBe(intent.assetId);
		const unreadable = await runner.run({ command: `cat ${test_db_files_mount}/source-copy.pdf` });
		expect(unreadable.metadata.exitCode).not.toBe(0);
		expect(unreadable.stderr).toContain("Bash can read editable text files only");
	});

	test("degrades to a replace when the destination is created concurrently", async () => {
		const runner = await create_bash_runner();
		const racedPath = "/docs/raced-copy.md";

		// Another user creates the destination between the shell check and transfer planning.
		const baseImpl = runner.runMutation.getMockImplementation();
		if (baseImpl == null) {
			throw new Error("expected the runner runMutation spy to have an implementation");
		}
		let raced = false;
		runner.runMutation.mockImplementation(async (ref, actionArgs) => {
			if (!raced && function_name_of(ref) === "files_transfer:start_for_agent") {
				raced = true;
				await runner.t.run(async (ctx) => {
					await seed_organization_node({
						ctx,
						scope: {
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							userId: runner.seeded.userId,
						},
						spec: { path: racedPath, content: "raced\n", withRealYjsSnapshot: true },
						seedIndex: 99,
					});
				});
			}
			return await baseImpl(ref, actionArgs);
		});

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}${racedPath}`,
		});

		expect(raced).toBe(true);
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The raced saved node becomes the replacement target and survives Discard.
		const racedNode = await get_seeded_node(runner, racedPath);
		const pendingRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", racedNode._id))
				.collect(),
		);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0].copiedFrom).toBeDefined();
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, racedNode._id),
		);
		expect(discarded._nay).toBeUndefined();
		expect((await get_seeded_node(runner, racedPath))._id).toBe(racedNode._id);
		expect((await runner.run({ command: `cat ${test_db_files_mount}${racedPath}` })).stdout).toBe("raced\n");
	});

	test.each([
		{ status: "failed", errorMessage: "Permission denied", stderr: /^cp: Permission denied\n$/ },
		// A Stop from the Files UI leaves no error message.
		{ status: "canceled", errorMessage: null, stderr: /^cp: transfer stopped\. Activity \S+\n$/ },
	])("cp prints only why the copy stopped when it ends $status before any item", async (stop) => {
		const runner = await create_bash_runner();
		const baseImpl = runner.runQuery.getMockImplementation()!;
		runner.runQuery.mockImplementation(async (ref, queryArgs) => {
			const view = await baseImpl(ref, queryArgs);
			if (function_name_of(ref) !== "files_transfer:get_for_agent" || !view) return view;
			// The run stopped while listing its sources, so no item ran.
			const { activity } = view as { activity: { progress: object | null } };
			return {
				...view,
				activity: {
					...activity,
					status: stop.status,
					errorMessage: stop.errorMessage,
					progress: { ...activity.progress, completed: 0, skipped: 0, failed: 0 },
				},
			};
		});

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/stopped-copy.md`,
		});
		expect(copied.metadata.exitCode).toBe(1);
		expect(copied.stderr).toMatch(stop.stderr);
		expect(copied.stdout).toBe("");
	});

	test.each(["throw", "http"] as const)("cp closes its private output after an upload %s failure", async (failure) => {
		const runner = await create_bash_runner();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let failedUploads = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT") {
				failedUploads += 1;
				if (failure === "throw") throw new Error("simulated upload failure");
				return new Response(null, { status: 503 });
			}
			return await baseFetch(input, init);
		});

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/failed-copy.md`,
		});
		expect(copied.metadata.exitCode).not.toBe(0);
		expect(copied.stderr).toBe("cp: Could not copy file\n");
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 0 ready for review, 0 skipped, 1 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		// Each of the three attempts writes content and a Yjs snapshot, and `r2_put_object` tries each PUT 3 times.
		expect(failedUploads).toBe(18);
		const items = await runner.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ state: "failed", attempt: 3 });
		expect(
			(await runner.run({ command: `cat ${test_db_files_mount}/docs/failed-copy.md` })).metadata.exitCode,
		).not.toBe(0);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_pending_nodes").collect()).filter((node) => node.state === "active"),
			),
		).toEqual([]);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path === "/docs/failed-copy.md"),
			),
		).toEqual([]);
		expect((await runner.run({ command: `cat ${test_db_files_mount}/docs/readme.md` })).stdout).toBe(
			readme_seed_content,
		);
	});

	test("a failed cp leaves an existing target and another member's draft unchanged", async () => {
		const test_db_files_mount = "/home/cloud-usr/w/copy-team/home";
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "copy-team", workspaceName: "home" }),
		);
		const runner = await create_bash_runner({
			shared: { t, seeded },
			extraFiles: [...default_organization_files, { path: "/docs/copy-target.md", content: "saved target\n" }],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/copy-target.md");
		const member = await runner.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "copy-failure-member" });
			await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const other = await create_bash_runner({ shared: { t: runner.t, seeded: { ...runner.seeded, ...member } } });
		expect(
			(await other.run({ command: `printf 'member draft\\n' > ${test_db_files_mount}/docs/copy-target.md` })).metadata
				.exitCode,
		).toBe(0);
		const otherDraft = await list_pending_updates(other);
		expect(otherDraft).toHaveLength(1);
		vi.spyOn(R2.prototype, "generateUploadUrl").mockRejectedValue(new Error("simulated upload failure"));

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/copy-target.md`,
		});
		expect(copied.metadata.exitCode).not.toBe(0);
		expect(copied.stderr).toBe("cp: Could not copy file\n");
		expect((await get_seeded_node(runner, "/docs/copy-target.md"))._id).toBe(targetId);
		expect(await read_committed_text(runner, targetId)).toBe("saved target\n");
		expect(await list_pending_updates(other)).toEqual(otherDraft);
		expect((await other.run({ command: `cat ${test_db_files_mount}/docs/copy-target.md` })).stdout).toBe(
			"member draft\n",
		);
		expect(await list_pending_updates(runner)).toEqual([]);
	});

	test("supports the broader Native Just Bash /tmp command surface", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: [
				"cd /tmp",
				"printf 'alpha\\nbeta\\n' > data.txt",
				"rev data.txt",
				"tac data.txt",
				"nl data.txt",
				"printf alpha | base64",
				'printf \'{"name":"alpha"}\\n\' > meta.json',
				"jq -r .name meta.json",
				"sha256sum data.txt",
				"du data.txt",
				"diff data.txt data.txt",
				"rg beta data.txt",
			].join(" && "),
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("ahpla");
		expect(result.stdout).toContain("beta");
		expect(result.stdout).toContain("1\talpha");
		expect(result.stdout).toContain("YWxwaGE=");
		expect(result.stdout).toContain("alpha");
		expect(result.stdout).toContain("data.txt");
		expect(result.stderr).not.toContain("db-backed");
		expect(result.stderr).not.toContain("app-aware commands");
	});

	test("delegates /tmp grep file operands to Native Just Bash", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command:
				"printf 'example: command not found\\n' > /tmp/literal.txt && grep -n 'command not found' /tmp/literal.txt",
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("1:example: command not found\n");
		expect(result.stderr).not.toContain("grep over multiple/app-wide files is not supported");
		expect(result.stderr).not.toContain("db-backed");
	});

	test("treats /dev/null and /dev/zero as Native Just Bash devices outside the app mount", async () => {
		const { run } = await create_bash_runner();

		const nullResult = await run({
			command:
				"printf hi > /dev/null && printf 'alpha\\n' > /tmp/a.txt && tee /dev/null /tmp/b.txt < /tmp/a.txt >/dev/null && cat /tmp/b.txt",
		});
		const zeroResult = await run({ command: "head -c 5 /dev/zero | wc -c" });

		expect(nullResult.metadata.exitCode).toBe(0);
		expect(nullResult.stdout).toBe("alpha\n");
		expect(nullResult.stderr).not.toContain("read-only file system");
		expect(nullResult.stderr).not.toContain("db-backed");
		expect(zeroResult.metadata.exitCode).toBe(0);
		expect(zeroResult.stdout).toBe("5\n");
		expect(zeroResult.stderr).not.toContain("No such file");
		expect(zeroResult.stderr).not.toContain("db-backed");
	});

	test("does not append app-mount guidance for /tmp Native Just Bash command failures", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "printf alpha > /tmp/a.txt && rg missing /tmp/a.txt" });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("db-backed");
		expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("does not append app-mount guidance when a Native Just Bash command fails without touching a file", async () => {
		const { run } = await create_bash_runner();

		// Both run at the default cwd inside the app tree. Neither names a file, so the failure has
		// nothing to do with app paths and the cwd must not be offered as the culprit.
		const badDuration = await run({ command: "sleep abc" });
		const badOption = await run({ command: "rev --bogus" });

		expect(badDuration.metadata.exitCode).not.toBe(0);
		expect(badDuration.stderr).toContain("sleep: invalid time interval 'abc'");
		expect(badDuration.stderr).not.toContain("db-backed");
		expect(badDuration.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		expect(badOption.metadata.exitCode).not.toBe(0);
		expect(badOption.stderr).not.toContain("db-backed");
		expect(badOption.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("names the app file a Native Just Bash command tried to read from an app cwd", async () => {
		const { run } = await create_bash_runner();

		// A bare file name looks nothing like a path, so the guidance has to come from the read the
		// restricted view refused, not from argv.
		const result = await run({ command: `cd ${test_db_files_mount}/docs && sed 's/a/b/' readme.md` });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("sed: readme.md: No such file or directory");
		expect(result.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs/readme.md'.`,
		);
	});

	test("does not read a sed script as an app operand", async () => {
		const { run } = await create_bash_runner();

		const missingScratch = await run({ command: "sed 's/a/b/' /tmp/missing" });
		const appAfterScratch = await run({
			command: `printf 'alpha\\n' > /tmp/a.txt && sed 's/a/b/' /tmp/a.txt ${test_db_files_mount}/docs/readme.md`,
		});

		// `s/a/b/` has slashes, but it is the script, not a path under the cwd.
		expect(missingScratch.metadata.exitCode).not.toBe(0);
		expect(missingScratch.stderr).toContain("sed: /tmp/missing: No such file or directory");
		expect(missingScratch.stderr).not.toContain("db-backed");
		expect(missingScratch.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		expect(missingScratch.stderr).not.toContain("/s/a/b/");
		// A /tmp operand must not hide the app operand next to it.
		expect(appAfterScratch.metadata.exitCode).not.toBe(0);
		expect(appAfterScratch.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs/readme.md'.`,
		);
		expect(appAfterScratch.stderr).not.toContain("/s/a/b/");
	});

	test("runs native file detection on scratch through the app command", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "printf hi > /tmp/a.txt && file /tmp/a.txt" });

		expect(result.metadata.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("/tmp/a.txt: ASCII text\n");
		expect(result.stderr).toBe("");
	});

	test("does not add the old file hint to unrelated unknown commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: "# Try file /tmp/a.txt\nprintf hi > /tmp/a.txt\nfile /tmp/a.txt\nnot-a-command",
		});

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).toBe("/tmp/a.txt: ASCII text\n");
		expect(result.stderr).toContain("not-a-command: command not found");
		expect(result.stderr).not.toContain("intentionally unavailable");
	});

	test("prevents scratch symlinks from escaping into the app mount", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: `ln -s ${test_db_files_mount}/docs/readme.md /tmp/readme-link && cat /tmp/readme-link`,
		});

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("unique-token");
		expect(result.stderr).toContain("db-backed");
		expect(result.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
		// Pre-checked before the inner shell, so the sanitizer never redacts the paths.
		expect(result.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stderr).not.toContain("<path>");
	});

	test("rejects expanded Native Just Bash /tmp commands when direct app operands are involved", async () => {
		const { run } = await create_bash_runner();

		const duResult = await run({ command: `du ${test_db_files_mount}/docs` });
		const rgResult = await run({ command: `rg unique-token ${test_db_files_mount}/docs/readme.md` });
		const diffResult = await run({
			command: `printf '# Readme\\n' > /tmp/readme.md && diff ${test_db_files_mount}/docs/readme.md /tmp/readme.md`,
		});
		const duWithFlagsResult = await run({ command: `du -sh ${test_db_files_mount}/docs` });
		const defaultCwdResult = await run({ command: `cd ${test_db_files_mount}/docs && du` });

		for (const result of [duResult, rgResult, diffResult, duWithFlagsResult, defaultCwdResult]) {
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("db-backed");
			expect(result.stderr).toContain("app-aware commands");
		}
		expect(duResult.stderr).toContain(test_db_files_mount);
		expect(duResult.stderr).not.toContain("No such file or directory");
		expect(duResult.stderr).toContain(
			`du: app-mount paths do not expose POSIX disk usage. Try: stat ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -type f --limit 20`,
		);
		expect(rgResult.stderr).toContain(
			`rg: app paths do not support direct Native Just Bash rg. Try: grep unique-token ${test_db_files_mount}/docs/readme.md`,
		);
		expect(duWithFlagsResult.stderr).not.toContain("No such file or directory");
		expect(diffResult.stderr).not.toContain("No such file or directory");
		// Without an operand, du reads `.` through the restricted view, which refuses the app cwd.
		expect(defaultCwdResult.stderr).toContain("du: cannot access '.': No such file or directory");
		expect(defaultCwdResult.stderr).toContain(
			`Native Just Bash /tmp commands cannot access app files directly: '${test_db_files_mount}/docs'.`,
		);
	});

	test("allows app reads to stream into expanded Native Just Bash text utilities", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: [
				`cat ${test_db_files_mount}/docs/readme.md | rev | head -n 1`,
				`cat ${test_db_files_mount}/docs/readme.md | sha256sum`,
			].join(" && "),
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("emdaeR #");
		expect(result.stdout).toContain("-");
		expect(result.stderr).not.toContain("db-backed");
	});

	test("keeps nested shells, xargs, and which inside the curated command surface", async () => {
		const { run } = await create_bash_runner();

		const nested = await run({ command: `bash -c 'ls --limit 1 ${test_db_files_mount}/docs'` });
		const nestedLoginForm = await run({ command: `bash -lc 'ls --limit 1 ${test_db_files_mount}/docs'` });
		const nestedMixed = await run({
			command: `bash -c 'printf nested-ok > /tmp/nested-ok.txt && cat /tmp/nested-ok.txt'; bash -c 'printf blocked > /home/cloud-usr/nested-blocked.md'`,
		});
		const nestedAppWrite = await run({
			command: `bash -c 'printf nested-app > ${test_db_files_mount}/nested-app.md && cat ${test_db_files_mount}/nested-app.md'`,
		});
		const xargsResult = await run({ command: `printf '${test_db_files_mount}/docs/readme.md\\n' | xargs cat` });
		const xargsParallel = await run({ command: "printf hi | xargs -P 2 echo" });
		const xargsHelp = await run({ command: "xargs --help" });
		const xargsCombined = await run({ command: "printf 'a b' | xargs -rt echo" });
		const xargsNullCombined = await run({ command: "printf 'a\\0b\\0' | xargs -0t echo" });
		const whichResult = await run({
			command: "which ls find cat du rg sha256sum search meta textgrep && which --silent bash",
		});
		const whichAll = await run({ command: "which --all search" });
		const whichCombined = await run({ command: "which -as search" });
		const whichHelp = await run({ command: "which --help" });
		const whichMissing = await run({ command: "which" });
		const whichEndOptions = await run({ command: "which -- --not-a-command" });

		expect(nested.metadata.exitCode).toBe(0);
		expect(nested.stdout).toContain("nested/");
		expect(nestedLoginForm.metadata.exitCode).toBe(0);
		expect(nestedLoginForm.stdout).toContain("nested/");
		expect(nestedMixed.metadata.exitCode).not.toBe(0);
		expect(nestedMixed.stdout).toContain("nested-ok");
		expect(nestedMixed.stderr).toContain("read-only file system");
		// Nested shells share the outer fs, so app redirects create pending proposals there too.
		expect(nestedAppWrite.metadata.exitCode).toBe(0);
		expect(nestedAppWrite.stdout).toBe("nested-app\n");
		expect(xargsResult.metadata.exitCode).toBe(0);
		expect(xargsResult.stdout).toContain("unique-token");
		expect(xargsParallel.metadata.exitCode).toBe(2);
		expect(xargsParallel.stderr).toContain("parallel execution");
		expect(xargsHelp.metadata.exitCode).toBe(0);
		expect(xargsHelp.stdout).toContain("[-P 0|1]");
		expect(xargsHelp.stdout).not.toContain("-a FILE");
		expect(xargsCombined.metadata.exitCode).toBe(0);
		expect(xargsCombined.stdout).toBe("a b\n");
		expect(xargsCombined.stderr).toBe("echo a b\n");
		expect(xargsNullCombined.metadata.exitCode).toBe(0);
		expect(xargsNullCombined.stdout).toBe("a b\n");
		expect(xargsNullCombined.stderr).toBe("echo a b\n");
		expect(whichResult.metadata.exitCode).toBe(0);
		expect(whichResult.stdout).toContain("/usr/bin/ls");
		expect(whichResult.stdout).toContain("/usr/bin/find");
		expect(whichResult.stdout).toContain("/usr/bin/cat");
		expect(whichResult.stdout).toContain("/usr/bin/du");
		expect(whichResult.stdout).toContain("/usr/bin/rg");
		expect(whichResult.stdout).toContain("/usr/bin/sha256sum");
		expect(whichResult.stdout).toContain("/usr/bin/search");
		expect(whichResult.stdout).toContain("/usr/bin/meta");
		expect(whichResult.stdout).toContain("/usr/bin/textgrep");
		expect(whichAll.metadata.exitCode).toBe(0);
		expect(whichAll.stdout).toBe("/usr/bin/search\n/bin/search\n");
		expect(whichCombined.metadata.exitCode).toBe(0);
		expect(whichCombined.stdout).toBe("");
		expect(whichHelp.metadata.exitCode).toBe(0);
		expect(whichHelp.stdout).toContain("Usage: which [-a] [-s] NAME...");
		expect(whichMissing.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(whichMissing.stderr).toContain("which: missing command name");
		expect(whichMissing.stderr).toContain("Usage: which [-a] [-s] NAME...");
		expect(whichEndOptions.metadata.exitCode).toBe(1);
		expect(whichEndOptions.stderr).toContain("which: no --not-a-command in (/usr/bin:/bin)");
	});

	test("keeps synthetic Native Just Bash lookup paths native-only", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "du -a /usr/bin" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("/usr/bin/grep");
		expect(result.stdout).not.toContain("/usr/bin/file");
		expect(result.stdout).not.toContain("/usr/bin/search");
		expect(result.stdout).not.toContain("/usr/bin/textgrep");
	});

	test("forwards nested shell stdin and handles script files cleanly", async () => {
		const { run } = await create_bash_runner();

		const nestedStdin = await run({ command: "printf nested-stdin | bash -c 'cat'" });
		const nestedShStdin = await run({ command: "printf nested-sh-stdin | sh -c 'cat'" });
		const nestedInlineArgs = await run({ command: "bash -c 'echo inline:$0:$1:$#' script forwarded" });
		const writeScript = await run({ command: "printf 'echo script:$1\\n' > /tmp/nested-script.sh" });
		const scriptPath = await run({ command: "bash /tmp/nested-script.sh forwarded" });
		const nestedTmpGlob = await run({
			command:
				"printf 'nested-a\\n' > /tmp/nested-a.txt && printf 'nested-b\\n' > /tmp/nested-b.txt && bash -c 'cat /tmp/nested-*.txt'",
		});
		const sourceTmpScript = await run({
			command: "printf 'echo sourced:$BONOBO\\n' > /tmp/source-script.sh && BONOBO=ok source /tmp/source-script.sh",
		});
		const cdTmpBeforeDot = await run({ command: "cd /tmp" });
		const dotTmpScriptFromCwd = await run({ command: ". source-script.sh" });
		const missingScript = await run({ command: "bash /tmp/missing-script.sh" });
		const directoryScript = await run({ command: "sh /tmp" });
		const appScript = await run({ command: `bash ${test_db_files_mount}/docs/readme.md` });
		const appSourceScript = await run({ command: `source ${test_db_files_mount}/docs/readme.md` });
		const appDotScript = await run({ command: `. ${test_db_files_mount}/docs/readme.md` });
		const appEnvSourceScript = await run({ command: `BONOBO=1 source ${test_db_files_mount}/docs/readme.md` });
		const appRedirectSourceScript = await run({
			command: `2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md`,
		});
		const appCommandSourceScript = await run({ command: `command source ${test_db_files_mount}/docs/readme.md` });
		const appEvalSourceScript = await run({ command: `eval 'source ${test_db_files_mount}/docs/readme.md'` });
		const appEvalEnvSourceScript = await run({
			command: `eval 'BONOBO=1 source ${test_db_files_mount}/docs/readme.md'`,
		});
		const nestedAppSourceScript = await run({ command: `bash -c 'source ${test_db_files_mount}/docs/readme.md'` });
		const nestedAppRedirectSourceScript = await run({
			command: `bash -c '2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md'`,
		});
		const nestedEchoSource = await run({ command: "bash -c 'echo source'" });
		const missingInlineScript = await run({ command: "bash -c" });
		const unsupportedFlag = await run({ command: "sh -e" });

		expect(nestedStdin.metadata.exitCode).toBe(0);
		expect(nestedStdin.stdout).toBe("nested-stdin");
		expect(nestedShStdin.metadata.exitCode).toBe(0);
		expect(nestedShStdin.stdout).toBe("nested-sh-stdin");
		expect(nestedInlineArgs.metadata.exitCode).toBe(0);
		expect(nestedInlineArgs.stdout).toBe("inline:script:forwarded:1\n");
		expect(writeScript.metadata.exitCode).toBe(0);
		expect(scriptPath.metadata.exitCode).toBe(0);
		expect(scriptPath.stdout).toBe("script:forwarded\n");
		expect(nestedTmpGlob.metadata.exitCode).toBe(0);
		expect(nestedTmpGlob.stdout).toContain("nested-a\n");
		expect(nestedTmpGlob.stdout).toContain("nested-b\n");
		expect(sourceTmpScript.metadata.exitCode).toBe(0);
		expect(sourceTmpScript.stdout).toBe("sourced:ok\n");
		expect(cdTmpBeforeDot.metadata.exitCode).toBe(0);
		expect(dotTmpScriptFromCwd.metadata.exitCode).toBe(0);
		expect(dotTmpScriptFromCwd.stdout).toBe("sourced:\n");
		expect(missingScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_NOT_FOUND);
		expect(missingScript.stderr).toBe("bash: /tmp/missing-script.sh: No such file or directory\n");
		expect(missingScript.stderr).not.toContain("ENOENT");
		expect(directoryScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(directoryScript.stderr).toBe("sh: /tmp: Is a directory\n");
		expect(directoryScript.stderr).not.toContain("EISDIR");
		expect(appScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appScript.stderr).toContain("app-mounted script files are not executable");
		expect(appScript.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(appSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appDotScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appDotScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appCommandSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appCommandSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEvalSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEvalSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(appEvalEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(appEvalEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedAppSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(nestedAppSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedAppRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
		expect(nestedAppRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
		expect(nestedEchoSource.metadata.exitCode).toBe(0);
		expect(nestedEchoSource.stdout).toBe("source\n");
		expect(missingInlineScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingInlineScript.stderr).toContain("option requires an argument");
		expect(unsupportedFlag.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(unsupportedFlag.stderr).toContain("sh -c 'script'");
		expect(unsupportedFlag.stderr).toContain("sh /tmp/script.sh");
	});

	test("keeps nested command loaders from executing app files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		for (const command of [
			`bash -c "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`sh -c "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`eval "$(cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command -- cat ${test_db_files_mount}/loaded-script.sh)"`,
			`bash -c "$(command -p cat ${test_db_files_mount}/loaded-script.sh)"`,
			'bash -c "$(command cat $(pwd)/loaded-script.sh)"',
			'bash -c "$($(echo cat) loaded-script.sh)"',
			'bash -c "$(head -n 1 loaded-script.sh)"',
			'bash -c "$(tail -n 1 loaded-script.sh)"',
			'bash -c "$(grep app-loaded loaded-script.sh)"',
			"bash -c \"$(sed -n '1p' loaded-script.sh)\"",
			'bash -c "$(textgrep app-loaded loaded-script.sh)"',
			"script='source loaded-script.sh'; bash -c \"$script\"",
		]) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("loaded");
			expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
		}

		const tmpScript = await runner.run({
			command: "printf 'echo tmp-loaded\\n' > /tmp/loaded-script.sh && bash -c \"$(cat /tmp/loaded-script.sh)\"",
		});
		expect(tmpScript.metadata.exitCode).toBe(0);
		expect(tmpScript.stdout).toBe("tmp-loaded\n");

		const appPathAsData = await runner.run({
			command: `bash -c "$(echo 'echo app-path' ${test_db_files_mount}/loaded-script.sh)"`,
		});
		expect(appPathAsData.metadata.exitCode).toBe(0);
		expect(appPathAsData.stdout).toBe(`app-path ${test_db_files_mount}/loaded-script.sh\n`);

		const dynamicCommandAsData = await runner.run({ command: `bash -c "$($(echo echo) 'echo dynamic-command')"` });
		expect(dynamicCommandAsData.metadata.exitCode).toBe(0);
		expect(dynamicCommandAsData.stdout).toBe("dynamic-command\n");
	});

	test("rejects app shell code captured in assignments", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		const executed = await runner.run({ command: 'script="$(cat loaded-script.sh)"; bash -c "$script"' });
		expect(executed.metadata.exitCode).not.toBe(0);
		expect(executed.stdout).not.toContain("app-loaded");
		expect(executed.stderr).toContain("cannot load app files or agent-only external mounts");

		const readAsData = await runner.run({ command: 'script="$(cat loaded-script.sh)"; printf "%s" "$script"' });
		expect(readAsData.metadata.exitCode).toBe(0);
		expect(readAsData.stdout).toBe("echo app-loaded");
	});

	test("rejects nested app-file reader command substitutions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo\n" }],
		});

		const result = await runner.run({ command: 'eval "$($(cat loaded-script.sh) echo nested-loaded)"' });
		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("nested-loaded");
		expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
	});

	test("allows resolved echo commands to print app paths without reading them", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/loaded-script.sh", content: "echo app-loaded\n" }],
		});

		const result = await runner.run({ command: 'bash -c "$($(echo echo) echo safe loaded-script.sh)"' });
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("safe loaded-script.sh\n");
	});

	test("rejects xargs -n with a non-positive or non-numeric value instead of silently batching all items", async () => {
		const { run } = await create_bash_runner();

		const zero = await run({ command: "printf 'a\\nb\\nc\\n' | xargs -n 0 echo" });
		const nonNumeric = await run({ command: "printf 'a\\nb\\nc\\n' | xargs -n x echo" });
		const attachedNonNumeric = await run({ command: "printf 'a\\nb\\nc\\n' | xargs -nx echo" });
		const valid = await run({ command: "printf 'a\\nb\\nc\\n' | xargs -n 1 echo" });

		expect(zero.metadata.exitCode).toBe(2);
		expect(zero.stderr).toContain("xargs: -n requires a positive integer");
		expect(zero.stderr).toContain("Supported: xargs");
		expect(nonNumeric.metadata.exitCode).toBe(2);
		expect(nonNumeric.stderr).toContain("xargs: -n requires a positive integer");
		expect(nonNumeric.stderr).toContain("Supported: xargs");
		expect(attachedNonNumeric.metadata.exitCode).toBe(2);
		expect(attachedNonNumeric.stderr).toContain("xargs: -n requires a positive integer");
		expect(attachedNonNumeric.stderr).toContain("Supported: xargs");
		expect(valid.metadata.exitCode).toBe(0);
	});

	test("validates xargs replacement delimiter and parallel option values", async () => {
		const { run } = await create_bash_runner();

		const missingReplace = await run({ command: "printf a | xargs -I" });
		const emptyReplace = await run({ command: "printf a | xargs -I '' echo" });
		const missingDelimiter = await run({ command: "printf a | xargs -d" });
		const emptyDelimiter = await run({ command: "printf a | xargs -d '' echo" });
		const missingParallel = await run({ command: "printf a | xargs -P" });
		const invalidParallel = await run({ command: "printf a | xargs -P nope echo" });
		const zeroParallel = await run({ command: "printf hi | xargs -P0 echo" });
		const oneParallel = await run({ command: "printf hi | xargs -P 1 echo" });
		const hugeParallel = await run({ command: `printf a | xargs -P ${"9".repeat(400)} echo` });

		expect(missingReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingReplace.stderr).toContain("xargs: -I requires a value");
		expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
		expect(missingDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingDelimiter.stderr).toContain("xargs: -d requires a value");
		expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
		expect(missingParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingParallel.stderr).toContain("xargs: -P requires a non-negative integer");
		expect(invalidParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidParallel.stderr).toContain("xargs: -P requires a non-negative integer");
		expect(zeroParallel.metadata.exitCode).toBe(0);
		expect(zeroParallel.stdout).toBe("hi\n");
		expect(oneParallel.metadata.exitCode).toBe(0);
		expect(oneParallel.stdout).toBe("hi\n");
		expect(hugeParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(hugeParallel.stderr).toContain("parallel execution");
	});

	test("supports GNU-style xargs long aliases", async () => {
		const { run } = await create_bash_runner();

		const maxArgsSeparate = await run({ command: "printf 'a b c' | xargs --max-args 2 echo" });
		const maxArgsEquals = await run({ command: "printf 'a b c' | xargs --max-args=2 echo" });
		const replaceBare = await run({ command: "printf 'a\\n' | xargs --replace echo '<{}>'" });
		const replaceEquals = await run({ command: "printf 'zeta\\n' | xargs --replace={} printf '({})\\n'" });
		const delimiterSeparate = await run({ command: "printf 'a,b,c' | xargs --delimiter , echo" });
		const delimiterEquals = await run({ command: "printf 'a:b:c' | xargs --delimiter=: echo" });
		const missingMaxArgs = await run({ command: "printf a | xargs --max-args" });
		const emptyReplace = await run({ command: "printf a | xargs --replace= echo" });
		const emptyDelimiter = await run({ command: "printf a | xargs --delimiter= echo" });

		expect(maxArgsSeparate.metadata.exitCode).toBe(0);
		expect(maxArgsSeparate.stdout).toBe("a b\nc\n");
		expect(maxArgsEquals.metadata.exitCode).toBe(0);
		expect(maxArgsEquals.stdout).toBe("a b\nc\n");
		expect(replaceBare.metadata.exitCode).toBe(0);
		expect(replaceBare.stdout).toBe("<a>\n");
		expect(replaceEquals.metadata.exitCode).toBe(0);
		expect(replaceEquals.stdout).toBe("(zeta)\n");
		expect(delimiterSeparate.metadata.exitCode).toBe(0);
		expect(delimiterSeparate.stdout).toBe("a b c\n");
		expect(delimiterEquals.metadata.exitCode).toBe(0);
		expect(delimiterEquals.stdout).toBe("a b c\n");
		expect(missingMaxArgs.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingMaxArgs.stderr).toContain("xargs: -n requires a positive integer");
		expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
		expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
	});

	test("keeps xargs replacement input newline-delimited and UTF-8 decoded", async () => {
		const { run } = await create_bash_runner();

		const replacement = await run({ command: "printf 'alpha beta\\ncafé file\\n' | xargs -I{} printf '<{}>\\n'" });
		const doubleDash = await run({ command: "printf ok | xargs -- echo" });
		const emptyInput = await run({ command: "printf '' | xargs echo should-not-run" });

		expect(replacement.metadata.exitCode).toBe(0);
		expect(replacement.stdout).toBe("<alpha beta>\n<café file>\n");
		expect(doubleDash.metadata.exitCode).toBe(0);
		expect(doubleDash.stdout).toBe("ok\n");
		expect(emptyInput.metadata.exitCode).toBe(0);
		expect(emptyInput.stdout).toBe("");
	});

	test("parses options after the search query", async () => {
		const { run, runQuery } = await create_bash_runner();

		await run({ command: "search unique-token --limit 5" });

		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				query: "unique-token",
				numItems: 5,
			}),
		);
	});

	test("reports stdout truncation without path-index truncation", async () => {
		const { run } = await create_bash_runner();

		// A wide zero pad reaches the cap in one command; seq now stops at the loop-iteration limit
		// well below it.
		const result = await run({ command: "printf '%0200000d' 1" });

		expect(result.metadata.stdoutTruncated).toBe(true);
		expect(result.metadata.stdoutLength).toBeGreaterThan(128 * 1024);
		expect(result.metadata.pathIndexTruncated).toBe(false);
		expect(result.stdout).toContain("[truncated after 131072 characters]");
	});
});
