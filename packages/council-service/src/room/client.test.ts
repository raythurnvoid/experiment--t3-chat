// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";

import { council_room_client_js } from "./client.ts";
import { council_room_page_html } from "./page.ts";

/**
 * Behavioral harness for the room's inline script: the real page HTML goes into happy-dom, the
 * real client script string is executed against it, and the provider SDK plus the Worker API are
 * stubbed. This drives the script the way a browser does — clicks and rendered text — instead of
 * asserting on the script's source string.
 */

type FakeSdk = {
	join: ReturnType<typeof vi.fn>;
	leave: ReturnType<typeof vi.fn>;
	self: {
		roomJoined: boolean;
		audioEnabled: boolean;
		enableAudio: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
	};
	participants: { joined: { on: ReturnType<typeof vi.fn>; toArray: () => unknown[] } };
	recording: { on: ReturnType<typeof vi.fn>; recordingState: string };
};

function make_fake_sdk(): FakeSdk {
	return {
		join: vi.fn(() => Promise.resolve()),
		leave: vi.fn(() => Promise.resolve()),
		self: {
			roomJoined: true,
			audioEnabled: false,
			enableAudio: vi.fn(() => Promise.resolve()),
			on: vi.fn(),
		},
		participants: { joined: { on: vi.fn(), toArray: () => [] } },
		recording: { on: vi.fn(), recordingState: "IDLE" },
	};
}

const SESSION_ANSWER = {
	csrfToken: "csrf-1",
	meeting: { id: "m1", title: "Test meeting", status: "open", deadlineAt: null },
	participant: { id: "p1", displayName: "Ada Host", role: "host" },
};

function load_room_document() {
	// The served HTML includes the client script. happy-dom runs inline scripts on innerHTML,
	// so strip them and execute `council_room_client_js` once through `new Function`.
	document.documentElement.innerHTML = council_room_page_html()
		.replace(/^<!doctype html>/u, "")
		.replace(/<script\b[\s\S]*?<\/script>/giu, "");
}

/**
 * Load the page DOM, stub fetch and the SDK global, run the client script, and wait for the host
 * lobby. The host entry ticket is planted directly; the boot script's fragment handling has its
 * own coverage in page.test.ts.
 */
async function boot_to_lobby(sdk: FakeSdk) {
	load_room_document();

	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string, init?: RequestInit) => {
			if (path === "/room/api/session") {
				return new Response(JSON.stringify(SESSION_ANSWER), { status: 200 });
			}
			if (path === "/room/api/join") {
				return new Response(JSON.stringify({ authToken: "provider-token" }), { status: 200 });
			}
			return new Response(JSON.stringify({ message: `no test handler for ${path}${init ? "" : ""}` }), { status: 500 });
		}),
	);
	vi.stubGlobal("RealtimeKitClient", { init: vi.fn(() => Promise.resolve(sdk)) });
	(window as { __councilEntry?: { ticket: string | null } }).__councilEntry = { ticket: "ticket-1" };

	new Function(council_room_client_js)();

	await vi.waitFor(() => {
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("council_room_client_js join failure", () => {
	test("a failed join leaves the SDK and re-arms the join button", async () => {
		const sdk = make_fake_sdk();
		sdk.join = vi.fn(() => Promise.reject(new Error("join blew up")));
		await boot_to_lobby(sdk);

		const joinButton = document.getElementById("join-button") as HTMLButtonElement;
		joinButton.click();

		await vi.waitFor(() => {
			expect(document.getElementById("lobby-error")!.textContent).toBe("join blew up");
		});
		// The half-joined SDK must not stay live behind the retry button.
		expect(sdk.leave).toHaveBeenCalled();
		expect(joinButton.disabled).toBe(false);
	});
});

describe("council_room_client_js host display name", () => {
	test("the host lobby asks for a display name when the session has none", async () => {
		const sdk = make_fake_sdk();
		load_room_document();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (path: string) => {
				if (path === "/room/api/session") {
					return new Response(
						JSON.stringify({
							...SESSION_ANSWER,
							participant: { id: "p1", displayName: "", role: "host" },
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ message: `no test handler for ${path}` }), { status: 500 });
			}),
		);
		vi.stubGlobal("RealtimeKitClient", { init: vi.fn(() => Promise.resolve(sdk)) });
		(window as { __councilEntry?: { ticket: string | null } }).__councilEntry = { ticket: "ticket-1" };
		new Function(council_room_client_js)();

		await vi.waitFor(() => {
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});
		expect(document.getElementById("host-name-field")!.hidden).toBe(false);

		const joinButton = document.getElementById("join-button") as HTMLButtonElement;
		joinButton.click();
		expect(document.getElementById("lobby-error")!.textContent).toBe("Enter the name to show to other participants.");
		expect(joinButton.disabled).toBe(false);
	});
});

describe("council_room_client_js microphone refusal", () => {
	test("the mic guidance survives the initial render instead of being clobbered", async () => {
		const sdk = make_fake_sdk();
		sdk.self.enableAudio = vi.fn(() => Promise.reject(new Error("denied")));
		await boot_to_lobby(sdk);

		(document.getElementById("join-button") as HTMLButtonElement).click();

		await vi.waitFor(() => {
			expect(document.getElementById("view-call")!.hidden).toBe(false);
		});
		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. Allow microphone access, then press Unmute microphone.",
		);
	});
});

