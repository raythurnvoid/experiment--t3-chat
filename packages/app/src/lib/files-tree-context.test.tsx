import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { ConvexError, convexToJson } from "convex/values";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "./app-tenant-context.tsx";
import { FilesTreeProvider, files_tree_stream_args } from "./files-tree-context.tsx";
import type { files_DirectoryView, files_SavedStream } from "../../shared/files.ts";

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: (props: { children: ReactNode }) => props.children,
}));

// Skip the query cache. It adds its own listener to each query, and these tests count the pager listeners.
vi.mock("@/hooks/convex-hooks.ts", async (importOriginal) => {
	const { useQueries, useQuery } = await import("convex/react");
	return {
		...(await importOriginal<typeof import("@/hooks/convex-hooks.ts")>()),
		useCachedQueries: useQueries,
		useCachedQuery: useQuery,
	};
});

const results = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
const subscriptions: Array<{ name: string; args: Record<string, unknown> }> = [];
let client: ConvexReactClient;

/**
 * Key one watched query by its name, its args, and its page cursors. The pagination session id and
 * page size change between runs, so they are left out.
 */
function watch_key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as {
		paginationOpts?: { cursor: string | null; endCursor?: string | null };
	};
	// Match Convex's field order, including nested args.
	return JSON.stringify(
		convexToJson({ name, ...rest, cursor: paginationOpts?.cursor, endCursor: paginationOpts?.endCursor }),
	);
}

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };
const IDLE_DIRECTORY_PAGE = { ...EMPTY_PAGE, directoryView: null };

/**
 * The key of one tree stream of a folder: the open one by default, or the restricted twin with
 * `restricted`.
 */
function children_key(args: {
	parentId: string;
	kind: "folder" | "file";
	cursor: string | null;
	archived?: boolean;
	restricted?: boolean;
	stream?: "normal" | "cohort";
	pageView?: files_DirectoryView;
}) {
	const { archived = false, cursor, kind, parentId, restricted = false } = args;
	const streamArgs = files_tree_stream_args({
		membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
		folderId: parentId as app_convex_Id<"files_nodes">,
		kind,
		archived,
		stream: args.stream ?? "normal",
	});

	return watch_key(getFunctionName(app_convex_api.files_tree.list_tree_children), {
		...streamArgs.children(restricted),
		...(cursor === null ? {} : { pageView: args.pageView ?? null }),
		paginationOpts: { cursor },
	});
}

/**
 * Answer the first page of the restricted twins of a folder with an empty, done page, like the server
 * does for a folder with no restricted child.
 */
function receive_empty_twins(parentId: string) {
	for (const kind of ["folder", "file"] as const) {
		receive(children_key({ parentId, kind, cursor: null, restricted: true }), EMPTY_PAGE);
	}
}

function shared_roots_key(args: { principalIndex: 0 | 1 | 2; archived?: boolean; cursor?: string | null; savedStream?: files_SavedStream }) {
	const { archived = false, cursor = null, principalIndex } = args;

	return watch_key(getFunctionName(app_convex_api.files_tree.list_tree_shared_roots), {
		membershipId: "membership_1",
		archived,
		principalIndex,
		savedStream: args.savedStream ?? { kind: "normal", generation: 0 },
		paginationOpts: { cursor },
	});
}

function ancestors_key(nodeId: string) {
	return watch_key(getFunctionName(app_convex_api.files_tree.get_tree_ancestors), {
		membershipId: "membership_1",
		nodeId,
	});
}

function receive(key: string, result: unknown) {
	act(() => {
		const directory = JSON.parse(key).name === getFunctionName(app_convex_api.files_tree.list_tree_children);
		results.set(key, directory && result !== null && typeof result === "object" && !(result instanceof Error)
			? { directoryView: null, ...result } : result);
		listeners.get(key)?.forEach((listener) => listener());
	});
}

function row(id: string, parentId = "root") {
	return { _id: id, parentId, name: id, archiveOperationId: null };
}

function locked_row(id: string, parentId = "root") {
	return { ...row(id, parentId), locked: true };
}

