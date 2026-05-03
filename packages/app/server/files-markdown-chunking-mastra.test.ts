import { describe, expect, test } from "vitest";
import {
	files_chunk_has_bitmask_flag,
	files_chunk_BITMASK_FLAGS,
	files_chunk_markdown,
} from "./files-markdown-chunking-mastra.ts";

describe("files_chunk_markdown", () => {
	test("builds chunk metadata and flags", async () => {
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

		const chunks = await files_chunk_markdown(markdownContent, {
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
			expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
			expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
			expect(markdownContent.slice(chunk.startIndex, chunk.endIndex)).toBe(chunk.markdownChunk);
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
			chunks._yay.some((chunk) => files_chunk_has_bitmask_flag(chunk.chunkFlags, files_chunk_BITMASK_FLAGS.isCode)),
		).toBe(true);
		expect(
			chunks._yay.some((chunk) => files_chunk_has_bitmask_flag(chunk.chunkFlags, files_chunk_BITMASK_FLAGS.isTable)),
		).toBe(true);
		expect(
			chunks._yay.some(
				(chunk) =>
					files_chunk_has_bitmask_flag(chunk.chunkFlags, files_chunk_BITMASK_FLAGS.isCode) &&
					(files_chunk_has_bitmask_flag(chunk.chunkFlags, files_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove) ||
						files_chunk_has_bitmask_flag(chunk.chunkFlags, files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow)),
			),
		).toBe(true);
	});

	test("returns empty chunks for empty markdown", async () => {
		const chunks = await files_chunk_markdown("");
		if (chunks._nay) {
			throw new Error("Expected markdown chunking to succeed for empty markdown", {
				cause: chunks._nay,
			});
		}

		expect(chunks._yay).toEqual([]);
	});

	test("records source indexes for chunks split within one long line", async () => {
		const markdownContent = "x".repeat(1500);

		const chunks = await files_chunk_markdown(markdownContent, {
			maxChunkSize: 1200,
		});
		if (chunks._nay) {
			throw new Error("Expected markdown chunking to succeed for a long single line", {
				cause: chunks._nay,
			});
		}

		expect(
			chunks._yay.map((chunk) => ({
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				length: chunk.markdownChunk.length,
			})),
		).toEqual([
			{ startIndex: 0, endIndex: 1200, length: 1200 },
			{ startIndex: 1200, endIndex: 1500, length: 300 },
		]);
		expect(chunks._yay.every((chunk) => chunk.lineStart === 1 && chunk.lineEnd === 1)).toBe(true);
	});

	test("handles consecutive blank lines (regression)", async () => {
		// Tiptap's markdown serializer can emit multiple blank lines (>=2) between blocks,
		// which produce adjacent separator matches in the chunker. Previously the 'start'
		// separatorPosition branch dropped the empty segment, yielding a chunk whose text
		// was no longer a substring of the source and a -1 startIndex downstream.
		const markdownContent = "# Welcome\n\nYou can start editing your document here.\n\n\n\ntest\n";

		const chunks = await files_chunk_markdown(markdownContent);
		if (chunks._nay) {
			throw new Error("Expected markdown chunking to succeed for consecutive blank lines", {
				cause: chunks._nay,
			});
		}

		expect(chunks._yay.length).toBeGreaterThan(0);
		for (const chunk of chunks._yay) {
			expect(markdownContent.slice(chunk.startIndex, chunk.endIndex)).toBe(chunk.markdownChunk);
			expect(chunk.lineStart).toBeGreaterThanOrEqual(1);
			expect(chunk.lineEnd).toBeGreaterThanOrEqual(chunk.lineStart);
		}
	});
});
