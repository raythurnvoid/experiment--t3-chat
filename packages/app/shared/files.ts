// Lean, cross-runtime file helpers: constants, name/path normalization, and byte helpers.
// Keep this module free of heavy runtime imports (@tiptap/* runtime, yjs,
// y-prosemirror, marked): Convex evaluates a function module's full static import graph on cold
// start, and many consumers only need these pure helpers. Type-only imports are fine. Yjs helpers
// live in `shared/files-yjs.ts`; Tiptap/Markdown helpers live in `shared/files-tiptap.ts`.

import stringByteLength from "string-byte-length";
import type { JSONContent as TiptapJSONContent } from "@tiptap/core";
import { composite_id } from "../shared/shared-utils.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { Result } from "common/errors-as-values-utils.ts";
import type { app_convex_Doc, app_convex_Id } from "./app-convex.ts";
import type { Merge } from "type-fest";

export const files_ROOT_ID = "root" as const;

export type files_PendingTarget = app_convex_Doc<"files_pending_updates">["target"];
export type files_PendingParent = app_convex_Doc<"files_pending_nodes">["parent"];
export type files_VisibleEntry =
	| {
			kind: "saved";
			node: app_convex_Doc<"files_nodes">;
			pendingUpdate: app_convex_Doc<"files_pending_updates"> | null;
			path: string;
	  }
	| {
			kind: "private";
			node: app_convex_Doc<"files_pending_nodes">;
			pendingUpdate: app_convex_Doc<"files_pending_updates">;
			path: string;
	  };

export type files_VisibleTreeNode = Omit<
	app_convex_Doc<"files_nodes">,
	"organizationId" | "workspaceId" | "createdBy" | "updatedBy" | "writePolicyScopeNodeId" | "writePolicy"
> & {
	organizationId: app_convex_Id<"organizations">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
	createdBy: app_convex_Id<"users">;
	updatedBy: app_convex_Id<"users">;
	canWrite: boolean;
	writeBlockedReason: "permission" | "read_only" | null;
	// Rule location is display-only. A selected writer may still edit.
	writePolicyState: "none" | "self" | "inherited";
	writePolicySourceNodeId?: app_convex_Id<"files_nodes">;
	writePolicySourcePath?: string;
};

export const files_SYNTHETIC_ROOT_FOLDER = {
	_id: files_ROOT_ID,
	_creationTime: 0,
	organizationId: "",
	workspaceId: "",
	path: "/",
	treePath: "/",
	pathDepth: 0,
	lowercaseExtension: null,
	name: "",
	kind: "folder",
	contentType: null,
	statsId: null,
	assetId: null,
	textKind: null,
	collaborationEnabled: null,
	archiveOperationId: null,
	yjsLastSequenceId: null,
	yjsSnapshotId: null,
	contentTooLargeByteSize: null,
	contentShapeMismatchAt: null,
	contentYjsStateTooLargeByteSize: null,
	contentFrontmatterTooLargeFieldCount: null,
	contentFrontmatterTooLargeIndexDocumentCount: null,
	restrictedScopeNodeId: null,
	parentId: "",
	updatedBy: "",
	createdBy: "",
	updatedAt: 0,
	// Root actions use the live workspace permission query.
	canWrite: false,
	writeBlockedReason: null,
	writePolicyState: "none",
} as const satisfies Merge<
	files_VisibleTreeNode,
	{
		_id: typeof files_ROOT_ID;
		organizationId: "";
		workspaceId: "";
		parentId: "";
		name: "";
		path: "/";
		treePath: "/";
		updatedBy: "";
		updatedAt: 0;
		createdBy: "";
		_creationTime: 0;
	}
>;

/**
 * Require Can manage when a child leaves its restricted scope.
 * Moving the scope folder itself keeps the restriction with it.
 *
 * Frontend mirror of `authorize_leaving_restricted_scope` in `convex/files_nodes.ts`. The backend
 * check is the authority; keep the two rules identical.
 */
export function files_can_move_node_between_restricted_scopes(args: {
	nodeId: app_convex_Id<"files_nodes">;
	sourceRestrictedScopeNodeId: app_convex_Id<"files_nodes"> | null;
	targetRestrictedScopeNodeId: app_convex_Id<"files_nodes"> | null;
	canManageRestrictedScope: (scopeNodeId: app_convex_Id<"files_nodes">) => boolean;
}) {
	return (
		!args.sourceRestrictedScopeNodeId ||
		args.sourceRestrictedScopeNodeId === args.nodeId ||
		args.sourceRestrictedScopeNodeId === args.targetRestrictedScopeNodeId ||
		args.canManageRestrictedScope(args.sourceRestrictedScopeNodeId)
	);
}

/**
 * Find every visible ancestor of a read-only node. Those ancestors cannot be renamed, moved, or
 * archived because that would also change the read-only node.
 *
 * Run this once for the whole visible tree instead of searching again for every row.
 */
export function files_collect_read_only_ancestor_ids(
	nodes: Array<Pick<files_VisibleTreeNode, "_id" | "parentId" | "canWrite">>,
) {
	// The map also accepts "root", which has no node.
	const nodesById = new Map<files_VisibleTreeNode["parentId"], (typeof nodes)[number]>();
	for (const node of nodes) {
		nodesById.set(node._id, node);
	}

	const ancestorIds = new Set<files_VisibleTreeNode["_id"]>();
	for (const node of nodes) {
		if (node.canWrite) {
			continue;
		}

		// Walk toward the root. Stop at a parent that was already handled.
		let parent = nodesById.get(node.parentId);
		while (parent && !ancestorIds.has(parent._id)) {
			ancestorIds.add(parent._id);
			parent = nodesById.get(parent.parentId);
		}
	}

	return ancestorIds;
}

