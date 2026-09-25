import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: seeded.userId,
		membershipId: seeded.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		userId: seeded.userId,
		threadId: created._yay!.threadId,
		membershipId: seeded.membershipId,
		membershipLifetime: captured._yay.membershipLifetime,
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
		membershipLifetime: captured._yay.membershipLifetime,
		invocationId: begun._yay.invocationId,
	};
}

async function create_team_thread() {
	const t = test_convex();
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "runtime-team", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const members = [];
	for (const role of ["member", "admin"] as const) {
		const personal = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: personal.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await asOwner.mutation(api.access_control.set_user_role, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: personal.userId,
				role,
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", personal.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected invited membership");
		members.push({ ...owner, userId: personal.userId, membershipId: membership._id });
	}
	const creator = members[0]!;
	const admin = members[1]!;
	const asCreator = t.withIdentity({ issuer: "https://clerk.test", external_id: creator.userId });
	const created = await asCreator.mutation(api.ai_chat.thread_create, {
		membershipId: creator.membershipId,
		clientGeneratedId: "private-runtime",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const scope = {
		organizationId: creator.organizationId,
		workspaceId: creator.workspaceId,
		userId: creator.userId,
		threadId: created._yay.threadId,
	};
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: creator.userId,
		membershipId: creator.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const beginArgs = {
		...scope,
		membershipId: creator.membershipId,
		membershipLifetime: captured._yay.membershipLifetime,
		toolCallId: "private-runtime-call",
		commandHash: "a".repeat(64),
		shellName: "default",
	};
	const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, beginArgs);
	if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a new shell");
	return { t, owner, creator, admin, asCreator, asOwner, scope, beginArgs, invocation: begun._yay };
}

async function start_job(f: Awaited<ReturnType<typeof create_team_thread>>) {
	const started = await f.t.mutation(internal.ai_chat_files.start_bash_job, {
		parentInvocationId: f.invocation.invocationId,
		commandNumber: 0,
		shellId: f.invocation.shell._id,
		script: "echo private",
		startCwd: "~",
		startCwdTarget: null,
		allowDbFilesMkdir: false,
		shellState: {
			env: [],
			arrays: [],
			options: {},
			shoptOptions: {},
			readonlyVars: [],
			associativeArrays: [],
			namerefs: [],
			boundNamerefs: [],
			invalidNamerefs: [],
			integerVars: [],
			lowercaseVars: [],
			uppercaseVars: [],
			exportedVars: [],
			declaredVars: [],
			functions: [],
			previousDir: "/",
			directoryStack: [],
			lastExitCode: 0,
			lastArg: "",
			openFileDescriptors: [],
		},
	});
	if (started._nay) throw new Error(started._nay.message);
	const invocation = await f.t.run((ctx) =>
		ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) =>
				q.eq("threadId", f.scope.threadId).eq("toolCallId", `job:${f.invocation.invocationId}:0`),
			)
			.first(),
	);
	if (!invocation?.job) throw new Error("Expected a job");
	return { ...invocation, job: invocation.job };
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
				invocationId: ctxData.invocationId,
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
				invocationId: ctxData.invocationId,
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
				userId: ctxData.userId,
				sourceThreadId: ctxData.threadId,
				targetThreadId,
			}),
		);

		const targetCall = await ctxData.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			organizationId: ctxData.organizationId,
			workspaceId: ctxData.workspaceId,
			userId: ctxData.userId,
			threadId: targetThreadId,
			membershipId: ctxData.membershipId,
			membershipLifetime: ctxData.membershipLifetime,
			toolCallId: "target-scratch",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (targetCall._nay) throw new Error(targetCall._nay.message);
		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: targetThreadId,
				invocationId: targetCall._yay.invocationId,
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
	test("the creator reads the entries in order; a non-member and another thread cannot", async () => {
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

describe("ai_chat_files creator privacy", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	test.each(["owner", "admin"] as const)("the organization %s cannot open another creator's shell", async (role) => {
		const f = await create_team_thread();
		const before = await f.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect());
		const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: f[role].userId,
			membershipId: f[role].membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const refused = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.beginArgs,
			userId: f[role].userId,
			membershipId: f[role].membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "another-user-call",
			shellName: "another-shell",
		});
		expect(refused).toEqual({ _nay: { message: "Unauthorized" } });
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect())).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_bash_shells").collect())).toHaveLength(1);
	});

	test.each(["owner", "admin"] as const)(
		"the organization %s cannot read another creator's transcript",
		async (role) => {
			const f = await create_team_thread();
			await f.t.mutation(internal.ai_chat.save_shell, {
				...f.scope,
				invocationId: f.invocation.invocationId,
				shellId: f.invocation.shell._id,
				cwd: "~",
				cwdTarget: null,
				transcriptEntry: "private command output",
			});
			expect(
				await f.t.query(internal.ai_chat_files.read_shell_transcript, {
					...f.scope,
					shellId: f.invocation.shell._id,
				}),
			).toEqual([{ seq: 0, text: "private command output" }]);
			await expect(
				f.t.query(internal.ai_chat_files.read_shell_transcript, {
					...f.scope,
					userId: f[role].userId,
					shellId: f.invocation.shell._id,
				}),
			).rejects.toThrow("Unauthorized");
		},
	);

	test("scratch reads bind the requested thread to the claimed call", async () => {
		const f = await create_team_thread();
		const otherThread = await f.asOwner.mutation(api.ai_chat.thread_create, {
			membershipId: f.owner.membershipId,
			clientGeneratedId: "owner-runtime",
			lastMessageAt: Date.now(),
		});
		if (otherThread._nay) throw new Error(otherThread._nay.message);
		await expect(
			f.t.query(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: otherThread._yay.threadId,
				invocationId: f.invocation.invocationId,
			}),
		).rejects.toThrow("Unauthorized");
	});

	test.each(["source", "target"] as const)(
		"scratch copy refuses another creator's %s thread before writes",
		async (side) => {
			const f = await create_team_thread();
			const otherThread = await f.asOwner.mutation(api.ai_chat.thread_create, {
				membershipId: f.owner.membershipId,
				clientGeneratedId: "copy-owner-runtime",
				lastMessageAt: Date.now(),
			});
			if (otherThread._nay) throw new Error(otherThread._nay.message);
			await f.t.mutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				threadId: f.scope.threadId,
				invocationId: f.invocation.invocationId,
				fileNodes: [{ path: "/private.txt", kind: "file", mode: 0o100644, size: 7, mtime: Date.now() }],
				fileNodesContent: [{ path: "/private.txt", content: bytes("private") }],
				deletePaths: [],
			});
			await expect(
				f.t.mutation(internal.ai_chat_files.copy_thread_tmp_files, {
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					userId: side === "source" ? f.owner.userId : f.creator.userId,
					sourceThreadId: f.scope.threadId,
					targetThreadId: otherThread._yay.threadId,
				}),
			).rejects.toThrow("Unauthorized");
			expect(
				await f.t.run((ctx) =>
					ctx.db
						.query("ai_chat_files")
						.withIndex("by_thread_path", (q) => q.eq("threadId", otherThread._yay.threadId))
						.collect(),
				),
			).toEqual([]);
		},
	);

	test("file output cannot use another creator's thread", async () => {
		const f = await create_team_thread();
		const prepared = await f.t.mutation(internal.ai_chat_files.prepare_file_output, {
			...f.scope,
			agentSource: {
				...f.scope,
				membershipId: f.owner.membershipId,
				userId: f.owner.userId,
				membershipLifetime: f.beginArgs.membershipLifetime,
			},
			membershipId: f.owner.membershipId,
			userId: f.owner.userId,
			modeId: "agent",
			requestId: "private-thread-output",
			attemptId: "first",
			path: "/private.txt",
			contentType: "text/plain;charset=utf-8",
			size: 7,
			digest: "a".repeat(64),
			content: { kind: "text", textKind: "plain_text" },
		});
		expect(prepared).toEqual({ _nay: { message: "Chat is no longer available" } });
		expect(await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
	});

	test("an old call cannot load or patch scratch after membership is removed and restored", async () => {
		const f = await create_team_thread();
		// The fixture used both invite tokens; allow the next invite without running queued jobs.
		vi.setSystemTime(Date.now() + 5000);
		expect(
			await f.asCreator.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.scope.organizationId,
				userIdToRemove: f.creator.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userIdToAdd: f.creator.userId,
			}),
		).toEqual({ _yay: null });
		await expect(
			f.t.query(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: f.scope.threadId,
				invocationId: f.invocation.invocationId,
			}),
		).rejects.toThrow("Unauthorized");
		await expect(
			f.t.mutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				threadId: f.scope.threadId,
				invocationId: f.invocation.invocationId,
				fileNodes: [],
				fileNodesContent: [],
				deletePaths: [],
			}),
		).rejects.toThrow("no longer available");
		const rejoined = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.scope.workspaceId).eq("userId", f.creator.userId).eq("active", true),
				)
				.unique(),
		);
		if (!rejoined) throw new Error("Expected rejoined membership");
		const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: f.creator.userId,
			membershipId: rejoined._id,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const fresh = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.beginArgs,
			membershipId: rejoined._id,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "new-lifetime-call",
		});
		if (fresh._nay) throw new Error(fresh._nay.message);
		expect(
			await f.t.query(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: f.scope.threadId,
				invocationId: fresh._yay.invocationId,
			}),
		).toEqual({ file_nodes: [], file_nodes_content_dict: {} });
	});

	test("only the creator can read and control the thread's jobs", async () => {
		const f = await create_team_thread();
		const job = await start_job(f);
		expect(
			await f.t.query(internal.ai_chat_files.list_thread_jobs, {
				...f.scope,
				select: { kind: "live" },
			}),
		).toMatchObject([{ jobNumber: 1, scriptPreview: "echo private" }]);
		expect(
			await f.asCreator.query(api.ai_chat_files.list_live_thread_jobs, {
				membershipId: f.creator.membershipId,
				threadId: f.scope.threadId,
			}),
		).toHaveLength(1);
		for (const other of [f.owner, f.admin]) {
			const scope = { ...f.scope, userId: other.userId };
			await expect(
				f.t.query(internal.ai_chat_files.list_thread_jobs, {
					...scope,
					select: { kind: "live" },
				}),
			).rejects.toThrow("Unauthorized");
			await expect(f.t.query(internal.ai_chat_files.read_job_output, { ...scope, jobNumber: 1 })).rejects.toThrow(
				"Unauthorized",
			);
			await expect(
				f.t.query(internal.ai_chat_files.read_job_exit_codes, {
					...scope,
					jobNumbers: [1],
				}),
			).rejects.toThrow("Unauthorized");
			expect(
				await f.t.mutation(internal.ai_chat_files.arm_bash_job_wakeup, {
					...scope,
					jobNumbers: [1],
					modelId: "gpt-6-luna",
				}),
			).toEqual([]);
			expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...scope, jobNumber: 1 })).toBe(false);
			expect(
				await f.t
					.withIdentity({ issuer: "https://clerk.test", external_id: other.userId })
					.query(api.ai_chat_files.list_live_thread_jobs, {
						membershipId: other.membershipId,
						threadId: f.scope.threadId,
					}),
			).toEqual([]);
		}
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job._id })).toMatchObject({
			authorized: true,
			stopRequested: false,
		});
	});

	test("losing content.read hides scratch, transcripts, and jobs but keeps requester Activity Stop", async () => {
		const f = await create_team_thread();
		const job = await start_job(f);
		const role = await f.asOwner.mutation(api.access_control.create_role, {
			organizationId: f.scope.organizationId,
			name: "Write only",
			description: "",
			permissions: ["content.write"],
		});
		if (role._nay) throw new Error(role._nay.message);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userId: f.creator.userId,
				role: role._yay.roleId,
			}),
		).toEqual({ _yay: null });
		await expect(
			f.t.query(internal.ai_chat_files.read_shell_transcript, {
				...f.scope,
				shellId: f.invocation.shell._id,
			}),
		).rejects.toThrow("Permission denied");
		await expect(f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).rejects.toThrow(
			"Permission denied",
		);
		await expect(
			f.t.query(internal.ai_chat_files.load_thread_tmp_files, {
				threadId: f.scope.threadId,
				invocationId: f.invocation.invocationId,
			}),
		).rejects.toThrow("Unauthorized");
		const { shellName: _shellName, ...identity } = f.beginArgs;
		expect(await f.t.query(internal.ai_chat_files.get_bash_invocation, identity)).toEqual({
			_nay: { message: "Unauthorized" },
		});
		expect(await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs)).toEqual({
			_nay: { message: "Unauthorized" },
		});
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job._id })).toMatchObject({
			authorized: false,
		});
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", job._id))
				.first(),
		);
		if (!activity) throw new Error("Expected the job Activity");
		expect(
			await f.asCreator.mutation(api.activities.request_stop, {
				membershipId: f.creator.membershipId,
				activityId: activity._id,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job._id })).toMatchObject({
			authorized: false,
			stopRequested: true,
		});
	});

	test("a removed and restored membership cannot queue another run of an old job", async () => {
		const f = await create_team_thread();
		const job = await start_job(f);
		expect(
			await f.t.mutation(internal.ai_chat_files.claim_bash_job, {
				invocationId: job._id,
				workerGeneration: job.job.workerGeneration,
			}),
		).not.toBeNull();
		// The fixture used both invite tokens; allow the next invite without running queued jobs.
		vi.setSystemTime(Date.now() + 5000);
		expect(
			await f.asCreator.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.scope.organizationId,
				userIdToRemove: f.creator.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userIdToAdd: f.creator.userId,
			}),
		).toEqual({ _yay: null });
		if (!job.job.shellState) throw new Error("Expected job shell state");
		expect(
			await f.t.mutation(internal.ai_chat_files.pause_bash_job, {
				invocationId: job._id,
				workId: job.job.workId!,
				resume: {
					script: "echo later",
					commandNumber: 1,
					launchedJobNumbers: [],
					shellState: job.job.shellState,
					cwd: "~",
					cwdTarget: null,
				},
				liveOutput: null,
				outcome: { exitCode: 0, stdout: "", stderr: "" },
				reason: "sleep",
				runAfterMs: 5000,
			}),
		).toBe(false);
		expect((await f.t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", job._id)))?.job?.workId).toBe(job.job.workId);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", job._id))
					.first(),
			),
		).toMatchObject({ status: "canceled" });
		expect(
			await f.t.mutation(internal.ai_chat_files.claim_bash_job, {
				invocationId: job._id,
				workerGeneration: job.job.workerGeneration,
			}),
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect())).toEqual([]);
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
