import type { files_TreeItem } from "../convex/files_nodes.ts";
import type { Doc } from "../convex/_generated/dataModel";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Highlight } from "@tiptap/extension-highlight";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { marked } from "marked";
import { Doc as YDoc, diffUpdate, encodeStateAsUpdate, applyUpdate, encodeStateVector } from "yjs";
import { Editor, Extension, type Extensions } from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { updateYFragment } from "y-prosemirror";
import { composite_id, is_browser, should_never_happen } from "../shared/shared-utils.ts";
import { CommentsExtension } from "@liveblocks/react-tiptap";
import { generateJSON as tiptap_generateJSON_server } from "@tiptap/html/server";
import { generateJSON as tiptap_generateJSON_browser } from "@tiptap/html";
import { Result } from "./errors-as-values-utils.ts";

export const files_ROOT_ID = "root";
export const files_FIRST_VERSION = 1;
export const files_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "markdown",
};

export type { files_TreeItem };

export function files_create_tree_root(): files_TreeItem {
	return {
		type: "root",
		kind: "folder",
		index: files_ROOT_ID,
		parentId: "",
		title: "",
		archiveOperationId: undefined,
		updatedAt: 0,
		updatedBy: "",
		_id: null,
	};
}

export function files_create_room_id(workspaceId: string, projectId: string, nodeId: string) {
	return composite_id("rooms", "files_nodes", workspaceId, projectId, nodeId);
}

// #region file name normalization
export type files_NodeKind = Doc<"files_nodes">["kind"];

const FILES_NORMALIZED_NAME_PART_REGEX = /^(?!.*--)(?!.*__)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const FILES_NORMALIZED_FILE_NAME_REGEX =
	/^(?!.*--)(?!.*__)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const FILES_FILE_EXTENSION_REGEX = /^[a-z0-9_-]+$/i;
const FILES_DIACRITIC_MARKS_REGEX = /\p{Mark}/gu;
const FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX = /[^a-z0-9_-]+/g;
const FILES_REPEATED_DASH_REGEX = /-+/g;
const FILES_REPEATED_UNDERSCORE_REGEX = /_+/g;
const FILES_EDGE_DASH_OR_UNDERSCORE_REGEX = /^[-_]+|[-_]+$/g;
const FILES_PATH_SEPARATOR_REGEX = /[\\/]+/g;
const FILES_TRAILING_DOTS_REGEX = /\.+$/g;
const FILES_NAME_INPUT_ALPHANUMERIC_REGEX = /^[a-z0-9]$/;
const FILES_FILE_NAME_INPUT_SEPARATOR_REGEX = /^[/._-]$/;
const FILES_FOLDER_NAME_INPUT_SEPARATOR_REGEX = /^[/_-]$/;
// Keep special Markdown file basenames in their conventional case after the general lowercase normalization.
const FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES = new Set(["readme"]);

export function files_normalize_name_input(args: {
	kind: files_NodeKind;
	previousText: string;
	insertedText: string;
	nextText: string;
}) {
	// Normalize the inserted fragment before checking adjacency so pasted text,
	// IME output, and direct keystrokes go through the same draft rules.
	const normalizedInsertedText = args.insertedText
		.normalize("NFKD")
		.replace(FILES_DIACRITIC_MARKS_REGEX, "")
		.toLowerCase();

	// Track the characters around the edit so we can block separator sequences
	// without needing to normalize the full input value on every keystroke.
	let previousCharacter = args.previousText.at(-1) ?? "";
	const nextCharacter = args.nextText.at(0) ?? "";
	let normalizedText = "";

	for (const character of normalizedInsertedText) {
		// Convert each incoming character to the live draft alphabet for the node kind.
		const normalizedCharacter = files_normalize_name_input_character(args.kind, character);
		if (files_is_name_input_separator(args.kind, normalizedCharacter)) {
			// Skip leading separators and adjacent separator pairs while typing.
			if (!previousCharacter || files_is_name_input_separator(args.kind, previousCharacter)) {
				continue;
			}
		}

		// Keep accepted characters in order and update adjacency state for the next one.
		normalizedText += normalizedCharacter;
		previousCharacter = normalizedCharacter;
	}

	if (
		normalizedText &&
		files_is_name_input_separator(args.kind, normalizedText.at(-1) ?? "") &&
		files_is_name_input_separator(args.kind, nextCharacter)
	) {
		// Avoid creating a separator pair across the insertion boundary.
		normalizedText = normalizedText.slice(0, -1);
	}

	return normalizedText;
}

