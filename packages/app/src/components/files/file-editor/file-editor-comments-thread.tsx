import "./file-editor-comments-thread.css";
import { useState, type ComponentProps, type Ref } from "react";
import { useQuery } from "convex/react";
import { ChannelsConversationPane } from "@/components/channels/channels-conversation.tsx";
import { ChannelsMessageContent } from "@/components/channels/channels-message.tsx";
import type { ChannelsMessage } from "@/components/channels/channels-message-window.ts";
import type { ChannelsMentionItem } from "@/components/channels/channels-composer-mention.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn } from "@/lib/utils.ts";

type FileEditorCommentsFilterInput_ClassNames = "FileEditorCommentsFilterInput";

export function FileEditorCommentsFilterInput(props: {
	value: string;
	onValueChange: (value: string) => void;
	ariaLabel?: string;
}) {
	return (
		<MyInput className={"FileEditorCommentsFilterInput" satisfies FileEditorCommentsFilterInput_ClassNames}>
			<MyInputBackground />
			<MyInputArea>
				<MyInputControl
					type="search"
					aria-label={props.ariaLabel ?? "Search comments"}
					placeholder="Search comments…"
					value={props.value}
					onChange={(event) => props.onValueChange(event.target.value)}
				/>
			</MyInputArea>
			<MyInputBox />
		</MyInput>
	);
}

FileEditorCommentsFilterInput.filterThreads = (threads: readonly ChannelsMessage[], query: string) => {
	const search = query.trim().toLowerCase();
	if (!search) return [...threads];
	const ids = search.split(/\s+/);
	return threads.filter(
		(thread) =>
			ids.includes(thread.message._id) ||
			thread.message.body.toLowerCase().includes(search) ||
			thread.thread?.title?.toLowerCase().includes(search),
	);
};

type FileEditorCommentsThread_ClassNames =
	| "FileEditorCommentsThread"
	| "FileEditorCommentsThread-active"
	| "FileEditorCommentsThread-summary"
	| "FileEditorCommentsThread-content";

export type FileEditorCommentsThread_Props = {
	ref?: Ref<HTMLDetailsElement>;
	thread: ChannelsMessage;
	open: boolean;
	hidden: boolean;
	mentionItems: readonly ChannelsMentionItem[];
	onToggle?: ComponentProps<"details">["onToggle"];
	onActivate?: () => void;
};

export function FileEditorCommentsThread(props: FileEditorCommentsThread_Props) {
	const { ref, thread, open, hidden, mentionItems, onToggle, onActivate } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [jumpMessageId, setJumpMessageId] = useState<string | undefined>(undefined);
	const channel = useQuery(
		app_convex_api.channels.get_channel,
		open ? { membershipId, channelId: thread.message.channelId } : "skip",
	);
	const pending = thread.thread?.anchor?.confirmedAt === null;
	return (
		<details
			ref={ref}
			className={cn(
				"FileEditorCommentsThread" satisfies FileEditorCommentsThread_ClassNames,
				open && ("FileEditorCommentsThread-active" satisfies FileEditorCommentsThread_ClassNames),
			)}
			open={open}
			hidden={hidden}
			onToggle={(event) => {
				onToggle?.(event);
				if (event.currentTarget.open && !open) onActivate?.();
			}}
		>
			<summary
				className={"FileEditorCommentsThread-summary" satisfies FileEditorCommentsThread_ClassNames}
				aria-label={`Open comment by ${thread.authorName}`}
			>
				<strong>{thread.thread?.title ?? thread.authorName}</strong>
				{!open && <ChannelsMessageContent row={thread} />}
				{pending && <p>Adding comment…</p>}
			</summary>
			{open && !pending && (
				<div className={"FileEditorCommentsThread-content" satisfies FileEditorCommentsThread_ClassNames}>
					{channel ? (
						<ChannelsConversationPane
							channel={channel}
							name="File comments"
							root={thread}
							readSequence={0}
							mentionItems={mentionItems}
							jumpMessageId={jumpMessageId}
							resolvable={true}
							onThread={onActivate ?? (() => {})}
							onJump={setJumpMessageId}
						/>
					) : (
						<p>Loading comment…</p>
					)}
				</div>
			)}
		</details>
	);
}
