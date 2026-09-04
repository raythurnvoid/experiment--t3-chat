import {
	files_is_node,
	files_find_file_stem_end_index,
	files_get_normalized_node_path_segments,
	files_MAX_YJS_WIRE_BYTES,
	files_u8_to_array_buffer,
	type files_TreeItem,
	type files_VisibleTreeNode,
	type files_YjsRootKind,
} from "../../shared/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../../shared/files-yjs.ts";
import {
	files_headless_tiptap_editor_create,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../../shared/files-tiptap.ts";
import { files_get_thread_ids_from_editor_state } from "../../shared/files-tiptap-comments.ts";
import { composite_key } from "../../shared/shared-utils.ts";
import { delay } from "../../shared/async-utils.ts";
import type { Doc } from "../../convex/_generated/dataModel";
import { TypedEventTarget } from "@remix-run/interaction";
import { should_never_happen, XCustomEvent } from "./utils.ts";
import type { usePresenceList, usePresenceSessions, usePresenceSessionsData } from "../hooks/presence-hooks.ts";
import { objects_equal_deep } from "./object.ts";
import { editor as monaco_editor } from "monaco-editor";
import { app_convex, type app_convex_Doc, type app_convex_Id, app_convex_api } from "@/lib/app-convex-client.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { applyUpdate, Doc as YDoc } from "yjs";

export * from "../../shared/files.ts";

export const files_editor_view_values = ["rich_text_editor", "plain_text_editor", "diff_editor"] as const;

export type files_EditorView = (typeof files_editor_view_values)[number];

/**
 * Clamp a requested editor view to what the node's document shape supports. A plain text
 * document has no rich editor: mounting Tiptap on a `Y.Text` root would show an empty editor
 * and write keystrokes into a second root nobody reads. The plain (Monaco) and diff views are
 * valid for both shapes, so only the rich view is redirected.
 *
 * The document shape is the only clamp. A file with collaboration turned off supports every
 * view its shape supports: the rich and diff editors for such a file are backed by the stored
 * string instead of a Yjs document.
 */
export function files_resolve_effective_editor_view(args: {
	requestedView: files_EditorView;
	rootKind: files_YjsRootKind;
}): files_EditorView {
	if (args.rootKind === "plain_text" && args.requestedView === "rich_text_editor") {
		return "plain_text_editor";
	}
	return args.requestedView;
}

export const files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE = "application/x-bonobo-senate-press-file-node-id";

export function files_download_blob(args: { blob: Blob; filename: string }) {
	const objectUrl = URL.createObjectURL(args.blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = args.filename;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => {
		URL.revokeObjectURL(objectUrl);
	}, 0);
}

/**
 * Return `new-file.md` or `new-folder` for the requested kind, adding an
 * incrementing suffix when one of the provided sibling names already uses it.
 */
export function files_get_default_node_name(args: {
	kind: Doc<"files_nodes">["kind"];
	siblingNames: Iterable<string>;
}) {
	const activeSiblingNames = new Set([...args.siblingNames].map((name) => name.trim().toLowerCase()));
	const baseName = args.kind === "folder" ? "new-folder" : "new-file";
	const extension = args.kind === "file" ? ".md" : "";
	const initialName = `${baseName}${extension}`;

	if (!activeSiblingNames.has(initialName.toLowerCase())) {
		return initialName;
	}

	let counter = 1;
	for (;;) {
		const candidateName = `${baseName}-${counter}${extension}`;
		if (!activeSiblingNames.has(candidateName.toLowerCase())) {
			return candidateName;
		}

		counter += 1;
	}
}

/**
 * Select the basename of the current input value, keeping the extension outside the
 * selection so typing replaces only the basename and preserves the file type.
 */
export function files_name_input_select_stem(args: { element: HTMLInputElement; kind: files_TreeItem["kind"] }) {
	const selectionEnd =
		args.kind === "file" ? files_find_file_stem_end_index({ fileName: args.element.value }) : args.element.value.length;
	if (selectionEnd > 0 && selectionEnd < args.element.value.length) {
		args.element.setSelectionRange(0, selectionEnd);
		return;
	}

	args.element.select();
}

// #region node path validation
const cachedNodePathValidationMessages = new Map<string, string>();

/**
 * Build the cache key for path validation failures.
 * Cache duplicate-name errors so repeat submissions for paths we already know
 * exist can fail immediately without sending another create or rename mutation.
 */
export function files_get_node_path_validation_cache_key(args: {
	scopeId: string;
	nodeIdToIgnore?: Doc<"files_nodes">["_id"];
	parentId: Doc<"files_nodes">["parentId"];
	kind: Doc<"files_nodes">["kind"] | null;
	nameOrPath: string;
	fileNamePolicy?: "markdown" | "editable_text" | "keep_extension";
}) {
	const normalizedPath = files_get_normalized_node_path_segments({
		kind: args.kind,
		nameOrPath: args.nameOrPath,
		fileNamePolicy: args.fileNamePolicy,
	});
	if (!args.kind || !normalizedPath || "validationMessage" in normalizedPath) {
		return null;
	}

	return composite_key(
		"node_path_validation_cache_key",
		args.scopeId,
		args.parentId,
		args.kind,
		normalizedPath.normalizedPathSegments.map((pathSegment) => pathSegment.toLowerCase()).join("/"),
		...(args.nodeIdToIgnore ? [args.nodeIdToIgnore] : []),
	);
}

export function files_get_node_path_cached_validation_message(args: { cacheKey: string }) {
	return cachedNodePathValidationMessages.get(args.cacheKey) ?? null;
}

export function files_set_node_path_cached_validation_message(args: { cacheKey: string; message: string }) {
	cachedNodePathValidationMessages.set(args.cacheKey, args.message);
}

export function files_clear_node_path_cached_validation_messages() {
	cachedNodePathValidationMessages.clear();
}

export function files_get_node_path_validation(args: {
	scopeId: string;
	fileNodesList: files_TreeItem[] | undefined;
	nodeIdToIgnore?: Doc<"files_nodes">["_id"];
	parentId: Doc<"files_nodes">["parentId"];
	kind: Doc<"files_nodes">["kind"] | null;
	nameOrPath: string;
	fileNamePolicy?: "markdown" | "editable_text" | "keep_extension";
}) {
	const validationMessage = files_get_node_path_validation_message({
		fileNodesList: args.fileNodesList,
		nodeIdToIgnore: args.nodeIdToIgnore,
		parentId: args.parentId,
		kind: args.kind,
		nameOrPathValidate: args.nameOrPath,
		fileNamePolicy: args.fileNamePolicy,
	});
	const validationCacheKey = files_get_node_path_validation_cache_key({
		scopeId: args.scopeId,
		nodeIdToIgnore: args.nodeIdToIgnore,
		parentId: args.parentId,
		kind: args.kind,
		nameOrPath: args.nameOrPath,
		fileNamePolicy: args.fileNamePolicy,
	});
	const cachedValidationMessage = validationCacheKey
		? files_get_node_path_cached_validation_message({ cacheKey: validationCacheKey })
		: null;
	const effectiveValidationMessage = validationMessage ?? cachedValidationMessage;

	const cacheValidationMessage = (message = effectiveValidationMessage) => {
		if (!validationCacheKey || !message) {
			return;
		}

		files_set_node_path_cached_validation_message({
			cacheKey: validationCacheKey,
			message,
		});
	};

	return {
		cacheValidationMessage,
		validationCacheKey,
		validationMessage: effectiveValidationMessage,
	};
}

/**
 * Validate a node name or slash-separated path and return the user-facing error.
 * Use `fileNodesList` to detect duplicate leaves in the current folder, including
 * paths that traverse existing intermediate folders.
 */
export function files_get_node_path_validation_message(args: {
	fileNodesList: files_TreeItem[] | undefined;
	nodeIdToIgnore?: Doc<"files_nodes">["_id"];
	parentId: Doc<"files_nodes">["parentId"];
	kind: Doc<"files_nodes">["kind"] | null;
	nameOrPathValidate: string;
	fileNamePolicy?: "markdown" | "editable_text" | "keep_extension";
}) {
	// First validate and canonicalize the user input without consulting the tree.
	const normalizedPath = files_get_normalized_node_path_segments({
		kind: args.kind,
		nameOrPath: args.nameOrPathValidate,
		fileNamePolicy: args.fileNamePolicy,
	});
	if (!normalizedPath) {
		return null;
	}
	if ("validationMessage" in normalizedPath) {
		return normalizedPath.validationMessage;
	}
	if (!args.kind || !args.fileNodesList) {
		return null;
	}

	// Then walk the current tree to catch duplicates, following existing folders for deep paths.
	let currentParentId = args.parentId;
	for (const [index, normalizedName] of normalizedPath.normalizedPathSegments.entries()) {
		const isLeaf = index === normalizedPath.normalizedPathSegments.length - 1;
		const existingNode = args.fileNodesList.find((item): item is files_VisibleTreeNode => {
			return (
				files_is_node(item) &&
				item._id !== args.nodeIdToIgnore &&
				item.parentId === currentParentId &&
				item.archiveOperationId === undefined &&
				item.name.trim().toLowerCase() === normalizedName.toLowerCase()
			);
		});
		if (isLeaf) {
			return existingNode ? (args.kind === "file" ? "This file already exists." : "This folder already exists.") : null;
		}

		if (!existingNode || existingNode.kind !== "folder") {
			return null;
		}

		currentParentId = existingNode._id;
	}

	return null;
}
// #endregion node path validation

export function files_yjs_rebase_branch_with_local_text(args: {
	previousBaseYjsDoc: YDoc;
	nextBaseYjsDoc: YDoc;
	previousBranchYjsDoc: YDoc;
	localText: string;
	rootKind: files_YjsRootKind;
}) {
	const previousBaseText = files_yjs_doc_get_text({
		yjsDoc: args.previousBaseYjsDoc,
		rootKind: args.rootKind,
	});
	if (previousBaseText._nay) {
		return previousBaseText;
	}

	const previousBranchText = files_yjs_doc_get_text({
		yjsDoc: args.previousBranchYjsDoc,
		rootKind: args.rootKind,
	});
	if (previousBranchText._nay) {
		return previousBranchText;
	}

	const nextBaseText = files_yjs_doc_get_text({
		yjsDoc: args.nextBaseYjsDoc,
		rootKind: args.rootKind,
	});
	if (nextBaseText._nay) {
		return nextBaseText;
	}

	if (args.localText === nextBaseText._yay) {
		return Result({
			_yay: {
				rebasedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextBaseYjsDoc }),
				rebasedBranchText: nextBaseText._yay,
			},
		});
	}

	const rebasedStoredBranchYjsDoc =
		previousBranchText._yay === previousBaseText._yay
			? files_yjs_doc_clone({ yjsDoc: args.nextBaseYjsDoc })
			: ((/* iife */) => {
					const rebasedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: args.previousBranchYjsDoc });
					const remoteDiffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
						yjsDoc: args.nextBaseYjsDoc,
						yjsBeforeDoc: args.previousBaseYjsDoc,
					});
					if (remoteDiffUpdate) {
						applyUpdate(rebasedBranchYjsDoc, remoteDiffUpdate);
					}
					return rebasedBranchYjsDoc;
				})();

	const rebasedStoredBranchText = files_yjs_doc_get_text({
		yjsDoc: rebasedStoredBranchYjsDoc,
		rootKind: args.rootKind,
	});
	if (rebasedStoredBranchText._nay) {
		return rebasedStoredBranchText;
	}

	if (args.localText === previousBranchText._yay) {
		return Result({
			_yay: {
				rebasedBranchYjsDoc: rebasedStoredBranchYjsDoc,
				rebasedBranchText: rebasedStoredBranchText._yay,
			},
		});
	}

	const rebasedLocalBranchResult = files_yjs_reconcile_branch_with_local_text({
		previousRemoteYjsDoc: args.previousBranchYjsDoc,
		nextRemoteYjsDoc: rebasedStoredBranchYjsDoc,
		localText: args.localText,
		rootKind: args.rootKind,
	});
	if (rebasedLocalBranchResult._nay) {
		return rebasedLocalBranchResult;
	}

	return Result({
		_yay: {
			rebasedBranchYjsDoc: rebasedLocalBranchResult._yay.mergedYjsDoc,
			rebasedBranchText: rebasedLocalBranchResult._yay.mergedText,
		},
	});
}