/**
 * Get the read-only label and tooltip for one file-tree row. Return null when no label is needed.
 *
 * Describe a refused write without exposing the policy's selected writer.
 */
export function files_get_read_only_row_labels(args: {
	canWrite: boolean;
	writeBlockedReason: files_VisibleTreeNode["writeBlockedReason"];
	/** True when a writable row contains a visible read-only child. */
	hasVisibleReadOnlyDescendant: boolean;
}) {
	if (!args.canWrite) {
		return args.writeBlockedReason === "read_only"
			? { description: "protected", tooltip: "A file policy blocks editing" }
			: { description: "read-only", tooltip: "You don't have permission to edit this item" };
	}
	if (args.hasVisibleReadOnlyDescendant) {
		return { description: "contains read-only items", tooltip: "Contains read-only items" };
	}

	return null;
}

/**
 * Use the server's write answer for this user.
 *
 * A folder with a read-only child can still receive new children. It cannot be renamed, moved, or
 * archived because those actions would also change the read-only child.
 */
export function files_get_read_only_capabilities(args: { canWrite: boolean; hasVisibleReadOnlyDescendant: boolean }) {
	const isWritable = args.canWrite;
	const canChangeSubtree = isWritable && !args.hasVisibleReadOnlyDescendant;

	return {
		canEditContent: isWritable,
		canReceiveChildren: isWritable,
		canRelocateOrRename: canChangeSubtree,
		canArchiveOrRestore: canChangeSubtree,
	};
}

export const files_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "plain_text",
};

