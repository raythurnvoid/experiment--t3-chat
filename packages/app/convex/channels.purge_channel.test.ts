import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import type { FunctionArgs } from "convex/server";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { channels_db_purge_channel_batch } from "./channels.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";

// Fake timers keep the scheduled job rows, so the test sees every row the purge must delete.
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: "https://upload.test/object",
	}));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const CHANNEL_TABLES = [
	"channels_activity",
	"channels_members",
	"channels_read_states",
	"channels_messages",
	"channels_threads",
	"channels_thread_followers",
	"channels_reactions",
	"channels_inbox",
	"channels_uploads",
	"channels_sidebar_jobs",
	"channels_thread_jobs",
	"channels_inbox_jobs",
] as const;

describe("channels_db_purge_channel_batch", () => {
	test("small batches delete one file channel with its upload and keep the other channel", async () => {
		const t = test_convex();
		const f = await t.run(async (ctx) => {
			const owner = await test_mocks_fill_db_with.membership(ctx);
			await ctx.db.patch("users", owner.userId, { clerkUserId: "purge-owner" });
			const memberUserId = await ctx.db.insert("users", { clerkUserId: "purge-member" });
			const memberMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: memberUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: memberUserId,
				role: "member",
				now: Date.now(),
			});
			return {
				...owner,
				owner: { userId: owner.userId, membershipId: owner.membershipId },
				member: { userId: memberUserId, membershipId: memberMembershipId },
			};
		});
		const as = (person: typeof f.owner) =>
			t.withIdentity({ issuer: "https://clerk.test", external_id: person.userId, name: "Purge test" });
		const send = async (
			person: typeof f.owner,
			target: FunctionArgs<typeof api.channels_messages.send_message>["target"],
			mentionUserIds: Array<Id<"users">> = [],
		) => {
			const result = await as(person).mutation(api.channels_messages.send_message, {
				membershipId: person.membershipId,
				target,
				clientMessageId: crypto.randomUUID(),
				body: "Hello **team**",
				mentionUserIds,
				fileMentionIds: [],
				fileQuotes: [],
				replyTo: null,
				attachments: [],
				alsoInChannel: false,
				title: null,
			});
			expect(result._nay).toBeUndefined();
			return result._yay!;
		};
		const react = async (person: typeof f.owner, messageId: Id<"channels_messages">, emoji: string) => {
			const result = await as(person).mutation(api.channels_messages.toggle_reaction, {
				membershipId: person.membershipId,
				messageId,
				emoji,
			});
			expect(result._nay).toBeUndefined();
		};
		const [fileNodeId, otherFileNodeId] = await test_run_with_flush(t, (ctx) =>
			Promise.all(
				["plan.md", "notes.md"].map((name) =>
					ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: f.organizationId,
						workspaceId: f.workspaceId,
						kind: "file",
						name,
						path: `/${name}`,
						treePath: `/${name}`,
						textKind: "rich_text",
						createdBy: f.userId,
						updatedBy: f.userId,
					}),
				),
			),
		);

		// The purged channel: two threads, replies, reactions, a mention and an upload.
		const root = await send(f.owner, { kind: "file_comment", fileNodeId: fileNodeId!, anchorExcerpt: null }, [
			f.member.userId,
		]);
		await send(f.member, { kind: "thread", rootMessageId: root.rootMessageId });
		await send(f.member, { kind: "thread", rootMessageId: root.rootMessageId });
		await send(f.member, { kind: "file_comment", fileNodeId: fileNodeId!, anchorExcerpt: null });
		await react(f.owner, root.messageId, "👍");
		await react(f.member, root.messageId, "👍");
		await react(f.member, root.messageId, "🎉");
		const target = await as(f.owner).mutation(api.channels_uploads.create_upload_target, {
			membershipId: f.owner.membershipId,
			target: { kind: "file", fileNodeId: fileNodeId! },
			name: "report.txt",
			contentType: "text/plain",
			size: 8,
		});
		expect(target._nay).toBeUndefined();

		// The kept channel in the same workspace.
		await send(f.member, { kind: "file_comment", fileNodeId: otherFileNodeId!, anchorExcerpt: null });

		const [channelId, otherChannelId] = await t.run((ctx) =>
			Promise.all(
				[fileNodeId!, otherFileNodeId!].map(async (nodeId) => {
					const channel = await ctx.db
						.query("channels")
						.withIndex("by_organization_workspace_fileNode", (q) =>
							q.eq("organizationId", f.organizationId).eq("workspaceId", f.workspaceId).eq("fileNodeId", nodeId),
						)
						.unique();
					return channel!._id;
				}),
			),
		);
		const upload = (await t.run((ctx) => ctx.db.get("channels_uploads", target._yay!.uploadId)))!;
		const key = r2_create_asset_key(upload);

		const channel_rows = (id: Id<"channels">) =>
			t.run(async (ctx) => {
				const rows: Record<string, unknown[]> = {
					channels: (await ctx.db.query("channels").collect()).filter((row) => row._id === id),
				};
				for (const table of CHANNEL_TABLES) {
					rows[table] = (await ctx.db.query(table).collect()).filter((row) => row.channelId === id);
				}
				const messageIds = new Set(
					(await ctx.db.query("channels_messages").collect())
						.filter((row) => row.channelId === id)
						.map((row) => row._id),
				);
				rows.channels_reaction_counts = (await ctx.db.query("channels_reaction_counts").collect()).filter((row) =>
					messageIds.has(row.messageId),
				);
				return rows;
			});

		const before = await channel_rows(channelId!);
		expect(before.channels_messages, "the fixture must hold more messages than one batch").toHaveLength(4);
		expect(before.channels_threads).toHaveLength(2);
		expect(before.channels_reactions).toHaveLength(3);
		expect(before.channels_reaction_counts).toHaveLength(2);
		expect(before.channels_inbox!.length, "the fixture must hold an unread source").toBeGreaterThan(0);
		expect(before.channels_uploads).toHaveLength(1);
		const otherBefore = await channel_rows(otherChannelId!);

		let calls = 0;
		for (;;) {
			calls += 1;
			if (calls > 50) throw new Error("Channel purge did not finish");
			const result = await t.run(async (ctx) =>
				channels_db_purge_channel_batch(ctx, {
					channel: (await ctx.db.get("channels", channelId!))!,
					batchSize: 2,
				}),
			);
			if (result.done) break;
		}
		expect(calls, "a small batch must need several calls").toBeGreaterThan(5);

		const after = await channel_rows(channelId!);
		expect(after, "every row of the purged channel must be gone").toEqual(
			Object.fromEntries(Object.keys(after).map((table) => [table, []])),
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", upload.assetId), "the upload asset must be deleted").toBeNull();
			const job = await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", key))
				.unique();
			expect(job?.reason, "the upload's R2 file must be queued for deletion").toBe("permanent_delete");
		});
		expect(await channel_rows(otherChannelId!), "the other channel must keep every row").toEqual(otherBefore);
	});
});
