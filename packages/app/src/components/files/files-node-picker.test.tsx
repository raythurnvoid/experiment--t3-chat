import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_tree_stream_args } from "@/lib/files-tree-context.tsx";
import {
	FilesNodePicker,
	type FilesNodePicker_Pickable,
	type FilesNodePicker_Ref,
	type FilesNodePicker_Row,
} from "./files-node-picker.tsx";

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: (props: { children: ReactNode }) => props.children,
}));

// happy-dom does not implement scrollIntoView; the picker calls it on the active row.
Element.prototype.scrollIntoView = vi.fn();

const MEMBERSHIP_ID = "membership_1";
const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

const results = new Map<string, unknown>();
let client: ConvexReactClient;

/**
 * Key one watched query by its name, its args, and its page cursor. The pagination session id and
 * page size change between runs, so they are left out.
 */
function watch_key(name: string, args: Record<string, unknown>) {
	const { paginationOpts, ...rest } = args as { paginationOpts?: { cursor: string | null } };
	const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify({ name, ...sorted, cursor: paginationOpts?.cursor });
}

function tree_row(args: { id: string; parentId: string; kind: "file" | "folder"; contentType?: string }) {
	const { id, parentId, kind, contentType = null } = args;
	const parentPath = parentId === "root" ? "" : `/${parentId}`;
	return { _id: id, parentId, name: id, path: `${parentPath}/${id}`, kind, contentType, archiveOperationId: null };
}

/**
 * Answer every stream of one folder: the open streams with the given pages, and the owner's
 * restricted twins and the member's share streams with an empty, done page.
 */
function set_folder(args: {
	parentId: string;
	folders?: Array<ReturnType<typeof tree_row>>;
	files?: Array<ReturnType<typeof tree_row>>;
	/**
	 * The open files stream is not done after its first page, and this is its second page.
	 */
	nextFiles?: Array<ReturnType<typeof tree_row>>;
}) {
	const { parentId, folders = [], files = [], nextFiles } = args;
	for (const kind of ["folder", "file"] as const) {
		const streamArgs = files_tree_stream_args({
			membershipId: MEMBERSHIP_ID as app_convex_Id<"organizations_workspaces_users">,
			folderId: parentId as app_convex_Id<"files_nodes">,
			kind,
			archived: false,
		});
		const children = getFunctionName(app_convex_api.files_nodes.list_tree_children);
		const page = kind === "folder" ? folders : files;
		const hasNext = kind === "file" && nextFiles !== undefined;
		results.set(watch_key(children, { ...streamArgs.children(false), paginationOpts: { cursor: null } }), {
			page,
			isDone: !hasNext,
			continueCursor: hasNext ? "next" : "",
		});
		if (hasNext) {
			results.set(watch_key(children, { ...streamArgs.children(false), paginationOpts: { cursor: "next" } }), {
				...EMPTY_PAGE,
				page: nextFiles,
			});
		}
		results.set(watch_key(children, { ...streamArgs.children(true), paginationOpts: { cursor: null } }), EMPTY_PAGE);
		for (const principalIndex of [0, 1, 2] as const) {
			results.set(
				watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_children_shared), {
					...streamArgs.shared(principalIndex),
					paginationOpts: { cursor: null },
				}),
				EMPTY_PAGE,
			);
		}
	}
}

/**
 * Answer the "Shared with you" streams: the member's own shares get `rows`, their roles get none.
 */
function set_shared_roots(rows: Array<ReturnType<typeof tree_row>>) {
	for (const principalIndex of [0, 1, 2] as const) {
		results.set(
			watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_shared_roots), {
				membershipId: MEMBERSHIP_ID,
				archived: false,
				principalIndex,
				paginationOpts: { cursor: null },
			}),
			{ ...EMPTY_PAGE, page: principalIndex === 0 ? rows : [] },
		);
	}
}

function set_folder_path(path: string, nodeId: string) {
	results.set(
		watch_key(getFunctionName(app_convex_api.files_nodes.get_authorized_by_path), {
			membershipId: MEMBERSHIP_ID,
			path,
		}),
		{ nodeId, name: nodeId, kind: "folder", assetId: null },
	);
}

const onPick = vi.fn<(row: FilesNodePicker_Row) => void>();

/**
 * A text field that keeps focus and forwards its keys to the picker, like the mention popup.
 */
