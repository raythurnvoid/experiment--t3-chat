import { describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	test_convex,
	test_mocks,
	test_mocks_fill_db_with,
	test_mocks_cancel_pending_home_file_seeds,
} from "./setup.test.ts";
import {
	organizations_db_create,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { channels_db_ensure_file_channel, channels_db_purge_workspace_batch } from "./channels.ts";
import { file_quotes_serialize_draft } from "../shared/file-quotes.ts";
import { channels_composer_markdown_for_edit } from "../shared/channels.ts";

async function fixture() {
	const t = test_convex();
	const data = await t.run(async (ctx) => {
		const now = Date.now();
		const ownerId = await ctx.db.insert("users", { clerkUserId: "channels-owner" });
		await quotas_db_ensure(ctx, { quotaName: "extra_organizations", userId: ownerId, now });
		await test_mocks_fill_db_with.plan(ctx, { userId: ownerId, plan: "Pay As You Go" });
		await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, { userId: ownerId, now });
		const created = await organizations_db_create(ctx, {
			userId: ownerId,
			name: "channels-test",
			description: "",
			now,
		});
		if (created._nay) throw new Error(created._nay.message);
		const { organizationId, defaultWorkspaceId: workspaceId } = created._yay;
		const ownerMembership = (await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", workspaceId).eq("userId", ownerId).eq("active", true),
			)
			.unique())!;
		const people: Array<{ userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> }> = [];
		for (const role of ["member", "member", "viewer"] as const) {
			const userId = await ctx.db.insert("users", { clerkUserId: `channels-${people.length}` });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId,
				workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, { organizationId, workspaceId, userId, role, now });
			await quotas_db_ensure(ctx, { quotaName: "active_api_credentials", organizationId, workspaceId, userId, now });
			people.push({ userId, membershipId });
		}
		await test_mocks_cancel_pending_home_file_seeds(ctx);
		return {
			organizationId,
			workspaceId,
			owner: { userId: ownerId, membershipId: ownerMembership._id },
			member: people[0]!,
			other: people[1]!,
			viewer: people[2]!,
		};
	});
	const as = (person: typeof data.owner) =>
		t.withIdentity({
			issuer: "https://clerk.test",
			external_id: person.userId,
			name: "Channel test",
			email: "channels@test.local",
		});
	return { t, ...data, as };
}

async function create(f: Awaited<ReturnType<typeof fixture>>, kind: "public" | "private", person = f.member) {
	const result = await f.as(person).mutation(api.channels.create_channel, {
		membershipId: person.membershipId,
		kind,
		name: "general",
		topic: "",
		layout: "messages",
	});
	expect(result._nay).toBeUndefined();
	return result._yay!.channelId;
}

async function agent_context(f: Awaited<ReturnType<typeof fixture>>, person = f.member) {
	await f.t.run((ctx) =>
		organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
			userId: person.userId,
			now: Date.now(),
		}),
	);
	await f.t.run(test_mocks_cancel_pending_home_file_seeds);
	const thread = await f.as(person).mutation(api.ai_chat.thread_create, {
		membershipId: person.membershipId,
		clientGeneratedId: "channels-agent",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const source = await f.t.mutation(internal.ai_chat_workspaces.capture, {
		userId: person.userId,
		membershipId: person.membershipId,
	});
	if (source._nay) throw new Error(source._nay.message);
	return {
		userId: person.userId,
		membershipId: person.membershipId,
		agentSource: {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: person.userId,
			membershipId: person.membershipId,
			membershipLifetime: source._yay.membershipLifetime,
			threadId: thread._yay.threadId,
		},
	};
}

describe("get_channel", () => {
	test("bad URL ids use the same missing result", async () => {
		const f = await fixture();
		for (const id of ["bad-id", f.member.userId]) {
			expect(
				await f.as(f.member).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId: id }),
			).toBeNull();
			expect(
				await f
					.as(f.member)
					.query(api.channels_messages.get_message, { membershipId: f.member.membershipId, messageId: id }),
			).toBeNull();
			expect(
				await f
					.as(f.member)
					.query(api.channels_messages.get_thread_by_root, { membershipId: f.member.membershipId, rootMessageId: id }),
			).toBeNull();
		}
	});
	test("private access is limited to members and the owner", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		expect(
			await f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId }),
			"private non-member must not see the channel",
		).toBeNull();
		expect(
			(await f.as(f.owner).query(api.channels.get_channel, { membershipId: f.owner.membershipId, channelId }))
				?.canManage,
		).toBe(true);
		const added = await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		expect(added._nay).toBeUndefined();
		expect(
			(await f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId }))?.canPost,
		).toBe(true);
	});

	test("a re-invite does not restore a private membership", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		const newMembershipId = await f.t.run(async (ctx) => {
			await ctx.db.delete("organizations_workspaces_users", f.member.membershipId);
			return ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.member.userId,
				active: true,
				updatedAt: Date.now(),
			});
		});
		expect(
			await f.as(f.member).query(api.channels.get_channel, { membershipId: newMembershipId, channelId }),
			"re-invite must not restore private history",
		).toBeNull();
	});

	test("file access follows the live file ACL and ignores its write policy", async () => {
		const f = await fixture();
		const { channelId, fileNodeId } = await f.t.run(async (ctx) => {
			const fileNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "plan.md",
				path: "/plan.md",
				treePath: "/plan.md",
				textKind: "rich_text",
				writePolicy: { mode: "read_only" },
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			});
			const channel = await channels_db_ensure_file_channel(ctx, {
				membership: (await ctx.db.get("organizations_workspaces_users", f.owner.membershipId))!,
				userId: f.owner.userId,
				fileNodeId,
			});
			return { fileNodeId, channelId: channel._id };
		});
		expect(
			(await f.as(f.member).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId }))
				?.canPost,
		).toBe(true);
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		expect(
			await f.as(f.member).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId }),
			"lost file access must hide its channel",
		).toBeNull();
	});

	test("a viewer can read public channels but cannot post or create", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const channel = await f
			.as(f.viewer)
			.query(api.channels.get_channel, { membershipId: f.viewer.membershipId, channelId });
		expect(channel?.canPost).toBe(false);
		expect(channel?.postRefusal).toBe("You have view-only access");
		const created = await f.as(f.viewer).mutation(api.channels.create_channel, {
			membershipId: f.viewer.membershipId,
			kind: "public",
			name: "viewer",
			topic: "",
			layout: "messages",
		});
		expect(created._nay).toBeDefined();
	});

	test("tombstoned users and foreign memberships do not reveal a channel", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		expect(
			await f.as(f.other).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId }),
		).toBeNull();
		await f.t.run((ctx) => ctx.db.patch("users", f.other.userId, { deletedAt: Date.now() }));
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.other.membershipId, { active: false }));
		await expect(
			f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId }),
		).rejects.toThrow("Unauthenticated");
	});
});

