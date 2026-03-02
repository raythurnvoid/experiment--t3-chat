import { expect, test } from "vitest";
import {
	pages_chunk_has_bitmask_flag,
	pages_chunk_BITMASK_FLAGS,
	pages_chunk_markdown,
} from "./pages-markdown-chunking-mastra.ts";

test("pages_markdown_chunk_with_mastra: builds chunk metadata and flags", async () => {
	const markdownContent = [
		"# Page title",
		"",
		"Intro paragraph with searchable text.",
		"Read [docs link](https://example.com/docs) for details.",
		"",
		"```ts",
		'const veryLongLine001 = "alpha alpha alpha alpha alpha alpha alpha alpha";',
		'const veryLongLine002 = "beta beta beta beta beta beta beta beta";',
		'const veryLongLine003 = "gamma gamma gamma gamma gamma gamma gamma";',
		'const veryLongLine004 = "delta delta delta delta delta delta delta";',
		"```",
		"",
		"| Name | Value |",
		"| --- | --- |",
		"| one | 1 |",
		"| two | 2 |",
		"",
		"Tail paragraph.",
	].join("\n");

	const chunks = await pages_chunk_markdown(markdownContent, {
		maxChunkSize: 140,
	});
	if (chunks._nay) {
		throw new Error("Expected markdown chunking to succeed", {
			cause: chunks._nay,
		});
	}

	expect(chunks._yay.length).toBeGreaterThan(1);

	expect(chunks._yay.map((chunk) => chunk.chunkIndex)).toEqual(chunks._yay.map((_, index) => index));

	for (const chunk of chunks._yay) {
		expect(chunk.lineStart).toBeGreaterThanOrEqual(1);
		expect(chunk.lineEnd).toBeGreaterThanOrEqual(chunk.lineStart);
		expect(chunk.plainTextChunk).not.toContain("```");
	}

	expect(chunks._yay.some((chunk) => chunk.plainTextChunk.includes("docs link"))).toBe(true);
	expect(chunks._yay.some((chunk) => chunk.plainTextChunk.includes("Name"))).toBe(true);
	expect(chunks._yay.some((chunk) => chunk.plainTextChunk.includes("one"))).toBe(true);
	expect(chunks._yay.some((chunk) => chunk.plainTextChunk.includes("const veryLongLine001"))).toBe(true);
	expect(chunks._yay.some((chunk) => chunk.plainTextChunk.includes("https://example.com/docs"))).toBe(false);

	expect(
		chunks._yay.some((chunk) => pages_chunk_has_bitmask_flag(chunk.chunkFlags, pages_chunk_BITMASK_FLAGS.isCode)),
	).toBe(true);
	expect(
		chunks._yay.some((chunk) => pages_chunk_has_bitmask_flag(chunk.chunkFlags, pages_chunk_BITMASK_FLAGS.isTable)),
	).toBe(true);
	expect(
		chunks._yay.some(
			(chunk) =>
				pages_chunk_has_bitmask_flag(chunk.chunkFlags, pages_chunk_BITMASK_FLAGS.isCode) &&
				(pages_chunk_has_bitmask_flag(chunk.chunkFlags, pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove) ||
					pages_chunk_has_bitmask_flag(chunk.chunkFlags, pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow)),
		),
	).toBe(true);
});

test("pages_markdown_chunk_with_mastra: returns empty chunks for empty markdown", async () => {
	const chunks = await pages_chunk_markdown("");
	if (chunks._nay) {
		throw new Error("Expected markdown chunking to succeed for empty markdown", {
			cause: chunks._nay,
		});
	}

	expect(chunks._yay).toEqual([]);
});
