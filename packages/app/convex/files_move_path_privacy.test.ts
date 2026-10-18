import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { measure_move } from "./files_move_scale.setup.test.ts";
import { add_member, create_folder_fixture, mock_transfer_storage } from "./files_transfer.setup.test.ts";
import { test_mocks, test_move_nodes } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(mock_transfer_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("move path privacy", () => {
	test("hides a path refusal below 500 extended roots within the transaction limits", async () => {
		const destination = `/${"d".repeat(18)}`;
		const fixture = await create_folder_fixture(["/s", "/s/r", destination]);
		const { t, db, asUser, folders } = fixture;
		const member = await add_member(fixture);
		const restrictedId = folders.get("/s/r")!;
		expect(
			await asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: db.membershipId,
				nodeId: restrictedId,
			}),
		).toEqual({ _yay: null });
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// Seed only the deep tree and unrelated grants. The Move uses its real public intake and workers.
		const leaf = await t.run(async (ctx) => {
			const strangerId = await ctx.db.insert("users", { clerkUserId: null });
			let parentId = restrictedId;
			let path = "/s/r";
			for (let depth = 0; depth < 500; depth++) {
				path += "/a";
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					kind: "folder",
					parentId,
					name: "a",
					sortName: files_sort_text_key("a"),
					path,
					treePath: `${path}/`,
					pathDepth: depth + 3,
					restrictedScopeNodeId: restrictedId,
					parentExtendedScopeNodeId: depth === 0 ? null : parentId,
				});
				await ctx.db.patch("files_nodes", nodeId, { extendedScopeNodeId: nodeId });
				for (const principal of [
					{ principalKind: "user" as const, userId: strangerId },
					{ principalKind: "role" as const, role: "admin" as const },
				]) {
					for (const permission of ["content.read", "content.write"] as const) {
						if (principal.principalKind === "user" && permission === "content.write") continue;
						await ctx.db.insert("access_control_permission_grants", {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							resourceKind: "file",
							resourceId: String(nodeId),
							...principal,
							permission,
							createdAt: 1,
							updatedAt: 1,
						});
					}
				}
				parentId = nodeId;
			}
			const leafPath = `${path}/z`;
			const id = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				kind: "folder",
				parentId,
				name: "z",
				sortName: files_sort_text_key("z"),
				path: leafPath,
				treePath: `${leafPath}/`,
				pathDepth: 503,
				restrictedScopeNodeId: restrictedId,
				extendedScopeNodeId: parentId,
			});
			return { id, path: leafPath };
		});
		expect(leaf.path.length).toBe(1006);
		expect(`${destination}${leaf.path}`.length).toBe(1025);
		expect(`${destination}${leaf.path.slice(0, -2)}`.length).toBe(1023);

		// Includes each real handler's overlay flush. The fixture enables transactionLimits: true.
		const peaks = measure_move();
		const result = await test_move_nodes(t, member.asUser, {
			membershipId: member.membershipId,
			itemIds: [folders.get("/s")!],
			targetParentId: folders.get(destination)!,
		});
		expect(result._nay?.name).toBe("path_too_long");
		expect(result._nay?.message, "A deep Move refusal must not expose the hidden leaf or its path length").toBe(
			'An item inside "s" would exceed the 1,024-character path limit. Shorten a folder name or move it higher.',
		);
		expect((await t.run((ctx) => ctx.db.get("files_nodes", leaf.id)))?.path).toBe(leaf.path);
		const headers = peaks.get("cohort/headers")!;
		expect(headers.calls).toBeGreaterThan(0);
		expect(headers.cost.documentsRead, "The refusal checks the full extended-root chain").toBeGreaterThan(500);
		console.info("Move path privacy at 500 extended roots", headers);
	}, 120_000);
});
