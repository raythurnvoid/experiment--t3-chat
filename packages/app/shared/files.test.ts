import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Lexer, Tokenizer } from "marked";
import {
	files_collect_protected_descendant_ids,
	files_derive_tree_path_for_file_node,
	files_find_file_stem_end_index,
	files_get_read_only_capabilities,
	files_get_read_only_row_labels,
	files_default_text_shape_for_name,
	files_editable_text_content_type_of,
	files_editable_text_shape_of,
	files_get_signed_download_serving,
	files_guess_content_type_from_name,
	files_monaco_language_id_of_content_type,
	files_normalize_content_type,
	files_parse_content_type,
	files_resolve_upload_content_type,
	files_yjs_root_kind_of_content_type,
	files_get_upload_pipeline_state,
	files_get_normalized_node_path_segments,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_normalize_markdown_name,
	files_normalize_browser_download_name,
	files_normalize_file_rename_name,
	files_normalize_special_node_path,
	files_normalize_upload_file_name,
	files_normalize_text_document_input,
	files_u8_equals,
	files_normalize_name_input,
	files_normalize_name,
	files_pending_update_content_is_stale,
	files_pending_update_has_asset_content,
	files_pending_update_has_content,
	files_pending_update_has_yjs_content,
	type files_VisibleTreeNode,
} from "./files.ts";
import { getSchema, type Editor, type JSONContent as TiptapJSONContent } from "@tiptap/core";
import { generateHTML as tiptap_generateHTML_server } from "@tiptap/html/server";
import {
	files_get_tiptap_shared_extensions,
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_get_markdown,
	files_parse_markdown_to_html,
	files_tiptap_html_to_json,
	files_tiptap_markdown_to_json,
	files_tiptap_markdown_to_plain_text,
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "./files-tiptap.ts";
import {
	files_yjs_doc_check_text_addressable,
	files_yjs_doc_plain_text_root_map_size,
	files_yjs_decode_v1_update,
	files_yjs_scan_client_update,
	files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE,
	files_yjs_RICH_TEXT_SHAPE_MISMATCH_MESSAGE,
	files_yjs_MALFORMED_UPDATE_MESSAGE,
	files_yjs_UNSUPPORTED_UPDATE_ENCODING_MESSAGE,
	files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
} from "./files-yjs.ts";
import {
	table_canonical_2x2,
	table_alignments,
	table_pipe_in_cell,
	table_backslash_before_pipe,
	table_empty_cell,
	table_inline_marks,
	table_comment_span,
	table_hard_break,
	table_between_paragraphs,
	table_last_block,
	table_code_span_backslash,
	table_code_span_markdown_active,
	table_ragged,
	table_no_outer_pipes,
	table_padded_cells,
	table_in_list_item,
} from "./files-table-markdown-fixtures.ts";
import {
	Doc as YDoc,
	XmlElement as YXmlElement,
	applyUpdate,
	encodeStateAsUpdate,
	encodeStateAsUpdateV2,
	encodeStateVector,
	mergeUpdates,
} from "yjs";
import stringByteLength from "string-byte-length";
import type { WorkId } from "@convex-dev/workpool";
import type { app_convex_Doc } from "./app-convex.ts";

const FILES_UTF8_BYTE_SIZE_TEXT_ENCODER_MIN_LENGTH = 1e2;
const FILES_UTF8_BYTE_SIZE_CACHE_MAX_MEMORY = 1e5;

// Adapted from string-byte-length's MIT-licensed test corpus:
// https://github.com/ehmicky/string-byte-length/blob/main/src/helpers/strings.test.js
const FILES_UTF8_BYTE_SIZE_CHARACTERS = [
	{ title: "null", string: "\0", size: 1 },
	{ title: "start of heading", string: "\u0001", size: 1 },
	{ title: "backspace", string: "\b", size: 1 },
	{ title: "tab", string: "\t", size: 1 },
	{ title: "newline", string: "\n", size: 1 },
	{ title: "ascii letter", string: "a", size: 1 },
	{ title: "space", string: " ", size: 1 },
	{ title: "delete", string: "\u007f", size: 1 },
	{ title: "two-byte lower bound", string: "\u0080", size: 2 },
	{ title: "two-byte upper bound", string: "\u07ff", size: 2 },
	{ title: "three-byte lower bound", string: "\u0800", size: 3 },
	{ title: "three-byte upper bound", string: "\uffff", size: 3 },
	{ title: "astral lower surrogate pair", string: "\ud800\udc00", size: 4 },
	{ title: "astral upper surrogate pair", string: "\udbff\udfff", size: 4 },
	{ title: "astral code point U+10000", string: "\u{10000}", size: 4 },
	{ title: "astral code point U+1FFFF", string: "\u{1ffff}", size: 4 },
	{ title: "astral code point U+FFFFF", string: "\u{fffff}", size: 4 },
	{ title: "invalid high surrogate lower bound", string: "\ud800", size: 3 },
	{ title: "invalid high surrogate upper bound", string: "\udbff", size: 3 },
	{ title: "invalid low surrogate lower bound", string: "\udc00", size: 3 },
	{ title: "invalid low surrogate upper bound", string: "\udfff", size: 3 },
	{ title: "invalid reversed surrogate pair", string: "\udc00\ud800", size: 6 },
] satisfies Array<{ title: string; string: string; size: number }>;

const FILES_UTF8_BYTE_SIZE_LONG_SPACE = "_".repeat(FILES_UTF8_BYTE_SIZE_TEXT_ENCODER_MIN_LENGTH);
const FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE = "_".repeat(Math.ceil(FILES_UTF8_BYTE_SIZE_CACHE_MAX_MEMORY / 3));
const FILES_UTF8_BYTE_SIZE_CASES = [
	{ title: "empty string", string: "", size: 0 },
	...FILES_UTF8_BYTE_SIZE_CHARACTERS.flatMap(({ title, string, size }) => [
		{ title, string, size },
		{ title: `${title} with appended space`, string: `${string} `, size: size + 1 },
		{ title: `${title} with prepended space`, string: ` ${string}`, size: size + 1 },
		{
			title: `${title} with appended long space`,
			string: `${string}${FILES_UTF8_BYTE_SIZE_LONG_SPACE}`,
			size: size + FILES_UTF8_BYTE_SIZE_LONG_SPACE.length,
		},
		{
			title: `${title} with prepended long space`,
			string: `${FILES_UTF8_BYTE_SIZE_LONG_SPACE}${string}`,
			size: size + FILES_UTF8_BYTE_SIZE_LONG_SPACE.length,
		},
		{
			title: `${title} with appended very long space`,
			string: `${string}${FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE}`,
			size: size + FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE.length,
		},
		{
			title: `${title} with prepended very long space`,
			string: `${FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE}${string}`,
			size: size + FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE.length,
		},
	]),
] satisfies Array<{ title: string; string: string; size: number }>;

type StringByteLengthGlobal = typeof globalThis & {
	Buffer?: {
		byteLength?: (string: string, encoding?: string) => number;
	};
	TextEncoder?: typeof TextEncoder;
};

async function import_string_byte_length_with_runtime(args: {
	bufferByteLength: "current" | "removed";
	textEncoder: "current" | "removed";
}) {
	const typedGlobal = globalThis as StringByteLengthGlobal;
	const buffer = typedGlobal.Buffer;
	const bufferByteLengthDescriptor = buffer ? Object.getOwnPropertyDescriptor(buffer, "byteLength") : undefined;
	const textEncoderDescriptor = Object.getOwnPropertyDescriptor(typedGlobal, "TextEncoder");

	try {
		vi.resetModules();
		if (args.bufferByteLength === "removed" && buffer) {
			Reflect.deleteProperty(buffer, "byteLength");
		}
		if (args.textEncoder === "removed") {
			Reflect.deleteProperty(typedGlobal, "TextEncoder");
		}

		return (await import("string-byte-length")).default;
	} finally {
		if (buffer) {
			if (bufferByteLengthDescriptor) {
				Object.defineProperty(buffer, "byteLength", bufferByteLengthDescriptor);
			} else {
				Reflect.deleteProperty(buffer, "byteLength");
			}
		}
		if (textEncoderDescriptor) {
			Object.defineProperty(typedGlobal, "TextEncoder", textEncoderDescriptor);
		} else {
			Reflect.deleteProperty(typedGlobal, "TextEncoder");
		}
		vi.resetModules();
	}
}

describe("files_get_utf8_byte_size", () => {
	test.each(FILES_UTF8_BYTE_SIZE_CASES)("computes UTF-8 byte size for $title", ({ string, size }) => {
		expect(files_get_utf8_byte_size(string)).toBe(size);
	});

	test.each(FILES_UTF8_BYTE_SIZE_CASES)("matches TextEncoder for $title", ({ string }) => {
		expect(files_get_utf8_byte_size(string)).toBe(new TextEncoder().encode(string).byteLength);
	});

	test.each(FILES_UTF8_BYTE_SIZE_CASES)("matches string-byte-length package for $title", ({ string, size }) => {
		expect(stringByteLength(string)).toBe(size);
	});
});

describe("files_normalize_text_document_input", () => {
	test.each([
		{ title: "CRLF pairs become LF", input: "a\r\nb\r\n", expected: "a\nb\n" },
		{ title: "a lone CR becomes LF", input: "a\rb", expected: "a\nb" },
		{ title: "one leading BOM is dropped", input: "\uFEFFabc", expected: "abc" },
		{ title: "a BOM after position 0 is content", input: "a\uFEFFb", expected: "a\uFEFFb" },
		{ title: "only the first BOM is dropped", input: "\uFEFF\uFEFFa", expected: "\uFEFFa" },
		{ title: "already-normalized text is untouched", input: "a\nb\n", expected: "a\nb\n" },
		{ title: "empty input stays empty", input: "", expected: "" },
	])("$title", ({ input, expected }) => {
		expect(files_normalize_text_document_input(input)).toBe(expected);
	});
});

describe("string-byte-length runtime paths", () => {
	test.each([
		["without Buffer.byteLength", { bufferByteLength: "removed", textEncoder: "current" }],
		["without Buffer.byteLength or TextEncoder", { bufferByteLength: "removed", textEncoder: "removed" }],
	] satisfies Array<
		[
			string,
			{
				bufferByteLength: Parameters<typeof import_string_byte_length_with_runtime>[0]["bufferByteLength"];
				textEncoder: Parameters<typeof import_string_byte_length_with_runtime>[0]["textEncoder"];
			},
		]
	>)("matches the upstream corpus %s", async (_title, runtime) => {
		const stringByteLengthForRuntime = await import_string_byte_length_with_runtime(runtime);

		for (const { title, string, size } of FILES_UTF8_BYTE_SIZE_CASES) {
			expect(stringByteLengthForRuntime(string), title).toBe(size);
		}
	});
});

describe("files_find_file_stem_end_index", () => {
	test.each([
		["notes.md", 5],
		["archive.tar.gz", 11],
		["notes", 5],
		[".env", 4],
		["trailing.", 8],
		["", 0],
	])("finds the stem end in %s", (fileName, expected) => {
		expect(files_find_file_stem_end_index({ fileName })).toBe(expected);
	});
});

function read_only_test_node(args: { id: string; parentId?: string; canWrite?: boolean }) {
	return {
		_id: args.id as files_VisibleTreeNode["_id"],
		parentId: (args.parentId ?? "root") as files_VisibleTreeNode["parentId"],
		canWrite: args.canWrite ?? true,
	};
}

function read_only_test_id(value: string) {
	return value as files_VisibleTreeNode["_id"];
}

describe("files_collect_protected_descendant_ids", () => {
	test("marks every visible ancestor of a locked node and nothing else", () => {
		const holderIds = files_collect_protected_descendant_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
			read_only_test_node({ id: "f", parentId: "b", canWrite: false }),
			read_only_test_node({ id: "c", parentId: "a" }),
			read_only_test_node({ id: "g", parentId: "c" }),
		]);

		expect(holderIds).toEqual(new Set([read_only_test_id("a"), read_only_test_id("b")]));
	});

	test("marks both branches when two locked nodes share an ancestor", () => {
		const holderIds = files_collect_protected_descendant_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
			read_only_test_node({ id: "f1", parentId: "b", canWrite: false }),
			read_only_test_node({ id: "c", parentId: "a" }),
			read_only_test_node({ id: "f2", parentId: "c", canWrite: false }),
		]);

		expect(holderIds).toEqual(new Set([read_only_test_id("a"), read_only_test_id("b"), read_only_test_id("c")]));
	});

	test("a locked root-level node has no visible ancestors", () => {
		const holderIds = files_collect_protected_descendant_ids([read_only_test_node({ id: "d", canWrite: false })]);

		expect(holderIds).toEqual(new Set());
	});

	test("a parent missing from the visible list ends the walk", () => {
		const holderIds = files_collect_protected_descendant_ids([
			read_only_test_node({ id: "a" }),
			// The locked node's direct parent is not visible to this caller, so the chain above it
			// cannot be walked. `a` is not related to the locked node here.
			read_only_test_node({ id: "f", parentId: "hidden", canWrite: false }),
		]);

		expect(holderIds).toEqual(new Set());
	});

	test("an all-writable tree yields an empty set", () => {
		const holderIds = files_collect_protected_descendant_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
		]);

		expect(holderIds).toEqual(new Set());
	});
});

describe("files_get_read_only_row_labels", () => {
	test("a read-only policy uses the local lock copy", () => {
		expect(
			files_get_read_only_row_labels({
				canWrite: false,
				writeBlockedReason: "read_only",
				writePolicyState: "read_only",
			}),
		).toEqual({ description: "Read-only", tooltip: "This item is read-only." });
	});

	test("an ACL refusal explains the missing permission", () => {
		expect(
			files_get_read_only_row_labels({
				canWrite: false,
				writeBlockedReason: "permission",
				writePolicyState: "none",
			}),
		).toEqual({ description: "read-only", tooltip: "You don't have permission to edit this item" });
	});

	test("a selected-writer rule shows even when this user can edit", () => {
		expect(
			files_get_read_only_row_labels({
				canWrite: true,
				writeBlockedReason: null,
				writePolicyState: "writer",
			}),
		).toEqual({ description: "Protected: selected writer", tooltip: "Only the selected writer can edit" });
	});

	test("a writable folder that only holds protected children has no lock", () => {
		expect(
			files_get_read_only_row_labels({
				canWrite: true,
				writeBlockedReason: null,
				writePolicyState: "none",
			}),
		).toBe(null);
	});

	test("a plain writable row gets no annotation", () => {
		expect(
			files_get_read_only_row_labels({
				canWrite: true,
				writeBlockedReason: null,
				writePolicyState: "none",
			}),
		).toBe(null);
	});
});

describe("files_get_read_only_capabilities", () => {
	test("protected children block delete, not rename or move", () => {
		expect(
			files_get_read_only_capabilities({
				canWrite: true,
				parentCanWrite: true,
				hasVisibleProtectedDescendant: true,
			}),
		).toEqual({
			canEditContent: true,
			canReceiveChildren: true,
			canRelocateOrRename: true,
			canArchiveOrRestore: false,
		});
	});

	test("a locked parent blocks rename and move of a writable child", () => {
		expect(
			files_get_read_only_capabilities({
				canWrite: true,
				parentCanWrite: false,
				hasVisibleProtectedDescendant: false,
			}),
		).toEqual({
			canEditContent: true,
			canReceiveChildren: true,
			canRelocateOrRename: false,
			canArchiveOrRestore: true,
		});
	});

	test("an effective refusal blocks every write capability", () => {
		expect(
			files_get_read_only_capabilities({
				canWrite: false,
				parentCanWrite: true,
				hasVisibleProtectedDescendant: false,
			}),
		).toEqual({
			canEditContent: false,
			canReceiveChildren: false,
			canRelocateOrRename: false,
			canArchiveOrRestore: false,
		});
	});

	test("ACL refusal blocks every write capability", () => {
		expect(
			files_get_read_only_capabilities({
				canWrite: false,
				parentCanWrite: false,
				hasVisibleProtectedDescendant: false,
			}),
		).toEqual({
			canEditContent: false,
			canReceiveChildren: false,
			canRelocateOrRename: false,
			canArchiveOrRestore: false,
		});
	});
});

describe("files_derive_tree_path_for_file_node", () => {
	test("keeps file paths unchanged", () => {
		expect(files_derive_tree_path_for_file_node("/docs/readme.md", "file")).toBe("/docs/readme.md");
	});

	test("adds a trailing slash for non-root folders", () => {
		expect(files_derive_tree_path_for_file_node("/docs", "folder")).toBe("/docs/");
	});

	test("keeps root unchanged", () => {
		expect(files_derive_tree_path_for_file_node("/", "folder")).toBe("/");
	});
});

describe("files_parse_content_type", () => {
	test("returns the lowercase essence and the charset", () => {
		expect(files_parse_content_type("Text/Markdown; Charset=UTF-8")).toEqual({
			essence: "text/markdown",
			charset: "utf-8",
		});
		expect(files_parse_content_type("image/png")).toEqual({ essence: "image/png", charset: null });
		expect(files_parse_content_type('text/plain; charset="utf-8"')).toEqual({
			essence: "text/plain",
			charset: "utf-8",
		});
	});

	test("refuses values that are not a valid type/subtype", () => {
		expect(files_parse_content_type("")).toBeNull();
		expect(files_parse_content_type("markdown")).toBeNull();
		expect(files_parse_content_type("text/markdown; broken")).toBeNull();
		expect(files_parse_content_type("text/plain; =utf-8")).toBeNull();
		expect(files_parse_content_type(`text/${"x".repeat(300)}`)).toBeNull();
	});
});

describe("files_normalize_content_type", () => {
	test.each([
		["text/markdown", "text/markdown;charset=utf-8"],
		["TEXT/X-MARKDOWN; charset=UTF-8", "text/markdown;charset=utf-8"],
		["text/plain", "text/plain;charset=utf-8"],
		["application/json; charset=utf-8", "application/json"],
		["text/x-yaml", "application/yaml"],
		["application/javascript", "text/javascript"],
		["Image/PNG", "image/png"],
		["text/html", "text/html;charset=utf-8"],
		["text/html; charset=ISO-8859-1", "text/html;charset=utf-8"],
		["application/octet-stream", "application/octet-stream"],
	] satisfies Array<[string, string]>)("normalizes %s to %s", (input, expected) => {
		expect(files_normalize_content_type(input)).toBe(expected);
	});

	test("returns null for a broken value", () => {
		expect(files_normalize_content_type("not a type")).toBeNull();
	});
});

