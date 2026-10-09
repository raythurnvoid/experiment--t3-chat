import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { files_saved_list_page } from "./files-saved-list.ts";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";
import { plugins_external_files_db_get_node } from "../convex/plugins_external_files_access.ts";
import { organizations_membership_lifetimes_db_record } from "../convex/organizations_membership_lifetimes.ts";
import { getFunctionName, type FunctionArgs } from "convex/server";
import type { ActionCtx } from "../convex/_generated/server.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("saved-list-test-work" as never);
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("saved list action", () => {
	test("re-seeks a completed selected source after staging moves a row behind its old cursor", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/a.txt", "/b.txt"] });
		let migrated = false;
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: async (query, args) => {
				const result = await f.t.action((ctx) => ctx.runQuery(query, args));
				if (!migrated && getFunctionName(query) === "files_nodes:list_subtree") {
					const input = args as FunctionArgs<typeof internal.files_nodes.list_subtree>;
					if (input.savedStream?.kind === "cohort") {
						migrated = true;
						await f.stageNode(f.normalNodes.get("/b.txt")!);
					}
				}
				return result;
			},
		};
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			folderPath: "/",
			minDepth: 1,
			maxDepth: 1,
			numItems: 1,
			cursorScope: "stage",
		};
		const first = await files_saved_list_page(ctx, { ...args, cursor: null });
		expect(first.page.map((node) => node.path)).toEqual(["/a.txt"]);
		const second = await files_saved_list_page(ctx, { ...args, cursor: first.continueCursor });
		expect(
			second.page.map((node) => node.path),
			"a row staged behind the old selected cursor is still returned",
		).toEqual(["/b.txt"]);
	});

	test("re-seeks normal rows after cleanup moves a row behind its old cursor", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/a.txt", "/b.txt"] });
		await f.stageNode(f.normalNodes.get("/b.txt")!);
		await f.publish();
		let migrated = false;
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: async (query, args) => {
				const result = await f.t.action((ctx) => ctx.runQuery(query, args));
				if (!migrated && getFunctionName(query) === "files_nodes:list_subtree") {
					const input = args as FunctionArgs<typeof internal.files_nodes.list_subtree>;
					if (input.savedStream?.kind === "normal") {
						migrated = true;
						await f.materializeNode(f.normalNodes.get("/b.txt")!);
					}
				}
				return result;
			},
		};
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			folderPath: "/",
			minDepth: 1,
			maxDepth: 1,
			numItems: 1,
			cursorScope: "cleanup",
		};
		const first = await files_saved_list_page(ctx, { ...args, cursor: null });
		expect(first.page.map((node) => node.path)).toEqual(["/a.txt"]);
		const second = await files_saved_list_page(ctx, { ...args, cursor: first.continueCursor });
		expect(
			second.page.map((node) => node.path),
			"a row cleaned up behind the old normal cursor is still returned",
		).toEqual(["/b.txt"]);
	});

	test("refuses an abort direction change between the two native source reads", async () => {
		const f = await test_create_saved_placement_fixture();
		let aborted = false;
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: async (query, args) => {
				const result = await f.t.action((ctx) => ctx.runQuery(query, args));
				if (!aborted && getFunctionName(query) === "files_nodes:list_subtree") {
					aborted = true;
					await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "aborting" }));
				}
				return result;
			},
		};
		await expect(
			files_saved_list_page(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				folderPath: "/",
				minDepth: 1,
				maxDepth: 1,
				numItems: 2,
				cursorScope: "abort",
				cursor: null,
			}),
		).rejects.toThrow("Move view changed");
	});

	test("returns a public error for a malformed continuation cursor", async () => {
		const f = await test_create_saved_placement_fixture({ signedIn: true });
		const key = await f.asUser.mutation(api.public_api.api_credential_create, {
			serviceAccountId: null,
			membershipId: f.db.membershipId,
			name: "Saved list",
			scopes: ["files:list"],
		});
		if (key._nay) throw new Error(key._nay.message);
		const response = await f.t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { Authorization: `Bearer ${key._yay.credential}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/", cursor: "broken" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "This list cursor changed. Start a new page." });
	});

	test("does not resume a cursor under a new membership lifetime", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/a.txt"] });
		const memberId = await f.t.run((ctx) => ctx.db.insert("users", { clerkUserId: "saved-list-member" }));
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: memberId,
			}),
		).toEqual({ _yay: null });
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: memberId,
			folderPath: "/",
			minDepth: 1,
			maxDepth: 1,
			numItems: 1,
			cursorScope: "member",
		};
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: (query, args) => f.t.action((ctx) => ctx.runQuery(query, args)),
		};
		const first = await files_saved_list_page(ctx, { ...args, cursor: null });
		// Use the same lifetime producer as removal and reinvitation. The membership ID stays the same.
		await f.t.run(async (ctx) => {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", memberId)
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId),
				)
				.first();
			if (!membership) throw new Error("Expected the invited member");
			await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
			await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
		});
		await expect(files_saved_list_page(ctx, { ...args, cursor: first.continueCursor })).rejects.toThrow(
			"scope changed",
		);
	});

	test("keeps unused cohort rows across small public list pages", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/a.txt", "/b.txt", "/z.txt"] });
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			folderPath: "/",
			minDepth: 1,
			maxDepth: 1,
			numItems: 2,
			cursorScope: "caller",
		};
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: (query, args) => f.t.action((ctx) => ctx.runQuery(query, args)),
		};
		const first = await files_saved_list_page(ctx, { ...args, cursor: null });
		expect(first.page.map((node) => node.path)).toEqual(["/a.txt", "/b.txt"]);
		const second = await files_saved_list_page(ctx, { ...args, cursor: first.continueCursor });
		expect(
			second.page.map((node) => node.path),
			"unused cohort rows survive the public page boundary",
		).toEqual(["/old.txt", "/target"]);
		const third = await files_saved_list_page(ctx, { ...args, cursor: second.continueCursor });
		expect(third.page.map((node) => node.path)).toEqual(["/z.txt"]);
		expect(third.isDone).toBe(true);
	});

	test("binds the global key to scope and the selected cohort view", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/a.txt"] });
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			folderPath: "/",
			minDepth: 1,
			maxDepth: 1,
			numItems: 1,
			cursorScope: "caller",
		};
		const ctx: Pick<ActionCtx, "runQuery"> = {
			runQuery: (query, args) => f.t.action((ctx) => ctx.runQuery(query, args)),
		};
		const first = await files_saved_list_page(ctx, { ...args, cursor: null });
		await expect(
			files_saved_list_page(ctx, { ...args, cursorScope: "other", cursor: first.continueCursor }),
		).rejects.toThrow("scope changed");
		await f.publish();
		await expect(files_saved_list_page(ctx, { ...args, cursor: first.continueCursor })).rejects.toThrow(
			"scope changed",
		);
		const after = await files_saved_list_page(ctx, { ...args, folderPath: "/target", numItems: 2, cursor: null });
		expect(after.page.map((node) => node.path)).toEqual(["/target/new.txt"]);
	});

	test("refuses a seek key outside its recursive source range", async () => {
		const f = await test_create_saved_placement_fixture();
		const args = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			folderPath: "/target",
			minDepth: 1,
			numItems: 1,
			cursor: null,
			savedStream: { kind: "cohort" as const, cohortId: f.cohortId, view: "before" as const, generation: 1 },
		};
		await expect(
			f.t.query(internal.files_nodes.list_subtree, {
				...args,
				seek: {
					lowerKey: { nodeId: f.nodeId, value: "/old.txt", createdAt: f.saved._creationTime },
					upperKey: null,
					phase: 0,
				},
			}),
		).rejects.toThrow("outside its folder");
	});

	test("external path and signed download readers use the selected saved header", async () => {
		const f = await test_create_saved_placement_fixture();
		const read = (path: string) => f.t.run((ctx) => plugins_external_files_db_get_node(ctx, { ...f.db, path }));
		expect((await read("/old.txt"))?._id).toBe(f.nodeId);
		expect(await read("/target/new.txt")).toBeNull();
		await f.publish();
		expect(await read("/old.txt")).toBeNull();
		expect((await read("/target/new.txt"))?._id).toBe(f.nodeId);
		const download = await f.t.query(internal.r2.get_data_for_public_download_url, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			fileNodeId: f.nodeId,
		});
		expect(download?.fileNode.path).toBe("/target/new.txt");
	});
});