export const files_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.`;

export type files_ContentType =
	| `text/${"markdown" | "plain" | "html"}${"" | `;charset=${"utf-8"}`}`
	| "application/json"
	| "application/yaml"
	| "application/toml"
	| "text/csv"
	| "text/tab-separated-values"
	| "text/css"
	| "text/javascript"
	| "text/typescript"
	| "application/x-sh"
	| "application/sql"
	| "application/octet-stream";

/**
 * The shape of a file's Yjs document. Markdown files keep the rich text
 * (ProseMirror) document; every other editable text file gets a plain `Y.Text` document.
 */
export type files_YjsRootKind = "rich_text" | "plain_text";

export type files_SpecialFileName = "README.md" | "AGENTS.md" | "SKILL.md";

export type files_InlineAiModelId = "gpt-5-mini";

export const files_MAX_TEXT_CONTENT_BYTES = 900_000;

/**
 * Max bytes for one transported Yjs value: one `files_yjs_updates.update` and one pending state
 * page. Convex rejects values close to 1 MiB, so this cap keeps headroom above the visible
 * 900,000-byte text cap.
 */
export const files_MAX_YJS_WIRE_BYTES = 930_000;

/**
 * Max total bytes of not-yet-materialized update docs per file. This bounds the work one
 * materialization run has to merge. Enforcement starts in the shape-bridge slice; until then the
 * counters are only maintained.
 */
export const files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES = 8 * 1024 * 1024;

/**
 * Max count of not-yet-materialized update docs per file. Same contract as the byte budget above.
 */
export const files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT = 256;

/**
 * Max bytes of a whole reconstructed Yjs document state (snapshot plus updates), and of a sealed
 * pending full state. A legal full state can be much larger than one wire value because of
 * tombstones, so this is a separate limit from `files_MAX_YJS_WIRE_BYTES`.
 */
export const files_MAX_YJS_RECONSTRUCTED_STATE_BYTES = 4 * 1024 * 1024;

/**
 * Operator-only ceiling for the Yjs repair action. Normal reads and writes never use this limit.
 */
export const files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES = 16 * 1024 * 1024;

// #region content type policy
// `files_nodes.contentType` says what a file is. It picks the document shape of a text file,
// the editor language, and how a download is served. The file NAME is only a hint for creating
// a file when no type is known yet. A rename never changes the stored type.

/**
 * Canonical content type for each supported editable text type, keyed by the lowercase
 * `type/subtype` essence. Common aliases that browsers and tools send map to the same canonical
 * value, so `text/x-yaml` and `application/yaml` become one stored type.
 */
const FILES_EDITABLE_TEXT_CONTENT_TYPE_BY_ESSENCE = new Map<string, files_ContentType>([
	["text/markdown", "text/markdown;charset=utf-8"],
	["text/x-markdown", "text/markdown;charset=utf-8"],
	["text/plain", "text/plain;charset=utf-8"],
	["text/html", "text/html;charset=utf-8"],
	["application/json", "application/json"],
	["application/yaml", "application/yaml"],
	["application/x-yaml", "application/yaml"],
	["text/yaml", "application/yaml"],
	["text/x-yaml", "application/yaml"],
	["application/toml", "application/toml"],
	["text/csv", "text/csv"],
	["text/tab-separated-values", "text/tab-separated-values"],
	["text/css", "text/css"],
	["text/javascript", "text/javascript"],
	["application/javascript", "text/javascript"],
	["application/x-javascript", "text/javascript"],
	["text/typescript", "text/typescript"],
	["application/typescript", "text/typescript"],
	["application/x-sh", "application/x-sh"],
	["text/x-shellscript", "application/x-sh"],
	["application/sql", "application/sql"],
]);

/**
 * The content type a file name hints at. Only file creation reads this, and only when the caller
 * supplied no type of its own.
 */
const FILES_CONTENT_TYPE_HINT_BY_EXTENSION = new Map<string, files_ContentType>([
	["md", "text/markdown;charset=utf-8"],
	["txt", "text/plain;charset=utf-8"],
	["log", "text/plain;charset=utf-8"],
	["html", "text/html;charset=utf-8"],
	["htm", "text/html;charset=utf-8"],
	["json", "application/json"],
	["jsonc", "application/json"],
	["yaml", "application/yaml"],
	["yml", "application/yaml"],
	["toml", "application/toml"],
	["ini", "text/plain;charset=utf-8"],
	["csv", "text/csv"],
	["tsv", "text/tab-separated-values"],
	["css", "text/css"],
	["js", "text/javascript"],
	["mjs", "text/javascript"],
	["cjs", "text/javascript"],
	["jsx", "text/javascript"],
	["ts", "text/typescript"],
	["tsx", "text/typescript"],
	["sh", "application/x-sh"],
	["sql", "application/sql"],
]);

/**
 * Monaco language id per canonical editable text type. Anything unmapped renders as plain text.
 */
const FILES_MONACO_LANGUAGE_ID_BY_CONTENT_TYPE = new Map<files_ContentType, string>([
	["text/markdown;charset=utf-8", "markdown"],
	["text/html;charset=utf-8", "html"],
	["application/json", "json"],
	["application/yaml", "yaml"],
	["text/css", "css"],
	["text/javascript", "javascript"],
	["text/typescript", "typescript"],
	["application/x-sh", "shell"],
	["application/sql", "sql"],
]);

/**
 * Content types a signed download may serve inline. Everything else, `image/svg+xml` and
 * `text/html` included, must download as an attachment so hostile bytes cannot run on the R2
 * origin.
 */
const FILES_INLINE_SERVED_MEDIA_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"video/mp4",
	"video/webm",
]);

/**
 * A `type/subtype` essence: RFC 7231 token characters, lowercase, no spaces.
 */
const FILES_CONTENT_TYPE_ESSENCE_REGEX = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Keep a stored type short enough for one header value. It also refuses junk that only looks
 * like a type.
 */
const FILES_CONTENT_TYPE_MAX_LENGTH = 255;

/**
 * Same extension rule as `files_lowercase_extension` in `convex/files_nodes.ts`, which fills the
 * indexed `lowercaseExtension` field: a leading-dot name like `.gitignore` and a trailing-dot
 * name have no extension. Any other rule would let the hint and the index disagree.
 */
function files_extension_of(fileName: string) {
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
		return null;
	}
	return fileName.slice(dotIndex + 1).toLowerCase();
}

/**
 * Parse a content type. Return the lowercase `type/subtype` essence and the charset parameter
 * when one is present, or `null` when the value is not a valid `type/subtype`. Every parameter must
 * have the `name=value` form, so a broken value is refused instead of stored.
 */
export function files_parse_content_type(value: string) {
	if (value.length > FILES_CONTENT_TYPE_MAX_LENGTH) {
		return null;
	}

	const [rawEssence, ...rawParameters] = value.split(";");
	const essence = rawEssence.trim().toLowerCase();
	if (!FILES_CONTENT_TYPE_ESSENCE_REGEX.test(essence)) {
		return null;
	}

	let charset: string | null = null;
	for (const rawParameter of rawParameters) {
		const separatorIndex = rawParameter.indexOf("=");
		if (separatorIndex === -1) {
			return null;
		}
		const name = rawParameter.slice(0, separatorIndex).trim().toLowerCase();
		const parameterValue = rawParameter
			.slice(separatorIndex + 1)
			.trim()
			// A parameter value may be quoted (`charset="utf-8"`). Store it without the quotes.
			.replace(/^"(.*)"$/, "$1")
			.toLowerCase();
		if (!name || !parameterValue) {
			return null;
		}
		if (name === "charset") {
			charset = parameterValue;
		}
	}

	return { essence, charset };
}

/**
 * Normalize a content type before storing it: a supported editable text type becomes its
 * canonical value, any other type keeps its lowercase essence plus the charset parameter when
 * one was given. Return `null` for invalid syntax.
 */
export function files_normalize_content_type(value: string) {
	const parsed = files_parse_content_type(value);
	if (parsed === null) {
		return null;
	}

	const editableTextContentType = FILES_EDITABLE_TEXT_CONTENT_TYPE_BY_ESSENCE.get(parsed.essence);
	if (editableTextContentType !== undefined) {
		return editableTextContentType;
	}

	return parsed.charset === null ? parsed.essence : `${parsed.essence};charset=${parsed.charset}`;
}

/**
 * Return the canonical editable text type for a stored or declared content type, or `null`
 * when that type is not editable text. Only the mapped types are text; other `application/*`
 * types stay stored bytes.
 */
export function files_editable_text_content_type_of(contentType: string | null | undefined) {
	if (contentType == null) {
		return null;
	}

	const parsed = files_parse_content_type(contentType);
	if (parsed === null) {
		return null;
	}
	return FILES_EDITABLE_TEXT_CONTENT_TYPE_BY_ESSENCE.get(parsed.essence) ?? null;
}

/**
 * Return the Yjs document shape a content type gets, or `null` when the type is not editable
 * text. Markdown keeps the rich text editor and its ProseMirror document. Every other editable
 * text type is a plain text document.
 */
export function files_yjs_root_kind_of_content_type(contentType: string | null | undefined): files_YjsRootKind | null {
	return files_editable_text_shape_of(contentType)?.rootKind ?? null;
}

/**
 * The canonical content type and its document shape (root kind) for a content type. `null` when
 * the type is not editable text, so a stored-bytes type can never become a text document.
 */
export function files_editable_text_shape_of(
	contentType: string | null | undefined,
): { contentType: files_ContentType; rootKind: files_YjsRootKind } | null {
	const editableTextContentType = files_editable_text_content_type_of(contentType);
	if (editableTextContentType === null) {
		return null;
	}
	return {
		contentType: editableTextContentType,
		rootKind: editableTextContentType === "text/markdown;charset=utf-8" ? "rich_text" : "plain_text",
	};
}

