import "./file-editor-sidebar-pending-strip.css";
import { ChevronRight, FileDiff } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Lives here instead of file-editor-sidebar.tsx so the strip, the tab badge, and the sidebar
 * tabs can all import it without an import cycle (sidebar -> strip, agent -> strip).
 */
export const FILE_EDITOR_SIDEBAR_TAB_ID_PENDING = "app_file_editor_sidebar_tabs_pending" satisfies AppElementId;

/**
 * Count of the user's pending updates in the workspace; 0 while the query loads.
 * `threadId === undefined` keeps the workspace-wide count; any other value (including `null`,
 * the "New chat" state) counts only the docs whose `threadIds` contributor set includes it, so
 * a chat with no persisted thread matches nothing. An optimistic (not yet swapped) thread id
 * also matches nothing — right after a new chat's first message the server may already have
 * stamped writes with the persisted id; the strip catches up once the id swap lands reactively.
 */
function useFilesPendingUpdatesCount(threadId?: string | null) {
	const { membershipId } = AppTenantProvider.useContext();
	const pendingUpdates = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, { membershipId });
	if (!pendingUpdates) {
		return 0;
	}
	if (threadId === undefined) {
		return pendingUpdates.length;
	}
	return pendingUpdates.filter((pendingUpdate) => pendingUpdate.threadIds?.some((id) => id === threadId)).length;
}

/**
 * The chat scope says "from this chat" because the count is files this chat TOUCHED — the diff
 * behind each row is the combined pending state, which other chats may have contributed to.
 */
function files_pending_strip_label(count: number, scope: "workspace" | "chat") {
	const noun = count === 1 ? "pending file change" : "pending file changes";
	return scope === "chat" ? `${noun} from this chat` : noun;
}

// #region strip
export type FileEditorSidebarPendingStrip_ClassNames =
	| "FileEditorSidebarPendingStrip"
	| "FileEditorSidebarPendingStrip-leaving"
	| "FileEditorSidebarPendingStrip-live"
	| "FileEditorSidebarPendingStrip-icon"
	| "FileEditorSidebarPendingStrip-count"
	| "FileEditorSidebarPendingStrip-label"
	| "FileEditorSidebarPendingStrip-review"
	| "FileEditorSidebarPendingStrip-review-chevron";

export type FileEditorSidebarPendingStrip_Props = {
	/**
	 * Persisted id of the open chat thread, or `null` when the chat has no persisted thread yet
	 * (the "New chat" tab) — both are chat scope, and `null` matches nothing. Omit the prop
	 * entirely for the user's workspace-wide count.
	 */
	threadId?: string | null;
};

/**
 * One-line notification pinned above the chat composer while pending file changes exist.
 * The whole row is a single button: clicking switches the sidebar to the Pending changes tab.
 * Unmounted at count 0; never dismissable (it represents persistent review state).
 */
export const FileEditorSidebarPendingStrip = memo(function FileEditorSidebarPendingStrip(
	props: FileEditorSidebarPendingStrip_Props,
) {
	const { threadId } = props;
	const labelScope = threadId === undefined ? "workspace" : "chat";
	const count = useFilesPendingUpdatesCount(threadId);

	// Keep the last non-zero count rendered for 150ms after count drops to 0 so the strip can
	// play its disappear animation before unmounting (CSS alone cannot animate an unmount).
	const [renderedCount, setRenderedCount] = useState(count);

	useEffect(() => {
		if (count > 0) {
			setRenderedCount(count);
			return;
		}

		const timeout = setTimeout(() => {
			setRenderedCount(0);
		}, 150);
		return () => clearTimeout(timeout);
	}, [count]);

	const isLeaving = count === 0 && renderedCount > 0;
	const displayCount = count > 0 ? count : renderedCount;

	const handleClick = useFn(() => {
		app_local_storage_set_value("app_state::files_last_tab", FILE_EDITOR_SIDEBAR_TAB_ID_PENDING);
		// Switching tabs hides the panel that contains this button, which would drop focus to
		// <body>; hand focus to the now-selected tab instead.
		document.getElementById(FILE_EDITOR_SIDEBAR_TAB_ID_PENDING)?.focus();
	});

	return (
		<>
			{/* Always mounted so screen readers announce 0 -> N count transitions reliably. */}
			<span
				className={cn(
					"FileEditorSidebarPendingStrip-live" satisfies FileEditorSidebarPendingStrip_ClassNames,
					"sr-only",
				)}
				role="status"
				aria-live="polite"
			>
				{count > 0 ? `${count} ${files_pending_strip_label(count, labelScope)}` : ""}
			</span>
			{displayCount > 0 ? (
				<button
					type="button"
					className={cn(
						"FileEditorSidebarPendingStrip" satisfies FileEditorSidebarPendingStrip_ClassNames,
						isLeaving && ("FileEditorSidebarPendingStrip-leaving" satisfies FileEditorSidebarPendingStrip_ClassNames),
					)}
					aria-label={`${displayCount} ${files_pending_strip_label(displayCount, labelScope)}, review`}
					onClick={handleClick}
				>
					<FileDiff
						aria-hidden
						className={cn("FileEditorSidebarPendingStrip-icon" satisfies FileEditorSidebarPendingStrip_ClassNames)}
					/>
					<span
						className={cn("FileEditorSidebarPendingStrip-count" satisfies FileEditorSidebarPendingStrip_ClassNames)}
					>
						{displayCount}
					</span>
					<span
						className={cn("FileEditorSidebarPendingStrip-label" satisfies FileEditorSidebarPendingStrip_ClassNames)}
					>
						{files_pending_strip_label(displayCount, labelScope)}
					</span>
					<span
						className={cn("FileEditorSidebarPendingStrip-review" satisfies FileEditorSidebarPendingStrip_ClassNames)}
					>
						Review
						<ChevronRight
							aria-hidden
							className={cn(
								"FileEditorSidebarPendingStrip-review-chevron" satisfies FileEditorSidebarPendingStrip_ClassNames,
							)}
						/>
					</span>
				</button>
			) : null}
		</>
	);
});
// #endregion strip

// #region tab badge
type FileEditorSidebarPendingTabBadge_ClassNames = "FileEditorSidebarPendingTabBadge";

/** Amber count pill for the "Pending changes" tab label. Hidden at count 0. */
export const FileEditorSidebarPendingTabBadge = memo(function FileEditorSidebarPendingTabBadge() {
	const count = useFilesPendingUpdatesCount();

	if (count === 0) {
		return null;
	}

	return (
		<span className={cn("FileEditorSidebarPendingTabBadge" satisfies FileEditorSidebarPendingTabBadge_ClassNames)}>
			{count}
		</span>
	);
});
// #endregion tab badge

// The NODE_ENV check comes first so client builds erase this block; `import.meta.vitest` is
// only defined when vitest runs this file.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("files_pending_strip_label", () => {
		test("uses the singular label only for exactly one change", () => {
			expect(files_pending_strip_label(1, "workspace")).toBe("pending file change");
			expect(files_pending_strip_label(0, "workspace")).toBe("pending file changes");
			expect(files_pending_strip_label(2, "workspace")).toBe("pending file changes");
			expect(files_pending_strip_label(5, "workspace")).toBe("pending file changes");
		});

		test("appends the chat qualifier in the chat scope", () => {
			expect(files_pending_strip_label(1, "chat")).toBe("pending file change from this chat");
			expect(files_pending_strip_label(3, "chat")).toBe("pending file changes from this chat");
		});
	});
}
