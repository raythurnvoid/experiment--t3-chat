import { tool, type InferToolInput, type InferToolOutput } from "ai";
import Exa, { ExaError, type RegularSearchOptions, type SearchResponse } from "exa-js";
import z from "zod";
import dedent from "dedent";
import { createPatch } from "diff";
import type { ActionCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { internal } from "../convex/_generated/api.js";
import { path_name_of, server_path_normalize, server_path_parent_of } from "./server-utils.ts";
import { minimatch } from "minimatch";
import { files_chunk_has_bitmask_flag, files_chunk_BITMASK_FLAGS } from "./files-markdown-chunking-mastra.ts";
import { files_get_normalized_node_path_segments } from "./files.ts";

/**
 * Advanced replace utility mirroring OpenCode's edit replacer pipeline.
 *
 * Notes:
 * - We require oldString to be non-empty (unlike OpenCode's special-case overwrite).
 * - The pipeline order and algorithms match OpenCode's active modes.
 */
type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

function normalize_lf_newlines(content: string) {
	return content.replace(/\r\n?/g, "\n");
}

function normalize_ai_edit_content(content: string, baselineContent: string) {
	if (content.length === 0) {
		return content;
	}

	const baselineHasTrailingNewline = baselineContent.endsWith("\n");
	const contentHasTrailingNewline = content.endsWith("\n");

	if (baselineHasTrailingNewline && !contentHasTrailingNewline) {
		return `${content}\n`;
	}

	if (!baselineHasTrailingNewline && contentHasTrailingNewline) {
		return content.replace(/\n+$/g, "");
	}

	return content;
}

/**
 * Calculate the similarity between two strings.
 *
 * @returns A number between 0 and 1, an higher number means the strings are more similar.
 */
function levenshtein(a: string, b: string): number {
	if (a === "" || b === "") return Math.max(a.length, b.length);
	const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
		}
	}
	return matrix[a.length][b.length];
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (SimpleReplacer)
 *
 * This replacer matches the exact literal oldString as-is,
 * ensuring byte-for-byte precision and highly predictable diffs in the simplest case.
 *
 * Order: 1
 * Pros:
 * - Exact and fast
 * - Lowest risk, predictable diffs
 * Cons:
 * - Brittle to whitespace/escaping/indentation changes
 */
function* ai_chat_tool_edit_file_replacer_simple(_content: string, find: string): Generator<string, void, unknown> {
	if (find !== find.trim()) return;
	yield find;
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (LineTrimmedReplacer)
 *
 * This replacer compares multi-line content by trimming each line before matching,
 * making it resilient to incidental leading/trailing spaces while preserving the original block.
 *
 * Order: 2
 * Pros:
 * - Ignores leading/trailing whitespace per line
 * - Good for multi-line blocks
 * Cons:
 * - Can collide when multiple blocks are equal after per-line trim
 */
function* ai_chat_tool_edit_file_replacer_line_trimmed(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
		let matches = true;
		for (let j = 0; j < searchLines.length; j++) {
			const originalTrimmed = originalLines[i + j].trim();
			const searchTrimmed = searchLines[j].trim();
			if (originalTrimmed !== searchTrimmed) {
				matches = false;
				break;
			}
		}
		if (matches) {
			let matchStartIndex = 0;
			for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1;
			let matchEndIndex = matchStartIndex;
			for (let k = 0; k < searchLines.length; k++) {
				matchEndIndex += originalLines[i + k].length;
				if (k < searchLines.length - 1) matchEndIndex += 1;
			}
			yield content.substring(matchStartIndex, matchEndIndex);
		}
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (BlockAnchorReplacer)
 *
 * This replacer anchors on the first and last trimmed lines of the block,
 * then checks middle-line similarity, allowing matches even when the interior has drifted.
 *
 * Order: 3
 * Pros:
 * - Robust to middle-line drift using first/last anchors
 * - Can find moved blocks
 * Cons:
 * - Heuristic thresholds; slower on large files
 * - Possible false positives
 */
function* ai_chat_tool_edit_file_replacer_block_anchor(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const originalLines = content.split("\n");
	const searchLines = find.split("\n");
	if (searchLines.length < 3) return;
	if (searchLines[searchLines.length - 1] === "") searchLines.pop();
	const firstLineSearch = searchLines[0].trim();
	const lastLineSearch = searchLines[searchLines.length - 1].trim();
	const searchBlockSize = searchLines.length;
	const candidates: Array<{ startLine: number; endLine: number }> = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (originalLines[i].trim() !== firstLineSearch) continue;
		for (let j = i + 2; j < originalLines.length; j++) {
			if (originalLines[j].trim() === lastLineSearch) {
				candidates.push({ startLine: i, endLine: j });
				break;
			}
		}
	}
	if (candidates.length === 0) return;
	if (candidates.length === 1) {
		const { startLine, endLine } = candidates[0]!;
		const actualBlockSize = endLine - startLine + 1;
		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck > 0) {
			for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
				const originalLine = originalLines[startLine + j].trim();
				const searchLine = searchLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += (1 - distance / maxLen) / linesToCheck;
				if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
			}
		} else {
			similarity = 1.0;
		}
		if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
			let matchStartIndex = 0;
			for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
			let matchEndIndex = matchStartIndex;
			for (let k = startLine; k <= endLine; k++) {
				matchEndIndex += originalLines[k].length;
				if (k < endLine) matchEndIndex += 1;
			}
			yield content.substring(matchStartIndex, matchEndIndex);
		}
		return;
	}
	let bestMatch: { startLine: number; endLine: number } | null = null;
	let maxSimilarity = -1;
	for (const candidate of candidates) {
		const { startLine, endLine } = candidate;
		const actualBlockSize = endLine - startLine + 1;
		let similarity = 0;
		const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
		if (linesToCheck > 0) {
			for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
				const originalLine = originalLines[startLine + j].trim();
				const searchLine = searchLines[j].trim();
				const maxLen = Math.max(originalLine.length, searchLine.length);
				if (maxLen === 0) continue;
				const distance = levenshtein(originalLine, searchLine);
				similarity += 1 - distance / maxLen;
			}
			similarity /= linesToCheck || 1;
		} else {
			similarity = 1.0;
		}
		if (similarity > maxSimilarity) {
			maxSimilarity = similarity;
			bestMatch = candidate;
		}
	}
	if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
		const { startLine, endLine } = bestMatch;
		let matchStartIndex = 0;
		for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
		let matchEndIndex = matchStartIndex;
		for (let k = startLine; k <= endLine; k++) {
			matchEndIndex += originalLines[k].length;
			if (k < endLine) matchEndIndex += 1;
		}
		yield content.substring(matchStartIndex, matchEndIndex);
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (WhitespaceNormalizedReplacer)
 *
 * This replacer collapses whitespace for comparison so that spacing differences
 * do not prevent a match, while still yielding the original text for replacement.
 *
 * Order: 4
 * Pros:
 * - Collapses whitespace; tolerant to spacing variations
 * - Works for inline and multi-line matches
 * Cons:
 * - Risky when whitespace is semantically meaningful (tables, YAML, code)
 */
