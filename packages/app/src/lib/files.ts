import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_CREATE_NODE_VALIDATION_MESSAGES,
	files_is_node,
	files_get_normalized_node_path_segments,
	type files_TreeItem,
} from "../../shared/files.ts";
import { composite_key } from "../../shared/shared-utils.ts";
import type { Doc } from "../../convex/_generated/dataModel";
import { TypedEventTarget } from "@remix-run/interaction";
import { should_never_happen, XCustomEvent } from "./utils.ts";
import type { usePresenceList, usePresenceSessions, usePresenceSessionsData } from "../hooks/presence-hooks.ts";
import { objects_equal_deep } from "./object.ts";
import { editor as monaco_editor } from "monaco-editor";
import { app_convex, type app_convex_Doc, type app_convex_Id, app_convex_api } from "@/lib/app-convex-client.ts";
import { Result } from "./errors-as-values-utils.ts";
import { applyUpdate, Doc as YDoc } from "yjs";

export * from "../../shared/files.ts";

export const files_editor_view_values = ["rich_text_editor", "plain_text_editor", "diff_editor"] as const;

export type files_EditorView = (typeof files_editor_view_values)[number];

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

// #region node path validation
const cachedNodePathValidationMessages = new Map<string, string>();

function get_node_kind_conflict_message(args: { kind: Doc<"files_nodes">["kind"] }) {
	return args.kind === "file"
		? files_CREATE_NODE_VALIDATION_MESSAGES.fileAlreadyExists
		: files_CREATE_NODE_VALIDATION_MESSAGES.folderAlreadyExists;
}

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
}) {
	const normalizedPath = files_get_normalized_node_path_segments({ kind: args.kind, nameOrPath: args.nameOrPath });
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
}) {
	const validationMessage = files_get_node_path_validation_message({
		fileNodesList: args.fileNodesList,
		nodeIdToIgnore: args.nodeIdToIgnore,
		parentId: args.parentId,
		kind: args.kind,
		nameOrPathValidate: args.nameOrPath,
	});
	const validationCacheKey = files_get_node_path_validation_cache_key({
		scopeId: args.scopeId,
		nodeIdToIgnore: args.nodeIdToIgnore,
		parentId: args.parentId,
		kind: args.kind,
		nameOrPath: args.nameOrPath,
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
}) {
	// First validate and canonicalize the user input without consulting the tree.
	const normalizedPath = files_get_normalized_node_path_segments({
		kind: args.kind,
		nameOrPath: args.nameOrPathValidate,
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
		const existingNode = args.fileNodesList.find((item): item is app_convex_Doc<"files_nodes"> => {
			return (
				files_is_node(item) &&
				item._id !== args.nodeIdToIgnore &&
				item.parentId === currentParentId &&
				item.archiveOperationId === undefined &&
				item.name.trim().toLowerCase() === normalizedName.toLowerCase()
			);
		});
		if (isLeaf) {
			return existingNode ? get_node_kind_conflict_message({ kind: args.kind }) : null;
		}

		if (!existingNode || existingNode.kind !== "folder") {
			return null;
		}

		currentParentId = existingNode._id;
	}

	return null;
}
// #endregion node path validation

export function files_yjs_rebase_branch_with_local_markdown(args: {
	previousBaseYjsDoc: YDoc;
	nextBaseYjsDoc: YDoc;
	previousBranchYjsDoc: YDoc;
	localMarkdown: string;
}) {
	const previousBaseMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.previousBaseYjsDoc,
	});
	if (previousBaseMarkdown._nay) {
		return previousBaseMarkdown;
	}

	const previousBranchMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.previousBranchYjsDoc,
	});
	if (previousBranchMarkdown._nay) {
		return previousBranchMarkdown;
	}

	const nextBaseMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.nextBaseYjsDoc,
	});
	if (nextBaseMarkdown._nay) {
		return nextBaseMarkdown;
	}

	if (args.localMarkdown === nextBaseMarkdown._yay) {
		return Result({
			_yay: {
				rebasedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextBaseYjsDoc }),
				rebasedBranchMarkdown: nextBaseMarkdown._yay,
			},
		});
	}

	const rebasedStoredBranchYjsDoc =
		previousBranchMarkdown._yay === previousBaseMarkdown._yay
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

	const rebasedStoredBranchMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: rebasedStoredBranchYjsDoc,
	});
	if (rebasedStoredBranchMarkdown._nay) {
		return rebasedStoredBranchMarkdown;
	}

	if (args.localMarkdown === previousBranchMarkdown._yay) {
		return Result({
			_yay: {
				rebasedBranchYjsDoc: rebasedStoredBranchYjsDoc,
				rebasedBranchMarkdown: rebasedStoredBranchMarkdown._yay,
			},
		});
	}

	const rebasedLocalBranchResult = files_yjs_reconcile_branch_with_local_markdown({
		previousRemoteYjsDoc: args.previousBranchYjsDoc,
		nextRemoteYjsDoc: rebasedStoredBranchYjsDoc,
		localMarkdown: args.localMarkdown,
	});
	if (rebasedLocalBranchResult._nay) {
		return rebasedLocalBranchResult;
	}

	return Result({
		_yay: {
			rebasedBranchYjsDoc: rebasedLocalBranchResult._yay.mergedYjsDoc,
			rebasedBranchMarkdown: rebasedLocalBranchResult._yay.mergedMarkdown,
		},
	});
}

