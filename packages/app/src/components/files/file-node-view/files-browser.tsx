import "./files-browser.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { BrowserViewer, type BrowserViewer_Ref } from "@/components/browser/browser-viewer.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
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
import type { files_browser_StreamControlMessage, files_browser_StreamHost } from "@/lib/files-browser-stream.ts";
import { file_preview_MaxHtmlBytes } from "bonobo-file-preview/protocol";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Bot, Clock, Dock, Hand, MonitorPlay, PictureInPicture2, Play, RefreshCw, Square } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";

type FilesBrowser_Session = Extract<
	NonNullable<FunctionReturnType<typeof app_convex_api.files_browser.current_browser_session>>,
	{ mode: "file" }
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
 * The agent panel's selected chat. Resume authorizes exactly this chat to continue on the
 * shared page; nothing is selected silently. Written by the mirror inside the agent panel's
 * chat provider, read by the Files and web browser panels.
 */
const useFilesBrowserResumeThreadStore = create<{ threadId: string | null }>(() => ({
	threadId: null,
}));

const FilesBrowserResumeThreadMirror = Object.assign(
	memo(function FilesBrowserResumeThreadMirror() {
		const controller = AiChatController.useThreadList({ includeArchived: false });
		const selectedThreadId = controller.selectedThreadId;

		useEffect(() => {
			useFilesBrowserResumeThreadStore.setState({ threadId: selectedThreadId });
		}, [selectedThreadId]);

		return null;
	}),
	{
		/**
		 * Read the agent panel's selected chat from outside its chat provider.
		 */
		useThreadId: function useThreadId() {
			return useFilesBrowserResumeThreadStore((store) => store.threadId);
		},
	},
);

export type FilesBrowserBindingWriter_Props = {
	/**
	 * The browser that agent requests from this panel may use. `file` binds the live file browser
	 * of that exact node (the target kind stops a saved/private id clash). `web` binds the live web browser.
	 */
	browserBinding: { mode: "file"; nodeId: string; targetKind: "saved" | "private" } | { mode: "web" } | null;
};

/**
 * Publishes the live browser session behind the panel's binding for agent requests. Sends
 * freeze the published id into message metadata; leaving the panel clears it so the full chat
 * page never binds. The effect is a deliberate bridge: the send-time reader lives outside
 * this tree and cannot subscribe to the query, and unmount must clear the published id.
 */
const FilesBrowserBindingWriter = memo(function FilesBrowserBindingWriter(props: FilesBrowserBindingWriter_Props) {
	const { browserBinding } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });

	const bound =
		session &&
		((browserBinding?.mode === "web" && session.mode === "web") ||
			(browserBinding?.mode === "file" &&
				session.mode === "file" &&
				session.nodeId === browserBinding.nodeId &&
				session.targetKind === browserBinding.targetKind))
			? session.sessionId
			: null;

	useEffect(() => {
		AiChatController.useStore.setState({ browserSessionId: bound });
		return () => {
			AiChatController.useStore.setState({ browserSessionId: null });
		};
	}, [bound]);

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
	| "FilesBrowser-meta";

export type FilesBrowser_Props = {
	targetKind: "saved" | "private";
	nodeId: string;
	path: string;
	host: files_browser_StreamHost;
	editorRevision: number;
	serverSequence: number | null;
	getDraftText: (() => string | null) | null;
	getDraftRevision: (() => number) | null;
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
		if (started._nay.message === "Plan required") {
			return { ok: false, error: "The browser needs a Pay As You Go or Pro plan." };
		}
		return { ok: false, error: started._nay.message };
	}
	return { ok: true, isDraft: args.sourceKind === "draft" };
}

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
	} = props;
	const { membershipId, organizationId, organizationName, workspaceId, workspaceName } =
		AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const convex = useConvex();
	const viewerRef = useRef<BrowserViewer_Ref | null>(null);

	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });
	// File mode has the same paid-plan rule as web mode. `paidPlan` is the payer's plan.
	const available = useQuery(app_convex_api.files_browser.web_browser_available, { membershipId });
	const mine =
		session && session.mode === "file" && session.nodeId === nodeId && session.targetKind === targetKind ? session : null;
	const sessionId = mine?.sessionId;
	const selectedThreadId = FilesBrowserResumeThreadMirror.useThreadId();
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

	const handleEnd = useFn((endingSessionId: app_convex_Id<"files_browser_sessions">) => {
		convex
			.action(app_convex_api.files_browser.end_browser, { membershipId, sessionId: endingSessionId })
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

	const deadline = mine ? format_remaining_time(mine, now) : null;
	const sourceMeta = mine ? `${files_browser_source_label(mine.sourceKind)} · ${mine.sourceHash.slice(0, 8)}` : null;

	return (
		<div className={"FilesBrowser" satisfies FilesBrowser_ClassNames} role="region" aria-label="Shared browser">
			<div className={"FilesBrowser-header" satisfies FilesBrowser_ClassNames}>
				<span className={"FilesBrowser-title" satisfies FilesBrowser_ClassNames}>
					<MonitorPlay size={16} aria-hidden />
					Shared browser
				</span>
				{mine && control && (
					<span className={"FilesBrowser-status" satisfies FilesBrowser_ClassNames} role="status">
						{BrowserViewer.CONTROL_LABELS[control] ?? control}
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
							<MyIconButton
								variant="ghost-highlightable"
								tooltip="Keep open for 5 more minutes"
								onClick={handleKeepOpen}
							>
								<MyIconButtonIcon>
									<Clock size={16} />
								</MyIconButtonIcon>
							</MyIconButton>
							<MyIconButton variant="ghost_destructive" tooltip="End browser" onClick={() => handleEnd(mine.sessionId)}>
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
				</div>
			</div>

			{mine ? (
				<>
					<div className={"FilesBrowser-meta" satisfies FilesBrowser_ClassNames}>
						<span>{sourceMeta}</span>
						{updatesAvailable && (
							<span className={"FilesBrowser-status-warn" satisfies FilesBrowser_ClassNames}>Updates available</span>
						)}
						{deadline && <span>{deadline}</span>}
						{!connected && connectionDetail && <span role="status">{connectionDetail}</span>}
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
						<BrowserViewer
							ref={viewerRef}
							key={mine.sessionId}
							mode="file"
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
							onSessionEnded={handleEnd}
							onWebMessage={null}
						/>
					)}
				</>
			) : session?.mode === "web" ? (
				// One live browser per user and workspace: a web browser blocks a file browser here.
				<div className={"FilesBrowser-start" satisfies FilesBrowser_ClassNames}>
					<span>A web browser is open.</span>
					<MyLink
						to="/w/$organizationName/$workspaceName/browser"
						params={{ organizationName, workspaceName }}
						variant="button-ghost-accent"
					>
						Open the web browser
					</MyLink>
					<MyButton variant="outline" onClick={() => handleEnd(session.sessionId)}>
						End it
					</MyButton>
				</div>
			) : available?.paidPlan === false ? (
				// Free plans see the feature but cannot start it. The start door refuses them too.
				<div className={"FilesBrowser-start" satisfies FilesBrowser_ClassNames}>
					<span>The browser needs a Pay As You Go or Pro plan. Change your plan in Billing, in your account menu.</span>
				</div>
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
		</div>
	);
});

export { FilesBrowser, FilesBrowserBindingWriter, FilesBrowserResumeThreadMirror };

// #endregion panel
