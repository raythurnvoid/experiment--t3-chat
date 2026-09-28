import "./callback.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { Logo } from "@/components/logo.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";

/**
 * The script at the top of `index.html` moves the sign-in answer here from the address bar. Keep the
 * two names equal.
 */
const CALLBACK_STORAGE_KEY = "app::mcp_oauth::callback";

/**
 * Send the sign-in answer to Convex once per page load. A second effect run (Strict Mode) reuses the
 * same call, because the answer works only once.
 */
const finish_sign_in = ((/* iife */) => {
	function value() {
		const query = sessionStorage.getItem(CALLBACK_STORAGE_KEY);
		sessionStorage.removeItem(CALLBACK_STORAGE_KEY);
		if (query === null) {
			return Promise.resolve({ kind: "failed" as const, message: "There is no sign-in to finish. Connect again." });
		}

		const params = new URLSearchParams(query);
		return app_convex
			.action(app_convex_api.plugins_mcp_oauth.finish, {
				state: params.get("state") ?? "",
				code: params.get("code"),
				iss: params.get("iss"),
				error: params.get("error"),
			})
			.then((result) =>
				result._nay
					? { kind: "failed" as const, message: result._nay.message }
					: { kind: "done" as const, returnPath: result._yay.returnPath },
			)
			.catch((error: unknown) => {
				console.error("[finish_sign_in] Unexpected async error", { error });
				return { kind: "failed" as const, message: "Could not finish the sign-in. Connect again." };
			});
	}

	let cache: ReturnType<typeof value> | undefined;

	return function finish_sign_in() {
		return (cache ??= value());
	};
})();

type RouteOauthMcpCallback_ClassNames =
	| "RouteOauthMcpCallback"
	| "RouteOauthMcpCallback-panel"
	| "RouteOauthMcpCallback-title"
	| "RouteOauthMcpCallback-description";

const RouteOauthMcpCallback = memo(function RouteOauthMcpCallback() {
	const auth = AppAuthProvider.useAuth();
	const clerk = useClerk();
	const navigate = Route.useNavigate();
	const [failedMessage, setFailedMessage] = useState<string | null>(null);

	// The sign-in belongs to the member who started it. A visitor without an account keeps the answer
	// in sessionStorage until they sign in, because the answer can be used only once.
	const isAnonymous = auth.isAnonymous !== false;

	const handleOpenSignIn = useFn(() => {
		void clerk.openSignIn();
	});

	useEffect(() => {
		if (isAnonymous) {
			return;
		}

		let active = true;
		finish_sign_in()
			.then((result) => {
				if (!active) {
					return;
				}
				if (result.kind === "failed") {
					setFailedMessage(result.message);
					return;
				}

				// `finish` returns a path inside the app, never a full URL.
				navigate({ to: result.returnPath, replace: true }).catch((error: unknown) => {
					console.error("[RouteOauthMcpCallback] Failed to open the return path", { error });
				});
			})
			.catch((error: unknown) => {
				console.error("[RouteOauthMcpCallback] Unexpected async error", { error });
			});
		return () => {
			active = false;
		};
	}, [isAnonymous, navigate]);

	return (
		<main className={"RouteOauthMcpCallback" satisfies RouteOauthMcpCallback_ClassNames} aria-label="MCP sign-in">
			<div className={"RouteOauthMcpCallback-panel" satisfies RouteOauthMcpCallback_ClassNames}>
				<Logo />
				{isAnonymous ? (
					<>
						<h1 className={"RouteOauthMcpCallback-title" satisfies RouteOauthMcpCallback_ClassNames}>
							Log in to finish
						</h1>
						<p className={"RouteOauthMcpCallback-description" satisfies RouteOauthMcpCallback_ClassNames}>
							Log in with the account that started this MCP sign-in.
						</p>
						<MyButton onClick={handleOpenSignIn}>
							<LogIn aria-hidden />
							Log in
						</MyButton>
					</>
				) : failedMessage !== null ? (
					<>
						<h1 className={"RouteOauthMcpCallback-title" satisfies RouteOauthMcpCallback_ClassNames}>Sign-in failed</h1>
						<p role="alert" className={"RouteOauthMcpCallback-description" satisfies RouteOauthMcpCallback_ClassNames}>
							{failedMessage}
						</p>
					</>
				) : (
					<>
						<MySpinner size="24px" color="var(--color-accent-07)" />
						<h1 role="status" className={"RouteOauthMcpCallback-title" satisfies RouteOauthMcpCallback_ClassNames}>
							Finishing sign-in
						</h1>
					</>
				)}
			</div>
		</main>
	);
});

const Route = createFileRoute("/oauth/mcp/callback")({
	component: RouteOauthMcpCallback,
});

export { Route };
