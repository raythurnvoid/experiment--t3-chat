import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { describe, expect, test } from "vitest";
import { components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

describe("backfill_files_nodes_content_type_fields", () => {
	test("fills the type fields of docs written before them and leaves the audit clean", async () => {
		const t = test_convex();
		component.register(t);
		// Docs saved before the fields existed have neither field.
		await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			for (const [name, kind, contentType] of [
				["docs", "folder", null],
				["photo.png", "file", "image/png;charset=x"],
				["broken", "file", "not a type"],
			] as const) {
				await ctx.db.insert("files_nodes", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					path: `/${name}`,
					treePath: kind === "folder" ? `/${name}/` : `/${name}`,
					pathDepth: 1,
					lowercaseExtension: null,
					name,
					sortName: files_sort_text_key(name),
					kind,
					contentType,
					parentId: "root",
					createdBy: db.userId,
					updatedBy: db.userId,
					updatedAt: Date.now(),
					assetId: null,
					contentByteSize: null,
					textKind: null,
					collaborationEnabled: null,
					yjsSnapshotId: null,
					yjsLastSequenceId: null,
					statsId: null,
					contentTooLargeByteSize: null,
					contentShapeMismatchAt: null,
					contentYjsStateTooLargeByteSize: null,
					contentFrontmatterTooLargeFieldCount: null,
					contentFrontmatterTooLargeIndexDocumentCount: null,
					restrictedScopeNodeId: null,
					isRestrictedScopeRoot: false,
					writePolicy: null,
					archiveOperationId: null,
					newChildWritePolicy: null,
				});
			}
		});
		const audit = () =>
			t.query(internal.migrations.audit_files_content_type_fields_page, { table: "files_nodes", cursor: null });
		expect((await audit()).wrongIds).toHaveLength(3);

		// One doc per batch, so the pass resumes from the cursor of each batch.
		await t.run((ctx) =>
			runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_content_type_fields, {
				batchSize: 1,
			}),
		);

		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(nodes.map((node) => [node.name, node.contentTypeEssence, node.contentTypeFamily])).toEqual([
			["docs", null, null],
			["photo.png", "image/png", "image"],
			["broken", null, null],
		]);
		expect(await audit()).toMatchObject({ checkedCount: 3, wrongIds: [], unparsedCount: 1, isDone: true });
	});
});
