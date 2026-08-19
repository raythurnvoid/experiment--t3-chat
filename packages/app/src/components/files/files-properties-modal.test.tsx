import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";

const {
	mutationMock,
	useQueryMock,
	queryPushListeners,
	editorChangeRef,
	editorOptionsRef,
	editorValues,
	editorHandle,
} = vi.hoisted(() => ({
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
		useContext: () => ({ membershipId: MEMBERSHIP_ID }),
	},
}));

// The real module creates a live ConvexReactClient when it is imported, which needs
// VITE_CONVEX_URL. The generated api object is also a Proxy. Using plain strings as function
// references keeps the call assertions readable.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
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
			get_node_read_only_management_state: "get_node_read_only_management_state",
			set_node_read_only: "set_node_read_only",
			set_node_writable: "set_node_writable",
		},
		r2: {
			get_asset_by_file_node_id: "get_asset_by_file_node_id",
		},
		users: {
			get_anagraphic: "get_anagraphic",
		},
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

			return <textarea aria-label="File metadata YAML" readOnly value={props.value ?? ""} />;
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
	createdBy: "user_1",
	updatedBy: "user_1",
	updatedAt: 1_700_000_000_000,
};

type ManagementState = {
	canManage: boolean;
	readOnlyState: "writable" | "self" | "inherited";
	hasInheritedParentLock: boolean;
	source: { nodeId: app_convex_Id<"files_nodes">; path: string } | null;
};

