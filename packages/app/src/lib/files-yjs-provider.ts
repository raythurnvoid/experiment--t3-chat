// Adapted from `references-submodules/liveblocks/packages/liveblocks-yjs/src/provider.ts`. The Liveblocks Room backend was
// replaced with Convex, so this is app code now. Keep it comparable to upstream when porting fixes.

import { DerivedSignal, type IYjsProvider, type YjsSyncStatus } from "@liveblocks/core";
import { ObservableV2 } from "lib0/observable";
import { Doc } from "yjs";
import { PermanentUserData, mergeUpdates } from "yjs";

import { files_yjs_Awareness } from "@/lib/files-yjs-awareness.ts";
import { files_yjs_DocHandler } from "@/lib/files-yjs-doc.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
	type app_convex_Watch,
} from "@/lib/app-convex-client.ts";
import type { files_PresenceStore } from "@/lib/files.ts";
import { files_u8_to_array_buffer, files_yjs_doc_is_diff_update_empty } from "../../shared/files.ts";
import { files_yjs_COMPACTION_RETRY_MESSAGE } from "../../shared/files-yjs.ts";

type StreamStateKey = "__root" | (string & {});

function files_convex_stream_key(guid: string | undefined): StreamStateKey {
	return guid ?? "__root";
}

type FilesConvexIncrementalUpdates = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.yjs_get_incremental_updates>
>;

export type files_yjs_EditBlockReason = "read_only" | "permission";
export type files_yjs_PushRefusalReason = files_yjs_EditBlockReason | "other";

type FilesConvexYjsStream_Args = {
	nodeId: app_convex_Id<"files_nodes">;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	presenceStore: files_PresenceStore;
	onGoodUpdatePacket: (packet: FilesConvexIncrementalUpdates["updates"][number]) => void;
	onAckUpdatePacket: (packet: FilesConvexIncrementalUpdates["updates"][number]) => void;
	onOutgoingUpdateSent: () => void;
	onSync: (currentStateUpdate: Uint8Array) => void;
	onLoadFailedChange: (failed: boolean) => void;
	onPushRefusedChange: (reason: files_yjs_PushRefusalReason | null, persistent?: boolean) => void;
};

type FilesConvexYjsOutgoingBatch = {
	update: Uint8Array;
	sealed: boolean;
	dropped: boolean;
};

class FilesConvexYjsStream {
	args: FilesConvexYjsStream_Args;
	state: {
		syncing: boolean;
		ready: boolean;
		appliedSeq: number;
		incrementalUpdates: FilesConvexIncrementalUpdates | null;
	};

	private onRemoteUpdatePacket: FilesConvexYjsStream_Args["onGoodUpdatePacket"];
	private onAckUpdatePacket: FilesConvexYjsStream_Args["onAckUpdatePacket"];
	private onOutgoingUpdateSent: FilesConvexYjsStream_Args["onOutgoingUpdateSent"];
	private onSync: FilesConvexYjsStream_Args["onSync"];
	private onLoadFailedChange: FilesConvexYjsStream_Args["onLoadFailedChange"];
	private onPushRefusedChange: FilesConvexYjsStream_Args["onPushRefusedChange"];

	private watcher: app_convex_Watch<
		app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.yjs_get_incremental_updates>
	>;
	private unsubscribe: () => void;
	private disposed = false;

	private pendingOutgoingBatches: FilesConvexYjsOutgoingBatch[] = [];
	private outgoingUpdatesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private outgoingUpdateInFlight = false;

	private incrementalUpdatesFirstValueReceived = Object.assign(Promise.withResolvers(), { initialized: false });

	constructor(args: FilesConvexYjsStream_Args) {
		this.args = args;
		this.state = {
			syncing: false,
			ready: false,
			appliedSeq: 0,
			incrementalUpdates: null,
		};

		this.onRemoteUpdatePacket = args.onGoodUpdatePacket;
		this.onAckUpdatePacket = args.onAckUpdatePacket;
		this.onOutgoingUpdateSent = args.onOutgoingUpdateSent;
		this.onSync = args.onSync;
		this.onLoadFailedChange = args.onLoadFailedChange;
		this.onPushRefusedChange = args.onPushRefusedChange;

		this.watcher = app_convex.watchQuery(app_convex_api.files_nodes.yjs_get_incremental_updates, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});