export function files_yjs_reconcile_branch_with_local_markdown(args: {
	previousRemoteYjsDoc: YDoc;
	nextRemoteYjsDoc: YDoc;
	localMarkdown: string;
}) {
	const projectedLocalYjsDoc = files_yjs_doc_clone({ yjsDoc: args.previousRemoteYjsDoc });
	const projectedLocalBranchResult = files_yjs_doc_update_from_markdown({
		mut_yjsDoc: projectedLocalYjsDoc,
		markdown: args.localMarkdown,
	});
	if (projectedLocalBranchResult._nay) {
		return projectedLocalBranchResult;
	}

	const projectedLocalMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: projectedLocalYjsDoc,
	});
	if (projectedLocalMarkdown._nay) {
		return projectedLocalMarkdown;
	}

	const nextRemoteMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.nextRemoteYjsDoc,
	});
	if (nextRemoteMarkdown._nay) {
		return nextRemoteMarkdown;
	}

	if (projectedLocalMarkdown._yay === nextRemoteMarkdown._yay) {
		return Result({
			_yay: {
				mergedYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc }),
				mergedMarkdown: nextRemoteMarkdown._yay,
			},
		});
	}

	const localDiffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
		yjsDoc: projectedLocalYjsDoc,
		yjsBeforeDoc: args.previousRemoteYjsDoc,
	});
	if (!localDiffUpdate) {
		return Result({
			_yay: {
				mergedYjsDoc: files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc }),
				mergedMarkdown: nextRemoteMarkdown._yay,
			},
		});
	}

	const mergedYjsDoc = files_yjs_doc_clone({ yjsDoc: args.nextRemoteYjsDoc });
	applyUpdate(mergedYjsDoc, localDiffUpdate);

	const mergedMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: mergedYjsDoc,
	});
	if (mergedMarkdown._nay) {
		return mergedMarkdown;
	}

	return Result({
		_yay: {
			mergedYjsDoc,
			mergedMarkdown: mergedMarkdown._yay,
		},
	});
}

export async function files_fetch_file_yjs_state_and_markdown(args: {
	membershipId: app_convex_Id<"workspaces_projects_users">;
	nodeId: app_convex_Id<"files_nodes">;
}) {
	const [yjsSnapshotTarget, yjsUpdatesDocs, yjsLastSequenceDoc] = await Promise.all([
		app_convex.action(app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot, args),
		app_convex
			.query(app_convex_api.files_nodes.yjs_get_incremental_updates, args)
			.then((updatesData) => updatesData?.updates ?? []),
		app_convex.query(app_convex_api.files_nodes.get_file_last_yjs_sequence, args),
	]);

	if (yjsSnapshotTarget == null) return null;

	const yjsSnapshotUpdate = await fetch(yjsSnapshotTarget.snapshotUrl).then((response) => {
		if (!response.ok) {
			throw new Error("Failed to fetch Yjs snapshot from R2");
		}

		return response.arrayBuffer();
	});
	const yjsSnapshotDoc = yjsSnapshotTarget.snapshot;

	// By default the API returns updates in descending order; normalize to ascending and filter
	// to only include updates that are after the snapshot.
	const filteredIncrementalUpdates = yjsUpdatesDocs
		.filter((u: app_convex_Doc<"files_yjs_updates">) => u.sequence > yjsSnapshotDoc.sequence)
		.reverse();

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: filteredIncrementalUpdates.map(
			(u: app_convex_Doc<"files_yjs_updates">) => u.update,
		),
	});
	const markdown = files_yjs_doc_get_markdown({ yjsDoc });

	const yjsSequence = yjsLastSequenceDoc?.lastSequence ?? yjsSnapshotDoc.sequence;

	return { markdown, yjsDoc, yjsSequence };
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
export function files_monaco_create_editor_model(markdown: string) {
	const model = monaco_editor.createModel(markdown, "markdown");
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}
// #endregion monaco