export function files_validate_and_normalize_name(kind: files_NodeKind, name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result(kind);
	}

	// Keep already-canonical names on a cheap fast path; pasted path-like names take the slower cleanup route.
	if (kind === "folder") {
		if (FILES_NORMALIZED_NAME_PART_REGEX.test(name)) {
			return Result({ _yay: name });
		}

		// Normalize folder names as extensionless parts and trim edge separators.
		const normalizedName = name
			.normalize("NFKD")
			.replace(FILES_DIACRITIC_MARKS_REGEX, "")
			.toLowerCase()
			.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
			.replace(FILES_REPEATED_DASH_REGEX, "-")
			.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
			.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "");

		return Result({ _yay: normalizedName || "untitled" });
	}

	const trimmedName = name.trim();
	if (!trimmedName.includes(".")) {
		// Treat extensionless file names as Markdown basenames.
		const baseName =
			trimmedName
				.normalize("NFKD")
				.replace(FILES_DIACRITIC_MARKS_REGEX, "")
				.toLowerCase()
				.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
				.replace(FILES_REPEATED_DASH_REGEX, "-")
				.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
				.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "") || "untitled";
		const fileName = `${baseName}.md`;

		return Result({ _yay: files_apply_special_file_name_case(fileName) });
	}
	if (trimmedName.endsWith(".")) {
		// Treat a trailing dot as a missing Markdown extension.
		const baseName = trimmedName
			.replace(FILES_TRAILING_DOTS_REGEX, "")
			.normalize("NFKD")
			.replace(FILES_DIACRITIC_MARKS_REGEX, "")
			.toLowerCase()
			.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
			.replace(FILES_REPEATED_DASH_REGEX, "-")
			.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
			.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "");
		if (!baseName) {
			// Reject a bare "." or dots-only value because there is no usable basename.
			return files_invalid_name_result(kind);
		}

		const fileName = `${baseName}.md`;

		return Result({ _yay: files_apply_special_file_name_case(fileName) });
	}

	const extensionSeparatorIndex = trimmedName.lastIndexOf(".");
	const extension = trimmedName.slice(extensionSeparatorIndex + 1);
	if (!FILES_FILE_EXTENSION_REGEX.test(extension)) {
		// Keep the extension strict so path separators, spaces, and punctuation are not repaired there.
		return files_invalid_name_result(kind);
	}

	if (FILES_NORMALIZED_FILE_NAME_REGEX.test(name)) {
		// Apply only the final Markdown extension policy when the file name is already canonical.
		const extensionSeparatorIndex = name.lastIndexOf(".");
		const fileName = `${name.slice(0, extensionSeparatorIndex)}.md`;

		return Result({ _yay: files_apply_special_file_name_case(fileName) });
	}

	// Use the slow path for pasted or generated names, then flatten path separators before splitting.
	const normalizedName = name
		.normalize("NFKD")
		.replace(FILES_DIACRITIC_MARKS_REGEX, "")
		.toLowerCase()
		.trim()
		.replace(FILES_PATH_SEPARATOR_REGEX, "-");
	if (!normalizedName.includes(".")) {
		const baseName =
			normalizedName
				.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
				.replace(FILES_REPEATED_DASH_REGEX, "-")
				.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
				.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "") || "untitled";
		const fileName = `${baseName}.md`;

		return Result({ _yay: files_apply_special_file_name_case(fileName) });
	}

	// Treat only the final dot as the extension separator; earlier dots become basename separators.
	const nameParts = normalizedName.split(".");
	const normalizedExtension =
		(nameParts.pop() ?? "")
			.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
			.replace(FILES_REPEATED_DASH_REGEX, "-")
			.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
			.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "") || "";
	const baseNameInput = nameParts.join("-");
	const baseName = baseNameInput
		.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
		.replace(FILES_REPEATED_DASH_REGEX, "-")
		.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
		.replace(FILES_EDGE_DASH_OR_UNDERSCORE_REGEX, "");
	let normalizedFileName: string;
	if (!baseName || !normalizedExtension) {
		// Preserve a usable piece when either side disappears during normalization.
		if (!baseName && normalizedExtension && baseNameInput !== "") {
			normalizedFileName = `untitled.${normalizedExtension}`;
		} else if (!baseName && normalizedExtension) {
			normalizedFileName = `untitled.${normalizedExtension}`;
		} else {
			normalizedFileName = baseName || normalizedExtension || "untitled";
		}
	} else {
		normalizedFileName = `${baseName}.${normalizedExtension}`;
	}

	// Apply the Markdown-only storage policy after cleanup, regardless of the original extension.
	const markdownExtensionSeparatorIndex = normalizedFileName.lastIndexOf(".");
	const fileName =
		markdownExtensionSeparatorIndex === -1
			? `${normalizedFileName}.md`
			: `${normalizedFileName.slice(0, markdownExtensionSeparatorIndex)}.md`;

	return Result({ _yay: files_apply_special_file_name_case(fileName) });
}

