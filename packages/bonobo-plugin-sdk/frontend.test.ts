import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bonobo_ui_connect } from "./frontend.js";

const HOST_ORIGIN = "https://host.test";
const BRIDGE_NONCE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CONVEX_URL = "https://deployment.convex.test";

type FakeOnUpdateEntry = {
	query: unknown;
	args: Record<string, unknown>;
	callback: (value: unknown) => void;
	onError: (error: Error) => void;
	unsubscribed: boolean;
};

type FakeConvexClientInstance = {
	address: string;
	options: Record<string, unknown>;
	fetchToken: (() => Promise<string | null>) | null;
	closed: boolean;
	onUpdates: FakeOnUpdateEntry[];
	onUpdate: (
		query: unknown,
		args: Record<string, unknown>,
		callback: (value: unknown) => void,
		onError: (error: Error) => void,
	) => () => void;
	mutation: ReturnType<typeof vi.fn>;
	query: ReturnType<typeof vi.fn>;
};

const fakeConvex = vi.hoisted(() => ({
	instances: [] as unknown[],
}));

// The real client opens a WebSocket at construction, so every client-backed test runs against
// this fake. Its onUpdate records the registration and lets the test deliver results manually —
// always after registration returned, which reproduces the real client's async delivery.
vi.mock("convex/browser", () => ({
	ConvexClient: class FakeConvexClient {
		address: string;
		options: Record<string, unknown>;
		fetchToken: (() => Promise<string | null>) | null = null;
		closed = false;
		onUpdates: FakeOnUpdateEntry[] = [];
		mutation = vi.fn();
		query = vi.fn();
		constructor(address: string, options: Record<string, unknown>) {
			this.address = address;
			this.options = options;
			fakeConvex.instances.push(this);
		}
		setAuth(fetchToken: () => Promise<string | null>) {
			this.fetchToken = fetchToken;
		}
		onUpdate(
			query: unknown,
			args: Record<string, unknown>,
			callback: (value: unknown) => void,
			onError: (error: Error) => void,
		) {
			const entry: FakeOnUpdateEntry = { query, args, callback, onError, unsubscribed: false };
			this.onUpdates.push(entry);
			return () => {
				entry.unsubscribed = true;
			};
		}
		close() {
			this.closed = true;
		}
	},
}));

function convex_instance() {
	const instance = fakeConvex.instances.at(-1) as FakeConvexClientInstance | undefined;
	if (!instance) {
		throw new Error("ConvexClient not constructed");
	}
	return instance;
}

function set_bridge_fragment(parentOrigin = HOST_ORIGIN, bridgeNonce = BRIDGE_NONCE) {
	window.history.replaceState(
		null,
		"",
		`/#${new URLSearchParams({ parentOrigin, bridgeNonce }).toString()}`,
	);
}

