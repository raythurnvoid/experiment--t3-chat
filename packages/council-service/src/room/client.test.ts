// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { council_room_client_js } from "./client.ts";
import { council_room_page_html } from "./page.ts";

type EventHandler = (payload?: unknown) => void;

class FakeEmitter {
	private handlers = new Map<string, Set<EventHandler>>();

	on = vi.fn((event: string, handler: EventHandler) => {
		let eventHandlers = this.handlers.get(event);
		if (!eventHandlers) {
			eventHandlers = new Set();
			this.handlers.set(event, eventHandlers);
		}
		eventHandlers.add(handler);
		return this;
	});

	off = vi.fn((event: string, handler: EventHandler) => {
		this.handlers.get(event)?.delete(handler);
		return this;
	});

	emit(event: string, payload?: unknown) {
		for (const handler of [...(this.handlers.get(event) ?? [])]) {
			handler(payload);
		}
	}
}

type FakeParticipant = FakeEmitter & {
	id: string;
	customParticipantId: string;
	name: string;
	videoEnabled: boolean;
	audioEnabled: boolean;
	videoTrack: MediaStreamTrack | null;
	audioTrack: MediaStreamTrack | null;
};

type FakeSelf = FakeParticipant & {
	roomJoined: boolean;
	enableAudio: ReturnType<typeof vi.fn>;
	disableAudio: ReturnType<typeof vi.fn>;
	enableVideo: ReturnType<typeof vi.fn>;
	disableVideo: ReturnType<typeof vi.fn>;
};

class FakeParticipantMap extends FakeEmitter {
	participants: FakeParticipant[] = [];

	toArray() {
		return this.participants;
	}
}

type FakeRecording = FakeEmitter & { recordingState: string };
type FakeMeta = FakeEmitter & { meetingStartedTimestamp: Date };

type FakeSdk = {
	join: ReturnType<typeof vi.fn>;
	leave: ReturnType<typeof vi.fn>;
	self: FakeSelf;
	// audioSubscribed is the SDK's map of the peers whose audio this browser really receives, keyed
	// by peer id. Tests that stay under the subscription limit leave it out, the way an older
	// provider build would.
	participants: { joined: FakeParticipantMap; audioSubscribed?: { has: (peerId: string) => boolean } };
	recording: FakeRecording;
	meta: FakeMeta;
};

type CouncilWindow = Window &
	typeof globalThis & {
		__councilEntry?: { ticket: string | null };
		__councilDispose?: () => void;
	};

type FetchHandler = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const HOST_SESSION = {
	csrfToken: "csrf-1",
	meeting: { id: "m1", title: "Product design review", status: "open", deadlineAt: null, recordingStarted: false },
	participant: { id: "p1", displayName: "Ada Host", role: "host" },
};

const GUEST_SESSION = {
	...HOST_SESSION,
	participant: { id: "p2", displayName: "Casey Guest", role: "guest" },
};

function make_track(kind: "audio" | "video", id: string) {
	return { kind, id } as MediaStreamTrack;
}

function make_participant(
	id: string,
	customParticipantId: string,
	name: string,
	overrides: Partial<Pick<FakeParticipant, "videoEnabled" | "audioEnabled" | "videoTrack" | "audioTrack">> = {},
) {
	return Object.assign(new FakeEmitter(), {
		id,
		customParticipantId,
		name,
		videoEnabled: false,
		audioEnabled: false,
		videoTrack: null,
		audioTrack: null,
		...overrides,
	}) as FakeParticipant;
}

function make_fake_sdk(): FakeSdk {
	const self = make_participant("self-1", "host-1", "Ada Host") as FakeSelf;
	self.roomJoined = true;
	self.enableAudio = vi.fn(async () => {
		self.audioEnabled = true;
		self.emit("audioUpdate", { audioEnabled: true, audioTrack: self.audioTrack });
	});
	self.disableAudio = vi.fn(async () => {
		self.audioEnabled = false;
		self.emit("audioUpdate", { audioEnabled: false, audioTrack: self.audioTrack });
	});
	self.enableVideo = vi.fn(async () => {
		self.videoEnabled = true;
		self.emit("videoUpdate", { videoEnabled: true, videoTrack: self.videoTrack });
	});
	self.disableVideo = vi.fn(async () => {
		self.videoEnabled = false;
		self.emit("videoUpdate", { videoEnabled: false, videoTrack: self.videoTrack });
	});

	return {
		join: vi.fn(() => Promise.resolve()),
		leave: vi.fn(() => Promise.resolve()),
		self,
		participants: { joined: new FakeParticipantMap() },
		recording: Object.assign(new FakeEmitter(), { recordingState: "IDLE" }),
		meta: Object.assign(new FakeEmitter(), { meetingStartedTimestamp: new Date(Date.now() - 65_000) }),
	};
}

function load_room_document() {
	(window as CouncilWindow).__councilDispose?.();
	document.documentElement.innerHTML = council_room_page_html()
		.replace(/^<!doctype html>/u, "")
		.replace(/<script\b[\s\S]*?<\/script>/giu, "");
}

async function boot_to_lobby(
	sdk: FakeSdk,
	options: {
		session?: typeof HOST_SESSION;
		fetchHandler?: FetchHandler;
		init?: ReturnType<typeof vi.fn>;
	} = {},
) {
	load_room_document();
	const session = options.session ?? HOST_SESSION;
	const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
		const customResponse = options.fetchHandler?.(path, init);
		if (customResponse !== undefined) {
			return await customResponse;
		}
		if (path === "/room/api/session") {
			return new Response(JSON.stringify(session), { status: 200 });
		}
		if (path === "/room/api/join") {
			return new Response(JSON.stringify({ authToken: "provider-token" }), { status: 200 });
		}
		if (path === "/room/api/state") {
			return new Response(JSON.stringify({ meeting: { ...session.meeting, status: "open" } }), { status: 200 });
		}
		return new Response(JSON.stringify({ message: `no test handler for ${path}` }), { status: 500 });
	});
	const init = options.init ?? vi.fn(() => Promise.resolve(sdk));
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("RealtimeKitClient", { init });
	(window as CouncilWindow).__councilEntry = { ticket: "ticket-1" };

	new Function(council_room_client_js)();

	await vi.waitFor(() => {
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
	});
	return { fetchMock, init };
}

async function boot_to_call(sdk: FakeSdk, options: Parameters<typeof boot_to_lobby>[1] = {}) {
	const harness = await boot_to_lobby(sdk, options);
	(document.getElementById("join-button") as HTMLButtonElement).click();
	await vi.waitFor(() => {
		expect(document.getElementById("view-call")!.hidden).toBe(false);
	});
	return harness;
}

beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
	(window as CouncilWindow).__councilDispose?.();
	delete (window as CouncilWindow).__councilDispose;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("council_room_client_js guest entry", () => {
	test("times out a hanging invite check and restores Continue", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		let guestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string, init?: RequestInit) => {
				if (path === "/room/api/session") {
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				if (path === "/room/api/guest-session") {
					guestSignal = init?.signal ?? undefined;
					return new Promise<Response>((_resolve, reject) => {
						guestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
					});
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));
		(document.getElementById("guest-code") as HTMLInputElement).value = "invite-code";
		(document.getElementById("guest-name") as HTMLInputElement).value = "Casey";
		vi.useFakeTimers();

		(document.getElementById("guest-form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		const submit = document.getElementById("guest-submit") as HTMLButtonElement;
		// The pending state is aria-busy, never disabled: a disabled control drops keyboard focus to
		// the body and never gets it back, and this is the only control the guest form has.
		expect(submit.getAttribute("aria-busy")).toBe("true");
		expect(submit.disabled).toBe(false);
		expect(submit.textContent).toBe("Checking invite…");
		await vi.advanceTimersByTimeAsync(30_000);

		expect(guestSignal?.aborted).toBe(true);
		expect(submit.getAttribute("aria-busy")).toBe(null);
		expect(submit.textContent).toBe("Continue");
		expect(document.getElementById("guest-error")!.textContent).toContain("took too long");
	});

	test("keeps the invite button usable during the check and ignores a repeat press", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		let guestCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string) => {
				if (path === "/room/api/session") {
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				if (path === "/room/api/guest-session") {
					guestCalls += 1;
					return new Promise<Response>(() => {});
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));
		(document.getElementById("guest-code") as HTMLInputElement).value = "invite-code";
		(document.getElementById("guest-name") as HTMLInputElement).value = "Casey";
		const form = document.getElementById("guest-form") as HTMLFormElement;
		const submit = document.getElementById("guest-submit") as HTMLButtonElement;

		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(guestCalls).toBe(1);
		// happy-dom does not blur a focused control when it turns disabled, so asserting on
		// activeElement here would pass whatever the client does. Assert the shape that decides it
		// in a real browser instead: the button never turns disabled, it only marks itself busy.
		expect(submit.getAttribute("aria-busy")).toBe("true");
		expect(submit.disabled).toBe(false);

		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(guestCalls).toBe(1);
	});

	test("refuses a display name past the server byte cap before spending an attempt", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		let guestCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string) => {
				if (path === "/room/api/session") {
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				if (path === "/room/api/guest-session") {
					guestCalls += 1;
					return new Promise<Response>(() => {});
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));
		const nameInput = document.getElementById("guest-name") as HTMLInputElement;
		(document.getElementById("guest-code") as HTMLInputElement).value = "invite-code";
		// 44 CJK characters: 44 UTF-16 units, so no length limit in the markup catches them, and 132
		// UTF-8 bytes, so the server refuses them. Its answer is the raw validator line "displayName
		// is longer than 128 bytes", and the try still costs one of the guest-join attempts the
		// server allows per address in ten minutes, because it charges that bucket before it reads
		// the body. The count lives in council_RATE_LIMITS in db.ts; naming it here is what made
		// this line and the one in client.ts go stale when it was raised.
		nameInput.value = "名".repeat(44);
		expect(new TextEncoder().encode(nameInput.value).length).toBe(132);

		(document.getElementById("guest-form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);

		expect(guestCalls).toBe(0);
		expect(document.getElementById("guest-error")!.textContent).toBe(
			"That display name is too long. Try a shorter one.",
		);
		expect(nameInput.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(nameInput);
		// #guest-error is role="alert", so it speaks once and is never read again. This form refuses
		// on four different grounds and marks the same two boxes, so a guest who tabs away and comes
		// back has to be able to hear which one applied from the field itself.
		expect(nameInput.getAttribute("aria-describedby")).toBe("guest-name-hint guest-error");
		// Only the refused field describes the refusal.
		expect(document.getElementById("guest-code")!.getAttribute("aria-describedby")).toBe("guest-code-hint");

		// An empty code is refused first, and the description follows the box that is now wrong.
		nameInput.value = "Casey";
		(document.getElementById("guest-code") as HTMLInputElement).value = "";
		(document.getElementById("guest-form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		expect(document.getElementById("guest-code")!.getAttribute("aria-describedby")).toBe(
			"guest-code-hint guest-error",
		);
		expect(nameInput.getAttribute("aria-describedby")).toBe("guest-name-hint");
		expect(nameInput.getAttribute("aria-invalid")).toBeNull();
	});

	test("names the meeting the page was opened for when it resumes a cookie session", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-7");
		let resumeBody: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string, init?: RequestInit) => {
				if (path === "/room/api/session") {
					resumeBody = typeof init?.body === "string" ? init.body : undefined;
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));

		// One room cookie covers every meeting on this origin. If the page does not say which meeting
		// it was opened for, the service resumes whatever meeting this visitor was in last and puts
		// them back into it.
		expect(JSON.parse(resumeBody ?? "{}")).toEqual({ meetingId: "meeting-7" });
	});

	test("keeps a resume that never reached the service off the join-code form", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string) => {
				if (path === "/room/api/session") {
					// This is how every failure to reach the service rejects: a reset connection, a DNS
					// blip on a keep-alive re-dial, a blocking extension, a proxy, a network handover
					// mid-load. The error carries no status, because no service answered it.
					return Promise.reject(new TypeError("Failed to fetch"));
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-error")!.hidden).toBe(false));

		// A host holds a room cookie and never had a join code — the code is the guest invite. Only a
		// refusal from the service says their cookie is no good. A request that never arrived says
		// nothing about it, so sending them to the guest form asks for a code they cannot have, and
		// that screen has nothing to press to try again.
		expect(document.getElementById("error-message")!.textContent).toContain("did not answer");
		expect(document.getElementById("view-guest")!.hidden).toBe(true);
	});

	test("still sends a session the service refused to the join-code form", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string) => {
				if (path === "/room/api/session") {
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));

		// Keep this beside the test above. A refusal is the normal answer for a visitor with no room
		// cookie, and the join code is their way in, so widening the fatal branch must not swallow it.
		expect(document.getElementById("view-error")!.hidden).toBe(true);
	});

	test("marks and focuses the join code when the server refuses it", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		vi.stubGlobal(
			"fetch",
			vi.fn((path: string) => {
				if (path === "/room/api/session") {
					return Promise.resolve(new Response(JSON.stringify({ message: "No session" }), { status: 401 }));
				}
				if (path === "/room/api/guest-session") {
					// A mistyped code is the one thing this route answers 401 for. Every other refusal
					// it can give is a 400 or a 409 about something else.
					return Promise.resolve(
						new Response(JSON.stringify({ message: "The meeting code is not right; check it and try again" }), {
							status: 401,
						}),
					);
				}
				return Promise.resolve(new Response(JSON.stringify({ message: "Unexpected" }), { status: 500 }));
			}),
		);
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-guest")!.hidden).toBe(false));
		const codeInput = document.getElementById("guest-code") as HTMLInputElement;
		codeInput.value = "wrong-code";
		(document.getElementById("guest-name") as HTMLInputElement).value = "Casey";

		(document.getElementById("guest-form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		await vi.waitFor(() =>
			expect(document.getElementById("guest-error")!.textContent).toContain("The meeting code is not right"),
		);

		// The form's own checks mark the field they refuse and put focus on it. The server refusal is
		// the far more common one, and it used to leave the guest on the submit button with nothing
		// marking the box they have to fix.
		expect(codeInput.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(codeInput);
		// And the server's own sentence has to reach the guest again when they come back to the box,
		// not only in the one announcement #guest-error makes as it appears.
		expect(codeInput.getAttribute("aria-describedby")).toBe("guest-code-hint guest-error");
	});
});

