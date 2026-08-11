// Yjs helpers for files: Y.Doc construction, update/diff plumbing, and Tiptap-editor bridging.
//
// Split out of `shared/files.ts` for module-eval weight: importing `yjs`/`y-prosemirror` must not
// tax consumers that only need the lean helpers in `shared/files.ts`. Keep this module free of
// Tiptap runtime imports (`@tiptap/core` type imports are fine); Tiptap-heavy helpers live in
// `shared/files-tiptap.ts`.

import {
	Doc as YDoc,
	diffUpdate,
	encodeStateAsUpdate,
	applyUpdate,
	encodeStateVector,
	decodeUpdate,
	decodeUpdateV2,
	Item as YItem,
	ContentString as YContentString,
	ContentDeleted as YContentDeleted,
} from "yjs";
import { updateYFragment } from "y-prosemirror";
import type { Editor } from "@tiptap/core";
import { Result } from "common/errors-as-values-utils.ts";
import { files_YJS_DOC_KEYS, files_yjs_doc_is_diff_update_empty, type files_YjsRootKind } from "./files.ts";
import { DIFF_DELETE, DIFF_EQUAL } from "@sanity/diff-match-patch";
import { files_text_diff_compute } from "./files-text-diff.ts";

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
 * Refusal message the server reserve gate returns when the aggregate unmaterialized budget
 * would be crossed. The gate schedules immediate materialization before answering, so a retry
 * a moment later is expected to succeed. Keep it here, not in `convex/files_nodes.ts`: the
 * client Yjs stream compares against it to retry instead of declaring the document broken.
 */
export const files_yjs_COMPACTION_RETRY_MESSAGE = "File updates are being compacted, retry in a moment";

// #region shape guards
// The read-side backstop for both document shapes. The refusal is a `Result`. The guard logs
// nothing because it has no node id: each caller logs in its own runtime's format with the id
// it already holds, and the `_nay.cause` carries the raw facts so the caller does not re-derive
// them. Public Convex boundaries must strip that `cause` before returning (`v_result` rejects it).

/**
 * Refusal message for a plain-text document whose text the line diff cannot address by offset.
 */
export const files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE = "File text is not addressable";

/**
 * Refusal message for a rich-text document whose only named root is the plain-text one.
 */
export const files_yjs_RICH_TEXT_SHAPE_MISMATCH_MESSAGE = "File document does not match its rich text shape";

/**
 * Check that a document is safe to read and write under the shape its node declares.
 *
 * `plain_text` branch — the parity check. `toString()` concatenates only string content, while
 * `length` also counts embeds and child types. The line diff addresses the text by offset, so
 * the document is safe to edit exactly when the two numbers agree. Parity does not catch every
 * wrong root type: a `Y.Map` named `plain_text` keeps parity true and reads `""`. That case is
 * closed by the byte doors instead (door 1 refuses `parentSub` items, door 2 requires the plain
 * root's `_map` to be empty), so do not delete either door check because "the getter already
 * checks".
 *
 * `rich_text` branch — a name test: refuse when the plain-text root is present and the rich-text
 * root is absent. This test MUST read `share` before any accessor call on the document. The
 * order matters in both directions: calling `getXmlFragment(richText)` first would make the
 * test allow a corrupted document (accessors register the root they read), and calling
 * `getText(plainText)` first would make it refuse an ordinary empty Markdown document (the
 * accessor registers `plain_text` on a doc whose `share` was empty). The test reads stored
 * history, so it is only safe because door 1's byte check ships in the same deploy. Without the
 * door, any `content.write` member could push bytes that create a root named `plain_text` into
 * a never-written Markdown file, and this guard would then refuse that file forever.
 *
 * `getText()` on the plain branch is safe on every server-reconstructed document: a root that
 * arrived through `applyUpdate` is stored as a bare `AbstractType` and `getText` coerces it.
 * `Y.Doc.get()` only throws when the same root was already instantiated as another concrete
 * type on the same doc, so never instantiate both roots up front on a document this guard reads.
 */
export function files_yjs_doc_check_text_addressable(args: { yjsDoc: YDoc; rootKind: files_YjsRootKind }) {
	if (args.rootKind === "rich_text") {
		const hasPlainTextRoot = args.yjsDoc.share.has(files_YJS_DOC_KEYS.plainText);
		const hasRichTextRoot = args.yjsDoc.share.has(files_YJS_DOC_KEYS.richText);
		if (hasPlainTextRoot && !hasRichTextRoot) {
			return Result({
				_nay: {
					name: "nay",
					message: files_yjs_RICH_TEXT_SHAPE_MISMATCH_MESSAGE,
					cause: { hasPlainTextRoot, hasRichTextRoot },
				},
			});
		}
		return Result({ _yay: null });
	}

	const plainTextRoot = args.yjsDoc.getText(files_YJS_DOC_KEYS.plainText);
	const visibleLength = plainTextRoot.toString().length;
	if (visibleLength !== plainTextRoot.length) {
		return Result({
			_nay: {
				name: "nay",
				message: files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE,
				cause: { toStringLength: visibleLength, length: plainTextRoot.length },
			},
		});
	}
	return Result({ _yay: null });
}

