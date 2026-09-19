import "./files-browser.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectLabel,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { AiChatController } from "@/hooks/ai-chat-controller.tsx";
import { ai_chat_is_optimistic_thread_id } from "@/lib/ai-chat.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_pending_update_has_content } from "@/lib/files.ts";
import {
	files_browser_stream_connect,
	type files_browser_StreamControlMessage,
	type files_browser_StreamHandle,
	type files_browser_StreamHost,
	type files_browser_StreamInput,
} from "@/lib/files-browser-stream.ts";
import { cn } from "@/lib/utils.ts";
import { file_preview_MaxHtmlBytes } from "bonobo-file-preview/protocol";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Bot, Clock, Dock, Hand, Maximize2, Minimize2, MonitorPlay, PictureInPicture2, Play, RefreshCw, Square, X } from "lucide-react";
import { memo, useEffect, useRef, useState, type Ref } from "react";
import { toast } from "sonner";
import { create } from "zustand";

type FilesBrowser_Session = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_browser.current_browser_session>
>;

type files_browser_SourceKind = "saved" | "proposed" | "draft";

// #region navigation generations

type files_browser_Nav = {
	clientId: string;
	generation: number;
};

const files_browser_nav_store = ((/* iife */) => {
	let memory: { key: string; nav: files_browser_Nav } | null = null;

	function read(): { key: string; nav: files_browser_Nav } | null {
		if (memory) {
			return memory;
		}
		try {
			const raw = sessionStorage.getItem("files-browser-nav");
			if (!raw) {
				return null;
			}
			const parsed = JSON.parse(raw) as { key?: unknown; clientId?: unknown; generation?: unknown };
			if (
				typeof parsed.key !== "string" ||
				typeof parsed.clientId !== "string" ||
				typeof parsed.generation !== "number"
			) {
				return null;
			}
			memory = { key: parsed.key, nav: { clientId: parsed.clientId, generation: parsed.generation } };
			return memory;
		} catch {
			return memory;
		}
	}

	function write(key: string, nav: files_browser_Nav) {
		memory = { key, nav };
		try {
			sessionStorage.setItem("files-browser-nav", JSON.stringify({ key, ...nav }));
		} catch {
			// Private windows and test runtimes may refuse storage; the memory copy still works.
		}
	}

	/**
	 * The navigation identity for one selected file. A new key bumps the generation, so a start
	 * for file B never reattaches the session of file A. Survives reloads in the same tab.
	 */
	function for_node(key: string): files_browser_Nav {
		const stored = read();
		if (stored && stored.key === key) {
			return stored.nav;
		}
		const nav: files_browser_Nav = {
			clientId: stored?.nav.clientId ?? crypto.randomUUID(),
			generation: (stored?.nav.generation ?? 0) + 1,
		};
		write(key, nav);
		return nav;
	}

	return { for_node };
})();

// #endregion navigation generations

// #region resume thread bridge

/**
 * The Files agent sidebar's selected chat. Resume authorizes exactly this chat to continue on
 * the shared page; nothing is selected silently. Written by the mirror inside the sidebar's
 * chat provider, read by the browser panel.
 */
const useFilesBrowserResumeThreadStore = create<{ threadId: string | null }>(() => ({
	threadId: null,
}));

const FilesBrowserResumeThreadMirror = memo(function FilesBrowserResumeThreadMirror() {
	const controller = AiChatController.useThreadList({ includeArchived: false });
	const selectedThreadId = controller.selectedThreadId;

	useEffect(() => {
		useFilesBrowserResumeThreadStore.setState({ threadId: selectedThreadId });
	}, [selectedThreadId]);

	return null;
});

/**
 * Publishes the live browser session behind the Files selection for agent requests. Sends
 * freeze the published id into message metadata; leaving Files clears it so the full chat
 * page never binds. The effect is a deliberate bridge: the send-time reader lives outside
 * this tree and cannot subscribe to the query, and unmount must clear the published id.
 */
const FilesBrowserBindingWriter = memo(function FilesBrowserBindingWriter(props: {
	browserNodeId: string | null;
	browserNodeKind: "saved" | "private" | null;
}) {
	const { browserNodeId, browserNodeKind } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });

	useEffect(() => {
		const bound =
			browserNodeId &&
			browserNodeKind &&
			session &&
			session.nodeId === browserNodeId &&
			session.targetKind === browserNodeKind
				? session.sessionId
				: null;
		AiChatController.useStore.setState({ browserSessionId: bound });
		return () => {
			AiChatController.useStore.setState({ browserSessionId: null });
		};
	}, [browserNodeId, browserNodeKind, session]);

	return null;
});

// #endregion resume thread bridge

// #region draft capture

