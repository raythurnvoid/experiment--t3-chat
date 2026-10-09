import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { channels_db_purge_workspace_batch } from "./channels.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { r2_create_asset_key, r2_PUT_MAY_ARRIVE_MARGIN_MS, r2_UNFINALIZED_ASSET_TTL_MS } from "./r2_client.ts";
import { files_UPLOAD_URL_TTL_MS } from "./files_nodes.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";

let uploadUrlSpy: MockInstance;
let downloadUrlSpy: MockInstance;
let enqueueActionSpy: MockInstance;

beforeEach(() => {
	uploadUrlSpy = vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: "https://upload.test/object",
	}));
	downloadUrlSpy = vi.spyOn(R2.prototype, "getUrl").mockResolvedValue("https://download.test/object");
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_channel_upload" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(plan: "Pay As You Go" | "Free" = "Pay As You Go") {
	const t = test_convex();
	const data = await t.run(async (ctx) => {
		const owner = await test_mocks_fill_db_with.membership(ctx, { plan });
		await ctx.db.patch("users", owner.userId, { clerkUserId: "upload-owner" });
		const people: Array<{ userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> }> = [];
		for (const role of ["member", "member", "viewer"] as const) {
			const userId = await ctx.db.insert("users", { clerkUserId: `upload-person-${people.length}` });
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				role,
				now: Date.now(),
			});
			people.push({ userId, membershipId });
		}
		return {
			...owner,
			owner: { userId: owner.userId, membershipId: owner.membershipId },
			member: people[0]!,
			other: people[1]!,
			viewer: people[2]!,
		};
	});
	const as = (person = data.owner) =>
		t.withIdentity({
			issuer: "https://clerk.test",
			external_id: person.userId,
			name: "Upload test",
			email: "upload@test.local",
		});
	return { t, ...data, as };
}

async function create(f: Awaited<ReturnType<typeof fixture>>, kind: "public" | "private" = "public") {
	const result = await f.as().mutation(api.channels.create_channel, {
		membershipId: f.membershipId,
		kind,
		name: "uploads",
		topic: "",
		layout: "messages",
	});
	expect(result._nay).toBeUndefined();
	return result._yay!.channelId;
}

async function target(f: Awaited<ReturnType<typeof fixture>>, channelId: Id<"channels">, size = 8, person = f.owner) {
	const result = await f.as(person).mutation(api.channels_uploads.create_upload_target, {
		membershipId: person.membershipId,
		target: { kind: "channel", channelId },
		name: "Report Ü.txt",
		contentType: "text/plain",
		size,
	});
	expect(result._nay).toBeUndefined();
	const uploadId = result._yay!.uploadId;
	return await f.t.run(async (ctx) => {
		const upload = (await ctx.db.get("channels_uploads", uploadId))!;
		const asset = (await ctx.db.get("files_r2_assets", upload.assetId))!;
		return {
			upload,
			asset,
			headers: result._yay!.headers,
			key: r2_create_asset_key({ ...upload, assetId: asset._id }),
		};
	});
}

function message_args(
	f: Awaited<ReturnType<typeof fixture>>,
	channelId: Id<"channels">,
	attachments: FunctionArgs<typeof api.channels_messages.send_message>["attachments"],
) {
	return {
		membershipId: f.membershipId,
		target: { kind: "channel" as const, channelId },
		clientMessageId: "upload-message",
		body: "",
		mentionUserIds: [],
		fileMentionIds: [],
		fileQuotes: [],
		replyTo: null,
		attachments,
		alsoInChannel: false,
		title: null,
	} satisfies FunctionArgs<typeof api.channels_messages.send_message>;
}

