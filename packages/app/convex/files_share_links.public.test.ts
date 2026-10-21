// "Anyone on the web": a public page shows an embedded image or video only when the media file itself
// is public. These tests cover the view check, the switch, and every writer of `publicScopeNodeId`.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	test_create_saved_text_file,
	test_db_hold_move_source,
	test_mocks,
	test_mocks_fill_db_with,
	test_move_nodes,
} from "./setup.test.ts";
import {
	access_control_db_can_act_on_file_node,
	access_control_db_set_service_account_grant,
	type access_control_Subject,
} from "./access_control.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	mock_share_storage,
	fixture,
	reset_rate_limits,
	insert_installation,
	apply_binding,
	seed_big_folder,
	read_links,
	link_on,
	set_public,
	insert_media_file,
	insert_restricted_folder,
	create_restricted_folder,
	restrict_and_bind,
	view_of,
	type Fixture,
} from "./files_share_links.setup.test.ts";
import { mock_transfer_storage, start_transfer, finish_copy_with_workers } from "./files_transfer.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// #region helpers

function read_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
}

/**
 * A saved page at `path` that embeds each id as an image, with a live public link.
 */
async function linked_page(f: Fixture, path: string, imageIds: string[]) {
	const pageId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path,
		textContent: imageIds.map((id, index) => `![Image ${index}](bonobo-file://${id})`).join("\n\n"),
	});
	return { pageId, link: await link_on(f, pageId) };
}

/** Whether each embed of the page shows. */
async function shown(f: Fixture, token: string) {
	return (await view_of(f, token))?.media.map((item) => item.available);
}

async function create_folder(f: Fixture, parentId: Id<"files_nodes"> | "root", path: string) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const created = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay.nodeId;
}

/** An open folder `/${name}` with an image inside, both public after the folder's scope job. */
async function public_folder_with_image(f: Fixture, name: string) {
	const folderId = await create_folder(f, "root", name);
	const imageId = await insert_media_file(f, { parentId: folderId, path: `/${name}/a.png`, contentType: "image/png" });
	expect(await set_public(f, folderId)).toEqual({ public: "on" });
	expect((await read_node(f, imageId))?.publicScopeNodeId).toBe(folderId);
	return { folderId, imageId };
}

/** Set an image node's fields by hand, like a stale pointer that no writer made. */
function patch_node(f: Fixture, nodeId: Id<"files_nodes">, fields: Partial<Doc<"files_nodes">>) {
	return f.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, fields));
}

/**
 * A signed-in member with no role, so no workspace `content.read`: a guest.
 */
async function insert_guest(f: Fixture, clerkUserId: string) {
	const ids = await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		// The membership is inserted directly, so its plan and API key quota are too. An API write costs a cent.
		await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
		await quotas_db_ensure(ctx, {
			quotaName: "active_api_credentials",
			userId,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			now: Date.now(),
		});
		return { userId, membershipId };
	});
	return { ...ids, as: f.t.withIdentity({ issuer: "https://clerk.test", external_id: ids.userId }) };
}

/** The owner adds `userId` to `nodeId` through Add people. */
async function add_person(f: Fixture, nodeId: Id<"files_nodes">, userId: Id<"users">, level: "read" | "write") {
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: f.db.membershipId,
			nodeId,
			principal: { kind: "user", userId },
			level,
		}),
	).toEqual({ _yay: null });
}

function can_act(
	f: Fixture,
	subject: access_control_Subject,
	nodeId: Id<"files_nodes">,
	permission: "content.read" | "content.write",
) {
	return f.t.run(async (ctx) =>
		access_control_db_can_act_on_file_node(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject,
			fileNode: (await ctx.db.get("files_nodes", nodeId))!,
			permission,
		}),
	);
}

/**
 * Keep uploaded objects in memory, so an API write can read back the saved state of an earlier write.
 */
function mock_object_store() {
	const objects = new Map<string, ArrayBuffer>();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test-upload-key",
		url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test-upload-key")}`,
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
			if (url.pathname === "/upload") {
				objects.set(url.searchParams.get("key")!, await new Response(init?.body).arrayBuffer());
				return new Response(null, { status: 200 });
			}
			return new Response(objects.get(decodeURIComponent(url.pathname.slice(1))) ?? null, { status: 200 });
		}),
	);
}

/**
 * Write `content` to `path` through the public API with a new `files:write` key.
 */
async function api_write(
	f: Fixture,
	args: {
		as: Fixture["asOwner"];
		membershipId: Id<"organizations_workspaces_users">;
		serviceAccountId: Id<"access_control_service_accounts"> | null;
		path: string;
		content: string;
	},
) {
	const key = await args.as.mutation(api.public_api.api_credential_create, {
		membershipId: args.membershipId,
		serviceAccountId: args.serviceAccountId,
		name: "Writer",
		scopes: ["files:write"],
	});
	if (key._nay) throw new Error(key._nay.message);
	return await f.t.fetch("/api/v1/files/write", {
		method: "POST",
		headers: { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" },
		body: JSON.stringify({ path: args.path, content: args.content }),
	});
}

function insert_service_account(f: Fixture, name: string) {
	return f.t.run((ctx) =>
		ctx.db.insert("access_control_service_accounts", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			name,
			createdBy: f.db.userId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			revokedAt: null,
		}),
	);
}

// #endregion helpers

