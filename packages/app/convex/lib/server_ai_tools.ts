import { tool } from "ai";
import z from "zod";
import dedent from "dedent";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
	server_path_extract_segments_from,
	server_path_name_of,
	server_path_normalize,
	server_path_parent_of,
} from "./server_utils.ts";
import { minimatch } from "minimatch";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../src/lib/ai-chat.ts";
import { math_clamp } from "../../shared/shared-utils.ts";

// TODO: when truncating, we truncate the total rows but we don't tell the LLM if we truncated in depth
async function list_dir(
	ctx: ActionCtx,
	args: {
		workspace_id: string;
		project_id: string;
		path: string;
		max_depth?: number;
		limit?: number;
		include?: string;
	},
): Promise<{ items: Array<{ path: string; updated_at: number }>; metadata: { count: number; truncated: boolean } }> {
	// Resolve the starting node id for the provided path
	const startNodeId = await ctx.runQuery(internal.ai_docs_temp.resolve_tree_node_id_from_path, {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		path: args.path,
	});
	if (!startNodeId) return { items: [], metadata: { count: 0, truncated: false } };

	// Normalize base path to an absolute path string (leading slash, no trailing slash except root)
	const basePath = server_path_normalize(args.path);

	const maxDepth = args.max_depth ? math_clamp(args.max_depth, 0, 10) : 5;
	const limit = args.limit ? math_clamp(args.limit, 1, 100) : 100;

	const resultPaths: Array<{ path: string; updated_at: number }> = [];
	let truncated = false;

	// Depth-first traversal using an explicit stack. Each frame carries a pagination cursor
	// so we fetch one child at a time for the current parent, then dive deeper first.
	const stack: Array<{ parentId: string; absPath: string; cursor: string | null; depth: number }> = [
		{ parentId: startNodeId, absPath: basePath, cursor: null, depth: 0 },
	];

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) continue;

		const paginatedResult = await ctx.runQuery(internal.ai_docs_temp.get_page_info_for_list_dir_pagination, {
			parent_id: frame.parentId,
			cursor: frame.cursor,
		});

		// No more children at this cursor for this parent or page is empty
		if (paginatedResult.isDone) continue;

		const child = paginatedResult.page.at(0);
		if (!child) continue; // just for type safety

		const childPath = frame.absPath === "/" ? `/${child.name}` : `${frame.absPath}/${child.name}`;

		// If include pattern is provided, only add items that match the glob
		const matchesInclude = args.include ? minimatch(childPath, args.include) : true;
		if (matchesInclude) {
			resultPaths.push({ path: childPath, updated_at: child.updated_at });

			// Respect limit if provided (only counts included items)
			if (resultPaths.length >= limit) {
				truncated = true;
				break;
			}
		}

		// First, if there are more siblings for the current parent, push the parent back with updated cursor
		// so we'll process siblings after we finish the deep dive into this child.
		if (!paginatedResult.isDone) {
			stack.push({
				parentId: frame.parentId,
				absPath: frame.absPath,
				cursor: paginatedResult.continueCursor,
				depth: frame.depth,
			});
		}

		// Then, push the child to dive deeper first (pre-order/JSON.stringify-like walk)
		const nextDepth = frame.depth + 1;
		if (nextDepth < maxDepth) {
			stack.push({ parentId: child.page_id, absPath: childPath, cursor: null, depth: nextDepth });
		}
	}

	return {
		items: resultPaths,
		metadata: {
			count: resultPaths.length,
			truncated,
		},
	};
}

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

		inputSchema: z.object({
			path: z
				.string()
				.describe('The absolute path to the page to read (must be absolute, starting with a slash "/", not relative)'),
			offset: z.number().int().gte(0).describe("The line number to start reading from (0-based)").optional(),
			limit: z.number().int().gte(1).lte(2000).describe("The number of lines to read (defaults to 2000)").default(2000),
		}),

		execute: async (args) => {
			const normalizedPath = server_path_normalize(args.path);

			const pageExists = await ctx.runQuery(internal.ai_docs_temp.page_exists_by_path, {
				path: normalizedPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
			});

			if (!pageExists) {
				// Try to get suggestions for similar paths
				const parentPath = server_path_parent_of(normalizedPath);
				if (parentPath) {
					const siblingPaths = await ctx.runQuery(internal.ai_docs_temp.read_dir, {
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

			const textContent = await ctx.runQuery(internal.ai_docs_temp.get_page_text_content_by_path, {
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
export function ai_tool_create_list_pages(ctx: ActionCtx) {
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

			const normalizedPath = server_path_normalize(args.path ?? "/");

			const list = await list_dir(ctx, {
				path: normalizedPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				max_depth: args.maxDepth,
				limit: args.limit,
			});

			// Apply ignore filters (on absolute paths)
			const visiblePaths = list.items.filter((p) => !matchesAnyIgnore(p.path, args.ignore));

			// Build directory structure (directories only)
			const dirs = new Set<string>();

			for (const visiblePath of visiblePaths) {
				const segments = server_path_extract_segments_from(visiblePath.path);

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
				metadata: {
					count: visiblePaths.length,
					truncated: list.metadata.truncated,
				},
				output,
			};
		},
	});
}

/**
 * Inspired by `opencode/packages/opencode/src/tool/glob.ts`
 */
export function ai_tool_create_glob_pages(ctx: ActionCtx) {
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
			const listResult = await list_dir(ctx, {
				path: searchPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				max_depth: 10,
				limit: args.limit,
				include: args.pattern,
			});

			// Sort by modification time (newest first)
			listResult.items.sort((a, b) => b.updated_at - a.updated_at);

			const output: string[] = [];
			if (listResult.items.length === 0) {
				output.push("No pages found");
			} else {
				output.push(...listResult.items.map((f) => f.path));
				if (listResult.metadata.truncated) {
					output.push("");
					output.push("(Results are truncated. Consider using a more specific path or pattern.)");
				}
			}

			return {
				title: searchPath,
				metadata: {
					count: listResult.items.length,
					truncated: listResult.metadata.truncated,
				},
				output: output.join("\n"),
			};
		},
	});
}

/**
 * Inspired by `opencode/packages/opencode/src/tool/grep.ts`
 * Search pages by applying a regex pattern against page name + text_content
 */
export function ai_tool_create_grep_pages(ctx: ActionCtx) {
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
			const searchPath = server_path_normalize(args.path || "/");

			// Compile regex
			let regex: RegExp;
			try {
				regex = new RegExp(args.pattern);
			} catch (error) {
				throw new Error(`Invalid regex pattern: ${args.pattern}. ${(error instanceof Error && error.message) || ""}`);
			}

			// Discover candidate pages using the same traversal logic as list_pages
			const list = await list_dir(ctx, {
				path: searchPath,
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				max_depth: args.maxDepth,
				limit: args.limit,
				include: args.include,
			});

			type Match = { path: string; updated_at: number; lineNum: number; lineText: string };
			const matches: Match[] = [];

			for (const item of list.items) {
				// Read page content
				const textContent = await ctx.runQuery(internal.ai_docs_temp.get_page_text_content_by_path, {
					path: item.path,
					workspace_id: ai_chat_HARDCODED_ORG_ID,
					project_id: ai_chat_HARDCODED_PROJECT_ID,
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
							updated_at: item.updated_at,
							lineNum: i + 1,
							lineText: line,
						});
					}
				}
			}

			// Sort by update time (newest first) to mirror opencode behavior
			matches.sort((a, b) => b.updated_at - a.updated_at);

			if (matches.length === 0) {
				return {
					title: args.pattern,
					metadata: { matches: 0, truncated: list.metadata.truncated },
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

			if (list.metadata.truncated) {
				outputLines.push("");
				outputLines.push("(Results may be truncated due to traversal limits. Consider adjusting maxDepth or limit.)");
			}

			return {
				title: args.pattern,
				metadata: { matches: matches.length, truncated: list.metadata.truncated },
				output: outputLines.join("\n"),
			};
		},
	});
}

export function ai_tool_create_text_search_pages(ctx: ActionCtx) {
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
			const res = await ctx.runQuery(internal.ai_docs_temp.text_search_pages, {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				query: args.query,
				limit: args.limit ?? 20,
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
