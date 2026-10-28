import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { app_convex_Id } from "./app-convex-client.ts";
import type { files_PendingTarget, files_YjsRootKind } from "../../shared/files.ts";

export type files_UnsavedText = {
	id: string;
	userId: string;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	target: files_PendingTarget;
	documentId: string;
	rootKind: files_YjsRootKind;
	text: string;
	reason: "read_only" | "permission" | "changed" | "closed";
	capturedAt: number;
};

let currentUserId: string | null = null;
let captures: readonly files_UnsavedText[] = [];
const listeners = new Set<() => void>();

function before_unload(event: BeforeUnloadEvent) {
	if (captures.length > 0) event.preventDefault();
}

function publish(next: readonly files_UnsavedText[]) {
	window.removeEventListener("beforeunload", before_unload);
	captures = next;
	if (captures.length > 0) window.addEventListener("beforeunload", before_unload);
	for (const listener of listeners) listener();
}

/**
 * Auth changes clear all copies, including late callbacks from the previous user's editor.
 */
export function files_unsaved_text_set_user(userId: string | null) {
	if (userId === currentUserId) return;
	currentUserId = userId;
	publish([]);
}

export function files_unsaved_text_capture(args: Omit<files_UnsavedText, "id" | "capturedAt">) {
	if (args.userId !== currentUserId || currentUserId === null) return;
	// A refusal and the subscription cleanup can report the same draft. Distinct drafts stay.
	if (
		captures.some(
			(capture) =>
				capture.userId === args.userId &&
				capture.membershipId === args.membershipId &&
				capture.target.kind === args.target.kind &&
				capture.target.id === args.target.id &&
				capture.documentId === args.documentId &&
				capture.text === args.text,
		)
	)
		return;
	publish([...captures, { ...args, id: crypto.randomUUID(), capturedAt: Date.now() }]);
	toast.warning("Your unsaved text was kept in this tab. Open Unsaved text to copy or download it.");
}

export function files_unsaved_text_discard(id: string) {
	publish(captures.filter((capture) => capture.id !== id));
}

export function files_unsaved_text_get_snapshot() {
	return captures;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useFilesUnsavedText() {
	return useSyncExternalStore(subscribe, files_unsaved_text_get_snapshot);
}
