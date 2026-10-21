import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { fixture, link_on, mock_share_storage, reset_rate_limits, view_of } from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("link removal cleans more than one page of old media approval docs", async () => {
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
