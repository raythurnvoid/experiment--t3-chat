import { Node, type JSONContent as TiptapJSONContent } from "@tiptap/core";

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;

export function files_frontmatter_extract(markdown: string): {
	frontmatterText: string | null;
	body: string;
} {
	const match = FRONTMATTER_REGEX.exec(markdown);
	if (!match) {
		return { frontmatterText: null, body: markdown };
	}
	return {
		frontmatterText: match[1],
		body: markdown.slice(match[0].length),
	};
}

export function files_frontmatter_attach_to_doc(
	doc: TiptapJSONContent,
	frontmatterText: string | null,
): TiptapJSONContent {
	if (frontmatterText === null) {
		return doc;
	}
	return {
		...doc,
		content: [{ type: "frontmatter", attrs: { text: frontmatterText } }, ...(doc.content ?? [])],
	};
}

export const files_frontmatter_node = Node.create({
	name: "frontmatter",
	group: "block",
	atom: true,
	selectable: true,
	defining: true,

	addAttributes() {
		return {
			text: {
				default: "",
				parseHTML: (element) => element.textContent ?? "",
				renderHTML: () => ({}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "pre[data-frontmatter]" }];
	},

	renderHTML({ node }) {
		return ["pre", { "data-frontmatter": "" }, node.attrs.text];
	},

	renderMarkdown(node) {
		const text = typeof node.attrs?.text === "string" ? node.attrs.text : "";
		return `---\n${text}\n---\n`;
	},
});
