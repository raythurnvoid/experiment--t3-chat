import "./app.css";
// Import the generated route tree
import { routeTree } from "./routeTree.gen.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { app_convex } from "./lib/app-convex-client.ts";
import { ClerkProvider } from "@clerk/clerk-react";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { ConvexProviderWithAuth } from "convex/react";
import { AppAuthProvider } from "./components/app-auth.tsx";

// Create a new router instance
const router = createRouter({
	routeTree,
	basepath: import.meta.env.BASE_URL,
});

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
				<AppAuthProvider>
					<ConvexProviderWithAuth client={app_convex} useAuth={AppAuthProvider.useAuth}>
						<RouterProvider router={router} />
					</ConvexProviderWithAuth>
				</AppAuthProvider>
			</ClerkProvider>
		</ThemeProvider>
	</StrictMode>,
);
