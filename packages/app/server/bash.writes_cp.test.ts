// The cp tests from app-to-app cp on, split from bash.writes.test.ts so the files can run at the same time.
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE } from "../convex/files_pending_updates.ts";
import { test_apply_file_pending_move } from "../convex/setup.test.ts";
import {
	test_db_files_mount,
	function_name_of,
	test_r2_objects,
	readme_seed_content,
	seed_organization_node,
	create_bash_runner,
	get_seeded_node,
	get_seeded_node_id,
	get_private_entry,
	list_pending_updates,
	runner_as_user,
	list_pending_updates_for_node,
	pending_review_for_test,
	accept_pending_update_for_test,
	save_private_copy_for_test,
	push_unsaved_rich_text_edit,
	accept_pending_replacement_for_test,
	read_committed_text,
	version_snapshot_asset_ids,
	count_version_snapshots,
	read_version_text,
	drain_scheduled_continuations,
	plain_copy_canonical,
	plain_copy_lossy,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	test("creates a pending copy proposal for app-to-app cp", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme-copy.md`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The copied file stays private until the user saves it.
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const draft = await get_private_entry(runner, "/docs/readme-copy.md");
		expect(draft.node.kind).toBe("file");
		expect(draft.pendingUpdate.copiedFrom).toMatchObject({
			target: { kind: "saved", id: sourceId },
			path: "/docs/readme.md",
		});
		expect(draft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/markdown;charset=utf-8",
			textKind: "rich_text",
		});

		// Readers see the owner's private content.
		const overlayRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/readme-copy.md` });
		expect(overlayRead.metadata.exitCode).toBe(0);
		expect(overlayRead.stdout).toContain("# Readme");
		expect(overlayRead.stdout).toContain("unique-token");

		// A new child inside an existing folder uses the special-name casing.
		const folderDest = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`,
		});
		expect(folderDest.metadata.exitCode).toBe(0);
		expect(folderDest.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await get_private_entry(runner, "/reports/README.md")).node.name).toBe("README.md");
	});

	test("blocks writes to a locked folder but lets writable children change and copy out", async () => {
		const runner = await create_bash_runner();

		const docsId = await get_seeded_node_id(runner, "/docs");
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const tutorialId = await get_seeded_node_id(runner, "/docs/tutorial.md");

		await runner.t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			for (const node of nodes) {
				if (
					node.organizationId === runner.seeded.organizationId &&
					node.workspaceId === runner.seeded.workspaceId &&
					(node.path === "/docs" || node.path.startsWith("/docs/"))
				) {
					await ctx.db.patch("files_nodes", node._id, {
						writePolicy: node._id === docsId ? { mode: "read_only" } : null,
					});
				}
			}
		});

		// Writes to writable children pass. The folder lock does not cover them.
		const allowedCommands = [
			`printf changed > ${test_db_files_mount}/docs/readme.md`,
			`rm ${test_db_files_mount}/docs/tutorial.md`,
		];
		for (const command of allowedCommands) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode, command).toBe(0);
			expect(result.stderr, command).toBe("");
		}

		// Create inside the locked folder, and move through it as the immediate parent, stay refused.
		const refusedCommands = [
			`mkdir ${test_db_files_mount}/docs/new-folder`,
			`mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/moved.md`,
			`mv ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/moved-in.md`,
			`cp ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/copied.md`,
		];
		for (const command of refusedCommands) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode, command).not.toBe(0);
			expect(result.stderr, command).toContain("read-only");
		}

		const copiedOut = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/copied-out.md`,
		});
		expect(copiedOut.metadata.exitCode).toBe(0);
		expect(copiedOut.stderr).toBe("");
		expect((await get_private_entry(runner, "/reports/copied-out.md")).node.parent).toEqual({
			kind: "saved",
			id: await get_seeded_node_id(runner, "/reports"),
		});
		expect(await get_seeded_node(runner, "/docs/readme.md")).toMatchObject({
			writePolicy: null,
		});

		const activePaths = await runner.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect())
				.filter(
					(node) =>
						node.organizationId === runner.seeded.organizationId &&
						node.workspaceId === runner.seeded.workspaceId &&
						node.archiveOperationId === null,
				)
				.map((node) => node.path),
		);
		expect(activePaths).toContain("/docs/readme.md");
		expect(activePaths).toContain("/docs/tutorial.md");
		expect(activePaths).not.toContain("/reports/copied-out.md");
		expect(activePaths).toContain("/reports/summary.md");
		expect(activePaths).not.toContain("/docs/new-folder");
		expect(activePaths).not.toContain("/docs/copied.md");
		expect(activePaths).not.toContain("/docs/moved-in.md");
		expect(activePaths).not.toContain("/reports/moved.md");

		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/docs/readme.md` });
		expect(readBack.stdout).toContain("changed");
		expect(readBack.stdout).not.toContain("# Readme");
		const tutorialRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/tutorial.md` });
		expect(tutorialRead.metadata.exitCode).not.toBe(0);

		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					target: { kind: "saved", id: sourceId },
				}),
				expect.objectContaining({
					target: { kind: "saved", id: tutorialId },
					pendingArchive: expect.objectContaining({ fromPath: "/docs/tutorial.md" }),
				}),
				expect.objectContaining({
					copiedFrom: expect.objectContaining({
						target: { kind: "saved", id: sourceId },
						path: "/docs/readme.md",
					}),
				}),
			]),
		);
		expect(pendingRows).toHaveLength(3);
		const savedCopyId = await save_private_copy_for_test(runner, "/reports/copied-out.md");
		expect(await runner.t.run((ctx) => ctx.db.get("files_nodes", savedCopyId))).toMatchObject({
			writePolicy: null,
		});
	});

	test("cp into a new deep path keeps the file and its parents private", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/new/deep/copy.md`,
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const draft = await get_private_entry(runner, "/new/deep/copy.md");
		const newFolder = await get_private_entry(runner, "/new");
		const deepFolder = await get_private_entry(runner, "/new/deep");
		expect(newFolder.node.parent).toEqual({ kind: "root" });
		expect(deepFolder.node.parent).toEqual({ kind: "private", id: newFolder.node._id });
		expect(draft.node.parent).toEqual({ kind: "private", id: deepFolder.node._id });
		expect((await list_pending_updates(runner)).map((row) => row.target)).toEqual(
			expect.arrayContaining([
				{ kind: "private", id: newFolder.node._id },
				{ kind: "private", id: deepFolder.node._id },
				{ kind: "private", id: draft.node._id },
			]),
		);
		expect(
			await runner.t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).filter((node) => node.path.startsWith("/new")),
			),
		).toEqual([]);
	});

	test("archive acceptance releases a copied replacement under a deleted file", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/copied/existing.md", content: "keep this saved version\n" }],
		});
		const targetBefore = await get_seeded_node(runner, "/copied/existing.md");
		const archivedId = targetBefore._id;
		const result = await runner.run({
			command: "cp docs/readme.md copied/existing.md; rm copied/existing.md",
		});
		expect(result.metadata.exitCode, result.stderr).toBe(0);
		const [copy] = await list_pending_updates_for_node(runner, targetBefore._id);
		if (!copy?.pendingReplacement) throw new Error("Expected the copied replacement");
		const assetId = copy.pendingReplacement.assetId;
		const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", assetId));
		if (!asset?.r2Key) throw new Error("Expected the sealed copy asset");
		expect(asset.unfinalizedExpiresAt).toBeUndefined();
		expect(asset.putMayArriveUntil).toBeGreaterThan(Date.now());
		const reservation = await runner.t.run((ctx) =>
			ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
				.unique(),
		);
		if (!reservation) throw new Error("Expected the copy storage hold");
		expect(reservation.settlement.kind).toBe("held");
		const [archive] = await list_pending_updates_for_node(runner, archivedId);
		expect(archive.pendingArchive).toBeDefined();
		const asUser = runner.t.withIdentity({ issuer: "https://clerk.test", external_id: runner.seeded.userId });
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: archivedId },
			pendingUpdateId: archive._id,
			reviewedRevision: archive.revision,
		});
		expect(accepted._nay).toBeUndefined();
		await runner.t.run(async (ctx) => {
			const target = await ctx.db.get("files_nodes", targetBefore._id);
			expect(target?.archiveOperationId).not.toBeNull();
			expect(target?.assetId).toBe(targetBefore.assetId);
			expect(await ctx.db.get("files_pending_updates", copy._id)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assetId)).toBeNull();
		});
		const job = await runner.t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", asset.r2Key!))
				.unique(),
		);
		if (!job) throw new Error("Expected the copy cleanup job");
		expect(job.privateStorageReservationId).toBe(reservation._id);
		expect(job.reason).toBe("discarded_replacement");
		expect(job.putMayArriveUntil).toBe(asset.putMayArriveUntil);
		expect(
			(await runner.t.run((ctx) => ctx.db.get("files_private_storage_reservations", reservation._id)))?.settlement.kind,
		).toBe("held");
		await runner.t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(test_r2_objects.has(asset.r2Key)).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).not.toBeNull();
		const now = vi.spyOn(Date, "now").mockReturnValue(job.putMayArriveUntil! + 1);
		try {
			await runner.t.action(internal.r2_client.process_object_deletion_job, {
				jobId: job._id,
				generation: job.generation,
			});
		} finally {
			now.mockRestore();
		}
		await runner.t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_object_deletion_jobs", job._id)).toBeNull();
			expect((await ctx.db.get("files_private_storage_reservations", reservation._id))?.settlement.kind).toBe(
				"deleted",
			);
			expect(await ctx.db.get("files_r2_assets", targetBefore.assetId!)).not.toBeNull();
		});
	});

	test("cp onto an existing file proposes replacing it as a whole", async () => {
		const runner = await create_bash_runner({
			// The copy replaces the whole file; the destination's own document is never read.
			extraFiles: [{ path: "/docs/replace-target.md", content: "replace me\n", withRealYjsSnapshot: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetId = await get_seeded_node_id(runner, "/docs/replace-target.md");

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/replace-target.md`,
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The replacement belongs to the saved file and carries no private creation intent.
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].copiedFrom).toMatchObject({ target: { kind: "saved", id: sourceId }, path: "/docs/readme.md" });
		expect(rows[0].createIntent).toBeUndefined();

		// The agent's own read overlays the proposed content on the destination.
		const overlayRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/replace-target.md` });
		expect(overlayRead.metadata.exitCode).toBe(0);
		expect(overlayRead.stdout).toContain("unique-token");
	});

	test("cp onto a file with collaboration off keeps that mode when accepted", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/off-target.md", content: "replace me\n", nonCollaborative: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetBefore = await get_seeded_node(runner, "/docs/off-target.md");

		const result = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/off-target.md`,
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The copy waits for review like on a collaborative file. The file itself is unchanged.
		const rows = await list_pending_updates_for_node(runner, targetBefore._id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pendingReplacement).toBeDefined();
		expect(rows[0]!.copiedFrom).toMatchObject({ target: { kind: "saved", id: sourceId }, path: "/docs/readme.md" });
		expect(await read_committed_text(runner, targetBefore._id)).toBe("replace me\n");

		// The agent's own read overlays the proposed content on the destination.
		const overlayRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/off-target.md` });
		expect(overlayRead.stdout).toContain("unique-token");

		// Accept keeps the destination's collaboration setting.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
		const targetAfter = await get_seeded_node(runner, "/docs/off-target.md");
		expect(targetAfter._id).toBe(targetBefore._id);
		expect(targetAfter.collaborationEnabled).toBe(false);
		expect(targetAfter.yjsSnapshotId).toBeNull();
		expect(targetAfter.yjsLastSequenceId).toBeNull();
		const savedRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/off-target.md` });
		expect(savedRead.stdout).toContain("unique-token");
		expect(savedRead.stdout).not.toContain("replace me");
	});

	test("cp of a Markdown file onto a plain text file with collaboration off takes the source's type on accept", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/settings.yaml", content: "a: 1\n", contentType: "application/yaml", nonCollaborative: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/data/settings.yaml");

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/settings.yaml`,
		});
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Until the review, the file keeps its type and its text.
		const targetPending = await get_seeded_node(runner, "/data/settings.yaml");
		expect(targetPending.contentType).toBe("application/yaml");
		expect(targetPending.assetId).toBe(targetBefore.assetId);

		// Accept keeps the file's identity and mode, and stores the source's text, type, and shape.
		// The name stays .yaml: it never decides the type.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		const targetAfter = await get_seeded_node(runner, "/data/settings.yaml");
		expect(targetAfter._id).toBe(targetBefore._id);
		expect(targetAfter.collaborationEnabled).toBe(false);
		expect(targetAfter.textKind).toBe("rich_text");
		expect(targetAfter.contentType).toBe("text/markdown;charset=utf-8");
		expect(targetAfter.assetId).not.toBe(targetBefore.assetId);
		// The old content stays in history next to the new one.
		const versionAssetIds = await version_snapshot_asset_ids(runner, targetAfter._id);
		expect(versionAssetIds).toContain(targetBefore.assetId);
		expect(versionAssetIds).toContain(targetAfter.assetId);
		expect(await list_pending_updates_for_node(runner, targetAfter._id)).toHaveLength(0);
		const saved = await runner.run({ command: `cat ${test_db_files_mount}/data/settings.yaml` });
		expect(saved.stdout).toContain("unique-token");
		expect(saved.stdout).not.toContain("a: 1");
	});

	test.each([false, true])(
		"cp carries HTML into a text destination with collaboration off: %s",
		async (nonCollaborative) => {
			const text = "<!doctype html>\n<p>Copied brief</p>\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/data/brief.html", content: text, contentType: "text/html;charset=utf-8" },
					{ path: "/data/target.txt", content: "Old text\n", nonCollaborative, withRealYjsSnapshot: !nonCollaborative },
				],
			});
			const targetBefore = await get_seeded_node(runner, "/data/target.txt");
			const copied = await runner.run({
				command: `cp ${test_db_files_mount}/data/brief.html ${test_db_files_mount}/data/target.txt`,
			});
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stderr).toBe("");
			expect((await get_seeded_node(runner, "/data/target.txt")).contentType).toBe("text/plain;charset=utf-8");

			await accept_pending_replacement_for_test(runner, targetBefore._id);
			const targetAfter = await get_seeded_node(runner, "/data/target.txt");
			expect(targetAfter).toMatchObject({
				_id: targetBefore._id,
				contentType: "text/html;charset=utf-8",
				textKind: "plain_text",
				collaborationEnabled: !nonCollaborative,
			});
			expect(await version_snapshot_asset_ids(runner, targetBefore._id)).toContain(targetBefore.assetId);
			expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
			expect((await runner.run({ command: `cat ${test_db_files_mount}/data/target.txt` })).stdout).toBe(text);
		},
	);

	test("cp onto an existing collaborative file proposes the source's whole file in both directions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{
					path: "/data/plain-target.txt",
					content: "old plain\n",
					contentType: "text/plain;charset=utf-8",
					withRealYjsSnapshot: true,
				},
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const canonicalId = await get_seeded_node_id(runner, "/data/canonical.json");
		const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");
		const plainTarget = await get_seeded_node(runner, "/data/plain-target.txt");

		// JSON onto Markdown: the proposal is the JSON file as a whole, text unchanged.
		const plainToRich = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(plainToRich.stderr).toBe("");
		expect(plainToRich.metadata.exitCode).toBe(0);
		expect(plainToRich.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const richRows = await list_pending_updates_for_node(runner, richTarget._id);
		expect(richRows).toHaveLength(1);
		expect(richRows[0].copiedFrom).toMatchObject({
			target: { kind: "saved", id: canonicalId },
			path: "/data/canonical.json",
		});
		expect(richRows[0].createIntent).toBeUndefined();
		expect(richRows[0].pendingReplacement).toMatchObject({
			contentType: "application/json",
			yjsRootKind: "plain_text",
			baseAssetId: richTarget.assetId,
		});
		const richProposed = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(richProposed.stdout).toBe(plain_copy_canonical);

		// Markdown onto plain text: the same, the other way round.
		const richToPlain = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/plain-target.txt`,
		});
		expect(richToPlain.stderr).toBe("");
		expect(richToPlain.metadata.exitCode).toBe(0);
		expect(richToPlain.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const plainRows = await list_pending_updates_for_node(runner, plainTarget._id);
		expect(plainRows).toHaveLength(1);
		expect(plainRows[0].copiedFrom).toMatchObject({ target: { kind: "saved", id: readmeId }, path: "/docs/readme.md" });
		expect(plainRows[0].pendingReplacement).toMatchObject({
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
		});
		const plainProposed = await runner.run({ command: `cat ${test_db_files_mount}/data/plain-target.txt` });
		expect(plainProposed.stdout).toBe(readme_seed_content);

		// Accepting replaces the file as a whole on the same node: content, type, and shape.
		// Discarding keeps the old file untouched.
		await accept_pending_replacement_for_test(runner, richTarget._id);
		expect(await list_pending_updates_for_node(runner, richTarget._id)).toHaveLength(0);
		const richCommitted = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(richCommitted.stdout).toBe(plain_copy_canonical);
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, plainTarget._id),
		);
		expect(discarded._nay).toBeUndefined();
		expect(await list_pending_updates_for_node(runner, plainTarget._id)).toHaveLength(0);
		const plainKept = await runner.run({ command: `cat ${test_db_files_mount}/data/plain-target.txt` });
		expect(plainKept.stdout).toBe("old plain\n");

		const richAfter = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(richAfter._id).toBe(richTarget._id);
		expect(richAfter.textKind).toBe("plain_text");
		expect(richAfter.contentType).toBe("application/json");
		const plainAfter = await get_seeded_node(runner, "/data/plain-target.txt");
		expect(plainAfter._id).toBe(plainTarget._id);
		expect(plainAfter.textKind).toBe("plain_text");
		expect(plainAfter.contentType).toBe("text/plain;charset=utf-8");
	});

	test("accepting a copy onto a saved collaborative file adds one version for the copy only", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		// A saved collaborative file: its current asset already is its newest version row, the
		// state a finished materialization leaves behind.
		await runner.t.run((ctx) =>
			ctx.db.insert("files_snapshots", {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				fileNodeId: richTarget._id,
				assetId: richTarget.assetId!,
				createdBy: runner.seeded.userId,
				archivedAt: -1,
				contentType: richTarget.contentType!,
				yjsRootKind: "rich_text",
				collaborationEnabled: true,
			}),
		);
		const versionsBefore = await version_snapshot_asset_ids(runner, richTarget._id);

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");
		await accept_pending_replacement_for_test(runner, richTarget._id);

		// No edit past the snapshot, so the old text needs no backup row.
		const versionsAfter = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(versionsAfter).toHaveLength(versionsBefore.length + 1);
		expect(await read_version_text(runner, versionsAfter[versionsAfter.length - 1]!)).toBe(plain_copy_canonical);
	});

	test("accepting a copy keeps the destination's unsaved edits as a version", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		// An edit the materializer has not saved to the content asset yet.
		await push_unsaved_rich_text_edit({ runner, fileNode: richTarget, text: "# Unsaved edit" });

		const versionsBefore = await version_snapshot_asset_ids(runner, richTarget._id);

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");
		await accept_pending_replacement_for_test(runner, richTarget._id);

		// One version for the edited text, then one for the copy.
		const versionsAfter = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(versionsAfter).toHaveLength(versionsBefore.length + 2);
		expect(await read_version_text(runner, versionsAfter[versionsAfter.length - 2]!)).toContain("Unsaved edit");
		expect(await read_committed_text(runner, richTarget._id)).toBe(plain_copy_canonical);
	});

	test("an edit during copy acceptance refuses the old copy and survives a fresh copy", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");
		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");
		const copyRow = (await list_pending_updates_for_node(runner, richTarget._id)).find(
			(row) => row.userId === runner.seeded.userId,
		);
		if (!copyRow) {
			throw new Error("No pending copy");
		}

		// The accept action reads the document state first and writes last. Its first R2 read
		// sits between the two, so an edit pushed there is one the action never saw.
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation();
		if (baseFetch == null) {
			throw new Error("expected the fetch stub to have an implementation");
		}
		let raced = false;
		fetchMock.mockImplementation(async (input, init) => {
			const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!raced && href.includes("/object/")) {
				raced = true;
				await push_unsaved_rich_text_edit({ runner, fileNode: richTarget, text: "# Edit during accept" });
			}
			return await baseFetch(input, init);
		});
		const refused = await runner_as_user(runner).action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: richTarget._id },
			pendingUpdateId: copyRow._id,
			reviewedRevision: copyRow.revision,
		});
		fetchMock.mockImplementation(baseFetch);
		expect(raced).toBe(true);
		expect(refused._nay?.message).toBe(files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE);
		const rowsAfterRefusal = await list_pending_updates_for_node(runner, richTarget._id);
		expect(rowsAfterRefusal.find((row) => row._id === copyRow._id)?.pendingReplacement).toBeDefined();

		// A fresh copy captures the new target version. Acceptance keeps the edit in history.
		const discarded = await runner_as_user(runner).mutation(
			api.files_pending_updates.discard_file_pending_structural,
			await pending_review_for_test(runner, richTarget._id),
		);
		expect(discarded._nay).toBeUndefined();
		const recopied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(recopied.metadata.exitCode, recopied.stderr).toBe(0);
		await accept_pending_replacement_for_test(runner, richTarget._id);
		const versions = await version_snapshot_asset_ids(runner, richTarget._id);
		expect(await read_version_text(runner, versions[versions.length - 2]!)).toContain("Edit during accept");
		expect(await read_committed_text(runner, richTarget._id)).toBe(plain_copy_canonical);
	});

	test("a text write onto a file with a pending copy is refused until the copy is reviewed", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const richTarget = await get_seeded_node(runner, "/docs/rich-target.md");

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");

		// The copy carries the source's type and shape. A text edit on top of it would turn it into
		// a plain edit in the file's old shape, so the write waits for the review.
		const written = await runner.run({ command: `echo edited > ${test_db_files_mount}/docs/rich-target.md` });
		expect(written.metadata.exitCode).not.toBe(0);
		expect(written.stderr).toContain(
			"This file has a pending copy. Accept or discard the copy in Files before writing to the file.",
		);
		const rows = await list_pending_updates_for_node(runner, richTarget._id);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.pendingReplacement).toBeDefined();
		const read = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(read.stdout).toBe(plain_copy_canonical);
	});

	test("cp onto a new path gives the copy the source's type in both directions", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" }],
		});

		// Markdown copied to a .txt name is still Markdown.
		const richToPlain = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/readme-copy.txt`,
		});
		expect(richToPlain.stderr).toBe("");
		expect(richToPlain.metadata.exitCode).toBe(0);
		expect(richToPlain.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const markdownCopy = await get_private_entry(runner, "/data/readme-copy.txt");
		expect(markdownCopy.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			textKind: "rich_text",
			contentType: "text/markdown;charset=utf-8",
		});
		const markdownProposed = await runner.run({ command: `cat ${test_db_files_mount}/data/readme-copy.txt` });
		expect(markdownProposed.stdout).toBe(readme_seed_content);

		// JSON copied to a .md name is still JSON.
		const plainToRich = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/canonical-copy.md`,
		});
		expect(plainToRich.stderr).toBe("");
		expect(plainToRich.metadata.exitCode).toBe(0);
		expect(plainToRich.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const jsonCopy = await get_private_entry(runner, "/docs/canonical-copy.md");
		expect(jsonCopy.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			textKind: "plain_text",
			contentType: "application/json",
		});
		const jsonProposed = await runner.run({ command: `cat ${test_db_files_mount}/docs/canonical-copy.md` });
		expect(jsonProposed.stdout).toBe(plain_copy_canonical);

		// Save publishes the JSON copy. Discard closes the private Markdown copy.
		const jsonSavedId = await save_private_copy_for_test(runner, "/docs/canonical-copy.md");
		expect(await list_pending_updates_for_node(runner, jsonSavedId)).toHaveLength(0);
		const jsonCommitted = await runner.run({ command: `cat ${test_db_files_mount}/docs/canonical-copy.md` });
		expect(jsonCommitted.stdout).toBe(plain_copy_canonical);
		expect((await get_seeded_node(runner, "/docs/canonical-copy.md")).textKind).toBe("plain_text");
		const discarded = await runner_as_user(runner).mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "private", id: markdownCopy.node._id },
			pendingUpdateId: markdownCopy.pendingUpdate._id,
			reviewedRevision: markdownCopy.pendingUpdate.revision,
		});
		expect(discarded._nay).toBeUndefined();
		expect(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", markdownCopy.node._id))).toMatchObject({
			state: "discarded",
		});
		expect(
			(await runner.run({ command: `cat ${test_db_files_mount}/data/readme-copy.txt` })).metadata.exitCode,
		).not.toBe(0);
	});

	test("cp of a plain text file onto a Markdown file keeps the text exactly, before review and after accept", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/notes.txt", content: plain_copy_lossy, contentType: "text/plain;charset=utf-8" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/rich-target.md");

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/notes.txt ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);

		// Nothing is converted: the copy is the plain text file as a whole, so the HTML comment
		// that Markdown would drop stays, in the proposal and in the accepted file.
		const proposed = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(proposed.stdout).toBe(plain_copy_lossy);

		await accept_pending_replacement_for_test(runner, targetId);
		const committed = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(committed.stdout).toBe(plain_copy_lossy);
		const target = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(target.contentType).toBe("text/plain;charset=utf-8");
		expect(target.textKind).toBe("plain_text");
	});

	test("cp keeps CRLF plain text when replacing a Markdown file with collaboration off", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/data/notes.txt",
					content: plain_copy_lossy.replaceAll("\n", "\r\n"),
					contentType: "text/plain;charset=utf-8",
				},
				{ path: "/docs/off-notes.md", content: "old saved\n", nonCollaborative: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/docs/off-notes.md");

		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/notes.txt ${test_db_files_mount}/docs/off-notes.md`,
		});
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(1);

		// The old content stays in history. The source's line endings and comment survive.
		await accept_pending_replacement_for_test(runner, targetBefore._id);
		expect(await list_pending_updates_for_node(runner, targetBefore._id)).toHaveLength(0);
		const targetAfter = await get_seeded_node(runner, "/docs/off-notes.md");
		expect(targetAfter._id).toBe(targetBefore._id);
		const versionAssetIds = await version_snapshot_asset_ids(runner, targetAfter._id);
		expect(versionAssetIds).toContain(targetBefore.assetId);
		expect(versionAssetIds).toContain(targetAfter.assetId);
		expect(targetAfter.contentType).toBe("text/plain;charset=utf-8");
		expect(targetAfter.textKind).toBe("plain_text");
		const saved = await runner.run({ command: `cat ${test_db_files_mount}/docs/off-notes.md` });
		expect(saved.stdout).toBe(plain_copy_lossy.replaceAll("\n", "\r\n"));
	});

	test("cp onto a file with collaboration off still refuses a locked destination, and a member save keeps the copy pending", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/settings.yaml", content: "a: 1\n", contentType: "application/yaml", nonCollaborative: true },
				{ path: "/data/locked.yaml", content: "b: 2\n", contentType: "application/yaml", nonCollaborative: true },
			],
		});
		const lockedId = await get_seeded_node_id(runner, "/data/locked.yaml");
		const savedOverId = await get_seeded_node_id(runner, "/data/settings.yaml");

		// Lock: the copy is refused before anything is staged.
		await runner.t.run((ctx) => ctx.db.patch("files_nodes", lockedId, { writePolicy: { mode: "read_only" } }));
		const locked = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/locked.yaml`,
		});
		expect(locked.metadata.exitCode).not.toBe(0);
		expect(locked.stderr).toContain("read-only");
		const lockedRead = await runner.run({ command: `cat ${test_db_files_mount}/data/locked.yaml` });
		expect(lockedRead.stdout).toBe("b: 2\n");
		expect(await count_version_snapshots(runner, lockedId)).toBe(0);
		expect(await list_pending_updates_for_node(runner, lockedId)).toHaveLength(0);

		// A member saves the file while the copy waits for review. Accept refuses, because the
		// copy was proposed against the older text, and the copy stays pending for the user.
		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/settings.yaml`,
		});
		expect(copied.stderr).toBe("");
		const copyRow = (await list_pending_updates_for_node(runner, savedOverId)).find(
			(row) => row.userId === runner.seeded.userId,
		);
		if (!copyRow) {
			throw new Error("No pending copy");
		}
		const memberSave = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			requestId: "member-before-accept-copy",
			membershipId: runner.seeded.membershipId,
			nodeId: savedOverId,
			text: "someone else: 1\n",
		});
		expect(memberSave._nay).toBeUndefined();
		const refused = await runner_as_user(runner).action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: runner.seeded.membershipId,
			target: { kind: "saved", id: savedOverId },
			pendingUpdateId: copyRow._id,
			reviewedRevision: copyRow.revision,
		});
		expect(refused._nay?.message).toBe(files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE);
		const rowsAfterRefusal = await list_pending_updates_for_node(runner, savedOverId);
		expect(rowsAfterRefusal).toHaveLength(1);
		expect(rowsAfterRefusal[0]!.pendingReplacement).toBeDefined();
		expect(await read_committed_text(runner, savedOverId)).toBe("someone else: 1\n");
	});

	test("a file that received a copy of another content type can turn collaboration off and on again and keep taking edits", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/canonical.json", content: plain_copy_canonical, contentType: "application/json" },
				{ path: "/docs/rich-target.md", content: "old rich\n", withRealYjsSnapshot: true },
			],
		});
		const targetBefore = await get_seeded_node(runner, "/docs/rich-target.md");
		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/data/canonical.json ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(copied.stderr).toBe("");
		expect(copied.metadata.exitCode).toBe(0);
		await accept_pending_replacement_for_test(runner, targetBefore._id);

		const asUser = runner_as_user(runner);
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: runner.seeded.membershipId,
			nodeId: targetBefore._id,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(runner);
		const offNode = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(offNode.collaborationEnabled).toBe(false);
		expect(offNode.yjsSnapshotId).toBeNull();
		expect(offNode.yjsLastSequenceId).toBeNull();
		const offRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(offRead.stdout).toBe(plain_copy_canonical);

		// Back on: a fresh document, not the old one restored, with the same text.
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: runner.seeded.membershipId,
			nodeId: targetBefore._id,
		});
		expect(on._nay).toBeUndefined();
		const onNode = await get_seeded_node(runner, "/docs/rich-target.md");
		expect(onNode.collaborationEnabled).toBe(true);
		// The copy made the file JSON, so the rebuilt document is plain text.
		expect(onNode.textKind).toBe("plain_text");
		expect(onNode.yjsSnapshotId).toBeDefined();
		expect(onNode.yjsSnapshotId).not.toBe(targetBefore.yjsSnapshotId);
		expect(onNode.yjsLastSequenceId).toBeDefined();
		expect(onNode.yjsLastSequenceId).not.toBe(targetBefore.yjsLastSequenceId);
		const onRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/rich-target.md` });
		expect(onRead.stdout).toBe(plain_copy_canonical);

		// The rebuilt document takes a normal edit, accept, and materialization.
		const appended = await runner.run({
			command: `printf '\\ntail line\\n' >> ${test_db_files_mount}/docs/rich-target.md`,
		});
		expect(appended.metadata.exitCode).toBe(0);
		await accept_pending_update_for_test(runner, { nodeId: targetBefore._id, path: "/docs/rich-target.md" });
		const committed = await read_committed_text(runner, targetBefore._id);
		expect(committed).toContain('"deep": true');
		expect(committed).toContain("tail line");
	});

	test("cp no-clobber leaves an existing app destination unchanged", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/no-clobber-target.md", content: "keep me\n", withRealYjsSnapshot: true }],
		});
		const targetId = await get_seeded_node_id(runner, "/docs/no-clobber-target.md");

		for (const flag of ["-n", "--no-clobber"]) {
			const result = await runner.run({
				command: `cp ${flag} ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/no-clobber-target.md`,
			});
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toMatch(
				/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
			);
			expect(result.stderr).toBe("");
		}

		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/docs/no-clobber-target.md` });
		expect(readBack.stdout).toBe("keep me\n");
	});

	test("cp no-clobber leaves a destination created during the command unchanged", async () => {
		const runner = await create_bash_runner();
		const baseImpl = runner.runMutation.getMockImplementation();
		if (baseImpl == null) {
			throw new Error("expected the runner runMutation spy to have an implementation");
		}
		let raced = false;
		runner.runMutation.mockImplementation(async (ref, actionArgs) => {
			if (!raced && function_name_of(ref) === "files_transfer:start_for_agent") {
				raced = true;
				await runner.t.run((ctx) =>
					seed_organization_node({
						ctx,
						scope: {
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							userId: runner.seeded.userId,
						},
						spec: { path: "/docs/raced-target.md", content: "raced content\n", withRealYjsSnapshot: true },
						seedIndex: 999,
					}),
				);
			}
			return await baseImpl(ref, actionArgs);
		});

		const result = await runner.run({
			command: `cp -n ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/raced-target.md`,
		});
		const targetId = await get_seeded_node_id(runner, "/docs/raced-target.md");
		const pendingUpdates = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/docs/raced-target.md` });

		expect(raced).toBe(true);
		expect(result).toMatchObject({ stderr: "", metadata: { exitCode: 0 } });
		expect(result.stdout).toMatch(
			/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(pendingUpdates).toHaveLength(0);
		expect(readBack.stdout).toBe("raced content\n");
	});

	test("cp creates a private file at a path vacated by the user's pending move", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});
		expect(move.metadata.exitCode).toBe(0);
		const tutorialId = await get_seeded_node_id(runner, "/docs/tutorial.md");

		// The vacated path must not become a silent content replacement on the moving node.
		const vacatedCopy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(vacatedCopy.metadata.exitCode, vacatedCopy.stderr).toBe(0);
		const copyDraft = await get_private_entry(runner, "/docs/tutorial.md");
		expect(copyDraft.pendingUpdate.target).toEqual({ kind: "private", id: copyDraft.node._id });

		// The moving node keeps its single move-only pending update doc without attached content.
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", tutorialId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({ destName: "guide.md" });
		expect(rows[0].content).toBeUndefined();

		// The copy and moved source keep separate content and identities.
		const vacatedRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/tutorial.md` });
		expect(vacatedRead.metadata.exitCode).toBe(0);
		expect(vacatedRead.stdout).toContain("# Readme");
		const movedRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/guide.md` });
		expect(movedRead.metadata.exitCode).toBe(0);
		expect(movedRead.stdout).toContain("zeta");

		// A genuinely free path still takes a plain pending copy.
		const freeCopy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/fresh.md`,
		});
		expect(freeCopy.metadata.exitCode).toBe(0);
		expect(freeCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});
});
