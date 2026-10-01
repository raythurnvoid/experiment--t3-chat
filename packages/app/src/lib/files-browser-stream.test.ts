import { describe, expect, test, vi } from "vitest";
import {
	files_browser_stream_connect,
	type files_browser_StreamEvents,
	type files_browser_StreamHello,
} from "./files-browser-stream.ts";

type FakeSocket = {
	binaryType: BinaryType;
	readyState: WebSocket["readyState"];
	sent: Array<string>;
	closed: { code: number; reason: string } | null;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	send: (data: string) => void;
	close: (code: number, reason: string) => void;
	emit: (data: unknown) => void;
};

function make_socket(): FakeSocket {
	const socket: FakeSocket = {
		binaryType: "blob",
		readyState: 0,
		sent: [],
		closed: null,
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
		send: (data: string) => {
			socket.sent.push(data);
		},
		close: (code: number, reason: string) => {
			socket.closed = { code, reason };
		},
		emit: (data: unknown) => {
			socket.onmessage?.({ data } as MessageEvent);
		},
	};
	return socket;
}

const hello: files_browser_StreamHello = {
	mode: "web",
	ownerId: "owner-1",
	organizationId: "org-1",
	workspaceId: "ws-1",
	grantId: "grant-1",
	host: "docked",
};

const tab = { tabId: "tab-1", tabGen: 1, viewGen: 1 };
const serverHello = {
	t: "hello",
	mode: "web",
	viewerId: "v-1",
	viewport: { width: 1280, height: 900 },
	control: "ready",
	controlGen: 1,
	...tab,
	viewedTabId: tab.tabId,
	policyRevision: 0,
	tabs: [{ tabId: tab.tabId, tabGen: 1, navGen: 1, title: "Example", url: "https://example.com/" }],
};

function encode(message: Record<string, unknown>) {
	if (message.t === "hello") return JSON.stringify({ ...serverHello, ...message });
	if (
		[
			"frame",
			"control",
			"viewport",
			"location",
			"notice",
			"nav-ack",
			"download",
			"file-chooser",
			"file-chooser-closed",
			"input",
			"nav",
			"file-chooser-cancel",
		].includes(String(message.t))
	)
		return JSON.stringify({ ...message, ...tab });
	return JSON.stringify(message);
}

function make_events() {
	return {
		onHello: vi.fn(),
		onFrame: vi.fn(),
		onControl: vi.fn(),
		onViewport: vi.fn(),
		onAck: vi.fn(),
		onWebMessage: vi.fn(),
		onClose: vi.fn(),
	} satisfies files_browser_StreamEvents as unknown as files_browser_StreamEvents & {
		onHello: ReturnType<typeof vi.fn>;
		onFrame: ReturnType<typeof vi.fn>;
		onControl: ReturnType<typeof vi.fn>;
		onViewport: ReturnType<typeof vi.fn>;
		onAck: ReturnType<typeof vi.fn>;
		onWebMessage: ReturnType<typeof vi.fn>;
		onClose: ReturnType<typeof vi.fn>;
	};
}

