import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { FilesClipboardProvider } from "./files-clipboard.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { FilesMoveIntake } from "@/lib/files-move-intake.ts";

type TransferRun = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.files_transfer.get>>;
type TransferItemPage = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.files_transfer.list_items>>;

const {
	mutationMock,
	intakeQueryMock,
	receiptQueryMock,
	itemQueryMock,
	queryState,
	toastErrorMock,
	intakeState,
	intakeLoadMock,
	intakeSaveMock,
	intakePageMock,
	intakeUpdateMock,
	intakeDeleteMock,
	authState,
} = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	intakeQueryMock: vi.fn(),
	receiptQueryMock: vi.fn(),
	itemQueryMock: vi.fn(),
	authState: { userId: "user" },
	intakeState: { request: null as FilesMoveIntake | null, sourceIds: [] as app_convex_Id<"files_nodes">[] },
	intakeLoadMock: vi.fn(),
	intakeSaveMock: vi.fn(),
	intakePageMock: vi.fn(),
	intakeUpdateMock: vi.fn(),
	intakeDeleteMock: vi.fn(),
	queryState: {
		revision: 0,
		listeners: new Set<() => void>(),
		runs: [] as TransferRun[] | undefined,
		run: undefined as TransferRun | null | undefined,
		runsById: {} as Record<string, TransferRun>,
		itemPages: {} as Record<string, TransferItemPage | null>,
	},
	toastErrorMock: vi.fn(),
}));

vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { useAuthenticated: () => authState } }));
vi.mock("@/lib/files-move-intake.ts", () => ({
	files_move_intake_load: intakeLoadMock,
	files_move_intake_save: intakeSaveMock,
	files_move_intake_read_page: intakePageMock,
	files_move_intake_update: intakeUpdateMock,
	files_move_intake_delete: intakeDeleteMock,
}));

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	const { useSyncExternalStore } = await import("react");
	const convex = {
		mutation: mutationMock,
		query: (reference: FunctionReference<"query">, args: { runId?: string; requestId?: string }) =>
			getFunctionName(reference) === "files_transfer:get_move_intake"
				? intakeQueryMock(reference, args)
				: receiptQueryMock(reference, args),
	};
	return {
		...original,
		useConvex: () => convex,
		useQuery: (
			reference: FunctionReference<"query">,
			args: { runId?: string; state?: string; paginationOpts?: { cursor: string | null } } | "skip",
		) => {
			// Thread the revision into every return. The React Compiler keeps a hook's
			// last result when it does not see that value as an input.
			const revision = useSyncExternalStore(
				(listener) => {
					queryState.listeners.add(listener);
					return () => queryState.listeners.delete(listener);
				},
				() => queryState.revision,
			);
			if (args === "skip") return undefined;
			if (getFunctionName(reference) === "files_transfer:list_current") {
				return revision < 0 ? undefined : queryState.runs;
			}
			if (getFunctionName(reference) === "files_transfer:list_items") {
				itemQueryMock(args);
				const cursor = args.paginationOpts?.cursor ?? "first";
				const itemPage = queryState.itemPages[`${args.state ?? "all"}:${cursor}`] ?? queryState.itemPages[cursor];
				// Return a new page object that includes revision. Mutating nested fields on
				// the stored page keeps the same object identity, and a compiled consumer
				// would keep the old UI. revision must appear in the returned value so the
				// React Compiler treats each store update as a new query result.
				return itemPage == null
					? itemPage
					: {
							page: itemPage.page,
							isDone: itemPage.isDone,
							continueCursor: itemPage.continueCursor,
							_revision: revision,
						};
			}
			const run = args.runId
				? (queryState.runsById[args.runId] ?? (queryState.run?._id === args.runId ? queryState.run : undefined))
				: queryState.run;
			return revision < 0 ? undefined : run;
		},
	};
});

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

const SOURCE_ID = "source" as app_convex_Id<"files_nodes">;
const SECOND_ID = "second" as app_convex_Id<"files_nodes">;
const TARGET_ID = "target" as app_convex_Id<"files_nodes">;
const RUN_ID = "run" as app_convex_Id<"files_transfer_runs">;
const OLD_RUN_ID = "old-run" as app_convex_Id<"files_transfer_runs">;
const MANY_SOURCE_IDS = Array.from({ length: 205 }, (_, index) => `source-${index}` as app_convex_Id<"files_nodes">);

function make_item(overrides: Partial<TransferItemPage["page"][number]> = {}): TransferItemPage["page"][number] {
	return {
		itemId: "item" as app_convex_Id<"files_transfer_items">,
		state: "conflict",
		kind: "file",
		outcome: null,
		source: { target: { kind: "saved", id: SOURCE_ID }, name: "report.md", path: "/report.md" },
		output: null,
		movedNodeId: null,
		conflictKind: "name_conflict",
		conflict: {
			kind: "name_conflict",
			target: { kind: "saved", id: TARGET_ID },
			version: null,
			path: "/copies/report.md",
		},
		errorMessage: null,
		...overrides,
	};
}

function make_run(
	overrides: Partial<Omit<TransferRun, "activity">> & {
		status?: TransferRun["activity"]["status"];
		progress?: Partial<TransferRun["activity"]["progress"]>;
	} = {},
): TransferRun {
	const { status = "running", progress, ...run } = overrides;
	const isTerminal = ["succeeded", "partial", "failed", "canceled", "timed_out"].includes(status);
	return {
		_id: RUN_ID,
		kind: "copy",
		publication: "saved",
		step: "apply",
		revision: 1,
		activity: {
			_id: "activity" as app_convex_Id<"activities">,
			_creationTime: 1,
			organizationId: "organization" as app_convex_Id<"organizations">,
			workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
			userId: "user" as app_convex_Id<"users">,
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			membershipLifetime: 1,
			source: { kind: "files_transfer_run", id: run._id ?? RUN_ID, transferKind: run.kind ?? "copy", isRename: false },
			title: "Copy files",
			status,
			visibility: "requester",
			feedVisible: true,
			resultKind: "saved",
			progress: {
				unit: "files",
				discovered: 2,
				total: 2,
				completed: 0,
				skipped: 0,
				failed: 0,
				blocked: 0,
				canceled: 0,
				...progress,
			},
			errorMessage: null,
			targets: [],
			deadlineAt: 1000,
			updatedAt: 1,
			finishedAt: isTerminal ? 2 : undefined,
		},
		controls: { canStop: !isTerminal && status !== "stopping", canRetry: false, canDismiss: isTerminal },
		conflicts: [],
		movedNodeIds: [],
		...run,
	};
}

function push_run(run: TransferRun) {
	act(() => {
		queryState.run = run;
		queryState.runs = run.activity.finishedAt === undefined ? [run] : [];
		queryState.revision++;
		for (const listener of queryState.listeners) listener();
	});
}

function press_key(args: { target: HTMLElement; key: string; ctrlKey?: boolean }) {
	const { target, key, ctrlKey = true } = args;

	const result = fireEvent.keyDown(target, { key, code: key === "Escape" ? key : `Key${key.toUpperCase()}`, ctrlKey });
	fireEvent.keyUp(target, { key, code: key === "Escape" ? key : `Key${key.toUpperCase()}`, ctrlKey });
	return result;
}

