// Find, grep, Ask mode and write tests over pending proposals. Resolve, reader, rm, cp, mv and listing
// tests are in bash.files.test.ts.
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { bash_COMMAND_EXIT_FAILURE, bash_COMMAND_EXIT_USAGE } from "./bash-utils.ts";
import { ai_chat_tool_create_edit_file, ai_chat_tool_create_set_file_metadata } from "./server-ai-tools.ts";
import {
	test_db_files_mount,
	function_name_of,
	create_bash_runner,
	get_seeded_node,
	get_private_entry,
	list_pending_updates,
	upsert_pending_update_for_test,
	runner_as_user,
	list_pending_updates_for_node,
	save_pending_update_for_test,
	accept_pending_update_for_test,
	read_committed_text,
	drain_scheduled_continuations,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	test("find matches moved files by their visible name only", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/word lesson.md", content: "word search fixture\n" }],
		});

		// mv normalizes app file names, so the visible destination becomes word-guide.md.
		await runner.run({
			command: `mv '${test_db_files_mount}/docs/word lesson.md' '${test_db_files_mount}/docs/word guide.md'`,
		});

		// The NEW name finds the moved file at its visible path, from the place search. convex-test
		// splits names on whitespace only, so the query is the start of `word-guide.md`.
		const byNewName = await runner.run({ command: "find -name word --limit 10" });
		expect(byNewName.metadata.exitCode).toBe(0);
		expect(byNewName.stdout).toContain(`${test_db_files_mount}/docs/word-guide.md`);
		expect(byNewName.stdout).not.toContain("word lesson.md");

		// The old name no longer matches: the committed-index hit projects to the new
		// name and fails the re-check.
		const byOldName = await runner.run({ command: "find -name lesson --limit 10" });
		expect(byOldName.metadata.exitCode).toBe(0);
		expect(byOldName.stderr.trim()).toBe("0 matches.");
	});

	test("find -name refuses a folder deeper than the saved ancestor fields", async () => {
		const deep = Array.from({ length: 13 }, (_, index) => `d${index + 1}`).join("/");
		const runner = await create_bash_runner({ extraFiles: [{ path: `/${deep}`, kind: "folder" }] });

		const result = await runner.run({ command: `find ${test_db_files_mount}/${deep} -name x` });
		expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_FAILURE);
		expect(result.stderr).toBe("find: This folder is too deep to search inside. Search a folder higher up.\n");

		// One level up still searches.
		const parent = deep.slice(0, deep.lastIndexOf("/"));
		const ok = await runner.run({ command: `find ${test_db_files_mount}/${parent} -name d13` });
		expect(ok.metadata.exitCode).toBe(0);
		expect(ok.stdout).toContain(`${test_db_files_mount}/${deep}/`);
	});

	test("find -name finds files inside a folder moved into the search folder", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/outside/inner/movedin.md", content: "moved in\n" }],
		});
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/outside/inner ${test_db_files_mount}/docs/inner`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The saved file is still under /outside, so only the nested search of the moved-in folder
		// finds it.
		const found = await runner.run({ command: `find ${test_db_files_mount}/docs -name movedin` });
		expect(found.metadata.exitCode).toBe(0);
		expect(found.stdout).toContain(`${test_db_files_mount}/docs/inner/movedin.md`);
		expect(found.stdout).not.toContain("/outside/");
		expect(
			runner.runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_name_saved" &&
					(args as { movedIn?: unknown }).movedIn != null,
			),
		).toBe(true);
	});

	test("find -name shows a row once when a folder inside a moved-in folder is renamed", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/outside/g/k/target.md", content: "target\n" }],
		});
		for (const command of [
			`mv ${test_db_files_mount}/outside/g ${test_db_files_mount}/docs/g`,
			`mv ${test_db_files_mount}/docs/g/k ${test_db_files_mount}/docs/g/k2`,
		])
			expect((await runner.run({ command })).metadata.exitCode).toBe(0);

		// One row per page: the dedupe inside one call cannot hide a row that two searches return.
		const paths: string[] = [];
		let command: string | null = `find ${test_db_files_mount}/docs -name target --limit 1`;
		for (let page = 0; command !== null && page < 10; page++) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			paths.push(...lines.filter((line) => line.startsWith(test_db_files_mount)));
			command = lines.find((line) => line.startsWith("Next page: "))?.slice("Next page: ".length) ?? null;
		}
		expect(paths).toEqual([`${test_db_files_mount}/docs/g/k2/target.md`]);
	});

	test("find -name opens no search for a folder moved inside the search folder", async () => {
		const deep = Array.from({ length: 12 }, (_, index) => `a${index + 1}`).join("/");
		const runner = await create_bash_runner({
			extraFiles: [{ path: `/docs/${deep}/deep/found.md`, content: "found\n" }],
		});
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/docs/${deep}/deep ${test_db_files_mount}/docs/deep`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The saved folder is 14 levels deep, too deep for its own search, but it is still under /docs,
		// so the main search finds its rows and no note is needed.
		const found = await runner.run({ command: `find ${test_db_files_mount}/docs -name found` });
		expect(found.metadata.exitCode).toBe(0);
		expect(found.stdout).toBe(`${test_db_files_mount}/docs/deep/found.md\n`);
		expect(
			runner.runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_name_saved" &&
					(args as { movedIn?: unknown }).movedIn != null,
			),
		).toBe(false);
	});

	test("find -name finds the agent's new draft only under its folder", async () => {
		const runner = await create_bash_runner();
		const written = await runner.run({ command: `printf 'draft\\n' > ${test_db_files_mount}/docs/draftnote.md` });
		expect(written.metadata.exitCode).toBe(0);

		const inDocs = await runner.run({ command: `find ${test_db_files_mount}/docs -name draftnote` });
		expect(inDocs.metadata.exitCode).toBe(0);
		expect(inDocs.stdout).toContain(`${test_db_files_mount}/docs/draftnote.md`);

		const inReports = await runner.run({ command: `find ${test_db_files_mount}/reports -name draftnote` });
		expect(inReports.metadata.exitCode).toBe(0);
		expect(inReports.stderr.trim()).toBe("0 matches.");
	});

	test("reports visible paths for search and recursive grep over pending moves", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested` });

		// An unscoped search finds content inside the moved folder at its visible path.
		const unscoped = await runner.run({ command: "search three" });
		expect(unscoped.metadata.exitCode).toBe(0);
		expect(unscoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
		expect(unscoped.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);

		// A --path scope at the visible destination folder translates to the committed source.
		const scoped = await runner.run({ command: `search --path ${test_db_files_mount}/reports/nested three` });
		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);

		const grepScoped = await runner.run({ command: `grep -R three ${test_db_files_mount}/reports/nested` });
		expect(grepScoped.metadata.exitCode).toBe(0);
		expect(grepScoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);

		// A moved file's content match reports the file's visible path too.
		await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/moved-guide.md`,
		});
		const movedFile = await runner.run({ command: "search alpha" });
		expect(movedFile.metadata.exitCode).toBe(0);
		expect(movedFile.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);
		expect(movedFile.stdout).not.toContain(`${test_db_files_mount}/docs/tutorial.md`);
	});

	test("grep finds matches in a file with a pending move-only row", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc has no pending chunks; grep must fall back to the
		// committed chunks instead of silently reporting no matches.
		const hit = await runner.run({ command: `grep alpha ${test_db_files_mount}/docs/guide.md` });
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("alpha\n");
	});

	test("textgrep finds matches in a file with a pending move-only row", async () => {
		const runner = await create_bash_runner();

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// Same committed fallback for the plain-text matcher behind a move-only pending update doc.
		const hit = await runner.run({ command: `textgrep alpha ${test_db_files_mount}/docs/guide.md` });
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("alpha\n");
	});

	test("grep reads the pending chunks when the pending row has content", async () => {
		const runner = await create_bash_runner();

		// cp stages the copied text on the fresh destination node as a whole-file replacement.
		// grep must read that staged text, not the (empty) committed one.
		const copied = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/readme-copy.md`,
		});
		expect(copied.metadata.exitCode).toBe(0);

		const hit = await runner.run({ command: `grep unique-token ${test_db_files_mount}/docs/readme-copy.md` });
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stderr).toBe("");
		expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");
	});

	test("multi-operand grep recovery hint keeps the moved-folder scope", async () => {
		const runner = await create_bash_runner();

		await runner.run({ command: `mv ${test_db_files_mount}/docs ${test_db_files_mount}/reports2` });

		// The fallback hint must scope to the moved folder's visible path, not suggest a
		// whole-workspace search.
		const result = await runner.run({
			command: `grep alpha ${test_db_files_mount}/reports2 ${test_db_files_mount}/reports2/readme.md`,
		});
		expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(result.stdout).toContain(`Try: search --path ${test_db_files_mount}/reports2 --limit 20 alpha`);
	});

	test("injects moved-in content into searches scoped at an ancestor of the destination", async () => {
		const runner = await create_bash_runner();

		await runner.run({
			command: `mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/reports/moved-guide.md`,
		});

		// /reports is an ancestor of the destination, not itself a redirected folder,
		// so the committed chunks under /docs sit outside the scoped committed prefix.
		const scoped = await runner.run({ command: `search --path ${test_db_files_mount}/reports alpha` });
		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		const grepScoped = await runner.run({ command: `grep -R alpha ${test_db_files_mount}/reports` });
		expect(grepScoped.metadata.exitCode).toBe(0);
		expect(grepScoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		const textgrepScoped = await runner.run({ command: `textgrep -R alpha ${test_db_files_mount}/reports` });
		expect(textgrepScoped.metadata.exitCode).toBe(0);
		expect(textgrepScoped.stdout).toContain(`${test_db_files_mount}/reports/moved-guide.md`);

		// A moved folder's children inject the same way at the ancestor scope.
		await runner.run({ command: `mv ${test_db_files_mount}/docs/nested ${test_db_files_mount}/reports/nested` });
		const folderScoped = await runner.run({ command: `search --path ${test_db_files_mount}/reports three` });
		expect(folderScoped.metadata.exitCode).toBe(0);
		expect(folderScoped.stdout).toContain(`${test_db_files_mount}/reports/nested/deep.md`);
	});

	test("reads on past a search page the overlay empties", async () => {
		// The file moved outside the scope is seeded first so the limit-1 first page holds only its
		// committed chunk, which the overlay drops from the /docs scope; the visible
		// match lives on the next page, which the same call reads.
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-moved.md", content: "dropscope alpha\n" },
				{ path: "/docs/paged-kept.md", content: "dropscope beta\n" },
			],
		});

		await runner.run({
			command: `mv ${test_db_files_mount}/docs/paged-moved.md ${test_db_files_mount}/reports/paged-moved.md`,
		});

		const firstPage = await runner.run({ command: `search --path ${test_db_files_mount}/docs --limit 1 dropscope` });

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain(`${test_db_files_mount}/docs/paged-kept.md`);
		expect(firstPage.stdout).not.toContain("paged-moved.md");
	});

	test("chained commands in one bash call see the proposal made by an earlier mv", async () => {
		const runner = await create_bash_runner();

		const chained = await runner.run({
			command: `ls ${test_db_files_mount}/docs && mv ${test_db_files_mount}/docs/tutorial.md ${test_db_files_mount}/docs/guide.md && ls ${test_db_files_mount}/docs`,
		});
		expect(chained.metadata.exitCode).toBe(0);
		// The mv confirmation line splits the first ls output from the second.
		const segments = chained.stdout.split("Review in Files.\n");
		expect(segments).toHaveLength(2);
		// The first ls (before the proposal) shows the committed name.
		expect(segments[0]).toContain("tutorial.md");
		// The second ls (after the proposal) shows the new name and drops the old one.
		expect(segments[1]).toContain("guide.md");
		expect(segments[1]).not.toContain("tutorial.md");

		// The proposal row records the chat thread that ran the mv.
		const pendingRows = await runner.t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", runner.ctxData.organizationId)
						.eq("workspaceId", runner.ctxData.workspaceId)
						.eq("userId", runner.ctxData.userId),
				)
				.collect(),
		);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.threadIds).toEqual([runner.threadId]);
	});

	test("keeps Ask mode mv and cp app rejections without creating proposals", async () => {
		const runner = await create_bash_runner({ allowDbFilesMkdir: false });
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		const mvResult = await runner.run({
			command: `mv ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/renamed.md`,
		});
		expect(mvResult.metadata.exitCode).not.toBe(0);
		expect(mvResult.stderr).toBe("mv: app file writes require Agent mode\n");

		const cpResult = await runner.run({
			command: `cp ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/copy.md`,
		});
		expect(cpResult.metadata.exitCode).not.toBe(0);
		expect(cpResult.stderr).toBe("cp: app file writes require Agent mode\n");

		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_pending_updates:upsert_file_pending_move_in_db",
			),
		).toBe(false);
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await list_pending_updates(runner)).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("keeps Ask mode redirect, touch, and tee app writes rejected without creating proposals", async () => {
		const runner = await create_bash_runner({ allowDbFilesMkdir: false });
		const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());

		const redirect = await runner.run({ command: `printf hi > ${test_db_files_mount}/ask.md` });
		const touched = await runner.run({ command: `touch ${test_db_files_mount}/ask.md` });
		const teed = await runner.run({ command: `printf hi | tee ${test_db_files_mount}/ask.md` });

		for (const result of [redirect, touched, teed]) {
			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Agent mode");
		}
		expect(
			runner.runMutation.mock.calls.some(
				([ref]) => function_name_of(ref) === "files_nodes:create_private_node_by_path",
			),
		).toBe(false);
		expect(await list_pending_updates(runner)).toHaveLength(0);
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test("redirect write creates a private proposal with thread provenance", async () => {
		const runner = await create_bash_runner();

		const written = await runner.run({
			command: `printf hello > ${test_db_files_mount}/note.md && cat ${test_db_files_mount}/note.md`,
		});
		expect(written.metadata.exitCode).toBe(0);
		expect(written.stderr).toBe("");
		// The chained cat proves resetProposalCaches: the same bash call reads the proposal back.
		// A Markdown file's pending content is rendered Markdown text, which POSIX-terminates
		// non-empty content with one newline; byte-exact storage is the plain-text files' contract.
		expect(written.stdout).toBe("hello\n");

		const draft = await get_private_entry(runner, "/note.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "private", id: draft.node._id });
		expect(pendingRows[0]!.content?.base).toEqual({ kind: "new" });
		expect(pendingRows[0]!.threadIds).toEqual([runner.threadId]);
		expect(draft.pendingUpdate.createIntent).toMatchObject({ kind: "text", textKind: "rich_text" });
		expect(
			await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				subject: { kind: "user", userId: runner.ctxData.userId, plugin: null },
				path: "/note.md",
			}),
		).toBeNull();
	});

	test("private files share paths and fresh sizes across chained readers", async () => {
		const runner = await create_bash_runner();
		const folder = `${test_db_files_mount}/reader-draft`;
		const file = `${folder}/lines.txt`;
		const result = await runner.run({
			command: [
				`mkdir ${folder}`,
				`printf 'one\\ntwo\\n' > ${file}`,
				`stat -c '%s %F' ${file}`,
				`head -n 1 ${file}`,
				`tail -n 1 ${file}`,
				`sed -n '2p' ${file}`,
				`ls ${folder}`,
				`printf 'three\\n' >> ${file}`,
				`stat -c %s ${file}`,
				`cat ${file}`,
			].join(" && "),
		});
		expect(result.stderr).toBe("");
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("8 regular file\none\ntwo\ntwo\nlines.txt\n14\none\ntwo\nthree\n");
		const entry = await get_private_entry(runner, "/reader-draft/lines.txt");
		expect(entry.pendingUpdate.size).toBe(14);
		expect(
			await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				subject: { kind: "user", userId: runner.ctxData.userId, plugin: null },
				path: "/reader-draft/lines.txt",
			}),
		).toBeNull();
	});

	test("discovery commands include private files and private folder scopes", async () => {
		const runner = await create_bash_runner();
		const written = await runner.run({ command: "printf 'privateneedle\\n' > private-search/note.md" });
		expect(written.metadata.exitCode).toBe(0);
		const listed = await runner.run({ command: "find private-search --limit 10" });
		expect(listed.metadata.exitCode).toBe(0);
		expect(listed.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const exact = await runner.run({ command: "grep -n privateneedle private-search/note.md" });
		expect(exact.metadata.exitCode).toBe(0);
		expect(exact.stdout).toContain("1:privateneedle");
		const recursive = await runner.run({ command: "grep -R privateneedle private-search" });
		expect(recursive.metadata.exitCode).toBe(0);
		expect(recursive.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const tree = await runner.run({ command: "tree private-search --limit 10" });
		expect(tree.metadata.exitCode).toBe(0);
		expect(tree.stdout).toContain("|-- note.md");
		const search = await runner.run({ command: "search --path private-search privateneedle" });
		expect(search.metadata.exitCode).toBe(0);
		expect(search.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
		const textgrep = await runner.run({ command: "textgrep -F privateneedle private-search/note.md" });
		expect(textgrep.metadata.exitCode).toBe(0);
		expect(textgrep.stdout).toBe("privateneedle\n");
		const textgrepRecursive = await runner.run({ command: "textgrep -R privateneedle private-search" });
		expect(textgrepRecursive.metadata.exitCode).toBe(0);
		expect(textgrepRecursive.stdout).toContain(`${test_db_files_mount}/private-search/note.md`);
	});

	test("private metadata writes keep frontmatter and text searchable", async () => {
		const runner = await create_bash_runner();
		const written = await runner.run({
			command: "printf '%s\\n' '---' 'status: draft' '---' 'privatemetadataword' > private-meta/note.md",
		});
		expect(written.metadata.exitCode).toBe(0);
		const tool = ai_chat_tool_create_set_file_metadata(runner.ctx, {
			...runner.ctxData,
			getThreadId: () => runner.threadId,
			getRun: () => runner.chatRun,
		});
		for (const path of ["/private-meta", "/private-meta/note.md"]) {
			expect(
				await tool.execute?.(
					{ workspace: "current", path, set: [{ key: "source", value: "draft-copy" }], remove: [] },
					{ toolCallId: `metadata-${path}`, messages: [] },
				),
			).toMatchObject({ metadata: { path } });
			const read = await runner.run({ command: `meta get ${test_db_files_mount}${path} --format json` });
			expect(read.stderr).toBe("");
			expect(read.metadata.exitCode).toBe(0);
			expect(JSON.parse(read.stdout)).toMatchObject({
				target: { kind: "private" },
				sourceKind: "pending",
				values: expect.arrayContaining([
					expect.objectContaining({ field: "metadata.source", valueKind: "string", value: "draft-copy" }),
				]),
			});
		}
		// Search reads private fields from a copy that a scheduled job writes. Let that job finish.
		await drain_scheduled_continuations(runner);
		const frontmatter = await runner.run({
			command: `meta search --path private-meta --where '{"eq":["frontmatter.status","draft"]}'`,
		});
		expect(frontmatter.stderr).toBe("");
		expect(frontmatter.metadata.exitCode).toBe(0);
		expect(frontmatter.stdout).toBe(`${test_db_files_mount}/private-meta/note.md\n`);
		const metadata = await runner.run({
			command: `meta search --where '{"eq":["metadata.source","draft-copy"]}' --format json`,
		});
		expect(metadata.metadata.exitCode).toBe(0);
		expect(JSON.parse(metadata.stdout).results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: `${test_db_files_mount}/private-meta`,
					target: { kind: "private", id: expect.any(String) },
				}),
				expect.objectContaining({
					path: `${test_db_files_mount}/private-meta/note.md`,
					target: { kind: "private", id: expect.any(String) },
				}),
			]),
		);
		const text = await runner.run({ command: "grep -R privatemetadataword private-meta" });
		expect(text.metadata.exitCode).toBe(0);
		expect(text.stdout).toContain(`${test_db_files_mount}/private-meta/note.md`);
	});

	test("redirect overwrite and append on an existing file stay pending proposals", async () => {
		// Pending upserts fetch the committed base yjs snapshot, so the target needs a real one.
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/existing.md", content: "committed body\n", withRealYjsSnapshot: true }],
		});

		const overwritten = await runner.run({
			command: `printf replaced > ${test_db_files_mount}/docs/existing.md && cat ${test_db_files_mount}/docs/existing.md`,
		});
		expect(overwritten.metadata.exitCode).toBe(0);
		// A Markdown file's pending content is rendered Markdown text, which POSIX-terminates
		// non-empty content with one newline (plain-text files store bytes exactly).
		expect(overwritten.stdout).toBe("replaced\n");

		const appended = await runner.run({
			command: `printf ' extra' >> ${test_db_files_mount}/docs/existing.md && cat ${test_db_files_mount}/docs/existing.md`,
		});
		expect(appended.metadata.exitCode).toBe(0);
		// Append builds on the user's own pending content, which already carries rich text's
		// trailing newline, so the appended run starts on a new line.
		expect(appended.stdout).toBe("replaced\n extra\n");

		const existingNode = await get_seeded_node(runner, "/docs/existing.md");
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: existingNode._id });
		// A saved file never becomes a private creation proposal.
		expect(pendingRows[0]!.createIntent).toBeUndefined();
	});

	test("redirect overwrite on a file with collaboration off stays a pending proposal", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/docs/off.md", content: "committed body\n", nonCollaborative: true }],
		});
		const nodeBefore = await get_seeded_node(runner, "/docs/off.md");

		const overwritten = await runner.run({
			command: `printf replaced > ${test_db_files_mount}/docs/off.md && cat ${test_db_files_mount}/docs/off.md`,
		});
		expect(overwritten.stderr).toBe("");
		expect(overwritten.metadata.exitCode).toBe(0);
		// Same as a collaborative file: the proposal is rendered Markdown, which ends with one newline.
		expect(overwritten.stdout).toBe("replaced\n");

		// The proposal is built from the saved text, so it records that text's asset as its base.
		// The file itself did not change and still has no Yjs document.
		const pendingRows = await list_pending_updates(runner);
		expect(pendingRows).toHaveLength(1);
		expect(pendingRows[0]!.target).toEqual({ kind: "saved", id: nodeBefore._id });
		expect(pendingRows[0]!.content?.base).toEqual({
			kind: "asset",
			assetId: nodeBefore.assetId,
			pendingContentVersion: nodeBefore.pendingContentVersion,
		});
		expect(pendingRows[0]!.createIntent).toBeUndefined();
		const nodeAfter = await get_seeded_node(runner, "/docs/off.md");
		expect(nodeAfter.assetId).toBe(nodeBefore.assetId);
		expect(nodeAfter.collaborationEnabled).toBe(false);
		expect(nodeAfter.yjsSnapshotId).toBeNull();
		expect(await read_committed_text(runner, nodeBefore._id)).toBe("committed body\n");

		// A second write builds on the agent's own proposal and keeps the same doc.
		const appended = await runner.run({
			command: `printf ' extra' >> ${test_db_files_mount}/docs/off.md && cat ${test_db_files_mount}/docs/off.md`,
		});
		expect(appended.stderr).toBe("");
		expect(appended.stdout).toBe("replaced\n extra\n");
		const rowsAfterAppend = await list_pending_updates(runner);
		expect(rowsAfterAppend).toHaveLength(1);
		expect(rowsAfterAppend[0]!._id).toBe(pendingRows[0]!._id);
	});

	test("a member save keeps the stale proposal readable and append prepares it automatically", async () => {
		const path = `${test_db_files_mount}/docs/off-stale.txt`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: "/docs/off-stale.txt",
					content: "committed needle\nsecond line\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const nodeBefore = await get_seeded_node(runner, "/docs/off-stale.txt");
		const proposed = await runner.run({ command: `printf 'proposal needle\\nsecond line\\n' > ${path}` });
		expect(proposed.stderr).toBe("");
		const [row] = await list_pending_updates(runner);
		expect(row?.content?.base).toEqual({
			kind: "asset",
			assetId: nodeBefore.assetId,
			pendingContentVersion: nodeBefore.pendingContentVersion,
		});

		// A member saves the file. Passive reads keep the agent's exact proposal.
		const memberSave = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			requestId: "committed-needle",
			membershipId: runner.seeded.membershipId,
			nodeId: nodeBefore._id,
			text: "committed needle\nsaved line\n",
		});
		expect(memberSave._nay).toBeUndefined();
		const read = await runner.run({ command: `cat ${path} && wc -l ${path} && grep -n needle ${path}` });
		expect(read.stderr).toBe("");
		expect(read.stdout).toBe(`proposal needle\nsecond line\n2 ${path}\n1:proposal needle\n`);
		expect(await list_pending_updates(runner)).toEqual([row]);

		// Append prepares the old proposal before reading the text it will extend.
		const rewritten = await runner.run({ command: `printf 'proposal again\\n' >> ${path} && cat ${path}` });
		expect(rewritten.stderr).toBe("");
		expect(rewritten.stdout).toBe("proposal needle\nsaved line\nproposal again\n");
		const rowsAfter = await list_pending_updates(runner);
		expect(rowsAfter).toHaveLength(1);
		expect(rowsAfter[0]!._id).toBe(row!._id);
		const nodeAfter = await get_seeded_node(runner, "/docs/off-stale.txt");
		expect(nodeAfter.assetId).not.toBe(nodeBefore.assetId);
		expect(rowsAfter[0]!.content?.base).toEqual({
			kind: "asset",
			assetId: nodeAfter.assetId,
			pendingContentVersion: nodeAfter.pendingContentVersion,
		});
	});

	test.each(["append", "edit_file"] as const)(
		"%s recomputes when a proposal appears after a read with no family",
		async (operation) => {
			const filePath = "/docs/new-family.txt";
			const path = `${test_db_files_mount}${filePath}`;
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: filePath, content: "old\n", contentType: "text/plain;charset=utf-8", nonCollaborative: true },
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
			const readName =
				operation === "edit_file"
					? "files_nodes_content:get_file_last_available_text_content_by_path"
					: "files_nodes:read_file_content_from_chunks";
			const read = readSpy.getMockImplementation()!;
			let inserted = false;
			readSpy.mockImplementation(async (ref, args) => {
				const result = await read(ref, args);
				if (!inserted && function_name_of(ref) === readName && args.path === filePath) {
					inserted = true;
					await upsert_pending_update_for_test(runner, {
						target: { kind: "saved", id: node._id },
						unstagedText: "earlier proposal\nold\n",
					});
				}
				return result;
			});
			if (operation === "edit_file") {
				const edit = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
					getRun: () => runner.chatRun,
				});
				await expect(
					edit.execute?.(
						{ workspace: "current", path: filePath, oldString: "old", newString: "new", replaceAll: false },
						{ toolCallId: "new-family", messages: [] },
					),
				).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
			} else {
				const appended = await runner.run({ command: `printf 'tail\\n' >> ${path}` });
				expect(appended.stderr).toBe("");
				expect(appended.metadata.exitCode).toBe(0);
			}
			expect(inserted).toBe(true);
			expect((await runner.run({ command: `cat ${path}` })).stdout).toBe(
				operation === "append" ? "earlier proposal\nold\ntail\n" : "earlier proposal\nnew\n",
			);
			expect(await read_committed_text(runner, node._id)).toBe("old\n");
		},
	);

	test.each([
		["append", "saved"],
		["edit_file", "saved"],
		["append", "replaced"],
		["edit_file", "replaced"],
	] as const)("%s retries when the file is %s after its read without owner preparation", async (operation, race) => {
		const filePath = "/docs/preflight-race.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: filePath,
					content: "first: old\nsecond: old\nthird: old\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const node = await get_seeded_node(runner, filePath);
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: node._id },
			unstagedText: "first: proposal\nsecond: old\nthird: old\n",
		});
		const [pending] = await list_pending_updates(runner);
		if (!pending) throw new Error("Missing proposal");
		const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
		const readName =
			operation === "edit_file"
				? "files_nodes_content:get_file_last_available_text_content_by_path"
				: "files_nodes:read_file_content_from_chunks";
		const read = readSpy.getMockImplementation()!;
		let changed = false;
		readSpy.mockImplementation(async (ref, args) => {
			const result = await read(ref, args);
			if (!changed && function_name_of(ref) === readName && args.path === filePath) {
				changed = true;
				if (race === "saved") {
					const saved = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
						requestId: "member-during-read",
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
						text: "first: old\nsecond: member\nthird: old\n",
					});
					expect(saved._nay).toBeUndefined();
				} else {
					const discarded = await runner_as_user(runner).mutation(
						api.files_pending_updates.discard_file_pending_content,
						{
							membershipId: runner.seeded.membershipId,
							target: { kind: "saved", id: node._id },
							pendingUpdateId: pending._id,
							reviewedRevision: pending.revision,
						},
					);
					expect(discarded._nay).toBeUndefined();
					await upsert_pending_update_for_test(runner, {
						target: { kind: "saved", id: node._id },
						unstagedText: "first: replacement\nsecond: old\nthird: old\n",
					});
				}
			}
			return result;
		});
		const preparedText =
			race === "saved"
				? "first: proposal\nsecond: member\nthird: old\n"
				: "first: replacement\nsecond: old\nthird: old\n";
		if (operation === "edit_file") {
			const edit = ai_chat_tool_create_edit_file(runner.ctx, {
				...runner.ctxData,
				getThreadId: () => runner.threadId,
				getRun: () => runner.chatRun,
			});
			await expect(
				edit.execute?.(
					{
						workspace: "current",
						path: filePath,
						oldString: "third: old",
						newString: "third: tool",
						replaceAll: false,
					},
					{ toolCallId: "preflight-race", messages: [] },
				),
			).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
		} else {
			const appended = await runner.run({ command: `printf 'tail\\n' >> ${path}` });
			expect(appended.stderr).toBe("");
			expect(appended.metadata.exitCode).toBe(0);
		}
		expect(changed).toBe(true);
		expect((await runner.run({ command: `cat ${path}` })).stdout).toBe(
			operation === "append" ? `${preparedText}tail\n` : preparedText.replace("third: old", "third: tool"),
		);
	});

	test("append stops after a second content-family change without losing the latest proposal", async () => {
		const filePath = "/docs/append-retry-limit.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: filePath, content: "old\n", contentType: "text/plain;charset=utf-8", nonCollaborative: true },
			],
		});
		const node = await get_seeded_node(runner, filePath);
		const read = runner.runQuery.getMockImplementation()!;
		let races = 0;
		runner.runQuery.mockImplementation(async (ref, args) => {
			const result = await read(ref, args);
			if (
				races < 2 &&
				function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
				args.path === filePath
			) {
				races += 1;
				await upsert_pending_update_for_test(runner, {
					target: { kind: "saved", id: node._id },
					unstagedText: `proposal ${races}\nold\n`,
				});
			}
			return result;
		});
		const appended = await runner.run({ command: `printf 'tail\\n' >> ${path}` });
		expect(appended.metadata.exitCode).not.toBe(0);
		expect(appended.stderr).toContain("The proposal changed after it was read.");
		expect(races).toBe(2);
		expect((await runner.run({ command: `cat ${path}` })).stdout).toBe("proposal 2\nold\n");
	});

	test.each(["overwrite", "edit_file"] as const)(
		"%s names a stored file's type before preparation",
		async (operation) => {
			const filePath = "/docs/image.png";
			const runner = await create_bash_runner({
				extraFiles: [{ path: filePath, content: "stored bytes", contentType: "image/png", withoutYjsState: true }],
			});
			const message = "this file's content type ('image/png') is not editable as text";
			if (operation === "edit_file") {
				const edit = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
					getRun: () => runner.chatRun,
				});
				await expect(
					edit.execute?.(
						{ workspace: "current", path: filePath, oldString: "old", newString: "new", replaceAll: false },
						{ toolCallId: "stored-type", messages: [] },
					),
				).rejects.toThrow(message);
			} else {
				const written = await runner.run({ command: `printf replacement > ${test_db_files_mount}${filePath}` });
				expect(written.metadata.exitCode).not.toBe(0);
				expect(written.stderr).toContain(message);
			}
			expect(
				runner.runAction.mock.calls.filter(
					([ref]) => function_name_of(ref) === "files_pending_updates:prepare_file_pending_update_for_agent",
				),
			).toHaveLength(0);
			expect(await list_pending_updates(runner)).toEqual([]);
		},
	);

	test("a full overwrite prepares a stale proposal and keeps its staged branch", async () => {
		const filePath = "/docs/staged-overwrite.txt";
		const path = `${test_db_files_mount}${filePath}`;
		const runner = await create_bash_runner({
			extraFiles: [
				{
					path: filePath,
					content: "first: old\nsecond: old\nthird: old\n",
					contentType: "text/plain;charset=utf-8",
					nonCollaborative: true,
				},
			],
		});
		const node = await get_seeded_node(runner, filePath);
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: node._id },
			stagedText: "first: staged\nsecond: old\nthird: old\n",
			unstagedText: "first: staged\nsecond: proposed\nthird: old\n",
		});
		const saved = await runner_as_user(runner).action(api.files_nodes_content.replace_file_content, {
			requestId: "member-before-overwrite",
			membershipId: runner.seeded.membershipId,
			nodeId: node._id,
			text: "first: old\nsecond: old\nthird: member\n",
		});
		expect(saved._nay).toBeUndefined();
		const overwritten = await runner.run({ command: `printf 'replacement\\n' > ${path} && cat ${path}` });
		expect(overwritten.stderr).toBe("");
		expect(overwritten.stdout).toBe("replacement\n");
		await save_pending_update_for_test(runner, node._id);
		expect(await read_committed_text(runner, node._id)).toBe("first: staged\nsecond: old\nthird: member\n");
	});

	test.each([
		["append", true, false],
		["append", false, false],
		["edit_file", true, false],
		["edit_file", false, false],
		["overwrite", true, false],
		["append", true, true],
	] as const)(
		"%s recomputes after a proposal changes during its read (already stale: %s, accepted: %s)",
		async (operation, staleAtRead, accepted) => {
			const filePath = "/docs/read-race.txt";
			const path = `${test_db_files_mount}${filePath}`;
			const savedText = "first: old\nsecond: member\nthird: old\n";
			const preparedText = "first: proposal\nsecond: member\nthird: old\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{
						path: filePath,
						content: "first: old\nsecond: old\nthird: old\n",
						contentType: "text/plain;charset=utf-8",
						nonCollaborative: true,
					},
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const proposed = await runner.run({
				command: `printf 'first: proposal\\nsecond: old\\nthird: old\\n' > ${path}`,
			});
			expect(proposed.stderr).toBe("");
			expect(proposed.metadata.exitCode).toBe(0);
			const [originalPending] = await list_pending_updates(runner);
			if (!originalPending) throw new Error("Missing proposal");
			const asUser = runner_as_user(runner);
			const saveArgs = {
				membershipId: runner.seeded.membershipId,
				nodeId: node._id,
				text: savedText,
				requestId: "saved-during-read",
			};
			if (staleAtRead) {
				expect(
					(
						await asUser.action(api.files_nodes_content.replace_file_content, {
							...saveArgs,
							requestId: "intermediate-save",
							text: "first: old\nsecond: intermediate\nthird: old\n",
						})
					)._nay,
				).toBeUndefined();
			}

			let preparedPending = originalPending;
			let preparedNode = node;
			let preparedAfterRead = false;
			const readSpy = operation === "edit_file" ? runner.runAction : runner.runQuery;
			const readFunctionName =
				operation === "edit_file"
					? "files_nodes_content:get_file_last_available_text_content_by_path"
					: "files_nodes:read_file_content_from_chunks";
			const read = readSpy.getMockImplementation()!;
			readSpy.mockImplementation(async (ref, args) => {
				const result = await read(ref, args);
				if (!preparedAfterRead && function_name_of(ref) === readFunctionName && args.path === filePath) {
					// Another preparation can replace the fresh family before its write starts.
					expect((await asUser.action(api.files_nodes_content.replace_file_content, saveArgs))._nay).toBeUndefined();
					const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
						membershipId: runner.seeded.membershipId,
						target: { kind: "saved", id: node._id },
						pendingUpdateId: originalPending._id,
					});
					expect(prepared._nay).toBeUndefined();
					const [pending] = await list_pending_updates(runner);
					if (!pending) throw new Error("Missing prepared proposal");
					preparedPending = pending;
					if (accepted) {
						await accept_pending_update_for_test(runner, { nodeId: node._id, path: filePath });
						expect(await list_pending_updates(runner)).toEqual([]);
					}
					preparedNode = await get_seeded_node(runner, filePath);
					expect(preparedPending.content?.baseStateId).not.toBe(originalPending.content?.baseStateId);
					preparedAfterRead = true;
				}
				return result;
			});

			if (operation === "edit_file") {
				const tool = ai_chat_tool_create_edit_file(runner.ctx, {
					...runner.ctxData,
					getThreadId: () => runner.threadId,
					getRun: () => runner.chatRun,
				});
				await expect(
					tool.execute?.(
						{
							workspace: "current",
							path: filePath,
							oldString: "third: old",
							newString: "third: tool",
							replaceAll: false,
						},
						{ toolCallId: "read-race", messages: [] },
					),
				).resolves.toMatchObject({ metadata: { pendingUpdateId: expect.any(String), matches: 1 } });
			} else {
				const written = await runner.run({
					command: operation === "append" ? `printf 'tool tail\\n' >> ${path}` : `printf 'replacement\\n' > ${path}`,
				});
				expect(written.metadata.exitCode).toBe(0);
				expect(written.stderr).toBe("");
			}
			expect(preparedAfterRead).toBe(true);
			expect(await list_pending_updates(runner)).toHaveLength(1);
			expect((await runner.run({ command: `cat ${path}` })).stdout).toBe(
				operation === "overwrite"
					? "replacement\n"
					: operation === "append"
						? `${preparedText}tool tail\n`
						: preparedText.replace("third: old", "third: tool"),
			);
			expect(await get_seeded_node(runner, filePath)).toEqual(preparedNode);
			expect(await read_committed_text(runner, node._id)).toBe(accepted ? preparedText : savedText);
			const batches = await runner.t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);

	test.each([
		[false, "txt"],
		[true, "txt"],
		[false, "md"],
		[true, "md"],
	] as const)(
		"a mode toggle keeps proposals readable and append prepares them (OFF %s, %s)",
		async (nonCollaborative, extension) => {
			const filePath = `/docs/toggle-pending.${extension}`;
			const path = `${test_db_files_mount}${filePath}`;
			const committed = extension === "md" ? "---\nstatus: saved\n---\n\ncommitted needle\n" : "committed needle\n";
			const proposed = extension === "md" ? "---\nstatus: proposed\n---\n\nproposal needle\n" : "proposal needle\n";
			const runner = await create_bash_runner({
				extraFiles: [
					{
						path: filePath,
						content: committed,
						contentType: extension === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
						nonCollaborative,
						withRealYjsSnapshot: !nonCollaborative,
					},
				],
			});
			const node = await get_seeded_node(runner, filePath);
			const write = await runner.run({ command: `cat > ${path} <<'EOF'\n${proposed}EOF` });
			expect(write.stderr).toBe("");
			expect(write.metadata.exitCode).toBe(0);
			expect((await runner.run({ command: `cat ${path}` })).stdout).toBe(proposed);
			const pendingSearch = await runner.run({ command: `search --path ${test_db_files_mount}/docs proposal` });
			expect(pendingSearch.metadata.exitCode).toBe(0);
			expect(pendingSearch.stdout).toContain(path);
			if (extension === "md") {
				const pendingMetadata = await runner.run({
					command: `meta search --where '{"eq":["frontmatter.status","proposed"]}'`,
				});
				expect(pendingMetadata.metadata.exitCode).toBe(0);
				expect(pendingMetadata.stdout).toContain(path);
			}
			const [pendingBefore] = await list_pending_updates_for_node(runner, node._id);

			const toggle = nonCollaborative
				? await runner_as_user(runner).action(api.files_nodes_content.set_file_collaborative, {
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
					})
				: await runner_as_user(runner).mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: runner.seeded.membershipId,
						nodeId: node._id,
						acknowledgeDropCollaborativeHistory: true,
					});
			expect(toggle._nay).toBeUndefined();
			await drain_scheduled_continuations(runner);

			const read = await runner.run({ command: `cat ${path} && wc -c ${path} && grep -n needle ${path}` });
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe(
				`${proposed}${new TextEncoder().encode(proposed).byteLength} ${path}\n${extension === "md" ? 5 : 1}:proposal needle\n`,
			);
			const retainedSearch = await runner.run({ command: `search --path ${test_db_files_mount}/docs proposal` });
			expect(retainedSearch.metadata.exitCode).toBe(0);
			expect(retainedSearch.stdout).toContain(path);
			const committedSearch = await runner.run({ command: `search --path ${test_db_files_mount}/docs committed` });
			expect(committedSearch.metadata.exitCode).toBe(0);
			expect(committedSearch.stdout).not.toContain(path);
			if (extension === "md") {
				const retainedMetadata = await runner.run({
					command: `meta search --where '{"eq":["frontmatter.status","proposed"]}'`,
				});
				expect(retainedMetadata.metadata.exitCode).toBe(0);
				expect(retainedMetadata.stdout).toContain(path);
				const committedMetadata = await runner.run({
					command: `meta search --where '{"eq":["frontmatter.status","saved"]}'`,
				});
				expect(committedMetadata.metadata.exitCode).toBe(0);
				expect(committedMetadata.stdout).not.toContain(path);
			}
			expect(await list_pending_updates_for_node(runner, node._id)).toEqual([pendingBefore]);

			const appended = await runner.run({ command: `printf 'agent tail\\n' >> ${path} && cat ${path}` });
			expect(appended.metadata.exitCode).toBe(0);
			expect(appended.stderr).toBe("");
			expect(appended.stdout).toBe(`${proposed}agent tail\n`);
			const [pendingAfter] = await list_pending_updates_for_node(runner, node._id);
			expect(pendingAfter?._id).toBe(pendingBefore?._id);
			const saved = await get_seeded_node(runner, filePath);
			expect(pendingAfter).toMatchObject({ content: { base: { pendingContentVersion: saved.pendingContentVersion } } });
			expect(await read_committed_text(runner, node._id)).toBe(committed);
		},
	);
});
