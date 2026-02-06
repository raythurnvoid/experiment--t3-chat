import "./page-editor-rich-text-drag-handle.css";
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
import { useState, useRef, type ComponentProps } from "react";
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
} from "@/components/my-menu.tsx";
import { MyButtonIcon, type MyButton_ClassNames, type MyButtonIcon_ClassNames } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";
import type {
	PageEditorRichText_FgColorCssVarKeys,
	PageEditorRichText_BgColorCssVarKeys,
} from "./page-editor-rich-text.tsx";
import type { MyIconButton_ClassNames } from "../../my-icon-button.tsx";

type TipTapNode = NonNullable<NonNullable<Parameters<NonNullable<EditorDragHandleProps["onNodeChange"]>>>[0]["node"]>;

// #region ColorData
const TEXT_COLORS = [
	{
		name: "Default",
		color: `var(${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Purple",
		color: `var(${"--PageEditorRichText-text-color-fg-purple" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Red",
		color: `var(${"--PageEditorRichText-text-color-fg-red" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Yellow",
		color: `var(${"--PageEditorRichText-text-color-fg-yellow" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Blue",
		color: `var(${"--PageEditorRichText-text-color-fg-blue" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Green",
		color: `var(${"--PageEditorRichText-text-color-fg-green" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Orange",
		color: `var(${"--PageEditorRichText-text-color-fg-orange" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Pink",
		color: `var(${"--PageEditorRichText-text-color-fg-pink" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
	{
		name: "Gray",
		color: `var(${"--PageEditorRichText-text-color-fg-gray" satisfies PageEditorRichText_FgColorCssVarKeys})`,
	},
] as const;

const HIGHLIGHT_COLORS = [
	{
		name: "Default",
		color: `var(${"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Purple",
		color: `var(${"--PageEditorRichText-text-color-bg-purple" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Red",
		color: `var(${"--PageEditorRichText-text-color-bg-red" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Yellow",
		color: `var(${"--PageEditorRichText-text-color-bg-yellow" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Blue",
		color: `var(${"--PageEditorRichText-text-color-bg-blue" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Green",
		color: `var(${"--PageEditorRichText-text-color-bg-green" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Orange",
		color: `var(${"--PageEditorRichText-text-color-bg-orange" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Pink",
		color: `var(${"--PageEditorRichText-text-color-bg-pink" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
	{
		name: "Gray",
		color: `var(${"--PageEditorRichText-text-color-bg-gray" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	},
] as const;

type FgColorCssValue = `var(${PageEditorRichText_FgColorCssVarKeys})`;
type BgColorCssValue = `var(${PageEditorRichText_BgColorCssVarKeys})`;
// #endregion ColorData

// #region TransformData
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
// #endregion TransformData

// #region ColorPreview
type PageEditorRichTextDragHandleColorPreview_ClassNames = "PageEditorRichTextDragHandleColorPreview";

type PageEditorRichTextDragHandleColorPreview_CssVars = {
	"--PageEditorRichTextDragHandleColorPreview-fg": string;
	"--PageEditorRichTextDragHandleColorPreview-bg": string;
};

const PageEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS: Partial<PageEditorRichTextDragHandleColorPreview_CssVars> =
	{
		"--PageEditorRichTextDragHandleColorPreview-fg": `var(${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys})`,
		"--PageEditorRichTextDragHandleColorPreview-bg": `var(${"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys})`,
	} as const;

type PageEditorRichTextDragHandleColorPreview_Props = {
	className?: string;
	style?: React.CSSProperties & Partial<PageEditorRichTextDragHandleColorPreview_CssVars>;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

function PageEditorRichTextDragHandleColorPreview(props: PageEditorRichTextDragHandleColorPreview_Props) {
	const { className, style, activeColor, activeBackground } = props;

	return (
		<span
			className={cn(
				"PageEditorRichTextDragHandleColorPreview" satisfies PageEditorRichTextDragHandleColorPreview_ClassNames,
				className,
			)}
			style={{
				...({
					...PageEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS,
					"--PageEditorRichTextDragHandleColorPreview-fg":
						activeColor ??
						PageEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS["--PageEditorRichTextDragHandleColorPreview-fg"],
					"--PageEditorRichTextDragHandleColorPreview-bg":
						activeBackground ??
						PageEditorRichTextDragHandleColorPreview_CssVars_DEFAULTS["--PageEditorRichTextDragHandleColorPreview-bg"],
				} satisfies Partial<PageEditorRichTextDragHandleColorPreview_CssVars>),
				...style,
			}}
		>
			A
		</span>
	);
}
// #endregion ColorPreview

// #region ColorSubMenu
type PageEditorRichTextDragHandleColorSubMenu_ClassNames =
	| "PageEditorRichTextDragHandleColorSubMenu"
	| "PageEditorRichTextDragHandleColorSubMenu-trigger"
	| "PageEditorRichTextDragHandleColorSubMenu-popover"
	| "PageEditorRichTextDragHandleColorSubMenu-item";

type PageEditorRichTextDragHandleColorSubMenu_Props = {
	editor: Editor;
};

function PageEditorRichTextDragHandleColorSubMenu(props: PageEditorRichTextDragHandleColorSubMenu_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				selection: editor.state.selection,
			};
		},
	});

	const activeColor = TEXT_COLORS.find(({ color }) => editor.isActive("textStyle", { color }));
	const activeBackground = HIGHLIGHT_COLORS.find(({ color }) => editor.isActive("highlight", { color }));

	const handleColorSelect = (item: (typeof TEXT_COLORS)[number]) => {
		const chain = editor.chain().unsetColor();

		if (
			item.color !==
			`var(${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys})`
		) {
			chain.setColor(item.color);
		}

		chain.run();
	};

	const handleHighlightSelect = (item: (typeof HIGHLIGHT_COLORS)[number]) => {
		const chain = editor.chain().unsetHighlight();

		if (
			item.color !==
			`var(${"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys})`
		) {
			chain.setHighlight({ color: item.color });
		}

		chain.run();
	};

	return (
		<MyMenu>
			<MyMenuTrigger
				className={cn(
					"PageEditorRichTextDragHandleColorSubMenu-trigger" satisfies PageEditorRichTextDragHandleColorSubMenu_ClassNames,
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
					"PageEditorRichTextDragHandleColorSubMenu-popover" satisfies PageEditorRichTextDragHandleColorSubMenu_ClassNames,
				)}
				gutter={8}
				shift={-5}
				hideOnHoverOutside={false}
				portalElement={editor.view.dom.parentElement}
			>
				<MyMenuPopoverScrollableArea>
					<MyMenuPopoverContent>
						<MyMenuItemsGroupText>Color</MyMenuItemsGroupText>
						{TEXT_COLORS.map((item) => {
							const isSelected =
								item === activeColor ||
								(item.color ===
									`var(${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys})` &&
									!activeColor);

							return (
								<MyMenuItem
									key={item.name}
									className={cn(
										"PageEditorRichTextDragHandleColorSubMenu-item" satisfies PageEditorRichTextDragHandleColorSubMenu_ClassNames,
									)}
									hideOnClick={false}
									onClick={() => handleColorSelect(item)}
								>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<PageEditorRichTextDragHandleColorPreview activeColor={item.color} />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
									</MyMenuItemContent>
									{isSelected && <Check className="PageEditorRichTextDragHandleMenuPopover-check" />}
								</MyMenuItem>
							);
						})}

						<MyMenuItemsGroupText>Background</MyMenuItemsGroupText>
						{HIGHLIGHT_COLORS.map((item) => {
							const isSelected =
								item === activeBackground ||
								(item.color ===
									`var(${"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys})` &&
									!activeBackground);

							return (
								<MyMenuItem
									key={item.name}
									className={cn(
										"PageEditorRichTextDragHandleColorSubMenu-item" satisfies PageEditorRichTextDragHandleColorSubMenu_ClassNames,
									)}
									hideOnClick={false}
									onClick={() => handleHighlightSelect(item)}
								>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<PageEditorRichTextDragHandleColorPreview activeBackground={item.color} />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
									</MyMenuItemContent>
									{isSelected && <Check className="PageEditorRichTextDragHandleMenuPopover-check" />}
								</MyMenuItem>
							);
						})}
					</MyMenuPopoverContent>
				</MyMenuPopoverScrollableArea>
			</MyMenuPopover>
		</MyMenu>
	);
}
// #endregion ColorSubMenu

// #region TurnIntoSubMenu
type PageEditorRichTextDragHandleTurnIntoSubMenu_ClassNames =
	| "PageEditorRichTextDragHandleTurnIntoSubMenu"
	| "PageEditorRichTextDragHandleTurnIntoSubMenu-trigger"
	| "PageEditorRichTextDragHandleTurnIntoSubMenu-popover"
	| "PageEditorRichTextDragHandleTurnIntoSubMenu-item"
	| "PageEditorRichTextDragHandleTurnIntoSubMenu-icon";

type PageEditorRichTextDragHandleTurnIntoSubMenu_Props = {
	editor: Editor;
};

function PageEditorRichTextDragHandleTurnIntoSubMenu(props: PageEditorRichTextDragHandleTurnIntoSubMenu_Props) {
	const { editor } = props;

	const handleTransform = (item: TransformItem) => {
		item.command(editor);
	};

	return (
		<MyMenu>
			<MyMenuTrigger
				className={cn(
					"PageEditorRichTextDragHandleTurnIntoSubMenu-trigger" satisfies PageEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
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
					"PageEditorRichTextDragHandleTurnIntoSubMenu-popover" satisfies PageEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
				)}
				gutter={8}
				shift={-5}
				hideOnHoverOutside={false}
				portalElement={editor.view.dom.parentElement}
			>
				<MyMenuPopoverScrollableArea>
					<MyMenuPopoverContent>
						{transformItems.map((item) => {
							const isActive = item.isActive(editor);

							return (
								<MyMenuItem
									key={item.name}
									className={cn(
										"PageEditorRichTextDragHandleTurnIntoSubMenu-item" satisfies PageEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
									)}
									hideOnClick={false}
									onClick={() => handleTransform(item)}
								>
									<MyMenuItemContent>
										<MyMenuItemContentIcon
											className={cn(
												"PageEditorRichTextDragHandleTurnIntoSubMenu-icon" satisfies PageEditorRichTextDragHandleTurnIntoSubMenu_ClassNames,
											)}
										>
											<item.Icon />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
									</MyMenuItemContent>
									{isActive && <Check className="PageEditorRichTextDragHandleMenuPopover-check" />}
								</MyMenuItem>
							);
						})}
					</MyMenuPopoverContent>
				</MyMenuPopoverScrollableArea>
			</MyMenuPopover>
		</MyMenu>
	);
}
// #endregion TurnIntoSubMenu

// #region MenuPopover
type PageEditorRichTextDragHandleMenuPopover_ClassNames =
	| "PageEditorRichTextDragHandleMenuPopover"
	| "PageEditorRichTextDragHandleMenuPopover-content"
	| "PageEditorRichTextDragHandleMenuPopover-check";

type PageEditorRichTextDragHandleMenuPopover_Props = {
	editor: Editor;
	currentNode: TipTapNode | null;
	currentNodePos: number | null;
};

function PageEditorRichTextDragHandleMenuPopover(props: PageEditorRichTextDragHandleMenuPopover_Props) {
	const { editor, currentNode, currentNodePos } = props;

	const handleDuplicate = () => {
		if (!currentNode || currentNodePos === null) return;

		const { state } = editor;
		const start = currentNodePos;
		const end = currentNodePos + currentNode.nodeSize;

		const nodeSlice = state.doc.slice(start, end);
		const nodeJSON = nodeSlice.content.toJSON();

		// Insert the duplicated content right after the current node
		editor.chain().focus().insertContentAt(end, nodeJSON).run();
	};

	const handleCopyToClipboard = async () => {
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
			.catch(console.error);
	};

	const handleDelete = () => {
		if (!currentNode || currentNodePos === null) return;

		const start = currentNodePos;
		const end = currentNodePos + currentNode.nodeSize;

		editor.chain().focus().deleteRange({ from: start, to: end }).run();
	};

	return (
		<MyMenuPopover
			className={cn(
				"PageEditorRichTextDragHandleMenuPopover" satisfies PageEditorRichTextDragHandleMenuPopover_ClassNames,
			)}
			portalElement={editor.view.dom.parentElement}
		>
			<MyMenuPopoverScrollableArea>
				<MyMenuPopoverContent
					className={
						"PageEditorRichTextDragHandleMenuPopover-content" satisfies PageEditorRichTextDragHandleMenuPopover_ClassNames
					}
				>
					<MyMenuItemsGroup>
						<PageEditorRichTextDragHandleColorSubMenu editor={editor} />
						<PageEditorRichTextDragHandleTurnIntoSubMenu editor={editor} />
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
}
// #endregion MenuPopover

// #region PageEditorRichTextDragHandle
export type PageEditorRichTextDragHandle_ClassNames =
	| "PageEditorRichTextDragHandle"
	| "PageEditorRichTextDragHandle-button";

export type PageEditorRichTextDragHandle_Props = {
	editor: Editor;
};

export function PageEditorRichTextDragHandle(props: PageEditorRichTextDragHandle_Props) {
	const { editor } = props;

	const [currentNode, setCurrentNode] = useState<TipTapNode | null>(null);
	const [currentNodePos, setCurrentNodePos] = useState<number | null>(null);
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

	const handleNodeChange: EditorDragHandleProps["onNodeChange"] = ({ node, pos }) => {
		// Saving in a ref because the underneath floating-ui stuff needs to access the last value immidiately
		// otherwise the position will be calculated wrong for a brief moment
		currentNodeRef.current = node;
		setCurrentNode(node);
		setCurrentNodePos(pos ?? null);
	};

	const handleMenuOpenChange = (isOpen: boolean) => {
		isOpenRef.current = isOpen;

		if (isOpen) {
			editor.commands.lockDragHandle();
		} else {
			editor.commands.unlockDragHandle();
		}
	};

	const handlePointerDown: ComponentProps<"button">["onPointerDown"] = (event) => {
		if (isOpenRef.current || currentNodePos == null) return;

		// Select the node when menu opens for focus effect and to prepare the target
		// for applying changes to the editor content
		editor.commands.setNodeSelection(currentNodePos);

		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handlePointerUp: ComponentProps<"button">["onPointerUp"] = (event) => {
		event.currentTarget.releasePointerCapture(event.pointerId);
	};

	return (
		<EditorDragHandle
			editor={editor}
			className={cn(
				"PageEditorRichTextDragHandle" satisfies PageEditorRichTextDragHandle_ClassNames,
				"MyButton" satisfies MyButton_ClassNames,
				"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
			)}
			onNodeChange={handleNodeChange}
			computePositionConfig={computePositionConfig}
		>
			<MyMenu placement="right-start" setOpen={handleMenuOpenChange}>
				<MyMenuTrigger>
					<button
						className={cn(
							"PageEditorRichTextDragHandle-button" satisfies PageEditorRichTextDragHandle_ClassNames,
							"MyButton" satisfies MyButton_ClassNames,
							"MyIconButton" satisfies MyIconButton_ClassNames,
							"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
						)}
						type="button"
						aria-label="Block menu"
						onPointerDown={handlePointerDown}
						onPointerUp={handlePointerUp}
					>
						<MyButtonIcon className={cn("MyButtonIcon" satisfies MyButtonIcon_ClassNames)}>
							<GripVertical />
						</MyButtonIcon>
					</button>
				</MyMenuTrigger>
				<PageEditorRichTextDragHandleMenuPopover
					editor={editor}
					currentNode={currentNode}
					currentNodePos={currentNodePos}
				/>
			</MyMenu>
		</EditorDragHandle>
	);
}
// #endregion PageEditorRichTextDragHandle
