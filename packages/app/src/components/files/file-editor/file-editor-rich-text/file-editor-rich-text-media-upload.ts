// Upload flow for images and videos pasted or dropped into the rich text editor.
//
// The placeholder embed node is inserted synchronously, before the first await: numeric
// document positions go stale while an upload waits (local typing, collaborator Yjs
// transactions), so every later step finds its node again by scanning the document for the
// `uploadId` attribute instead of remembering a position. The node view in
// `file-editor-rich-text-media-extension.ts` renders `Uploading…` for exactly this attr
// shape (an `uploadId` and no `src`).
//
// Uploads land in an `assets` folder that is a sibling of the document (created when it is
// missing), and always with `onConflict: "fail"`: a name collision must never archive the
// existing file, because that file may be another document's embed. On a collision the flow
// picks the next free `name 2.ext` style name instead.

import { toast } from "sonner";
import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PmNode } from "@tiptap/pm/model";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_UPLOAD_PATH_TAKEN_MESSAGE, files_normalize_upload_file_name } from "@/lib/files.ts";
import { files_media_build_file_src } from "@/lib/files-media-src.ts";
import { files_prepare_image_upload_file } from "@/lib/files-image-compression.ts";

export function file_editor_rich_text_handle_media_paste(args: {
	view: EditorView;
	event: ClipboardEvent;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	documentNodeId: app_convex_Id<"files_nodes">;
}) {
	const files = collect_media_files(args.event.clipboardData);
	if (files.length === 0) {
		return false;
	}

	args.event.preventDefault();
	file_editor_rich_text_upload_media_files({
		view: args.view,
		files,
		source: "clipboard",
		membershipId: args.membershipId,
		documentNodeId: args.documentNodeId,
	});
	return true;
}

export function file_editor_rich_text_handle_media_drop(args: {
	view: EditorView;
	event: DragEvent;
	moved: boolean;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	documentNodeId: app_convex_Id<"files_nodes">;
}) {
	// An internal drag only relocates content the document already has.
	if (args.moved) {
		return false;
	}

	const files = collect_media_files(args.event.dataTransfer);
	if (files.length === 0) {
		return false;
	}

	args.event.preventDefault();
	const dropPos = args.view.posAtCoords({ left: args.event.clientX, top: args.event.clientY })?.pos ?? null;
	file_editor_rich_text_upload_media_files({
		view: args.view,
		files,
		source: "file",
		dropPos,
		membershipId: args.membershipId,
		documentNodeId: args.documentNodeId,
	});
	return true;
}

/**
 * Upload media files into the document at the current selection (or at `dropPos`). The
 * placeholder nodes are inserted synchronously before this returns; the uploads then run in
 * the background. Files from the clipboard get a timestamp name because the browser calls
 * every pasted bitmap `image.png`; picked and dropped files keep their own name.
 */
export function file_editor_rich_text_upload_media_files(args: {
	view: EditorView;
	files: File[];
	source: "clipboard" | "file";
	dropPos?: number | null;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	documentNodeId: app_convex_Id<"files_nodes">;
}) {
	const pending = insert_upload_placeholders({
		view: args.view,
		files: args.files,
		source: args.source,
		dropPos: args.dropPos ?? null,
	});
	run_upload_batch({
		view: args.view,
		membershipId: args.membershipId,
		documentNodeId: args.documentNodeId,
		pending,
	}).catch((error: unknown) => {
		console.error("[file_editor_rich_text_upload_media_files] Unexpected upload batch error", { error });
	});
}

