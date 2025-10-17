import "./page-editor-rich-text-tools-color-selector.css";
import { Check, ChevronDown } from "lucide-react";
import { useEditor } from "novel";
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
	MySelectItemsGroup,
	MySelectItemsGroupText,
} from "@/components/my-select.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

export interface BubbleColorMenuItem {
	name: string;
	color: string;
}

const TEXT_COLORS: BubbleColorMenuItem[] = [
	{
		name: "Default",
		color: "var(--novel-black)",
	},
	{
		name: "Purple",
		color: "#9333EA",
	},
	{
		name: "Red",
		color: "#E00000",
	},
	{
		name: "Yellow",
		color: "#EAB308",
	},
	{
		name: "Blue",
		color: "#2563EB",
	},
	{
		name: "Green",
		color: "#008A00",
	},
	{
		name: "Orange",
		color: "#FFA500",
	},
	{
		name: "Pink",
		color: "#BA4081",
	},
	{
		name: "Gray",
		color: "#A8A29E",
	},
];

const HIGHLIGHT_COLORS: BubbleColorMenuItem[] = [
	{
		name: "Default",
		color: "var(--novel-highlight-default)",
	},
	{
		name: "Purple",
		color: "var(--novel-highlight-purple)",
	},
	{
		name: "Red",
		color: "var(--novel-highlight-red)",
	},
	{
		name: "Yellow",
		color: "var(--novel-highlight-yellow)",
	},
	{
		name: "Blue",
		color: "var(--novel-highlight-blue)",
	},
	{
		name: "Green",
		color: "var(--novel-highlight-green)",
	},
	{
		name: "Orange",
		color: "var(--novel-highlight-orange)",
	},
	{
		name: "Pink",
		color: "var(--novel-highlight-pink)",
	},
	{
		name: "Gray",
		color: "var(--novel-highlight-gray)",
	},
];

type PageEditorRichTextToolsColorSelectorPreview_ClassNames = "PageEditorRichTextToolsColorSelectorPreview";

type PageEditorRichTextToolsColorSelectorPreview_CssVars = {
	"--PageEditorRichTextToolsColorSelector-selected-fg": string;
	"--PageEditorRichTextToolsColorSelector-selected-bg": string;
};

const PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS: Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars> =
	{
		"--PageEditorRichTextToolsColorSelector-selected-fg": "transparent",
		"--PageEditorRichTextToolsColorSelector-selected-bg": "transparent",
	} as const;

export type PageEditorRichTextToolsColorSelectorPreview_Props = {
	className?: string;
	style?: React.CSSProperties & Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>;
	activeColorItem?: BubbleColorMenuItem;
	activeHighlightItem?: BubbleColorMenuItem;
};

export function PageEditorRichTextToolsColorSelectorPreview(props: PageEditorRichTextToolsColorSelectorPreview_Props) {
	const { className, style, activeColorItem, activeHighlightItem } = props;

	return (
		<span
			className={cn(
				"PageEditorRichTextToolsColorSelectorPreview" satisfies PageEditorRichTextToolsColorSelectorPreview_ClassNames,
				className,
			)}
			style={{
				...({
					...PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS,
					"--PageEditorRichTextToolsColorSelector-selected-fg":
						activeColorItem?.color ??
						PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS[
							"--PageEditorRichTextToolsColorSelector-selected-fg"
						],
					"--PageEditorRichTextToolsColorSelector-selected-bg":
						activeHighlightItem?.color ??
						PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS[
							"--PageEditorRichTextToolsColorSelector-selected-bg"
						],
				} satisfies Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>),
				...style,
			}}
		>
			A
		</span>
	);
}

export type PageEditorRichTextToolsColorSelector_ClassNames =
	| "PageEditorRichTextToolsColorSelector"
	| "PageEditorRichTextToolsColorSelector-popover"
	| "PageEditorRichTextToolsColorSelector-item"
	| "PageEditorRichTextToolsColorSelector-check-icon";

