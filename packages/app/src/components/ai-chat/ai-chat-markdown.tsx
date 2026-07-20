import "./ai-chat-markdown.css";

import { isValidElement, memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, Streamdown, type Components } from "streamdown";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "../../lib/dom-utils.ts";

// #region code
type AiChatMarkdownCode_ClassNames = "AiChatMarkdown-inline-code";

function AiChatMarkdownCode(props: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<code className={cn("AiChatMarkdown-inline-code" satisfies AiChatMarkdownCode_ClassNames, className)} {...rest}>
			{children}
		</code>
	);
}
// #endregion code

// #region pre
type AiChatMarkdownPre_ClassNames =
	| "AiChatMarkdown-code-block"
	| "AiChatMarkdown-code-header"
	| "AiChatMarkdown-code-header-language"
	| "AiChatMarkdown-code-copy-button"
	| "AiChatMarkdown-pre"
	| "AiChatMarkdown-code";

function get_code_text(children: ReactNode): string {
	if (typeof children === "string" || typeof children === "number") {
		return String(children);
	}

	if (Array.isArray(children)) {
		return children.map(get_code_text).join("");
	}

	return "";
}

function get_code_language(className: string | undefined) {
	const match = className?.match(/(?:^|\s)language-(\S+)/);
	return match?.[1] ?? "text";
}

function get_first_child(children: ReactNode) {
	return Array.isArray(children) ? children[0] : children;
}

function AiChatMarkdownPre(props: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;
	const firstChild = get_first_child(children);
	let codeClassName: string | undefined;
	let code = get_code_text(children);

	if (isValidElement(firstChild)) {
		const childProps = firstChild.props as { className?: string; children?: ReactNode };
		codeClassName = childProps.className;
		code = get_code_text(childProps.children);
	}

	const displayCode = code.endsWith("\n") ? code.slice(0, -1) : code;

	return (
		<div className={"AiChatMarkdown-code-block" satisfies AiChatMarkdownPre_ClassNames}>
			<div className={"AiChatMarkdown-code-header" satisfies AiChatMarkdownPre_ClassNames}>
				<span className={"AiChatMarkdown-code-header-language" satisfies AiChatMarkdownPre_ClassNames}>
					{get_code_language(codeClassName)}
				</span>
				<CopyIconButton
					variant="ghost-highlightable"
					className={"AiChatMarkdown-code-copy-button" satisfies AiChatMarkdownPre_ClassNames}
					text={displayCode}
					tooltipCopy="Copy code"
				/>
			</div>
			<pre className={cn("AiChatMarkdown-pre" satisfies AiChatMarkdownPre_ClassNames, className)} {...rest}>
				<code className={cn("AiChatMarkdown-code" satisfies AiChatMarkdownPre_ClassNames, codeClassName)}>
					{displayCode}
				</code>
			</pre>
		</div>
	);
}
// #endregion pre

// #region ul
/**
 * Streamdown's default list components use `list-inside` (list-style-position: inside),
 * which pushes the marker onto its own line when the li starts with a block element
 * (loose list items render as `<li><p>…</p>…</li>`). Render plain ul/ol instead so the
 * `.app-doc` list styles apply with default outside markers.
 */
function AiChatMarkdownUl(props: ComponentPropsWithoutRef<"ul"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<ul className={cn("AiChatMarkdown-ul" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</ul>
	);
}
// #endregion ul

// #region ol
/**
 * Streamdown's default list components use `list-inside` (list-style-position: inside),
 * which pushes the marker onto its own line when the li starts with a block element
 * (loose list items render as `<li><p>…</p>…</li>`). Render plain ul/ol instead so the
 * `.app-doc` list styles apply with default outside markers.
 */
function AiChatMarkdownOl(props: ComponentPropsWithoutRef<"ol"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<ol className={cn("AiChatMarkdown-ol" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</ol>
	);
}
// #endregion ol

// #region root
export type AiChatMarkdown_ClassNames =
	| "AiChatMarkdown"
	| "AiChatMarkdown-content"
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
	| "AiChatMarkdown-sup";

const ai_chat_markdown_components = {
	code: AiChatMarkdownCode,
	pre: AiChatMarkdownPre,
	ul: AiChatMarkdownUl,
	ol: AiChatMarkdownOl,
} satisfies Components;

export type AiChatMarkdown_Props = {
	className?: string;
	contentClassName?: string;
	markdown: string;
};

export const AiChatMarkdown = memo(function AiChatMarkdown(props: AiChatMarkdown_Props) {
	const { markdown, className, contentClassName } = props;

	// remark-breaks renders soft line breaks as <br> like chat UIs do, since
	// model output relies on single newlines for line separation.
	const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

	return (
		<div
			className={cn("AiChatMarkdown" satisfies AiChatMarkdown_ClassNames, "app-doc" satisfies AppClassName, className)}
		>
			<Streamdown
				mode="static"
				className={cn("AiChatMarkdown-content" satisfies AiChatMarkdown_ClassNames, contentClassName)}
				remarkPlugins={remarkPlugins}
				components={ai_chat_markdown_components}
			>
				{markdown}
			</Streamdown>
		</div>
	);
});

// #endregion root
