import { defaultTreeAdapter, parse } from "parse5";
import { describe, expect, test } from "vitest";
import { file_preview_create_document, file_preview_DocumentMessageSchema } from "./document";

const loadId = "7d0c56c4-07e1-457a-9b70-dcf7c9f43010";

describe("file_preview_create_document", () => {
	test("keeps the full document and script order with the relay first in head", () => {
		const source = `<!doctype html><html lang="it" data-value="1"><head><title>Brief</title><style>body { color: red }</style><script>const config = 1;</script><script type="module">await Promise.resolve();</script></head><body class="brief"><button>Run</button></body></html>`;
		const output = file_preview_create_document(source, loadId, "https://preview.example");
		expect(output.startsWith('<!doctype html><html lang="it" data-value="1"><head><script>(() => {')).toBe(true);
		expect(output).toContain('<meta name="referrer" content="no-referrer"><title>Brief</title>');
		expect(output).toContain(
			'<style>body { color: red }</style><script>const config = 1;</script><script type="module">await Promise.resolve();</script>',
		);
		expect(output).toContain('<body class="brief"><button>Run</button></body>');
	});

	test("preserves a legacy doctype and its browser layout mode", () => {
		const doctype = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">';
		const source = `${doctype}<p>Legacy layout</p>`;
		const output = file_preview_create_document(source, loadId, "https://preview.example");
		expect(output.startsWith(doctype)).toBe(true);
		expect(parse(output).mode).toBe(parse(source).mode);
	});

	test("uses active-document noscript parsing and keeps a missing doctype missing", () => {
		const output = file_preview_create_document(
			"<noscript><p>Fallback</p></noscript><p>Content</p>",
			loadId,
			"https://preview.example",
		);
		expect(output.startsWith("<html><head><script>")).toBe(true);
		expect(output).toContain("<noscript><p>Fallback</p></noscript>");
	});

	test("does not turn relay configuration into HTML", () => {
		const output = file_preview_create_document(
			"<p>Content</p>",
			loadId,
			"https://preview.example/</script><script>bad()</script>",
		);
		const document = parse(output);
		const root = document.childNodes.find((node) => defaultTreeAdapter.isElementNode(node));
		if (!root || !defaultTreeAdapter.isElementNode(root)) throw new Error("Missing root");
		const head = root.childNodes.find((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "head");
		if (!head || !defaultTreeAdapter.isElementNode(head)) throw new Error("Missing head");
		expect(
			head.childNodes.filter((node) => defaultTreeAdapter.isElementNode(node) && node.tagName === "script"),
		).toHaveLength(1);
	});
});

describe("file_preview_DocumentMessageSchema", () => {
	test("keeps child status separate from host commands", () => {
		expect(
			file_preview_DocumentMessageSchema.safeParse({ protocol: "bonobo-file-preview-document", type: "loaded", loadId })
				.success,
		).toBe(true);
		expect(
			file_preview_DocumentMessageSchema.safeParse({ protocol: "bonobo-file-preview", type: "loaded", loadId }).success,
		).toBe(false);
		expect(
			file_preview_DocumentMessageSchema.safeParse({
				protocol: "bonobo-file-preview-document",
				type: "error",
				loadId,
				message: "x".repeat(501),
			}).success,
		).toBe(false);
	});
});
