import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import {
	test_apply_file_pending_move,
	test_convex,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "../convex/setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import {
	bash_COMMAND_EXIT_USAGE,
	bash_READER_FILE_OPERAND_MAX,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_READ_INLINE_MAX_BYTES,
} from "./bash-utils.ts";
import {
	test_db_files_mount,
	function_name_of,
	big_md_file,
	seed_organization_node,
	create_bash_runner,
	get_seeded_node,
	get_seeded_node_id,
	get_private_entry,
	list_pending_updates,
	upsert_pending_update_for_test,
	runner_as_user,
	pending_review_for_test,
	accept_pending_move_group_for_test,
	accept_pending_replacement_for_test,
	drain_scheduled_continuations,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	describe("resolve", () => {
		test("returns the Bash path for a raw node ID", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
			runner.runQuery.mockClear();
			vi.mocked(fetch).mockClear();

			const result = await runner.run({ command: `resolve '${nodeId}'` });

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
			expect(result.stderr).toBe("");
			expect(result.metadata.observedPaths).toEqual([{ workspace: "current", path: "/docs/readme.md" }]);
			const queries = runner.runQuery.mock.calls.map(([ref]) => function_name_of(ref));
			expect(queries).toContain("files_nodes:get_path_by_id");
			expect(queries.some((name) => name?.startsWith("files_nodes:list"))).toBe(false);
			expect(queries).not.toContain("files_nodes:read_file_content_from_chunks");
			expect(fetch).not.toHaveBeenCalled();
			expect(await list_pending_updates(runner)).toEqual([]);
		});

		test.each(["/docs", "/source.pdf"])("returns the path for %s without reading content", async (path) => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, path);
			vi.mocked(fetch).mockClear();

			const result = await runner.run({ command: `resolve '${nodeId}'` });

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}${path}\n`);
			expect(fetch).not.toHaveBeenCalled();
		});

		test("accepts copied URLs and encoded saved paths without fetching them", async () => {
			const path = "/docs/My 100% café.md";
			const runner = await create_bash_runner({ extraFiles: [{ path, content: "encoded path marker\n" }] });
			const nodeId = await get_seeded_node_id(runner, path);
			vi.mocked(fetch).mockClear();

			for (const reference of [
				`http://localhost:5173/w/personal/home/files?nodeId=${nodeId}`,
				`https://app.example/w/personal/home/files?view=preview&nodeId=${nodeId}#details`,
				`https://other-host.example/w/%70ersonal/%68ome/files?nodeId=${nodeId}`,
				"https://app.example/w/personal/home/files/docs/My%20100%25%20caf%C3%A9.md?view=preview#details",
				`https://app.example/w/personal/home/files/docs/missing.md?nodeId=${nodeId}`,
			]) {
				const result = await runner.run({ command: `resolve '${reference}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe(`${test_db_files_mount}${path}\n`);
				expect(result.metadata.observedPaths).toEqual([{ workspace: "current", path }]);
			}
			expect(fetch).not.toHaveBeenCalled();
		});

		test("resolves private IDs and pendingNodeId links without fetching content", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "printf draft > docs/draft.txt" })).metadata.exitCode).toBe(0);
			const pending = (await list_pending_updates(runner)).find((item) => item.target.kind === "private");
			if (!pending) throw new Error("Missing private file");
			vi.mocked(fetch).mockClear();
			for (const reference of [
				pending.target.id,
				`https://app.example/w/personal/home/files?pendingNodeId=${pending.target.id}`,
			]) {
				const result = await runner.run({ command: `resolve '${reference}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe(`${test_db_files_mount}/docs/draft.txt\n`);
			}
			expect(fetch).not.toHaveBeenCalled();
		});

		test("reports usage mistakes without looking up a node", async () => {
			const runner = await create_bash_runner();
			for (const args of [
				"",
				"--unknown",
				"one two",
				"'http://['",
				"'ftp://app.example/w/personal/home/files?nodeId=one'",
				"'https://app.example/w/personal/home/chat?nodeId=one'",
				"'https://app.example/w/personal/home/files'",
				"'https://app.example/w/personal/home/files?nodeId='",
				"'https://app.example/w/personal/home/files?nodeId=one&nodeId=two'",
				"'https://app.example/w/personal/home/files?nodeId=one&pendingNodeId=two'",
				"'https://app.example/w/personal/home/files?pendingNodeId='",
				"'https://app.example/w/personal/home/files/docs/%ZZ.md'",
				"'https://app.example/w/%E0%A4%A/home/files?nodeId=one'",
			]) {
				runner.runQuery.mockClear();
				const result = await runner.run({ command: `resolve ${args}` });
				expect(result.metadata.exitCode, result.stderr).toBe(bash_COMMAND_EXIT_USAGE);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("resolve:");
				expect(result.metadata.observedPaths).toEqual([]);
				expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:get_path_by_id")).toBe(
					false,
				);
			}
		});

		test("supports help and the end-of-options marker", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");

			const help = await runner.run({ command: "resolve --help" });
			const found = await runner.run({ command: `resolve -- '${nodeId}'` });
			const literalHelp = await runner.run({ command: "resolve -- --help" });

			expect(help.metadata.exitCode).toBe(0);
			expect(help.stdout).toContain("Usage: resolve [--]");
			expect(help.stderr).toBe("");
			expect(help.metadata.observedPaths).toEqual([]);
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
			expect(literalHelp.metadata.exitCode).toBe(1);
			expect(literalHelp.stdout).toBe("");
		});

		test("uses the same unavailable result for invalid, missing, and archived IDs", async () => {
			const runner = await create_bash_runner();
			const archivedId = await get_seeded_node_id(runner, "/reports/summary.md");
			const missingId = await get_seeded_node_id(runner, "/uploaded.md");
			const archived = await runner_as_user(runner).mutation(api.files_nodes.archive_nodes, {
				membershipId: runner.seeded.membershipId,
				nodeIds: [archivedId],
			});
			expect(archived._nay).toBeUndefined();
			await runner.t.run((ctx) => ctx.db.delete("files_nodes", missingId));
			const unavailable = await runner.run({ command: "resolve 'missing'" });

			for (const reference of ["", runner.seeded.userId, missingId, archivedId, files_ROOT_ID]) {
				const result = await runner.run({ command: `resolve '${reference}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
		});

		test("refuses another tenant's ID and URL without returning its path", async () => {
			const runner = await create_bash_runner();
			const other = await create_bash_runner({
				shared: {
					t: runner.t,
					seeded: await runner.t.run((ctx) =>
						test_mocks_fill_db_with.membership(ctx, { organizationName: "other", workspaceName: "elsewhere" }),
					),
				},
				extraFiles: [{ path: "/private-marker.md", content: "private marker\n" }],
			});
			const otherId = await get_seeded_node_id(other, "/private-marker.md");
			const ownId = await get_seeded_node_id(runner, "/docs/readme.md");
			const unavailable = await runner.run({ command: "resolve 'missing'" });

			for (const reference of [
				otherId,
				`https://app.example/w/other/elsewhere/files?nodeId=${otherId}`,
				`https://app.example/w/other/elsewhere/files?nodeId=${ownId}`,
				"https://app.example/w/other/elsewhere/files/docs/readme.md",
			]) {
				const result = await runner.run({ command: `resolve '${reference}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
		});

		test.each([true, false])(
			"works in the app workspace from /tmp with writes enabled: %s",
			async (allowDbFilesMkdir) => {
				const runner = await create_bash_runner({ allowDbFilesMkdir });
				const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
				await runner.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { writePolicy: { mode: "read_only" } }));

				const result = await runner.run({ command: `cd /tmp && resolve '${nodeId}'` });

				expect(result.metadata.exitCode, result.stderr).toBe(0);
				expect(result.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
				expect(result.metadata.nextCwd).toBe("/tmp");
				expect(await list_pending_updates(runner)).toEqual([]);
			},
		);

		test("keeps spaces in quoted substitution and works in a nested shell", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/docs/Space name.md", content: "space marker\n" }],
			});
			const nodeId = await get_seeded_node_id(runner, "/docs/Space name.md");

			const read = await runner.run({ command: `p=$(resolve '${nodeId}') && cat "$p"` });
			const nested = await runner.run({ command: `bash -lc 'resolve "${nodeId}"'` });

			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toBe("space marker\n");
			expect(nested.metadata.exitCode, nested.stderr).toBe(0);
			expect(nested.stdout).toBe(`${test_db_files_mount}/docs/Space name.md\n`);
			expect(nested.metadata.observedPaths).toEqual([{ workspace: "current", path: "/docs/Space name.md" }]);
		});

		test("sees chained moves in the same call and follows discard and accept", async () => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/docs/tutorial.md");
			const moved = await runner.run({
				command:
					`mv docs/tutorial.md docs/guide.md >/dev/null && resolve '${nodeId}' && ` +
					`mv docs/guide.md reports/manual.md >/dev/null && p=$(resolve '${nodeId}') && cat "$p"`,
			});
			expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			expect(moved.stdout).toBe(`${test_db_files_mount}/docs/guide.md\nzeta\nalpha\nALPHA\n`);
			expect((await get_seeded_node(runner, "/docs/tutorial.md"))._id).toBe(nodeId);

			const discarded = await runner_as_user(runner).mutation(
				api.files_pending_updates.discard_file_pending_structural,
				await pending_review_for_test(runner, nodeId),
			);
			expect(discarded._nay).toBeUndefined();
			expect((await runner.run({ command: `resolve '${nodeId}'` })).stdout).toBe(
				`${test_db_files_mount}/docs/tutorial.md\n`,
			);
			expect((await runner.run({ command: "mv docs/tutorial.md reports/manual.md" })).metadata.exitCode).toBe(0);
			const accepted = await test_apply_file_pending_move(
				runner_as_user(runner),
				await pending_review_for_test(runner, nodeId),
			);
			expect(accepted._nay).toBeUndefined();
			expect((await get_seeded_node(runner, "/reports/manual.md"))._id).toBe(nodeId);
			expect((await runner.run({ command: `resolve '${nodeId}'` })).stdout).toBe(
				`${test_db_files_mount}/reports/manual.md\n`,
			);
		});

		test("follows pending ancestor moves for folder and child IDs", async () => {
			const runner = await create_bash_runner();
			const folderId = await get_seeded_node_id(runner, "/docs/nested");
			const childId = await get_seeded_node_id(runner, "/docs/nested/deep.md");
			expect((await runner.run({ command: "mv docs/nested reports/notes" })).metadata.exitCode).toBe(0);

			const folder = await runner.run({ command: `resolve '${folderId}'` });
			const child = await runner.run({ command: `resolve '${childId}'` });

			expect(folder.metadata.exitCode, folder.stderr).toBe(0);
			expect(folder.stdout).toBe(`${test_db_files_mount}/reports/notes\n`);
			expect(child.metadata.exitCode, child.stderr).toBe(0);
			expect(child.stdout).toBe(`${test_db_files_mount}/reports/notes/deep.md\n`);
			expect(child.metadata.observedPaths).toEqual([{ workspace: "current", path: "/reports/notes/deep.md" }]);
		});

		test("keeps a saved path URL attached to its original node during a pending swap", async () => {
			const runner = await create_bash_runner();
			for (const command of [
				"mv docs/tutorial.md swap.md",
				"mv reports/summary.md docs/tutorial.md",
				"mv swap.md reports/summary.md",
			]) {
				const moved = await runner.run({ command });
				expect(moved.metadata.exitCode, moved.stderr).toBe(0);
			}

			const result = await runner.run({
				command: "resolve 'https://app.example/w/personal/home/files/docs/tutorial.md'",
			});

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/reports/summary.md\n`);
			expect(result.metadata.observedPaths).toEqual([{ workspace: "current", path: "/reports/summary.md" }]);
			expect((await runner.run({ command: `cat '${result.stdout.trimEnd()}'` })).stdout).toBe("zeta\nalpha\nALPHA\n");
		});

		test("does not turn a replaced target ID or saved URL into its replacement", async () => {
			const runner = await create_bash_runner();
			const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
			const targetId = await get_seeded_node_id(runner, "/reports/summary.md");
			expect((await runner.run({ command: "mv -f docs/tutorial.md reports/summary.md" })).metadata.exitCode).toBe(0);
			const unavailable = await runner.run({ command: "resolve 'missing'" });

			for (const reference of [targetId, "https://app.example/w/personal/home/files/reports/summary.md"]) {
				const result = await runner.run({ command: `resolve '${reference}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe(unavailable.stderr);
				expect(result.metadata.observedPaths).toEqual([]);
			}
			expect((await runner.run({ command: `resolve '${sourceId}'` })).stdout).toBe(
				`${test_db_files_mount}/reports/summary.md\n`,
			);
		});

		test("hides a pending-deleted folder but keeps a child moved out of it", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/docs/nested/hidden.md", content: "hidden marker\n" }],
			});
			const folderId = await get_seeded_node_id(runner, "/docs/nested");
			const hiddenId = await get_seeded_node_id(runner, "/docs/nested/hidden.md");
			const childId = await get_seeded_node_id(runner, "/docs/nested/deep.md");
			expect((await runner.run({ command: "mv docs/nested/deep.md reports/survivor.md" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "rm -r docs/nested" })).metadata.exitCode).toBe(0);

			for (const nodeId of [folderId, hiddenId]) {
				const result = await runner.run({ command: `resolve '${nodeId}'` });
				expect(result.metadata.exitCode, result.stderr).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.metadata.observedPaths).toEqual([]);
			}
			expect((await runner.run({ command: `resolve '${childId}'` })).stdout).toBe(
				`${test_db_files_mount}/reports/survivor.md\n`,
			);
			const discarded = await runner_as_user(runner).mutation(
				api.files_pending_updates.discard_file_pending_structural,
				await pending_review_for_test(runner, folderId),
			);
			expect(discarded._nay).toBeUndefined();
			expect((await runner.run({ command: `resolve '${hiddenId}'` })).stdout).toBe(
				`${test_db_files_mount}/docs/nested/hidden.md\n`,
			);
		});

		test("is discoverable through which without adding a native executable", async () => {
			const { run } = await create_bash_runner();

			const which = await run({ command: "which resolve" });
			const nativePaths = await run({ command: "du -a /usr/bin" });

			expect(which.metadata.exitCode, which.stderr).toBe(0);
			expect(which.stdout).toBe("/usr/bin/resolve\n");
			expect(nativePaths.metadata.exitCode, nativePaths.stderr).toBe(0);
			expect(nativePaths.stdout).not.toContain("/usr/bin/resolve");
		});
	});

	describe("file", () => {
		test("reports stored types without body, chunk, size, or R2 reads", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/empty.txt", content: "", contentType: "text/plain;charset=utf-8" }],
			});
			runner.runQuery.mockClear();
			runner.runAction.mockClear();
			vi.mocked(fetch).mockClear();

			const result = await runner.run({ command: "file docs/readme.md source.pdf empty.txt docs" });

			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				"docs/readme.md: text/markdown;charset=utf-8\nsource.pdf: application/pdf\nempty.txt: text/plain;charset=utf-8\ndocs: directory\n",
			);
			const queryNames = runner.runQuery.mock.calls.map(([ref]) => function_name_of(ref));
			expect(runner.runAction, "file must not call content or size actions").not.toHaveBeenCalled();
			expect(
				queryNames.filter((name) => name?.includes("chunk") || name?.includes("read_shell_transcript")),
				"file must not read chunks or transcripts",
			).toEqual([]);
			expect(queryNames, "file must not load asset sizes").not.toContain("r2:get_asset_by_id");
			expect(fetch, "file must not fetch bodies from R2").not.toHaveBeenCalled();
		});

		test("supports brief and MIME output without guessing from extensions", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({
				command: "file --mime-type docs/readme.md docs; file --brief --mime-type uploaded.md",
			});
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe("docs/readme.md: text/markdown\ndocs: inode/directory\napplication/octet-stream\n");
		});

		test.each([null, "invalid"])("reports unknown for stored type %s", async (contentType) => {
			const runner = await create_bash_runner();
			const nodeId = await get_seeded_node_id(runner, "/uploaded.md");
			await runner.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { contentType }));
			const result = await runner.run({ command: "file uploaded.md; file -b --mime-type uploaded.md" });
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe("uploaded.md: unknown\nunknown\n");
		});

		test("keeps valid siblings when paths are missing or pending-deleted", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "rm docs/tutorial.md" })).metadata.exitCode).toBe(0);
			const missing = await runner.run({ command: "file missing.md docs/readme.md" });
			const hidden = await runner.run({ command: "file docs/tutorial.md docs/readme.md" });
			for (const result of [missing, hidden]) {
				expect(result.metadata.exitCode).toBe(1);
				expect(result.stdout).toBe("docs/readme.md: text/markdown;charset=utf-8\n");
			}
			expect(hidden.stderr).toBe(missing.stderr.replace("missing.md", "docs/tutorial.md"));
		});

		test("keeps private create and moved metadata in the pending view", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({
				command:
					"printf hello > draft.txt && mv docs/readme.md reports/renamed.txt >/dev/null && file draft.txt reports/renamed.txt",
			});
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				"draft.txt: text/plain;charset=utf-8\nreports/renamed.txt: text/markdown;charset=utf-8\n",
			);
			expect((await get_seeded_node(runner, "/docs/readme.md")).contentType).toBe("text/markdown;charset=utf-8");
		});

		test("follows whole-file replacement types through Discard and Save", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/notes.txt", content: "plain text\n", contentType: "text/plain;charset=utf-8" }],
			});
			const nodeId = await get_seeded_node_id(runner, "/docs/readme.md");
			const copied = await runner.run({ command: "cp notes.txt docs/readme.md >/dev/null && file -b docs/readme.md" });
			expect(copied.metadata.exitCode, copied.stderr).toBe(0);
			expect(copied.stdout).toBe("text/plain;charset=utf-8\n");
			expect((await get_seeded_node(runner, "/docs/readme.md")).contentType).toBe("text/markdown;charset=utf-8");
			const discarded = await runner_as_user(runner).mutation(
				api.files_pending_updates.discard_file_pending_update,
				await pending_review_for_test(runner, nodeId),
			);
			expect(discarded._nay).toBeUndefined();
			expect((await runner.run({ command: "file -b docs/readme.md" })).stdout).toBe("text/markdown;charset=utf-8\n");
			expect((await runner.run({ command: "cp notes.txt docs/readme.md" })).metadata.exitCode).toBe(0);
			await accept_pending_replacement_for_test(runner, nodeId);
			expect((await runner.run({ command: "file -b docs/readme.md" })).stdout).toBe("text/plain;charset=utf-8\n");
		});

		test("keeps each user's private MIME at the same path", async () => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "file-team", workspaceName: "home" }),
			);
			const owner = await create_bash_runner({
				shared: { t, seeded },
				extraFiles: [
					{ path: "/plain.txt", content: "plain\n", contentType: "text/plain;charset=utf-8" },
					{ path: "/data.json", content: "{}\n", contentType: "application/json" },
				],
			});
			const member = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "file-type-member" });
				await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			const other = await create_bash_runner({ shared: { t, seeded: { ...seeded, ...member } } });
			expect((await owner.run({ command: "cp plain.txt private.bin" })).metadata.exitCode).toBe(0);
			expect((await other.run({ command: "cp data.json private.bin" })).metadata.exitCode).toBe(0);

			expect(
				(await owner.run({ command: "file -b private.bin" })).stdout,
				"file must report only the owner's private MIME",
			).toBe("text/plain;charset=utf-8\n");
			expect(
				(await other.run({ command: "file -b private.bin" })).stdout,
				"file must report only the other member's private MIME",
			).toBe("application/json\n");
		});

		test("reads stored MIME from a stale text proposal without preparing it", async () => {
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/stale.txt", content: "saved\n", contentType: "text/plain;charset=utf-8", nonCollaborative: true },
				],
			});
			expect((await runner.run({ command: "printf proposed > stale.txt" })).metadata.exitCode).toBe(0);
			const [proposal] = await list_pending_updates(runner);
			if (!proposal?.content || proposal.content.base.kind !== "asset") throw new Error("Expected a text proposal");
			const nodeId = await get_seeded_node_id(runner, "/stale.txt");
			const saved = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
				membershipId: runner.seeded.membershipId,
				nodeId,
				text: "new saved text\n",
			});
			expect(saved._nay).toBeUndefined();
			expect((await get_seeded_node(runner, "/stale.txt")).assetId).not.toBe(proposal.content.base.assetId);
			runner.runAction.mockClear();

			expect(
				(await runner.run({ command: "file -b stale.txt" })).stdout,
				"a stale text proposal must keep the stored MIME visible",
			).toBe("text/plain;charset=utf-8\n");
			expect(runner.runAction, "file must not prepare a stale proposal").not.toHaveBeenCalled();
			expect(await list_pending_updates(runner), "file must leave the stale proposal unchanged").toEqual([proposal]);
		});

		test("keeps MIME after a partial private Save retains the proposal", async () => {
			vi.useFakeTimers();
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "printf initial > partial.txt" })).metadata.exitCode).toBe(0);
			const draft = await get_private_entry(runner, "/partial.txt");
			await upsert_pending_update_for_test(runner, {
				target: { kind: "private", id: draft.node._id },
				stagedText: "selected\n",
				unstagedText: "remaining\n",
			});
			const prepared = await get_private_entry(runner, "/partial.txt");
			const asUser = runner_as_user(runner);
			const originalAction = asUser.action;
			let checkedBeforeCleanup = false;
			// Observe the selected view between real Save steps.
			vi.spyOn(asUser, "action").mockImplementation(async (ref, actionArgs?) => {
				const result = await originalAction(ref, actionArgs);
				const slot = await runner.t.run((ctx) =>
					ctx.db.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", runner.seeded.organizationId).eq("workspaceId", runner.seeded.workspaceId),
						)
						.unique(),
				);
				if (!checkedBeforeCleanup && slot?.cohortId && slot.visibleView === "after") {
					const raw = await runner.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdate._id));
					if (raw?.target.kind === "private") {
						checkedBeforeCleanup = true;
						expect(
							await runner.t.query(internal.files_nodes.get_path_by_id, {
								organizationId: runner.seeded.organizationId,
								workspaceId: runner.seeded.workspaceId,
								visibilityUserId: runner.seeded.userId,
								nodeId: draft.node._id,
							}),
							"the private ID must keep its published path before cleanup",
						).toBe("/partial.txt");
						expect(
							(await runner.run({ command: "file -b partial.txt" })).stdout,
							"publication must expose the saved MIME before the private header is cleaned up",
						).toBe("text/plain;charset=utf-8\n");
					}
				}
				return result;
			});
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: runner.seeded.membershipId,
				target: { kind: "private", id: draft.node._id },
				pendingUpdateId: draft.pendingUpdate._id,
				reviewedRevision: prepared.pendingUpdate.revision,
			});
			if (saved._nay || !("kind" in saved._yay)) throw new Error("Expected a queued private Save");
			await test_finish_pending_update_run(asUser, saved._yay.runId, { stepwise: true });
			expect(checkedBeforeCleanup, "the check must reach the published private-to-saved window").toBe(true);
			const nodeId = await get_seeded_node_id(runner, "/partial.txt");
			const remainder = await runner.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdate._id));
			expect(remainder?.target).toEqual({ kind: "saved", id: nodeId });
			expect(remainder?.createIntent).toBeUndefined();

			expect(
				(await runner.run({ command: "file -b partial.txt" })).stdout,
				"partial Save must keep the published file's MIME visible",
			).toBe("text/plain;charset=utf-8\n");
		});

		test("stops reporting a private MIME after real expiry", async () => {
			vi.useFakeTimers();
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "printf expiring > expiring.txt" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "file -b expiring.txt" })).stdout).toBe("text/plain;charset=utf-8\n");
			vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
			await runner.t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
			});

			const expired = await runner.run({ command: "file -b expiring.txt" });
			expect(expired.stdout, "an expired private file must expose no MIME").toBe("");
			expect(expired.stderr).toBe("file: cannot stat 'expiring.txt': No such file or directory\n");
			expect(expired.metadata.exitCode).toBe(1);
		});

		test("reports tmp failure without dropping a valid sibling", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({ command: "file /tmp/missing docs/readme.md" });
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("docs/readme.md: text/markdown;charset=utf-8\n");
			expect(result.stderr).toBe("file: cannot stat '/tmp/missing': No such file or directory\n");
		});

		test("refuses app globs without dropping a valid sibling", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({ command: "file 'docs/*.md' source.pdf" });
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("source.pdf: application/pdf\n");
			expect(result.stderr).toContain("app file glob patterns are not supported");
		});

		test("keeps tmp detection, links, and mixed app operands", async () => {
			const runner = await create_bash_runner();
			const setup = await runner.run({
				command: "printf café > /tmp/unicode; ln -s /tmp/missing /tmp/link; printf hi > /tmp/-",
			});
			expect(setup.metadata.exitCode, setup.stderr).toBe(0);
			const result = await runner.run({
				command: "file -b --mime-type /tmp/unicode docs/readme.md /tmp/link; cd /tmp && file -- -",
			});
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stdout).toBe("text/plain\ntext/markdown\ninode/symlink\n");
			const literal = await runner.run({ command: "file ./-" });
			expect(literal.metadata.exitCode, literal.stderr).toBe(0);
			expect(literal.stdout).toBe("./-: ASCII text\n");
		});

		test("does not load lazy transcripts when classifying synthetic files", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "echo ready" })).metadata.exitCode).toBe(0);
			runner.runQuery.mockClear();
			const result = await runner.run({ command: "file /shells /shells/default /shells/default/transcript" });
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(
				"/shells: directory\n/shells/default: directory\n/shells/default/transcript: unknown\n",
			);
			expect(
				runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:read_shell_transcript"),
			).toHaveLength(0);
		});

		test("works through nested shells, xargs, help, and which", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({
				command:
					"bash -lc 'file -b source.pdf'; sh -c 'file -b docs'; printf 'uploaded.md\\n' | xargs file -b; which file",
			});
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe("application/pdf\ndirectory\napplication/octet-stream\n/usr/bin/file\n");
			const help = await runner.run({ command: "file --help" });
			expect(help.metadata.exitCode).toBe(0);
			expect(help.stdout).toContain("App files report stored content types");
		});

		test.each(["", "-", "-- --help", "-i source.pdf", "--mime source.pdf", "-bi source.pdf"])(
			"rejects missing operands and unsupported input: %s",
			async (args) => {
				const runner = await create_bash_runner();
				const result = await runner.run({ command: `file ${args}` });
				expect(result.metadata.exitCode).toBe(args === "-- --help" ? 1 : 2);
				expect(result.stdout).toBe("");
			},
		);
	});

	test("caps the number of app files a single reader command fetches", async () => {
		const { run, runAction } = await create_bash_runner();

		const overCapFiles = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX + 1 },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");
		const atCapFiles = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");

		// The over-cap reads must short-circuit before any content fetch, so assert no
		// runAction before any later run (the at-cap cat below legitimately fetches content).
		const overCap = await run({ command: `cat ${overCapFiles}` });
		expect(overCap.metadata.exitCode).toBe(2);
		expect(overCap.stderr).toContain(
			`cat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX} files per command`,
		);
		expect(overCap.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
		expect(runAction).not.toHaveBeenCalled();

		const headOverCap = await run({ command: `head ${overCapFiles}` });
		const wcOverCap = await run({ command: `wc -l ${overCapFiles}` });
		const statOverCap = await run({ command: `stat ${overCapFiles}` });
		const fileOverCap = await run({ command: `file ${overCapFiles}` });
		const atCap = await run({ command: `cat ${atCapFiles}` });

		expect(headOverCap.metadata.exitCode).toBe(2);
		expect(headOverCap.stderr).toContain(`head: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(wcOverCap.metadata.exitCode).toBe(2);
		expect(wcOverCap.stderr).toContain(`wc: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(statOverCap.metadata.exitCode).toBe(2);
		expect(statOverCap.stderr).toContain(`stat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(fileOverCap.metadata.exitCode).toBe(2);
		expect(fileOverCap.stderr).toContain(`file: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
		expect(atCap.stderr).not.toContain("db-backed file reads are limited");
	});

	test("counts only db-file operands toward the reader cap, not /tmp scratch", async () => {
		const { run } = await create_bash_runner();

		const tmpFiles = Array.from({ length: 20 }, (_, index) => `/tmp/scratch-${index}.txt`).join(" ");
		const dbFileOperands = Array.from(
			{ length: bash_READER_FILE_OPERAND_MAX + 1 },
			(_, index) => `${test_db_files_mount}/doc-${index}.md`,
		).join(" ");

		const result = await run({ command: `cat ${tmpFiles} ${dbFileOperands}` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
	});

	test("pages large files smoothly: cat/head/sed/tail return bounded pages with hints, wc reports counts", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const catResult = await run({ command: `cat ${bigPath}` });
		const wcResult = await run({ command: `wc -l ${bigPath}` });
		const headResult = await run({ command: `head -n 3 ${bigPath}` });
		const sedResult = await run({ command: `sed -n '4,6p' ${bigPath}` });
		const tailResult = await run({ command: `tail -n 3 ${bigPath}` });
		const headOverCap = await run({ command: `head -n 9999 ${bigPath}` });
		const smallStillWorks = await run({ command: `cat ${test_db_files_mount}/docs/readme.md` });

		// cat no longer refuses: it returns a bounded first page on stdout, with the advisory
		// on stderr so it never contaminates a pipe.
		expect(catResult.metadata.exitCode).toBe(0);
		expect(catResult.stdout).toContain("line 1\nline 2");
		expect(catResult.stdout).not.toContain("showing the first");
		expect(catResult.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
		expect(catResult.stderr).toContain(
			`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
		);
		// wc reports the line count (so the agent knows the size).
		expect(wcResult.metadata.exitCode).toBe(0);
		expect(wcResult.stdout).toContain(`1000 ${bigPath}`);
		// head reads first N lines and puts the next-page command on stderr.
		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toContain("line 1\nline 2\nline 3\n");
		expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
		// sed -n 'A,Bp' reads that exact range and puts its continuation on stderr.
		expect(sedResult.metadata.exitCode).toBe(0);
		expect(sedResult.stdout).toContain("line 4\nline 5\nline 6\n");
		expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
		// tail reads the last N lines and puts the partial-view note on stderr.
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
		expect(tailResult.stderr).toContain("tail: showing the last 3 lines");
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
		// head -n beyond the per-page cap clamps (no refusal) and notes it.
		expect(headOverCap.metadata.exitCode).toBe(0);
		expect(headOverCap.stderr).toContain(`showing ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines (per-page cap)`);
		// Files under the cap are unaffected.
		expect(smallStillWorks.metadata.exitCode).toBe(0);
		expect(smallStillWorks.stdout).toContain("# Readme");
	});

	test("cat reads a complete 64 KiB skill with more than 500 lines", async () => {
		const prefix = "---\nname: complete\ndescription: Read the whole file.\n---\n";
		const lines = "instruction\n".repeat(600);
		const content = `${prefix}${lines}${"x".repeat(64 * 1024 - prefix.length - lines.length - 8)}THE_END\n`;
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/.agents/skills/complete/SKILL.md", content }],
		});

		const result = await run({ command: "cat .agents/skills/complete/SKILL.md" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(content);
		expect(result.metadata.stdoutTruncated).toBe(false);
		expect(result.stderr).toBe("");
	});

	test("records only command paths without cwd maintenance or listed descendants", async () => {
		const { run } = await create_bash_runner({ initialCwd: `${test_db_files_mount}/docs` });

		const read = await run({ command: `cat ${test_db_files_mount}/reports/summary.md` });
		const listed = await run({ command: `ls ${test_db_files_mount}/reports` });

		expect(read.metadata.observedPaths).toContainEqual({ workspace: "current", path: "/reports/summary.md" });
		expect(read.metadata.observedPaths).not.toContainEqual({ workspace: "current", path: "/docs" });
		expect(listed.metadata.observedPaths).toContainEqual({ workspace: "current", path: "/reports" });
		expect(listed.metadata.observedPaths).not.toContainEqual({ workspace: "current", path: "/reports/summary.md" });
	});

	test.each([
		"false && value=$(cat reports/missing.md); echo done",
		"bash -c 'false && value=$(cat reports/missing.md); echo done'",
		"printf '%s\\n' 'false && value=$(cat reports/missing.md); echo done' | xargs -I {} bash -c '{}'",
	])("does not record paths probed by shell safety checks: %s", async (command) => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat docs/readme.md > /tmp/read; ${command}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("done\n");
		expect(result.metadata.observedPaths).toContainEqual({ workspace: "current", path: "/docs/readme.md" });
		expect(result.metadata.observedPaths).not.toContainEqual({ workspace: "current", path: "/reports/missing.md" });
	});

	test("follows byte-limited pages without losing file lines", async () => {
		const content = Array.from({ length: 600 }, (_, index) => `${index}: ${"é".repeat(200)}\n`).join("");
		const { run } = await create_bash_runner({ extraFiles: [{ path: "/pages.txt", content }] });
		let command = "cat pages.txt";
		let combined = "";
		for (let page = 0; page < 10; page++) {
			const result = await run({ command });
			expect(result.metadata.exitCode).toBe(0);
			expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(64 * 1024);
			combined += result.stdout;
			const next = /Next page: (sed[^\n]+)/.exec(result.stderr)?.[1];
			if (!next) break;
			command = next;
		}
		expect(combined).toBe(content);
	});

	test("prefix reads keep UTF-8 characters whole and see pending content", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/prefix.txt", content: "head ééé tail", nonCollaborative: true }],
		});
		const read = () =>
			runner.t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				subject: { kind: "user", userId: runner.seeded.userId, plugin: null },
				overlayUserId: runner.seeded.userId,
				path: "/prefix.txt",
				mode: { kind: "prefix", maxBytes: 8 },
			});

		expect(await read()).toMatchObject({ content: "head é", moreLines: true, pendingUpdateId: null });
		const write = await runner.run({ command: "printf 'edit ééé tail' > prefix.txt" });
		expect(write.metadata.exitCode).toBe(0);
		const pending = await read();
		expect(pending).toMatchObject({ content: "edit é", moreLines: true });
		expect(pending?.pendingUpdateId).not.toBeNull();
	});

	test("large cat uses query-only chunk line range reads", async () => {
		const { run, runQuery, runAction } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run({ command: `cat ${bigPath}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("line 1\nline 2");
		expect(result.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
		expect(
			runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks"),
		).toBe(true);
		expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
			false,
		);
	});

	test("prints absolute db-files paths in large-file reader continuations", async () => {
		const { run } = await create_bash_runner({ initialCwd: test_db_files_mount, extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const catResult = await run({ command: "cat big.md" });
		const headResult = await run({ command: "head -n 3 big.md" });
		const tailForwardResult = await run({ command: "tail -n +5 big.md" });
		const sedResult = await run({ command: "sed -n '4,6p' big.md" });
		const tailResult = await run({ command: "tail -n 3 big.md" });

		expect(catResult.stderr).toContain(
			`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
		);
		expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
		expect(tailForwardResult.stderr).toContain(
			`Next page: sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
		);
		expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
	});

	test("does not emit precise reader continuations when the bounded scan is truncated", async () => {
		// Unmaterialized (no chunks) so reads fall back to the bounded leading window, with lines
		// so long the window holds fewer lines than each command requests → scanTruncated.
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/big.md",
					content: `${"A".repeat(49999)}\n${"B".repeat(49999)}\n${"C".repeat(2000)}`,
					materialized: false,
				},
			],
		});
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run({ command: `head -n 3 ${bigPath}` });
		const tailForwardResult = await run({ command: `tail -n +5 ${bigPath}` });
		const sedResult = await run({ command: `sed -n '5,9p' ${bigPath}` });

		for (const result of [headResult, tailForwardResult, sedResult]) {
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Next page:");
			expect(result.stderr).toContain("only");
		}
	});

	test("supports obsolete head and tail line-count flags on large files", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run({ command: `head -5 ${bigPath}` });
		const tailResult = await run({ command: `tail -3 ${bigPath}` });

		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toContain("line 1\nline 2\nline 3\nline 4\nline 5\n");
		expect(headResult.stderr).toContain(`Next page: sed -n '6,10p' ${bigPath}`);
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
		expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
	});

	test("rejects missing and invalid head and tail line counts", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const missingHead = await run({ command: "head -n" });
		const invalidHead = await run({ command: `head -n nope ${readmePath}` });
		const missingTail = await run({ command: "tail --lines" });
		const invalidTail = await run({ command: `tail --lines=nope ${readmePath}` });

		expect(missingHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingHead.stderr).toContain("head: -n requires a value");
		expect(invalidHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidHead.stderr).toContain("head: -n must be an integer line count");
		expect(missingTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(missingTail.stderr).toContain("tail: --lines requires a value");
		expect(invalidTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(invalidTail.stderr).toContain("tail: --lines must be an integer line count");
		for (const result of [missingHead, invalidHead, missingTail, invalidTail]) {
			expect(result.stderr).toContain("Usage:");
		}
	});

	test("supports head tail and wc end-of-options markers for app operands", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-reader.md", content: "dash reader\n" }],
		});

		const headResult = await run({ command: "head -n 1 -- -reader.md" });
		const tailResult = await run({ command: "tail -n +1 -- -reader.md" });
		const wcResult = await run({ command: "wc -c -- -reader.md" });

		expect(headResult.metadata.exitCode).toBe(0);
		expect(headResult.stdout).toBe("dash reader\n");
		expect(tailResult.metadata.exitCode).toBe(0);
		expect(tailResult.stdout).toBe("dash reader\n");
		expect(wcResult.metadata.exitCode).toBe(0);
		expect(wcResult.stdout).toContain(`12 -reader.md`);
	});

	test("rejects byte-range reads for oversized app files with explicit guidance", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const headResult = await run({ command: `head -c 100 ${bigPath}` });
		const tailResult = await run({ command: `tail -c 100 ${bigPath}` });

		expect(headResult.metadata.exitCode).toBe(1);
		expect(headResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
		expect(headResult.stderr).toContain(`wc -c ${bigPath}`);
		expect(tailResult.metadata.exitCode).toBe(1);
		expect(tailResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
		expect(tailResult.stderr).toContain(`wc -c ${bigPath}`);
	});

	test("does not drop non-app operands when a mixed reader command includes a large app file", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		await run({ command: "printf tmp > /tmp/reader-mixed.txt" });
		const result = await run({ command: `head -n 3 ${bigPath} /tmp/reader-mixed.txt` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("over the");
		expect(result.stderr).toContain("inline read limit");
	});

	test("wc over one app file uses the bounded stats path", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [{ path: "/wc/single.md", content: "on two\nthree\nfour x\n" }],
		});

		const result = await run({ command: `wc ${test_db_files_mount}/wc/single.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/single.md`);
		const statsCalls = runAction.mock.calls.filter((call) => {
			const actionArgs = call[1];
			return (
				actionArgs && typeof actionArgs === "object" && "path" in actionArgs && actionArgs.path === "/wc/single.md"
			);
		});
		expect(statsCalls).toHaveLength(1);
	});

	test("wc over multiple app files reports per-file counts plus a total via the bounded stats path", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [
				{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" },
				{ path: "/wc/b.md", content: "abc cd\nef g\n" },
			],
		});

		const result = await run({ command: `wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md` });

		expect(result.metadata.exitCode).toBe(0);
		// Default triad (lines words bytes) per file, then a summed total line.
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
		expect(result.stdout).toContain(`2 4 12 ${test_db_files_mount}/wc/b.md`);
		expect(result.stdout).toContain("5 9 32 total");
		// Each file is counted via the bounded stats action — never a full content read.
		const statsCalls = runAction.mock.calls.filter((call) => {
			const actionArgs = call[1];
			return (
				actionArgs &&
				typeof actionArgs === "object" &&
				"path" in actionArgs &&
				(actionArgs.path === "/wc/a.md" || actionArgs.path === "/wc/b.md")
			);
		});
		expect(statsCalls).toHaveLength(2);

		// -l restricts the columns to the line count; the total still sums.
		const linesOnly = await run({ command: `wc -l ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md` });
		expect(linesOnly.metadata.exitCode).toBe(0);
		expect(linesOnly.stdout).toContain(`3 ${test_db_files_mount}/wc/a.md`);
		expect(linesOnly.stdout).toContain(`2 ${test_db_files_mount}/wc/b.md`);
		expect(linesOnly.stdout).toContain("5 total");

		const combinedLinesWords = await run({
			command: `wc -lw ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`,
		});
		expect(combinedLinesWords.metadata.exitCode).toBe(0);
		expect(combinedLinesWords.stdout).toContain(`3 5 ${test_db_files_mount}/wc/a.md`);
		expect(combinedLinesWords.stdout).toContain(`2 4 ${test_db_files_mount}/wc/b.md`);
		expect(combinedLinesWords.stdout).toContain("5 9 total");

		const combinedCharsBytes = await run({
			command: `wc -mc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`,
		});
		expect(combinedCharsBytes.metadata.exitCode).toBe(0);
		expect(combinedCharsBytes.stdout).toContain(`20 20 ${test_db_files_mount}/wc/a.md`);
		expect(combinedCharsBytes.stdout).toContain(`12 12 ${test_db_files_mount}/wc/b.md`);
		expect(combinedCharsBytes.stdout).toContain("32 32 total");
	});

	test("multi-file wc flags windowed lower bounds and reports missing operands without aborting", async () => {
		// Unmaterialized 12000-byte file with exactly 40 newlines inside the 8192-byte scan
		// window (40 × 204B lines, then one long unterminated line), so counts are lower bounds.
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/wc/windowed.md",
					content: `${`${"x".repeat(203)}\n`.repeat(40)}${"y".repeat(3840)}`,
					materialized: false,
				},
			],
		});

		const result = await run({
			command: `wc -l ${test_db_files_mount}/wc/windowed.md ${test_db_files_mount}/wc/missing.md`,
		});

		// A missing operand reports an error and exit 1, but the readable file still counts.
		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain(`wc: ${test_db_files_mount}/wc/missing.md: No such file or directory`);
		expect(result.stdout).toContain(`40 ${test_db_files_mount}/wc/windowed.md`);
		expect(result.stdout).toContain("40 total");
		// The windowed file makes line/word/char counts lower bounds (bytes stay exact).
		expect(result.stderr).toContain("lower bounds");
	});

	test("multi-file wc uses the readable-sibling advisory for unreadable app operands", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" }],
		});

		const result = await run({ command: `wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/source.pdf` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
		expect(result.stdout).toContain("3 5 20 total");
		expect(result.stderr).toContain("Bash can read editable text files only");
		expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(result.stderr).toContain(`stat -c %s ${test_db_files_mount}/source.pdf`);
	});

	test("tail -n +K reads forward from line K on a large file (not the trailing window)", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run({ command: `tail -n +5 ${bigPath}` });

		expect(result.metadata.exitCode).toBe(0);
		// Forward read from line 5 (not the last lines), bounded to the per-page cap.
		expect(result.stdout).toContain("line 5\nline 6\nline 7\n");
		expect(result.stdout).not.toContain("line 1000");
		// Forward continuation page via sed, anchored at the offset.
		expect(result.stderr).toContain(
			`sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
		);
	});

	test("cat refuses a multi-file concatenation when a member is too large to inline", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;
		const smallPath = `${test_db_files_mount}/docs/readme.md`;

		const result = await run({ command: `cat ${bigPath} ${smallPath}` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stderr).toContain("too large to concatenate");
		// Nothing from the small file is emitted: the refusal happens up front.
		expect(result.stdout).not.toContain("# Readme");
	});

	test("piping a large cat keeps the advisory out of the pipe", async () => {
		const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigPath = `${test_db_files_mount}/big.md`;

		const result = await run({ command: `cat ${bigPath} | cat` });

		// The footer is on stderr, so only the file content flows downstream.
		expect(result.stdout).toContain("line 1");
		expect(result.stdout).not.toContain("showing the first");
	});

	test("large cat reports chunk-unavailable files on stderr only", async () => {
		const { run, runAction } = await create_bash_runner({
			extraFiles: [
				{
					path: "/chunk-unavailable.md",
					content: big_md_file.content,
					materialized: false,
				},
			],
		});
		const bigPath = `${test_db_files_mount}/chunk-unavailable.md`;

		const result = await run({ command: `cat ${bigPath} | grep materialized` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content is not available from materialized chunks");
		expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
			false,
		);
	});

	test("large cat oversize gate uses unsaved edit size, not the committed asset", async () => {
		// Simulates the agent's own large write_file/edit_file edit living in files_pending_updates:
		// the committed asset is tiny, but the current unsaved edit is large. The gate must
		// fire on the edit size, otherwise a multi-MB draft would be pulled inline unguarded.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/draft.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const draftNodeId = await get_seeded_node_id(runner, "/draft.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: draftNodeId },
			unstagedText: Array.from(
				{ length: 400 },
				(_, index) => `line ${index + 1}${index === 300 ? "x".repeat(bash_READ_INLINE_MAX_BYTES) : ""}`,
			).join("\n\n"),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: draftNodeId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /draft.md");
		}
		expect(pendingUpdate.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
		const draftPath = `${test_db_files_mount}/draft.md`;
		runner.runQuery.mockClear();
		runner.runAction.mockClear();

		const result = await runner.run({ command: `cat ${draftPath}` });

		// Gate fired on the unsaved edit size: bounded page on stdout, advisory carrying
		// that byte count on stderr — even though the committed asset is only 10 bytes.
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("line 1\n\nline 2");
		expect(result.stderr).toContain(`is ${pendingUpdate.size} bytes`);
		expect(
			runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks"),
		).toBe(true);
		expect(
			runner.runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range"),
		).toBe(false);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("large cat oversize gate still fires behind a pure move", async () => {
		const runner = await create_bash_runner({ extraFiles: [big_md_file] });

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/big.md ${test_db_files_mount}/renamed-big.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc stores size 0; both cat gates must keep using the committed asset size.
		const multi = await runner.run({
			command: `cat ${test_db_files_mount}/renamed-big.md ${test_db_files_mount}/docs/readme.md`,
		});
		expect(multi.metadata.exitCode).toBe(1);
		expect(multi.stderr).toContain("too large to concatenate");
		expect(multi.stdout).not.toContain("# Readme");

		const single = await runner.run({ command: `cat ${test_db_files_mount}/renamed-big.md` });
		expect(single.metadata.exitCode).toBe(0);
		expect(single.stdout).toContain("line 1\n");
		expect(single.stderr).toContain("showing the first");
	});

	test("sed app line-range fast path supports -- and unreadable source advisories", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const appResult = await run({ command: `sed -n -- '1p' ${readmePath}` });
		const tmpResult = await run({ command: "printf 'one\\ntwo\\n' > /tmp/sed.txt && sed -n '2p' /tmp/sed.txt" });
		const unreadableResult = await run({ command: `sed -n '1p' ${test_db_files_mount}/source.pdf` });
		const zeroResult = await run({ command: `sed -n '0p' ${readmePath}` });
		const negativeResult = await run({ command: `sed -n '-1p' ${readmePath}` });
		const folderResult = await run({ command: `sed -n '1p' ${test_db_files_mount}/docs` });
		const rootResult = await run({ command: `sed -n '1p' ${test_db_files_mount}` });

		expect(appResult.metadata.exitCode).toBe(0);
		expect(appResult.stdout).toBe("# Readme\n");
		expect(tmpResult.metadata.exitCode).toBe(0);
		expect(tmpResult.stdout).toBe("two\n");
		expect(unreadableResult.metadata.exitCode).toBe(1);
		expect(unreadableResult.stderr).toContain("Bash can read editable text files only");
		expect(unreadableResult.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(unreadableResult.stderr).not.toContain("No such file or directory");
		for (const result of [zeroResult, negativeResult]) {
			expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(result.stderr).toContain("invalid line range");
		}
		for (const result of [folderResult, rootResult]) {
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("Is a directory");
		}
	});

	test("allows app exact reads through stream utilities but rejects direct app operands", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/docs/dupes.md", content: "alpha\nzeta\nalpha\n" }],
		});

		const pipeline = await run({
			command: [
				`cat ${test_db_files_mount}/docs/dupes.md | sort | uniq -c`,
				`cat ${test_db_files_mount}/docs/nested/deep.md | cut -d ':' -f 2`,
				`cat ${test_db_files_mount}/docs/readme.md | sed 's/Readme/Guide/'`,
				`cat ${test_db_files_mount}/docs/readme.md | awk '{print $1}'`,
			].join(" && "),
		});
		const directSort = await run({ command: `sort ${test_db_files_mount}/docs/tutorial.md` });
		const directSed = await run({ command: `sed 's/a/b/' ${test_db_files_mount}/docs/tutorial.md` });
		const directAwk = await run({ command: `awk '{print $1}' ${test_db_files_mount}/docs/tutorial.md` });

		expect(pipeline.metadata.exitCode).toBe(0);
		expect(pipeline.stdout).toContain("2 alpha");
		expect(pipeline.stdout).toContain("two");
		expect(pipeline.stdout).toContain("# Guide");
		expect(pipeline.stdout).toContain("#");
		expect(directSort.metadata.exitCode).not.toBe(0);
		expect(directSort.stderr).toContain("db-backed");
		expect(directSort.stderr).toContain("pipe it through cat");
		expect(directSed.metadata.exitCode).not.toBe(0);
		expect(directSed.stderr).toContain("db-backed");
		expect(directSed.stderr).toContain("pipe it through cat");
		expect(directAwk.metadata.exitCode).not.toBe(0);
		expect(directAwk.stderr).toContain("db-backed");
		expect(directAwk.stderr).toContain("pipe it through cat");
	});

	test("does not falsely reject a sed script that merely contains the mount path text", async () => {
		const { run } = await create_bash_runner();

		// The mount path appears inside the sed SCRIPT, not as a file operand; piping via cat
		// must run, not be rejected by an over-broad substring guard.
		const result = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md | sed 's|${test_db_files_mount}|X|'`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(result.stderr).not.toContain("cannot be used as direct operands");
		expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
	});

	test("rejects unsupported app mutations and prevents mixed /tmp partial side effects", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-delete.md", content: "dash delete\n" }],
		});

		const touchReferenceResult = await run({ command: `touch -r ${test_db_files_mount}/docs/readme.md /tmp/from-ref` });
		const cpAppDestResult = await run({
			command: "printf copy > /tmp/copy-src.txt; cp /tmp/copy-src.txt -- -copy-dest.md",
		});
		const cpAppFolderDestResult = await run({
			command: `printf copy > /tmp/native-output.md; cp /tmp/native-output.md ${test_db_files_mount}/docs`,
		});
		const mvResult = await run({
			command: `mv ${test_db_files_mount}/docs/readme.md /tmp/moved.md; cat /tmp/moved.md`,
		});
		const mvAppDestResult = await run({
			command: "printf move > /tmp/move-src.txt; mv /tmp/move-src.txt -- -move-dest.md",
		});
		const mvAppDestSource = await run({ command: "cat /tmp/move-src.txt" });
		const mvAppToAppResult = await run({ command: `mv ${test_db_files_mount}/docs/readme.md renamed.md` });
		const mvGlobResult = await run({ command: `mv '${test_db_files_mount}/docs/*.md' /tmp/moved.md` });
		const mvDashResult = await run({ command: "mv -- -delete.md /tmp/moved-dash.md" });

		expect(touchReferenceResult.metadata.exitCode).not.toBe(0);
		expect(touchReferenceResult.stderr).toContain("reference file");
		expect(cpAppDestResult.metadata.exitCode).not.toBe(0);
		expect(cpAppDestResult.stderr).toContain("only app files can be copied into the app tree");
		expect(cpAppDestResult.stderr).toContain("cat <scratch-file> > -copy-dest.md");
		expect(cpAppFolderDestResult.metadata.exitCode).not.toBe(0);
		expect(cpAppFolderDestResult.stderr).toContain("only app files can be copied into the app tree");
		expect(cpAppFolderDestResult.stderr).toContain("cat <scratch-file> >");
		expect(mvResult.metadata.exitCode).not.toBe(0);
		expect(mvResult.stderr).toContain("all sources and the destination must be app paths");
		expect(mvResult.stderr).toContain("cp");
		expect(mvAppDestResult.metadata.exitCode).not.toBe(0);
		expect(mvAppDestResult.stderr).toContain("all sources and the destination must be app paths");
		expect(mvAppDestSource.metadata.exitCode).toBe(0);
		expect(mvAppDestSource.stdout).toBe("move");
		// App→app mv is no longer a rejection: it records a pending move proposal.
		expect(mvAppToAppResult.metadata.exitCode).toBe(0);
		expect(mvAppToAppResult.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect(mvGlobResult.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(mvGlobResult.stderr).toContain("app file glob patterns are not supported");
		expect(mvGlobResult.stderr).toContain("find");
		expect(mvDashResult.metadata.exitCode).not.toBe(0);
		expect(mvDashResult.stderr).toContain("all sources and the destination must be app paths");
	});

	test.each(["cp", "mv"])("rejects unsupported app %s flags before copy or move work", async (command) => {
		const runner = await create_bash_runner({ initialCwd: test_db_files_mount });
		expect(
			(await runner.run({ command: "printf scratch > /tmp/source.txt && mkdir /tmp/target" })).metadata.exitCode,
		).toBe(0);

		const app = await runner.run({ command: `${command} -v docs/readme.md new.md` });
		expect(app.metadata.exitCode).toBe(2);
		expect(app.stderr).toBe(`${command}: unsupported option '-v'\n`);
		const mixed = await runner.run({ command: `${command} --unknown /tmp/source.txt docs/readme.md /tmp/target` });
		expect(mixed.metadata.exitCode).toBe(2);
		expect(mixed.stderr).toBe(`${command}: unsupported option '--unknown'\n`);
		expect(await list_pending_updates(runner)).toEqual([]);
		expect((await runner.run({ command: "cat new.md" })).metadata.exitCode).not.toBe(0);
		expect((await runner.run({ command: "ls /tmp/target" })).stdout).toBe("");
		expect((await runner.run({ command: "cat /tmp/source.txt" })).stdout).toBe("scratch");

		// Verbose remains valid when every operand belongs to the native scratch filesystem.
		const scratch = await runner.run({ command: `${command} -v /tmp/source.txt /tmp/native.txt` });
		expect(scratch.metadata.exitCode).toBe(0);
		expect((await runner.run({ command: "cat /tmp/native.txt" })).stdout).toBe("scratch");
	});

	test("creates a pending delete proposal for an app file and hides it from later reads", async () => {
		const runner = await create_bash_runner();

		const removed = await runner.run({ command: `rm ${test_db_files_mount}/docs/readme.md` });
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(
			"pending delete created: /docs/readme.md — archives the file when accepted; review in Files\n",
		);

		const readmeId = await get_seeded_node_id(runner, "/docs/readme.md");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			target: { kind: "saved", id: readmeId },
			pendingArchive: { fromPath: "/docs/readme.md" },
			size: 0,
		});
		expect(rows[0]!.threadIds).toEqual([runner.threadId]);

		// The proposer's later reads see the file as gone; listings drop it too.
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/docs/readme.md` });
		expect(readBack.metadata.exitCode).not.toBe(0);
		expect(readBack.stderr).toContain("No such file or directory");
		const listing = await runner.run({ command: `ls ${test_db_files_mount}/docs` });
		expect(listing.stdout).not.toContain("readme.md");

		// A second rm behaves like a real fs: the path is already gone.
		const removedAgain = await runner.run({ command: `rm ${test_db_files_mount}/docs/readme.md` });
		expect(removedAgain.metadata.exitCode).not.toBe(0);
		expect(removedAgain.stderr).toBe(
			`rm: cannot remove '${test_db_files_mount}/docs/readme.md': No such file or directory\n`,
		);
		const removedForced = await runner.run({ command: `rm -f ${test_db_files_mount}/docs/readme.md` });
		expect(removedForced.metadata.exitCode).toBe(0);
		expect(removedForced.stdout).toBe("");
		expect(removedForced.stderr).toBe("");
	});

	test("creates a folder delete proposal with -r and mirrors builtin folder errors", async () => {
		const runner = await create_bash_runner();

		const withoutRecursive = await runner.run({ command: `rm ${test_db_files_mount}/docs` });
		expect(withoutRecursive.metadata.exitCode).not.toBe(0);
		expect(withoutRecursive.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/docs': Is a directory\n`);

		const removed = await runner.run({ command: `rm -r ${test_db_files_mount}/docs` });
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(
			"pending delete created: /docs — archives the folder and its contents when accepted; review in Files\n",
		);

		const docsId = await get_seeded_node_id(runner, "/docs");
		const rows = await list_pending_updates(runner);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: { kind: "saved", id: docsId }, pendingArchive: { fromPath: "/docs" } });

		// The whole subtree reads as gone for the proposer.
		const childRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/tutorial.md` });
		expect(childRead.metadata.exitCode).not.toBe(0);
		expect(childRead.stderr).toContain("No such file or directory");
		const rootListing = await runner.run({ command: `ls ${test_db_files_mount}` });
		expect(rootListing.stdout).not.toContain("docs");
	});

	test("rm on the user's own unaccepted Added file removes it immediately", async () => {
		const runner = await create_bash_runner();

		const created = await runner.run({ command: `printf 'draft\\n' > ${test_db_files_mount}/draft-note.md` });
		expect(created.metadata.exitCode).toBe(0);
		const draft = await get_private_entry(runner, "/draft-note.md");

		const removed = await runner.run({ command: `rm ${test_db_files_mount}/draft-note.md` });
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stderr).toBe("");
		expect(removed.stdout).toBe(`removed '${test_db_files_mount}/draft-note.md'\n`);

		// The draft closes immediately. Its bytes are cleaned up in the background.
		expect(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", draft.node._id))).toMatchObject({
			state: "discarded",
		});
		expect((await runner.run({ command: `cat ${test_db_files_mount}/draft-note.md` })).metadata.exitCode).not.toBe(0);
		const committedNodes = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.ctxData.organizationId)
						.eq("workspaceId", runner.ctxData.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/draft-note.md"),
				)
				.collect(),
		);
		expect(committedNodes).toHaveLength(0);
	});

	test("handles mixed /tmp and app rm operands in order with builtin flag semantics", async () => {
		const runner = await create_bash_runner();

		const prepared = await runner.run({ command: "printf scratch > /tmp/scratch.txt" });
		expect(prepared.metadata.exitCode).toBe(0);
		const removed = await runner.run({ command: `rm -v /tmp/scratch.txt ${test_db_files_mount}/docs/tutorial.md` });
		expect(removed.metadata.exitCode).toBe(0);
		expect(removed.stdout).toBe(
			"removed '/tmp/scratch.txt'\n" +
				"pending delete created: /docs/tutorial.md — archives the file when accepted; review in Files\n",
		);
		const scratchRead = await runner.run({ command: "cat /tmp/scratch.txt" });
		expect(scratchRead.metadata.exitCode).not.toBe(0);

		// A failing operand does not stop later operands (builtin continue-on-error).
		const partial = await runner.run({
			command: `rm ${test_db_files_mount}/missing.md ${test_db_files_mount}/docs/nested/deep.md`,
		});
		expect(partial.metadata.exitCode).not.toBe(0);
		expect(partial.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/missing.md': No such file or directory\n`);
		expect(partial.stdout).toBe(
			"pending delete created: /docs/nested/deep.md — archives the file when accepted; review in Files\n",
		);
	});

	test("keeps Ask-mode, glob, and unknown-option rm safety", async () => {
		const askRunner = await create_bash_runner({ allowDbFilesMkdir: false });
		const askResult = await askRunner.run({ command: `rm ${test_db_files_mount}/docs/readme.md` });
		expect(askResult.metadata.exitCode).not.toBe(0);
		expect(askResult.stderr).toContain("cannot delete app file");
		expect(askResult.stderr).toContain("App file deletes are available in Agent mode");
		expect(askResult.stderr).toContain("path '/docs/readme.md'");
		expect(await list_pending_updates(askRunner)).toHaveLength(0);

		const runner = await create_bash_runner();
		const globResult = await runner.run({ command: `rm '${test_db_files_mount}/docs/*.md'` });
		expect(globResult.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(globResult.stderr).toContain("app file glob patterns are not supported");

		// Unknown options delegate to the builtin, whose parser errors before touching the fs.
		const unknownOption = await runner.run({ command: `rm -i ${test_db_files_mount}/docs/readme.md` });
		expect(unknownOption.metadata.exitCode).not.toBe(0);
		expect(await list_pending_updates(runner)).toHaveLength(0);
	});

	test("covers builtin rm flag forms, root rejection, and same-call visibility", async () => {
		const runner = await create_bash_runner();

		// -f never suppresses the folder error, and the workspace root is never removable.
		const forcedFolder = await runner.run({ command: `rm -f ${test_db_files_mount}/reports` });
		expect(forcedFolder.metadata.exitCode).not.toBe(0);
		expect(forcedFolder.stderr).toBe(`rm: cannot remove '${test_db_files_mount}/reports': Is a directory\n`);
		const root = await runner.run({ command: `rm -r ${test_db_files_mount}` });
		expect(root.metadata.exitCode).not.toBe(0);
		expect(root.stderr).toBe(`rm: cannot remove '${test_db_files_mount}': Operation not permitted\n`);

		// -R, clustered flags, and `--` all keep builtin semantics for app operands.
		const upperRecursive = await runner.run({ command: `rm -R ${test_db_files_mount}/reports` });
		expect(upperRecursive.metadata.exitCode).toBe(0);
		expect(upperRecursive.stdout).toBe(
			"pending delete created: /reports — archives the folder and its contents when accepted; review in Files\n",
		);
		const clustered = await runner.run({ command: `rm -rfv -- ${test_db_files_mount}/docs/nested` });
		expect(clustered.metadata.exitCode).toBe(0);
		expect(clustered.stdout).toBe(
			"pending delete created: /docs/nested — archives the folder and its contents when accepted; review in Files\n",
		);

		// The builtin's parser ignores a boolean long option's value, so --force=false still
		// means force and must be intercepted, not delegated into a silent builtin no-op.
		const booleanForm = await runner.run({
			command: `rm --force=false --recursive=x ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(booleanForm.metadata.exitCode).toBe(0);
		expect(booleanForm.stdout).toBe(
			"pending delete created: /docs/tutorial.md — archives the file when accepted; review in Files\n",
		);

		// Later commands chained in the SAME bash call already see the removed path as gone.
		const sameCall = await runner.run({
			command: `rm ${test_db_files_mount}/docs/readme.md && cat ${test_db_files_mount}/docs/readme.md`,
		});
		expect(sameCall.metadata.exitCode).not.toBe(0);
		expect(sameCall.stdout).toContain("pending delete created: /docs/readme.md");
		expect(sameCall.stderr).toContain("No such file or directory");
	});

	test("copies one exact readable app file to scratch and rejects unreadable app copies", async () => {
		const { run } = await create_bash_runner({
			initialCwd: test_db_files_mount,
			extraFiles: [{ path: "/-dash-copy.md", content: "dash cp\n" }],
		});

		const copied = await run({
			command: `cp ${test_db_files_mount}/docs/readme.md /tmp/readme.md && cat /tmp/readme.md`,
		});
		const dashCopied = await run({ command: "cp -- -dash-copy.md /tmp/dash-copy.md && cat /tmp/dash-copy.md" });
		const dirDestination = await run({
			command: `cp ${test_db_files_mount}/docs/readme.md /tmp && cat /tmp/readme.md`,
		});
		const outsideTmp = await run({ command: `cp ${test_db_files_mount}/docs/readme.md /dev/null` });
		const unreadable = await run({ command: `cp ${test_db_files_mount}/source.pdf /tmp/source.pdf` });

		expect(copied.metadata.exitCode).toBe(0);
		expect(copied.stdout).toContain("unique-token");
		expect(dashCopied.metadata.exitCode).toBe(0);
		expect(dashCopied.stdout).toContain("dash cp");
		expect(dirDestination.metadata.exitCode).toBe(0);
		expect(dirDestination.stdout).toContain("unique-token");
		expect(outsideTmp.metadata.exitCode).not.toBe(0);
		expect(outsideTmp.stderr).toContain("only supports /tmp destinations");
		expect(outsideTmp.stderr).not.toContain("read-only for cp");
		expect(unreadable.metadata.exitCode).not.toBe(0);
		expect(unreadable.stderr).toContain("Bash can read editable text files only");
		expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
	});

	test("cp no-clobber keeps an existing scratch destination", async () => {
		const { run } = await create_bash_runner();
		await run({ command: "printf 'keep me\\n' > /tmp/no-clobber.md" });

		const result = await run({
			command: `cp -n ${test_db_files_mount}/docs/readme.md /tmp/no-clobber.md && cat /tmp/no-clobber.md`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("keep me\n");
		expect(result.stderr).toBe("");
	});

	test("creates a pending move proposal for an app file rename", async () => {
		const runner = await create_bash_runner();
		const docsId = await get_seeded_node_id(runner, "/docs");

		const result = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The committed node stays at the old path; only a move-only pending update doc exists.
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			pendingMove: { destParent: { kind: "saved", id: docsId }, destName: "guide.md", fromPath: "/docs/tutorial.md" },
			size: 0,
		});
		expect(rows[0].content).toBeUndefined();

		// The proposer's later commands see the pending path overlay: the vacated path reads
		// as gone and the claimed destination serves the moved file.
		const oldRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/tutorial.md` });
		expect(oldRead.metadata.exitCode).not.toBe(0);
		expect(oldRead.stderr).toContain("No such file or directory");
		const newRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/guide.md` });
		expect(newRead.metadata.exitCode).toBe(0);
		expect(newRead.stdout).toContain("zeta");
		const newStat = await runner.run({ command: `stat ${test_db_files_mount}/docs/guide.md` });
		expect(newStat.metadata.exitCode).toBe(0);
		expect(newStat.stdout).toContain("regular file");
		const oldStat = await runner.run({ command: `stat ${test_db_files_mount}/docs/tutorial.md` });
		expect(oldStat.metadata.exitCode).not.toBe(0);
		expect(oldStat.stderr).toContain("No such file or directory");
	});

	test("mv back to the original path cancels the pending move", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		const cancelled = await runner.run({
			command: `mv ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(cancelled.metadata.exitCode).toBe(0);
		expect(cancelled.stderr).toBe("");
		expect(cancelled.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// The move-only pending update doc is gone and the file reads at its committed path again.
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(0);
		const restoredRead = await runner.run({ command: `cat ${test_db_files_mount}/docs/tutorial.md` });
		expect(restoredRead.metadata.exitCode).toBe(0);
		expect(restoredRead.stdout).toContain("zeta");
	});

	test("creates pending move proposals into an existing folder and for folders", async () => {
		const runner = await create_bash_runner();
		const reportsId = await get_seeded_node_id(runner, "/reports");

		const fileMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`,
		});
		expect(fileMove.metadata.exitCode).toBe(0);
		expect(fileMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);
		expect(folderMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const nestedId = await get_seeded_node_id(runner, "/docs/nested");
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", nestedId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({
			destParent: { kind: "saved", id: reportsId },
			destName: "nested",
			fromPath: "/docs/nested",
		});
	});

	test("rejects unsupported app move destinations without creating proposals", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/reports/readme.md", content: "occupied\n" }],
		});

		const destFileExists = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(destFileExists.metadata.exitCode).not.toBe(0);
		expect(destFileExists.stderr).toBe("mv: The destination already exists\n");

		const destOccupiedInFolder = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`,
		});
		expect(destOccupiedInFolder.metadata.exitCode).not.toBe(0);
		expect(destOccupiedInFolder.stderr).toBe("mv: The destination already exists\n");

		const multiSource = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports/summary.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(multiSource.metadata.exitCode).not.toBe(0);
		expect(multiSource.stderr).toBe("mv: the destination must be an existing directory\n");

		const missingParent = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/missing/readme.md`,
		});
		expect(missingParent.metadata.exitCode).not.toBe(0);
		expect(missingParent.stderr).toBe("mv: the destination parent is not a directory\n");

		const folderIntoItself = await runner.run({
			command: `mv ${test_db_files_mount}/docs ${test_db_files_mount}/docs/nested`,
		});
		expect(folderIntoItself.metadata.exitCode).not.toBe(0);
		expect(folderIntoItself.stderr).toBe("mv: A folder cannot be transferred inside itself\n");

		const samePath = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme.md`,
		});
		expect(samePath.metadata.exitCode).toBe(0);
		expect(samePath.stdout).toBe("");
		expect(samePath.stderr).toBe("");

		const missingSource = await runner.run({
			command: `mv ${test_db_files_mount}/nope.md ${test_db_files_mount}/reports`,
		});
		expect(missingSource.metadata.exitCode).not.toBe(0);
		expect(missingSource.stderr).toBe(`mv: source '${test_db_files_mount}/nope.md' is not available\n`);

		const rows = await runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(rows).toHaveLength(0);
	});

	test("proposes a structural replace on the source with mv -f between editable files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/replace-me.md", content: "old target\n" },
				{ path: "/docs/nested/readme.md", content: "second source\n" },
				{ path: "/reports/readme.md", content: "occupied\n" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const targetId = await get_seeded_node_id(runner, "/docs/replace-me.md");

		const fileOntoFile = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/replace-me.md`,
		});
		expect(fileOntoFile.stderr).toBe("");
		expect(fileOntoFile.metadata.exitCode).toBe(0);
		expect(fileOntoFile.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		// The proposal is a move on the SOURCE node that replaces the target. The source keeps
		// its identity, type, and history. The target gets no pending update doc.
		const sourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destName: "replace-me.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(sourceRows[0].copiedFrom).toBeUndefined();
		expect(sourceRows[0].content).toBeUndefined();
		const targetRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", targetId))
				.collect(),
		);
		expect(targetRows).toHaveLength(0);

		// The pending move hides its source from the proposer's overlay, so a later mv of the
		// same source path reads as missing (the file is already spoken for).
		const hiddenSource = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/reports`,
		});
		expect(hiddenSource.metadata.exitCode).not.toBe(0);
		expect(hiddenSource.stderr).toBe(`mv: source '${test_db_files_mount}/docs/readme.md' is not available\n`);

		// A folder destination replaces its occupant file through the same -f opt-in
		// (mv into a folder keeps the source name, so the nested readme collides).
		const secondSourceId = await get_seeded_node_id(runner, "/docs/nested/readme.md");
		const occupantId = await get_seeded_node_id(runner, "/reports/readme.md");
		const folderDest = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/nested/readme.md ${test_db_files_mount}/reports`,
		});
		expect(folderDest.metadata.exitCode).toBe(0);
		expect(folderDest.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const secondSourceRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", secondSourceId))
				.collect(),
		);
		expect(secondSourceRows).toHaveLength(1);
		expect(secondSourceRows[0].pendingMove).toMatchObject({
			destName: "readme.md",
			replacesTarget: { kind: "saved", id: occupantId },
		});

		// Folders can never replace a file, even with -f; real mv reports the kind mismatch.
		// (replace-me.md is claimed by the first move above, so a free file stands in here.)
		const folderOntoFile = await runner.run({
			command: `mv -Tf ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/summary.md`,
		});
		expect(folderOntoFile.metadata.exitCode).not.toBe(0);
		expect(folderOntoFile.stderr).toBe("mv: The source and destination types differ\n");
	});

	test("keeps the structural replace for mv -f onto a non-editable file", async () => {
		const runner = await create_bash_runner();
		const sourceId = await get_seeded_node_id(runner, "/docs/readme.md");
		const uploadedId = await get_seeded_node_id(runner, "/uploaded.md");

		// A non-editable target has no version history to keep, so the source's pending update doc
		// records a structural replacement: accepting archives the target and moves the source onto its path.
		const result = await runner.run({
			command: `mv -f ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/uploaded.md`,
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const rows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pendingMove).toMatchObject({
			destName: "uploaded.md",
			replacesTarget: { kind: "saved", id: uploadedId },
		});
	});

	test("replaces an earlier move proposal and mixes with pending content", async () => {
		const runner = await create_bash_runner({
			// The content upsert below reconstructs the live base from the stored snapshot.
			extraFiles: [{ path: "/docs/mixed.md", content: "mixed base\n", withRealYjsSnapshot: true }],
		});
		const sourceId = await get_seeded_node_id(runner, "/docs/tutorial.md");

		const firstMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/first.md`,
		});
		expect(firstMove.metadata.exitCode).toBe(0);
		// The overlay already shows the file at /docs/first.md, so the follow-up mv uses the
		// visible path (the vacated /docs/tutorial.md reads as gone).
		const secondMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/first.md ${test_db_files_mount}/docs/second.md`,
		});
		expect(secondMove.metadata.exitCode).toBe(0);

		// mv after mv replaces the proposal on the same single pending update doc.
		const moveRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", sourceId))
				.collect(),
		);
		expect(moveRows).toHaveLength(1);
		expect(moveRows[0].pendingMove).toMatchObject({ destName: "second.md" });

		// mv after a write_file-style content upsert degrades to one content-plus-move pending update doc.
		const mixedId = await get_seeded_node_id(runner, "/docs/mixed.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: mixedId },
			unstagedText: "edited mixed content\n",
		});

		const mixedMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/mixed.md ${test_db_files_mount}/docs/renamed-mixed.md`,
		});
		expect(mixedMove.metadata.exitCode).toBe(0);
		const mixedRows = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", mixedId))
				.collect(),
		);
		expect(mixedRows).toHaveLength(1);
		expect(mixedRows[0].pendingMove).toMatchObject({ destName: "renamed-mixed.md" });
		expect(mixedRows[0].content?.unstagedStateId).toBeDefined();
		expect(mixedRows[0].size).toBeGreaterThan(0);
	});

	test("reuses a vacated path and reads a moved source through the overlay", async () => {
		const runner = await create_bash_runner();

		const firstMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});
		expect(firstMove.metadata.exitCode).toBe(0);

		// The vacated path reads as free for the proposer, so another mv can claim it.
		const reuseMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(reuseMove.metadata.exitCode).toBe(0);
		expect(reuseMove.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// cp reads the moved source through the overlay at its claimed destination.
		const scratchCopy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/guide.md /tmp/guide-copy.md && cat /tmp/guide-copy.md`,
		});
		expect(scratchCopy.metadata.exitCode).toBe(0);
		expect(scratchCopy.stdout).toContain("zeta");

		const appCopy = await runner.run({
			command: `cp ${test_db_files_mount}/docs/guide.md ${test_db_files_mount}/guide-copy.md`,
		});
		expect(appCopy.metadata.exitCode).toBe(0);
		expect(appCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("proposes and accepts a folder swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/fsc-a", kind: "folder" },
				{ path: "/fsc-a/a-child.md", content: "fsc a child\n" },
				{ path: "/fsc-b", kind: "folder" },
				{ path: "/fsc-b/b-child.md", content: "fsc b child\n" },
			],
		});
		const folderAId = await get_seeded_node_id(runner, "/fsc-a");
		const folderBId = await get_seeded_node_id(runner, "/fsc-b");
		const childAId = await get_seeded_node_id(runner, "/fsc-a/a-child.md");
		const childBId = await get_seeded_node_id(runner, "/fsc-b/b-child.md");

		// The classic 3-step swap: every mv succeeds and leaves a 2-row folder cycle.
		const moveBToTemp = await runner.run({
			command: `mv ${test_db_files_mount}/fsc-b ${test_db_files_mount}/fsc-temp`,
		});
		expect(moveBToTemp.metadata.exitCode).toBe(0);
		const moveAToB = await runner.run({ command: `mv ${test_db_files_mount}/fsc-a ${test_db_files_mount}/fsc-b` });
		expect(moveAToB.metadata.exitCode).toBe(0);
		const closing = await runner.run({ command: `mv ${test_db_files_mount}/fsc-temp ${test_db_files_mount}/fsc-a` });
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Both rows now target each other's committed paths.
		const rowsA = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect(),
		);
		expect(rowsA).toHaveLength(1);
		expect(rowsA[0].pendingMove).toMatchObject({ destName: "fsc-b", fromPath: "/fsc-a" });
		const rowsB = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect(),
		);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0].pendingMove).toMatchObject({ destName: "fsc-a", fromPath: "/fsc-b" });

		// One selected member cannot settle the other member without review.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-folder-swap-accept",
			external_id: runner.seeded.userId,
			email: "bash-folder-swap-accept@test.local",
		});
		const incomplete = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, folderAId));
		expect(incomplete._nay?.name).toBe("needs_review");
		await accept_pending_move_group_for_test(runner, [folderAId, folderBId]);

		// Both folders and their children sit at swapped committed paths, rows settled.
		const movedA = await get_seeded_node(runner, "/fsc-b");
		expect(movedA._id).toBe(folderAId);
		const movedB = await get_seeded_node(runner, "/fsc-a");
		expect(movedB._id).toBe(folderBId);
		const movedChildA = await get_seeded_node(runner, "/fsc-b/a-child.md");
		expect(movedChildA._id).toBe(childAId);
		const movedChildB = await get_seeded_node(runner, "/fsc-a/b-child.md");
		expect(movedChildB._id).toBe(childBId);
		const settledRows = await runner.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect()),
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect()),
		]);
		expect(settledRows).toHaveLength(0);
	});

	test("proposes a mixed file and folder swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/fsc-mix-a.md", content: "fsc mix a\n" },
				{ path: "/fsc-mix-b.md", kind: "folder" },
			],
		});

		const moveFileToTemp = await runner.run({
			command: `mv ${test_db_files_mount}/fsc-mix-a.md ${test_db_files_mount}/fsc-mix-tmp.md`,
		});
		expect(moveFileToTemp.metadata.exitCode).toBe(0);
		const moveFolderToFilePath = await runner.run({
			command: `mv ${test_db_files_mount}/fsc-mix-b.md ${test_db_files_mount}/fsc-mix-a.md`,
		});
		expect(moveFolderToFilePath.metadata.exitCode).toBe(0);

		// The closing mv forms a mixed cycle with a folder member: proposable like any swap.
		const closing = await runner.run({
			command: `mv ${test_db_files_mount}/fsc-mix-tmp.md ${test_db_files_mount}/fsc-mix-b.md`,
		});
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("mv -Tf proposes and accepts replacing an empty folder occupant", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-src", kind: "folder" },
				{ path: "/edr-src/child.md", content: "edr child\n" },
				{ path: "/edr-dst", kind: "folder" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/edr-src");
		const destId = await get_seeded_node_id(runner, "/edr-dst");
		const childId = await get_seeded_node_id(runner, "/edr-src/child.md");

		// Both flags make the replacement explicit.
		const moved = await runner.run({ command: `mv -Tf ${test_db_files_mount}/edr-src ${test_db_files_mount}/edr-dst` });
		expect(moved.stderr).toBe("");
		expect(moved.metadata.exitCode).toBe(0);
		expect(moved.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Accepting through the real mutation archives the empty occupant and moves the subtree.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-edr-accept",
			external_id: runner.seeded.userId,
			email: "bash-edr-accept@test.local",
		});
		const accepted = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, sourceId));
		expect(accepted._nay).toBeUndefined();

		const movedFolder = await get_seeded_node(runner, "/edr-dst");
		expect(movedFolder._id).toBe(sourceId);
		const movedChild = await get_seeded_node(runner, "/edr-dst/child.md");
		expect(movedChild._id).toBe(childId);
		const occupant = await runner.t.run((ctx) => ctx.db.get("files_nodes", destId));
		expect(occupant?.archiveOperationId).toBeDefined();
	});

	test("mv -T without -f refuses an empty folder occupant", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-nf-src", kind: "folder" },
				{ path: "/edr-nf-src/child.md", content: "edr nf child\n" },
				{ path: "/edr-nf-dst", kind: "folder" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/edr-nf-src");
		const destId = await get_seeded_node_id(runner, "/edr-nf-dst");

		// -T alone only says "do not move inside the destination". Replacing it still needs -f.
		const moved = await runner.run({
			command: `mv -T ${test_db_files_mount}/edr-nf-src ${test_db_files_mount}/edr-nf-dst`,
		});
		expect(moved.stderr).toBe("mv: The destination already exists\n");
		expect(moved.metadata.exitCode).not.toBe(0);

		// Nothing is proposed and nothing moves: both folders keep their saved paths.
		expect(await list_pending_updates(runner)).toEqual([]);
		expect((await get_seeded_node(runner, "/edr-nf-src"))._id).toBe(sourceId);
		expect((await get_seeded_node(runner, "/edr-nf-dst"))._id).toBe(destId);
		expect((await runner.t.run((ctx) => ctx.db.get("files_nodes", destId)))?.archiveOperationId).toBeNull();
	});

	test("mv -T onto a non-empty folder fails like rename()", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-full-src", kind: "folder" },
				{ path: "/edr-full", kind: "folder" },
				{ path: "/edr-full/keep.md", content: "edr keep\n" },
				{ path: "/edr-full-file.md", content: "edr file\n" },
			],
		});

		const moved = await runner.run({
			command: `mv -Tf ${test_db_files_mount}/edr-full-src ${test_db_files_mount}/edr-full`,
		});
		expect(moved.metadata.exitCode).not.toBe(0);
		expect(moved.stderr).toBe("mv: Directory not empty\n");

		// A file never replaces a folder, matching rename()'s EISDIR.
		const fileMove = await runner.run({
			command: `mv -Tf ${test_db_files_mount}/edr-full-file.md ${test_db_files_mount}/edr-full`,
		});
		expect(fileMove.metadata.exitCode).not.toBe(0);
		expect(fileMove.stderr).toBe("mv: The source and destination types differ\n");
	});

	test("mv into a folder requires an explicit empty-folder replacement", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-mv-a", kind: "folder" },
				{ path: "/edr-mv-a/child.md", content: "edr mv child\n" },
				{ path: "/edr-into", kind: "folder" },
				{ path: "/edr-into/edr-mv-a", kind: "folder" },
			],
		});

		const moved = await runner.run({ command: `mv ${test_db_files_mount}/edr-mv-a ${test_db_files_mount}/edr-into` });
		expect(moved.stderr).toBe("mv: The destination already exists\n");
		expect(moved.metadata.exitCode).not.toBe(0);
		expect(await list_pending_updates(runner)).toEqual([]);
		const replacement = await runner.run({
			command: `mv -Tf ${test_db_files_mount}/edr-mv-a ${test_db_files_mount}/edr-into/edr-mv-a`,
		});
		expect(replacement.metadata.exitCode, replacement.stderr).toBe(0);
		expect(replacement.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("proposes a pure file swap cycle through a temp name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/r16s-swap-a.md", content: "r16s swap a\n" },
				{ path: "/r16s-swap-b.md", content: "r16s swap b\n" },
			],
		});

		const moveAToTemp = await runner.run({
			command: `mv ${test_db_files_mount}/r16s-swap-a.md ${test_db_files_mount}/r16s-swap-tmp.md`,
		});
		expect(moveAToTemp.metadata.exitCode).toBe(0);
		const moveBToA = await runner.run({
			command: `mv ${test_db_files_mount}/r16s-swap-b.md ${test_db_files_mount}/r16s-swap-a.md`,
		});
		expect(moveBToA.metadata.exitCode).toBe(0);

		// A pure file cycle stays proposable: accept applies the whole cycle atomically.
		const closing = await runner.run({
			command: `mv ${test_db_files_mount}/r16s-swap-tmp.md ${test_db_files_mount}/r16s-swap-b.md`,
		});
		expect(closing.metadata.exitCode).toBe(0);
		expect(closing.stderr).toBe("");
		expect(closing.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Both rows now target each other's committed paths.
		const fileAId = await get_seeded_node_id(runner, "/r16s-swap-a.md");
		const fileBId = await get_seeded_node_id(runner, "/r16s-swap-b.md");
		const rowsA = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", fileAId))
				.collect(),
		);
		expect(rowsA).toHaveLength(1);
		expect(rowsA[0].pendingMove).toMatchObject({ destName: "r16s-swap-b.md", fromPath: "/r16s-swap-a.md" });
		const rowsB = await runner.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", fileBId))
				.collect(),
		);
		expect(rowsB).toHaveLength(1);
		expect(rowsB[0].pendingMove).toMatchObject({ destName: "r16s-swap-a.md", fromPath: "/r16s-swap-b.md" });
	});

	test("still allows a linear folder move chain onto a vacated path", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/r16s-lin-a", kind: "folder" },
				{ path: "/r16s-lin-b", kind: "folder" },
			],
		});

		// B vacates its path, then A claims it: a chain with no cycle stays allowed.
		const moveB = await runner.run({
			command: `mv ${test_db_files_mount}/r16s-lin-b ${test_db_files_mount}/r16s-lin-c`,
		});
		expect(moveB.metadata.exitCode).toBe(0);
		const moveA = await runner.run({
			command: `mv ${test_db_files_mount}/r16s-lin-a ${test_db_files_mount}/r16s-lin-b`,
		});
		expect(moveA.metadata.exitCode).toBe(0);
		expect(moveA.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
	});

	test("mv -T claims a folder path vacated by the same user's pending move", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/edr-vac-a", kind: "folder" },
				{ path: "/edr-vac-a/child.md", content: "edr vac child\n" },
				{ path: "/edr-vac-b", kind: "folder" },
			],
		});
		const folderAId = await get_seeded_node_id(runner, "/edr-vac-a");
		const folderBId = await get_seeded_node_id(runner, "/edr-vac-b");

		// B vacates its path, then -T claims it: the direct rename sees the path as free.
		const moveB = await runner.run({ command: `mv ${test_db_files_mount}/edr-vac-b ${test_db_files_mount}/edr-vac-c` });
		expect(moveB.metadata.exitCode).toBe(0);
		const moveA = await runner.run({
			command: `mv -T ${test_db_files_mount}/edr-vac-a ${test_db_files_mount}/edr-vac-b`,
		});
		expect(moveA.stderr).toBe("");
		expect(moveA.metadata.exitCode).toBe(0);
		expect(moveA.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		// Accepting A first hits the order guard: B still occupies the committed path.
		const asUser = runner.t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-bash-edr-vac",
			external_id: runner.seeded.userId,
			email: "bash-edr-vac@test.local",
		});
		const acceptedAFirst = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, folderAId));
		expect(acceptedAFirst._nay?.name).toBe("needs_review");

		await accept_pending_move_group_for_test(runner, [folderAId, folderBId]);

		const movedA = await get_seeded_node(runner, "/edr-vac-b");
		expect(movedA._id).toBe(folderAId);
		const movedChild = await get_seeded_node(runner, "/edr-vac-b/child.md");
		expect(movedChild.kind).toBe("file");
		const movedB = await get_seeded_node(runner, "/edr-vac-c");
		expect(movedB._id).toBe(folderBId);
		const settledRows = await runner.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderAId))
				.collect()),
			...(await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", folderBId))
				.collect()),
		]);
		expect(settledRows).toHaveLength(0);
	});

	test("overlays pending moves onto ls listings", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/guide.md`,
		});
		expect(move.metadata.exitCode).toBe(0);

		// The destination folder shows the moved file under its new name.
		const destList = await runner.run({ command: `ls ${test_db_files_mount}/reports` });
		expect(destList.metadata.exitCode).toBe(0);
		expect(destList.stdout.trim().split("\n")).toEqual(["guide.md", "summary.md"]);

		// The source folder no longer lists it.
		const sourceList = await runner.run({ command: `ls ${test_db_files_mount}/docs` });
		expect(sourceList.metadata.exitCode).toBe(0);
		expect(sourceList.stdout.trim().split("\n")).toEqual(["nested/", "readme.md"]);

		// A move to the workspace root shows up in the root listing.
		const rootMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/root-readme.md`,
		});
		expect(rootMove.metadata.exitCode).toBe(0);
		const rootList = await runner.run({ command: `ls ${test_db_files_mount}` });
		const rootLines = rootList.stdout.trim().split("\n");
		expect(rootLines).toContain("root-readme.md");
		expect(rootLines).not.toContain("readme.md");

		// The workspace recency view shows the visible path of a moved file.
		const recency = await runner.run({ command: "ls -t --limit 50" });
		expect(recency.stdout).toContain(`${test_db_files_mount}/reports/guide.md`);
		expect(recency.stdout).not.toContain(`${test_db_files_mount}/docs/tutorial.md`);
	});

	test("shows an in-place rename exactly once in listings", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md` });

		const list = await runner.run({ command: `ls ${test_db_files_mount}/docs` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout.trim().split("\n")).toEqual(["guide.md", "nested/", "readme.md"]);
	});

	test("shadows a committed newcomer at a claimed destination in listings", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/claimed.md` });

		// A committed node appears at the claimed path after the proposal. The overlay job then writes
		// the proposer's claim hide of it, so seed through the overlay wrapper and run the job.
		await test_run_with_flush(runner.t, (ctx) =>
			seed_organization_node({
				ctx,
				scope: {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					userId: runner.seeded.userId,
				},
				spec: { path: "/docs/claimed.md", content: "newcomer\n" },
				seedIndex: 99,
			}),
		);
		await drain_scheduled_continuations(runner);

		// The mover appears exactly once; the newcomer stays hidden from the proposer.
		const list = await runner.run({ command: `ls ${test_db_files_mount}/docs` });
		const lines = list.stdout.trim().split("\n");
		expect(lines.filter((line) => line === "claimed.md")).toHaveLength(1);
		expect(lines).not.toContain("tutorial.md");
		const read = await runner.run({ command: `cat ${test_db_files_mount}/docs/claimed.md` });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("zeta");
	});

	test("splices a moved folder's subtree into tree and recursive ls", async () => {
		const runner = await create_bash_runner();

		const move = await runner.run({
			command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`,
		});
		expect(move.metadata.exitCode).toBe(0);

		// The destination parent shows the moved folder with its subtree spliced in.
		const destTree = await runner.run({ command: `tree ${test_db_files_mount}/reports` });
		expect(destTree.metadata.exitCode).toBe(0);
		expect(destTree.stdout).toContain("nested/");
		expect(destTree.stdout).toContain("deep.md");

		// Listing the moved folder itself walks its committed source subtree.
		const movedTree = await runner.run({ command: `tree ${test_db_files_mount}/reports/nested` });
		expect(movedTree.metadata.exitCode).toBe(0);
		expect(movedTree.stdout).toContain("deep.md");

		// The old location is gone from listings.
		const sourceTree = await runner.run({ command: `tree ${test_db_files_mount}/docs` });
		expect(sourceTree.stdout).not.toContain("nested");
		expect(sourceTree.stdout).not.toContain("deep.md");

		const destRecursive = await runner.run({ command: `ls -R ${test_db_files_mount}/reports` });
		expect(destRecursive.metadata.exitCode).toBe(0);
		expect(destRecursive.stdout).toContain(`${test_db_files_mount}/reports/nested/`);
		expect(destRecursive.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		const sourceRecursive = await runner.run({ command: `ls -R ${test_db_files_mount}/docs` });
		expect(sourceRecursive.stdout).not.toContain("deep.md");

		const destFind = await runner.run({ command: `find ${test_db_files_mount}/reports --limit 20` });
		expect(destFind.metadata.exitCode).toBe(0);
		expect(destFind.stdout).toContain(`${test_db_files_mount}/reports/nested/`);
		expect(destFind.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		const sourceFind = await runner.run({ command: `find ${test_db_files_mount}/docs --limit 20` });
		expect(sourceFind.stdout).not.toContain("deep.md");
	});

	test("lists a pending move nested under a moved folder exactly once", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);
		// The follow-up mv uses the moved folder's visible path, nesting one pending move
		// under another.
		const nestedMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports/nested/deep.md ${test_db_files_mount}/reports/nested/renamed.md`,
		});
		expect(nestedMove.metadata.exitCode).toBe(0);

		// Each visible path appears exactly once: the folder splice and the file's own
		// injection must not both emit /reports/nested/renamed.md.
		const destFind = await runner.run({ command: `find ${test_db_files_mount}/reports --limit 20` });
		expect(destFind.metadata.exitCode).toBe(0);
		const findLines = destFind.stdout.trim().split("\n");
		expect(findLines.filter((line) => line === `${test_db_files_mount}/reports/nested/renamed.md`)).toHaveLength(1);
		expect(findLines.filter((line) => line === `${test_db_files_mount}/reports/nested/deep.md`)).toHaveLength(0);

		const destTree = await runner.run({ command: `tree ${test_db_files_mount}/reports` });
		expect(destTree.metadata.exitCode).toBe(0);
		expect(destTree.stdout.match(/renamed\.md/gu) ?? []).toHaveLength(1);
	});

	test("ls -R lists a pending move nested under a moved folder exactly once", async () => {
		const runner = await create_bash_runner();

		const folderMove = await runner.run({
			command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested`,
		});
		expect(folderMove.metadata.exitCode).toBe(0);
		const nestedMove = await runner.run({
			command: `mv ${test_db_files_mount}/reports/nested/deep.md ${test_db_files_mount}/reports/nested/renamed.md`,
		});
		expect(nestedMove.metadata.exitCode).toBe(0);

		// The folder splice and the file's own injection must not both emit renamed.md.
		const destRecursive = await runner.run({ command: `ls -R ${test_db_files_mount}/reports` });
		expect(destRecursive.metadata.exitCode).toBe(0);
		const recursiveLines = destRecursive.stdout.trim().split("\n");
		expect(recursiveLines.filter((line) => line === `${test_db_files_mount}/reports/nested/renamed.md`)).toHaveLength(
			1,
		);
		expect(recursiveLines.filter((line) => line === `${test_db_files_mount}/reports/nested/deep.md`)).toHaveLength(0);
	});

	test("lists a claimed vacated path inside a moved folder exactly once and agrees with cat", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/a/x.md", content: "X body\n" },
				{ path: "/z.md", content: "Z body\n" },
			],
		});

		const folderMove = await runner.run({ command: `mv ${test_db_files_mount}/a ${test_db_files_mount}/b` });
		expect(folderMove.metadata.exitCode).toBe(0);
		const childRename = await runner.run({ command: `mv ${test_db_files_mount}/b/x.md ${test_db_files_mount}/b/y.md` });
		expect(childRename.metadata.exitCode).toBe(0);
		// The child rename vacated /b/x.md, so another file can claim that visible path.
		const claim = await runner.run({ command: `mv ${test_db_files_mount}/z.md ${test_db_files_mount}/b/x.md` });
		expect(claim.metadata.exitCode).toBe(0);

		// Discard the child rename pending update doc (as the pending panel would): only
		// the folder move and the claim remain.
		const childId = await get_seeded_node_id(runner, "/a/x.md");
		await runner.t.run(async (ctx) => {
			const rows = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", childId))
				.collect();
			for (const row of rows) {
				await ctx.db.delete("files_pending_updates", row._id);
			}
		});

		// Listings and exact reads agree: /b/x.md appears exactly once and serves Z's
		// content (the claim shadows the committed child for the proposer).
		const list = await runner.run({ command: `ls ${test_db_files_mount}/b` });
		expect(list.metadata.exitCode).toBe(0);
		const lines = list.stdout.trim().split("\n");
		expect(lines.filter((line) => line === "x.md")).toHaveLength(1);
		// The recency view projects every committed node: the shadowed child must not
		// emit a second /b/x.md line next to the claiming move's line.
		const recency = await runner.run({ command: "ls -t --limit 50" });
		expect(recency.metadata.exitCode).toBe(0);
		const recencyLines = recency.stdout.trim().split("\n");
		expect(recencyLines.filter((line) => line.endsWith(`${test_db_files_mount}/b/x.md`))).toHaveLength(1);
		const read = await runner.run({ command: `cat ${test_db_files_mount}/b/x.md` });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toContain("Z body");
	});
});
