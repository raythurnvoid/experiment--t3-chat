import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_mocks_fill_db_with, test_move_nodes } from "./setup.test.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../shared/files.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	fixture,
	insert_media_file,
	link_on,
	mock_share_storage,
	read_links,
	reset_rate_limits,
	view_of,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("an added editor can save an unreadable image reference but cannot publish its bytes", async () => {
	const f = await fixture();
	await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.memberId, plan: "Pro" }));
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/team/page.md",
		textContent: "Before",
	});
	const parentId = (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.parentId as Id<"files_nodes">;
	const imageId = await insert_media_file(f, { parentId, path: "/team/secret.png", contentType: "image/png" });
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: parentId,
			})
		)._nay,
	).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(
		(
			await f.asOwner.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			})
		)._nay,
	).toBeUndefined();
	const link = await link_on(f, nodeId);
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId,
				principal: { kind: "user", userId: f.memberId },
				level: "write",
			})
		)._nay,
	).toBeUndefined();
	const denied = await f.asMember.query(api.files_nodes_content.get_non_collaborative_file_content, {
		membershipId: f.memberMembershipId,
		nodeId: imageId,
	});
	expect(denied._nay?.message).toBe("Permission denied");
	expect(
		(
			await f.asMember.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.memberMembershipId,
				nodeId,
				text: `![Known image](bonobo-file://${imageId})`,
			})
		)._nay,
	).toBeUndefined();
	const view = await view_of(f, link.token);
	const signer = vi.spyOn(R2.prototype, "getUrl").mockResolvedValue("https://r2.test/image");
	const signed = await f.t.action(api.files_share_links.create_share_link_download_urls, {
		token: link.token,
		revision: view!.revision,
		targets: [{ kind: "embed", index: 0 }],
	});
	expect
		.soft(view?.media, "an unreadable reference needs publication approval")
		.toEqual([{ index: 0, available: false }]);
	expect.soft(signed._nay?.message, "an unapproved reference must not be signed").toBe("Not found");
	expect(signer).not.toHaveBeenCalled();
	expect(
		(
			await f.asMember.mutation(api.files_share_links.approve_inserted_media, {
				membershipId: f.memberMembershipId,
				nodeId,
				src: `bonobo-file://${imageId}`,
			})
		)._nay?.message,
	).toBe("Permission denied");
	// Reading the review and saving unrelated text must not approve an old reference.
	await f.asOwner.query(api.files_share_links.get_media_to_share, { membershipId: f.db.membershipId, nodeId });
	expect(
		(
			await f.asOwner.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId,
				text: `A heading\n\n![Known image](bonobo-file://${imageId})`,
			})
		)._nay,
	).toBeUndefined();
	expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	// Separate Add people grants can still authorize a deliberate insertion.
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: imageId,
				principal: { kind: "user", userId: f.memberId },
				level: "read",
			})
		)._nay,
	).toBeUndefined();
	expect(
		await f.asMember.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.memberMembershipId,
			nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _yay: { shared: true } });
	expect((await view_of(f, link.token))?.media[0]?.available).toBe(true);
});

test("turning a link on preserves old content without silently approving its images", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/page.md",
		textContent: `![Photo](bonobo-file://${imageId})`,
	});
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _yay: { shared: false } });
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	const [link] = await read_links(f.t, nodeId);
	expect((await view_of(f, link!.token))?.media).toEqual([{ index: 0, available: false }]);
	const review = await f.asOwner.query(api.files_share_links.get_media_to_share, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	const item = review!.media[0]!;
	if (!item.available) throw new Error("Expected a readable image");
	expect(item.shared).toBe(false);
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_reviewed_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: item.src,
			expectedLinkId: review!.linkId,
			expectedAssetId: item.assetId,
		}),
	).toEqual({ _yay: { shared: true } });
	expect((await view_of(f, link!.token))?.media[0]?.available).toBe(true);
});

