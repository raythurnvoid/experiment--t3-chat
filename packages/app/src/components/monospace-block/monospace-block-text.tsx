import "./monospace-block-text.css";

import { useState, type ComponentPropsWithRef, type CSSProperties, type Ref } from "react";
import { cn, forward_ref } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useUiStickToBottom } from "@/hooks/ui-hooks.tsx";

type TextMonospaceBlock_ClassNames = "TextMonospaceBlock" | "TextMonospaceBlock-line";

type TextMonospaceBlock_CssVars = {
	"--TextMonospaceBlock-max-height": string;
};

const TextMonospaceBlock_CssVars_DEFAULTS: TextMonospaceBlock_CssVars = {
	"--TextMonospaceBlock-max-height": "16lh",
} as const;

export type TextMonospaceBlock_Props = Omit<ComponentPropsWithRef<"pre">, "children"> & {
	ref?: Ref<HTMLPreElement>;
	id?: string;
	className?: string;
	text: string;
	stickToBottom?: boolean;
	maxHeight?: string;
	style?: CSSProperties & Partial<TextMonospaceBlock_CssVars>;
};

export function TextMonospaceBlock(props: TextMonospaceBlock_Props) {
	const { ref, id, className, text, stickToBottom = false, maxHeight, style, ...rest } = props;

	const [scrollEl, setScrollEl] = useState<HTMLPreElement | null>(null);

	const normalizedText = text.replace(/\r\n?/g, "\n");
	const lines = normalizedText.split("\n");

	useUiStickToBottom({
		scrollEl,
		contentKey: normalizedText,
		enable: stickToBottom,
	});

	return (
		<pre
			ref={(inst) => forward_ref(inst, ref, setScrollEl)}
			id={id}
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
			{...rest}
		>
			{lines.map((line, index) => {
				const lineText = index === lines.length - 1 ? line : `${line}\n`;
				return (
					<span key={index} className={"TextMonospaceBlock-line" satisfies TextMonospaceBlock_ClassNames}>
						{lineText}
					</span>
				);
			})}
		</pre>
	);
}
