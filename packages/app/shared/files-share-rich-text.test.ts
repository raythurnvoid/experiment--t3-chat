import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DOMParser as LinkedomDOMParser } from "linkedom/worker";
import {
	files_share_rich_text_finish,
	files_share_rich_text_parse_json,
	files_share_rich_text_prepare,
} from "./files-share-rich-text.ts";

// This suite runs in the edge runtime and in happy-dom. In happy-dom the native parser must never
// run: it can load images and iframes. So make it throw while preparation runs.
let nativeParserSpy: { mockRestore: () => void; mock: { calls: unknown[] } } | null = null;

beforeEach(() => {
	if (typeof window !== "undefined" && window.DOMParser) {
		nativeParserSpy = vi.spyOn(window.DOMParser.prototype, "parseFromString").mockImplementation(() => {
			throw new Error("The native DOMParser must not run");
		});
	}
});

afterEach(() => {
	if (nativeParserSpy) {
		expect(nativeParserSpy.mock.calls).toEqual([]);
		nativeParserSpy.mockRestore();
		nativeParserSpy = null;
	}
});

/**
 * Prepare Markdown and publish it with the given media available.
 */
function publish(markdown: string, availableIndexes: number[] = []) {
	const prepared = files_share_rich_text_prepare({ text: markdown, textKind: "rich_text" });
	if (prepared._nay) {
		return { prepared, content: null };
	}

	const content = files_share_rich_text_finish({
		prepared: prepared._yay,
		isMediaAvailable: (index) => availableIndexes.includes(index),
	});
	return { prepared, content };
}

function rich_json(content: ReturnType<typeof files_share_rich_text_finish> | null) {
	if (content?.kind !== "rich_text") {
		throw new Error(`Expected rich text, got ${content?.kind}`);
	}
	return content.json;
}

type JsonNode = {
	type: string;
	attrs?: Record<string, unknown>;
	marks?: JsonNode[];
	text?: string;
	content?: JsonNode[];
};

function find_nodes(json: string, type: string) {
	const found: JsonNode[] = [];
	const visit = (node: JsonNode) => {
		if (node.type === type) found.push(node);
		for (const child of node.content ?? []) visit(child);
	};
	visit(JSON.parse(json) as JsonNode);
	return found;
}