describe("council_room_client_js join operation", () => {
	test("shows progress immediately and leaves a failed SDK before retry", async () => {
		const sdk = make_fake_sdk();
		sdk.join = vi.fn(() => Promise.reject(new Error("provider token details")));
		await boot_to_lobby(sdk);

		const joinButton = document.getElementById("join-button") as HTMLButtonElement;
		joinButton.click();
		expect(joinButton.getAttribute("aria-busy")).toBe("true");
		expect(joinButton.disabled).toBe(false);
		expect(joinButton.textContent).toBe("Joining…");
		expect(document.getElementById("lobby-progress")!.textContent).not.toBe("");

		await vi.waitFor(() => {
			expect(document.getElementById("lobby-error")!.textContent).toBe(
				"Could not enter the meeting. Check your connection, then try again.",
			);
		});
		expect(document.getElementById("lobby-error")!.textContent).not.toContain("provider token details");
		expect(sdk.leave).toHaveBeenCalled();
		expect(joinButton.getAttribute("aria-busy")).toBe(null);
		expect(joinButton.disabled).toBe(false);
	});

	test("keeps the join button usable during admission and ignores a repeat press", async () => {
		const sdk = make_fake_sdk();
		let joinCalls = 0;
		await boot_to_lobby(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/join") return undefined;
				joinCalls += 1;
				return new Promise<Response>(() => {});
			},
		});
		const joinButton = document.getElementById("join-button") as HTMLButtonElement;

		joinButton.click();
		expect(joinCalls).toBe(1);
		// happy-dom does not blur a focused control when it turns disabled, so an activeElement
		// assertion here could not fail. Assert the shape that decides it in a real browser: the
		// button never turns disabled, so the lobby keeps something to tab to for the whole wait.
		expect(joinButton.getAttribute("aria-busy")).toBe("true");
		expect(joinButton.disabled).toBe(false);

		// joinMeeting cancels the join in progress on every call, so the repeat press this allows
		// must be ignored instead of cancelling and restarting the admission already running.
		joinButton.click();
		expect(joinCalls).toBe(1);
	});

	test("aborts an admission request at the whole-join deadline", async () => {
		const sdk = make_fake_sdk();
		let requestSignal: AbortSignal | undefined;
		await boot_to_lobby(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/join") return undefined;
				requestSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			},
		});
		vi.useFakeTimers();

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(requestSignal?.aborted).toBe(true);
		expect(document.getElementById("lobby-error")!.textContent).toContain("Joining took too long");
		expect((document.getElementById("join-button") as HTMLButtonElement).disabled).toBe(false);
	});

	test("leaves an SDK whose init finishes after the deadline", async () => {
		const sdk = make_fake_sdk();
		let resolveInit!: (sdk: FakeSdk) => void;
		const init = vi.fn(
			() =>
				new Promise<FakeSdk>((resolve) => {
					resolveInit = resolve;
				}),
		);
		await boot_to_lobby(sdk, { init });
		vi.useFakeTimers();

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(init).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		resolveInit(sdk);
		await Promise.resolve();
		await Promise.resolve();

		expect(sdk.leave).toHaveBeenCalled();
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
	});

	test("keeps an abandoned join from taking the live one's SDK", async () => {
		const abandoned = make_fake_sdk();
		const live = make_fake_sdk();
		let resolveAbandonedInit!: (sdk: FakeSdk) => void;
		let resolveLiveInit!: (sdk: FakeSdk) => void;
		const init = vi.fn(() => {
			if (init.mock.calls.length === 1) {
				return new Promise<FakeSdk>((resolve) => {
					resolveAbandonedInit = resolve;
				});
			}
			return new Promise<FakeSdk>((resolve) => {
				resolveLiveInit = resolve;
			});
		});
		await boot_to_lobby(abandoned, { init });
		vi.useFakeTimers();
		const joinButton = document.getElementById("join-button") as HTMLButtonElement;

		joinButton.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(init).toHaveBeenCalledTimes(1);

		// The first join gives up at its deadline and the host presses Join again. The test at the
		// deadline above stops here, and with state.joinOperation back to null the first clause of
		// isJoinActive answers on its own. A second press fills it again, and from then on only the
		// operation id can tell the abandoned answer apart from the live join's own.
		await vi.advanceTimersByTimeAsync(30_000);
		joinButton.click();
		await vi.advanceTimersByTimeAsync(0);
		expect(init).toHaveBeenCalledTimes(2);

		// The abandoned init answers while the live join is still waiting for its own SDK.
		resolveAbandonedInit(abandoned);
		await vi.advanceTimersByTimeAsync(0);
		expect(abandoned.join).not.toHaveBeenCalled();
		expect(abandoned.leave).toHaveBeenCalled();

		resolveLiveInit(live);
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));
		expect(live.join).toHaveBeenCalled();
	});

	test("leaves when sdk.join finishes after the deadline", async () => {
		const sdk = make_fake_sdk();
		let resolveJoin!: () => void;
		sdk.join = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveJoin = resolve;
				}),
		);
		await boot_to_lobby(sdk);
		vi.useFakeTimers();

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(sdk.join).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		resolveJoin();
		await Promise.resolve();
		await Promise.resolve();

		expect(sdk.leave).toHaveBeenCalled();
		expect(document.getElementById("view-call")!.hidden).toBe(true);
	});

	test("times out while waiting for roomJoined after sdk.join resolves", async () => {
		const sdk = make_fake_sdk();
		sdk.self.roomJoined = false;
		await boot_to_lobby(sdk);
		vi.useFakeTimers();

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(sdk.leave).toHaveBeenCalled();
		expect(document.getElementById("lobby-error")!.textContent).toContain("Joining took too long");
	});

	test("times out while microphone setup is still pending", async () => {
		const sdk = make_fake_sdk();
		sdk.self.audioEnabled = false;
		sdk.self.enableAudio = vi.fn(() => new Promise<void>(() => {}));
		await boot_to_lobby(sdk);
		vi.useFakeTimers();

		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(sdk.self.enableAudio).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(sdk.leave).toHaveBeenCalled();
		expect(document.getElementById("lobby-error")!.textContent).toContain("Joining took too long");
		expect(document.getElementById("view-call")!.hidden).toBe(true);
	});

	test("takes the session token back once and joins the meeting anyway", async () => {
		const sdk = make_fake_sdk();
		let joinCalls = 0;
		const joinTokens: (string | null)[] = [];
		const sessionBodies: string[] = [];
		await boot_to_lobby(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/session") {
					sessionBodies.push(String(init?.body));
					// Number the token from the call count, never from a fixed pair. A fixture that
					// hands out the same token twice makes "the token changed" compare two equal
					// values, and the test then passes with the refresh removed.
					return new Response(JSON.stringify({ ...HOST_SESSION, csrfToken: `csrf-${sessionBodies.length}` }), {
						status: 200,
					});
				}
				if (path !== "/room/api/join") return undefined;
				joinCalls += 1;
				joinTokens.push(new Headers(init?.headers).get("X-Council-Csrf"));
				// A second document on this same room URL resumed the cookie session, which rotates
				// the CSRF token, so the token this lobby still holds is refused.
				if (joinCalls === 1) {
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				return new Response(JSON.stringify({ authToken: "provider-token" }), { status: 200 });
			},
		});

		(document.getElementById("join-button") as HTMLButtonElement).click();
		// Before this, Join was the one route that checked the token without the refresh: the lobby
		// showed the bare word "Unauthorized" and every further press repeated it, so only a reload
		// got into the meeting, and that reload broke the other tab the same way.
		await vi.waitFor(() => expect(joinTokens).toEqual(["csrf-1", "csrf-2"]));
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		expect(joinCalls).toBe(2);
		expect(document.getElementById("lobby-error")!.hidden).toBe(true);
		// The refresh names the meeting this page is in, the way the in-call routes do.
		expect(sessionBodies[1]).toBe(JSON.stringify({ meetingId: "m1" }));
	});
});

describe("council_room_client_js lobby", () => {
	test("asks a host with no stored name before join", async () => {
		const sdk = make_fake_sdk();
		await boot_to_lobby(sdk, {
			session: {
				...HOST_SESSION,
				participant: { id: "p1", displayName: "", role: "host" },
			},
		});

		expect(document.getElementById("host-name-field")!.hidden).toBe(false);
		(document.getElementById("join-button") as HTMLButtonElement).click();
		expect(document.getElementById("lobby-error")!.textContent).toBe("Enter the name to show to other participants.");
		expect(document.activeElement).toBe(document.getElementById("host-name"));
	});

	test("joins on a lobby form submit, which is what Enter in the name field fires", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_lobby(sdk, {
			session: {
				...HOST_SESSION,
				participant: { id: "p1", displayName: "", role: "host" },
			},
		});
		const nameInput = document.getElementById("host-name") as HTMLInputElement;
		// The field is required while it is shown, but the markup cannot say so with `required`: it
		// is hidden for a host who already has a name, and a hidden control is still
		// constraint-validated, so the submit would be blocked for all of those hosts.
		expect(nameInput.getAttribute("aria-required")).toBe("true");
		nameInput.value = "Ada Host";

		// happy-dom has no implicit submission, so Enter cannot be typed here. In a browser that key
		// fires the form's default button and raises this exact event, and page.test.ts pins the two
		// markup facts that make Join that default button. What this test owns is the other half: the
		// client listens on the form's submit, not only on a click on the button, so the key reaches
		// joinMeeting at all.
		(document.getElementById("lobby-form") as HTMLFormElement).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);

		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));
		const joinCalls = fetchMock.mock.calls.filter(([path]) => path === "/room/api/join");
		expect(joinCalls).toHaveLength(1);
		expect(JSON.parse(String(joinCalls[0][1]?.body))).toEqual({ displayName: "Ada Host" });
	});

	test("refuses a host display name past the server byte cap before asking for admission", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_lobby(sdk, {
			session: {
				...HOST_SESSION,
				participant: { id: "p1", displayName: "", role: "host" },
			},
		});
		const nameInput = document.getElementById("host-name") as HTMLInputElement;

		// The lobby field has the guest form's problem: 44 CJK characters are 44 UTF-16 units and 132
		// UTF-8 bytes, so no length limit in the markup stops them and the server answers with its raw
		// validator line.
		nameInput.value = "名".repeat(44);
		(document.getElementById("join-button") as HTMLButtonElement).click();

		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/join")).toHaveLength(0);
		expect(document.getElementById("lobby-error")!.textContent).toBe(
			"That display name is too long. Try a shorter one.",
		);
		expect(nameInput.getAttribute("aria-invalid")).toBe("true");
		expect(document.activeElement).toBe(nameInput);
		// #lobby-error is role="alert", so it speaks once and is never read again. Without the field
		// pointing at it, a host who tabs away and comes back hears only "Display name, edit, invalid
		// entry, Shown to other participants" and never learns which check refused the value.
		expect(nameInput.getAttribute("aria-describedby")).toBe("host-name-hint lobby-error");

		// A name the checks accept takes the description back to the plain hint, so the field stops
		// reading out a refusal that no longer applies.
		nameInput.value = "Ada Host";
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));
		expect(nameInput.getAttribute("aria-describedby")).toBe("host-name-hint");
		expect(nameInput.getAttribute("aria-invalid")).toBeNull();
	});

	test("keeps host-only controls hidden for a guest", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, { session: GUEST_SESSION });

		expect(document.getElementById("start-recording-button")!.hidden).toBe(true);
		expect(document.getElementById("end-meeting-button")!.hidden).toBe(true);
	});

	test("keeps microphone guidance after the first room render", async () => {
		const sdk = make_fake_sdk();
		// This is what the pinned SDK really does with a microphone it cannot start: enableAudio
		// swallows the error in an empty catch and resolves, leaving audioEnabled false. A fake that
		// rejects instead let the join treat every press as a success and say nothing. This fake says
		// nothing about the cause either, so the join has only that flag to read and falls back to
		// the likeliest cause.
		sdk.self.enableAudio = vi.fn(async () => {});
		await boot_to_call(sdk);

		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. Allow microphone access, then turn the microphone on.",
		);
	});

	test("names the missing device, not the permission, when the join finds no microphone", async () => {
		const sdk = make_fake_sdk();
		// A host on a machine with no microphone. The pinned SDK swallows the device error in an
		// empty catch, resolves with audioEnabled still false, and emits the reason during that same
		// call — before the join is finished, so wireCallEvents has not run yet.
		sdk.self.enableAudio = vi.fn(async () => {
			sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "NO_DEVICES_AVAILABLE" });
		});
		await boot_to_call(sdk);

		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. No microphone was found. Connect one, then turn the microphone on.",
		);
		// There is no permission to fix here. Sending this host to the browser permission panel finds
		// microphone access already allowed, with nothing to do, and the room reads as broken.
		expect(document.getElementById("call-status")!.textContent).not.toContain("Allow microphone access");
	});

	test("names the other app when the join cannot start the microphone", async () => {
		const sdk = make_fake_sdk();
		// COULD_NOT_START is where the SDK's Chromium mapper sends NotReadableError: another app holds
		// the microphone, the hardware failed, or it was unplugged.
		sdk.self.enableAudio = vi.fn(async () => {
			sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "COULD_NOT_START" });
		});
		await boot_to_call(sdk);

		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. Close any other app using it, then turn the microphone on.",
		);
		expect(document.getElementById("call-status")!.textContent).not.toContain("Allow microphone access");
	});
});