describe("files_editable_text_shape_of", () => {
	// One table for the three sister helpers below: the shape, its root kind, and its canonical
	// type must agree on every content type.
	test.each([
		// Markdown keeps the rich text document. Every other editable text type is plain text.
		["text/markdown;charset=utf-8", { contentType: "text/markdown;charset=utf-8", rootKind: "rich_text" }],
		["text/markdown", { contentType: "text/markdown;charset=utf-8", rootKind: "rich_text" }],
		["text/plain", { contentType: "text/plain;charset=utf-8", rootKind: "plain_text" }],
		["text/html", { contentType: "text/html;charset=utf-8", rootKind: "plain_text" }],
		["TEXT/HTML; charset=UTF-8", { contentType: "text/html;charset=utf-8", rootKind: "plain_text" }],
		["application/json", { contentType: "application/json", rootKind: "plain_text" }],
		["application/x-yaml", { contentType: "application/yaml", rootKind: "plain_text" }],
		["text/css", { contentType: "text/css", rootKind: "plain_text" }],
		["text/typescript", { contentType: "text/typescript", rootKind: "plain_text" }],
		["application/sql", { contentType: "application/sql", rootKind: "plain_text" }],
		// Other types stay stored bytes.
		["image/svg+xml", null],
		["image/png", null],
		["application/pdf", null],
		["application/octet-stream", null],
		["broken", null],
		[undefined, null],
	] satisfies Array<[string | undefined, ReturnType<typeof files_editable_text_shape_of>]>)(
		"shapes %s as %o",
		(contentType, expected) => {
			expect(files_editable_text_shape_of(contentType)).toEqual(expected);
			expect(files_yjs_root_kind_of_content_type(contentType)).toBe(expected?.rootKind ?? null);
			expect(files_editable_text_content_type_of(contentType)).toBe(expected?.contentType ?? null);
		},
	);
});

describe("files_monaco_language_id_of_content_type", () => {
	test.each([
		["text/markdown;charset=utf-8", "markdown"],
		["text/markdown", "markdown"],
		["text/plain;charset=utf-8", "plaintext"],
		["text/html;charset=utf-8", "html"],
		["text/html", "html"],
		["application/json", "json"],
		["application/yaml", "yaml"],
		["text/yaml", "yaml"],
		["application/toml", "plaintext"],
		["text/csv", "plaintext"],
		["text/css", "css"],
		["text/javascript", "javascript"],
		["text/typescript", "typescript"],
		["application/x-sh", "shell"],
		["application/sql", "sql"],
		["image/png", "plaintext"],
		[undefined, "plaintext"],
	] satisfies Array<[string | undefined, string]>)("maps %s to %s", (contentType, expected) => {
		expect(files_monaco_language_id_of_content_type(contentType)).toBe(expected);
	});
});

describe("files_guess_content_type_from_name", () => {
	test.each([
		["notes.md", "text/markdown;charset=utf-8"],
		["NOTES.MD", "text/markdown;charset=utf-8"],
		["notes.txt", "text/plain;charset=utf-8"],
		["build.log", "text/plain;charset=utf-8"],
		["settings.ini", "text/plain;charset=utf-8"],
		["data.json", "application/json"],
		["config.jsonc", "application/json"],
		["config.yml", "application/yaml"],
		["config.toml", "application/toml"],
		["table.csv", "text/csv"],
		["table.tsv", "text/tab-separated-values"],
		["style.css", "text/css"],
		["script.mjs", "text/javascript"],
		["view.tsx", "text/typescript"],
		["run.sh", "application/x-sh"],
		["query.sql", "application/sql"],
		["page.html", "text/html;charset=utf-8"],
		["PAGE.HTM", "text/html;charset=utf-8"],
		// The name is only a hint. Unknown extensions and names without one hint at nothing.
		["photo.png", null],
		["script.py", null],
		[".json", null],
		[".gitignore", null],
		["data.", null],
		["notes", null],
	] satisfies Array<[string, ReturnType<typeof files_guess_content_type_from_name>]>)(
		"hints %s as %s",
		(fileName, expected) => {
			expect(files_guess_content_type_from_name(fileName)).toBe(expected);
		},
	);
});

describe("files_default_text_shape_for_name", () => {
	test("uses the name hint and falls back to plain text, so no name is refused", () => {
		expect(files_default_text_shape_for_name("README.md")).toEqual({
			contentType: "text/markdown;charset=utf-8",
			rootKind: "rich_text",
		});
		expect(files_default_text_shape_for_name("data.json")).toEqual({
			contentType: "application/json",
			rootKind: "plain_text",
		});
		for (const name of ["brief.html", "brief.htm"]) {
			expect(files_default_text_shape_for_name(name)).toEqual({
				contentType: "text/html;charset=utf-8",
				rootKind: "plain_text",
			});
		}
		expect(files_default_text_shape_for_name("notes")).toEqual({
			contentType: "text/plain;charset=utf-8",
			rootKind: "plain_text",
		});
		expect(files_default_text_shape_for_name("script.py")).toEqual({
			contentType: "text/plain;charset=utf-8",
			rootKind: "plain_text",
		});
		// A stored-bytes hint never makes a text file: the name only helps pick a text type.
		expect(files_default_text_shape_for_name("photo.png")).toEqual({
			contentType: "text/plain;charset=utf-8",
			rootKind: "plain_text",
		});
		expect(files_default_text_shape_for_name("notes.txt").contentType).toBe("text/plain;charset=utf-8");
	});
});

describe("files_resolve_upload_content_type", () => {
	test("the caller's valid type wins over the name", () => {
		expect(files_resolve_upload_content_type({ contentType: "text/markdown", fileName: "data.json" })).toBe(
			"text/markdown;charset=utf-8",
		);
		expect(files_resolve_upload_content_type({ contentType: "application/octet-stream", fileName: "notes.md" })).toBe(
			"application/octet-stream",
		);
		expect(files_resolve_upload_content_type({ contentType: "text/plain", fileName: "brief.html" })).toBe(
			"text/plain;charset=utf-8",
		);
		expect(files_resolve_upload_content_type({ contentType: "text/html", fileName: "brief.txt" })).toBe(
			"text/html;charset=utf-8",
		);
	});

	test("the name is a hint only when the caller sent no type", () => {
		expect(files_resolve_upload_content_type({ contentType: undefined, fileName: "notes.md" })).toBe(
			"text/markdown;charset=utf-8",
		);
		expect(files_resolve_upload_content_type({ contentType: undefined, fileName: "photo.png" })).toBe(
			"application/octet-stream",
		);
		expect(files_resolve_upload_content_type({ contentType: undefined, fileName: "brief.htm" })).toBe(
			"text/html;charset=utf-8",
		);
	});

	test("a broken type is refused instead of guessed", () => {
		expect(files_resolve_upload_content_type({ contentType: "not a type", fileName: "notes.md" })).toBeNull();
	});
});

describe("files_get_signed_download_serving", () => {
	test.each([
		["image/png", "image/png"],
		["video/mp4", "video/mp4"],
		["audio/mpeg", "application/octet-stream"],
		["image/svg+xml", "application/octet-stream"],
		["text/html", "text/html;charset=utf-8"],
		["text/plain", "text/plain;charset=utf-8"],
	])("forces %s to download without changing its safe served type", (contentType, responseContentType) => {
		const serving = files_get_signed_download_serving({ contentType, fileName: "it's a file.png", download: true });
		expect(serving).toEqual({
			responseContentType,
			responseContentDisposition: "attachment; filename*=UTF-8''it%27s%20a%20file.png",
		});
	});

	test("keeps media inline when download is false", () => {
		expect(
			files_get_signed_download_serving({ contentType: "image/png", fileName: "photo.png", download: false }),
		).toEqual({
			responseContentType: "image/png",
			responseContentDisposition: "inline; filename*=UTF-8''photo.png",
		});
	});

	test.each([
		["image/png", "photo.png", "image/png", "inline"],
		["IMAGE/JPEG; charset=binary", "photo.jpg", "image/jpeg", "inline"],
		["video/mp4", "movie.mp4", "video/mp4", "inline"],
		// SVG and HTML can run script when served inline, so they always download.
		["image/svg+xml", "image.svg", "application/octet-stream", "attachment"],
		["text/html", "page.html", "text/html;charset=utf-8", "attachment"],
		["text/html;charset=utf-8", "page.htm", "text/html;charset=utf-8", "attachment"],
		// Editable text keeps its canonical type but never serves inline.
		["text/markdown", "notes.md", "text/markdown;charset=utf-8", "attachment"],
		["application/json", "data.json", "application/json", "attachment"],
		["application/pdf", "paper.pdf", "application/octet-stream", "attachment"],
		[undefined, "unknown.bin", "application/octet-stream", "attachment"],
	] satisfies Array<[string | undefined, string, string, "inline" | "attachment"]>)(
		"serves %s (%s) as %s %s",
		(contentType, fileName, responseContentType, disposition) => {
			const serving = files_get_signed_download_serving({ contentType, fileName });
			expect(serving.responseContentType).toBe(responseContentType);
			expect(serving.responseContentDisposition.startsWith(`${disposition}; filename*=UTF-8''`)).toBe(true);
		},
	);

	test("the file name is encoded for the disposition header", () => {
		// The name never decides the type: a `.png` name with a text type still downloads as text.
		const serving = files_get_signed_download_serving({ contentType: "text/plain", fileName: "my notes (1).png" });
		expect(serving.responseContentType).toBe("text/plain;charset=utf-8");
		expect(serving.responseContentDisposition).toBe("attachment; filename*=UTF-8''my%20notes%20%281%29.png");
	});
});

describe("files_get_upload_pipeline_state", () => {
	test.each([
		[null, "not_applicable"],
		[{ kind: "content", r2Key: "content-key" }, "not_applicable"],
		[{ kind: "content", processingWorkId: "work_1" as WorkId }, "processing"],
		[{ kind: "content", processingWorkId: null }, "terminal"],
		[{ kind: "upload" }, "waiting_for_upload"],
		[{ kind: "upload", processingWorkId: null }, "terminal"],
		[{ kind: "upload", r2Key: "upload-key" }, "pending_processing"],
		[{ kind: "upload", r2Key: "upload-key", processingWorkId: "work_1" as WorkId }, "processing"],
		[{ kind: "upload", r2Key: "upload-key", processingWorkId: null }, "terminal"],
	] satisfies Array<
		[Parameters<typeof files_get_upload_pipeline_state>[0], ReturnType<typeof files_get_upload_pipeline_state>]
	>)("returns expected state for case %#", (asset, expected) => {
		expect(files_get_upload_pipeline_state(asset)).toBe(expected);
	});
});

describe("files_node_has_editable_text_content", () => {
	const assetId = "asset" as NonNullable<app_convex_Doc<"files_nodes">["assetId"]>;

	test.each(["rich_text", "plain_text"] as const)("keeps %s editable without a live document", (textKind) => {
		const node = { kind: "file" as const, assetId, textKind, yjsSnapshotId: null, yjsLastSequenceId: null };
		expect(files_node_has_editable_text_content(node)).toBe(true);
		expect(files_node_has_editable_yjs_state(node)).toBe(false);
	});

	test("rejects folders, missing content, and stored blobs", () => {
		expect(files_node_has_editable_text_content({ kind: "folder", assetId, textKind: "rich_text" })).toBe(false);
		expect(files_node_has_editable_text_content({ kind: "file", assetId: null, textKind: "plain_text" })).toBe(false);
		expect(files_node_has_editable_text_content({ kind: "file", assetId, textKind: null })).toBe(false);
	});

	test("keeps older HTML blobs stored even when their type supports editable text", () => {
		const node = { kind: "file" as const, assetId, textKind: null, contentType: "text/html", name: "brief.html" };
		expect(files_node_has_editable_text_content(node)).toBe(false);
	});
});

describe("files_node_has_editable_yjs_state", () => {
	const assetId = "asset" as NonNullable<app_convex_Doc<"files_nodes">["assetId"]>;
	const yjsSnapshotId = "snapshot" as NonNullable<app_convex_Doc<"files_nodes">["yjsSnapshotId"]>;
	const yjsLastSequenceId = "sequence" as NonNullable<app_convex_Doc<"files_nodes">["yjsLastSequenceId"]>;

	test("requires a file with an asset and both Yjs pointers", () => {
		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
				textKind: "rich_text",
			}),
		).toBe(true);

		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
				textKind: null,
			}),
		).toBe(false);
		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId: null,
				textKind: "rich_text",
			}),
		).toBe(false);
		expect(
			files_node_has_editable_yjs_state({
				kind: "folder",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
				textKind: "rich_text",
			}),
		).toBe(false);
	});
});

describe("files_pending_update_has_content", () => {
	const baseStateId = "base" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const stagedStateId = "staged" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const unstagedStateId = "unstaged" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const baseAssetId = "asset" as app_convex_Doc<"files_r2_assets">["_id"];
	const yjsContent = {
		content: {
			rootKind: "plain_text" as const,
			base: { kind: "yjs" as const, sequence: 3, lineageGeneration: 1, pendingContentVersion: 1 },
			baseStateId,
			stagedStateId,
			unstagedStateId,
		},
	};
	const assetContent = {
		content: {
			rootKind: "plain_text" as const,
			base: { kind: "asset" as const, assetId: baseAssetId, pendingContentVersion: 1 },
			baseStateId, stagedStateId, unstagedStateId,
		},
	};

	test("recognizes branches built from a saved asset", () => {
		expect(files_pending_update_has_asset_content(assetContent)).toBe(true);
		expect(files_pending_update_has_yjs_content(assetContent)).toBe(false);
		expect(files_pending_update_has_content(assetContent)).toBe(true);
	});

	test("recognizes branches built from a saved Yjs sequence", () => {
		expect(files_pending_update_has_yjs_content(yjsContent)).toBe(true);
		expect(files_pending_update_has_asset_content(yjsContent)).toBe(false);
		expect(files_pending_update_has_content(yjsContent)).toBe(true);
	});

	test("recognizes a new private file without a saved base", () => {
		const pendingUpdate = {
			content: { rootKind: "plain_text" as const, base: { kind: "new" as const }, baseStateId, stagedStateId, unstagedStateId },
		};
		expect(files_pending_update_has_content(pendingUpdate)).toBe(true);
		expect(files_pending_update_has_yjs_content(pendingUpdate)).toBe(false);
		expect(files_pending_update_has_asset_content(pendingUpdate)).toBe(false);
	});

	test("a structural-only or missing doc has no content", () => {
		expect(files_pending_update_has_content({})).toBe(false);
		expect(files_pending_update_has_asset_content({})).toBe(false);
		expect(files_pending_update_has_yjs_content({})).toBe(false);
		expect(files_pending_update_has_content(null)).toBe(false);
		expect(files_pending_update_has_content(undefined)).toBe(false);
	});
});

describe("files_pending_update_content_is_stale", () => {
	const baseStateId = "base" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const stagedStateId = "staged" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const unstagedStateId = "unstaged" as app_convex_Doc<"files_pending_update_yjs_states">["_id"];
	const baseAssetId = "asset" as app_convex_Doc<"files_r2_assets">["_id"];
	const savedAssetId = "saved-asset" as NonNullable<app_convex_Doc<"files_nodes">["assetId"]>;
	const assetContent = {
		content: {
			rootKind: "plain_text" as const,
			base: { kind: "asset" as const, assetId: baseAssetId, pendingContentVersion: 1 },
			baseStateId, stagedStateId, unstagedStateId,
		},
	};
	const yjsContent = {
		content: {
			rootKind: "plain_text" as const,
			base: { kind: "yjs" as const, sequence: 3, lineageGeneration: 1, pendingContentVersion: 1 },
			baseStateId,
			stagedStateId,
			unstagedStateId,
		},
	};

	test("an asset base becomes stale after the saved asset changes", () => {
		expect(files_pending_update_content_is_stale(assetContent, { assetId: baseAssetId, pendingContentVersion: 1 })).toBe(false);
		expect(files_pending_update_content_is_stale(assetContent, { assetId: savedAssetId, pendingContentVersion: 1 })).toBe(true);
		expect(files_pending_update_content_is_stale(yjsContent, { assetId: savedAssetId, pendingContentVersion: 1 })).toBe(false);
		expect(files_pending_update_content_is_stale({}, { assetId: savedAssetId, pendingContentVersion: 1 })).toBe(false);
	});

	test("a new private file has no saved asset to become stale against", () => {
		expect(
			files_pending_update_content_is_stale(
				{ content: { rootKind: "plain_text", base: { kind: "new" }, baseStateId, stagedStateId, unstagedStateId } },
				{ assetId: savedAssetId, pendingContentVersion: 2 },
			),
		).toBe(false);
	});

	test.each([yjsContent, assetContent])("an older file version is stale but keeps its draft %#", (content) => {
		expect(files_pending_update_content_is_stale(content, { assetId: baseAssetId, pendingContentVersion: 2 })).toBe(true);
		expect(files_pending_update_has_content(content)).toBe(true);
	});
});

describe("files_get_normalized_node_path_segments", () => {
	test.each([
		[null, "docs/readme", null],
		["file", "", null],
		["file", "/", null],
		["folder", "Docs / Feature Plan", { normalizedPathSegments: ["docs", "feature-plan"] }],
		["folder", "Docs / release.v1", { normalizedPathSegments: ["docs", "release.v1"] }],
		["file", "Docs / readme", { normalizedPathSegments: ["docs", "README.md"] }],
		["file", "docs/archive.tar.md", { normalizedPathSegments: ["docs", "archive.tar.md"] }],
		["file", "docs/archive.tar.gz", { validationMessage: "Invalid file name" }],
		["folder", "docs/Bad Name", { normalizedPathSegments: ["docs", "bad-name"] }],
		["file", "docs/bad.m d", { validationMessage: "Invalid file name" }],
	] satisfies Array<[Parameters<typeof files_get_normalized_node_path_segments>[0]["kind"], string, unknown]>)(
		"normalizes %#",
		(kind, nameOrPath, expected) => {
			expect(files_get_normalized_node_path_segments({ kind, nameOrPath })).toEqual(expected);
		},
	);
});

describe("files_normalize_name_input", () => {
	test.each([
		[{ kind: "file", previousText: "", insertedText: "A", nextText: "" }, "a"],
		[{ kind: "file", previousText: "", insertedText: "é", nextText: "" }, "e"],
		[{ kind: "folder", previousText: "", insertedText: "é", nextText: "" }, "e"],
		[{ kind: "file", previousText: "file", insertedText: " ", nextText: "name" }, "-"],
		[{ kind: "file", previousText: "file-", insertedText: " ", nextText: "name" }, ""],
		[{ kind: "file", previousText: "notes", insertedText: ".", nextText: "md" }, "."],
		[{ kind: "folder", previousText: "notes", insertedText: ".", nextText: "md" }, "."],
		[{ kind: "file", previousText: "a-", insertedText: "_", nextText: "b" }, ""],
		[{ kind: "file", previousText: "a", insertedText: "_", nextText: "-b" }, ""],
		[{ kind: "file", previousText: "a", insertedText: ".", nextText: "-b" }, ""],
		[{ kind: "file", previousText: "a_", insertedText: ".", nextText: "b" }, ""],
		[{ kind: "folder", previousText: "a", insertedText: "_", nextText: "-b" }, ""],
		[{ kind: "file", previousText: "file", insertedText: "2026", nextText: "" }, "2026"],
		[{ kind: "folder", previousText: "", insertedText: "2026", nextText: "" }, "2026"],
		[{ kind: "file", previousText: "foo", insertedText: "-", nextText: "" }, "-"],
		[{ kind: "file", previousText: "foo", insertedText: "_", nextText: "" }, "_"],
		[{ kind: "file", previousText: "foo", insertedText: "/bar", nextText: "" }, "/bar"],
		[{ kind: "folder", previousText: "foo", insertedText: "\\bar", nextText: "" }, "/bar"],
		[{ kind: "file", previousText: "", insertedText: "-file", nextText: "" }, "file"],
		[{ kind: "folder", previousText: "", insertedText: ".", nextText: "" }, "."],
		[{ kind: "folder", previousText: "", insertedText: ".agents", nextText: "" }, ".agents"],
		[{ kind: "folder", previousText: "", insertedText: ".system", nextText: "" }, ".system"],
		[
			{ kind: "file", previousText: "docs/", insertedText: ".agents/skills/one/skill.md", nextText: "" },
			".agents/skills/one/skill.md",
		],
	] satisfies Array<[Parameters<typeof files_normalize_name_input>[0], string]>)(
		"normalizes live input %#",
		(input, expected) => {
			expect(files_normalize_name_input(input)).toBe(expected);
		},
	);
});

