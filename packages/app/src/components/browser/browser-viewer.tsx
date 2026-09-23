import "./browser-viewer.css";

import { MyButton } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_browser_stream_connect,
	type files_browser_StreamControlMessage,
	type files_browser_StreamHandle,
	type files_browser_StreamHost,
	type files_browser_StreamInput,
	type files_browser_StreamNav,
	type files_browser_StreamWebMessage,
} from "@/lib/files-browser-stream.ts";
import { memo, useEffect, useRef, useState, type Ref } from "react";

// The runner accepts at most this many characters in one `text.insert`.
const BROWSER_VIEWER_PASTE_MAX_CHARS = 4000;

type BrowserViewer_ClassNames = "BrowserViewer" | "BrowserViewer-frame" | "BrowserViewer-status" | "BrowserViewer-hint";

export type BrowserViewer_Ref = {
	close: () => void;
	focus: () => void;
	/**
	 * Send one address bar action. Returns its sequence number, or -1 while the stream is not ready.
	 */
	sendNav: (nav: files_browser_StreamNav) => number;
	/**
	 * Close the page's file dialog without a file. Returns false while the stream is not ready.
	 */
	sendFileChooserCancel: (chooserId: string) => boolean;
};

export type BrowserViewer_Props = {
	ref?: Ref<BrowserViewer_Ref>;
	/**
	 * `web` forwards the edit shortcuts and paste to the page. `file` keeps them local.
	 */
	mode: "file" | "web";
	sessionId: app_convex_Id<"files_browser_sessions">;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	host: files_browser_StreamHost;
	inputEnabled: boolean;
	grant: () => Promise<{ grantId: string; viewerUrl: string } | null>;
	onViewerHello: (viewerId: string, viewport: { width: number; height: number }, control: string) => void;
	onControl: (control: files_browser_StreamControlMessage) => void;
	onConnection: (connected: boolean, detail: string | null) => void;
	onSessionEnded: (sessionId: app_convex_Id<"files_browser_sessions">) => void;
	/**
	 * Receives the web-only socket messages. A file session never gets them.
	 */
	onWebMessage: ((message: files_browser_StreamWebMessage) => void) | null;
};

type BrowserViewer_Status = "connecting" | "live" | "closed";

/**
 * Status text for each control state of the session. The file and web panels both show it.
 */
const BrowserViewer_CONTROL_LABELS: Record<string, string> = {
	starting: "Starting…",
	ready: "Live",
	agent: "Agent is using the browser",
	pausing: "Taking control…",
	human: "You have control",
	closing: "Closing…",
	closed: "Ended",
};

