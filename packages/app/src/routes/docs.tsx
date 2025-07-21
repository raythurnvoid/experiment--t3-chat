import React, { Suspense } from "react";
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from "@liveblocks/react/suspense";

export const Route = createFileRoute({
	component: Docs,
});

// Get Convex HTTP URL for HTTP endpoints
const CONVEX_HTTP_URL = import.meta.env.VITE_CONVEX_HTTP_URL;

if (!CONVEX_HTTP_URL) {
	throw new Error("`VITE_CONVEX_HTTP_URL` env var is not set");
}

// Loading fallback component
function LoadingEditor() {
	return (
		<div className="relative flex h-full flex-col bg-background">
			<div className="flex h-[60px] items-center justify-end border-b border-border/80 bg-background px-4">
				<div className="text-sm font-medium text-foreground">Loading AI Document Editor...</div>
			</div>
			<div className="border-b border-border/80 bg-background">
				<div className="h-12 animate-pulse bg-muted/50"></div>
			</div>
			<div className="flex-1 p-8">
				<div className="mx-auto max-w-4xl animate-pulse rounded-lg bg-muted/30 p-8">
					<div className="mb-4 h-8 w-3/4 rounded bg-muted/50"></div>
					<div className="mb-2 h-4 rounded bg-muted/50"></div>
					<div className="mb-2 h-4 w-5/6 rounded bg-muted/50"></div>
					<div className="h-4 w-4/5 rounded bg-muted/50"></div>
				</div>
			</div>
		</div>
	);
}

// Dynamic import for the Tiptap editor with error boundary
const TiptapEditor = React.lazy(() =>
	import("../components/ai-docs-temp/editor").catch((e) => {
		console.error("Error loading TiptapEditor:", e);

		return {
			default: () => (
				<div className="flex h-full items-center justify-center">
					<div className="text-center">
						<h3 className="mb-2 text-lg font-medium text-foreground">Editor Loading Error</h3>
						<p className="text-sm text-muted-foreground">Please refresh the page to try again.</p>
					</div>
				</div>
			),
		};
	}),
);

function Docs() {
	return (
		<div className="h-full w-full overflow-hidden">
			<LiveblocksProvider
				authEndpoint={`${CONVEX_HTTP_URL}/api/ai-docs/liveblocks-auth`}
				resolveUsers={async ({ userIds }: { userIds: string[] }) => {
					// Mock user resolution for development
					return userIds.map((id: string) => ({
						id,
						name: "Development User",
						avatar: "https://via.placeholder.com/32",
					}));
				}}
			>
				<RoomProvider id="ai-docs-temp-room">
					<ClientSideSuspense fallback={<LoadingEditor />}>
						<div className="h-full w-full">
							<Suspense fallback={<LoadingEditor />}>
								<TiptapEditor />
							</Suspense>
						</div>
					</ClientSideSuspense>
				</RoomProvider>
			</LiveblocksProvider>
		</div>
	);
}