describe("files_normalize_name", () => {
	test.each([
		["docs", "docs"],
		["new-folder", "new-folder"],
		["UPPER_lower-123", "upper_lower-123"],
		["Résumé", "resume"],
		["a\u1ab0folder", "afolder"],
		["---docs---", "docs"],
		["___docs___", "docs"],
		["a@b#c!", "a-b-c"],
		["asd/.txt", "asd-txt"],
		["test.", "test"],
		[".test", "test"],
		[".agents", ".agents"],
		[".AGENTS", ".agents"],
		[".system", ".system"],
		[" .SYSTEM ", ".system"],
		[".", "untitled"],
		["test/test.txt", "test-test.txt"],
		["test//test.txt", "test-test.txt"],
		["test.txt/test", "test.txt-test"],
		["bad\\name", "bad-name"],
		["  spaced name  ", "spaced-name"],
		["你好", "untitled"],
		["2026 plan", "2026-plan"],
		["a__b", "a_b"],
		["a--b", "a-b"],
		["test___test", "test_test"],
		["test---test", "test-test"],
	])("normalizes folder %s to %s", (input, expected) => {
		expect(files_normalize_name("folder", input)).toEqual({ _yay: expected });
	});

	test.each(["..", "test..test"])("rejects folder %s", (input) => {
		const result = files_normalize_name("folder", input);
		if (!result._nay) {
			throw new Error("Expected folder name normalization to fail");
		}

		expect(result._nay.message).toBe("Invalid folder name");
	});

	test.each([
		["notes.md", "notes.md"],
		["notes", "notes.md"],
		["NOTES.MD", "notes.md"],
		["readme", "README.md"],
		["README", "README.md"],
		["readme.md", "README.md"],
		["README.md", "README.md"],
		["agents.md", "AGENTS.md"],
		["skill.md", "SKILL.md"],
		["New File.md", "new-file.md"],
		["a\u1ab0file.md", "afile.md"],
		["---notes---.MD", "notes.md"],
		["___notes___.md", "notes.md"],
		["a@b#c!.md", "a-b-c.md"],
		["x.", "x.md"],
		["test.", "test.md"],
		["bad\\name.md", "bad-name.md"],
		["archive.tar.md", "archive.tar.md"],
		["folder/file.name.with.many.md", "folder-file.name.with.many.md"],
		["  spaced name.md  ", "spaced-name.md"],
		["你好", "untitled.md"],
		["你好.md", "untitled.md"],
		["emoji😊file.md", "emoji-file.md"],
		["test___test.md", "test_test.md"],
		["test---test.md", "test-test.md"],
	])("normalizes file %s to %s", (input, expected) => {
		expect(files_normalize_name("file", input)).toEqual({ _yay: expected });
	});

	test.each([
		"..",
		".",
		"test..test",
		".test",
		"readme.txt",
		"notes.txt",
		"Résumé.DOC",
		"asd/.txt",
		"test/test.txt",
		"test//test.txt",
		"test.txt/test",
		"test.txt\\test",
		"archive.tar.gz",
		"folder/file.name.with.many.dots",
		"2026 plan.final",
		"multi___under.txt",
		"test.m d",
	])("rejects file %s", (input) => {
		const result = files_normalize_name("file", input);
		if (!result._nay) {
			throw new Error("Expected file name normalization to fail");
		}

		expect(result._nay.message).toBe("Invalid file name");
	});
});

describe("files_normalize_markdown_name", () => {
	test("normalizes extensionless names as Markdown files", () => {
		expect(files_normalize_markdown_name("Feature Plan")).toEqual({ _yay: "feature-plan.md" });
	});

	test("rejects non-Markdown extensions instead of rewriting them", () => {
		expect(files_normalize_markdown_name("Feature Plan.pdf")).toEqual({
			_nay: { name: "nay", message: "Invalid file name" },
		});
	});
});

describe("files_normalize_upload_file_name", () => {
	test.each([
		["readme", "README.md"],
		["README", "README.md"],
		["readme.md", "README.md"],
		["agents.md", "AGENTS.md"],
		["skill.md", "SKILL.md"],
		["data.json", "data.json"],
		["DATA.JSON", "data.json"],
		["My Notes.yaml", "my-notes.yaml"],
		["photo.PNG", "photo.png"],
		// Any extension is kept as it is. The name never decides what the file is.
		["tool.exe", "tool.exe"],
		["script.py", "script.py"],
		// Other names without an extension stay without one.
		["Feature Plan", "feature-plan"],
		["notes.", "notes"],
		["a\\b/c.txt", "c.txt"],
	])("normalizes %s to %s", (input, expected) => {
		expect(files_normalize_upload_file_name(input)).toBe(expected);
	});
});

describe("files_normalize_browser_download_name", () => {
	test.each([
		// A page must not create an instruction file, so special names get `-download`.
		["README", "readme-download.md"],
		["readme.md", "readme-download.md"],
		["Agents.MD", "agents-download.md"],
		["AGENTS.md", "agents-download.md"],
		["skill.txt", "skill-download.txt"],
		["SKILL", "skill-download"],
		// Other names follow the upload rules.
		["report.pdf", "report.pdf"],
		["Quarterly Report.PDF", "quarterly-report.pdf"],
		["readme-v2.md", "readme-v2.md"],
		["my-agents.md", "my-agents.md"],
		["path/to/agents.md", "agents-download.md"],
		["", "upload"],
	])("normalizes %s to %s", (input, expected) => {
		expect(files_normalize_browser_download_name(input)).toBe(expected);
	});
});

describe("files_normalize_file_rename_name", () => {
	test.each([
		["readme.md", "README.md"],
		["agents.md", "AGENTS.md"],
		["skill.md", "SKILL.md"],
		["readme", "README.md"],
		["README", "README.md"],
		["agents", "AGENTS"],
		["skill", "SKILL"],
		["data.yaml", "data.yaml"],
	])("normalizes %s to %s", (input, expected) => {
		expect(files_normalize_file_rename_name(input)).toEqual({ _yay: expected });
	});
});

describe("files_normalize_special_node_path", () => {
	test.each([
		["file", "/.AGENTS/skills/one/skill.md", "/.agents/skills/one/SKILL.md"],
		["file", "/docs/agents.MD", "/docs/AGENTS.md"],
		["file", "/docs/readme", "/docs/README.md"],
		["folder", "/.AGENTS", "/.agents"],
		["folder", "/.SYSTEM/downloads", "/.system/downloads"],
		["file", "/.System/downloads/report.pdf", "/.system/downloads/report.pdf"],
		["file", "/Bad Folder//bad File.md", "/Bad Folder//bad File.md"],
		["file", "/../.agents/SKILL.md", "/../.agents/SKILL.md"],
	] as const)("changes only special spelling %#", (kind, path, expected) => {
		expect(files_normalize_special_node_path(kind, path)).toBe(expected);
	});
});

describe("files_tiptap_markdown_to_json", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("keeps default markdown behavior when replaceNewLineToBr is not provided", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "first line\nsecond line",
		});
		if (result._nay) {
			throw new Error("Expected markdown conversion to succeed by default", {
				cause: result._nay,
			});
		}

		expect(result).toMatchInlineSnapshot(
			{
				_yay: {
					content: [
						{
							content: [{ text: expect.any(String) }],
						},
					],
				},
			},
			`
			{
			  "_yay": {
			    "content": [
			      {
			        "attrs": {
			          "markdownTight": null,
			        },
			        "content": [
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			        ],
			        "type": "paragraph",
			      },
			    ],
			    "type": "doc",
			  },
			}
			`,
		);
	});

	test("preserves inline line breaks when replaceNewLineToBr is true", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "first line\nsecond line",
			replaceNewLineToBr: true,
		});
		if (result._nay) {
			throw new Error("Expected markdown conversion to succeed when replacing new lines with <br>", {
				cause: result._nay,
			});
		}

		expect(result).toMatchInlineSnapshot(
			{
				_yay: {
					content: [
						{
							content: [{ text: expect.any(String) }, {}, { text: expect.any(String) }],
						},
					],
				},
			},
			`
			{
			  "_yay": {
			    "content": [
			      {
			        "attrs": {
			          "markdownTight": null,
			        },
			        "content": [
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			          {
			            "attrs": {
			              "markdownSource": "<br>",
			            },
			            "type": "hardBreak",
			          },
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			        ],
			        "type": "paragraph",
			      },
			    ],
			    "type": "doc",
			  },
			}
			`,
		);
	});

	test("preserves trailing whitespace at EOF through JSON conversion", () => {
		const noTrailingWhitespace = files_tiptap_markdown_to_json({
			markdown: "hello",
		});
		const trailingSpace = files_tiptap_markdown_to_json({
			markdown: "hello ",
		});
		const trailingNewline = files_tiptap_markdown_to_json({
			markdown: "hello\n",
		});
		const trailingBlankLine = files_tiptap_markdown_to_json({
			markdown: "hello\n\n",
		});

		if (noTrailingWhitespace._nay) {
			throw new Error("Expected markdown conversion without trailing whitespace to succeed", {
				cause: noTrailingWhitespace._nay,
			});
		}
		if (trailingSpace._nay) {
			throw new Error("Expected markdown conversion with trailing space to succeed", {
				cause: trailingSpace._nay,
			});
		}
		if (trailingNewline._nay) {
			throw new Error("Expected markdown conversion with trailing newline to succeed", {
				cause: trailingNewline._nay,
			});
		}
		if (trailingBlankLine._nay) {
			throw new Error("Expected markdown conversion with trailing blank line to succeed", {
				cause: trailingBlankLine._nay,
			});
		}

		expect(trailingSpace._yay).not.toEqual(noTrailingWhitespace._yay);
		expect(trailingSpace._yay.content?.[0]).toMatchObject({
			type: "paragraph",
			content: [{ type: "text", text: "hello " }],
		});

		// One final `\n` is a plain line terminator, not an empty line; only newlines
		// beyond it become empty paragraphs.
		expect(trailingNewline._yay).toEqual(noTrailingWhitespace._yay);
		expect((trailingBlankLine._yay.content ?? []).length).toBeGreaterThan((trailingNewline._yay.content ?? []).length);
	});

	test("preserves trailing whitespace at EOF for heading markdown through JSON conversion", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "# Base ",
		});

		if (result._nay) {
			throw new Error("Expected heading markdown conversion with trailing space to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay.content).toEqual([
			{
				type: "heading",
				attrs: {
					level: 1,
					markdownClosing: null,
					markdownOpening: null,
					markdownTight: null,
					markdownUnderline: null,
				},
				content: [{ type: "text", text: "Base " }],
			},
		]);
	});
});

describe("files_headless_tiptap_editor_create", () => {
	test("keeps each editor's Markdown parser separate", () => {
		const input = [
			"---",
			"subject: Parser isolation",
			"---",
			"",
			"- [ ] First task",
			"- [x] Finished task",
			"",
			"![Image](bonobo-file://k17abcdef)",
			"",
			'<video src="bonobo-file://k17video"></video>',
			"",
		].join("\n");
		const first = files_headless_tiptap_editor_create({ initialContent: { markdown: input } });
		if (first._nay) throw new Error("Expected first editor creation to succeed", { cause: first._nay });
		const parser = first._yay.markdown!.instance;
		const expectedJson = first._yay.getJSON();
		const expectedMarkdown = files_headless_tiptap_editor_get_markdown({ mut_editor: first._yay });
		const blockCount = parser.defaults.extensions?.block?.length;
		const inlineCount = parser.defaults.extensions?.inline?.length;

		try {
			for (let index = 0; index < 20; index++) {
				const next = files_headless_tiptap_editor_create({ initialContent: { markdown: input } });
				if (next._nay) throw new Error("Expected next editor creation to succeed", { cause: next._nay });
				try {
					expect(next._yay.markdown!.instance).not.toBe(parser);
					expect(next._yay.markdown!.instance.defaults.extensions?.block?.length).toBe(blockCount);
					expect(next._yay.markdown!.instance.defaults.extensions?.inline?.length).toBe(inlineCount);
					expect(next._yay.getJSON()).toEqual(expectedJson);
					expect(files_headless_tiptap_editor_get_markdown({ mut_editor: next._yay })).toBe(expectedMarkdown);
					expect(parser.defaults.extensions?.block?.length).toBe(blockCount);
					expect(parser.defaults.extensions?.inline?.length).toBe(inlineCount);
				} finally {
					next._yay.destroy();
				}
			}
		} finally {
			first._yay.destroy();
		}
	});
});

