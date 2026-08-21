import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	files_collect_read_only_ancestor_ids,
	files_find_file_stem_end_index,
	files_get_read_only_capabilities,
	files_get_read_only_row_labels,
	files_get_editable_text_content_type,
	files_get_editable_text_yjs_root_kind,
	files_get_monaco_language_id,
	files_get_served_media_content_type,
	files_get_upload_pipeline_state,
	files_get_normalized_node_path_segments,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_normalize_editable_file_name,
	files_normalize_markdown_name,
	files_validate_file_rename_class,
	files_normalize_text_document_input,
	files_u8_equals,
	files_normalize_name_input,
	files_normalize_name,
	files_pending_path_overlay_build,
	files_pending_path_overlay_list_injections,
	files_pending_path_overlay_pick_visible_entry,
	files_pending_path_overlay_project_committed_path,
	files_pending_path_overlay_translate_path,
	files_ROOT_ID,
	type files_PendingPathOverlayNode,
	type files_PendingPathOverlayRow,
	type files_VisibleTreeNode,
} from "./files.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_get_markdown,
	files_parse_markdown_to_html,
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
import { files_text_diff_TOO_LARGE_MESSAGE } from "./files-text-diff.ts";
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

function read_only_test_node(args: {
	id: string;
	parentId?: string;
	readOnlyState?: files_VisibleTreeNode["readOnlyState"];
}) {
	return {
		_id: args.id as files_VisibleTreeNode["_id"],
		parentId: (args.parentId ?? "root") as files_VisibleTreeNode["parentId"],
		readOnlyState: args.readOnlyState ?? "writable",
	};
}

function read_only_test_id(value: string) {
	return value as files_VisibleTreeNode["_id"];
}

describe("files_collect_read_only_ancestor_ids", () => {
	test("marks every visible ancestor of a locked node and nothing else", () => {
		const ancestorIds = files_collect_read_only_ancestor_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
			read_only_test_node({ id: "f", parentId: "b", readOnlyState: "inherited" }),
			read_only_test_node({ id: "c", parentId: "a" }),
			read_only_test_node({ id: "g", parentId: "c" }),
		]);

		expect(ancestorIds).toEqual(new Set([read_only_test_id("a"), read_only_test_id("b")]));
	});

	test("marks both branches when two locked nodes share an ancestor", () => {
		const ancestorIds = files_collect_read_only_ancestor_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
			read_only_test_node({ id: "f1", parentId: "b", readOnlyState: "self" }),
			read_only_test_node({ id: "c", parentId: "a" }),
			read_only_test_node({ id: "f2", parentId: "c", readOnlyState: "inherited" }),
		]);

		expect(ancestorIds).toEqual(new Set([read_only_test_id("a"), read_only_test_id("b"), read_only_test_id("c")]));
	});

	test("a locked root-level node has no visible ancestors", () => {
		const ancestorIds = files_collect_read_only_ancestor_ids([
			read_only_test_node({ id: "d", readOnlyState: "self" }),
		]);

		expect(ancestorIds).toEqual(new Set());
	});

	test("a parent missing from the visible list ends the walk", () => {
		const ancestorIds = files_collect_read_only_ancestor_ids([
			read_only_test_node({ id: "a" }),
			// The locked node's direct parent is not visible to this caller, so the chain above it
			// cannot be walked. `a` is not related to the locked node here.
			read_only_test_node({ id: "f", parentId: "hidden", readOnlyState: "inherited" }),
		]);

		expect(ancestorIds).toEqual(new Set());
	});

	test("an all-writable tree yields an empty set", () => {
		const ancestorIds = files_collect_read_only_ancestor_ids([
			read_only_test_node({ id: "a" }),
			read_only_test_node({ id: "b", parentId: "a" }),
		]);

		expect(ancestorIds).toEqual(new Set());
	});
});

describe("files_get_read_only_row_labels", () => {
	test("a direct lock reads read-only and ignores the source fields", () => {
		// The projection points a self lock's source at the node itself, so the label must not
		// name it.
		expect(
			files_get_read_only_row_labels({
				readOnlyState: "self",
				readOnlySourcePath: "/docs/plan.md",
				hasVisibleReadOnlyDescendant: false,
			}),
		).toEqual({ description: "read-only", tooltip: "Read-only" });
	});

	test("an inherited lock names its visible source path", () => {
		expect(
			files_get_read_only_row_labels({
				readOnlyState: "inherited",
				readOnlySourcePath: "/docs",
				hasVisibleReadOnlyDescendant: false,
			}),
		).toEqual({ description: "read-only from /docs", tooltip: "Read-only from /docs" });
	});

	test("an inherited lock with a hidden source never names it", () => {
		expect(
			files_get_read_only_row_labels({
				readOnlyState: "inherited",
				readOnlySourcePath: undefined,
				hasVisibleReadOnlyDescendant: false,
			}),
		).toEqual({
			description: "read-only from a protected folder",
			tooltip: "Read-only from a protected folder",
		});
	});

	test("a writable ancestor of a locked node says it contains read-only items", () => {
		expect(
			files_get_read_only_row_labels({
				readOnlyState: "writable",
				readOnlySourcePath: undefined,
				hasVisibleReadOnlyDescendant: true,
			}),
		).toEqual({ description: "contains read-only items", tooltip: "Contains read-only items" });
	});

	test("a plain writable row gets no annotation", () => {
		expect(
			files_get_read_only_row_labels({
				readOnlyState: "writable",
				readOnlySourcePath: undefined,
				hasVisibleReadOnlyDescendant: false,
			}),
		).toBe(null);
	});
});