function PickerHarness(props: {
	initialQuery: string;
	getPickable?: (row: FilesNodePicker_Row) => FilesNodePicker_Pickable;
}) {
	const { initialQuery, getPickable } = props;
	const [query, setQuery] = useState(initialQuery);
	const [owner, setOwner] = useState<HTMLInputElement | null>(null);
	const pickerRef = useRef<FilesNodePicker_Ref>(null);

	return (
		<ConvexProvider client={client}>
			<AppTenantProvider
				membershipId={MEMBERSHIP_ID as app_convex_Id<"organizations_workspaces_users">}
				workspaceId={"workspace_1" as app_convex_Id<"organizations_workspaces">}
				workspaceName="home"
				organizationId={"organization_1" as app_convex_Id<"organizations">}
				organizationName="team"
			>
				<input
					ref={setOwner}
					aria-label="Find a file"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (pickerRef.current?.onKeyDown(event.nativeEvent)) event.preventDefault();
					}}
				/>
				{owner && (
					<FilesNodePicker
						ref={pickerRef}
						variant="listbox"
						aria-label="Files"
						ownerElement={owner}
						query={query}
						select="file"
						folderRow={null}
						getPickable={getPickable}
						onPick={onPick}
						clearQuery={() => setQuery("")}
					/>
				)}
			</AppTenantProvider>
		</ConvexProvider>
	);
}

function option_names() {
	return screen.queryAllByRole("option").map((option) => option.textContent);
}