export function files_yjs_reconcile_branch_with_local_text(args: {
	previousRemoteYjsDoc: YDoc;
	nextRemoteYjsDoc: YDoc;
	localText: string;
	rootKind: files_YjsRootKind;
}) {
	const workspaceedLocalYjsDoc = files_yjs_doc_clone({ yjsDoc: args.previousRemoteYjsDoc });

	// A state-vector diff against the previous remote doc would also carry that doc's full
	// historical delete set, not only the edits made here. The next remote doc can be a sibling
	// that never had those deletions (a content discard clones the staged branch into the
	// unstaged branch), so replaying them would delete live content in the merged doc. Capture
	// the updates the local projection emits instead: they hold exactly the local edits.
	const localEditUpdates: Uint8Array[] = [];
	const captureLocalEditUpdate = (update: Uint8Array) => {
		localEditUpdates.push(update);
	};
	workspaceedLocalYjsDoc.on("update", captureLocalEditUpdate);
	const workspaceedLocalBranchResult = files_yjs_doc_update_from_text({
		mut_yjsDoc: workspaceedLocalYjsDoc,
		text: args.localText,
		rootKind: args.rootKind,
	});
	workspaceedLocalYjsDoc.off("update", captureLocalEditUpdate);
	if (workspaceedLocalBranchResult._nay) {
		return workspaceedLocalBranchResult;
	}

	const workspaceedLocalText = files_yjs_doc_get_text({
		yjsDoc: workspaceedLocalYjsDoc,
		rootKind: args.rootKind,
	});
	if (workspaceedLocalText._nay) {
		return workspaceedLocalText;
	}

	const nextRemoteText = files_yjs_doc_get_text({
		yjsDoc: args.nextRemoteYjsDoc,
		rootKind: args.rootKind,
	});
	if (nextRemoteText._nay) {
		return nextRemoteText;
	}

	if (workspaceedLocalText._yay === nextRemoteText._yay) {
		return Result({
			_yay: {
				mergedYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc }),
				mergedText: nextRemoteText._yay,
			},
		});
	}

	// No captured updates means the local text was already the previous remote content, so
	// the next remote branch replaces the pane as-is.
	if (localEditUpdates.length === 0) {
		return Result({
			_yay: {
				mergedYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc }),
				mergedText: nextRemoteText._yay,
			},
		});
	}

	const mergedYjsDoc = files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc });
	for (const localEditUpdate of localEditUpdates) {
		applyUpdate(mergedYjsDoc, localEditUpdate);
	}

	// A captured local edit can anchor to structs that only ever existed in the previous branch.
	// A sibling branch never had those structs, so Yjs parks the edit as pending instead of
	// integrating it, and the user's typing would silently disappear from the pane. Keep the
	// local projection in that case: the pane keeps what the user sees, and the normal draft
	// sync proposes it again on top of the new branch.
	if (mergedYjsDoc.store.pendingStructs !== null || mergedYjsDoc.store.pendingDs !== null) {
		return Result({
			_yay: {
				mergedYjsDoc: workspaceedLocalYjsDoc,
				mergedText: workspaceedLocalText._yay,
			},
		});
	}

	const mergedText = files_yjs_doc_get_text({
		yjsDoc: mergedYjsDoc,
		rootKind: args.rootKind,
	});
	if (mergedText._nay) {
		return mergedText;
	}

	return Result({
		_yay: {
			mergedYjsDoc,
			mergedText: mergedText._yay,
		},
	});
}