export function files_validate_name(name: string, kind: files_NodeKind) {
	// Reuse normalization for validation and discard the normalized value.
	const nameNormalizationResult = files_validate_and_normalize_name(kind, name);
	if (nameNormalizationResult._nay) {
		return nameNormalizationResult;
	}

	return Result({ _yay: null });
}

function files_invalid_name_result(kind: files_NodeKind) {
	// Keep the visible message kind-specific while preserving the shared Result shape.
	return Result({
		_nay: {
			name: "nay",
			message: kind === "folder" ? "Invalid folder name" : "Invalid file name",
		},
	});
}

function files_normalize_name_input_character(kind: files_NodeKind, character: string) {
	if (FILES_NAME_INPUT_ALPHANUMERIC_REGEX.test(character)) {
		// Accept lowercase ASCII letters and digits as valid draft characters.
		return character;
	}

	if (character === "/" || character === "\\") {
		// Keep path separators in create/rename drafts so the submit path can create missing folders.
		return "/";
	}

	if (kind === "file" && character === ".") {
		// Allow files to type an extension separator; folders turn dots into separators.
		return character;
	}

	if (character === "-" || character === "_") {
		// Keep supported separators and let the caller handle adjacency rules.
		return character;
	}

	// Unsupported characters become dashes so live typing can recover when possible.
	return "-";
}

function files_is_name_input_separator(kind: files_NodeKind, character: string) {
	// Treat dots as file separators, while folder drafts do not allow dots at all.
	return kind === "file"
		? FILES_FILE_NAME_INPUT_SEPARATOR_REGEX.test(character)
		: FILES_FOLDER_NAME_INPUT_SEPARATOR_REGEX.test(character);
}

function files_apply_special_file_name_case(name: string) {
	// Compare only the basename so the extension policy stays independent of special casing.
	const extensionSeparatorIndex = name.lastIndexOf(".");
	const baseName = extensionSeparatorIndex === -1 ? name : name.slice(0, extensionSeparatorIndex);
	if (!FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES.has(baseName)) {
		return name;
	}

	// Preserve the normalized extension and uppercase only the special basename.
	const extension = extensionSeparatorIndex === -1 ? "" : name.slice(extensionSeparatorIndex);
	return `${baseName.toUpperCase()}${extension}`;
}
// #endregion file name normalization

const TRAILING_SPACES_OR_TABS_REGEX = /[ \t]+$/;
const TRAILING_WHITESPACE_ONLY_LINE_REGEX = /\n([ \t]+)$/;
const TRAILING_NEWLINES_REGEX = /\n+$/;
const STRUCTURAL_HTML_WHITESPACE_REGEX = />\n[ \t]*</g;
const TRAILING_HARD_BREAKS_REGEX = /(?:\\\n)+$/;
const HARD_BREAK_REGEX = /\\\n/g;

/**
 * Shared marked instance configured for Markdown files.
 *
 * Configured with GitHub Flavored Markdown enabled and breaks disabled.
 */
