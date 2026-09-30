import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { Window } from "../../app/node_modules/happy-dom/lib/index.js";
import { PLAYWRITER_EXECUTOR_JS, PLAYWRITER_EXECUTOR_REVISION } from "./playwriter-executor";
import { browser_web_url_host_matches } from "common/browser-web-url.ts";

function make_executor(
	iframeCount = 0,
	world = "utility",
	childUrl?: string,
	grandchildUrl?: string,
	mainUrl = "https://fixture.test/",
) {
	const send = vi.fn(async () => ({ data: "image" }));
	const detach = vi.fn(async () => {});
	const grandchild = {
		_guid: "grandchild",
		url: () => grandchildUrl!,
		childFrames: () => [],
		parentFrame: () => child as object | null,
	};
	const child = {
		_guid: "child",
		url: () => childUrl!,
		childFrames: () => (grandchildUrl ? [grandchild] : []),
		parentFrame: () => frame as object | null,
	};
	const frame = {
		_guid: "frame",
		url: () => mainUrl,
		childFrames: () => (childUrl ? [child] : []),
		parentFrame: () => null as object | null,
	};
	const utility = {
		world,
		frame: {} as object,
		injectedScript: vi.fn(async () => ({})),
		evaluate: vi.fn(async (code: () => unknown) =>
			code.toString().includes("const fields")
				? { text: "Fixture", accessibility: "button Click", fields: [], iframeCount }
				: iframeCount,
		),
	};
	const server = { _utilityContext: async () => utility };
	utility.frame = server;
	const childUtility = { ...utility, frame: {} as object, evaluate: vi.fn(async () => (grandchildUrl ? 1 : 0)) };
	const childServer = { _utilityContext: vi.fn(async () => childUtility) };
	childUtility.frame = childServer;
	const grandchildUtility = { ...utility, frame: {} as object, evaluate: vi.fn(async () => 0) };
	const grandchildServer = { _utilityContext: vi.fn(async () => grandchildUtility) };
	grandchildUtility.frame = grandchildServer;
	const page = {
		_guid: "page",
		_connection: {
			_objects: new Map<string, object>(),
			toImpl: (value: object) =>
				value === frame ? server : value === child ? childServer : value === grandchild ? grandchildServer : {},
		},
		frames: () => (childUrl ? (grandchildUrl ? [frame, child, grandchild] : [frame, child]) : [frame]),
		mainFrame: () => frame,
		url: () => mainUrl,
		title: async () => "Fixture",
		on: vi.fn(),
		setDefaultTimeout: vi.fn(),
	};
	page._connection._objects.set("page", page);
	page._connection._objects.set("frame", frame);
	if (childUrl) page._connection._objects.set("child", child);
	if (grandchildUrl) page._connection._objects.set("grandchild", grandchild);
	const context = { pages: () => [page], newCDPSession: vi.fn(async () => ({ send, detach })) };
	const browser = { contexts: () => [context], close: vi.fn(async () => {}) };
	const connect = vi.fn(async () => browser);
	const source = PLAYWRITER_EXECUTOR_JS.replace(/^import .*;\r?\n/gm, "").replace(
		"export default class",
		"return class",
	);
	const Executor = new Function("WorkerEntrypoint", "connect", "browser_web_url_host_matches", source)(
		class {},
		connect,
		browser_web_url_host_matches,
	) as new () => { revision: () => string; evaluate: (input: unknown) => Promise<unknown> };
	return {
		executor: new Executor(),
		connect,
		browser,
		context,
		send,
		utility,
		childServer,
		grandchildServer,
		child,
		page,
	};
}

function request(operation: object) {
	return {
		commandId: "command",
		deadline: Date.now() + 20_000,
		blockedHosts: [],
		observationRevision: "observation",
		privateFields: [],
		operation,
	};
}

