import "./web-browser.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { BrowserViewer, type BrowserViewer_Ref } from "@/components/browser/browser-viewer.tsx";
import { WebBrowserFileChooser } from "@/components/browser/web-browser-file-chooser.tsx";
import { WebBrowserSavedData } from "@/components/browser/web-browser-saved-data.tsx";
import { FilesBrowserResumeThreadMirror } from "@/components/files/file-node-view/files-browser.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputHelperText,
	MyInputLabel,
} from "@/components/my-input.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { MySwitch } from "@/components/my-switch.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { ai_chat_is_optimistic_thread_id } from "@/lib/ai-chat.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { files_browser_StreamControlMessage, files_browser_StreamWebMessage } from "@/lib/files-browser-stream.ts";
import { useNavigate } from "@tanstack/react-router";
import { browser_web_normalize_url, type browser_web_UrlRefusal } from "common/browser-web-url.ts";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, ArrowRight, Bot, Clock, Hand, KeyRound, Play, RotateCw, Square, X } from "lucide-react";
import { memo, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { toast } from "sonner";

type WebBrowser_Session = Extract<
	NonNullable<FunctionReturnType<typeof app_convex_api.files_browser.current_browser_session>>,
	{ mode: "web" }
>;

const WEB_BROWSER_VIEWPORT = { width: 1280, height: 800 };

// The runner ends a web session 60 minutes after it starts. The session has no start time, so
// the time used is this limit minus the time left until `totalUntil`.
const WEB_BROWSER_TOTAL_MS = 60 * 60 * 1000;

const WEB_BROWSER_ADDRESS_ERRORS: Record<browser_web_UrlRefusal, string> = {
	empty: "Type an address.",
	too_long: "This address is too long.",
	invalid: "This is not a valid address.",
	scheme: "Use an address that starts with http:// or https://.",
	credentials: "Remove the user name and password from the address.",
	denied_host: "This address is blocked.",
};

const WEB_BROWSER_NOTICES: Record<string, string> = {
	popup_opened_here: "Opened the new tab here",
	popup_closed: "Closed a new tab",
	address_blocked: "This address is blocked",
	upload_unsupported: "This site uses a file picker the cloud browser does not support.",
	download_unsupported: "This download is not supported in the cloud browser.",
	download_blocked: "A download started without a click was blocked.",
	download_busy: "Download not saved: another download is still being saved.",
	download_too_large: "Download not saved: over 25 MB.",
	download_limit: "Download not saved: too many downloads in this session.",
	download_lost: "A download was not saved in time.",
	download_failed: "Download not saved: it did not finish.",
};

function web_browser_address_error(value: string) {
	const normalized = browser_web_normalize_url(value, []);
	return normalized.ok ? undefined : WEB_BROWSER_ADDRESS_ERRORS[normalized.reason];
}

function web_browser_minutes(ms: number) {
	return Math.max(0, Math.floor(ms / 60_000));
}

type WebBrowserStart_ClassNames =
	| "WebBrowserStart"
	| "WebBrowserStart-header"
	| "WebBrowserStart-title"
	| "WebBrowserStart-text"
	| "WebBrowserStart-saved"
	| "WebBrowserStart-address"
	| "WebBrowserStart-actions"
	| "WebBrowserStart-error";

type WebBrowserStart_Props = {
	/**
	 * The live file browser of this user and workspace. Only one browser can be live, so Start
	 * offers to end it first.
	 */
	fileSessionId: app_convex_Id<"files_browser_sessions"> | null;
	/**
	 * A web session exists but the runner is still opening it. This card stays until the session
	 * is ready, so a refusal that arrives after that still shows here, with the typed address.
	 */
	sessionStarting: boolean;
	available: { enabled: boolean; paidPlan: boolean } | undefined;
	savedData: boolean;
	onManageSavedData: () => void;
};

const WebBrowserStart = memo(function WebBrowserStart(props: WebBrowserStart_Props) {
	const { fileSessionId, sessionStarting, available, savedData, onManageSavedData } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [startAddress, setStartAddress] = useState("");
	const [displayValidationMessage, setDisplayValidationMessage] = useState<string | undefined>();
	const [startPending, setStartPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A start from another tab also shows as starting here.
	const starting = startPending || sessionStarting;

	// The start address is optional. An empty field starts on a blank page.
	const validationMessage = startAddress.trim() === "" ? undefined : web_browser_address_error(startAddress);

	const handleAddressInput = useFn((event: ChangeEvent<HTMLInputElement>) => {
		const value = event.currentTarget.value;
		setStartAddress(value);
		if (displayValidationMessage !== undefined) {
			setDisplayValidationMessage(value.trim() === "" ? undefined : web_browser_address_error(value));
		}
	});

	const start = () => {
		setStartPending(true);
		setError(null);
		const normalized = startAddress.trim() === "" ? null : browser_web_normalize_url(startAddress, []);
		(async (/* iife */) => {
			if (fileSessionId) {
				const ended = await convex.action(app_convex_api.files_browser.end_browser, {
					membershipId,
					sessionId: fileSessionId,
				});
				if (ended._nay) {
					setError(ended._nay.message);
					return;
				}
			}
			const started = await convex.action(app_convex_api.files_browser.start_web_browser, {
				membershipId,
				viewport: WEB_BROWSER_VIEWPORT,
				startUrl: normalized?.ok ? normalized.url : null,
			});
			if (!started._nay) {
				return;
			}
			switch (started._nay.message) {
				case "Permission denied":
					setError("You do not have permission to use the browser in this workspace.");
					break;
				case "Daily limit reached":
					setError("You reached today's limit of web browser starts. Try again tomorrow.");
					break;
				case "Browser busy":
					// A live file browser also shows up in the session query, and then this card offers to end it.
					setError("Another browser is open. End it first.");
					break;
				case "Address blocked":
					setError("This address is blocked.");
					break;
				case "Plan required":
					setError("The browser needs a Pay As You Go or Pro plan.");
					break;
				case "Browser did not start":
					setError("The browser did not start. Try again.");
					break;
				default:
					setError(started._nay.message);
			}
		})()
			.catch((error: unknown) => {
				setError("Starting failed. Try again.");
				console.error("[WebBrowserStart.start] Unexpected start error", { error });
			})
			.finally(() => {
				setStartPending(false);
			});
	};

	const handleSubmit = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (validationMessage) {
			setDisplayValidationMessage(validationMessage);
			return;
		}
		start();
	});

	if (available === undefined) {
		return (
			<div className={"WebBrowserStart" satisfies WebBrowserStart_ClassNames}>
				<MySpinner size="16px" aria-label="Loading" />
			</div>
		);
	}

	const header = (
		<div className={"WebBrowserStart-header" satisfies WebBrowserStart_ClassNames}>
			<h2 className={"WebBrowserStart-title" satisfies WebBrowserStart_ClassNames}>Web browser</h2>
			{savedData && <MyBadge variant="outline">Saved data</MyBadge>}
		</div>
	);

	const manageSavedDataButton = (
		<MyButton variant="outline" onClick={onManageSavedData}>
			<MyButtonIcon>
				<KeyRound aria-hidden />
			</MyButtonIcon>
			Manage saved data
		</MyButton>
	);

	if (!available.enabled) {
		return (
			<div className={"WebBrowserStart" satisfies WebBrowserStart_ClassNames}>
				{header}
				<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>
					The web browser is not available in this workspace.
				</p>
				{/* A user may always clear their own saved data, even while the browser is off. */}
				{savedData && manageSavedDataButton}
			</div>
		);
	}

	return (
		<form className={"WebBrowserStart" satisfies WebBrowserStart_ClassNames} noValidate onSubmit={handleSubmit}>
			{header}
			<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>Browser time is billed per minute.</p>
			<div className={"WebBrowserStart-saved" satisfies WebBrowserStart_ClassNames}>
				<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>
					Your logins are saved for this workspace. Only you and your agent chats use them.
				</p>
				{manageSavedDataButton}
			</div>
			<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>
				Your agent can use the sites you are logged in to. Add sites it must not use, like your bank, under Manage saved
				data.
			</p>
			<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>
				Reload the page before you type a password if the agent used it.
			</p>
			{available.paidPlan ? (
				<>
					<MyInput
						className={"WebBrowserStart-address" satisfies WebBrowserStart_ClassNames}
						layout="stacked"
						displayValidationMessage={displayValidationMessage}
					>
						<MyInputLabel>Start address (optional)</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								type="text"
								inputMode="url"
								autoComplete="off"
								spellCheck={false}
								placeholder="example.com"
								value={startAddress}
								validationMessage={validationMessage}
								disabled={starting}
								onChange={handleAddressInput}
							/>
						</MyInputArea>
						<MyInputBox />
						<MyInputHelperText aria-live="polite">{displayValidationMessage}</MyInputHelperText>
					</MyInput>
					<div className={"WebBrowserStart-actions" satisfies WebBrowserStart_ClassNames}>
						{fileSessionId ? (
							<>
								<span>A file browser is open in Files.</span>
								<MyButton type="submit" variant="default" disabled={starting} aria-busy={starting}>
									{starting ? "Starting…" : "End it and start here"}
								</MyButton>
							</>
						) : (
							<MyButton type="submit" variant="default" disabled={starting} aria-busy={starting}>
								<MyButtonIcon>
									<Play aria-hidden />
								</MyButtonIcon>
								{starting ? "Starting…" : "Start web browser"}
							</MyButton>
						)}
					</div>
				</>
			) : (
				// Free plans see the feature but cannot start it. The start door refuses them too.
				<p className={"WebBrowserStart-text" satisfies WebBrowserStart_ClassNames}>
					The browser needs a Pay As You Go or Pro plan. Change your plan in Billing, in your account menu.
				</p>
			)}
			{error && (
				<span className={"WebBrowserStart-error" satisfies WebBrowserStart_ClassNames} role="alert">
					{error}
				</span>
			)}
		</form>
	);
});