async function sha256_hex(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Capture the current editor text as draft bytes: reserve the capture, upload the bytes, and
 * bind the blob. The caller re-reads the editor revision after this and passes it to Start or
 * Reload, which refuses when an edit landed mid-capture.
 */
async function files_browser_capture_draft(
	convex: ReturnType<typeof useConvex>,
	args: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		nodeId: string;
		path: string;
		navGeneration: number;
		html: string;
		revision: number;
		basisKind: string;
		basisVersion: string;
	},
): Promise<{ captureId: app_convex_Id<"files_browser_draft_captures">; storageId: string } | { error: string }> {
	const byteSize = new TextEncoder().encode(args.html).byteLength;
	if (byteSize === 0 || byteSize > file_preview_MaxHtmlBytes) {
		return { error: "This draft does not fit the 900,000-byte browser limit." };
	}
	const hash = await sha256_hex(args.html);

	const reserved = await convex.mutation(app_convex_api.files_browser.capture_browser_draft, {
		membershipId: args.membershipId,
		nodeId: args.nodeId,
		path: args.path,
		revision: args.revision,
		basisKind: args.basisKind,
		basisVersion: args.basisVersion,
		navigationGeneration: args.navGeneration,
		byteSize,
		hash,
	});
	if (reserved._nay) {
		return { error: reserved._nay.message };
	}

	let storageId: unknown;
	try {
		const upload = await fetch(reserved._yay.uploadUrl, {
			method: "POST",
			headers: { "Content-Type": "text/html" },
			body: args.html,
		});
		if (!upload.ok) {
			return { error: "The draft upload failed. Try again." };
		}
		storageId = ((await upload.json()) as { storageId?: unknown } | null)?.storageId;
	} catch {
		return { error: "The draft upload failed. Try again." };
	}
	if (typeof storageId !== "string" || storageId.length === 0) {
		return { error: "The draft upload failed. Try again." };
	}

	const attached = await convex.mutation(app_convex_api.files_browser.attach_draft_capture_blob, {
		membershipId: args.membershipId,
		captureId: reserved._yay.captureId,
		storageId,
	});
	if (attached._nay) {
		return { error: attached._nay.message };
	}
	return { captureId: reserved._yay.captureId, storageId };
}

// #endregion draft capture

// #region viewer

type FilesBrowserViewer_ClassNames =
	| "FilesBrowserViewer"
	| "FilesBrowserViewer-frame"
	| "FilesBrowserViewer-status"
	| "FilesBrowserViewer-hint";

type FilesBrowserViewer_Ref = {
	close: () => void;
	focus: () => void;
};

type FilesBrowserViewer_Props = {
	ref?: Ref<FilesBrowserViewer_Ref>;
	sessionId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	host: files_browser_StreamHost;
	inputEnabled: boolean;
	grant: () => Promise<{ grantId: string; viewerUrl: string } | null>;
	onViewerHello: (viewerId: string, viewport: { width: number; height: number }, control: string) => void;
	onControl: (control: files_browser_StreamControlMessage) => void;
	onConnection: (connected: boolean, detail: string | null) => void;
};

type FilesBrowserViewer_Status = "connecting" | "live" | "closed";

const FilesBrowserViewer = memo(function FilesBrowserViewer(props: FilesBrowserViewer_Props) {
	const {
		ref: outerRef,
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
	} = props;
	const frameRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const streamRef = useRef<files_browser_StreamHandle | null>(null);
	const closedByClientRef = useRef(false);
	const objectUrlRef = useRef<string | null>(null);
	const viewportRef = useRef<{ width: number; height: number }>({ width: 1280, height: 800 });
	const lastMoveRef = useRef(0);
	const pressedButtonRef = useRef<{ button: "left" | "middle" | "right"; clickCount: number } | null>(null);
	const [status, setStatus] = useState<FilesBrowserViewer_Status>("connecting");
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
		const handle: FilesBrowserViewer_Ref = {
			close: () => {
				closedByClientRef.current = true;
				streamRef.current?.close();
				streamRef.current = null;
				setStatus("closed");
			},
			focus: () => {
				frameRef.current?.focus();
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
		<div className={"FilesBrowserViewer" satisfies FilesBrowserViewer_ClassNames}>
			<div
				ref={frameRef}
				className={"FilesBrowserViewer-frame" satisfies FilesBrowserViewer_ClassNames}
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
			>
				<img ref={imgRef} alt="" draggable={false} />
			</div>
			{status !== "live" && (
				<div
					className={"FilesBrowserViewer-status" satisfies FilesBrowserViewer_ClassNames}
					role="status"
					aria-live="polite"
				>
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
				<div className={"FilesBrowserViewer-hint" satisfies FilesBrowserViewer_ClassNames}>
					Watching. Take control to click and type.
				</div>
			)}
		</div>
	);
});

// #endregion viewer

// #region panel

function is_transfer_message(
	value: unknown,
): value is
	| { kind: "browser-takeover" | "browser-dock-request" | "browser-dock-ack"; sessionId: string }
	| { kind: "browser-thread"; sessionId: string; threadId: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		(record.kind === "browser-takeover" ||
			record.kind === "browser-dock-request" ||
			record.kind === "browser-dock-ack" ||
			(record.kind === "browser-thread" && (record.threadId === null || typeof record.threadId === "string"))) &&
		typeof record.sessionId === "string"
	);
}