/**
 * Reassemble one of the caller's own pending-update Yjs states from its pages. One page per
 * query call is the server contract (a page may itself be 930,000 bytes), so this loops the
 * page index until the recorded page count and concatenates locally.
 */
export async function files_fetch_file_pending_update_yjs_state(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
	stateId: app_convex_Id<"files_pending_update_yjs_states">;
}) {
	const pages: ArrayBuffer[] = [];
	let pageIndex = 0;
	let pageCount = 1;
	let totalBytes = 0;
	while (pageIndex < pageCount) {
		const page = await app_convex.query(app_convex_api.files_pending_updates.get_file_pending_update_state_page, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			stateId: args.stateId,
			pageIndex,
		});
		if (page === null) {
			return Result({ _nay: { name: "nay", message: "Failed to load a pending update state page" } });
		}
		pages.push(page.bytes);
		pageCount = page.pageCount;
		totalBytes = page.totalBytes;
		pageIndex += 1;
	}

	const whole = new Uint8Array(totalBytes);
	let offset = 0;
	for (const page of pages) {
		if (offset + page.byteLength > totalBytes) {
			return Result({ _nay: { name: "nay", message: "Pending update state pages exceed the recorded size" } });
		}
		whole.set(new Uint8Array(page), offset);
		offset += page.byteLength;
	}
	if (offset !== totalBytes) {
		return Result({ _nay: { name: "nay", message: "Pending update state pages did not match the recorded size" } });
	}

	return Result({ _yay: files_u8_to_array_buffer(whole) });
}

