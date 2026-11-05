import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_create_file_checker, access_control_db_ensure_role_assignment } from "./access_control.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { test_create_saved_text_file, test_move_nodes, test_rename_node, test_spy_handler } from "./setup.test.ts";
import { rename_node } from "./files_nodes.ts";
import { advance as advance_cohort, resume, handoff, wake_waiters } from "./files_move_cohorts.ts";
import { advance_stage } from "./files_move_content.ts";
import { accept_input, seal, advance as advance_transfer, settle_cohort } from "./files_transfer.ts";
import { run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { expect_under_convex_limits, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import {
	fixture,
	insert_installation,
	mock_share_storage,
	reset_rate_limits,
	type Fixture,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function pair(
	f: Fixture,
	membershipId = f.db.membershipId,
	installationId?: Id<"plugins_workspace_installations">,
) {
	const installedId = installationId ?? (await insert_installation(f));
	return await f.t.run(async (ctx) => {
		const membership = (await ctx.db.get("organizations_workspaces_users", membershipId))!;
		return await ctx.db.insert("plugins_file_pairs", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installedId,
			userId: membership.userId,
			membershipId,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			createdAt: Date.now(),
		});
	});
}

async function consent(
	f: Fixture,
	pairId: Id<"plugins_file_pairs">,
	rootNodeId: Id<"files_nodes">,
	appliedLevel: "read" | "write" | null,
) {
	const consentId = await f.t.run((ctx) =>
		ctx.db.insert("plugins_file_consents", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			pairId,
			rootNodeId,
			requestedLevel: appliedLevel ?? "write",
			appliedLevel,
			areaEligible: false,
			open: true,
			revision: 1,
			state: appliedLevel === null ? "pending" : "applied",
			endedReason: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}),
	);
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", rootNodeId));
	if (node!.restrictedScopeNodeId !== rootNodeId) {
		await f.t.mutation(internal.files_subtree_ops.extend_node, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			nodeId: rootNodeId,
		});
	}
	return consentId;
}

async function levels(f: Fixture, pairId: Id<"plugins_file_pairs">, nodeId: Id<"files_nodes"> | null) {
	return await f.t.run(async (ctx) => {
		const checker = access_control_create_file_checker(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject: { kind: "plugin_pair", pairId },
		});
		const node = nodeId ? (await ctx.db.get("files_nodes", nodeId))! : null;
		return {
			read: await checker.can(node, "content.read"),
			write: await checker.can(node, "content.write"),
			manage: await checker.can(node, "content.permissions.manage"),
		};
	});
}