describe("council_room_client_js participant media", () => {
	test("attaches local and remote video plus remote audio tracks", async () => {
		const sdk = make_fake_sdk();
		const localVideo = make_track("video", "local-video");
		const remoteVideo = make_track("video", "remote-video");
		const remoteAudio = make_track("audio", "remote-audio");
		sdk.self.videoEnabled = true;
		sdk.self.videoTrack = localVideo;
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			videoEnabled: true,
			audioEnabled: true,
			videoTrack: remoteVideo,
			audioTrack: remoteAudio,
		});
		sdk.participants.joined.participants = [remote];
		await boot_to_call(sdk);

		const localTile = document.querySelector('[data-participant-key="custom:host-1"]')!;
		const remoteTile = document.querySelector('[data-participant-key="custom:guest-2"]')!;
		const localElement = localTile.querySelector("video") as HTMLVideoElement;
		const remoteElement = remoteTile.querySelector("video") as HTMLVideoElement;
		const audioElement = document.querySelector("#audio-bin audio") as HTMLAudioElement;

		expect(localElement.muted).toBe(true);
		expect((localElement.srcObject as MediaStream).getVideoTracks()).toEqual([localVideo]);
		expect((remoteElement.srcObject as MediaStream).getVideoTracks()).toEqual([remoteVideo]);
		expect((audioElement.srcObject as MediaStream).getAudioTracks()).toEqual([remoteAudio]);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
	});

	test("offers one user-gesture recovery action for blocked remote audio", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play");
		// The browser refuses autoplay with exactly this error name, and only that one may raise
		// the recovery button.
		play.mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError")).mockResolvedValue(undefined);
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey", {
				audioEnabled: true,
				audioTrack: make_track("audio", "remote-audio"),
			}),
		];
		await boot_to_call(sdk);
		const button = document.getElementById("play-audio-button") as HTMLButtonElement;
		await vi.waitFor(() => {
			expect(button.hidden).toBe(false);
		});

		button.focus();
		button.click();
		await vi.waitFor(() => {
			expect(button.hidden).toBe(true);
		});
		expect(play).toHaveBeenCalledTimes(2);

		// The button hides itself under the focus that just pressed it, and a real browser drops the
		// focus of a hidden control to the body. Nothing would bring it back, and the next Tab would
		// restart at the top of the call view with no confirmation that anything happened.
		const status = document.getElementById("call-status")!;
		expect(document.activeElement).toBe(status);
		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe("Remote audio is playing now.");
	});

	test("does not take the terminal connection guidance off the line to confirm audio", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play");
		play.mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError")).mockResolvedValue(undefined);
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey", {
				audioEnabled: true,
				audioTrack: make_track("audio", "remote-audio"),
			}),
		];
		await boot_to_call(sdk);
		const button = document.getElementById("play-audio-button") as HTMLButtonElement;
		await vi.waitFor(() => expect(button.hidden).toBe(false));

		const status = document.getElementById("call-status")!;
		const terminal = "The connection to the meeting was lost. Press Leave, then rejoin from the next screen.";
		sdk.self.emit("roomLeft", { state: "failed" });
		expect(status.textContent).toBe(terminal);

		button.focus();
		button.click();
		await vi.waitFor(() => expect(button.hidden).toBe(true));

		// The confirmation this press normally writes clears itself after five seconds, and hiding
		// the line takes the sentence above away with it for good. Nothing writes that sentence a
		// second time, and Leave is the only control that still works. Focus still lands on the line,
		// so the listener is told where they are, and they can hear the audio for themselves.
		expect(document.activeElement).toBe(status);
		expect(status.textContent).toBe(terminal);
	});

	test("takes the audio recovery button away with the peer whose audio was blocked", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play");
		play.mockRejectedValue(new DOMException("autoplay blocked", "NotAllowedError"));
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: make_track("audio", "remote-audio"),
		});
		sdk.participants.joined.participants = [remote];
		await boot_to_call(sdk);
		const button = document.getElementById("play-audio-button") as HTMLButtonElement;
		await vi.waitFor(() => expect(button.hidden).toBe(false));

		sdk.participants.joined.participants = [];
		sdk.participants.joined.emit("participantLeft", remote);

		// The blocked element leaves the room with its tile, and removeTile is the only place that
		// drops it from the blocked list. Without that drop the room keeps offering to unblock the
		// audio of somebody who is gone, the press finds nothing to play, and the button never goes
		// away for the rest of the meeting.
		expect(button.hidden).toBe(true);
	});

	test("keeps the audio recovery button hidden when a remote mute interrupts a play", async () => {
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: make_track("audio", "remote-audio"),
		});
		sdk.participants.joined.participants = [remote];
		let rejectPlay!: (error: unknown) => void;
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPlay = reject;
				}),
		);
		await boot_to_call(sdk);
		const audio = document.querySelector("#audio-bin audio") as HTMLAudioElement;
		expect(audio.srcObject).not.toBeNull();

		// The remote mutes while that play() is still running. The client detaches the track, and
		// the browser then rejects the pending play() with AbortError.
		remote.audioEnabled = false;
		remote.emit("audioUpdate", { audioEnabled: false, audioTrack: remote.audioTrack });
		expect(audio.srcObject).toBeNull();
		rejectPlay(new DOMException("The play() request was interrupted", "AbortError"));
		// Let the rejection handler run before reading the button.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(document.getElementById("play-audio-button")!.hidden).toBe(true);
	});

	test("keeps the audio recovery button hidden when the peer leaves mid-play", async () => {
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: make_track("audio", "remote-audio"),
		});
		sdk.participants.joined.participants = [remote];
		let rejectPlay!: (error: unknown) => void;
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPlay = reject;
				}),
		);
		await boot_to_call(sdk);
		const audio = document.querySelector("#audio-bin audio") as HTMLAudioElement;
		expect(audio.srcObject).not.toBeNull();

		// The peer hangs up while that play() is still running. removeTile drops both marks and takes
		// the element out of the document, and only then does the browser deliver the autoplay
		// refusal. Marking the removed element again puts "Play audio" back on screen for the rest of
		// the meeting, and pressing it finds nothing to play.
		sdk.participants.joined.participants = [];
		sdk.participants.joined.emit("participantLeft", remote);
		expect(audio.isConnected).toBe(false);
		rejectPlay(new DOMException("autoplay blocked", "NotAllowedError"));
		// Let the rejection handler run before reading the button.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(document.getElementById("play-audio-button")!.hidden).toBe(true);
	});

	test("plays a swapped remote audio track instead of waiting on the old play", async () => {
		const sdk = make_fake_sdk();
		const firstTrack = make_track("audio", "remote-audio-1");
		const secondTrack = make_track("audio", "remote-audio-2");
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: firstTrack,
		});
		sdk.participants.joined.participants = [remote];
		let rejectPlay!: (error: unknown) => void;
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPlay = reject;
				}),
		);
		await boot_to_call(sdk);
		const audio = document.querySelector("#audio-bin audio") as HTMLAudioElement;
		expect(play).toHaveBeenCalledTimes(1);

		// The provider republishes the same participant with a new track object, for example after
		// a device change.
		const firstRejection = rejectPlay;
		remote.audioTrack = secondTrack;
		remote.emit("audioUpdate", { audioEnabled: true, audioTrack: secondTrack });
		firstRejection(new DOMException("The play() request was interrupted", "AbortError"));
		await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));

		expect((audio.srcObject as MediaStream).getAudioTracks()).toEqual([secondTrack]);
		expect(document.getElementById("play-audio-button")!.hidden).toBe(true);
	});

	test("replaces a reconnect ghost by durable custom participant id and removes old listeners", async () => {
		const sdk = make_fake_sdk();
		const ghost = make_participant("old-peer", "guest-2", "Casey old");
		const replacement = make_participant("new-peer", "guest-2", "Casey new");
		sdk.participants.joined.participants = [ghost];
		await boot_to_call(sdk);

		// "disconnected" is the drop a roomJoined really follows. "failed" is the SDK giving up for
		// good, and no rejoin comes after it, so it cannot set up the reconnect this test is about.
		sdk.self.emit("roomLeft", { state: "disconnected" });
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(document.getElementById("connection-status")!.textContent).toContain("Reconnecting");

		sdk.participants.joined.participants = [ghost, replacement];
		vi.useFakeTimers();
		sdk.self.emit("roomJoined");

		const labels = [...document.querySelectorAll(".participant-name")].map((item) => item.textContent);
		expect(labels).toContain("Casey new");
		expect(labels).not.toContain("Casey old");
		expect(ghost.off).toHaveBeenCalledWith("videoUpdate", expect.any(Function));
		expect(ghost.off).toHaveBeenCalledWith("audioUpdate", expect.any(Function));
		expect(document.getElementById("connection-status")!.textContent).toContain("Connected");
		expect(document.getElementById("call-status")!.textContent).toBe("Connection restored.");
		await vi.advanceTimersByTimeAsync(3000);
		expect(document.getElementById("call-status")!.hidden).toBe(true);
	});

	test("removes participant media and listeners after participantLeft", async () => {
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: make_track("audio", "remote-audio"),
		});
		sdk.participants.joined.participants = [remote];
		await boot_to_call(sdk);

		sdk.participants.joined.participants = [];
		sdk.participants.joined.emit("participantLeft", remote);

		expect(document.querySelector('[data-participant-key="custom:guest-2"]')).toBeNull();
		expect(document.querySelector("#audio-bin audio")).toBeNull();
		expect(remote.off).toHaveBeenCalled();
	});

	test("uses the last reconnect peer when a snapshot contains the old and new peer", async () => {
		const sdk = make_fake_sdk();
		const ghost = make_participant("ghost-2", "guest-2", "Casey old");
		const replacement = make_participant("new-2", "guest-2", "Casey new");
		const sameName = make_participant("twin-1", "guest-3", "Ada Host");
		sdk.participants.joined.participants = [ghost, replacement, sameName];
		await boot_to_call(sdk);

		const labels = [...document.querySelectorAll(".participant-name")].map((item) => item.textContent);
		expect(labels).toEqual(expect.arrayContaining(["Ada Host (you)", "Casey new", "Ada Host"]));
		expect(labels).not.toContain("Casey old");
	});

	test("keeps the peer participantJoined named when the ghost comes later in the snapshot", async () => {
		const sdk = make_fake_sdk();
		const ghost = make_participant("ghost-2", "guest-2", "Casey old");
		const replacement = make_participant("new-2", "guest-2", "Casey new");
		// The ghost is last here, so the last-entry rule alone would pick it. participantJoined names
		// the peer that really joined, and that name has to beat the snapshot order.
		sdk.participants.joined.participants = [replacement, ghost];
		await boot_to_call(sdk);

		sdk.participants.joined.emit("participantJoined", replacement);

		const labels = [...document.querySelectorAll(".participant-name")].map((item) => item.textContent);
		expect(labels).toContain("Casey new");
		expect(labels).not.toContain("Casey old");
	});

	test("pins a chosen participant with an accessible toggle", async () => {
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey"),
			make_participant("peer-3", "guest-3", "Morgan"),
		];
		await boot_to_call(sdk);

		const remoteTile = document.querySelector('[data-participant-key="custom:guest-2"]') as HTMLElement;
		const pin = remoteTile.querySelector(".participant-pin") as HTMLButtonElement;
		expect(pin.getAttribute("aria-pressed")).toBe("false");
		pin.click();

		expect(pin.getAttribute("aria-pressed")).toBe("true");
		expect(remoteTile.dataset.featured).toBe("true");
		// The accessible name has to contain the visible text so speech input can reach it
		// (WCAG 2.5.3 Label in Name).
		expect(pin.textContent).toBe("Pinned");
		expect(pin.getAttribute("aria-label")).toContain("Pinned");
		expect(pin.getAttribute("aria-label")).toBe("Pinned — unpin Casey");
	});

	test("marks a pinned tile as featured at every meeting size", async () => {
		const sdk = make_fake_sdk();
		const casey = make_participant("peer-2", "guest-2", "Casey");
		sdk.participants.joined.participants = [casey];
		await boot_to_call(sdk);
		const stage = document.getElementById("participant-list")!;
		const featuredKeys = () =>
			[...stage.querySelectorAll<HTMLElement>('[data-featured="true"]')].map((tile) => tile.dataset.participantKey);

		// Nobody pinned anything yet. The stage still has an implicit featured tile — the host's own —
		// and it must not wear the accent border for a pin nobody pressed.
		expect(featuredKeys()).toEqual([]);

		// Two tiles are too few for the featured layout, but Pin says "Pinned" and so the stage has to
		// show it. The accent border rule in page.ts is not scoped to that layout.
		(document.querySelector('[data-participant-key="custom:guest-2"] .participant-pin') as HTMLButtonElement).click();
		expect(stage.dataset.layout).toBeUndefined();
		expect(featuredKeys()).toEqual(["custom:guest-2"]);

		// Seven tiles are past the featured layout, so the stage is a plain grid. The pin still holds.
		sdk.participants.joined.participants = [
			casey,
			make_participant("peer-3", "guest-3", "Morgan"),
			make_participant("peer-4", "guest-4", "Robin"),
			make_participant("peer-5", "guest-5", "Taylor"),
			make_participant("peer-6", "guest-6", "Sam"),
			make_participant("peer-7", "guest-7", "Alex"),
		];
		sdk.participants.joined.emit("participantJoined", undefined);

		expect(stage.dataset.count).toBe("7");
		expect(stage.dataset.layout).toBe("grid");
		expect(featuredKeys()).toEqual(["custom:guest-2"]);
	});

	test("keeps keyboard focus on a tile control across a stage render", async () => {
		const sdk = make_fake_sdk();
		const casey = make_participant("peer-2", "guest-2", "Casey");
		sdk.participants.joined.participants = [casey, make_participant("peer-3", "guest-3", "Morgan")];
		await boot_to_call(sdk);
		const pin = document.querySelector('[data-participant-key="custom:guest-2"] .participant-pin') as HTMLButtonElement;

		// Every render re-appends every tile, and happy-dom blurs a focused descendant when its node
		// is moved, the same way a browser does. So activeElement is the check here, and it is a
		// stronger one than a focus() spy: it also catches focus landing on the wrong element.
		pin.focus();
		pin.click();
		expect(document.activeElement).toBe(pin);

		// A join renders the stage with no user action at all. The control bar sits last in tab order,
		// so a host dropped to the body walks every pin again to reach Leave.
		sdk.participants.joined.participants = [...sdk.participants.joined.participants, make_participant("peer-4", "guest-4", "Robin")];
		sdk.participants.joined.emit("participantJoined", undefined);
		expect(document.activeElement).toBe(pin);
	});

	test("hands keyboard focus to a tile that stayed when the focused peer leaves", async () => {
		const sdk = make_fake_sdk();
		const casey = make_participant("peer-2", "guest-2", "Casey");
		const morgan = make_participant("peer-3", "guest-3", "Morgan");
		sdk.participants.joined.participants = [casey, morgan];
		await boot_to_call(sdk);
		const pin = document.querySelector('[data-participant-key="custom:guest-2"] .participant-pin') as HTMLButtonElement;

		pin.focus();
		expect(document.activeElement).toBe(pin);

		// happy-dom drops focus to the body when the focused node's ancestor is removed, the same way
		// a browser does, so activeElement is the real check here. The tile the user was standing on
		// cannot take its focus back, and renderStageLayout never even sees the loss: it reads
		// activeElement after removeTile has already sent it to the body. Reaching Leave from there
		// took 6 Tab presses in this call, mid-meeting, because a peer hung up.
		sdk.participants.joined.participants = [morgan];
		sdk.participants.joined.emit("participantLeft", casey);

		expect(document.activeElement).not.toBe(document.body);
		// The first tile on the stage. Nothing is pinned, so the host's own tile is the featured one
		// and the sort puts it first, which makes its Pin the stage's first control in tab order.
		expect(document.activeElement).toBe(
			document.querySelector('[data-participant-key="custom:host-1"] .participant-pin'),
		);
		expect(document.getElementById("participant-list")!.querySelector(".participant-pin")).toBe(
			document.activeElement,
		);
	});

	test("says No video on every tile with no picture, past the subscription limit too", async () => {
		const sdk = make_fake_sdk();
		const seen = make_participant("peer-2", "guest-2", "Casey", {
			videoEnabled: true,
			videoTrack: make_track("video", "remote-video"),
		});
		// Seven remotes puts the call past the SDK's default subscription limit of 6, which is the
		// case the room could not explain before: those peers arrive with no track at all.
		sdk.participants.joined.participants = [
			seen,
			make_participant("peer-3", "guest-3", "Morgan"),
			make_participant("peer-4", "guest-4", "Robin"),
			make_participant("peer-5", "guest-5", "Taylor"),
			make_participant("peer-6", "guest-6", "Sam"),
			make_participant("peer-7", "guest-7", "Alex"),
			make_participant("peer-8", "guest-8", "Jordan"),
		];
		await boot_to_call(sdk);

		const stateOf = (key: string) =>
			document.querySelector(`[data-participant-key="${key}"] .participant-video-state`)!.textContent;

		// The peer whose video really arrived says nothing: the tile shows the picture, so there is
		// nothing to explain. Only the negative state is worth words.
		expect(document.querySelector('[data-participant-key="custom:guest-2"]')!.getAttribute("data-video")).toBe("on");
		expect(stateOf("custom:guest-2")).toBe("");

		// Every tile without a picture explains itself, including the host's own.
		const silent = ["custom:guest-3", "custom:guest-4", "custom:guest-5", "custom:guest-6", "custom:guest-7", "custom:guest-8", "custom:host-1"];
		for (const key of silent) {
			expect(stateOf(key)).toBe("No video");
		}

		// The room cannot tell "camera off" from "we never received it", so it must not claim either.
		const everyWord = [...document.querySelectorAll(".participant-video-state")].map((item) => item.textContent);
		expect(everyWord).not.toContain("Camera off");

		// A peer whose video drops mid-call picks the words up, and loses them when it comes back.
		seen.videoEnabled = false;
		seen.videoTrack = null;
		seen.emit("videoUpdate", { videoEnabled: false, videoTrack: null });
		expect(stateOf("custom:guest-2")).toBe("No video");

		seen.videoEnabled = true;
		seen.videoTrack = make_track("video", "remote-video-2");
		seen.emit("videoUpdate", { videoEnabled: true, videoTrack: seen.videoTrack });
		expect(stateOf("custom:guest-2")).toBe("");
	});

	test("says No audio instead of Mic off for a peer the SDK never subscribed to", async () => {
		const sdk = make_fake_sdk();
		// Eleven remotes puts the call past the SDK's default audio subscription limit of 10, in a room
		// that allows 25. Every peer past it arrives with audioEnabled false and no track, which is the
		// same state as a peer who muted themselves.
		const peers: FakeParticipant[] = [];
		for (let index = 2; index <= 12; index += 1) {
			peers.push(make_participant(`peer-${index}`, `guest-${index}`, `Peer ${index}`));
		}
		const subscribedIds = new Set(peers.slice(0, 10).map((peer) => peer.id));
		sdk.participants.audioSubscribed = { has: (peerId: string) => subscribedIds.has(peerId) };
		sdk.participants.joined.participants = peers;
		await boot_to_call(sdk);

		const micOf = (key: string) =>
			document.querySelector(`[data-participant-key="${key}"] .participant-mic`)!.textContent;

		// The room does not receive this peer's audio at all, so it cannot claim they muted themselves.
		expect(micOf("custom:guest-12")).not.toBe("Mic off");
		expect(micOf("custom:guest-12")).toBe("No audio");

		// A peer inside the subscribed set with audio off really is muted and must keep saying so.
		// Gating the chip on audioTrack instead would flip every unmuted subscribed peer to a false
		// "Mic off", because .participant-mic[data-muted="false"] renders no visible badge to fall
		// back on.
		expect(micOf("custom:guest-2")).toBe("Mic off");
	});

	test("drops tiles the SDK removed through participantsCleared", async () => {
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey", {
			audioEnabled: true,
			audioTrack: make_track("audio", "remote-audio"),
		});
		sdk.participants.joined.participants = [remote];
		await boot_to_call(sdk);
		expect(document.querySelector('[data-participant-key="custom:guest-2"]')).not.toBeNull();

		// The SDK empties this collection on every socket rejoin and adds the fresh peers back one by
		// one. The clear emits only participantsCleared, never one participantLeft per peer, so a
		// meeting that came back without this peer would keep the tile, its audio element and its
		// place in the count forever.
		sdk.participants.joined.participants = [];
		sdk.participants.joined.emit("participantsCleared");

		expect(document.querySelector('[data-participant-key="custom:guest-2"]')).toBeNull();
		expect(document.querySelector("#audio-bin audio")).toBeNull();
		// One is the local tile, which no SDK collection owns.
		expect(document.getElementById("participant-count")!.textContent).toBe("1");
	});

	test("uses a main tile with a two-by-two side grid for five participants", async () => {
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey"),
			make_participant("peer-3", "guest-3", "Morgan"),
			make_participant("peer-4", "guest-4", "Robin"),
			make_participant("peer-5", "guest-5", "Taylor"),
		];
		await boot_to_call(sdk);

		const stage = document.getElementById("participant-list")!;
		expect(stage.dataset.layout).toBe("featured");
		expect(stage.dataset.sideColumns).toBe("2");
		expect(stage.querySelectorAll('[data-featured="true"]')).toHaveLength(1);
	});

	test("uses one stacked side column for three participants", async () => {
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey"),
			make_participant("peer-3", "guest-3", "Morgan"),
		];
		await boot_to_call(sdk);

		const stage = document.getElementById("participant-list")!;
		expect(stage.dataset.layout).toBe("featured");
		expect(stage.dataset.sideColumns).toBe("1");
	});

	test("drops the featured layout once the side column is full", async () => {
		// The featured tile spans both explicit rows, so the two side columns hold four tiles. A
		// sixth tile would open an implicit row that the featured tile then paints over.
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey"),
			make_participant("peer-3", "guest-3", "Morgan"),
			make_participant("peer-4", "guest-4", "Robin"),
			make_participant("peer-5", "guest-5", "Taylor"),
			make_participant("peer-6", "guest-6", "Sam"),
		];
		await boot_to_call(sdk);

		const stage = document.getElementById("participant-list")!;
		expect(stage.dataset.count).toBe("6");
		expect(stage.dataset.layout).toBe("grid");
		expect(stage.dataset.sideColumns).toBeUndefined();
		expect(stage.querySelectorAll('[data-featured="true"]')).toHaveLength(0);
	});
});

