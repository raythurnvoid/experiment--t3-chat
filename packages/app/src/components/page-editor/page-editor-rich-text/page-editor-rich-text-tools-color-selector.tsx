import "./page-editor-rich-text-tools-color-selector.css";
import { Check, ChevronDown } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
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
import { useFn, useForceRender } from "@/hooks/utils-hooks.ts";
import {
	PageEditorRichText,
	type PageEditorRichText_FgColorCssVarKeys,
	type PageEditorRichText_BgColorCssVarKeys,
	type PageEditorRichText_CustomAttributes,
} from "./page-editor-rich-text.tsx";
import { useEditorState, type Editor } from "@tiptap/react";

export interface BubbleColorMenuItem {
	name: string;
	color: string;
}

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
type TextColorItem = (typeof TEXT_COLORS)[number];
type HighlightColorItem = (typeof HIGHLIGHT_COLORS)[number];

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

// #region preview
type PageEditorRichTextToolsColorSelectorPreview_ClassNames = "PageEditorRichTextToolsColorSelectorPreview";

type PageEditorRichTextToolsColorSelectorPreview_CssVars = {
	"--PageEditorRichTextToolsColorSelector-selected-fg": string;
	"--PageEditorRichTextToolsColorSelector-selected-bg": string;
};

const PageEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS: Partial<PageEditorRichTextToolsColorSelectorPreview_CssVars> =
	{
		"--PageEditorRichTextToolsColorSelector-selected-fg":
			"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys,
		"--PageEditorRichTextToolsColorSelector-selected-bg":
			"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys,
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
// #endregion preview

// #region item
type PageEditorRichTextToolsColorSelectorItem_ClassNames =
	| "PageEditorRichTextToolsColorSelectorItem"
	| "PageEditorRichTextToolsColorSelectorItem-checkIcon";

type PageEditorRichTextToolsColorSelectorItem_Props<TItem extends BubbleColorMenuItem> = {
	item: TItem;
	isSelected: boolean;
	onSelect: (item: TItem) => void;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

function PageEditorRichTextToolsColorSelectorItem<TItem extends BubbleColorMenuItem>(
	props: PageEditorRichTextToolsColorSelectorItem_Props<TItem>,
) {
	const { item, isSelected, onSelect, activeColor, activeBackground } = props;
	const handleClick = useFn(() => {
		onSelect(item);
	});

	return (
		<MySelectItem
			className={cn("PageEditorRichTextToolsColorSelectorItem" satisfies PageEditorRichTextToolsColorSelectorItem_ClassNames)}
			value={item.color}
			onClick={handleClick}
		>
			<MySelectItemContent>
				<MySelectItemContentIcon>
					<PageEditorRichTextToolsColorSelectorPreview
						activeColor={activeColor}
						activeBackground={activeBackground}
					/>
				</MySelectItemContentIcon>
				<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
			</MySelectItemContent>

			{isSelected && (
				<MySelectItemIndicator>
					<Check
						className={cn(
							"PageEditorRichTextToolsColorSelectorItem-checkIcon" satisfies PageEditorRichTextToolsColorSelectorItem_ClassNames,
						)}
					/>
				</MySelectItemIndicator>
			)}
		</MySelectItem>
	);
}
// #endregion item

// #region list
type PageEditorRichTextToolsColorSelectorList_Props = {
	activeColor: TextColorItem | undefined;
	activeBackground: HighlightColorItem | undefined;
	onColorSelect: (item: TextColorItem) => void;
	onHighlightSelect: (item: HighlightColorItem) => void;
};

function PageEditorRichTextToolsColorSelectorList(props: PageEditorRichTextToolsColorSelectorList_Props) {
	const { activeColor, activeBackground, onColorSelect, onHighlightSelect } = props;

	return (
		<MySelectPopoverScrollableArea>
			<MySelectPopoverContent>
				<MySelectItemsGroup>
					<MySelectItemsGroupText>Color</MySelectItemsGroupText>
					{TEXT_COLORS.map((item) => {
						const isSelected =
							item === activeColor ||
							(item.color ===
								`var${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys}` &&
								!activeColor);

						return (
							<PageEditorRichTextToolsColorSelectorItem
								key={item.name}
								item={item}
								isSelected={isSelected}
								onSelect={onColorSelect}
								activeColor={item.color}
							/>
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
							<PageEditorRichTextToolsColorSelectorItem
								key={item.name}
								item={item}
								isSelected={isSelected}
								onSelect={onHighlightSelect}
								activeBackground={item.color}
							/>
						);
					})}
				</MySelectItemsGroup>
			</MySelectPopoverContent>
		</MySelectPopoverScrollableArea>
	);
}
// #endregion list

// #region root
export type PageEditorRichTextToolsColorSelector_ClassNames =
	| "PageEditorRichTextToolsColorSelector"
	| "PageEditorRichTextToolsColorSelector-popover";

export type PageEditorRichTextToolsColorSelector_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

type PageEditorRichTextToolsColorSelectorInner_Props = PageEditorRichTextToolsColorSelector_Props & {
	activeColor: TextColorItem | undefined;
	activeBackground: HighlightColorItem | undefined;
	onColorSelect: (item: TextColorItem) => void;
	onHighlightSelect: (item: HighlightColorItem) => void;
};

const PageEditorRichTextToolsColorSelectorInner = memo(function PageEditorRichTextToolsColorSelectorInner(
	props: PageEditorRichTextToolsColorSelectorInner_Props,
) {
	const { editor, activeColor, activeBackground, onColorSelect, onHighlightSelect, setDecorationHighlightOnOpen = false } =
		props;

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

	// Unmount useEffect
	useEffect(() => {
		return () => {
			if (didSetDecorationHighlightRef.current) {
				PageEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
			}
		};
	}, []);

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
				setOpen={doSetOpen}
			>
				<MySelectTrigger>
					<MyButton
						ref={triggerButtonRef}
						variant="ghost"
						{...(setDecorationHighlightOnOpen
							? ({ "data-app-set-decoration-highlight": "" } satisfies Partial<PageEditorRichText_CustomAttributes>)
							: {})}
					>
						<PageEditorRichTextToolsColorSelectorPreview
							activeColor={activeColor?.color}
							activeBackground={activeBackground?.color}
						/>
						<MySelectOpenIndicator>
							<ChevronDown />
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
					<PageEditorRichTextToolsColorSelectorList
						activeColor={activeColor}
						activeBackground={activeBackground}
						onColorSelect={onColorSelect}
						onHighlightSelect={onHighlightSelect}
					/>
				</MySelectPopover>
			</MySelect>
		</div>
	);
});

export const PageEditorRichTextToolsColorSelector = memo(function PageEditorRichTextToolsColorSelector(
	props: PageEditorRichTextToolsColorSelector_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor, setDecorationHighlightOnOpen = false } = props;

	// Subscribe to the derived color state so mark changes rerender immediately.
	const editorState = useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				activeColor:
					TEXT_COLORS.find(({ color }) => editor.isActive("textStyle", { color }))?.color ?? null,
				activeBackground:
					HIGHLIGHT_COLORS.find(({ color }) => editor.isActive("highlight", { color }))?.color ?? null,
			};
		},
	});

	const forceRender = useForceRender();

	const activeColor = TEXT_COLORS.find(({ color }) => color === editorState.activeColor);
	const activeBackground = HIGHLIGHT_COLORS.find(({ color }) => color === editorState.activeBackground);

	const handleColorSelect = useFn((item: TextColorItem) => {
		editor.commands.command(({ commands }) => {
			commands.unsetColor();
			if (
				item.color !==
				`var(${"--PageEditorRichText-text-color-fg-default" satisfies PageEditorRichText_FgColorCssVarKeys})`
			) {
				commands.setColor(item.color);
			}
			return true;
		});

		forceRender();
	});

	const handleHighlightSelect = useFn((item: HighlightColorItem) => {
		editor.commands.command(({ commands }) => {
			commands.unsetHighlight();
			if (
				item.color !==
				`var${"--PageEditorRichText-text-color-bg-default" satisfies PageEditorRichText_BgColorCssVarKeys}`
			) {
				commands.setHighlight({ color: item.color });
			}
			return true;
		});

		forceRender();
	});

	return (
		<PageEditorRichTextToolsColorSelectorInner
			editor={editor}
			activeColor={activeColor}
			activeBackground={activeBackground}
			onColorSelect={handleColorSelect}
			onHighlightSelect={handleHighlightSelect}
			setDecorationHighlightOnOpen={setDecorationHighlightOnOpen}
		/>
	);
});
// #endregion root
