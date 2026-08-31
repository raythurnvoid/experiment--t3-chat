import "./file-editor-rich-text-tools-slash-command.css";
import {
	CheckSquare,
	Clapperboard,
	Code,
	FileImage,
	FileVideo,
	Heading1,
	Heading2,
	Heading3,
	Heading4,
	Heading5,
	Heading6,
	ImageDown,
	ImagePlus,
	List,
	ListOrdered,
	Table,
	Text,
	TextQuote,
	Twitter,
	Youtube,
} from "lucide-react";
import {
	createSuggestionItems,
	Command,
	renderItems,
	EditorCommand,
	EditorCommandEmpty,
	EditorCommandItem,
	EditorCommandList,
} from "novel";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import type { MyPopoverContent_ClassNames } from "../../../my-popover.tsx";
import type {
	MyMenuItem_ClassNames,
	MyMenuItemContentIcon_ClassNames,
	MyMenuItemContentPrimary_ClassNames,
	MyMenuItemContentSecondary_ClassNames,
} from "../../../my-menu.tsx";

export type FileEditorRichTextToolsSlashCommand_ClassNames =
	| "FileEditorRichTextToolsSlashCommand"
	| "FileEditorRichTextToolsSlashCommand-empty"
	| "FileEditorRichTextToolsSlashCommand-list"
	| "FileEditorRichTextToolsSlashCommand-item"
	| "FileEditorRichTextToolsSlashCommand-item-icon"
	| "FileEditorRichTextToolsSlashCommand-item-content"
	| "FileEditorRichTextToolsSlashCommand-item-title"
	| "FileEditorRichTextToolsSlashCommand-item-description";

const suggestionItems = createSuggestionItems([
	{
		title: "Text",
		description: "Just start typing with plain text.",
		searchTerms: ["p", "paragraph"],
		icon: <Text size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleNode("paragraph", "paragraph").run();
		},
	},
	{
		title: "To-do List",
		description: "Track tasks with a to-do list.",
		searchTerms: ["todo", "task", "list", "check", "checkbox"],
		icon: <CheckSquare size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleTaskList().run();
		},
	},
	{
		title: "Heading 1",
		description: "Big section heading.",
		searchTerms: ["title", "big", "large"],
		icon: <Heading1 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
		},
	},
	{
		title: "Heading 2",
		description: "Medium section heading.",
		searchTerms: ["subtitle", "medium"],
		icon: <Heading2 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
		},
	},
	{
		title: "Heading 3",
		description: "Small section heading.",
		searchTerms: ["subtitle", "small"],
		icon: <Heading3 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
		},
	},
	{
		title: "Heading 4",
		description: "Smaller section heading.",
		searchTerms: ["subsection", "small"],
		icon: <Heading4 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 4 }).run();
		},
	},
	{
		title: "Heading 5",
		description: "Very small section heading.",
		searchTerms: ["subsection", "x-small"],
		icon: <Heading5 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 5 }).run();
		},
	},
	{
		title: "Heading 6",
		description: "Tiny section heading.",
		searchTerms: ["subsection", "tiny"],
		icon: <Heading6 size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setNode("heading", { level: 6 }).run();
		},
	},
	{
		title: "Bullet List",
		description: "Create a simple bullet list.",
		searchTerms: ["unordered", "point"],
		icon: <List size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleBulletList().run();
		},
	},
	{
		title: "Numbered List",
		description: "Create a list with numbering.",
		searchTerms: ["ordered"],
		icon: <ListOrdered size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).toggleOrderedList().run();
		},
	},
	{
		title: "Quote",
		description: "Capture a quote.",
		searchTerms: ["blockquote"],
		icon: <TextQuote size={18} />,
		command: ({ editor, range }) =>
			editor.chain().focus().deleteRange(range).toggleNode("paragraph", "paragraph").toggleBlockquote().run(),
	},
	{
		title: "Code",
		description: "Capture a code snippet.",
		searchTerms: ["codeblock"],
		icon: <Code size={18} />,
		command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
	},
	{
		title: "Table",
		description: "Insert a table.",
		searchTerms: ["table", "grid", "rows", "columns"],
		icon: <Table size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
		},
	},
	{
		title: "Image",
		description: "Upload an image from your device.",
		searchTerms: ["image", "picture", "photo", "upload"],
		icon: <ImagePlus size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).run();
			editor.commands.filesMediaPickUpload("image");
		},
	},
	{
		title: "Video",
		description: "Upload a video from your device.",
		searchTerms: ["video", "movie", "upload"],
		icon: <Clapperboard size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).run();
			editor.commands.filesMediaPickUpload("video");
		},
	},
	{
		title: "Embed file",
		description: "Embed an image or video from this workspace.",
		searchTerms: ["embed", "file", "image", "video", "workspace"],
		icon: <FileImage size={18} />,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).run();
			editor.commands.filesMediaEmbedExisting();
		},
	},
	{
		title: "Image from URL",
		description: "Embed an external image by its link.",
		searchTerms: ["image", "url", "link", "external"],
		icon: <ImageDown size={18} />,
		command: ({ editor, range }) => {
			const image_link = prompt("Please enter the image URL");

			if (!image_link) {
				return;
			}

			// Only plain web urls: the node view refuses every other scheme anyway, and accepting
			// one here would just store a reference that can never render.
			if (!/^https?:\/\//i.test(image_link.trim())) {
				alert("Please enter an http(s) image URL");
				return;
			}

			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({ type: "image", attrs: { src: image_link.trim() } })
				.run();
		},
	},
	{
		title: "Video from URL",
		description: "Embed an external video by its link.",
		searchTerms: ["video", "url", "link", "external"],
		icon: <FileVideo size={18} />,
		command: ({ editor, range }) => {
			const video_link = prompt("Please enter the video URL");

			if (!video_link) {
				return;
			}

			// Same http(s) gate as the image item above.
			if (!/^https?:\/\//i.test(video_link.trim())) {
				alert("Please enter an http(s) video URL");
				return;
			}

			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({ type: "video", attrs: { src: video_link.trim() } })
				.run();
		},
	},
	{
		title: "Youtube",
		description: "Embed a Youtube video.",
		searchTerms: ["video", "youtube", "embed"],
		icon: <Youtube size={18} />,
		command: ({ editor, range }) => {
			const video_link = prompt("Please enter Youtube Video Link");

			if (!video_link) {
				return;
			}

			// From https://regexr.com/3dj5t
			const yt_regex = new RegExp(
				/^((?:https?:)?\/\/)?((?:www|m)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w\-]+\?v=|embed\/|v\/)?)([\w\-]+)(\S+)?$/,
			);

			if (yt_regex.test(video_link)) {
				editor
					.chain()
					.focus()
					.deleteRange(range)
					.setYoutubeVideo({
						src: video_link,
					})
					.run();
			} else {
				if (video_link !== null) {
					alert("Please enter a correct Youtube Video Link");
				}
			}
		},
	},
	{
		title: "Twitter",
		description: "Embed a Tweet.",
		searchTerms: ["twitter", "embed"],
		icon: <Twitter size={18} />,
		command: ({ editor, range }) => {
			const tweet_link = prompt("Please enter Twitter Link");

			if (!tweet_link) {
				return;
			}

			const tweet_regex = new RegExp(/^https?:\/\/(www\.)?x\.com\/([a-zA-Z0-9_]{1,15})(\/status\/(\d+))?(\/\S*)?$/);

			if (tweet_regex.test(tweet_link)) {
				editor
					.chain()
					.focus()
					.deleteRange(range)
					.setTweet({
						src: tweet_link,
					})
					.run();
			} else {
				if (tweet_link !== null) {
					alert("Please enter a correct Twitter Link");
				}
			}
		},
	},
]);