async function press_paste() {
	await act(async () => {});
	return press_key({ target: screen.getByRole("group", { name: "File navigation" }), key: "v" });
}

function FileNavigation(props: { blocked?: boolean }) {
	const navigationRef = useRef<HTMLDivElement | null>(null);
	const { clipboard, isPasting, setClipboard, move, openRun } = FilesClipboardProvider.useContext();
	const { stop } = AppActivitiesProvider.useContext();
	FilesClipboardProvider.useHotkeys({
		target: navigationRef,
		getSourceIds: () => [SOURCE_ID],
		getTargetParentId: () => (props.blocked ? null : TARGET_ID),
	});
	return (
		<>
			<div ref={navigationRef} role="group" aria-label="File navigation" tabIndex={0}>
				<button onClick={() => setClipboard("copy", [SOURCE_ID])}>Copy source</button>
				<button onClick={() => setClipboard("copy", MANY_SOURCE_IDS)}>Copy many sources</button>
				<button onClick={() => setClipboard("cut", [SOURCE_ID, SECOND_ID])}>Cut sources</button>
				<button onClick={() => setClipboard("cut", MANY_SOURCE_IDS)}>Cut many sources</button>
				<button onClick={() => move(MANY_SOURCE_IDS, TARGET_ID)}>Drag many sources</button>
				<button onClick={() => setClipboard("copy", [SECOND_ID])}>Copy another source</button>
				<button onClick={() => openRun(RUN_ID)}>Review operation</button>
				<button onClick={() => openRun(OLD_RUN_ID)}>Review older operation</button>
				<button onClick={() => void stop({ activityId: "activity" as app_convex_Id<"activities">, sourceId: RUN_ID })}>
					Stop operation
				</button>
				<input aria-label="Rename file" />
				<textarea aria-label="Search notes" />
				<div contentEditable suppressContentEditableWarning role="textbox" aria-label="Editable note">
					Text
				</div>
			</div>
			<textarea aria-label="Chat message" />
			<output aria-label="Clipboard sources">{clipboard?.sourceIds.join(",") ?? "empty"}</output>
			<output aria-label="Paste busy">{String(isPasting)}</output>
		</>
	);
}

function TestClipboard(props: { membershipId?: string; showNavigation?: boolean; blocked?: boolean }) {
	return (
		<AppActivitiesProvider
			key={props.membershipId ?? "membership"}
			membershipId={(props.membershipId ?? "membership") as app_convex_Id<"organizations_workspaces_users">}
		>
			<FilesClipboardProvider
				membershipId={(props.membershipId ?? "membership") as app_convex_Id<"organizations_workspaces_users">}
			>
				{props.showNavigation === false ? null : <FileNavigation blocked={props.blocked} />}
			</FilesClipboardProvider>
		</AppActivitiesProvider>
	);
}

