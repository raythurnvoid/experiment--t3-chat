import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { users_SYSTEM_AUTHOR } from "../../../shared/users.ts";

const {
	actionMock,
	mutationMock,
	useQueryMock,
	queryPushListeners,
	editorChangeRef,
	editorOptionsRef,
	editorValues,
	editorHandle,
} = vi.hoisted(() => ({
	actionMock: vi.fn(),
	mutationMock: vi.fn(),
	useQueryMock: vi.fn(),
	queryPushListeners: new Set<() => void>(),
	editorChangeRef: { current: null as ((value: string | undefined) => void) | null },
	editorOptionsRef: { current: null as Record<string, unknown> | null },
	editorValues: [] as string[],
	editorHandle: {
		options: {} as { readOnly?: boolean },
		updateOptions(next: { readOnly?: boolean }) {
			Object.assign(editorHandle.options, next);
		},
	},
}));

// Network boundary. The real hook talks to a live Convex client. These tests feed the query data
// in directly.
//
// The stand-in re-renders on demand, because the real one does. Convex pushes a new answer into the
// component that subscribed, and the parent does not re-render the memoized metadata section: its
// props do not change when the stored map does. A mock that only reads on render would make every
// "somebody else changed it" test unreachable.
vi.mock("convex/react", async () => {
	const { useEffect, useState } = await import("react");

	return {
		useQueries: () => ({ user_1: { displayName: "Ada" } }),
		usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
		useQuery: (...args: unknown[]) => {
			const [, forceRender] = useState(0);

			useEffect(() => {
				const listener = () => forceRender((current) => current + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);

			return useQueryMock(...args);
		},
	};
});

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: MEMBERSHIP_ID, organizationId: "organization_1", workspaceId: "workspace_1" }),
	},
}));

// The real module creates a live ConvexReactClient when it is imported, which needs
// VITE_CONVEX_URL. The generated api object is also a Proxy. Using plain strings as function
// references keeps the call assertions readable.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		action: (...args: unknown[]) => actionMock(...args),
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		files_metadata: {
			get_entries: "get_entries",
			set_entries: "set_entries",
		},
		files_nodes: {
			get_file_node_for_membership: "get_file_node_for_membership",
			get_current_user_file_write_permission: "get_current_user_file_write_permission",
			get_node_write_policy_management_state: "get_node_write_policy_management_state",
			set_node_write_policy: "set_node_write_policy",
		},
		files_nodes_content: {
			get_file_collaboration_cleanup_state: "get_file_collaboration_cleanup_state",
			set_file_collaborative: "set_file_collaborative",
			set_file_non_collaborative: "set_file_non_collaborative",
		},
		r2: {
			get_asset_by_file_node_id: "get_asset_by_file_node_id",
		},
		users: {
			get_anagraphic: "get_anagraphic",
		},
		organizations: { list_organization_workspace_users: "list_workspace_users" },
		access_control: { list_service_accounts: "list_service_accounts", get_service_account: "get_service_account" },
	},
}));

// Monaco owns a real code editor and a web worker. Stand in a textarea that reports the same value
// and calls the same onChange, so the modal's own draft handling is what these tests exercise. The
// stand-in also hands over an editor handle through onMount, because the modal pushes readOnly to
// that handle instead of through the options object, and a mock that never mounts would let that
// wiring disappear without a test noticing.
vi.mock("@monaco-editor/react", async () => {
	const { useEffect } = await import("react");

	return {
		Editor: function Editor(props: {
			value?: string;
			onChange?: (value: string | undefined) => void;
			onMount?: (editor: unknown) => void;
			options?: Record<string, unknown>;
		}) {
			editorChangeRef.current = props.onChange ?? null;
			editorOptionsRef.current = props.options ?? null;
			editorValues.push(props.value ?? "");
			const onMount = props.onMount;

			useEffect(() => {
				onMount?.(editorHandle);
			}, [onMount]);

			return <textarea aria-label="Metadata YAML" readOnly value={props.value ?? ""} />;
		},
	};
});

vi.mock("@/lib/app-monaco-config.ts", () => ({
	app_monaco_THEME_NAME_DARK: "app-files-monaco-theme-dark",
}));