describe("files_tiptap_markdown_to_plain_text", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("extracts searchable plain text without markdown markers", () => {
		const markdown = [
			"# Search Title",
			"",
			"Paragraph with [link label](https://example.com).",
			"",
			"```ts",
			"const chunkValue = 123;",
			"```",
		].join("\n");

		const result = files_tiptap_markdown_to_plain_text({
			markdown,
		});
		if (result._nay) {
			throw new Error("Expected markdown plain-text conversion to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay).toContain("Search Title");
		expect(result._yay).toContain("link label");
		expect(result._yay).toContain("const chunkValue = 123;");
		expect(result._yay).not.toContain("```");
		expect(result._yay).not.toContain("https://example.com");
	});

	test("keeps markdown table cells in plain text output", () => {
		const markdown = ["| Name | Value |", "| --- | --- |", "| one | 1 |", "| two | 2 |"].join("\n");

		const result = files_tiptap_markdown_to_plain_text({
			markdown,
		});
		if (result._nay) {
			throw new Error("Expected markdown table plain-text conversion to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay).toContain("Name");
		expect(result._yay).toContain("Value");
		expect(result._yay).toContain("one");
		expect(result._yay).toContain("1");
		expect(result._yay).toContain("two");
		expect(result._yay).toContain("2");
	});

	test("keeps underlined and highlighted text searchable", () => {
		const result = files_tiptap_markdown_to_plain_text({
			markdown: "<u>**A & B**</u> and ==*C & D*==",
		});

		expect(result._nay).toBeUndefined();
		expect(result._yay).toBe("A & B and C & D");
	});
});

describe("files_parse_markdown_to_html", () => {
	test.each([
		["highlight", "==*C & D*==", "<p><mark><em>C &amp; D</em></mark></p>\n"],
		// Other Markdown apps have no `++` underline.
		["`++` as plain text", "++**A & B**++ and C++", "<p>++<strong>A &amp; B</strong>++ and C++</p>\n"],
		["`==` with a space inside as plain text", "a == b == c", "<p>a == b == c</p>\n"],
	])("renders %s like the editor Markdown parser", (_name, markdown, expectedHtml) => {
		const result = files_parse_markdown_to_html(markdown);

		expect(result._nay).toBeUndefined();
		expect(result._yay).toBe(expectedHtml);
	});

	test("preserves trailing newline shape at EOF", () => {
		const noTrailingNewline = files_parse_markdown_to_html("hello");
		const oneTrailingNewline = files_parse_markdown_to_html("hello\n");
		const twoTrailingNewlines = files_parse_markdown_to_html("hello\n\n");
		const fourTrailingNewlines = files_parse_markdown_to_html("hello\n\n\n\n");

		if (noTrailingNewline._nay) {
			throw new Error("Expected markdown to HTML conversion without trailing newline to succeed", {
				cause: noTrailingNewline._nay,
			});
		}
		if (oneTrailingNewline._nay) {
			throw new Error("Expected markdown to HTML conversion with one trailing newline to succeed", {
				cause: oneTrailingNewline._nay,
			});
		}
		if (twoTrailingNewlines._nay) {
			throw new Error("Expected markdown to HTML conversion with two trailing newlines to succeed", {
				cause: twoTrailingNewlines._nay,
			});
		}
		if (fourTrailingNewlines._nay) {
			throw new Error("Expected markdown to HTML conversion with four trailing newlines to succeed", {
				cause: fourTrailingNewlines._nay,
			});
		}

		// One final `\n` is a plain line terminator, not an empty line; each extra
		// pair of newlines beyond it is one empty paragraph.
		expect(oneTrailingNewline._yay).toBe(noTrailingNewline._yay);
		expect(oneTrailingNewline._yay.match(/<p><\/p>/g) ?? []).toHaveLength(0);
		expect(twoTrailingNewlines._yay.match(/<p><\/p>/g) ?? []).toHaveLength(1);
		expect(fourTrailingNewlines._yay.match(/<p><\/p>/g) ?? []).toHaveLength(2);
	});

	test("preserves trailing space at EOF", () => {
		const noTrailingSpace = files_parse_markdown_to_html("hello");
		const oneTrailingSpace = files_parse_markdown_to_html("hello ");

		if (noTrailingSpace._nay) {
			throw new Error("Expected markdown to HTML conversion without trailing space to succeed", {
				cause: noTrailingSpace._nay,
			});
		}
		if (oneTrailingSpace._nay) {
			throw new Error("Expected markdown to HTML conversion with trailing space to succeed", {
				cause: oneTrailingSpace._nay,
			});
		}

		expect(oneTrailingSpace._yay).not.toBe(noTrailingSpace._yay);
	});

	test.each([
		["an ordered list", "1. a\n2. b\n\npara"],
		["a task list", "- [ ] a\n- [x] b\n\npara"],
	])("keeps the paragraph after %s", (_name, markdown) => {
		const html = files_parse_markdown_to_html(markdown);
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toContain("<p>para</p>");
	});

	test("keeps the text of a paragraph inside an ordered list item", () => {
		const html = files_parse_markdown_to_html("1. a\n\n   para text here\n");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toContain("<p>para text here</p>");
	});

	test("keeps an unclosed link tag in a list item out of the other paragraphs", () => {
		const html = files_parse_markdown_to_html(
			'see https://example.com first\n\n1. Open <a href="https://example.com/q">it\n',
		);
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toContain(
			'<p>see <a data-markdown-autolink="bare" href="https://example.com">https://example.com</a> first</p>',
		);
	});

	test("lets a close tag inside a highlight end the open link", () => {
		const html = files_parse_markdown_to_html(
			'<a href="https://example.com/a">a ==</a>== then https://example.com/b\n',
		);
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toContain(
			'<a data-markdown-autolink="bare" href="https://example.com/b">https://example.com/b</a>',
		);
	});

	test("reads more text of an ordered item in a bullet item as a paragraph", () => {
		const html = files_parse_markdown_to_html("- outer\n  1. inner one\n\n    inner more\n");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toContain("<p>inner more</p>");
	});

	test("splits a video line out of a paragraph", () => {
		const html = files_parse_markdown_to_html('Intro\n<video src="bonobo-file://k17abcdef"></video>\nOutro');
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toBe(
			'<p>Intro</p>\n<video data-markdown-tight="" src="bonobo-file://k17abcdef"></video><p data-markdown-tight="">Outro</p>\n',
		);
	});

	test("refuses Markdown that needs more work than the limit", () => {
		// Each `*` with no closing `*` makes Marked scan the rest of the paragraph.
		const html = files_parse_markdown_to_html("*a ".repeat(20_000), { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses paragraphs where each character is its own step", () => {
		// Marked ends a step at each `<`, and each step tries about a dozen patterns.
		const html = files_parse_markdown_to_html(("<".repeat(150) + "\n\n").repeat(3_400), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a long line that Marked reads again at each step to look for an email address", () => {
		const html = files_parse_markdown_to_html("a!".repeat(12_000), { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("keeps paragraphs full of `=` under the limit", () => {
		// The highlight search stops at the next `<`, so it does not read the rest of the paragraph at
		// each step like Tiptap's own search.
		const highlight = files_parse_markdown_to_html(("x" + "=<".repeat(1_000) + "\n\n").repeat(40), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(highlight._nay).toBeUndefined();
	});

	test.each([
		[
			"after other marks and code",
			"*a* ==b== _c_ `e` ==f==",
			'<em>a</em> <mark>b</mark> <em data-markdown-syntax="_">c</em> <code>e</code> <mark>f</mark>',
		],
		["after a leading `~~` run", "~~a ==b==", "~~a <mark>b</mark>"],
		["inside an email-like word", "a b!c==d==@e", "a b!c<mark>d</mark>@e"],
		["inside a code span", "``==a==``", "<code>==a==</code>"],
	])("finds highlight %s", (_name, markdown, paragraph) => {
		const html = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toBe(`<p>${paragraph}</p>\n`);
	});

	test("refuses open links that Marked reads to the end of the paragraph at each step", () => {
		// With no space, the link destination runs to the end of the paragraph.
		const html = files_parse_markdown_to_html(("x" + "[a](".repeat(1_250) + "\n\n").repeat(20), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses text full of characters that the renderer escapes", () => {
		const html = files_parse_markdown_to_html('"'.repeat(1_500_000), { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses URLs that Marked reads to the end of the paragraph at each step", () => {
		// Marked reads each URL to the next space, and reads it again to drop trailing punctuation.
		const html = files_parse_markdown_to_html(("x" + "http://a(".repeat(2_222) + "\n\n").repeat(4), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a URL full of entities that Marked drops one at a time", () => {
		// Marked's backpedal pattern reads the whole URL again for each `&b;` it drops from the end.
		const html = files_parse_markdown_to_html("www.a" + "&b;".repeat(6_000) + "\n", {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses code spans that never close", () => {
		// Each run of backticks has a new length, so Marked reads the rest of the paragraph for its closing run.
		let markdown = "x ";
		for (let length = 1; length <= 300; length++) {
			markdown += "`".repeat(length) + ",".repeat(2_500);
		}
		const html = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses many link definitions with many table cells", () => {
		// Marked lists every link definition again for each table cell.
		const definitions = Array.from({ length: 5_000 }, (_, i) => `[k${i}]: u`).join("\n");
		const table = "|a".repeat(30) + "|\n" + "|-".repeat(30) + "|\n" + ("|a".repeat(30) + "|\n").repeat(100);
		const html = files_parse_markdown_to_html(`${definitions}\n\n${table}`, { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("keeps each task item once after blank lines", () => {
		// Tiptap's task list skipped the blank lines before an item but left them out of its token.
		const html = files_parse_markdown_to_html("- [ ] a\n\n\n\n- [ ] b\n");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toBe(
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a</p></li></ul>' +
				'<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>b</p></li></ul>',
		);
	});

	test("refuses many blank lines inside a task item", () => {
		// Tiptap copies the rest of the list at each blank line inside an item.
		const html = files_parse_markdown_to_html("- [ ] a" + "\n".repeat(8_000) + "  b\n", {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a very deep task list", () => {
		// Tiptap parses each item's nested items again without Marked.
		const markdown = Array.from({ length: 940 }, (_, i) => "  ".repeat(i) + "- [ ] x").join("\n");
		const html = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("keeps a task list with outdented lines under the limit", () => {
		// Tiptap's task list ends before a line that is not indented under the item.
		const html = files_parse_markdown_to_html("  - [ ] a\n b\n".repeat(3_846), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay).toBeUndefined();
	});

	test("keeps paragraphs that end at headings under the limit", () => {
		// The video start search reads only the paragraph that Marked reads next.
		const html = files_parse_markdown_to_html(("a".repeat(40) + "\n# " + "h".repeat(40) + "\n").repeat(10_714), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay).toBeUndefined();
	});

	test("ends a paragraph where a table starts", () => {
		const html = files_parse_markdown_to_html("a\n|x|y|\n|-|-|\n|1|2|\nb\n");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).toMatch(/^<p>a<\/p>\n<table[\s>]/);
		expect(html._yay).toContain("<td>1</td>");
	});

	test("parses a paragraph of header and align lines quickly", () => {
		// Marked's paragraph rule read every later line at each line, to look for table rows. That took
		// about 9 seconds for this accepted input. The short table check only reads the next two lines.
		const markdown = "x\n" + ("<?" + "a".repeat(100) + "?>\n-|-\n").repeat(11_700);
		const start = performance.now();
		const html = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });
		const elapsed = performance.now() - start;

		expect(html._nay).toBeUndefined();
		expect(elapsed).toBeLessThan(1_500);
	});

	test("refuses a long paragraph inside a list item", () => {
		// Marked tries its setext heading pattern at every line of a list item.
		const html = files_parse_markdown_to_html("- a\n" + ("  " + "b".repeat(40) + "\n").repeat(2_400), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses quote lines mixed with lazy lines", () => {
		// Marked copies the rest of a blockquote's lines for each run of `>` lines.
		const html = files_parse_markdown_to_html(("> h\n" + "a".repeat(40) + "\n").repeat(5_000), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a quoted list with long lazy lines before it parses the rest again", () => {
		// In a quoted list, Marked joins and parses all the remaining text again for each run of `>` lines.
		const list = vi.spyOn(Tokenizer.prototype, "list");
		const html = files_parse_markdown_to_html(("> - x\n" + "y".repeat(1_000) + "\n").repeat(500), {
			cache: false,
			workLimit: 150_000_000,
		});
		const listCalls = list.mock.calls.length;
		list.mockRestore();

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
		expect(listCalls).toBeLessThan(100);
	});

	test("refuses many short lines inside a list item", () => {
		// Marked tries its setext heading pattern at every line, and each try tests many patterns per line.
		const html = files_parse_markdown_to_html("- a\n" + "  |x\n".repeat(3_000), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a wide table before it splits the rows", () => {
		// Marked pads every row to the header's column count, so 1,000 columns over 1,000 short rows
		// make 1,000,000 cells from 2 KB of rows.
		const inline = vi.spyOn(Lexer.prototype, "inline");
		const html = files_parse_markdown_to_html(
			"|a".repeat(1_000) + "|\n" + "|-".repeat(1_000) + "|\n" + "a\n".repeat(1_000),
			{
				cache: false,
				workLimit: 150_000_000,
			},
		);
		const inlineCalls = inline.mock.calls.length;
		inline.mockRestore();

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
		expect(inlineCalls).toBeLessThan(1_000);
	});

	test("refuses many references to one long link definition", () => {
		// Each `[a]` copies the whole URL into the HTML. 50 KB of text would make 20 MB of HTML.
		const html = files_parse_markdown_to_html(`[a]: http://x.y/${"a".repeat(50_000)}\n\n` + "[a]\n".repeat(400), {
			cache: false,
			workLimit: 150_000_000,
		});

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("refuses a deep ordered list with a long last item", () => {
		// Tiptap copies the text below each level of an ordered list. 190 KB here would copy about 15M
		// characters and use over 64 MB, which is past a Convex query's memory.
		const markdown =
			Array.from({ length: 300 }, (_, i) => "  ".repeat(i) + "1. " + (i === 299 ? "Њ".repeat(50_000) : "Њ")).join(
				"\n",
			) + "\n";
		const html = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });

		expect(html._nay?.message).toBe("Markdown needs too much work to parse");
	});

	test("keeps link definitions of one file out of the next file", () => {
		// Tiptap once kept one lexer across parses, so one file's link definitions reached the next file.
		files_parse_markdown_to_html("- [ ] a\n  [foo]: https://attacker.example/x\n", {
			cache: false,
			workLimit: 150_000_000,
		});
		const html = files_parse_markdown_to_html("- [ ] read [foo] now\n", { cache: false, workLimit: 150_000_000 });
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });

		expect(html._yay).not.toContain("attacker.example");
	});

	test("gives the same HTML with a work limit", () => {
		const markdown = "# Title\n\n1. **a**\n2. ==b==\n\n- [ ] task\n\n`code` and [link](https://example.com)\n";
		const withLimit = files_parse_markdown_to_html(markdown, { cache: false, workLimit: 150_000_000 });
		const withoutLimit = files_parse_markdown_to_html(markdown);
		if (withLimit._nay) throw new Error("Expected markdown parse to succeed", { cause: withLimit._nay });
		if (withoutLimit._nay) throw new Error("Expected markdown parse to succeed", { cause: withoutLimit._nay });

		expect(withLimit._yay).toBe(withoutLimit._yay);
		// A limited parse must not read or fill the private cache, which keeps every text for the process life.
		expect(withoutLimit).not.toBe(withLimit);
	});
});

describe("files_yjs_doc_update_from_text", () => {
	test("preserves trailing whitespace at EOF through the Yjs round-trip", () => {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			text: "hello ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		// The trailing space survives; serialized non-empty file content ends with one `\n`.
		expect(markdownResult._yay).toBe("hello \n");
	});

	test("preserves trailing whitespace-only line at EOF through the Yjs round-trip", () => {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			text: "# Base\n\n ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown with trailing whitespace-only line to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion with trailing whitespace-only line to succeed", {
				cause: markdownResult._nay,
			});
		}

		// The whitespace-only line survives; serialized non-empty file content ends with one `\n`.
		expect(markdownResult._yay).toBe("# Base\n\n \n");
	});
});

describe("frontmatter parsing via marked", () => {
	test("emits <pre data-frontmatter> for leading YAML frontmatter", () => {
		const html = files_parse_markdown_to_html("---\nfoo: bar\n---\n\nBody");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).toContain("<pre data-frontmatter>foo: bar</pre>");
	});

	test("escapes HTML special chars inside the frontmatter body", () => {
		const html = files_parse_markdown_to_html('---\nfrom: "Marcus Dane <marcus@example.com>"\n---\n');
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).toContain('<pre data-frontmatter>from: "Marcus Dane &lt;marcus@example.com&gt;"</pre>');
	});

	test("does not match a non-leading ---...--- block", () => {
		const html = files_parse_markdown_to_html("Some text.\n\n---\nfoo: bar\n---\n\nMore text.");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});

	test("does not close on a line that only starts with ---", () => {
		const html = files_parse_markdown_to_html("---\nfoo: bar\n---not-a-closing-marker\n\nBody");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});

	test("does not match frontmatter-like content inside a list item", () => {
		const html = files_parse_markdown_to_html("- ---\n  foo: bar\n  ---");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});
});

describe("frontmatter round-trip through Yjs", () => {
	test("preserves the AI-style mail frontmatter and body byte-for-byte", () => {
		const input = [
			"---",
			'to: ["ops@company.example"]',
			'cc: ["security@company.example","engineering@company.example"]',
			'from: "Marcus Dane <marcus.dane@company.example>"',
			'subject: "Access logs review — suspected burst"',
			'date: "2026-03-13"',
			'messageId: "<aurorareef-20260313-md-1@company.example>"',
			'threadId: "aurorareef-access-logs"',
			"---",
			"",
			"Hi team,",
			"",
			"We're seeing a short burst of failed authentication events around the `gateway-aurora` edge.",
			"",
		].join("\n");

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			text: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected frontmatter+body markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe(input);
	});

	test("preserves a frontmatter-only document", () => {
		const input = '---\nfoo: bar\nbaz: "qux"\n---';

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			text: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected frontmatter-only markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		// Only the usual POSIX final newline is added. The headless doc replace no longer
		// appends an empty trailing paragraph after a trailing atom block (that paragraph came
		// from `commands.setContent`'s ProseMirror replace step, and it surfaced as `\n\n`
		// after the closing fence). In the mounted editor a trailing atom is still editable:
		// select it and press Enter to get a paragraph after it.
		expect(markdownResult._yay).toBe(`${input}\n`);
	});

	test("does not invent a frontmatter node for a body-only document", () => {
		const input = "# Heading\n\nBody text\n";

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			text: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected body-only markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe(input);
	});
});

describe("media embeds round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected media markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	test("preserves a standalone image line", () => {
		const input = "![Wiring diagram](bonobo-file://k17abcdef)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves an image inside a paragraph without splitting it", () => {
		const input = "Before ![Shot](bonobo-file://k17abcdef) after.\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves an external image url", () => {
		const input = "![Logo](https://example.com/logo.png)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves an image title", () => {
		const input = '![Shot](bonobo-file://k17abcdef "Hover text")\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("escapes brackets in alt text so they cannot end the image early", () => {
		const input = "![Figure \\[1\\]](bonobo-file://k17abcdef)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps a url with parentheses in the angle-bracket form", () => {
		const input = "![Shot](<https://example.com/a(1).png>)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps how an image writes its address and title", () => {
		const input = "![a](<x y.png> 'T') ![b\\](c](bonobo-file://k17abcdef (T))\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test.each([
		// The image moves to a workspace file, like an upload of a pasted image does.
		["address", { src: "bonobo-file://k17abcdef" }, '![a](bonobo-file://k17abcdef "T")'],
		["title", { title: "U" }, '![a](x%20y.png "U")'],
	])("writes the default image form after the %s changes", (_name, change, expected) => {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: "![a](<x y.png> 'T')\n" } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		const image = editor._yay.state.doc.nodeAt(1);
		editor._yay.view.dispatch(editor._yay.state.tr.setNodeMarkup(1, undefined, { ...image?.attrs, ...change }));
		expect(files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay })).toBe(expected);
		editor._yay.destroy();
	});

	test("preserves a video line without adding a blank line", () => {
		const input = '<video src="bonobo-file://k17abcdef"></video>\n\nCaption text\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves a video between two paragraphs", () => {
		const input = 'Intro\n\n<video src="bonobo-file://k17abcdef"></video>\n\nOutro\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("escapes the video src attribute", () => {
		const input = '<video src="https://example.com/v.mp4?a=1&amp;b=2"></video>\n\nCaption text\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps an unresolvable file reference as opaque text", () => {
		// A hand-edited markdown file can name a file node that does not exist. The reference is
		// just a string here; only the client decides it cannot be resolved and shows a placeholder.
		const input = "![Gone](bonobo-file://not-a-real-id)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves a sized image in its raw img form", () => {
		const input = '<img src="bonobo-file://k17abcdef" alt="Shot" width="320">\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps a sized image inline in its paragraph", () => {
		const input = 'Before <img src="bonobo-file://k17abcdef" width="200"> after.\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves a video width", () => {
		const input = '<video src="bonobo-file://k17abcdef" width="480"></video>\n\nCaption text\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves a plain video as the last block", () => {
		// Guards the headless doc-replace path: `commands.setContent` used to append an empty
		// trailing paragraph after a trailing atom block, which grew a blank line here.
		const input = '<video src="bonobo-file://k17abcdef"></video>\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves an aligned image in its raw img form", () => {
		const input = '<img src="bonobo-file://k17abcdef" alt="Shot" width="320" align="center">\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves an aligned image without a width", () => {
		const input = '<img src="bonobo-file://k17abcdef" align="right">\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps the attributes of a file's image that the image node does not hold", () => {
		const input =
			'<img src="bonobo-file://k17abcdef" height="80">\n\nA <img src="bonobo-file://k17abcdef" alt="Logo" width="50%" align="left"> b\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	// Before, a plain `<img>` saved as `![…](…)`, and the attributes moved to a fixed order.
	test("keeps a file's img tag as written", () => {
		const input =
			'<img src="x.png" alt="a">\n\nA <img alt=\'a\' src=\'x.png\'/> b <IMG SRC="x.png" width="320"> c <image src="x.png">\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("writes the image's own img tag after a resize", () => {
		const editor = files_headless_tiptap_editor_create({
			initialContent: { markdown: "<img alt='a' src='x.png' width='320'>\n" },
		});
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		const image = editor._yay.state.doc.nodeAt(1);
		editor._yay.view.dispatch(editor._yay.state.tr.setNodeMarkup(1, undefined, { ...image?.attrs, width: 200 }));
		expect(files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay })).toBe(
			'<img src="x.png" alt="a" width="200">',
		);
		editor._yay.destroy();
	});

	test("preserves a video caption and alignment", () => {
		const input = '<video src="bonobo-file://k17abcdef" title="A red circle" width="480" align="center"></video>\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("preserves a raw img block followed by a video block", () => {
		// A copy re-parses the document's markdown and writes it again. If this round trip added
		// empty paragraphs between the two raw HTML blocks, every copy of a copy would add more.
		const input =
			'<img src="bonobo-file://k17abcdef" alt="Shot" width="586" align="right">\n\n<video src="bonobo-file://k17video"></video>\n\nCaption text\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("does not write the upload placeholder marker into markdown", () => {
		const editor = files_headless_tiptap_editor_create({
			initialContent: {
				json: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{
									type: "image",
									attrs: { src: "bonobo-file://k17abcdef", alt: "Shot", uploadId: "upload-1" },
								},
							],
						},
					],
				},
			},
		});
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}

		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();

		expect(markdown).toBe("![Shot](bonobo-file://k17abcdef)");
	});

	test("writes a sized image as a raw img tag", () => {
		const editor = files_headless_tiptap_editor_create({
			initialContent: {
				json: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{
									type: "image",
									attrs: { src: "bonobo-file://k17abcdef", alt: "Shot", width: 320 },
								},
							],
						},
					],
				},
			},
		});
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}

		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();

		expect(markdown).toBe('<img src="bonobo-file://k17abcdef" alt="Shot" width="320">');
	});

	test("writes an aligned captioned video as a raw video tag", () => {
		const editor = files_headless_tiptap_editor_create({
			initialContent: {
				json: {
					type: "doc",
					content: [
						{
							type: "video",
							attrs: { src: "bonobo-file://k17abcdef", title: "A red circle", width: 480, align: "center" },
						},
					],
				},
			},
		});
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}

		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();

		expect(markdown).toBe(
			'<video src="bonobo-file://k17abcdef" title="A red circle" width="480" align="center"></video>',
		);
	});
});

describe("links round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected link markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (editor: Editor) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		edit(editor._yay);
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();
		return saved + "\n";
	}

	test("keeps links to app files and to other apps", () => {
		const input =
			"[Doc](bonobo-file://k17abcdef), [draft](bonobo-file://private/k17abcdef) and [note](obsidian://open?vault=a)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps only the label of a link that could run code", () => {
		// A browser ignores a tab inside the scheme, so `java<tab>script:` runs as `javascript:`. Markdown
		// link syntax cannot hold a tab, so the HTML link carries it.
		expect(
			round_trip_markdown(
				'[a](JavaScript:alert(1)) <a href="java\tscript:alert(1)">b</a> [c](vbscript:x) [d](data:text/html,x)\n',
			),
		).toBe("a b c d\n");
	});

	test("keeps a bare or angle auto link as written", () => {
		const input = "See https://e.com/a_b?x=1*2, www.e.com/a~b, email_me@foo_bar.com and <https://e.com/x_y>\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("writes an auto link as a Markdown link once its text changes or holds another mark", () => {
		// Positions: the paragraph starts at 1, so the link text "https://e.com" runs from 1 to 14.
		const typed = edit_and_save("https://e.com\n", (editor) => {
			editor.view.dispatch(editor.state.tr.insertText("/x", 14));
		});
		expect(typed).toBe("[https://e.com/x](https://e.com)\n");

		const bold = edit_and_save("https://e.com\n", (editor) => {
			editor.view.dispatch(editor.state.tr.addMark(11, 14, editor.state.schema.marks.bold.create()));
		});
		expect(bold).toBe("[https://e.**com**](https://e.com)\n");
	});
});

describe("sub, sup and kbd round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected sub, sup and kbd markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	test("keeps the tags", () => {
		const input = "# H<sub>2</sub>O\n\nx<sup>2</sup>, a<sub>b<sup>c</sup></sub> and **<kbd>Ctrl</kbd>**+<kbd>C</kbd>\n";
		expect(round_trip_markdown(input)).toBe(input);
	});
});

describe("hidden HTML tags round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected hidden tag markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	test("keeps inline tags and comments that the editor cannot show", () => {
		const input =
			"# Draft <name>\n\nReplace <Owner> with Array<T>, call <Foo /> and close </div>. a <!-- note --> b\n\n- [ ] ask <who>\n\n| a | b |\n| --- | --- |\n| <x y=\"1\"> | c |\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("hides a known tag with an attribute that save would drop, and its closing tag", () => {
		// `<b and c>` reads as a `<b>` tag with two attributes. A shown bold tag lost "b and c" on save.
		const input =
			'if a<b and c>d, <span class="note">hi</span>, <a href="https://e.com" target="_blank">site</a>, <b class="x">a **bold** b</b> and a stray </i>\n\n<p><code class="c">x</code></p>\n\n| a |\n| --- |\n| <kbd title="t">K</kbd> |\n';
		expect(round_trip_markdown(input)).toBe(input);
		expect(files_tiptap_markdown_to_plain_text({ markdown: input })._yay).toContain("hi, site, a bold b");
		// An HTML block saves from its source until someone edits it. So check its content too.
		expect(JSON.stringify(files_tiptap_markdown_to_json({ markdown: input })._yay)).toContain(
			'{"type":"htmlTag","attrs":{"html":"<code class=\\"c\\">"}}',
		);
	});

	test("keeps a hidden tag or an image inside the bold or link around it", () => {
		// Yjs and the Markdown writer used to drop the marks of these inline nodes. A linked image lost its link.
		const input =
			'**<a href="https://e.com" target="_blank">x</a>** and a **b <span class="x">c</span>**, [<span class="x">d</span>](https://e.com) [![i](https://e.com/i.png)](https://e.com/page) **e ![j](https://e.com/j.png)**\n';
		expect(round_trip_markdown(input)).toBe(input);
	});
});

describe("HTML entities round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected entity markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (editor: Editor) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		edit(editor._yay);
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();
		return saved + "\n";
	}

	test("keeps each entity as the file writes it", () => {
		const input =
			"# Q&amp;A &copy;\n\nTom &amp; Jerry, &copy; 2026 &mdash; a&nbsp;b, a&nbsp;&nbsp;b, &#169; &#x2014;, say &quot;hi&quot;, use &lt;div&gt; here, a &foo; b.\n\n**R&amp;D** and [R&amp;D](https://e.com) and <kbd>Ctrl&amp;</kbd>\n\n- &nbsp;\n\n| a | b |\n| --- | --- |\n| R&amp;D | &copy; |\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps a raw &, < and > unless they would read as markup", () => {
		const input =
			"# Q&A\n\nTom & Jerry, AT&T, a < b > c, a <= b, 1 > 0 and trailing &\n\n**R&D** and [R&D](https://e.com/?a=1&b=2)\n";
		expect(round_trip_markdown(input)).toBe(input);

		const typed = edit_and_save("a\n", (editor) => {
			const { schema } = editor.state;
			const tr = editor.state.tr.insertText(" &copy; <div> a<b c < d R&D x> <1@b.co>", 2);
			tr.insert(tr.doc.content.size, schema.nodes.paragraph.create(null, schema.text("> not a quote")));
			editor.view.dispatch(tr);
		});
		expect(typed).toBe("a &amp;copy; &lt;div> a&lt;b c < d R&D x> &lt;1@b.co>\n\n\\> not a quote\n");
	});

	test("writes a changed entity character as plain text", () => {
		const saved = edit_and_save("&copy; a&nbsp;b\n", (editor) => {
			// Type right after and right before the ©, then replace the no-break space.
			editor.view.dispatch(editor.state.tr.insertText("x", 2));
			editor.view.dispatch(editor.state.tr.insertText("y", 1));
			editor.view.dispatch(editor.state.tr.insertText("-", 6, 7));
		});
		expect(saved).toBe("y&copy;x a-b\n");
	});

	test("keeps entities through the editor's own HTML, like a copy and paste", () => {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: "a&nbsp;&nbsp;b &copy;\n" } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}
		const html = tiptap_generateHTML_server(editor._yay.getJSON(), Object.values(files_get_tiptap_shared_extensions()));
		editor._yay.destroy();

		const pasted = files_headless_tiptap_editor_create({
			initialContent: { json: files_tiptap_html_to_json({ html }) },
		});
		if (pasted._nay) {
			throw new Error("Expected the editor to load the HTML", { cause: pasted._nay });
		}
		expect(files_headless_tiptap_editor_get_markdown({ mut_editor: pasted._yay })).toBe("a&nbsp;&nbsp;b &copy;");
		pasted._yay.destroy();
	});
});