describe("files_get_read_only_capabilities", () => {
	test("keeps destination writes separate from subtree-changing writes", () => {
		expect(
			files_get_read_only_capabilities({
				canWrite: true,
				readOnlyState: "writable",
				hasVisibleReadOnlyDescendant: true,
			}),
		).toEqual({
			canEditContent: true,
			canReceiveChildren: true,
			canRelocateOrRename: false,
			canArchiveOrRestore: false,
		});
	});

	test.each(["self", "inherited"] as const)("an effective %s lock blocks every write capability", (readOnlyState) => {
		expect(
			files_get_read_only_capabilities({ canWrite: true, readOnlyState, hasVisibleReadOnlyDescendant: false }),
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
				readOnlyState: "writable",
				hasVisibleReadOnlyDescendant: false,
			}),
		).toEqual({
			canEditContent: false,
			canReceiveChildren: false,
			canRelocateOrRename: false,
			canArchiveOrRestore: false,
		});
	});
});

describe("files_get_editable_text_content_type", () => {
	test.each([
		["notes.md", "text/markdown;charset=utf-8"],
		["NOTES.MD", "text/markdown;charset=utf-8"],
		["notes.txt", "text/plain;charset=utf-8"],
		["build.log", "text/plain;charset=utf-8"],
		["data.json", "application/json"],
		["DATA.JSON", "application/json"],
		["config.jsonc", "application/json"],
		["config.yaml", "application/yaml"],
		["config.yml", "application/yaml"],
		["config.toml", "application/toml"],
		["settings.ini", "text/plain;charset=utf-8"],
		["table.csv", "text/csv"],
		["table.tsv", "text/tab-separated-values"],
		["style.css", "text/css"],
		["script.js", "text/javascript"],
		["script.mjs", "text/javascript"],
		["script.cjs", "text/javascript"],
		["view.jsx", "text/javascript"],
		["module.ts", "text/typescript"],
		["view.tsx", "text/typescript"],
		["run.sh", "application/x-sh"],
		["query.sql", "application/sql"],
		// Active content and unknown extensions are not editable text.
		["page.html", null],
		["feed.xml", null],
		["image.svg", null],
		["photo.png", null],
		["movie.mp4", null],
		["secrets.env", null],
		["archive.tar.gz", null],
		["script.py", null],
		// A leading-dot name has no extension, same rule as `files_lowercase_extension`.
		[".json", null],
		[".env", null],
		[".gitignore", null],
		// A trailing dot means no extension either, and so does no dot at all.
		["data.", null],
		["notes", null],
	] satisfies Array<[string, ReturnType<typeof files_get_editable_text_content_type>]>)(
		"classifies %s as %s",
		(fileName, expected) => {
			expect(files_get_editable_text_content_type(fileName)).toBe(expected);
		},
	);
});

describe("files_get_editable_text_yjs_root_kind", () => {
	test.each([
		// `.md` keeps the rich text document; that routing rule is this table's reason to exist.
		["notes.md", "rich_text"],
		["README.MD", "rich_text"],
		["notes.txt", "plain_text"],
		["build.log", "plain_text"],
		["data.json", "plain_text"],
		["config.jsonc", "plain_text"],
		["config.yaml", "plain_text"],
		["config.yml", "plain_text"],
		["config.toml", "plain_text"],
		["settings.ini", "plain_text"],
		["table.csv", "plain_text"],
		["table.tsv", "plain_text"],
		["style.css", "plain_text"],
		["script.js", "plain_text"],
		["script.mjs", "plain_text"],
		["script.cjs", "plain_text"],
		["view.jsx", "plain_text"],
		["module.ts", "plain_text"],
		["view.tsx", "plain_text"],
		["run.sh", "plain_text"],
		["query.sql", "plain_text"],
		["photo.png", null],
		["page.html", null],
		["image.svg", null],
		[".json", null],
		[".gitignore", null],
		["data.", null],
		["notes", null],
	] satisfies Array<[string, ReturnType<typeof files_get_editable_text_yjs_root_kind>]>)(
		"classifies %s as %s",
		(fileName, expected) => {
			expect(files_get_editable_text_yjs_root_kind(fileName)).toBe(expected);
		},
	);
});

