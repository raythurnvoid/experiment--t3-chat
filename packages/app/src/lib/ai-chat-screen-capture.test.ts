import { afterEach, describe, expect, test, vi } from "vitest";

import { ai_chat_screen_capture_frame, ai_chat_screen_capture_is_supported } from "./ai-chat-screen-capture.ts";

describe("ai_chat_screen_capture_is_supported", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// The same shape as Chrome 155 and Edge 157: only the tab capture track type has `cropTo`.
	test("finds cropTo on the tab capture track type", () => {
		vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: () => {} } });
		vi.stubGlobal("CropTarget", { fromElement: async () => ({}) });
		vi.stubGlobal("MediaStreamTrack", class MediaStreamTrack {});
		vi.stubGlobal(
			"BrowserCaptureMediaStreamTrack",
			class BrowserCaptureMediaStreamTrack {
				cropTo() {}
			},
		);

		expect(ai_chat_screen_capture_is_supported()).toBe(true);
	});
});

describe("ai_chat_screen_capture_frame", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const fake_stream = (cropTo: () => Promise<void>) => {
		const track = { stop: vi.fn(), cropTo };
		const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
		vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } });
		vi.stubGlobal("CropTarget", { fromElement: async () => ({}) });
		// The test DOM accepts only a real MediaStream here.
		vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
		return track;
	};

	// If sharing stayed on, the browser would keep showing the share bar and keep the stream alive.
	test("stops sharing when the user shared another surface and when taking the picture fails", async () => {
		const otherSurface = fake_stream(() => Promise.reject(new Error("not a self-capture track")));
		const refused = await ai_chat_screen_capture_frame(document.body);
		expect(refused._nay?.name).toBe("wrong_surface");
		expect(otherSurface.stop, "sharing must stop when the crop is refused").toHaveBeenCalled();

		const broken = fake_stream(() => Promise.resolve());
		vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("play failed"));
		const failed = await ai_chat_screen_capture_frame(document.body);
		expect(failed._nay?.name).toBe("failed");
		expect(broken.stop, "sharing must stop when the picture fails").toHaveBeenCalled();
	});

	// A covered window can stop sending frames. Seen live in Chrome 155: sharing stayed on forever.
	test("stops sharing when no frame arrives", async () => {
		vi.useFakeTimers();
		const stalled = fake_stream(() => Promise.resolve());
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		// The test DOM has no `requestVideoFrameCallback`. Add one that never calls back, and remove it after.
		HTMLVideoElement.prototype.requestVideoFrameCallback = () => 0;

		const pending = ai_chat_screen_capture_frame(document.body);
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await pending;
		vi.useRealTimers();
		Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");

		expect(result._nay?.message).toBe("No picture arrived from the shared tab");
		expect(stalled.stop, "sharing must stop when no frame arrives").toHaveBeenCalled();
	});
});
