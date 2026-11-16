import { Result } from "common/errors-as-values-utils.ts";

/**
 * Region Capture (Chrome and Edge 104+, desktop). TypeScript's DOM types do not have it yet.
 */
declare global {
	var CropTarget: { fromElement(element: Element): Promise<object> } | undefined;
	var BrowserCaptureMediaStreamTrack: { prototype: object } | undefined;
	interface MediaStreamTrack {
		cropTo?(cropTarget: object | null): Promise<void>;
	}
}

/**
 * The long edge of the picture. The model sees at most this many pixels, which is enough to read app
 * text and costs about 1,650 tokens at OpenAI's "high" detail.
 */
const MAX_EDGE_PX = 1568;
const SMALL_EDGE_PX = 1024;

/**
 * How long to wait for the first frame after sharing starts. A visible tab sends one in well under a
 * second.
 */
const FRAME_WAIT_MS = 5_000;

/**
 * The call doc stores the picture as base64. Keep it far below the 1 MiB Convex document limit,
 * like the chat image attachments.
 */
const MAX_BASE64_CHARS = 700 * 1024;

/**
 * True when this browser can share only this tab. Firefox, Safari, and phones cannot crop a shared
 * tab to one element, so the agent must not ask them for a picture.
 *
 * `cropTo` lives on `BrowserCaptureMediaStreamTrack`, the track type a tab capture returns. Plain
 * `MediaStreamTrack` does not have it, also in Chrome and Edge.
 */
export function ai_chat_screen_capture_is_supported() {
	return (
		typeof globalThis.CropTarget !== "undefined" &&
		typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
		typeof globalThis.BrowserCaptureMediaStreamTrack !== "undefined" &&
		"cropTo" in globalThis.BrowserCaptureMediaStreamTrack.prototype
	);
}

function encode_jpeg(video: HTMLVideoElement, maxEdge: number, quality: number) {
	const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
	canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("No 2D canvas context");
	}
	context.drawImage(video, 0, 0, canvas.width, canvas.height);

	const base64 = canvas.toDataURL("image/jpeg", quality).slice("data:image/jpeg;base64,".length);
	return { base64, width: canvas.width, height: canvas.height };
}

/**
 * Take one picture of `target` from this tab, then stop sharing.
 *
 * Call it first in a click handler: `getDisplayMedia` works only while the click's user activation
 * lasts, so no network call may come before it. The browser asks the user what to share. If the user
 * picks another tab, a window, or the screen, `cropTo` refuses and nothing is sent. The stream stops
 * on every path, so sharing never stays on.
 */
export async function ai_chat_screen_capture_frame(target: Element) {
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getDisplayMedia({
			video: { displaySurface: "browser" },
			audio: false,
			// Chrome hints: offer this tab first, hide "share this tab instead", and hide whole screens.
			preferCurrentTab: true,
			selfBrowserSurface: "include",
			surfaceSwitching: "exclude",
			monitorTypeSurfaces: "exclude",
		} as DisplayMediaStreamOptions);
	} catch (error) {
		// The user closed the browser prompt, or the browser blocked it.
		if (error instanceof DOMException && error.name === "NotAllowedError") {
			return Result({ _nay: { name: "denied", message: "Screen sharing was not allowed" } });
		}
		return Result({ _nay: { name: "failed", message: "Failed to start screen sharing", cause: error } });
	}

	const video = document.createElement("video");
	try {
		const [track] = stream.getVideoTracks();
		const cropTarget = await globalThis.CropTarget?.fromElement(target);
		// `cropTo` refuses a track that is not this tab, so a picture of anything else is never taken.
		let cropped = false;
		if (track?.cropTo && cropTarget) {
			cropped = await track.cropTo(cropTarget).then(
				() => true,
				() => false,
			);
		}
		if (!cropped) {
			return Result({ _nay: { name: "wrong_surface", message: "Something other than this tab was shared" } });
		}

		video.muted = true;
		video.srcObject = stream;
		// The first frame after `play()` can be from before the crop. Wait for a new frame.
		//
		// A covered or minimized window can stop sending frames. Do not wait forever with sharing on.
		const gotFrame = await Promise.race([
			video.play().then(() => new Promise<boolean>((resolve) => video.requestVideoFrameCallback(() => resolve(true)))),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FRAME_WAIT_MS)),
		]);
		if (!gotFrame) {
			return Result({ _nay: { name: "failed", message: "No picture arrived from the shared tab" } });
		}

		// Try smaller pictures until one fits the call doc.
		for (const [maxEdge, quality] of [
			[MAX_EDGE_PX, 0.85],
			[MAX_EDGE_PX, 0.7],
			[SMALL_EDGE_PX, 0.7],
		] as const) {
			const picture = encode_jpeg(video, maxEdge, quality);
			if (picture.base64.length <= MAX_BASE64_CHARS) {
				return Result({ _yay: { mediaType: "image/jpeg" as const, ...picture } });
			}
		}
		return Result({ _nay: { name: "too_large", message: "The picture was too large" } });
	} catch (error) {
		return Result({ _nay: { name: "failed", message: "Failed to take the picture", cause: error } });
	} finally {
		for (const track of stream.getTracks()) {
			track.stop();
		}
		video.srcObject = null;
	}
}