		this.unsubscribe = this.watcher.onUpdate(() => {
			if (this.disposed) return;
			const updateData = this.watcher.localQueryResult();
			if (!this.incrementalUpdatesFirstValueReceived.initialized) {
				this.incrementalUpdatesFirstValueReceived.resolve(updateData);
				this.incrementalUpdatesFirstValueReceived.initialized = true;
			}
			if (!updateData) return;
			this.state.incrementalUpdates = updateData;
			this.handleIncrementalUpdates(updateData);
		});
	}

	private handleIncrementalUpdates(incrementalUpdates: FilesConvexIncrementalUpdates) {
		if (this.disposed) return;
		if (!this.state.ready || this.state.syncing) return;

		let appliedSeq = this.state.appliedSeq;

		// Loop through updates in ascending order. The BE returns them in descending order.
		for (let i = incrementalUpdates.updates.length - 1; i >= 0; i--) {
			const updatePacket = incrementalUpdates.updates[i];

			if (!updatePacket || updatePacket.sequence <= appliedSeq) continue;

			// Only USER_EDIT with matching sessionId are treated as local (ack-only).
			// All other origins (USER_SNAPSHOT_RESTORE, USER_AI_EDIT, or USER_EDIT with different sessionId)
			// are treated as remote changes and applied to the document.
			const isLocalEdit =
				updatePacket.origin.type === "USER_EDIT" &&
				updatePacket.origin.sessionId === this.args.presenceStore.localSessionId;

			if (isLocalEdit) {
				// Local packets are "ack-only": applying them again would be redundant,
				// but we still need the ack to update sync status and keep stream
				// ordering consistent.
				this.onAckUpdatePacket(updatePacket);
			} else {
				// Remote changes: apply to the document
				this.onRemoteUpdatePacket(updatePacket);
			}

			appliedSeq = updatePacket.sequence;
		}

		this.state.appliedSeq = appliedSeq;
	}

	enqueueUpdate(update: Uint8Array) {
		if (this.disposed) return;
		if (files_yjs_doc_is_diff_update_empty(update)) return;

		// Merge quick edits into one unsent batch. Keep a sent batch fixed so each
		// retry sends the same Yjs update.
		const tailBatch = this.pendingOutgoingBatches.at(-1);
		if (tailBatch && !tailBatch.sealed) {
			tailBatch.update = mergeUpdates([tailBatch.update, update]);
		} else {
			this.pendingOutgoingBatches.push({
				update,
				sealed: false,
				dropped: false,
			});
		}

		// Let the active pump own retries and follow-up batches. Enqueueing during
		// an in-flight send should only append to the queue.
		if (this.outgoingUpdateInFlight) return;

		const flushUpdates = () => {
			this.outgoingUpdatesDebounceTimer = null;
			this.outgoingUpdateInFlight = true;

			void Promise.try(async () => {
				while (!this.disposed && this.pendingOutgoingBatches.length > 0) {
					// Stop adding edits to this batch before sending it. New edits go into a new
					// batch. A retry sends this same batch again.
					const outgoingBatch = this.pendingOutgoingBatches[0];
					if (!outgoingBatch) continue;
					outgoingBatch.sealed = true;
					if (files_yjs_doc_is_diff_update_empty(outgoingBatch.update)) {
						this.pendingOutgoingBatches.shift();
						continue;
					}

					// Keep the sent batch at the head of the queue until Convex accepts it.
					// Notify sync status once for this batch; retries must not create extra
					// pending ack counts because Convex will only ack the accepted write.
					this.onOutgoingUpdateSent();

					// Retry this same sealed Yjs batch until it persists. Later Yjs updates
					// may depend on earlier structs, so newer edits must not overtake it.
					let compactionRetryCount = 0;
					while (!this.disposed) {
						try {
							const result = await app_convex.mutation(app_convex_api.files_nodes.yjs_push_update, {
								membershipId: this.args.membershipId,
								nodeId: this.args.nodeId,
								update: files_u8_to_array_buffer(outgoingBatch.update),
								sessionId: this.args.presenceStore.localSessionId,
							});

							// Access may change while this request runs. Ignore the result if that change
							// already dropped this batch. The result must not remove a newer batch.
							if (outgoingBatch.dropped) {
								break;
							}

							if (result._nay) {
								console.warn("[FilesConvexYjsStream] yjs_push_update failed", result._nay);

								// A read-only refusal is final. Drop the queued edits and show the warning now.
								// Do not retry these edits after the file is unlocked.
								if (result._nay.name === "read_only") {
									this.dropPendingUpdates();
									this.onPushRefusedChange("read_only", true);
									break;
								}

								// A rate limit is temporary. Keep retrying every 5 seconds.
								// Do not show the final warning for this case.
								if (result._nay.message === "Rate limit exceeded") {
									await new Promise((resolve) => setTimeout(resolve, 5000));
									continue;
								}

								// Compaction means the server is joining old Yjs updates to free space.
								// Retry 5 times. Wait 5 seconds between tries. Show the warning if the
								// server refuses the sixth request.
								if (result._nay.message === files_yjs_COMPACTION_RETRY_MESSAGE && compactionRetryCount < 5) {
									compactionRetryCount += 1;
									await new Promise((resolve) => setTimeout(resolve, 5000));
									continue;
								}

								// Show the warning on the first permission refusal or other final refusal.
								// Keep this batch. A later edit can try it again.
								this.onPushRefusedChange(result._nay.message === "Permission denied" ? "permission" : "other");
								return;
							}

							const batchIndex = this.pendingOutgoingBatches.indexOf(outgoingBatch);
							if (batchIndex !== -1) {
								this.pendingOutgoingBatches.splice(batchIndex, 1);
							}
							this.onPushRefusedChange(null);
							break;
						} catch (err) {
							if (outgoingBatch.dropped) {
								break;
							}

							console.warn("[FilesConvexYjsStream] yjs_push_update errored", err);
							// A network error may be temporary. Keep retrying every 5 seconds.
							// Do not show the final warning for this case.
							await new Promise((resolve) => setTimeout(resolve, 5000));
							continue;
						}
					}

					if (this.pendingOutgoingBatches.length > 0) {
						// Preserve the normal debounce cadence before sealing edits that
						// accumulated while the previous batch was in flight.
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}
			})
				.catch((err: unknown) => {
					console.warn("[FilesConvexYjsStream] outgoing_updates_loop errored", err);
				})
				.finally(() => {
					this.outgoingUpdateInFlight = false;
				});
		};

		if (this.outgoingUpdatesDebounceTimer) {
			clearTimeout(this.outgoingUpdatesDebounceTimer);
		}
		// Reset the timer while idle so this stays a real debounce, not a throttle.
		this.outgoingUpdatesDebounceTimer = setTimeout(flushUpdates, 500);
	}

	dropPendingUpdates() {
		const dropped = this.pendingOutgoingBatches.length > 0;

		// Mark each batch before clearing the queue. An active request still holds
		// its batch and may finish later.
		for (const batch of this.pendingOutgoingBatches) {
			batch.dropped = true;
		}
		this.pendingOutgoingBatches = [];

		// Stop the scheduled send because the queue is now empty.
		if (this.pendingOutgoingBatches.length === 0 && this.outgoingUpdatesDebounceTimer) {
			clearTimeout(this.outgoingUpdatesDebounceTimer);
			this.outgoingUpdatesDebounceTimer = null;
		}

		return dropped;
	}

	async sync() {
		if (this.disposed) return;
		if (this.state.syncing) return;

		this.state.syncing = true;

		let iteration = 0;

		try {
			do {
				iteration++;
				// After 10 straight failures, tell the UI the document is not loading, then keep
				// retrying more slowly. The old code gave up here, and a tab that was open during
				// a short storage outage stayed on an empty document forever with no message.
				if (iteration === 11) {
					console.error("[FilesConvexYjsStream.sync] yjs sync failed after 10 retries", {
						membershipId: this.args.membershipId,
						nodeId: this.args.nodeId,
					});
					this.onLoadFailedChange(true);
				}
				const retryDelayMs = iteration > 10 ? 5000 : 500;

				let result: app_convex_FunctionReturnType<
					typeof app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot
				> | null = null;

				try {
					[result] = await Promise.all([
						app_convex.action(app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot, {
							membershipId: this.args.membershipId,
							nodeId: this.args.nodeId,
						}),
						this.incrementalUpdatesFirstValueReceived.promise,
					]);
				} catch (err) {
					console.warn("[FilesConvexYjsStream.sync] snapshot query failed, retrying", err);
					// Backoff a bit before retrying to avoid hot-looping on transient errors.
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
					continue;
				}

				// A null answer is not retryable: the node is gone or this user lost read access.
				if (!result) {
					console.error("[FilesConvexYjsStream.sync] fetch_doc returned null");
					this.onLoadFailedChange(true);
					break;
				}

				if (this.disposed) break;

				let resultSnapshotUpdate: ArrayBuffer;
				try {
					if (!result.snapshotUrl) {
						throw new Error("Yjs snapshot URL is not set");
					}

					resultSnapshotUpdate = await fetch(result.snapshotUrl).then((response) => {
						if (!response.ok) {
							throw new Error("Failed to fetch Yjs snapshot from R2");
						}

						return response.arrayBuffer();
					});
				} catch (err) {
					console.warn("[FilesConvexYjsStream.sync] snapshot fetch failed, retrying", err);
					// Backoff a bit before retrying to avoid hot-looping on transient R2 errors.
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
					continue;
				}

				if (this.disposed) break;

				const snapshotUpdate = new Uint8Array(resultSnapshotUpdate);

				let lastSequence = result.snapshot.sequence;
				let updatesAfterSnapshot;

				if (this.state.incrementalUpdates?.updates.length) {
					updatesAfterSnapshot = [] as Uint8Array[];

					// Loop through updates in ascending order. The BE returns them in descending order.
					for (let i = this.state.incrementalUpdates.updates.length - 1; i >= 0; i--) {
						const updateData = this.state.incrementalUpdates?.updates[i];
						if (!updateData) continue;

						if (updateData.sequence <= lastSequence) {
							continue;
						}

						// Only USER_EDIT with matching sessionId are treated as local (ack-only).
						// All other origins (USER_SNAPSHOT_RESTORE, USER_AI_EDIT, or USER_EDIT with different sessionId)
						// are treated as remote changes and applied to the document.
						const isLocalEdit =
							updateData.origin.type === "USER_EDIT" &&
							updateData.origin.sessionId === this.args.presenceStore.localSessionId;

						lastSequence = updateData.sequence;

						// Only skip local edits AFTER we've hydrated at least once.
						// On the first sync of a fresh provider, the doc has NOT applied them yet.
						if (this.state.ready && isLocalEdit) continue;

						updatesAfterSnapshot.push(new Uint8Array(updateData.update));
					}
				}

				const currentStateUpdate = updatesAfterSnapshot
					? mergeUpdates([snapshotUpdate, ...updatesAfterSnapshot])
					: snapshotUpdate;

				// `onSync()` applies `currentStateUpdate` to the Yjs doc synchronously.
				// There is no possible interleaving *inside* that apply step.
				// The only interleaving point is earlier in this `sync()` at `await`s: the query watcher
				// may update `this.state.incrementalUpdates` while we are awaiting the snapshot/query.

				this.onSync(currentStateUpdate);
				this.state.ready = true;
				this.state.appliedSeq = lastSequence;
				this.onLoadFailedChange(false);

				break;
			} while (true);
		} finally {
			this.state.syncing = false;
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.outgoingUpdatesDebounceTimer) {
			clearTimeout(this.outgoingUpdatesDebounceTimer);
			this.outgoingUpdatesDebounceTimer = null;
		}

		// Try to send every queued batch once before the editor closes. This protects
		// the user's last keystrokes. A batch may already be in flight, but Yjs can
		// apply the same update twice without changing the document twice.
		for (const batch of this.pendingOutgoingBatches) {
			batch.sealed = true;
			if (!batch.dropped && !files_yjs_doc_is_diff_update_empty(batch.update)) {
				app_convex
					.mutation(app_convex_api.files_nodes.yjs_push_update, {
						membershipId: this.args.membershipId,
						nodeId: this.args.nodeId,
						update: files_u8_to_array_buffer(batch.update),
						sessionId: this.args.presenceStore.localSessionId,
					})
					.then((result) => {
						if (result._nay) {
							console.warn("[FilesConvexYjsStream] final yjs_push_update failed", result._nay);
						}
					})
					.catch((err: unknown) => {
						console.warn("[FilesConvexYjsStream] final yjs_push_update errored", err);
					});
			}
		}

		this.outgoingUpdateInFlight = false;
		this.pendingOutgoingBatches = [];
		this.unsubscribe();
	}
}