describe("council_room_client_js call controls", () => {
	test("toggles microphone and camera with pressed and pending states", async () => {
		const sdk = make_fake_sdk();
		sdk.self.audioEnabled = true;
		await boot_to_call(sdk);

		const mic = document.getElementById("mute-button") as HTMLButtonElement;
		const camera = document.getElementById("camera-button") as HTMLButtonElement;
		expect(mic.getAttribute("aria-pressed")).toBe("true");
		expect(camera.getAttribute("aria-pressed")).toBe("false");

		// The pending state is aria-busy, never disabled: a disabled control loses keyboard focus
		// to the body and never gets it back.
		mic.click();
		expect(mic.getAttribute("aria-busy")).toBe("true");
		expect(mic.disabled).toBe(false);
		mic.click();
		await vi.waitFor(() => expect(mic.getAttribute("aria-busy")).toBe(null));
		expect(sdk.self.disableAudio).toHaveBeenCalledOnce();
		expect(mic.getAttribute("aria-pressed")).toBe("false");

		camera.click();
		await vi.waitFor(() => expect(camera.getAttribute("aria-busy")).toBe(null));
		expect(sdk.self.enableVideo).toHaveBeenCalledOnce();
		expect(camera.getAttribute("aria-pressed")).toBe("true");
	});

	test("names the media controls from their visible text in both states", async () => {
		const sdk = make_fake_sdk();
		sdk.self.audioEnabled = true;
		await boot_to_call(sdk);
		const mic = document.getElementById("mute-button") as HTMLButtonElement;
		const camera = document.getElementById("camera-button") as HTMLButtonElement;
		const visibleNames = () => [
			mic.querySelector(".control-label")!.textContent,
			camera.querySelector(".control-label")!.textContent,
		];

		// Both controls are toggles, so aria-pressed carries the state and the name has to stay the
		// thing being toggled. A name that says "Turn microphone off" says the opposite of
		// pressed="true", and it takes the visible word out of the name, so a speech-input user
		// saying "click Microphone" reaches nothing (WCAG 2.5.3 Label in Name). The buttons name
		// themselves from the label in the markup, so there must be no aria-label in either state.
		// Do not add one back as a fix.
		expect(mic.getAttribute("aria-pressed")).toBe("true");
		expect(camera.getAttribute("aria-pressed")).toBe("false");
		expect(mic.getAttribute("aria-label")).toBe(null);
		expect(camera.getAttribute("aria-label")).toBe(null);
		expect(visibleNames()).toEqual(["Microphone", "Camera"]);

		mic.click();
		await vi.waitFor(() => expect(mic.getAttribute("aria-pressed")).toBe("false"));
		camera.click();
		await vi.waitFor(() => expect(camera.getAttribute("aria-pressed")).toBe("true"));

		expect(mic.getAttribute("aria-label")).toBe(null);
		expect(camera.getAttribute("aria-label")).toBe(null);
		expect(visibleNames()).toEqual(["Microphone", "Camera"]);
	});

	test("clears a media error after the retry succeeds", async () => {
		const sdk = make_fake_sdk();
		sdk.self.enableVideo = vi.fn(() => Promise.reject(new Error("denied")));
		await boot_to_call(sdk);
		const camera = document.getElementById("camera-button") as HTMLButtonElement;

		camera.click();
		await vi.waitFor(() => expect(document.getElementById("call-status")!.textContent).toContain("Camera unavailable"));
		sdk.self.enableVideo = vi.fn(async () => {
			sdk.self.videoEnabled = true;
		});
		camera.click();
		await vi.waitFor(() => expect(document.getElementById("call-status")!.hidden).toBe(true));
	});

	test("clears the device-loss banner once the device comes back", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;

		// Another app takes the microphone mid-call, and the SDK has already turned the track off.
		sdk.self.audioEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "COULD_NOT_START" });
		expect(status.hidden).toBe(false);

		// The listener closes that app and turns the microphone back on. clearCallStatus matches the
		// first words of the line, so this message has to open the same way the permission one does.
		// Wording that opens any other way is never cleared, and the room keeps telling the listener
		// their microphone is gone for the rest of the meeting.
		sdk.self.enableAudio = vi.fn(async () => {
			sdk.self.audioEnabled = true;
		});
		(document.getElementById("mute-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(sdk.self.enableAudio).toHaveBeenCalled());
		await Promise.resolve();
		await Promise.resolve();

		expect(status.hidden).toBe(true);
		expect(status.textContent).toBe("");
	});

	test("keeps the reason on screen when the SDK resolves a camera that never started", async () => {
		const sdk = make_fake_sdk();
		// The SDK-faithful shape of a camera that cannot start: the permission event goes out first,
		// then enableVideo swallows the error in an empty catch and resolves with videoEnabled still
		// false. Every other media test here uses a fake that rejects, which is why the press could
		// run its success branch and wipe the line its own event had just written.
		sdk.self.enableVideo = vi.fn(async () => {
			sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "COULD_NOT_START" });
		});
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;
		const camera = document.getElementById("camera-button") as HTMLButtonElement;

		camera.click();
		await vi.waitFor(() => expect(camera.getAttribute("aria-busy")).toBe(null));

		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe("Camera unavailable. Close any other app using it, then turn the camera on.");
		expect(camera.getAttribute("aria-pressed")).toBe("false");
	});

	test("says why a camera did not start when the SDK resolves without an event", async () => {
		const sdk = make_fake_sdk();
		// Same swallowed failure, but no event at all reaches the room. A resolved promise is the
		// only thing the press gets back, and it does not mean the camera turned on.
		sdk.self.enableVideo = vi.fn(async () => {});
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;
		const camera = document.getElementById("camera-button") as HTMLButtonElement;

		camera.click();
		await vi.waitFor(() => expect(camera.getAttribute("aria-busy")).toBe(null));

		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe("Camera unavailable. Check the browser camera permission.");
	});

	test("shows the room header for the call and hides it again on leave", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const header = document.getElementById("room-header")!;

		// The header ships hidden and showView is the one place that ever unhides it. It holds the
		// meeting title, the elapsed clock, the connection chip and the recording pill, so losing
		// that one line leaves every one of them off screen for the whole meeting.
		expect(header.hidden).toBe(false);

		(document.getElementById("leave-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The ended screen is not the call, so the header goes away with it.
		expect(header.hidden).toBe(true);
	});

	test("shows shared elapsed time and applies meeting start updates", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		expect(document.getElementById("meeting-elapsed")!.textContent).toBe("01:05");
		sdk.meta.meetingStartedTimestamp = new Date(Date.now() - 3_723_000);
		sdk.meta.emit("meetingStartTimeUpdate");
		expect(document.getElementById("meeting-elapsed")!.textContent).toBe("01:02:03");
	});

	test("starts recording only once and announces the shared active state", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/start-recording") {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				return undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;
		expect(button.hidden).toBe(false);
		expect(document.getElementById("recording-indicator")!.hidden).toBe(true);

		button.click();
		await vi.waitFor(() => expect(button.disabled).toBe(true));
		await vi.waitFor(() => expect(document.getElementById("call-status")!.textContent).toBe("Recording is starting."));
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(1);

		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(document.getElementById("recording-live")!.textContent).toBe("Recording has started.");
		expect(document.getElementById("call-status")!.hidden).toBe(true);
	});

	test("says nothing about a start the provider has already announced", async () => {
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				return startGate.then(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
			},
		});
		const status = document.getElementById("call-status")!;

		(document.getElementById("start-recording-button") as HTMLButtonElement).click();

		// The provider's own broadcast wins the race against the service's answer, which is easy: the
		// service writes D1 before it answers. The only line that clears "Recording is starting." is
		// this event, and it runs before the answer writes it. No second recordingUpdate("RECORDING")
		// ever follows, because the SDK emits that event only on a change, so a line written now
		// stays for the rest of the meeting: it was still promising a start after the recording had
		// stopped, beside a button that read "Recording finished".
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		// In a real browser that event disables the control and the browser takes focus off it in the
		// same statement, which leaves the host on the body. happy-dom does not blur on disable, so
		// put the focus where the browser puts it. It doubles as the signal that the answer below has
		// been handled: the client moves this focus off the body in its success branch, and nothing
		// else here does. The broadcast itself does not, because this browser's own start request is
		// still in the air and handleRecordingUpdate leaves that answer to claim the host.
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).toBe(document.body);

		releaseStart();
		await vi.waitFor(() => expect(document.activeElement).not.toBe(document.body));

		expect(status.hidden).toBe(true);
		expect(status.textContent).toBe("");
		// With no line to stand on, the ladder lands on the recording pill: the broadcast above
		// showed it, and it is the one visible box that says why the control closed.
		expect(document.activeElement).toBe(document.getElementById("recording-indicator"));

		sdk.recording.recordingState = "STOPPED";
		sdk.recording.emit("recordingUpdate", "STOPPED");
		expect(document.getElementById("recording-live")!.textContent).toBe("Recording has stopped.");
		expect(status.hidden).toBe(true);
	});

	test("hands the host the notice when the answer disables the control they pressed", async () => {
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				return startGate.then(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;
		const status = document.getElementById("call-status")!;

		// A host who presses this control is standing on it, and happy-dom does not move focus on
		// click(), so put focus there the way a real press does.
		button.focus();
		button.click();
		// The control stays enabled while the request runs, so the host is still standing on it here.
		expect(button.disabled).toBe(false);

		// A meeting records once, so a start that worked closes the control the host just pressed. A
		// browser takes focus off a control in the same statement that disables it, which leaves the
		// host on the body before the client's own catch runs; happy-dom does not blur on disable at
		// all. So put the focus where the browser puts it and release the answer after. Written the
		// other way round the control keeps focus in happy-dom, the recovery branch never runs, and
		// the test passes with the fix removed.
		button.blur();
		expect(document.activeElement).toBe(document.body);

		releaseStart();
		await vi.waitFor(() => expect(status.textContent).toBe("Recording is starting."));

		expect(button.disabled).toBe(true);
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording requested");
		expect(status.hidden).toBe(false);
		// Hand them the line that says what happened, instead of leaving them on the body for the
		// rest of the call.
		expect(document.activeElement).toBe(status);
	});

	test("catches the host's focus when a recording nobody here started closes the control", async () => {
		const sdk = make_fake_sdk();
		// Keep the microphone on so no device notice is showing. The landing below is then the last
		// resort on purpose, and not an unrelated line that happens to be up.
		sdk.self.audioEnabled = true;
		await boot_to_call(sdk);
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		// Nothing is in flight here. The provider reports a recording this browser never asked for:
		// another host started it, or a reconnect replays the state.
		button.focus();
		expect(document.activeElement).toBe(button);
		expect(button.disabled).toBe(false);

		// A browser takes focus off a control in the same statement that disables it, and the
		// broadcast below disables this one. happy-dom does not blur on disable, and blur() on an
		// already-disabled control does nothing either, so drop the focus first and let the broadcast
		// land after: that is the state a browser really produces. Measured in Edge on the served
		// room, this path left the host on the body at the synchronous read and at every sample out
		// to 500ms, with nothing bringing them back.
		button.blur();
		expect(document.activeElement).toBe(document.body);

		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");

		expect(button.disabled).toBe(true);
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording");
		expect(document.activeElement).not.toBe(document.body);
		// No banner and no status line are up on this path, and the same render that disabled the
		// control has just shown the recording pill. The pill is a visible box that says why the
		// control closed, so the ladder lands there instead of on the clipped call heading, whose
		// ring paints no pixels. The tabindex="-1" that makes this work in a browser is pinned in
		// page.test.ts, because happy-dom focuses any element it is asked to.
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(document.activeElement).toBe(document.getElementById("recording-indicator"));
	});

	test("falls back past the hidden pill when the recording stops", async () => {
		const sdk = make_fake_sdk();
		// Keep the microphone on so no device notice is showing and the ladder is what decides.
		sdk.self.audioEnabled = true;
		await boot_to_call(sdk);
		const indicator = document.getElementById("recording-indicator")!;

		// Reach the pill through the real path: the start broadcast parks the host on it.
		(document.activeElement as HTMLElement).blur();
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(document.activeElement).toBe(indicator);

		// The stop broadcast hides the pill the host is standing on, and a browser drops focus to
		// the body in the same statement that hides it. happy-dom does not blur on hidden, so put
		// the focus where the browser puts it and let the broadcast land after.
		(document.activeElement as HTMLElement).blur();
		sdk.recording.recordingState = "STOPPED";
		sdk.recording.emit("recordingUpdate", "STOPPED");

		// The pill is hidden again, and a hidden element cannot take focus, so the ladder falls
		// through to its last resort exactly as it did before the pill rung existed.
		expect(indicator.hidden).toBe(true);
		expect(document.activeElement).toBe(document.getElementById("call-heading"));
	});

	test("keeps a visible status line ahead of the pill in the focus ladder", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;

		// A device notice is up when the broadcast lands. The notice carries a sentence and the
		// pill does not, so the rescue must land on the notice, not on the pill.
		sdk.self.videoEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "NO_DEVICES_AVAILABLE" });
		expect(status.hidden).toBe(false);

		(document.activeElement as HTMLElement).blur();
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");

		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(document.activeElement).toBe(status);
	});

	test("leaves the answer to put the host back when the broadcast beats it", async () => {
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const sdk = make_fake_sdk();
		sdk.self.audioEnabled = true;
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				return startGate.then(() => new Response(JSON.stringify({ ok: true }), { status: 500 }));
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.focus();
		button.click();
		// Same browser fact as the test above: the broadcast is about to disable the control the host
		// is standing on, so drop the focus first.
		button.blur();
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(button.disabled).toBe(true);

		// The broadcast must not park the host on the call heading here. This browser's own start
		// request is still in the air, and its answer writes the line that says what happened. A host
		// already standing on the heading is no longer on the body, so that later catch could not
		// claim them and they would be left on a line that marks nothing.
		expect(document.activeElement).toBe(document.body);

		releaseStart();
		await vi.waitFor(() =>
			expect(document.getElementById("host-error")!.textContent).toBe(
				"The recording could not be saved, so it produced no files. You can start a new recording.",
			),
		);
		expect(document.activeElement).toBe(document.getElementById("host-error"));
	});

	test("moves focus off the call status line before hiding it", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/start-recording") {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}
				return undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;
		const status = document.getElementById("call-status") as HTMLElement;

		button.click();
		await vi.waitFor(() => expect(status.textContent).toBe("Recording is starting."));

		// In a real browser the recording control loses focus in the same statement that disables it,
		// and the client then catches that focus on the status line, which the test above pins.
		// happy-dom does not blur on disable and this test never focuses the button, so put the focus
		// where the client leaves it and check what happens when the line goes away.
		status.focus();
		expect(document.activeElement).toBe(status);

		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");

		expect(status.hidden).toBe(true);
		// The same render that cleared this line has already shown the recording pill, and the pill
		// is a visible box the focus ring can paint on. Landing on the clipped call heading here
		// would give the host a place in the page and no visible mark, while the one box naming why
		// the line went away is right there.
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(document.activeElement).toBe(document.getElementById("recording-indicator"));
	});

	test("falls back to the heading when the dying status line leaves nothing visible", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status") as HTMLElement;

		// Drop the connection and restore it, so the line carries the "Connection restored."
		// confirmation with its three-second clear. Fake timers go on before the confirmation is
		// written, so its clear timer is the one being advanced below.
		sdk.self.emit("roomLeft", { state: "disconnected" });
		vi.useFakeTimers();
		sdk.self.emit("roomJoined", { reconnected: true });
		expect(status.textContent).toBe("Connection restored.");

		// A rescue can park the host on this line while it shows. happy-dom moves focus nowhere by
		// itself, so put the focus where the client leaves it.
		status.focus();
		expect(document.activeElement).toBe(status);

		await vi.advanceTimersByTimeAsync(3000);

		// No banner and no pill is up when the timer takes the line away, so the ladder falls
		// through to its last resort, the same landing this path always had.
		expect(status.hidden).toBe(true);
		expect(document.getElementById("host-error")!.hidden).toBe(true);
		expect(document.getElementById("recording-indicator")!.hidden).toBe(true);
		expect(document.activeElement).toBe(document.getElementById("call-heading"));
	});

	test("hands the host the error banner when the status line they stand on clears", async () => {
		const play = vi.spyOn(HTMLMediaElement.prototype, "play");
		play.mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError")).mockResolvedValue(undefined);
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey", {
				audioEnabled: true,
				audioTrack: make_track("audio", "remote-audio"),
			}),
		];
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/close"
					? new Response(JSON.stringify({ message: "The room could not be closed." }), { status: 500 })
					: undefined,
		});
		const playButton = document.getElementById("play-audio-button") as HTMLButtonElement;
		await vi.waitFor(() => expect(playButton.hidden).toBe(false));

		// A close that fails leaves its banner up, and nothing but the next press clears it.
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		const hostError = document.getElementById("host-error")!;
		await vi.waitFor(() => expect(hostError.hidden).toBe(false));

		// The host then recovers the blocked audio. That press hides its own button under their
		// focus, so the client parks them on the confirmation line, which clears itself after five
		// seconds. Fake timers go on first so that clear timer is the one being advanced below.
		vi.useFakeTimers();
		playButton.focus();
		playButton.click();
		const status = document.getElementById("call-status")!;
		expect(document.activeElement).toBe(status);
		expect(status.textContent).toBe("Remote audio is playing now.");

		// A recording broadcast lights the pill while they stand there. The banner still outranks
		// it, because the banner carries a sentence and the pill does not.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(document.activeElement).toBe(status);

		await vi.advanceTimersByTimeAsync(5000);

		expect(status.hidden).toBe(true);
		expect(document.activeElement).toBe(hostError);
	});

	test("keeps an unrelated notice on screen when the recording starts", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status") as HTMLElement;

		sdk.self.videoEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "NO_DEVICES_AVAILABLE" });
		expect(status.textContent).toBe("Camera unavailable. No camera was found. Connect one, then turn the camera on.");

		// The broadcast clears this line, but only its own wording. The device notice belongs to the
		// member's own camera and nothing else takes it away, so a recording somebody else started
		// must leave it alone. The shared "Camera unavailable" opening of all three device wordings
		// exists so the prefix match can tell them apart from this one.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");

		expect(status.textContent).toBe("Camera unavailable. No camera was found. Connect one, then turn the camera on.");
		expect(status.hidden).toBe(false);
	});

	test("unhides a live region before writing the text into it", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/close"
					? new Response(JSON.stringify({ message: "The room could not be closed." }), { status: 500 })
					: undefined,
		});
		// Every line here ships hidden. A hidden element is out of the accessibility tree, so it holds
		// no live region for the new text to change. Record the two steps in the order they happen:
		// the unhide has to come first. Keep all three writers in one test so they cannot drift apart
		// again — setCallStatus writes the polite #call-status, setError writes the role="alert"
		// #host-error, and showFatal writes the role="alert" #error-message. #guest-error and
		// #lobby-error are the same setError, so this covers all four alert regions in page.ts.
		// Watch the subtree too: showFatal's unhide lands on the section around its line.
		const stepsOn = (element: HTMLElement) => {
			const steps: string[] = [];
			const collect = (records: MutationRecord[]) => {
				for (const record of records) {
					steps.push(record.type === "attributes" ? "unhide" : "text");
				}
			};
			const observer = new MutationObserver(collect);
			observer.observe(element, {
				attributes: true,
				attributeFilter: ["hidden"],
				childList: true,
				subtree: true,
			});
			return () => {
				collect(observer.takeRecords());
				observer.disconnect();
				return steps;
			};
		};

		const status = document.getElementById("call-status")!;
		expect(status.hidden).toBe(true);
		const callStatusSteps = stepsOn(status);
		sdk.self.videoEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "NO_DEVICES_AVAILABLE" });
		expect(callStatusSteps()).toEqual(["unhide", "text"]);

		const hostError = document.getElementById("host-error")!;
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		// confirmEndMeeting clears this line synchronously on the press, and that clear is a step of
		// its own. Start recording after it, so the only steps left are the ones the refused close
		// writes.
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		expect(hostError.hidden).toBe(true);
		const hostErrorSteps = stepsOn(hostError);
		await vi.waitFor(() => expect(hostError.hidden).toBe(false));
		expect(hostErrorSteps()).toEqual(["unhide", "text"]);

		// showFatal is the third writer, and its line is hidden by the section around it instead of
		// by its own attribute. A hidden ancestor takes the paragraph out of the accessibility tree
		// just as its own hidden attribute would, so the unhide still has to come first. Every
		// sentence that reaches this screen names the one thing the participant can still do, and
		// there is no other line to read it from.
		load_room_document();
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
		(window as CouncilWindow).__councilEntry = { ticket: null };
		const errorView = document.getElementById("view-error")!;
		expect(errorView.hidden).toBe(true);
		const fatalSteps = stepsOn(errorView);
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(errorView.hidden).toBe(false));
		expect(fatalSteps()).toEqual(["unhide", "text"]);
		expect(document.getElementById("error-message")!.textContent).toContain("did not answer");
	});

	test("reports a stopped recording as finished instead of still requested", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const label = document.getElementById("start-recording-button")!.querySelector(".control-label")!;

		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(label.textContent).toBe("Recording");

		// The provider stops on its own at the max_seconds cap. A meeting records once, so the
		// control stays closed and both the label and the live region have to say so.
		sdk.recording.recordingState = "IDLE";
		sdk.recording.emit("recordingUpdate", "IDLE");

		expect(document.getElementById("recording-indicator")!.hidden).toBe(true);
		expect(document.getElementById("recording-live")!.textContent).toBe("Recording has stopped.");
		expect(label.textContent).toBe("Recording finished");
		expect((document.getElementById("start-recording-button") as HTMLButtonElement).disabled).toBe(true);
	});

	test("never re-offers the recording control for a meeting that already recorded", async () => {
		// The service keeps provider_recording_id forever, so a reload must not offer a button
		// whose only possible answer is a refusal.
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			session: { ...HOST_SESSION, meeting: { ...HOST_SESSION.meeting, recordingStarted: true } },
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		expect(button.hidden).toBe(false);
		expect(button.disabled).toBe(true);
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording finished");
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(0);
	});

	test("closes the recording control on a reload into recording_start_unknown", async () => {
		// A lost start records nothing, so recordingStarted stays false. The meeting is no longer
		// open either, so start-recording answers 409 "This meeting can no longer record." while
		// the call view is visibly live. Seed from the status too, or the reload offers a button
		// whose only possible answer is that refusal, and the button stays enabled to repeat it.
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			session: { ...HOST_SESSION, meeting: { ...HOST_SESSION.meeting, status: "recording_start_unknown" } },
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		expect(button.disabled).toBe(true);
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable");
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(0);
		expect(document.getElementById("host-error")!.hidden).toBe(true);
	});

	test("times out a hanging start-recording request and offers a retry", async () => {
		const sdk = make_fake_sdk();
		let recordingSignal: AbortSignal | undefined;
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				recordingSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					recordingSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;
		vi.useFakeTimers();

		button.focus();
		button.click();
		expect(button.querySelector(".control-label")!.textContent).toBe("Starting recording…");
		// A disabled control blurs to the body and never gets focus back, and this wait can last
		// half a minute. The control stays enabled, marks itself busy, and ignores repeat presses.
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.disabled).toBe(false);
		expect(document.activeElement).toBe(button);
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(30_000);

		expect(recordingSignal?.aborted).toBe(true);
		expect(button.getAttribute("aria-busy")).toBe(null);
		expect(button.disabled).toBe(false);
		expect(button.querySelector(".control-label")!.textContent).toBe("Start recording");
		expect(document.getElementById("host-error")!.textContent).toContain("took too long");
	});

	test("closes the recording control for good when the provider answer is lost", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				return new Response(JSON.stringify({ message: "The provider answer was lost" }), { status: 502 });
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() =>
			expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable"),
		);

		expect(button.disabled).toBe(true);
		// The meeting is now in recording_start_unknown: it records nothing and admits nobody.
		// Both facts have to reach the host, because neither is visible in the room otherwise.
		expect(document.getElementById("call-status")!.textContent).toBe(
			"Recording could not be started. This meeting will not be saved, and no one else can join.",
		);
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(1);
	});

	test("keeps the recording control usable when the provider refuses the start", async () => {
		const sdk = make_fake_sdk();
		let startCalls = 0;
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				startCalls += 1;
				// A refusal is not the lost answer: the service leaves the meeting open and answers
				// with a status that is not 502, so the host can press again.
				return new Response(JSON.stringify({ message: "The provider refused to start the recording" }), {
					status: 503,
				});
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() =>
			expect(document.getElementById("host-error")!.textContent).toBe("The provider refused to start the recording"),
		);

		expect(button.disabled).toBe(false);
		expect(button.querySelector(".control-label")!.textContent).toBe("Start recording");
		expect(document.activeElement).toBe(button);
		// The meeting was never touched, so nothing may tell the host that it cannot be saved or
		// joined. That sentence belongs to the lost-answer case only.
		expect(document.getElementById("call-status")!.hidden).toBe(true);

		button.click();
		await vi.waitFor(() => expect(startCalls).toBe(2));
	});

	test("gives focus back when a held start-recording request fails behind a live broadcast", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				const signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		// The control stays enabled while the request runs, so the host's place in the page is that
		// button.
		button.focus();
		button.click();
		expect(button.getAttribute("aria-busy")).toBe("true");

		// The provider's own broadcast reaches the browser while the request is still in the air, and
		// renderRecordingState disables the control for an active recording. A real browser blurs a
		// focused element the moment it turns disabled; happy-dom keeps the focus instead. So blur
		// while the control is still enabled and let the broadcast land after, which reaches the same
		// state a browser really produces: a disabled control with focus on the body.
		button.blur();
		expect(document.activeElement).toBe(document.body);
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(button.disabled).toBe(true);

		await vi.advanceTimersByTimeAsync(30_000);

		// The line used to say the start took too long and to offer a retry. Both were wrong here:
		// the recording is running, and startRecording refuses every press while it is. The test
		// below pins that whole branch; this one only needs the catch to have run.
		expect(document.getElementById("host-error")!.textContent).toBe(
			"Starting the recording got no answer, but the recording is running.",
		);
		// The catch cannot put focus back on the start button, because the broadcast disabled it.
		// Without a fallback the host was left standing on the body, inside a live call.
		expect(document.activeElement).not.toBe(document.body);
		// The fallback used to be .call-heading, and that met the letter of the line above without
		// meeting its point. That heading is 1px and clipped, so a focus ring on it paints nothing:
		// measured in Chromium, focusing it changed 0 pixels, while focusing the mute control in the
		// same check did change pixels. The host was standing somewhere, with no way to see where.
		// Park them on the banner instead, which is the sentence that explains what happened.
		// happy-dom focuses any element, so the tabindex="-1" that makes this work in a browser is
		// pinned in page.test.ts instead.
		expect(document.activeElement).toBe(document.getElementById("host-error"));
	});

	test("a 409 already-running answer behind a live broadcast shows the server sentence", async () => {
		const sdk = make_fake_sdk();
		let resolveStart: ((response: Response) => void) | undefined;
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") return undefined;
				return new Promise<Response>((resolve) => {
					resolveStart = resolve;
				});
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		// The other tab's recording broadcast lands while this tab's request is still in the air.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");

		resolveStart!(
			new Response(JSON.stringify({ message: "The recording is already running" }), { status: 409 }),
		);
		await vi.waitFor(() =>
			expect(document.getElementById("host-error")!.textContent).toBe("The recording is already running"),
		);
	});

	test("does not claim nothing was recorded while the provider is recording the room", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
				}
				if (path !== "/room/api/host/start-recording") return undefined;
				// The abort has to be the client's own deadline. A mock that ignores the signal never
				// settles, the catch never runs, and the test proves nothing about this branch.
				const signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		// The provider starts recording everyone and broadcasts it while the host's own request is
		// still in the air. The room lights the pill, the button reads "Recording", and the live
		// region has already told the host that the recording started.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording");
		expect(document.getElementById("recording-live")!.textContent).toBe("Recording has started.");

		await vi.advanceTimersByTimeAsync(30_000);

		// The catch used to reset the stage to "idle", and both end dialogs branch on the stage
		// alone. The host was asked to end a meeting that "started no recording" while every other
		// participant was being recorded.
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. Council will prepare the recording files.",
		);

		// The old line offered a retry that startRecording refuses on the spot, because it ignores
		// every press while a recording is active.
		expect(document.getElementById("host-error")!.textContent).toBe(
			"Starting the recording got no answer, but the recording is running.",
		);
		expect(document.getElementById("host-error")!.textContent).not.toContain("try again");
		button.click();
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(1);

		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording files will appear on the Council page when they are ready.",
		);
	});

	test("the close answer's recorded truth beats a start still in the air", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") {
					// The server read the row after admission closed: the start attached in time.
					return new Response(JSON.stringify({ status: "processing", recorded: true }), { status: 200 });
				}
				// Leave the start request in the air so the stage is still "pending" at close.
				if (path === "/room/api/host/start-recording") {
					return new Promise<Response>(() => {});
				}
				return undefined;
			},
		});

		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The page alone could only hedge ("If the recording started…"). The close answer knows.
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording files will appear on the Council page when they are ready.",
		);
	});

	test("the close answer's recorded truth beats a recording the provider showed but never stored", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/host/close") {
					// The server read the row after admission closed: no recording id ever attached,
					// so no files can come — whatever the provider broadcast to this page.
					return new Response(JSON.stringify({ status: "ready", recorded: false }), { status: 200 });
				}
				if (path !== "/room/api/host/start-recording") return undefined;
				const signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});

		// The provider broadcast lights the recording stage while the host's own request times out,
		// exactly like the test above — the page believes a recording is running.
		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		await vi.advanceTimersByTimeAsync(30_000);

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// Without the server's answer this page would promise files that can never arrive. But this
		// page also announced "Recording has started.", so the message must not deny a recording ran:
		// "could not be saved" holds both facts.
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording could not be saved, so there are no files to prepare.",
		);
	});

	test("the close answer's recorded truth beats a recording the provider ran and stopped but never stored", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "ready", recorded: false }), { status: 200 });
				}
				if (path !== "/room/api/host/start-recording") return undefined;
				const signal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});

		// Same setup as the test above, but the provider also shows the recording stopping, so the
		// stage sits at "finished" instead of "requested" when the close answers.
		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		await vi.advanceTimersByTimeAsync(30_000);
		sdk.recording.recordingState = "STOPPED";
		sdk.recording.emit("recordingUpdate", "STOPPED");

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The page watched the whole recording run, so the message must not say none was started. No
		// id was ever stored, so it must not promise files either.
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording could not be saved, so there are no files to prepare.",
		);
	});

	test("takes the session token back once and still starts the recording", async () => {
		const sdk = make_fake_sdk();
		let startCalls = 0;
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/session") {
					return new Response(JSON.stringify({ ...HOST_SESSION, csrfToken: "csrf-2" }), { status: 200 });
				}
				if (path !== "/room/api/host/start-recording") return undefined;
				startCalls += 1;
				// A second document on this room URL resumed the cookie session, which rotates the
				// CSRF token, so the first press is refused with the token this page still holds. A
				// meeting is recorded at most once, so a press lost this way costs the recording.
				if (startCalls === 1) {
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});

		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(document.getElementById("call-status")!.textContent).toBe("Recording is starting."),
		);

		expect(startCalls).toBe(2);
		expect(document.getElementById("host-error")!.hidden).toBe(true);
	});

	test("resumes the session once for two calls that are refused together", async () => {
		vi.useFakeTimers();
		// Model the service side: one session holds one CSRF token, and every resume replaces it.
		// A fixture that hands the same token back twice cannot show this bug at all.
		let sessionPosts = 0;
		let serverToken = "";
		let releaseResume!: () => void;
		const resumeGate = new Promise<void>((resolve) => {
			releaseResume = resolve;
		});
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/session") {
					sessionPosts += 1;
					serverToken = `csrf-${sessionPosts}`;
					const body = JSON.stringify({ ...HOST_SESSION, csrfToken: serverToken });
					// Hold every resume after this page's own boot, so both refused calls are waiting
					// on the refresh at the same moment.
					return sessionPosts === 1
						? new Response(body, { status: 200 })
						: resumeGate.then(() => new Response(body, { status: 200 }));
				}
				if (path !== "/room/api/state" && path !== "/room/api/host/start-recording") return undefined;
				if (new Headers(init?.headers).get("X-Council-Csrf") !== serverToken) {
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				return path === "/room/api/state"
					? new Response(JSON.stringify({ meeting: { ...HOST_SESSION.meeting, status: "open" } }), {
							status: 200,
						})
					: new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});

		// A second document on this room URL resumed the cookie session, so this page's token is now
		// the one the service replaced. Every route that checks it refuses this page from here on.
		serverToken = "other-document";

		// The host presses Start recording, and the ten-second meeting-state poll lands while that
		// press is still waiting for the resume. No second tab is needed for this: the poll runs the
		// whole time the call does.
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		releaseResume();

		// Wait for the press to settle, whichever way it settles. The control drops aria-busy on
		// success and on failure alike, so this does not wait for the answer the test wants and then
		// time out into an unreadable failure when the answer is the wrong one.
		await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBe(null));

		// Two resumes rotate the service token twice, and the service keeps only the last one. The
		// call that resumed first then repeats itself with a token that is already dead, takes a
		// second refusal, and this is the sentence that refusal puts in front of the host, in the
		// middle of a call that is fine. Nothing ever takes it away either.
		expect(document.getElementById("host-error")!.textContent).toBe("");
		// One resume for both calls is what prevents that.
		expect(sessionPosts).toBe(2);
		expect(document.getElementById("call-status")!.textContent).toBe("Recording is starting.");
	});

	test("reports a revoked microphone permission during the call", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		sdk.self.audioEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "SYSTEM_DENIED" });

		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. Check the browser microphone permission.",
		);
		expect(document.getElementById("mute-button")!.getAttribute("aria-pressed")).toBe("false");
	});

	test("says why a device stopped feeding the call, and stays quiet on a grant", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;
		expect(status.hidden).toBe(true);

		// ACCEPTED is the one message in the SDK 2.0.1 vocabulary that leaves the track working, so it
		// is the one that needs no notice.
		sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "ACCEPTED" });
		expect(status.hidden).toBe(true);

		// COULD_NOT_START is where the SDK's Chromium mapper sends NotReadableError and every error it
		// does not recognise: another app holds the device, the hardware failed, it was unplugged. The
		// SDK has already turned the track off, so silence leaves the microphone dead mid-sentence.
		sdk.self.audioEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "COULD_NOT_START" });

		expect(status.hidden).toBe(false);
		expect(status.textContent).toBe(
			"Microphone unavailable. Close any other app using it, then turn the microphone on.",
		);
		// A busy device is not a permission answer, so pointing at the permission sends the listener to
		// check the wrong thing.
		expect(status.textContent).not.toContain("permission");

		// NO_DEVICES_AVAILABLE is the sixth message of that vocabulary. The SDK sends it when the
		// browser lists no input of that kind at all: a desktop with no webcam, a camera switched off
		// in the system settings, an unplugged headset. There is no permission to fix, so a member
		// sent to the permission panel finds it already allowed and has nowhere else to go.
		sdk.self.videoEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "video", message: "NO_DEVICES_AVAILABLE" });

		expect(status.textContent).toBe("Camera unavailable. No camera was found. Connect one, then turn the camera on.");
		expect(status.textContent).not.toContain("permission");
	});

	test("leaves focus on an enabled dialog control while close is pending", async () => {
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/close") return undefined;
				return closeGate.then(() => new Response(JSON.stringify({ status: "processing" }), { status: 200 }));
			},
		});
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		const dialog = document.getElementById("host-confirm")!;
		const confirm = document.getElementById("host-confirm-yes") as HTMLButtonElement;
		const cancel = document.getElementById("host-confirm-cancel") as HTMLButtonElement;
		// Focus the button before pressing it, the way a real mouse press does. happy-dom's click()
		// does not, and openEndConfirm has just put focus on Cancel, so without this line the
		// assertion below reads that earlier focus and passes whatever confirmEndMeeting does.
		confirm.focus();
		confirm.click();

		expect(dialog.hidden).toBe(false);
		expect(confirm.disabled).toBe(true);
		expect(confirm.textContent).toBe("Ending…");
		// happy-dom does not blur a focused element when it turns disabled either, so focus stays on
		// the confirm button unless the client moves it off. A real browser drops it to the body
		// instead, inside a modal dialog. Either way the host has to end up on a control they can
		// use, so assert that shape: still inside the dialog, and enabled.
		const active = document.activeElement as HTMLButtonElement | null;
		expect(dialog.contains(active)).toBe(true);
		expect(active!.disabled).toBe(false);
		expect(active).toBe(cancel);
		expect(document.getElementById("host-confirm-text")!.textContent).toContain("Ending the meeting");
		releaseClose();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
	});

	test("lets Escape abort a close whose answer never arrives", async () => {
		const sdk = make_fake_sdk();
		let closeSignal: AbortSignal | undefined;
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/host/close") return undefined;
				closeSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					closeSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});
		const endButton = document.getElementById("end-meeting-button") as HTMLButtonElement;
		const dialog = document.getElementById("host-confirm")!;
		const confirm = document.getElementById("host-confirm-yes") as HTMLButtonElement;
		endButton.click();
		confirm.click();
		expect(confirm.disabled).toBe(true);
		expect(endButton.disabled).toBe(true);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

		expect(closeSignal?.aborted).toBe(true);
		await vi.waitFor(() => expect(endButton.disabled).toBe(false));
		expect(dialog.hidden).toBe(true);
		expect(confirm.disabled).toBe(false);
		expect(confirm.textContent).toBe("End meeting");
		expect(document.activeElement).toBe(endButton);
		expect(document.getElementById("host-error")!.textContent).toContain("got no answer");
	});

	test("aborts a close at its deadline instead of leaving the dialog up", async () => {
		const sdk = make_fake_sdk();
		let closeSignal: AbortSignal | undefined;
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/host/close") return undefined;
				closeSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					closeSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});
		const endButton = document.getElementById("end-meeting-button") as HTMLButtonElement;
		endButton.click();
		vi.useFakeTimers();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();

		await vi.advanceTimersByTimeAsync(30_000);

		expect(closeSignal?.aborted).toBe(true);
		expect(document.getElementById("host-confirm")!.hidden).toBe(true);
		expect(endButton.disabled).toBe(false);
		expect(document.getElementById("host-error")!.textContent).toContain("got no answer");
	});

	test("takes the session token back once and ends the meeting anyway", async () => {
		const sdk = make_fake_sdk();
		let closeCalls = 0;
		const closeTokens: (string | null)[] = [];
		const sessionBodies: string[] = [];
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path === "/room/api/session") {
					sessionBodies.push(String(init?.body));
					// The first post is this page's own boot, which hands out csrf-1. The second is
					// the refresh, and it hands out the token the other document rotated in.
					return new Response(
						JSON.stringify({ ...HOST_SESSION, csrfToken: `csrf-${sessionBodies.length}` }),
						{ status: 200 },
					);
				}
				if (path !== "/room/api/host/close") return undefined;
				closeCalls += 1;
				closeTokens.push(new Headers(init?.headers).get("X-Council-Csrf"));
				// A second document on this same room URL resumed the cookie session, which rotates
				// the CSRF token, so the token this page still holds is refused.
				if (closeCalls === 1) {
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
			},
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The host pressed End for all once and the meeting really ended. Before this, the bare word
		// "Unauthorized" landed in the host error and the meeting stayed open.
		expect(closeCalls).toBe(2);
		expect(closeTokens).toEqual(["csrf-1", "csrf-2"]);
		expect(document.getElementById("host-error")!.hidden).toBe(true);
		// The refresh names the meeting this page is in. Without it the resume would adopt whatever
		// meeting the room cookie points at.
		expect(sessionBodies[1]).toBe(JSON.stringify({ meetingId: "m1" }));
	});

	test("traps focus in the end dialog and restores focus on Escape", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		const endButton = document.getElementById("end-meeting-button") as HTMLButtonElement;
		const dialog = document.getElementById("host-confirm")!;
		const cancelButton = document.getElementById("host-confirm-cancel") as HTMLButtonElement;
		const confirmButton = document.getElementById("host-confirm-yes") as HTMLButtonElement;
		endButton.click();

		expect(dialog.hidden).toBe(false);
		// Focus moves into the dialog so a screen reader reads the heading and the warning, but it
		// lands on Cancel: a held Enter would otherwise open this dialog and confirm it in one press.
		expect(document.activeElement).toBe(cancelButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		expect(document.activeElement).toBe(confirmButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		expect(document.activeElement).toBe(cancelButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(dialog.hidden).toBe(true);
		expect(document.activeElement).toBe(endButton);
	});

	test("keeps Tab inside the end dialog after a click that lands on no button", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		const dialog = document.getElementById("host-confirm")!;
		const cancelButton = document.getElementById("host-confirm-cancel") as HTMLButtonElement;
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();

		// A click on the backdrop, on the heading or on the warning line puts focus on the body. The
		// dialog blocks the pointer correctly, so this is keyboard-only and it looks sealed.
		cancelButton.blur();
		expect(dialog.contains(document.activeElement)).toBe(false);

		const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
		document.dispatchEvent(backwards);

		// Without this the browser's own Tab order took over and walked straight out of the dialog:
		// Shift+Tab from the body reaches Leave first, and Enter there takes the host out of the
		// meeting while the dialog is still asking whether to end it for everyone.
		expect(backwards.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(cancelButton);

		cancelButton.blur();
		const forwards = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.dispatchEvent(forwards);

		expect(forwards.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(cancelButton);
	});

	test("one held Enter cannot open and confirm the end dialog", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/close") return undefined;
				return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
			},
		});
		const dialog = document.getElementById("host-confirm")!;
		const confirmButton = document.getElementById("host-confirm-yes") as HTMLButtonElement;

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();

		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(confirmButton);

		// A real browser activates a focused button on Enter keydown, and the operating system
		// repeats keydown while the key stays down. happy-dom runs no default action for a key
		// event, so do what the browser would do: the repeat press activates whatever has focus.
		const active = document.activeElement as HTMLButtonElement;
		active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
		active.click();

		expect(fetchMock.mock.calls.some(([path]) => path === "/room/api/host/close")).toBe(false);
		expect(document.getElementById("view-call")!.hidden).toBe(false);
	});

	test("tells the host in the end dialog that nothing was recorded", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const question = document.getElementById("host-confirm-text")!;

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();

		// The room knows the answer at the moment it asks the question, and this dialog is the last
		// moment a host who meant to record and forgot can still act on it.
		expect(question.textContent).toBe(
			"Everyone will leave the room. No recording was started, so there will be no files to prepare.",
		);
		expect(question.textContent).not.toContain("If recording was started");
	});

	test("does not ask the host about files after the recording start was lost", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "The provider answer was lost" }), { status: 502 })
					: undefined,
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() => expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable"));

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();

		// The room told the host seconds ago that this meeting would not be saved. Asking about files
		// here would take that back at the very last moment.
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. The recording could not be started, so this meeting will not be saved.",
		);
	});

	test("keeps a lost recording start unavailable when the provider broadcasts one anyway", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
				}
				return path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "The provider answer was lost" }), { status: 502 })
					: undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() => expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable"));

		// The 502 says the service stored no recording id, so no files can ever be sealed for this
		// meeting. The provider can still be running a recording of its own and broadcast it, and
		// renderRecordingState moves the stage with that broadcast. "unavailable" is the one stage it
		// may not move: promoting it would promise the host files that cannot arrive, seconds after
		// the room told them the meeting would not be saved.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		expect(document.getElementById("recording-indicator")!.hidden).toBe(false);

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. The recording could not be started, so this meeting will not be saved.",
		);

		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording could not be started, so this meeting was not saved.",
		);
	});

	test("keeps a lost recording start unavailable after the provider's recording stops", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
				}
				return path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "The provider answer was lost" }), { status: 502 })
					: undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() => expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable"));

		// The twin of the test above, on the other edge. The provider keeps the recording it started
		// and stops it at its max_seconds cap. The stop edge moved the stage to "finished" for any
		// stage at all, and "finished" reads as "Council will prepare the recording files" in both
		// end wordings, so the room took its own answer back and sent the host to wait for files the
		// service holds no id for.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		sdk.recording.recordingState = "IDLE";
		sdk.recording.emit("recordingUpdate", "IDLE");

		expect(document.getElementById("recording-live")!.textContent).toBe("Recording has stopped.");
		expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable");

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. The recording could not be started, so this meeting will not be saved.",
		);

		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
		const message = document.getElementById("ended-message")!.textContent ?? "";
		expect(message).toBe("You ended the meeting. The recording could not be started, so this meeting was not saved.");
		expect(message).not.toContain("Council page");
	});

	test("does not promise files when the service could not store the recording id", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
				}
				// handle_start_recording answers 500 when the provider started a recording and the
				// write that stores its id failed. The service stops that recording itself and keeps
				// no id, so nothing can seal files for it however long it ran.
				return path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "Storing the recording failed" }), { status: 500 })
					: undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		// The provider's broadcast reaches the browser before the answer does, so the stage is
		// already "requested" when the 500 lands. The test below runs the other order, and the room
		// has to reach the same place from both.
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		await vi.waitFor(() => expect(document.getElementById("host-error")!.hidden).toBe(false));

		// The old line said no answer arrived. The service answered, and it said the recording is
		// not being kept. The second sentence is new: this used to be a dead end, on the reasoning
		// that the control was closed anyway. It was not. The 500 leaves the meeting open with no
		// recording on it, handle_start_recording says in its own comment that the host may retry,
		// and the answer 500 exists to separate that case from the 502 that really is a dead end.
		expect(document.getElementById("host-error")!.textContent).toBe(
			"The recording could not be saved, so it produced no files. You can start a new recording.",
		);

		// The service stops the recording it could not keep, and the stop edge used to move the
		// stage to "finished" from here. "unsaved" holds through both edges, so the room keeps
		// saying no files while the control comes back for a new attempt.
		sdk.recording.recordingState = "IDLE";
		sdk.recording.emit("recordingUpdate", "IDLE");
		expect(button.disabled).toBe(false);
		expect(button.querySelector(".control-label")!.textContent).toBe("Start recording");

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. The recording could not be saved, so there will be no files to prepare.",
		);

		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
		const message = document.getElementById("ended-message")!.textContent ?? "";
		expect(message).toBe("You ended the meeting. The recording could not be saved, so there are no files to prepare.");
		expect(message).not.toContain("Council page");
	});

	test("does not promise files when the 500 lands before the provider's broadcast", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
				}
				return path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "Storing the recording failed" }), { status: 500 })
					: undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		// The twin of the test above, on the other side of the race. The answer wins this time, and
		// the provider's broadcast arrives after it. Nothing about the service differs: it stopped
		// the recording it could not store and holds no id for it either way.
		await vi.waitFor(() => expect(document.getElementById("host-error")!.hidden).toBe(false));
		sdk.recording.recordingState = "RECORDING";
		sdk.recording.emit("recordingUpdate", "RECORDING");
		sdk.recording.recordingState = "IDLE";
		sdk.recording.emit("recordingUpdate", "IDLE");

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		const question = document.getElementById("host-confirm-text")!.textContent ?? "";
		// While the 500 branch sat inside the recordingActive check, this order fell past it to
		// "idle". The late broadcast then promoted "idle" to "requested" and its stop edge moved
		// that to "finished", and both end wordings read "finished" as files on the way. The host
		// was sent to wait for files the service holds no id for.
		expect(question).not.toContain("Council will prepare the recording files");
		expect(question).toBe(
			"Everyone will leave the room. The recording could not be saved, so there will be no files to prepare.",
		);

		// The service left the meeting open with no recording on it, so a new press can still work.
		// The stage says "no files from that attempt" without closing the control.
		expect(button.disabled).toBe(false);
		expect(button.querySelector(".control-label")!.textContent).toBe("Start recording");

		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
		const message = document.getElementById("ended-message")!.textContent ?? "";
		expect(message).toBe("You ended the meeting. The recording could not be saved, so there are no files to prepare.");
		expect(message).not.toContain("Council page");
	});

	test("lets the host start a new recording after the service could not store the last one", async () => {
		const sdk = make_fake_sdk();
		let startCalls = 0;
		const { fetchMock } = await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/host/start-recording") {
					return undefined;
				}
				startCalls += 1;
				// The failed write left the meeting open with no recording on it, so the second press
				// passes every check the first one passed and attaches this time.
				return startCalls === 1
					? new Response(JSON.stringify({ message: "Storing the recording failed" }), { status: 500 })
					: new Response(JSON.stringify({ recording: true }), { status: 200 });
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() => expect(document.getElementById("host-error")!.hidden).toBe(false));

		// An enabled control that startRecording refuses is worse than a disabled one: it looks like
		// a way out and does nothing. The stage guard and the disabled guard have to agree, so press
		// it and check the service was really asked again.
		expect(button.disabled).toBe(false);
		button.click();
		await vi.waitFor(() => expect(startCalls).toBe(2));
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/host/start-recording")).toHaveLength(2);

		// The new attempt succeeded, so the room may promise its files again. The banner the failed
		// attempt left behind is gone with it.
		await vi.waitFor(() =>
			expect(button.querySelector(".control-label")!.textContent).toBe("Recording requested"),
		);
		expect(document.getElementById("host-error")!.hidden).toBe(true);

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(
			"Everyone will leave the room. Council will prepare the recording files.",
		);
	});

	test("tells the host on the ended screen that no recording was started", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/close" ? new Response(JSON.stringify({ status: "ready" }), { status: 200 }) : undefined,
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. No recording was started, so there are no files to prepare.",
		);
	});

	test("does not send the host to wait for files after a recording that never started", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/start-recording") {
					return new Response(JSON.stringify({ message: "The provider answer was lost" }), { status: 502 });
				}
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
				}
				return undefined;
			},
		});
		const button = document.getElementById("start-recording-button") as HTMLButtonElement;

		button.click();
		await vi.waitFor(() => expect(button.querySelector(".control-label")!.textContent).toBe("Recording unavailable"));
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The room told the host thirty seconds ago that this meeting would not be saved. Sending
		// them to the Council page to wait for files would take that back.
		const message = document.getElementById("ended-message")!.textContent ?? "";
		expect(message).toBe("You ended the meeting. The recording could not be started, so this meeting was not saved.");
		expect(message).not.toContain("Council page");
	});

	test("promises the files on the ended screen for a meeting that recorded", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			session: { ...HOST_SESSION, meeting: { ...HOST_SESSION.meeting, recordingStarted: true } },
			fetchHandler: (path) =>
				path === "/room/api/host/close" ? new Response(JSON.stringify({ status: "processing" }), { status: 200 }) : undefined,
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording files will appear on the Council page when they are ready.",
		);
	});

	test("keeps the host's own ended message when a state poll reads the close first", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		let statePolls = 0;
		let releaseClose!: (response: Response) => void;
		const closeGate = new Promise<Response>((resolve) => {
			releaseClose = resolve;
		});
		await boot_to_call(sdk, {
			session: { ...HOST_SESSION, meeting: { ...HOST_SESSION.meeting, recordingStarted: true } },
			fetchHandler: (path) => {
				if (path === "/room/api/host/close") return closeGate;
				if (path !== "/room/api/state") return undefined;
				statePolls += 1;
				// The service commits the closed transition in its database before it does any
				// provider or Convex work, and it answers the host only after all of it. So the poll
				// really can read "closed" while the host's own close is still in the air.
				return new Response(
					JSON.stringify({ meeting: { ...HOST_SESSION.meeting, recordingStarted: true, status: "closed" } }),
					{ status: 200 },
				);
			},
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(statePolls).toBe(1);

		releaseClose(new Response(JSON.stringify({ status: "processing" }), { status: 200 }));
		await vi.advanceTimersByTimeAsync(0);

		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		// The poll used to win this race: it ended the call with the neutral line, and the close's own
		// answer then hit endLocally's early return. A host who recorded was told the meeting ended,
		// with nothing about the files the dialog had just promised them seconds earlier.
		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording files will appear on the Council page when they are ready.",
		);
	});

	test("keeps the host's own ended message when the provider kick arrives first", async () => {
		const sdk = make_fake_sdk();
		let releaseClose!: (response: Response) => void;
		const closeGate = new Promise<Response>((resolve) => {
			releaseClose = resolve;
		});
		await boot_to_call(sdk, {
			session: { ...HOST_SESSION, meeting: { ...HOST_SESSION.meeting, recordingStarted: true } },
			fetchHandler: (path) => (path === "/room/api/host/close" ? closeGate : undefined),
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();

		// council_close_meeting commits the closed transition, then kicks the provider room, and
		// only then stops the recording, seals the meeting and projects it before it answers. The
		// pinned SDK turns a kickAll into leaveRoom("ended"), so this frame reaches the host two to
		// four outbound calls ahead of the answer — essentially always, not occasionally. It used to
		// end the call with the neutral line, and the close's own answer then hit endLocally's early
		// return: the host who recorded was told the meeting had ended, seconds after the dialog
		// promised them their files.
		sdk.self.emit("roomLeft", { state: "ended" });
		expect(document.getElementById("view-ended")!.hidden).toBe(true);
		expect(document.getElementById("view-call")!.hidden).toBe(false);

		releaseClose(new Response(JSON.stringify({ status: "processing" }), { status: 200 }));
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. The recording files will appear on the Council page when they are ready.",
		);
	});

	test("keeps the ended screen conditional while a recording start is still in the air", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/host/start-recording") {
					return new Promise<Response>(() => {});
				}
				if (path === "/room/api/host/close") {
					return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
				}
				return undefined;
			},
		});

		// The start request has no answer yet, so the close decides it. Neither promise nor refusal
		// is known here, and the wording has to stay conditional.
		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		expect(document.getElementById("ended-message")!.textContent).toBe(
			"You ended the meeting. If the recording started, its files will appear on the Council page when they are ready.",
		);
	});

	test("clears the end dialog once the close finishes", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/close" ? new Response(JSON.stringify({ status: "ready" }), { status: 200 }) : undefined,
		});
		const dialog = document.getElementById("host-confirm")!;
		const confirmButton = document.getElementById("host-confirm-yes") as HTMLButtonElement;
		const endButton = document.getElementById("end-meeting-button") as HTMLButtonElement;
		const question = document.getElementById("host-confirm-text")!.textContent;

		endButton.click();
		confirmButton.click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The dialog is invisible only because the call view is hidden. Left open, it covers the next
		// call in this same document with a modal that ends a meeting nobody is ending.
		expect(dialog.hidden).toBe(true);
		expect(confirmButton.disabled).toBe(false);
		expect(confirmButton.textContent).toBe("End meeting");
		expect(document.getElementById("host-confirm-text")!.textContent).toBe(question);
		expect(endButton.disabled).toBe(false);
	});

	test("starts the next call in the same document without the stale end dialog", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/close" ? new Response(JSON.stringify({ status: "ready" }), { status: 200 }) : undefined,
		});
		const dialog = document.getElementById("host-confirm")!;
		const endButton = document.getElementById("end-meeting-button") as HTMLButtonElement;

		endButton.click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		// The host pastes a fresh room link into the same document and joins the next meeting.
		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		expect(dialog.hidden).toBe(true);
		expect(endButton.disabled).toBe(false);
	});

	test("frees a media control whose provider call never settled before the call ended", async () => {
		const sdk = make_fake_sdk();
		sdk.self.enableVideo = vi.fn(() => new Promise<void>(() => {}));
		await boot_to_call(sdk);
		const camera = document.getElementById("camera-button") as HTMLButtonElement;

		// A browser permission prompt keeps enableVideo() pending for as long as it is open.
		camera.click();
		expect(camera.getAttribute("aria-busy")).toBe("true");

		// The meeting ends while that toggle is still in the air, and the host pastes a fresh room
		// link into the same document.
		sdk.self.emit("roomLeft", { state: "ended" });
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));

		expect(camera.getAttribute("aria-busy")).toBe(null);
		expect(camera.disabled).toBe(false);
	});

	test("keeps a stale media promise from unlocking the next call's camera button", async () => {
		const first = make_fake_sdk();
		let settleFirstVideo!: () => void;
		first.self.enableVideo = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settleFirstVideo = resolve;
				}),
		);
		const second = make_fake_sdk();
		second.self.enableVideo = vi.fn(() => new Promise<void>(() => {}));
		let initCalls = 0;
		await boot_to_call(first, {
			init: vi.fn(() => Promise.resolve(initCalls++ === 0 ? first : second)),
		});
		const camera = document.getElementById("camera-button") as HTMLButtonElement;

		// A browser permission prompt keeps the first call's enableVideo() pending, and the host
		// leaves and rejoins while it is still open.
		camera.click();
		(document.getElementById("leave-button") as HTMLButtonElement).click();
		(document.getElementById("rejoin-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		camera.click();
		expect(camera.getAttribute("aria-busy")).toBe("true");

		// The host finally answers the old prompt. Both calls share this one button, so a settle that
		// belongs to the call already over must not clear the mark the current call is standing on.
		settleFirstVideo();
		await Promise.resolve();
		await Promise.resolve();

		expect(camera.getAttribute("aria-busy")).toBe("true");
		camera.click();
		expect(second.self.enableVideo).toHaveBeenCalledTimes(1);
	});

	test("keeps a stale media refusal from unlocking the next call's microphone button", async () => {
		const first = make_fake_sdk();
		first.self.audioEnabled = true;
		let refuseFirstAudio!: (error: Error) => void;
		first.self.disableAudio = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					refuseFirstAudio = reject;
				}),
		);
		const second = make_fake_sdk();
		second.self.audioEnabled = true;
		second.self.disableAudio = vi.fn(() => new Promise<void>(() => {}));
		let initCalls = 0;
		await boot_to_call(first, {
			init: vi.fn(() => Promise.resolve(initCalls++ === 0 ? first : second)),
		});
		const mute = document.getElementById("mute-button") as HTMLButtonElement;

		mute.click();
		(document.getElementById("leave-button") as HTMLButtonElement).click();
		(document.getElementById("rejoin-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		mute.click();
		expect(mute.getAttribute("aria-busy")).toBe("true");

		// The refusal belongs to the call that is already over. Its branch carries the same stale-call
		// guard as the one that succeeds, so it must not clear the mark either.
		refuseFirstAudio(new Error("permission denied"));
		await Promise.resolve();
		await Promise.resolve();

		expect(mute.getAttribute("aria-busy")).toBe("true");
		mute.click();
		expect(second.self.disableAudio).toHaveBeenCalledTimes(1);
	});

	test("does not tell a participant who left that the meeting ended", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const heading = document.getElementById("ended-heading")!;

		(document.getElementById("leave-button") as HTMLButtonElement).click();

		// The heading labels this whole view and is the element showView puts focus on, so a screen
		// reader may read it and nothing else. The meeting is still running for everyone else, and the
		// message and the Rejoin button under it say the opposite of "Meeting ended".
		expect(heading.textContent).not.toBe("Meeting ended");
		expect(heading.textContent).toBe("You left the meeting");
		expect(document.getElementById("ended-message")!.textContent).toBe("You left the meeting.");
		expect(document.getElementById("rejoin-button")!.hidden).toBe(false);
	});

	test("keeps the ended heading for a meeting the poll found closed", async () => {
		vi.useFakeTimers();
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/state"
					? new Response(JSON.stringify({ meeting: { ...HOST_SESSION.meeting, status: "closed" } }), { status: 200 })
					: undefined,
		});

		await vi.advanceTimersByTimeAsync(10_000);

		// This end really is over, so the heading keeps the words the document ships with.
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(document.getElementById("ended-heading")!.textContent).toBe("Meeting ended");
		expect(document.getElementById("rejoin-button")!.hidden).toBe(true);
	});

	test("does not carry a stale host error into the next call in the same document", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) =>
				path === "/room/api/host/start-recording"
					? new Response(JSON.stringify({ message: "The provider refused to start the recording" }), { status: 503 })
					: undefined,
		});
		const hostError = document.getElementById("host-error")!;

		(document.getElementById("start-recording-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(hostError.hidden).toBe(false));

		(document.getElementById("leave-button") as HTMLButtonElement).click();
		(document.getElementById("rejoin-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		// The recording control is back to idle. A red alert about a refusal it no longer remembers
		// contradicts the only control it belongs to.
		expect(hostError.hidden).toBe(true);
		expect(hostError.textContent).toBe("");
		expect((document.getElementById("start-recording-button") as HTMLButtonElement).disabled).toBe(false);
	});

	test("offers a rejoin only after the participant left by choice", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const rejoin = document.getElementById("rejoin-button") as HTMLButtonElement;

		sdk.self.emit("roomLeft", { state: "ended" });
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(rejoin.hidden).toBe(true);
	});

	test("rejoins from the ended view through the room cookie", async () => {
		const sdk = make_fake_sdk();
		const { fetchMock } = await boot_to_call(sdk);
		const rejoin = document.getElementById("rejoin-button") as HTMLButtonElement;

		(document.getElementById("leave-button") as HTMLButtonElement).click();
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(document.getElementById("ended-message")!.textContent).toBe("You left the meeting.");
		expect(rejoin.hidden).toBe(false);

		const sessionCallsBefore = fetchMock.mock.calls.filter(([path]) => path === "/room/api/session").length;
		rejoin.click();
		// The control keeps focus while the session request runs, so a repeat press must be
		// ignored rather than sending a second request.
		rejoin.click();
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		expect(fetchMock.mock.calls.filter(([path]) => path === "/room/api/session")).toHaveLength(
			sessionCallsBefore + 1,
		);
	});

	test("keeps tiles during disconnect but ends for a terminal roomLeft state", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const tile = document.querySelector(".participant-tile");

		sdk.self.emit("roomLeft", { state: "disconnected" });
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(document.querySelector(".participant-tile")).toBe(tile);
		expect(document.getElementById("call-status")!.textContent).toBe("Connection lost. Reconnecting…");

		// "failed" is the SDK giving up: a socket reconnect out of attempts, or a failed room node.
		// Both log that the SDK has to be created again, and nothing retries after either. The
		// meeting keeps running, so the state poll never ends this call — only this participant is
		// gone. Promising a reconnect here left them watching stale tiles for good, with no deadline,
		// no clear, and nothing pointing at the one control that still works.
		sdk.self.emit("roomLeft", { state: "failed" });
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(document.getElementById("call-status")!.textContent).toBe(
			"The connection to the meeting was lost. Press Leave, then rejoin from the next screen.",
		);
		expect(document.getElementById("connection-status")!.textContent).toContain("Connection problem");

		sdk.self.emit("roomLeft", { state: "ended" });
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(document.querySelector(".participant-tile")).toBeNull();
		expect(sdk.leave).toHaveBeenCalled();
	});

	test("keeps the terminal connection guidance while a device notice arrives", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const status = document.getElementById("call-status")!;
		const terminal = "The connection to the meeting was lost. Press Leave, then rejoin from the next screen.";

		sdk.self.emit("roomLeft", { state: "failed" });
		expect(status.textContent).toBe(terminal);

		// Unplugging a headset is enough to send NO_DEVICES_AVAILABLE, so no user action is needed
		// for this to land. #call-status is a role="status" live region and nothing writes the
		// sentence above a second time, so microphone advice here became the last word a screen
		// reader heard about a dead call, next to the one control that still works.
		sdk.self.audioEnabled = false;
		sdk.self.emit("mediaPermissionUpdate", { kind: "audio", message: "NO_DEVICES_AVAILABLE" });
		expect(status.textContent).toBe(terminal);
		// Only the status line is held back. The control still has to follow the device.
		expect(document.getElementById("mute-button")!.getAttribute("aria-pressed")).toBe("false");

		// A media toggle the provider refuses is the same notice from the other side.
		sdk.self.enableVideo = vi.fn(() => Promise.reject(new Error("no camera")));
		const cameraButton = document.getElementById("camera-button") as HTMLButtonElement;
		cameraButton.click();
		await vi.waitFor(() => expect(cameraButton.getAttribute("aria-busy")).toBeNull());
		expect(status.textContent).toBe(terminal);

		// Leave is still the way out, and it still says so.
		(document.getElementById("leave-button") as HTMLButtonElement).click();
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
	});

	test("keeps the connection chip off Connected while the room is out of the meeting", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const chip = document.getElementById("connection-status")!;

		// A socket blip with the room still joined is what this chip is for, so the plain path has to
		// keep working: the guard below must not simply stop the chip from ever going green again.
		sdk.meta.emit("socketConnectionUpdate", { state: "reconnecting" });
		expect(chip.textContent).toContain("Reconnecting");
		sdk.meta.emit("socketConnectionUpdate", { state: "connected" });
		expect(chip.textContent).toContain("Connected");

		// "failed" is the SDK giving up for good. It has to be created again, so this participant is
		// not coming back without a rejoin, and the room says exactly that.
		sdk.self.emit("roomLeft", { state: "failed" });
		expect(chip.textContent).toContain("Connection problem");

		// The socket under a dead room can still report itself up. Painting the chip green there
		// contradicts the message telling the host to press Leave, and #connection-status is a
		// role="status" live region, so "Connected" became the last word a screen reader heard about
		// a connection that was gone. handleRoomJoined owns the way back to green.
		sdk.meta.emit("socketConnectionUpdate", { state: "connected" });
		expect(chip.textContent).not.toContain("Connected");
		expect(chip.textContent).toContain("Connection problem");
		expect(chip.dataset.state).toBe("problem");
		expect(document.getElementById("call-status")!.textContent).toBe(
			"The connection to the meeting was lost. Press Leave, then rejoin from the next screen.",
		);
	});

	test("keeps a recording-start-unknown meeting live until a terminal status arrives", async () => {
		vi.useFakeTimers();
		let statePolls = 0;
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/state") {
					return undefined;
				}
				statePolls += 1;
				return new Response(
					JSON.stringify({
						meeting: { ...HOST_SESSION.meeting, status: statePolls === 1 ? "recording_start_unknown" : "closed" },
					}),
					{ status: 200 },
				);
			},
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
	});

	test("runs one meeting-state poll at a time and gives it a deadline", async () => {
		vi.useFakeTimers();
		let statePolls = 0;
		const pollSignals: (AbortSignal | undefined)[] = [];
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/state") {
					return undefined;
				}
				statePolls += 1;
				const signal = init?.signal ?? undefined;
				pollSignals.push(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});

		// Three poll intervals pass while the route never answers. Without the in-flight guard the
		// room stacks one more request every ten seconds, and they all land together when the
		// network comes back.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(statePolls).toBe(1);

		// And that request cannot hang forever: it carries the same deadline as every other call.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(pollSignals[0]?.aborted).toBe(true);
	});

	test("refreshes a refused state poll and keeps its one-at-a-time slot free", async () => {
		vi.useFakeTimers();
		let statePolls = 0;
		let sessionPosts = 0;
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path === "/room/api/session") {
					sessionPosts += 1;
					// The first post is this page's own boot, the second is the refresh after the
					// refused poll. From the third on, the other document keeps the session for good.
					if (sessionPosts <= 2) {
						return new Response(JSON.stringify({ ...HOST_SESSION, csrfToken: `csrf-${sessionPosts}` }), {
							status: 200,
						});
					}
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				if (path !== "/room/api/state") return undefined;
				statePolls += 1;
				// A second document on this room URL rotated the CSRF token, so this page's token is
				// refused. Poll 1 is that refusal, poll 2 is the retry with the fresh token.
				if (statePolls === 1 || statePolls > 2) {
					return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
				}
				return new Response(JSON.stringify({ meeting: { ...HOST_SESSION.meeting, status: "open" } }), {
					status: 200,
				});
			},
		});
		const status = document.getElementById("call-status")!;

		// One refused poll, one refresh, one retry that works. Nothing is said, because nothing is
		// wrong for the person in the room.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(statePolls).toBe(2);
		expect(sessionPosts).toBe(2);
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(status.hidden).toBe(true);

		// Now the refresh is refused too, so this page cannot ask about the meeting any more and will
		// never notice that it ended. Every failure here used to be swallowed, and the room went on
		// looking healthy with its only server-side end detection dead.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(statePolls).toBe(3);
		expect(status.textContent).toBe("This room page is no longer the active one. Reload the page.");

		// The retry runs inside the poll's own request, so it takes the one-at-a-time slot once and
		// gives it back. A slot held twice would stop every later poll.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(statePolls).toBe(4);
	});

	test("frees the meeting-state poll slot when the call ends", async () => {
		vi.useFakeTimers();
		let statePolls = 0;
		const pollSignals: (AbortSignal | undefined)[] = [];
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/state") {
					return undefined;
				}
				statePolls += 1;
				const signal = init?.signal ?? undefined;
				pollSignals.push(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(statePolls).toBe(1);

		// The participant leaves while that poll is still in the air. Nothing else frees the
		// one-at-a-time slot before the request's own 30s deadline, so the next call in this same
		// document would skip its polls and never notice a meeting that ended.
		(document.getElementById("leave-button") as HTMLButtonElement).click();
		expect(pollSignals[0]?.aborted).toBe(true);

		(document.getElementById("rejoin-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));
		await vi.advanceTimersByTimeAsync(10_000);

		expect(statePolls).toBe(2);
	});

	test("frees the close latch that silences end detection when the call ends", async () => {
		let closeSignal: AbortSignal | undefined;
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, {
			fetchHandler: (path, init) => {
				if (path !== "/room/api/host/close") {
					return undefined;
				}
				closeSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					closeSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				});
			},
		});

		(document.getElementById("end-meeting-button") as HTMLButtonElement).click();
		(document.getElementById("host-confirm-yes") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(closeSignal).toBeDefined());

		// The host gives up on the answer and pastes a fresh room link into the same tab. That is a
		// hashchange, not a navigation, so nothing else replaces this document.
		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));

		// handleRoomLeft and the state poll both stay silent while a close is in the air. A latch
		// carried over from the meeting before this one leaves this call running on stale tiles until
		// the old close hits its own 30s deadline.
		sdk.self.emit("roomLeft", { state: "ended" });
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		// Aborting is what settles the old close right away, so its finally cannot later null a latch
		// a newer close has stored.
		expect(closeSignal?.aborted).toBe(true);
	});

	test("removes SDK and participant listeners on pagehide", async () => {
		const sdk = make_fake_sdk();
		const remote = make_participant("peer-2", "guest-2", "Casey");
		sdk.participants.joined.participants = [remote];
		await boot_to_call(sdk);

		window.dispatchEvent(new Event("pagehide"));

		expect(sdk.leave).toHaveBeenCalled();
		expect(sdk.self.off).toHaveBeenCalledWith("roomLeft", expect.any(Function));
		expect(sdk.participants.joined.off).toHaveBeenCalledWith("participantJoined", expect.any(Function));
		expect(remote.off).toHaveBeenCalled();
	});

	test("drops a boot answer that lands after the page was disposed", async () => {
		load_room_document();
		let releaseSession!: (response: Response) => void;
		const sessionResponse = new Promise<Response>((resolve) => {
			releaseSession = resolve;
		});
		vi.stubGlobal("fetch", vi.fn(() => sessionResponse));
		(window as CouncilWindow).__councilEntry = { ticket: null };
		new Function(council_room_client_js)();

		// dispose() is reachable from page context: the room installs it as window.__councilDispose,
		// and a pagehide that really unloads the document calls it too. The boot request is still in
		// the air when it runs here.
		(window as CouncilWindow).__councilDispose!();
		releaseSession(new Response(JSON.stringify(HOST_SESSION), { status: 200 }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The boot answers guard on the boot generation and nothing else. resumeOrGuest, the ticket
		// exchange and the guest-session answer all skip the state.over check the in-call handlers
		// carry, so the generation bump in dispose is the only thing that stops this answer from
		// rendering the lobby of a page that is already torn down.
		expect(document.getElementById("view-lobby")!.hidden).toBe(true);
	});

	test("ends the call the honest way when the page may come back from the cache", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		// happy-dom aliases PageTransitionEvent to plain Event, and a plain Event drops an unknown
		// init key, so put the flag on the event the way the browser does.
		const pageHide = new Event("pagehide");
		Object.defineProperty(pageHide, "persisted", { value: true });
		window.dispatchEvent(pageHide);

		// dispose() cannot be undone, so a restored document would show a healthy-looking call whose
		// Leave button does nothing and whose clock has stopped. The ended screen says what happened
		// and offers the way back in.
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(document.getElementById("rejoin-button")!.hidden).toBe(false);
		expect(sdk.leave).toHaveBeenCalled();
	});

	test("leaves the lobby alone when the page may come back from the cache", async () => {
		const sdk = make_fake_sdk();
		await boot_to_lobby(sdk);

		// A live call holds the microphone and Chrome refuses to cache a document that does, so the
		// lobby and the guest form are the pages this event really reaches. Nobody joined anything
		// here, so there is no meeting to leave.
		const pageHide = new Event("pagehide");
		Object.defineProperty(pageHide, "persisted", { value: true });
		window.dispatchEvent(pageHide);

		expect(document.getElementById("view-ended")!.hidden).toBe(true);
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);

		// The browser may show this very document again, so nothing was disposed either: Join still
		// works. dispose() would leave the button stuck on "Joining…" forever.
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(document.getElementById("view-call")!.hidden).toBe(false));
	});

	test("keeps the call alive through a beforeunload that never replaces the document", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);

		// A navigation whose response is 204 No Content fires beforeunload and leaves this document on
		// screen. Ending the call there strands the participant in a meeting that looks healthy but is
		// already over: Leave does nothing, so there is no way to the ended screen or to Rejoin.
		window.dispatchEvent(new Event("beforeunload"));

		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(sdk.leave).not.toHaveBeenCalled();
		expect(document.querySelector(".participant-tile")).not.toBeNull();
	});
});