describe("files_get_monaco_language_id", () => {
	test.each([
		["notes.md", "markdown"],
		["notes.txt", "plaintext"],
		["build.log", "plaintext"],
		["data.json", "json"],
		["config.jsonc", "json"],
		["config.yaml", "yaml"],
		["config.yml", "yaml"],
		["config.toml", "plaintext"],
		["settings.ini", "ini"],
		["table.csv", "plaintext"],
		["table.tsv", "plaintext"],
		["style.css", "css"],
		["script.js", "javascript"],
		["script.mjs", "javascript"],
		["script.cjs", "javascript"],
		["view.jsx", "javascript"],
		["module.ts", "typescript"],
		["view.tsx", "typescript"],
		["run.sh", "shell"],
		["query.sql", "sql"],
		["MODULE.TS", "typescript"],
		["unknown.bin", "plaintext"],
		[".gitignore", "plaintext"],
		["notes", "plaintext"],
	] satisfies Array<[string, string]>)("maps %s to %s", (fileName, expected) => {
		expect(files_get_monaco_language_id(fileName)).toBe(expected);
	});
});

describe("files_get_served_media_content_type", () => {
	test.each([
		["photo.png", "image/png"],
		["PHOTO.PNG", "image/png"],
		["photo.jpg", "image/jpeg"],
		["photo.jpeg", "image/jpeg"],
		["photo.webp", "image/webp"],
		["clip.gif", "image/gif"],
		["movie.mp4", "video/mp4"],
		["movie.webm", "video/webm"],
		// SVG and HTML can run script when served inline, so they never get an inline media type.
		["image.svg", null],
		["page.html", null],
		["notes.md", null],
		["data.json", null],
		["unknown.bin", null],
		[".png", null],
		["photo", null],
	] satisfies Array<[string, string | null]>)("serves %s as %s", (fileName, expected) => {
		expect(files_get_served_media_content_type(fileName)).toBe(expected);
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
				yjsRootKind: "rich_text",
			}),
		).toBe(true);

		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
				yjsRootKind: undefined,
			}),
		).toBe(false);
		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId: undefined,
				yjsRootKind: "rich_text",
			}),
		).toBe(false);
		expect(
			files_node_has_editable_yjs_state({
				kind: "folder",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
				yjsRootKind: "rich_text",
			}),
		).toBe(false);
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

describe("files_normalize_editable_file_name", () => {
	test.each([
		["data.json", "data.json"],
		["DATA.JSON", "data.json"],
		["My Notes.yaml", "my-notes.yaml"],
		// Extensionless names still default to Markdown, like the UI create flow.
		["Feature Plan", "feature-plan.md"],
		["notes.", "notes.md"],
		["readme.md", "README.md"],
	])("normalizes %s to %s", (input, expected) => {
		expect(files_normalize_editable_file_name(input)).toEqual({ _yay: expected });
	});

	test("refuses an unwritable extension with the classifier's rule", () => {
		const result = files_normalize_editable_file_name("tool.exe");
		if (!result._nay) {
			throw new Error("Expected the unwritable extension to refuse");
		}
		expect(result._nay.message).toContain("'.exe' is not supported");
		expect(result._nay.message).toContain("Writable extensions: .md, .txt");
	});
});

describe("files_validate_file_rename_class", () => {
	const richNode = {
		kind: "file",
		lowercaseExtension: "md",
		assetId: "asset" as never,
		yjsSnapshotId: "snapshot" as never,
		yjsLastSequenceId: "sequence" as never,
		yjsRootKind: "rich_text",
	} as const;
	const plainNode = { ...richNode, lowercaseExtension: "json", yjsRootKind: "plain_text" } as const;
	const uploadNode = {
		kind: "file",
		lowercaseExtension: "png",
		assetId: undefined,
		yjsSnapshotId: undefined,
		yjsLastSequenceId: undefined,
		yjsRootKind: undefined,
	} as const;

	test("refuses class crossings and extension changes on stored files", () => {
		expect(files_validate_file_rename_class({ node: richNode, destName: "notes.json" })._nay?.message).toBe(
			"A Markdown file must keep the .md extension",
		);
		expect(files_validate_file_rename_class({ node: plainNode, destName: "notes.md" })._nay?.message).toContain(
			"A plain text file must keep a plain text extension",
		);
		expect(files_validate_file_rename_class({ node: uploadNode, destName: "movie.mp4" })._nay?.message).toContain(
			"keep '.png'",
		);
	});

	test("allows plain subtype changes with the destination media type and same-class renames", () => {
		expect(files_validate_file_rename_class({ node: plainNode, destName: "notes.yaml" })).toEqual({
			_yay: { contentType: "application/yaml" },
		});
		expect(files_validate_file_rename_class({ node: richNode, destName: "notes.md" })).toEqual({
			_yay: { contentType: "text/markdown;charset=utf-8" },
		});
		expect(files_validate_file_rename_class({ node: uploadNode, destName: "picture.png" })).toEqual({
			_yay: { contentType: null },
		});
	});

	test("a non-collaborative file follows the same class rule as a collaborative one", () => {
		// Collaboration off drops the Yjs pointers but keeps the text and its class, so the rule
		// still reads the class from yjsRootKind.
		const nonCollaborativeRichNode = { ...richNode, yjsSnapshotId: undefined, yjsLastSequenceId: undefined } as const;
		const nonCollaborativePlainNode = { ...plainNode, yjsSnapshotId: undefined, yjsLastSequenceId: undefined } as const;

		expect(
			files_validate_file_rename_class({ node: nonCollaborativeRichNode, destName: "notes.json" })._nay?.message,
		).toBe("A Markdown file must keep the .md extension");
		expect(files_validate_file_rename_class({ node: nonCollaborativePlainNode, destName: "notes.yaml" })).toEqual({
			_yay: { contentType: "application/yaml" },
		});
	});

	test("an extensionless destination claims no class, so a swap can park a file on a folder name", () => {
		expect(files_validate_file_rename_class({ node: richNode, destName: "swap-temp" })).toEqual({
			_yay: { contentType: null },
		});
		expect(files_validate_file_rename_class({ node: plainNode, destName: "swap-temp" })).toEqual({
			_yay: { contentType: null },
		});
		// A stored upload's extension is the only record of its bytes: it may not be dropped.
		expect(files_validate_file_rename_class({ node: uploadNode, destName: "photo" })._nay).toBeDefined();
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
			        "content": [
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			          {
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
				},
				content: [{ type: "text", text: "Base " }],
			},
		]);
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
});