describe("view", () => {
	describe("images added by a writer who cannot read them", () => {
		test("a guest editor of an open page adds an open image: hidden until a manager makes it public", async () => {
			const f = await fixture();
			mock_object_store();
			const pageId = await test_create_saved_text_file(f.t, {
				membershipId: f.db.membershipId,
				path: "/page.md",
				textContent: "Start.\n",
			});
			const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
			const guest = await insert_guest(f, "clerk-guest");
			await add_person(f, pageId, guest.userId, "write");
			const subject = { kind: "user", userId: guest.userId, plugin: null } as const;
			expect(await can_act(f, subject, pageId, "content.write")).toBe(true);
			expect(await can_act(f, subject, imageId, "content.read")).toBe(false);
			const link = await link_on(f, pageId);

			const written = await api_write(f, {
				as: guest.as,
				membershipId: guest.membershipId,
				serviceAccountId: null,
				path: "/page.md",
				content: `![x](bonobo-file://${imageId})`,
			});
			expect(written.status).toBe(200);
			expect(await read_links(f.t, pageId)).toEqual([link]);
			expect(await shown(f, link.token)).toEqual([false]);

			await set_public(f, imageId);
			expect(await shown(f, link.token)).toEqual([true]);
		}, 60_000);

		test("a guest editor of a page in a restricted folder adds an image of the same folder: hidden until public", async () => {
			const f = await fixture();
			mock_object_store();
			const folderId = await insert_restricted_folder(f, "r");
			const pageId = await test_create_saved_text_file(f.t, {
				membershipId: f.db.membershipId,
				path: "/r/page.md",
				textContent: "Start.\n",
			});
			expect((await read_node(f, pageId))?.restrictedScopeNodeId).toBe(folderId);
			const imageId = await insert_media_file(f, {
				parentId: folderId,
				path: "/r/photo.png",
				contentType: "image/png",
			});
			await patch_node(f, imageId, { restrictedScopeNodeId: folderId });
			const guest = await insert_guest(f, "clerk-guest");
			await add_person(f, pageId, guest.userId, "write");
			const subject = { kind: "user", userId: guest.userId, plugin: null } as const;
			expect(await can_act(f, subject, pageId, "content.write")).toBe(true);
			expect(await can_act(f, subject, imageId, "content.read")).toBe(false);
			const link = await link_on(f, pageId);

			const written = await api_write(f, {
				as: guest.as,
				membershipId: guest.membershipId,
				serviceAccountId: null,
				path: "/r/page.md",
				content: `![x](bonobo-file://${imageId})`,
			});
			expect(written.status).toBe(200);
			expect(await read_links(f.t, pageId)).toEqual([link]);
			// The same restricted area as the page no longer shows an image.
			expect(await shown(f, link.token)).toEqual([false]);

			await set_public(f, imageId);
			expect(await shown(f, link.token)).toEqual([true]);
		});

		test("an account with write on a folder above the page adds an open image: hidden until public", async () => {
			const f = await fixture();
			mock_object_store();
			const pageId = await test_create_saved_text_file(f.t, {
				membershipId: f.db.membershipId,
				path: "/z/page.md",
				textContent: "Start.\n",
			});
			const folderId = (await read_node(f, pageId))!.parentId as Id<"files_nodes">;
			const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
			const serviceAccountId = await insert_service_account(f, "Importer");
			await f.t.run(async (ctx) => {
				const granted = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource: { kind: "file", nodeId: folderId },
					level: "write",
				});
				expect(granted._nay).toBeUndefined();
			});
			const subject = { kind: "service_account", serviceAccountId } as const;
			expect(await can_act(f, subject, pageId, "content.write")).toBe(true);
			expect(await can_act(f, subject, imageId, "content.read")).toBe(false);
			const link = await link_on(f, pageId);

			// Only a signed-in account may create an API key.
			await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
			const written = await api_write(f, {
				as: f.asOwner,
				membershipId: f.db.membershipId,
				serviceAccountId,
				path: "/z/page.md",
				content: `![x](bonobo-file://${imageId})`,
			});
			expect(written.status).toBe(200);
			expect(await read_links(f.t, pageId)).toEqual([link]);
			expect(await shown(f, link.token)).toEqual([false]);

			await set_public(f, imageId);
			expect(await shown(f, link.token)).toEqual([true]);
		});
	});

	test("an old media approval doc does not show an image that is not public", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const { link } = await linked_page(f, "/page.md", [imageId]);
		await f.t.run(async (ctx) => {
			const image = await ctx.db.get("files_nodes", imageId);
			await ctx.db.insert("files_share_link_media", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				linkId: link._id,
				mediaNodeId: imageId,
				assetId: image!.assetId!,
				approvedBy: f.db.userId,
				approvedAt: Date.now(),
			});
		});

		expect(await shown(f, link.token)).toEqual([false]);
		// Control: the same page shows the image once it is public.
		await set_public(f, imageId);
		expect(await shown(f, link.token)).toEqual([true]);
	});

	test("shows an image inside a public folder, and one uploaded or saved there later", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");

		// An upload copies the folder's value when it creates the node.
		await reset_rate_limits(f.t, [f.db.userId]);
		const uploaded = await f.asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.db.membershipId,
			parentId: folderId,
			filename: "later.png",
			contentType: "image/png",
			size: 4,
		});
		if (uploaded._nay) throw new Error(uploaded._nay.message);
		const uploadedId = uploaded._yay.nodeId;
		expect((await read_node(f, uploadedId))?.publicScopeNodeId).toBe(folderId);
		// Finish the upload by hand. The R2 event does this in the app.
		await f.t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", uploadedId);
			await ctx.db.patch("files_r2_assets", node!.assetId!, {
				unfinalizedExpiresAt: undefined,
				r2Key: "test/later.png",
			});
		});

		// A draft saved into the folder gets the folder's value from its Move.
		const savedId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/pub/notes.md" });
		expect((await read_node(f, savedId))?.publicScopeNodeId).toBe(folderId);

		const { link } = await linked_page(f, "/page.md", [imageId, uploadedId]);
		expect(await shown(f, link.token)).toEqual([true, true]);
	});

	test("Off on a folder hides its images at once, before its job reaches them", async () => {
		const f = await fixture();
		const big = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const imageId = await insert_media_file(f, {
			parentId: big.folderId,
			path: "/big/zz.png",
			contentType: "image/png",
		});
		await set_public(f, big.folderId);
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBe(big.folderId);
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_public, {
				membershipId: f.db.membershipId,
				nodeId: big.folderId,
				enabled: false,
			}),
		).toEqual({ _yay: { public: "off" } });
		// The job has not reached the image, so only the folder's own state hides it.
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBe(big.folderId);
		expect(await shown(f, link.token)).toEqual([false]);

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);
	});

	test("hides an image whose pointer names a public file that only starts its path", async () => {
		const f = await fixture();
		const fileId = await insert_media_file(f, {
			parentId: "root",
			path: "/a.png",
			contentType: "image/png",
			public: true,
		});
		const imageId = await insert_media_file(f, { parentId: "root", path: "/a.png.jpg", contentType: "image/jpeg" });
		await patch_node(f, imageId, { publicScopeNodeId: fileId });
		const { link } = await linked_page(f, "/page.md", [imageId, fileId]);

		// Control: the public file itself shows.
		expect(await shown(f, link.token)).toEqual([false, true]);
	});

	test("hides an image whose public folder is archived, or in another area, or in another workspace", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);
		const folder = (await read_node(f, folderId))!;
		const image = (await read_node(f, imageId))!;

		await patch_node(f, folderId, { archiveOperationId: "archive-op" });
		expect(await shown(f, link.token)).toEqual([false]);
		await f.t.run((ctx) => ctx.db.replace("files_nodes", folderId, folder));
		expect(await shown(f, link.token)).toEqual([true]);

		// The image stores another live area than its public folder, like a job that has not reached it.
		const teamId = await insert_restricted_folder(f, "team");
		await patch_node(f, imageId, { restrictedScopeNodeId: teamId });
		expect(await shown(f, link.token)).toEqual([false]);
		await f.t.run((ctx) => ctx.db.replace("files_nodes", imageId, image));
		expect(await shown(f, link.token)).toEqual([true]);

		// The public folder belongs to another workspace. Only the tenant check of the folder refuses it.
		await f.t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
			await ctx.db.patch("files_nodes", folderId, {
				organizationId: other.organizationId,
				workspaceId: other.workspaceId,
			});
		});
		expect(await shown(f, link.token)).toEqual([false]);
	});

	test("hides a public image of another workspace", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, {
			parentId: "root",
			path: "/other.png",
			contentType: "image/png",
			public: true,
		});
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		await f.t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
			const image = await ctx.db.get("files_nodes", imageId);
			const tenant = { organizationId: other.organizationId, workspaceId: other.workspaceId };
			await ctx.db.patch("files_nodes", imageId, tenant);
			await ctx.db.patch("files_r2_assets", image!.assetId!, tenant);
		});
		expect(await shown(f, link.token)).toEqual([false]);
	});

	test("hides a public image in a bound area or in a dead area", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_folder(f, "team");
		const imageId = await insert_media_file(f, {
			parentId: teamId,
			path: "/team/a.png",
			contentType: "image/png",
			public: true,
		});
		await patch_node(f, imageId, { restrictedScopeNodeId: teamId });
		// The page is open, so only the image's own area can hide it.
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		// A plugin decides who reads the area. The image keeps its own flag, like one inside a bound folder.
		const installationId = await insert_installation(f);
		const bindingId = await f.t.run((ctx) =>
			ctx.db.insert("plugins_file_access_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				scopeId: "team",
				nodeId: teamId,
				updatedAt: Date.now(),
			}),
		);
		expect(await shown(f, link.token)).toEqual([false]);
		await f.t.run((ctx) => ctx.db.delete("plugins_file_access_bindings", bindingId));
		expect(await shown(f, link.token)).toEqual([true]);

		// The folder stopped being restricted, and its job has not reached the image yet.
		await patch_node(f, teamId, { restrictedScopeNodeId: null, isRestrictedScopeRoot: false });
		expect(await shown(f, link.token)).toEqual([false]);
	});

	// Each image reads its public folder and checks the folder's area, so this is the most a page reads.
	test("shows 50 images of one public restricted folder on an open page", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_folder(f, "team");
		const imageIds: Id<"files_nodes">[] = [];
		for (let index = 0; index < 50; index++) {
			const imageId = await insert_media_file(f, {
				parentId: teamId,
				path: `/team/photo-${index}.png`,
				contentType: "image/png",
			});
			await patch_node(f, imageId, { restrictedScopeNodeId: teamId });
			imageIds.push(imageId);
		}
		await set_public(f, teamId);
		expect((await read_node(f, imageIds[49]!))?.publicScopeNodeId).toBe(teamId);
		const { link } = await linked_page(f, "/page.md", imageIds);

		expect(await shown(f, link.token)).toEqual(imageIds.map(() => true));
	}, 120_000);

	test("hides a public PDF or SVG embedded as an image", async () => {
		const f = await fixture();
		const pdfId = await insert_media_file(f, {
			parentId: "root",
			path: "/a.pdf",
			contentType: "application/pdf",
			public: true,
		});
		const svgId = await insert_media_file(f, {
			parentId: "root",
			path: "/a.svg",
			contentType: "image/svg+xml",
			public: true,
		});
		const pngId = await insert_media_file(f, {
			parentId: "root",
			path: "/a.png",
			contentType: "image/png",
			public: true,
		});
		const { link } = await linked_page(f, "/page.md", [pdfId, svgId, pngId]);

		expect(await shown(f, link.token)).toEqual([false, false, true]);
	});
});