describe("council_room_client_js ticket after join", () => {
	test("a later hash ticket takes over the lobby instead of painting Meeting ended", async () => {
		let roomLeft: (() => void) | undefined;
		const sdk = make_fake_sdk();
		sdk.self.on = vi.fn((event: string, handler: () => void) => {
			if (event === "roomLeft") {
				roomLeft = handler;
			}
		});
		sdk.leave = vi.fn(() => {
			return Promise.resolve().then(() => {
				roomLeft?.();
			});
		});
		await boot_to_lobby(sdk);

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(document.getElementById("view-call")!.hidden).toBe(false);
		});
		expect(document.getElementById("view-lobby")!.hidden).toBe(true);

		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));

		await vi.waitFor(() => {
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});
		await vi.waitFor(() => {
			expect(sdk.leave).toHaveBeenCalled();
		});
		await Promise.resolve();
		expect(document.getElementById("view-ended")!.hidden).toBe(true);
		expect((document.getElementById("join-button") as HTMLButtonElement).disabled).toBe(false);
	});

	test("ignores an old join response after a fresh ticket restores the lobby", async () => {
		const sdk = make_fake_sdk();
		let resolveJoin!: (response: Response) => void;
		const joinResponse = new Promise<Response>((resolve) => {
			resolveJoin = resolve;
		});
		load_room_document();
		const fetchMock = vi.fn(async (path: string) => {
			if (path === "/room/api/session") {
				return new Response(JSON.stringify(SESSION_ANSWER), { status: 200 });
			}
			if (path === "/room/api/join") {
				return await joinResponse;
			}
			return new Response(JSON.stringify({ message: `no test handler for ${path}` }), { status: 500 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const init = vi.fn(() => Promise.resolve(sdk));
		vi.stubGlobal("RealtimeKitClient", { init });
		(window as { __councilEntry?: { ticket: string | null } }).__councilEntry = { ticket: "ticket-1" };
		new Function(council_room_client_js)();

		await vi.waitFor(() => {
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(fetchMock.mock.calls.some(([path]) => path === "/room/api/join")).toBe(true);
		});

		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => {
			expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/session")).toHaveLength(2);
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});

		resolveJoin(new Response(JSON.stringify({ authToken: "old-provider-token" }), { status: 200 }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(init).not.toHaveBeenCalled();
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
	});

	test("does not let an old leave completion paint ended over a fresh lobby", async () => {
		let resolveLeave!: () => void;
		const leave = new Promise<void>((resolve) => {
			resolveLeave = resolve;
		});
		const sdk = make_fake_sdk();
		sdk.leave = vi.fn(() => leave);
		await boot_to_lobby(sdk);

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(document.getElementById("view-call")!.hidden).toBe(false);
		});
		(document.getElementById("leave-button") as HTMLButtonElement).click();

		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => {
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});

		resolveLeave();
		await Promise.resolve();
		await Promise.resolve();
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		expect(document.getElementById("view-ended")!.hidden).toBe(true);
	});
});

describe("council_room_client_js roster", () => {
	test("drops a reconnect ghost that reused the same custom participant id", async () => {
		const sdk = make_fake_sdk();
		Object.assign(sdk.self, { id: "self-1", customParticipantId: "host-1", name: "Ada Host" });
		sdk.participants.joined.toArray = () => [
			{ id: "ghost-2", customParticipantId: "host-1", name: "Ada Host" },
			{ id: "other-1", customParticipantId: "guest-1", name: "Casey" },
			{ id: "twin-1", customParticipantId: "guest-2", name: "Ada Host" },
		];
		await boot_to_lobby(sdk);

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(document.getElementById("view-call")!.hidden).toBe(false);
		});

		const labels = [...document.querySelectorAll("#participant-list li")].map((item) => item.textContent);
		expect(labels).toEqual(["Ada Host (you)", "Casey", "Ada Host"]);
	});
});
