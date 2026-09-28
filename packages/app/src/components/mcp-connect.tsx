import "./mcp-connect.css";

import { useLocation } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { LogIn } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionArgs } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { ai_chat_McpTarget } from "../../shared/ai-chat-files.ts";

type McpConnect_ClassNames = "McpConnect" | "McpConnect-text";

type McpConnect_Props = {
	/**
	 * Ids may be plain strings from the chat history.
	 */
	target: ai_chat_McpTarget;
	/**
	 * The button text, such as "Connect" or "Reconnect with more access".
	 */
	label: string;
	/**
	 * The server name for the button's accessible name.
	 */
	serverLabel: string;
};

/**
 * Start an MCP sign-in. Before the browser leaves Press, show the sign-in server's host and wait for
 * the member to continue, so they know where they are about to type a password.
 */
export const McpConnect = memo(function McpConnect(props: McpConnect_Props) {
	const { target, label, serverLabel } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const location = useLocation();
	const canConnect = useQuery(app_convex_api.plugins_mcp_oauth.can_connect, { membershipId, target });
	const [isStarting, setIsStarting] = useState(false);
	const [signIn, setSignIn] = useState<{ authorizationUrl: string; authorizationHost: string } | null>(null);

	const handleConnect = useFn(() => {
		setIsStarting(true);
		app_convex
			.action(app_convex_api.plugins_mcp_oauth.start, {
				membershipId,
				// `can_connect` already found this target, so its ids are real ids. `start` checks them again.
				target: target as app_convex_FunctionArgs<typeof app_convex_api.plugins_mcp_oauth.start>["target"],
				// The callback page opens this path after the sign-in.
				returnPath: `${location.pathname}${location.searchStr}`,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}
				// Only ever send the member to an https sign-in page.
				if (new URL(result._yay.authorizationUrl).protocol !== "https:") {
					toast.error("This sign-in server does not use https, so Press cannot open it.");
					return;
				}
				setSignIn(result._yay);
			})
			.catch((error: unknown) => {
				console.error("[McpConnect.handleConnect] Unexpected async error", { error, target });
				toast.error("Could not start the sign-in. Try again.");
			})
			.finally(() => {
				setIsStarting(false);
			});
	});

	const handleContinue = useFn(() => {
		if (signIn) {
			window.location.assign(signIn.authorizationUrl);
		}
	});

	if (canConnect === undefined) {
		return null;
	}

	if (!canConnect) {
		return (
			<p className={"McpConnect-text" satisfies McpConnect_ClassNames} role="status">
				This server was removed
			</p>
		);
	}

	return (
		<div className={"McpConnect" satisfies McpConnect_ClassNames}>
			{signIn ? (
				<>
					<p className={"McpConnect-text" satisfies McpConnect_ClassNames} role="status">
						You will sign in at {signIn.authorizationHost}
					</p>
					<MyButton variant="outline" onClick={() => setSignIn(null)}>
						Cancel
					</MyButton>
					<MyButton aria-label={`Continue to sign in for ${serverLabel}`} onClick={handleContinue}>
						<LogIn aria-hidden />
						Continue
					</MyButton>
				</>
			) : (
				<MyButton aria-label={`${label} ${serverLabel}`} disabled={isStarting} onClick={handleConnect}>
					<LogIn aria-hidden />
					{label}
				</MyButton>
			)}
		</div>
	);
});