describe("open_direct_channel", () => {
	test("includes the caller, keeps a group open after departure, and restores the same membership", async () => {
		const f = await fixture();
		const opened = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.other.userId, f.owner.userId],
		});
		const channelId = opened._yay!.channelId;
		const channel = await f.t.run((ctx) => ctx.db.get("channels", channelId));
		expect(channel?.kind === "direct" && channel.participantUserIds.includes(f.member.userId)).toBe(true);
		await f.t.run(async (ctx) => {
			await ctx.db.patch("users", f.other.userId, { deletedAt: Date.now() });
			await ctx.db.patch("organizations_workspaces_users", f.other.membershipId, { active: false });
		});
		expect((await send(f, f.member, { kind: "channel", channelId }))._nay).toBeUndefined();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("users", f.other.userId, { deletedAt: undefined });
			await ctx.db.patch("organizations_workspaces_users", f.other.membershipId, { active: true });
		});
		const restored = await f.as(f.other).mutation(api.channels.open_direct_channel, {
			membershipId: f.other.membershipId,
			otherUserIds: [f.member.userId, f.owner.userId],
		});
		expect(restored._yay?.channelId).toBe(channelId);
		expect(
			(await f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId }))?.canPost,
		).toBe(true);
	});
	test("participants share one channel and the owner reads without posting", async () => {
		const f = await fixture();
		const first = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.other.userId],
		});
		const second = await f.as(f.other).mutation(api.channels.open_direct_channel, {
			membershipId: f.other.membershipId,
			otherUserIds: [f.member.userId],
		});
		expect(first._yay?.channelId).toBe(second._yay?.channelId);
		const channelId = first._yay!.channelId;
		expect(
			await f.as(f.viewer).query(api.channels.get_channel, { membershipId: f.viewer.membershipId, channelId }),
			"direct non-participant must not see the channel",
		).toBeNull();
		expect(
			(await f.as(f.owner).query(api.channels.get_channel, { membershipId: f.owner.membershipId, channelId }))?.canPost,
		).toBe(false);
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.other.membershipId, { active: false }));
		expect(
			(await f.as(f.member).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId }))
				?.postRefusal,
		).toBe("This conversation ended");
	});

	test("a re-invite creates a new conversation", async () => {
		const f = await fixture();
		const old = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.other.userId],
		});
		const membershipId = await f.t.run(async (ctx) => {
			await ctx.db.delete("organizations_workspaces_users", f.other.membershipId);
			return ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.other.userId,
				active: true,
				updatedAt: Date.now(),
			});
		});
		expect(
			await f.as(f.other).query(api.channels.get_channel, { membershipId, channelId: old._yay!.channelId }),
			"re-invite must not restore direct history",
		).toBeNull();
		const next = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.other.userId],
		});
		expect(next._yay?.channelId).not.toBe(old._yay?.channelId);
	});
});

describe("create_channel", () => {
	test("public names are unique and do not depend on hidden private names", async () => {
		const f = await fixture();
		await create(f, "private");
		await create(f, "private");
		await create(f, "public", f.other);
		const duplicate = await f.as(f.other).mutation(api.channels.create_channel, {
			membershipId: f.other.membershipId,
			kind: "public",
			name: "General",
			topic: "",
			layout: "messages",
		});
		expect(duplicate._nay?.message).toBe("Channel name is already used");
	});
});

describe("get_message", () => {
	test("neutral mentions use live names and inline quotes use their visible text", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const profileId = await f.t.run(async (ctx) => {
			const id = await ctx.db.insert("users_anagraphics", {
				userId: f.other.userId,
				displayName: "Nina",
				email: "",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", f.other.userId, { anagraphic: id });
			return id;
		});
		const root = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ body: 'Hello [@ id="user:0"]', mentionUserIds: [f.other.userId] },
		);
		const messageId = root._yay!.messageId;
		const read = () =>
			f.as(f.member).query(api.channels_messages.get_message, { membershipId: f.member.membershipId, messageId });
		expect((await read())?.mentionNames).toEqual(["Nina"]);
		const reply = await send(f, f.member, { kind: "channel", channelId }, { replyTo: { messageId, quote: "@Nina" } });
		expect(reply._nay, "visible mention text must be accepted as an inline quote").toBeUndefined();
		await f.t.run((ctx) => ctx.db.patch("users_anagraphics", profileId, { displayName: "New name" }));
		expect((await read())?.mentionNames, "stored mention text must use the current name").toEqual(["New name"]);
	});
});

describe("get_thread_state", () => {
	test("read positions count thread replies and lost private access hides the state", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		const sent = await send(f, f.member, { kind: "channel", channelId });
		const rootMessageId = sent._yay!.messageId;
		await send(f, f.member, { kind: "thread", rootMessageId });
		const read = () =>
			f
				.as(f.other)
				.query(api.channels_messages.get_thread_state, { membershipId: f.other.membershipId, rootMessageId });
		expect((await read())?.unreadCount).toBe(1);
		await f.as(f.other).mutation(api.channels_messages.mark_thread_read, {
			membershipId: f.other.membershipId,
			rootMessageId,
			replySequence: 1,
		});
		expect((await read())?.unreadCount).toBe(0);
		await f.as(f.member).mutation(api.channels.remove_channel_member, {
			membershipId: f.member.membershipId,
			channelId,
			userId: f.other.userId,
		});
		expect(await read(), "lost private access must hide thread state").toBeNull();
	});
});

describe("archive_channel", () => {
	test("admin manages public channels, has no private access, and archiving keeps history readable", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const assignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", f.organizationId).eq("workspaceId", f.workspaceId).eq("userId", f.other.userId),
				)
				.unique();
			await ctx.db.patch("access_control_role_assignments", assignment!._id, { role: "admin" });
		});
		const privateId = await create(f, "private");
		expect(
			await f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId: privateId }),
		).toBeNull();
		const channelId = await create(f, "public");
		const posted = await send(f, f.member, { kind: "channel", channelId });
		expect(
			(await f.as(f.other).query(api.channels.get_channel, { membershipId: f.other.membershipId, channelId }))
				?.canManage,
		).toBe(true);
		const archived = await f
			.as(f.other)
			.mutation(api.channels.archive_channel, { membershipId: f.other.membershipId, channelId });
		expect(archived._nay).toBeUndefined();
		expect((await send(f, f.member, { kind: "channel", channelId }))._nay?.message).toBe("This channel is archived");
		expect(
			await f.as(f.viewer).query(api.channels_messages.get_message, {
				membershipId: f.viewer.membershipId,
				messageId: posted._yay!.messageId,
			}),
		).not.toBeNull();
	});
});

describe("mark_read", () => {
	test("own send reads the main stream, forward marks cannot move back or past its end", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		await send(f, f.member, { kind: "channel", channelId });
		await send(f, f.member, { kind: "channel", channelId });
		const state = () =>
			f.as(f.member).query(api.channels.get_channel_state, { membershipId: f.member.membershipId, channelId });
		expect((await state())?.readSequence).toBe(2);
		await f
			.as(f.member)
			.mutation(api.channels.mark_read, { membershipId: f.member.membershipId, channelId, sequence: 0 });
		expect((await state())?.readSequence).toBe(2);
		await f
			.as(f.member)
			.mutation(api.channels.mark_read, { membershipId: f.member.membershipId, channelId, sequence: 999 });
		expect((await state())?.readSequence).toBe(2);
	});
});

describe("remove_user_from_organization", () => {
	test("removal without file grants drains channels before deleting the membership", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		const removed = await f.as(f.owner).mutation(api.organizations.remove_user_from_organization, {
			organizationId: f.organizationId,
			userIdToRemove: f.member.userId,
		});
		expect(removed._nay).toBeUndefined();
		expect(
			await f.as(f.member).query(api.channels.get_channel, { membershipId: f.member.membershipId, channelId }),
		).toBeNull();
		for (let i = 0; i < 4; i++)
			await f.t.mutation(internal.organizations.continue_remove_user_from_organization, {
				organizationId: f.organizationId,
				userId: f.member.userId,
			});
		const state = await f.t.run(async (ctx) => ({
			members: await ctx.db
				.query("channels_members")
				.withIndex("by_user", (q) => q.eq("userId", f.member.userId))
				.collect(),
			reads: await ctx.db
				.query("channels_read_states")
				.withIndex("by_user", (q) => q.eq("userId", f.member.userId))
				.collect(),
			membership: await ctx.db.get("organizations_workspaces_users", f.member.membershipId),
			activity: await ctx.db
				.query("channels_activity")
				.withIndex("by_channel", (q) => q.eq("channelId", channelId))
				.unique(),
		}));
		expect(state.members).toHaveLength(0);
		expect(state.reads).toHaveLength(0);
		expect(state.membership).toBeNull();
		expect(state.activity?.memberCount).toBe(0);
	});
});

