import "./ai-chat-pending-review.css";

import { memo, useEffect, useState } from "react";
import { useQuery } from "convex/react";

import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { FileEditorSidebarPending } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx";
import { FileEditorSidebarPendingStrip } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx";
import { MyModal, MyModalCloseTrigger, MyModalHeader, MyModalHeading, MyModalPopover } from "@/components/my-modal.tsx";

type AiChatPendingReview_ClassNames = "AiChatPendingReview";

type AiChatPendingReview_Props = {
	threadId: string | null;
};

/**
 * Review the agent's pending file changes from the phone chat. A phone has no Files page, so the
 * pending strip opens the Files "Pending changes" panel in a full-screen modal.
 */
export const AiChatPendingReview = memo(function AiChatPendingReview(props: AiChatPendingReview_Props) {
	const { threadId } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [open, setOpen] = useState(false);

	const threadSummary = useQuery(
		app_convex_api.files_pending_list.get_files_pending_updates_summary,
		open && threadId ? { membershipId, listKey: threadId } : "skip",
	);

	const handleReview = useFn(() => {
		setOpen(true);
	});

	// When this chat has no changes left, the panel switches itself to "All changes". Then Accept all
	// would act on other chats. So close the modal instead, because this chat's review is done.
	useEffect(() => {
		if (threadSummary?.count === 0 && !threadSummary.truncated) {
			setOpen(false);
		}
	}, [threadSummary]);

	return (
		<>
			<FileEditorSidebarPendingStrip threadId={threadId} onReview={handleReview} />
			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover className={"AiChatPendingReview" satisfies AiChatPendingReview_ClassNames} unmountOnHide>
					<MyModalHeader>
						<MyModalHeading>Pending changes</MyModalHeading>
					</MyModalHeader>
					{/* The strip opens this modal only for a saved thread, so the id is a real thread id. */}
					<FileEditorSidebarPending
						initialThreadId={(threadId ?? undefined) as app_convex_Id<"ai_chat_threads"> | undefined}
					/>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		</>
	);
});