beforeEach(() => {
	authState.userId = "user";
	intakeState.request = null;
	intakeState.sourceIds = [];
	intakeLoadMock
		.mockReset()
		.mockImplementation(async (scope) =>
			intakeState.request?.userId === scope.userId && intakeState.request?.membershipId === scope.membershipId
				? { ...intakeState.request }
				: null,
		);
	intakeSaveMock.mockReset().mockImplementation(async ({ request, sourceIds }) => {
		intakeState.request = { ...request };
		intakeState.sourceIds = [...sourceIds];
	});
	intakePageMock.mockReset().mockImplementation(async ({ offset }) => {
		const page = intakeState.sourceIds.slice(offset, offset + 100);
		if (page.length === 0) throw new Error("The saved Move selection is missing a page.");
		return page;
	});
	intakeUpdateMock.mockReset().mockImplementation(async (request: FilesMoveIntake) => {
		if (intakeState.request?.requestId === request.requestId)
			intakeState.request = {
				...request,
				stopRequested: intakeState.request.stopRequested || request.stopRequested,
			};
		else if (!intakeState.request && request.stopRequested && request.runId) intakeState.request = { ...request };
	});
	intakeDeleteMock.mockReset().mockImplementation(async (request: FilesMoveIntake) => {
		if (intakeState.request?.requestId !== request.requestId) return;
		if (intakeState.request.stopRequested && !request.stopRequested) return;
		intakeState.request = null;
		intakeState.sourceIds = [];
	});
	queryState.run = undefined;
	queryState.runsById = {};
	queryState.runs = [];
	queryState.itemPages = { first: { page: [], isDone: true, continueCursor: "" } };
	queryState.revision = 0;
	mutationMock.mockReset();
	itemQueryMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: { runId: RUN_ID } });
	intakeQueryMock
		.mockReset()
		.mockImplementation(async () =>
			intakeState.request?.runId ? { runId: intakeState.request.runId, step: "uploading", isFinished: false } : null,
		);
	receiptQueryMock.mockReset().mockImplementation(async (_reference, args) => {
		const run = queryState.runsById[args.runId] ?? queryState.run;
		return {
			page: (run?.movedNodeIds ?? []).map((id) => make_item({ state: "completed", movedNodeId: id })),
			isDone: true,
			continueCursor: "",
		};
	});
	vi.spyOn(app_convex, "mutation").mockImplementation(mutationMock);
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
		expect(press_key({ target: navigation, key: "c" })).toBe(false);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		for (const name of ["Rename file", "Search notes", "Editable note", "Chat message"]) {
			const input = screen.getByLabelText(name);
			for (const key of ["c", "x", "v"]) expect(press_key({ target: input, key })).toBe(true);
		}
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
	});

	test("Escape clears an idle cut and leaves Copy ready", async () => {
		render(<TestClipboard />);
		await act(async () => {});
		const navigation = screen.getByRole("group", { name: "File navigation" });
		press_key({ target: navigation, key: "c" });
		expect(press_key({ target: navigation, key: "Escape", ctrlKey: false })).toBe(true);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
		press_key({ target: navigation, key: "x" });
		expect(press_key({ target: navigation, key: "Escape", ctrlKey: false })).toBe(false);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty");
	});

	test("disables Paste without destination write permission", async () => {
		render(<TestClipboard blocked />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		expect(await press_paste()).toBe(true);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each([undefined, [make_run()]])(
		"waits while the current workspace run is loading or active: %s",
		async (runs) => {
			queryState.runs = runs;
			render(<TestClipboard />);
			fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
			expect(await press_paste()).toBe(true);
			expect(mutationMock).not.toHaveBeenCalled();
		},
	);

	test("sends Cut through paged intake and seal", async () => {
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await screen.findByRole("dialog");
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership",
			requestId: expect.any(String),
			kind: "move",
			expectedSourceCount: 2,
			sourceIds: [SOURCE_ID, SECOND_ID],
			targetParentId: TARGET_ID,
		});
		expect(getFunctionName(mutationMock.mock.calls[1]![0])).toBe("files_transfer:seal");
	});

	test("starts one request with source IDs and keeps Copy after completion", async () => {
		const response = Promise.withResolvers<{ _yay: { runId: typeof RUN_ID } }>();
		mutationMock.mockReturnValue(response.promise);
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		await press_paste();
		await press_paste();
		expect(mutationMock).toHaveBeenCalledOnce();
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:start");
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			membershipId: "membership",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [SOURCE_ID],
			targetParentId: TARGET_ID,
			requestId: expect.any(String),
		});
		await act(async () => response.resolve({ _yay: { runId: RUN_ID } }));
		push_run(make_run({ status: "succeeded", progress: { completed: 2 } }));
		expect(view.getByLabelText("Clipboard sources").textContent).toBe(SOURCE_ID);
	});

	test("removes only moved cut IDs and preserves a newer clipboard", async () => {
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		push_run(
			make_run({
				kind: "move",
				status: "succeeded",
				progress: { completed: 1, skipped: 1 },
				movedNodeIds: [SOURCE_ID],
			}),
		);
		await waitFor(() => expect(view.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID));
		cleanup();
		queryState.run = undefined;
		queryState.runs = [];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		const response = Promise.withResolvers<{ _yay: { runId: typeof RUN_ID } }>();
		mutationMock.mockReturnValue(response.promise);
		await press_paste();
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		await act(async () => response.resolve({ _yay: { runId: RUN_ID } }));
		push_run(
			make_run({ kind: "move", status: "succeeded", progress: { completed: 2 }, movedNodeIds: [SOURCE_ID, SECOND_ID] }),
		);
		await waitFor(() => expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID));
	});

	test("updates cut IDs while the dialog shows an older operation", async () => {
		queryState.runsById[OLD_RUN_ID] = make_run({ _id: OLD_RUN_ID, status: "succeeded", progress: { completed: 2 } });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		fireEvent.click(screen.getByRole("button", { name: "Review older operation" }));
		push_run(
			make_run({
				kind: "move",
				status: "succeeded",
				progress: { completed: 1, skipped: 1 },
				movedNodeIds: [SOURCE_ID],
			}),
		);
		expect(screen.getByRole("heading", { name: "Copy files" })).toBeTruthy();
		await waitFor(() => expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID));
	});

	test("reuses the request ID after a lost start response", async () => {
		mutationMock.mockRejectedValueOnce(new Error("offline"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		await press_paste();
		fireEvent.click(await screen.findByRole("button", { name: "Retry Paste" }));
		expect(mutationMock.mock.calls[1]![1]).toEqual(mutationMock.mock.calls[0]![1]);
		// A one-file paste opens no dialog. Its Activity card can still open it.
		await waitFor(() => expect(getFunctionName(mutationMock.mock.lastCall![0])).toBe("files_transfer:seal"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test.each(["Copy", "Cut"])("sends all %s pages before sealing", async (mode) => {
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: `${mode} many sources` }));
		await press_paste();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(4));
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
			"files_transfer:start",
			"files_transfer:append_sources",
			"files_transfer:append_sources",
			"files_transfer:seal",
		]);
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			kind: mode === "Cut" ? "move" : "copy",
			expectedSourceCount: 205,
			sourceIds: MANY_SOURCE_IDS.slice(0, 100),
		});
		for (const [index, offset] of [100, 200].entries()) {
			expect(mutationMock.mock.calls[index + 1]![1]).toEqual({
				membershipId: "membership",
				runId: RUN_ID,
				offset,
				sourceIds: MANY_SOURCE_IDS.slice(offset, offset + 100),
			});
		}
		expect(mutationMock.mock.calls[3]![1]).toEqual({ membershipId: "membership", runId: RUN_ID });
	});

	test("saves a drag selection before upload and keeps the clipboard", async () => {
		const saved = Promise.withResolvers<void>();
		intakeSaveMock.mockImplementationOnce(async ({ request, sourceIds }) => {
			await saved.promise;
			intakeState.request = { ...request };
			intakeState.sourceIds = [...sourceIds];
		});
		render(<TestClipboard />);
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		fireEvent.click(screen.getByRole("button", { name: "Drag many sources" }));
		expect(intakeSaveMock).toHaveBeenCalledWith({
			request: expect.objectContaining({
				userId: "user",
				membershipId: "membership",
				revision: null,
				sourceCount: 205,
			}),
			sourceIds: MANY_SOURCE_IDS,
		});
		expect(mutationMock).not.toHaveBeenCalled();
		await act(async () => saved.resolve());
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(4));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			kind: "move",
			expectedSourceCount: 205,
			sourceIds: MANY_SOURCE_IDS.slice(0, 100),
		});
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
	});

	test("resumes the same Move and exact pages after a reload with a lost page reply", async () => {
		let loseReply = true;
		mutationMock.mockImplementation(async (reference) => {
			if (getFunctionName(reference) === "files_transfer:append_sources" && loseReply) {
				loseReply = false;
				throw new Error("offline");
			}
			return { _yay: { runId: RUN_ID } };
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut many sources" }));
		await press_paste();
		await screen.findByRole("button", { name: "Retry Paste" });
		const originalStart = mutationMock.mock.calls[0]![1];
		const originalPage = mutationMock.mock.calls[1]![1];
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		cleanup();
		render(<TestClipboard />);
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		const starts = mutationMock.mock.calls.filter(
			([reference]) => getFunctionName(reference) === "files_transfer:start",
		);
		const pages = mutationMock.mock.calls.filter(
			([reference]) => getFunctionName(reference) === "files_transfer:append_sources",
		);
		expect(starts).toHaveLength(2);
		expect(starts[1]![1]).toEqual(originalStart);
		expect(pages[1]![1]).toEqual(originalPage);
		expect(pages[2]![1]).toMatchObject({ offset: 200, sourceIds: MANY_SOURCE_IDS.slice(200) });
		expect(getFunctionName(mutationMock.mock.lastCall![0])).toBe("files_transfer:seal");
	});

	test.each(["running", "succeeded"] as const)(
		"retires accepted Move input already sealed in another tab while %s",
		async (status) => {
			intakeState.request = {
				userId: "user",
				membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
				requestId: "saved-request",
				revision: null,
				sourceCount: 205,
				targetParentId: TARGET_ID,
				runId: RUN_ID,
				stopRequested: false,
			};
			const accepted = make_run({ kind: "move", step: "apply", status });
			intakeQueryMock.mockResolvedValue({ runId: RUN_ID, step: "apply", isFinished: status === "succeeded" });
			queryState.runs = status === "running" ? [accepted] : [];
			render(<TestClipboard />);
			await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
			expect(intakePageMock).not.toHaveBeenCalled();
			expect(mutationMock).not.toHaveBeenCalled();
			expect(screen.queryByRole("alert")).toBeNull();
			push_run(make_run({ kind: "move", status: "succeeded" }));
			await waitFor(() => expect(screen.getByLabelText("Paste busy").textContent).toBe("false"));
			fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
			await press_paste();
			await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		},
	);

	test("clears local intake when another tab seals during a replay reply", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: RUN_ID,
			stopRequested: false,
		};
		intakeState.sourceIds = MANY_SOURCE_IDS;
		const reply = Promise.withResolvers<{ _yay: { runId: typeof RUN_ID } }>();
		let starts = 0;
		let accepted = make_run({ kind: "move", step: "uploading" });
		intakeQueryMock.mockImplementation(async () => ({
			runId: accepted._id,
			step: accepted.step,
			isFinished: accepted.activity.finishedAt !== undefined,
		}));
		mutationMock.mockImplementation(async (reference) => {
			const name = getFunctionName(reference);
			if (name === "files_transfer:start" && ++starts === 2) return reply.promise;
			if (name === "files_transfer:seal") accepted = make_run({ kind: "move", status: "succeeded" });
			return { _yay: { runId: RUN_ID } };
		});
		render(
			<>
				<section aria-label="First tab">
					<TestClipboard />
				</section>
				<section aria-label="Second tab">
					<TestClipboard />
				</section>
			</>,
		);
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		expect(intakeState.sourceIds).toEqual([]);
		await act(async () => reply.resolve({ _yay: { runId: RUN_ID } }));
		const secondTab = within(screen.getByRole("region", { name: "Second tab" }));
		await waitFor(() => expect(secondTab.getByLabelText("Paste busy").textContent).toBe("false"));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
			"files_transfer:start",
			"files_transfer:start",
			"files_transfer:append_sources",
			"files_transfer:append_sources",
			"files_transfer:seal",
		]);
		fireEvent.click(secondTab.getByRole("button", { name: "Copy source" }));
		press_key({ target: secondTab.getByRole("group", { name: "File navigation" }), key: "v" });
		await waitFor(() => expect(starts).toBe(3));
	});

	test("keeps a missing Move page error while the server still needs input", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: RUN_ID,
			stopRequested: false,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		await screen.findByRole("button", { name: "Retry Paste" });
		expect(intakeDeleteMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Paste busy").textContent).toBe("true");
	});

	test.each(["Resume Move", "Discard saved Move"])(
		"handles late %s after another tab retired unstarted input",
		async (action) => {
			intakeState.request = {
				userId: "user",
				membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
				requestId: "saved-request",
				revision: null,
				sourceCount: 205,
				targetParentId: TARGET_ID,
				runId: null,
				stopRequested: false,
			};
			intakeState.sourceIds = MANY_SOURCE_IDS;
			let sealed = false;
			intakeQueryMock.mockImplementation(async () =>
				sealed ? { runId: RUN_ID, step: "apply", isFinished: true } : null,
			);
			mutationMock.mockImplementation(async (reference) => {
				if (getFunctionName(reference) === "files_transfer:seal") sealed = true;
				return { _yay: { runId: RUN_ID } };
			});
			render(
				<>
					<section aria-label="First tab">
						<TestClipboard />
					</section>
					<section aria-label="Second tab">
						<TestClipboard />
					</section>
				</>,
			);
			const firstTab = within(screen.getByRole("region", { name: "First tab" }));
			const secondTab = within(screen.getByRole("region", { name: "Second tab" }));
			await firstTab.findByRole("button", { name: "Resume Move" });
			await secondTab.findByRole("button", { name: "Resume Move" });
			expect(intakeQueryMock).not.toHaveBeenCalled();
			fireEvent.click(firstTab.getByRole("button", { name: "Resume Move" }));
			await waitFor(() => expect(intakeState.request).toBeNull());
			const pagesRead = intakePageMock.mock.calls.length;
			fireEvent.click(secondTab.getByRole("button", { name: action }));
			await waitFor(() =>
				expect(secondTab.getByLabelText("Paste busy").textContent, "late action retires the accepted request").toBe(
					"false",
				),
			);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(intakePageMock).toHaveBeenCalledTimes(pagesRead);
			expect(intakeQueryMock.mock.lastCall![1]).toEqual({ membershipId: "membership", requestId: "saved-request" });
			expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
				"files_transfer:start",
				"files_transfer:append_sources",
				"files_transfer:append_sources",
				"files_transfer:seal",
				...(action === "Discard saved Move" ? ["files_transfer:stop"] : []),
			]);
		},
	);

	test("retries late Discard after a lost Stop reply and reload without pages", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: null,
			stopRequested: false,
		};
		intakeState.sourceIds = MANY_SOURCE_IDS;
		let sealed = false;
		let loseStopReply = true;
		intakeQueryMock.mockImplementation(async () =>
			sealed ? { runId: RUN_ID, step: "apply", isFinished: true } : null,
		);
		mutationMock.mockImplementation(async (reference) => {
			const name = getFunctionName(reference);
			if (name === "files_transfer:seal") sealed = true;
			if (name === "files_transfer:stop" && loseStopReply) {
				loseStopReply = false;
				throw new Error("offline");
			}
			return { _yay: { runId: RUN_ID } };
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			<>
				<section aria-label="First tab">
					<TestClipboard />
				</section>
				<section aria-label="Second tab">
					<TestClipboard />
				</section>
			</>,
		);
		const firstTab = within(screen.getByRole("region", { name: "First tab" }));
		const secondTab = within(screen.getByRole("region", { name: "Second tab" }));
		await firstTab.findByRole("button", { name: "Resume Move" });
		await secondTab.findByRole("button", { name: "Discard saved Move" });
		fireEvent.click(firstTab.getByRole("button", { name: "Resume Move" }));
		await waitFor(() => expect(intakeState.request).toBeNull());
		fireEvent.click(secondTab.getByRole("button", { name: "Discard saved Move" }));
		await secondTab.findByRole("button", { name: "Retry Stop" });
		expect(intakeState.request, "the lost Stop reply keeps a header for reload").toMatchObject({
			runId: RUN_ID,
			stopRequested: true,
		});
		expect(intakeState.sourceIds).toEqual([]);
		const pagesRead = intakePageMock.mock.calls.length;
		const queries = intakeQueryMock.mock.calls.length;
		cleanup();
		render(<TestClipboard />);
		await waitFor(() => expect(intakeState.request).toBeNull());
		expect(intakePageMock).toHaveBeenCalledTimes(pagesRead);
		expect(intakeQueryMock).toHaveBeenCalledTimes(queries);
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
			"files_transfer:start",
			"files_transfer:append_sources",
			"files_transfer:append_sources",
			"files_transfer:seal",
			"files_transfer:stop",
			"files_transfer:stop",
		]);
	});

	test.each(["user", "membership"])("does not resume another %s scope", async (changedScope) => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: RUN_ID,
			stopRequested: false,
		};
		intakeState.sourceIds = MANY_SOURCE_IDS;
		if (changedScope === "user") authState.userId = "another-user";
		render(<TestClipboard membershipId={changedScope === "membership" ? "another-membership" : "membership"} />);
		await waitFor(() => expect(screen.getByLabelText("Paste busy").textContent).toBe("false"));
		expect(mutationMock).not.toHaveBeenCalled();
		expect(intakeDeleteMock).not.toHaveBeenCalled();
	});

	test("asks before starting an old unstarted Move after same-ID reinvite", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-before-reinvite",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: null,
			stopRequested: false,
		};
		intakeState.sourceIds = MANY_SOURCE_IDS;
		render(<TestClipboard />);
		const resume = await screen.findByRole("button", { name: "Resume Move" });
		expect(mutationMock).not.toHaveBeenCalled();
		fireEvent.click(resume);
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			requestId: "saved-before-reinvite",
			kind: "move",
			sourceIds: MANY_SOURCE_IDS.slice(0, 100),
		});
	});

	test("discards unstarted input without starting a run", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: null,
			stopRequested: false,
		};
		intakeState.sourceIds = MANY_SOURCE_IDS;
		render(<TestClipboard />);
		fireEvent.click(await screen.findByRole("button", { name: "Discard saved Move" }));
		await waitFor(() => expect(intakeState.request, "Discard deletes the saved input").toBeNull());
		expect(intakeQueryMock).toHaveBeenCalledOnce();
		expect(
			mutationMock.mock.calls.map(([reference]) => getFunctionName(reference)),
			"Discard starts no server run",
		).toEqual([]);
		expect(intakeUpdateMock.mock.calls[0]![0]).toMatchObject({ stopRequested: true });
		expect(screen.getByLabelText("Paste busy").textContent).toBe("false");
	});

	test("keeps Copy working when browser storage fails", async () => {
		const storageError = new Error("Move storage could not be opened.");
		intakeLoadMock.mockRejectedValue(storageError);
		intakeSaveMock.mockRejectedValue(storageError);
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		await waitFor(() =>
			expect(screen.getByLabelText("Paste busy").textContent, "a failed load does not block Paste").toBe("false"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Drag many sources" }));
		await waitFor(() => expect(intakeSaveMock).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(screen.getByLabelText("Paste busy").textContent, "a failed Move save does not block Paste").toBe("false"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		await press_paste();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({ kind: "copy", sourceIds: [SOURCE_ID] });
	});

	test("resumes only an unconfirmed Move Stop after reload", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "saved-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: RUN_ID,
			stopRequested: true,
		};
		intakeQueryMock.mockResolvedValue({ runId: RUN_ID, step: "apply", isFinished: true });
		render(<TestClipboard />);
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		expect(intakeQueryMock).not.toHaveBeenCalled();
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual(["files_transfer:stop"]);
	});

	test("retires a Stop-only header after the server confirms a missing run", async () => {
		intakeState.request = {
			userId: "user",
			membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
			requestId: "expired-request",
			revision: null,
			sourceCount: 205,
			targetParentId: TARGET_ID,
			runId: RUN_ID,
			stopRequested: true,
		};
		const stopped = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValueOnce(stopped.promise);
		intakeQueryMock.mockResolvedValue(null);
		render(<TestClipboard />);
		await waitFor(() => expect(mutationMock).toHaveBeenCalledOnce());
		expect(screen.getByLabelText("Paste busy").textContent).toBe("true");
		expect(intakeState.request?.stopRequested).toBe(true);
		await act(async () => stopped.resolve({ _yay: null }));
		await waitFor(() => {
			expect(intakeState.request, "confirmed Stop removes the expired request's local header").toBeNull();
			expect(screen.getByLabelText("Paste busy").textContent, "confirmed Stop allows a new Move").toBe("false");
		});
		expect(intakePageMock).not.toHaveBeenCalled();
		expect(intakeQueryMock).not.toHaveBeenCalled();
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual(["files_transfer:stop"]);
	});

	test("drains every completed Cut page before allowing another Paste", async () => {
		const lastPage = Promise.withResolvers<TransferItemPage>();
		receiptQueryMock.mockImplementation(async (_reference, args) => {
			if (args.paginationOpts.cursor === "last") return lastPage.promise;
			const offset = args.paginationOpts.cursor === "second" ? 100 : 0;
			return {
				page: MANY_SOURCE_IDS.slice(offset, offset + 100).map((id) =>
					make_item({ state: "completed", movedNodeId: id, source: null, output: null }),
				),
				isDone: false,
				continueCursor: offset === 0 ? "second" : "last",
			};
		});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut many sources" }));
		await press_paste();
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		push_run(make_run({ kind: "move", status: "succeeded", progress: { completed: 205, total: 205 } }));
		await waitFor(() => expect(receiptQueryMock).toHaveBeenCalledTimes(3));
		expect(screen.getByLabelText("Paste busy").textContent).toBe("true");
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(MANY_SOURCE_IDS.join(","));
		await press_paste();
		expect(mutationMock).toHaveBeenCalledTimes(4);
		await act(async () =>
			lastPage.resolve({
				page: MANY_SOURCE_IDS.slice(200).map((id) =>
					make_item({ state: "completed", movedNodeId: id, source: null, output: null }),
				),
				isDone: true,
				continueCursor: "",
			}),
		);
		await waitFor(() => expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty"));
		expect(screen.getByLabelText("Paste busy").textContent).toBe("false");
		expect(receiptQueryMock.mock.calls.map(([, args]) => args.paginationOpts.cursor)).toEqual([null, "second", "last"]);
		expect(receiptQueryMock.mock.calls.every(([, args]) => args.state === "completed")).toBe(true);
	});

	test("retries the failed Cut receipt page without touching a newer clipboard", async () => {
		const nextPage = Promise.withResolvers<TransferItemPage>();
		let failPage = true;
		receiptQueryMock.mockImplementation(async (_reference, args) => {
			if (args.paginationOpts.cursor === null)
				return {
					page: [make_item({ state: "completed", movedNodeId: SOURCE_ID })],
					isDone: false,
					continueCursor: "next",
				};
			if (failPage) {
				failPage = false;
				throw new Error("offline");
			}
			return nextPage.promise;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await waitFor(() => expect(intakeDeleteMock).toHaveBeenCalledOnce());
		push_run(make_run({ kind: "move", status: "succeeded", progress: { completed: 2 } }));
		fireEvent.click(await screen.findByRole("button", { name: "Retry clearing Cut" }));
		await waitFor(() => expect(receiptQueryMock).toHaveBeenCalledTimes(3));
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		await act(async () =>
			nextPage.resolve({
				page: [make_item({ state: "completed", movedNodeId: SECOND_ID })],
				isDone: true,
				continueCursor: "",
			}),
		);
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
		expect(screen.queryByText("Clearing completed Cut items…")).toBeNull();
		expect(receiptQueryMock.mock.calls.map(([, args]) => args.paginationOpts.cursor)).toEqual([null, "next", "next"]);
	});

	test.each(["files_transfer:append_sources", "files_transfer:seal"])(
		"replays the same Copy after a lost %s reply",
		async (lostDoor) => {
			let loseReply = true;
			mutationMock.mockImplementation(async (reference) => {
				if (getFunctionName(reference) === lostDoor && loseReply) {
					loseReply = false;
					throw new Error("offline");
				}
				return { _yay: { runId: RUN_ID } };
			});
			vi.spyOn(console, "error").mockImplementation(() => {});
			render(<TestClipboard />);
			fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
			await press_paste();
			await screen.findByRole("button", { name: "Retry Paste" });
			push_run(make_run({ step: "uploading", progress: { discovered: 0, total: null } }));
			fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
			fireEvent.click(screen.getByRole("button", { name: "Retry Paste" }));
			await waitFor(() => expect(screen.queryByRole("button", { name: "Retry Paste" })).toBeNull());
			const starts = mutationMock.mock.calls.filter(
				([reference]) => getFunctionName(reference) === "files_transfer:start",
			);
			expect(starts).toHaveLength(2);
			expect(starts[1]![1]).toEqual(starts[0]![1]);
			const pages = mutationMock.mock.calls.filter(([reference]) => getFunctionName(reference) === lostDoor);
			expect(pages[1]![1]).toEqual(pages[0]![1]);
			expect(getFunctionName(mutationMock.mock.lastCall![0])).toBe("files_transfer:seal");
			expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID);
		},
	);

	test("keeps an uncertain request when the clipboard changes", async () => {
		mutationMock.mockRejectedValueOnce(new Error("offline"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
		await press_paste();
		await screen.findByRole("button", { name: "Retry Paste" });
		fireEvent.click(screen.getByRole("button", { name: "Copy another source" }));
		expect(await press_paste()).toBe(true);
		expect(mutationMock).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Retry Paste" }));
		expect(mutationMock.mock.calls[1]![1]).toEqual(mutationMock.mock.calls[0]![1]);
		await waitFor(() => expect(getFunctionName(mutationMock.mock.lastCall![0])).toBe("files_transfer:seal"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("waits for the page reply before sending the next page and seal", async () => {
		const page = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockResolvedValueOnce({ _yay: { runId: RUN_ID } }).mockReturnValueOnce(page.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
		await press_paste();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(await press_paste()).toBe(true);
		expect(mutationMock).toHaveBeenCalledTimes(2);
		await act(async () => page.resolve({ _yay: null }));
		expect(mutationMock).toHaveBeenCalledTimes(4);
		expect(getFunctionName(mutationMock.mock.lastCall![0])).toBe("files_transfer:seal");
	});

	test("retries only Stop after a refused page and a lost Stop reply", async () => {
		let loseReply = true;
		mutationMock.mockImplementation(async (reference) => {
			const name = getFunctionName(reference);
			if (name === "files_transfer:append_sources") return { _nay: { message: "Permission denied" } };
			if (name === "files_transfer:stop" && loseReply) {
				loseReply = false;
				throw new Error("offline");
			}
			return { _yay: { runId: RUN_ID } };
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
		await press_paste();
		expect((await screen.findByRole("alert")).textContent).toContain("Stop was not confirmed");
		fireEvent.click(screen.getByRole("button", { name: "Retry Stop" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
			"files_transfer:start",
			"files_transfer:append_sources",
			"files_transfer:stop",
			"files_transfer:stop",
		]);
		expect(mutationMock.mock.calls[3]![1]).toEqual(mutationMock.mock.calls[2]![1]);
	});

	test.each(["files_transfer:append_sources", "files_transfer:seal"])(
		"stops accepted Copy after a known %s refusal",
		async (door) => {
			mutationMock.mockImplementation(async (reference) =>
				getFunctionName(reference) === door ? { _nay: { message: "Permission denied" } } : { _yay: { runId: RUN_ID } },
			);
			render(<TestClipboard />);
			fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
			await press_paste();
			await waitFor(() =>
				expect(
					mutationMock.mock.calls.some(([reference]) => getFunctionName(reference) === "files_transfer:stop"),
				).toBe(true),
			);
			expect(mutationMock.mock.lastCall![1]).toEqual({ membershipId: "membership", runId: RUN_ID });
			expect(toastErrorMock).toHaveBeenCalledWith("Permission denied");
			expect(screen.queryByRole("button", { name: "Retry Paste" })).toBeNull();
		},
	);

	test("stops incomplete Copy when the workspace changes during a page", async () => {
		const page = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockImplementation((reference) =>
			getFunctionName(reference) === "files_transfer:append_sources"
				? page.promise
				: Promise.resolve({ _yay: { runId: RUN_ID } }),
		);
		const view = render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
		await press_paste();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		view.rerender(<TestClipboard membershipId="another-membership" />);
		await act(async () => page.resolve({ _yay: null }));
		expect(mutationMock.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
			"files_transfer:start",
			"files_transfer:append_sources",
			"files_transfer:stop",
		]);
		expect(mutationMock.mock.lastCall![1]).toEqual({ membershipId: "membership", runId: RUN_ID });
		expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty");
	});

	test("does not seal while Stop is pending", async () => {
		const page = Promise.withResolvers<{ _yay: null }>();
		const stopped = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockImplementation((reference) => {
			const name = getFunctionName(reference);
			return name === "files_transfer:append_sources"
				? page.promise
				: name === "activities:request_stop"
					? stopped.promise
					: Promise.resolve({ _yay: { runId: RUN_ID } });
		});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Copy many sources" }));
		await press_paste();
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		push_run(make_run({ step: "uploading", progress: { discovered: 0, total: null } }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await act(async () => page.resolve({ _yay: null }));
		expect(mutationMock.mock.calls.some(([reference]) => getFunctionName(reference) === "files_transfer:seal")).toBe(
			false,
		);
		await act(async () => stopped.resolve({ _yay: null }));
	});

	test("clears the remaining cut IDs after a retry finishes", async () => {
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		push_run(
			make_run({
				kind: "move",
				status: "partial",
				movedNodeIds: [SOURCE_ID],
				progress: { completed: 1, failed: 1 },
				controls: { canStop: false, canRetry: true, canDismiss: true },
			}),
		);
		await waitFor(() => expect(screen.getByLabelText("Clipboard sources").textContent).toBe(SECOND_ID));
		mutationMock.mockResolvedValue({ _yay: { runId: OLD_RUN_ID } });
		fireEvent.click(screen.getByRole("button", { name: "Retry remaining files" }));
		await waitFor(() => expect(screen.getByRole("heading", { name: "Paste files" })).toBeTruthy());
		push_run(
			make_run({
				_id: OLD_RUN_ID,
				kind: "move",
				status: "succeeded",
				movedNodeIds: [SECOND_ID],
				progress: { completed: 1 },
			}),
		);
		await waitFor(() => expect(screen.getByLabelText("Clipboard sources").textContent).toBe("empty"));
	});
});

describe("FilesTransferRunModal", () => {
	test("opens a full conflict page without reading the completed item pages", async () => {
		queryState.run = make_run({ kind: "move", status: "awaiting_input" });
		queryState.itemPages.first = {
			page: Array.from({ length: 50 }, (_, index) =>
				make_item({
					itemId: `completed-${index}` as app_convex_Id<"files_transfer_items">,
					state: "completed",
					source: null,
				}),
			),
			isDone: false,
			continueCursor: "completed-page-2",
		};
		queryState.itemPages["conflict:first"] = {
			page: Array.from({ length: 50 }, (_, index) =>
				make_item({
					itemId: `conflict-${index}` as app_convex_Id<"files_transfer_items">,
					source: {
						target: { kind: "saved", id: SOURCE_ID },
						name: `conflict-${index}.md`,
						path: `/conflict-${index}.md`,
					},
				}),
			),
			isDone: true,
			continueCursor: "",
		};
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(itemQueryMock).toHaveBeenLastCalledWith({
			membershipId: "membership",
			runId: RUN_ID,
			state: "conflict",
			paginationOpts: { numItems: 50, cursor: null },
		});
		expect(screen.getByText("/conflict-49.md")).toBeTruthy();
		expect(screen.getAllByRole("radio", { name: "Keep both" }).length).toBeGreaterThanOrEqual(50);
		expect(screen.queryByText("Page 2")).toBeNull();
	});

	test.each(["uploading", "select", "normalize"] as const)(
		"shows selection loading without output counts at %s",
		async (step) => {
			queryState.run = make_run({ step, progress: { discovered: 0, total: null } });
			queryState.runs = [queryState.run];
			render(<TestClipboard />);
			fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
			expect(screen.getByText(step === "uploading" ? "Loading selection…" : "Checking files…")).toBeTruthy();
			expect(screen.getByText("File counts appear after the selection is checked.")).toBeTruthy();
			expect(screen.queryByText(/0 copied/)).toBeNull();
			expect(screen.queryByText("No items on this page.")).toBeNull();
			if (step === "uploading") expect(screen.getByText(/If you reload, stop this request in Activity/)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Stop" }));
			await waitFor(() => expect(mutationMock).toHaveBeenCalledOnce());
			expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("activities:request_stop");
		},
	);

	test("shows a pending Stop before the run details load", async () => {
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Stop operation" }));
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("activities:request_stop");
		expect(mutationMock.mock.calls[0]![1]).toEqual({ membershipId: "membership", activityId: "activity" });
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(await screen.findByText("Stop requested. Waiting for the server…")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Paste files" })).toBeTruthy();
		expect(screen.queryByText("Loading…")).toBeNull();

		await act(async () => response.resolve({ _yay: null }));
		push_run(make_run({ status: "canceled" }));
		expect(screen.getByText("Stopped.")).toBeTruthy();
	});

	test("keeps Stop pending when the dialog is hidden and reopened", async () => {
		queryState.run = make_run({ status: "awaiting_input", progress: { completed: 1 } });
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
		push_run(make_run({ _id: OLD_RUN_ID, status: "succeeded", progress: { completed: 2 } }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		fireEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })[0]!);
		push_run(make_run({ status: "awaiting_input", progress: { completed: 1 } }));
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(await screen.findByText("Stop requested. Waiting for the server…")).toBeTruthy();

		push_run(make_run({ status: "stopping", progress: { completed: 1 } }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		expect(screen.getByText("Stopping…")).toBeTruthy();
		await act(async () => response.resolve({ _yay: null }));
		push_run(make_run({ status: "canceled", progress: { completed: 1 } }));
		expect(screen.getByText("Stopped.")).toBeTruthy();
		expect(mutationMock).toHaveBeenCalledTimes(1);
	});

	test.each([
		["succeeded", "Completed."],
		["partial", "Some files completed."],
		["canceled", "Stopped."],
		["failed", "Failed."],
		["timed_out", "Timed out."],
	] as const)("shows the saved %s result while Stop is pending", async (status, label) => {
		queryState.run = make_run();
		queryState.runs = [queryState.run];
		const response = Promise.withResolvers<{ _yay: null }>();
		mutationMock.mockReturnValue(response.promise);
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
		expect(screen.getByText("Stop requested. Waiting for the server…")).toBeTruthy();

		push_run(make_run({ status }));
		expect(screen.queryByText("Stop requested. Waiting for the server…")).toBeNull();
		expect(screen.getByText(label)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
		await act(async () => response.resolve({ _yay: null }));
	});

	test("uses a neutral heading while a move is loading", async () => {
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Cut sources" }));
		await press_paste();
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
		expect(screen.getByRole("heading", { name: "Paste files" })).toBeTruthy();
		push_run(make_run({ kind: "move" }));
		expect(screen.getByRole("heading", { name: "Move files" })).toBeTruthy();
	});

	test("submits explicit conflict choices with their revision", async () => {
		queryState.run = make_run({ status: "awaiting_input", revision: 4 });
		queryState.itemPages.first!.page = [make_item()];
		queryState.runs = [queryState.run];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "/report.md" });
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(within(conflict).getByRole("radio", { name: "Keep both" }));
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to remaining file name conflicts" })).getByRole("radio", {
				name: "Skip",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership",
			runId: RUN_ID,
			revision: 4,
			choices: [{ itemId: "item", choice: "keep_both" }],
			applyToRemaining: { file: "skip", folder: null },
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("shows full paths for same-name sources and keeps their choices separate", async () => {
		queryState.run = make_run({ status: "awaiting_input" });
		queryState.itemPages.first!.page = ["a", "b"].map((folder) =>
			make_item({
				itemId: folder as app_convex_Id<"files_transfer_items">,
				source: { target: { kind: "saved", id: SOURCE_ID }, name: "report.md", path: `/${folder}/report.md` },
			}),
		);
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
			applyToRemaining: { file: null, folder: null },
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("offers only Skip for a changed source and hides without stopping", async () => {
		queryState.run = make_run({ status: "awaiting_input", progress: { completed: 1 } });
		queryState.itemPages.first!.page = [make_item({ source: null, conflict: null })];
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

	test("offers Keep both when another item in the same paste claims the name", async () => {
		queryState.run = make_run({ status: "awaiting_input", revision: 4 });
		// Two sources claim the same new name and nothing occupies it yet, so the second item is a
		// name conflict with no destination doc. Replace needs a doc, Keep both and Skip do not.
		queryState.itemPages.first!.page = [
			make_item({
				itemId: "second" as app_convex_Id<"files_transfer_items">,
				source: { target: { kind: "saved", id: SECOND_ID }, name: "report.md", path: "/b/report.md" },
				conflict: null,
			}),
		];
		queryState.runs = [queryState.run];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "/b/report.md" });
		expect(within(conflict).getByText(/Another item in this paste already uses this name/)).toBeTruthy();
		expect(within(conflict).queryByRole("radio", { name: "Replace" })).toBeNull();
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(within(conflict).getByRole("radio", { name: "Keep both" }));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			choices: [{ itemId: "second", choice: "keep_both" }],
		});
	});

	test("clears choices when a new conflict revision arrives", async () => {
		const run = make_run({ status: "awaiting_input" });
		queryState.itemPages.first!.page = [make_item()];
		queryState.run = run;
		queryState.runs = [run];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = await screen.findByRole("group", { name: "/report.md" });
		fireEvent.click(within(conflict).getByRole("radio", { name: "Keep both" }));
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to remaining file name conflicts" })).getByRole("radio", {
				name: "Skip",
			}),
		);
		push_run({ ...run, revision: run.revision + 1 });
		expect(within(conflict).getByRole("radio", { name: "Keep both" }).matches(":checked")).toBe(false);
		expect(
			within(screen.getByRole("group", { name: "Apply to remaining file name conflicts" }))
				.getByRole("radio", { name: "Ask each time" })
				.matches(":checked"),
		).toBe(true);
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
	});

	test("waits for server confirmation when Stop fails", async () => {
		queryState.run = make_run({ progress: { completed: 1 } });
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
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("activities:request_stop");
		expect(mutationMock.mock.calls[0]![1]).toEqual({ membershipId: "membership", activityId: "activity" });
	});

	test("sends the reviewed destination for Replace and offers no Merge for a copied folder", async () => {
		queryState.run = make_run({ status: "awaiting_input" });
		const file = make_item({
			conflict: {
				kind: "name_conflict",
				target: { kind: "private", id: "private-target" as app_convex_Id<"files_pending_nodes"> },
				version: {
					kind: "pending",
					pendingUpdateId: "proposal" as app_convex_Id<"files_pending_updates">,
					revision: 7,
					privateVersion: { creationGeneration: 2, structuralRevision: 3 },
					savedVersion: null,
					contentType: "text/plain",
					textKind: "plain_text",
					collaborationEnabled: false,
				},
				path: "/copies/report.md",
			},
		});
		const folder = make_item({
			itemId: "folder" as app_convex_Id<"files_transfer_items">,
			kind: "folder",
			source: { target: { kind: "saved", id: SECOND_ID }, name: "notes", path: "/notes" },
			conflict: {
				kind: "name_conflict",
				target: { kind: "saved", id: TARGET_ID },
				version: null,
				path: "/copies/notes",
			},
		});
		queryState.itemPages.first!.page = [file, folder];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(screen.getByText("Destination: /copies/report.md")).toBeTruthy();
		fireEvent.click(
			within(screen.getByRole("group", { name: "Apply to remaining file name conflicts" })).getByRole("radio", {
				name: "Replace",
			}),
		);
		const remainingFolders = screen.getByRole("group", { name: "Apply to remaining folder name conflicts" });
		expect(within(remainingFolders).queryByRole("radio", { name: "Merge" })).toBeNull();
		fireEvent.click(within(remainingFolders).getByRole("radio", { name: "Skip" }));
		expect(
			within(screen.getByRole("group", { name: "/report.md" }))
				.getByRole("radio", { name: "Replace" })
				.matches(":checked"),
		).toBe(true);
		const folderGroup = screen.getByRole("group", { name: "/notes" });
		expect(within(folderGroup).queryByRole("radio", { name: "Merge" })).toBeNull();
		expect(within(folderGroup).getByRole("radio", { name: "Skip" }).matches(":checked")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership",
			runId: RUN_ID,
			revision: 1,
			choices: [
				{
					itemId: file.itemId,
					choice: "replace",
					reviewedTarget: file.conflict!.target,
					reviewedVersion: file.conflict!.version,
				},
				{ itemId: folder.itemId, choice: "skip" },
			],
			applyToRemaining: { file: "replace", folder: "skip" },
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("follows an empty page and submits only the conflicts on the current page", async () => {
		queryState.run = make_run({ status: "awaiting_input" });
		queryState.itemPages = {
			first: { page: [], isDone: false, continueCursor: "next" },
			next: { page: [make_item()], isDone: true, continueCursor: "end" },
		};
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(screen.getByText("No items on this page.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(itemQueryMock).toHaveBeenLastCalledWith({
			membershipId: "membership",
			runId: RUN_ID,
			state: "conflict",
			paginationOpts: { numItems: 50, cursor: "next" },
		});
		expect(screen.getByText("Page 2")).toBeTruthy();
		fireEvent.click(within(screen.getByRole("group", { name: "/report.md" })).getByRole("radio", { name: "Skip" }));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({ choices: [{ itemId: "item", choice: "skip" }] });
		await waitFor(() => expect(screen.getByRole("button", { name: "Previous page" }).matches(":disabled")).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		expect(screen.getByText("Page 1")).toBeTruthy();
	});

	test("offers an exact empty-folder replacement for Move without a future merge choice", async () => {
		queryState.run = make_run({ status: "awaiting_input", kind: "move" });
		const item = make_item({ kind: "folder" });
		queryState.itemPages.first!.page = [item];
		mutationMock.mockResolvedValue({ _yay: null });
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		const conflict = screen.getByRole("group", { name: "/report.md" });
		expect(within(conflict).queryByRole("radio", { name: "Merge" })).toBeNull();
		const remaining = screen.getByRole("group", { name: "Apply to remaining folder name conflicts" });
		expect(
			within(remaining)
				.getAllByRole("radio")
				.map((radio) => radio.closest("label")?.textContent),
		).toEqual(["Ask each time", "Keep both", "Skip"]);
		fireEvent.click(within(conflict).getByRole("radio", { name: "Replace empty folder" }));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			choices: [
				{ itemId: item.itemId, choice: "replace", reviewedTarget: item.conflict!.target, reviewedVersion: null },
			],
			applyToRemaining: { file: null, folder: null },
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false));
	});

	test("stops a selected Replace after source access disappears", () => {
		const run = make_run({ status: "awaiting_input" });
		queryState.run = run;
		queryState.itemPages.first!.page = [make_item()];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(within(screen.getByRole("group", { name: "/report.md" })).getByRole("radio", { name: "Replace" }));
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(false);
		queryState.itemPages.first!.page = [make_item({ source: null, conflict: null })];
		push_run(run);
		expect(screen.queryByText("Destination: /copies/report.md")).toBeNull();
		expect(screen.getByRole("button", { name: "Continue" }).matches(":disabled")).toBe(true);
		expect(
			within(screen.getByRole("group", { name: "Unavailable item" })).queryByRole("radio", { name: "Replace" }),
		).toBeNull();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows proposal results with their private destination", () => {
		queryState.run = make_run({ status: "succeeded", publication: "proposal", progress: { completed: 1 } });
		queryState.itemPages.first!.page = [
			make_item({
				state: "completed",
				conflict: null,
				output: {
					target: { kind: "private", id: "draft" as app_convex_Id<"files_pending_nodes"> },
					path: "/copies/report.md",
					name: "report.md",
				},
			}),
		];
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		expect(screen.getByText("Ready for review.")).toBeTruthy();
		expect(within(screen.getByRole("group", { name: "/report.md" })).getByText("Ready for review")).toBeTruthy();
		expect(screen.getByText("Destination: /copies/report.md")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Retry remaining files" })).toBeNull();
	});

	test("reuses a retry request after a lost response and opens the new run", async () => {
		queryState.run = make_run({ status: "failed", controls: { canStop: false, canRetry: true, canDismiss: true } });
		queryState.runsById[OLD_RUN_ID] = make_run({ _id: OLD_RUN_ID });
		mutationMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ _yay: { runId: OLD_RUN_ID } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(<TestClipboard />);
		fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
		fireEvent.click(screen.getByRole("button", { name: "Retry remaining files" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Could not confirm the retry");
		fireEvent.click(screen.getByRole("button", { name: "Retry remaining files" }));
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:retry_remaining");
		expect(mutationMock.mock.calls[1]![1]).toEqual(mutationMock.mock.calls[0]![1]);
		await waitFor(() => expect(itemQueryMock.mock.lastCall?.[0].runId).toBe(OLD_RUN_ID));
	});
});
