import { file_preview_create_document, file_preview_DocumentMessageSchema } from "./document";
import {
	file_preview_HostMessageSchema,
	file_preview_ProtocolName,
	file_preview_ProtocolVersion,
	type file_preview_RuntimeMessage,
} from "./protocol";
import "./style.css";

declare const __FILE_PREVIEW_PARENT_ORIGINS__: string[];

let parentOrigin: string | null = null;
let sessionId: string | null = null;
let currentLoadId: string | null = null;
let currentFrame: HTMLIFrameElement | null = null;
let loadFailed = false;

function send(message: file_preview_RuntimeMessage) {
	if (parentOrigin) window.parent.postMessage(message, parentOrigin);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
	if (event.source === window.parent && __FILE_PREVIEW_PARENT_ORIGINS__.includes(event.origin)) {
		const result = file_preview_HostMessageSchema.safeParse(event.data);
		if (!result.success) return;
		const message = result.data;
		if (message.type === "hello") {
			// The first hello binds the session and parent origin for this frame's whole life.
			if (sessionId !== null && (sessionId !== message.sessionId || parentOrigin !== event.origin)) return;
			parentOrigin = event.origin;
			sessionId = message.sessionId;
			send({ protocol: file_preview_ProtocolName, version: file_preview_ProtocolVersion, type: "ready", sessionId });
			return;
		}
		if (message.sessionId !== sessionId || event.origin !== parentOrigin || message.loadId === currentLoadId) return;
		currentLoadId = message.loadId;
		loadFailed = false;
		currentFrame?.remove();
		currentFrame = null;
		try {
			const frame = document.createElement("iframe");
			frame.title = "HTML preview document";
			// allow-same-origin stays off so the untrusted document keeps an opaque origin.
			frame.sandbox.add("allow-scripts");
			frame.referrerPolicy = "no-referrer";
			frame.srcdoc = file_preview_create_document(message.html, message.loadId, window.location.origin);
			currentFrame = frame;
			document.body.replaceChildren(frame);
		} catch {
			loadFailed = true;
			send({
				protocol: file_preview_ProtocolName,
				version: file_preview_ProtocolVersion,
				type: "error",
				sessionId,
				loadId: currentLoadId,
				message: "The HTML preview could not open.",
			});
		}
		return;
	}

	// A sandboxed frame has no real origin, so its messages arrive with origin "null".
	if (event.source !== currentFrame?.contentWindow || event.origin !== "null" || !sessionId) return;
	const result = file_preview_DocumentMessageSchema.safeParse(event.data);
	if (!result.success || result.data.loadId !== currentLoadId) return;
	const message = result.data;
	// An error is terminal for this load: a late "loaded" must not overwrite it.
	if (message.type === "loaded" && loadFailed) return;
	if (message.type === "error") loadFailed = true;
	send({
		protocol: file_preview_ProtocolName,
		version: file_preview_ProtocolVersion,
		sessionId,
		loadId: message.loadId,
		...(message.type === "error" ? { type: "error", message: message.message } : { type: "loaded" }),
	});
});
