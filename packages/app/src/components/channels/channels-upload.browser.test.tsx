import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ChannelsUpload } from "./channels-upload.tsx";

const mocks = vi.hoisted(() => ({ rootWrite: true }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member" }) },
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: {
		useFullList: () => [
			{ _id: "folder", kind: "folder", path: "/copies", archiveOperationId: null, canWrite: true },
			{ _id: "readonly", kind: "folder", path: "/locked", archiveOperationId: null, canWrite: false },
		],
	},
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (_query: unknown, args: unknown) => (args === "skip" ? undefined : mocks.rootWrite),
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
		await userEvent.click(screen.getByText("/copies", { exact: true }));
		expect(screen.queryByRole("radio", { name: "/locked" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Save file" }));
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
		await userEvent.click(screen.getByRole("button", { name: "Save file" }));
		await screen.findByRole("alert");
		expect(fetchFile, "a refused destination must not receive a PUT").toHaveBeenCalledOnce();
	});

	test("root write refusal blocks save while writable folder choices remain", async () => {
		mocks.rootWrite = false;
		const create = vi.spyOn(app_convex, "mutation");
		render(<ChannelsUpload upload={upload} />);
		await userEvent.click(screen.getByRole("button", { name: "Save to Files" }));
		expect((screen.getByRole("radio", { name: "Workspace root /" }) as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Save file" }) as HTMLButtonElement).disabled).toBe(true);
		expect(create).not.toHaveBeenCalled();
		await userEvent.click(screen.getByText("/copies", { exact: true }));
		expect((screen.getByRole("button", { name: "Save file" }) as HTMLButtonElement).disabled).toBe(false);
	});
});
