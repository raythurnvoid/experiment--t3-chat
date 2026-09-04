import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { files_PresenceStore } from "./files.ts";
import { files_yjs_Provider, type files_yjs_Provider_Args } from "./files-yjs-provider.ts";

type PromiseConstructorWithTry = Omit<PromiseConstructor, "try"> & {
	try?: <T>(callback: () => T | PromiseLike<T>) => Promise<Awaited<T>>;
};

type TestPresenceStoreData = ConstructorParameters<typeof files_PresenceStore>[0]["data"];

type MockIncrementalUpdate = {
	sequence: number;
	update: ArrayBuffer;
	origin: {
		type: "USER_EDIT";
		sessionId: string;
	};
};

type MockIncrementalUpdates = { yjsLastSequenceId: string; updates: MockIncrementalUpdate[] } | null;

type MockPushUpdateArgs = {
	membershipId: string;
	nodeId: string;
	update: ArrayBuffer;
	sessionId: string;
	expectedYjsLastSequenceId: string;
};

const appConvexMock = vi.hoisted(() => {
	let watcherResult: MockIncrementalUpdates = null;
	let watcherCallback: (() => void) | null = null;

	const files_u8_to_array_buffer = (u8: Uint8Array) => {
		if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
			return u8.buffer as ArrayBuffer;
		}

		return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
	};

	const files_u8_equals = (a: Uint8Array, b: Uint8Array) => {
		if (a.byteLength !== b.byteLength) return false;

		for (let i = 0; i < a.byteLength; i++) {
			if (a[i] !== b[i]) return false;
		}

		return true;
	};

	const files_yjs_doc_is_diff_update_empty = (diffUpdate: Uint8Array) => {
		return diffUpdate.byteLength === 0 || files_u8_equals(diffUpdate, new Uint8Array([0, 0]));
	};

	const unsubscribe = vi.fn();
	const watcher = {
		localQueryResult: vi.fn(() => watcherResult),
		onUpdate: vi.fn((callback: () => void) => {
			watcherCallback = callback;
			return unsubscribe;
		}),
	};

	const app_convex = {
		action: vi.fn(),
		mutation: vi.fn(),
		query: vi.fn(),
		watchQuery: vi.fn(() => watcher),
	};

	return {
		app_convex,
		app_convex_api: {
			files_nodes: {
				yjs_prepare_doc_last_snapshot: "yjs_prepare_doc_last_snapshot",
				yjs_get_incremental_updates: "yjs_get_incremental_updates",
				yjs_push_update: "yjs_push_update",
			},
		},
		emitIncrementalUpdates(result: MockIncrementalUpdates) {
			watcherResult = result;
			watcherCallback?.();
		},
		files_u8_equals,
		files_u8_to_array_buffer,
		files_yjs_doc_is_diff_update_empty,
		reset() {
			watcherResult = null;
			watcherCallback = null;
			unsubscribe.mockClear();
			watcher.localQueryResult.mockClear();
			watcher.onUpdate.mockClear();
			app_convex.action.mockReset();
			app_convex.mutation.mockReset();
			app_convex.query.mockReset();
			app_convex.watchQuery.mockReset();
			app_convex.watchQuery.mockReturnValue(watcher);
		},
	};
});

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: appConvexMock.app_convex,
	app_convex_api: appConvexMock.app_convex_api,
}));

const promiseConstructor = Promise as PromiseConstructorWithTry;
const originalPromiseTry = promiseConstructor.try;

function createEmptySnapshotUpdate() {
	return appConvexMock.files_u8_to_array_buffer(Y.encodeStateAsUpdate(new Y.Doc()));
}

function createPresenceStore() {
	const localSessionId = "session_local";
	const localUserId = "user_local";

	return new files_PresenceStore({
		data: {
			sessionToken: "session_token",
			sessions: [{ sessionId: localSessionId, userId: localUserId }],
			sessionsData: {
				[localSessionId]: {
					color: "#000000",
				},
			},
			usersAnagraphics: {
				[localUserId]: {
					displayName: "Local User",
				} as TestPresenceStoreData["usersAnagraphics"][string],
			},
		},
		localSessionId,
		onSetSessionData: vi.fn(),
	});
}