async function send(
	f: Awaited<ReturnType<typeof fixture>>,
	person: typeof f.member,
	target: FunctionArgs<typeof api.channels_messages.send_message>["target"],
	changes: Partial<FunctionArgs<typeof api.channels_messages.send_message>> = {},
) {
	return f.as(person).mutation(api.channels_messages.send_message, {
		membershipId: person.membershipId,
		target,
		clientMessageId: crypto.randomUUID(),
		body: "Hello **team**",
		mentionUserIds: [],
		fileMentionIds: [],
		fileQuotes: [],
		replyTo: null,
		attachments: [],
		alsoInChannel: false,
		title: null,
		...changes,
	});
}

describe("get_mentionable_users", () => {
	test("private candidates use the same access rules as send", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		const args = {
			membershipId: f.member.membershipId,
			target: { channelId },
			userIds: [f.member.userId, f.other.userId],
		};
		expect(
			await f.as(f.member).query(api.channels_messages.get_mentionable_users, args),
			"private suggestions must hide people outside the channel",
		).toEqual([f.member.userId]);
		expect(
			await f
				.as(f.other)
				.query(api.channels_messages.get_mentionable_users, { ...args, membershipId: f.other.membershipId }),
			"a non-reader must not learn candidates",
		).toEqual([]);
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		expect(await f.as(f.member).query(api.channels_messages.get_mentionable_users, args)).toEqual(args.userIds);
		expect(
			await f.as(f.member).query(api.channels_messages.get_mentionable_users, {
				...args,
				userIds: Array.from({ length: 51 }, () => f.member.userId),
			}),
		).toEqual([]);
	});
	test("file candidates require current file read access before a channel exists", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "mentions.md",
				path: "/mentions.md",
				treePath: "/mentions.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		const args = {
			membershipId: f.member.membershipId,
			target: { fileNodeId },
			userIds: [f.member.userId, f.other.userId],
		};
		expect(await f.as(f.member).query(api.channels_messages.get_mentionable_users, args)).toEqual(args.userIds);
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		expect(
			await f.as(f.owner).query(api.channels_messages.get_mentionable_users, {
				...args,
				membershipId: f.owner.membershipId,
				userIds: [f.owner.userId, f.other.userId],
			}),
			"file suggestions must hide a person without file access",
		).toEqual([f.owner.userId]);
		expect(
			await f.as(f.member).query(api.channels_messages.get_mentionable_users, args),
			"a hidden file must not reveal candidates",
		).toEqual([]);
	});
});

describe("send_message", () => {
	test("private mentions are refused before any message write", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		const refused = await send(f, f.member, { kind: "channel", channelId }, { mentionUserIds: [f.other.userId] });
		expect(refused._nay?.message, "mention must refuse a person without private channel access").toContain(
			"cannot see this channel",
		);
		expect(
			(
				await f
					.as(f.member)
					.query(api.channels_messages.list_latest_main, { membershipId: f.member.membershipId, channelId })
			).messages,
			"a refused mention must not save a message",
		).toHaveLength(0);
		const added = await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		expect(added._nay).toBeUndefined();
		const posted = await send(f, f.member, { kind: "channel", channelId }, { mentionUserIds: [f.other.userId] });
		expect(posted._nay).toBeUndefined();
		expect(
			(await f.as(f.other).query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId }))
				?.mentionCount,
		).toBe(1);
	});

	test("replies have their own sequence and only broadcasts mark the main stream unread", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		await f.as(f.other).mutation(api.channels.join_channel, { membershipId: f.other.membershipId, channelId });
		const posted = await send(f, f.member, { kind: "channel", channelId });
		const rootMessageId = posted._yay!.messageId;
		await f
			.as(f.other)
			.mutation(api.channels.mark_read, { membershipId: f.other.membershipId, channelId, sequence: 1 });
		const reply = await send(f, f.member, { kind: "thread", rootMessageId });
		expect(reply._nay).toBeUndefined();
		expect(
			(await f.as(f.other).query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId }))
				?.unread,
		).toBe(false);
		const broadcast = await send(f, f.member, { kind: "thread", rootMessageId }, { alsoInChannel: true });
		expect(broadcast._nay).toBeUndefined();
		expect(
			(await f.as(f.other).query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId }))
				?.unread,
		).toBe(true);
		const thread = await f
			.as(f.other)
			.query(api.channels_messages.list_latest_thread, { membershipId: f.other.membershipId, rootMessageId });
		expect(thread.lastReplySequence).toBe(2);
		expect(thread.messages.map((item) => item.message.threadSequence)).toEqual([2, 1]);
	});

	test("a retry returns the same message without another sequence or inbox item", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const clientMessageId = crypto.randomUUID();
		const first = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ clientMessageId, mentionUserIds: [f.other.userId] },
		);
		const retry = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ clientMessageId, mentionUserIds: [f.other.userId] },
		);
		expect(retry).toEqual(first);
		const state = await f
			.as(f.member)
			.query(api.channels.get_channel_state, { membershipId: f.member.membershipId, channelId });
		expect(state?.activity.lastChannelSequence).toBe(1);
		const inbox = await f.t.run((ctx) => ctx.db.query("channels_inbox").collect());
		expect(inbox).toHaveLength(1);
	});

	test("inline quotes use plain text and are removed after the original is edited", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const original = await send(f, f.member, { kind: "channel", channelId });
		const messageId = original._yay!.messageId;
		const bad = await send(f, f.other, { kind: "channel", channelId }, { replyTo: { messageId, quote: "**team**" } });
		expect(bad._nay?.message).toContain("Quote is not part");
		const reply = await send(f, f.other, { kind: "channel", channelId }, { replyTo: { messageId, quote: "team" } });
		expect(reply._nay).toBeUndefined();
		await f.as(f.member).mutation(api.channels_messages.edit_message, {
			membershipId: f.member.membershipId,
			messageId,
			expectedRevision: 0,
			body: "New text",
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
		});
		const shaped = await f.as(f.other).query(api.channels_messages.get_message, {
			membershipId: f.other.membershipId,
			messageId: reply._yay!.messageId,
		});
		expect(shaped?.message.replyTo?.quote).toBeNull();
		expect(shaped?.replyPreview?.excerpt).toBe("New text");
	});

	test("an unconfirmed anchored comment is private until confirmation and can be discarded", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "plan.md",
				path: "/plan.md",
				treePath: "/plan.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		const sent = await send(
			f,
			f.member,
			{ kind: "file_comment", fileNodeId, anchorExcerpt: "Selected text" },
			{ mentionUserIds: [f.other.userId] },
		);
		expect(sent._nay).toBeUndefined();
		const rootMessageId = sent._yay!.rootMessageId;
		const channelId = await f.as(f.other).query(api.channels.get_file_channel, {
			membershipId: f.other.membershipId,
			fileNodeId,
		});
		if (!channelId) throw new Error("Missing file channel");
		await f.as(f.other).mutation(api.channels.join_channel, { membershipId: f.other.membershipId, channelId });
		const beforeConfirm = await f.as(f.other).query(api.channels.get_channel_state, {
			membershipId: f.other.membershipId,
			channelId,
		});
		expect(beforeConfirm?.activity.lastChannelSequence, "an unsaved anchor must not advance the visible head").toBe(0);
		await f.as(f.other).mutation(api.channels.mark_read, {
			membershipId: f.other.membershipId,
			channelId,
			sequence: beforeConfirm!.activity.lastChannelSequence,
		});
		expect(
			await f
				.as(f.other)
				.query(api.channels_messages.get_thread_by_root, { membershipId: f.other.membershipId, rootMessageId }),
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("channels_inbox").collect())).toHaveLength(0);
		const reply = await send(f, f.member, { kind: "thread", rootMessageId });
		expect(reply._nay?.message).toBe("This comment is still being added");
		await f
			.as(f.member)
			.mutation(api.channels_messages.confirm_comment_anchor, { membershipId: f.member.membershipId, rootMessageId });
		const afterConfirm = await f.as(f.other).query(api.channels.get_channel_state, {
			membershipId: f.other.membershipId,
			channelId,
		});
		expect(afterConfirm?.activity.lastChannelSequence).toBe(1);
		expect(afterConfirm?.unread, "a reader's earlier visit must not mark a newly confirmed anchor read").toBe(true);
		expect(
			(await f.as(f.member).query(api.channels.get_channel_state, { membershipId: f.member.membershipId, channelId }))
				?.readSequence,
		).toBe(1);
		expect(
			await f
				.as(f.other)
				.query(api.channels_messages.get_thread_by_root, { membershipId: f.other.membershipId, rootMessageId }),
		).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("channels_inbox").collect())).toHaveLength(1);
		await f
			.as(f.member)
			.mutation(api.channels_messages.confirm_comment_anchor, { membershipId: f.member.membershipId, rootMessageId });
		expect(await f.t.run((ctx) => ctx.db.query("channels_inbox").collect())).toHaveLength(1);
		const second = await send(f, f.member, { kind: "file_comment", fileNodeId, anchorExcerpt: "Another selection" });
		const discarded = await f.as(f.member).mutation(api.channels_messages.discard_unconfirmed_comment, {
			membershipId: f.member.membershipId,
			rootMessageId: second._yay!.rootMessageId,
		});
		expect(discarded._nay).toBeUndefined();
		expect(
			(await f.as(f.other).query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId }))
				?.activity.lastChannelSequence,
		).toBe(1);
		expect(
			await f.as(f.member).query(api.channels_messages.get_message, {
				membershipId: f.member.membershipId,
				messageId: second._yay!.messageId,
			}),
		).toBeNull();
	});
});

