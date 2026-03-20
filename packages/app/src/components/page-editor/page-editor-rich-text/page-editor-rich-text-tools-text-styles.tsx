import "./page-editor-rich-text-tools-text-styles.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { cn } from "@/lib/utils.ts";
import type { Except } from "type-fest";

type Item = {
	name: string;
	command: (editor: Editor) => void;
	isActive: (editor: Editor) => boolean;
	icon: React.ComponentType;
	tooltip: string;
};

type ItemState = Except<Item, "isActive"> & {
	isActive: boolean;
};

const items: readonly Item[] = [
	{
		name: "bold",
		command: (editor) => editor?.chain().focus().toggleBold().run(),
		isActive: (editor) => editor?.isActive("bold") ?? false,
		icon: BoldIcon,
		tooltip: "Bold (Ctrl+B)",
	},
	{
		name: "italic",
		command: (editor) => editor?.chain().focus().toggleItalic().run(),
		isActive: (editor) => editor?.isActive("italic") ?? false,
		icon: ItalicIcon,
		tooltip: "Italic (Ctrl+I)",
	},
	{
		name: "underline",
		command: (editor) => editor?.chain().focus().toggleUnderline().run(),
		isActive: (editor) => editor?.isActive("underline") ?? false,
		icon: UnderlineIcon,
		tooltip: "Underline (Ctrl+U)",
	},
	{
		name: "strike",
		command: (editor) => editor?.chain().focus().toggleStrike().run(),
		isActive: (editor) => editor?.isActive("strike") ?? false,
		icon: StrikethroughIcon,
		tooltip: "Strikethrough",
	},
	{
		name: "code",
		command: (editor) => editor?.chain().focus().toggleCode().run(),
		isActive: (editor) => editor?.isActive("code") ?? false,
		icon: CodeIcon,
		tooltip: "Code (Ctrl+E)",
	},
];

// #region text style toggle
type PageEditorRichTextToolsTextStyleToggle_ClassNames = "PageEditorRichTextToolsTextStyleToggle-active";

type PageEditorRichTextToolsTextStyleToggle_Props = {
	editor: Editor;
	icon: ItemState["icon"];
	isActive: ItemState["isActive"];
	tooltip: ItemState["tooltip"];
	onSelect: ItemState["command"];
};

const PageEditorRichTextToolsTextStyleToggle = memo(function PageEditorRichTextToolsTextStyleToggle(
	props: PageEditorRichTextToolsTextStyleToggle_Props,
) {
	const { editor, icon: Icon, isActive, tooltip, onSelect } = props;

	const handleClick = useFn(() => {
		onSelect(editor);
	});

	return (
		<MyIconButton
			variant="ghost"
			tooltip={tooltip}
			onClick={handleClick}
			className={cn(
				isActive &&
					("PageEditorRichTextToolsTextStyleToggle-active" satisfies PageEditorRichTextToolsTextStyleToggle_ClassNames),
			)}
		>
			<MyIconButtonIcon>
				<Icon />
			</MyIconButtonIcon>
		</MyIconButton>
	);
});
// #endregion text style toggle

// #region root
export type PageEditorRichTextToolsTextStyles_ClassNames = "PageEditorRichTextToolsTextStyles";

export type PageEditorRichTextToolsTextStyles_Props = {
	editor: Editor;
};

type PageEditorRichTextToolsTextStylesInner_Props = PageEditorRichTextToolsTextStyles_Props & {
	itemStates: readonly ItemState[];
};

const PageEditorRichTextToolsTextStylesInner = memo(function PageEditorRichTextToolsTextStylesInner(
	props: PageEditorRichTextToolsTextStylesInner_Props,
) {
	const { editor, itemStates } = props;

	return (
		<div className={cn("PageEditorRichTextToolsTextStyles" satisfies PageEditorRichTextToolsTextStyles_ClassNames)}>
			{itemStates.map((item) => (
				<PageEditorRichTextToolsTextStyleToggle
					key={item.name}
					editor={editor}
					icon={item.icon}
					isActive={item.isActive}
					tooltip={item.tooltip}
					onSelect={item.command}
				/>
			))}
		</div>
	);
});

export const PageEditorRichTextToolsTextStyles = memo(function PageEditorRichTextToolsTextStyles(
	props: PageEditorRichTextToolsTextStyles_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to the derived text-style states so formatting transactions rerender immediately.
	const itemActiveStates = useEditorState({
		editor,
		selector: ({ editor }) => {
			return items.map((item) => item.isActive(editor));
		},
	});

	const itemStates = items.map((item, index) => ({
		...item,
		isActive: itemActiveStates[index] ?? false,
	}));

	return <PageEditorRichTextToolsTextStylesInner editor={editor} itemStates={itemStates} />;
});
// #endregion root
