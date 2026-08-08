// Node views for the image and video embeds.
//
// The nodes themselves live in `shared/files-tiptap.ts`, because Convex serializes documents to
// markdown with that same extension set and a node missing from it is dropped without a word.
// Only the on-screen part lives here: a document holds a `bonobo-file://<fileNodeId>` reference,
// and the element needs a real url, which depends on who is looking. The membership is known only
// once an editor is built, so this extension is configured where the editor is assembled, next to
// the size limit extension.

import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_media_get_signed_url, files_media_parse_src, files_media_resolve_file_node } from "@/lib/files-media-src.ts";
import {
	file_editor_rich_text_local_upload_get,
	file_editor_rich_text_local_upload_subscribe,
	file_editor_rich_text_retry_upload,
} from "./file-editor-rich-text-media-upload.ts";

export type FileEditorRichTextMedia_ClassNames =
	| "FileEditorRichTextMedia"
	| "FileEditorRichTextMedia-image"
	| "FileEditorRichTextMedia-video"
	| "FileEditorRichTextMedia-placeholder"
	| "FileEditorRichTextMedia-local-preview"
	| "FileEditorRichTextMedia-retry"
	| "FileEditorRichTextMedia-retryable"
	| "FileEditorRichTextMedia-has-media"
	| "FileEditorRichTextMedia-resize-handle"
	| "FileEditorRichTextMedia-alt-button"
	| "FileEditorRichTextMedia-alt-input"
	| "FileEditorRichTextMedia-alt-editing"
	| "FileEditorRichTextMedia-state-uploading"
	| "FileEditorRichTextMedia-state-processing"
	| "FileEditorRichTextMedia-state-failed"
	| "FileEditorRichTextMedia-state-missing"
	| "FileEditorRichTextMedia-state-broken";

/**
 * What the reader should see for one embed.
 *
 * `uploading` is this browser's own in-flight upload. `processing` is the same file seen by
 * anybody else: the node exists and the bytes are on their way to R2. `failed` is an upload that
 * never arrived. The cron sweeper deliberately leaves an unfinalized asset alone while a node
 * still points at it, so nothing else will ever clean it up and the reader has to be told.
 */
type MediaState = "ready" | "uploading" | "processing" | "failed" | "missing" | "broken";

/** Every state that shows a text placeholder instead of the media itself. */
type MediaPlaceholderState = Exclude<MediaState, "ready">;

const MEDIA_STATE_CLASS_NAMES = {
	uploading: "FileEditorRichTextMedia-state-uploading",
	processing: "FileEditorRichTextMedia-state-processing",
	failed: "FileEditorRichTextMedia-state-failed",
	missing: "FileEditorRichTextMedia-state-missing",
	broken: "FileEditorRichTextMedia-state-broken",
} satisfies Record<MediaPlaceholderState, FileEditorRichTextMedia_ClassNames>;

const MEDIA_STATE_LABELS = {
	uploading: "Uploading…",
	processing: "Processing…",
	failed: "Upload failed",
	missing: "File not available",
	broken: "Could not load media",
} satisfies Record<MediaPlaceholderState, string>;

function media_state_from_asset(asset: app_convex_Doc<"files_r2_assets"> | null): MediaState {
	if (!asset) {
		return "missing";
	}

	if (asset.r2Key) {
		return "ready";
	}

	// No R2 object yet. Until the deadline passes the upload may still be running in another tab
	// or another browser, so it reads as processing rather than as an error.
	const isPastDeadline = asset.unfinalizedExpiresAt !== undefined && asset.unfinalizedExpiresAt <= Date.now();
	return isPastDeadline ? "failed" : "processing";
}

class MediaNodeView implements NodeView {
	dom: HTMLElement;
	private media: HTMLImageElement | HTMLVideoElement;
	private placeholder: HTMLElement;
	private retryButton: HTMLButtonElement;
	private resizeHandle: HTMLElement;
	private altButton: HTMLButtonElement | null = null;
	private altInput: HTMLInputElement | null = null;
	private assetWatchUnsubscribe: (() => void) | null = null;
	private localUploadUnsubscribe: (() => void) | null = null;
	private isDestroyed = false;