describe("confirm_comment_anchor", () => {
	test("removing a mention keeps the remaining person's body position", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "mentions.md",
				path: "/mentions.md",
				treePath: "/mentions.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		const sent = await send(
			f,
			f.owner,
			{ kind: "file_comment", fileNodeId, anchorExcerpt: "Selected text" },
			{ body: 'First [@ id="user:0"], second [@ id="user:1"]', mentionUserIds: [f.other.userId, f.member.userId] },
		);
		if (sent._nay) throw new Error(sent._nay.message);
		expect(
			await f.as(f.owner).mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.organizationId,
				userIdToRemove: f.other.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.as(f.owner).mutation(api.channels_messages.confirm_comment_anchor, {
				membershipId: f.owner.membershipId,
				rootMessageId: sent._yay.rootMessageId,
			}),
		).toEqual({ _yay: null });
		const confirmed = await f.as(f.member).query(api.channels_messages.get_message, {
			membershipId: f.member.membershipId,
			messageId: sent._yay.messageId,
		});
		expect(confirmed?.message.mentionUserIds).toEqual([f.member.userId]);
		expect(confirmed?.message.body, "confirmation must not move a remaining mention to another person").toBe(
			'First @Person, second [@ id="user:0"]',
		);
		expect(
			(await f.t.run((ctx) => ctx.db.query("channels_inbox").collect())).map((item) => item.recipientUserId),
		).toEqual([f.member.userId]);
	});
});

describe("edit_message", () => {
	test("edits do not notify new mentions and keep a separate reply inbox item", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const original = await send(f, f.other, { kind: "channel", channelId });
		const sent = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ mentionUserIds: [f.other.userId], replyTo: { messageId: original._yay!.messageId, quote: null } },
		);
		const messageId = sent._yay!.messageId;
		await f.as(f.member).mutation(api.channels_messages.edit_message, {
			membershipId: f.member.membershipId,
			messageId,
			expectedRevision: 0,
			body: "Changed",
			mentionUserIds: [f.viewer.userId],
			fileMentionIds: [],
			fileQuotes: [],
		});
		const inbox = await f.t.run((ctx) =>
			ctx.db
				.query("channels_inbox")
				.withIndex("by_message", (q) => q.eq("messageId", messageId))
				.collect(),
		);
		expect(inbox.map((item) => [item.recipientUserId, item.kind])).toEqual([[f.other.userId, "reply"]]);
		const stale = await f.as(f.member).mutation(api.channels_messages.edit_message, {
			membershipId: f.member.membershipId,
			messageId,
			expectedRevision: 0,
			body: "Stale",
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
		});
		expect(stale._nay?.message).toContain("Message changed");
	});
});

describe("resolve_thread", () => {
	test("general comments reuse one file channel and resolve ignores file write policy", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "policy.md",
				path: "/policy.md",
				treePath: "/policy.md",
				textKind: "rich_text",
				writePolicy: { mode: "read_only" },
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		const first = await send(f, f.member, { kind: "file_comment", fileNodeId, anchorExcerpt: null });
		const second = await send(f, f.other, { kind: "file_comment", fileNodeId, anchorExcerpt: null });
		expect(first._nay).toBeUndefined();
		expect(second._nay).toBeUndefined();
		const channels = await f.t.run((ctx) => ctx.db.query("channels").collect());
		expect(channels).toHaveLength(1);
		const resolved = await f.as(f.other).mutation(api.channels_messages.resolve_thread, {
			membershipId: f.other.membershipId,
			rootMessageId: first._yay!.rootMessageId,
		});
		expect(resolved._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("channels_messages").collect())).toHaveLength(2);
		const anchored = await send(f, f.member, { kind: "file_comment", fileNodeId, anchorExcerpt: "Text" });
		expect(anchored._nay).toBeDefined();
	});
	test("a new reply reopens the thread and a deleted root stays only while replies exist", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		await f.as(f.member).mutation(api.channels.set_channel_resolvable_threads, {
			membershipId: f.member.membershipId,
			channelId,
			resolvableThreads: true,
		});
		const posted = await send(f, f.member, { kind: "channel", channelId });
		const rootMessageId = posted._yay!.messageId;
		const resolved = await f
			.as(f.member)
			.mutation(api.channels_messages.resolve_thread, { membershipId: f.member.membershipId, rootMessageId });
		expect(resolved._nay).toBeUndefined();
		expect(
			(
				await f
					.as(f.member)
					.query(api.channels_messages.get_thread_by_root, { membershipId: f.member.membershipId, rootMessageId })
			)?.thread?.isResolved,
		).toBe(true);
		const reply = await send(f, f.other, { kind: "thread", rootMessageId });
		expect(
			(
				await f
					.as(f.member)
					.query(api.channels_messages.get_thread_by_root, { membershipId: f.member.membershipId, rootMessageId })
			)?.thread?.isResolved,
		).toBe(false);
		await f.as(f.member).mutation(api.channels_messages.delete_message, {
			membershipId: f.member.membershipId,
			messageId: rootMessageId,
		});
		expect(
			(
				await f
					.as(f.other)
					.query(api.channels_messages.get_message, { membershipId: f.other.membershipId, messageId: rootMessageId })
			)?.message.body,
		).toBe("");
		await f.as(f.other).mutation(api.channels_messages.delete_message, {
			membershipId: f.other.membershipId,
			messageId: reply._yay!.messageId,
		});
		expect(
			await f
				.as(f.other)
				.query(api.channels_messages.get_message, { membershipId: f.other.membershipId, messageId: rootMessageId }),
		).toBeNull();
	});
});

