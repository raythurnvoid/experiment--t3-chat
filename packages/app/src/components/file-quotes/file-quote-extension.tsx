import { Node, createInlineMarkdownSpec } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { file_quotes_decode_draft_data } from "../../../shared/file-quotes.ts";
import { FileQuote } from "./file-quote.tsx";

const markdownSpec = createInlineMarkdownSpec({
	nodeName: "fileQuote",
	name: "file-quote",
	selfClosing: true,
	allowedAttributes: ["data"],
});

// eslint-disable-next-line react-refresh/only-export-components
function FileQuoteNodeView(props: NodeViewProps) {
	const quote = file_quotes_decode_draft_data(props.node.attrs.data);
	return (
		<NodeViewWrapper as="span" contentEditable={false}>
			{quote ? <FileQuote quote={quote} /> : "Quote unavailable"}
		</NodeViewWrapper>
	);
}

/**
 * Inline so both composers can keep text before and after the quote.
 */
export const file_quote_extension = Node.create({
	name: "fileQuote",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes() {
		return { data: { default: null } };
	},
	parseHTML() {
		return [
			{
				tag: "span[data-file-quote]",
				getAttrs: (element) => {
					const data = element.getAttribute("data-file-quote");
					return file_quotes_decode_draft_data(data) ? { data } : false;
				},
			},
		];
	},
	renderHTML({ node }) {
		return ["span", { "data-file-quote": node.attrs.data }, file_quotes_decode_draft_data(node.attrs.data)?.text ?? ""];
	},
	renderText({ node }) {
		return `[file-quote data="${node.attrs.data}"]`;
	},
	...markdownSpec,
	parseMarkdown(token, helpers) {
		return file_quotes_decode_draft_data(token.attributes?.data)
			? markdownSpec.parseMarkdown(token, helpers)
			: helpers.createTextNode(token.raw ?? "");
	},
	addNodeView() {
		return ReactNodeViewRenderer(FileQuoteNodeView, { as: "span" });
	},
});
