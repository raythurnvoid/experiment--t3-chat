import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Id } from "./_generated/dataModel.js";

const pages_migration_created_by_user_id = "m576s0qn7c59mej54zddpr8dr97yewhy" as Id<"users">;

export const migrations = new Migrations<DataModel>(components.migrations);

export const migrate_pages_created_by_to_createdby = migrations.define({
	table: "pages",
	migrateOne: () => ({
		createdBy: pages_migration_created_by_user_id,
		created_by: undefined,
	}),
});

export const migrate_pages_page_id_to_client_generated_id = migrations.define({
	table: "pages",
	migrateOne: (_ctx, page) => {
		const pageClientGeneratedId =
			(page as { clientGeneratedId?: string }).clientGeneratedId ?? (page as { page_id?: string }).page_id;
		if (!pageClientGeneratedId) {
			return;
		}

		return {
			clientGeneratedId: pageClientGeneratedId,
			page_id: undefined,
		};
	},
});

export const migrate_pages_snake_case_to_camel_case = migrations.define({
	table: "pages",
	migrateOne: (_ctx, page) => {
		const value = page as {
			workspaceId?: string;
			workspace_id?: string;
			projectId?: string;
			project_id?: string;
			markdownContentId?: Id<"pages_markdown_content">;
			markdown_content_id?: Id<"pages_markdown_content">;
			yjsLastSequenceId?: Id<"pages_yjs_docs_last_sequences">;
			yjs_last_sequence_id?: Id<"pages_yjs_docs_last_sequences">;
			yjsSnapshotId?: Id<"pages_yjs_snapshots">;
			yjs_snapshot_id?: Id<"pages_yjs_snapshots">;
			isArchived?: boolean;
			is_archived?: boolean;
			parentId?: string;
			parent_id?: string;
			updatedBy?: string;
			updated_by?: string;
			updatedAt?: number;
			updated_at?: number;
		};

		return {
			workspaceId: value.workspaceId ?? value.workspace_id,
			projectId: value.projectId ?? value.project_id,
			markdownContentId: value.markdownContentId ?? value.markdown_content_id,
			yjsLastSequenceId: value.yjsLastSequenceId ?? value.yjs_last_sequence_id,
			yjsSnapshotId: value.yjsSnapshotId ?? value.yjs_snapshot_id,
			isArchived: value.isArchived ?? value.is_archived,
			parentId: value.parentId ?? value.parent_id,
			updatedBy: value.updatedBy ?? value.updated_by,
			updatedAt: value.updatedAt ?? value.updated_at,
			workspace_id: undefined,
			project_id: undefined,
			markdown_content_id: undefined,
			yjs_last_sequence_id: undefined,
			yjs_snapshot_id: undefined,
			is_archived: undefined,
			parent_id: undefined,
			updated_by: undefined,
			updated_at: undefined,
		};
	},
});

export const run = migrations.runner();

export const run_pages_created_by_to_createdby = migrations.runner(
	internal.migrations.migrate_pages_created_by_to_createdby,
);

export const run_pages_page_id_to_client_generated_id = migrations.runner(
	internal.migrations.migrate_pages_page_id_to_client_generated_id,
);

export const run_pages_snake_case_to_camel_case = migrations.runner(
	internal.migrations.migrate_pages_snake_case_to_camel_case,
);
