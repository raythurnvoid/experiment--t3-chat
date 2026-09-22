import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_media_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${key}`);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "media-team", workspaceName: "home" }),
	);
	const home = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const invited = await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userIdToAdd: home.userId,
	});
	if (invited._nay) throw new Error(invited._nay.message);
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected an invited membership");
	const scope = { ...owner, userId: home.userId, membershipId: membership._id };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const prepared = await t.mutation(internal.files_ingestion.prepare_file, {
		...scope,
		requestId: "media-draft",
		attemptId: "media-attempt",
		path: "/photo.png",
		size: 4,
		contentType: "image/png",
		digest: "a".repeat(64),
		content: { kind: "stored" },
	});
	if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected a stored preparation");
	const upload = prepared._yay;
	const completed = await t.mutation(internal.files_ingestion.finalize_file, {
		...scope,
		receiptId: upload.receiptId,
		attemptId: "media-attempt",
	});
	if (completed._nay || completed._yay.target.kind !== "private") throw new Error("Expected private media");
	const target = completed._yay.target;
	const src = `bonobo-file://private/${target.id}`;
	return { t, owner, home, scope, asUser, asOwner, upload, target, src };
}

async function save_media(f: Awaited<ReturnType<typeof fixture>>) {
	const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
		membershipId: f.scope.membershipId,
		target: f.target,
	});
	if (!view?.entry.pendingUpdate) throw new Error("Expected a media proposal");
	const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
		membershipId: f.scope.membershipId,
		target: f.target,
		pendingUpdateId: view.entry.pendingUpdate._id,
		reviewedRevision: view.entry.pendingUpdate.revision,
	});
	if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
	return saved._yay.target;
}

describe("get_media_by_reference", () => {
	test("only the draft owner can read unsaved media, with its exact review version", async () => {
		const f = await fixture();
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.scope.membershipId,
			target: f.target,
		});
		const pending = view?.entry.pendingUpdate;
		if (!pending) throw new Error("Expected a media proposal");
		const node = await f.t.run((ctx) => ctx.db.get("files_pending_nodes", f.target.id));
		const before = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).toMatchObject({
			target: f.target,
			contentType: "image/png",
			asset: { _id: f.upload.assetId, r2Key: f.upload.r2Key },
			privateVersion: {
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
				creationGeneration: node!.creationGeneration,
			},
		});
		expect(
			await f.asOwner.query(api.r2.get_media_by_reference, {
				membershipId: f.owner.membershipId,
				src: f.src,
			}),
		).toBeNull();
		expect(
			await f.asOwner.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect())).toEqual(before);
		expect(vi.spyOn(R2.prototype, "getUrl")).not.toHaveBeenCalled();
	});

	test("the same private reference resolves after Save and after draft receipts expire", async () => {
		const f = await fixture();
		const target = await save_media(f);
		for (const src of [f.src, `bonobo-file://${target.id}`]) {
			expect(
				await f.asOwner.query(api.r2.get_media_by_reference, {
					membershipId: f.owner.membershipId,
					src,
				}),
			).toMatchObject({ target, privateVersion: null, asset: { _id: f.upload.assetId } });
		}
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
		await f.t.mutation(internal.files_pending_nodes.cleanup_published_nodes, {});
		await f.t.mutation(internal.files_ingestion.cleanup_expired_receipts, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", f.target.id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).toMatchObject({ target, privateVersion: null, asset: { _id: f.upload.assetId } });
	});

	test("a published private reference follows the saved file's current access rules", async () => {
		const f = await fixture();
		const target = await save_media(f);
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).not.toBeNull();
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: target.id,
			}),
		).toEqual({ _yay: null });
		for (const src of [f.src, `bonobo-file://${target.id}`]) {
			expect(
				await f.asUser.query(api.r2.get_media_by_reference, {
					membershipId: f.scope.membershipId,
					src,
				}),
			).toBeNull();
			expect(
				await f.asOwner.query(api.r2.get_media_by_reference, {
					membershipId: f.owner.membershipId,
					src,
				}),
			).toMatchObject({ target });
		}
	});

	test("published media stays inside its workspace and disappears when archived", async () => {
		const f = await fixture();
		const target = await save_media(f);
		for (const src of [f.src, `bonobo-file://${target.id}`]) {
			expect(
				await f.asUser.query(api.r2.get_media_by_reference, {
					membershipId: f.home.membershipId,
					src,
				}),
			).toBeNull();
		}
		expect(
			await f.asOwner.mutation(api.files_nodes.archive_nodes, {
				membershipId: f.owner.membershipId,
				nodeIds: [target.id],
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.query(api.r2.get_media_by_reference, {
				membershipId: f.owner.membershipId,
				src: f.src,
			}),
		).toBeNull();
	});

	test("rejects invalid references and wrong-table IDs without exposing file data", async () => {
		const f = await fixture();
		for (const src of [
			"https://example.test/photo.png",
			"data:image/png;base64,eA==",
			"bonobo-file://private/",
			`bonobo-file://${f.target.id}`,
			`bonobo-file://private/${f.upload.assetId}`,
			`bonobo-file://private/${f.target.id}/more`,
			`bonobo-file://private/${f.target.id}?query`,
			`bonobo-file://private/${f.target.id}#hash`,
			"bonobo-file://not-an-id",
		]) {
			expect(
				await f.asUser.query(api.r2.get_media_by_reference, {
					membershipId: f.scope.membershipId,
					src,
				}),
			).toBeNull();
		}
		await expect(
			f.t.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).rejects.toThrow("Unauthenticated");
	});

	test("revoking the membership removes private media access", async () => {
		const f = await fixture();
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).not.toBeNull();
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.scope.membershipId, { active: false }));
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.scope.membershipId,
				src: f.src,
			}),
		).toBeNull();
	});

	test.each(["unfinalized", "retired", "wrong size", "missing hold"] as const)(
		"does not expose a draft with %s storage",
		async (state) => {
			const f = await fixture();
			await f.t.run(async (ctx) => {
				if (state === "unfinalized")
					await ctx.db.patch("files_r2_assets", f.upload.assetId, { unfinalizedExpiresAt: Date.now() });
				if (state === "retired")
					await ctx.db.patch("files_r2_assets", f.upload.assetId, { uploadRetiredAt: Date.now() });
				if (state === "wrong size") await ctx.db.patch("files_r2_assets", f.upload.assetId, { size: 5 });
				if (state === "missing hold") {
					const reservation = await ctx.db
						.query("files_private_storage_reservations")
						.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", f.upload.assetId))
						.first();
					if (!reservation) throw new Error("Expected a storage hold");
					await ctx.db.delete("files_private_storage_reservations", reservation._id);
				}
			});
			expect(
				await f.asUser.query(api.r2.get_media_by_reference, {
					membershipId: f.scope.membershipId,
					src: f.src,
				}),
			).toBeNull();
		},
	);
});