/**
 * The client upsert flow: one operation batch, one bounded text per staging call, then the
 * finishing action that carries only ids. A staging refusal already retired the batch
 * server-side, so refusals return directly.
 */
export async function files_upsert_file_pending_update(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	/**
	 * The `updatedAt` of the proposal version the user reviewed. The server refuses when the
	 * proposal was revised after that read; pass it from review flows (the sidebar Accept).
	 */
	reviewedUpdatedAt?: number;
	stagedText?: string;
	unstagedText: string;
}) {
	const batch = await app_convex.mutation(app_convex_api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: args.membershipId,
		nodeId: args.nodeId,
	});
	if (batch._nay) {
		return batch;
	}
	const operationBatchId = batch._yay.operationBatchId;

	if (args.stagedText !== undefined) {
		const staged = await app_convex.mutation(app_convex_api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: args.membershipId,
			operationBatchId,
			role: "staged",
			text: args.stagedText,
		});
		if (staged._nay) {
			return staged;
		}
	}
	const unstaged = await app_convex.mutation(app_convex_api.files_pending_updates.stage_file_pending_update_text_input, {
		membershipId: args.membershipId,
		operationBatchId,
		role: "unstaged",
		text: args.unstagedText,
	});
	if (unstaged._nay) {
		return unstaged;
	}

	return await app_convex.action(app_convex_api.files_pending_updates.upsert_file_pending_update, {
		membershipId: args.membershipId,
		nodeId: args.nodeId,
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.reviewedUpdatedAt !== undefined ? { reviewedUpdatedAt: args.reviewedUpdatedAt } : {}),
	});
}