describe("delete_unconfirmed_comments", () => {
	test("the hourly cleanup removes old unconfirmed comments and keeps confirmed ones", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "anchors.md",
				path: "/anchors.md",
				treePath: "/anchors.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		vi.useFakeTimers();
		try {
			const old = await send(f, f.member, { kind: "file_comment", fileNodeId, anchorExcerpt: "Lost mark" });
			const confirmed = await send(f, f.member, { kind: "file_comment", fileNodeId, anchorExcerpt: "Saved mark" });
			await f.as(f.member).mutation(api.channels_messages.confirm_comment_anchor, {
				membershipId: f.member.membershipId,
				rootMessageId: confirmed._yay!.rootMessageId,
			});
			vi.setSystemTime(Date.now() + 61 * 60 * 1000);
			await f.t.mutation(internal.channels_messages.delete_unconfirmed_comments, {});
			expect(await f.t.run((ctx) => ctx.db.get("channels_messages", old._yay!.messageId))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("channels_messages", confirmed._yay!.messageId))).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("get_attachable_files", () => {
	test("only returns readable saved files with finished uploads in a bounded batch", async () => {
		const f = await fixture();
		const files = await f.t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "upload",
				r2Bucket: "test-files-bucket",
				size: 20,
				createdBy: f.member.userId,
				updatedAt: Date.now(),
			});
			const ids: Id<"files_nodes">[] = [];
			for (const name of ["ready.md", "upload.png", "hidden.md"]) {
				const id = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					kind: "file",
					name,
					path: `/${name}`,
					treePath: `/${name}`,
					assetId: name === "upload.png" ? assetId : null,
					createdBy: f.member.userId,
					updatedBy: f.member.userId,
				});
				ids.push(id);
			}
			await ctx.db.patch("files_nodes", ids[2]!, { restrictedScopeNodeId: ids[2]!, isRestrictedScopeRoot: true });
			return { ids, assetId };
		});
		const read = (fileNodeIds = files.ids) =>
			f.as(f.other).query(api.channels_messages.get_attachable_files, {
				membershipId: f.other.membershipId,
				fileNodeIds,
			});
		expect(await read(), "unfinished and hidden files must stay out of the picker").toEqual([files.ids[0]]);
		await f.t.run((ctx) => ctx.db.patch("files_r2_assets", files.assetId, { r2Key: "finished-object" }));
		expect(await read()).toEqual(files.ids.slice(0, 2));
		expect(await read(Array(51).fill(files.ids[0]))).toEqual([]);
	});
});

describe("message shaping", () => {
	test("lost file access removes every file id, name, and path from messages and reply previews", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "protected-notes.md",
				path: "/protected-notes.md",
				treePath: "/protected-notes.md",
				createdBy: f.member.userId,
				updatedBy: f.member.userId,
			}),
		);
		const reference = {
			body: 'See [@ id="file:0"] [file-quote id="0"]',
			fileMentionIds: [fileNodeId],
			fileQuotes: [{ fileNodeId, text: "Selected words stay visible" }],
		};
		const sent = await send(f, f.member, { kind: "channel", channelId }, reference);
		expect(sent._nay).toBeUndefined();
		const messageId = sent._yay!.messageId;
		const reply = await send(
			f,
			f.other,
			{ kind: "channel", channelId },
			{ replyTo: { messageId, quote: "@protected-notes.md" } },
		);
		expect(reply._nay).toBeUndefined();
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		const message = await f
			.as(f.other)
			.query(api.channels_messages.get_message, { membershipId: f.other.membershipId, messageId });
		const shapedReply = await f.as(f.other).query(api.channels_messages.get_message, {
			membershipId: f.other.membershipId,
			messageId: reply._yay!.messageId,
		});
		const agent = await agent_context(f, f.other);
		const agentRead = await f.t.query(internal.channels_messages.agent_read, {
			...agent,
			reference: { kind: "channel", value: channelId },
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(agentRead._nay).toBeUndefined();
		for (const value of [message, shapedReply, agentRead]) {
			const json = JSON.stringify(value);
			expect(json, "lost file access must hide the raw file id in every read").not.toContain(fileNodeId);
			expect(json, "lost file access must hide the file name in every read").not.toContain("protected-notes.md");
		}
		expect(message?.fileMentions).toEqual([{ kind: "unavailable" }]);
		expect(message?.message.fileQuotes).toEqual([{ fileNodeId: null, text: reference.fileQuotes[0]!.text }]);
		expect(shapedReply?.message.replyTo?.quote).toBeNull();
		expect(shapedReply?.replyPreview?.excerpt).toContain("File unavailable");
		const draft = channels_composer_markdown_for_edit(
			message!.message.body,
			[],
			message!.fileMentions,
			message!.message.fileQuotes,
		);
		expect(draft).toContain("File unavailable");
		expect(draft).not.toContain(fileNodeId);
		const inboxBefore = await f.t.run((ctx) => ctx.db.query("channels_inbox").collect());
		const edited = await f.as(f.member).mutation(api.channels_messages.edit_message, {
			membershipId: f.member.membershipId,
			messageId,
			expectedRevision: 0,
			body: 'Changed [file-quote id="0"]',
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: message!.message.fileQuotes,
		});
		expect(edited._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("channels_inbox").collect())).toEqual(inboxBefore);
		const retried = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{
				...reference,
				clientMessageId: (await f.t.run((ctx) => ctx.db.get("channels_messages", messageId)))!.clientMessageId,
			},
		);
		expect(retried._yay?.messageId, "a lost-access retry must reuse the already sent message").toBe(messageId);
	});

	test("file references reject unreadable, cross-workspace, archived, and missing files before message writes", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const ids = await f.t.run(async (ctx) => {
			const foreign = await test_mocks_fill_db_with.membership(ctx, { userId: f.owner.userId });
			const ids: Id<"files_nodes">[] = [];
			for (const name of ["hidden", "foreign", "archived", "missing", "folder"]) {
				const id = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: name === "foreign" ? foreign.organizationId : f.organizationId,
					workspaceId: name === "foreign" ? foreign.workspaceId : f.workspaceId,
					kind: name === "folder" ? "folder" : "file",
					name,
					path: `/${name}`,
					treePath: `/${name}`,
					createdBy: f.owner.userId,
					updatedBy: f.owner.userId,
				});
				ids.push(id);
				if (name === "hidden")
					await ctx.db.patch("files_nodes", id, { restrictedScopeNodeId: id, isRestrictedScopeRoot: true });
				if (name === "archived") await ctx.db.patch("files_nodes", id, { archiveOperationId: id });
				if (name === "missing") await ctx.db.delete("files_nodes", id);
			}
			return ids;
		});
		for (const fileNodeId of ids.slice(0, 4)) {
			for (const changes of [
				{ body: '[@ id="file:0"]', fileMentionIds: [fileNodeId] },
				{ body: '[file-quote id="0"]', fileQuotes: [{ fileNodeId, text: "Selected text" }] },
			]) {
				const result = await send(f, f.member, { kind: "channel", channelId }, changes);
				expect(result._nay?.message).toBe("File unavailable");
			}
		}
		const folderQuote = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ body: '[file-quote id="0"]', fileQuotes: [{ fileNodeId: ids[4]!, text: "Folder text" }] },
		);
		expect(folderQuote._nay?.message).toBe("File unavailable");
		expect(
			await f.t.run((ctx) => ctx.db.query("channels_messages").collect()),
			"refused references must not publish any message",
		).toEqual([]);
		const folderMention = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ body: '[@ id="file:0"]', fileMentionIds: [ids[4]!] },
		);
		expect(folderMention._nay).toBeUndefined();
	});

	test("file markers and quote limits cannot store private draft data in a public body", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const quote = { fileNodeId: null, text: "Quoted text" };
		for (const changes of [
			{ body: '[@ id="file:raw-file-id"]' },
			{ body: '[@ id="file:0"]' },
			{ body: file_quotes_serialize_draft(quote), fileQuotes: [quote] },
			{ body: '[file-quote id="1"]', fileQuotes: [quote] },
			{ body: '[file-quote id="0"]', fileQuotes: [{ ...quote, text: "🙂".repeat(1_025) }] },
			{ body: '[file-quote id="0"]', fileQuotes: Array(21).fill(quote) },
			{ body: "x".repeat(14_000) + '[file-quote id="0"]', fileQuotes: [{ ...quote, text: "x".repeat(3_000) }] },
		])
			expect((await send(f, f.member, { kind: "channel", channelId }, changes))._nay).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.query("channels_messages").collect())).toEqual([]);
	});

	test("unreadable attachments expose no raw id, filename, or path", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "hidden-report.md",
				path: "/hidden-report.md",
				treePath: "/hidden-report.md",
				textKind: "rich_text",
				createdBy: f.member.userId,
				updatedBy: f.member.userId,
			}),
		);
		const sent = await send(
			f,
			f.member,
			{ kind: "channel", channelId },
			{ attachments: [{ kind: "file", fileNodeId }] },
		);
		expect(sent._nay).toBeUndefined();
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		const message = await f.as(f.other).query(api.channels_messages.get_message, {
			membershipId: f.other.membershipId,
			messageId: sent._yay!.messageId,
		});
		expect(message?.attachments).toEqual([{ kind: "unavailable" }]);
		expect(JSON.stringify(message)).not.toContain(fileNodeId);
		expect(JSON.stringify(message)).not.toContain("hidden-report.md");
	});
});