function FoldersConsumer(props: { folderIds: string[]; archived?: boolean; pinnedNodeIds?: string[] }) {
	const folders = FilesTreeProvider.useFolders({
		folderIds: props.folderIds as app_convex_Id<"files_nodes">[],
		archived: props.archived ?? false,
		pinnedNodeIds: props.pinnedNodeIds ?? [],
	});
	return (
		<>
			<output aria-label="Rows">
				{folders.rows === undefined ? "Loading files" : folders.rows.map((node) => node.name).join(",")}
			</output>
			<output aria-label="Status">
				{[...folders.statusByFolderId].map(([folderId, status]) => `${folderId}:${status}`).join(",")}
			</output>
			<output aria-label="Hoisted">{[...folders.hoistedIds].join(",")}</output>
			<output aria-label="Shared">
				{`${folders.sharedRoots.rows.map((node) => node._id).join(",")}:${folders.sharedRoots.status}`}
			</output>
			<button type="button" onClick={() => folders.sharedRoots.loadMore()}>
				More shared
			</button>
			{props.folderIds.map((folderId) => (
				<button
					key={folderId}
					type="button"
					onClick={() => folders.loadMore(folderId as app_convex_Id<"files_nodes">)}
				>{`More ${folderId}`}</button>
			))}
		</>
	);
}

function TestWorkspace(props: { membershipId: string; children?: ReactNode }) {
	return (
		<ConvexProvider client={client}>
			<AppTenantProvider
				userId={"user_1" as app_convex_Id<"users">}
				membershipId={props.membershipId as app_convex_Id<"organizations_workspaces_users">}
				workspaceId={"workspace_1" as app_convex_Id<"organizations_workspaces">}
				workspaceName="home"
				organizationId={"organization_1" as app_convex_Id<"organizations">}
				organizationName="team"
			>
				{props.children}
			</AppTenantProvider>
		</ConvexProvider>
	);
}

