import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	access_control_db_can_act_on_file_node,
	access_control_db_set_service_account_grant,
	type access_control_Subject,
} from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	mock_share_storage,
	fixture,
	reset_rate_limits,
	insert_installation,
	read_links,
	link_on,
	insert_media_file,
	insert_restricted_folder,
	insert_subtree_op,
	view_of,
	type Fixture,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("get_share_link_view", () => {
	test("shows the saved text to a visitor without an account, and nothing for a bad or old token", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		const view = await view_of(f, link.token);
		expect(view).toMatchObject({
			name: "doc.md",
			textKind: "rich_text",
			media: [],
			content: { kind: "rich_text" },
		});
		expect(view?.content.kind === "rich_text" && JSON.parse(view.content.json)).toMatchObject({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
		});
		expect(view?.revision).toMatch(/^[0-9a-f]{64}$/);
		// The page never receives the token or the file's private IDs.
		const body = JSON.stringify(view);
		for (const secret of [link.token, f.nodeId, f.db.organizationId, f.db.workspaceId]) {
			expect(body).not.toContain(secret);
		}

		// The same saved state gives the same revision.
		expect((await view_of(f, link.token))?.revision).toBe(view?.revision);

		for (const token of ["", "abc", link.token.toUpperCase(), `${link.token}0`, "0".repeat(64)]) {
			expect(await view_of(f, token)).toBeNull();
		}

		await reset_rate_limits(f.t, [f.db.userId]);
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		});
		expect(await view_of(f, link.token)).toBeNull();
	});

	test("shows an empty file, which stores no text, and nothing for a non-empty file with no text", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/empty.md",
			textContent: "",
		});
		const link = await link_on(f, nodeId);

		expect(await view_of(f, link.token)).toMatchObject({ name: "empty.md", content: { kind: "rich_text" } });

		const fullLink = await link_on(f, f.nodeId);
		await f.t.run(async (ctx) => {
			for (const chunk of await ctx.db.query("files_text_chunks").collect()) {
				if (chunk.sourceKind === "committed" && chunk.fileNodeId === f.nodeId) {
					await ctx.db.delete("files_text_chunks", chunk._id);
				}
			}
		});
		expect(await view_of(f, fullLink.token)).toBeNull();
	});

	test("reads the live folders above the file, not the link's stored state", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/team/notes.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const folderId = node!.parentId as Id<"files_nodes">;
		const link = await link_on(f, nodeId);
		expect(await view_of(f, link.token)).not.toBeNull();

		// Each change below skips the file lifecycle, like a job that has not reached the file yet.
		const changes = [
			{ restrictedScopeNodeId: folderId, isRestrictedScopeRoot: true },
			{ archiveOperationId: "archive-op" },
		];
		for (const change of changes) {
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", folderId));
			await f.t.run((ctx) => ctx.db.patch("files_nodes", folderId, change));
			expect(await view_of(f, link.token)).toBeNull();
			await f.t.run((ctx) => ctx.db.replace("files_nodes", folderId, before!));
			expect(await view_of(f, link.token)).not.toBeNull();
		}

		const installationId = await insert_installation(f);
		const bindingId = await f.t.run((ctx) =>
			ctx.db.insert("plugins_file_access_bindings", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				installationId,
				scopeId: "team",
				nodeId: folderId,
				updatedAt: Date.now(),
			}),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("plugins_file_access_bindings", bindingId));
		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("shows nothing while a file job or a deletion covers the file", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		// A later job on another path must not clear the block of an earlier job.
		const opId = await insert_subtree_op(f, "/");
		const otherOpId = await insert_subtree_op(f, "/other/");
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_subtree_ops", opId);
			await ctx.db.delete("files_subtree_ops", otherOpId);
		});
		expect(await view_of(f, link.token)).not.toBeNull();

		// A data-only reset of the workspace leaves no deletion request. Its purge flag alone hides the page.
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: undefined }),
		);
		expect(await view_of(f, link.token)).not.toBeNull();

		const requestId = await f.t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				scope: "workspace",
				eligibleAt: Date.now(),
			}),
		);
		expect(await view_of(f, link.token)).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("data_deletion_requests", requestId));
		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("shows an image with the same audience and hides every other image", async () => {
		const f = await fixture();
		const privateFolderId = await insert_restricted_folder(f, "private");
		const openImageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateImageId = await insert_media_file(f, {
			parentId: privateFolderId,
			path: "/private/secret.png",
			contentType: "image/png",
		});
		const svgImageId = await insert_media_file(f, {
			parentId: "root",
			path: "/logo.svg",
			contentType: "image/svg+xml",
		});
		const busyImageId = await insert_media_file(f, { parentId: "root", path: "/busy.png", contentType: "image/png" });
		// An image restricted by itself, with no restricted folder above it.
		const selfRestrictedImageId = await insert_media_file(f, {
			parentId: "root",
			path: "/restricted.png",
			contentType: "image/png",
		});
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", selfRestrictedImageId, {
				isRestrictedScopeRoot: true,
				restrictedScopeNodeId: selfRestrictedImageId,
			});
		});
		// An image at the root of another workspace. Only the tenant check can refuse it.
		const otherImageId = await insert_media_file(f, { parentId: "root", path: "/other.png", contentType: "image/png" });
		await f.t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
			const image = await ctx.db.get("files_nodes", otherImageId);
			const tenant = { organizationId: other.organizationId, workspaceId: other.workspaceId };
			await ctx.db.patch("files_nodes", otherImageId, tenant);
			await ctx.db.patch("files_r2_assets", image!.assetId!, tenant);
		});
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: [
				`![Photo](bonobo-file://${openImageId})`,
				`![Secret](bonobo-file://${privateImageId})`,
				`![Logo](bonobo-file://${svgImageId})`,
				`![Busy](bonobo-file://${busyImageId})`,
				"![Missing](bonobo-file://not-a-real-id)",
				`![Other](bonobo-file://${otherImageId})`,
				// A video tag that points at an image.
				`<video src="bonobo-file://${openImageId}"></video>`,
				`![Restricted](bonobo-file://${selfRestrictedImageId})`,
			].join("\n\n"),
		});
		const link = await link_on(f, nodeId);
		await insert_subtree_op(f, "/busy.png");

		const view = await view_of(f, link.token);
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
			{ index: 3, available: false },
			{ index: 4, available: false },
			{ index: 5, available: false },
			{ index: 6, available: false },
			{ index: 7, available: false },
		]);
		// Only the shown image keeps its alt text. The editor often fills alt with a private file name.
		const json = view?.content.kind === "rich_text" ? view.content.json : "";
		expect(json).toContain('"alt":"Photo"');
		for (const hidden of [
			"Secret",
			"Logo",
			"Busy",
			"Missing",
			"Other",
			"Restricted",
			"bonobo-file",
			openImageId,
			privateImageId,
		]) {
			expect(json).not.toContain(hidden);
		}
	});

	test("shows an image of a restricted file's own scope and hides open and deeper restricted images", async () => {
		const f = await fixture();
		const teamId = await insert_restricted_folder(f, "team");
		// `/team/assets` belongs to the team scope. `/team/private` is its own restricted scope.
		const [assetsId, privateId] = await f.t.run(async (ctx) => {
			const insert_folder = (name: string, restricted: boolean) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: teamId,
					name,
					sortName: files_sort_text_key(name),
					path: `/team/${name}`,
					treePath: `/team/${name}/`,
					pathDepth: 2,
					isRestrictedScopeRoot: restricted,
					restrictedScopeNodeId: teamId,
				});
			const privateFolderId = await insert_folder("private", true);
			await ctx.db.patch("files_nodes", privateFolderId, { restrictedScopeNodeId: privateFolderId });
			return [await insert_folder("assets", false), privateFolderId];
		});
		const teamImageId = await insert_media_file(f, {
			parentId: assetsId,
			path: "/team/assets/a.png",
			contentType: "image/png",
		});
		const openImageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateImageId = await insert_media_file(f, {
			parentId: privateId,
			path: "/team/private/b.png",
			contentType: "image/png",
		});
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", teamImageId, { restrictedScopeNodeId: teamId });
			await ctx.db.patch("files_nodes", privateImageId, { restrictedScopeNodeId: privateId });
		});
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/team/doc.md",
			textContent: [teamImageId, openImageId, privateImageId].map((id) => `![a](bonobo-file://${id})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		// The team image reuses the folder walk of the file, so this also covers the cached walk.
		expect((await view_of(f, link.token))?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
		]);
	});

	test("shows a file that is restricted by itself", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", f.nodeId, { isRestrictedScopeRoot: true, restrictedScopeNodeId: f.nodeId });
		});
		const link = await link_on(f, f.nodeId);

		expect(await view_of(f, link.token)).not.toBeNull();
	});

	test("hides an open image from a writer account that cannot read it", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${imageId})`,
		});
		const link = await link_on(f, nodeId);
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		const set_grant = (
			resource: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> },
			level: "read" | "write" | null,
		) =>
			f.t.run(async (ctx) => {
				const result = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource,
					level,
				});
				expect(result._nay).toBeUndefined();
			});
		const available = async () => (await view_of(f, link.token))?.media[0]?.available;

		expect(await available()).toBe(true);
		const shown = await view_of(f, link.token);

		await set_grant({ kind: "file", nodeId }, "write");
		expect(await available()).toBe(false);
		// The hidden image changes the revision, so an old signing request is refused.
		expect((await view_of(f, link.token))?.revision).not.toBe(shown?.revision);

		await set_grant({ kind: "file", nodeId: imageId }, "read");
		expect(await available()).toBe(true);

		await set_grant({ kind: "file", nodeId: imageId }, null);
		await set_grant({ kind: "workspace" }, "read");
		expect(await available()).toBe(true);

		await set_grant({ kind: "workspace" }, null);
		await set_grant({ kind: "file", nodeId: imageId }, "read");
		// A revoked account keeps its grants. It is never skipped, so the image stays hidden.
		await f.t.run((ctx) =>
			ctx.db.patch("access_control_service_accounts", serviceAccountId, { revokedAt: Date.now() }),
		);
		expect(await available()).toBe(false);
	});

	test("shows a draft image only through the saved file it became", async () => {
		const f = await fixture();
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const privateNodeId = await f.t.run((ctx) =>
			ctx.db.insert("files_pending_nodes", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				kind: "file",
				name: "photo.png",
				parent: { kind: "root" },
				structuralRevision: 0,
				creationGeneration: 0,
				state: "published",
				closedAt: null,
			}),
		);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](${files_media_build_private_src(privateNodeId)})`,
		});
		const link = await link_on(f, nodeId);

		// The draft was not published as a saved file yet.
		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);

		await f.t.run((ctx) => ctx.db.patch("files_nodes", imageId, { publishedFromPrivateNodeId: privateNodeId }));
		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: true, kind: "image" }]);
	});

	test("hides media past the first 50", async () => {
		const f = await fixture();
		const imageIds: Id<"files_nodes">[] = [];
		for (let index = 0; index < 51; index++) {
			imageIds.push(
				await insert_media_file(f, { parentId: "root", path: `/photo-${index}.png`, contentType: "image/png" }),
			);
		}
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: imageIds.map((imageId, index) => `![Photo ${index}](bonobo-file://${imageId})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		const view = await view_of(f, link.token);
		expect(view?.media).toHaveLength(50);
		expect(view?.media.every((item) => item.available)).toBe(true);
		const json = view?.content.kind === "rich_text" ? view.content.json : "";
		expect(json).toContain('"alt":"Photo 49"');
		expect(json).not.toContain("Photo 50");
	});

	test("shows the file when checking its media spends the read limits", async () => {
		const f = await fixture();
		// Put each image under its own chain of 30 folders. The view reads every folder above each image, so
		// 50 images need more read calls than one view may use.
		const images = await f.t.run(async (ctx) => {
			const result: Array<{ parentId: Id<"files_nodes"> | "root"; path: string }> = [];
			for (let chain = 0; chain < 50; chain++) {
				let parentId: Id<"files_nodes"> | "root" = "root";
				let path = "";
				for (let depth = 0; depth < 30; depth++) {
					const name = `c${chain}-${depth}`;
					path += `/${name}`;
					parentId = await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						createdBy: f.db.userId,
						updatedBy: f.db.userId,
						parentId,
						name,
						sortName: files_sort_text_key(name),
						path,
						treePath: `${path}/`,
						pathDepth: depth + 1,
					});
				}
				result.push({ parentId, path: `${path}/photo.png` });
			}
			return result;
		});
		const imageIds: Id<"files_nodes">[] = [];
		for (const image of images) {
			imageIds.push(await insert_media_file(f, { ...image, contentType: "image/png" }));
		}
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: imageIds.map((imageId, index) => `![Photo ${index}](bonobo-file://${imageId})`).join("\n\n"),
		});
		const link = await link_on(f, nodeId);

		const view = await view_of(f, link.token);
		expect(view?.media).toHaveLength(50);
		expect(view?.media[0].available).toBe(true);
		expect(view?.media[49].available).toBe(false);
	});

	test("shows nothing when the workspace has more file jobs than one view reads", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		// Jobs on other paths do not block the file, but a view reads at most 500 of them.
		for (let index = 0; index < 500; index++) {
			await insert_subtree_op(f, `/other-${index}/`);
		}
		expect(await view_of(f, link.token)).not.toBeNull();

		await insert_subtree_op(f, "/other-500/");
		expect(await view_of(f, link.token)).toBeNull();
	});
});

