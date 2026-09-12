import { defaultTreeAdapter, html, parse, serializeOuter } from "parse5";
import { z } from "zod";
import { file_preview_MaxErrorLength } from "./protocol";

const documentProtocol = "bonobo-file-preview-document";

export const file_preview_DocumentMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({ protocol: z.literal(documentProtocol), type: z.literal("loaded"), loadId: z.uuid() }),
	z.strictObject({
		protocol: z.literal(documentProtocol),
		type: z.literal("error"),
		loadId: z.uuid(),
		message: z.string().min(1).max(file_preview_MaxErrorLength),
	}),
]);

export function file_preview_create_document(source: string, loadId: string, runtimeOrigin: string) {
	const document = parse(source, { scriptingEnabled: true, sourceCodeLocationInfo: true });
	const root = document.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "html");
	const head =
		root && defaultTreeAdapter.isElementNode(root)
			? root.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "head")
			: undefined;
	if (!head || !defaultTreeAdapter.isElementNode(head)) throw new Error("HTML document has no head.");

	const relay = defaultTreeAdapter.createElement("script", html.NS.HTML, []);
	// Keep relay names local. A file may use the same names in its classic scripts.
	const relayConfig = JSON.stringify({
		protocol: documentProtocol,
		loadId,
		runtimeOrigin,
		maxErrorLength: file_preview_MaxErrorLength,
		// Escape "<" so a "</script>" inside the JSON cannot break out of the relay script.
	}).replaceAll("<", "\\u003c");
	defaultTreeAdapter.insertText(
		relay,
		`(() => {
		const config = ${relayConfig};
		const postStatus = window.parent.postMessage.bind(window.parent);
		const send = (status) => postStatus({ protocol: config.protocol, loadId: config.loadId, ...status }, config.runtimeOrigin);
		const report = (message) => send({ type: "error", message: message.slice(0, config.maxErrorLength) || "Preview script failed." });
		addEventListener("load", () => send({ type: "loaded" }), { once: true });
		addEventListener("error", (event) => {
			if (event instanceof ErrorEvent) report(event.message || "Preview script failed.");
			else report("A preview resource could not load.");
		}, true);
		addEventListener("unhandledrejection", (event) => {
			const reason = event.reason;
			report(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Preview promise failed.");
		});
	})();`,
	);
	const referrer = defaultTreeAdapter.createElement("meta", html.NS.HTML, [
		{ name: "name", value: "referrer" },
		{ name: "content", value: "no-referrer" },
	]);
	// Both elements go before the head's first child so the relay's listeners precede file scripts.
	const firstChild = head.childNodes[0];
	if (firstChild) {
		defaultTreeAdapter.insertBefore(head, relay, firstChild);
		defaultTreeAdapter.insertBefore(head, referrer, firstChild);
	} else {
		defaultTreeAdapter.appendChild(head, relay);
		defaultTreeAdapter.appendChild(head, referrer);
	}

	return document.childNodes
		.map((node) => {
			if (defaultTreeAdapter.isDocumentTypeNode(node)) {
				// parse5 serialization drops PUBLIC/SYSTEM IDs, which can change the browser's layout mode.
				const location = defaultTreeAdapter.getNodeSourceCodeLocation(node)!;
				return source.slice(location.startOffset, location.endOffset);
			}
			return serializeOuter(node);
		})
		.join("");
}
