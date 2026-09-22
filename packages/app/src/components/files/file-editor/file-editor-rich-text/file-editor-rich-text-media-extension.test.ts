import { Editor } from "@tiptap/core";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { app_convex_FunctionReturnType, app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { files_get_tiptap_shared_extensions } from "../../../../../shared/files-tiptap.ts";
import { file_editor_rich_text_MediaExtension } from "./file-editor-rich-text-media-extension.ts";

type MediaResult = app_convex_FunctionReturnType<typeof app_convex_api.r2.get_media_by_reference>;

const { action, query, watchQuery, localUploadGet, localUploadSubscribe } = vi.hoisted(() => ({
	action: vi.fn(),
	query: vi.fn(),
	watchQuery: vi.fn(),
	localUploadGet: vi.fn(),
	localUploadSubscribe: vi.fn(),
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action, query, watchQuery } };
});
vi.mock("./file-editor-rich-text-media-upload.ts", () => ({
	file_editor_rich_text_local_upload_get: localUploadGet,
	file_editor_rich_text_local_upload_subscribe: localUploadSubscribe,
	file_editor_rich_text_retry_upload: vi.fn(),
}));

const watches = new Map<
	string,
	{
		result: MediaResult | undefined;
		error: Error | null;
		callbacks: Set<() => void>;
	}
>();
const editors: Editor[] = [];
let membershipId: app_convex_Id<"organizations_workspaces_users">;
let testId = 0;

function media_result(kind: "saved" | "private", id = "1"): NonNullable<MediaResult> {
	return {
		contentType: "image/png",
		asset: {
			_id: `asset_${testId}_${id}` as app_convex_Id<"files_r2_assets">,
			_creationTime: 1,
			organizationId: "org_1" as app_convex_Id<"organizations">,
			workspaceId: "workspace_1" as app_convex_Id<"organizations_workspaces">,
			kind: "upload",
			r2Bucket: "files",
			r2Key: `images/${id}.png`,
			size: 10,
			createdBy: "user_1" as app_convex_Id<"users">,
			updatedAt: 1,
		},
		...(kind === "private"
			? {
					target: { kind, id: `private_${id}` as app_convex_Id<"files_pending_nodes"> },
					privateVersion: {
						pendingUpdateId: `proposal_${id}` as app_convex_Id<"files_pending_updates">,
						reviewedRevision: 2,
						creationGeneration: 3,
					},
				}
			: { target: { kind, id: `saved_${id}` as app_convex_Id<"files_nodes"> }, privateVersion: null }),
	};
}

function get_watch(src: string) {
	let watch = watches.get(src);
	if (!watch) {
		watch = { result: undefined, error: null, callbacks: new Set() };
		watches.set(src, watch);
	}
	return watch;
}

function emit_result(src: string, result: MediaResult | undefined) {
	const watch = get_watch(src);
	watch.result = result;
	for (const callback of watch.callbacks) callback();
}

