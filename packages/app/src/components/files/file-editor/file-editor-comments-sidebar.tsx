import "./file-editor-comments-sidebar.css";
import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { ChannelsPosts } from "@/components/channels/channels-posts.tsx";
import { ChannelsConversationPane } from "@/components/channels/channels-conversation.tsx";
import { ChannelsPaneHeader } from "@/components/channels/channels-pane-header.tsx";
import { useChannelsMentionPeople, useChannelsPeople } from "@/components/channels/channels-people.ts";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { url_path_messages } from "@/lib/urls.ts";
import { useGlobalCustomEvent } from "@/lib/global-event.tsx";
import type { file_quotes_Quote } from "../../../../shared/file-quotes.ts";

type FileEditorCommentsSidebar_ClassNames =
	| "FileEditorCommentsSidebar"
	| "FileEditorCommentsSidebar-header"
	| "FileEditorCommentsSidebar-thread";

export function FileEditorCommentsSidebar(props: {
	fileNodeId: app_convex_Id<"files_nodes">;
	threadIds: readonly string[];
	hideMarkedPosts?: boolean;
	children?: ReactNode;
}) {
	const { fileNodeId, threadIds, hideMarkedPosts, children } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const file = useQuery(app_convex_api.files_nodes.get_file_node_for_membership, { membershipId, fileNodeId });
	const ready = useQuery(app_convex_api.channels_messages.get_attachable_files, {
		membershipId,
		fileNodeIds: [fileNodeId],
	});
	const channelId = useQuery(app_convex_api.channels.get_file_channel, { membershipId, fileNodeId });
	const channel = useQuery(app_convex_api.channels.get_channel, channelId ? { membershipId, channelId } : "skip");
	const state = useQuery(app_convex_api.channels.get_channel_state, channelId ? { membershipId, channelId } : "skip");
	const { people } = useChannelsPeople();
	const mentionItems = useChannelsMentionPeople({ fileNodeId }, people);
	const [rootId, setRootId] = useState<app_convex_Id<"channels_messages"> | null>(null);
	const [quoteRequest, setQuoteRequest] = useState<file_quotes_Quote | null>(null);
	useGlobalCustomEvent("files::quote_selection", ({ detail }) => {
		if (detail.membershipId === membershipId && detail.target === "comments" && detail.quote.fileNodeId === fileNodeId)
			setQuoteRequest(detail.quote);
	});
	const thread = useQuery(
		app_convex_api.channels_messages.get_thread_by_root,
		rootId ? { membershipId, rootMessageId: rootId } : "skip",
	);
	const canPost =
		!!file &&
		file.writeBlockedReason !== "permission" &&
		file.archiveOperationId === null &&
		(ready?.includes(fileNodeId) ?? false);
	const follow = () => {
		if (!channelId) return;
		app_convex
			.mutation(state?.member ? app_convex_api.channels.leave_channel : app_convex_api.channels.join_channel, {
				membershipId,
				channelId,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[FileEditorCommentsSidebar.follow] Failed to change follow", { error });
				toast.error("Could not change follow");
			});
	};
	return (
		<aside
			className={"FileEditorCommentsSidebar" satisfies FileEditorCommentsSidebar_ClassNames}
			aria-label="File comments"
		>
			<header className={"FileEditorCommentsSidebar-header" satisfies FileEditorCommentsSidebar_ClassNames}>
				{state?.unread && <span aria-label="Unread comments">●</span>}
				<MyButton onClick={follow} disabled={!channelId} aria-pressed={!!state?.member}>
					{state?.member ? "Unfollow comments" : "Follow comments"}
				</MyButton>
				{channelId && (
					<a
						className={"MyButton" satisfies MyButton_ClassNames}
						href={`${url_path_messages({ organizationName, workspaceName })}/${channelId}`}
					>
						Open in Messages
					</a>
				)}
			</header>
			{rootId ? (
				<>
					<div className={"FileEditorCommentsSidebar-thread" satisfies FileEditorCommentsSidebar_ClassNames}>
						{channel && thread?.root.message.channelId === channel.channel._id ? (
							<ChannelsConversationPane
								channel={channel}
								name={file?.name ?? "File comments"}
								root={thread.root}
								readSequence={0}
								mentionItems={mentionItems}
								quoteRequest={quoteRequest}
								onQuoteInserted={() => setQuoteRequest(null)}
								jumpMessageId={undefined}
								resolvable={true}
								onClose={() => setRootId(null)}
								back
								backLabel="Back to comments"
								onThread={setRootId}
								onJump={(id, root) => setRootId(root ?? id)}
							/>
						) : (
							<>
								<ChannelsPaneHeader title="Thread" onBack={() => setRootId(null)} backLabel="Back to comments" />
								<p>{thread === undefined ? "Loading comment…" : "Comment not found"}</p>
							</>
						)}
					</div>
				</>
			) : (
				<>
					{file === undefined || channelId === undefined ? (
						<p>Loading comments…</p>
					) : file ? (
						<ChannelsPosts
							key={fileNodeId}
							channelId={channelId}
							fileNodeId={fileNodeId}
							state={state}
							canPost={canPost}
							mentionItems={mentionItems}
							quoteRequest={quoteRequest}
							onQuoteInserted={() => setQuoteRequest(null)}
							markThreadIds={threadIds}
							hideMarkedPosts={hideMarkedPosts}
							onThread={setRootId}
						/>
					) : (
						<p>File not found</p>
					)}
					{children}
				</>
			)}
		</aside>
	);
}