describe("create_upload_target", () => {
	test("keeps the original name and mints create-only bytes outside the Files tree", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const before = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const minted = await target(f, channelId);
		expect(minted.upload.name).toBe("Report Ü.txt");
		expect(minted.asset.kind).toBe("channel_upload");
		expect(minted.asset.r2Key).toBeUndefined();
		expect(minted.asset.unfinalizedExpiresAt).toBe(minted.upload.createdAt + r2_UNFINALIZED_ASSET_TTL_MS);
		expect(minted.asset.uploadUrlExpiresAt).toBe(minted.upload.createdAt + files_UPLOAD_URL_TTL_MS);
		expect(minted.headers).toEqual({ "Content-Type": "text/plain;charset=utf-8", "If-None-Match": "*" });
		expect(uploadUrlSpy).toHaveBeenCalledWith(minted.key, { createOnly: true, expiresIn: 900 });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", f.workspaceId).eq("quotaName", "stored_file_bytes"),
					)
					.first(),
			),
		).toBeNull();
	});

	test("Free refusal leaves no upload, asset or file channel", async () => {
		const f = await fixture("Free");
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
				createdBy: f.userId,
				updatedBy: f.userId,
			}),
		);
		const before = await f.t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		const result = await f.as().mutation(api.channels_uploads.create_upload_target, {
			membershipId: f.membershipId,
			target: { kind: "file", fileNodeId },
			name: "small.bin",
			size: 8,
		});
		expect(result._nay?.message).toBe("This workspace's plan does not include file uploads");
		await f.t.run(async (ctx) => {
			expect(await ctx.db.query("channels").collect()).toEqual([]);
			expect(await ctx.db.query("channels_uploads").collect()).toEqual([]);
			expect(await ctx.db.query("files_r2_assets").collect()).toEqual(before.assets);
			expect(await ctx.db.query("quotas").collect()).toEqual(before.quotas);
		});
	});

	test.each(["", " ", "../secret", "folder\\secret", "bad\nname", "x".repeat(256)])(
		"refuses unsafe name %j before allocation",
		async (name) => {
			const f = await fixture();
			const channelId = await create(f);
			const result = await f.as().mutation(api.channels_uploads.create_upload_target, {
				membershipId: f.membershipId,
				target: { kind: "channel", channelId },
				name,
				size: 8,
			});
			expect(result._nay?.message).toBe("Invalid file name");
			expect(await f.t.run((ctx) => ctx.db.query("channels_uploads").collect())).toEqual([]);
		},
	);

	test("private, direct, viewer and archived targets refuse before allocation", async () => {
		const f = await fixture();
		const privateId = await create(f, "private");
		const request = {
			membershipId: f.other.membershipId,
			target: { kind: "channel" as const, channelId: privateId },
			name: "secret.txt",
			size: 8,
		};
		expect(
			(await f.as(f.other).mutation(api.channels_uploads.create_upload_target, request))._nay?.message,
			"private outsider cannot allocate an upload",
		).toBe("Not found");
		const direct = await f.as(f.member).mutation(api.channels.open_direct_channel, {
			membershipId: f.member.membershipId,
			otherUserIds: [f.other.userId],
		});
		expect(direct._nay).toBeUndefined();
		expect(
			(
				await f.as().mutation(api.channels_uploads.create_upload_target, {
					...request,
					membershipId: f.membershipId,
					target: { kind: "channel", channelId: direct._yay!.channelId },
				})
			)._nay?.message,
		).toBe("You have view-only access");
		const publicId = await create(f);
		expect(
			(
				await f.as(f.viewer).mutation(api.channels_uploads.create_upload_target, {
					...request,
					membershipId: f.viewer.membershipId,
					target: { kind: "channel", channelId: publicId },
				})
			)._nay?.message,
		).toBe("You have view-only access");
		await f.as().mutation(api.channels.archive_channel, { membershipId: f.membershipId, channelId: publicId });
		expect(
			(
				await f.as().mutation(api.channels_uploads.create_upload_target, {
					...request,
					membershipId: f.membershipId,
					target: { kind: "channel", channelId: publicId },
				})
			)._nay?.message,
		).toBe("This channel is archived");
		expect(await f.t.run((ctx) => ctx.db.query("channels_uploads").collect())).toEqual([]);
	});

	test("cap refusal does not consume quota or allocate bytes", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const before = await f.t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...f, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 8, usedCount: 1 });
			return ctx.db.get("quotas", quotaId);
		});
		const result = await f.as().mutation(api.channels_uploads.create_upload_target, {
			membershipId: f.membershipId,
			target: { kind: "channel", channelId },
			name: "small.bin",
			size: 8,
		});
		expect(result._nay?.message).toBe("This workspace has reached its storage limit");
		expect(await f.t.run((ctx) => ctx.db.get("quotas", before!._id))).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.query("channels_uploads").collect())).toEqual([]);
	});
});