/**
 * The client rebase flow: stage the three full branch states as pages under one operation batch,
 * seal each role (the seal runs door 2 server-side), then run the finishing action that carries
 * only ids. A refusal at any staging step already retired the batch server-side.
 */
export async function files_persist_file_pending_update_rebased_state(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	baseYjsSequence: number;
	baseYjsUpdate: ArrayBuffer;
	stagedBranchYjsUpdate: ArrayBuffer;
	unstagedBranchYjsUpdate: ArrayBuffer;
}) {
	const batch = await app_convex.mutation(app_convex_api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: args.membershipId,
		nodeId: args.nodeId,
	});
	if (batch._nay) {
		return batch;
	}
	const operationBatchId = batch._yay.operationBatchId;

	const inputs = [
		{ role: "base" as const, update: args.baseYjsUpdate },
		{ role: "staged" as const, update: args.stagedBranchYjsUpdate },
		{ role: "unstaged" as const, update: args.unstagedBranchYjsUpdate },
	];
	for (const input of inputs) {
		const bytes = new Uint8Array(input.update);
		for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
			const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
			const staged = await app_convex.mutation(app_convex_api.files_pending_updates.stage_file_pending_update_state_page, {
				membershipId: args.membershipId,
				operationBatchId,
				role: input.role,
				pageIndex,
				bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
			});
			if (staged._nay) {
				return staged;
			}
		}

		const sealed = await app_convex.mutation(app_convex_api.files_pending_updates.seal_file_pending_update_state, {
			membershipId: args.membershipId,
			operationBatchId,
			role: input.role,
			expectedTotalBytes: input.update.byteLength,
		});
		if (sealed._nay) {
			return sealed;
		}
	}

	return await app_convex.action(app_convex_api.files_pending_updates.persist_file_pending_update_rebased_state, {
		membershipId: args.membershipId,
		nodeId: args.nodeId,
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		baseYjsSequence: args.baseYjsSequence,
	});
}