export type PageEditorRichTextToolsColorSelector_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	style?: React.CSSProperties & Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>;
};

export function PageEditorRichTextToolsColorSelector(props: PageEditorRichTextToolsColorSelector_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { style, open, onOpenChange } = props;

	const { editor } = useEditor();
	if (!editor) return null;

	const activeColorItem = TEXT_COLORS.find(({ color }) => editor.isActive("textStyle", { color }));
	const activeHighlightItem = HIGHLIGHT_COLORS.find(({ color }) => editor.isActive("highlight", { color }));

	const currentValue = activeColorItem?.name || activeHighlightItem?.name || "Default";

	const handleColorSelect = (item: BubbleColorMenuItem) => {
		editor.commands.unsetColor();
		if (item.name !== "Default") {
			editor
				.chain()
				.focus()
				.setColor(item.color || "")
				.run();
		}
		onOpenChange(false);
	};

	const handleHighlightSelect = (item: BubbleColorMenuItem) => {
		editor.commands.unsetHighlight();
		if (item.name !== "Default") {
			editor.chain().focus().setHighlight({ color: item.color }).run();
		}
		onOpenChange(false);
	};

	return (
		<div
			className={cn("PageEditorRichTextToolsColorSelector" satisfies PageEditorRichTextToolsColorSelector_ClassNames)}
			style={{
				...PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS,
				...({
					"--PageEditorRichTextToolsColorSelector-selected-fg": activeColorItem?.color,
					"--PageEditorRichTextToolsColorSelector-selected-bg": activeHighlightItem?.color,
				} satisfies Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>),
				...style,
			}}
		>
			<MySelect value={currentValue} open={open} setOpen={onOpenChange}>
				<MySelectTrigger>
					<MyButton variant="ghost">
						<PageEditorRichTextToolsColorSelectorPreview
							activeColorItem={activeColorItem}
							activeHighlightItem={activeHighlightItem}
						/>
						<MySelectOpenIndicator>
							<ChevronDown className="h-4 w-4" />
						</MySelectOpenIndicator>
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover
					className={cn(
						"PageEditorRichTextToolsColorSelector-popover" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
					)}
				>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							<MySelectItemsGroup>
								<MySelectItemsGroupText>Color</MySelectItemsGroupText>
								{TEXT_COLORS.map((item) => (
									<MySelectItem
										key={item.name}
										className={cn(
											"PageEditorRichTextToolsColorSelector-item" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
										)}
										value={item.name}
										onClick={() => handleColorSelect(item)}
									>
										<MySelectItemContent>
											<MySelectItemContentIcon>
												<PageEditorRichTextToolsColorSelectorPreview activeColorItem={item} />
											</MySelectItemContentIcon>
											<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
										</MySelectItemContent>

										{editor.isActive("textStyle", { color: item.color }) && (
											<MySelectItemIndicator>
												<Check
													className={cn(
														"PageEditorRichTextToolsColorSelector-check-icon" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
													)}
												/>
											</MySelectItemIndicator>
										)}
									</MySelectItem>
								))}
							</MySelectItemsGroup>

							<MySelectItemsGroup>
								<MySelectItemsGroupText>Background</MySelectItemsGroupText>
								{HIGHLIGHT_COLORS.map((item) => (
									<MySelectItem
										key={item.name}
										className={cn(
											"PageEditorRichTextToolsColorSelector-item" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
										)}
										value={item.name}
										onClick={() => handleHighlightSelect(item)}
									>
										<MySelectItemContent>
											<MySelectItemContentIcon>
												<PageEditorRichTextToolsColorSelectorPreview activeHighlightItem={item} />
											</MySelectItemContentIcon>
											<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
										</MySelectItemContent>

										{editor.isActive("highlight", { color: item.color }) && (
											<MySelectItemIndicator>
												<Check
													className={cn(
														"PageEditorRichTextToolsColorSelector-check-icon" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
													)}
												/>
											</MySelectItemIndicator>
										)}
									</MySelectItem>
								))}
							</MySelectItemsGroup>
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
}
