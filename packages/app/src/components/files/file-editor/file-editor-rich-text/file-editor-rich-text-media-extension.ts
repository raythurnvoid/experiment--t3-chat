// Node views for the image and video embeds.
//
// The nodes themselves live in `shared/files-tiptap.ts`, because Convex serializes documents to
// markdown with that same extension set and a node missing from it is dropped without a word.
// Only the on-screen part lives here: a document holds a `bonobo-file://<fileNodeId>` reference,
// and the element needs a real url, which depends on who is looking. The membership is known only
// once an editor is built, so this extension is configured where the editor is assembled, next to
// the size limit extension.

import { Extension, type Editor } from "@tiptap/core";
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
	| "FileEditorRichTextMedia-caption"
	| "FileEditorRichTextMedia-placeholder"
	| "FileEditorRichTextMedia-local-preview"
	| "FileEditorRichTextMedia-retry"
	| "FileEditorRichTextMedia-retryable"
	| "FileEditorRichTextMedia-has-media"
	| "FileEditorRichTextMedia-resize-handle"
	| "FileEditorRichTextMedia-controls"
	| "FileEditorRichTextMedia-alt-button"
	| "FileEditorRichTextMedia-alt-input"
	| "FileEditorRichTextMedia-alt-editing"
	| "FileEditorRichTextMedia-caption-button"
	| "FileEditorRichTextMedia-caption-input"
	| "FileEditorRichTextMedia-caption-editing"
	| "FileEditorRichTextMedia-align-button"
	| "FileEditorRichTextMedia-align-center"
	| "FileEditorRichTextMedia-align-right"
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

const MEDIA_MIN_WIDTH_PX = 80;
const MEDIA_MAX_WIDTH_PX = 4096;
const MEDIA_KEYBOARD_WIDTH_STEP_PX = 64;

// The keyboard shortcuts live on the extension but the alt and caption editors live in the
// node view, so a shortcut reaches them through these events on the node view's root element.
const MEDIA_ALT_OPEN_EVENT = "FileEditorRichTextMedia-alt-open";
const MEDIA_CAPTION_OPEN_EVENT = "FileEditorRichTextMedia-caption-open";

type MediaAlign = "center" | "right" | null;

function media_next_align(align: MediaAlign): MediaAlign {
	if (align === null) return "center";
	if (align === "center") return "right";
	return null;
}