/**
 * Read the plain-text root's map-slot count. Door 2 asserts this is 0 beside the parity check:
 * a `Y.Map` named `plain_text` passes the parity check and reads as `""` because its content
 * lives in `_map`, which neither `toString()` nor `length` sees.
 */
export function files_yjs_doc_plain_text_root_map_size(args: { yjsDoc: YDoc }) {
	return args.yjsDoc.getText(files_YJS_DOC_KEYS.plainText)._map.size;
}
// #endregion shape guards

// #region plain text branches
// The plain-text (`Y.Text`) branches of the shape dispatchers in `shared/files-tiptap.ts`.
// The dispatchers' rich branches need Tiptap; these branches touch no Tiptap, so they live here
// (this module must stay free of Tiptap runtime imports, see the header). They assume the
// dispatcher already ran the parity check as its first statement.

/**
 * Read a plain-text document's `Y.Text` root as a string. Returns the text exactly as stored: no
 * forced trailing newline (that is rich-text-only behavior) and no normalization of any kind.
 */
export function files_yjs_doc_get_plain_text(args: { yjsDoc: YDoc }) {
	return args.yjsDoc.getText(files_YJS_DOC_KEYS.plainText).toString();
}

/**
 * Apply the minimal character-refining diff from the document's current text to `text`.
 *
 * A whole-document replace would double the file under concurrent saves: both saves insert
 * their full text and the merge keeps both inserts. A line-only diff would anchor two edits on
 * the same line at the same position, so they would merge as duplicate lines. The bounded
 * character diff makes concurrent saves merge at the characters the users actually changed.
 * When the diff runs out of budget, this returns the diff module's visible refusal and writes
 * nothing.
 */
export function files_yjs_doc_update_plain_text_from_text(args: { text: string; mut_yjsDoc: YDoc }) {
	const plainTextRoot = args.mut_yjsDoc.getText(files_YJS_DOC_KEYS.plainText);
	const sourceText = plainTextRoot.toString();
	if (sourceText === args.text) {
		return Result({ _yay: args.mut_yjsDoc });
	}

	const diffs = files_text_diff_compute({ sourceText, targetText: args.text });
	if (diffs._nay) {
		return diffs;
	}

	// Collect operations with source offsets front-to-back, then apply them end-to-start inside
	// one transaction. `Y.Text.delete`/`insert` index into the type's current content, so
	// applying from the end keeps every earlier offset valid. The diff module already guarantees
	// no operation boundary splits a surrogate pair.
	const operations: Array<{ index: number; deleteLength: number; insertText: string }> = [];
	let sourceIndex = 0;
	for (const [kind, tupleText] of diffs._yay) {
		if (kind === DIFF_EQUAL) {
			sourceIndex += tupleText.length;
		} else if (kind === DIFF_DELETE) {
			operations.push({ index: sourceIndex, deleteLength: tupleText.length, insertText: "" });
			sourceIndex += tupleText.length;
		} else {
			operations.push({ index: sourceIndex, deleteLength: 0, insertText: tupleText });
		}
	}

	args.mut_yjsDoc.transact(() => {
		for (let i = operations.length - 1; i >= 0; i--) {
			const operation = operations[i];
			if (operation.deleteLength > 0) {
				plainTextRoot.delete(operation.index, operation.deleteLength);
			}
			if (operation.insertText) {
				plainTextRoot.insert(operation.index, operation.insertText);
			}
		}
	}, "user-edit");

	return Result({ _yay: args.mut_yjsDoc });
}

/**
 * Build a fresh plain-text document from a string. The parity check cannot fail here because
 * this function builds the document itself. So the create direction is protected only by the
 * `rootKind` the caller dispatched on: a wrong `rootKind` at a create site produces a wrongly
 * shaped document that nothing downstream can catch.
 */
export function files_yjs_doc_create_plain_text_from_text(args: { text: string }) {
	const yjsDoc = new YDoc();
	// Skip the root registration for empty text: an empty root is never persisted anyway
	// (`encodeStateAsUpdate` writes structs and an empty root has none).
	if (args.text) {
		yjsDoc.transact(() => {
			yjsDoc.getText(files_YJS_DOC_KEYS.plainText).insert(0, args.text);
		}, "snapshot-restore");
	}
	return yjsDoc;
}
// #endregion plain text branches

// #region client update scan
// Door checks over client-supplied Yjs bytes. Door 1 (`files_db_yjs_push_update`) receives an
// incremental diff. Door 2 (paged pending states) receives whole document states and reuses
// only the encoding rules here: a whole state legitimately carries content an incremental
// plain-text diff never should, so the content whitelist must not run on door 2's input.

/**
 * Refusal messages for the update scans. Stable: both doors return them through `v_result`
 * boundaries and tests match on them.
 */