describe("posts read state", () => {
	test("visiting a channel keeps root mentions unread until the post opens", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "posts.md",
				path: "/posts.md",
				treePath: "/posts.md",
				textKind: "rich_text",
				createdBy: f.member.userId,
				updatedBy: f.member.userId,
			}),
		);
		const sent = await send(
			f,
			f.member,
			{ kind: "file_comment", fileNodeId, anchorExcerpt: null },
			{ mentionUserIds: [f.other.userId] },
		);
		const channelId = (await f
			.as(f.other)
			.query(api.channels.get_file_channel, { membershipId: f.other.membershipId, fileNodeId }))!;
		await f.as(f.other).mutation(api.channels.join_channel, { membershipId: f.other.membershipId, channelId });
		await f
			.as(f.other)
			.mutation(api.channels.mark_read, { membershipId: f.other.membershipId, channelId, sequence: 1 });
		const visited = await f
			.as(f.other)
			.query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId });
		expect(visited?.unread).toBe(false);
		expect(visited?.mentionCount).toBe(1);
		expect(
			(
				await f.as(f.other).query(api.channels_messages.list_my_inbox, {
					membershipId: f.other.membershipId,
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page[0]?.unread,
			"post mention stays unread after a channel visit",
		).toBe(true);
		await f.as(f.other).mutation(api.channels_messages.mark_thread_read, {
			membershipId: f.other.membershipId,
			rootMessageId: sent._yay!.rootMessageId,
			replySequence: 0,
		});
		expect(
			(await f.as(f.other).query(api.channels.get_channel_state, { membershipId: f.other.membershipId, channelId }))
				?.mentionCount,
		).toBe(0);
	});
});

describe("toggle_reaction", () => {
	test("toggle keeps exact counts and refuses viewers and non-emoji text", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const sent = await send(f, f.member, { kind: "channel", channelId });
		const messageId = sent._yay!.messageId;
		for (const person of [f.member, f.other]) {
			const toggled = await f
				.as(person)
				.mutation(api.channels_messages.toggle_reaction, { membershipId: person.membershipId, messageId, emoji: "👍" });
			expect(toggled._nay).toBeUndefined();
		}
		const reactions = await f
			.as(f.member)
			.query(api.channels_messages.list_message_reactions, { membershipId: f.member.membershipId, messageId });
		expect(reactions[0]).toMatchObject({ emoji: "👍", count: 2, mine: true });
		const refused = await f
			.as(f.viewer)
			.mutation(api.channels_messages.toggle_reaction, { membershipId: f.viewer.membershipId, messageId, emoji: "👍" });
		expect(refused._nay?.message).toBe("You have view-only access");
		const invalid = await f.as(f.member).mutation(api.channels_messages.toggle_reaction, {
			membershipId: f.member.membershipId,
			messageId,
			emoji: "hello",
		});
		expect(invalid._nay?.message).toBe("Choose one emoji");
		await f
			.as(f.member)
			.mutation(api.channels_messages.toggle_reaction, { membershipId: f.member.membershipId, messageId, emoji: "👍" });
		expect(
			(
				await f
					.as(f.member)
					.query(api.channels_messages.list_message_reactions, { membershipId: f.member.membershipId, messageId })
			)[0],
		).toMatchObject({ count: 1, mine: false });
	});
});