describe("files_share_rich_text_prepare", () => {
	test("keeps the reduced formatting and drops author attributes", () => {
		const { content } = publish('# Title\n\nSome **bold** ==marked== and a [link](https://example.com/a "t").\n');
		const json = rich_json(content);

		expect(find_nodes(json, "heading")[0]?.attrs).toEqual({ level: 1, textAlign: null });
		const doc = JSON.parse(json) as JsonNode;
		const paragraph = doc.content?.[1];
		expect(paragraph?.content?.map((node) => node.marks?.map((mark) => mark.type) ?? [])).toEqual([
			[],
			["bold"],
			[],
			["highlight"],
			[],
			["link"],
			[],
		]);
		const link = paragraph?.content?.[5]?.marks?.[0];
		expect(link).toEqual({ type: "link", attrs: { href: "https://example.com/a" } });
		expect(json).not.toContain('"title"');
	});

	test("keeps only a checked paragraph alignment from author styles", () => {
		const json = rich_json(
			publish('<p style="text-align:center;color:red;background:url(https://third.example/x)">x</p>\n').content,
		);

		expect(find_nodes(json, "paragraph")[0]?.attrs).toEqual({ textAlign: "center" });
		expect(json).not.toContain("third.example");
		expect(json).not.toContain("red");
	});

	test("drops an invalid alignment", () => {
		const json = rich_json(publish('<p style="text-align: url(x)">x</p>\n').content);

		expect(find_nodes(json, "paragraph")[0]?.attrs).toEqual({ textAlign: null });
	});

	test("reads the alignment of a long style quickly", () => {
		// linkedom's style parser took about 3.7 seconds on 100,000 spaces with no `;`.
		const start = performance.now();
		const json = rich_json(publish(`<p style="color:red${" ".repeat(100_000)}x; TEXT-ALIGN : Right">x</p>\n`).content);
		const elapsed = performance.now() - start;

		expect(find_nodes(json, "paragraph")[0]?.attrs).toEqual({ textAlign: "right" });
		expect(elapsed).toBeLessThan(1_500);
	});

	test("redacts references split by formatting in rich text and in the fallback", () => {
		const markdown = 'See bonobo-<!-- c -->**file://saved_1** and data-lb-thread-**id=**"thread_1" here.\n';
		const json = rich_json(publish(markdown).content);

		expect(json).not.toContain("saved_1");
		expect(json).not.toContain("thread_1");
		expect(json).toContain("[file reference]");
		expect(json).toContain("[comment reference]");

		const fallback = publish(`${markdown}${"<div>".repeat(40)}x${"</div>".repeat(40)}\n`).content;
		expect(fallback).toMatchObject({ kind: "plain_text", formattingFallback: true });
		const text = fallback?.kind === "plain_text" ? fallback.text : "";
		expect(text).toContain("See [file reference] and [comment reference] here.");
		expect(text).not.toContain("saved_1");
		expect(text).not.toContain("thread_1");
	});

	test("redacts entity-encoded references", () => {
		const markdown = "A bonobo-file&#58;//saved_1 and `bonobo-file://private/draft_1` in code.\n";
		const json = rich_json(publish(markdown).content);

		expect(json).not.toContain("saved_1");
		expect(json).not.toContain("draft_1");
	});

	test("drops comment markup and literal comment attributes", () => {
		const json = rich_json(
			publish(
				'Text <span data-type="comment" data-lb-thread-id="thread_1">marked</span>.\n\n```\n<span DATA-LB-THREAD-ID = thread_2>\n```\n',
			).content,
		);

		expect(json).not.toContain("thread_1");
		expect(json).not.toContain("thread_2");
		expect(json).toContain("marked");
	});

	test("turns file-reference links into fixed text", () => {
		const json = rich_json(publish("Open [my private doc](bonobo-file://saved_1).\n").content);

		expect(json).toContain("[file reference]");
		expect(json).not.toContain("saved_1");
		expect(json).not.toContain("my private doc");
	});

	test("hides file-link labels in the fallback, behind leading spaces, and later in the address", () => {
		const markdown =
			'Open [Q3 list](bonobo-file://saved_1) and <a href=" bonobo-file://saved_2">Q4 list</a>.\n\n' +
			// A file copy saves a file link right after a typed URL as one link. The file address is inside it.
			"Merged [https://example.com/rQ5 list.pdf](https://example.com/r%5BQ5%20list.pdf%5D(bonobo-file://saved_3)).\n";
		expect(rich_json(publish(markdown).content)).not.toContain("list");

		const fallback = publish(`${markdown}${"<div>".repeat(40)}x${"</div>".repeat(40)}\n`).content;
		expect(fallback?.kind === "plain_text" && fallback.text).toContain("Open [file reference] and [file reference].");
		expect(fallback?.kind === "plain_text" && fallback.text).not.toContain("list");
	});

	test("removes unsafe link schemes and credentials but keeps the label", () => {
		const json = rich_json(
			publish("[a](javascript:alert(1)) [b](https://user:pass@example.com/) [c](mailto:x@example.com)\n").content,
		);

		expect(find_nodes(json, "text").flatMap((node) => node.marks ?? [])).toEqual([]);
		expect(json).not.toContain("javascript");
		expect(json).not.toContain("pass@");
	});

	test("drops a link whose host is longer than any real host name", () => {
		// `new URL` is slow on a long non-ASCII host, so a host past 255 characters is refused before parsing.
		const json = rich_json(publish(`[a](http://${"a".repeat(300)}.example/) [b](https://example.com/)\n`).content);

		expect(find_nodes(json, "text").flatMap((node) => node.marks ?? [])).toEqual([
			{ type: "link", attrs: { href: "https://example.com/" } },
		]);

		// The URL parser removes a tab, so a tab must not hide a long host from the check.
		const tabbed = rich_json(publish(`<a href="http:/&#9;/${"a".repeat(300)}.example/">c</a>\n`).content);
		expect(find_nodes(tabbed, "text").flatMap((node) => node.marks ?? [])).toEqual([]);
	});

	test("drops a link that is too long or carries a private reference", () => {
		const json = rich_json(
			publish(
				// Keep the long link in its own paragraph. A hidden reference on the same line would drop its mark anyway.
				`[a](https://e.com/${"x".repeat(9_000)})\n\n[b](https://e.com/?bonobo-file://saved_1) [c](https://e.com/data-lb-thread-id=t_1)\n`,
			).content,
		);

		expect(find_nodes(json, "text").flatMap((node) => node.marks ?? [])).toEqual([]);
		expect(json).not.toContain("saved_1");
		expect(json).not.toContain("t_1");
	});

	test("shows plain text when one long link covers too much text", () => {
		// The link mark repeats on each of the 1,200 text nodes, so the JSON would hold 9.6 MB of URLs.
		const prepared = files_share_rich_text_prepare({
			text: `[${"**a**b".repeat(600)}](https://e.com/${"x".repeat(8_000)})\n`,
			textKind: "rich_text",
		});

		expect(prepared._yay?.draft).toMatchObject({ kind: "plain_text", formattingFallback: true });
	});

	test("shows plain text when the HTML parser throws", () => {
		// linkedom adds each class name as its own argument, which overflows the stack.
		const { content } = publish(`<p class="${"a ".repeat(130_000)}">hello</p>\n`);

		expect(content).toEqual({ kind: "plain_text", text: "hello", formattingFallback: true });
	});

	test("gives each kind and reference pair one index, in document order", () => {
		const { prepared } = publish(
			[
				"![a](bonobo-file://saved_1) ![b](bonobo-file://saved_1)",
				'<video src="bonobo-file://saved_1"></video>',
				"![c](bonobo-file://private/draft_1)",
				'<img src="bonobo-file://saved_2" data-share-index="0" data-share-media>',
				"",
			].join("\n\n"),
		);

		expect(prepared._yay?.media).toEqual([
			{ kind: "image", src: "bonobo-file://saved_1" },
			{ kind: "video", src: "bonobo-file://saved_1" },
			{ kind: "image", src: "bonobo-file://private/draft_1" },
			{ kind: "image", src: "bonobo-file://saved_2" },
		]);
	});

	test("gives malformed and overflow media no index", () => {
		const images = Array.from({ length: 52 }, (_, index) => `![x](bonobo-file://saved_${index})`).join(" ");
		const { prepared, content } = publish(`![bad](bonobo-file://private/..) ${images}\n`);
		const json = rich_json(content);

		expect(prepared._yay?.media).toHaveLength(50);
		const indexes = find_nodes(json, "image").map((node) => node.attrs?.index);
		expect(indexes[0]).toBeNull();
		expect(indexes.slice(1, 51)).toEqual(Array.from({ length: 50 }, (_, index) => index));
		expect(indexes.slice(51)).toEqual([null, null]);
	});

	test("never copies media alt or sources into the fallback", () => {
		const markdown = `![Secret plan.png](bonobo-file://saved_1)\n\n${"<div>".repeat(40)}x${"</div>".repeat(40)}\n`;
		const { prepared, content } = publish(markdown, [0]);

		expect(prepared._yay?.media).toEqual([]);
		expect(content).toMatchObject({ kind: "plain_text", formattingFallback: true });
		const text = content?.kind === "plain_text" ? content.text : "";
		expect(text).toContain("[image]");
		expect(text).not.toContain("Secret");
		expect(text).not.toContain("saved_1");
	});

	test("turns external media and iframes into plain links", () => {
		const markdown = [
			"![x](https://third.example/a.png)",
			'<img srcset="https://third.example/b.png 2x" src="https://third.example/c.png">',
			'<video poster="https://third.example/p.png" src="https://third.example/v.mp4"><source src="https://third.example/s.mp4"></video>',
			'<iframe src="https://www.youtube.com/embed/x"></iframe>',
			"",
		].join("\n\n");
		const { prepared, content } = publish(markdown);
		const json = rich_json(content);

		expect(prepared._yay?.media).toEqual([]);
		expect(find_nodes(json, "image")).toEqual([]);
		expect(find_nodes(json, "video")).toEqual([]);
		expect(json).not.toContain("srcset");
		expect(json).not.toContain("p.png");
		expect(json).not.toContain("s.mp4");
		const hrefs = find_nodes(json, "text")
			.flatMap((node) => node.marks ?? [])
			.map((mark) => mark.attrs?.href);
		expect(hrefs).toEqual([
			"https://third.example/a.png",
			"https://third.example/c.png",
			"https://third.example/v.mp4",
			"https://www.youtube.com/embed/x",
		]);
	});

	test("removes scripts, forms, SVG, and styles", () => {
		const json = rich_json(
			publish(
				'<script>alert(1)</script>\n\n<form><input value="v"></form>\n\n<svg><text>svg text</text></svg>\n\n<style>p{}</style>\n\nok\n',
			).content,
		);

		expect(json).not.toContain("alert");
		expect(json).not.toContain("svg text");
		expect(json).not.toContain('"v"');
		expect(json).toContain("ok");
	});

	test("keeps code and frontmatter whitespace", () => {
		const markdown = "---\ntitle: x\n  indented: y\n\n---\n\n```\n  a\n\n\tb\n```\n";
		const json = rich_json(publish(markdown).content);

		expect(find_nodes(json, "frontmatter")[0]?.content?.[0]?.text).toBe("title: x\n  indented: y\n");
		expect(find_nodes(json, "codeBlock")[0]?.content?.[0]?.text).toBe("  a\n\n\tb\n");

		const fallback = publish(`${markdown}${"<div>".repeat(40)}x${"</div>".repeat(40)}\n`).content;
		const text = fallback?.kind === "plain_text" ? fallback.text : "";
		expect(text).toContain("title: x\n  indented: y\n");
		expect(text).toContain("  a\n\n\tb\n");
	});

	test("keeps task items read-only data and table bounds", () => {
		const markdown = "- [x] done\n- [ ] open\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |\n";
		const json = rich_json(publish(markdown).content);

		expect(find_nodes(json, "taskItem").map((node) => node.attrs)).toEqual([{ checked: true }, { checked: false }]);
		expect(find_nodes(json, "tableHeader")[0]?.attrs).toEqual({
			colspan: 1,
			rowspan: 1,
			colwidth: null,
			align: "left",
		});
		expect(find_nodes(json, "tableCell")[1]?.attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null, align: "right" });
	});

	test("drops out-of-range table spans and list attributes", () => {
		const json = rich_json(
			publish(
				'<ol start="-4" type="disc"><li>a</li></ol>\n\n<table><tr><td colspan="99" rowspan="0" colwidth="10,20">x</td></tr></table>\n',
			).content,
		);

		expect(find_nodes(json, "orderedList")[0]?.attrs).toEqual({ start: 1, type: null });
		expect(find_nodes(json, "tableCell")[0]?.attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null, align: null });
	});

	test("falls back to visible text past 32 nested levels", () => {
		const content = publish(`${"<div>".repeat(33)}deep${"</div>".repeat(33)}\n`).content;

		expect(content).toEqual({ kind: "plain_text", text: "deep", formattingFallback: true });
	});

	test("refuses past 256 parser levels, 128 attributes, or 256 foreign contexts", () => {
		expect(publish(`${"<div>".repeat(257)}x\n`).prepared._nay).toBeTruthy();
		expect(publish(`${"<div>".repeat(256)}x\n`).prepared._yay).toBeTruthy();

		const attributes = Array.from({ length: 129 }, (_, index) => `a${index}="x"`).join(" ");
		expect(publish(`<p ${attributes}>x</p>\n`).prepared._nay).toBeTruthy();
		const allowed = Array.from({ length: 128 }, (_, index) => `a${index}="x"`).join(" ");
		expect(publish(`<p ${allowed}>x</p>\n\n<p ${allowed}>y</p>\n`).prepared._yay).toBeTruthy();

		expect(publish(`${"<svg/>".repeat(257)}\n`).prepared._nay).toBeTruthy();
		expect(publish(`${"<math><mi/>".repeat(129)}\n`).prepared._nay).toBeTruthy();
	});

	test("refuses 150,000 self-closing SVG tags", () => {
		expect(publish("<svg/>".repeat(150_000)).prepared._nay).toBeTruthy();
	});

	test("refuses dense unclosed emphasis before the Markdown parser runs long", () => {
		expect(publish("*a ".repeat(300_000)).prepared._nay).toBeTruthy();
	});

	test("falls back without a DOM for 100,000 newlines and refuses 900,000", () => {
		const linkedomSpy = vi.spyOn(LinkedomDOMParser.prototype, "parseFromString");

		const { content } = publish("\n".repeat(100_000));
		// Tiptap turns blank lines into empty paragraphs, so the parse charges work for each one.
		const refused = publish("\n".repeat(900_000));

		expect(linkedomSpy).not.toHaveBeenCalled();
		linkedomSpy.mockRestore();
		expect(content).toEqual({ kind: "plain_text", text: "", formattingFallback: true });
		expect(refused.prepared._nay).toBeTruthy();
	});

	test("accepts 441 KB of plain paragraphs and refuses 588 KB", () => {
		expect(publish(("x".repeat(96) + "\n\n").repeat(4_500)).prepared._yay).toBeTruthy();
		expect(publish(("x".repeat(96) + "\n\n").repeat(6_000)).prepared._nay).toBeTruthy();
	});

	test("shows decoded text for entity-heavy code", () => {
		const markdown = `\`\`\`\n${"&amp;<>".repeat(100_000)}\n\`\`\`\n`;
		const { content } = publish(markdown);

		// Each entity is its own parser text piece, so this block is past the rich size and falls back.
		expect(content).toEqual({
			kind: "plain_text",
			text: `${"&amp;<>".repeat(100_000)}\n`,
			formattingFallback: true,
		});
	});

	test("shows code whose HTML passes 4 MiB", () => {
		// Each quote becomes a 6-byte entity, so this HTML is about 4.5 MB.
		const text = `${'"'.repeat(99)}\n`.repeat(7_500);
		const { content } = publish(`\`\`\`\n${text}\`\`\`\n`);

		expect(content).toEqual({ kind: "plain_text", text, formattingFallback: true });
	});

	test("keeps 950 paragraphs rich and shows 1,050 as plain text", () => {
		const paragraphs = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`).join("\n\n");

		expect(find_nodes(rich_json(publish(paragraphs(950)).content), "paragraph")).toHaveLength(950);
		expect(publish(paragraphs(1_050)).content).toMatchObject({ kind: "plain_text", formattingFallback: true });
	});

	test("shows plain text and publishes no media past the node limit after the DOM step", () => {
		// Each list item also gets a paragraph node, so this passes the DOM check but not the node limit.
		const list = Array.from({ length: 700 }, (_, index) => `- i${index}`).join("\n");
		const { prepared, content } = publish(`![a](bonobo-file://saved_1)\n\n${list}\n`);

		expect(prepared._yay?.media).toEqual([]);
		expect(content).toMatchObject({ kind: "plain_text", formattingFallback: true });
	});

	test("refuses text past the public size after redaction", () => {
		// The labels are longer than the references, so this grows past the cap.
		const text = "bonobo-file:// ".repeat(60_000);

		expect(publish(`${text}\n`).prepared._nay).toBeTruthy();
		expect(files_share_rich_text_prepare({ text, textKind: "plain_text" })._nay).toBeTruthy();
	});

	test("redacts hundreds of split references in one paragraph", () => {
		const markdown = `${"bonobo-**file://saved_1** ".repeat(600)}\n`;
		const json = rich_json(publish(markdown).content);

		expect(json).not.toContain("saved_1");
		expect(json.split("[file reference]").length - 1).toBe(600);
	});

	test("redacts plain text files", () => {
		const prepared = files_share_rich_text_prepare({
			// Hidden syntax keeps the lines before it and the text after its `)`.
			text: 'x bonobo-file://saved_1 <span data-lb-thread-id="t_1"> y\n[a](bonobo-file://saved_2) after\n',
			textKind: "plain_text",
		});

		expect(prepared._yay?.draft).toEqual({
			kind: "plain_text",
			text: "x [file reference] <span [comment reference]> y\n[file reference] after\n",
			formattingFallback: false,
		});
	});

	test("never cuts a character in half when it hides a long comment attribute", () => {
		const prepared = files_share_rich_text_prepare({
			text: `before data-lb-thread-id=${"a".repeat(255)}😀 after\n`,
			textKind: "plain_text",
		});

		expect(prepared._yay?.draft).toMatchObject({ kind: "plain_text", text: "before [comment reference] after\n" });
	});

	test("hides the file name in image syntax that stayed text", () => {
		// The editor writes an image right after a typed URL like this, and Marked reads it as part of the URL.
		const markdown =
			"Source: https://example.com/report![salary.png](bonobo-file://saved_1)\n\n" +
			'`<img src="bonobo-file://saved_2" alt="budget.png" width="300">`\n\n' +
			// The URL's link address runs into the name, up to the space.
			"Guide: https://example.com/guide![pay rise.png](bonobo-file://saved_3)\n\n" +
			'`![team \\[2026\\] bonus.png](bonobo-file://saved_4 "Q3 (draft) layoffs")`\n\n' +
			// Marked removes the escapes after a URL, so the brackets in the name pair up wrongly.
			"Plan: https://example.com/plan![Q3 plan\\] hiring \\[draft.png](bonobo-file://saved_5)\n\n" +
			// Typed link syntax before the image takes its `![` and part of its name.
			"[docs](https://example.com/![severance-list).png](bonobo-file://saved_6)\n\n" +
			// A file name has no length limit.
			`Long: https://example.com/long![${"payroll-".repeat(150)}.png](bonobo-file://saved_7)\n\n` +
			"`![alpha.png](bonobo-file://saved_8)` keep this text `![beta.png](bonobo-file://saved_9)`\n\n" +
			// A long `alt` or title comes after the address.
			`\`<img src="bonobo-file://saved_10" alt="${"overtime-".repeat(150)}.png" width="300">\`\n\n` +
			`\`![a.png](bonobo-file://saved_11 "${"memo-".repeat(250)}")\`\n\n` +
			// A broken reference earlier on the line must not end its range inside the later syntax.
			'`](bonobo-file://saved_12 <img src="bonobo-file://saved_13" alt="Salary (2026) Bob Smith.png">`\n\n' +
			'`](bonobo-file://saved_15 ![a](bonobo-file://saved_16 "Review (2026) Dave Brown")`\n\n' +
			'`data-lb-thread-id=![a](bonobo-file://saved_14 "Carol Jones layoffs")`\n\n' +
			"Old syntax: ](bonobo-file://saved_18 see https://example.com![Q3 (final) Frank Green \\[v2\\].png](bonobo-file://saved_19)\n\n" +
			// A lone backtick ends a code span inside the tag, and Marked decodes `&gt;` to `>`.
			'Press the ` key, then see <img src="bonobo-file://saved_17" alt="Q3 ` plan &gt; Erin Hall.png" width="320">\n\n' +
			// The editor saves the first line again like this. The address now follows `)(`, not `](`.
			'Chart (source: [https://example.com/report)![Hana Ito.png]](https://example.com/report)!%5BHana Ito.png%5D)(bonobo-file://saved_20 "Q3 plan") end\n\n' +
			// Each line of a code block must find its own line end.
			'```\n![a](bonobo-file://saved_21 "Ann Lee")\n<img src="bonobo-file://saved_22" alt="Gina Park.png">\nsee https://example.com/x!%5BKim Lee) end\nend\n```\n\n' +
			// A file copy saves the first line twice. The URL takes in the image and the start of its name.
			"Copy: [https://example.com/report](bonobo-file://saved_23)![Ivan](https://example.com/report!%5BIvan)[ Petrov.png](bonobo-file://saved_23) end\n\n" +
			"Moved: see https://example.com/x!%5BJune Park) end\n\n" +
			// After more saves, the name starts in one link's label and the file address is in a later link's address.
			"Chart (source: [https://example.com/report)![LiaMoss]](https://example.com/report)!%5BLiaMoss%5C%5D)(x.png[https://example.com/y](bonobo-file://saved_24)](https://example.com/y%5D(bonobo-file://saved_24))\n\n" +
			// A typed `[1]` after the file link ends up after the name.
			"See the plan ([https://example.com/r)NinaRoss.pdf[1]](https://example.com/r)%5BNinaRoss.pdf%5D(bonobo-file://saved_25)%5B1%5D) for details.\n\n" +
			// An image between the name and the file address.
			"(source: [[https://example.com/r)OmarDiaz.pdf](https://example.com/r)![a.png](bonobo-file://saved_26)[%5BOmarDiaz.pdf%5D(bonobo-file://saved_27)\n";
		const json = rich_json(publish(markdown).content);
		const fallback = publish(`${markdown}${"<div>".repeat(40)}x${"</div>".repeat(40)}\n`).content;
		const fallbackText = fallback?.kind === "plain_text" ? fallback.text : "";

		expect(json).not.toContain("salary");
		expect(json).not.toContain("budget");
		expect(json).not.toContain("pay");
		expect(json).not.toContain("team");
		expect(json).not.toContain("layoffs");
		expect(json).not.toContain("hiring");
		expect(json).not.toContain("severance");
		expect(json).not.toContain("payroll");
		expect(json).not.toContain("alpha");
		expect(json).not.toContain("beta");
		expect(json).not.toContain("overtime");
		expect(json).not.toContain("memo");
		expect(json).not.toContain("Bob Smith");
		expect(json).not.toContain("Dave Brown");
		expect(json).not.toContain("Carol");
		expect(json).not.toContain("Frank Green");
		expect(json).not.toContain("Erin Hall");
		expect(json).not.toContain("Hana Ito");
		expect(json).not.toContain("Gina Park");
		expect(json).not.toContain("Ivan");
		expect(json).not.toContain("June");

		// The link ends at the space, so the rest of the name follows it.
		expect(json).not.toContain("Park");

		expect(json).not.toContain("Kim");
		expect(json).not.toContain("LiaMoss");
		expect(json).not.toContain("NinaRoss");
		expect(json).not.toContain("OmarDiaz");
		expect(fallback).toMatchObject({ kind: "plain_text", formattingFallback: true });
		expect(fallbackText).not.toContain("NinaRoss");
		expect(fallbackText).not.toContain("OmarDiaz");
	});

	test("keeps an image that shares a line with a hidden reference", () => {
		const json = rich_json(
			publish("Typed bonobo-file://saved_1 and ![photo](bonobo-file://saved_2) after\n", [0]).content,
		);

		expect(find_nodes(json, "image").map((node) => node.attrs)).toEqual([{ index: 0, alt: "photo" }]);
	});

	test("keeps typed text that looks like an open tag as text", () => {
		// An unclosed `<code>` makes Marked stop escaping text. Then `a<b` becomes a tag and takes in the text
		// after it.
		const json = rich_json(
			publish("Wrap it in the <code> element.\n\nUse a<b and see [Budget.pdf](bonobo-file://saved_1) now\n").content,
		);

		expect(json).toContain("Use a<b and see [file reference] now");
		expect(json).not.toContain("Budget");
	});

	test("hides a file link name when typed HTML takes in the link's tag", () => {
		// The link's address ends up in an attribute. Then only the label is left to hide.
		const shapes = [
			'<div x="\n\nsee [Budget.pdf](bonobo-file://saved_1) end\n',
			"note <b x='a b=\"'> then [Budget.pdf](bonobo-file://saved_1) end\n",
		];

		for (const markdown of shapes) {
			expect(JSON.stringify(publish(markdown))).not.toContain("Budget");
		}
	});

	test("removes the text after an unclosed xmp tag", () => {
		// The text after it would be the page's HTML source, where the visible-text rules cannot hide names.
		const json = rich_json(publish("Start here\n\nWrap old code in the <xmp> tag.\n\nlater text\n").content);

		expect(json).toContain("Start here");
		expect(json).not.toContain("later text");
	});

	test("drops the alt an image gets from a tag it takes in", () => {
		// The open quote takes in the next image's tag, so the shared image would show that image's name.
		const hiddenImage = '<img src="bonobo-file://saved_2" alt="Secret Name" width="300">';
		const shapes = [
			'<div><img src="bonobo-file://saved_1" q="\n\n![Secret Name](bonobo-file://saved_2)\n',
			`<div><img src="bonobo-file://saved_1" q="a" q="\n${hiddenImage}\n</div>`,
			`<div><img src="bonobo-file://saved_1" src="\n${hiddenImage}\n</div>`,
		];

		for (const markdown of shapes) {
			const json = rich_json(publish(markdown, [0]).content);
			expect(find_nodes(json, "image").map((node) => node.attrs)).toEqual([{ index: 0, alt: null }]);
			expect(json).not.toContain("Secret");
		}
	});

	test("keeps a ++ pair as text when it holds a typed tag", () => {
		// The pair would take in the start of the name, and the typed tag would split it from the rest.
		const shapes = [
			"Notes on C++ and the <p> tag  \nSee [Smith C++ Smith.pdf](bonobo-file://saved_1)\n",
			'C++ and <p> <img src="bonobo-file://saved_1" alt="Smith C++ Smith">\n',
		];

		for (const markdown of shapes) {
			expect(JSON.stringify(publish(markdown).content)).not.toContain("Smith");
		}
	});
});

