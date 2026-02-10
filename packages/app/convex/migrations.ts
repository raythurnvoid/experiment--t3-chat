import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import type { DataModel, Id } from "./_generated/dataModel.js";

export const migrations = new Migrations<DataModel>(components.migrations);

const pages_parent_id_by_legacy_id_cache = new Map<string, Map<string, Id<"pages">>>();

export const migrate_pages_parent_id_client_generated_id_to_convex_id = migrations.define({
	table: "pages",
	migrateOne: async (ctx, page) => {
		const value = page as {
			parentId: Id<"pages"> | string;
			workspaceId: string;
			projectId: string;
			clientGeneratedId?: string;
			page_id?: string;
		};

		if (value.parentId === "root") {
			return {
				clientGeneratedId: undefined,
				page_id: undefined,
			} as unknown as Partial<DataModel["pages"]["document"]>;
		}

		const normalizedParentId = ctx.db.normalizeId("pages", value.parentId);
		if (normalizedParentId) {
			return {
				parentId: normalizedParentId,
				clientGeneratedId: undefined,
				page_id: undefined,
			} as unknown as Partial<DataModel["pages"]["document"]>;
		}

		const cacheKey = `${value.workspaceId}::${value.projectId}`;
		let legacyIdMap = pages_parent_id_by_legacy_id_cache.get(cacheKey);
		if (!legacyIdMap) {
			const pages = await ctx.db
				.query("pages")
				.withIndex("by_workspaceId_projectId_and_name", (q) =>
					q.eq("workspaceId", value.workspaceId).eq("projectId", value.projectId),
				)
				.collect();

			legacyIdMap = new Map<string, Id<"pages">>();
			for (const currentPage of pages) {
				const currentPageClientGeneratedId = (currentPage as { clientGeneratedId?: string }).clientGeneratedId;
				const currentPageLegacyId = (currentPage as { page_id?: string }).page_id;

				if (currentPageClientGeneratedId) {
					legacyIdMap.set(currentPageClientGeneratedId, currentPage._id);
				}
				if (currentPageLegacyId) {
					legacyIdMap.set(currentPageLegacyId, currentPage._id);
				}
			}

			pages_parent_id_by_legacy_id_cache.set(cacheKey, legacyIdMap);
		}

		const migratedParentId = legacyIdMap.get(value.parentId);
		if (!migratedParentId) {
			return {
				clientGeneratedId: undefined,
				page_id: undefined,
			} as unknown as Partial<DataModel["pages"]["document"]>;
		}

		return {
			parentId: migratedParentId,
			clientGeneratedId: undefined,
			page_id: undefined,
		} as unknown as Partial<DataModel["pages"]["document"]>;
	},
});

export const migrate_pages_remove_client_generated_id = migrations.define({
	table: "pages",
	migrateOne: (_ctx, page) => {
		const value = page as { clientGeneratedId?: string; page_id?: string };
		if (!value.clientGeneratedId && !value.page_id) {
			return;
		}

		return {
			clientGeneratedId: undefined,
			page_id: undefined,
		} as unknown as Partial<DataModel["pages"]["document"]>;
	},
});

export const run = migrations.runner();
