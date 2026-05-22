import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { files_PresenceStore } from "./files.ts";
import {
	LiveblocksYjsProvider,
	type LiveblocksYjsProvider_Args,
} from "../../vendor/liveblocks/packages/liveblocks-yjs/src/provider.ts";

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

type MockIncrementalUpdates = { updates: MockIncrementalUpdate[] } | null;

type MockPushUpdateArgs = {
	membershipId: string;
	nodeId: string;
	update: ArrayBuffer;
	sessionId: string;
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

vi.mock("../../vendor/liveblocks/packages/liveblocks-yjs/app_lb_bridge.ts", () => ({
	app_convex: appConvexMock.app_convex,
	app_convex_api: appConvexMock.app_convex_api,
	files_u8_equals: appConvexMock.files_u8_equals,
	files_u8_to_array_buffer: appConvexMock.files_u8_to_array_buffer,
	files_yjs_doc_is_diff_update_empty: appConvexMock.files_yjs_doc_is_diff_update_empty,
}));

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

function getRootDoc(provider: LiveblocksYjsProvider) {
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

async function createReadyProvider() {
	const presenceStore = createPresenceStore();
	const emptySnapshotUpdate = createEmptySnapshotUpdate();
	appConvexMock.app_convex.action.mockResolvedValue({
		snapshot: {
			sequence: 0,
		},
		snapshotUrl: "https://r2.test/snapshot",
	});
	appConvexMock.app_convex.query.mockResolvedValue(null);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(emptySnapshotUpdate)),
	);

	const provider = new LiveblocksYjsProvider({
		membershipId: "membership_id" as LiveblocksYjsProvider_Args["membershipId"],
		nodeId: "file_id" as LiveblocksYjsProvider_Args["nodeId"],
		presenceStore,
	});

	appConvexMock.emitIncrementalUpdates(null);
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

describe("LiveblocksYjsProvider snapshot sync", () => {
	test("retries failed R2 snapshot fetches before marking the provider synchronized", async () => {
		const presenceStore = createPresenceStore();
		const emptySnapshotUpdate = createEmptySnapshotUpdate();
		appConvexMock.app_convex.action.mockResolvedValue({
			snapshot: {
				sequence: 0,
			},
			snapshotUrl: "https://r2.test/snapshot",
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(emptySnapshotUpdate));
		vi.stubGlobal("fetch", fetchMock);

		const provider = new LiveblocksYjsProvider({
			membershipId: "membership_id" as LiveblocksYjsProvider_Args["membershipId"],
			nodeId: "file_id" as LiveblocksYjsProvider_Args["nodeId"],
			presenceStore,
		});

		appConvexMock.emitIncrementalUpdates(null);
		await flushMicrotasks();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(provider.getStatus()).toBe("loading");

		await advanceTimersByTime(500);

		expect(appConvexMock.app_convex.action).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(provider.getStatus()).toBe("synchronized");

		provider.destroy();
	});
});

describe("LiveblocksYjsProvider outgoing update queue", () => {
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
});
