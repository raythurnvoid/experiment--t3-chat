import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	test_convex,
	test_mocks,
	test_mocks_cancel_pending_home_file_seeds,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import {
	organizations_db_create,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	channels_notifications_db_advance_authority,
	channels_notifications_db_enqueue_sidebar,
	channels_notifications_db_ensure_summary,
} from "../server/channels-notifications.ts";
import { files_access_version_db_wrap } from "../server/files-access-version.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex();
	const data = await t.run(async (ctx) => {
		const now = Date.now();
		const ownerId = await ctx.db.insert("users", { clerkUserId: "counts-owner" });
		await quotas_db_ensure(ctx, { quotaName: "extra_organizations", userId: ownerId, now });
		await test_mocks_fill_db_with.plan(ctx, { userId: ownerId, plan: "Pay As You Go" });
		await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, { userId: ownerId, now });
		const created = await organizations_db_create(ctx, { userId: ownerId, name: "counts-test", description: "", now });
		if (created._nay) throw new Error(created._nay.message);
		const { organizationId, defaultWorkspaceId: workspaceId } = created._yay;
		const owner = (await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", workspaceId).eq("userId", ownerId).eq("active", true),
			)
			.unique())!;
		const people = [];
		for (let i = 0; i < 2; i++) {
			const userId = await ctx.db.insert("users", { clerkUserId: `counts-${i}` });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId,
				workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, { organizationId, workspaceId, userId, role: "member", now });
			people.push({ userId, membershipId });
		}
		await test_mocks_cancel_pending_home_file_seeds(ctx);
		return {
			organizationId,
			workspaceId,
			owner: { userId: ownerId, membershipId: owner._id },
			sender: people[0]!,
			reader: people[1]!,
		};
	});
	const as = (person: typeof data.owner) =>
		t.withIdentity({ issuer: "https://clerk.test", external_id: person.userId });
	return { t, ...data, as };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function create(f: Fixture, kind: "public" | "private" = "public", name = "general") {
	vi.setSystemTime(Date.now() + 2_001);
	const result = await f
		.as(f.sender)
		.mutation(api.channels.create_channel, {
			membershipId: f.sender.membershipId,
			kind,
			name,
			topic: "",
			layout: "messages",
		});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.channelId;
}

