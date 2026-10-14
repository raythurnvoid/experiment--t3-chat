// Push A mirror. Keep old readers and limits until the source audit passes.
import type { Doc } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_metadata_validate_entries } from "../shared/files-metadata.ts";
import { convex_error } from "./convex-utils.ts";

export async function files_metadata_maps_db_read(db: QueryCtx["db"], owner: Doc<"files_metadata_maps">["owner"]) {
	return await db
		.query("files_metadata_maps")
		.withIndex("by_owner", (q) => q.eq("owner.kind", owner.kind).eq("owner.id", owner.id))
		.unique();
}

export async function files_metadata_maps_db_delete(db: MutationCtx["db"], owner: Doc<"files_metadata_maps">["owner"]) {
	const stored = await files_metadata_maps_db_read(db, owner);
	if (stored) await db.delete("files_metadata_maps", stored._id);
}

export async function files_metadata_maps_db_write(
	db: MutationCtx["db"],
	args: Pick<Doc<"files_metadata_maps">, "organizationId" | "workspaceId" | "owner" | "entries">,
) {
	const checked = files_metadata_validate_entries(args.entries);
	if (checked._nay) throw convex_error(checked._nay);
	const stored = await files_metadata_maps_db_read(db, args.owner);
	if (!args.entries.length) {
		if (stored) await db.delete("files_metadata_maps", stored._id);
		return;
	}
	const fields = { ...args, revision: (stored?.revision ?? 0) + 1 };
	if (stored) await db.replace("files_metadata_maps", stored._id, fields);
	else await db.insert("files_metadata_maps", fields);
}