describe("Markdown escapes and line breaks round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected escape markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (editor: Editor) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		edit(editor._yay);
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();
		return saved + "\n";
	}

	test("keeps each escape and the plain `++` and `==` text as the file writes it", () => {
		const input = "# C\\# \\(a+b\\)\n\n2026\\-08\\-30, \\*a\\*, \\&copy;, I know C++ and C++17, x == 1 or y == 2\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("escapes typed text only where it would read as Markdown", () => {
		const typed = edit_and_save("## Issue\n\na\n", (editor) => {
			// Type at the paragraph end first, so the heading edit does not move its position.
			const tr = editor.state.tr.insertText(" snake_case C:\\Users 5 * 3 x == y *b* [c] `d` ==e==", 9);
			tr.insertText(" #", 6);
			editor.view.dispatch(tr);
		});
		expect(typed).toBe("## Issue \\#\n\na snake_case C:\\Users 5 * 3 x == y \\*b\\* \\[c\\] \\`d\\` \\=\\=e==\n");

		const json = files_tiptap_markdown_to_json({ markdown: typed });
		expect(JSON.stringify(json._yay)).not.toMatch(/"type":"(italic|code|highlight)"/);
		expect(files_tiptap_markdown_to_plain_text({ markdown: typed })._yay).toContain("Issue #");
	});

	test("escapes a `*` whose space moves outside the bold marks", () => {
		// Save moves the space at the end of the bold text outside the `**`, so `* ` is not between spaces.
		const bold = edit_and_save("a\n", (editor) => {
			const { schema } = editor.state;
			editor.view.dispatch(
				editor.state.tr.insert(2, [schema.text(" x * ", [schema.marks.bold.create()]), schema.text("y")]),
			);
		});
		expect(bold).toBe("a **x \\*** y\n");
	});

	test("keeps each line break style, and writes a new break with a backslash", () => {
		const input = "a  \nb\\\nc<br>d\n";
		expect(round_trip_markdown(input)).toBe(input);

		const typed = edit_and_save("a\n", (editor) => {
			const { schema } = editor.state;
			editor.view.dispatch(editor.state.tr.insert(2, [schema.nodes.hardBreak.create(), schema.text("b")]));
		});
		expect(typed).toBe("a\\\nb\n");
	});

	test("keeps a soft line break between a mark and a tag or image", () => {
		const input =
			'*a*\n<u>b</u> `c`\n<mark>d</mark> **e**\n![i](https://e.com/i.png) f<br>\n<span class="g">h</span>\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test.each([
		"use my_var and __dirname\n",
		"glob **/*.ts and *.md\n",
		"~/projects and ~50% off\n",
		"[TODO] fix login\n",
		"[10:00] <alice> hi and </3\n",
		'100*2 = 200 and ==<span class="x">b</span>==\n',
	])("writes %j without escapes it does not need", (input) => {
		expect(round_trip_markdown(input)).toBe(input);
	});
});

describe("mark syntax round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected bold markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (editor: Editor) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}

		edit(editor._yay);
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();
		return saved + "\n";
	}

	test("keeps each mark syntax as the file writes it", () => {
		const input = [
			"a <b>x</b> <strong>y</strong> <i>z</i> <em>w</em> <B>q</B> __u__ _v_ ___t___ **s** *r*",
			"<s>x</s> <del>y</del> <strike>z</strike> <S>q</S> ~t~ ~~u~~ <code>npm run dev</code> `v`",
			"<mark>a=b</mark> <MARK>m</MARK> ==h==",
			'<a href="https://e.com" title="T">x</a> <a href=\'#top\'>y</a> [z](#z) <A HREF="#w">w</A>\n',
		].join("\n\n");
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("writes stars where typed text would stop underscores from reading as bold or italic", () => {
		const saved = edit_and_save("_x_ __y__ _z_\n", (editor) => {
			const { schema } = editor.state;
			// Insert from the end, so each insert keeps the positions of the ones before it.
			const tr = editor.state.tr.insert(6, schema.text("_", [schema.marks.italic.create({ markdownSyntax: "_" })]));
			tr.insert(3, schema.text("b"));
			tr.insert(2, schema.text("a"));
			editor.view.dispatch(tr);
		});
		expect(saved).toBe("*x*a b**y** *z_*\n");
	});

	test("writes backticks and `~~` where typed text would read differently inside a tag or `~`", () => {
		const saved = edit_and_save("<code>ab</code> ~x~\n", (editor) => {
			const { schema } = editor.state;
			const tr = editor.state.tr.insert(5, schema.text("~", [schema.marks.strike.create({ markdownSyntax: "~" })]));
			tr.insert(2, schema.text("*", [schema.marks.code.create({ markdownSyntax: "<code>" })]));
			editor.view.dispatch(tr);
		});
		expect(saved).toBe("`a*b` ~~x\\~~~\n");
	});

	test("keeps how a link writes its address and title", () => {
		const input =
			"[a](<https://e.com/a b> 'T') [b](https://e.com (T)) [c\\](d]( https://e.com/ä ) [e](https://e.com)\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("writes the default link form after the address changes", () => {
		const saved = edit_and_save("[a](<https://e.com/a b> 'T')\n", (editor) => {
			const { schema } = editor.state;
			const link = editor.state.doc.nodeAt(1)?.marks.find((mark) => mark.type === schema.marks.link);
			if (!link) {
				throw new Error("Expected a link");
			}
			// Keep the other attributes, like changing the address in the link editor does.
			const changed = schema.marks.link.create({ ...link.attrs, href: "https://f.com" });
			editor.view.dispatch(editor.state.tr.removeMark(1, 2, link).addMark(1, 2, changed));
		});
		expect(saved).toBe('[a](https://f.com "T")\n');
	});

	test("keeps links and other marks around a code span", () => {
		const input = "[`a`](https://e.com) **x `b` y** *`c`* ~~`d`~~ <u>`e`</u>\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("closes a code span where a mark starts inside it", () => {
		const saved = edit_and_save("`abc`\n", (editor) => {
			editor.view.dispatch(editor.state.tr.addMark(2, 3, editor.state.schema.marks.bold.create()));
		});
		expect(saved).toBe("`a`**`b`**`c`\n");
	});

	test("saves a comment to Yjs without Node's Buffer, like Convex", () => {
		const input = 'a <span data-type="comment" data-lb-thread-id="t1">c</span>\n';
		vi.stubGlobal("Buffer", undefined);
		try {
			expect(round_trip_markdown(input)).toBe(input);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("block syntax round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	test.each(["***", "___", "* * *", "- - -"])("keeps a rule written as %j", (rule) => {
		const input = `a\n\n${rule}\n\nb\n`;
		expect(round_trip_markdown(input)).toBe(input);
	});

	test.each([
		// Without the blank line, the `---` turned the item's text into a heading on the next load.
		["a rule", "- a\n\n  ---\n"],
		["a code block", "- a\n\n  ```\n  x\n  ```\n"],
		["a code block in an ordered item", "1. a\n\n   ```\n   x\n   ```\n"],
		["a code block in a task item", "- [ ] a\n\n  ```\n  x\n  ```\n"],
	])("keeps a blank line before %s in a list item", (_name, input) => {
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("keeps a list item without blank lines tight", () => {
		const input = "- a\n  ```\n  x\n\n  y\n  ```\n";
		expect(round_trip_markdown(input)).toBe(input);
	});

	test.each([
		["the same number on every item", "1. a\n1. b\n"],
		// Before, a list that started at 0 saved from 1.
		["a list that starts at 0", "0. a\n1. b\n"],
		["a list that numbers every item 0", "0) a\n0) b\n"],
		// Before, a save wrote one space after each marker.
		["3 spaces after each bullet", "-   a\n    -   b\n-\n-   c\n"],
		["2 spaces after each number", "1.  a\n2.  b\n"],
		["a paragraph under a wide bullet", "-   a\n\n    more\n"],
		["a wide space next to text under the marker", "-\n    a\n-   b\n"],
		// Before, a save wrote `\[ ]`, so other apps stopped showing a checkbox.
		["a task box in a numbered item", "1. [ ] a\n2. [x] b\n"],
		["a task box at the start of a paragraph", "[ ] a\n"],
		["a `*` task bullet", "* [ ] a\n* [x] b\n"],
		// Before, a save wrote `[X]` as `[x]`.
		["an upper-case `[X]`", "- [X] a\n- [x] b\n  - [X] c\n"],
		["an empty bullet item", "- a\n-\n- c\n"],
		// Before, the empty item ended the list, and `3. c` started a second list.
		["an empty ordered item", "1. a\n2.\n3. c\n"],
		["a list nested with 4 spaces", "- a\n    - b\n        - c\n"],
		["an ordered list nested with 4 spaces", "1. a\n    1. b\n"],
		["a paragraph indented 4 spaces in an item", "- a\n\n    more\n"],
		["a `~~~` fence", "~~~js\ncode\n~~~\n"],
		["a longer fence", "````\ncode\n````\n"],
		["a space before the language", "``` js\ncode\n```\n"],
		// Before, a save dropped the info string after the language.
		["the info string after the language", '```ts title="a" {1,3}\ncode\n```\n'],
		["a backtick in a `~~~` fence's info string", "~~~sh a`b &amp;\ncode\n~~~\n"],
		["spaces after a fence's language", "```ts  \ncode\n```\n"],
		// Before, a save dropped the spaces before a fence.
		["an indented fence", "   ```ts\n   x\n\n   y\n   ```\n"],
		["an indented `~~~` fence", " ~~~\n x\n ~~~\n"],
		["an indented code block", "a\n\n    code\n\n    more\n"],
		["heading closing marks", "## a ##\n"],
		["a heading underline", "a\n=\n"],
		// Before, the block moved out of the list, and `- # a` split the list in two.
		["a heading that starts a list item", "- # a\n- b\n"],
		["a fence that starts a list item", "- ```\n  code\n  ```\n"],
		["a list that starts a list item", "- - a\n"],
		["a list under an empty list item", "-\n  - a\n"],
		["a heading under an empty list item", "-\n  # a\n"],
		// Before, a save moved the text up to the marker line.
		["text on the line under a list item's marker", "-\n  a\n  b\n-\n  c\n"],
		["text on the line under a wide number", "10.\n    a\n"],
		// Before, the heading became text, and a fence changed on every save.
		["a heading that starts a numbered item", "1. # a\n2. b\n"],
		["a fence that starts a numbered item", "1. ```\n   code\n   ```\n"],
		// Before, a save changed the indent of a wrapped line in a list item.
		["a wrapped line indented 4 spaces in an item", "- a\n    b\n"],
		["a wrapped line indented 4 spaces in an ordered item", "1. a\n    b\n"],
		["a wrapped line in a task item", "- [ ] a\n  b\n"],
		["a wrapped line indented 6 spaces in a task item", "- [ ] a\n      b\n"],
		["a wrapped line before a nested task item", "- [ ] a\n  b\n  - [ ] c\n"],
		["a wrapped line in a nested task item", "- [ ] a\n  - [ ] b\n    c\n"],
		["a wrapped line before a list nested with 4 spaces", "- a\n  b\n    - c\n"],
		// Before, a save wrote `2\.`, but `2.` cannot start a list there.
		["a line that starts with `2.` in a paragraph", "Version\n2. x\n"],
		// Before, a save put a blank line between every two blocks.
		["text right under a heading", "# h\ntext\n"],
		["a blank line between a heading and its text", "# h\n\ntext\n"],
		// Before, a save dropped an empty heading.
		["an empty heading", "a\n\n##\n\nb\n"],
		// Before, a save wrote one space after `#` and dropped the closing marks of an empty heading.
		["spaces after a heading's opening marks", "#   a\n\n##\ta  ##\n\n## ##\n"],
		["a list right under text", "Intro:\n- a\n- b\n"],
		["a fence right under text, and text under it", "text\n```\ncode\n```\nmore\n"],
		["text right under a heading in a quote", "> # h\n> text\n"],
		// Before, a save put a space after each quote's `>`.
		["no space after a quote's marker", ">a\n>\n># h\n>- b\n"],
		["email style nested quotes", "> a\n>> b\n>>> c\n"],
		["an indented code block in a quote with no space after its marker", ">a\n>\n>     code\n"],
		// Before, a save put a blank line before the text, and before each block of a loose item.
		["text right under a heading in a list item", "- # a\n  text\n"],
		["a blank line between a heading and its text in a list item", "- # a\n\n  text\n"],
		["text right under a fence in a list item", "- a\n  ```\n  x\n  ```\n  more\n"],
		["text right under a heading in a task item", "- [ ] a\n  # h\n  text\n"],
		["text right under a rule in a loose list item", "- a\n\n  ***\n  text\n"],
		["a heading right under text in a loose list item", "- a\n\n  b\n  # h\n"],
	])("keeps %s", (_name, input) => {
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("puts a blank line back when an edit would join two blocks", () => {
		const json = files_tiptap_markdown_to_json({ markdown: "# h\ntext\n" });
		if (json._nay) {
			throw new Error("Expected markdown to parse", { cause: json._nay });
		}

		// Turn the heading into a paragraph. Right under it, `text` would join it.
		const heading = json._yay.content?.[0];
		if (!heading) {
			throw new Error("Expected a heading");
		}
		heading.type = "paragraph";
		heading.attrs = {};

		const editor = files_headless_tiptap_editor_create({ initialContent: { json: json._yay } });
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}
		expect(files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay })).toBe("h\n\ntext");
		editor._yay.destroy();
	});

	test("keeps a quote's marker with no space only when all its lines of that kind have none", () => {
		const quoteAttrs = (markdown: string) => {
			const json = files_tiptap_markdown_to_json({ markdown });
			if (json._nay) {
				throw new Error("Expected markdown to parse", { cause: json._nay });
			}
			const { markdownTextMarker, markdownNestedMarker } = json._yay.content?.[0]?.attrs ?? {};
			return { markdownTextMarker, markdownNestedMarker };
		};

		// A quote with one kind of line has no style for the other kind.
		expect(quoteAttrs(">a\n")).toEqual({ markdownTextMarker: ">", markdownNestedMarker: null });
		expect(quoteAttrs(">>a\n")).toEqual({ markdownTextMarker: null, markdownNestedMarker: ">" });
		expect(quoteAttrs("> a\n>b\n")).toEqual({ markdownTextMarker: null, markdownNestedMarker: null });
	});

	test("writes one space after each list marker when the items do not agree", () => {
		// The numbers line up their text, so the space after them is not a style to keep.
		expect(round_trip_markdown("9.  a\n10. b\n")).toBe("9. a\n10. b\n");
	});

	test("puts a blank line back when an edit would join two blocks in a list item", () => {
		const json = files_tiptap_markdown_to_json({ markdown: "- # h\n  text\n" });
		if (json._nay) {
			throw new Error("Expected markdown to parse", { cause: json._nay });
		}

		// Turn the heading into a paragraph. Right under it, `text` would join it. The item starts with an empty
		// paragraph, so the heading is its second block.
		const heading = json._yay.content?.[0]?.content?.[0]?.content?.[1];
		if (!heading) {
			throw new Error("Expected a heading");
		}
		heading.type = "paragraph";
		heading.attrs = {};

		const editor = files_headless_tiptap_editor_create({ initialContent: { json: json._yay } });
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}
		expect(files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay })).toBe("- h\n\n  text");
		editor._yay.destroy();
	});
});