describe("files_parse_markdown_to_html", () => {
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

	test("preserves a video caption and alignment", () => {
		const input = '<video src="bonobo-file://k17abcdef" title="A red circle" width="480" align="center"></video>\n';
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

		expect(markdown).toBe('<video src="bonobo-file://k17abcdef" title="A red circle" width="480" align="center"></video>');
	});
});

describe("files_pending_path_overlay", () => {
	function make_overlay_node_id(value: string) {
		return value as app_convex_Doc<"files_nodes">["_id"];
	}

	function make_overlay_node(id: string, path: string, kind: "file" | "folder"): files_PendingPathOverlayNode {
		return { _id: make_overlay_node_id(id), path, kind };
	}

	function make_move_row(args: {
		nodeId: string;
		destParentId: string;
		destName: string;
		replacesNodeId?: string;
	}): files_PendingPathOverlayRow {
		return {
			fileNodeId: make_overlay_node_id(args.nodeId),
			pendingMove: {
				destParentId: args.destParentId === files_ROOT_ID ? files_ROOT_ID : make_overlay_node_id(args.destParentId),
				destName: args.destName,
				fromPath: "",
				replacesNodeId: args.replacesNodeId ? make_overlay_node_id(args.replacesNodeId) : undefined,
			},
		};
	}

	function make_copy_row(args: {
		destNodeId: string;
		sourceNodeId: string;
		sourcePath: string;
		archivesSourceOnAccept?: boolean;
	}): files_PendingPathOverlayRow {
		return {
			fileNodeId: make_overlay_node_id(args.destNodeId),
			copiedFrom: {
				nodeId: make_overlay_node_id(args.sourceNodeId),
				path: args.sourcePath,
				archivesSourceOnAccept: args.archivesSourceOnAccept,
			},
		};
	}

	function make_archive_row(args: { nodeId: string; fromPath?: string }): files_PendingPathOverlayRow {
		return {
			fileNodeId: make_overlay_node_id(args.nodeId),
			pendingArchive: { fromPath: args.fromPath ?? "" },
		};
	}

	function build_overlay(rows: files_PendingPathOverlayRow[], nodes: files_PendingPathOverlayNode[]) {
		return files_pending_path_overlay_build({
			pendingUpdates: rows,
			nodesById: new Map<string, files_PendingPathOverlayNode>(nodes.map((node) => [node._id, node])),
		});
	}

	describe("rows that never affect paths", () => {
		test("an empty overlay leaves every path unchanged", () => {
			const overlay = build_overlay([], []);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a content-only row leaves every path unchanged", () => {
			const overlay = build_overlay(
				[{ fileNodeId: make_overlay_node_id("a") }],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
		});

		test("a plain copy row (no archivesSourceOnAccept) leaves the source visible", () => {
			// The copy destination is a real committed node already, so the overlay has nothing to add.
			const overlay = build_overlay(
				[make_copy_row({ destNodeId: "dest", sourceNodeId: "src", sourcePath: "/a.md" })],
				[make_overlay_node("src", "/a.md", "file"), make_overlay_node("dest", "/copy.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/copy.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
			// The copy destination is an eagerly created committed node; listings show it as-is.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/copy.md")).toBe("/copy.md");
		});
	});

	describe("file move", () => {
		const nodes = [make_overlay_node("a", "/a.md", "file"), make_overlay_node("docs", "/docs", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })];

		test("the destination path redirects to the committed source path", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
		});

		test("the vacated source path is hidden", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
		});

		test("the committed source path projects onto the destination path", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/docs/b.md");
		});

		test("a file move hides only the exact source path, not lookalike siblings", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/ab.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab.md")).toBe("/ab.md");
		});

		test("a committed node at the claimed destination path is hidden from listings", () => {
			// A file created at /docs/b.md after the proposal is shadowed for the proposer;
			// accept auto-replaces it. Projection drops it so listings show the moved node once.
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/b.md")).toBe(null);
		});

		test("the destination folder listing injects the moved file under its new name", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_list_injections(overlay, "/docs")).toEqual([
				{ nodeId: make_overlay_node_id("a"), kind: "file", committedPath: "/a.md", visibleName: "b.md" },
			]);
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a move to the root folder works like any other destination", () => {
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" })],
				[make_overlay_node("a", "/docs/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/docs/a.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([
				{ nodeId: make_overlay_node_id("a"), kind: "file", committedPath: "/docs/a.md", visibleName: "b.md" },
			]);
		});

		test("an in-place rename projects the new name and adds no injection", () => {
			// The committed listing of /docs already contains the node; projection renames it.
			// An injection on top would show the same node twice.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })],
				[make_overlay_node("a", "/docs/a.md", "file"), make_overlay_node("docs", "/docs", "folder")],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/a.md")).toBe("/docs/b.md");
			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/docs/a.md",
			});
			expect(files_pending_path_overlay_list_injections(overlay, "/docs")).toEqual([]);
		});
	});

	describe("folder move", () => {
		const nodes = [make_overlay_node("a", "/a", "folder"), make_overlay_node("b", "/b", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "b", destName: "c" })];

		test("the destination folder path and its descendants redirect into the source subtree", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/b/c")).toEqual({
				kind: "redirected",
				committedPath: "/a",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b/c/sub/file.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/sub/file.md",
			});
		});

		test("the vacated folder path and its descendants are hidden", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/a")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_translate_path(overlay, "/a/sub/file.md")).toEqual({ kind: "hidden" });
		});

		test("committed descendant paths project onto the destination subtree", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a")).toBe("/b/c");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/sub/file.md")).toBe("/b/c/sub/file.md");
		});

		test("prefix matching respects path segment boundaries", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/ab.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/b/cd.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab.md")).toBe("/ab.md");
		});

		test("committed paths at or under the claimed destination are hidden from listings", () => {
			// A committed folder or file created inside the claimed /b/c area after the
			// proposal is shadowed by the redirect; the source subtree shows there instead.
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b/c")).toBe(null);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b/c/late.md")).toBe(null);
		});
	});

	describe("stacked moves", () => {
		test("a move into a moved folder resolves through the parent's visible path", () => {
			// Folder /a becomes /b, and /x.md moves into that folder: the file shows at /b/x.md.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "x.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/b/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([
				{ nodeId: make_overlay_node_id("x"), kind: "file", committedPath: "/x.md", visibleName: "x.md" },
			]);
		});

		test("a rename inside a moved folder projects once and adds no injection", () => {
			// /a/x.md is already a committed child of the moved folder, so listing the
			// redirected folder /b covers it; its own rename row only changes the name.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x.md")).toBe("/b/y.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([]);
		});

		test("a renamed child's old visible path under a moved folder is hidden", () => {
			// /a/x.md is renamed to y.md inside the moved folder: the folder-prefix redirect
			// for /b/x.md no longer projects back onto /b/x.md, so the old path reads as gone.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({ kind: "hidden" });
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/b/x.md", occupantNodeId: null }),
			).toBe("none");
			// The child's own rename keeps working through the exact-redirect branch.
			expect(files_pending_path_overlay_translate_path(overlay, "/b/y.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/x.md",
			});
		});

		test("an untouched sibling under the same moved folder still redirects", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/s.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/s.md",
			});
		});

		test("a move claiming a vacated visible path inside a moved folder shadows the committed child", () => {
			// Folder /a becomes /b and /z.md moves onto /b/x.md (the visible path of the
			// committed child /a/x.md). The exact claim wins: lookups at /b/x.md read Z, so
			// projecting the committed child there too would make listings disagree with reads.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "z", destParentId: "a", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("x", "/a/x.md", "file"),
					make_overlay_node("z", "/z.md", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/z.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/z.md")).toBe("/b/x.md");
			// The committed child is shadowed by the exact claim; the injection owns the path.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x.md")).toBe(null);
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([
				{ nodeId: make_overlay_node_id("z"), kind: "file", committedPath: "/z.md", visibleName: "x.md" },
			]);
		});

		test("siblings inside the moved folder still project when another move claims one child path", () => {
			// The producing ancestor's own visible path prefixes every rewritten child, so only
			// EXACT claims may shadow: siblings of the claimed path keep projecting through.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "z", destParentId: "a", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("x", "/a/x.md", "file"),
					make_overlay_node("s", "/a/s.md", "file"),
					make_overlay_node("z", "/z.md", "file"),
				],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/s.md")).toBe("/b/s.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/sub/deep.md")).toBe("/b/sub/deep.md");
			expect(files_pending_path_overlay_translate_path(overlay, "/b/s.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/s.md",
			});
		});

		test("chained moves keep each mapping single-hop", () => {
			// /a.md -> /b.md while /c.md -> /a.md: the vacated path is reused, no transitive chasing.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" }),
					make_move_row({ nodeId: "c", destParentId: files_ROOT_ID, destName: "a.md" }),
				],
				[make_overlay_node("a", "/a.md", "file"), make_overlay_node("c", "/c.md", "file")],
			);

			// The redirect into /a.md wins over the "moved away" hiding of the same path.
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/c.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/c.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/c.md")).toBe("/a.md");
		});

		test("two files can swap paths", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" }),
					make_move_row({ nodeId: "b", destParentId: files_ROOT_ID, destName: "a.md" }),
				],
				[make_overlay_node("a", "/a.md", "file"), make_overlay_node("b", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/b.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b.md")).toBe("/a.md");
		});

		test("a destination-parent cycle drops all cycling rows", () => {
			// Folder /a into /b while folder /b into /a: no visible path can resolve, so
			// both rows are ignored instead of guessing an order.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "b", destName: "a" }),
					make_move_row({ nodeId: "b", destParentId: "a", destName: "b" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("b", "/b", "folder")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/b")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a")).toBe("/a");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b")).toBe("/b");
		});

		test("a destination-parent cycle leaves unrelated rows applied", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "b", destName: "a" }),
					make_move_row({ nodeId: "b", destParentId: "a", destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "docs", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("b", "/b", "folder"),
					make_overlay_node("x", "/x.md", "file"),
					make_overlay_node("docs", "/docs", "folder"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/docs/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/docs/x.md");
		});

		test("a move into a committed subfolder of a moved folder resolves through the prefix rewrite", () => {
			// Folder /a becomes /b; /a/sub has NO row of its own, its visible path /b/sub
			// exists only through the ancestor rewrite. A move whose destination parent is
			// that committed subfolder must land under the rewritten path.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "sub", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("sub", "/a/sub", "folder"),
					make_overlay_node("x", "/x.md", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/sub/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/b/sub/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b/sub")).toEqual([
				{ nodeId: make_overlay_node_id("x"), kind: "file", committedPath: "/x.md", visibleName: "x.md" },
			]);
		});

		test("two moves onto the same visible path drop all colliding rows", () => {
			// Proposal-time validation prevents this state; if rows still collide, do not
			// guess a winner — both nodes stay visible at their committed paths.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "x", destParentId: files_ROOT_ID, destName: "n.md" }),
					make_move_row({ nodeId: "y", destParentId: files_ROOT_ID, destName: "n.md" }),
				],
				[make_overlay_node("x", "/x.md", "file"), make_overlay_node("y", "/y.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/n.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/x.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/y.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});
	});

	describe("replace-move", () => {
		test("a structural replace shows the source at the destination and hides the replaced node", () => {
			// mv -f between non-editable files: the SOURCE node moves onto the destination
			// path and the current destination owner is archived on accept.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "src", destParentId: "media", destName: "new.mp4", replacesNodeId: "target" })],
				[
					make_overlay_node("src", "/old.mp4", "file"),
					make_overlay_node("media", "/media", "folder"),
					make_overlay_node("target", "/media/new.mp4", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/media/new.mp4")).toEqual({
				kind: "redirected",
				committedPath: "/old.mp4",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/old.mp4")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/old.mp4")).toBe("/media/new.mp4");
			// The replaced node leaves the visible tree entirely.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/media/new.mp4")).toBe(null);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/media/new.mp4",
					occupantNodeId: "target",
				}),
			).toBe("redirected");
			// The moved-away source at its vacated path reads as missing.
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/old.mp4", occupantNodeId: "src" }),
			).toBe("none");
		});

		test("a replace whose target node is missing degrades to a plain move", () => {
			// The target was archived or deleted after the proposal. Accept then performs a
			// plain move, so the overlay must show the same thing instead of going inert.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "src", destParentId: "media", destName: "new.mp4", replacesNodeId: "ghost" })],
				[make_overlay_node("src", "/old.mp4", "file"), make_overlay_node("media", "/media", "folder")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/media/new.mp4")).toEqual({
				kind: "redirected",
				committedPath: "/old.mp4",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/old.mp4")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/old.mp4")).toBe("/media/new.mp4");
		});

		test("a replace whose target has its own pending move lets both rows apply", () => {
			// Node a is moving to /docs/b.md, and node c replaces it at /a.md. Node a follows
			// its own move instead of being hidden as a replaced target. This matches the
			// non-destructive accept order (accept a's move first, then c's move onto the
			// vacated path proceeds plainly).
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" }),
					make_move_row({ nodeId: "c", destParentId: files_ROOT_ID, destName: "a.md", replacesNodeId: "a" }),
				],
				[
					make_overlay_node("a", "/a.md", "file"),
					make_overlay_node("c", "/c.md", "file"),
					make_overlay_node("docs", "/docs", "folder"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/c.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/docs/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/c.md")).toBe("/a.md");
		});

		test("an editable replace hides the source and keeps the destination committed", () => {
			// mv -f between editable files is stored as a copy on the destination node plus
			// archivesSourceOnAccept: only the source disappears from the visible tree.
			const overlay = build_overlay(
				[
					make_copy_row({
						destNodeId: "dest",
						sourceNodeId: "src",
						sourcePath: "/a.md",
						archivesSourceOnAccept: true,
					}),
				],
				[make_overlay_node("src", "/a.md", "file"), make_overlay_node("dest", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe(null);
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({ kind: "unchanged" });
			// The destination keeps its identity; listings show it at its own path.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b.md")).toBe("/b.md");
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/b.md", occupantNodeId: "dest" }),
			).toBe("occupant");
			// The copy-archived source at its own path reads as missing.
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/a.md", occupantNodeId: "src" }),
			).toBe("none");
		});
	});

	describe("pending delete", () => {
		test("a deleted file reads as gone and its siblings stay visible", () => {
			const overlay = build_overlay(
				[make_archive_row({ nodeId: "a", fromPath: "/a.md" })],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe(null);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/a.md", occupantNodeId: "a" }),
			).toBe("none");
			expect(files_pending_path_overlay_translate_path(overlay, "/ab.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab.md")).toBe("/ab.md");
		});

		test("a deleted folder hides its whole subtree, respecting segment boundaries", () => {
			const overlay = build_overlay([make_archive_row({ nodeId: "a" })], [make_overlay_node("a", "/a", "folder")]);

			expect(files_pending_path_overlay_translate_path(overlay, "/a")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_translate_path(overlay, "/a/sub/file.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a")).toBe(null);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/sub/file.md")).toBe(null);
			expect(files_pending_path_overlay_translate_path(overlay, "/ab")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab/file.md")).toBe("/ab/file.md");
		});

		test("a delete on a row supersedes its own pending move", () => {
			// The upsert clears pendingMove when setting pendingArchive; the build skips
			// the move defensively if both are ever present.
			const overlay = build_overlay(
				[
					{
						...make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" }),
						...make_archive_row({ nodeId: "a", fromPath: "/a.md" }),
					},
				],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe(null);
		});

		test("a subtree moved out of a deleted folder stays visible at its destination", () => {
			// Deletes-last accept order: the move applies first, so /a/x escapes the delete.
			const overlay = build_overlay(
				[
					make_archive_row({ nodeId: "a" }),
					make_move_row({ nodeId: "x", destParentId: files_ROOT_ID, destName: "x2" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x", "folder")],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x")).toBe("/x2");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x/f.md")).toBe("/x2/f.md");
			expect(files_pending_path_overlay_translate_path(overlay, "/x2/f.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/x/f.md",
			});
			// The vacated source area and the rest of the deleted folder still read as gone.
			expect(files_pending_path_overlay_translate_path(overlay, "/a/x/f.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_translate_path(overlay, "/a/other.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/other.md")).toBe(null);
		});

		test("a delete deeper inside a moved folder hides that area at the destination", () => {
			const overlay = build_overlay(
				[make_move_row({ nodeId: "m", destParentId: files_ROOT_ID, destName: "n" }), make_archive_row({ nodeId: "d" })],
				[make_overlay_node("m", "/m", "folder"), make_overlay_node("d", "/m/d", "folder")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/n/d")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_translate_path(overlay, "/n/d/f.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/m/d/f.md")).toBe(null);
			// The rest of the moved folder still redirects normally.
			expect(files_pending_path_overlay_translate_path(overlay, "/n/other.md")).toEqual({
				kind: "redirected",
				committedPath: "/m/other.md",
			});
		});
	});

	describe("files_pending_path_overlay_pick_visible_entry", () => {
		const nodes = [make_overlay_node("a", "/a.md", "file"), make_overlay_node("docs", "/docs", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })];

		test("an untouched committed occupant wins", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/other.md", occupantNodeId: "n" }),
			).toBe("occupant");
		});

		test("a redirect with no committed occupant is presented", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/docs/b.md", occupantNodeId: null }),
			).toBe("redirected");
		});

		test("the moved-away occupant of a vacated path reads as missing", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/a.md", occupantNodeId: "a" }),
			).toBe("none");
		});

		test("a node created at a vacated path after the proposal stays visible", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/a.md",
					occupantNodeId: "newcomer",
				}),
			).toBe("occupant");
		});

		test("a pending move claims its destination even over a newer committed node", () => {
			// Someone created /docs/b.md after the proposal. The move keeps its claim: the
			// proposer sees the moved node there, and accept auto-replaces (soft-archives)
			// the occupant like mv -f. The pending panel shows "Replaces" before accept.
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/docs/b.md",
					occupantNodeId: "newcomer",
				}),
			).toBe("redirected");
		});

		test("a missing path with no redirect reads as missing", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/nope.md", occupantNodeId: null }),
			).toBe("none");
		});
	});

	describe("rows with missing node data are inert", () => {
		test("a move row whose node is not in nodesById does nothing", () => {
			const overlay = build_overlay(
				[make_move_row({ nodeId: "ghost", destParentId: files_ROOT_ID, destName: "b.md" })],
				[],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a move row whose destination parent is not in nodesById does nothing", () => {
			// The source must stay visible: a half-applied overlay would hide the node everywhere.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: "ghost-folder", destName: "b.md" })],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
		});

		test("an editable replace row whose source node is not in nodesById hides nothing", () => {
			const overlay = build_overlay(
				[
					make_copy_row({
						destNodeId: "dest",
						sourceNodeId: "ghost",
						sourcePath: "/a.md",
						archivesSourceOnAccept: true,
					}),
				],
				[make_overlay_node("dest", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
		});

		test("a delete row whose node is not in nodesById hides nothing", () => {
			// The data loader filters archived/out-of-scope nodes, so the row goes inert.
			const overlay = build_overlay([make_archive_row({ nodeId: "ghost", fromPath: "/a.md" })], []);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
		});
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

	// Diff budget calibration guards. These run the production budgets on purpose: the pass
	// cases prove ordinary bulk edits stay under the step budget, and the refusal case proves a
	// genuinely pathological near-cap change still refuses. Step counts are deterministic (same
	// input, same count, on every machine), so these outcomes do not depend on machine speed;
	// the explicit test timeouts only give slow machines room to finish the compute.
	test(
		"applies a full sort of 1,000 lines (~25 KB) within the diff budgets",
		() => {
			// The generated hash-key order is deterministically scrambled, so sorting it is a
			// full permutation of every line. Measured cost: 132M steps (budget 1,000M).
			const lines = Array.from({ length: 1000 }, (_, i) => `key_${((i * 2654435761) >>> 0).toString(16)} = value_${i}`);
			const sortedText = [...lines].sort().join("\n");

			const yjsDoc = plain_doc_from(lines.join("\n"));
			set_plain_text(yjsDoc, sortedText);
			expect(plain_text_of(yjsDoc)).toBe(sortedText);
		},
		60_000,
	);

	test(
		"applies a prettify of a ~40 KB minified JSON within the diff budgets",
		() => {
			// Measured cost: 313M steps (budget 1,000M) — the heaviest ordinary edit the budgets
			// must admit.
			const obj: Record<string, unknown> = {};
			for (let i = 0; i < 500; i++) {
				obj[`key_${((i * 2654435761) >>> 0).toString(16)}`] = {
					id: i,
					name: `name ${i}`,
					tags: [`a${i}`, `b${i}`],
					active: i % 2 === 0,
				};
			}
			const minifiedText = JSON.stringify(obj);
			const prettyText = JSON.stringify(obj, null, 2);

			const yjsDoc = plain_doc_from(minifiedText);
			set_plain_text(yjsDoc, prettyText);
			expect(plain_text_of(yjsDoc)).toBe(prettyText);
		},
		60_000,
	);

	test(
		"applies a replace-all with 1,000 hits in a ~66 KB file within the diff budgets",
		() => {
			// Measured cost: 52M steps (budget 1,000M).
			const lines = Array.from({ length: 2000 }, (_, i) =>
				i % 2 === 0 ? `const value_${i} = oldName.compute(${i});` : `plain line ${i} with text`,
			);
			const sourceText = lines.join("\n");
			const targetText = sourceText.replaceAll("oldName", "newLongerName");

			const yjsDoc = plain_doc_from(sourceText);
			set_plain_text(yjsDoc, targetText);
			expect(plain_text_of(yjsDoc)).toBe(targetText);
		},
		60_000,
	);

	test(
		"refuses a near-cap high-line-count rewrite instead of degrading",
		() => {
			// Two unrelated ~890 KB texts: measured cost is over 2,000M steps, so the 1,000M step
			// budget trips (after ~19 s of compute on the measuring machine) and the Myers bisect
			// must refuse, never fall back to a coarse whole-document replacement.
			const sourceText = Array.from({ length: 68500 }, (_, i) => `src ${((i * 2654435761) >>> 0).toString(16)}`).join(
				"\n",
			);
			const targetText = Array.from({ length: 68500 }, (_, i) => `dst ${((i * 40503) >>> 0).toString(16)}`).join("\n");

			const yjsDoc = plain_doc_from(sourceText);
			const result = files_yjs_doc_update_from_text({
				text: targetText,
				mut_yjsDoc: yjsDoc,
				rootKind: "plain_text",
			});
			expect(result._nay?.message).toBe(files_text_diff_TOO_LARGE_MESSAGE);

			// The refusal must leave the document untouched.
			expect(plain_text_of(yjsDoc)).toBe(sourceText);
		},
		120_000,
	);
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