// A collaborator sees "Uploading…" while the uploader's tab has not yet created the file node,
// so there is no asset record to read a deadline from. That window is seconds in a healthy
// upload; if no src arrives within this time, the uploader's tab is gone and nothing will ever
// finish this upload.
const UPLOADING_PLACEHOLDER_EXPIRY_MS = 2 * 60 * 1000;

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
	private caption: HTMLElement;
	private placeholder: HTMLElement;
	private retryButton: HTMLButtonElement;
	private resizeHandle: HTMLElement;
	private controls: HTMLElement;
	private alignButton: HTMLButtonElement;
	private captionButton: HTMLButtonElement;
	private captionInput: HTMLInputElement;
	private altButton: HTMLButtonElement | null = null;
	private altInput: HTMLInputElement | null = null;
	private assetWatchUnsubscribe: (() => void) | null = null;
	private localUploadUnsubscribe: (() => void) | null = null;
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;
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

		// The caption is the visible text under the media; it doubles as the image's markdown
		// `title`. CSS hides it while it is empty.
		this.caption = document.createElement("span");
		this.caption.className = "FileEditorRichTextMedia-caption" satisfies FileEditorRichTextMedia_ClassNames;

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
		// The handle itself stays pointer-only and out of the accessibility tree; the keyboard
		// path is Alt+ArrowLeft/Right on the selected node (see addKeyboardShortcuts below).
		this.resizeHandle.setAttribute("aria-hidden", "true");
		this.resizeHandle.addEventListener("pointerdown", this.handle_resize_start);
		this.resizeHandle.addEventListener("dblclick", this.handle_resize_reset);

		// One shared cluster for the selected-embed buttons, so they lay out as a row instead
		// of each one owning an absolute position.
		this.controls = document.createElement("span");
		this.controls.className = "FileEditorRichTextMedia-controls" satisfies FileEditorRichTextMedia_ClassNames;

		this.alignButton = document.createElement("button");
		this.alignButton.type = "button";
		this.alignButton.className = "FileEditorRichTextMedia-align-button" satisfies FileEditorRichTextMedia_ClassNames;
		this.alignButton.setAttribute("aria-keyshortcuts", "Alt+Shift+A");
		this.alignButton.addEventListener("mousedown", (event) => event.stopPropagation());
		this.alignButton.addEventListener("click", this.handle_align_cycle);

		this.captionButton = document.createElement("button");
		this.captionButton.type = "button";
		this.captionButton.className = "FileEditorRichTextMedia-caption-button" satisfies FileEditorRichTextMedia_ClassNames;
		this.captionButton.textContent = "Caption";
		this.captionButton.setAttribute("aria-label", "Edit caption (Alt+Shift+Enter)");
		this.captionButton.addEventListener("mousedown", (event) => event.stopPropagation());
		this.captionButton.addEventListener("click", this.handle_caption_open);
		this.dom.addEventListener(MEDIA_CAPTION_OPEN_EVENT, () => this.open_caption_editor());

		this.captionInput = document.createElement("input");
		this.captionInput.type = "text";
		this.captionInput.className = "FileEditorRichTextMedia-caption-input" satisfies FileEditorRichTextMedia_ClassNames;
		this.captionInput.setAttribute("aria-label", "Caption");
		this.captionInput.placeholder = "Add a caption";
		this.captionInput.addEventListener("mousedown", (event) => event.stopPropagation());
		this.captionInput.addEventListener("keydown", this.handle_caption_keydown);
		this.captionInput.addEventListener("blur", this.handle_caption_commit);

		this.controls.append(this.alignButton, this.captionButton);

		this.dom.append(
			this.media,
			this.caption,
			this.placeholder,
			this.retryButton,
			this.resizeHandle,
			this.controls,
			this.captionInput,
		);

		// The video node has no alt attribute, so only images get the alt editor.
		if (!isVideo) {
			this.altButton = document.createElement("button");
			this.altButton.type = "button";
			this.altButton.className = "FileEditorRichTextMedia-alt-button" satisfies FileEditorRichTextMedia_ClassNames;
			this.altButton.textContent = "Alt";
			this.altButton.setAttribute("aria-label", "Edit alt text (Alt+Enter)");
			this.altButton.addEventListener("mousedown", (event) => event.stopPropagation());
			this.altButton.addEventListener("click", this.handle_alt_open);
			this.dom.addEventListener(MEDIA_ALT_OPEN_EVENT, () => this.open_alt_editor());

			this.altInput = document.createElement("input");
			this.altInput.type = "text";
			this.altInput.className = "FileEditorRichTextMedia-alt-input" satisfies FileEditorRichTextMedia_ClassNames;
			this.altInput.setAttribute("aria-label", "Alt text");
			this.altInput.placeholder = "Describe this image";
			this.altInput.addEventListener("mousedown", (event) => event.stopPropagation());
			this.altInput.addEventListener("keydown", this.handle_alt_keydown);
			this.altInput.addEventListener("blur", this.handle_alt_commit);

			this.controls.append(this.altButton);
			this.dom.append(this.altInput);
		}

		this.apply_text_attributes();
		this.apply_width();
		this.apply_align();
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
			this.controls.contains(target) ||
			this.captionInput.contains(target) ||
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
		this.apply_align();
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

	private commit_attributes(attrs: {
		width?: number | null;
		alt?: string | null;
		title?: string | null;
		align?: MediaAlign;
	}) {
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
			const width = Math.round(
				Math.min(MEDIA_MAX_WIDTH_PX, Math.max(MEDIA_MIN_WIDTH_PX, startWidth + (moveEvent.clientX - startX))),
			);
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
		this.open_alt_editor();
	};

	private open_alt_editor() {
		if (!this.altInput) {
			return;
		}
		this.altInput.value = typeof this.node.attrs.alt === "string" ? this.node.attrs.alt : "";
		this.dom.classList.add("FileEditorRichTextMedia-alt-editing" satisfies FileEditorRichTextMedia_ClassNames);
		this.altInput.focus();
		this.altInput.select();
	}

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

	private handle_caption_open = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		this.open_caption_editor();
	};

	private open_caption_editor() {
		this.captionInput.value = typeof this.node.attrs.title === "string" ? this.node.attrs.title : "";
		this.dom.classList.add("FileEditorRichTextMedia-caption-editing" satisfies FileEditorRichTextMedia_ClassNames);
		this.captionInput.focus();
		this.captionInput.select();
	}

	private handle_caption_keydown = (event: KeyboardEvent) => {
		// The editor must never treat these keys as document input.
		event.stopPropagation();
		if (event.key === "Enter") {
			event.preventDefault();
			this.handle_caption_commit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			this.close_caption_editor();
		}
	};

	private handle_caption_commit = () => {
		// Closing the editor moves focus, which fires the input's blur; the class check keeps
		// that second call (and a blur after Escape) from committing again.
		if (
			!this.dom.classList.contains("FileEditorRichTextMedia-caption-editing" satisfies FileEditorRichTextMedia_ClassNames)
		) {
			return;
		}

		const value = this.captionInput.value.trim();
		this.close_caption_editor();
		this.commit_attributes({ title: value || null });
	};

	private close_caption_editor() {
		this.dom.classList.remove("FileEditorRichTextMedia-caption-editing" satisfies FileEditorRichTextMedia_ClassNames);
		this.view.focus();
	}

	private handle_align_cycle = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const align: MediaAlign =
			this.node.attrs.align === "center" || this.node.attrs.align === "right" ? this.node.attrs.align : null;
		this.commit_attributes({ align: media_next_align(align) });
	};

	/**
	 * Put the document's text attributes on the element. `title` is the caption for both
	 * media kinds: visible under the media and doubling as the hover tooltip. `alt` is
	 * image-only; without it a screen reader falls back to reading the signed url's
	 * filename, which is a random asset key.
	 */
	private apply_text_attributes() {
		const title = typeof this.node.attrs.title === "string" ? this.node.attrs.title : "";
		this.caption.textContent = title;
		if (title) {
			this.media.title = title;
		} else {
			this.media.removeAttribute("title");
		}

		if (!(this.media instanceof HTMLImageElement)) {
			return;
		}
		this.media.alt = typeof this.node.attrs.alt === "string" ? this.node.attrs.alt : "";
	}

	/**
	 * Apply the document's alignment as a class on the root, and keep the align button's
	 * label saying what the current placement is.
	 */
	private apply_align() {
		const align: MediaAlign =
			this.node.attrs.align === "center" || this.node.attrs.align === "right" ? this.node.attrs.align : null;
		this.dom.classList.toggle(
			"FileEditorRichTextMedia-align-center" satisfies FileEditorRichTextMedia_ClassNames,
			align === "center",
		);
		this.dom.classList.toggle(
			"FileEditorRichTextMedia-align-right" satisfies FileEditorRichTextMedia_ClassNames,
			align === "right",
		);
		this.alignButton.textContent = `Align: ${align ?? "left"}`;
	}

	destroy() {
		this.isDestroyed = true;
		this.assetWatchUnsubscribe?.();
		this.assetWatchUnsubscribe = null;
		this.localUploadUnsubscribe?.();
		this.localUploadUnsubscribe = null;
		this.clear_expiry_timer();
	}

	private clear_expiry_timer() {
		if (this.expiryTimer) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
		}
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
		this.clear_expiry_timer();

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
			// No local entry (the return above) and no src: this is a collaborator's or a reloaded
			// tab's view of somebody else's in-flight upload. If the src never arrives, the
			// uploader's tab died, so stop claiming progress after a while. There are no local
			// bytes here, so the failed state deliberately has no retry.
			if (uploadId) {
				this.expiryTimer = setTimeout(() => {
					this.expiryTimer = null;
					this.render_state("failed");
				}, UPLOADING_PLACEHOLDER_EXPIRY_MS);
			}
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

			this.clear_expiry_timer();

			const state = media_state_from_asset(asset);
			if (state !== "ready") {
				// Nothing in the database changes when the upload deadline passes, so the watch
				// never fires again on its own and "Processing…" would stay on screen forever.
				// Re-run this check right after the deadline to flip the placeholder to "failed".
				if (state === "processing" && asset && asset.unfinalizedExpiresAt !== undefined) {
					this.expiryTimer = setTimeout(
						() => {
							this.expiryTimer = null;
							apply();
						},
						Math.max(0, asset.unfinalizedExpiresAt - Date.now()) + 1000,
					);
				}
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

/**
 * Resize the selected image or video from the keyboard. Mirrors the pointer drag: same clamp,
 * and the node is re-selected after the replace so the next press keeps working.
 */
function media_adjust_width(editor: Editor, delta: number) {
	const state = editor.view.state;
	const selection = state.selection;
	if (!(selection instanceof NodeSelection)) {
		return false;
	}
	const node = selection.node;
	if (node.type.name !== "image" && node.type.name !== "video") {
		return false;
	}

	// With no stored width, start from the rendered size so the first press is a small nudge,
	// not a jump to some unrelated default.
	let width = typeof node.attrs.width === "number" && Number.isFinite(node.attrs.width) ? node.attrs.width : null;
	if (width === null) {
		const dom = editor.view.nodeDOM(selection.from);
		const media = dom instanceof HTMLElement ? dom.querySelector("img, video") : null;
		width = media ? Math.round(media.getBoundingClientRect().width) : null;
	}
	if (width === null) {
		return false;
	}

	const next = Math.round(Math.min(MEDIA_MAX_WIDTH_PX, Math.max(MEDIA_MIN_WIDTH_PX, width + delta)));
	const tr = state.tr.setNodeMarkup(selection.from, undefined, { ...node.attrs, width: next });
	tr.setSelection(NodeSelection.create(tr.doc, selection.from));
	editor.view.dispatch(tr);
	return true;
}

/**
 * Cycle the selected embed's alignment left → center → right from the keyboard. Same
 * re-select as the width helper above.
 */
function media_cycle_align(editor: Editor) {
	const state = editor.view.state;
	const selection = state.selection;
	if (!(selection instanceof NodeSelection)) {
		return false;
	}
	const node = selection.node;
	if (node.type.name !== "image" && node.type.name !== "video") {
		return false;
	}

	const align: MediaAlign = node.attrs.align === "center" || node.attrs.align === "right" ? node.attrs.align : null;
	const tr = state.tr.setNodeMarkup(selection.from, undefined, { ...node.attrs, align: media_next_align(align) });
	tr.setSelection(NodeSelection.create(tr.doc, selection.from));
	editor.view.dispatch(tr);
	return true;
}

export const file_editor_rich_text_MediaExtension = Extension.create<{
	membershipId: app_convex_Id<"organizations_workspaces_users"> | null;
}>({
	name: "fileEditorRichTextMedia",

	addOptions() {
		return { membershipId: null };
	},

	addKeyboardShortcuts() {
		return {
			// Keyboard path for the pointer-only resize handle.
			"Alt-ArrowRight": () => media_adjust_width(this.editor, MEDIA_KEYBOARD_WIDTH_STEP_PX),
			"Alt-ArrowLeft": () => media_adjust_width(this.editor, -MEDIA_KEYBOARD_WIDTH_STEP_PX),
			// Keyboard path for the align button.
			"Alt-Shift-a": () => media_cycle_align(this.editor),
			// Keyboard path for the alt editor; only images have one.
			"Alt-Enter": () => {
				const selection = this.editor.view.state.selection;
				if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") {
					return false;
				}
				const dom = this.editor.view.nodeDOM(selection.from);
				if (!(dom instanceof HTMLElement)) {
					return false;
				}
				dom.dispatchEvent(new CustomEvent(MEDIA_ALT_OPEN_EVENT));
				return true;
			},
			// Keyboard path for the caption editor; images and videos both have one.
			"Alt-Shift-Enter": () => {
				const selection = this.editor.view.state.selection;
				if (!(selection instanceof NodeSelection)) {
					return false;
				}
				const typeName = selection.node.type.name;
				if (typeName !== "image" && typeName !== "video") {
					return false;
				}
				const dom = this.editor.view.nodeDOM(selection.from);
				if (!(dom instanceof HTMLElement)) {
					return false;
				}
				dom.dispatchEvent(new CustomEvent(MEDIA_CAPTION_OPEN_EVENT));
				return true;
			},
		};
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
