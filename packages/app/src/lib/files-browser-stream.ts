// App side of the runner viewer socket. The component mints a single-use grant through Convex,
// opens this stream, and shows JPEG frames. Human input flows only while the server confirms
// the viewer holds input; the socket never carries provider credentials.

export type files_browser_StreamHost = "docked" | "detached";

export type files_browser_StreamHello = {
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	grantId: string;
	host: files_browser_StreamHost;
};

export type files_browser_StreamInput =
	| { kind: "mouse.move"; x: number; y: number }
	| { kind: "mouse.click"; x: number; y: number; button?: "left" | "middle" | "right" }
	| { kind: "mouse.down" | "mouse.up"; button?: "left" | "middle" | "right"; clickCount?: number }
	| { kind: "wheel"; x: number; y: number; dx: number; dy: number }
	| { kind: "key.press" | "key.down" | "key.up"; key: string }
	| { kind: "key.type"; text: string };

export type files_browser_StreamHelloMessage = {
	viewerId: string;
	viewport: { width: number; height: number };
	control: string;
	controlGen: number;
};

export type files_browser_StreamControlMessage = {
	control: string;
	controlGen: number;
};

export type files_browser_StreamViewportMessage = {
	width: number;
	height: number;
};

export type files_browser_StreamAckMessage = {
	seq: number;
	ok: boolean;
	code?: string;
};

export type files_browser_StreamCloseMessage = {
	code: number;
	reason: string;
};

export type files_browser_StreamEvents = {
	onHello: (hello: files_browser_StreamHelloMessage) => void;
	onFrame: (frame: Blob) => void;
	onControl: (control: files_browser_StreamControlMessage) => void;
	onViewport: (viewport: files_browser_StreamViewportMessage) => void;
	onAck: (ack: files_browser_StreamAckMessage) => void;
	onClose: (close: files_browser_StreamCloseMessage) => void;
};

export type files_browser_StreamHandle = {
	/**
	 * Send one input message. Returns its sequence number, or -1 when the socket is not
	 * open and the input was dropped. The caller gates input on hello plus human control.
	 */
	sendInput: (input: files_browser_StreamInput) => number;
	close: () => void;
};

type files_browser_Socket = Pick<WebSocket, "binaryType" | "readyState" | "send" | "close"> & {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
};

// Numeric WebSocket.OPEN. The module reads no other WebSocket global so unit tests can inject
// a fake socket in runtimes without one.
const WEBSOCKET_OPEN = 1;

function is_record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse_hello(value: unknown): files_browser_StreamHelloMessage | null {
	if (!is_record(value) || value.t !== "hello") {
		return null;
	}
	if (
		typeof value.viewerId !== "string" ||
		typeof value.control !== "string" ||
		typeof value.controlGen !== "number" ||
		!Number.isInteger(value.controlGen) ||
		value.controlGen <= 0
	) {
		return null;
	}
	const viewport = value.viewport;
	if (
		!is_record(viewport) ||
		typeof viewport.width !== "number" ||
		typeof viewport.height !== "number"
	) {
		return null;
	}
	return { viewerId: value.viewerId, viewport: { width: viewport.width, height: viewport.height }, control: value.control, controlGen: value.controlGen };
}

function parse_control(value: unknown): files_browser_StreamControlMessage | null {
	if (!is_record(value) || value.t !== "control") {
		return null;
	}
	if (
		typeof value.control !== "string" ||
		typeof value.controlGen !== "number" ||
		!Number.isInteger(value.controlGen) ||
		value.controlGen <= 0
	) {
		return null;
	}
	return { control: value.control, controlGen: value.controlGen };
}

function parse_viewport(value: unknown): files_browser_StreamViewportMessage | null {
	if (!is_record(value) || value.t !== "viewport") {
		return null;
	}
	const viewport = value.viewport;
	if (
		!is_record(viewport) ||
		typeof viewport.width !== "number" ||
		typeof viewport.height !== "number" ||
		viewport.width <= 0 ||
		viewport.height <= 0
	) {
		return null;
	}
	return { width: viewport.width, height: viewport.height };
}

function parse_ack(value: unknown): files_browser_StreamAckMessage | null {
	if (!is_record(value) || value.t !== "input-ack") {
		return null;
	}
	if (typeof value.seq !== "number" || typeof value.ok !== "boolean") {
		return null;
	}
	return { seq: value.seq, ok: value.ok, ...(typeof value.code === "string" ? { code: value.code } : {}) };
}

export function files_browser_stream_connect(args: {
	url: string;
	hello: files_browser_StreamHello;
	events: files_browser_StreamEvents;
	createSocket?: (url: string) => files_browser_Socket;
}): files_browser_StreamHandle {
	const socket = args.createSocket ? args.createSocket(args.url) : new WebSocket(args.url);
	socket.binaryType = "blob";
	let seq = 0;

	socket.onopen = () => {
		socket.send(
			JSON.stringify({
				ownerId: args.hello.ownerId,
				organizationId: args.hello.organizationId,
				workspaceId: args.hello.workspaceId,
				grantId: args.hello.grantId,
				host: args.hello.host,
			}),
		);
	};

	socket.onmessage = (event: MessageEvent) => {
		const data: unknown = event.data;
		if (data instanceof Blob) {
			args.events.onFrame(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			args.events.onFrame(new Blob([data], { type: "image/jpeg" }));
			return;
		}
		if (typeof data !== "string") {
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(data) as unknown;
		} catch {
			return;
		}
		const hello = parse_hello(value);
		if (hello) {
			args.events.onHello(hello);
			return;
		}
		const control = parse_control(value);
		if (control) {
			args.events.onControl(control);
			return;
		}
		const ack = parse_ack(value);
		if (ack) {
			args.events.onAck(ack);
			return;
		}
		const viewport = parse_viewport(value);
		if (viewport) {
			args.events.onViewport(viewport);
		}
		// Unknown message types are ignored so the server can add new ones.
	};

	socket.onclose = (event: CloseEvent) => {
		args.events.onClose({ code: event.code, reason: event.reason });
	};

	// A socket error is always followed by close, which carries the terminal state.
	socket.onerror = () => {};

	return {
		sendInput: (input) => {
			if (socket.readyState !== WEBSOCKET_OPEN) {
				return -1;
			}
			seq += 1;
			socket.send(JSON.stringify({ t: "input", seq, ...input }));
			return seq;
		},
		close: () => {
			socket.close(1000, "client closed");
		},
	};
}
