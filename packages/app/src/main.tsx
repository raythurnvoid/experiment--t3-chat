import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { app_convex } from "./lib/app-convex-client";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ThemeProvider } from "./components/theme-provider";
import "./app.css";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
const router = createRouter({ routeTree });

// Import your Publishable Key
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
	throw new Error("Missing Publishable Key");
}

// Register the router instance for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ThemeProvider>
			<ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
				<ConvexProviderWithClerk client={app_convex} useAuth={useAuth}>
					<RouterProvider router={router} />
				</ConvexProviderWithClerk>
			</ClerkProvider>
		</ThemeProvider>
	</StrictMode>,
);
