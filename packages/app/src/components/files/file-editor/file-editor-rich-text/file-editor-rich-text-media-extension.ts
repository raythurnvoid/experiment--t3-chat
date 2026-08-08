// Node views for the image and video embeds.
//
// The nodes themselves live in `shared/files-tiptap.ts`, because Convex serializes documents to
// markdown with that same extension set and a node missing from it is dropped without a word.
// Only the on-screen part lives here: a document holds a `bonobo-file://<fileNodeId>` reference,
// and the element needs a real url, which depends on who is looking. The membership is known only
// once an editor is built, so this extension is configured where the editor is assembled, next to
// the size limit extension.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_media_get_signed_url, files_media_parse_src, files_media_resolve_file_node } from "@/lib/files-media-src.ts";

export type FileEditorRichTextMedia_ClassNames =
	| "FileEditorRichTextMedia"
	| "FileEditorRichTextMedia-image"
	| "FileEditorRichTextMedia-video"
	| "FileEditorRichTextMedia-placeholder"
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
	private assetWatchUnsubscribe: (() => void) | null = null;
	private isDestroyed = false;

	constructor(
		private node: PmNode,
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

		this.dom.append(this.media, this.placeholder);
		this.apply_text_attributes();
		this.resolve();
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
		if (!hasSameSource) {
			this.resolve();
		}

		return true;
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

		if (state === "ready" && url) {
			this.media.src = url;
			this.placeholder.textContent = "";
			return;
		}

		// "ready" without a url means signing failed after all, which leaves nothing to show.
		const placeholderState: MediaPlaceholderState = state === "ready" ? "missing" : state;

		// Drop any url already on the element, so a failed reload cannot keep showing stale media.
		this.media.removeAttribute("src");
		this.dom.classList.add(MEDIA_STATE_CLASS_NAMES[placeholderState]);
		const alt = typeof this.node.attrs.alt === "string" && this.node.attrs.alt ? `: ${this.node.attrs.alt}` : "";
		this.placeholder.textContent = `${MEDIA_STATE_LABELS[placeholderState]}${alt}`;
	}

	private resolve() {
		this.assetWatchUnsubscribe?.();
		this.assetWatchUnsubscribe = null;

		const src = typeof this.node.attrs.src === "string" ? this.node.attrs.src : "";
		if (!src) {
			this.render_state(this.node.attrs.uploadId ? "uploading" : "missing");
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

		const createNodeView = (node: PmNode) => new MediaNodeView(node, membershipId);

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