const files_marked = ((/* iife */) => {
	function value() {
		const instance = marked;
		instance.setOptions({
			gfm: true,
			breaks: false,
		});

		// Tiptap registers a custom `taskList` tokenizer on the same marked instance
		// in `packages/app/vendor/tiptap/packages/extension-list/src/task-list/task-list.ts` (line 76).
		// Add a renderer for it so `marked.parse()` can emit HTML for task lists.
		instance.use({
			extensions: [
				{
					name: "taskList",
					renderer(token) {
						const taskListToken = token as {
							items?: Array<{
								checked?: boolean;
								text?: string;
								tokens?: unknown[];
								nestedTokens?: unknown[];
							}>;
						};
						const itemsHtml = (taskListToken.items ?? [])
							.map((itemToken) => {
								const itemTextHtml =
									itemToken.tokens && itemToken.tokens.length > 0
										? this.parser.parseInline(itemToken.tokens as Parameters<typeof this.parser.parseInline>[0])
										: (itemToken.text ?? "");
								const nestedHtml =
									itemToken.nestedTokens && itemToken.nestedTokens.length > 0
										? this.parser.parse(itemToken.nestedTokens as Parameters<typeof this.parser.parse>[0])
										: "";
								return `<li data-type="taskItem" data-checked="${
									itemToken.checked ? "true" : "false"
								}"><p>${itemTextHtml}</p>${nestedHtml}</li>`;
							})
							.join("");
						return `<ul data-type="taskList">${itemsHtml}</ul>`;
					},
				},
			],
			renderer: {
				heading(token) {
					const headingToken = token as {
						raw?: string;
						depth?: number;
						text?: string;
						tokens?: unknown[];
					};
					const raw = headingToken.raw ?? "";
					const trailingSpaces = raw.match(TRAILING_SPACES_OR_TABS_REGEX)?.[0];

					if (!trailingSpaces) {
						return false;
					}

					const depth = headingToken.depth ?? 1;
					const bodyHtml =
						headingToken.tokens && headingToken.tokens.length > 0
							? this.parser.parseInline(headingToken.tokens as Parameters<typeof this.parser.parseInline>[0])
							: (headingToken.text ?? "");

					return `<h${depth}>${bodyHtml}${trailingSpaces}</h${depth}>`;
				},

				// Handle trailing `\\\n` in paragraphs that are not converted to `<br>` by default
				paragraph(token) {
					const paragraphToken = token as {
						raw?: string;
					};
					const raw = paragraphToken.raw ?? "";
					const trailingHardBreaks = raw.match(TRAILING_HARD_BREAKS_REGEX)?.[0];

					if (!trailingHardBreaks) {
						return false;
					}

					const hardBreakCount = (trailingHardBreaks.match(HARD_BREAK_REGEX) ?? []).length;
					const bodyRaw = raw.slice(0, raw.length - trailingHardBreaks.length);
					const bodyHtml = instance.parseInline(bodyRaw, { async: false });

					return `<p>${bodyHtml}${"<br>".repeat(hardBreakCount)}</p>`;
				},
			},
		});

		return instance;
	}

	let cache: ReturnType<typeof value>;

	return function files_marked() {
		return (cache ??= value());
	};
})();

/**
 * Parse markdown string to HTML.
 */
function tiptap_markdown_to_html(args: { markdown: string; extensions?: Extensions; replaceNewLineToBr?: boolean }) {
	const markdown = args.replaceNewLineToBr ? args.markdown.replaceAll("\n", "<br>") : args.markdown;

	// const markdownWithoutTrailingHardBreaks = markdown.replace(/(?:\\\n)+$/g, "");

	let html;
	try {
		html = files_marked().parse(markdown, { async: false });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while parsing markdown to HTML",
				cause: error,
			},
		});
	}

	const trailingWhitespaceOnlyLine = markdown.match(TRAILING_WHITESPACE_ONLY_LINE_REGEX)?.[1];
	if (trailingWhitespaceOnlyLine) {
		return Result({
			_yay: html + `<p>${trailingWhitespaceOnlyLine}</p>`,
		});
	}

	// Preserve trailing empty lines at EOF (Markdown usually ignores them).
	// - every 2 `\n` => 1 empty paragraph
	// - odd counts round up
	const trailingNewlines = markdown.match(TRAILING_NEWLINES_REGEX)?.[0] ?? "";
	const newlineCount = trailingNewlines.length;
	if (newlineCount === 0) return Result({ _yay: html });

	const paragraphCount = Math.max(1, Math.ceil(newlineCount / 2));
	return Result({
		_yay: html + "<p></p>".repeat(paragraphCount),
	});
}

/**
 * Parse markdown string to HTML.
 */
export const files_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		return tiptap_markdown_to_html({
			markdown,
		});
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function files_parse_markdown_to_html(markdown: string) {
		const cachedValue = cache.get(markdown);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(markdown);
		cache.set(markdown, result);
		return result;
	};
})();

export function files_tiptap_html_to_json(args: { html: string; extensions?: Extensions }) {
	const extensions = args.extensions ?? get_tiptap_shared_extensions_list();
	const parseOptions = {
		preserveWhitespace: "full" as const,
	};
	const normalizedHtml = args.html.replace(STRUCTURAL_HTML_WHITESPACE_REGEX, "><").trimEnd();

	const json = is_browser()
		? tiptap_generateJSON_browser(normalizedHtml, extensions, parseOptions)
		: tiptap_generateJSON_server(normalizedHtml, extensions, parseOptions);

	return json;
}

