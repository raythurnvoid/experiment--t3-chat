import {
	DecorationHighlight,
	CharacterCount,
	CodeBlockLowlight,
	Color,
	CustomKeymap,
	DragHandle,
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
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { files_get_tiptap_shared_extensions } from "../../../../../shared/files-tiptap.ts";

//TODO I am using cx here to get tailwind autocomplete working, idk if someone else can write a regex to just capture the class key in objects
const decorationHighlight = DecorationHighlight;
//You can overwrite the placeholder with your own configuration
const placeholder = Placeholder;

const sharedExtensions = files_get_tiptap_shared_extensions();

const starterKit = StarterKit.configure({
	// The Liveblocks extension comes with its own history handling
	undoRedo: false,
	underline: false,
	dropcursor: {
		color: false,
		width: 4,
	},
	gapcursor: false,

	//
	horizontalRule: false,
	codeBlock: false,
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

type FileEditorRichTextFrontmatter_ClassNames = "FileEditorRichTextFrontmatter-key" | "FileEditorRichTextFrontmatter-focused";

// Browser-only polish for the shared frontmatter node: tint YAML keys and brighten the
// block border while the caret is inside it. Decorations never change the document, so
// the markdown round-trip in `shared/files-tiptap.ts` stays byte-exact.
const frontmatter = sharedExtensions.frontmatter.extend({
	addProseMirrorPlugins() {
		const frontmatterTypeName = this.name;

		return [
			new Plugin({
				props: {
					decorations(state) {
						// Frontmatter is only recognized at the document start, so only the first
						// block can be one. A block moved elsewhere just loses this polish.
						const firstNode = state.doc.firstChild;
						if (!firstNode || firstNode.type.name !== frontmatterTypeName) {
							return null;
						}

						const decorations: Decoration[] = [];

						// The node holds one text run with literal newlines; positions inside it
						// start at 1 (position 0 is the node boundary).
						const text = firstNode.textContent;
						const keyLineRegex = /^([ \t]*(?:- )?)([A-Za-z0-9_-]+:)(?=[ \t]|$)/gm;
						let match;
						while ((match = keyLineRegex.exec(text)) !== null) {
							const keyFrom = 1 + match.index + match[1].length;
							decorations.push(
								Decoration.inline(keyFrom, keyFrom + match[2].length, {
									class: "FileEditorRichTextFrontmatter-key" satisfies FileEditorRichTextFrontmatter_ClassNames,
								}),
							);
						}

						// Selection positions past the node end belong to the document body.
						if (state.selection.to <= firstNode.nodeSize) {
							decorations.push(
								Decoration.node(0, firstNode.nodeSize, {
									class: "FileEditorRichTextFrontmatter-focused" satisfies FileEditorRichTextFrontmatter_ClassNames,
								}),
							);
						}

						return DecorationSet.create(state.doc, decorations);
					},
				},
			}),
		];
	},
});

export const defaultExtensions = [
	starterKit,
	placeholder,
	taskList,
	taskItem,
	decorationHighlight,
	codeBlockLowlight,
	youtube,
	twitter,
	mathematics,
	characterCount,
	sharedExtensions.markdown,
	// The media nodes come from the shared set, so the client schema and the schema Convex
	// serializes with stay identical. Their node views are added by
	// `file_editor_rich_text_MediaExtension`, which needs a membership and is configured where the
	// editor is assembled.
	sharedExtensions.image,
	sharedExtensions.video,
	sharedExtensions.highlight,
	sharedExtensions.textStyle,
	Color,
	sharedExtensions.underline,
	sharedExtensions.liveblocksComments,
	CustomKeymap,
	DragHandle,
	sharedExtensions.textAlign,
	sharedExtensions.typography,
	sharedExtensions.horizontalRule,
	frontmatter,
];
