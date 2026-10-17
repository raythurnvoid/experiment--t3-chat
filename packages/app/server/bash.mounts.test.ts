// The shells and mount tests, split from bash.test.ts so the files can run at the same time.
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { bash_ReviewScratch } from "../convex/bash.ts";
import { files_nodes_db_create_node_recursively_at_path } from "../convex/files_nodes_create_db.ts";
import { files_nodes_db_insert_file_content_docs } from "../convex/files_nodes_content.ts";
import { r2 } from "../convex/r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_ROOT_ID, files_guess_content_type_from_name } from "../shared/files.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { bash_run_job } from "./bash.ts";
import { bash_cursor_id_create } from "./bash-utils.ts";
import {
	test_db_files_mount,
	function_name_of,
	test_r2_objects,
	create_bash_runner,
	get_shell,
	get_seeded_node_id,
	job_row,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	describe("shells", () => {
		const transcript_of = async (runner: Awaited<ReturnType<typeof create_bash_runner>>, name: string) => {
			const shell = await get_shell({ t: runner.t, threadId: runner.threadId, name });
			if (!shell) throw new Error(`Expected shell ${name}`);
			const entries = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shell_transcripts")
					.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
					.collect(),
			);
			return { shell, entries };
		};

		const transcript_reads = (runner: Awaited<ReturnType<typeof create_bash_runner>>) =>
			runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:read_shell_transcript")
				.length;

		test("creates a named shell and runs the command in one call", async () => {
			const runner = await create_bash_runner();
			const result = await runner.run({ command: "pwd", toolCallId: undefined, shellName: "work" });
			expect(result.metadata.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe(`${test_db_files_mount}\n`);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells.map((shell) => shell.name)).toEqual(["work"]);
		});

		test("refuses the 11th shell and names the existing ones", async () => {
			const runner = await create_bash_runner();
			for (let i = 0; i < 10; i++) {
				expect(
					(await runner.run({ command: "true", toolCallId: undefined, shellName: `s${i}` })).metadata.exitCode,
				).toBe(0);
			}
			await expect(runner.run({ command: "true", toolCallId: undefined, shellName: "s10" })).rejects.toThrow(
				"This thread already has 10 shells (s0, s1, s2, s3, s4, s5, s6, s7, s8, s9). Reuse one of them.",
			);
			const shells = await runner.t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", runner.threadId))
					.collect(),
			);
			expect(shells).toHaveLength(10);
		});

		test("keeps a variable for the next call in the same shell only", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=5" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x" })).stdout).toBe("5\n");
			expect((await runner.run({ command: "echo $x", toolCallId: undefined, shellName: "other" })).stdout).toBe("\n");
		});

		test("keeps the saved state when the call leaves cwd inside /tmp", async () => {
			const runner = await create_bash_runner();

			// /tmp is per-thread scratch with its own caps, so a cwd left there is the case most
			// likely to lose the rest of the shell state on the way back.
			expect(
				(await runner.run({ command: "kept=yes; fruits=(apple pear); mkdir -p /tmp/scratch-cwd; cd /tmp/scratch-cwd" }))
					.metadata.exitCode,
			).toBe(0);

			const read = await runner.run({ command: 'printf "%s|%s|%s\\n" "$kept" "${#fruits[@]}" "$(pwd)"' });
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("yes|2|/tmp/scratch-cwd\n");
		});

		test("keeps an indexed and an associative array for the next call", async () => {
			const runner = await create_bash_runner();

			// Arrays live outside env in the engine state, so they need their own place in the saved
			// snapshot. Without it a later call sees the names as unset.
			expect(
				(await runner.run({ command: "fruits=(apple pear plum); declare -A ages; ages[ana]=31" })).metadata.exitCode,
			).toBe(0);

			const read = await runner.run({ command: 'printf "%s|%s|%s\\n" "${fruits[1]}" "${#fruits[@]}" "${ages[ana]}"' });
			expect(read.stderr).toBe("");
			expect(read.stdout).toBe("pear|3|31\n");

			// A different shell in the same thread starts without them.
			expect(
				(await runner.run({ command: 'printf "%s\\n" "${#fruits[@]}"', toolCallId: undefined, shellName: "other" }))
					.stdout,
			).toBe("0\n");
		});

		test("still saves the variable when the call ends with exit 0", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=5; exit 0" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x" })).stdout).toBe("5\n");
		});

		test("keeps a function for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "hi() { echo hi from $1; }" })).metadata.exitCode).toBe(0);
			const called = await runner.run({ command: "hi later" });
			expect(called.metadata.exitCode, called.stderr).toBe(0);
			expect(called.stdout).toBe("hi from later\n");
		});

		test("keeps set -e for the next call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "set -e" })).metadata.exitCode).toBe(0);
			const stopped = await runner.run({ command: "false; echo after" });
			expect(stopped.metadata.exitCode).toBe(1);
			expect(stopped.stdout).toBe("");
		});

		test("an Ask-mode call still saves the snapshot into the shared shell", async () => {
			const runner = await create_bash_runner({ allowDbFilesMkdir: false });
			expect((await runner.run({ command: "x=5; f() { echo fn; }" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo $x; f" })).stdout).toBe("5\nfn\n");
		});

		test("cd in one shell does not move another", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "cd docs", toolCallId: undefined, shellName: "a" })).metadata.nextCwd).toBe(
				`${test_db_files_mount}/docs`,
			);
			expect((await runner.run({ command: "pwd", toolCallId: undefined, shellName: "b" })).stdout).toBe(
				`${test_db_files_mount}\n`,
			);
			expect((await runner.run({ command: "pwd", toolCallId: undefined, shellName: "a" })).stdout).toBe(
				`${test_db_files_mount}/docs\n`,
			);
		});

		test("warns about a file descriptor left open and does not restore it", async () => {
			const runner = await create_bash_runner();
			const opened = await runner.run({ command: "exec 3>/tmp/fd.txt; echo hi" });
			expect(opened.metadata.exitCode).toBe(0);
			expect(opened.stderr).toContain("bash: file descriptor 3 was closed\n");
			const reused = await runner.run({ command: "echo again >&3" });
			expect(reused.metadata.exitCode).not.toBe(0);
			expect(reused.stderr).toMatch(/bad file descriptor/i);
		});

		test("does not save a snapshot over 128 KiB and keeps the previous state", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "x=1" })).metadata.exitCode).toBe(0);
			const grown = await runner.run({ command: "big=a; for i in $(seq 18); do big=$big$big; done; echo ${#big}" });
			expect(grown.metadata.exitCode, grown.stderr).toBe(0);
			expect(grown.stdout).toBe("262144\n");
			expect(grown.stderr).toContain(
				"bash: the shell state is larger than 128 KiB and was not saved; the previous state stays.\n",
			);
			expect((await runner.run({ command: "echo ${#big} $x" })).stdout).toBe("0 1\n");
		});

		test("appends one transcript entry per call, in order, with the header", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo one" });
			await runner.run({ command: "cd docs; echo two; echo err >&2" });
			const { shell, entries } = await transcript_of(runner, "default");
			expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
			expect(entries[0]!.text).toMatch(
				new RegExp(`^\\$ \\[\\d{4}-\\d\\d-\\d\\dT[^\\]]+Z\\] \\(exit 0\\) ${test_db_files_mount}\necho one\none\n\n$`),
			);
			expect(entries[1]!.text).toMatch(
				new RegExp(
					`^\\$ \\[[^\\]]+\\] \\(exit 0\\) ${test_db_files_mount}\ncd docs; echo two; echo err >&2\ntwo\n\nerr\n$`,
				),
			);
			expect(shell).toMatchObject({
				transcriptEntries: 2,
				transcriptSeq: 2,
				transcriptBytes: entries[0]!.bytes + entries[1]!.bytes,
			});
		});

		test("output with half a character reaches the result and the transcript as U+FFFD", async () => {
			const runner = await create_bash_runner();
			// A character outside the basic range is two code units, and `printf` can write one of them
			// on its own. Convex refuses a mutation argument that holds such a string, so the whole call
			// used to fail with "Invalid arguments provided" and the model saw no output at all.
			const result = await runner.run({ command: `printf 'A\\ud83cB'` });
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("A�B");
			const { entries } = await transcript_of(runner, "default");
			expect(entries[0]!.text).toContain("A�B");
			expect(entries[0]!.text.isWellFormed()).toBe(true);
		});

		test("mounts the transcripts read-only under /shells and reads one only when asked", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "echo hi", toolCallId: undefined, shellName: "a" })).metadata.exitCode).toBe(
				0,
			);
			const listed = await runner.run({ command: "ls /shells", toolCallId: undefined, shellName: "b" });
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(listed.stdout).toBe("a\nb\n");
			expect(transcript_reads(runner)).toBe(0);

			const detailed = await runner.run({ command: "ls -l /shells/a", toolCallId: undefined, shellName: "b" });
			expect(detailed.metadata.exitCode, detailed.stderr).toBe(0);
			expect(detailed.stdout).toContain("transcript");
			expect(transcript_reads(runner)).toBe(1);

			const read = await runner.run({ command: "cat /shells/a/transcript", toolCallId: undefined, shellName: "b" });
			expect(read.metadata.exitCode, read.stderr).toBe(0);
			expect(read.stdout).toContain("echo hi\nhi\n");
			expect(transcript_reads(runner)).toBe(2);

			const written = await runner.run({
				command: "echo x > /shells/a/transcript",
				toolCallId: undefined,
				shellName: "b",
			});
			expect(written.metadata.exitCode).not.toBe(0);
			expect(written.stderr).toMatch(/read-only/i);
			expect(
				(await runner.run({ command: "rm /shells/a/transcript", toolCallId: undefined, shellName: "b" })).metadata
					.exitCode,
			).not.toBe(0);
			expect((await transcript_of(runner, "a")).entries).toHaveLength(1);
		});

		test("persists cd /shells/<name>", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "true", toolCallId: undefined, shellName: "a" })).metadata.exitCode).toBe(0);
			const entered = await runner.run({ command: "cd /shells/a" });
			expect(entered.metadata.exitCode, entered.stderr).toBe(0);
			expect(entered.metadata.nextCwd).toBe("/shells/a");
			expect(entered.stderr).toBe("");
			expect((await runner.run({ command: "pwd" })).stdout).toBe("/shells/a\n");
		});

		test("a replayed call with another shell is refused, and a job: id never reaches the lookup", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "pwd", toolCallId: "same-call", shellName: "a" })).metadata.exitCode).toBe(0);
			await expect(runner.run({ command: "pwd", toolCallId: "same-call", shellName: "b" })).rejects.toThrow(
				"This Bash call already has a different command.",
			);
			await expect(runner.run({ command: "pwd", toolCallId: "job:x:1" })).rejects.toThrow(
				"Invalid Bash call identity.",
			);
		});
	});

	describe("plugin volume mounts", () => {
		const VOLUME_TEXT = "# unfinished [markdown\nMountneedle marker.\nUnicode: café 🐒\nLast line\n";
		const VOLUME_PATH = "/.mounts/research/repo/notes.md";

		async function seed_generation(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			installationId: Id<"plugins_workspace_installations">;
			volumeId: Id<"plugins_volumes">;
			files: { path: string; text: string }[];
			opts?: { status?: "published" | "staging"; revision?: string; chunks?: boolean };
		}) {
			const { runner, volumeId, files, opts = {}, installationId } = args;

			return await runner.t.run(async (ctx) => {
				const now = Date.now();
				const tenant = { organizationId: runner.seeded.organizationId, workspaceId: runner.seeded.workspaceId };
				const generationId = await ctx.db.insert("plugins_volume_generations", {
					...tenant,
					installationId,
					volumeId,
					status: opts.status ?? "published",
					revision: opts.revision ?? "copy-1",
					fileCount: files.length,
					bytes: files.reduce((sum, file) => sum + new TextEncoder().encode(file.text).byteLength, 0),
					createdAt: now,
					lastWriteAt: now,
					publishedAt: opts.status === "staging" ? null : now,
					expiresAt: null,
					drainScheduledUntil: null,
				});
				const scope = { organizationId: tenant.organizationId, workspaceId: volumeId };
				const nodes: { nodeId: Id<"files_nodes">; assetId: Id<"files_r2_assets">; r2Key: string }[] = [];
				// This is the trusted SYSTEM materialization path. Reads use the real Bash doors below.
				for (const file of files) {
					const path = `/${generationId}${file.path}`;
					const contentType = files_guess_content_type_from_name(file.path);
					const bytes = new TextEncoder().encode(file.text);
					const assetId = await ctx.db.insert("files_r2_assets", {
						...scope,
						kind: "content",
						r2Bucket: r2.config.bucket,
						size: bytes.byteLength,
						createdBy: users_SYSTEM_AUTHOR,
						updatedAt: now,
					});
					const r2Key = `bash-volume/${assetId}`;
					await ctx.db.patch("files_r2_assets", assetId, { r2Key });
					test_r2_objects.set(r2Key, bytes);
					const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
						...scope,
						userId: users_SYSTEM_AUTHOR,
						parentId: files_ROOT_ID,
						path,
						kind: "file",
						contentType,
						assetId,
						expectsTextContent: true,
						now,
					});
					if (created._nay) throw new Error(created._nay.message);
					const nodeId = created._yay;
					await ctx.db.patch("files_nodes", nodeId, { contentByteSize: bytes.byteLength });
					if (opts.chunks !== false)
						await files_nodes_db_insert_file_content_docs(ctx, {
							...scope,
							nodeId,
							path,
							contentType,
							rootKind: "plain_text",
							textContent: file.text,
							readOnly: true,
							userId: users_SYSTEM_AUTHOR,
							now,
						});
					nodes.push({ nodeId, assetId, r2Key });
				}
				return { generationId, nodes };
			});
		}

		async function create_volume_runner(opts: { reader?: boolean; large?: boolean; chunks?: boolean } = {}) {
			const t = test_convex();
			const owner = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "mount-team", workspaceName: "home" }),
			);
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
			let seeded = owner;
			if (opts.reader) {
				const reader = await t.run((ctx) =>
					test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
				);
				expect(
					await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: owner.organizationId,
						workspaceId: owner.workspaceId,
						userIdToAdd: reader.userId,
					}),
				).toEqual({ _yay: null });
				const membership = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", owner.workspaceId).eq("userId", reader.userId).eq("active", true),
						)
						.unique(),
				);
				if (!membership) throw new Error("Expected reader membership");
				seeded = { ...owner, userId: reader.userId, membershipId: membership._id };
			}
			const runner = await create_bash_runner({ shared: { t, seeded } });
			const capabilities = ["workspace.volumes.write", "plugin.backend.invoke"] as const;
			const pluginVersionId = await t.run((ctx) =>
				ctx.db.insert("plugins_versions", {
					name: "research",
					displayName: "Research",
					version: "0.1.0",
					description: "External records",
					reviewStatus: "passed",
					reviewId: null,
					isLatest: true,
					artifactHash: `sha256:${"a".repeat(64)}`,
					sourceRepositoryUrl: "https://github.com/example/research",
					sourceOwner: "example",
					sourceRepo: "research",
					sourceCommitSha: "a".repeat(40),
					manifestR2Key: "research/manifest.json",
					backendEntrypointFile: {
						entry: "backend.js",
						moduleName: "backend",
						r2Key: "research/backend.js",
						sha256: "a".repeat(64),
						compatibilityDate: "2026-01-01",
						compatibilityFlags: [],
					},
					configuration: { description: "Mount name", defaultYaml: "mount:\n  name: research\n" },
					mounts: [{ id: "sources", description: "External records", configurationPath: ["mount", "name"] }],
					events: [],
					capabilities: [...capabilities],
					endpoints: [{ id: "refresh", path: "/refresh", serialization: "installation" }],
					pages: [],
					fileViews: [],
					outboundOrigins: [],
					uiOutboundOrigins: [],
					mcpServers: [],
					mcpServersFingerprint: "research-mcp",
					skills: [],
					files: [],
					sourceStatus: "ready",
					sourceLastError: null,
					createdBy: owner.userId,
					updatedAt: Date.now(),
					secrets: [],
					userWritableCollections: null,
				}),
			);
			const installed = await asOwner.mutation(api.plugins.install_version, {
				membershipId: owner.membershipId,
				pluginVersionId,
				acceptedCapabilities: [...capabilities],
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				acceptedMcpServersFingerprint: "research-mcp",
				acceptedSkillNames: [],
			});
			if (installed._nay) throw new Error(installed._nay.message);
			const installationId = installed._yay.installationId;
			const claim = await t.run((ctx) =>
				ctx.db
					.query("plugins_mounts")
					.withIndex("by_organization_workspace_installation", (q) =>
						q
							.eq("organizationId", owner.organizationId)
							.eq("workspaceId", owner.workspaceId)
							.eq("installationId", installationId),
					)
					.unique(),
			);
			if (!claim) throw new Error("Expected mount claim");
			const volumeId = await t.run((ctx) =>
				ctx.db.insert("plugins_volumes", {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					installationId,
					mountId: "sources",
					volumeKey: "repo",
					publishedGenerationId: null,
					createdAt: Date.now(),
					deleteRequestedAt: null,
					drainScheduledUntil: null,
				}),
			);
			const text = opts.large ? `${"Mountneedle line\n".repeat(6000)}END\n` : VOLUME_TEXT;
			const copy = await seed_generation({
				runner,
				installationId,
				volumeId,
				files: [
					{ path: "/notes.md", text },
					{ path: "/guide.md", text: "Mountneedle guide\n" },
					{ path: "/records/sample/item-1.json", text: '{"name":"Mountneedle"}\n' },
				],
				opts: { chunks: opts.chunks },
			});
			await t.run((ctx) => ctx.db.patch("plugins_volumes", volumeId, { publishedGenerationId: copy.generationId }));
			return { runner, owner, asOwner, installationId, claimId: claim._id, volumeId, ...copy, text };
		}

		async function seed_legacy_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			name: string;
			synced?: boolean;
		}) {
			const { runner, name, synced = true } = args;

			const inserted = await runner.t.mutation(internal.github_mounts.upsert_mount, {
				name,
				owner: "example",
				repo: "legacy",
				ref: "main",
			});
			if (inserted._nay) throw new Error(inserted._nay.message);
			if (synced) {
				const sha = "a".repeat(40);
				await runner.t.run((ctx) => ctx.db.patch("github_mounts", inserted._yay.mountId, { lastCommitSha: sha }));
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					path: `/${name}/${sha}/old.md`,
					rawText: "Mountneedle legacy\n",
				});
				if (created._nay) throw new Error(created._nay.message);
			}
			return inserted._yay.mountId;
		}

		test("reads published copies through every reader and forwards the original source", async () => {
			const f = await create_volume_runner();
			for (const [command, text] of [
				[`cat ${VOLUME_PATH}`, VOLUME_TEXT],
				[`head -n 1 ${VOLUME_PATH}`, "# unfinished [markdown\n"],
				[`tail -n 1 ${VOLUME_PATH}`, "Last line\n"],
				[`sed -n '2p' ${VOLUME_PATH}`, "Mountneedle marker.\n"],
				[`grep Mountneedle ${VOLUME_PATH}`, "Mountneedle marker.\n"],
				[`wc -l ${VOLUME_PATH}`, "4"],
				[`textgrep Mountneedle ${VOLUME_PATH}`, "Mountneedle"],
				[`stat -c %s ${VOLUME_PATH}`, String(new TextEncoder().encode(VOLUME_TEXT).byteLength)],
				[`file -b --mime-type ${VOLUME_PATH}`, "text/markdown\n"],
				["cat /.mounts/research/repo/records/sample/item-1.json", '{"name":"Mountneedle"}\n'],
			] as const) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
				expect(result.stdout, command).toContain(text);
			}
			for (const command of [
				"ls /.mounts/research/repo",
				"tree /.mounts/research/repo --limit 20",
				"find /.mounts/research/repo --limit 20",
				"search --path /.mounts/research/repo Mountneedle",
				`meta get ${VOLUME_PATH}`,
			]) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
			}
			const volumeReads = [...f.runner.runQuery.mock.calls, ...f.runner.runAction.mock.calls].filter(
				([ref, args]) => args.workspaceId === f.volumeId && function_name_of(ref)?.startsWith("files_"),
			);
			expect(volumeReads.length).toBeGreaterThan(8);
			for (const [, args] of volumeReads)
				expect(args.agentSource).toEqual({
					organizationId: f.runner.ctxData.organizationId,
					workspaceId: f.runner.ctxData.workspaceId,
					userId: f.runner.ctxData.userId,
					threadId: f.runner.ctxData.threadId,
					membershipId: f.runner.ctxData.membershipId,
					membershipLifetime: f.runner.ctxData.membershipLifetime,
					run: f.runner.chatRun,
				});
			expect((await f.runner.run({ command: `resolve ${f.nodes[0].nodeId}` })).metadata.exitCode).not.toBe(0);
		});

		test.each([
			`printf changed > ${VOLUME_PATH}`,
			`printf changed >> ${VOLUME_PATH}`,
			`printf changed | tee ${VOLUME_PATH}`,
			`touch ${VOLUME_PATH}`,
			`rm ${VOLUME_PATH}`,
			`mv ${VOLUME_PATH} /tmp/moved.md`,
			`cp /tmp/new.md ${VOLUME_PATH}`,
			"mkdir /.mounts/research/repo/new-folder",
			"mkdir -p /.mounts/research/repo/records",
			`chmod 777 ${VOLUME_PATH}`,
			`ln -s ${VOLUME_PATH} /.mounts/research/repo/link`,
			"mkdir /.mounts/research/new-leaf",
			"printf changed > /.mounts/research/new-leaf",
			"rm -r /.mounts/research",
		])("refuses writes through %s", async (command) => {
			const f = await create_volume_runner();
			await f.runner.run({ command: "printf new > /tmp/new.md" });
			const result = await f.runner.run({ command });
			expect(result.metadata.exitCode, command).not.toBe(0);
			expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe(VOLUME_TEXT);
			expect(await f.runner.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		});

		test("copies data to scratch and never executes mounted code", async () => {
			const f = await create_volume_runner();
			expect((await f.runner.run({ command: `cp ${VOLUME_PATH} /tmp/notes.md && cat /tmp/notes.md` })).stdout).toBe(
				VOLUME_TEXT,
			);
			for (const command of [`bash ${VOLUME_PATH}`, `source ${VOLUME_PATH}`, `eval "$(cat ${VOLUME_PATH})"`])
				expect((await f.runner.run({ command })).metadata.exitCode).not.toBe(0);
		});

		test("reads large published text through bounded reader modes", async () => {
			const f = await create_volume_runner({ large: true });
			for (const command of [
				`cat ${VOLUME_PATH}`,
				`head -n 1 ${VOLUME_PATH}`,
				`tail -n 1 ${VOLUME_PATH}`,
				`sed -n '2p' ${VOLUME_PATH}`,
				`wc -l ${VOLUME_PATH}`,
				`grep -c Mountneedle ${VOLUME_PATH}`,
				`textgrep -c Mountneedle ${VOLUME_PATH}`,
			]) {
				const result = await f.runner.run({ command });
				expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
				expect(result.stdout.length, command).toBeGreaterThan(0);
				expect(result.stdout.length, command).toBeLessThan(20_000);
			}
		});

		test.each([
			`cat ${VOLUME_PATH}`,
			`head -n 1 ${VOLUME_PATH}`,
			`tail -n 1 ${VOLUME_PATH}`,
			`wc ${VOLUME_PATH}`,
			`sed -n '2p' ${VOLUME_PATH}`,
			`grep Mountneedle ${VOLUME_PATH}`,
			`textgrep Mountneedle ${VOLUME_PATH}`,
			`stat ${VOLUME_PATH}`,
			`file ${VOLUME_PATH}`,
			`meta get ${VOLUME_PATH}`,
			"ls /.mounts/research/repo",
			"tree /.mounts/research/repo",
			"find /.mounts/research/repo",
			"search --path /.mounts/research/repo Mountneedle",
		])("refuses pinned readers after installation disable: %s", async (command) => {
			const f = await create_volume_runner();
			const baseQuery = f.runner.runQuery.getMockImplementation()!;
			let disabled = false;
			f.runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await baseQuery(ref, args);
				if (!disabled && function_name_of(ref) === "plugins:list_bash_volume_mounts") {
					disabled = true;
					await f.runner.t.run((ctx) =>
						ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }),
					);
				}
				return result;
			});
			const result = await f.runner.run({ command });
			expect(disabled).toBe(true);
			expect(result.stdout, command).not.toContain("Mountneedle");
			expect(result.stdout, command).not.toContain("notes.md");
			expect(result.metadata.exitCode, command).not.toBe(0);
		});

		test("lists mixed trees with correct root and group depths", async () => {
			const f = await create_volume_runner();
			await seed_legacy_mount({ runner: f.runner, name: "legacy" });
			expect((await f.runner.run({ command: "ls /.mounts" })).stdout).toBe("legacy\nresearch\n");
			expect((await f.runner.run({ command: "ls /.mounts/research" })).stdout).toBe("repo\n");
			const mixedListing = await f.runner.run({ command: "ls /tmp /.mounts/research --limit 1" });
			expect(mixedListing.metadata.exitCode, mixedListing.stderr).toBe(0);
			expect(mixedListing.stdout).toContain("repo");
			const rootOne = await f.runner.run({ command: "find /.mounts -maxdepth 1 --limit 20" });
			expect(rootOne.stdout).toContain("/.mounts/legacy/");
			expect(rootOne.stdout).toContain("/.mounts/research/");
			expect(rootOne.stdout).not.toContain("repo");
			const rootTwo = await f.runner.run({ command: "find /.mounts -maxdepth 2 --limit 20" });
			expect(rootTwo.stdout).toContain("/.mounts/legacy/old.md");
			expect(rootTwo.stdout).toContain("/.mounts/research/repo/");
			expect(rootTwo.stdout).not.toContain("notes.md");
			const groupOne = await f.runner.run({ command: "find /.mounts/research -maxdepth 1 --limit 20" });
			expect(groupOne.stdout).toContain("/.mounts/research/repo/");
			expect(groupOne.stdout).not.toContain("notes.md");
			// A mount reads its root, its root and children, or its whole subtree; deeper limits are refused.
			const groupTwo = await f.runner.run({ command: "find /.mounts/research -maxdepth 2 --limit 20" });
			expect(groupTwo.stdout).toContain("/.mounts/research/repo/notes.md");
			expect(groupTwo.stdout).toContain("/.mounts/research/repo/records/");
			expect(groupTwo.stdout).not.toContain("sample");
			const groupThree = await f.runner.run({ command: "find /.mounts/research -maxdepth 3 --limit 20" });
			expect(groupThree.metadata.exitCode).toBe(2);
			expect(groupThree.stderr).toContain("its direct children (-maxdepth 2), or the whole subtree");
			const folders = await f.runner.run({ command: "find /.mounts -type d --limit 20" });
			expect(folders.stdout).toContain("/.mounts/research/");
			expect(folders.stdout).toContain("/.mounts/research/repo/records/sample/");
			for (const base of ["/.mounts", "/.mounts/research"]) {
				for (const command of [
					`ls -R ${base} --limit 20`,
					`tree ${base} --limit 20`,
					`find ${base} -type f --limit 20`,
					`search --path ${base} Mountneedle`,
				]) {
					const result = await f.runner.run({ command });
					expect(result.metadata.exitCode, `${command}: ${result.stderr}`).toBe(0);
					expect(result.stdout, command).toContain("notes.md");
					if (base !== "/.mounts") expect(result.stdout, command).not.toContain("legacy");
				}
			}
			expect(
				(await f.runner.run({ command: "meta search --path /.mounts/research name=Mountneedle" })).metadata.exitCode,
			).not.toBe(0);
			expect((await f.runner.run({ command: "grep -R Mountneedle /.mounts/research" })).stdout).toContain(
				"search --path /.mounts/research",
			);
			expect((await f.runner.run({ command: "textgrep -R Mountneedle /.mounts/research" })).stderr).toContain(
				"search --path /.mounts/research",
			);
		});

		test.each([false, true])("skips a whole plugin group after a later legacy claim (synced %s)", async (synced) => {
			const f = await create_volume_runner();
			await seed_legacy_mount({ runner: f.runner, name: "research", synced });
			const result = await f.runner.run({ command: `cat ${VOLUME_PATH}` });
			expect(result.stdout, "collision must hide the plugin copy").toBe("");
			expect(result.metadata.exitCode).not.toBe(0);
			for (const command of [
				"find /.mounts --limit 20",
				"tree /.mounts --limit 20",
				"search --path /.mounts Mountneedle",
			]) {
				const listed = await f.runner.run({ command });
				expect(listed.stdout).not.toContain("repo");
				expect(listed.stdout).not.toContain("notes.md");
			}
		});

		test("hides staging copies and unpublished leaves", async () => {
			const f = await create_volume_runner();
			await seed_generation({
				runner: f.runner,
				installationId: f.installationId,
				volumeId: f.volumeId,
				files: [{ path: "/staging.md", text: "Stagingneedle\n" }],
				opts: { status: "staging", revision: "copy-2" },
			});
			expect((await f.runner.run({ command: "find /.mounts --limit 20" })).stdout).not.toContain("staging.md");
			expect((await f.runner.run({ command: "search --path /.mounts Stagingneedle" })).stdout).toContain(
				"No content matches",
			);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: null }));
			expect((await f.runner.run({ command: "ls /.mounts/research" })).metadata.exitCode).not.toBe(0);
		});

		test.each(["find", "ls -R", "tree", "search"] as const)(
			"keeps %s cursors scoped to a root or group and rejects changed copies",
			async (command) => {
				const f = await create_volume_runner();
				const build = (base: string) =>
					command === "search" ? `search --path ${base} Mountneedle --limit 1` : `${command} ${base} --limit 1`;
				const rootPage = await f.runner.run({ command: build("/.mounts") });
				const rootNext = rootPage.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
				expect(rootNext, rootPage.stdout).toBeTruthy();
				const wrongGroup = await f.runner.run({ command: rootNext!.replace("/.mounts", "/.mounts/research") });
				expect(wrongGroup.metadata.exitCode).not.toBe(0);
				expect(wrongGroup.stderr).toContain("does not belong");
				const groupPage = await f.runner.run({ command: build("/.mounts/research") });
				const groupNext = groupPage.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
				expect(groupNext, groupPage.stdout).toBeTruthy();
				expect((await f.runner.run({ command: groupNext! })).metadata.exitCode).toBe(0);
				const next = await seed_generation({
					runner: f.runner,
					installationId: f.installationId,
					volumeId: f.volumeId,
					files: [{ path: "/notes.md", text: "Mountneedle replacement\n" }],
					opts: { revision: "copy-2" },
				});
				await f.runner.t.run((ctx) =>
					ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: next.generationId }),
				);
				const changed = await f.runner.run({ command: groupNext! });
				expect(changed.metadata.exitCode).not.toBe(0);
				expect(changed.stderr).toContain("listing changed");
			},
		);

		test("rejects renamed root cursors and climbs cwd after rename or deletion", async () => {
			const f = await create_volume_runner();
			const page = await f.runner.run({ command: "find /.mounts --limit 1" });
			const next = page.stdout.split("Next page: ")[1]?.split("\n")[0].trim();
			expect(next).toBeTruthy();
			expect((await f.runner.run({ command: "cd /.mounts/research/repo/records/sample" })).metadata.exitCode).toBe(0);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_mounts", f.claimId, { name: "renamed" }));
			expect((await f.runner.run({ command: "pwd" })).stdout).toBe("/.mounts\n");
			expect((await f.runner.run({ command: next! })).stderr).toContain("listing changed");
			expect((await f.runner.run({ command: "cd /.mounts/renamed/repo/records/sample" })).metadata.exitCode).toBe(0);
			await f.runner.t.run((ctx) => ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() }));
			expect((await f.runner.run({ command: "pwd" })).stdout).toBe("/\n");
		});

		test.each(["disabled", "uninstalled", "purging", "deleting", "foreign workspace"] as const)(
			"refuses a volume after %s",
			async (state) => {
				const f = await create_volume_runner();
				expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe(VOLUME_TEXT);
				await f.runner.t.run(async (ctx) => {
					if (state === "disabled")
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
					else if (state === "uninstalled") await ctx.db.delete("plugins_workspace_installations", f.installationId);
					else if (state === "purging")
						await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, {
							pluginDataPurgeStartedAt: Date.now(),
						});
					else if (state === "deleting")
						await ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now() });
					else {
						const other = await test_mocks_fill_db_with.membership(ctx, {
							organizationName: "other-team",
							workspaceName: "home",
						});
						await ctx.db.patch("plugins_volumes", f.volumeId, { workspaceId: other.workspaceId });
					}
				});
				if (state === "purging") {
					await expect(f.runner.run({ command: `cat ${VOLUME_PATH}` })).rejects.toThrow("Unauthorized");
					return;
				}
				const refused = await f.runner.run({ command: `cat ${VOLUME_PATH}` });
				expect(refused.stdout).toBe("");
				expect(refused.metadata.exitCode).not.toBe(0);
			},
		);

		test.each(["disabled", "uninstalled", "purging", "left and rejoined", "role loss"] as const)(
			"rechecks access after paused R2 reads (%s)",
			async (state) => {
				const f = await create_volume_runner({ reader: true, large: true, chunks: false });
				let arrive = () => {};
				let resume = () => {};
				const started = new Promise<void>((resolve) => {
					arrive = resolve;
				});
				const paused = new Promise<void>((resolve) => {
					resume = resolve;
				});
				const baseFetch = vi.mocked(fetch).getMockImplementation()!;
				const baseAction = f.runner.runAction.getMockImplementation()!;
				const readResults: unknown[] = [];
				f.runner.runAction.mockImplementation(async (ref, args) => {
					const result = await baseAction(ref, args);
					if (function_name_of(ref) === "files_nodes_content:read_file_line_range") readResults.push(result);
					return result;
				});
				let intercepted = false;
				vi.mocked(fetch).mockImplementation(async (input, init) => {
					const response = await baseFetch(input, init);
					const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					if (!intercepted && href.endsWith(encodeURIComponent(f.nodes[0].r2Key))) {
						intercepted = true;
						arrive();
						await paused;
					}
					return response;
				});
				const reading = Promise.allSettled([f.runner.run({ command: `head -n 1 ${VOLUME_PATH}` })]);
				await started;
				if (state === "left and rejoined") {
					const asReader = f.runner.t.withIdentity({
						issuer: "https://clerk.test",
						external_id: f.runner.seeded.userId,
					});
					expect(
						await asReader.mutation(api.organizations.remove_user_from_organization, {
							organizationId: f.owner.organizationId,
							userIdToRemove: f.runner.seeded.userId,
						}),
					).toEqual({ _yay: null });
					expect(
						await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							userIdToAdd: f.runner.seeded.userId,
						}),
					).toEqual({ _yay: null });
				} else if (state === "role loss") {
					const role = await f.asOwner.mutation(api.access_control.create_role, {
						organizationId: f.owner.organizationId,
						name: "Workspace maker",
						description: "",
						permissions: ["workspace.create"],
					});
					if (role._nay) throw new Error(role._nay.message);
					expect(
						await f.asOwner.mutation(api.access_control.set_user_role, {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							userId: f.runner.seeded.userId,
							role: role._yay.roleId,
						}),
					).toEqual({ _yay: null });
				} else
					await f.runner.t.run(async (ctx) => {
						if (state === "disabled")
							await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
						else if (state === "uninstalled") await ctx.db.delete("plugins_workspace_installations", f.installationId);
						else
							await ctx.db.patch("organizations_workspaces", f.owner.workspaceId, {
								pluginDataPurgeStartedAt: Date.now(),
							});
					});
				resume();
				const [settled] = await reading;
				expect(intercepted).toBe(true);
				expect(readResults, "the paused read must not release old text").toEqual([null]);
				if (state === "purging" || state === "left and rejoined" || state === "role loss") {
					expect(settled.status).toBe("rejected");
					if (settled.status === "rejected") expect(String(settled.reason)).toContain("Unauthorized");
				} else {
					expect(settled.status).toBe("fulfilled");
					if (settled.status === "fulfilled") {
						expect(settled.value.stdout).toBe("");
						expect(settled.value.metadata.exitCode).not.toBe(0);
					}
				}
			},
		);

		test("refuses cached cat text after access changes during its second size lookup", async () => {
			const f = await create_volume_runner();
			const baseQuery = f.runner.runQuery.getMockImplementation()!;
			let sizeReads = 0;
			f.runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await baseQuery(ref, args);
				if (function_name_of(ref) === "r2:get_asset_by_id" && args.assetId === f.nodes[0].assetId) {
					sizeReads += 1;
					if (sizeReads === 2)
						await f.runner.t.run((ctx) =>
							ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" }),
						);
				}
				return result;
			});
			const result = await f.runner.run({ command: `cat ${VOLUME_PATH}; cat ${VOLUME_PATH}` });
			expect(sizeReads).toBe(2);
			expect(result.stdout, "cached content must not be released after the volume becomes unreadable").toBe(
				VOLUME_TEXT,
			);
			expect(result.metadata.exitCode).not.toBe(0);
		});

		test.each(["disabled", "replacement"] as const)(
			"rechecks exact file metadata after the size lookup (%s)",
			async (state) => {
				const f = await create_volume_runner();
				let arrive = () => {};
				let resume = () => {};
				const started = new Promise<void>((resolve) => {
					arrive = resolve;
				});
				const paused = new Promise<void>((resolve) => {
					resume = resolve;
				});
				const baseQuery = f.runner.runQuery.getMockImplementation()!;
				let intercepted = false;
				f.runner.runQuery.mockImplementation(async (ref, args) => {
					const result = await baseQuery(ref, args);
					if (!intercepted && function_name_of(ref) === "r2:get_asset_by_id" && args.assetId === f.nodes[0].assetId) {
						intercepted = true;
						arrive();
						await paused;
					}
					return result;
				});
				const reading = f.runner.run({ command: `stat -c %s ${VOLUME_PATH}` });
				await started;
				await f.runner.t.run(async (ctx) => {
					if (state === "disabled")
						await ctx.db.patch("plugins_workspace_installations", f.installationId, { status: "disabled" });
					else {
						const old = await ctx.db.get("files_nodes", f.nodes[0].nodeId);
						if (!old) throw new Error("Expected the original node");
						const { _id, _creationTime, ...fields } = old;
						await ctx.db.delete("files_nodes", _id);
						await ctx.db.insert("files_nodes", fields);
					}
				});
				resume();
				const result = await reading;
				expect(intercepted).toBe(true);
				expect(result.stdout, "the final target check must withhold stale metadata").toBe("");
				expect(result.metadata.exitCode).not.toBe(0);
			},
		);

		test("reads the pinned retired copy during publication until its files are removed", async () => {
			const f = await create_volume_runner({ large: true, chunks: false });
			const next = await seed_generation({
				runner: f.runner,
				installationId: f.installationId,
				volumeId: f.volumeId,
				files: [{ path: "/notes.md", text: "Replacement text\n" }],
				opts: { revision: "copy-2" },
			});
			const baseFetch = vi.mocked(fetch).getMockImplementation()!;
			let changed = false;
			vi.mocked(fetch).mockImplementation(async (input, init) => {
				const response = await baseFetch(input, init);
				if (!changed) {
					changed = true;
					await f.runner.t.run(async (ctx) => {
						await ctx.db.patch("plugins_volume_generations", f.generationId, {
							status: "retired",
							expiresAt: Date.now() + 600_000,
						});
						await ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: next.generationId });
					});
				}
				return response;
			});
			const oldRead = await f.runner.run({ command: `head -n 1 ${VOLUME_PATH}` });
			expect(changed).toBe(true);
			expect(oldRead.stdout).toBe("Mountneedle line\n");
			expect(oldRead.metadata.exitCode).toBe(0);
			expect((await f.runner.run({ command: `cat ${VOLUME_PATH}` })).stdout).toBe("Replacement text\n");
			await f.runner.t.run((ctx) => ctx.db.delete("files_nodes", f.nodes[0].nodeId));
			const oldTarget = await f.runner.t.action(internal.files_nodes_content.read_file_line_range, {
				agentSource: {
					organizationId: f.runner.ctxData.organizationId,
					workspaceId: f.runner.ctxData.workspaceId,
					userId: f.runner.ctxData.userId,
					threadId: f.runner.threadId,
					membershipId: f.runner.ctxData.membershipId,
					membershipLifetime: f.runner.ctxData.membershipLifetime,
				},
				organizationId: f.owner.organizationId,
				workspaceId: f.volumeId,
				userId: f.runner.seeded.userId,
				path: `/${f.generationId}/notes.md`,
				startLine: 1,
				maxLines: 1,
			});
			expect(oldTarget).toBeNull();
		});

		test("keeps published volume mounts inside background jobs", async () => {
			const f = await create_volume_runner();
			expect((await f.runner.run({ command: `{ cat ${VOLUME_PATH}; } &` })).metadata.exitCode).toBe(0);
			const row = await job_row(f.runner, 1);
			await bash_run_job(f.runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
			const finished = await job_row(f.runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(VOLUME_TEXT);
		});
	});

	describe("github mounts (Phase F7)", () => {
		// README content is markdown-hostile on purpose and small enough to read inline from the
		// committed plain-text chunks (no R2 round-trip), matching how the sync materializes external mount content.
		const README_TEXT = "# experiment--t3-chat\n\nMounted repo readme.\nZorptelemetry marker line.\n";
		const GUIDE_TEXT = "guide alpha\nguide beta\n";
		const MOUNT_COMMIT_SHA = "a".repeat(40);

		// Seed reserved-scope (`GLOBAL`/`GITHUB`) plain-text nodes via the real Phase D path, under the
		// commit-keyed root a finished sync would produce. Bash only mounts sources whose
		// `lastCommitSha` is set, so the source row is part of the fixture.
		async function seed_github_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			name: string;
			files: { path: string; rawText: string }[];
		}) {
			const { runner, name, files } = args;

			const inserted = (await runner.t.mutation(internal.github_mounts.upsert_mount, {
				name,
				owner: "raythurnvoid",
				repo: "experiment--t3-chat",
				ref: "main",
			})) as { _yay?: { mountId: Id<"github_mounts"> }; _nay?: { message: string } };
			if (!inserted._yay) {
				throw new Error(`Failed to seed github mount ${name}: ${inserted._nay?.message}`);
			}
			const mountId = inserted._yay.mountId;
			await runner.t.run((ctx) => ctx.db.patch("github_mounts", mountId, { lastCommitSha: MOUNT_COMMIT_SHA }));
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					path: `/${name}/${MOUNT_COMMIT_SHA}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed mount file /${name}${file.path}: ${created._nay?.message}`);
				}
			}
		}

		test("lists reserved top-level mount folders at the synthetic /.mounts root", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });
			await seed_github_mount({ runner, name: "examples", files: [{ path: "/hello.md", rawText: "hello\n" }] });

			const result = await runner.run({ command: "ls /.mounts" });

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("t3-chat");
			expect(result.stdout).toContain("examples");
		});

		test("lists and reads files inside a mount byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [
					{ path: "/README.md", rawText: README_TEXT },
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
				],
			});

			const listing = await runner.run({ command: "ls /.mounts/t3-chat" });
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("docs");

			runner.runQuery.mockClear();
			const readme = await runner.run({ command: "cat /.mounts/t3-chat/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);

			const guide = await runner.run({ command: "cat /.mounts/t3-chat/docs/guide.md" });
			expect(guide.metadata.exitCode).toBe(0);
			expect(guide.stdout).toBe(GUIDE_TEXT);
			expect(
				runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_pending_updates:get_by_file_node"),
			).toBe(false);
		});

		test("rejects mount glob patterns without shell-expanding reserved db files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const result = await runner.run({ command: "ls /.mounts/t3-chat/*.md" });

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain("Try: find /.mounts/t3-chat -type f --extension md --limit 20");
		});

		test("reports mount folders as directories for readers", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }] });

			for (const command of [
				"cat /.mounts/t3-chat/docs",
				"head /.mounts/t3-chat/docs",
				"sed -n '1p' /.mounts/t3-chat/docs",
				"wc /.mounts/t3-chat/docs",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Is a directory");
			}
		});

		test("cd into a mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }] });

			const moved = await runner.run({ command: "cd /.mounts/t3-chat/docs" });
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run({ command: "pwd" });
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.mounts/t3-chat/docs\n");
		});

		test("grep and search find content scoped to a mount", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const grepped = await runner.run({ command: "grep Zorptelemetry /.mounts/t3-chat/README.md" });
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Zorptelemetry marker line.");

			const searched = await runner.run({ command: "search --path /.mounts/t3-chat Zorptelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("README.md");
		});

		test("find --prefix resolves relative to mount cwd and returns zero matches for absent prefixes", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
					{ path: "/docs/notes.md", rawText: "notes\n" },
					{ path: "/docs-archive/leak.md", rawText: "leak\n" },
				],
			});

			const fromMount = await runner.run({ command: "cd /.mounts/t3-chat && find --prefix docs --limit 20 -type f" });
			expect(fromMount.metadata.exitCode).toBe(0);
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/guide.md");
			expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/notes.md");
			expect(fromMount.stdout).not.toContain("/.mounts/t3-chat/docs-archive/leak.md");

			const fromDocs = await runner.run({ command: "cd /.mounts/t3-chat/docs && find --prefix . --limit 1" });
			expect(fromDocs.metadata.exitCode).toBe(0);
			expect(fromDocs.stdout).toContain("/.mounts/t3-chat/docs/");

			const paged = await runner.run({ command: "cd /.mounts/t3-chat && find --prefix docs --limit 1" });
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toMatch(/Next page: find --prefix \/.mounts\/t3-chat\/docs --limit 1 --cursor \S+/u);

			const missing = await runner.run({ command: "find --prefix /.mounts/nope --limit 20" });
			expect(missing.metadata.exitCode).toBe(0);
			expect(missing.stdout).toContain("0 matches.");
		});

		test("keeps mount content isolated from the tenant app file tree", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			// The default app file tree has no Zorptelemetry marker, so an app-scope search misses it:
			// the reserved mount scope is reachable only through the /.mounts prefix.
			const workspaceSearch = await runner.run({ command: "search Zorptelemetry" });
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("README.md");

			// The runner starts in the app file tree root; listing it shows app folders, never mounts.
			const workspaceRoot = await runner.run({ command: "ls" });
			expect(workspaceRoot.metadata.exitCode).toBe(0);
			expect(workspaceRoot.stdout).toContain("docs");
			expect(workspaceRoot.stdout).not.toContain("t3-chat");

			// The stored reserved path (without the /.mounts prefix) is not addressable from the shell.
			const bare = await runner.run({ command: "cat /t3-chat/README.md" });
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("rejects every write into a read-only mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const writes = [
				"touch /.mounts/t3-chat/new.txt",
				"rm /.mounts/t3-chat/README.md",
				"mv /.mounts/t3-chat/README.md /.mounts/t3-chat/renamed.md",
				"echo hi | tee /.mounts/t3-chat/new.txt",
				"cp /.mounts/t3-chat/README.md /.mounts/t3-chat/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("is a read-only mount of an external source");
			}

			// The mount file is still present and unchanged after all rejected writes.
			const readme = await runner.run({ command: "cat /.mounts/t3-chat/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(README_TEXT);
		});

		test("allows copying a mount file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const copied = await runner.run({
				command: "cp /.mounts/t3-chat/README.md /tmp/readme.md && cat /tmp/readme.md",
			});
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(README_TEXT);
		});

		test("refuses to execute a mount file through bash", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/script.sh", rawText: "echo pwned\n" }] });

			for (const command of ["bash /.mounts/t3-chat/script.sh"]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("not executable through bash");
			}

			for (const command of [
				"source /.mounts/t3-chat/script.sh",
				". /.mounts/t3-chat/script.sh",
				"BONOBO=1 source /.mounts/t3-chat/script.sh",
				"2>/tmp/source.err source /.mounts/t3-chat/script.sh",
				"command source /.mounts/t3-chat/script.sh",
				"command -- source /.mounts/t3-chat/script.sh",
				"command -p source /.mounts/t3-chat/script.sh",
				"eval 'source /.mounts/t3-chat/script.sh'",
				"eval 'BONOBO=1 source /.mounts/t3-chat/script.sh'",
				"bash -c 'source /.mounts/t3-chat/script.sh'",
				"bash -c '2>/tmp/source.err source /.mounts/t3-chat/script.sh'",
				"sh -c '. /.mounts/t3-chat/script.sh'",
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("pwned");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("keeps nested command loaders from executing mount files", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({
				runner,
				name: "t3-chat",
				files: [{ path: "/script.sh", rawText: "echo mount-loaded\n" }],
			});

			for (const command of [
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs source",
				"printf '%s\\n' '/.mounts/t3-chat/script.sh' | xargs .",
				'bash -c "$(cat /.mounts/t3-chat/script.sh)"',
				'sh -c "$(cat /.mounts/t3-chat/script.sh)"',
				'eval "$(cat /.mounts/t3-chat/script.sh)"',
			]) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stdout).not.toContain("loaded");
				expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
			}
		});

		test("reports missing mount targets as no such file", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			const listMissing = await runner.run({ command: "ls /.mounts/nope" });
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run({ command: "cat /.mounts/nope/x.md" });
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps the launching call's mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_github_mount({ runner, name: "t3-chat", files: [{ path: "/README.md", rawText: README_TEXT }] });

			expect(
				(await runner.run({ command: "{ ls /.mounts; cat /.mounts/t3-chat/README.md; } &" })).metadata.exitCode,
			).toBe(0);

			// The worker builds its own filesystem, so it must fetch the mount list itself. Without
			// that query `/.mounts` is empty inside the job even though the launching call saw it.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`t3-chat\n${README_TEXT}`);
		});
	});

	describe("run_plugin_review", () => {
		const reviewRoot = `/review-${"a".repeat(32)}`;
		const otherRoot = `/review-${"b".repeat(32)}`;
		const source = "// Reviewneedle marker\nexport const ready = true;\n";

		async function create_review_runner() {
			const runner = await create_bash_runner();
			for (const [path, rawText] of [
				[`${reviewRoot}/dist/worker.js`, source],
				[`${reviewRoot}/script.sh`, "printf 'executed-source-marker'\n"],
				[`${otherRoot}/other.js`, "Reviewneedle Otherreviewprivate\n"],
			]) {
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path,
					rawText,
				});
				expect(created._nay).toBeUndefined();
			}
			let cwd = "/.plugins/review";
			let scratch: bash_ReviewScratch = { fileNodes: [], fileNodesContent: [] };
			const run = async (command: string) => {
				const result = await runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot,
					userId: runner.seeded.userId,
					command,
					cwd,
					scratch,
				});
				cwd = result.cwd;
				scratch = result.scratch;
				return result;
			};
			return { runner, run };
		}

		test("reads and searches only the pinned source tree with ordinary Bash commands", async () => {
			const { run } = await create_review_runner();
			const read = await run("cat dist/worker.js");
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain(source.trim());
			for (const command of [
				"ls dist",
				"find .",
				"grep -n Reviewneedle dist/worker.js",
				"search Reviewneedle",
				"tree /.plugins",
				"find /.plugins",
				"search --path /.plugins Reviewneedle",
				"cd /tmp && search Reviewneedle",
				`meta search --where '{"eq":["metadata.source","plugin-source"]}'`,
				"cd / && search Reviewneedle",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(0);
				expect(result.output).toContain("worker.js");
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("other.js");
			}
		});

		test("pages MIME matches inside one review and refuses its cursor in another source", async () => {
			const { runner, run } = await create_review_runner();
			const first = await run("find /.plugins/review --content-type text/plain --limit 1");
			expect(first.exitCode, first.output).toBe(0);
			expect(first.output).toContain("/.plugins/review/dist/worker.js\n");
			expect(first.output).not.toContain("other.js");
			const next = first.output.match(/Next page: (.+)/u)?.[1];
			expect(next).toBeTruthy();
			const second = await run(next!);
			expect(second.exitCode, second.output).toBe(0);
			expect(second.output).toContain("/.plugins/review/script.sh\n");
			expect(second.output).not.toContain("Next page:");
			const otherReview = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: otherRoot,
				userId: runner.seeded.userId,
				command: next!,
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(otherReview.exitCode).toBe(1);
			expect(otherReview.output).toContain("The file search changed");
			expect(otherReview.output).not.toContain("worker.js");
			const chat = await runner.run({ command: next! });
			expect(chat.metadata.exitCode).not.toBe(0);
			expect(chat.stdout).toBe("");
			for (const rootPath of ["/", otherRoot]) {
				const outside = await runner.t.mutation(internal.files_type_queries.begin, {
					organizationId: "GLOBAL",
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					userId: runner.seeded.userId,
					pluginReviewRoot: reviewRoot,
					overlay: false,
					rootPath,
					contentType: "text/plain",
					directoriesOnly: false,
					limit: 1,
				});
				expect(outside._nay?.message).toBe("File search unavailable");
			}
		});

		test("stops MIME pages and replay as soon as review cleanup starts", async () => {
			const { runner, run } = await create_review_runner();
			for (let index = 0; index < 40; index++) {
				const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path: `${reviewRoot}/later/${index}.js`,
					rawText: "export const ready = true;\n",
				});
				expect(created._nay).toBeUndefined();
			}
			const command = "find /.plugins/review --content-type text/plain --limit 1";
			const first = await run(command);
			expect(first.exitCode, first.output).toBe(0);
			expect(first.output).toContain("/.plugins/review/dist/worker.js\n");
			const next = first.output.match(/Next page: (.+)/u)?.[1];
			expect(next).toBeTruthy();
			const query = await runner.t.run((ctx) =>
				ctx.db
					.query("files_type_queries")
					.withIndex("by_user", (q) => q.eq("userId", runner.seeded.userId))
					.first(),
			);
			expect(query?.pluginReviewRoot).toBe(reviewRoot);
			const replayCursor = await bash_cursor_id_create(runner.ctx, JSON.stringify({ queryId: query!._id, step: 0 }));
			const replay = `${command} --cursor ${replayCursor}`;
			expect((await run(replay)).exitCode).toBe(0);
			const root = await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: "GLOBAL",
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				visibilityUserId: runner.seeded.userId,
				subject: { kind: "user", userId: runner.seeded.userId, plugin: null },
				path: reviewRoot,
			});
			await runner.t.mutation(internal.plugins.delete_review_source_tree, { reviewRoot });
			const cleaning = await runner.t.run((ctx) => ctx.db.get("files_nodes", root!._id));
			expect(cleaning, "cleanup has not removed the root yet").not.toBeNull();
			for (const remaining of [next!, replay, command]) {
				const result = await run(remaining);
				expect(result.exitCode, result.output).toBe(1);
				expect(result.output).toContain("File search unavailable");
				expect(result.output).not.toContain("worker.js");
			}
		});

		test("has no /shells mount and no jobs, wait or kill; & runs inline", async () => {
			const { run } = await create_review_runner();
			expect((await run("ls /shells")).exitCode).not.toBe(0);
			for (const command of ["jobs", "kill 1"]) {
				const result = await run(command);
				expect(result.exitCode, result.output).toBe(127);
			}
			const inline = await run("echo inline &");
			expect(inline.exitCode, inline.output).toBe(0);
			expect(inline.output).toContain("inline");
			expect(inline.output).not.toContain("started job");
		});

		test("resolve refuses tenant and reserved IDs in plugin review", async () => {
			const { runner, run } = await create_review_runner();
			const tenantId = await get_seeded_node_id(runner, "/docs/readme.md");
			const reserved = await runner.t.query(internal.files_nodes.get_by_path, {
				organizationId: "GLOBAL",
				workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
				visibilityUserId: runner.seeded.userId,
				subject: { kind: "user", userId: runner.seeded.userId, plugin: null },
				path: `${reviewRoot}/dist/worker.js`,
			});
			expect(reserved).not.toBeNull();
			vi.mocked(fetch).mockClear();

			for (const nodeId of [tenantId, reserved!._id]) {
				const result = await run(`resolve '${nodeId}'`);
				expect(result.exitCode).toBe(1);
				expect(result.output).toContain("unavailable in this chat's workspaces");
				expect(result.output).not.toContain("/docs/readme.md");
				expect(result.output).not.toContain("dist/worker.js");
			}
			const tenantLookup = await runner.run({ command: `resolve '${reserved!._id}'` });
			expect(tenantLookup.metadata.exitCode).toBe(1);
			expect(tenantLookup.stdout).toBe("");
			expect(tenantLookup.metadata.observedPaths).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
		});

		test("keeps cwd and scratch between calls without writing a chat thread", async () => {
			const { runner, run } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect());
			expect((await run("mkdir /tmp/notes && printf 'follow the backend' > /tmp/notes/plan && cd dist")).exitCode).toBe(
				0,
			);
			const next = await run("cat /tmp/notes/plan && cat worker.js");
			expect(next.exitCode).toBe(0);
			expect(next.cwd).toBe("/.plugins/review/dist");
			expect(next.output).toContain("follow the backend");
			expect(next.output).toContain(source.trim());
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_threads").collect())).toEqual(before);
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_files").collect())).toEqual([]);
		});

		test("hides review files from the main agent and blocks unrelated paths in review", async () => {
			const { runner, run } = await create_review_runner();
			expect((await runner.run({ command: "search Reviewneedle" })).stdout).not.toContain("worker.js");
			expect((await runner.run({ command: "cat /.plugins/review/dist/worker.js" })).metadata.exitCode).not.toBe(0);
			for (const path of [
				"/home/cloud-usr/w/personal/home/docs/readme.md",
				`${otherRoot}/other.js`,
				`/.plugins/review/../../${otherRoot.slice(1)}/other.js`,
				"/.plugins/other/other.js",
				"/.mounts/other/other.js",
				"/etc/passwd",
			]) {
				const result = await run(`cat ${path}`);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("Otherreviewprivate");
				expect(result.output).not.toContain("unique-token");
			}
		});

		test("refuses source changes and mounted shell execution", async () => {
			const { run } = await create_review_runner();
			for (const command of [
				"printf changed > dist/worker.js",
				"printf changed | tee dist/worker.js",
				"rm dist/worker.js",
				"mv dist/worker.js dist/changed.js",
				"cp dist/worker.js dist/copy.js",
				"touch dist/new.js",
				"mkdir new",
				"bash script.sh",
				"source script.sh",
			]) {
				const result = await run(command);
				expect(result.exitCode, result.output).not.toBe(0);
				expect(result.output).not.toContain("executed-source-marker");
			}
			expect((await run("cat dist/worker.js")).output).toContain(source.trim());
		});

		test("bounds scratch and keeps guidance when a pipeline discards stderr", async () => {
			const { run } = await create_review_runner();
			const scratch = await run("printf '%3000s' x > /tmp/large.txt");
			expect(scratch.output).toContain("not persisted");
			expect(scratch.scratch.fileNodes).toEqual([]);
			expect((await run("cat /tmp/large.txt")).exitCode).not.toBe(0);
			const invalid = await run("cat --invalid dist/worker.js 2>/dev/null | head");
			expect(invalid.output).toContain("cat: unsupported option");
		});

		test("rejects a host request for a root outside the review namespace", async () => {
			const { runner } = await create_review_runner();
			await expect(
				runner.t.action(internal.bash.run_plugin_review, {
					reviewRoot: "/",
					userId: runner.seeded.userId,
					command: "ls",
					cwd: "/.plugins/review",
					scratch: { fileNodes: [], fileNodesContent: [] },
				}),
			).rejects.toThrow("Invalid plugin review root");
		});

		test("stages exact source and cleans only that attempt's nodes, chunks, and assets", async () => {
			const { runner } = await create_review_runner();
			const preserved = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const beforeAssets = await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect());
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/worker.js", source: "// café 🦜\r\nexport const value = 1;\r\n" }],
			});
			expect(staged._nay).toBeUndefined();
			if (!staged._yay) throw new Error("Source staging failed");
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "cat dist/worker.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode).toBe(0);
			expect(read.output).toContain("// café 🦜\nexport const value = 1;");
			const nodes = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const stagedNodeIds = new Set(
				nodes.filter((node) => node.path.startsWith(`${staged._yay.reviewRoot}/`)).map((node) => node._id),
			);
			const file = nodes.find((node) => node.path === `${staged._yay.reviewRoot}/dist/worker.js`);
			if (!file?.assetId) throw new Error("Staged source has no asset");
			const asset = await runner.t.run((ctx) => ctx.db.get("files_r2_assets", file.assetId!));
			expect(test_r2_objects.get(asset!.r2Key!)).toEqual(
				new TextEncoder().encode("// café 🦜\r\nexport const value = 1;\r\n"),
			);
			const stored = await runner.t.run((ctx) => ctx.db.query("files_text_chunks").collect());
			expect(stored.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
				true,
			);
			await runner.t.mutation(internal.plugins.delete_review_source_tree, { reviewRoot: staged._yay.reviewRoot });
			expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(preserved);
			expect(await runner.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(beforeAssets);
			for (const table of ["files_text_chunks", "files_plain_text_chunks"] as const) {
				const chunks = await runner.t.run((ctx) => ctx.db.query(table).collect());
				expect(chunks.some((chunk) => chunk.sourceKind === "committed" && stagedNodeIds.has(chunk.fileNodeId))).toBe(
					false,
				);
			}
		});

		test("schedules cleanup before staging so an abandoned attempt expires", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: Array.from({ length: 30 }, (_, index) => ({ path: `dist/module-${index}.js`, source })),
				});
				expect(staged._nay).toBeUndefined();
				expect((await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).length).toBeGreaterThan(
					before.length,
				);
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});

		test("reads a bounded window near the end of a large minified file", async () => {
			const { runner } = await create_review_runner();
			const staged = await runner.t.action(internal.plugins_review.stage_sources, {
				files: [{ path: "dist/large.js", source: `${"x".repeat(780_000)};const payload = 'Largetailneedle';` }],
			});
			if (!staged._yay) throw new Error(staged._nay.message);
			const read = await runner.t.action(internal.bash.run_plugin_review, {
				reviewRoot: staged._yay.reviewRoot,
				userId: runner.seeded.userId,
				command: "grep --start-index 780000 --max-chars 2000 payload dist/large.js",
				cwd: "/.plugins/review",
				scratch: { fileNodes: [], fileNodesContent: [] },
			});
			expect(read.exitCode, read.output).toBe(0);
			expect(read.output).toContain("Largetailneedle");
			expect(read.output.length).toBeLessThan(3000);
		});

		test.each(["../escape.js", "/escape.js", "dist/../escape.js", "dist//escape.js"])(
			"refuses source path %s before writing anything",
			async (path) => {
				const { runner } = await create_review_runner();
				const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/valid.js", source },
						{ path, source },
					],
				});
				expect(staged._nay?.message).toContain("normalized relative paths");
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			},
		);

		test("cleans partial staging when a later file cannot be created", async () => {
			const { runner } = await create_review_runner();
			const before = await runner.t.run((ctx) => ctx.db.query("files_nodes").collect());
			vi.useFakeTimers();
			try {
				const staged = await runner.t.action(internal.plugins_review.stage_sources, {
					files: [
						{ path: "dist/worker.js", source },
						{ path: "dist/worker.js/child.js", source },
					],
				});
				expect(staged._nay).toBeDefined();
				await runner.t.finishAllScheduledFunctions(() => vi.runAllTimers());
				expect(await runner.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("plugin source mounts", () => {
		const WORKER_TEXT = "export const plugin = 'media';\nGlomtelemetry marker line.\n";
		const PLUGIN_README_TEXT = "# media plugin\n\nPlugin source readme.\n";

		// Seed a registered plugin version with a version-keyed source tree in the reserved
		// GLOBAL/PLUGINS scope, plus an enabled installation in the runner's workspace — the
		// same rows the publish + install flows produce, without the full publish pipeline.
		async function seed_plugin_mount(args: {
			runner: Awaited<ReturnType<typeof create_bash_runner>>;
			pluginName: string;
			files: { path: string; rawText: string }[];
			opts?: { installed?: boolean };
		}) {
			const { runner, pluginName, files, opts } = args;

			const now = Date.now();
			const pluginVersionId = await runner.t.run((ctx) =>
				ctx.db.insert("plugins_versions", {
					name: pluginName,
					displayName: pluginName,
					version: "0.1.0",
					description: `${pluginName} plugin`,
					reviewStatus: "passed",
					reviewId: null,
					isLatest: true,
					artifactHash: `sha256:${"a".repeat(64)}`,
					sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
					sourceOwner: "bonobo",
					sourceRepo: `${pluginName}-plugin`,
					sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
					manifestR2Key: `plugins/${pluginName}/manifest.json`,
					backendEntrypointFile: {
						entry: "dist/backend/worker.js",
						moduleName: "plugin.js",
						r2Key: `plugins/${pluginName}/backend/worker.js`,
						sha256: `sha256:${"b".repeat(64)}`,
						compatibilityDate: "2026-07-01",
						compatibilityFlags: ["nodejs_compat"],
					},
					configuration: null,
					mounts: [],
					events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
					pages: [],
					fileViews: [],
					capabilities: [],
					outboundOrigins: [],
					uiOutboundOrigins: [],
					mcpServers: [],
					mcpServersFingerprint: "mcp-servers-hash",
					skills: [],
					files: [],
					sourceStatus: "ready",
					sourceLastError: null,
					createdBy: runner.seeded.userId,
					updatedAt: now,
					secrets: [],
					endpoints: [],
					userWritableCollections: null,
				}),
			);
			for (const file of files) {
				const created = (await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					path: `/${pluginVersionId}${file.path}`,
					rawText: file.rawText,
				})) as { _yay?: unknown; _nay?: { message: string } };
				if (!created._yay) {
					throw new Error(`Failed to seed plugin source file ${file.path}: ${created._nay?.message}`);
				}
			}
			let installationId: Id<"plugins_workspace_installations"> | null = null;
			if (opts?.installed !== false) {
				installationId = await runner.t.run(async (ctx) => {
					const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						name: pluginName,
						createdBy: runner.seeded.userId,
						createdAt: now,
						updatedAt: now,
						revokedAt: null,
					});
					await ctx.db.insert("plugins_service_account_bindings", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						pluginName,
						publisherUserId: runner.seeded.userId,
						sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
						serviceAccountId,
					});
					return await ctx.db.insert("plugins_workspace_installations", {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						serviceAccountId,
						pluginVersionId,
						pluginName,
						status: "enabled",
						managementAccess: "selected",
						configurationYaml: null,
						acceptedCapabilities: [],
						capabilitiesAcceptedAt: now,
						acceptedOutboundOrigins: [],
						acceptedUiOutboundOrigins: [],
						acceptedMcpServersFingerprint: "mcp-servers-hash",
						acceptedSkillNames: [],
						outboundOriginsAcceptedAt: now,
						sandbox: { roots: [], rebuild: null },
						installedBy: runner.seeded.userId,
						updatedBy: runner.seeded.userId,
						updatedAt: now,
					});
				});
			}
			return { pluginVersionId, installationId };
		}

		test("hides /.plugins entirely when no plugin is installed", async () => {
			const runner = await create_bash_runner();
			// Published but not installed in this workspace: no existence leak.
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
				opts: {
					installed: false,
				},
			});

			const listing = await runner.run({ command: "ls /.plugins" });
			expect(listing.metadata.exitCode).not.toBe(0);
			expect(listing.stderr).toContain("No such file");

			const read = await runner.run({ command: "cat /.plugins/media/dist/backend/worker.js" });
			expect(read.metadata.exitCode).not.toBe(0);
			expect(read.stderr).toContain("No such file");

			// The fan-out commands also treat the root as nonexistent with zero installations.
			const tree = await runner.run({ command: "tree /.plugins" });
			expect(tree.metadata.exitCode).not.toBe(0);
			expect(tree.stderr).toContain("No such file");

			const found = await runner.run({ command: "find /.plugins" });
			expect(found.metadata.exitCode).not.toBe(0);
			expect(found.stderr).toContain("No such file");

			const searched = await runner.run({ command: "search --path /.plugins Glomtelemetry" });
			expect(searched.metadata.exitCode).not.toBe(0);
			expect(searched.stderr).toContain("No such file");
		});

		test("lists installed plugin names at the synthetic /.plugins root", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const result = await runner.run({ command: "ls /.plugins" });

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("media");
			expect(result.stdout).toContain("alpha-notes");
		});

		test("lists and reads files inside an installed plugin byte-identically", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				],
			});

			const listing = await runner.run({ command: "ls /.plugins/media" });
			expect(listing.metadata.exitCode).toBe(0);
			expect(listing.stdout).toContain("README.md");
			expect(listing.stdout).toContain("dist");

			const readme = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);

			const worker = await runner.run({ command: "cat /.plugins/media/dist/backend/worker.js" });
			expect(worker.metadata.exitCode).toBe(0);
			expect(worker.stdout).toBe(WORKER_TEXT);
		});

		test("grep and search find content scoped to one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const grepped = await runner.run({ command: "grep Glomtelemetry /.plugins/media/dist/backend/worker.js" });
			expect(grepped.metadata.exitCode).toBe(0);
			expect(grepped.stdout).toContain("Glomtelemetry marker line.");

			const searched = await runner.run({ command: "search --path /.plugins/media Glomtelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("worker.js");
		});

		test("fans out root-scope tree, find, and search across installed plugins in name order", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const tree = await runner.run({ command: "tree /.plugins" });
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("/.plugins");
			expect(tree.stdout).toContain("|-- alpha-notes/");
			expect(tree.stdout).toContain("|-- media/");
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");
			expect(tree.stdout.indexOf("alpha-notes")).toBeLessThan(tree.stdout.indexOf("media"));

			const found = await runner.run({ command: "find /.plugins -type f --limit 20" });
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

			// Depth predicates are relative to /.plugins: -maxdepth 1 keeps only plugin folders.
			const top = await runner.run({ command: "find /.plugins -maxdepth 1 --limit 20" });
			expect(top.metadata.exitCode).toBe(0);
			expect(top.stdout).toContain("/.plugins/alpha-notes/");
			expect(top.stdout).toContain("/.plugins/media/");
			expect(top.stdout).not.toContain("README.md");
			// Each plugin reads its root, its root and children, or its whole subtree.
			const twoLevels = await runner.run({ command: "find /.plugins -maxdepth 2 --limit 20" });
			expect(twoLevels.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(twoLevels.stdout).toContain("/.plugins/media/dist/");
			expect(twoLevels.stdout).not.toContain("backend");
			const childrenOnly = await runner.run({ command: "find /.plugins -mindepth 2 -maxdepth 2 --limit 20" });
			expect(childrenOnly.stdout.split("\n")).not.toContain("/.plugins/media/");
			expect(childrenOnly.stdout).toContain("/.plugins/media/dist/");
			const tooDeep = await runner.run({ command: "find /.plugins -maxdepth 3 --limit 20" });
			expect(tooDeep.metadata.exitCode).toBe(2);
			expect(tooDeep.stderr).toContain("the folder itself (-maxdepth 1), its direct children (-maxdepth 2)");

			const searched = await runner.run({ command: "search --path /.plugins Glomtelemetry" });
			expect(searched.metadata.exitCode).toBe(0);
			expect(searched.stdout).toContain("under /.plugins");
			expect(searched.stdout).toContain("/.plugins/media/dist/backend/worker.js");
		});

		test("pages the /.plugins fan-out with a composite cursor and detects listing changes", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "alpha-notes",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});
			const { installationId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const firstPage = await runner.run({ command: "find /.plugins -type f --limit 1" });
			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain("/.plugins/alpha-notes/README.md");
			expect(firstPage.stdout).not.toContain("/.plugins/media/README.md");
			const continuation = firstPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(continuation).toBeTruthy();

			// The composite cursor resumes into the next plugin in name order.
			const secondPage = await runner.run({ command: String(continuation) });
			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("/.plugins/media/README.md");

			// Uninstalling between pages invalidates the pinned listing snapshot.
			const restartPage = await runner.run({ command: "find /.plugins -type f --limit 1" });
			const staleContinuation = restartPage.stdout.match(/Next page: (find .+)/)?.[1];
			expect(staleContinuation).toBeTruthy();
			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});
			const changed = await runner.run({ command: String(staleContinuation) });
			expect(changed.metadata.exitCode).not.toBe(0);
			expect(changed.stderr).toContain("listing changed");
		});

		test("keeps guidance for root-scope --prefix and meta search", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const prefixed = await runner.run({ command: "find --prefix /.plugins --limit 5" });
			expect(prefixed.metadata.exitCode).not.toBe(0);
			expect(prefixed.stderr).toContain("--prefix cannot scan the /.plugins root");

			const metaSearched = await runner.run({
				command: `meta search --path /.plugins --where '{"exists":"frontmatter.cc"}'`,
			});
			expect(metaSearched.metadata.exitCode).not.toBe(0);
			expect(metaSearched.stderr).toContain("choose a single plugin to search");
		});

		test("scoped tree and find work inside one plugin", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				],
			});

			const tree = await runner.run({ command: "tree /.plugins/media" });
			expect(tree.metadata.exitCode).toBe(0);
			expect(tree.stdout).toContain("README.md");
			expect(tree.stdout).toContain("worker.js");

			const found = await runner.run({ command: "find /.plugins/media -type f --limit 20" });
			expect(found.metadata.exitCode).toBe(0);
			expect(found.stdout).toContain("/.plugins/media/README.md");
			expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

			// Name search reads the plugin tree's saved ancestor fields.
			const byName = await runner.run({ command: "find /.plugins/media -name worker" });
			expect(byName.stdout).toBe("/.plugins/media/dist/backend/worker.js\n");
			// App files refuse these two; one plugin keeps its path word scan.
			const byPath = await runner.run({ command: "find /.plugins/media --path-query backend" });
			expect(byPath.stdout).toBe("/.plugins/media/dist/backend/\n/.plugins/media/dist/backend/worker.js\n");
			const children = await runner.run({ command: "find /.plugins/media/dist -maxdepth 1 -name backend" });
			expect(children.stdout).toBe("/.plugins/media/dist/backend/\n");
		});

		test("cd into a plugin mount persists across invocations", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			const moved = await runner.run({ command: "cd /.plugins/media/dist" });
			expect(moved.metadata.exitCode).toBe(0);

			const here = await runner.run({ command: "pwd" });
			expect(here.metadata.exitCode).toBe(0);
			expect(here.stdout).toBe("/.plugins/media/dist\n");
		});

		test("rejects every write into a plugin mount and leaves it intact", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const writes = [
				"touch /.plugins/media/new.txt",
				"rm /.plugins/media/README.md",
				"mv /.plugins/media/README.md /.plugins/media/renamed.md",
				"echo hi | tee /.plugins/media/new.txt",
				"cp /.plugins/media/README.md /.plugins/media/copy.md",
			];
			for (const command of writes) {
				const result = await runner.run({ command });
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("read-only mount of installed plugin sources");
			}

			const readme = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(readme.metadata.exitCode).toBe(0);
			expect(readme.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("allows copying a plugin file out to /tmp scratch", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const copied = await runner.run({ command: "cp /.plugins/media/README.md /tmp/readme.md && cat /tmp/readme.md" });
			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toBe(PLUGIN_README_TEXT);
		});

		test("refuses to execute plugin source through bash and source", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/script.sh", rawText: "echo pwned\n" }],
			});

			const executed = await runner.run({ command: "bash /.plugins/media/script.sh" });
			expect(executed.metadata.exitCode).not.toBe(0);
			expect(executed.stdout).not.toContain("pwned");
			expect(executed.stderr).toContain("not executable through bash");

			const sourced = await runner.run({ command: "source /.plugins/media/script.sh" });
			expect(sourced.metadata.exitCode).not.toBe(0);
			expect(sourced.stdout).not.toContain("pwned");
			expect(sourced.stderr).toContain("cannot load app files or agent-only external mounts");
		});

		test("reports not-installed plugin names as plain missing paths", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const listMissing = await runner.run({ command: "ls /.plugins/nope" });
			expect(listMissing.metadata.exitCode).not.toBe(0);
			expect(listMissing.stderr).toContain("No such file");

			const catMissing = await runner.run({ command: "cat /.plugins/nope/x.md" });
			expect(catMissing.metadata.exitCode).not.toBe(0);
			expect(catMissing.stderr).toContain("No such file");
		});

		test("keeps plugin source isolated from the tenant app tree", async () => {
			const runner = await create_bash_runner();
			const { pluginVersionId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }],
			});

			// App-scope search never reaches the reserved plugin scope.
			const workspaceSearch = await runner.run({ command: "search Glomtelemetry" });
			expect(workspaceSearch.metadata.exitCode).toBe(0);
			expect(workspaceSearch.stdout).not.toContain("worker.js");

			// The stored version-keyed path is not addressable outside the /.plugins prefix.
			const bare = await runner.run({ command: `cat /${pluginVersionId}/dist/backend/worker.js` });
			expect(bare.metadata.exitCode).not.toBe(0);
		});

		test("drops the mount when the installation is removed", async () => {
			const runner = await create_bash_runner();
			const { installationId } = await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			const visible = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(visible.metadata.exitCode).toBe(0);

			await runner.t.run(async (ctx) => {
				if (installationId == null) {
					throw new Error("Expected seeded installation");
				}
				await ctx.db.delete("plugins_workspace_installations", installationId);
			});

			// Mounts are derived per command run, so the next call already reflects the uninstall.
			const gone = await runner.run({ command: "cat /.plugins/media/README.md" });
			expect(gone.metadata.exitCode).not.toBe(0);
			expect(gone.stderr).toContain("No such file");
		});

		test("keeps the launching call's plugin mounts inside a background job", async () => {
			const runner = await create_bash_runner();
			await seed_plugin_mount({
				runner,
				pluginName: "media",
				files: [{ path: "/README.md", rawText: PLUGIN_README_TEXT }],
			});

			expect(
				(await runner.run({ command: "{ ls /.plugins; cat /.plugins/media/README.md; } &" })).metadata.exitCode,
			).toBe(0);

			// The worker builds its own filesystem, so it must fetch the installed plugins itself.
			// Without that query `/.plugins` is empty inside the job.
			const row = await job_row(runner, 1);
			await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });

			const finished = await job_row(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe(`media\n${PLUGIN_README_TEXT}`);
		});
	});
});