/**
 * Read a collaborative file once and return its text together with the Yjs document it came from.
 *
 * The plain text editor, the diff editor, and the pending sidebar use this instead of a live
 * provider. The result names the exact document (`yjsLastSequenceId`), so a later save can be
 * refused when the file was rebuilt as a different document in the meantime.
 */
export async function files_fetch_file_yjs_state_and_text(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
}) {
	// The snapshot, the updates, and the sequence doc come from three separate reads. If someone
	// turns collaboration off and on between them, they describe two different documents. Read
	// all three again until they agree. Three tries cover one toggle landing in the middle.
	for (let attempt = 0; attempt < 3; attempt++) {
		const [yjsSnapshotTarget, yjsUpdatesData, yjsLastSequenceDoc] = await Promise.all([
			app_convex.action(app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot, args),
			app_convex.query(app_convex_api.files_nodes.yjs_get_incremental_updates, args),
			app_convex.query(app_convex_api.files_nodes.get_file_last_yjs_sequence, args),
		]);

		if (yjsSnapshotTarget == null) return null;

		// All three reads must name the same document. Otherwise updates from one document would
		// be applied on top of a snapshot from another.
		if (
			yjsUpdatesData?.yjsLastSequenceId !== yjsSnapshotTarget.yjsLastSequenceId ||
			yjsLastSequenceDoc?.yjsLastSequenceId !== yjsSnapshotTarget.yjsLastSequenceId
		) {
			await delay(250);
			continue;
		}

		const yjsSnapshotUpdate = await fetch(yjsSnapshotTarget.snapshotUrl).then((response) => {
			if (!response.ok) {
				throw new Error("Failed to fetch Yjs snapshot from R2");
			}

			return response.arrayBuffer();
		});
		const yjsSnapshotDoc = yjsSnapshotTarget.snapshot;

		// By default the API returns updates in descending order; normalize to ascending and filter
		// to only include updates that are after the snapshot.
		const filteredIncrementalUpdates = yjsUpdatesData.updates
			.filter((u: app_convex_Doc<"files_yjs_updates">) => u.sequence > yjsSnapshotDoc.sequence)
			.reverse();

		const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
			additionalIncrementalArrayBufferUpdates: filteredIncrementalUpdates.map(
				(u: app_convex_Doc<"files_yjs_updates">) => u.update,
			),
		});
		// The shape comes from the server call that already loaded the node: there is no node doc on
		// the client, and the snapshot response's `yjsRootKind` is the resolved required union.
		const yjsRootKind = yjsSnapshotTarget.yjsRootKind;
		const text = files_yjs_doc_get_text({ yjsDoc, rootKind: yjsRootKind });

		return {
			text,
			yjsDoc,
			yjsSequence: yjsLastSequenceDoc.lastSequence,
			yjsRootKind,
			yjsLastSequenceId: yjsSnapshotTarget.yjsLastSequenceId,
		};
	}

	// Three reads in a row disagreed. Give up and let the caller show its own error.
	throw new Error("The file collaboration state kept changing while it loaded");
}

/**
 * Read the comment thread ids out of a Markdown string, sorted.
 *
 * The three text editors call this after every load and save to keep their comments sidebar in
 * step with the text. Returns `null` when there is nothing to read: comment marks only exist in a
 * rich-text document, and a plain-text file's sidebar stays empty, so the headless Tiptap parse is
 * skipped there. It also returns `null` when the Markdown cannot be parsed, and the caller keeps
 * the ids it already had.
 */