/**
 * Make `R2.getUrl` return a fake URL that shows the key and the response headers it was signed with.
 */
function mock_signed_urls() {
	return vi
		.spyOn(R2.prototype, "getUrl")
		.mockImplementation(
			async (key, options) =>
				`https://r2.test/${key}?type=${options?.responseContentType}&disposition=${options?.responseContentDisposition}&ttl=${options?.expiresIn}`,
		);
}

function sign(
	f: Fixture,
	args: {
		token: string;
		revision: string;
		targets: Array<{ kind: "file" } | { kind: "embed"; index: number }>;
	},
) {
	return f.t.action(api.files_share_links.create_share_link_download_urls, args);
}

describe("create_share_link_download_urls", () => {
	test("signs the page's media by index, with neutral names, for the revision the page shows", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, {
			parentId: "root",
			path: "/Secret plan.png",
			contentType: "image/png",
		});
		const clipId = await insert_media_file(f, { parentId: "root", path: "/clip.mp4", contentType: "video/mp4" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})\n\n<video src="bonobo-file://${clipId}"></video>`,
		});
		const link = await link_on(f, nodeId);
		const view = await view_of(f, link.token);
		const revision = view!.revision;
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: true, kind: "video" },
		]);

		const signed = await sign(f, {
			token: link.token,
			revision,
			targets: [
				{ kind: "embed", index: 0 },
				{ kind: "embed", index: 1 },
			],
		});
		expect(signed._yay).toEqual({
			status: "ready",
			revision,
			urls: [
				{
					target: { kind: "embed", index: 0 },
					url: "https://r2.test/test/Secret plan.png?type=image/png&disposition=inline; filename*=UTF-8''image.png&ttl=900",
					expiresAt: expect.any(Number),
				},
				{
					target: { kind: "embed", index: 1 },
					url: "https://r2.test/test/clip.mp4?type=video/mp4&disposition=inline; filename*=UTF-8''video.mp4&ttl=900",
					expiresAt: expect.any(Number),
				},
			],
		});

		// A few of the targets prepare the same whole page, so the same revision still signs.
		const subset = await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 1 }] });
		expect(subset._yay?.status).toBe("ready");

		// A negative index must not count from the end of the media list.
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: -1 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("answers stale for an old revision, and refuses media that the page no longer shows", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})`,
		});
		const link = await link_on(f, nodeId);
		const shown = (await view_of(f, link.token))!.revision;

		expect(
			(await sign(f, { token: link.token, revision: "0".repeat(64), targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({
			status: "stale",
		});

		// Archiving the image changes the page. The old revision is stale, and the new one has no image to sign.
		await f.t.run((ctx) => ctx.db.patch("files_nodes", photoId, { archiveOperationId: "archive-op" }));
		expect(
			(await sign(f, { token: link.token, revision: shown, targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({
			status: "stale",
		});
		const current = (await view_of(f, link.token))!.revision;
		expect(current).not.toBe(shown);
		expect(await sign(f, { token: link.token, revision: current, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("answers stale after the file or one of its images gets new bytes", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})`,
		});
		const link = await link_on(f, nodeId);
		const targets = [{ kind: "embed" as const, index: 0 }];

		// A new version of a file gets a new asset, like an upload that replaces it in place.
		const replace_asset = (id: Id<"files_nodes">) =>
			f.t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", id);
				const { _id, _creationTime, ...asset } = (await ctx.db.get("files_r2_assets", node!.assetId!))!;
				const assetId = await ctx.db.insert("files_r2_assets", { ...asset, r2Key: `${asset.r2Key}-v2` });
				await ctx.db.patch("files_nodes", id, { assetId });
			});

		for (const id of [photoId, nodeId]) {
			const shown = (await view_of(f, link.token))!.revision;
			await replace_asset(id);
			expect((await sign(f, { token: link.token, revision: shown, targets }))._yay).toEqual({ status: "stale" });
		}
	});

	test("refuses the media of a page that shows as plain text", async () => {
		const f = await fixture();
		const signUrl = mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		// Each control character becomes a 6-byte `\u0001` escape in the rich JSON. So 1,000 more than a sixth
		// of the cap make the JSON too large, and the page shows its text only. 1,000 fewer stay rich. This
		// happens after the image is loaded, so only the page's media list can refuse it. Each Save step of a
		// text costs time by its size, so this is the smallest text that passes the cap.
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: `![Photo](bonobo-file://${photoId})\n\na${"\u0001".repeat(files_MAX_TEXT_CONTENT_BYTES / 6 + 1_000)}a`,
		});
		const link = await link_on(f, nodeId);
		const view = await view_of(f, link.token);
		expect(view?.content.kind).not.toBe("rich_text");
		expect(view?.media).toEqual([]);

		expect(
			await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index: 0 }] }),
		).toEqual({ _nay: { message: "Not found" } });
		expect(signUrl).not.toHaveBeenCalled();
	}, 120_000);

	test("refuses bad targets, a text file's own bytes, and a link that is off", async () => {
		const f = await fixture();
		const signUrl = mock_signed_urls();
		const link = await link_on(f, f.nodeId);
		const revision = (await view_of(f, link.token))!.revision;
		const notFound = { _nay: { message: "Not found" } };

		const refused: Array<Parameters<typeof sign>[1]> = [
			// The raw saved text is never downloaded. The page shows only its safe content.
			{ token: link.token, revision, targets: [{ kind: "file" }] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 0 }] },
			{ token: link.token, revision, targets: [] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 50 }] },
			{ token: link.token, revision, targets: [{ kind: "embed", index: 0.5 }] },
			{ token: link.token, revision, targets: Array.from({ length: 51 }, () => ({ kind: "file" as const })) },
			{ token: link.token, revision: "not-a-revision", targets: [{ kind: "file" }] },
			{ token: "0".repeat(64), revision, targets: [{ kind: "file" }] },
		];
		for (const args of refused) {
			expect(await sign(f, args)).toEqual(notFound);
		}

		await reset_rate_limits(f.t, [f.db.userId]);
		await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		});
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "file" }] })).toEqual(notFound);
		expect(signUrl).not.toHaveBeenCalled();
	});

	test("signs a shared image file under its own name", async () => {
		const f = await fixture();
		mock_signed_urls();
		const photoId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const link = await link_on(f, photoId);
		const view = await view_of(f, link.token);
		expect(view?.content).toEqual({ kind: "binary" });

		const signed = await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "file" }] });
		expect(signed._yay?.status === "ready" && signed._yay.urls[0].url).toBe(
			"https://r2.test/test/photo.png?type=image/png&disposition=inline; filename*=UTF-8''photo.png&ttl=900",
		);

		// Each target counts once.
		expect(
			await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "file" }, { kind: "file" }] }),
		).toEqual({ _nay: { message: "Not found" } });
	});

	test("charges each target to the link, shared by every visitor", async () => {
		const f = await fixture();
		mock_signed_urls();
		const link = await link_on(f, f.nodeId);
		const revision = (await view_of(f, link.token))!.revision;
		const fullPage = Array.from({ length: 50 }, (_, index) => ({ kind: "embed" as const, index }));

		// A refused target still costs its charge, because the charge runs before the page is prepared.
		for (let call = 0; call < 4; call++) {
			expect(await sign(f, { token: link.token, revision, targets: fullPage })).toEqual({
				_nay: { message: "Not found" },
			});
		}
		const limited = await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 0 }] });
		expect(limited._nay).toMatchObject({ message: "Rate limit exceeded", data: { retryAfterMs: expect.any(Number) } });

		// The bucket key is the link doc, never the token.
		const [linkDoc] = await read_links(f.t, f.nodeId);
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "files_share_link_download",
				key: linkDoc._id,
			}),
		);
		expect(await sign(f, { token: link.token, revision, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});

	test("publishes an image that an API key without download scope adds, and only that one", async () => {
		const f = await fixture();
		mock_signed_urls();
		// Keep uploaded objects in memory, so a second write can read back the first write's saved state.
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
				// Objects saved before this store existed read as empty, like the file's default stub.
				return new Response(objects.get(decodeURIComponent(url.pathname.slice(1))) ?? null, { status: 200 });
			}),
		);
		// Create the page after the store, so every object its writes read back is kept.
		const pageId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: "Start.\n",
		});
		const privateFolderId = await insert_restricted_folder(f, "private");
		const readableId = await insert_media_file(f, {
			parentId: "root",
			path: "/readable.png",
			contentType: "image/png",
		});
		const unreadableId = await insert_media_file(f, {
			parentId: "root",
			path: "/unreadable.png",
			contentType: "image/png",
		});
		const restrictedId = await insert_media_file(f, {
			parentId: privateFolderId,
			path: "/private/restricted.png",
			contentType: "image/png",
		});
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		await f.t.run(async (ctx) => {
			for (const [nodeId, level] of [
				[pageId, "write"],
				[readableId, "read"],
			] as const) {
				const granted = await access_control_db_set_service_account_grant(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					serviceAccountId,
					resource: { kind: "file", nodeId },
					level,
				});
				expect(granted._nay).toBeUndefined();
			}
		});
		// Only a signed-in account may create an API key.
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-share-owner" }));
		const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId,
			name: "Importer",
			scopes: ["files:write"],
		});
		if (key._nay) {
			throw new Error(key._nay.message);
		}
		const headers = { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" };
		const link = await link_on(f, pageId);

		// The owner approved this: an in-place API edit keeps the link, and its new images show when the
		// embed rules allow them, even though this key cannot download them itself.
		const written = await f.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({
				path: "/page.md",
				content: [readableId, unreadableId, restrictedId].map((id) => `![x](bonobo-file://${id})`).join("\n\n"),
			}),
		});
		expect(written.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);

		const view = await view_of(f, link.token);
		expect(view?.media).toEqual([
			{ index: 0, available: true, kind: "image" },
			{ index: 1, available: false },
			{ index: 2, available: false },
		]);
		const signed = await sign(f, {
			token: link.token,
			revision: view!.revision,
			targets: [{ kind: "embed", index: 0 }],
		});
		expect(signed._yay?.status).toBe("ready");
		for (const index of [1, 2]) {
			expect(
				await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index }] }),
			).toEqual({
				_nay: { message: "Not found" },
			});
		}

		// The key's own download door still refuses the image. A download key of the same account may.
		const download = (credential: string) =>
			f.t.fetch("/api/v1/files/download-urls", {
				method: "POST",
				headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
				body: JSON.stringify({ fileNodeIds: [readableId] }),
			});
		expect((await download(key._yay.credential)).status).toBe(403);
		const downloadKey = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId,
			name: "Downloader",
			scopes: ["files:download"],
		});
		if (downloadKey._nay) {
			throw new Error(downloadKey._nay.message);
		}
		expect((await download(downloadKey._yay.credential)).status).toBe(200);

		// Removing the reference changes the page. The old revision is stale, and the new page has no image.
		const removed = await f.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers,
			body: JSON.stringify({ path: "/page.md", content: "No images now.\n" }),
		});
		expect(removed.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);
		expect(
			(await sign(f, { token: link.token, revision: view!.revision, targets: [{ kind: "embed", index: 0 }] }))._yay,
		).toEqual({ status: "stale" });
		const current = (await view_of(f, link.token))!.revision;
		expect(await sign(f, { token: link.token, revision: current, targets: [{ kind: "embed", index: 0 }] })).toEqual({
			_nay: { message: "Not found" },
		});
	});
});

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
 * A signed-in member with no role, so no workspace `content.read`: a guest.
 */
