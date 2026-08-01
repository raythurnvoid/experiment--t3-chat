// Yjs helpers for files: Y.Doc construction, update/diff plumbing, and Tiptap-editor bridging.
//
// Split out of `shared/files.ts` for module-eval weight: importing `yjs`/`y-prosemirror` must not
// tax consumers that only need the lean helpers in `shared/files.ts`. Keep this module free of
// Tiptap runtime imports (`@tiptap/core` type imports are fine); Tiptap-heavy helpers live in
// `shared/files-tiptap.ts`.

import { Doc as YDoc, diffUpdate, encodeStateAsUpdate, applyUpdate, encodeStateVector } from "yjs";
import { updateYFragment } from "y-prosemirror";
import type { Editor } from "@tiptap/core";
import { files_u8_equals, files_YJS_DOC_KEYS, files_yjs_doc_is_diff_update_empty } from "./files.ts";

export function files_yjs_create_empty_state_update() {
	return encodeStateAsUpdate(new YDoc());
}

export function files_yjs_doc_apply_array_buffer_update(mut_yjsDoc: YDoc, update: ArrayBuffer) {
	if (update.byteLength === 0) {
		return;
	}

	applyUpdate(mut_yjsDoc, new Uint8Array(update));
}

/**
 * Applies incremental Yjs updates to an existing Y.Doc.
 *
 * @param mut_yjsDoc - The Y.Doc instance to apply updates to (mutated in place)
 * @param incrementalUpdates - Array of incremental Yjs updates (ArrayBuffer) to apply
 */
export function files_yjs_doc_apply_incremental_array_buffer_updates(
	mut_yjsDoc: YDoc,
	incrementalUpdates: Array<ArrayBuffer>,
): void {
	for (const incrementalUpdate of incrementalUpdates) {
		files_yjs_doc_apply_array_buffer_update(mut_yjsDoc, incrementalUpdate);
	}
}

/**
 * Creates a Y.Doc from a Yjs update.
 *
 * Applies the update to a new Y.Doc instance.
 *
 * Optionally applies additional incremental updates.
 *
 * @param update - The initial Yjs update (ArrayBuffer) to apply to create the Y.Doc
 * @param args - Optional configuration object
 * @param args.additionalIncrementalArrayBufferUpdates - Optional array of incremental Yjs updates (ArrayBuffer)
 * to apply after the initial update
 * @returns A new Y.Doc instance with all updates applied
 */
export function files_yjs_doc_create_from_array_buffer_update(
	update: ArrayBuffer,
	args?: { additionalIncrementalArrayBufferUpdates?: Array<ArrayBuffer> },
): YDoc {
	const yjsDoc = new YDoc();
	files_yjs_doc_apply_array_buffer_update(yjsDoc, update);

	if (args?.additionalIncrementalArrayBufferUpdates) {
		files_yjs_doc_apply_incremental_array_buffer_updates(yjsDoc, args.additionalIncrementalArrayBufferUpdates);
	}

	return yjsDoc;
}

export function files_yjs_doc_update_from_tiptap_editor(args: {
	mut_yjsDoc: YDoc;
	tiptapEditor: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsFragment = args.mut_yjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText);

	args.mut_yjsDoc.transact(() => {
		updateYFragment(args.mut_yjsDoc, yjsFragment, args.tiptapEditor.state.doc, {
			mapping: new Map(),
			isOMark: new Map(),
		});
	}, args.opKind);
}

export function files_yjs_doc_create_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = new YDoc();
	files_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.tiptapEditor,
		opKind: "snapshot-restore",
	});
	return yjsDoc;
}

export function files_yjs_doc_clone(args: { yjsDoc: YDoc }) {
	const clonedDoc = new YDoc();
	applyUpdate(clonedDoc, encodeStateAsUpdate(args.yjsDoc));
	return clonedDoc;
}

