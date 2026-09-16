import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { ai_chat_files_db_append_shell_transcript } from "./ai_chat_files.ts";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytes(value: string) {
	return textEncoder.encode(value).buffer as ArrayBuffer;
}

function text(value: ArrayBuffer) {
	return textDecoder.decode(new Uint8Array(value));
}

async function create_thread() {
	const t = test_convex();
	const seeded = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "personal",
			workspaceName: "home",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		subject: "clerk-ai-chat-files",
		external_id: seeded.userId,
		email: "ai-chat-files@test.local",
	});
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: seeded.membershipId,
		clientGeneratedId: "client_ai_chat_files",
		title: "AI chat files",
		lastMessageAt: Date.now(),
	});
	expect(created._yay).toBeTruthy();
	const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		userId: seeded.userId,
		threadId: created._yay!.threadId,
		toolCallId: "scratch-test",
		commandHash: "a".repeat(64),
		shellName: "default",
	});
	if (begun._nay) throw new Error(begun._nay.message);

	return {
		t,
		asUser,
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		userId: seeded.userId,
		membershipId: seeded.membershipId,
		threadId: created._yay!.threadId as Id<"ai_chat_threads">,
		invocationId: begun._yay.invocationId,
	};
}

describe("ai_chat_files /tmp persistence", () => {
	test("patch_thread_tmp_files upserts changed paths and deletes removed paths", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				invocationId: ctxData.invocationId,
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [
					{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
					{ path: "/b.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
				],
				fileNodesContent: [
					{ path: "/a.txt", content: bytes("one") },
					{ path: "/b.txt", content: bytes("two") },
				],
				deletePaths: [],
			}),
		);

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				invocationId: ctxData.invocationId,
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now + 1 }],
				fileNodesContent: [{ path: "/a.txt", content: bytes("ONE") }],
				deletePaths: ["/b.txt"],
			}),
		);

		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: ctxData.threadId,
			}),
		);
		expect(snapshot.file_nodes.map((fileNode) => fileNode.path)).toEqual(["/a.txt"]);
		expect(
			snapshot.file_nodes.map((fileNode) => [
				fileNode.path,
				text(snapshot.file_nodes_content_dict[fileNode._id]!.bytes),
			]),
		).toEqual([["/a.txt", "ONE"]]);
	});

	test("patch_thread_tmp_files removes stale content when a file path becomes a directory", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				invocationId: ctxData.invocationId,
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/node", kind: "file", mode: 0o100644, size: 4, mtime: now }],
				fileNodesContent: [{ path: "/node", content: bytes("file") }],
				deletePaths: [],
			}),
		);

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				invocationId: ctxData.invocationId,
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/node", kind: "directory", mode: 0o40755, size: 0, mtime: now + 1 }],
				fileNodesContent: [],
				deletePaths: [],
			}),
		);

		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: ctxData.threadId,
			}),
		);
		expect(snapshot.file_nodes).toMatchObject([{ path: "/node", kind: "directory", size: 0 }]);
		expect(snapshot.file_nodes_content_dict).toEqual({});
	});

	test("patch_thread_tmp_files cannot recreate scratch after thread or workspace purge", async () => {
		for (const purge of ["thread", "workspace"] as const) {
			const f = await create_thread();
			await f.t.run(async (ctx) => {
				if (purge === "thread") await ctx.db.delete("ai_chat_threads", f.threadId);
				else await ctx.db.patch("organizations_workspaces", f.workspaceId, { pluginDataPurgeStartedAt: Date.now() });
			});
			await expect(
				f.t.mutation(internal.ai_chat_files.patch_thread_tmp_files, {
					invocationId: f.invocationId,
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					threadId: f.threadId,
					fileNodes: [{ path: "/late.txt", kind: "file", mode: 0o100644, size: 4, mtime: Date.now() }],
					fileNodesContent: [{ path: "/late.txt", content: bytes("late") }],
					deletePaths: [],
				}),
			).rejects.toThrow("no longer available");
			expect(await f.t.run((ctx) => ctx.db.query("ai_chat_files").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.query("ai_chat_files_content").collect())).toEqual([]);
		}
	});

	test("copy_thread_tmp_files copies file nodes and content to the target thread", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		const target = await ctxData.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: ctxData.membershipId,
			clientGeneratedId: "client_ai_chat_files_copy",
			title: "AI chat files copy",
			lastMessageAt: Date.now(),
		});
		expect(target._yay).toBeTruthy();
		const targetThreadId = target._yay!.threadId as Id<"ai_chat_threads">;

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				invocationId: ctxData.invocationId,
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [
					{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
					{ path: "/dir", kind: "directory", mode: 0o40755, size: 0, mtime: now },
					{ path: "/link", kind: "symlink", mode: 0o120777, size: 6, mtime: now, symlinkTargetPath: "/a.txt" },
				],
				fileNodesContent: [{ path: "/a.txt", content: bytes("one") }],
				deletePaths: [],
			}),
		);

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.copy_thread_tmp_files, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				sourceThreadId: ctxData.threadId,
				targetThreadId,
			}),
		);

		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: targetThreadId,
			}),
		);
		expect(snapshot.file_nodes).toMatchObject([
			{ path: "/a.txt", kind: "file", size: 3, mtime: now },
			{ path: "/dir", kind: "directory", size: 0 },
			{ path: "/link", kind: "symlink", size: 6, symlinkTargetPath: "/a.txt" },
		]);
		expect(
			snapshot.file_nodes.flatMap((fileNode) =>
				snapshot.file_nodes_content_dict[fileNode._id]
					? [[fileNode.path, text(snapshot.file_nodes_content_dict[fileNode._id]!.bytes)]]
					: [],
			),
		).toEqual([["/a.txt", "one"]]);
	});
});

