import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { FilesClipboardProvider, FilesClipboardToolbar } from "./files-clipboard.tsx";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";

type TransferRun = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.files_transfer.get>>;

const { mutationMock, queryState, toastErrorMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	queryState: {
		revision: 0,
		listeners: new Set<() => void>(),
		runs: [] as TransferRun[],
		run: undefined as TransferRun | null | undefined,
		runsById: {} as Record<string, TransferRun>,
	},
	toastErrorMock: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	const { useSyncExternalStore } = await import("react");
	return {
		...original,
		useConvex: () => ({ mutation: mutationMock }),
		useQuery: (reference: FunctionReference<"query">, args: { runId?: string } | "skip") => {
			useSyncExternalStore(
				(listener) => {
					queryState.listeners.add(listener);
					return () => queryState.listeners.delete(listener);
				},
				() => queryState.revision,
			);
			if (args === "skip") return undefined;
			if (getFunctionName(reference) === "files_transfer:list_current") return queryState.runs;
			return (args.runId && queryState.runsById[args.runId]) || queryState.run;
		},
	};
});

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

const SOURCE_ID = "source" as app_convex_Id<"files_nodes">;
const SECOND_ID = "second" as app_convex_Id<"files_nodes">;
const TARGET_ID = "target" as app_convex_Id<"files_nodes">;
const RUN_ID = "run" as app_convex_Id<"files_transfer_runs">;
const OLD_RUN_ID = "old-run" as app_convex_Id<"files_transfer_runs">;

function make_run(overrides: Partial<TransferRun> = {}): TransferRun {
	return {
		_id: RUN_ID,
		kind: "copy",
		phase: "running",
		revision: 1,
		total: 2,
		completed: 0,
		skipped: 0,
		failed: 0,
		errorMessage: null,
		conflicts: [],
		movedNodeIds: [],
		...overrides,
	};
}

function push_run(run: TransferRun) {
	act(() => {
		queryState.run = run;
		queryState.runs = run.phase === "completed" || run.phase === "canceled" || run.phase === "failed" ? [] : [run];
		queryState.revision++;
		for (const listener of queryState.listeners) listener();
	});
}

function press_key(target: HTMLElement, key: string, ctrlKey = true) {
	const result = fireEvent.keyDown(target, { key, code: key === "Escape" ? key : `Key${key.toUpperCase()}`, ctrlKey });
	fireEvent.keyUp(target, { key, code: key === "Escape" ? key : `Key${key.toUpperCase()}`, ctrlKey });
	return result;
}

function FileNavigation(props: { blocked?: boolean }) {
	const navigationRef = useRef<HTMLDivElement | null>(null);
	const { clipboard, setClipboard, openRun, stop } = FilesClipboardProvider.useContext();
	FilesClipboardProvider.useHotkeys({
		target: navigationRef,
		getSourceIds: () => [SOURCE_ID],
		getTargetParentId: () => (props.blocked ? null : TARGET_ID),
	});
	return (
		<>
			<div ref={navigationRef} role="group" aria-label="File navigation" tabIndex={0}>
				<button onClick={() => setClipboard("copy", [SOURCE_ID])}>Copy source</button>
				<button onClick={() => setClipboard("cut", [SOURCE_ID, SECOND_ID])}>Cut sources</button>
				<button onClick={() => setClipboard("copy", [SECOND_ID])}>Copy another source</button>
				<button onClick={() => openRun(RUN_ID)}>Review operation</button>
				<button onClick={() => openRun(OLD_RUN_ID)}>Review older operation</button>
				<button onClick={() => void stop(RUN_ID)}>Stop operation</button>
				<input aria-label="Rename file" />
				<textarea aria-label="Search notes" />
				<div contentEditable suppressContentEditableWarning role="textbox" aria-label="Editable note">
					Text
				</div>
				<FilesClipboardToolbar targetParentId={TARGET_ID} targetName="target" canPaste={!props.blocked} />
			</div>
			<textarea aria-label="Chat message" />
			<output aria-label="Clipboard sources">{clipboard?.sourceIds.join(",") ?? "empty"}</output>
		</>
	);
}

function TestClipboard(props: { membershipId?: string; showNavigation?: boolean; blocked?: boolean }) {
	return (
		<FilesClipboardProvider
			key={props.membershipId ?? "membership"}
			membershipId={(props.membershipId ?? "membership") as app_convex_Id<"organizations_workspaces_users">}
		>
			{props.showNavigation === false ? null : <FileNavigation blocked={props.blocked} />}
		</FilesClipboardProvider>
	);
}

beforeEach(() => {
	queryState.run = undefined;
	queryState.runsById = {};
	queryState.runs = [];
	queryState.revision = 0;
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: { runId: RUN_ID } });
	toastErrorMock.mockReset();
});

afterEach(() => {
	cleanup();
	queryState.listeners.clear();
	vi.restoreAllMocks();
});