type WebBrowserLive_ClassNames =
	| "WebBrowserLive"
	| "WebBrowserLive-toolbar"
	| "WebBrowserLive-address"
	| "WebBrowserLive-address-hint"
	| "WebBrowserLive-address-error"
	| "WebBrowserLive-agent-access"
	| "WebBrowserLive-status"
	| "WebBrowserLive-title"
	| "WebBrowserLive-notice";

type WebBrowserLive_CustomAttributes = {
	"data-agent-access": "on" | "off";
};

type WebBrowserLive_Location = Omit<Extract<files_browser_StreamWebMessage, { t: "location" }>, "t">;

/**
 * The open file dialog of the page. The runner keeps at most one.
 */
type WebBrowserLive_FileChooser = Omit<Extract<files_browser_StreamWebMessage, { t: "file-chooser" }>, "t">;

type WebBrowserLive_Props = {
	session: WebBrowser_Session;
	savedData: boolean;
	onManageSavedData: () => void;
};

const WebBrowserLive = memo(function WebBrowserLive(props: WebBrowserLive_Props) {
	const { session, savedData, onManageSavedData } = props;
	const { membershipId, organizationId, organizationName, workspaceId, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const convex = useConvex();
	const navigate = useNavigate();
	const viewerRef = useRef<BrowserViewer_Ref | null>(null);
	const resumeThreadId = FilesBrowserResumeThreadMirror.useThreadId();

	const [viewerId, setViewerId] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
	const [remoteControl, setRemoteControl] = useState<files_browser_StreamControlMessage | null>(null);
	const [takingGen, setTakingGen] = useState<number | null>(null);
	const [remoteAgentAccess, setRemoteAgentAccess] = useState<boolean | null>(null);
	const [switchingAgentAccess, setSwitchingAgentAccess] = useState(false);
	const [location, setLocation] = useState<WebBrowserLive_Location | null>(null);
	const [addressDraft, setAddressDraft] = useState<string | null>(null);
	const [displayValidationMessage, setDisplayValidationMessage] = useState<string | undefined>();
	const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
	const [fileChooser, setFileChooser] = useState<WebBrowserLive_FileChooser | null>(null);
	const [now, setNow] = useState(() => Date.now());

	// Query and socket updates arrive separately. Finishing a handoff keeps its generation.
	const control =
		!remoteControl ||
		session.controlGen > remoteControl.controlGen ||
		(session.controlGen === remoteControl.controlGen &&
			session.control === "human" &&
			remoteControl.control === "pausing")
			? session.control
			: remoteControl.control;
	const controlGen = Math.max(session.controlGen, remoteControl?.controlGen ?? 0);
	const hasControl = control === "human" && connected;
	// Take is in progress until the control generation moves on.
	const taking = takingGen !== null && takingGen === controlGen;
	// The socket pushes every change, so its value wins over the query.
	const agentAccess = remoteAgentAccess ?? session.agentAccess;
	const addressValue = addressDraft ?? location?.url ?? "";
	const validationMessage = addressDraft === null ? undefined : web_browser_address_error(addressDraft);
	const loading = location?.loading ?? false;

	const timeLeft = [session.idleUntil, session.totalUntil].filter((value): value is number => value !== null);
	const minutesLeft = timeLeft.length > 0 ? web_browser_minutes(Math.min(...timeLeft) - now) : null;
	const minutesUsed =
		session.totalUntil !== null ? web_browser_minutes(WEB_BROWSER_TOTAL_MS - (session.totalUntil - now)) : null;

	const showNotice = (text: string) => {
		setNotice({ id: Date.now(), text });
	};

	const handleGrant = useFn(async (): Promise<{ grantId: string; viewerUrl: string } | null> => {
		const granted = await convex.action(app_convex_api.files_browser.grant_browser_viewer, {
			membershipId,
			sessionId: session.sessionId,
		});
		if (granted._nay) {
			toast.error(granted._nay.message);
			return null;
		}
		return { grantId: granted._yay.grantId, viewerUrl: granted._yay.viewerUrl };
	});

	const handleViewerHello = useFn((id: string) => {
		setViewerId(id);
	});

	const handleViewerControl = useFn((next: files_browser_StreamControlMessage) => {
		setRemoteControl(next);
	});

	const handleConnection = useFn((isConnected: boolean, detail: string | null) => {
		// No detail means the viewer lost its socket and connects again. The new socket gets a new
		// viewer id, and the runner gives control to one viewer id only, so control is lost. Say so,
		// or the panel just shows "Watching" again.
		if (!isConnected && detail === null && hasControl) {
			showNotice("You lost control because the viewer reconnected. Take control again.");
		}
		setConnected(isConnected);
		setConnectionDetail(detail);
	});

	const handleEnd = useFn(() => {
		convex
			.action(app_convex_api.files_browser.end_browser, { membershipId, sessionId: session.sessionId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[WebBrowserLive.end] Unexpected end error", { error });
			});
	});

	const openDownload = (nodeId: app_convex_Id<"files_nodes">) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search: { nodeId },
		}).catch((error: unknown) => {
			console.error("[WebBrowserLive.openDownload] Failed to open the download in Files", { error });
		});
	};

	// Delete works like Delete in Files: it archives the file, so it can be restored there.
	const deleteDownload = (nodeId: app_convex_Id<"files_nodes">) => {
		convex
			.mutation(app_convex_api.files_nodes.archive_nodes, { membershipId, nodeIds: [nodeId] })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}
				toast.success("Download deleted. You can restore it from the archived items in Files.");
			})
			.catch((error: unknown) => {
				console.error("[WebBrowserLive.deleteDownload] Unexpected archive error", { error });
			});
	};

	// The runner holds a human download for 2 minutes only, so it is saved to Files at once.
	// Saving the same download again returns the same file, so a second tab does no harm. After a
	// failed upload, Retry saves again: the runner keeps the bytes until the 2 minutes end.
	const saveDownload = (downloadId: string) => {
		const retry = { label: "Retry", onClick: () => saveDownload(downloadId) };
		convex
			.action(app_convex_api.files_browser.save_browser_download, {
				membershipId,
				sessionId: session.sessionId,
				downloadId,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message, { action: retry });
					return;
				}
				const { nodeId, path, shared } = result._yay;
				// Files paths start at the workspace root "/". The toast shows them without it.
				toast.success(`Saved to ${path.replace(/^\//, "")}`, {
					description: shared ? "Members of this workspace can see it." : undefined,
					action: { label: "Open", onClick: () => openDownload(nodeId) },
					cancel: { label: "Delete", onClick: () => deleteDownload(nodeId) },
				});
			})
			.catch((error: unknown) => {
				toast.error("Download not saved. Try again.", { action: retry });
				console.error("[WebBrowserLive.saveDownload] Unexpected save error", { error });
			});
	};

	const handleWebMessage = useFn((message: files_browser_StreamWebMessage) => {
		switch (message.t) {
			case "location":
				setLocation({
					url: message.url,
					title: message.title,
					loading: message.loading,
					canGoBack: message.canGoBack,
					canGoForward: message.canGoForward,
				});
				break;
			case "notice":
				showNotice(WEB_BROWSER_NOTICES[message.code] ?? "The browser sent a notice.");
				break;
			case "agent-access":
				setRemoteAgentAccess(message.on);
				break;
			case "download":
				saveDownload(message.downloadId);
				break;
			case "file-chooser":
				// The runner keeps one open chooser. A new one replaces the old one.
				setFileChooser({
					chooserId: message.chooserId,
					multiple: message.multiple,
					accept: message.accept,
					origin: message.origin,
				});
				break;
			case "file-chooser-closed":
				setFileChooser((current) => (current?.chooserId === message.chooserId ? null : current));
				break;
			case "nav-ack":
				if (message.ok || message.code === "no_history") {
					break;
				}
				if (message.code === "not_controller") {
					showNotice("Take control to navigate");
				} else if (message.code === "denied_host") {
					showNotice("This address is blocked");
				} else if (message.code && Object.hasOwn(WEB_BROWSER_ADDRESS_ERRORS, message.code)) {
					showNotice("This address is not valid");
				} else {
					showNotice("The browser could not do that. Try again.");
				}
				break;
		}
	});

	const sendNav = (nav: Parameters<BrowserViewer_Ref["sendNav"]>[0]) => {
		const seq = viewerRef.current?.sendNav(nav) ?? -1;
		if (seq === -1) {
			showNotice("The browser is not connected yet. Try again.");
		}
		return seq !== -1;
	};

	const handleAddressInput = useFn((event: ChangeEvent<HTMLInputElement>) => {
		const value = event.currentTarget.value;
		setAddressDraft(value);
		if (displayValidationMessage !== undefined) {
			setDisplayValidationMessage(web_browser_address_error(value));
		}
	});

	const handleAddressKeyDown = useFn((event: React.KeyboardEvent<HTMLInputElement>) => {
		// Escape drops the typed address and shows the page address again.
		if (event.key === "Escape") {
			setAddressDraft(null);
			setDisplayValidationMessage(undefined);
		}
	});

	// Enter in the address and the Go button both submit this form.
	const handleGo = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!hasControl) {
			return;
		}
		const normalized = browser_web_normalize_url(addressValue, []);
		if (!normalized.ok) {
			setDisplayValidationMessage(WEB_BROWSER_ADDRESS_ERRORS[normalized.reason]);
			return;
		}
		if (sendNav({ action: "go", url: normalized.url })) {
			setAddressDraft(null);
			setDisplayValidationMessage(undefined);
			// Like a desktop browser, move focus from the address to the page after Go.
			viewerRef.current?.focus();
		}
	});

	const handleTake = useFn(() => {
		if (!viewerId || !connected) {
			return;
		}
		setTakingGen(controlGen);
		convex
			.action(app_convex_api.files_browser.take_browser_control, {
				membershipId,
				sessionId: session.sessionId,
				viewerId,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					setTakingGen(null);
				}
			})
			.catch((error: unknown) => {
				setTakingGen(null);
				console.error("[WebBrowserLive.take] Unexpected take error", { error });
			});
	});

	const handleResume = useFn(() => {
		if (!resumeThreadId || ai_chat_is_optimistic_thread_id(resumeThreadId)) {
			return;
		}
		convex
			.action(app_convex_api.files_browser.resume_browser_agent, {
				membershipId,
				sessionId: session.sessionId,
				threadId: resumeThreadId as app_convex_Id<"ai_chat_threads">,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[WebBrowserLive.resume] Unexpected resume error", { error });
			});
	});

	const handleKeepOpen = useFn(() => {
		convex
			.action(app_convex_api.files_browser.keep_open_browser, { membershipId, sessionId: session.sessionId })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[WebBrowserLive.keepOpen] Unexpected keep-open error", { error });
			});
	});

	const handleFileChooserCancel = useFn(() => {
		if (fileChooser) {
			// The runner ignores this unless this viewer holds control. Then the chooser stays until
			// it expires or the page navigates.
			viewerRef.current?.sendFileChooserCancel(fileChooser.chooserId);
		}
		setFileChooser(null);
	});

	const handleFileChooserGiven = useFn(() => {
		setFileChooser(null);
		showNotice("File given to the page");
	});

	// The runner sends `file-chooser-closed` before it fills the page, so a refusal can arrive
	// after that message closed the dialog. An open dialog shows the refusal itself.
	const handleFileChooserFailed = useFn((chooserId: string, text: string) => {
		if (fileChooser?.chooserId !== chooserId) {
			toast.error(text);
		}
	});

	const handleAgentAccessChange = useFn((on: boolean) => {
		setSwitchingAgentAccess(true);
		convex
			.action(app_convex_api.files_browser.set_browser_agent_access, {
				membershipId,
				sessionId: session.sessionId,
				on,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}
				setRemoteAgentAccess(result._yay.agentAccess);
			})
			.catch((error: unknown) => {
				console.error("[WebBrowserLive.agentAccess] Unexpected agent access error", { error });
			})
			.finally(() => {
				setSwitchingAgentAccess(false);
			});
	});

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (!notice) {
			return;
		}
		const timer = setTimeout(() => setNotice(null), 8000);
		return () => clearTimeout(timer);
	}, [notice]);

	// Renew the viewer grant on a timer. A refusal closes the stream at once instead of waiting
	// for the runner's grant deadline. Control and access changes must not restart the timer.
	useEffect(() => {
		if (!viewerId || !connected) {
			return;
		}
		const timer = setInterval(() => {
			convex
				.action(app_convex_api.files_browser.renew_browser_viewer, {
					membershipId,
					sessionId: session.sessionId,
					viewerId,
				})
				.then((result) => {
					if (result._nay) {
						viewerRef.current?.close();
						setConnected(false);
						setConnectionDetail("Access changed. The viewer closed.");
						return;
					}
					if (result._yay.agentAccess !== null) {
						setRemoteAgentAccess(result._yay.agentAccess);
					}
				})
				.catch((error: unknown) => {
					console.error("[WebBrowserLive.renew] Unexpected renew error", { error });
				});
		}, 20_000);
		return () => clearInterval(timer);
	}, [convex, membershipId, session.sessionId, viewerId, connected]);

	return (
		<div className={"WebBrowserLive" satisfies WebBrowserLive_ClassNames} aria-busy={loading}>
			<div className={"WebBrowserLive-toolbar" satisfies WebBrowserLive_ClassNames} role="toolbar" aria-label="Browser">
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Back"
					disabled={!hasControl || !location?.canGoBack}
					onClick={() => sendNav({ action: "back" })}
				>
					<MyIconButtonIcon>
						<ArrowLeft size={16} />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Forward"
					disabled={!hasControl || !location?.canGoForward}
					onClick={() => sendNav({ action: "forward" })}
				>
					<MyIconButtonIcon>
						<ArrowRight size={16} />
					</MyIconButtonIcon>
				</MyIconButton>
				{loading ? (
					<MyIconButton
						variant="ghost-highlightable"
						tooltip="Stop"
						disabled={!hasControl}
						onClick={() => sendNav({ action: "stop" })}
					>
						<MyIconButtonIcon>
							<X size={16} />
						</MyIconButtonIcon>
					</MyIconButton>
				) : (
					<MyIconButton
						variant="ghost-highlightable"
						tooltip="Reload"
						disabled={!hasControl}
						onClick={() => sendNav({ action: "reload" })}
					>
						<MyIconButtonIcon>
							<RotateCw size={16} />
						</MyIconButtonIcon>
					</MyIconButton>
				)}
				<form className={"WebBrowserLive-address" satisfies WebBrowserLive_ClassNames} noValidate onSubmit={handleGo}>
					<MyInput displayValidationMessage={displayValidationMessage}>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								type="text"
								inputMode="url"
								autoComplete="off"
								spellCheck={false}
								aria-label="Address"
								value={addressValue}
								readOnly={!hasControl}
								validationMessage={validationMessage}
								onChange={handleAddressInput}
								onKeyDown={handleAddressKeyDown}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>
					<MyButton type="submit" variant="outline" disabled={!hasControl}>
						Go
					</MyButton>
				</form>
				{control === "human" ? (
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
				) : (
					<MyButton
						variant="outline"
						disabled={!viewerId || !connected || taking || (control !== "ready" && control !== "agent")}
						onClick={handleTake}
					>
						<MyButtonIcon>
							<Hand aria-hidden />
						</MyButtonIcon>
						{taking ? "Taking…" : "Take control"}
					</MyButton>
				)}
				<MyIconButton variant="ghost-highlightable" tooltip="Manage saved data" onClick={onManageSavedData}>
					<MyIconButtonIcon>
						<KeyRound size={16} />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyIconButton variant="ghost-highlightable" tooltip="Keep open" onClick={handleKeepOpen}>
					<MyIconButtonIcon>
						<Clock size={16} />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyIconButton variant="ghost_destructive" tooltip="End browser" onClick={handleEnd}>
					<MyIconButtonIcon>
						<Square size={16} />
					</MyIconButtonIcon>
				</MyIconButton>
				<label className={"WebBrowserLive-agent-access" satisfies WebBrowserLive_ClassNames}>
					<MySwitch
						{...({ "data-agent-access": agentAccess ? "on" : "off" } satisfies WebBrowserLive_CustomAttributes)}
						checked={agentAccess}
						disabled={switchingAgentAccess}
						onCheckedChange={handleAgentAccessChange}
					/>
					Agent can use this browser
				</label>
			</div>
			{!hasControl && (
				<span className={"WebBrowserLive-address-hint" satisfies WebBrowserLive_ClassNames}>
					Take control to navigate
				</span>
			)}
			{displayValidationMessage && (
				<span className={"WebBrowserLive-address-error" satisfies WebBrowserLive_ClassNames} role="alert">
					{displayValidationMessage}
				</span>
			)}
			<div className={"WebBrowserLive-status" satisfies WebBrowserLive_ClassNames}>
				<span className={"WebBrowserLive-title" satisfies WebBrowserLive_ClassNames}>
					{location?.title || location?.url || "New page"}
				</span>
				{loading && <span>Loading…</span>}
				<span role="status">{BrowserViewer.CONTROL_LABELS[control] ?? control}</span>
				{minutesUsed !== null && <span>{minutesUsed} min used</span>}
				{minutesLeft !== null && <span>{minutesLeft} min left</span>}
				{savedData && <MyBadge variant="outline">Saved data</MyBadge>}
				{!connected && connectionDetail && <span role="status">{connectionDetail}</span>}
			</div>
			<div className={"WebBrowserLive-notice" satisfies WebBrowserLive_ClassNames} role="status">
				{notice?.text}
			</div>
			{/* A starting session shows the Start card instead of this panel. */}
			{session.control === "closing" ? (
				<div className={"WebBrowserLive-status" satisfies WebBrowserLive_ClassNames}>
					<MySpinner size="16px" aria-label="Closing" />
					<span>Closing…</span>
				</div>
			) : (
				<BrowserViewer
					ref={viewerRef}
					mode="web"
					sessionId={session.sessionId}
					ownerId={userId}
					organizationId={organizationId}
					workspaceId={workspaceId}
					host="docked"
					inputEnabled={hasControl}
					grant={handleGrant}
					onViewerHello={handleViewerHello}
					onControl={handleViewerControl}
					onConnection={handleConnection}
					onSessionEnded={handleEnd}
					onWebMessage={handleWebMessage}
				/>
			)}
			{fileChooser && (
				<WebBrowserFileChooser
					key={fileChooser.chooserId}
					sessionId={session.sessionId}
					chooser={fileChooser}
					controlGen={controlGen}
					hasControl={hasControl}
					onCancel={handleFileChooserCancel}
					onGiven={handleFileChooserGiven}
					onFailed={handleFileChooserFailed}
				/>
			)}
		</div>
	);
});

