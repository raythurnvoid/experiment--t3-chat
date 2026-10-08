import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_tree_stream_args } from "@/lib/files-tree-context.tsx";
import { files_media_build_file_src } from "../../../../../shared/files-media.ts";
import { FileEditorRichTextMediaEmbedPicker } from "./file-editor-rich-text-media-insert.tsx";

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@/lib/app-channels-context.tsx", () => ({
	AppChannelsProvider: (props: { children: ReactNode }) => props.children,
}));

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

/**
 * Answer every stream of the root: the open files stream holds an image and a text file, and every
 * other stream is empty and done.
 */
function set_root_files() {
	const files = [
		{ id: "cover.png", contentType: "image/png" },
		{ id: "notes.txt", contentType: "text/plain" },
	].map(({ id, contentType }) => ({
		_id: id,
		parentId: "root",
		name: id,
		path: `/${id}`,
		kind: "file",
		contentType,
		archiveOperationId: null,
	}));
	for (const kind of ["folder", "file"] as const) {
		const streamArgs = files_tree_stream_args({
			membershipId: MEMBERSHIP_ID as app_convex_Id<"organizations_workspaces_users">,
			folderId: "root" as app_convex_Id<"files_nodes">,
			kind,
			archived: false,
		});
		const children = getFunctionName(app_convex_api.files_nodes.list_tree_children);
		results.set(watch_key(children, { ...streamArgs.children(false), paginationOpts: { cursor: null } }), {
			...EMPTY_PAGE,
			page: kind === "file" ? files : [],
		});
		results.set(watch_key(children, { ...streamArgs.children(true), paginationOpts: { cursor: null } }), EMPTY_PAGE);
		for (const principalIndex of [0, 1, 2] as const) {
			results.set(
				watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_children_shared), {
					...streamArgs.shared(principalIndex),
					paginationOpts: { cursor: null },
				}),
				EMPTY_PAGE,
			);
			results.set(
				watch_key(getFunctionName(app_convex_api.files_nodes.list_tree_shared_roots), {
					membershipId: MEMBERSHIP_ID,
					archived: false,
					principalIndex,
					paginationOpts: { cursor: null },
				}),
				EMPTY_PAGE,
			);
		}
	}
}

const insertContent = vi.fn();
const onClose = vi.fn();

function render_picker() {
	// The picker only uses the editor to insert the picked file.
	const chain = {
		focus: () => chain,
		insertContent: (content: unknown) => (insertContent(content), chain),
		run: () => true,
	};
	const editor = { chain: () => chain } as unknown as Editor;

	render(
		<ConvexProvider client={client}>
			<AppTenantProvider
				membershipId={MEMBERSHIP_ID as app_convex_Id<"organizations_workspaces_users">}
				workspaceId={"workspace_1" as app_convex_Id<"organizations_workspaces">}
				workspaceName="home"
				organizationId={"organization_1" as app_convex_Id<"organizations">}
				organizationName="team"
			>
				<FileEditorRichTextMediaEmbedPicker
					editor={editor}
					anchorRect={{ x: 0, y: 0, width: 0, height: 0 }}
					onClose={onClose}
				/>
			</AppTenantProvider>
		</ConvexProvider>,
	);
}

beforeEach(() => {
	results.clear();
	insertContent.mockReset();
	onClose.mockReset();
	client = new ConvexReactClient("https://media-picker-test.convex.cloud");
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

describe("FileEditorRichTextMediaEmbedPicker", () => {
	test("shows a file that is not an image or video as disabled, with its reason", async () => {
		set_root_files();
		render_picker();

		expect(screen.getByRole("combobox", { name: "Search files" }).getAttribute("placeholder")).toBe("Search files...");
		const textOption = await screen.findByRole("option", { name: "notes.txt" });
		expect(textOption.getAttribute("aria-disabled")).toBe("true");
		expect(document.getElementById(textOption.getAttribute("aria-describedby")!)?.textContent).toBe(
			"This file is not an image or video",
		);
		const search = screen.getByRole("combobox", { name: "Search files" });
		fireEvent.keyDown(search, { key: "ArrowDown" });
		fireEvent.keyDown(search, { key: "ArrowDown" });
		expect(search.getAttribute("aria-activedescendant"), "the arrow keys reach a disabled row").toBe(textOption.id);
		fireEvent.keyDown(search, { key: "Enter" });
		expect(insertContent, "a disabled row inserts nothing").not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("This file is not an image or video");

		const imageOption = screen.getByRole("option", { name: /cover\.png/ });
		expect(imageOption.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(imageOption);
		expect(insertContent).toHaveBeenCalledWith({
			type: "image",
			attrs: { src: files_media_build_file_src("cover.png"), alt: "cover.png" },
		});
		expect(onClose).toHaveBeenCalled();
	});
});
