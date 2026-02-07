import { tool, type InferToolInput, type InferToolOutput } from "ai";
import z from "zod";
import dedent from "dedent";
import { createPatch } from "diff";
import type { ActionCtx } from "../convex/_generated/server";
import { internal } from "../convex/_generated/api.js";
import {
	decode_path_segment,
	server_path_extract_segments_from,
	server_path_name_of,
	server_path_normalize,
	server_path_parent_of,
} from "./server-utils.ts";
import { minimatch } from "minimatch";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../shared/shared-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "./server-utils.ts";

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
function* ai_chat_tool_edit_page_replacer_simple(_content: string, find: string): Generator<string, void, unknown> {
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
function* ai_chat_tool_edit_page_replacer_line_trimmed(
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
			for (let k = 0; k < searchLines.length; k++) matchEndIndex += originalLines[i + k].length + 1;
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
function* ai_chat_tool_edit_page_replacer_block_anchor(
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
function* ai_chat_tool_edit_page_replacer_whitespace_normalized(
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
function* ai_chat_tool_edit_page_replacer_indentation_flexible(
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
function* ai_chat_tool_edit_page_replacer_escape_normalized(
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
	if (content.includes(unescapedFind)) yield unescapedFind;
	const lines = content.split("\n");
	const findLines = unescapedFind.split("\n");
	for (let i = 0; i <= lines.length - findLines.length; i++) {
		const block = lines.slice(i, i + findLines.length).join("\n");
		const unescapedBlock = unescapeString(block);
		if (unescapedBlock === unescapedFind) yield block;
	}
}

function replace_once_or_all(
	content: string,
	oldString: string,
	newString: string,
	opts?: { replaceAll?: boolean; mode?: "auto" | "exact" },
): { content: string; matches: number } {
	if (oldString.length === 0) throw new Error("oldString must not be empty");
	if (oldString === newString) throw new Error("oldString and newString must be different");

	const replaceAll = !!opts?.replaceAll;
	const activePipeline: Replacer[] = [
		ai_chat_tool_edit_page_replacer_simple,
		ai_chat_tool_edit_page_replacer_line_trimmed,
		ai_chat_tool_edit_page_replacer_block_anchor,
		ai_chat_tool_edit_page_replacer_whitespace_normalized,
		ai_chat_tool_edit_page_replacer_indentation_flexible,
		ai_chat_tool_edit_page_replacer_escape_normalized,
		// Optional (disabled) replacers:
		// - ai_chat_tool_edit_page_replacer_trimmed_boundary
		//   Source: OpenCode TrimmedBoundaryReplacer (packages/app/vendor/opencode/packages/opencode/src/tool/edit.ts)
		//   Pros: tolerant when only outer whitespace differs
		//   Cons: high collision risk; enable only as last fallback
		// - ai_chat_tool_edit_page_replacer_context_aware
		//   Source: OpenCode ContextAwareReplacer
		//   Pros: first/last anchors + middle-line equality ratio
		//   Cons: heuristic, slower; keep last if enabled
		// - ai_chat_tool_edit_page_replacer_multi_occurrence
		//   Source: OpenCode MultiOccurrenceReplacer
		//   Pros: enumerate all exact hits for custom global replace flows
		//   Cons: redundant with replaceAll; usually unnecessary here
	];

	for (const replacer of activePipeline) {
		for (const search of replacer(content, oldString)) {
			const firstIndex = content.indexOf(search);
			if (firstIndex === -1) continue;
			if (replaceAll) {
				const occurrences = search.length === 0 ? 0 : content.split(search).length - 1;
				if (occurrences === 0) continue;
				return { content: content.split(search).join(newString), matches: occurrences };
			} else {
				const lastIndex = content.lastIndexOf(search);
				if (firstIndex !== lastIndex) continue;
				const updated = content.substring(0, firstIndex) + newString + content.substring(firstIndex + search.length);
				return { content: updated, matches: 1 };
			}
		}
	}

	throw new Error("oldString not found in content or was found multiple times");
}

/**
 * Inspired by `opencode/packages/opencode/src/tool/read.ts`
 */
export function ai_chat_tool_create_read_page(ctx: ActionCtx, tool_execution_ctx: { thread_id: string }) {
	return tool({
		description: dedent`\
			Reads a page from the DB. You can access any page directly by using this tool.
			Assume this tool is able to read all pages on the DB. If the User provides a path to a path assume that path is valid. It is okay to read a page that does not exist; an error will be returned.

			Usage:
			- The path parameter must be an absolute path, not a relative path
			- By default, it reads up to 2000 lines starting from the beginning of the page
			- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole page by not providing these parameters
			- Any lines longer than 2000 characters will be truncated
			- Results are returned using cat -n format, with line numbers starting at 1
			- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful. 
			- If you read a page that exists but has empty contents you will receive a system reminder warning in place of page contents.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe('The absolute path to the page to read (must be absolute, starting with a slash "/", not relative)'),
			offset: z.number().int().gte(0).describe("The line number to start reading from (0-based)").optional(),
			limit: z.number().int().gte(1).lte(2000).describe("The number of lines to read (defaults to 2000)").default(2000),
		}),

		execute: async (args) => {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);
			const normalizedPath = server_path_normalize(args.path);

			const textContent = await ctx.runQuery(internal.ai_docs_temp.get_page_last_available_markdown_content_by_path, {
				path: normalizedPath,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				userId: user.id,
				threadId: tool_execution_ctx.thread_id,
			});

			if (!textContent) {
				// Try to get suggestions for similar paths
				const parentPath = server_path_parent_of(normalizedPath);
				if (parentPath) {
					const siblingPaths = await ctx.runQuery(internal.ai_docs_temp.read_dir, {
						path: parentPath,
						workspaceId: ai_chat_HARDCODED_ORG_ID,
						projectId: ai_chat_HARDCODED_PROJECT_ID,
					});

					const pageName = server_path_name_of(normalizedPath);
					const suggestions = siblingPaths
						.filter(
							(name) =>
								name.trim() !== "" &&
								(name.toLowerCase().includes(pageName.toLowerCase()) ||
									pageName.toLowerCase().includes(name.toLowerCase())),
						)
						.map((name) => {
							const trimmedName = name.trim();
							return parentPath === "/" ? `/${trimmedName}` : `${parentPath}/${trimmedName}`;
						})
						.slice(0, 3);

					if (suggestions.length > 0) {
						return {
							title: normalizedPath,
							output: "Page not found. Did you mean one of these?\n" + suggestions.join("\n"),
						};
					}
				}

				return {
					title: normalizedPath,
					output: "Page not found.",
				};
			}

			const lines = textContent.split("\n");
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

			let output = "<page>\n";
			output += formattedLines.join("\n");

			if (lines.length > offset + selectedLines.length) {
				output += `\n\n(Page has more lines. Use 'offset' parameter to read beyond line ${offset + selectedLines.length})`;
			}
			output += "\n</page>";

			// Create preview (first 20 lines of truncated content, without line numbers)
			const preview = truncatedLines.slice(0, 20).join("\n");

			return {
				title: normalizedPath,
				output,
				metadata: {
					preview,
				},
			};
		},
	});
}

type ai_chat_tool_create_read_page_Tool = ReturnType<typeof ai_chat_tool_create_read_page>;
export type ai_chat_tool_create_read_page_ToolInput = InferToolInput<ai_chat_tool_create_read_page_Tool>;
export type ai_chat_tool_create_read_page_ToolOutput = InferToolOutput<ai_chat_tool_create_read_page_Tool>;

/**
 * Inspired by `opencode/packages/opencode/src/tool/ls.ts`
 */
export function ai_chat_tool_create_list_pages(ctx: ActionCtx, tool_execution_ctx?: { thread_id: string }) {
	return tool({
		description: dedent`\
			Lists descendants pages in a given path. \
			The path parameter must be an absolute path, not a relative path. \
			You can optionally provide an array of glob patterns to ignore with the ignore parameter. \
			You should generally prefer the Glob and Grep tools, if you know which directories to search.
			The root path is "/", you can use it to list all pages.`,

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

			// const normalizedPath = server_path_normalize(args.path ?? "/");
			const path = args.path;

			const list = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
				path: path,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				maxDepth: args.maxDepth,
				limit: args.limit,
			});

			// Apply ignore filters (on absolute paths)
			const visiblePaths = list.items.filter((p) => !matchesAnyIgnore(p.path, args.ignore));

			// Build directory structure (directories only)
			const dirs = new Set<string>();
			const depthTruncatedPaths = new Set<string>();

			for (const visiblePath of visiblePaths) {
				const segments = server_path_extract_segments_from(visiblePath.path);

				if (visiblePath.depthTruncated) {
					depthTruncatedPaths.add(visiblePath.path);
				}

				// Add all parent directories including the path itself
				for (let i = 0; i <= segments.length; i++) {
					const dirPath = i === 0 ? "/" : "/" + segments.slice(0, i).join("/");
					dirs.add(dirPath);
				}
			}

			// Render tree starting at `path`
			function renderDir(dirPath: string, depth: number): string {
				const indent = "  ".repeat(depth);
				let output = depth === 0 ? `/\n` : `${indent}${decode_path_segment(server_path_name_of(dirPath))}/\n`;

				const subdirs = Array.from(dirs)
					.filter((d) => server_path_parent_of(d) === dirPath && d !== dirPath)
					.sort();

				for (const child of subdirs) {
					output += renderDir(child, depth + 1);
				}

				if (depthTruncatedPaths.has(dirPath)) {
					output += `${indent}  ... (children truncated due to \`maxDepth\`)\n`;
				}

				return output;
			}

			const output = renderDir(path, 0);

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

type ai_chat_tool_create_list_pages_Tool = ReturnType<typeof ai_chat_tool_create_list_pages>;
export type ai_chat_tool_create_list_pages_ToolInput = InferToolInput<ai_chat_tool_create_list_pages_Tool>;
export type ai_chat_tool_create_list_pages_ToolOutput = InferToolOutput<ai_chat_tool_create_list_pages_Tool>;

/**
 * Inspired by `opencode/packages/opencode/src/tool/glob.ts`
 */
export function ai_chat_tool_create_glob_pages(ctx: ActionCtx) {
	return tool({
		description: dedent`\
			Fast page pattern matching tool that works with any database size. \
			Supports glob patterns like "**/bar" or "foo/**/bar*". \
			Returns matching page paths sorted by modification time (newest first). \
			Use this tool when you need to find pages by name patterns. \
			When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead. \
			You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`,

		inputSchema: z.object({
			pattern: z.string().describe("The glob pattern to match pages against"),
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

			// Get all pages under the search path
			const listResult = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
				path: searchPath,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				maxDepth: 10,
				limit: args.limit,
				include: args.pattern,
			});

			// Sort by modification time (newest first)
			listResult.items.sort((a, b) => b.updatedAt - a.updatedAt);

			const output: string[] = [];
			if (listResult.items.length === 0) {
				output.push("No pages found");
			} else {
				output.push(...listResult.items.map((f) => f.path));
				if (listResult.truncated) {
					output.push("");
					output.push("(Results are truncated. Consider using a more specific path or pattern.)");
				}
			}

			return {
				title: searchPath,
				metadata: {
					count: listResult.items.length,
					truncated: listResult.truncated,
				},
				output: output.join("\n"),
			};
		},
	});
}

type ai_chat_tool_create_glob_pages_Tool = ReturnType<typeof ai_chat_tool_create_glob_pages>;
export type ai_chat_tool_create_glob_pages_ToolInput = InferToolInput<ai_chat_tool_create_glob_pages_Tool>;
export type ai_chat_tool_create_glob_pages_ToolOutput = InferToolOutput<ai_chat_tool_create_glob_pages_Tool>;

/**
 * Inspired by `opencode/packages/opencode/src/tool/grep.ts`
 *
 * Search pages by applying a regex pattern against page name + text_content
 */
export function ai_chat_tool_create_grep_pages(ctx: ActionCtx, tool_execution_ctx: { thread_id: string }) {
	return tool({
		description: dedent`\
      Fast content search over pages using regular expressions.\
      Searches concatenated page name + "\n" + text_content.\
      Use optional include glob to restrict paths and path to scope the root.\
      Results are grouped by page path and sorted by most recently updated.\
      The traversal is limited by depth and limit, identical to list_pages.`,

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
				.describe("Maximum depth to traverse (same semantics as list_pages)")
				.default(5),
			limit: z
				.number()
				.int()
				.gte(1)
				.lte(100)
				.describe("Maximum number of pages to traverse (same semantics as list_pages)")
				.default(100),
		}),

		execute: async (args) => {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);
			const searchPath = server_path_normalize(args.path || "/");

			// Compile regex
			let regex: RegExp;
			try {
				regex = new RegExp(args.pattern);
			} catch (error) {
				throw new Error(`Invalid regex pattern: ${args.pattern}. ${(error instanceof Error && error.message) || ""}`);
			}

			// Discover candidate pages using the same traversal logic as list_pages
			const list = await ctx.runQuery(internal.ai_docs_temp.list_pages, {
				path: searchPath,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				maxDepth: args.maxDepth,
				limit: args.limit,
				include: args.include,
			});

			type Match = { path: string; updatedAt: number; lineNum: number; lineText: string };
			const matches: Match[] = [];

			for (const item of list.items) {
				// Read page content
				const textContent = await ctx.runQuery(internal.ai_docs_temp.get_page_last_available_markdown_content_by_path, {
					path: item.path,
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					userId: user.id,
					threadId: tool_execution_ctx.thread_id,
				});

				const pageName = server_path_name_of(item.path);
				const fullText = `${pageName}\n${textContent ?? ""}`;

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

type ai_chat_tool_create_grep_pages_Tool = ReturnType<typeof ai_chat_tool_create_grep_pages>;
export type ai_chat_tool_create_grep_pages_ToolInput = InferToolInput<ai_chat_tool_create_grep_pages_Tool>;
export type ai_chat_tool_create_grep_pages_ToolOutput = InferToolOutput<ai_chat_tool_create_grep_pages_Tool>;

export function ai_chat_tool_create_text_search_pages(ctx: ActionCtx, tool_execution_ctx: { thread_id: string }) {
	return tool({
		description: dedent`\
			Ultra-fast text search over page content using the database search index.\
			Behaves like using grep with the expression "<search_term>.*" (the .* means any letters, using regexp syntax),\
			but leverages Convex full-text search so it's much faster and ranked by relevance.

			Notes:\
			- Searches the text_content field only.\
			- Results are relevance-ranked by Convex and limited to the specified limit.\
			- Prefer this over grep for general keyword search; use grep for precise regex line matches.`,

		inputSchema: z.object({
			query: z.string().describe("Search terms (e.g. 'hello hi'). Prefix matching applies to the last term."),
			limit: z.number().int().gte(1).lte(100).default(20),
		}),

		execute: async (args) => {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);
			const res = await ctx.runQuery(internal.ai_docs_temp.text_search_pages, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				query: args.query,
				limit: args.limit ?? 20,
				userId: user.id,
				threadId: tool_execution_ctx.thread_id,
			});

			if (!res.items.length) {
				return {
					title: args.query,
					metadata: { matches: 0 },
					output: "No pages found",
				};
			}

			const lines: string[] = [
				`Found ${res.items.length} results (relevance-ranked)`,
				"",
				...res.items.map((i) => `${i.path}\n  Preview: ${i.preview}`),
			];

			return {
				title: args.query,
				metadata: { matches: res.items.length },
				output: lines.join("\n"),
			};
		},
	});
}

type ai_chat_tool_create_text_search_pages_Tool = ReturnType<typeof ai_chat_tool_create_text_search_pages>;
export type ai_chat_tool_create_text_search_pages_ToolInput =
	InferToolInput<ai_chat_tool_create_text_search_pages_Tool>;
export type ai_chat_tool_create_text_search_pages_ToolOutput =
	InferToolOutput<ai_chat_tool_create_text_search_pages_Tool>;

/**
 * Inspired by `opencode/packages/opencode/src/tool/write.ts`
 *
 * Tool for proposing page content with preview diff (no direct apply)
 */
export function ai_chat_tool_create_write_page(ctx: ActionCtx, tool_execution_ctx: { thread_id: string }) {
	return tool({
		description: dedent`\
			Writes a page in the system.

			Usage:
			- This tool proposes changes to an existing page (or content for a new page) and returns a preview diff.
			- It does not apply changes directly; the client will open a diff editor for human-in-the-loop review.
			- ALWAYS prefer editing existing pages. ONLY propose new pages if explicitly requested.
			- NEVER proactively create documentation pages unless explicitly requested by the user.
			- Only use emojis if the user explicitly requests it. Avoid writing emojis to pages unless asked.
			- NEVER include a file extension in the page path (no .md, .mdx, .txt) unless the user explicitly provided it. Pages are extensionless by default.
			  Examples: Correct → /docs/Getting Started | Incorrect → /docs/Getting Started.md, /docs/Getting Started.mdx
			- The content must be valid GitHub Flavored Markdown.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe(
					'Absolute path to the page to write. Must start with "/". Do NOT include a file extension (.md, .mdx, .txt) unless explicitly provided by the user.',
				),
			content: z.string().describe("The GitHub Flavored Markdown content to write to the page"),
		}),

		execute: async (args) => {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);
			const path = server_path_normalize(args.path);
			if (!path.startsWith("/") || path === "/") {
				throw new Error(`Invalid path: ${path}. Path must be absolute and not root.`);
			}

			let pageId = await ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
				path,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			});

			let exists = !!pageId;

			const oldText = pageId
				? ((await ctx.runQuery(internal.ai_docs_temp.get_page_last_available_markdown_content_by_path, {
						path,
						workspaceId: ai_chat_HARDCODED_ORG_ID,
						projectId: ai_chat_HARDCODED_PROJECT_ID,
						userId: user.id,
						threadId: tool_execution_ctx.thread_id,
					})) ?? "")
				: "";

			// TODO(pages): Enforce LF-only markdown in AI tools. Normalize CRLF/CR to "\n" before diffing and persisting.
			const newText = args.content;
			const diff = createPatch(path, oldText, newText);

			if (!pageId) {
				const created = await ctx.runMutation(internal.ai_docs_temp.create_page_by_path, {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					path,
					userId: user.id,
					threadId: tool_execution_ctx.thread_id,
				});
				exists = false;
				pageId = created.page_id;
			}

			if (!pageId) {
				throw new Error("Internal error: pageId not resolved after page creation");
			}

			await ctx.runMutation(internal.ai_chat.upsert_ai_pending_edit, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				threadId: tool_execution_ctx.thread_id,
				pageId: pageId,
				baseContent: oldText,
				modifiedContent: newText,
			});

			return {
				output: exists ? "Page overwritten" : "New page created",
				metadata: { pageId: pageId, exists, path, diff, modifiedContent: newText },
			};
		},
	});
}

type ai_chat_tool_create_write_page_Tool = ReturnType<typeof ai_chat_tool_create_write_page>;
export type ai_chat_tool_create_write_page_ToolInput = InferToolInput<ai_chat_tool_create_write_page_Tool>;
export type ai_chat_tool_create_write_page_ToolOutput = InferToolOutput<ai_chat_tool_create_write_page_Tool>;

/**
 * Inspired by `opencode/packages/opencode/src/tool/edit.ts`
 *
 * Tool for proposing a search-and-replace edit on a page (no direct apply).
 * It mirrors OpenCode's edit semantics (unique match vs. replaceAll), operates on DB pages,
 * and stores a pending edit for human-in-the-loop review.
 */
export function ai_chat_tool_create_edit_page(ctx: ActionCtx, tool_execution_ctx: { thread_id: string }) {
	return tool({
		description: dedent`\
			Edits an existing page by replacing text and returns a preview diff.

			Usage:
			- The path must refer to an existing page (absolute, starting with "/").
			- By default, replaces a single unique occurrence of oldString; fails if not found or ambiguous.
			- Set replaceAll=true to replace every occurrence.
			- If copying from read_page output, do NOT include the line-number prefix (e.g., "00001| ").
			- The text must be valid GitHub Flavored Markdown; ensure replacements preserve valid Markdown structure (headings, code fences, lists).
			- This tool does not apply changes directly; it saves a pending edit for human review.`,

		inputSchema: z.object({
			path: z
				.string()
				.describe(
					'Absolute path to the page (must start with "/"; do not include a file extension unless explicitly provided).',
				),
			oldString: z.string().describe("The GitHub Flavored Markdown text to replace"),
			newString: z.string().describe("The replacement GitHub Flavored Markdown text"),
			replaceAll: z.boolean().optional().default(false),
		}),

		execute: async (args) => {
			const user = await server_convex_get_user_fallback_to_anonymous(ctx);
			const normalizedPath = server_path_normalize(args.path);
			if (!normalizedPath.startsWith("/") || normalizedPath === "/") {
				throw new Error(`Invalid path: ${normalizedPath}. Path must be absolute and not root.`);
			}

			const pageId = await ctx.runQuery(internal.ai_docs_temp.resolve_page_id_from_path, {
				path: normalizedPath,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			});
			if (!pageId) {
				throw new Error(`Page not found: ${normalizedPath}`);
			}

			const baseText =
				(await ctx.runQuery(internal.ai_docs_temp.get_page_last_available_markdown_content_by_path, {
					path: normalizedPath,
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					userId: user.id,
					threadId: tool_execution_ctx.thread_id,
				})) ?? "";

			const { content: modifiedText, matches } = replace_once_or_all(baseText, args.oldString, args.newString, {
				replaceAll: args.replaceAll,
				mode: "auto",
			});
			// TODO(pages): Enforce LF-only markdown in AI tools. Normalize CRLF/CR to "\n" before diffing and persisting.

			const diff = createPatch(normalizedPath, baseText, modifiedText);

			await ctx.runMutation(internal.ai_chat.upsert_ai_pending_edit, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				threadId: tool_execution_ctx.thread_id,
				pageId,
				baseContent: baseText,
				modifiedContent: modifiedText,
			});

			return {
				title: normalizedPath,
				metadata: { pageId: pageId, path: normalizedPath, matches, diff, modifiedContent: modifiedText },
				output: args.replaceAll ? `Replaced ${matches} occurrences` : "Replaced 1 occurrence",
			};
		},
	});
}

type ai_chat_tool_create_edit_page_Tool = ReturnType<typeof ai_chat_tool_create_edit_page>;
export type ai_chat_tool_create_edit_page_ToolInput = InferToolInput<ai_chat_tool_create_edit_page_Tool>;
export type ai_chat_tool_create_edit_page_ToolOutput = InferToolOutput<ai_chat_tool_create_edit_page_Tool>;
