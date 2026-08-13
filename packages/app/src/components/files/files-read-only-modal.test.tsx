import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const { mutationMock, useQueryMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { mutation: (...args: unknown[]) => mutationMock(...args) },
	app_convex_api: {
		files_nodes: {
			get_node_read_only_management_state: "get_node_read_only_management_state",
			set_node_read_only: "set_node_read_only",
			set_node_writable: "set_node_writable",
		},
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1" }),
	},
}));

import { FilesReadOnlyModal } from "./files-read-only-modal.tsx";

const NODE_ID = "node_1" as app_convex_Id<"files_nodes">;
const SOURCE_ID = "source_1" as app_convex_Id<"files_nodes">;

beforeEach(() => {
	mutationMock.mockReset();
	useQueryMock.mockReset();
});

afterEach(() => {
	cleanup();
});

describe("FilesReadOnlyModal", () => {
	test.each([
		[undefined, "Loading read-only settings…"],
		[
			{ canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			"This folder is writable.",
		],
		[
			{ canManage: true, readOnlyState: "self", hasInheritedParentLock: false, source: null },
			"This folder has a direct read-only lock.",
		],
		[
			{
				canManage: true,
				readOnlyState: "self",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			"This folder has a direct lock and will remain read-only from /outer after it is removed.",
		],
		[
			{
				canManage: true,
				readOnlyState: "inherited",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			"This folder is read-only from /outer.",
		],
	] as const)("shows each management state", (managementState, expectedText) => {
		useQueryMock.mockReturnValue(managementState);

		render(
			<FilesReadOnlyModal
				nodeId={NODE_ID}
				nodeName="docs"
				nodeKind="folder"
				hasVisibleReadOnlyDescendant={false}
				onClose={() => {}}
			/>,
		);

		expect(screen.getByText(expectedText)).toBeTruthy();
	});

	test("keeps the modal open while saving, shows a server error, and restores focus on close", async () => {
		useQueryMock.mockReturnValue({
			canManage: true,
			readOnlyState: "writable",
			hasInheritedParentLock: false,
			source: null,
		});
		let finishMutation: (result: { _nay: { message: string } }) => void = () => {};
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				finishMutation = resolve;
			}),
		);
		const returnFocusRef = createRef<HTMLButtonElement>();
		const onClose = vi.fn();
		function Harness() {
			const [nodeId, setNodeId] = useState<app_convex_Id<"files_nodes"> | null>(NODE_ID);
			return (
				<>
					<button ref={returnFocusRef}>Open settings</button>
					<FilesReadOnlyModal
						nodeId={nodeId}
						nodeName="docs"
						nodeKind="folder"
						hasVisibleReadOnlyDescendant={false}
						returnFocusRef={returnFocusRef}
						onClose={() => {
							onClose();
							setNodeId(null);
						}}
					/>
				</>
			);
		}

		render(<Harness />);

		fireEvent.click(screen.getByRole("button", { name: "Make read-only" }));

		expect(screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
		expect(onClose).not.toHaveBeenCalled();

		await act(async () => {
			finishMutation({ _nay: { message: "The lock changed in another tab" } });
		});

		expect(screen.getByRole("alert").textContent).toBe("The lock changed in another tab");
		expect(document.activeElement?.closest("[data-files-read-only-modal]")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(document.activeElement).toBe(returnFocusRef.current));
	});

	test("navigates to the visible inherited lock source", async () => {
		useQueryMock.mockReturnValue({
			canManage: true,
			readOnlyState: "inherited",
			hasInheritedParentLock: true,
			source: { nodeId: SOURCE_ID, path: "/outer" },
		});
		const onNavigateNode = vi.fn();
		const onClose = vi.fn();

		render(
			<FilesReadOnlyModal
				nodeId={NODE_ID}
				nodeName="docs"
				nodeKind="folder"
				hasVisibleReadOnlyDescendant={false}
				onNavigateNode={onNavigateNode}
				onClose={onClose}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Manage /outer" }));

		expect(onNavigateNode).toHaveBeenCalledWith(SOURCE_ID);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
