// Lean, cross-runtime file helpers: constants, name/path normalization, byte helpers, and the
// pending path overlay. Keep this module free of heavy runtime imports (@tiptap/* runtime, yjs,
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

export type files_VisibleTreeNode = Omit<
	app_convex_Doc<"files_nodes">,
	"organizationId" | "workspaceId" | "createdBy" | "updatedBy"
> & {
	organizationId: app_convex_Id<"organizations">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
	createdBy: app_convex_Id<"users">;
	updatedBy: app_convex_Id<"users">;
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
	contentType: undefined,
	statsId: undefined,
	assetId: undefined,
	archiveOperationId: undefined,
	yjsLastSequenceId: undefined,
	yjsSnapshotId: undefined,
	parentId: "",
	updatedBy: "",
	createdBy: "",
	updatedAt: 0,
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

export const files_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "markdown",
};

export const files_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.`;

export type files_ContentType =
	| `text/${"markdown" | "plain"}${"" | `;charset=${"utf-8"}`}`
	| "application/octet-stream";

export type files_SpecialFileName = "README.md";

export type files_InlineAiModelId = "gpt-5-mini";

export const files_MAX_TEXT_CONTENT_BYTES = 900_000;

export function files_get_utf8_byte_size(content: string) {
	return stringByteLength(content);
}

export function files_normalize_lf_newlines(content: string) {
	return content.replace(/\r\n?/g, "\n");
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
 * 50 MiB.
 *
 * Keep this aligned with the Modal file converter `maxBytes` contract.
 **/
export const files_MAX_UPLOADS_BYTES = 50 * 1024 * 1024;

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

type FileNodeFieldsForEditability = Pick<
	app_convex_Doc<"files_nodes">,
	"kind" | "assetId" | "yjsSnapshotId" | "yjsLastSequenceId"
>;

export function files_node_has_editable_yjs_state<Node extends FileNodeFieldsForEditability | null | undefined>(
	node: Node,
): node is NonNullable<Node> & {
	kind: "file";
	assetId: NonNullable<FileNodeFieldsForEditability["assetId"]>;
	yjsSnapshotId: NonNullable<FileNodeFieldsForEditability["yjsSnapshotId"]>;
	yjsLastSequenceId: NonNullable<FileNodeFieldsForEditability["yjsLastSequenceId"]>;
} {
	// Treat Yjs pointers as the editor-ready signal instead of inferring readiness from MIME metadata.
	return (
		node?.kind === "file" &&
		node.assetId !== undefined &&
		node.yjsSnapshotId !== undefined &&
		node.yjsLastSequenceId !== undefined
	);
}

type FilePendingUpdateFieldsForYjsContent = Pick<
	app_convex_Doc<"files_pending_updates">,
	"baseYjsSequence" | "baseYjsUpdate" | "stagedBranchYjsUpdate" | "unstagedBranchYjsUpdate"
>;

/**
 * Narrow a pending update doc to a content-bearing one. Move-only docs
 * leave all 4 Yjs fields unset; the 4 fields are set together or not at all.
 */
export function files_pending_update_has_yjs_content<
	Row extends FilePendingUpdateFieldsForYjsContent | null | undefined,
>(
	row: Row,
): row is NonNullable<Row> & {
	baseYjsSequence: NonNullable<FilePendingUpdateFieldsForYjsContent["baseYjsSequence"]>;
	baseYjsUpdate: NonNullable<FilePendingUpdateFieldsForYjsContent["baseYjsUpdate"]>;
	stagedBranchYjsUpdate: NonNullable<FilePendingUpdateFieldsForYjsContent["stagedBranchYjsUpdate"]>;
	unstagedBranchYjsUpdate: NonNullable<FilePendingUpdateFieldsForYjsContent["unstagedBranchYjsUpdate"]>;
} {
	return (
		row != null &&
		row.baseYjsSequence !== undefined &&
		row.baseYjsUpdate !== undefined &&
		row.stagedBranchYjsUpdate !== undefined &&
		row.unstagedBranchYjsUpdate !== undefined
	);
}

// #region pending path overlay
// The proposing user's pending `mv` / `mv -f` proposals re-shape the tree that user sees:
// moved nodes appear at their destination path, vacated and replaced paths read as gone.
// Other users keep seeing the committed tree. Callers (bash fs, convex path queries) fetch
// the user's pending update docs plus the few referenced nodes, build one overlay per
// command run, and route every path decision through these pure functions.
//
// Sealed rules (see the tests in files.test.ts):
// - A pending update doc is inert when the node it moves, its destination parent, or a
//   replace-copy source is missing from `nodesById`; the overlay simply drops it on the next
//   build. A missing `replacesNodeId` node only degrades the replace to a plain move,
//   matching what accept does.
// - Visible destination paths resolve through moved ancestors (including committed subfolders of
//   a moved folder); parent cycles drop all cycling docs, other docs keep applying.
// - Two docs that claim the same visible destination path are all dropped (no guessing a winner;
//   proposal-time validation prevents this state).
// - A replaced target that has its own pending move follows its move instead of being hidden.
// - At one path, a redirect wins over the vacated-source hiding (chains and swaps work).
// - A pending move claims its destination path. A committed node that appears there later is
//   shadowed for the proposer: lookups redirect, listings hide it. Accept auto-replaces it like
//   `mv -f` (file onto file; the pending panel shows a live "Replaces" indicator before accept).
// - A pending delete (`rm`) hides its node; a deleted folder hides its whole committed subtree.
//   A deeper pending move wins over the delete-hiding (a subtree moved out of a deleted folder
//   stays visible at its destination), while a delete deeper inside a moved folder still hides
//   that area — the deepest structural claim over a path decides.

export type files_PendingPathOverlayRow = Pick<
	app_convex_Doc<"files_pending_updates">,
	"fileNodeId" | "pendingMove" | "copiedFrom" | "pendingArchive"
>;

export type files_PendingPathOverlayNode = Pick<app_convex_Doc<"files_nodes">, "_id" | "path" | "kind">;

export type files_PendingPathOverlay = {
	/** One entry per applied move doc; `visiblePath` already resolves through moved ancestors. */
	moves: Array<{
		nodeId: app_convex_Doc<"files_nodes">["_id"];
		kind: app_convex_Doc<"files_nodes">["kind"];
		committedPath: string;
		visiblePath: string;
	}>;
	/** Nodes that disappear from the visible tree: replaced targets, replace-move sources, and pending deletes. */
	hiddenNodeIds: Set<string>;
	hiddenCommittedPaths: Set<string>;
	/** Committed folder paths with a pending delete: their whole subtree reads as gone. */
	hiddenCommittedFolderPaths: Set<string>;
};

/**
 * Build the overlay from the user's pending update docs.
 *
 * `nodesById` must contain the nodes the docs reference: each move doc's `fileNodeId` and
 * `destParentId` node, each `pendingMove.replacesNodeId` node, each
 * `copiedFrom.nodeId` node of a replace-move (`archivesSourceOnAccept`), and each
 * `pendingArchive` doc's `fileNodeId` node. A doc with a
 * missing moved node, destination parent, replace-copy source, or deleted node is inert;
 * a missing `replacesNodeId` node only degrades the replace to a plain move (accept does
 * the same). Content-only docs and plain copies never affect paths.
 */
export function files_pending_path_overlay_build(args: {
	pendingUpdates: readonly files_PendingPathOverlayRow[];
	nodesById: ReadonlyMap<string, files_PendingPathOverlayNode>;
}): files_PendingPathOverlay {
	const { pendingUpdates, nodesById } = args;

	type CandidateMove = {
		nodeId: app_convex_Doc<"files_nodes">["_id"];
		kind: app_convex_Doc<"files_nodes">["kind"];
		committedPath: string;
		destParentId: NonNullable<files_PendingPathOverlayRow["pendingMove"]>["destParentId"];
		destName: string;
		replacesNodeId: app_convex_Doc<"files_nodes">["_id"] | undefined;
	};

	// Collect the move docs whose moved node and destination parent both exist.
	// A missing replace target is fine here: the replace degrades to a plain move.
	const candidateMoves: CandidateMove[] = [];
	const candidateMoveByNodeId = new Map<string, CandidateMove>();
	for (const row of pendingUpdates) {
		const pendingMove = row.pendingMove;
		// A pending delete supersedes a pending move (the upsert clears it; skip defensively).
		if (!pendingMove || row.pendingArchive) {
			continue;
		}
		const node = nodesById.get(row.fileNodeId);
		if (!node) {
			continue;
		}
		if (pendingMove.destParentId !== files_ROOT_ID && !nodesById.has(pendingMove.destParentId)) {
			continue;
		}
		const candidate: CandidateMove = {
			nodeId: node._id,
			kind: node.kind,
			committedPath: node.path,
			destParentId: pendingMove.destParentId,
			destName: pendingMove.destName,
			replacesNodeId: pendingMove.replacesNodeId,
		};
		candidateMoves.push(candidate);
		candidateMoveByNodeId.set(node._id, candidate);
	}

	// Resolve each move's visible destination path through moved ancestors.
	// Re-entering a move that is still resolving means a destination-parent cycle:
	// that branch resolves to null, so every move on the cycle is dropped.
	const resolvingMoves = new Set<CandidateMove>();
	const visiblePathByMove = new Map<CandidateMove, string | null>();

	function resolve_move_visible_path(move: CandidateMove): string | null {
		if (resolvingMoves.has(move)) {
			return null;
		}
		const known = visiblePathByMove.get(move);
		if (known !== undefined) {
			return known;
		}

		resolvingMoves.add(move);
		let parentVisiblePath: string | null;
		if (move.destParentId === files_ROOT_ID) {
			parentVisiblePath = "";
		} else {
			const parentMove = candidateMoveByNodeId.get(move.destParentId);
			if (parentMove) {
				parentVisiblePath = resolve_move_visible_path(parentMove);
			} else {
				const parentNode = nodesById.get(move.destParentId);
				parentVisiblePath = parentNode ? resolve_committed_dir_visible_path(parentNode.path) : null;
			}
		}
		resolvingMoves.delete(move);

		const visiblePath = parentVisiblePath == null ? null : `${parentVisiblePath}/${move.destName}`;
		visiblePathByMove.set(move, visiblePath);
		return visiblePath;
	}

	// A committed folder with no move doc of its own can still sit inside a moved
	// folder (destination parents resolved by id). Project its path through the
	// deepest moved ancestor so nested destinations land under the visible tree.
	function resolve_committed_dir_visible_path(committedDirPath: string): string | null {
		let deepestAncestor: CandidateMove | null = null;
		for (const move of candidateMoves) {
			if (move.kind !== "folder") {
				continue;
			}
			if (move.committedPath !== committedDirPath && !committedDirPath.startsWith(`${move.committedPath}/`)) {
				continue;
			}
			if (!deepestAncestor || move.committedPath.length > deepestAncestor.committedPath.length) {
				deepestAncestor = move;
			}
		}
		if (!deepestAncestor) {
			return committedDirPath;
		}

		const ancestorVisiblePath = resolve_move_visible_path(deepestAncestor);
		if (ancestorVisiblePath == null) {
			return null;
		}
		return `${ancestorVisiblePath}${committedDirPath.slice(deepestAncestor.committedPath.length)}`;
	}

	// Two docs must not claim one visible path: drop all colliding docs instead of
	// guessing a winner (proposal-time validation prevents this state).
	const claimsByVisiblePath = new Map<string, CandidateMove[]>();
	for (const move of candidateMoves) {
		const visiblePath = resolve_move_visible_path(move);
		if (visiblePath == null) {
			continue;
		}
		const claims = claimsByVisiblePath.get(visiblePath) ?? [];
		claims.push(move);
		claimsByVisiblePath.set(visiblePath, claims);
	}
	const appliedMoves: Array<{ candidate: CandidateMove; visiblePath: string }> = [];
	for (const [visiblePath, claims] of claimsByVisiblePath) {
		if (claims.length !== 1) {
			continue;
		}
		appliedMoves.push({ candidate: claims[0], visiblePath });
	}

	const moves: files_PendingPathOverlay["moves"] = appliedMoves.map(({ candidate, visiblePath }) => ({
		nodeId: candidate.nodeId,
		kind: candidate.kind,
		committedPath: candidate.committedPath,
		visiblePath,
	}));
	const appliedMoveNodeIds = new Set<string>(moves.map((move) => move.nodeId));

	const hiddenNodeIds = new Set<string>();
	const hiddenCommittedPaths = new Set<string>();
	// Replace targets leave the visible tree, unless the target follows its own
	// pending move (then both docs apply; see the sealed rules above).
	for (const { candidate } of appliedMoves) {
		if (!candidate.replacesNodeId) {
			continue;
		}
		const target = nodesById.get(candidate.replacesNodeId);
		if (!target || appliedMoveNodeIds.has(target._id)) {
			continue;
		}
		hiddenNodeIds.add(target._id);
		hiddenCommittedPaths.add(target.path);
	}
	// Replace-move copies (`mv -f` between editable files) hide their source.
	for (const row of pendingUpdates) {
		if (!row.copiedFrom?.archivesSourceOnAccept) {
			continue;
		}
		const source = nodesById.get(row.copiedFrom.nodeId);
		if (!source) {
			continue;
		}
		hiddenNodeIds.add(source._id);
		hiddenCommittedPaths.add(source.path);
	}
	// Pending deletes (`rm`) hide their node; a deleted folder hides its whole subtree.
	const hiddenCommittedFolderPaths = new Set<string>();
	for (const row of pendingUpdates) {
		if (!row.pendingArchive) {
			continue;
		}
		const node = nodesById.get(row.fileNodeId);
		if (!node) {
			continue;
		}
		hiddenNodeIds.add(node._id);
		hiddenCommittedPaths.add(node.path);
		if (node.kind === "folder") {
			hiddenCommittedFolderPaths.add(node.path);
		}
	}

	return { moves, hiddenNodeIds, hiddenCommittedPaths, hiddenCommittedFolderPaths };
}

/**
 * Answer "what does the user see at this visible path?" for lookups (cat, stat, exists).
 *
 * - `redirected`: a pending move presents the node stored at `committedPath` here.
 *   For paths inside a moved folder, `committedPath` is the source-prefix translation.
 * - `hidden`: the committed node at this path moved away or is replaced away.
 * - `unchanged`: the overlay does not touch this path.
 */
export function files_pending_path_overlay_translate_path(
	overlay: files_PendingPathOverlay,
	visiblePath: string,
): { kind: "unchanged" } | { kind: "hidden" } | { kind: "redirected"; committedPath: string } {
	// A redirect wins over the vacated-source hiding of the same path (chains, swaps).
	for (const move of overlay.moves) {
		if (move.visiblePath === visiblePath) {
			return { kind: "redirected", committedPath: move.committedPath };
		}
	}
	// Paths inside a moved folder's claimed area translate back to the committed source;
	// the deepest claiming folder wins so nested folder moves resolve correctly.
	let deepestFolderRedirect: files_PendingPathOverlay["moves"][number] | null = null;
	for (const move of overlay.moves) {
		if (move.kind !== "folder" || !visiblePath.startsWith(`${move.visiblePath}/`)) {
			continue;
		}
		if (!deepestFolderRedirect || move.visiblePath.length > deepestFolderRedirect.visiblePath.length) {
			deepestFolderRedirect = move;
		}
	}
	if (deepestFolderRedirect) {
		const committedPath = `${deepestFolderRedirect.committedPath}${visiblePath.slice(deepestFolderRedirect.visiblePath.length)}`;
		// The committed node at the translated path can have its own move (a rename inside the
		// moved folder): the redirect only holds when it projects back onto this path.
		if (files_pending_path_overlay_project_committed_path(overlay, committedPath) !== visiblePath) {
			return { kind: "hidden" };
		}
		return { kind: "redirected", committedPath };
	}

	// Vacated sources (and their descendants) and replaced/copy-archived/deleted nodes read as gone.
	if (overlay.hiddenCommittedPaths.has(visiblePath)) {
		return { kind: "hidden" };
	}
	for (const folderPath of overlay.hiddenCommittedFolderPaths) {
		if (visiblePath.startsWith(`${folderPath}/`)) {
			return { kind: "hidden" };
		}
	}
	for (const move of overlay.moves) {
		if (move.committedPath === visiblePath) {
			return { kind: "hidden" };
		}
		if (move.kind === "folder" && visiblePath.startsWith(`${move.committedPath}/`)) {
			return { kind: "hidden" };
		}
	}

	return { kind: "unchanged" };
}

/**
 * Answer "where does this committed node appear in the visible tree?" for listings.
 *
 * Returns the visible path (destination path for moved nodes and their descendants,
 * the same path when untouched) or `null` when the node is hidden from the visible tree.
 * A node's own move doc wins over an ancestor folder's prefix projection. A committed path
 * that sits at or under a move's visible destination is shadowed (`null`): the pending
 * move claims that path, and accept will auto-replace whatever committed node sits there.
 */
export function files_pending_path_overlay_project_committed_path(
	overlay: files_PendingPathOverlay,
	committedPath: string,
): string | null {
	// Replaced targets, copy-archived sources, and deleted nodes leave the visible tree entirely.
	if (overlay.hiddenCommittedPaths.has(committedPath)) {
		return null;
	}

	// The node's own move doc wins over an ancestor folder's prefix projection.
	for (const move of overlay.moves) {
		if (move.committedPath === committedPath) {
			return move.visiblePath;
		}
	}
	let deepestAncestor: files_PendingPathOverlay["moves"][number] | null = null;
	for (const move of overlay.moves) {
		if (move.kind !== "folder" || !committedPath.startsWith(`${move.committedPath}/`)) {
			continue;
		}
		if (!deepestAncestor || move.committedPath.length > deepestAncestor.committedPath.length) {
			deepestAncestor = move;
		}
	}
	// The deepest structural claim wins: a deleted ancestor folder hides the path unless a
	// deeper moved ancestor lifts it out of the deleted area (redirect wins over hiding).
	let deepestDeletedFolderPath: string | null = null;
	for (const folderPath of overlay.hiddenCommittedFolderPaths) {
		if (!committedPath.startsWith(`${folderPath}/`)) {
			continue;
		}
		if (deepestDeletedFolderPath == null || folderPath.length > deepestDeletedFolderPath.length) {
			deepestDeletedFolderPath = folderPath;
		}
	}
	if (
		deepestDeletedFolderPath != null &&
		(!deepestAncestor || deepestDeletedFolderPath.length > deepestAncestor.committedPath.length)
	) {
		return null;
	}
	if (deepestAncestor) {
		const rewrittenPath = `${deepestAncestor.visiblePath}${committedPath.slice(deepestAncestor.committedPath.length)}`;
		// Another move can claim the projected path exactly (a node moved onto a vacated
		// visible path inside the moved folder): that claim shadows the committed child.
		// Only exact claims apply here — the producing ancestor's own visible path prefixes
		// every projected child, so the folder prefix-shadow rule would hide the whole subtree.
		for (const move of overlay.moves) {
			if (move.visiblePath === rewrittenPath) {
				return null;
			}
		}
		return rewrittenPath;
	}

	// A committed path at or under a claimed destination is shadowed: the pending
	// move owns that path, and accept will auto-replace whatever sits there.
	for (const move of overlay.moves) {
		if (move.visiblePath === committedPath) {
			return null;
		}
		if (move.kind === "folder" && committedPath.startsWith(`${move.visiblePath}/`)) {
			return null;
		}
	}

	return committedPath;
}

/**
 * Decide which entry a lookup at `requestedPath` should present when both a committed
 * occupant and a redirect can claim the path. `occupantNodeId` is the id of the committed
 * node found at the path, or `null` when nothing committed lives there.
 *
 * - `redirected`: a pending move claims this path; fetch the node at the redirect's
 *   `committedPath` and present it here, even over a committed occupant (accept will
 *   auto-replace the occupant like `mv -f`).
 * - `occupant`: no redirect claims the path and the committed node is live (not moved
 *   away, not hidden). A node created at a vacated path after the proposal stays visible.
 * - `none`: the path reads as missing.
 */
export function files_pending_path_overlay_pick_visible_entry(
	overlay: files_PendingPathOverlay,
	args: { requestedPath: string; occupantNodeId: string | null },
): "occupant" | "redirected" | "none" {
	const translated = files_pending_path_overlay_translate_path(overlay, args.requestedPath);
	if (translated.kind === "redirected") {
		return "redirected";
	}
	if (args.occupantNodeId == null) {
		return "none";
	}

	// A hidden or moved-away occupant reads as missing; any other committed node is
	// live and stays visible (for example one created at a vacated path later).
	if (overlay.hiddenNodeIds.has(args.occupantNodeId)) {
		return "none";
	}
	for (const move of overlay.moves) {
		if (move.nodeId === args.occupantNodeId) {
			return "none";
		}
	}

	return "occupant";
}

/**
 * List the moved nodes that a listing of `visibleFolderPath` must add as direct children.
 *
 * Skips moves already covered by projecting that folder's own committed children (in-place
 * renames, and moves whose committed parent folder projects onto this same visible folder),
 * so callers never show one node twice.
 */
export function files_pending_path_overlay_list_injections(
	overlay: files_PendingPathOverlay,
	visibleFolderPath: string,
): Array<{
	nodeId: app_convex_Doc<"files_nodes">["_id"];
	kind: app_convex_Doc<"files_nodes">["kind"];
	committedPath: string;
	visibleName: string;
}> {
	const injections: ReturnType<typeof files_pending_path_overlay_list_injections> = [];
	for (const move of overlay.moves) {
		const visibleDirPath = move.visiblePath.slice(0, move.visiblePath.lastIndexOf("/")) || "/";
		if (visibleDirPath !== visibleFolderPath) {
			continue;
		}

		// Skip moves this folder's own committed children already surface via projection
		// (in-place renames, and renames inside a moved folder), so nothing shows twice.
		const committedDirPath = move.committedPath.slice(0, move.committedPath.lastIndexOf("/")) || "/";
		if (files_pending_path_overlay_project_committed_path(overlay, committedDirPath) === visibleFolderPath) {
			continue;
		}

		injections.push({
			nodeId: move.nodeId,
			kind: move.kind,
			committedPath: move.committedPath,
			visibleName: move.visiblePath.slice(move.visiblePath.lastIndexOf("/") + 1),
		});
	}
	return injections;
}
// #endregion pending path overlay

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
const FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES = new Set(["readme" satisfies Lowercase<files_SpecialFileBaseName>]);

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
			// Skip leading separators and adjacent separator pairs while typing.
			if (!previousCharacter || files_is_name_input_separator(args.kind, previousCharacter)) {
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

		return Result({ _yay: files_apply_special_file_name_case(`${fileNameParts.baseName}.md`) });
	}

	const fileNameParts = files_normalize_file_name_parts({
		fileName: name,
		pathSeparators: "dash",
		fallbackBaseName: "untitled",
	});
	if (fileNameParts.extension && fileNameParts.extension !== "md") {
		return files_invalid_name_result("file");
	}

	return Result({ _yay: files_apply_special_file_name_case(`${fileNameParts.baseName}.md`) });
}

// Normalize browser File.name for an app node while preserving non-Markdown extensions.
export function files_normalize_upload_file_name(fileName: string) {
	const fileNameParts = files_normalize_file_name_parts({
		fileName,
		pathSeparators: "leaf",
		fallbackBaseName: "upload",
	});
	return fileNameParts.extension ? `${fileNameParts.baseName}.${fileNameParts.extension}` : fileNameParts.baseName;
}

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
		const normalizedName = files_normalize_name(pathSegmentKind, pathSegment);
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

function files_apply_special_file_name_case(name: string) {
	// Compare only the basename so the extension policy stays independent of special casing.
	const extensionSeparatorIndex = name.lastIndexOf(".");
	const baseName = extensionSeparatorIndex === -1 ? name : name.slice(0, extensionSeparatorIndex);
	if (!FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES.has(baseName)) {
		return name;
	}

	// Preserve the normalized extension and uppercase only the special basename.
	const extension = extensionSeparatorIndex === -1 ? "" : name.slice(extensionSeparatorIndex);
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
