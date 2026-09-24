import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionArgs } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { activities_is_active } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test-upload-key",
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

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	await t.run(async (ctx) => {
		// A real member gets this record on join. Jobs such as "Apply to contents" create it when it is
		// missing, and that moves the clock once. Create it here so each test sees only its own change.
		await organizations_membership_lifetimes_db_ensure(
			ctx,
			(await ctx.db.get("organizations_workspaces_users", db.membershipId))!,
		);
		const organization = await ctx.db.get("organizations", db.organizationId);
		if (!organization?.defaultWorkspaceId) throw new Error("Expected the default workspace");
		for (const workspaceId of [null, db.workspaceId, organization.defaultWorkspaceId]) {
			await files_media_validation_db_advance_version(ctx, { organizationId: db.organizationId, workspaceId });
		}
	});
	return { t, db, scope, asUser };
}

async function folder(
	f: Awaited<ReturnType<typeof fixture>>,
	path: string,
	parentId: Id<"files_nodes"> | "root" = "root",
) {
	const result = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId,
		path,
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.nodeId;
}

/**
 * Start "Apply to contents" and run its steps until the job finishes.
 */
async function apply_to_contents(
	f: Awaited<ReturnType<typeof fixture>>,
	asUser: Awaited<ReturnType<typeof fixture>>["asUser"],
	args: FunctionArgs<typeof api.files_write_policy_runs.start>,
) {
	const started = await asUser.mutation(api.files_write_policy_runs.start, args);
	if (started._nay) return started;
	for (let count = 0; count < 100; count++) {
		const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
		if (activity?.source.kind !== "files_write_policy_run") throw new Error("Missing protection activity");
		if (!activities_is_active(activity.status))
			return Result({ _yay: { status: activity.status, completed: activity.progress!.completed } });
		await f.t.mutation(internal.files_write_policy_runs.advance, { runId: activity.source.id });
	}
	throw new Error("The protection job did not finish");
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) => ({
		clocks: await ctx.db.query("files_media_validation_versions").collect(),
		pending: await ctx.db.query("files_pending_review_versions").collect(),
		nodes: await ctx.db.query("files_nodes").collect(),
	}));
}

async function expect_clock(
	f: Awaited<ReturnType<typeof fixture>>,
	before: Awaited<ReturnType<typeof snapshot>>,
	changed: boolean,
	pendingChanged = false,
) {
	const after = await snapshot(f);
	const previous = before.clocks.find((clock) => clock.workspaceId === f.db.workspaceId)!;
	const current = after.clocks.find((clock) => clock._id === previous._id)!;
	expect(current).toBeDefined();
	if (changed) expect(current.revision).toBeGreaterThan(previous.revision);
	else expect(current).toEqual(previous);
	expect(after.clocks.filter((clock) => clock._id !== previous._id)).toEqual(
		before.clocks.filter((clock) => clock._id !== previous._id),
	);
	if (!pendingChanged) expect(after.pending).toEqual(before.pending);
}

async function upload(f: Awaited<ReturnType<typeof fixture>>, bulk: boolean, replace = false) {
	if (bulk) {
		const result = await f.asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: f.db.membershipId,
			parentId: "root",
			onConflict: replace ? "replace" : "skip",
			items: [{ relativePath: "photo.png", contentType: "image/png", size: 1 }],
		});
		if (result._nay) throw new Error(result._nay.message);
		return result._yay.created[0]!.nodeId;
	}
	const result = await f.asUser.mutation(api.files_nodes.create_upload_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		filename: "photo.png",
		contentType: "image/png",
		size: 1,
		onConflict: replace ? "replace" : "fail",
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.nodeId;
}

async function proposal(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">) {
	const found = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", f.db.organizationId)
					.eq("workspaceId", f.db.workspaceId)
					.eq("userId", f.db.userId)
					.eq("target.kind", "saved")
					.eq("target.id", nodeId),
			)
			.first(),
	);
	if (!found) throw new Error("Expected the proposal");
	return found;
}