function* ai_chat_tool_edit_file_replacer_whitespace_normalized(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
	const normalizedFind = normalizeWhitespace(find);
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (normalizeWhitespace(line) === normalizedFind) {
			yield line;
		} else {
			const normalizedLine = normalizeWhitespace(line);
			if (normalizedLine.includes(normalizedFind)) {
				const words = find.trim().split(/\s+/);
				if (words.length > 0) {
					const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
					try {
						const regex = new RegExp(pattern);
						const match = line.match(regex);
						if (match) yield match[0]!;
					} catch {}
				}
			}
		}
	}
	const findLines = find.split("\n");
	if (findLines.length > 1) {
		for (let i = 0; i <= lines.length - findLines.length; i++) {
			const block = lines.slice(i, i + findLines.length);
			if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
				yield block.join("\n");
			}
		}
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (IndentationFlexibleReplacer)
 *
 * This replacer removes common indentation before comparison to handle blocks
 * that have been re-indented, matching the original block regardless of leading spaces.
 *
 * Order: 5
 * Pros:
 * - Matches blocks regardless of common leading indentation
 * - Good for re-indented code/docs
 * Cons:
 * - Can over-match the same block at multiple indents
 */
function* ai_chat_tool_edit_file_replacer_indentation_flexible(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const removeIndentation = (text: string) => {
		const lines = text.split("\n");
		const nonEmpty = lines.filter((l) => l.trim().length > 0);
		if (nonEmpty.length === 0) return text;
		const minIndent = Math.min(
			...nonEmpty.map((line) => {
				const m = line.match(/^(\s*)/);
				return m ? m[1]!.length : 0;
			}),
		);
		return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
	};
	const normalizedFind = removeIndentation(find);
	const contentLines = content.split("\n");
	const findLines = find.split("\n");
	for (let i = 0; i <= contentLines.length - findLines.length; i++) {
		const block = contentLines.slice(i, i + findLines.length).join("\n");
		if (removeIndentation(block) === normalizedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (EscapeNormalizedReplacer)
 *
 * This replacer unescapes sequences like \n and \t when matching,
 * making it possible to locate content embedded inside string literals or escaped contexts.
 *
 * Order: 6
 * Pros:
 * - Unescapes sequences (\n, \t, \' , \" , \`, \\) to match embedded strings
 * Cons:
 * - May over-match in files with many similar string literals
 */
function* ai_chat_tool_edit_file_replacer_escape_normalized(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const unescapeString = (str: string): string =>
		str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
			switch (captured) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				case "'":
					return "'";
				case '"':
					return '"';
				case "`":
					return "`";
				case "\\":
					return "\\";
				case "\n":
					return "\n";
				case "$":
					return "$";
				default:
					return match;
			}
		});
	const unescapedFind = unescapeString(find);
	if (unescapeString(content) === content && unescapedFind === find) {
		return;
	}
	if (unescapeString(content) === unescapedFind) {
		yield content;
	}
	if (content.includes(unescapedFind)) yield unescapedFind;
	const lines = content.split("\n");
	const findLines = unescapedFind.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		const unescapedBlock = unescapeString(block);
		if (unescapedBlock === unescapedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (TrimmedBoundaryReplacer)
 *
 * This replacer trims only the outer boundary of the target text before matching,
 * making it resilient when the copied block includes extra leading or trailing blank space.
 *
 * Order: 7
 * Pros:
 * - Helps when the copied block differs only at the boundaries
 * Cons:
 * - Higher collision risk than earlier matchers
 */
function* ai_chat_tool_edit_file_replacer_trimmed_boundary(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const trimmedFind = find.trim();
	const trimmedFindLines = trimmedFind.split("\n");

	if (trimmedFind === find) return;

	if (content.includes(trimmedFind)) yield trimmedFind;

	const lines = content.split("\n");

	for (let i = 0; i <= lines.length - trimmedFindLines.length; i++) {
		const block = lines.slice(i, i + trimmedFindLines.length).join("\n");
		if (block.trim() === trimmedFind) yield block;
	}
}

/**
 * Inspired by `vendor/opencode/packages/opencode/src/tool/edit.ts` (ContextAwareReplacer)
 *
 * This replacer uses the first and last lines as anchors and accepts a candidate block
 * when the middle lines still resemble the requested block closely enough.
 *
 * Order: 8
 * Pros:
 * - Helps when the middle of a block drifted slightly
 * Cons:
 * - Heuristic; riskier than the earlier exact-ish fallbacks
 */
function* ai_chat_tool_edit_file_replacer_context_aware(
	content: string,
	find: string,
): Generator<string, void, unknown> {
	const findLines = find.split("\n");
	if (findLines.length < 3) return;
	if (findLines[findLines.length - 1] === "") findLines.pop();

	const contentLines = content.split("\n");
	const firstLine = findLines[0].trim();
	const lastLine = findLines[findLines.length - 1].trim();

	for (let i = 0; i < contentLines.length; i++) {
		if (contentLines[i].trim() !== firstLine) continue;

		for (let j = i + 2; j < contentLines.length; j++) {
			if (contentLines[j].trim() !== lastLine) continue;

			const blockLines = contentLines.slice(i, j + 1);
			if (blockLines.length !== findLines.length) break;

			let matchingLines = 0;
			let totalNonEmptyLines = 0;

			for (let k = 1; k < blockLines.length - 1; k++) {
				const blockLine = blockLines[k].trim();
				const findLine = findLines[k].trim();

				if (blockLine.length > 0 || findLine.length > 0) {
					totalNonEmptyLines++;
					if (blockLine === findLine) matchingLines++;
				}
			}

			if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
				yield blockLines.join("\n");
				break;
			}

			break;
		}
	}
}

export function replace_once_or_all(
	content: string,
	oldString: string,
	newString: string,
	opts?: { replaceAll?: boolean; mode?: "auto" | "exact" },
): { content: string; matches: number; matcher: string } {
	if (oldString.length === 0) throw new Error("oldString must not be empty");
	if (oldString === newString) throw new Error("oldString and newString must be different");

	const replaceAll = !!opts?.replaceAll;
	let foundMatch = false;
	const activePipeline =
		opts?.mode === "exact"
			? ([["simple", ai_chat_tool_edit_file_replacer_simple]] as const)
			: ([
					["simple", ai_chat_tool_edit_file_replacer_simple],
					["line_trimmed", ai_chat_tool_edit_file_replacer_line_trimmed],
					["block_anchor", ai_chat_tool_edit_file_replacer_block_anchor],
					["whitespace_normalized", ai_chat_tool_edit_file_replacer_whitespace_normalized],
					["indentation_flexible", ai_chat_tool_edit_file_replacer_indentation_flexible],
					["escape_normalized", ai_chat_tool_edit_file_replacer_escape_normalized],
					["trimmed_boundary", ai_chat_tool_edit_file_replacer_trimmed_boundary],
					["context_aware", ai_chat_tool_edit_file_replacer_context_aware],
					// Keep MultiOccurrence disabled.
					// `replaceAll` already handles the safe exact global-replace case.
				] as const satisfies ReadonlyArray<readonly [string, Replacer]>);

	for (const [matcher, replacer] of activePipeline) {
		for (const search of replacer(content, oldString)) {
			const firstIndex = content.indexOf(search);
			if (firstIndex === -1) continue;
			foundMatch = true;
			if (replaceAll) {
				const occurrences = search.length === 0 ? 0 : content.split(search).length - 1;
				if (occurrences === 0) continue;
				return {
					content: content.split(search).join(newString),
					matches: occurrences,
					matcher,
				};
			} else {
				const lastIndex = content.lastIndexOf(search);
				if (firstIndex !== lastIndex) continue;
				const updated = content.substring(0, firstIndex) + newString + content.substring(firstIndex + search.length);
				return { content: updated, matches: 1, matcher };
			}
		}
	}

	if (!foundMatch) {
		throw new Error(
			"oldString not found in content. It must match exactly, including whitespace, indentation, and line endings.",
		);
	}

	throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}

// #region read file
/**
 * Inspired by `opencode/packages/opencode/src/tool/read.ts`
 */
export function ai_chat_tool_create_read_file(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Reads a Markdown file from the files. You can access any file directly by absolute path.
			It is okay to read a file that does not exist; an error will be returned.

			Usage:
			- The path parameter must be an absolute path, not a relative path
			- By default, it reads up to 2000 lines starting from the beginning of the file
			- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
			- Any lines longer than 2000 characters will be truncated
			- Results are returned using cat -n format, with line numbers starting at 1
			- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful. 
			- Files use real Markdown paths such as /readme.md and /docs/setup.md.
			- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe('The absolute path to the file to read (must be absolute, starting with a slash "/", not relative)'),
			pendingUpdateId: z
				.string()
				.optional()
				.describe("Optional pending update id returned by a prior file read or edit result"),
			offset: z.number().int().gte(0).describe("The line number to start reading from (0-based)").optional(),
			limit: z.number().int().gte(1).lte(2000).describe("The number of lines to read (defaults to 2000)").default(2000),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);
			const pendingUpdateId = args.pendingUpdateId as Id<"files_pending_updates"> | undefined;

			const fileContent = await ctx.runQuery(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				path: normalizedPath,
				pendingUpdateId,
			});

			if (!fileContent) {
				// Try to get suggestions for similar paths
				const parentPath = server_path_parent_of(normalizedPath);
				if (parentPath) {
					const siblingPaths = await ctx.runQuery(internal.files_nodes.read_dir, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						path: parentPath,
					});

					const fileName = path_name_of(normalizedPath);
					const suggestions = siblingPaths
						.filter(
							(name) =>
								name.trim() !== "" &&
								(name.toLowerCase().includes(fileName.toLowerCase()) ||
									fileName.toLowerCase().includes(name.toLowerCase())),
						)
						.map((name) => {
							const trimmedName = name.trim();
							return parentPath === "/" ? `/${trimmedName}` : `${parentPath}/${trimmedName}`;
						})
						.slice(0, 3);

					if (suggestions.length > 0) {
						return {
							title: normalizedPath,
							output: "File not found. Did you mean one of these?\n" + suggestions.join("\n"),
						};
					}
				}

				return {
					title: normalizedPath,
					output: "File not found.",
				};
			}

			const lines = fileContent.content.split("\n");
			const offset = args.offset || 0;
			const limit = args.limit ?? 2000;

			// Apply offset and limit
			const selectedLines = lines.slice(offset, offset + limit);

			// Truncate lines first (match MAX_LINE_LENGTH = 2000)
			const truncatedLines = selectedLines.map((line) => (line.length > 2000 ? line.substring(0, 2000) + "..." : line));

			// Format with line numbers (1-based, 5-digit padding like original)
			const formattedLines = truncatedLines.map((line, index) => {
				const lineNumber = index + offset + 1;
				return `${lineNumber.toString().padStart(5, "0")}| ${line}`;
			});

			let output = "<file>\n";
			output += formattedLines.join("\n");

			if (lines.length > offset + selectedLines.length) {
				output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${offset + selectedLines.length})`;
			}
			output += "\n</file>";

			// Create preview (first 20 lines of truncated content, without line numbers)
			const preview = truncatedLines.slice(0, 20).join("\n");

			return {
				title: normalizedPath,
				output,
				metadata: {
					preview,
					nodeId: fileContent.nodeId,
					pendingUpdateId: fileContent.pendingUpdateId,
				},
			};
		},
	});
}

type ai_chat_tool_create_read_file_Tool = ReturnType<typeof ai_chat_tool_create_read_file>;
export type ai_chat_tool_create_read_file_ToolInput = InferToolInput<ai_chat_tool_create_read_file_Tool>;
export type ai_chat_tool_create_read_file_ToolOutput = InferToolOutput<ai_chat_tool_create_read_file_Tool>;
// #endregion read file

// #region list files
/**
 * Inspired by `opencode/packages/opencode/src/tool/ls.ts`
 */
export function ai_chat_tool_create_list_files(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Lists descendant folders and files in a given path. \
			The path parameter must be an absolute path, not a relative path. \
			You can optionally provide an array of glob patterns to ignore with the ignore parameter. \
			You should generally prefer the Glob and Grep tools, if you know which directories to search.
			The root path is "/", you can use it to list all files.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe("The absolute path to the directory to list (must be absolute, not relative)")
				.default("/"),
			ignore: z.array(z.string()).describe("List of glob patterns to ignore").optional(),
			maxDepth: z.number().int().gte(0).lte(10).describe("The maximum depth to list").default(5),
			limit: z.number().int().gte(1).lte(100).describe("The maximum number of items to list").default(100),
		}),

		execute: async (args) => {
			const matchesAnyIgnore = (path: string, ignores?: string[]): boolean => {
				if (!ignores || ignores.length === 0) return false;
				return ignores.some((pattern) => minimatch(path, pattern));
			};

			const path = server_path_normalize(args.path || "/");

			const list = await ctx.runQuery(internal.files_nodes.list_files, {
				path: path,
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				maxDepth: args.maxDepth,
				limit: args.limit,
			});

			// Apply ignore filters (on absolute paths)
			const visiblePaths = list.items.filter((p) => !matchesAnyIgnore(p.path, args.ignore));

			const output = visiblePaths
				.map((item) => `${item.path}${item.kind === "folder" ? "/" : ""}${item.depthTruncated ? " (...)" : ""}`)
				.join("\n");

			return {
				title: path,
				metadata: {
					count: visiblePaths.length,
					truncated: list.truncated,
				},
				output,
			};
		},
	});
}

type ai_chat_tool_create_list_files_Tool = ReturnType<typeof ai_chat_tool_create_list_files>;
export type ai_chat_tool_create_list_files_ToolInput = InferToolInput<ai_chat_tool_create_list_files_Tool>;
export type ai_chat_tool_create_list_files_ToolOutput = InferToolOutput<ai_chat_tool_create_list_files_Tool>;
// #endregion list files

// #region glob files
/**
 * Inspired by `opencode/packages/opencode/src/tool/glob.ts`
 */
export function ai_chat_tool_create_glob_files(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Fast file pattern matching tool that works with any database size. \
			Supports glob patterns like "**/bar" or "foo/**/bar*". \
			Returns matching paths sorted by modification time (newest first). \
			Use this tool when you need to find files or folders by name patterns. \
			When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead. \
			You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`,

		inputSchema: z.object({
			pattern: z.string().describe("The glob pattern to match paths against"),
			path: z
				.string()
				.describe(
					'The directory to search in. If not specified, the root directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
				)
				.optional(),
			limit: z.number().int().gte(1).lte(100).describe("The maximum number of items to list").default(100),
		}),

		execute: async (args) => {
			const searchPath = server_path_normalize(args.path || "/");

			// Get all files under the search path
			const list = await ctx.runQuery(internal.files_nodes.list_files, {
				path: searchPath,
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				maxDepth: 10,
				limit: args.limit,
				include: args.pattern,
			});

			// Sort by modification time (newest first)
			list.items.sort((a, b) => b.updatedAt - a.updatedAt);

			const output: string[] = [];
			if (list.items.length === 0) {
				output.push("No files found");
			} else {
				output.push(...list.items.map((f) => f.path));
				if (list.truncated) {
					output.push("");
					output.push("(Results are truncated. Consider using a more specific path or pattern.)");
				}
			}

			return {
				title: searchPath,
				metadata: {
					count: list.items.length,
					truncated: list.truncated,
				},
				output: output.join("\n"),
			};
		},
	});
}

