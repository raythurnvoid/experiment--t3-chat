import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_unsaved_text_capture,
	files_unsaved_text_get_snapshot,
	files_unsaved_text_set_user,
} from "@/lib/files-unsaved-text.ts";
import { FilesUnsavedText } from "./files-unsaved-text.tsx";

const { access, auth, fileNodeMock, downloadMock } = vi.hoisted(() => ({
	access: { node: null as { name: string } | null },
	auth: { userId: "user" },
	fileNodeMock: vi.fn(),
	downloadMock: vi.fn<(args: { blob: Blob; filename: string }) => void>(),
}));
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuth: () => auth },
}));
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: { files_tree: { get_file_node_for_membership: "get_file_node_for_membership" } },
}));
vi.mock("convex/react", () => ({ useQuery: (...args: unknown[]) => fileNodeMock(...args) }));
vi.mock("@/lib/files.ts", () => ({ files_download_blob: downloadMock }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
	files_unsaved_text_set_user("user");
	auth.userId = "user";
	access.node = { name: "notes.md" };
	fileNodeMock.mockImplementation(() => access.node);
	files_unsaved_text_capture({
		userId: "user",
		membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
		target: { kind: "saved", id: "file" as app_convex_Id<"files_nodes"> },
		documentId: "document",
		rootKind: "plain_text",
		text: "my draft",
		reason: "read_only",
	});
});
afterEach(() => {
	cleanup();
	files_unsaved_text_set_user(null);
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

test("keeps selectable text after Files closes, with names checked against current access", async () => {
	const first = render(<FilesUnsavedText />);
	fireEvent.click(screen.getByRole("button", { name: "Unsaved text (1)" }));
	expect((screen.getByRole("textbox", { name: "Unsaved text for notes.md" }) as HTMLTextAreaElement).value).toBe(
		"my draft",
	);
	first.unmount();
	access.node = null;
	render(<FilesUnsavedText />);
	fireEvent.click(screen.getByRole("button", { name: "Unsaved text (1)" }));
	expect(
		(screen.getByRole("textbox", { name: "Unsaved text for Unavailable file" }) as HTMLTextAreaElement).value,
	).toBe("my draft");
	expect(screen.queryByText(/notes.md/)).toBeNull();
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("my draft"));
	fireEvent.click(screen.getByRole("button", { name: "Download text" }));
	expect(downloadMock).toHaveBeenCalledWith({ filename: "unsaved-text.txt", blob: expect.any(Blob) });
	expect(await downloadMock.mock.calls[0]![0].blob.text()).toBe("my draft");
});

test("requires confirmation before discard", async () => {
	render(<FilesUnsavedText />);
	fireEvent.click(screen.getByRole("button", { name: "Unsaved text (1)" }));
	fireEvent.click(screen.getByRole("button", { name: "Discard" }));
	expect(files_unsaved_text_get_snapshot()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Keep text" }));
	expect(files_unsaved_text_get_snapshot()).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Discard" }));
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Discard text" }));
	});
	expect(files_unsaved_text_get_snapshot()).toEqual([]);
});

test("uses each capture's membership without a current workspace", () => {
	files_unsaved_text_capture({
		userId: "user",
		membershipId: "other membership" as app_convex_Id<"organizations_workspaces_users">,
		target: { kind: "saved", id: "other file" as app_convex_Id<"files_nodes"> },
		documentId: "other document",
		rootKind: "plain_text",
		text: "another draft",
		reason: "changed",
	});
	render(<FilesUnsavedText />);
	fireEvent.click(screen.getByRole("button", { name: "Unsaved text (2)" }));
	expect(
		screen.getByText("This file changed while you were editing. This is the text kept from your editor."),
	).toBeTruthy();
	expect(fileNodeMock).toHaveBeenCalledWith("get_file_node_for_membership", {
		membershipId: "membership",
		fileNodeId: "file",
	});
	expect(fileNodeMock).toHaveBeenCalledWith("get_file_node_for_membership", {
		membershipId: "other membership",
		fileNodeId: "other file",
	});
});

test("hides the previous user's text before auth cleanup runs", () => {
	auth.userId = "other user";
	render(<FilesUnsavedText />);
	expect(screen.queryByRole("button", { name: /Unsaved text/ })).toBeNull();
	expect(files_unsaved_text_get_snapshot()).toHaveLength(1);
	expect(fileNodeMock).not.toHaveBeenCalled();
});