export type files_yjs_Provider_Args = {
	nodeId: app_convex_Id<"files_nodes">;
	enablePermanentUserData?: boolean;
	presenceStore: files_PresenceStore;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	/** Set this to false to keep sync active without collecting local edits. */
	editable: boolean;
};

/** `sync` and `status` are required by `IYjsProvider`; `synced` is the Yjs-style alias. */
type files_yjs_Provider_Events = {
	sync: (synced: boolean) => void;
	synced: (synced: boolean) => void;
	status: (status: YjsSyncStatus) => void;
	/** Fires with true when the initial document load keeps failing, and false once a load succeeds. */
	loadFailed: (failed: boolean) => void;
	/**
	 * `reason` tells the UI why the edit failed. `persistent` keeps the warning
	 * after the hook creates a new provider.
	 */
	pushRefused: (reason: files_yjs_PushRefusalReason | null, persistent?: boolean) => void;
};

export class files_yjs_Provider extends ObservableV2<files_yjs_Provider_Events> implements IYjsProvider {
	args: files_yjs_Provider_Args;

	private readonly rootDoc: Doc;
	private isPaused = false;

	private readonly unsubscribers: Array<() => void> = [];

	public readonly awareness: files_yjs_Awareness;

	public readonly rootDocHandler: files_yjs_DocHandler;

