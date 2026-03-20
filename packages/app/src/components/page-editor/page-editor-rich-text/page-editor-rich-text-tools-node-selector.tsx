import {
	CheckSquare,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Heading4,
	Heading5,
	Heading6,
	ListOrdered,
	type LucideIcon,
	TextIcon,
	TextQuote,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
	MySelect,
	MySelectTrigger,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectItem,
	MySelectItemIndicator,
	MySelectItemContent,
	MySelectItemContentPrimary,
	MySelectItemContentIcon,
	type MySelectItem_Props,
} from "@/components/my-select.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import "./page-editor-rich-text-tools-node-selector.css";
import { PageEditorRichText } from "./page-editor-rich-text.tsx";
import type { PageEditorRichText_CustomAttributes } from "./page-editor-rich-text.tsx";

type TransformItem = {
	name: string;
	Icon: LucideIcon;
	command: (editor: Editor) => void;
	isActive: (editor: Editor) => boolean;
};

const transformItems: TransformItem[] = [
	{
		name: "Text",
		Icon: TextIcon,
		command: (editor) => editor?.chain().focus().clearNodes().run(),
		isActive: (editor) =>
			(editor?.isActive("paragraph") && !editor?.isActive("bulletList") && !editor?.isActive("orderedList")) ?? false,
	},
	{
		name: "Heading 1",
		Icon: Heading1,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 1 }) ?? false,
	},
	{
		name: "Heading 2",
		Icon: Heading2,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 2 }) ?? false,
	},
	{
		name: "Heading 3",
		Icon: Heading3,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 3 }) ?? false,
	},
	{
		name: "Heading 4",
		Icon: Heading4,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 4 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 4 }) ?? false,
	},
	{
		name: "Heading 5",
		Icon: Heading5,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 5 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 5 }) ?? false,
	},
	{
		name: "Heading 6",
		Icon: Heading6,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 6 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 6 }) ?? false,
	},
	{
		name: "To-do List",
		Icon: CheckSquare,
		command: (editor) => editor?.chain().focus().clearNodes().toggleTaskList().run(),
		isActive: (editor) => editor?.isActive("taskItem") ?? false,
	},
	{
		name: "Bullet List",
		Icon: ListOrdered,
		command: (editor) => editor?.chain().focus().clearNodes().toggleBulletList().run(),
		isActive: (editor) => editor?.isActive("bulletList") ?? false,
	},
	{
		name: "Numbered List",
		Icon: ListOrdered,
		command: (editor) => editor?.chain().focus().clearNodes().toggleOrderedList().run(),
		isActive: (editor) => editor?.isActive("orderedList") ?? false,
	},
	{
		name: "Quote",
		Icon: TextQuote,
		command: (editor) => editor?.chain().focus().clearNodes().toggleBlockquote().run(),
		isActive: (editor) => editor?.isActive("blockquote") ?? false,
	},
	{
		name: "Code",
		Icon: Code,
		command: (editor) => editor?.chain().focus().clearNodes().toggleCodeBlock().run(),
		isActive: (editor) => editor?.isActive("codeBlock") ?? false,
	},
];

// #region item
export type PageEditorRichTextToolsNodeSelector_ClassNames =
	| "PageEditorRichTextToolsNodeSelector"
	| "PageEditorRichTextToolsNodeSelector-popover"
	| "PageEditorRichTextToolsNodeSelector-item"
	| "PageEditorRichTextToolsNodeSelector-icon";

type PageEditorRichTextToolsNodeSelectorItem_Props = {
	item: TransformItem;
	isActive: boolean;
	onSelect: (item: TransformItem) => void;
};

