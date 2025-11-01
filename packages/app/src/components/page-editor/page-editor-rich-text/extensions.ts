import {
	AIHighlight,
	CharacterCount,
	CodeBlockLowlight,
	Color,
	CustomKeymap,
	HorizontalRule,
	Placeholder,
	StarterKit,
	TaskItem,
	TaskList,
	Twitter,
	Youtube,
	Mathematics,
} from "novel";
import { cx } from "class-variance-authority";
import { common, createLowlight } from "lowlight";
import { pages_get_tiptap_shared_extensions } from "@/lib/pages.ts";

//TODO I am using cx here to get tailwind autocomplete working, idk if someone else can write a regex to just capture the class key in objects
const aiHighlight = AIHighlight;
//You can overwrite the placeholder with your own configuration
const placeholder = Placeholder;

const sharedExtensions = pages_get_tiptap_shared_extensions();

const starterKit = StarterKit.configure({
	// The Liveblocks extension comes with its own history handling
	undoRedo: false,
	codeBlock: false,
	horizontalRule: false,
	dropcursor: {
		color: "#DBEAFE",
		width: 4,
	},
	gapcursor: false,
});

const taskList = TaskList.configure({
	HTMLAttributes: {
		class: cx("not-prose pl-2 "),
	},
});

const taskItem = TaskItem.configure({
	HTMLAttributes: {
		class: cx("flex gap-2 items-start my-4"),
	},
	nested: true,
});

const horizontalRule = HorizontalRule.configure({
	HTMLAttributes: {
		class: cx("mt-4 mb-6 border-t border-muted-foreground"),
	},
});

const codeBlockLowlight = CodeBlockLowlight.configure({
	// configure lowlight: common /  all / use highlightJS in case there is a need to specify certain language grammars only
	// common: covers 37 language grammars which should be good enough in most cases
	lowlight: createLowlight(common),
});

const youtube = Youtube.configure({
	HTMLAttributes: {
		class: cx("rounded-lg border border-muted"),
	},
	inline: false,
});

const twitter = Twitter.configure({
	HTMLAttributes: {
		class: cx("not-prose"),
	},
	inline: false,
});

const mathematics = Mathematics.configure({
	HTMLAttributes: {
		class: cx("text-foreground rounded p-1 hover:bg-accent cursor-pointer"),
	},
	katexOptions: {
		throwOnError: false,
	},
});

const characterCount = CharacterCount.configure();

export const defaultExtensions = [
	starterKit,
	placeholder,
	taskList,
	taskItem,
	horizontalRule,
	aiHighlight,
	codeBlockLowlight,
	youtube,
	twitter,
	mathematics,
	characterCount,
	sharedExtensions.markdown,
	sharedExtensions.highlight,
	sharedExtensions.textStyle,
	Color,
	sharedExtensions.underline,
	CustomKeymap,
	sharedExtensions.textAlign,
	sharedExtensions.typography,
];