type WebBrowser_ClassNames = "WebBrowser";

type WebBrowser_CustomAttributes = {
	"data-browser-mode": "web";
};

/**
 * The cloud web browser of this user and workspace. Leaving the page keeps the session: the
 * runner's idle limit ends it. Coming back attaches a new viewer to the same session.
 */
export const WebBrowser = memo(function WebBrowser() {
	const { membershipId } = AppTenantProvider.useContext();
	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });
	const available = useQuery(app_convex_api.files_browser.web_browser_available, { membershipId });
	const profile = useQuery(app_convex_api.files_browser.current_browser_profile, { membershipId });

	// This owner keeps the dialog, so it stays open when listing saved sites ends the live panel.
	const [savedDataOpen, setSavedDataOpen] = useState(false);

	// The profile doc exists after the first web start, and also after the blocked sites list was
	// set before any start. The query cannot tell those apart, so the badge says "Saved data" and
	// not "Saved logins".
	const savedData = profile?.exists === true;

	const handleManageSavedData = useFn(() => {
		setSavedDataOpen(true);
	});

	const handleSavedDataClose = useFn(() => {
		setSavedDataOpen(false);
	});

	return (
		<div
			className={"WebBrowser" satisfies WebBrowser_ClassNames}
			role="region"
			aria-label="Web browser"
			{...({ "data-browser-mode": "web" } satisfies WebBrowser_CustomAttributes)}
		>
			{session?.mode === "web" && session.control !== "starting" ? (
				// A new session remounts the live panel, so no state from the old session survives.
				<WebBrowserLive
					key={session.sessionId}
					session={session}
					savedData={savedData}
					onManageSavedData={handleManageSavedData}
				/>
			) : (
				// The Start card stays while the runner opens the session. It shows a refusal from the
				// runner with the typed address, and live controls appear only once the session is ready.
				<WebBrowserStart
					fileSessionId={session?.mode === "file" ? session.sessionId : null}
					sessionStarting={session?.mode === "web"}
					available={available}
					savedData={savedData}
					onManageSavedData={handleManageSavedData}
				/>
			)}
			{savedDataOpen && (
				// Any live browser of this user here, file or web, ends when saved sites are read.
				<WebBrowserSavedData browserLive={!!session} profile={profile} onClose={handleSavedDataClose} />
			)}
		</div>
	);
});
