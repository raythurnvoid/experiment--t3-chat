import { expect, test } from "vitest";
import { api } from "./_generated/api";
import { test_convex, test_mocks_fill_db_with } from "./test.setup.ts";

test("search pages", async () => {
	const t = test_convex();

	t.run(async (ctx) => {
		test_mocks_fill_db_with.nested_pages(ctx);
	});

	await t.query(api.ai_docs_temp.get_page_by_path, {
		name: "test_1",
		parentId: "root",
		workspaceId: "workspace_1",
		projectId: "project_1",
		pageId: "test_1",
	});
});