beforeEach(() => {
	results.clear();
	listeners.clear();
	subscriptions.length = 0;
	results.set(watch_key(getFunctionName(app_convex_api.files_tree.get_workspace_move_view), { membershipId: "membership_1" }), {
		cohortId: null, view: null, generation: 0, searchGeneration: 0,
	});
	client = new ConvexReactClient("https://tree-test.convex.cloud");
	// Keep the real pagination and subscription hooks. Only replace the server watches.
	vi.spyOn(client, "watchQuery").mockImplementation((query, args?, _options?) => {
		const key = watch_key(getFunctionName(query), args as Record<string, unknown>);
		const page = args?.paginationOpts as { cursor?: string | null; endCursor?: string | null } | undefined;
		return {
			onUpdate: (callback) => {
				subscriptions.push({ name: getFunctionName(query), args: args as Record<string, unknown> });
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(key, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => (results.has(key) ? results.get(key) :
				(getFunctionName(query) === "files_tree:list_tree_children" && args?.stream === "cohort" && page?.cursor === null && page.endCursor == null
					? IDLE_DIRECTORY_PAGE : undefined)) as never,
			localQueryLogs: () => undefined,
			journal: () => undefined,
		};
	});
});

afterEach(async () => {
	vi.useRealTimers();
	cleanup();
	await client.close();
	vi.restoreAllMocks();
});

describe("FilesTreeProvider.useFolders", () => {
	test("starts directory pages before the workspace Move view answers", () => {
		results.delete(watch_key(getFunctionName(app_convex_api.files_tree.get_workspace_move_view), { membershipId: "membership_1" }));
		render(<TestWorkspace membershipId="membership_1"><FoldersConsumer folderIds={[]} /></TestWorkspace>);
		const key = watch_key(getFunctionName(app_convex_api.files_tree.list_tree_children), {
			membershipId: "membership_1", parentId: "root", kind: "folder", archived: false, restricted: false,
			stream: "normal", paginationOpts: { cursor: null },
		});
		expect(listeners.get(key)?.size, "directory pages do not wait for the workspace Move view").toBe(1);
	});

	test("finishes empty when directory access is refused", () => {
		results.set(watch_key(getFunctionName(app_convex_api.files_tree.get_workspace_move_view), { membershipId: "membership_1" }), null);
		for (const kind of ["folder", "file"] as const) {
			for (const restricted of [false, true]) results.set(children_key({ parentId: "root", kind, cursor: null, restricted }), IDLE_DIRECTORY_PAGE);
		}
		render(<TestWorkspace membershipId="membership_1"><FoldersConsumer folderIds={[]} /></TestWorkspace>);
		expect(screen.getByLabelText("Rows").textContent).toBe("");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
		expect(screen.getByLabelText("Shared").textContent).toBe(":done");
	});

	test("merges normal and selected rows in the tree", () => {
		const cohortId = "cohort_1" as app_convex_Id<"files_move_cohorts">;
		const directoryView = { cohortId, view: "before" } as const;
		for (const stream of ["normal", "cohort"] as const) {
			for (const kind of ["folder", "file"] as const) {
				for (const restricted of [false, true]) results.set(children_key({ parentId: "root", kind, cursor: null, restricted, stream }), { ...EMPTY_PAGE, directoryView });
			}
		}
		results.set(children_key({ parentId: "root", kind: "file", cursor: null }), { ...EMPTY_PAGE, directoryView, page: [row("b.md")] });
		const cohortKey = children_key({ parentId: "root", kind: "file", cursor: null, stream: "cohort" });
		results.set(cohortKey, { ...EMPTY_PAGE, directoryView, page: [row("a.md")] });
		render(<TestWorkspace membershipId="membership_1"><FoldersConsumer folderIds={[]} /></TestWorkspace>);
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
		receive(cohortKey, { ...EMPTY_PAGE, directoryView: { cohortId, view: "after" }, page: [row("c.md")] });
		expect(screen.getByLabelText("Rows").textContent, "different directory views never form one tree").toBe("a.md,b.md");
		for (const stream of ["normal", "cohort"] as const) {
			for (const kind of ["folder", "file"] as const) {
				for (const restricted of [false, true]) {
					const page = restricted || kind === "folder" ? [] : [row(stream === "normal" ? "b.md" : "c.md")];
					receive(children_key({ parentId: "root", kind, cursor: null, restricted, stream }), {
						...EMPTY_PAGE, directoryView: { cohortId, view: "after" }, page,
					});
				}
			}
		}
		expect(screen.getByLabelText("Rows").textContent).toBe("b.md,c.md");
	});

	test("keeps Show more rows when a Move puts them in an earlier cohort stream", async () => {
		const files = Array.from({ length: 400 }, (_, index) => row(`b-${String(index).padStart(3, "0")}.md`));
		const afterFiles = [{ ...files[399]!, name: "a-moved.md" }, ...files.slice(0, 399)];
		const firstKey = children_key({ parentId: "root", kind: "file", cursor: null });
		const oldNextKey = children_key({ parentId: "root", kind: "file", cursor: "normal-next" });
		for (const kind of ["folder", "file"] as const)
			for (const restricted of [false, true])
				results.set(children_key({ parentId: "root", kind, restricted, cursor: null }), IDLE_DIRECTORY_PAGE);
		results.set(firstKey, { page: files.slice(0, 200), isDone: false, continueCursor: "normal-next", directoryView: null });
		results.set(oldNextKey, { ...IDLE_DIRECTORY_PAGE, page: files.slice(200) });
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={["root"]} />
			</TestWorkspace>,
		);
		fireEvent.click(screen.getByRole("button", { name: "More root" }));
		await waitFor(() => expect(screen.getByLabelText("Rows").textContent).toBe(files.map((file) => file.name).join(",")));

		const directoryView: files_DirectoryView = {
			cohortId: "cohort_1" as app_convex_Id<"files_move_cohorts">,
			view: "after",
		};
		const cohortFirstKey = children_key({ parentId: "root", kind: "file", stream: "cohort", cursor: null });
		const refillKey = children_key({
			parentId: "root", kind: "file", stream: "cohort", cursor: "cohort-next", pageView: directoryView,
		});
		const subscriptionCount = subscriptions.length;
		act(() => {
			for (const stream of ["normal", "cohort"] as const)
				for (const kind of ["folder", "file"] as const)
					for (const restricted of [false, true])
						results.set(children_key({ parentId: "root", kind, restricted, stream, cursor: null }), {
							...EMPTY_PAGE, directoryView,
						});
			// The old normal continuation still pins the idle directory view.
			results.set(oldNextKey, new ConvexError({
				message: "InvalidCursor: The saved directory Move view changed.",
				isConvexSystemError: true, paginationError: "InvalidCursor", reason: "saved_directory_view_changed",
			}));
			results.set(cohortFirstKey, { page: afterFiles.slice(0, 200), isDone: false, continueCursor: "cohort-next", directoryView });
			for (const callbacks of listeners.values()) for (const notify of [...callbacks]) notify();
		});
		expect(
			screen.getByLabelText("Rows").textContent,
			"the tree keeps its displayed extent while rows move into the cohort stream",
		).toBe(files.map((file) => file.name).join(","));
		await waitFor(() => expect(
			listeners.get(refillKey)?.size,
			"the tree refills the stream that now holds its requested rows",
		).toBe(1));
		const nextPages = subscriptions.slice(subscriptionCount).flatMap(({ name, args: queryArgs }) => {
			const args = queryArgs as FunctionArgs<typeof app_convex_api.files_tree.list_tree_children>;
			return name === getFunctionName(app_convex_api.files_tree.list_tree_children) && args.paginationOpts.cursor !== null
				? [watch_key(name, args)] : [];
		});
		expect([...new Set(nextPages)], "only the blocking cohort stream asks for another tree page").toEqual([refillKey]);
		receive(refillKey, { ...EMPTY_PAGE, page: afterFiles.slice(200), directoryView });
		await waitFor(() => expect(
			screen.getByLabelText("Rows").textContent,
			"the matching refill shows every final name without losing the requested extent",
		).toBe(afterFiles.map((file) => file.name).join(",")));
	});

	test("loads the root folders and files together", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(screen.getByLabelText("Rows").textContent).toBe("Loading files");
		expect(listeners.get(children_key({ parentId: "root", kind: "folder", cursor: null }))?.size).toBe(1);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null }))?.size).toBe(1);

		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), {
			page: [row("docs")],
			isDone: true,
			continueCursor: "d",
		});
		// Wait for both kinds, so the files never show before the folders above them.
		expect(screen.getByLabelText("Rows").textContent).toBe("Loading files");

		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("a.md")],
			isDone: true,
			continueCursor: "a",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("docs,a.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
	});

	test("pages an open folder on demand and closes its pagers 5 minutes after it closes", () => {
		const view = render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={["people"]} />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), {
			page: [row("people")],
			isDone: true,
			continueCursor: "p",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [],
			isDone: true,
			continueCursor: "",
		});
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:loading");

		receive_empty_twins("people");
		receive(children_key({ parentId: "people", kind: "folder", cursor: null }), {
			page: [],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "people", kind: "file", cursor: null }), {
			page: [row("ann.md", "people")],
			isDone: false,
			continueCursor: "ann",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("people,ann.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:more");
		expect(listeners.has(children_key({ parentId: "people", kind: "file", cursor: "ann" }))).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "More people" }));
		expect(listeners.get(children_key({ parentId: "people", kind: "file", cursor: "ann" }))?.size).toBe(1);
		receive(children_key({ parentId: "people", kind: "file", cursor: "ann" }), {
			page: [row("bob.md", "people")],
			isDone: true,
			continueCursor: "b",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("people,ann.md,bob.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:done");

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const closeFolder = () =>
			view.rerender(
				<TestWorkspace membershipId="membership_1">
					<FoldersConsumer folderIds={[]} />
				</TestWorkspace>,
			);
		closeFolder();
		expect(screen.getByLabelText("Rows").textContent).toBe("people");

		// A folder opened again within 5 minutes shows every page it had, with no new load.
		view.rerender(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={["people"]} />
			</TestWorkspace>,
		);
		expect(screen.getByLabelText("Rows").textContent).toBe("people,ann.md,bob.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done,people:done");

		closeFolder();
		act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
		expect(listeners.get(children_key({ parentId: "people", kind: "file", cursor: "ann" }))?.size).toBe(1);
		act(() => vi.advanceTimersByTime(1));
		expect(listeners.get(children_key({ parentId: "people", kind: "file", cursor: null }))?.size).toBe(0);
		expect(listeners.get(children_key({ parentId: "people", kind: "file", cursor: "ann" }))?.size).toBe(0);
	});

	test("keeps a folder's rows while Convex splits one of its pages", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), {
			page: [],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("a.md"), row("b.md")],
			isDone: true,
			continueCursor: "c",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");

		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("a.md")],
			isDone: true,
			continueCursor: "c",
			pageStatus: "SplitRequired",
			splitCursor: "a",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
	});

	test("merges a folder's open and locked rows in name order and shows a node both streams hold once", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		// Each stream comes in the folder table's name order: numbers by value and no case.
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), {
			page: [row("a9"), row("b"), row("C")],
			isDone: true,
			continueCursor: "",
		});
		// `b` just became restricted, so for a moment both streams hold it.
		receive(children_key({ parentId: "root", kind: "folder", cursor: null, restricted: true }), {
			page: [locked_row("a10"), locked_row("b")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }), EMPTY_PAGE);

		expect(screen.getByLabelText("Rows").textContent).toBe("a9,a10,b,C");
	});

	test("lists every share in the Shared with you group once, and hoists pinned ancestors", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} pinnedNodeIds={["deep.md"]} />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), EMPTY_PAGE);
		expect(screen.getByLabelText("Shared").textContent).toBe(":loading");

		receive(shared_roots_key({ principalIndex: 0 }), {
			page: [row("alpha", "hidden"), row("gamma", "other")],
			isDone: true,
			continueCursor: "",
		});
		receive(shared_roots_key({ principalIndex: 1 }), {
			page: [row("beta", "hidden")],
			isDone: false,
			continueCursor: "b",
		});
		receive(shared_roots_key({ principalIndex: 2 }), {
			page: [row("gamma", "other")],
			isDone: true,
			continueCursor: "",
		});
		// `gamma` waits: the next page of the role stream could still hold a row before it.
		expect(screen.getByLabelText("Shared").textContent).toBe("alpha,beta:more");
		// The shares are not tree rows: the group shows them.
		expect(screen.getByLabelText("Rows").textContent).toBe("");

		fireEvent.click(screen.getByRole("button", { name: "More shared" }));
		receive(shared_roots_key({ principalIndex: 1, cursor: "b" }), EMPTY_PAGE);
		expect(screen.getByLabelText("Shared").textContent).toBe("alpha,beta,gamma:done");

		receive(ancestors_key("deep.md"), {
			node: row("deep.md", "inner"),
			ancestors: [row("outer", "secret"), row("inner", "outer")],
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("outer,inner,deep.md");
		expect(screen.getByLabelText("Hoisted").textContent).toBe("outer");
	});

	test("holds back the rows a stream that is not done could still precede, and loads that stream", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={["root"]} />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("a.md"), row("d.md")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }), {
			page: [locked_row("b.md")],
			isDone: false,
			continueCursor: "b",
		});
		// `d.md` waits: the next page of the twin could still hold a row before it.
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:more");

		fireEvent.click(screen.getByRole("button", { name: "More root" }));
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: "b", restricted: true }))?.size).toBe(
			1,
		);
		receive(children_key({ parentId: "root", kind: "file", cursor: "b", restricted: true }), {
			page: [locked_row("c.md")],
			isDone: true,
			continueCursor: "",
		});
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md,c.md,d.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
	});

	test("merges archived rows by archive operation, then by name", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} archived />
			</TestWorkspace>,
		);
		for (const archived of [false, true]) {
			for (const kind of ["folder", "file"] as const) {
				if (!(archived && kind === "file")) {
					receive(children_key({ parentId: "root", kind, cursor: null, archived, restricted: true }), EMPTY_PAGE);
					receive(children_key({ parentId: "root", kind, cursor: null, archived }), EMPTY_PAGE);
				}
			}
		}
		const archived_row = (id: string, archiveOperationId: string) => ({ ...row(id), archiveOperationId });
		receive(children_key({ parentId: "root", kind: "file", cursor: null, archived: true }), {
			page: [archived_row("z.md", "op-1"), archived_row("a.md", "op-2")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null, archived: true, restricted: true }), {
			page: [
				{ ...locked_row("m.md"), archiveOperationId: "op-1" },
				{ ...locked_row("b.md"), archiveOperationId: "op-2" },
			],
			isDone: true,
			continueCursor: "",
		});

		expect(screen.getByLabelText("Rows").textContent).toBe("m.md,z.md,a.md,b.md");
	});

	test("keeps the Shared with you rows while Convex splits one of their pages", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		for (const principalIndex of [1, 2] as const) receive(shared_roots_key({ principalIndex }), EMPTY_PAGE);
		receive(shared_roots_key({ principalIndex: 0 }), {
			page: [row("alpha", "hidden"), row("beta", "hidden")],
			isDone: true,
			continueCursor: "",
		});
		expect(screen.getByLabelText("Shared").textContent).toBe("alpha,beta:done");

		receive(shared_roots_key({ principalIndex: 0 }), {
			page: [row("alpha", "hidden")],
			isDone: true,
			continueCursor: "",
			pageStatus: "SplitRequired",
			splitCursor: "a",
		});
		expect(screen.getByLabelText("Shared").textContent).toBe("alpha,beta:done");
	});

	test("a Shared with you update keeps the tree rows, so the tree does not rebuild", () => {
		const rowsByRender: unknown[] = [];
		function RowsConsumer() {
			const folders = FilesTreeProvider.useFolders({ folderIds: [], archived: false, pinnedNodeIds: [] });
			rowsByRender.push(folders.rows);
			return <output aria-label="Shared">{folders.sharedRoots.rows.map((node) => node._id).join(",")}</output>;
		}
		render(
			<TestWorkspace membershipId="membership_1">
				<RowsConsumer />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("a.md")],
			isDone: true,
			continueCursor: "",
		});
		const rows = rowsByRender.at(-1);
		expect(rows).toEqual([row("a.md")]);

		for (const principalIndex of [1, 2] as const) receive(shared_roots_key({ principalIndex }), EMPTY_PAGE);
		receive(shared_roots_key({ principalIndex: 0 }), {
			page: [row("alpha", "hidden")],
			isDone: true,
			continueCursor: "",
		});
		expect(screen.getByLabelText("Shared").textContent).toBe("alpha");
		expect(rowsByRender.at(-1)).toBe(rows);
	});

	test("reads both directory views of each kind for every reader, and Shared with you for a member only", () => {
		const organizations_key = watch_key(getFunctionName(app_convex_api.organizations.list), {});
		const tree_children_name = getFunctionName(app_convex_api.files_tree.list_tree_children);
		const watched_tree_streams = () =>
			[...listeners].filter(([key, callbacks]) => callbacks.size > 0 && JSON.parse(key).name === tree_children_name)
				.length;
		const view = render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(watched_tree_streams()).toBe(8);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }))?.size).toBe(
			1,
		);

		receive(organizations_key, { workspaceIdsPermissionsDict: { workspace_1: "all" } });
		expect(watched_tree_streams()).toBe(8);
		expect(listeners.get(shared_roots_key({ principalIndex: 0 }))?.size).toBe(0);
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "folder", cursor: null, restricted: true }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("b.md")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }), {
			page: [locked_row("a.md")],
			isDone: true,
			continueCursor: "",
		});
		// The owner's skipped group does not hold the folder or the group back.
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
		expect(screen.getByLabelText("Shared").textContent).toBe(":done");

		receive(organizations_key, { workspaceIdsPermissionsDict: { workspace_1: ["content.read"] } });
		view.rerender(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		// Each view has the same twin: it gives the children the member cannot open as locked rows.
		expect(watched_tree_streams()).toBe(8);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }))?.size).toBe(
			1,
		);
		expect(listeners.get(shared_roots_key({ principalIndex: 0 }))?.size).toBe(1);
	});

	test("adds the archived pagers only while archived rows are shown", () => {
		const view = render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(listeners.has(children_key({ parentId: "root", kind: "folder", cursor: null, archived: true }))).toBe(false);
		expect(listeners.has(shared_roots_key({ principalIndex: 0, archived: true }))).toBe(false);

		view.rerender(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} archived />
			</TestWorkspace>,
		);
		expect(listeners.get(children_key({ parentId: "root", kind: "folder", cursor: null, archived: true }))?.size).toBe(
			1,
		);
		expect(listeners.get(shared_roots_key({ principalIndex: 0, archived: true }))?.size).toBe(1);
	});
});