/**
 * The content type and its document shape (root kind) a new text file gets when the caller named
 * no type: the name's hint, else plain text. Always a text shape, so there is no file name a text
 * write refuses.
 */
export function files_default_text_shape_for_name(fileName: string): {
	contentType: files_ContentType;
	rootKind: files_YjsRootKind;
} {
	const hint = files_guess_content_type_from_name(fileName);
	return {
		contentType: hint ?? "text/plain;charset=utf-8",
		rootKind: hint === "text/markdown;charset=utf-8" ? "rich_text" : "plain_text",
	};
}

/**
 * Return the Monaco language id for a content type. Unmapped types render as plain text.
 */
export function files_monaco_language_id_of_content_type(contentType: string | null | undefined) {
	const editableTextContentType = files_editable_text_content_type_of(contentType);
	if (editableTextContentType === null) {
		return "plaintext";
	}
	return FILES_MONACO_LANGUAGE_ID_BY_CONTENT_TYPE.get(editableTextContentType) ?? "plaintext";
}

/**
 * Guess a content type from a file name. Use it only when a file is created and the caller
 * supplied no type. Return `null` for an unknown or missing extension.
 */
export function files_guess_content_type_from_name(fileName: string) {
	const extension = files_extension_of(fileName);
	if (extension === null) {
		return null;
	}
	return FILES_CONTENT_TYPE_HINT_BY_EXTENSION.get(extension) ?? null;
}

/**
 * The message every write door returns for a content type that does not parse.
 */
export const files_INVALID_CONTENT_TYPE_MESSAGE = "Invalid content type";

/**
 * The type an upload stores. The caller's type wins when it is valid, `application/octet-stream`
 * included. The name is only a hint when the caller sent no type, and a file with neither is
 * stored bytes. Return `null` for a broken type, so the caller refuses instead of guessing.
 */
export function files_resolve_upload_content_type(args: { contentType: string | undefined; fileName: string }) {
	if (args.contentType !== undefined) {
		return files_normalize_content_type(args.contentType);
	}
	return files_guess_content_type_from_name(args.fileName) ?? ("application/octet-stream" satisfies files_ContentType);
}

/**
 * Build a Content-Disposition value with the file name encoded per RFC 5987, so any Unicode
 * name survives the header without breaking it.
 */
