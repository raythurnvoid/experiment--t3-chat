// The plugin rule for app file refs (`bonobo-file://`): a plugin may add a ref only to a file it can read itself.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { Result } from "common/errors-as-values-utils.ts";
import { access_control_create_file_checker } from "../convex/access_control.ts";
import { files_pending_nodes_db_resolve_read_target } from "../convex/files_pending_nodes_db.ts";
import { plugins_sandbox_subject } from "../convex/plugins_service_accounts.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import type { files_YjsRootKind } from "../shared/files.ts";
import { files_share_rich_text_MAX_MEDIA, files_share_rich_text_prepare } from "../shared/files-share-rich-text.ts";
import { files_headless_tiptap_editor_create, files_headless_tiptap_editor_get_markdown } from "../shared/files-tiptap.ts";
import { files_saved_placement_db_get_node } from "./files-saved-placement.ts";
import { files_transfer_rewrite_media_refs } from "./files-transfer-media.ts";

/**
 * The app file refs that `content` adds to `previousContent`, and whether it keeps any old ones. Read
 * them as the editor does, and as the public page does: it parses the saved text on its own. Plain text
 * never shows media.
 *
 * Run it in an action: parsing a large text is too slow for a mutation.
 */
export function files_media_refs_added(args: {
	content: string;
	previousContent: string | null;
	rootKind: files_YjsRootKind;
}) {
	const refs_of = (text: string) => {
		const refs = new Set<string>();
		if (args.rootKind === "plain_text") return Result({ _yay: refs });
		// The saved text is rebuilt from the document, and the rebuild can differ from the text. A gap
		// in the Markdown writer could then turn text into markdown, as a code block holding a fence
		// line once did. Read the rebuilt text too. Each later rebuild (for example a person saving the
		// file) can differ again, so this covers only the rebuild the server does on its own.
		let current = text;
		for (let round = 0; round < 2; round++) {
			const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: current } });
			if (editor._nay) return Result({ _nay: { message: editor._nay.message } });
			let rebuilt: string;
			try {
				rebuilt = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
				// With no mappings, every app media ref comes back as unresolved.
				const found = files_transfer_rewrite_media_refs({ mut_editor: editor._yay, referenceMap: new Map() });
				for (const src of found._nay?.data.unresolvedRefs ?? []) refs.add(src);
			} finally {
				editor._yay.destroy();
			}
			const prepared = files_share_rich_text_prepare({ text: current, textKind: args.rootKind });
			for (const item of prepared._yay?.media ?? []) refs.add(item.src);
			current = rebuilt;
		}
		return Result({ _yay: refs });
	};

	const refs = refs_of(args.content);
	if (refs._nay) return refs;
	// An old text that does not parse keeps no refs, so every ref counts as added.
	const previousRefs = args.previousContent === null ? null : refs_of(args.previousContent)._yay;
	const fileRefs = [...refs._yay].filter((src) => {
		const parsed = files_media_parse_src(src);
		return parsed.kind === "file" || parsed.kind === "private";
	});
	return Result({
		_yay: {
			added: fileRefs.filter((src) => !previousRefs?.has(src)),
			keepsOldRefs: fileRefs.some((src) => previousRefs?.has(src)),
		},
	});
}

/**
 * Refuse refs the plugin cannot read: as its member inside its sandbox roots, or the file an upload run
 * was started for. Otherwise knowing an id would be enough to show a locked file, for example on the
 * document's public page. A write that adds more refs than the public page shows is refused, so the
 * check stays small.
 */
export async function files_media_refs_db_check_plugin_added(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installation: Doc<"plugins_workspace_installations">;
		userId: Id<"users">;
		/** An upload run's source file. The run may already download it. */
		sourceNodeId?: Id<"files_nodes">;
		sourceAssetId?: Id<"files_r2_assets">;
		addedFileRefs: string[];
	},
) {
	if (args.addedFileRefs.length > files_share_rich_text_MAX_MEDIA) {
		return Result({
			_nay: {
				name: "file_reference_limit",
				message: `This write adds more than ${files_share_rich_text_MAX_MEDIA} new file references`,
			},
		});
	}

	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	const checker = access_control_create_file_checker(ctx, {
		...scope,
		subject: plugins_sandbox_subject(args.installation, args.userId),
	});
	const nodes: Doc<"files_nodes">[] = [];
	for (const src of args.addedFileRefs) {
		const parsed = files_media_parse_src(src);
		const privateId =
			parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
		// A private draft counts only once it is published, as the saved file it became.
		const target = privateId
			? await files_pending_nodes_db_resolve_read_target(ctx, { ...scope, target: { kind: "private", id: privateId } })
			: null;
		const nodeId =
			parsed.kind === "file"
				? ctx.db.normalizeId("files_nodes", parsed.fileNodeId)
				: target?.kind === "saved"
					? target.id
					: null;
		const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
		// Missing and locked files get the same answer, so the plugin cannot learn which ids exist.
		if (
			!node ||
			node.organizationId !== scope.organizationId ||
			node.workspaceId !== scope.workspaceId ||
			node.archiveOperationId !== null ||
			node.kind !== "file" ||
			(node._id !== args.sourceNodeId && !(await checker.can(node, "content.read")))
		) {
			return Result({
				_nay: {
					name: "file_reference_denied",
					message: `This write adds a reference to a file this plugin cannot read: ${src}`,
				},
			});
		}
		// Upload authority covers only the source bytes pinned by the run. A replacement needs read access.
		if (
			node._id !== args.sourceNodeId ||
			node.assetId === args.sourceAssetId ||
			(await checker.can(node, "content.read"))
		) {
			nodes.push(node);
		}
	}
	// The write sink may publish only these exact checked files and assets, in this transaction.
	return Result({ _yay: nodes });
}
