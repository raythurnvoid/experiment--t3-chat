import { describe, expect, test } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { components, internal } from "./_generated/api.js";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

// Temporary tests for the approved one-time dev conversion. Remove after the strict-schema audit.
describe("plugin file metadata migration", () => {
	test("preserves active and archived nodes, locks, and other metadata, and leaves unmarked nodes alone", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const nodes = [];
			for (const [name, kind, pluginName] of [
				["chat", "folder", "chitchat"],
				["note.md", "file", "council"],
				["member", "folder", null],
			] as const) {
				const nodeId = await ctx.db.insert("files_nodes", {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					parentId: "root",
					path: `/${name}`,
					treePath: `/${name}${kind === "folder" ? "/" : ""}`,
					pathDepth: 1,
					name,
					kind,
					lowercaseExtension: kind === "file" ? "md" : null,
					...(pluginName === "chitchat" ? { pluginOwnerName: pluginName } : {}),
					...(pluginName === "council" ? { pluginServiceWritePluginName: pluginName, archiveOperationId: "history" } : {}),
					createdBy: membership.userId,
					updatedBy: membership.userId,
					updatedAt: 123,
				});
				if (pluginName) {
					await ctx.db.patch("files_nodes", nodeId, {
						readOnlyScopeNodeId: nodeId,
						readOnlyPluginName: pluginName,
						restrictedScopeNodeId: nodeId,
					});
				}
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				await files_metadata_db_write_entries(ctx, {
					fileNode: node,
					entries: [{ key: "source", value: "api" }, { key: "note", value: false }],
				});
				nodes.push(node);
			}
			return { nodes, metadata: await ctx.db.query("files_metadata_docs").collect() };
		});
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugin_file_metadata, { batchSize: 1 });
		});
		const after = await t.run(async (ctx) => ({
			nodes: await Promise.all(fixture.nodes.map((node) => ctx.db.get("files_nodes", node._id))),
			metadata: await ctx.db.query("files_metadata_docs").collect(),
		}));
		expect(after.nodes).toEqual(fixture.nodes);
		for (const node of fixture.nodes) {
			const docs = after.metadata.filter((doc) => doc.fileNodeId === node._id);
			if (!node.pluginOwnerName && !node.pluginServiceWritePluginName) {
				expect(docs).toEqual(fixture.metadata.filter((doc) => doc.fileNodeId === node._id));
				continue;
			}
			expect(docs.filter((doc) => doc.docKind === "value")).toEqual(expect.arrayContaining([
				expect.objectContaining({ qualifiedField: "metadata.source", stringValue: "plugin" }),
				expect.objectContaining({ qualifiedField: "metadata.plugin-name", stringValue: node.pluginOwnerName ?? node.pluginServiceWritePluginName }),
				expect.objectContaining({ qualifiedField: "metadata.note", booleanValue: false }),
			]));
			expect(docs.every((doc) => doc.archiveOperationId === node.archiveOperationId && doc.treePath === node.treePath)).toBe(true);
		}
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugin_file_metadata, { cursor: null, batchSize: 1 });
		});
		expect(await t.run((ctx) => ctx.db.query("files_metadata_docs").collect())).toEqual(after.metadata);
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.strip_plugin_file_fields, { batchSize: 1 });
		});
		for (const node of fixture.nodes) {
			const { pluginOwnerName: _owner, pluginServiceWritePluginName: _service, ...kept } = node;
			expect(await t.run((ctx) => ctx.db.get("files_nodes", node._id))).toEqual(kept);
		}
		expect(await t.run((ctx) => ctx.db.query("files_metadata_docs").collect())).toEqual(after.metadata);
	});

	test("refuses a changed label before writing metadata or removing the old field", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await t.run(async (ctx) => {
			const { files } = await test_mocks_fill_db_with.nested_files(ctx);
			const node = files.file_root_1;
			await ctx.db.patch("files_nodes", node._id, { pluginOwnerName: "chitchat" });
			await files_metadata_db_write_entries(ctx, { fileNode: node, entries: [{ key: "plugin-name", value: "member-choice" }] });
			return { node: await ctx.db.get("files_nodes", node._id), metadata: await ctx.db.query("files_metadata_docs").collect() };
		});
		await expect(t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugin_file_metadata, { batchSize: 1 });
		})).rejects.toThrow("Metadata label changed");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", fixture.node!._id))).toEqual(fixture.node);
		expect(await t.run((ctx) => ctx.db.query("files_metadata_docs").collect())).toEqual(fixture.metadata);
	});
});