describe("set_node_public", () => {
	const set_as = async (
		f: Fixture,
		as: Fixture["asOwner"],
		membershipId: Id<"organizations_workspaces_users">,
		nodeId: Id<"files_nodes">,
		enabled: boolean,
	) => {
		await reset_rate_limits(f.t, [f.db.userId, f.memberId]);
		return await as.mutation(api.files_sharing.set_node_public, { membershipId, nodeId, enabled });
	};

	test("refuses a member without manage, a guest with Can edit, a viewer, and an anonymous On", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const editor = await insert_guest(f, "clerk-editor");
		const viewer = await insert_guest(f, "clerk-viewer");
		await add_person(f, imageId, editor.userId, "write");
		await add_person(f, imageId, viewer.userId, "read");
		const asAnonymousOwner = f.t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: f.db.userId });

		expect((await set_as(f, f.asMember, f.memberMembershipId, imageId, true))._nay?.message).toBe("Permission denied");
		await reset_rate_limits(f.t, [editor.userId, viewer.userId]);
		expect((await set_as(f, editor.as, editor.membershipId, imageId, true))._nay?.message).toBe("Permission denied");
		expect((await set_as(f, viewer.as, viewer.membershipId, imageId, true))._nay?.message).toBe("Permission denied");
		expect((await set_as(f, asAnonymousOwner, f.db.membershipId, imageId, true))._nay?.message).toBe(
			"Sign in to make files public",
		);
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBeUndefined();

		// Control: the signed-in owner may.
		expect(await set_as(f, f.asOwner, f.db.membershipId, imageId, true)).toEqual({ _yay: { public: "on" } });
	});

	test("refuses Off by a member without manage, and the flag stays", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		await set_public(f, imageId);

		expect((await set_as(f, f.asMember, f.memberMembershipId, imageId, false))._nay?.message).toBe("Permission denied");
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBe(imageId);
	});

	test("refuses a node of another workspace and a node in a bound area", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other" }),
		);
		const otherNodeId = await test_create_saved_text_file(f.t, { membershipId: other.membershipId, path: "/x.md" });
		expect((await set_as(f, f.asOwner, f.db.membershipId, otherNodeId, true))._nay?.message).toBe("Not found");

		const team = await create_restricted_folder(f, "/team");
		await restrict_and_bind(f, team.folderId);
		expect((await set_as(f, f.asOwner, f.db.membershipId, team.fileId, true))._nay?.message).toBe(
			"A plugin decides who can read this item, so it cannot be public",
		);
		expect((await read_node(f, team.fileId))?.publicScopeNodeId).toBeUndefined();
	});

	test("refuses On while a scope job above runs, and for a node a Move reserved", async () => {
		const f = await fixture();
		const big = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: big.folderId,
				})
			)._nay,
		).toBeUndefined();
		expect((await set_as(f, f.asOwner, f.db.membershipId, big.nodeId, true))._nay?.message).toBe(
			"Wait until the access change of this item or a folder above finishes",
		);
		expect((await read_node(f, big.nodeId))?.publicScopeNodeId).toBeUndefined();

		// The reservation holds the Move slot, so it comes last: later saves would wait for it.
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		await f.t.run((ctx) =>
			test_db_hold_move_source(
				ctx,
				{
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					membershipId: f.db.membershipId,
				},
				{ kind: "saved", id: imageId },
			),
		);
		expect((await set_as(f, f.asOwner, f.db.membershipId, imageId, true))._nay?.name).toBe("move_busy");
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBeUndefined();
	});

	test("a scope job below the node does not block On", async () => {
		const f = await fixture();
		const parentId = await create_folder(f, "root", "p");
		// `/p/big` has more children than one job step writes, so its restrict job keeps running.
		const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/p/big/zz.md" });
		const bigId = (await read_node(f, fileId))!.parentId as Id<"files_nodes">;
		await f.t.run(async (ctx) => {
			for (let index = 0; index < files_subtree_ops_STEP_MAX_NODES + 1; index++) {
				const name = `f${String(index).padStart(3, "0")}`;
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: bigId,
					name,
					sortName: files_sort_text_key(name),
					path: `/p/big/${name}`,
					treePath: `/p/big/${name}/`,
					pathDepth: 3,
				});
			}
		});
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: bigId }))
				._nay,
		).toBeUndefined();
		// The job has not reached the file yet.
		expect((await read_node(f, fileId))?.restrictedScopeNodeId).toBeNull();

		expect(await set_as(f, f.asOwner, f.db.membershipId, parentId, true)).toEqual({ _yay: { public: "on" } });
		expect((await read_node(f, parentId))?.publicScopeNodeId).toBe(parentId);
	});

	test("Off on an item public through a folder above is refused, and a repeated On answers at once", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");

		expect((await set_as(f, f.asOwner, f.db.membershipId, imageId, false))._nay?.message).toBe(
			"This item is public because a folder above it is public. Turn it off on that folder.",
		);
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBe(folderId);

		// A repeated On answers at once, so a double click never fails, even while a Move holds the item.
		const imageAlone = await insert_media_file(f, { parentId: "root", path: "/alone.png", contentType: "image/png" });
		expect(await set_public(f, imageAlone)).toEqual({ public: "on" });
		await f.t.run((ctx) =>
			test_db_hold_move_source(
				ctx,
				{
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					membershipId: f.db.membershipId,
				},
				{ kind: "saved", id: imageAlone },
			),
		);
		expect(await set_as(f, f.asOwner, f.db.membershipId, imageAlone, true)).toEqual({ _yay: { public: "on" } });
	});
});