export const files_yjs_MALFORMED_UPDATE_MESSAGE = "Malformed update";
export const files_yjs_UNSUPPORTED_UPDATE_ENCODING_MESSAGE = "Unsupported update encoding";
export const files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE = "Update does not match the file shape";

/**
 * Encoding rule shared by both doors, for one non-empty v1 value. Decode it, and when the
 * decode yields no structs and no deletions, tell a canonical v1 no-op apart from a V2
 * encoding. `Y.decodeUpdate` does not throw on well-formed V2 bytes, it just returns zero
 * structs. So try `decodeUpdateV2`: when it succeeds the bytes are a V2 encoding we do not
 * support, and when it also throws the value is a genuine v1 no-op. Malformed bytes throw and
 * are refused. Catching and continuing instead would let any malformed value pass the check.
 *
 * Returns the decoded v1 structs so door 1 can run its content whitelist without a second decode.
 */
export function files_yjs_decode_v1_update(args: { update: Uint8Array }) {
	let decoded: ReturnType<typeof decodeUpdate>;
	try {
		decoded = decodeUpdate(args.update);
	} catch (error) {
		return Result({
			_nay: { name: "nay", message: files_yjs_MALFORMED_UPDATE_MESSAGE, cause: error },
		});
	}

	if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) {
		let isV2 = false;
		try {
			decodeUpdateV2(args.update);
			isV2 = true;
		} catch {
			// A genuine v1 no-op: `decodeUpdateV2` throws on it. Allow it and store it unchanged.
		}
		if (isV2) {
			return Result({
				_nay: { name: "nay", message: files_yjs_UNSUPPORTED_UPDATE_ENCODING_MESSAGE },
			});
		}
	}

	return Result({ _yay: decoded });
}

/**
 * Door 1's content check for one client-supplied incremental update, per `rootKind`.
 *
 * `plain_text`: whitelist over the decoded v1 structs. A struct that is not a `Y.Item` is
 * refused: `GC` needs a deleted nested type a flat `Y.Text` cannot contain, and `Skip` only
 * comes out of `mergeUpdates` across a gap, which no plain-text client path produces. An
 * `Item`'s content must be `ContentString` or `ContentDeleted`. `ContentFormat` is deliberately
 * not allowed: Monaco never emits format marks, and a format item can carry a large hidden
 * payload the parity check never sees. `parentSub` must be null: a map-slot item would land in
 * the plain root's `_map`, and door 2 refuses a non-empty `_map` forever, so if door 1 accepted
 * such an item the file could never pass door 2 again.
 *
 * Compare content kinds with `instanceof`, not `constructor.name`: the Convex bundler's
 * `keepNames` setting belongs to a third-party CLI we neither own nor test. This is an
 * allow-list, so a renamed class would fail closed. `instanceof` needs exactly one copy of the
 * `yjs` package in the dependency tree. A second copy (a lockfile change can introduce one
 * silently) would make every comparison false and refuse every plain-text save.
 *
 * `rich_text`: not a whitelist, because rich text legitimately carries every content kind.
 * Apply the update to a throwaway `Y.Doc` and refuse when it creates the plain-text root. A
 * yjs update names a root only when it creates one, so a legitimate incremental edit creates no
 * roots on the throwaway doc and a legitimate first write creates only `"default"`.
 */
export function files_yjs_scan_client_update(args: { update: Uint8Array; rootKind: files_YjsRootKind }) {
	const decoded = files_yjs_decode_v1_update({ update: args.update });
	if (decoded._nay) {
		return decoded;
	}

	if (args.rootKind === "rich_text") {
		const probeDoc = new YDoc();
		try {
			applyUpdate(probeDoc, args.update);
		} catch (error) {
			return Result({
				_nay: { name: "nay", message: files_yjs_MALFORMED_UPDATE_MESSAGE, cause: error },
			});
		}
		if (probeDoc.share.has(files_YJS_DOC_KEYS.plainText)) {
			return Result({
				_nay: {
					name: "nay",
					message: files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
					cause: { refusedRoot: files_YJS_DOC_KEYS.plainText },
				},
			});
		}
		return Result({ _yay: null });
	}

	for (const struct of decoded._yay.structs) {
		if (!(struct instanceof YItem)) {
			return Result({
				_nay: {
					name: "nay",
					message: files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
					cause: { refusedStruct: struct.constructor.name },
				},
			});
		}
		if (struct.parentSub !== null) {
			return Result({
				_nay: {
					name: "nay",
					message: files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
					cause: { refusedParentSub: struct.parentSub },
				},
			});
		}
		if (!(struct.content instanceof YContentString) && !(struct.content instanceof YContentDeleted)) {
			return Result({
				_nay: {
					name: "nay",
					message: files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
					cause: { refusedContent: struct.content.constructor.name },
				},
			});
		}
	}

	return Result({ _yay: null });
}
// #endregion client update scan