	/** True while the initial document load keeps failing; read it before the event fires. */
	public loadFailed = false;

	/** Read this before the event fires to learn why the latest push failed. */
	public pushRefusedReason: files_yjs_PushRefusalReason | null = null;
	// Keep an access warning even if an older request succeeds later.
	private persistentPushRefusalReason: files_yjs_PushRefusalReason | null = null;

	private readonly syncStatusΣ: DerivedSignal<YjsSyncStatus>;

	public readonly permanentUserData?: PermanentUserData;

	private readonly convexStreams = new Map<StreamStateKey, FilesConvexYjsStream>();

	constructor(args: files_yjs_Provider_Args) {
		super();
		this.args = args;
		this.rootDoc = new Doc();

		this.rootDocHandler = new files_yjs_DocHandler({
			doc: this.rootDoc,
			isRoot: true,
			updateDoc: this.updateDoc,
			fetchDoc: this.fetchDoc,
		});

		if (this.args.enablePermanentUserData) {
			this.permanentUserData = new PermanentUserData(this.rootDoc);
		}

		// Construct Convex-backed awareness
		if (!this.args.presenceStore) {
			throw new Error("convexPresenceConfig is required for files_yjs_Provider");
		}

		this.awareness = new files_yjs_Awareness(this.rootDoc, this.args.presenceStore);

		// different consumers listen to sync and synced
		this.rootDocHandler.on("synced", () => {
			const state = this.rootDocHandler.synced;

			this.emit("synced", [state]);
			this.emit("sync", [state]);
		});
		this.syncDoc();

		if (this.args.presenceStore) {
			this.ensureConvexStream({
				yDocHandler: this.rootDocHandler,
				presenceStore: this.args.presenceStore,
			});
		}

		this.syncStatusΣ = DerivedSignal.from(() => {
			return this.rootDocHandler.experimental_getSyncStatus();
		});

		this.emit("status", [this.getStatus()]);

		this.unsubscribers.push(
			this.syncStatusΣ.subscribe(() => {
				this.emit("status", [this.getStatus()]);
			}),
		);
	}

