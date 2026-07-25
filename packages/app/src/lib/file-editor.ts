// Client-side half of the content size cap. `files_MAX_TEXT_CONTENT_BYTES` is enforced on every
// server write path that receives a whole string, but the editors only send Yjs deltas, so the
// size is never knowable server-side until materialization. These helpers let the editors measure
// and reject over-cap content before it is persisted.
//
// Imports `shared/files.ts` directly rather than `@/lib/files.ts` to stay out of the Convex,
// Monaco and Yjs module graph: these are plain functions shared by both editors.

import { files_MAX_TEXT_CONTENT_BYTES, files_format_size } from "../../shared/files.ts";

/** Editors show the content-size badge from here up. 80% of `files_MAX_TEXT_CONTENT_BYTES`. */
export const file_editor_SIZE_WARN_BYTES = 720_000;

/**
 * Character count above which the editors start measuring exact Markdown bytes.
 *
 * The character count is a lower bound on the Markdown byte size (every character is at
 * least one UTF-8 byte, and Markdown syntax only adds more), so below this gate the
 * content is provably under the cap and the expensive measure can be skipped.
 */
export const file_editor_SIZE_MEASURE_CHARS = 400_000;

/**
 * Badge shown in the editor toolbars once the content gets close to the size cap.
 * Returns `null` while the content is comfortably under the cap.
 */
export function file_editor_get_size_badge_text(byteSize: number | null) {
	if (byteSize == null || byteSize < file_editor_SIZE_WARN_BYTES) {
		return null;
	}

	const isOverCap = byteSize > files_MAX_TEXT_CONTENT_BYTES;

	return {
		isOverCap,
		label: isOverCap
			? "Over limit"
			: `${files_format_size(byteSize)} / ${files_format_size(files_MAX_TEXT_CONTENT_BYTES)}`,
	};
}

/** Message shown when an edit or a save is rejected for going over the size cap. */
export function file_editor_get_size_error_message(byteSize: number) {
	return `This file would be ${files_format_size(byteSize)}, over the ${files_format_size(files_MAX_TEXT_CONTENT_BYTES)} limit. Remove about ${files_format_size(byteSize - files_MAX_TEXT_CONTENT_BYTES)}.`;
}

/**
 * Whether an editor change must be rejected for going over the size cap.
 *
 * Only local changes that grow the document are blocked: remote collaboration changes must
 * always apply or the local document desyncs, and deletions must always apply or the user
 * cannot get back under the cap.
 */
export function file_editor_should_block_growth(args: {
	isOverCap: boolean;
	isRemoteChange: boolean;
	docSizeBefore: number;
	docSizeAfter: number;
}) {
	if (!args.isOverCap || args.isRemoteChange) {
		return false;
	}

	return args.docSizeAfter > args.docSizeBefore;
}