async function folder(f: Fixture, path: string) {
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/doc.md` });
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", fileId));
	return { folderId: node!.parentId as Id<"files_nodes">, fileId };
}

async function restrict(f: Fixture, nodeId: Id<"files_nodes">, restricted: boolean) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(
		restricted ? api.files_sharing.restrict_node : api.files_sharing.unrestrict_node,
		{
			membershipId: f.db.membershipId,
			nodeId,
		},
	);
	expect(result._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
}

const denied = { read: false, write: false, manage: false };
const read = { read: true, write: false, manage: false };
const write = { read: true, write: true, manage: false };

test("an owner's plugin has no owner or open-workspace bypass", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	expect(await levels(f, pairId, f.nodeId), "the owner's plugin needs its own selection").toEqual(denied);
	expect(await levels(f, pairId, null), "a pair has no workspace-root grant").toEqual(denied);
});

test.each(["read", "write", null] as const)(
	"a %s applied grant controls a selected folder and its child",
	async (level) => {
		const f = await fixture();
		const pairId = await pair(f);
		const { folderId, fileId } = await folder(f, "/selected");
		await consent(f, pairId, folderId, level);
		const expected = level === "write" ? write : level === "read" ? read : denied;
		expect(await levels(f, pairId, folderId), "the exact selection uses applied access only").toEqual(expected);
		expect(await levels(f, pairId, fileId), "the child inherits the selected folder's applied access").toEqual(
			expected,
		);
		expect(await levels(f, pairId, f.nodeId), "a selection gives no sibling access").toEqual(denied);
	},
);

test("a file selection gives no access to its parent or siblings", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	const { folderId, fileId } = await folder(f, "/selected");
	await consent(f, pairId, fileId, "write");
	expect(await levels(f, pairId, fileId), "the selected file can be edited").toEqual(write);
	expect(await levels(f, pairId, folderId), "selecting a file does not allow creating a sibling").toEqual(denied);
	expect(await levels(f, pairId, f.nodeId)).toEqual(denied);
});

test("a selected folder stops at the next restricted boundary", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	const outer = await folder(f, "/selected");
	const inner = await folder(f, "/selected/private");
	await consent(f, pairId, outer.folderId, "write");
	await restrict(f, inner.folderId, true);
	expect(await levels(f, pairId, outer.fileId)).toEqual(write);
	expect(await levels(f, pairId, inner.fileId), "a parent selection cannot cross a restricted boundary").toEqual(
		denied,
	);
	await consent(f, pairId, inner.folderId, "read");
	expect(await levels(f, pairId, inner.fileId), "a separate restricted-root selection reaches its child").toEqual(read);
});

test("a separately selected child survives ended parent consent", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	const { folderId, fileId } = await folder(f, "/selected");
	const parentConsentId = await consent(f, pairId, folderId, "write");
	await consent(f, pairId, fileId, "read");
	await f.t.run((ctx) =>
		ctx.db.patch("plugins_file_consents", parentConsentId, {
			open: false,
			appliedLevel: null,
			state: "ended",
			endedReason: "removed",
		}),
	);
	expect(await levels(f, pairId, folderId)).toEqual(denied);
	expect(await levels(f, pairId, fileId), "the child's own selection remains usable").toEqual(read);
});

test.each(["person", "installation"] as const)("a plugin pair cannot use another %s's consent", async (other) => {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const ownerPairId = await pair(f, f.db.membershipId, installationId);
	const memberPairId = await pair(f, f.memberMembershipId, installationId);
	const otherPairId = await pair(f);
	await consent(f, ownerPairId, f.nodeId, "write");
	expect(await levels(f, ownerPairId, f.nodeId)).toEqual(write);
	expect(
		await levels(f, other === "person" ? memberPairId : otherPairId, f.nodeId),
		"the other pair has no grant",
	).toEqual(denied);
});

test("an ended membership lifetime refuses even a stored applied grant", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	await consent(f, pairId, f.nodeId, "write");
	expect(await levels(f, pairId, f.nodeId)).toEqual(write);
	await f.t.run(async (ctx) => {
		const lifetime = (await ctx.db
			.query("organizations_membership_lifetimes")
			.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", f.db.userId))
			.first())!;
		await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { lifetime: lifetime.lifetime + 1 });
	});
	expect(await levels(f, pairId, f.nodeId), "old pair consent does not survive leaving and rejoining").toEqual(denied);
});

test.each(["user", "service_account"] as const)(
	"removing the last %s share keeps a plugin-only anchor",
	async (kind) => {
		const f = await fixture();
		const pairId = await pair(f);
		const { folderId, fileId } = await folder(f, "/selected");
		const accountId = await f.t.run(async (ctx) => {
			const selectedPair = (await ctx.db.get("plugins_file_pairs", pairId))!;
			return (await ctx.db.get("plugins_workspace_installations", selectedPair.installationId))!.serviceAccountId;
		});
		const principal =
			kind === "user" ? ({ kind, userId: f.memberId } as const) : ({ kind, serviceAccountId: accountId } as const);
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId: folderId,
					principal,
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		await consent(f, pairId, folderId, "read");
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId: folderId,
					principal,
				})
			)._nay,
		).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", folderId));
		expect(node!.extendedScopeNodeId, "plugin consent keeps the anchor after the last ordinary share").toBe(folderId);
		expect(await levels(f, pairId, fileId), "plugin-only consent still reaches the child").toEqual(read);
	},
);

test("unrestrict keeps a plugin-only anchor and descendant access", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	const { folderId, fileId } = await folder(f, "/selected");
	await restrict(f, folderId, true);
	await consent(f, pairId, folderId, "read");
	expect(await levels(f, pairId, fileId)).toEqual(read);
	await restrict(f, folderId, false);
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", folderId));
	expect(node!.extendedScopeNodeId, "unrestrict retains an anchor for plugin-only consent").toBe(folderId);
	expect(await levels(f, pairId, fileId), "the plugin still reads the child after unrestrict").toEqual(read);
});

test("a pair uses the published Move placement while physical cleanup is pending", async () => {
	const f = await fixture();
	const pairId = await pair(f);
	const selected = await folder(f, "/selected");
	const moved = await folder(f, "/selected/moved");
	const destination = await folder(f, "/destination");
	await consent(f, pairId, selected.folderId, "read");
	expect(await levels(f, pairId, moved.fileId)).toEqual(read);
	let checkedPublishedPlacement = false;
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [moved.folderId],
		targetParentId: destination.folderId,
		onStep: async () => {
			const placements = await f.t.run(async (ctx) => ({
				physical: await ctx.db.get("files_nodes", moved.fileId),
				saved: await files_saved_placement_db_get_node(ctx.db, moved.fileId),
			}));
			if (
				placements.physical?.path === "/selected/moved/doc.md" &&
				placements.saved?.path === "/destination/moved/doc.md"
			) {
				checkedPublishedPlacement = true;
				expect(
					await levels(f, pairId, moved.fileId),
					"published Move removes access inherited from the old parent",
				).toEqual(denied);
			}
		},
	});
	expect(result._nay).toBeUndefined();
	expect(checkedPublishedPlacement, "the real Move reached publication before physical cleanup").toBe(true);
	expect(await levels(f, pairId, moved.fileId)).toEqual(denied);
});

test.each(["rename", "move"] as const)(
	"%s work stays flat with 64 pairs selecting one folder",
	async (operation) => {
		const measurements: Array<{ count: number; calls: number; queries: number; reads: number; writes: number }> = [];
		let current = { count: 0, calls: 0, queries: 0, reads: 0, writes: 0 };
		let measuring = false;
		let nested = 0;
		for (const registered of [
			rename_node,
			accept_input,
			seal,
			advance_transfer,
			settle_cohort,
			advance_cohort,
			resume,
			handoff,
			wake_waiters,
			advance_stage,
			run_overlay_job,
		]) {
			test_spy_handler(registered, async (handler, ctx, args) => {
				// Registered handlers include the flush. Nested calls already count in their parent.
				const outer = nested++ === 0;
				const before = await ctx.meta.getTransactionMetrics();
				try {
					const result = await handler(ctx, args);
					if (measuring && outer) {
						const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
						expect_under_convex_limits(cost);
						current.calls++;
						current.queries += cost.databaseQueries;
						current.reads += cost.documentsRead;
						current.writes += cost.documentsWritten;
					}
					return result;
				} finally {
					nested--;
				}
			});
		}
		for (const count of [1, 64]) {
			const f = await fixture();
			const installationId = await insert_installation(f);
			const firstPairId = await pair(f, f.db.membershipId, installationId);
			const selected = await folder(f, "/selected");
			const destination = await folder(f, "/destination");
			const firstConsentId = await consent(f, firstPairId, selected.folderId, "read");
			await f.t.run(async (ctx) => {
				const { _id, _creationTime, ...template } = (await ctx.db.get("plugins_file_consents", firstConsentId))!;
				for (let index = 1; index < count; index++) {
					const userId = await ctx.db.insert("users", { clerkUserId: null });
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						userId,
						active: true,
						pendingOrganizationRemoval: false,
						updatedAt: Date.now(),
						displayName: "",
						sortDisplayName: "",
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					const membership = (await ctx.db.get("organizations_workspaces_users", membershipId))!;
					const pairId = await ctx.db.insert("plugins_file_pairs", {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						installationId,
						userId,
						membershipId,
						membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
						createdAt: Date.now(),
					});
					await ctx.db.insert("plugins_file_consents", { ...template, pairId });
				}
			});
			const selections = () =>
				f.t.run((ctx) =>
					ctx.db
						.query("plugins_file_consents")
						.withIndex("by_rootNode_open", (q) => q.eq("rootNodeId", selected.folderId).eq("open", true))
						.collect(),
				);
			const before = await selections();
			expect(new Set(before.map((entry) => entry.pairId)).size).toBe(count);
			await reset_rate_limits(f.t, [f.db.userId]);
			current = { count, calls: 0, queries: 0, reads: 0, writes: 0 };
			measuring = true;
			const result =
				operation === "rename"
					? await test_rename_node(f.t, f.asOwner, {
							membershipId: f.db.membershipId,
							nodeId: selected.folderId,
							path: "renamed",
						})
					: await test_move_nodes(f.t, f.asOwner, {
							membershipId: f.db.membershipId,
							itemIds: [selected.folderId],
							targetParentId: destination.folderId,
						});
			measuring = false;
			expect(result._nay).toBeUndefined();
			measurements.push(current);
			const saved = await f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, selected.folderId));
			expect(saved?.path).toBe(operation === "rename" ? "/renamed" : "/destination/selected");
			expect(await selections(), "Rename and Move do not copy paths into every consent").toEqual(before);
			expect(
				await levels(f, before.at(-1)!.pairId, selected.fileId),
				"the last pair still reads the selected folder's child",
			).toEqual(read);
		}
		expect(measurements[1]!.calls).toBeGreaterThan(1);
		expect(
			{ ...measurements[1], count: 1 },
			"Rename and Move work does not grow with the number of plugin selections",
		).toEqual(measurements[0]);
	},
	120_000,
);