describe("FilesClipboardProvider", () => {
	test("keeps clipboard IDs across navigation and clears them on membership change", () => {
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		view.rerender(<TestClipboard showNavigation={false} />);
		view.rerender(<TestClipboard />);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		view.rerender(<TestClipboard membershipId="another-membership" />);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty");
	});

	test("scopes shortcuts to navigation and preserves editable shortcuts", () => {
		render(<TestClipboard />);
		const navigation = screen.getByRole("group", { name: "File navigation" });
		expect(press_key(navigation, "c")).toBe(false);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		for (const name of ["Rename file", "Search notes", "Editable note", "Chat message"]) {
			const input = screen.getByLabelText(name);
			for (const key of ["c", "x", "v"]) expect(press_key(input, key)).toBe(true);
		}
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
	});

	test("Escape clears an idle cut and leaves Copy ready", () => {
		render(<TestClipboard />);
		const navigation = screen.getByRole("group", { name: "File navigation" });
		press_key(navigation, "c");
		expect(press_key(navigation, "Escape", false)).toBe(true);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		press_key(navigation, "x");
		expect(press_key(navigation, "Escape", false)).toBe(false);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty");
	});

	test("disables Paste without destination write permission", () => {
		render(<TestClipboard blocked />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		expect(screen.getByRole("button", { name: "Paste files" }).matches(":disabled")).toBe(true);
		expect(press_key(screen.getByRole("group", { name: "File navigation" }), "v")).toBe(true);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("starts one request with source IDs and keeps Copy after completion", async () => {
		const response = Promise.withResolvers<{ _yay: { runId: typeof RUN_ID } }>();
		mutationMock.mockReturnValue(response.promise);
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		const paste = screen.getByRole("button", { name: "Paste files" });
		fireEvent.click(paste);
		fireEvent.click(paste);
		expect(mutationMock).toHaveBeenCalledOnce();
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:start");
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			membershipId: "membership",
			kind: "copy",
			sourceIds: [SOURCE_ID],
			targetParentId: TARGET_ID,
			requestId: expect.any(String),
		});
		await act(async () => response.resolve({ _yay: { runId: RUN_ID } }));
		push_run(make_run({ phase: "completed", completed: 2 }));
		expect(view.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
	});

	test("removes only moved cut IDs and preserves a newer clipboard", async () => {
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		push_run(make_run({ kind: "move", phase: "completed", completed: 1, skipped: 1, movedNodeIds: [SOURCE_ID] }));
		expect(view.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
		cleanup();
		queryState.run = undefined;
		queryState.runs = [];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		const response = Promise.withResolvers<{ _yay: { runId: typeof RUN_ID } }>();
		mutationMock.mockReturnValue(response.promise);
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		await act(async () => response.resolve({ _yay: { runId: RUN_ID } }));
		push_run(make_run({ kind: "move", phase: "completed", completed: 2, movedNodeIds: [SOURCE_ID, SECOND_ID] }));
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
	});

	test("updates cut IDs while the dialog shows an older operation", async () => {
		queryState.runsById[OLD_RUN_ID] = make_run({ _id: OLD_RUN_ID, phase: "completed", completed: 2 });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		fireEvent.click(screen.getByRole("button", { name: "Review older operation" }));
		push_run(make_run({ kind: "move", phase: "completed", completed: 1, skipped: 1, movedNodeIds: [SOURCE_ID] }));
		expect(screen.getByRole("heading", { name: "Copy files" })).toBeTruthy();
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
	});

	test("reuses the request ID after a lost start response", async () => {
		mutationMock.mockRejectedValueOnce(new Error("offline"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Paste files" }).matches(":disabled")).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		expect(mutationMock.mock.calls[1]![1]).toEqual(mutationMock.mock.calls[0]![1]);
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
	});
});

describe("FilesTransferRunModal", () => {
	test("shows a pending Stop before the run details load", async () => {
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(await screen.findByText("Stop requested. Waiting for the server…")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Paste files" })).toBeTruthy();
		expect(screen.queryByText("Loading…")).toBeNull();

		await act(async () => response.resolve({ _yay: null }));
		push_run(make_run({ phase: "canceled" }));
		expect(screen.getByText("Stopped.")).toBeTruthy();
	});

	test("keeps Stop pending when the dialog is hidden and reopened", async () => {
		queryState.run = make_run({ phase: "awaiting_choice", completed: 1 });
		queryState.runs = [queryState.run];
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(await screen.findByRole("button", { name: "Stop and keep completed copies" }));

		expect(screen.getByText("Stop requested. Waiting for the server…").getAttribute("role")).toBe("status");
		expect(screen.getByRole("button", { name: "Stop and keep completed copies" }).matches(":disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		fireEvent.click(screen.getByRole("button", { name: "Review older operation" }));
		push_run(make_run({ _id: OLD_RUN_ID, phase: "completed", completed: 2 }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		fireEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]!);
		push_run(make_run({ phase: "awaiting_choice", completed: 1 }));
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(await screen.findByText("Stop requested. Waiting for the server…")).toBeTruthy();

		push_run(make_run({ phase: "stopping", completed: 1 }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		expect(screen.getByText("Stopping…")).toBeTruthy();
		await act(async () => response.resolve({ _yay: null }));
		push_run(make_run({ phase: "canceled", completed: 1 }));
		expect(screen.getByText("Stopped.")).toBeTruthy();
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test.each([
		["completed", "Completed."],
		["canceled", "Stopped."],
		["failed", "Failed."],
	] as const)("shows the saved %s result while Stop is pending", async (phase, label) => {
		queryState.run = make_run();
		queryState.runs = [queryState.run];
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		expect(screen.getByText("Stop requested. Waiting for the server…")).toBeTruthy();

		push_run(make_run({ phase }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		await act(async () => response.resolve({ _yay: null }));
	});

	test("uses a neutral heading while a move is loading", async () => {
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		expect(screen.getByRole("heading", { name: "Paste files" })).toBeTruthy();
		push_run(make_run({ kind: "move" }));
		expect(screen.getByRole("heading", { name: "Move files" })).toBeTruthy();
	});

	test("submits explicit conflict choices with their revision", async () => {
		queryState.run = make_run({
			phase: "awaiting_choice",
			revision: 4,
			conflicts: [
				{
					itemId: "item" as app_convex_Id<"files_transfer_items">,
					sourceName: "report.md",
					sourcePath: "/report.md",
					targetName: "report.md",
					kind: "name_conflict",
				},
			],
		});
		queryState.runs = [queryState.run];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "/report.md" });
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(within(conflict).getByRole("radio", { name: "Keep both" }));
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to remaining name conflicts" })).getByRole("radio", {
				name: "Skip",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership",
			runId: RUN_ID,
			revision: 4,
			choices: [{ itemId: "item", choice: "keep_both" }],
			applyToRemaining: "skip",
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("shows full paths for same-name sources and keeps their choices separate", async () => {
		queryState.run = make_run({
			phase: "awaiting_choice",
			conflicts: ["a", "b"].map((folder) => ({
				itemId: folder as app_convex_Id<"files_transfer_items">,
				sourceName: "report.md",
				sourcePath: `/${folder}/report.md`,
				targetName: "report.md",
				kind: "name_conflict",
			})),
		});
		queryState.runs = [queryState.run];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const first = await screen.findByRole("group", { name: "/a/report.md" });
		const second = screen.getByRole("group", { name: "/b/report.md" });
		fireEvent.click(within(first).getByRole("radio", { name: "Keep both" }));
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(within(second).getByRole("radio", { name: "Skip" }));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			choices: [
				{ itemId: "a", choice: "keep_both" },
				{ itemId: "b", choice: "skip" },
			],
			applyToRemaining: null,
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("offers only Skip for a changed source and hides without stopping", async () => {
		queryState.run = make_run({
			phase: "awaiting_choice",
			completed: 1,
			conflicts: [
				{
					itemId: "item" as app_convex_Id<"files_transfer_items">,
					sourceName: null,
					sourcePath: null,
					targetName: null,
					kind: "source_changed",
				},
			],
		});
		queryState.runs = [queryState.run];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "Unavailable item" });
		expect(within(conflict).queryByRole("radio", { name: "Keep both" })).toBeNull();
		expect(within(conflict).getByRole("radio", { name: "Skip" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop and keep completed copies" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("clears choices when a new conflict revision arrives", async () => {
		const run = make_run({
			phase: "awaiting_choice",
			conflicts: [
				{
					itemId: "item" as app_convex_Id<"files_transfer_items">,
					sourceName: "report.md",
					sourcePath: "/report.md",
					targetName: "report.md",
					kind: "name_conflict",
				},
			],
		});
		queryState.run = run;
		queryState.runs = [run];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "/report.md" });
		fireEvent.click(within(conflict).getByRole("radio", { name: "Keep both" }));
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to remaining name conflicts" })).getByRole("radio", {
				name: "Skip",
			}),
		);
		push_run({ ...run, revision: run.revision + 1 });
		expect(within(conflict).getByRole("radio", { name: "Keep both" }).matches(":checked")).toBe(false);
		expect(
			within(screen.getByRole("group", { name: "Apply to remaining name conflicts" }))
				.getByRole("radio", { name: "Ask each time" })
				.matches(":checked"),
		).toBe(true);
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
	});

	test("waits for server confirmation when Stop fails", async () => {
		queryState.run = make_run({ completed: 1 });
		queryState.runs = [queryState.run];
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(await screen.findByRole("button", { name: "Stop and keep completed copies" }));
		expect(screen.getByText("Stop requested. Waiting for the server…")).toBeTruthy();
		await act(async () => response.reject(new Error("Request failed")));
		expect((await screen.findByRole("alert")).textContent).toContain("Stop was not confirmed");
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		expect(screen.getByText("Copying files…")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop and keep completed copies" }).matches(":disabled")).toBe(false);
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:stop");
	});
});
