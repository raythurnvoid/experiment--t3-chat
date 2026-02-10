import "./setup-env.test.ts";
import { convexTest } from "convex-test";
import schema from "./schema.ts";
import { faker } from "@faker-js/faker";
import { make } from "../src/lib/utils.ts";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";
import type { MutationCtx } from "./_generated/server";

// #region helpers

export function test_convex() {
	return convexTest(schema, import.meta.glob("./**/*.ts"));
}

// #endregion

// #region mocks

export const test_mocks_hardcoded = ((/* iife */) => {
	const workspace_id = {
		workspace_1: "workspace_1",
		workspace_2: "workspace_2",
	} as const;

	const project_id = {
		project_1: "project_1",
		project_2: "project_2",
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

			return make<ConvexDocUserData<"pages">>({
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				projectId: test_mocks_hardcoded.project_id.project_1,
				createdBy: test_mocks_hardcoded.user.user_1.id as Id<"users">,
				updatedAt: updatedAt,
				updatedBy: test_mocks_hardcoded.user.user_1.id,
				parentId: test_mocks_hardcoded.page.page_root_1.parentId,
				name: faker.lorem.words({
					min: 1,
					max: 3,
				}),
				version: pages_FIRST_VERSION,
				isArchived: false,
			});
		};

		return {
			base,
		};
	})(),
};

export const test_mocks_fill_db_with = {
	nested_pages: async (ctx: MutationCtx) => {
		const createdByUserId = await ctx.db.insert("users", {
			clerkUserId: null,
			anonymousAuthToken: null,
		});

		/** /root_1 */
		const page_root_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1.name,
				parentId: test_mocks_hardcoded.page.page_root_1.parentId,
			}),
		);
		if (!page_root_1) throw new Error("page_root_1 not found");

		/** /root_1/child_1 */
		const page_root_1_child_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_1.name,
				parentId: page_root_1._id,
			}),
		);
		if (!page_root_1_child_1) throw new Error("page_root_1_child_1 not found");

		/** /root_1/child_1/deep_1 */
		const page_root_1_child_1_deep_1 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_1_deep_1.name,
				parentId: page_root_1_child_1._id,
			}),
		);
		if (!page_root_1_child_1_deep_1) throw new Error("page_root_1_child_1_deep_1 not found");

		/** /root_1/child_2 */
		const page_root_1_child_2 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_1_child_2.name,
				parentId: page_root_1._id,
			}),
		);
		if (!page_root_1_child_2) throw new Error("page_root_1_child_2 not found");

		/** /root_2 */
		const page_root_2 = await ctx.db.get(
			"pages",
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.page.page_root_2.name,
				parentId: test_mocks_hardcoded.page.page_root_2.parentId,
			}),
		);
		if (!page_root_2) throw new Error("page_root_2 not found");

		return {
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
