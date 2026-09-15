import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { queryMock, stopMock, state } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	stopMock: vi.fn(),
	state: { revision: 0, listeners: new Set<() => void>(), pendingStops: new Set<string>() },
}));

vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useQuery: (...args: unknown[]) => {
			useSyncExternalStore(
				(listener) => {
					state.listeners.add(listener);
					return () => state.listeners.delete(listener);
				},
				() => state.revision,
			);
			return args[1] === "skip" ? undefined : queryMock(...args);
		},
	};
});
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../convex/_generated/api.js");
	return { app_convex_api: api };
});
vi.mock("@/lib/app-activities-context.tsx", () => ({
	AppActivitiesProvider: { useContext: () => ({ stop: stopMock, pendingStopSourceIds: state.pendingStops }) },
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ organizationName: "team", workspaceName: "home" }) },
}));
// Keep the real dialog and buttons. Only routing is outside this test.
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: (props: { children?: ReactNode; search?: Record<string, string>; onClick?: () => void }) => (
		<a
			href={`/files?${new URLSearchParams(props.search).toString()}`}
			onClick={(event) => {
				event.preventDefault();
				props.onClick?.();
			}}
		>
			{props.children}
		</a>
	),
}));

import { FilesPendingReviewModal } from "./files-pending-review.tsx";
import { app_local_storage_get_value } from "@/lib/storage.ts";

const membershipId = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const runId = "review_1" as app_convex_Id<"files_pending_update_runs">;
const target = { kind: "private", id: "private_1" };
let status = "running";
let kind = "accept";
let step = "applying";
let runUnavailable = false;
let targetReadable = true;

function pushQueries() {
	act(() => {
		state.revision++;
		for (const listener of state.listeners) listener();
	});
}

beforeEach(() => {
	status = "running";
	kind = "accept";
	step = "applying";
	runUnavailable = false;
	targetReadable = true;
	state.revision = 0;
	state.pendingStops.clear();
	stopMock.mockReset();
	stopMock.mockResolvedValue({ _yay: null });
	queryMock.mockReset();
	queryMock.mockImplementation((ref: never, args: { paginationOpts?: { cursor: string | null } }) => {
		const name = getFunctionName(ref);
		if (name === "files_pending_update_runs:get") {
			if (runUnavailable) return null;
			const finished = ["succeeded", "partial", "failed", "canceled", "timed_out"].includes(status);
			return {
				run: { kind, step, needsReviewIds: status === "failed" ? ["hidden_proposal"] : [] },
				activity: {
					_id: "activity_1",
					status,
					finishedAt: finished ? 2 : undefined,
					progress: { total: 6, discovered: 6, completed: 2, blocked: 1, failed: 1, skipped: 0, canceled: 1 },
					errorMessage: status === "failed" ? "Review linked changes together." : null,
				},
				controls: { canStop: !finished && status !== "stopping", canRetry: false, canDismiss: finished },
			};
		}
		if (name === "files_pending_update_runs:list_items")
			return args.paginationOpts?.cursor === "second"
				? {
						page: [{ pendingUpdateId: "proposal_2", target, order: 50, status: "completed" }],
						isDone: true,
						continueCursor: "",
					}
				: {
						page: [
							{
								pendingUpdateId: "proposal_1",
								target,
								order: 0,
								status: "needs_review",
								message: "The destination changed.",
							},
						],
						isDone: false,
						continueCursor: "second",
					};
		if (name === "files_pending_updates:get_file_pending_target")
			return targetReadable ? { entry: { kind: "private", path: "/draft.md", pendingUpdate: { target } } } : null;
		return undefined;
	});
	localStorage.clear();
});
afterEach(() => cleanup());

