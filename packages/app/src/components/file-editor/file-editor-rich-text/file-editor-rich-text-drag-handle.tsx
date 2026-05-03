import "./file-editor-rich-text-drag-handle.css";
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
	TextIcon,
	TextQuote,
	Trash2,
	GripVertical,
	Palette,
	ArrowRightLeft,
	Check,
	Copy,
	CopyPlus,
	type LucideIcon,
} from "lucide-react";
import { memo, useState, useRef, type ComponentProps, useDeferredValue } from "react";
import { Editor, useEditorState } from "@tiptap/react";
import { EditorDragHandle, type EditorDragHandleProps } from "novel";
import { offset } from "@floating-ui/dom";
import {
	MyMenu,
	MyMenuTrigger,
	MyMenuPopover,
	MyMenuPopoverScrollableArea,
	MyMenuPopoverContent,
	MyMenuItem,
	MyMenuItemsGroup,
	MyMenuItemsGroupText,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuItemSubMenuIndicator,
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import { MyButtonIcon, type MyButton_ClassNames, type MyButtonIcon_ClassNames } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type {
	FileEditorRichText_FgColorCssVarKeys,
	FileEditorRichText_BgColorCssVarKeys,
} from "./file-editor-rich-text.tsx";
import type { MyIconButton_ClassNames } from "../../my-icon-button.tsx";

type TipTapNode = NonNullable<NonNullable<Parameters<NonNullable<EditorDragHandleProps["onNodeChange"]>>>[0]["node"]>;

const TEXT_COLORS = [
	{
		name: "Default",
		color: `var(${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Purple",
		color: `var(${"--FileEditorRichText-text-color-fg-purple" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Red",
		color: `var(${"--FileEditorRichText-text-color-fg-red" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Yellow",
		color: `var(${"--FileEditorRichText-text-color-fg-yellow" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Blue",
		color: `var(${"--FileEditorRichText-text-color-fg-blue" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Green",
		color: `var(${"--FileEditorRichText-text-color-fg-green" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Orange",
		color: `var(${"--FileEditorRichText-text-color-fg-orange" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Pink",
		color: `var(${"--FileEditorRichText-text-color-fg-pink" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Gray",
		color: `var(${"--FileEditorRichText-text-color-fg-gray" satisfies FileEditorRichText_FgColorCssVarKeys})`,
	},
] as const;

const HIGHLIGHT_COLORS = [
	{
		name: "Default",
		color: `var(${"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Purple",
		color: `var(${"--FileEditorRichText-text-color-bg-purple" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Red",
		color: `var(${"--FileEditorRichText-text-color-bg-red" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Yellow",
		color: `var(${"--FileEditorRichText-text-color-bg-yellow" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Blue",
		color: `var(${"--FileEditorRichText-text-color-bg-blue" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Green",
		color: `var(${"--FileEditorRichText-text-color-bg-green" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Orange",
		color: `var(${"--FileEditorRichText-text-color-bg-orange" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Pink",
		color: `var(${"--FileEditorRichText-text-color-bg-pink" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Gray",
		color: `var(${"--FileEditorRichText-text-color-bg-gray" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	},
] as const;

type FgColorCssValue = `var(${FileEditorRichText_FgColorCssVarKeys})`;
type BgColorCssValue = `var(${FileEditorRichText_BgColorCssVarKeys})`;
type TextColorItem = (typeof TEXT_COLORS)[number];
type HighlightColorItem = (typeof HIGHLIGHT_COLORS)[number];

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
		command: (editor) => editor.chain().focus().clearNodes().run(),
		isActive: (editor) =>
			(editor.isActive("paragraph") && !editor.isActive("bulletList") && !editor.isActive("orderedList")) ?? false,
	},
	{
		name: "Heading 1",
		Icon: Heading1,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 1 }) ?? false,
	},
	{
		name: "Heading 2",
		Icon: Heading2,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 2 }) ?? false,
	},
	{
		name: "Heading 3",
		Icon: Heading3,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 3 }) ?? false,
	},
	{
		name: "Heading 4",
		Icon: Heading4,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 4 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 4 }) ?? false,
	},
	{
		name: "Heading 5",
		Icon: Heading5,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 5 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 5 }) ?? false,
	},
	{
		name: "Heading 6",
		Icon: Heading6,
		command: (editor) => editor.chain().focus().clearNodes().toggleHeading({ level: 6 }).run(),
		isActive: (editor) => editor.isActive("heading", { level: 6 }) ?? false,
	},
	{
		name: "To-do List",
		Icon: CheckSquare,
		command: (editor) => editor.chain().focus().clearNodes().toggleTaskList().run(),
		isActive: (editor) => editor.isActive("taskItem") ?? false,
	},
	{
		name: "Bullet List",
		Icon: ListOrdered,
		command: (editor) => editor.chain().focus().clearNodes().toggleBulletList().run(),
		isActive: (editor) => editor.isActive("bulletList") ?? false,
	},
	{
		name: "Numbered List",
		Icon: ListOrdered,
		command: (editor) => editor.chain().focus().clearNodes().toggleOrderedList().run(),
		isActive: (editor) => editor.isActive("orderedList") ?? false,
	},
	{
		name: "Quote",
		Icon: TextQuote,
		command: (editor) => editor.chain().focus().clearNodes().toggleBlockquote().run(),
		isActive: (editor) => editor.isActive("blockquote") ?? false,
	},
	{
		name: "Code",
		Icon: Code,
		command: (editor) => editor.chain().focus().clearNodes().toggleCodeBlock().run(),
		isActive: (editor) => editor.isActive("codeBlock") ?? false,
	},
];

// #region color preview
type FileEditorRichTextDragHandleColorPreview_ClassNames = "FileEditorRichTextDragHandleColorPreview";

type FileEditorRichTextDragHandleColorPreview_CssVars = {
	"--FileEditorRichTextDragHandleColorPreview-fg": string;
	"--FileEditorRichTextDragHandleColorPreview-bg": string;
};

const FileEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS: Partial<FileEditorRichTextDragHandleColorPreview_CssVars> =
	{
		"--FileEditorRichTextDragHandleColorPreview-fg": `var(${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys})`,
		"--FileEditorRichTextDragHandleColorPreview-bg": `var(${"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys})`,
	} as const;

type FileEditorRichTextDragHandleColorPreview_Props = {
	className?: string;
	style?: React.CSSProperties & Partial<FileEditorRichTextDragHandleColorPreview_CssVars>;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

const FileEditorRichTextDragHandleColorPreview = memo(function FileEditorRichTextDragHandleColorPreview(
	props: FileEditorRichTextDragHandleColorPreview_Props,
) {
	const { className, style, activeColor, activeBackground } = props;

	return (
		<span
			className={cn(
				"FileEditorRichTextDragHandleColorPreview" satisfies FileEditorRichTextDragHandleColorPreview_ClassNames,
				className,
			)}
			style={{
				...({
					...FileEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS,
					"--FileEditorRichTextDragHandleColorPreview-fg":
						activeColor ??
						FileEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS["--FileEditorRichTextDragHandleColorPreview-fg"],
					"--FileEditorRichTextDragHandleColorPreview-bg":
						activeBackground ??
						FileEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS["--FileEditorRichTextDragHandleColorPreview-bg"],
				} satisfies Partial<FileEditorRichTextDragHandleColorPreview_CssVars>),
				...style,
			}}
		>
			A
		</span>
	);
});
// #endregion color preview

// #region color submenu item
type FileEditorRichTextDragHandleColorSubMenuTextItem_ClassNames = "FileEditorRichTextDragHandleColorSubMenuTextItem";

type FileEditorRichTextDragHandleColorSubMenuTextItem_Props = {
	item: TextColorItem;
	isSelected: boolean;
	onSelect: (item: TextColorItem) => void;
};

const FileEditorRichTextDragHandleColorSubMenuTextItem = memo(function FileEditorRichTextDragHandleColorSubMenuTextItem(
	props: FileEditorRichTextDragHandleColorSubMenuTextItem_Props,
) {
	const { item, isSelected, onSelect } = props;

	const handleClick = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
		onSelect(item);
	});

	return (
		<MyMenuItem
			className={cn(
				"FileEditorRichTextDragHandleColorSubMenuTextItem" satisfies FileEditorRichTextDragHandleColorSubMenuTextItem_ClassNames,
			)}
			hideOnClick={false}
			onClick={handleClick}
		>
			<MyMenuItemContent>
				<MyMenuItemContentIcon>
					<FileEditorRichTextDragHandleColorPreview activeColor={item.color} />
				</MyMenuItemContentIcon>
				<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
			</MyMenuItemContent>
			{isSelected && <Check className="FileEditorRichTextDragHandleMenuPopover-check" />}
		</MyMenuItem>
	);
});

type FileEditorRichTextDragHandleColorSubMenuHighlightItem_ClassNames =
	"FileEditorRichTextDragHandleColorSubMenuHighlightItem";

type FileEditorRichTextDragHandleColorSubMenuHighlightItem_Props = {
	item: HighlightColorItem;
	isSelected: boolean;
	onSelect: (item: HighlightColorItem) => void;
};

const FileEditorRichTextDragHandleColorSubMenuHighlightItem = memo(
	function FileEditorRichTextDragHandleColorSubMenuHighlightItem(
		props: FileEditorRichTextDragHandleColorSubMenuHighlightItem_Props,
	) {
		const { item, isSelected, onSelect } = props;

		const handleClick = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
			onSelect(item);
		});

		return (
			<MyMenuItem
				className={cn(
					"FileEditorRichTextDragHandleColorSubMenuHighlightItem" satisfies FileEditorRichTextDragHandleColorSubMenuHighlightItem_ClassNames,
				)}
				hideOnClick={false}
				onClick={handleClick}
			>
				<MyMenuItemContent>
					<MyMenuItemContentIcon>
						<FileEditorRichTextDragHandleColorPreview activeBackground={item.color} />
					</MyMenuItemContentIcon>
					<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
				</MyMenuItemContent>
				{isSelected && <Check className="FileEditorRichTextDragHandleMenuPopover-check" />}
			</MyMenuItem>
		);
	},
);
// #endregion color submenu item

// #region color submenu
type FileEditorRichTextDragHandleColorSubMenu_ClassNames =
	| "FileEditorRichTextDragHandleColorSubMenu"
	| "FileEditorRichTextDragHandleColorSubMenu-trigger"
	| "FileEditorRichTextDragHandleColorSubMenu-popover";

type FileEditorRichTextDragHandleColorSubMenu_Props = {
	editor: Editor;
};

type FileEditorRichTextDragHandleColorSubMenuInner_Props = FileEditorRichTextDragHandleColorSubMenu_Props & {
	activeColor: TextColorItem | undefined;
	activeBackground: HighlightColorItem | undefined;
};

const FileEditorRichTextDragHandleColorSubMenuInner = memo(function FileEditorRichTextDragHandleColorSubMenuInner(
	props: FileEditorRichTextDragHandleColorSubMenuInner_Props,
) {
	const { editor, activeColor, activeBackground } = props;

	const handleColorSelect = useFn((item: TextColorItem) => {
		const chain = editor.chain().unsetColor();

		if (
			item.color !==
			`var(${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys})`
		) {
			chain.setColor(item.color);
		}

		chain.run();
	});

	const handleHighlightSelect = useFn((item: HighlightColorItem) => {
		const chain = editor.chain().unsetHighlight();

		if (
			item.color !==
			`var(${"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys})`
		) {
			chain.setHighlight({ color: item.color });
		}

		chain.run();
	});

	const renderTextColorItem = useFn((item: TextColorItem) => {
		const isSelected =
			item === activeColor ||
			(item.color ===
				`var(${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys})` &&
				!activeColor);

		return (
			<FileEditorRichTextDragHandleColorSubMenuTextItem
				key={item.name}
				item={item}
				isSelected={isSelected}
				onSelect={handleColorSelect}
			/>
		);
	});

	const renderHighlightColorItem = useFn((item: HighlightColorItem) => {
		const isSelected =
			item === activeBackground ||
			(item.color ===
				`var(${"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys})` &&
				!activeBackground);

		return (
			<FileEditorRichTextDragHandleColorSubMenuHighlightItem
				key={item.name}
				item={item}
				isSelected={isSelected}
				onSelect={handleHighlightSelect}
			/>
		);
	});

	return (
		<MyMenu>
			<MyMenuTrigger
				className={cn(
					"FileEditorRichTextDragHandleColorSubMenu-trigger" satisfies FileEditorRichTextDragHandleColorSubMenu_ClassNames,
					"MyMenuItem",
				)}
			>
				<MyMenuItem>
					<MyMenuItemContent>
						<MyMenuItemContentIcon>
							<Palette />
						</MyMenuItemContentIcon>
						<MyMenuItemContentPrimary>Color</MyMenuItemContentPrimary>
					</MyMenuItemContent>
					<MyMenuItemSubMenuIndicator />
				</MyMenuItem>
			</MyMenuTrigger>
			<MyMenuPopover
				className={cn(
					"FileEditorRichTextDragHandleColorSubMenu-popover" satisfies FileEditorRichTextDragHandleColorSubMenu_ClassNames,
				)}
				gutter={8}
				shift={-5}
				hideOnHoverOutside={false}
				portalElement={editor.view.dom.parentElement}
			>
				<MyMenuPopoverScrollableArea>
					<MyMenuPopoverContent>
						<MyMenuItemsGroupText>Color</MyMenuItemsGroupText>
						{TEXT_COLORS.map(renderTextColorItem)}

						<MyMenuItemsGroupText>Background</MyMenuItemsGroupText>
						{HIGHLIGHT_COLORS.map(renderHighlightColorItem)}
					</MyMenuPopoverContent>
				</MyMenuPopoverScrollableArea>
			</MyMenuPopover>
		</MyMenu>
	);
});

const FileEditorRichTextDragHandleColorSubMenu = memo(function FileEditorRichTextDragHandleColorSubMenu(
	props: FileEditorRichTextDragHandleColorSubMenu_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to the derived color state so mark changes rerender immediately.
	const editorState = useEditorState({
		editor,
		selector: ({ editor }: { editor: Editor }) => {
			return {
				activeColor:
					TEXT_COLORS.find((item) => editor.isActive("textStyle", { color: item.color }))?.color ?? null,
				activeBackground:
					HIGHLIGHT_COLORS.find((item) => editor.isActive("highlight", { color: item.color }))?.color ?? null,
			};
		},
	});

	const activeColor = TEXT_COLORS.find((item) => item.color === editorState.activeColor);
	const activeBackground = HIGHLIGHT_COLORS.find((item) => item.color === editorState.activeBackground);

	return (
		<FileEditorRichTextDragHandleColorSubMenuInner
			editor={editor}
			activeColor={activeColor}
			activeBackground={activeBackground}
		/>
	);
});
// #endregion color submenu

// #region turn into submenu item
type FileEditorRichTextDragHandleTurnIntoItem_ClassNames =
	| "FileEditorRichTextDragHandleTurnIntoItem"
	| "FileEditorRichTextDragHandleTurnIntoItem-icon";

type FileEditorRichTextDragHandleTurnIntoItem_Props = {
	item: TransformItem;
	isActive: boolean;
	onSelect: (item: TransformItem) => void;
};

const FileEditorRichTextDragHandleTurnIntoItem = memo(function FileEditorRichTextDragHandleTurnIntoItem(
	props: FileEditorRichTextDragHandleTurnIntoItem_Props,
) {
	const { item, isActive, onSelect } = props;

	const handleClick = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
		onSelect(item);
	});

	return (
		<MyMenuItem
			className={cn(
				"FileEditorRichTextDragHandleTurnIntoItem" satisfies FileEditorRichTextDragHandleTurnIntoItem_ClassNames,
			)}
			hideOnClick={false}
			onClick={handleClick}
		>
			<MyMenuItemContent>
				<MyMenuItemContentIcon
					className={cn(
						"FileEditorRichTextDragHandleTurnIntoItem-icon" satisfies FileEditorRichTextDragHandleTurnIntoItem_ClassNames,
					)}
				>
					<item.Icon />
				</MyMenuItemContentIcon>
				<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
			</MyMenuItemContent>
			{isActive && <Check className="FileEditorRichTextDragHandleMenuPopover-check" />}
		</MyMenuItem>
	);
});
// #endregion turn into submenu item

// #region turn into submenu
type FileEditorRichTextDragHandleTurnIntoSubMenu_ClassNames =
	| "FileEditorRichTextDragHandleTurnIntoSubMenu"
	| "FileEditorRichTextDragHandleTurnIntoSubMenu-trigger"
	| "FileEditorRichTextDragHandleTurnIntoSubMenu-popover";

type FileEditorRichTextDragHandleTurnIntoSubMenu_Props = {
	editor: Editor;
};

const FileEditorRichTextDragHandleTurnIntoSubMenu = memo(function FileEditorRichTextDragHandleTurnIntoSubMenu(
	props: FileEditorRichTextDragHandleTurnIntoSubMenu_Props,
) {
	const { editor } = props;

	const handleTransform = useFn((item: TransformItem) => {
		item.command(editor);
	});

	const renderTransformItem = useFn((item: TransformItem) => {
		const isActive = item.isActive(editor);

		return (
			<FileEditorRichTextDragHandleTurnIntoItem
				key={item.name}
				item={item}
				isActive={isActive}
				onSelect={handleTransform}
			/>
		);
	});

	return (
		<MyMenu>
			<MyMenuTrigger
				className={cn(
					"FileEditorRichTextDragHandleTurnIntoSubMenu-trigger" satisfies FileEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
					"MyMenuItem",
				)}
			>
				<MyMenuItem>
					<MyMenuItemContent>
						<MyMenuItemContentIcon>
							<ArrowRightLeft />
						</MyMenuItemContentIcon>
						<MyMenuItemContentPrimary>Turn into</MyMenuItemContentPrimary>
					</MyMenuItemContent>
					<MyMenuItemSubMenuIndicator />
				</MyMenuItem>
			</MyMenuTrigger>
			<MyMenuPopover
				className={cn(
					"FileEditorRichTextDragHandleTurnIntoSubMenu-popover" satisfies FileEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
				)}
				gutter={8}
				shift={-5}
				hideOnHoverOutside={false}
				portalElement={editor.view.dom.parentElement}
			>
				<MyMenuPopoverScrollableArea>
					<MyMenuPopoverContent>{transformItems.map(renderTransformItem)}</MyMenuPopoverContent>
				</MyMenuPopoverScrollableArea>
			</MyMenuPopover>
		</MyMenu>
	);
});
// #endregion turn into submenu

// #region menu popover
type FileEditorRichTextDragHandleMenuPopover_ClassNames =
	| "FileEditorRichTextDragHandleMenuPopover"
	| "FileEditorRichTextDragHandleMenuPopover-content"
	| "FileEditorRichTextDragHandleMenuPopover-check";

type FileEditorRichTextDragHandleMenuPopover_Props = {
	editor: Editor;
	currentNode: TipTapNode | null;
	currentNodePos: number | null;
};

const FileEditorRichTextDragHandleMenuPopover = memo(function FileEditorRichTextDragHandleMenuPopover(
	props: FileEditorRichTextDragHandleMenuPopover_Props,
) {
	const { editor, currentNode, currentNodePos } = props;

	const handleDuplicate = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
		if (!currentNode || currentNodePos === null) return;

		const { state } = editor;
		const start = currentNodePos;
		const end = currentNodePos + currentNode.nodeSize;

		const nodeSlice = state.doc.slice(start, end);
		const nodeJSON = nodeSlice.content.toJSON();

		// Insert the duplicated content right after the current node
		editor.chain().focus().insertContentAt(end, nodeJSON).run();
	});

	const handleCopyToClipboard = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(async () => {
		if (!currentNode || currentNodePos === null) return;

		const { state, view } = editor;
		const start = currentNodePos;
		const end = currentNodePos + currentNode.nodeSize;

		const nodeSlice = state.doc.slice(start, end);
		const { dom, text } = view.serializeForClipboard(nodeSlice);

		navigator.clipboard
			.write([
				new ClipboardItem({
					"text/html": new Blob([dom.innerHTML], { type: "text/html" }),
					"text/plain": new Blob([text], { type: "text/plain" }),
				}),
			])
			.catch((error) => {
				console.error("[FileEditorRichTextDragHandle.handleCopy] Error copying node to clipboard", { error });
			});
	});

	const handleDelete = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
		if (!currentNode || currentNodePos === null) return;

		const start = currentNodePos;
		const end = currentNodePos + currentNode.nodeSize;

		editor.chain().focus().deleteRange({ from: start, to: end }).run();
	});

	return (
		<MyMenuPopover
			className={cn(
				"FileEditorRichTextDragHandleMenuPopover" satisfies FileEditorRichTextDragHandleMenuPopover_ClassNames,
			)}
			portalElement={editor.view.dom.parentElement}
			unmountOnHide
		>
			<MyMenuPopoverScrollableArea>
				<MyMenuPopoverContent
					className={
						"FileEditorRichTextDragHandleMenuPopover-content" satisfies FileEditorRichTextDragHandleMenuPopover_ClassNames
					}
				>
					<MyMenuItemsGroup>
						<FileEditorRichTextDragHandleColorSubMenu editor={editor} />
						<FileEditorRichTextDragHandleTurnIntoSubMenu editor={editor} />
					</MyMenuItemsGroup>
					<MyMenuItemsGroup separator>
						<MyMenuItem onClick={handleDuplicate}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<CopyPlus />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Duplicate node</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
						<MyMenuItem onClick={handleCopyToClipboard}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Copy />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Copy to clipboard</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
					<MyMenuItemsGroup separator>
						<MyMenuItem variant="destructive" onClick={handleDelete}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Trash2 />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Delete block</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
				</MyMenuPopoverContent>
			</MyMenuPopoverScrollableArea>
		</MyMenuPopover>
	);
});
// #endregion menu popover

// #region menu
type FileEditorRichTextDragHandleMenu_ClassNames = "FileEditorRichTextDragHandleMenu-button";

type FileEditorRichTextDragHandleMenu_Props = {
	editor: Editor;
	currentNode: TipTapNode | null;
	currentNodePos: number | null;
	onMenuOpenChange: (isOpen: boolean) => void;
	onPointerDown: ComponentProps<"button">["onPointerDown"];
	onPointerUp: ComponentProps<"button">["onPointerUp"];
};

const FileEditorRichTextDragHandleMenu = memo(function FileEditorRichTextDragHandleMenu(
	props: FileEditorRichTextDragHandleMenu_Props,
) {
	const { editor, currentNode, currentNodePos, onMenuOpenChange, onPointerDown, onPointerUp } = props;

	return (
		<MyMenu placement="right-start" setOpen={onMenuOpenChange}>
			<MyMenuTrigger>
				<button
					className={cn(
						"FileEditorRichTextDragHandleMenu-button" satisfies FileEditorRichTextDragHandleMenu_ClassNames,
						"MyButton" satisfies MyButton_ClassNames,
						"MyIconButton" satisfies MyIconButton_ClassNames,
						"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
					)}
					type="button"
					aria-label="Block menu"
					onPointerDown={onPointerDown}
					onPointerUp={onPointerUp}
				>
					<MyButtonIcon className={cn("MyButtonIcon" satisfies MyButtonIcon_ClassNames)}>
						<GripVertical />
					</MyButtonIcon>
				</button>
			</MyMenuTrigger>
			<FileEditorRichTextDragHandleMenuPopover
				editor={editor}
				currentNode={currentNode}
				currentNodePos={currentNodePos}
			/>
		</MyMenu>
	);
});
// #endregion menu

// #region root
export type FileEditorRichTextDragHandle_ClassNames = "FileEditorRichTextDragHandle";

export type FileEditorRichTextDragHandle_Props = {
	editor: Editor;
};

export const FileEditorRichTextDragHandle = memo(function FileEditorRichTextDragHandle(
	props: FileEditorRichTextDragHandle_Props,
) {
	const { editor } = props;

	const [currentNode, setCurrentNode] = useState<TipTapNode | null>(null);
	const currentNodeDeferred = useDeferredValue(currentNode);
	const [currentNodePos, setCurrentNodePos] = useState<number | null>(null);
	const currentNodePosDeferred = useDeferredValue(currentNodePos);
	const currentNodeRef = useRef<TipTapNode>(null);

	const isOpenRef = useRef(false);

	const [computePositionConfig] = useState(() => ({
		middleware: [
			offset((state) => {
				// Trick the compiler to prevent it from yelling when accessing the ref value.
				// This seems to be a bug of the compiler?
				const currentNode = ((r) => r().current)(() => currentNodeRef);
				const nodeType = currentNode?.type.name;

				if (nodeType === "heading") {
					const referenceHeight = state.rects.reference.height;
					// Center vertically by offsetting by half the reference height
					return {
						mainAxis: 8,
						crossAxis: referenceHeight / 2 - 16,
					};
				}

				return { mainAxis: 8, crossAxis: -5 };
			}),
		],
	}));

	const handleNodeChange = useFn<EditorDragHandleProps["onNodeChange"]>(({ node, pos }) => {
		// Saving in a ref because the underneath floating-ui stuff needs to access the last value immidiately
		// otherwise the position will be calculated wrong for a brief moment
		currentNodeRef.current = node;
		setCurrentNode(node);
		setCurrentNodePos(pos ?? null);
	});

	const handleMenuOpenChange = useFn((isOpen: boolean) => {
		isOpenRef.current = isOpen;

		if (isOpen) {
			editor.commands.lockDragHandle();
		} else {
			editor.commands.unlockDragHandle();
		}
	});

	const handlePointerDown = useFn<ComponentProps<"button">["onPointerDown"]>((event) => {
		if (isOpenRef.current || currentNodePos == null) return;

		// Select the node when menu opens for focus effect and to prepare the target
		// for applying changes to the editor content
		editor.commands.setNodeSelection(currentNodePos);

		event.currentTarget.setPointerCapture(event.pointerId);
	});

	const handlePointerUp = useFn<ComponentProps<"button">["onPointerUp"]>((event) => {
		event.currentTarget.releasePointerCapture(event.pointerId);
	});

	return (
		<EditorDragHandle
			editor={editor}
			className={cn(
				"FileEditorRichTextDragHandle" satisfies FileEditorRichTextDragHandle_ClassNames,
				"MyButton" satisfies MyButton_ClassNames,
				"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
			)}
			onNodeChange={handleNodeChange}
			computePositionConfig={computePositionConfig}
		>
			<FileEditorRichTextDragHandleMenu
				editor={editor}
				currentNode={currentNodeDeferred}
				currentNodePos={currentNodePosDeferred}
				onMenuOpenChange={handleMenuOpenChange}
				onPointerDown={handlePointerDown}
				onPointerUp={handlePointerUp}
			/>
		</EditorDragHandle>
	);
});
// #endregion root