async function send(
	f: Fixture,
	target: FunctionArgs<typeof api.channels_messages.send_message>["target"],
	changes: Partial<FunctionArgs<typeof api.channels_messages.send_message>> = {},
	person = f.sender,
) {
	vi.setSystemTime(Date.now() + 1_001);
	const result = await f.as(person).mutation(api.channels_messages.send_message, {
		membershipId: person.membershipId,
		target,
		clientMessageId: crypto.randomUUID(),
		body: "Hello",
		mentionUserIds: [],
		fileMentionIds: [],
		fileQuotes: [],
		replyTo: null,
		attachments: [],
		alsoInChannel: false,
		title: null,
		...changes,
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay;
}

async function settle(f: Fixture) {
	await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

function summary(f: Fixture, person = f.reader) {
	return f.as(person).query(api.channels_notifications.get_summary, { membershipId: person.membershipId });
}

async function invite(f: Fixture, channelId: Id<"channels">) {
	const result = await f
		.as(f.sender)
		.mutation(api.channels.add_channel_members, {
			membershipId: f.sender.membershipId,
			channelId,
			userIds: [f.reader.userId],
			level: "member",
		});
	if (result._nay) throw new Error(result._nay.message);
}

describe("Messages totals", () => {
	test("deleted users cannot read totals or recreate summaries through delayed work", async () => {
		const f = await fixture();
		const channelId = await create(f);
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		await f.t.run(async (ctx) => {
			await ctx.db.patch("users", f.reader.userId, { deletedAt: Date.now() });
			const old = (await ctx.db
				.query("channels_summaries")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique())!;
			await ctx.db.delete("channels_summaries", old._id);
		});
		await expect(summary(f)).rejects.toThrow("Unauthenticated");
		await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
		await settle(f);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("channels_summaries")
					.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
					.unique(),
			),
		).toBeNull();
	});
	test("unused membership returns zero without allocating a summary", async () => {
		const f = await fixture();
		expect(await summary(f)).toMatchObject({ state: "delayed", mentionChannels: 0, unreadInbox: 0, unreadThreads: 0 });
		expect(await f.t.run((ctx) => ctx.db.query("channels_summaries").collect())).toEqual([]);
	});

	test("counts receipts beyond the loaded page and public non-member receipts", async () => {
		const f = await fixture();
		const channelId = await create(f);
		for (let i = 0; i < 54; i++) await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		expect(await summary(f), "all 54 receipts contribute without loading another page").toMatchObject({
			state: "delayed",
			mentionChannels: 0,
			unreadInbox: 54,
			unreadThreads: 0,
		});
		const page = await f
			.as(f.reader)
			.query(api.channels_messages.list_my_inbox, {
				membershipId: f.reader.membershipId,
				paginationOpts: { cursor: null, numItems: 50 },
			});
		expect(page.page).toHaveLength(50);
		expect(page.isDone).toBe(false);
		await f.as(f.reader).mutation(api.channels.join_channel, { membershipId: f.reader.membershipId, channelId });
		expect(await summary(f)).toMatchObject({ mentionChannels: 1, unreadInbox: 54 });
		await f
			.as(f.reader)
			.mutation(api.channels.mark_read, { membershipId: f.reader.membershipId, channelId, sequence: 54 });
		await settle(f);
		expect(await summary(f)).toMatchObject({ mentionChannels: 0, unreadInbox: 0 });
		const last = await f.t.run((ctx) =>
			ctx.db
				.query("channels_messages")
				.withIndex("by_channel_mainSequence", (q) => q.eq("channelId", channelId).eq("mainSequence", 52))
				.unique(),
		);
		await f
			.as(f.reader)
			.mutation(api.channels.mark_unread, { membershipId: f.reader.membershipId, messageId: last!._id });
		await settle(f);
		expect(await summary(f)).toMatchObject({ mentionChannels: 1, unreadInbox: 3 });
		await f.as(f.reader).mutation(api.channels.leave_channel, { membershipId: f.reader.membershipId, channelId });
		expect(await summary(f)).toMatchObject({ mentionChannels: 0, unreadInbox: 3 });
	});

	test("broadcasts clear through either read cursor and root deletion keeps live replies", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const root = await send(f, { kind: "channel", channelId }, {}, f.reader);
		await send(
			f,
			{ kind: "thread", rootMessageId: root.rootMessageId },
			{ mentionUserIds: [f.reader.userId], alsoInChannel: true },
		);
		await settle(f);
		expect(await summary(f)).toMatchObject({ unreadInbox: 1, unreadThreads: 1 });
		await f
			.as(f.reader)
			.mutation(api.channels.mark_read, { membershipId: f.reader.membershipId, channelId, sequence: 2 });
		await settle(f);
		expect(await summary(f)).toMatchObject({ unreadInbox: 0, unreadThreads: 1 });
		await f
			.as(f.reader)
			.mutation(api.channels_messages.delete_message, {
				membershipId: f.reader.membershipId,
				messageId: root.messageId,
			});
		await settle(f);
		expect(await summary(f), "deleted root with live replies remains an unread followed thread").toMatchObject({
			unreadThreads: 1,
		});
	});

	test("clearing a post's root mention repairs sequence-zero receipts", async () => {
		const f = await fixture();
		const channelId = await create(f);
		await f.t.run((ctx) => ctx.db.patch("channels", channelId, { layout: "posts" }));
		await f.as(f.reader).mutation(api.channels.join_channel, { membershipId: f.reader.membershipId, channelId });
		const root = await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		expect(await summary(f)).toMatchObject({ mentionChannels: 1, unreadInbox: 1, unreadThreads: 1 });
		await f
			.as(f.reader)
			.mutation(api.channels_messages.mark_thread_read, {
				membershipId: f.reader.membershipId,
				rootMessageId: root.rootMessageId,
				replySequence: 0,
			});
		await settle(f);
		expect(await summary(f), "sequence zero must clear even when the reply cursor stays zero").toMatchObject({
			mentionChannels: 0,
			unreadInbox: 0,
			unreadThreads: 0,
		});
	});

	test.each(["resolve_thread", "reopen_thread", "set_thread_title"] as const)(
		"%s restores the author's unread follow through the public door",
		async (door) => {
			const f = await fixture();
			const channelId = await create(f);
			await f
				.as(f.sender)
				.mutation(api.channels.set_channel_resolvable_threads, {
					membershipId: f.sender.membershipId,
					channelId,
					resolvableThreads: true,
				});
			const root = await send(f, { kind: "channel", channelId }, {}, f.reader);
			await send(f, { kind: "thread", rootMessageId: root.rootMessageId });
			await f
				.as(f.reader)
				.mutation(api.channels_messages.unfollow_thread, {
					membershipId: f.reader.membershipId,
					rootMessageId: root.rootMessageId,
				});
			await settle(f);
			expect(await summary(f)).toMatchObject({ unreadThreads: 0 });
			const args = { membershipId: f.sender.membershipId, rootMessageId: root.rootMessageId };
			const result =
				door === "set_thread_title"
					? await f.as(f.sender).mutation(api.channels_messages.set_thread_title, { ...args, title: "Title" })
					: await f.as(f.sender).mutation(api.channels_messages[door], args);
			expect(result._nay).toBeUndefined();
			expect(await summary(f), "metadata door's existing auto-follow must restore its count").toMatchObject({
				unreadThreads: 1,
			});
		},
	);
});

