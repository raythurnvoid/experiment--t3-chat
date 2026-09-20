import { describe, expect, test } from "vitest";
import { files_upload_content_from_bytes } from "./files-upload-content.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";

describe("files_upload_content_from_bytes", () => {
	test("normalizes plain text once and builds the same document text", () => {
		const bytes = new TextEncoder().encode("\uFEFFone\r\ntwo\r");
		const result = files_upload_content_from_bytes({ bytes, contentType: "text/plain" });
		if (result.kind !== "text") throw new Error("Expected editable text");
		expect(result).toMatchObject({
			text: "one\ntwo\n",
			textKind: "plain_text",
			contentType: "text/plain;charset=utf-8",
		});
		const doc = files_yjs_doc_create_from_array_buffer_update(result.snapshotUpdate);
		try {
			expect(files_yjs_doc_get_text({ yjsDoc: doc, rootKind: result.textKind })._yay).toBe(result.text);
		} finally {
			doc.destroy();
		}
	});

	test.each([
		{ name: "explicit binary MIME", bytes: new TextEncoder().encode("hello"), contentType: "application/octet-stream" },
		{ name: "invalid UTF-8", bytes: new Uint8Array([0xc0, 0xaf]), contentType: "text/plain" },
		{ name: "NUL", bytes: new Uint8Array([0x61, 0, 0x62]), contentType: "text/plain" },
		{
			name: "text over its byte cap",
			bytes: new Uint8Array(files_MAX_TEXT_CONTENT_BYTES + 1).fill(0x61),
			contentType: "text/plain",
		},
	])("keeps $name as unchanged bytes", ({ bytes, contentType }) => {
		const original = bytes.slice();
		expect(files_upload_content_from_bytes({ bytes, contentType })).toEqual({ kind: "stored" });
		expect(bytes).toEqual(original);
	});

	test("uses Markdown MIME for rich text and accepts empty plain text", () => {
		expect(
			files_upload_content_from_bytes({ bytes: new TextEncoder().encode("# Hello"), contentType: "text/markdown" }),
		).toMatchObject({ kind: "text", textKind: "rich_text" });
		expect(files_upload_content_from_bytes({ bytes: new Uint8Array(), contentType: "text/plain" })).toMatchObject({
			kind: "text",
			text: "",
			textKind: "plain_text",
		});
	});
});