import { FilesPropertiesModal } from "./files-properties-modal.tsx";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;
const NODE_ID = "node_1" as app_convex_Id<"files_nodes">;
const SOURCE_ID = "source_1" as app_convex_Id<"files_nodes">;

const NODE = {
	_id: NODE_ID,
	_creationTime: 1_700_000_000_000,
	path: "/docs/notes.md",
	name: "notes.md",
	kind: "file",
	contentType: "text/markdown",
	assetId: null as string | null,
	textKind: null as "rich_text" | "plain_text" | null,
	collaborationEnabled: null as boolean | null,
	yjsSnapshotId: null,
	yjsLastSequenceId: null,
	createdBy: "user_1",
	updatedBy: "user_1",
	updatedAt: 1_700_000_000_000,
	canWrite: true,
	writeBlockedReason: null as "read_only" | "permission" | null,
	writePolicyState: "none" as const,
};

// A file whose text can be edited. `assetId` plus `textKind` is what marks one, and the plain
// NODE above deliberately has neither, so an image gets no collaboration section.
const TEXT_NODE = { ...NODE, assetId: "asset_1", textKind: "rich_text" as const, collaborationEnabled: true };

type ManagementState = {
	canManage: boolean;
	canWrite: boolean;
	writeBlockedReason: "read_only" | "permission" | null;
	localPolicy:
		| null
		| { mode: "read_only" }
		| { mode: "writer"; writer: null | { kind: "user"; userId: string; name: string } };
	hasInheritedPolicy: boolean;
	inheritedSource: { nodeId: app_convex_Id<"files_nodes">; path: string } | null;
	blockedByAncestor: boolean;
};

const WRITABLE_POLICY: ManagementState = {
	canManage: true,
	canWrite: true,
	writeBlockedReason: null,
	localPolicy: null,
	hasInheritedPolicy: false,
	inheritedSource: null,
	blockedByAncestor: false,
};

function mockQueries(args: {
	management?: ManagementState;
	node?: typeof NODE;
	cleanupBlocksCollaboration?: boolean | null;
	asset?: { size: number } | null;
	entries?: { key: string; value: string | number | boolean }[];
	canWrite?: boolean;
}) {
	useQueryMock.mockImplementation((query: unknown, queryArgs: unknown) => {
		if (queryArgs === "skip") {
			return undefined;
		}
		if (query === "get_node_write_policy_management_state") {
			return { nodeId: NODE_ID, ...WRITABLE_POLICY, ...args.management };
		}
		if (query === "get_file_node_for_membership") {
			return args.node ?? NODE;
		}
		if (query === "get_file_collaboration_cleanup_state") {
			return args.cleanupBlocksCollaboration ?? false;
		}
		if (query === "get_asset_by_file_node_id") {
			return args.asset === undefined ? { size: 2048 } : args.asset;
		}
		if (query === "get_anagraphic") {
			return { displayName: "Ada" };
		}
		if (query === "list_workspace_users") {
			return ["user_1"];
		}
		if (query === "get_entries") {
			return args.entries;
		}
		if (query === "get_current_user_file_write_permission") {
			return args.canWrite;
		}
		return undefined;
	});
}

// Render the way the app does. StrictMode runs every state updater twice, which is what catches an
// updater that is not pure. In the sidebar panel this modal replaced, one updater wrote a ref, and
// the second run then reported a conflict that was not there.
function renderModal(overrides?: Partial<Parameters<typeof FilesPropertiesModal>[0]>) {
	return render(
		<FilesPropertiesModal
			nodeId={NODE_ID}
			nodeName="notes.md"
			nodeKind="file"
			hasVisibleReadOnlyDescendant={false}
			onClose={() => {}}
			{...overrides}
		/>,
		{ wrapper: StrictMode },
	);
}

function typeDraft(value: string) {
	act(() => {
		editorChangeRef.current?.(value);
	});
}

function clickSave() {
	act(() => {
		screen.getByRole("button", { name: "Save metadata" }).click();
	});
}

/**
 * Push a new stored map the way the reactive query would.
 */
async function pushServerEntries(entries: { key: string; value: string | number | boolean }[]) {
	mockQueries({ entries, canWrite: true });
	await act(async () => {
		for (const listener of queryPushListeners) {
			listener();
		}
	});
}

