import "./setup-env.test.ts";
import { convexTest } from "convex-test";
import schema from "./schema.ts";
import { faker } from "@faker-js/faker";
import { make } from "../src/lib/utils.ts";
import type { Doc, TableNames } from "./_generated/dataModel";
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
		parent_id: pages_ROOT_ID,
	} as const;

	const page_root_1 = {
		page_id: "page_root_1_id",
		name: "page_root_1_name",
		parent_id: pages_ROOT_ID,
	} as const;

	const page_root_2 = {
		page_id: "page_root_2_id",
		name: "page_root_2_name",
		parent_id: pages_ROOT_ID,
	} as const;

	const page_root_1_child_1 = {
		page_id: "page_root_1_child_1_id",
		name: "page_root_1_child_1_name",
		parent_id: page_root_1.page_id,
	} as const;

	const page_root_1_child_2 = {
		page_id: "page_root_1_child_2_id",
		name: "page_root_1_child_2_name",
		parent_id: page_root_1.page_id,
	} as const;

	const page_root_1_child_1_deep_1 = {
		page_id: "page_root_1_child_1_deep_1",
		name: "page_root_1_child_1_deep_1_name",
		parent_id: page_root_1_child_1.page_id,
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
			const updated_at = faker.date.recent().getTime();

			return make<ConvexDocUserData<"pages">>({
				workspace_id: test_mocks_hardcoded.workspace_id.workspace_1,
				project_id: test_mocks_hardcoded.project_id.project_1,
				created_by: test_mocks_hardcoded.user.user_1.id,
				updated_at: updated_at,
				updated_by: test_mocks_hardcoded.user.user_1.id,
				page_id: test_mocks_hardcoded.page.page_root_1.page_id,
				parent_id: test_mocks_hardcoded.page.page_root_1.parent_id,
				name: faker.lorem.words({
					min: 1,
					max: 3,
				}),
				text_content: faker.lorem.paragraphs(
					{
						min: 1,
						max: 3,
					},
					"\n\n",
				),
				version: pages_FIRST_VERSION,
				is_archived: false,
			});
		};

		return {
			base,
		};
	})(),
};

export const test_mocks_fill_db_with = {
	nested_pages: async (ctx: MutationCtx) => {
		/** /root_1 */
		const page_root_1 = await ctx.db.get(
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				page_id: test_mocks_hardcoded.page.page_root_1.page_id,
				name: test_mocks_hardcoded.page.page_root_1.name,
				parent_id: test_mocks_hardcoded.page.page_root_1.parent_id,
			}),
		);
		if (!page_root_1) throw new Error("page_root_1 not found");

		/** /root_1/child_1 */
		const page_root_1_child_1 = await ctx.db.get(
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				page_id: test_mocks_hardcoded.page.page_root_1_child_1.page_id,
				name: test_mocks_hardcoded.page.page_root_1_child_1.name,
				parent_id: test_mocks_hardcoded.page.page_root_1_child_1.parent_id,
			}),
		);
		if (!page_root_1_child_1) throw new Error("page_root_1_child_1 not found");

		/** /root_1/child_1/deep_1 */
		const page_root_1_child_1_deep_1 = await ctx.db.get(
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				page_id: test_mocks_hardcoded.page.page_root_1_child_1_deep_1.page_id,
				name: test_mocks_hardcoded.page.page_root_1_child_1_deep_1.name,
				parent_id: test_mocks_hardcoded.page.page_root_1_child_1_deep_1.parent_id,
			}),
		);
		if (!page_root_1_child_1_deep_1) throw new Error("page_root_1_child_1_deep_1 not found");

		/** /root_1/child_2 */
		const page_root_1_child_2 = await ctx.db.get(
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				page_id: test_mocks_hardcoded.page.page_root_1_child_2.page_id,
				name: test_mocks_hardcoded.page.page_root_1_child_2.name,
				parent_id: test_mocks_hardcoded.page.page_root_1_child_2.parent_id,
			}),
		);
		if (!page_root_1_child_2) throw new Error("page_root_1_child_2 not found");

		/** /root_2 */
		const page_root_2 = await ctx.db.get(
			await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				page_id: test_mocks_hardcoded.page.page_root_2.page_id,
				name: test_mocks_hardcoded.page.page_root_2.name,
				parent_id: test_mocks_hardcoded.page.page_root_2.parent_id,
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