describe("writers", () => {
	test("restricting the public folder itself hides its images at once and keeps them hidden", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: folderId }))
				._nay,
		).toBeUndefined();
		// A new restricted root starts not public.
		expect((await read_node(f, folderId))?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);

		// After the job the image is in the folder's area, so a kept flag would show it again.
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		const image = await read_node(f, imageId);
		expect(image?.restrictedScopeNodeId).toBe(folderId);
		expect(image?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);
	});

	test("restricting a folder above a public folder hides its images after the job", async () => {
		const f = await fixture();
		const aboveId = await create_folder(f, "root", "a");
		const folderId = await create_folder(f, aboveId, "pub");
		const imageId = await insert_media_file(f, { parentId: folderId, path: "/a/pub/x.png", contentType: "image/png" });
		await set_public(f, folderId);
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: aboveId }))
				._nay,
		).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		const folder = await read_node(f, folderId);
		expect(folder?.restrictedScopeNodeId).toBe(aboveId);
		expect(folder?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);
	});

	// Accepted rule: the items of a folder that stops being restricted take the value of the folder above.
	test("unrestricting a folder inside a public folder makes its images public after the job", async () => {
		const f = await fixture();
		const folderId = await create_folder(f, "root", "pub");
		await set_public(f, folderId);
		const inner = await create_restricted_folder(f, "/pub/r");
		expect((await read_node(f, inner.folderId))?.publicScopeNodeId).toBeUndefined();
		const imageId = await insert_media_file(f, {
			parentId: inner.folderId,
			path: "/pub/r/x.png",
			contentType: "image/png",
		});
		await patch_node(f, imageId, { restrictedScopeNodeId: inner.folderId });
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([false]);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.unrestrict_node, {
					membershipId: f.db.membershipId,
					nodeId: inner.folderId,
				})
			)._nay,
		).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_node(f, imageId)).toMatchObject({ restrictedScopeNodeId: null, publicScopeNodeId: folderId });
		expect(await shown(f, link.token)).toEqual([true]);
	});

	test("a restore to the same place keeps a public image public, and a restore to another area clears it", async () => {
		const f = await fixture();
		const archive = async (nodeIds: Id<"files_nodes">[]) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds,
			});
			expect(archived._nay).toBeUndefined();
			await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		};
		const restore = async (nodeIds: Id<"files_nodes">[]) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const restored = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds,
			});
			expect(restored._nay).toBeUndefined();
			await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		};
		const openId = await insert_media_file(f, {
			parentId: "root",
			path: "/open.png",
			contentType: "image/png",
			public: true,
		});
		const teamId = await insert_restricted_folder(f, "team");
		const teamImageId = await insert_media_file(f, {
			parentId: teamId,
			path: "/team/a.png",
			contentType: "image/png",
			public: true,
		});
		await patch_node(f, teamImageId, { restrictedScopeNodeId: teamId });
		const { link } = await linked_page(f, "/page.md", [openId, teamImageId]);
		expect(await shown(f, link.token)).toEqual([true, true]);

		await archive([openId, teamImageId]);
		expect(await shown(f, link.token)).toEqual([false, false]);
		// Archive the folder too, so the team image alone lands at the workspace root, an open area.
		await archive([teamId]);

		await restore([openId, teamImageId]);
		expect(await read_node(f, openId)).toMatchObject({ archiveOperationId: null, publicScopeNodeId: openId });
		const teamImage = await read_node(f, teamImageId);
		expect(teamImage).toMatchObject({ archiveOperationId: null, path: "/a.png", restrictedScopeNodeId: null });
		expect(teamImage?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([true, false]);
	});

	/** Copy one file into `targetParentId` as the owner, and return the new node. */
	const copy_file = async (f: Fixture, sourceId: Id<"files_nodes">, targetParentId: Id<"files_nodes">) => {
		mock_transfer_storage();
		vi.spyOn(r2_server_side_copy, "copy_object").mockResolvedValue({ outcome: "copied", size: 4, etag: "copied" });
		const started = await start_transfer(f.asOwner, {
			membershipId: f.db.membershipId,
			requestId: `copy-${sourceId}`,
			kind: "copy",
			sourceIds: [sourceId],
			targetParentId,
		});
		if (started._nay) throw new Error(started._nay.message);
		// The Copy helper only reads `t`, `db.membershipId` and `asUser` of its fixture.
		const copyFixture = { t: f.t, db: f.db, asUser: f.asOwner, folders: new Map() } as unknown as Parameters<
			typeof finish_copy_with_workers
		>[0];
		expect((await finish_copy_with_workers(copyFixture, started._yay.runId)).activity.status).toBe("succeeded");
		return await f.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.filter((q) => q.eq(q.field("parentId"), targetParentId))
				.first(),
		);
	};

	test("a copy of a public image into a folder that is not public is not public", async () => {
		const f = await fixture();
		const { imageId } = await public_folder_with_image(f, "pub");
		const plainId = await create_folder(f, "root", "plain");

		const copy = await copy_file(f, imageId, plainId);
		expect(copy?.name).toBe("a.png");
		expect(copy?.publicScopeNodeId).toBeUndefined();
		const { link } = await linked_page(f, "/page.md", [copy!._id, imageId]);
		expect(await shown(f, link.token)).toEqual([false, true]);
	});

	test("a copy into a public folder is public and shows", async () => {
		const f = await fixture();
		const folderId = await create_folder(f, "root", "pub");
		await set_public(f, folderId);
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });

		const copy = await copy_file(f, imageId, folderId);
		expect(copy?.name).toBe("photo.png");
		expect(copy?.publicScopeNodeId).toBe(folderId);
		const { link } = await linked_page(f, "/page.md", [copy!._id, imageId]);
		expect(await shown(f, link.token)).toEqual([true, false]);
	});
});