function mockQueries(args: {
	management?: ManagementState;
	entries?: { key: string; value: string | number | boolean }[];
	canWrite?: boolean;
}) {
	useQueryMock.mockImplementation((query: unknown, queryArgs: unknown) => {
		if (queryArgs === "skip") {
			return undefined;
		}
		if (query === "get_node_read_only_management_state") {
			return (
				args.management ?? { canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null }
			);
		}
		if (query === "get_file_node_for_membership") {
			return NODE;
		}
		if (query === "get_asset_by_file_node_id") {
			return { size: 2048 };
		}
		if (query === "get_anagraphic") {
			return { displayName: "Ada" };
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
});

describe("FilesPropertiesModalReadOnly", () => {
	test.each([
		[
			{ canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			false,
			"Anyone with permission to edit can change this file.",
		],
		[
			{ canManage: true, readOnlyState: "self", hasInheritedParentLock: false, source: null },
			true,
			"Locked here. Unchecking makes this file writable again.",
		],
		[
			{
				canManage: true,
				readOnlyState: "self",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			true,
			"Locked here and by /outer. Unchecking removes only the lock set here, so this file stays read-only.",
		],
		[
			{
				canManage: true,
				readOnlyState: "inherited",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			true,
			"Read-only because /outer is locked. Unlock it there to make this file writable.",
		],
	] as const)("says which lock is in force in each state", (management, expectedChecked, expectedText) => {
		mockQueries({ management, entries: [], canWrite: true });

		renderModal();

		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(expectedChecked);
		expect(screen.getByText(expectedText, { exact: false })).toBeTruthy();
	});

	// Before the state arrives the box would otherwise render enabled and unticked, so one fast
	// click would write a lock decision against a value the user never saw.
	test("disables the box until the current lock state has loaded", () => {
		renderModal();

		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.disabled).toBe(true);
		expect(checkbox.checked).toBe(false);
		expect(screen.getByText("Loading read-only settings…", { exact: false })).toBeTruthy();
	});

	// The write is not idempotent, so a second click while the first is still running would send a
	// second lock mutation.
	test("ignores a second click while the first lock write is still running", async () => {
		mockQueries({
			management: { canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			entries: [],
			canWrite: true,
		});
		let finishMutation: (result: { _yay: null }) => void = () => {};
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				finishMutation = resolve;
			}),
		);

		renderModal();
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		fireEvent.click(checkbox);

		expect(checkbox.disabled).toBe(true);
		expect(checkbox.getAttribute("aria-busy")).toBe("true");

		fireEvent.click(checkbox);
		expect(mutationMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			finishMutation({ _yay: null });
		});
	});

	test("locks the file when the checkbox is ticked and unlocks it when it is cleared", () => {
		mockQueries({
			management: { canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			entries: [],
			canWrite: true,
		});
		const { unmount } = renderModal();

		fireEvent.click(screen.getByRole("checkbox"));
		expect(mutationMock).toHaveBeenCalledWith("set_node_read_only", { membershipId: MEMBERSHIP_ID, nodeId: NODE_ID });
		unmount();

		mutationMock.mockClear();
		mockQueries({
			management: { canManage: true, readOnlyState: "self", hasInheritedParentLock: false, source: null },
			entries: [],
			canWrite: true,
		});
		renderModal();

		fireEvent.click(screen.getByRole("checkbox"));
		expect(mutationMock).toHaveBeenCalledWith("set_node_writable", { membershipId: MEMBERSHIP_ID, nodeId: NODE_ID });
	});

	// The node stores a pointer to the folder that owns the lock, not a true/false flag. Clearing the
	// box under a folder lock removes only the lock set here, and the file stays read-only. It must
	// still call the unlock mutation.
	test("clearing the box under an outer lock removes only the direct lock", () => {
		mockQueries({
			management: {
				canManage: true,
				readOnlyState: "self",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			entries: [],
			canWrite: true,
		});

		renderModal();
		fireEvent.click(screen.getByRole("checkbox"));

		expect(mutationMock).toHaveBeenCalledWith("set_node_writable", { membershipId: MEMBERSHIP_ID, nodeId: NODE_ID });
	});

	// A lock owned by a folder above cannot be released from this node, so the box must not offer it.
	test("disables the box for an inherited lock and offers the source instead", () => {
		mockQueries({
			management: {
				canManage: true,
				readOnlyState: "inherited",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			entries: [],
			canWrite: true,
		});
		const onNavigateNode = vi.fn();
		const onClose = vi.fn();

		renderModal({ onNavigateNode, onClose });

		expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Manage /outer" }));
		expect(onNavigateNode).toHaveBeenCalledWith(SOURCE_ID);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("adds a direct lock under an inherited one without touching the box", () => {
		mockQueries({
			management: {
				canManage: true,
				readOnlyState: "inherited",
				hasInheritedParentLock: true,
				source: { nodeId: SOURCE_ID, path: "/outer" },
			},
			entries: [],
			canWrite: true,
		});

		renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Also lock here" }));

		expect(mutationMock).toHaveBeenCalledWith("set_node_read_only", { membershipId: MEMBERSHIP_ID, nodeId: NODE_ID });
	});

	test("disables the box and says so when the member cannot manage the lock", () => {
		mockQueries({
			management: { canManage: false, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			entries: [],
			canWrite: true,
		});

		renderModal();

		expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByText("You cannot change this.", { exact: false })).toBeTruthy();
	});

	test("reports a refused lock change without closing the dialog", async () => {
		mockQueries({
			management: { canManage: true, readOnlyState: "writable", hasInheritedParentLock: false, source: null },
			entries: [],
			canWrite: true,
		});
		let finishMutation: (result: { _nay: { message: string } }) => void = () => {};
		mutationMock.mockReturnValue(
			new Promise((resolve) => {
				finishMutation = resolve;
			}),
		);
		const onClose = vi.fn();

		renderModal({ onClose });
		fireEvent.click(screen.getByRole("checkbox"));

		await act(async () => {
			finishMutation({ _nay: { message: "The lock changed in another tab" } });
		});

		expect(screen.getByRole("alert").textContent).toBe("The lock changed in another tab");
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

describe("FilesPropertiesModalMetadata", () => {
	test("shows the stored map as YAML and keeps Save disabled until the draft changes", () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });

		renderModal();

		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toContain("created-by: slack");
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
			management: { canManage: true, readOnlyState: "inherited", hasInheritedParentLock: true, source: null },
			entries: [],
			canWrite: true,
		});

		renderModal();
		typeDraft("created-by: agent\n");

		expect(screen.getByRole("status").textContent).toBe("This file is read-only.");
		const save = screen.getByRole("button", { name: "Save metadata" });
		// Native `disabled` drops the button from the tab order, so a keyboard user never reaches
		// the reason. Keep it focusable with `aria-disabled`, the same way the users page does.
		expect(save.hasAttribute("disabled")).toBe(false);
		expect(save.getAttribute("aria-disabled")).toBe("true");
		expect(save.getAttribute("aria-describedby")).toBe(screen.getByRole("status").id);
	});

	test("blocks saving without write permission and names the permission first", () => {
		mockQueries({
			management: { canManage: true, readOnlyState: "inherited", hasInheritedParentLock: true, source: null },
			entries: [],
			canWrite: false,
		});

		renderModal();

		expect(screen.getByRole("status").textContent).toBe("You don't have permission to edit this file.");
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
			management: { canManage: true, readOnlyState: "inherited", hasInheritedParentLock: true, source: null },
			entries: [],
			canWrite: true,
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
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
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
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: me\n");
	});

	test("follows the server when the draft was never touched", async () => {
		mockQueries({ entries: [{ key: "created-by", value: "slack" }], canWrite: true });
		renderModal();

		await pushServerEntries([{ key: "created-by", value: "agent" }]);

		expect(screen.queryByRole("alert")).toBeNull();
		expect((screen.getByLabelText("File metadata YAML") as HTMLTextAreaElement).value).toBe("created-by: agent\n");
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

	// `set_entries` refuses a non-file, so a folder must not get an editor that always fails to save.
	test("shows no metadata editor for a folder", () => {
		mockQueries({ entries: [], canWrite: true });

		renderModal({ nodeKind: "folder" });

		expect(screen.queryByLabelText("File metadata YAML")).toBeNull();
		expect(screen.queryByRole("button", { name: "Save metadata" })).toBeNull();
	});
});