/**
 * Computes the remaining portion of a diff update that is not already present in a target Y.Doc.
 *
 * This is useful when a diff update was produced from an older base state and you want to keep only
 * the operations that the target Y.Doc still needs. Yjs performs this by filtering the diff update
 * against the target doc's current state vector.
 *
 * @param args.diffUpdate - Diff update bytes to filter against the target doc state.
 * @param args.yjsDoc - Target Y.Doc whose state vector is used to remove already-applied operations.
 *
 * @returns `null` when the target Y.Doc already contains the entire diff update; otherwise the
 * remaining diff update bytes.
 */
export function files_yjs_doc_compute_remaining_diff_update_from_yjs_doc(args: {
	diffUpdate: ArrayBuffer;
	yjsDoc: YDoc;
}) {
	if (args.diffUpdate.byteLength === 0) {
		return null;
	}

	const remainingDiffUpdate = diffUpdate(new Uint8Array(args.diffUpdate), encodeStateVector(args.yjsDoc));
	return files_yjs_doc_is_diff_update_empty(remainingDiffUpdate) ? null : remainingDiffUpdate;
}

export function files_yjs_compute_diff_update_from_state_vector(args: {
	yjsDoc: YDoc;
	yjsBeforeStateVector: Uint8Array;
}) {
	const diffUpdate = encodeStateAsUpdate(args.yjsDoc, args.yjsBeforeStateVector);
	return files_yjs_doc_is_diff_update_empty(diffUpdate) ? null : diffUpdate;
}

export function files_yjs_compute_diff_update_from_yjs_doc(args: { yjsDoc: YDoc; yjsBeforeDoc: YDoc }) {
	const yjsBeforeStateVector = encodeStateVector(args.yjsBeforeDoc);
	return files_yjs_compute_diff_update_from_state_vector({ yjsDoc: args.yjsDoc, yjsBeforeStateVector });
}

/**
 * Compare two diff updates that were produced from the same base Y.Doc.
 *
 * Performs a fast byte-level check first, then falls back to applying updates to
 * cloned docs and comparing their rich-text fragment JSON snapshots.
 *
 * @param args.baseYjsDoc - Base Y.Doc both diff updates are relative to
 * @param args.diffUpdateAFromBase - First diff update to compare
 * @param args.diffUpdateBFromBase - Second diff update to compare
 * @param args.diffUpdateBYjsDocFromBase - Optional precomputed doc with diffUpdateBFromBase already applied
 *
 * @returns `true` when both updates produce the same rich-text content
 */
export function files_yjs_doc_diff_updates_match(args: {
	baseYjsDoc: YDoc;
	diffUpdateAFromBase: ArrayBuffer;
	diffUpdateBFromBase: ArrayBuffer;
	diffUpdateBYjsDocFromBase?: YDoc;
}) {
	const isBytewiseMatch =
		args.diffUpdateAFromBase.byteLength === args.diffUpdateBFromBase.byteLength &&
		files_u8_equals(new Uint8Array(args.diffUpdateAFromBase), new Uint8Array(args.diffUpdateBFromBase));

	if (isBytewiseMatch) {
		return true;
	}

	const diffUpdateAYjsDoc = files_yjs_doc_clone({
		yjsDoc: args.baseYjsDoc,
	});
	files_yjs_doc_apply_array_buffer_update(diffUpdateAYjsDoc, args.diffUpdateAFromBase);

	let diffUpdateBYjsDoc = args.diffUpdateBYjsDocFromBase;
	if (!diffUpdateBYjsDoc) {
		diffUpdateBYjsDoc = files_yjs_doc_clone({
			yjsDoc: args.baseYjsDoc,
		});
		files_yjs_doc_apply_array_buffer_update(diffUpdateBYjsDoc, args.diffUpdateBFromBase);
	}

	return (
		diffUpdateAYjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText).toJSON() ===
		diffUpdateBYjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText).toJSON()
	);
}
