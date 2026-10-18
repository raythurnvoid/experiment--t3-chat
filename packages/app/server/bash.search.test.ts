// The find, /tmp, search, grep, tree and stat tests, split from bash.test.ts so the files can run at the same
// time.
import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { ai_chat_files_patch_thread_tmp_files_Args } from "../convex/ai_chat_files.ts";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { bash_COMMAND_EXIT_USAGE, bash_READ_INLINE_MAX_BYTES } from "./bash-utils.ts";
import { ai_chat_tool_create_set_file_metadata } from "./server-ai-tools.ts";
import {
	accept_pending_move_group_for_test,
	test_db_files_mount,
	function_name_of,
	big_md_file,
	create_bash_runner,
	default_organization_files,
	drain_scheduled_continuations,
	get_seeded_node,
	get_seeded_node_id,
	upsert_pending_update_for_test,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	test("supports paginated find with maxdepth and type filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 10` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(result.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		// -maxdepth 1 reads the folder's children.
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_list_children_saved,
			expect.objectContaining({
				folderPath: "/docs",
				numItems: 10,
				position: { rangeStart: null, cursor: null, lastKey: null },
				kind: "file",
			}),
		);
	});

	test("handles exact file find targets locally with type depth and extension filters", async () => {
		const { run, runQuery } = await create_bash_runner();

		const plain = await run({ command: `find ${test_db_files_mount}/docs/readme.md --limit 10` });
		const extension = await run({ command: `find ${test_db_files_mount}/docs/readme.md --extension md --limit 10` });
		const typeFolder = await run({ command: `find ${test_db_files_mount}/docs/readme.md -type d --limit 10` });
		const tooDeep = await run({ command: `find ${test_db_files_mount}/docs/readme.md -mindepth 1 --limit 10` });

		expect(plain.metadata.exitCode).toBe(0);
		expect(plain.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(typeFolder.stdout.trim()).toBe("0 matches.");
		expect(tooDeep.stdout.trim()).toBe("0 matches.");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("supports app-file find name word search", async () => {
		// convex-test's search index splits document words on whitespace only, so the word
		// query can only land on a path segment that follows a space in the file name.
		const wordSearchPath = "/docs/word readme.md";
		const outsideWordSearchPath = "/word readme-outside.md";
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: wordSearchPath, content: "word search fixture\n" },
				{ path: outsideWordSearchPath, content: "outside word search fixture\n" },
				{ path: "/docs/scope word/child.md", content: "child under scope word\n" },
			],
		});
		const { run, runQuery } = runner;

		const nameResult = await run({ command: "find -name readme --limit 10" });
		const explicitResult = await run({ command: "find --path-query readme --limit 10" });
		const scopedResult = await run({
			command: `find ${test_db_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`,
		});
		const subtreeResult = await run({ command: `find ${test_db_files_mount}/docs -name readme --limit 10` });
		const dottedNameResult = await run({
			command: `find ${test_db_files_mount}/docs -type f -name 'word readme.md' --limit 10`,
		});
		const scopedSelfResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -name child --limit 10`,
		});
		const scopedMindepthResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -mindepth 1 -name child --limit 10`,
		});
		const scopedRootResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -name scope --limit 10`,
		});
		const scopedRootMindepthResult = await run({
			command: `find '${test_db_files_mount}/docs/scope word' -mindepth 1 -name scope --limit 10`,
		});

		expect(nameResult.metadata.exitCode).toBe(0);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(nameResult.stdout).toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		// App files search names only, and the name index has no parent filter.
		expect(explicitResult.metadata.exitCode).toBe(2);
		expect(explicitResult.stderr).toBe(
			"find: --path-query is not supported for app files; use find <folder> -name QUERY\n",
		);
		expect(scopedResult.metadata.exitCode).toBe(2);
		expect(scopedResult.stderr).toBe(
			"find: -maxdepth 1 -name is not supported for app files; use find <folder> -name QUERY for the whole folder, or ls <folder>\n",
		);
		// A folder scope searches the full subtree and leaves out the rest.
		expect(subtreeResult.metadata.exitCode).toBe(0);
		expect(subtreeResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(subtreeResult.stdout).not.toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
		expect(dottedNameResult.metadata.exitCode).toBe(0);
		expect(dottedNameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
		expect(dottedNameResult.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		for (const result of [scopedSelfResult, scopedMindepthResult]) {
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}/docs/scope word/child.md\n`);
		}
		// Like GNU find, the start folder prints when its own name matches, unless -mindepth 1.
		expect(scopedRootResult.stdout).toBe(`${test_db_files_mount}/docs/scope word/\n`);
		expect(scopedRootMindepthResult.stdout).toBe("0 matches.\n");
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_search_name_saved,
			expect.objectContaining({ query: "readme", folderPath: "/" }),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_visible.internal_search_name_places,
			expect.objectContaining({ query: "readme", folderPath: "/docs" }),
		);
	});

	test("supports find -mindepth and accepts -print as a no-op", async () => {
		const { run } = await create_bash_runner();

		const self = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 0 --limit 50` });
		const below = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 --limit 50` });
		const deepOnly = await run({ command: `find ${test_db_files_mount}/docs -mindepth 2 --limit 50` });
		const twoLevels = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 2 --limit 50` });
		const directOnly = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 -maxdepth 1 --limit 50` });
		const printed = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -print --limit 50` });

		// App folders take three depth shapes: the folder, its children, or its whole subtree.
		expect(self.stdout.trim()).toBe(`${test_db_files_mount}/docs/`);
		expect(below.metadata.exitCode).toBe(0);
		expect(below.stdout).not.toContain(`${test_db_files_mount}/docs/\n`);
		expect(below.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		for (const refused of [deepOnly, twoLevels]) {
			expect(refused.metadata.exitCode).toBe(2);
			expect(refused.stderr).toContain(
				"support only the folder itself (-maxdepth 0), its direct children (-maxdepth 1), or the whole subtree",
			);
		}
		expect(directOnly.metadata.exitCode).toBe(0);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
		expect(directOnly.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(printed.metadata.exitCode).toBe(0);
		expect(printed.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
	});

	test("rejects a non-integer find -mindepth and round-trips it in the continuation", async () => {
		const { run } = await create_bash_runner();

		const invalid = await run({ command: `find ${test_db_files_mount}/docs -mindepth x --limit 10` });
		const paged = await run({ command: `find ${test_db_files_mount}/docs -mindepth 1 --limit 1` });

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
		expect(paged.metadata.exitCode).toBe(0);
		expect(paged.stdout).toContain("Next page: find");
		expect(paged.stdout).toContain("-mindepth 1");
	});

	test("rejects find --prefix combined with depth flags", async () => {
		const { run, runQuery } = await create_bash_runner();

		const maxResult = await run({ command: `find --prefix ${test_db_files_mount}/docs -maxdepth 1 --limit 10` });
		const minResult = await run({ command: `find --prefix ${test_db_files_mount}/docs -mindepth 2 --limit 10` });

		expect(maxResult.metadata.exitCode).toBe(2);
		expect(maxResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		expect(minResult.metadata.exitCode).toBe(2);
		expect(minResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports indexed app-file find extension search and simple extension glob recovery", async () => {
		const { run, runQuery } = await create_bash_runner();

		const globName = await run({ command: "find -name '*.md' --limit 10" });
		const extension = await run({ command: `find ${test_db_files_mount}/docs --extension md --limit 10` });
		const pathGlob = await run({ command: `find ${test_db_files_mount}/docs/*.md --limit 1` });

		expect(globName.metadata.exitCode).toBe(0);
		expect(globName.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(extension.metadata.exitCode).toBe(0);
		expect(extension.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(pathGlob.metadata.exitCode).toBe(0);
		expect(pathGlob.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
		expect(pathGlob.stdout).toMatch(
			new RegExp(`Next page: find ${test_db_files_mount}/docs --extension md --limit 1 --cursor \\S+`, "u"),
		);
		expect(runQuery).toHaveBeenCalledWith(
			internal.files_nodes.list_subtree,
			expect.objectContaining({
				folderPath: "/docs",
				kind: "file",
				lowercaseExtension: "md",
			}),
		);
	});

	test("rejects find combinations that still cannot stay indexed", async () => {
		const { run } = await create_bash_runner();

		const scopedDepth = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 2 -name readme --limit 10` });
		const tokenGlobName = await run({ command: "find -type f -name '*readme*' --limit 10" });
		const prefixExtensionGlobName = await run({
			command: `find ${test_db_files_mount}/docs -type f -name 'readme*.md' --limit 10`,
		});
		const complexGlobName = await run({ command: "find -name 'read.*.md' --limit 10" });
		const pathQueryGlob = await run({ command: "find --path-query '.*readme.*' --limit 10" });
		const combinedPathQueryExtension = await run({
			command: `find ${test_db_files_mount}/docs -type f --extension md --path-query readme --limit 10`,
		});
		const recursivePathQuery = await run({
			command: `find ${test_db_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
		});
		const regexPathPredicate = await run({
			command: `find ${test_db_files_mount}/docs -type f -regex '.*readme.*' --limit 10`,
		});

		expect(scopedDepth.metadata.exitCode).toBe(2);
		expect(scopedDepth.stderr).toContain("name search reads the whole folder; omit -maxdepth.");
		expect(scopedDepth.stderr).toContain(`Try: find ${test_db_files_mount}/docs -name readme --limit 10`);
		expect(tokenGlobName.metadata.exitCode).toBe(2);
		expect(tokenGlobName.stderr).toContain(`Try: find ${test_db_files_mount} -type f -name readme --limit 10`);
		expect(prefixExtensionGlobName.metadata.exitCode).toBe(2);
		expect(prefixExtensionGlobName.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f -name readme --limit 10`,
		);
		expect(complexGlobName.metadata.exitCode).toBe(2);
		expect(complexGlobName.stderr).toContain("not glob patterns");
		expect(complexGlobName.stderr).toContain("Try `find <dir> -type f --extension md");
		expect(pathQueryGlob.metadata.exitCode).toBe(2);
		expect(pathQueryGlob.stderr).toContain("--path-query uses path word search for /.plugins and /.mounts");
		expect(pathQueryGlob.stderr).toContain(`Try: find ${test_db_files_mount} -name readme --limit 10`);
		expect(combinedPathQueryExtension.metadata.exitCode).toBe(2);
		expect(combinedPathQueryExtension.stderr).toContain("--path-query is not supported for app files");
		expect(recursivePathQuery.metadata.exitCode).toBe(2);
		expect(recursivePathQuery.stderr).toContain("--path-query is not supported for app files");
		expect(regexPathPredicate.metadata.exitCode).toBe(2);
		expect(regexPathPredicate.stderr).toContain(
			`Try: find ${test_db_files_mount}/docs -type f -name readme --limit 10`,
		);
	});

	test("filters non-search find pages before pagination", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 1` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(result.stdout).toContain("Next page:");
	});

	test("rejects unsupported find predicates when pagination is requested", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `find ${test_db_files_mount}/docs -delete --limit 10` });
		const regexResult = await run({
			command: `find ${test_db_files_mount}/docs -regextype posix-extended -regex '.*readme.*' --limit 10`,
		});
		const nativeJustBashResult = await run({ command: "find /tmp -mtime 1 --limit 1" });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("unsupported predicate -delete");
		expect(result.stderr).toContain("/home/cloud-usr/w");
		expect(result.stderr).toContain("use -name QUERY");
		expect(result.stderr).toContain("Usage: find");
		expect(regexResult.metadata.exitCode).toBe(2);
		expect(regexResult.stderr).toContain("unsupported predicate -regextype");
		expect(regexResult.stderr).toContain("use -name with plain name words");
		expect(regexResult.stderr).toContain(`Try: find ${test_db_files_mount}/docs -name readme --limit 10`);
		expect(regexResult.stderr).not.toContain("supports one path only");
		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("ignores app pagination options outside the app file mount without Convex queries", async () => {
		const { run, runQuery } = await create_bash_runner();

		const lsResult = await run({ command: "ls --limit 1 /tmp" });
		const lsCursorResult = await run({ command: "ls /tmp --cursor missing" });
		const findResult = await run({ command: "find /tmp --limit 1" });
		const findCursorResult = await run({ command: "find /tmp --cursor missing" });
		const plainTreeResult = await run({ command: "tree /tmp" });
		const treeResult = await run({ command: "tree /tmp --limit 1" });
		const treeCursorResult = await run({ command: "tree /tmp --cursor missing" });
		const malformedLimitResult = await run({ command: "ls --limit nope /tmp" });

		expect(lsResult.metadata.exitCode).toBe(0);
		expect(lsCursorResult.metadata.exitCode).toBe(0);
		expect(findResult.metadata.exitCode).toBe(0);
		expect(findCursorResult.metadata.exitCode).toBe(0);
		expect(treeResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeResult.stderr).toBe(plainTreeResult.stderr);
		expect(treeCursorResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
		expect(treeCursorResult.stdout).toBe(plainTreeResult.stdout);
		expect(treeCursorResult.stderr).toBe(plainTreeResult.stderr);
		expect(malformedLimitResult.metadata.exitCode).toBe(2);
		expect(malformedLimitResult.stderr).toContain("ls: --limit must be an integer");
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("resolves exact parent folders through db-files path lookups", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `cd ${test_db_files_mount}/reports && pwd` });
		const reportsLookupCalls = runQuery.mock.calls.filter((call) => {
			const queryArgs = call[1];
			return (
				queryArgs &&
				typeof queryArgs === "object" &&
				!("maxDepth" in queryArgs) &&
				"path" in queryArgs &&
				queryArgs.path === "/reports"
			);
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/reports`);
		expect(reportsLookupCalls.length).toBeGreaterThan(0);
	});

	test("rejects app glob patterns without falling back to capped enumeration", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `ls ${test_db_files_mount}/docs/*.md` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.metadata.pathIndexTruncated).toBe(false);
		expect(result.stderr).toContain("app file glob patterns are not supported");
		expect(result.stderr).toContain(`Try: find ${test_db_files_mount}/docs -type f --extension md --limit 20`);
	});

	test("expands scratch globs but rejects app globs after cwd resolution", async () => {
		const { run } = await create_bash_runner();

		const writeTmp = await run({ command: "printf 'alpha\\n' > /tmp/a.txt && printf 'beta\\n' > /tmp/b.txt" });
		const cdTmp = await run({ command: "cd /tmp" });
		const tmpGlob = await run({ command: "cat *.txt" });
		const cdApp = await run({ command: `cd ${test_db_files_mount}/docs` });
		const appGlob = await run({ command: "ls *.md" });

		expect(writeTmp.metadata.exitCode).toBe(0);
		expect(cdTmp.metadata.exitCode).toBe(0);
		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("alpha\n");
		expect(tmpGlob.stdout).toContain("beta\n");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(cdApp.metadata.exitCode).toBe(0);
		expect(appGlob.metadata.exitCode).toBe(2);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("Try: find . -type f --extension md --limit 20");
	});

	test("does not alias root listing to app files", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: "ls /" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).not.toContain("docs");
		expect(result.stdout).not.toContain("source.pdf");
		expect(result.stdout).toContain("home");
		expect(result.stdout).toContain("tmp");
	});

	test("does not expose the removed legacy mount", async () => {
		const { run } = await create_bash_runner();
		const legacyMount = "/work" + "space";

		const result = await run({ command: `ls ${legacyMount}` });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("readme.md");
	});

	test("explains unreadable uploaded source files through bash cat", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/source.pdf` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
		expect(result.stderr).toContain("Bash can read editable text files only");
		expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.md`);
		expect(result.stderr).toContain(`${test_db_files_mount}/source.txt`);
	});

	test("keeps unreadable cat advisories out of pipelines", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/source.pdf | grep application/pdf` });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("content type is 'application/pdf'");
	});

	test("does not suggest rereading the same unreadable file path", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `cat ${test_db_files_mount}/uploaded.md` });
		const suggestionLine = result.stderr
			.split("\n")
			.find((line) => line.startsWith("To read generated text output for this file"));

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(suggestionLine).toBeDefined();
		// The advisory must suggest readable siblings, never re-reading the same unreadable path.
		expect(suggestionLine).not.toContain(`${test_db_files_mount}/uploaded.md,`);
		expect(suggestionLine?.endsWith(`${test_db_files_mount}/uploaded.md`)).toBe(false);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.md.md`);
		expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.txt`);
	});

	test("app redirect writes become pending proposals and same-thread /tmp scratch files persist", async () => {
		const { run, runMutation } = await create_bash_runner();

		const organizationWrite = await run({ command: `echo nope > ${test_db_files_mount}/docs/new.md` });
		expect(organizationWrite.metadata.exitCode).toBe(0);
		expect(organizationWrite.stderr).toBe("");

		const tmpWrite = await run({ command: "printf hi > /tmp/a.txt" });
		expect(tmpWrite.metadata.exitCode).toBe(0);

		const nextInvocation = await run({ command: "cat /tmp/a.txt" });
		expect(nextInvocation.metadata.exitCode).toBe(0);
		expect(nextInvocation.stdout).toBe("hi");

		// Only the tmp write flushes; the app proposal write and the read do not.
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		expect(patchCalls).toHaveLength(1);
	});

	test("flushes only changed /tmp paths as a delta", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({ command: "printf one > /tmp/a.txt && printf two > /tmp/b.txt" });
		const update = await run({ command: "printf ONE > /tmp/a.txt" });

		expect(update.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a.txt"]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([{ path: "/a.txt", content: expect.any(ArrayBuffer) }]);
		expect(lastPatchArgs?.deletePaths).toEqual([]);

		const read = await run({ command: "cat /tmp/a.txt /tmp/b.txt" });
		expect(read.stdout).toBe("ONEtwo");
	});

	test("flushes a /tmp file whose name is not ASCII and one that holds half a character", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Convex allows only printable ASCII field names, so while this payload kept the content in a
		// record keyed by path, one file named `café.txt` failed the whole call. A name can also hold
		// half a character, which Convex refuses anywhere. That one is repaired on its way out, like the
		// output is.
		const wrote = await run({ command: `printf hi > /tmp/café.txt && printf hi > "/tmp/$(printf 'a\\ud83c').txt"` });
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
		expect(lastPatchArgs?.fileNodesContent.map((entry) => entry.path).sort()).toEqual(["/a�.txt", "/café.txt"]);
	});

	test("keeps one /tmp node when two names repair to the same path", async () => {
		const { run, runMutation } = await create_bash_runner();

		// Every half of a character is repaired to the same U+FFFD, so these two names leave the call as
		// one path. Only one node may be sent for it. Two would write two docs for one path, and the next
		// call could not even build the filesystem: `mkdir` refuses a path a file already holds, so every
		// later call in the thread would fail before it ran a command.
		const wrote = await run({
			command: `printf hi > "/tmp/$(printf 'a\\ud83c').txt" && mkdir "/tmp/$(printf 'a\\udf89').txt"`,
		});
		expect(wrote.metadata.exitCode, wrote.stderr).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| { fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"] }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a�.txt"]);

		// The thread still works: the next call reads the /tmp it just wrote.
		expect((await run({ command: "ls /tmp" })).metadata.exitCode).toBe(0);
	});
	test("flushes /tmp removals as delete-only deltas", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({ command: "printf one > /tmp/a.txt && printf two > /tmp/b.txt" });
		const remove = await run({ command: "rm /tmp/a.txt" });

		expect(remove.metadata.exitCode).toBe(0);

		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as { fileNodes: unknown[]; deletePaths: string[] } | undefined;
		expect(lastPatchArgs?.fileNodes).toEqual([]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/a.txt"]);
	});

	test("persists nested /tmp creates and recursive deletes through deltas", async () => {
		const { run } = await create_bash_runner();

		const create = await run({ command: "mkdir -p /tmp/a/b && printf nested > /tmp/a/b/c.txt" });
		expect(create.metadata.exitCode).toBe(0);

		const hydratedRead = await run({ command: "cat /tmp/a/b/c.txt" });
		expect(hydratedRead.metadata.exitCode).toBe(0);
		expect(hydratedRead.stdout).toBe("nested");

		const remove = await run({ command: "rm -r /tmp/a" });
		expect(remove.metadata.exitCode).toBe(0);

		const missing = await run({ command: "cat /tmp/a/b/c.txt" });
		expect(missing.metadata.exitCode).not.toBe(0);
		expect(missing.stderr).toContain("No such file");
	});

	test("persists /tmp copy and move changes through deltas", async () => {
		const { run } = await create_bash_runner();

		await run({
			command: "mkdir -p /tmp/src && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
		});
		const copyMove = await run({ command: "cp -r /tmp/src /tmp/copy && mv /tmp/to-move.txt /tmp/moved.txt" });

		expect(copyMove.metadata.exitCode).toBe(0);

		const read = await run({ command: "cat /tmp/src/a.txt /tmp/copy/a.txt /tmp/moved.txt" });
		expect(read.stdout).toBe("copiedcopiedmoved");
	});

	test("persists /tmp copy and move into existing directories through real destination paths", async () => {
		const { run, runMutation } = await create_bash_runner();

		await run({
			command:
				"mkdir -p /tmp/src /tmp/copy-dir /tmp/move-dir && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
		});
		runMutation.mockClear();

		const copyMove = await run({ command: "cp /tmp/src/a.txt /tmp/copy-dir && mv /tmp/to-move.txt /tmp/move-dir" });

		expect(copyMove.metadata.exitCode).toBe(0);
		const patchCalls = runMutation.mock.calls.filter(
			([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
		);
		const lastPatchArgs = patchCalls.at(-1)?.[1] as
			| {
					fileNodes: ai_chat_files_patch_thread_tmp_files_Args["fileNodes"];
					fileNodesContent: ai_chat_files_patch_thread_tmp_files_Args["fileNodesContent"];
					deletePaths: string[];
			  }
			| undefined;
		expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual([
			"/copy-dir/a.txt",
			"/move-dir/to-move.txt",
		]);
		expect(lastPatchArgs?.fileNodesContent).toEqual([
			{ path: "/copy-dir/a.txt", content: expect.any(ArrayBuffer) },
			{ path: "/move-dir/to-move.txt", content: expect.any(ArrayBuffer) },
		]);
		expect(lastPatchArgs?.deletePaths).toEqual(["/to-move.txt"]);

		const read = await run({ command: "cat /tmp/copy-dir/a.txt /tmp/move-dir/to-move.txt" });
		expect(read.stdout).toBe("copiedmoved");
	});

	test("scopes durable /tmp scratch files by thread", async () => {
		const writer = await create_bash_runner();
		await writer.run({ command: "printf thread-a > /tmp/scope.txt" });
		const shared = { t: writer.t, seeded: writer.seeded };

		const sameScope = await create_bash_runner({ shared, threadId: writer.threadId });
		const sameScopeRead = await sameScope.run({ command: "cat /tmp/scope.txt" });
		expect(sameScopeRead.metadata.exitCode).toBe(0);
		expect(sameScopeRead.stdout).toBe("thread-a");

		const otherThread = await create_bash_runner({ shared });
		const otherThreadRead = await otherThread.run({ command: "cat /tmp/scope.txt" });
		expect(otherThreadRead.metadata.exitCode).not.toBe(0);
		expect(otherThreadRead.stderr).toContain("No such file");

		const otherUserSeeded = await writer.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, {}));
		const sameThreadOtherUser = await create_bash_runner({
			shared,
			threadId: writer.threadId,
			userId: otherUserSeeded.userId,
		});
		await expect(sameThreadOtherUser.run({ command: "cat /tmp/scope.txt" })).rejects.toThrow("Unauthorized");
	});

	test("merges parallel same-thread /tmp writes through deltas", async () => {
		const { run } = await create_bash_runner();

		const [aResult, bResult] = await Promise.all([
			run({ command: "printf a > /tmp/a.txt" }),
			run({ command: "printf b > /tmp/b.txt" }),
		]);
		expect(aResult.metadata.exitCode).toBe(0);
		expect(bResult.metadata.exitCode).toBe(0);

		const read = await run({ command: "cat /tmp/a.txt /tmp/b.txt" });
		expect(read.metadata.exitCode).toBe(0);
		expect(read.stdout).toBe("ab");
	});

	test("evicts the oldest /tmp scratch paths beyond the path cap", async () => {
		const { run } = await create_bash_runner();

		await run({ command: "printf old > /tmp/old.txt" });
		// The path cap is private to bash.ts and small in dev. 20 new paths are enough to go over it.
		// The exact eviction count is asserted by the in-source tmp_fs_evict_to_limits tests.
		const paths = Array.from({ length: 20 }, (_, index) => `/tmp/p-${index}.txt`).join(" ");
		const overflow = await run({ command: `touch ${paths}` });
		expect(overflow.metadata.exitCode).toBe(0);
		// old.txt was written by an earlier call, so it is the oldest path and is listed first.
		expect(overflow.stderr).toContain("oldest path(s) to fit: /tmp/old.txt");

		const list = await run({ command: "ls /tmp" });
		expect(list.stdout).toContain("p-");
		expect(list.stdout).not.toContain("old.txt");
	});

	test("evicts the oldest /tmp scratch files beyond the byte cap", async () => {
		const { run } = await create_bash_runner();

		// Each seq output is ~1.7KB: under the per-file cap, but three together pass the 4KB session cap.
		const first = await run({ command: "seq 1 470 > /tmp/a.txt" });
		expect(first.stderr).toBe("");
		const overflow = await run({ command: "seq 1 470 > /tmp/b.txt && seq 1 470 > /tmp/c.txt" });
		expect(overflow.metadata.exitCode).toBe(0);
		expect(overflow.stderr).toContain("evicted the 1 oldest path(s) to fit: /tmp/a.txt");

		const evictedRead = await run({ command: "cat /tmp/a.txt" });
		expect(evictedRead.metadata.exitCode).not.toBe(0);
		const survivorsRead = await run({ command: "cat /tmp/b.txt /tmp/c.txt" });
		expect(survivorsRead.metadata.exitCode).toBe(0);
	});

	test("evicts only the offending /tmp file beyond the per-file cap", async () => {
		const { run } = await create_bash_runner();

		// seq 1 1000 is ~3.9KB, past the 2KB per-file cap.
		const result = await run({ command: "seq 1 1000 > /tmp/big.txt && printf keep > /tmp/keep.txt" });
		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toContain("discarded 1 oversized file(s): /tmp/big.txt");

		const read = await run({ command: "cat /tmp/keep.txt && cat /tmp/big.txt" });
		expect(read.stdout).toBe("keep");
		expect(read.metadata.exitCode).not.toBe(0);
	});

	test("creates persistent app file tree folders through bash mkdir when allowed", async () => {
		const { run, runMutation, seeded } = await create_bash_runner({ allowDbFilesMkdir: true });

		const result = await run({
			command: `mkdir ${test_db_files_mount}/bash-created && stat ${test_db_files_mount}/bash-created && ls ${test_db_files_mount}`,
		});

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("drwx");
		expect(result.stdout).toContain("bash-created");
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/bash-created",
				userId: seeded.userId,
			}),
		);
	});

	test("blocks app file tree folder creation through bash mkdir when not allowed", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: false });

		const result = await run({ command: `mkdir ${test_db_files_mount}/ask-denied` });

		expect(result.metadata.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Agent mode");
		expect(result.stderr).toContain("Scratch space does not create durable folders");
		expect(runMutation).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				path: "/ask-denied",
			}),
		);
	});

	test("normalizes the skills folder through bash mkdir", async () => {
		const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: true });
		const result = await run({ command: `mkdir -p ${test_db_files_mount}/.AGENTS/skills/one` });
		expect(result.metadata.exitCode).toBe(0);
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ path: "/.agents/skills/one" }),
		);
	});

	test("runs indexed search with options before the query", async () => {
		const { run, runQuery, seeded } = await create_bash_runner();

		const result = await run({ command: "search --limit 5 unique-token" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: seeded.userId,
				query: "unique-token",
				numItems: 5,
				cursor: null,
			}),
		);
	});

	test("runs indexed search with equals-form options", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `search --path=${test_db_files_mount}/docs --limit=5 unique-token` });

		expect(result.metadata.exitCode).toBe(0);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				query: "unique-token",
				numItems: 5,
				pathPrefix: "/docs",
			}),
		);
	});

	test("annotates broad full-text results for exact hyphenated token searches", async () => {
		// The broad fixture's intraword bold breaks the literal token in the markdown chunk while
		// the plain-text search index still matches it; the hit stays in the page with a
		// word-level note instead of being filtered out.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run({ command: "search --limit 5 exact-hyphen-token-2026" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Found 2 results (exact matches: 1, word-level-only matches: 1; see per-hit notes)",
		);
		expect(result.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("finds content whose phrase spans a chunk boundary", async () => {
		// Chunks are cut at a hard character offset with no overlap (see OVERLAP in
		// files-markdown-chunking-mastra.ts), so a phrase across the cut lives in no single chunk.
		// Recall must not depend on overlap: the per-chunk term index still has to surface the file.
		const phrase = "quarterly revenue reconciliation";
		const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: "/split/boundary.md",
					content: `# Report\n\n${filler.repeat(20).slice(0, 1190)}${phrase} tail words follow.\n`,
				},
			],
		});

		const result = await run({ command: `search --limit 5 "${phrase}"` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Found 1 results");
		expect(result.stdout).toContain("/split/boundary.md");
		// The snippet shows the side of the cut that holds most of the phrase, and flags the rest.
		expect(result.stdout).toContain("revenue reconciliation tail words follow.");
		expect(result.stdout).toContain("... more content above");
	});

	test("keeps word-level-only search pages full and the continuation reachable", async () => {
		// Broad file is seeded first so the limit-1 first page holds only the word-level hit;
		// the exact match lives on the next page and must stay reachable via Next page.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
			],
		});

		const firstPage = await run({ command: "search --limit 1 exact-hyphen-token-2026" });

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain(
			"Found 1 results (exact matches: 0, word-level-only matches: 1; see per-hit notes)",
		);
		expect(firstPage.stdout).toMatch(
			/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ exact-hyphen-token-2026/u);
		expect(firstPage.stdout.indexOf("Next page: search")).toBeLessThan(
			firstPage.stdout.indexOf(`${test_db_files_mount}/search-fixtures/broad.md`),
		);
		expect(firstPage.stdout).toContain("run the exact Next page command before answering");

		const continuation = firstPage.stdout.match(/Next page: (search .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a search continuation in the first page stdout");
		}
		const secondPage = await run({ command: continuation });

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("exact-hyphen-token-2026 inside");
		expect(secondPage.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
	});

	test("rejects indexed search invalid limit values", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "search --limit nope unique-token" });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("search: --limit must be an integer");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("prints a search continuation when indexed search has another db page", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const firstPage = await run({ command: "search --limit 1 paged-token" });
		const complete = await run({ command: "search --limit 5 unique-token" });

		expect(firstPage.metadata.exitCode).toBe(0);
		expect(firstPage.stdout).toContain("Found 1 results");
		expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ paged-token/u);
		expect(complete.stdout).not.toContain("Next page: search");
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("reports unknown indexed search cursor ids", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: "search --limit 1 --cursor cursor-1 paged-token" });

		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
		expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: "cursor-1" });
	});

	test("does not probe scoped search continuations because Convex filters paginate results", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
				{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
			],
		});

		const result = await run({ command: `search --path ${test_db_files_mount}/docs --limit 1 paged-token` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("Next page: search --path");
		expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "paged-token", pathPrefix: "/docs", numItems: 1 }),
		);
		const pageProbeCalls = runQuery.mock.calls.filter(
			([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
		);
		expect(pageProbeCalls).toHaveLength(0);
	});

	test("rejects db-files path operands in indexed search instead of folding them into the query", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `search --limit 5 unique-token ${test_db_files_mount}` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stderr).toContain("path operands are not supported");
		expect(result.stderr).toContain("search --path <folder>");
		expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
	});

	test("scopes indexed search to a folder with --path", async () => {
		const { run, runQuery } = await create_bash_runner();

		// In-scope folder -> hit, and the db-files path is passed through to the query.
		const inScope = await run({ command: `search --path ${test_db_files_mount}/docs unique-token` });
		expect(inScope.metadata.exitCode).toBe(0);
		expect(inScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(inScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Bare search follows the current app cwd so "cd dir && search term" stays db-scoped.
		const cwdScope = await run({ command: `cd ${test_db_files_mount}/docs && search unique-token` });
		expect(cwdScope.metadata.exitCode).toBe(0);
		expect(cwdScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(cwdScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
		const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Relative --path (including `.`) resolves against the current working directory.
		const relScope = await run({ command: `cd ${test_db_files_mount} && search --path docs unique-token` });
		expect(relScope.metadata.exitCode).toBe(0);
		expect(relScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(relScope.stdout).toContain(`under ${test_db_files_mount}/docs`);

		const dotScope = await run({ command: `cd ${test_db_files_mount}/docs && search --path . unique-token` });
		expect(dotScope.metadata.exitCode).toBe(0);
		expect(dotScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		const relCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
		expect(relCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

		// Explicit --path scopes must be real app folders.
		const missingScope = await run({ command: `search --path ${test_db_files_mount}/other unique-token` });
		expect(missingScope.metadata.exitCode).toBe(1);
		expect(missingScope.stderr).toContain("--path folder does not exist");

		const fileScope = await run({ command: `search --path ${test_db_files_mount}/docs/readme.md unique-token` });
		expect(fileScope.metadata.exitCode).toBe(2);
		expect(fileScope.stderr).toContain("--path must be a folder");

		// A --path outside currentWorkspacePath (and outside any mount) is rejected.
		const bad = await run({ command: "search --path /etc unique-token" });
		expect(bad.metadata.exitCode).toBe(2);
		expect(bad.stderr).toContain("--path must be a folder under");
	});

	test("textgrep scans one file's rendered plain text and maps -R to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;

		// Single-file regex over rendered plain text: no line numbers, no separators.
		const singleFile = await run({ command: `textgrep 'critical\\s+alert' ${filePath}` });
		expect(singleFile.metadata.exitCode).toBe(0);
		expect(singleFile.stdout).toBe("critical alert\n");
		expect(singleFile.stderr).toBe("");

		// -F treats regex metacharacters literally, so "critical.alert" does not match.
		const fixed = await run({ command: `textgrep -F 'critical.alert' ${filePath}` });
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");

		// -c counts matching lines; an absent pattern still prints 0 (exit 1).
		const count = await run({ command: `textgrep -c 'critical' ${filePath}` });
		expect(count.metadata.exitCode).toBe(0);
		expect(count.stdout).toBe("1\n");
		const countAbsent = await run({ command: `textgrep -c 'absent-token' ${filePath}` });
		expect(countAbsent.metadata.exitCode).toBe(1);
		expect(countAbsent.stdout).toBe("0\n");

		// -l prints the path when there is a match.
		const list = await run({ command: `textgrep -l 'critical' ${filePath}` });
		expect(list.metadata.exitCode).toBe(0);
		expect(list.stdout).toBe(`${filePath}\n`);

		// -v keeps non-matching lines.
		const invert = await run({ command: `textgrep -v 'critical' ${filePath}` });
		expect(invert.metadata.exitCode).toBe(0);
		expect(invert.stdout).not.toContain("critical alert");

		// -R folder scan routes to indexed full-text search, mirroring grep -R.
		const recursive = await run({ command: `textgrep -R unique-token ${test_db_files_mount}/docs` });
		expect(recursive.metadata.exitCode).toBe(0);
		expect(recursive.stdout).toContain("uses indexed full-text search");
		expect(recursive.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(recursive.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(true);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);

		// Invalid regex over a single file is reported.
		const invalid = await run({ command: `textgrep '[' ${filePath}` });
		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("invalid regex");

		// -n is rejected with a pointer to grep.
		const lineNumbers = await run({ command: `textgrep -n 'critical' ${filePath}` });
		expect(lineNumbers.metadata.exitCode).toBe(2);
		expect(lineNumbers.stderr).toContain("grep -n");
	});

	test("textgrep parses extended grep flags and rejects unsupported / recursive-fixed-string forms", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
		});
		const filePath = `${test_db_files_mount}/docs/textgrep.md`;
		const folder = `${test_db_files_mount}/docs`;

		// -e / --regexp supply the pattern explicitly.
		const dashE = await run({ command: `textgrep -e 'critical' ${filePath}` });
		expect(dashE.metadata.exitCode).toBe(0);
		expect(dashE.stdout).toBe("critical alert\n");
		const longRegexp = await run({ command: `textgrep --regexp='critical' ${filePath}` });
		expect(longRegexp.metadata.exitCode).toBe(0);
		expect(longRegexp.stdout).toBe("critical alert\n");

		// Combined short flags: -iF (ignore-case + fixed string), -cl (count + list → list wins).
		const combinedIF = await run({ command: `textgrep -iF 'CRITICAL' ${filePath}` });
		expect(combinedIF.metadata.exitCode).toBe(0);
		expect(combinedIF.stdout).toBe("critical alert\n");
		const combinedCL = await run({ command: `textgrep -cl 'critical' ${filePath}` });
		expect(combinedCL.metadata.exitCode).toBe(0);
		expect(combinedCL.stdout).toBe(`${filePath}\n`);

		// Long aliases mirror their short forms.
		const longFixed = await run({ command: `textgrep --fixed-strings 'critical.alert' ${filePath}` });
		expect(longFixed.metadata.exitCode).toBe(1);
		expect(longFixed.stdout).toBe("");
		const longInvert = await run({ command: `textgrep --invert-match 'critical' ${filePath}` });
		expect(longInvert.metadata.exitCode).toBe(0);
		expect(longInvert.stdout).not.toContain("critical alert");
		const longCount = await run({ command: `textgrep --count 'critical' ${filePath}` });
		expect(longCount.metadata.exitCode).toBe(0);
		expect(longCount.stdout).toBe("1\n");
		const longList = await run({ command: `textgrep --files-with-matches 'critical' ${filePath}` });
		expect(longList.metadata.exitCode).toBe(0);
		expect(longList.stdout).toBe(`${filePath}\n`);

		// Context flags are rejected with a pointer to grep.
		for (const contextFlag of ["-A 1", "-B 1", "-C 1", "--context=2"]) {
			const contextRes = await run({ command: `textgrep ${contextFlag} 'critical' ${filePath}` });
			expect(contextRes.metadata.exitCode).toBe(2);
			expect(contextRes.stderr).toContain("context windows");
		}

		// Markdown scan-window flags are rejected.
		const startLine = await run({ command: `textgrep --start-line 2 'critical' ${filePath}` });
		expect(startLine.metadata.exitCode).toBe(2);
		expect(startLine.stderr).toContain("scan-window");
		const startIndex = await run({ command: `textgrep --start-index 0 'critical' ${filePath}` });
		expect(startIndex.metadata.exitCode).toBe(2);
		expect(startIndex.stderr).toContain("scan-window");

		// Removed folder-regex flags now surface as unsupported options.
		for (const removedFlag of ["--path", "--limit", "--cursor"]) {
			const removed = await run({ command: `textgrep ${removedFlag} 'critical' ${filePath}` });
			expect(removed.metadata.exitCode).toBe(2);
			expect(removed.stderr).toContain(`unsupported option ${removedFlag}`);
		}

		// Recursive -c / -l / -v fall to single-file guidance, never indexed search.
		for (const recursiveFlag of ["-c", "-l", "-v"]) {
			const recursive = await run({ command: `textgrep -R ${recursiveFlag} 'critical' ${folder}` });
			expect(recursive.metadata.exitCode).toBe(2);
			expect(recursive.stdout).toContain("textgrep regex runs over ONE app file");
		}

		// Recursive -F is rejected: indexed scans cannot do exact fixed-string matching.
		const recursiveFixed = await run({ command: `textgrep -R -F 'critical' ${folder}` });
		expect(recursiveFixed.metadata.exitCode).toBe(2);
		expect(recursiveFixed.stderr).toContain("does not support exact fixed-string");

		// None of the rejected/guidance forms above reached indexed full-text search.
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("meta searches indexed frontmatter and inspects one file", async () => {
		const { run, runQuery } = await create_bash_runner({
			extraFiles: [
				{
					path: "/docs/meta-email.md",
					content:
						"---\nfrom: alice@example.com\ncc:\n  - Bob\n  - Jane\namount: 125\nreviewed: true\nsentAt: 2026-07-29T14:30:00Z\n---\n# Email\n",
				},
				{
					path: "/docs/meta-tags.md",
					content: "---\ntopic:\n  - alpha\n  - atlas\n---\n# Tags\n",
				},
			],
		});

		const paths = await run({
			command: `meta search --where '{"eq":["frontmatter.from","alice@example.com"]}' --limit 5`,
		});
		const json = await run({
			command: `meta search --format json --where '{"range":["frontmatter.amount",{"gte":100}]}'`,
		});
		const jsonExists = await run({ command: `meta search --format json --where '{"exists":"frontmatter.cc"}'` });
		const jsonDateRange = await run({
			command: `meta search --format json --where '{"range":["frontmatter.sentAt",{"gte":"2026-07-27","lt":"2026-08-02"}]}'`,
		});
		const dedupedPrefix = await run({
			command: `meta search --where '{"prefix":["frontmatter.topic","a"]}' --limit 5`,
		});
		const scoped = await run({
			command: `cd ${test_db_files_mount}/docs && meta search --where '{"exists":"frontmatter.cc"}'`,
		});
		const get = await run({ command: `meta get ${test_db_files_mount}/docs/meta-email.md` });
		const invalid = await run({ command: `meta search --where '{"eq":["from","alice@example.com"]}'` });

		expect(paths.metadata.exitCode).toBe(0);
		expect(paths.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(paths.stderr).toBe("");
		expect(
			runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_metadata_saved" &&
					(args as { plan?: unknown }).plan != null,
			),
		).toBe(true);

		expect(json.metadata.exitCode).toBe(0);
		expect(json.stderr).toBe("");
		const parsedJson = JSON.parse(json.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
			nextCursor: string | null;
		};
		expect(parsedJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.amount",
				valueKind: "number",
				matchedValue: 125,
			}),
		]);
		expect(parsedJson.nextCursor).toBeNull();

		expect(jsonExists.metadata.exitCode).toBe(0);
		expect(jsonExists.stderr).toBe("");
		const parsedExistsJson = JSON.parse(jsonExists.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue?: unknown }>;
		};
		expect(parsedExistsJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.cc",
				valueKind: "none",
			}),
		]);
		expect(parsedExistsJson.results[0]).not.toHaveProperty("matchedValue");

		expect(jsonDateRange.metadata.exitCode).toBe(0);
		expect(jsonDateRange.stderr).toBe("");
		const parsedDateRangeJson = JSON.parse(jsonDateRange.stdout) as {
			results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
		};
		// Confirm that string bounds match the maybe_date companion doc and render as an ISO string.
		expect(parsedDateRangeJson.results).toEqual([
			expect.objectContaining({
				path: `${test_db_files_mount}/docs/meta-email.md`,
				field: "frontmatter.sentAt",
				valueKind: "maybe_date",
				matchedValue: "2026-07-29T14:30:00.000Z",
			}),
		]);

		expect(dedupedPrefix.metadata.exitCode).toBe(0);
		expect(dedupedPrefix.stderr).toBe("");
		expect(dedupedPrefix.stdout).toBe(`${test_db_files_mount}/docs/meta-tags.md\n`);

		expect(scoped.metadata.exitCode).toBe(0);
		expect(scoped.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
		expect(
			runQuery.mock.calls.some(
				([ref, args]) =>
					function_name_of(ref) === "files_visible:internal_search_metadata_saved" &&
					(args as { folderPath?: string }).folderPath === "/docs",
			),
		).toBe(true);

		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain("source: committed");
		expect(get.stdout).toContain("frontmatter.cc");
		expect(get.stdout).toContain('frontmatter.from = "alice@example.com"');
		// A date-like string produces two lines. Only the maybe_date line carries the marker, so the
		// agent can tell them apart and see that the field supports range filters.
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00Z"\n');
		expect(get.stdout).toContain('frontmatter.sentAt = "2026-07-29T14:30:00.000Z" (maybe_date)');

		expect(invalid.metadata.exitCode).toBe(2);
		expect(invalid.stderr).toContain("must be qualified");
	});

	test("meta search with a folder keeps rows under it and finds a folder moved into it", async () => {
		const topic = "---\ntopic: atlas\n---\n# Topic\n";
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/docs/meta-in.md", content: topic },
				{ path: "/reports/meta-out.md", content: topic },
				{ path: "/outside/inner/meta-moved.md", content: topic },
			],
		});
		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/outside/inner ${test_db_files_mount}/docs/inner`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// `eq` reads the folder's own rows, then the rows under the folder moved into it.
		const eq = await runner.run({
			command: `meta search --path ${test_db_files_mount}/docs --where '{"eq":["frontmatter.topic","atlas"]}'`,
		});
		expect(eq.stderr).toBe("");
		expect(eq.stdout.split("\n").filter(Boolean).sort()).toEqual([
			`${test_db_files_mount}/docs/inner/meta-moved.md`,
			`${test_db_files_mount}/docs/meta-in.md`,
		]);

		// `prefix` reads the whole workspace and drops the rows outside the folder.
		const prefix = await runner.run({
			command: `meta search --path ${test_db_files_mount}/docs --where '{"prefix":["frontmatter.topic","at"]}'`,
		});
		expect(prefix.stderr).toBe("");
		expect(prefix.stdout.split("\n").filter(Boolean).sort()).toEqual([
			`${test_db_files_mount}/docs/inner/meta-moved.md`,
			`${test_db_files_mount}/docs/meta-in.md`,
		]);
	});

	test("meta search shows a row once when a folder inside a moved-in folder is renamed", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/outside/g/k/meta-target.md", content: "---\ntopic: atlas\n---\n# Topic\n" }],
		});
		for (const command of [
			`mv ${test_db_files_mount}/outside/g ${test_db_files_mount}/docs/g`,
			`mv ${test_db_files_mount}/docs/g/k ${test_db_files_mount}/docs/g/k2`,
		])
			expect((await runner.run({ command })).metadata.exitCode).toBe(0);

		// One row per page: the dedupe inside one call cannot hide a row that two streams return.
		const paths: string[] = [];
		let command: string | null =
			`meta search --path ${test_db_files_mount}/docs --where '{"eq":["frontmatter.topic","atlas"]}' --limit 1`;
		for (let page = 0; command !== null && page < 10; page++) {
			const result = await runner.run({ command });
			expect(result.metadata.exitCode).toBe(0);
			paths.push(...result.stdout.split("\n").filter(Boolean));
			// meta search prints its Next page command on stderr.
			command = result.stderr.startsWith("Next page: ") ? result.stderr.trim().slice("Next page: ".length) : null;
		}
		expect(paths).toEqual([`${test_db_files_mount}/docs/g/k2/meta-target.md`]);
	});

	test("reads and searches a folder map written by the metadata tool", async () => {
		const runner = await create_bash_runner();
		const tool = ai_chat_tool_create_set_file_metadata(runner.ctx, {
			...runner.ctxData,
			getThreadId: () => runner.threadId,
			getRun: () => runner.chatRun,
		});
		const written = await tool.execute?.(
			{
				workspace: "current",
				path: "/docs",
				set: [
					{ key: "plugin-name", value: "chitchat" },
					{ key: "reviewed", value: false },
				],
				remove: [],
			},
			{ toolCallId: "folder-metadata", messages: [] },
		);
		expect(written).toMatchObject({ metadata: { path: "/docs" } });

		const get = await runner.run({ command: `meta get ${test_db_files_mount}/docs` });
		expect(get.metadata.exitCode).toBe(0);
		expect(get.stdout).toContain('metadata.plugin-name = "chitchat"');
		expect(get.stdout).toContain("metadata.reviewed = false");
		expect(get.stdout).not.toContain("frontmatter.");
		const json = await runner.run({ command: `meta get ${test_db_files_mount}/docs --format json` });
		expect(json.metadata.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			path: `${test_db_files_mount}/docs`,
			fields: ["metadata.plugin-name", "metadata.reviewed"],
			values: [
				{ field: "metadata.plugin-name", valueKind: "string", value: "chitchat" },
				{ field: "metadata.reviewed", valueKind: "boolean", value: false },
			],
		});
		const search = await runner.run({ command: `meta search --where '{"eq":["metadata.plugin-name","chitchat"]}'` });
		expect(search.metadata.exitCode).toBe(0);
		expect(search.stdout).toBe(`${test_db_files_mount}/docs\n`);

		await tool.execute?.(
			{ workspace: "current", path: "/docs", set: [], remove: ["plugin-name", "reviewed"] },
			{ toolCallId: "remove-folder-metadata", messages: [] },
		);
		const empty = await runner.run({ command: `meta get ${test_db_files_mount}/docs --format json` });
		expect(empty.metadata.exitCode).toBe(0);
		expect(JSON.parse(empty.stdout)).toMatchObject({ fields: [], values: [] });
	});

	test("does not scan markdown files when indexed search misses", async () => {
		const { run, runAction } = await create_bash_runner();

		const result = await run({ command: "search --limit 5 zzz-absent-token" });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("No content matches found");
		expect(result.stdout).toContain("find -name QUERY");
		expect(result.stdout).toContain("meta search");
		expect(runAction).not.toHaveBeenCalled();
	});

	test("rejects chunk-type filters for indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const code = await run({ command: "search --code code-token" });
		const table = await run({ command: "search --table table-token" });
		const noCode = await run({ command: "search --no-code unique-token" });

		expect(code.metadata.exitCode).toBe(2);
		expect(table.metadata.exitCode).toBe(2);
		expect(noCode.metadata.exitCode).toBe(2);
		expect(code.stderr).toContain("--code is not supported");
		expect(table.stderr).toContain("--table is not supported");
		expect(noCode.stderr).toContain("--no-code is not supported");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("maps simple recursive app grep to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `grep -R unique-token ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("uses indexed full-text search");
		expect(result.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
		);
	});

	test("rejects grep -R -F over an app folder instead of routing to indexed search", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `grep -R -F unique-token ${test_db_files_mount}/docs` });

		expect(result.metadata.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("does not support exact fixed-string");
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(false);
	});

	test("annotates broad full-text results for exact hyphenated grep -R patterns", async () => {
		// Same intraword-bold trick as the search annotation tests: the index matches broad.md
		// but its markdown chunk lacks the literal token, so its hit carries the word-level note.
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/grep-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
			],
		});

		const result = await run({ command: `grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 2 results under ${test_db_files_mount}/grep-fixtures (exact matches: 1, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(/grep-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("keeps a grep -R page whose hits are only word-level matches", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" }],
		});

		const result = await run({ command: `grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Found 1 results under ${test_db_files_mount}/grep-fixtures (exact matches: 0, word-level-only matches: 1; see per-hit notes)`,
		);
		expect(result.stdout).toMatch(
			/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
		);
	});

	test("greps a single app file (regex by default, -F substring, optional line numbers, -i), guidance otherwise", async () => {
		const { run } = await create_bash_runner();

		// Single app file prints raw matching lines by default, like native grep.
		const hit = await run({ command: `grep unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(hit.metadata.exitCode).toBe(0);
		expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");

		// Single-file app grep supports regex because it scans one bounded chunk stream.
		const regexHit = await run({ command: `grep 'unique.*below' ${test_db_files_mount}/docs/readme.md` });
		expect(regexHit.metadata.exitCode).toBe(0);
		expect(regexHit.stdout).toBe("more unique-token below\n");

		const invalidRegex = await run({ command: `grep '[' ${test_db_files_mount}/docs/readme.md` });
		expect(invalidRegex.metadata.exitCode).toBe(2);
		expect(invalidRegex.stderr).toContain("invalid regex");

		// -F switches back to fixed-string semantics.
		const fixedMiss = await run({ command: `grep -F 'unique.*below' ${test_db_files_mount}/docs/readme.md` });
		expect(fixedMiss.metadata.exitCode).toBe(1);
		expect(fixedMiss.stdout).toBe("");

		// -n switches to 1-based line numbers.
		const numberedHit = await run({ command: `grep -n unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(numberedHit.metadata.exitCode).toBe(0);
		expect(numberedHit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const dashPattern = await run({ command: `grep -- -token ${test_db_files_mount}/docs/readme.md` });
		expect(dashPattern.metadata.exitCode).toBe(0);
		expect(dashPattern.stdout).toBe("unique-token here\nmore unique-token below\n");

		const piped = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`,
		});
		expect(piped.metadata.exitCode).toBe(0);
		expect(piped.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

		const pipedRegex = await run({ command: `cat ${test_db_files_mount}/docs/readme.md | grep 'unique.*below'` });
		expect(pipedRegex.metadata.exitCode).toBe(0);
		expect(pipedRegex.stdout).toBe("more unique-token below\n");

		const pipedFixedMiss = await run({
			command: `cat ${test_db_files_mount}/docs/readme.md | grep -F 'unique.*below'`,
		});
		expect(pipedFixedMiss.metadata.exitCode).toBe(1);
		expect(pipedFixedMiss.stdout).toBe("");

		// Case-insensitive.
		const ci = await run({ command: `grep -i ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(ci.metadata.exitCode).toBe(0);
		expect(ci.stdout).toBe("alpha\nALPHA\n");

		// No match → exit 1, no output (real grep semantics).
		const none = await run({ command: `grep zzz-nope ${test_db_files_mount}/docs/readme.md` });
		expect(none.metadata.exitCode).toBe(1);
		expect(none.stdout).toBe("");

		// Multiple files → falls back to guidance (we only handle one file).
		const multi = await run({
			command: `grep token ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
		});
		expect(multi.metadata.exitCode).toBe(2);
		expect(multi.stdout).toContain("is not supported");

		const unsupportedSingleFileFlag = await run({ command: `grep -o token ${test_db_files_mount}/docs/readme.md` });
		expect(unsupportedSingleFileFlag.metadata.exitCode).toBe(2);
		expect(unsupportedSingleFileFlag.stderr).toContain("unsupported option -o");
		expect(unsupportedSingleFileFlag.stderr).toContain("Supported: grep [-n] [-i] [-F]");

		// -c counts matching lines ("token" is on lines 2 and 3).
		const counted = await run({ command: `grep -c token ${test_db_files_mount}/docs/readme.md` });
		expect(counted.metadata.exitCode).toBe(0);
		expect(counted.stdout).toBe("2\n");

		// Multiple -e patterns (OR semantics we don't reproduce) → guidance, not a silent
		// single-pattern match.
		const multiE = await run({ command: `grep -e token -e other ${test_db_files_mount}/docs/readme.md` });
		expect(multiE.metadata.exitCode).toBe(2);

		// Combined short flags: -in (= -i -n) takes the single-file fast path, case-insensitively.
		const combined = await run({ command: `grep -in ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(combined.metadata.exitCode).toBe(0);
		expect(combined.stdout).toBe("2:alpha\n3:ALPHA\n");

		const fixedCombined = await run({ command: `grep -Fin alpha ${test_db_files_mount}/docs/tutorial.md` });
		expect(fixedCombined.metadata.exitCode).toBe(0);
		expect(fixedCombined.stdout).toBe("2:alpha\n3:ALPHA\n");

		// -iv (= -i -v) inverts: only line 1 lacks "token" (case-insensitively).
		const combinedV = await run({ command: `grep -iv token ${test_db_files_mount}/docs/readme.md` });
		expect(combinedV.metadata.exitCode).toBe(0);
		expect(combinedV.stdout).toBe("# Readme\n");

		// -l prints the file path when it has a match, and exits 1 (no output) when it does not.
		const listed = await run({ command: `grep -l unique-token ${test_db_files_mount}/docs/readme.md` });
		expect(listed.metadata.exitCode).toBe(0);
		expect(listed.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
		const listedNone = await run({ command: `grep -l zzz-nope ${test_db_files_mount}/docs/readme.md` });
		expect(listedNone.metadata.exitCode).toBe(1);
		expect(listedNone.stdout).toBe("");

		// -B N adds leading context. Without -n, both matching and context lines are raw text.
		const before = await run({ command: `grep -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(before.metadata.exitCode).toBe(0);
		expect(before.stdout).toBe("alpha\nALPHA\n");

		// With -n, context lines use "-" and selected lines use ":".
		const beforeNumbered = await run({ command: `grep -n -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md` });
		expect(beforeNumbered.metadata.exitCode).toBe(0);
		expect(beforeNumbered.stdout).toBe("2-alpha\n3:ALPHA\n");

		// -v without context stays native-like: non-contiguous selected lines are printed directly.
		const invertGap = await run({ command: `grep -v alpha ${test_db_files_mount}/docs/tutorial.md` });
		expect(invertGap.metadata.exitCode).toBe(0);
		expect(invertGap.stdout).toBe("zeta\nALPHA\n");

		const pipedInvertGap = await run({ command: `cat ${test_db_files_mount}/docs/tutorial.md | grep -v alpha` });
		expect(pipedInvertGap.metadata.exitCode).toBe(0);
		expect(pipedInvertGap.stdout).toBe("zeta\nALPHA\n");
	});

	test("supports app grep line and slice continuation windows", async () => {
		const latePath = "/docs/late-grep.md";
		const longPath = "/docs/long-line-grep.md";
		const longPrefix = "x".repeat(256 * 1024);
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path: latePath,
					content: ["first line", "late-window-token", "third line"].join("\n"),
				},
				{
					path: longPath,
					content: `${longPrefix}needle-after-long-prefix\n`,
				},
			],
		});

		const lineWindow = await run({
			command: `grep --start-line 3 --max-lines 1 unique-token ${test_db_files_mount}/docs/readme.md`,
		});
		expect(lineWindow.metadata.exitCode).toBe(0);
		expect(lineWindow.stdout).toBe("more unique-token below\n");

		const capped = await run({
			command: `grep --start-line 1 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		});
		expect(capped.metadata.exitCode).toBe(1);
		expect(capped.stdout).toBe("");
		expect(capped.stderr).toContain("line scan cap reached");
		expect(capped.stderr).toContain(
			`Next scan: grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		);

		const continued = await run({
			command: `grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
		});
		expect(continued.metadata.exitCode).toBe(0);
		expect(continued.stdout).toBe("late-window-token\n");

		const byteCapped = await run({ command: `grep needle-after-long-prefix ${test_db_files_mount}${longPath}` });
		expect(byteCapped.metadata.exitCode).toBe(1);
		expect(byteCapped.stdout).toBe("");
		expect(byteCapped.stderr).toContain("byte scan cap reached");
		const byteContinuationCommand = byteCapped.stderr.match(
			/Next scan: (grep --start-index 0 --max-chars \d+ needle-after-long-prefix [^\n]+)/u,
		)?.[1];
		expect(byteContinuationCommand?.startsWith("grep --start-index 0 --max-chars ")).toBe(true);
		expect(byteContinuationCommand).toContain(` needle-after-long-prefix ${test_db_files_mount}${longPath}`);

		const slice = await run({
			command: `grep --start-index ${longPrefix.length - 8} --max-chars 128 needle-after-long-prefix ${test_db_files_mount}${longPath}`,
		});
		expect(slice.metadata.exitCode).toBe(0);
		expect(slice.stdout).toBe(`xxxxxxxxneedle-after-long-prefix\n`);
		expect(slice.stderr).toContain("slice mode scans a text slice");
	});

	test("uses regex for single-file app grep patterns that look like regex", async () => {
		const { run } = await create_bash_runner();

		const anchored = await run({ command: `grep '^# Readme' ${test_db_files_mount}/docs/readme.md` });
		const wildcard = await run({ command: `grep 'unique.*token' ${test_db_files_mount}/docs/readme.md` });
		const fixed = await run({ command: `grep -F '^# Readme' ${test_db_files_mount}/docs/readme.md` });

		expect(anchored.metadata.exitCode).toBe(0);
		expect(anchored.stdout).toBe("# Readme\n");
		expect(anchored.stderr).toBe("");
		expect(wildcard.metadata.exitCode).toBe(0);
		expect(wildcard.stdout).toBe("unique-token here\nmore unique-token below\n");
		expect(fixed.metadata.exitCode).toBe(1);
		expect(fixed.stdout).toBe("");
		expect(fixed.stderr).toBe("");
	});

	test("warns when app grep output is capped", async () => {
		const path = "/docs/capped-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: Array.from({ length: 105 }, (_, index) => `cap-token ${index + 1}`).join("\n"),
				},
			],
		});

		const capped = await run({ command: `grep cap-token ${test_db_files_mount}${path}` });

		expect(capped.metadata.exitCode).toBe(0);
		expect(capped.stdout.split("\n").filter(Boolean)).toHaveLength(100);
		expect(capped.stderr).toContain("match cap reached");
		expect(capped.stderr).toContain("Next scan:");
	});

	test("treats chunk-unavailable app grep as no match", async () => {
		const path = "/docs/large-grep.md";
		const { run } = await create_bash_runner({
			extraFiles: [
				{
					path,
					content: `match-token\n${"filler-line\n".repeat(800)}`,
					brokenChunks: true,
				},
			],
		});
		const shellPath = `${test_db_files_mount}${path}`;

		const match = await run({ command: `grep match-token ${shellPath}` });
		const noMatch = await run({ command: `grep missing-token ${shellPath}` });

		for (const result of [match, noMatch]) {
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		}
		expect(noMatch.stdout).toBe("");
	});

	test("uses prefix find and renders app tree pages", async () => {
		const { run } = await create_bash_runner();
		const scopedRunner = await create_bash_runner({
			initialCwd: `${test_db_files_mount}/docs`,
			extraFiles: [{ path: "/docs/nested/more.md", content: "more\n" }],
		});

		const prefixResult = await run({ command: "find --prefix /docs --limit 20 -type f" });
		const relativePrefixResult = await scopedRunner.run({ command: "find --prefix nested --limit 1" });
		const treeResult = await run({ command: `tree ${test_db_files_mount}/docs --limit 2` });

		expect(prefixResult.metadata.exitCode).toBe(0);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
		expect(relativePrefixResult.metadata.exitCode).toBe(0);
		expect(relativePrefixResult.stdout).toMatch(
			new RegExp(`Next page: find --prefix ${test_db_files_mount}/docs/nested --limit 1 --cursor \\S+`, "u"),
		);
		expect(treeResult.metadata.exitCode).toBe(0);
		expect(treeResult.stdout).toContain(test_db_files_mount + "/docs");
		expect(treeResult.stdout).toContain("|-- nested/");
		expect(treeResult.stdout).toContain("|   |-- deep.md");
		expect(treeResult.stdout).toMatch(
			new RegExp(`Next page: tree ${test_db_files_mount}/docs --limit 2 --cursor \\S+`, "u"),
		);
	});

	test("tree continuation pages remind agents to stop after one requested continuation", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [
				{ path: "/tree-stop/a.md", content: "a\n" },
				{ path: "/tree-stop/b.md", content: "b\n" },
				{ path: "/tree-stop/c.md", content: "c\n" },
			],
		});

		const firstPage = await run({ command: `tree ${test_db_files_mount}/tree-stop --limit 1` });
		const continuation = firstPage.stdout.match(/Next page: (tree .+)/u)?.[1];
		if (continuation == null) {
			throw new Error("expected a tree continuation in the first page stdout");
		}

		const secondPage = await run({ command: continuation });

		expect(secondPage.metadata.exitCode).toBe(0);
		expect(secondPage.stdout).toContain("Next page: tree");
		expect(secondPage.stdout).toContain("if the user asked for exactly one continuation, stop here");
	});

	test("renders exact file tree targets without subtree pagination", async () => {
		const { run, runQuery } = await create_bash_runner();

		const result = await run({ command: `tree ${test_db_files_mount}/docs/readme.md --limit 2` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
		expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
	});

	test("keeps tree app-only option guidance out of /tmp paths", async () => {
		const { run, runQuery } = await create_bash_runner();

		const nativeJustBashResult = await run({
			command: "mkdir -p /tmp/tree-tmp && printf hi > /tmp/tree-tmp/a.md && tree -P '*.md' /tmp/tree-tmp",
		});
		const appResult = await run({ command: `tree -P '*.md' ${test_db_files_mount}/docs` });
		const nativeJustBashNextPage = await run({ command: "tree --next-page /tmp" });
		const appNextPage = await run({ command: `tree --next-page ${test_db_files_mount}/docs` });

		expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
		expect(appResult.metadata.exitCode).toBe(2);
		expect(appResult.stderr).toContain("unsupported option -P");
		expect(appResult.stderr).toContain("/home/cloud-usr/w");
		for (const result of [nativeJustBashNextPage, appNextPage]) {
			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
		}
		const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
		expect(paginatedCalls).toHaveLength(0);
	});

	test("supports exact reader commands while keeping unreadable app content out of generic readers", async () => {
		const { run } = await create_bash_runner();

		const result = await run({
			command: [
				`head -n 1 ${test_db_files_mount}/docs/readme.md`,
				`tail -n +2 ${test_db_files_mount}/docs/readme.md`,
				`wc -c ${test_db_files_mount}/docs/readme.md`,
				`stat -c "%F %n" ${test_db_files_mount}/docs/readme.md`,
			].join(" && "),
		});
		const unreadableHead = await run({ command: `head ${test_db_files_mount}/source.pdf` });
		const unreadableTail = await run({ command: `tail ${test_db_files_mount}/source.pdf` });
		const unreadableWc = await run({ command: `wc ${test_db_files_mount}/source.pdf` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("# Readme");
		expect(result.stdout).toContain("unique-token");
		expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		expect(result.stdout).toContain("regular file");
		for (const unreadable of [unreadableHead, unreadableTail, unreadableWc]) {
			expect(unreadable.metadata.exitCode).toBe(1);
			expect(unreadable.stdout).toBe("");
			expect(unreadable.stderr).toContain("Bash can read editable text files only");
			expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
		}
	});

	test("supports stat long format options and dash-leading operands after --", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const shortFormat = await run({ command: `stat -c "%F %n" ${readmePath}` });
		const longFormat = await run({ command: `stat --format "%F %n" ${readmePath}` });
		const equalsFormat = await run({ command: `stat --format=%F ${readmePath}` });
		const literalPercent = await run({ command: `stat -c "%% %F" ${readmePath}` });
		const dashLeadingTmp = await run({ command: "printf hi > /tmp/-dash-stat && stat -- /tmp/-dash-stat" });

		expect(shortFormat.metadata.exitCode).toBe(0);
		expect(longFormat.metadata.exitCode).toBe(0);
		expect(equalsFormat.metadata.exitCode).toBe(0);
		expect(literalPercent.metadata.exitCode).toBe(0);
		expect(dashLeadingTmp.metadata.exitCode).toBe(0);
		expect(longFormat.stdout).toBe(shortFormat.stdout);
		expect(equalsFormat.stdout).toBe("regular file\n");
		expect(literalPercent.stdout).toBe("% regular file\n");
		expect(dashLeadingTmp.stdout).toContain("File: /tmp/-dash-stat");
		expect(dashLeadingTmp.stdout).not.toContain("app files track");
	});

	test("warns about unsupported app stat format tokens without changing stdout", async () => {
		const { run } = await create_bash_runner();
		const readmePath = `${test_db_files_mount}/docs/readme.md`;

		const appResult = await run({ command: `stat -c "%i %b %s %%" ${readmePath}` });
		const tmpResult = await run({
			command: 'printf hi > /tmp/stat-format.txt && stat -c "%i %b %s %%" /tmp/stat-format.txt',
		});

		expect(appResult.metadata.exitCode).toBe(0);
		expect(appResult.stdout).toContain("%i %b ");
		expect(appResult.stdout).toContain(" %\n");
		expect(appResult.stderr).toContain("app files support only");
		expect(appResult.stderr).toContain("inode, blocks, device, and filesystem fields are not tracked");
		expect(tmpResult.metadata.exitCode).toBe(0);
		expect(tmpResult.stderr).not.toContain("app files support only");
	});

	test("does not recursively expand stat format tokens introduced by file names", async () => {
		const { run } = await create_bash_runner({
			extraFiles: [{ path: "/docs/%s-%F.md", content: "token name\n" }],
		});
		const tokenPath = `${test_db_files_mount}/docs/%s-%F.md`;

		const result = await run({ command: `stat -c "%n" '${tokenPath}'` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${tokenPath}\n`);
	});

	test("keeps stat glob guidance scoped to app paths", async () => {
		const { run } = await create_bash_runner();

		const tmpGlob = await run({ command: "printf hi > '/tmp/star*.txt' && stat '/tmp/star*.txt'" });
		const appGlob = await run({ command: `stat '${test_db_files_mount}/docs/*.md'` });

		expect(tmpGlob.metadata.exitCode).toBe(0);
		expect(tmpGlob.stdout).toContain("File: /tmp/star*.txt");
		expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
		expect(appGlob.metadata.exitCode).not.toBe(0);
		expect(appGlob.stderr).toContain("app file glob patterns are not supported");
		expect(appGlob.stderr).toContain("find");
	});

	test("renders app stat metadata without fake block counts", async () => {
		const { run } = await create_bash_runner();

		const result = await run({ command: `stat ${test_db_files_mount}/docs/readme.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toContain("  Size: ");
		expect(result.stdout).not.toContain("Blocks:");
		expect(result.stdout).toContain("not POSIX permissions, owner, group, inode, or blocks");
	});

	test("stat reports non-editable asset size through the shared size helper", async () => {
		const { run, runQuery } = await create_bash_runner();
		const sourcePath = `${test_db_files_mount}/source.pdf`;
		runQuery.mockClear();

		const result = await run({ command: `stat -c %s ${sourcePath}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe("4096\n");
		expect(runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toHaveLength(1);
	});

	test("stat reports unsaved edit size before the committed asset size", async () => {
		const runner = await create_bash_runner({
			extraFiles: [{ path: "/draft-stat.md", content: "tiny base\n", withRealYjsSnapshot: true }],
		});
		const draftNodeId = await get_seeded_node_id(runner, "/draft-stat.md");
		await upsert_pending_update_for_test(runner, {
			target: { kind: "saved", id: draftNodeId },
			unstagedText: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
		});
		const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			fileNodeId: draftNodeId,
		});
		if (pendingUpdate?.size == null) {
			throw new Error("expected pending update size to be set for /draft-stat.md");
		}
		const draftPath = `${test_db_files_mount}/draft-stat.md`;
		runner.runQuery.mockClear();

		const result = await runner.run({ command: `stat -c %s ${draftPath}` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${pendingUpdate.size}\n`);
		expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
	});

	test("stat reports the committed size after a pure move", async () => {
		const runner = await create_bash_runner({ extraFiles: [big_md_file] });
		const bigNode = await get_seeded_node(runner, "/big.md");
		if (bigNode.assetId == null) {
			throw new Error("expected /big.md to have a committed asset");
		}
		const asset = await runner.t.query(internal.r2.get_asset_by_id, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			assetId: bigNode.assetId,
		});
		if (asset?.size == null) {
			throw new Error("expected a committed asset size for /big.md");
		}
		expect(asset.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);

		const moved = await runner.run({
			command: `mv ${test_db_files_mount}/big.md ${test_db_files_mount}/renamed-big.md`,
		});
		expect(moved.metadata.exitCode).toBe(0);

		// The move-only pending update doc stores size 0; stat must report the committed asset size, not 0.
		const result = await runner.run({ command: `stat -c %s ${test_db_files_mount}/renamed-big.md` });

		expect(result.metadata.exitCode).toBe(0);
		expect(result.stdout).toBe(`${asset.size}\n`);
	});

	test("rejects stat format options without a value", async () => {
		const { run } = await create_bash_runner();

		const shortFormat = await run({ command: "stat -c" });
		const longFormat = await run({ command: "stat --format" });

		expect(shortFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(longFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
		expect(shortFormat.stderr).toContain("stat: -c requires a value");
		expect(longFormat.stderr).toContain("stat: --format requires a value");
		expect(shortFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
		expect(longFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
	});
});

describe("recursive reads stop at a locked folder", () => {
	const mount = "/home/cloud-usr/w/walk-team/home";

	/**
	 * The owner restricts /docs without sharing it. The member reads the rest of the workspace.
	 */
	async function seed_locked_docs(extraFiles: typeof default_organization_files = []) {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "walk-team", workspaceName: "home" }),
		);
		const owner = await create_bash_runner({
			shared: { t, seeded },
			extraFiles: [...default_organization_files, ...extraFiles],
		});
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "walk-member" });
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
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "walk-owner",
			external_id: seeded.userId,
			email: "walk-owner@test.local",
		});
		const docsId = await get_seeded_node_id(owner, "/docs");
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: seeded.membershipId, nodeId: docsId }))
				._nay,
		).toBeUndefined();
		// The scope job moves the items inside /docs into its area.
		await drain_scheduled_continuations(owner);
		const runner = await create_bash_runner({ shared: { t, seeded: { ...seeded, ...member } } });
		const share = async (path: string) => {
			const shared = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: seeded.membershipId,
				nodeId: await get_seeded_node_id(owner, path),
				principal: { kind: "user", userId: member.userId },
				level: "read",
			});
			expect(shared._nay).toBeUndefined();
			await drain_scheduled_continuations(owner);
		};
		return { t, seeded, owner, asOwner, member, runner, share };
	}

	test("ls -R prints Permission denied for a locked folder and goes on", async () => {
		const { runner } = await seed_locked_docs();

		const result = await runner.run({ command: `ls -R ${mount}` });

		expect(result.stderr).toContain(`ls: cannot open directory '${mount}/docs': Permission denied`);
		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).toContain("summary.md");
		expect(result.stdout).not.toContain("readme.md");
	});

	test("find prints Permission denied and exits 1, also with -type f", async () => {
		const { runner } = await seed_locked_docs();

		const all = await runner.run({ command: `find ${mount}` });
		expect(all.stdout).toContain(`${mount}/docs/`);
		expect(all.stdout).toContain(`${mount}/reports/summary.md`);
		expect(all.stdout).not.toContain(`${mount}/docs/readme.md`);
		expect(all.stderr).toContain(`find: '${mount}/docs': Permission denied`);
		expect(all.metadata.exitCode).toBe(1);

		// The locked folder is not a file, but its denied line still prints.
		const files = await runner.run({ command: `find ${mount} -type f` });
		expect(files.stdout).not.toContain(`${mount}/docs`);
		expect(files.stdout).toContain(`${mount}/reports/summary.md`);
		expect(files.stderr).toContain(`find: '${mount}/docs': Permission denied`);
		expect(files.metadata.exitCode).toBe(1);
	});

	test("tree marks a locked folder", async () => {
		const { runner } = await seed_locked_docs();

		const result = await runner.run({ command: `tree ${mount}` });

		expect(result.stdout).toMatch(/docs\/ {2}\[error opening dir\]/u);
		expect(result.stdout).not.toContain("readme.md");
		expect(result.stdout).toContain("summary.md");
	});

	test("find -name does not return files under a locked folder", async () => {
		const { runner } = await seed_locked_docs();

		const result = await runner.run({ command: `find ${mount} -name readme` });

		expect(result.stdout).not.toContain("readme.md");
	});

	// A guest cannot chat in this workspace, so Bash has no guest. `server/files-tree-walk.test.ts`
	// runs the same search as a guest.
	test("find -name finds a file a member reads through Add people", async () => {
		const { runner, share } = await seed_locked_docs();
		await share("/docs/nested");

		const inside = await runner.run({ command: `find ${mount}/docs/nested -name deep` });
		expect(inside.stdout).toContain(`${mount}/docs/nested/deep.md`);
		// From the root the walk stops at the locked /docs, so the search does too.
		const fromRoot = await runner.run({ command: `find ${mount} -name deep` });
		expect(fromRoot.stdout).not.toContain("deep.md");
	});

	/** Every page of `meta search --limit 1` for `topic: atlas`, as the paths of each page. */
	async function meta_pages(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
		const pages: string[][] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 20; page++) {
			const result = await runner.run({
				command: `meta search --path ${mount} --format json --limit 1 --where '{"eq":["frontmatter.topic","atlas"]}'${cursor ? ` --cursor '${cursor}'` : ""}`,
			});
			expect(result.stderr).toBe("");
			const json = JSON.parse(result.stdout) as { results: Array<{ path: string }>; nextCursor: string | null };
			pages.push(json.results.map((row) => row.path));
			cursor = json.nextCursor;
			if (cursor === null) return pages;
		}
		throw new Error("meta search did not end");
	}
	const topic = (value: string) => `---\ntopic: ${value}\n---\n`;

	test("meta search --limit 1 pages past a locked folder", async () => {
		const { runner } = await seed_locked_docs([
			{ path: "/a.md", content: topic("atlas") },
			{ path: "/docs/b.md", content: topic("atlas") },
			{ path: "/z.md", content: topic("atlas") },
		]);

		const pages = await meta_pages(runner);

		expect(pages.flat()).toEqual([`${mount}/a.md`, `${mount}/z.md`]);
		expect(pages.every((page) => page.length <= 1)).toBe(true);
	});

	test("a locked file's value does not change the pages", async () => {
		const pages_with = async (value: string) =>
			meta_pages(
				(
					await seed_locked_docs([
						{ path: "/a.md", content: topic("atlas") },
						{ path: "/docs/b.md", content: topic(value) },
						{ path: "/z.md", content: topic("atlas") },
					])
				).runner,
			);

		expect(await pages_with("atlas")).toEqual(await pages_with("other"));
	});

	test("meta search walks into a readable restricted folder", async () => {
		const { runner, share } = await seed_locked_docs([
			{ path: "/a.md", content: topic("atlas") },
			{ path: "/docs/b.md", content: topic("atlas") },
			{ path: "/docs/nested/c.md", content: topic("atlas") },
		]);
		await share("/docs");

		expect((await meta_pages(runner)).flat()).toEqual([
			`${mount}/a.md`,
			`${mount}/docs/b.md`,
			`${mount}/docs/nested/c.md`,
		]);
	});

	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;

	/** The documents each query of the next commands reads, by query name. */
	function count_reads(runner: Awaited<ReturnType<typeof create_bash_runner>>) {
		const reads: Record<string, number> = {};
		runner.runQuery.mockImplementation((ref, args) =>
			runner.t.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result: unknown = await ctx.runQuery(ref as FunctionReference<"query">, args);
				const name = function_name_of(ref) ?? "unknown";
				reads[name] =
					(reads[name] ?? 0) + (await ctx.meta.getTransactionMetrics()).documentsRead.used - before.documentsRead.used;
				return result;
			}),
		);
		return reads;
	}
	/** The documents the row streams read: the time read, or the path walk. */
	const row_reads = (reads: Record<string, number>) =>
		(reads["files_visible:internal_list_subtree_recent_saved"] ?? 0) +
		(reads["files_visible:internal_list_subtree_saved"] ?? 0);

	test("find -mmin -60 lists only files changed in the last hour", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			{ path: "/old.md", updatedAt: now - 3 * HOUR },
			{ path: "/reports/recent.md", updatedAt: now - 5 * MINUTE },
		]);

		const result = await runner.run({ command: `find ${mount} -mmin -60` });

		expect(result.stdout).toContain(`${mount}/reports/recent.md`);
		expect(result.stdout).not.toContain("old.md");
		// `-name` is checked on each recent row.
		const named = await runner.run({ command: `find ${mount} -mmin -60 -name recent` });
		expect(named.stdout).toContain(`${mount}/reports/recent.md`);
		expect(named.stdout).not.toContain("summary.md");
		// With only `+N`, a name check would scan every old row.
		const older = await runner.run({ command: `find ${mount} -mmin +60 -name old` });
		expect(older.stderr).toContain("find: -name and --content-type need a time test like -mmin -60");
	});

	test("find -mmin pages keep the same time window", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			...Array.from({ length: 12 }, (_, index) => ({ path: `/new/n-${index}.md`, updatedAt: now - MINUTE - index })),
			{ path: "/new/old.md", updatedAt: now - 3 * HOUR },
		]);

		const listed: string[] = [];
		let command = `find ${mount}/new -mmin -60 -type f --limit 5`;
		for (let page = 0; page < 10; page++) {
			const result = await runner.run({ command });
			listed.push(...result.stdout.split("\n").filter((line) => line.endsWith(".md")));
			const next = result.stdout.match(/Next page: (find .*)/u)?.[1];
			if (!next) break;
			command = next;
		}

		expect(listed).toEqual(Array.from({ length: 12 }, (_, index) => `${mount}/new/n-${index}.md`));
		// A changed command cannot reuse the cursor.
		const first = await runner.run({ command: `find ${mount}/new -mmin -60 -type f --limit 5` });
		const cursor = first.stdout.match(/--cursor (\S+)/u)![1];
		const wrong = await runner.run({ command: `find ${mount}/new -type f --limit 5 --cursor ${cursor}` });
		expect(wrong.metadata.exitCode).toBe(1);
	});

	test("find -mmin +60", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			{ path: "/old.md", updatedAt: now - 3 * HOUR },
			{ path: "/reports/recent.md", updatedAt: now - 5 * MINUTE },
		]);

		const result = await runner.run({ command: `find ${mount} -mmin +60` });

		expect(result.stdout).toContain(`${mount}/old.md`);
		expect(result.stdout).not.toContain("recent.md");
		// The seeded files changed about 16 minutes ago.
		expect(result.stdout).not.toContain("summary.md");
	});

	test("find -mtime -1, like GNU find", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			{ path: "/m4.md", updatedAt: now - 4.5 * MINUTE },
			{ path: "/h3.md", updatedAt: now - 3 * HOUR },
			{ path: "/d1.md", updatedAt: now - 36 * HOUR },
			{ path: "/d3.md", updatedAt: now - 3 * DAY },
		]);
		const names = async (test: string) =>
			(await runner.run({ command: `find ${mount} -type f ${test}` })).stdout
				.split("\n")
				.filter((line) => /\/(m4|h3|d1|d3)\.md$/u.test(line))
				.map((line) => line.slice(mount.length + 1));

		// Days are rounded down: `+1` needs two whole days.
		expect(await names("-mtime -1")).toEqual(["m4.md", "h3.md"]);
		expect(await names("-mtime 1")).toEqual(["d1.md"]);
		expect(await names("-mtime +1")).toEqual(["d3.md"]);
		// `-mmin 5` alone means 4 to 5 minutes ago.
		expect(await names("-mmin 5")).toEqual(["m4.md"]);
		expect(await names("-mmin 4")).toEqual([]);
		// Several tests must all match.
		expect(await names("-mtime -2 -mtime +0")).toEqual(["d1.md"]);
		const fraction = await runner.run({ command: `find ${mount} -mmin 1.5` });
		expect(fraction.stderr).toContain("find: -mmin needs a whole number like -60, +60 or 60");
		expect(fraction.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
	});

	test("find -mmin prints Permission denied for a locked folder", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([{ path: "/docs/secret.md", updatedAt: now - MINUTE }]);

		const result = await runner.run({ command: `find ${mount} -mmin -60` });

		expect(result.stderr).toContain(`find: '${mount}/docs': Permission denied`);
		expect(result.metadata.exitCode).toBe(1);
		expect(result.stdout).not.toContain("secret.md");
		expect(result.stdout).toContain(`${mount}/reports/summary.md`);
	});

	test("find -mmin reads only recent rows", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			...Array.from({ length: 2000 }, (_, index) => ({
				path: `/Open/old-${index}.md`,
				updatedAt: now - 3 * HOUR - index,
			})),
			...Array.from({ length: 5 }, (_, index) => ({ path: `/Open/new-${index}.md`, updatedAt: now - MINUTE })),
		]);
		const reads = count_reads(runner);

		const result = await runner.run({ command: `find ${mount} -mmin -60` });

		expect(result.stdout).toContain(`${mount}/Open/new-4.md`);
		expect(result.stdout).not.toContain("old-");
		console.info("find -mmin -60 over 2,005 rows read", JSON.stringify(reads));
		expect(row_reads(reads), "the time index skips the 2,000 old rows").toBeLessThan(100);
	}, 120_000);

	test("find -mmin +60 at the top of an area reads only old rows", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			...Array.from({ length: 2000 }, (_, index) => ({
				path: `/Open/new-${index}.md`,
				updatedAt: now - MINUTE - index,
			})),
			...Array.from({ length: 5 }, (_, index) => ({ path: `/Open/old-${index}.md`, updatedAt: now - 3 * HOUR })),
		]);
		const reads = count_reads(runner);

		const result = await runner.run({ command: `find ${mount} -mmin +60` });

		console.info("find -mmin +60 over 2,005 rows read", JSON.stringify(reads));
		expect(row_reads(reads), "the time index skips the 2,000 new rows").toBeLessThan(100);
		expect(result.stdout).toContain(`${mount}/Open/old-4.md`);
		expect(result.stdout).not.toContain("new-");
	}, 120_000);

	test("find -mmin through Add people reads no row outside the shared folder", async () => {
		const now = Date.now();
		const { runner, share } = await seed_locked_docs(
			Array.from({ length: 100 }, (_, index) => ({ path: `/docs/r-${index}.md`, updatedAt: now - MINUTE })),
		);
		await share("/docs/nested");
		const reads = count_reads(runner);

		const result = await runner.run({ command: `find ${mount}/docs/nested -mmin -60` });

		expect(result.stdout).toContain(`${mount}/docs/nested/deep.md`);
		expect(result.stdout).not.toContain("r-");
		console.info("find -mmin -60 through Add people read", JSON.stringify(reads));
		expect(row_reads(reads), "the per-folder read skips the 100 recent rows of /docs").toBeLessThan(100);
	});

	test("find -mmin groups output per restricted folder, newest first", async () => {
		const now = Date.now();
		const { runner, share } = await seed_locked_docs([
			{ path: "/a-new.md", updatedAt: now - MINUTE },
			{ path: "/z-old.md", updatedAt: now - 10 * MINUTE },
			{ path: "/docs/b-mid.md", updatedAt: now - 5 * MINUTE },
			{ path: "/docs/c-newest.md", updatedAt: now - 0.5 * MINUTE },
		]);
		await share("/docs");

		const result = await runner.run({ command: `find ${mount} -mmin -15` });

		expect(result.stdout.split("\n").filter((line) => line.endsWith(".md"))).toEqual([
			`${mount}/a-new.md`,
			`${mount}/z-old.md`,
			`${mount}/docs/c-newest.md`,
			`${mount}/docs/b-mid.md`,
		]);
	});

	test("find -mmin +60 under a folder in the middle of an area", async () => {
		const now = Date.now();
		const { runner } = await seed_locked_docs([
			{ path: "/old-root.md", updatedAt: now - 3 * HOUR },
			{ path: "/reports/old.md", updatedAt: now - 3 * HOUR },
			{ path: "/reports/new.md", updatedAt: now - 5 * MINUTE },
		]);

		const result = await runner.run({ command: `find ${mount}/reports -mmin +60` });

		expect(result.stdout).toContain(`${mount}/reports/old.md`);
		expect(result.stdout).not.toContain("new.md");
		expect(result.stdout).not.toContain("old-root.md");
	});

	test("find -mmin --content-type leaves out a locked file", async () => {
		const { runner, owner, asOwner, seeded } = await seed_locked_docs();
		expect(
			(
				await asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: seeded.membershipId,
					nodeId: await get_seeded_node_id(owner, "/reports/summary.md"),
				})
			)._nay,
		).toBeUndefined();
		await drain_scheduled_continuations(owner);

		const all = await runner.run({ command: `find ${mount} -mmin -60` });
		expect(all.stdout, "the locked file shows by name").toContain(`${mount}/reports/summary.md`);
		const typed = await runner.run({ command: `find ${mount} -mmin -60 --content-type text/` });
		expect(typed.stdout, "a type search does not match a locked file").not.toContain("summary.md");
	});

	test("find -mmin does not show another user's drafts", async () => {
		const { runner, owner } = await seed_locked_docs();
		expect(
			(await owner.run({ command: `echo hi > ${test_db_files_mount}/reports/owner-draft.md` })).metadata.exitCode,
		).toBe(0);
		expect((await owner.run({ command: `find ${test_db_files_mount} -mmin -5` })).stdout).toContain("owner-draft.md");

		const result = await runner.run({ command: `find ${mount} -mmin -5` });

		expect(result.stdout).not.toContain("owner-draft.md");
	});

	test("find -mmin with tests that cannot all match reads nothing", async () => {
		const runner = await create_bash_runner();
		const reads = count_reads(runner);

		const result = await runner.run({ command: `find ${test_db_files_mount} -mmin -10 -mmin +20` });

		expect(reads["files_visible:internal_get_move_view"], "no listing runs").toBeUndefined();
		expect(result.stdout).toBe("0 matches.\n");
	});

	test("find -mmin shows the agent's recent drafts", async () => {
		const runner = await create_bash_runner();
		expect((await runner.run({ command: `echo hi > ${test_db_files_mount}/reports/draft.md` })).metadata.exitCode).toBe(
			0,
		);

		const all = await runner.run({ command: `find ${test_db_files_mount} -mmin -5` });
		expect(all.stdout).toContain(`${test_db_files_mount}/reports/draft.md`);
		// The seeded files changed about 16 minutes ago.
		expect(all.stdout).not.toContain("summary.md");
		const docs = await runner.run({ command: `find ${test_db_files_mount}/docs -mmin -5` });
		expect(docs.stdout).not.toContain("draft.md");
	});

	test("find -mmin after a Move does not list the moved file as recent", async () => {
		const runner = await create_bash_runner({ extraFiles: [{ path: "/old.md", updatedAt: Date.now() - 3 * HOUR }] });
		const oldId = await get_seeded_node_id(runner, "/old.md");
		expect(
			(await runner.run({ command: `mv ${test_db_files_mount}/old.md ${test_db_files_mount}/reports/old.md` })).metadata
				.exitCode,
		).toBe(0);
		await accept_pending_move_group_for_test(runner, [oldId]);

		const recent = await runner.run({ command: `find ${test_db_files_mount} -mmin -60` });
		expect(recent.stdout).not.toContain("old.md");
		const older = await runner.run({ command: `find ${test_db_files_mount} -mmin +60` });
		expect(older.stdout).toContain(`${test_db_files_mount}/reports/old.md`);
	});
});