export function files_get_comment_thread_ids_from_markdown(markdown: string, rootKind: files_YjsRootKind) {
	if (rootKind !== "rich_text") {
		return null;
	}

	const headlessEditor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
	if (headlessEditor._nay) {
		console.error("[files_get_comment_thread_ids_from_markdown] Error while creating headless editor", {
			nay: headlessEditor._nay,
		});
		return null;
	}

	const threadIds = files_get_thread_ids_from_editor_state(headlessEditor._yay.state).toSorted();
	headlessEditor._yay.destroy();
	return threadIds;
}

// #region presence store
export class files_PresenceStore_Event extends XCustomEvent<{
	connected: { userId: string; sessionId: string };
	disconnected: { userId: string; sessionId: string };
	data_changed: {
		userId: string;
		sessionId: string;
		userData: files_PresenceStore_UserData;
		sessionData: files_PresenceStore_SessionData;
	};
}> {}

type files_PresenceStore_Data = {
	sessionToken: string;
	sessions: NonNullable<ReturnType<typeof usePresenceSessions>>;
	sessionsData: NonNullable<ReturnType<typeof usePresenceSessionsData>>;
	usersAnagraphics: NonNullable<ReturnType<typeof usePresenceList>>["usersAnagraphics"];
};

type files_PresenceStore_SessionData = {
	yjs_data?: {
		user: { name: string | null; color: string | null };
		cursor?: unknown;
		[key: string]: unknown;
	} | null;
	yjs_clientId?: number;
	color: string;
};

type files_PresenceStore_UserData = {
	displayName: string;
};

export class files_PresenceStore extends TypedEventTarget<files_PresenceStore_Event["__map"]> {
	sessionIdUserIdMap = new Map<string, string>();
	sessionIds = new Set<string>();
	sessionsData = new Map<string, files_PresenceStore_SessionData>();
	usersData = new Map<string, files_PresenceStore_UserData>();
	localSessionId: string;
	localSessionToken: string;

	private disposed = false;

	private onSetSessionData: typeof this.setSessionData;

	constructor(args: {
		data: files_PresenceStore_Data;
		localSessionId: string;
		onSetSessionData: (data: files_PresenceStore_SessionData) => void;
	}) {
		super();
		this.localSessionId = args.localSessionId;
		this.localSessionToken = args.data.sessionToken;
		this.onSetSessionData = args.onSetSessionData;

		for (const session of args.data.sessions) {
			this.sessionIdUserIdMap.set(session.sessionId, session.userId);
			this.sessionIds.add(session.sessionId);

			this.usersData.set(session.userId, {
				displayName: args.data.usersAnagraphics[session.userId].displayName,
			});

			this.sessionsData.set(session.sessionId, {
				color: args.data.sessionsData[session.sessionId]?.color,
				yjs_data: args.data.sessionsData[session.sessionId]?.yjs_data,
				yjs_clientId: args.data.sessionsData[session.sessionId]?.yjs_clientId,
			});
		}

		if (!args.data.sessions.some((session) => session.sessionId === args.localSessionId)) {
			// TODO: remove this if we do not catch it for a long time
			should_never_happen("[files_PresenceStore.constructor] localSessionId is not in sessions");
		}
	}