describe("Messages access and identity", () => {
	test("denied auto-follows stay off the feed, then keep a locked receipt after restore and loss", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await invite(f, channelId);
		const root = await send(f, { kind: "channel", channelId }, {}, f.reader);
		await f
			.as(f.sender)
			.mutation(api.channels.remove_channel_member, {
				membershipId: f.sender.membershipId,
				channelId,
				userId: f.reader.userId,
			});
		const reply = await send(f, { kind: "thread", rootMessageId: root.rootMessageId });
		await settle(f);
		const read = () =>
			f
				.as(f.reader)
				.query(api.channels_messages.list_my_threads, {
					membershipId: f.reader.membershipId,
					paginationOpts: { cursor: null, numItems: 50 },
				});
		expect((await read()).page).toEqual([]);
		const follower = await f.t.run((ctx) =>
			ctx.db
				.query("channels_thread_followers")
				.withIndex("by_workspaceMembership_thread", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique(),
		);
		expect(follower).toMatchObject({ following: true, feedVisible: false, countedUnread: false });
		await invite(f, channelId);
		await settle(f);
		expect((await read()).page[0]?.state).toBe("readable");
		expect(await summary(f)).toMatchObject({ unreadThreads: 1 });
		await f
			.as(f.sender)
			.mutation(api.channels.remove_channel_member, {
				membershipId: f.sender.membershipId,
				channelId,
				userId: f.reader.userId,
			});
		await settle(f);
		const locked = (await read()).page;
		expect(locked).toEqual([{ state: "locked", followerId: follower!._id, kind: "thread" }]);
		for (const messageId of [reply.messageId, root.messageId])
			await f
				.as(f.sender)
				.mutation(api.channels_messages.delete_message, { membershipId: f.sender.membershipId, messageId });
		await settle(f);
		expect((await read()).page).toEqual(locked);
		expect(await summary(f)).toMatchObject({ unreadThreads: 0 });
		await invite(f, channelId);
		await settle(f);
		expect((await read()).page).toEqual([]);
	});
	test("same-membership restore catches up only main activity after Close", async () => {
		const f = await fixture();
		const opened = await f
			.as(f.sender)
			.mutation(api.channels.open_direct_channel, {
				membershipId: f.sender.membershipId,
				otherUserIds: [f.reader.userId, f.owner.userId],
			});
		const channelId = opened._yay!.channelId;
		const root = await send(f, { kind: "channel", channelId });
		await f.as(f.reader).mutation(api.channels.hide_direct_channel, { membershipId: f.reader.membershipId, channelId });
		const setActive = (active: boolean) =>
			f.t.run(async (ctx) => {
				const capture = files_access_version_db_wrap(ctx);
				await capture.db.patch("organizations_workspaces_users", f.reader.membershipId, { active });
				await capture.flush();
			});
		await setActive(false);
		await send(f, { kind: "thread", rootMessageId: root.rootMessageId });
		await setActive(true);
		await settle(f);
		const state = () =>
			f.as(f.reader).query(api.channels.get_channel_state, { membershipId: f.reader.membershipId, channelId });
		expect((await state())?.member?.hidden).toBe(true);
		await setActive(false);
		await send(f, { kind: "channel", channelId });
		await setActive(true);
		await settle(f);
		expect((await state())?.member?.hidden, "restoring the same membership catches up missed main activity").toBe(
			false,
		);
	});
	test("denied receipts stay locked through hidden edit and do not revive on restore", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await invite(f, channelId);
		const message = await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		await f
			.as(f.sender)
			.mutation(api.channels.remove_channel_member, {
				membershipId: f.sender.membershipId,
				channelId,
				userId: f.reader.userId,
			});
		expect(await summary(f)).toMatchObject({ state: "updating" });
		await settle(f);
		const before = await summary(f);
		const read = () =>
			f
				.as(f.reader)
				.query(api.channels_messages.list_my_inbox, {
					membershipId: f.reader.membershipId,
					paginationOpts: { cursor: null, numItems: 50 },
				});
		const locked = (await read()).page;
		expect(locked).toEqual([{ state: "locked", inboxId: expect.any(String), kind: "mention" }]);
		await f
			.as(f.sender)
			.mutation(api.channels_messages.edit_message, {
				membershipId: f.sender.membershipId,
				messageId: message.messageId,
				expectedRevision: 0,
				body: "Edited",
				mentionUserIds: [],
				fileMentionIds: [],
				fileQuotes: [],
			});
		await f
			.as(f.sender)
			.mutation(api.channels.rename_channel, { membershipId: f.sender.membershipId, channelId, name: "secret-rename" });
		await settle(f);
		expect((await read()).page).toEqual(locked);
		expect(await summary(f), "hidden edits and names must not change counts or authority status").toEqual(before);
		await invite(f, channelId);
		await settle(f);
		expect((await read()).page).toEqual([]);
		expect(await summary(f)).toMatchObject({ unreadInbox: 0, mentionChannels: 0 });
	});

	test("a fresh invite does not inherit root authorship or old mention replay", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const authored = await send(f, { kind: "channel", channelId }, {}, f.reader);
		const mentioned = await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		const membershipId = await test_run_with_flush(f.t, async (ctx) => {
			const old = (await ctx.db.get("organizations_workspaces_users", f.reader.membershipId))!;
			await ctx.db.delete("organizations_workspaces_users", old._id);
			const { _id, _creationTime, ...fields } = old;
			return ctx.db.insert("organizations_workspaces_users", fields);
		});
		const fresh = { userId: f.reader.userId, membershipId };
		await send(f, { kind: "thread", rootMessageId: authored.rootMessageId });
		await send(f, { kind: "thread", rootMessageId: mentioned.rootMessageId });
		await settle(f);
		expect(await summary(f, fresh)).toMatchObject({ unreadInbox: 0, unreadThreads: 0 });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("channels_thread_followers")
					.withIndex("by_workspaceMembership_thread", (q) => q.eq("workspaceMembershipId", membershipId))
					.collect(),
			),
		).toEqual([]);
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [fresh.userId] });
		expect(await summary(f, fresh)).toMatchObject({ unreadInbox: 1 });
	});

	test("Close ignores ordinary replies, stale opens, and retried accepted sends", async () => {
		const f = await fixture();
		const opened = await f
			.as(f.sender)
			.mutation(api.channels.open_direct_channel, {
				membershipId: f.sender.membershipId,
				otherUserIds: [f.reader.userId],
			});
		const channelId = opened._yay!.channelId;
		const clientMessageId = crypto.randomUUID();
		const root = await send(f, { kind: "channel", channelId }, { clientMessageId }, f.reader);
		await settle(f);
		const state = () =>
			f.as(f.reader).query(api.channels.get_channel_state, { membershipId: f.reader.membershipId, channelId });
		const revision = (await state())!.member!.visibilityRevision;
		await f.as(f.reader).mutation(api.channels.hide_direct_channel, { membershipId: f.reader.membershipId, channelId });
		await send(f, { kind: "thread", rootMessageId: root.rootMessageId });
		await send(f, { kind: "channel", channelId }, { clientMessageId }, f.reader);
		const stale = await f
			.as(f.reader)
			.mutation(api.channels.open_direct_channel_by_id, {
				membershipId: f.reader.membershipId,
				channelId,
				expectedVisibilityRevision: revision,
			});
		expect(stale._yay?.opened).toBe(false);
		expect((await state())!.member!.hidden).toBe(true);
		await send(f, { kind: "thread", rootMessageId: root.rootMessageId }, { alsoInChannel: true });
		expect((await state())!.member!.hidden).toBe(false);
	});
});

