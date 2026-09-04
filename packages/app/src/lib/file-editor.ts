// Client-side half of the content size cap. `files_MAX_TEXT_CONTENT_BYTES` is enforced on every
// server write path that receives a whole string, but the editors only send Yjs deltas, so the
// server cannot see the size until materialization reconstructs the document. These helpers let
// the editors measure and reject over-cap content before it is persisted. They also build the
// message for the `files_nodes.contentTooLargeByteSize` state. Materialization sets that state when
// the reconstructed document is over the cap.
//
// The module also holds the small shared pieces of editor feedback, such as the warning about
// unsaved text that was dropped.
//
// Imports `shared/files.ts` directly rather than `@/lib/files.ts` to stay out of the Convex,
// Monaco and Yjs module graph: these are plain functions shared by both editors.

import { toast } from "sonner";
import { files_MAX_TEXT_CONTENT_BYTES, files_format_size } from "../../shared/files.ts";

/**
 * Tell the member that text they never saved is gone, and offer it back through the clipboard.
 *
 * A file with collaboration turned off keeps unsaved text only inside the open editor. Closing
 * the file, switching the view, or another member turning collaboration on all replace that
 * editor, and the text goes with it. All three non-collaborative editors call this from their
 * unmount cleanup, so the warning reads the same everywhere.
 *
 * The toast stays up for 30 seconds because copying the text back is the only way to keep it.
 */
export function file_editor_warn_unsaved_text_dropped(lostText: string) {
	toast.warning("Your unsaved changes to this file were discarded.", {
		duration: 30_000,
		action: {
			label: "Copy text",
			onClick: () => navigator.clipboard.writeText(lostText),
		},
	});
}

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

/**
 * Announcement for the toolbar live region, so the size state reaches screen readers.
 * The badge alone is silent, and over the cap the editor stops accepting input, which
 * without this reads as a broken keyboard.
 *
 * Returns the same string for every size within a state, so the live region only speaks
 * when the state actually changes instead of on every measured byte.
 */
export function file_editor_get_size_status_message(args: { byteSize: number | null; blocks: "editing" | "saving" }) {
	const badge = file_editor_get_size_badge_text(args.byteSize);

	if (!badge) {
		return "";
	}

	if (!badge.isOverCap) {
		return "File size is close to the limit.";
	}

	return args.blocks === "editing"
		? "File is over the size limit. Remove content to keep editing."
		: "File is over the size limit. Remove content to save.";
}

/** Message shown when an edit or a save is rejected for going over the size cap. */
export function file_editor_get_size_error_message(byteSize: number) {
	return `This file would be ${files_format_size(byteSize)}, over the ${files_format_size(files_MAX_TEXT_CONTENT_BYTES)} limit. Remove about ${files_format_size(byteSize - files_MAX_TEXT_CONTENT_BYTES)}.`;
}

/**
 * Message for the durable `files_nodes.contentTooLargeByteSize` state, shown while the server
 * refuses to materialize the file. Editors keep syncing the live document, so nobody loses work.
 * What stops updating is the saved copy. Downloads, search, the bash tools and the AI tools read
 * that copy.
 */
export function file_editor_get_content_too_large_message(byteSize: number) {
	return `This file is ${files_format_size(byteSize)}, over the ${files_format_size(files_MAX_TEXT_CONTENT_BYTES)} limit. Its saved copy is not updating. Remove about ${files_format_size(byteSize - files_MAX_TEXT_CONTENT_BYTES)}.`;
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
