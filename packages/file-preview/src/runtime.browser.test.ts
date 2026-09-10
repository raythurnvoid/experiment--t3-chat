import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute, resolve, sep } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { preview, type PreviewServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { file_preview_security_config } from "../security";
import { file_preview_RuntimeMessageSchema } from "./protocol";

const runtimeUrl = "http://127.0.0.1:5175/v0";
const hostUrl = "http://127.0.0.1:5173/__file-preview-test";
const sessionId = "8a16bed0-5b30-4c38-b643-33d708f6b285";
const loadId = "7d0c56c4-07e1-457a-9b70-dcf7c9f43010";
let browser: BrowserContext;
let runtimeServer: PreviewServer | undefined;
let collector: Server;
let blockedUrl: string;
let forbiddenRequests = 0;

beforeAll(async () => {
	const runDir = process.env.FILE_PREVIEW_TEST_RUN_DIR;
	const repository = resolve("../..");
	if (
		!runDir ||
		!isAbsolute(runDir) ||
		resolve(runDir).startsWith(repository + sep) ||
		resolve(runDir) === repository
	) {
		throw new Error("Set FILE_PREVIEW_TEST_RUN_DIR to an absolute scratch folder outside the repository.");
	}
	await mkdir(resolve(runDir), { recursive: true });
	try {
		await fetch(runtimeUrl, { signal: AbortSignal.timeout(1_000) });
	} catch {
		runtimeServer = await preview({ mode: "development" });
	}
	collector = createServer((_request, response) => {
		forbiddenRequests++;
		response.end("Forbidden network request reached the server.");
	});
	await new Promise<void>((done) => collector.listen(0, "127.0.0.1", done));
	const address = collector.address();
	if (!address || typeof address === "string") throw new Error("Missing collector address");
	blockedUrl = `http://127.0.0.1:${address.port}/blocked`;
	browser = await chromium.launchPersistentContext(await mkdtemp(resolve(runDir, "browser-profile-")), {
		headless: true,
		// Full Chromium also covers blob navigation; the headless shell can crash on that path.
		channel: "chromium",
		// The intercepted host has no network address. Permit loopback access for this test browser.
		permissions: ["local-network-access"],
		downloadsPath: resolve(runDir, "downloads"),
		tracesDir: resolve(runDir, "traces"),
	});
});

afterEach(async () => {
	for (const page of browser.pages()) await page.close();
});

afterAll(async () => {
	await browser?.close();
	await new Promise<void>((done) => (runtimeServer ? runtimeServer.httpServer.close(() => done()) : done()));
	await new Promise<void>((done) => (collector ? collector.close(() => done()) : done()));
});

async function openPreview(source: string, parentUrl = hostUrl) {
	const page = await browser.newPage();
	page.setDefaultTimeout(5_000);
	await page.route(parentUrl, (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><title>Preview test host</title><output id="status"></output><div id="frames"></div>',
		}),
	);
	await page.goto(parentUrl);
	await page.evaluate(
		({ source, runtimeUrl, sessionId, loadId }) => {
			const frame = document.createElement("iframe");
			frame.id = "preview";
			frame.title = "HTML file preview";
			frame.sandbox.add("allow-scripts", "allow-same-origin");
			frame.referrerPolicy = "no-referrer";
			const fields = { protocol: "bonobo-file-preview", version: 1, sessionId };
			const runtimeOrigin = new URL(runtimeUrl).origin;
			window.addEventListener("message", (event: MessageEvent<unknown>) => {
				if (event.origin !== runtimeOrigin || event.source !== frame.contentWindow) return;
				const status = document.querySelector("#status")!;
				status.textContent = JSON.stringify(event.data);
				if (event.data && typeof event.data === "object" && "type" in event.data && event.data.type === "ready") {
					frame.contentWindow?.postMessage({ ...fields, type: "load_html", loadId, html: source }, runtimeOrigin);
				}
			});
			frame.onload = () => frame.contentWindow?.postMessage({ ...fields, type: "hello" }, runtimeOrigin);
			frame.src = runtimeUrl;
			document.querySelector("#frames")!.append(frame);
		},
		{ source, runtimeUrl, sessionId, loadId },
	);
	return page;
}

function documentFrame(page: Page) {
	return page.frameLocator("#preview").frameLocator('iframe[title="HTML preview document"]');
}