function getRootDoc(provider: files_yjs_Provider) {
	return provider.getYDoc();
}

async function flushMicrotasks() {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

async function advanceTimersByTime(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await flushMicrotasks();
}

async function createReadyProvider(args: { editable?: boolean } = {}) {
	const presenceStore = createPresenceStore();
	const emptySnapshotUpdate = createEmptySnapshotUpdate();
	appConvexMock.app_convex.action.mockResolvedValue({
		snapshot: {
			sequence: 0,
		},
		snapshotUrl: "https://r2.test/snapshot",
		yjsLastSequenceId: "last_sequence_id",
	});
	appConvexMock.app_convex.query.mockResolvedValue(null);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(emptySnapshotUpdate)),
	);

	const provider = new files_yjs_Provider({
		membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
		nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
		expectedYjsLastSequenceId: "last_sequence_id" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
		presenceStore,
		editable: args.editable ?? true,
	});

	appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "last_sequence_id", updates: [] });
	await flushMicrotasks();
	expect(provider.getStatus()).toBe("synchronized");

	return {
		presenceStore,
		provider,
		rootDoc: getRootDoc(provider),
	};
}

function insertText(rootDoc: Y.Doc, text: string) {
	const yText = rootDoc.getText("content");
	yText.insert(yText.length, text);
}

function getMutationUpdate(callIndex: number) {
	const call = appConvexMock.app_convex.mutation.mock.calls[callIndex];
	if (!call) {
		throw new Error(`Missing yjs_push_update mutation call at index ${callIndex}`);
	}

	return (call[1] as MockPushUpdateArgs).update;
}

function emitLocalAck(args: { sequence: number; sessionId: string; update: ArrayBuffer }) {
	appConvexMock.emitIncrementalUpdates({
		yjsLastSequenceId: "last_sequence_id",
		updates: [
			{
				sequence: args.sequence,
				update: args.update,
				origin: {
					type: "USER_EDIT",
					sessionId: args.sessionId,
				},
			},
		],
	});
}

