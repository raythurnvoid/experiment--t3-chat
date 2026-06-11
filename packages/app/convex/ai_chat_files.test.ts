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
			workspaceName: "personal",
			projectName: "home",
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
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		userId: seeded.userId,
		threadId: created._yay!.threadId as Id<"ai_chat_threads">,
	};
}

describe("ai_chat_files /tmp persistence", () => {
	test("patch_thread_tmp_files upserts changed paths and deletes removed paths", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		const initial = await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.flush_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
				entries: [
					{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
					{ path: "/b.txt", kind: "file", mode: 0o100644, size: 3, mtime: now },
				],
				contents: [
					{ path: "/a.txt", bytes: bytes("one") },
					{ path: "/b.txt", bytes: bytes("two") },
				],
			}),
		);
		expect(initial._yay).toMatchObject({ pathCount: 2, totalBytes: 6 });

		const patched = await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
				upsertEntries: [{ path: "/a.txt", kind: "file", mode: 0o100644, size: 3, mtime: now + 1 }],
				upsertContents: [{ path: "/a.txt", bytes: bytes("ONE") }],
				deletePaths: ["/b.txt"],
			}),
		);

		expect(patched._yay).toMatchObject({
			pathCount: 1,
			totalBytes: 3,
			upsertedPathCount: 1,
			deletedPathCount: 1,
		});

		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
			}),
		);
		expect(snapshot.aiChatFiles.map((entry) => entry.path)).toEqual(["/a.txt"]);
		expect(
			snapshot.aiChatFiles.map((entry) => [entry.path, text(snapshot.aiChatFilesContentDict[entry._id]!.bytes)]),
		).toEqual([["/a.txt", "ONE"]]);
	});

	test("patch_thread_tmp_files removes stale content when a file path becomes a directory", async () => {
		const ctxData = await create_thread();
		const now = Date.now();

		await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.flush_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
				entries: [{ path: "/node", kind: "file", mode: 0o100644, size: 4, mtime: now }],
				contents: [{ path: "/node", bytes: bytes("file") }],
			}),
		);

		const patched = await ctxData.t.run((ctx) =>
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
				upsertEntries: [{ path: "/node", kind: "directory", mode: 0o40755, size: 0, mtime: now + 1 }],
				upsertContents: [],
				deletePaths: [],
			}),
		);

		expect(patched._yay).toMatchObject({ pathCount: 1, totalBytes: 0 });

		const snapshot = await ctxData.t.run((ctx) =>
			ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				threadId: ctxData.threadId,
			}),
		);
		expect(snapshot.aiChatFiles).toMatchObject([{ path: "/node", kind: "directory", size: 0 }]);
		expect(snapshot.aiChatFilesContentDict).toEqual({});
	});
});