function make_action_executor(
	options: {
		field?: boolean;
		html?: string;
		labelControl?: boolean;
		relabelBeforeArm?: boolean;
		moveBeforeArm?: boolean;
		blockBeforeArm?: boolean;
		foreignDocument?: boolean;
		iframe?: boolean;
		rejectOutcome?: boolean;
		outcomeError?: string;
		holdOutcome?: boolean;
		holdReady?: boolean;
		rejectStop?: boolean;
		stopGate?: Promise<void>;
		releaseGate?: Promise<void>;
		expired?: boolean;
		noEvents?: boolean;
		moveOnInput?: boolean;
	} = {},
) {
	const trace: string[] = [];
	const native = {
		field: options.field ?? false,
		foreignDocument: options.foreignDocument ?? false,
		iframe: options.iframe ?? false,
		clicks: 0,
		focuses: 0,
		selects: 0,
		blocked: 0,
		witnesses: [] as string[],
		foreignClockReads: 0,
		clockOffset: 0,
		value: "before",
		hitBlocked: false,
		x: 20,
	};
	let realm = createContext({ native, trace, hostNow: () => performance.now() });
	runInContext(
		`
		globalThis.window = globalThis;
		globalThis.document = { defaultView: window, activeElement: null };
		globalThis.listeners = new Map();
		globalThis.pageTimers = new Set();
		globalThis.performance = { now: () => hostNow() + native.clockOffset };
		globalThis.setTimeout = callback => { pageTimers.add(callback); return callback; };
		globalThis.clearTimeout = callback => pageTimers.delete(callback);
		globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
		globalThis.removeEventListener = (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); };
		globalThis.innerWidth = 500; globalThis.innerHeight = 400;
		globalThis.top = native.iframe ? {} : window;
		globalThis.visualViewport = { scale: 1, offsetLeft: 0, offsetTop: 0 };
		globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', contentVisibility: 'visible', transform: 'none', zoom: '1' });
		globalThis.element = {
			tagName: native.field ? 'INPUT' : 'BUTTON', type: 'text', ownerDocument: document, isConnected: true,
			parentElement: null, assignedSlot: null, inert: false, readOnly: false,
			get value() { return native.value; },
			getAttribute: name => name === 'type' && native.field ? 'text' : null,
			hasAttribute: () => false, matches: () => false, getRootNode: () => ({ host: null }),
			getBoundingClientRect: () => ({ x: native.x, y: 30, width: 100, height: 40 }), getClientRects: () => [{}],
			focus() { native.focuses++; element.ownerDocument.activeElement = element; }, select() { native.selects++; }
		};
		const overlay = { parentElement: null, assignedSlot: null, getRootNode: () => ({ host: null }) };
		document.elementFromPoint = () => native.hitBlocked ? overlay : element;
		if (native.foreignDocument) {
			const view = { innerWidth, innerHeight, visualViewport, getComputedStyle, setTimeout, clearTimeout, addEventListener, removeEventListener };
			view.top = view;
			view.performance = { get now() { native.foreignClockReads++; return () => hostNow(); } };
			element.ownerDocument = { defaultView: view, elementFromPoint: () => element, activeElement: null };
		}
		globalThis.events = (types, key) => {
			for (const type of types) {
				const event = { type, key, isTrusted: true, button: 0, clientX: 70, clientY: 50, prevented: false,
					composedPath: () => [element, element.ownerDocument], preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
				listeners.get(type)?.(event);
				if (event.prevented) native.blocked++;
				if (type === 'click' && !event.prevented) native.clicks++;
			}
		};
	`,
		realm,
	);
	let documentWindow: Window | undefined;
	let injected:
		| { parseSelector: (selector: string) => unknown; querySelectorAll: (selector: unknown, root: object) => object[] }
		| undefined;
	if (options.html !== undefined) {
		// Run the real SDK selector engine and Read callback on the same DOM node.
		const eventSource = runInContext("events.toString()", realm) as string;
		documentWindow = new Window({ url: "https://fixture.test/" });
		documentWindow.document.body.innerHTML = options.html;
		realm = createContext(documentWindow);
		Object.assign(realm, { native, trace });
		runInContext(
			`
			globalThis.listeners = new Map();
			globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
			globalThis.removeEventListener = (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); };
			globalThis.element = document.querySelector(${JSON.stringify(options.labelControl ? "label" : "input,textarea,button,select,[contenteditable]")});
			Object.defineProperty(element, 'value', { get: () => native.value, set: value => native.value = value });
			element.getBoundingClientRect = () => ({ x: 20, y: 30, width: 100, height: 40 });
			element.getClientRects = () => [{}];
			const focus = element.focus.bind(element);
			element.focus = () => { native.focuses++; focus(); };
			element.select = () => native.selects++;
			document.elementFromPoint = () => element;
			for (const node of [element, document.body, document.documentElement]) node.style.transform = 'none';
			globalThis.events = ${eventSource};
		`,
			realm,
		);
		const installed = readFileSync(
			new URL(
				"../node_modules/@cloudflare/playwright/lib/playwright-core/src/generated/injectedScriptSource.js",
				import.meta.url,
			),
			"utf8",
		);
		const injectedSource = new Function(installed.replace("export { source };", "return source;"))() as string;
		injected = runInContext(
			`(() => { const module = {}; ${injectedSource}; return new (module.exports.InjectedScript())(globalThis, {isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',isUtilityWorld:true,customEngines:[]}); })()`,
			realm,
		) as typeof injected;
	}
	type Control = {
		read: () => unknown;
		ready: () => boolean;
		arm: (previous: unknown) => unknown;
		outcome: () => unknown;
		stop: () => void;
	};
	const nativeSend = vi.fn(
		async (method: string, params: { objectId?: string; name?: string; executionContextId?: number }) => {
			if (method === "Runtime.addBinding") {
				expect(params.executionContextId, "A completion witness must belong only to the isolated utility world").toBe(
					2,
				);
				Object.assign(realm, { [params.name!]: (payload: string) => native.witnesses.push(payload) });
				return;
			}
			expect(method).toBe("Runtime.releaseObject");
			trace.push(`release:${params.objectId}`);
			if (params.objectId === "guard" && options.releaseGate) await options.releaseGate;
		},
	);
	const serverPage = { delegate: {} as object };
	const serverFrame = { _page: serverPage, _utilityContext: async (): Promise<object> => utility };
	const main = { world: "main", frame: serverFrame, delegate: { _contextId: 1, _client: { send: nativeSend } } };
	const nativeHandle = (objectId: string, context: object, extra: object = {}) => ({
		__jshandle: true,
		_disposed: false,
		_objectId: objectId,
		_context: context,
		...extra,
	});
	const utility = {
		world: "utility",
		frame: serverFrame,
		delegate: { _contextId: 2, _client: main.delegate._client },
		injectedScript: vi.fn(
			async () =>
				injected ?? {
					utils: {
						getElementAccessibleName: () => "Name",
						elementText: (_cache: unknown, node: { textContent?: string }) => ({ full: node.textContent ?? "" }),
					},
				},
		),
		evaluate: vi.fn(async (code: (arg: unknown) => unknown, arg?: unknown) =>
			options.html === undefined
				? { fields: [{ label: "Name", tag: "INPUT", type: "text", value: native.value }], selectedLabel: "Name" }
				: (runInContext(`(${code.toString()})`, realm) as typeof code)(arg),
		),
		evaluateHandle: vi.fn(
			async (
				code: (input: unknown) => unknown,
				args: { element: object; action: unknown; injected?: unknown; binding?: string },
			) => {
				const create = runInContext(`(${code.toString()})`, realm) as (input: {
					element: object;
					action: unknown;
					injected?: unknown;
					binding?: string;
				}) => Control;
				const control = create({
					element: runInContext("element", realm) as object,
					action: args.action,
					injected: args.injected,
					binding: args.binding,
				});
				return nativeHandle("guard", utility, {
					evaluate: async (fn: (control: Control, arg: unknown) => unknown, arg: unknown) => {
						const source = fn.toString();
						const outcome = source.includes("control.outcome()");
						const stop = source.includes("control.stop()");
						trace.push(outcome ? (stop ? "outcome_stop" : "outcome") : stop ? "stop" : "guard_check");
						if (outcome && options.rejectOutcome) throw new Error(options.outcomeError ?? "Fixed outcome failure");
						if (outcome && options.holdOutcome) return new Promise(() => {});
						if (source.includes("control.ready()") && options.holdReady) return new Promise(() => {});
						if (stop && !outcome && options.rejectStop) throw new Error("Fixed stop failure");
						if (stop && !outcome && options.stopGate) await options.stopGate;
						if (source.includes("control.ready()") && options.expired) native.clockOffset += 3001;
						if (source.includes("control.arm(previous)") && options.relabelBeforeArm)
							documentWindow!.document.getElementById("caption")!.textContent = "Password";
						if (source.includes("control.arm(previous)") && options.moveBeforeArm) native.x += 40;
						if (source.includes("control.arm(previous)") && options.blockBeforeArm) native.hitBlocked = true;
						const evaluate = runInContext(`(${source})`, realm) as (control: Control, arg: unknown) => unknown;
						return evaluate(control, arg);
					},
				});
			},
		),
	};
	const original = nativeHandle("original", main, { __elementhandle: true, _page: serverPage, _frame: serverFrame });
	const adopted = nativeHandle("utility-element", utility, {
		__elementhandle: true,
		_page: serverPage,
		_frame: serverFrame,
	});
	serverPage.delegate = { adoptElementHandle: vi.fn(async () => adopted) };
	const implementations = new Map<object, object>();
	const connection = { _objects: new Map<string, object>(), toImpl: (value: object) => implementations.get(value) };
	const frame = { _guid: "frame", _connection: connection };
	const ownerFrame = vi.fn(async () => frame);
	const element = {
		_guid: "element",
		_connection: connection,
		ownerFrame,
		dispose: vi.fn(async () => {
			trace.push("client_dispose");
			connection._objects.delete("element");
		}),
	};
	const events = runInContext("events", realm) as (types: string[], key?: string) => void;
	const mouseClick = vi.fn(async () => {
		trace.push("input");
		if (options.moveOnInput) native.hitBlocked = true;
		if (!options.noEvents) events(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
	});
	const page = {
		_guid: "page",
		_connection: connection,
		mainFrame: () => frame,
		frames: () => [frame],
		url: () => "https://fixture.test/",
		title: async () => "Fixture",
		on: vi.fn(),
		setDefaultTimeout: vi.fn(),
		mouse: { click: mouseClick, up: vi.fn(async () => {}) },
		keyboard: {
			insertText: vi.fn(async (value: string) => {
				trace.push("input");
				events(["beforeinput"]);
				native.value = value;
				events(["input"]);
			}),
			press: vi.fn(async (key: string) => {
				trace.push("input");
				events(["keydown", "keyup"], key);
			}),
		},
		getByText: (text: string) => (documentWindow ? domLocator(`internal:text=${JSON.stringify(text)}s`) : locator),
		getByRole: (role: string, options: { name: string }) =>
			documentWindow
				? domLocator(`internal:role=${role}[include-hidden=true][name=${JSON.stringify(options.name)}s]`)
				: locator,
		getByLabel: (label: string) => (documentWindow ? domLocator(`internal:label=${JSON.stringify(label)}s`) : locator),
	};
	const locator = { page: () => page, elementHandles: vi.fn(async () => [element]) };
	function domLocator(selector: string) {
		return {
			page: () => page,
			elementHandles: vi.fn(async () =>
				injected!.querySelectorAll(injected!.parseSelector(selector), documentWindow!.document).map((node) => {
					expect(node).toBe(runInContext("element", realm));
					return element;
				}),
			),
		};
	}
	Object.assign(frame, { url: () => "https://fixture.test/", childFrames: () => [], parentFrame: () => null });
	for (const [client, server] of [
		[page, serverPage],
		[frame, serverFrame],
		[element, original],
	] as const) {
		connection._objects.set(client._guid, client);
		implementations.set(client, server);
	}
	const browser = { contexts: () => [{ pages: () => [page] }], close: vi.fn(async () => {}) };
	const source = PLAYWRITER_EXECUTOR_JS.replace(/^import .*;\r?\n/gm, "").replace(
		"export default class",
		"return class",
	);
	const Executor = new Function("WorkerEntrypoint", "connect", "browser_web_url_host_matches", source)(
		class {},
		async () => browser,
		browser_web_url_host_matches,
	) as new () => { evaluate: (input: unknown) => Promise<unknown> };
	return {
		executor: new Executor(),
		page,
		ownerFrame,
		native,
		trace,
		realm,
		nativeSend,
		utility,
		original,
		adopted,
		documentWindow,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Playwriter fixed executor", () => {
	it("parses the built template and reads its revision without a browser", () => {
		const { executor, connect } = make_executor();
		expect(executor.revision()).toBe(PLAYWRITER_EXECUTOR_REVISION);
		expect(connect).not.toHaveBeenCalled();
	});

	it("reads the main page in the trusted utility world", async () => {
		const { executor, utility, browser } = make_executor();
		expect(await executor.evaluate(request({ kind: "read" }))).toMatchObject({
			result: { ok: true, inputSent: false, cleanup: "complete" },
			observation: { kind: "read", observationRevision: "observation", text: "Fixture", frames: [] },
		});
		expect(utility.evaluate).toHaveBeenCalledTimes(3);
		expect(browser.close).toHaveBeenCalledOnce();
	});

	it("reads an allowed about:blank main page", async () => {
		const { executor } = make_executor(0, "utility", undefined, undefined, "about:blank");
		expect(await executor.evaluate(request({ kind: "read" }))).toMatchObject({
			result: { ok: true },
			observation: { url: "about:blank", text: "Fixture" },
		});
	});

	it.each(["read", "capture"])("refuses %s when a document iframe has no announced session", async (kind) => {
		const { executor, context } = make_executor(1);
		expect(await executor.evaluate(request({ kind, format: "png" }))).toMatchObject({
			result: { ok: false, reason: "iframe_unsupported", inputSent: false },
		});
		expect(context.newCDPSession).not.toHaveBeenCalled();
	});

	it.each([
		{ url: "https://BLOCKED.TEST./", host: "blocked.test" },
		{ url: "https://login.blocked.test./", host: "BLOCKED.TEST." },
		{ url: "http://[::1]:8080/", host: "::1" },
	])("refuses Capture from a canonical blocked announced frame at $url", async ({ url, host }) => {
		const { executor, context } = make_executor(1, "utility", url);
		const reply = await executor.evaluate({ ...request({ kind: "capture", format: "png" }), blockedHosts: [host] });
		expect(reply, "A canonical blocked announced frame must not return pixels").toMatchObject({
			result: { ok: false, reason: "iframe_unsupported", inputSent: false },
		});
		expect(reply).not.toHaveProperty("observation");
		expect(context.newCDPSession).not.toHaveBeenCalled();
	});

	it.each(["about:srcdoc", "data:text/html,%3Cp%3EChild%3C%2Fp%3E"])(
		"reads a checked inherited child at %s",
		async (url) => {
			const { executor } = make_executor(1, "utility", url);
			const reply = await executor.evaluate(request({ kind: "read" }));
			expect(reply, "A checked child inherits the safe parent policy").toMatchObject({
				result: { ok: true },
				observation: { text: "Fixture", frames: [{ url }] },
			});
		},
	);

	it.each(["about:blank", "about:srcdoc", "data:text/html,%3Cp%3EChild%3C%2Fp%3E"])(
		"reads safe main text and skips a blocked child with inherited descendant %s",
		async (url) => {
			const { executor, childServer, grandchildServer } = make_executor(1, "utility", "https://blocked.test/", url);
			const reply = await executor.evaluate({ ...request({ kind: "read" }), blockedHosts: ["blocked.test"] });
			expect(reply, "A blocked child must not hide safe main text").toMatchObject({
				result: { ok: true },
				observation: { text: "Fixture", frames: [] },
			});
			expect(childServer._utilityContext).not.toHaveBeenCalled();
			expect(grandchildServer._utilityContext).not.toHaveBeenCalled();
		},
	);

	it("keeps an allowed HTTP grandchild under a blocked parent", async () => {
		const url = "https://allowed.test/";
		const { executor, childServer, grandchildServer } = make_executor(1, "utility", "https://blocked.test/", url);
		const reply = await executor.evaluate({ ...request({ kind: "read" }), blockedHosts: ["blocked.test"] });
		expect(reply, "An HTTP child uses its own host policy").toMatchObject({
			result: { ok: true },
			observation: { text: "Fixture", frames: [{ url }] },
		});
		expect(childServer._utilityContext).not.toHaveBeenCalled();
		expect(grandchildServer._utilityContext).toHaveBeenCalled();
	});

	it("refuses Read when a blocked announced child has an unannounced sibling", async () => {
		const { executor } = make_executor(2, "utility", "https://blocked.test/");
		expect(await executor.evaluate({ ...request({ kind: "read" }), blockedHosts: ["blocked.test"] })).toMatchObject({
			result: { ok: false, reason: "iframe_unsupported" },
		});
	});

	it("refuses Read when an inherited child has no checked parent", async () => {
		const { executor, child } = make_executor(1, "utility", "about:srcdoc");
		child.parentFrame = () => null;
		expect(await executor.evaluate(request({ kind: "read" }))).toMatchObject({
			result: { ok: false, reason: "iframe_unsupported" },
		});
	});

	it("drops Read text when the main page navigates to a blocked site during the read", async () => {
		const { executor, utility, page } = make_executor();
		const read = utility.evaluate.getMockImplementation()!;
		utility.evaluate.mockImplementation(async (code) => {
			const value = await read(code);
			if (code.toString().includes("const fields")) page.url = () => "https://blocked.test/";
			return value;
		});
		const reply = await executor.evaluate({ ...request({ kind: "read" }), blockedHosts: ["blocked.test"] });
		expect(reply, "Read must not return text from a blocked landing").toMatchObject({
			result: { ok: false, reason: "blocked_site" },
		});
		expect(reply).not.toHaveProperty("observation");
	});

	it.each(["https://notblocked.test/", "about:blank", "about:srcdoc", "data:text/html,%3Cp%3EChild%3C%2Fp%3E"])(
		"keeps an allowed announced frame at %s available for Capture",
		async (url) => {
			const { executor } = make_executor(1, "utility", url);
			expect(
				await executor.evaluate({ ...request({ kind: "capture", format: "png" }), blockedHosts: ["blocked.test"] }),
			).toMatchObject({ result: { ok: true }, observation: { kind: "capture", data: "image" } });
		},
	);

	it("drops Capture pixels when an announced frame moves to a blocked host during the screenshot", async () => {
		const { executor, context, send } = make_executor(1, "utility", "https://allowed.test/");
		send.mockImplementationOnce(async () => {
			context.pages()[0]!.frames()[1]!.url = () => "https://BLOCKED.TEST./";
			return { data: "image" };
		});
		const reply = await executor.evaluate({
			...request({ kind: "capture", format: "png" }),
			blockedHosts: ["blocked.test"],
		});
		expect(reply, "A blocked child landing must not return captured pixels").not.toHaveProperty("observation");
		expect(reply).toMatchObject({ result: { ok: false, reason: "iframe_unsupported", inputSent: false } });
		const cdp = await context.newCDPSession.mock.results[0]!.value;
		expect(cdp.detach).toHaveBeenCalledOnce();
	});

	it("captures one image without starting a video producer", async () => {
		const { executor, send } = make_executor();
		expect(await executor.evaluate(request({ kind: "capture", format: "png" }))).toMatchObject({
			result: { ok: true, inputSent: false },
			observation: { kind: "capture", data: "image" },
		});
		expect(send.mock.calls).toEqual([["Page.captureScreenshot", { format: "png", captureBeyondViewport: false }]]);
	});

	it("refuses a changed utility world and explicit child-frame actions", async () => {
		const { executor } = make_executor(0, "main");
		expect(await executor.evaluate(request({ kind: "read" }))).toMatchObject({
			result: { ok: false, reason: "iframe_unsupported", inputSent: false },
		});
		expect(
			await executor.evaluate(
				request({ kind: "act", frameRef: "frame", action: "click", locator: { by: "text", text: "Click" } }),
			),
		).toMatchObject({ result: { ok: false, reason: "iframe_unsupported", inputSent: false } });
	});
});

describe("Playwriter fixed executor actions", () => {
	const roleFields = [
		{
			role: "spinbutton",
			name: "Quantity",
			html: '<label for="quantity">Quantity</label><input id="quantity" type="number">',
			before: "1",
			value: "2",
			type: "number",
		},
		{
			role: "combobox",
			name: "City",
			html: '<label for="city">City</label><input id="city" type="text" list="cities"><datalist id="cities"><option value="Rome"><option value="Paris"></datalist>',
			before: "Rome",
			value: "Paris",
			type: "text",
		},
	];
	const credentialFields = [
		{
			kind: "aria-labelledby",
			name: "Password",
			html: '<span id="caption">Password</span><input id="field" type="text" aria-labelledby="caption">',
		},
		{
			kind: "native label",
			name: "Password",
			html: '<label for="field">Password</label><input id="field" type="text">',
		},
		{
			kind: "overridden native label",
			name: "Display name",
			html: '<label for="field">Password</label><input id="field" type="text" aria-label="Display name">',
		},
	];
	const pressControls = [
		{
			kind: "editable textbox",
			role: "textbox",
			key: "Enter",
			html: '<span id="caption">Name</span><div id="field" role="textbox" contenteditable="true" aria-labelledby="caption">One</div>',
			credentialHtml:
				'<span id="caption">Password</span><div id="field" role="textbox" contenteditable="true" aria-labelledby="caption">One</div>',
		},
		{
			kind: "native select",
			role: "combobox",
			key: "ArrowDown",
			html: '<label id="caption" for="field">Name</label><select id="field"><option>One</option><option>Two</option></select>',
			credentialHtml:
				'<label id="caption" for="field">Password</label><select id="field"><option>One</option><option>Two</option></select>',
		},
	];

	function action_request(action: "click" | "fill" | "press") {
		return {
			...request({
				kind: "act",
				action,
				locator: { by: "label", label: "Name" },
				...(action === "fill" ? { value: "after" } : action === "press" ? { key: "Enter" } : {}),
			}),
			privateFields: [{ label: "Name", tag: "INPUT", type: "text", value: "before" }],
		};
	}

	it.each(["click", "fill", "press"] as const)(
		"keeps trusted %s input without the extra native owner lookup",
		async (action) => {
			const f = make_action_executor({ field: action !== "click" });
			expect(await f.executor.evaluate(action_request(action))).toMatchObject({
				result: { ok: true, inputSent: true, cleanup: "complete" },
			});
			expect(f.ownerFrame).not.toHaveBeenCalled();
			expect(f.native.clicks).toBe(action === "click" ? 1 : 0);
			expect(f.native.focuses).toBe(action === "click" ? 0 : 1);
			if (action === "fill") expect(f.native.value).toBe("after");
			expect(
				f.native.witnesses,
				"Only a checked trusted click or Enter event may publish the private completion witness",
			).toEqual(action === "fill" ? [] : ["complete"]);
		},
	);

	it("keeps pre-input guard checks within three native calls", async () => {
		const f = make_action_executor();
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: true, inputSent: true, cleanup: "complete" },
		});
		expect(
			f.trace.slice(0, f.trace.indexOf("input")).filter((step) => step === "guard_check"),
			"The remote guard budget must not include a repeated geometry read",
		).toHaveLength(3);
	});

	it.each([
		{ reason: "moving_target", moveBeforeArm: true, blockBeforeArm: false },
		{ reason: "hit_target_blocked", moveBeforeArm: false, blockBeforeArm: true },
	])("refuses $reason before arming input", async ({ reason, moveBeforeArm, blockBeforeArm }) => {
		const f = make_action_executor({ moveBeforeArm, blockBeforeArm });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, reason, inputSent: false, cleanup: "complete" },
		});
		expect(f.trace).not.toContain("input");
		expect(f.native.focuses).toBe(0);
		expect(f.native.clicks).toBe(0);
		expect(f.native.witnesses).toHaveLength(0);
	});

	it.each([
		{
			name: "Display name",
			html: '<label for="name">Name</label><input id="name" type="text" aria-label="Display name">',
		},
		{
			name: "Given name",
			html: '<span id="given">Given name</span><label for="name">Name</label><input id="name" type="text" aria-labelledby="given" aria-label="Display name">',
		},
		{ name: "Name", html: '<label for="name">Name</label><input id="name" type="text">' },
	])("reads the SDK field name $name", async ({ name, html }) => {
		const f = make_action_executor({ field: true, html });
		try {
			const read = await f.executor.evaluate(request({ kind: "read" }));
			expect(read).toMatchObject({ result: { ok: true }, privateFields: [{ label: name, value: "before" }] });
			expect(read, "Read must use the same field name as the pinned SDK").toMatchObject({
				observation: { accessibility: `input ${name}` },
			});
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(["label", "role"] as const)("fills an aria-label field selected by the actual SDK %s query", async (by) => {
		const f = make_action_executor({
			field: true,
			html: '<label for="name">Name</label><input id="name" type="text" aria-label="Display name">',
		});
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as {
				result: { ok: boolean };
				privateFields: unknown[];
			};
			expect(read.result.ok).toBe(true);
			const locator = by === "label" ? { by, label: "Display name" } : { by, role: "textbox", name: "Display name" };
			const result = await f.executor.evaluate({
				...request({ kind: "act", action: "fill", locator, value: "after" }),
				privateFields: read.privateFields,
			});
			expect(result, "Fill must accept the field returned by the pinned SDK locator").toMatchObject({
				result: { ok: true, inputSent: true, cleanup: "complete" },
			});
			expect(f.native.value).toBe("after");
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(roleFields)(
		"fills an observed $role field using the actual SDK query",
		async ({ role, name, html, before, value, type }) => {
			const f = make_action_executor({ field: true, html });
			try {
				f.native.value = before;
				expect(
					await f.page.getByRole(role, { name }).elementHandles(),
					"The pinned SDK role query must find this exact field",
				).toHaveLength(1);
				const read = (await f.executor.evaluate(request({ kind: "read" }))) as {
					result: { ok: boolean };
					privateFields: unknown[];
				};
				expect(read).toMatchObject({
					result: { ok: true },
					privateFields: [{ label: name, tag: "INPUT", type, value: before }],
				});
				const result = await f.executor.evaluate({
					...request({ kind: "act", action: "fill", locator: { by: "role", role, name }, value }),
					privateFields: read.privateFields,
				});
				expect(result, "Fill must accept the observed field selected by the pinned SDK role query").toMatchObject({
					result: { ok: true, inputSent: true, cleanup: "complete" },
				});
				expect(f.native.value).toBe(value);
			} finally {
				await f.documentWindow!.happyDOM.close();
			}
		},
	);

	it.each(roleFields)(
		"keeps the observed $role value check before Fill",
		async ({ role, name, html, before, value }) => {
			const f = make_action_executor({ field: true, html });
			try {
				f.native.value = before;
				const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
				f.native.value = value;
				expect(
					await f.executor.evaluate({
						...request({ kind: "act", action: "fill", locator: { by: "role", role, name }, value }),
						privateFields: read.privateFields,
					}),
				).toMatchObject({ result: { ok: false, reason: "field_changed", inputSent: false } });
				expect(f.trace).not.toContain("input");
				expect(f.native.focuses).toBe(0);
			} finally {
				await f.documentWindow!.happyDOM.close();
			}
		},
	);

	it("keeps the observed number field type check before Fill", async () => {
		const f = make_action_executor({
			field: true,
			html: '<label for="quantity">Quantity</label><input id="quantity" type="number">',
		});
		try {
			f.native.value = "1";
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
			f.documentWindow!.document.querySelector("input")!.type = "text";
			expect(
				await f.executor.evaluate({
					...request({
						kind: "act",
						action: "fill",
						locator: { by: "role", role: "spinbutton", name: "Quantity" },
						value: "2",
					}),
					privateFields: read.privateFields,
				}),
			).toMatchObject({ result: { ok: false, reason: "field_changed", inputSent: false } });
			expect(f.trace).not.toContain("input");
			expect(f.native.focuses).toBe(0);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("refuses a readonly combobox field before focus or input", async () => {
		const f = make_action_executor({
			field: true,
			html: '<label for="city">City</label><input id="city" type="text" list="cities" readonly><datalist id="cities"><option value="Rome"></datalist>',
		});
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
			expect(
				await f.executor.evaluate({
					...request({
						kind: "act",
						action: "fill",
						locator: { by: "role", role: "combobox", name: "City" },
						value: "Rome",
					}),
					privateFields: read.privateFields,
				}),
			).toMatchObject({ result: { ok: false, reason: "unsupported_field", inputSent: false } });
			expect(f.trace).not.toContain("input");
			expect(f.native.focuses).toBe(0);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("matches one referenced label to its full observed SDK field name", async () => {
		const f = make_action_executor({
			field: true,
			html: '<span id="first">Given</span><span id="last">name</span><input type="text" aria-labelledby="first last">',
		});
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as {
				result: { ok: boolean };
				privateFields: unknown[];
			};
			expect(read.result.ok).toBe(true);
			expect(
				await f.executor.evaluate({
					...request({ kind: "act", action: "fill", locator: { by: "label", label: "Given" }, value: "after" }),
					privateFields: read.privateFields,
				}),
			).toMatchObject({ result: { ok: true, inputSent: true } });
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("still checks the real aria-label field value before Fill", async () => {
		const f = make_action_executor({
			field: true,
			html: '<label for="name">Name</label><input id="name" type="text" aria-label="Display name">',
		});
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
			f.native.value = "human edit";
			expect(
				await f.executor.evaluate({
					...request({ kind: "act", action: "fill", locator: { by: "label", label: "Display name" }, value: "after" }),
					privateFields: read.privateFields,
				}),
			).toMatchObject({ result: { ok: false, reason: "field_changed", inputSent: false } });
			expect(f.trace).not.toContain("input");
			expect(f.native.focuses).toBe(0);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each([
		'<label for="name">Password</label><input id="name" type="password">',
		'<input type="text" autocomplete="one-time-code" aria-label="Code">',
	])("keeps sensitive fields out of real Read and Fill (%s)", async (html) => {
		const f = make_action_executor({ field: true, html });
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
			expect(read.privateFields).toEqual([]);
			expect(await f.executor.evaluate({ ...action_request("fill"), privateFields: read.privateFields })).toMatchObject(
				{ result: { ok: false, inputSent: false } },
			);
			expect(f.trace).not.toContain("input");
			expect(f.native.focuses).toBe(0);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(credentialFields)("excludes $kind credential fields from real Read", async ({ html }) => {
		const f = make_action_executor({ field: true, html });
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
			expect(read.privateFields, "Read must omit fields named as credentials, including overridden label text").toEqual(
				[],
			);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(credentialFields.flatMap((field) => ["click", "press"].map((action) => ({ ...field, action }))))(
		"refuses $action on a $kind credential field before focus or input",
		async ({ name, html, action }) => {
			const f = make_action_executor({ field: true, html });
			try {
				expect(await f.page.getByRole("textbox", { name }).elementHandles()).toHaveLength(1);
				const result = await f.executor.evaluate(
					request({
						kind: "act",
						action,
						locator: { by: "role", role: "textbox", name },
						...(action === "press" ? { key: "Enter" } : {}),
					}),
				);
				expect(f.native.focuses, "Credential fields must never receive native focus").toBe(0);
				expect(f.trace, "Credential fields must never receive native input").not.toContain("input");
				expect(result).toMatchObject({ result: { ok: false, reason: "sensitive_input", inputSent: false } });
			} finally {
				await f.documentWindow!.happyDOM.close();
			}
		},
	);

	it.each(["click", "fill", "press"] as const)(
		"refuses relabeling to Password before %s arm focus or input",
		async (action) => {
			const f = make_action_executor({
				field: true,
				relabelBeforeArm: true,
				html: '<span id="caption">Name</span><input id="field" type="text" aria-labelledby="caption">',
			});
			try {
				const read = (await f.executor.evaluate(request({ kind: "read" }))) as { privateFields: unknown[] };
				const result = await f.executor.evaluate({
					...request({
						kind: "act",
						action,
						locator: { by: "role", role: "textbox", name: "Name" },
						...(action === "fill" ? { value: "after" } : action === "press" ? { key: "Enter" } : {}),
					}),
					privateFields: read.privateFields,
				});
				expect(f.native.focuses, "Credential relabeling must never focus the field").toBe(0);
				expect(f.trace, "Credential relabeling must never send native input").not.toContain("input");
				expect(result).toMatchObject({ result: { ok: false, reason: "sensitive_input" } });
			} finally {
				await f.documentWindow!.happyDOM.close();
			}
		},
	);

	it("refuses a direct credential label through its current control before input", async () => {
		const f = make_action_executor({
			field: true,
			labelControl: true,
			html: '<label for="field">Password</label><input id="field" type="text">',
		});
		try {
			const result = await f.executor.evaluate(
				request({ kind: "act", action: "click", locator: { by: "text", text: "Password" } }),
			);
			expect(f.trace, "A credential label's control must prevent native input").not.toContain("input");
			expect(f.native.focuses).toBe(0);
			expect(result).toMatchObject({ result: { ok: false, reason: "sensitive_input", inputSent: false } });
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("keeps ordinary password button text outside credential field checks", async () => {
		const f = make_action_executor({ html: "<button>Reset password</button>" });
		try {
			expect(
				await f.executor.evaluate(
					request({ kind: "act", action: "click", locator: { by: "role", role: "button", name: "Reset password" } }),
				),
			).toMatchObject({ result: { ok: true, inputSent: true } });
			expect(f.native.clicks).toBe(1);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(pressControls)(
		"refuses a credential $kind before native focus or input",
		async ({ role, key, credentialHtml }) => {
			const f = make_action_executor({ html: credentialHtml });
			try {
				expect(
					await f.page.getByRole(role, { name: "Password" }).elementHandles(),
					"The pinned SDK query must find this exact credential control",
				).toHaveLength(1);
				const result = await f.executor.evaluate(
					request({ kind: "act", action: "press", locator: { by: "role", role, name: "Password" }, key }),
				);
				expect(f.native.focuses, "Credential editable and select controls must never receive native focus").toBe(0);
				expect(f.trace, "Credential editable and select controls must never receive native input").not.toContain(
					"input",
				);
				expect(result).toMatchObject({ result: { ok: false, reason: "sensitive_input", inputSent: false } });
			} finally {
				await f.documentWindow!.happyDOM.close();
			}
		},
	);

	it.each(pressControls)("omits a credential $kind from real Read lines", async ({ credentialHtml }) => {
		const f = make_action_executor({ html: credentialHtml });
		try {
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as {
				observation: { accessibility: string };
				privateFields: unknown[];
			};
			expect(read.observation.accessibility, "Read must omit credential editable and select controls").toBe("");
			expect(read.privateFields).toEqual([]);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(pressControls)("keeps normal Press on a $kind through the actual SDK query", async ({ role, key, html }) => {
		const f = make_action_executor({ html });
		try {
			expect(await f.page.getByRole(role, { name: "Name" }).elementHandles()).toHaveLength(1);
			expect(
				await f.executor.evaluate(
					request({ kind: "act", action: "press", locator: { by: "role", role, name: "Name" }, key }),
				),
			).toMatchObject({ result: { ok: true, inputSent: true, cleanup: "complete" } });
			expect(f.native.focuses).toBe(1);
			expect(f.trace).toContain("input");
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(pressControls)("refuses a $kind relabeled as a credential before arm", async ({ role, key, html }) => {
		const f = make_action_executor({ html, relabelBeforeArm: true });
		try {
			const result = await f.executor.evaluate(
				request({ kind: "act", action: "press", locator: { by: "role", role, name: "Name" }, key }),
			);
			expect(f.native.focuses, "Relabeled editable and select controls must never receive native focus").toBe(0);
			expect(f.trace, "Relabeled editable and select controls must never receive native input").not.toContain("input");
			expect(result).toMatchObject({ result: { ok: false, reason: "sensitive_input" } });
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("keeps a Password button name outside editable control checks", async () => {
		const f = make_action_executor({
			html: '<span id="caption">Password</span><button aria-labelledby="caption">Continue</button>',
		});
		try {
			expect(
				await f.executor.evaluate(
					request({ kind: "act", action: "click", locator: { by: "role", role: "button", name: "Password" } }),
				),
			).toMatchObject({ result: { ok: true, inputSent: true } });
			expect(f.native.clicks).toBe(1);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it.each(
		[
			{ id: "password-help", name: "Password help" },
			{ id: "passcode-help", name: "Passcode help" },
			{ id: "verification-code-help", name: "Verification code help" },
		].flatMap((button) => ["click", "press"].map((action) => ({ ...button, action }))),
	)("keeps native $action on ordinary $name buttons", async ({ id, name, action }) => {
		const f = make_action_executor({ html: `<button id="${id}" aria-label="${name}">Help</button>` });
		try {
			expect(await f.page.getByRole("button", { name }).elementHandles()).toHaveLength(1);
			const read = (await f.executor.evaluate(request({ kind: "read" }))) as { observation: { accessibility: string } };
			expect(read.observation.accessibility).toContain(name);
			const result = await f.executor.evaluate(
				request({
					kind: "act",
					action,
					locator: { by: "role", role: "button", name },
					...(action === "press" ? { key: "Enter" } : {}),
				}),
			);
			expect(result, "Ordinary help buttons must stay usable even when their names mention credentials").toMatchObject({
				result: { ok: true, inputSent: true, cleanup: "complete" },
			});
			expect(f.native.clicks).toBe(action === "click" ? 1 : 0);
			expect(f.native.focuses).toBe(action === "press" ? 1 : 0);
		} finally {
			await f.documentWindow!.happyDOM.close();
		}
	});

	it("still refuses Tab internally before native focus or input", async () => {
		const f = make_action_executor({ field: true });
		const input = action_request("press");
		expect(await f.executor.evaluate({ ...input, operation: { ...input.operation, key: "Tab" } })).toMatchObject({
			result: { ok: false, reason: "unsupported_key", inputSent: false },
		});
		expect(f.trace).not.toContain("input");
		expect(f.native.focuses).toBe(0);
	});

	it.each(["missing Read", "changed field"])("refuses Fill after Capture with %s proof", async (change) => {
		const f = make_action_executor({ field: true });
		const input = action_request("fill");
		if (change === "missing Read") input.privateFields = [];
		else f.native.value = "human edit";
		expect(await f.executor.evaluate(input)).toMatchObject({
			result: { ok: false, reason: "field_changed", inputSent: false, cleanup: "complete" },
		});
		expect(f.trace).not.toContain("input");
		expect(f.native.focuses).toBe(0);
	});

	it.each(["click", "fill", "press"] as const)(
		"refuses a node adopted into another document before %s focus or input",
		async (action) => {
			const f = make_action_executor({ field: action !== "click", foreignDocument: true });
			expect(await f.executor.evaluate(action_request(action))).toMatchObject({
				result: { ok: false, reason: "detached", inputSent: false, cleanup: "complete" },
			});
			expect(f.native.foreignClockReads).toBe(0);
			expect(f.native.focuses).toBe(0);
			expect(f.trace).not.toContain("input");
		},
	);

	it("refuses an iframe document before native input", async () => {
		const f = make_action_executor({ iframe: true });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, reason: "iframe_unsupported", inputSent: false, cleanup: "complete" },
		});
		expect(f.trace).not.toContain("input");
	});

	it.each(["stale element", "stale frame", "wrong utility world"])("refuses %s before native input", async (change) => {
		const f = make_action_executor();
		if (change === "stale element") f.page._connection._objects.delete("element");
		else if (change === "stale frame") f.page._connection._objects.delete("frame");
		else f.utility.world = "main";
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, inputSent: false },
		});
		expect(f.trace).not.toContain("input");
		expect(f.utility.evaluateHandle).not.toHaveBeenCalled();
		if (change === "stale element") {
			expect(f.nativeSend).not.toHaveBeenCalled();
			expect(f.trace).not.toContain("client_dispose");
		}
	});

	it("reads the outcome and stops in one call before native releases", async () => {
		const f = make_action_executor();
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: true, cleanup: "complete" },
		});
		expect(f.trace.filter((entry) => entry === "outcome_stop")).toHaveLength(1);
		expect(f.trace).not.toContain("stop");
		expect(f.trace.indexOf("outcome_stop")).toBeLessThan(f.trace.indexOf("release:guard"));
		expect(runInContext("listeners.size", f.realm)).toBe(0);
		expect(
			f.nativeSend.mock.calls
				.filter(([method]) => method === "Runtime.releaseObject")
				.map(([, params]) => params.objectId),
		).toEqual(["guard", "utility-element", "original"]);
		expect(f.trace.indexOf("release:original")).toBeLessThan(f.trace.indexOf("client_dispose"));
	});

	it.each(["Fixed outcome failure", "Execution context was destroyed"])(
		"uses fallback stop and keeps unknown after %s",
		async (outcomeError) => {
			const f = make_action_executor({ rejectOutcome: true, outcomeError });
			expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
				result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "unknown" },
			});
			expect(f.native.clicks).toBe(1);
			expect(f.trace).toContain("stop");
			expect(f.trace.indexOf("stop")).toBeLessThan(f.trace.indexOf("release:guard"));
			expect(runInContext("listeners.size", f.realm)).toBe(0);
		},
	);

	it("uses fallback stop after the shared outcome deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const f = make_action_executor({ holdOutcome: true });
		const pending = f.executor.evaluate(action_request("click"));
		await vi.advanceTimersByTimeAsync(75);
		expect(f.trace).toContain("input");
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({
			result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "unknown" },
		});
		expect(f.trace).toContain("stop");
		expect(f.trace.indexOf("stop")).toBeLessThan(f.trace.indexOf("release:guard"));
	});

	it("does not release owned handles while guard stop is pending", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const stop = Promise.withResolvers<void>();
		const f = make_action_executor({ rejectOutcome: true, stopGate: stop.promise });
		const timeout = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			// A fractional timer can fire while a small cleanup budget remains.
			return timeout(callback, f.trace.at(-1) === "stop" ? (delay ?? 0) - 0.5 : delay, ...args);
		});
		const pending = f.executor.evaluate(action_request("click"));
		try {
			await vi.advanceTimersByTimeAsync(75);
			expect(f.trace).toContain("stop");
			await vi.advanceTimersByTimeAsync(999);
			expect(
				f.nativeSend.mock.calls.filter(([method]) => method === "Runtime.releaseObject"),
				"Pending guard stop must prevent every owned native release",
			).toHaveLength(0);
			expect(f.trace, "Pending guard stop must keep the client dispatcher").not.toContain("client_dispose");
			expect(await pending).toMatchObject({
				result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "unknown" },
			});
		} finally {
			stop.resolve();
			timer.mockRestore();
			await pending;
		}
	});

	it("keeps best-effort releases after a prompt stop error", async () => {
		const f = make_action_executor({ rejectOutcome: true, rejectStop: true });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "unknown" },
		});
		expect(f.trace.indexOf("stop")).toBeLessThan(f.trace.indexOf("release:guard"));
		expect(
			f.nativeSend.mock.calls
				.filter(([method]) => method === "Runtime.releaseObject")
				.map(([, params]) => params.objectId),
		).toEqual(["guard", "utility-element", "original"]);
		expect(f.trace.indexOf("release:original")).toBeLessThan(f.trace.indexOf("client_dispose"));
	});

	it("waits for each native release before reporting cleanup complete", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const release = Promise.withResolvers<void>();
		const f = make_action_executor({ releaseGate: release.promise });
		let finished = false;
		const pending = f.executor.evaluate(action_request("click")).then((result) => {
			finished = true;
			return result;
		});
		try {
			await vi.advanceTimersByTimeAsync(75);
			expect(
				f.nativeSend.mock.calls
					.filter(([method]) => method === "Runtime.releaseObject")
					.map(([, params]) => params.objectId),
			).toEqual(["guard", "utility-element", "original"]);
			expect(finished).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await pending).toMatchObject({ result: { ok: true, cleanup: "complete" } });
	});

	it("keeps unknown when a native release misses the shared cleanup deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const f = make_action_executor({ releaseGate: new Promise(() => {}) });
		const pending = f.executor.evaluate(action_request("click"));
		await vi.advanceTimersByTimeAsync(75);
		expect(f.nativeSend).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({ result: { ok: false, reason: "outcome_unknown", cleanup: "unknown" } });
	});

	it("keeps the utility clock expiry check before input", async () => {
		const f = make_action_executor({ expired: true });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, reason: "guard_expired", inputSent: false },
		});
		expect(f.trace).not.toContain("input");
	});

	it("refuses a timed-out guard check after cleanup without marking the click unknown", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const f = make_action_executor({ holdReady: true });
		const pending = f.executor.evaluate(action_request("click"));
		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({
			result: { ok: false, reason: "guard_expired", inputSent: false, cleanup: "complete" },
		});
		expect(f.trace).not.toContain("input");
		expect(f.trace.indexOf("stop")).toBeLessThan(f.trace.indexOf("release:guard"));
	});

	it("keeps a timed-out guard check unknown when cleanup fails", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const f = make_action_executor({ holdReady: true, rejectStop: true });
		const pending = f.executor.evaluate(action_request("click"));
		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toMatchObject({
			result: { ok: false, reason: "outcome_unknown", inputSent: false, cleanup: "unknown" },
		});
		expect(f.trace).not.toContain("input");
	});

	it("still blocks an occluded target during native input", async () => {
		const f = make_action_executor({ moveOnInput: true });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, inputSent: true, reason: "hit_target_blocked" },
		});
		expect(f.native.clicks).toBe(0);
		expect(f.native.blocked).toBe(5);
	});

	it("does not treat missing native events as success", async () => {
		const f = make_action_executor({ noEvents: true });
		expect(await f.executor.evaluate(action_request("click"))).toMatchObject({
			result: { ok: false, inputSent: true, reason: "target_events_missing" },
		});
	});
});
