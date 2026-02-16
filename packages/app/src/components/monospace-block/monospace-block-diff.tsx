import "./monospace-block-diff.css";

import { useState, type ComponentPropsWithRef, type CSSProperties, type Ref } from "react";
import { cn, forward_ref } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useUiStickToBottom } from "@/lib/ui.tsx";

type DiffMonospaceBlock_ClassNames =
	| "DiffMonospaceBlock"
	| "DiffMonospaceBlock-line"
	| "DiffMonospaceBlock-line-added"
	| "DiffMonospaceBlock-line-removed"
	| "DiffMonospaceBlock-line-header"
	| "DiffMonospaceBlock-line-context";

type DiffMonospaceBlock_CssVars = {
	"--DiffMonospaceBlock-max-height": string;
};

const DiffMonospaceBlock_CssVars_DEFAULTS: DiffMonospaceBlock_CssVars = {
	"--DiffMonospaceBlock-max-height": "16lh",
} as const;

export type DiffMonospaceBlock_Props = Omit<ComponentPropsWithRef<"pre">, "children"> & {
	ref?: Ref<HTMLPreElement>;
	id?: string;
	className?: string;
	diffText: string;
	stickToBottom?: boolean;
	maxHeight?: string;
	style?: CSSProperties & Partial<DiffMonospaceBlock_CssVars>;
};

export function DiffMonospaceBlock(props: DiffMonospaceBlock_Props) {
	const { ref, id, className, diffText, stickToBottom = false, maxHeight, style, ...rest } = props;
	const [scrollEl, setScrollEl] = useState<HTMLPreElement | null>(null);

	const normalizedDiffText = diffText.replace(/\r\n?/g, "\n");
	const lines = normalizedDiffText.split("\n");

	useUiStickToBottom({
		scrollEl,
		contentKey: normalizedDiffText,
		enable: stickToBottom,
	});

	return (
		<pre
			ref={(node) => forward_ref(node, ref, setScrollEl)}
			id={id}
			className={cn(
				"DiffMonospaceBlock" satisfies DiffMonospaceBlock_ClassNames,
				"app-font-monospace" satisfies AppClassName,
				className,
			)}
			style={{
				...({
					...DiffMonospaceBlock_CssVars_DEFAULTS,
					"--DiffMonospaceBlock-max-height":
						maxHeight ?? DiffMonospaceBlock_CssVars_DEFAULTS["--DiffMonospaceBlock-max-height"],
				} satisfies Partial<DiffMonospaceBlock_CssVars>),
				...style,
			}}
			{...rest}
		>
			{lines.map((line, index) => {
				const isHeaderLine =
					line.startsWith("diff --git") ||
					line.startsWith("index ") ||
					line.startsWith("@@") ||
					line.startsWith("+++") ||
					line.startsWith("---");
				const isAddedLine = !isHeaderLine && line.startsWith("+");
				const isRemovedLine = !isHeaderLine && line.startsWith("-");

				const lineVariantClassName = isHeaderLine
					? ("DiffMonospaceBlock-line-header" satisfies DiffMonospaceBlock_ClassNames)
					: isAddedLine
						? ("DiffMonospaceBlock-line-added" satisfies DiffMonospaceBlock_ClassNames)
						: isRemovedLine
							? ("DiffMonospaceBlock-line-removed" satisfies DiffMonospaceBlock_ClassNames)
							: ("DiffMonospaceBlock-line-context" satisfies DiffMonospaceBlock_ClassNames);
				const lineText = index === lines.length - 1 ? line : `${line}\n`;

				return (
					<span
						key={index}
						className={cn("DiffMonospaceBlock-line" satisfies DiffMonospaceBlock_ClassNames, lineVariantClassName)}
					>
						{lineText}
					</span>
				);
			})}
		</pre>
	);
}