describe("settle_channel_upload_asset", () => {
	test("R2 event settles channel bytes without Files conversion or plugin jobs", async () => {
		const f = await fixture();
		const minted = await target(f, await create(f));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("12345678", { headers: { "Content-Length": "8", ETag: '"event-etag"' } })),
		);
		enqueueActionSpy.mockClear();
		const response = await f.t.fetch("/api/r2/event", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}` },
			body: JSON.stringify({
				cloudflareMessageId: "channel-event",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: minted.asset.r2Bucket,
					object: { key: minted.key, size: 8, eTag: "event-etag" },
					eventTime: "2026-10-03T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", minted.asset._id)).then((asset) => asset?.r2Key)).toBe(
			minted.key,
		);
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());
	});

	test("client settlement and event replay bill real bytes once, past a later full cap", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const size = 20 * 1024 * 1024 + 1;
		const minted = await target(f, channelId, size + 8);
		await f.t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...f, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 10, usedCount: 10 });
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { headers: { "Content-Length": String(size), ETag: '"upload-etag"' } })),
		);
		enqueueActionSpy.mockClear();
		expect(
			(
				await f
					.as()
					.action(api.channels_uploads.settle_upload, { membershipId: f.membershipId, uploadId: minted.upload._id })
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.t.mutation(internal.r2.settle_channel_upload_asset, {
					assetId: minted.asset._id,
					r2Key: minted.key,
					size,
					eventId: "event-replay",
				})
			)._nay,
		).toBeUndefined();
		await f
			.as()
			.action(api.channels_uploads.settle_upload, { membershipId: f.membershipId, uploadId: minted.upload._id });
		await f.t.run(async (ctx) => {
			const quota = await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", f.workspaceId).eq("quotaName", "stored_file_bytes"),
				)
				.first();
			expect(quota?.usedCount, "replayed settlement must count bytes once").toBe(size + 10);
			const asset = await ctx.db.get("files_r2_assets", minted.asset._id);
			expect(asset?.size).toBe(size);
			expect(asset?.etag).toBe("upload-etag");
			expect(asset?.unfinalizedExpiresAt).toBe(minted.asset.unfinalizedExpiresAt);
			expect(await ctx.db.query("files_nodes").collect()).toEqual([]);
		});
		expect(enqueueActionSpy, "replayed settlement must bill once").toHaveBeenCalledTimes(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_upload",
					metadata: expect.objectContaining({ amount: 2, bytes: size, nodeId: null, assetId: minted.asset._id }),
				}),
			],
		});
	});

	test("oversized bytes delete asset and link without charge or quota", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		const before = await f.t.run((ctx) => ctx.db.query("quotas").collect());
		enqueueActionSpy.mockClear();
		const result = await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 9,
			eventId: "oversized-event",
		});
		await f.t.run(async (ctx) => {
			expect(
				await ctx.db.get("channels_uploads", minted.upload._id),
				"oversized upload must remove its link",
			).toBeNull();
			expect(
				await ctx.db.get("files_r2_assets", minted.asset._id),
				"oversized upload must remove its asset",
			).toBeNull();
			expect(await ctx.db.query("quotas").collect()).toEqual(before);
			const job = await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", minted.key))
				.unique();
			expect(job?.putMayArriveUntil).toBe(minted.asset.uploadUrlExpiresAt! + r2_PUT_MAY_ARRIVE_MARGIN_MS);
		});
		expect(result._nay?.message).toBe("The stored file is larger than declared");
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});
});

describe("send_message upload attachments", () => {
	test("expired ready bytes cannot attach", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		await f.t.run((ctx) => ctx.db.patch("files_r2_assets", minted.asset._id, { unfinalizedExpiresAt: Date.now() - 1 }));
		const result = await f
			.as()
			.mutation(
				api.channels_messages.send_message,
				message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]),
			);
		expect(result._nay?.message).toBe("This upload expired");
		expect(await f.t.run((ctx) => ctx.db.query("channels_messages").collect())).toEqual([]);
	});

	test.each(["discard", "stale cleanup"])(
		"unconfirmed anchor bytes stay author-only and release on %s",
		async (cleanup) => {
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
					createdBy: f.userId,
					updatedBy: f.userId,
				}),
			);
			const targetResult = await f.as().mutation(api.channels_uploads.create_upload_target, {
				membershipId: f.membershipId,
				target: { kind: "file", fileNodeId },
				name: "anchor.txt",
				size: 8,
			});
			expect(targetResult._nay).toBeUndefined();
			const upload = (await f.t.run((ctx) => ctx.db.get("channels_uploads", targetResult._yay!.uploadId)))!;
			await f.t.mutation(internal.r2.settle_channel_upload_asset, {
				assetId: upload.assetId,
				r2Key: r2_create_asset_key(upload),
				size: 8,
			});
			const sent = await f.as().mutation(api.channels_messages.send_message, {
				...message_args(f, upload.channelId, [{ kind: "upload", uploadId: upload._id }]),
				target: { kind: "file_comment", fileNodeId, anchorExcerpt: "selected text" },
			});
			expect(sent._nay).toBeUndefined();
			expect(
				(
					await f
						.as(f.member)
						.action(api.channels_uploads.get_upload_url, { membershipId: f.member.membershipId, uploadId: upload._id })
				)._nay?.message,
			).toBe("Not found");
			if (cleanup === "discard") {
				expect(
					(
						await f.as().mutation(api.channels_messages.discard_unconfirmed_comment, {
							membershipId: f.membershipId,
							rootMessageId: sent._yay!.messageId,
						})
					)._nay,
				).toBeUndefined();
			} else {
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
				await f.t.mutation(internal.channels_messages.delete_unconfirmed_comments, {});
			}
			const asset = await f.t.run((ctx) => ctx.db.get("files_r2_assets", upload.assetId));
			expect(asset?.unfinalizedExpiresAt).toBeLessThanOrEqual(Date.now());
			expect(asset?.unfinalizedExpiresAt).toBeDefined();
			expect(await f.t.run((ctx) => ctx.db.get("channels_messages", sent._yay!.messageId))).toBeNull();
		},
	);

	test("attaches once, shapes checked metadata and preserves client retry", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		const args = message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]);
		const result = await f.as().mutation(api.channels_messages.send_message, args);
		expect(result._nay).toBeUndefined();
		expect((await f.as().mutation(api.channels_messages.send_message, args))._yay).toEqual(result._yay);
		expect(
			(await f.as().mutation(api.channels_messages.send_message, { ...args, clientMessageId: "second-message" }))._nay
				?.message,
		).toBe("This upload is already attached");
		const message = await f.as(f.member).query(api.channels_messages.get_message, {
			membershipId: f.member.membershipId,
			messageId: result._yay!.messageId,
		});
		expect(message?.attachments).toEqual([
			{
				kind: "upload",
				uploadId: minted.upload._id,
				name: "Report Ü.txt",
				contentType: "text/plain;charset=utf-8",
				size: 8,
			},
		]);
		expect(message?.message.attachments).toEqual([]);
		expect(
			await f.t.run((ctx) => ctx.db.get("channels_uploads", minted.upload._id)).then((upload) => upload?.messageId),
		).toBe(result._yay!.messageId);
		expect(
			await f.t
				.run((ctx) => ctx.db.get("files_r2_assets", minted.asset._id))
				.then((asset) => asset?.unfinalizedExpiresAt),
		).toBeUndefined();
	});

	test("mixes existing Files and uploads without exposing raw attachments", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "notes.md",
				path: "/notes.md",
				treePath: "/notes.md",
				textKind: "rich_text",
				createdBy: f.userId,
				updatedBy: f.userId,
			}),
		);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		const sent = await f.as().mutation(
			api.channels_messages.send_message,
			message_args(f, channelId, [
				{ kind: "file", fileNodeId },
				{ kind: "upload", uploadId: minted.upload._id },
			]),
		);
		expect(sent._nay).toBeUndefined();
		const message = await f
			.as(f.member)
			.query(api.channels_messages.get_message, {
				membershipId: f.member.membershipId,
				messageId: sent._yay!.messageId,
			});
		expect(message?.attachments).toEqual([
			{ kind: "file", fileNodeId, name: "notes.md", path: "/notes.md" },
			{
				kind: "upload",
				uploadId: minted.upload._id,
				name: "Report Ü.txt",
				contentType: "text/plain;charset=utf-8",
				size: 8,
			},
		]);
		expect(message?.message.attachments).toEqual([]);
	});

	test("refuses another uploader, another channel, unsettled bytes and duplicates before a message write", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		const args = message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]);
		expect((await f.as().mutation(api.channels_messages.send_message, args))._nay?.message).toBe(
			"Wait for the file upload to finish",
		);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		expect(
			(
				await f
					.as(f.other)
					.mutation(api.channels_messages.send_message, { ...args, membershipId: f.other.membershipId })
			)._nay?.message,
			"only the uploader may attach bytes",
		).toBe("Upload unavailable");
		const second = await f.as().mutation(api.channels.create_channel, {
			membershipId: f.membershipId,
			kind: "public",
			name: "second",
			topic: "",
			layout: "messages",
		});
		expect(
			(
				await f.as().mutation(api.channels_messages.send_message, {
					...args,
					target: { kind: "channel", channelId: second._yay!.channelId },
				})
			)._nay?.message,
		).toBe("Upload unavailable");
		expect(
			(
				await f.as().mutation(api.channels_messages.send_message, {
					...args,
					attachments: [...args.attachments, ...args.attachments],
				})
			)._nay?.message,
		).toBe("Attach each upload once");
		expect(await f.t.run((ctx) => ctx.db.query("channels_messages").collect())).toEqual([]);
	});

	test("deleting a message releases bytes and the normal cleanup drains the link", async () => {
		const f = await fixture();
		const channelId = await create(f);
		const minted = await target(f, channelId);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		const sent = await f
			.as()
			.mutation(
				api.channels_messages.send_message,
				message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]),
			);
		const before = Date.now();
		await f.as().mutation(api.channels_messages.delete_message, {
			membershipId: f.membershipId,
			messageId: sent._yay!.messageId,
		});
		const asset = await f.t.run((ctx) => ctx.db.get("files_r2_assets", minted.asset._id));
		expect(asset?.unfinalizedExpiresAt).toBeGreaterThanOrEqual(before);
		expect(
			(
				await f.as(f.member).action(api.channels_uploads.get_upload_url, {
					membershipId: f.member.membershipId,
					uploadId: minted.upload._id,
				})
			)._nay?.message,
		).toBe("Not found");
		await f.t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: Date.now() + 1,
			_test_disableReschedule: true,
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("channels_uploads", minted.upload._id)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", minted.asset._id)).toBeNull();
			expect(
				await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", minted.key))
					.unique(),
			).not.toBeNull();
		});
	});
});

describe("get_upload_url", () => {
	test("a new workspace membership cannot reuse an old private-channel pin", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		await f
			.as()
			.mutation(api.channels.add_channel_members, {
				membershipId: f.membershipId,
				channelId,
				userIds: [f.member.userId],
				level: "member",
			});
		const minted = await target(f, channelId);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		await f
			.as()
			.mutation(
				api.channels_messages.send_message,
				message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]),
			);
		expect(
			(
				await f
					.as(f.member)
					.action(api.channels_uploads.get_upload_url, {
						membershipId: f.member.membershipId,
						uploadId: minted.upload._id,
					})
			)._nay,
		).toBeUndefined();
		const membershipId = await f.t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", f.member.membershipId, { active: false });
			return await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.member.userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
		});
		downloadUrlSpy.mockClear();
		expect(
			(await f.as(f.member).action(api.channels_uploads.get_upload_url, { membershipId, uploadId: minted.upload._id }))
				._nay?.message,
			"re-invited membership must not inherit private upload access",
		).toBe("Not found");
		expect(downloadUrlSpy).not.toHaveBeenCalled();
		expect(
			(
				await f
					.as(f.member)
					.mutation(api.channels_uploads.create_upload_target, {
						membershipId,
						target: { kind: "channel", channelId },
						name: "new.bin",
						size: 8,
					})
			)._nay?.message,
		).toBe("Not found");
	});

	test("a public channel cannot expose an unattached upload to another member", async () => {
		const f = await fixture();
		const minted = await target(f, await create(f));
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		expect(
			(
				await f.as(f.member).action(api.channels_uploads.get_upload_url, {
					membershipId: f.member.membershipId,
					uploadId: minted.upload._id,
				})
			)._nay?.message,
		).toBe("Not found");
		expect(downloadUrlSpy).not.toHaveBeenCalled();
	});

	test("file channel ACL loss hides attached bytes and shaped message metadata", async () => {
		const f = await fixture();
		const fileNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				kind: "file",
				name: "secret.md",
				path: "/secret.md",
				treePath: "/secret.md",
				textKind: "rich_text",
				createdBy: f.userId,
				updatedBy: f.userId,
			}),
		);
		const result = await f.as().mutation(api.channels_uploads.create_upload_target, {
			membershipId: f.membershipId,
			target: { kind: "file", fileNodeId },
			name: "secret.txt",
			size: 8,
		});
		const upload = (await f.t.run((ctx) => ctx.db.get("channels_uploads", result._yay!.uploadId)))!;
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: upload.assetId,
			r2Key: r2_create_asset_key(upload),
			size: 8,
		});
		const sent = await f.as().mutation(api.channels_messages.send_message, {
			...message_args(f, upload.channelId, [{ kind: "upload", uploadId: upload._id }]),
			target: { kind: "file_comment", fileNodeId, anchorExcerpt: null },
		});
		expect(sent._nay).toBeUndefined();
		expect(
			(
				await f
					.as(f.member)
					.action(api.channels_uploads.get_upload_url, { membershipId: f.member.membershipId, uploadId: upload._id })
			)._nay,
		).toBeUndefined();
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", fileNodeId, {
				restrictedScopeNodeId: fileNodeId,
				isRestrictedScopeRoot: true,
			}),
		);
		downloadUrlSpy.mockClear();
		expect(
			(
				await f
					.as(f.member)
					.action(api.channels_uploads.get_upload_url, { membershipId: f.member.membershipId, uploadId: upload._id })
			)._nay?.message,
			"live file ACL must refuse the upload URL",
		).toBe("Not found");
		expect(
			await f.as(f.member).query(api.channels_messages.get_message, {
				membershipId: f.member.membershipId,
				messageId: sent._yay!.messageId,
			}),
		).toBeNull();
		expect(downloadUrlSpy).not.toHaveBeenCalled();
	});

	test("unattached bytes are uploader-only and hidden channels leak no URL or name", async () => {
		const f = await fixture();
		const channelId = await create(f, "private");
		const minted = await target(f, channelId);
		await f.t.mutation(internal.r2.settle_channel_upload_asset, {
			assetId: minted.asset._id,
			r2Key: minted.key,
			size: 8,
		});
		const result = await f
			.as(f.other)
			.action(api.channels_uploads.get_upload_url, { membershipId: f.other.membershipId, uploadId: minted.upload._id });
		expect(result._nay?.message, "private upload must not issue a URL to an outsider").toBe("Not found");
		expect(JSON.stringify(result)).not.toContain("Report");
		expect(downloadUrlSpy).not.toHaveBeenCalled();
		const allowed = await f
			.as()
			.action(api.channels_uploads.get_upload_url, { membershipId: f.membershipId, uploadId: minted.upload._id });
		expect(allowed._nay).toBeUndefined();
		expect(downloadUrlSpy).toHaveBeenCalledWith(minted.key, {
			expiresIn: 900,
			responseContentType: "text/plain;charset=utf-8",
			responseContentDisposition: expect.stringContaining("attachment;"),
		});
		const sent = await f
			.as()
			.mutation(
				api.channels_messages.send_message,
				message_args(f, channelId, [{ kind: "upload", uploadId: minted.upload._id }]),
			);
		expect(sent._nay).toBeUndefined();
		expect(
			(
				await f.as(f.other).action(api.channels_uploads.get_upload_url, {
					membershipId: f.other.membershipId,
					uploadId: minted.upload._id,
				})
			)._nay?.message,
			"attached private upload must not issue a URL to an outsider",
		).toBe("Not found");
	});
});

describe("channel upload cleanup", () => {
	test("unattached expiry removes both docs and keeps the late PUT window", async () => {
		const f = await fixture();
		const minted = await target(f, await create(f));
		await f.t.mutation(internal.r2.cleanup_expired_unfinalized_assets, {
			_test_now: minted.asset.unfinalizedExpiresAt! + 1,
			_test_disableReschedule: true,
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("channels_uploads", minted.upload._id)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", minted.asset._id)).toBeNull();
			const job = await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", minted.key))
				.unique();
			expect(job?.putMayArriveUntil).toBe(minted.asset.uploadUrlExpiresAt! + r2_PUT_MAY_ARRIVE_MARGIN_MS);
		});
	});

	test("workspace purge drains upload links before channels", async () => {
		const f = await fixture();
		const channelId = await create(f);
		await target(f, channelId);
		await f.t.run((ctx) =>
			channels_db_purge_workspace_batch(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				batchSize: 1,
			}),
		);
		expect(await f.t.run((ctx) => ctx.db.query("channels_uploads").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("channels", channelId))).not.toBeNull();
	});
});
