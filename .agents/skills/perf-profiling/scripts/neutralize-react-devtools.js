// Playwriter script (run with: vp env exec pnpx playwriter -s N -f this-file.js)
// Stubs the React DevTools extension hook before page scripts run, then reloads.
// Use before any render-latency measurement or CPU profile: the real hook walks
// every fiber on commit and pollutes profiles (shows up as huge `get scrollX` self time).
// Generic — works on any React app. Adapt only the waitForSelector to your app's ready signal.
await state.page.addInitScript(() => {
	const stub = {
		isDisabled: true,
		supportsFiber: true,
		supportsFlight: false,
		renderers: new Map(),
		inject() {
			return 0;
		},
		onCommitFiberRoot() {},
		onCommitFiberUnmount() {},
		onPostCommitFiberRoot() {},
		onScheduleFiberRoot() {},
		checkDCE() {},
		sub() {
			return () => {};
		},
		emit() {},
		on() {},
		off() {},
	};
	try {
		Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
			configurable: false,
			get: () => stub,
			set: () => {},
		});
	} catch {}
});
await state.page.reload({ waitUntil: "domcontentloaded" });
// Adapt: wait for an element that means the app is interactive.
await state.page.waitForSelector("body", { timeout: 45000 });
const hookCheck = await state.page.evaluate(
	() => window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.isDisabled === true,
);
console.log("devtools hook neutralized:", hookCheck, "url:", state.page.url());
