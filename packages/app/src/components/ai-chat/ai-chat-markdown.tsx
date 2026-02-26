import "./ai-chat-markdown.css";

// import type { ComponentPropsWithoutRef, ReactNode } from "react";
// import { cloneElement, isValidElement } from "react";
// import { CheckIcon, CopyIcon } from "lucide-react";
// import { defaultRemarkPlugins, Streamdown, type Components, type StreamdownProps } from "streamdown";

// import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button.tsx";
// import { useAutoRevertingState } from "@/hooks/utils-hooks.ts";
// import { cn, copy_to_clipboard } from "@/lib/utils.ts";

import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "../../lib/dom-utils.ts";

// #region code header
// function CodeHeader(props: { language: string; code: string }) {
// 	const { language, code } = props;
// 	const [isCopied, setIsCopied] = useAutoRevertingState(false, 3000);

// 	const onCopy = () => {
// 		if (!code || isCopied) return;

// 		copy_to_clipboard({ text: code })
// 			.then((result) => {
// 				if (result._nay) {
// 					console.error("[AiChatMarkdown.CodeHeader] Error copying to clipboard", { result });
// 					return;
// 				}

// 				setIsCopied(true);
// 			})
// 			.catch((error) => {
// 				console.error("[AiChatMarkdown.CodeHeader] Error copying to clipboard", { error });
// 			});
// 	};

// 	return (
// 		<div className={"AiChatMarkdown-code-header" satisfies AiChatMarkdown_ClassNames}>
// 			<span className={"AiChatMarkdown-code-header-language" satisfies AiChatMarkdown_ClassNames}>{language}</span>
// 			<TooltipIconButton tooltip="Copy" onClick={onCopy}>
// 				{!isCopied && <CopyIcon />}
// 				{isCopied && <CheckIcon />}
// 			</TooltipIconButton>
// 		</div>
// 	);
// }
// #endregion code header

// #region markdown elements

// function PreComponent(props: ComponentPropsWithoutRef<"pre">) {
// 	const { className, children, ...rest } = props;
// 	let language = "text";
// 	let code = "";
// 	const firstChild = Array.isArray(children) ? children[0] : children;
// 	if (isValidElement(firstChild)) {
// 		const childProps = firstChild.props as { className?: string; children?: ReactNode };
// 		const classNameValue = childProps.className ?? "";
// 		const match = classNameValue.match(/language-(\S+)/);
// 		language = match ? match[1] : "text";
// 		const codeValue = Array.isArray(childProps.children)
// 			? childProps.children.join("")
// 			: String(childProps.children ?? "");
// 		code = codeValue.endsWith("\n") ? codeValue.slice(0, -1) : codeValue;
// 	}

// 	const renderedChildren = Array.isArray(children)
// 		? children.map((child, index) =>
// 				index === 0 && isValidElement(child)
// 					? cloneElement(child, { "data-block": "true" } as { "data-block": string })
// 					: child,
// 			)
// 		: isValidElement(children)
// 			? cloneElement(children, { "data-block": "true" } as { "data-block": string })
// 			: children;

// 	return (
// 		<div className={"AiChatMarkdown-code-block" satisfies AiChatMarkdown_ClassNames}>
// 			<CodeHeader language={language} code={code} />
// 			<pre className={cn("AiChatMarkdown-pre" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
// 				{renderedChildren}
// 			</pre>
// 		</div>
// 	);
// }

// #endregion markdown elements

// #region root
type markdown_MdastNode = {
	type?: string;
	children?: markdown_MdastNode[];
	value?: string;
};

const remark_plugin_preserve_trailing_hard_breaks = ((/* iife */) => {
	function value() {
		const plugin = (tree: unknown, file: unknown) => {
			if (!tree || typeof tree !== "object") {
				return;
			}

			const root = tree as markdown_MdastNode;
			if (root.type !== "root" || !Array.isArray(root.children)) {
				return;
			}

			if (!file || typeof file !== "object") {
				return null;
			}

			const value = (file as { value?: unknown }).value;
			if (typeof value !== "string") {
				return;
			}

			const source = value;

			const trailingHardBreaks = source.match(/(?:\\\n)+$/)?.[0];
			if (!trailingHardBreaks) {
				return;
			}

			const trailingHardBreakCount = (trailingHardBreaks.match(/\\\n/g) ?? []).length;
			if (trailingHardBreakCount === 0) {
				return;
			}

			let lastParagraph;

			const children = root.children ?? [];
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const node = children[index];
				if (node?.type !== "paragraph") {
					continue;
				}

				if (!Array.isArray(node.children)) {
					node.children = [];
				}

				lastParagraph = node;
				break;
			}

			if (!lastParagraph) {
				return;
			}

			const paragraphChildren = lastParagraph.children ?? (lastParagraph.children = []);
			const lastChild = paragraphChildren.at(-1);
			if (lastChild?.type === "text" && typeof lastChild.value === "string" && lastChild.value.endsWith("\\")) {
				const nextValue = lastChild.value.slice(0, -1);
				if (nextValue.length > 0) {
					lastChild.value = nextValue;
				} else {
					paragraphChildren.pop();
				}
			}

			let trailingBreakNodeCount = 0;
			for (let index = paragraphChildren.length - 1; index >= 0; index -= 1) {
				if (paragraphChildren[index]?.type !== "break") {
					break;
				}
				trailingBreakNodeCount += 1;
			}

			const missingBreakCount = trailingHardBreakCount - trailingBreakNodeCount;
			if (missingBreakCount <= 0) {
				return;
			}

			for (let index = 0; index < missingBreakCount; index += 1) {
				paragraphChildren.push({
					type: "break",
				});
			}
		};

		return plugin;
	}

	let cache: ReturnType<typeof value> | undefined;

	return function markdown_remark_preserve_trailing_hard_breaks() {
		return (cache ??= value());
	};
})();

const markdown_remark_plugins = [...Object.values(defaultRemarkPlugins), remark_plugin_preserve_trailing_hard_breaks];

export type AiChatMarkdown_ClassNames =
	| "AiChatMarkdown"
	| "AiChatMarkdown-code-header"
	| "AiChatMarkdown-code-header-language"
	| "AiChatMarkdown-h1"
	| "AiChatMarkdown-h2"
	| "AiChatMarkdown-h3"
	| "AiChatMarkdown-h4"
	| "AiChatMarkdown-h5"
	| "AiChatMarkdown-h6"
	| "AiChatMarkdown-p"
	| "AiChatMarkdown-a"
	| "AiChatMarkdown-blockquote"
	| "AiChatMarkdown-ul"
	| "AiChatMarkdown-ol"
	| "AiChatMarkdown-hr"
	| "AiChatMarkdown-table"
	| "AiChatMarkdown-th"
	| "AiChatMarkdown-td"
	| "AiChatMarkdown-tr"
	| "AiChatMarkdown-sup"
	| "AiChatMarkdown-code-block"
	| "AiChatMarkdown-pre"
	| "AiChatMarkdown-inline-code";

export type AiChatMarkdown_Props = {
	text: string;
	className?: string;
};

export function AiChatMarkdown(props: AiChatMarkdown_Props) {
	const { text, className } = props;

	return (
		<div
			className={cn("AiChatMarkdown" satisfies AiChatMarkdown_ClassNames, "app-doc" satisfies AppClassName, className)}
		>
			<Streamdown mode="static" remarkPlugins={markdown_remark_plugins}>
				{text}
			</Streamdown>
		</div>
	);
}
// #endregion root
