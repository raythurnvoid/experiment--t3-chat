import "./playwriter-browser-connection.css";

import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { playwriter_parse_share } from "../../../shared/playwriter-browser.ts";
import { useConvex, useQuery } from "convex/react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";

const CONNECTION_LABELS = {
	connecting: "Connecting…",
	needs_confirmation: "Choose a tab",
	ready: "Connected",
	running: "Agent is using this tab",
	paused: "Paused",
	recovering: "Recovering…",
	offline: "Offline",
	closing: "Disconnecting…",
	closed: "Disconnected",
	limit_reached: "Limit reached",
	needs_human: "Needs your help",
};

const PAUSE_REASON_LABELS: Record<string, string> = {
	human: "You paused the agent.",
	agent_closed: "The agent ended this browser session.",
	limit: "This browser session reached its limit.",
	access_lost: "Browser access changed.",
	idle_expired: "This browser connection expired while idle.",
	unavailable: "This browser connection is unavailable.",
	disconnected: "You disconnected this browser.",
	connect_failed: "The browser could not connect.",
	connect_again: "Connect your browser again.",
	key_unavailable: "Connect your browser again.",
	member_removed: "Workspace access changed.",
};

type PlaywriterBrowserConnection_ClassNames =
	| "PlaywriterBrowserConnection"
	| "PlaywriterBrowserConnection-title"
	| "PlaywriterBrowserConnection-form"
	| "PlaywriterBrowserConnection-text"
	| "PlaywriterBrowserConnection-actions"
	| "PlaywriterBrowserConnection-targets"
	| "PlaywriterBrowserConnection-target"
	| "PlaywriterBrowserConnection-error";

type PlaywriterBrowserConnection_CustomAttributes = {
	"data-browser-provider": "playwriter";
	"data-connection-state": keyof typeof CONNECTION_LABELS;
};

/**
 * The user's native tab is the view. This component never mounts a cloud viewer.
 */
