import React, { Suspense } from "react";
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from "@liveblocks/react/suspense";

export const Route = createFileRoute({
	component: Docs,
});

// Loading fallback component
function LoadingEditor() {
	return (
		<div className="bg-background relative flex h-full flex-col">
			<div className="border-border/80 bg-background flex h-[60px] items-center justify-end border-b px-4">
				<div className="text-foreground text-sm font-medium">Loading AI Document Editor...</div>
			</div>
			<div className="border-border/80 bg-background border-b">
				<div className="bg-muted/50 h-12 animate-pulse"></div>
			</div>
			<div className="flex-1 p-4">
				<div className="bg-muted/30 h-32 animate-pulse rounded"></div>
			</div>
		</div>
	)
}

// Dynamic import for the Tiptap editor with error boundary
const TiptapEditor = React.lazy(() =>
	import("../components/ai-docs-temp/editor").catch(() => ({
		default: () => (
			<div className="flex h-full items-center justify-center">
				<div className="text-center">
					<h3 className="text-foreground mb-2 text-lg font-medium">Editor Loading Error</h3>
					<p className="text-muted-foreground text-sm">Please refresh the page to try again.</p>
				</div>
			</div>
		),
	})),
);

function Docs() {
	return (
		<div className="h-full w-full overflow-hidden">
			<LiveblocksProvider
				authEndpoint={async () => {
					// Mock auth for development
					return {
						token: "mock_token_for_development",
						user: {
							id: "dev_user",
							info: {
								name: "Development User",
								avatar: "https://via.placeholder.com/32",
							},
						},
					}
				}}
				resolveUsers={async ({ userIds }) => {
					// Mock user resolution for development
					return userIds.map((id) => ({
						id,
						name: "Development User",
						avatar: "https://via.placeholder.com/32",
					}))
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
	)
}