	sync(newData: files_PresenceStore_Data) {
		if (this.disposed) return;

		for (const newSession of newData.sessions) {
			let isNewSession = false;

			if (this.sessionIds.has(newSession.sessionId) === false) {
				isNewSession = true;
				this.sessionIdUserIdMap.set(newSession.sessionId, newSession.userId);
				this.sessionIds.add(newSession.sessionId);
				this.dispatchEvent(
					new files_PresenceStore_Event("connected", {
						detail: { userId: newSession.userId, sessionId: newSession.sessionId },
					}),
				);
			}

			const setData = () => {
				this.localSessionToken = newData.sessionToken;
				this.sessionsData.set(newSession.sessionId, {
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				});
				this.usersData.set(newSession.userId, {
					displayName: newData.usersAnagraphics[newSession.userId].displayName,
				});
			};

			if (isNewSession) {
				setData();
			} else {
				const oldSessionData = this.sessionsData.get(newSession.sessionId);
				const oldUserData = this.usersData.get(newSession.userId);

				if (!oldSessionData || !oldUserData)
					throw should_never_happen("[files_PresenceStore.sync] old data missing", {
						localSessionId: this.localSessionId,
						localSessionToken: this.localSessionToken,
						newSession,
						oldSessionData,
						oldUserData,
					});

				const newSessionData = {
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				};

				const newUserData = {
					displayName: newData.usersAnagraphics[newSession.userId].displayName,
				};

				if (
					objects_equal_deep(oldSessionData, newSessionData) === false ||
					objects_equal_deep(oldUserData, newUserData) === false
				) {
					setData();
					this.dispatchEvent(
						new files_PresenceStore_Event("data_changed", {
							detail: {
								userId: newSession.userId,
								sessionId: newSession.sessionId,
								sessionData: newSessionData,
								userData: newUserData,
							} as files_PresenceStore_Event["__map"]["data_changed"]["detail"],
						}),
					);
				}
			}
		}

		const disconnectedSessions = this.sessionIds.difference(
			new Set(newData.sessions.map((session) => session.sessionId)),
		);

		for (const disconnectedSessionId of disconnectedSessions) {
			const userId = this.sessionIdUserIdMap.get(disconnectedSessionId);
			if (!userId) throw should_never_happen("[files_PresenceStore.sync] userId is undefined");

			this.sessionIds.delete(disconnectedSessionId);
			this.sessionsData.delete(disconnectedSessionId);
			this.sessionIdUserIdMap.delete(disconnectedSessionId);
			this.dispatchEvent(
				new files_PresenceStore_Event("disconnected", { detail: { userId, sessionId: disconnectedSessionId } }),
			);
		}
	}

	setSessionData(data: Partial<files_PresenceStore_SessionData>) {
		const currentPresenceData = this.sessionsData.get(this.localSessionId);
		if (!currentPresenceData) {
			if (this.disposed) return;
			throw should_never_happen("[files_PresenceStore.setSessionData] currentPresenceData is undefined");
		}

		const newValue = { ...currentPresenceData, ...data };
		this.sessionsData.set(this.localSessionId, newValue);

		if (this.disposed) return;

		this.onSetSessionData(newValue);
	}

	getPresenceData() {
		const userId = this.sessionIdUserIdMap.get(this.localSessionId);
		if (!userId) return null;
		const userData = this.usersData.get(userId);
		if (!userData) return null;
		const sessionData = this.sessionsData.get(this.localSessionId);
		if (!sessionData) return null;

		return {
			userId,
			sessionId: this.localSessionId,
			userData,
			sessionData,
		};
	}

	dispose() {
		this.disposed = true;
	}
}
// #endregion PresenceStore

// #region monaco
export function files_monaco_create_editor_model(text: string, languageId: string) {
	const model = monaco_editor.createModel(text, languageId);
	// Keep this pin: Monaco is a second normalizer. Without it a CRLF string reaching a mounted
	// model would flip the whole buffer's line endings and mark the file dirty with no user edit.
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}

/**
 * Apply a programmatic edit through the editor so undo/redo behaves like normal typing.
 * Monaco refuses editor-level `executeEdits` while the editor is read-only, which happens when
 * the user loses write permission while a sync or snapshot restore is running. Without a
 * fallback the model would silently keep stale content while the flow advances its baselines.
 * A model-level edit is still allowed then, and it still fires one model change event.
 */
export function files_monaco_execute_edits_with_read_only_fallback(args: {
	editor: Pick<monaco_editor.ICodeEditor, "pushUndoStop" | "executeEdits">;
	model: Pick<monaco_editor.ITextModel, "pushStackElement" | "applyEdits">;
	edits: monaco_editor.IIdentifiedSingleEditOperation[];
}) {
	args.editor.pushUndoStop();
	const applied = args.editor.executeEdits("app_files_sync", args.edits);
	args.editor.pushUndoStop();

	if (!applied) {
		args.model.pushStackElement();
		args.model.applyEdits(args.edits);
		args.model.pushStackElement();
	}
}
// #endregion monaco
