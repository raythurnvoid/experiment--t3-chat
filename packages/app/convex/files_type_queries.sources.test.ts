import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

test("a type search cannot continue after its GitHub commit leaves the mounted view", async () => {
	const t = test_convex();
	const member = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: member.membershipId,
		clientGeneratedId: "source-search",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: member.userId,
		membershipId: member.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const mountId = await t.run((ctx) =>
		ctx.db.insert("github_mounts", {
			name: "repo",
			owner: "owner",
			repo: "repo",
			ref: "main",
			defaultBranch: "main",
			lastCommitSha: "first",
			lastTreeSha: "tree",
			lastSyncedAt: Date.now(),
			status: "idle",
			startedAt: null,
			producerFinishedAt: null,
			finishedAt: null,
			lastError: null,
		}),
	);
	const request = {
		organizationId: "GLOBAL" as const,
		workspaceId: "GITHUB" as const,
		userId: member.userId,
		agentSource: {
			...member,
			threadId: thread._yay.threadId,
			membershipLifetime: captured._yay.membershipLifetime,
			run: null,
		},
		overlay: false,
		rootPath: "/repo/first",
		contentType: "text/plain",
		directoriesOnly: false,
		limit: 10,
	};
	const started = await t.mutation(internal.files_type_queries.begin, request);
	if (started._nay) throw new Error(started._nay.message);
	await t.run((ctx) => ctx.db.patch("github_mounts", mountId, { lastCommitSha: "second" }));
	expect(
		await t.mutation(internal.files_type_queries.advance, {
			...request,
			...started._yay,
			token: "source-search",
			seal: false,
		}),
	).toMatchObject({ _nay: { message: "File search unavailable" } });
});
