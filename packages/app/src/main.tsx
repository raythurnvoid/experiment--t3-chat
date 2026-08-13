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
createRoot(document.getElementById("root" satisfies AppElementId)!).render(
	<StrictMode>
		<ThemeProvider>
			<AppHotkeysProvider>
				<ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
					<AppAuthProvider>
						<ConvexProviderWithAuth client={app_convex} useAuth={AppAuthProvider.useAuth}>
							<RouterProvider router={app_router()} />
						</ConvexProviderWithAuth>
					</AppAuthProvider>
				</ClerkProvider>
			</AppHotkeysProvider>
			<AppToaster />
		</ThemeProvider>
	</StrictMode>,
);
