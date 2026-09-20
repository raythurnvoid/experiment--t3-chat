import {
	files_editable_text_shape_of,
	files_get_utf8_byte_size,
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_normalize_text_document_input,
} from "../shared/files.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "../convex/files_nodes_content.ts";

/**
 * Uploads and generated files make the same byte-to-text decision before creating content.
 * Invalid or oversized text remains exact stored bytes.
 */
export function files_upload_content_from_bytes(args: { bytes: Uint8Array; contentType: string }) {
	const shape = files_editable_text_shape_of(args.contentType);
	if (!shape || args.bytes.byteLength > files_MAX_TEXT_CONTENT_BYTES) return { kind: "stored" as const };

	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(args.bytes);
	} catch {
		return { kind: "stored" as const };
	}
	if (decoded.includes("\u0000")) return { kind: "stored" as const };

	const text = files_normalize_text_document_input(decoded);
	if (files_get_utf8_byte_size(text) > files_MAX_TEXT_CONTENT_BYTES) return { kind: "stored" as const };
	const snapshot = files_nodes_create_yjs_snapshot_update_from_text({ text, rootKind: shape.rootKind });
	if (snapshot._nay || snapshot._yay.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES)
		return { kind: "stored" as const };

	return {
		kind: "text" as const,
		contentType: shape.contentType,
		textKind: shape.rootKind,
		text,
		snapshotUpdate: snapshot._yay,
	};
}
