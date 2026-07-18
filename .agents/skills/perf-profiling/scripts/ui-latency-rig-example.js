// Playwriter script — TEMPLATE, adapt the marked parts to your app.
// Arms an in-page timing rig that records product latency without including Playwright wait overhead:
// - capture-phase listeners timestamp the user action (performance.now)
// - WebSocket.prototype.send patch timestamps outgoing mutation frames
// - MutationObserver timestamps when the awaited DOM state appears
// - CDP Network.webSocketFrame* events time the network legs (monotonic seconds);
//   align that clock with performance.now via the shared send event.
// After arming: perform the interaction, then read window.__t / window.__ws / state.frames.
if (typeof state.cleanupLatencyRig === "function") {
	await state.cleanupLatencyRig();
}

await state.page.evaluate(() => {
	window.__latencyRigCleanup?.();
	window.__t = {};
	window.__ws = [];
	const originalSend = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data) {
		try {
			// ADAPT: match your mutation names
			if (typeof data === "string" && data.includes("create_folder_node")) {
				window.__ws.push({ at: performance.now(), head: data.slice(0, 90) });
			}
		} catch {}
		return originalSend.call(this, data);
	};

	const clickListener = (event) => {
		// ADAPT: the button that starts the interaction
		if (event.target && event.target.closest && event.target.closest('button[aria-label="New folder"]')) {
			window.__t = { clickAt: performance.now() };
			window.__ws = [];
		}
	};
	document.addEventListener("click", clickListener, true);

	const observer = new MutationObserver(() => {
		const timing = window.__t;
		if (!timing.clickAt) return;
		// ADAPT: the DOM state that means "done" from the user's point of view
		if (!timing.rowAt && document.querySelector('[aria-label="Add folder to new-folder-1"]')) {
			timing.rowAt = performance.now();
		}
	});
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });

	window.__latencyRigCleanup = () => {
		WebSocket.prototype.send = originalSend;
		document.removeEventListener("click", clickListener, true);
		observer.disconnect();
		delete window.__latencyRigCleanup;
	};
});

state.frames = [];
state.cdp = await getCDPSession({ page: state.page });
await state.cdp.send("Network.enable");
state.onSent = (e) => {
	const d = e.response.payloadData || "";
	// ADAPT: match your mutation names
	if (d.includes("create_folder_node")) {
		state.frames.push({ dir: "sent", ts: e.timestamp, data: d.slice(0, 200) });
	}
};
state.onRecv = (e) => {
	const d = e.response.payloadData || "";
	let type = "?";
	try {
		const parsed = JSON.parse(d);
		type = parsed.type || "?";
	} catch {}
	state.frames.push({ dir: "recv", ts: e.timestamp, type, size: d.length, head: d.slice(0, 120) });
};
state.cdp.on("Network.webSocketFrameSent", state.onSent);
state.cdp.on("Network.webSocketFrameReceived", state.onRecv);
state.cleanupLatencyRig = async () => {
	state.cdp?.off("Network.webSocketFrameSent", state.onSent);
	state.cdp?.off("Network.webSocketFrameReceived", state.onRecv);
	await state.cdp?.detach().catch(() => undefined);
	await state.page.evaluate(() => window.__latencyRigCleanup?.()).catch(() => undefined);
	state.cdp = undefined;
	state.onSent = undefined;
	state.onRecv = undefined;
};
console.log("armed");
