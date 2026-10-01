import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { app_convex } from "./lib/app-convex-client.ts";
import { app_router } from "./lib/app-router.ts";
import { ClerkProvider } from "@clerk/clerk-react";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { AppToaster } from "./components/app-toaster.tsx";
import { ConvexProvider, ConvexProviderWithAuth } from "convex/react";
import { AppAuthProvider } from "./components/app-auth.tsx";
import { AppHotkeysProvider } from "./components/app-hotkeys.tsx";
import type { AppElementId } from "./lib/dom-utils.ts";
import { app_qa_install } from "./lib/app-qa.ts";
import { app_scrollbar_install } from "./lib/app-scrollbar.ts";
import { url_is_share_path } from "./lib/urls.ts";

app_qa_install();
app_scrollbar_install();

// Open the Convex websocket now. The client opens it only on first use, which comes after the auth
// bootstrap (Clerk token, then resolve-user). Then the ~300 ms connection setup waits for that too.
// The socket sends no query and stays unauthenticated until `ConvexProviderWithAuth` sets the token.
app_convex.connectionState();

// Register the router instance for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof app_router>;
	}
}

// Pin the exact Clerk script version. With a range like `5`, Clerk's server first redirects to the exact
// version, which adds about 190 ms to every page load. Update this by hand when you upgrade
// `@clerk/clerk-react`, and check that the new pair works together.
const CLERK_JS_VERSION = "5.127.2";

const router = app_router();
const root_element = document.getElementById("root" satisfies AppElementId)!;

// The public share page loads without sign-in. Skip Clerk, app auth, and hotkeys there, so a visitor
// makes no auth request and gets no anonymous account. The Convex client stays unauthenticated.
// Moving between the share page and the app always loads a new document, so this choice holds.
if (url_is_share_path(router.state.location.pathname)) {
	// By default React logs every error, even one an error boundary caught, with its message. A share page
	// error can hold the token or the shared text, so log only a fixed line.
	const logShareError = () => console.error("[main.renderSharePage] Share page error");
	const root = createRoot(root_element, {
		onCaughtError: logShareError,
		onUncaughtError: logShareError,
		onRecoverableError: logShareError,
	});
	root.render(
		<StrictMode>
			<ThemeProvider>
				<ConvexProvider client={app_convex}>
					<RouterProvider router={router} />
				</ConvexProvider>
				<AppToaster />
			</ThemeProvider>
		</StrictMode>,
	);
} else {
	const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
	if (!publishableKey) {
		throw new Error("Missing Publishable Key");
	}

	// Warm up the Clerk connection. These hints live here, not in `index.html`, so the public share
	// page never contacts Clerk.
	const clerkHost = import.meta.env.VITE_CLERK_FRONTEND_API_HOST as string | undefined;
	if (clerkHost) {
		const dnsPrefetch = document.createElement("link");
		dnsPrefetch.rel = "dns-prefetch";
		dnsPrefetch.href = `//${clerkHost}`;
		const preconnect = document.createElement("link");
		preconnect.rel = "preconnect";
		preconnect.href = `https://${clerkHost}`;
		preconnect.crossOrigin = "";
		document.head.append(dnsPrefetch, preconnect);
	}

	const root = createRoot(root_element);
	root.render(
		<StrictMode>
			<ThemeProvider>
				<AppHotkeysProvider>
					<ClerkProvider publishableKey={publishableKey} clerkJSVersion={CLERK_JS_VERSION} afterSignOutUrl="/">
						<AppAuthProvider>
							<ConvexProviderWithAuth client={app_convex} useAuth={AppAuthProvider.useConvexAuth}>
								<RouterProvider router={router} />
							</ConvexProviderWithAuth>
						</AppAuthProvider>
					</ClerkProvider>
				</AppHotkeysProvider>
				<AppToaster />
			</ThemeProvider>
		</StrictMode>,
	);
}