describe("plugin binding", () => {
	test("binding a restricted public folder clears its flag, and a detach does not bring it back", async () => {
		const f = await fixture();
		const team = await create_restricted_folder(f, "/team");
		await set_public(f, team.folderId);
		const imageId = await insert_media_file(f, {
			parentId: team.folderId,
			path: "/team/a.png",
			contentType: "image/png",
		});
		await patch_node(f, imageId, { restrictedScopeNodeId: team.folderId, publicScopeNodeId: team.folderId });
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		const installationId = await insert_installation(f);
		await apply_binding(f, { installationId, folderId: team.folderId, readScopeId: "team" });
		expect((await read_node(f, team.folderId))?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);

		await apply_binding(f, { installationId, folderId: team.folderId, readScopeId: null });
		expect((await read_node(f, team.folderId))?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);
	});
});

describe("Move", () => {
	const move = async (f: Fixture, args: Omit<Parameters<typeof test_move_nodes>[2], "membershipId">) => {
		await reset_rate_limits(f.t, [f.db.userId]);
		return await test_move_nodes(f.t, f.asOwner, { membershipId: f.db.membershipId, ...args });
	};

	test("a public folder moved into a restricted folder loses its flag, and so does a public folder inside it", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");
		const innerId = await create_folder(f, folderId, "inner");
		const innerImageId = await insert_media_file(f, {
			parentId: innerId,
			path: "/pub/inner/b.png",
			contentType: "image/png",
		});
		await set_public(f, innerId);
		const team = await create_restricted_folder(f, "/team");
		// An editor of the restricted folder who does not manage it.
		await add_person(f, team.folderId, f.memberId, "write");
		const { link } = await linked_page(f, "/page.md", [imageId, innerImageId]);
		expect(await shown(f, link.token)).toEqual([true, true]);

		await reset_rate_limits(f.t, [f.memberId]);
		expect(
			await test_move_nodes(f.t, f.asMember, {
				membershipId: f.memberMembershipId,
				itemIds: [folderId],
				targetParentId: team.folderId,
			}),
		).toEqual({ _yay: null });

		// Check the stored nodes after the Move ended, not only the page.
		for (const nodeId of [folderId, innerId, imageId, innerImageId]) {
			const node = await read_node(f, nodeId);
			expect(node?.moveCohortId).toBeUndefined();
			expect(node?.restrictedScopeNodeId).toBe(team.folderId);
			expect(node?.publicScopeNodeId).toBeUndefined();
		}
		expect(await shown(f, link.token)).toEqual([false, false]);
	});

	test("a public folder moved into a restricted folder is hidden already while the Move runs", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");
		const team = await create_restricted_folder(f, "/team");
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);
		let afterSteps = 0;

		const moved = await move(f, {
			itemIds: [folderId],
			targetParentId: team.folderId,
			onStep: async () => {
				const cohortId = (await read_node(f, folderId))?.moveCohortId;
				if (cohortId === undefined) return;
				// The page reads the new place once the Move shows it, before the Move writes the nodes.
				if ((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId)))?.visibleView !== "after") return;
				afterSteps++;
				expect(await shown(f, link.token)).toEqual([false]);
			},
		});

		expect(moved).toEqual({ _yay: null });
		expect(afterSteps).toBeGreaterThan(0);
		expect(await shown(f, link.token)).toEqual([false]);
	});

	test("a public item moved inside the same area keeps its own flag", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		await set_public(f, imageId);
		const destId = await create_folder(f, "root", "dest");
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);

		expect(await move(f, { itemIds: [imageId], targetParentId: destId })).toEqual({ _yay: null });
		expect(await read_node(f, imageId)).toMatchObject({ path: "/dest/photo.png", publicScopeNodeId: imageId });
		expect(await shown(f, link.token)).toEqual([true]);
	});

	test("an image moved into a public folder shows after the Move", async () => {
		const f = await fixture();
		const folderId = await create_folder(f, "root", "pub");
		await set_public(f, folderId);
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([false]);

		expect(await move(f, { itemIds: [imageId], targetParentId: folderId })).toEqual({ _yay: null });
		expect(await read_node(f, imageId)).toMatchObject({ path: "/pub/photo.png", publicScopeNodeId: folderId });
		expect(await shown(f, link.token)).toEqual([true]);
	});

	test("Off on a folder a Move holds hides its images during and after the Move, and On waits", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");
		const destId = await create_folder(f, "root", "dest");
		const { link } = await linked_page(f, "/page.md", [imageId]);
		expect(await shown(f, link.token)).toEqual([true]);
		let heldSteps = 0;

		const moved = await move(f, {
			itemIds: [folderId],
			targetParentId: destId,
			onStep: async () => {
				if ((await read_node(f, folderId))?.moveCohortId === undefined) return;
				heldSteps++;
				await reset_rate_limits(f.t, [f.db.userId]);
				if (heldSteps === 1) {
					expect(
						await f.asOwner.mutation(api.files_sharing.set_node_public, {
							membershipId: f.db.membershipId,
							nodeId: folderId,
							enabled: false,
						}),
					).toEqual({ _yay: { public: "off" } });
				} else {
					expect(
						(
							await f.asOwner.mutation(api.files_sharing.set_node_public, {
								membershipId: f.db.membershipId,
								nodeId: folderId,
								enabled: true,
							})
						)._nay?.name,
					).toBe("move_busy");
				}
				expect(await shown(f, link.token)).toEqual([false]);
			},
		});

		expect(moved).toEqual({ _yay: null });
		expect(heldSteps).toBeGreaterThan(1);
		const folder = await read_node(f, folderId);
		expect(folder?.path).toBe("/dest/pub");
		expect(folder?.publicScopeNodeId).toBeUndefined();
		expect(await shown(f, link.token)).toEqual([false]);
	});
});