describe("council_room_client_js ticket replacement", () => {
	test("blames the connection, not the room link, when the ticket never reached the service", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		// A failure to reach the service rejects with this and carries no status, because no service
		// answered it.
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
		(window as CouncilWindow).__councilEntry = { ticket: "ticket-1" };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-error")!.hidden).toBe(false));

		const message = document.getElementById("error-message")!.textContent ?? "";
		expect(message).toContain("did not answer");
		// The request never left the browser, so nothing there read the ticket. The boot script has
		// already erased it from the fragment, so telling the host their link is spent costs them a
		// second room link for a failure the link had no part in. And a raw browser string glued to
		// that claim is not a sentence anyone can act on.
		expect(message).not.toContain("single-use");
		expect(message).not.toContain("Failed to fetch");
	});

	test("still names a spent room link when the service refuses the ticket", async () => {
		load_room_document();
		history.replaceState(null, "", "/room?m=meeting-1");
		vi.stubGlobal(
			"fetch",
			// The real refusal, not a friendlier one. handle_session answers every refused ticket with
			// this one word, whether the ticket was spent, expired or never existed. A fixture that
			// invents a punctuated sentence the service cannot send certifies a sentence nobody sees.
			vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }))),
		);
		(window as CouncilWindow).__councilEntry = { ticket: "ticket-1" };
		new Function(council_room_client_js)();
		await vi.waitFor(() => expect(document.getElementById("view-error")!.hidden).toBe(false));

		// Keep this beside the test above. The service answered and refused the ticket, so the link
		// really is spent and the way out is a fresh one.
		const message = document.getElementById("error-message")!.textContent ?? "";
		expect(message).toContain("single-use");
		expect(message).toContain("Council page");
		// The service's word used to be glued onto the front of that sentence, and the host read
		// "Unauthorized Room links are single-use." A bare noun phrase is not a sentence, and it
		// names nothing the host can act on.
		expect(message).not.toContain("Unauthorized");
	});

	test("ignores an old admission response after a fresh ticket restores the lobby", async () => {
		const sdk = make_fake_sdk();
		let resolveJoin!: (response: Response) => void;
		const joinResponse = new Promise<Response>((resolve) => {
			resolveJoin = resolve;
		});
		const { init, fetchMock } = await boot_to_lobby(sdk, {
			fetchHandler: (path) => (path === "/room/api/join" ? joinResponse : undefined),
		});
		(document.getElementById("join-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(fetchMock.mock.calls.some(([path]) => path === "/room/api/join")).toBe(true);
		});

		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => {
			expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		});
		resolveJoin(new Response(JSON.stringify({ authToken: "old-provider-token" }), { status: 200 }));
		await Promise.resolve();
		await Promise.resolve();

		expect(init).not.toHaveBeenCalled();
		expect(document.getElementById("view-lobby")!.hidden).toBe(false);
		// The join that was cancelled left the button marked busy and reading "Joining…". Nothing
		// else puts it back, so the new lobby would open with a Join nobody can press.
		const joinButton = document.getElementById("join-button") as HTMLButtonElement;
		expect(joinButton.textContent).toBe("Join meeting");
		expect(joinButton.getAttribute("aria-busy")).toBe(null);
	});

	test("clears the lobby refusal when a fresh room link installs a new session", async () => {
		// routes-room.ts writes the host row with an empty display_name, so the lobby shows the name
		// field and the refusal below is the one every host meets on their first meeting.
		const firstSession = {
			...HOST_SESSION,
			participant: { ...HOST_SESSION.participant, displayName: "" },
		};
		const secondSession = {
			...firstSession,
			meeting: { ...firstSession.meeting, id: "m2", title: "Quarterly planning" },
		};
		const sdk = make_fake_sdk();
		let sessionCalls = 0;
		await boot_to_lobby(sdk, {
			session: firstSession,
			fetchHandler: (path) => {
				if (path !== "/room/api/session") return undefined;
				sessionCalls += 1;
				// The second call is a freshly minted room link for another meeting, pasted into this
				// same tab.
				return new Response(JSON.stringify(sessionCalls === 1 ? firstSession : secondSession), { status: 200 });
			},
		});
		const nameInput = document.getElementById("host-name") as HTMLInputElement;

		(document.getElementById("join-button") as HTMLButtonElement).click();
		expect(document.getElementById("lobby-error")!.textContent).toBe("Enter the name to show to other participants.");
		expect(nameInput.getAttribute("aria-invalid")).toBe("true");

		// Pasting the link is a hashchange, not a navigation, so nothing reloads the document.
		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => expect(document.getElementById("lobby-meeting")!.textContent).toBe("Quarterly planning"));

		// The new lobby used to open under a red role="alert" about the meeting the host had just
		// left, with the field still marked invalid and still described by that line. Someone using
		// a screen reader heard "invalid entry" and a message about a meeting they are no longer in.
		expect(document.getElementById("lobby-error")!.hidden).toBe(true);
		expect(document.getElementById("lobby-error")!.textContent).toBe("");
		expect(nameInput.getAttribute("aria-invalid")).toBe(null);
		expect(nameInput.getAttribute("aria-describedby")).toBe("host-name-hint");
	});

	test("leaves the call screen for the loading view while a pasted ticket is exchanged", async () => {
		const sdk = make_fake_sdk();
		let sessionCalls = 0;
		let releaseSession!: (response: Response) => void;
		const heldSession = new Promise<Response>((resolve) => {
			releaseSession = resolve;
		});
		await boot_to_call(sdk, {
			fetchHandler: (path) => {
				if (path !== "/room/api/session") return undefined;
				sessionCalls += 1;
				// The first call is this page's own boot ticket. The second is a freshly minted room
				// link pasted into the tab that is already in the call, and it is held open here.
				if (sessionCalls === 1) return new Response(JSON.stringify(HOST_SESSION), { status: 200 });
				return heldSession;
			},
		});
		expect(document.querySelectorAll(".participant-tile").length).toBeGreaterThan(0);

		window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#ticket=ticket-2`);
		window.dispatchEvent(new Event("hashchange"));
		await vi.waitFor(() => expect(sessionCalls).toBe(2));

		// Same path and query, so this is a hashchange and not a navigation. resetLiveCall ends the
		// call but changes no view, so the room kept the call screen up with no tiles, a frozen clock
		// and a "Connected" chip for the whole exchange, up to its thirty-second deadline.
		expect(document.getElementById("view-call")!.hidden).toBe(true);
		expect(document.getElementById("room-header")!.hidden).toBe(true);
		expect(document.getElementById("view-loading")!.hidden).toBe(false);
		expect(document.querySelectorAll(".participant-tile").length).toBe(0);

		releaseSession(new Response(JSON.stringify(HOST_SESSION), { status: 200 }));
		await vi.waitFor(() => expect(document.getElementById("view-lobby")!.hidden).toBe(false));
	});
});