describe("HTML blocks round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected HTML block markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (mut_content: TiptapJSONContent[]) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}
		const json = editor._yay.getJSON();
		editor._yay.destroy();

		edit(json.content ?? []);
		const edited = files_headless_tiptap_editor_create({ initialContent: { json } });
		if (edited._nay) {
			throw new Error("Expected the editor to load the edited document", { cause: edited._nay });
		}
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: edited._yay });
		edited._yay.destroy();
		return saved + "\n";
	}

	test("keeps comment blocks and other HTML blocks", () => {
		const input =
			'<!-- note -->\n\n<!--\nline one\n\nline two\n-->\n\n<div>\nhello <b>x</b> **raw** <name>\n</div>\n\n<p align="center">\n  <img src="https://example.com/x.png" width="100">\n</p>\n\n<center>Title</center>\n\n<section>\n\n# Heading\n\n</section>\n\n<script>alert(1)</script>\n\n> <!-- quoted -->\n\nText\n\n<!-- unclosed\n';
		expect(round_trip_markdown(input)).toBe(input);
	});

	test("writes an edited HTML block as HTML and keeps its tags", () => {
		const saved = edit_and_save('<div align="center">\n  hello <name> **raw** a&amp;b\n</div>\n', (content) => {
			const text = content[0]?.content?.find((node) => node.text?.includes("hello"));
			if (!text?.text) {
				throw new Error("Expected the block text");
			}
			text.text = text.text.replace("hello", "hi");
		});

		expect(saved).toBe('<div align="center">\n  hi <name> **raw** a&amp;b\n</div>\n');
		expect(round_trip_markdown(saved)).toBe(saved);
	});

	test("has an HTML writer branch for every inline node and mark type", () => {
		const schema = getSchema(Object.values(files_get_tiptap_shared_extensions()));
		const inlineNodeTypes = Object.values(schema.nodes).filter((type) => type.isInline);
		// A new inline node or mark type needs a branch in `html_render_inline`. Add it there, then here.
		expect(inlineNodeTypes.map((type) => type.name).sort()).toEqual(["hardBreak", "htmlTag", "image", "text"]);
		expect(Object.keys(schema.marks).sort()).toEqual([
			"bold",
			"code",
			"highlight",
			"htmlEntity",
			"italic",
			"kbd",
			"link",
			"liveblocksCommentMark",
			"markdownEscape",
			"strike",
			"subscript",
			"superscript",
			"textStyle",
			"underline",
		]);

		const markAttrs: Record<string, Record<string, string>> = {
			link: { href: "https://example.com" },
			highlight: { color: "yellow" },
			textStyle: { color: "red" },
			liveblocksCommentMark: { threadId: "thread-1" },
		};
		const content: TiptapJSONContent[] = [
			{ type: "htmlTag", attrs: { html: "<div>\n" } },
			...Object.keys(schema.marks)
				// HTML has no backslash escapes, so an escape mark writes plain text there and does not come back.
				.filter((markType) => markType !== "htmlEntity" && markType !== "markdownEscape")
				.map((markType) => ({
					type: "text",
					text: `${markType} `,
					marks: [{ type: markType, attrs: markAttrs[markType] ?? {} }],
				})),
			// An entity mark is on its own character only.
			{ type: "text", text: "©", marks: [{ type: "htmlEntity", attrs: { source: "&copy;", text: "©" } }] },
			{ type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] },
			{ type: "hardBreak" },
			{ type: "image", attrs: { src: "https://example.com/x.png", alt: "x" } },
			{ type: "htmlTag", attrs: { html: "\n</div>" } },
		];
		const saved = edit_and_save("<div>\nold\n</div>\n", (mut_content) => {
			mut_content[0]!.content = content;
		});

		const parsed = files_tiptap_markdown_to_json({ markdown: saved });
		if (parsed._nay) {
			throw new Error("Expected the saved block to parse", { cause: parsed._nay });
		}
		const shape = (nodes: TiptapJSONContent[]) =>
			nodes.map((node) => [node.type, node.text, node.marks?.map((mark) => mark.type)]);
		expect(shape(parsed._yay.content?.[0]?.content ?? [])).toEqual(shape(content));
	});
});

