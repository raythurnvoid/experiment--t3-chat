import { describe, expect, test, vi } from "vitest";
import {
	files_browser_stream_connect,
	type files_browser_StreamEvents,
	type files_browser_StreamHello,
} from "./files-browser-stream.ts";

type FakeSocket = {
	binaryType: string;
	readyState: number;
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
		binaryType: "",
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
	ownerId: "owner-1",
	organizationId: "org-1",
	workspaceId: "ws-1",
	grantId: "grant-1",
	host: "docked",
};

function make_events() {
	return {
		onHello: vi.fn(),
		onFrame: vi.fn(),
		onControl: vi.fn(),
		onViewport: vi.fn(),
		onAck: vi.fn(),
		onClose: vi.fn(),
	} satisfies files_browser_StreamEvents as unknown as files_browser_StreamEvents & {
		onHello: ReturnType<typeof vi.fn>;
		onFrame: ReturnType<typeof vi.fn>;
		onControl: ReturnType<typeof vi.fn>;
		onViewport: ReturnType<typeof vi.fn>;
		onAck: ReturnType<typeof vi.fn>;
		onClose: ReturnType<typeof vi.fn>;
	};
}

describe("files_browser_stream_connect", () => {
	test("sends the grant hello once the socket opens", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({ url: "wss://runner.test/viewer/stream", hello, events, createSocket: () => socket as never });

		expect(socket.binaryType).toBe("blob");
		socket.readyState = 1;
		socket.onopen?.({} as Event);
		expect(socket.sent).toEqual([
			JSON.stringify({
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
		files_browser_stream_connect({ url: "wss://runner.test/viewer/stream", hello, events, createSocket: () => socket as never });

		const frame = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
		socket.emit(frame);
		expect(events.onFrame).toHaveBeenCalledWith(frame);

		socket.emit(new Uint8Array([4, 5, 6]).buffer);
		expect(events.onFrame).toHaveBeenCalledTimes(2);
		const buffered = events.onFrame.mock.calls[1]?.[0] as Blob;
		expect(buffered).toBeInstanceOf(Blob);
		expect(buffered.type).toBe("image/jpeg");

		socket.emit(
			JSON.stringify({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "ready", controlGen: 1 }),
		);
		expect(events.onHello).toHaveBeenCalledWith({
			viewerId: "v-1",
			viewport: { width: 1280, height: 900 },
			control: "ready",
			controlGen: 1,
		});

		socket.emit(JSON.stringify({ t: "control", control: "human", controlGen: 2 }));
		expect(events.onControl).toHaveBeenCalledWith({ control: "human", controlGen: 2 });

		socket.emit(JSON.stringify({ t: "viewport", viewport: { width: 800, height: 600 } }));
		expect(events.onViewport).toHaveBeenCalledWith({ width: 800, height: 600 });

		socket.emit(JSON.stringify({ t: "input-ack", seq: 3, ok: false, code: "denied" }));
		expect(events.onAck).toHaveBeenCalledWith({ seq: 3, ok: false, code: "denied" });
	});

	test("ignores malformed and unknown messages", () => {
		const socket = make_socket();
		const events = make_events();
		files_browser_stream_connect({ url: "wss://runner.test/viewer/stream", hello, events, createSocket: () => socket as never });

		socket.emit("not json");
		socket.emit(JSON.stringify({ t: "future-message", payload: 1 }));
		socket.emit(JSON.stringify({ t: "control", control: "human" }));
		for (const controlGen of [undefined, 0, -1, 1.5, "2"]) {
			socket.emit(JSON.stringify({ t: "hello", viewerId: "v-1", viewport: { width: 1280, height: 900 }, control: "ready", controlGen }));
			socket.emit(JSON.stringify({ t: "control", control: "human", controlGen }));
		}
		socket.emit(JSON.stringify({ t: "viewport", viewport: { width: 0, height: 600 } }));
		socket.emit(JSON.stringify({ t: "viewport" }));
		socket.emit(42);
		expect(events.onHello).not.toHaveBeenCalled();
		expect(events.onControl).not.toHaveBeenCalled();
		expect(events.onViewport).not.toHaveBeenCalled();
		expect(events.onAck).not.toHaveBeenCalled();
		expect(events.onFrame).not.toHaveBeenCalled();
	});

	test("numbers inputs and drops them while closed", () => {
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
		expect(handle.sendInput({ kind: "mouse.move", x: 10, y: 20 })).toBe(1);
		expect(handle.sendInput({ kind: "key.type", text: "hi" })).toBe(2);
		expect(socket.sent).toEqual([
			JSON.stringify({ t: "input", seq: 1, kind: "mouse.move", x: 10, y: 20 }),
			JSON.stringify({ t: "input", seq: 2, kind: "key.type", text: "hi" }),
		]);
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
});