type FilesBrowser_ClassNames =
	| "FilesBrowser"
	| "FilesBrowser-header"
	| "FilesBrowser-title"
	| "FilesBrowser-status"
	| "FilesBrowser-status-warn"
	| "FilesBrowser-actions"
	| "FilesBrowser-start"
	| "FilesBrowser-error"
	| "FilesBrowser-meta"
	| "FilesBrowser-results"
	| "FilesBrowser-results-title"
	| "FilesBrowser-results-list"
	| "FilesBrowser-results-item"
	| "FilesBrowser-results-item-selected"
	| "FilesBrowser-results-detail"
	| "FilesBrowser-results-text"
	| "FilesBrowser-results-images";

export type FilesBrowser_Props = {
	targetKind: "saved" | "private";
	nodeId: string;
	path: string;
	host: files_browser_StreamHost;
	editorRevision: number;
	serverSequence: number | null;
	getDraftText: (() => string | null) | null;
	getDraftRevision: (() => number) | null;
	focusActive: boolean;
	onToggleFocus: (() => void) | null;
	onHide: (() => void) | null;
};

const files_browser_VIEWPORT = { width: 1280, height: 800 };

type files_browser_StartOutcome = { ok: true; isDraft: boolean } | { ok: false; error: string };

/**
 * Start one session, capturing the editor draft first when needed. Module-level so the React
 * Compiler never sees its awaits; the caller applies the outcome to state.
 */
async function files_browser_start_session(args: {
	convex: ReturnType<typeof useConvex>;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	targetKind: "saved" | "private";
	nodeId: string;
	path: string;
	sourceKind: files_browser_SourceKind;
	nav: { clientId: string; generation: number };
	serverSequence: number | null;
	getDraftText: (() => string | null) | null;
	getDraftRevision: (() => number) | null;
}): Promise<files_browser_StartOutcome> {
	let draft: { captureId: app_convex_Id<"files_browser_draft_captures">; storageId: string } | null = null;
	let draftRevisionAfter: number | undefined;
	if (args.sourceKind === "draft") {
		const html = args.getDraftText?.() ?? null;
		const revision = args.getDraftRevision?.() ?? null;
		if (html === null || revision === null) {
			return { ok: false, error: "Open the editor draft first, then start again." };
		}
		const captured = await files_browser_capture_draft(args.convex, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			path: args.path,
			navGeneration: args.nav.generation,
			html,
			revision,
			basisKind: "saved",
			basisVersion: String(args.serverSequence ?? 0),
		});
		if ("error" in captured) {
			return { ok: false, error: captured.error };
		}
		draft = captured;
		draftRevisionAfter = args.getDraftRevision?.() ?? revision;
	}

	const started = await args.convex.action(app_convex_api.files_browser.start_browser, {
		membershipId: args.membershipId,
		targetKind: args.targetKind,
		nodeId: args.nodeId,
		path: args.path,
		sourceKind: args.sourceKind,
		navigationGeneration: args.nav.generation,
		navigationClientId: args.nav.clientId,
		viewport: files_browser_VIEWPORT,
		...(draft
			? {
					draftCaptureId: draft.captureId,
					draftStorageId: draft.storageId,
					draftRevisionAfter,
				}
			: {}),
	});
	if (started._nay) {
		return { ok: false, error: started._nay.message };
	}
	return { ok: true, isDraft: args.sourceKind === "draft" };
}

const files_browser_CONTROL_LABELS: Record<string, string> = {
	starting: "Starting…",
	ready: "Live",
	agent: "Agent is using the browser",
	pausing: "Taking control…",
	human: "You have control",
	closing: "Closing…",
	closed: "Ended",
};

function files_browser_source_label(sourceKind: string) {
	return sourceKind === "saved" ? "Saved" : sourceKind === "proposed" ? "Proposed" : "Draft";
}