	constructor(
		private node: PmNode,
		private view: EditorView,
		private getPos: () => number | undefined,
		private membershipId: app_convex_Id<"organizations_workspaces_users">,
	) {
		const isVideo = node.type.name === "video";

		this.dom = document.createElement("span");
		this.dom.className = "FileEditorRichTextMedia" satisfies FileEditorRichTextMedia_ClassNames;

		this.media = isVideo ? document.createElement("video") : document.createElement("img");
		this.media.className = (
			isVideo ? "FileEditorRichTextMedia-video" : "FileEditorRichTextMedia-image"
		) satisfies FileEditorRichTextMedia_ClassNames;
		if (this.media instanceof HTMLVideoElement) {
			this.media.controls = true;
		} else {
			// An external image must not tell the third-party host which document is reading it.
			// `<video>` has no such attribute, so an external video url cannot be trimmed this way.
			this.media.referrerPolicy = "no-referrer";
		}
		this.media.addEventListener("error", () => this.render_state("broken"));

		this.placeholder = document.createElement("span");
		this.placeholder.className = "FileEditorRichTextMedia-placeholder" satisfies FileEditorRichTextMedia_ClassNames;

		this.retryButton = document.createElement("button");
		this.retryButton.type = "button";
		this.retryButton.className = "FileEditorRichTextMedia-retry" satisfies FileEditorRichTextMedia_ClassNames;
		this.retryButton.textContent = "Retry upload";
		// Keep ProseMirror from turning the press into a node selection or a drag start.
		this.retryButton.addEventListener("mousedown", (event) => event.stopPropagation());
		this.retryButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const uploadId = typeof this.node.attrs.uploadId === "string" ? this.node.attrs.uploadId : "";
			if (uploadId) {
				file_editor_rich_text_retry_upload({ view: this.view, uploadId });
			}
		});

		this.resizeHandle = document.createElement("span");
		this.resizeHandle.className = "FileEditorRichTextMedia-resize-handle" satisfies FileEditorRichTextMedia_ClassNames;
		// Pointer-only affordance with no keyboard equivalent yet, so keep it out of the
		// accessibility tree instead of pretending it is operable.
		this.resizeHandle.setAttribute("aria-hidden", "true");
		this.resizeHandle.addEventListener("pointerdown", this.handle_resize_start);
		this.resizeHandle.addEventListener("dblclick", this.handle_resize_reset);

		this.dom.append(this.media, this.placeholder, this.retryButton, this.resizeHandle);

		// The video node has no alt attribute, so only images get the alt editor.
		if (!isVideo) {
			this.altButton = document.createElement("button");
			this.altButton.type = "button";
			this.altButton.className = "FileEditorRichTextMedia-alt-button" satisfies FileEditorRichTextMedia_ClassNames;
			this.altButton.textContent = "Alt";
			this.altButton.setAttribute("aria-label", "Edit alt text");
			this.altButton.addEventListener("mousedown", (event) => event.stopPropagation());
			this.altButton.addEventListener("click", this.handle_alt_open);

			this.altInput = document.createElement("input");
			this.altInput.type = "text";
			this.altInput.className = "FileEditorRichTextMedia-alt-input" satisfies FileEditorRichTextMedia_ClassNames;
			this.altInput.setAttribute("aria-label", "Alt text");
			this.altInput.placeholder = "Describe this image";
			this.altInput.addEventListener("mousedown", (event) => event.stopPropagation());
			this.altInput.addEventListener("keydown", this.handle_alt_keydown);
			this.altInput.addEventListener("blur", this.handle_alt_commit);

			this.dom.append(this.altButton, this.altInput);
		}

		this.apply_text_attributes();
		this.apply_width();
		this.resolve();
	}

	/**
	 * Keep ProseMirror away from events inside the embed's own controls, so typing in the alt
	 * input or pressing a button never becomes document input or a node selection.
	 */
	stopEvent(event: Event) {
		const target = event.target;
		if (!(target instanceof Node)) {
			return false;
		}
		return (
			this.retryButton.contains(target) ||
			this.resizeHandle.contains(target) ||
			(this.altButton?.contains(target) ?? false) ||
			(this.altInput?.contains(target) ?? false)
		);
	}

	/**
	 * A leaf embed has no editable content, so ProseMirror must not try to write into it.
	 */
	ignoreMutation() {
		return true;
	}

	update(node: PmNode) {
		if (node.type !== this.node.type) {
			return false;
		}

		const hasSameSource = node.attrs.src === this.node.attrs.src && node.attrs.uploadId === this.node.attrs.uploadId;
		this.node = node;
		this.apply_text_attributes();
		this.apply_width();
		if (!hasSameSource) {
			this.resolve();
		}

		return true;
	}

	/**
	 * Apply the document's width to the element. CSS `max-width: 100%` still caps the
	 * display to the editor column.
	 */
	private apply_width() {
		const width =
			typeof this.node.attrs.width === "number" && Number.isFinite(this.node.attrs.width) ? this.node.attrs.width : null;
		if (width !== null) {
			this.media.style.width = `${width}px`;
		} else {
			this.media.style.removeProperty("width");
		}
	}

	private commit_attributes(attrs: { width?: number | null; alt?: string | null }) {
		const pos = this.getPos();
		if (pos === undefined) {
			return;
		}
		const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...attrs });
		// Replacing the node drops its NodeSelection, which would hide the controls right
		// after every commit. Re-select it so a second resize needs no extra click.
		tr.setSelection(NodeSelection.create(tr.doc, pos));
		this.view.dispatch(tr);
	}

	private handle_resize_start = (event: PointerEvent) => {
		// Left button only; a right-button drag would fight the context menu.
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();

		const startX = event.clientX;
		const startWidth = this.media.getBoundingClientRect().width;
		this.resizeHandle.setPointerCapture(event.pointerId);

		const handleMove = (moveEvent: PointerEvent) => {
			const width = Math.round(Math.min(4096, Math.max(80, startWidth + (moveEvent.clientX - startX))));
			this.media.style.width = `${width}px`;
		};
		const removeListeners = () => {
			this.resizeHandle.removeEventListener("pointermove", handleMove);
			this.resizeHandle.removeEventListener("pointerup", handleUp);
			this.resizeHandle.removeEventListener("pointercancel", handleCancel);
		};
		const handleUp = () => {
			removeListeners();
			// Commit what is actually displayed: the CSS cap has already clamped the drag to
			// the editor column, so the stored width never exceeds it.
			this.commit_attributes({ width: Math.round(this.media.getBoundingClientRect().width) });
		};
		const handleCancel = () => {
			removeListeners();
			// Snap back to the stored width.
			this.apply_width();
		};

		this.resizeHandle.addEventListener("pointermove", handleMove);
		this.resizeHandle.addEventListener("pointerup", handleUp);
		this.resizeHandle.addEventListener("pointercancel", handleCancel);
	};

	private handle_resize_reset = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		// Back to the natural size, and immediately: the node update echoes the same answer.
		this.media.style.removeProperty("width");
		this.commit_attributes({ width: null });
	};

	private handle_alt_open = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (!this.altInput) {
			return;
		}
		this.altInput.value = typeof this.node.attrs.alt === "string" ? this.node.attrs.alt : "";
		this.dom.classList.add("FileEditorRichTextMedia-alt-editing" satisfies FileEditorRichTextMedia_ClassNames);
		this.altInput.focus();
		this.altInput.select();
	};

	private handle_alt_keydown = (event: KeyboardEvent) => {
		// The editor must never treat these keys as document input.
		event.stopPropagation();
		if (event.key === "Enter") {
			event.preventDefault();
			this.handle_alt_commit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			this.close_alt_editor();
		}
	};

	private handle_alt_commit = () => {
		// Closing the editor moves focus, which fires the input's blur; the class check keeps
		// that second call (and a blur after Escape) from committing again.
		if (
			!this.altInput ||
			!this.dom.classList.contains("FileEditorRichTextMedia-alt-editing" satisfies FileEditorRichTextMedia_ClassNames)
		) {
			return;
		}

		const value = this.altInput.value.trim();
		this.close_alt_editor();
		this.commit_attributes({ alt: value || null });
	};

	private close_alt_editor() {
		this.dom.classList.remove("FileEditorRichTextMedia-alt-editing" satisfies FileEditorRichTextMedia_ClassNames);
		this.view.focus();
	}

	/**
	 * Put the document's alt and title text on the image. Without an `alt` a screen reader
	 * falls back to reading the signed url's filename, which is a random asset key. The video
	 * node has no alt or title attribute, so there is nothing to apply for it.
	 */
	private apply_text_attributes() {
		if (!(this.media instanceof HTMLImageElement)) {
			return;
		}

		this.media.alt = typeof this.node.attrs.alt === "string" ? this.node.attrs.alt : "";
		const title = typeof this.node.attrs.title === "string" ? this.node.attrs.title : "";
		if (title) {
			this.media.title = title;
		} else {
			this.media.removeAttribute("title");
		}
	}

	destroy() {
		this.isDestroyed = true;
		this.assetWatchUnsubscribe?.();
		this.assetWatchUnsubscribe = null;
		this.localUploadUnsubscribe?.();
		this.localUploadUnsubscribe = null;
	}

	private render_state(state: MediaState, url?: string) {
		if (this.isDestroyed) {
			return;
		}

		// A re-resolve passes through "processing" even when the media is already on screen: the
		// uploader swaps the node's src right after finalizing, and the collaborator's embed
		// resolves the new src from scratch. Keep showing the rendered media instead of flashing
		// the placeholder. A hard answer (missing, failed, broken) still replaces the media.
		if (state === "processing" && this.media.getAttribute("src")) {
			return;
		}

		for (const className of Object.values(MEDIA_STATE_CLASS_NAMES)) {
			this.dom.classList.remove(className);
		}
		this.dom.classList.remove(
			"FileEditorRichTextMedia-local-preview" satisfies FileEditorRichTextMedia_ClassNames,
			"FileEditorRichTextMedia-retryable" satisfies FileEditorRichTextMedia_ClassNames,
		);

		if (state === "ready" && url) {
			this.dom.classList.add("FileEditorRichTextMedia-has-media" satisfies FileEditorRichTextMedia_ClassNames);
			this.media.src = url;
			this.placeholder.textContent = "";
			return;
		}

		// "ready" without a url means signing failed after all, which leaves nothing to show.
		const placeholderState: MediaPlaceholderState = state === "ready" ? "missing" : state;

		// Drop any url already on the element, so a failed reload cannot keep showing stale media.
		this.dom.classList.remove("FileEditorRichTextMedia-has-media" satisfies FileEditorRichTextMedia_ClassNames);
		this.media.removeAttribute("src");
		this.dom.classList.add(MEDIA_STATE_CLASS_NAMES[placeholderState]);
		const alt = typeof this.node.attrs.alt === "string" && this.node.attrs.alt ? `: ${this.node.attrs.alt}` : "";
		this.placeholder.textContent = `${MEDIA_STATE_LABELS[placeholderState]}${alt}`;
	}

	/**
	 * Show the upload's local bytes while the real url is still on its way. The state classes
	 * come off so the media element is visible; `-local-preview` dims it slightly to say
	 * "not stored yet".
	 */
	private render_local_preview(objectUrl: string) {
		if (this.isDestroyed) {
			return;
		}

		for (const className of Object.values(MEDIA_STATE_CLASS_NAMES)) {
			this.dom.classList.remove(className);
		}
		this.dom.classList.remove("FileEditorRichTextMedia-retryable" satisfies FileEditorRichTextMedia_ClassNames);
		this.dom.classList.add(
			"FileEditorRichTextMedia-local-preview" satisfies FileEditorRichTextMedia_ClassNames,
			"FileEditorRichTextMedia-has-media" satisfies FileEditorRichTextMedia_ClassNames,
		);
		if (this.media.getAttribute("src") !== objectUrl) {
			this.media.src = objectUrl;
		}
		this.placeholder.textContent = "";
	}

	private resolve() {
		this.assetWatchUnsubscribe?.();
		this.assetWatchUnsubscribe = null;
		this.localUploadUnsubscribe?.();
		this.localUploadUnsubscribe = null;

		const src = typeof this.node.attrs.src === "string" ? this.node.attrs.src : "";
		const uploadId = typeof this.node.attrs.uploadId === "string" ? this.node.attrs.uploadId : "";

		// An upload that started in this tab still has its bytes here: show them right away
		// instead of a placeholder, and re-render when the upload fails, retries, or settles.
		// Collaborators and reloaded tabs have no local entry and keep the placeholder flow.
		if (uploadId) {
			this.localUploadUnsubscribe = file_editor_rich_text_local_upload_subscribe(uploadId, () => this.resolve());
			const localUpload = file_editor_rich_text_local_upload_get(uploadId);
			if (localUpload?.status === "failed") {
				this.render_state("failed");
				this.dom.classList.add("FileEditorRichTextMedia-retryable" satisfies FileEditorRichTextMedia_ClassNames);
				return;
			}
			if (localUpload) {
				this.render_local_preview(localUpload.objectUrl);
				// With no src yet there is nothing to watch. With a src, fall through: the asset
				// watch below swaps the preview for the signed url once the bytes are confirmed,
				// and the "processing" render on the way is skipped because media is showing.
				if (!src) {
					return;
				}
			}
		}

		if (!src) {
			this.render_state(uploadId ? "uploading" : "missing");
			return;
		}

		const parsed = files_media_parse_src(src);
		if (parsed.kind === "external") {
			this.render_state("ready", parsed.url);
			return;
		}

		if (parsed.kind === "unsupported") {
			this.render_state("missing");
			return;
		}

		this.render_state("processing");
		files_media_resolve_file_node({ membershipId: this.membershipId, fileNodeId: parsed.fileNodeId })
			.then((fileNode) => {
				if (this.isDestroyed) {
					return;
				}
				if (!fileNode?.assetId) {
					this.render_state("missing");
					return;
				}

				// Watch the asset instead of reading it once: the reader may be looking at a file
				// somebody else is still uploading, and the embed has to swap itself in when the R2
				// object is confirmed.
				this.watch_asset(fileNode._id);
			})
			.catch((error: unknown) => {
				console.error("[FileEditorRichTextMedia.resolve] Failed to resolve media reference", {
					error,
					src,
				});
				this.render_state("missing");
			});
	}

	private watch_asset(fileNodeId: app_convex_Id<"files_nodes">) {
		const watch = app_convex.watchQuery(app_convex_api.r2.get_asset, {
			membershipId: this.membershipId,
			fileNodeId,
		});

		const apply = () => {
			if (this.isDestroyed) {
				return;
			}

			// `localQueryResult()` returns `undefined` while the subscription has not received its
			// first result, and `null` only when the server answered that the asset does not exist.
			// Treating `undefined` as `null` here made every collaborator see a short "File not
			// available" flash during an upload, once per subscribe: the embed re-resolves when the
			// uploader swaps the node's src, and each new watch starts one round trip away from its
			// first result. Keep the current placeholder until a real result lands.
			const asset = watch.localQueryResult();
			if (asset === undefined) {
				return;
			}

			const state = media_state_from_asset(asset);
			if (state !== "ready") {
				this.render_state(state);
				return;
			}

			// The upload pipeline may still be converting the file into a Markdown sibling, but the
			// bytes are already in R2, so the embed can show them now.
			files_media_get_signed_url({ membershipId: this.membershipId, fileNodeId })
				.then((signed) => {
					if (signed._nay) {
						this.render_state("missing");
						return;
					}
					this.render_state("ready", signed._yay);
				})
				.catch((error: unknown) => {
					console.error("[FileEditorRichTextMedia.watch_asset] Failed to sign a media url", {
						error,
						fileNodeId,
					});
					this.render_state("missing");
				});
		};

		this.assetWatchUnsubscribe = watch.onUpdate(apply);
		apply();
	}
}

const FILE_EDITOR_RICH_TEXT_MEDIA_PLUGIN_KEY = new PluginKey("file-editor-rich-text-media");

export const file_editor_rich_text_MediaExtension = Extension.create<{
	membershipId: app_convex_Id<"organizations_workspaces_users"> | null;
}>({
	name: "fileEditorRichTextMedia",

	addOptions() {
		return { membershipId: null };
	},

	addProseMirrorPlugins() {
		const membershipId = this.options.membershipId;
		if (!membershipId) {
			return [];
		}

		const createNodeView = (node: PmNode, view: EditorView, getPos: () => number | undefined) =>
			new MediaNodeView(node, view, getPos, membershipId);

		return [
			new Plugin({
				key: FILE_EDITOR_RICH_TEXT_MEDIA_PLUGIN_KEY,
				props: {
					nodeViews: {
						image: createNodeView,
						video: createNodeView,
					},
				},
			}),
		];
	},
});