beforeEach(() => {
	results.clear();
	onPick.mockReset();
	client = new ConvexReactClient("https://picker-test.convex.cloud");
	// Keep the real pagination and subscription hooks. Only replace the server watches.
	vi.spyOn(client, "watchQuery").mockImplementation((query, args?, _options?) => {
		const key = watch_key(getFunctionName(query), args as Record<string, unknown>);
		return {
			onUpdate: () => () => {},
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

describe("FilesNodePicker", () => {
	test("browses one folder at a time, folders first, and a folder row opens the folder", async () => {
		set_folder({
			parentId: "root",
			folders: [tree_row({ id: "docs", parentId: "root", kind: "folder" })],
			files: [tree_row({ id: "readme.md", parentId: "root", kind: "file" })],
		});
		set_shared_roots([]);
		set_folder_path("/docs", "docs");
		set_folder({ parentId: "docs", files: [tree_row({ id: "api.md", parentId: "docs", kind: "file" })] });
		render(<PickerHarness initialQuery="" />);

		await waitFor(() => expect(option_names()).toEqual(["docs", "readme.md"]));
		fireEvent.click(screen.getByRole("option", { name: "docs" }));

		await waitFor(() => expect(option_names()).toEqual(["api.md"]));
		expect(onPick, "a folder row opens the folder in a file picker").not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Opened /docs");
		const breadcrumb = screen.getByRole("navigation", { name: "Folder path" });
		fireEvent.click(within(breadcrumb).getByRole("button", { name: "/" }));
		await waitFor(() => expect(option_names()).toEqual(["docs", "readme.md"]));
	});

	test("text with no slash searches names inside the opened folder", async () => {
		set_folder({ parentId: "root", folders: [tree_row({ id: "docs", parentId: "root", kind: "folder" })] });
		set_shared_roots([]);
		set_folder_path("/docs", "docs");
		set_folder({ parentId: "docs" });
		results.set(
			watch_key(getFunctionName(app_convex_api.files_nodes.search_saved), {
				membershipId: MEMBERSHIP_ID,
				clause: { kind: "name", text: "ap" },
				folderPath: "/docs",
				paginationOpts: { cursor: null },
			}),
			{
				...EMPTY_PAGE,
				page: [{ kind: "file", nodeId: "api", path: "/docs/api.md", contentType: "text/markdown" }],
			},
		);
		render(<PickerHarness initialQuery="" />);

		fireEvent.click(await screen.findByRole("option", { name: "docs" }));
		await screen.findByText("This folder is empty");
		fireEvent.change(screen.getByRole("textbox", { name: "Find a file" }), { target: { value: "ap" } });

		const option = await screen.findByRole("option", { name: /api.md/ });
		expect(option.textContent, "the search stays in the opened folder").toBe("api.md/docs/");
	});

	test("searches names inside the folder typed before the last slash", async () => {
		results.set(
			watch_key(getFunctionName(app_convex_api.files_nodes.search_saved), {
				membershipId: MEMBERSHIP_ID,
				clause: { kind: "name", text: "na" },
				folderPath: "/a/b",
				paginationOpts: { cursor: null },
			}),
			{
				...EMPTY_PAGE,
				page: [{ kind: "file", nodeId: "names", path: "/a/b/names.md", contentType: "text/markdown" }],
			},
		);
		render(<PickerHarness initialQuery="/a/b/na" />);

		const option = await screen.findByRole("option", { name: /names\.md/ });
		expect(option.textContent, "a search row shows its folder").toBe("names.md/a/b/");
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Find a file" }), { key: "Enter" });
		expect(onPick).toHaveBeenCalledWith({
			nodeId: "names",
			name: "names.md",
			path: "/a/b/names.md",
			kind: "file",
			contentType: "text/markdown",
		});
	});

	test("reaches a disabled row by keyboard and announces its reason on Enter", async () => {
		set_folder({
			parentId: "root",
			files: [
				tree_row({ id: "cover.png", parentId: "root", kind: "file", contentType: "image/png" }),
				tree_row({ id: "notes.txt", parentId: "root", kind: "file", contentType: "text/plain" }),
			],
		});
		set_shared_roots([]);
		render(
			<PickerHarness
				initialQuery=""
				getPickable={(row) =>
					row.contentType?.startsWith("image/") ? { ok: true } : { ok: false, reason: "Not an image or video" }
				}
			/>,
		);

		const disabledOption = await screen.findByRole("option", { name: "notes.txt" });
		expect(disabledOption.getAttribute("aria-disabled")).toBe("true");
		expect(document.getElementById(disabledOption.getAttribute("aria-describedby")!)?.textContent).toBe(
			"Not an image or video",
		);

		const textbox = screen.getByRole("textbox", { name: "Find a file" });
		fireEvent.keyDown(textbox, { key: "ArrowDown" });
		expect(textbox.getAttribute("aria-activedescendant"), "the arrow keys reach a disabled row").toBe(
			disabledOption.id,
		);
		fireEvent.keyDown(textbox, { key: "Enter" });
		expect(onPick).not.toHaveBeenCalled();
		const status = screen.getByRole("status");
		expect(status.textContent).toBe("Not an image or video");

		// A screen reader reads a live region again only when its content changes.
		const firstMessage = status.firstChild;
		fireEvent.keyDown(textbox, { key: "Enter" });
		expect(status.firstChild, "a second Enter puts the reason in a new node").not.toBe(firstMessage);
		expect(status.textContent).toBe("Not an image or video");
	});

	test("Enter that confirms IME text does not pick a row", async () => {
		set_folder({ parentId: "root", files: [tree_row({ id: "notes.md", parentId: "root", kind: "file" })] });
		set_shared_roots([]);
		render(<PickerHarness initialQuery="" />);

		await screen.findByRole("option", { name: "notes.md" });
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Find a file" }), { key: "Enter", isComposing: true });
		expect(onPick, "the IME takes this Enter").not.toHaveBeenCalled();
	});

	test("at the root, a member without workspace read sees only the shared roots", async () => {
		// `list_tree_children` refuses the root to this member with an empty, done page.
		set_folder({ parentId: "root" });
		set_shared_roots([tree_row({ id: "team", parentId: "projects", kind: "folder" })]);
		render(<PickerHarness initialQuery="" />);

		const group = await screen.findByRole("group", { name: "Shared with you" });
		expect(
			within(group)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["team"]);
		expect(option_names()).toEqual(["team"]);
		expect(screen.queryByText("This folder is empty")).toBeNull();
	});

	test("Show more loads the next page of the folder", async () => {
		set_folder({
			parentId: "root",
			files: [tree_row({ id: "a.md", parentId: "root", kind: "file" })],
			nextFiles: [tree_row({ id: "b.md", parentId: "root", kind: "file" })],
		});
		set_shared_roots([]);
		render(<PickerHarness initialQuery="" />);

		await waitFor(() => expect(option_names()).toEqual(["a.md", "Show more"]));
		const textbox = screen.getByRole("textbox", { name: "Find a file" });
		fireEvent.keyDown(textbox, { key: "ArrowDown" });
		const showMoreId = textbox.getAttribute("aria-activedescendant");
		expect(showMoreId).toBe(screen.getByRole("option", { name: "Show more" }).id);
		fireEvent.keyDown(textbox, { key: "Enter" });
		await waitFor(() => expect(option_names()).toEqual(["a.md", "b.md"]));

		// The highlight stays on the second row, now b.md. Its new id makes a screen reader read it.
		await waitFor(() =>
			expect(textbox.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "b.md" }).id),
		);
		expect(textbox.getAttribute("aria-activedescendant"), "the highlighted row gets a new id").not.toBe(showMoreId);
	});
});