const PageEditorRichTextToolsNodeSelectorItem = memo(function PageEditorRichTextToolsNodeSelectorItem(
	props: PageEditorRichTextToolsNodeSelectorItem_Props,
) {
	const { item, isActive, onSelect } = props;

	const handleClick = useFn<NonNullable<MySelectItem_Props["onClick"]>>(() => {
		onSelect(item);
	});

	return (
		<MySelectItem
			className={cn(
				"PageEditorRichTextToolsNodeSelector-item" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
			)}
			value={item.name}
			onClick={handleClick}
		>
			<MySelectItemContent>
				<MySelectItemContentIcon
					className={cn(
						"PageEditorRichTextToolsNodeSelector-icon" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
					)}
				>
					<item.Icon />
				</MySelectItemContentIcon>
				<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
			</MySelectItemContent>

			{isActive && <MySelectItemIndicator />}
		</MySelectItem>
	);
});
// #endregion item

// #region root
export type PageEditorRichTextToolsNodeSelector_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

type PageEditorRichTextToolsNodeSelectorInner_Props = PageEditorRichTextToolsNodeSelector_Props & {
	activeItemName: string;
};

/**
 * Inner component necessary to let the compiler optimize this while keeping the outer component un-optimized.
 */
const PageEditorRichTextToolsNodeSelectorInner = memo(function PageEditorRichTextToolsNodeSelectorInner(
	props: PageEditorRichTextToolsNodeSelectorInner_Props,
) {
	const { editor, activeItemName, setDecorationHighlightOnOpen = false } = props;

	const [open, setOpen] = useState(false);

	const triggerButtonRef = useRef<HTMLButtonElement>(null);
	const openRef = useRef(false);
	const didSetDecorationHighlightRef = useRef(false);

	const doSetOpen = useFn((next: boolean | ((prev: boolean) => boolean)) => {
		const prev = openRef.current;
		const nextOpen = typeof next === "function" ? next(prev) : next;

		openRef.current = nextOpen;
		setOpen(nextOpen);

		if (setDecorationHighlightOnOpen) {
			if (nextOpen && !prev) {
				didSetDecorationHighlightRef.current = editor.commands.setDecorationHighlight();
			} else if (!nextOpen && prev && didSetDecorationHighlightRef.current) {
				PageEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
				didSetDecorationHighlightRef.current = false;
			}
		}
	});

	const handleClick = useFn((item: TransformItem) => {
		item.command(editor);
	});

	const renderItem = useFn((item: TransformItem) => {
		return (
			<PageEditorRichTextToolsNodeSelectorItem
				key={item.name}
				item={item}
				isActive={activeItemName === item.name}
				onSelect={handleClick}
			/>
		);
	});

	// Clear the decoration highlight on unmount.
	useEffect(() => {
		return () => {
			if (didSetDecorationHighlightRef.current) {
				PageEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
			}
		};
	}, []);

	return (
		<div className={cn("PageEditorRichTextToolsNodeSelector" satisfies PageEditorRichTextToolsNodeSelector_ClassNames)}>
			<MySelect value={activeItemName} open={open} setOpen={doSetOpen}>
				<MySelectTrigger>
					<MyButton
						ref={triggerButtonRef}
						variant="ghost"
						{...(setDecorationHighlightOnOpen
							? ({ "data-app-set-decoration-highlight": "" } satisfies Partial<PageEditorRichText_CustomAttributes>)
							: {})}
					>
						{activeItemName || "Select format"}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover
					className={cn(
						"PageEditorRichTextToolsNodeSelector-popover" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
					)}
					unmountOnHide
				>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>{transformItems.map(renderItem)}</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
});

export const PageEditorRichTextToolsNodeSelector = memo(function PageEditorRichTextToolsNodeSelector(
	props: PageEditorRichTextToolsNodeSelector_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor, setDecorationHighlightOnOpen = false } = props;

	// Subscribe to the derived active node label so block transforms rerender immediately.
	const activeItemName = useEditorState({
		editor,
		selector: ({ editor }: { editor: Editor }) => {
			return transformItems.filter((item) => item.isActive(editor)).pop()?.name ?? "Multiple";
		},
	});

	return (
		<PageEditorRichTextToolsNodeSelectorInner
			editor={editor}
			activeItemName={activeItemName}
			setDecorationHighlightOnOpen={setDecorationHighlightOnOpen}
		/>
	);
});
// #endregion root