test("private insertion approvals do not spend the publication write quota", async () => {
	const f = await fixture();
	for (let index = 0; index < 51; index++) {
		expect(
			await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				src: "bonobo-file://unused",
			}),
		).toEqual({ _yay: { shared: false } });
	}
});

test("approving inserted media does not spend the file tree write quota", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/page.md",
		textContent: `![Photo](bonobo-file://${imageId})`,
	});
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	await reset_rate_limits(f.t, [f.db.userId]);
	// An upload batch spends the tree quota on its uploads. Their approvals must still go through.
	// Freeze the limiter clock, so the drained bucket does not refill on a slow machine.
	vi.spyOn(Date, "now").mockReturnValue(Date.now());
	const drained = await f.t.run((ctx) =>
		rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: f.db.userId, count: 50 }),
	);
	expect(drained).toBeNull();
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _yay: { shared: true } });
});

test("a read-only document refuses inserted media but a manager can still review it", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/page.md",
		textContent: `![Photo](bonobo-file://${imageId})`,
	});
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	const [link] = await read_links(f.t, nodeId);
	expect(
		(
			await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId,
				writePolicy: { mode: "read_only" },
			})
		)._nay,
	).toBeUndefined();
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _nay: { name: "read_only", message: "This item is read-only." } });
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
	const review = await f.asOwner.query(api.files_share_links.get_media_to_share, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	const item = review!.media[0]!;
	if (!item.available) throw new Error("Expected a readable image");
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_reviewed_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: item.src,
			expectedLinkId: review!.linkId,
			expectedAssetId: item.assetId,
		}),
	).toEqual({ _yay: { shared: true } });
	expect((await view_of(f, link!.token))?.media[0]?.available).toBe(true);
});

test("a readable image in a different restricted area explains how to share a copy", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/secret.png", contentType: "image/png" });
	const link = await link_on(f, f.nodeId);
	await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: imageId });
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({
		_nay: {
			message:
				"“secret.png” is in a different restricted area. Copy it next to this document, then insert the copy to share it.",
		},
	});
	expect(await view_of(f, link.token)).not.toBeNull();
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
});

test("review refuses a replacement asset and an old link instead of approving the latest bytes", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/page.md",
		textContent: `![Photo](bonobo-file://${imageId})`,
	});
	const link = await link_on(f, nodeId);
	const review = await f.asOwner.query(api.files_share_links.get_media_to_share, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	const item = review!.media[0]!;
	if (!item.available) throw new Error("Expected a readable image");
	const request = {
		membershipId: f.db.membershipId,
		nodeId,
		src: item.src,
		expectedLinkId: review!.linkId,
		expectedAssetId: item.assetId,
	};
	await f.t.run(async (ctx) => {
		const { _id, _creationTime, ...asset } = (await ctx.db.get("files_r2_assets", item.assetId))!;
		const assetId = await ctx.db.insert("files_r2_assets", { ...asset, r2Key: "replacement-image" });
		await ctx.db.patch("files_nodes", imageId, { assetId });
	});
	expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	expect((await f.asOwner.mutation(api.files_share_links.approve_reviewed_media, request))._nay?.message).toContain(
		"changed",
	);
	const current = await f.asOwner.query(api.files_share_links.get_media_to_share, {
		membershipId: f.db.membershipId,
		nodeId,
	});
	const replacement = current!.media[0]!;
	if (!replacement.available) throw new Error("Expected the replacement image");
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_reviewed_media, {
			...request,
			expectedAssetId: replacement.assetId,
		}),
	).toEqual({ _yay: { shared: true } });
	await reset_rate_limits(f.t, [f.db.userId]);
	await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
		membershipId: f.db.membershipId,
		nodeId,
		enabled: false,
	});
	await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
		membershipId: f.db.membershipId,
		nodeId,
		enabled: true,
	});
	expect((await f.asOwner.mutation(api.files_share_links.approve_reviewed_media, request))._nay?.message).toContain(
		"link changed",
	);
	const [fresh] = await read_links(f.t, nodeId);
	expect((await view_of(f, fresh!.token))?.media).toEqual([{ index: 0, available: false }]);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
});

