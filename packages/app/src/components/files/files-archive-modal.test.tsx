import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { mutationMock, openArchiveRunMock, toastInfoMock, toastWarningMock, useQueryMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	useQueryMock: vi.fn(),
	openArchiveRunMock: vi.fn(),
	toastInfoMock: vi.fn(),
	toastWarningMock: vi.fn(),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1", organizationId: "organization_1", workspaceId: "workspace_1" }),
	},
}));

vi.mock("@/lib/app-activities-context.tsx", () => ({
	AppActivitiesProvider: {
		useContext: () => ({ openArchiveRun: openArchiveRunMock, pendingStopSourceIds: new Set(), stop: vi.fn() }),
	},
}));

vi.mock("convex/react", () => ({
	useConvex: () => ({ mutation: (...args: unknown[]) => mutationMock(...args) }),
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("sonner", () => ({ toast: { info: toastInfoMock, warning: toastWarningMock } }));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		files_nodes: { archive_nodes: "archive_nodes" },
		files_archive_runs: { get: "files_archive_runs.get", resolve_conflicts: "resolve_conflicts" },
	},
}));

import { FilesArchiveModal, FilesArchiveRunModal, type FilesArchiveModal_Node } from "./files-archive-modal.tsx";

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
	openArchiveRunMock.mockReset();
	toastInfoMock.mockReset();
	toastWarningMock.mockReset();
});

afterEach(cleanup);

describe("FilesArchiveModal", () => {
	test("archives the given nodes and reports them", async () => {
		const { onClose, onArchived } = renderModal([NOTE, REPORTS]);
		const dialog = await screen.findByRole("dialog", { name: "Archive 2 items?" });
		const list = within(dialog).getByRole("list");
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["note.md", "Reports"]);

		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id, REPORTS._id]));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("archive_nodes", {
			membershipId: "membership_1",
			nodeIds: [NOTE._id, REPORTS._id],
		});
		expect(onClose).not.toHaveBeenCalled();
	});

	test("hands a big archive to a background job and links it", async () => {
		mutationMock.mockResolvedValue({
			_yay: { runId: "run_1", activityId: "activity_1", isDone: false, notArchivedNodeIds: [] },
		});
		const { onArchived } = renderModal([REPORTS]);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([REPORTS._id]));
		expect(toastInfoMock).toHaveBeenCalledTimes(1);
		const [message, options] = toastInfoMock.mock.calls[0] as [string, { action: { onClick: () => void } }];
		expect(message).toBe("Archiving in the background. See Activity.");
		options.action.onClick();
		expect(openArchiveRunMock).toHaveBeenCalledWith("run_1");
	});

	test("leaves the items the archive refused out of the archived ids and links the job", async () => {
		mutationMock.mockResolvedValue({
			_yay: { runId: "run_1", activityId: "activity_1", isDone: true, notArchivedNodeIds: [REPORTS._id] },
		});
		const { onArchived } = renderModal([NOTE, REPORTS]);
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id]));
		expect(toastInfoMock).not.toHaveBeenCalled();
		const [message, options] = toastWarningMock.mock.calls[0] as [string, { action: { onClick: () => void } }];
		expect(message).toBe("Some items could not be archived. See Activity.");
		options.action.onClick();
		expect(openArchiveRunMock).toHaveBeenCalledWith("run_1");
	});

	test("archives inline without a toast", async () => {
		const { onArchived } = renderModal([NOTE]);
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id]));
		expect(toastInfoMock).not.toHaveBeenCalled();
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
		mutationMock.mockReturnValue(
			new Promise<{ _yay: null }>((resolve) => (finishWrite = () => resolve({ _yay: null }))),
		);
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

describe("FilesArchiveRunModal", () => {
	const pausedRestore = (canReplace: boolean) => ({
		kind: "restore",
		revision: 3,
		activity: {
			_id: "activity_1",
			status: "awaiting_input",
			title: "Restore files",
			errorMessage: null,
			progress: { completed: 10, skipped: 0, blocked: 0, total: 20 },
		},
		controls: { canStop: true, canRetry: false, canDismiss: false },
		conflict: {
			kind: "file",
			name: "a.md",
			path: "/Reports/a.md",
			occupantPath: "/Reports/a.md",
			canReplace,
		},
		notArchived: [],
	});

	function renderRunModal() {
		render(
			<FilesArchiveRunModal
				membershipId={"membership_1" as app_convex_Id<"organizations_workspaces_users">}
				runId={"run_1" as app_convex_Id<"files_archive_runs">}
				onClose={vi.fn()}
			/>,
		);
	}

	test("sends the picked choice with the revision it was shown for", async () => {
		useQueryMock.mockReturnValue(pausedRestore(true));
		renderRunModal();
		const dialog = await screen.findByRole("dialog", { name: "Restore files" });
		expect(within(dialog).getByText("10 restored, 0 skipped. Total: 20.")).toBeTruthy();
		const continueButton = within(dialog).getByRole("button", { name: "Continue" });
		expect(continueButton).toHaveProperty("disabled", true);

		const clash = within(dialog).getByRole("group", { name: "/Reports/a.md" });
		fireEvent.click(within(clash).getByRole("radio", { name: "Replace" }));
		fireEvent.click(continueButton);

		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith("resolve_conflicts", {
				membershipId: "membership_1",
				runId: "run_1",
				revision: 3,
				choice: "replace",
				applyToRemaining: { file: null, folder: null },
			}),
		);
	});

	test("hides Replace when the server says it is not possible", async () => {
		useQueryMock.mockReturnValue(pausedRestore(false));
		renderRunModal();
		const dialog = await screen.findByRole("dialog", { name: "Restore files" });
		const clash = within(dialog).getByRole("group", { name: "/Reports/a.md" });
		expect(within(clash).queryByRole("radio", { name: "Replace" })).toBeNull();
		expect(within(clash).getByRole("radio", { name: "Keep both" })).toBeTruthy();
	});

	test("lists the selected items the archive did not archive", async () => {
		useQueryMock.mockReturnValue({
			kind: "archive",
			revision: 0,
			activity: {
				_id: "activity_1",
				status: "partial",
				title: "Archive files",
				errorMessage: null,
				finishedAt: 1,
				progress: { completed: 4, skipped: 0, blocked: 2, total: 4 },
			},
			controls: { canStop: false, canRetry: false, canDismiss: true },
			conflict: null,
			notArchived: [
				{ nodeId: "node_2", name: "Reports", message: "An item inside it is read-only." },
				{ nodeId: "node_3", name: null, message: "Permission denied" },
			],
		});
		renderRunModal();
		const dialog = await screen.findByRole("dialog", { name: "Archive files" });
		expect(within(dialog).getByText("4 archived, 0 skipped, 2 not archived. Total: 4.")).toBeTruthy();
		const list = within(dialog).getByRole("region", { name: "Not archived" });
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Reports: An item inside it is read-only.", "An item you cannot open: Permission denied"]);
	});
});
