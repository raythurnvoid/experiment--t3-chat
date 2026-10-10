import { R2 } from "@convex-dev/r2";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE } from "../convex/files_pending_updates.ts";
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
	readme_copy_content,
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
	test("heredoc redirect writes a multi-line pending proposal", async () => {
		const runner = await create_bash_runner();

		const heredoc = await runner.run({
			command: [
				`cat > ${test_db_files_mount}/heredoc.md <<'EOF'`,
				"# Title",
				"",
				"Body line",
				"EOF",
				`cat ${test_db_files_mount}/heredoc.md`,
			].join("\n"),
		});
		expect(heredoc.metadata.exitCode).toBe(0);
		expect(heredoc.stderr).toBe("");
		// A new file's baseline is empty, so the content is stored exactly as written,
		// including the heredoc's trailing newline.
		expect(heredoc.stdout).toBe("# Title\n\nBody line\n");
	});

	test("keeps the trailing newline on new files so appends start a new line", async () => {
		const runner = await create_bash_runner();

		const result = await runner.run({
			command: `printf 'one\\n' > ${test_db_files_mount}/lines.md && printf 'two\\n' >> ${test_db_files_mount}/lines.md && cat ${test_db_files_mount}/lines.md`,
		});
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("one\ntwo\n");
	});

	test("bare redirect truncation becomes a pending empty-content proposal", async () => {
		// Pending upserts fetch the committed base yjs snapshot, so the target needs a real one.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/existing.md", content: "committed body\n", withRealYjsSnapshot: true }],
		});

		const truncated = await runner.run({ command: `> ${test_db_files_mount}/docs/existing.md` });
		expect(truncated.metadata.exitCode).toBe(0);

		// The next bash call still sees the pending truncation; the committed file is untouched.
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/docs/existing.md` });
		expect(readBack.metadata.exitCode).toBe(0);
		expect(readBack.stdout).toBe("");

		const existingNode = await get_seeded_node(runner, "/docs/existing.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: existingNode._id });
	});

	test("touch creates an empty-file pending proposal and is a no-op on existing files", async () => {
		const runner = await create_bash_runner();

		const created = await runner.run({ command: `touch ${test_db_files_mount}/new-note.md` });
		expect(created.metadata.exitCode).toBe(0);
		expect(created.stderr).toBe("");
		expect(created.stdout).toBe("");

		const draft = await get_private_entry(runner, "/new-note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });
		expect(pendingRows[0]!.content?.base).toEqual({ kind: "new" });
		expect((await runner.run({ command: `cat ${test_db_files_mount}/new-note.md` })).stdout).toBe("");

		const existing = await runner.run({ command: `touch ${test_db_files_mount}/docs/readme.md` });
		expect(existing.metadata.exitCode).toBe(0);
		expect(existing.stderr).toBe("");
		// utimes is a no-op for app files: no new proposal on the existing file.
		expect(await list_pending_updates(runner)).toHaveLength(1);
	});

	test("refuses creating a file at a silently normalized path but overwrites an existing normalized target", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/my-note.md", content: "note body\n", withRealYjsSnapshot: true }],
		});
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		// A missing dot-leading target would be created as 'hidden.md'; refuse instead of
		// silently writing a different path than the shell reported success for.
		const dotted = await runner.run({ command: `printf x > ${test_db_files_mount}/.hidden.md` });
		expect(dotted.metadata.exitCode).not.toBe(0);
		expect(dotted.stderr).toContain("app file names are normalized");
		expect(dotted.stderr).toContain(`${test_db_files_mount}/hidden.md`);
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await list_pending_updates(runner)).toHaveLength(0);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);

		// When the normalized name lands on an existing file, that file is the overwrite
		// target (cp's replace-target behavior), not a rejected create.
		const normalizedHit = await runner.run({
			command: `printf replaced > '${test_db_files_mount}/docs/my note.md' && cat ${test_db_files_mount}/docs/my-note.md`,
		});
		expect(normalizedHit.metadata.exitCode).toBe(0);
		// Rendered Markdown text POSIX-terminates the pending content.
		expect(normalizedHit.stdout).toBe("replaced\n");
		const noteNode = await get_seeded_node(runner, "/docs/my-note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: noteNode._id });
		expect(pendingRows[0]!.createIntent).toBeUndefined();
	});

	test("normalizes special file names on new Bash writes without renaming existing files", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/legacy/readme.md", content: "legacy\n", withRealYjsSnapshot: true },
				{ path: "/legacy/readme", content: "legacy bare\n", withRealYjsSnapshot: true },
				{ path: "/legacy/README.md", content: "canonical sibling\n", withRealYjsSnapshot: true },
			],
		});
		for (const [input, path] of [
			["/.agents/skills/one/skill.md", "/.agents/skills/one/SKILL.md"],
			["/instructions/agents.md", "/instructions/AGENTS.md"],
			["/instructions/readme.md", "/instructions/README.md"],
			["/new/readme", "/new/README.md"],
		] as const) {
			const written = await runner.run({ command: `printf 'saved body' > ${test_db_files_mount}${input}` });
			expect(written.metadata.exitCode, written.stderr).toBe(0);
			expect((await get_private_entry(runner, path)).path).toBe(path);
		}
		for (const name of ["readme.md", "readme"]) {
			const nodeId = await get_seeded_node_id(runner, `/legacy/${name}`);
			const existing = await runner.run({ command: `printf 'existing body' > ${test_db_files_mount}/legacy/${name}` });
			expect(existing.metadata.exitCode, existing.stderr).toBe(0);
			expect((await get_seeded_node(runner, `/legacy/${name}`))._id).toBe(nodeId);
		}
		expect((await runner.run({ command: `cat ${test_db_files_mount}/legacy/README.md` })).stdout).toBe(
			"canonical sibling\n",
		);
	});

	test("uses README.md for new bare readme copy and move destinations", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/legacy/readme", content: "legacy\n", withRealYjsSnapshot: true },
				{ path: "/copies", kind: "folder" },
				{ path: "/moved", kind: "folder" },
			],
		});
		for (const destination of ["/copies", "/docs/readme"]) {
			const copied = await runner.run({
				command: `cp ${test_db_files_mount}/legacy/readme ${test_db_files_mount}${destination}`,
			});
			expect(copied.metadata.exitCode, copied.stderr).toBe(0);
		}
		expect((await get_private_entry(runner, "/copies/README.md")).node.name).toBe("README.md");
		expect((await get_private_entry(runner, "/docs/README.md")).node.name).toBe("README.md");
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/legacy/readme ${test_db_files_mount}/moved/readme`,
		});
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(await list_pending_updates(runner)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pendingMove: expect.objectContaining({ destName: "README.md" }) }),
			]),
		);
	});

	test("normalizes special destinations for Bash cp and mv", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/legacy/readme.md", content: "legacy\n", withRealYjsSnapshot: true }],
		});
		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/legacy/readme.md ${test_db_files_mount}/docs/skill.md`,
		});
		expect(copied.metadata.exitCode, copied.stderr).toBe(0);
		expect((await get_private_entry(runner, "/docs/SKILL.md")).path).toBe("/docs/SKILL.md");
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/legacy/readme.md ${test_db_files_mount}/docs/agents.md`,
		});
		expect(moved.metadata.exitCode, moved.stderr).toBe(0);
		expect(await list_pending_updates(runner)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pendingMove: expect.objectContaining({ destName: "AGENTS.md" }) }),
			]),
		);
	});

	test.each(["missing", "literal", "canonical no-clobber"] as const)(
		"cp into a folder resolves special names for a %s child",
		async (destination) => {
			const destinationPath = "/.agents/skills/summarize";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/templates/skill.md", content: "Saved skill body\n", withRealYjsSnapshot: true },
					{ path: destinationPath, kind: "folder" },
					...(destination === "literal"
						? [{ path: `${destinationPath}/skill.md`, content: "Legacy target\n", withRealYjsSnapshot: true }]
						: []),
					...(destination !== "missing"
						? [{ path: `${destinationPath}/SKILL.md`, content: "Canonical sibling\n", withRealYjsSnapshot: true }]
						: []),
				],
			});
			const literalId =
				destination === "literal" ? await get_seeded_node_id(runner, `${destinationPath}/skill.md`) : null;
			const canonicalId =
				destination !== "missing" ? await get_seeded_node_id(runner, `${destinationPath}/SKILL.md`) : null;
			const copied = await runner.run({
				command: `cp ${destination === "canonical no-clobber" ? "-n " : ""}${test_db_files_mount}/templates/skill.md ${test_db_files_mount}${destinationPath}`,
			});
			expect(copied.metadata.exitCode, copied.stderr).toBe(0);
			if (destination === "canonical no-clobber") {
				expect(copied.stdout).toMatch(
					/^Transfer \S+: 0 ready for review, 1 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
				);
				expect(await list_pending_updates(runner)).toEqual([]);
			} else {
				const expectedPath = `${destinationPath}/${literalId ? "skill.md" : "SKILL.md"}`;
				expect(copied.stdout).toMatch(
					/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
				);
				if (literalId) {
					expect((await get_seeded_node(runner, expectedPath))._id).toBe(literalId);
					expect(await list_pending_updates(runner)).toEqual([
						expect.objectContaining({ target: { kind: "saved", id: literalId } }),
					]);
					await accept_pending_replacement_for_test(runner, literalId);
					expect(await read_committed_text(runner, literalId)).toBe("Saved skill body\n");
				} else {
					const draft = await get_private_entry(runner, expectedPath);
					expect(await list_pending_updates(runner)).toEqual([
						expect.objectContaining({ target: { kind: "private", id: draft.node._id } }),
					]);
					const savedId = await save_private_copy_for_test(runner, expectedPath);
					expect(await read_committed_text(runner, savedId)).toBe("Saved skill body\n");
				}
			}
			if (canonicalId) {
				expect((await get_seeded_node(runner, `${destinationPath}/SKILL.md`))._id).toBe(canonicalId);
				expect(await read_committed_text(runner, canonicalId)).toBe("Canonical sibling\n");
			}
			if (!literalId) {
				const literal = await runner.t.query(internal.files_nodes.get_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					visibilityUserId: runner.seeded.userId,
					path: `${destinationPath}/skill.md`,
				});
				expect(literal).toBeNull();
			}
		},
	);

	test.each(["cp folder", "cp file", "write", "mkdir"] as const)(
		"%s refuses a hidden special-name target without changing visible siblings",
		async (door) => {
			const test_db_files_mount = "/home/cloud-usr/w/literal-team/home";
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "literal-team", workspaceName: "home" }),
			);
			const owner = await create_bash_runner({
				shared: { t, seeded },
				extraFiles: [
					{ path: "/templates/skill.md", content: "Source text\n", withRealYjsSnapshot: true },
					{ path: "/destination/skill.md", content: "Hidden legacy text\n", withRealYjsSnapshot: true },
					{ path: "/destination/SKILL.md", content: "Visible sibling\n", withRealYjsSnapshot: true },
					...(door === "mkdir" ? [{ path: "/.agents", kind: "folder" as const }] : []),
				],
			});
			const literalId = await get_seeded_node_id(owner, "/destination/skill.md");
			const canonicalId = await get_seeded_node_id(owner, "/destination/SKILL.md");
			const hiddenPath = door === "mkdir" ? "/.agents" : "/destination/skill.md";
			const hiddenId = await get_seeded_node_id(owner, hiddenPath);
			const member = await owner.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "literal-member" });
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
				await ctx.db.patch("files_nodes", hiddenId, { restrictedScopeNodeId: hiddenId });
				return { userId, membershipId };
			});
			const runner = await create_bash_runner({ shared: { t: owner.t, seeded: { ...owner.seeded, ...member } } });
			expect(
				await runner.t.query(internal.files_nodes.get_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					visibilityUserId: member.userId,
					path: hiddenPath,
				}),
			).toBeNull();
			const command =
				door === "mkdir"
					? `mkdir -p ${test_db_files_mount}/.AGENTS`
					: door === "write"
						? `printf changed > ${test_db_files_mount}/destination/skill.md`
						: `cp ${test_db_files_mount}/templates/skill.md ${test_db_files_mount}/destination${door === "cp file" ? "/skill.md" : ""}`;
			const refused = await runner.run({ command });
			expect(refused.metadata.exitCode).not.toBe(0);
			expect(await list_pending_updates(runner)).toEqual([]);
			expect(await read_committed_text(owner, literalId)).toBe("Hidden legacy text\n");
			expect(await read_committed_text(owner, canonicalId)).toBe("Visible sibling\n");
		},
	);

	test("tee writes app targets as pending proposals", async () => {
		const runner = await create_bash_runner();

		const teed = await runner.run({ command: `printf hi | tee /tmp/out.txt ${test_db_files_mount}/tee-note.md` });
		expect(teed.metadata.exitCode).toBe(0);
		expect(teed.stderr).toBe("");
		expect(teed.stdout).toBe("hi");

		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/tee-note.md && cat /tmp/out.txt` });
		expect(readBack.metadata.exitCode).toBe(0);
		// The app file serves rendered Markdown text (POSIX newline); /tmp keeps the raw bytes.
		expect(readBack.stdout).toBe("hi\nhi");

		const appendTee = await runner.run({ command: `printf ' more' | tee -a ${test_db_files_mount}/tee-note.md` });
		expect(appendTee.metadata.exitCode).toBe(0);
		expect(appendTee.stdout).toBe(" more");
		const appendRead = await runner.run({ command: `cat ${test_db_files_mount}/tee-note.md` });
		expect(appendRead.stdout).toBe("hi\n more\n");

		// A folder target surfaces the real error instead of the builtin's generic message.
		const folderTee = await runner.run({ command: `printf hi | tee ${test_db_files_mount}/docs` });
		expect(folderTee.metadata.exitCode).not.toBe(0);
		expect(folderTee.stderr).toContain("EISDIR");
	});

	test("tee mirrors builtin option handling before writing app targets", async () => {
		const runner = await create_bash_runner();

		// --help and invalid options delegate: the builtin exits before touching any file.
		const help = await runner.run({ command: `printf hi | tee --help ${test_db_files_mount}/tee-opt.md` });
		expect(help.metadata.exitCode).toBe(0);
		expect(help.stdout).toContain("Usage: tee");
		const bogus = await runner.run({ command: `printf hi | tee --bogus ${test_db_files_mount}/tee-opt.md` });
		expect(bogus.metadata.exitCode).not.toBe(0);
		expect(bogus.stderr).toContain("unrecognized option '--bogus'");
		const badCluster = await runner.run({ command: `printf hi | tee -ax ${test_db_files_mount}/tee-opt.md` });
		expect(badCluster.metadata.exitCode).not.toBe(0);
		expect(badCluster.stderr).toContain("invalid option -- 'x'");
		expect(await list_pending_updates(runner)).toHaveLength(0);

		// A clustered append flag still appends instead of silently overwriting.
		const first = await runner.run({ command: `printf hi | tee ${test_db_files_mount}/tee-opt.md` });
		expect(first.metadata.exitCode).toBe(0);
		const clustered = await runner.run({ command: `printf ' more' | tee -aa ${test_db_files_mount}/tee-opt.md` });
		expect(clustered.metadata.exitCode).toBe(0);
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/tee-opt.md` });
		// The rendered Markdown text's trailing newline puts the appended run on its own line.
		expect(readBack.stdout).toBe("hi\n more\n");
	});

	test.each([
		{ name: "data.json", contentType: "application/json", text: '{"port": 9090}' },
		{ name: "brief.html", contentType: "text/html;charset=utf-8", text: "<!doctype html><p>Brief</p>" },
		{ name: "brief.htm", contentType: "text/html;charset=utf-8", text: "<!doctype html><p>Brief</p>" },
	])("redirect into $name stores the bytes exactly", async ({ name, contentType, text }) => {
		const runner = await create_bash_runner();

		const written = await runner.run({ command: `printf '${text}' > ${test_db_files_mount}/${name}` });
		// The named break-on-purpose line: a re-added Markdown-only write gate refuses here.
		expect(written.metadata.exitCode).toBe(0);
		expect(written.stderr).toBe("");

		// Read-back before byte equality: with the fix off, no file exists at this path.
		const draft = await get_private_entry(runner, `/${name}`);
		expect(draft.pendingUpdate.createIntent).toMatchObject({ kind: "text", contentType, textKind: "plain_text" });
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });

		// Byte equality: plain text stores bytes exactly, with no added newline.
		const readBack = await runner.run({ command: `cat ${test_db_files_mount}/${name}` });
		expect(readBack.metadata.exitCode).toBe(0);
		expect(readBack.stdout).toBe(text);
	});

	test("heredoc and append writes to plain text files stay byte-exact", async () => {
		const runner = await create_bash_runner();

		const heredoc = await runner.run({
			command: [
				`cat > ${test_db_files_mount}/config.yaml <<'EOF'`,
				"service: files",
				"ports:",
				"  - 8080",
				"EOF",
				`cat ${test_db_files_mount}/config.yaml`,
			].join("\n"),
		});
		expect(heredoc.metadata.exitCode).toBe(0);
		expect(heredoc.stderr).toBe("");
		expect(heredoc.stdout).toBe("service: files\nports:\n  - 8080\n");

		// `>>` concatenates bytes, so no extra newline appears between the two writes.
		const appended = await runner.run({
			command: `printf 'a,b' > ${test_db_files_mount}/table.csv && printf ',c' >> ${test_db_files_mount}/table.csv && cat ${test_db_files_mount}/table.csv`,
		});
		expect(appended.metadata.exitCode).toBe(0);
		expect(appended.stdout).toBe("a,b,c");

		const yamlDraft = await get_private_entry(runner, "/config.yaml");
		expect(yamlDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "application/yaml",
			textKind: "plain_text",
		});
		const csvDraft = await get_private_entry(runner, "/table.csv");
		expect(csvDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/csv",
			textKind: "plain_text",
		});
	});

	test("an unknown extension and an extensionless name write plain text files", async () => {
		const runner = await create_bash_runner();

		// The name is only a hint for the stored type. An extension the app does not know
		// gives plain text, and the file keeps the name the agent typed.
		const exe = await runner.run({ command: `printf x > ${test_db_files_mount}/tool.exe` });
		expect(exe.stderr).toBe("");
		expect(exe.metadata.exitCode).toBe(0);
		const exeDraft = await get_private_entry(runner, "/tool.exe");
		expect(exeDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
		});

		// No `.md` is added to an extensionless name.
		const extensionless = await runner.run({ command: `printf x > ${test_db_files_mount}/data` });
		expect(extensionless.stderr).toBe("");
		expect(extensionless.metadata.exitCode).toBe(0);
		const dataDraft = await get_private_entry(runner, "/data");
		expect(dataDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
		});
	});

	test("cp keeps the source's type at any destination name", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/data/config.json", content: '{"a": 1}\n' }],
		});

		// The destination name never decides the type: a JSON file copied to a .yaml name is
		// still JSON, and the agent reads the staged copy back right away.
		const subtypeCopy = await runner.run({
			command: `cp ${test_db_files_mount}/data/config.json ${test_db_files_mount}/data/config.yaml && cat ${test_db_files_mount}/data/config.yaml`,
		});
		expect(subtypeCopy.metadata.exitCode).toBe(0);
		expect(subtypeCopy.stderr).toBe("");
		expect(subtypeCopy.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n/,
		);
		expect(subtypeCopy.stdout.split("Review in Files.\n")[1]).toBe('{"a": 1}\n');
		const yamlDraft = await get_private_entry(runner, "/data/config.yaml");
		expect(yamlDraft.pendingUpdate.createIntent).toMatchObject({
			contentType: "application/json",
			textKind: "plain_text",
		});

		// Markdown copied to a .json name stays Markdown, text unchanged.
		const markdownToJson = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/data/copy.json && cat ${test_db_files_mount}/data/copy.json`,
		});
		expect(markdownToJson.stderr).toBe("");
		expect(markdownToJson.metadata.exitCode).toBe(0);
		expect(markdownToJson.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n/,
		);
		expect(markdownToJson.stdout.split("Review in Files.\n")[1]).toBe(readme_copy_content);
		const jsonDraft = await get_private_entry(runner, "/data/copy.json");
		expect(jsonDraft.pendingUpdate.copiedFrom).toMatchObject({ path: "/docs/readme.md" });
		expect(jsonDraft.pendingUpdate.createIntent).toMatchObject({
			kind: "text",
			contentType: "text/markdown;charset=utf-8",
			textKind: "rich_text",
		});
	});

	test.each([
		{ source: "notes.json", destination: "notes.yaml", extension: "yaml", contentType: "application/json" },
		{ source: "notes.txt", destination: "notes.html", extension: "html", contentType: "text/plain;charset=utf-8" },
	])(
		"mv renames $source to $destination and accepting keeps the stored type",
		async ({ source, destination, extension, contentType }) => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: `/data/${source}`, content: '{"note": true}\n' }],
			});
			const nodeId = await get_seeded_node_id(runner, `/data/${source}`);

			const moved = await runner.run({
				command: `mv ${test_db_files_mount}/data/${source} ${test_db_files_mount}/data/${destination}`,
			});
			expect(moved.metadata.exitCode).toBe(0);
			expect(moved.stdout).toMatch(
				/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
			);

			const asUser = runner.t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-bash-subtype-rename-accept",
				external_id: runner.seeded.userId,
				email: "bash-subtype-rename-accept@test.local",
			});
			const accepted = await test_apply_file_pending_move(asUser, await pending_review_for_test(runner, nodeId));
			expect(accepted._nay).toBeUndefined();

			// The accept patches the name and the extension index. The stored type stays: a rename
			// never changes what the file is.
			const renamed = await runner.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(renamed?.name).toBe(destination);
			expect(renamed?.path).toBe(`/data/${destination}`);
			expect(renamed?.lowercaseExtension).toBe(extension);
			expect(renamed?.contentType).toBe(contentType);
			expect(renamed?.textKind).toBe("plain_text");
		},
	);

	test("renames keep the stored type for any extension, and mv -f across types proposes a structural replace", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/data/notes.json", content: '{"note": true}\n' },
				{ path: "/data/other.json", content: '{"other": true}\n' },
				{ path: "/docs/target.md", content: "target body\n" },
			],
		});
		const sourceId = await get_seeded_node_id(runner, "/data/notes.json");
		const targetId = await get_seeded_node_id(runner, "/docs/target.md");

		// The name never decides the type, so a rename across extensions is a plain move.
		const plainToMd = await runner.run({
			command: `mv ${test_db_files_mount}/data/other.json ${test_db_files_mount}/data/other.md`,
		});
		expect(plainToMd.stderr).toBe("");
		expect(plainToMd.metadata.exitCode).toBe(0);
		expect(plainToMd.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);

		const mdToJson = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme.json`,
		});
		expect(mdToJson.stderr).toBe("");
		expect(mdToJson.metadata.exitCode).toBe(0);

		// mv -f between files of different types is the same structural replace as any other
		// mv -f: the source moves onto the path with its own type, and the target is archived.
		const crossReplace = await runner.run({
			command: `mv -f ${test_db_files_mount}/data/notes.json ${test_db_files_mount}/docs/target.md`,
		});
		expect(crossReplace.stderr).toBe("");
		expect(crossReplace.metadata.exitCode).toBe(0);
		expect(crossReplace.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		const sourceRows = await list_pending_updates_for_node(runner, sourceId);
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0].pendingMove).toMatchObject({
			destName: "target.md",
			replacesTarget: { kind: "saved", id: targetId },
		});
		expect(await list_pending_updates_for_node(runner, targetId)).toHaveLength(0);

		// A stored upload may change its extension too. The type stays with the bytes.
		const extensionChange = await runner.run({
			command: `mv ${test_db_files_mount}/source.pdf ${test_db_files_mount}/video.mp4`,
		});
		expect(extensionChange.stderr).toBe("");
		expect(extensionChange.metadata.exitCode).toBe(0);
		expect(extensionChange.stdout).toMatch(
			/^Transfer \S+: 1 ready for review, 0 skipped, 0 failed\. Activity \S+\. Review in Files\.\n$/,
		);
		expect((await runner.run({ command: `stat ${test_db_files_mount}/video.mp4` })).metadata.exitCode).toBe(0);
	});

	test("an oversized redirect refuses the content and leaves the new file empty", async () => {
		const runner = await create_bash_runner();

		// The shell's own output budget stops this well before the app's 900,000-byte file limit,
		// because since just-bash 3.4 the bytes a redirection writes are charged to that budget too.
		// So this is the refusal an agent actually meets when it writes too much to an app file.
		const result = await runner.run({ command: `printf '%0300000d' 1 > ${test_db_files_mount}/big.md` });
		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("limit exceeded");

		// `>` truncates its target when the shell opens it, before the command that fills it runs.
		// For a path with no file yet that open is itself a write, so it proposes the new file as an
		// empty placeholder, the same one any new-file write creates. The refused content never
		// lands, so the proposal stays empty and the user discards it like any other proposal.
		const pendingNodes = await runner.t.run(async (ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(pendingNodes.map((node) => node.name)).toEqual(["big.md"]);
		expect((await runner.run({ command: `wc -c ${test_db_files_mount}/big.md` })).stdout).toBe(
			`0 ${test_db_files_mount}/big.md\n`,
		);
		expect((await list_pending_updates(runner)).map((update) => update.size)).toEqual([0]);

		// The refusal still commits nothing to the shared tree.
		const orphan = await runner.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", runner.seeded.organizationId)
						.eq("workspaceId", runner.seeded.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/big.md")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		expect(orphan).toBeNull();
	});

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

	test.each(["file", "folder"])("archive acceptance releases a copied replacement under a deleted %s", async (kind) => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/copied/existing.md", content: "keep this saved version\n" }],
		});
		const targetBefore = await get_seeded_node(runner, "/copied/existing.md");
		const archivedId = kind === "file" ? targetBefore._id : await get_seeded_node_id(runner, "/copied");
		const result = await runner.run({
			command: `cp docs/readme.md copied/existing.md; rm ${kind === "folder" ? "-r copied" : "copied/existing.md"}`,
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
		const accepted = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
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
		expect(plainProposed.stdout).toBe(readme_copy_content);

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
		expect(markdownProposed.stdout).toBe(readme_copy_content);

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
		// Each of the three attempts writes content and a Yjs snapshot.
		expect(failedUploads).toBe(6);
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

	test("keeps the Unix file command unavailable", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "printf hi > /tmp/a.txt && file /tmp/a.txt" });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("file: command not found");
		expect(result.stderr).toContain("run 'help'");
		expect(result.stderr).toContain(
			"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
		);
	});

	test("ignores shell comment lines when hinting unavailable file commands", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: "# Try file (intentionally unavailable)\nprintf hi > /tmp/a.txt\nfile /tmp/a.txt",
		});

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("file: command not found");
		expect(result.stderr).toContain(
			"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
		);
		expect(result.stderr).not.toContain("stat '(intentionally'");
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
