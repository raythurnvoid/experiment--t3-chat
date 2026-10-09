import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "./app-tenant-context.tsx";
import { FilesTreeProvider, files_tree_stream_args } from "./files-tree-context.tsx";
import type { files_SavedStream } from "../../shared/files.ts";

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: (props: { children: ReactNode }) => props.children,
}));

const results = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
let client: ConvexReactClient;

/**
 * Key one watched query by its name, its args, and its page cursors. The pagination session id and
 * page size change between runs, so they are left out.
 */
function watch_key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as {
		paginationOpts?: { cursor: string | null; endCursor?: string | null };
	};
	const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify({ name, ...sorted, cursor: paginationOpts?.cursor, endCursor: paginationOpts?.endCursor });
}

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

/**
 * The key of one tree stream of a folder: the open one by default, the owner's restricted twin with
 * `restricted`, or a member's share stream with `principalIndex`.
 */
function children_key(args: {
	parentId: string;
	kind: "folder" | "file";
	cursor: string | null;
	archived?: boolean;
	restricted?: boolean;
	principalIndex?: 0 | 1 | 2;
	savedStream?: files_SavedStream;
}) {
	const { archived = false, cursor, kind, parentId, restricted = false, principalIndex } = args;
	const streamArgs = files_tree_stream_args({
		membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
		folderId: parentId as app_convex_Id<"files_nodes">,
		kind,
		archived,
		savedStream: args.savedStream ?? { kind: "normal", generation: 0 },
	});

	return principalIndex === undefined
		? watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_children), {
				...streamArgs.children(restricted),
				paginationOpts: { cursor },
			})
		: watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_children_shared), {
				...streamArgs.shared(principalIndex),
				paginationOpts: { cursor },
			});
}

/**
 * Answer the first page of every stream of a folder but the open ones with an empty, done page, like
 * the server does for a member with no shares there.
 */
function receive_empty_twins(parentId: string) {
	for (const kind of ["folder", "file"] as const) {
		receive(children_key({ parentId, kind, cursor: null, restricted: true }), EMPTY_PAGE);
		for (const principalIndex of [0, 1, 2] as const) {
			receive(children_key({ parentId, kind, cursor: null, principalIndex }), EMPTY_PAGE);
		}
	}
}

function shared_roots_key(args: { principalIndex: 0 | 1 | 2; archived?: boolean; cursor?: string | null; savedStream?: files_SavedStream }) {
	const { archived = false, cursor = null, principalIndex } = args;

	return watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_shared_roots), {
		membershipId: "membership_1",
		archived,
		principalIndex,
		savedStream: args.savedStream ?? { kind: "normal", generation: 0 },
		paginationOpts: { cursor },
	});
}

function ancestors_key(nodeId: string) {
	return watch_key(getFunctionName(app_convex_api.files_nodes.get_tree_ancestors), {
		membershipId: "membership_1",
		nodeId,
	});
}

function receive(key: string, result: unknown) {
	act(() => {
		results.set(key, result);
		listeners.get(key)?.forEach((listener) => listener());
	});
}

function row(id: string, parentId = "root") {
	return { _id: id, parentId, name: id, archiveOperationId: null };
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
				{folders.rows === undefined ? "Loading files" : folders.rows.map((node) => node._id).join(",")}
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
	results.set(watch_key(getFunctionName(app_convex_api.files_nodes.get_workspace_move_view), { membershipId: "membership_1" }), {
		cohortId: null, view: null, generation: 0, searchGeneration: 0,
	});
	client = new ConvexReactClient("https://tree-test.convex.cloud");
	// Keep the real pagination and subscription hooks. Only replace the server watches.
	vi.spyOn(client, "watchQuery").mockImplementation((query, args?, _options?) => {
		const key = watch_key(getFunctionName(query), args as Record<string, unknown>);
		return {
			onUpdate: (callback) => {
				const callbacks = listeners.get(key) ?? new Set<() => void>();
				callbacks.add(callback);
				listeners.set(key, callbacks);
				return () => callbacks.delete(callback);
			},
			localQueryResult: () => results.get(key) as never,
			localQueryLogs: () => undefined,
			journal: () => undefined,
		};
	});
});

afterEach(async () => {
	cleanup();
	await client.close();
	vi.restoreAllMocks();
});

