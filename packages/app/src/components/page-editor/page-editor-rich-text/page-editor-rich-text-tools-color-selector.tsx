import "./page-editor-rich-text-tools-color-selector.css";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

export type PageEditorRichTextToolsColorSelector_ClassNames =
	| "PageEditorRichTextToolsColorSelector"
	| "PageEditorRichTextToolsColorSelector-popover"
	| "PageEditorRichTextToolsColorSelector-item"
	| "PageEditorRichTextToolsColorSelector-check-icon";

export type PageEditorRichTextToolsColorSelector_Props = {
	editor: Editor;
	setDecorationHighlightOnOpen?: boolean;
};

export function PageEditorRichTextToolsColorSelector(props: PageEditorRichTextToolsColorSelector_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor, setDecorationHighlightOnOpen = false } = props;

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				selection: editor.state.selection,
			};
		},
	});

	const forceRender = useForceRender();
	const [open, setOpen] = useState(false);

	const triggerButtonRef = useRef<HTMLButtonElement>(null);
	const openRef = useRef(false);
	const didSetDecorationHighlightRef = useRef(false);

	const doSetOpen = (next: boolean | ((prev: boolean) => boolean)) => {
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
	};

	const activeColor = editor ? TEXT_COLORS.find(({ color }) => editor.isActive("textStyle", { color })) : undefined;
	const activeBackground = editor
		? HIGHLIGHT_COLORS.find(({ color }) => editor.isActive("highlight", { color }))
		: undefined;

	const handleColorSelect = (item: (typeof TEXT_COLORS)[number]) => {
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
	};

	const handleHighlightSelect = (item: (typeof HIGHLIGHT_COLORS)[number]) => {
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
	};

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
