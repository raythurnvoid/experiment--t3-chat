import { afterEach, describe, expect, test, vi } from "vitest";

import { ai_chat_screen_capture_frame } from "./ai-chat-screen-capture.ts";

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
});