const slashCommand = Command.configure({
	suggestion: {
		items: () => suggestionItems,
		render: renderItems,
	},
});

export function FileEditorRichTextToolsSlashCommand() {
	return (
		<EditorCommand
			className={cn(
				"FileEditorRichTextToolsSlashCommand" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
				"app-scrollable" satisfies AppClassName,
				"MyPopoverContent" satisfies MyPopoverContent_ClassNames,
			)}
		>
			<EditorCommandEmpty
				className={cn(
					"FileEditorRichTextToolsSlashCommand-empty" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
				)}
			>
				No results
			</EditorCommandEmpty>
			<EditorCommandList
				className={cn(
					"FileEditorRichTextToolsSlashCommand-list" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
				)}
			>
				{suggestionItems.map((item) => (
					<EditorCommandItem
						value={item.title}
						onCommand={(val) => {
							if (!item?.command) {
								return;
							}

							item.command(val);
						}}
						className={cn(
							"FileEditorRichTextToolsSlashCommand-item" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
							"MyMenuItem" satisfies MyMenuItem_ClassNames,
						)}
						key={item.title}
					>
						<div
							className={cn(
								"FileEditorRichTextToolsSlashCommand-item-icon" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
								"MyMenuItemContentIcon" satisfies MyMenuItemContentIcon_ClassNames,
							)}
						>
							{item.icon}
						</div>
						<div
							className={cn(
								"FileEditorRichTextToolsSlashCommand-item-content" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
							)}
						>
							<p
								className={cn(
									"FileEditorRichTextToolsSlashCommand-item-title" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
									"MyMenuItemContentPrimary" satisfies MyMenuItemContentPrimary_ClassNames,
								)}
							>
								{item.title}
							</p>
							<p
								className={cn(
									"FileEditorRichTextToolsSlashCommand-item-description" satisfies FileEditorRichTextToolsSlashCommand_ClassNames,
									"MyMenuItemContentSecondary" satisfies MyMenuItemContentSecondary_ClassNames,
								)}
							>
								{item.description}
							</p>
						</div>
					</EditorCommandItem>
				))}
			</EditorCommandList>
		</EditorCommand>
	);
}

FileEditorRichTextToolsSlashCommand.suggestionItems = suggestionItems;
FileEditorRichTextToolsSlashCommand.slashCommand = slashCommand;
