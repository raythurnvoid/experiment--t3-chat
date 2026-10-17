// The cwd, moved folder path and Native Just Bash command tests are in bash.writes_cwd.test.ts, and the cp tests
// from app-to-app cp on are in bash.writes_cp.test.ts, so the files can run at the same time.
import { describe, expect, test } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_apply_file_pending_move, test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import {
	test_db_files_mount,
	function_name_of,
	readme_copy_content,
	create_bash_runner,
	get_seeded_node,
	get_seeded_node_id,
	get_private_entry,
	list_pending_updates,
	list_pending_updates_for_node,
	pending_review_for_test,
	save_private_copy_for_test,
	accept_pending_replacement_for_test,
	read_committed_text,
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
					subject: { kind: "user", userId: runner.seeded.userId, plugin: null },
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
					subject: { kind: "user", userId: member.userId, plugin: null },
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
			// The locked folder exists, so `mkdir -p` has nothing to do, like on any existing folder.
			if (door === "mkdir") expect(refused.metadata.exitCode).toBe(0);
			else expect(refused.metadata.exitCode).not.toBe(0);
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
});
