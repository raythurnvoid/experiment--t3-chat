import {
	CheckSquare,
	Code,
	Heading1,
	Heading2,
	Heading3,
	ImageIcon,
	List,
	ListOrdered,
	Text,
	TextQuote,
	Twitter,
	Youtube,
} from "lucide-react";
import { createSuggestionItems, Command, renderItems } from "novel";
import { uploadFn } from "./image-upload";

export const suggestionItems = createSuggestionItems([
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

export const slashCommand = Command.configure({
	suggestion: {
		items: () => suggestionItems,
		render: renderItems,
	},
});