beforeAll(() => {
	if (!promiseConstructor.try) {
		promiseConstructor.try = <T>(callback: () => T | PromiseLike<T>) => Promise.resolve(callback());
	}
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	appConvexMock.reset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

afterAll(() => {
	if (originalPromiseTry) {
		promiseConstructor.try = originalPromiseTry;
	} else {
		delete promiseConstructor.try;
	}
});

describe("files_yjs_Provider snapshot sync", () => {
	test("retries failed R2 snapshot fetches before marking the provider synchronized", async () => {
		const presenceStore = createPresenceStore();
		const emptySnapshotUpdate = createEmptySnapshotUpdate();
		appConvexMock.app_convex.action.mockResolvedValue({
			snapshot: {
				sequence: 0,
			},
			snapshotUrl: "https://r2.test/snapshot",
			yjsLastSequenceId: "last_sequence_id",
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(emptySnapshotUpdate));
		vi.stubGlobal("fetch", fetchMock);

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "last_sequence_id" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore,
			editable: true,
		});

		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "last_sequence_id", updates: [] });
		await flushMicrotasks();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(provider.getStatus()).toBe("loading");

		await advanceTimersByTime(500);

		expect(appConvexMock.app_convex.action).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(provider.getStatus()).toBe("synchronized");

		provider.destroy();
	});

	test("waits for incremental updates from the same lineage as the snapshot", async () => {
		const presenceStore = createPresenceStore();
		const emptySnapshotUpdate = createEmptySnapshotUpdate();
		appConvexMock.app_convex.action.mockResolvedValue({
			snapshot: { sequence: 0 },
			snapshotUrl: "https://r2.test/snapshot",
			yjsLastSequenceId: "lineage_b",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(emptySnapshotUpdate)),
		);

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "lineage_b" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore,
			editable: true,
		});

		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_a", updates: [] });
		await flushMicrotasks();
		expect(provider.getStatus()).toBe("loading");

		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_b", updates: [] });
		await advanceTimersByTime(500);
		expect(provider.getStatus()).toBe("synchronized");

		provider.destroy();
	});

	test("stops without the load-failed banner when the prepare action returns another lineage", async () => {
		appConvexMock.app_convex.action.mockResolvedValue({
			snapshot: { sequence: 0 },
			snapshotUrl: "https://r2.test/snapshot",
			yjsLastSequenceId: "lineage_b",
		});
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(createEmptySnapshotUpdate())),
		);

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "lineage_a" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore: createPresenceStore(),
			editable: true,
		});

		// The subscription shows the expected lineage first, then the newer one the action returned.
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_a", updates: [] });
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_b", updates: [] });
		await flushMicrotasks();
		expect(provider.getStatus()).toBe("loading");
		expect(provider.loadFailed).toBe(false);

		insertText(getRootDoc(provider), "held");
		await advanceTimersByTime(6000);
		expect(provider.loadFailed).toBe(false);
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();

		provider.destroy();
	});

	test("stops without the load-failed banner when a newer lineage arrives before the snapshot is applied", async () => {
		appConvexMock.app_convex.action.mockResolvedValue({
			snapshot: { sequence: 0 },
			snapshotUrl: "https://r2.test/snapshot",
			yjsLastSequenceId: "lineage_a",
		});
		const fetchResult = Promise.withResolvers<Response>();
		const fetchMock = vi.fn(() => fetchResult.promise);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "lineage_a" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore: createPresenceStore(),
			editable: true,
		});

		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_a", updates: [] });
		await flushMicrotasks();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// The lineage changes while the snapshot download is still running.
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "lineage_b", updates: [] });
		fetchResult.resolve(new Response(createEmptySnapshotUpdate()));
		await advanceTimersByTime(6000);

		expect(provider.getStatus()).toBe("loading");
		expect(provider.loadFailed).toBe(false);
		expect(appConvexMock.app_convex.action).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		provider.destroy();
	});
});

describe("files_yjs_Provider incoming updates", () => {
	test("ignores incremental updates from another lineage after sync", async () => {
		const { provider, rootDoc } = await createReadyProvider();
		const remoteDoc = new Y.Doc();
		remoteDoc.getText("content").insert(0, "remote");
		const remotePacket: MockIncrementalUpdate = {
			sequence: 1,
			update: appConvexMock.files_u8_to_array_buffer(Y.encodeStateAsUpdate(remoteDoc)),
			origin: { type: "USER_EDIT", sessionId: "session_remote" },
		};

		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "other_lineage", updates: [remotePacket] });
		expect(rootDoc.getText("content").toString()).toBe("");

		// The same packet on the expected lineage is applied, so the lineage check is the only
		// reason the first one was skipped.
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "last_sequence_id", updates: [remotePacket] });
		expect(rootDoc.getText("content").toString()).toBe("remote");

		provider.destroy();
	});
});

