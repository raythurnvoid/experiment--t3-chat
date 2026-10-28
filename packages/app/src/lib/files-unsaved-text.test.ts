import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_unsaved_text_capture,
	files_unsaved_text_discard,
	files_unsaved_text_get_snapshot,
	files_unsaved_text_set_user,
	type files_UnsavedText,
} from "./files-unsaved-text.ts";

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

const draft = {
	userId: "user",
	membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
	target: { kind: "saved", id: "file" as app_convex_Id<"files_nodes"> },
	documentId: "document",
	rootKind: "plain_text",
	text: "unsaved words",
	reason: "read_only",
} satisfies Omit<files_UnsavedText, "id" | "capturedAt">;

beforeEach(() => files_unsaved_text_set_user("user"));
afterEach(() => files_unsaved_text_set_user(null));

describe("files_unsaved_text_capture", () => {
	test("keeps distinct drafts but does not duplicate one refusal and cleanup", () => {
		files_unsaved_text_capture(draft);
		files_unsaved_text_capture(draft);
		files_unsaved_text_capture({ ...draft, text: "new words" });
		files_unsaved_text_capture({ ...draft, documentId: "new document" });
		expect(files_unsaved_text_get_snapshot().map((item) => item.text)).toEqual([
			"unsaved words",
			"new words",
			"unsaved words",
		]);
	});
});

describe("files_unsaved_text_set_user", () => {
	test("clears copies on sign-out and refuses late callbacks from the old user", () => {
		files_unsaved_text_capture(draft);
		files_unsaved_text_set_user(null);
		files_unsaved_text_capture(draft);
		expect(files_unsaved_text_get_snapshot()).toEqual([]);
		files_unsaved_text_set_user("other user");
		files_unsaved_text_capture(draft);
		expect(files_unsaved_text_get_snapshot()).toEqual([]);
	});
});

describe("files_unsaved_text_discard", () => {
	test("keeps the unload warning after the editor queue is gone until the last copy is discarded", () => {
		files_unsaved_text_capture(draft);
		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		files_unsaved_text_discard(files_unsaved_text_get_snapshot()[0]!.id);
		const afterDiscard = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(afterDiscard);
		expect(afterDiscard.defaultPrevented).toBe(false);
	});
});