describe("GFM tables round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected table markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	// A table that loses its column count comes back from marked as a plain paragraph, and the parse
	// keeps the paragraph's newlines, so the pipe lines survive in the text. Looking for a delimiter
	// row in the output would therefore pass on a document with no table in it. Parse the output back
	// and look for the node instead.
	function expect_still_a_table(markdown: string) {
		const json = files_tiptap_markdown_to_json({ markdown });
		if (json._nay) {
			throw new Error("Expected table markdown to parse", { cause: json._nay });
		}

		expect(JSON.stringify(json._yay)).toContain('"type":"table"');
	}

	test("round-trips a canonical table byte for byte", () => {
		const output = round_trip_markdown(table_canonical_2x2);
		expect(output).toBe(table_canonical_2x2);
		expect_still_a_table(output);
	});

	test("keeps the alignment colons of every column", () => {
		const output = round_trip_markdown(table_alignments);
		expect(output).toBe(table_alignments);
		expect_still_a_table(output);
	});

	test("keeps an escaped pipe inside a cell", () => {
		const output = round_trip_markdown(table_pipe_in_cell);
		expect(output).toBe(table_pipe_in_cell);
		expect_still_a_table(output);
	});

	test("keeps a backslash before a pipe without destroying the table", () => {
		// Without `expect_still_a_table` this test would pass while the table was gone: a degraded
		// paragraph keeps its pipe lines verbatim, so a text match alone proves nothing.
		const output = round_trip_markdown(table_backslash_before_pipe);
		expect(output).toBe(table_backslash_before_pipe);
		expect_still_a_table(output);
	});

	test("keeps an empty cell and its column", () => {
		const output = round_trip_markdown(table_empty_cell);
		expect(output).toBe(table_empty_cell);
		expect_still_a_table(output);
	});

	test("keeps bold, code with an escaped pipe, and a link inside cells", () => {
		const output = round_trip_markdown(table_inline_marks);
		expect(output).toBe(table_inline_marks);
		expect_still_a_table(output);
	});

	test("keeps a comment span inside a cell", () => {
		const output = round_trip_markdown(table_comment_span);
		expect(output).toBe(table_comment_span);
		expect_still_a_table(output);
	});

	test("keeps a hard break inside a cell as <br>", () => {
		const output = round_trip_markdown(table_hard_break);
		expect(output).toBe(table_hard_break);
		expect_still_a_table(output);
	});

	test("keeps a table between two paragraphs", () => {
		const output = round_trip_markdown(table_between_paragraphs);
		expect(output).toBe(table_between_paragraphs);
		expect_still_a_table(output);
	});

	test("keeps a table that is the last block", () => {
		const output = round_trip_markdown(table_last_block);
		expect(output).toBe(table_last_block);
		expect_still_a_table(output);
	});

	test("writes a code span holding a backslash before a pipe as an HTML code element, stable", () => {
		// The backtick form cannot store this content: the backslash run would grow on every save.
		// The serializer writes the span as `<code>` with numeric character references instead.
		const expected = "| <code>x &#92;&#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |\n";
		const output = round_trip_markdown(table_code_span_backslash);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(round_trip_markdown(output)).toBe(output);
	});

	test("disarms markdown syntax inside the HTML code element form, stable", () => {
		// Between the written code tags the text is ordinary inline markdown to marked, so an
		// unescaped `**b**` would come back as bold and the asterisks would be deleted.
		const expected = "| <code>a &#42;&#42;b&#42;&#42; &#92;&#92;&#124; c</code> | d |\n| --- | --- |\n| 1 | 2 |\n";
		const output = round_trip_markdown(table_code_span_markdown_active);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(round_trip_markdown(output)).toBe(output);
	});

	test("keeps the exact text and code mark of the HTML code element form", () => {
		const json = files_tiptap_markdown_to_json({
			markdown: "| <code>x &#92;&#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |\n",
		});
		if (json._nay) {
			throw new Error("Expected the entity code form to parse", { cause: json._nay });
		}

		const flat = JSON.stringify(json._yay);
		expect(flat).toContain('"type":"table"');
		expect(flat).toContain(JSON.stringify("x \\\\| y"));
		expect(flat).toContain('"type":"code"');
	});

	// Before, save rewrote every row and the divider as `| a | b |` and `| --- |`.
	test.each([
		["a ragged table", table_ragged],
		["a table without outer pipes", table_no_outer_pipes],
		["column padding", table_padded_cells],
		["a short divider", "| a |\n| - |\n| b |\n"],
		["compact rows", "|a|b|\n|-|-|\n|c|d|\n"],
		["a row with fewer cells", "| a | b |\n|-|-|\n| c |\n"],
		["an escaped pipe in a compact row", "|a|\n|-|\n|x \\| y|\n"],
	])("keeps %s as written", (_name, input) => {
		const output = round_trip_markdown(input);
		expect(output).toBe(input);
		expect_still_a_table(output);
	});

	test("rewrites only the edited row and keeps the divider while the alignments stay", () => {
		const json = files_tiptap_markdown_to_json({ markdown: "| a  | b |\n|:-|-|\n| c  | d |\n| e  | f |\n" });
		if (json._nay) {
			throw new Error("Expected table markdown to parse", { cause: json._nay });
		}

		const table = json._yay.content?.[0];
		const cell = table?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0];
		if (!cell) {
			throw new Error("Expected a body cell");
		}
		cell.text = "edited";

		expect(build_markdown_from_json(json._yay)).toBe("| a  | b |\n|:-|-|\n| edited | d |\n| e  | f |");

		for (const row of table?.content ?? []) {
			const firstCell = row.content?.[0];
			if (firstCell) {
				firstCell.attrs = { ...firstCell.attrs, align: "center" };
			}
		}
		expect(build_markdown_from_json(json._yay)).toBe("| a  | b |\n| :---: | --- |\n| edited | d |\n| e  | f |");
	});

	test("keeps a table inside a list item", () => {
		const expected = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n";
		const output = round_trip_markdown(table_in_list_item);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(round_trip_markdown(output)).toBe(output);
	});

	function build_markdown_from_json(json: Record<string, unknown>) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { json } });
		if (editor._nay) {
			throw new Error("Expected headless editor creation to succeed", { cause: editor._nay });
		}

		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		editor._yay.destroy();
		return markdown;
	}

	function make_table_row(cellType: "tableCell" | "tableHeader", texts: string[]) {
		return {
			type: "tableRow",
			content: texts.map((text) => ({
				type: cellType,
				content: [{ type: "paragraph", content: [{ type: "text", text }] }],
			})),
		};
	}

	test("writes an empty header row for a table with no header row", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [make_table_row("tableCell", ["a", "b"]), make_table_row("tableCell", ["1", "2"])],
				},
			],
		});
		expect(markdown).toBe("|  |  |\n| --- | --- |\n| a | b |\n| 1 | 2 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("joins a multi-paragraph cell with <br>", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						make_table_row("tableHeader", ["A", "B"]),
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{ type: "paragraph", content: [{ type: "text", text: "one" }] },
										{ type: "paragraph", content: [{ type: "text", text: "two" }] },
									],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
								},
							],
						},
					],
				},
			],
		});
		expect(markdown).toBe("| A | B |\n| --- | --- |\n| one<br>two | 2 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("keeps a backslash that ends a non-final cell paragraph, stable", () => {
		// An unescaped backslash right before the <br> join would escape the "<" on the next parse
		// and turn the break into literal text.
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						make_table_row("tableHeader", ["A", "B"]),
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{ type: "paragraph", content: [{ type: "text", text: "one\\" }] },
										{ type: "paragraph", content: [{ type: "text", text: "two" }] },
									],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
								},
							],
						},
					],
				},
			],
		});
		expect(markdown).toBe("| A | B |\n| --- | --- |\n| one&#92;<br>two | 2 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("keeps a backslash right before a hard break in a cell, stable", () => {
		// The newline join must not eat the member's own backslash. In a cell a hard break is
		// written as `<br>`, so any backslash next to it belongs to the text.
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						make_table_row("tableHeader", ["A", "B"]),
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "a\\" }, { type: "hardBreak" }, { type: "text", text: "b" }],
										},
									],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
								},
							],
						},
					],
				},
			],
		});
		expect(markdown).toBe("| A | B |\n| --- | --- |\n| a&#92;<br>b | c |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("writes a table with a colspan cell as an HTML table", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									attrs: { colspan: 2 },
									content: [{ type: "paragraph", content: [{ type: "text", text: "X" }] }],
								},
							],
						},
						make_table_row("tableCell", ["1", "2"]),
					],
				},
			],
		});
		expect(markdown).toBe('<table>\n<tr><th colspan="2">X</th></tr>\n<tr><td>1</td><td>2</td></tr>\n</table>');
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("measures the table by its widest row, so a narrow first row loses no cell", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [make_table_row("tableCell", ["Quarterly results"]), make_table_row("tableCell", ["Q1", "1000"])],
				},
			],
		});
		expect(markdown).toBe("|  |  |\n| --- | --- |\n| Quarterly results |  |\n| Q1 | 1000 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("writes a table with a rowspan cell as an HTML table", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						make_table_row("tableHeader", ["Region", "Rep"]),
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									attrs: { rowspan: 2 },
									content: [{ type: "paragraph", content: [{ type: "text", text: "EU" }] }],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "Ann" }] }],
								},
							],
						},
						make_table_row("tableCell", ["Bob"]),
					],
				},
			],
		});
		expect(markdown).toBe(
			'<table>\n<tr><th>Region</th><th>Rep</th></tr>\n<tr><td rowspan="2">EU</td><td>Ann</td></tr>\n<tr><td>Bob</td></tr>\n</table>',
		);
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("serializes direct code-marked JSON with a backslash before a pipe, stable", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "x \\| y", marks: [{ type: "code" }] }],
										},
									],
								},
								{
									type: "tableHeader",
									content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
								},
							],
						},
						make_table_row("tableCell", ["1", "2"]),
					],
				},
			],
		});
		expect(markdown).toBe("| <code>x &#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("serializes code-marked text holding a backtick and a backslash-pipe, stable", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "x ` \\| y", marks: [{ type: "code" }] }],
										},
									],
								},
								{
									type: "tableHeader",
									content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
								},
							],
						},
						make_table_row("tableCell", ["1", "2"]),
					],
				},
			],
		});
		// The backtick is escaped too: a lone backtick is inert, but a pair would form a code span
		// on the next parse, so every non-alphanumeric character takes the numeric-reference form.
		expect(markdown).toBe("| <code>x &#96; &#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |");
		expect_still_a_table(markdown);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");
	});

	test("writes a table with a list in a cell as an HTML table", () => {
		const markdown = build_markdown_from_json({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						make_table_row("tableHeader", ["A", "B"]),
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{
											type: "bulletList",
											content: [
												{
													type: "listItem",
													content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
												},
											],
										},
									],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
								},
							],
						},
					],
				},
			],
		});
		expect(markdown).toBe(
			"<table>\n<tr><th>A</th><th>B</th></tr>\n<tr><td><ul><li>one</li></ul></td><td>2</td></tr>\n</table>",
		);
		expect(round_trip_markdown(markdown)).toBe(markdown + "\n");

		const json = files_tiptap_markdown_to_json({ markdown });
		if (json._nay) {
			throw new Error("Expected the HTML table to parse", { cause: json._nay });
		}
		expect(json._yay.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0]?.type).toBe("bulletList");
	});
});

describe("HTML tables round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected HTML table markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (mut_content: TiptapJSONContent[]) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}
		const json = editor._yay.getJSON();
		editor._yay.destroy();

		edit(json.content ?? []);
		const edited = files_headless_tiptap_editor_create({ initialContent: { json } });
		if (edited._nay) {
			throw new Error("Expected the editor to load the edited document", { cause: edited._nay });
		}
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: edited._yay });
		edited._yay.destroy();
		return saved + "\n";
	}

	const table_full =
		'<table class="t">\n  <caption>Cap</caption>\n  <colgroup><col width="10"></colgroup>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td colspan="2" style="color:red">\n        <ul><li>one</li><li>two</li></ul>\n      </td>\n    </tr>\n    <!-- last row -->\n    <tr><td rowspan="2">Use <name> here</td><td>b</td></tr>\n  </tbody>\n</table>\n';

	test("keeps HTML tables exactly", () => {
		const inputs = [
			"<table><tr><td>a</td></tr></table>\n",
			table_full,
			// A README table with Markdown in its cells comes from Marked as several blocks.
			"<table>\n<tr>\n<td>\n\n- a\n- b\n\n</td>\n<td>\n\n**bold** text\n\n</td>\n</tr>\n</table>\n",
			"- item\n  <table><tr><td>in a list</td></tr></table>\n",
		];
		for (const input of inputs) {
			expect(round_trip_markdown(input)).toBe(input);
		}
	});

	test("writes an edited HTML table as HTML and keeps its parts", () => {
		const saved = edit_and_save(table_full, (content) => {
			const header = content[0]?.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0];
			if (header?.text !== "A") {
				throw new Error("Expected the first header text");
			}
			header.text = "AA";
		});

		expect(saved).toBe(
			'<table class="t">\n<caption>Cap</caption>\n<colgroup><col width="10"></colgroup>\n<thead>\n<tr><th>AA</th><th>B</th></tr>\n</thead>\n<tbody>\n<tr><td colspan="2" style="color:red"><ul><li>one</li><li>two</li></ul></td></tr>\n<!-- last row -->\n<tr><td rowspan="2">Use <name> here</td><td>b</td></tr>\n</tbody>\n</table>\n',
		);
		expect(round_trip_markdown(saved)).toBe(saved);
	});

	test("has an HTML writer branch for every block node type", () => {
		const schema = getSchema(Object.values(files_get_tiptap_shared_extensions()));
		const blockNodeTypes = Object.values(schema.nodes).filter((type) => type.isBlock);
		// A new block node type needs a branch in `html_render_blocks`. Add it there, then here. The `details`
		// branch writes `detailsSummary` and `detailsContent`.
		expect(blockNodeTypes.map((type) => type.name).sort()).toEqual([
			"blockquote",
			"bulletList",
			"codeBlock",
			"details",
			"detailsContent",
			"detailsSummary",
			"doc",
			"footnoteDefinition",
			"frontmatter",
			"heading",
			"horizontalRule",
			"htmlBlock",
			"htmlComment",
			"listItem",
			"orderedList",
			"paragraph",
			"table",
			"tableCell",
			"tableHeader",
			"tableRow",
			"taskItem",
			"taskList",
			"video",
		]);

		const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
		const content: TiptapJSONContent[] = [
			paragraph("p <&>"),
			{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "h" }] },
			{ type: "blockquote", content: [paragraph("q")] },
			{ type: "bulletList", content: [{ type: "listItem", content: [paragraph("b1"), paragraph("b2")] }] },
			{ type: "orderedList", attrs: { start: 0 }, content: [{ type: "listItem", content: [paragraph("o")] }] },
			{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("t")] }] },
			{ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "a <\n\nb" }] },
			{ type: "horizontalRule" },
			{ type: "video", attrs: { src: "https://example.com/v.mp4" } },
			{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph("n")] }] }] },
			{
				type: "details",
				content: [
					{ type: "detailsSummary", content: [{ type: "text", text: "s" }] },
					{ type: "detailsContent", content: [paragraph("e1"), paragraph("e2")] },
				],
			},
			{ type: "frontmatter", content: [{ type: "text", text: "a: 1" }] },
			{ type: "htmlComment", content: [{ type: "text", text: " c " }] },
			{ type: "htmlBlock", content: [{ type: "text", text: "d" }] },
			{ type: "footnoteDefinition", content: [{ type: "text", text: "[^1]: <f>" }] },
		];
		const saved = edit_and_save("| a |\n| --- |\n| 1 |\n", (mut_content) => {
			mut_content[0]!.content![1]!.content![0]!.content = content;
		});
		// Before, a list that starts at 0 saved with no start, so it showed 1.
		expect(saved).toContain('<ol start="0">');

		const parsed = files_tiptap_markdown_to_json({ markdown: saved });
		if (parsed._nay) {
			throw new Error("Expected the saved table to parse", { cause: parsed._nay });
		}
		const shape = (nodes: TiptapJSONContent[]): unknown[] =>
			nodes.map((node) => [node.type, node.text, shape(node.content ?? [])]);
		const cellContent = parsed._yay.content?.[0]?.content?.[1]?.content?.[0]?.content ?? [];
		// A comment in a cell reads back as a hidden tag in a paragraph. An HTML block and a footnote definition
		// read back as a paragraph.
		expect(shape(cellContent)).toEqual(
			shape([
				...content.slice(0, -3),
				{ type: "paragraph", content: [{ type: "htmlTag" }] },
				paragraph("d"),
				paragraph("[^1]: <f>"),
			]),
		);
	});
});

describe("details blocks round-trip through Yjs", () => {
	function round_trip_markdown(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected details markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	function edit_and_save(markdown: string, edit: (mut_content: TiptapJSONContent[]) => void) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown } });
		if (editor._nay) {
			throw new Error("Expected the editor to load", { cause: editor._nay });
		}
		const json = editor._yay.getJSON();
		editor._yay.destroy();

		edit(json.content ?? []);
		const edited = files_headless_tiptap_editor_create({ initialContent: { json } });
		if (edited._nay) {
			throw new Error("Expected the editor to load the edited document", { cause: edited._nay });
		}
		const saved = files_headless_tiptap_editor_get_markdown({ mut_editor: edited._yay });
		edited._yay.destroy();
		return saved + "\n";
	}

	test("keeps details blocks exactly", () => {
		const inputs = [
			// GitHub's layout: Marked gives the body as Markdown blocks between two HTML blocks.
			"<details>\n<summary>More</summary>\n\nBody **bold**\n\n- a\n- b\n\n</details>\n",
			"<details>\n<summary>More</summary>\nBody **bold**\n</details>\n",
			"<details><summary>Use <name> and <b>bold</b></summary>Body</details>\n",
			"<details>\n\nNo summary\n\n</details>\n",
			"<details>\n<summary>A</summary>\n\n<details>\n<summary>B</summary>\n\ninner\n\n</details>\n\n</details>\n",
			"<details>\n<summary>T</summary>\n\n<table>\n<tr>\n<td>\n\n**x**\n\n</td>\n</tr>\n</table>\n\n</details>\n",
			"<table>\n<tr>\n<td>\n\n<details>\n<summary>S</summary>\n\nin a cell\n\n</details>\n\n</td>\n</tr>\n</table>\n",
			"- item\n  <details><summary>S</summary>in a list</details>\n",
			// GitHub shows a Pandoc block as text. Tiptap's details nodes would read it as a details block.
			":::details\nhello\n:::\n",
		];
		for (const input of inputs) {
			expect(round_trip_markdown(input)).toBe(input);
		}
	});

	test("reads a details block as one node with its Markdown body inside", () => {
		const parsed = files_tiptap_markdown_to_json({
			markdown: "<details>\n<summary>More</summary>\n\nBody **bold**\n\n- a\n\n</details>\n",
		});
		if (parsed._nay) {
			throw new Error("Expected the details block to parse", { cause: parsed._nay });
		}

		const blocks: TiptapJSONContent[] = parsed._yay.content ?? [];
		expect(blocks.map((node) => node.type)).toEqual(["details"]);
		expect(blocks[0]?.content?.[1]?.content?.map((node) => node.type)).toEqual(["paragraph", "bulletList"]);
	});

	test("writes an edited details block in GitHub's layout and keeps its tags", () => {
		const input = '<details open class="x"><summary>Use <name></summary><div>Body <b>x</b></div></details>\n';
		const saved = edit_and_save(input, (content) => {
			const summaryText = content[0]?.content?.[0]?.content?.[0];
			if (summaryText?.text !== "Use ") {
				throw new Error("Expected the summary text");
			}
			summaryText.text = "See ";
		});

		// The body did not change, so it keeps its exact source (`<b>`, not `<strong>`).
		expect(saved).toBe(
			'<details open class="x">\n<summary>See <name></summary>\n\n<div>Body <b>x</b></div>\n\n</details>\n',
		);
		expect(round_trip_markdown(saved)).toBe(saved);
	});
});

describe("non-collaborative markdown normalization is idempotent", () => {
	// The mounted non-collaborative editor serializes with `nonCollaborativeExtensions`; its own
	// idempotence suite lives in the browser project next to that list. This suite is the shared
	// mirror: the same fixtures through the shared Yjs pipeline, which the comment merge retry
	// and the Yjs materialization path use. The property both suites stand on is the same: the
	// first pass may reformat, and every pass after that changes nothing.
	function normalize(markdown: string) {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_text({
			text: markdown,
			mut_yjsDoc: yjsDoc,
			rootKind: "rich_text",
		});
		if (updateResult._nay) {
			throw new Error("Expected markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		return markdownResult._yay;
	}

	// A table that loses its column count comes back from marked as a plain paragraph, and the parse
	// keeps the paragraph's newlines, so the pipe lines survive in the text. Looking for a delimiter
	// row in the output would therefore pass on a document with no table in it. Parse the output back
	// and look for the node instead.
	function expect_still_a_table(markdown: string) {
		const json = files_tiptap_markdown_to_json({ markdown });
		if (json._nay) {
			throw new Error("Expected table markdown to parse", { cause: json._nay });
		}

		expect(JSON.stringify(json._yay)).toContain('"type":"table"');
	}

	test("keeps a canonical document byte for byte, so the second save is a no-op", () => {
		const input = "# Heading\n\nBody text\n";
		expect(normalize(input)).toBe(input);
	});

	test("keeps backslash escapes as written", () => {
		const fixtures = [
			"Meeting on 2026\\-08\\-30\n",
			"C\\# and \\(a+b\\)\n",
			"\\=\\=x\\=\\= and \\&copy;\n",
			"\\*not italic\\* and snake\\_case\n",
		];
		for (const fixture of fixtures) {
			expect(normalize(fixture)).toBe(fixture);
		}
	});

	test("settles headings, lists, code fences, task lists and frontmatter after one pass", () => {
		const fixtures = [
			"# Title\n\nDated 2026-08-30\n",
			"* one\n* two\n",
			"1. one\n2. two\n",
			"```ts\nconst a = 1;\n```\n",
			"- [ ] todo\n- [x] done\n",
			'---\nfoo: bar\nbaz: "qux"\n---\n\nBody\n',
		];
		for (const fixture of fixtures) {
			const once = normalize(fixture);
			expect(normalize(once)).toBe(once);
		}
	});

	test("keeps code and frontmatter text from turning into Markdown on a save", () => {
		const fixtures = [
			// A code block keeps its last line. It must not gain a blank line before the closing fence.
			["a\n\n```sh\nx\n```\n\nb\n", "a\n\n```sh\nx\n```\n\nb\n"],
			// Code that holds a fence line.
			["````\n```\n![x](bonobo-file://S)\n```\n````\n", "````\n```\n![x](bonobo-file://S)\n```\n````\n"],
			["~~~\n```js\nx\n```\n~~~\n", "~~~\n```js\nx\n```\n~~~\n"],
			// A backtick in the language would make a backtick fence line plain text. A `~~~` fence can keep it.
			["~~~a`b\nx\n~~~\n", "~~~a`b\nx\n~~~\n"],
			// Code in an ordered list keeps its indent: `1. ` is three columns.
			["1. Step:\n   ```sh\n   a\n     b\n   ```\n2. Next\n", "1. Step:\n   ```sh\n   a\n     b\n   ```\n2. Next\n"],
			// A bullet nested with 2 spaces stays nested.
			["1. Install\n  - run setup\n    - on Windows\n2. Done\n", "1. Install\n   - run setup\n     - on Windows\n2. Done\n"],
			// Frontmatter that is not first, or that holds a `---` line, stays HTML.
			["Intro\n\n<pre data-frontmatter>a: 1\n---\n![x](bonobo-file://S)</pre>\n", "Intro\n\n<pre data-frontmatter>a: 1\n---\n![x](bonobo-file://S)</pre>\n"],
			["<pre data-frontmatter>a: 1\n---\nb</pre>\n", "<pre data-frontmatter>a: 1\n---\nb</pre>\n"],
		] as const;
		for (const [fixture, expected] of fixtures) {
			const once = normalize(fixture);
			expect(once).toBe(expected);
			expect(normalize(once)).toBe(once);
			const json = files_tiptap_markdown_to_json({ markdown: once });
			expect(JSON.stringify(json._yay)).not.toContain('"type":"image"');
		}
	});

	test("keeps escaped block markers at a line start as paragraph text", () => {
		const fixtures = [
			["\\# a\n", "\\# a\n"],
			["\\- a\n", "\\- a\n"],
			["\\+ a\n", "\\+ a\n"],
			["1\\. a\n", "1\\. a\n"],
			["1\\) a\n", "1\\) a\n"],
			["\\---\n", "\\---\n"],
			["a\n\\===\n", "a\n\\===\n"],
			["a\n\\## b\n", "a\n\\## b\n"],
			["a  \n\\- b\n", "a  \n\\- b\n"],
			["a \\| b\n\\--- \\| ---\n", "a \\| b\n\\--- \\| ---\n"],
			// A line without a dash is no table divider, so it needs no escape.
			["a\n:::\n", "a\n:::\n"],
		] as const;
		for (const [fixture, expected] of fixtures) {
			const once = normalize(fixture);
			expect(once).toBe(expected);
			const json = files_tiptap_markdown_to_json({ markdown: once });
			expect(JSON.stringify(json._yay)).not.toMatch(/"type":"(heading|bulletList|orderedList|horizontalRule|table)"/);
		}
	});

	test("keeps footnotes exactly", () => {
		const fixtures = [
			"A[^a].\n\n[^a]: First.\n\n    Second paragraph.\n",
			"A[^1] B[^my_note].\n\n[^1]: One wrapped\nline.\n[^my_note]: a <b> & c\n\n[^3]: Three.\n\nAfter.\n",
			// A reference before `(` would start a link, so it stays escaped.
			"\\[^1\\](x)\n",
		];
		for (const fixture of fixtures) {
			expect(normalize(fixture)).toBe(fixture);
		}

		// A definition in a list stays as Marked reads it. As a block there, the next read lost it.
		const inList = normalize("1. a[^1]\n\n   [^1]: note\n       more\n");
		expect(normalize(inList)).toBe(inList);

		const json = JSON.stringify(files_tiptap_markdown_to_json({ markdown: fixtures[0] })._yay);
		expect(json).toContain('"type":"footnoteDefinition"');
		expect(json).not.toMatch(/"type":"(link|codeBlock)"/);
	});

	test("keeps link definitions", () => {
		const fixtures = [
			// Before, save dropped a definition that no link used.
			'[x]: http://e.com\n[y]: http://f.com "T"\n',
			"> [x]: http://e.com\n> [y]: http://f.com\n",
			// Marked reads a one-word footnote in a quote as a link definition.
			"> [^1]: note\n",
		];
		for (const fixture of fixtures) {
			expect(normalize(fixture)).toBe(fixture);
		}

		// A reference still finds its definition. Save writes the link inline.
		expect(normalize("[a][x]\n\n[x]: http://e.com\n")).toBe("[a](http://e.com)\n\n[x]: http://e.com\n");
	});

	test("keeps a heading with more lines one heading", () => {
		const fixtures = [
			// A `#` heading is one line, so a line break saves as a tag.
			["# a<br>b\n", "# a<br>b\n"],
			["### a<br>b\n", "### a<br>b\n"],
			// An underlined heading keeps its underline and its lines, and they start like paragraph lines.
			["a\\\nb\n===\n", "a<br>b\n===\n"],
			["Title\nmore\n---\n", "Title\nmore\n---\n"],
			["\\- Title\n\\---\n===\n", "\\- Title\n\\---\n===\n"],
		] as const;
		for (const [fixture, expected] of fixtures) {
			const once = normalize(fixture);
			expect(once).toBe(expected);
			expect(normalize(once)).toBe(once);
		}
	});

	test("keeps the list markers the file uses", () => {
		const fixtures = [
			"* a\n* b\n",
			"+ a\n  * b\n",
			"1) a\n2) b\n",
			"3) a\n   - b\n",
			// A new marker starts a new list, so two lists must not become one.
			"- a\n\n* b\n",
		];
		for (const fixture of fixtures) {
			expect(normalize(fixture)).toBe(fixture);
		}
	});

	test("keeps the blank lines between list items", () => {
		const fixtures = [
			"- a\n\n- b\n",
			"1. a\n\n2. b\n",
			"3) a\n\n4) b\n",
			"- a\n\n- b\n  - c\n  - d\n",
			// A blank line inside an item does not put blank lines between the items.
			"- a\n\n  more\n- b\n",
		];
		for (const fixture of fixtures) {
			expect(normalize(fixture)).toBe(fixture);
		}
	});

	test("settles trailing-newline variants", () => {
		for (const fixture of ["text", "text\n", "text\n\n\n"]) {
			const once = normalize(fixture);
			expect(normalize(once)).toBe(once);
		}
	});

	test("keeps a paragraph comment mark span stable", () => {
		// Section 7's targeted comment save writes exactly this span through this path.
		const once = normalize('Hello <span data-type="comment" data-lb-thread-id="t1">world</span> again.\n');
		expect(once).toContain('data-lb-thread-id="t1"');
		expect(normalize(once)).toBe(once);
	});

	// Table fixtures never assert idempotence alone: a table degraded to a paragraph is
	// idempotent too. Assert the exact expected bytes and parse the output back for the node.
	test("keeps the imported canonical table fixtures byte for byte", () => {
		const fixtures = [
			table_canonical_2x2,
			table_alignments,
			table_pipe_in_cell,
			table_backslash_before_pipe,
			table_comment_span,
		];
		for (const fixture of fixtures) {
			const output = normalize(fixture);
			expect(output).toBe(fixture);
			expect_still_a_table(output);
		}
	});

	test("reformats the code-span backslash fixture once, then holds still", () => {
		// Product decision: the serializer writes the span as an HTML code element with numeric
		// character references, so the backslash run cannot grow.
		const expected = "| <code>x &#92;&#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |\n";
		const output = normalize(table_code_span_backslash);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(normalize(output)).toBe(output);
	});
});

// #region plain text shape bridge
function plain_doc_from(text: string) {
	const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: "plain_text" });
	if ("_nay" in yjsDoc) {
		throw new Error("Expected plain-text doc creation to succeed", { cause: yjsDoc._nay });
	}
	return yjsDoc;
}

function plain_text_of(yjsDoc: YDoc) {
	const result = files_yjs_doc_get_text({ yjsDoc, rootKind: "plain_text" });
	if (result._nay) {
		throw new Error("Expected plain-text read to succeed", { cause: result._nay });
	}
	return result._yay;
}

function set_plain_text(mut_yjsDoc: YDoc, text: string) {
	const result = files_yjs_doc_update_from_text({ text, mut_yjsDoc, rootKind: "plain_text" });
	if (result._nay) {
		throw new Error("Expected plain-text write to succeed", { cause: result._nay });
	}
}

function clone_doc(yjsDoc: YDoc) {
	const cloned = new YDoc();
	applyUpdate(cloned, encodeStateAsUpdate(yjsDoc));
	return cloned;
}

/** Re-apply an encoded doc into a fresh doc so roots arrive as bare AbstractTypes (like stored docs do). */
function reencode_doc(yjsDoc: YDoc) {
	return clone_doc(yjsDoc);
}