// Only media files are handled here. For anything else the handlers return false so
// ProseMirror's default behavior runs — which for files is nothing, because this app has no
// attachment support.
function collect_media_files(dataTransfer: DataTransfer | null) {
	return Array.from(dataTransfer?.files ?? []).filter(
		(file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
	);
}

type PendingUpload = {
	uploadId: string;
	file: File;
	isVideo: boolean;
	/** The name the upload asks for first; a collision may add a ` 2` style suffix later. */
	requestedName: string;
};

function insert_upload_placeholders(args: {
	view: EditorView;
	files: File[];
	source: "clipboard" | "file";
	dropPos: number | null;
}) {
	// Land the drop where the pointer released instead of at the old caret.
	if (args.dropPos != null) {
		const tr = args.view.state.tr;
		args.view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(args.dropPos))));
	}

	const pending: PendingUpload[] = [];
	for (const file of args.files) {
		const isVideo = file.type.startsWith("video/");
		const uploadId = crypto.randomUUID();
		const requestedName =
			args.source === "clipboard" ? build_pasted_media_name(file, isVideo) : files_normalize_upload_file_name(file.name);

		// The video node has no alt attribute, so only the image placeholder carries a name.
		const nodeType = args.view.state.schema.nodes[isVideo ? "video" : "image"];
		const node = nodeType.create(isVideo ? { src: "", uploadId } : { src: "", uploadId, alt: requestedName });
		args.view.dispatch(args.view.state.tr.replaceSelectionWith(node).scrollIntoView());
		pending.push({ uploadId, file, isVideo, requestedName });
	}

	return pending;
}