/** Simulates one host → page postMessage. */
function post_from_host(data: unknown, origin: string = HOST_ORIGIN, source: MessageEventSource = window): void {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

function make_init(overrides?: Record<string, unknown>) {
	return {
		type: "bonobo:init",
		bridgeNonce: BRIDGE_NONCE,
		apiOrigin: "https://api.test",
		convexUrl: CONVEX_URL,
		token: "plu_1",
		tokenExpiresAt: Date.now() + 600_000,
		context: {
			kind: "page",
			pluginName: "gallery",
			userId: "user_1",
			pageId: "main",
			pageTitle: "Gallery",
			organizationId: "org_1",
			workspaceId: "ws_1",
		},
		...overrides,
	};
}

function make_file_view_context(overrides?: Record<string, unknown>) {
	return {
		kind: "file_view",
		pluginName: "video-player",
		userId: "user_1",
		fileViewId: "player",
		fileViewTitle: "Video player",
		organizationId: "org_1",
		workspaceId: "ws_1",
		file: {
			fileNodeId: "node_1",
			name: "clip.mp4",
			path: "/clips/clip.mp4",
			contentType: "video/mp4",
		},
		...overrides,
	};
}

/** happy-dom cannot deliver a real cross-origin parent postMessage, so record it directly. */
function spy_on_post_message() {
	return vi.spyOn(window, "postMessage").mockImplementation(() => {});
}

function refresh_requests(postSpy: ReturnType<typeof spy_on_post_message>) {
	return postSpy.mock.calls.filter((call) => (call[0] as { type?: string }).type === "bonobo:token-refresh-request");
}

function make_public_doc(overrides?: Record<string, unknown>) {
	return {
		collection: "messages",
		key: "m:1",
		value: { body: "hi" },
		revision: 1,
		createdBy: "user_1",
		updatedBy: "user_1",
		ownership: "shared",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function answer_refresh(
	postSpy: ReturnType<typeof spy_on_post_message>,
	token: string,
	overrides?: Record<string, unknown>,
) {
	const request = refresh_requests(postSpy).at(-1)?.[0] as { requestId: string } | undefined;
	if (!request) {
		throw new Error("refresh request not posted");
	}
	post_from_host({
		type: "bonobo:token",
		bridgeNonce: BRIDGE_NONCE,
		requestId: request.requestId,
		token,
		tokenExpiresAt: Date.now() + 600_000,
		...overrides,
	});
	return request.requestId;
}

/** One macrotask: flushes the SDK's setTimeout(0) death deliveries and the window flush. */
async function flush_deliveries() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function connect_client() {
	spy_on_post_message();
	const clientPromise = bonobo_ui_connect();
	post_from_host(make_init());
	return await clientPromise;
}

beforeEach(() => {
	set_bridge_fragment();
});

afterEach(() => {
	window.history.replaceState(null, "", "/");
	fakeConvex.instances.length = 0;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("bonobo_ui_connect", () => {
	test("rejects a missing or malformed host bridge fragment", async () => {
		window.history.replaceState(null, "", "/");
		await expect(bonobo_ui_connect()).rejects.toThrow("Missing host bridge fragment");

		// A plugin that ships only file views renders this rejection verbatim to the member (the
		// video player's `main.tsx` does exactly that). A member in a file view is not on a page,
		// so the wording must name the frame instead. Pin the rule, not the sentence: re-wording
		// is fine, calling the frame a page is not.
		let bridgeMessage = "";
		await bonobo_ui_connect().catch((error: unknown) => {
			bridgeMessage = error instanceof Error ? error.message : String(error);
		});
		expect(bridgeMessage).not.toMatch(/page/i);

		set_bridge_fragment("ftp://host.test");
		await expect(bonobo_ui_connect()).rejects.toThrow("Invalid host bridge parent origin");

		set_bridge_fragment("https://host.test/");
		await expect(bonobo_ui_connect()).rejects.toThrow("Invalid host bridge parent origin");

		set_bridge_fragment(HOST_ORIGIN, "not-a-uuid");
		await expect(bonobo_ui_connect()).rejects.toThrow("Invalid host bridge nonce");

		window.history.replaceState(
			null,
			"",
			`/#${new URLSearchParams({ parentOrigin: HOST_ORIGIN, bridgeNonce: BRIDGE_NONCE, extra: "value" })}`,
		);
		await expect(bonobo_ui_connect()).rejects.toThrow("Invalid host bridge fragment");
	});

	test("sends nonce-bound ready to the exact parent and accepts only its matching init", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		expect(postSpy).toHaveBeenCalledWith({ type: "bonobo:ready", bridgeNonce: BRIDGE_NONCE }, HOST_ORIGIN);

		post_from_host(make_init({ token: "plu_wrong_source" }), HOST_ORIGIN, {} as Window);
		post_from_host(make_init({ token: "plu_wrong_origin" }), "https://wrong-host.test");
		post_from_host(make_init({ bridgeNonce: crypto.randomUUID(), token: "plu_bad_nonce" }));
		post_from_host(make_init({ tokenExpiresAt: Number.NaN, token: "plu_bad_shape" }));
		post_from_host(make_init({ convexUrl: undefined, token: "plu_no_convex_url" }));
		post_from_host(make_init());
		const client = await clientPromise;

		expect(client.apiOrigin).toBe("https://api.test");
		expect(client.context.kind === "page" && client.context.pageTitle).toBe("Gallery");
		await expect(client.getToken()).resolves.toBe("plu_1");
	});

	test("init opens the page's own Convex client and closes it on pagehide", async () => {
		await connect_client();

		const instance = convex_instance();
		expect(instance.address).toBe(CONVEX_URL);
		// expectAuth parks queries until the first JWT; the SDK never wants the unsaved-changes
		// beforeunload handler inside a sandboxed iframe.
		expect(instance.options).toEqual({ expectAuth: true, unsavedChangesWarning: false });
		expect(instance.fetchToken).toBeTypeOf("function");
		expect(instance.closed).toBe(false);

		window.dispatchEvent(new Event("pagehide"));
		expect(instance.closed).toBe(true);
	});

	test("accepts a file-view context and rejects contexts with a missing or unknown kind", async () => {
		spy_on_post_message();
		const clientPromise = bonobo_ui_connect();

		post_from_host(make_init({ context: make_file_view_context({ kind: undefined }), token: "plu_no_kind" }));
		post_from_host(make_init({ context: make_file_view_context({ kind: "backend" }), token: "plu_bad_kind" }));
		post_from_host(make_init({ context: make_file_view_context({ file: undefined }), token: "plu_no_file" }));
		post_from_host(
			make_init({ context: make_file_view_context({ file: { fileNodeId: "node_1" } }), token: "plu_bad_file" }),
		);
		post_from_host(make_init({ context: make_file_view_context() }));
		const client = await clientPromise;

		expect(client.context).toEqual(make_file_view_context());
		await expect(client.getToken()).resolves.toBe("plu_1");

		// The refresh timeout reaches the member from a file view too: the video player passes it
		// to `setErrorMessage` and renders it. Same rule as the bridge refusal above — the message
		// must not tell a member in a file view that they are on a page.
		vi.useFakeTimers();
		let refreshMessage = "";
		const refreshSettled = client.refreshToken().catch((error: unknown) => {
			refreshMessage = error instanceof Error ? error.message : String(error);
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await refreshSettled;
		expect(refreshMessage).toContain("token refresh timed out");
		expect(refreshMessage).not.toMatch(/page/i);
	});

	test("requires userId in the init context for both kinds", async () => {
		spy_on_post_message();
		const clientPromise = bonobo_ui_connect();

		post_from_host(make_init({ context: { ...make_init().context, userId: undefined }, token: "plu_no_user" }));
		post_from_host(
			make_init({ context: make_file_view_context({ userId: undefined }), token: "plu_no_user_file_view" }),
		);
		post_from_host(make_init());
		const client = await clientPromise;

		expect(client.context.userId).toBe("user_1");
		await expect(client.getToken()).resolves.toBe("plu_1");
	});

	test("keeps retrying ready because the host owns the startup deadline", async () => {
		vi.useFakeTimers();
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();

		await vi.advanceTimersByTimeAsync(15_500);
		expect(
			postSpy.mock.calls.filter((call) => (call[0] as { type?: string }).type === "bonobo:ready").length,
		).toBeGreaterThan(20);

		post_from_host(make_init());
		await expect(clientPromise).resolves.toMatchObject({ apiOrigin: "https://api.test" });
	});

	test("shares one token refresh across simultaneous 401 responses", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;

		const fetchMock = vi
			.fn<(url: string, init: { method: string; headers: Headers; body?: string }) => Promise<Response>>()
			.mockResolvedValueOnce(new Response("expired", { status: 401 }))
			.mockResolvedValueOnce(new Response("expired", { status: 401 }))
			.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const first = client.fetchJson("/api/v1/files/list", { body: { limit: 100 } });
		const second = client.fetchJson("/api/v1/files/list", { body: { limit: 100 } });
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");

		await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[0]?.[1].headers.get("Authorization")).toBe("Bearer plu_1");
		expect(fetchMock.mock.calls[2]?.[1].headers.get("Authorization")).toBe("Bearer plu_2");
	});

	test("a delayed 401 retries the token another request already refreshed", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;

		let resolveDelayed401: ((response: Response) => void) | null = null;
		const delayed401 = new Promise<Response>((resolve) => {
			resolveDelayed401 = resolve;
		});
		const fetchMock = vi.fn((url: string, init: { headers: Headers }): Promise<Response> => {
			const bearer = init.headers.get("Authorization");
			if (url.endsWith("/first") && bearer === "Bearer plu_1") {
				return Promise.resolve(new Response("expired", { status: 401 }));
			}
			if (url.endsWith("/second") && bearer === "Bearer plu_1") {
				return delayed401;
			}
			return Promise.resolve(
				new Response(JSON.stringify({ bearer }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = client.fetchJson("/first");
		const second = client.fetchJson("/second");
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");
		await expect(first).resolves.toEqual({ bearer: "Bearer plu_2" });

		resolveDelayed401?.(new Response("late expired", { status: 401 }));
		await expect(second).resolves.toEqual({ bearer: "Bearer plu_2" });
		expect(refresh_requests(postSpy)).toHaveLength(1);
	});

	test("throws after the one 401 retry instead of starting another cycle", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;
		const fetchMock = vi.fn().mockResolvedValue(new Response("still expired", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = client.fetchJson("/api/v1/files/list");
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");

		await expect(result).rejects.toMatchObject({ status: 401, responseText: "still expired" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(refresh_requests(postSpy)).toHaveLength(1);
	});

	test("shares refresh failure and lets a later request try again", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;

		const first = client.refreshToken();
		const second = client.refreshToken();
		const firstRejected = expect(first).rejects.toThrow("Refresh denied");
		const secondRejected = expect(second).rejects.toThrow("Refresh denied");
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		const firstRequest = refresh_requests(postSpy)[0]?.[0] as { requestId: string };
		post_from_host({
			type: "bonobo:token-error",
			bridgeNonce: BRIDGE_NONCE,
			requestId: firstRequest.requestId,
			message: "Refresh denied",
		});
		await Promise.all([firstRejected, secondRejected]);

		const later = client.refreshToken();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(2));
		answer_refresh(postSpy, "plu_3");
		await expect(later).resolves.toBe("plu_3");
	});

	test("ignores refresh replies with the wrong source, origin, or nonce", async () => {
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;
		const refresh = client.refreshToken();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		const request = refresh_requests(postSpy)[0]?.[0] as { requestId: string };
		const reply = {
			type: "bonobo:token",
			bridgeNonce: BRIDGE_NONCE,
			requestId: request.requestId,
			token: "plu_ignored",
			tokenExpiresAt: Date.now() + 600_000,
		};

		post_from_host(reply, HOST_ORIGIN, {} as Window);
		post_from_host(reply, "https://wrong-host.test");
		post_from_host({ ...reply, bridgeNonce: "wrong_nonce" });
		let settled = false;
		void refresh.finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		answer_refresh(postSpy, "plu_2");
		await expect(refresh).resolves.toBe("plu_2");
	});

	test("rejects a refresh that receives no host response and clears the single-flight request", async () => {
		vi.useFakeTimers();
		const postSpy = spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await clientPromise;

		const firstRefresh = client.refreshToken();
		const rejected = expect(firstRefresh).rejects.toThrow("Plugin frame token refresh timed out");
		await vi.advanceTimersByTimeAsync(10_000);
		await rejected;

		const secondRefresh = client.refreshToken();
		expect(refresh_requests(postSpy)).toHaveLength(2);
		answer_refresh(postSpy, "plu_3");
		await expect(secondRefresh).resolves.toBe("plu_3");
	});

	test("declares the fetchJson result as unknown so a page must check the answer before reading it", async () => {
		// `fetchJson` is the one call that hands the page data from outside the app, and outside data
		// starts as `unknown`. With `any` a page could read `.items` off a listing page that came back
		// empty while `isDone` was still false, which is exactly what the doc block warns about.
		//
		// This reads the declaration text because nothing in this package type-checks that file:
		// `pnpm run typecheck` passes `--skipLibCheck`, which skips every `.d.ts`, and vitest
		// transpiles the tests without checking types. A type-level assertion here would never run.
		//
		// Build the path from `import.meta.dirname`, not from `new URL(..., import.meta.url)`. The
		// happy-dom environment resolves a relative URL against the fake document location, so that
		// form asks for `https://plugin.test/frontend.d.ts` and `readFile` refuses the scheme.
		const declaration = await readFile(join(import.meta.dirname, "frontend.d.ts"), "utf8");
		// Cut the declaration out first, from `fetchJson(` to the `Promise<…>;` that ends it, so a
		// failure prints the signature instead of the whole file.
		const fetchJsonDeclaration = declaration.match(/\bfetchJson\([^]*?\bPromise<[^>]*>;/)?.[0] ?? "";
		expect(fetchJsonDeclaration).toMatch(/\): Promise<unknown>;$/);

		// Read the implementation's own JSDoc too. It is the file a maintainer opens to edit
		// `fetchJson`, and `any` is assignable to `unknown`, so the two can disagree forever without
		// a compile error. Someone reading only `frontend.js` would "fix" the declaration back.
		const implementation = await readFile(join(import.meta.dirname, "frontend.js"), "utf8");
		// Anchor on the block close so this reads fetchJson's own tag. Without the anchor the scan
		// returns the first `@returns` in the file that has `fetchJson` somewhere after it.
		const fetchJsonReturnsTag =
			implementation.match(/@returns \{Promise<[^>]*>\}(?=\s*\*\/\s*async function fetchJson\()/)?.[0] ?? "";
		expect(fetchJsonReturnsTag).toBe("@returns {Promise<unknown>}");

		// The README states the same rule and then shows the one example a plugin author copies.
		// That example used to read `page.items`, `page.cursor`, `page.isDone` and `error.status`
		// with no check at all, so it broke the rule printed above it and did not compile in a
		// TypeScript plugin — which every first-party plugin is. Read the file the same way,
		// because no gate in this package looks at the README.
		const readme = await readFile(join(import.meta.dirname, "README.md"), "utf8");
		// Cut out just the frontend example's fenced block, so a failure prints the snippet.
		const frontendExample = readme.match(/### Frontend page example\s*```js\n([^]*?)```/)?.[1] ?? "";
		expect(frontendExample).toContain("client.fetchJson");

		// Both guards must survive, in the shape the shipped plugins already use: the video
		// player's `get_error_status` before reading a rejection's `status`, and Council's
		// `as_record` before reading fields off the answer.
		expect(frontendExample).toContain('"status" in error');
		expect(frontendExample).toContain('typeof page === "object" && page !== null');
		// And nothing may read a field straight off the `unknown` that `fetchJson` answered.
		expect(frontendExample).not.toMatch(/\bpage\.\w/);
	});
});

describe("convex session jwt auth", () => {
	function stub_exchange(responses: Response[] | ((body: { token: string }) => Response)) {
		const exchangeCalls: { token: string }[] = [];
		const queue = Array.isArray(responses) ? [...responses] : null;
		const fetchMock = vi.fn((url: string, init: { body: string }): Promise<Response> => {
			if (!url.endsWith("/plugins-ui/session-jwt")) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			const body = JSON.parse(init.body) as { token: string };
			exchangeCalls.push(body);
			if (queue) {
				const next = queue.shift();
				if (!next) {
					throw new Error("No stubbed exchange response left");
				}
				return Promise.resolve(next);
			}
			return Promise.resolve((responses as (body: { token: string }) => Response)(body));
		});
		vi.stubGlobal("fetch", fetchMock);
		return { fetchMock, exchangeCalls };
	}

	function jwt_response(jwt: string, sessionExpiresAt: number) {
		return new Response(JSON.stringify({ _yay: { jwt, sessionExpiresAt } }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	test("exchanges the session token same-origin and returns the jwt", async () => {
		const postSpy = spy_on_post_message();
		await connect_client();
		const { fetchMock, exchangeCalls } = stub_exchange([jwt_response("jwt_1", Date.now() + 1_800_000)]);

		await expect(convex_instance().fetchToken!()).resolves.toBe("jwt_1");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.test/plugins-ui/session-jwt",
			expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }),
		);
		expect(exchangeCalls).toEqual([{ token: "plu_1" }]);
		// The init token was fresh, so no host refresh was needed on the way.
		expect(refresh_requests(postSpy)).toHaveLength(0);
	});

	test("the exchange's sessionExpiresAt re-anchors the refresh margin", async () => {
		const postSpy = spy_on_post_message();
		const client = await connect_client();
		// The exchange reports the session ending sooner than the init said.
		stub_exchange([jwt_response("jwt_1", Date.now() + 30_000)]);
		await expect(convex_instance().fetchToken!()).resolves.toBe("jwt_1");

		// getToken now sees the session inside the 60-second margin and asks the host.
		const tokenPromise = client.getToken();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");
		await expect(tokenPromise).resolves.toBe("plu_2");
	});

	test("a session near expiry is refreshed through the host before the exchange", async () => {
		const postSpy = spy_on_post_message();
		spy_on_post_message();
		const clientPromise = bonobo_ui_connect();
		// The init token is already inside the 60-second refresh margin.
		post_from_host(make_init({ tokenExpiresAt: Date.now() + 30_000 }));
		await clientPromise;
		const { exchangeCalls } = stub_exchange((body) => jwt_response(`jwt_for_${body.token}`, Date.now() + 1_800_000));

		const jwtPromise = convex_instance().fetchToken!();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");

		// The host refresh extended the session, and the exchange used the fresh token.
		await expect(jwtPromise).resolves.toBe("jwt_for_plu_2");
		expect(exchangeCalls).toEqual([{ token: "plu_2" }]);
	});

	test("a 401 exchange refreshes the session once and re-exchanges", async () => {
		const postSpy = spy_on_post_message();
		await connect_client();
		const { exchangeCalls } = stub_exchange([
			new Response("dead", { status: 401 }),
			jwt_response("jwt_2", Date.now() + 1_800_000),
		]);

		const jwtPromise = convex_instance().fetchToken!();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");

		await expect(jwtPromise).resolves.toBe("jwt_2");
		expect(exchangeCalls).toEqual([{ token: "plu_1" }, { token: "plu_2" }]);
	});

	test("a second 401 answers null: the session is gone", async () => {
		const postSpy = spy_on_post_message();
		await connect_client();
		stub_exchange([new Response("dead", { status: 401 }), new Response("dead", { status: 401 })]);

		const jwtPromise = convex_instance().fetchToken!();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		answer_refresh(postSpy, "plu_2");

		await expect(jwtPromise).resolves.toBeNull();
	});

	test("a transient exchange failure retries instead of reporting unauthenticated", async () => {
		await connect_client();
		// One null from fetchToken is final for the Convex client, so a 429 or a network blip
		// must be retried, not reported as "unauthenticated".
		const { exchangeCalls } = stub_exchange([
			new Response("slow down", { status: 429 }),
			jwt_response("jwt_retry", Date.now() + 1_800_000),
		]);

		await expect(convex_instance().fetchToken!()).resolves.toBe("jwt_retry");
		expect(exchangeCalls).toEqual([{ token: "plu_1" }, { token: "plu_1" }]);
	}, 15_000);

	test("a hard refusal answers null without retrying", async () => {
		await connect_client();
		const { fetchMock } = stub_exchange([new Response("refused", { status: 403 })]);

		await expect(convex_instance().fetchToken!()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("a refused host refresh answers null", async () => {
		const postSpy = spy_on_post_message();
		await connect_client();
		stub_exchange([new Response("dead", { status: 401 })]);

		const jwtPromise = convex_instance().fetchToken!();
		await vi.waitFor(() => expect(refresh_requests(postSpy)).toHaveLength(1));
		const request = refresh_requests(postSpy)[0]?.[0] as { requestId: string };
		post_from_host({
			type: "bonobo:token-error",
			bridgeNonce: BRIDGE_NONCE,
			requestId: request.requestId,
			message: "Session revoked",
		});

		await expect(jwtPromise).resolves.toBeNull();
	});

	test("a rate-limited or malformed exchange answers null", async () => {
		await connect_client();

		stub_exchange([new Response(JSON.stringify({ message: "Rate limit exceeded" }), { status: 429 })]);
		await expect(convex_instance().fetchToken!()).resolves.toBeNull();

		stub_exchange([
			new Response(JSON.stringify({ _yay: { jwt: 42, sessionExpiresAt: "soon" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		]);
		await expect(convex_instance().fetchToken!()).resolves.toBeNull();
	});
});

describe("data.watch", () => {
	test("subscribes on the page's client and delivers each update's docs", async () => {
		const client = await connect_client();

		const onUpdate = vi.fn();
		client.data.watch({ collection: "messages", keyPrefix: "m:", limit: 100 }, onUpdate);
		const instance = convex_instance();
		expect(instance.onUpdates).toHaveLength(1);
		const registration = instance.onUpdates[0]!;
		expect(getFunctionName(registration.query as never)).toBe("plugins_data:watch_documents");
		expect(registration.args).toEqual({ collection: "messages", keyPrefix: "m:", limit: 100 });

		const firstDocs = [make_public_doc()];
		registration.callback({ docs: firstDocs, truncated: false });
		const secondDocs = [make_public_doc(), make_public_doc({ key: "m:2" })];
		registration.callback({ docs: secondDocs, truncated: false });

		expect(onUpdate).toHaveBeenNthCalledWith(1, firstDocs);
		expect(onUpdate).toHaveBeenNthCalledWith(2, secondDocs);
	});

	test("a null answer kills the subscription and makes unsubscribe a no-op", async () => {
		const client = await connect_client();

		const onUpdate = vi.fn();
		const unsubscribe = client.data.watch({ collection: "messages", limit: 50 }, onUpdate);
		const registration = convex_instance().onUpdates[0]!;
		expect("keyPrefix" in registration.args).toBe(false);

		registration.callback(null);
		expect(onUpdate).toHaveBeenNthCalledWith(1, null);
		expect(registration.unsubscribed).toBe(true);

		// Late deliveries for the dead registration are dropped, and unsubscribe is inert.
		registration.callback({ docs: [make_public_doc()], truncated: false });
		unsubscribe();
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	test("a query error kills the subscription with a bare null", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const client = await connect_client();

		const onUpdate = vi.fn();
		client.data.watch({ collection: "messages", limit: 10 }, onUpdate);
		const registration = convex_instance().onUpdates[0]!;

		registration.onError(new Error("query failed"));
		expect(onUpdate).toHaveBeenNthCalledWith(1, null);
		expect(registration.unsubscribed).toBe(true);
		expect(errorSpy).toHaveBeenCalled();
	});

	test("unsubscribe disposes once and stops delivery", async () => {
		const client = await connect_client();

		const onUpdate = vi.fn();
		const unsubscribe = client.data.watch({ collection: "messages", limit: 100 }, onUpdate);
		const registration = convex_instance().onUpdates[0]!;

		unsubscribe();
		expect(registration.unsubscribed).toBe(true);

		registration.callback({ docs: [make_public_doc()], truncated: false });
		expect(onUpdate).not.toHaveBeenCalled();
		unsubscribe();
	});

	test("invalid inputs die at birth with a reason and never reach the client", async () => {
		const client = await connect_client();

		const cases: Array<[{ collection: string; keyPrefix?: string; limit: number }, string]> = [
			[{ collection: "", limit: 10 }, "Collection names must be 1 to 128 characters"],
			[{ collection: "a".repeat(129), limit: 10 }, "Collection names must be 1 to 128 characters"],
			[
				{ collection: "messages", keyPrefix: "no space", limit: 10 },
				"Key prefixes must be 1 to 109 printable ASCII characters",
			],
			[{ collection: "messages", limit: 0 }, "Watch limits must be integers from 1 to 100"],
			[{ collection: "messages", limit: 101 }, "Watch limits must be integers from 1 to 100"],
			[{ collection: "messages", limit: 2.5 }, "Watch limits must be integers from 1 to 100"],
		];
		for (const [opts, message] of cases) {
			const onUpdate = vi.fn();
			client.data.watch(opts, onUpdate);
			expect(onUpdate).not.toHaveBeenCalled();
			await flush_deliveries();
			expect(onUpdate).toHaveBeenNthCalledWith(1, null, { reason: "invalid", message });
		}
		expect(convex_instance().onUpdates).toHaveLength(0);

		// Inputs outside the client-side subset — refusals whose outcome depends on the Unicode
		// version — still go to the server and die as its bare null.
		client.data.watch({ collection: "bad\u{0}name", limit: 10 }, vi.fn());
		expect(convex_instance().onUpdates).toHaveLength(1);
	});

	test("the ninth watch dies as capacity without subscribing", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = await connect_client();

		for (let index = 1; index <= 8; index += 1) {
			client.data.watch({ collection: "notes", limit: 10 }, vi.fn());
		}
		expect(convex_instance().onUpdates).toHaveLength(8);

		const onRefused = vi.fn();
		client.data.watch({ collection: "notes", limit: 10 }, onRefused);
		await flush_deliveries();
		expect(convex_instance().onUpdates).toHaveLength(8);
		// The cap refusal names itself: a page holding real slots should close one, not treat
		// the refusal as access gone.
		expect(onRefused).toHaveBeenNthCalledWith(1, null, {
			reason: "capacity",
			message: "Subscription limit reached for this plugin frame",
		});
		expect(warnSpy).toHaveBeenCalled();

		// A death released its slot: after one subscription dies, a new watch starts again.
		convex_instance().onUpdates[0]!.callback(null);
		client.data.watch({ collection: "notes", limit: 10 }, vi.fn());
		expect(convex_instance().onUpdates).toHaveLength(9);
	});
});

describe("data.watchWindow", () => {
	type FakeWatch = {
		queryArgs: { collection: string; keyPrefix?: string; limit: number };
		bounds: { keyStartExclusive?: string; keyEndInclusive?: string };
		onResult: (outcome: { value: unknown } | { queryError: unknown }) => void;
		disposed: boolean;
	};

	/**
	 * The window manager is not exported, so these tests drive it the way a plugin does: through
	 * the client `bonobo_ui_connect` resolves, on the fake Convex client the module mock installs.
	 *
	 * The SDK wires the manager to that client through `create_convex_data_deps`, which merges the
	 * manager's query args and its interval fenceposts into the ONE args object Convex receives.
	 * So the wrapper below splits them apart again and presents the `FakeWatch` shape the
	 * assertions read. That makes the bound assertions stronger than they were against a
	 * hand-written `start_watch`: they now check the range the SDK really asked the server for.
	 */
	async function make_data_api() {
		const client = await connect_client();
		const instance = convex_instance();
		const startedWatches: FakeWatch[] = [];
		// Results the next started watches are born with, oldest first. A seeded watch mimics
		// the Convex client holding a cached result for identical args: it arrives on a
		// setTimeout(0) after the start call, never synchronously — the client's own contract.
		const seededResults: unknown[] = [];
		const record_watch = instance.onUpdate.bind(instance);

		instance.onUpdate = (query, args, callback, onError) => {
			const { keyStartExclusive, keyEndInclusive, ...queryArgs } = args;
			const unsubscribe = record_watch(query, args, callback, onError);
			const watch: FakeWatch = {
				queryArgs: queryArgs as FakeWatch["queryArgs"],
				bounds: {
					...(keyStartExclusive === undefined ? {} : { keyStartExclusive: keyStartExclusive as string }),
					...(keyEndInclusive === undefined ? {} : { keyEndInclusive: keyEndInclusive as string }),
				},
				// The SDK's own adapter turns the client's two callbacks back into one outcome, so
				// hand the outcome to whichever callback the real client would have called.
				onResult: (outcome) => {
					if ("queryError" in outcome) {
						onError(outcome.queryError as Error);
					} else {
						callback(outcome.value);
					}
				},
				disposed: false,
			};
			startedWatches.push(watch);
			if (seededResults.length > 0) {
				const value = seededResults.shift();
				setTimeout(() => {
					if (!watch.disposed) {
						callback(value);
					}
				}, 0);
			}
			return () => {
				watch.disposed = true;
				unsubscribe();
			};
		};

		return { api: client.data, startedWatches, seededResults };
	}

	async function deliver(watch: FakeWatch, docs: { key: string }[], truncated: boolean) {
		watch.onResult({ value: { docs, truncated } });
		await flush_deliveries();
	}

	function window_updates(onUpdate: ReturnType<typeof vi.fn>) {
		return onUpdate.mock.calls;
	}

	/**
	 * Grows one window to `intervals` bounded intervals, each holding a full page. Per cycle the
	 * newest unbounded interval delivers a truncated page and re-seats onto the range its docs
	 * cover, then loadOlder appends the next unbounded tail. Full pages never merge back, because
	 * a merge needs an adjacent pair holding less than one page between them.
	 */
	async function grow_window(harness: Awaited<ReturnType<typeof make_data_api>>, prefix: string, intervals = 6) {
		const onUpdate = vi.fn();
		const handle = harness.api.watchWindow({ collection: "messages", keyPrefix: prefix, pageSize: 3 }, onUpdate);
		for (let interval = 1; interval <= intervals; interval += 1) {
			const docs = [1, 2, 3].map((slot) => ({ key: `${prefix}${interval}:${slot}` }));
			await deliver(harness.startedWatches.at(-1)!, docs, true);
			if (interval < intervals) {
				handle.loadOlder();
			}
		}
		return { handle, onUpdate };
	}

	test("starts one unbounded read with the caller's args and coalesces identical deliveries", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);

		expect(startedWatches).toHaveLength(1);
		expect(startedWatches[0]!.queryArgs).toEqual({ collection: "messages", keyPrefix: "m:", limit: 3 });
		expect(startedWatches[0]!.bounds).toEqual({});

		await deliver(startedWatches[0]!, [{ key: "m:1" }], false);
		expect(window_updates(onUpdate)).toEqual([
			[{ docs: [{ key: "m:1" }], hasMore: false, atCapacity: false, incomplete: false }],
		]);

		// An identical delivery coalesces away: the whole payload is unchanged.
		await deliver(startedWatches[0]!, [{ key: "m:1" }], false);
		expect(window_updates(onUpdate)).toHaveLength(1);

		handle.unsubscribe();
		expect(startedWatches[0]!.disposed).toBe(true);
		expect(window_updates(onUpdate)).toHaveLength(1);
	});

	test("a truncated first delivery re-seats behind one update that already says hasMore", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);

		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		// The re-seat happened before the flush: exactly one update, content unchanged, hasMore on.
		expect(window_updates(onUpdate)).toEqual([
			[{ docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], hasMore: true, atCapacity: false, incomplete: false }],
		]);
		expect(startedWatches[0]!.disposed).toBe(true);
		expect(startedWatches).toHaveLength(2);
		// The new subscription pins the window to its own largest delivered key.
		expect(startedWatches[1]!.bounds).toEqual({ keyEndInclusive: "m:3" });
	});

	test("loadOlder appends an unbounded tail from the stored bound", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		handle.loadOlder();
		expect(startedWatches).toHaveLength(3);
		expect(startedWatches[2]!.bounds).toEqual({ keyStartExclusive: "m:3" });

		// The tail's first non-truncated delivery closes the history: hasMore drops.
		await deliver(startedWatches[2]!, [{ key: "m:4" }, { key: "m:5" }], false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }, { key: "m:4" }, { key: "m:5" }],
				hasMore: false,
				atCapacity: false,
				incomplete: false,
			},
		]);

		// With the whole range covered, another loadOlder is a silent no-op and starts nothing.
		handle.loadOlder();
		await flush_deliveries();
		expect(startedWatches).toHaveLength(3);
	});

	test("loadOlder called synchronously from inside a delivery still grows the window", async () => {
		// The window flush calls the page's onUpdate directly, so a chitchat-style catch-up loop
		// (call loadOlder whenever an update still says hasMore) now runs inside the flush call
		// stack instead of behind a postMessage hop. The re-entrant call must behave like any
		// other loadOlder.
		const { api, startedWatches } = await make_data_api();
		let handle: { loadOlder: () => void; unsubscribe: () => void } | null = null;
		const onUpdate = vi.fn((update: { hasMore: boolean } | null) => {
			if (update?.hasMore) {
				handle?.loadOlder();
			}
		});
		handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);

		// The truncated head re-seats and flushes hasMore: the onUpdate above immediately asks
		// for older history, which must start the tail read right there.
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		expect(startedWatches).toHaveLength(3);
		expect(startedWatches[2]!.bounds).toEqual({ keyStartExclusive: "m:3" });

		await deliver(startedWatches[2]!, [{ key: "m:4" }], false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }, { key: "m:4" }],
				hasMore: false,
				atCapacity: false,
				incomplete: false,
			},
		]);
	});

	test("an arrival overflow splits the interval and the swap commits in one update", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		// The re-seated watcher confirms the same content: whole payload unchanged, no update.
		await deliver(startedWatches[1]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], false);
		expect(window_updates(onUpdate)).toHaveLength(1);

		// Two arrivals push the old docs past the page size: the interval re-reads as newest-3.
		await deliver(startedWatches[1]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], true);
		// The split starts left (.. lte previously-first key] and right (gt it .. old end].
		expect(startedWatches).toHaveLength(4);
		expect(startedWatches[2]!.bounds).toEqual({ keyEndInclusive: "m:1" });
		expect(startedWatches[3]!.bounds).toEqual({ keyStartExclusive: "m:1", keyEndInclusive: "m:3" });
		expect(window_updates(onUpdate)).toHaveLength(2);

		// One replacement delivering does not commit or post: the swap is all-or-nothing. The
		// right side goes first on purpose — a premature commit here would splice in an
		// undelivered left interval and the arrivals would vanish from the flattened list.
		await deliver(startedWatches[3]!, [{ key: "m:2" }, { key: "m:3" }], false);
		expect(window_updates(onUpdate)).toHaveLength(2);
		expect(startedWatches[1]!.disposed).toBe(false);

		await deliver(startedWatches[2]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], false);
		expect(startedWatches[1]!.disposed).toBe(true);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }, { key: "m:2" }, { key: "m:3" }],
				hasMore: true,
				atCapacity: false,
				incomplete: false,
			},
		]);
		expect(window_updates(onUpdate)).toHaveLength(3);
	});

	test("a split replaces only the interval it split, not the neighbour below it", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		// Load one older page first. The window then holds two intervals, so the split below
		// happens at an index that has a neighbour after it.
		handle.loadOlder();
		await deliver(startedWatches[2]!, [{ key: "m:4" }, { key: "m:5" }], false);
		expect(startedWatches).toHaveLength(3);

		// Arrivals overflow the FIRST of the two intervals: left is watch 3, right is watch 4.
		await deliver(startedWatches[1]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], true);
		expect(startedWatches).toHaveLength(5);
		expect(startedWatches[3]!.bounds).toEqual({ keyEndInclusive: "m:1" });
		expect(startedWatches[4]!.bounds).toEqual({ keyStartExclusive: "m:1", keyEndInclusive: "m:3" });

		await deliver(startedWatches[4]!, [{ key: "m:2" }, { key: "m:3" }], false);
		await deliver(startedWatches[3]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], false);

		// The commit swaps out the split interval alone. Taking the neighbour with it would stop
		// a live subscription and drop its docs out of the flattened list.
		expect(startedWatches[1]!.disposed).toBe(true);
		expect(startedWatches[2]!.disposed).toBe(false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [
					{ key: "m:0a" },
					{ key: "m:0b" },
					{ key: "m:1" },
					{ key: "m:2" },
					{ key: "m:3" },
					{ key: "m:4" },
					{ key: "m:5" },
				],
				hasMore: false,
				atCapacity: false,
				incomplete: false,
			},
		]);
	});

	test("a truncated interval whose only fencepost is its own bound reports incomplete", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		// A second bounded interval: the tail delivers truncated and re-seats onto (m:3 .. m:6].
		handle.loadOlder();
		await deliver(startedWatches[2]!, [{ key: "m:4" }, { key: "m:5" }, { key: "m:6" }], true);
		expect(startedWatches).toHaveLength(4);
		expect(startedWatches[3]!.bounds).toEqual({ keyStartExclusive: "m:3", keyEndInclusive: "m:6" });

		// Deletes leave that interval holding one doc, which is also its upper bound.
		await deliver(startedWatches[3]!, [{ key: "m:6" }], false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }, { key: "m:6" }],
				hasMore: true,
				atCapacity: false,
				incomplete: false,
			},
		]);

		// Three arrivals inside that range push m:6 out of the read. The split may only use the
		// previously delivered first key as its fencepost, and that key is m:6, the interval's
		// own bound. Splitting there would recreate the parent's exact args, so it is refused.
		// m:6 is now missing from the middle of the list, and the payload has to say so.
		await deliver(startedWatches[3]!, [{ key: "m:4a" }, { key: "m:4b" }, { key: "m:4c" }], true);
		expect(startedWatches).toHaveLength(4);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }, { key: "m:4a" }, { key: "m:4b" }, { key: "m:4c" }],
				hasMore: true,
				atCapacity: false,
				incomplete: true,
			},
		]);
	});

	test("an interval a pending split is already replacing is repaired, not incomplete", async () => {
		const harness = await make_data_api();
		const { startedWatches } = harness;
		const { onUpdate } = await grow_window(harness, "m:", 5);
		const olderPages = [2, 3, 4, 5].flatMap((interval) => [1, 2, 3].map((slot) => ({ key: `m:${interval}:${slot}` })));

		// Arrivals overflow the first interval. The split has room for a sixth interval. While it
		// runs, committed plus pending is 7, which is past the ceiling. That must not read as a
		// hole: the range is being re-read, not stuck.
		await deliver(startedWatches[1]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1:1" }], true);
		expect(startedWatches).toHaveLength(12);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1:1" }, ...olderPages],
				hasMore: true,
				atCapacity: false,
				incomplete: false,
			},
		]);

		// The swap commits and the two halves cover the whole parent range again.
		await deliver(startedWatches[11]!, [{ key: "m:1:2" }, { key: "m:1:3" }], false);
		await deliver(startedWatches[10]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1:1" }], false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [
					{ key: "m:0a" },
					{ key: "m:0b" },
					{ key: "m:1:1" },
					{ key: "m:1:2" },
					{ key: "m:1:3" },
					...olderPages,
				],
				hasMore: true,
				atCapacity: true,
				incomplete: false,
			},
		]);
	});

	test("a denial mid-split kills the whole window with exactly one null", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		await deliver(startedWatches[1]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], false);
		await deliver(startedWatches[1]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], true);
		expect(startedWatches).toHaveLength(4);

		// One pending replacement answers a denial: every watcher dies, committed and pending.
		startedWatches[2]!.onResult({ value: null });
		await flush_deliveries();
		expect(startedWatches.every((watch) => watch.disposed)).toBe(true);
		expect(window_updates(onUpdate).at(-1)).toEqual([null]);
		const updatesAfterKill = window_updates(onUpdate).length;

		// The other pending replacement's late delivery reaches a dead window: no update, and a
		// loadOlder on the dead handle starts nothing.
		await deliver(startedWatches[3]!, [{ key: "m:2" }], false);
		handle.loadOlder();
		await flush_deliveries();
		expect(window_updates(onUpdate)).toHaveLength(updatesAfterKill);
		expect(startedWatches).toHaveLength(4);
	});

	test("a cached truncated first delivery still re-seats and reports hasMore", async () => {
		const { api, startedWatches, seededResults } = await make_data_api();
		const onUpdate = vi.fn();

		// A sibling subscription with identical args leaves a cached result in the client, so
		// the head's first delivery arrives on the client's own setTimeout(0) instead of a later
		// server answer. The window must still see it AFTER its bookkeeping registered the
		// interval: the re-seat and the hasMore it implies must match the live path exactly.
		seededResults.push({ docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], truncated: true });
		api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await flush_deliveries();

		expect(startedWatches).toHaveLength(2);
		expect(startedWatches[1]!.bounds).toEqual({ keyEndInclusive: "m:3" });
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{ docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], hasMore: true, atCapacity: false, incomplete: false },
		]);
	});

	test("a cached denial at window start kills it without leaking the subscription", async () => {
		const { api, startedWatches, seededResults } = await make_data_api();
		const onUpdate = vi.fn();

		// The page retries a just-denied read as a window before the server confirms the
		// removal: the head's first read answers the cached null. The kill must find the started
		// interval — a missed dispose here would leak a subscription on the page's Convex client
		// until the page reloads.
		seededResults.push(null);
		api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await flush_deliveries();

		expect(startedWatches[0]!.disposed).toBe(true);
		expect(window_updates(onUpdate)).toEqual([[null]]);

		// The slot came back: a fresh watch starts instead of hitting a phantom ceiling.
		api.watch({ collection: "notes", limit: 10 }, vi.fn());
		expect(startedWatches).toHaveLength(2);
	});

	test("the interval ceiling reports atCapacity and refuses the next loadOlder", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);

		// Grow to the 6-interval ceiling: the head re-seats, then each loadOlder tail delivers
		// truncated and re-seats into a bounded interval of its own.
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		for (let round = 0; round < 5; round += 1) {
			handle.loadOlder();
			const tail = startedWatches[startedWatches.length - 1]!;
			const base = (round + 1) * 3;
			await deliver(tail, [{ key: `m:${base + 1}` }, { key: `m:${base + 2}` }, { key: `m:${base + 3}` }], true);
		}
		expect(startedWatches).toHaveLength(12);

		// Six intervals: the payload itself reports atCapacity while history stays open.
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: Array.from({ length: 18 }, (_, index) => ({ key: `m:${index + 1}` })),
				hasMore: true,
				atCapacity: true,
				incomplete: false,
			},
		]);

		// The seventh loadOlder starts nothing and posts nothing new: the refusal's payload
		// coalesces away because atCapacity was already on.
		const updatesAtCeiling = window_updates(onUpdate).length;
		handle.loadOlder();
		await flush_deliveries();
		expect(startedWatches).toHaveLength(12);
		expect(window_updates(onUpdate)).toHaveLength(updatesAtCeiling);
	});

	test("a split refused by the interval ceiling reports incomplete", async () => {
		const harness = await make_data_api();
		const { startedWatches } = harness;
		const { onUpdate } = await grow_window(harness, "m:", 6);
		expect(startedWatches).toHaveLength(12);

		// Arrivals overflow the window's newest range while all six interval slots are spent. The
		// split that would absorb them needs a seventh, so the range stays truncated and the docs
		// it can no longer reach are missing from the middle of the list.
		await deliver(startedWatches[1]!, [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1:1" }], true);
		expect(startedWatches).toHaveLength(12);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [
					{ key: "m:0a" },
					{ key: "m:0b" },
					{ key: "m:1:1" },
					...[2, 3, 4, 5, 6].flatMap((interval) => [1, 2, 3].map((slot) => ({ key: `m:${interval}:${slot}` }))),
				],
				hasMore: true,
				atCapacity: true,
				incomplete: true,
			},
		]);
	});

	test("adjacent intervals that shrink below one page merge back into one subscription", async () => {
		const { api, startedWatches } = await make_data_api();
		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onUpdate);
		await deliver(startedWatches[0]!, [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		handle.loadOlder();
		await deliver(startedWatches[2]!, [{ key: "m:4" }, { key: "m:5" }], false);
		expect(startedWatches).toHaveLength(3);

		// Physical deletes shrink the head interval: 1 + 2 = 3 docs still fill one page, so the
		// pair keeps its own subscriptions (one full page would re-split on the next arrival).
		await deliver(startedWatches[1]!, [{ key: "m:1" }], false);
		expect(startedWatches).toHaveLength(3);

		// The tail shrinks too: 1 + 1 = 2 docs fit one page, and the merge starts one
		// subscription over the combined range.
		await deliver(startedWatches[2]!, [{ key: "m:4" }], false);
		expect(startedWatches).toHaveLength(4);
		expect(startedWatches[3]!.bounds).toEqual({});
		// All-or-nothing: the replaced pair keeps delivering until the merged read has a result.
		expect(startedWatches[1]!.disposed).toBe(false);
		expect(startedWatches[2]!.disposed).toBe(false);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{ docs: [{ key: "m:1" }, { key: "m:4" }], hasMore: false, atCapacity: false, incomplete: false },
		]);

		// The commit swaps the pair out and reclaims their server slots. The flattened list is
		// unchanged, so the commit itself posts nothing.
		const updatesBeforeCommit = window_updates(onUpdate).length;
		await deliver(startedWatches[3]!, [{ key: "m:1" }, { key: "m:4" }], false);
		expect(startedWatches[1]!.disposed).toBe(true);
		expect(startedWatches[2]!.disposed).toBe(true);
		expect(window_updates(onUpdate)).toHaveLength(updatesBeforeCommit);
	});

	test("a window occupies one page-visible slot, and the ninth watch dies as capacity", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { api, startedWatches } = await make_data_api();

		api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, vi.fn());
		for (let index = 1; index <= 7; index += 1) {
			api.watch({ collection: "notes", limit: 10 }, vi.fn());
		}
		expect(startedWatches).toHaveLength(8);

		const onRefused = vi.fn();
		api.watch({ collection: "notes", limit: 10 }, onRefused);
		await flush_deliveries();
		expect(startedWatches).toHaveLength(8);
		expect(onRefused).toHaveBeenNthCalledWith(1, null, {
			reason: "capacity",
			message: "Subscription limit reached for this plugin frame",
		});
		expect(warnSpy).toHaveBeenCalled();
	});

	test("the ninth subscription dies as capacity when it is a window", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { api, startedWatches } = await make_data_api();

		for (let index = 1; index <= 8; index += 1) {
			api.watch({ collection: "notes", limit: 10 }, vi.fn());
		}
		expect(startedWatches).toHaveLength(8);

		// The eight page-visible slots refuse a window exactly like they refuse a plain watch.
		// The refusal names itself, so a page holding real slots closes one instead of reading
		// the death as access gone.
		const onRefused = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "m:", pageSize: 3 }, onRefused);
		await flush_deliveries();
		expect(startedWatches).toHaveLength(8);
		expect(onRefused).toHaveBeenNthCalledWith(1, null, {
			reason: "capacity",
			message: "Subscription limit reached for this plugin frame",
		});
		expect(warnSpy).toHaveBeenCalled();

		// Nothing was registered, so the handle has nothing to grow or dispose.
		handle.loadOlder();
		handle.unsubscribe();
		expect(startedWatches).toHaveLength(8);
	});

	// The page's server-subscription ceiling is the second, lower cap: 24 across the page, one
	// per plain watch and one per window interval. Four windows at their 6-interval limit spend
	// all 24 while holding only four of the eight page-visible slots.
	test("four fully-grown windows spend the page's 24 server subscriptions and refuse the next watch", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const harness = await make_data_api();
		const { api, startedWatches } = harness;
		const live_watches = () => startedWatches.filter((watch) => !watch.disposed);

		const { handle: firstWindow } = await grow_window(harness, "a:");
		await grow_window(harness, "b:");
		await grow_window(harness, "c:");
		await grow_window(harness, "d:");
		expect(live_watches()).toHaveLength(24);

		const onRefused = vi.fn();
		api.watch({ collection: "notes", limit: 10 }, onRefused);
		await flush_deliveries();
		expect(onRefused).toHaveBeenNthCalledWith(1, null, {
			reason: "capacity",
			message: "Subscription limit reached for this plugin frame",
		});
		expect(warnSpy).toHaveBeenCalled();
		// The ceiling is checked before the read starts, so the refusal subscribed to nothing.
		expect(live_watches()).toHaveLength(24);

		// Closing one window returns its six subscriptions and the same watch starts. That is
		// what proves the refusal above came from the 24-subscription ceiling: the page-visible
		// count only went from four windows to three, nowhere near the eight-slot cap.
		firstWindow.unsubscribe();
		expect(live_watches()).toHaveLength(18);
		api.watch({ collection: "notes", limit: 10 }, vi.fn());
		expect(live_watches()).toHaveLength(19);
	});

	test("the same spent budget kills a new window at birth with reason capacity", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await make_data_api();
		const { api, startedWatches } = harness;
		const live_watches = () => startedWatches.filter((watch) => !watch.disposed);

		const { handle: firstWindow } = await grow_window(harness, "a:");
		await grow_window(harness, "b:");
		await grow_window(harness, "c:");
		await grow_window(harness, "d:");
		expect(live_watches()).toHaveLength(24);

		// Four windows hold four of the eight page-visible slots, so only the 24-subscription
		// ceiling can refuse this one. Without the check here the window would be created and its
		// head read would fail on the spent budget. The page would then hear an unexplained null
		// and a console error, with nothing telling it to close a window first.
		const onRefused = vi.fn();
		const handle = api.watchWindow({ collection: "messages", keyPrefix: "e:", pageSize: 3 }, onRefused);
		await flush_deliveries();
		expect(live_watches()).toHaveLength(24);
		expect(onRefused).toHaveBeenNthCalledWith(1, null, {
			reason: "capacity",
			message: "Subscription limit reached for this plugin frame",
		});
		expect(warnSpy).toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();

		handle.loadOlder();
		handle.unsubscribe();
		expect(live_watches()).toHaveLength(24);

		// Closing one window returns its six subscriptions and the refused window opens, which
		// is what proves the refusal came from the 24-subscription ceiling: the page-visible
		// count only went from four windows to three, nowhere near the eight-slot cap.
		firstWindow.unsubscribe();
		expect(live_watches()).toHaveLength(18);
		api.watchWindow({ collection: "messages", keyPrefix: "e:", pageSize: 3 }, vi.fn());
		expect(live_watches()).toHaveLength(19);
	});

	test("a split refused by the page's spent server budget reports incomplete", async () => {
		const harness = await make_data_api();
		const { api, startedWatches } = harness;

		// Three full windows plus a two-interval one spend 20 subscriptions. Four plain watches
		// spend the last four. That fills the eight page-visible slots, and the small window
		// still has four of its own six interval slots free.
		await grow_window(harness, "a:");
		await grow_window(harness, "b:");
		await grow_window(harness, "c:");
		const { onUpdate } = await grow_window(harness, "d:", 2);
		for (let index = 1; index <= 4; index += 1) {
			api.watch({ collection: "notes", limit: 10 }, vi.fn());
		}
		const liveWindowWatches = startedWatches.filter((watch) => !watch.disposed && watch.queryArgs.keyPrefix === "d:");
		expect(liveWindowWatches).toHaveLength(2);

		// Arrivals overflow the small window's first interval. Its own interval budget allows the
		// split, but the page has no server subscription left to start it, so the range stays
		// truncated and the docs it dropped are missing from the middle of the list.
		await deliver(liveWindowWatches[0]!, [{ key: "d:0a" }, { key: "d:0b" }, { key: "d:1:1" }], true);
		expect(startedWatches.filter((watch) => !watch.disposed)).toHaveLength(24);
		expect(window_updates(onUpdate).at(-1)).toEqual([
			{
				docs: [
					{ key: "d:0a" },
					{ key: "d:0b" },
					{ key: "d:1:1" },
					{ key: "d:2:1" },
					{ key: "d:2:2" },
					{ key: "d:2:3" },
				],
				hasMore: true,
				atCapacity: true,
				incomplete: true,
			},
		]);
	});

	test("invalid window inputs die at birth and the handle is inert", async () => {
		const { api, startedWatches } = await make_data_api();

		const onUpdate = vi.fn();
		const handle = api.watchWindow({ collection: "a".repeat(129), pageSize: 10 }, onUpdate);
		await flush_deliveries();
		expect(onUpdate).toHaveBeenNthCalledWith(1, null, {
			reason: "invalid",
			message: "Collection names must be 1 to 128 characters",
		});
		handle.loadOlder();
		handle.unsubscribe();
		expect(startedWatches).toHaveLength(0);
	});
});