beforeEach(() => {
	useQueryMock.mockReset();
	useQueryMock.mockReturnValue(undefined);
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: null });
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: null });
	editorChangeRef.current = null;
	editorOptionsRef.current = null;
	editorValues.length = 0;
	editorHandle.options = {};
});

afterEach(() => {
	cleanup();
});

describe("FilesPropertiesModalFacts", () => {
	test("shows the file facts, and drops the file-only rows for a folder", () => {
		mockQueries({ entries: [], canWrite: true });

		const { unmount } = renderModal();
		expect(screen.getByText("Content type")).toBeTruthy();
		expect(screen.getByText("Size")).toBeTruthy();
		expect(screen.getByText("/docs")).toBeTruthy();
		unmount();

		renderModal({ nodeKind: "folder" });
		expect(screen.queryByText("Content type")).toBeNull();
		expect(screen.queryByText("Size")).toBeNull();
	});

	// The test above reads the row names. The work is in the values: two author lookups, a skipped
	// lookup for the author the app uses for its own writes, and the size of the stored blob.
	test("shows the value in every row, and System for a file the app itself last wrote", () => {
		mockQueries({ node: { ...NODE, updatedBy: users_SYSTEM_AUTHOR }, entries: [], canWrite: true });

		renderModal();

		const labels = Array.from(document.querySelectorAll(".FilesPropertiesModalFacts-label")).map(
			(element) => element.textContent,
		);
		expect(labels).toEqual([
			"Content type",
			"Size",
			"Location",
			"Created",
			"Created by",
			"Last edited",
			"Last edited by",
		]);
		const rowValue = (label: string) =>
			Array.from(document.querySelectorAll(".FilesPropertiesModalFacts-row"))
				.find((row) => row.querySelector(".FilesPropertiesModalFacts-label")?.textContent === label)
				?.querySelector(".FilesPropertiesModalFacts-value")?.textContent;
		expect(rowValue("Content type")).toBe("text/markdown");
		expect(rowValue("Size")).toBe("2.0 KB");
		expect(rowValue("Location")).toBe("/docs");
		expect(rowValue("Created by")).toBe("Ada");
		expect(rowValue("Last edited by")).toBe("System");

		// SYSTEM is not a real user id, so its lookup must be skipped instead of sent.
		expect(useQueryMock).toHaveBeenCalledWith("get_anagraphic", { userId: "user_1" });
		expect(useQueryMock).toHaveBeenCalledWith("get_anagraphic", "skip");
	});

	// A file written in the app keeps its text in chunks and has no stored blob, so there is no
	// size to report.
	test("shows the size as Unknown for a file with no stored asset", () => {
		mockQueries({ asset: null, entries: [], canWrite: true });

		renderModal();

		const sizeRow = Array.from(document.querySelectorAll(".FilesPropertiesModalFacts-row")).find(
			(row) => row.querySelector(".FilesPropertiesModalFacts-label")?.textContent === "Size",
		);
		expect(sizeRow?.querySelector(".FilesPropertiesModalFacts-value")?.textContent).toBe("Unknown");
	});

	// The two author lookups answer after the node does. Rendering the rows as soon as the node
	// arrives would leave both author values blank for a moment, so every row waits for all of them.
	test("keeps skeleton rows while the author lookups are still loading", () => {
		useQueryMock.mockImplementation((query: unknown) => {
			if (query === "get_file_node_for_membership") {
				return NODE;
			}
			if (query === "get_asset_by_file_node_id") {
				return { size: 2048 };
			}
			return undefined;
		});

		renderModal();

		expect(document.querySelectorAll(".FilesPropertiesModalFacts-row")).toHaveLength(7);
		expect(document.querySelectorAll(".FilesPropertiesModalFacts-skeleton").length).toBeGreaterThan(0);
		expect(screen.queryByText("Content type")).toBeNull();
	});
});