describe("Messages paging", () => {
	test("four indexed sections page 10,000 file joins and 500 named joins", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			await channels_notifications_db_ensure_summary(
				ctx,
				(await ctx.db.get("organizations_workspaces_users", f.reader.membershipId))!,
			);
		});
		for (const [kind, count] of [
			["public", 620],
			["direct", 120],
			["file", 10_000],
		] as const) {
			for (let start = 0; start < count; start += 100)
				await test_run_with_flush(f.t, async (ctx) => {
					for (let i = start; i < Math.min(count, start + 100); i++) {
						const common = {
							organizationId: f.organizationId,
							workspaceId: f.workspaceId,
							createdBy: f.reader.userId,
							createdAt: i + 1,
						};
						let channelId: Id<"channels">;
						if (kind === "file") {
							const name = `file-${i.toString().padStart(5, "0")}.md`;
							const fileNodeId = await ctx.db.insert("files_nodes", {
								...test_mocks.files.base(),
								organizationId: f.organizationId,
								workspaceId: f.workspaceId,
								kind: "file",
								name,
								path: `/${name}`,
								treePath: `/${name}`,
								textKind: "rich_text",
								createdBy: f.reader.userId,
								updatedBy: f.reader.userId,
							});
							channelId = await ctx.db.insert("channels", { ...common, kind, fileNodeId });
						} else if (kind === "direct") {
							const userId = await ctx.db.insert("users", { clerkUserId: `page-${i}` });
							const membershipId = await ctx.db.insert("organizations_workspaces_users", {
								organizationId: f.organizationId,
								workspaceId: f.workspaceId,
								userId,
								active: true,
								pendingOrganizationRemoval: false,
								updatedAt: Date.now(),
								displayName: "",
								sortDisplayName: "",
							});
							channelId = await ctx.db.insert("channels", {
								...common,
								kind,
								participantUserIds: [f.reader.userId, userId],
								directKey: [f.reader.membershipId, membershipId].sort().join(":"),
							});
						} else
							channelId = await ctx.db.insert("channels", {
								...common,
								kind,
								name: `channel-${i.toString().padStart(3, "0")}`,
								topic: "",
								layout: "messages",
								resolvableThreads: false,
								archived: i < 60,
								archivedAt: i < 60 ? 1 : null,
							});
						await ctx.db.insert("channels_activity", {
							channelId,
							organizationId: f.organizationId,
							workspaceId: f.workspaceId,
							lastMainSequence: 0,
							lastChannelSequence: 0,
							lastMainMessageAt: i + 1,
							lastMessageAt: i + 1,
							memberCount: 1,
						});
						await ctx.db.insert("channels_members", {
							channelId,
							organizationId: f.organizationId,
							workspaceId: f.workspaceId,
							userId: f.reader.userId,
							workspaceMembershipId: f.reader.membershipId,
							channelKind: kind,
							level: "member",
							addedBy: null,
							notify: "all",
							starred: kind === "public" && i >= 60 && i < 120,
							section: kind === "file" ? "files" : kind === "direct" ? "direct" : "channels",
							hidden: kind === "direct" && i >= 60,
							hiddenAtMainSequence: kind === "direct" && i >= 60 ? 0 : null,
							sidebarArchived: kind === "public" && i < 60,
							sidebarName: kind === "public" ? `channel-${i.toString().padStart(3, "0")}` : null,
							sidebarActivityAt: i + 1,
							starredAt: kind === "public" && i >= 60 && i < 120 ? i + 1 : null,
							visibilityRevision: 0,
							countSummaryId: null,
							countGeneration: 0,
							countedMention: false,
							joinedAt: i + 1,
						});
					}
				});
		}
		for (const section of ["starred", "channels", "direct", "files"] as const) {
			const first = await f
				.as(f.reader)
				.query(api.channels.list_my_channels, {
					membershipId: f.reader.membershipId,
					section,
					paginationOpts: { cursor: null, numItems: 50 },
				});
			expect(first.page, `${section} first page stays full despite excluded joins`).toHaveLength(50);
			expect(first.page.every((item) => item.state === "readable")).toBe(true);
			expect(first.isDone).toBe(false);
			const next = await f
				.as(f.reader)
				.query(api.channels.list_my_channels, {
					membershipId: f.reader.membershipId,
					section,
					paginationOpts: { cursor: first.continueCursor, numItems: 50 },
				});
			expect(next.page).toHaveLength(section === "starred" || section === "direct" ? 10 : 50);
			expect(new Set([...first.page, ...next.page].map((item) => item.memberId)).size).toBe(
				first.page.length + next.page.length,
			);
			if (section === "channels")
				expect(
					first.page.flatMap((item) =>
						item.state === "readable" && (item.channel.kind === "public" || item.channel.kind === "private")
							? [item.channel.name]
							: [],
					),
				).toEqual(Array.from({ length: 50 }, (_, i) => `channel-${(i + 120).toString().padStart(3, "0")}`));
		}
	}, 60_000);

	test("server prefix search uses normalized whole-name prefixes and scope keys", async () => {
		const f = await fixture();
		await create(f, "public", "alpha-one");
		await create(f, "public", "beta_alpha");
		await create(f, "public", "a".repeat(80));
		const key = (await summary(f))!.accessScopeKey;
		const read = (prefix: string) =>
			f
				.as(f.reader)
				.query(api.channels.browse_public_channels, {
					membershipId: f.reader.membershipId,
					accessScopeKey: key,
					archived: false,
					prefix,
					paginationOpts: { cursor: null, numItems: 50 },
				});
		expect((await read(" ALPHA- ")).page).toHaveLength(1);
		expect((await read("alpha")).page).toHaveLength(1);
		expect((await read("a")).page).toHaveLength(2);
		expect((await read("a".repeat(80))).page).toHaveLength(1);
		expect((await read("a".repeat(81))).page).toEqual([]);
		expect((await read("  ")).page).toHaveLength(3);
		expect((await read("#alpha")).page).toEqual([]);
	});

	test("private prefix search keeps frozen locked matches after workspace read is lost", async () => {
		const f = await fixture();
		const channelId = await create(f, "private", "sidebar-known");
		await invite(f, channelId);
		await create(f, "private", "sidebar-unjoined");
		await create(f, "public", "sidebar-public");
		await settle(f);
		const beforeKey = (await summary(f))!.accessScopeKey;
		const read = (accessScopeKey: string, prefix = "sidebar") =>
			f.as(f.reader).query(api.channels.search_my_private_channels, {
				membershipId: f.reader.membershipId,
				accessScopeKey,
				archived: false,
				prefix,
				paginationOpts: { cursor: null, numItems: 50 },
			});
		const before = (await read(beforeKey)).page;
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({ state: "readable", channel: { _id: channelId } });
		await f.t.run(async (ctx) => {
			const capture = files_access_version_db_wrap(ctx);
			const assignments = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_user_workspace", (q) =>
					q.eq("organizationId", f.organizationId).eq("userId", f.reader.userId).eq("workspaceId", f.workspaceId),
				)
				.collect();
			for (const assignment of assignments) await capture.db.delete("access_control_role_assignments", assignment._id);
			await capture.flush();
		});
		await settle(f);
		const currentKey = (await summary(f))!.accessScopeKey;
		expect(currentKey).not.toBe(beforeKey);
		expect((await read(beforeKey)).page).toEqual([]);
		const locked = [{ state: "locked", memberId: before[0]!.memberId, kind: "private" }];
		expect((await read(currentKey)).page, "current private prefix must keep the generic locked match").toEqual(locked);
		await f.as(f.sender).mutation(api.channels.rename_channel, {
			membershipId: f.sender.membershipId,
			channelId,
			name: "hidden-rename",
		});
		await settle(f);
		expect((await summary(f))!.accessScopeKey).toBe(currentKey);
		expect((await read(currentKey)).page).toEqual(locked);
		expect((await read(currentKey, "hidden")).page).toEqual([]);
		expect(
			(
				await f.as(f.reader).query(api.channels.browse_public_channels, {
					membershipId: f.reader.membershipId,
					accessScopeKey: currentKey,
					archived: false,
					prefix: "sidebar",
					paginationOpts: { cursor: null, numItems: 50 },
				})
			).page,
		).toEqual([]);
	});
});

