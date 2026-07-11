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
import stringByteLength from "string-byte-length";
import { Doc as YDoc, diffUpdate, encodeStateAsUpdate, applyUpdate, encodeStateVector } from "yjs";
import { Editor, Extension, Node, type Extensions } from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { updateYFragment } from "y-prosemirror";
import { composite_id, is_browser, path_extract_segments_from, should_never_happen } from "../shared/shared-utils.ts";
import { CommentsExtension } from "@liveblocks/react-tiptap";
import { generateJSON as tiptap_generateJSON_server } from "@tiptap/html/server";
import { generateJSON as tiptap_generateJSON_browser } from "@tiptap/html";
import { Result } from "common/errors-as-values-utils.ts";
import type { app_convex_Doc, app_convex_Id } from "./app-convex.ts";
import type { Merge } from "type-fest";

export const files_ROOT_ID = "root" as const;

export type files_VisibleTreeNode = Omit<
	app_convex_Doc<"files_nodes">,
	"organizationId" | "workspaceId" | "createdBy" | "updatedBy"
> & {
	organizationId: app_convex_Id<"organizations">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
	createdBy: app_convex_Id<"users">;
	updatedBy: app_convex_Id<"users">;
};

export const files_SYNTHETIC_ROOT_FOLDER = {
	_id: files_ROOT_ID,
	_creationTime: 0,
	organizationId: "",
	workspaceId: "",
	path: "/",
	treePath: "/",
	pathDepth: 0,
	lowercaseExtension: null,
	name: "",
	kind: "folder",
	contentType: undefined,
	statsId: undefined,
	assetId: undefined,
	archiveOperationId: undefined,
	yjsLastSequenceId: undefined,
	yjsSnapshotId: undefined,
	parentId: "",
	updatedBy: "",
	createdBy: "",
	updatedAt: 0,
} as const satisfies Merge<
	files_VisibleTreeNode,
	{
		_id: typeof files_ROOT_ID;
		organizationId: "";
		workspaceId: "";
		parentId: "";
		name: "";
		path: "/";
		treePath: "/";
		updatedBy: "";
		updatedAt: 0;
		createdBy: "";
		_creationTime: 0;
	}
>;

export const files_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "markdown",
};

