import "./page-editor-rich-text-tools-color-selector.css";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
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
import { cn, sx } from "@/lib/utils.ts";
import { useForceRender } from "@/hooks/utils-hooks.ts";

// Color variable types for type safety
export type PageEditorRichTextTextColorFgVars = {
	"--PageEditorRichText-text-color-fg-default": string;
	"--PageEditorRichText-text-color-fg-purple": string;
	"--PageEditorRichText-text-color-fg-red": string;
	"--PageEditorRichText-text-color-fg-yellow": string;
	"--PageEditorRichText-text-color-fg-blue": string;
	"--PageEditorRichText-text-color-fg-green": string;
	"--PageEditorRichText-text-color-fg-orange": string;
	"--PageEditorRichText-text-color-fg-pink": string;
	"--PageEditorRichText-text-color-fg-gray": string;
};

export type PageEditorRichTextTextColorBgVars = {
	"--PageEditorRichText-text-color-bg-default": string;
	"--PageEditorRichText-text-color-bg-purple": string;
	"--PageEditorRichText-text-color-bg-red": string;
	"--PageEditorRichText-text-color-bg-yellow": string;
	"--PageEditorRichText-text-color-bg-blue": string;
	"--PageEditorRichText-text-color-bg-green": string;
	"--PageEditorRichText-text-color-bg-orange": string;
	"--PageEditorRichText-text-color-bg-pink": string;
	"--PageEditorRichText-text-color-bg-gray": string;
};

type FgColor = keyof PageEditorRichTextTextColorFgVars;
type BgColor = keyof PageEditorRichTextTextColorBgVars;

export interface BubbleColorMenuItem {
	name: string;
	color: string;
}

const TEXT_COLORS = [
	{
		name: "Default",
		color: `var(${"--PageEditorRichText-text-color-fg-default" satisfies FgColor})`,
	},
	{
		name: "Purple",
		color: `var(${"--PageEditorRichText-text-color-fg-purple" satisfies FgColor})`,
	},
	{
		name: "Red",
		color: `var(${"--PageEditorRichText-text-color-fg-red" satisfies FgColor})`,
	},
	{
		name: "Yellow",
		color: `var(${"--PageEditorRichText-text-color-fg-yellow" satisfies FgColor})`,
	},
	{
		name: "Blue",
		color: `var(${"--PageEditorRichText-text-color-fg-blue" satisfies FgColor})`,
	},
	{
		name: "Green",
		color: `var(${"--PageEditorRichText-text-color-fg-green" satisfies FgColor})`,
	},
	{
		name: "Orange",
		color: `var(${"--PageEditorRichText-text-color-fg-orange" satisfies FgColor})`,
	},
	{
		name: "Pink",
		color: `var(${"--PageEditorRichText-text-color-fg-pink" satisfies FgColor})`,
	},
	{
		name: "Gray",
		color: `var(${"--PageEditorRichText-text-color-fg-gray" satisfies FgColor})`,
	},
] as const;

const HIGHLIGHT_COLORS = [
	{
		name: "Default",
		color: `var(${"--PageEditorRichText-text-color-bg-default" satisfies BgColor})`,
	},
	{
		name: "Purple",
		color: `var(${"--PageEditorRichText-text-color-bg-purple" satisfies BgColor})`,
	},
	{
		name: "Red",
		color: `var(${"--PageEditorRichText-text-color-bg-red" satisfies BgColor})`,
	},
	{
		name: "Yellow",
		color: `var(${"--PageEditorRichText-text-color-bg-yellow" satisfies BgColor})`,
	},
	{
		name: "Blue",
		color: `var(${"--PageEditorRichText-text-color-bg-blue" satisfies BgColor})`,
	},
	{
		name: "Green",
		color: `var(${"--PageEditorRichText-text-color-bg-green" satisfies BgColor})`,
	},
	{
		name: "Orange",
		color: `var(${"--PageEditorRichText-text-color-bg-orange" satisfies BgColor})`,
	},
	{
		name: "Pink",
		color: `var(${"--PageEditorRichText-text-color-bg-pink" satisfies BgColor})`,
	},
	{
		name: "Gray",
		color: `var(${"--PageEditorRichText-text-color-bg-gray" satisfies BgColor})`,
	},
] as const;

type FgColorCssValue = `var(${FgColor})`;
type BgColorCssValue = `var(${BgColor})`;

type SelectedValue = FgColorCssValue | BgColorCssValue;

function make_selected_values(args: { color?: FgColorCssValue; background?: BgColorCssValue }) {
	const values: SelectedValue[] = [];
	if (args.color) {
		values.push(args.color);
	}
	if (args.background) {
		values.push(args.background);
	}
	return values;
}

type PageEditorRichTextToolsColorSelectorPreview_ClassNames = "PageEditorRichTextToolsColorSelectorPreview";

type PageEditorRichTextToolsColorSelectorPreview_CssVars = {
	"--PageEditorRichTextToolsColorSelector-selected-fg": string;
	"--PageEditorRichTextToolsColorSelector-selected-bg": string;
};

const PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS: Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars> =
	{
		"--PageEditorRichTextToolsColorSelector-selected-fg":
			"--PageEditorRichText-text-color-fg-default" satisfies FgColor,
		"--PageEditorRichTextToolsColorSelector-selected-bg":
			"--PageEditorRichText-text-color-bg-default" satisfies BgColor,
	} as const;

export type PageEditorRichTextToolsColorSelectorPreview_Props = {
	className?: string;
	style?: React.CSSProperties & Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

export function PageEditorRichTextToolsColorSelectorPreview(props: PageEditorRichTextToolsColorSelectorPreview_Props) {
	const { className, style, activeColor, activeBackground } = props;

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
						activeColor ??
						PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS[
							"--PageEditorRichTextToolsColorSelector-selected-fg"
						],
					"--PageEditorRichTextToolsColorSelector-selected-bg":
						activeBackground ??
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

export type PageEditorRichTextToolsColorSelector_Props = {};

export function PageEditorRichTextToolsColorSelector(props: PageEditorRichTextToolsColorSelector_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const [open, setOpen] = useState(false);

	const { editor } = useEditor();
	const forceRender = useForceRender();

	const activeColor = editor ? TEXT_COLORS.find(({ color }) => editor.isActive("textStyle", { color })) : undefined;
	const activeBackground = editor
		? HIGHLIGHT_COLORS.find(({ color }) => editor.isActive("highlight", { color }))
		: undefined;

	const handleColorSelect = (item: (typeof TEXT_COLORS)[number]) => {
		if (!editor) return;

		editor.commands.command(({ commands }) => {
			commands.unsetColor();
			if (item.color !== `var(${"--PageEditorRichText-text-color-fg-default" satisfies FgColor})`) {
				commands.setColor(item.color);
			}
			return true;
		});

		forceRender();
	};

	const handleHighlightSelect = (item: (typeof HIGHLIGHT_COLORS)[number]) => {
		if (!editor) return;

		editor.commands.command(({ commands }) => {
			commands.unsetHighlight();
			if (item.color !== `var${"--PageEditorRichText-text-color-bg-default" satisfies BgColor}`) {
				commands.setHighlight({ color: item.color });
			}
			return true;
		});

		forceRender();
	};

	if (!editor) return null;
	return (
		<div
			className={cn("PageEditorRichTextToolsColorSelector" satisfies PageEditorRichTextToolsColorSelector_ClassNames)}
			style={sx({
				...PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS,
				...({
					"--PageEditorRichTextToolsColorSelector-selected-fg": activeColor?.color,
					"--PageEditorRichTextToolsColorSelector-selected-bg": activeBackground?.color,
				} satisfies Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars>),
			})}
		>
			<MySelect
				value={make_selected_values({ color: activeColor?.color, background: activeBackground?.color })}
				open={open}
				setOpen={setOpen}
			>
				<MySelectTrigger>
					<MyButton variant="ghost">
						<PageEditorRichTextToolsColorSelectorPreview
							activeColor={activeColor?.color}
							activeBackground={activeBackground?.color}
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
					autoFocusOnShow={false}
					unmountOnHide
				>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							<MySelectItemsGroup>
								<MySelectItemsGroupText>Color</MySelectItemsGroupText>
								{TEXT_COLORS.map((item) => {
									const isSelected =
										item === activeColor ||
										(item.color === `var${"--PageEditorRichText-text-color-fg-default" satisfies FgColor}` &&
											!activeColor);

									return (
										<MySelectItem
											key={item.name}
											className={cn(
												"PageEditorRichTextToolsColorSelector-item" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
											)}
											value={item.color}
											onClick={() => handleColorSelect(item)}
										>
											<MySelectItemContent>
												<MySelectItemContentIcon>
													<PageEditorRichTextToolsColorSelectorPreview activeColor={item.color} />
												</MySelectItemContentIcon>
												<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
											</MySelectItemContent>

											{isSelected && (
												<MySelectItemIndicator>
													<Check
														className={cn(
															"PageEditorRichTextToolsColorSelector-check-icon" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
														)}
													/>
												</MySelectItemIndicator>
											)}
										</MySelectItem>
									);
								})}
							</MySelectItemsGroup>

							<MySelectItemsGroup>
								<MySelectItemsGroupText>Background</MySelectItemsGroupText>
								{HIGHLIGHT_COLORS.map((item) => {
									const isSelected =
										item === activeBackground ||
										(item.color === `var(--PageEditorRichText-text-color-bg-default)` && !activeBackground);

									return (
										<MySelectItem
											key={item.name}
											className={cn(
												"PageEditorRichTextToolsColorSelector-item" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
											)}
											value={item.color}
											onClick={() => handleHighlightSelect(item)}
										>
											<MySelectItemContent>
												<MySelectItemContentIcon>
													<PageEditorRichTextToolsColorSelectorPreview activeBackground={item.color} />
												</MySelectItemContentIcon>
												<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
											</MySelectItemContent>

											{isSelected && (
												<MySelectItemIndicator>
													<Check
														className={cn(
															"PageEditorRichTextToolsColorSelector-check-icon" satisfies PageEditorRichTextToolsColorSelector_ClassNames,
														)}
													/>
												</MySelectItemIndicator>
											)}
										</MySelectItem>
									);
								})}
							</MySelectItemsGroup>
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
}
