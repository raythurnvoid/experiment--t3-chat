import "@/app.css";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChannelsUpload } from "./channels-upload.tsx";

const mocks = vi.hoisted(() => ({
	rootWrite: true,
	// The root holds two folders. The user can add files to "copies" but not to "locked".
	folders: [
		{ _id: "folder", name: "copies", path: "/copies", kind: "folder", contentType: null },
		{ _id: "readonly", name: "locked", path: "/locked", kind: "folder", contentType: null },
	],
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member" }) },
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: {
		usePickerFolder: (args: { folderId: string | null }) => ({
			children: { rows: args.folderId === "root" ? mocks.folders : [], status: "done", loadMore: () => {} },
			shared: null,
		}),
	},
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (query: FunctionReference<"query">, args: Record<string, unknown> | "skip") => {
		if (args === "skip") return undefined;
		const name = getFunctionName(query);
		if (name === getFunctionName(app_convex_api.files_nodes.get_authorized_by_path)) {
			const folder = mocks.folders.find((row) => row.path === args.path);
			return folder ? { nodeId: folder._id, name: folder.name, kind: "folder", assetId: null } : null;
		}
		if (name === getFunctionName(app_convex_api.files_nodes.get_current_user_file_write_permission)) {
			return args.nodeId === "root" ? mocks.rootWrite : args.nodeId === "folder";
		}
		return undefined;
	},
	usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
	useQueries: () => ({}),
}));

const upload = {
	kind: "upload" as const,
	uploadId: "upload" as app_convex_Id<"channels_uploads">,
	name: "Report Ü.txt",
	contentType: "text/plain",
	size: 5,
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	mocks.rootWrite = true;
});

describe("ChannelsUpload", () => {
	test.each([
		{ contentType: "image/svg+xml", size: 5 },
		{ contentType: "text/html", size: 5 },
		{ contentType: "video/mp4", size: 20 * 1024 * 1024 + 1 },
	])("does not preview $contentType at $size bytes", async ({ contentType, size }) => {
		const sign = vi.spyOn(app_convex, "action");
		const { container } = render(<ChannelsUpload upload={{ ...upload, contentType, size }} />);
		expect(container.querySelector("img,video"), "unsafe or oversized media must not load inline").toBeNull();
		expect(sign).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
	});

	test("refresh checks access again and clears an old preview on refusal", async () => {
		const sign = vi
			.spyOn(app_convex, "action")
			.mockResolvedValueOnce({
				_yay: { url: "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=", expiresAt: Date.now() + 61000 },
			})
			.mockResolvedValue({ _nay: { message: "Not found" } });
		render(<ChannelsUpload upload={{ ...upload, name: "preview.gif", contentType: "image/gif" }} />);
		await screen.findByRole("img", { name: "preview.gif" });
		await waitFor(() => expect(sign).toHaveBeenCalledTimes(2), { timeout: 3000 });
		await screen.findByText("Preview unavailable");
		expect(screen.queryByRole("img"), "a refused refresh must clear the previous signed source").toBeNull();
	});

	test("saves a copy through the normal Files door into the chosen folder", async () => {
		vi.spyOn(app_convex, "action").mockResolvedValue({
			_yay: { url: "https://source.invalid", expiresAt: Date.now() + 900000 },
		});
		const create = vi.spyOn(app_convex, "mutation").mockResolvedValue({
			_yay: {
				url: "https://destination.invalid",
				headers: { "If-None-Match": "*" },
				nodeId: "copy",
				assetId: "copy-asset",
			},
		});
		const fetchFile = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(new Blob(["hello"])))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		render(<ChannelsUpload upload={upload} />);
		await userEvent.click(screen.getByRole("button", { name: "Save to Files" }));
		await userEvent.click(await screen.findByRole("option", { name: "copies" }));
		await within(screen.getByRole("navigation", { name: "Folder path" })).findByRole("button", { name: "copies" });
		await userEvent.click(screen.getByRole("option", { name: "Save here" }));
		await waitFor(() =>
			expect(create).toHaveBeenCalledWith(
				app_convex_api.files_nodes.create_upload_node,
				expect.objectContaining({
					membershipId: "member",
					parentId: "folder",
					filename: "report-u.txt",
					size: 5,
					contentType: "text/plain",
					onConflict: "fail",
				}),
			),
		);
		await waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(2));
		expect(fetchFile.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", headers: { "If-None-Match": "*" } });
	});

	test("a destination name conflict leaves the existing file alone", async () => {
		vi.spyOn(app_convex, "action").mockResolvedValue({
			_yay: { url: "https://source.invalid", expiresAt: Date.now() + 900000 },
		});
		vi.spyOn(app_convex, "mutation").mockResolvedValue({ _nay: { message: "A file already uses this path" } });
		const fetchFile = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["hello"])));
		render(<ChannelsUpload upload={upload} />);
		await userEvent.click(screen.getByRole("button", { name: "Save to Files" }));
		await userEvent.click(await screen.findByRole("option", { name: "Save here" }));
		await screen.findByRole("alert");
		expect(fetchFile, "a refused destination must not receive a PUT").toHaveBeenCalledOnce();
	});

	test("Save here is disabled in a folder the user cannot write, reachable by keyboard, and says why", async () => {
		mocks.rootWrite = false;
		const create = vi.spyOn(app_convex, "mutation");
		render(<ChannelsUpload upload={upload} />);
		await userEvent.click(screen.getByRole("button", { name: "Save to Files" }));
		const saveHere = await screen.findByRole("option", { name: "Save here" });
		expect(saveHere.getAttribute("aria-disabled")).toBe("true");
		expect(document.getElementById(saveHere.getAttribute("aria-describedby")!)?.textContent).toBe(
			"You cannot add files to this folder",
		);

		const search = screen.getByRole("combobox", { name: "Find folder" });
		await userEvent.click(search);
		expect(search.getAttribute("aria-activedescendant"), "the keyboard reaches the disabled row").toBe(saveHere.id);
		await userEvent.keyboard("{Enter}");
		await waitFor(() =>
			expect(screen.getAllByRole("status").map((status) => status.textContent)).toContain(
				"You cannot add files to this folder",
			),
		);
		expect(create).not.toHaveBeenCalled();

		// A folder the user cannot write still opens, so its subfolders stay reachable.
		await userEvent.click(screen.getByRole("option", { name: "locked" }));
		await waitFor(() =>
			expect(screen.getByRole("option", { name: "Save here" }).getAttribute("aria-disabled")).toBe("true"),
		);

		// Enter on the root of the path opens the root, and the focus stays on that button.
		const rootCrumb = within(screen.getByRole("navigation", { name: "Folder path" })).getByRole("button", {
			name: "/",
		});
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(rootCrumb);
		await userEvent.keyboard("{Enter}");
		await waitFor(() =>
			expect(screen.getAllByRole("status").map((status) => status.textContent)).toContain("Opened /"),
		);
		expect(document.activeElement, "the root crumb keeps the focus").toBe(rootCrumb);
	});
});
