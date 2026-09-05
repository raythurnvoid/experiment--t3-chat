import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";

const { convex, snapshotsQueryMock } = vi.hoisted(() => ({
	convex: { action: vi.fn() },
	snapshotsQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useConvex: () => convex,
	useMutation: () => vi.fn(),
	useQueries: () => ({}),
	useQuery: () => ({ createdBy: "user_1" }),
}));

vi.mock("@/hooks/convex-hooks.ts", () => ({
	useStableQuery: (...args: unknown[]) => snapshotsQueryMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "membership_1" }) },
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {
		files_nodes: {
			get_file_snapshots_list: "get_file_snapshots_list",
			get_file_snapshot: "get_file_snapshot",
			create_file_snapshot_content_url: "create_file_snapshot_content_url",
			archive_snapshot: "archive_snapshot",
			unarchive_snapshot: "unarchive_snapshot",
		},
		files_nodes_content: { restore_snapshot_r2: "restore_snapshot_r2" },
		users: { get_anagraphic: "get_anagraphic" },
	},
}));

import { FileEditorSnapshotsModal } from "./file-editor-snapshots-modal.tsx";

const SNAPSHOT_TIME = Date.now() - 60_000;

beforeEach(() => {
	convex.action.mockReset();
	convex.action.mockImplementation((name: string) => {
		return Promise.resolve(
			name === "create_file_snapshot_content_url"
				? { url: "https://snapshot.test/content", snapshotId: "snapshot_1", _creationTime: SNAPSHOT_TIME }
				: { _yay: null },
		);
	});
	snapshotsQueryMock.mockReturnValue({
		snapshots: [{ _id: "snapshot_1", _creationTime: SNAPSHOT_TIME, createdBy: "user_1", archivedAt: 0 }],
	});
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("older text\n")));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("FileEditorSnapshotsModal", () => {
	test("restores the selected snapshot without a base asset", async () => {
		const onApplySnapshotText = vi.fn();
		render(
			<FileEditorSnapshotsModal
				nodeId={"node_1" as app_convex_Id<"files_nodes">}
				sessionId="session_1"
				editable={true}
				getCurrentText={() => "current text\n"}
				onApplySnapshotText={onApplySnapshotText}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open file snapshots" }));
		fireEvent.click(await screen.findByRole("button", { name: format_relative_time(SNAPSHOT_TIME) }));
		const confirmButton = await screen.findByRole("button", { name: "Confirm" });
		await waitFor(() => expect(confirmButton.hasAttribute("disabled")).toBe(false));
		fireEvent.click(confirmButton);
		await act(async () => {});

		expect(convex.action).toHaveBeenLastCalledWith("restore_snapshot_r2", {
			membershipId: "membership_1",
			snapshotId: "snapshot_1",
			nodeId: "node_1",
			sessionId: "session_1",
		});
		expect(convex.action.mock.calls.at(-1)?.[1]).not.toHaveProperty("baseAssetId");
		expect(onApplySnapshotText).toHaveBeenCalledWith("older text\n");
	});
});