async function insert_guest(f: Fixture) {
	return await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-guest" });
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
	if (key._nay) {
		throw new Error(key._nay.message);
	}
	return await f.t.fetch("/api/v1/files/write", {
		method: "POST",
		headers: { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" },
		body: JSON.stringify({ path: args.path, content: args.content }),
	});
}

/** The owner adds `userId` to `nodeId` with "Can edit". */
async function add_editor(f: Fixture, nodeId: Id<"files_nodes">, userId: Id<"users">) {
	await reset_rate_limits(f.t, [f.db.userId]);
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: f.db.membershipId,
			nodeId,
			principal: { kind: "user", userId },
			level: "write",
		}),
	).toEqual({ _yay: null });
}

describe("get_share_link_view, images added by a writer who cannot read them", () => {
	test("hides an open image that a guest editor of the page cannot read", async () => {
		const f = await fixture();
		mock_object_store();
		const pageId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/page.md",
			textContent: "Start.\n",
		});
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const guest = await insert_guest(f);
		await add_editor(f, pageId, guest.userId);
		const subject = { kind: "user", userId: guest.userId, plugin: null } as const;
		expect(await can_act(f, subject, pageId, "content.write")).toBe(true);
		expect(await can_act(f, subject, imageId, "content.read")).toBe(false);
		const link = await link_on(f, pageId);

		const written = await api_write(f, {
			as: f.t.withIdentity({ issuer: "https://clerk.test", external_id: guest.userId }),
			membershipId: guest.membershipId,
			serviceAccountId: null,
			path: "/page.md",
			content: `![x](bonobo-file://${imageId})`,
		});
		expect(written.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);

		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	});

	test("hides an image of the same restricted folder that a guest editor of the page cannot read", async () => {
		const f = await fixture();
		mock_object_store();
		const folderId = await insert_restricted_folder(f, "r");
		const pageId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/r/page.md",
			textContent: "Start.\n",
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", pageId)))?.restrictedScopeNodeId).toBe(folderId);
		const imageId = await insert_media_file(f, { parentId: folderId, path: "/r/photo.png", contentType: "image/png" });
		await f.t.run((ctx) => ctx.db.patch("files_nodes", imageId, { restrictedScopeNodeId: folderId }));
		const guest = await insert_guest(f);
		await add_editor(f, pageId, guest.userId);
		const subject = { kind: "user", userId: guest.userId, plugin: null } as const;
		expect(await can_act(f, subject, pageId, "content.write")).toBe(true);
		expect(await can_act(f, subject, imageId, "content.read")).toBe(false);
		const link = await link_on(f, pageId);

		const written = await api_write(f, {
			as: f.t.withIdentity({ issuer: "https://clerk.test", external_id: guest.userId }),
			membershipId: guest.membershipId,
			serviceAccountId: null,
			path: "/r/page.md",
			content: `![x](bonobo-file://${imageId})`,
		});
		expect(written.status).toBe(200);
		expect(await read_links(f.t, pageId)).toEqual([link]);

		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	});

	test("hides an open image from an account that writes the page through a folder above it", async () => {
		const f = await fixture();
		mock_object_store();
		const pageId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/z/page.md",
			textContent: "Start.\n",
		});
		const folderId = (await f.t.run((ctx) => ctx.db.get("files_nodes", pageId)))!.parentId as Id<"files_nodes">;
		const imageId = await insert_media_file(f, { parentId: "root", path: "/photo.png", contentType: "image/png" });
		const serviceAccountId = await f.t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				name: "Importer",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
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

		expect((await view_of(f, link.token))?.media).toEqual([{ index: 0, available: false }]);
	});
});