describe("FilesTreeProvider.useFolders", () => {
	test("finishes empty when the workspace view refuses access", () => {
		results.set(watch_key(getFunctionName(app_convex_api.files_nodes.get_workspace_move_view), { membershipId: "membership_1" }), null);
		render(<TestWorkspace membershipId="membership_1"><FoldersConsumer folderIds={[]} /></TestWorkspace>);
		expect(screen.getByLabelText("Rows").textContent).toBe("");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
		expect(screen.getByLabelText("Shared").textContent).toBe(":done");
	});

	test("merges normal and selected rows in the tree", () => {
		const cohortId = "cohort_1" as app_convex_Id<"files_move_cohorts">;
		const normal: files_SavedStream = { kind: "normal", generation: 1 };
		const cohort: files_SavedStream = { kind: "cohort", cohortId, view: "before", generation: 1 };
		results.set(watch_key(getFunctionName(app_convex_api.files_nodes.get_workspace_move_view), { membershipId: "membership_1" }), {
			cohortId, view: "before", generation: 1, searchGeneration: 1,
		});
		for (const savedStream of [normal, cohort]) {
			for (const kind of ["folder", "file"] as const) {
				for (const restricted of [false, true]) results.set(children_key({ parentId: "root", kind, cursor: null, restricted, savedStream }), EMPTY_PAGE);
				for (const principalIndex of [0, 1, 2] as const) results.set(children_key({ parentId: "root", kind, cursor: null, principalIndex, savedStream }), EMPTY_PAGE);
			}
		}
		results.set(children_key({ parentId: "root", kind: "file", cursor: null, savedStream: normal }), { ...EMPTY_PAGE, page: [row("b.md")] });
		results.set(children_key({ parentId: "root", kind: "file", cursor: null, savedStream: cohort }), { ...EMPTY_PAGE, page: [row("a.md")] });
		render(<TestWorkspace membershipId="membership_1"><FoldersConsumer folderIds={[]} /></TestWorkspace>);
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
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

	test("pages an open folder on demand and closes its pagers when it closes", () => {
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

		view.rerender(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(listeners.get(children_key({ parentId: "people", kind: "file", cursor: null }))?.size).toBe(0);
		expect(screen.getByLabelText("Rows").textContent).toBe("people");
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

	test("merges a folder's open and share streams in name order and shows a node shared twice once", () => {
		render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		receive_empty_twins("root");
		// Each stream comes in the folder table's name order: numbers by value and no case.
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), {
			page: [row("a9"), row("C")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "folder", cursor: null, principalIndex: 0 }), {
			page: [row("a10"), row("b")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "folder", cursor: null, principalIndex: 1 }), {
			page: [row("b")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), EMPTY_PAGE);

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
		receive(children_key({ parentId: "root", kind: "file", cursor: null, principalIndex: 0 }), {
			page: [row("b.md")],
			isDone: false,
			continueCursor: "b",
		});
		// `d.md` waits: the next page of the share stream could still hold a row before it.
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:more");

		fireEvent.click(screen.getByRole("button", { name: "More root" }));
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: "b", principalIndex: 0 }))?.size).toBe(
			1,
		);
		receive(children_key({ parentId: "root", kind: "file", cursor: "b", principalIndex: 0 }), {
			page: [row("c.md")],
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
				receive(children_key({ parentId: "root", kind, cursor: null, archived, restricted: true }), EMPTY_PAGE);
				for (const principalIndex of [0, 1, 2] as const) {
					receive(children_key({ parentId: "root", kind, cursor: null, archived, principalIndex }), EMPTY_PAGE);
				}
				if (!(archived && kind === "file")) {
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
		receive(children_key({ parentId: "root", kind: "file", cursor: null, archived: true, principalIndex: 0 }), {
			page: [archived_row("m.md", "op-1"), archived_row("b.md", "op-2")],
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

	test("once the role is known, reads no share stream for the owner and no restricted twin for a member", () => {
		const organizations_key = watch_key(getFunctionName(app_convex_api.organizations.list), {});
		const view = render(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		// While the role loads, every stream is read.
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }))?.size).toBe(
			1,
		);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, principalIndex: 0 }))?.size).toBe(
			1,
		);

		receive(organizations_key, { workspaceIdsPermissionsDict: { workspace_1: "all" } });
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }))?.size).toBe(
			1,
		);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, principalIndex: 0 }))?.size).toBe(
			0,
		);
		expect(listeners.get(shared_roots_key({ principalIndex: 0 }))?.size).toBe(0);
		receive(children_key({ parentId: "root", kind: "folder", cursor: null }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "folder", cursor: null, restricted: true }), EMPTY_PAGE);
		receive(children_key({ parentId: "root", kind: "file", cursor: null }), {
			page: [row("b.md")],
			isDone: true,
			continueCursor: "",
		});
		receive(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }), {
			page: [row("a.md")],
			isDone: true,
			continueCursor: "",
		});
		// The owner's skipped streams do not hold the folder or the group back.
		expect(screen.getByLabelText("Rows").textContent).toBe("a.md,b.md");
		expect(screen.getByLabelText("Status").textContent).toBe("root:done");
		expect(screen.getByLabelText("Shared").textContent).toBe(":done");

		receive(organizations_key, { workspaceIdsPermissionsDict: { workspace_1: ["content.read"] } });
		view.rerender(
			<TestWorkspace membershipId="membership_1">
				<FoldersConsumer folderIds={[]} />
			</TestWorkspace>,
		);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, restricted: true }))?.size).toBe(
			0,
		);
		expect(listeners.get(children_key({ parentId: "root", kind: "file", cursor: null, principalIndex: 0 }))?.size).toBe(
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