	private updateDoc = (update: Uint8Array) => {
		// Keep receiving saved changes in read-only mode. Do not queue local edits.
		if (!this.args.editable || this.isPaused) return;
		if (update.byteLength === 0) return;

		const stream = this.ensureConvexStream({
			yDocHandler: this.rootDocHandler,
			presenceStore: this.args.presenceStore,
		});
		stream.enqueueUpdate(update);
	};

	private fetchDoc = () => {
		const stream = this.ensureConvexStream({
			yDocHandler: this.rootDocHandler,
			presenceStore: this.args.presenceStore,
		});
		stream.sync();
	};

	private ensureConvexStream(args: {
		yDocHandler: files_yjs_DocHandler;
		presenceStore: files_PresenceStore;
		guid?: string;
	}) {
		const key = files_convex_stream_key(args.guid);
		let stream = this.convexStreams.get(key);
		if (stream) {
			return stream;
		}

		stream = new FilesConvexYjsStream({
			nodeId: this.args.nodeId,
			membershipId: this.args.membershipId,
			presenceStore: args.presenceStore,
			onGoodUpdatePacket: (updateItem) => {
				args.yDocHandler.handleServerUpdate({
					update: new Uint8Array(updateItem.update),
				});
			},
			onAckUpdatePacket: () => {
				// Do not re-apply local updates (already applied optimistically).
				// Still use the ack so sync status can converge to "synchronized"
				// and keep seq ordering consistent.
				args.yDocHandler.notifyOutgoingUpdateAcked();
			},
			onOutgoingUpdateSent: () => {
				args.yDocHandler.notifyOutgoingUpdateSent();
			},
			onSync: (currentStateUpdate) => {
				args.yDocHandler.handleDocSync({
					currentStateUpdate,
					canWrite: this.args.editable,
				});
			},
			onLoadFailedChange: (failed) => {
				if (failed === this.loadFailed) return;
				this.loadFailed = failed;
				this.emit("loadFailed", [failed]);
			},
			onPushRefusedChange: (reason, persistent = false) => {
				const wasPersistent = this.persistentPushRefusalReason !== null;

				// Stop this provider after an access error. The hook will replace its Y.Doc with a clean one.
				if (persistent && reason) {
					this.persistentPushRefusalReason = reason;
					this.args.editable = false;
				}

				// Keep the warning when an older request succeeds after access changed.
				if (!reason && this.persistentPushRefusalReason) {
					return;
				}

				const nextReason = this.persistentPushRefusalReason ?? reason;
				if (nextReason === this.pushRefusedReason) {
					if (persistent && !wasPersistent && nextReason) {
						this.emit("pushRefused", [nextReason, true]);
					}
					return;
				}

				this.pushRefusedReason = nextReason;
				this.emit("pushRefused", [nextReason, persistent]);
			},
		});

		this.convexStreams.set(key, stream);

		this.unsubscribers.push(() => {
			stream.dispose();
		});

		return stream;
	}

