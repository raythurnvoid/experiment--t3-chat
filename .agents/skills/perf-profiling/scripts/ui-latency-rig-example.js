// Playwriter script — TEMPLATE, adapt the marked parts to your app.
// Arms an in-page timing rig that survives tab backgrounding (Playwright waits don't):
// - capture-phase listeners timestamp the user action (performance.now)
// - WebSocket.prototype.send patch timestamps outgoing mutation frames
// - MutationObserver timestamps when the awaited DOM state appears
// - CDP Network.webSocketFrame* events time the network legs (monotonic seconds);
//   align that clock with performance.now via the shared send event.
// After arming: perform the interaction, then read window.__t / window.__ws / state.frames.
await state.page.evaluate(() => {
	window.__t = {};
	window.__ws = [];
	if (!window.__wsPatched) {
		window.__wsPatched = true;
		const orig = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			try {
				// ADAPT: match your mutation names
				if (typeof data === "string" && data.includes("create_folder_node")) {
					window.__ws.push({ at: performance.now(), head: data.slice(0, 90) });
				}
			} catch {}
			return orig.call(this, data);
		};
	}
	if (!window.__listenersInstalled) {
		window.__listenersInstalled = true;
		document.addEventListener(
			"click",
			(e) => {
				// ADAPT: the button that starts the interaction
				if (e.target && e.target.closest && e.target.closest('button[aria-label="New folder"]')) {
					window.__t = { clickAt: performance.now() };
					window.__ws = [];
				}
			},
			true,
		);
	}
	if (!window.__mo) {
		window.__mo = new MutationObserver(() => {
			const t = window.__t;
			if (!t.clickAt) return;
			// ADAPT: the DOM state that means "done" from the user's point of view
			if (!t.rowAt && document.querySelector('[aria-label="Add folder to new-folder-1"]')) {
				t.rowAt = performance.now();
			}
		});
		window.__mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
	}
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
console.log("armed");