describe("data writes", () => {
	test("each op runs its own mutation and passes the Result through verbatim", async () => {
		const client = await connect_client();
		const instance = convex_instance();
		const appendResult = { _yay: { key: "r:0001:ab", revision: 1, byteSize: 12 } };
		const putResult = { _nay: { name: "conflict", message: "Revision mismatch" } };
		instance.mutation.mockImplementation((query: unknown) => {
			const name = getFunctionName(query as never);
			if (name === "plugins_data:user_append_document") {
				return Promise.resolve(appendResult);
			}
			if (name === "plugins_data:user_put_document") {
				return Promise.resolve(putResult);
			}
			return Promise.resolve({ _yay: { deleted: true } });
		});

		await expect(
			client.data.append({ collection: "replies", keyPrefix: "r:", value: { body: "yo" }, clientRequestId: "req_1" }),
		).resolves.toBe(appendResult);
		await expect(
			client.data.put({ collection: "messages", key: "m:1", value: { body: "hi" } }),
		).resolves.toBe(putResult);
		await expect(client.data.remove({ collection: "messages", key: "m:1" })).resolves.toEqual({
			_yay: { deleted: true },
		});
		await client.data.putOwned({ collection: "reactions", key: "m:1:heart", value: { on: true } });
		await client.data.removeOwned({ collection: "reactions", key: "m:1:heart" });

		const calls = instance.mutation.mock.calls.map((call) => [getFunctionName(call[0] as never), call[1]]);
		expect(calls).toEqual([
			[
				"plugins_data:user_append_document",
				{ collection: "replies", keyPrefix: "r:", value: { body: "yo" }, clientRequestId: "req_1" },
			],
			["plugins_data:user_put_document", { collection: "messages", key: "m:1", value: { body: "hi" } }],
			["plugins_data:user_remove_document", { collection: "messages", key: "m:1" }],
			["plugins_data:user_put_owned_document", { collection: "reactions", key: "m:1:heart", value: { on: true } }],
			["plugins_data:user_remove_owned_document", { collection: "reactions", key: "m:1:heart" }],
		]);
	});

	test("expectedRevision rides put, remove, putOwned, and removeOwned when given", async () => {
		const client = await connect_client();
		const instance = convex_instance();
		instance.mutation.mockResolvedValue({ _yay: {} });

		await client.data.put({ collection: "channels", key: "c:1", value: { name: "general" }, expectedRevision: 3 });
		await client.data.remove({ collection: "channels", key: "c:1", expectedRevision: 4 });
		// expectedRevision 0 means "the key must not exist yet" and must reach the args, not be
		// dropped as falsy.
		await client.data.putOwned({ collection: "profiles", key: "status", value: { text: "hi" }, expectedRevision: 0 });
		await client.data.removeOwned({ collection: "profiles", key: "status", expectedRevision: 1 });

		const args = instance.mutation.mock.calls.map((call) => call[1]);
		expect(args).toEqual([
			{ collection: "channels", key: "c:1", value: { name: "general" }, expectedRevision: 3 },
			{ collection: "channels", key: "c:1", expectedRevision: 4 },
			{ collection: "profiles", key: "status", value: { text: "hi" }, expectedRevision: 0 },
			{ collection: "profiles", key: "status", expectedRevision: 1 },
		]);
	});

	test("a thrown mutation resolves the stable generic _nay", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const client = await connect_client();
		convex_instance().mutation.mockRejectedValue(new Error("ArgumentValidationError"));

		await expect(client.data.put({ collection: "notes", key: "k1", value: { body: "hi" } })).resolves.toEqual({
			_nay: { message: "Failed to write plugin data" },
		});
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe("members.resolve", () => {
	test("resolves ids through the client and maps a null denial to an empty map", async () => {
		const client = await connect_client();
		const instance = convex_instance();
		instance.query.mockResolvedValueOnce({ members: { user_2: "Ada", user_gone: null } }).mockResolvedValueOnce(null);

		await expect(client.members.resolve(["user_2", "user_gone"])).resolves.toEqual({ user_2: "Ada", user_gone: null });
		expect(getFunctionName(instance.query.mock.calls[0]?.[0] as never)).toBe("plugins_data:resolve_member_display");
		expect(instance.query.mock.calls[0]?.[1]).toEqual({ userIds: ["user_2", "user_gone"] });

		await expect(client.members.resolve(["user_3"])).resolves.toEqual({});
	});

	test("a failed query resolves an empty map instead of rejecting", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const client = await connect_client();
		convex_instance().query.mockRejectedValue(new Error("network"));

		await expect(client.members.resolve(["user_1"])).resolves.toEqual({});
		expect(errorSpy).toHaveBeenCalled();
	});
});