describe("FilesPendingReviewModal", () => {
	test("shows progress and links each remaining change using current access", () => {
		const onClose = vi.fn();
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={onClose} />);
		expect(screen.getByText("Saving reviewed changes…")).toBeTruthy();
		expect(screen.getByText(/2 saved, 1 need review, 1 failed, 0 skipped, 1 stopped. 1 remaining./)).toBeTruthy();
		const link = screen.getByRole("link", { name: "Review /draft.md" });
		expect(link.getAttribute("href")).toContain("pendingNodeId=private_1");
		fireEvent.click(link);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(app_local_storage_get_value("app_state::files_last_tab")).toBe("app_file_editor_sidebar_tabs_pending");
		expect(stopMock).not.toHaveBeenCalled();
	});

	test("drops a file name and its review link when read access is lost", () => {
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		expect(screen.getByRole("link", { name: "Review /draft.md" })).toBeTruthy();
		targetReadable = false;
		pushQueries();
		expect(screen.queryByText(/draft.md/)).toBeNull();
		expect(screen.getByText("Change 1 · Needs review")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Review /draft.md" })).toBeNull();
	});

	test("loads one bounded page at a time and supports going back", () => {
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		const pageCalls = () =>
			queryMock.mock.calls.filter(([ref]) => getFunctionName(ref) === "files_pending_update_runs:list_items");
		expect(pageCalls().at(-1)?.[1]).toEqual({ membershipId, runId, paginationOpts: { numItems: 50, cursor: null } });
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(pageCalls().at(-1)?.[1]).toEqual({
			membershipId,
			runId,
			paginationOpts: { numItems: 50, cursor: "second" },
		});
		expect(screen.getByText("Change 51 · Completed")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Next page" }).matches(":disabled")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		expect(screen.getByText("/draft.md · Needs review")).toBeTruthy();
	});

	test("keeps paging controls mounted while the next page loads", () => {
		const original = queryMock.getMockImplementation()!;
		let loading = true;
		queryMock.mockImplementation((ref: never, args: { paginationOpts?: { cursor: string | null } }) => {
			if (
				getFunctionName(ref) === "files_pending_update_runs:list_items" &&
				args.paginationOpts?.cursor === "second" &&
				loading
			)
				return undefined;
			return original(ref, args);
		});
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		const next = screen.getByRole("button", { name: "Next page" });
		next.focus();
		fireEvent.click(next);
		expect(screen.getByRole("button", { name: "Next page" })).toBe(next);
		expect(next.matches(":disabled")).toBe(true);
		expect(screen.getByText("Loading changes…")).toBeTruthy();
		loading = false;
		pushQueries();
		expect(screen.getByRole("button", { name: "Next page" })).toBe(next);
		expect(screen.getByText("Change 51 · Completed")).toBeTruthy();
	});

	test("Hide and Escape close the dialog without stopping work", async () => {
		const onClose = vi.fn();
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		const dialog = screen.getByRole("dialog");
		fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
		expect(stopMock).not.toHaveBeenCalled();
	});

	test("uses shared Stop state and shows a refused Stop", async () => {
		stopMock.mockResolvedValue({ _nay: { message: "Stop was refused." } });
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Stop and keep completed changes" }));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Stop was refused."));
		expect(stopMock).toHaveBeenCalledWith({ activityId: "activity_1", sourceId: runId });
		state.pendingStops.add(runId);
		pushQueries();
		expect(screen.getByText("Stop requested. Waiting for the server…")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop and keep completed changes" }).matches(":disabled")).toBe(true);
		status = "stopping";
		pushQueries();
		expect(screen.getByText("Stopping…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop and keep completed changes" })).toBeNull();
	});

	test("keeps the remaining review link after a hidden dependency blocks the job", () => {
		status = "failed";
		step = "finished";
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		expect(screen.getByText(/Some linked changes were not selected/)).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toBe("Review linked changes together.");
		expect(screen.getByRole("link", { name: "Review remaining changes" })).toBeTruthy();
		expect(screen.getByText("Close").closest("button")).toBeTruthy();
	});

	test("labels a completed Discard and handles unavailable history", () => {
		status = "succeeded";
		kind = "discard";
		render(<FilesPendingReviewModal membershipId={membershipId} runId={runId} onClose={vi.fn()} />);
		expect(screen.getByText("Changes discarded.")).toBeTruthy();
		expect(screen.queryByText("Changes saved.")).toBeNull();
		runUnavailable = true;
		pushQueries();
		expect(screen.getByText("This review is no longer available.")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Review remaining changes" })).toBeNull();
	});
});