function files_content_disposition(kind: "inline" | "attachment", fileName: string) {
	const encoded = encodeURIComponent(fileName).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename*=UTF-8''${encoded}`;
}

/**
 * The response headers every signed R2 download URL must pin, derived from the stored content
 * type. The name only fills the disposition file name. `download` forces media to download too.
 *
 * A presigned R2 GET carries no `nosniff` and no CSP. The signer can set only
 * `responseContentType` and `responseContentDisposition`, so this pinned type plus the
 * disposition is the whole defense against hostile bytes running on the shared R2 origin. Only
 * the literal media set above may serve `inline`. Everything else, editable text, `svg`,
 * `html`, and unknown types, downloads as an attachment. The stored type is client input at
 * upload time, and that is fine here: the inline set holds only types a browser never runs as
 * a page, whatever bytes sit behind them.
 */
export function files_get_signed_download_serving(args: {
	contentType: string | null | undefined;
	fileName: string;
	download?: boolean;
}) {
	const essence = args.contentType == null ? null : (files_parse_content_type(args.contentType)?.essence ?? null);
	if (essence !== null && FILES_INLINE_SERVED_MEDIA_CONTENT_TYPES.has(essence)) {
		return {
			responseContentType: essence,
			responseContentDisposition: files_content_disposition(args.download ? "attachment" : "inline", args.fileName),
		};
	}

	// Editable text keeps its canonical type so a saved download opens in the right app, but it
	// never serves inline: `text/html`-adjacent sniffing is exactly what the attachment blocks.
	const textContentType = files_editable_text_content_type_of(args.contentType);
	return {
		responseContentType: textContentType ?? ("application/octet-stream" satisfies files_ContentType),
		responseContentDisposition: files_content_disposition("attachment", args.fileName),
	};
}
// #endregion content type policy

export function files_get_utf8_byte_size(content: string) {
	return stringByteLength(content);
}

export function files_normalize_lf_newlines(content: string) {
	return content.replace(/\r\n?/g, "\n");
}

/**
 * The one normalization every string→document producer runs at its request boundary, BEFORE any
 * byte count or fan-out: drop one leading U+FEFF (the BOM policy — stored text never begins with
 * a BOM, so Monaco's silent BOM strip cannot make a file dirty-on-open) and normalize CRLF and
 * lone CR to LF. The setter and getter below this line stay byte-transparent and normalize
 * nothing; normalizing only inside the setter would give one file different truths in the
 * document, the R2 snapshot, the chunks, and the stored size.
 */
export function files_normalize_text_document_input(content: string) {
	return files_normalize_lf_newlines(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
}

/**
 * Align proposed content's trailing-newline shape to the baseline so AI edits
 * do not flip the file's trailing-newline style.
 */
export function files_normalize_ai_edit_content(content: string, baselineContent: string) {
	if (content.length === 0) {
		return content;
	}

	const baselineHasTrailingNewline = baselineContent.endsWith("\n");
	const contentHasTrailingNewline = content.endsWith("\n");

	if (baselineHasTrailingNewline && !contentHasTrailingNewline) {
		return `${content}\n`;
	}

	if (!baselineHasTrailingNewline && contentHasTrailingNewline) {
		return content.replace(/\n+$/g, "");
	}

	return content;
}

/**
 * 2 GiB. Raw uploads are stored in R2 as-is with one signed PUT.
 *
 * R2 accepts a single PUT up to 5 GiB, so this cap stays under that limit. The
 * Modal file converter `maxBytes` contract stays at 50 MiB, so consumers that
 * route uploads to the converter must enforce their own smaller cap.
 **/
export const files_MAX_UPLOADS_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How many files one bulk-import mutation or conflict pre-check call accepts.
 * The client chunks to this size and the server rejects bigger calls, so both
 * sides must read the same number.
 */
export const files_IMPORT_MAX_ITEMS_PER_CALL = 50;

/**
 * What `files_nodes.create_upload_node` answers when the target path is taken and the caller
 * asked it to fail instead of replacing.
 *
 * A caller that picks its own name reads this exact message to decide it should try the next
 * name. Any other refusal (no write access to the parent, file too large) is not fixed by
 * renaming, so it must stop instead.
 */
export const files_UPLOAD_PATH_TAKEN_MESSAGE = "This file already exists.";

/**
 * Turning collaboration on refuses when a save changed the content asset while the new Yjs
 * document was uploading. Whole-text saves with collaboration off do not use this check.
 */
export const files_REPLACE_FILE_CONTENT_STALE_MESSAGE =
	"This file changed while you were saving. Copy your local changes before reloading, then try again.";

/**
 * What the pending doors answer when a content proposal on a file with collaboration off is out
 * of date: a member saved the file after the agent made the change. The Pending changes row, the
 * diff view, and the server all show this one sentence, so it lives in one place.
 */
export const files_PENDING_UPDATE_STALE_BASE_MESSAGE =
	"This file changed. Open Review to update the proposal, or discard it.";

export function files_create_tree_items_list_from_nodes(nodes: files_VisibleTreeNode[]) {
	return [files_SYNTHETIC_ROOT_FOLDER, ...nodes];
}

export type files_TreeItem = ReturnType<typeof files_create_tree_items_list_from_nodes>[number];

export function files_is_node(item: files_TreeItem): item is files_VisibleTreeNode {
	return item._id !== files_ROOT_ID;
}

export function files_create_room_id(organizationId: string, workspaceId: string, nodeId: string) {
	return composite_id("rooms", "files_nodes", organizationId, workspaceId, nodeId);
}

/**
 * Return the end index of the file stem. The file name is the full leaf name;
 * the stem is the part before the final extension separator.
 */
export function files_find_file_stem_end_index(args: { fileName: string }) {
	const extensionSeparatorIndex = args.fileName.lastIndexOf(".");
	if (extensionSeparatorIndex > 0) {
		return extensionSeparatorIndex;
	}

	return args.fileName.length;
}

export function files_format_size(size: number | undefined) {
	if (size === undefined) {
		return "Unknown";
	}
	if (size < 1024) {
		return `${size} bytes`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 1,
		style: "unit",
		unit: "megabyte",
		unitDisplay: "short",
	}).format(size / (1024 * 1024));
}

export type files_UploadPipelineState =
	| "not_applicable"
	| "waiting_for_upload"
	| "pending_processing"
	| "processing"
	| "terminal";

type files_UploadPipelineAsset = Pick<app_convex_Doc<"files_r2_assets">, "kind" | "r2Key"> & {
	processingWorkId?: app_convex_Doc<"files_r2_assets">["processingWorkId"] | null;
};

// Use asset conversion state as the pipeline signal; editor availability is a separate Yjs outcome.
export function files_get_upload_pipeline_state(
	asset: files_UploadPipelineAsset | null | undefined,
): files_UploadPipelineState {
	if (!asset) {
		return "not_applicable";
	}
	if (asset.processingWorkId === null) {
		return "terminal";
	}
	if (asset.processingWorkId !== undefined) {
		return "processing";
	}
	if (asset.kind === "upload" && !asset.r2Key) {
		return "waiting_for_upload";
	}

	return asset.kind === "upload" ? "pending_processing" : "not_applicable";
}

type FileNodeFieldsForEditability = Pick<app_convex_Doc<"files_nodes">, "kind" | "assetId" | "textKind">;

/**
 * True when the node is a text file the app can read and write, whether or not it is collaborative.
 *
 * Use this for anything that works on the text: reading the committed chunks, replacing the content,
 * choosing the editor, deciding which renames are legal, indexing frontmatter. Use
 * `files_node_has_editable_yjs_state` instead for anything that touches the Yjs document itself.
 *
 * `textKind` is the marker, not the Yjs pointers. Stored upload blobs and read-only mount files
 * also have an `assetId` but keep `textKind` null, so they stay out.
 */
export function files_node_has_editable_text_content<Node extends FileNodeFieldsForEditability | null | undefined>(
	node: Node,
): node is NonNullable<Node> & {
	kind: "file";
	assetId: NonNullable<FileNodeFieldsForEditability["assetId"]>;
	textKind: NonNullable<FileNodeFieldsForEditability["textKind"]>;
} {
	return node?.kind === "file" && node.assetId !== null && node.textKind !== null;
}

export function files_node_has_editable_yjs_state<
	Node extends
		| (FileNodeFieldsForEditability & Pick<app_convex_Doc<"files_nodes">, "yjsSnapshotId" | "yjsLastSequenceId">)
		| null
		| undefined,
>(
	node: Node,
): node is NonNullable<Node> & {
	kind: "file";
	assetId: NonNullable<FileNodeFieldsForEditability["assetId"]>;
	yjsSnapshotId: app_convex_Id<"files_yjs_snapshots">;
	yjsLastSequenceId: app_convex_Id<"files_yjs_docs_last_sequences">;
	textKind: NonNullable<FileNodeFieldsForEditability["textKind"]>;
} {
	// Treat Yjs pointers as the editor-ready signal instead of inferring readiness from MIME metadata.
	// A non-collaborative file is editable text but has no Yjs document, so it fails this on purpose
	// and every Yjs door refuses it.
	return files_node_has_editable_text_content(node) && node.yjsSnapshotId !== null && node.yjsLastSequenceId !== null;
}

type FilePendingUpdateFieldsForContent = Pick<app_convex_Doc<"files_pending_updates">, "content">;
type FilePendingUpdateContent = NonNullable<FilePendingUpdateFieldsForContent["content"]>;

/**
 * Narrow a pending update doc to a content proposal on a collaborative file (Yjs base).
 * Use `files_pending_update_has_content` when only the three branch ids are needed.
 */
export function files_pending_update_has_yjs_content<Row extends FilePendingUpdateFieldsForContent | null | undefined>(
	row: Row,
): row is NonNullable<Row> & {
	content: FilePendingUpdateContent & { base: Extract<FilePendingUpdateContent["base"], { kind: "yjs" }> };
} {
	return row?.content?.base.kind === "yjs";
}

/**
 * Narrow a pending update doc to branches built from a saved content asset.
 */
export function files_pending_update_has_asset_content<
	Row extends FilePendingUpdateFieldsForContent | null | undefined,
>(
	row: Row,
): row is NonNullable<Row> & {
	content: FilePendingUpdateContent & { base: Extract<FilePendingUpdateContent["base"], { kind: "asset" }> };
} {
	return row?.content?.base.kind === "asset";
}

/**
 * Narrow a pending update doc to its content proposal, including a new private file.
 * The schema keeps its base and all three branch ids together.
 */
export function files_pending_update_has_content<Row extends FilePendingUpdateFieldsForContent | null | undefined>(
	row: Row,
): row is NonNullable<Row> & {
	content: FilePendingUpdateContent;
} {
	return row?.content !== undefined;
}

/**
 * A content proposal on a file with collaboration off is stale when a member saved the file
 * after the proposal was made: the node's content asset is no longer the one the branches were
 * built from. Reads use saved text. Agent writes and Review prepare the retained proposal
 * on the current file. Toggles and restores use the same preparation flow. Discard deletes
 * the content proposal, or keeps only its move or delete.
 */
export function files_pending_update_content_is_stale(
	row: FilePendingUpdateFieldsForContent & Pick<app_convex_Doc<"files_pending_updates">, "contentNeedsRebase">,
	node: Pick<app_convex_Doc<"files_nodes">, "assetId">,
) {
	return (
		row.contentNeedsRebase === true || (row.content?.base.kind === "asset" && row.content.base.assetId !== node.assetId)
	);
}

// #region file name normalization
const FILES_NORMALIZED_DOTTED_NAME_REGEX = /^(?!.*[._-]{2})[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const FILES_DIACRITIC_MARKS_REGEX = /\p{Mark}/gu;
const FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX = /[^a-z0-9_-]+/g;
const FILES_UNSUPPORTED_DOTTED_NAME_CHARACTERS_REGEX = /[^a-z0-9._-]+/g;
const FILES_REPEATED_DASH_REGEX = /-+/g;
const FILES_REPEATED_UNDERSCORE_REGEX = /_+/g;
const FILES_MIXED_SEPARATOR_SEQUENCE_REGEX = /[._-]{2,}/g;
const FILES_EDGE_SEPARATOR_REGEX = /^[._-]+|[._-]+$/g;
const FILES_PATH_SEPARATOR_REGEX = /[\\/]+/g;
const FILES_TRAILING_DOTS_REGEX = /\.+$/g;
const FILES_NAME_INPUT_ALPHANUMERIC_REGEX = /^[a-z0-9]$/;
const FILES_FILE_NAME_INPUT_SEPARATOR_REGEX = /^[/._-]$/;
const FILES_FOLDER_NAME_INPUT_SEPARATOR_REGEX = /^[/._-]$/;
// Keep special Markdown file basenames in their conventional case after the general lowercase normalization.
type files_SpecialFileBaseName = files_SpecialFileName extends `${infer BaseName}.${string}`
	? BaseName
	: files_SpecialFileName;
const FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES = new Set<string>([
	"readme",
	"agents",
	"skill",
] satisfies Lowercase<files_SpecialFileBaseName>[]);

export function files_normalize_name_input(args: {
	kind: app_convex_Doc<"files_nodes">["kind"];
	previousText: string;
	insertedText: string;
	nextText: string;
}) {
	// Normalize the inserted fragment before checking adjacency so pasted text,
	// IME output, and direct keystrokes go through the same draft rules.
	const normalizedInsertedText = args.insertedText
		.normalize("NFKD")
		.replace(FILES_DIACRITIC_MARKS_REGEX, "")
		.toLowerCase();

	// Track the characters around the edit so we can block separator sequences
	// without needing to normalize the full input value on every keystroke.
	let previousCharacter = args.previousText.at(-1) ?? "";
	const nextCharacter = args.nextText.at(0) ?? "";
	let normalizedText = "";

	for (const character of normalizedInsertedText) {
		// Convert each incoming character to the live draft alphabet for the node kind.
		const normalizedCharacter = files_normalize_name_input_character(args.kind, character);
		if (files_is_name_input_separator(args.kind, normalizedCharacter)) {
			// A leading dot stays in the draft so `.agents` can be typed one letter at a time.
			const isLeadingDot = normalizedCharacter === "." && (!previousCharacter || previousCharacter === "/");
			if (!isLeadingDot && (!previousCharacter || files_is_name_input_separator(args.kind, previousCharacter))) {
				continue;
			}
		}

		// Keep accepted characters in order and update adjacency state for the next one.
		normalizedText += normalizedCharacter;
		previousCharacter = normalizedCharacter;
	}

	if (
		normalizedText &&
		files_is_name_input_separator(args.kind, normalizedText.at(-1) ?? "") &&
		files_is_name_input_separator(args.kind, nextCharacter)
	) {
		// Avoid creating a separator pair across the insertion boundary.
		normalizedText = normalizedText.slice(0, -1);
	}

	return normalizedText;
}

export function files_normalize_name(kind: app_convex_Doc<"files_nodes">["kind"], name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result(kind);
	}

	if (kind === "folder") {
		if (name.trim().toLowerCase() === ".agents") {
			return Result({ _yay: ".agents" });
		}
		// Keep already-canonical folder names on a cheap fast path; pasted path-like names take the slower cleanup route.
		if (FILES_NORMALIZED_DOTTED_NAME_REGEX.test(name)) {
			return Result({ _yay: name });
		}

		// Treat dots as regular internal separators for folders, but keep path separators as cleanup input.
		const normalizedName = name
			.normalize("NFKD")
			.replace(FILES_DIACRITIC_MARKS_REGEX, "")
			.toLowerCase()
			.replace(FILES_UNSUPPORTED_DOTTED_NAME_CHARACTERS_REGEX, "-")
			.replace(FILES_REPEATED_DASH_REGEX, "-")
			.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
			.replace(FILES_MIXED_SEPARATOR_SEQUENCE_REGEX, "-")
			.replace(FILES_EDGE_SEPARATOR_REGEX, "");

		return Result({ _yay: normalizedName || "untitled" });
	}

	return files_normalize_markdown_name(name);
}

export function files_normalize_markdown_name(name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result("file");
	}

	const trimmedName = name.trim();
	if (trimmedName === ".") {
		return files_invalid_name_result("file");
	}

	if (trimmedName.endsWith(".")) {
		// Treat a trailing dot as a missing Markdown extension.
		const fileNameParts = files_normalize_file_name_parts({
			fileName: trimmedName.replace(FILES_TRAILING_DOTS_REGEX, ""),
			pathSeparators: "dash",
			fallbackBaseName: "untitled",
		});

		if (!fileNameParts.baseName) {
			return files_invalid_name_result("file");
		}

		return Result({ _yay: files_normalize_special_file_name(`${fileNameParts.baseName}.md`) });
	}

	const fileNameParts = files_normalize_file_name_parts({
		fileName: name,
		pathSeparators: "dash",
		fallbackBaseName: "untitled",
	});
	if (fileNameParts.extension && fileNameParts.extension !== "md") {
		return files_invalid_name_result("file");
	}

	return Result({ _yay: files_normalize_special_file_name(`${fileNameParts.baseName}.md`) });
}

/**
 * File name normalizer for renames and for files the agent creates: clean the characters but
 * keep the typed extension, except bare README becomes README.md. Renames never change the
 * stored content type.
 */
export function files_normalize_file_rename_name(name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result("file");
	}

	const trimmedName = name.trim();
	if (trimmedName === ".") {
		return files_invalid_name_result("file");
	}

	const fileNameParts = files_normalize_file_name_parts({
		fileName: trimmedName.replace(FILES_TRAILING_DOTS_REGEX, ""),
		pathSeparators: "dash",
		fallbackBaseName: "untitled",
	});
	return Result({
		_yay: files_normalize_special_file_name(
			fileNameParts.extension ? `${fileNameParts.baseName}.${fileNameParts.extension}` : fileNameParts.baseName,
		),
	});
}

// Normalize browser File.name for an app node while preserving non-Markdown extensions.
export function files_normalize_upload_file_name(fileName: string) {
	const fileNameParts = files_normalize_file_name_parts({
		fileName,
		pathSeparators: "leaf",
		fallbackBaseName: "upload",
	});
	return files_normalize_special_file_name(
		fileNameParts.extension ? `${fileNameParts.baseName}.${fileNameParts.extension}` : fileNameParts.baseName,
	);
}

/**
 * Apply conventional spelling and the bare README extension. Other names keep strict validation.
 */
export function files_normalize_special_node_path(kind: "file" | "folder", path: string) {
	// Keep empty segments and escaped slashes so this never repairs an invalid path.
	const segments = path.split(/(?<!\\)\//);
	return segments
		.map((segment, index) =>
			kind === "file" && index === segments.length - 1
				? files_normalize_special_file_name(segment)
				: segment.toLowerCase() === ".agents"
					? ".agents"
					: segment,
		)
		.join("/");
}

// TODO: decide a maximum name length and enforce it here. Nothing limits a name today, not this
// normalizer, not the schema, and not any door, so a paste can store a name of any length. Keep-both
// makes it grow: every retry appends `-copy-N` to a name that is already too long. Investigate what
// the limit should be before choosing one. 255 bytes matches most filesystems and survives an export
// to disk, while 255 characters is easier to explain but lets a CJK name reach about 765 bytes. The
// truncation also has to keep the extension and the `-copy-N` suffix, or two different sources would
// cut down to the same name.
function files_normalize_file_name_parts(args: {
	fileName: string;
	pathSeparators: "dash" | "leaf";
	fallbackBaseName: string;
}) {
	const name =
		args.pathSeparators === "leaf"
			? (args.fileName.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? args.fallbackBaseName)
			: args.fileName;
	const normalizedName = name
		.normalize("NFKD")
		.replace(FILES_DIACRITIC_MARKS_REGEX, "")
		.toLowerCase()
		.trim()
		.replace(FILES_PATH_SEPARATOR_REGEX, args.pathSeparators === "dash" ? "-" : "/");
	const parts = normalizedName.split(".").map(files_normalize_file_name_part);

	if (parts.length === 0) {
		return { baseName: args.fallbackBaseName, extension: null };
	}
	if (parts.length === 1) {
		return { baseName: parts[0] || args.fallbackBaseName, extension: null };
	}

	const extension = parts.at(-1) || null;
	const baseName = parts.slice(0, -1).filter(Boolean).join(".") || args.fallbackBaseName;
	if (!extension) {
		return { baseName, extension: null };
	}

	return {
		baseName,
		extension,
	};
}

function files_normalize_file_name_part(part: string) {
	return part
		.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
		.replace(FILES_REPEATED_DASH_REGEX, "-")
		.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
		.replace(FILES_MIXED_SEPARATOR_SEQUENCE_REGEX, "-")
		.replace(FILES_EDGE_SEPARATOR_REGEX, "");
}

export function files_get_normalized_node_path_segments(args: {
	kind: app_convex_Doc<"files_nodes">["kind"] | null;
	nameOrPath: string;
	/**
	 * How a file leaf's extension is handled. The default keeps the Markdown-only UI rule for
	 * the sidebar's "New Markdown file" flow. With "keep_extension", renames
	 * and agent-created files keep the typed extension, except bare README becomes README.md.
	 * Renames never change the stored content type. Folder segments ignore this.
	 */
	fileNamePolicy?: "markdown" | "keep_extension";
}) {
	if (!args.kind) {
		return null;
	}

	const trimmedNameOrPath = args.nameOrPath.trim();
	if (!trimmedNameOrPath) {
		return null;
	}

	const pathSegments = path_extract_segments_from(trimmedNameOrPath);
	if (pathSegments.length === 0) {
		return null;
	}

	const normalizedPathSegments: string[] = [];
	for (const [index, pathSegment] of pathSegments.entries()) {
		const isLeaf = index === pathSegments.length - 1;
		const pathSegmentKind = isLeaf ? args.kind : "folder";
		const normalizedName =
			pathSegmentKind === "file" && args.fileNamePolicy === "keep_extension"
				? files_normalize_file_rename_name(pathSegment)
				: files_normalize_name(pathSegmentKind, pathSegment);
		if (normalizedName._nay) {
			return { validationMessage: normalizedName._nay.message };
		}

		normalizedPathSegments.push(normalizedName._yay);
	}

	return { normalizedPathSegments };
}

function files_invalid_name_result(kind: app_convex_Doc<"files_nodes">["kind"]) {
	// Keep the visible message kind-specific while preserving the shared Result shape.
	return Result({
		_nay: {
			name: "nay",
			message: kind === "folder" ? "Invalid folder name" : "Invalid file name",
		},
	});
}

function files_normalize_name_input_character(kind: app_convex_Doc<"files_nodes">["kind"], character: string) {
	if (FILES_NAME_INPUT_ALPHANUMERIC_REGEX.test(character)) {
		// Accept lowercase ASCII letters and digits as valid draft characters.
		return character;
	}

	if (character === "/" || character === "\\") {
		// Keep path separators in create/rename drafts so the submit path can create missing folders.
		return "/";
	}

	if (character === ".") {
		// Allow dots as ordinary filename and folder-name separators.
		return character;
	}

	if (character === "-" || character === "_") {
		// Keep supported separators and let the caller handle adjacency rules.
		return character;
	}

	// Unsupported characters become dashes so live typing can recover when possible.
	return "-";
}

function files_is_name_input_separator(kind: app_convex_Doc<"files_nodes">["kind"], character: string) {
	// Treat dots as regular separators for both files and folders.
	return kind === "file"
		? FILES_FILE_NAME_INPUT_SEPARATOR_REGEX.test(character)
		: FILES_FOLDER_NAME_INPUT_SEPARATOR_REGEX.test(character);
}

function files_normalize_special_file_name(name: string) {
	const extensionSeparatorIndex = name.lastIndexOf(".");
	const baseName = (extensionSeparatorIndex === -1 ? name : name.slice(0, extensionSeparatorIndex)).toLowerCase();
	// Give bare README the .md extension at new file destinations.
	if (baseName === "readme" && extensionSeparatorIndex === -1) return "README.md";
	if (!FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES.has(baseName)) {
		return name;
	}

	// Preserve the normalized extension and uppercase only the special basename.
	const extension = extensionSeparatorIndex === -1 ? "" : name.slice(extensionSeparatorIndex).toLowerCase();
	return `${baseName.toUpperCase()}${extension}`;
}
// #endregion file name normalization

/**
 * Convert a Uint8Array to an ArrayBuffer.
 */
export function files_u8_to_array_buffer(u8: Uint8Array) {
	// Zero-copy if view covers entire buffer
	if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
		return u8.buffer as ArrayBuffer;
	}
	// Copy only if partial view (handles both cases safely)
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Compare two Uint8Arrays for byte-level equality.
 */
export function files_u8_equals(a: Uint8Array, b: Uint8Array) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

const files_yjs_encoded_empty_diff_update = new Uint8Array([0, 0]);

/**
 * Returns whether a Yjs diff update encodes no content changes.
 *
 * Yjs may encode an empty diff as either an empty update (`byteLength === 0`)
 * or the canonical 2-byte marker `[0, 0]`.
 *
 * @param diffUpdate - Diff update bytes produced by Yjs.
 *
 * @returns `true` when the update does not contain operations.
 */
export function files_yjs_doc_is_diff_update_empty(diffUpdate: Uint8Array) {
	return diffUpdate.byteLength === 0 || files_u8_equals(diffUpdate, files_yjs_encoded_empty_diff_update);
}

export const files_tiptap_empty_doc_json = ((/* iife */) => {
	function value(): TiptapJSONContent {
		return { type: "doc", content: [{ type: "paragraph" }] };
	}

	let cache: ReturnType<typeof value>;

	return function files_tiptap_empty_doc_json() {
		return (cache ??= value());
	};
})();
