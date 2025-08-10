import { tool } from "ai";
import z from "zod";
import dedent from "dedent";
import type { ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../src/lib/ai-chat.ts";
import {
	server_path_extract_segments_from,
	server_path_name_of,
	server_path_normalize,
	server_path_parent_of,
} from "./server_utils.ts";
import { minimatch } from "minimatch";

/**
 * Inspired by `opencode/packages/opencode/src/tool/read.ts`
 */
export function ai_tool_create_read_page(ctx: ActionCtx) {
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

		parameters: z.object({
			path: z
				.string()
				.describe('The absolute path to the page to read (must be absolute, starting with a slash "/", not relative)'),
			offset: z.number().int().gte(0).describe("The line number to start reading from (0-based)").optional(),
			limit: z.number().int().gte(1).lte(2000).describe("The number of lines to read (defaults to 2000)").default(2000),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);

			const pageExists = await ctx.runQuery(api.ai_docs_temp.page_exists_by_path, {
				path: normalizedPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
			});

			if (!pageExists) {
				// Try to get suggestions for similar paths
				const parentPath = server_path_parent_of(normalizedPath);
				if (parentPath) {
					const siblingPaths = await ctx.runQuery(api.ai_docs_temp.read_dir, {
						path: parentPath,
						workspace_id: ai_chat_HARDCODED_ORG_ID,
						project_id: ai_chat_HARDCODED_PROJECT_ID,
					});

					const pageName = server_path_name_of(normalizedPath);
					const suggestions = siblingPaths
						.filter(
							(name) =>
								name.toLowerCase().includes(pageName.toLowerCase()) ||
								pageName.toLowerCase().includes(name.toLowerCase()),
						)
						.map((name) => (parentPath === "/" ? `/${name}` : `${parentPath}/${name}`))
						.slice(0, 3);

					if (suggestions.length > 0) {
						throw new Error(
							`Page not found: ${normalizedPath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`,
						);
					}
				}

				throw new Error(`Page not found: ${normalizedPath}`);
			}

			const textContent = await ctx.runQuery(api.ai_docs_temp.get_page_text_content_by_path, {
				path: normalizedPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
			});

			if (!textContent) {
				return {
					title: normalizedPath,
					output: "<file>\n(Page has no text content)\n</file>",
					metadata: {
						preview: "(empty)",
					},
				};
			}

			const lines = textContent.split("\n");
			const offset = args.offset || 0;
			const limit = args.limit;

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
				output += `\n\n(Page has more lines. Use 'offset' parameter to read beyond line ${offset + selectedLines.length})`;
			}
			output += "\n</file>";

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

/**
 * Inspired by `opencode/packages/opencode/src/tool/ls.ts`
 */
export function ai_tool_create_list_page(ctx: ActionCtx) {
	return tool({
		description: dedent`\
			Lists descendants pages in a given path. \
			The path parameter must be an absolute path, not a relative path. \
			You can optionally provide an array of glob patterns to ignore with the ignore parameter. \
			You should generally prefer the Glob and Grep tools, if you know which directories to search.
			The root path is "/", you can use it to list all pages.`,

		parameters: z.object({
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

			const normalizedPath = server_path_normalize(args.path);

			const list = await ctx.runQuery(api.ai_docs_temp.list_dir, {
				path: normalizedPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				max_depth: args.maxDepth,
				limit: args.limit,
			});

			// Apply ignore filters (on absolute paths)
			const visiblePaths = list.filter((p) => !matchesAnyIgnore(p, args.ignore));

			// Build directory structure (directories only)
			const dirs = new Set<string>();

			for (const visiblePath of visiblePaths) {
				const segments = server_path_extract_segments_from(visiblePath);

				// Add all parent directories including the path itself
				for (let i = 0; i <= segments.length; i++) {
					const dirPath = i === 0 ? "/" : "/" + segments.slice(0, i).join("/");
					dirs.add(dirPath);
				}
			}

			// Render tree starting at normalizedPath
			function renderDir(dirPath: string, depth: number): string {
				const indent = "  ".repeat(depth);
				let output = depth === 0 ? `${dirPath}/\n` : `${indent}${server_path_name_of(dirPath)}/\n`;

				const subdirs = Array.from(dirs)
					.filter((d) => server_path_parent_of(d) === dirPath && d !== dirPath)
					.sort();

				for (const child of subdirs) {
					output += renderDir(child, depth + 1);
				}

				return output;
			}

			const output = renderDir(normalizedPath, 0);

			return {
				title: normalizedPath,
				output,
			};
		},
	});
}