function format_remaining_time(session: FilesBrowser_Session, now: number) {
	const ends = [session.idleUntil, session.totalUntil].filter(
		(value): value is number => typeof value === "number",
	);
	if (ends.length === 0) {
		return null;
	}
	const ms = Math.min(...ends) - now;
	if (ms <= 0) {
		return "Time expired";
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return minutes > 0 ? `${minutes} min left` : `${seconds} s left`;
}

const FilesBrowser = memo(function FilesBrowser(props: FilesBrowser_Props) {
	const {
		targetKind,
		nodeId,
		path,
		host,
		editorRevision,
		serverSequence,
		getDraftText,
		getDraftRevision,
		focusActive,
		onToggleFocus,
		onHide,
	} = props;
	const { membershipId, organizationId, organizationName, workspaceId, workspaceName } =
		AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const convex = useConvex();
	const viewerRef = useRef<FilesBrowserViewer_Ref | null>(null);

	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });
	const mine =
		session && session.nodeId === nodeId && (session.targetKind === targetKind) ? session : null;
	const sessionId = mine?.sessionId;
	const selectedThreadId = useFilesBrowserResumeThreadStore((store) => store.threadId);
	const [openerThreadId, setOpenerThreadId] = useState<string | null>(null);
	const resumeThreadId = host === "detached" ? openerThreadId : selectedThreadId;
	const pendingUpdate = useQuery(app_convex_api.files_pending_updates.get_file_pending_update, {
		membershipId,
		target:
			targetKind === "saved"
				? { kind: "saved", id: nodeId as app_convex_Id<"files_nodes"> }
				: { kind: "private", id: nodeId as app_convex_Id<"files_pending_nodes"> },
	});
	const hasProposal = !!pendingUpdate && files_pending_update_has_content(pendingUpdate);
	const results = useQuery(
		app_convex_api.files_browser.list_browser_results,
		resumeThreadId && !ai_chat_is_optimistic_thread_id(resumeThreadId)
			? { membershipId, threadId: resumeThreadId as app_convex_Id<"ai_chat_threads"> }
			: "skip",
	);

	const [source, setSource] = useState<files_browser_SourceKind>(
		targetKind === "private" ? "proposed" : "saved",
	);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [viewerId, setViewerId] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
	const [remoteControl, setRemoteControl] = useState<files_browser_StreamControlMessage | null>(null);
	const [taking, setTaking] = useState(false);
	const [loadedDraftRevision, setLoadedDraftRevision] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [poppedOut, setPoppedOut] = useState(false);
	const [pendingDockAck, setPendingDockAck] = useState(false);
	const [takeoverSent, setTakeoverSent] = useState(false);
	const [docking, setDocking] = useState(false);
	const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
	const [selectedResult, setSelectedResult] = useState<{
		text: string;
		images: Array<{ url: string; mime: string; width: number; height: number }>;
	} | null>(null);
	const childRef = useRef<Window | null>(null);
	const isChild = host === "detached";

	const navKey = `${targetKind}:${nodeId}`;
	// Once per mount: the file view remounts per file, so the initializer runs once per navigation.
	const [nav] = useState(() => files_browser_nav_store.for_node(navKey));

	useEffect(() => {
		setViewerId(null);
		setRemoteControl(null);
		setTaking(false);
		setPendingDockAck(false);
		setTakeoverSent(false);
		setDocking(false);
	}, [mine?.sessionId]);

	useEffect(() => {
		if (remoteControl?.control === "human") {
			setTaking(false);
		}
	}, [remoteControl]);

	useEffect(() => {
		if (!taking) {
			return;
		}
		const timer = setTimeout(() => setTaking(false), 35_000);
		return () => clearTimeout(timer);
	}, [taking]);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	// Query and socket updates arrive separately. Finishing a handoff keeps its generation.
	const control = mine && (
		!remoteControl ||
		mine.controlGen > remoteControl.controlGen ||
		(mine.controlGen === remoteControl.controlGen && mine.control === "human" && remoteControl.control === "pausing")
	) ? mine.control : remoteControl?.control ?? null;

	// Renew the viewer grant on a timer. A refusal closes the stream at once instead of waiting
	// for the runner's grant deadline. A popped-out panel holds no viewer, so it renews nothing.
	// Session updates must not restart the timer and let the current grant expire.
	useEffect(() => {
		if (!sessionId || !viewerId || !connected || poppedOut) {
			return;
		}
		const timer = setInterval(() => {
			convex
				.action(app_convex_api.files_browser.renew_browser_viewer, {
					membershipId,
					sessionId,
					viewerId,
				})
				.then((result) => {
					if (result._nay) {
						viewerRef.current?.close();
						setConnected(false);
						setConnectionDetail("Access changed. The viewer closed.");
					}
				})
				.catch((error: unknown) => {
					console.error("[FilesBrowser.renew] Unexpected renew error", { error });
				});
		}, 20_000);
		return () => clearInterval(timer);
	}, [convex, membershipId, sessionId, viewerId, connected, poppedOut]);

	// Popout transfer between the docked panel and its child window. The child attaches first,
	// moves input to itself when a human holds it, and only then tells the docked panel to stand
	// down — a failed child never takes the live viewer away. Docking reverses the dance.
	useEffect(() => {
		if (isChild || !mine) {
			return;
		}
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || !is_transfer_message(event.data)) {
				return;
			}
			if (event.data.sessionId !== mine.sessionId) {
				return;
			}
			// Only the opened popout may move this viewer. Any same-origin tab can post a
			// message, but only the child window holds this session's live viewer.
			if (event.source !== childRef.current) {
				return;
			}
			if (event.data.kind === "browser-takeover") {
				childRef.current?.postMessage(
					{ kind: "browser-thread", sessionId: mine.sessionId, threadId: selectedThreadId },
					window.location.origin,
				);
				setPoppedOut(true);
			} else if (event.data.kind === "browser-dock-request") {
				setPoppedOut(false);
				setPendingDockAck(true);
			}
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
		};
	}, [isChild, mine, selectedThreadId]);

	useEffect(() => {
		if (isChild || !mine || !poppedOut) return;
		childRef.current?.postMessage(
			{ kind: "browser-thread", sessionId: mine.sessionId, threadId: selectedThreadId },
			window.location.origin,
		);
	}, [isChild, mine, poppedOut, selectedThreadId]);

	useEffect(() => {
		if (!isChild) {
			return;
		}
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || !is_transfer_message(event.data)) {
				return;
			}
			if (event.source !== window.opener) {
				return;
			}
			if (event.data.sessionId !== mine?.sessionId) return;
			if (event.data.kind === "browser-thread") {
				setOpenerThreadId(event.data.threadId);
			} else if (event.data.kind === "browser-dock-ack") {
				window.close();
			}
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
		};
	}, [isChild, mine?.sessionId]);

	// A manually closed popout reattaches here instead of stranding the session viewerless.
	useEffect(() => {
		if (isChild || !poppedOut) {
			return;
		}
		const timer = setInterval(() => {
			const child = childRef.current;
			if (child && child.closed) {
				childRef.current = null;
				setPoppedOut(false);
				toast.info("The popout closed. The viewer reattached here.");
			}
		}, 2000);
		return () => clearInterval(timer);
	}, [isChild, poppedOut]);

	useEffect(() => {
		if (!docking) {
			return;
		}
		const timer = setTimeout(() => {
			setDocking(false);
			toast.error("Docking timed out. The popout stays live.");
		}, 10_000);
		return () => clearTimeout(timer);
	}, [docking]);

	const currentVersion = useQuery(
		app_convex_api.files_browser.browser_source_current_version,
		mine && mine.sourceKind !== "draft"
			? { membershipId, nodeId: nodeId, path: path, sourceKind: mine.sourceKind }
			: "skip",
	);
	const updatesAvailable =
		mine && mine.control !== "starting" && mine.control !== "closing" && mine.control !== "closed"
			? mine.sourceKind === "draft"
				? loadedDraftRevision !== null && editorRevision !== loadedDraftRevision
				: currentVersion !== undefined &&
					currentVersion !== null &&
					currentVersion.version !== mine.sourceVersion
			: false;

	const handleGrant = useFn(async (): Promise<{ grantId: string; viewerUrl: string } | null> => {
		if (!mine) {
			return null;
		}
		const granted = await convex.action(app_convex_api.files_browser.grant_browser_viewer, {
			membershipId,
			sessionId: mine.sessionId,
		});
		if (granted._nay) {
			toast.error(granted._nay.message);
			return null;
		}
		return { grantId: granted._yay.grantId, viewerUrl: granted._yay.viewerUrl };
	});

	const handleStart = useFn(() => {
		setStarting(true);
		setError(null);
		files_browser_start_session({
			convex,
			membershipId,
			targetKind,
			nodeId,
			path,
			sourceKind: source,
			nav,
			serverSequence,
			getDraftText,
			getDraftRevision,
		})
			.then((outcome) => {
				if (!outcome.ok) {
					setError(outcome.error);
					return;
				}
				if (outcome.isDraft) {
					setLoadedDraftRevision(editorRevision);
				}
			})
			.catch((error: unknown) => {
				setError("Starting failed. Try again.");
				console.error("[FilesBrowser.handleStart] Unexpected start error", { error });
			})
			.finally(() => {
				setStarting(false);
			});
	});

	const takeWithViewer = useFn((id: string): Promise<boolean> => {
		if (!mine) {
			return Promise.resolve(false);
		}
		return convex
			.action(app_convex_api.files_browser.take_browser_control, {
				membershipId,
				sessionId: mine.sessionId,
				viewerId: id,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return false;
				}
				return result._yay.control === "human" || result._yay.control === "pausing";
			})
			.catch((error: unknown) => {
				console.error("[FilesBrowser.take] Unexpected take error", { error });
				return false;
			});
	});

	const handleTake = useFn(() => {
		if (!viewerId || !connected) {
			return;
		}
		setTaking(true);
		takeWithViewer(viewerId).then((moved: boolean) => {
			if (!moved) {
				setTaking(false);
			}
		});
	});

	const handleResume = useFn(() => {
		if (!mine || !resumeThreadId || ai_chat_is_optimistic_thread_id(resumeThreadId)) {
			return;
		}
		convex
			.action(app_convex_api.files_browser.resume_browser_agent, {
				membershipId,
				sessionId: mine.sessionId,
				threadId: resumeThreadId as app_convex_Id<"ai_chat_threads">,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesBrowser.resume] Unexpected resume error", { error });
			});
	});

	const handleReload = useFn(async () => {
		if (!mine) {
			return;
		}
		let draft: { captureId: app_convex_Id<"files_browser_draft_captures">; storageId: string } | null = null;
		let draftRevisionAfter: number | undefined;
		if (mine.sourceKind === "draft") {
			const html = getDraftText?.() ?? null;
			const revision = getDraftRevision?.() ?? null;
			if (html === null || revision === null) {
				toast.error("Open the editor draft first, then reload again.");
				return;
			}
			const captured = await files_browser_capture_draft(convex, {
				membershipId,
				nodeId: nodeId,
				path: path,
				navGeneration: nav.generation,
				html,
				revision,
				basisKind: "saved",
				basisVersion: String(serverSequence ?? 0),
			});
			if ("error" in captured) {
				toast.error(captured.error);
				return;
			}
			draft = captured;
			draftRevisionAfter = getDraftRevision?.() ?? revision;
		}
		const reloaded = await convex.action(app_convex_api.files_browser.reload_browser, {
			membershipId,
			sessionId: mine.sessionId,
			path: path,
			...(draft
				? {
						draftCaptureId: draft.captureId,
						draftStorageId: draft.storageId,
						draftRevisionAfter,
					}
				: {}),
		});
		if (reloaded._nay) {
			toast.error(reloaded._nay.message);
			return;
		}
		if (mine.sourceKind === "draft") {
			setLoadedDraftRevision(editorRevision);
		}
	});

	const handleKeepOpen = useFn(() => {
		if (!mine) {
			return;
		}
		convex
			.action(app_convex_api.files_browser.keep_open_browser, { membershipId, sessionId: mine.sessionId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesBrowser.keepOpen] Unexpected keep-open error", { error });
			});
	});

	const handleEnd = useFn(() => {
		if (!mine) {
			return;
		}
		convex
			.action(app_convex_api.files_browser.end_browser, { membershipId, sessionId: mine.sessionId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesBrowser.end] Unexpected end error", { error });
			});
	});

	const handleViewerHello = useFn((id: string, viewport: { width: number; height: number }, control: string) => {
		setViewerId(id);
		// The child moves human input here before the docked viewer stops streaming.
		if (isChild) {
			if (takeoverSent || !mine) {
				return;
			}
			setTakeoverSent(true);
			const postTakeover = () => {
				window.opener?.postMessage(
					{ kind: "browser-takeover", sessionId: mine.sessionId },
					window.location.origin,
				);
			};
			if (control === "human") {
				takeWithViewer(id).then((moved: boolean) => {
					if (moved) {
						postTakeover();
					} else {
						// Stay live here: the docked viewer keeps streaming, so a failed move
						// loses nothing and the user can close this window to retry.
						setTakeoverSent(false);
					}
				});
			} else {
				postTakeover();
			}
			return;
		}
		// Move input back here before the child closes; its detach would otherwise release control.
		if (pendingDockAck && mine) {
			setPendingDockAck(false);
			const sessionId = mine.sessionId;
			const ack = () => {
				childRef.current?.postMessage({ kind: "browser-dock-ack", sessionId }, window.location.origin);
			};
			if (control === "human") {
				takeWithViewer(id).then((moved: boolean) => {
					// On a failed move the child stays live; Dock retries the dance.
					if (moved) {
						ack();
					}
				});
			} else {
				ack();
			}
		}
	});

	const handleViewerControl = useFn((next: files_browser_StreamControlMessage) => {
		setRemoteControl(next);
	});

	const handleConnection = useFn((isConnected: boolean, detail: string | null) => {
		setConnected(isConnected);
		setConnectionDetail(detail);
	});

	const handleSourceChange = useFn((value: string) => {
		if (value === "saved" || value === "proposed" || value === "draft") {
			setSource(value);
		}
	});

	const handlePopOut = useFn(() => {
		if (!mine || isChild) {
			return;
		}
		// The window name dedupes: popping out twice focuses the same child.
		const child = window.open(
			`${window.location.origin}/w/${encodeURIComponent(organizationName)}/${encodeURIComponent(workspaceName)}/files/browser?session=${mine.sessionId}`,
			`files-browser-${mine.sessionId}`,
			"popup,width=1280,height=900",
		);
		if (!child) {
			toast.error("The popout was blocked. Allow popups for this site.");
			return;
		}
		childRef.current = child;
		child.focus();
	});

	const handleFocusPopout = useFn(() => {
		childRef.current?.focus();
	});

	const handleDock = useFn(() => {
		if (!mine || !isChild) {
			return;
		}
		if (!window.opener || window.opener.closed) {
			toast.error("The Files window is gone. Close this popout instead.");
			return;
		}
		setDocking(true);
		window.opener.postMessage(
			{ kind: "browser-dock-request", sessionId: mine.sessionId },
			window.location.origin,
		);
	});

	const handleFocusToggle = useFn(() => {
		onToggleFocus?.();
		// Entering focus moves keyboard input into the page; exiting returns it to the editor.
		if (!focusActive) {
			viewerRef.current?.focus();
		}
	});

	const deadline = mine ? format_remaining_time(mine, now) : null;
	const sourceMeta = mine ? `${files_browser_source_label(mine.sourceKind)} · ${mine.sourceHash.slice(0, 8)}` : null;

	useEffect(() => {
		setSelectedResultId(null);
		setSelectedResult(null);
	}, [resumeThreadId]);

	useEffect(() => {
		if (!selectedResultId) {
			setSelectedResult(null);
			return;
		}
		let cancelled = false;
		convex
			.action(app_convex_api.files_browser.read_browser_result, {
				membershipId,
				resultId: selectedResultId as app_convex_Id<"ai_chat_browser_results">,
			})
			.then((read) => {
				if (cancelled) {
					return;
				}
				if (read._nay) {
					toast.error(read._nay.message);
					setSelectedResult(null);
					return;
				}
				setSelectedResult({ text: read._yay.text, images: read._yay.images });
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					console.error("[FilesBrowser.result] Unexpected read error", { error });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [convex, membershipId, selectedResultId]);

	return (
		<div className={"FilesBrowser" satisfies FilesBrowser_ClassNames} role="region" aria-label="Shared browser">
			<div className={"FilesBrowser-header" satisfies FilesBrowser_ClassNames}>
				<span className={"FilesBrowser-title" satisfies FilesBrowser_ClassNames}>
					<MonitorPlay size={16} aria-hidden />
					Shared browser
				</span>
				{mine && control && (
					<span className={"FilesBrowser-status" satisfies FilesBrowser_ClassNames} role="status">
						{files_browser_CONTROL_LABELS[control] ?? control}
					</span>
				)}
				<div className={"FilesBrowser-actions" satisfies FilesBrowser_ClassNames}>
					{mine && (
						<>
							{(control === "ready" || control === "agent") && (
								<MyButton
									variant="outline"
									disabled={!viewerId || !connected || taking}
									tooltip={
										taking ? "Taking control…" : !viewerId || !connected ? "Take control (connecting…)" : "Take control"
									}
									onClick={handleTake}
								>
									<MyButtonIcon>
										<Hand aria-hidden />
									</MyButtonIcon>
									{taking ? "Taking…" : "Take control"}
								</MyButton>
							)}
							{control === "human" && (
								<MyButton
									variant="outline"
									disabled={!resumeThreadId || ai_chat_is_optimistic_thread_id(resumeThreadId)}
									tooltip={
										resumeThreadId && !ai_chat_is_optimistic_thread_id(resumeThreadId)
											? "Resume agent"
											: "Resume agent (select a chat first)"
									}
									onClick={handleResume}
								>
									<MyButtonIcon>
										<Bot aria-hidden />
									</MyButtonIcon>
									Resume agent
								</MyButton>
							)}
							<MyIconButton variant="ghost-highlightable" tooltip="Reload from current source" onClick={handleReload}>
								<MyIconButtonIcon>
									<RefreshCw size={16} />
								</MyIconButtonIcon>
							</MyIconButton>
							<MyIconButton variant="ghost-highlightable" tooltip="Keep open for 5 more minutes" onClick={handleKeepOpen}>
								<MyIconButtonIcon>
									<Clock size={16} />
								</MyIconButtonIcon>
							</MyIconButton>
							<MyIconButton variant="ghost_destructive" tooltip="End browser" onClick={handleEnd}>
								<MyIconButtonIcon>
									<Square size={16} />
								</MyIconButtonIcon>
							</MyIconButton>
							{!isChild && !poppedOut && (
								<MyIconButton variant="ghost-highlightable" tooltip="Pop out" onClick={handlePopOut}>
									<MyIconButtonIcon>
										<PictureInPicture2 size={16} />
									</MyIconButtonIcon>
								</MyIconButton>
							)}
							{isChild && (
								<MyIconButton
									variant="ghost-highlightable"
									tooltip="Dock in Files"
									disabled={docking}
									onClick={handleDock}
								>
									<MyIconButtonIcon>
										<Dock size={16} />
									</MyIconButtonIcon>
								</MyIconButton>
							)}
						</>
					)}
					{onHide && (
						<MyIconButton variant="ghost-highlightable" tooltip="Hide browser" onClick={onHide}>
							<MyIconButtonIcon>
								<X size={16} />
							</MyIconButtonIcon>
						</MyIconButton>
					)}
					{onToggleFocus && (
						<MyIconButton
							variant="ghost-highlightable"
							tooltip={focusActive ? "Exit focus" : "Focus browser"}
							aria-pressed={focusActive}
							onClick={handleFocusToggle}
						>
							<MyIconButtonIcon>
								{focusActive ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
							</MyIconButtonIcon>
						</MyIconButton>
					)}
				</div>
			</div>

			{mine ? (
				<>
					<div className={"FilesBrowser-meta" satisfies FilesBrowser_ClassNames}>
						<span>{sourceMeta}</span>
						{updatesAvailable && (
							<span className={"FilesBrowser-status-warn" satisfies FilesBrowser_ClassNames}>
								Updates available
							</span>
						)}
						{deadline && <span>{deadline}</span>}
						{!connected && connectionDetail && (
							<span role="status">{connectionDetail}</span>
						)}
					</div>
					{mine.control === "starting" || mine.control === "closing" ? (
						<div className={"FilesBrowser-start" satisfies FilesBrowser_ClassNames}>
							<MySpinner size="16px" aria-label={mine.control === "starting" ? "Starting" : "Closing"} />
							<span>{mine.control === "starting" ? "Starting the cloud page…" : "Closing…"}</span>
						</div>
					) : poppedOut ? (
						<div className={"FilesBrowser-start" satisfies FilesBrowser_ClassNames}>
							<span>Viewing in a popout window.</span>
							<MyButton variant="outline" onClick={handleFocusPopout}>
								Focus popout
							</MyButton>
						</div>
					) : (
						<FilesBrowserViewer
							ref={viewerRef}
							key={mine.sessionId}
							sessionId={mine.sessionId}
							ownerId={userId}
							organizationId={organizationId}
							workspaceId={workspaceId}
							host={host}
							inputEnabled={control === "human" && connected}
							grant={handleGrant}
							onViewerHello={handleViewerHello}
							onControl={handleViewerControl}
							onConnection={handleConnection}
						/>
					)}
				</>
			) : (
				<div className={"FilesBrowser-start" satisfies FilesBrowser_ClassNames}>
					{targetKind === "saved" && (
						<MySelect value={source} setValue={handleSourceChange}>
							<MySelectLabel>Source</MySelectLabel>
							<MySelectTrigger>
								<MyButton variant="outline">
									{files_browser_source_label(source)}
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							<MySelectPopover>
								<MySelectPopoverScrollableArea>
									<MySelectPopoverContent>
										<MySelectItem value="saved">Saved content</MySelectItem>
										{getDraftText && <MySelectItem value="draft">Editor draft</MySelectItem>}
										{hasProposal && <MySelectItem value="proposed">Proposed changes</MySelectItem>}
									</MySelectPopoverContent>
								</MySelectPopoverScrollableArea>
							</MySelectPopover>
						</MySelect>
					)}
					<MyButton variant="default" disabled={starting} onClick={handleStart} aria-busy={starting}>
						<MyButtonIcon>
							<Play aria-hidden />
						</MyButtonIcon>
						{starting ? "Starting…" : "Start shared browser"}
					</MyButton>
					{error && (
						<span className={"FilesBrowser-error" satisfies FilesBrowser_ClassNames} role="alert">
							{error}
						</span>
					)}
				</div>
			)}
			{results !== undefined && results.length > 0 && (
				<div className={"FilesBrowser-results" satisfies FilesBrowser_ClassNames}>
					<span className={"FilesBrowser-results-title" satisfies FilesBrowser_ClassNames}>
						Results
					</span>
					<div
						className={"FilesBrowser-results-list" satisfies FilesBrowser_ClassNames}
						role="group"
						aria-label="Browser results"
					>
						{results.map((entry) => (
							<button
								key={entry.resultId}
								type="button"
								className={cn(
									"FilesBrowser-results-item" satisfies FilesBrowser_ClassNames,
									entry.resultId === selectedResultId &&
										("FilesBrowser-results-item-selected" satisfies FilesBrowser_ClassNames),
								)}
								aria-expanded={entry.resultId === selectedResultId}
								onClick={() =>
									setSelectedResultId((current) => (current === entry.resultId ? null : entry.resultId))
								}
							>
								{new Date(entry.createdAt).toLocaleTimeString()} ·{" "}
								{files_browser_source_label(entry.sourceKind)} · {entry.imageCount} img
							</button>
						))}
					</div>
					{selectedResult && (
						<div className={"FilesBrowser-results-detail" satisfies FilesBrowser_ClassNames}>
							<pre className={"FilesBrowser-results-text" satisfies FilesBrowser_ClassNames}>
								{selectedResult.text}
							</pre>
							{selectedResult.images.length > 0 && (
								<div className={"FilesBrowser-results-images" satisfies FilesBrowser_ClassNames}>
									{selectedResult.images.map((image, index) => (
										<img
											key={image.url}
											src={image.url}
											alt={`Browser capture ${index + 1} of ${selectedResult.images.length}`}
											width={image.width}
											height={image.height}
											loading="lazy"
										/>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export { FilesBrowser, FilesBrowserBindingWriter, FilesBrowserResumeThreadMirror };

// #endregion panel
