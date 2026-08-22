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
	participants: { joined: FakeParticipantMap };
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
	meeting: { id: "m1", title: "Product design review", status: "open", deadlineAt: null },
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
			return new Response(JSON.stringify({ status: "open" }), { status: 200 });
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
		expect(submit.disabled).toBe(true);
		expect(submit.textContent).toBe("Checking invite…");
		await vi.advanceTimersByTimeAsync(30_000);

		expect(guestSignal?.aborted).toBe(true);
		expect(submit.disabled).toBe(false);
		expect(submit.textContent).toBe("Continue");
		expect(document.getElementById("guest-error")!.textContent).toContain("took too long");
	});
});

describe("council_room_client_js join operation", () => {
	test("shows progress immediately and leaves a failed SDK before retry", async () => {
		const sdk = make_fake_sdk();
		sdk.join = vi.fn(() => Promise.reject(new Error("provider token details")));
		await boot_to_lobby(sdk);

		const joinButton = document.getElementById("join-button") as HTMLButtonElement;
		joinButton.click();
		expect(joinButton.disabled).toBe(true);
		expect(joinButton.textContent).toBe("Joining…");
		expect(document.getElementById("lobby-progress")!.textContent).not.toBe("");

		await vi.waitFor(() => {
			expect(document.getElementById("lobby-error")!.textContent).toBe(
				"Could not enter the meeting. Check your connection, then try again.",
			);
		});
		expect(document.getElementById("lobby-error")!.textContent).not.toContain("provider token details");
		expect(sdk.leave).toHaveBeenCalled();
		expect(joinButton.disabled).toBe(false);
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

	test("keeps host-only controls hidden for a guest", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk, { session: GUEST_SESSION });

		expect(document.getElementById("start-recording-button")!.hidden).toBe(true);
		expect(document.getElementById("end-meeting-button")!.hidden).toBe(true);
	});

	test("keeps microphone guidance after the first room render", async () => {
		const sdk = make_fake_sdk();
		sdk.self.enableAudio = vi.fn(() => Promise.reject(new Error("denied")));
		await boot_to_call(sdk);

		expect(document.getElementById("call-status")!.textContent).toBe(
			"Microphone unavailable. Allow microphone access, then turn the microphone on.",
		);
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
		play.mockRejectedValueOnce(new Error("autoplay blocked")).mockResolvedValue(undefined);
		const sdk = make_fake_sdk();
		sdk.participants.joined.participants = [
			make_participant("peer-2", "guest-2", "Casey", {
				audioEnabled: true,
				audioTrack: make_track("audio", "remote-audio"),
			}),
		];
		await boot_to_call(sdk);
		await vi.waitFor(() => {
			expect(document.getElementById("play-audio-button")!.hidden).toBe(false);
		});

		(document.getElementById("play-audio-button") as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(document.getElementById("play-audio-button")!.hidden).toBe(true);
		});
		expect(play).toHaveBeenCalledTimes(2);
	});

	test("replaces a reconnect ghost by durable custom participant id and removes old listeners", async () => {
		const sdk = make_fake_sdk();
		const ghost = make_participant("old-peer", "guest-2", "Casey old");
		const replacement = make_participant("new-peer", "guest-2", "Casey new");
		sdk.participants.joined.participants = [ghost];
		await boot_to_call(sdk);

		sdk.self.emit("roomLeft", { state: "failed" });
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
		expect(pin.getAttribute("aria-label")).toBe("Unpin Casey");
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

		mic.click();
		expect(mic.disabled).toBe(true);
		await vi.waitFor(() => expect(mic.disabled).toBe(false));
		expect(sdk.self.disableAudio).toHaveBeenCalledOnce();
		expect(mic.getAttribute("aria-pressed")).toBe("false");

		camera.click();
		await vi.waitFor(() => expect(camera.disabled).toBe(false));
		expect(sdk.self.enableVideo).toHaveBeenCalledOnce();
		expect(camera.getAttribute("aria-pressed")).toBe("true");
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

	test("keeps focus in the end dialog while close is pending", async () => {
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
		confirm.click();

		expect(dialog.hidden).toBe(false);
		expect(confirm.disabled).toBe(true);
		expect(cancel.disabled).toBe(true);
		expect(confirm.textContent).toBe("Ending…");
		expect(document.activeElement).toBe(confirm);
		releaseClose();
		await vi.waitFor(() => expect(document.getElementById("view-ended")!.hidden).toBe(false));
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
		expect(document.activeElement).toBe(confirmButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		expect(document.activeElement).toBe(cancelButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		expect(document.activeElement).toBe(confirmButton);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(dialog.hidden).toBe(true);
		expect(document.activeElement).toBe(endButton);
	});

	test("keeps tiles during disconnect but ends for a terminal roomLeft state", async () => {
		const sdk = make_fake_sdk();
		await boot_to_call(sdk);
		const tile = document.querySelector(".participant-tile");

		sdk.self.emit("roomLeft", { state: "disconnected" });
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		expect(document.querySelector(".participant-tile")).toBe(tile);

		sdk.self.emit("roomLeft", { state: "ended" });
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
		expect(document.querySelector(".participant-tile")).toBeNull();
		expect(sdk.leave).toHaveBeenCalled();
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
				return new Response(JSON.stringify({ status: statePolls === 1 ? "recording_start_unknown" : "closed" }), {
					status: 200,
				});
			},
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(document.getElementById("view-call")!.hidden).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(document.getElementById("view-ended")!.hidden).toBe(false);
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
});

describe("council_room_client_js ticket replacement", () => {
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
	});
});
