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
	| { kind: "key.type"; text: string }
	| { kind: "text.insert"; text: string };

/**
 * One address bar action. Web mode only, and only while this viewer holds control.
 */
export type files_browser_StreamNav = { action: "go"; url: string } | { action: "back" | "forward" | "reload" | "stop" };

/**
 * Messages the runner sends only for a web session.
 */
export type files_browser_StreamWebMessage =
	| { t: "location"; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
	| { t: "notice"; code: string }
	| { t: "nav-ack"; seq: number; ok: boolean; code?: string }
	| { t: "agent-access"; on: boolean }
	/**
	 * A human download is held in the runner. The app saves it to Files with this id.
	 */
	| { t: "download"; downloadId: string; name: string; size: number; contentType: string }
	/**
	 * The page opened a file dialog. `accept` is the input's raw `accept` text, `origin` the frame origin.
	 */
	| { t: "file-chooser"; chooserId: string; multiple: boolean; accept: string; origin: string }
	| { t: "file-chooser-closed"; chooserId: string };

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
	onWebMessage: (message: files_browser_StreamWebMessage) => void;
	onClose: (close: files_browser_StreamCloseMessage) => void;
};

export type files_browser_StreamHandle = {
	/**
	 * Send one input message. Returns its sequence number, or -1 until the socket is open
	 * and control plus a frame have arrived. The caller also gates input on human control.
	 */
	sendInput: (input: files_browser_StreamInput) => number;
	/**
	 * Send one address bar action. Returns its sequence number, or -1 until the socket is open
	 * and control has arrived. The `nav-ack` web message carries the same number.
	 */
	sendNav: (nav: files_browser_StreamNav) => number;
	/**
	 * Tell the page its file dialog was closed without a file. The runner accepts it only from the
	 * viewer that holds human control. Returns false until the socket is open and control has arrived.
	 */
	sendFileChooserCancel: (chooserId: string) => boolean;
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

// The runner refuses longer text messages in both directions.
const MESSAGE_MAX_CHARS = 16_384;

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
		!Number.isSafeInteger(value.controlGen) ||
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
		!Number.isSafeInteger(value.controlGen) ||
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

function parse_web_message(value: unknown): files_browser_StreamWebMessage | null {
	if (!is_record(value)) {
		return null;
	}
	switch (value.t) {
		case "location":
			if (
				typeof value.url !== "string" ||
				typeof value.title !== "string" ||
				typeof value.loading !== "boolean" ||
				typeof value.canGoBack !== "boolean" ||
				typeof value.canGoForward !== "boolean"
			) {
				return null;
			}
			return {
				t: "location",
				url: value.url,
				title: value.title,
				loading: value.loading,
				canGoBack: value.canGoBack,
				canGoForward: value.canGoForward,
			};
		case "notice":
			return typeof value.code === "string" ? { t: "notice", code: value.code } : null;
		case "nav-ack":
			if (typeof value.seq !== "number" || typeof value.ok !== "boolean") {
				return null;
			}
			return {
				t: "nav-ack",
				seq: value.seq,
				ok: value.ok,
				...(typeof value.code === "string" ? { code: value.code } : {}),
			};
		case "agent-access":
			return typeof value.on === "boolean" ? { t: "agent-access", on: value.on } : null;
		case "download":
			if (
				typeof value.downloadId !== "string" ||
				typeof value.name !== "string" ||
				typeof value.size !== "number" ||
				typeof value.contentType !== "string"
			) {
				return null;
			}
			return {
				t: "download",
				downloadId: value.downloadId,
				name: value.name,
				size: value.size,
				contentType: value.contentType,
			};
		case "file-chooser":
			if (
				typeof value.chooserId !== "string" ||
				typeof value.multiple !== "boolean" ||
				typeof value.accept !== "string" ||
				typeof value.origin !== "string"
			) {
				return null;
			}
			return {
				t: "file-chooser",
				chooserId: value.chooserId,
				multiple: value.multiple,
				accept: value.accept,
				origin: value.origin,
			};
		case "file-chooser-closed":
			return typeof value.chooserId === "string" ? { t: "file-chooser-closed", chooserId: value.chooserId } : null;
		default:
			return null;
	}
}

export function files_browser_stream_connect(args: {
	url: string;
	hello: files_browser_StreamHello;
	events: files_browser_StreamEvents;
	createSocket?: (url: string) => files_browser_Socket;
}): files_browser_StreamHandle {
	const url = new URL(args.url);
	url.searchParams.set("ownerId", args.hello.ownerId);
	url.searchParams.set("organizationId", args.hello.organizationId);
	url.searchParams.set("workspaceId", args.hello.workspaceId);
	const socket = args.createSocket ? args.createSocket(url.toString()) : new WebSocket(url.toString());
	socket.binaryType = "blob";
	let seq = 0;
	let controlGen: number | null = null;
	let loadGen: number | null = null;
	let pendingFrame: { seq: number; loadGen: number } | null = null;

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
		const frame = pendingFrame;
		// The frame bytes must be the next message after their metadata.
		pendingFrame = null;
		if (data instanceof Blob || data instanceof ArrayBuffer) {
			if (frame === null) {
				return;
			}
			let frameFailed = false;
			try {
				// Metadata alone must not rebind input to a load whose image has not arrived.
				loadGen = frame.loadGen;
				args.events.onFrame(data instanceof Blob ? data : new Blob([data], { type: "image/jpeg" }));
			} catch {
				frameFailed = true;
			}
			// ACK delivery after the callback. Image decoding and paint happen later.
			if (socket.readyState === WEBSOCKET_OPEN) {
				socket.send(JSON.stringify({ t: "frame-ack", seq: frame.seq }));
			}
			if (frameFailed) {
				loadGen = null;
				socket.close(1000, "frame failed");
			}
			return;
		}
		if (typeof data !== "string" || data.length > MESSAGE_MAX_CHARS) {
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(data) as unknown;
		} catch {
			return;
		}
		if (
			is_record(value) &&
			value.t === "frame" &&
			typeof value.seq === "number" &&
			Number.isSafeInteger(value.seq) &&
			value.seq > 0 &&
			typeof value.loadGen === "number" &&
			Number.isSafeInteger(value.loadGen) &&
			value.loadGen > 0
		) {
			pendingFrame = { seq: value.seq, loadGen: value.loadGen };
			return;
		}
		const hello = parse_hello(value);
		if (hello) {
			controlGen = hello.controlGen;
			args.events.onHello(hello);
			return;
		}
		const control = parse_control(value);
		if (control) {
			controlGen = control.controlGen;
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
			return;
		}
		const webMessage = parse_web_message(value);
		if (webMessage) {
			args.events.onWebMessage(webMessage);
		}
		// Unknown message types are ignored so the server can add new ones.
	};

	socket.onclose = (event: CloseEvent) => {
		pendingFrame = null;
		controlGen = null;
		loadGen = null;
		args.events.onClose({ code: event.code, reason: event.reason });
	};

	// A socket error is always followed by close, which carries the terminal state.
	socket.onerror = () => {};

	// Send one numbered message. A message over the runner's size cap is never sent.
	const send_numbered = (message: Record<string, unknown> & { seq: number }) => {
		const text = JSON.stringify(message);
		if (text.length > MESSAGE_MAX_CHARS) {
			return -1;
		}
		seq = message.seq;
		socket.send(text);
		return seq;
	};

	return {
		sendInput: (input) => {
			if (socket.readyState !== WEBSOCKET_OPEN || controlGen === null || loadGen === null) {
				return -1;
			}
			return send_numbered({ t: "input", seq: seq + 1, ...input, controlGen, loadGen });
		},
		sendNav: (nav) => {
			// Navigation does not depend on the image on screen, so it needs only control.
			if (socket.readyState !== WEBSOCKET_OPEN || controlGen === null) {
				return -1;
			}
			return send_numbered({ t: "nav", seq: seq + 1, controlGen, ...nav });
		},
		sendFileChooserCancel: (chooserId) => {
			if (socket.readyState !== WEBSOCKET_OPEN || controlGen === null) {
				return false;
			}
			socket.send(JSON.stringify({ t: "file-chooser-cancel", chooserId }));
			return true;
		},
		close: () => {
			pendingFrame = null;
			controlGen = null;
			loadGen = null;
			socket.close(1000, "client closed");
		},
	};
}