describe("Messages repair", () => {
	test("a later rename revisits members already behind the sidebar job cursor", async () => {
		const f = await fixture();
		const channelId = await create(f);
		for (const person of [f.reader, f.owner])
			await f.as(person).mutation(api.channels.join_channel, { membershipId: person.membershipId, channelId });
		await settle(f);
		await f
			.as(f.sender)
			.mutation(api.channels.rename_channel, { membershipId: f.sender.membershipId, channelId, name: "first-name" });
		const job = (await f.t.run((ctx) =>
			ctx.db
				.query("channels_sidebar_jobs")
				.withIndex("by_channel", (q) => q.eq("channelId", channelId))
				.unique(),
		))!;
		await f.t.mutation(internal.channels_notifications.drain_sidebar_job, { jobId: job._id, _test_batchSize: 1 });
		await f
			.as(f.sender)
			.mutation(api.channels.rename_channel, { membershipId: f.sender.membershipId, channelId, name: "last-name" });
		await settle(f);
		const members = await f.t.run((ctx) =>
			ctx.db
				.query("channels_members")
				.withIndex("by_channel_user", (q) => q.eq("channelId", channelId))
				.collect(),
		);
		expect(members).toHaveLength(3);
		expect(members.map((member) => member.sidebarName)).toEqual(["last-name", "last-name", "last-name"]);
	});

	test("member authority changes replace a partial summary repair", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await invite(f, channelId);
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
		const old = (await f.t.run((ctx) =>
			ctx.db
				.query("channels_summary_jobs")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique(),
		))!;
		await f.t.mutation(internal.channels_notifications.drain_summary_job, { jobId: old._id, _test_batchSize: 1 });
		await f
			.as(f.sender)
			.mutation(api.channels.remove_channel_member, {
				membershipId: f.sender.membershipId,
				channelId,
				userId: f.reader.userId,
			});
		await invite(f, channelId);
		await f.t.mutation(internal.channels_notifications.drain_summary_job, { jobId: old._id });
		expect(await summary(f)).toMatchObject({ state: "updating" });
		await settle(f);
		expect(await summary(f)).toMatchObject({ state: "delayed", mentionChannels: 1, unreadInbox: 1 });
	});

	test("overlapping forward and backward read jobs use the latest read position", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const messages = [];
		for (let i = 0; i < 4; i++)
			messages.push(await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] }));
		await settle(f);
		await f
			.as(f.reader)
			.mutation(api.channels.mark_read, { membershipId: f.reader.membershipId, channelId, sequence: 4 });
		await f
			.as(f.reader)
			.mutation(api.channels.mark_unread, { membershipId: f.reader.membershipId, messageId: messages[2]!.messageId });
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("channels_inbox_jobs")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.collect(),
		);
		for (const job of jobs.reverse())
			await f.t.mutation(internal.channels_notifications.drain_inbox_job, { jobId: job._id, _test_batchSize: 1 });
		await settle(f);
		expect(await summary(f)).toMatchObject({ unreadInbox: 2 });
	});
	test("new summary identity ignores stamps from the removed summary", async () => {
		const f = await fixture();
		const channelId = await create(f);
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		// Reuse generation 2 after recreation, so only the summary id separates the stamps.
		for (let i = 0; i < 2; i++) {
			await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
			await settle(f);
		}
		const old = await f.t.run(async (ctx) => {
			const summary = (await ctx.db
				.query("channels_summaries")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique())!;
			await ctx.db.delete("channels_summaries", summary._id);
			return summary;
		});
		expect(await summary(f)).toMatchObject({ state: "updating" });
		await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
		await settle(f);
		expect(await summary(f), "the old true stamp must still add once to the new summary").toMatchObject({
			state: "delayed",
			unreadInbox: 1,
		});
		const current = await f.t.run((ctx) =>
			ctx.db
				.query("channels_summaries")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique(),
		);
		expect(current!._id).not.toBe(old._id);
		expect(current!.generation).toBe(old.generation);
	});

	test("writes and deletion behind a repair cursor converge without double counting", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const first = await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
		const job = (await f.t.run((ctx) =>
			ctx.db
				.query("channels_summary_jobs")
				.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", f.reader.membershipId))
				.unique(),
		))!;
		await f.t.mutation(internal.channels_notifications.drain_summary_job, { jobId: job._id, _test_batchSize: 1 });
		await f.t.mutation(internal.channels_notifications.drain_summary_job, { jobId: job._id, _test_batchSize: 1 });
		await f
			.as(f.sender)
			.mutation(api.channels_messages.delete_message, {
				membershipId: f.sender.membershipId,
				messageId: first.messageId,
			});
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		expect(await summary(f)).toMatchObject({ state: "delayed", unreadInbox: 2 });
		await f.t.mutation(internal.channels_notifications.drain_summary_job, { jobId: job._id });
		expect(await summary(f)).toMatchObject({ unreadInbox: 2 });
	});

	test("second authority changes while Updating change the key and replace stale repair work", async () => {
		const f = await fixture();
		const channelId = await create(f);
		await send(f, { kind: "channel", channelId }, { mentionUserIds: [f.reader.userId] });
		await settle(f);
		const oldKey = (await summary(f))!.accessScopeKey;
		await f.t.run((ctx) =>
			channels_notifications_db_advance_authority(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
			}),
		);
		const first = await summary(f);
		await f.t.mutation(internal.channels_notifications.repair_summary, { membershipId: f.reader.membershipId });
		await f.t.run((ctx) =>
			channels_notifications_db_advance_authority(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
			}),
		);
		const second = await summary(f);
		expect(first?.state).toBe("updating");
		expect(second?.state).toBe("updating");
		expect(second?.accessScopeKey).not.toBe(first?.accessScopeKey);
		const stale = await f
			.as(f.reader)
			.query(api.channels.browse_public_channels, {
				membershipId: f.reader.membershipId,
				accessScopeKey: oldKey,
				archived: false,
				prefix: "",
				paginationOpts: { cursor: null, numItems: 50 },
			});
		expect(stale.page).toEqual([]);
		await settle(f);
		expect(await summary(f)).toMatchObject({ state: "delayed", unreadInbox: 1 });
	});

	test("recovery continues past a pending first page", async () => {
		const f = await fixture();
		const first = await create(f, "public", "first");
		const second = await create(f, "public", "second");
		const jobs = await f.t.run(async (ctx) => {
			for (const channelId of [first, second]) {
				await channels_notifications_db_enqueue_sidebar(ctx, (await ctx.db.get("channels", channelId))!);
			}
			const jobs = await ctx.db.query("channels_sidebar_jobs").withIndex("by_dueAt").collect();
			for (const job of jobs) await ctx.db.patch("channels_sidebar_jobs", job._id, { dueAt: 0 });
			await ctx.scheduler.cancel(jobs[1]!.scheduledId!);
			return jobs;
		});
		await f.t.mutation(internal.channels_notifications.recover_jobs_page, {
			kind: "sidebar",
			cutoff: Date.now(),
			cursor: null,
			_test_batchSize: 1,
		});
		const continuation = await f.t.run(async (ctx) => {
			const functions = await ctx.db.system.query("_scheduled_functions").collect();
			return functions.find(
				(fn) => fn.name === "channels_notifications:recover_jobs_page" && fn.state.kind === "pending",
			);
		});
		expect(continuation, "pending first page must schedule a cursor continuation").toBeTruthy();
		const args = continuation!.args[0] as FunctionArgs<typeof internal.channels_notifications.recover_jobs_page>;
		expect(args.cursor).not.toBeNull();
		await f.t.mutation(internal.channels_notifications.recover_jobs_page, args);
		const retried = await f.t.run((ctx) => ctx.db.get("channels_sidebar_jobs", jobs[1]!._id));
		expect(retried!.scheduledId, "failed job after a pending page must get a new scheduled call").not.toBe(
			jobs[1]!.scheduledId,
		);
		await settle(f);
	});
});