describe("files_yjs_doc_get_text", () => {
	// The bridge is byte-transparent: no forced trailing newline, no LF normalization, no BOM
	// stripping (producers own the BOM policy; the bridge must not hide bytes).
	test.each([
		{ title: "simple text", text: "hello world" },
		{ title: "trailing newline preserved exactly", text: "line one\nline two\n" },
		{ title: "no trailing newline preserved", text: "line one\nline two" },
		{ title: "multiple trailing newlines", text: "a\n\n\n" },
		{ title: "CRLF kept by the transparent bridge", text: "a\r\nb\r\n" },
		{ title: "lone CR kept by the transparent bridge", text: "progress\rdone\n" },
		{ title: "leading BOM kept by the transparent bridge", text: "﻿a,b\n1,2\n" },
		{ title: "astral characters", text: "x😀y\n" },
		{ title: "empty text", text: "" },
	])("round-trips byte-exact: $title", ({ text }) => {
		expect(plain_text_of(plain_doc_from(text))).toBe(text);
	});

	test("round-trips byte-exact through an encode/apply cycle", () => {
		const text = "a\nb😀c\r\nd";
		expect(plain_text_of(reencode_doc(plain_doc_from(text)))).toBe(text);
	});

	test("refuses to read a document whose text is not addressable", () => {
		// An XmlFragment named `plain_text` reads "" while `length` counts its children.
		const attackerDoc = new YDoc();
		const fragment = attackerDoc.getXmlFragment("plain_text");
		attackerDoc.transact(() => {
			fragment.insert(0, [new YXmlElement("p")]);
		});
		const victimDoc = reencode_doc(attackerDoc);

		const result = files_yjs_doc_get_text({ yjsDoc: victimDoc, rootKind: "plain_text" });
		expect(result._nay?.message).toBe(files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE);
	});

	test("refuses to read a rich-text document whose only root is the plain-text one", () => {
		const attackerDoc = new YDoc();
		attackerDoc.getText("plain_text").insert(0, "smuggled");
		const victimDoc = reencode_doc(attackerDoc);

		const result = files_yjs_doc_get_text({ yjsDoc: victimDoc, rootKind: "rich_text" });
		expect(result._nay?.message).toBe(files_yjs_RICH_TEXT_SHAPE_MISMATCH_MESSAGE);
	});

	test("reads the real root of a both-roots document", () => {
		const yjsDoc = plain_doc_from("real content\n");
		// A stale rich-text tab wrote a `default` root beside the plain one.
		yjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("p")]);
		const bothRootsDoc = reencode_doc(yjsDoc);

		expect(plain_text_of(bothRootsDoc)).toBe("real content\n");
	});

	test("reads an empty never-written document as empty text under both shapes", () => {
		const emptyDoc = new YDoc();
		expect(plain_text_of(emptyDoc)).toBe("");

		const richResult = files_yjs_doc_get_text({ yjsDoc: new YDoc(), rootKind: "rich_text" });
		expect(richResult._nay).toBeUndefined();
	});
});

describe("files_yjs_doc_check_text_addressable", () => {
	test.each([
		{ title: "plain text with content", build: () => plain_doc_from("hello\nworld\n") },
		{ title: "empty document", build: () => new YDoc() },
		{
			title: "emptied by delete-all",
			build: () => {
				const yjsDoc = plain_doc_from("content");
				yjsDoc.getText("plain_text").delete(0, "content".length);
				return yjsDoc;
			},
		},
		{ title: "astral character", build: () => plain_doc_from("x😀y") },
		{
			title: "many lines",
			build: () => plain_doc_from(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")),
		},
		{
			title: "format marks on real text",
			build: () => {
				const yjsDoc = plain_doc_from("bold text");
				yjsDoc.getText("plain_text").format(0, 4, { bold: true });
				return yjsDoc;
			},
		},
	])("allows: $title", ({ build }) => {
		const result = files_yjs_doc_check_text_addressable({ yjsDoc: reencode_doc(build()), rootKind: "plain_text" });
		expect(result._nay).toBeUndefined();
	});

	test.each([
		{
			title: "XmlFragment named plain_text with one child",
			build: () => {
				const yjsDoc = new YDoc();
				yjsDoc.getXmlFragment("plain_text").insert(0, [new YXmlElement("p")]);
				return yjsDoc;
			},
		},
		{
			title: "XmlFragment named plain_text with three children",
			build: () => {
				const yjsDoc = new YDoc();
				yjsDoc
					.getXmlFragment("plain_text")
					.insert(0, [new YXmlElement("p"), new YXmlElement("p"), new YXmlElement("p")]);
				return yjsDoc;
			},
		},
		{
			title: "embed inside a real Y.Text",
			build: () => {
				const yjsDoc = plain_doc_from("hello world");
				yjsDoc.getText("plain_text").insertEmbed(5, { image: "x.png" });
				return yjsDoc;
			},
		},
		{
			title: "embed-only Y.Text",
			build: () => {
				const yjsDoc = new YDoc();
				yjsDoc.getText("plain_text").insertEmbed(0, { image: "x.png" });
				return yjsDoc;
			},
		},
	])("refuses: $title", ({ build }) => {
		const result = files_yjs_doc_check_text_addressable({ yjsDoc: reencode_doc(build()), rootKind: "plain_text" });
		expect(result._nay?.message).toBe(files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE);
	});

	test("parity does not catch a Y.Map named plain_text; the map-size line does", () => {
		const attackerDoc = new YDoc();
		attackerDoc.getMap("plain_text").set("k", "v");
		const victimDoc = reencode_doc(attackerDoc);

		// Parity is vacuously true (a map's content contributes to neither toString nor length)…
		const parity = files_yjs_doc_check_text_addressable({ yjsDoc: victimDoc, rootKind: "plain_text" });
		expect(parity._nay).toBeUndefined();
		// …which is why door 2 also asserts the plain root's map slots are empty.
		expect(files_yjs_doc_plain_text_root_map_size({ yjsDoc: victimDoc })).toBe(1);
		expect(files_yjs_doc_plain_text_root_map_size({ yjsDoc: reencode_doc(plain_doc_from("legal")) })).toBe(0);
	});

	test("rich branch allows the legal root layouts", () => {
		// Only the rich root.
		const richDoc = new YDoc();
		richDoc.getXmlFragment("default").insert(0, [new YXmlElement("p")]);
		expect(
			files_yjs_doc_check_text_addressable({ yjsDoc: reencode_doc(richDoc), rootKind: "rich_text" })._nay,
		).toBeUndefined();

		// Both roots present: the rich root exists, so the name test allows.
		const bothDoc = new YDoc();
		bothDoc.getXmlFragment("default").insert(0, [new YXmlElement("p")]);
		bothDoc.getText("plain_text").insert(0, "x");
		expect(
			files_yjs_doc_check_text_addressable({ yjsDoc: reencode_doc(bothDoc), rootKind: "rich_text" })._nay,
		).toBeUndefined();

		// Brand-new empty document.
		expect(files_yjs_doc_check_text_addressable({ yjsDoc: new YDoc(), rootKind: "rich_text" })._nay).toBeUndefined();
	});
});

describe("files_yjs_doc_update_from_text plain branch", () => {
	test("refuses to write into a document whose text is not addressable", () => {
		const attackerDoc = new YDoc();
		attackerDoc.getXmlFragment("plain_text").insert(0, [new YXmlElement("p")]);
		const victimDoc = reencode_doc(attackerDoc);

		const result = files_yjs_doc_update_from_text({ text: "new", mut_yjsDoc: victimDoc, rootKind: "plain_text" });
		expect(result._nay?.message).toBe(files_yjs_TEXT_NOT_ADDRESSABLE_MESSAGE);
	});

	// Incremental byte-equality: build from A, run the setter with B, read back B exactly.
	// This is where the end-to-start offsets and surrogate-safe boundaries actually bite.
	test.each([
		{ title: "multi-range edits", source: "aaa\nbbb\nccc\nddd\n", target: "aXa\nbbb\nInserted\ncYc\nddd\n" },
		{ title: "ranges not in source order", source: "one two three four", target: "one 2 three 4our five" },
		{ title: "emoji straddling a range boundary", source: "x😀y😀z", target: "x😀q😀z" },
		{ title: "delete inside astral text", source: "a😀b😀c", target: "a😀c" },
		{ title: "add trailing newline", source: "tail no nl", target: "tail no nl\n" },
		{ title: "remove trailing newline", source: "tail with nl\n", target: "tail with nl" },
		{ title: "delete-all", source: "a\nb\nc\n", target: "" },
		{ title: "create from empty", source: "", target: "fresh content\n" },
		{ title: "whole-line replace in repeated block", source: "x\ny\nx\ny\n", target: "x\ny\nz\ny\n" },
	])("applies the minimal diff byte-exact: $title", ({ source, target }) => {
		const yjsDoc = plain_doc_from(source);
		set_plain_text(yjsDoc, target);
		expect(plain_text_of(yjsDoc)).toBe(target);
		// And the write survives an encode/apply cycle.
		expect(plain_text_of(reencode_doc(yjsDoc))).toBe(target);
	});

	test("a changed text always changes the state vector (under-emission control)", () => {
		const yjsDoc = plain_doc_from("before text");
		// Give the doc a deletion first so the delete-set can never stand in for content ops.
		set_plain_text(yjsDoc, "before");
		const stateVectorBefore = encodeStateVector(yjsDoc);
		set_plain_text(yjsDoc, "after");
		expect(files_u8_equals(encodeStateVector(yjsDoc), stateVectorBefore)).toBe(false);
		expect(plain_text_of(yjsDoc)).toBe("after");
	});

	// Objective 12's deterministic merge lane: build D0, clone A and B, run the real setter on
	// each clone, encode each state-vector diff against D0, apply both diffs to a third clone,
	// and assert the exact merged text: A's edited line where A edited it, B's where
	// B edited it, every untouched line in its original place.
	test.each([
		{
			title: "two edits on different lines",
			base: "l1\nl2\nl3\n",
			editA: "l1 edited by A\nl2\nl3\n",
			editB: "l1\nl2\nl3 edited by B\n",
			merged: "l1 edited by A\nl2\nl3 edited by B\n",
		},
		{
			title: "different character spans on one line of a multiline file",
			base: "a=1 b=2\nkeep\n",
			editA: "a=9 b=2\nkeep\n",
			editB: "a=1 b=7\nkeep\n",
			merged: "a=9 b=7\nkeep\n",
		},
		{
			title: "concurrent key edits in minified JSON",
			base: '{"a":1,"b":2}',
			editA: '{"a":9,"b":2}',
			editB: '{"a":1,"b":7}',
			merged: '{"a":9,"b":7}',
		},
		{
			title: "three-line interleaving",
			base: "l1\nl2\nl3\n",
			editA: "l1\nA\nl2\nl3\n",
			editB: "l1\nl2\nB\nl3\n",
			merged: "l1\nA\nl2\nB\nl3\n",
		},
		{
			title: "A deletes a line while B edits a later one",
			base: "l1\nl2\nl3\nl4\n",
			editA: "l1\nl3\nl4\n",
			editB: "l1\nl2\nl3\nl4 edited\n",
			merged: "l1\nl3\nl4 edited\n",
		},
	])("merges concurrent saves positionally: $title", ({ base, editA, editB, merged }) => {
		const baseDoc = plain_doc_from(base);
		const cloneA = clone_doc(baseDoc);
		const cloneB = clone_doc(baseDoc);
		set_plain_text(cloneA, editA);
		set_plain_text(cloneB, editB);

		const diffA = encodeStateAsUpdate(cloneA, encodeStateVector(baseDoc));
		const diffB = encodeStateAsUpdate(cloneB, encodeStateVector(baseDoc));
		const mergedDoc = clone_doc(baseDoc);
		applyUpdate(mergedDoc, diffA);
		applyUpdate(mergedDoc, diffB);

		expect(plain_text_of(mergedDoc)).toBe(merged);
	});

	// The diff budget calibration cases are in files.diff_budgets.test.ts and files.diff_refusal.test.ts.
});

describe("files_yjs_doc_create_from_text", () => {
	test("creates a plain-text document under the plain root", () => {
		const yjsDoc = plain_doc_from("seeded\n");
		expect([...reencode_doc(yjsDoc).share.keys()]).toEqual(["plain_text"]);
		expect(plain_text_of(yjsDoc)).toBe("seeded\n");
	});

	test("creates an empty plain-text document with no persisted root", () => {
		const yjsDoc = plain_doc_from("");
		// An empty root is never persisted: encodeStateAsUpdate writes structs and there are none.
		expect(encodeStateAsUpdate(yjsDoc).byteLength).toBe(2);
	});

	test("creates a rich-text document under the rich root", () => {
		const yjsDoc = files_yjs_doc_create_from_text({ text: "# Title\n", rootKind: "rich_text" });
		if ("_nay" in yjsDoc) {
			throw new Error("Expected rich-text doc creation to succeed", { cause: yjsDoc._nay });
		}
		expect([...reencode_doc(yjsDoc).share.keys()]).toEqual(["default"]);
	});
});
// #endregion plain text shape bridge

// #region client update scan
function encoded_state_of(build: (yjsDoc: YDoc) => void) {
	const yjsDoc = new YDoc();
	yjsDoc.transact(() => build(yjsDoc));
	return encodeStateAsUpdate(yjsDoc);
}

function incremental_update_of(yjsDoc: YDoc, edit: (yjsDoc: YDoc) => void) {
	const stateVectorBefore = encodeStateVector(yjsDoc);
	yjsDoc.transact(() => edit(yjsDoc));
	return encodeStateAsUpdate(yjsDoc, stateVectorBefore);
}

describe("files_yjs_decode_v1_update", () => {
	test("allows the canonical two-byte v1 no-op", () => {
		const update = encodeStateAsUpdate(new YDoc());
		expect(update.byteLength).toBe(2);
		expect(files_yjs_decode_v1_update({ update })._nay).toBeUndefined();
	});

	test("allows a delete-only update", () => {
		const yjsDoc = plain_doc_from("abc");
		const update = incremental_update_of(yjsDoc, (d) => d.getText("plain_text").delete(0, 3));
		expect(files_yjs_decode_v1_update({ update })._nay).toBeUndefined();
	});

	test("refuses a V2-encoded update by name", () => {
		const yjsDoc = plain_doc_from("v2 content");
		const update = encodeStateAsUpdateV2(yjsDoc);
		expect(files_yjs_decode_v1_update({ update })._nay?.message).toBe(files_yjs_UNSUPPORTED_UPDATE_ENCODING_MESSAGE);
	});

	test("refuses malformed bytes (catch-and-refuse, never catch-and-continue)", () => {
		expect(files_yjs_decode_v1_update({ update: new Uint8Array([255, 255, 255, 255]) })._nay?.message).toBe(
			files_yjs_MALFORMED_UPDATE_MESSAGE,
		);
	});
});

describe("files_yjs_scan_client_update", () => {
	test.each([
		{
			title: "first write",
			update: () => encoded_state_of((d) => d.getText("plain_text").insert(0, "first")),
		},
		{
			title: "incremental insert",
			update: () => incremental_update_of(plain_doc_from("base"), (d) => d.getText("plain_text").insert(4, "!")),
		},
		{
			title: "incremental delete",
			update: () => incremental_update_of(plain_doc_from("base"), (d) => d.getText("plain_text").delete(0, 2)),
		},
		{
			title: "delete-everything",
			update: () => incremental_update_of(plain_doc_from("wipe me"), (d) => d.getText("plain_text").delete(0, 7)),
		},
		{
			title: "canonical two-byte no-op",
			update: () => encodeStateAsUpdate(new YDoc()),
		},
	])("allows on a plain-text node: $title", ({ update }) => {
		expect(files_yjs_scan_client_update({ update: update(), rootKind: "plain_text" })._nay).toBeUndefined();
	});

	test.each([
		{
			title: "format mark (ContentFormat), including a hidden payload",
			update: () =>
				incremental_update_of(plain_doc_from("styled"), (d) =>
					d.getText("plain_text").format(0, 3, { hidden: "A".repeat(1000) }),
				),
		},
		{
			title: "map-slot item (parentSub)",
			update: () => encoded_state_of((d) => d.getMap("plain_text").set("k", "v")),
		},
		{
			// A deleted map entry keeps `parentSub` while its content becomes the whitelisted
			// ContentDeleted, so this row is refused by the `parentSub` check alone.
			title: "map-slot tombstone (parentSub with whitelisted ContentDeleted)",
			update: () =>
				encoded_state_of((d) => {
					d.getMap("plain_text").set("k", "v");
					d.getMap("plain_text").delete("k");
				}),
		},
		{
			title: "XmlFragment named plain_text (ContentType)",
			update: () => encoded_state_of((d) => d.getXmlFragment("plain_text").insert(0, [new YXmlElement("p")])),
		},
		{
			title: "opposite root created (ContentType)",
			update: () => encoded_state_of((d) => d.getXmlFragment("default").insert(0, [new YXmlElement("p")])),
		},
		{
			title: "embed into an existing root (ContentEmbed)",
			update: () =>
				incremental_update_of(plain_doc_from("base"), (d) => d.getText("plain_text").insertEmbed(2, { x: 1 })),
		},
		{
			title: "Y.Array named plain_text (ContentAny without parentSub)",
			update: () => encoded_state_of((d) => d.getArray("plain_text").insert(0, [1])),
		},
	])("refuses on a plain-text node: $title", ({ update }) => {
		expect(files_yjs_scan_client_update({ update: update(), rootKind: "plain_text" })._nay?.message).toBe(
			files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
		);
	});

	test("refuses a Skip struct built by merging across a gap", () => {
		const yjsDoc = new YDoc();
		const ytext = yjsDoc.getText("plain_text");
		ytext.insert(0, "a");
		const updateA = encodeStateAsUpdate(yjsDoc);
		ytext.insert(1, "b");
		const stateVectorAfterB = encodeStateVector(yjsDoc);
		ytext.insert(2, "c");
		const updateC = encodeStateAsUpdate(yjsDoc, stateVectorAfterB);

		// Merging A and C without B leaves a hole that mergeUpdates encodes as a Skip struct.
		const merged = mergeUpdates([updateA, updateC]);
		expect(files_yjs_scan_client_update({ update: merged, rootKind: "plain_text" })._nay?.message).toBe(
			files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
		);
	});

	test("refuses a V2-encoded update with the encoding message and refuses malformed bytes", () => {
		const update = encodeStateAsUpdateV2(plain_doc_from("v2"));
		expect(files_yjs_scan_client_update({ update, rootKind: "plain_text" })._nay?.message).toBe(
			files_yjs_UNSUPPORTED_UPDATE_ENCODING_MESSAGE,
		);
		expect(
			files_yjs_scan_client_update({ update: new Uint8Array([9, 9, 9]), rootKind: "plain_text" })._nay?.message,
		).toBe(files_yjs_MALFORMED_UPDATE_MESSAGE);
	});

	test("rich-text node: allows normal Markdown pushes, refuses an update creating the plain-text root", () => {
		// A first Markdown write carries ContentType structs and names only the rich root.
		const richDoc = files_yjs_doc_create_from_text({ text: "# Title\n\nBody\n", rootKind: "rich_text" });
		if ("_nay" in richDoc) {
			throw new Error("Expected rich-text doc creation to succeed", { cause: richDoc._nay });
		}
		const firstWrite = encodeStateAsUpdate(richDoc);
		expect(files_yjs_scan_client_update({ update: firstWrite, rootKind: "rich_text" })._nay).toBeUndefined();

		// An incremental edit names no root at all.
		const incremental = incremental_update_of(richDoc, (d) => {
			d.getXmlFragment("default").insert(0, [new YXmlElement("p")]);
		});
		expect(files_yjs_scan_client_update({ update: incremental, rootKind: "rich_text" })._nay).toBeUndefined();

		// Hand-built bytes creating a root named plain_text are refused at the door.
		const vandal = encoded_state_of((d) => d.getText("plain_text").insert(0, "x"));
		expect(files_yjs_scan_client_update({ update: vandal, rootKind: "rich_text" })._nay?.message).toBe(
			files_yjs_UPDATE_SHAPE_REFUSED_MESSAGE,
		);
	});
});
// #endregion client update scan
