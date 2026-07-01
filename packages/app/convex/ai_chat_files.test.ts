import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
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

	return {
		t,
		asUser,
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		userId: seeded.userId,
		membershipId: seeded.membershipId,
		threadId: created._yay!.threadId as Id<"ai_chat_threads">,
	};
}

describe("ai_chat_files /tmp persistence", () => {
	test("patch_thread_tmp_files upserts changed paths and deletes removed paths", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [
					{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
					{ path: "/b.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
				],
				fileNodesContentDict: {
					"/a.txt": bytes("one"),
					"/b.txt": bytes("two"),
				},
				deletePaths: [],
			}),
		);

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now + 1 }],
				fileNodesContentDict: { "/a.txt": bytes("ONE") },
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
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/node", kind: "file", mode: 0o100644, size: 4, mtime: now }],
				fileNodesContentDict: { "/node": bytes("file") },
				deletePaths: [],
			}),
		);

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [{ path: "/node", kind: "directory", mode: 0o40755, size: 0, mtime: now + 1 }],
				fileNodesContentDict: {},
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
				organizationId: ctxData.organizationId,
				workspaceId: ctxData.workspaceId,
				threadId: ctxData.threadId,
				fileNodes: [
					{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
					{ path: "/dir", kind: "directory", mode: 0o40755, size: 0, mtime: now },
					{ path: "/link", kind: "symlink", mode: 0o120777, size: 6, mtime: now, symlinkTargetPath: "/a.txt" },
				],
				fileNodesContentDict: { "/a.txt": bytes("one") },
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
