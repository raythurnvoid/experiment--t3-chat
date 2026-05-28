import "./monospace-block-text.css";

import { memo, useState, type ComponentPropsWithRef, type CSSProperties, type Ref } from "react";
import type { ExtractStrict } from "type-fest";

import { useFn } from "@/hooks/utils-hooks.ts";
import { cn, forward_ref } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useUiStickToBottom } from "@/lib/ui.tsx";

type TextMonospaceBlock_ClassNames = "TextMonospaceBlock" | "TextMonospaceBlock-line";

type TextMonospaceBlock_CssVars = {
	"--TextMonospaceBlock-max-height": string;
};

const TextMonospaceBlock_CssVars_DEFAULTS: TextMonospaceBlock_CssVars = {
	"--TextMonospaceBlock-max-height": "16lh",
} as const;

export type TextMonospaceBlock_Props = Omit<
	ComponentPropsWithRef<"pre">,
	ExtractStrict<keyof ComponentPropsWithRef<"pre">, "children">
> & {
	ref?: Ref<HTMLPreElement>;
	id?: string;
	className?: string;
	text: string | undefined;
	stickToBottom?: boolean;
	maxHeight?: string;
	style?: CSSProperties & Partial<TextMonospaceBlock_CssVars>;
};

export const TextMonospaceBlock = memo(function TextMonospaceBlock(props: TextMonospaceBlock_Props) {
	const {
		ref,
		id,
		role,
		"aria-label": ariaLabel,
		"aria-readonly": ariaReadonly,
		"aria-multiline": ariaMultiline,
		tabIndex,
		className,
		text,
		stickToBottom = false,
		maxHeight,
		style,
		onKeyDown,
		onMouseDown,
		...rest
	} = props;

	const [scrollEl, setScrollEl] = useState<HTMLPreElement | null>(null);

	const normalizedText = text?.replace(/\r\n?/g, "\n");
	const lines = normalizedText?.split("\n");

	useUiStickToBottom({
		scrollEl,
		contentKey: normalizedText,
		enable: stickToBottom,
	});

	const handleRef = useFn((node: HTMLPreElement | null) => {
		return forward_ref(node, ref, setScrollEl);
	});

	const handleKeyDown = useFn<ComponentPropsWithRef<"pre">["onKeyDown"]>((event) => {
		onKeyDown?.(event);
		if (
			event.defaultPrevented ||
			event.altKey ||
			!(event.ctrlKey || event.metaKey) ||
			event.key.toLowerCase() !== "a"
		) {
			return;
		}

		event.preventDefault();

		// Keep Select All scoped to the focused preview instead of the whole page.
		const selection = document.getSelection();
		if (!selection) return;

		const range = document.createRange();
		range.selectNodeContents(event.currentTarget);
		selection.removeAllRanges();
		selection.addRange(range);
	});

	const handleMouseDown = useFn<ComponentPropsWithRef<"pre">["onMouseDown"]>((event) => {
		onMouseDown?.(event);
		if (event.defaultPrevented) return;

		// Non-native textbox roles do not always take focus on pointer interaction.
		event.currentTarget.focus();
	});

	return (
		<pre
			ref={handleRef}
			id={id}
			role={role ?? "textbox"}
			aria-label={ariaLabel ?? "Text preview"}
			aria-readonly={ariaReadonly ?? true}
			aria-multiline={ariaMultiline ?? true}
			tabIndex={tabIndex ?? 0}
			className={cn(
				"TextMonospaceBlock" satisfies TextMonospaceBlock_ClassNames,
				"app-font-monospace" satisfies AppClassName,
				className,
			)}
			style={{
				...({
					...TextMonospaceBlock_CssVars_DEFAULTS,
					"--TextMonospaceBlock-max-height":
						maxHeight ?? TextMonospaceBlock_CssVars_DEFAULTS["--TextMonospaceBlock-max-height"],
				} satisfies Partial<TextMonospaceBlock_CssVars>),
				...style,
			}}
			onKeyDown={handleKeyDown}
			onMouseDown={handleMouseDown}
			{...rest}
		>
			{lines?.map((line, index) => {
				const lineText = index === lines.length - 1 ? line : `${line}\n`;
				return (
					<span key={index} className={"TextMonospaceBlock-line" satisfies TextMonospaceBlock_ClassNames}>
						{lineText}
					</span>
				);
			})}
		</pre>
	);
});
