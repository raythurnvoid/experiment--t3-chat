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

	test("chunks reconstruct the source exactly and tile it contiguously", async () => {
		// The chunk-backed reader (convex/files_nodes.ts read_committed_file_chunks_line_range) relies
		// on chunks being verbatim source substrings that tile the document with no gaps, so merging
		// the chunks overlapping a line range reproduces that portion exactly. Guard that invariant.
		const sections = Array.from(
			{ length: 12 },
			(_, i) =>
				`## Section ${i + 1}\n\nParagraph ${i + 1} with searchable words alpha-${i} beta gamma delta epsilon zeta.\n\n` +
				"```ts\n" +
				`const value${i} = "x".repeat(${i});\n` +
				"```",
		);
		const markdownContent = `# Title\n\n${sections.join("\n\n")}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`;

		const chunks = await files_chunk_markdown(markdownContent, { maxChunkSize: 120 });
		if (chunks._nay) {
			throw new Error("Expected markdown chunking to succeed", { cause: chunks._nay });
		}

		expect(chunks._yay.length).toBeGreaterThan(3);
		// Verbatim: every chunk is the exact source slice at its recorded offsets.
		for (const chunk of chunks._yay) {
			expect(markdownContent.slice(chunk.startIndex, chunk.endIndex)).toBe(chunk.markdownChunk);
		}
		// Contiguous: each chunk starts exactly where the previous ended (no dropped bytes).
		for (let i = 1; i < chunks._yay.length; i++) {
			expect(chunks._yay[i]!.startIndex).toBe(chunks._yay[i - 1]!.endIndex);
		}
		// Concatenating all chunk text reproduces the whole document.
		expect(chunks._yay.map((chunk) => chunk.markdownChunk).join("")).toBe(markdownContent);
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