describe("files_yjs_Provider outgoing update queue", () => {
	test("debounces multiple local edits into one yjs push", async () => {
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });
		const { provider, rootDoc } = await createReadyProvider();

		insertText(rootDoc, "a");
		await advanceTimersByTime(250);
		insertText(rootDoc, "b");

		await advanceTimersByTime(499);
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();

		await advanceTimersByTime(1);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		provider.destroy();
	});

	test("holds a local edit made before sync finishes until the document is confirmed", async () => {
		const prepareResult = Promise.withResolvers<{
			snapshot: { sequence: number };
			snapshotUrl: string;
			yjsLastSequenceId: string;
		}>();
		appConvexMock.app_convex.action.mockReturnValue(prepareResult.promise);
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(createEmptySnapshotUpdate())),
		);

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "last_sequence_id" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore: createPresenceStore(),
			editable: true,
		});
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "last_sequence_id", updates: [] });

		insertText(getRootDoc(provider), "early");
		await advanceTimersByTime(1500);
		expect(provider.getStatus()).toBe("loading");
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();

		prepareResult.resolve({
			snapshot: { sequence: 0 },
			snapshotUrl: "https://r2.test/snapshot",
			yjsLastSequenceId: "last_sequence_id",
		});
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
		expect((appConvexMock.app_convex.mutation.mock.calls[0]![1] as MockPushUpdateArgs).expectedYjsLastSequenceId).toBe(
			"last_sequence_id",
		);

		await advanceTimersByTime(1000);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		provider.destroy();
	});

	test("drops a queued edit when the provider is destroyed before sync finishes", async () => {
		// The prepare action never answers, so sync never confirms the document.
		appConvexMock.app_convex.action.mockReturnValue(Promise.withResolvers().promise);
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });

		const provider = new files_yjs_Provider({
			membershipId: "membership_id" as files_yjs_Provider_Args["membershipId"],
			nodeId: "file_id" as files_yjs_Provider_Args["nodeId"],
			expectedYjsLastSequenceId: "last_sequence_id" as files_yjs_Provider_Args["expectedYjsLastSequenceId"],
			presenceStore: createPresenceStore(),
			editable: true,
		});
		appConvexMock.emitIncrementalUpdates({ yjsLastSequenceId: "last_sequence_id", updates: [] });

		insertText(getRootDoc(provider), "not confirmed");
		provider.destroy();
		await advanceTimersByTime(1000);

		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();
	});

	test("does not count each rate-limit retry as a separate outgoing update", async () => {
		appConvexMock.app_convex.mutation
			.mockResolvedValueOnce({ _nay: { message: "Rate limit exceeded", name: "nay" } })
			.mockResolvedValueOnce({ _nay: { message: "Rate limit exceeded", name: "nay" } })
			.mockResolvedValueOnce({ _yay: { newSequence: 1 } });
		const { presenceStore, provider, rootDoc } = await createReadyProvider();

		insertText(rootDoc, "a");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
		const firstAttemptUpdate = getMutationUpdate(0);
		expect((appConvexMock.app_convex.mutation.mock.calls[0]![1] as MockPushUpdateArgs).expectedYjsLastSequenceId).toBe(
			"last_sequence_id",
		);
		expect(provider.getStatus()).toBe("synchronizing");

		await advanceTimersByTime(5000);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(2);
		expect(getMutationUpdate(1)).toBe(firstAttemptUpdate);

		await advanceTimersByTime(5000);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(3);
		expect(getMutationUpdate(2)).toBe(firstAttemptUpdate);
		expect(provider.getStatus()).toBe("synchronizing");

		emitLocalAck({
			sequence: 1,
			sessionId: presenceStore.localSessionId,
			update: getMutationUpdate(2),
		});
		expect(provider.getStatus()).toBe("synchronized");

		provider.destroy();
	});

	test("keeps edits made during retry behind the failed head batch", async () => {
		appConvexMock.app_convex.mutation
			.mockResolvedValueOnce({ _nay: { message: "Rate limit exceeded", name: "nay" } })
			.mockResolvedValueOnce({ _yay: { newSequence: 1 } })
			.mockResolvedValueOnce({ _yay: { newSequence: 2 } });
		const { provider, rootDoc } = await createReadyProvider();

		insertText(rootDoc, "a");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
		const firstAttemptUpdate = getMutationUpdate(0);

		insertText(rootDoc, "b");
		await advanceTimersByTime(4999);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		await advanceTimersByTime(1);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(2);
		expect(getMutationUpdate(1)).toBe(firstAttemptUpdate);

		await advanceTimersByTime(499);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(2);

		await advanceTimersByTime(1);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(3);
		expect(getMutationUpdate(2)).not.toBe(firstAttemptUpdate);

		provider.destroy();
	});

	test("drops a queued batch after the editor becomes read-only and keeps the warning", async () => {
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });
		const { provider, rootDoc } = await createReadyProvider();
		const pushRefused = vi.fn();
		provider.on("pushRefused", pushRefused);

		insertText(rootDoc, "not saved");
		provider.dropPendingUpdatesForAccessChange({ editable: false, editBlockReason: "read_only" });

		expect(provider.pushRefusedReason).toBe("read_only");
		expect(pushRefused).toHaveBeenCalledWith("read_only", true);
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();

		provider.destroy();
		await flushMicrotasks();
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();
	});

	test("reports permission when write access loss drops a queued batch", async () => {
		const { provider, rootDoc } = await createReadyProvider();
		const pushRefused = vi.fn();
		provider.on("pushRefused", pushRefused);

		insertText(rootDoc, "not saved");
		provider.dropPendingUpdatesForAccessChange({ editable: false, editBlockReason: "permission" });

		expect(provider.pushRefusedReason).toBe("permission");
		expect(pushRefused).toHaveBeenCalledWith("permission", true);

		provider.destroy();
	});

	test("drops an in-flight batch after the editor becomes read-only", async () => {
		const pushResult = Promise.withResolvers<{ _yay: { newSequence: number } }>();
		appConvexMock.app_convex.mutation.mockReturnValue(pushResult.promise);
		const { provider, rootDoc } = await createReadyProvider();

		insertText(rootDoc, "in flight");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		provider.dropPendingUpdatesForAccessChange({ editable: false, editBlockReason: "read_only" });
		provider.destroy();
		pushResult.resolve({ _yay: { newSequence: 1 } });
		await flushMicrotasks();

		expect(provider.pushRefusedReason).toBe("read_only");
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
	});

	test("drops a read-only batch and does not retry it after another local edit", async () => {
		appConvexMock.app_convex.mutation.mockResolvedValue({
			_nay: { message: "This item is read-only.", name: "read_only" },
		});
		const { provider, rootDoc } = await createReadyProvider();

		insertText(rootDoc, "not saved");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
		expect(provider.pushRefusedReason).toBe("read_only");

		insertText(rootDoc, " still not saved");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		provider.destroy();
		await flushMicrotasks();
		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);
	});

	test("reports permission when the server refuses an edit after access is removed", async () => {
		appConvexMock.app_convex.mutation.mockResolvedValue({
			_nay: { message: "Permission denied", name: "nay" },
		});
		const { provider, rootDoc } = await createReadyProvider();
		const pushRefused = vi.fn();
		provider.on("pushRefused", pushRefused);

		insertText(rootDoc, "not saved");
		await advanceTimersByTime(500);

		expect(provider.pushRefusedReason).toBe("permission");
		expect(pushRefused).toHaveBeenCalledWith("permission", false);

		provider.destroy();
	});

	test("does not queue local updates while the provider is read-only", async () => {
		const { provider, rootDoc } = await createReadyProvider({ editable: false });

		insertText(rootDoc, "not queued");
		await advanceTimersByTime(500);
		expect(appConvexMock.app_convex.mutation).not.toHaveBeenCalled();

		provider.destroy();
	});

	test("resyncs before sending a fresh edit after access changes", async () => {
		appConvexMock.app_convex.mutation.mockResolvedValue({ _yay: { newSequence: 1 } });
		const oldProvider = await createReadyProvider();

		insertText(oldProvider.rootDoc, "old edit");
		oldProvider.provider.dropPendingUpdatesForAccessChange({ editable: true, editBlockReason: null });
		oldProvider.provider.destroy();

		const freshProvider = await createReadyProvider();
		expect(appConvexMock.app_convex.action).toHaveBeenCalledTimes(2);
		insertText(freshProvider.rootDoc, "fresh edit");
		await advanceTimersByTime(500);

		expect(appConvexMock.app_convex.mutation).toHaveBeenCalledTimes(1);

		freshProvider.provider.destroy();
	});
});