// The browser calls every pasted bitmap `image.png`, so a clipboard paste gets a timestamp
// name instead. Two pastes in the same second collide on purpose and resolve through the
// conflict suffix retry.
function build_pasted_media_name(file: File, isVideo: boolean) {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
		now.getMinutes(),
	)}${pad(now.getSeconds())}`;

	const normalizedName = files_normalize_upload_file_name(file.name);
	const dotIndex = normalizedName.lastIndexOf(".");
	const extension = dotIndex > 0 ? normalizedName.slice(dotIndex + 1) : isVideo ? "mp4" : "png";
	return `pasted-${isVideo ? "video" : "image"}-${stamp}.${extension}`;
}

function with_name_suffix(filename: string, suffix: number) {
	const dotIndex = filename.lastIndexOf(".");
	if (dotIndex <= 0) {
		return `${filename} ${suffix}`;
	}
	return `${filename.slice(0, dotIndex)} ${suffix}${filename.slice(dotIndex)}`;
}

// Same helper as the sidebar's `join_file_node_path`: a root parent's path is "/", so a
// plain string concat would produce "//assets", a path that matches nothing.
function join_file_node_path(parentPath: string, pathSegment: string) {
	return parentPath === "/" ? `/${pathSegment}` : `${parentPath}/${pathSegment}`;
}

// The return type is explicit because TypeScript cannot see the assignment inside the
// `descendants` callback and would infer plain `null`.
function find_upload_node(view: EditorView, uploadId: string): { node: PmNode; pos: number } | null {
	if (view.isDestroyed) {
		return null;
	}

	let found: { node: PmNode; pos: number } | null = null;
	view.state.doc.descendants((node, pos) => {
		if (found) {
			return false;
		}
		if (node.attrs.uploadId === uploadId) {
			found = { node, pos };
			return false;
		}
		return true;
	});
	return found;
}

function remove_upload_node(view: EditorView, uploadId: string) {
	const found = find_upload_node(view, uploadId);
	if (!found) {
		return;
	}
	view.dispatch(view.state.tr.delete(found.pos, found.pos + found.node.nodeSize));
}

function patch_upload_node(view: EditorView, uploadId: string, attrs: { src?: string; alt?: string; uploadId?: null }) {
	const found = find_upload_node(view, uploadId);
	if (!found) {
		return false;
	}
	view.dispatch(view.state.tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, ...attrs }));
	return true;
}

type UploadTarget = {
	// Shared by every file of one paste/drop batch on purpose: when the assets folder
	// refuses a write, the whole batch falls back together instead of failing file by file.
	parentId: app_convex_Doc<"files_nodes">["parentId"];
	parentPath: string;
	/** The document's own parent folder, for when the assets folder refuses the write. */
	fallbackParentId: app_convex_Doc<"files_nodes">["parentId"];
	fallbackParentPath: string;
};

async function resolve_upload_target(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	documentNodeId: app_convex_Id<"files_nodes">;
}): Promise<UploadTarget | null> {
	const documentNode = await app_convex.query(app_convex_api.files_nodes.get_file_node_for_membership, {
		membershipId: args.membershipId,
		fileNodeId: args.documentNodeId,
	});
	if (!documentNode) {
		return null;
	}

	const parentPath = documentNode.path.slice(0, documentNode.path.lastIndexOf("/")) || "/";
	const assetsPath = join_file_node_path(parentPath, "assets");
	const fallback = { fallbackParentId: documentNode.parentId, fallbackParentPath: parentPath };

	// A file squatting on the `assets` name: don't fight it, upload next to the document.
	const probe = await app_convex.query(app_convex_api.files_nodes.get_authorized_by_path, {
		membershipId: args.membershipId,
		path: assetsPath,
	});
	if (probe) {
		return probe.kind === "folder"
			? { parentId: probe.nodeId, parentPath: assetsPath, ...fallback }
			: { parentId: documentNode.parentId, parentPath, ...fallback };
	}

	const created = await app_convex.mutation(app_convex_api.files_nodes.create_folder_node, {
		membershipId: args.membershipId,
		parentId: documentNode.parentId,
		path: "assets",
	});
	if (!created._nay) {
		return { parentId: created._yay.nodeId, parentPath: assetsPath, ...fallback };
	}

	// The create can lose a race with a collaborator creating the same folder, or the user
	// may not be allowed to create folders here. Ask once more, then settle for the
	// document's parent folder.
	const reprobe = await app_convex.query(app_convex_api.files_nodes.get_authorized_by_path, {
		membershipId: args.membershipId,
		path: assetsPath,
	});
	if (reprobe?.kind === "folder") {
		return { parentId: reprobe.nodeId, parentPath: assetsPath, ...fallback };
	}
	return { parentId: documentNode.parentId, parentPath, ...fallback };
}

async function run_upload_batch(args: {
	view: EditorView;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	documentNodeId: app_convex_Id<"files_nodes">;
	pending: PendingUpload[];
}) {
	const target = await resolve_upload_target({
		membershipId: args.membershipId,
		documentNodeId: args.documentNodeId,
	}).catch((error: unknown) => {
		console.error("[file_editor_rich_text_upload_media_files.run_upload_batch] Failed to resolve the upload folder", {
			error,
		});
		return null;
	});
	if (!target) {
		for (const item of args.pending) {
			remove_upload_node(args.view, item.uploadId);
		}
		toast.error("Failed to prepare upload");
		return;
	}

	// One file at a time: collisions inside the batch then resolve through the same suffix
	// retry as collisions with existing files, and the picked names stay deterministic.
	for (const [index, item] of args.pending.entries()) {
		const outcome = await upload_one({ view: args.view, membershipId: args.membershipId, target, item }).catch(
			(error: unknown) => {
				console.error("[file_editor_rich_text_upload_media_files.run_upload_batch] Unexpected upload error", {
					error,
					uploadId: item.uploadId,
				});
				remove_upload_node(args.view, item.uploadId);
				toast.error("Failed to upload file");
				return "failed" as const;
			},
		);

		// The tree-write bucket is shared with the whole app; once it refuses, more calls only
		// push the refill further away, so drop the rest of the batch.
		if (outcome === "rate_limited") {
			for (const rest of args.pending.slice(index + 1)) {
				remove_upload_node(args.view, rest.uploadId);
			}
			toast.error("Rate limit exceeded");
			return;
		}
	}
}

async function upload_one(args: {
	view: EditorView;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	target: UploadTarget;
	item: PendingUpload;
}): Promise<"done" | "failed" | "rate_limited"> {
	const { view, membershipId, target, item } = args;

	let file = item.file;
	if (!item.isVideo) {
		file = await files_prepare_image_upload_file(file);
		if (file !== item.file) {
			toast.info("Image compressed before upload.");
		}
	}

	// Undone or deleted while compressing: nothing was created yet, nothing to clean up.
	if (!find_upload_node(view, item.uploadId)) {
		return "done";
	}

	const created = await create_upload_node_with_free_name({
		membershipId,
		target,
		filename: item.requestedName,
		contentType: file.type || undefined,
		size: file.size,
	});
	if (created.outcome === "rate_limited") {
		remove_upload_node(view, item.uploadId);
		return "rate_limited";
	}
	if (created.outcome === "failed") {
		remove_upload_node(view, item.uploadId);
		toast.error(created.message ?? "Failed to prepare upload");
		return "failed";
	}

	// Point the placeholder at the real node. The node view swaps `Uploading…` for the asset
	// watch (processing → ready) on this src change; `uploadId` stays set until the bytes are
	// through, so a failed PUT can still find the node.
	const patched = patch_upload_node(
		view,
		item.uploadId,
		item.isVideo
			? { src: files_media_build_file_src(created.nodeId) }
			: { src: files_media_build_file_src(created.nodeId), alt: created.filename },
	);
	if (!patched) {
		// The embed disappeared while the node was being created (undo, collaborator delete).
		// There is no embed left to keep either way; the discard's `removed: false` answer just
		// means the bytes already landed and the file stays in the tree as a normal file.
		await discard_upload_node({ membershipId, nodeId: created.nodeId });
		return "done";
	}

	const putOk = await fetch(created.url, { method: "PUT", headers: created.headers, body: file })
		.then((response) => response.ok)
		.catch(() => false);
	if (!putOk) {
		const discarded = await discard_upload_node({ membershipId, nodeId: created.nodeId });
		// `removed: false` means the R2 event recorded the object first: the bytes landed
		// despite the browser-side failure, so the file and the embed both stay.
		if (discarded === "removed") {
			remove_upload_node(view, item.uploadId);
			toast.error("Upload failed before processing could start.");
			return "failed";
		}
	}

	patch_upload_node(view, item.uploadId, { uploadId: null });
	return "done";
}

async function create_upload_node_with_free_name(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	target: UploadTarget;
	filename: string;
	contentType: string | undefined;
	size: number;
}): Promise<
	| {
			outcome: "created";
			nodeId: app_convex_Id<"files_nodes">;
			url: string;
			headers: Record<string, string>;
			filename: string;
	  }
	| { outcome: "rate_limited" }
	| { outcome: "failed"; message: string | null }
> {
	let suffix = 1;
	let hasFallenBack = args.target.parentId === args.target.fallbackParentId;

	// Cap the mutations, not the names: every create charges the shared `files_tree_write`
	// bucket, so taken names are skipped with the free path query below instead of burning
	// one refused mutation each.
	for (let attempt = 0; attempt < 10; attempt++) {
		const filename = suffix === 1 ? args.filename : with_name_suffix(args.filename, suffix);
		const created = await app_convex.mutation(app_convex_api.files_nodes.create_upload_node, {
			membershipId: args.membershipId,
			parentId: args.target.parentId,
			filename,
			contentType: args.contentType,
			size: args.size,
			onConflict: "fail",
		});
		if (!created._nay) {
			return { outcome: "created", ...created._yay, filename };
		}

		const message = created._nay.message ?? null;
		if (message === "Rate limit exceeded") {
			return { outcome: "rate_limited" };
		}
		// The assets folder probe authorizes reading only, so it can pick a folder this user
		// cannot write. Land those uploads next to the document instead.
		if (message === "Permission denied" && !hasFallenBack) {
			args.target.parentId = args.target.fallbackParentId;
			args.target.parentPath = args.target.fallbackParentPath;
			hasFallenBack = true;
			suffix = 1;
			continue;
		}
		if (message !== files_UPLOAD_PATH_TAKEN_MESSAGE) {
			return { outcome: "failed", message };
		}

		const freeSuffix = await find_free_name_suffix({
			membershipId: args.membershipId,
			parentPath: args.target.parentPath,
			filename: args.filename,
			fromSuffix: suffix + 1,
		});
		if (freeSuffix === null) {
			return { outcome: "failed", message: files_UPLOAD_PATH_TAKEN_MESSAGE };
		}
		suffix = freeSuffix;
	}

	return { outcome: "failed", message: files_UPLOAD_PATH_TAKEN_MESSAGE };
}

async function find_free_name_suffix(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	parentPath: string;
	filename: string;
	fromSuffix: number;
}) {
	// The query cannot see nodes the user is not allowed to read, so a "free" answer can
	// still collide; the caller's mutation cap absorbs that.
	for (let suffix = Math.max(args.fromSuffix, 2); suffix <= 50; suffix++) {
		const candidate = with_name_suffix(args.filename, suffix);
		const taken = await app_convex.query(app_convex_api.files_nodes.get_authorized_by_path, {
			membershipId: args.membershipId,
			path: join_file_node_path(args.parentPath, candidate),
		});
		if (!taken) {
			return suffix;
		}
	}
	return null;
}

async function discard_upload_node(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
}): Promise<"removed" | "kept"> {
	// The discard charges the `files_bulk_import` bucket, so wait a rate limit out instead of
	// leaving a phantom node in the tree.
	while (true) {
		const discarded = await app_convex
			.mutation(app_convex_api.files_nodes.discard_failed_upload_node, {
				membershipId: args.membershipId,
				nodeId: args.nodeId,
			})
			.catch((error: unknown) => {
				console.error("[file_editor_rich_text_upload_media_files.discard_upload_node] Unexpected discard error", {
					error,
					nodeId: args.nodeId,
				});
				return null;
			});
		if (discarded === null) {
			return "kept";
		}

		if (discarded._nay) {
			// "Rate limit exceeded" is the literal from `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`.
			if (discarded._nay.message === "Rate limit exceeded") {
				const retryAfterMs = discarded._nay.data?.retryAfterMs ?? 5000;
				await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
				continue;
			}
			console.error("[file_editor_rich_text_upload_media_files.discard_upload_node] Failed to discard upload node", {
				error: discarded._nay,
				nodeId: args.nodeId,
			});
			return "kept";
		}

		return discarded._yay.removed ? "removed" : "kept";
	}
}

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("with_name_suffix", () => {
		test("puts the suffix before the extension", () => {
			expect(with_name_suffix("shot.png", 2)).toBe("shot 2.png");
		});

		test("appends the suffix when there is no extension", () => {
			expect(with_name_suffix("shot", 2)).toBe("shot 2");
		});

		test("keeps earlier dots inside the base name", () => {
			expect(with_name_suffix("a.b.png", 3)).toBe("a.b 3.png");
		});

		test("treats a leading dot as part of the name, not an extension", () => {
			expect(with_name_suffix(".env", 2)).toBe(".env 2");
		});
	});

	describe("build_pasted_media_name", () => {
		test("names a pasted bitmap with a timestamp and the file's extension", () => {
			const file = new File(["x"], "image.png", { type: "image/png" });
			expect(build_pasted_media_name(file, false)).toMatch(/^pasted-image-\d{8}-\d{6}\.png$/);
		});

		test("falls back to a default extension when the pasted file has none", () => {
			const image = new File(["x"], "clipboard", { type: "image/png" });
			expect(build_pasted_media_name(image, false)).toMatch(/^pasted-image-\d{8}-\d{6}\.png$/);

			const video = new File(["x"], "clipboard", { type: "video/mp4" });
			expect(build_pasted_media_name(video, true)).toMatch(/^pasted-video-\d{8}-\d{6}\.mp4$/);
		});
	});
}