export function files_tiptap_markdown_to_json(args: {
	markdown: string;
	extensions?: Extensions;
	replaceNewLineToBr?: boolean;
}) {
	if (!args.markdown) {
		return Result({ _yay: files_tiptap_empty_doc_json() });
	}

	// Go through HTML so extension `parseHTML` handlers can normalize embedded HTML
	// consistently with the rest of the editor pipeline.
	const markdownToHtml = tiptap_markdown_to_html({
		markdown: args.markdown,
		extensions: args.extensions,
		replaceNewLineToBr: args.replaceNewLineToBr,
	});

	if (markdownToHtml._nay) {
		return markdownToHtml;
	}

	return Result({
		_yay: files_tiptap_html_to_json({
			html: markdownToHtml._yay,
			extensions: args.extensions,
		}),
	});
}

/**
 * Convert a Uint8Array to an ArrayBuffer.
 */
export function files_u8_to_array_buffer(u8: Uint8Array) {
	// Zero-copy if view covers entire buffer
	if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
		return u8.buffer as ArrayBuffer;
	}
	// Copy only if partial view (handles both cases safely)
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Compare two Uint8Arrays for byte-level equality.
 */
export function files_u8_equals(a: Uint8Array, b: Uint8Array) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// #region yjs
export function files_yjs_create_empty_state_update() {
	return encodeStateAsUpdate(new YDoc());
}

export function files_yjs_doc_apply_array_buffer_update(mut_yjsDoc: YDoc, update: ArrayBuffer) {
	if (update.byteLength === 0) {
		return;
	}

	applyUpdate(mut_yjsDoc, new Uint8Array(update));
}

/**
 * Applies incremental Yjs updates to an existing Y.Doc.
 *
 * @param mut_yjsDoc - The Y.Doc instance to apply updates to (mutated in place)
 * @param incrementalUpdates - Array of incremental Yjs updates (ArrayBuffer) to apply
 */
export function files_yjs_doc_apply_incremental_array_buffer_updates(
	mut_yjsDoc: YDoc,
	incrementalUpdates: Array<ArrayBuffer>,
): void {
	for (const incrementalUpdate of incrementalUpdates) {
		files_yjs_doc_apply_array_buffer_update(mut_yjsDoc, incrementalUpdate);
	}
}

/**
 * Creates a Y.Doc from a Yjs update.
 *
 * Applies the update to a new Y.Doc instance.
 *
 * Optionally applies additional incremental updates.
 *
 * @param update - The initial Yjs update (ArrayBuffer) to apply to create the Y.Doc
 * @param args - Optional configuration object
 * @param args.additionalIncrementalArrayBufferUpdates - Optional array of incremental Yjs updates (ArrayBuffer)
 * to apply after the initial update
 * @returns A new Y.Doc instance with all updates applied
 */
export function files_yjs_doc_create_from_array_buffer_update(
	update: ArrayBuffer,
	args?: { additionalIncrementalArrayBufferUpdates?: Array<ArrayBuffer> },
): YDoc {
	const yjsDoc = new YDoc();
	files_yjs_doc_apply_array_buffer_update(yjsDoc, update);

	if (args?.additionalIncrementalArrayBufferUpdates) {
		files_yjs_doc_apply_incremental_array_buffer_updates(yjsDoc, args.additionalIncrementalArrayBufferUpdates);
	}

	return yjsDoc;
}

export function files_yjs_doc_update_from_tiptap_editor(args: {
	mut_yjsDoc: YDoc;
	tiptapEditor: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsFragment = args.mut_yjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText);

	args.mut_yjsDoc.transact(() => {
		updateYFragment(args.mut_yjsDoc, yjsFragment, args.tiptapEditor.state.doc, {
			mapping: new Map(),
			isOMark: new Map(),
		});
	}, args.opKind);
}

export function files_yjs_doc_create_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = new YDoc();
	files_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.tiptapEditor,
		opKind: "snapshot-restore",
	});
	return yjsDoc;
}