export const files_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.`;

export type files_ContentType =
	| `text/${"markdown" | "plain"}${"" | `;charset=${"utf-8"}`}`
	| "application/octet-stream";

export type files_SpecialFileName = "README.md";

export type files_InlineAiModelId = "gpt-5-mini";

export const files_MAX_TEXT_CONTENT_BYTES = 900_000;

export function files_get_utf8_byte_size(content: string) {
	return stringByteLength(content);
}

/**
 * 50 MiB.
 *
 * Keep this aligned with the Modal file converter `maxBytes` contract.
 **/
export const files_MAX_UPLOADS_BYTES = 50 * 1024 * 1024;

export function files_create_tree_items_list_from_nodes(nodes: files_VisibleTreeNode[]) {
	return [files_SYNTHETIC_ROOT_FOLDER, ...nodes];
}

export type files_TreeItem = ReturnType<typeof files_create_tree_items_list_from_nodes>[number];

export function files_is_node(item: files_TreeItem): item is files_VisibleTreeNode {
	return item._id !== files_ROOT_ID;
}

export function files_create_room_id(organizationId: string, workspaceId: string, nodeId: string) {
	return composite_id("rooms", "files_nodes", organizationId, workspaceId, nodeId);
}

/**
 * Return the end index of the file stem. The file name is the full leaf name;
 * the stem is the part before the final extension separator.
 */
export function files_find_file_stem_end_index(args: { fileName: string }) {
	const extensionSeparatorIndex = args.fileName.lastIndexOf(".");
	if (extensionSeparatorIndex > 0) {
		return extensionSeparatorIndex;
	}

	return args.fileName.length;
}

export function files_format_size(size: number | undefined) {
	if (size === undefined) {
		return "Unknown";
	}
	if (size < 1024) {
		return `${size} bytes`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 1,
		style: "unit",
		unit: "megabyte",
		unitDisplay: "short",
	}).format(size / (1024 * 1024));
}

export type files_UploadPipelineState =
	| "not_applicable"
	| "waiting_for_upload"
	| "pending_processing"
	| "processing"
	| "terminal";

type files_UploadPipelineAsset = Pick<app_convex_Doc<"files_r2_assets">, "kind" | "r2Key"> & {
	processingWorkId?: app_convex_Doc<"files_r2_assets">["processingWorkId"] | null;
};

// Use asset conversion state as the pipeline signal; editor availability is a separate Yjs outcome.
export function files_get_upload_pipeline_state(
	asset: files_UploadPipelineAsset | null | undefined,
): files_UploadPipelineState {
	if (!asset) {
		return "not_applicable";
	}
	if (asset.processingWorkId === null) {
		return "terminal";
	}
	if (asset.processingWorkId !== undefined) {
		return "processing";
	}
	if (asset.kind === "upload" && !asset.r2Key) {
		return "waiting_for_upload";
	}

	return asset.kind === "upload" ? "pending_processing" : "not_applicable";
}

type FileNodeFieldsForEditability = Pick<
	app_convex_Doc<"files_nodes">,
	"kind" | "assetId" | "yjsSnapshotId" | "yjsLastSequenceId"
>;

export function files_node_has_editable_yjs_state<Node extends FileNodeFieldsForEditability | null | undefined>(
	node: Node,
): node is NonNullable<Node> & {
	kind: "file";
	assetId: NonNullable<FileNodeFieldsForEditability["assetId"]>;
	yjsSnapshotId: NonNullable<FileNodeFieldsForEditability["yjsSnapshotId"]>;
	yjsLastSequenceId: NonNullable<FileNodeFieldsForEditability["yjsLastSequenceId"]>;
} {
	// Treat Yjs pointers as the editor-ready signal instead of inferring readiness from MIME metadata.
	return (
		node?.kind === "file" &&
		node.assetId !== undefined &&
		node.yjsSnapshotId !== undefined &&
		node.yjsLastSequenceId !== undefined
	);
}

// #region file name normalization
const FILES_NORMALIZED_DOTTED_NAME_REGEX = /^(?!.*[._-]{2})[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const FILES_DIACRITIC_MARKS_REGEX = /\p{Mark}/gu;
const FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX = /[^a-z0-9_-]+/g;
const FILES_UNSUPPORTED_DOTTED_NAME_CHARACTERS_REGEX = /[^a-z0-9._-]+/g;
const FILES_REPEATED_DASH_REGEX = /-+/g;
const FILES_REPEATED_UNDERSCORE_REGEX = /_+/g;
const FILES_MIXED_SEPARATOR_SEQUENCE_REGEX = /[._-]{2,}/g;
const FILES_EDGE_SEPARATOR_REGEX = /^[._-]+|[._-]+$/g;
const FILES_PATH_SEPARATOR_REGEX = /[\\/]+/g;
const FILES_TRAILING_DOTS_REGEX = /\.+$/g;
const FILES_NAME_INPUT_ALPHANUMERIC_REGEX = /^[a-z0-9]$/;
const FILES_FILE_NAME_INPUT_SEPARATOR_REGEX = /^[/._-]$/;
const FILES_FOLDER_NAME_INPUT_SEPARATOR_REGEX = /^[/._-]$/;
// Keep special Markdown file basenames in their conventional case after the general lowercase normalization.
type files_SpecialFileBaseName = files_SpecialFileName extends `${infer BaseName}.${string}`
	? BaseName
	: files_SpecialFileName;
const FILES_SPECIAL_UPPERCASE_FILE_BASE_NAMES = new Set(["readme" satisfies Lowercase<files_SpecialFileBaseName>]);

export function files_normalize_name_input(args: {
	kind: app_convex_Doc<"files_nodes">["kind"];
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

export function files_normalize_name(kind: app_convex_Doc<"files_nodes">["kind"], name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result(kind);
	}

	if (kind === "folder") {
		// Keep already-canonical folder names on a cheap fast path; pasted path-like names take the slower cleanup route.
		if (FILES_NORMALIZED_DOTTED_NAME_REGEX.test(name)) {
			return Result({ _yay: name });
		}

		// Treat dots as regular internal separators for folders, but keep path separators as cleanup input.
		const normalizedName = name
			.normalize("NFKD")
			.replace(FILES_DIACRITIC_MARKS_REGEX, "")
			.toLowerCase()
			.replace(FILES_UNSUPPORTED_DOTTED_NAME_CHARACTERS_REGEX, "-")
			.replace(FILES_REPEATED_DASH_REGEX, "-")
			.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
			.replace(FILES_MIXED_SEPARATOR_SEQUENCE_REGEX, "-")
			.replace(FILES_EDGE_SEPARATOR_REGEX, "");

		return Result({ _yay: normalizedName || "untitled" });
	}

	return files_normalize_markdown_name(name);
}

export function files_normalize_markdown_name(name: string) {
	if (name.includes("..")) {
		// Reject double dots because their basename/extension intent is ambiguous.
		return files_invalid_name_result("file");
	}

	const trimmedName = name.trim();
	if (trimmedName === ".") {
		return files_invalid_name_result("file");
	}

	if (trimmedName.endsWith(".")) {
		// Treat a trailing dot as a missing Markdown extension.
		const fileNameParts = files_normalize_file_name_parts({
			fileName: trimmedName.replace(FILES_TRAILING_DOTS_REGEX, ""),
			pathSeparators: "dash",
			fallbackBaseName: "untitled",
		});

		if (!fileNameParts.baseName) {
			return files_invalid_name_result("file");
		}

		return Result({ _yay: files_apply_special_file_name_case(`${fileNameParts.baseName}.md`) });
	}

	const fileNameParts = files_normalize_file_name_parts({
		fileName: name,
		pathSeparators: "dash",
		fallbackBaseName: "untitled",
	});
	if (fileNameParts.extension && fileNameParts.extension !== "md") {
		return files_invalid_name_result("file");
	}

	return Result({ _yay: files_apply_special_file_name_case(`${fileNameParts.baseName}.md`) });
}

// Normalize browser File.name for an app node while preserving non-Markdown extensions.
export function files_normalize_upload_file_name(fileName: string) {
	const fileNameParts = files_normalize_file_name_parts({
		fileName,
		pathSeparators: "leaf",
		fallbackBaseName: "upload",
	});
	return fileNameParts.extension ? `${fileNameParts.baseName}.${fileNameParts.extension}` : fileNameParts.baseName;
}

function files_normalize_file_name_parts(args: {
	fileName: string;
	pathSeparators: "dash" | "leaf";
	fallbackBaseName: string;
}) {
	const name =
		args.pathSeparators === "leaf"
			? (args.fileName.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? args.fallbackBaseName)
			: args.fileName;
	const normalizedName = name
		.normalize("NFKD")
		.replace(FILES_DIACRITIC_MARKS_REGEX, "")
		.toLowerCase()
		.trim()
		.replace(FILES_PATH_SEPARATOR_REGEX, args.pathSeparators === "dash" ? "-" : "/");
	const parts = normalizedName.split(".").map(files_normalize_file_name_part);

	if (parts.length === 0) {
		return { baseName: args.fallbackBaseName, extension: null };
	}
	if (parts.length === 1) {
		return { baseName: parts[0] || args.fallbackBaseName, extension: null };
	}

	const extension = parts.at(-1) || null;
	const baseName = parts.slice(0, -1).filter(Boolean).join(".") || args.fallbackBaseName;
	if (!extension) {
		return { baseName, extension: null };
	}

	return {
		baseName,
		extension,
	};
}

function files_normalize_file_name_part(part: string) {
	return part
		.replace(FILES_UNSUPPORTED_NAME_PART_CHARACTERS_REGEX, "-")
		.replace(FILES_REPEATED_DASH_REGEX, "-")
		.replace(FILES_REPEATED_UNDERSCORE_REGEX, "_")
		.replace(FILES_MIXED_SEPARATOR_SEQUENCE_REGEX, "-")
		.replace(FILES_EDGE_SEPARATOR_REGEX, "");
}

export function files_get_normalized_node_path_segments(args: {
	kind: app_convex_Doc<"files_nodes">["kind"] | null;
	nameOrPath: string;
}) {
	if (!args.kind) {
		return null;
	}

	const trimmedNameOrPath = args.nameOrPath.trim();
	if (!trimmedNameOrPath) {
		return null;
	}

	const pathSegments = path_extract_segments_from(trimmedNameOrPath);
	if (pathSegments.length === 0) {
		return null;
	}

	const normalizedPathSegments: string[] = [];
	for (const [index, pathSegment] of pathSegments.entries()) {
		const isLeaf = index === pathSegments.length - 1;
		const pathSegmentKind = isLeaf ? args.kind : "folder";
		const normalizedName = files_normalize_name(pathSegmentKind, pathSegment);
		if (normalizedName._nay) {
			return { validationMessage: normalizedName._nay.message };
		}

		normalizedPathSegments.push(normalizedName._yay);
	}

	return { normalizedPathSegments };
}

function files_invalid_name_result(kind: app_convex_Doc<"files_nodes">["kind"]) {
	// Keep the visible message kind-specific while preserving the shared Result shape.
	return Result({
		_nay: {
			name: "nay",
			message: kind === "folder" ? "Invalid folder name" : "Invalid file name",
		},
	});
}

function files_normalize_name_input_character(kind: app_convex_Doc<"files_nodes">["kind"], character: string) {
	if (FILES_NAME_INPUT_ALPHANUMERIC_REGEX.test(character)) {
		// Accept lowercase ASCII letters and digits as valid draft characters.
		return character;
	}

	if (character === "/" || character === "\\") {
		// Keep path separators in create/rename drafts so the submit path can create missing folders.
		return "/";
	}

	if (character === ".") {
		// Allow dots as ordinary filename and folder-name separators.
		return character;
	}

	if (character === "-" || character === "_") {
		// Keep supported separators and let the caller handle adjacency rules.
		return character;
	}

	// Unsupported characters become dashes so live typing can recover when possible.
	return "-";
}

function files_is_name_input_separator(kind: app_convex_Doc<"files_nodes">["kind"], character: string) {
	// Treat dots as regular separators for both files and folders.
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
					// YAML-style frontmatter. Recognized only at the start of the root
					// document token stream so nested list/blockquote content keeps its
					// normal Markdown meaning. The emitted HTML round-trips through
					// `files_frontmatter_node.parseHTML` -> Tiptap JSON -> `renderMarkdown`.
					name: "frontmatter",
					level: "block",
					start(src) {
						return src.startsWith("---\n") ? 0 : -1;
					},
					tokenizer(this: { lexer: { tokens: unknown } }, src, tokens) {
						if (tokens !== this.lexer.tokens) return undefined;
						if (tokens && tokens.length > 0) return undefined;
						if (!src.startsWith("---\n")) return undefined;
						const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
						if (!match) return undefined;
						return {
							type: "frontmatter",
							raw: match[0],
							text: match[1],
						};
					},
					renderer(token) {
						const text = (token as { text?: string }).text ?? "";
						const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
						return `<pre data-frontmatter>${escaped}</pre>`;
					},
				},
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

// #region frontmatter
// The frontmatter parser lives inside `files_marked()` above as a custom marked
// block tokenizer. This Node is the Tiptap end of the round-trip: it picks up
// the `<pre data-frontmatter>` HTML emitted by marked and re-emits the YAML
// fence when serializing back to markdown.
export const files_frontmatter_node = Node.create({
	name: "frontmatter",
	// Above `codeBlock` (default priority 100) so `<pre data-frontmatter>` is
	// picked up by this node instead of being parsed as a generic code block.
	priority: 1000,
	group: "block",
	atom: true,
	selectable: true,
	defining: true,

	addAttributes() {
		return {
			text: {
				default: "",
				parseHTML: (element) => element.textContent ?? "",
				renderHTML: () => ({}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "pre[data-frontmatter]" }];
	},

	renderHTML({ node }) {
		return ["pre", { "data-frontmatter": "" }, node.attrs.text];
	},

	renderMarkdown(node) {
		const text = typeof node.attrs?.text === "string" ? node.attrs.text : "";
		// The doc renderer joins block-level siblings with "\n\n",
		// so frontmatter must not emit its own trailing newlines.
		return `---\n${text}\n---`;
	},
});
// #endregion frontmatter

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
			frontmatter: files_frontmatter_node,
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
