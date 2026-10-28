import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_metadata_db_write_entries } from "./files_metadata_db.ts";
import { insert_tree_node, seed_tree_access_fixture } from "./files_nodes.setup.test.ts";
import { test_convex, test_db_hold_move_slot, test_finish_file_index, test_run_with_flush } from "./setup.test.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tree page read budgets", () => {
	test.each([false, true])("file page guards cover saved views (restricted %s)", async (restricted) => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const { parentId, ids } = await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			const folder = (parentId: Id<"files_nodes">, path: string, scope?: Id<"files_nodes"> | "self") =>
				insert_tree_node({ ctx, owner: f.owner, parentId, path, kind: "folder", scope });
			const areaId = await folder(f.nodes.openId, "/open/budget", "self");
			const addedId = await folder(areaId, "/open/budget/d", areaId);
			await ctx.db.patch("files_nodes", addedId, { extendedScopeNodeId: addedId, parentExtendedScopeNodeId: null });
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "file",
				resourceId: String(addedId),
				principalKind: "role",
				role: "member",
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			const parentId = await folder(addedId, "/open/budget/d/f", areaId);
			await ctx.db.patch("files_nodes", parentId, {
				extendedScopeNodeId: parentId,
				parentExtendedScopeNodeId: addedId,
			});
			const ids: Id<"files_nodes">[] = [];
			for (let index = 0; index < 6; index++) {
				const nodeId = await insert_tree_node({
					ctx,
					owner: f.owner,
					parentId,
					path: `/open/budget/d/f/a-${index}.md`,
					kind: "file",
					scope: restricted ? "self" : areaId,
				});
				if (restricted) {
					// Read through the second role, after rejecting an old plugin grant.
					for (const principal of [
						{ principalKind: "role", role: "member" },
						{ principalKind: "user", userId: f.admin.userId, externalPluginMembershipLifetime: 1 },
					] as const) {
						await ctx.db.insert("access_control_permission_grants", {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							resourceKind: "file",
							resourceId: String(nodeId),
							...principal,
							permission: "content.read",
							createdAt: now,
							updatedAt: now,
						});
					}
				} else {
					// The parent gained added people, but its scope job has not reached these files.
					await ctx.db.patch("files_nodes", nodeId, {
						extendedScopeNodeId: nodeId,
						parentExtendedScopeNodeId: addedId,
					});
				}
				await files_metadata_db_write_entries(ctx, {
					fileNode: (await ctx.db.get("files_nodes", nodeId))!,
					entries: [{ key: "status", value: "open" }],
				});
				ids.push(nodeId);
			}
			return { parentId, ids };
		});
		for (const id of ids) await test_finish_file_index(t, id);

		// Observe the real guard without changing pagination or access checks. Six files measure the
		// per-file cost; extrapolating to the guard avoids a slow fixture with hundreds of files.
		const treeDb = await import("./files_tree_db.ts");
		const split = vi.spyOn(treeDb, "files_tree_db_page_needs_split");
		let view: "before" | "after" | null = null;
		let cohortId: Id<"files_move_cohorts"> | null = null;
		let generation = 0;
		const check = async (
			field: "tree" | "name" | "metadata.status" | "shared" | "roots",
			stream: "normal" | "cohort",
			owner = false,
		) => {
			const member = owner ? f.owner : f.admin;
			const as = owner ? f.asOwner : f.asAdmin;
			const read = (numItems: number) =>
				as.run(async (ctx) => {
					split.mockClear();
					const before = await ctx.meta.getTransactionMetrics();
					// Nested queries share the caller's read budget too.
					await ctx.db.get("users", member.userId);
					await ctx.db.get("organizations_workspaces_users", member.membershipId);
					const common = {
						membershipId: member.membershipId,
						parentId,
						kind: "file" as const,
						stream,
						paginationOpts: { numItems, cursor: null },
					};
					const sorted = {
						...common,
						sort: [{ field: field === "name" ? ("name" as const) : "metadata.status", direction: "asc" as const }],
						filter: null,
						namePrefix: null,
						segment: "value" as const,
					};
					const result =
						field === "tree"
							? await ctx.runQuery(api.files_tree.list_tree_children, { ...common, archived: false, restricted })
							: field === "roots"
								? await ctx.runQuery(api.files_tree.list_tree_shared_roots, {
										membershipId: member.membershipId,
										archived: false,
										principalIndex: 2,
										paginationOpts: common.paginationOpts,
										...(cohortId && view
											? {
													savedStream:
														stream === "normal"
															? { kind: "normal" as const, generation }
															: { kind: "cohort" as const, generation, cohortId, view },
												}
											: {}),
									})
								: field === "shared"
									? await ctx.runQuery(api.files_tree.list_tree_children_shared, {
											...sorted,
											principalIndex: 2,
											filter: { kind: "text", field: "metadata.status", op: "present" },
										})
									: await ctx.runQuery(api.files_tree.list_tree_children_sorted, { ...sorted, restricted });
					const after = await ctx.meta.getTransactionMetrics();
					expect(result.page.map((node) => node._id)).toEqual(ids.slice(0, numItems));
					expect(split).toHaveBeenCalledOnce();
					return { ranges: after.databaseQueries.used - before.databaseQueries.used, guard: split.mock.calls[0]![1] };
				});
			const one = await read(1);
			const six = await read(6);
			const perFile = (six.ranges - one.ranges) / 5;
			const fixed = one.ranges - perFile;
			expect(perFile).toBeGreaterThan(0);
			expect
				.soft(
					fixed + six.guard * perFile,
					`${field}, ${stream}, ${view ?? "ordinary"}, owner ${owner}: ${perFile} reads/file, guard ${six.guard}, fixed ${fixed}`,
				)
				.toBeLessThanOrEqual(3000);
		};
		const check_stream = async (stream: "normal" | "cohort") => {
			await check("tree", stream);
			await check("name", stream);
			await check("metadata.status", stream, restricted);
			if (restricted) {
				await check("tree", stream, true);
				await check("name", stream, true);
				await check("shared", stream);
				await check("roots", stream);
			}
		};
		await check_stream("normal");

		cohortId = await t.run(async (ctx) => {
			const cohortId = await test_db_hold_move_slot(ctx, f.owner);
			for (const nodeId of ids) {
				const {
					_id,
					_creationTime,
					createdBy: _createdBy,
					readOnly: _readOnly,
					readOnlyDecisionId: _readOnlyDecisionId,
					moveCohortId: _moveCohortId,
					scopeOpId: _scopeOpId,
					...header
				} = (await ctx.db.get("files_nodes", nodeId))!;
				for (const view of ["before", "after"] as const) {
					await ctx.db.insert("files_saved_places", {
						...header,
						organizationId: f.owner.organizationId,
						workspaceId: f.owner.workspaceId,
						cohortId,
						view,
						nodeId,
						nodeCreationTime: _creationTime,
						contentId: null,
					});
				}
				await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
			}
			return cohortId;
		});
		generation = await t.run(async (ctx) => (await ctx.db.get("files_move_cohorts", cohortId!))!.slotGeneration);
		view = "before";
		// Move reserves nodes before it copies their metadata and share docs. Normal index docs can
		// therefore load expensive Move nodes too.
		await check("metadata.status", "normal", restricted);
		if (restricted) {
			await check("shared", "normal");
			await check("roots", "normal");
		}
		await t.run(async (ctx) => {
			for (const table of ["files_metadata_docs", "files_share_rows"] as const) {
				for (const { _id, _creationTime: _creationTime, ...doc } of await ctx.db.query(table).collect()) {
					const nodeId = "fileNodeId" in doc ? doc.fileNodeId : "nodeId" in doc ? doc.nodeId : undefined;
					if (!nodeId || !ids.includes(nodeId)) continue;
					await ctx.db.patch(table, _id, { moveView: { cohortId: cohortId!, view: "before" } });
					await ctx.db.insert(table, { ...doc, moveView: { cohortId: cohortId!, view: "after" } });
				}
			}
		});
		await check_stream("cohort");
		await t.run(async (ctx) => {
			await ctx.db.patch("files_move_cohorts", cohortId!, { visibleView: "after", publishedAt: Date.now() });
			const slot = (await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.owner.organizationId).eq("workspaceId", f.owner.workspaceId),
				)
				.unique())!;
			await ctx.db.patch("files_move_workspace_slots", slot._id, { visibleView: "after" });
		});
		view = "after";
		await check_stream("cohort");
	});
});