export function files_yjs_doc_get_markdown(args: { yjsDoc: YDoc }) {
	const yjsDoc = args.yjsDoc;
	const fragment = yjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText);

	const editor = files_headless_tiptap_editor_create();

	if (editor._nay) {
		return editor;
	}

	try {
		const node = yXmlFragmentToProseMirrorRootNode(fragment, editor._yay.schema);
		const json = node.toJSON();
		editor._yay.commands.setContent(json);
		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		return Result({ _yay: markdown });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

export function files_yjs_doc_update_from_markdown(args: { markdown: string; mut_yjsDoc: YDoc }) {
	const editor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
	});

	if (editor._nay) {
		return editor;
	}

	try {
		files_yjs_doc_update_from_tiptap_editor({
			mut_yjsDoc: args.mut_yjsDoc,
			tiptapEditor: editor._yay,
			opKind: "user-edit",
		});

		return Result({ _yay: args.mut_yjsDoc });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while updating Y.Doc from tiptap editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

export function files_yjs_doc_create_from_markdown(args: { markdown: string }) {
	const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: args.markdown } });
	if (editor._nay) {
		return editor;
	}

	try {
		return files_yjs_doc_create_from_tiptap_editor({ tiptapEditor: editor._yay });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while creating Y.Doc from tiptap editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

export function files_yjs_doc_clone(args: { yjsDoc: YDoc }) {
	const clonedDoc = new YDoc();
	applyUpdate(clonedDoc, encodeStateAsUpdate(args.yjsDoc));
	return clonedDoc;
}

const files_yjs_encoded_empty_diff_update = new Uint8Array([0, 0]);

/**
 * Returns whether a Yjs diff update encodes no content changes.
 *
 * Yjs may encode an empty diff as either an empty update (`byteLength === 0`)
 * or the canonical 2-byte marker `[0, 0]`.
 *
 * @param diffUpdate - Diff update bytes produced by Yjs.
 *
 * @returns `true` when the update does not contain operations.
 */
export function files_yjs_doc_is_diff_update_empty(diffUpdate: Uint8Array) {
	return diffUpdate.byteLength === 0 || files_u8_equals(diffUpdate, files_yjs_encoded_empty_diff_update);
}

/**
 * Computes the remaining portion of a diff update that is not already present in a target Y.Doc.
 *
 * This is useful when a diff update was produced from an older base state and you want to keep only
 * the operations that the target Y.Doc still needs. Yjs performs this by filtering the diff update
 * against the target doc's current state vector.
 *
 * @param args.diffUpdate - Diff update bytes to filter against the target doc state.
 * @param args.yjsDoc - Target Y.Doc whose state vector is used to remove already-applied operations.
 *
 * @returns `null` when the target Y.Doc already contains the entire diff update; otherwise the
 * remaining diff update bytes.
 */
export function files_yjs_doc_compute_remaining_diff_update_from_yjs_doc(args: {
	diffUpdate: ArrayBuffer;
	yjsDoc: YDoc;
}) {
	if (args.diffUpdate.byteLength === 0) {
		return null;
	}

	const remainingDiffUpdate = diffUpdate(new Uint8Array(args.diffUpdate), encodeStateVector(args.yjsDoc));
	return files_yjs_doc_is_diff_update_empty(remainingDiffUpdate) ? null : remainingDiffUpdate;
}

export function files_yjs_compute_diff_update_from_state_vector(args: {
	yjsDoc: YDoc;
	yjsBeforeStateVector: Uint8Array;
}) {
	const diffUpdate = encodeStateAsUpdate(args.yjsDoc, args.yjsBeforeStateVector);
	return files_yjs_doc_is_diff_update_empty(diffUpdate) ? null : diffUpdate;
}

export function files_yjs_compute_diff_update_from_yjs_doc(args: { yjsDoc: YDoc; yjsBeforeDoc: YDoc }) {
	const yjsBeforeStateVector = encodeStateVector(args.yjsBeforeDoc);
	return files_yjs_compute_diff_update_from_state_vector({ yjsDoc: args.yjsDoc, yjsBeforeStateVector });
}

/**
 * Compare two diff updates that were produced from the same base Y.Doc.
 *
 * Performs a fast byte-level check first, then falls back to applying updates to
 * cloned docs and comparing their rich-text fragment JSON snapshots.
 *
 * @param args.baseYjsDoc - Base Y.Doc both diff updates are relative to
 * @param args.diffUpdateAFromBase - First diff update to compare
 * @param args.diffUpdateBFromBase - Second diff update to compare
 * @param args.diffUpdateBYjsDocFromBase - Optional precomputed doc with diffUpdateBFromBase already applied
 *
 * @returns `true` when both updates produce the same rich-text content
 */
export function files_yjs_doc_diff_updates_match(args: {
	baseYjsDoc: YDoc;
	diffUpdateAFromBase: ArrayBuffer;
	diffUpdateBFromBase: ArrayBuffer;
	diffUpdateBYjsDocFromBase?: YDoc;
}) {
	const isBytewiseMatch =
		args.diffUpdateAFromBase.byteLength === args.diffUpdateBFromBase.byteLength &&
		files_u8_equals(new Uint8Array(args.diffUpdateAFromBase), new Uint8Array(args.diffUpdateBFromBase));

	if (isBytewiseMatch) {
		return true;
	}

	const diffUpdateAYjsDoc = files_yjs_doc_clone({
		yjsDoc: args.baseYjsDoc,
	});
	files_yjs_doc_apply_array_buffer_update(diffUpdateAYjsDoc, args.diffUpdateAFromBase);

	let diffUpdateBYjsDoc = args.diffUpdateBYjsDocFromBase;
	if (!diffUpdateBYjsDoc) {
		diffUpdateBYjsDoc = files_yjs_doc_clone({
			yjsDoc: args.baseYjsDoc,
		});
		files_yjs_doc_apply_array_buffer_update(diffUpdateBYjsDoc, args.diffUpdateBFromBase);
	}

	return (
		diffUpdateAYjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText).toJSON() ===
		diffUpdateBYjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText).toJSON()
	);
}