type ai_chat_tool_create_glob_files_Tool = ReturnType<typeof ai_chat_tool_create_glob_files>;
export type ai_chat_tool_create_glob_files_ToolInput = InferToolInput<ai_chat_tool_create_glob_files_Tool>;
export type ai_chat_tool_create_glob_files_ToolOutput = InferToolOutput<ai_chat_tool_create_glob_files_Tool>;
// #endregion glob files

// #region grep files
/**
 * Inspired by `opencode/packages/opencode/src/tool/grep.ts`
 *
 * Search files by applying a regex pattern against file name + text_content
 */
export function ai_chat_tool_create_grep_files(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
      Fast content search over files using regular expressions.\
      Searches concatenated file name + "\n" + text_content.\
      Use optional include glob to restrict paths and path to scope the root.\
      Results are grouped by file path and sorted by most recently updated.\
      The traversal is limited by depth and limit, identical to list_files.`,

		inputSchema: z.object({
			pattern: z.string().describe("The regex pattern to search for (JavaScript RegExp syntax, case-sensitive)"),
			path: z
				.string()
				.describe('The directory to search in (absolute path starting with "/"). Defaults to root.')
				.optional(),
			include: z.string().describe('Glob pattern to include (e.g. "**/Guides/*")').optional(),
			maxDepth: z
				.number()
				.int()
				.gte(0)
				.lte(10)
				.describe("Maximum depth to traverse (same semantics as list_files)")
				.default(5),
			limit: z
				.number()
				.int()
				.gte(1)
				.lte(100)
				.describe("Maximum number of files to traverse (same semantics as list_files)")
				.default(100),
		}),

		execute: async (args) => {
			const searchPath = server_path_normalize(args.path || "/");

			// Compile regex
			let regex: RegExp;
			try {
				regex = new RegExp(args.pattern);
			} catch (error) {
				throw new Error(`Invalid regex pattern: ${args.pattern}. ${(error instanceof Error && error.message) || ""}`);
			}

			// Discover candidate files using the same traversal logic as list_files
			const list = await ctx.runQuery(internal.files_nodes.list_files, {
				path: searchPath,
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				maxDepth: args.maxDepth,
				limit: args.limit,
				include: args.include,
			});

			type Match = { path: string; updatedAt: number; lineNum: number; lineText: string };
			const matches: Match[] = [];

			for (const item of list.items) {
				if (item.kind !== "file") {
					continue;
				}

				// Read file content
				const file = await ctx.runQuery(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
					path: item.path,
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
				});

				const fileName = path_name_of(item.path);
				const fullText = `${fileName}\n${file?.content ?? ""}`;

				// Line-based scan to produce line numbers and line snippets, similar to ripgrep output
				const lines = fullText.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (regex.test(line)) {
						matches.push({
							path: item.path,
							updatedAt: item.updatedAt,
							lineNum: i + 1,
							lineText: line,
						});
					}
				}
			}

			// Sort by update time (newest first) to mirror opencode behavior
			matches.sort((a, b) => b.updatedAt - a.updatedAt);

			if (matches.length === 0) {
				return {
					title: args.pattern,
					metadata: { matches: 0, truncated: list.truncated },
					output: "No files found",
				};
			}

			const outputLines: string[] = [`Found ${matches.length} matches`];
			let currentPath = "";
			for (const m of matches) {
				if (currentPath !== m.path) {
					if (currentPath !== "") outputLines.push("");
					currentPath = m.path;
					outputLines.push(`${m.path}:`);
				}
				outputLines.push(`  Line ${m.lineNum}: ${m.lineText}`);
			}

			if (list.truncated) {
				outputLines.push("");
				outputLines.push("(Results may be truncated due to traversal limits. Consider adjusting maxDepth or limit.)");
			}

			return {
				title: args.pattern,
				metadata: { matches: matches.length, truncated: list.truncated },
				output: outputLines.join("\n"),
			};
		},
	});
}

type ai_chat_tool_create_grep_files_Tool = ReturnType<typeof ai_chat_tool_create_grep_files>;
export type ai_chat_tool_create_grep_files_ToolInput = InferToolInput<ai_chat_tool_create_grep_files_Tool>;
export type ai_chat_tool_create_grep_files_ToolOutput = InferToolOutput<ai_chat_tool_create_grep_files_Tool>;
// #endregion grep files

// #region text search files
export function ai_chat_tool_create_text_search_files(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Ultra-fast text search over file content using a plain-text chunk index.\
			Search happens on markdown-derived plain text, while results return markdown fragments with line ranges.\
			This makes search resilient to markdown syntax and still gives exact markdown context.

			Notes:\
			- Searches chunk plain text only (not raw markdown syntax).\
			- Results are relevance-ranked by Convex and limited to the specified limit.\
			- Result snippets include chunk line ranges and explicit fragment markers above/below.\
			- Prefer this over grep for general keyword search; use grep for precise regex line matches.`,

		inputSchema: z.object({
			query: z.string().describe("Search terms (e.g. 'hello hi'). Prefix matching applies to the last term."),
			limit: z.number().int().gte(1).lte(100).default(20),
		}),

		execute: async (args) => {
			const res = await ctx.runQuery(internal.files_nodes.text_search_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				query: args.query,
				limit: args.limit ?? 20,
			});

			if (!res.items.length) {
				return {
					title: args.query,
					metadata: { matches: 0 },
					output: "No files found",
				};
			}

			const outputBlocks = res.items.map((item) => {
				const isCodeChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isCode);
				const isTableChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isTable);
				const hasSpecificAbove = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove,
				);
				const hasSpecificBelow = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				);

				const blockLines = [
					`${item.path} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})`,
				];

				if (item.hasChunkAbove) {
					if (hasSpecificAbove && isCodeChunk) {
						blockLines.push("... more code block content above");
					} else if (hasSpecificAbove && isTableChunk) {
						blockLines.push("... more table content above");
					} else {
						blockLines.push("... more content above");
					}
				}

				blockLines.push(item.markdownChunk);

				if (item.hasChunkBelow) {
					if (hasSpecificBelow && isCodeChunk) {
						blockLines.push("... more code block content below");
					} else if (hasSpecificBelow && isTableChunk) {
						blockLines.push("... more table content below");
					} else {
						blockLines.push("... more content below");
					}
				}

				return blockLines.join("\n");
			});

			const lines: string[] = [
				`Found ${res.items.length} results (relevance-ranked plain-text chunks)`,
				"",
				...outputBlocks,
			];

			return {
				title: args.query,
				metadata: { matches: res.items.length },
				output: lines.join("\n"),
			};
		},
	});
}

