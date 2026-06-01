import "./ai-chat-markdown.css";

import { isValidElement, memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
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

// #region root
type markdown_MdastNode = {
	type?: string;
	children?: markdown_MdastNode[];
	value?: string;
};

function is_mdast_node_children_an_array(
	node: markdown_MdastNode,
): node is markdown_MdastNode & { children: Array<markdown_MdastNode> } {
	return Array.isArray(node.children) && node.children.length > 0;
}

function is_mdast_node(value: unknown): value is markdown_MdastNode {
	return Boolean(value) && typeof value === "object";
}

function merge_adjacent_text_nodes(children: markdown_MdastNode[]) {
	for (let index = children.length - 1; index > 0; index -= 1) {
		const current = children[index];
		const previous = children[index - 1];

		if (previous?.type !== "text" || typeof previous.value !== "string") {
			continue;
		}

		if (current?.type !== "text" || typeof current.value !== "string") {
			continue;
		}

		previous.value += current.value;
		children.splice(index, 1);
	}
}

function is_mdast_node_html_break(node: markdown_MdastNode) {
	return node.type === "html" && typeof node.value === "string" && /^<br\s*\/?>$/i.test(node.value.trim());
}

const remark_plugin_replace_break_with_newline = ((/* iife */) => {
	function value() {
		return (tree: unknown) => {
			if (!is_mdast_node(tree) || !is_mdast_node_children_an_array(tree)) {
				return;
			}

			const stack: markdown_MdastNode[] = [tree];

			while (stack.length > 0) {
				const node = stack.pop();
				if (!node || !is_mdast_node_children_an_array(node)) {
					continue;
				}

				const children = node.children;

				for (let index = 0; index < children.length; index += 1) {
					const child = children[index];
					if (!is_mdast_node(child)) {
						continue;
					}

					if (child.type === "break" || is_mdast_node_html_break(child)) {
						children[index] = {
							type: "text",
							value: "\n",
						};
						continue;
					}

					if (is_mdast_node_children_an_array(child)) {
						stack.push(child);
					}
				}

				if (children.length > 1) {
					merge_adjacent_text_nodes(children);
				}
			}
		};
	}

	let cache: ReturnType<typeof value> | undefined = undefined;

	return function remark_plugin_replace_break_with_newline() {
		if (!cache) {
			cache = value();
		}

		return cache;
	};
})();

export type AiChatMarkdown_ClassNames =
	| "AiChatMarkdown"
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
} satisfies Components;

export type AiChatMarkdown_Props = {
	className?: string;
	markdown: string;
	replaceNewLineToBr?: boolean;
};

export const AiChatMarkdown = memo(function AiChatMarkdown(props: AiChatMarkdown_Props) {
	const { markdown, replaceNewLineToBr, className } = props;

	const remarkPlugins = [
		...Object.values(defaultRemarkPlugins),
		...(replaceNewLineToBr ? [remark_plugin_replace_break_with_newline] : []),
	];

	let markdownToParse = markdown;
	if (replaceNewLineToBr) {
		markdownToParse = markdownToParse.replaceAll("\n", "<br>");
		// For trailing br we need to add an extra one to emulate the
		// empty line when switching to composer mode
		if (markdownToParse.endsWith("<br>")) {
			markdownToParse += "<br>";
		}
	}

	return (
		<div
			className={cn("AiChatMarkdown" satisfies AiChatMarkdown_ClassNames, "app-doc" satisfies AppClassName, className)}
		>
			<Streamdown mode="static" remarkPlugins={remarkPlugins} components={ai_chat_markdown_components}>
				{markdownToParse}
			</Streamdown>
		</div>
	);
});

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

	describe("remark_plugin_replace_break_with_newline", () => {
		test("replaces non-trailing break nodes and merges adjacent text nodes", () => {
			const tree = {
				type: "root",
				children: [
					{
						type: "paragraph",
						children: [{ type: "text", value: "hello" }, { type: "break" }, { type: "text", value: "world" }],
					},
				],
			} satisfies markdown_MdastNode;

			remark_plugin_replace_break_with_newline()(tree);

			expect(tree).toMatchInlineSnapshot(`
				{
				  "children": [
				    {
				      "children": [
				        {
				          "type": "text",
				          "value": "hello
				world",
				        },
				      ],
				      "type": "paragraph",
				    },
				  ],
				  "type": "root",
				}
			`);
		});

		test("replaces trailing break nodes with newline text", () => {
			const tree = {
				type: "root",
				children: [
					{
						type: "paragraph",
						children: [{ type: "text", value: "line" }, { type: "break" }, { type: "break" }],
					},
				],
			} satisfies markdown_MdastNode;

			remark_plugin_replace_break_with_newline()(tree);

			expect(tree).toMatchInlineSnapshot(`
				{
				  "children": [
				    {
				      "children": [
				        {
				          "type": "text",
				          "value": "line

				",
				        },
				      ],
				      "type": "paragraph",
				    },
				  ],
				  "type": "root",
				}
			`);
		});

		test("applies the same conversion to nested mdast children", () => {
			const tree = {
				type: "root",
				children: [
					{
						type: "blockquote",
						children: [
							{
								type: "paragraph",
								children: [{ type: "text", value: "nested" }, { type: "break" }, { type: "text", value: "line" }],
							},
						],
					},
				],
			} satisfies markdown_MdastNode;

			remark_plugin_replace_break_with_newline()(tree);

			expect(tree).toMatchInlineSnapshot(`
				{
				  "children": [
				    {
				      "children": [
				        {
				          "children": [
				            {
				              "type": "text",
				              "value": "nested
				line",
				            },
				          ],
				          "type": "paragraph",
				        },
				      ],
				      "type": "blockquote",
				    },
				  ],
				  "type": "root",
				}
			`);
		});

		test("replaces html br nodes with newline text, including trailing br", () => {
			const tree = {
				type: "root",
				children: [
					{
						type: "paragraph",
						children: [
							{ type: "text", value: "line" },
							{ type: "html", value: "<br>" },
							{ type: "html", value: "<br />" },
						],
					},
				],
			} satisfies markdown_MdastNode;

			remark_plugin_replace_break_with_newline()(tree);

			expect(tree).toMatchInlineSnapshot(`
				{
				  "children": [
				    {
				      "children": [
				        {
				          "type": "text",
				          "value": "line

				",
				        },
				      ],
				      "type": "paragraph",
				    },
				  ],
				  "type": "root",
				}
			`);
		});
	});
}
// #endregion root