describe("list_my_inbox", () => {
	test("broadcasts clear from either read position and normal replies need the thread", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const root = await send(f, f.member, { kind: "channel", channelId }, { mentionUserIds: [f.other.userId] });
		const rootMessageId = root._yay!.rootMessageId;
		await send(
			f,
			f.member,
			{ kind: "thread", rootMessageId },
			{ mentionUserIds: [f.other.userId], alsoInChannel: true },
		);
		const read = () =>
			f.as(f.other).query(api.channels_messages.list_my_inbox, {
				membershipId: f.other.membershipId,
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect((await read()).page.map((row) => row.unread)).toEqual([true, true]);
		await f
			.as(f.other)
			.mutation(api.channels.mark_read, { membershipId: f.other.membershipId, channelId, sequence: 2 });
		expect(
			(await read()).page.map((row) => row.unread),
			"broadcast mention must clear when the main stream is read",
		).toEqual([false, false]);
		await send(f, f.member, { kind: "thread", rootMessageId }, { mentionUserIds: [f.other.userId] });
		expect((await read()).page[0]?.unread).toBe(true);
		await f.as(f.other).mutation(api.channels_messages.mark_thread_read, {
			membershipId: f.other.membershipId,
			rootMessageId,
			replySequence: 2,
		});
		expect((await read()).page.map((row) => row.unread)).toEqual([false, false, false]);
	});

	test("losing private access hides the whole inbox result", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		await send(f, f.member, { kind: "channel", channelId }, { mentionUserIds: [f.other.userId] });
		const read = () =>
			f.as(f.other).query(api.channels_messages.list_my_inbox, {
				membershipId: f.other.membershipId,
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect((await read()).page).toHaveLength(1);
		await f.t.run(async (ctx) => {
			const member = await ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", f.other.userId))
				.unique();
			await ctx.db.delete("channels_members", member!._id);
		});
		expect((await read()).page, "private inbox must disappear after access is lost").toEqual([]);
	});
});

describe("list_my_threads", () => {
	test("unfollow hides the thread and lost channel access hides a followed thread", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		const root = await send(f, f.member, { kind: "channel", channelId });
		const rootMessageId = root._yay!.rootMessageId;
		await send(f, f.member, { kind: "thread", rootMessageId }, { mentionUserIds: [f.other.userId] });
		const read = () =>
			f.as(f.other).query(api.channels_messages.list_my_threads, {
				membershipId: f.other.membershipId,
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect((await read()).page[0]?.unread).toBe(true);
		await f
			.as(f.other)
			.mutation(api.channels_messages.unfollow_thread, { membershipId: f.other.membershipId, rootMessageId });
		expect((await read()).page).toEqual([]);
		await f
			.as(f.other)
			.mutation(api.channels_messages.follow_thread, { membershipId: f.other.membershipId, rootMessageId });
		await f.t.run(async (ctx) => {
			const member = await ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", f.other.userId))
				.unique();
			await ctx.db.delete("channels_members", member!._id);
		});
		expect((await read()).page, "private followed thread must disappear after access is lost").toEqual([]);
	});
});

describe("agent_read", () => {
	test("reads roots and replies in time order with an exclusive date end", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const root = await send(f, f.member, { kind: "channel", channelId }, { body: "Root body" });
		const reply = await send(
			f,
			f.member,
			{ kind: "thread", rootMessageId: root._yay!.messageId },
			{ body: "Reply body" },
		);
		const context = await agent_context(f);
		const first = await f.t.query(internal.channels_messages.agent_read, {
			...context,
			reference: { kind: "public", value: "general" },
			paginationOpts: { numItems: 1, cursor: null },
		});
		expect(first._yay!.page.map((row) => row.message.body)).toEqual(["Root body"]);
		const next = await f.t.query(internal.channels_messages.agent_read, {
			...context,
			reference: { kind: "channel", value: channelId },
			paginationOpts: { numItems: 1, cursor: first._yay!.continueCursor },
		});
		expect(next._yay!.page.map((row) => row.message.body)).toEqual(["Reply body"]);
		const until = next._yay!.page[0]!.message._creationTime;
		const range = await f.t.query(internal.channels_messages.agent_read, {
			...context,
			reference: { kind: "channel", value: channelId },
			until,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(
			range._yay!.page.some((row) => row.message._id === reply._yay!.messageId),
			"date end must exclude a message at that exact time",
		).toBe(false);
		const thread = await f.t.query(internal.channels_messages.agent_read, {
			...context,
			reference: { kind: "channel", value: channelId },
			rootMessageId: root._yay!.messageId,
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(thread._yay!.page.map((row) => row.message.body)).toEqual(["Root body", "Reply body"]);
	});
	test("reads a thread without reading the rest of the channel", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const root = await send(f, f.member, { kind: "channel", channelId }, { body: "Root body" });
		const rootMessageId = root._yay!.messageId as Id<"channels_messages">;
		// More channel messages than one page, all between the root and its reply.
		await f.t.run(async (ctx) => {
			const { _id, _creationTime, ...rootDoc } = (await ctx.db.get("channels_messages", rootMessageId))!;
			for (let index = 0; index < 60; index++)
				await ctx.db.insert("channels_messages", { ...rootDoc, body: `Other ${index}`, clientMessageId: `other-${index}` });
		});
		await send(f, f.member, { kind: "thread", rootMessageId }, { body: "Reply body" });

		const thread = await f.t.query(internal.channels_messages.agent_read, {
			...(await agent_context(f)),
			reference: { kind: "channel", value: channelId },
			rootMessageId,
			paginationOpts: { numItems: 50, cursor: null },
		});

		expect(thread._yay!.page.map((row) => row.message.body)).toEqual(["Root body", "Reply body"]);
		expect(thread._yay!.isDone).toBe(true);
	});
	test("hides private channels and refuses a stale source lifetime", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await send(f, f.member, { kind: "channel", channelId }, { body: "Private body" });
		const context = await agent_context(f, f.other);
		const args = {
			...context,
			reference: { kind: "channel" as const, value: channelId },
			paginationOpts: { numItems: 50, cursor: null },
		};
		expect(
			(await f.t.query(internal.channels_messages.agent_read, args))._nay?.message,
			"agent must not read a private non-member channel",
		).toBe("Not found");
		expect(
			(await f.t.query(internal.channels_messages.agent_list, { ...context, paginationOpts: args.paginationOpts }))
				._yay!.page,
		).toEqual([]);
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId,
			userIds: [f.other.userId],
			level: "member",
		});
		expect((await f.t.query(internal.channels_messages.agent_read, args))._yay!.page).toHaveLength(1);
		await f.t.run(async (ctx) => {
			const lifetime = (await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.other.userId))
				.unique())!;
			await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { lifetime: lifetime.lifetime + 1 });
		});
		expect(
			(await f.t.query(internal.channels_messages.agent_read, args))._nay?.message,
			"agent must refuse the old source lifetime",
		).toBe("Chat is no longer available");
	});
	test("file references use live file access and members use current pins", async () => {
		const f = await fixture();
		const context = await agent_context(f);
		const { fileNodeId, channelId } = await f.t.run(async (ctx) => {
			const fileNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "agent.md",
				path: "/agent.md",
				treePath: "/agent.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			});
			const channel = await channels_db_ensure_file_channel(ctx, {
				membership: (await ctx.db.get("organizations_workspaces_users", f.member.membershipId))!,
				userId: f.member.userId,
				fileNodeId,
			});
			return { fileNodeId, channelId: channel._id };
		});
		await send(f, f.member, { kind: "channel", channelId }, { body: "File discussion" });
		for (const reference of [
			{ kind: "file_id" as const, value: fileNodeId },
			{ kind: "file_path" as const, value: "/agent.md" },
		]) {
			expect(
				(
					await f.t.query(internal.channels_messages.agent_read, {
						...context,
						reference,
						paginationOpts: { numItems: 50, cursor: null },
					})
				)._yay!.page,
			).toHaveLength(1);
		}
		const members = await f.t.query(internal.channels_messages.agent_members, {
			...context,
			reference: { kind: "channel", value: channelId },
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(members._yay!.page.map((row) => row.userId)).toEqual([f.member.userId]);
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		const result = await f.t.query(internal.channels_messages.agent_read, {
			...context,
			reference: { kind: "file_path", value: "/agent.md" },
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(result._nay?.message, "agent file read must not reveal a path after access is lost").toBe("Not found");
	});
});

describe("search_messages", () => {
	test("hides private and direct messages, including after access is lost", async () => {
		const f = await fixture();
		const publicId = await create(f, "public");
		const privateId = await create(f, "private");
		const direct = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.owner.userId],
		});
		if (direct._nay) throw new Error(direct._nay.message);
		for (const channelId of [publicId, privateId, direct._yay.channelId])
			await send(f, f.member, { kind: "channel", channelId }, { body: "Searchneedle discussion" });
		const read = () =>
			f.as(f.other).query(api.channels_messages.search_messages, {
				membershipId: f.other.membershipId,
				query: "Searchneedle",
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect(
			(await read()).page.map((doc) => doc.message.channelId),
			"search must not return private or direct hits",
		).toEqual([publicId]);
		await f.as(f.member).mutation(api.channels.add_channel_members, {
			membershipId: f.member.membershipId,
			channelId: privateId,
			userIds: [f.other.userId],
			level: "member",
		});
		expect((await read()).page).toHaveLength(2);
		await f.as(f.member).mutation(api.channels.remove_channel_member, {
			membershipId: f.member.membershipId,
			channelId: privateId,
			userId: f.other.userId,
		});
		expect(
			(await read()).page.map((doc) => doc.message.channelId),
			"search must hide a revoked private hit",
		).toEqual([publicId]);
	});

	test("checks tenant, author, attachment and exclusive date filters", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const sent = await send(f, f.member, { kind: "channel", channelId }, { body: "Filterneedle first" });
		await send(f, f.other, { kind: "channel", channelId }, { body: "Filterneedle second" });
		const first = (await f.t.run((ctx) => ctx.db.get("channels_messages", sent._yay!.messageId)))!;
		const args = {
			membershipId: f.other.membershipId,
			query: "Filterneedle",
			paginationOpts: { numItems: 50, cursor: null },
		};
		expect(
			(
				await f
					.as(f.other)
					.query(api.channels_messages.search_messages, { ...args, authorUserId: f.member.userId, channelId })
			).page.map((doc) => doc.message._id),
		).toEqual([first._id]);
		expect(
			(await f.as(f.other).query(api.channels_messages.search_messages, { ...args, hasAttachments: true })).page,
		).toEqual([]);
		expect(
			(
				await f
					.as(f.other)
					.query(api.channels_messages.search_messages, { ...args, hasAttachments: false, since: first._creationTime })
			).page,
		).toHaveLength(2);
		expect(
			(await f.as(f.other).query(api.channels_messages.search_messages, { ...args, until: first._creationTime })).page,
		).toEqual([]);
		const foreign = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "foreign-search" }),
		);
		// A foreign message in the same test database must not enter the tenant search.
		const { _id, _creationTime, ...fields } = first;
		await f.t.run((ctx) =>
			ctx.db.insert("channels_messages", {
				...fields,
				organizationId: foreign.organizationId,
				workspaceId: foreign.workspaceId,
			}),
		);
		expect((await f.as(f.other).query(api.channels_messages.search_messages, args)).page).toHaveLength(2);
		for (const query of ["", "!!!", "x".repeat(513), Array.from({ length: 17 }, () => "word").join(" ")])
			expect((await f.as(f.other).query(api.channels_messages.search_messages, { ...args, query })).page).toEqual([]);
	});

	test("keeps continuation after hidden hits and drops deleted messages", async () => {
		const f = await fixture();
		const privateId = await create(f, "private");
		const publicId = await create(f, "public");
		await send(f, f.member, { kind: "channel", channelId: privateId }, { body: "Pagedneedle" });
		const visible = await send(f, f.member, { kind: "channel", channelId: publicId }, { body: "Pagedneedle" });
		const args = {
			membershipId: f.other.membershipId,
			query: "Pagedneedle",
			paginationOpts: { numItems: 1, cursor: null },
		};
		const first = await f.as(f.other).query(api.channels_messages.search_messages, args);
		const next = first.isDone
			? null
			: await f.as(f.other).query(api.channels_messages.search_messages, {
					...args,
					paginationOpts: { numItems: 1, cursor: first.continueCursor },
				});
		expect([...first.page, ...(next?.page ?? [])].map((doc) => doc.message._id)).toEqual([visible._yay!.messageId]);
		await f.as(f.member).mutation(api.channels_messages.delete_message, {
			membershipId: f.member.membershipId,
			messageId: visible._yay!.messageId,
		});
		expect(
			(
				await f
					.as(f.other)
					.query(api.channels_messages.search_messages, { ...args, paginationOpts: { numItems: 50, cursor: null } })
			).page,
		).toEqual([]);
	});

	test("uses live file access and shapes references in public hits", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "search-private.md",
				path: "/search-private.md",
				treePath: "/search-private.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		await send(f, f.owner, { kind: "file_comment", fileNodeId, anchorExcerpt: null }, { body: "Fileneedle comment" });
		await send(
			f,
			f.owner,
			{ kind: "channel", channelId },
			{
				body: 'Fileneedle [@ id="file:0"] [file-quote id="0"]',
				fileMentionIds: [fileNodeId],
				fileQuotes: [{ fileNodeId, text: "Selected text" }],
				attachments: [{ kind: "file", fileNodeId }],
			},
		);
		const read = () =>
			f.as(f.other).query(api.channels_messages.search_messages, {
				membershipId: f.other.membershipId,
				query: "Fileneedle",
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect((await read()).page).toHaveLength(2);
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, { restrictedScopeNodeId: fileNodeId, isRestrictedScopeRoot: true }),
		);
		const page = (await read()).page;
		expect(
			page.map((doc) => doc.message.channelId),
			"search must hide a file channel after read access is lost",
		).toEqual([channelId]);
		expect(JSON.stringify(page), "search must hide unreadable file ids and names").not.toContain(fileNodeId);
		expect(JSON.stringify(page)).not.toContain("search-private.md");
		expect(page[0]!.attachments).toEqual([{ kind: "unavailable" }]);
		expect(page[0]!.message.fileQuotes).toEqual([{ fileNodeId: null, text: "Selected text" }]);
	});

	test("keeps an unconfirmed file comment private to its author", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "search-anchor.md",
				path: "/search-anchor.md",
				treePath: "/search-anchor.md",
				textKind: "rich_text",
				createdBy: f.owner.userId,
				updatedBy: f.owner.userId,
			}),
		);
		const root = await send(
			f,
			f.owner,
			{ kind: "file_comment", fileNodeId, anchorExcerpt: "Selected" },
			{ body: "Anchorneedle" },
		);
		expect(root._nay).toBeUndefined();
		const args = { query: "Anchorneedle", paginationOpts: { numItems: 50, cursor: null } };
		expect(
			(
				await f
					.as(f.other)
					.query(api.channels_messages.search_messages, { ...args, membershipId: f.other.membershipId })
			).page,
			"search must hide an unconfirmed comment from other readers",
		).toEqual([]);
		expect(
			(
				await f
					.as(f.owner)
					.query(api.channels_messages.search_messages, { ...args, membershipId: f.owner.membershipId })
			).page,
		).toHaveLength(1);
	});
});

