import "./setup-env.test.ts";
import { convexTest } from "convex-test";
import schema from "./schema.ts";
import { faker } from "@faker-js/faker";
import { make } from "../src/lib/utils.ts";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";
import type { MutationCtx } from "./_generated/server";
import presence_test from "@convex-dev/presence/test";
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "../server/workspaces.ts";
import { user_limits } from "../shared/limits.ts";

// #region helpers

const convex_test_modules = import.meta.glob("./**/*.ts");

export function test_convex() {
	const t = convexTest(schema, convex_test_modules);
	presence_test.register(t);
	return t;
}

// #endregion

// #region mocks

export const test_mocks_hardcoded = ((/* iife */) => {
	const workspace_id = {
		workspace_1: "app_workspace_test_1",
		workspace_2: "app_workspace_test_2",
	} as const;

	const project_id = {
		project_1: "app_project_test_1",
		project_2: "app_project_test_2",
	} as const;

	const membership_id = {
		membership_1: "test_membership" as Id<"workspaces_projects_users">,
	} as const;

	const user = {
		user_1: {
			id: "user_1",
		},
		user_2: {
			id: "user_2",
		},
	} as const;

	const page_root_generic = {
		parentId: pages_ROOT_ID,
	} as const;

	const page_root_1 = {
		name: "page_root_1_name",
		parentId: pages_ROOT_ID,
	} as const;

	const page_root_2 = {
		name: "page_root_2_name",
		parentId: pages_ROOT_ID,
	} as const;

	const page_root_1_child_1 = {
		name: "page_root_1_child_1_name",
	} as const;

	const page_root_1_child_2 = {
		name: "page_root_1_child_2_name",
	} as const;

	const page_root_1_child_1_deep_1 = {
		name: "page_root_1_child_1_deep_1_name",
	} as const;

	return {
		workspace_id,
		project_id,
		membership_id,
		user,
		page: {
			page_root_generic,
			page_root_1,
			page_root_2,
			page_root_1_child_1,
			page_root_1_child_2,
			page_root_1_child_1_deep_1,
		},
	} as const;
})();

export const test_mocks = {
	pages: ((/* iife */) => {
		const base = () => {
			const updatedAt = faker.date.recent().getTime();
			const name = faker.lorem.words({
				min: 1,
				max: 3,
			});

			return make<ConvexDocUserData<"pages">>({
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				createdBy: test_mocks_hardcoded.user.user_1.id as Id<"users">,
				updatedAt: updatedAt,
				updatedBy: test_mocks_hardcoded.user.user_1.id,
				parentId: test_mocks_hardcoded.page.page_root_1.parentId,
				name: name,
				path: `/${name}`,
				version: pages_FIRST_VERSION,
				archiveOperationId: undefined,
			});
		};

		return {
			base,
		};
	})(),
};

export const test_mocks_fill_db_with = {
	membership: async (
		ctx: MutationCtx,
		args?: {
			userId?: Id<"users">;
			workspaceName?: string;
			projectName?: string;
		},
	) => {
		const now = Date.now();
		const workspaceName = args?.workspaceName ?? "test-workspace";
		const projectName = args?.projectName ?? "test-project";
		const userId =
			args?.userId ??
			(await ctx.db.insert("users", {
				clerkUserId: null,
			}));

		const userLimit = await ctx.db
			.query("limits_per_user")
			.withIndex("by_userId_limitName", (q) =>
				q.eq("userId", userId).eq("limitName", user_limits.EXTRA_WORKSPACES.name),
			)
			.first();
		if (!userLimit) {
			await ctx.db.insert("limits_per_user", {
				userId,
				limitName: user_limits.EXTRA_WORKSPACES.name,
				usedCount: 0,
				maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
				createdAt: now,
				updatedAt: now,
			});
		}

		await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
			userId,
			now,
		});

		const user = await ctx.db.get("users", userId);
		if (!user?.defaultWorkspaceId || !user.defaultProjectId) {
			throw new Error("Expected default workspace bootstrap to set user defaults");
		}

		if (workspaceName === "personal" && projectName === "home") {
			const membershipId = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", user.defaultProjectId!).eq("userId", userId))
				.first()
				.then((membership) => membership?._id);
			if (!membershipId) {
				throw new Error("Expected default workspace membership after bootstrap");
			}

			return {
				userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				membershipId,
			} as const;
		}

		const workspaceResult = await workspaces_db_create(ctx, {
			userId,
			name: workspaceName,
			description: "",
			now,
		});
		if (workspaceResult._nay) {
			throw new Error(`Failed to seed workspace membership: ${workspaceResult._nay.message}`);
		}

		let projectId = workspaceResult._yay.defaultProjectId;
		if (projectName !== "home") {
			const projectResult = await workspaces_db_create_project(ctx, {
				userId,
				workspaceId: workspaceResult._yay.workspaceId,
				name: projectName,
				description: "",
				now,
			});
			if (projectResult._nay) {
				throw new Error(`Failed to seed project membership: ${projectResult._nay.message}`);
			}

			projectId = projectResult._yay.projectId;
		}

		const membershipId = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_projectId_userId", (q) => q.eq("projectId", projectId).eq("userId", userId))
			.first()
			.then((membership) => membership?._id);
		if (!membershipId) {
			throw new Error("Expected workspace membership after seed setup");
		}

		return {
			userId,
			workspaceId: workspaceResult._yay.workspaceId,
			projectId,
			membershipId,
		} as const;
	},

	nested_pages: async (ctx: MutationCtx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx);
		const createdByUserId = membership.userId;

		/** /root_1 */
		const page_root_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1.name,
				parentId: test_mocks_hardcoded.page.page_root_1.parentId,
				path: `/${test_mocks_hardcoded.page.page_root_1.name}`,
			}),
		);
		if (!page_root_1) throw new Error("page_root_1 not found");

		/** /root_1/child_1 */
		const page_root_1_child_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_1.name,
				parentId: page_root_1._id,
				path: `/${page_root_1.name}/${test_mocks_hardcoded.page.page_root_1_child_1.name}`,
			}),
		);
		if (!page_root_1_child_1) throw new Error("page_root_1_child_1 not found");

		/** /root_1/child_1/deep_1 */
		const page_root_1_child_1_deep_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_1_deep_1.name,
				parentId: page_root_1_child_1._id,
				path: `/${page_root_1.name}/${page_root_1_child_1.name}/${test_mocks_hardcoded.page.page_root_1_child_1_deep_1.name}`,
			}),
		);
		if (!page_root_1_child_1_deep_1) throw new Error("page_root_1_child_1_deep_1 not found");

		/** /root_1/child_2 */
		const page_root_1_child_2 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_2.name,
				parentId: page_root_1._id,
				path: `/${page_root_1.name}/${test_mocks_hardcoded.page.page_root_1_child_2.name}`,
			}),
		);
		if (!page_root_1_child_2) throw new Error("page_root_1_child_2 not found");

		/** /root_2 */
		const page_root_2 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_2.name,
				parentId: test_mocks_hardcoded.page.page_root_2.parentId,
				path: `/${test_mocks_hardcoded.page.page_root_2.name}`,
			}),
		);
		if (!page_root_2) throw new Error("page_root_2 not found");

		return {
			userId: createdByUserId,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			membershipId: membership.membershipId,
			pages: {
				page_root_1,
				page_root_1_child_1,
				page_root_1_child_1_deep_1,
				page_root_1_child_2,
				page_root_2,
			},
		} as const;
	},
};

type ConvexDocUserData<T extends TableNames> = Omit<Doc<T>, "_creationTime" | "_id">;

// #endregion