async function flush_microtasks() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function create_editor(src: string, kind: "image" | "video" = "image", uploadId?: string) {
	const element = document.createElement("div");
	document.body.append(element);
	const node = { type: kind, attrs: { src, uploadId, alt: "Capture", title: "Caption", width: 240, align: "center" } };
	const editor = new Editor({
		element,
		injectCSS: false,
		extensions: [
			...Object.values(files_get_tiptap_shared_extensions()),
			file_editor_rich_text_MediaExtension.configure({ membershipId }),
		],
		content: { type: "doc", content: kind === "image" ? [{ type: "paragraph", content: [node] }] : [node] },
	});
	editors.push(editor);
	return {
		editor,
		media: element.querySelector<HTMLImageElement | HTMLVideoElement>("img, video")!,
		dom: element.querySelector<HTMLElement>(".FileEditorRichTextMedia")!,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	membershipId = `membership_media_${++testId}` as app_convex_Id<"organizations_workspaces_users">;
	watches.clear();
	action.mockReset();
	action.mockResolvedValue({ _yay: { url: "https://images.test/current.png" } });
	query.mockReset();
	watchQuery.mockReset();
	watchQuery.mockImplementation((reference, args: { src: string }) => {
		expect(getFunctionName(reference)).toBe("r2:get_media_by_reference");
		const watch = get_watch(args.src);
		return {
			localQueryResult: () => {
				if (watch.error) throw watch.error;
				return watch.result;
			},
			onUpdate: (callback: () => void) => {
				watch.callbacks.add(callback);
				return () => watch.callbacks.delete(callback);
			},
		};
	});
	localUploadGet.mockReset();
	localUploadGet.mockReturnValue(null);
	localUploadSubscribe.mockReset();
	localUploadSubscribe.mockReturnValue(vi.fn());
});

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("file_editor_rich_text_MediaExtension", () => {
	test.each(["image", "video"] as const)(
		"follows a private %s into its saved target without changing the document",
		async (kind) => {
			const src = "bonobo-file://private/private_1";
			const draft = { ...media_result("private"), contentType: `${kind}/test` };
			emit_result(src, draft);
			const { editor, media, dom } = create_editor(src, kind);
			await flush_microtasks();

			expect(getFunctionName(watchQuery.mock.calls[0]![0])).toBe("r2:get_media_by_reference");
			expect(watchQuery.mock.calls[0]![1]).toEqual({ membershipId, src });
			expect(query).not.toHaveBeenCalled();
			expect(getFunctionName(action.mock.calls[0]![0])).toBe(
				"files_pending_updates:create_private_pending_download_url",
			);
			expect(action.mock.calls[0]![1]).toEqual({ membershipId, target: draft.target, ...draft.privateVersion });
			expect(media.getAttribute("src")).toBe("https://images.test/current.png");

			action.mockResolvedValue({ _yay: { url: "https://images.test/saved.png" } });
			emit_result(src, { ...media_result("saved"), contentType: `${kind}/test` });
			await flush_microtasks();

			expect(getFunctionName(action.mock.calls[1]![0])).toBe("r2:create_signed_download_url");
			expect(action.mock.calls[1]![1]).toEqual({ membershipId, fileNodeId: "saved_1" });
			expect(media.getAttribute("src")).toBe("https://images.test/saved.png");
			expect(editor.getHTML()).toContain(src);
			expect(editor.getHTML()).not.toContain("images.test");
			expect(media.style.width).toBe("240px");
			expect(dom.classList.contains("FileEditorRichTextMedia-align-center")).toBe(true);
			expect(dom.querySelector(".FileEditorRichTextMedia-caption")?.textContent).toBe("Caption");
			if (kind === "image") expect(media.getAttribute("alt")).toBe("Capture");
		},
	);

	test.each(["saved", "private"] as const)(
		"clears a %s image when the file disappears or access is lost",
		async (kind) => {
			const src = kind === "saved" ? "bonobo-file://saved_1" : "bonobo-file://private/private_1";
			emit_result(src, media_result(kind));
			const { media, dom } = create_editor(src);
			await flush_microtasks();
			expect(media.hasAttribute("src")).toBe(true);

			emit_result(src, null);
			await flush_microtasks();
			expect(media.hasAttribute("src")).toBe(false);
			expect(dom.textContent).toContain("File not available");
		},
	);

	test("does not restore a URL after access is lost during signing", async () => {
		const src = "bonobo-file://saved_1";
		emit_result(src, media_result("saved"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { media, dom } = create_editor(src);
		await flush_microtasks();
		expect(action).toHaveBeenCalled();
		emit_result(src, null);
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.hasAttribute("src")).toBe(false);
		expect(dom.textContent).toContain("File not available");
	});

	test("ignores an old URL when src changes during signing", async () => {
		const src = "bonobo-file://saved_1";
		emit_result(src, media_result("saved"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { editor, media } = create_editor(src);
		await flush_microtasks();
		expect(action).toHaveBeenCalled();
		editor.commands.setNodeSelection(1);
		editor.commands.updateAttributes("image", { src: "https://images.test/new.png" });
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.getAttribute("src")).toBe("https://images.test/new.png");
		expect(get_watch(src).callbacks.size).toBe(0);
	});

	test("ignores an older query result after the asset changes", async () => {
		const src = "bonobo-file://saved_1";
		emit_result(src, media_result("saved"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { media } = create_editor(src);
		await flush_microtasks();
		expect(action).toHaveBeenCalled();
		action.mockResolvedValue({ _yay: { url: "https://images.test/new.png" } });
		const changed = media_result("saved", "2");
		changed.target = media_result("saved").target;
		emit_result(src, changed);
		await flush_microtasks();
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.getAttribute("src")).toBe("https://images.test/new.png");
	});

	test("does not reuse a private URL when the same reference is opened again", async () => {
		const src = "bonobo-file://private/private_1";
		emit_result(src, media_result("private"));
		const first = create_editor(src);
		await flush_microtasks();
		expect(first.media.hasAttribute("src")).toBe(true);
		first.editor.destroy();
		action.mockResolvedValue({ _nay: { message: "This draft changed. Open it again." } });
		const second = create_editor(src);
		await flush_microtasks();

		expect(action).toHaveBeenCalledTimes(2);
		expect(second.media.hasAttribute("src")).toBe(false);
		expect(second.dom.textContent).toContain("File not available");
	});

	test("ignores a URL that arrives after the editor is destroyed", async () => {
		const src = "bonobo-file://saved_1";
		emit_result(src, media_result("saved"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { editor, media } = create_editor(src);
		await flush_microtasks();
		expect(action).toHaveBeenCalled();
		editor.destroy();
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.hasAttribute("src")).toBe(false);
		expect(get_watch(src).callbacks.size).toBe(0);
	});

	test("keeps saved uploads processing until their deadline, then shows failure", async () => {
		const src = "bonobo-file://saved_1";
		const result = media_result("saved");
		delete result.asset.r2Key;
		result.asset.unfinalizedExpiresAt = Date.now() + 2000;
		emit_result(src, result);
		const { dom } = create_editor(src);
		await flush_microtasks();
		expect(dom.textContent).toContain("Processing…");
		expect(action).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(3000);
		expect(dom.textContent).toContain("Upload failed");
	});

	test("waits for the first query answer and can recover from a missing private file", async () => {
		const src = "bonobo-file://private/private_1";
		const { media, dom } = create_editor(src);
		expect(dom.textContent).toContain("Processing…");
		expect(action).not.toHaveBeenCalled();

		emit_result(src, null);
		expect(dom.textContent).toContain("File not available");
		emit_result(src, media_result("private"));
		await flush_microtasks();
		expect(media.getAttribute("src")).toBe("https://images.test/current.png");
	});

	test("clears media on a query error and rejects a URL still being signed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const src = "bonobo-file://private/private_1";
		emit_result(src, media_result("private"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { media, dom } = create_editor(src);
		expect(action).toHaveBeenCalled();
		get_watch(src).error = new Error("Unauthenticated");
		emit_result(src, null);
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.hasAttribute("src")).toBe(false);
		expect(dom.textContent).toContain("File not available");
	});

	test.each(["success", "refusal", "error"])("ignores a late private %s after publication", async (outcome) => {
		const src = "bonobo-file://private/private_1";
		emit_result(src, media_result("private"));
		const signed = Promise.withResolvers<{ _yay: { url: string } } | { _nay: { message: string } }>();
		action.mockReturnValueOnce(signed.promise);
		const { media } = create_editor(src);
		expect(getFunctionName(action.mock.calls[0]![0])).toBe("files_pending_updates:create_private_pending_download_url");
		emit_result(src, media_result("saved"));
		await flush_microtasks();
		expect(media.getAttribute("src")).toBe("https://images.test/current.png");

		if (outcome === "error") signed.reject(new Error("Request failed"));
		else if (outcome === "refusal") signed.resolve({ _nay: { message: "The draft was published" } });
		else signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();
		expect(media.getAttribute("src")).toBe("https://images.test/current.png");
	});

	test("signs a changed private version again even when the target and asset stay the same", async () => {
		const src = "bonobo-file://private/private_1";
		const first = media_result("private");
		emit_result(src, first);
		const { media } = create_editor(src);
		await flush_microtasks();
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValueOnce(signed.promise);
		const next = media_result("private");
		next.privateVersion!.reviewedRevision = 5;
		emit_result(src, next);

		expect(media.hasAttribute("src")).toBe(false);
		expect(action).toHaveBeenCalledTimes(2);
		expect(action.mock.calls[1]![1]).toEqual({ membershipId, target: next.target, ...next.privateVersion });
		signed.resolve({ _yay: { url: "https://images.test/revised.png" } });
		await flush_microtasks();
		expect(media.getAttribute("src")).toBe("https://images.test/revised.png");
	});

	test("rejects a late URL when the current file is no longer an image", async () => {
		const src = "bonobo-file://saved_1";
		emit_result(src, media_result("saved"));
		const signed = Promise.withResolvers<{ _yay: { url: string } }>();
		action.mockReturnValue(signed.promise);
		const { media, dom } = create_editor(src);
		emit_result(src, { ...media_result("saved"), contentType: "application/pdf" });
		signed.resolve({ _yay: { url: "https://images.test/stale.png" } });
		await flush_microtasks();

		expect(media.hasAttribute("src")).toBe(false);
		expect(dom.textContent).toContain("File is not an image or video anymore");
		expect(action).toHaveBeenCalledTimes(1);
	});

	test("keeps local upload bytes visible until the saved asset is ready", async () => {
		localUploadGet.mockReturnValue({ status: "uploading", objectUrl: "blob:local-preview" });
		const { editor, media } = create_editor("", "image", "upload_1");
		expect(media.getAttribute("src")).toBe("blob:local-preview");
		expect(watchQuery).not.toHaveBeenCalled();
		const src = "bonobo-file://saved_1";
		const processing = media_result("saved");
		delete processing.asset.r2Key;
		processing.asset.unfinalizedExpiresAt = Date.now() + 2000;
		emit_result(src, processing);
		editor.commands.setNodeSelection(1);
		editor.commands.updateAttributes("image", { src });
		expect(media.getAttribute("src")).toBe("blob:local-preview");
		expect(action).not.toHaveBeenCalled();

		emit_result(src, media_result("saved"));
		await flush_microtasks();
		expect(media.getAttribute("src")).toBe("https://images.test/current.png");
		await vi.advanceTimersByTimeAsync(3000);
		expect(media.getAttribute("src")).toBe("https://images.test/current.png");
	});

	test.each(["bonobo-file://private//image", "javascript:alert(1)"])("never loads an unsupported source: %s", (src) => {
		const { media, dom } = create_editor(src);
		expect(media.hasAttribute("src")).toBe(false);
		expect(dom.textContent).toContain("File not available");
		expect(watchQuery).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
	});
});