describe("read_shell_transcript", () => {
	test("a workspace member reads the entries in order; a non-member and another thread cannot", async () => {
		const owner = await create_thread();
		const shell = await owner.t.run(async (ctx) => {
			const shellId = await ctx.db.insert("ai_chat_bash_shells", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				threadId: owner.threadId,
				name: "work",
				cwd: "~",
				cwdTarget: null,
				state: null,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
				updatedBy: owner.userId,
				updatedAt: Date.now(),
			});
			const shell = await ctx.db.get("ai_chat_bash_shells", shellId);
			if (!shell) throw new Error("Expected the shell");
			await ai_chat_files_db_append_shell_transcript(ctx, shell, "$ first");
			await ai_chat_files_db_append_shell_transcript(ctx, { ...shell, transcriptSeq: 1 }, "$ second");
			return shell;
		});
		const identity = {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: owner.userId,
			threadId: owner.threadId,
			shellId: shell._id,
		};

		expect(await owner.t.query(internal.ai_chat_files.read_shell_transcript, identity)).toEqual([
			{ seq: 0, text: "$ first" },
			{ seq: 1, text: "$ second" },
		]);

		// A user with no membership in the workspace gets the same refusal as any other door.
		const stranger = await owner.t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await expect(
			owner.t.query(internal.ai_chat_files.read_shell_transcript, { ...identity, userId: stranger.userId }),
		).rejects.toThrow("Unauthorized");

		// The shell id must belong to the named thread.
		const otherThread = await owner.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: owner.membershipId,
			clientGeneratedId: "client_ai_chat_files_other",
			title: "Other",
			lastMessageAt: Date.now(),
		});
		if (otherThread._nay) throw new Error(otherThread._nay.message);
		await expect(
			owner.t.query(internal.ai_chat_files.read_shell_transcript, {
				...identity,
				threadId: otherThread._yay.threadId,
			}),
		).rejects.toThrow("Not found");
	});
});

describe("ai_chat_files_db_append_shell_transcript", () => {
	async function seed_shell() {
		const owner = await create_thread();
		const shellId = await owner.t.run((ctx) =>
			ctx.db.insert("ai_chat_bash_shells", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				threadId: owner.threadId,
				name: "default",
				cwd: "~",
				cwdTarget: null,
				state: null,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
				updatedBy: owner.userId,
				updatedAt: Date.now(),
			}),
		);
		// Re-read the row before every append: the helper trusts the counters on the doc it gets.
		const append = (texts: string[]) =>
			owner.t.run(async (ctx) => {
				for (const entryText of texts) {
					const shell = await ctx.db.get("ai_chat_bash_shells", shellId);
					if (!shell) throw new Error("Expected the shell");
					await ai_chat_files_db_append_shell_transcript(ctx, shell, entryText);
				}
			});
		const read = () =>
			owner.t.run(async (ctx) => ({
				shell: await ctx.db.get("ai_chat_bash_shells", shellId),
				entries: await ctx.db
					.query("ai_chat_bash_shell_transcripts")
					.withIndex("by_shell_seq", (q) => q.eq("shellId", shellId))
					.collect(),
			}));
		return { append, read };
	}

	test("drops the oldest entries to stay under 1 MiB", async () => {
		const { append, read } = await seed_shell();
		const big = "a".repeat(300 * 1024);
		await append([big, big, big]);
		expect((await read()).entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);

		// The fourth entry pushes the total to 1200 KiB, so the oldest one goes.
		await append([big]);
		const after = await read();
		expect(after.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(after.shell).toMatchObject({ transcriptBytes: 3 * big.length, transcriptEntries: 3, transcriptSeq: 4 });
	});

	test("keeps at most 1,000 entries and drops the oldest sequence", async () => {
		const { append, read } = await seed_shell();
		await append(Array.from({ length: 1001 }, (_, i) => `$ ${i}`));
		const after = await read();
		expect(after.entries).toHaveLength(1000);
		expect(after.entries[0]).toMatchObject({ seq: 1, text: "$ 1" });
		expect(after.entries[999]).toMatchObject({ seq: 1000, text: "$ 1000" });
		expect(after.shell).toMatchObject({ transcriptEntries: 1000, transcriptSeq: 1001 });
	});

	test("counts bytes in UTF-8, not characters", async () => {
		const { append, read } = await seed_shell();
		await append(["語語語"]);
		const after = await read();
		expect(after.entries[0]).toMatchObject({ bytes: 9 });
		expect(after.shell).toMatchObject({ transcriptBytes: 9 });
	});
});