describe("agent_search", () => {
	test("uses current access and refuses a stale source", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await send(f, f.member, { kind: "channel", channelId }, { body: "Agentneedle" });
		const context = await agent_context(f, f.other);
		const args = { ...context, query: "Agentneedle", paginationOpts: { numItems: 50, cursor: null } };
		expect((await f.t.query(internal.channels_messages.agent_search, args))._yay!.page).toEqual([]);
		expect(
			(
				await f.t.query(internal.channels_messages.agent_search, {
					...args,
					reference: { kind: "channel", value: channelId },
				})
			)._nay?.message,
		).toBe("Not found");
		await f.t.run(async (ctx) => {
			const lifetime = (await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.other.userId))
				.unique())!;
			await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { lifetime: lifetime.lifetime + 1 });
		});
		expect((await f.t.query(internal.channels_messages.agent_search, args))._nay?.message).toBe(
			"Chat is no longer available",
		);
	});
});

describe("channels_db_purge_workspace_batch", () => {
	test("small batches remove every channel table before its parent", async () => {
		const f = await fixture();
		const channelId = await create(f, "public");
		const sent = await send(f, f.member, { kind: "channel", channelId }, { mentionUserIds: [f.other.userId] });
		await send(f, f.other, { kind: "thread", rootMessageId: sent._yay!.rootMessageId });
		await f.as(f.member).mutation(api.channels_messages.toggle_reaction, {
			membershipId: f.member.membershipId,
			messageId: sent._yay!.messageId,
			emoji: "👍",
		});
		let batches = 0;
		for (;;) {
			const count = await f.t.run((ctx) =>
				channels_db_purge_workspace_batch(ctx, {
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					batchSize: 1,
				}),
			);
			if (count === 0) break;
			expect(count).toBe(1);
			batches += 1;
			if (batches > 30) throw new Error("Channel purge did not finish");
		}
		expect(batches).toBeGreaterThan(8);
		const remaining = await f.t.run(async (ctx) => ({
			channel: await ctx.db.get("channels", channelId),
			messages: await ctx.db.query("channels_messages").collect(),
			followers: await ctx.db.query("channels_thread_followers").collect(),
			inbox: await ctx.db.query("channels_inbox").collect(),
			counts: await ctx.db.query("channels_reaction_counts").collect(),
		}));
		expect(remaining).toEqual({ channel: null, messages: [], followers: [], inbox: [], counts: [] });
	});
});
