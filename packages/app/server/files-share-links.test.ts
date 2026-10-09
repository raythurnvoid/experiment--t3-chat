import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("share-links-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function linked_fixture() {
	const f = await fixture({ signedIn: true });
	// The future cohort has no public producer yet. Create the link through its real door first.
	await f.t.run((ctx) => ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined }));
	expect(
		await f.asUser.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: true,
		}),
	).toEqual({ _yay: null });
	await f.t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: f.cohortId });
		await ctx.db.insert("files_move_source_reservations", {
			cohortId: f.cohortId,
			source: { kind: "saved", id: f.nodeId },
			mode: "placement",
			userId: null,
			generation: 1,
		});
	});
	const link = await f.t.run((ctx) =>
		ctx.db
			.query("files_share_links")
			.withIndex("by_organization_workspace_node", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId).eq("nodeId", f.nodeId),
			)
			.unique(),
	);
	if (!link) throw new Error("Expected the public link");
	return { ...f, link, read: () => f.t.query(api.files_share_links.get_share_link_view, { token: link.token }) };
}

test("a before-only token stays readable until the switch and then grants nothing", async () => {
	const f = await linked_fixture();
	await f.t.run((ctx) =>
		ctx.db.patch("files_share_links", f.link._id, { moveView: { cohortId: f.cohortId, view: "before" } }),
	);
	expect(await f.read()).toMatchObject({ name: "old.txt", content: { kind: "plain_text", text: "old text" } });
	await f.t.run(async (ctx) => {
		const after = await ctx.db
			.query("files_saved_places")
			.withIndex("by_cohort_view_node", (q) => q.eq("cohortId", f.cohortId).eq("view", "after").eq("nodeId", f.nodeId))
			.unique();
		if (!after) throw new Error("Expected the final placement");
		await ctx.db.patch("files_saved_places", after._id, {
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
		});
	});
	await f.publish();
	expect(await f.read(), "a before-only token stops at the saved group switch").toBeNull();
});

test("the public token merges normal and selected chunks once during preparation", async () => {
	const f = await linked_fixture();
	await f.t.run(async (ctx) => {
		const chunk = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", f.db.organizationId)
					.eq("workspaceId", f.db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", f.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.first();
		if (!chunk) throw new Error("Expected saved text");
		const { _id: _id, _creationTime: _time, ...fields } = chunk;
		await ctx.db.insert("files_text_chunks", {
			...fields,
			moveView: { cohortId: f.cohortId, view: "before" },
			textChunk: "new text",
		});
	});
	expect(await f.read(), "selected chunks win duplicate keys before public text is built").toMatchObject({
		content: { kind: "plain_text", text: "new text" },
	});
});

test("creating a link is busy after access proof, while revocation remains immediate", async () => {
	const f = await linked_fixture();
	expect(
		await f.asUser.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: true,
		}),
	).toMatchObject({ _nay: { name: "move_busy" } });
	expect(
		await f.asUser.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			enabled: false,
		}),
	).toEqual({ _yay: null });
	expect(await f.read()).toBeNull();
	await f.publish();
	expect(await f.read()).toBeNull();
});