describe("FilesPropertiesModalWritePolicy", () => {
	test.each([
		[WRITABLE_POLICY, "Inherit", "You can edit this file."],
		[
			{ ...WRITABLE_POLICY, canWrite: false, writeBlockedReason: "read_only", localPolicy: { mode: "read_only" } },
			"Read-only",
			"The local policy blocks editing.",
		],
		[
			{
				...WRITABLE_POLICY,
				canWrite: false,
				writeBlockedReason: "read_only",
				hasInheritedPolicy: true,
				blockedByAncestor: true,
				inheritedSource: { nodeId: SOURCE_ID, path: "/outer" },
			},
			"Inherit",
			"A policy on a parent folder blocks editing.",
		],
	] satisfies [ManagementState, string, string][])(
		"shows the local choice and effective result",
		(management, choice, description) => {
			mockQueries({ management, entries: [], canWrite: management.canWrite });
			renderModal();
			expect((screen.getByRole("radio", { name: choice }) as HTMLInputElement).checked).toBe(true);
			expect(screen.getByText(description, { exact: false })).toBeTruthy();
		},
	);

	test("disables policy choices until settings arrive", () => {
		renderModal();
		for (const radio of screen.getAllByRole("radio")) {
			expect((radio as HTMLInputElement).disabled).toBe(true);
		}
		expect(screen.getByText("Loading write policy…")).toBeTruthy();
	});

	test("saves an explicit policy and ignores a second press while saving", async () => {
		mockQueries({ entries: [], canWrite: true });
		let finishMutation: (result: { _yay: null }) => void = () => {};
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				finishMutation = resolve;
			}),
		);
		renderModal();
		fireEvent.click(screen.getByRole("radio", { name: "Read-only" }));
		expect(mutationMock).not.toHaveBeenCalled();
		const save = screen.getByRole("button", { name: "Save policy" });
		save.focus();
		fireEvent.click(save);
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(document.activeElement).toBe(save);
		fireEvent.click(save);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).toHaveBeenCalledWith("set_node_write_policy", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			writePolicy: { mode: "read_only" },
		});
		await act(async () => {
			finishMutation({ _yay: null });
		});
	});

	test("removes only the local policy under a parent policy", () => {
		mockQueries({
			management: {
				...WRITABLE_POLICY,
				localPolicy: { mode: "read_only" },
				hasInheritedPolicy: true,
				blockedByAncestor: true,
				inheritedSource: { nodeId: SOURCE_ID, path: "/outer" },
				canWrite: false,
				writeBlockedReason: "read_only",
			},
			entries: [],
			canWrite: false,
		});
		renderModal();
		fireEvent.click(screen.getByRole("radio", { name: "Inherit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		expect(mutationMock).toHaveBeenCalledWith("set_node_write_policy", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			writePolicy: null,
		});
	});

	test("offers a readable parent without disabling local policy management", () => {
		mockQueries({
			management: {
				...WRITABLE_POLICY,
				hasInheritedPolicy: true,
				blockedByAncestor: true,
				inheritedSource: { nodeId: SOURCE_ID, path: "/outer" },
				canWrite: false,
				writeBlockedReason: "read_only",
			},
			entries: [],
			canWrite: false,
		});
		const onNavigateNode = vi.fn();
		const onClose = vi.fn();
		renderModal({ onNavigateNode, onClose });
		expect((screen.getByRole("radio", { name: "Read-only" }) as HTMLInputElement).disabled).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Open parent policy" }));
		expect(onNavigateNode).toHaveBeenCalledWith(SOURCE_ID);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("keeps a hidden writer protected without making a write", () => {
		mockQueries({
			management: { ...WRITABLE_POLICY, localPolicy: { mode: "writer", writer: null } },
			entries: [],
			canWrite: true,
		});
		renderModal();
		expect(screen.getByText("Protected file. The selected writer is unavailable.")).toBeTruthy();
		expect((screen.getByRole("radio", { name: "Selected writer" }) as HTMLInputElement).checked).toBe(true);
		expect(screen.getByRole("button", { name: "Save policy" }).hasAttribute("disabled")).toBe(true);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("allows a selected human to edit while a writer policy exists", () => {
		mockQueries({
			management: {
				...WRITABLE_POLICY,
				localPolicy: { mode: "writer", writer: { kind: "user", userId: "user_1", name: "Ada" } },
			},
			entries: [],
			canWrite: true,
		});
		renderModal();
		expect(screen.getByText("You can edit this file.", { exact: false })).toBeTruthy();
		expect(editorHandle.options.readOnly).toBe(false);
	});

	test("separates policy management from content write permission", () => {
		mockQueries({ management: { ...WRITABLE_POLICY, canManage: false }, entries: [], canWrite: true });
		renderModal();
		expect((screen.getByRole("radio", { name: "Read-only" }) as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByText("You cannot change this policy.", { exact: false })).toBeTruthy();
		expect(editorHandle.options.readOnly).toBe(false);
	});

	test("shows a refused policy change without closing", async () => {
		mockQueries({ entries: [], canWrite: true });
		mutationMock.mockResolvedValue({ _nay: { message: "The policy changed in another tab" } });
		const onClose = vi.fn();
		renderModal({ onClose });
		fireEvent.click(screen.getByRole("radio", { name: "Read-only" }));
		fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
		expect((await screen.findByRole("alert")).textContent).toBe("The policy changed in another tab");
		expect(onClose).not.toHaveBeenCalled();
	});

	test("restores focus to the control that opened the dialog", async () => {
		mockQueries({ entries: [], canWrite: true });
		const returnFocusRef = createRef<HTMLButtonElement>();
		const onClose = vi.fn();
		function Harness() {
			const [nodeId, setNodeId] = useState<app_convex_Id<"files_nodes"> | null>(NODE_ID);
			return (
				<>
					<button ref={returnFocusRef}>Properties</button>
					<FilesPropertiesModal
						nodeId={nodeId}
						nodeName="notes.md"
						nodeKind="file"
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
		fireEvent.click(screen.getByRole("button", { name: "Done" }));

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(document.activeElement).toBe(returnFocusRef.current));
	});
});

describe("FilesPropertiesModalCollaboration", () => {
	const collaborationCheckbox = () =>
		screen.getByRole("checkbox", { name: /Collaborative editing/ }) as HTMLInputElement;

	// An image has no text to share, so there is no mode to choose. The section must not draw its
	// divider line for one either.
	test("shows the checkbox for a text file and nothing at all for a stored blob", () => {
		mockQueries({ node: TEXT_NODE, entries: [], canWrite: true });
		const { unmount } = renderModal();
		expect(collaborationCheckbox().checked).toBe(true);
		expect(screen.getByText("Everybody can type in this file at the same time.", { exact: false })).toBeTruthy();
		unmount();

		mockQueries({ entries: [], canWrite: true });
		renderModal();
		expect(screen.queryByRole("checkbox", { name: /Collaborative editing/ })).toBeNull();
		expect(document.querySelector(".FilesPropertiesModalCollaboration")).toBeNull();
	});

	test("explains last write wins when collaboration is already off", () => {
		mockQueries({ node: { ...TEXT_NODE, collaborationEnabled: false }, entries: [], canWrite: true });

		renderModal();

		expect(collaborationCheckbox().checked).toBe(false);
		expect(
			screen.getByText("The last save wins. Earlier saves stay in File Snapshots.", { exact: false }),
		).toBeTruthy();
	});

	// Turning it off cannot be undone, so one click must not write. The warning has to name every
	// loss before anything happens.
	test("asks before turning collaboration off and only writes after the confirm button", () => {
		mockQueries({ node: TEXT_NODE, entries: [], canWrite: true });

		renderModal();
		fireEvent.click(collaborationCheckbox());

		expect(mutationMock).not.toHaveBeenCalled();
		const warning = screen.getByText("Turn collaboration off for this file?", { exact: false }).textContent ?? "";
		expect(warning).toContain("edit history");
		expect(warning).toContain("Comments attached to text disappear from the file for everyone.");
		expect(warning).toContain("Text changes waiting for review are kept.");
		expect(warning).toContain("Review them again before accepting.");
		expect(warning).toContain("last saved text");
		expect(warning).toContain("open editor changes");
		// The box still shows the state the server has, not the one the click asked for.
		expect(collaborationCheckbox().checked).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Turn collaboration off" }));

		fireEvent.click(screen.getByRole("button", { name: "Turn collaboration off" }));

		expect(mutationMock).toHaveBeenCalledWith("set_file_non_collaborative", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
			acknowledgeDropCollaborativeHistory: true,
		});
	});

	test("cancelling the confirm step writes nothing and closes the warning", () => {
		mockQueries({ node: TEXT_NODE, entries: [], canWrite: true });

		renderModal();
		fireEvent.click(collaborationCheckbox());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByText("Turn collaboration off for this file?", { exact: false })).toBeNull();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(collaborationCheckbox());
	});

	test("warns about unsaved editor text before turning collaboration on", () => {
		mockQueries({ node: { ...TEXT_NODE, collaborationEnabled: false }, entries: [], canWrite: true });

		renderModal();
		fireEvent.click(collaborationCheckbox());

		expect(actionMock).not.toHaveBeenCalled();
		expect(screen.getByText("Only the last saved text is used.", { exact: false })).toBeTruthy();
		expect(screen.getByText("Text changes waiting for review are kept.", { exact: false })).toBeTruthy();
		expect(screen.getByText("Markdown formatting may change.", { exact: false })).toBeTruthy();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Turn collaboration on" }));
		fireEvent.click(screen.getByRole("button", { name: "Turn collaboration on" }));
		expect(actionMock).toHaveBeenCalledWith("set_file_collaborative", {
			membershipId: MEMBERSHIP_ID,
			nodeId: NODE_ID,
		});
	});

	test("shows the cleanup refusal and keeps collaboration off", async () => {
		mockQueries({ node: { ...TEXT_NODE, collaborationEnabled: false }, entries: [], canWrite: true });
		actionMock.mockResolvedValueOnce({
			_nay: { message: "The old collaboration history is still being removed. Please try again later." },
		});

		renderModal();
		fireEvent.click(collaborationCheckbox());
		fireEvent.click(screen.getByRole("button", { name: "Turn collaboration on" }));

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain("old collaboration history is still being removed");
		});
		expect(collaborationCheckbox().checked).toBe(false);
	});

	test("shows cleanup status only while old history blocks collaboration", async () => {
		mockQueries({
			node: { ...TEXT_NODE, collaborationEnabled: false },
			cleanupBlocksCollaboration: true,
			entries: [],
			canWrite: true,
		});
		renderModal();
		expect(screen.getByRole("status").textContent).toContain("Old edit history is being removed.");
		mockQueries({ node: { ...TEXT_NODE, collaborationEnabled: false }, entries: [], canWrite: true });
		await act(async () => {
			for (const listener of queryPushListeners) {
				listener();
			}
		});
		expect(screen.queryByText("Old edit history is being removed.", { exact: false })).toBeNull();
		expect(collaborationCheckbox().disabled).toBe(false);
	});

	// The server asks for the write permission and refuses a locked file, so the box must not offer
	// a write that is going to be refused.
	test.each([
		[{ canWrite: false, locked: false }, "You don't have permission to edit this file."],
		[{ canWrite: false, locked: true }, "A file policy blocks editing this file."],
	] as const)("disables the box and says why when the server would refuse", (blocked, expectedText) => {
		mockQueries({
			node: { ...TEXT_NODE, writeBlockedReason: blocked.locked ? "read_only" : "permission" },
			entries: [],
			canWrite: blocked.canWrite,
		});

		renderModal();

		expect(collaborationCheckbox().disabled).toBe(true);
		// Read the collaboration section's own reason.
		expect(document.querySelector(".FilesPropertiesModalCollaboration-description")?.textContent).toContain(
			expectedText,
		);
		fireEvent.click(collaborationCheckbox());
		expect(mutationMock).not.toHaveBeenCalled();
	});

	// The mutation refuses a file that is still saving, and a new file nobody accepted yet. The
	// reason has to reach the user instead of the click looking like it did nothing.
	test("shows the reason the server gave for refusing", async () => {
		mockQueries({ node: TEXT_NODE, entries: [], canWrite: true });
		mutationMock.mockResolvedValue({ _nay: { message: "This file is still saving. Try again in a moment." } });

		renderModal();
		fireEvent.click(collaborationCheckbox());
		await act(async () => {
			screen.getByRole("button", { name: "Turn collaboration off" }).click();
		});

		expect(screen.getByRole("alert").textContent).toBe("This file is still saving. Try again in a moment.");
		// The confirm step stays open, so the user can try again after the save lands.
		expect(screen.getByRole("button", { name: "Turn collaboration off" })).toBeTruthy();
	});
});

describe("FilesPropertiesModalMetadata", () => {
	test("shows the stored map as YAML and keeps Save disabled until the draft changes", () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });

		renderModal();

		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toContain("created-by: slack");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);

		typeDraft("created-by: email\n");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(false);
	});

	test("mounts the editor on the stored YAML, not an empty draft", () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });

		renderModal();

		expect(editorValues[0]).toContain("created-by: slack");
	});

	// The same rule on the cold path: the query has no answer yet on the first render, so the
	// skeleton must hold until the draft carries the stored map. Mounting the editor as soon as the
	// map arrives would create it empty and fill it one render later.
	test("waits for the stored map instead of mounting the editor empty", async () => {
		mockQueries({ entries: undefined, canWrite: true });
		renderModal();

		expect(editorValues).toEqual([]);

		await pushServerEntries([{ key: "created-by", value: "slack" }]);

		expect(editorValues[0]).toContain("created-by: slack");
	});

	// YAML allows lists and nested maps. The stored shape is a flat key-value map only. The refusal
	// happens before the mutation, so an invalid draft never spends a write rate-limit token.
	test("refuses a nested draft in the dialog and never calls the mutation", async () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal();
		typeDraft("owner:\n  name: nested\n");
		clickSave();

		expect(mutationMock).not.toHaveBeenCalled();
		expect((await screen.findByRole("alert")).textContent).toContain("must have a text, number, or true/false value");
	});

	test("saves the draft YAML through set_entries", () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal();
		typeDraft("created-by: agent\n");
		clickSave();

		expect(mutationMock).toHaveBeenCalledWith("set_entries", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: NODE_ID,
			metadataYaml: "created-by: agent\n",
		});
	});

	test("blocks saving on a read-only file and says why", () => {
		mockQueries({
			node: { ...NODE, writeBlockedReason: "read_only" },
			entries: [],
			canWrite: false,
		});

		renderModal();
		typeDraft("created-by: agent\n");

		expect(screen.getByRole("status").textContent).toBe("A file policy blocks editing this item.");
		const save = screen.getByRole("button", { name: "Save metadata" });
		// Native `disabled` drops the button from the tab order, so a keyboard user never reaches
		// the reason. Keep it focusable with `aria-disabled`, the same way the users page does.
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
	});

	test("blocks saving without write permission and names the permission first", () => {
		mockQueries({
			node: { ...NODE, writeBlockedReason: "permission" },
			entries: [],
			canWrite: false,
		});

		renderModal();

		expect(screen.getByRole("status").textContent).toBe("You don't have permission to edit this item.");
		const save = screen.getByRole("button", { name: "Save metadata" });
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
	});

	// Monaco traps Tab by default, which leaves a keyboard user stuck inside this small field with no
	// way to reach Save. Live QA found the trap. This test pins the option that lets Tab out.
	test("lets Tab leave the editor instead of typing a tab character", () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal();

		expect(editorOptionsRef.current?.tabFocusMode).toBe(true);
	});

	test("makes the editor itself read-only, not only the Save button", () => {
		mockQueries({
			node: { ...NODE, writeBlockedReason: "read_only" },
			entries: [],
			canWrite: false,
		});

		renderModal();

		expect(editorHandle.options.readOnly).toBe(true);
	});

	test("leaves the editor writable when the file is writable", () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal();

		expect(editorHandle.options.readOnly).toBe(false);
	});

	// The stored map is re-rendered as YAML on every push, so the text that comes back is almost never
	// the text that was sent. The editor uses CRLF and drops nothing. The map drops comments and
	// re-quotes values. Without this the dialog treated its own save as somebody else's edit.
	test("adopts the server rendering of its own save instead of warning about a conflict", async () => {
		mockQueries({ entries: [], canWrite: true });
		renderModal();

		typeDraft("created-by: agent");
		clickSave();

		await pushServerEntries([{ key: "created-by", value: "agent" }]);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("Metadata saved");
		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);
	});

	// A draft that already reads like the stored map needs no re-rendering, so it lands on the branch
	// that clears a resolved conflict. That branch must not drop the save confirmation.
	test("still confirms a save whose text the server did not have to re-render", async () => {
		mockQueries({ entries: [], canWrite: true });
		renderModal();

		typeDraft("created-by: agent\n");
		clickSave();

		await pushServerEntries([{ key: "created-by", value: "agent" }]);

		expect(screen.getByRole("status").textContent).toBe("Metadata saved");
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);
	});

	test("keeps an unsaved draft and warns when somebody else changes the metadata", async () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });
		renderModal();

		typeDraft("created-by: me\n");
		await pushServerEntries([{ key: "created-by", value: "agent" }]);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Metadata changed elsewhere. Review this draft before saving it over the newer version.",
		);
		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: me\n");
	});

	test("follows the server when the draft was never touched", async () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });
		renderModal();

		await pushServerEntries([{ key: "created-by", value: "agent" }]);

		expect(screen.queryByRole("alert")).toBeNull();
		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
	});

	// Closing the dialog throws the draft away, and a modal is easier to dismiss by accident than the
	// sidebar tab this replaced.
	test("warns in the footer while a draft is unsaved", () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal();
		expect(screen.queryByText("Unsaved metadata will be lost.")).toBeNull();

		typeDraft("created-by: agent\n");
		expect(screen.getByText("Unsaved metadata will be lost.")).toBeTruthy();
	});

	// The section unmounts with the dialog body, so it cannot report the draft it just lost. Without
	// the reset in `handleClose` the next file would open still showing the warning left over from
	// the file that was just closed.
	test("drops the unsaved warning when the dialog closes", async () => {
		mockQueries({ entries: [], canWrite: true });
		const onClose = vi.fn();
		function Harness() {
			const [nodeId, setNodeId] = useState<app_convex_Id<"files_nodes"> | null>(NODE_ID);
			return (
				<FilesPropertiesModal
					nodeId={nodeId}
					nodeName="notes.md"
					nodeKind="file"
					hasVisibleReadOnlyDescendant={false}
					onClose={() => {
						onClose();
						setNodeId(null);
					}}
				/>
			);
		}

		render(<Harness />);
		typeDraft("created-by: agent\n");
		expect(screen.getByText("Unsaved metadata will be lost.")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		expect(screen.queryByText("Unsaved metadata will be lost.")).toBeNull();
	});

	test("edits and removes folder metadata without showing collaboration", async () => {
		mockQueries({
			node: { ...NODE, kind: "folder", name: "docs", path: "/docs" },
			entries: [{ key: "plugin-name", value: "chitchat" }],
			canWrite: true,
		});

		renderModal({ nodeKind: "folder", nodeName: "docs" });

		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toBe("plugin-name: chitchat\n");
		expect(editorOptionsRef.current?.ariaLabel).toBe("Metadata YAML");
		expect(screen.queryByRole("region", { name: "Collaboration" })).toBeNull();
		typeDraft("plugin-name: council\n");
		clickSave();
		expect(mutationMock).toHaveBeenLastCalledWith("set_entries", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: NODE_ID,
			metadataYaml: "plugin-name: council\n",
		});
		await pushServerEntries([{ key: "plugin-name", value: "council" }]);
		expect(screen.getByRole("button", { name: "Save metadata" }).hasAttribute("disabled")).toBe(true);

		typeDraft("");
		clickSave();
		expect(mutationMock).toHaveBeenLastCalledWith("set_entries", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: NODE_ID,
			metadataYaml: "",
		});
		await pushServerEntries([]);
		expect((screen.getByLabelText("Metadata YAML") as HTMLTextAreaElement).value).toBe("");
	});

	test.each([
		[{ canWrite: false, locked: false }, "You don't have permission to edit this item."],
		[{ canWrite: false, locked: true }, "A file policy blocks editing this item."],
	] as const)("blocks folder metadata when writing is not allowed", (blocked, expectedText) => {
		mockQueries({
			node: {
				...NODE,
				kind: "folder",
				name: "docs",
				path: "/docs",
				writeBlockedReason: blocked.locked ? "read_only" : "permission",
			},
			entries: [],
			canWrite: blocked.canWrite,
		});
		renderModal({ nodeKind: "folder", nodeName: "docs" });
		typeDraft("plugin-name: chitchat\n");
		clickSave();
		expect(editorHandle.options.readOnly).toBe(true);
		const save = screen.getByRole("button", { name: "Save metadata" });
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
		expect(screen.getByRole("status").textContent).toBe(expectedText);
		expect(mutationMock).not.toHaveBeenCalled();
	});
});