describe("Sharing list", () => {
	test("names only readable images, gives every other ref one answer, and agrees with the public page", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_folder(f, "team");
		const secretId = await insert_media_file(f, {
			parentId: teamId,
			path: "/team/secret.png",
			contentType: "image/png",
		});
		await patch_node(f, secretId, { restrictedScopeNodeId: teamId });
		const goneId = await insert_media_file(f, { parentId: "root", path: "/gone.png", contentType: "image/png" });
		await f.t.run((ctx) => ctx.db.delete("files_nodes", goneId));
		// Only a restricted item can have a manager added, so the page and the managed image each sit in one.
		const pagesId = await insert_restricted_folder(f, "pages");
		const mediaId = await insert_restricted_folder(f, "media");
		const managedId = await insert_media_file(f, {
			parentId: mediaId,
			path: "/media/managed.png",
			contentType: "image/png",
		});
		await patch_node(f, managedId, { restrictedScopeNodeId: mediaId });
		await set_public(f, managedId);
		const plainId = await insert_media_file(f, { parentId: "root", path: "/plain.png", contentType: "image/png" });
		const { pageId, link } = await linked_page(f, "/pages/page.md", [secretId, goneId, managedId, plainId]);
		// The member manages the page and one image. The member role reads open files, not the team folder.
		for (const nodeId of [pagesId, mediaId]) {
			await reset_rate_limits(f.t, [f.db.userId]);
			expect(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId,
					principal: { kind: "user", userId: f.memberId },
					level: "manage",
				}),
			).toEqual({ _yay: null });
		}

		const list = await f.asMember.query(api.files_share_links.get_media_to_share, {
			membershipId: f.memberMembershipId,
			nodeId: pageId,
		});
		const hidden = { available: false, kind: "image", isPublic: false };
		expect(list?.media).toEqual([
			hidden,
			hidden,
			{ available: true, kind: "image", isPublic: true, nodeId: managedId, name: "managed.png", canManage: true },
			{ available: true, kind: "image", isPublic: false, nodeId: plainId, name: "plain.png", canManage: false },
		]);
		expect(list?.media.map((item) => item.isPublic)).toEqual(await shown(f, link.token));
	});
});

