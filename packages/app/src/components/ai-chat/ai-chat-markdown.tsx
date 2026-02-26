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
	className?: string;
	markdown: string;
	replaceNewLineToBr?: boolean;
};

export function AiChatMarkdown(props: AiChatMarkdown_Props) {
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
			<Streamdown mode="static" remarkPlugins={remarkPlugins}>
				{markdownToParse}
			</Streamdown>
		</div>
	);
}

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