describe("files_share_rich_text_finish", () => {
	test("keeps redacted alt only for available media", () => {
		const markdown =
			"![Secret plan.png](bonobo-file://saved_1) ![Other bonobo-file://saved_9](bonobo-file://saved_2) ![Hidden.png](bonobo-file://saved_3)\n";
		const json = rich_json(publish(markdown, [1]).content);
		const images = find_nodes(json, "image");

		expect(images.map((node) => node.attrs)).toEqual([
			{ index: 0, alt: null },
			{ index: 1, alt: "Other [file reference]" },
			{ index: 2, alt: null },
		]);
		expect(json).not.toContain("Secret plan");
		expect(json).not.toContain("Hidden");
		expect(json).not.toContain("saved_");
	});
});

describe("files_share_rich_text_parse_json", () => {
	test("reads the prepared JSON back exactly", () => {
		const json = rich_json(publish("# a\n\n- [x] b\n\n| c |\n| - |\n| d |\n").content);
		const doc = files_share_rich_text_parse_json(json);

		expect(JSON.stringify(doc?.toJSON())).toBe(json);
	});

	test("keeps a link whose host the visitor's URL parser refuses", () => {
		const json = rich_json(publish("[site](http://xn--9hbc.com/) text\n").content);
		expect(json).toContain('"href":"http://xn--9hbc.com/"');
		// Chrome and Node accept this host. The URL standard refuses it, like a stricter browser would.
		vi.stubGlobal(
			"URL",
			class extends URL {
				constructor(url: string | URL, base?: string | URL) {
					if (String(url).includes("xn--9hbc")) {
						throw new TypeError("Invalid URL");
					}
					super(url, base);
				}
			},
		);
		const doc = files_share_rich_text_parse_json(json);
		vi.unstubAllGlobals();

		expect(JSON.stringify(doc?.toJSON())).toBe(json);
	});

	test("refuses broken JSON, unknown nodes, invalid content, and invalid attributes", () => {
		expect(files_share_rich_text_parse_json("{")).toBeNull();
		expect(files_share_rich_text_parse_json('{"type":"doc","content":[{"type":"iframe"}]}')).toBeNull();
		expect(files_share_rich_text_parse_json('{"type":"doc","content":[{"type":"text","text":"x"}]}')).toBeNull();
		expect(
			files_share_rich_text_parse_json(
				'{"type":"doc","content":[{"type":"heading","attrs":{"level":9,"textAlign":null},"content":[{"type":"text","text":"x"}]}]}',
			),
		).toBeNull();
		expect(
			files_share_rich_text_parse_json(
				'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"image","attrs":{"index":50,"alt":null}}]}]}',
			),
		).toBeNull();
		expect(
			files_share_rich_text_parse_json(
				'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"javascript:x"}}]}]}]}',
			),
		).toBeNull();
	});
});