test("an inserted upload publishes only after its approved asset finishes", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const image = (await f.t.run((ctx) => ctx.db.get("files_nodes", imageId)))!;
	await f.t.run((ctx) =>
		ctx.db.patch("files_r2_assets", image.assetId!, { r2Key: undefined, unfinalizedExpiresAt: Date.now() + 60_000 }),
	);
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/page.md",
		textContent: `![Photo](bonobo-file://${imageId})`,
	});
	const link = await link_on(f, nodeId);
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _yay: { shared: true } });
	expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	await f.t.run((ctx) =>
		ctx.db.patch("files_r2_assets", image.assetId!, { r2Key: "finished-photo", unfinalizedExpiresAt: undefined }),
	);
	expect((await view_of(f, link.token))?.media[0]?.available).toBe(true);
});

test("a raw collaborative update cannot approve media when it is materialized", async () => {
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const link = await link_on(f, f.nodeId);
	const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
	const document = files_yjs_doc_create_from_text({
		text: `![Photo](bonobo-file://${imageId})`,
		rootKind: "rich_text",
	});
	if (!(document instanceof YDoc)) throw new Error("Expected a rich text document");
	const update = files_u8_to_array_buffer(encodeStateAsUpdate(document));
	document.destroy();
	expect(
		(
			await f.asOwner.mutation(api.files_nodes.yjs_push_update, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				update,
				sessionId: "raw-media",
				expectedYjsLastSequenceId: node.yjsLastSequenceId!,
			})
		)._nay,
	).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
});

test("Move stops media approval when it stops selecting the document link", async () => {
	const f = await fixture();
	const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
	const link = await link_on(f, f.nodeId);
	expect(
		await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			src: `bonobo-file://${imageId}`,
		}),
	).toEqual({ _yay: { shared: true } });
	const destination = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "dest",
	});
	let checked = false;
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [f.nodeId],
		targetParentId: destination._yay!.nodeId,
		onStep: async () => {
			if (checked || !(await read_links(f.t, f.nodeId)).length || (await view_of(f, link.token))) return;
			checked = true;
			expect(
				await f.asOwner.query(api.files_share_links.get_media_to_share, {
					membershipId: f.db.membershipId,
					nodeId: f.nodeId,
				}),
			).toBeNull();
			expect(
				await f.asOwner.mutation(api.files_share_links.approve_inserted_media, {
					membershipId: f.db.membershipId,
					nodeId: f.nodeId,
					src: `bonobo-file://${imageId}`,
				}),
			).toEqual({ _yay: { shared: false } });
		},
	});
	expect(moved._nay).toBeUndefined();
	expect(checked).toBe(true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
});

test("link removal cleans more than one page of past publication records", async () => {
	const f = await fixture();
	const link = await link_on(f, f.nodeId);
	await f.t.run(async (ctx) => {
		for (let index = 0; index < 101; index++) {
			const node = (await ctx.db.get("files_nodes", f.nodeId))!;
			const { _id, _creationTime, ...fields } = node;
			const mediaNodeId = await ctx.db.insert("files_nodes", {
				...fields,
				name: `image-${index}.png`,
				path: `/image-${index}.png`,
				treePath: `/image-${index}.png`,
			});
			await ctx.db.insert("files_share_link_media", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				linkId: link._id,
				mediaNodeId,
				assetId: node.assetId!,
				approvedBy: f.db.userId,
				approvedAt: Date.now(),
			});
		}
	});
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		}),
	).toEqual({ _yay: null });
	expect(await view_of(f, link.token)).toBeNull();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await f.t.run((ctx) => ctx.db.query("files_share_link_media").collect())).toEqual([]);
});
