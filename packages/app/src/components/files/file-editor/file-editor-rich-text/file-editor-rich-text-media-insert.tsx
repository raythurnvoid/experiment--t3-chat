// Insertion UI for media embeds: the slash menu items call the editor commands below, and the
// commands hand off to callbacks the editor component configured — the same direction as
// `file_editor_rich_text_SizeLimitExtension.configure({ getIsOverCap })`. The component owns
// the hidden file inputs and the embed-existing picker, because those need React state and
// refs the static slash items cannot reach.

import "./file-editor-rich-text-media-insert.css";
import { memo, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { useQuery } from "convex/react";
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	type MySearchSelect_Props,
} from "@/components/my-search-select.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_media_build_file_src } from "@/lib/files-media-src.ts";
import { cn } from "@/lib/utils.ts";
import { useFn } from "@/hooks/utils-hooks.ts";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		fileEditorRichTextMediaInsert: {
			/**
			 * Open the hidden file input for the given media kind. The picked files then run
			 * through the paste/drop upload flow at the current selection.
			 */
			filesMediaPickUpload: (kind: "image" | "video") => ReturnType;
			/**
			 * Open the picker that embeds an image or video file the workspace already has.
			 */
			filesMediaEmbedExisting: () => ReturnType;
		};
	}
}

/**
 * The Tiptap side of media insertion. Its two commands only forward to callbacks the editor
 * component sets through `configure`, because opening a file input or the picker needs React
 * state and refs that a static extension cannot hold.
 */
// This module also exports a React component, the picker below. The Fast Refresh lint rule wants
// component modules to export nothing else. Keep both here anyway: the commands and the picker
// are one small contract, and splitting them would hide half of it in another file.
// eslint-disable-next-line react-refresh/only-export-components
export const file_editor_rich_text_MediaInsertExtension = Extension.create<{
	pickUploadFile: ((kind: "image" | "video") => void) | null;
	openEmbedExistingPicker: (() => void) | null;
}>({
	name: "fileEditorRichTextMediaInsert",

	addOptions() {
		return { pickUploadFile: null, openEmbedExistingPicker: null };
	},

	addCommands() {
		return {
			filesMediaPickUpload:
				(kind) =>
				() => {
					this.options.pickUploadFile?.(kind);
					return true;
				},
			filesMediaEmbedExisting:
				() =>
				() => {
					this.options.openEmbedExistingPicker?.();
					return true;
				},
		};
	},
});

// #region embed picker
export type FileEditorRichTextMediaEmbedPicker_ClassNames =
	| "FileEditorRichTextMediaEmbedPicker"
	| "FileEditorRichTextMediaEmbedPicker-empty"
	| "FileEditorRichTextMediaEmbedPicker-item"
	| "FileEditorRichTextMediaEmbedPicker-item-name"
	| "FileEditorRichTextMediaEmbedPicker-item-path";

type FileEditorRichTextMediaEmbedPicker_Props = {
	editor: Editor;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	/** The caret rectangle the popover anchors to, captured when the picker was opened. */
	anchorRect: { x: number; y: number; width: number; height: number };
	onClose: () => void;
};

/**
 * A caret-anchored picker listing the workspace's image and video files. Mounted only while
 * open, so the tree subscription lives only as long as the picker (the sidebar already
 * subscribes to the same query with the same args, and Convex dedupes identical
 * subscriptions).
 */
export const FileEditorRichTextMediaEmbedPicker = memo(function FileEditorRichTextMediaEmbedPicker(
	props: FileEditorRichTextMediaEmbedPicker_Props,
) {
	const { editor, membershipId, anchorRect, onClose } = props;

	const [searchText, setSearchText] = useState("");

	const treeNodes = useQuery(app_convex_api.files_nodes.list_tree, { membershipId });
	const mediaNodes = (treeNodes ?? []).filter(
		(node) =>
			node.kind === "file" &&
			(node.contentType?.startsWith("image/") === true || node.contentType?.startsWith("video/") === true),
	);
	const normalizedSearchText = searchText.trim().toLowerCase();
	const shownNodes = normalizedSearchText
		? mediaNodes.filter((node) => node.path.toLowerCase().includes(normalizedSearchText))
		: mediaNodes;

	const handleSetOpen: MySearchSelect_Props["setOpen"] = (open) => {
		if (!open) {
			onClose();
		}
	};

	const handleSetValue = useFn<NonNullable<MySearchSelect_Props["setValue"]>>((value) => {
		const node = mediaNodes.find((mediaNode) => mediaNode._id === value);
		if (!node) {
			return;
		}

		// The document stores the node reference; the node view signs a url while rendering.
		editor
			.chain()
			.focus()
			.insertContent(
				node.contentType?.startsWith("video/")
					? { type: "video", attrs: { src: files_media_build_file_src(node._id) } }
					: { type: "image", attrs: { src: files_media_build_file_src(node._id), alt: node.name } },
			)
			.run();
		onClose();
	});

	return (
		// The value is pinned to "" because Ariakit adopts the first item's value on mount when
		// no value is given, and that would fire `setValue` — inserting an embed nobody picked
		// and closing the picker in the frame it opened.
		<MySearchSelect open value="" setOpen={handleSetOpen} setValue={handleSetValue}>
			<MySearchSelectPopover
				className={cn("FileEditorRichTextMediaEmbedPicker" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames)}
				aria-label="Embed a workspace file"
				getAnchorRect={() => anchorRect}
			>
				<MySearchSelectPopoverScrollableArea>
					<MySearchSelectPopoverContent>
						<MySearchSelectSearch
							placeholder="Search images and videos..."
							aria-label="Search images and videos"
							onChange={(event) => setSearchText(event.currentTarget.value)}
						/>
						{shownNodes.length === 0 ? (
							<div
								className={cn(
									"FileEditorRichTextMediaEmbedPicker-empty" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames,
								)}
							>
								{mediaNodes.length === 0 ? "No images or videos in this workspace" : "No results"}
							</div>
						) : (
							<MySearchSelectList>
								{shownNodes.map((node) => (
									<MySearchSelectItem
										key={node._id}
										value={node._id}
										className={cn(
											"FileEditorRichTextMediaEmbedPicker-item" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames,
										)}
									>
										<span
											className={cn(
												"FileEditorRichTextMediaEmbedPicker-item-name" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames,
											)}
										>
											{node.name}
										</span>
										<span
											className={cn(
												"FileEditorRichTextMediaEmbedPicker-item-path" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames,
											)}
										>
											{node.path}
										</span>
									</MySearchSelectItem>
								))}
							</MySearchSelectList>
						)}
					</MySearchSelectPopoverContent>
				</MySearchSelectPopoverScrollableArea>
			</MySearchSelectPopover>
		</MySearchSelect>
	);
});
// #endregion embed picker
