import { describe, expect, test } from "vitest";
import { files_chunk_plain_text } from "./files-plain-text-chunking.ts";

/**
 * Concatenating every chunk in order must reproduce the input exactly. This is the byte-exactness
 * contract search/read/`head`/`tail` rely on, and the reason contiguity
 * (`startIndex_n === endIndex_{n-1}`) is asserted with it.
 */
function expect_chunks_tile_input(text: string, chunks: ReturnType<typeof files_chunk_plain_text>) {
	let previousEnd = 0;
	for (const chunk of chunks) {
		expect(chunk.startIndex).toBe(previousEnd);
		expect(text.slice(chunk.startIndex, chunk.endIndex)).toBe(chunk.plainTextChunk);
		expect(chunk.textChunk).toBe(chunk.plainTextChunk);
		previousEnd = chunk.endIndex;
	}
	expect(previousEnd).toBe(text.length);
	expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toBe(text);
}

describe("files_chunk_plain_text", () => {
	test("returns no chunks for empty input", () => {
		expect(files_chunk_plain_text("")).toEqual([]);
	});

	test("packs whole short lines into windows up to the cap", () => {
		const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 64 });

		expect(chunks.length).toBeGreaterThan(1);
		expect_chunks_tile_input(text, chunks);
		for (const chunk of chunks) {
			expect(chunk.plainTextChunk.length).toBeLessThanOrEqual(64);
			// Whole-line packing: every window of short lines still ends at a line boundary.
			expect(chunk.plainTextChunk.endsWith("\n")).toBe(true);
			expect(chunk.chunkFlags).toBe(0);
		}
		expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
	});

	test("splits a 600 KB single-line document into many capped chunks", () => {
		// The minified-JSON shape: one line, no newline anywhere.
		const text = '{"key":"' + "v".repeat(600_000) + '"}';
		const chunks = files_chunk_plain_text(text);

		// The whole point of the mid-line split: the old chunker emitted ONE 600 KB chunk here,
		// which blew Convex's per-document limit inside the infinite-retry workpool.
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks.length).toBe(Math.ceil(text.length / 1200));
		expect_chunks_tile_input(text, chunks);
		for (const chunk of chunks) {
			expect(chunk.plainTextChunk.length).toBeLessThanOrEqual(1200);
			// Every piece of the split line reports the same single line number.
			expect(chunk.lineStart).toBe(chunk.lineEnd);
			expect(chunk.lineStart).toBe(chunks[0]!.lineStart);
		}
	});

	test("keeps the cap at 1200 by default", () => {
		const text = "x".repeat(1200) + "\n";
		// Exactly cap-sized content (with its newline the line is 1201 units, so it splits once).
		const chunks = files_chunk_plain_text(text);
		expect(chunks.length).toBe(2);
		expect(chunks[0]!.plainTextChunk.length).toBe(1200);
		expect_chunks_tile_input(text, chunks);
	});

	test("a split line's tail packs together with the following short lines", () => {
		const text = "a".repeat(25) + "\nshort one\nshort two\n";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 20 });

		expect_chunks_tile_input(text, chunks);
		// Piece one: 20 units of the long line. Piece two: the 6-unit tail placeholder window that
		// then packs the following short lines behind it.
		expect(chunks[0]!.plainTextChunk).toBe("a".repeat(20));
		expect(chunks[0]!.lineStart).toBe(chunks[0]!.lineEnd);
		expect(chunks[1]!.plainTextChunk.startsWith("a".repeat(5) + "\n")).toBe(true);
	});

	test("never cuts between the two halves of an emoji at the cap boundary", () => {
		// Each emoji is two UTF-16 code units. A cap of 5 lands the cut inside the third emoji,
		// so the chunker must move the cut back by one unit.
		const text = "😀😀😀😀😀";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 5 });

		expect_chunks_tile_input(text, chunks);
		for (const chunk of chunks) {
			// A piece that starts with a low surrogate or ends with a high surrogate holds half a
			// character and would not survive encode/decode.
			const firstCodeUnit = chunk.plainTextChunk.charCodeAt(0);
			const lastCodeUnit = chunk.plainTextChunk.charCodeAt(chunk.plainTextChunk.length - 1);
			expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
			expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
		}
	});

	test("a pathological cap of 1 still terminates on surrogate pairs", () => {
		const text = "😀😀";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 1 });

		expect_chunks_tile_input(text, chunks);
		expect(chunks.length).toBe(2);
	});

	test("keeps the last chunk exact when the input has no trailing newline", () => {
		const text = "first line\nsecond line without newline";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 16 });

		expect_chunks_tile_input(text, chunks);
		expect(chunks[chunks.length - 1]!.plainTextChunk.endsWith("newline")).toBe(true);
	});

	test("reports line numbers from the offset math for packed and split chunks", () => {
		const text = "one\n" + "b".repeat(50) + "\nthree\n";
		const chunks = files_chunk_plain_text(text, { maxChunkSize: 20 });

		expect_chunks_tile_input(text, chunks);
		// Line 1 packs alone (the next line would overflow); line 2 splits into pieces that all
		// report lineStart === lineEnd === 2; line 3 follows.
		expect(chunks[0]!.lineStart).toBe(1);
		const middlePieces = chunks.filter((chunk) => chunk.lineStart === 2 && chunk.lineEnd === 2);
		expect(middlePieces.length).toBeGreaterThanOrEqual(2);
		expect(chunks[chunks.length - 1]!.lineEnd).toBe(3);
	});
});