	/**
	 * Drop unsaved edits when the file lock or write permission changes.
	 * A Yjs sync adds saved changes. It cannot remove local edits already in this Y.Doc.
	 * Let the hook create a new Y.Doc and load the saved content again.
	 */
	public dropPendingUpdatesForAccessChange(args: {
		editable: boolean;
		editBlockReason: files_yjs_EditBlockReason | null;
	}) {
		this.args.editable = args.editable;

		let dropped = false;
		for (const stream of this.convexStreams.values()) {
			dropped = stream.dropPendingUpdates() || dropped;
		}

		// Tell the user that these local edits were not saved.
		if (dropped) {
			const reason = args.editBlockReason ?? "other";
			this.persistentPushRefusalReason = reason;
			this.pushRefusedReason = reason;
			this.emit("pushRefused", [reason, true]);
		}
	}

	// attempt to load a subdoc of a given guid
	public loadSubdoc = (guid: string): boolean => {
		for (const subdoc of this.rootDoc.subdocs) {
			if (subdoc.guid === guid) {
				subdoc.load();
				return true;
			}
		}
		// should we throw instead?
		return false;
	};

	private syncDoc = () => {
		this.rootDocHandler.syncDoc();
	};

	// The sync'd property is required by some provider implementations
	get synced(): boolean {
		return this.rootDocHandler.synced;
	}

	async pause(): Promise<void> {
		this.isPaused = true;
	}

	unpause(): void {
		this.isPaused = false;
		this.rootDocHandler.syncDoc();
	}

	public getStatus(): YjsSyncStatus {
		return this.syncStatusΣ.get();
	}

	destroy(): void {
		this.unsubscribers.forEach((unsub) => unsub());
		this.awareness.destroy();
		this.rootDocHandler.destroy();
		super.destroy();
	}

	getYDoc(): Doc {
		return this.rootDoc;
	}

	// Some provider implementations expect to be able to call connect/disconnect, implement as noop
	disconnect(): void {
		// This is a noop for liveblocks as connections are managed by the room
	}

	connect(): void {
		// This is a noop for liveblocks as connections are managed by the room
	}
}