describe("tree rows", () => {
	test("a tree row of a public item has no publicScopeNodeId", async () => {
		const f = await fixture();
		const { folderId, imageId } = await public_folder_with_image(f, "pub");

		const page = await f.asOwner.query(api.files_tree.list_tree_children, {
			membershipId: f.db.membershipId,
			stream: "normal",
			parentId: folderId,
			kind: "file",
			archived: false,
			restricted: false,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(page.page.map((row) => row._id)).toEqual([imageId]);
		expect(page.page[0]).not.toHaveProperty("publicScopeNodeId");
	});
});

describe("public API", () => {
	const set_with = (f: Fixture, credential: string, nodeId: Id<"files_nodes">, isPublic: boolean) =>
		f.t.fetch("/api/v1/files/public/set", {
			method: "POST",
			headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
			body: JSON.stringify({ nodeId, public: isPublic }),
		});
	const create_key = (
		f: Fixture,
		args: {
			serviceAccountId: Id<"access_control_service_accounts"> | null;
			scopes: Array<"files:permissions" | "files:publish">;
		},
	) =>
		f.t
			.run((ctx) =>
				ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
					name: "api_credentials_write",
					key: f.db.userId,
				}),
			)
			.then(() =>
				f.asOwner.mutation(api.public_api.api_credential_create, {
					membershipId: f.db.membershipId,
					name: "Publisher",
					...args,
				}),
			);

	test("only a key of a person with files:publish turns it on", async () => {
		const f = await fixture();
		// Only a signed-in account may create an API key.
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const { link } = await linked_page(f, "/page.md", [imageId]);

		const permissionsKey = await create_key(f, { serviceAccountId: null, scopes: ["files:permissions"] });
		if (permissionsKey._nay) throw new Error(permissionsKey._nay.message);
		expect((await set_with(f, permissionsKey._yay.credential, imageId, true)).status).toBe(403);
		expect(await shown(f, link.token)).toEqual([false]);

		// A key bound to a service account cannot hold the scope at all.
		const serviceAccountId = await insert_service_account(f, "Publisher");
		const accountKey = await create_key(f, { serviceAccountId, scopes: ["files:publish"] });
		expect(accountKey._nay?.message).toBe("Choose an active service account and file scopes only");

		const publishKey = await create_key(f, { serviceAccountId: null, scopes: ["files:publish"] });
		if (publishKey._nay) throw new Error(publishKey._nay.message);
		const published = await set_with(f, publishKey._yay.credential, imageId, true);
		expect(published.status).toBe(200);
		expect(await published.json()).toEqual({ nodeId: imageId, public: "on" });
		expect(await shown(f, link.token)).toEqual([true]);

		// A spent Sharing bucket answers 429, like the other API rate limits, and changes nothing.
		await reset_rate_limits(f.t, [f.db.userId]);
		await f.t.run((ctx) => rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: f.db.userId, count: 8 }));
		expect((await set_with(f, publishKey._yay.credential, imageId, false)).status).toBe(429);
		expect(await shown(f, link.token)).toEqual([true]);
	});

	test("a key of a member who reads but does not manage the file answers 404", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		// Only a signed-in account may create an API key. The member was inserted directly, so its key quota is too.
		await f.t.run(async (ctx) => {
			await ctx.db.patch("users", f.memberId, { clerkUserId: "clerk-member" });
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: f.memberId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				now: Date.now(),
			});
		});
		const subject = { kind: "user", userId: f.memberId, plugin: null } as const;
		expect(await can_act(f, subject, imageId, "content.read")).toBe(true);
		const key = await f.asMember.mutation(api.public_api.api_credential_create, {
			membershipId: f.memberMembershipId,
			serviceAccountId: null,
			name: "Publisher",
			scopes: ["files:publish"],
		});
		if (key._nay) throw new Error(key._nay.message);

		expect((await set_with(f, key._yay.credential, imageId, true)).status).toBe(404);
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBeUndefined();
	});

	test("On while a scope job above runs answers 409", async () => {
		const f = await fixture();
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
		const big = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: big.folderId,
				})
			)._nay,
		).toBeUndefined();
		const key = await create_key(f, { serviceAccountId: null, scopes: ["files:publish"] });
		if (key._nay) throw new Error(key._nay.message);

		await reset_rate_limits(f.t, [f.db.userId]);
		const refused = await set_with(f, key._yay.credential, big.nodeId, true);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({
			message: "Wait until the access change of this item or a folder above finishes",
		});
		expect((await read_node(f, big.nodeId))?.publicScopeNodeId).toBeUndefined();
	});

	test("a plugin run token is refused", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const installationId = await insert_installation(f);
		const runToken = `plr_${"d".repeat(64)}`;
		const installation = await f.t.run(async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
			const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			// A plugin with one backend endpoint that its installation may invoke.
			await ctx.db.patch("plugins_versions", version._id, {
				backendEntrypointFile: {
					entry: "dist/backend/worker.js",
					moduleName: "plugin.js",
					r2Key: "plugins/chat/worker.js",
					sha256: `sha256:${"b".repeat(64)}`,
					compatibilityDate: "2026-07-01",
					compatibilityFlags: ["nodejs_compat"],
				},
				endpoints: [{ id: "echo", path: "/echo", serialization: "installation" }],
			});
			await ctx.db.patch("plugins_workspace_installations", installationId, {
				acceptedCapabilities: ["plugin.backend.invoke"],
			});
			await ctx.db.insert("plugins_service_account_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				pluginName: version.name,
				publisherUserId: version.createdBy,
				sourceRepositoryUrl: version.sourceRepositoryUrl,
				serviceAccountId: installation.serviceAccountId,
			});
			return installation;
		});
		const started = await f.t.mutation(internal.plugins_runtime.start_invoke_run, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			serviceAccountId: installation.serviceAccountId,
			installationId,
			pluginVersionId: installation.pluginVersionId,
			userId: f.db.userId,
			endpointId: "echo",
			callerSerializationKey: null,
			apiTokenHash: await crypto_sha256_hex(runToken),
		});
		if (started._nay) throw new Error(started._nay.message);

		const refused = await set_with(f, runToken, imageId, true);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Permission denied" });
		expect((await read_node(f, imageId))?.publicScopeNodeId).toBeUndefined();
	});
});