describe("saved file media validation clocks", () => {
	test.each(["folder", "branch/child"])(
		"advances the workspace clock when a saved folder is created: %s",
		async (path) => {
			const f = await fixture();
			const before = await snapshot(f);
			const nodeId = await folder(f, path);
			const saved = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(saved).toMatchObject({ path: `/${path}`, kind: "folder", archiveOperationId: null });
			expect((await snapshot(f)).nodes).toHaveLength(path.split("/").length);
			await expect_clock(f, before, true);
		},
	);

	test.each([false, true])("advances the workspace clock for a new stored upload (bulk: %s)", async (bulk) => {
		const f = await fixture();
		const before = await snapshot(f);
		const nodeId = await upload(f, bulk);
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node).toMatchObject({ path: "/photo.png", contentType: "image/png", archiveOperationId: null });
		expect(node?.assetId).toBeTruthy();
		await expect_clock(f, before, true);
	});

	test("advances the workspace clock when a private text file is saved", async () => {
		const f = await fixture();
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_clock_test" as never);
		const before = await snapshot(f);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/note.md",
			textContent: "Saved text",
		});
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node).toMatchObject({ path: "/note.md", kind: "file", archiveOperationId: null });
		expect(node?.assetId).toBeTruthy();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		await expect_clock(f, before, true, true);
	});

	test("advances the workspace clock for a same-workspace parent Move", async () => {
		const f = await fixture();
		const parent = await folder(f, "parent");
		const child = await folder(f, "child", parent);
		const nested = await folder(f, "restricted", parent);
		const destination = await folder(f, "destination");
		for (const nodeId of [nested, destination]) {
			expect(
				await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }),
			).toEqual({ _yay: null });
		}
		const before = await snapshot(f);
		expect(
			(
				await f.asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: f.db.membershipId,
					itemIds: [parent],
					targetParentId: destination,
				})
			)._nay,
		).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", parent))).toMatchObject({
			parentId: destination,
			path: "/destination/parent",
			restrictedScopeNodeId: destination,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toMatchObject({
			parentId: parent,
			path: "/destination/parent/child",
			treePath: "/destination/parent/child/",
			restrictedScopeNodeId: destination,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nested))).toMatchObject({
			path: "/destination/parent/restricted",
			restrictedScopeNodeId: nested,
		});
		await expect_clock(f, before, true);
	});

	test.each(["renamed", "new/parents/renamed"])(
		"advances the workspace clock when Rename changes descendant paths: %s",
		async (path) => {
			const f = await fixture();
			const parent = await folder(f, "parent");
			const child = await folder(f, "child", parent);
			const before = await snapshot(f);
			expect(
				await f.asUser.mutation(api.files_nodes.rename_node, { membershipId: f.db.membershipId, nodeId: parent, path }),
			).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", parent))).toMatchObject({ path: `/${path}` });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toMatchObject({
				parentId: parent,
				path: `/${path}/child`,
				treePath: `/${path}/child/`,
			});
			expect((await snapshot(f)).nodes).toHaveLength(path.split("/").length + 1);
			await expect_clock(f, before, true);
		},
	);

	test("advances the workspace clock when an independent pending Move is saved", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "source");
		const destination = await folder(f, "destination");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: nodeId },
					destParent: { kind: "saved", id: destination },
					destName: "source",
				})
			)._nay,
		).toBeUndefined();
		const pending = await proposal(f, nodeId);
		const before = await snapshot(f);
		expect(
			await f.asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
				membershipId: f.db.membershipId,
				target: { kind: "saved", id: nodeId },
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			parentId: destination,
			path: "/destination/source",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
		await expect_clock(f, before, true, true);
	});

	test("advances the workspace clock when a pending Move replaces a pinned saved file", async () => {
		const f = await fixture();
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_clock_test" as never);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/source.txt",
			textContent: "source",
		});
		const occupantId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/destination.txt",
			textContent: "occupant",
		});
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: nodeId },
					destParent: { kind: "root" },
					destName: "destination.txt",
					replace: true,
				})
			)._nay,
		).toBeUndefined();
		const pending = await proposal(f, nodeId);
		expect(pending.pendingMove?.replacesTarget).toEqual({ kind: "saved", id: occupantId });
		expect(pending.pendingMove?.replacesContentVersion).toBeDefined();
		const before = await snapshot(f);
		expect(
			await f.asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
				membershipId: f.db.membershipId,
				target: { kind: "saved", id: nodeId },
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			path: "/destination.txt",
			archiveOperationId: null,
			assetId: before.nodes.find((node) => node._id === nodeId)!.assetId,
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId)))?.archiveOperationId).toBeTruthy();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
		await expect_clock(f, before, true, true);
	});

	test("advances the workspace clock when related pending Moves are saved together", async () => {
		const f = await fixture();
		const parent = await folder(f, "parent");
		const child = await folder(f, "child", parent);
		const destination = await folder(f, "destination");
		for (const [nodeId, destParentId, destName] of [
			[parent, destination, "parent"],
			[child, parent, "renamed"],
		] as const) {
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...f.scope,
						target: { kind: "saved", id: nodeId },
						destParent: { kind: "saved", id: destParentId },
						destName,
					})
				)._nay,
			).toBeUndefined();
		}
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const before = await snapshot(f);
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: proposals.length,
			items: proposals.map((pending) => ({
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
		).toEqual({ _yay: null });
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		for (let pass = 0; pass < 10; pass++) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
			if (!run) throw new Error("Expected the review run");
			if (run.step === "finished") break;
			const unit = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_run_units")
					.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
					.first(),
			);
			if (!unit) throw new Error("Expected the review unit");
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: run.fence,
				unitId: unit._id,
				attemptFence: unit.attemptFence,
			});
		}
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity.status).toBe("succeeded");
		expect(result?.run).toMatchObject({ unitCount: 1, finishedUnitCount: 1 });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", parent))).toMatchObject({
			parentId: destination,
			path: "/destination/parent",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toMatchObject({
			parentId: parent,
			path: "/destination/parent/renamed",
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		await expect_clock(f, before, true, true);
	});

	test.each([false, true])(
		"advances the workspace clock when Archive hides a saved node (parent: %s)",
		async (withChild) => {
			const f = await fixture();
			const nodeId = await folder(f, "archive");
			const child = withChild ? await folder(f, "child", nodeId) : null;
			const sibling = await folder(f, "keep");
			const before = await snapshot(f);
			expect(
				await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [nodeId] }),
			).toEqual({ _yay: null });
			const archived = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(archived?.archiveOperationId).toBeTruthy();
			if (child)
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toMatchObject({
					archiveOperationId: archived!.archiveOperationId,
				});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sibling))).toEqual(
				before.nodes.find((node) => node._id === sibling),
			);
			await expect_clock(f, before, true);
		},
	);

	test.each([false, true])(
		"advances the workspace clock when upload replacement archives the old path owner (bulk: %s)",
		async (bulk) => {
			const f = await fixture();
			const oldId = await upload(f, false);
			const before = await snapshot(f);
			const newId = await upload(f, bulk, true);
			expect(newId).not.toBe(oldId);
			expect((await f.t.run((ctx) => ctx.db.get("files_nodes", oldId)))?.archiveOperationId).toBeTruthy();
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", newId))).toMatchObject({
				path: "/photo.png",
				archiveOperationId: null,
			});
			await expect_clock(f, before, true);
		},
	);

	test("advances the workspace clock when a pending Archive is saved", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "archive");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: nodeId },
				})
			)._nay,
		).toBeUndefined();
		const pending = await proposal(f, nodeId);
		const before = await snapshot(f);
		expect(
			await f.asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
				membershipId: f.db.membershipId,
				target: { kind: "saved", id: nodeId },
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).toBeTruthy();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
		await expect_clock(f, before, true, true);
	});

	test("advances the workspace clock when Unarchive restores the same placement", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "restore");
		expect(
			await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [nodeId] }),
		).toEqual({ _yay: null });
		const before = await snapshot(f);
		expect(
			await f.asUser.mutation(api.files_nodes.unarchive_nodes, { membershipId: f.db.membershipId, nodeIds: [nodeId] }),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			parentId: "root",
			path: "/restore",
			archiveOperationId: null,
		});
		await expect_clock(f, before, true);
	});

	test("advances the workspace clock when Unarchive restores below an archived parent", async () => {
		const f = await fixture();
		const parent = await folder(f, "parent");
		const child = await folder(f, "child", parent);
		const nested = await folder(f, "nested", child);
		const restricted = await folder(f, "restricted", child);
		for (const nodeId of [parent, restricted])
			expect(
				await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }),
			).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [parent] }),
		).toEqual({ _yay: null });
		const before = await snapshot(f);
		expect(
			await f.asUser.mutation(api.files_nodes.unarchive_nodes, { membershipId: f.db.membershipId, nodeIds: [child] }),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", parent)))?.archiveOperationId).toBeTruthy();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toMatchObject({
			parentId: "root",
			path: "/child",
			restrictedScopeNodeId: null,
			archiveOperationId: null,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nested))).toMatchObject({
			parentId: child,
			path: "/child/nested",
			restrictedScopeNodeId: null,
			archiveOperationId: null,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", restricted))).toMatchObject({
			path: "/child/restricted",
			restrictedScopeNodeId: restricted,
			archiveOperationId: null,
		});
		await expect_clock(f, before, true);
	});

	test.each([false, true])(
		"advances the workspace clock for each real local write-policy change (archived: %s)",
		async (archived) => {
			const f = await fixture();
			const nodeId = await folder(f, "policy");
			const child = await folder(f, "child", nodeId);
			if (archived)
				expect(
					await f.asUser.mutation(api.files_nodes.archive_nodes, {
						membershipId: f.db.membershipId,
						nodeIds: [nodeId],
					}),
				).toEqual({ _yay: null });
			const policies: Array<Doc<"files_nodes">["writePolicy"]> = [
				{ mode: "read_only" },
				{ mode: "writer", writer: { kind: "user", userId: f.db.userId } },
				null,
			];
			for (const writePolicy of policies) {
				const before = await snapshot(f);
				expect(
					await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: f.db.membershipId,
						nodeId,
						writePolicy,
					}),
				).toEqual({ _yay: null });
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual({
					...before.nodes.find((node) => node._id === nodeId)!,
					writePolicy,
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toEqual(
					before.nodes.find((node) => node._id === child),
				);
				await expect_clock(f, before, true);
			}
		},
	);

	test("advances the workspace clock for each real new-child default change", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "defaults");
		const child = await folder(f, "child", nodeId);
		for (const newChildWritePolicy of [{ mode: "read_only" } as const, null]) {
			const before = await snapshot(f);
			expect(
				await f.asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: f.db.membershipId,
					nodeId,
					newChildWritePolicy,
				}),
			).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual({
				...before.nodes.find((node) => node._id === nodeId)!,
				newChildWritePolicy,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toEqual(
				before.nodes.find((node) => node._id === child),
			);
			await expect_clock(f, before, true);
		}
	});

	test("advances the workspace clock when bulk policy changes at least one descendant", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "bulk");
		const first = await folder(f, "first", nodeId);
		const second = await folder(f, "second", nodeId);
		const archived = await folder(f, "archived", nodeId);
		expect(
			await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [archived] }),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: first,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		for (const writePolicy of [{ mode: "read_only" } as const, null]) {
			const before = await snapshot(f);
			expect(await apply_to_contents(f, f.asUser, { membershipId: f.db.membershipId, nodeId, writePolicy })).toEqual({
				_yay: { status: "succeeded", completed: writePolicy ? 1 : 2 },
			});
			for (const id of [first, second])
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", id))).toEqual({
					...before.nodes.find((node) => node._id === id)!,
					writePolicy,
				});
			for (const id of [nodeId, archived])
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", id))).toEqual(
					before.nodes.find((node) => node._id === id),
				);
			await expect_clock(f, before, true);
		}
	});

	test.each([
		"policy",
		"default",
		"bulk",
		"move",
		"rename",
		"archive",
		"restore",
		"exists",
		"empty-archive",
		"empty-restore",
	] as const)("keeps the workspace clock for a successful no-op: %s", async (operation) => {
		const f = await fixture();
		const nodeId = await folder(f, "unchanged");
		if (operation === "archive")
			expect(
				await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [nodeId] }),
			).toEqual({ _yay: null });
		const before = await snapshot(f);
		const scope = { membershipId: f.db.membershipId, nodeId };
		switch (operation) {
			case "policy":
				expect(await f.asUser.mutation(api.files_nodes.set_node_write_policy, { ...scope, writePolicy: null })).toEqual(
					{ _yay: null },
				);
				break;
			case "default":
				expect(
					await f.asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
						...scope,
						newChildWritePolicy: null,
					}),
				).toEqual({ _yay: null });
				break;
			case "bulk":
				expect(await apply_to_contents(f, f.asUser, { ...scope, writePolicy: null })).toEqual({
					_yay: { status: "succeeded", completed: 0 },
				});
				break;
			case "move":
				expect(
					(
						await f.asUser.mutation(api.files_nodes.move_nodes, {
							membershipId: scope.membershipId,
							itemIds: [nodeId],
							targetParentId: "root",
						})
					)._nay,
				).toBeUndefined();
				break;
			case "rename":
				expect(await f.asUser.mutation(api.files_nodes.rename_node, { ...scope, path: "unchanged" })).toEqual({
					_yay: null,
				});
				break;
			case "archive":
			case "empty-archive":
				expect(
					await f.asUser.mutation(api.files_nodes.archive_nodes, {
						membershipId: scope.membershipId,
						nodeIds: operation === "archive" ? [nodeId] : [],
					}),
				).toEqual({ _yay: null });
				break;
			case "restore":
			case "empty-restore":
				expect(
					await f.asUser.mutation(api.files_nodes.unarchive_nodes, {
						membershipId: scope.membershipId,
						nodeIds: operation === "restore" ? [nodeId] : [],
					}),
				).toEqual({ _yay: null });
				break;
			case "exists":
				expect(
					await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/unchanged" }),
				).toEqual({ _yay: { nodeId, exists: true } });
				break;
		}
		expect((await snapshot(f)).nodes).toEqual(before.nodes);
		await expect_clock(f, before, false);
	});

	test.each(["rename", "restore", "upload", "bulk-upload"] as const)(
		"keeps files and the workspace clock for a path conflict: %s",
		async (operation) => {
			const f = await fixture();
			const nodeId = operation.includes("upload") ? await upload(f, false) : await folder(f, "source");
			if (operation === "rename") await folder(f, "taken");
			if (operation === "restore") {
				expect(
					await f.asUser.mutation(api.files_nodes.archive_nodes, {
						membershipId: f.db.membershipId,
						nodeIds: [nodeId],
					}),
				).toEqual({ _yay: null });
				await folder(f, "source");
			}
			const before = await snapshot(f);
			if (operation === "rename")
				expect(
					(
						await f.asUser.mutation(api.files_nodes.rename_node, {
							membershipId: f.db.membershipId,
							nodeId,
							path: "taken",
						})
					)._nay,
				).toBeDefined();
			else if (operation === "restore")
				expect(
					(
						await f.asUser.mutation(api.files_nodes.unarchive_nodes, {
							membershipId: f.db.membershipId,
							nodeIds: [nodeId],
						})
					)._nay?.message,
				).toBe("Failed to unarchive file because path already exists");
			else if (operation === "upload")
				expect(
					(
						await f.asUser.mutation(api.files_nodes.create_upload_node, {
							membershipId: f.db.membershipId,
							parentId: "root",
							filename: "photo.png",
							contentType: "image/png",
							size: 1,
							onConflict: "fail",
						})
					)._nay,
				).toBeDefined();
			else {
				const result = await f.asUser.mutation(api.files_nodes.create_upload_nodes, {
					membershipId: f.db.membershipId,
					parentId: "root",
					items: [{ relativePath: "photo.png", contentType: "image/png", size: 1 }],
					onConflict: "skip",
				});
				expect(result._nay).toBeUndefined();
				expect(result._yay?.created).toEqual([]);
			}
			expect((await snapshot(f)).nodes).toEqual(before.nodes);
			await expect_clock(f, before, false);
		},
	);

	test("keeps the workspace clock when bulk policy already matches every child", async () => {
		const f = await fixture();
		const nodeId = await folder(f, "unchanged");
		await folder(f, "first", nodeId);
		await folder(f, "second", nodeId);
		const before = await snapshot(f);
		expect(
			await apply_to_contents(f, f.asUser, { membershipId: f.db.membershipId, nodeId, writePolicy: null }),
		).toEqual({ _yay: { status: "succeeded", completed: 0 } });
		expect((await snapshot(f)).nodes).toEqual(before.nodes);
		await expect_clock(f, before, false);
	});

	test("keeps files and the workspace clock when a file is given a new-child default", async () => {
		const f = await fixture();
		const nodeId = await upload(f, false);
		const before = await snapshot(f);
		const result = await f.asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
			membershipId: f.db.membershipId,
			nodeId,
			newChildWritePolicy: { mode: "read_only" },
		});
		expect(result._nay?.message).toBe("Only folders have a new-item default.");
		expect((await snapshot(f)).nodes).toEqual(before.nodes);
		await expect_clock(f, before, false);
	});

	test.each(["move", "rename", "archive", "restore", "create"] as const)(
		"keeps files and the workspace clock when read-only refuses: %s",
		async (operation) => {
			const f = await fixture();
			const nodeId = await folder(f, "locked");
			const destination = await folder(f, "destination");
			if (operation === "restore")
				expect(
					await f.asUser.mutation(api.files_nodes.archive_nodes, {
						membershipId: f.db.membershipId,
						nodeIds: [nodeId],
					}),
				).toEqual({ _yay: null });
			expect(
				await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: f.db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				}),
			).toEqual({ _yay: null });
			const before = await snapshot(f);
			const membershipId = f.db.membershipId;
			const result =
				operation === "move"
					? await f.asUser.mutation(api.files_nodes.move_nodes, {
							membershipId,
							itemIds: [nodeId],
							targetParentId: destination,
						})
					: operation === "rename"
						? await f.asUser.mutation(api.files_nodes.rename_node, { membershipId, nodeId, path: "changed" })
						: operation === "archive"
							? await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [nodeId] })
							: operation === "restore"
								? await f.asUser.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [nodeId] })
								: await f.asUser.mutation(api.files_nodes.create_folder_node, {
										membershipId,
										parentId: nodeId,
										path: "child",
									});
			expect(result._nay?.name).toBe("read_only");
			expect((await snapshot(f)).nodes).toEqual(before.nodes);
			await expect_clock(f, before, false);
		},
	);

	test.each(["policy", "default", "bulk"] as const)(
		"keeps files and the workspace clock without policy management: %s",
		async (operation) => {
			const f = await fixture();
			const nodeId = await folder(f, "policy");
			await folder(f, "child", nodeId);
			const member = await f.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "clock-viewer" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId,
					active: true,
				});
				await access_control_db_ensure_role_assignment(ctx, { ...f.scope, userId, role: "viewer", now: Date.now() });
				return { userId, membershipId };
			});
			const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
			const before = await snapshot(f);
			const args = { membershipId: member.membershipId, nodeId };
			const result =
				operation === "policy"
					? await asMember.mutation(api.files_nodes.set_node_write_policy, {
							...args,
							writePolicy: { mode: "read_only" },
						})
					: operation === "default"
						? await asMember.mutation(api.files_nodes.set_node_new_child_write_policy, {
								...args,
								newChildWritePolicy: { mode: "read_only" },
							})
						: await apply_to_contents(f, asMember, { ...args, writePolicy: { mode: "read_only" } });
			expect(result._nay).toBeDefined();
			expect((await snapshot(f)).nodes).toEqual(before.nodes);
			await expect_clock(f, before, false);
		},
	);

	test("keeps files and the workspace clock when descendant authority is missing: restore", async () => {
		const f = await fixture();
		const parent = await folder(f, "parent");
		const child = await folder(f, "child", parent);
		await folder(f, "other", parent);
		const member = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clock-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, { ...f.scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: parent,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: parent,
				principal: { kind: "user", userId: member.userId },
				level: "write",
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds: [parent],
			}),
		).toEqual({ _yay: null });
		const before = await snapshot(f);
		const result = await asMember.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [child],
		});
		expect(result._nay?.message).toContain("Can manage");
		expect((await snapshot(f)).nodes).toEqual(before.nodes);
		await expect_clock(f, before, false);
	});

	test("bulk policy skips a hidden restricted child and advances the clock for the rest", async () => {
		const f = await fixture();
		const parent = await folder(f, "parent");
		const child = await folder(f, "child", parent);
		const other = await folder(f, "other", parent);
		const member = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clock-admin" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, { ...f.scope, userId, role: "admin", now: Date.now() });
			return { userId, membershipId };
		});
		const asMember = f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: child }),
		).toEqual({ _yay: null });
		// The admin cannot see the restricted child, so the job must neither change nor count it.
		expect(
			await asMember.query(api.files_nodes.get_file_node_for_membership, {
				membershipId: member.membershipId,
				fileNodeId: String(child),
			}),
		).toBeNull();

		const before = await snapshot(f);
		expect(
			await apply_to_contents(f, asMember, {
				membershipId: member.membershipId,
				nodeId: parent,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: { status: "succeeded", completed: 1 } });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", child))).toEqual(
			before.nodes.find((node) => node._id === child),
		);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", other)))?.writePolicy).toEqual({ mode: "read_only" });
		await expect_clock(f, before, true);
	});
});