// #endregion yjs

// #region tiptap editor
export const files_tiptap_empty_doc_json = ((/* iife */) => {
	function value(): TiptapJSONContent {
		return { type: "doc", content: [{ type: "paragraph" }] };
	}

	let cache: ReturnType<typeof value>;

	return function files_tiptap_empty_doc_json() {
		return (cache ??= value());
	};
})();

/**
 * Server-safe Tiptap extensions (no DOM, no React).
 *
 * Shared with client and server code.
 */
export const files_get_tiptap_shared_extensions = ((/* iife */) => {
	function value() {
		return {
			starterKit: StarterKit.configure({
				// The Liveblocks extension comes with its own history handling
				undoRedo: false,
				underline: false,
				dropcursor: false, // DOM-only, disabled for server
				gapcursor: false,
				listKeymap: false,

				horizontalRule: false,
			}),
			taskList: TaskList.configure({
				HTMLAttributes: {
					class: "not-prose pl-2",
				},
			}),
			taskItem: TaskItem.configure({
				HTMLAttributes: {
					class: "flex gap-2 items-start my-4",
				},
				nested: true,
			}),
			textAlign: TextAlign,
			typography: Typography,
			markdown: Markdown.configure({ marked: files_marked() }),
			highlight: Highlight.extend({
				renderMarkdown: (node: TiptapJSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) => {
					const color = node.attrs?.color;

					if (!color) {
						// Default to markdown syntax
						return `==${helpers.renderChildren(node.content || [])}==`;
					}

					const content = helpers.renderChildren(node.content || []);
					return `<mark style="background-color: ${color}">${content}</mark>`;
				},
			}).configure({
				multicolor: true,
			}),
			textStyle: TextStyle.extend({
				renderMarkdown: (node: TiptapJSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) => {
					const color = node.attrs?.color;

					if (!color) {
						return helpers.renderChildren(node.content || []);
					}

					const content = helpers.renderChildren(node.content || []);
					return `<span style="color: ${color}">${content}</span>`;
				},
			}),
			color: Color.configure({
				types: ["textStyle"],
			}),
			underline: Underline.extend({
				renderMarkdown: (node, helpers, ctx) => {
					// Return HTML <u> tag to preserve underline formatting
					const content = helpers.renderChildren(node.content || []);
					return `<u>${content}</u>`;
				},
			}),
			horizontalRule: HorizontalRule.configure({
				HTMLAttributes: {
					class: "mt-4 mb-6 border-t border-muted-foreground",
				},
			}),
			liveblocksComments: CommentsExtension,
		};
	}

	let cache: ReturnType<typeof value>;

	return function files_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();

const get_tiptap_shared_extensions_list = ((/* iife */) => {
	function value() {
		return Object.values(files_get_tiptap_shared_extensions());
	}

	let cache: ReturnType<typeof value>;

	return function files_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();

/**
 * Create a headless Tiptap editor instance.
 *
 * Can be used server-side (no DOM) or client-side (with optional additional extensions).
 *
 * @param args.additionalExtensions - Optional array of additional extensions to include
 *   (e.g., Collaboration extension for client-side Yjs sync)
 * @returns Editor instance
 */
export function files_headless_tiptap_editor_create(args?: {
	initialContent?: { markdown?: string; json?: TiptapJSONContent };
	additionalExtensions?: Extension[];
}) {
	const baseExtensions = get_tiptap_shared_extensions_list();
	const extensions = args?.additionalExtensions ? [...baseExtensions, ...args.additionalExtensions] : baseExtensions;

	const editor = new Editor({
		element: null, // REQUIRED for headless (no DOM mounting)
		content: { type: "doc", content: [] },
		extensions,
		enableCoreExtensions: false,
		enableInputRules: false,
		enablePasteRules: false,
		coreExtensionOptions: {
			delete: { async: false },
		},
	});

	// In Tiptap's core, extension ProseMirror plugins are normally installed during `createView()`.
	// Headless editors never create a DOM view, so we must explicitly install plugins by
	// reconfiguring the state and updating via the headless `view` proxy.
	editor.view.updateState(
		editor.state.reconfigure({
			plugins: editor.extensionManager.plugins,
		}),
	);

	if (args?.initialContent?.markdown) {
		const result = files_headless_tiptap_editor_set_content_from_markdown({
			markdown: args.initialContent.markdown,
			mut_editor: editor,
		});

		if (result._nay) {
			return result;
		}
	} else if (args?.initialContent?.json) {
		editor.commands.setContent(args.initialContent.json);
	}

	return Result({ _yay: editor });
}

/**
 * Set the content of a headless editor from a Markdown string.
 *
 * This is the primary function for parsing snapshot Markdown in Convex.
 *
 * @param markdown - Markdown string
 * @returns A Result containing the Tiptap JSON document or an error
 *
 * @example
 *
 * ```ts
 * const json = files_tiptap_markdown_to_json("# Title\n\nParagraph");
 * // { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, ... }] }
 * ```
 */
export function files_headless_tiptap_editor_set_content_from_markdown(args: { markdown: string; mut_editor: Editor }) {
	const editor = args.mut_editor;
	const json = files_tiptap_markdown_to_json({
		markdown: args.markdown,
		extensions: editor.options.extensions,
	});

	if (json._nay) {
		return json;
	}

	editor.commands.setContent(json._yay);
	return Result({ _yay: json._yay });
}

/**
 * Extract plain text from a headless Tiptap editor instance.
 *
 * Uses Tiptap's built-in text serialization and trims leading/trailing whitespace.
 *
 * @param args.mut_editor - Headless editor instance
 * @param args.blockSeparator - Optional separator inserted between block nodes. Defaults to "\n\n".
 * @returns Plain text content
 */
export function files_headless_tiptap_editor_get_plain_text(args: { mut_editor: Editor; blockSeparator?: string }) {
	const editor = args.mut_editor;
	const plainText = editor.getText({
		blockSeparator: args.blockSeparator ?? "\n\n",
	});
	return plainText.trim();
}

/**
 * Convert Markdown to plain text using a headless Tiptap editor.
 *
 * Creates a temporary headless editor, loads Markdown content, extracts plain text,
 * then destroys the editor before returning.
 *
 * @param args.markdown - Markdown string
 * @param args.blockSeparator - Optional separator inserted between block nodes. Defaults to "\n\n".
 * @returns A Result containing plain text or an error
 */
export function files_tiptap_markdown_to_plain_text(args: { markdown: string; blockSeparator?: string }) {
	const editor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
	});
	if (editor._nay) {
		return editor;
	}

	try {
		return Result({
			_yay: files_headless_tiptap_editor_get_plain_text({
				mut_editor: editor._yay,
				blockSeparator: args.blockSeparator,
			}),
		});
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while extracting plain text from editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

/**
 * Set the content of a headless editor from a Tiptap JSON document.
 *
 * Inverse of markdown_to_json, useful for serializing editor state.
 *
 * @param json - Tiptap JSON document
 * @returns A Result containing the Markdown string or an error
 */
export function files_headless_tiptap_editor_get_markdown(args: { mut_editor: Editor }) {
	const editor = args.mut_editor;
	if (!editor.markdown) throw should_never_happen("editor.markdown is not set");
	const markdown = editor.markdown.serialize(editor.getJSON());
	return markdown;
}
// #endregion tiptap editor
