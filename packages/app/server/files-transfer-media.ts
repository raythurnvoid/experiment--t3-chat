import type { Editor } from "@tiptap/core";
import { Result } from "common/errors-as-values-utils.ts";
import { files_media_parse_src } from "../shared/files-media.ts";

/**
 * Rewrite media in the caller's headless copy editor.
 * The caller must resolve and authorize exact source refs and supply private destination refs.
 * Return `_yay: null` on success or `_nay.data.unresolvedRefs` in document order, without duplicates.
 * Refusal details contain original refs. Authorize and redact them before exposing them.
 */
export function files_transfer_rewrite_media_refs(args: {
	mut_editor: Editor;
	referenceMap: ReadonlyMap<string, string>;
}) {
	const editor = args.mut_editor;
	const state = editor.state;
	const transaction = state.tr;
	const unresolvedRefs = new Set<string>();

	state.doc.descendants((node, pos) => {
		if (node.type.name !== "image" && node.type.name !== "video") return;
		const src: unknown = node.attrs.src;
		if (typeof src !== "string") return;
		const reference = files_media_parse_src(src);
		if (reference.kind !== "file" && reference.kind !== "private") return;

		const destination = args.referenceMap.get(src);
		if (destination === undefined) {
			unresolvedRefs.add(src);
		} else if (destination !== src) {
			transaction.setNodeAttribute(pos, "src", destination);
		}
	});

	// Keep the editor unchanged until every app-media reference has a mapping.
	if (unresolvedRefs.size > 0) {
		return Result({
			_nay: {
				name: "nay",
				message: "Missing media mappings",
				data: { unresolvedRefs: [...unresolvedRefs] },
			},
		});
	}

	if (transaction.docChanged) {
		// Apply only this transfer transaction. Editing plugins can append paragraphs or links.
		// Rebuild their state against the copied document after the update.
		editor.view.updateState(
			state.reconfigure({ plugins: [] }).apply(transaction).reconfigure({ plugins: state.plugins }),
		);
	}

	return Result({ _yay: null });
}