describe("files_browser_stream_connect", () => {
	test("waits for the selected tab's frame and refuses old tab messages", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(new Blob([new Uint8Array([1])]));
		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(1);
		const next = { tabId: "tab-2", tabGen: 3, viewGen: 2 };
		socket.emit(JSON.stringify({ t: "control", control: "human", controlGen: 2, ...next }));
		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(-1);
		socket.emit(encode({ t: "frame", seq: 2, loadGen: 1 }));
		socket.emit(new Blob([new Uint8Array([2])]));
		socket.emit(
			encode({ t: "file-chooser", chooserId: "old", multiple: false, accept: "", origin: "https://example.com" }),
		);
		expect(events.onFrame).toHaveBeenCalledTimes(1);
		expect(events.onWebMessage).not.toHaveBeenCalled();
		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(-1);
		socket.emit(JSON.stringify({ t: "frame", seq: 3, loadGen: 1, ...next }));
		socket.emit(new Blob([new Uint8Array([3])]));
		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(2);
		expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject(next);
	});

	test("does not accept missing or malformed tab identity", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket,
		});
		socket.readyState = 1;
		for (const identity of [{ tabId: undefined }, { tabGen: 0 }, { tabGen: "1" }, { viewGen: -1 }, { viewGen: 1.5 }])
			socket.emit(JSON.stringify({ ...serverHello, ...identity }));
		expect(events.onHello).not.toHaveBeenCalled();
		expect(handle.sendNav({ action: "reload" })).toBe(-1);
	});
	test("sends the grant hello once the socket opens", () => {
		const socket = make_socket();
		const events = make_events();
		const createSocket = vi.fn(() => socket as never);
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream?ownerId=old-owner",
			hello,
			events,
			createSocket,
		});

		expect(createSocket).toHaveBeenCalledWith(
			"wss://runner.test/viewer/stream?ownerId=owner-1&organizationId=org-1&workspaceId=ws-1",
		);
		expect(socket.binaryType).toBe("blob");
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		socket.onopen?.({} as Event);
		expect(socket.sent).toEqual([
			encode({
				mode: "web",
				ownerId: "owner-1",
				organizationId: "org-1",
				workspaceId: "ws-1",
				grantId: "grant-1",
				host: "docked",
			}),
		]);
	});

	test("routes frames, hello, control, and acks", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));

		const frame = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(frame);
		expect(events.onFrame).toHaveBeenCalledWith(frame);

		socket.emit(encode({ t: "frame", seq: 2, loadGen: 1 }));
		socket.emit(new Uint8Array([4, 5, 6]).buffer);
		expect(events.onFrame).toHaveBeenCalledTimes(2);
		const buffered = events.onFrame.mock.calls[1]?.[0] as Blob;
		expect(buffered).toBeInstanceOf(Blob);
		expect(buffered.type).toBe("image/jpeg");
		expect(socket.sent).toEqual([encode({ t: "frame-ack", seq: 1 }), encode({ t: "frame-ack", seq: 2 })]);

		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "ready", controlGen: 1 }),
		);
		expect(events.onHello).toHaveBeenCalledWith({
			mode: "web",
			...tab,
			viewedTabId: tab.tabId,
			policyRevision: 0,
			tabs: serverHello.tabs,
			viewerId: "v-1",
			viewport: { width: 1280, height: 900 },
			control: "ready",
			controlGen: 1,
		});

		socket.emit(encode({ t: "control", control: "human", controlGen: 2 }));
		expect(events.onControl).toHaveBeenCalledWith({ control: "human", controlGen: 2, ...tab });

		socket.emit(encode({ t: "viewport", viewport: { width: 800, height: 600 } }));
		expect(events.onViewport).toHaveBeenCalledWith({ width: 800, height: 600, ...tab });

		socket.emit(encode({ t: "input-ack", seq: 3, ok: false, code: "denied" }));
		expect(events.onAck).toHaveBeenCalledWith({ seq: 3, ok: false, code: "denied" });
	});

	test("ignores orphan images and invalid frame metadata", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		const frame = new Blob([new Uint8Array([1, 2, 3])]);

		socket.emit(frame);
		socket.emit(new Uint8Array([4, 5, 6]).buffer);
		for (const value of [undefined, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
			socket.emit(encode({ t: "frame", seq: value, loadGen: 1 }));
			socket.emit(frame);
			socket.emit(encode({ t: "frame", seq: 1, loadGen: value }));
			socket.emit(frame);
		}

		expect(events.onFrame).not.toHaveBeenCalled();
		expect(socket.sent).toEqual([]);
	});

	test("requires an image immediately after its metadata", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		const frame = new Blob([new Uint8Array([1, 2, 3])]);

		for (const message of [
			encode({ t: "viewport", viewport: { width: 800, height: 600 } }),
			encode({ t: "control", control: "human", controlGen: 2 }),
			encode({ t: "frame", seq: 2 }),
			encode({ t: "future-message" }),
			"not json",
			42,
		]) {
			socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
			socket.emit(message);
			socket.emit(frame);
		}

		expect(events.onFrame).not.toHaveBeenCalled();
		expect(socket.sent).toEqual([]);
		socket.emit(encode({ t: "frame", seq: 2, loadGen: 1 }));
		socket.emit(encode({ t: "frame", seq: 3, loadGen: 2 }));
		socket.emit(frame);
		socket.emit(frame);
		expect(events.onFrame).toHaveBeenCalledExactlyOnceWith(frame);
		expect(socket.sent).toEqual([encode({ t: "frame-ack", seq: 3 })]);
	});

	test("acknowledges only after the frame callback returns", () => {
		const socket = make_socket();
		const events = make_events();
		const sentDuringFrame: string[][] = [];
		events.onFrame.mockImplementation(() => {
			sentDuringFrame.push([...socket.sent]);
		});
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));

		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(new Blob([new Uint8Array([1, 2, 3])]));

		expect(events.onFrame).toHaveBeenCalledOnce();
		expect(sentDuringFrame).toEqual([[]]);
		expect(socket.sent).toEqual([encode({ t: "frame-ack", seq: 1 })]);
		expect(socket.closed).toBeNull();
	});

	test("acknowledges and closes when the frame callback fails", () => {
		const socket = make_socket();
		const events = make_events();
		events.onFrame.mockImplementation(() => {
			throw new Error("Frame failed");
		});
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));

		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		expect(() => socket.emit(new Blob([new Uint8Array([1, 2, 3])]))).not.toThrow();
		expect(socket.sent).toEqual([encode({ t: "frame-ack", seq: 1 })]);
		expect(socket.closed).toEqual({ code: 1000, reason: "frame failed" });
	});

	test("clears pending frame metadata on either close path", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		const frame = new Blob([new Uint8Array([1, 2, 3])]);

		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.onclose?.({ code: 4408, reason: "grant expired" } as CloseEvent);
		socket.emit(frame);
		socket.emit(encode({ t: "frame", seq: 2, loadGen: 1 }));
		handle.close();
		socket.emit(frame);

		expect(events.onFrame).not.toHaveBeenCalled();
		expect(socket.sent).toEqual([]);
	});

	test("ignores malformed and unknown messages", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});

		socket.emit("not json");
		socket.emit(encode({ t: "future-message", payload: 1 }));
		socket.emit(encode({ t: "control", control: "human" }));
		for (const controlGen of [undefined, 0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
			socket.emit(
				encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "ready", controlGen }),
			);
			socket.emit(encode({ t: "control", control: "human", controlGen }));
		}
		socket.emit(encode({ t: "viewport", viewport: { width: 0, height: 600 } }));
		socket.emit(encode({ t: "viewport" }));
		socket.emit(42);
		expect(events.onHello).not.toHaveBeenCalled();
		expect(events.onControl).not.toHaveBeenCalled();
		expect(events.onViewport).not.toHaveBeenCalled();
		expect(events.onAck).not.toHaveBeenCalled();
		expect(events.onFrame).not.toHaveBeenCalled();
		expect(events.onWebMessage).not.toHaveBeenCalled();
	});

	test("stamps inputs after control and a frame arrive, and drops them while closed", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});

		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(-1);
		expect(socket.sent).toEqual([]);

		socket.readyState = 1;
		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(-1);
		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 2 }),
		);
		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(-1);
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 3 }));
		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(-1);
		socket.emit(new Blob([new Uint8Array([1, 2, 3])]));
		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(1);
		expect(handle.sendInput({ kind: "key.type", text: "hi" })).toBe(2);
		expect(socket.sent).toEqual([
			encode({ t: "frame-ack", seq: 1 }),
			encode({ t: "input", seq: 1, kind: "mouse.move", x: 10, y: 20, controlGen: 2, loadGen: 3 }),
			encode({ t: "input", seq: 2, kind: "key.type", text: "hi", controlGen: 2, loadGen: 3 }),
		]);
		socket.readyState = 3;
		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(-1);
		expect(socket.sent).toHaveLength(3);
	});

	test("keeps sent generations fixed and waits for image bytes before changing loads", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		const frame = new Blob([new Uint8Array([1, 2, 3])]);

		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 1 }),
		);
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(frame);
		handle.sendInput({ kind: "key.press", key: "Enter" });
		socket.emit(encode({ t: "control", control: "human", controlGen: 2 }));
		handle.sendInput({ kind: "key.press", key: "Enter" });
		socket.emit(encode({ t: "frame", seq: 2, loadGen: 2 }));
		handle.sendInput({ kind: "key.press", key: "Enter" });
		socket.emit(frame);
		handle.sendInput({ kind: "key.press", key: "Enter" });
		socket.emit(encode({ t: "frame", seq: 3, loadGen: 3 }));
		socket.emit(encode({ t: "control", control: "human", controlGen: 0 }));
		socket.emit(frame);
		handle.sendInput({ kind: "key.press", key: "Enter" });

		const inputs = socket.sent
			.map((message) => JSON.parse(message) as Record<string, unknown>)
			.filter((message) => message.t === "input");
		expect(inputs).toEqual([
			{ t: "input", seq: 1, kind: "key.press", key: "Enter", controlGen: 1, loadGen: 1, ...tab },
			{ t: "input", seq: 2, kind: "key.press", key: "Enter", controlGen: 2, loadGen: 1, ...tab },
			{ t: "input", seq: 3, kind: "key.press", key: "Enter", controlGen: 2, loadGen: 1, ...tab },
			{ t: "input", seq: 4, kind: "key.press", key: "Enter", controlGen: 2, loadGen: 2, ...tab },
			{ t: "input", seq: 5, kind: "key.press", key: "Enter", controlGen: 2, loadGen: 2, ...tab },
		]);
	});

	test.each(["server", "client"])("clears input generations on %s close", (source) => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));
		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 1 }),
		);
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(new Blob([new Uint8Array([1, 2, 3])]));

		if (source === "server") socket.onclose?.({ code: 4408, reason: "grant expired" } as CloseEvent);
		else handle.close();

		expect(handle.sendInput({ kind: "key.press", key: "Enter" })).toBe(-1);
		expect(socket.sent).toEqual([encode({ t: "frame-ack", seq: 1 })]);
	});

	test("reports close codes and closes cleanly", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});

		socket.onclose?.({ code: 4408, reason: "grant expired" } as CloseEvent);
		expect(events.onClose).toHaveBeenCalledWith({ code: 4408, reason: "grant expired" });

		handle.close();
		expect(socket.closed).toEqual({ code: 1000, reason: "client closed" });
	});

	test("routes the web messages and drops malformed or oversized ones", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));

		const location = {
			t: "location",
			url: "https://example.com/",
			title: "Example",
			loading: false,
			canGoBack: true,
			canGoForward: false,
			...tab,
		};
		socket.emit(encode(location));
		socket.emit(encode({ t: "notice", code: "popup_opened_here" }));
		socket.emit(encode({ t: "nav-ack", seq: 4, ok: false, code: "denied_host" }));
		socket.emit(encode({ t: "nav-ack", seq: 5, ok: true }));
		socket.emit(encode({ t: "agent-access", on: false }));

		socket.emit(encode({ ...location, loading: "no" }));
		socket.emit(encode({ t: "notice" }));
		socket.emit(encode({ t: "nav-ack", seq: "6", ok: true }));
		socket.emit(encode({ t: "agent-access", on: "off" }));
		socket.emit(encode({ ...location, title: "x".repeat(16_384) }));

		expect(events.onWebMessage.mock.calls.map(([message]) => message)).toEqual([
			location,
			{ t: "notice", code: "popup_opened_here", ...tab },
			{ t: "nav-ack", seq: 4, ok: false, code: "denied_host", ...tab },
			{ t: "nav-ack", seq: 5, ok: true, ...tab },
			{ t: "agent-access", on: false },
		]);
	});

	test("routes download and file chooser messages and drops malformed ones", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(encode(serverHello));

		const download = {
			t: "download",
			downloadId: "d-1",
			name: "report.pdf",
			size: 1024,
			contentType: "application/pdf",
			...tab,
		};
		const chooser = {
			t: "file-chooser",
			chooserId: "c-1",
			multiple: true,
			accept: "image/*,.pdf",
			origin: "https://example.com",
			...tab,
		};
		socket.emit(encode(download));
		socket.emit(encode(chooser));
		socket.emit(encode({ t: "file-chooser-closed", chooserId: "c-1" }));

		socket.emit(encode({ ...download, size: "1024" }));
		socket.emit(encode({ ...download, downloadId: undefined }));
		socket.emit(encode({ ...chooser, multiple: "yes" }));
		socket.emit(encode({ ...chooser, accept: null }));
		socket.emit(encode({ t: "file-chooser-closed", chooserId: 1 }));

		expect(events.onWebMessage.mock.calls.map(([message]) => message)).toEqual([
			download,
			chooser,
			{ t: "file-chooser-closed", chooserId: "c-1", ...tab },
		]);
	});

	test("sends a file chooser cancel only after control arrives", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;

		expect(handle.sendFileChooserCancel("c-1")).toBe(false);
		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 2 }),
		);
		expect(handle.sendFileChooserCancel("c-1")).toBe(true);
		socket.readyState = 3;
		expect(handle.sendFileChooserCancel("c-2")).toBe(false);

		expect(socket.sent).toEqual([encode({ t: "file-chooser-cancel", chooserId: "c-1" })]);
	});

	test("sends nav after control without waiting for a frame, and shares the input sequence", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;

		expect(handle.sendNav({ action: "back" })).toBe(-1);
		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 2 }),
		);
		expect(handle.sendNav({ action: "go", url: "https://example.com/" })).toBe(1);
		socket.emit(encode({ t: "frame", seq: 1, loadGen: 1 }));
		socket.emit(new Blob([new Uint8Array([1])]));
		expect(handle.sendInput({ kind: "text.insert", text: "hello" })).toBe(2);
		expect(handle.sendNav({ action: "reload" })).toBe(3);

		expect(socket.sent.filter((message) => !message.includes("frame-ack"))).toEqual([
			encode({ t: "nav", seq: 1, controlGen: 2, action: "go", url: "https://example.com/" }),
			encode({ t: "input", seq: 2, kind: "text.insert", text: "hello", controlGen: 2, loadGen: 1 }),
			encode({ t: "nav", seq: 3, controlGen: 2, action: "reload" }),
		]);
	});

	test("never sends a message over the runner's size cap", () => {
		const socket = make_socket();
		const events = make_events();
		const handle = files_browser_stream_connect({
			url: "wss://runner.test/viewer/stream",
			hello,
			events,
			createSocket: () => socket as never,
		});
		socket.readyState = 1;
		socket.emit(
			encode({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "human", controlGen: 1 }),
		);

		expect(handle.sendNav({ action: "go", url: `https://example.com/${"a".repeat(16_384)}` })).toBe(-1);
		expect(handle.sendNav({ action: "stop" })).toBe(1);
		expect(socket.sent).toEqual([encode({ t: "nav", seq: 1, controlGen: 1, action: "stop" })]);
	});
});
