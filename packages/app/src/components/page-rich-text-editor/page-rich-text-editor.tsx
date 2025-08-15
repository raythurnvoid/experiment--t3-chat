import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { useAuth } from "../../lib/auth";
import { app_fetch_ai_docs_liveblocks_auth } from "../../lib/fetch";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat";
import { RichTextDocEditor } from "./editor";

export interface PageRichTextEditor_Props {
	pageId: string | null | undefined;
}

function ai_docs_create_liveblocks_room_id(orgId: string, projectId: string, docId: string) {
	return `${orgId}:${projectId}:${docId}`;
}

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

export function PageRichTextEditor(props: PageRichTextEditor_Props) {
	const { pageId } = props;
	const auth = useAuth();

	if (!pageId) {
		return <div>No document selected</div>;
	}

	const roomId = ai_docs_create_liveblocks_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, pageId);

	return (
		<LiveblocksProvider
			authEndpoint={async (room) => {
				const result = await app_fetch_ai_docs_liveblocks_auth({
					input: { room },
					auth: auth.isAuthenticated,
				});

				if (result.ok) {
					return result.ok.payload;
				} else {
					throw new Error(`Failed to authenticate: ${result.bad.message}`);
				}
			}}
			resolveUsers={async ({ userIds }: { userIds: string[] }) => {
				return userIds.map((id: string) => ({
					id,
					name: "Development User",
					avatar: "https://via.placeholder.com/32",
				}));
			}}
		>
			<RoomProvider id={roomId}>
				<ClientSideSuspense fallback={<LoadingEditor />}>
					<div className="h-full w-full">
						<RichTextDocEditor doc_id={pageId} />
					</div>
				</ClientSideSuspense>
			</RoomProvider>
		</LiveblocksProvider>
	);
}
