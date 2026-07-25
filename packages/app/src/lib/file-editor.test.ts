import { describe, expect, test } from "vitest";
import {
	file_editor_SIZE_MEASURE_CHARS,
	file_editor_SIZE_WARN_BYTES,
	file_editor_get_content_too_large_message,
	file_editor_get_size_badge_text,
	file_editor_get_size_status_message,
	file_editor_should_block_growth,
} from "./file-editor.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_format_size } from "../../shared/files.ts";

describe("editor size cap thresholds", () => {
	test("warns before reaching the cap", () => {
		expect(file_editor_SIZE_WARN_BYTES).toBeLessThan(files_MAX_TEXT_CONTENT_BYTES);
	});

	test("starts measuring before the warning point", () => {
		// The character count is a lower bound on the Markdown byte size, so the measure gate
		// must sit below the warn point or the badge could never appear in time.
		expect(file_editor_SIZE_MEASURE_CHARS).toBeLessThan(file_editor_SIZE_WARN_BYTES);
	});
});

describe("file_editor_get_size_badge", () => {
	test("stays hidden while the content is well under the cap", () => {
		expect(file_editor_get_size_badge_text(null)).toBeNull();
		expect(file_editor_get_size_badge_text(0)).toBeNull();
		expect(file_editor_get_size_badge_text(file_editor_SIZE_WARN_BYTES - 1)).toBeNull();
	});

	test("warns from the threshold up to the cap", () => {
		const badge = file_editor_get_size_badge_text(file_editor_SIZE_WARN_BYTES);

		expect(badge?.isOverCap).toBe(false);
		expect(badge?.label).toContain("/");
	});

	test("reports over the cap", () => {
		expect(file_editor_get_size_badge_text(files_MAX_TEXT_CONTENT_BYTES)?.isOverCap).toBe(false);
		expect(file_editor_get_size_badge_text(files_MAX_TEXT_CONTENT_BYTES + 1)?.isOverCap).toBe(true);
	});
});

describe("file_editor_get_size_status_message", () => {
	test("stays quiet while the content is well under the cap", () => {
		expect(file_editor_get_size_status_message({ byteSize: null, blocks: "editing" })).toBe("");
		expect(file_editor_get_size_status_message({ byteSize: 0, blocks: "editing" })).toBe("");
	});

	test("says the same thing for every size inside a state so it does not repeat on each byte", () => {
		const first = file_editor_get_size_status_message({ byteSize: file_editor_SIZE_WARN_BYTES, blocks: "editing" });
		const later = file_editor_get_size_status_message({
			byteSize: files_MAX_TEXT_CONTENT_BYTES,
			blocks: "editing",
		});

		expect(first).not.toBe("");
		expect(later).toBe(first);
	});

	test("names what is blocked once over the cap", () => {
		const overCap = files_MAX_TEXT_CONTENT_BYTES + 1;

		expect(file_editor_get_size_status_message({ byteSize: overCap, blocks: "editing" })).toContain("editing");
		expect(file_editor_get_size_status_message({ byteSize: overCap, blocks: "saving" })).toContain("save");
	});
});

describe("file_editor_get_content_too_large_message", () => {
	test("names the size, the limit and how much to remove", () => {
		const message = file_editor_get_content_too_large_message(files_MAX_TEXT_CONTENT_BYTES + 100_000);

		expect(message).toContain(files_format_size(files_MAX_TEXT_CONTENT_BYTES + 100_000));
		expect(message).toContain(files_format_size(files_MAX_TEXT_CONTENT_BYTES));
		expect(message).toContain(`Remove about ${files_format_size(100_000)}`);
	});

	test("says the saved copy is stale, not that editing stopped", () => {
		// The live document keeps syncing while the file is over the cap. Only the saved copy
		// falls behind, and that is what downloads, search and the tools read.
		const message = file_editor_get_content_too_large_message(files_MAX_TEXT_CONTENT_BYTES + 1);

		expect(message).toContain("saved copy");
		expect(message).not.toContain("editing");
	});
});

describe("file_editor_should_block_growth", () => {
	const base = {
		isOverCap: true,
		isRemoteChange: false,
		docSizeBefore: 100,
		docSizeAfter: 101,
	};

	test("blocks local growth while over the cap", () => {
		expect(file_editor_should_block_growth(base)).toBe(true);
	});

	test("allows everything while under the cap", () => {
		expect(file_editor_should_block_growth({ ...base, isOverCap: false })).toBe(false);
	});

	test("allows remote changes so collaboration never desyncs", () => {
		expect(file_editor_should_block_growth({ ...base, isRemoteChange: true })).toBe(false);
	});

	test("allows deletions so the user can get back under the cap", () => {
		expect(file_editor_should_block_growth({ ...base, docSizeAfter: 99 })).toBe(false);
	});

	test("allows changes that keep the same size", () => {
		expect(file_editor_should_block_growth({ ...base, docSizeAfter: 100 })).toBe(false);
	});
});