export const PlaywriterBrowserConnection = memo(function PlaywriterBrowserConnection() {
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const available = useQuery(app_convex_api.playwriter_browser.remote_browser_available, { membershipId });
	const connection = useQuery(app_convex_api.playwriter_browser.current_connection, { membershipId });
	const preferences = useQuery(app_convex_api.files_browser.current_browser_preferences, { membershipId });
	const statusRef = useRef<HTMLParagraphElement>(null);
	const shareRef = useRef<HTMLInputElement>(null);
	const refreshedConnectionRef = useRef<string | null>(null);
	const [share, setShare] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = (action: () => Promise<{ _nay?: { message: string; name?: string } | null }>) => {
		statusRef.current?.focus();
		setPending(true);
		setError(null);
		return (async (/* iife */) => {
			const result = await action();
			if (result._nay) setError(result._nay.message);
		})()
			.catch(() => {
				// Remote errors may contain share IDs. Keep them out of logs and the UI.
				setError("The browser could not do that. Try again.");
			})
			.finally(() => setPending(false));
	};

	const handleConnect = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		const id = playwriter_parse_share(share);
		if (!id) {
			setError(
				"Paste the 32-character share ID or the Playwriter Remote control link. For a copied command, paste only the value after --remote.",
			);
			shareRef.current?.focus();
			return;
		}
		// Forget the pasted value before sending it. It never becomes chat or saved browser data.
		setShare("");
		void run(() => convex.action(app_convex_api.playwriter_browser.connect_tab, { membershipId, share: id }));
	});

	// The stored status is only a mirror. Check the runner whenever these controls mount.
	useEffect(() => {
		if (!connection || refreshedConnectionRef.current === connection.connectionId) return;
		refreshedConnectionRef.current = connection.connectionId;
		convex
			.action(app_convex_api.playwriter_browser.refresh_connection_status, {
				membershipId,
				connectionId: connection.connectionId,
			})
			.then((result) => {
				if (result._nay) setError(result._nay.message);
			})
			.catch(() => {
				// Remote errors may contain the saved share. Show only this fixed message.
				setError("Could not check the connection. Try Refresh status.");
			});
	}, [convex, membershipId, connection?.connectionId]);

	const live = connection !== null && connection !== undefined && connection.state !== "closed";
	const canAct = available?.enabled === true && !pending;
	// Needs-help states may have no transport. Reconnect checks it before resuming.
	const canResume = connection?.state === "paused";
	const chosen = preferences?.webChoice;
	const targetSelected =
		chosen?.provider === "playwriter" &&
		chosen.connectionId === connection?.connectionId &&
		chosen.confirmedTargetHandle === connection?.target?.handle;

	return (
		<section
			className={"PlaywriterBrowserConnection" satisfies PlaywriterBrowserConnection_ClassNames}
			aria-label="My browser connection"
			{...({
				"data-browser-provider": "playwriter",
				"data-connection-state": connection?.state ?? "closed",
			} satisfies PlaywriterBrowserConnection_CustomAttributes)}
		>
			<h2 className={"PlaywriterBrowserConnection-title" satisfies PlaywriterBrowserConnection_ClassNames}>
				Connect my browser
			</h2>
			<p className={"PlaywriterBrowserConnection-text" satisfies PlaywriterBrowserConnection_ClassNames}>
				Free. Your agent can use the sites you are logged in to. Keep your computer and browser open.
			</p>
			<p ref={statusRef} tabIndex={-1} role="status">
				{connection === undefined || available === undefined
					? "Checking connection…"
					: connection
						? CONNECTION_LABELS[connection.state]
						: "Not connected"}
			</p>
			{connection?.target && (
				<div className={"PlaywriterBrowserConnection-target" satisfies PlaywriterBrowserConnection_ClassNames}>
					<strong>{connection.target.title || "Shared tab"}</strong>
					<span>{connection.target.url}</span>
				</div>
			)}
			{connection?.pauseReason && (
				<p role="status">
					{PAUSE_REASON_LABELS[connection.pauseReason] ?? "Check the connection, then reconnect if needed."}
				</p>
			)}
			{connection?.target && connection.state !== "needs_confirmation" && !targetSelected && (
				<MyButton
					variant="outline"
					disabled={!canAct}
					onClick={() =>
						void run(() =>
							convex.action(app_convex_api.files_browser.set_browser_choice, {
								membershipId,
								webChoice: {
									provider: "playwriter",
									connectionId: connection.connectionId,
									confirmedTargetHandle: connection.target!.handle,
								},
							}),
						)
					}
				>
					Use this tab for agent
				</MyButton>
			)}
			{connection?.state === "needs_confirmation" && (
				<ul
					className={"PlaywriterBrowserConnection-targets" satisfies PlaywriterBrowserConnection_ClassNames}
					aria-label="Shared tabs"
				>
					{connection.targets.map((target) => (
						<li
							key={target.handle}
							className={"PlaywriterBrowserConnection-target" satisfies PlaywriterBrowserConnection_ClassNames}
						>
							<strong>{target.title || "Shared tab"}</strong>
							<span>{target.url}</span>
							<MyButton
								variant="outline"
								disabled={!canAct}
								onClick={() =>
									void run(() =>
										convex.action(app_convex_api.playwriter_browser.confirm_tab, {
											membershipId,
											connectionId: connection.connectionId,
											targetHandle: target.handle,
										}),
									)
								}
							>
								Use this tab
							</MyButton>
						</li>
					))}
				</ul>
			)}
			{live && connection ? (
				<div className={"PlaywriterBrowserConnection-actions" satisfies PlaywriterBrowserConnection_ClassNames}>
					{canResume ? (
						<MyButton
							variant="outline"
							disabled={!canAct}
							onClick={() =>
								void run(() =>
									convex.action(app_convex_api.playwriter_browser.resume_connection, {
										membershipId,
										connectionId: connection.connectionId,
										connectionGeneration: connection.connectionGeneration,
										controlRevision: connection.controlRevision,
									}),
								)
							}
						>
							Resume
						</MyButton>
					) : (
						<MyButton
							variant="outline"
							disabled={!canAct || (connection.state !== "ready" && connection.state !== "running")}
							onClick={() =>
								void run(() =>
									convex.action(app_convex_api.playwriter_browser.pause_connection, {
										membershipId,
										connectionId: connection.connectionId,
									}),
								)
							}
						>
							Pause
						</MyButton>
					)}
					<MyButton
						variant="outline"
						disabled={!canAct}
						onClick={() =>
							void run(() =>
								convex.action(app_convex_api.playwriter_browser.reconnect_connection, {
									membershipId,
									connectionId: connection.connectionId,
								}),
							)
						}
					>
						Reconnect
					</MyButton>
					<MyButton
						variant="ghost"
						disabled={pending}
						onClick={() =>
							void run(() =>
								convex.action(app_convex_api.playwriter_browser.refresh_connection_status, {
									membershipId,
									connectionId: connection.connectionId,
								}),
							)
						}
					>
						Refresh status
					</MyButton>
					<MyButton
						variant="outline_destructive"
						disabled={pending || connection.state === "closing"}
						onClick={() =>
							void run(() =>
								convex.action(app_convex_api.playwriter_browser.disconnect_connection, {
									membershipId,
									connectionId: connection.connectionId,
								}),
							)
						}
					>
						Disconnect
					</MyButton>
				</div>
			) : available?.enabled ? (
				<form
					className={"PlaywriterBrowserConnection-form" satisfies PlaywriterBrowserConnection_ClassNames}
					onSubmit={handleConnect}
				>
					<p className={"PlaywriterBrowserConnection-text" satisfies PlaywriterBrowserConnection_ClassNames}>
						Install the{" "}
						<a href="https://playwriter.dev" target="_blank" rel="noreferrer">
							Playwriter extension
						</a>
						. Open Remote control on the tab you want to share, then paste its ID here.
					</p>
					<MyInput layout="stacked">
						<MyInputLabel>Share ID or Remote control link</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								ref={shareRef}
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={share}
								disabled={pending}
								onChange={(event) => setShare(event.currentTarget.value)}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>
					<MyButton type="submit" variant="default" disabled={pending || share.trim() === ""} aria-busy={pending}>
						{pending ? "Connecting…" : "Connect"}
					</MyButton>
				</form>
			) : available !== undefined ? (
				<p>This browser connection is not available in this workspace.</p>
			) : null}
			{error && (
				<p
					className={"PlaywriterBrowserConnection-error" satisfies PlaywriterBrowserConnection_ClassNames}
					role="alert"
				>
					{error}
				</p>
			)}
		</section>
	);
});
