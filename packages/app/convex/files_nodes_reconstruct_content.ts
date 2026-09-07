import { Result } from "common/errors-as-values-utils.ts";
import { mergeUpdates } from "yjs";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { r2_fetch_object_from_bucket } from "./r2_client.ts";
import type { get_file_content_materialization_state_Result } from "./files_nodes.ts";

/**
 * Rebuild the latest text of a collaborative file from its Yjs snapshot and the updates that
 * came after it. The content asset can lag behind the document, so a door that is about to
 * replace the content reads the text from here, not from the asset.
 *
 * This module holds no Convex function and imports no door module. Three modules call this
 * helper: `files_nodes_content.ts`, `files_pending_updates.ts`, and `public_api.ts`. And
 * `files_nodes_content.ts` already imports `files_pending_updates.ts`. So the helper cannot
 * live in either of them without an import cycle.
 */
export async function files_nodes_reconstruct_latest_file_content_from_materialization_state(args: {
	state: NonNullable<get_file_content_materialization_state_Result>;
}) {
	if (!args.state.yjsSnapshotAsset.r2Key) {
		const errorMessage = "yjsSnapshotAsset.r2Key is not set";
		const errorData = {
			nodeId: args.state.fileNode._id,
			assetId: args.state.yjsSnapshotAsset._id,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: args.state.yjsSnapshotAsset.r2Key }).then(
		(response) => response.arrayBuffer(),
	);
	const updatesAfterSnapshot = args.state.yjsUpdatesDocs.filter(
		(update) => update.sequence > args.state.yjsSnapshotDoc.sequence,
	);
	const snapshotUpdate = files_u8_to_array_buffer(
		mergeUpdates([
			new Uint8Array(baseSnapshotUpdate),
			...updatesAfterSnapshot.map((update) => new Uint8Array(update.update)),
		]),
	);

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
	// Read text under the node's stored shape. The getter's first-statement guard refuses a
	// document whose text is not addressable under that shape.
	const text = files_yjs_doc_get_text({
		yjsDoc,
		rootKind: args.state.fileNode.textKind,
	});

	if (text._nay) {
		return text;
	}

	return Result({
		_yay: {
			yjsDoc,
			text: text._yay,
			snapshotUpdate,
			sequence: args.state.yjsLastSequenceDoc.lastSequence,
		},
	});
}