type ai_chat_tool_create_text_search_files_Tool = ReturnType<typeof ai_chat_tool_create_text_search_files>;
export type ai_chat_tool_create_text_search_files_ToolInput =
	InferToolInput<ai_chat_tool_create_text_search_files_Tool>;
export type ai_chat_tool_create_text_search_files_ToolOutput =
	InferToolOutput<ai_chat_tool_create_text_search_files_Tool>;
// #endregion text search files

// Tools that mutate files. Ask mode must not expose these. Keep in sync when
// adding a new mutating file tool.
export const ai_chat_WRITE_TOOL_NAMES = ["write_file", "edit_file"] as const;
export type ai_chat_WriteToolName = (typeof ai_chat_WRITE_TOOL_NAMES)[number];

// #region write file
/**
 * Inspired by `opencode/packages/opencode/src/tool/write.ts`
 *
 * Tool for proposing file content with preview diff (no direct apply)
 */
export function ai_chat_tool_create_write_file(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Writes a Markdown file in the files.

			Usage:
			- This tool proposes changes to an existing file (or content for a new file) and returns a preview diff.
			- It does not apply changes directly; the client will open a diff editor for human-in-the-loop review.
			- ALWAYS prefer editing existing files. ONLY propose new files if explicitly requested.
			- NEVER proactively create documentation files unless explicitly requested by the user.
			- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
			- Paths are real Markdown file paths and must end in .md, for example /readme.md or /docs/setup.md.
			- The content must be valid GitHub Flavored Markdown.`,

		inputSchema: z.object({
			path: z.string().describe('Absolute path to the Markdown file to write. Must start with "/" and end with ".md".'),
			content: z.string().describe("The GitHub Flavored Markdown content to write to the file"),
			pendingUpdateId: z
				.string()
				.optional()
				.describe("Optional pending update id returned by a prior file read or edit result"),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);
			if (!normalizedPath.startsWith("/") || normalizedPath === "/") {
				throw new Error(`Invalid path: ${normalizedPath}. Path must be absolute and not root.`);
			}
			const normalizedPathSegments = files_get_normalized_node_path_segments({
				kind: "file",
				nameOrPath: normalizedPath,
			});
			if (!normalizedPathSegments || "validationMessage" in normalizedPathSegments) {
				throw new Error(`Invalid path: ${normalizedPath}`, {
					cause: normalizedPathSegments,
				});
			}
			const path = `/${normalizedPathSegments.normalizedPathSegments.join("/")}`;
			const pendingUpdateId = args.pendingUpdateId as Id<"files_pending_updates"> | undefined;

			const currentFileContent = await ctx.runQuery(
				internal.files_nodes.get_file_last_available_markdown_content_by_path,
				{
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path,
					pendingUpdateId,
				},
			);

			let exists = !!currentFileContent;
			const oldText = currentFileContent?.content ?? "";
			const newText = normalize_ai_edit_content(normalize_lf_newlines(args.content), oldText);
			const diff = createPatch(path, oldText, newText);

			let nodeId = currentFileContent?.nodeId;

			if (!nodeId) {
				const created = await ctx.runMutation(internal.files_nodes.create_file_by_path, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path,
				});
				if (created._nay) {
					throw new Error("[server-ai-tools.ai_chat_tool_create_write_file] Error creating file by path", {
						cause: created._nay,
					});
				}
				exists = false;
				nodeId = created._yay.nodeId;
			}

			await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_update_internal, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent?.pendingUpdateId ?? undefined,
				unstagedMarkdown: newText,
			});
			const nextPendingUpdate = await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_internal, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent?.pendingUpdateId ?? undefined,
			});

			return {
				output: exists ? "File overwritten" : "New file created",
				metadata: {
					nodeId,
					pendingUpdateId: nextPendingUpdate?._id ?? null,
					exists,
					path,
					diff,
					modifiedContent: newText,
				},
			};
		},
	});
}

type ai_chat_tool_create_write_file_Tool = ReturnType<typeof ai_chat_tool_create_write_file>;
export type ai_chat_tool_create_write_file_ToolInput = InferToolInput<ai_chat_tool_create_write_file_Tool>;
export type ai_chat_tool_create_write_file_ToolOutput = InferToolOutput<ai_chat_tool_create_write_file_Tool>;
// #endregion write file

// #region edit file
/**
 * Inspired by `opencode/packages/opencode/src/tool/edit.ts`
 *
 * Tool for proposing a search-and-replace edit on a file (no direct apply).
 * It mirrors OpenCode's edit semantics (unique match vs. replaceAll), operates on files files,
 * and stores a pending update for human-in-the-loop review.
 */
export function ai_chat_tool_create_edit_file(
	ctx: ActionCtx,
	ctxData: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
	},
) {
	return tool({
		description: dedent`\
			Edits an existing file by replacing text and returns a preview diff.

			Usage:
			- The path must refer to an existing Markdown file (absolute, starting with "/" and ending with ".md").
			- By default, replaces a single unique occurrence of oldString; fails if not found or ambiguous.
			- Set replaceAll=true to replace every occurrence.
			- If copying from read_file output, do NOT include the line-number prefix (e.g., "00001| ").
			- The text must be valid GitHub Flavored Markdown; ensure replacements preserve valid Markdown structure (headings, code fences, lists).
			- This tool does not apply changes directly; it saves a pending update for human review.`,

		inputSchema: z.object({
			path: z.string().describe('Absolute path to the Markdown file (must start with "/" and end with ".md").'),
			oldString: z.string().describe("The GitHub Flavored Markdown text to replace"),
			newString: z.string().describe("The replacement GitHub Flavored Markdown text"),
			replaceAll: z.boolean().optional().default(false),
			pendingUpdateId: z
				.string()
				.optional()
				.describe("Optional pending update id returned by a prior file read or edit result"),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);
			const pendingUpdateId = args.pendingUpdateId as Id<"files_pending_updates"> | undefined;
			if (!normalizedPath.startsWith("/") || normalizedPath === "/") {
				throw new Error(`Invalid path: ${normalizedPath}. Path must be absolute and not root.`);
			}

			const currentFileContent = await ctx.runQuery(
				internal.files_nodes.get_file_last_available_markdown_content_by_path,
				{
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: normalizedPath,
					pendingUpdateId,
				},
			);
			if (!currentFileContent) {
				throw new Error(`File not found: ${normalizedPath}`);
			}

			const oldString = normalize_lf_newlines(args.oldString);
			const newString = normalize_lf_newlines(args.newString);

			const {
				content: modifiedTextRaw,
				matches,
				matcher,
			} = replace_once_or_all(currentFileContent.content, oldString, newString, {
				replaceAll: args.replaceAll,
				mode: "auto",
			});
			const modifiedText = normalize_ai_edit_content(modifiedTextRaw, currentFileContent.content);
			const diff = createPatch(normalizedPath, currentFileContent.content, modifiedText);

			const nodeId = currentFileContent.nodeId;

			await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_update_internal, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent.pendingUpdateId ?? undefined,
				unstagedMarkdown: modifiedText,
			});
			const nextPendingUpdate = await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_internal, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				nodeId,
				pendingUpdateId: currentFileContent.pendingUpdateId ?? undefined,
			});

			return {
				title: normalizedPath,
				metadata: {
					nodeId,
					pendingUpdateId: nextPendingUpdate?._id ?? null,
					path: normalizedPath,
					matches,
					matcher,
					diff,
					modifiedContent: modifiedText,
				},
				output: args.replaceAll ? `Replaced ${matches} occurrences` : "Replaced 1 occurrence",
			};
		},
	});
}

type ai_chat_tool_create_edit_file_Tool = ReturnType<typeof ai_chat_tool_create_edit_file>;
export type ai_chat_tool_create_edit_file_ToolInput = InferToolInput<ai_chat_tool_create_edit_file_Tool>;
export type ai_chat_tool_create_edit_file_ToolOutput = InferToolOutput<ai_chat_tool_create_edit_file_Tool>;
// #endregion edit file

// #region web search
type ai_chat_tool_web_search_ExaItem = {
	title: string | null;
	url: string | null;
	highlights: string[];
};

type ai_chat_tool_web_search_ContentsOptions = {
	highlights: {
		maxCharacters: number;
	};
};

function ai_chat_tool_web_search_map_sdk_results(result: SearchResponse<ai_chat_tool_web_search_ContentsOptions>): {
	requestId: string | undefined;
	results: ai_chat_tool_web_search_ExaItem[];
} {
	const results: ai_chat_tool_web_search_ExaItem[] = [];

	for (const entry of result.results) {
		const highlights = Array.isArray(entry.highlights)
			? entry.highlights.filter((h): h is string => typeof h === "string")
			: [];

		results.push({
			title: entry.title,
			url: entry.url,
			highlights,
		});
	}

	return { requestId: result.requestId, results };
}

function ai_chat_tool_web_search_format_output(results: ai_chat_tool_web_search_ExaItem[]) {
	const blocks: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const headline = r.title?.trim() || "(untitled)";
		const link = r.url?.trim() || "";

		blocks.push(`${i + 1}. ${headline}`);

		if (link) {
			blocks.push(`   ${link}`);
		}

		for (const h of r.highlights.slice(0, 3)) {
			const snippet = h.replace(/\s+/g, " ").trim().slice(0, 500);
			if (snippet) {
				blocks.push(`   — ${snippet}`);
			}
		}

		blocks.push("");
	}

	return blocks.join("\n").replace(/\n+$/u, "");
}

/**
 * Public web search via Exa (`exa-js`).
 *
 * Keep `EXA_API_KEY` on the server only; never expose it to the browser.
 */
export function ai_chat_tool_create_web_search() {
	return tool({
		description: dedent`\
			Search the public web for current facts, documentation, release notes, news, and other information outside this workspace. \
			Returns compact highlight snippets plus titles and URLs — summarize these in your own words instead of dumping the raw tool output. \
			Prefer workspace file tools first when the answer should come from the user's docs.`,

		inputSchema: z.object({
			query: z.string().describe("Natural language search query"),
			numResults: z.number().int().gte(1).lte(20).describe("Number of results to return (1-20)").optional(),
			includeDomains: z.array(z.string()).describe("Only include results from these domains").optional(),
			excludeDomains: z.array(z.string()).describe("Exclude results from these domains").optional(),
		}),

		execute: async (args) => {
			const apiKey = process.env.EXA_API_KEY?.trim();
			if (!apiKey) {
				throw new Error("Web search is unavailable.");
			}

			const numResults = Math.min(20, Math.max(1, args.numResults ?? 10));

			const searchOptions: RegularSearchOptions & { contents: ai_chat_tool_web_search_ContentsOptions } = {
				type: "fast",
				numResults,
				contents: {
					highlights: {
						maxCharacters: 4000,
					},
				},
			};

			if (args.includeDomains?.length) {
				searchOptions.includeDomains = args.includeDomains;
			}

			if (args.excludeDomains?.length) {
				searchOptions.excludeDomains = args.excludeDomains;
			}

			const exa = new Exa(apiKey);

			let sdkResult: SearchResponse<ai_chat_tool_web_search_ContentsOptions>;
			try {
				sdkResult = await exa.search(args.query, searchOptions);
			} catch (error) {
				if (error instanceof ExaError) {
					throw new Error(`Web search request failed: ${error.message}`);
				}

				throw error;
			}

			const { requestId, results } = ai_chat_tool_web_search_map_sdk_results(sdkResult);
			const output = ai_chat_tool_web_search_format_output(results);

			return {
				title: "Web search",
				metadata: {
					query: args.query,
					resultCount: results.length,
					requestId: requestId ?? null,
				},
				output:
					output.length > 0
						? output
						: "No web results returned for this query. Try different keywords or broader phrasing.",
			};
		},
	});
}

type ai_chat_tool_create_web_search_Tool = ReturnType<typeof ai_chat_tool_create_web_search>;
export type ai_chat_tool_create_web_search_ToolInput = InferToolInput<ai_chat_tool_create_web_search_Tool>;
export type ai_chat_tool_create_web_search_ToolOutput = InferToolOutput<ai_chat_tool_create_web_search_Tool>;
// #endregion web search
