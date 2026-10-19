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

const NOTE: FilesArchiveModal_Node = {
	_id: "node_1" as app_convex_Id<"files_nodes">,
	name: "note.md",
	path: "/note.md",
	kind: "file",
};
const REPORTS: FilesArchiveModal_Node = {
	_id: "node_2" as app_convex_Id<"files_nodes">,
	name: "Reports",
	path: "/Reports",
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
		expect(within(dialog).getByRole("textbox", { name: "Items to archive" }).textContent).toBe("/note.md\n/Reports");

		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id, REPORTS._id]));
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("archive_nodes", {
			membershipId: "membership_1",
			nodeIds: [NOTE._id, REPORTS._id],
		});
		expect(onClose).not.toHaveBeenCalled();
		// An archive that finished inside the request needs no toast.
		expect(toastInfoMock).not.toHaveBeenCalled();
		expect(toastWarningMock).not.toHaveBeenCalled();
	});

	test("hands a big archive to a background job and links it", async () => {
		mutationMock.mockResolvedValue({
			_yay: {
				runId: "run_1",
				activityId: "activity_1",
				isDone: false,
				notArchivedNodeIds: [],
				refusedItems: [],
				waitingNodeIds: [],
				isChecking: false,
			},
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

	test("names the item the archive refused, leaves it out of the archived ids and links the job", async () => {
		const reason = '"/Reports/plan.md" is read-only. Unlock it, then try again.';
		mutationMock.mockResolvedValue({
			_yay: {
				runId: "run_1",
				activityId: "activity_1",
				isDone: true,
				notArchivedNodeIds: [REPORTS._id],
				refusedItems: [{ nodeId: REPORTS._id, message: reason }],
				waitingNodeIds: [],
				isChecking: false,
			},
		});
		const { onArchived } = renderModal([NOTE, REPORTS]);
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onArchived).toHaveBeenCalledWith([NOTE._id]));
		expect(toastInfoMock).not.toHaveBeenCalled();
		const [message, options] = toastWarningMock.mock.calls[0] as [string, { action: { onClick: () => void } }];
		expect(message).toBe(`"Reports" was not archived: ${reason}`);
		options.action.onClick();
		expect(openArchiveRunMock).toHaveBeenCalledWith("run_1");
	});

	test("closes without archived ids when the job refused or still checks every item", async () => {
		mutationMock.mockResolvedValue({
			_yay: {
				runId: "run_1",
				activityId: "activity_1",
				isDone: false,
				notArchivedNodeIds: [NOTE._id],
				refusedItems: [{ nodeId: NOTE._id, message: "Permission denied" }],
				waitingNodeIds: [REPORTS._id],
				isChecking: true,
			},
		});
		const { onClose, onArchived } = renderModal([NOTE, REPORTS]);
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onArchived).not.toHaveBeenCalled();
		expect(toastInfoMock).not.toHaveBeenCalled();
		expect(toastWarningMock.mock.calls[0]?.[0]).toBe(
			'"note.md" was not archived: Permission denied. 1 more is being checked.',
		);
	});

	test("starts on Cancel", async () => {
		renderModal([NOTE, REPORTS]);
		const dialog = await screen.findByRole("dialog", { name: "Archive 2 items?" });
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });
		await waitFor(() => expect(document.activeElement).toBe(cancel));
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
	const pausedRestore = () => ({
		kind: "restore",
		revision: 3,
		activity: {
			_id: "activity_1",
			status: "awaiting_input",
			title: "Restore files",
			errorMessage: null,
			progress: { completed: 10, skipped: 0, failed: 0, blocked: 0, canceled: 0, total: 20 },
		},
		controls: { canStop: true, canRetry: false, canDismiss: false },
		conflict: {
			kind: "file",
			name: "a.md",
			path: "/Reports/a.md",
			occupantPath: "/Reports/a.md",
			canReplace: true,
			canKeepBoth: true,
		},
		archived: [],
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
		useQueryMock.mockReturnValue(pausedRestore());
		renderRunModal();
		const dialog = await screen.findByRole("dialog", { name: "Restore files" });
		expect(within(dialog).getByText("Restoring 10 of 20 items…")).toBeTruthy();
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
				progress: { completed: 4, skipped: 0, failed: 0, blocked: 2, canceled: 0, total: 6 },
			},
			controls: { canStop: false, canRetry: false, canDismiss: true },
			conflict: null,
			archived: [
				{ nodeId: "node_1", path: "/note.md" },
				{ nodeId: "node_4", path: null },
				{ nodeId: "node_5", path: "/Plans" },
			],
			notArchived: [
				{ nodeId: "node_2", path: "/Reports", message: "This item is read-only. Unlock it, then try again." },
				{ nodeId: "node_3", path: null, message: "Permission denied" },
				{ nodeId: "node_6", path: "/Drafts", message: "This item is read-only. Unlock it, then try again." },
			],
		});
		renderRunModal();
		const dialog = await screen.findByRole("dialog", { name: "Archive files" });
		// A refused read-only item is expected, so the job reads as completed, not partly completed.
		expect(within(dialog).getByText("Completed.")).toBeTruthy();
		expect(dialog.querySelector("[data-activity-status-icon]")?.getAttribute("data-activity-status-icon")).toBe(
			"succeeded",
		);
		expect(within(dialog).getByText("Archived 4 of 6 items.")).toBeTruthy();
		// A path the person can no longer read is left out.
		expect(within(dialog).getByRole("textbox", { name: "Archived items" }).textContent).toBe("/note.md\n/Plans");
		const list = within(dialog).getByRole("region", { name: "Not archived (3)" });
		// One reason is written once, above all the paths it refused.
		expect(
			within(list).getByRole("textbox", { name: "Not archived: This item is read-only. Unlock it, then try again." })
				.textContent,
		).toBe("/Reports\n/Drafts");
		expect(within(list).getByText("1 item you cannot open")).toBeTruthy();
	});
});
