import { beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "./app-convex-client.ts";
import { files_media_get_signed_url } from "./files-media-src.ts";
import { getFunctionName } from "convex/server";

const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("./app-convex-client.ts", async () => {
	const { api } = await import("../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action } };
});

const savedMedia: Parameters<typeof files_media_get_signed_url>[0]["media"] = {
	target: { kind: "saved", id: "saved_cache_1" as app_convex_Id<"files_nodes"> },
	contentType: "image/png",
	asset: {
		_id: "asset_cache_1" as app_convex_Id<"files_r2_assets">,
		_creationTime: 1,
		organizationId: "org_1" as app_convex_Id<"organizations">,
		workspaceId: "workspace_1" as app_convex_Id<"organizations_workspaces">,
		kind: "upload",
		r2Bucket: "files",
		r2Key: "images/cache.png",
		size: 10,
		createdBy: "user_1" as app_convex_Id<"users">,
		updatedAt: 1,
	},
	privateVersion: null,
};

beforeEach(() => {
	action.mockReset();
	action.mockResolvedValue({ _yay: { url: "https://images.test/signed.png" } });
});

describe("files_media_get_signed_url", () => {
	test("reuses saved URLs only for the same membership, file and asset", async () => {
		const args = {
			membershipId: "membership_cache_1" as app_convex_Id<"organizations_workspaces_users">,
			media: savedMedia,
		};
		await files_media_get_signed_url(args);
		await files_media_get_signed_url(args);
		expect(action).toHaveBeenCalledTimes(1);

		await files_media_get_signed_url({
			...args,
			membershipId: "membership_cache_2" as app_convex_Id<"organizations_workspaces_users">,
		});
		expect(action).toHaveBeenCalledTimes(2);

		await files_media_get_signed_url({
			...args,
			media: {
				...savedMedia,
				asset: { ...savedMedia.asset, _id: "asset_cache_2" as app_convex_Id<"files_r2_assets"> },
			},
		});
		expect(action).toHaveBeenCalledTimes(3);

		await files_media_get_signed_url({
			...args,
			media: { ...savedMedia, target: { kind: "saved", id: "saved_cache_2" as app_convex_Id<"files_nodes"> } },
		});
		expect(action).toHaveBeenCalledTimes(4);
	});

	test("signs every private read with its exact version and never caches the URL", async () => {
		const args: Parameters<typeof files_media_get_signed_url>[0] = {
			membershipId: "membership_private_1" as app_convex_Id<"organizations_workspaces_users">,
			media: {
				...savedMedia,
				target: { kind: "private", id: "private_1" as app_convex_Id<"files_pending_nodes"> },
				privateVersion: {
					pendingUpdateId: "proposal_1" as app_convex_Id<"files_pending_updates">,
					reviewedRevision: 4,
					creationGeneration: 2,
				},
			},
		};
		expect((await files_media_get_signed_url(args))._yay).toBe("https://images.test/signed.png");
		action.mockResolvedValue({ _nay: { message: "Access denied" } });
		expect((await files_media_get_signed_url(args))._nay?.message).toBe("Access denied");
		expect(action).toHaveBeenCalledTimes(2);
		expect(getFunctionName(action.mock.calls[1]![0])).toBe("files_pending_updates:create_private_pending_download_url");
		expect(action.mock.calls[1]![1]).toEqual({
			membershipId: args.membershipId,
			target: args.media.target,
			pendingUpdateId: "proposal_1",
			reviewedRevision: 4,
			creationGeneration: 2,
		});
	});
});
