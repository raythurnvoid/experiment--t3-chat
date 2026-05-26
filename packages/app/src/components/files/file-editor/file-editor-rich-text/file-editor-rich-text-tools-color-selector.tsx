import "./file-editor-rich-text-tools-color-selector.css";
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
	FileEditorRichText,
	type FileEditorRichText_FgColorCssVarKeys,
	type FileEditorRichText_BgColorCssVarKeys,
	type FileEditorRichText_CustomAttributes,
} from "./file-editor-rich-text.tsx";
import { useEditorState, type Editor } from "@tiptap/react";

export interface BubbleColorMenuItem {
	name: string;
	color: string;
}

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
type FileEditorRichTextToolsColorSelectorPreview_ClassNames = "FileEditorRichTextToolsColorSelectorPreview";

type FileEditorRichTextToolsColorSelectorPreview_CssVars = {
	"--FileEditorRichTextToolsColorSelector-selected-fg": string;
	"--FileEditorRichTextToolsColorSelector-selected-bg": string;
};

const FileEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS: Partial<FileEditorRichTextToolsColorSelectorPreview_CssVars> =
	{
		"--FileEditorRichTextToolsColorSelector-selected-fg":
			"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys,
		"--FileEditorRichTextToolsColorSelector-selected-bg":
			"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys,
	} as const;

export type FileEditorRichTextToolsColorSelectorPreview_Props = {
	className?: string;
	style?: React.CSSProperties & Partial<FileEditorRichTextToolsColorSelectorPreview_CssVars>;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

export function FileEditorRichTextToolsColorSelectorPreview(props: FileEditorRichTextToolsColorSelectorPreview_Props) {
	const { className, style, activeColor, activeBackground } = props;

	return (
		<span
			className={cn(
				"FileEditorRichTextToolsColorSelectorPreview" satisfies FileEditorRichTextToolsColorSelectorPreview_ClassNames,
				className,
			)}
			style={{
				...({
					...FileEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS,
					"--FileEditorRichTextToolsColorSelector-selected-fg":
						activeColor ??
						FileEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS[
							"--FileEditorRichTextToolsColorSelector-selected-fg"
						],
					"--FileEditorRichTextToolsColorSelector-selected-bg":
						activeBackground ??
						FileEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS[
							"--FileEditorRichTextToolsColorSelector-selected-bg"
						],
				} satisfies Partial<FileEditorRichTextToolsColorSelectorPreview_CssVars>),
				...style,
			}}
		>
			A
		</span>
	);
}
// #endregion preview

// #region item
type FileEditorRichTextToolsColorSelectorItem_ClassNames =
	| "FileEditorRichTextToolsColorSelectorItem"
	| "FileEditorRichTextToolsColorSelectorItem-checkIcon";

type FileEditorRichTextToolsColorSelectorItem_Props<TItem extends BubbleColorMenuItem> = {
	item: TItem;
	isSelected: boolean;
	onSelect: (item: TItem) => void;
	activeColor?: FgColorCssValue;
	activeBackground?: BgColorCssValue;
};

function FileEditorRichTextToolsColorSelectorItem<TItem extends BubbleColorMenuItem>(
	props: FileEditorRichTextToolsColorSelectorItem_Props<TItem>,
) {
	const { item, isSelected, onSelect, activeColor, activeBackground } = props;
	const handleClick = useFn(() => {
		onSelect(item);
	});

	return (
		<MySelectItem
			className={cn("FileEditorRichTextToolsColorSelectorItem" satisfies FileEditorRichTextToolsColorSelectorItem_ClassNames)}
			value={item.color}
			onClick={handleClick}
		>
			<MySelectItemContent>
				<MySelectItemContentIcon>
					<FileEditorRichTextToolsColorSelectorPreview
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
							"FileEditorRichTextToolsColorSelectorItem-checkIcon" satisfies FileEditorRichTextToolsColorSelectorItem_ClassNames,
						)}
					/>
				</MySelectItemIndicator>
			)}
		</MySelectItem>
	);
}
// #endregion item

// #region list
type FileEditorRichTextToolsColorSelectorList_Props = {
	activeColor: TextColorItem | undefined;
	activeBackground: HighlightColorItem | undefined;
	onColorSelect: (item: TextColorItem) => void;
	onHighlightSelect: (item: HighlightColorItem) => void;
};

function FileEditorRichTextToolsColorSelectorList(props: FileEditorRichTextToolsColorSelectorList_Props) {
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
								`var${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys}` &&
								!activeColor);

						return (
							<FileEditorRichTextToolsColorSelectorItem
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
							(item.color === `var(--FileEditorRichText-text-color-bg-default)` && !activeBackground);

						return (
							<FileEditorRichTextToolsColorSelectorItem
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
export type FileEditorRichTextToolsColorSelector_ClassNames =
	| "FileEditorRichTextToolsColorSelector"
	| "FileEditorRichTextToolsColorSelector-popover";

export type FileEditorRichTextToolsColorSelector_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

type FileEditorRichTextToolsColorSelectorInner_Props = FileEditorRichTextToolsColorSelector_Props & {
	activeColor: TextColorItem | undefined;
	activeBackground: HighlightColorItem | undefined;
	onColorSelect: (item: TextColorItem) => void;
	onHighlightSelect: (item: HighlightColorItem) => void;
};

const FileEditorRichTextToolsColorSelectorInner = memo(function FileEditorRichTextToolsColorSelectorInner(
	props: FileEditorRichTextToolsColorSelectorInner_Props,
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
				FileEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
				didSetDecorationHighlightRef.current = false;
			}
		}
	});

	// Unmount useEffect
	useEffect(() => {
		return () => {
			if (didSetDecorationHighlightRef.current) {
				FileEditorRichText.clearDecorationHighlightProperly(editor, triggerButtonRef.current);
			}
		};
	}, []);

	return (
		<div
			className={cn("FileEditorRichTextToolsColorSelector" satisfies FileEditorRichTextToolsColorSelector_ClassNames)}
			style={sx({
				...FileEditorRichTextToolsColorSelectorPreview_CssVars_DEFAULTS,
				...({
					"--FileEditorRichTextToolsColorSelector-selected-fg": activeColor?.color,
					"--FileEditorRichTextToolsColorSelector-selected-bg": activeBackground?.color,
				} satisfies Partial<FileEditorRichTextToolsColorSelectorPreview_CssVars>),
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
						aria-label="Text color and highlight"
						{...(setDecorationHighlightOnOpen
							? ({ "data-app-set-decoration-highlight": "" } satisfies Partial<FileEditorRichText_CustomAttributes>)
							: {})}
					>
						<FileEditorRichTextToolsColorSelectorPreview
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
						"FileEditorRichTextToolsColorSelector-popover" satisfies FileEditorRichTextToolsColorSelector_ClassNames,
					)}
					autoFocusOnShow={false}
					unmountOnHide
				>
					<FileEditorRichTextToolsColorSelectorList
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

export const FileEditorRichTextToolsColorSelector = memo(function FileEditorRichTextToolsColorSelector(
	props: FileEditorRichTextToolsColorSelector_Props,
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
				`var(${"--FileEditorRichText-text-color-fg-default" satisfies FileEditorRichText_FgColorCssVarKeys})`
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
				`var${"--FileEditorRichText-text-color-bg-default" satisfies FileEditorRichText_BgColorCssVarKeys}`
			) {
				commands.setHighlight({ color: item.color });
			}
			return true;
		});

		forceRender();
	});

	return (
		<FileEditorRichTextToolsColorSelectorInner
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
