// Insertion UI for media embeds: the slash menu items call the editor commands below, and the
// commands hand off to callbacks the editor component configured — the same direction as
// `file_editor_rich_text_SizeLimitExtension.configure({ getIsOverCap })`. The component owns
// the hidden file inputs and the embed-existing picker, because those need React state and
// refs the static slash items cannot reach.

import "./file-editor-rich-text-media-insert.css";
import { memo, useState } from "react";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import {
	MySearchSelect,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	type MySearchSelect_Props,
} from "@/components/my-search-select.tsx";
import {
	FilesNodePicker,
	type FilesNodePicker_Pickable,
	type FilesNodePicker_Row,
} from "@/components/files/files-node-picker.tsx";
import { files_media_build_file_src } from "../../../../../shared/files-media.ts";
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
			filesMediaPickUpload: (kind) => () => {
				this.options.pickUploadFile?.(kind);
				return true;
			},
			filesMediaEmbedExisting: () => () => {
				this.options.openEmbedExistingPicker?.();
				return true;
			},
		};
	},
});

// #region embed picker
export type FileEditorRichTextMediaEmbedPicker_ClassNames = "FileEditorRichTextMediaEmbedPicker";

type FileEditorRichTextMediaEmbedPicker_Props = {
	editor: Editor;
	/** The caret rectangle the popover anchors to, captured when the picker was opened. */
	anchorRect: { x: number; y: number; width: number; height: number };
	onClose: () => void;
};

/**
 * Only images and videos can be embedded. Other files show disabled, because the name search
 * cannot leave them out.
 */
function media_row_pickable(row: FilesNodePicker_Row): FilesNodePicker_Pickable {
	return row.contentType?.startsWith("image/") || row.contentType?.startsWith("video/")
		? { ok: true }
		: { ok: false, reason: "This file is not an image or video" };
}

/**
 * A caret-anchored picker that embeds an image or video file of the workspace.
 */
export const FileEditorRichTextMediaEmbedPicker = memo(function FileEditorRichTextMediaEmbedPicker(
	props: FileEditorRichTextMediaEmbedPicker_Props,
) {
	const { editor, anchorRect, onClose } = props;

	const [searchText, setSearchText] = useState("");

	const handleSetOpen: MySearchSelect_Props["setOpen"] = (open) => {
		if (!open) {
			onClose();
		}
	};

	const handlePick = useFn((row: FilesNodePicker_Row) => {
		// The document stores the node reference; the node view signs a url while rendering.
		editor
			.chain()
			.focus()
			.insertContent(
				row.contentType?.startsWith("video/")
					? { type: "video", attrs: { src: files_media_build_file_src(row.nodeId) } }
					: { type: "image", attrs: { src: files_media_build_file_src(row.nodeId), alt: row.name } },
			)
			.run();
		onClose();
	});

	return (
		<MySearchSelect open setOpen={handleSetOpen}>
			<MySearchSelectPopover
				className={cn("FileEditorRichTextMediaEmbedPicker" satisfies FileEditorRichTextMediaEmbedPicker_ClassNames)}
				aria-label="Embed a workspace file"
				anchorRect={anchorRect}
			>
				<MySearchSelectPopoverScrollableArea>
					<MySearchSelectPopoverContent>
						<MySearchSelectSearch
							placeholder="Search files..."
							aria-label="Search files"
							value={searchText}
							onChange={(event) => setSearchText(event.currentTarget.value)}
						/>
						<FilesNodePicker
							variant="select"
							query={searchText}
							select="file"
							folderRow={null}
							getPickable={media_row_pickable}
							onPick={handlePick}
							clearQuery={() => setSearchText("")}
						/>
					</MySearchSelectPopoverContent>
				</MySearchSelectPopoverScrollableArea>
			</MySearchSelectPopover>
		</MySearchSelect>
	);
});
// #endregion embed picker
