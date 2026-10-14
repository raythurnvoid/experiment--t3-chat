// Full metadata belongs to one file, private proposal, or immutable Copy capture.
// Empty maps have no doc. Search and table docs keep their own short copies.

import type { Doc } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_metadata_validate_entries } from "../shared/files-metadata.ts";
import { convex_error } from "./convex-utils.ts";
import { files_move_reservations_db_note_source } from "./files-move-reservations.ts";

export async function files_metadata_maps_db_read(db: QueryCtx["db"], owner: Doc<"files_metadata_maps">["owner"]) {
	return await db
		.query("files_metadata_maps")
		.withIndex("by_owner", (q) => q.eq("owner.kind", owner.kind).eq("owner.id", owner.id))
		.unique();
}

export async function files_metadata_maps_db_delete(db: MutationCtx["db"], owner: Doc<"files_metadata_maps">["owner"]) {
	const stored = await files_metadata_maps_db_read(db, owner);
	if (!stored) return;
	// The reservation guard needs only the owner and scope, not another read of the full map.
	files_move_reservations_db_note_source(db, {
		table: "files_metadata_maps",
		id: stored._id,
		old: { organizationId: stored.organizationId, workspaceId: stored.workspaceId, owner: stored.owner },
	});
	await db.delete("files_metadata_maps", stored._id);
}

export async function files_metadata_maps_db_write(
	db: MutationCtx["db"],
	args: Pick<Doc<"files_metadata_maps">, "organizationId" | "workspaceId" | "owner" | "entries">,
) {
	// Trusted create and Copy writes must keep the same bound as the user write doors.
	const validated = files_metadata_validate_entries(args.entries);
	if (validated._nay) throw convex_error(validated._nay);
	if (validated._yay.entries.length === 0) {
		await files_metadata_maps_db_delete(db, args.owner);
		return;
	}
	const stored = await files_metadata_maps_db_read(db, args.owner);
	const fields = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		owner: args.owner,
		entries: validated._yay.entries,
		revision: (stored?.revision ?? 0) + 1,
	};
	if (stored) await db.replace("files_metadata_maps", stored._id, fields);
	else await db.insert("files_metadata_maps", fields);
}
