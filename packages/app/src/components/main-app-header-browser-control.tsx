import "./main-app-header-browser-control.css";

import { BrowserSettings } from "@/components/browser/browser-settings.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useConvex, useQuery } from "convex/react";
import { memo, useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

const MainAppHeaderCloudBrowserControl = memo(function MainAppHeaderCloudBrowserControl() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const convex = useConvex();
	const navigate = useNavigate();
	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId, mode: "web" });
	const [pending, setPending] = useState(false);
	const paused = session?.control === "human" || session?.control === "pausing";
	const run = (end: boolean) => {
		if (!session) return;
		setPending(true);
		return (async (/* iife */) => {
			const result = end
				? await convex.action(app_convex_api.files_browser.end_browser, { membershipId, sessionId: session.sessionId })
				: await convex.action(app_convex_api.files_browser.resume_browser_agent, {
						membershipId,
						sessionId: session.sessionId,
						controlGen: session.controlGen,
					});
			if (result._nay) toast.error(result._nay.message);
		})()
			.catch(() => {
				// Browser errors may contain viewer grants. Show only this fixed message.
				toast.error("Could not change the browser. Try again.");
			})
			.finally(() => setPending(false));
	};
	return (
		<>
			<span role="status">Cloud browser{session ? (paused ? " · Paused" : " · Running") : ""}</span>
			<MyButton
				variant="ghost"
				onClick={() =>
					void navigate({
						to: "/w/$organizationName/$workspaceName/browser",
						params: { organizationName, workspaceName },
					})
				}
			>
				Open Browser
			</MyButton>
			{paused && (
				<MyButton variant="ghost" disabled={pending} onClick={() => void run(false)}>
					Resume
				</MyButton>
			)}
			{session && (
				<MyButton variant="ghost_destructive" disabled={pending} onClick={() => void run(true)}>
					End
				</MyButton>
			)}
		</>
	);
});

const MainAppHeaderPlaywriterBrowserControl = memo(function MainAppHeaderPlaywriterBrowserControl() {
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const connection = useQuery(app_convex_api.playwriter_browser.current_connection, { membershipId });
	const [pending, setPending] = useState(false);
	const handleDisconnect = () => {
		if (!connection) return;
		setPending(true);
		return (async (/* iife */) => {
			const result = await convex.action(app_convex_api.playwriter_browser.disconnect_connection, {
				membershipId,
				connectionId: connection.connectionId,
			});
			if (result._nay) toast.error(result._nay.message);
		})()
			.catch(() => {
				// Remote errors may contain the saved share. Show only this fixed message.
				toast.error("Could not disconnect. Try again.");
			})
			.finally(() => setPending(false));
	};
	return (
		<>
			<span role="status">
				My browser
				{connection
					? ` · ${connection.state === "ready" ? "Connected" : connection.state === "running" ? "Running" : connection.state === "paused" ? "Paused" : connection.state === "needs_confirmation" ? "Choose a tab" : connection.state.replaceAll("_", " ")}`
					: " · Not connected"}
			</span>
			{connection && connection.state !== "closed" && (
				<MyButton
					variant="ghost_destructive"
					disabled={pending || connection.state === "closing"}
					onClick={() => void handleDisconnect()}
				>
					Disconnect
				</MyButton>
			)}
		</>
	);
});

type MainAppHeaderBrowserControl_ClassNames = "MainAppHeaderBrowserControl";

type MainAppHeaderBrowserControl_CustomAttributes = {
	"data-agent-access": "on" | "off";
};

/**
 * Workspace controls stay available when the Browser and Files views are hidden.
 */
export const MainAppHeaderBrowserControl = memo(function MainAppHeaderBrowserControl() {
	const { membershipId } = AppTenantProvider.useContext();
	const preferences = useQuery(app_convex_api.files_browser.current_browser_preferences, { membershipId });
	const cloudAvailable = useQuery(app_convex_api.files_browser.web_browser_available, { membershipId });
	const remoteAvailable = useQuery(app_convex_api.playwriter_browser.remote_browser_available, { membershipId });
	const [settingsOpen, setSettingsOpen] = useState(false);
	if (!cloudAvailable?.enabled && !remoteAvailable?.enabled && !remoteAvailable?.hasSavedConnection) return null;
	return (
		<div
			className={"MainAppHeaderBrowserControl" satisfies MainAppHeaderBrowserControl_ClassNames}
			{...({
				"data-agent-access": preferences?.webAgentAccess ? "on" : "off",
			} satisfies MainAppHeaderBrowserControl_CustomAttributes)}
		>
			{cloudAvailable?.enabled && <MainAppHeaderCloudBrowserControl />}
			{(remoteAvailable?.enabled || remoteAvailable?.hasSavedConnection) && <MainAppHeaderPlaywriterBrowserControl />}
			{preferences && !preferences.webAgentAccess && <span>Agent access off</span>}
			<MyButton variant="ghost" onClick={() => setSettingsOpen(true)}>
				Browser settings
			</MyButton>
			{settingsOpen && <BrowserSettings onClose={() => setSettingsOpen(false)} />}
		</div>
	);
});
