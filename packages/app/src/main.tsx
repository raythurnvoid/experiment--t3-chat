import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { app_convex } from "./lib/app-convex-client.ts";
import { app_router } from "./lib/app-router.ts";
import { ClerkProvider } from "@clerk/clerk-react";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { AppToaster } from "./components/app-toaster.tsx";
import { ConvexProviderWithAuth } from "convex/react";
import { AppAuthProvider } from "./components/app-auth.tsx";
import { AppHotkeysProvider } from "./components/app-hotkeys.tsx";
import type { AppElementId } from "./lib/dom-utils.ts";
import { app_qa_install } from "./lib/app-qa.ts";
import { app_scrollbar_install } from "./lib/app-scrollbar.ts";

app_qa_install();
app_scrollbar_install();

// Open the Convex websocket now. The client opens it only on first use, which comes after the auth
// bootstrap (Clerk token, then resolve-user). Then the ~300 ms connection setup waits for that too.
// The socket sends no query and stays unauthenticated until `ConvexProviderWithAuth` sets the token.
app_convex.connectionState();

// Import your Publishable Key
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
	throw new Error("Missing Publishable Key");
}

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

createRoot(document.getElementById("root" satisfies AppElementId)!).render(
	<StrictMode>
		<ThemeProvider>
			<AppHotkeysProvider>
				<ClerkProvider publishableKey={PUBLISHABLE_KEY} clerkJSVersion={CLERK_JS_VERSION} afterSignOutUrl="/">
					<AppAuthProvider>
						<ConvexProviderWithAuth client={app_convex} useAuth={AppAuthProvider.useConvexAuth}>
							<RouterProvider router={app_router()} />
						</ConvexProviderWithAuth>
					</AppAuthProvider>
				</ClerkProvider>
			</AppHotkeysProvider>
			<AppToaster />
		</ThemeProvider>
	</StrictMode>,
);
