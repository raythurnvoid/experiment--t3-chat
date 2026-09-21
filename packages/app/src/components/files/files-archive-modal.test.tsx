import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { mutationMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationId: "organization_1", workspaceId: "workspace_1" }),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		files_nodes: { archive_nodes: "archive_nodes" },
	},
}));

import { FilesArchiveModal, type FilesArchiveModal_Node } from "./files-archive-modal.tsx";

const NOTE: FilesArchiveModal_Node = { _id: "node_1" as app_convex_Id<"files_nodes">, name: "note.md", kind: "file" };
const REPORTS: FilesArchiveModal_Node = {
	_id: "node_2" as app_convex_Id<"files_nodes">,
	name: "Reports",
	kind: "folder",
};

function renderModal(nodes: FilesArchiveModal_Node[]) {
	const onClose = vi.fn();
	const onArchived = vi.fn();
	render(<FilesArchiveModal nodes={nodes} onClose={onClose} onArchived={onArchived} />);
	return { onClose, onArchived };
}

beforeEach(() => {
	mutationMock.mockReset().mockResolvedValue({ _yay: null });
});

afterEach(cleanup);

describe("FilesArchiveModal", () => {
	test("archives the given nodes and reports them", async () => {
		const { onClose, onArchived } = renderModal([NOTE, REPORTS]);
		const dialog = await screen.findByRole("dialog", { name: "Archive 2 items?" });
		const list = within(dialog).getByRole("list");
		expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["note.md", "Reports"]);

		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id, REPORTS._id]));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("archive_nodes", {
			membershipId: "membership_1",
			nodeIds: [NOTE._id, REPORTS._id],
		});
		expect(onClose).not.toHaveBeenCalled();
	});

	test("names one item in the heading", async () => {
		renderModal([NOTE]);
		const dialog = await screen.findByRole("dialog", { name: "Archive “note.md”?" });
		expect(within(dialog).queryByRole("list")).toBeNull();
	});

	test("warns when a folder is in the list", async () => {
		const folderSentence = /A folder is archived with everything inside it\./;
		renderModal([NOTE, REPORTS]);
		expect(within(await screen.findByRole("dialog")).getByText(folderSentence)).toBeTruthy();
		cleanup();

		renderModal([NOTE]);
		expect(within(await screen.findByRole("dialog")).queryByText(folderSentence)).toBeNull();
	});

	test("shows a refusal and stays open", async () => {
		mutationMock.mockResolvedValue({ _nay: { name: "nay", message: "Permission denied" } });
		const { onArchived } = renderModal([NOTE]);
		const dialog = await screen.findByRole("dialog");
		const archiveButton = within(dialog).getByRole("button", { name: "Archive" });
		fireEvent.click(archiveButton);

		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"You don't have permission to edit files in this workspace.",
		);
		expect(onArchived).not.toHaveBeenCalled();
		expect(archiveButton).toHaveProperty("disabled", false);
	});

	test("cannot be closed while the write runs", async () => {
		let finishWrite = () => {};
		mutationMock.mockReturnValue(new Promise<{ _yay: null }>((resolve) => (finishWrite = () => resolve({ _yay: null }))));
		const { onClose, onArchived } = renderModal([NOTE]);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		expect(within(dialog).getByRole("button", { name: "Archiving..." })).toHaveProperty("disabled", true);
		expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
		fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
		expect(onClose).not.toHaveBeenCalled();

		finishWrite();
		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id]));
	});

	test("cancel closes without a write", async () => {
		const { onClose, onArchived } = renderModal([NOTE]);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(mutationMock).not.toHaveBeenCalled();
		expect(onArchived).not.toHaveBeenCalled();
	});
});