describe("isolated HTML runtime", () => {
	test("serves built security headers on the runtime and fallback paths", async () => {
		const expected = file_preview_security_config(undefined, true);
		expect(await readFile(resolve("dist/_headers"), "utf8")).toBe(expected.staticHeaders);
		for (const path of ["/v0", "/missing/path"]) {
			const response = await fetch(new URL(path, runtimeUrl));
			expect(response.status).toBe(200);
			for (const [name, value] of Object.entries(expected.headers)) expect(response.headers.get(name)).toBe(value);
		}
	});

	test("runs full documents, classic scripts, and native module scripts", async () => {
		const page = await openPreview(
			`<!doctype html><html lang="it"><head><style>body { color: rgb(12, 34, 56) }</style><script>const config = "file"; const parent = "tree"; window.steps = ["head"]; document.addEventListener("DOMContentLoaded", () => window.steps.push("dom"));</script></head><body><button id="count" onclick="this.textContent = Number(this.textContent) + 1">0</button><output id="result"></output><script>window.steps.push("body");</script><script type="module">await Promise.resolve(); window.steps.push("module"); document.querySelector("#result").textContent = config;</script></body></html>`,
		);
		const frame = documentFrame(page);
		await frame.locator("#result").waitFor({ state: "visible" });
		await expect.poll(() => frame.locator("#result").textContent()).toBe("file");
		await frame.locator("#count").click();
		expect(await frame.locator("#count").textContent()).toBe("1");
		expect(
			await frame.locator("body").evaluate((body) => ({
				color: getComputedStyle(body).color,
				lang: document.documentElement.lang,
				mode: document.compatMode,
				steps: Reflect.get(window, "steps"),
			})),
		).toEqual({ color: "rgb(12, 34, 56)", lang: "it", mode: "CSS1Compat", steps: ["head", "body", "module", "dom"] });
		await expect.poll(() => page.locator("#status").textContent()).toContain('"type":"loaded"');
	});

	test("imports pinned esm.sh modules and their transitive imports", async () => {
		const page = await openPreview(
			`<!doctype html><body><svg aria-label="Chart"></svg><script type="module">import { select, scaleLinear } from "https://esm.sh/d3@7.9.0"; const width = scaleLinear().domain([0, 10]).range([0, 100]); select("svg").append("rect").attr("width", width(4)).attr("height", 20); document.body.dataset.ready = "yes";</script></body>`,
		);
		const frame = documentFrame(page);
		await expect.poll(() => frame.locator("rect").count(), { timeout: 25_000 }).toBe(1);
		expect(await frame.locator("rect").getAttribute("width")).toBe("40");
		expect(await frame.locator("body").getAttribute("data-ready")).toBe("yes");
	});

	test("blocks parent access and storage in every document", async () => {
		const page = await openPreview(`<!doctype html><body><output id="result"></output><script>
		const checks = {};
		for (const [name, read] of Object.entries({ parent: () => parent.document.body, top: () => top.document.body, cookie: () => document.cookie, local: () => localStorage.length, session: () => sessionStorage.length, indexedDB: () => indexedDB.open("preview"), serviceWorker: () => navigator.serviceWorker.register("/worker.js") })) {
			try { read(); checks[name] = false; } catch { checks[name] = true; }
		}
		document.querySelector("#result").textContent = JSON.stringify(checks);
		</script></body>`);
		const result = documentFrame(page).locator("#result");
		await expect.poll(() => result.textContent()).toContain('"session":true');
		expect(JSON.parse((await result.textContent())!)).toEqual({
			parent: true,
			top: true,
			cookie: true,
			local: true,
			session: true,
			indexedDB: true,
			serviceWorker: true,
		});
	});

	test("rejects bad sessions, extra fields, and messages from a sibling window", async () => {
		const page = await openPreview("<p id='original'>Original</p>");
		await documentFrame(page).locator("#original").waitFor();
		await page.evaluate(
			({ sessionId, loadId }) => {
				const frame = document.querySelector<HTMLIFrameElement>("#preview")!;
				const message = {
					protocol: "bonobo-file-preview",
					version: 1,
					type: "load_html",
					sessionId,
					loadId,
					html: '<p id="bad">Bad</p>',
				};
				frame.contentWindow!.postMessage({ ...message, sessionId: crypto.randomUUID() }, "http://127.0.0.1:5175");
				frame.contentWindow!.postMessage(
					{ ...message, loadId: crypto.randomUUID(), token: "bad" },
					"http://127.0.0.1:5175",
				);
				const sibling = document.createElement("iframe");
				sibling.srcdoc = `<script>parent.document.querySelector("#preview").contentWindow.postMessage(${JSON.stringify({ ...message, loadId: crypto.randomUUID() })}, "http://127.0.0.1:5175")<\/script>`;
				document.body.append(sibling);
			},
			{ sessionId, loadId },
		);
		await page.waitForTimeout(150);
		expect(await documentFrame(page).locator("#original").count()).toBe(1);
		expect(await documentFrame(page).locator("#bad").count()).toBe(0);
	});

	test("does not allow a different parent origin to start a preview", async () => {
		const page = await openPreview("<p id='bad'>Bad</p>", "http://127.0.0.1:5174/__file-preview-test");
		await page.waitForTimeout(200);
		expect(await page.locator("#status").textContent()).toBe("");
		expect(page.frames().some((frame) => frame.url() === "about:srcdoc")).toBe(false);
	});

	test("relays bounded script, rejection, and resource errors", async () => {
		for (const source of [
			'<script>throw new Error("x".repeat(700));</script>',
			'<script>Promise.reject(new Error("x".repeat(700)));</script>',
			`<script src="${blockedUrl}"></script>`,
		]) {
			const page = await openPreview(source);
			await expect.poll(() => page.locator("#status").textContent()).toContain('"type":"error"');
			const result = file_preview_RuntimeMessageSchema.parse(
				JSON.parse((await page.locator("#status").textContent())!),
			);
			expect(result).toMatchObject({ protocol: "bonobo-file-preview", type: "error", sessionId, loadId });
			expect(Object.keys(result).sort()).toEqual(["loadId", "message", "protocol", "sessionId", "type", "version"]);
			if (result.type !== "error") throw new Error("Expected an error status");
			expect(result.message.length).toBeLessThanOrEqual(500);
			await page.close();
		}
	});

	test("blocks forbidden network requests, nested frames, popups, forms, and top navigation", async () => {
		forbiddenRequests = 0;
		const page =
			await openPreview(`<!doctype html><body><img src="${blockedUrl}?image"><iframe src="${blockedUrl}?frame"></iframe><form action="${blockedUrl}?form"><button id="submit">Submit</button></form><a id="top" href="${blockedUrl}?top" target="_top">Top</a><button id="popup" onclick="window.open('${blockedUrl}?popup')">Popup</button><script>
		fetch("${blockedUrl}?fetch").catch(() => {});
		try { navigator.sendBeacon("${blockedUrl}?beacon", "private"); } catch {}
		try { new Worker(URL.createObjectURL(new Blob(["fetch('${blockedUrl}?worker')"], { type: "text/javascript" }))); } catch {}
		</script></body>`);
		const frame = documentFrame(page);
		await frame.locator("#submit").click();
		await frame.locator("#popup").click();
		await frame.locator("#top").click();
		await page.waitForTimeout(250);
		expect(forbiddenRequests).toBe(0);
		expect(page.url()).toBe(hostUrl);
		expect(browser.pages()).toHaveLength(1);
	});

	test("blocks document navigation by script, link, meta refresh, and blob child", async () => {
		forbiddenRequests = 0;
		for (const source of [
			`<script>location.href = "${blockedUrl}?script";</script>`,
			`<meta http-equiv="refresh" content="0;url=${blockedUrl}?meta">`,
			`<a id="navigate" href="${blockedUrl}?link">Navigate</a>`,
			`<script>const frame = document.createElement("iframe"); frame.src = URL.createObjectURL(new Blob(['<script>location.href = "${blockedUrl}?blob";' + '</scr' + 'ipt>'], { type: "text/html" })); document.documentElement.append(frame);</script>`,
		]) {
			const page = await openPreview(source);
			if (source.startsWith("<a")) await documentFrame(page).locator("#navigate").click();
			await page.waitForTimeout(250);
			await page.close();
		}
		expect(forbiddenRequests).toBe(0);
	});

	test("tears down the document when its host frame is removed", async () => {
		const page = await openPreview(
			'<script>setInterval(() => parent.postMessage({ protocol: "bonobo-file-preview-document", type: "error", loadId: "7d0c56c4-07e1-457a-9b70-dcf7c9f43010", message: "tick" }, "http://127.0.0.1:5175"), 20);</script>',
		);
		await expect.poll(() => page.locator("#status").textContent()).toContain('"message":"tick"');
		await page.evaluate(() => {
			document.querySelector("#preview")!.remove();
			document.querySelector("#status")!.textContent = "stopped";
		});
		await page.waitForTimeout(100);
		expect(await page.locator("#status").textContent()).toBe("stopped");
	});
});