const BrowserViewer = Object.assign(
	memo(function BrowserViewer(props: BrowserViewer_Props) {
		const {
			ref: outerRef,
			mode,
			sessionId,
			ownerId,
			organizationId,
			workspaceId,
			host,
			inputEnabled,
			grant,
			onViewerHello,
			onControl,
			onConnection,
			onSessionEnded,
			onWebMessage,
		} = props;
		const frameRef = useRef<HTMLDivElement>(null);
		const imgRef = useRef<HTMLImageElement>(null);
		const streamRef = useRef<files_browser_StreamHandle | null>(null);
		const closedByClientRef = useRef(false);
		const objectUrlRef = useRef<string | null>(null);
		const viewportRef = useRef<{ width: number; height: number }>({ width: 1280, height: 800 });
		const lastMoveRef = useRef(0);
		const pressedButtonRef = useRef<{ button: "left" | "middle" | "right"; clickCount: number } | null>(null);
		const [status, setStatus] = useState<BrowserViewer_Status>("connecting");
		const [statusDetail, setStatusDetail] = useState<string | null>(null);
		const [attempt, setAttempt] = useState(0);

		function to_remote_point(clientX: number, clientY: number, clampToPage = false) {
			const frame = frameRef.current;
			if (!frame) {
				return null;
			}
			const rect = frame.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return null;
			}
			const viewport = viewportRef.current;
			// The image uses object-fit: contain. Its empty margins are not part of the remote page.
			const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
			const x = (clientX - rect.left - (rect.width - viewport.width * scale) / 2) / scale;
			const y = (clientY - rect.top - (rect.height - viewport.height * scale) / 2) / scale;
			if (!clampToPage && (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)) {
				return null;
			}
			return {
				x: Math.min(Math.max(Math.round(x), 0), viewport.width - 1),
				y: Math.min(Math.max(Math.round(y), 0), viewport.height - 1),
			};
		}

		const send = (input: files_browser_StreamInput) => {
			if (inputEnabled) {
				streamRef.current?.sendInput(input);
			}
		};

		const handleMouseMove = (event: React.MouseEvent) => {
			if (!inputEnabled) {
				return;
			}
			const now = Date.now();
			if (now - lastMoveRef.current < 33) {
				return;
			}
			lastMoveRef.current = now;
			const point = to_remote_point(event.clientX, event.clientY, pressedButtonRef.current !== null);
			if (point) {
				send({ kind: "mouse.move", ...point });
			}
		};

		const handleMouseDown = (event: React.MouseEvent) => {
			if (!inputEnabled || event.button > 2) return;
			const point = to_remote_point(event.clientX, event.clientY);
			if (!point) return;
			event.preventDefault();
			const button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
			const clickCount = Math.min(Math.max(event.detail, 1), 10);
			pressedButtonRef.current = { button, clickCount };
			send({ kind: "mouse.move", ...point });
			send({ kind: "mouse.down", button, clickCount });
			frameRef.current?.focus();
		};

		const handleMouseUp = (event: React.MouseEvent) => {
			const pressed = pressedButtonRef.current;
			if (!pressed) return;
			pressedButtonRef.current = null;
			const point = to_remote_point(event.clientX, event.clientY, true);
			if (point) send({ kind: "mouse.move", ...point });
			send({ kind: "mouse.up", ...pressed });
		};

		const handlePointerCancel = () => {
			const pressed = pressedButtonRef.current;
			pressedButtonRef.current = null;
			if (pressed) send({ kind: "mouse.up", ...pressed });
		};

		const handleKeyDown = (event: React.KeyboardEvent) => {
			if (!inputEnabled) {
				return;
			}
			// Escape releases the frame; every other key, Tab included, goes to the remote
			// page so keyboard users can operate it fully.
			if (event.key === "Escape") {
				frameRef.current?.blur();
				return;
			}
			if (event.ctrlKey || event.metaKey) {
				// Web mode sends select all, undo, and redo to the page, and macOS Cmd becomes Control
				// there. Copy and cut are not sent: the remote clipboard never reaches this computer.
				// Paste arrives through the paste event below.
				const key = event.key.toLowerCase();
				if (mode === "web" && (key === "a" || key === "z" || key === "y")) {
					event.preventDefault();
					send({ kind: "key.press", key: `Control+${key}` });
				}
				return;
			}
			event.preventDefault();
			if (event.key === "Tab") {
				send({ kind: "key.press", key: "Tab" });
			} else if (event.key.length === 1) {
				// Held keys repeat through here too: each OS repeat is one more typed char.
				send({ kind: "key.type", text: event.key });
			} else if (event.key.length > 1) {
				send({ kind: "key.down", key: event.key });
			}
		};

		const handleKeyUp = (event: React.KeyboardEvent) => {
			if (!inputEnabled) {
				return;
			}
			if (event.ctrlKey || event.metaKey || event.key.length <= 1 || event.key === "Tab") {
				return;
			}
			event.preventDefault();
			send({ kind: "key.up", key: event.key });
		};

		const handlePaste = (event: React.ClipboardEvent) => {
			if (!inputEnabled || mode !== "web") {
				return;
			}
			event.preventDefault();
			// Longer text is cut to the runner's limit instead of being refused as a whole.
			const text = event.clipboardData.getData("text/plain").slice(0, BROWSER_VIEWER_PASTE_MAX_CHARS);
			if (text.length > 0) {
				send({ kind: "text.insert", text });
			}
		};

		useEffect(() => {
			let cancelled = false;
			let retries = 0;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;

			const connect = () => {
				if (cancelled) {
					return;
				}
				closedByClientRef.current = false;
				setStatus("connecting");
				setStatusDetail(null);
				onConnection(false, null);
				(async (/* iife */) => {
					const granted = await grant();
					if (cancelled) {
						return;
					}
					if (!granted) {
						setStatus("closed");
						setStatusDetail("The viewer grant failed.");
						onConnection(false, "The viewer grant failed.");
						return;
					}
					const stream = files_browser_stream_connect({
						url: granted.viewerUrl,
						hello: {
							ownerId: ownerId,
							organizationId: organizationId,
							workspaceId: workspaceId,
							grantId: granted.grantId,
							host: host,
						},
						events: {
							onHello: (hello) => {
								if (cancelled) {
									return;
								}
								retries = 0;
								viewportRef.current = hello.viewport;
								setStatus("live");
								setStatusDetail(null);
								onControl({ control: hello.control, controlGen: hello.controlGen });
								onViewerHello(hello.viewerId, hello.viewport, hello.control);
								onConnection(true, null);
							},
							onFrame: (frame) => {
								if (cancelled) {
									return;
								}
								if (objectUrlRef.current) {
									URL.revokeObjectURL(objectUrlRef.current);
								}
								objectUrlRef.current = URL.createObjectURL(frame);
								if (imgRef.current) {
									imgRef.current.src = objectUrlRef.current;
								}
							},
							onControl: (control) => {
								if (!cancelled) {
									onControl(control);
								}
							},
							onViewport: (viewport) => {
								if (!cancelled) {
									viewportRef.current = viewport;
								}
							},
							onAck: () => {},
							onWebMessage: (message) => {
								if (!cancelled) {
									onWebMessage?.(message);
								}
							},
							onClose: (close) => {
								if (cancelled) {
									return;
								}
								streamRef.current = null;
								// An intentional close (renewal refused, panel hiding) never retries:
								// reconnecting would mint a fresh grant right after access failed.
								if (closedByClientRef.current) {
									return;
								}
								// The session is gone or this viewer moved to another window: stay
								// closed instead of minting grants against a dead target.
								if (close.code === 4404 || close.code === 4409) {
									const detail = close.code === 4404 ? "The session ended." : "The viewer moved.";
									setStatus("closed");
									setStatusDetail(detail);
									onConnection(false, detail);
									// Socket expiry stops renewal, so retire the matching app session too.
									if (close.code === 4404) onSessionEnded(sessionId);
									return;
								}
								if (retries >= 3) {
									const detail = close.reason || "The stream closed.";
									setStatus("closed");
									setStatusDetail(detail);
									onConnection(false, detail);
									return;
								}
								retries += 1;
								setStatus("connecting");
								onConnection(false, null);
								retryTimer = setTimeout(connect, 1000 * retries);
							},
						},
					});
					streamRef.current = stream;
				})().catch(() => {
					if (!cancelled) {
						setStatus("closed");
						setStatusDetail("The stream failed.");
						onConnection(false, "The stream failed.");
					}
				});
			};

			connect();
			return () => {
				cancelled = true;
				if (retryTimer !== undefined) {
					clearTimeout(retryTimer);
				}
				streamRef.current?.close();
				streamRef.current = null;
				if (objectUrlRef.current) {
					URL.revokeObjectURL(objectUrlRef.current);
					objectUrlRef.current = null;
				}
			};
			// The grant callback is stable per session; a new session id or tenant reconnects.
			// A manual retry re-runs the whole sequence after a terminal close.
		}, [sessionId, ownerId, organizationId, workspaceId, host, attempt]);

		useEffect(() => {
			const frame = frameRef.current;
			if (!frame) {
				return;
			}
			// React wheel listeners are passive: a native one is needed to keep page scroll local
			// while the viewer has human control.
			const handleWheel = (event: WheelEvent) => {
				if (!inputEnabled) {
					return;
				}
				event.preventDefault();
				const point = to_remote_point(event.clientX, event.clientY);
				if (point) {
					streamRef.current?.sendInput({ kind: "wheel", ...point, dx: event.deltaX, dy: event.deltaY });
				}
			};
			frame.addEventListener("wheel", handleWheel, { passive: false });
			return () => {
				frame.removeEventListener("wheel", handleWheel);
			};
		}, [inputEnabled]);

		useEffect(() => {
			const ref = outerRef;
			if (!ref) {
				return;
			}
			const handle: BrowserViewer_Ref = {
				close: () => {
					closedByClientRef.current = true;
					streamRef.current?.close();
					streamRef.current = null;
					setStatus("closed");
				},
				focus: () => {
					frameRef.current?.focus();
				},
				sendNav: (nav) => {
					return streamRef.current?.sendNav(nav) ?? -1;
				},
				sendFileChooserCancel: (chooserId) => {
					return streamRef.current?.sendFileChooserCancel(chooserId) ?? false;
				},
			};
			if (typeof ref === "function") {
				ref(handle);
				return () => {
					ref(null);
				};
			}
			ref.current = handle;
			return () => {
				ref.current = null;
			};
		}, [outerRef]);

		return (
			<div className={"BrowserViewer" satisfies BrowserViewer_ClassNames}>
				<div
					ref={frameRef}
					className={"BrowserViewer-frame" satisfies BrowserViewer_ClassNames}
					tabIndex={inputEnabled && status === "live" ? 0 : -1}
					role="application"
					aria-label={
						inputEnabled && status === "live"
							? "Shared browser page. Type and click to drive it; Tab goes to the page, Escape leaves it."
							: "Shared browser page, view only. Take control to interact."
					}
					onMouseMove={handleMouseMove}
					onMouseDown={handleMouseDown}
					onMouseUp={handleMouseUp}
					onPointerDown={(event) => {
						if (inputEnabled && to_remote_point(event.clientX, event.clientY)) {
							event.currentTarget.setPointerCapture(event.pointerId);
						}
					}}
					onPointerCancel={handlePointerCancel}
					onLostPointerCapture={handlePointerCancel}
					onContextMenu={(event) => {
						if (inputEnabled) event.preventDefault();
					}}
					onKeyDown={handleKeyDown}
					onKeyUp={handleKeyUp}
					onPaste={handlePaste}
				>
					<img ref={imgRef} alt="" draggable={false} />
				</div>
				{status !== "live" && (
					<div className={"BrowserViewer-status" satisfies BrowserViewer_ClassNames} role="status" aria-live="polite">
						{status === "connecting" ? <MySpinner size="16px" aria-label="Connecting" /> : null}
						<span>{status === "connecting" ? "Connecting…" : (statusDetail ?? "Closed.")}</span>
						{status === "closed" && (
							<MyButton variant="outline" onClick={() => setAttempt((count) => count + 1)}>
								Retry
							</MyButton>
						)}
					</div>
				)}
				{status === "live" && !inputEnabled && (
					<div className={"BrowserViewer-hint" satisfies BrowserViewer_ClassNames}>
						Watching. Take control to click and type.
					</div>
				)}
			</div>
		);
	}),
	{
		CONTROL_LABELS: BrowserViewer_CONTROL_LABELS,
	},
);

export { BrowserViewer };
